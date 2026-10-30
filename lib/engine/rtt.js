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
import { isPortBusy } from "./debug.js";
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
export const RTT_LEVEL_NAMES = { 1: "error", 2: "warn", 3: "info", 4: "debug" };
const HINT_ADDR = "addr 要写成 32 位十六进制（例如 0x20000000），填控制块的起始地址，不是通道缓冲区的地址。";
const HINT_NO_SESSION = "先起一个调试会话：stm32_debug_session action=start；也可以直接 stm32_rtt action=start，工具会自动起一个。";
const HINT_NO_TCL = "会话没有 Tcl RPC 端口（openocd 启动日志里没有 tcl 那一行）：确认 openocd 版本支持 tcl（0.11 以上默认开），再重启会话。";
const HINT_NO_BLOCK = "目标内存里没有 RTT 控制块：在模板里加最小实现——控制块头 10 字节放 SEGGER RTT 魔数，把它链接到固定 RAM 地址（例如 .noinit 段，地址和 addr 一致），通道 0 按 [4B 长度|1B 级别|8B 时间戳|UTF-8] 写记录；然后核对 addr/size。";
const HINT_MAGIC = "控制块魔数不符：核对 addr 是不是控制块起始地址（不是通道缓冲区地址），并确认模板里的控制块真的被链接进 RAM（查 .map 文件）。";
const HINT_PORT_BUSY = "RTT 端口被占用：换一个 rttPort，或关掉占着它的进程（另一个 RTT 客户端 / 上次没停的 rtt server）。";
const HINT_CONNECT = "连不上 RTT 通道：确认 start 成功（openocd 的 rtt server 已在监听该端口），端口没被防火墙挡住；换个 rttPort 或加大 timeoutMs 再试。";
const HINT_NOT_RUNNING = "RTT 还没启动：先 stm32_rtt action=start，addr 填模板里控制块的地址。";
const HINT_SETUP = "openocd 拒绝了 RTT 命令：看 evidence 里 openocd 的原话；常见原因是控制块地址/长度不对，或者目标没在跑（rtt start 需要目标在跑）。";
const HINT_TCL_TIMEOUT = "openocd 的 Tcl 口超时：确认调试会话还在（stm32_debug_session action=status），必要时重启会话再试。";
const HINT_FRAME = "通道字节流不符合我们的帧约定（[4B 长度|1B 级别|8B 时间戳|UTF-8]）：核对模板里写通道 0 的函数，或先 stop 再 start 重来。";
const HINT_CANCEL = "已取消：重新调用同一个工具即可，RTT 状态不会被这次取消弄坏。";
function initialState() {
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
let state = initialState();
/** 组一个结构化错误：形状与 probe-error 的 ProbeError 一致，hint 是 RTT 专用的。 */
function rttError(kind, cause, hint, evidence = []) {
    return { kind, cause, hint, evidence, retryable: kind === "timeout" };
}
function clampNumber(value, min, max) {
    if (!Number.isFinite(value))
        return min;
    return Math.min(max, Math.max(min, value));
}
function addWords(address, delta) {
    const base = Number.parseInt(address.replace(/^0x/iu, ""), 16);
    return "0x" + (base + delta).toString(16).padStart(8, "0");
}
/** 从 mdw 的回复里取 32 位值；地址对不上（回复错位）也返回 null。 */
function wordFromReply(reply, address) {
    const parsed = parseMdwReply(reply);
    if (parsed === null)
        return null;
    if (parsed.address !== "") {
        const expected = normalizeWordAddress(address);
        if (expected !== null && parsed.address !== expected)
            return null;
    }
    const value = Number.parseInt(parsed.value.replace(/^0x/iu, ""), 16);
    return Number.isFinite(value) ? value : null;
}
/** 找出 openocd 回复里第一条像错误的；没有就返回 null。 */
function firstErrorReply(replies) {
    for (const reply of replies) {
        const text = String(reply ?? "").trim();
        if (text === "")
            continue;
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
export function parseRttFrames(buffer, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {
    const records = [];
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
        if (buffer.length - offset - 4 < length)
            break;
        const level = buffer.readUInt8(offset + 4);
        if (level < RTT_MIN_LEVEL || level > RTT_MAX_LEVEL) {
            return {
                records,
                rest: Buffer.from(buffer.subarray(offset)),
                error: "级别字段 " + String(level) + " 越界（约定 1..4：1=error 2=warn 3=info 4=debug）",
            };
        }
        const t = Number(buffer.readBigUInt64LE(offset + 5));
        const text = buffer.toString("utf8", offset + RTT_FRAME_HEADER_BYTES, offset + 4 + length);
        records.push({ t, level, text });
        offset += 4 + length;
    }
    return { records, rest: Buffer.from(buffer.subarray(offset)), error: null };
}
/**
 * 按同一套约定编一帧。引擎自己不用它（记录是固件写的），但它是帧格式的可执行参考：
 * 模板端的 C 实现和单测都对着它写。
 */
export function encodeRttFrame(record) {
    const payload = Buffer.from(record.text, "utf8");
    const frame = Buffer.alloc(RTT_FRAME_HEADER_BYTES + payload.length);
    frame.writeUInt32LE(RTT_MIN_FRAME_BYTES + payload.length, 0);
    frame.writeUInt8(record.level, 4);
    frame.writeBigUInt64LE(BigInt(Math.max(0, Math.floor(record.t))), 5);
    payload.copy(frame, RTT_FRAME_HEADER_BYTES);
    return frame;
}
/** 读控制块的头三个字，用来判断目标里到底有没有 RTT 控制块。 */
async function readControlBlock(addr, tclPort, timeoutMs, signal) {
    const addresses = [addr, addWords(addr, 4), addWords(addr, 8)];
    const commands = addresses.map((address) => "mdw " + address);
    const round = await tclRoundTrip(tclPort, commands, timeoutMs, signal);
    if (!round.ok)
        return { ok: false, words: null, error: round.error ?? "读控制块失败", output: round.output };
    touch();
    const values = [];
    for (let index = 0; index < addresses.length; index += 1) {
        const value = wordFromReply(round.replies[index] ?? "", addresses[index] ?? "");
        if (value === null)
            return { ok: false, words: null, error: "控制块读取的回复解析不了：" + JSON.stringify(round.replies[index] ?? ""), output: round.output };
        values.push(value >>> 0);
    }
    return { ok: true, words: { word0: values[0] ?? 0, word1: values[1] ?? 0, word2: values[2] ?? 0 }, error: null, output: round.output };
}
function describeWords(words) {
    const hex = (value) => "0x" + (value >>> 0).toString(16).padStart(8, "0");
    return "控制块三个字：" + hex(words.word0) + " " + hex(words.word1) + " " + hex(words.word2);
}
/**
 * 启动 RTT：先用 mdw 确认目标里真有控制块，再依次发 rtt setup / rtt start /
 * rtt server start，最后记下通道端口供 dumpRtt 连。
 */
export async function startRtt(request) {
    const startedAt = Date.now();
    const addr = normalizeWordAddress(typeof request.addr === "string" ? request.addr : "") ?? "";
    const size = Math.round(clampNumber(request.size ?? DEFAULT_RTT_SIZE, 16, 0x4000));
    const banner = typeof request.banner === "string" ? request.banner.trim() : "";
    const port = Math.round(clampNumber(request.port ?? DEFAULT_RTT_PORT, 1, 65_535));
    const tclTimeout = Math.round(clampNumber(request.timeoutMs ?? 5_000, 500, 60_000));
    const checkBusy = request.checkPortBusy ?? isPortBusy;
    const base = {
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
        const timeout = /超时|timeout/iu.test(block.error ?? "");
        const probeError = rttError(timeout ? "timeout" : "unknown", "读控制块失败：" + (block.error ?? "未知原因"), timeout ? HINT_TCL_TIMEOUT : HINT_NO_BLOCK, [block.error ?? ""]);
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
        const probeError = rttError("unknown", zero ? "控制块是空的（三个字全是 0），目标里没有 RTT 控制块" : "控制块魔数不符，目标里那块内存不是 RTT 控制块", zero ? HINT_NO_BLOCK : HINT_MAGIC, [describeWords(words), "期望 magic " + RTT_MAGIC_TEXT + " = 0x47474553 0x52205245 0x????5454"]);
        return { ...base, tclPort, output: block.output, words, durationMs: Date.now() - startedAt, probeError, message: formatProbeError(probeError) };
    }
    const setup = "rtt setup " + addr + " " + String(size) + (banner === "" ? "" : " " + banner);
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
/** 连上 RTT 通道端口，采 seconds 秒（或直到 maxRecords / 通道关闭 / 出错）。 */
async function collectFromPort(port, options) {
    return await new Promise((resolve) => {
        const startedAt = Date.now();
        const records = [];
        const notes = [];
        let dropped = 0;
        let bytes = 0;
        let carry = Buffer.alloc(0);
        let truncated = false;
        let stopped = false;
        let settled = false;
        let connected = false;
        let error = null;
        let failureKind = "unknown";
        let failureHint = HINT_FRAME;
        const socket = createConnection({ host: "127.0.0.1", port });
        state.socket = socket;
        socket.setNoDelay(true);
        const finish = (reason, detail) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(connectTimer);
            if (windowTimer !== null)
                clearTimeout(windowTimer);
            options.signal?.removeEventListener("abort", onAbort);
            if (state.socket === socket)
                state.socket = null;
            socket.removeAllListeners();
            socket.on("error", () => undefined);
            socket.destroy();
            if (reason === "closed")
                stopped = true;
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
            if (reason === "window" && carry.length > 0) {
                notes.push("窗口结束时尾部还有 " + String(carry.length) + " 字节的半个帧，没算进 records");
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
        const onAbort = () => {
            finish("aborted", null);
        };
        const connectTimer = setTimeout(() => {
            finish("connect-failed", "连不上 RTT 通道端口 " + String(port) + "（" + String(options.connectTimeoutMs) + " ms 内没建立连接）");
        }, options.connectTimeoutMs);
        let windowTimer = null;
        socket.on("connect", () => {
            connected = true;
            clearTimeout(connectTimer);
            windowTimer = setTimeout(() => {
                finish("window", null);
            }, Math.round(options.seconds * 1000));
        });
        socket.on("data", (chunk) => {
            if (settled)
                return;
            bytes += chunk.length;
            state.bytes += chunk.length;
            carry = Buffer.concat([carry, chunk]);
            const parsed = parseRttFrames(carry, options.maxFrameBytes);
            carry = parsed.rest;
            if (parsed.error !== null) {
                state.lastError = parsed.error;
                finish("error", parsed.error);
                return;
            }
            for (const record of parsed.records) {
                if (record.level > options.level) {
                    dropped += 1;
                    state.dropped += 1;
                    continue;
                }
                if (records.length >= options.maxRecords) {
                    finish("truncated", null);
                    return;
                }
                records.push(record);
                state.records += 1;
            }
        });
        socket.on("close", () => {
            finish("closed", null);
        });
        socket.on("error", (err) => {
            if (settled)
                return;
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
        if (options.signal?.aborted === true)
            onAbort();
    });
}
/** dump：从通道 0 读一段时间的记录；level 是保留上限（默认 4 = 全要）。 */
export async function dumpRtt(request = {}) {
    const rawSeconds = request.seconds ?? DEFAULT_DUMP_SECONDS;
    const seconds = clampNumber(rawSeconds, 0.2, 60);
    const level = Math.round(clampNumber(request.level ?? RTT_MAX_LEVEL, RTT_MIN_LEVEL, RTT_MAX_LEVEL));
    const maxRecords = Math.round(clampNumber(request.maxRecords ?? DEFAULT_MAX_RECORDS, 1, 5_000));
    const maxFrameBytes = Math.round(clampNumber(request.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES, RTT_MIN_FRAME_BYTES, 65_536));
    const connectTimeoutMs = Math.round(clampNumber(request.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS, 100, 60_000));
    const port = state.port;
    const addr = state.addr;
    const base = {
        ok: false,
        records: [],
        dropped: 0,
        bytes: 0,
        truncated: false,
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
    const outcome = await collectFromPort(port, { seconds, level, maxRecords, maxFrameBytes, connectTimeoutMs, ...(request.signal === undefined ? {} : { signal: request.signal }) });
    const notes = [...outcome.notes];
    if (seconds !== rawSeconds)
        notes.push("seconds=" + String(rawSeconds) + " 超出 0.2..60，按 " + String(seconds) + " s 收；要更长的窗口就分多次 dump");
    if (outcome.error !== null)
        state.lastError = outcome.error;
    let message;
    if (outcome.ok) {
        message = "dump 到 " + String(outcome.records.length) + " 条 RTT 记录（端口 " + String(port) + "，窗口 " + String(seconds) + " s，收 " + String(outcome.bytes) + " 字节）";
        if (outcome.dropped > 0)
            message += "，按级别过滤掉 " + String(outcome.dropped) + " 条";
        if (outcome.truncated)
            message += "，达到 maxRecords 提前收尾";
        if (outcome.stopped)
            message += "，通道在窗口内被关掉（目标复位或 rtt stop）";
    }
    else {
        const probeError = outcome.probeError ?? rttError("unknown", outcome.error ?? "未知原因", HINT_FRAME);
        message = formatProbeError(probeError);
    }
    return {
        ok: outcome.ok,
        records: outcome.records,
        dropped: outcome.dropped,
        bytes: outcome.bytes,
        truncated: outcome.truncated,
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
function resetState() {
    state = initialState();
}
/** 停 RTT：先断掉正在读的通道，再让 openocd 收掉 rtt server 和 rtt 轮询。 */
export async function stopRtt() {
    const startedAt = Date.now();
    const wasRunning = state.running;
    const port = state.port;
    const records = state.records;
    const bytes = state.bytes;
    const dropped = state.dropped;
    const base = { ok: false, stopped: false, port, records, bytes, dropped, durationMs: 0, error: null, probeError: null, message: "", notes: [] };
    if (state.socket !== null) {
        const socket = state.socket;
        state.socket = null;
        socket.destroy();
    }
    const session = sessionInfo();
    let tclError = null;
    if (session === null) {
        tclError = "没有活跃的调试会话（本地 RTT 状态已经清掉，openocd 那边可能还开着 rtt server）";
    }
    else if (session.tclPort <= 0) {
        tclError = "会话没有 Tcl 端口，没法让 openocd 收掉 rtt server（本地状态已清）";
    }
    else {
        const commands = ["rtt server stop " + String(port), "rtt stop"];
        const round = await tclRoundTrip(session.tclPort, commands, 3_000);
        if (!round.ok)
            tclError = round.error ?? "rtt stop 没发出去";
        else {
            const bad = firstErrorReply(round.replies);
            if (bad !== null)
                tclError = bad;
        }
    }
    resetState();
    const notes = [];
    if (!wasRunning)
        notes.push("本来就没在跑，这次只做了清理");
    if (tclError !== null)
        notes.push(tclError);
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
export function rttStatus() {
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
