/**
 * L2：flash —— 只烧录，不进调试会话（用户最初的痛点：F5/Ctrl+F5 都会把调试器拉起来）。
 *
 * 干的事就是命令行等价物：
 *   openocd -f <cfg> -c "program <elf> verify reset exit"
 * 跑完 reset run 就退出，探针立刻释放，不留后台 server，也不停核。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { chooseOpenocdTarget, readProjectFamily } from "../data/family.js";
import { describeSearchScope, resolveSearchConfig } from "../data/search-roots.js";
import { liveProbeChoice, usbDiagnosis } from "./doctor.js";
import { cubeProgrammerBackendNote, findCubeProgrammerCli, runCubeProgrammerFlash } from "./cube-programmer.js";
import { classifyProbeFailure, makeProbeError, probeMissingLines, usbNoteFor } from "./probe-error.js";
import { detectBuildDir, elfSelectionNote, findElf } from "./build.js";
import { findIocFile } from "./generate.js";
import { summarizeIoc } from "./ioc.js";
import { resolveToolIn } from "./probe.js";
import { runStreaming } from "./subprocess-runner.js";
/**
 * A5 守卫：.ioc 里没启用 Serial Wire 时，CubeMX 会生成 __HAL_AFIO_REMAP_SWJ_DISABLE()，
 * 烧完 SWD 就废了，下一次只能靠 BOOT0 进系统 bootloader 救回来。
 * 所以**烧录前**先看 .ioc，宁可拒绝也不要烧成砖。没有 .ioc 时不拦（可能是别人给的 hex 工程）。
 */
export function checkNoDebugGuard(projectDir, allowNoDebug = false, explicitIoc = "") {
    if (allowNoDebug)
        return { blocked: false, errors: [], notes: [] };
    const iocPath = explicitIoc !== ""
        ? (isAbsolute(explicitIoc) ? explicitIoc : resolve(projectDir, explicitIoc))
        : findIocFile(projectDir);
    if (iocPath === null || !existsSync(iocPath)) {
        // 审计 A6：findIocFile 只认「唯一」，0 个或有多个都返回 null。以前这里静默放行，
        // 用户拿别人的工程（或 demo.ioc + demo_backup.ioc）时 SWD 守卫等于不存在，
        // 烧下去 SWD 被关掉只能 BOOT0 救砖。现在至少要把"守卫没生效"说清楚。
        let names = [];
        try {
            names = existsSync(projectDir)
                ? readdirSync(projectDir).filter((name) => name.toLowerCase().endsWith(".ioc"))
                : [];
        }
        catch {
            names = [];
        }
        const why = iocPath !== null && explicitIoc !== ""
            ? "指定的 .ioc 不存在：" + iocPath
            : names.length === 0
                ? "工程里没有 .ioc"
                : "工程里有 " + String(names.length) + " 个 .ioc（" + names.join("、") + "），分不清用哪个";
        // 2c：没有 .ioc（寄存器工程就是这样）时退回看 openocd.cfg 的 transport——
        // 插件生成的 cfg 固定是 hla_swd；用户换成 jtag 的 cfg 就给警告，守卫从此也覆盖寄存器工程。
        const cfg = findProjectConfig(projectDir);
        if (cfg !== null) {
            try {
                const cfgText = readFileSync(cfg, "utf8");
                const isSwd = /transport\s+select\s+(?:hla_)?swd/iu.test(cfgText);
                const isJtag = /transport\s+select\s+jtag/iu.test(cfgText);
                if (isSwd) {
                    return {
                        blocked: false,
                        errors: [],
                        notes: ["SWD 守卫（openocd.cfg 版）：transport 是 swd，探针侧不会关调试口；固件侧仍可能自己关 SWD，烧录前自行确认固件没动 AFIO_MAPR。"],
                    };
                }
                if (isJtag) {
                    return {
                        blocked: false,
                        errors: [],
                        notes: [
                            "SWD 守卫（openocd.cfg 版）：openocd.cfg 选了 jtag 而不是 swd。F103 的 JTAG 引脚与 SWD 引脚复用，" +
                                "用 JTAG 烧录前确认固件没有把 PA13/PA14 改作他用。",
                        ],
                    };
                }
                return { blocked: false, errors: [], notes: ["SWD 守卫没生效：" + why + "；openocd.cfg 里也没有 transport select，无法判断。"] };
            }
            catch {
                return { blocked: false, errors: [], notes: ["读不了 openocd.cfg（" + cfg + "），跳过 SWD 守卫"] };
            }
        }
        return {
            blocked: false,
            errors: [],
            notes: [
                "SWD 守卫没生效：" + why + "。烧录前请自己确认 .ioc 里 PA13 是 SYS_JTMS-SWDIO、PA14 是 SYS_JTCK-SWCLK；" +
                    "没启用 Serial Wire 时烧下去会关掉 SWD，之后只能 BOOT0=1 进系统 bootloader 救回来。",
                "如需自动检查：工程根目录只保留一个 .ioc，或为 stm32_flash 传入 iocPath 指向正确文件。",
            ],
        };
    }
    let summary;
    try {
        summary = summarizeIoc(readFileSync(iocPath, "utf8"), iocPath);
    }
    catch {
        return { blocked: false, errors: [], notes: ["读不了 .ioc（" + iocPath + "），跳过 SWD 守卫"] };
    }
    if (summary.debug.serialWire)
        return { blocked: false, errors: [], notes: [] };
    return {
        blocked: true,
        errors: [summary.warnings[0] ?? "没有启用 Serial Wire 调试口（缺 SYS_JTMS-SWDIO/SYS_JTCK-SWCLK）"],
        notes: [
            "没烧：.ioc 里没启用 Serial Wire，烧下去固件会关掉 SWD，之后只能靠 BOOT0=1 进系统 bootloader 才能再连上。",
            "修法一（推荐）：stm32_ioc_plan 里把 PA13 设为 SYS_JTMS-SWDIO、PA14 设为 SYS_JTCK-SWCLK → stm32_ioc_apply → stm32_generate，再烧。",
            "修法二（确认已经连不上、要救砖）：真的想烧就带 allowNoDebug=true，承认烧完要按 BOOT0 恢复。",
            "参考文件：" + iocPath,
        ],
    };
}
/** openocd 的相对路径参数一律换成正斜杠：反斜杠会被 Tcl 当转义吃掉。 */
export function toOpenOcdPath(path) {
    return path.replace(/\\/gu, "/");
}
/** 把 program 参数拼成一条 openocd -c 命令。 */
export function buildProgramCommand(elfPath, options = {}) {
    const parts = ["program", '"' + toOpenOcdPath(elfPath) + '"'];
    if (options.verify !== false)
        parts.push("verify");
    if (options.reset !== false)
        parts.push("reset");
    if (options.exit !== false)
        parts.push("exit");
    return parts.join(" ");
}
/** 只在展示时用：参数里已经带双引号时改用单引号，避免出现 "program "x.elf" verify"。 */
export function quoteForDisplay(item) {
    if (!item.includes(" "))
        return item;
    return item.includes('"') ? "'" + item + "'" : '"' + item + '"';
}
/**
 * 内置回退配置：探针仅 CMSIS-DAP（规格 §13），target 按芯片族选择。
 *
 * family 省略/null 时保持历史行为回退 stm32f1x。真正的"按族选 target + 选不出来就拒绝"
 * 走 chooseOpenocdTarget（data/family.ts）——这里只负责拼相对路径。
 */
export function defaultConfigs(family) {
    const target = family === undefined || family === null ? "stm32f1x" : (family.openocdTarget ?? "stm32f1x");
    return { interfaceConfig: "interface/cmsis-dap.cfg", targetConfig: "target/" + target + ".cfg" };
}
export function findProjectConfig(projectDir, explicit) {
    if (explicit !== undefined && explicit !== "") {
        const abs = isAbsolute(explicit) ? explicit : resolve(projectDir, explicit);
        return existsSync(abs) ? abs : null;
    }
    for (const candidate of ["openocd.cfg", "openocd/openocd.cfg", "OpenOCD.cfg"]) {
        const abs = resolve(projectDir, candidate);
        if (existsSync(abs))
            return abs;
    }
    return null;
}
export function resolveElf(projectDir, request) {
    if (request.elfPath !== undefined && request.elfPath !== "") {
        const abs = isAbsolute(request.elfPath) ? request.elfPath : resolve(projectDir, request.elfPath);
        if (existsSync(abs))
            return { elf: abs, buildDir: null, note: "" };
        return { elf: null, buildDir: null, note: "指定的 .elf 不存在：" + abs };
    }
    const buildDir = request.buildDir !== undefined && request.buildDir !== ""
        ? (isAbsolute(request.buildDir) ? request.buildDir : resolve(projectDir, request.buildDir))
        : detectBuildDir(projectDir);
    if (buildDir === null)
        return { elf: null, buildDir: null, note: "找不到构建目录（先跑 stm32_build）" };
    const elfInfo = findElf(buildDir);
    if (elfInfo === null)
        return { elf: null, buildDir, note: "构建目录里没有 .elf（先跑 stm32_build）" };
    return { elf: elfInfo.path, buildDir, note: "" };
}
/**
 * 认 openocd 的 ** Programming Finished ** / ** Verified OK ** 与 Error: 行。
 * 归类不在这里做：失败原因要连退出码/超时/启动失败一起看，统一走 probe-error.ts 的
 * classifyProbeFailure（B2 之后只有这一个分类入口，避免两份规则漂移）。
 */
export function parseFlashLog(text) {
    const programmed = /\*\*\s*Programming Finished\s*\*\*/u.test(text);
    const verified = /\*\*\s*Verified OK\s*\*\*/u.test(text);
    // A25：以成功序列为主判据。openocd 成功时也会打 Error: 前缀的行（无关 ACK / DAP 噪声），
    // 以前将这些输出一律视为失败，导致「烧录成功、已校验」被判为失败。
    const succeeded = programmed && verified;
    const errors = [];
    const noise = [];
    const seen = new Set();
    for (const raw of text.split(/\r?\n/u)) {
        const line = raw.trim();
        if (line === "")
            continue;
        const isError = /^Error:/u.test(line) ||
            /\*\*\s*(Programming|Verify|Reset)[^]*Failed[^]*\*\*/u.test(line) ||
            /^Error: Error connecting DP/u.test(line) ||
            /no device found/i.test(line) ||
            /unable to find a matching CMSIS-DAP device/iu.test(line);
        if (!isError)
            continue;
        if (seen.has(line))
            continue;
        seen.add(line);
        if (succeeded)
            noise.push(line);
        else
            errors.push(line);
    }
    return { programmed, verified, errors, noise };
}
/**
 * 两条后端共用的前置：找 .elf、按 .ioc 过 SWD 守卫、把"烧的是哪一个"说清楚。
 * 后端只决定"字节怎么进 Flash"；这些判断与后端无关——CubeProgrammer 同样会把 SWD 烧失联。
 */
function prepareFlashTarget(projectDir, request, startedAt) {
    const notes = [];
    const elfResolved = resolveElf(projectDir, request);
    if (elfResolved.elf === null) {
        return {
            ok: false,
            report: {
                ok: false, projectDir, elfPath: "", elfSize: 0, command: "", args: [], configs: [],
                durationMs: Date.now() - startedAt, programmed: false, verified: false,
                probeError: null,
                errors: [elfResolved.note], message: "没烧：找不到要烧的 .elf", logTail: "", notes,
            },
        };
    }
    const elfPath = elfResolved.elf;
    const elfSize = statSync(elfPath).size;
    // 多个 .elf 并存时说明"烧录的是哪一个、选择该文件的原因"。
    const selectionNote = elfSelectionNote(dirname(elfPath));
    if (selectionNote !== "")
        notes.push(selectionNote);
    // A5：先看 .ioc，别把 SWD 烧死。
    const guard = checkNoDebugGuard(projectDir, request.allowNoDebug === true, request.iocPath ?? "");
    if (!guard.blocked && guard.notes.length > 0)
        notes.push(...guard.notes);
    if (guard.blocked) {
        return {
            ok: false,
            report: {
                ok: false, projectDir, elfPath, elfSize, command: "", args: [], configs: [],
                durationMs: Date.now() - startedAt, programmed: false, verified: false,
                // 守卫拒绝不是探针故障：这次连烧录器都没起，probeError 保持 null。
                probeError: null,
                errors: guard.errors, message: "没烧：.ioc 里没启用 Serial Wire（SWD 会被关掉）",
                logTail: "", notes: [...notes, ...guard.notes], guard: "no-debug",
            },
        };
    }
    return { ok: true, projectDir, elfPath, elfSize, notes };
}
/**
 * CLI 的失败文本不在 openocd 的错误字符串里，classifyProbeFailure 认不出，
 * 这里只归两类有把握的：没看见 ST-Link（换探针/插好）与连不上目标（供电/接线/芯片）。
 */
function cliFailureProbeError(errors) {
    const text = errors.join("\n");
    if (/No ST-Link detected|no st-link/iu.test(text)) {
        return makeProbeError("no-probe", { cause: "CubeProgrammer 没看到 ST-LINK", evidence: errors.slice(0, 3) });
    }
    if (/Unable to connect|Cannot connect/iu.test(text)) {
        return makeProbeError("target-mismatch", { cause: "CubeProgrammer 连不上目标", evidence: errors.slice(0, 3) });
    }
    return null;
}
/** CubeProgrammer 后端（ST-LINK 官方 CLI）：不经过 openocd，也不依赖 target/flash 脚本。 */
async function runCubeProgrammerBackend(subprocess, request, probeNote) {
    const projectDir = resolve(request.projectDir);
    const startedAt = Date.now();
    const target = prepareFlashTarget(projectDir, request, startedAt);
    if (!target.ok)
        return target.report;
    const { elfPath, elfSize } = target;
    const notes = target.notes;
    if (probeNote !== "")
        notes.unshift(probeNote);
    const config = resolveSearchConfig(process.env, request.binDirs === undefined ? {} : { binDirs: request.binDirs });
    const cli = findCubeProgrammerCli(config.cubePrgBins);
    if (cli === null) {
        const searched = describeSearchScope(config.cubePrgBins, "STM32_CUBE_PRG_ROOT");
        return {
            ok: false, projectDir, elfPath, elfSize, command: "", args: [], configs: [],
            durationMs: Date.now() - startedAt, programmed: false, verified: false,
            probeError: null,
            errors: ["没找到 STM32_Programmer_CLI.exe（查过 " + searched + "）"],
            message: "没烧：backend=cubeprogrammer 需要 STM32CubeProgrammer 的 CLI，本机没找到" +
                "（下载安装：https://www.st.com/en/development-tools/stm32cubeprog.html；默认路径即可被自动发现，装在别处就设 STM32_CUBE_PRG_ROOT）",
            logTail: "", notes,
        };
    }
    const alt = await runCubeProgrammerFlash(subprocess, {
        projectDir,
        elfPath,
        cliPath: cli,
        ...(request.adapterSpeed === undefined ? {} : { adapterSpeed: request.adapterSpeed }),
        runAfterReset: request.runAfterReset !== false,
        timeoutMs: request.timeoutMs ?? 120_000,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress }),
    });
    if (alt.ok)
        notes.push(cubeProgrammerBackendNote(cli));
    return {
        ok: alt.ok,
        projectDir,
        elfPath,
        elfSize,
        command: alt.command,
        args: alt.args,
        configs: [],
        durationMs: Date.now() - startedAt,
        ...(alt.exitCode === null ? {} : { exitCode: alt.exitCode }),
        programmed: alt.programmed,
        verified: alt.verified,
        probeError: alt.ok ? null : cliFailureProbeError(alt.errors),
        errors: alt.errors,
        message: alt.message,
        logTail: alt.logTail,
        notes,
    };
}
/** openocd 后端主体；ifaceOverride 仅在工程没有自己的 openocd.cfg 时参与回退 interface 选择。 */
async function runOpenocdFlash(subprocess, request, ifaceOverride) {
    const projectDir = resolve(request.projectDir);
    const config = resolveSearchConfig(process.env, request.binDirs === undefined ? {} : { binDirs: request.binDirs });
    const startedAt = Date.now();
    const target = prepareFlashTarget(projectDir, request, startedAt);
    if (!target.ok)
        return target.report;
    const { elfPath, elfSize } = target;
    const notes = target.notes;
    const openOcd = request.openOcdPath !== undefined && request.openOcdPath !== ""
        ? request.openOcdPath
        : await resolveToolIn(subprocess, ["openocd"], config.binDirs);
    if (openOcd === null) {
        return {
            ok: false, projectDir, elfPath, elfSize, command: "", args: [], configs: [],
            durationMs: Date.now() - startedAt, programmed: false, verified: false,
            probeError: null,
            errors: ["找不到 openocd"],
            message: "没烧：找不到 openocd（msys64 里 pacman -S mingw-w64-ucrt-x86_64-openocd）；查过 " +
                describeSearchScope(config.binDirs, "PATH"),
            logTail: "",
            notes,
        };
    }
    const configs = [];
    const projectConfig = findProjectConfig(projectDir, request.configFile);
    if (projectConfig !== null) {
        configs.push(toOpenOcdPath(projectConfig));
    }
    else {
        // 按 .ioc 的 Mcu.Family 选 target：F1 仍是 stm32f1x，换了族不会再拿 F1 的脚本硬连。
        const family = readProjectFamily(projectDir);
        const choice = chooseOpenocdTarget(family);
        if (choice.error !== "") {
            return {
                ok: false, projectDir, elfPath, elfSize, command: "", args: [], configs: [],
                durationMs: Date.now() - startedAt, programmed: false, verified: false,
                probeError: null,
                errors: [choice.error],
                message: "没烧：" + (family === null ? "认不出芯片族" : "本机 openocd 没有 " + family.id + " 的 target 脚本"),
                logTail: "",
                notes,
            };
        }
        configs.push(request.interfaceConfig ?? ifaceOverride ?? "interface/cmsis-dap.cfg", request.targetConfig ?? choice.targetConfig);
        notes.push("工程里没有 openocd 配置文件，回退到 " + configs.join(" + "));
        if (family !== null)
            notes.push("芯片族按 .ioc 判定：" + family.id + "（内核 " + family.core + "）");
        if (choice.note !== "")
            notes.push(choice.note);
    }
    const args = [openOcd];
    for (let i = 0; i < configs.length; i += 1) {
        const cfg = configs[i] ?? "";
        args.push("-f", cfg);
        // J-Link 的 interface/jlink.cfg 只写 `adapter driver jlink`：不显式选 transport 时 openocd
        // 默认 jtag，SWD 目标会报 "No J-Link device found"。工程自带 cfg 时按其 source 的 interface 判断。
        if (projectConfig !== null && i === 0) {
            let projectText = "";
            try {
                projectText = readFileSync(projectConfig, "utf8");
            }
            catch {
                projectText = "";
            }
            if (/interface\/jlink\.cfg/u.test(projectText))
                args.push("-c", "transport select swd");
        }
        else if (/jlink/iu.test(cfg)) {
            args.push("-c", "transport select swd");
        }
    }
    if (request.adapterSpeed !== undefined)
        args.push("-c", "adapter speed " + String(request.adapterSpeed));
    args.push("-c", buildProgramCommand(elfPath, { reset: request.runAfterReset !== false }));
    const command = args.map(quoteForDisplay).join(" ");
    request.onProgress?.("烧录：" + command);
    const outcome = await runStreaming(subprocess, {
        argv: args,
        cwd: projectDir,
        timeoutMs: request.timeoutMs ?? 120_000,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        onOutput: (stream, text) => {
            for (const line of text.split(/\r?\n/u)) {
                if (line.trim() !== "")
                    request.onProgress?.(line.trim());
            }
        },
    });
    const log = outcome.stdout + "\n" + outcome.stderr;
    const verdict = parseFlashLog(log);
    const errors = [...verdict.errors];
    if (outcome.spawnError !== null)
        errors.push("openocd 启动失败：" + outcome.spawnError);
    if (outcome.timedOut)
        errors.push("超时（" + String(request.timeoutMs ?? 120_000) + " ms）：烧录没跑完");
    if (verdict.noise.length > 0) {
        notes.push("openocd 成功路径上的 " + String(verdict.noise.length) + " 条 Error: 行按噪声处理（首条：" +
            (verdict.noise[0] ?? "") + "）");
    }
    const ok = outcome.exitCode === 0 && outcome.spawnError === null && !outcome.timedOut && verdict.programmed && errors.length === 0;
    if (!ok && verdict.programmed && !verdict.verified)
        notes.push("写入成功但校验没过，建议重试或降低 adapter speed");
    if (ok)
        notes.push("产物：" + basename(elfPath) + "（" + String(elfSize) + " B）已写入并复位运行，探针已释放");
    // B2：失败时只归一次类。模型按 kind 分支、按 hint 动手，不用自己解析中文 message。
    // unknown 不往 notes 里推 hint：没有依据的"下一步"只会盖住真正的根因。
    const probeError = ok
        ? null
        : classifyProbeFailure({
            // 分类要看**完整日志**，不能只看解析出的 Error 行：target 不匹配这类故障，
            // openocd 只打一行 `Warn : Cannot identify target as a STM32 family.`（2026-10-31 实测，
            // 仅检查 errors 时会落到 unknown）。errors 中还包含本插件合成的行（spawn 失败/超时），排在后面。
            lines: [
                ...log.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== ""),
                ...errors,
            ],
            exitCode: outcome.exitCode,
            stage: "flash",
            timedOut: outcome.timedOut,
            spawnError: outcome.spawnError,
        });
    if (probeError !== null && probeError.kind !== "unknown")
        notes.push(probeError.hint);
    if (probeError !== null && probeError.kind === "no-probe" && probeMissingLines(errors).length > 0) {
        // 2a：找不到设备时同时做一次 USB 形态诊断——"未插入"与"这台机器没有 USB"是两种结论。
        // 诊断失败静默（unknown 不写入 notes），诊断异常不得增加失败报告的噪声。
        const usb = await usbDiagnosis(subprocess, request.signal);
        const extra = usbNoteFor(usb.kind, usb.detail);
        if (extra !== null)
            notes.push(extra);
    }
    const message = ok
        ? "烧录成功（" + ((Date.now() - startedAt) / 1000).toFixed(1) + " s" + (verdict.verified ? "，已校验" : "") + "）"
        : "烧录失败：" + (errors[0] ?? "openocd 退出码 " + String(outcome.exitCode));
    return {
        ok, projectDir, elfPath, elfSize, command, args, configs,
        durationMs: Date.now() - startedAt,
        ...(outcome.exitCode === null ? {} : { exitCode: outcome.exitCode }),
        programmed: verdict.programmed, verified: verdict.verified,
        probeError,
        errors, message, logTail: log.split(/\r?\n/u).slice(-25).join("\n"), notes,
    };
}
/**
 * 烧录编排器（2026-11-08 复盘后的两层修复）：
 *
 * 1. **interface 先探后选**：以前回退配置硬编码 cmsis-dap（规格 §13 的旧前提），插 ST-Link 的
 *    用户直接被带偏——openocd 报 "unable to find a matching CMSIS-DAP device"，还得人肉猜。
 *    现在先 usbDiagnosis（VID:PID 分流）按实见探针选 interface；工程自带 openocd.cfg 时不插手
 *    （那是用户显式配置，只在失败后提示改哪一行）。
 * 2. **换 interface 自动重试一次**：仍报 probe-interface-mismatch 就切另一个驱动再跑。
 * 3. **CubeProgrammer 回退**：openocd 两条路径均失败、实见探针是 ST-LINK、本机安装了 CubeProgrammer、
 *    且失败不是「换后端也没用」类（swd-locked/no-power/flash-protected）时，走 CLI 第二后端。
 *    DAPLink 用户没有这条腿（CLI 只认 ST-LINK），报告里如实说。
 */
export async function runFlash(subprocess, request) {
    const backend = request.backend ?? "auto";
    const hasProjectCfg = findProjectConfig(request.projectDir, request.configFile) !== null;
    let ifaceOverride;
    let probeNote = "";
    let sawStLink = false;
    let sawDapFamily = false;
    let sawJlink = false;
    // CLI 后端同样需要探针类型（该后端只认 ST-LINK），因此不能只按 interfaceConfig 是否显式给出决定是否探测。
    if (request.interfaceConfig === undefined || backend === "cubeprogrammer") {
        const live = await liveProbeChoice(subprocess, request.signal);
        sawStLink = live.swdProbes.some((p) => p.kind === "st-link");
        sawDapFamily = live.swdProbes.some((p) => p.kind === "cmsis-dap" || p.kind === "daplink");
        sawJlink = live.swdProbes.some((p) => p.kind === "jlink");
        if (live.swdProbes.length > 0) {
            if (request.interfaceConfig === undefined && !hasProjectCfg)
                ifaceOverride = live.cfg;
            probeNote = "探针实见：" + live.swdProbes.map((p) => p.label).join("、") +
                (backend === "cubeprogrammer"
                    ? ""
                    : hasProjectCfg
                        ? "（工程自带 openocd.cfg，interface 以其为准）"
                        : "；interface 用 " + live.cfg + "（" + live.why + "）");
        }
    }
    if (backend === "cubeprogrammer") {
        // 实见的是 DAPLink/CMSIS-DAP：CLI 路径不可用，不要让其运行一次后仅报出含糊的 "no ST-Link"。
        if (sawDapFamily && !sawStLink) {
            return {
                ok: false, projectDir: resolve(request.projectDir), elfPath: "", elfSize: 0, command: "", args: [], configs: [],
                durationMs: 0, programmed: false, verified: false, probeError: null,
                errors: ["CubeProgrammer CLI 的 SWD 路径只认 ST-LINK，实见的是 CMSIS-DAP/DAPLink 类探针"],
                message: "没烧：backend=cubeprogrammer 只认 ST-LINK；这块探针请用 backend=auto（openocd）",
                logTail: "", notes: probeNote === "" ? [] : [probeNote],
            };
        }
        return runCubeProgrammerBackend(subprocess, request, probeNote);
    }
    let report = await runOpenocdFlash(subprocess, request, ifaceOverride);
    if (probeNote !== "")
        report.notes.unshift(probeNote);
    // 2) 接口不匹配 → 更换另一个 interface 重试一次（仅限使用插件回退配置的工程；手写 cfg 的工程由用户按 hint 修改）
    if (!report.ok && !hasProjectCfg && report.probeError !== null && report.probeError.kind === "probe-interface-mismatch") {
        // 换哪条由**实见探针**决定，不是"把当前值取反"：取反在探针结论过期/缺失时会把重试引向
        // 与真实硬件无关的方向（CI 上 2 条用例即因此失败）。实见 ST-LINK 时先试 stlink。
        const firstIface = ifaceOverride ?? "interface/cmsis-dap.cfg";
        const guided = sawStLink ? "interface/stlink-dap.cfg" : sawDapFamily ? "interface/cmsis-dap.cfg" : sawJlink ? "interface/jlink.cfg" : "";
        const other = guided !== "" && guided !== firstIface
            ? guided
            : firstIface === "interface/cmsis-dap.cfg" ? "interface/stlink-dap.cfg" : "interface/cmsis-dap.cfg";
        const firstMessage = report.message;
        const retry = await runOpenocdFlash(subprocess, request, other);
        // notes 归属：retry 生成新报告——探针实见行、换接口说明、第一次失败原因均需附加到该报告
        // （第一版把"自动换…"push 进了旧 report，随对象丢弃，测试当场抓到）。
        if (probeNote !== "")
            retry.notes.unshift(probeNote);
        retry.notes.push("openocd 报探针驱动不匹配，自动换 " + other + " 重试一次（第 1 次：" + firstMessage + "）");
        report = retry;
    }
    // 3) CubeProgrammer 第二后端
    const futile = report.probeError !== null && ["swd-locked", "no-power", "flash-protected", "probe-busy"].includes(report.probeError.kind);
    const fallbackAllowed = backend !== "openocd" && !futile && report.elfPath !== "" && sawStLink;
    if (!report.ok && fallbackAllowed) {
        const config = resolveSearchConfig(process.env, request.binDirs === undefined ? {} : { binDirs: request.binDirs });
        const cli = findCubeProgrammerCli(config.cubePrgBins);
        if (cli !== null) {
            report.notes.push(report.configs.length === 0
                ? "openocd 根本没起来（没有可用的 target 脚本），直接试 CubeProgrammer CLI（ST-LINK 后端）…"
                : "openocd 没烧成（" + String(report.configs.length) + " 个配置都试过），改试 CubeProgrammer CLI（ST-LINK 后端）…");
            const alt = await runCubeProgrammerFlash(subprocess, {
                projectDir: request.projectDir,
                elfPath: report.elfPath,
                cliPath: cli,
                ...(request.adapterSpeed === undefined ? {} : { adapterSpeed: request.adapterSpeed }),
                runAfterReset: request.runAfterReset !== false,
                timeoutMs: request.timeoutMs ?? 120_000,
                ...(request.signal === undefined ? {} : { signal: request.signal }),
                ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress }),
            });
            if (alt.ok) {
                return {
                    ok: true,
                    projectDir: report.projectDir,
                    elfPath: report.elfPath,
                    elfSize: report.elfSize,
                    command: alt.command,
                    args: alt.args,
                    configs: [],
                    durationMs: report.durationMs + alt.durationMs,
                    ...(alt.exitCode === null ? {} : { exitCode: alt.exitCode }),
                    programmed: alt.programmed,
                    verified: alt.verified,
                    probeError: null,
                    errors: [],
                    message: alt.message,
                    logTail: alt.logTail,
                    notes: [...report.notes, cubeProgrammerBackendNote(cli)],
                };
            }
            report.notes.push("CubeProgrammer 回退同样失败：" + alt.message + "（查过 " + alt.searched + "）");
        }
        else {
            report.notes.push("实见 ST-LINK 但本机未安装 STM32CubeProgrammer（CLI 未找到）：安装后可获得一条不依赖 openocd target 脚本的后端" +
                "（backend=cubeprogrammer 可直连；H5/WBA/WB0/WL3 只能使用该后端）。下载：https://www.st.com/en/development-tools/stm32cubeprog.html");
        }
    }
    if (!report.ok && sawJlink && !sawStLink) {
        // J-Link 也没有 CLI 腿（CubeProgrammer 的 SWD 路径只认 ST-LINK）
        report.notes.push("J-Link 没有 CubeProgrammer 备选后端（CLI 只认 ST-LINK）：openocd 的 jlink 驱动需要 `-c \"transport select swd\"`，插着 J-Link 时若仍失败，先确认 J-Link 驱动（SEGGER 的 USB Driver）与 openocd 版本。");
    }
    if (!report.ok && !futile && report.probeError !== null && report.probeError.kind === "no-probe" && sawDapFamily && !sawStLink) {
        // DAPLink 用户走不了 CLI 这条腿，别让人以为还有救
        const config = resolveSearchConfig(process.env, {});
        if (findCubeProgrammerCli(config.cubePrgBins) !== null) {
            report.notes.push("本机已安装 CubeProgrammer，但其 SWD 路径只认 ST-LINK：当前插入的是 CMSIS-DAP/DAPLink 类探针，该路径不可用（docs §79）。");
        }
    }
    return report;
}
