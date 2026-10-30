/**
 * L1：引脚名合法性 + 由本机 CubeMX db 派生的引脚表。
 *
 * 用户 2026-10-31「内置表删了吧」之后，这里**不再有任何内置芯片/引脚表**（原来的 CHIPS / KNOWN_CHIPS /
 * findChip 已删）。原因：芯片事实的唯一来源是资源包缓存 device/f1/chips.json，而那份文件只有 pinCount
 * （封装上有多少根脚），没有「这个封装有哪几根 GPIO」的清单——拿 pinCount 去猜 PA0-PB15… 等于又造一张表。
 *
 * 于是分工变成：
 *   1. isKnownPin(pin)：只校验**引脚名**是不是 STM32 的合法名（P + A..K + 0..15，虚拟引脚 VP_* 恒放行）。
 *      它拦的是手误（PA99、PZ9、PA-1），不再假装知道某个封装有没有这根脚。
 *   2. deriveChipPinTable()：引脚**存在性**只认本机 CubeMX 的 db/mcu XML
 *      （<Pin Name="PA1" Position="3"/>，Position>0 才是真实封装引脚）。本机没装 CubeMX / 没有这个 XML 时
 *      kind="unknown"，notes 里明说「没校验」，绝不拿猜测冒充实测。
 *
 * 放行语义（从第一天就在，不能变）：没把握的一律当「不是不存在」，只拦一定写错的东西。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
/** STM32 的 GPIO 引脚名：PA0..PK15。F1 只用到 A..E，这里按族上界放到 K。 */
const PIN_NAME = /^P([A-K])(\d{1,2})$/u;
/** 每个端口最多 16 根（0..15）；再大的一定是写错了。 */
const MAX_PIN_NUMBER = 15;
/**
 * 引脚名是否合法（未知/虚拟引脚一律放行）。
 *
 * 为什么不再按型号判「有没有这根脚」：那需要「封装 → 引脚清单」的事实，而资源包只给了 pinCount。
 * 真正的引脚存在性请用 deriveChipPinTable（本机 CubeMX db）——它给的是实测清单，不是符号表。
 */
export function isKnownPin(pin) {
    const raw = pin.trim().toUpperCase();
    if (raw === "")
        return true;
    if (raw.startsWith("VP_"))
        return true;
    // .ioc 里同一根脚会带功能后缀（PA0-WKUP / PC13-TAMPER-RTC），比较时只看引脚名本身。
    const name = (raw.split(/[-/]/u)[0] ?? "").trim();
    const matched = PIN_NAME.exec(name);
    if (matched === null)
        return false;
    return Number.parseInt(matched[2] ?? "", 10) <= MAX_PIN_NUMBER;
}
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
            // 读不了/不是合法 db：当作没有 db，notes 里会说明没校验。
        }
    }
    return null;
}
/**
 * 型号 → 引脚表（只认本机 CubeMX db）。
 *
 * "没校验"这件事必须写进 notes：没有 db 就没有任何引脚存在性事实，此时 pins 是空的、kind=unknown，
 * 报告里要说清「没校验」，而不是让上层以为「这个型号没有引脚」。
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
    const why = input.dbMcuDir === null || input.dbMcuDir === undefined
        ? "本机没找到 CubeMX 的 db/mcu"
        : "db/mcu 下没有 " + (names.length === 0 ? "该型号" : names.join(" / ")) + ".xml";
    return {
        kind: "unknown",
        cpn,
        mcuName,
        pins: [],
        notes: [
            "引脚表：没有本机 CubeMX db（" + why + "），引脚存在性不校验（isKnownPin 只查引脚名是否合法）；" +
                "插件不内置引脚表，需要逐脚校验请装 CubeMX 或用 stm32_assets 的 chipdb",
        ],
    };
}
