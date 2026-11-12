/**
 * 工具调用的统一事件埋点：不逐个工具改 execute，而是在装配时包一层。
 *
 * 做法：给 apply 用的 ctx 套一个 Proxy，只替换 `tools.register`。
 * 其余属性原样转发（绑定到真实 ctx，避免 cordis 内部的 this 语义被破坏）。
 *
 * 每条工具调用产生两条事件：start 与配对的 ok/fail，共享工具名。
 * 摘要是给人看的一行字，完整参数与结果放进 payload，超过 8 KB 时由总线截断。
 */
import { emitEvent, setEventSessionKey } from "./event-bus.js";
function firstLine(text, limit = 160) {
    const line = text.split(/\r?\n/u)[0] ?? "";
    return line.length > limit ? line.slice(0, limit) + "…" : line;
}
function describeError(error) {
    if (error instanceof Error)
        return firstLine(error.message === "" ? error.name : error.message);
    return firstLine(String(error));
}
/** 从返回值里挑少量字段进事件，避免把整个产物结构塞进时间线。 */
function resultDigest(value) {
    if (value === null || typeof value !== "object")
        return undefined;
    const record = value;
    const digest = {};
    for (const key of ["ok", "summary", "error", "message", "elfPath", "hexPath", "binPath", "port", "taskId"]) {
        if (record[key] !== undefined)
            digest[key] = record[key];
    }
    return Object.keys(digest).length === 0 ? undefined : digest;
}
function formatDuration(ms) {
    if (ms < 1000)
        return String(Math.round(ms)) + " ms";
    return (ms / 1000).toFixed(1) + " s";
}
/** 给单个工具定义加 start / ok / fail 事件。 */
export function withToolEvents(definition) {
    const original = definition.execute;
    return {
        ...definition,
        execute: async (args, exec) => {
            const startedAt = Date.now();
            const owner = exec?.agent?.id;
            if (typeof owner === "string" && owner !== "")
                setEventSessionKey(owner);
            emitEvent({
                source: "model",
                kind: definition.name,
                status: "start",
                summary: definition.name + " 开始",
                payload: { args: args },
                session: owner,
            });
            try {
                const value = await original(args, exec);
                emitEvent({
                    source: "model",
                    kind: definition.name,
                    status: "ok",
                    summary: definition.name + " 完成（" + formatDuration(Date.now() - startedAt) + "）",
                    payload: { durationMs: Date.now() - startedAt, result: resultDigest(value) },
                    session: owner,
                });
                return value;
            }
            catch (error) {
                emitEvent({
                    source: "model",
                    kind: definition.name,
                    status: "fail",
                    summary: definition.name + " 失败：" + describeError(error),
                    payload: { durationMs: Date.now() - startedAt, error: describeError(error) },
                    session: owner,
                });
                throw error;
            }
        },
    };
}
/**
 * 返回一个只替换了 `tools` 的 ctx 代理，供 apply 里注册工具使用。
 *
 * 参数：deps 由调用方传 `{}`，留给后续按工具过滤/采样用。
 */
export function instrumentContext(ctx, options = {}) {
    const include = options.include ?? ((name) => name.startsWith("stm32_"));
    const tools = {
        register(tool) {
            return ctx.tools.register(include(tool.name) ? withToolEvents(tool) : tool);
        },
    };
    return new Proxy(ctx, {
        get(target, property) {
            if (property === "tools")
                return tools;
            const value = Reflect.get(target, property, target);
            if (typeof value === "function")
                return value.bind(target);
            return value;
        },
        set(target, property, value) {
            return Reflect.set(target, property, value, target);
        },
    });
}
