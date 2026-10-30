/**
 * L2：doctor —— 回答"为什么现在跑不起来"。
 *
 * 只读：探工具链版本、找有没有残留的调试进程占着探针、看 gdb 端口是否被占、
 * 找构建目录与 .elf、把 .ioc 里的致命告警（例如没启用 Serial Wire）汇总成阻塞项。
 * 不烧录、不生成、不写工程。
 */
import { createConnection } from "node:net";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { deriveChipPinTable, findMcuDbDir } from "../data/chips.js";
import { describeSearchScope, discoverInstalls, discoveryDisabled, resolveSearchConfig } from "../data/search-roots.js";
import { resolveF1Chip } from "../data/stm32f1.js";
import { detectBuildDir, findElf } from "./build.js";
import { CUBEMX_CMAKE_REL, deviceDefineFromStartup, isDeviceDefine, listStartupFiles } from "./cmake-sources.js";
import { findIocFile } from "./generate.js";
import { summarizeIoc } from "./ioc.js";
import { buildTargets, probeAll } from "./probe.js";
import { runCapture } from "./subprocess-runner.js";
/**
 * 解析 `pnputil /enum-devices /connected` 的输出，回答"这台机器上 USB 是什么形态"。
 *
 * 为什么要分级：云服务器（阿里云 ECS）物理上没有 USB 口，无论用户怎么插线都进不来探针；
 * 这和"没插板 / 线只供电 / 驱动没装 / 被占"是四种完全不同的回答，混成一句"找不到探针"
 * 会让用户白折腾。诊断只读、失败不阻塞（unknown 也会给一句手查指引）。
 */
export function diagnoseUsb(pnputilText) {
    // 不依赖本地化字段名（中文系统的 pnputil 字段名是 GBK，读出来是乱码）：
    // 只要任意一行里出现 USB\VID_、USB\ROOT_HUB、或 VID_xxxx&PID 形态的 USB 实例，
    // 就认定这台机器有 USB 控制器/设备；纯 ASCII 部分（USB、VID、PID、ROOT_HUB）不受编码影响。
    const hasUsbController = /USB\\(?:VID_|ROOT_HUB|VID\w{4}&PID)/iu.test(pnputilText) ||
        /\\USB\\/u.test(pnputilText);
    // VID 集（2a）：CMSIS-DAP 是 ARM 官方 VID 0x0D28；ST-Link 全系 VID_0483；
    // DAPLink 是 VID_C251；CH340 串口桥接的国产探针常见 VID_1A86。ASCII 本体不受编码影响。
    const hasDap = /CMSIS-DAP|VID_0D28|VID_0483|VID_C251|VID_1A86/iu.test(pnputilText) ||
        /\\usb\\vid_(?:0d28|0483|c251|1a86)/iu.test(pnputilText);
    const hasDriverProblem = /(?:Problem Code|问题代码)\s*[:：]?\s*(?:1[0-9]|2[0-8]|3[0-9]|4[0-3]|5[0-2])/iu.test(pnputilText);
    if (!hasUsbController) {
        return {
            kind: "no-usb",
            detail: "系统里枚举不到任何 USB 控制器：这台机器多半是云服务器/虚拟机，物理上没有 USB 口，" +
                "插线、换线、装驱动都解决不了。要么换一台有 USB 的物理机，要么用 USB over IP（usbipd/USBIP）把探针从别的机器转发过来" +
                "（注意 SWD 对延迟敏感，转发方案只建议实验用）。",
        };
    }
    if (hasDap && hasDriverProblem) {
        return {
            kind: "driver-error",
            detail: "能看到 CMSIS-DAP 设备但驱动状态异常（Problem Code 非 0）：在设备管理器里找到该设备，" +
                "重装或回退驱动（CMSIS-DAP 用 WinUSB/HID 通用驱动即可；装过 DAPLink 官方驱动的先卸载它）。",
        };
    }
    if (hasDap) {
        return { kind: "ok", detail: "能看到 CMSIS-DAP 设备且驱动正常：探针在线，烧录/调试应当能直接找到它。" };
    }
    return {
        kind: "no-dap",
        detail: "有 USB 控制器但没看到常见探针（CMSIS-DAP / ST-Link / DAPLink / CH340 桥接）：检查探针有没有插好（有的线只能供电不能传数据）、" +
            "板上调试器的跳线/开关位置、以及 BOOT0 是否接错（BOOT0=1 会进系统 bootloader，SWD 不响应）。",
    };
}
export async function usbDiagnosis(subprocess, signal) {
    // 只读枚举；pnputil 不存在（老系统）或被组策略拦时返回 unknown，绝不让诊断把 doctor 搞挂。
    try {
        const outcome = await runCapture(subprocess, {
            argv: ["pnputil", "/enum-devices", "/connected"],
            timeoutMs: 10_000,
            maxBytes: 2 * 1024 * 1024,
            ...(signal === undefined ? {} : { signal }),
        });
        if (outcome.spawnError !== null || outcome.exitCode !== 0) {
            return {
                kind: "unknown",
                detail: "跑不了 pnputil /enum-devices（" +
                    (outcome.spawnError !== null ? outcome.spawnError : "退出码 " + String(outcome.exitCode)) +
                    "），无法判断 USB/探针形态；可在设备管理器里人工核对。",
            };
        }
        return diagnoseUsb(outcome.stdout + "\n" + outcome.stderr);
    }
    catch (error) {
        return {
            kind: "unknown",
            detail: "USB/探针诊断异常终止（" + (error instanceof Error ? error.message : String(error)) + "），可忽略；设备管理器里人工核对。",
        };
    }
}
/** 会占着探针/端口的进程名（小写比较）。 */
const PROBE_PROCESS_NAMES = ["openocd.exe", "gdb-multiarch.exe", "arm-none-eabi-gdb.exe", "stm32cubemx.exe"];
/** 解析 `tasklist /NH /FO CSV` 的输出，只留下关心的进程。 */
export function parseTasklistCsv(text, wanted = PROBE_PROCESS_NAMES) {
    const wantedLower = new Set(wanted.map((name) => name.toLowerCase()));
    const seen = new Set();
    const found = [];
    for (const line of text.split(/\r?\n/u)) {
        const match = /^"([^"]+)","([^"]+)"/u.exec(line.trim());
        if (match === null)
            continue;
        const name = match[1] ?? "";
        const pidText = (match[2] ?? "").replace(/[^0-9]/gu, "");
        if (pidText === "")
            continue;
        if (!wantedLower.has(name.toLowerCase()))
            continue;
        const key = name.toLowerCase() + ":" + pidText;
        if (seen.has(key))
            continue;
        seen.add(key);
        found.push({ name, pid: Number(pidText) });
    }
    return found;
}
/** 端口上有没有人在监听。 */
export function checkPortBusy(port, timeoutMs = 600) {
    return new Promise((resolvePort) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        const finish = (busy) => {
            socket.removeAllListeners();
            socket.destroy();
            resolvePort(busy);
        };
        socket.setTimeout(timeoutMs, () => finish(false));
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
    });
}
/** Gnu ld 的容量写法：20K / 0x5000 / 65536 / 64M；带 +/- 的算式不猜，返回 null。 */
function parseByteLength(raw) {
    const matched = /^(0x[0-9a-f]+|\d+)\s*(k|m)?$/iu.exec(raw.trim());
    if (matched === null)
        return null;
    const literal = matched[1] ?? "";
    const base = literal.toLowerCase().startsWith("0x") ? Number.parseInt(literal, 16) : Number.parseInt(literal, 10);
    if (!Number.isFinite(base))
        return null;
    const unit = (matched[2] ?? "").toLowerCase();
    if (unit === "k")
        return base * 1024;
    if (unit === "m")
        return base * 1024 * 1024;
    return base;
}
/**
 * 从链接脚本读 MEMORY 的 RAM/FLASH 容量。
 *
 * 只认 MEMORY 行（`RAM (xrw) : ORIGIN = 0x20000000, LENGTH = 20K`）。
 * `LENGTH = 20K - 1` 这类算式返回 null：算错了不如说不知道。
 */
export function parseLinkerMemory(text) {
    const out = { ramBytes: null, flashBytes: null };
    const withoutComments = text.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/\/\/[^\n]*/gu, " ");
    const regionRe = /^[ \t]*([A-Za-z_][\w.]*)\s*(?:\([^)]*\))?\s*:\s*ORIGIN\s*=\s*[^,\n]+,\s*LENGTH\s*=\s*([^,\n;]+)/gmu;
    for (const matched of withoutComments.matchAll(regionRe)) {
        const region = (matched[1] ?? "").toUpperCase();
        const bytes = parseByteLength(matched[2] ?? "");
        if (bytes === null)
            continue;
        if (region.includes("RAM")) {
            if (out.ramBytes === null)
                out.ramBytes = bytes;
        }
        else if (region.includes("FLASH")) {
            if (out.flashBytes === null)
                out.flashBytes = bytes;
        }
    }
    return out;
}
/** cmake 源清单里的 STM32 设备宏（`set(MX_Defines_Syms ... STM32F103xB ...)` 那一行）。 */
export function deviceDefinesIn(cmakeText) {
    // 去掉注释，并把 -DSTM32F103xB 这种带 -D 的写法还原成裸宏名（-D 紧贴 S 会顶住左边界）。
    const withoutComments = cmakeText.replace(/#[^\n]*/gu, " ").replace(/-D(?=STM32[A-Z]\d{3}[A-Za-z])/gu, " ");
    const out = [];
    for (const token of withoutComments.match(/(?<![A-Za-z0-9_])STM32[A-Z]\d{3}[A-Za-z][A-Za-z0-9]?(?![A-Za-z0-9_])/gu) ?? []) {
        if (!isDeviceDefine(token))
            continue;
        if (!out.includes(token))
            out.push(token);
    }
    return out;
}
function kib(bytes) {
    return String(Math.round((bytes / 1024) * 10) / 10) + " KiB";
}
/**
 * ELF 里真正要烧进 Flash 的字节数：只算 p_paddr 落在 F1 Flash 区间（0x08000000 起 1 MiB）的 PT_LOAD。
 *
 * 为什么不用文件大小：开了 -g3 的工程 .elf 里塞着几百 KiB 调试信息，文件大小和 Flash 占用能差一个数量级，
 * 拿文件大小判"超 Flash"会在正经工程上误报。看不懂 program header 时返回 null，调用方退回文件大小并说明。
 */
export function elfFlashBytes(elfPath) {
    let buf;
    try {
        buf = readFileSync(elfPath);
    }
    catch {
        return null;
    }
    if (buf.length < 52)
        return null;
    if (buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46)
        return null;
    const isElf32 = buf[4] === 1;
    if (buf[4] !== 1 && buf[4] !== 2)
        return null;
    if (buf[5] !== 1)
        return null; // ARM 目标一律小端
    const u16 = (at) => buf.readUInt16LE(at);
    const u32 = (at) => buf.readUInt32LE(at);
    const u64 = (at) => Number(buf.readBigUInt64LE(at));
    const phoff = isElf32 ? u32(28) : u64(32);
    const phentsize = isElf32 ? u16(42) : u16(54);
    const phnum = isElf32 ? u16(44) : u16(56);
    if (phoff <= 0 || phentsize === 0 || phnum === 0)
        return null;
    const flashBase = 0x08000000;
    const flashTop = flashBase + 1024 * 1024;
    let total = 0;
    let seen = false;
    for (let index = 0; index < phnum; index += 1) {
        const at = phoff + index * phentsize;
        if (at + phentsize > buf.length)
            break;
        if (u32(at) !== 1)
            continue; // PT_LOAD
        const paddr = isElf32 ? u32(at + 12) : u64(at + 24);
        const filesz = isElf32 ? u32(at + 16) : u64(at + 32);
        if (paddr < flashBase || paddr >= flashTop)
            continue;
        total += filesz;
        seen = true;
    }
    return seen ? total : null;
}
/** .ioc 里的引脚名（可能带功能后缀：PC13-TAMPER-RTC、PD0-OSC_IN）归一化成 PA13/PC13/PD0。 */
function normalizeIocPin(pin) {
    const head = (pin.split(/[-/]/u)[0] ?? "").trim().toUpperCase();
    return /^P[A-K]\d{1,2}$/u.test(head) ? head : "";
}
/** 工程根下的 *_FLASH.ld 文件名（按名字排序）。 */
export function linkerScriptNames(projectDir) {
    if (!existsSync(projectDir))
        return [];
    try {
        return readdirSync(projectDir).filter((name) => /_FLASH\.ld$/iu.test(name)).sort();
    }
    catch {
        return [];
    }
}
/** 工程根那个链接脚本：多个时优先按芯片命名的（旧通用名 STM32F103XX_FLASH.ld 排最后）。 */
export function findLinkerScript(projectDir) {
    const names = linkerScriptNames(projectDir);
    if (names.length === 0)
        return null;
    const preferred = names.find((name) => name.toUpperCase() !== "STM32F103XX_FLASH.LD") ?? names[0];
    try {
        return { path: join(projectDir, preferred), name: preferred, text: readFileSync(join(projectDir, preferred), "utf8") };
    }
    catch {
        return null;
    }
}
/**
 * 四项一致性检查（纯函数，runDoctor 与单测共用）：
 *   ① 芯片型号 ↔ 工程根启动文件；
 *   ② 启动文件/芯片 ↔ cmake 源清单里的设备宏；
 *   ③ 链接脚本 MEMORY 的 FLASH/RAM ↔ 芯片真实容量（大了致命，小了只浪费）；
 *   ④ .elf 实际大小 ↔ Flash 容量。
 * 另外把引脚表来源（本机 db 还是 unknown、有没有校验过）写进 notes。
 */
export function checkChipConsistency(input) {
    const blockers = [];
    const notes = [];
    const cpn = input.cpn.trim();
    const mcuName = (input.mcuName ?? "").trim();
    const pins = deriveChipPinTable({ cpn, mcuName, dbMcuDir: input.dbMcuDir ?? null });
    if (cpn !== "")
        notes.push(...pins.notes);
    let chip = null;
    if (cpn !== "") {
        const resolved = resolveF1Chip(cpn);
        chip = resolved.chip;
        if (chip === null) {
            notes.push("芯片型号 " + cpn + " 没法按 F1 反推（" + resolved.reason + "）：跳过型号↔启动文件/链接脚本校验");
        }
    }
    // ① 型号 ↔ 启动文件
    const startupFiles = [...(input.startupFiles ?? [])];
    const startup = startupFiles[0] ?? "";
    const startupDefine = startup === "" ? "" : deviceDefineFromStartup(startup);
    if (startup === "") {
        notes.push("工程根没有 startup_stm32*.s：判断不了启动文件跟芯片是否配套（CubeMX 布局的 HAL 工程根上应该有一个）");
    }
    else {
        if (startupFiles.length > 1) {
            notes.push("工程根有多个启动文件（" + startupFiles.join("、") + "）：按 " + startup +
                " 判断；换过芯片请删掉旧的，否则链接期会撞重复的中断向量表");
        }
        if (chip !== null && startup.toLowerCase() !== chip.startup.toLowerCase()) {
            blockers.push("芯片 " + chip.cpn + " 的启动文件应是 " + chip.startup + "，工程根却是 " + startup +
                "（中断向量表还是别的容量档，烧进去会跑飞）");
        }
    }
    // ② 启动文件/芯片 ↔ 设备宏（cmake 源清单）
    const cmakeText = input.cmakeText ?? null;
    const cmakeDefines = cmakeText === null ? [] : deviceDefinesIn(cmakeText);
    if (cmakeText === null) {
        notes.push("没有 " + CUBEMX_CMAKE_REL + "：跳过设备宏一致性检查（不是 ST 的 CMake 布局？）");
    }
    else if (cmakeDefines.length === 0) {
        notes.push(CUBEMX_CMAKE_REL + " 里没有 STM32 设备宏（set(MX_Defines_Syms ...)）：跳过设备宏一致性检查");
    }
    else if (startupDefine !== "" && !cmakeDefines.includes(startupDefine)) {
        blockers.push("启动文件 " + startup + " 对应设备宏 " + startupDefine + "，但 " + CUBEMX_CMAKE_REL + " 里是 " +
            cmakeDefines.join(" / ") +
            "（设备宏决定 CMSIS 头的容量档与中断表，错配编出来的是不相干的工程；换芯片后重跑 stm32_generate 让 CubeMX 重写这份清单）");
    }
    const startupMatchesChip = chip !== null && (startup === "" || startup.toLowerCase() === chip.startup.toLowerCase());
    if (chip !== null && startupMatchesChip && cmakeDefines.length > 0 && !cmakeDefines.includes(chip.deviceDefine)) {
        blockers.push("芯片 " + chip.cpn + " 的设备宏应是 " + chip.deviceDefine + "，" + CUBEMX_CMAKE_REL + " 里是 " + cmakeDefines.join(" / "));
    }
    // ③ 链接脚本 MEMORY ↔ 芯片容量
    const linkerText = input.linkerText ?? null;
    const memory = linkerText === null ? null : parseLinkerMemory(linkerText);
    const linkerLabel = (input.linkerName ?? "").trim() === "" ? "链接脚本" : input.linkerName.trim();
    if (linkerText === null) {
        notes.push("工程根没有 *_FLASH.ld：跳过 MEMORY 容量校验（链接脚本缺失或命名不同）");
    }
    else if (memory !== null) {
        if (memory.flashBytes === null) {
            notes.push(linkerLabel + " 里读不到 FLASH 区的 LENGTH（不是 MEMORY 写法？）：没校验 Flash 容量");
        }
        else if (chip !== null && chip.flashBytes !== null) {
            if (memory.flashBytes > chip.flashBytes) {
                blockers.push(linkerLabel + " 的 FLASH 是 " + kib(memory.flashBytes) + "，超过芯片 " + chip.cpn + " 的 " + kib(chip.flashBytes) +
                    "（链接器会照它放代码，超出物理容量的部分写不进去）");
            }
            else if (memory.flashBytes < chip.flashBytes) {
                notes.push(linkerLabel + " 只给了 " + kib(memory.flashBytes) + " Flash，芯片 " + chip.cpn + " 有 " + kib(chip.flashBytes) +
                    "：能用，但浪费了 " + kib(chip.flashBytes - memory.flashBytes) + "（按芯片重渲染 <DeviceId>_FLASH.ld 才能用满）");
            }
        }
        if (chip !== null && chip.ramBytes === null) {
            notes.push("芯片 " + chip.cpn + " 的 RAM 大小未收录：没校验链接脚本的 RAM 上限");
        }
        else if (chip !== null && chip.ramBytes !== null && memory.ramBytes !== null) {
            if (memory.ramBytes > chip.ramBytes) {
                blockers.push(linkerLabel + " 的 RAM 是 " + kib(memory.ramBytes) + "，超过芯片 " + chip.cpn + " 的 " + kib(chip.ramBytes) +
                    "（栈/堆一涨就踩到不存在的内存）");
            }
            else if (memory.ramBytes < chip.ramBytes) {
                notes.push(linkerLabel + " 只给了 " + kib(memory.ramBytes) + " RAM，芯片 " + chip.cpn + " 有 " + kib(chip.ramBytes) + "：浪费了 " + kib(chip.ramBytes - memory.ramBytes));
            }
        }
    }
    // ④ .elf ↔ Flash
    const elfSize = input.elfSize ?? 0;
    const headerBytes = input.elfPath === undefined || input.elfPath === "" ? null : elfFlashBytes(input.elfPath);
    const elfUsed = headerBytes ?? elfSize;
    const flashLimit = chip?.flashBytes ?? (memory === null ? null : memory.flashBytes);
    if (elfUsed > 0 && flashLimit !== null) {
        const usage = headerBytes === null ? ".elf 的 program header 读不出来，按文件大小 " + kib(elfUsed) + " 粗算" : ".elf 要占 " + kib(elfUsed) + " Flash";
        if (elfUsed > flashLimit) {
            blockers.push(usage + "，超过 Flash 容量 " + kib(flashLimit) +
                (chip === null ? "（按链接脚本算）" : "（芯片 " + chip.cpn + "）") +
                (headerBytes === null
                    ? "：文件大小含调试信息时会偏大，跑一次 stm32_build 看 FLASH 占用再确认；真的超了就别烧"
                    : "：链接器本该拦下，多半是 .ld 跟芯片错配，别烧"));
        }
        else if (elfUsed / flashLimit >= 0.9) {
            notes.push(".elf 已用 " + String(Math.round((elfUsed / flashLimit) * 100)) + "% Flash（" + kib(elfUsed) + " / " + kib(flashLimit) + "），快满了");
        }
    }
    // 引脚表 ↔ .ioc 用到的引脚（只有真拿到本机 db 时才比：没有内置表可退，没 db 就不判引脚存在性）
    const iocPins = [...new Set((input.iocPins ?? []).map((pin) => normalizeIocPin(pin)).filter((pin) => pin !== ""))];
    if (pins.kind === "db" && iocPins.length > 0) {
        const unknown = iocPins.filter((pin) => !pins.pins.includes(pin));
        if (unknown.length > 0) {
            notes.push(".ioc 里这些引脚不在本机 db 的 " + (mcuName === "" ? cpn : mcuName) + " 封装里：" + unknown.join("、") + "（型号或封装选错了？）");
        }
    }
    return { blockers, notes, chip, memory, pins };
}
/** 从工程读事实再判：runDoctor 用它把四项一致性接进报告（不 spawn、不写盘）。 */
export function collectChipConsistency(projectDir, options) {
    const startupFiles = listStartupFiles(projectDir);
    let cmakeText = null;
    try {
        cmakeText = readFileSync(join(projectDir, CUBEMX_CMAKE_REL), "utf8");
    }
    catch {
        cmakeText = null;
    }
    const linker = findLinkerScript(projectDir);
    const result = checkChipConsistency({
        cpn: options.cpn,
        mcuName: options.mcuName,
        startupFiles,
        cmakeText,
        linkerText: linker === null ? null : linker.text,
        linkerName: linker === null ? "" : linker.name,
        elfPath: options.elfPath ?? "",
        elfSize: options.elfSize ?? 0,
        dbMcuDir: options.dbMcuDir ?? null,
        iocPins: options.iocPins,
    });
    const names = linkerScriptNames(projectDir);
    if (names.length > 1) {
        result.notes.push("工程根有多个链接脚本（" + names.join("、") + "）：按 " + (linker === null ? (names[0] ?? "") : linker.name) + " 校验；多余的删掉，免得 -T 指错");
    }
    return result;
}
async function listProcesses(subprocess, signal) {
    const outcome = await runCapture(subprocess, {
        argv: ["tasklist", "/NH", "/FO", "CSV"],
        timeoutMs: 10_000,
        maxBytes: 512 * 1024,
        ...(signal === undefined ? {} : { signal }),
    });
    if (outcome.spawnError !== null || outcome.exitCode !== 0)
        return [];
    return parseTasklistCsv(outcome.stdout + "\n" + outcome.stderr);
}
export async function runDoctor(subprocess, request) {
    const projectDir = resolve(request.projectDir);
    const startedAt = Date.now();
    const progress = request.onProgress ?? (() => undefined);
    const config = resolveSearchConfig(process.env, {
        ...(request.binDirs === undefined ? {} : { binDirs: request.binDirs }),
        ...(request.cubeMxRoots === undefined ? {} : { cubeMxRoots: request.cubeMxRoots }),
    });
    const port = request.port ?? 3333;
    progress("探测工具链…");
    const tools = await probeAll(subprocess, buildTargets(config), config, {
        timeoutMs: Math.min(request.timeoutMs ?? 15_000, 15_000),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const missingRequired = tools.filter((tool) => tool.required && !tool.found).map((tool) => tool.label);
    progress("检查残留的调试进程与端口…");
    const [processes, portBusy, usb] = await Promise.all([
        listProcesses(subprocess, request.signal),
        checkPortBusy(port),
        usbDiagnosis(subprocess, request.signal),
    ]);
    const buildDir = detectBuildDir(projectDir) ?? "";
    const elfInfo = buildDir === "" ? null : findElf(buildDir);
    const iocPath = findIocFile(projectDir) ?? "";
    const iocWarnings = [];
    let iocMcu = null;
    let iocPins = [];
    if (iocPath !== "") {
        try {
            const summary = summarizeIoc(readFileSync(iocPath, "utf8"), iocPath);
            iocWarnings.push(...summary.warnings);
            iocMcu = { cpn: summary.mcu.cpn, name: summary.mcu.name };
            iocPins = summary.pins.map((pin) => pin.pin);
        }
        catch (error) {
            iocWarnings.push("读不了 .ioc：" + (error instanceof Error ? error.message : String(error)));
        }
    }
    const blockers = [];
    const notes = [];
    for (const tool of tools) {
        if (!tool.required || tool.found)
            continue;
        blockers.push("缺少必需组件：" + tool.label + (tool.hint === "" ? "" : "（" + tool.hint + "）"));
    }
    if (missingRequired.length > 0) {
        notes.push("工具搜索范围：" + describeSearchScope(config.binDirs, "PATH") + "（缺失时按上面的 hint 装好后重跑）");
    }
    if (!discoveryDisabled()) {
        const discovered = discoverInstalls();
        const found = [];
        if (discovered.binDirs.length > 0)
            found.push("工具链 " + discovered.binDirs.join("、"));
        if (discovered.cubeMxRoots.length > 0)
            found.push("CubeMX " + discovered.cubeMxRoots.join("、"));
        if (found.length > 0)
            notes.push("自动发现（已追加到候选尾部）：" + found.join("；"));
    }
    const cubeMxTool = tools.find((tool) => tool.id === "cubemx");
    if (cubeMxTool !== undefined && !cubeMxTool.found) {
        notes.push("CubeMX 搜索范围：" + describeSearchScope(config.cubeMxRoots) + "（只有生成工程需要）");
    }
    const openOcdProcesses = processes.filter((process) => process.name.toLowerCase() === "openocd.exe");
    if (openOcdProcesses.length > 0) {
        blockers.push("有 openocd 正在运行（PID " + openOcdProcesses.map((process) => String(process.pid)).join(", ") +
            "），它很可能占着 CMSIS-DAP 探针；先结束这些进程再烧录/调试");
    }
    if (portBusy) {
        blockers.push("gdb 端口 " + String(port) + " 已被监听（可能是上一次调试会话没退干净），debug_run/flash 会顺延或失败");
    }
    if (elfInfo === null)
        notes.push(buildDir === "" ? "找不到构建目录：先跑 stm32_build" : "构建目录里还没有 .elf：先跑 stm32_build");
    if (usb.kind === "no-usb") {
        blockers.push("USB：" + usb.detail);
    }
    else if (usb.kind !== "ok" && usb.kind !== "unknown") {
        notes.push("USB：" + usb.detail);
    }
    else if (usb.kind === "ok") {
        notes.push("USB：探针在线（CMSIS-DAP 已枚举）。");
    }
    if (iocPath === "")
        notes.push("工程根目录里没有 .ioc：generate/ioc_inspect 用不了");
    for (const warning of iocWarnings)
        blockers.push(".ioc：" + warning);
    // 芯片一致性：型号 ↔ 启动文件 ↔ 设备宏 ↔ .ld MEMORY ↔ .elf（没有 .ioc 就没有芯片主张，跳过）。
    if (iocMcu !== null && iocMcu.cpn !== "") {
        progress("核对芯片/启动文件/设备宏/链接脚本是否配套…");
        const chipCheck = collectChipConsistency(projectDir, {
            cpn: iocMcu.cpn,
            mcuName: iocMcu.name,
            elfPath: elfInfo === null ? "" : elfInfo.path,
            elfSize: elfInfo === null ? 0 : elfInfo.size,
            dbMcuDir: findMcuDbDir(config.cubeMxRoots),
            iocPins,
        });
        blockers.push(...chipCheck.blockers);
        notes.push(...chipCheck.notes);
    }
    if (blockers.length === 0)
        notes.push("环境就绪：工具链齐全、探针没被占、.ioc 没有致命告警");
    const message = blockers.length === 0
        ? "环境就绪（工具链 " + String(tools.filter((tool) => tool.found).length) + "/" + String(tools.length) + " 项可用）"
        : "发现 " + String(blockers.length) + " 个阻塞项";
    return {
        ok: blockers.length === 0,
        projectDir,
        message,
        durationMs: Date.now() - startedAt,
        missingRequired,
        tools,
        processes,
        port,
        portBusy,
        buildDir,
        elfPath: elfInfo === null ? "" : elfInfo.path,
        elfSize: elfInfo === null ? 0 : elfInfo.size,
        iocPath,
        iocWarnings,
        usb,
        blockers,
        notes,
    };
}
