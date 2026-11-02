/**
 * pllmn 模型的时钟规划（PLLM / PLLN / PLLP：F2 / F4 / F7 / G4 / L4 这类族）。
 *
 * 与 pllmul 模型的区别只在「源 → SYSCLK」这一段：
 *   pllmul：sysclk = src × PLLMUL
 *   pllmn ：vco = src / PLLM × PLLN；sysclk = vco / PLLP
 * 后面 AHB/APB/ADC 分频与要写的 RCC.* 键基本一致（键名从 PLLMUL 变成 PLLM/PLLN/PLLP）。
 *
 * 事实来源：PLLM/PLLN/PLLP 的枚举与 PLLN 的 Min/Max 从 db 的 RCC-*_Modes.xml 读（见 src/data/clock-db.ts）；
 * VCO 的允许区间是数据手册规格（db 不写），按族放在下面这张表里，**只收核过的族**。
 */
import { apbDivValue, pllSourceById } from "../data/clock-f1.js";
import type { ClockFacts, ClockSourceId, DividerFact } from "../data/clock-f1.js";
import { PLL_VCO_LIMITS } from "../data/clock-db.js";
import { emptyClockPlan, formatHz, peripheralClockHz } from "./clock-plan.js";
import type { ClockChainInfo, ClockPlan, ClockPlanRequest, ClockPeripheral } from "./clock-plan.js";

/** PLL 输入频率（HSI 用 .ioc 的 RCC.HSI_VALUE；HSE 用 RCC.HSE_VALUE）。 */
export function pllInHzOfSource(source: ClockSourceId, hseHz: number, hsiHz: number, facts: ClockFacts): number {
  const fact = pllSourceById(source, facts.sources);
  if (fact === null) return 0;
  if (fact.id === "hse") return hseHz;
  const divider = fact.divider ?? (fact.id === "hsi-div2" ? 2 : 1);
  return Math.round(hsiHz / divider);
}

function divFact(divs: readonly DividerFact[] | undefined, div: number): DividerFact | null {
  if (divs === undefined) return null;
  return divs.find((item) => item.div === div) ?? null;
}

function minimalDiv(divs: readonly DividerFact[], value: number, limit: number): DividerFact {
  let best: DividerFact | null = null;
  for (const item of divs) {
    if (value / item.div > limit) continue;
    if (best === null || item.div < best.div) best = item;
  }
  return best ?? (divs[divs.length - 1] as DividerFact);
}

export interface PllmnPlanInput {
  request: ClockPlanRequest | undefined;
  /** .ioc 现有键值（读 HSE/HSI 频率、判断有没有晶振）。 */
  entries: Map<string, string>;
  facts: ClockFacts;
  familyId: string;
}

/** 从 .ioc 读 RCC.HSE_VALUE / RCC.HSI_VALUE，缺省按 8 / 16 MHz（F4 的 HSI 是 16 MHz）。 */
function readSourcesHz(entries: Map<string, string>): { hseHz: number; hsiHz: number } {
  const hse = Number.parseInt((entries.get("RCC.HSE_VALUE") ?? "").trim(), 10);
  const hsi = Number.parseInt((entries.get("RCC.HSI_VALUE") ?? "").trim(), 10);
  return {
    hseHz: Number.isFinite(hse) && hse > 0 ? hse : 8_000_000,
    hsiHz: Number.isFinite(hsi) && hsi > 0 ? hsi : 16_000_000,
  };
}

interface Candidate {
  source: ClockSourceId;
  sourceLabel: string;
  m: number;
  n: number;
  p: number;
  vcoHz: number;
  sysclkHz: number;
  score: number;
}

/**
 * pllmn 的规划入口。返回与 pllmul 完全同形状的 ClockPlan，这样 ioc-plan 不用分叉。
 */
export function planClockPllmn(input: PllmnPlanInput): ClockPlan {
  const { request, entries, facts, familyId } = input;
  const vcoLimits = PLL_VCO_LIMITS[familyId.trim().toUpperCase()];
  const pllM = facts.pllM ?? [];
  const pllP = facts.pllP ?? [];
  const pllN = facts.pllN ?? null;
  if (vcoLimits === undefined) {
    return emptyClockPlan(familyId + " 的 PLLM/PLLN/PLLP 模型已从 db 读到，但 VCO 允许区间还没按手册核对：clock 参数不会生效");
  }
  if (pllM.length === 0 || pllP.length === 0 || pllN === null) {
    return emptyClockPlan(familyId + " 的 db 事实不全（缺 PLLM/PLLN/PLLP 枚举）：clock 参数不会生效");
  }
  const { hseHz, hsiHz } = readSourcesHz(entries);
  const hasHse = entries.has("RCC.HSE_VALUE") || entries.get("RCC.PLLSourceVirtual") === "RCC_PLLSOURCE_HSE";
  const targetHz = request?.targetHz ?? 0;
  const wantedSource = request?.pllSource ?? (hasHse ? "hse" : "hsi");

  // 1) 枚举所有 (源, M, N, P)，留下 VCO 与 SYSCLK 都合法的组合
  const candidates: Candidate[] = [];
  const nMin = Math.max(pllN.min, 2);
  const nMax = Math.min(pllN.max, 432);
  for (const source of facts.sources) {
    if (!source.selectable) continue;
    const srcHz = pllInHzOfSource(source.id, hseHz, hsiHz, facts);
    if (srcHz <= 0) continue;
    for (const m of pllM) {
      const inHz = srcHz / m.div;
      if (vcoLimits.inMinHz !== undefined && inHz < vcoLimits.inMinHz) continue;
      if (vcoLimits.inMaxHz !== undefined && inHz > vcoLimits.inMaxHz) continue;
      // N 全扫（50..432，几百个值，成本可忽略）：早先按目标反推邻域会在 P≠1 时把正确档位截掉
      // （8 MHz/4 × 168 × 1/2 = 168 MHz 这种档位就落在窗口外，实测选了 86 MHz）。
      for (let n = nMin; n <= nMax; n += 1) {
        const vcoHz = Math.round(inHz * n);
        if (vcoHz < vcoLimits.minHz || vcoHz > vcoLimits.maxHz) continue;
        for (const p of pllP) {
          const sysclkHz = Math.round(vcoHz / p.div);
          if (sysclkHz <= 0 || sysclkHz > facts.limits.sysclkHz) continue;
          const score = targetHz > 0 ? Math.abs(sysclkHz - targetHz) : 0;
          candidates.push({
            source: source.id,
            sourceLabel: source.label,
            m: m.div,
            n,
            p: p.div,
            vcoHz,
            sysclkHz,
            score,
          });
        }
      }
    }
  }
  if (candidates.length === 0) {
    return emptyClockPlan("在 " + familyId + " 的 PLLM/PLLN/PLLP 组合里找不到满足 VCO 与 SYSCLK 上限的档位：clock 参数不会生效");
  }

  // 2) 选最接近目标的；同分时优先「用户指定的源」、再优先 P=2（VCO 越高越少抖动）
  const sameSource = candidates.filter((item) => item.source === wantedSource);
  const pool = sameSource.length > 0 ? sameSource : candidates;
  pool.sort((left, right) => left.score - right.score || left.p - right.p || left.m - right.m);
  const best = pool[0] as Candidate;

  // 3) 总线频率与分频（APB1 取满足上限的最小分频，APB2 缺省 ÷1）
  const apb1Div = request?.apb1Div ?? minimalDiv(facts.apbDivs, best.sysclkHz, facts.limits.apb1Hz).div;
  const apb2Div = request?.apb2Div ?? 1;
  const apb1Hz = Math.round(best.sysclkHz / apb1Div);
  const apb2Hz = Math.round(best.sysclkHz / apb2Div);
  const adcDiv = request?.adcDiv ?? minimalDiv(facts.adcDivs.length > 0 ? facts.adcDivs : [{ div: 1, iocValue: "" }], apb2Hz, facts.limits.adcHz).div;
  const adcHz = Math.round(apb2Hz / adcDiv);

  const chain: ClockChainInfo = {
    pllSource: best.source,
    pllSourceLabel: best.sourceLabel,
    pllInHz: Math.round(pllInHzOfSource(best.source, hseHz, hsiHz, facts) / best.m),
    pllMul: best.n,
    pllM: best.m,
    pllN: best.n,
    pllP: best.p,
    pllClkHz: best.vcoHz / best.p,
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

  // 4) 要写的键（pllmn 用 PLLM/PLLN/PLLP，没有 PLLMUL）
  const mFact = divFact(pllM, best.m);
  const pFact = divFact(pllP, best.p);
  if (mFact === null || pFact === null) {
    return emptyClockPlan("PLLM/PLLP 的 .ioc 取值在 db 枚举里找不到：clock 参数不会生效");
  }
  const draft = new Map<string, string>();
  draft.set("RCC.PLLSourceVirtual", (pllSourceById(best.source, facts.sources) as { iocValue: string }).iocValue);
  draft.set("RCC.PLLM", mFact.iocValue);
  draft.set("RCC.PLLN", String(best.n));
  draft.set("RCC.PLLP", pFact.iocValue);
  draft.set("RCC.SYSCLKSource", "RCC_SYSCLKSOURCE_PLLCLK");
  draft.set("RCC.AHBCLKDivider", apbDivValue(1));
  draft.set("RCC.APB1CLKDivider", apbDivValue(apb1Div));
  draft.set("RCC.APB2CLKDivider", apbDivValue(apb2Div));
  draft.set("RCC.SYSCLKFreq_VALUE", String(best.sysclkHz));
  draft.set("RCC.HCLKFreq_Value", String(best.sysclkHz));
  draft.set("RCC.FCLKCortexFreq_Value", String(best.sysclkHz));
  draft.set("RCC.PLLCLKFreq_Value", String(Math.round(best.vcoHz / best.p)));
  draft.set("RCC.VCOOutputFreq_Value", String(best.vcoHz));
  draft.set("RCC.APB1Freq_Value", String(apb1Hz));
  draft.set("RCC.APB1TimFreq_Value", String(chain.apb1TimHz));
  draft.set("RCC.APB2Freq_Value", String(apb2Hz));
  draft.set("RCC.APB2TimFreq_Value", String(chain.apb2TimHz));
  if (adcDiv >= 2 && facts.adcDivs.length > 0) {
    const adcFact = divFact(facts.adcDivs, adcDiv);
    if (adcFact !== null && adcFact.iocValue !== "") {
      draft.set("RCC.ADCPresc", adcFact.iocValue);
      draft.set("RCC.ADCFreqValue", String(adcHz));
    }
  }
  // RCC.IPParameters 要把上面这些名字并进去（CubeMX 按它决定读哪些键）
  const existing = (entries.get("RCC.IPParameters") ?? "").split(",").map((item) => item.trim()).filter((item) => item !== "");
  const merged: string[] = [...existing];
  for (const key of draft.keys()) {
    const name = key.slice("RCC.".length);
    if (!merged.includes(name)) merged.push(name);
  }
  draft.set("RCC.IPParameters", merged.join(","));

  const reachable = targetHz === 0 || best.sysclkHz === targetHz;
  const deltaHz = targetHz === 0 ? 0 : best.sysclkHz - targetHz;
  const notes: string[] = [];
  notes.push(
    (targetHz === 0 ? "时钟现状" : reachable ? "目标 " + formatHz(targetHz) + " 可达" : "目标 " + formatHz(targetHz) + " 不可达，已选 " + formatHz(best.sysclkHz)) +
      "：" + best.sourceLabel + " ÷" + String(best.m) + " ×" + String(best.n) + " ÷" + String(best.p) +
      " → SYSCLK " + formatHz(best.sysclkHz) + "（VCO " + formatHz(best.vcoHz) + "）",
  );
  if (!reachable) notes.push("PLLM/PLLN/PLLP 只能凑出上面这一档最接近的频率");

  return {
    mode: targetHz === 0 ? "snapshot" : "nearest",
    ok: true,
    reachable,
    deltaHz,
    note: notes.join("；"),
    requested: {
      targetHz,
      pllSource: wantedSource,
      pllMul: best.n,
      apb1Div,
      apb2Div,
      adcDiv,
    },
    achieved: chain,
    alternatives: candidates
      .filter((item) => item.sysclkHz !== best.sysclkHz && item.source === best.source)
      .sort((left, right) => left.score - right.score)
      .slice(0, 3)
      .map((item) => ({
        sysclkHz: item.sysclkHz,
        pllSource: item.source,
        pllSourceLabel: item.sourceLabel,
        pllMul: item.n,
        apb1Div: minimalDiv(facts.apbDivs, item.sysclkHz, facts.limits.apb1Hz).div,
        adcDiv,
        usbAvailable: false,
        deltaHz: targetHz === 0 ? 0 : item.sysclkHz - targetHz,
      })),
    peripherals,
    bauds: [],
    entries: [...draft.entries()].map(([key, value]) => ({ key, value })),
    unset: ["RCC.PLLMUL", "RCC.PLLMCOFreq_Value", "RCC.USBPrescaler"],
    warnings: [],
    errors: [],
  };
}
