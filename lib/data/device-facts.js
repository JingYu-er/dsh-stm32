/**
 * L1：设备事实（device facts）——唯一来源是本地内置资源里的 device/f1/chips.json。
 *
 * 用户 2026-10-31 的决定（原话「内置表删了吧」）：插件不再自带任何手写芯片事实表。型号 → 容量档 /
 * 启动文件 / 设备宏 / 设备头 / Flash / RAM / 引脚数，全部取自随插件包发布的 assets/device/<族>/chips.json
 * （flat 布局，2026-11 起不再走独立资源仓与联网下载）。
 *
 * 读不到怎么办：工具层调 ensureAssets()（src/engine/assets.ts）做本地完整性检查；
 * 缺文件只可能是插件安装不完整——明说「重装插件后重试（stm32_assets verify 可定位缺件）」，不猜也不内置第二份事实。
 *
 * 为什么要内存缓存：resolveF1Chip 在一个工程里会被调几十次（校验 .ioc、渲染启动文件名、选时钟），
 * 每次都读一遍 JSON 太浪费。缓存键带 path + size + mtimeMs：资源升级/重装/手改后自动失效，
 * 不需要任何 reset 钩子（也没有全局状态需要维护）。
 *
 * 只读：本文件不写盘、不联网、不起进程。
 */
import fs from "node:fs";
import path from "node:path";
import { ASSETS_DEVICE_FACTS_FILE, ASSETS_REFRESH_HINT, errText, readLocalManifest } from "../engine/assets.js";
import { familyIdOfPart, familyProfileOf } from "./family.js";
/** chips.json 在内置资源里的相对路径（manifest 的 profiles.core 也按 device/** 收录它）。 */
export const DEVICE_FACTS_REL = ASSETS_DEVICE_FACTS_FILE;
/** 没缓存/没这颗芯片时，给用户的那句可执行提示（所有结构化错误都带上它）。 */
export const DEVICE_FACTS_HINT = ASSETS_REFRESH_HINT;
/** 每个族的 chips.json 各缓存一份（键里带 path:size:mtimeMs）。 */
const cache = new Map();
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
 * 只给 line + group 时按上游命名规则补出三样名字（启动文件 / 设备宏 / 设备头）+ 链接脚本名。
 *
 * 规则不是猜的：group（x6/xb/xe/xg/xc…）本来就是从固件包
 *   Drivers/CMSIS/Device/ST/STM32F1xx/Source/Templates/gcc/startup_stm32f1<line><group>.s
 *   Drivers/CMSIS/Device/ST/STM32F1xx/Include/stm32f1<line><group>.h
 * 的文件名反推出来的，group 合法时名字唯一。
 *
 * 内置资源 v2026.11.x 起 chips.json 只留 db/mcu 能算出来的 9 个字段
 * （cpn/line/group/packageName/pinCount/flashBytes/ramBytes/deviceId/mcuName），这三样由这里现补；
 * 老版本资源（v2026.10.31-1 及更早）自带显式字段，优先用包里的 —— 新插件读老缓存照样能用。
 */
export function namingFrom(line, group, deviceId) {
    // line 三到四字符且可能带字母（L4+ 的 4P5、WBA 的 BA50 —— startup_stm32wba50xx.s）；group 两种形态：按容量（x6/xb/xx）或按封装（cx/rx/tx）。
    if (!/^[0-9A-Z]{3,4}$/u.test(line) || !/^(?:x[0-9a-z]|[0-9a-z]x)$/u.test(group)) {
        return { startup: "", deviceDefine: "", deviceHeader: "", linkerScript: "" };
    }
    // 族字母从型号名里取（STM32F103C8Tx → F；STM32L4P5AGIx → L），不写死 F。
    const letter = /^STM32([A-Z])/u.exec(deviceId)?.[1] ?? "F";
    // 文件名全小写：L4+ 的 line 是 4P5（带字母），固件包里那份叫 startup_stm32l4p5xx.s。
    const lowerLine = line.toLowerCase();
    return {
        startup: "startup_stm32" + letter.toLowerCase() + lowerLine + group + ".s",
        deviceDefine: "STM32" + letter + line + defineSuffix(group),
        deviceHeader: "stm32" + letter.toLowerCase() + lowerLine + group + ".h",
        linkerScript: deviceId === "" ? "" : deviceId + "_FLASH.ld",
    };
}
/**
 * 启动文件尾缀 → 设备宏尾缀（大写的是「不是 x 的那个字符」，x 永远小写）：
 *   xb → xB（STM32F103xB）、xx → xx（STM32F407xx）、cx → Cx（STM32F410Cx，按封装分档那种）。
 * 与资源脚本 scripts/family-assets.mjs 的 defineSuffix 必须逐字一致。
 */
export function defineSuffix(group) {
    if (group === "xx")
        return "xx";
    if (group.charAt(0) === "x")
        return "x" + group.charAt(1).toUpperCase();
    return group.charAt(0).toUpperCase() + group.charAt(1);
}
/**
 * 一条 chips.json 记录 → DeviceFactsChip。
 * 关键字段（cpn / line / group / Flash / RAM / 引脚数）缺一个就丢掉：
 * 半条事实比没有事实更危险——它会算出错误的链接脚本内存布局。
 * 启动文件 / 设备宏 / 设备头 缺失时按 line + group 现算（见 namingFrom）。
 */
function chipFrom(value) {
    if (!isRecord(value))
        return null;
    const cpn = textOf(value["cpn"]).toUpperCase();
    const line = textOf(value["line"]);
    const group = textOf(value["group"]).toLowerCase();
    const deviceId = textOf(value["deviceId"]);
    const derived = namingFrom(line, group, deviceId);
    const startup = textOf(value["startup"]) || derived.startup;
    const deviceDefine = textOf(value["deviceDefine"]) || derived.deviceDefine;
    const deviceHeader = textOf(value["deviceHeader"]) || derived.deviceHeader;
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
        deviceId,
        mcuName: textOf(value["mcuName"]),
        startup,
        deviceDefine,
        deviceHeader,
        linkerScript: textOf(value["linkerScript"]) || derived.linkerScript,
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
 * env 默认 process.env：DSH_STM32_ASSETS 可以覆盖内置资源根目录（测试与自定义安装用）。
 * 读不到不抛——返回 ok:false + 人话，让调用方（工具卡片）照常渲染。
 */
export function loadDeviceFacts(env = process.env) {
    return loadFamilyDeviceFacts("STM32F1", env);
}
/**
 * 族 id → 内置资源里的设备事实相对路径：STM32F1 → device/f1/chips.json；
 * STM32L4+ → device/l4+/chips.json；STM32WBA → device/wba/chips.json。
 *
 * 目录名取族画像的族段（小写、保留 +）—— 资源脚本就是这么建的目录。
 * 不能按「前两个字符」推：WBA 会被推成 wb、L4+ 会被推成 l4（都是别的族，读到的芯片表是错的）。
 */
export function familyFactsRelOf(familyId) {
    const raw = familyId.trim().toUpperCase();
    const line = familyProfileOf(raw).line.toLowerCase();
    if (!/^[a-z0-9]{1,3}\+?$/u.test(line))
        return ASSETS_DEVICE_FACTS_FILE;
    return "device/" + line + "/chips.json";
}
/**
 * 按族读设备事实（内存缓存一次，按 path+size+mtimeMs 自动失效）。
 *
 * 为什么要按族分文件：资源脚本按族生成 device/<族>/chips.json（F0/F4/G4/L0/C0…），
 * 合成一个大文件会让「装了这个族但没装那个族」这件事看不出来，也没法只更新一个族。
 */
export function loadFamilyDeviceFacts(familyId, env = process.env) {
    const rel = familyFactsRelOf(familyId);
    const state = readLocalManifest(env);
    const filePath = state.versionDir === "" ? path.join(state.root, ...rel.split("/")) : path.join(state.versionDir, ...rel.split("/"));
    if (state.versionDir === "") {
        return emptyFacts(filePath, "", (state.error === "" ? "找不到插件内置资源" : state.error) + "；设备事实只从内置资源读，" + DEVICE_FACTS_HINT + "。");
    }
    let stat;
    try {
        stat = fs.statSync(filePath);
    }
    catch {
        return emptyFacts(filePath, state.version, "内置资源 " + state.version + " 里没有 " + rel + "（" + filePath + "）：这一版内置资源不含 " + familyId + " 的芯片表；" + DEVICE_FACTS_HINT + "。");
    }
    const key = filePath + ":" + String(stat.size) + ":" + String(stat.mtimeMs);
    const hit = cache.get(filePath);
    if (hit !== undefined && hit.key === key)
        return hit.facts;
    let text;
    try {
        text = fs.readFileSync(filePath, "utf8");
    }
    catch (error) {
        return emptyFacts(filePath, state.version, "设备事实读不了（" + filePath + "）：" + errText(error) + "；" + DEVICE_FACTS_HINT + "。");
    }
    const facts = parseDeviceFacts(text, filePath, state.version);
    cache.set(filePath, { key, facts });
    return facts;
}
/** 型号 → 事实；没有这颗（或没有缓存）返回 null。cpn 大小写不敏感。 */
export function findChipFact(cpn, env = process.env) {
    const wanted = cpn.trim().toUpperCase();
    if (wanted === "")
        return null;
    const familyId = familyIdOfPart(wanted);
    const facts = familyId === "" ? loadDeviceFacts(env) : loadFamilyDeviceFacts(familyId, env);
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
    const familyId = familyIdOfPart(wanted);
    const facts = familyId === "" ? loadDeviceFacts(env) : loadFamilyDeviceFacts(familyId, env);
    const label = familyId === "" ? "" : familyProfileOf(familyId).id + " ";
    if (!facts.ok)
        throw new DeviceFactError("facts-missing", label + facts.error, wanted);
    const found = facts.byCpn.get(wanted);
    if (found === undefined) {
        throw new DeviceFactError("chip-unknown", label + "内置资源（" + facts.version + "）里没有 " + (wanted === "" ? "(空型号)" : wanted) + " 这颗芯片：" +
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
