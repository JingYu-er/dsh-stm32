/**
 * direct 模型的时钟规划（没有 PLL，SYSCLK 直接取源：STM32C0 这类族）。
 *
 * 与 pllmul / pllmn 的区别只在「源 → SYSCLK」这一段：
 *   pllmul：sysclk = src × PLLMUL
 *   pllmn ：vco = src / PLLM × PLLN；sysclk = vco / PLLP
 *   direct：sysclk = src（HSI 时再 ÷ HSISYSCLKDivider）
 * 后面 APB/ADC 分频与要写的 RCC.* 键同形，所以对外还是同一个 ClockPlan。
 *
 * 事实来源：能当源的枚举（SYSCLKSource）、源分频枚举（HSISYSCLKDivider）、总线频率上限、
 * 派生频率参数名都从 db 的 RCC-*_Modes.xml 读（src/data/clock-db.ts）；不手抄。
 *
 * 实测依据（2026-11，DB.6.0.150，C031C6T6）：拿 C0 模板写
 * RCC.SYSCLKSource=RCC_SYSCLKSOURCE_HSI + RCC.HSISYSCLKDivider=RCC_HSI_DIV1 +
 * RCC.APB1CLKDivider=RCC_APB1_DIV1 + 14 个派生键后，CubeMX 无头 load+save 的 RCC 段零 diff。
 */
import { pllSourceById } from "../data/clock-f1.js";
import type { ClockFacts, ClockSourceId, DividerFact } from "../data/clock-f1.js";

import { emptyClockPlan, formatHz, peripheralClockHz } from "./clock-plan.js";
import type { ClockChainInfo, ClockPlan, ClockPlanRequest, ClockPeripheral } from "./clock-plan.js";

function divFact(divs: readonly DividerFact[] | undefined, div: number): DividerFact | null {
  if (divs === undefined) return null;
  return divs.find((item) => item.div === div) ?? null;
}

function minimalDiv(divs: readonly DividerFact[], value: number, limit: number): DividerFact {
  // 没有 APB 分频参数的族（WB0/WL3 总线不分频）：只有 ÷1 这一档，别去写那个键。
  if (divs.length === 0) return { div: 1, iocValue: "" };
  let best: DividerFact | null = null;
  for (const item of divs) {
    if (item.div <= 0 || value / item.div > limit) continue;
    if (best === null || item.div < best.div) best = item;
  }
  return best ?? (divs[divs.length - 1] as DividerFact);
}

/**
 * 源的标称频率（Hz）。hzKey 是 db 给的「这一路频率写在 .ioc 的哪个键」（HSE → RCC.HSE_VALUE）；
 * 空 hzKey = 固定频率源（WB0/WL3 的 RC64MPLL 64 MHz），不读 .ioc。
 */
function readSourceHz(entries: Map<string, string>, source: { id: ClockSourceId; defaultHz: number; hzKey?: string }): number {
  const key = source.hzKey ?? (source.id === "hse" ? "RCC.HSE_VALUE" : source.id === "hsi" ? "RCC.HSI_VALUE" : "");
  if (key === "") return source.defaultHz;
  const parsed = Number.parseInt((entries.get(key) ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : source.defaultHz;
}

/**
 * .ioc 里配了外部晶振没有：看有没有引脚的 Signal=RCC_OSC_IN/OUT。
 * 不能看「有没有 RCC.HSE_VALUE」——CubeMX 生成的模板**都**带这个键（默认 8 MHz），
 * 板上没晶振时它只是个占位值，拿它当「有 HSE」会把 C0 规划成 8 MHz。
 */
function hasHseCrystal(entries: Map<string, string>): boolean {
  for (const value of entries.values()) {
    const trimmed = value.trim();
    if (trimmed === "RCC_OSC_IN" || trimmed === "RCC_OSC_OUT") return true;
  }
  return false;
}

export interface DirectPlanInput {
  request: ClockPlanRequest | undefined;
  /** .ioc 现有键值（读源分频、HSE/HSI 频率、派生键旧值、IPParameters 名单）。 */
  entries: Map<string, string>;
  facts: ClockFacts;
  familyId: string;
}

interface Candidate {
  source: ClockSourceId;
  sourceLabel: string;
  div: number;
  divValue: string;
  sourceHz: number;
  sysclkHz: number;
  score: number;
}

/**
 * direct 模型的规划入口。返回与 pllmul/pllmn 同形状的 ClockPlan，ioc-plan 不用再分叉。
 */
export function planClockDirect(input: DirectPlanInput): ClockPlan {
  const { request, entries, facts, familyId } = input;
  const sources = facts.sources.filter((source) => source.selectable);
  if (sources.length === 0) {
    return emptyClockPlan(familyId + " 的 db 里没有能直连 SYSCLK 的源（SYSCLKSource 只有 LSE/LSI 这类）：clock 参数不会生效");
  }
  if (request !== undefined && (request.targetHz ?? 0) <= 0 && request.pllMul !== undefined) {
    return emptyClockPlan(
      familyId + " 没有 PLL（SYSCLK 直接取源），pllMul（倍频）不适用：请给 targetHz，例如 clock:{ targetHz: 48000000 }",
    );
  }

  const srcKey = facts.sysclkSourceKey ?? "RCC.SYSCLKSource";
  // 源分频两种写法：单键（C0 的 HSISYSCLKDivider 只管 HSI）与「一源一键」（WB0/WL3：
  // HSE 走 SYSCLK32Divider/SYSCLK48Divider、RC64MPLL 走 SYSCLK64Divider）。
  const legacySrcDivKey = facts.srcDivKey ?? "";
  const legacySrcDivs = facts.srcDivs ?? [];
  const perSource = facts.srcDivBySource ?? {};
  const divsOf = (source: ClockSourceId): readonly DividerFact[] => {
    const bySource = perSource[source];
    if (bySource !== undefined && bySource.divs.length > 0) return bySource.divs;
    if (legacySrcDivKey !== "" && legacySrcDivs.length > 0 && (facts.srcDivSources ?? []).includes(source)) return legacySrcDivs;
    return [{ div: 1, iocValue: "" }];
  };
  const divKeyOf = (source: ClockSourceId | null): string => {
    if (source !== null) {
      const bySource = perSource[source];
      if (bySource !== undefined) return bySource.key;
      if (legacySrcDivKey !== "" && (facts.srcDivSources ?? []).includes(source)) return legacySrcDivKey;
    }
    return "";
  };

  const currentValue = entries.get(srcKey) ?? "";
  const currentSource = pllSourceById(sources.find((source) => source.iocValue === currentValue)?.id ?? "", sources)?.id ?? null;
  const currentDivKey = divKeyOf(currentSource);
  const currentDivValue = currentDivKey === "" ? "" : (entries.get(currentDivKey) ?? "");
  const wantedSource: ClockSourceId =
    request?.pllSource !== undefined && sources.some((source) => source.id === request.pllSource)
      ? request.pllSource
      : currentSource ??
        (hasHseCrystal(entries) && sources.some((source) => source.id === "hse")
          ? "hse"
          : (sources.find((source) => source.id === "hsi")?.id ?? (sources[0] as { id: ClockSourceId }).id));
  const targetHz = request?.targetHz ?? 0;

  // 1) 枚举「源 × 源分频」，留下不超过 SYSCLK 上限的档位（direct 没有 VCO，约束只有这一条）
  const candidates: Candidate[] = [];
  for (const source of sources) {
    const sourceHz = readSourceHz(entries, source);
    if (sourceHz <= 0) continue;
    for (const div of divsOf(source.id)) {
      if (div.div <= 0) continue;
      const sysclkHz = Math.round(sourceHz / div.div);
      if (sysclkHz <= 0 || sysclkHz > facts.limits.sysclkHz) continue;
      candidates.push({
        source: source.id,
        sourceLabel: source.label,
        div: div.div,
        divValue: div.iocValue,
        sourceHz,
        sysclkHz,
        score: targetHz > 0 ? Math.abs(sysclkHz - targetHz) : 0,
      });
    }
  }
  if (candidates.length === 0) {
    return emptyClockPlan("在 " + familyId + " 的 SYSCLK 源里找不到不超过 " + formatHz(facts.limits.sysclkHz) + " 的档位：clock 参数不会生效");
  }

  let best: Candidate;
  if (targetHz === 0) {
    // 快照：优先按 .ioc 现在的源与分频读，读不出来就取该源的 ÷1
    const asIs = candidates.find((item) => item.source === wantedSource && (currentDivValue === "" ? item.div === 1 : item.divValue === currentDivValue));
    best = asIs ?? (candidates.filter((item) => item.source === wantedSource).sort((left, right) => left.div - right.div)[0] as Candidate) ?? (candidates[0] as Candidate);
  } else {
    // 先按「当前/偏好的源」找最近档；那个源凑不出来时（WB0/WL3 的 HSE 只有 32/48 MHz，
    // 64 MHz 得走 RC64MPLL）再放开到所有源，否则会把可达的目标报成不可达。
    const byScore = (left: Candidate, right: Candidate): number => left.score - right.score || left.div - right.div;
    const sameSource = candidates.filter((item) => item.source === wantedSource).sort(byScore);
    const allSources = [...candidates].sort(byScore);
    const sameBest = sameSource[0];
    best = sameBest !== undefined && sameBest.score <= (allSources[0] as Candidate).score ? sameBest : (allSources[0] as Candidate);
  }

  // 2) 总线分频：APB1/APB2 各取满足上限的最小分频；单 APB 族（C0）没有 APB2 参数，APB2 跟着 APB1 走
  const hasApb2 = (facts.apb2Divs ?? []).length > 0;
  const apb1Div = request?.apb1Div ?? minimalDiv(facts.apbDivs, best.sysclkHz, facts.limits.apb1Hz).div;
  const apb2Div = !hasApb2 ? apb1Div : (request?.apb2Div ?? minimalDiv(facts.apb2Divs as readonly DividerFact[], best.sysclkHz, facts.limits.apb2Hz).div);
  const apb1Hz = Math.round(best.sysclkHz / apb1Div);
  const apb2Hz = Math.round(best.sysclkHz / apb2Div);
  const adcDiv = 1;
  // direct 族的 ADC 时钟由 ADCCLockSelection 从 SYSCLK 取（C0 默认就是 SYSCLK），
  // 不像 F1/F4 走 ADCPresc：所以这里不写 RCC.ADCPresc，只把 ADCFreq_Value 写对。
  const adcHz = best.sysclkHz;

  const chain: ClockChainInfo = {
    pllSource: best.source,
    pllSourceLabel: best.sourceLabel + (best.div > 1 ? " ÷" + String(best.div) : ""),
    pllInHz: best.sysclkHz,
    pllMul: 1,
    pllClkHz: best.sysclkHz,
    sysclkHz: best.sysclkHz,
    hclkHz: best.sysclkHz,
    apb1Div,
    apb1TimHz: apb1Div === 1 ? apb1Hz : apb1Hz * 2,
    apb1Hz,
    apb2Div,
    apb2Hz,
    apb2TimHz: apb2Div === 1 ? apb2Hz : apb2Hz * 2,
    adcDiv,
    adcHz,
    usbHz: 0,
    usbAvailable: false,
    usbPrescaled: false,
    mcoHz: 0,
  };

  const peripherals: ClockPeripheral[] = facts.peripheralClocks.map((fact) => ({
    id: fact.id,
    label: fact.label,
    bus: fact.bus,
    clockHz: peripheralClockHz(chain, fact),
    note: "",
  }));

  // 3) 要写的键：源 + 源分频 + AHB/APB 分频 + 派生频率
  const draft = new Map<string, string>();
  const source = sources.find((item) => item.id === best.source);
  if (source === undefined) return emptyClockPlan("SYSCLK 源的 .ioc 取值在 db 枚举里找不到：clock 参数不会生效");
  draft.set(srcKey, source.iocValue);
  const bestDivKey = divKeyOf(best.source);
  if (bestDivKey !== "" && best.divValue !== "") draft.set(bestDivKey, best.divValue);
  // AHB 只 ÷1。取值名按族不同（C0 是 RCC_HCLK_DIV1、F2 是 RCC_SYSCLK_DIV1），从 db 查。
  const ahbOne = divFact(facts.ahbDivs, 1);
  if (ahbOne !== null && ahbOne.iocValue !== "") draft.set("RCC.AHBCLKDivider", ahbOne.iocValue);
  // 没有 APB 分频参数的族（WB0/WL3）不写这个键：CubeMX 会把未知键当垃圾丢掉，
  // 计划里写了、保存后消失 = ioc_verify 报 missingKeys。
  if (facts.apbDivs.length > 0) draft.set("RCC.APB1CLKDivider", divFact(facts.apbDivs, apb1Div)?.iocValue ?? "");
  if (hasApb2) draft.set("RCC.APB2CLKDivider", divFact(facts.apb2Divs, apb2Div)?.iocValue ?? "");
  // 空值（db 里查不到这个分频的枚举名）不写：空串会让 CubeMX 载入失败。
  for (const [key, value] of [...draft.entries()]) if (value === "") draft.delete(key);

  // 4) 派生频率键：只写「按名字算得出来」的那批（PWR/HCLK/SYSCLK/APB/APB Tim/ADC）。
  // 其余（MCO1PinFreq_Value、USART1Freq_Value、VcooutputI2S…）依赖各外设自己的选源，
  // 猜错会让 ioc_verify 报「值被改写」（真差异），不如留给 CubeMX 按树重算——
  // 那种差异会进 derivedRecomputed 桶，不参与 benign 判定。
  const derivedNames = new Set<string>(facts.derivedClockNames ?? []);
  for (const key of entries.keys()) {
    if (!key.startsWith("RCC.")) continue;
    const name = key.slice("RCC.".length);
    if (/freq_?value$/iu.test(name)) derivedNames.add(name);
  }
  // 名字比较一律转小写：.ioc 里同一类键的写法不统一（SFreq_VALUE 全大写、APBFreq_Value 驼峰、
  // ADCFreqValue 连写），按原样写正则必漏一半。
  const derivedValueOf = (name: string): number | null => {
    const lower = name.toLowerCase();
    // WatchDogFreq_Value 不在这一组：它是 LSI 32 kHz（C0 实测 CubeMX 回写 32000，按 SYSCLK 写就是错值）
    if (/^(sysclk|hclk|ahb|cortex|fclkcortex|pwr)freq_value$/u.test(lower)) return best.sysclkHz;
    if (/^apb2timfreq_value$/u.test(lower)) return chain.apb2TimHz;
    if (/^apb2freq_value$/u.test(lower)) return apb2Hz;
    if (/^(apb1|apb)timfreq_value$/u.test(lower)) return chain.apb1TimHz;
    if (/^(apb1|apb)freq_value$/u.test(lower)) return apb1Hz;
    // 只写 ADCFreq_Value：synchADCFreq_Value/asynchADCFreq_Value 是 ADCCLockSelection 的另一档，
    // 猜错就成真差异，留给 CubeMX 重算。
    if (/^adcfreq_?value$/u.test(lower)) return adcHz;
    return null;
  };
  let derivedWritten = 0;
  for (const name of [...derivedNames].sort()) {
    const value = derivedValueOf(name);
    if (value === null) continue;
    draft.set("RCC." + name, String(value));
    derivedWritten += 1;
  }

  // 5) RCC.IPParameters：已有名单 ∪ 本次写入（CubeMX 按 ASCII 升序写这一列，我们跟着排）
  const existing = (entries.get("RCC.IPParameters") ?? "").split(",").map((item) => item.trim()).filter((item) => item !== "");
  const merged = [...existing];
  for (const key of draft.keys()) {
    const name = key.slice("RCC.".length);
    if (!merged.includes(name)) merged.push(name);
  }
  draft.set("RCC.IPParameters", merged.sort().join(","));

  const reachable = targetHz === 0 || best.sysclkHz === targetHz;
  const deltaHz = targetHz === 0 ? 0 : best.sysclkHz - targetHz;
  const notes: string[] = [];
  notes.push(
    (targetHz === 0
      ? "时钟现状"
      : reachable
        ? "目标 " + formatHz(targetHz) + " 可达"
        : "目标 " + formatHz(targetHz) + " 不可达，已选 " + formatHz(best.sysclkHz)) +
      "：" + chain.pllSourceLabel + " → SYSCLK " + formatHz(best.sysclkHz) + "（这一族没有 PLL，SYSCLK 直接取源）",
  );
  if (!reachable) notes.push("SYSCLK 只能取「源 ÷ 分频」这一档组合，凑不出目标时给的是最近档");
  if (derivedWritten > 0) notes.push("顺带写对了 " + String(derivedWritten) + " 个派生频率键（其余留给 CubeMX 按树重算）");

  const warnings: string[] = [];
  if (best.source === "hsi") {
    warnings.push("用 HSI（内部 RC，±1%）当 SYSCLK：UART 波特率会漂，量产建议接晶振（HSE）。");
  }

  return {
    mode: targetHz === 0 ? "snapshot" : "nearest",
    ok: true,
    reachable,
    deltaHz,
    note: notes.join("；"),
    requested: {
      targetHz,
      pllSource: wantedSource,
      pllMul: 0,
      apb1Div,
      apb2Div,
      adcDiv,
    },
    achieved: chain,
    alternatives: candidates
      .filter((item) => item.sysclkHz !== best.sysclkHz)
      .sort((left, right) => left.score - right.score)
      .slice(0, 3)
      .map((item) => ({
        sysclkHz: item.sysclkHz,
        pllSource: item.source,
        pllSourceLabel: item.sourceLabel + (item.div > 1 ? " ÷" + String(item.div) : ""),
        pllMul: 1,
        apb1Div: minimalDiv(facts.apbDivs, item.sysclkHz, facts.limits.apb1Hz).div,
        adcDiv,
        usbAvailable: false,
        deltaHz: targetHz === 0 ? 0 : item.sysclkHz - targetHz,
      })),
    peripherals,
    bauds: [],
    entries: [...draft.entries()].map(([key, value]) => ({ key, value })),
    unset: ["RCC.PLLMUL", "RCC.PLLMCOFreq_Value", "RCC.PLLSourceVirtual"],
    warnings,
    errors: [],
  };
}
