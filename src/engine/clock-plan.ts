/**
 * L2：F1 时钟规划 —— 把「我要 60 MHz」变成一整套 RCC 键值 + 逐外设频率表。
 *
 * 为什么不是独立工具：时钟就是 .ioc 里的一段键，单开一个 stm32_clock_plan 会让"改引脚"和
 * "改时钟"变成两次 plan、两次 apply，中间还可能出现 PLL 与 APB 分频不自洽的中间态。
 * 所以 clock 作为 stm32_ioc_plan 的一个入参，和 entries/pins 一起算、一起写、一起回滚。
 *
 * 三条硬规则（踩坑换来的）：
 * 1) 只改 RCC.PLLMUL 是不够的：CubeMX 按 RCC.*Freq_Value 生成 SystemClock_Config，
 *    20 个派生键必须成套重算，否则 HAL_RCC_ClockConfig 用旧值算错总线频率。
 * 2) 目标频率可能根本不可达（板上 8 MHz HSE 只能出 8 的整数倍）。这时不猜、不静默：取
 *    绝对值最接近的那一档，并在 note 里明写「不可达，已选 X MHz」。
 * 3) F1 的 USB 只能从 PLLCLK÷1.5 得到 48 MHz，所以只有 PLLCLK=72 MHz 时 USB 可用；
 *    其它频率下 USBFreq_Value 退化成 PLLCLK，报告必须点明"USB 不可用"。
 */

import {
  F1_ADC_DIVS,
  F1_APB_DIVS,
  F1_BAUD_LIST,
  F1_CLOCK_LIMITS,
  F1_PERIPHERAL_CLOCKS,
  F1_PLL_MULS,
  F1_PLL_SOURCES,
  F1_USB_PRESCALER,
  adcDivFromValue,
  adcDivValue,
  apbDivFromValue,
  apbDivValue,
  pllMulValue,
  pllSourceById,
} from "../data/clock-f1.js";
import type {
  ClockSourceId,
  DividerFact,
  PeripheralClockFact,
  PllSourceFact,
} from "../data/clock-f1.js";

/** 入参：要么给 targetHz（就近搜），要么给 pllMul（定点）。两者都给时 pllMul 优先。 */
export interface ClockPlanRequest {
  /** 目标 SYSCLK（Hz），例如 60_000_000。 */
  targetHz?: number;
  /** 指定 PLL 输入源；缺省按 .ioc 里有没有配 HSE 晶振来定。 */
  pllSource?: ClockSourceId;
  /** 指定倍频（×2..×16）；给了就按定点算，不再就近搜。 */
  pllMul?: number;
  /** 指定 APB1 分频；缺省取满足 APB1≤36 MHz 的最小分频。 */
  apb1Div?: number;
  /** 指定 APB2 分频；缺省 1（APB2 降频只会拖慢外设，没理由主动降）。 */
  apb2Div?: number;
  /** 指定 ADC 预分频；缺省取满足 ADC≤14 MHz 的最小分频。 */
  adcDiv?: number;
  /** 覆盖 HSE 频率（Hz）；缺省读 RCC.HSE_VALUE，再缺省 8 MHz。 */
  hseHz?: number;
  /** 强制按"要用 USB"来规划（写 RCC.USBPrescaler）；缺省看 Mcu.IP* 里有没有 USB。 */
  usb?: boolean;
  /** 要算整除误差的波特率档；缺省 F1_BAUD_LIST。 */
  bauds?: number[];
}

/** 规划后的时钟链（全部 Hz）。 */
export interface ClockChainInfo {
  pllSource: string;
  pllSourceLabel: string;
  pllInHz: number;
  pllMul: number;
  pllClkHz: number;
  sysclkHz: number;
  hclkHz: number;
  apb1Div: number;
  apb1Hz: number;
  apb1TimHz: number;
  apb2Div: number;
  apb2Hz: number;
  apb2TimHz: number;
  adcDiv: number;
  adcHz: number;
  /** USB 时钟：可用时 48 MHz，不可用时退化成 PLLCLK（CubeMX 就是这么写的）。 */
  usbHz: number;
  usbAvailable: boolean;
  /** 是否真的写 RCC.USBPrescaler=÷1.5。 */
  usbPrescaled: boolean;
  mcoHz: number;
}

export interface ClockRequestedInfo {
  targetHz: number;
  pllSource: string;
  pllMul: number;
  apb1Div: number;
  apb2Div: number;
  adcDiv: number;
}

export interface ClockAlternative {
  sysclkHz: number;
  pllSource: string;
  pllSourceLabel: string;
  pllMul: number;
  apb1Div: number;
  adcDiv: number;
  usbAvailable: boolean;
  /** achieved - target（带符号）。 */
  deltaHz: number;
}

export interface ClockPeripheral {
  id: string;
  label: string;
  /** ahb / apb1 / apb2。 */
  bus: string;
  clockHz: number;
  note: string;
}

export interface ClockBaudRow {
  baud: number;
  /** USART_BRR 的整数值（F1 用 16 倍过采样：BRR = round(fCK/baud)）。 */
  brr: number;
  actualBaud: number;
  /** 相对误差（%），正数 = 实际偏快。 */
  errorPercent: number;
}

export interface ClockBaudTable {
  id: string;
  clockHz: number;
  worstBaud: number;
  worstErrorPercent: number;
  rows: ClockBaudRow[];
}

export interface ClockIocEntry {
  key: string;
  value: string;
}

export interface ClockPlan {
  /** snapshot = 没请求（只读现状）；nearest = 就近搜；explicit = 定点；none = 参数不成立。 */
  mode: "snapshot" | "nearest" | "explicit" | "none";
  ok: boolean;
  /** 目标是否精确命中（false = 不可达，已取最近档）。 */
  reachable: boolean;
  /** achieved - requested.targetHz。 */
  deltaHz: number;
  /** 人读结论：命中就说命中，不可达必须写「不可达，已选 X MHz」。 */
  note: string;
  requested: ClockRequestedInfo;
  achieved: ClockChainInfo;
  alternatives: ClockAlternative[];
  peripherals: ClockPeripheral[];
  bauds: ClockBaudTable[];
  /** 要写进 .ioc 的 RCC 键（含 RCC.IPParameters 的合并结果）。 */
  entries: ClockIocEntry[];
  /** 要删掉的键（例如 SYSCLK≠72 时残留的 RCC.USBPrescaler）。 */
  unset: string[];
  warnings: string[];
  errors: string[];
}

export interface ClockPlanContext {
  /** 当前 .ioc 的键值（只读）：用它判断有没有 HSE 晶振、HSE_VALUE、MCOSource、USB 是否启用。 */
  entries: Map<string, string>;
}

const ZERO_CHAIN: ClockChainInfo = {
  pllSource: "",
  pllSourceLabel: "",
  pllInHz: 0,
  pllMul: 0,
  pllClkHz: 0,
  sysclkHz: 0,
  hclkHz: 0,
  apb1Div: 0,
  apb1TimHz: 0,
  apb1Hz: 0,
  apb2Div: 0,
  apb2Hz: 0,
  apb2TimHz: 0,
  adcDiv: 0,
  adcHz: 0,
  usbHz: 0,
  usbAvailable: false,
  usbPrescaled: false,
  mcoHz: 0,
};

const ZERO_REQUESTED: ClockRequestedInfo = {
  targetHz: 0,
  pllSource: "",
  pllMul: 0,
  apb1Div: 0,
  apb2Div: 0,
  adcDiv: 0,
};

/** 没有 .ioc / 参数不成立时给宿主一个形状合法的空计划（宿主不接受 null）。 */
export function emptyClockPlan(note: string): ClockPlan {
  return {
    mode: "none",
    ok: false,
    reachable: false,
    deltaHz: 0,
    note,
    requested: { ...ZERO_REQUESTED },
    achieved: { ...ZERO_CHAIN },
    alternatives: [],
    peripherals: [],
    bauds: [],
    entries: [],
    unset: [],
    warnings: [],
    errors: [],
  };
}

/** Hz → 人读（72 MHz / 10.667 MHz / 250 kHz）。 */
export function formatHz(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return "0 Hz";
  if (hz >= 1_000_000) {
    const mhz = hz / 1_000_000;
    const text = Number.isInteger(mhz) ? String(mhz) : mhz.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "");
    return text + " MHz";
  }
  if (hz >= 1000) return String(Math.round(hz / 1000)) + " kHz";
  return String(hz) + " Hz";
}

/** RCC.HSE_VALUE（Hz）；没有就按 8 MHz。 */
function readHseHz(entries: Map<string, string>): number {
  const raw = entries.get("RCC.HSE_VALUE") ?? "";
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 1_000_000 && parsed <= 32_000_000 ? parsed : 8_000_000;
}

/** .ioc 里配了 HSE 晶振没有：看有没有引脚的 Signal=RCC_OSC_IN。 */
function detectsHse(entries: Map<string, string>): boolean {
  for (const [key, value] of entries) {
    if (!key.endsWith(".Signal")) continue;
    if (value.trim() === "RCC_OSC_IN" || value.trim() === "RCC_OSC_OUT") return true;
  }
  return false;
}

/** Mcu.IP* 里启用的外设名集合。 */
function enabledIps(entries: Map<string, string>): Set<string> {
  const names = new Set<string>();
  const count = Number.parseInt(entries.get("Mcu.IPNb") ?? "0", 10);
  if (!Number.isFinite(count) || count <= 0) return names;
  for (let index = 0; index < count; index += 1) {
    const name = entries.get("Mcu.IP" + String(index));
    if (name !== undefined) names.add(name.trim().toUpperCase());
  }
  return names;
}

/** 满足 value/div ≤ limit 的最小分频；没有就 null。 */
function minimalDiv(divs: readonly DividerFact[], value: number, limit: number): DividerFact | null {
  for (const fact of divs) {
    if (Math.round(value / fact.div) <= limit) return fact;
  }
  return null;
}

function needDivText(divs: readonly DividerFact[], value: number, limit: number): string {
  const found = minimalDiv(divs, value, limit);
  return found === null ? "无解" : "÷" + String(found.div);
}

/** RCC_MCOSource → MCO 输出频率。 */
function mcoHzFor(mcoSource: string, values: { hseHz: number; pllClk: number; sysclk: number }): number {
  const source = mcoSource.trim().toUpperCase();
  if (source.includes("PLL")) return values.pllClk;
  if (source.includes("HSE")) return values.hseHz;
  if (source.includes("HSI")) return 8_000_000;
  return values.sysclk;
}

interface BuildInput {
  source: PllSourceFact;
  pllInHz: number;
  pllMul: number;
  apb1Div?: number;
  apb2Div?: number;
  adcDiv?: number;
  mcoSource: string;
  hseHz: number;
  /** true = 规划模式（ADC 超上限算错误）；false = 只读现状（ADC 超上限只在报告里点一句）。 */
  enforceAdc: boolean;
}

interface BuildResult {
  chain: ClockChainInfo;
  errors: string[];
}

function buildChain(input: BuildInput): BuildResult {
  const errors: string[] = [];
  const pllClk = input.pllInHz * input.pllMul;
  const sysclk = pllClk;
  const hclk = sysclk;
  if (sysclk > F1_CLOCK_LIMITS.sysclkHz) {
    errors.push(
      "SYSCLK " + formatHz(sysclk) + " 超过 F1 上限 " + formatHz(F1_CLOCK_LIMITS.sysclkHz) +
      "（" + input.source.label + " ×" + String(input.pllMul) + "）",
    );
  }

  let apb1Div = input.apb1Div;
  if (apb1Div === undefined) apb1Div = minimalDiv(F1_APB_DIVS, sysclk, F1_CLOCK_LIMITS.apb1Hz)?.div ?? 16;
  const apb1 = Math.round(sysclk / apb1Div);
  if (apb1 > F1_CLOCK_LIMITS.apb1Hz) {
    errors.push(
      "APB1 " + formatHz(apb1) + " 超过 F1 上限 " + formatHz(F1_CLOCK_LIMITS.apb1Hz) +
      "（APB1CLKDivider 至少要 " + needDivText(F1_APB_DIVS, sysclk, F1_CLOCK_LIMITS.apb1Hz) + "）",
    );
  }

  const apb2Div = input.apb2Div ?? 1;
  const apb2 = Math.round(sysclk / apb2Div);
  if (apb2 > F1_CLOCK_LIMITS.apb2Hz) {
    errors.push("APB2 " + formatHz(apb2) + " 超过 F1 上限 " + formatHz(F1_CLOCK_LIMITS.apb2Hz));
  }

  let adcDiv = input.adcDiv;
  if (adcDiv === undefined) adcDiv = minimalDiv(F1_ADC_DIVS, apb2, F1_CLOCK_LIMITS.adcHz)?.div ?? 8;
  const adc = Math.round(apb2 / adcDiv);
  if (adc > F1_CLOCK_LIMITS.adcHz && input.enforceAdc) {
    errors.push(
      "ADC " + formatHz(adc) + " 超过 F1 上限 " + formatHz(F1_CLOCK_LIMITS.adcHz) +
      "（ADCPresc 至少要 " + needDivText(F1_ADC_DIVS, apb2, F1_CLOCK_LIMITS.adcHz) + "）",
    );
  }

  const usbAvailable = pllClk === F1_USB_PRESCALER.requiresPllClkHz;
  const chain: ClockChainInfo = {
    pllSource: input.source.id,
    pllSourceLabel: input.source.label,
    pllInHz: input.pllInHz,
    pllMul: input.pllMul,
    pllClkHz: pllClk,
    sysclkHz: sysclk,
    hclkHz: hclk,
    apb1Div,
    apb1Hz: apb1,
    apb1TimHz: apb1Div === 1 ? apb1 : apb1 * 2,
    apb2Div,
    apb2Hz: apb2,
    apb2TimHz: apb2Div === 1 ? apb2 : apb2 * 2,
    adcDiv,
    adcHz: adc,
    usbHz: usbAvailable ? F1_USB_PRESCALER.hz : pllClk,
    usbAvailable,
    usbPrescaled: false,
    mcoHz: mcoHzFor(input.mcoSource, { hseHz: input.hseHz, pllClk, sysclk }),
  };
  return { chain, errors };
}

/** 某个外设最终拿到的时钟（TIM 在 APB≠1 时 ×2 这条规则在这里统一处理）。 */
export function peripheralClockHz(chain: ClockChainInfo, fact: PeripheralClockFact): number {
  if (fact.kind === "usb") return chain.usbHz;
  if (fact.kind === "adc") return chain.adcHz;
  if (fact.bus === "apb1") return fact.kind === "tim" ? chain.apb1TimHz : chain.apb1Hz;
  if (fact.bus === "apb2") return fact.kind === "tim" ? chain.apb2TimHz : chain.apb2Hz;
  return chain.hclkHz;
}

function peripheralReport(
  chain: ClockChainInfo,
  enabled: Set<string>,
  usbWanted: boolean,
): ClockPeripheral[] {
  const rows: ClockPeripheral[] = [];
  for (const fact of F1_PERIPHERAL_CLOCKS) {
    const notes: string[] = [];
    if (fact.kind === "adc") notes.push("APB2÷" + String(chain.adcDiv));
    if (fact.kind === "tim") {
      if (fact.bus === "apb1" && chain.apb1Div !== 1) notes.push("APB1÷" + String(chain.apb1Div) + "，定时器时钟 ×2");
      if (fact.bus === "apb2" && chain.apb2Div !== 1) notes.push("APB2÷" + String(chain.apb2Div) + "，定时器时钟 ×2");
    }
    if (fact.kind === "usb") {
      if (chain.usbAvailable) {
        notes.push(chain.usbPrescaled ? "PLLCLK÷1.5=48 MHz（启用 USB）" : "48 MHz 可用（启用 USB 后写 RCC.USBPrescaler=÷1.5）");
      } else {
        notes.push("不可用：USB 需要 PLLCLK=72 MHz（÷1.5=48 MHz），当前 PLLCLK " + formatHz(chain.pllClkHz));
      }
    }
    if (fact.kind === "core") notes.push("Cortex-M3 内核 / SysTick 跑 HCLK");
    const ip = fact.ip ?? fact.id;
    if (fact.kind !== "core" && !enabled.has(ip.toUpperCase())) notes.push("未在 .ioc 启用");
    if (fact.kind === "usb" && usbWanted && !chain.usbAvailable) notes.push("已请求 USB 但当前频率下拿不到 48 MHz");
    rows.push({
      id: fact.id,
      label: fact.label,
      bus: fact.bus,
      clockHz: peripheralClockHz(chain, fact),
      note: notes.join("；"),
    });
  }
  return rows;
}

function baudTables(chain: ClockChainInfo, bauds: readonly number[]): ClockBaudTable[] {
  const tables: ClockBaudTable[] = [];
  for (const fact of F1_PERIPHERAL_CLOCKS) {
    if (fact.kind !== "usart") continue;
    const clockHz = fact.bus === "apb2" ? chain.apb2Hz : chain.apb1Hz;
    const rows: ClockBaudRow[] = [];
    for (const baud of bauds) {
      // F1 用 16 倍过采样：USARTDIV = fCK/(16×baud)，BRR = round(USARTDIV×16) = round(fCK/baud)。
      const brr = Math.max(1, Math.round(clockHz / baud));
      const actual = clockHz / brr;
      rows.push({
        baud,
        brr,
        actualBaud: Math.round(actual * 1000) / 1000,
        errorPercent: Math.round(((actual - baud) / baud) * 1_000_000) / 10_000,
      });
    }
    let worst = rows[0];
    for (const row of rows) {
      if (worst === undefined || Math.abs(row.errorPercent) > Math.abs(worst.errorPercent)) worst = row;
    }
    tables.push({
      id: fact.id,
      clockHz,
      worstBaud: worst?.baud ?? 0,
      worstErrorPercent: worst?.errorPercent ?? 0,
      rows,
    });
  }
  return tables;
}

/** RCC.IPParameters 合并：已有名单 ∪ 现存 RCC.* 键 ∪ 本次写入，去掉本次删掉的，按字母序。 */
function mergeIpParameters(existing: string | undefined, draft: Map<string, string>, unset: readonly string[]): string {
  const names = new Set<string>();
  for (const part of (existing ?? "").split(",")) {
    const trimmed = part.trim();
    if (trimmed !== "") names.add(trimmed);
  }
  for (const key of draft.keys()) {
    if (key.startsWith("RCC.") && key !== "RCC.IPParameters") names.add(key.slice("RCC.".length));
  }
  for (const key of unset) {
    if (key.startsWith("RCC.") && key !== "RCC.IPParameters") names.delete(key.slice("RCC.".length));
  }
  return [...names].sort().join(",");
}

interface ChainWithSource {
  chain: ClockChainInfo;
}

/**
 * 规划时钟。request 为 undefined 时进入 snapshot 模式：只读 .ioc 现状，产出同样的频率表，
 * entries/unset 为空（一个字节都不改）。
 */
export function planClock(request: ClockPlanRequest | undefined, ctx: ClockPlanContext): ClockPlan {
  const entries = ctx.entries;
  const hseHz = request?.hseHz !== undefined && request.hseHz > 0 ? request.hseHz : readHseHz(entries);
  const mcoSource = entries.get("RCC.MCOSource") ?? "";
  const hasHse = detectsHse(entries);
  const enabled = enabledIps(entries);
  const usbWanted = request?.usb === true || enabled.has("USB");
  const bauds = (request?.bauds ?? F1_BAUD_LIST).filter((value) => Number.isFinite(value) && value > 0);
  const detected = pllSourceById(hasHse ? "hse" : "hsi-div2") ?? (F1_PLL_SOURCES[0] as PllSourceFact);

  if (request === undefined) {
    // 只读现状：按 .ioc 里记着的源/倍频/分频反推（缺键就用 CubeMX 的缺省值）。
    const storedSource = pllSourceById(entries.get("RCC.PLLSourceVirtual") ?? "");
    const source = storedSource !== null && storedSource.selectable ? storedSource : detected;
    const pllIn = source.id === "hse" ? hseHz : source.defaultHz;
    const mul = Number.parseInt((entries.get("RCC.PLLMUL") ?? "").replace(/^RCC_PLL_MUL/u, ""), 10);
    const pllMul = Number.isFinite(mul) && mul >= 2 && mul <= 16 ? mul : source.id === "hse" ? 9 : 16;
    const apb1Div = apbDivFromValue(entries.get("RCC.APB1CLKDivider") ?? "") ?? undefined;
    const apb2Div = apbDivFromValue(entries.get("RCC.APB2CLKDivider") ?? "") ?? undefined;
    const adcDiv = adcDivFromValue(entries.get("RCC.ADCPresc") ?? "") ?? undefined;
    const built = buildChain({ source, pllInHz: pllIn, pllMul, apb1Div, apb2Div, adcDiv, mcoSource, hseHz, enforceAdc: false });
    const chain: ClockChainInfo = {
      ...built.chain,
      usbPrescaled: built.chain.usbAvailable && entries.get("RCC.USBPrescaler") !== undefined,
    };
    return {
      mode: "snapshot",
      ok: built.errors.length === 0,
      reachable: true,
      deltaHz: 0,
      note: "没请求 clock：这是 .ioc 当前的时钟配置（只读，不写盘）。要改就传 clock:{ targetHz: 72000000 }。",
      requested: {
        targetHz: chain.sysclkHz,
        pllSource: chain.pllSource,
        pllMul: chain.pllMul,
        apb1Div: chain.apb1Div,
        apb2Div: chain.apb2Div,
        adcDiv: chain.adcDiv,
      },
      achieved: chain,
      alternatives: [],
      peripherals: peripheralReport(chain, enabled, usbWanted),
      bauds: baudTables(chain, bauds.length > 0 ? bauds : F1_BAUD_LIST),
      entries: [],
      unset: [],
      warnings: [],
      errors: [...built.errors],
    };
  }

  const wantsTarget = typeof request.targetHz === "number" && Number.isFinite(request.targetHz) && request.targetHz > 0;
  const wantsExplicit = typeof request.pllMul === "number" && request.pllMul >= 2 && request.pllMul <= 16;
  if (!wantsTarget && !wantsExplicit) {
    return {
      ...emptyClockPlan("clock 参数不成立：至少给 targetHz（目标 SYSCLK，Hz，例如 72000000）或 pllMul（×2..×16）"),
      errors: ["clock 参数不成立：至少给 targetHz（目标 SYSCLK，Hz，例如 72000000）或 pllMul（×2..×16）"],
    };
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  /** 定点模式：直接用给定倍频。 */
  if (wantsExplicit) {
    const source = (request.pllSource === undefined ? detected : pllSourceById(request.pllSource)) ?? detected;
    if (!source.selectable) errors.push(source.label + " 不能当 PLL 输入：" + source.note);
    const pllIn = source.id === "hse" ? hseHz : source.defaultHz;
    const built = buildChain({
      source,
      pllInHz: pllIn,
      pllMul: request.pllMul as number,
      apb1Div: request.apb1Div,
      apb2Div: request.apb2Div,
      adcDiv: request.adcDiv,
      mcoSource,
      hseHz,
      enforceAdc: true,
    });
    errors.push(...built.errors);
    const chain: ClockChainInfo = { ...built.chain };
    if (errors.length > 0) {
      return finish({ mode: "explicit", chain, source, errors, warnings, enabled, bauds, usbWanted, entries, targetHz: request.targetHz ?? chain.sysclkHz, reachable: false, alternatives: [] });
    }
    chain.usbPrescaled = chain.usbAvailable && (usbWanted || entries.get("RCC.USBPrescaler") !== undefined);
    const reachable = request.targetHz === undefined || request.targetHz === chain.sysclkHz;
    const alternatives = reachable ? [] : nearestList([], chain.sysclkHz, request.targetHz as number, hasHse, hseHz, request);
    return finish({
      mode: "explicit", chain, source, errors, warnings, enabled, bauds, usbWanted, entries,
      targetHz: request.targetHz ?? chain.sysclkHz, reachable, alternatives,
      explicitTargetHz: request.targetHz,
    });
  }

  // 就近搜：只搜 PLL 那条路（SYSCLK 必须来自 PLL，HSE/HSI 直通只在小频率下有意义，不规划）。
  const target = request.targetHz as number;
  const sources: PllSourceFact[] = [];
  const wantedSource = request.pllSource === undefined ? null : pllSourceById(request.pllSource);
  if (wantedSource !== null) {
    if (!wantedSource.selectable) return { ...emptyClockPlan(wantedSource.label + " 不能当 PLL 输入：" + wantedSource.note), errors: [wantedSource.note] };
    sources.push(wantedSource);
  } else {
    sources.push(detected);
  }
  const candidates: ClockChainInfo[] = [];
  /** 被上限/显式分频否掉的档：全部不可行时拿最近那档的理由当错误信息，别只说"没有可行组合"。 */
  const rejected: { sysclkHz: number; errors: string[] }[] = [];
  for (const source of sources) {
    const pllIn = source.id === "hse" ? hseHz : source.defaultHz;
    for (const fact of F1_PLL_MULS) {
      const built = buildChain({
        source,
        pllInHz: pllIn,
        pllMul: fact.mul,
        apb1Div: request.apb1Div,
        apb2Div: request.apb2Div,
        adcDiv: request.adcDiv,
        mcoSource,
        hseHz,
        enforceAdc: true,
      });
      if (built.errors.length > 0) {
        rejected.push({ sysclkHz: built.chain.sysclkHz, errors: built.errors });
        continue;
      }
      if (candidates.some((item) => item.sysclkHz === built.chain.sysclkHz)) continue;
      candidates.push({ ...built.chain, usbPrescaled: built.chain.usbAvailable && (usbWanted || entries.get("RCC.USBPrescaler") !== undefined) });
    }
  }
  if (candidates.length === 0) {
    rejected.sort((left, right) => Math.abs(left.sysclkHz - target) - Math.abs(right.sysclkHz - target));
    const nearest = rejected[0];
    const reasons = nearest === undefined ? [] : nearest.errors;
    if (reasons.length === 0) {
      const note = "没有可行组合：目标 " + formatHz(target) + " 在 " + (sources[0] as PllSourceFact).label + " 下没有任何合法 PLL 档";
      return { ...emptyClockPlan(note), errors: [note] };
    }
    return { ...emptyClockPlan("目标 " + formatHz(target) + " 没有可行组合：" + reasons.join("；")), errors: reasons };
  }
  candidates.sort((left, right) => {
    const gap = Math.abs(left.sysclkHz - target) - Math.abs(right.sysclkHz - target);
    // 距离相同取更高的那档：少失一点总是比多失一点好，也符合"60 → 64"的拍板。
    return gap !== 0 ? gap : right.sysclkHz - left.sysclkHz;
  });
  const chosen = candidates[0] as ClockChainInfo;
  const source = pllSourceById(chosen.pllSource) ?? detected;
  const reachable = chosen.sysclkHz === target;
  // 命中了就不再给备选（和 explicit 模式保持一致）；不可达才列附近档，方便用户改主意。
  const alternatives: ClockAlternative[] = reachable
    ? []
    : candidates
      .filter((item) => item.sysclkHz !== chosen.sysclkHz)
      .slice(0, 6)
      .map((item) => ({
        sysclkHz: item.sysclkHz,
        pllSource: item.pllSource,
        pllSourceLabel: item.pllSourceLabel,
        pllMul: item.pllMul,
        apb1Div: item.apb1Div,
        adcDiv: item.adcDiv,
        usbAvailable: item.usbAvailable,
        deltaHz: item.sysclkHz - target,
      }));
  return finish({
    mode: "nearest", chain: chosen, source, errors, warnings, enabled, bauds, usbWanted, entries,
    targetHz: target, reachable, alternatives,
  });
}

interface FinishInput {
  mode: "nearest" | "explicit";
  chain: ClockChainInfo;
  source: PllSourceFact;
  errors: string[];
  warnings: string[];
  enabled: Set<string>;
  bauds: readonly number[];
  usbWanted: boolean;
  entries: Map<string, string>;
  targetHz: number;
  reachable: boolean;
  alternatives: ClockAlternative[];
  explicitTargetHz?: number;
}

/** 收尾：note + 派生键 + IPParameters + 报告。 */
function finish(input: FinishInput): ClockPlan {
  const chain = input.chain;
  const warnings = [...input.warnings];
  const errors = [...input.errors];
  const parts: string[] = [];
  const delta = input.targetHz > 0 ? chain.sysclkHz - input.targetHz : 0;

  if (input.mode === "explicit") {
    parts.push("定点：" + chain.pllSourceLabel + " ×" + String(chain.pllMul) + " → SYSCLK " + formatHz(chain.sysclkHz));
  } else if (input.reachable) {
    parts.push("目标 " + formatHz(input.targetHz) + " 可达：" + chain.pllSourceLabel + " ×" + String(chain.pllMul) + " → SYSCLK " + formatHz(chain.sysclkHz));
  } else {
    parts.push(
      "目标 " + formatHz(input.targetHz) + " 不可达，已选 " + formatHz(chain.sysclkHz) +
      "（差 " + (delta > 0 ? "+" : "-") + formatHz(Math.abs(delta)) + "）",
    );
    if (input.targetHz > F1_CLOCK_LIMITS.sysclkHz) {
      parts.push("F1 的 SYSCLK 上限是 " + formatHz(F1_CLOCK_LIMITS.sysclkHz));
    } else {
      parts.push("F1 的 PLL 只能整数倍频（×2..×16），" + chain.pllSourceLabel + " 拼不出这一档");
    }
  }
  // 换源提示：另一个可用源也许正好凑得出目标，但没说它能替代（HSI 精度差 / 要换晶振）。
  if (!input.reachable && input.targetHz > 0 && input.targetHz <= F1_CLOCK_LIMITS.sysclkHz) {
    for (const other of F1_PLL_SOURCES) {
      if (!other.selectable || other.id === chain.pllSource) continue;
      if (other.id === "hse") continue; // 板上没晶振就没法凭空变一个出来
      const pllIn = other.defaultHz;
      const mul = input.targetHz / pllIn;
      if (!Number.isInteger(mul) || mul < 2 || mul > 16) continue;
      parts.push(
        "（改用 " + other.label + " ×" + String(mul) + " 正好 " + formatHz(input.targetHz) +
        "，但 " + (other.id === "hsi-div2" ? "HSI 精度 ±1%，UART 波特率会跟着漂" : "需要板上换晶振") + "，默认没选它）",
      );
      break;
    }
  }

  if (chain.pllSource === "hsi-div2") {
    warnings.push("用 HSI÷2（内部 RC，±1%）当 PLL 输入：UART 波特率会漂，量产建议接 8 MHz 晶振（HSE）。");
  }
  if (!chain.usbAvailable && input.usbWanted) {
    warnings.push(
      "USB 不可用：F1 的 USB 只能从 PLLCLK÷1.5 得到 48 MHz，需要 PLLCLK=72 MHz；当前 SYSCLK " +
      formatHz(chain.sysclkHz) + "。",
    );
  }
  if (!chain.usbAvailable && input.entries.get("RCC.USBPrescaler") !== undefined) {
    warnings.push("RCC.USBPrescaler 在 SYSCLK " + formatHz(chain.sysclkHz) + " 下无效（拿不到 48 MHz），已删掉这个键。");
  }
  if (chain.adcDiv > 0 && chain.adcDiv * chain.adcHz !== chain.apb2Hz) {
    parts.push("ADC 时钟 " + formatHz(chain.adcHz) + " 不是整数（APB2 " + formatHz(chain.apb2Hz) + " ÷" + String(chain.adcDiv) + "），.ioc 里写成 " + String(chain.adcHz));
  }

  const entries: ClockIocEntry[] = [];
  const unset: string[] = [];
  if (errors.length === 0) {
    const push = (key: string, value: string): void => {
      entries.push({ key, value });
    };
    push("RCC.SYSCLKSource", "RCC_SYSCLKSOURCE_PLLCLK");
    push("RCC.PLLSourceVirtual", input.source.iocValue);
    push("RCC.PLLMUL", pllMulValue(chain.pllMul));
    push("RCC.SYSCLKFreq_VALUE", String(chain.sysclkHz));
    push("RCC.HCLKFreq_Value", String(chain.hclkHz));
    push("RCC.AHBFreq_Value", String(chain.hclkHz));
    push("RCC.FCLKCortexFreq_Value", String(chain.hclkHz));
    push("RCC.APB1CLKDivider", apbDivValue(chain.apb1Div));
    push("RCC.APB1Freq_Value", String(chain.apb1Hz));
    push("RCC.APB1TimFreq_Value", String(chain.apb1TimHz));
    push("RCC.APB2Freq_Value", String(chain.apb2Hz));
    push("RCC.APB2TimFreq_Value", String(chain.apb2TimHz));
    push("RCC.ADCPresc", adcDivValue(chain.adcDiv));
    push("RCC.ADCFreqValue", String(chain.adcHz));
    push("RCC.PLLCLKFreq_Value", String(chain.pllClkHz));
    push("RCC.PLLMCOFreq_Value", String(Math.round(chain.pllClkHz / 2)));
    push("RCC.VCOOutput2Freq_Value", String(chain.pllInHz));
    push("RCC.MCOFreq_Value", String(chain.mcoHz));
    push("RCC.TimSysFreq_Value", String(chain.apb1TimHz));
    // CubeMX 的写法：没真的用 USB 分频时，USBFreq_Value 记的就是 PLLCLK（不是 48）。
    push("RCC.USBFreq_Value", String(chain.usbPrescaled ? F1_USB_PRESCALER.hz : chain.pllClkHz));
    if (chain.apb2Div !== 1) push("RCC.APB2CLKDivider", apbDivValue(chain.apb2Div));
    else if (input.entries.get("RCC.APB2CLKDivider") !== undefined) unset.push("RCC.APB2CLKDivider");
    if (chain.usbPrescaled) push("RCC.USBPrescaler", F1_USB_PRESCALER.iocValue);
    else if (input.entries.get("RCC.USBPrescaler") !== undefined) unset.push("RCC.USBPrescaler");

    const draft = new Map(input.entries);
    for (const entry of entries) draft.set(entry.key, entry.value);
    for (const key of unset) draft.delete(key);
    entries.push({ key: "RCC.IPParameters", value: mergeIpParameters(input.entries.get("RCC.IPParameters"), draft, unset) });
  }

  return {
    mode: input.mode,
    ok: errors.length === 0,
    reachable: input.reachable,
    deltaHz: delta,
    note: parts.join("；"),
    requested: {
      targetHz: input.targetHz,
      pllSource: chain.pllSource,
      pllMul: chain.pllMul,
      apb1Div: chain.apb1Div,
      apb2Div: chain.apb2Div,
      adcDiv: chain.adcDiv,
    },
    achieved: chain,
    alternatives: input.alternatives,
    peripherals: peripheralReport(chain, input.enabled, input.usbWanted),
    bauds: baudTables(chain, input.bauds.length > 0 ? input.bauds : F1_BAUD_LIST),
    entries,
    unset,
    warnings,
    errors,
  };
}

/** 定点模式没命中目标时，顺手给出附近的可选档（方便用户改主意）。 */
function nearestList(
  base: readonly ClockAlternative[],
  chosenHz: number,
  targetHz: number,
  hasHse: boolean,
  hseHz: number,
  request: ClockPlanRequest,
): ClockAlternative[] {
  const sources: PllSourceFact[] = [];
  const wantedSource = request.pllSource === undefined ? null : pllSourceById(request.pllSource);
  const detected = pllSourceById(hasHse ? "hse" : "hsi-div2") ?? (F1_PLL_SOURCES[0] as PllSourceFact);
  sources.push(wantedSource ?? detected);
  const rows: ClockAlternative[] = [...base];
  for (const source of sources) {
    if (!source.selectable) continue;
    const pllIn = source.id === "hse" ? hseHz : source.defaultHz;
    for (const fact of F1_PLL_MULS) {
      const sysclk = pllIn * fact.mul;
      if (sysclk > F1_CLOCK_LIMITS.sysclkHz || sysclk === chosenHz) continue;
      if (rows.some((row) => row.sysclkHz === sysclk)) continue;
      const apb1 = minimalDiv(F1_APB_DIVS, sysclk, F1_CLOCK_LIMITS.apb1Hz);
      const apb2 = sysclk;
      const adc = minimalDiv(F1_ADC_DIVS, apb2, F1_CLOCK_LIMITS.adcHz);
      if (apb1 === null || adc === null) continue;
      rows.push({
        sysclkHz: sysclk,
        pllSource: source.id,
        pllSourceLabel: source.label,
        pllMul: fact.mul,
        apb1Div: apb1.div,
        adcDiv: adc.div,
        usbAvailable: sysclk === F1_USB_PRESCALER.requiresPllClkHz,
        deltaHz: sysclk - targetHz,
      });
    }
  }
  rows.sort((left, right) => Math.abs(left.deltaHz) - Math.abs(right.deltaHz));
  return rows.slice(0, 6);
}
