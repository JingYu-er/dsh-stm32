/**
 * 调试台的事件总线：把工具调用、面板操作与设备副作用收敛成一条带序号的流。
 *
 * 设计取舍：
 *  - 单一事实源。时间线、SSE 推流、证据目录都读这一份事件，面板不各自记账，
 *    所以「模型做了什么」与「用户看到什么」不会分叉。
 *  - 只保留最近 5000 条（环形）。RTT 与串口已按窗口汇总，剩下的条目量级在千级，
 *    5000 条足够回看一整轮联调，内存占用保持在兆级以内。
 *  - 被挤出的条目不是直接丢弃，而是交给 event-log.ts 定期落盘（默认 30 秒一批），
 *    于是「内存里只留近期」与「证据目录里的完整记录」同时成立。
 *
 * 本模块是纯内存实现：不碰文件系统、不碰定时器，可在单测里直接驱动。
 */
/** 内存里保留的事件条数。 */
export const EVENT_RING_LIMIT = 5000;
/** 单条事件 payload 的序列化上限（字节）。超出时保留预览并标记截断。 */
export const EVENT_PAYLOAD_LIMIT = 8192;
/** 等待落盘的挤出条目上限；落盘通道卡住时丢弃最旧的，并留一条缺口事件。 */
export const EVENT_PENDING_LIMIT = 2000;
const ring = [];
let pending = [];
let pendingDropped = 0;
let nextSeq = 1;
let sessionKey = "";
const listeners = new Set();
function trimmedPayload(payload) {
    if (payload === undefined)
        return { payload: undefined, truncated: false };
    let text;
    try {
        text = JSON.stringify(payload);
    }
    catch {
        return { payload: { note: "payload 含无法序列化的值，已省略" }, truncated: true };
    }
    if (text.length <= EVENT_PAYLOAD_LIMIT)
        return { payload, truncated: false };
    return {
        payload: { preview: text.slice(0, EVENT_PAYLOAD_LIMIT - 32) },
        truncated: true,
    };
}
/**
 * 追加一条事件。
 *
 * 序号由总线分配，调用方不要自己造：面板按 seq 增量拉取，自己造的序号会让续播错位。
 */
export function emitEvent(input) {
    const trimmed = trimmedPayload(input.payload);
    const event = {
        seq: nextSeq,
        time: new Date().toISOString(),
        source: input.source,
        kind: input.kind,
        status: input.status ?? "info",
        summary: input.summary,
    };
    if (trimmed.payload !== undefined)
        event.payload = trimmed.payload;
    if (trimmed.truncated)
        event.truncated = true;
    if (input.refs !== undefined && input.refs.length > 0)
        event.refs = input.refs;
    const owner = (input.session ?? sessionKey).trim();
    if (owner !== "")
        event.session = owner;
    nextSeq += 1;
    ring.push(event);
    if (ring.length > EVENT_RING_LIMIT) {
        const overflow = ring.splice(0, ring.length - EVENT_RING_LIMIT);
        for (const item of overflow)
            pending.push(item);
        if (pending.length > EVENT_PENDING_LIMIT) {
            pendingDropped += pending.length - EVENT_PENDING_LIMIT;
            pending = pending.slice(pending.length - EVENT_PENDING_LIMIT);
        }
    }
    for (const listener of listeners) {
        try {
            listener(event);
        }
        catch {
            // 订阅方自己出错不影响其它订阅方，也不该让工具调用失败。
        }
    }
    return event;
}
/** 订阅新事件，返回注销函数。 */
export function subscribeEvents(listener) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
/**
 * 取序号大于 since 的事件（按 seq 升序）。
 * 传 session 时只返回该会话的事件；不传则返回全部（单会话时面板不传也能用）。
 */
export function eventSnapshot(since = 0, session) {
    const wanted = (session ?? "").trim();
    const base = since <= 0 ? ring.slice() : ring.filter((event) => event.seq > since);
    if (wanted === "")
        return base;
    return base.filter((event) => event.session === wanted);
}
/** 内存里当前保留的事件条数（面板与诊断用）；传 session 时只数该会话的。 */
export function eventCount(session) {
    const wanted = (session ?? "").trim();
    if (wanted === "")
        return ring.length;
    return ring.reduce((total, event) => (event.session === wanted ? total + 1 : total), 0);
}
/** 取走待落盘的挤出事件；调用方负责写入成功后再确认。 */
export function drainEvicted() {
    const drained = pending;
    pending = [];
    return drained;
}
/** 把落盘失败的条目放回队首（维持时间顺序），供下一轮重试。 */
export function requeueEvicted(events) {
    if (events.length === 0)
        return;
    pending = events.concat(pending);
    if (pending.length > EVENT_PENDING_LIMIT) {
        pendingDropped += pending.length - EVENT_PENDING_LIMIT;
        pending = pending.slice(pending.length - EVENT_PENDING_LIMIT);
    }
}
/** 因落盘积压被丢弃的条数，写进缺口事件，避免证据目录看起来连续其实是断的。 */
export function takeDroppedCount() {
    const count = pendingDropped;
    pendingDropped = 0;
    return count;
}
/**
 * 绑定会话键：证据目录按它分目录，做到「一个会话一个目录」。
 *
 * 工具执行时能拿到 agent id，面板能拿到 session id，两者谁先到就用谁；
 * 都没绑定时退回进程级默认键，事件照样可用，只是目录不按会话切分。
 */
export function setEventSessionKey(key) {
    const normalized = key.trim();
    if (normalized === "" || normalized === sessionKey)
        return;
    sessionKey = normalized;
}
export function eventSessionKey() {
    return sessionKey;
}
/** 单测用：清空全部状态。 */
export function resetEventBus() {
    ring.length = 0;
    pending = [];
    pendingDropped = 0;
    nextSeq = 1;
    sessionKey = "";
    listeners.clear();
}
