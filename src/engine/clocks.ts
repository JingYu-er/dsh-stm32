/**
 * 时钟树：从 .ioc 的 `RCC.*` 键读出各路时钟频率与分频，供调试台的时钟页显示。
 *
 * 与 `src/data/clock-db.ts` 的分工：那个模块按芯片算「目标频率该怎么配 PLL」，
 * 是写 .ioc 之前的规划；这里只读已经写进 .ioc 的结果，不推导、不修改。
 * 频率一律取 CubeMX 自己写下的 `*Freq_Value` 键——插件复算容易与 CubeMX 的取整口径不一致。
 */

import { readFileSync } from "node:fs";

import { BUS_LIMITS, type BusLimits } from "../data/clock-db.js";
import { parseIocEntries } from "./ioc.js";
import { findIocPath } from "./pinout.js";

export interface ClockNode {
  /** 显示名：SYSCLK / AHB / APB1 … */
  readonly label: string;
  /** 这一路的频率（Hz）；.ioc 没写就是 null。 */
  readonly hz: number | null;
  /** 该路在 .ioc 里的键名，便于对照原始文件。 */
  readonly key: string;
  /** 分频说明，例如 ÷2；没有就空串。 */
  readonly divider: string;
  /** 这一路的手册上限（Hz）；没有上限或芯片族不在表里时为 null。 */
  readonly limitHz: number | null;
  /** 频率是否超过手册上限（S66）。 */
  readonly overLimit: boolean;
  /** 超限时的修法建议（S71）；未超限为空串。 */
  readonly suggest: string;
}

export interface ClockTreeReport {
  readonly projectDir: string;
  readonly iocPath: string;
  readonly cpn: string;
  /** 系统时钟源（原始键值，例如 RCC_SYSCLKSOURCE_PLLCLK）。 */
  readonly sysclkSource: string;
  /** 系统时钟源的可读名，例如 PLL。 */
  readonly sysclkSourceLabel: string;
  /** PLL 输入源与倍频（原始键值与可读值）。 */
  readonly pll: { source: string; sourceLabel: string; mul: string; mulLabel: string };
  /** 主要节点，按树顺序：源 → SYSCLK → AHB → 四路 APB / ADC / USB。 */
  readonly nodes: readonly ClockNode[];
  /** 解析到的其它 RCC.*Freq* 键，供排查。 */
  readonly others: readonly ClockNode[];
  /** 该型号所属族的总线上限；族不在表里时为 null。 */
  readonly limits: { readonly family: string; readonly apb1Hz: number; readonly apb2Hz: number; readonly adcHz: number } | null;
}

export type ClockTreeResult = { readonly ok: true; readonly report: ClockTreeReport } | { readonly ok: false; readonly error: string };

interface NodeSpec {
  readonly label: string;
  readonly key: string;
  readonly dividerKey?: string;
}

const NODE_SPECS: readonly NodeSpec[] = [
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

/**
 * 型号 → 总线上限表的键（S66），例如 STM32F103C8T6 → STM32F1、STM32G431CBT6 → STM32G4。
 * 表里没有的族返回空串；此时不做上限判断，而不是猜一个值。
 */
export function familyOfCpn(cpn: string): string {
  const match = /^STM32([A-Z])(\d)/u.exec(cpn.trim().toUpperCase());
  if (match === null || match[1] === undefined || match[2] === undefined) return "";
  const family = "STM32" + match[1] + match[2];
  return BUS_LIMITS[family] === undefined ? "" : family;
}

/** 节点 → 该族总线上限；只有真正受手册约束的三路给出上限。 */
export function limitForNode(label: string, limits: BusLimits | null): number | null {
  if (limits === null) return null;
  if (label === "PCLK1 / APB1") return limits.apb1Hz;
  if (label === "PCLK2 / APB2") return limits.apb2Hz;
  if (label === "ADC") return limits.adcHz;
  return null;
}

/** 各总线允许的分频档；F1 的 APB 分频与 ADC 预分频不是同一组。 */
const APB_DIVISORS = [2, 4, 8, 16];
const ADC_DIVISORS = [2, 4, 6, 8];

/**
 * 超限修法（S71）：算出「最小够用的分频档」，让人不必自己除。
 *
 * 只给分频建议，不写 .ioc——改配置仍走 stm32_ioc_plan，那里会重算全部派生键。
 */
export function suggestFix(
  label: string,
  hz: number | null,
  limitHz: number | null,
  baseHz: number | null = null,
): string {
  if (hz === null || limitHz === null || hz <= limitHz) return "";
  const isAdc = label === "ADC";
  const isApb = label === "PCLK1 / APB1" || label === "PCLK2 / APB2";
  if (!isAdc && !isApb) return "";
  const divisors = isAdc ? ADC_DIVISORS : APB_DIVISORS;
  // 分频器挂在父时钟上：ADC 预分频除 PCLK2、APB 分频除 HCLK。
  // 直接拿「当前频率 ÷ 分频」会把 36/4=9 这种不存在的档位说给人听。
  const source = baseHz !== null && baseHz > 0 ? baseHz : hz;
  const knob = isAdc ? "ADC 预分频" : label === "PCLK1 / APB1" ? "APB1 分频" : "APB2 分频";
  for (const divisor of divisors) {
    const next = source / divisor;
    if (next <= limitHz) {
      const mhz = (next / 1_000_000).toFixed(1).replace(/\.0$/u, "");
      return "把 " + knob + "改成 ÷" + String(divisor) + "（" + mhz + " MHz）";
    }
  }
  return "现有分频档都不够，需要降低源频率";
}

/** `.ioc` 的频率值是十进制整数；带小数的写法一律视为没有。 */
export function parseHz(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const text = raw.trim();
  if (!/^\d+$/u.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/** `RCC_HCLK_DIV2` → `÷2`；`RCC_SYSCLK_DIV1` → `÷1`。认不出就原样返回。 */
export function dividerLabel(raw: string): string {
  const match = /_DIV(\d+)$/u.exec(raw.trim());
  return match === null || match[1] === undefined ? raw : "÷" + match[1];
}

const SYSCLK_SOURCES: Record<string, string> = {
  RCC_SYSCLKSOURCE_HSI: "HSI",
  RCC_SYSCLKSOURCE_HSE: "HSE",
  RCC_SYSCLKSOURCE_PLLCLK: "PLL",
  RCC_SYSCLKSOURCE_PLLRCLK: "PLLR",
  RCC_SYSCLKSOURCE_MSI: "MSI",
  RCC_SYSCLKSOURCE_HSI48: "HSI48",
};

const PLL_SOURCES: Record<string, string> = {
  RCC_PLLSOURCE_HSI: "HSI",
  RCC_PLLSOURCE_HSE: "HSE",
  RCC_PLLSOURCE_HSI_DIV2: "HSI/2",
  RCC_PLLSOURCE_MSI: "MSI",
};

/** `RCC_PLL_MUL9` → `×9`。 */
export function mulLabel(raw: string): string {
  const match = /_MUL(\d+)$/u.exec(raw.trim());
  return match === null || match[1] === undefined ? raw : "×" + match[1];
}

export function readClockTree(projectDir: string): ClockTreeResult {
  const dir = projectDir.trim();
  if (dir === "") return { ok: false, error: "projectDir 不能为空" };
  const iocPath = findIocPath(dir);
  if (iocPath === "") return { ok: false, error: "工程目录里没有可读的 .ioc：" + dir };
  let entries: Map<string, string>;
  try {
    entries = parseIocEntries(readFileSync(iocPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: "读取 .ioc 失败：" + message };
  }
  const used = new Set<string>();
  const cpn = entries.get("Mcu.CPN") ?? "";
  const hclkHz = parseHz(entries.get("RCC.AHBFreq_Value"));
  // .ioc 里没有 ADC 外设时，ADCFreqValue 只是 CubeMX 顺手算出的派生键，不是真在用的时钟。
  const adcUsed = [...entries.values()].some((value) => /^ADC\d/u.test(value.trim()));
  const apb2Hz = parseHz(entries.get("RCC.APB2Freq_Value"));
  const family = familyOfCpn(cpn);
  const limits: BusLimits | null = family === "" ? null : (BUS_LIMITS[family] ?? null);
  const nodes: ClockNode[] = NODE_SPECS.map((spec) => {
    used.add(spec.key);
    if (spec.dividerKey !== undefined) used.add(spec.dividerKey);
    const divider = spec.dividerKey === undefined ? "" : dividerLabel(entries.get(spec.dividerKey) ?? "");
    const hz = parseHz(entries.get(spec.key));
    const limitHz = limitForNode(spec.label, limits);
    const overLimit = hz !== null && limitHz !== null && hz > limitHz;
    const baseHz = spec.label === "ADC" ? apb2Hz : spec.label.startsWith("PCLK") ? hclkHz : null;
    return {
      label: spec.label,
      hz,
      key: spec.key,
      divider,
      limitHz,
      overLimit,
      suggest: (() => {
        if (!overLimit) return "";
        const fix = suggestFix(spec.label, hz, limitHz, baseHz);
        if (fix === "") return "";
        return spec.label === "ADC" && !adcUsed ? "工程没有启用 ADC，这条不影响运行；启用时" + fix : fix;
      })(),
    };
  });
  const others: ClockNode[] = [];
  for (const [key, value] of entries) {
    if (!key.startsWith("RCC.") || !/Freq/iu.test(key) || used.has(key)) continue;
    const hz = parseHz(value);
    if (hz === null) continue;
    others.push({ label: key.slice("RCC.".length), hz, key, divider: "", limitHz: null, overLimit: false, suggest: "" });
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
      cpn,
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
      limits: limits === null ? null : { family, apb1Hz: limits.apb1Hz, apb2Hz: limits.apb2Hz, adcHz: limits.adcHz },
    },
  };
}
