/**
 * KiCad IPC 的 TS 侧（S153）：拼参数、跑脚本、解析信封。
 *
 * 分工：KiCad 是唯一事实源，脚本拥有协议（见 `ipc-script.ts`），这里只负责
 * 「找到 KiCad 自带的 Python → 把 payload 落成 json → 跑脚本 → 解析一行 JSON」。
 * 所有失败都收敛成 `{ ok:false, kind, error }`，不抛——调用方按 kind 决定怎么讲。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCapture } from "../../subprocess-runner.js";
import { PCB_IPC_SCRIPT } from "./ipc-script.js";
/** 脚本落盘目录：每个进程第一次调用时写一次，内容变了才重写。 */
export function ipcScriptPath() {
    return join(tmpdir(), "dsh-stm32-ipc", "pcb_ipc.py");
}
export function ensureIpcScript() {
    const path = ipcScriptPath();
    try {
        mkdirSync(join(path, ".."), { recursive: true });
        if (existsSync(path) && readFileSync(path, "utf8") === PCB_IPC_SCRIPT)
            return { path, error: "" };
        writeFileSync(path, PCB_IPC_SCRIPT, "utf8");
        return { path, error: "" };
    }
    catch (error) {
        return { path, error: error instanceof Error ? error.message : String(error) };
    }
}
/** 脚本只允许往 stdout 打一行 JSON；KiCad/kipy 的告警会混进来，取最后一个能解析的。 */
export function parseIpcOutput(stdout) {
    const lines = stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== "");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index] ?? "";
        if (!line.startsWith("{"))
            continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (typeof parsed !== "object" || parsed === null)
            continue;
        const record = parsed;
        if (record.ok === true) {
            const data = typeof record.data === "object" && record.data !== null ? record.data : {};
            return { ok: true, kind: "", error: "", data };
        }
        const failure = typeof record.error === "object" && record.error !== null ? record.error : {};
        const kind = typeof failure.kind === "string" ? failure.kind : "INTERNAL";
        const message = typeof failure.message === "string" ? failure.message : "脚本没有说明失败原因";
        return { ok: false, kind, error: message, data: {} };
    }
    return { ok: false, kind: "INTERNAL", error: "脚本没有输出可解析的结果：", data: {} };
}
export async function runPcbIpc(options, request) {
    const script = ensureIpcScript();
    if (script.error !== "") {
        return { ok: false, kind: "INTERNAL", error: "写不出 IPC 脚本：" + script.error, data: {}, script: script.path };
    }
    const payloadPath = join(tmpdir(), "dsh-stm32-ipc", "payload-" + process.pid + "-" + Date.now() + ".json");
    try {
        writeFileSync(payloadPath, JSON.stringify({ ...request, timeoutMs: request.timeoutMs ?? options.timeoutMs ?? 30000 }), "utf8");
    }
    catch (error) {
        return { ok: false, kind: "INTERNAL", error: "写不出 payload：" + String(error), data: {}, script: script.path };
    }
    const outcome = await runCapture(options.subprocess, {
        argv: [options.python, script.path, payloadPath],
        timeoutMs: (options.timeoutMs ?? 60000) + 5000,
        env: options.env,
    });
    if (outcome.spawnError !== null) {
        return { ok: false, kind: "FAILED_PRECONDITION", error: "跑不起 KiCad 自带的 Python：" + outcome.spawnError, data: {}, script: script.path };
    }
    if (outcome.timedOut) {
        return { ok: false, kind: "FAILED_PRECONDITION", error: "KiCad IPC 超时：编辑器可能正忙或没开 PCB 编辑器", data: {}, script: script.path };
    }
    const parsed = parseIpcOutput(outcome.stdout);
    if (!parsed.ok) {
        const detail = parsed.error === "" ? outcome.stderr.trim() : parsed.error;
        return { ok: false, kind: parsed.kind, error: detail, data: {}, script: script.path };
    }
    return { ok: true, kind: "", error: "", data: parsed.data, script: script.path };
}
