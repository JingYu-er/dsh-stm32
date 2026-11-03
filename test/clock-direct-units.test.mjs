// direct 时钟模型（src/engine/clock-direct.ts）的离线单测：没有 PLL、SYSCLK 直接取源（C0）。
// 用合成事实，不依赖本机 CubeMX；真机往返（C0 @48 MHz）另有脚本。
import assert from "node:assert/strict";
import { test } from "node:test";

import { planClockDirect } from "../lib/engine/clock-direct.js";

/** C0 形状的合成事实（db 实测：单 APB1、HSISYSCLKDivider ÷1..÷128、SYSCLK ≤48 MHz）。 */
function c0Facts(overrides = {}) {
  return {
    model: "direct",
    muls: [],
    sources: [
      { id: "hse", label: "HSE（外部晶振）", iocValue: "RCC_SYSCLKSOURCE_HSE", defaultHz: 8_000_000, selectable: true, note: "" },
      { id: "hsi", label: "HSI（内部 RC）", iocValue: "RCC_SYSCLKSOURCE_HSI", defaultHz: 48_000_000, selectable: true, note: "" },
    ],
    sysclkSourceKey: "RCC.SYSCLKSource",
    srcDivs: [1, 2, 4, 8, 16, 32, 64, 128].map((div) => ({ div, iocValue: "RCC_HSI_DIV" + String(div) })),
    srcDivKey: "RCC.HSISYSCLKDivider",
    srcDivSources: ["hsi"],
    // db 的 RefParameter 名单里既有算得出来的（APB/APB Tim），也有依赖外设自身选源的（MCO1Pin/USART1）
    derivedClockNames: [
      "SYSCLKFreq_VALUE",
      "HCLKFreq_Value",
      "AHBFreq_Value",
      "CortexFreq_Value",
      "FCLKCortexFreq_Value",
      "PWRFreq_Value",
      "APBFreq_Value",
      "APBTimFreq_Value",
      "ADCFreq_Value",
      "MCO1PinFreq_Value",
      "USART1Freq_Value",
    ],
    apbDivs: [1, 2, 4, 8, 16].map((div) => ({ div, iocValue: "RCC_APB1_DIV" + String(div) })),
    // C0 没有 APB2CLKDivider，AHB 的取值名是 RCC_HCLK_DIVn
    ahbDivs: [1, 2, 4, 8, 16].map((div) => ({ div, iocValue: "RCC_HCLK_DIV" + String(div) })),
    adcDivs: [{ div: 1, iocValue: "" }],
    limits: { sysclkHz: 48_000_000, apb1Hz: 48_000_000, apb2Hz: 48_000_000, adcHz: 48_000_000 },
    usb: { hz: 48_000_000, requiresPllClkHz: 0, iocValue: "" },
    peripheralClocks: [
      { id: "USART1", label: "USART1", bus: "apb1", kind: "usart" },
      { id: "TIM1", label: "TIM1", bus: "apb1", kind: "tim" },
    ],
    baudList: [115200],
    ...overrides,
  };
}

const entries = new Map([
  ["RCC.HSE_VALUE", "8000000"],
  ["RCC.HSI_VALUE", "48000000"],
  ["RCC.IPParameters", "ADCFreq_Value,SYSCLKFreq_VALUE"],
]);

const keyed = (plan) => new Map(plan.entries.map((item) => [item.key, item.value]));

test("direct：HSI 48 MHz 目标 48 MHz → 只写源 + 源分频，不写任何 PLL 键", () => {
  const plan = planClockDirect({ request: { targetHz: 48_000_000 }, entries, facts: c0Facts(), familyId: "STM32C0" });
  assert.equal(plan.ok, true, plan.note);
  assert.equal(plan.reachable, true);
  assert.equal(plan.achieved.sysclkHz, 48_000_000);
  const map = keyed(plan);
  assert.equal(map.get("RCC.SYSCLKSource"), "RCC_SYSCLKSOURCE_HSI");
  assert.equal(map.get("RCC.HSISYSCLKDivider"), "RCC_HSI_DIV1");
  assert.equal(map.get("RCC.APB1CLKDivider"), "RCC_APB1_DIV1");
  assert.equal(map.get("RCC.AHBCLKDivider"), "RCC_HCLK_DIV1");
  for (const key of ["RCC.PLLMUL", "RCC.PLLM", "RCC.PLLN", "RCC.PLLP", "RCC.PLLSourceVirtual"]) {
    assert.equal(map.get(key), undefined, "direct 模型不该写 " + key);
  }
  assert.ok(plan.unset.includes("RCC.PLLMUL"), "要显式删掉别的模型留下的 RCC.PLLMUL");
});

test("direct：单 APB 族不写 RCC.APB2CLKDivider（C0 没有这个参数，写了会被 CubeMX 丢掉）", () => {
  const plan = planClockDirect({ request: { targetHz: 48_000_000 }, entries, facts: c0Facts(), familyId: "STM32C0" });
  const map = keyed(plan);
  assert.equal(map.get("RCC.APB2CLKDivider"), undefined);
  assert.equal(plan.achieved.apb2Div, plan.achieved.apb1Div);
});

test("direct：目标 12 MHz 走 HSI÷4（源分频就是这一族的全部档位）", () => {
  const plan = planClockDirect({ request: { targetHz: 12_000_000 }, entries, facts: c0Facts(), familyId: "STM32C0" });
  assert.equal(plan.ok, true, plan.note);
  assert.equal(plan.achieved.sysclkHz, 12_000_000);
  assert.equal(keyed(plan).get("RCC.HSISYSCLKDivider"), "RCC_HSI_DIV4");
  assert.match(plan.note, /HSI.*÷4|÷4.*SYSCLK/u);
});

test("direct：凑不出来的目标给最近档并写进 note（不静默）", () => {
  // 36 MHz 不在 48/div 的档位里（48/1=48、48/2=24）
  const plan = planClockDirect({ request: { targetHz: 36_000_000 }, entries, facts: c0Facts(), familyId: "STM32C0" });
  assert.equal(plan.ok, true);
  assert.equal(plan.reachable, false);
  assert.match(plan.note, /不可达/u);
  assert.ok([48_000_000, 24_000_000].includes(plan.achieved.sysclkHz), "只能给 48 或 24：" + plan.achieved.sysclkHz);
});

test("direct：指定 HSE 源时不写 HSI 源分频（源分频只作用于 HSI）", () => {
  const plan = planClockDirect({ request: { targetHz: 8_000_000, pllSource: "hse" }, entries, facts: c0Facts(), familyId: "STM32C0" });
  assert.equal(plan.ok, true, plan.note);
  assert.equal(plan.achieved.sysclkHz, 8_000_000);
  const map = keyed(plan);
  assert.equal(map.get("RCC.SYSCLKSource"), "RCC_SYSCLKSOURCE_HSE");
  assert.equal(map.get("RCC.HSISYSCLKDivider"), undefined, "HSE 直连，不该写 HSI 的源分频");
});

test("direct：派生频率键只写算得出来的（APB/APB Tim 写对，MCO1Pin/USART1 留给 CubeMX 重算）", () => {
  const plan = planClockDirect({ request: { targetHz: 48_000_000 }, entries, facts: c0Facts(), familyId: "STM32C0" });
  const map = keyed(plan);
  assert.equal(map.get("RCC.SYSCLKFreq_VALUE"), "48000000");
  assert.equal(map.get("RCC.HCLKFreq_Value"), "48000000");
  assert.equal(map.get("RCC.APBFreq_Value"), "48000000");
  assert.equal(map.get("RCC.APBTimFreq_Value"), "48000000");
  assert.equal(map.get("RCC.ADCFreq_Value"), "48000000");
  for (const key of ["RCC.MCO1PinFreq_Value", "RCC.USART1Freq_Value"]) {
    assert.equal(map.get(key), undefined, "依赖外设自身选源的派生键不该猜：" + key);
  }
  // IPParameters 要把写进去的名字并进名单，按 ASCII 升序（CubeMX 的写法）
  const names = (map.get("RCC.IPParameters") ?? "").split(",");
  assert.ok(names.includes("SYSCLKFreq_VALUE"));
  assert.ok(names.includes("APBFreq_Value"));
  assert.deepEqual(names, [...names].sort());
});

test("direct：APB1 降到 ÷2 时 APB/APB Tim 跟着变（Tim = APB ×2）", () => {
  const plan = planClockDirect({
    request: { targetHz: 48_000_000, apb1Div: 2 },
    entries,
    facts: c0Facts(),
    familyId: "STM32C0",
  });
  const map = keyed(plan);
  assert.equal(plan.achieved.apb1Hz, 24_000_000);
  assert.equal(map.get("RCC.APB1CLKDivider"), "RCC_APB1_DIV2");
  assert.equal(map.get("RCC.APBFreq_Value"), "24000000");
  assert.equal(map.get("RCC.APBTimFreq_Value"), "48000000", "APB1 分频 >1 时 TIM 时钟 = APB1 ×2");
});

test("direct：快照模式按 .ioc 现在的源与分频读（模板默认 HSI÷4 = 12 MHz）", () => {
  const asIs = new Map(entries);
  asIs.set("RCC.SYSCLKSource", "RCC_SYSCLKSOURCE_HSI");
  asIs.set("RCC.HSISYSCLKDivider", "RCC_HSI_DIV4");
  const plan = planClockDirect({ request: undefined, entries: asIs, facts: c0Facts(), familyId: "STM32C0" });
  assert.equal(plan.ok, true, plan.note);
  assert.equal(plan.mode, "snapshot");
  assert.equal(plan.achieved.sysclkHz, 12_000_000);
  assert.equal(plan.achieved.pllSource, "hsi");
});

test("direct：只给 pllMul（这一族没有 PLL）→ 空计划 + 说清不适用", () => {
  const plan = planClockDirect({ request: { pllMul: 9 }, entries, facts: c0Facts(), familyId: "STM32C0" });
  assert.equal(plan.ok, false);
  assert.match(plan.note, /pllMul/u);
});

test("direct：SYSCLK 上限挡住超频（目标 56 MHz 在 C0 上只能到 48 MHz）", () => {
  const plan = planClockDirect({ request: { targetHz: 56_000_000 }, entries, facts: c0Facts(), familyId: "STM32C0" });
  assert.equal(plan.ok, true);
  assert.equal(plan.achieved.sysclkHz, 48_000_000);
  assert.ok(plan.achieved.sysclkHz <= 48_000_000);
});

test("direct：db 里没有能直连的源 → 空计划（不猜一个 HSI 出来）", () => {
  const plan = planClockDirect({ request: { targetHz: 48_000_000 }, entries, facts: c0Facts({ sources: [] }), familyId: "STM32C0" });
  assert.equal(plan.ok, false);
  assert.match(plan.note, /SYSCLKSource|源/u);
});
