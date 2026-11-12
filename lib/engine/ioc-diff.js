/**
 * .ioc 基线对比：把当前 CubeMX 配置与上一次手动记下的基线逐键比较。
 *
 * 为什么不看 git：工程可以不在版本库里，也可能是别人的机器；基线要能随手记、
 * 随手比，所以单独存一份到用户目录，按工程路径分文件。
 *
 * 只读工程文件、只写自己的基线目录；不跑 CubeMX，也不改 .ioc。
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { findIocPath } from "./pinout.js";
/** 基线目录：默认 `~/.dsh-stm32/ioc-snapshots`，可用 DSH_STM32_SNAPSHOTS 覆盖。 */
export function snapshotRoot(env = process.env) {
    const custom = env.DSH_STM32_SNAPSHOTS;
    if (typeof custom === "string" && custom.trim() !== "")
        return resolve(custom.trim());
    return join(homedir(), ".dsh-stm32", "ioc-snapshots");
}
/** 一个工程一份基线，文件名取工程绝对路径的短哈希，换机器不冲突。 */
export function snapshotPath(projectDir, env = process.env) {
    const digest = createHash("sha256").update(resolve(projectDir)).digest("hex").slice(0, 16);
    return join(snapshotRoot(env), digest + ".ioc");
}
/**
 * 解析 .ioc：只收第一个 `=` 前的键与之后的值。
 * 注释行、空行、没有 `=` 的行都跳过——CubeMX 版本之间会插入说明行。
 */
export function parseIocEntries(text) {
    const out = [];
    const seen = new Set();
    for (const line of text.split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#"))
            continue;
        const index = trimmed.indexOf("=");
        if (index <= 0)
            continue;
        const key = trimmed.slice(0, index).trim();
        const value = trimmed.slice(index + 1).trim();
        if (key === "" || seen.has(key))
            continue;
        seen.add(key);
        out.push({ key, value });
    }
    return out;
}
/** 逐键比较：新增、删除、值变化各列一张表，按 key 排序，输出稳定。 */
export function diffIocEntries(before, after) {
    const beforeMap = new Map(before.map((entry) => [entry.key, entry.value]));
    const afterMap = new Map(after.map((entry) => [entry.key, entry.value]));
    const added = [];
    const removed = [];
    const changed = [];
    for (const [key, value] of afterMap) {
        if (!beforeMap.has(key))
            added.push({ key, value });
        else if (beforeMap.get(key) !== value)
            changed.push({ key, before: beforeMap.get(key) ?? "", after: value });
    }
    for (const [key, value] of beforeMap) {
        if (!afterMap.has(key))
            removed.push({ key, value });
    }
    const byKey = (left, right) => left.key.localeCompare(right.key);
    added.sort(byKey);
    removed.sort(byKey);
    changed.sort(byKey);
    return { added, removed, changed };
}
/** 把当前 .ioc 记为基线。已有基线直接覆盖，不留历史版本。 */
export function saveIocSnapshot(projectDir, env = process.env) {
    const dir = projectDir.trim();
    if (dir === "")
        return { ok: false, error: "projectDir 不能为空" };
    const iocPath = findIocPath(dir);
    if (iocPath === "")
        return { ok: false, error: "工程目录里没有 .ioc：" + dir };
    const target = snapshotPath(dir, env);
    try {
        mkdirSync(snapshotRoot(env), { recursive: true });
        copyFileSync(iocPath, target);
        const text = readFileSync(iocPath, "utf8");
        return {
            ok: true,
            report: {
                iocPath: iocPath,
                snapshotPath: target,
                savedAt: new Date().toISOString(),
                entries: parseIocEntries(text).length,
            },
        };
    }
    catch (error) {
        return { ok: false, error: "记录基线失败：" + (error instanceof Error ? error.message : String(error)) };
    }
}
/** 读当前 .ioc 与基线的差异；没有基线时 hasSnapshot=false，其余为空。 */
export function readIocDiff(projectDir, env = process.env) {
    const dir = projectDir.trim();
    if (dir === "")
        return { ok: false, error: "projectDir 不能为空" };
    const iocPath = findIocPath(dir);
    if (iocPath === "")
        return { ok: false, error: "工程目录里没有 .ioc：" + dir };
    let currentText;
    try {
        currentText = readFileSync(iocPath, "utf8");
    }
    catch (error) {
        return { ok: false, error: "读取 .ioc 失败：" + (error instanceof Error ? error.message : String(error)) };
    }
    const target = snapshotPath(dir, env);
    const empty = {
        iocPath: iocPath,
        iocName: basename(iocPath),
        snapshotPath: target,
        hasSnapshot: false,
        savedAt: "",
        added: [],
        removed: [],
        changed: [],
        counts: { added: 0, removed: 0, changed: 0, total: 0 },
        notes: [],
    };
    if (!existsSync(target)) {
        return { ok: true, report: { ...empty, notes: ["还没有基线：点「记下当前配置」后才有可比较的版本。"] } };
    }
    let beforeText;
    try {
        beforeText = readFileSync(target, "utf8");
    }
    catch (error) {
        return {
            ok: true,
            report: { ...empty, notes: ["基线文件读不出来：" + (error instanceof Error ? error.message : String(error))] },
        };
    }
    const diff = diffIocEntries(parseIocEntries(beforeText), parseIocEntries(currentText));
    let savedAt = "";
    try {
        savedAt = new Date(statSync(target).mtimeMs).toISOString();
    }
    catch {
        savedAt = "";
    }
    return {
        ok: true,
        report: {
            iocPath: iocPath,
            iocName: basename(iocPath),
            snapshotPath: target,
            hasSnapshot: true,
            savedAt: savedAt,
            added: diff.added,
            removed: diff.removed,
            changed: diff.changed,
            counts: {
                added: diff.added.length,
                removed: diff.removed.length,
                changed: diff.changed.length,
                total: diff.added.length + diff.removed.length + diff.changed.length,
            },
            notes: [],
        },
    };
}
