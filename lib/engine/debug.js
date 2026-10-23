/**
 * L2：debug_run —— 一次调用完成"调试"：起 openocd → gdb 连上 → 断点停在指定位置 →
 * 抓一份现场（寄存器 / 调用栈 / 局部变量）→ 让目标继续跑 → 关 openocd。
 *
 * 为什么不常驻会话：用户要能在 agent 交还控制权时用 VS Code 自己调试，
 * 所以默认形态是"进来拿一次快照就走"，探针必释放（规格 §6）。
 */
import { existsSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { resolveSearchConfig } from "../data/search-roots.js";
import { detectBuildDir, findElf } from "./build.js";
import { defaultConfigs, findProjectConfig, quoteForDisplay, toOpenOcdPath } from "./flash.js";
import { resolveFromDirs } from "./probe.js";
import { runStreaming } from "./subprocess-runner.js";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/** 端口是否被占用（openocd 默认 3333 常被用户自己的调试会话占着）。 */
export function isPortBusy(port, timeoutMs = 800) {
    return new Promise((done) => {
        const socket = createConnection({ port, host: "127.0.0.1" });
        const finish = (busy) => {
            socket.removeAllListeners();
            socket.destroy();
            done(busy);
        };
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => finish(true));
        socket.once("timeout", () => finish(false));
        socket.once("error", () => finish(false));
    });
}
export async function pickPort(preferred = 3333) {
    for (let offset = 0; offset < 10; offset += 1) {
        const port = preferred + offset;
        if (!(await isPortBusy(port)))
            return port;
    }
    return preferred;
}
const REGISTER_NAMES = ["pc", "sp", "lr", "xpsr"];
/** 从 gdb -batch 输出里抠出断点位置、寄存器、调用栈。 */
export function parseGdbOutput(text) {
    const errors = [];
    let hitBreakpoint = false;
    let location = "";
    const registers = [];
    const backtrace = [];
    const locals = [];
    for (const raw of text.split(/\r?\n/u)) {
        const line = raw.trim();
        if (line === "")
            continue;
        if (/^Breakpoint \d+,/u.test(line)) {
            hitBreakpoint = true;
            location = line.replace(/^Breakpoint \d+,\s*/u, "");
            continue;
        }
        if (/^0x[0-9a-fA-F]+ in /u.test(line) && location === "") {
            location = line;
            continue;
        }
        const registerMatch = /^(pc|sp|lr|xpsr)\s+(0x[0-9a-fA-F]+)/u.exec(line);
        if (registerMatch !== null && registerMatch[1] !== undefined && registerMatch[2] !== undefined) {
            registers.push({ name: registerMatch[1], value: registerMatch[2] });
            continue;
        }
        if (/^#\d+\s/u.test(line)) {
            backtrace.push(line);
            continue;
        }
        const localMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/u.exec(line);
        if (localMatch !== null && !/^(Info|Warn|Error)\b/u.test(line)) {
            locals.push(line);
            continue;
        }
        if (/^(Remote communication error|Cannot access memory|No symbol|error:|\.gdbinit)/iu.test(line))
            errors.push(line);
    }
    for (const name of REGISTER_NAMES) {
        if (!registers.some((item) => item.name === name))
            continue;
    }
    return { hitBreakpoint, location, registers, backtrace, locals, errors };
}
/** 等 openocd 打出 "Listening on port"（或超时）。 */
export async function waitForListening(handle, timeoutMs, onText) {
    const startedAt = Date.now();
    let outOffset = 0;
    let errOffset = 0;
    let text = "";
    const drain = () => {
        let sawListening = /Listening on port \d+/u.test(text);
        for (const [reader, key] of [[handle.collected.stdout, "out"], [handle.collected.stderr, "err"]]) {
            if (reader === undefined)
                continue;
            const chunk = reader.readFrom(key === "out" ? outOffset : errOffset);
            if (key === "out")
                outOffset = chunk.nextOffset;
            else
                errOffset = chunk.nextOffset;
            if (chunk.text === "")
                continue;
            text += chunk.text;
            onText?.(chunk.text.trim());
            if (/Listening on port \d+/u.test(chunk.text))
                sawListening = true;
        }
        return sawListening;
    };
    while (Date.now() - startedAt < timeoutMs) {
        // openocd 的日志其实走 stderr，两路都要读，否则永远等不到 "Listening on port"。
        if (drain())
            return { ok: true, text };
        const exit = await Promise.race([handle.done.then(() => true), sleep(200).then(() => false)]);
        if (exit === true) {
            drain();
            return { ok: false, text };
        }
    }
    drain();
    return { ok: false, text };
}
export async function runDebugRun(subprocess, request) {
    const projectDir = resolve(request.projectDir);
    const config = resolveSearchConfig(process.env, request.binDirs === undefined ? {} : { binDirs: request.binDirs });
    const startedAt = Date.now();
    const notes = [];
    const errors = [];
    const empty = {
        ok: false, projectDir, elfPath: "", port: 0, breakAt: request.breakAt ?? "main",
        hitBreakpoint: false, location: "", registers: [], backtrace: [], locals: [],
        gdbCommand: "", gdbOutput: "", openOcdLogTail: "", durationMs: 0, errors, message: "", notes,
    };
    const elfPath = resolveElfPath(projectDir, request);
    if (elfPath === null) {
        errors.push("找不到 .elf（先跑 stm32_build）");
        return { ...empty, message: "没调试：找不到 .elf", durationMs: Date.now() - startedAt };
    }
    const openOcd = request.openOcdPath !== undefined && request.openOcdPath !== ""
        ? request.openOcdPath
        : resolveFromDirs("openocd", config.binDirs);
    const gdb = resolveFromDirs("gdb-multiarch", config.binDirs) ?? resolveFromDirs("arm-none-eabi-gdb", config.binDirs);
    if (openOcd === null || gdb === null) {
        errors.push(openOcd === null ? "找不到 openocd" : "找不到 gdb（gdb-multiarch 或 arm-none-eabi-gdb）");
        return { ...empty, elfPath, message: "没调试：缺工具链（先跑 stm32_env_probe）", durationMs: Date.now() - startedAt };
    }
    const port = request.port ?? (await pickPort(3333));
    if (request.port === undefined && port !== 3333)
        notes.push("3333 被占用，本次改用 " + String(port));
    const openOcdArgs = [openOcd];
    const projectConfig = findProjectConfig(projectDir, request.configFile);
    if (projectConfig !== null) {
        openOcdArgs.push("-f", toOpenOcdPath(projectConfig));
    }
    else {
        const fallback = defaultConfigs();
        openOcdArgs.push("-f", request.interfaceConfig ?? fallback.interfaceConfig, "-f", request.targetConfig ?? fallback.targetConfig);
        notes.push("工程里没有 openocd 配置文件，回退到 CMSIS-DAP + stm32f1x");
    }
    if (request.adapterSpeed !== undefined)
        openOcdArgs.push("-c", "adapter speed " + String(request.adapterSpeed));
    openOcdArgs.push("-c", "gdb_port " + String(port));
    const openOcdHandle = subprocess.spawn({
        argv: openOcdArgs,
        cwd: projectDir,
        stdio: { stdin: "ignore", stdout: { maxBytes: 512 * 1024 }, stderr: { maxBytes: 512 * 1024 } },
        graceMs: 2000,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    let openOcdText = "";
    try {
        const listening = await waitForListening(openOcdHandle, 15_000, (text) => {
            openOcdText += text + "\n";
            request.onProgress?.(text);
        });
        if (!listening.ok) {
            const tail = listening.text.split(/\r?\n/u).slice(-15).join("\n");
            errors.push(/Error connecting DP|no device found|CMSIS-DAP/iu.test(listening.text)
                ? "openocd 连不上探针/芯片（见日志）"
                : "openocd 没有在 15 s 内开始监听 " + String(port));
            return {
                ...empty, elfPath, port, openOcdLogTail: tail,
                message: "没调试：openocd 起不来", durationMs: Date.now() - startedAt,
            };
        }
        const breakAt = request.breakAt ?? "main";
        const gdbArgs = [gdb, "-q", "-batch", "-nx"];
        const ex = (command) => {
            gdbArgs.push("-ex", command);
        };
        ex("set confirm off");
        ex("set pagination off");
        ex("set print pretty off");
        ex("file " + toOpenOcdPath(elfPath));
        ex("target extended-remote 127.0.0.1:" + String(port));
        ex("monitor reset halt");
        if (breakAt !== "none" && breakAt !== "")
            ex("break " + breakAt);
        for (const command of request.preCommands ?? [])
            ex(command);
        if (breakAt !== "none" && breakAt !== "")
            ex("continue");
        ex("info registers pc sp lr xpsr");
        ex("bt");
        ex("info locals");
        for (const command of request.postCommands ?? ["monitor reset run", "detach"])
            ex(command);
        const gdbCommand = gdbArgs.map(quoteForDisplay).join(" ");
        request.onProgress?.("gdb：" + breakAt + (breakAt === "none" ? "" : " 断点"));
        const gdbOutcome = await runStreaming(subprocess, {
            argv: gdbArgs,
            cwd: projectDir,
            timeoutMs: request.timeoutMs ?? 45_000,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
            onOutput: (stream, text) => {
                for (const line of text.split(/\r?\n/u))
                    if (line.trim() !== "")
                        request.onProgress?.(line.trim());
            },
        });
        const gdbText = gdbOutcome.stdout + "\n" + gdbOutcome.stderr;
        const probe = parseGdbOutput(gdbText);
        errors.push(...probe.errors);
        if (gdbOutcome.spawnError !== null)
            errors.push("gdb 启动失败：" + gdbOutcome.spawnError);
        if (gdbOutcome.timedOut)
            errors.push("gdb 超时（" + String(request.timeoutMs ?? 45_000) + " ms）：断点没命中或目标没在跑");
        if (gdbOutcome.exitCode !== 0)
            errors.push("gdb 退出码 " + String(gdbOutcome.exitCode));
        const ok = gdbOutcome.spawnError === null && !gdbOutcome.timedOut && (breakAt === "none" || probe.hitBreakpoint);
        if (ok)
            notes.push("已在 " + (probe.location === "" ? breakAt : probe.location) + " 停住并抓过快照；收尾是 monitor reset run + detach，芯片现在自由运行，探针已释放");
        if (!ok && probe.hitBreakpoint)
            notes.push("命中了断点，但收尾阶段有问题");
        if (breakAt !== "none" && !probe.hitBreakpoint && errors.length === 0) {
            errors.push("没有停在 " + breakAt + "：可能是复位后没跑到这里，或符号对不上（.elf 与板上的固件不一致）");
        }
        return {
            ok,
            projectDir,
            elfPath,
            port,
            breakAt,
            hitBreakpoint: probe.hitBreakpoint,
            location: probe.location,
            registers: probe.registers,
            backtrace: probe.backtrace,
            locals: probe.locals,
            gdbCommand,
            gdbOutput: gdbText,
            openOcdLogTail: openOcdText.split(/\r?\n/u).slice(-15).join("\n"),
            durationMs: Date.now() - startedAt,
            errors,
            message: ok
                ? "调试快照完成（" + ((Date.now() - startedAt) / 1000).toFixed(1) + " s）" + (probe.location === "" ? "" : "：" + probe.location)
                : "调试失败：" + (errors[0] ?? "未知原因"),
            notes,
        };
    }
    finally {
        // 无论成败都要把 openocd 收掉：探针必须释放，否则用户 F5 连不上。
        openOcdHandle.terminate();
        await openOcdHandle.waitForExit().catch(() => undefined);
    }
}
export function resolveElfPath(projectDir, request) {
    if (request.elfPath !== undefined && request.elfPath !== "") {
        const abs = isAbsolute(request.elfPath) ? request.elfPath : resolve(projectDir, request.elfPath);
        return existsSync(abs) ? abs : null;
    }
    const buildDir = request.buildDir !== undefined && request.buildDir !== ""
        ? (isAbsolute(request.buildDir) ? request.buildDir : resolve(projectDir, request.buildDir))
        : detectBuildDir(projectDir);
    if (buildDir === null)
        return null;
    const elf = findElf(buildDir);
    if (elf === null)
        return null;
    statSync(elf.path);
    return elf.path;
}
