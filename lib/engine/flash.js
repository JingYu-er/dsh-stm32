/**
 * L2：flash —— 只烧录，不进调试会话（用户最初的痛点：F5/Ctrl+F5 都会把调试器拉起来）。
 *
 * 干的事就是命令行等价物：
 *   openocd -f <cfg> -c "program <elf> verify reset exit"
 * 跑完 reset run 就退出，探针立刻释放，不留后台 server，也不停核。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { describeSearchScope, resolveSearchConfig } from "../data/search-roots.js";
import { detectBuildDir, findElf } from "./build.js";
import { findIocFile } from "./generate.js";
import { summarizeIoc } from "./ioc.js";
import { resolveFromDirs } from "./probe.js";
import { runStreaming } from "./subprocess-runner.js";
/**
 * A5 守卫：.ioc 里没启用 Serial Wire 时，CubeMX 会生成 __HAL_AFIO_REMAP_SWJ_DISABLE()，
 * 烧完 SWD 就废了，下一次只能靠 BOOT0 进系统 bootloader 救回来。
 * 所以**烧录前**先看 .ioc，宁可拒绝也不要烧成砖。没有 .ioc 时不拦（可能是别人给的 hex 工程）。
 */
export function checkNoDebugGuard(projectDir, allowNoDebug = false) {
    if (allowNoDebug)
        return { blocked: false, errors: [], notes: [] };
    const iocPath = findIocFile(projectDir);
    if (iocPath === null)
        return { blocked: false, errors: [], notes: [] };
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
/** 认 openocd 的 ** Programming Finished ** / ** Verified OK ** 与 Error: 行。 */
export function parseFlashLog(text) {
    const programmed = /\*\*\s*Programming Finished\s*\*\*/u.test(text);
    const verified = /\*\*\s*Verified OK\s*\*\*/u.test(text);
    const errors = [];
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
        errors.push(line);
    }
    return { programmed, verified, errors };
}
const HINT_DP = "连不上芯片（Error connecting DP）：固件里可能关了 SWD（__HAL_AFIO_REMAP_SWJ_DISABLE），需要 BOOT0=1 重启进系统 bootloader 再烧，或按住复位键在连接瞬间松开。";
const HINT_PROBE = "找不到 CMSIS-DAP 探针：检查 USB、是否被 openocd/调试会话占用（先停掉正在跑的调试）。";
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
    const guard = checkNoDebugGuard(projectDir, request.allowNoDebug === true);
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
        : resolveFromDirs("openocd", config.binDirs);
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
    if (errors.some((line) => /Error connecting DP/u.test(line)))
        notes.push(HINT_DP);
    if (errors.some((line) => /CMSIS-DAP device|no device found/iu.test(line)))
        notes.push(HINT_PROBE);
    const ok = outcome.exitCode === 0 && outcome.spawnError === null && !outcome.timedOut && verdict.programmed && errors.length === 0;
    if (!ok && verdict.programmed && !verdict.verified)
        notes.push("写入成功但校验没过，建议重试或降低 adapter speed");
    if (ok)
        notes.push("产物：" + basename(elfPath) + "（" + String(elfSize) + " B）已写入并复位运行，探针已释放");
    const message = ok
        ? "烧录成功（" + ((Date.now() - startedAt) / 1000).toFixed(1) + " s" + (verdict.verified ? "，已校验" : "") + "）"
        : "烧录失败：" + (errors[0] ?? "openocd 退出码 " + String(outcome.exitCode));
    return {
        ok, projectDir, elfPath, elfSize, command, args, configs,
        durationMs: Date.now() - startedAt,
        ...(outcome.exitCode === null ? {} : { exitCode: outcome.exitCode }),
        programmed: verdict.programmed, verified: verdict.verified,
        errors, message, logTail: log.split(/\r?\n/u).slice(-25).join("\n"), notes,
    };
}
