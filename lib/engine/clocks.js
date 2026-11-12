/**
 * 时钟树：从 .ioc 的 `RCC.*` 键读出各路时钟频率与分频，供调试台的时钟页显示。
 *
 * 与 `src/data/clock-db.ts` 的分工：那个模块按芯片算「目标频率该怎么配 PLL」，
 * 是写 .ioc 之前的规划；这里只读已经写进 .ioc 的结果，不推导、不修改。
 * 频率一律取 CubeMX 自己写下的 `*Freq_Value` 键——插件复算容易与 CubeMX 的取整口径不一致。
 */
import { readFileSync } from "node:fs";
import { parseIocEntries } from "./ioc.js";
import { findIocPath } from "./pinout.js";
const NODE_SPECS = [
    { label: "SYSCLK", key: "RCC.SYSCLKFreq_VALUE" },
    { label: "HCLK / AHB", key: "RCC.AHBFreq_Value" },
    { label: "PCLK1 / APB1", key: "RCC.APB1Freq_Value", dividerKey: "RCC.APB1CLKDivider" },
    { label: "PCLK2 / APB2", key: "RCC.APB2Freq_Value", dividerKey: "RCC.APB2CLKDivider" },
    { label: "TIM (APB1)", key: "RCC.APB1TimFreq_Value" },
    { label: "TIM (APB2)", key: "RCC.APB2TimFreq_Value" },
    { label: "Cortex 内核", key: "RCC.FCLKCortexFreq_Value" },
    { label: "ADC", key: "RCC.ADCFreqValue" },
    { label: "USB", key: "RCC.USBFreq_Value" },
    { label: "SysTick", key: "RCC.TimSysFreq_Value" },
    { label: "MCO", key: "RCC.MCOFreq_Value" },
];
/** `.ioc` 的频率值是十进制整数；带小数的写法一律视为没有。 */
export function parseHz(raw) {
    if (raw === undefined)
        return null;
    const text = raw.trim();
    if (!/^\d+$/u.test(text))
        return null;
    const value = Number(text);
    return Number.isSafeInteger(value) ? value : null;
}
/** `RCC_HCLK_DIV2` → `÷2`；`RCC_SYSCLK_DIV1` → `÷1`。认不出就原样返回。 */
export function dividerLabel(raw) {
    const match = /_DIV(\d+)$/u.exec(raw.trim());
    return match === null || match[1] === undefined ? raw : "÷" + match[1];
}
const SYSCLK_SOURCES = {
    RCC_SYSCLKSOURCE_HSI: "HSI",
    RCC_SYSCLKSOURCE_HSE: "HSE",
    RCC_SYSCLKSOURCE_PLLCLK: "PLL",
    RCC_SYSCLKSOURCE_PLLRCLK: "PLLR",
    RCC_SYSCLKSOURCE_MSI: "MSI",
    RCC_SYSCLKSOURCE_HSI48: "HSI48",
};
const PLL_SOURCES = {
    RCC_PLLSOURCE_HSI: "HSI",
    RCC_PLLSOURCE_HSE: "HSE",
    RCC_PLLSOURCE_HSI_DIV2: "HSI/2",
    RCC_PLLSOURCE_MSI: "MSI",
};
/** `RCC_PLL_MUL9` → `×9`。 */
export function mulLabel(raw) {
    const match = /_MUL(\d+)$/u.exec(raw.trim());
    return match === null || match[1] === undefined ? raw : "×" + match[1];
}
export function readClockTree(projectDir) {
    const dir = projectDir.trim();
    if (dir === "")
        return { ok: false, error: "projectDir 不能为空" };
    const iocPath = findIocPath(dir);
    if (iocPath === "")
        return { ok: false, error: "工程目录里没有可读的 .ioc：" + dir };
    let entries;
    try {
        entries = parseIocEntries(readFileSync(iocPath, "utf8"));
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: "读取 .ioc 失败：" + message };
    }
    const used = new Set();
    const nodes = NODE_SPECS.map((spec) => {
        used.add(spec.key);
        if (spec.dividerKey !== undefined)
            used.add(spec.dividerKey);
        const divider = spec.dividerKey === undefined ? "" : dividerLabel(entries.get(spec.dividerKey) ?? "");
        return { label: spec.label, hz: parseHz(entries.get(spec.key)), key: spec.key, divider };
    });
    const others = [];
    for (const [key, value] of entries) {
        if (!key.startsWith("RCC.") || !/Freq/iu.test(key) || used.has(key))
            continue;
        const hz = parseHz(value);
        if (hz === null)
            continue;
        others.push({ label: key.slice("RCC.".length), hz, key, divider: "" });
    }
    others.sort((left, right) => left.key.localeCompare(right.key, "en"));
    const source = entries.get("RCC.SYSCLKSource") ?? "";
    const pllSource = entries.get("RCC.PLLSourceVirtual") ?? entries.get("RCC.PLLSource") ?? "";
    const pllMul = entries.get("RCC.PLLMUL") ?? entries.get("RCC.PLLMultiplier") ?? "";
    return {
        ok: true,
        report: {
            projectDir: dir,
            iocPath,
            cpn: entries.get("Mcu.CPN") ?? "",
            sysclkSource: source,
            sysclkSourceLabel: SYSCLK_SOURCES[source] ?? source,
            pll: {
                source: pllSource,
                sourceLabel: PLL_SOURCES[pllSource] ?? pllSource,
                mul: pllMul,
                mulLabel: mulLabel(pllMul),
            },
            nodes,
            others,
        },
    };
}
