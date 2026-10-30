/**
 * L1：SVD 寄存器表（device/f1/svd/<line>.json）——按名字找寄存器、按值解释位域。
 *
 * 为什么要这一层：regs_read 以前只认裸地址（0x4001100C），用户手里拿的是手册里的
 * "GPIOC_ODR" / "GPIOC.ODR"，读回来的 0x00000004 也没人告诉你那是 ODR2（PC2 输出高）。
 * SVD 里这些都有：外设 baseAddress + 寄存器 addressOffset + 字段 bitOffset/bitWidth。
 *
 * 数据来源只有一个：资源包 dsh-stm32-assets 的 device/f1/svd/<line>.json，装到
 * <DSH_STM32_ASSETS 根或 ~/.dsh-stm32/assets>/<version>/device/f1/svd/ 之后复用。
 * 兼容两种布局：
 *   · 装好的缓存：<root>/<version>/device/f1/svd/103.json（install.json 里有 version）；
 *   · 直接检出/自定义布局：<root>/device/f1/svd/103.json（开发时把 DSH_STM32_ASSETS 指到资源仓库）。
 *
 * 关键约定：
 *   · SVD 只在 profile=full 里。缺了不是"静默降级"，而是结构化失败 + 一句能照着敲的
 *     "stm32_assets refresh --profile full"（见 SVD_FULL_PROFILE_HINT）；
 *   · 读不到不抛：loadSvd() 返回 { device, failure }，loadSvdForLine() 复用前者的便捷版（返回 null）；
 *     只有"明确要一个寄存器/一段地址"的 API（resolveRegisterRef / describeAddress）才抛 SvdError，
 *     因为那时候没有数据就已经是错误，而不是"可选增强"；
 *   · 缓存键是 path+size+mtimeMs：资源包升级/重装/手改后自动失效，不需要 reset 钩子。
 *     单测靠 svdCacheStats() + resetSvdCache() 验证"命中不重复读盘"；
 *   · 严格解析：外设/寄存器/字段有任何一条不合法就整份拒绝（装错文件比没装更危险，
 *     半个位域表会解释出错误的位）。资源仓库的产物是脚本生成的，这份严格性目前一次都没误伤。
 *
 * 只读：本文件不写盘、不联网、不起进程，只读 fs + 内存缓存。
 */
import fs from "node:fs";
import path from "node:path";
import { assetsRootInfo, errText, listInstalledVersions } from "../engine/assets.js";
import { findChipFact } from "./device-facts.js";
/** SVD 在资源包里的目录（相对版本目录）。 */
export const SVD_REL_DIR = "device/f1/svd";
/**
 * 缺 SVD 时反复出现的那句提示。SVD 只在 profile=full 里，所以文案必须带
 * "stm32_assets refresh --profile full"——用户照着敲就能补齐，不用翻文档。
 */
export const SVD_FULL_PROFILE_HINT = "SVD 只在 profile=full 里：先跑 stm32_assets refresh --profile full";
/** 资源仓库当前发布的 F1 SVD（只用于报错文案，不做硬校验：上游加 line 不用改这里）。 */
export const SVD_KNOWN_LINES = ["100", "101", "102", "103", "105", "107"];
export class SvdError extends Error {
    code;
    line;
    ref;
    hint;
    constructor(code, message, options = {}) {
        super(message);
        this.name = "SvdError";
        this.code = code;
        this.line = options.line ?? "";
        this.ref = options.ref ?? "";
        this.hint = options.hint ?? "";
    }
}
/* ------------------------------ 小工具 ------------------------------ */
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function textOf(value) {
    return typeof value === "string" ? value.trim() : "";
}
function quote(value) {
    return value === "" ? "(空)" : JSON.stringify(value);
}
function isDirectory(dir) {
    try {
        return fs.statSync(dir).isDirectory();
    }
    catch {
        return false;
    }
}
/**
 * SVD 里的数值：资源包写的是十六进制字符串（"0x40011000" / "0x0C"），
 * 也接受数字与纯十进制字符串，别的都算坏数据。
 */
export function parseSvdNumber(value) {
    if (typeof value === "number")
        return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    if (trimmed === "")
        return null;
    if (/^0[xX][0-9a-fA-F]+$/u.test(trimmed))
        return parseInt(trimmed.slice(2), 16);
    if (/^[0-9]+$/u.test(trimmed))
        return parseInt(trimmed, 10);
    return null;
}
/**
 * 用户写的地址：必须带 0x（1–8 位十六进制），或者不带前缀但至少 5 位（"4001100C"）。
 * 为什么裸写要求 5 位：否则 "ADC1"/"DAC" 这种全是十六进制字符的外设名会被当成地址。
 */
export function parseAddressText(text) {
    const trimmed = text.trim();
    const prefixed = /^0[xX]([0-9a-fA-F]{1,8})$/u.exec(trimmed);
    if (prefixed !== null)
        return parseInt(prefixed[1] ?? "", 16) >>> 0;
    const bare = /^([0-9a-fA-F]{5,8})$/u.exec(trimmed);
    if (bare !== null)
        return parseInt(bare[1] ?? "", 16) >>> 0;
    return null;
}
/** 0x4001100C（8 位大写，跟 regs_read 的地址风格一致）。 */
export function formatAddress(value) {
    return "0x" + (value >>> 0).toString(16).toUpperCase().padStart(8, "0");
}
/** 0x0C / 0x4（寄存器偏移用最短形式，跟手册一致）。 */
export function formatOffset(value) {
    return "0x" + value.toString(16).toUpperCase();
}
/** 规范写法：外设名.寄存器名。 */
export function formatRegisterRef(resolved) {
    return resolved.peripheral + "." + resolved.register;
}
function maskOf(bitOffset, bitWidth) {
    const width = Math.min(Math.max(bitWidth, 0), 32);
    if (width === 0)
        return 0;
    if (width >= 32)
        return 0xFFFFFFFF;
    const mask = (2 ** width - 1) * 2 ** bitOffset;
    return mask > 0xFFFFFFFF ? 0xFFFFFFFF : mask;
}
function sizeMask(size) {
    if (!Number.isFinite(size) || size <= 0 || size >= 32)
        return 0xFFFFFFFF;
    return 2 ** size - 1;
}
function registerBytes(size) {
    return Math.max(1, Math.ceil((size > 0 ? size : 32) / 8));
}
/** 报错文案里点名候选，但不把 700 个寄存器全倒出来。 */
function listNames(names, limit = 24) {
    if (names.length === 0)
        return "(无)";
    const head = names.slice(0, limit).join("、");
    return names.length > limit ? head + " …（共 " + String(names.length) + " 个）" : head + "（共 " + String(names.length) + " 个）";
}
const svdCache = new Map();
const svdStats = { reads: 0, hits: 0 };
/** 缓存诊断：单测用它证明"第二次没再读盘"（reads 不涨、hits 涨）。 */
export function svdCacheStats() {
    return { reads: svdStats.reads, hits: svdStats.hits, entries: svdCache.size };
}
/** 清空 SVD 缓存与计数器（单测用；生产不需要，键自带失效）。 */
export function resetSvdCache() {
    svdCache.clear();
    svdStats.reads = 0;
    svdStats.hits = 0;
}
/**
 * 可能装着 SVD 的目录，按优先级：
 *   1. 已安装的资源包版本（新 → 旧，listInstalledVersions 已排好）；
 *   2. 未分版本的自定义布局（DSH_STM32_ASSETS 直接指到资源仓库/自建目录）。
 */
function svdLocations(env) {
    const out = [];
    const seen = new Set();
    for (const installed of listInstalledVersions(env)) {
        const resolved = path.resolve(installed.dir);
        if (seen.has(resolved))
            continue;
        seen.add(resolved);
        out.push({ dir: installed.dir, version: installed.version, profiles: installed.profiles, layout: "versioned" });
    }
    const root = assetsRootInfo(env).root;
    const flat = path.resolve(root);
    if (!seen.has(flat) && isDirectory(path.join(root, SVD_REL_DIR))) {
        out.push({ dir: root, version: "", profiles: [], layout: "flat" });
    }
    return out;
}
/* ------------------------------ 解析 ------------------------------ */
function failureOf(code, line, filePath, message) {
    return { code, line, path: filePath, message, hint: SVD_FULL_PROFILE_HINT };
}
function fieldFrom(value, where) {
    if (!isRecord(value))
        return { field: null, error: where + " 不是对象" };
    const name = textOf(value["name"]);
    if (name === "")
        return { field: null, error: where + " 缺 name" };
    const bitOffset = parseSvdNumber(value["bitOffset"]);
    if (bitOffset === null || bitOffset > 31)
        return { field: null, error: where + "（" + name + "）的 bitOffset 不合法：" + JSON.stringify(value["bitOffset"]) };
    const bitWidth = parseSvdNumber(value["bitWidth"]);
    if (bitWidth === null || bitWidth < 1 || bitWidth > 32) {
        return { field: null, error: where + "（" + name + "）的 bitWidth 不合法：" + JSON.stringify(value["bitWidth"]) };
    }
    if (bitOffset + bitWidth > 32) {
        return { field: null, error: where + "（" + name + "）越界：bitOffset " + String(bitOffset) + " + bitWidth " + String(bitWidth) + " > 32" };
    }
    return { field: { name, bitOffset, bitWidth, description: textOf(value["description"]) }, error: "" };
}
/**
 * 解析一份 SVD 文本。纯函数：测试可以直接喂字符串，不走磁盘。
 * 任何一条外设/寄存器/字段不合法都返回 error（宁缺勿错，见文件头）。
 */
export function parseSvd(text, filePath = "", version = "", expectedLine = "") {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        return { device: null, error: "SVD 不是合法 JSON（" + filePath + "）：" + errText(error) };
    }
    if (!isRecord(parsed))
        return { device: null, error: "SVD 顶层不是对象（" + filePath + "）" };
    const line = textOf(parsed["line"]);
    if (line === "")
        return { device: null, error: "SVD 缺 line 字段（" + filePath + "）" };
    if (expectedLine !== "" && line !== expectedLine) {
        return { device: null, error: "SVD 里的 line=" + quote(line) + " 与要读的 line=" + quote(expectedLine) + " 不一致（装错文件比没装更危险）" };
    }
    const rawPeripherals = parsed["peripherals"];
    if (!Array.isArray(rawPeripherals) || rawPeripherals.length === 0) {
        return { device: null, error: "SVD 缺 peripherals 数组或为空（" + filePath + "）" };
    }
    const peripherals = [];
    let registerCount = 0;
    let fieldCount = 0;
    for (let index = 0; index < rawPeripherals.length; index += 1) {
        const rawPeripheral = rawPeripherals[index];
        const where = "peripherals[" + String(index) + "]";
        if (!isRecord(rawPeripheral))
            return { device: null, error: where + " 不是对象" };
        const name = textOf(rawPeripheral["name"]);
        if (name === "")
            return { device: null, error: where + " 缺 name" };
        const baseAddress = parseSvdNumber(rawPeripheral["baseAddress"]);
        if (baseAddress === null)
            return { device: null, error: "外设 " + name + " 的 baseAddress 不合法：" + JSON.stringify(rawPeripheral["baseAddress"]) };
        const rawRegisters = rawPeripheral["registers"];
        if (!Array.isArray(rawRegisters) || rawRegisters.length === 0) {
            return { device: null, error: "外设 " + name + " 缺 registers 数组或为空" };
        }
        const registers = [];
        for (let regIndex = 0; regIndex < rawRegisters.length; regIndex += 1) {
            const rawRegister = rawRegisters[regIndex];
            const regWhere = name + ".registers[" + String(regIndex) + "]";
            if (!isRecord(rawRegister))
                return { device: null, error: regWhere + " 不是对象" };
            const regName = textOf(rawRegister["name"]);
            if (regName === "")
                return { device: null, error: regWhere + " 缺 name" };
            const addressOffset = parseSvdNumber(rawRegister["addressOffset"]);
            if (addressOffset === null) {
                return { device: null, error: name + "." + regName + " 的 addressOffset 不合法：" + JSON.stringify(rawRegister["addressOffset"]) };
            }
            const size = parseSvdNumber(rawRegister["size"]) ?? 32;
            if (size <= 0 || size > 64)
                return { device: null, error: name + "." + regName + " 的 size 不合法：" + JSON.stringify(rawRegister["size"]) };
            const rawFields = rawRegister["fields"];
            if (rawFields !== undefined && !Array.isArray(rawFields)) {
                return { device: null, error: name + "." + regName + " 的 fields 不是数组" };
            }
            const fields = [];
            if (Array.isArray(rawFields)) {
                for (let fieldIndex = 0; fieldIndex < rawFields.length; fieldIndex += 1) {
                    const rawField = rawFields[fieldIndex];
                    const parsedField = fieldFrom(rawField, name + "." + regName + ".fields[" + String(fieldIndex) + "]");
                    if (parsedField.field === null)
                        return { device: null, error: parsedField.error };
                    fields.push(parsedField.field);
                    fieldCount += 1;
                }
            }
            registers.push({ name: regName, addressOffset, size, access: textOf(rawRegister["access"]), fields });
            registerCount += 1;
        }
        peripherals.push({ name, baseAddress, registers });
    }
    const byName = new Map();
    for (const peripheral of peripherals)
        if (!byName.has(peripheral.name))
            byName.set(peripheral.name, peripheral);
    const flat = [];
    for (const peripheral of peripherals) {
        for (const register of peripheral.registers) {
            flat.push({ address: (peripheral.baseAddress + register.addressOffset) >>> 0, peripheral, register });
        }
    }
    flat.sort((left, right) => left.address - right.address);
    const byAddress = new Map();
    for (const entry of flat)
        if (!byAddress.has(entry.address))
            byAddress.set(entry.address, entry);
    const source = (() => {
        const raw = parsed["source"];
        if (typeof raw === "string")
            return raw.trim();
        if (isRecord(raw))
            return textOf(raw["url"]) || textOf(raw["file"]) || textOf(raw["repo"]);
        return "";
    })();
    return {
        device: {
            line,
            device: textOf(parsed["device"]),
            family: textOf(parsed["family"]),
            schema: parseSvdNumber(parsed["schema"]) ?? 0,
            version,
            path: filePath,
            source,
            counts: { peripherals: peripherals.length, registers: registerCount, fields: fieldCount },
            peripherals,
            byName,
            peripheralNames: peripherals.map((peripheral) => peripheral.name),
            flat,
            byAddress,
        },
        error: "",
    };
}
/* ------------------------------ 加载 ------------------------------ */
/**
 * 按 line 读 SVD：成功返回 { device, failure: null }，失败返回 { device: null, failure }。
 *
 * 不抛异常（工具卡片照常渲染）；需要"没有就报错"的调用方用 requireSvd()。
 * env 默认 process.env：DSH_STM32_ASSETS 可以换根（测试一律指到 test/fixtures，不碰真实 home）。
 */
export function loadSvd(line, env = process.env) {
    const wanted = (line ?? "").trim();
    if (!/^[0-9]{3}$/u.test(wanted)) {
        return {
            device: null,
            failure: failureOf("line-invalid", wanted, "", "line 要三位数字（例如 " + SVD_KNOWN_LINES.join(" / ") + "），拿到的是 " + quote(wanted) + "；" + SVD_FULL_PROFILE_HINT + "。"),
        };
    }
    const locations = svdLocations(env);
    if (locations.length === 0) {
        const root = assetsRootInfo(env).root;
        return {
            device: null,
            failure: failureOf("assets-missing", wanted, path.join(root, SVD_REL_DIR, wanted + ".json"), "本地还没装资源包（" + root + "），读不到 " + SVD_REL_DIR + "/" + wanted + ".json；" + SVD_FULL_PROFILE_HINT + "。"),
        };
    }
    const tried = [];
    for (const location of locations) {
        const filePath = path.join(location.dir, SVD_REL_DIR, wanted + ".json");
        let stat;
        try {
            stat = fs.statSync(filePath);
        }
        catch {
            tried.push(filePath);
            continue;
        }
        if (!stat.isFile()) {
            tried.push(filePath);
            continue;
        }
        const key = filePath + ":" + String(stat.size) + ":" + String(stat.mtimeMs);
        const cached = svdCache.get(filePath);
        if (cached !== undefined && cached.key === key) {
            svdStats.hits += 1;
            return { device: cached.device, failure: null };
        }
        let text;
        try {
            text = fs.readFileSync(filePath, "utf8");
            svdStats.reads += 1;
        }
        catch (error) {
            return {
                device: null,
                failure: failureOf("svd-invalid", wanted, filePath, "SVD 读不了（" + filePath + "）：" + errText(error) + "；" + SVD_FULL_PROFILE_HINT + "。"),
            };
        }
        const parsed = parseSvd(text, filePath, location.version, wanted);
        if (parsed.device === null) {
            return {
                device: null,
                failure: failureOf("svd-invalid", wanted, filePath, "SVD 解析失败（" + filePath + "）：" + parsed.error + "；" + SVD_FULL_PROFILE_HINT + "。"),
            };
        }
        svdCache.set(filePath, { key, device: parsed.device });
        return { device: parsed.device, failure: null };
    }
    const versioned = locations.filter((location) => location.layout === "versioned");
    const onlyCore = versioned.length > 0 && versioned.every((location) => location.profiles.length > 0 && !location.profiles.includes("full"));
    const where = versioned.length === 0 ? "（" + assetsRootInfo(env).root + "）" : "（版本 " + versioned.map((location) => location.version).join("、") + "）";
    const message = "本地资源包" + where + "里没有 " + SVD_REL_DIR + "/" + wanted + ".json" +
        (onlyCore ? "：已装的版本只装了 profile=core" : "") +
        "；" + SVD_FULL_PROFILE_HINT + "。";
    return { device: null, failure: failureOf("svd-missing", wanted, tried[0] ?? "", message) };
}
/** 便捷版：拿不到就 null（要原因用 loadSvd）。 */
export function loadSvdForLine(line, env = process.env) {
    return loadSvd(line, env).device;
}
/** 必须有 SVD：拿不到抛 SvdError（message 一定带 full profile 提示）。 */
export function requireSvd(line, env = process.env) {
    const loaded = loadSvd(line, env);
    if (loaded.device !== null)
        return loaded.device;
    const failure = loaded.failure;
    const code = failure === null ? "svd-missing" : failure.code;
    throw new SvdError(code, failure === null ? "读不到 SVD（line=" + line + "）；" + SVD_FULL_PROFILE_HINT + "。" : failure.message, {
        line: failure === null ? line : failure.line,
        hint: SVD_FULL_PROFILE_HINT,
    });
}
/** 型号 → SVD line（用资源包 device facts 的 line 字段）；没有这颗芯片/没有资源包返回 null。 */
export function svdLineForChip(cpn, env = process.env) {
    const chip = findChipFact(cpn, env);
    return chip === null ? null : chip.line;
}
/* ------------------------------ 查找 ------------------------------ */
function findPeripheral(device, name) {
    const exact = device.byName.get(name);
    if (exact !== undefined)
        return exact;
    const wanted = name.trim().toUpperCase();
    if (wanted === "")
        return null;
    for (const peripheral of device.peripherals) {
        if (peripheral.name.toUpperCase() === wanted)
            return peripheral;
    }
    return null;
}
function findRegister(peripheral, name) {
    const exact = peripheral.registers.find((register) => register.name === name);
    if (exact !== undefined)
        return exact;
    const wanted = name.trim().toUpperCase();
    if (wanted === "")
        return null;
    return peripheral.registers.find((register) => register.name.toUpperCase() === wanted) ?? null;
}
function resolvedOf(entry) {
    return {
        ref: entry.peripheral.name + "." + entry.register.name,
        address: entry.address,
        addressHex: formatAddress(entry.address),
        peripheral: entry.peripheral.name,
        baseAddress: entry.peripheral.baseAddress,
        register: entry.register.name,
        addressOffset: entry.register.addressOffset,
        offsetHex: formatOffset(entry.register.addressOffset),
        size: entry.register.size,
        fields: entry.register.fields,
    };
}
/** 地址 → 命中的寄存器条目（先精确命中 byAddress，再找"落在寄存器内部"的那一条）。 */
function locateAddress(device, address) {
    const exact = device.byAddress.get(address);
    if (exact !== undefined)
        return exact;
    // flat 已按地址升序：找到最后一条起点 <= address 的，看它是否覆盖该地址。
    let low = 0;
    let high = device.flat.length - 1;
    let candidate = null;
    while (low <= high) {
        const middle = (low + high) >> 1;
        const entry = device.flat[middle];
        if (entry === undefined)
            break;
        if (entry.address <= address) {
            candidate = entry;
            low = middle + 1;
        }
        else {
            high = middle - 1;
        }
    }
    if (candidate === null)
        return null;
    const span = registerBytes(candidate.register.size);
    return address < candidate.address + span ? candidate : null;
}
/**
 * 把四种写法解析成寄存器：
 *   GPIOC.ODR / GPIOC->ODR / RCC.CR（大小写与空白都容错）/ 0x4001100C（或裸 4001100C）。
 * 失败抛 SvdError：code 区分"没装 SVD"与"外设/寄存器/地址不认识"。
 */
export function resolveRegisterRef(ref, line, env = process.env) {
    const device = requireSvd(line, env);
    const text = (ref ?? "").trim();
    if (text === "") {
        throw new SvdError("ref-invalid", "寄存器写法是空的：要 GPIOC.ODR / GPIOC->ODR / 0x4001100C 之一。", { line: device.line });
    }
    const address = parseAddressText(text);
    if (address !== null) {
        const entry = device.byAddress.get(address);
        if (entry !== undefined)
            return resolvedOf(entry);
        const inside = locateAddress(device, address);
        if (inside !== null) {
            throw new SvdError("register-unknown", formatAddress(address) + " 不是寄存器起点：它落在 " + inside.peripheral.name + "." + inside.register.name +
                "（起点 " + formatAddress(inside.address) + "，位宽 " + String(inside.register.size) + " 位）内部。", { line: device.line, ref: text });
        }
        throw new SvdError("address-unknown", "line=" + device.line + " 的 SVD 里没有寄存器覆盖地址 " + formatAddress(address) + "（按裸地址读仍然可以，只是没有名字/位域）。", { line: device.line, ref: text });
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\.|->)\s*([A-Za-z_][A-Za-z0-9_]*)$/u.exec(text);
    if (match === null) {
        throw new SvdError("ref-invalid", "不认识的寄存器写法：" + quote(text) + "；支持 GPIOC.ODR、GPIOC->ODR、RCC.CR、0x4001100C 四种。", { line: device.line, ref: text });
    }
    const peripheralName = match[1] ?? "";
    const registerName = match[2] ?? "";
    const peripheral = findPeripheral(device, peripheralName);
    if (peripheral === null) {
        throw new SvdError("peripheral-unknown", "资源包（line=" + device.line + "）里没有外设 " + peripheralName.toUpperCase() + "；已知外设：" + listNames(device.peripheralNames) + "。", { line: device.line, ref: text });
    }
    const register = findRegister(peripheral, registerName);
    if (register === null) {
        throw new SvdError("register-unknown", "外设 " + peripheral.name + " 里没有寄存器 " + registerName.toUpperCase() + "；已知寄存器：" +
            listNames(peripheral.registers.map((item) => item.name)) + "。", { line: device.line, ref: text });
    }
    return {
        ref: peripheral.name + "." + register.name,
        address: (peripheral.baseAddress + register.addressOffset) >>> 0,
        addressHex: formatAddress((peripheral.baseAddress + register.addressOffset) >>> 0),
        peripheral: peripheral.name,
        baseAddress: peripheral.baseAddress,
        register: register.name,
        addressOffset: register.addressOffset,
        offsetHex: formatOffset(register.addressOffset),
        size: register.size,
        fields: register.fields,
    };
}
/**
 * 按地址反查名字：命中寄存器返回描述（含 exact 标志），没命中返回 null。
 *
 * 为什么不抛：地址没被 SVD 覆盖是"正常答案"（外设私有地址、保留区都可能有），
 * 工具层拿去当 note 就行；SVD 本身缺失才抛 SvdError（那是配置问题，必须提示 full profile）。
 */
export function describeAddress(address, line, env = process.env) {
    const device = requireSvd(line, env);
    const numeric = typeof address === "number" ? (Number.isFinite(address) ? address >>> 0 : null) : parseAddressText(address);
    if (numeric === null) {
        throw new SvdError("ref-invalid", "地址不合法：" + quote(typeof address === "number" ? String(address) : address) + "（要 0x 开头的 1–8 位十六进制，或 5–8 位裸十六进制）。", { line: device.line });
    }
    const entry = locateAddress(device, numeric);
    if (entry === null)
        return null;
    return {
        address: numeric,
        addressHex: formatAddress(numeric),
        ref: entry.peripheral.name + "." + entry.register.name,
        peripheral: entry.peripheral.name,
        baseAddress: entry.peripheral.baseAddress,
        register: entry.register.name,
        addressOffset: entry.register.addressOffset,
        size: entry.register.size,
        fields: entry.register.fields,
        exact: numeric === entry.address,
        offsetInRegister: numeric - entry.address,
    };
}
/* ------------------------------ 位域解释 ------------------------------ */
function registerNameOf(register) {
    return "register" in register ? register.register : register.name;
}
function parseValueInput(value) {
    if (typeof value === "number")
        return Number.isFinite(value) && value >= 0 ? Math.trunc(value) >>> 0 : null;
    const text = (value ?? "").trim();
    if (text === "")
        return null;
    if (/^0[xX][0-9a-fA-F]+$/u.test(text))
        return parseInt(text.slice(2), 16) >>> 0;
    if (/^[0-9]+$/u.test(text))
        return parseInt(text, 10) >>> 0;
    return null;
}
/**
 * 把一个读回来的值按位域拆开：返回全部字段 + 置位字段（set）+ 没被任何位域解释的位。
 * 接受 "0x00000004" 这种字符串（regs_read 的样本就是这种格式）。
 */
export function decodeRegisterValue(register, value) {
    const numeric = parseValueInput(value);
    if (numeric === null) {
        throw new SvdError("value-invalid", "寄存器值不合法：" + quote(typeof value === "number" ? String(value) : value) + "（要 0x 十六进制或十进制非负整数）。", {
            ref: "name" in register ? register.name : register.register,
        });
    }
    const size = register.size > 0 && register.size <= 32 ? register.size : 32;
    const masked = numeric & sizeMask(size);
    const width = size >= 32 ? 32 : size;
    const decoded = [];
    let covered = 0;
    for (const field of register.fields) {
        const mask = maskOf(field.bitOffset, field.bitWidth) & sizeMask(width);
        covered = (covered | mask) >>> 0;
        const raw = (masked & mask) >>> 0;
        const fieldValue = field.bitOffset >= 32 ? 0 : raw >>> field.bitOffset;
        decoded.push({
            name: field.name,
            bitOffset: field.bitOffset,
            bitWidth: field.bitWidth,
            mask,
            raw,
            value: fieldValue,
            description: field.description,
        });
    }
    const uncovered = (masked & ~covered) >>> 0;
    const uncoveredBits = [];
    for (let bit = 0; bit < width; bit += 1) {
        if ((uncovered & (1 << bit)) !== 0)
            uncoveredBits.push(bit);
    }
    return {
        register: registerNameOf(register),
        value: masked,
        valueHex: formatAddress(masked),
        size,
        fields: decoded,
        set: decoded.filter((field) => field.value !== 0),
        clear: decoded.filter((field) => field.value === 0),
        uncovered,
        uncoveredBits,
    };
}
/** 一行人话：ODR0=1、ODR2=1、ODR15=1（+ 未解释的工作位）。 */
export function formatDecodedFields(decoded) {
    const parts = decoded.set.map((field) => field.name + "=" + String(field.value));
    const base = parts.length === 0 ? "没有置位的位域" : parts.join("、");
    const tail = decoded.uncovered === 0
        ? ""
        : "（另有 " + formatAddress(decoded.uncovered) + " 不属于任何位域：第 " + decoded.uncoveredBits.map((bit) => String(bit)).join("、") + " 位）";
    return base + tail;
}
