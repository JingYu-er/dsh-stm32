/**
 * L1：设备事实（device facts）——唯一来源是本地资源包缓存里的 device/f1/chips.json。
 *
 * 用户 2026-10-31 的决定（原话「内置表删了吧」）：插件不再自带任何芯片事实表。型号 → 容量档 /
 * 启动文件 / 设备宏 / 设备头 / Flash / RAM / 引脚数，全部取自资源仓库 dsh-stm32-assets 的
 * device/f1/chips.json，装到 <DSH_STM32_ASSETS 根或 ~/.dsh-stm32/assets>/<version>/device/f1/chips.json。
 *
 * 第一次用没有缓存怎么办：工具层调 ensureAssets()（src/engine/assets.ts）自动 refresh 一次；
 * 没网、没装就只能明说「先跑 stm32_assets refresh，或检查网络」，绝不退回内置表（已经没有内置表了）。
 *
 * 为什么要内存缓存：resolveF1Chip 在一个工程里会被调几十次（校验 .ioc、渲染启动文件名、选时钟），
 * 每次都读一遍 JSON 太浪费。缓存键带 path + size + mtimeMs：资源包升级/重装/手改后自动失效，
 * 不需要任何 reset 钩子（也没有全局状态需要维护）。
 *
 * 只读：本文件不写盘、不联网、不起进程。
 */
import fs from "node:fs";
import path from "node:path";
import { ASSETS_DEVICE_FACTS_FILE, ASSETS_REFRESH_HINT, errText, readLocalManifest } from "../engine/assets.js";
/** chips.json 在资源包里的相对路径（manifest 的 profiles.core 也按 device/** 收录它）。 */
export const DEVICE_FACTS_REL = ASSETS_DEVICE_FACTS_FILE;
/** 没缓存/没这颗芯片时，给用户的那句可执行提示（所有结构化错误都带上它）。 */
export const DEVICE_FACTS_HINT = ASSETS_REFRESH_HINT;
let cache = null;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function textOf(value) {
    return typeof value === "string" ? value.trim() : "";
}
function countOf(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
/**
 * 一条 chips.json 记录 → DeviceFactsChip。
 * 关键字段（cpn / line / group / 启动文件 / 设备宏 / 设备头 / Flash / RAM / 引脚数）缺一个就丢掉：
 * 半条事实比没有事实更危险——它会算出错误的链接脚本内存布局。
 */
function chipFrom(value) {
    if (!isRecord(value))
        return null;
    const cpn = textOf(value["cpn"]).toUpperCase();
    const line = textOf(value["line"]);
    const group = textOf(value["group"]).toLowerCase();
    const startup = textOf(value["startup"]);
    const deviceDefine = textOf(value["deviceDefine"]);
    const deviceHeader = textOf(value["deviceHeader"]);
    const pinCount = countOf(value["pinCount"]);
    const flashBytes = countOf(value["flashBytes"]);
    const ramBytes = countOf(value["ramBytes"]);
    // B4：断点预算（可选字段，chips.json 没写就是没有，调用方回退 F1 默认）。
    const breakpoints = countOf(value["breakpoints"]);
    const watchpoints = countOf(value["watchpoints"]);
    if (cpn === "" || line === "" || group === "" || startup === "" || deviceDefine === "" || deviceHeader === "")
        return null;
    if (pinCount === null || flashBytes === null || ramBytes === null)
        return null;
    return {
        cpn,
        line,
        group,
        packageName: textOf(value["packageName"]),
        pinCount,
        flashBytes,
        ramBytes,
        deviceId: textOf(value["deviceId"]),
        mcuName: textOf(value["mcuName"]),
        startup,
        deviceDefine,
        deviceHeader,
        linkerScript: textOf(value["linkerScript"]),
        ...(breakpoints === null || breakpoints <= 0 ? {} : { breakpoints: Math.trunc(breakpoints) }),
        ...(watchpoints === null || watchpoints <= 0 ? {} : { watchpoints: Math.trunc(watchpoints) }),
    };
}
function emptyFacts(filePath, version, error) {
    return {
        ok: false,
        path: filePath,
        version,
        chips: [],
        byCpn: new Map(),
        byLineGroup: new Map(),
        lines: [],
        groupsByLine: new Map(),
        error,
    };
}
/** 解析 chips.json 文本 → DeviceFacts（纯函数，测试可直接喂字符串）。 */
export function parseDeviceFacts(text, filePath, version = "") {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        return emptyFacts(filePath, version, "本地设备事实不是合法 JSON（" + filePath + "）：" + errText(error) + "；" + DEVICE_FACTS_HINT + "。");
    }
    const list = isRecord(parsed) && Array.isArray(parsed["chips"]) ? parsed["chips"] : [];
    const chips = [];
    const byCpn = new Map();
    const byLineGroup = new Map();
    const groupsByLine = new Map();
    for (const item of list) {
        const chip = chipFrom(item);
        if (chip === null)
            continue;
        chips.push(chip);
        if (!byCpn.has(chip.cpn))
            byCpn.set(chip.cpn, chip);
        const lineGroup = chip.line + ":" + chip.group;
        // 同一个 line+档 有多颗芯片（F103C8T6 / F103RBT6 / ...），只留一颗当代表：
        // cpn 最小的那颗，保证「同一份事实同一个结果」，不随文件顺序变。
        const existing = byLineGroup.get(lineGroup);
        if (existing === undefined || chip.cpn < existing.cpn)
            byLineGroup.set(lineGroup, chip);
        const groups = groupsByLine.get(chip.line) ?? new Set();
        groups.add(chip.group);
        groupsByLine.set(chip.line, groups);
    }
    const lines = [...groupsByLine.keys()].sort((left, right) => left.localeCompare(right));
    const sortedGroups = new Map();
    for (const [line, groups] of groupsByLine) {
        sortedGroups.set(line, [...groups].sort((left, right) => left.localeCompare(right)));
    }
    if (chips.length === 0) {
        return emptyFacts(filePath, version, "本地设备事实里一条可用的芯片都没有（" + filePath + "）：文件可能是空的或字段不全；" + DEVICE_FACTS_HINT + "。");
    }
    return { ok: true, path: filePath, version, chips, byCpn, byLineGroup, lines, groupsByLine: sortedGroups, error: "" };
}
/**
 * 读设备事实（内存缓存一次，按 path+size+mtimeMs 自动失效）。
 *
 * env 默认 process.env：DSH_STM32_ASSETS 可以覆盖资源包根目录（测试与自定义安装用）。
 * 读不到不抛——返回 ok:false + 人话，让调用方（工具卡片）照常渲染。
 */
export function loadDeviceFacts(env = process.env) {
    const state = readLocalManifest(env);
    const filePath = state.versionDir === "" ? path.join(state.root, "device", "f1", "chips.json") : path.join(state.versionDir, DEVICE_FACTS_REL);
    if (state.versionDir === "") {
        return emptyFacts(filePath, "", (state.error === "" ? "本地还没装资源包" : state.error) + "；设备事实只从资源包缓存读，" + DEVICE_FACTS_HINT + "。");
    }
    let stat;
    try {
        stat = fs.statSync(filePath);
    }
    catch {
        return emptyFacts(filePath, state.version, "资源包 " + state.version + " 里没有 " + DEVICE_FACTS_REL + "（" + filePath + "）：这一版资源包不全；" + DEVICE_FACTS_HINT + "。");
    }
    const key = filePath + ":" + String(stat.size) + ":" + String(stat.mtimeMs);
    if (cache !== null && cache.key === key)
        return cache.facts;
    let text;
    try {
        text = fs.readFileSync(filePath, "utf8");
    }
    catch (error) {
        return emptyFacts(filePath, state.version, "设备事实读不了（" + filePath + "）：" + errText(error) + "；" + DEVICE_FACTS_HINT + "。");
    }
    const facts = parseDeviceFacts(text, filePath, state.version);
    cache = { key, facts };
    return facts;
}
/** 型号 → 事实；没有这颗（或没有缓存）返回 null。cpn 大小写不敏感。 */
export function findChipFact(cpn, env = process.env) {
    const wanted = cpn.trim().toUpperCase();
    if (wanted === "")
        return null;
    const facts = loadDeviceFacts(env);
    return facts.ok ? facts.byCpn.get(wanted) ?? null : null;
}
export class DeviceFactError extends Error {
    code;
    cpn;
    constructor(code, message, cpn = "") {
        super(message);
        this.name = "DeviceFactError";
        this.code = code;
        this.cpn = cpn;
    }
}
/** 型号 → 事实；没有就抛 DeviceFactError（message 一定带 refresh 提示）。 */
export function requireChipFact(cpn, env = process.env) {
    const wanted = cpn.trim().toUpperCase();
    const facts = loadDeviceFacts(env);
    if (!facts.ok)
        throw new DeviceFactError("facts-missing", facts.error, wanted);
    const found = facts.byCpn.get(wanted);
    if (found === undefined) {
        throw new DeviceFactError("chip-unknown", "资源包（" + facts.version + "）里没有 " + (wanted === "" ? "(空型号)" : wanted) + " 这颗芯片：" +
            "已知 line " + (facts.lines.length === 0 ? "(无)" : facts.lines.join("/")) + "；" + DEVICE_FACTS_HINT + "。", wanted);
    }
    return found;
}
/**
 * 设备事实的来源（写进报告/错误文案）：读到缓存 → chips.json 的绝对路径；没有缓存 → "none"。
 * 想看版本用 loadDeviceFacts().version。
 */
export function deviceFactsSource(env = process.env) {
    const facts = loadDeviceFacts(env);
    return facts.ok ? facts.path : "none";
}
