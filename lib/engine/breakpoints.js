/**
 * B4：断点预算 —— 按芯片的真实上限限制硬件断点 / 数据观察点，超限在碰探针之前就报。
 *
 * 为什么要有这一层：Cortex-M 的硬件断点用 FPB 代码比较器、观察点用 DWT 数据比较器，
 * STM32F1 只有 6 / 4 个。第 7 个断点不是"慢一点"，而是 gdb 报
 * "Cannot insert breakpoint N" 然后整次调试提前收场，用户看到的是"调试莫名其妙失败"。
 * 所以这里在设断点之前先把请求和预算对齐：超了就一次说清超了几个、删哪个、换成什么，
 * 而且这一步发生在 spawn openocd 之前（探针不动、不占用）。
 *
 * 预算来源：资源包 device/f1/chips.json 里如果给某颗芯片写了 breakpoints / watchpoints，
 * 就用芯片自己的值（资源仓库以后按型号补值，插件不用改）；没写就按 F1 实测值 6 / 4。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { findChipFact } from "../data/device-facts.js";
/** F1 实测：6 个硬件断点、4 个观察点。 */
export const F1_BREAKPOINT_BUDGET = { code: 6, data: 4 };
/** 目前插件只支持 F1：拿不到更精确的值时就用这一份。 */
export const DEFAULT_BREAKPOINT_BUDGET = F1_BREAKPOINT_BUDGET;
/** used 夹在 [0, limit] 里：报告不能让"已用"看起来超过上限或为负。 */
export function quotaOf(used, limit) {
    const cap = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;
    const taken = Number.isFinite(used) ? Math.min(cap, Math.max(0, Math.trunc(used))) : 0;
    return { used: taken, limit: cap, remaining: cap - taken };
}
function usableCount(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}
/**
 * chips.json 里的芯片记录 → 预算；没写就返回 null（调用方回退 F1 默认）。
 * 只写了一个字段时，另一个按 F1 默认补齐——比整份作废更有用。
 */
export function budgetFromChipFact(chip) {
    if (chip === null || chip === undefined)
        return null;
    const code = usableCount(chip.breakpoints);
    const data = usableCount(chip.watchpoints);
    if (code === null && data === null)
        return null;
    return { code: code ?? F1_BREAKPOINT_BUDGET.code, data: data ?? F1_BREAKPOINT_BUDGET.data };
}
/** 工程里 .ioc 的 Mcu.CPN（找不到就是空串；多个 .ioc 时按文件名顺序取第一个读得出来的）。 */
export function readIocCpn(projectDir) {
    let names;
    try {
        names = readdirSync(projectDir);
    }
    catch {
        return "";
    }
    const candidates = names.filter((name) => name.toLowerCase().endsWith(".ioc")).sort();
    for (const name of candidates) {
        try {
            const text = readFileSync(join(projectDir, name), "utf8");
            const match = /^Mcu\.CPN=(.+)$/mu.exec(text);
            const cpn = match === null ? "" : (match[1] ?? "").trim();
            if (cpn !== "")
                return cpn.toUpperCase();
        }
        catch {
            // 读不了就试下一个；没有可用的就回退默认预算（不让断点预算把调试挡在门外）。
        }
    }
    return "";
}
/** 工程 → 芯片 → 预算。任何一步失败都退回 F1 默认并说明原因。 */
export function resolveBreakpointBudget(projectDir, env = process.env) {
    const cpn = readIocCpn(projectDir);
    const fallback = (why) => ({
        budget: F1_BREAKPOINT_BUDGET,
        source: "f1-default",
        chip: cpn,
        note: "断点预算按 STM32F1 默认 " + String(F1_BREAKPOINT_BUDGET.code) + " 个硬件断点 / " + String(F1_BREAKPOINT_BUDGET.data) + " 个观察点算（" + why + "）",
    });
    if (cpn === "")
        return fallback("工程里没找到 .ioc");
    let fact = null;
    try {
        fact = findChipFact(cpn, env);
    }
    catch {
        fact = null;
    }
    if (fact === null)
        return fallback("chips.json 里没有 " + cpn);
    const budget = budgetFromChipFact(fact);
    if (budget === null)
        return fallback("chips.json 的 " + cpn + " 没写 breakpoints/watchpoints");
    return {
        budget,
        source: "chips.json",
        chip: cpn,
        note: "断点预算来自 chips.json（" + cpn + "）：" + String(budget.code) + " 个硬件断点 / " + String(budget.data) + " 个观察点",
    };
}
const BREAK_COMMANDS = new Set(["break", "b", "tbreak", "tb", "hbreak", "thbreak", "rbreak"]);
const WATCH_COMMANDS = new Set(["watch", "rwatch", "awatch"]);
/**
 * "main" / "watch:g_led_count" / "break:HAL_Delay" → 规范化断点。
 * 前缀只用来标 kind，去掉前缀后的部分原样交给 gdb。空串返回 null（调用方忽略）。
 */
export function parseBreakpointSpec(text) {
    const raw = text.trim();
    if (raw === "")
        return null;
    const lower = raw.toLowerCase();
    for (const prefix of ["watch:", "rwatch:", "awatch:", "data:"]) {
        if (lower.startsWith(prefix)) {
            const location = raw.slice(prefix.length).trim();
            return location === "" ? null : { location, kind: "data" };
        }
    }
    for (const prefix of ["break:", "tbreak:", "hbreak:", "code:"]) {
        if (lower.startsWith(prefix)) {
            const location = raw.slice(prefix.length).trim();
            return location === "" ? null : { location, kind: "code" };
        }
    }
    return { location: raw, kind: "code" };
}
/** 一条 gdb 命令 → 断点请求（只认 break/watch 家族；别的命令原样留给 preCommands 执行）。 */
export function breakpointFromGdbCommand(command) {
    const text = command.trim();
    if (text === "")
        return null;
    const match = /^([A-Za-z]+)(?:\s+(.*))?$/u.exec(text);
    if (match === null)
        return null;
    const verb = (match[1] ?? "").toLowerCase();
    const rest = (match[2] ?? "").trim();
    if (BREAK_COMMANDS.has(verb))
        return { location: rest === "" ? "(当前 pc)" : rest, kind: "code" };
    if (WATCH_COMMANDS.has(verb))
        return { location: rest === "" ? "(当前表达式)" : rest, kind: "data" };
    return null;
}
/**
 * 把三处来源（breakAt / breakpoints / preCommands）收成一份不重复的请求清单。
 *
 * 同一位置只留一个：硬件比较器按地址分配，重复的 break 在 gdb 里会各占一个编号，
 * 真到 FPB 上就是白吃一个比较器。
 */
export function collectBreakpointRequests(input) {
    const notes = [];
    const raw = [];
    const breakAt = (input.breakAt ?? "").trim();
    if (breakAt !== "" && breakAt.toLowerCase() !== "none")
        raw.push({ location: breakAt, kind: "code" });
    for (const text of input.breakpoints ?? []) {
        const spec = parseBreakpointSpec(text);
        if (spec === null)
            notes.push("breakpoints 里有一个空串，已经忽略");
        else
            raw.push(spec);
    }
    let fromPre = 0;
    for (const command of input.preCommands ?? []) {
        const spec = breakpointFromGdbCommand(command);
        if (spec === null)
            continue;
        raw.push(spec);
        fromPre += 1;
    }
    if (fromPre > 0)
        notes.push("preCommands 里有 " + String(fromPre) + " 条 break/watch 命令，也一起算进断点预算");
    const seen = new Set();
    const requested = [];
    for (const spec of raw) {
        const key = spec.kind + "\u0000" + spec.location;
        if (seen.has(key))
            continue;
        seen.add(key);
        requested.push(spec);
    }
    if (requested.length !== raw.length) {
        notes.push("有 " + String(raw.length - requested.length) + " 个重复断点（同一位置）并成了一个，不重复占比较器");
    }
    return { requested, notes };
}
/** 超预算时的一句话（放进 errors[0]，用户最先看到的就是它）。 */
function overflowDetail(codeAsked, dataAsked, budget, overCode, overData) {
    const parts = [];
    if (overCode > 0)
        parts.push("多 " + String(overCode) + " 个硬件断点");
    if (overData > 0)
        parts.push("多 " + String(overData) + " 个观察点");
    return "这次要设 " + String(codeAsked) + " 个硬件断点 / " + String(dataAsked) + " 个观察点，芯片上限是 "
        + String(budget.code) + "/" + String(budget.data) + "（" + parts.join("、") + "）";
}
/** 超预算时用户能照着做的建议（放进 notes，不塞进一行里的长句）。 */
function overflowSuggestion(budget, overCode, overData) {
    const parts = [];
    if (overCode > 0) {
        parts.push("删掉多出来的 " + String(overCode) + " 个 break：硬件断点占 FPB 比较器，第 " + String(budget.code + 1) + " 个 gdb 只会报 Cannot insert breakpoint 并把整次调试带崩；要连着停几个点就改用 tbreak（命中即删），或者先 break 一个、到点再换下一个");
    }
    if (overData > 0) {
        parts.push("观察点同理：DWT 只有 " + String(budget.data) + " 个数据比较器，超出的改成一次 watch 一个、或用 print / x 轮询变量");
    }
    parts.push("F1 的 " + String(budget.code) + "/" + String(budget.data) + " 是硅片上限（FPB/DWT 比较器数量），想同时停更多点只能换芯片");
    return parts.join("；");
}
/** 请求清单 vs 预算：按顺序放到放不下为止，剩下的进 overflow。 */
export function planBreakpoints(requested, budget) {
    const cap = {
        code: Number.isFinite(budget.code) ? Math.max(0, Math.trunc(budget.code)) : 0,
        data: Number.isFinite(budget.data) ? Math.max(0, Math.trunc(budget.data)) : 0,
    };
    const placed = [];
    const overflow = [];
    let codeUsed = 0;
    let dataUsed = 0;
    for (const request of requested) {
        if (request.kind === "data") {
            if (dataUsed < cap.data) {
                dataUsed += 1;
                placed.push(request);
            }
            else
                overflow.push(request);
            continue;
        }
        if (codeUsed < cap.code) {
            codeUsed += 1;
            placed.push(request);
        }
        else
            overflow.push(request);
    }
    const codeAsked = codeUsed + overflow.filter((item) => item.kind === "code").length;
    const dataAsked = dataUsed + overflow.filter((item) => item.kind === "data").length;
    const ok = overflow.length === 0;
    return {
        ok,
        placed,
        overflow,
        suggestion: ok ? "" : overflowSuggestion(cap, codeAsked - codeUsed, dataAsked - dataUsed),
        detail: ok ? "" : overflowDetail(codeAsked, dataAsked, cap, codeAsked - codeUsed, dataAsked - dataUsed),
        budget: cap,
        used: { code: codeUsed, data: dataUsed },
        remaining: { code: cap.code - codeUsed, data: cap.data - dataUsed },
    };
}
