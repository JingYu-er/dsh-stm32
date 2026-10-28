/**
 * L2：doctor —— 回答"为什么现在跑不起来"。
 *
 * 只读：探工具链版本、找有没有残留的调试进程占着探针、看 gdb 端口是否被占、
 * 找构建目录与 .elf、把 .ioc 里的致命告警（例如没启用 Serial Wire）汇总成阻塞项。
 * 不烧录、不生成、不写工程。
 */
import { createConnection } from "node:net";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describeSearchScope, discoverInstalls, discoveryDisabled, resolveSearchConfig } from "../data/search-roots.js";
import { detectBuildDir, findElf } from "./build.js";
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
    const hasDap = /CMSIS-DAP|VID_0483&PID_374B|VID_C251&PID_F001|VID_C251&PID_F002/iu.test(pnputilText);
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
        detail: "有 USB 控制器但没看到 CMSIS-DAP 设备：检查探针有没有插好（有的线只能供电不能传数据）、" +
            "板上调试器的跳线/开关位置、以及 BOOT0 是否接错（BOOT0=1 会进系统 bootloader，SWD 不响应）。",
    };
}
async function usbDiagnosis(subprocess, signal) {
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
    if (iocPath !== "") {
        try {
            iocWarnings.push(...summarizeIoc(readFileSync(iocPath, "utf8"), iocPath).warnings);
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
