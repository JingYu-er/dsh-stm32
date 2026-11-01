/**
 * L1：变量监视与硬件观察点的登记表（纯状态 + 纯函数）。
 *
 * 为什么单独一层：
 * - 登记项要跨 stm32_watch 的多次调用保留（add → sample → list → remove），
 *   但"登记了什么、上次值是多少"是纯数据，放这里能离线单测；
 * - 真正连 gdb 的动作（采样求值、装/删观察点）在 DebugSessionManager 里，
 *   这样才能复用常驻的 MI 会话（P3）而不是每次另起一个 gdb；
 * - 观察点（data watchpoint）和硬件断点抢同一批比较器（F1 只有 4 个），
 *   预算校验也在这里做，别等 gdb 报 "Cannot insert watchpoint" 才发现。
 *
 * 生命周期：观察点活在 gdb 进程里。
 * - 会话关闭（stm32_debug_stop / turn 结束 / 租约到期）时引擎会 resetWatchState()，登记表一起清；
 * - MI 会话重建（gdb 进程没了、下次 eval 重新连）时观察点已经不在，
 *   markWatchpointsStale() 把编号清 0 并写明原因；值监视项不受影响，重新 sample 就行。
 */
export const WATCH_KINDS = ["value", "write", "read", "access"];
/** 报告/提示里给人看的名字。 */
export const WATCH_KIND_LABELS = {
    value: "值监视（每次 sample 求值）",
    write: "写观察点（gdb watch）",
    read: "读观察点（gdb rwatch）",
    access: "读写观察点（gdb awatch）",
};
/** 一次会话里登记项的上限：再多的话 sample 一次要停芯片太久。 */
export const MAX_WATCH_ENTRIES = 32;
export const MAX_WATCH_EXPRESSION_LENGTH = 200;
export function createWatchState() {
    return { entries: [], nextId: 1 };
}
/** 引擎用的单例：工具层与 DebugSessionManager 共用同一份登记表。 */
export const watchState = createWatchState();
export function isWatchKind(value) {
    return WATCH_KINDS.includes(value);
}
export function isSampledKind(kind) {
    return kind === "value";
}
/** 表达式去空白、拒绝空/超长/带换行的（带换行会把 gdb 命令行拆坏）。 */
export function normalizeWatchExpression(text) {
    if (typeof text !== "string")
        return null;
    const trimmed = text.trim();
    if (trimmed === "")
        return null;
    if (trimmed.length > MAX_WATCH_EXPRESSION_LENGTH)
        return null;
    if (/[\r\n\u0000]/u.test(trimmed))
        return null;
    return trimmed;
}
/**
 * 登记一项。expression 会先规范化；同一个表达式 + 同一种 kind 只登记一次
 * （重复登记只会让 sample 多读一遍同一处内存，没意义）。
 */
export function registerWatch(state, expression, kind, now, gdbNumber = 0) {
    const normalized = normalizeWatchExpression(expression);
    if (normalized === null) {
        return { entry: null, error: "表达式为空、超过 " + String(MAX_WATCH_EXPRESSION_LENGTH) + " 字符或带换行：" + JSON.stringify(expression) };
    }
    const duplicate = state.entries.find((item) => item.expression === normalized && item.kind === kind);
    if (duplicate !== undefined) {
        return { entry: null, error: "已经登记过：" + normalized + "（" + WATCH_KIND_LABELS[kind] + "，id " + String(duplicate.id) + "）" };
    }
    if (state.entries.length >= MAX_WATCH_ENTRIES) {
        return { entry: null, error: "登记项太多（上限 " + String(MAX_WATCH_ENTRIES) + "）：先 remove 掉不用的" };
    }
    const entry = {
        id: state.nextId,
        expression: normalized,
        kind,
        gdbNumber,
        lastValue: "",
        lastAt: 0,
        lastError: "",
        addedAt: now,
    };
    state.nextId += 1;
    state.entries.push(entry);
    return { entry, error: "" };
}
export function removeWatchByIds(state, ids) {
    const wanted = new Set(ids);
    const removed = [];
    state.entries = state.entries.filter((entry) => {
        if (wanted.has(entry.id)) {
            removed.push(entry);
            return false;
        }
        return true;
    });
    return removed;
}
export function removeAllWatches(state) {
    const removed = state.entries.slice();
    state.entries = [];
    return removed;
}
export function resetWatchState(state = watchState) {
    state.entries = [];
    state.nextId = 1;
}
export function sampledWatches(state) {
    return state.entries.filter((entry) => entry.kind === "value");
}
export function hardwareWatchpoints(state) {
    return state.entries.filter((entry) => entry.kind !== "value");
}
/** MI 会话重建后调用：gdb 里那些观察点已经跟着旧进程没了。 */
export function markWatchpointsStale(state, reason) {
    const affected = hardwareWatchpoints(state).filter((entry) => entry.gdbNumber !== 0);
    for (const entry of affected) {
        entry.gdbNumber = 0;
        entry.lastError = reason;
    }
    return affected;
}
/** 记一次采样结果：出错时保留上一次的值（采样失败不该把历史值抹掉）。 */
export function recordWatchSample(entry, value, error, now) {
    if (error === "" && value !== "")
        entry.lastValue = value;
    entry.lastAt = now;
    entry.lastError = error;
}
/** gdb 打印的标量 → 数字；结构体/数组/字符串返回 null（算不了差值）。 */
export function numericWatchValue(text) {
    const body = text.trim();
    if (/^[-+]?0x[0-9a-f]+$/iu.test(body)) {
        const hex = Number.parseInt(body, 16);
        return Number.isFinite(hex) ? hex : null;
    }
    if (/^[-+]?\d+$/u.test(body)) {
        const decimal = Number.parseInt(body, 10);
        return Number.isFinite(decimal) ? decimal : null;
    }
    if (/^[-+]?\d*\.\d+$/u.test(body)) {
        const float = Number.parseFloat(body);
        return Number.isFinite(float) ? float : null;
    }
    return null;
}
/** 与上次值的差：数字给带符号差值，非数字给"变化"。 */
export function formatWatchDelta(previous, current) {
    if (current === "")
        return "—";
    if (previous === "")
        return "首次";
    if (previous === current)
        return "0";
    const before = numericWatchValue(previous);
    const after = numericWatchValue(current);
    if (before !== null && after !== null) {
        const diff = after - before;
        return (diff > 0 ? "+" : "") + String(diff);
    }
    return "变化";
}
/** 列表里一行：id + 表达式 + 种类 + 最近值（或失败原因）。 */
export function formatWatchEntry(entry) {
    const parts = ["#" + String(entry.id), entry.expression, "[" + WATCH_KIND_LABELS[entry.kind] + "]"];
    parts.push(entry.lastValue === "" ? "= （还没采过）" : "= " + entry.lastValue);
    if (entry.gdbNumber > 0)
        parts.push("（gdb #" + String(entry.gdbNumber) + "）");
    if (entry.lastError !== "")
        parts.push("x " + entry.lastError);
    return parts.join(" ");
}
export function formatWatchLines(entries) {
    return entries.map((entry) => formatWatchEntry(entry));
}
/**
 * 解析 eval 回退路径的输出：每条表达式前面用 echo ===DSH:W<id>=== 打了标记，
 * 标记后是 gdb 打印的 "$N = ..."。结构体/数组会打多行，整段都算这条的值。
 */
export function parseWatchMarkers(output) {
    const values = new Map();
    const marks = [];
    for (const match of output.matchAll(/===DSH:W(\d+)===/gu)) {
        const id = Number(match[1]);
        const start = match.index ?? 0;
        if (!Number.isFinite(id))
            continue;
        marks.push({ id, start, end: start + match[0].length });
    }
    for (let index = 0; index < marks.length; index += 1) {
        const mark = marks[index];
        const next = marks[index + 1];
        const segment = output.slice(mark.end, next === undefined ? output.length : next.start).trim();
        if (segment === "") {
            values.set(mark.id, { value: "", error: "没有输出" });
            continue;
        }
        const printed = /^\$\d+\s*=\s*([\s\S]*)$/u.exec(segment);
        if (printed === null) {
            const firstLine = segment.split(/\r?\n/u)[0] ?? segment;
            values.set(mark.id, { value: "", error: firstLine.trim() });
            continue;
        }
        values.set(mark.id, { value: printed[1].trim(), error: "" });
    }
    return values;
}
/**
 * 从 gdb 输出里取观察点编号。
 * 形如 "Hardware watchpoint 2: g_tick_1k"、"Watchpoint 3: foo"（软件观察点，单步开销大）。
 */
export function parseWatchpointNumber(text) {
    const match = /watchpoint\s+(\d+)\s*:/iu.exec(text);
    if (match === null)
        return null;
    const number = Number(match[1]);
    return Number.isFinite(number) && number > 0 ? number : null;
}
/** gdb 建的是硬件观察点还是软件观察点（软件观察点会拖慢目标，报告里要说明）。 */
export function isHardwareWatchpoint(text) {
    return /Hardware\s+(?:read\s+|access\s+)?watchpoint/iu.test(text);
}
