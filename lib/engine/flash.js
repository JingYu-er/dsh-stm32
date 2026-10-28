/**
 * L2：flash —— 只烧录，不进调试会话（用户最初的痛点：F5/Ctrl+F5 都会把调试器拉起来）。
 *
 * 干的事就是命令行等价物：
 *   openocd -f <cfg> -c "program <elf> verify reset exit"
 * 跑完 reset run 就退出，探针立刻释放，不留后台 server，也不停核。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { describeSearchScope, resolveSearchConfig } from "../data/search-roots.js";
import { usbDiagnosis } from "./doctor.js";
import { detectBuildDir, findElf } from "./build.js";
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
                "想让它自动检查：工程根目录只留一个 .ioc，或给 stm32_flash 传 iocPath 指向正确的那份。",
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
export function defaultConfigs() {
    // 只支持 CMSIS-DAP + STM32F1（规格 §13 已定：探针只 CMSIS-DAP，芯片只 F103C8T6）。
    return { interfaceConfig: "interface/cmsis-dap.cfg", targetConfig: "target/stm32f1x.cfg" };
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
/** 按日志行特征归码（2d）：一行命中即返回，多类并存时按先见者优先。 */
export function errorCodeOfLines(lines) {
    for (const raw of lines) {
        const line = raw.toLowerCase();
        if (/unable to find a matching cmsis-dap device|no device found/.test(line))
            return "no-probe";
        if (/adapter speed could not be limited|target is openocd and must be halted/.test(line))
            return "probe-busy";
        // 真板子取证（2026-10-28）：两个 openocd 同时抓同一个 CMSIS-DAP 时，openocd 不会报"忙"，
        // 而是两边交替收发导致 DAP 事务错位——满屏 transfer count mismatch / command mismatch。
        if (/cmsis-dap (transfer count mismatch|command mismatch)|cmsis-dap command cmd_\w+ failed|libusb_error_busy/.test(line))
            return "probe-busy";
        if (/error connecting dp|cannot read idr|ap lock|sticky error/.test(line))
            return "swd-locked";
        if (/flash programming|write protected|read protected|memory protected/.test(line))
            return "flash-protected";
        if (/target voltage may be too low|no power/.test(line))
            return "no-power";
        if (/device id|cannot identify|unexpected idcode/.test(line))
            return "target-mismatch";
    }
    return "unknown";
}
/** 认 openocd 的 ** Programming Finished ** / ** Verified OK ** 与 Error: 行。 */
export function parseFlashLog(text) {
    const programmed = /\*\*\s*Programming Finished\s*\*\*/u.test(text);
    const verified = /\*\*\s*Verified OK\s*\*\*/u.test(text);
    // A25：以成功序列为主判据。openocd 成功时也会打 Error: 前缀的行（无关 ACK / DAP 噪声），
    // 以前把它们一律当失败，于是「烧录成功、已校验」被判成失败。
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
    const flat = [...errors, ...noise];
    const errorCode = succeeded ? "" : errorCodeOfLines(flat.length === 0 ? [text] : flat);
    return { programmed, verified, errors, noise, errorCode };
}
const HINT_DP = "连不上芯片（Error connecting DP）：固件里可能关了 SWD（__HAL_AFIO_REMAP_SWJ_DISABLE），需要 BOOT0=1 重启进系统 bootloader 再烧，或按住复位键在连接瞬间松开。";
const HINT_PROBE = "找不到 CMSIS-DAP 探针：检查 USB、是否被 openocd/调试会话占用（先停掉正在跑的调试）。";
const HINT_BUSY = "探针被别的进程同时访问（两个 openocd 抢同一个 CMSIS-DAP 时不会报错，而是满屏 transfer count mismatch）：先关掉调试会话或另一个 openocd，再烧一次。";
/** openocd 报"找不到设备"的那几行错误行（2a 的判定基准，纯函数便于单测）。 */
export function probeMissingLines(errors) {
    return errors.filter((line) => /CMSIS-DAP device|no device found/iu.test(line));
}
/** USB 形态诊断的结论该以什么 note 呈现（unknown 静默：诊断失败不能把失败报告搞得更吵）。 */
export function usbNoteFor(kind, detail) {
    if (kind === "unknown")
        return null;
    return "USB 形态：" + detail;
}
export async function runFlash(subprocess, request) {
    const projectDir = resolve(request.projectDir);
    const config = resolveSearchConfig(process.env, request.binDirs === undefined ? {} : { binDirs: request.binDirs });
    const notes = [];
    const startedAt = Date.now();
    const elfResolved = resolveElf(projectDir, request);
    if (elfResolved.elf === null) {
        return {
            ok: false, projectDir, elfPath: "", elfSize: 0, command: "", args: [], configs: [],
            durationMs: Date.now() - startedAt, programmed: false, verified: false,
            errors: [elfResolved.note], message: "没烧：找不到要烧的 .elf", logTail: "", notes,
        };
    }
    const elfPath = elfResolved.elf;
    const elfSize = statSync(elfPath).size;
    // A5：先看 .ioc，别把 SWD 烧死。
    const guard = checkNoDebugGuard(projectDir, request.allowNoDebug === true, request.iocPath ?? "");
    if (!guard.blocked && guard.notes.length > 0)
        notes.push(...guard.notes);
    if (guard.blocked) {
        return {
            ok: false, projectDir, elfPath, elfSize, command: "", args: [], configs: [],
            durationMs: Date.now() - startedAt, programmed: false, verified: false,
            errors: guard.errors, message: "没烧：.ioc 里没启用 Serial Wire（SWD 会被关掉）",
            logTail: "", notes: [...notes, ...guard.notes], guard: "no-debug",
        };
    }
    const openOcd = request.openOcdPath !== undefined && request.openOcdPath !== ""
        ? request.openOcdPath
        : await resolveToolIn(subprocess, ["openocd"], config.binDirs);
    if (openOcd === null) {
        return {
            ok: false, projectDir, elfPath, elfSize, command: "", args: [], configs: [],
            durationMs: Date.now() - startedAt, programmed: false, verified: false,
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
        const fallback = defaultConfigs();
        configs.push(request.interfaceConfig ?? fallback.interfaceConfig, request.targetConfig ?? fallback.targetConfig);
        notes.push("工程里没有 openocd 配置文件，回退到 " + configs.join(" + "));
    }
    const args = [openOcd];
    for (const cfg of configs)
        args.push("-f", cfg);
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
    if (errors.some((line) => /Error connecting DP/u.test(line)))
        notes.push(HINT_DP);
    const probeMissing = probeMissingLines(errors);
    if (probeMissing.length > 0) {
        notes.push(HINT_PROBE);
        // 2a：找不到设备时顺手做一次 USB 形态诊断——"没插"与"这台机器根本没 USB"是两种答案。
        // 诊断失败静默（unknown 不进 notes），绝不能让诊断把失败报告搞得更吵。
        const usb = await usbDiagnosis(subprocess, request.signal);
        const extra = usbNoteFor(usb.kind, usb.detail);
        if (extra !== null)
            notes.push(extra);
    }
    const ok = outcome.exitCode === 0 && outcome.spawnError === null && !outcome.timedOut && verdict.programmed && errors.length === 0;
    if (!ok && verdict.programmed && !verdict.verified)
        notes.push("写入成功但校验没过，建议重试或降低 adapter speed");
    if (ok)
        notes.push("产物：" + basename(elfPath) + "（" + String(elfSize) + " B）已写入并复位运行，探针已释放");
    const message = ok
        ? "烧录成功（" + ((Date.now() - startedAt) / 1000).toFixed(1) + " s" + (verdict.verified ? "，已校验" : "") + "）"
        : "烧录失败：" + (errors[0] ?? "openocd 退出码 " + String(outcome.exitCode));
    // 2d：errorCode 供模型分流（重试 / 换线 / 停会话 / 直接问人）。
    let errorCode = verdict.errorCode;
    if (!ok && (outcome.spawnError !== null || outcome.timedOut))
        errorCode = "unknown";
    if (!ok && errorCode === "swd-locked" && errors.some((line) => /Error connecting DP/u.test(line)))
        errorCode = "swd-locked";
    if (!ok && errorCode === "probe-busy")
        notes.push(HINT_BUSY);
    return {
        ok, projectDir, elfPath, elfSize, command, args, configs,
        durationMs: Date.now() - startedAt,
        ...(outcome.exitCode === null ? {} : { exitCode: outcome.exitCode }),
        programmed: verdict.programmed, verified: verdict.verified,
        ...(errorCode === "" ? {} : { errorCode }),
        errors, message, logTail: log.split(/\r?\n/u).slice(-25).join("\n"), notes,
    };
}
