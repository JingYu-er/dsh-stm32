/**
 * RTT（Real Time Transfer）引擎：固件把日志写进 RAM 里的环，openocd 用 rtt 命令把环
 * 暴露成一个 TCP 端口，这里连上去把字节流解成一条条记录。
 *
 * 分工：
 *   - 控制块按 SEGGER 的约定（首 10 字节是 "SEGGER RTT"），这样 openocd 原生的
 *     rtt setup / rtt start 能直接认；
 *   - 通道 0 的记录格式是我们自己的（不抄 SEGGER：它没有级别和时间戳）：
 *       [4B 长度 LE][1B 级别][8B 时间戳 ms LE][payload UTF-8]
 *     长度字段 = 9 + payload 字节数，不含这 4 字节本身；
 *   - 级别 1..4 = error / warn / info / debug，dump 的 level 是"保留到哪一级"的上限。
 *
 * 所有失败都走 ProbeError 的形状（kind 只用 unknown / timeout），hint 专门讲 RTT 这边
 * 该怎么办：端口被占、连不上通道、目标里没有控制块、帧对不上……
 */

import { createConnection } from "node:net";
import type { Socket } from "node:net";

import { isPortBusy } from "./debug.js";
import type { ProbeError, ProbeErrorKind } from "./probe-error.js";
import { formatProbeError } from "./probe-error.js";
import { normalizeWordAddress, parseMdwReply, sessionInfo, tclRoundTrip, touch } from "./probe-session.js";

/** RTT 通道的 TCP 端口缺省值（openocd 的 rtt server 监听这个端口）。 */
export const DEFAULT_RTT_PORT = 9090;
/** 控制块预留的字节数缺省值；真正用的是模板里那块内存的大小。 */
export const DEFAULT_RTT_SIZE = 0x400;
/** 一次 dump 的采集窗口（秒）。 */
export const DEFAULT_DUMP_SECONDS = 3;
/** 一次 dump 最多返回多少条记录。 */
export const DEFAULT_MAX_RECORDS = 200;
/** 单条记录的 payload 上限，超了就认为通道里不是我们的帧。 */
export const DEFAULT_MAX_FRAME_BYTES = 4096;
/** 连 RTT 通道端口的超时。 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
/** 4B 长度 + 1B 级别 + 8B 时间戳。 */
export const RTT_FRAME_HEADER_BYTES = 13;
/** 长度字段允许的最小值：1B 级别 + 8B 时间戳（空 payload）。 */
export const RTT_MIN_FRAME_BYTES = 9;

/** 控制块的魔数文本（与 SEGGER 兼容，openocd 靠它找控制块）。 */
export const RTT_MAGIC_TEXT = "SEGGER RTT";
/** 魔数第 0 个字：小端读出来是 "SEGG"。 */
export const RTT_MAGIC_WORD_0 = 0x47474553;
/** 魔数第 1 个字：小端读出来是 "ER R"。 */
export const RTT_MAGIC_WORD_1 = 0x52205245;
/** 魔数第 2 个字的低 16 位是 "TT"（0x5454），高 16 位由模板自己决定（后面就是通道描述符）。 */
export const RTT_MAGIC_WORD_2_LOW = 0x5454;

export const RTT_MIN_LEVEL = 1;
export const RTT_MAX_LEVEL = 4;
/** 级别名；模板端写记录时用同一张表。 */
export const RTT_LEVEL_NAMES: Readonly<Record<number, string>> = { 1: "error", 2: "warn", 3: "info", 4: "debug" };

const HINT_ADDR = "addr 要写成 32 位十六进制（例如 0x20000000），填控制块的起始地址，不是通道缓冲区的地址。";
const HINT_NO_SESSION = "先起一个调试会话：stm32_debug_session action=start；也可以直接 stm32_rtt action=start，工具会自动起一个。";
const HINT_NO_TCL = "会话没有 Tcl RPC 端口（openocd 启动日志里没有 tcl 那一行）：确认 openocd 版本支持 tcl（0.11 以上默认开），再重启会话。";
const HINT_NO_BLOCK =
  "目标内存里没有 RTT 控制块：在模板里加最小实现——控制块头 10 字节放 SEGGER RTT 魔数，把它链接到固定 RAM 地址（例如 .noinit 段，地址和 addr 一致），通道 0 按 [4B 长度|1B 级别|8B 时间戳|UTF-8] 写记录；然后核对 addr/size。";
const HINT_MAGIC =
  "控制块魔数不符：核对 addr 是不是控制块起始地址（不是通道缓冲区地址），并确认模板里的控制块真的被链接进 RAM（查 .map 文件）。";
const HINT_PORT_BUSY = "RTT 端口被占用：换一个 rttPort，或关掉占着它的进程（另一个 RTT 客户端 / 上次没停的 rtt server）。";
const HINT_CONNECT = "连不上 RTT 通道：确认 start 成功（openocd 的 rtt server 已在监听该端口），端口没被防火墙挡住；换个 rttPort 或加大 timeoutMs 再试。";
const HINT_NOT_RUNNING = "RTT 还没启动：先 stm32_rtt action=start，addr 填模板里控制块的地址。";
const HINT_SETUP = "openocd 拒绝了 RTT 命令：看 evidence 里 openocd 的原话；常见原因是控制块地址/长度不对，或者目标没在跑（rtt start 需要目标在跑）。";
const HINT_TCL_TIMEOUT = "openocd 的 Tcl 口超时：确认调试会话还在（stm32_debug_session action=status），必要时重启会话再试。";
/** 连接被拒/被重置 = openocd 已经没了（探针掉线也会这样），别把它报成「目标里没有控制块」。 */
const HINT_SESSION_GONE = "调试会话的 openocd 已经不在了（连接被拒/被重置）：先 stm32_debug_stop 关掉残留会话，再重试；反复出现就插拔探针（USB）后重来。";

/** 从 Tcl 连接错误里认出「会话已经死了」：这类错误换多少 addr 都没用。 */
export function sessionGoneHint(error: string): string | null {
  return /ECONNREFUSED|ECONNRESET|ECONNABORTED|EPIPE|socket hang up/iu.test(error) ? HINT_SESSION_GONE : null;
}
const HINT_FRAME = "通道字节流不符合我们的帧约定（[4B 长度|1B 级别|8B 时间戳|UTF-8]）：核对模板里写通道 0 的函数，或先 stop 再 start 重来。";
const HINT_CANCEL = "已取消：重新调用同一个工具即可，RTT 状态不会被这次取消弄坏。";

/** 一条 RTT 记录：t 是模板写进来的毫秒时间戳（相对任意起点，通常就用 HAL_GetTick）。 */
export interface RttRecord {
  t: number;
  level: number;
  text: string;
}

/** 控制块里读出来的三个字。 */
export interface RttControlBlockWords {
  word0: number;
  word1: number;
  word2: number;
}

export interface RttStartRequest {
  addr: string;
  size?: number;
  banner?: string;
  port?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  checkPortBusy?: (port: number) => Promise<boolean>;
}

export interface RttStartResult {
  ok: boolean;
  started: boolean;
  addr: string;
  size: number;
  banner: string;
  port: number;
  tclPort: number;
  command: string[];
  output: string;
  words: RttControlBlockWords | null;
  durationMs: number;
  probeError: ProbeError | null;
  message: string;
  notes: string[];
}

export interface RttDumpRequest {
  seconds?: number;
  level?: number;
  maxRecords?: number;
  timeoutMs?: number;
  maxFrameBytes?: number;
  signal?: AbortSignal;
  /** true = 持续读（follow）：超过 maxRecords 只保留最新的 N 条，不提前收尾。 */
  keepNewest?: boolean;
  /** true = 收完再读一次固件里的 s_dropped（会短暂 halt 目标，代价约一次 gdb 往返）。 */
  readFirmwareDrop?: boolean;
}

export interface RttDumpResult {
  ok: boolean;
  records: RttRecord[];
  dropped: number;
  bytes: number;
  truncated: boolean;
  /** 固件侧累计丢帧（s_dropped，自复位起）；读不到时 -1。 */
  firmwareDropped: number;
  stopped: boolean;
  port: number;
  addr: string;
  seconds: number;
  level: number;
  maxRecords: number;
  durationMs: number;
  error: string | null;
  probeError: ProbeError | null;
  message: string;
  notes: string[];
}

export interface RttStopResult {
  ok: boolean;
  stopped: boolean;
  port: number;
  records: number;
  bytes: number;
  dropped: number;
  durationMs: number;
  error: string | null;
  probeError: ProbeError | null;
  message: string;
  notes: string[];
}

export interface RttStatusSnapshot {
  running: boolean;
  addr: string;
  size: number;
  banner: string;
  port: number;
  tclPort: number;
  startedAt: number;
  runningMs: number;
  records: number;
  bytes: number;
  dropped: number;
  socketOpen: boolean;
  lastError: string | null;
}

interface RttState extends RttStatusSnapshot {
  socket: Socket | null;
}

function initialState(): RttState {
  return {
    running: false,
    addr: "",
    size: DEFAULT_RTT_SIZE,
    banner: "",
    port: DEFAULT_RTT_PORT,
    tclPort: 0,
    startedAt: 0,
    runningMs: 0,
    records: 0,
    bytes: 0,
    dropped: 0,
    socketOpen: false,
    lastError: null,
    socket: null,
  };
}

let state: RttState = initialState();

/** 组一个结构化错误：形状与 probe-error 的 ProbeError 一致，hint 是 RTT 专用的。 */
function rttError(kind: ProbeErrorKind, cause: string, hint: string, evidence: string[] = []): ProbeError {
  return { kind, cause, hint, evidence, retryable: kind === "timeout" };
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function addWords(address: string, delta: number): string {
  const base = Number.parseInt(address.replace(/^0x/iu, ""), 16);
  return "0x" + (base + delta).toString(16).padStart(8, "0");
}

/** 从 mdw 的回复里取 32 位值；地址对不上（回复错位）也返回 null。 */
function wordFromReply(reply: string, address: string): number | null {
  const parsed = parseMdwReply(reply);
  if (parsed === null) return null;
  if (parsed.address !== "") {
    const expected = normalizeWordAddress(address);
    if (expected !== null && parsed.address !== expected) return null;
  }
  const value = Number.parseInt(parsed.value.replace(/^0x/iu, ""), 16);
  return Number.isFinite(value) ? value : null;
}

/** 找出 openocd 回复里第一条像错误的；没有就返回 null。 */
function firstErrorReply(replies: string[]): string | null {
  for (const reply of replies) {
    const text = String(reply ?? "").trim();
    if (text === "") continue;
    if (/^(error|invalid|unknown|no\s)/iu.test(text) || /unknown command|not found|no such|can't|cannot|failed/iu.test(text)) {
      return text;
    }
  }
  return null;
}

/**
 * 解析 RTT 通道字节流。返回解出来的记录、剩下的半个帧字节，以及失步错误。
 * 纯函数：单测直接喂 Buffer 就能验帧格式，不用起 openocd。
 */
export function parseRttFrames(buffer: Buffer, maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES): { records: RttRecord[]; rest: Buffer; error: string | null } {
  const records: RttRecord[] = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32LE(offset);
    if (length < RTT_MIN_FRAME_BYTES) {
      return {
        records,
        rest: Buffer.from(buffer.subarray(offset)),
        error: "帧长度字段 " + String(length) + " 不合法（最小 " + String(RTT_MIN_FRAME_BYTES) + " = 1B 级别 + 8B 时间戳）",
      };
    }
    if (length > maxFrameBytes) {
      return {
        records,
        rest: Buffer.from(buffer.subarray(offset)),
        error: "帧长度 " + String(length) + " 超过上限 " + String(maxFrameBytes) + "，通道里很可能不是我们的帧",
      };
    }
    if (buffer.length - offset - 4 < length) break;
    const level = buffer.readUInt8(offset + 4);
    if (level < RTT_MIN_LEVEL || level > RTT_MAX_LEVEL) {
      return {
        records,
        rest: Buffer.from(buffer.subarray(offset)),
        error: "级别字段 " + String(level) + " 越界（约定 1..4：1=error 2=warn 3=info 4=debug）",
      };
    }
    const t = Number(buffer.readBigUInt64LE(offset + 5));
    const rawText = buffer.toString("utf8", offset + RTT_FRAME_HEADER_BYTES, offset + 4 + length);
    // 环形缓冲回绕/残留时，一帧尾部会被环起点处的旧数据或清零区补齐：末尾的 NUL 不是内容，
    // 裁掉它，否则 dump 出来的文本尾巴挂一串 \0（真机上必现）。
    const text = rawText.replace(/\u0000+$/u, "");
    records.push({ t, level, text });
    offset += 4 + length;
  }
  return { records, rest: Buffer.from(buffer.subarray(offset)), error: null };
}

/**
 * 在缓冲区里找第一个「看起来是帧头」的偏移：长度字段在 [9, maxFrameBytes]、级别在 1..4，
 * 且剩余字节够一整帧（不够也算候选：先对齐过来，等后续字节补齐）。
 *
 * 为什么需要它：openocd 的 rtt server 在客户端连上时会把整块通道缓冲（由短及长，正好是
 * 通道大小时就是 1024 字节）一次性推过来，而固件的写指针早就绕过好几圈 —— 首字节往往落在
 * 某条记录的中间。parseRttFrames 是严格解析器（偏移 0 失步就报错），对齐这一步只能在外面做。
 *
 * 返回 -1 表示整段都找不到帧头（那才是真的「通道里不是我们的帧」）。
 */
export function resyncRttFrames(buffer: Buffer, maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES): number {
  for (let offset = 0; offset + 4 <= buffer.length; offset += 1) {
    const length = buffer.readUInt32LE(offset);
    if (length < RTT_MIN_FRAME_BYTES || length > maxFrameBytes) continue;
    if (offset + 4 + length > buffer.length) return offset;
    const level = buffer.readUInt8(offset + 4);
    if (level < RTT_MIN_LEVEL || level > RTT_MAX_LEVEL) continue;
    return offset;
  }
  return -1;
}


/**
 * 按同一套约定编一帧。引擎自己不用它（记录是固件写的），但它是帧格式的可执行参考：
 * 模板端的 C 实现和单测都对着它写。
 */
export function encodeRttFrame(record: RttRecord): Buffer {
  const payload = Buffer.from(record.text, "utf8");
  const frame = Buffer.alloc(RTT_FRAME_HEADER_BYTES + payload.length);
  frame.writeUInt32LE(RTT_MIN_FRAME_BYTES + payload.length, 0);
  frame.writeUInt8(record.level, 4);
  frame.writeBigUInt64LE(BigInt(Math.max(0, Math.floor(record.t))), 5);
  payload.copy(frame, RTT_FRAME_HEADER_BYTES);
  return frame;
}

/** 读控制块的头三个字，用来判断目标里到底有没有 RTT 控制块。 */
async function readControlBlock(addr: string, tclPort: number, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; words: RttControlBlockWords | null; error: string | null; output: string }> {
  const addresses = [addr, addWords(addr, 4), addWords(addr, 8)];
  const commands = addresses.map((address) => "mdw " + address);
  const round = await tclRoundTrip(tclPort, commands, timeoutMs, signal);
  if (!round.ok) return { ok: false, words: null, error: round.error ?? "读控制块失败", output: round.output };
  touch();
  const values: number[] = [];
  for (let index = 0; index < addresses.length; index += 1) {
    const value = wordFromReply(round.replies[index] ?? "", addresses[index] ?? "");
    if (value === null) return { ok: false, words: null, error: "控制块读取的回复解析不了：" + JSON.stringify(round.replies[index] ?? ""), output: round.output };
    values.push(value >>> 0);
  }
  return { ok: true, words: { word0: values[0] ?? 0, word1: values[1] ?? 0, word2: values[2] ?? 0 }, error: null, output: round.output };
}

function describeWords(words: RttControlBlockWords): string {
  const hex = (value: number): string => "0x" + (value >>> 0).toString(16).padStart(8, "0");
  return "控制块三个字：" + hex(words.word0) + " " + hex(words.word1) + " " + hex(words.word2);
}

/**
 * 启动 RTT：先用 mdw 确认目标里真有控制块，再依次发 rtt setup / rtt start /
 * rtt server start，最后记下通道端口供 dumpRtt 连。
 */
export async function startRtt(request: RttStartRequest): Promise<RttStartResult> {
  const startedAt = Date.now();
  const addr = normalizeWordAddress(typeof request.addr === "string" ? request.addr : "") ?? "";
  const size = Math.round(clampNumber(request.size ?? DEFAULT_RTT_SIZE, 16, 0x4000));
  const banner = typeof request.banner === "string" ? request.banner.trim() : "";
  const port = Math.round(clampNumber(request.port ?? DEFAULT_RTT_PORT, 1, 65_535));
  const tclTimeout = Math.round(clampNumber(request.timeoutMs ?? 5_000, 500, 60_000));
  const checkBusy = request.checkPortBusy ?? isPortBusy;
  const base: RttStartResult = {
    ok: false,
    started: false,
    addr,
    size,
    banner,
    port,
    tclPort: 0,
    command: [],
    output: "",
    words: null,
    durationMs: 0,
    probeError: null,
    message: "",
    notes: [],
  };

  if (addr === "") {
    const probeError = rttError("unknown", "addr 不是合法的 32 位地址：" + JSON.stringify(String(request.addr ?? "")), HINT_ADDR);
    return { ...base, durationMs: Date.now() - startedAt, probeError, message: formatProbeError(probeError) };
  }
  if (request.signal?.aborted === true) {
    const probeError = rttError("unknown", "已取消", HINT_CANCEL);
    return { ...base, durationMs: Date.now() - startedAt, probeError, message: formatProbeError(probeError) };
  }
  const session = sessionInfo();
  if (session === null) {
    const probeError = rttError("unknown", "没有活跃的调试会话（RTT 要走 openocd 的 Tcl RPC）", HINT_NO_SESSION);
    return { ...base, durationMs: Date.now() - startedAt, probeError, message: formatProbeError(probeError) };
  }
  if (session.tclPort <= 0) {
    const probeError = rttError("unknown", "会话没有 Tcl 端口（openocd 日志里没有 tcl 那一行）", HINT_NO_TCL);
    return { ...base, tclPort: session.tclPort, durationMs: Date.now() - startedAt, probeError, message: formatProbeError(probeError) };
  }
  const tclPort = session.tclPort;

  if (await checkBusy(port)) {
    const probeError = rttError("unknown", "RTT 通道端口 " + String(port) + " 已被占用", HINT_PORT_BUSY, ["rtt port " + String(port) + " busy"]);
    return { ...base, tclPort, durationMs: Date.now() - startedAt, probeError, message: formatProbeError(probeError) };
  }

  const block = await readControlBlock(addr, tclPort, tclTimeout, request.signal);
  if (!block.ok) {
    const errorText = block.error ?? "";
    const timeout = /超时|timeout/iu.test(errorText);
    const gone = sessionGoneHint(errorText);
    const probeError = rttError(
      timeout ? "timeout" : "unknown",
      "读控制块失败：" + (errorText === "" ? "未知原因" : errorText),
      gone ?? (timeout ? HINT_TCL_TIMEOUT : HINT_NO_BLOCK),
      [errorText],
    );
    return { ...base, tclPort, output: block.output, durationMs: Date.now() - startedAt, probeError, message: formatProbeError(probeError) };
  }
  const words = block.words;
  if (words === null) {
    const probeError = rttError("unknown", "读不到控制块", HINT_NO_BLOCK);
    return { ...base, tclPort, output: block.output, durationMs: Date.now() - startedAt, probeError, message: formatProbeError(probeError) };
  }
  const zero = words.word0 === 0 && words.word1 === 0 && words.word2 === 0;
  const magicOk = words.word0 === RTT_MAGIC_WORD_0 && words.word1 === RTT_MAGIC_WORD_1 && (words.word2 & 0xffff) === RTT_MAGIC_WORD_2_LOW;
  if (zero || !magicOk) {
    const probeError = rttError(
      "unknown",
      zero ? "控制块是空的（三个字全是 0），目标里没有 RTT 控制块" : "控制块魔数不符，目标里那块内存不是 RTT 控制块",
      zero ? HINT_NO_BLOCK : HINT_MAGIC,
      [describeWords(words), "期望 magic " + RTT_MAGIC_TEXT + " = 0x47474553 0x52205245 0x????5454"],
    );
    return { ...base, tclPort, output: block.output, words, durationMs: Date.now() - startedAt, probeError, message: formatProbeError(probeError) };
  }

  // openocd 0.12 的 rtt setup 要求三个参数：<address> <size> <ID>，ID 是控制块里的标识字符串
  // （SEGGER RTT）。只给两个参数会被当成参数缺失，命令不生效却不一定报错——实测踩过。
  const controlBlockId = banner === "" ? RTT_MAGIC_TEXT : banner;
  const setup = "rtt setup " + addr + " " + String(size) + " \"" + controlBlockId + "\"";
  const commands = [setup, "rtt start", "rtt server start " + String(port) + " 0"];
  const round = await tclRoundTrip(tclPort, commands, tclTimeout, request.signal);
  const output = round.output;
  if (!round.ok) {
    const timeout = /超时|timeout/iu.test(round.error ?? "");
    const probeError = rttError(timeout ? "timeout" : "unknown", "RTT 命令没发出去：" + (round.error ?? "未知原因"), timeout ? HINT_TCL_TIMEOUT : HINT_SETUP, [round.error ?? ""]);
    return { ...base, tclPort, command: commands, output, words, durationMs: Date.now() - startedAt, probeError, message: formatProbeError(probeError) };
  }
  touch();
  const bad = firstErrorReply(round.replies);
  if (bad !== null) {
    const probeError = rttError("unknown", "openocd 拒绝了 RTT 命令：" + bad, HINT_SETUP, [bad, "commands: " + commands.join("; ")]);
    return { ...base, tclPort, command: commands, output, words, durationMs: Date.now() - startedAt, probeError, message: formatProbeError(probeError) };
  }

  state = {
    running: true,
    addr,
    size,
    banner,
    port,
    tclPort,
    startedAt: Date.now(),
    runningMs: 0,
    records: 0,
    bytes: 0,
    dropped: 0,
    socketOpen: false,
    lastError: null,
    socket: null,
  };
  return {
    ok: true,
    started: true,
    addr,
    size,
    banner,
    port,
    tclPort,
    command: commands,
    output,
    words,
    durationMs: Date.now() - startedAt,
    probeError: null,
    message: "RTT 已启动：控制块 " + addr + "（" + String(size) + " 字节），通道端口 " + String(port) + "；dump 用 stm32_rtt action=dump",
    notes: [describeWords(words)],
  };
}

interface CollectOutcome {
  ok: boolean;
  records: RttRecord[];
  dropped: number;
  bytes: number;
  truncated: boolean;
  stopped: boolean;
  error: string | null;
  probeError: ProbeError | null;
  notes: string[];
  durationMs: number;
}

/** 连上 RTT 通道端口，采 seconds 秒（或直到 maxRecords / 通道关闭 / 出错）。 */
async function collectFromPort(port: number, options: { seconds: number; level: number; maxRecords: number; maxFrameBytes: number; connectTimeoutMs: number; keepNewest?: boolean; signal?: AbortSignal }): Promise<CollectOutcome> {
  return await new Promise<CollectOutcome>((resolve) => {
    const startedAt = Date.now();
    const records: RttRecord[] = [];
    const notes: string[] = [];
    let dropped = 0;
    let bytes = 0;
    let carry: Buffer = Buffer.alloc(0);
    let truncated = false;
    let stopped = false;
    let settled = false;
    let connected = false;
    let error: string | null = null;
    let failureKind: ProbeErrorKind = "unknown";
    let failureHint = HINT_FRAME;
    /** 已经收过的记录（时间戳|级别|文本）：openocd 回绕后会重推同一段，别重复计数。 */
    const seen = new Set<string>();
    let duplicates = 0;
    /** 对齐时跳过的字节总数：攒成一条 note，免得每个 chunk 刷一条一样的（实测硬件上刷 27 条）。 */
    let skippedBytes = 0;
    let skippedAtHead = true;
    /** 尾部半条记录的解析错误：等窗口结束再写进 notes，中途不提前收尾。 */
    let tailError: string | null = null;
    /** follow 模式下"只留最新 N 条"的提示只写一次。 */
    let keepNewestNoted = false;
    const socket = createConnection({ host: "127.0.0.1", port });
    state.socket = socket;
    socket.setNoDelay(true);

    const finish = (reason: "window" | "closed" | "truncated" | "error" | "connect-failed" | "aborted", detail: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      if (windowTimer !== null) clearTimeout(windowTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (state.socket === socket) state.socket = null;
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      socket.destroy();
      if (reason === "closed") stopped = true;
      if (reason === "truncated") {
        truncated = true;
        notes.push("达到 maxRecords=" + String(options.maxRecords) + " 提前收尾，后面的记录没读");
      }
      if (reason === "error") {
        error = detail ?? "读 RTT 通道时出错";
        failureKind = "unknown";
        failureHint = HINT_FRAME;
      }
      if (reason === "connect-failed") {
        error = detail ?? "连不上 RTT 通道";
        failureKind = "timeout";
        failureHint = HINT_CONNECT;
      }
      if (reason === "aborted") {
        error = "已取消";
        failureKind = "unknown";
        failureHint = HINT_CANCEL;
      }
      if (skippedBytes > 0) {
        notes.unshift((skippedAtHead ? "开头 " : "中段 ") + String(skippedBytes) + " 字节不是帧头（环形缓冲绕圈/回绕），已跳过并对齐到帧边界");
      }
      if (reason === "window" && carry.length > 0) {
        notes.push("窗口结束时尾部还有 " + String(carry.length) + " 字节的半个帧，没算进 records"
          + (tailError === null ? "" : "（" + tailError + "）"));
      }
      if (duplicates > 0) {
        notes.push("重复记录 " + String(duplicates) + " 条（时间戳+级别+文本都相同）已去重");
      }
      if (reason === "window" && error === null && records.length === 0 && state.lastError !== null) {
        // 整段窗口一条都没解出来：通道里确实不是我们的帧（例如固件写的是别的格式）。
        error = state.lastError;
        failureKind = "unknown";
        failureHint = HINT_FRAME;
      }
      resolve({
        ok: error === null,
        records,
        dropped,
        bytes,
        truncated,
        stopped,
        error,
        probeError: error === null ? null : rttError(failureKind, error, failureHint),
        notes,
        durationMs: Date.now() - startedAt,
      });
    };
    /** 把解析出来的记录收进去：去重、按 level 过滤、maxRecords 到了就收尾。返回 false 表示已经 finish。 */
    const takeRecords = (list: RttRecord[]): boolean => {
      for (const record of list) {
        const key = String(record.t) + "|" + String(record.level) + "|" + record.text;
        if (seen.has(key)) {
          duplicates += 1;
          continue;
        }
        seen.add(key);
        if (record.level > options.level) {
          dropped += 1;
          state.dropped += 1;
          continue;
        }
        if (records.length >= options.maxRecords) {
          if (options.keepNewest !== true) {
            finish("truncated", null);
            return false;
          }
          // follow：窗口长、记录多，只留最新的 N 条（用户要的是"现在在打什么"，不是全史）。
          records.shift();
          if (!keepNewestNoted) {
            keepNewestNoted = true;
            notes.push("记录超过 maxRecords=" + String(options.maxRecords) + "，只保留最新的 " + String(options.maxRecords) + " 条");
          }
          truncated = true;
        }
        records.push(record);
        state.records += 1;
      }
      return true;
    };

    const onAbort = (): void => {
      finish("aborted", null);
    };

    const connectTimer = setTimeout(() => {
      finish("connect-failed", "连不上 RTT 通道端口 " + String(port) + "（" + String(options.connectTimeoutMs) + " ms 内没建立连接）");
    }, options.connectTimeoutMs);
    let windowTimer: ReturnType<typeof setTimeout> | null = null;

    socket.on("connect", () => {
      connected = true;
      clearTimeout(connectTimer);
      windowTimer = setTimeout(() => {
        finish("window", null);
      }, Math.round(options.seconds * 1000));
    });
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      state.bytes += chunk.length;
      carry = Buffer.concat([carry, chunk]);
      // 对齐/解析最多来回这么多次：整块环形缓冲里可能夹着多段垃圾，但绝不无限转。
      for (let guard = 0; guard < 64; guard += 1) {
        if (settled) return;
        const parsed = parseRttFrames(carry, options.maxFrameBytes);
        // 先把已经解出来的记录收下：解析只是在后面的垃圾处失步，前面读到的不能一起扔掉
        // （实测 C8T6：整块 1024 字节缓冲推过来时，开头对不齐 + 后面一长串 0，旧写法会 0 条记录）。
        if (!takeRecords(parsed.records)) return;
        if (parsed.error === null) {
          carry = parsed.rest;
          return;
        }
        // 连上通道时 openocd 常把整块环形缓冲从中间推过来（固件写指针早已绕过一圈），
        // 或者回绕后中段夹着半条记录：先往后找帧头对齐，别整次 dump 判失败。
        // 注意要在 parsed.rest 上找：在整段 carry 上找会永远在偏移 0 命中刚解出的那帧的首字节，
        // 于是每次都在原地打转（实测真机上卡死在这里，后面的记录一条都解不出来）。
        const rest = parsed.rest;
        const offset = resyncRttFrames(rest, options.maxFrameBytes);
        if (offset > 0) {
          if (skippedBytes === 0) skippedAtHead = records.length === 0;
          skippedBytes += offset;
          carry = rest.subarray(offset);
          continue;
        }
        if (offset === 0) {
          // rest 本身就以帧头开头：这帧还没收齐，等下一个 chunk 补齐。
          carry = rest;
          return;
        }
        // 整段都找不到帧头：既可能是回绕后的半条记录，也可能只是这半条还没写完（下一个 chunk 就补齐）。
        // 旧写法在「已解出过记录」时直接 finish("window")，实测 C8T6 上会把后面还能解出来的整秒记录全丢掉。
        tailError = parsed.error;
        if (records.length === 0) state.lastError = parsed.error;
        // 垃圾攒太多就只留尾巴：一帧最长 maxFrameBytes，帧头最坏也就落在这么多字节之前。
        const keepBytes = options.maxFrameBytes + RTT_FRAME_HEADER_BYTES;
        if (rest.length > keepBytes) carry = rest.subarray(rest.length - keepBytes);
        else carry = rest;
        return;
      }
      // 对齐来回 64 次还没收敛：剩下的按垃圾丢掉，别把 socket 拖死。
      state.lastError = "对齐帧头来回 " + String(64) + " 次仍未收敛，剩下的 " + String(carry.length) + " 字节按垃圾丢弃";
      carry = Buffer.alloc(0);
    });
    socket.on("close", () => {
      finish("closed", null);
    });
    socket.on("error", (err: Error) => {
      if (settled) return;
      if (!connected) {
        finish("connect-failed", "连不上 RTT 通道端口 " + String(port) + "：" + err.message);
        return;
      }
      if (bytes === 0) {
        finish("error", "读 RTT 通道时出错：" + err.message);
        return;
      }
      finish("closed", null);
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted === true) onAbort();
  });
}

/**
 * 读固件侧的丢帧计数（rtt.c 里的 static uint32_t s_dropped，自复位起累计）。
 * 为什么值得多花一次 gdb 往返：宿主侧的 dropped 是「按级别过滤掉几条」，固件侧的 s_dropped 才是
 * 「环满丢了几条」—— 这才是「RTT 会不会丢数据」真正该看的数字。
 * 走 eval（halt -> print -> resume），目标会被停约 50–100 ms；读不到就返回 -1，不编数。
 */
export async function readFirmwareDropCount(): Promise<{ value: number; note: string }> {
  const session = sessionInfo();
  if (session === null) return { value: -1, note: "没有活跃会话，读不到固件侧 s_dropped（-1）" };
  try {
    const { debugSessions } = await import("./debug-session.js");
    const report = await debugSessions.eval({ commands: ["p (unsigned)s_dropped"] });
    const matched = /\$\d+\s*=\s*(\d+)/u.exec(report.output);
    if (matched === null) {
      const last = report.output.trim().split("\n").slice(-1)[0];
      return { value: -1, note: "固件里没找到 s_dropped（符号被优化掉或改名）：" + last };
    }
    return { value: Number(matched[1]), note: "固件侧 s_dropped=" + matched[1] + "（自复位起累计）" };
  } catch (error) {
    return { value: -1, note: "读 s_dropped 失败：" + (error instanceof Error ? error.message : String(error)) };
  }
}

/** dump：从通道 0 读一段时间的记录；level 是保留上限（默认 4 = 全要）。 */
export async function dumpRtt(request: RttDumpRequest = {}): Promise<RttDumpResult> {
  const rawSeconds = request.seconds ?? DEFAULT_DUMP_SECONDS;
  const keepNewest = request.keepNewest === true;
  const maxWindow = keepNewest ? 300 : 60;
  const seconds = clampNumber(rawSeconds, 0.2, maxWindow);
  const level = Math.round(clampNumber(request.level ?? RTT_MAX_LEVEL, RTT_MIN_LEVEL, RTT_MAX_LEVEL));
  const maxRecords = Math.round(clampNumber(request.maxRecords ?? DEFAULT_MAX_RECORDS, 1, 5_000));
  const maxFrameBytes = Math.round(clampNumber(request.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES, RTT_MIN_FRAME_BYTES, 65_536));
  const connectTimeoutMs = Math.round(clampNumber(request.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS, 100, 60_000));
  const port = state.port;
  const addr = state.addr;
  const base: RttDumpResult = {
    ok: false,
    records: [],
    dropped: 0,
    bytes: 0,
    truncated: false,
    firmwareDropped: -1,
    stopped: false,
    port,
    addr,
    seconds,
    level,
    maxRecords,
    durationMs: 0,
    error: null,
    probeError: null,
    message: "",
    notes: [],
  };

  if (!state.running) {
    const probeError = rttError("unknown", "RTT 没在跑（当前没有活动的 RTT 通道）", HINT_NOT_RUNNING);
    return { ...base, probeError, error: probeError.cause, message: formatProbeError(probeError) };
  }
  if (request.signal?.aborted === true) {
    const probeError = rttError("unknown", "已取消", HINT_CANCEL);
    return { ...base, probeError, error: probeError.cause, message: formatProbeError(probeError) };
  }

  const outcome = await collectFromPort(port, { seconds, level, maxRecords, maxFrameBytes, connectTimeoutMs, keepNewest, ...(request.signal === undefined ? {} : { signal: request.signal }) });
  const notes = [...outcome.notes];
  if (seconds !== rawSeconds) notes.push("seconds=" + String(rawSeconds) + " 超出 0.2.." + String(maxWindow) + "，按 " + String(seconds) + " s 收");
  if (outcome.error !== null) state.lastError = outcome.error;
  let firmwareDropped = -1;
  if (request.readFirmwareDrop === true && outcome.ok) {
    const reading = await readFirmwareDropCount();
    firmwareDropped = reading.value;
    notes.push(reading.note);
  }

  let message: string;
  if (outcome.ok) {
    message = "dump 到 " + String(outcome.records.length) + " 条 RTT 记录（端口 " + String(port) + "，窗口 " + String(seconds) + " s，收 " + String(outcome.bytes) + " 字节）";
    if (outcome.dropped > 0) message += "，按级别过滤掉 " + String(outcome.dropped) + " 条";
    if (outcome.truncated) message += keepNewest ? "，超过 maxRecords 只保留最新 " + String(maxRecords) + " 条" : "，达到 maxRecords 提前收尾";
    if (firmwareDropped >= 0) message += "；固件侧累计丢帧 " + String(firmwareDropped) + " 条";
    if (outcome.stopped) message += "，通道在窗口内被关掉（目标复位或 rtt stop）";
  } else {
    const probeError = outcome.probeError ?? rttError("unknown", outcome.error ?? "未知原因", HINT_FRAME);
    message = formatProbeError(probeError);
  }
  return {
    ok: outcome.ok,
    records: outcome.records,
    dropped: outcome.dropped,
    bytes: outcome.bytes,
    truncated: outcome.truncated,
    firmwareDropped,
    stopped: outcome.stopped,
    port,
    addr,
    seconds,
    level,
    maxRecords,
    durationMs: outcome.durationMs,
    error: outcome.error,
    probeError: outcome.probeError,
    message,
    notes,
  };
}

function resetState(): void {
  state = initialState();
}

/** 停 RTT：先断掉正在读的通道，再让 openocd 收掉 rtt server 和 rtt 轮询。 */
export async function stopRtt(): Promise<RttStopResult> {
  const startedAt = Date.now();
  const wasRunning = state.running;
  const port = state.port;
  const records = state.records;
  const bytes = state.bytes;
  const dropped = state.dropped;
  const base: RttStopResult = { ok: false, stopped: false, port, records, bytes, dropped, durationMs: 0, error: null, probeError: null, message: "", notes: [] };

  if (state.socket !== null) {
    const socket = state.socket;
    state.socket = null;
    socket.destroy();
  }

  const session = sessionInfo();
  let tclError: string | null = null;
  if (session === null) {
    tclError = "没有活跃的调试会话（本地 RTT 状态已经清掉，openocd 那边可能还开着 rtt server）";
  } else if (session.tclPort <= 0) {
    tclError = "会话没有 Tcl 端口，没法让 openocd 收掉 rtt server（本地状态已清）";
  } else {
    const commands = ["rtt server stop " + String(port), "rtt stop"];
    const round = await tclRoundTrip(session.tclPort, commands, 3_000);
    if (!round.ok) tclError = round.error ?? "rtt stop 没发出去";
    else {
      const bad = firstErrorReply(round.replies);
      if (bad !== null) tclError = bad;
    }
  }
  resetState();
  const notes: string[] = [];
  if (!wasRunning) notes.push("本来就没在跑，这次只做了清理");
  if (tclError !== null) notes.push(tclError);
  const ok = wasRunning && tclError === null;
  const message = ok
    ? "RTT 已停（通道端口 " + String(port) + "，这一轮收 " + String(records) + " 条 / " + String(bytes) + " 字节）"
    : "RTT 已从本地停掉（通道端口 " + String(port) + "，这一轮收 " + String(records) + " 条 / " + String(bytes) + " 字节）" + (tclError === null ? "" : "；openocd 那边没收干净：" + tclError);
  return {
    ok,
    stopped: wasRunning,
    port,
    records,
    bytes,
    dropped,
    durationMs: Date.now() - startedAt,
    error: tclError,
    probeError: tclError === null ? null : rttError("unknown", tclError, HINT_NOT_RUNNING),
    message,
    notes,
  };
}

/** 当前 RTT 状态快照（status 动作与报告都从这里取）。 */
export function rttStatus(): RttStatusSnapshot {
  return {
    running: state.running,
    addr: state.addr,
    size: state.size,
    banner: state.banner,
    port: state.port,
    tclPort: state.tclPort,
    startedAt: state.startedAt,
    runningMs: state.running && state.startedAt > 0 ? Date.now() - state.startedAt : 0,
    records: state.records,
    bytes: state.bytes,
    dropped: state.dropped,
    socketOpen: state.socket !== null,
    lastError: state.lastError,
  };
}
