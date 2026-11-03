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
 * 早先以为「APB1/APB2/ADC 的频率上限 db 里没有」，实测是错的：`RCC-*_Modes.xml` 里
 * `<RefParameter Name="APB1Freq_Value" Max="30000000">`、`APB2Freq_Value`、`ADCFreq_Value`、
 * `VCOOutputFreq_Value`、`VCOInputFreq_Value`、`SYSCLKFreq_VALUE` 的 Min/Max 就是
 * CubeMX 自己校验的上限，所以这里按族从 db 读（见 readClockDbFacts）。
 * 但 db 是**按 RCC IP 版本**给值，个别族偏保守（F103 走 RCC-STM32F102，APB2 只给 36/48 MHz，
 * 实际 72 MHz），所以核过手册/真机的族用 BUS_LIMITS / PLL_VCO_LIMITS 的 override。
 * db 里确实没有的：USB 需要的 48 MHz 规则。
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
/** 取 RefParameter 的数值属性；`Max="=SYSCLKFreq_VALUE"` 这类表达式直接丢弃（不是数字）。 */
function numAttr(attrs, key) {
    const raw = new RegExp('\\b' + key + '="([^"]*)"', "u").exec(attrs)?.[1];
    if (raw === undefined)
        return null;
    const text = raw.trim();
    if (text === "" || text.startsWith("="))
        return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
}
/**
 * 取同名 RefParameter 的 Min/Max（"APB1Freq_Value" 这种）。
 *
 * 同名参数在 Modes xml 里常常有多个**变体**，各自带 `<Condition Expression="scale1">`
 * （G0/U0 的 ADC 35000000/16000000/80000000、G4 的 APB1 150M/170M 都是这种）。
 * 这里取「最小的 Min + 最大的 Max」：CubeMX 允许多少就给多少，规划出来的档位不会因为
 * 取错变体而被无故拒绝；真正的兜底还有后面的 SYSCLK 上限与 CubeMX 自己的校验。
 * 名字按顺序试，先读出 Max 的优先（APB1Freq_Value 优先于单 APB 族的 APBFreq_Value）。
 */
function limitOf(text, names) {
    const re = (name) => new RegExp('<RefParameter[^>]*Name="' + name + '"[^>]*>', "gu");
    for (const name of names) {
        let min = null;
        let max = null;
        for (const matched of text.matchAll(re(name))) {
            const one = numAttr(matched[0], "Min");
            const other = numAttr(matched[0], "Max");
            if (one !== null)
                min = min === null ? one : Math.min(min, one);
            if (other !== null)
                max = max === null ? other : Math.max(max, other);
        }
        if (max !== null)
            return { min, max };
    }
    return null;
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
    const pllR = enumOf(text, "PLLR")
        .map((entry) => ({ div: entry.num ?? 0, iocValue: entry.value }))
        .filter((item) => item.div >= 1 && item.iocValue !== "")
        .sort((left, right) => left.div - right.div);
    const pllP = enumOf(text, "PLLP")
        .map((entry) => ({ div: entry.num ?? 0, iocValue: entry.value }))
        .filter((item) => item.div >= 1 && item.iocValue !== "")
        .sort((left, right) => left.div - right.div);
    const pllN = rangeOf(text, "PLLN");
    // PLLP 只有 DIV7/DIV17 = 那是 PLLSAI1 的输出，SYSCLK 走 PLLR（L4 的 RCC-STM32L4*）。
    const pllPIsSai = pllP.length > 0 && pllP.every((item) => item.div === 7 || item.div === 17);
    const sysclkOutput = pllPIsSai && pllR.length > 0 ? "R" : "P";
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
    const ahbDivs = toDivs(enumOf(text, "AHBCLKDivider"));
    const adcDivs = toDivs(enumOf(text, "ADCPresc"));
    // 总线上限与 VCO 区间：都在同一份 Modes xml 的 RefParameter Max/Min 里（CubeMX 自己校验用）。
    const sysclkMaxDbHz = limitOf(text, ["SYSCLKFreq_VALUE", "HCLKFreq_Value"])?.max ?? 0;
    const apb1 = limitOf(text, ["APB1Freq_Value", "APBFreq_Value"]);
    const apb2 = limitOf(text, ["APB2Freq_Value", "APBFreq_Value"]);
    const adcLimit = limitOf(text, ["ADCFreq_Value", "ADC12outputFreq_Value", "synchADCFreq_Value"]);
    const apb1Max = apb1?.max ?? null;
    const busLimits = apb1Max === null
        ? null
        : {
            apb1Hz: apb1Max,
            apb2Hz: apb2?.max ?? apb1Max,
            // 没有独立 ADC 上限的族（L1 的 ADCFreq_Value 没有 Max）先按 APB2 顶住，
            // 反正 adcDivs 为空时 planner 不写 ADCPresc，这条不会生效。
            adcHz: adcLimit?.max ?? apb2?.max ?? apb1Max,
        };
    if (busLimits === null) {
        notes.push("db 的 RCC Modes 里没有 APB1Freq_Value/APBFreq_Value 的 Max：这一族的总线上限读不出来");
    }
    const vcoOut = limitOf(text, ["VCOOutputFreq_Value"]);
    const vcoIn = limitOf(text, ["VCOInputFreq_Value"]);
    const vcoMinHz = vcoOut?.min ?? null;
    const vcoMaxHz = vcoOut?.max ?? null;
    const vco = vcoMinHz === null || vcoMaxHz === null || vcoMinHz <= 0 || vcoMinHz >= vcoMaxHz
        ? null
        : {
            minHz: vcoMinHz,
            maxHz: vcoMaxHz,
            ...(vcoIn?.min === null || vcoIn?.min === undefined ? {} : { inMinHz: vcoIn.min }),
            ...(vcoIn?.max === null || vcoIn?.max === undefined ? {} : { inMaxHz: vcoIn.max }),
        };
    // SYSCLK 源按 db 的 RefParameter 名字决定：有 SYSCLKSourceVirtual 就只能写它（F303）。
    const sysclkSourceKey = /\bName="SYSCLKSourceVirtual"/u.test(text) ? "RCC.SYSCLKSourceVirtual" : "RCC.SYSCLKSource";
    return {
        model,
        sysclkMaxHz: Math.round((facts.frequencyMhz ?? 0) * 1_000_000),
        sysclkMaxDbHz,
        sysclkSourceKey,
        busLimits,
        vco,
        muls,
        sources,
        apbDivs: apbDivs.length > 0 ? apbDivs : [1, 2, 4, 8, 16].map((div) => ({ div, iocValue: "RCC_HCLK_DIV" + String(div) })),
        ahbDivs,
        adcDivs,
        pllM,
        pllN,
        pllP,
        pllR,
        sysclkOutput,
        notes,
        sourceFile: path ?? "",
    };
}
export const BUS_LIMITS = {
    // RM0090（F4）：APB1 ≤42 MHz、APB2 ≤84 MHz、ADC ≤36 MHz（ADC 走 APB2 再分频）
    STM32F4: { apb1Hz: 42_000_000, apb2Hz: 84_000_000, adcHz: 36_000_000 },
    // RM0385/RM0410（F7）：APB1 ≤54 MHz、APB2 ≤108 MHz、ADC ≤36 MHz
    STM32F7: { apb1Hz: 54_000_000, apb2Hz: 108_000_000, adcHz: 36_000_000 },
    // RM0440（G4）：APB1/APB2 都能跑到 SYSCLK；ADC 时钟不走 RCC 预分频（由 ADC12CLockSelection 选）
    STM32G4: { apb1Hz: 170_000_000, apb2Hz: 170_000_000, adcHz: 60_000_000 },
    // RM0351（L4）：APB1/APB2 = AHB（≤80 MHz）；ADC 时钟来自 PLLSAI1 或 SYSCLK
    STM32L4: { apb1Hz: 80_000_000, apb2Hz: 80_000_000, adcHz: 80_000_000 },
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
    // RM0385/RM0410（F7）：同 F4 的 PLL 结构
    STM32F7: { minHz: 100_000_000, maxHz: 432_000_000, inMinHz: 1_000_000, inMaxHz: 2_000_000 },
    // RM0440（G4）：PLL 输入 2.66–16 MHz，VCO 96–344 MHz
    STM32G4: { minHz: 96_000_000, maxHz: 344_000_000, inMinHz: 2_660_000, inMaxHz: 16_000_000 },
    // RM0351（L4）：PLL 输入 4–16 MHz，VCO 64–344 MHz
    STM32L4: { minHz: 64_000_000, maxHz: 344_000_000, inMinHz: 4_000_000, inMaxHz: 16_000_000 },
};
/**
 * db 事实 + 该族总线上限 → planClock 认的 ClockFacts。
 * 返回 null 表示这一族还不能规划（没有总线上限、或 PLL 模型不是 pllmul）。
 */
export function clockFactsFromDb(facts, familyId) {
    const family = familyId.trim().toUpperCase();
    const limits = BUS_LIMITS[family] ?? facts.busLimits;
    if (limits === null)
        return null;
    if (facts.sources.length === 0)
        return null;
    // SYSCLK 上限三级回退：MCU xml 的 <Frequency> → db 的 SYSCLKFreq_VALUE Max → APB2 上限。
    // 第三级是兜底（G4/U0 的 <Frequency> 读出来是 0，但它们的 SYSCLKFreq_VALUE Max 是有的）。
    const sysclkHz = facts.sysclkMaxHz > 0 ? facts.sysclkMaxHz : facts.sysclkMaxDbHz > 0 ? facts.sysclkMaxDbHz : limits.apb2Hz;
    const base = {
        sources: facts.sources,
        apbDivs: facts.apbDivs,
        sysclkSourceKey: facts.sysclkSourceKey,
        ...(facts.ahbDivs.length > 0 ? { ahbDivs: facts.ahbDivs } : {}),
        adcDivs: facts.adcDivs.length > 0 ? facts.adcDivs : [{ div: 1, iocValue: "" }],
        limits: {
            sysclkHz,
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
        const vco = PLL_VCO_LIMITS[family] ?? facts.vco;
        if (vco === null)
            return null;
        const outputDivs = facts.sysclkOutput === "R" ? facts.pllR : facts.pllP;
        if (facts.pllM.length === 0 || outputDivs.length === 0 || facts.pllN === null)
            return null;
        return {
            ...base,
            model: "pllmn",
            vco,
            muls: [],
            pllM: facts.pllM,
            pllN: facts.pllN,
            pllP: facts.pllP,
            pllR: facts.pllR,
            sysclkOutput: facts.sysclkOutput,
        };
    }
    if (facts.model !== "pllmul")
        return null;
    if (facts.muls.length === 0)
        return null;
    return {
        muls: facts.muls,
        sources: facts.sources,
        apbDivs: facts.apbDivs,
        sysclkSourceKey: facts.sysclkSourceKey,
        ...(facts.ahbDivs.length > 0 ? { ahbDivs: facts.ahbDivs } : {}),
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
