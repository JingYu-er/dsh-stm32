/**
 * rm-topics（主题/锚点清单）的两层装载。
 *
 * 为什么要有「spec」这层：机器是阅卷人不是出题人——自动抽取必须有人（或踩过坑后的会话）
 * 给出「要采信哪几条结论 + 在 RM 里逐字回查什么」，机器才能核验并落 semantics。
 *
 * 装载顺序（两层合并，同 id 用户赢）：
 *   1) 插件自带的族级 spec：lib/data/rm-topics/<族>.json（源在 src/data/rm-topics/，
 *      随包发布；scripts/copy-data.mjs 负责进 lib）。
 *   2) 用户芯片级 spec：<factsRoot>/topics/<族>/<线>.json——只覆盖手上这颗。
 *      用户踩了坑（比如某条选项字节规则害得板子连不上），把「这条结论 + 回查锚点」
 *      写成一份小 JSON 放进这里，这颗芯片下一次烧录前就必须过机检；没写过的其它
 *      芯片不受影响（族级判据太粗，坑通常是芯片级的，见 2026-11-07 决定）。
 *
 * 判定「这颗芯片要不要过机检」= 合并后主题数 > 0。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const EMPTY = { topics: [], lines: [], docId: "", origins: [], hasSpec: false };
function normalize(raw, fallbackLines) {
    if (typeof raw !== "object" || raw === null)
        return null;
    const o = raw;
    if (!Array.isArray(o.topics) || o.topics.length === 0)
        return null;
    const topics = o.topics.filter((x) => {
        if (typeof x !== "object" || x === null)
            return false;
        const e = x;
        return typeof e.id === "string" && Array.isArray(e.anchors) && e.anchors.length > 0;
    });
    if (topics.length === 0)
        return null;
    const lines = Array.isArray(o.lines) ? o.lines.map((x) => String(x).toUpperCase()) : fallbackLines;
    const docId = typeof o.doc?.id === "string" ? o.doc.id : "";
    return { topics, lines, docId };
}
function readJson(file) {
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    }
    catch {
        return null;
    }
}
/**
 * 插件自带族级 spec 的目录：lib/data/rm-topics/（JSON 不进 tsc，由
 * scripts/copy-data.mjs 在 build 时复制；仓库里 lib/ 是入库的，装包侧也带）。
 * 没有退回 src 的兜底：那条相对路径在插件真实安装位置（node_modules 深处）
 * 基本不可能存在，留着只会把「没跑 copy-data」伪装成「清单在但读不到」。
 */
export function bundledTopicsDir() {
    return fileURLToPath(new URL("./rm-topics/", import.meta.url));
}
/** 用户芯片级 spec 的路径（暴露给用户/会话往里放）。 */
export function userTopicsPath(factsRoot, family, line) {
    return join(factsRoot, "topics", family.toLowerCase(), line.toUpperCase() + ".json");
}
/**
 * 两层合并装载。factsRoot 由调用方传入（engine/facts 的 factsRoot(env)），
 * 本模块不 import engine——data 层保持无环。
 */
export function loadRmTopics(family, line, factsRoot) {
    const fam = family.toLowerCase();
    const ln = line.toUpperCase();
    const merged = new Map();
    const lines = new Set();
    const origins = [];
    let docId = "";
    const famFile = join(bundledTopicsDir(), fam + ".json");
    if (existsSync(famFile)) {
        const n = normalize(readJson(famFile), []);
        if (n !== null) {
            for (const tp of n.topics)
                merged.set(tp.id, tp);
            for (const l of n.lines)
                lines.add(l);
            docId = n.docId;
            origins.push("bundled:" + famFile);
        }
    }
    const userFile = userTopicsPath(factsRoot, fam, ln);
    if (existsSync(userFile)) {
        const n = normalize(readJson(userFile), [ln]);
        if (n !== null) {
            for (const tp of n.topics)
                merged.set(tp.id, tp); // 同 id 用户赢
            for (const l of n.lines)
                lines.add(l);
            if (docId === "")
                docId = n.docId;
            origins.push("user:" + userFile);
        }
    }
    const topics = [...merged.values()];
    if (topics.length === 0)
        return EMPTY;
    // 用户 spec 没写 lines 时只管自己这颗（fallbackLines 兜底）；族级有 lines 尊重族级
    if (lines.size === 0)
        lines.add(ln);
    return { topics, lines: [...lines].sort(), docId, origins, hasSpec: true };
}
