/**
 * 常驻通道：把串口与 RTT 的输出持续灌进事件流，而不是只在工具调用时取一段。
 *
 * 为什么放在服务端而不是面板轮询工具：面板一刷新就该有历史，且「一轮联调里
 * 串口一直在冒字」不该依赖某个前台工具被调用。这里只做两件事：定时取增量、
 * 通过 `emitChannel` 归成事件；解析与过滤全复用 serial / rtt 已有的实现。
 *
 * 串口 tap 自己维护文件偏移，不碰 `readSerial` 的读路径：rx.ndjson 是只追加的，
 * 两边各读各的，互不抢游标。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { emitChannel } from "./channels.js";
import { currentSerialSession } from "./serial.js";
import { dumpRtt, rttStatus } from "./rtt.js";
/** 轮询间隔：串口 700 ms、RTT 2 s（每次 dump 都建一次 TCP 连接，不能太密）。 */
const SERIAL_POLL_MS = 700;
const RTT_POLL_MS = 2_000;
/** 单批上限：一次塞太多会把面板尾部挤满，剩下的下一拍再发。 */
const SERIAL_BATCH_LINES = 200;
/** 尾部指纹长度：桥重写文件时长度往往不变，只靠偏移判断会漏读或错读。 */
const SERIAL_TAIL_BYTES = 32;
const RTT_BATCH_RECORDS = 200;
function blank(name) {
    return { active: false, lines: 0, lastAt: "", lastError: "", timer: null, offset: 0, carry: "", sourceId: "", tail: "", lineCarry: "" };
}
const taps = { serial: blank("serial"), rtt: blank("rtt") };
function stamp() {
    return new Date().toISOString();
}
/** 读 rx.ndjson 里偏移之后的新增完整行；半行留到下一拍。 */
function readSerialIncrement(ipcDir) {
    const file = join(ipcDir, "rx.ndjson");
    if (!existsSync(file))
        return { lines: [], reset: false };
    const runtime = taps.serial;
    const buffer = readFileSync(file);
    let start = runtime.offset;
    let reset = start > buffer.length;
    // 偏移落在旧文件里但也可能「越界到别的字段」：用尾部指纹确认上一批还在原处。
    // 桥在 open 之后重写 rx.ndjson，长度可能不变，只看长度会静默错位。
    if (!reset && start > 0 && runtime.tail !== "") {
        const from = Math.max(0, start - runtime.tail.length);
        if (buffer.subarray(from, start).toString("utf8") !== runtime.tail)
            reset = true;
    }
    if (reset)
        start = 0;
    const chunk = buffer.subarray(start);
    const text = runtime.carry + chunk.toString("utf8");
    const parts = text.split("\n");
    runtime.carry = parts.pop() ?? "";
    runtime.offset = buffer.length - Buffer.byteLength(runtime.carry, "utf8");
    runtime.tail = buffer.subarray(Math.max(0, buffer.length - SERIAL_TAIL_BYTES)).toString("utf8");
    const lines = [];
    for (const part of parts) {
        const raw = part.trim();
        if (raw === "")
            continue;
        try {
            const parsed = JSON.parse(raw);
            const data = typeof parsed.d === "string" ? parsed.d : "";
            if (data === "")
                continue;
            if (parsed.p === true) {
                runtime.lineCarry += data;
                continue;
            }
            lines.push(runtime.lineCarry + data);
            runtime.lineCarry = "";
        }
        catch {
            // 半行或被桥截断的行：跳过，等下一批。
        }
    }
    return { lines, reset };
}
/**
 * 取一次串口增量并写事件流，返回本次发出的行数。
 *
 * 单独导出是为了单测能喂一个临时 ipc 目录，不必真的开串口。
 */
export function tapSerialOnce(ipcDir, sessionId, meta = {}) {
    const runtime = taps.serial;
    // 会话换了：偏移与残留都归零。
    if (runtime.sourceId !== sessionId) {
        runtime.sourceId = sessionId;
        runtime.offset = 0;
        runtime.carry = "";
        runtime.tail = "";
        runtime.lineCarry = "";
    }
    try {
        const { lines, reset } = readSerialIncrement(ipcDir);
        if (reset)
            runtime.lastError = "串口输出文件被重写，从头读";
        if (lines.length === 0)
            return 0;
        const batch = lines.slice(0, SERIAL_BATCH_LINES);
        emitChannel({
            channel: "serial",
            lines: batch,
            meta: { action: "stream", sessionId, ...meta },
            source: "system",
        });
        runtime.lines += batch.length;
        runtime.lastAt = stamp();
        runtime.lastError = "";
        return batch.length;
    }
    catch (error) {
        runtime.lastError = error instanceof Error ? error.message : String(error);
        return 0;
    }
}
function pollSerial() {
    const runtime = taps.serial;
    const session = currentSerialSession();
    if (session === null) {
        if (runtime.lastError !== "没有串口会话")
            runtime.lastError = "没有串口会话";
        return;
    }
    tapSerialOnce(session.ipcDir, session.sessionId, { port: session.port });
}
async function pollRtt() {
    const runtime = taps.rtt;
    const snapshot = rttStatus();
    if (!snapshot.running) {
        if (runtime.lastError !== "RTT 没在跑")
            runtime.lastError = "RTT 没在跑";
        return;
    }
    try {
        const dumped = await dumpRtt({ seconds: 0.5, maxRecords: RTT_BATCH_RECORDS });
        if (!dumped.ok) {
            runtime.lastError = dumped.message;
            return;
        }
        const records = dumped.records;
        if (records.length === 0)
            return;
        emitChannel({
            channel: "rtt",
            lines: records.map((record) => "[" + record.level + "] " + record.text),
            meta: { action: "stream", port: snapshot.port, addr: snapshot.addr },
            source: "system",
        });
        runtime.lines += records.length;
        runtime.lastAt = stamp();
        runtime.lastError = "";
    }
    catch (error) {
        runtime.lastError = error instanceof Error ? error.message : String(error);
    }
}
function startOne(name) {
    const runtime = taps[name];
    if (runtime.active)
        return;
    runtime.active = true;
    runtime.lastError = "";
    if (name === "serial") {
        runtime.timer = setInterval(pollSerial, SERIAL_POLL_MS);
    }
    else {
        let busy = false;
        runtime.timer = setInterval(() => {
            // dump 是 async 且要等窗口，重叠调用只会把 openocd 压满。
            if (busy)
                return;
            busy = true;
            void pollRtt().finally(() => {
                busy = false;
            });
        }, RTT_POLL_MS);
    }
    const timer = runtime.timer;
    if (timer !== null && typeof timer.unref === "function")
        timer.unref();
}
function stopOne(name) {
    const runtime = taps[name];
    if (!runtime.active)
        return;
    runtime.active = false;
    if (runtime.timer !== null)
        clearInterval(runtime.timer);
    runtime.timer = null;
}
/** 开/关常驻通道；返回操作后的状态。 */
export function setChannelTaps(request = {}) {
    if (request.serial !== undefined) {
        if (request.serial)
            startOne("serial");
        else
            stopOne("serial");
    }
    if (request.rtt !== undefined) {
        if (request.rtt)
            startOne("rtt");
        else
            stopOne("rtt");
    }
    return channelTapStatus();
}
/** 当前状态（面板据此画开关）。 */
export function channelTapStatus() {
    return ["serial", "rtt"].map((name) => ({
        name,
        active: taps[name].active,
        lines: taps[name].lines,
        lastAt: taps[name].lastAt,
        lastError: taps[name].lastError,
    }));
}
/** 停掉所有常驻通道；插件 dispose 与单测都用它。 */
export function stopChannelTaps() {
    stopOne("serial");
    stopOne("rtt");
}
/** 单测用：停掉并清空计数与偏移。 */
export function resetChannelTaps() {
    stopChannelTaps();
    taps.serial = blank("serial");
    taps.rtt = blank("rtt");
}
