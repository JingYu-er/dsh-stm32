/**
 * L1：芯片型号 → 可用引脚表。
 *
 * 两条来源，优先本机 CubeMX 的数据库：
 *   1. `<CubeMX 安装根>/db/mcu/<Mcu.Name>.xml` 里的 `<Pin Name="PA1" Position="3"/>`——
 *      Position>0 才是真实封装引脚（Position=0 是虚拟引脚，例如 VP_SYS_VS_Systick 的占位）。
 *      名字常带功能后缀（`PA0-WKUP`、`PC13-TAMPER-RTC`、`PD0-OSC_IN`），这里归一化成 PA0/PC13/PD0。
 *   2. 内置表（CHIPS）：机器上没装 CubeMX 时兜底，能跑但**没有跟本机 db 校验过**，
 *      deriveChipPinTable 会在 notes 里把这件事说清楚。
 *
 * 放行语义（从第一天就在，不能变）：isKnownPin 只认内置表；未知型号、虚拟引脚（VP_*）一律 true。
 * 校验是为了拦住手误，不是为了当数据源；没校验过的东西绝不当"不存在"。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
function port(prefix, from, to) {
    const out = [];
    for (let index = from; index <= to; index += 1)
        out.push(prefix + String(index));
    return out;
}
const CHIPS = [
    {
        cpn: "STM32F103C8T6",
        // LQFP48：PA0-15、PB0-15、PC13-15、PD0-1（PD0/PD1 默认是 OSC_IN/OSC_OUT）。
        pins: [...port("PA", 0, 15), ...port("PB", 0, 15), "PC13", "PC14", "PC15", "PD0", "PD1"],
        flashBytes: 64 * 1024,
        ramBytes: 20 * 1024,
    },
];
export function findChip(cpn) {
    const wanted = cpn.trim().toUpperCase();
    return CHIPS.find((chip) => chip.cpn.toUpperCase() === wanted) ?? null;
}
/** 引脚名是否属于该型号；未知型号或虚拟引脚（VP_*）一律放行。 */
export function isKnownPin(cpn, pin) {
    if (pin.startsWith("VP_"))
        return true;
    const chip = findChip(cpn);
    if (chip === null)
        return true;
    return chip.pins.includes(pin.toUpperCase());
}
export const KNOWN_CHIPS = CHIPS;
// ── 本机 CubeMX db/mcu 派生 ─────────────────────────────────────────────────
/** db 里 Pin 的 Name 形如 `PA0-WKUP` / `PC13-TAMPER-RTC` / `PD0-OSC_IN` / `PA13` / `VDD_1`。 */
function normalizeDbPinName(raw) {
    const head = (raw.split(/[-/]/u)[0] ?? "").trim().toUpperCase();
    return /^P[A-K]\d{1,2}$/u.test(head) ? head : "";
}
function pinOrder(pin) {
    const matched = /^P([A-K])(\d{1,2})$/u.exec(pin);
    return [matched?.[1] ?? "", Number(matched?.[2] ?? 0)];
}
/**
 * 解析 db/mcu/<Mcu.Name>.xml，取出这个封装上真实存在的 GPIO 引脚（PA0…，已排序去重）。
 *
 * 只认 Position>0：CubeMX 把虚拟引脚也写进 <Pin>，Position=0，拿来当"这个型号有这根脚"会误判。
 * 兼容多行标签（真实 db 里属性经常换行）与自闭合/带子节点的写法。
 */
export function parseMcuDbXmlPins(xml) {
    const pins = [];
    const seen = new Set();
    for (const tag of xml.match(/<Pin\b[^>]*>/gu) ?? []) {
        const name = /\bName\s*=\s*"([^"]*)"/u.exec(tag)?.[1] ?? "";
        const positionText = /\bPosition\s*=\s*"([^"]*)"/u.exec(tag)?.[1] ?? "";
        const position = Number.parseInt(positionText.trim(), 10);
        if (!Number.isFinite(position) || position <= 0)
            continue;
        const pin = normalizeDbPinName(name);
        if (pin === "" || seen.has(pin))
            continue;
        seen.add(pin);
        pins.push(pin);
    }
    pins.sort((left, right) => {
        const [leftPort, leftNumber] = pinOrder(left);
        const [rightPort, rightNumber] = pinOrder(right);
        if (leftPort !== rightPort)
            return leftPort < rightPort ? -1 : 1;
        return leftNumber - rightNumber;
    });
    return pins;
}
/** 本机 CubeMX 的 db/mcu 目录（<CubeMX 安装根>/db/mcu）；没有返回 null。 */
export function findMcuDbDir(cubeMxRoots) {
    for (const root of cubeMxRoots ?? []) {
        if (root.trim() === "")
            continue;
        const dir = join(root, "db", "mcu");
        if (existsSync(dir))
            return dir;
    }
    return null;
}
/**
 * 在 db/mcu 下按候选文件名找 XML（CubeMX 用 Mcu.Name，例如 STM32F103C(8-B)Tx.xml；
 * 也可能有人按完整型号存成 STM32F103RCT6.xml），读到就解析，读不到返回 null。
 */
export function readMcuDbPins(dbMcuDir, names) {
    if (dbMcuDir === null || dbMcuDir === undefined || dbMcuDir.trim() === "")
        return null;
    for (const name of names) {
        const wanted = name.trim();
        if (wanted === "")
            continue;
        const xmlPath = join(dbMcuDir, wanted + ".xml");
        if (!existsSync(xmlPath))
            continue;
        try {
            const pins = parseMcuDbXmlPins(readFileSync(xmlPath, "utf8"));
            if (pins.length > 0)
                return { xmlPath, pins };
        }
        catch {
            // 读不了/不是合法 db：退回内置表，notes 里会说明没校验。
        }
    }
    return null;
}
/**
 * 型号 → 引脚表（db 优先，退回内置表）。
 *
 * "没校验"这件事必须写进 notes：内置表只收了 C8T6 一款，别的型号拿它当"真实引脚"会误判，
 * 所以内置表路径只说"这里是内置表，未与本机 db 校验"，不假装校验过。
 */
export function deriveChipPinTable(input) {
    const cpn = input.cpn.trim();
    const mcuName = (input.mcuName ?? "").trim();
    const names = [mcuName, cpn].filter((name) => name !== "");
    const dbHit = readMcuDbPins(input.dbMcuDir ?? null, names);
    if (dbHit !== null) {
        return {
            kind: "db",
            cpn,
            mcuName,
            pins: dbHit.pins,
            notes: [
                "引脚表：来自本机 CubeMX db（" + dbHit.xmlPath + "，" + String(dbHit.pins.length) + " 个封装引脚）",
            ],
        };
    }
    const builtin = findChip(cpn);
    const why = input.dbMcuDir === null || input.dbMcuDir === undefined
        ? "本机没找到 CubeMX 的 db/mcu"
        : "db/mcu 下没有 " + (names.length === 0 ? "该型号" : names.join(" / ")) + ".xml";
    if (builtin !== null) {
        return {
            kind: "builtin",
            cpn,
            mcuName,
            pins: builtin.pins,
            notes: ["引脚表：内置表（" + String(builtin.pins.length) + " 个引脚，未与本机 db 校验：" + why + "）"],
        };
    }
    return {
        kind: "unknown",
        cpn,
        mcuName,
        pins: [],
        notes: [
            "引脚表：型号 " + (cpn === "" ? "(空)" : cpn) + " 不在内置表，也没有本机 CubeMX db（未与本机 db 校验：" + why +
                "）；未知引脚一律放行（isKnownPin 语义不变）",
        ],
    };
}
