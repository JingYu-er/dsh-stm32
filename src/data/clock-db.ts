/**
 * 从 CubeMX db 读时钟事实（PLL 倍频/分频枚举、PLL 源、SYSCLK 上限、PLL 模型）。
 *
 * 为什么要有这一层：`clock-f1.ts` 里的 `F1_PLL_MULS` / `F1_APB_DIVS` / `F1_ADC_DIVS` / `F1_PLL_SOURCES`
 * 全是「某个 db 版本枚举值的手抄快照」。db 里这些恰好都有：
 *   - `db/mcu/<Mcu.Name>.xml` 的 `<Frequency>` 就是该型号的 SYSCLK 上限（MHz）；
 *   - `db/mcu/IP/RCC-*.xml`（Modes）里 `<RefParameter Name="PLLMUL" Type="list">` 的
 *     `<PossibleValue Value="RCC_PLL_MUL2" Comment="2"/>` 就是倍频枚举，分频同理。
 * 抄写快照的局限与预设表相同：更换芯片族或 db 版本后即失真（F1 的 `S_TIM2_CH1_ETR` 已出现过一次错误）。
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
import { join } from "node:path";

import { ipModesPath, type CubemxDb, type CubemxMcuFacts } from "../engine/cubemx-db.js";
import { F1_BAUD_LIST, F1_PERIPHERAL_CLOCKS, F1_USB_PRESCALER, type ClockFacts, type ClockSourceId, type DividerFact, type PllMulFact, type PllSourceFact, type VcoBand } from "./clock-f1.js";

/** PLL 模型：决定「源 → SYSCLK」怎么算。 */
export type ClockModel =
  /** 源 ÷ 预分频 × 倍频（F0/F1/F3/L0/L1…；.ioc 键是 RCC.PLLMUL）。 */
  | "pllmul"
  /** 源 ÷ PLLM × PLLN ÷ PLLP|PLLR（F2/F4/F7/G4/L4…；.ioc 键是 RCC.PLLM/PLLN/PLLP）。 */
  | "pllmn"
  /**
   * 没有 PLL：SYSCLK 直接取源（HSE 或 HSI÷1/2/4/…/128）。C0 就是这一类——
   * Modes xml 里既没有 PLLMUL 也没有 PLLM/PLLN，只有 SYSCLKSource + HSISYSCLKDivider。
   * 早先判成 unknown 时会直接拒绝，C0 因此无法规划时钟。
   */
  | "direct"
  /** 认不出（H7 的 DIVM1/DIVN1、U5 的 PLL1 分相…）：调用方必须拒绝，别硬套别的模型。 */
  | "unknown";

export interface ClockDbFacts {
  model: ClockModel;
  /** MCU xml `<Frequency>`（MHz → Hz）；0 = db 没写。 */
  sysclkMaxHz: number;
  /** db 的 SYSCLKFreq_VALUE Max（MCU xml 未写 `<Frequency>` 时作为缺省值，例如 G4/U0 读出为 0）。 */
  sysclkMaxDbHz: number;
  /**
   * 写 SYSCLK 源该用哪个键：`RCC.SYSCLKSource` 还是 `RCC.SYSCLKSourceVirtual`。
   *
   * 为什么不能写死：F303 的 Modes xml 里两个名字都有——`SYSCLKSource` 是由
   * `SYSCLKSourceVirtualString` 拼出来的派生项，CubeMX 真正读的是 `SYSCLKSourceVirtual`。
   * 实测（2026-11，DB.6.0.150，F303CBT6 @72 MHz）写 `RCC.SYSCLKSource` 会被**静默丢掉**，
   * 仅靠 PLL 键由 CubeMX 自行推出 PLLCLK；更换频率档位时结果可能错误，因此按 db 中是否存在 Virtual 决定。
   */
  sysclkSourceKey: string;
  /** db 的 APB1Freq_Value/APB2Freq_Value/ADCFreq_Value Max（G0/U0 这种单 APB 族用 APBFreq_Value）。 */
  busLimits: BusLimits | null;
  /** db 的 VCOOutputFreq_Value/VCOInputFreq_Value Min/Max（pllmul 族通常没有）。 */
  vco: PllVcoLimits | null;
  /** pllmul 模型的倍频枚举（RCC_PLL_MUL2..）。 */
  muls: PllMulFact[];
  /** PLL 输入源（只收频率已知的：HSE 与 HSI/HSI÷2）。 */
  sources: PllSourceFact[];
  /** direct 模型：能直接当 SYSCLK 的源（Modes xml 的 SYSCLKSource 里认得出的 HSE/HSI）。 */
  directSources: PllSourceFact[];
  /** direct 模型：源分频枚举（HSISYSCLKDivider）与该枚举在 .ioc 中的键名；空 = 没有源分频。 */
  srcDivs: DividerFact[];
  srcDivKey: string;
  /** 源分频只对这些源生效（键名以 HSI 开头 → 只有 hsi）。 */
  srcDivSources: ClockSourceId[];
  /**
   * 每个源各自的分频键（WB0/WL3 这种「一个源一套分频」的族）：WB0 的 HSE 走 SYSCLK32Divider、
   * RC64MPLL 走 SYSCLK64Divider；WL3 的 HSE 叫 SYSCLK48Divider（÷1/2/3/6/12/24/48）。
   * 为空 = 这一族只有上面那张单键表（C0 的 HSISYSCLKDivider）。
   */
  srcDivBySource: Partial<Record<ClockSourceId, { key: string; divs: DividerFact[] }>>;
  /** APB 分频枚举是否真的存在。false = 这一族没有 APB 分频（WB0/WL3 总线不分频），不能写 RCC.APB1CLKDivider。 */
  hasApbDivider: boolean;
  /** APB2 分频枚举；空 = 单 APB 族（C0），不能写 RCC.APB2CLKDivider。 */
  apb2Divs: DividerFact[];
  /** RCC 的派生频率参数名（RefParameter 里 *Freq_Value/*FreqValue 那批）。 */
  derivedNames: string[];
  /** APB 分频（来自 APB1CLKDivider 枚举）。 */
  apbDivs: DividerFact[];
  /**
   * AHB 分频（AHBCLKDivider 枚举）。取值名字跟 APB **不是同一套**：
   * F2/F4/F7 是 RCC_SYSCLK_DIV1/2/4/…/512，C0 是 RCC_HCLK_DIV1/2/4/8/16。
   * 早先把 APB 的值直接写进 AHBCLKDivider（RCC_HCLK_DIV1），F2 拿到非法枚举值后
   * CubeMX 载入即死循环（>240 s 不返回、日志停在 setPackage），所以这里单独读。
   */
  ahbDivs: DividerFact[];
  /** ADC 预分频（来自 ADCPresc 枚举）。 */
  adcDivs: DividerFact[];
  /** pllmn 模型：PLLM 分频枚举 / PLLN 范围 / PLLP 分频枚举。 */
  pllM: DividerFact[];
  pllN: { min: number; max: number } | null;
  pllP: DividerFact[];
  /** L4 的 SYSCLK 输出是 PLLR（PLLP 属于 PLLSAI1，值只有 DIV7/DIV17）。 */
  pllR: DividerFact[];
  sysclkOutput: "P" | "R";
  /** PLL1 族：分频键是 RCC.PLL1P/PLL1R（H5/U5/WBA/L4+），不是 RCC.PLLP/PLLR。 */
  pll1Naming: boolean;
  /** 这三组键在 .ioc 里的真实名字（L4+ 是 PLLM1/PLL1P；空串 = 这一族没有）。 */
  pllMKey: string;
  pllPKey: string;
  pllRKey: string;
  /**
   * Cortex（SysTick）时钟是否等于 HCLK。
   *
   * false = db 里给了 Cortex 的选择/分频参数（H5/U5/WBA/L4+ 都有），CubeMX 会按自己的树算
   * CortexFreq_Value，写入任意值都可能被 CubeMX 改回（同一族两次往返可反向修改）→ planner 不写这个键，
   * 该键归到 derivedRecomputed。true = 没有这类参数，Cortex = HCLK，按原值写入。
   */
  cortexFollowsHclk: boolean;
  /** PLL 输入频段（PLL1_VCI_Range）与每段的 VCO 区间；空 = 这一族不分段。 */
  vcoBands: VcoBand[];
  /** 写输入频段/档位用的键名（读不到就是空串）。 */
  vciRangeKey: string;
  vcoSelKey: string;
  /** 打开 PLL 的键（H5/U5：PLLUsed + PLLState）；null = 这一族不用写。 */
  pllEnable: { usedKey: string; usedValue: string; stateKey: string; stateValue: string } | null;
  /** 读不到/推不出的地方，原样报给用户。 */
  notes: string[];
  /** 这份事实是从哪个 RCC Modes 文件读的（排查用）。 */
  sourceFile: string;
}

function readTextOrNull(file: string | null): string | null {
  if (file === null || !existsSync(file)) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** RCC 实例的 Modes 文件路径（IP 的 Version 属性本身就带族名，例如 STM32F102_rcc_v1_0）。 */
function rccModesPath(db: CubemxDb, facts: CubemxMcuFacts): string | null {
  for (const [instance, ip] of facts.ips) {
    const name = (ip.name ?? instance).toUpperCase();
    if (name !== "RCC") continue;
    return ipModesPath(db, facts, instance);
  }
  return null;
}

interface EnumEntry {
  value: string;
  comment: string;
  num: number | null;
}

function numberOf(text: string): number | null {
  const matched = /(-?[0-9]+(?:\.[0-9]+)?)/u.exec(text);
  return matched === null ? null : Number(matched[1]);
}

/** 取某个 list 型 RefParameter 的 PossibleValue（属性顺序不固定，按名字各取）。 */
function enumOf(text: string, parameterName: string): EnumEntry[] {
  const open = new RegExp('<RefParameter[^>]*Name="' + parameterName + '"[^>]*>', "u").exec(text);
  if (open === null) return [];
  // 自闭合 = integer 型（PLLM/PLLN 在 F4 上就是 Min=2 Max=63 这种），没有 PossibleValue。
  // 不加阻止时，正则会把**下一个** RefParameter 的块当成当前块的 children —— F4 的 PLLM 曾因此拿到 PLLP 的枚举名。
  if (open[0].trimEnd().endsWith("/>")) return [];
  const from = (open.index ?? 0) + open[0].length;
  const close = text.indexOf("</RefParameter>", from);
  const block = close < 0 ? null : text.slice(from, close);
  const body = block;
  if (body === null) return [];
  const out: EnumEntry[] = [];
  for (const matched of body.matchAll(/<PossibleValue([^>]*)\/?>/gu)) {
    const attrs = matched[1] ?? "";
    const value = /Value="([^"]*)"/u.exec(attrs)?.[1] ?? "";
    const comment = /Comment="([^"]*)"/u.exec(attrs)?.[1] ?? "";
    if (value === "") continue;
    out.push({ value, comment, num: numberOf(comment) ?? numberOf(value) });
  }
  return out;
}

/**
 * 读某一棵时钟树里「由 CubeMX 自己算」的频率槽名（`db/plugins/clock/<ClockTree>.xml` 的 refParameter）。
 *
 * 为什么需要：这些名字**不带** Freq_Value 后缀（H5 的 `EPOD_VALUE` 就是 PLL 源频率信号），
 * 只看名字认不出是派生量。真机证据（2026-11 H5 @250 MHz 往返）：计划没碰 `RCC.EPOD_VALUE`，
 * CubeMX 保存时把该值从 4 MHz 改成 8 MHz（跟随 PLL 源换成 HSE），ioc_verify 却记成 valueChanged
 * → benign 翻 false。名字从 db 取而不是手抄，才能覆盖 27 族。
 */
export function readClockTreeDerivedNames(db: CubemxDb, clockTree: string): string[] {
  if (clockTree === "") return [];
  const file = join(db.root, "plugins", "clock", clockTree + ".xml");
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const names = new Set<string>();
  for (const match of text.matchAll(/refParameter="([^"]+)"/gu)) names.add(match[1] as string);
  return [...names];
}

/**
 * 读「每个 SYSCLK 源各自的分频器」——从时钟树定义里走一遍 SYSCLK 多路选择器的每条输入。
 *
 * 为什么不能按名字猜：WB0/WL3 的 `SYSCLK32Divider`/`SYSCLK64Divider` **不是** SYSCLK 分频器，
 * 而是 CLKSYS 那一路的预分频（STM32WB0.xml 里 `SYSCLK32Prescaler` 的输入是 SYSCLK、输出是 CLKSYS32）。
 * 按名字猜会在 WB0 上写出 `SYSCLK64Divider=÷2` 以为 SYSCLK 变 32 MHz，而 CubeMX 实际把 CLKSYS 改成 24 MHz、
 * SYSCLK 仍按源值（2026-11 合成 .ioc 往返实测：SysCLKFreq_VALUE 32000000→48000000）。
 *
 * 判据（全部来自 db/plugins/clock/<ClockTree>.xml）：
 *   1. 找 refParameter=SYSCLKSource（WL3 叫 ROOTClkSource）的 multiplexor；
 *   2. 该多路选择器的每条 <Input refValue=...> 是一条源（refValue 决定是 hse/hsi/rc64/…）；
 *   3. 顺着 from= 往回走，只有 type="devisor" 的元素才算这一路的分频器，走到源（fixedSource/variedSource）为止。
 * C0 的 HSISYSCLKDivider 就在 HSI → SysClkSource 中间，所以仍能读到；WB0/WL3 走回去第一个就是源，读出来是空。
 *
 * 返回值语义需区分（关系到结果是否可信）：
 *   - null  = 没读到时钟树（db 里没有该树的 xml、或 xml 里没有 SYSCLK 多路选择器）→ 调用方可以按名字回退；
 *   - 空 Map = **读到了**、而且这些源确实没有 SYSCLK 分频器（WB0/WL3 就是这样）→ 调用方必须采信，不能回退。
 * 早先两者都返回空 Map，WB0 因此仍走按名字推测的回退路径，把 CLKSYS 预分频当成 SYSCLK 分频。
 */
export function readClockTreeSysclkDividers(db: CubemxDb, clockTree: string): Map<ClockSourceId, string[]> | null {
  if (clockTree === "") return null;
  const file = join(db.root, "plugins", "clock", clockTree + ".xml");
  if (!existsSync(file)) return null;
  const out = new Map<ClockSourceId, string[]>();
  const text = readFileSync(file, "utf8");
  interface ElementInfo { id: string; type: string; ref: string; inputs: Array<{ from: string; refValue: string }> }
  const byId = new Map<string, ElementInfo>();
  for (const matched of text.matchAll(/<Element\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Element>)/gu)) {
    const attrs = matched[1] ?? "";
    const body = matched[2] ?? "";
    const id = attrOf(attrs, "id");
    if (id === "") continue;
    const inputs: Array<{ from: string; refValue: string }> = [];
    for (const input of body.matchAll(/<Input\b([^>]*)\/?>/gu)) {
      const inputAttrs = input[1] ?? "";
      const from = attrOf(inputAttrs, "from");
      if (from === "") continue;
      inputs.push({ from, refValue: attrOf(inputAttrs, "refValue") });
    }
    byId.set(id, { id, type: attrOf(attrs, "type"), ref: attrOf(attrs, "refParameter"), inputs });
  }
  const mux = [...byId.values()].find((item) => item.ref === "SYSCLKSource" || item.ref === "ROOTClkSource");
  if (mux === undefined) return null;
  for (const input of mux.inputs) {
    const source = directSourceIdOf(input.refValue);
    if (source === null) continue;
    const names: string[] = [];
    let current: string | null = input.from;
    for (let guard = 0; guard < 32 && current !== null; guard += 1) {
      const element = byId.get(current);
      if (element === undefined || element.type !== "devisor") break;
      if (element.ref !== "") names.push(element.ref);
      const upstream = element.inputs[0];
      current = upstream === undefined ? null : upstream.from;
    }
    if (names.length > 0 && !out.has(source)) out.set(source, names);
  }
  return out;
}

/** 同义参数名按顺序试（F4 的 RCC.PLLP 与 H5 的 RCC.PLL1P 是同一件事）。 */
function enumAlias(text: string, names: readonly string[]): { entries: EnumEntry[]; name: string } {
  for (const name of names) {
    const entries = enumOf(text, name);
    if (entries.length > 0) return { entries, name };
  }
  return { entries: [], name: "" };
}

/** 依次试同义名，先看 list 枚举、再看 Min/Max 数值范围（U5 的 PLL1P 就是 integer 1..128）。 */
function divsWithName(text: string, names: readonly string[]): { divs: DividerFact[]; name: string } {
  for (const name of names) {
    const listed: DividerFact[] = enumOf(text, name)
      .map((entry) => ({ div: entry.num ?? 0, iocValue: entry.value }))
      .filter((item) => item.div >= 1 && item.iocValue !== "")
      .sort((left, right) => left.div - right.div);
    if (listed.length > 0) return { divs: listed, name };
    const range = rangeOf(text, name);
    if (range !== null) {
      const divs: DividerFact[] = [];
      for (let div = range.min; div <= range.max; div += 1) divs.push({ div, iocValue: String(div) });
      return { divs, name };
    }
  }
  return { divs: [], name: "" };
}

/**
 * SYSCLK 走 PLL 的哪一路输出（PLLP 还是 PLLR）。
 *
 * 从时钟树定义读：db/plugins/clock/<ClockTree>.xml 里 Signal id="PLLCLK" 的 refParameter
 * 即传入 SYSCLK 多路选择器的那一路。实测 L4RS 与 U5 都指向 PLLRCLKFreq_Value，
 * 而 U5 的 PLLP 只有 PLLPoutputFreq_Value（供 SAI/其它外设）——按 PLLP 规划会把
 * SYSCLK 接到错的分频上。读不到（老 db）返回 null，调用方回退旧启发式。
 */
export function readSysclkPllOutput(db: CubemxDb, clockTree: string): "P" | "R" | null {
  if (clockTree === "") return null;
  const file = join(db.root, "plugins", "clock", clockTree + ".xml");
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  const signal = /<Signal\b[^>]*\bid="PLLCLK"[^>]*>/u.exec(text);
  if (signal === null) return null;
  const ref = /refParameter="([^"]+)"/u.exec(signal[0])?.[1] ?? "";
  if (/PLLR/u.test(ref)) return "R";
  if (/PLLP/u.test(ref)) return "P";
  return null;
}

/**
 * 这一族的 Cortex（SysTick）时钟能不能当成 HCLK 来写。
 *
 * 判据是 db 里有没有 Cortex 的选择/分频参数（CortexCLockSelectionVirtual / CortexCLockSelection /
 * Cortex_Div）。有就不能写：那几档（÷1 与 ÷8 都在选项里，.ioc 里的默认值不一定是 CubeMX 保存时
 * 实际用的那个）—— 实测四次往返都很任性：H5 写 HCLK 被改成 HCLK÷8，U5 写 HCLK÷8 又被改回 HCLK，
 * 同一个键两次往返方向相反。这类「CubeMX 按树自行计算」的派生量交由 CubeMX 计算，本插件只写确定等于 HCLK 的那些键，
 * verify 中该键归到 derivedRecomputed（不参与 benign）。
 */
function cortexFollowsHclk(text: string): boolean {
  return !/\bName="(?:CortexCLockSelectionVirtual|CortexCLockSelection|Cortex_Div)"/u.test(text);
}

/** 取数值型 RefParameter 的 Min/Max（F4 的 PLLN 这种不是 list，而是 2..432 的范围）。 */
function rangeOf(text: string, parameterName: string): { min: number; max: number } | null {
  const matched = new RegExp('<RefParameter[^>]*Name="' + parameterName + '"[^>]*/?>', "u").exec(text);
  if (matched === null) return null;
  const min = numberOf(/Min="([^"]*)"/u.exec(matched[0])?.[1] ?? "");
  const max = numberOf(/Max="([^"]*)"/u.exec(matched[0])?.[1] ?? "");
  if (min === null || max === null || min >= max) return null;
  return { min, max };
}

/** 取 RefParameter 的数值属性；`Max="=SYSCLKFreq_VALUE"` 这类表达式直接丢弃（不是数字）。 */
function numAttr(attrs: string, key: string): number | null {
  const raw = new RegExp('\\b' + key + '="([^"]*)"', "u").exec(attrs)?.[1];
  if (raw === undefined) return null;
  const text = raw.trim();
  if (text === "" || text.startsWith("=")) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * 取同名 RefParameter 的 Min/Max（"APB1Freq_Value" 这种）。
 *
 * 同名参数在 Modes xml 里常常有多个**变体**，各自带 `<Condition Expression="scale1">`
 * （G0/U0 的 ADC 35000000/16000000/80000000、G4 的 APB1 150M/170M 都是这种）。
 * 这里取「最小的 Min + 最大的 Max」：CubeMX 允许多少就给多少，规划出来的档位不会因为
 * 取错变体而被无故拒绝；最终仍受后面的 SYSCLK 上限与 CubeMX 自身校验约束。
 * 名字按顺序试，先读出 Max 的优先（APB1Freq_Value 优先于单 APB 族的 APBFreq_Value）。
 */
function limitOf(text: string, names: readonly string[]): { min: number | null; max: number | null } | null {
  const re = (name: string): RegExp => new RegExp('<RefParameter[^>]*Name="' + name + '"[^>]*>', "gu");
  for (const name of names) {
    let min: number | null = null;
    let max: number | null = null;
    for (const matched of text.matchAll(re(name))) {
      const one = numAttr(matched[0], "Min");
      const other = numAttr(matched[0], "Max");
      if (one !== null) min = min === null ? one : Math.min(min, one);
      if (other !== null) max = max === null ? other : Math.max(max, other);
    }
    if (max !== null) return { min, max };
  }
  return null;
}

interface RawParamBlock { attrs: string; body: string }

/** 把 Modes xml 里所有 <RefParameter> 块按顺序拆出来（同名多块是常态：每个 Condition 一块）。 */
function refParamBlocks(text: string): RawParamBlock[] {
  const out: RawParamBlock[] = [];
  const re = /<RefParameter\b([^>]*?)(\/>|>)/gu;
  let matched = re.exec(text);
  while (matched !== null) {
    const attrs = matched[1] ?? "";
    if ((matched[2] ?? "") === "/>") {
      out.push({ attrs, body: "" });
      matched = re.exec(text);
      continue;
    }
    const close = text.indexOf("</RefParameter>", re.lastIndex);
    const body = close < 0 ? "" : text.slice(re.lastIndex, close);
    out.push({ attrs, body });
    re.lastIndex = close < 0 ? text.length : close + "</RefParameter>".length;
    matched = re.exec(text);
  }
  return out;
}

function attrOf(attrs: string, key: string): string {
  return new RegExp('\\b' + key + '="([^"]*)"', "u").exec(attrs)?.[1] ?? "";
}

/** 比较枚举名时忽略大小写与下划线：db 自己就两种写法混用（RCC_PLL1_VCIRANGE_0 / RCC_PLL1VCIRANGE_0）。 */
function looseName(value: string): string {
  return value.replace(/[^A-Za-z0-9]/gu, "").toUpperCase();
}

/** Condition 表达式里的 VCIRANGE 枚举引用（H5 的 VCO_SEL 块写 RCC_PLL1VCIRANGE_0，少一个下划线）。 */
function vciTokens(condition: string): string[] {
  return [...condition.matchAll(/RCC[^A-Za-z0-9]?PLL[0-9]?[^A-Za-z0-9]?VCIRANGE[^A-Za-z0-9]?[0-9]+/giu)].map((item) => looseName(item[0]));
}

/**
 * 读 PLL 输入频段（PLL1_VCI_Range）：H5 是 1–2/2–4/4–8/≥8 MHz 四段，每段 VCO 上限不同
 * （150–420 MHz 与 128–560 MHz）。db 把「段」写成四个同名 RefParameter，各带一个 Condition；
 * 段的枚举值在 PossibleValue，段的频率边界在 Condition 的数字里，段的 VCO 区间在
 * VCOOutputFreq_Value 的变体里（按 Condition 引用哪个 VCIRANGE 认）。
 */
function readVcoBands(text: string): { bands: VcoBand[]; vciRangeKey: string; vcoSelKey: string } {
  const blocks = refParamBlocks(text);
  const rawBands: Array<{ value: string; inMinHz: number; inMaxHz: number }> = [];
  let vciRangeKey = "";
  for (const block of blocks) {
    const name = attrOf(block.attrs, "Name");
    if (!/^PLL[0-9]?_VCI_Range$/u.test(name)) continue;
    const condition = /<Condition[^>]*Expression="([^"]*)"/u.exec(block.body)?.[1] ?? "";
    if (!/VCOInputFreq_Value/u.test(condition)) continue;
    const value = /<PossibleValue[^>]*\bValue="([^"]+)"/u.exec(block.body)?.[1] ?? attrOf(block.attrs, "DefaultValue");
    const nums = [...condition.matchAll(/[0-9]{5,}/gu)].map((item) => Number(item[0]));
    if (value === "" || nums.length === 0) continue;
    vciRangeKey = "RCC." + name;
    rawBands.push({ value, inMinHz: Math.min(...nums), inMaxHz: Math.max(...nums) });
  }
  if (rawBands.length === 0) return { bands: [], vciRangeKey: "", vcoSelKey: "" };
  // "RCC.PLL1_VCI_Range" → "PLL1_"（VCO_SEL / 其它同号参数都按这个前缀认）
  const vciPrefix = vciRangeKey.slice("RCC.".length, vciRangeKey.length - "_VCI_Range".length) + "_";
  rawBands.sort((left, right) => left.inMinHz - right.inMinHz);
  const lastBand = rawBands[rawBands.length - 1] as { value: string; inMinHz: number; inMaxHz: number };
  const inMaxFallback = limitOf(text, ["VCOInputFreq_Value"])?.max ?? lastBand.inMaxHz;
  // 最后一段的 Condition 常常是残缺表达式（H5 的 range3 只有下界），上界按 VCOInput 的 Max 补。
  for (let index = 0; index < rawBands.length; index += 1) {
    const band = rawBands[index] as { value: string; inMinHz: number; inMaxHz: number };
    if (band.inMaxHz > band.inMinHz) continue;
    band.inMaxHz = rawBands[index + 1]?.inMinHz ?? inMaxFallback;
  }

  // 每段的 VCO 区间：VCOOutputFreq_Value 的变体里，Condition 引用哪个 VCIRANGE 就是哪一段。
  const bandLimits = new Map<string, { minHz: number; maxHz: number }>();
  let defaultLimits: { minHz: number; maxHz: number } | null = null;
  const bandSel = new Map<string, string>();
  let vcoSelKey = "";
  for (const block of blocks) {
    const name = attrOf(block.attrs, "Name");
    const condition = /<Condition[^>]*Expression="([^"]*)"/u.exec(block.body)?.[1] ?? "";
    if (name === "VCOOutputFreq_Value") {
      const minHz = numAttr(block.attrs, "Min");
      const maxHz = numAttr(block.attrs, "Max");
      if (minHz === null || maxHz === null || minHz >= maxHz) continue;
      const tokens = vciTokens(condition);
      if (tokens.length === 0) defaultLimits = defaultLimits ?? { minHz, maxHz };
      for (const token of tokens) bandLimits.set(token, { minHz, maxHz });
      continue;
    }
    if (!/^PLL[0-9]?_VCO_SEL$/u.test(name)) continue;
    // 同号才算：PLL1 的输入档只能配 PLL1_VCO_SEL（文件里还有 PLL2/PLL3 的，后出现的会盖掉）
    if (!name.startsWith(vciPrefix)) continue;
    const value = /<PossibleValue[^>]*\bValue="([^"]+)"/u.exec(block.body)?.[1] ?? attrOf(block.attrs, "DefaultValue");
    for (const token of vciTokens(condition)) {
      if (value === "") continue;
      vcoSelKey = "RCC." + name;
      bandSel.set(token, value);
    }
  }

  const bands: VcoBand[] = [];
  for (const band of rawBands) {
    const limits = bandLimits.get(looseName(band.value)) ?? defaultLimits;
    if (limits === null || limits === undefined) continue;
    const sel = bandSel.get(looseName(band.value));
    bands.push({
      value: band.value,
      inMinHz: band.inMinHz,
      inMaxHz: band.inMaxHz,
      minHz: limits.minHz,
      maxHz: limits.maxHz,
      ...(sel === undefined ? {} : { vcoSel: sel }),
    });
  }
  return { bands, vciRangeKey, vcoSelKey };
}

/** RCC_PLLSOURCE_HSE → "hse"；只认频率已知的三种。 */
function sourceIdOf(value: string): ClockSourceId | null {
  const upper = value.toUpperCase();
  // PLL1 族的枚举名是 RCC_PLL1_SOURCE_HSE（U5 还有 RCC_PLLSOURCE_MSI 这种），
  // 所以按后缀认而不是整串相等。
  if (/SOURCE_HSE$/u.test(upper)) return "hse";
  if (/SOURCE_HSI_DIV2$/u.test(upper)) return "hsi-div2";
  if (/SOURCE_HSI$/u.test(upper)) return "hsi";
  return null;
}

/**
 * RCC_SYSCLKSOURCE_HSE / _HSI → "hse" / "hsi"（direct 模型的源）。
 * 无线族（WB0/WL3）的 HSE 直连叫 RCC_SYSCLKSOURCE_DIRECT_HSE，内部 64 MHz RC 叫 _RC64MPLL。
 * LSE/LSI 是 32 kHz 级，规划 MHz 目标时用不上，返回 null 让调用方跳过。
 */
function directSourceIdOf(value: string): ClockSourceId | null {
  const upper = value.toUpperCase();
  if (upper === "RCC_SYSCLKSOURCE_HSE" || upper === "RCC_SYSCLKSOURCE_DIRECT_HSE") return "hse";
  if (upper === "RCC_SYSCLKSOURCE_HSI") return "hsi";
  if (upper === "RCC_SYSCLKSOURCE_RC64MPLL") return "rc64";
  return null;
}

/**
 * 读一颗芯片的时钟事实。读不到 RCC Modes 文件返回 null（调用方按「这一族没有 db 时钟事实」处理）。
 */
export function readClockDbFacts(db: CubemxDb, facts: CubemxMcuFacts): ClockDbFacts | null {
  const path = rccModesPath(db, facts);
  const text = readTextOrNull(path);
  if (text === null) return null;
  const notes: string[] = [];

  const muls: PllMulFact[] = enumOf(text, "PLLMUL")
    .map((entry) => ({ mul: entry.num ?? 0, iocValue: entry.value }))
    .filter((item) => item.mul >= 2 && item.iocValue !== "")
    .sort((left, right) => left.mul - right.mul);
  // PLLM 的三种写法都要认：PLLM（F4/F2/H5）、PLLM1（L4+ 的 PLL 叫 PLL1，输入分频是 PLLM1）、
  // 以及 integer 型 Min/Max（U5 是 1..16 的整数，不是枚举）—— 原来只认 PLLM 的枚举，L4+ 直接读空。
  const mFact = divsWithName(text, ["PLLM", "PLLM1", "PLLM2"]);
  const pllM = mFact.divs;
  const pllRAlias = divsWithName(text, ["PLLR", "PLL1R"]);
  // PLLP 可能是枚举（F4 的 RCC_PLLP_DIV2..）也可能是整数区间（U5 的 PLL1P 1..128）。
  const pllPAlias = divsWithName(text, ["PLLP", "PLL1P"]);
  const pll1Naming = pllRAlias.name === "PLL1R" || pllPAlias.name === "PLL1P";
  const pllR = pllRAlias.divs;
  const pllP = pllPAlias.divs;
  const pllN = rangeOf(text, "PLLN");

  // SYSCLK 走 PLLP 还是 PLLR：优先按时钟树（db 里 Signal id="PLLCLK" 接的那路）判，
  // 读不到才回退旧启发式「PLLP 只有 DIV7/DIV17 = 那是 PLLSAI 的输出，SYSCLK 走 PLLR」。
  const pllPIsSai = pllP.length > 0 && pllP.every((item) => item.div === 7 || item.div === 17);
  const sysclkOutput: "P" | "R" =
    readSysclkPllOutput(db, facts.clockTree) ?? (pllPIsSai && pllR.length > 0 ? "R" : "P");
  const sources: PllSourceFact[] = [];
  for (const entry of enumAlias(text, ["PLLSource", "PLLSourceVirtual"]).entries) {
    const id = sourceIdOf(entry.value);
    if (id === null) continue;
    const dup = sources.some((source) => source.id === id);
    if (dup) continue;
    sources.push({
      id,
      label: id === "hse" ? "HSE（外部晶振）" : id === "hsi" ? "HSI（内部 RC）" : "HSI÷2（内部 RC 二分频）",
      iocValue: entry.value,
      // HSI 的绝对频率 db 不给（各族 8/16/48 MHz 都有），默认值只是占位：调用方要用 HSI 时必须从 .ioc 的 RCC.HSI_VALUE 拿真值。
      defaultHz: id === "hse" ? 8_000_000 : id === "hsi" ? 8_000_000 : 4_000_000,
      selectable: true,
      note:
        id === "hse"
          ? "外部晶振：频率以 .ioc 的 RCC.HSE_VALUE 为准（缺省 8 MHz）"
          : "内部 RC：" + (id === "hsi" ? "" : "二分频后") + "频率以 .ioc 的 RCC.HSI_VALUE 为准（db 不写各族 HSI 频率）",
    });
  }

  // F0/L0 这类族只有 RCC_PLLSOURCE_HSI 一档，硬件上该源以 HSI/2 进入 PLL（不是 HSI 直连）：
  // 少了这一步，规划会把 HSI 8 MHz 当 8 MHz 源算，CubeMX 回写时按 /2 重算 → 频率对不上（F0 实测 48→24 MHz）。
  if (sources.some((source) => source.id === "hsi") && !sources.some((source) => source.id === "hsi-div2")) {
    for (const source of sources) {
      if (source.id !== "hsi") continue;
      source.divider = 2;
      source.note += "；该族的 RCC_PLLSOURCE_HSI 实际是 HSI/2 进 PLL（硬件固定二分频）";
    }
  }

  const toDivs = (entries: EnumEntry[]): DividerFact[] =>
    entries
      .map((entry) => ({ div: entry.num ?? 0, iocValue: entry.value }))
      .filter((item) => item.div >= 1 && item.iocValue !== "")
      .sort((left, right) => left.div - right.div);
  const apbDivs = toDivs(enumOf(text, "APB1CLKDivider"));
  const ahbDivs = toDivs(enumOf(text, "AHBCLKDivider"));
  const apb2Divs = toDivs(enumOf(text, "APB2CLKDivider"));
  const adcDivs = toDivs(enumOf(text, "ADCPresc"));

  // db 里某个 RefParameter 的 DefaultValue（Hz）：HSE_VALUE/PLL64_VALUE 这类「源标称频率」以此作为缺省。
  const defaultOf = (name: string): number | null => {
    for (const block of refParamBlocks(text)) {
      if (attrOf(block.attrs, "Name") !== name) continue;
      const parsed = Number.parseInt(attrOf(block.attrs, "DefaultValue"), 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
  };

  // direct 模型：SYSCLK 直接取源，没有 PLL。能当源的只有 SYSCLKSource 里的 HSE/HSI
  // （LSE/LSI 是 32 kHz 级，规划到 MHz 目标用不上，也不该作为「无法命中就选最近档」的回退）。
  // 无线族（WB0/WL3）不叫 SYSCLKSource：WL3 是 ROOTClkSource；WL3 的 HSE 直连是 DIRECT_HSE，
  // 内部 64 MHz RC 是 RC64MPLL（频率取 db 的 PLL64_VALUE，不读 .ioc）。
  const directSourceEnum = enumAlias(text, ["SYSCLKSource", "ROOTClkSource"]);
  const directSources: PllSourceFact[] = [];
  for (const entry of directSourceEnum.entries) {
    const id = directSourceIdOf(entry.value);
    if (id === null) continue;
    if (directSources.some((source) => source.id === id)) continue;
    const hseDefaultHz = defaultOf("HSE_VALUE") ?? 8_000_000;
    const hsiDefaultHz = defaultOf("HSI_VALUE") ?? 16_000_000;
    const rc64Hz = defaultOf("PLL64_VALUE") ?? 64_000_000;
    directSources.push({
      id,
      label: id === "hse" ? "HSE（外部晶振）" : id === "hsi" ? "HSI（内部 RC）" : "RC64MPLL（64 MHz 内部 RC）",
      iocValue: entry.value,
      // 真值从 .ioc 的 RCC.HSE_VALUE / RCC.HSI_VALUE 读；这里给 db 的 DefaultValue 当缺省。
      defaultHz: id === "hse" ? hseDefaultHz : id === "hsi" ? hsiDefaultHz : rc64Hz,
      // RC64MPLL 是固定频率源，.ioc 没有该源的频率键（PLL64_VALUE 是派生值，写入该键与自身计算冲突）。
      ...(id === "rc64" ? {} : { hzKey: id === "hse" ? "RCC.HSE_VALUE" : "RCC.HSI_VALUE" }),
      selectable: true,
      note:
        id === "hse"
          ? "外部晶振：频率以 .ioc 的 RCC.HSE_VALUE 为准"
          : id === "hsi"
            ? "内部 RC：频率以 .ioc 的 RCC.HSI_VALUE 为准"
            : "内部 64 MHz RC 多相时钟（固定频率，只能靠源分频往下分）",
    });
  }
  // 源分频：哪一路有分频器、键叫什么，全从时钟树走（readClockTreeSysclkDividers）。
  // 走不出来（db 没有该树的 xml）才回落到按名字猜的老路——WB0/WL3 的 SYSCLK32/64Divider
  // 是 CLKSYS 预分频而非 SYSCLK 分频，按名字推测在无线族上不成立，因此只能作为回退。
  const srcDivBySource: Partial<Record<ClockSourceId, { key: string; divs: DividerFact[] }>> = {};
  const treeDividers = readClockTreeSysclkDividers(db, facts.clockTree);
  for (const [source, names] of treeDividers ?? new Map<ClockSourceId, string[]>()) {
    for (const name of names) {
      const divs = toDivs(enumOf(text, name));
      if (divs.length === 0) continue;
      srcDivBySource[source] = { key: "RCC." + name, divs };
      break;
    }
  }
  if (treeDividers === null) {
    for (const [source, names] of [
      ["hse", ["SYSCLK32Divider", "SYSCLK48Divider"]],
      ["rc64", ["SYSCLK64Divider"]],
      ["hsi", ["HSISYSCLKDivider"]],
    ] as [ClockSourceId, string[]][]) {
      for (const name of names) {
        const divs = toDivs(enumOf(text, name));
        if (divs.length === 0) continue;
        srcDivBySource[source] = { key: "RCC." + name, divs };
        break;
      }
    }
  }
  const srcDivs = srcDivBySource.hsi?.divs ?? [];
  const srcDivKey = srcDivBySource.hsi?.key ?? "";
  const srcDivSources: ClockSourceId[] = srcDivs.length > 0 ? ["hsi"] : [];
  // 派生频率参数名：RefParameter 里以 Freq_Value/FreqValue 结尾的那批（C0 有 25 个）。
  const derivedNames: string[] = [];
  // 三种写法都有：APBFreq_Value（驼峰）、ADCFreqValue（连写）、SysCLKFreq_VALUE（全大写带下划线）。
  for (const matched of text.matchAll(/<RefParameter[^>]*\bName="([A-Za-z0-9_]+(?:Freq_Value|FreqValue|Freq_VALUE))"/gu)) {
    const name = matched[1] as string;
    if (!derivedNames.includes(name)) derivedNames.push(name);
  }

  let model: ClockModel =
    muls.length > 0 ? "pllmul" : pllM.length > 0 || pllN !== null ? "pllmn" : directSources.length > 0 ? "direct" : "unknown";
  // direct 模型仅对「SYSCLK 直接取一个固定标称频率的源」成立。以下两种情况形似 direct，实为假直连：
  //   · 分相 PLL（H7：DIVM1/DIVN1/DIVP1 + PLL1/2/3 三套 6 参数，SYSCLKSource 里也有 PLLCLK）；
  //   · MSI 直连（U3：SYSCLKSource 只有 MSIS/HSI/HSE，MSIS 最高 96 MHz、频率可配，不是固定标称值）。
  // 两种都归到 unknown 并写清原因：宁可明确拒绝，也不给一个「按 HSI 猜出来」的档位 ——
  // 此类计划写入 .ioc 后，CubeMX 会据此算出更低的 SYSCLK，verify 还可能因派生键被重算而无法发现该错误。
  let unknownNote = "";
  if (model === "direct") {
    const refNames = [...new Set([...text.matchAll(/<RefParameter[^>]*\bName="([A-Za-z0-9_]+)"/gu)].map((matched) => matched[1] as string))];
    // 分相 PLL 的参数名是 DIVM<n>/DIVN<n>/DIVP<n>/PLL<k> 开头的那批。
    // 无线族的 PLL64_VALUE 是 64 MHz RC 的派生值（PLL6 后面是数字 4），不能被误判成分相 PLL。
    // 只按「组」去重并把原始名截到组号：DIVM1/DIVM2/DIVM3 是同一组输入分频，
    // 全列出来既刷屏又会混进 DIVP1Freq_Value 这种派生值名。
    // PLL[1-9](?![0-9])：PLL64_VALUE（无线族 64 MHz RC 派生值）不算，PLL1R/PLL2M 算。
    const phasePllNames = refNames.filter((name) => /^(?:DIV[MPNQ]\d|PLL[1-9](?![0-9]))/u.test(name));
    const phasePllKeys = [...new Set(phasePllNames.map((name) => /^(?:DIV[MPNQ]\d|PLL[1-9](?![0-9]))/u.exec(name)?.[0] ?? name))].sort();
    const phasePll = phasePllKeys.slice(0, 5);
    const phasePllMore = phasePllKeys.length > phasePll.length ? " 等" : "";
    const msiSources = directSourceEnum.entries.filter((entry) => directSourceIdOf(entry.value) === null && /_MSI[S]?$/u.test(entry.value.toUpperCase()));
    if (phasePll.length > 0) {
      unknownNote =
        "db 里这一族的 PLL 是分相模型（参数 " + phasePll.join(" / ") + phasePllMore + "：DIVM/DIVN/DIVP 三组 + 多路 PLL）：这个模型还没实现，不会给时钟计划";
    } else if (msiSources.length > 0) {
      unknownNote =
        "SYSCLK 还能直连 MSI（db 的 SYSCLKSource 里有 " + msiSources.map((entry) => entry.value).join(" / ") + "），MSI 的频率是可配置的源、直连模型只认固定标称频率的 HSE/HSI：这个形状还没建模，不会给时钟计划";
    }
    if (unknownNote !== "") model = "unknown";
  }
  if (model === "unknown" && unknownNote === "") {
    notes.push("db 的 RCC Modes 里既没有 PLLMUL、也没有 PLLM/PLLN、也没有能直连的 SYSCLKSource（HSE/HSI）：这一族的时钟模型不在已实现的三种之内");
  }
  if (unknownNote !== "") notes.push(unknownNote);

  // 总线上限与 VCO 区间：都在同一份 Modes xml 的 RefParameter Max/Min 里（CubeMX 自己校验用）。
  // 无线族（WB0/WL3）的 SYSCLK 上限参数叫 SysCLKFreq_VALUE（注意大小写与 Freq_VALUE 写法）。
  const sysclkMaxDbHz = limitOf(text, ["SYSCLKFreq_VALUE", "SysCLKFreq_VALUE", "HCLKFreq_Value"])?.max ?? 0;
  const apb1 = limitOf(text, ["APB1Freq_Value", "APBFreq_Value"]);
  const apb2 = limitOf(text, ["APB2Freq_Value", "APBFreq_Value"]);
  const adcLimit = limitOf(text, ["ADCFreq_Value", "ADC12outputFreq_Value", "synchADCFreq_Value"]);
  const apb1Max = apb1?.max ?? null;
  const busLimits: BusLimits | null =
    apb1Max === null
      ? null
      : {
          apb1Hz: apb1Max,
          apb2Hz: apb2?.max ?? apb1Max,
          // 没有独立 ADC 上限的族（L1 的 ADCFreq_Value 没有 Max）先按 APB2 上限处理，
          // adcDivs 为空时 planner 不写 ADCPresc，此条不生效。
          adcHz: adcLimit?.max ?? apb2?.max ?? apb1Max,
        };
  if (busLimits === null) {
    notes.push("db 的 RCC Modes 里没有 APB1Freq_Value/APBFreq_Value 的 Max：这一族的总线上限读不出来");
  }
  const vcoOut = limitOf(text, ["VCOOutputFreq_Value"]);
  const vcoIn = limitOf(text, ["VCOInputFreq_Value"]);
  const vcoMinHz = vcoOut?.min ?? null;
  const vcoMaxHz = vcoOut?.max ?? null;
  const vco: PllVcoLimits | null =
    vcoMinHz === null || vcoMaxHz === null || vcoMinHz <= 0 || vcoMinHz >= vcoMaxHz
      ? null
      : {
          minHz: vcoMinHz,
          maxHz: vcoMaxHz,
          ...(vcoIn?.min === null || vcoIn?.min === undefined ? {} : { inMinHz: vcoIn.min }),
          ...(vcoIn?.max === null || vcoIn?.max === undefined ? {} : { inMaxHz: vcoIn.max }),
        };

  // SYSCLK 源按 db 的 RefParameter 名字决定：有 SYSCLKSourceVirtual 时只能写该键（F303），
  // 无线族（WL3）根本没有 SYSCLKSource，源键叫 ROOTClkSource。
  const sysclkSourceKey = /\bName="SYSCLKSourceVirtual"/u.test(text)
    ? "RCC.SYSCLKSourceVirtual"
    : /\bName="ROOTClkSource"/u.test(text)
      ? "RCC.ROOTClkSource"
      : "RCC.SYSCLKSource";

  // PLL1 族（H5/U5/WBA/L4+）：输入分频叫 PLL1P/PLL1R、VCO 分两档（PLL1_VCO_SEL）、
  // 输入按频段选档（PLL1_VCI_Range）、PLL 要显式打开（PLLUsed/PLLState）。
  const bandInfo = readVcoBands(text);
  // PLLUsed/PLLState 在 Modes xml 里各有两个变体（0/1、OFF/ON），属性顺序也不固定
  // （H5 的 PLLState 是 DefaultValue 在 Name 前面），所以按块读、取"打开"那个变体。
  const paramBlocks = refParamBlocks(text);
  const pllUsedBlock = paramBlocks.find((block) => attrOf(block.attrs, "Name") === "PLLUsed");
  const pllStateBlocks = paramBlocks.filter((block) => attrOf(block.attrs, "Name") === "PLLState");
  const pllStateOn =
    pllStateBlocks.map((block) => attrOf(block.attrs, "DefaultValue")).find((value) => /ON$/u.test(value)) ??
    pllStateBlocks.map((block) => attrOf(block.attrs, "DefaultValue")).find((value) => value !== "") ??
    "";
  const pllEnable =
    pllUsedBlock === undefined || pllStateOn === ""
      ? null
      : { usedKey: "RCC.PLLUsed", usedValue: "1", stateKey: "RCC.PLLState", stateValue: pllStateOn };

  return {
    model,
    sysclkMaxHz: Math.round((facts.frequencyMhz ?? 0) * 1_000_000),
    sysclkMaxDbHz,
    sysclkSourceKey,
    busLimits,
    vco,
    muls,
    sources,
    directSources,
    srcDivs,
    srcDivKey,
    srcDivSources,
    srcDivBySource,
    // 读不到 APB 分频就留空：WB0/WL3 根本没有 APB1CLKDivider，早先这里填 RCC_HCLK_DIV1..16
    // 的假枚举，planner 会把这些假枚举写入 .ioc，CubeMX 当成未知键丢弃（= 计划里的键凭空消失）。
    apbDivs,
    hasApbDivider: apbDivs.length > 0,
    ahbDivs,
    apb2Divs,
    derivedNames,
    adcDivs,
    pllM,
    pllN,
    pllP,
    pllR,
    sysclkOutput,
    pll1Naming,
    pllMKey: mFact.name === "" ? "" : "RCC." + mFact.name,
    pllPKey: pllPAlias.name === "" ? "" : "RCC." + pllPAlias.name,
    pllRKey: pllRAlias.name === "" ? "" : "RCC." + pllRAlias.name,
    cortexFollowsHclk: cortexFollowsHclk(text),
    vcoBands: bandInfo.bands,
    vciRangeKey: bandInfo.vciRangeKey,
    vcoSelKey: bandInfo.vcoSelKey,
    pllEnable,
    notes,
    sourceFile: path ?? "",
  };
}

/**
 * 总线频率上限（APB1 / APB2 / ADC）的 **override 表**：只收「核过手册 + 做过真机往返」的族。
 *
 * 没在表里的族不再直接拒绝：先用 db 的 `APB1Freq_Value`/`APB2Freq_Value` Max（那是 CubeMX
 * 自己的约束，见 readClockDbFacts），读不到才拒绝。保留这张表的理由：db 按 RCC IP 版本给值，
 * 个别族比手册保守（F103 走 RCC-STM32F102，APB2 只有 36/48 MHz，实际 72 MHz），
 * 核过的族以手册/真机为准。
 */
export interface BusLimits {
  apb1Hz: number;
  apb2Hz: number;
  adcHz: number;
}

export const BUS_LIMITS: Readonly<Record<string, BusLimits>> = {
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

/**
 * VCO 允许区间（`VCOOutputFreq_Value`/`VCOInputFreq_Value` 的 override）。
 * 同样只收核过手册 + 做过真机往返的族；没在表里的族用 db 的 Min/Max（F2 的 192–432 MHz、
 * G0/U0 的 96–344 MHz 都是 db 给的原值）。
 */
export interface PllVcoLimits {
  minHz: number;
  maxHz: number;
  inMinHz?: number;
  inMaxHz?: number;
}

export const PLL_VCO_LIMITS: Readonly<Record<string, PllVcoLimits>> = {
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
export function clockFactsFromDb(facts: ClockDbFacts, familyId: string): ClockFacts | null {
  const family = familyId.trim().toUpperCase();
  // SYSCLK 上限三级回退：MCU xml 的 <Frequency> → db 的 SYSCLKFreq_VALUE Max → APB2 上限。
  // 第三级为回退（G4/U0 的 <Frequency> 读出为 0，但 SYSCLKFreq_VALUE Max 存在）。
  const sysclkMaxNow = facts.sysclkMaxHz > 0 ? facts.sysclkMaxHz : facts.sysclkMaxDbHz;
  const limits: BusLimits | null =
    BUS_LIMITS[family] ??
    facts.busLimits ??
    // direct 族可能连 APB 频率上限参数都没有（WB0/WL3 总线不分频，db 里只有 SysCLKFreq_VALUE）：
    // 此时总线跟着 SYSCLK 走，用 SYSCLK 上限兜住。
    (facts.model === "direct" && sysclkMaxNow > 0
      ? { apb1Hz: sysclkMaxNow, apb2Hz: sysclkMaxNow, adcHz: sysclkMaxNow }
      : null);
  if (limits === null) return null;
  // direct 模型没有 PLL，也就没有 PLLSource 参数：源从 SYSCLKSource 来。
  if (facts.sources.length === 0 && facts.model !== "direct") return null;
  const sysclkHz = sysclkMaxNow > 0 ? sysclkMaxNow : limits.apb2Hz;
  const base = {
    sources: facts.sources,
    apbDivs: facts.apbDivs,
    sysclkSourceKey: facts.sysclkSourceKey,
    ...(facts.ahbDivs.length > 0 ? { ahbDivs: facts.ahbDivs } : {}),
    ...(facts.apb2Divs.length > 0 ? { apb2Divs: facts.apb2Divs } : {}),
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
    if (vco === null) return null;
    const outputDivs = facts.sysclkOutput === "R" ? facts.pllR : facts.pllP;
    if (facts.pllM.length === 0 || outputDivs.length === 0 || facts.pllN === null) return null;
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
      ...(facts.pll1Naming ? { pll1Naming: true } : {}),
      ...(facts.pllMKey === "" ? {} : { pllMKey: facts.pllMKey }),
      ...(facts.pllPKey === "" ? {} : { pllPKey: facts.pllPKey }),
      ...(facts.pllRKey === "" ? {} : { pllRKey: facts.pllRKey }),
      ...(facts.cortexFollowsHclk ? {} : { cortexFollowsHclk: false }),
      ...((facts.vcoBands ?? []).length > 0 ? { vcoBands: facts.vcoBands, vciRangeKey: facts.vciRangeKey, vcoSelKey: facts.vcoSelKey } : {}),
      ...(facts.pllEnable === null ? {} : { pllEnable: facts.pllEnable }),
      ...(facts.derivedNames.length > 0 ? { knownDerivedNames: facts.derivedNames } : {}),
    };
  }
  if (facts.model === "direct") {
    if (facts.directSources.length === 0) return null;
    return {
      ...base,
      model: "direct",
      muls: [],
      sources: facts.directSources,
      ...(facts.srcDivs.length > 0 ? { srcDivs: facts.srcDivs, srcDivKey: facts.srcDivKey } : {}),
      ...(facts.srcDivSources.length > 0 ? { srcDivSources: facts.srcDivSources } : {}),
      ...(Object.keys(facts.srcDivBySource).length > 0 ? { srcDivBySource: facts.srcDivBySource } : {}),
      // 没有 APB 分频参数的族（WB0/WL3）：清掉 base 里的 APB 分频，planner 就不会去写那个键。
      ...(facts.hasApbDivider ? {} : { apbDivs: [] as DividerFact[] }),
      derivedClockNames: facts.derivedNames,
    };
  }
  if (facts.model !== "pllmul") return null;
  if (facts.muls.length === 0) return null;
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
