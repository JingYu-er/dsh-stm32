/**
 * B3：探针会话复用快路径（把 regs_read 从"每次 spawn 一个 openocd"降到毫秒级）。
 *
 * 背景：`stm32_regs_read` 原来是"起 openocd → mdw → shutdown"，实测 1493 ms；而
 * `stm32_debug_eval` 每次也要新起一个 `gdb -batch`。两者都太慢，但慢的不是"读"，
 * 是进程启动。这里把"常驻 openocd"这件事抽成一个小门面，让两条路都走它：
 *
 * - `ensureSession()`：没有会话就起一个（复用 `debug-session.ts` 的租约/Turn 收尾/端口让位），
 *   有同项目的会话就直接复用（`reused=true`）；
 * - `readWordsViaSession()`：走 openocd 的 **Tcl RPC 口**（`halt` → `reg pc` → `mdw ...` →
 *   `resume`，一条 TCP 连接、几毫秒），这是 1493 ms → <150 ms 的关键；解析不到 Tcl 端口时
 *   调用方回退到 gdb 路径；
 * - `release()` / `touch()`：显式释放与续租（`turn/end`、90 s 空闲、`stm32_debug_stop` 都走 manager）。
 *
 * 唯一真相仍然是 `debugSessions`（单例）：这里不自己存句柄、不自己算租约，只做"要不要起、
 * 起完怎么用"的编排，避免出现两个都说自己握着探针的状态。
 */

import { createConnection } from "node:net";

import { debugSessions } from "./debug-session.js";
import type { SessionReport } from "./debug-session.js";
import { isPortBusy } from "./debug.js";
import { classifyProbeFailure, formatProbeError, makeProbeError } from "./probe-error.js";
import type { ProbeError } from "./probe-error.js";
import type { SubprocessService } from "../types.js";

/** 默认 gdb 端口（与 debug_run / debug_session 一致）。 */
export const DEFAULT_PROBE_PORT = 3333;

/** 空闲多久自动关（沿用 L2 会话的 90 s 租约）。 */
export const DEFAULT_SESSION_IDLE_TTL_MS = 90_000;

/**
 * Tcl RPC 协议：每条命令以 0x1a 结尾，每个响应也以 0x1a 结尾（不含回显）。
 * 这里不用 `\n`——openocd 的 Tcl 口按 0x1a 分帧，用换行会卡住等不到响应。
 */
const TCL_FRAME = String.fromCharCode(0x1a);
/**
 * 响应帧收齐后立刻收尾：帧是按 0x1a 完整切出来的，计数够了就说明每条命令都回了，
 * 不需要再等一个"庄家时间"（那会让每次读白等几十毫秒）。
 */
const TCL_DONE_MS = 0;
/** 响应不齐（比如某条命令被 openocd 拒了但没回帧）时的兜底等待。 */
const TCL_IDLE_MS = 120;

export interface ProbeSessionInfo {
  port: number;
  /** openocd 的 Tcl RPC 端口（0＝没解析到，快路径不可用）。 */
  tclPort: number;
  projectDir: string;
  /** 起会话时用的 openocd 配置（空串＝默认 interface/target）。 */
  configFile: string;
  startedAt: number;
  /** 租约到期时刻（会话空闲到期或总时长上限，取更早的那个）。 */
  idleDeadline: number;
}

export interface EnsureSessionOptions {
  /** 空闲租约（默认 90 s）。 */
  idleTtlMs?: number;
  /** 起会话的调用方标识（工具层传 exec.agent?.id）。 */
  owner?: string;
  binDirs?: string[];
  elfPath?: string;
  port?: number;
  /** 新起会话时生效；复用已有会话时不生效（工具层会提醒）。 */
  configFile?: string;
  adapterSpeed?: number;
  subprocess?: SubprocessService;
  /** 端口被占时是否直接报 probe-busy（默认 true：不抢用户的 VS Code 调试会话）。 */
  portBusyIsError?: boolean;
  /** 可注入的端口探测（单测用；默认走 debug.ts 的 isPortBusy）。 */
  checkPortBusy?: (port: number) => Promise<boolean>;
}

export interface EnsureSessionResult {
  ok: boolean;
  /** true＝复用了已有会话（快路径的前提）。 */
  reused: boolean;
  session: ProbeSessionInfo | null;
  probeError: ProbeError | null;
  message: string;
}

export interface WithSessionResult<T> {
  ok: boolean;
  reused: boolean;
  session: ProbeSessionInfo | null;
  value: T | null;
  probeError: ProbeError | null;
  message: string;
}

export interface SessionWordSample {
  address: string;
  value: string;
  ok: boolean;
}

export interface SessionTclWordsReport {
  ok: boolean;
  pc: string;
  samples: SessionWordSample[];
  durationMs: number;
  /** 实际发过去的命令序列（进报告，方便复现）。 */
  command: string;
  output: string;
  error: string | null;
}

/** 并发去重：同时来两个 ensureSession 时只起一个 openocd（后到的直接复用同一个 Promise）。 */
let starting: Promise<EnsureSessionResult> | null = null;

function normalizeDir(dir: string): string {
  return dir.trim().replace(/[\\/]+$/u, "").replace(/\\/gu, "/").toLowerCase();
}

function sameProject(left: string, right: string): boolean {
  return normalizeDir(left) === normalizeDir(right);
}

/** 当前会话信息（没有就是 null）。idleDeadline 由 manager 的 remainingMs 反推，不另算一套。 */
export function sessionInfo(): ProbeSessionInfo | null {
  const status: SessionReport = debugSessions.status();
  if (!status.active) return null;
  return {
    port: status.port,
    tclPort: status.tclPort,
    configFile: status.configFile,
    projectDir: status.projectDir,
    startedAt: status.startedAt,
    idleDeadline: Date.now() + status.remainingMs,
  };
}

/** 续租（每读一次都算"用过"）。 */
export function touch(): boolean {
  return debugSessions.touch();
}

/** 显式释放（stm32_debug_stop、进程退出等）。 */
export async function release(reason = "显式释放"): Promise<{ ok: boolean; stopped: boolean; message: string }> {
  return await debugSessions.stop(reason);
}

/**
 * 保证有一个可用的调试会话：
 * - 已有同项目会话 → 直接复用（续租）；
 * - 没有 → 起一个（端口被占先报 probe-busy，不让 openocd 顺延到别的口偷偷抢探针）；
 * - 并发调用 → 只起一个进程。
 */
export async function ensureSession(projectDir: string, options: EnsureSessionOptions = {}): Promise<EnsureSessionResult> {
  const current = sessionInfo();
  if (current !== null && sameProject(current.projectDir, projectDir)) {
    touch();
    return {
      ok: true,
      reused: true,
      session: sessionInfo(),
      probeError: null,
      message: "复用已有调试会话（gdb 端口 " + String(current.port) + "，tcl 端口 " + String(current.tclPort) + "）",
    };
  }
  if (starting !== null) return await starting;

  const idleTtlMs = options.idleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS;
  const promise = startSession(projectDir.trim() === "" ? projectDir : projectDir, idleTtlMs, options).finally(() => {
    starting = null;
  });
  starting = promise;
  return await promise;
}

async function startSession(projectDir: string, idleTtlMs: number, options: EnsureSessionOptions): Promise<EnsureSessionResult> {
  if (options.subprocess !== undefined) debugSessions.configure(options.subprocess, options.binDirs ?? []);

  const port = options.port ?? DEFAULT_PROBE_PORT;
  const checkBusy = options.checkPortBusy ?? isPortBusy;
  if (options.portBusyIsError !== false && (await checkBusy(port))) {
    const probeError = makeProbeError("probe-busy", {
      cause: "gdb 端口 " + String(port) + " 已被占用（多半是 VS Code 的调试会话或另一个 openocd 还握着探针）",
      evidence: ["probe port " + String(port) + " busy"],
    });
    return { ok: false, reused: false, session: null, probeError, message: formatProbeError(probeError) };
  }

  const started = await debugSessions.start({
    projectDir,
    port,
    idleTtlMs,
    ...(options.elfPath === undefined ? {} : { elfPath: options.elfPath }),
    ...(options.configFile === undefined || options.configFile === "" ? {} : { configFile: options.configFile }),
    ...(options.adapterSpeed === undefined ? {} : { adapterSpeed: options.adapterSpeed }),
    ...(options.binDirs === undefined ? {} : { binDirs: options.binDirs }),
    ...(options.owner === undefined ? {} : { owner: options.owner }),
  });
  if (!started.ok) {
    // 起会话失败的日志已经在 report.errors 里：归类只走 probe-error 那一张表。
    const probeError = classifyProbeFailure({ lines: started.errors, stage: "session" });
    return { ok: false, reused: false, session: null, probeError, message: formatProbeError(probeError) };
  }
  return {
    ok: true,
    reused: false,
    session: sessionInfo(),
    probeError: null,
    message: "起了调试会话（gdb 端口 " + String(started.port) + "，tcl 端口 " + String(started.tclPort) + "，空闲 " + String(Math.round(idleTtlMs / 1000)) + " s 后自动关）",
  };
}

/**
 * 在会话里跑一段操作：拿不到会话就把 probeError 原样带出来（调用方只负责格式化）。
 * 失败也 touch()——会话本身是好的，只是一次读取失败，不该被提前回收。
 */
export async function withSession<T>(
  fn: (session: ProbeSessionInfo) => Promise<T>,
  projectDir: string,
  options: EnsureSessionOptions = {},
): Promise<WithSessionResult<T>> {
  const ensured = await ensureSession(projectDir, options);
  if (!ensured.ok || ensured.session === null) {
    return { ok: false, reused: ensured.reused, session: null, value: null, probeError: ensured.probeError, message: ensured.message };
  }
  try {
    const value = await fn(ensured.session);
    touch();
    return { ok: true, reused: ensured.reused, session: ensured.session, value, probeError: null, message: ensured.message };
  } catch (error) {
    touch();
    const detail = error instanceof Error ? error.message : String(error);
    const probeError = makeProbeError("unknown", { cause: "会话内操作失败：" + detail, evidence: [detail] });
    return { ok: false, reused: ensured.reused, session: ensured.session, value: null, probeError, message: formatProbeError(probeError) };
  }
}

/** 把 "0x4001100c" / "4001100C" 统一成 8 位小写 0x 形式；解析不了返回 null。 */
export function normalizeWordAddress(text: string): string | null {
  const body = text.trim().replace(/^0x/iu, "");
  if (!/^[0-9a-f]{1,8}$/iu.test(body)) return null;
  return "0x" + body.toLowerCase().padStart(8, "0");
}

/**
 * 解析 `mdw <addr>` 的响应：openocd 回 `0x4001100c: 00000020`（值可能不带 0x）。
 * 少数构建只回一个裸值，那就把地址留空、由调用方按序号对齐。
 */
export function parseMdwReply(reply: string): { address: string; value: string } | null {
  const framed = /(?:0x)?([0-9a-f]{1,16})\s*:\s*(?:0x)?([0-9a-f]{1,8})/iu.exec(reply);
  if (framed !== null) {
    const address = normalizeWordAddress(framed[1] ?? "");
    const value = "0x" + (framed[2] ?? "").toLowerCase().padStart(8, "0");
    if (address === null) return null;
    return { address, value };
  }
  const bare = /^\s*(?:0x)?([0-9a-f]{1,8})\s*$/iu.exec(reply);
  if (bare === null) return null;
  return { address: "", value: "0x" + (bare[1] ?? "").toLowerCase().padStart(8, "0") };
}

/** 解析 `reg pc` 的响应：Tcl 的 reg 返回 `pc (/32): 0x0800012c`，也兼容裸 0x 值。 */
export function parsePcReply(reply: string): string {
  const named = /pc\s*(?:\(\s*\/\s*32\s*\))?\s*:?\s*(0x[0-9a-f]{1,8})/iu.exec(reply);
  if (named !== null) return (named[1] ?? "").toLowerCase();
  const any = /(0x[0-9a-f]{1,8})/iu.exec(reply);
  if (any !== null) return (any[1] ?? "").toLowerCase();
  const bare = /^\s*([0-9a-f]{1,8})\s*$/iu.exec(reply);
  return bare === null ? "" : "0x" + (bare[1] ?? "").toLowerCase().padStart(8, "0");
}

/**
 * 一次 Tcl RPC 往返：连上 openocd 的 Tcl 口，按 0x1a 分帧发命令，收齐响应就断开。
 * 返回 ok=false 时调用方应回退到 gdb 路径（不该把整个 regs_read 判死）。
 */
export async function tclRoundTrip(
  port: number,
  commands: string[],
  timeoutMs = 5_000,
  signal?: AbortSignal,
): Promise<{ ok: boolean; replies: string[]; output: string; error: string | null; durationMs: number }> {
  const startedAt = Date.now();
  const empty = { ok: false, replies: [] as string[], output: "", durationMs: 0 };
  if (!Number.isInteger(port) || port <= 0) return { ...empty, error: "没有可用的 Tcl 端口（openocd 日志里没有 tcl 那一行）" };
  if (signal?.aborted === true) return { ...empty, error: "已取消" };

  return await new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const replies: string[] = [];
    let buffer = "";
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (error: string | null): void => {
      if (settled) return;
      settled = true;
      if (idleTimer !== null) clearTimeout(idleTimer);
      if (hardTimer !== null) clearTimeout(hardTimer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve({ ok: error === null && replies.length > 0, replies, output: replies.join("\n"), error, durationMs: Date.now() - startedAt });
    };
    const onAbort = (): void => {
      finish("已取消");
    };
    const onData = (chunk: string): void => {
      buffer += chunk;
      let frame = buffer.indexOf(TCL_FRAME);
      while (frame >= 0) {
        replies.push(buffer.slice(0, frame));
        buffer = buffer.slice(frame + TCL_FRAME.length);
        frame = buffer.indexOf(TCL_FRAME);
      }
      if (idleTimer !== null) clearTimeout(idleTimer);
      // 收齐了就立刻收尾；没齐就按空闲兜底（万一某条命令没回帧，也不至于卡死）。
      idleTimer = setTimeout(() => { finish(null); }, replies.length >= commands.length ? TCL_DONE_MS : TCL_IDLE_MS);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    hardTimer = setTimeout(() => { finish("Tcl 往返超时（" + String(timeoutMs) + " ms）"); }, Math.max(500, timeoutMs));
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      for (const command of commands) socket.write(command + TCL_FRAME);
    });
    socket.on("data", onData);
    socket.on("error", (error: Error) => {
      finish("连不上 openocd 的 Tcl 口：" + error.message);
    });
  });
}

/**
 * 走会话的 Tcl 口读 pc + 一组字：`halt` → `reg pc` → `mdw x N` → `resume`。
 * 这是 B3 的主路径（本机实测单次 < 150 ms）；失败时调用方回退到 gdb（debug_sessions.read_words）。
 */
export async function readWordsViaSession(request: { addresses: string[]; timeoutMs?: number; signal?: AbortSignal }): Promise<SessionTclWordsReport> {
  const startedAt = Date.now();
  const info = sessionInfo();
  const base = { ok: false, pc: "", samples: [] as SessionWordSample[], command: "", output: "" };
  if (info === null) return { ...base, durationMs: 0, error: "没有可复用的调试会话（先 ensureSession）" };
  if (info.tclPort <= 0) return { ...base, durationMs: 0, error: "会话没有 Tcl 端口（openocd 日志里没有 tcl 那一行），改用 gdb 读" };

  const wanted: string[] = [];
  for (const address of request.addresses) {
    const normalized = normalizeWordAddress(address);
    if (normalized !== null) wanted.push(normalized);
  }
  const commands = ["halt", "reg pc", ...wanted.map((address) => "mdw " + address), "resume"];
  const round = await tclRoundTrip(info.tclPort, commands, request.timeoutMs ?? 5_000, request.signal);
  if (!round.ok) {
    return { ...base, command: commands.join("; "), output: round.output, durationMs: Date.now() - startedAt, error: round.error };
  }
  touch();

  const pcReply = round.replies[1] ?? "";
  const pc = parsePcReply(pcReply);
  const byAddress = new Map<string, string>();
  const byIndex: string[] = [];
  for (let index = 0; index < wanted.length; index += 1) {
    const reply = round.replies[2 + index] ?? "";
    const parsed = parseMdwReply(reply);
    if (parsed === null) {
      byIndex.push("");
      continue;
    }
    byIndex.push(parsed.value);
    if (parsed.address !== "") byAddress.set(parsed.address, parsed.value);
  }
  const samples: SessionWordSample[] = wanted.map((address, index) => {
    const value = byAddress.get(address) ?? byIndex[index] ?? "";
    return { address, value, ok: value !== "" };
  });
  const failed = samples.filter((sample) => !sample.ok).length;
  return {
    ok: failed === 0,
    pc,
    samples,
    command: commands.join("; "),
    output: round.output,
    durationMs: Date.now() - startedAt,
    error: failed === 0 ? null : "有 " + String(failed) + " 个地址没读到值",
  };
}

/**
 * 进程退出前的尽力清理：exit 里不能 await，只让 manager 发终止信号。
 * 不这么做的话，插件宿主重启后可能留下一个握死探针的 openocd（VS Code 那边就 F5 不动了）。
 */
process.once("exit", () => {
  try {
    debugSessions.terminateSync();
  } catch {
    // exit 阶段不能抛。
  }
});
