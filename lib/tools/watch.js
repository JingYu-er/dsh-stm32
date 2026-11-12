/**
 * P3：stm32_watch —— 变量监视（值采样）与硬件观察点。
 *
 * - action=add：kind=value 登记一个"每次 sample 求值"的表达式；kind=write/read/access 用真实观察点
 *   （gdb watch / rwatch / awatch，F1 有 4 个数据比较器，与硬件断点共用）；
 * - action=sample：目标在跑就先 -exec-interrupt 停住，逐项求值，给出与上次的差值，再按原状态放回去；
 * - action=list / remove / clear：看登记表、按 id 删、全清。
 *
 * 为什么单独一个工具而不是塞进 stm32_debug_eval：观察点会消耗芯片比较器预算、值监视需要
 * "停下→读→放回"这一整套语义，混进 eval 的裸命令里没人管得住上限。
 * 登记表住在插件进程内（engine/watch.ts 的单例），会话一关就清空（观察点在 gdb 进程里随会话消失）。
 */
import { debugSessions } from "../engine/debug-session.js";
import { WATCH_KIND_LABELS, hardwareWatchpoints, isWatchKind, normalizeWatchExpression, registerWatch, watchState, } from "../engine/watch.js";
import { emitChannel } from "../engine/channels.js";
export const WATCH_TOOL = "stm32_watch";
const quotaSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        used: { type: "number" },
        limit: { type: "number" },
        remaining: { type: "number" },
    },
    required: ["used", "limit", "remaining"],
};
const entrySchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        id: { type: "number" },
        expression: { type: "string" },
        kind: { type: "string" },
        kindLabel: { type: "string" },
        gdbNumber: { type: "number" },
        lastValue: { type: "string" },
        lastAt: { type: "number" },
        lastError: { type: "string" },
        delta: { type: "string" },
    },
    required: ["id", "expression", "kind", "kindLabel", "gdbNumber", "lastValue", "lastAt", "lastError", "delta"],
};
export const watchOutputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        message: { type: "string" },
        report: {
            type: "object",
            additionalProperties: false,
            properties: {
                ok: { type: "boolean" },
                action: { type: "string" },
                entries: { type: "array", items: entrySchema },
                watchpoints: quotaSchema,
                halted: { type: "boolean" },
                resumed: { type: "boolean" },
                durationMs: { type: "number" },
                errors: { type: "array", items: { type: "string" } },
                notes: { type: "array", items: { type: "string" } },
                message: { type: "string" },
            },
            required: ["ok", "action", "entries", "watchpoints", "halted", "resumed", "durationMs", "errors", "notes", "message"],
        },
    },
    required: ["message", "report"],
};
function entryView(entry, delta = "") {
    return {
        id: entry.id,
        expression: entry.expression,
        kind: entry.kind,
        kindLabel: WATCH_KIND_LABELS[entry.kind],
        gdbNumber: entry.gdbNumber,
        lastValue: entry.lastValue,
        lastAt: entry.lastAt,
        lastError: entry.lastError,
        delta,
    };
}
function currentQuota() {
    return debugSessions.status().watchpoints;
}
/** 值监视清单的人话描述（limit=0 时别写成 "0/0" 让人以为超了）。 */
function describeQuota(quota) {
    return "硬件观察点 " + String(quota.used) + "/" + String(quota.limit);
}
function emptyReport(action, message, errors = [], notes = []) {
    return {
        ok: errors.length === 0, action, entries: [], watchpoints: currentQuota(),
        halted: false, resumed: false, durationMs: 0, errors, notes, message,
    };
}
/** 把 addWatchpoints 的报告翻成本工具的 report（entries 换成视图）。 */
function fromAddReport(report) {
    return {
        ok: report.ok, action: "add", entries: report.added.map((entry) => entryView(entry)),
        watchpoints: report.budget, halted: false, resumed: report.resumed, durationMs: report.durationMs,
        errors: report.errors, notes: report.notes, message: report.message,
    };
}
/** 把 sampleWatches 的报告翻成本工具的 report（值 + 差值一起给）。 */
function fromSampleReport(report) {
    const byId = new Map();
    for (const sample of report.samples)
        byId.set(sample.id, sample.delta);
    const errors = report.errors.slice();
    for (const sample of report.samples) {
        if (!sample.ok)
            errors.push(sample.expression + "：" + sample.error);
    }
    return {
        ok: report.ok, action: "sample", entries: watchState.entries.map((entry) => entryView(entry, byId.get(entry.id) ?? "")),
        watchpoints: currentQuota(), halted: report.halted, resumed: report.resumed, durationMs: report.durationMs,
        errors, notes: [], message: report.message,
    };
}
export function registerWatchTool(ctx) {
    ctx.tools.register({
        name: WATCH_TOOL,
        description: "变量监视与硬件观察点。action=add 登记表达式（kind=value 每次 sample 求值；kind=write/read/access 装真正的硬件观察点，F1 只有 4 个数据比较器，与硬件断点共用）；action=sample 把目标停下读一遍、给与上次的差值、再按原状态放回去；action=list/remove/clear 管理登记表。值监视项每次 sample 都会求值，观察点是被动拦截（命中时由 gdb 报停）。会话关闭时登记表随之清空。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                action: { type: "string", enum: ["add", "sample", "list", "remove", "clear"], description: "要做什么，默认 list（看登记表）。" },
                expressions: { type: "array", items: { type: "string" }, description: "action=add 要监视的表达式，例如 g_tick_1k、g_adc_dma[0]、*(unsigned int *)0x4001100C。" },
                kind: { type: "string", enum: ["value", "write", "read", "access"], description: "action=add 的类型：value（默认，采样求值）、write（写观察点）、read（读观察点）、access（读写观察点）。" },
                ids: { type: "array", items: { type: "number" }, description: "action=remove 要删的 id（action=list 里能看到）。" },
                timeoutMs: { type: "number", description: "单条求值/装观察点的超时毫秒数，默认 20000。" },
                resume: { type: "boolean", description: "采样时目标原本在跑：采完是否放回去（默认 true）。" },
            },
        },
        timeoutMs: 90_000,
        isConcurrencySafe: () => false,
        output: {
            schema: watchOutputSchema,
            render: (_args, value) => {
                const typed = value;
                const lines = [typed.report.message];
                for (const entry of typed.report.entries) {
                    const delta = entry.delta === "" ? "" : "（Δ " + entry.delta + "）";
                    const where = entry.gdbNumber > 0 ? " [gdb #" + String(entry.gdbNumber) + "]" : "";
                    const value = entry.lastValue === "" ? "（还没采过）" : entry.lastValue;
                    lines.push("#" + String(entry.id) + " " + entry.expression + " = " + value + delta + where);
                    if (entry.lastError !== "")
                        lines.push("  x " + entry.lastError);
                }
                if (typed.report.entries.length === 0)
                    lines.push("（登记表是空的：先用 action=add 加表达式）");
                lines.push("· " + describeQuota(typed.report.watchpoints));
                for (const note of typed.report.notes.slice(0, 6))
                    lines.push("- " + note);
                for (const error of typed.report.errors.slice(0, 6))
                    lines.push("x " + error);
                return [{ type: "text", text: lines.join("\n") }];
            },
        },
        async execute(rawArgs, exec) {
            const args = rawArgs ?? {};
            const action = args.action ?? "list";
            const startedAt = Date.now();
            const timeout = args.timeoutMs;
            if (action === "add") {
                const expressions = args.expressions ?? [];
                const kind = args.kind === undefined ? "value" : args.kind;
                if (!isWatchKind(kind)) {
                    return { message: "kind 不认识：" + String(kind) + "（只认 value/write/read/access）", report: emptyReport(action, "没加：kind 不认识", ["kind 不认识：" + String(kind)]) };
                }
                if (expressions.length === 0) {
                    return { message: "没给 expressions：例如 action=add，expressions 传 [g_tick_1k]", report: emptyReport(action, "没加：没给表达式", ["expressions 是空的"]) };
                }
                // 值监视只是登记（求值要等 sample），所以不需要会话；观察点必须现在装进 gdb。
                if (kind === "value") {
                    const errors = [];
                    const added = [];
                    for (const text of expressions) {
                        const expression = normalizeWatchExpression(text);
                        if (expression === null) {
                            errors.push("表达式不合法：" + JSON.stringify(text));
                            continue;
                        }
                        const registered = registerWatch(watchState, expression, "value", Date.now());
                        if (registered.entry === null) {
                            errors.push(registered.error);
                            continue;
                        }
                        added.push(registered.entry);
                    }
                    const report = {
                        ok: errors.length === 0, action: "add", entries: added.map((entry) => entryView(entry)),
                        watchpoints: currentQuota(), halted: false, resumed: false, durationMs: Date.now() - startedAt,
                        errors, notes: [], message: errors.length === 0 ? "登记了 " + String(added.length) + " 个值监视项（用 action=sample 取值）" : "有 " + String(errors.length) + " 条没登记上",
                    };
                    return { message: report.message, report };
                }
                const entries = expressions.map((expression) => ({ expression, kind }));
                const added = await debugSessions.addWatchpoints({ entries, ...(timeout === undefined ? {} : { timeoutMs: timeout }) });
                const report = fromAddReport(added);
                return { message: report.message, report };
            }
            if (action === "sample") {
                const sampled = await debugSessions.sampleWatches({
                    ...(timeout === undefined ? {} : { timeoutMs: timeout }),
                    ...(args.resume === undefined ? {} : { resume: args.resume }),
                    signal: exec.signal,
                });
                // 通道用原始样本：报表里的 entries 已经丢了 previous，差值语义也换了名字。
                const channelLines = sampled.samples.map((sample) => sample.ok
                    ? sample.expression + " = " + sample.value + (sample.delta === "" ? "" : "（" + sample.delta + "）")
                    : sample.expression + "：" + sample.error);
                if (channelLines.length > 0) {
                    // 结构化样本随通道事件一起发：面板据此画历史曲线，不必再解析文本行。
                    emitChannel({
                        channel: "watch",
                        lines: channelLines,
                        meta: {
                            action: "sample",
                            samples: sampled.samples.map((sample) => ({
                                expression: sample.expression,
                                value: sample.value,
                                delta: sample.delta,
                                ok: sample.ok,
                            })),
                        },
                    });
                }
                const report = fromSampleReport(sampled);
                return { message: report.message, report };
            }
            if (action === "list") {
                const entries = watchState.entries.map((entry) => entryView(entry));
                const sampled = watchState.entries.filter((entry) => entry.kind === "value").length;
                const message = entries.length === 0
                    ? "登记表是空的：先用 action=add 加表达式"
                    : "登记了 " + String(entries.length) + " 项（值监视 " + String(sampled) + "、观察点 " + String(hardwareWatchpoints(watchState).length) + "）";
                return {
                    message,
                    report: { ok: true, action: "list", entries, watchpoints: currentQuota(), halted: false, resumed: false, durationMs: Date.now() - startedAt, errors: [], notes: [], message },
                };
            }
            if (action === "remove") {
                const ids = args.ids ?? [];
                if (ids.length === 0) {
                    return { message: "没给 ids：先 action=list 看编号，或 action=clear 全清", report: emptyReport(action, "没删：没给 ids", ["ids 是空的"]) };
                }
                const removed = await debugSessions.removeWatchpoints(ids);
                return {
                    message: removed.message,
                    report: {
                        ok: removed.ok, action: "remove", entries: removed.removed.map((entry) => entryView(entry)),
                        watchpoints: removed.budget, halted: false, resumed: removed.resumed, durationMs: removed.durationMs,
                        errors: removed.errors, notes: [], message: removed.message,
                    },
                };
            }
            if (action === "clear") {
                const ids = watchState.entries.map((entry) => entry.id);
                if (ids.length === 0) {
                    return { message: "登记表本来就是空的", report: emptyReport(action, "没清：登记表本来就是空的") };
                }
                const removed = await debugSessions.removeWatchpoints(ids);
                const message = "清空了登记表（" + String(removed.removed.length) + " 项）";
                return {
                    message: removed.ok ? message : message + "，但有问题：" + (removed.errors[0] ?? ""),
                    report: {
                        ok: removed.ok, action: "clear", entries: [], watchpoints: removed.budget, halted: false,
                        resumed: removed.resumed, durationMs: removed.durationMs, errors: removed.errors, notes: [], message,
                    },
                };
            }
            return {
                message: "action 不认识：" + action + "（只认 add/sample/list/remove/clear）",
                report: emptyReport(action, "没做：action 不认识", ["action 不认识：" + action]),
            };
        },
    });
}
