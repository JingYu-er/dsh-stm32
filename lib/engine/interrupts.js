/**
 * 中断表：从 .ioc 的 NVIC.* 键读出「哪些中断开着、抢占优先级与子优先级多少」。
 *
 * CubeMX 写下的值形如 `true\:0\:0\:false\:false\:true\:false\:false\:false`：
 * 第一段是 NVIC 使能，第二段抢占优先级，第三段子优先级，其余段与中断表无关，不解释。
 * 只读，不改 .ioc；排序按「抢占优先级 → 子优先级 → 名字」，与 CubeMX 的列表习惯一致。
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findIocPath } from "./pinout.js";
import { iocBackupDir, parseIocEntries } from "./ioc-diff.js";
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
/**
 * 改一路中断的抢占 / 子优先级（S43）。
 *
 * 只改 `NVIC.<name>_IRQn` 那一条的第二、三段，其余段与文件其余字节原样保留；
 * 写之前备份到 `<工程>/.dsh-stm32/backups`。不跑 CubeMX，不改生成代码。
 */
export function setInterruptPriority(projectDir, name, preempt, sub) {
    const dir = projectDir.trim();
    if (dir === "")
        return { ok: false, error: "projectDir 不能为空" };
    const wanted = name.trim();
    if (wanted === "" || !/^[A-Za-z0-9_]+$/u.test(wanted))
        return { ok: false, error: "中断名只允许字母、数字与下划线：" + wanted };
    const range = (value) => Number.isInteger(value) && value >= 0 && value <= 15;
    if (!range(preempt))
        return { ok: false, error: "抢占优先级必须是 0–15 的整数（实际 " + String(preempt) + "）" };
    if (!range(sub))
        return { ok: false, error: "子优先级必须是 0–15 的整数（实际 " + String(sub) + "）" };
    const iocPath = findIocPath(dir);
    if (iocPath === "")
        return { ok: false, error: "工程目录里没有 .ioc：" + dir };
    let text;
    try {
        text = readFileSync(iocPath, "utf8");
    }
    catch (error) {
        return { ok: false, error: "读取 .ioc 失败：" + (error instanceof Error ? error.message : String(error)) };
    }
    const key = "NVIC." + wanted + "_IRQn";
    const lines = text.split(/\r?\n/u);
    let before = { preempt: -1, sub: -1 };
    let hit = false;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#"))
            continue;
        const eq = trimmed.indexOf("=");
        if (eq <= 0)
            continue;
        if (trimmed.slice(0, eq).trim() !== key)
            continue;
        const raw = trimmed.slice(eq + 1).trim();
        // `.ioc` 里冒号被转义成 `\:`，按转义分隔符切段再拼回去。
        const parts = raw.split("\\:");
        if (parts.length < 3)
            return { ok: false, error: "这一条 NVIC 值段数不足，无法安全改写：" + key };
        before = parseNvicValue(raw);
        parts[1] = String(preempt);
        parts[2] = String(sub);
        const indent = line.slice(0, line.indexOf(trimmed));
        lines[index] = indent + key + "=" + parts.join("\\:");
        hit = true;
        break;
    }
    if (!hit)
        return { ok: false, error: "工程 .ioc 里没有这一路中断：" + key };
    const nextText = lines.join("\n");
    const backupPath = join(iocBackupDir(dir), "ioc-" + new Date().toISOString().replace(/[:.]/gu, "-") + ".ioc");
    try {
        mkdirSync(iocBackupDir(dir), { recursive: true });
        copyFileSync(iocPath, backupPath);
        writeFileSync(iocPath, nextText, "utf8");
    }
    catch (error) {
        return { ok: false, error: "写回 .ioc 失败：" + (error instanceof Error ? error.message : String(error)) };
    }
    return {
        ok: true,
        report: {
            iocPath: iocPath,
            name: wanted,
            key: key,
            before: before,
            after: { preempt: preempt, sub: sub },
            backupPath: backupPath,
            changed: before.preempt !== preempt || before.sub !== sub,
        },
    };
}
