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
import { resolveSearchConfig } from "../data/search-roots.js";
import { detectBuildDir, findElf } from "./build.js";
import { findIocFile } from "./generate.js";
import { summarizeIoc } from "./ioc.js";
import { buildTargets, probeAll } from "./probe.js";
import { runCapture } from "./subprocess-runner.js";
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
    const [processes, portBusy] = await Promise.all([listProcesses(subprocess, request.signal), checkPortBusy(port)]);
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
    for (const label of missingRequired)
        blockers.push("缺少必需组件：" + label);
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
        blockers,
        notes,
    };
}
