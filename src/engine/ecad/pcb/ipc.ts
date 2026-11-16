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

import type { SubprocessService } from "../../../types.js";
import { runCapture } from "../../subprocess-runner.js";
import { PCB_IPC_SCRIPT } from "./ipc-script.js";
import { openBoardInKicad, waitForIpc } from "./ipc-open.js";
import type { Launcher } from "./ipc-open.js";

export type PcbIpcAction = "status" | "inspect" | "move" | "route" | "via" | "refill" | "save";

export type PcbIpcKind = "FAILED_PRECONDITION" | "NOT_FOUND" | "INVALID_ARGUMENT" | "INTERNAL";

export interface PcbIpcRequest {
  readonly action: PcbIpcAction;
  readonly ref?: string;
  readonly x?: number;
  readonly y?: number;
  readonly net?: string;
  readonly layer?: string;
  readonly width?: number;
  readonly points?: string;
  readonly size?: number;
  readonly drill?: number;
  /** 缺省 false：只报计划，不动板子。 */
  readonly apply?: boolean;
  /** 期望的活动文档名（例如 `PCB1.kicad_pcb`）：对不上就拒绝，避免改错板子。 */
  readonly expectBoard?: string;
  readonly timeoutMs?: number;
}

export interface PcbIpcResult {
  /** 脚本是否成功（含 apply:false 的计划）。 */
  readonly ok: boolean;
  /** 机器可读的失败类别；成功时为空串。 */
  readonly kind: PcbIpcKind | "";
  readonly error: string;
  /** 脚本回的数据：status/inspect 的板况，或 move/route 的计划。 */
  readonly data: Record<string, unknown>;
  /** 生成出来的脚本路径，进检查报告用。 */
  readonly script: string;
}

export interface ConnectPcbIpcOptions extends PcbIpcOptions {
  /** 连不上时要不要替用户把 KiCad 打开（默认 true）。 */
  readonly autoOpen?: boolean;
  /** 连不上时要打开的板子；没给就不打开，只报原因。 */
  readonly boardFile?: string;
  readonly kicadRoot?: string;
  /** 覆盖 pcbnew.exe 全路径（测试与自定义安装用）。 */
  readonly exe?: string;
  readonly launcher?: Launcher;
  readonly waitMs?: number;
  readonly pollMs?: number;
}

export interface ConnectPcbIpcResult {
  readonly status: PcbIpcResult;
  /** 这次有没有替用户启动 KiCad。 */
  readonly opened: boolean;
  readonly notes: string[];
}

/**
 * 确保 IPC 可用：先探一次，连不上就打开板子再等（S154）。
 *
 * 为什么自动打开：没开编辑器时局部编辑一律失败，而用户此刻的意图就是「在这块板上改」；
 * 让人手动去找地址、开 KiCad、切文档，是把工具的准备工作推回给人。
 */
export async function connectPcbIpc(options: ConnectPcbIpcOptions): Promise<ConnectPcbIpcResult> {
  const notes: string[] = [];
  const first = await runPcbIpc(options, { action: "status", timeoutMs: options.timeoutMs ?? 30_000 });
  const boardNameOf = (result: PcbIpcResult): string => {
    const data = result.data as { board?: { name?: string } } | undefined;
    return data?.board?.name ?? "";
  };
  if (first.ok && boardNameOf(first) !== "") return { status: first, opened: false, notes };
  if (options.autoOpen === false) return { status: first, opened: false, notes };
  if (options.boardFile === undefined || options.boardFile === "") {
    notes.push("要找 KiCad 打开板子，但没有可用的板子文件：先构建一次，或显式给 boardFile");
    return { status: first, opened: false, notes };
  }
  const opened = openBoardInKicad(options.boardFile, { exe: options.exe, kicadRoot: options.kicadRoot, launcher: options.launcher });
  if (!opened.ok) {
    notes.push(opened.error);
    return { status: first, opened: false, notes };
  }
  notes.push("已用 pcbnew 打开 " + opened.boardFile + "，等 IPC 就绪…");
  const waited = await waitForIpc({
    probe: async () => boardNameOf(await runPcbIpc(options, { action: "status", timeoutMs: 30_000 })),
    timeoutMs: options.waitMs,
    pollMs: options.pollMs,
  });
  if (!waited.ok) {
    notes.push("等了 " + String(Math.round(waited.waitedMs / 1000)) + " s 仍连不上：" + waited.error);
    notes.push("在 KiCad 里打开 偏好设置 → 插件，勾选「启用 IPC API 服务器」，改完重启 KiCad 再试");
    return { status: first, opened: true, notes };
  }
  const second = await runPcbIpc(options, { action: "status", timeoutMs: 30_000 });
  notes.push("IPC 已就绪（" + waited.boardName + "，" + String(Math.round(waited.waitedMs / 1000)) + " s）");
  return { status: second, opened: true, notes };
}

export interface PcbIpcOptions {
  readonly subprocess: SubprocessService;
  /** KiCad 自带的 python（`EcadToolchain.python`）。 */
  readonly python: string;
  /** 缺省 30 s：KiCad 在加载大板时会慢，但不应无限等。 */
  readonly timeoutMs?: number;
  readonly env?: Record<string, string | undefined>;
}

/** 脚本落盘目录：每个进程第一次调用时写一次，内容变了才重写。 */
export function ipcScriptPath(): string {
  return join(tmpdir(), "dsh-stm32-ipc", "pcb_ipc.py");
}

export function ensureIpcScript(): { path: string; error: string } {
  const path = ipcScriptPath();
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    if (existsSync(path) && readFileSync(path, "utf8") === PCB_IPC_SCRIPT) return { path, error: "" };
    writeFileSync(path, PCB_IPC_SCRIPT, "utf8");
    return { path, error: "" };
  } catch (error) {
    return { path, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 脚本只允许往 stdout 打一行 JSON；KiCad/kipy 的告警会混进来，取最后一个能解析的。 */
export function parseIpcOutput(stdout: string): { ok: boolean; kind: PcbIpcKind | ""; error: string; data: Record<string, unknown> } {
  const lines = stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== "");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (!line.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as { ok?: unknown; data?: unknown; error?: unknown };
    if (record.ok === true) {
      const data = typeof record.data === "object" && record.data !== null ? (record.data as Record<string, unknown>) : {};
      return { ok: true, kind: "", error: "", data };
    }
    const failure = typeof record.error === "object" && record.error !== null ? (record.error as { kind?: unknown; message?: unknown }) : {};
    const kind = typeof failure.kind === "string" ? (failure.kind as PcbIpcKind) : "INTERNAL";
    const message = typeof failure.message === "string" ? failure.message : "脚本没有说明失败原因";
    return { ok: false, kind, error: message, data: {} };
  }
  return { ok: false, kind: "INTERNAL", error: "脚本没有输出可解析的结果：", data: {} };
}

export async function runPcbIpc(options: PcbIpcOptions, request: PcbIpcRequest): Promise<PcbIpcResult> {
  const script = ensureIpcScript();
  if (script.error !== "") {
    return { ok: false, kind: "INTERNAL", error: "写不出 IPC 脚本：" + script.error, data: {}, script: script.path };
  }
  const payloadPath = join(tmpdir(), "dsh-stm32-ipc", "payload-" + process.pid + "-" + Date.now() + ".json");
  try {
    writeFileSync(payloadPath, JSON.stringify({ ...request, timeoutMs: request.timeoutMs ?? options.timeoutMs ?? 30000 }), "utf8");
  } catch (error) {
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
