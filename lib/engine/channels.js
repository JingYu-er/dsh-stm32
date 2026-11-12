/**
 * 实时通道事件：串口、RTT、变量监视的输出走同一条总线。
 *
 * 为什么不另开一条 SSE：面板已经按 seq 续播，把通道输出也编进同一序号，
 * 时间线、详情、证据目录就能共用一套断线与回放逻辑；代价是通道行不是独立流，
 * 面板按 kind=channel:<名字> 过滤即可。
 *
 * 一次工具调用产生一条通道事件，最多 400 行、单行 400 字符：面板只需要看尾部，
 * 完整原文仍在工具返回值与 rx.ndjson / RTT 记录里。
 */
import { emitEvent } from "./event-bus.js";
/** 中文标签写进摘要，面板与证据目录直接可读。 */
const CHANNEL_LABEL = {
    serial: "串口",
    rtt: "RTT",
    watch: "监视",
};
export const CHANNEL_LINE_LIMIT = 400;
const CHANNEL_CHAR_LIMIT = 400;
function normalizeLines(lines) {
    const nonEmpty = lines.map((line) => String(line)).filter((line) => line !== "");
    const shown = [];
    for (const text of nonEmpty) {
        shown.push(text.length > CHANNEL_CHAR_LIMIT ? text.slice(0, CHANNEL_CHAR_LIMIT) + "…" : text);
        if (shown.length >= CHANNEL_LINE_LIMIT)
            break;
    }
    return { total: nonEmpty.length, shown };
}
/** 追加一段通道输出；返回 null 表示没有内容可发。 */
export function emitChannel(chunk) {
    const { total, shown } = normalizeLines(chunk.lines);
    if (total === 0)
        return null;
    const label = CHANNEL_LABEL[chunk.channel];
    const payload = { channel: chunk.channel, lines: shown };
    if (chunk.meta !== undefined)
        payload.meta = chunk.meta;
    if (total > shown.length)
        payload.omitted = total - shown.length;
    return emitEvent({
        source: chunk.source ?? "model",
        kind: "channel:" + chunk.channel,
        status: "info",
        summary: label + " " + String(total) + " 行" + (total > shown.length ? "（面板保留前 " + String(shown.length) + " 行）" : ""),
        payload,
    });
}
