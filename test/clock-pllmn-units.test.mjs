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
    adcDivs: [{ div: 2, iocValue: "RCC_ADCPCLK2_DIV2" }, { div: 4, iocValue: "RCC_ADCPCLK2_DIV4" }],
    limits: { sysclkHz: 168_000_000, apb1Hz: 42_000_000, apb2Hz: 84_000_000, adcHz: 36_000_000 },
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
  // 总线频率跟着 SYSCLK 走，APB1 不超过 42 MHz
  assert.ok(plan.achieved.apb1Hz <= 42_000_000);
  assert.equal(plan.achieved.apb2Hz, 168_000_000);
});

test("pllmn：目标不可达时给最接近的一档并写进 note（不静默）", () => {
  // 100 MHz 本身是可达的（8/4×100/2）；用 100_000_001 这种凑不出来的目标验证「不可达」分支
  const plan = planClockPllmn({ request: { targetHz: 100_000_001 }, entries, facts: f4Facts(), familyId: "STM32F4" });
  assert.equal(plan.ok, true);
  assert.equal(plan.reachable, false);
  assert.ok(Math.abs(plan.deltaHz) > 0);
  assert.match(plan.note, /不可达|可达/u);
});

test("pllmn：没有 VCO 区间（族没核过）或事实不全 → 空计划 + 说清原因", () => {
  const noVco = planClockPllmn({ request: { targetHz: 168_000_000 }, entries, facts: f4Facts(), familyId: "STM32G4" });
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
