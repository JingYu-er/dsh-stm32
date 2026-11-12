/**
 * 中断表：从 .ioc 的 NVIC.* 键读出「哪些中断开着、抢占优先级与子优先级多少」。
 *
 * CubeMX 写下的值形如 `true\:0\:0\:false\:false\:true\:false\:false\:false`：
 * 第一段是 NVIC 使能，第二段抢占优先级，第三段子优先级，其余段与中断表无关，不解释。
 * 只读，不改 .ioc；排序按「抢占优先级 → 子优先级 → 名字」，与 CubeMX 的列表习惯一致。
 */
import { readFileSync } from "node:fs";
import { findIocPath } from "./pinout.js";
import { parseIocEntries } from "./ioc-diff.js";
/** `NVIC.USART1_IRQn` → `USART1`；不是这一形状返回空串。 */
export function interruptName(key) {
    if (!key.startsWith("NVIC."))
        return "";
    const body = key.slice("NVIC.".length);
    if (!body.endsWith("_IRQn"))
        return "";
    return body.slice(0, -"_IRQn".length);
}
/**
 * 解析一条 NVIC 值。
 *
 * `.ioc` 里冒号被转义成 `\:`，先还原再切段；段数不足时保留能读出的部分，
 * 优先级给 -1 而不是 0——0 是合法的高优先级，不能用来表示「没写」。
 */
export function parseNvicValue(value) {
    const parts = value.replace(/\\:/gu, ":").split(":");
    const enabled = (parts[0] ?? "").trim().toLowerCase() === "true";
    const toNumber = (text) => {
        const trimmed = (text ?? "").trim();
        if (!/^\d+$/u.test(trimmed))
            return -1;
        const parsed = Number.parseInt(trimmed, 10);
        return Number.isFinite(parsed) ? parsed : -1;
    };
    return { enabled, preempt: toNumber(parts[1]), sub: toNumber(parts[2]) };
}
/** 只认带三段的 NVIC 值：`NVIC.ForceEnableDMAVector=true` 这类开关不是中断。 */
export function collectInterrupts(entries) {
    const out = [];
    for (const entry of entries) {
        const name = interruptName(entry.key);
        if (name === "")
            continue;
        const parts = entry.value.replace(/\\:/gu, ":").split(":");
        if (parts.length < 3)
            continue;
        const parsed = parseNvicValue(entry.value);
        out.push({ name, enabled: parsed.enabled, preempt: parsed.preempt, sub: parsed.sub });
    }
    out.sort((left, right) => {
        if (left.preempt !== right.preempt)
            return left.preempt - right.preempt;
        if (left.sub !== right.sub)
            return left.sub - right.sub;
        return left.name.localeCompare(right.name);
    });
    return out;
}
/** 读工程 .ioc 的中断表。没有 .ioc 或读不出来时返回错误文本，不抛。 */
export function readInterrupts(projectDir) {
    const dir = typeof projectDir === "string" ? projectDir.trim() : "";
    if (dir === "")
        return { ok: false, error: "projectDir 不能为空" };
    const iocPath = findIocPath(dir);
    if (iocPath === "")
        return { ok: false, error: "工程里没有 .ioc：先建工程，或确认 CubeMX 配置已保存" };
    let text = "";
    try {
        text = readFileSync(iocPath, "utf8");
    }
    catch (error) {
        return { ok: false, error: "读取 .ioc 失败：" + (error instanceof Error ? error.message : String(error)) };
    }
    const entries = collectInterrupts(parseIocEntries(text));
    return {
        ok: true,
        report: {
            iocPath,
            iocName: iocPath.slice(iocPath.lastIndexOf("\\") + 1),
            entries,
            enabledCount: entries.filter((entry) => entry.enabled).length,
        },
    };
}
