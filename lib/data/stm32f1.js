/**
 * L1：STM32F1 型号 → 芯片事实（容量档 / 启动文件 / 设备宏 / 设备头 / Flash / RAM / 引脚数）。
 *
 * 这里只剩**解析逻辑**，没有事实：事实全部来自资源包缓存里的 device/f1/chips.json，
 * 经 src/data/device-facts.ts 读入（用户 2026-10-31「内置表删了吧」的决定）。
 * 所以本文件不再有 F1_LINES / GROUP_BY_LETTER / FLASH_BY_LETTER / RAM_BY_LINE_LETTER
 * 这类表——加一款芯片只改资源仓库的 scripts/build-assets.mjs，插件一个字都不用动。
 *
 * 支持三种输入（与 0.2 一致，调用方不用改）：
 *   - 完整型号：STM32F103C8T6 / STM32F103RCT6 / STM32F107VCT6
 *   - 去掉温度后缀：STM32F103C8（按 chips.json 里同前缀的唯一一颗归一化）
 *   - 显式容量档：F103:xb（脚本与 cmsis 缓存 id 用；取该档在资源包里的一个代表型号）
 *
 * 认不出时返回 chip: null + 人话原因，绝不编一个不存在的启动文件。
 * 没装资源包时同样返回 chip: null，原因里带「先跑 stm32_assets refresh，或检查网络」。
 */
import { DEVICE_FACTS_HINT, loadDeviceFacts } from "./device-facts.js";
/** 完整型号：STM32F103RCT6 → line 103 / 封装 R / 容量 C / 后缀 T / 温度 6。 */
const CPN_PATTERN = /^STM32F(\d{3})([A-Z])([0-9A-G])([A-Z])?([0-9])?$/u;
/** 容量档写法：F103:xb（脚本、cmsis 缓存 id 用）。 */
const GROUP_PATTERN = /^F(\d{2,3}):(X[0-9A-Z]{1,2})$/u;
/**
 * 型号 → 芯片事实。认不出返回 chip: null + 原因，绝不编一个不存在的启动文件。
 */
export function resolveF1Chip(input) {
    const text = input.trim().toUpperCase();
    if (text.length === 0)
        return { chip: null, reason: "没有给型号" };
    const facts = loadDeviceFacts();
    if (!facts.ok)
        return { chip: null, reason: facts.error };
    const loose = GROUP_PATTERN.exec(text);
    if (loose !== null) {
        const code = loose[1] ?? "";
        const group = (loose[2] ?? "").toLowerCase();
        if (!facts.lines.includes(code))
            return { chip: null, reason: lineMissing(facts, code) };
        const fact = facts.byLineGroup.get(code + ":" + group);
        if (fact === undefined)
            return { chip: null, reason: groupMissing(facts, code, group) };
        return { chip: chipFromFact(fact), reason: "" };
    }
    const m = CPN_PATTERN.exec(text);
    if (m === null)
        return { chip: null, reason: "不是 F1 的型号格式：" + input };
    const code = m[1] ?? "";
    const suffix = m[4] ?? "";
    const extra = m[5] ?? "";
    if (suffix.length > 0 && !"TXUYK".includes(suffix)) {
        return { chip: null, reason: "认不出封装后缀 " + suffix + "（期望 T/U/Y 之一）：" + input };
    }
    if (extra.length > 0 && !"67".includes(extra)) {
        return { chip: null, reason: "认不出温度档 " + extra + "（期望 6 或 7）：" + input };
    }
    if (!facts.lines.includes(code))
        return { chip: null, reason: lineMissing(facts, code) };
    const fact = matchFact(facts, text);
    if (fact === null) {
        return { chip: null, reason: unknownChip(facts, text, code, m[3] ?? "") };
    }
    return { chip: chipFromFact(fact), reason: "" };
}
/**
 * 型号 → 资源包里的那颗。先精确匹配 cpn；没有再按「cpn 以输入开头」归一化
 * （STM32F103C8 → STM32F103C8T6，即用户省略了温度后缀）。
 * 多命中时取 cpn 最短、再按字典序——同一份事实永远给同一个结果。
 */
function matchFact(facts, text) {
    const exact = facts.byCpn.get(text);
    if (exact !== undefined)
        return exact;
    const candidates = facts.chips.filter((chip) => chip.cpn.startsWith(text));
    if (candidates.length === 0)
        return null;
    candidates.sort((left, right) => {
        if (left.cpn.length !== right.cpn.length)
            return left.cpn.length - right.cpn.length;
        return left.cpn < right.cpn ? -1 : left.cpn > right.cpn ? 1 : 0;
    });
    return candidates[0] ?? null;
}
function lineMissing(facts, code) {
    return ("F1 里没有 F" + code + " 这一 line（资源包已知：" + facts.lines.join("/") + "）；" + DEVICE_FACTS_HINT + "，看有没有新版资源包。");
}
function groupMissing(facts, code, group) {
    const groups = facts.groupsByLine.get(code) ?? [];
    return ("STM32F" + code + " 没有 " + group + " 这一容量档（资源包里的档位：" + groups.join("/") + "）；" +
        DEVICE_FACTS_HINT + "，看有没有新版资源包。");
}
/**
 * 格式对、line 在，但资源包里没有这一颗。
 * 分两种情况说清楚，别把「没收录」说成「不存在」：
 *   · 这个容量档在资源包里有，只是没有这个封装/温度后缀的组合（例如 C8T7）；
 *   · 这个容量档根本没收录（上游 CubeMX 没给出这档的 RAM/Flash，或者资源包还没覆盖，例如 F100RCT6）。
 */
function unknownChip(facts, text, code, densityLetter) {
    const groups = facts.groupsByLine.get(code) ?? [];
    const direct = "x" + densityLetter.toLowerCase();
    const inGroup = groups.includes(direct);
    const detail = inGroup
        ? "这一容量档在，但没有「封装 + 温度后缀」正好是这串的组合"
        : "这一档没有收录（上游没给这档的 RAM/Flash，或资源包还没覆盖）";
    return ("资源包（" + (facts.version === "" ? "未知版本" : facts.version) + "）里没有 " + text + " 这一颗：" +
        "STM32F" + code + " 收录了 " + groups.join("/") + " 容量档；" + detail + "；" +
        DEVICE_FACTS_HINT + "，看有没有新版资源包，或换一颗同档的常见型号（资源包共 " + String(facts.chips.length) + " 颗）。");
}
function chipFromFact(fact) {
    const lineMatch = /^STM32F(\d{3})/u.exec(fact.cpn);
    const densityMatch = /^STM32F\d{3}[A-Z]([0-9A-G])/u.exec(fact.cpn);
    return {
        cpn: fact.cpn,
        prefix: lineMatch === null ? "STM32F" + fact.line : "STM32F" + (lineMatch[1] ?? fact.line),
        densityLetter: densityMatch?.[1] ?? fact.group.slice(1).toUpperCase(),
        group: fact.group,
        startup: fact.startup,
        deviceDefine: fact.deviceDefine,
        deviceHeader: fact.deviceHeader,
        pinCount: fact.pinCount,
        flashBytes: fact.flashBytes,
        ramBytes: fact.ramBytes,
        notes: [],
    };
}
/** 该 line 的全部容量档（去重升序；给「这个型号能选哪些档」的报告用）。 */
export function f1GroupsFor(code) {
    const facts = loadDeviceFacts();
    if (!facts.ok)
        return [];
    return facts.groupsByLine.get(code.trim()) ?? [];
}
