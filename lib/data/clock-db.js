/**
 * 从 CubeMX db 读时钟事实（PLL 倍频/分频枚举、PLL 源、SYSCLK 上限、PLL 模型）。
 *
 * 为什么要有这一层：`clock-f1.ts` 里的 `F1_PLL_MULS` / `F1_APB_DIVS` / `F1_ADC_DIVS` / `F1_PLL_SOURCES`
 * 全是「某个 db 版本枚举值的手抄快照」。db 里这些恰好都有：
 *   - `db/mcu/<Mcu.Name>.xml` 的 `<Frequency>` 就是该型号的 SYSCLK 上限（MHz）；
 *   - `db/mcu/IP/RCC-*.xml`（Modes）里 `<RefParameter Name="PLLMUL" Type="list">` 的
 *     `<PossibleValue Value="RCC_PLL_MUL2" Comment="2"/>` 就是倍频枚举，分频同理。
 * 抄快照的问题与预设表一样：换族/换 db 版本就失真（F1 的 `S_TIM2_CH1_ETR` 已经栽过一次）。
 *
 * db 里**没有**的东西（所以仍然手写，别指望这一层给）：APB1/APB2/ADC 的**频率上限**
 * （那是数据手册的规格，db 只给引脚与枚举）；USB 需要的 48 MHz 规则同理。
 */
import { existsSync, readFileSync } from "node:fs";
import { ipModesPath } from "../engine/cubemx-db.js";
import { F1_BAUD_LIST, F1_PERIPHERAL_CLOCKS } from "./clock-f1.js";
function readTextOrNull(file) {
    if (file === null || !existsSync(file))
        return null;
    try {
        return readFileSync(file, "utf8");
    }
    catch {
        return null;
    }
}
/** RCC 实例的 Modes 文件路径（IP 的 Version 属性本身就带族名，例如 STM32F102_rcc_v1_0）。 */
function rccModesPath(db, facts) {
    for (const [instance, ip] of facts.ips) {
        const name = (ip.name ?? instance).toUpperCase();
        if (name !== "RCC")
            continue;
        return ipModesPath(db, facts, instance);
    }
    return null;
}
function numberOf(text) {
    const matched = /(-?[0-9]+(?:\.[0-9]+)?)/u.exec(text);
    return matched === null ? null : Number(matched[1]);
}
/** 取某个 list 型 RefParameter 的 PossibleValue（属性顺序不固定，按名字各取）。 */
function enumOf(text, parameterName) {
    const open = new RegExp('<RefParameter[^>]*Name="' + parameterName + '"[^>]*>', "u").exec(text);
    if (open === null)
        return [];
    // 自闭合 = integer 型（PLLM/PLLN 在 F4 上就是 Min=2 Max=63 这种），没有 PossibleValue。
    // 不挡住的话正则会把**下一个** RefParameter 的块当成它的 children —— F4 的 PLLM 曾因此拿到 PLLP 的枚举名。
    if (open[0].trimEnd().endsWith("/>"))
        return [];
    const from = (open.index ?? 0) + open[0].length;
    const close = text.indexOf("</RefParameter>", from);
    const block = close < 0 ? null : text.slice(from, close);
    const body = block;
    if (body === null)
        return [];
    const out = [];
    for (const matched of body.matchAll(/<PossibleValue([^>]*)\/?>/gu)) {
        const attrs = matched[1] ?? "";
        const value = /Value="([^"]*)"/u.exec(attrs)?.[1] ?? "";
        const comment = /Comment="([^"]*)"/u.exec(attrs)?.[1] ?? "";
        if (value === "")
            continue;
        out.push({ value, comment, num: numberOf(comment) ?? numberOf(value) });
    }
    return out;
}
/** 取数值型 RefParameter 的 Min/Max（F4 的 PLLN 这种不是 list，而是 2..432 的范围）。 */
function rangeOf(text, parameterName) {
    const matched = new RegExp('<RefParameter[^>]*Name="' + parameterName + '"[^>]*/?>', "u").exec(text);
    if (matched === null)
        return null;
    const min = numberOf(/Min="([^"]*)"/u.exec(matched[0])?.[1] ?? "");
    const max = numberOf(/Max="([^"]*)"/u.exec(matched[0])?.[1] ?? "");
    if (min === null || max === null || min >= max)
        return null;
    return { min, max };
}
/** RCC_PLLSOURCE_HSE → "hse"；只认频率已知的三种。 */
function sourceIdOf(value) {
    const upper = value.toUpperCase();
    if (upper === "RCC_PLLSOURCE_HSE")
        return "hse";
    if (upper === "RCC_PLLSOURCE_HSI")
        return "hsi";
    if (upper === "RCC_PLLSOURCE_HSI_DIV2")
        return "hsi-div2";
    return null;
}
/**
 * 读一颗芯片的时钟事实。读不到 RCC Modes 文件返回 null（调用方按「这一族没有 db 时钟事实」处理）。
 */
export function readClockDbFacts(db, facts) {
    const path = rccModesPath(db, facts);
    const text = readTextOrNull(path);
    if (text === null)
        return null;
    const notes = [];
    const muls = enumOf(text, "PLLMUL")
        .map((entry) => ({ mul: entry.num ?? 0, iocValue: entry.value }))
        .filter((item) => item.mul >= 2 && item.iocValue !== "")
        .sort((left, right) => left.mul - right.mul);
    const pllMRange = rangeOf(text, "PLLM");
    const pllM = pllMRange !== null ? [] : enumOf(text, "PLLM")
        .map((entry) => ({ div: entry.num ?? 0, iocValue: entry.value }))
        .filter((item) => item.div >= 1 && item.iocValue !== "")
        .sort((left, right) => left.div - right.div);
    if (pllMRange !== null) {
        for (let div = pllMRange.min; div <= pllMRange.max; div += 1)
            pllM.push({ div, iocValue: String(div) });
    }
    const pllP = enumOf(text, "PLLP")
        .map((entry) => ({ div: entry.num ?? 0, iocValue: entry.value }))
        .filter((item) => item.div >= 1 && item.iocValue !== "")
        .sort((left, right) => left.div - right.div);
    const pllN = rangeOf(text, "PLLN");
    const model = muls.length > 0 ? "pllmul" : pllM.length > 0 || pllN !== null ? "pllmn" : "unknown";
    if (model === "unknown") {
        notes.push("db 的 RCC Modes 里既没有 PLLMUL 也没有 PLLM/PLLN：这一族的 PLL 模型不在已实现的两种之内（H7/U5 这类分相 PLL 需要单独实现）");
    }
    const sources = [];
    for (const entry of enumOf(text, "PLLSource")) {
        const id = sourceIdOf(entry.value);
        if (id === null)
            continue;
        const dup = sources.some((source) => source.id === id);
        if (dup)
            continue;
        sources.push({
            id,
            label: id === "hse" ? "HSE（外部晶振）" : id === "hsi" ? "HSI（内部 RC）" : "HSI÷2（内部 RC 二分频）",
            iocValue: entry.value,
            // HSI 的绝对频率 db 不给（各族 8/16/48 MHz 都有），默认值只是占位：调用方要用 HSI 时必须从 .ioc 的 RCC.HSI_VALUE 拿真值。
            defaultHz: id === "hse" ? 8_000_000 : id === "hsi" ? 8_000_000 : 4_000_000,
            selectable: true,
            note: id === "hse"
                ? "外部晶振：频率以 .ioc 的 RCC.HSE_VALUE 为准（缺省 8 MHz）"
                : "内部 RC：" + (id === "hsi" ? "" : "二分频后") + "频率以 .ioc 的 RCC.HSI_VALUE 为准（db 不写各族 HSI 频率）",
        });
    }
    // F0/L0 这类族只有 RCC_PLLSOURCE_HSI 一档，硬件上它就是 HSI/2 进 PLL（不是 HSI 直连）：
    // 少了这一步，规划会把 HSI 8 MHz 当 8 MHz 源算，CubeMX 回写时按 /2 重算 → 频率对不上（F0 实测 48→24 MHz）。
    if (sources.some((source) => source.id === "hsi") && !sources.some((source) => source.id === "hsi-div2")) {
        for (const source of sources) {
            if (source.id !== "hsi")
                continue;
            source.divider = 2;
            source.note += "；该族的 RCC_PLLSOURCE_HSI 实际是 HSI/2 进 PLL（硬件固定二分频）";
        }
    }
    const toDivs = (entries) => entries
        .map((entry) => ({ div: entry.num ?? 0, iocValue: entry.value }))
        .filter((item) => item.div >= 1 && item.iocValue !== "")
        .sort((left, right) => left.div - right.div);
    const apbDivs = toDivs(enumOf(text, "APB1CLKDivider"));
    const adcDivs = toDivs(enumOf(text, "ADCPresc"));
    return {
        model,
        sysclkMaxHz: Math.round((facts.frequencyMhz ?? 0) * 1_000_000),
        muls,
        sources,
        apbDivs: apbDivs.length > 0 ? apbDivs : [1, 2, 4, 8, 16].map((div) => ({ div, iocValue: "RCC_HCLK_DIV" + String(div) })),
        adcDivs,
        pllM,
        pllN,
        pllP,
        notes,
        sourceFile: path ?? "",
    };
}
export const BUS_LIMITS = {
    // RM0090（F4）：APB1 ≤42 MHz、APB2 ≤84 MHz、ADC ≤36 MHz（ADC 走 APB2 再分频）
    STM32F4: { apb1Hz: 42_000_000, apb2Hz: 84_000_000, adcHz: 36_000_000 },
    // RM0008（F1）：APB1 ≤36 MHz、APB2 = SYSCLK、ADC ≤14 MHz
    STM32F1: { apb1Hz: 36_000_000, apb2Hz: 72_000_000, adcHz: 14_000_000 },
    // RM0091（F0）：APB1 = AHB（F0 的 APB1 不再二分频）、ADC ≤14 MHz
    STM32F0: { apb1Hz: 48_000_000, apb2Hz: 48_000_000, adcHz: 14_000_000 },
    // RM0377（L0）：APB1/APB2 = AHB（≤32 MHz）、ADC ≤16 MHz
    STM32L0: { apb1Hz: 32_000_000, apb2Hz: 32_000_000, adcHz: 16_000_000 },
};
export const PLL_VCO_LIMITS = {
    // RM0090：VCO 输出 100–432 MHz，PLL 输入 1–2 MHz
    STM32F4: { minHz: 100_000_000, maxHz: 432_000_000, inMinHz: 1_000_000, inMaxHz: 2_000_000 },
};
/**
 * db 事实 + 该族总线上限 → planClock 认的 ClockFacts。
 * 返回 null 表示这一族还不能规划（没有总线上限、或 PLL 模型不是 pllmul）。
 */
export function clockFactsFromDb(facts, familyId) {
    const family = familyId.trim().toUpperCase();
    const limits = BUS_LIMITS[family];
    if (limits === undefined)
        return null;
    if (facts.sources.length === 0)
        return null;
    const base = {
        sources: facts.sources,
        apbDivs: facts.apbDivs,
        adcDivs: facts.adcDivs.length > 0 ? facts.adcDivs : [{ div: 1, iocValue: "" }],
        limits: {
            sysclkHz: facts.sysclkMaxHz > 0 ? facts.sysclkMaxHz : limits.apb2Hz,
            apb1Hz: limits.apb1Hz,
            apb2Hz: limits.apb2Hz,
            adcHz: limits.adcHz,
        },
        // USB 规则：db 不写，且各族的 48 MHz 来源不同（F1 要 PLL=72 再 ÷1.5；F0/L0 直接 PLL=48）。
        // 这里给「未建模」（requiresPllClkHz = 0 ⇒ planClock 认为 USB 不可用，不会写 RCC.USBPrescaler）。
        usb: { hz: 48_000_000, requiresPllClkHz: 0, iocValue: "" },
        peripheralClocks: F1_PERIPHERAL_CLOCKS,
        baudList: F1_BAUD_LIST,
    };
    if (facts.model === "pllmn") {
        if (PLL_VCO_LIMITS[family] === undefined)
            return null;
        if (facts.pllM.length === 0 || facts.pllP.length === 0 || facts.pllN === null)
            return null;
        return { ...base, model: "pllmn", muls: [], pllM: facts.pllM, pllN: facts.pllN, pllP: facts.pllP };
    }
    if (facts.model !== "pllmul")
        return null;
    if (facts.muls.length === 0)
        return null;
    return {
        muls: facts.muls,
        sources: facts.sources,
        apbDivs: facts.apbDivs,
        adcDivs: facts.adcDivs.length > 0 ? facts.adcDivs : [{ div: 1, iocValue: "" }],
        limits: {
            sysclkHz: facts.sysclkMaxHz > 0 ? facts.sysclkMaxHz : limits.apb2Hz,
            apb1Hz: limits.apb1Hz,
            apb2Hz: limits.apb2Hz,
            adcHz: limits.adcHz,
        },
        // USB 规则：db 不写，且各族的 48 MHz 来源不同（F1 要 PLL=72 再 ÷1.5；F0/L0 直接 PLL=48）。
        // 这里给「未建模」（requiresPllClkHz = 0 ⇒ planClock 认为 USB 不可用，不会写 RCC.USBPrescaler），
        // 由调用方按族补规则 —— 宁可报 USB 不可用，也不拿 F1 的 72 MHz 规则套到别的族。
        usb: { hz: 48_000_000, requiresPllClkHz: 0, iocValue: "" },
        peripheralClocks: F1_PERIPHERAL_CLOCKS,
        baudList: F1_BAUD_LIST,
    };
}
