// pllmn 时钟规划（src/engine/clock-pllmn.ts）的离线单测：VCO 约束、PLLM/PLLN/PLLP 写键、拒绝分支。
// 用合成事实，不依赖本机 CubeMX；真机往返（F4）另有脚本。
import assert from "node:assert/strict";
import { test } from "node:test";

import { planClockPllmn } from "../lib/engine/clock-pllmn.js";

/** F4 形状的合成事实（RM0090：VCO 100–432 MHz，SYSCLK ≤168）。 */
function f4Facts(overrides = {}) {
  return {
    model: "pllmn",
    muls: [],
    pllM: [{ div: 2, iocValue: "RCC_PLLM_DIV2" }, { div: 4, iocValue: "RCC_PLLM_DIV4" }, { div: 8, iocValue: "RCC_PLLM_DIV8" }],
    pllN: { min: 50, max: 432 },
    pllP: [{ div: 2, iocValue: "RCC_PLLP_DIV2" }, { div: 4, iocValue: "RCC_PLLP_DIV4" }],
    sources: [{ id: "hse", label: "HSE", iocValue: "RCC_PLLSOURCE_HSE", defaultHz: 8_000_000, selectable: true, note: "" }],
    apbDivs: [1, 2, 4, 8, 16].map((div) => ({ div, iocValue: "RCC_HCLK_DIV" + String(div) })),
    // AHB 的枚举名与 APB 不是同一套（db 实测：F2/F4/F7 是 RCC_SYSCLK_DIVn）
    ahbDivs: [1, 2, 4, 8, 16].map((div) => ({ div, iocValue: "RCC_SYSCLK_DIV" + String(div) })),
    adcDivs: [{ div: 2, iocValue: "RCC_ADCPCLK2_DIV2" }, { div: 4, iocValue: "RCC_ADCPCLK2_DIV4" }],
    limits: { sysclkHz: 168_000_000, apb1Hz: 42_000_000, apb2Hz: 84_000_000, adcHz: 36_000_000 },
    // VCO 区间跟着 facts 走（planner 不再按族名查表）
    vco: { minHz: 100_000_000, maxHz: 432_000_000, inMinHz: 1_000_000, inMaxHz: 2_000_000 },
    usb: { hz: 48_000_000, requiresPllClkHz: 0, iocValue: "" },
    peripheralClocks: [
      { id: "USART1", label: "USART1", bus: "apb2", kind: "usart" },
      { id: "TIM2", label: "TIM2", bus: "apb1", kind: "tim" },
    ],
    baudList: [115200],
    ...overrides,
  };
}

const entries = new Map([["RCC.HSE_VALUE", "8000000"]]);

test("pllmn：8 MHz HSE 目标 168 MHz → M=8/N=336/P=2，写 PLLM/PLLN/PLLP 并清掉 PLLMUL", () => {
  const plan = planClockPllmn({ request: { targetHz: 168_000_000 }, entries, facts: f4Facts(), familyId: "STM32F4" });
  assert.equal(plan.ok, true, plan.note);
  assert.equal(plan.achieved.sysclkHz, 168_000_000, plan.note);
  assert.equal(plan.reachable, true);
  const map = new Map(plan.entries.map((item) => [item.key, item.value]));
  assert.equal(map.get("RCC.PLLN"), String(plan.achieved.pllN));
  assert.match(map.get("RCC.PLLM") ?? "", /^RCC_PLLM_DIV\d+$/u);
  assert.match(map.get("RCC.PLLP") ?? "", /^RCC_PLLP_DIV\d+$/u);
  assert.equal(map.get("RCC.PLLMUL"), undefined, "pllmn 不该写 PLLMUL");
  assert.ok(plan.unset.includes("RCC.PLLMUL"), "要显式删掉旧模型留下的 RCC.PLLMUL");
  // VCO 必须落在 100–432 MHz
  const vco = Number.parseInt(map.get("RCC.VCOOutputFreq_Value") ?? "0", 10);
  assert.ok(vco >= 100_000_000 && vco <= 432_000_000, "VCO 越界：" + vco);
  // 总线频率跟着 SYSCLK 走：APB1 ≤42 MHz、APB2 ≤84 MHz（都取满足上限的最小分频）
  assert.ok(plan.achieved.apb1Hz <= 42_000_000);
  assert.equal(plan.achieved.apb2Hz, 84_000_000, "168 MHz SYSCLK 下 APB2 上限 84 MHz → 必须 ÷2");
  assert.equal(map.get("RCC.APB2CLKDivider"), "RCC_HCLK_DIV2");
  // AHB 分频的取值来自 facts（db 的 AHBCLKDivider 枚举），不是硬编码的 RCC_HCLK_DIV1
  assert.equal(map.get("RCC.AHBCLKDivider"), "RCC_SYSCLK_DIV1");
});

test("pllmn：AHB 分频值只来自 facts —— facts 没有 AHB 枚举时不写这个键（缺省 ÷1 正好是我们要的）", () => {
  const plan = planClockPllmn({
    request: { targetHz: 168_000_000 },
    entries,
    facts: f4Facts({ ahbDivs: undefined }),
    familyId: "STM32F4",
  });
  assert.equal(plan.ok, true, plan.note);
  const map = new Map(plan.entries.map((item) => [item.key, item.value]));
  assert.equal(map.get("RCC.AHBCLKDivider"), undefined, "宁可不写，也不写一个可能非法的枚举名");
  assert.equal(map.get("RCC.APB1CLKDivider"), "RCC_HCLK_DIV4");
});

test("pllmn：APB2 也按上限分频（F2 反例：120 MHz SYSCLK / 60 MHz APB2 → ÷2，不是 ÷1）", () => {
  const facts = f4Facts({
    pllM: [2, 4, 8, 20].map((div) => ({ div, iocValue: String(div) })),
    limits: { sysclkHz: 120_000_000, apb1Hz: 30_000_000, apb2Hz: 60_000_000, adcHz: 60_000_000 },
    vco: { minHz: 192_000_000, maxHz: 432_000_000, inMinHz: 1_000_000, inMaxHz: 2_000_000 },
    sources: [{ id: "hse", label: "HSE", iocValue: "RCC_PLLSOURCE_HSE", defaultHz: 8_000_000, selectable: true, note: "" }],
  });
  const plan = planClockPllmn({
    request: { targetHz: 120_000_000 },
    entries: new Map([["RCC.HSE_VALUE", "25000000"]]),
    facts,
    familyId: "STM32F2",
  });
  assert.equal(plan.ok, true, plan.note);
  assert.equal(plan.achieved.sysclkHz, 120_000_000, plan.note);
  const map = new Map(plan.entries.map((item) => [item.key, item.value]));
  assert.equal(map.get("RCC.APB2CLKDivider"), "RCC_HCLK_DIV2", "APB2 60 MHz 上限 → ÷2");
  assert.ok(plan.achieved.apb2Hz <= 60_000_000, "APB2 不能超 60 MHz：" + plan.achieved.apb2Hz);
  assert.ok(plan.achieved.apb1Hz <= 30_000_000, "APB1 不能超 30 MHz：" + plan.achieved.apb1Hz);
});

test("pllmn：目标不可达时给最接近的一档并写进 note（不静默）", () => {
  // 100 MHz 本身是可达的（8/4×100/2）；用 100_000_001 这种凑不出来的目标验证「不可达」分支
  const plan = planClockPllmn({ request: { targetHz: 100_000_001 }, entries, facts: f4Facts(), familyId: "STM32F4" });
  assert.equal(plan.ok, true);
  assert.equal(plan.reachable, false);
  assert.ok(Math.abs(plan.deltaHz) > 0);
  assert.match(plan.note, /不可达|可达/u);
});

test("pllmn：没有 VCO 区间（db 与 override 表都没有）或事实不全 → 空计划 + 说清原因", () => {
  // VCO 区间来自 facts：把它摘掉就等于「这一族的 db 与 override 表都没给区间」
  const noVco = planClockPllmn({ request: { targetHz: 168_000_000 }, entries, facts: f4Facts({ vco: undefined }), familyId: "STM32F4" });
  assert.equal(noVco.ok, false);
  assert.match(noVco.note, /VCO/u);
  const noPllN = planClockPllmn({ request: { targetHz: 168_000_000 }, entries, facts: f4Facts({ pllN: null }), familyId: "STM32F4" });
  assert.equal(noPllN.ok, false);
  assert.match(noPllN.note, /pllN|事实不全/u);
});

test("pllmn：外设频率按总线算（TIM 在 APB1 上自动 ×2，USART 在 APB2 上不乘）", () => {
  const plan = planClockPllmn({ request: { targetHz: 84_000_000 }, entries, facts: f4Facts(), familyId: "STM32F4" });
  const byId = new Map(plan.peripherals.map((item) => [item.id, item]));
  const tim = byId.get("TIM2");
  const usart = byId.get("USART1");
  assert.notEqual(tim, undefined);
  assert.notEqual(usart, undefined);
  assert.ok((tim?.clockHz ?? 0) > 0 && (usart?.clockHz ?? 0) > 0);
});

/** PLL1 形状的合成事实（H5/U5/WBA/L4+ 那套：PLL1P/PLL1R、VCI 分段、PLLUsed 开关）。 */
function pll1Facts(overrides = {}) {
  return {
    model: "pllmn",
    muls: [],
    pllM: [1, 2, 4, 8].map((div) => ({ div, iocValue: String(div) })),
    pllN: { min: 4, max: 512 },
    pllP: [2, 4, 8].map((div) => ({ div, iocValue: "RCC_PLL1_DIV" + String(div) })),
    sources: [{ id: "hse", label: "HSE", iocValue: "RCC_PLL1_SOURCE_HSE", defaultHz: 8_000_000, selectable: true, note: "" }],
    apbDivs: [1, 2, 4, 8, 16].map((div) => ({ div, iocValue: "RCC_HCLK_DIV" + String(div) })),
    ahbDivs: [1, 2, 4, 8, 16].map((div) => ({ div, iocValue: "RCC_SYSCLK_DIV" + String(div) })),
    adcDivs: [],
    limits: { sysclkHz: 250_000_000, apb1Hz: 250_000_000, apb2Hz: 250_000_000, adcHz: 250_000_000 },
    vco: { minHz: 128_000_000, maxHz: 560_000_000, inMinHz: 1_000_000, inMaxHz: 16_000_000 },
    vcoBands: [
      { value: "RCC_PLL1_VCIRANGE_0", inMinHz: 1_000_000, inMaxHz: 2_000_000, minHz: 150_000_000, maxHz: 420_000_000, vcoSel: "RCC_PLL1_VCORANGE_MEDIUM" },
      { value: "RCC_PLL1_VCIRANGE_1", inMinHz: 2_000_000, inMaxHz: 4_000_000, minHz: 128_000_000, maxHz: 560_000_000, vcoSel: "RCC_PLL1_VCORANGE_WIDE" },
    ],
    vciRangeKey: "RCC.PLL1_VCI_Range",
    vcoSelKey: "RCC.PLL1_VCO_SEL",
    pll1Naming: true,
    pllMKey: "RCC.PLLM1",
    pllPKey: "RCC.PLL1P",
    pllRKey: "RCC.PLL1R",
    pllEnable: { usedKey: "RCC.PLLUsed", usedValue: "1", stateKey: "RCC.PLLState", stateValue: "RCC_PLL_ON" },
    knownDerivedNames: ["SYSCLKFreq_VALUE", "HCLKFreq_Value", "AHBFreq_Value", "PLL1CLKFreq_Value", "VCOOutputFreq_Value", "APB1Freq_Value", "APB1TimFreq_Value", "APB2Freq_Value", "APB2TimFreq_Value"],
    usb: { hz: 48_000_000, requiresPllClkHz: 0, iocValue: "" },
    peripheralClocks: [],
    baudList: [],
    ...overrides,
  };
}

test("pllmn/PLL1：键名按 db 走（PLLM1/PLL1P），写 VCI 频段与 VCO 档位，只写 PLLUsed 不写 PLLState", () => {
  const plan = planClockPllmn({ request: { targetHz: 100_000_000 }, entries, facts: pll1Facts(), familyId: "STM32H5" });
  assert.equal(plan.ok, true, plan.note);
  assert.equal(plan.achieved.sysclkHz, 100_000_000, plan.note);
  const map = new Map(plan.entries.map((item) => [item.key, item.value]));
  assert.notEqual(map.get("RCC.PLLM1"), undefined, "L4+/PLL1 族的输入分频键是 RCC.PLLM1");
  assert.equal(map.get("RCC.PLLM"), undefined, "不该再写旧名 RCC.PLLM");
  assert.notEqual(map.get("RCC.PLL1P"), undefined, "PLL1 族输出键是 RCC.PLL1P");
  assert.equal(map.get("RCC.PLLP"), undefined);
  // 写回去的 VCI 频段必须就是这一档输入频率所落的段（0 段 MEDIUM / 1 段 WIDE 都可能是最优解，
  // 所以这里按实际选中的输入频率反查，而不是写死某一段）
  const facts = pll1Facts();
  const inHz = plan.achieved.pllInHz;
  const band = facts.vcoBands.find((item) => inHz >= item.inMinHz && inHz <= item.inMaxHz);
  assert.notEqual(band, undefined, "输入频率没落在任何分段：" + inHz);
  assert.equal(map.get("RCC.PLL1_VCI_Range"), band.value);
  assert.equal(map.get("RCC.PLL1_VCO_SEL"), band.vcoSel);
  assert.equal(map.get("RCC.PLLUsed"), "1", "不写 PLLUsed=1 时 CubeMX 会认为不用 PLL");
  assert.equal(map.get("RCC.PLLState"), undefined, "PLLState 是派生键，写了会被 CubeMX 丢掉（F4/F7 实测）");
});

test("pllmn/PLL1：VCO 上限跟着输入频段走（1 MHz 段只到 420 MHz，2 MHz 段才到 560 MHz）", () => {
  // 目标 250 MHz：1 MHz 输入段最多 420 MHz VCO → 撑不到 250 MHz×2，必须换到 2–4 MHz 段
  const plan = planClockPllmn({ request: { targetHz: 250_000_000 }, entries, facts: pll1Facts(), familyId: "STM32H5" });
  assert.equal(plan.ok, true, plan.note);
  assert.equal(plan.achieved.sysclkHz, 250_000_000, plan.note);
  const map = new Map(plan.entries.map((item) => [item.key, item.value]));
  const inHz = plan.achieved.pllInHz;
  assert.ok(inHz >= 2_000_000 && inHz <= 4_000_000, "要落进 2–4 MHz 段才够 560 MHz VCO：" + inHz);
  assert.equal(map.get("RCC.PLL1_VCI_Range"), "RCC_PLL1_VCIRANGE_1");
  assert.equal(map.get("RCC.PLL1_VCO_SEL"), "RCC_PLL1_VCORANGE_WIDE");
});

test("pllmn/PLL1：派生频率键只在 db 有同名参数时写，SYSCLKFreq_VALUE 永远写", () => {
  const plan = planClockPllmn({ request: { targetHz: 100_000_000 }, entries, facts: pll1Facts(), familyId: "STM32H5" });
  assert.equal(plan.ok, true, plan.note);
  const map = new Map(plan.entries.map((item) => [item.key, item.value]));
  assert.equal(map.get("RCC.SYSCLKFreq_VALUE"), "100000000", "SYSCLKFreq_VALUE 的尾巴是 _VALUE，不在名单里也必须写");
  assert.equal(map.get("RCC.PLLCLKFreq_Value"), undefined, "db 没有 PLLCLKFreq_Value（H5 只有 PLL1CLKFreq_Value）→ 不写");
  assert.equal(map.get("RCC.PLL1CLKFreq_Value"), "100000000", "派生键跟着 db 名单换名");
});

test("pllmn：db 带 Cortex 分频参数时不写 CortexFreq_Value（交给 CubeMX，避免往返反向改写）", () => {
  const plan = planClockPllmn({
    request: { targetHz: 100_000_000 },
    entries,
    facts: pll1Facts({ cortexFollowsHclk: false, knownDerivedNames: ["SYSCLKFreq_VALUE", "HCLKFreq_Value", "CortexFreq_Value", "FCLKCortexFreq_Value"] }),
    familyId: "STM32U5",
  });
  assert.equal(plan.ok, true, plan.note);
  const map = new Map(plan.entries.map((item) => [item.key, item.value]));
  assert.equal(map.get("RCC.CortexFreq_Value"), undefined);
  assert.equal(map.get("RCC.FCLKCortexFreq_Value"), undefined);
  assert.equal(map.get("RCC.HCLKFreq_Value"), "100000000", "HCLK 还是要写（AHB 固定 ÷1）");
});
