/**
 * L1：STM32F1 全系的芯片事实表（型号 → 容量档 / 启动文件 / 设备宏 / Flash / RAM）。
 *
 * 为什么单独一个文件：容量字母 → 上游启动文件的映射是事实，不是逻辑。
 * 加一款芯片只改这里，不动引擎。
 *
 * 取数优先级（写进 docs/development-notes.md）：
 *   1. 固件包 `Drivers/CMSIS/Device/ST/STM32F1xx/Source/Templates/gcc` 里真实存在的启动文件
 *      —— 实测 F1 有 14 个（100 xb/xe、101 x6/xb/xe/xg、102 x6/xb、103 x6/xb/xe/xg、105 xc、107 xc）。
 *   2. 本机 CubeMX 的 `db/mcu/*.xml`（Flash/RAM/引脚数，将来用作校验）。
 *   3. 本文件内置的容量字母表。
 *
 * 关键坑：容量字母 → 容量档不是全局映射。字母 C 在 F103 上是 xE（startup_stm32f103xe.s），
 * 在 F105/F107 上却是 xC（startup_stm32f105xc.s）——先按「line 真有这一档」匹配，再退回全局表。
 */
import { F1_RAM_FROM_DB } from "./f1-ram.generated.js";
/** 容量字母 → 上游容量档的兜底映射（当 line 没有「x + 字母」这个档时用它）。 */
const GROUP_BY_LETTER = {
    "4": "x6",
    "6": "x6",
    "8": "xb",
    B: "xb",
    C: "xe",
    D: "xe",
    E: "xe",
    F: "xg",
    G: "xg",
};
/** 容量字母 → Flash 字节（ST 的容量字母就是 Flash 档）。 */
const FLASH_BY_LETTER = {
    "4": 16 * 1024,
    "6": 32 * 1024,
    "8": 64 * 1024,
    B: 128 * 1024,
    C: 256 * 1024,
    D: 384 * 1024,
    E: 512 * 1024,
    F: 768 * 1024,
    G: 1024 * 1024,
};
/**
 * RAM 字节。键是「line:容量字母」——一个容量档会跨多个字母，而它们的 RAM 并不相同
 * （F103xC 是 48 KiB，F103xE 是 64 KiB），所以不能按档查。
 * 只收有把握的组合；查不到返回 null 并在 notes 里说清楚，绝不猜。
 *
 * 来源（实测日期 2026-10-30）：本机 ST 固件包
 * STM32Cube_FW_F1_V1.8.7/Drivers/CMSIS/Device/ST/STM32F1xx/Source/Templates/gcc/linker/
 * 下 ST 官方每个 .ld 的 MEMORY 段，逐个核对（FLASH / RAM）：
 *   STM32F100XB 128K/8K、STM32F100XE 512K/32K、
 *   STM32F101X6 32K/6K、STM32F101XB 128K/16K、STM32F101XE 512K/48K、STM32F101XG 1000K/80K、
 *   STM32F102X6 32K/6K、STM32F102XB 128K/16K、
 *   STM32F103X6 32K/10K、STM32F103XB 128K/20K、STM32F103XE 512K/64K、STM32F103XG 1000K/96K、
 *   STM32F105XC 256K/64K、STM32F107XC 256K/64K。
 * 因此 STM32F100XE_FLASH.ld 的 ram=32K、STM32F101XE_FLASH.ld 的 ram=48K 就是 F100xE / F101xE
 * 的正式值（比 CubeMX db 里那个按分组取的保守下限 24K/32K 大）。
 *
 * 本表只收「官方 .ld 能对上、且生成表 f1-ram.generated.ts 里没有」的组合：
 * x6 / xB / xG 那几档生成表已给同值（100:8/B=8K、101:6=6K、101:B=16K、101:F/G=80K、
 * 102:6/B、103:6/8/B、103:F/G 等），重复收进来只会丢掉「RAM 取自 CubeMX db」的来源 note。
 *
 * 两处要写清楚的判断：
 *   - F103 的 C/D 字母：官方 gcc 模板只有 STM32F103XE_FLASH.ld（512K/64K），
 *     没有 STM32F103XC/XD_FLASH.ld；而 F103xC 是 256K Flash / 48K RAM（ST 数据手册），
 *     与 XE 的 64K 不同 → C 保留 48K，不跟着 103:E 的 64K 走；D（384K）按 64K。
 *   - F100xC / F101xC 这类只在 XE 分组里出现的中间档，官方 .ld 没给独立值，
 *     本表不收（宁可不收也不猜）；寄存器路线的链接脚本沿 register-linker.ts 的 db 保守下限并报 warning。
 */
const RAM_BY_LINE_LETTER = {
    "100:E": 32 * 1024,
    "101:E": 48 * 1024,
    "103:6": 10 * 1024,
    "103:8": 20 * 1024,
    "103:B": 20 * 1024,
    "103:C": 48 * 1024,
    "103:D": 64 * 1024,
    "103:E": 64 * 1024,
    "105:C": 64 * 1024,
    "107:C": 64 * 1024,
};
/** F1 各 line 在上游真实存在的容量档（由固件包 gcc 启动文件实测得出；F106 不是独立产品线）。 */
export const F1_LINES = [
    { code: "100", prefix: "STM32F100", groups: ["xb", "xe"], familyDir: "STM32F1xx" },
    { code: "101", prefix: "STM32F101", groups: ["x6", "xb", "xe", "xg"], familyDir: "STM32F1xx" },
    { code: "102", prefix: "STM32F102", groups: ["x6", "xb"], familyDir: "STM32F1xx" },
    { code: "103", prefix: "STM32F103", groups: ["x6", "xb", "xe", "xg"], familyDir: "STM32F1xx" },
    { code: "105", prefix: "STM32F105", groups: ["xc"], familyDir: "STM32F1xx" },
    { code: "107", prefix: "STM32F107", groups: ["xc"], familyDir: "STM32F1xx" },
];
/** 封装字母（型号第 4 位）→ 引脚数。 */
const PINS_BY_PACKAGE = {
    T: 36,
    C: 48,
    R: 64,
    V: 100,
    Z: 144,
};
/**
 * 型号 → 芯片事实。认不出返回 chip: null + 原因，绝不编一个不存在的启动文件。
 *
 * 支持三种输入：
 *   - 完整型号：STM32F103C8T6 / STM32F103RCT6 / STM32F107VCT6
 *   - 去掉温度后缀：STM32F103C8
 *   - 显式容量档：F103:xb（脚本与测试用）
 */
export function resolveF1Chip(input) {
    const text = input.trim().toUpperCase();
    if (text.length === 0)
        return { chip: null, reason: "没有给型号" };
    const loose = /^F(\d{2,3}):(X[0-9A-Z]{1,2})$/u.exec(text);
    if (loose !== null) {
        const code = loose[1] ?? "";
        const group = (loose[2] ?? "").toLowerCase();
        const line = F1_LINES.find((item) => item.code === code);
        if (line === undefined)
            return { chip: null, reason: lineMissing(code) };
        return fromGroup(line, group, "F" + code);
    }
    const m = /^STM32F(\d{3})([A-Z])([0-9A-G])([A-Z])?([0-9])?$/u.exec(text);
    if (m === null)
        return { chip: null, reason: "不是 F1 的型号格式：" + input };
    const code = m[1] ?? "";
    const packageLetter = m[2] ?? "";
    const densityLetter = m[3] ?? "";
    const suffix = m[4] ?? "";
    const extra = m[5] ?? "";
    if (suffix.length > 0 && !"TXUYK".includes(suffix)) {
        return { chip: null, reason: "认不出封装后缀 " + suffix + "（期望 T/U/Y 之一）：" + input };
    }
    if (extra.length > 0 && !"67".includes(extra)) {
        return { chip: null, reason: "认不出温度档 " + extra + "（期望 6 或 7）：" + input };
    }
    const line = F1_LINES.find((item) => item.code === code);
    if (line === undefined)
        return { chip: null, reason: lineMissing(code) };
    const group = chooseGroup(line, densityLetter);
    if (group === null) {
        const fallback = GROUP_BY_LETTER[densityLetter];
        if (fallback === undefined) {
            return { chip: null, reason: "认不出容量字母 " + densityLetter + "：" + input };
        }
        return {
            chip: null,
            reason: line.prefix + " 没有 " + fallback + " 这一容量档（上游真实档位：" + line.groups.join("/") + "）",
        };
    }
    return fromGroup(line, group, text, packageLetter, densityLetter);
}
function lineMissing(code) {
    return "F1 里没有 F" + code + " 这一 line（已知：" + F1_LINES.map((x) => x.code).join("/") + "）";
}
/** 先认「line 真有 x+字母」，再退回全局表；都不行返回 null。 */
function chooseGroup(line, letter) {
    const direct = "x" + letter.toLowerCase();
    if (line.groups.includes(direct))
        return direct;
    const fallback = GROUP_BY_LETTER[letter];
    if (fallback === undefined)
        return null;
    return line.groups.includes(fallback) ? fallback : null;
}
function fromGroup(line, group, cpn, packageLetter = "", densityLetter = "") {
    const notes = [];
    if (!line.groups.includes(group)) {
        return {
            chip: null,
            reason: line.prefix + " 没有 " + group + " 这一容量档（上游真实档位：" + line.groups.join("/") + "）",
        };
    }
    const letter = densityLetter.length > 0 ? densityLetter : letterForGroup(group);
    const stem = line.prefix.toLowerCase() + group;
    // 先用手写表（有把握的组合），再用生成表（CubeMX db 里「容量字母与 RAM 唯一对应」的条目）。
    // db 给区间的分组（例如 F103R(C-D-E) 的 [48,64]）不进生成表——字母对不上号时宁可不收。
    const handRam = RAM_BY_LINE_LETTER[line.code + ":" + letter];
    const dbRam = F1_RAM_FROM_DB[line.code + ":" + letter];
    const ramBytes = handRam ?? dbRam ?? null;
    if (handRam === undefined && dbRam !== undefined) {
        notes.push("RAM 取自 CubeMX db 的容量档值（" + line.prefix + letter + " = " + String(dbRam / 1024) + " KiB）");
    }
    if (ramBytes === null) {
        notes.push("RAM 大小未收录：" + line.prefix + letter + "（用 CubeMX 的 db/mcu 确认后再补表）");
    }
    if (packageLetter.length > 0 && PINS_BY_PACKAGE[packageLetter] === undefined) {
        notes.push("认不出封装字母 " + packageLetter + "，引脚数未知");
    }
    return {
        chip: {
            cpn,
            prefix: line.prefix,
            densityLetter: letter,
            group,
            startup: "startup_" + stem + ".s",
            deviceDefine: line.prefix + "x" + group.slice(1).toUpperCase(),
            deviceHeader: stem + ".h",
            pinCount: packageLetter.length > 0 ? (PINS_BY_PACKAGE[packageLetter] ?? null) : null,
            flashBytes: FLASH_BY_LETTER[letter] ?? null,
            ramBytes,
            notes,
        },
        reason: "",
    };
}
function letterForGroup(group) {
    const found = Object.entries(GROUP_BY_LETTER).find(([, value]) => value === group);
    return found === undefined ? "" : found[0];
}
/** 该 line 的全部容量档（给「这个型号能选哪些档」的报告用）。 */
export function f1GroupsFor(code) {
    const line = F1_LINES.find((item) => item.code === code);
    return line === undefined ? [] : line.groups;
}
