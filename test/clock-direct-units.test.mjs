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

// 无线族（WB0/WL3）：没有 PLL、总线不分频、源分频一源一键，且 RC64MPLL 是固定 64 MHz。
// 形状全部按 db 实测抄（RCC-STM32WB0_rcc_v1_0_Modes.xml / RCC-STM32WL33xx_rcc_v1_0_Modes.xml）。
function wb0Facts(overrides = {}) {
  return {
    model: "direct",
    muls: [],
    sources: [
      { id: "hse", label: "HSE（外部晶振）", iocValue: "RCC_SYSCLKSOURCE_DIRECT_HSE", defaultHz: 32_000_000, hzKey: "RCC.HSE_VALUE", selectable: true, note: "" },
      { id: "rc64", label: "RC64MPLL（64 MHz 内部 RC）", iocValue: "RCC_SYSCLKSOURCE_RC64MPLL", defaultHz: 64_000_000, selectable: true, note: "" },
    ],
    sysclkSourceKey: "RCC.SYSCLKSource",
    // 无 SYSCLK 分频器：SYSCLK 就是源频率（WB0 的 SYSCLK32/64Divider 是 CLKSYS 预分频，别当成 SYSCLK 分频）。
    // 总线不分频：没有 APB1CLKDivider 参数
    apbDivs: [],
    derivedClockNames: ["SysCLKFreq_VALUE", "CLKSYSFreq_VALUE", "MCO1PinFreq_Value"],
    adcDivs: [{ div: 1, iocValue: "" }],
    limits: { sysclkHz: 64_000_000, apb1Hz: 64_000_000, apb2Hz: 64_000_000, adcHz: 64_000_000 },
    usb: { hz: 48_000_000, requiresPllClkHz: 0, iocValue: "" },
    peripheralClocks: [{ id: "SPI1", label: "SPI1", bus: "apb1", kind: "spi" }],
    baudList: [115200],
    ...overrides,
  };
}

test("direct（WB0）：64 MHz 目标走 RC64MPLL，只写源，不写 CLKSYS 预分频、不碰 APB", () => {
  const e = new Map([
    ["RCC.HSE_VALUE", "32000000"],
    ["RCC.SysCLKFreq_VALUE", "48000000"],
    ["RCC.IPParameters", "HSE_VALUE,HSI_VALUE,SysCLKFreq_VALUE"],
  ]);
  const plan = planClockDirect({ request: { targetHz: 64_000_000 }, entries: e, facts: wb0Facts(), familyId: "STM32WB0" });
  assert.equal(plan.ok, true, plan.note);
  assert.equal(plan.reachable, true, plan.note);
  assert.equal(plan.achieved.sysclkHz, 64_000_000);
  const map = keyed(plan);
  assert.equal(map.get("RCC.SYSCLKSource"), "RCC_SYSCLKSOURCE_RC64MPLL");
  assert.equal(map.get("RCC.SysCLKFreq_VALUE"), "64000000");
  // 总线不分频：写 APB1CLKDivider 会被 CubeMX 当未知键丢掉
  assert.equal(map.get("RCC.APB1CLKDivider"), undefined);
  assert.equal(map.get("RCC.AHBCLKDivider"), undefined);
  // CLKSYS 预分频键一个都不该写：它们不改变 SYSCLK，写了只会让 CLKSYS 差一截
  assert.equal(map.get("RCC.SYSCLK64Divider"), undefined);
  assert.equal(map.get("RCC.SYSCLK32Divider"), undefined);
});

test("direct（WB0）：HSE 32 MHz 直接当 SYSCLK；HSE 那一路凑不出目标时放开到 RC64MPLL", () => {
  const e = new Map([["RCC.HSE_VALUE", "32000000"]]);
  const asIs = new Map(e);
  asIs.set("RCC.SYSCLKSource", "RCC_SYSCLKSOURCE_DIRECT_HSE");
  const hse = planClockDirect({ request: { targetHz: 32_000_000 }, entries: asIs, facts: wb0Facts(), familyId: "STM32WB0" });
  assert.equal(hse.reachable, true, hse.note);
  assert.equal(hse.achieved.pllSource, "hse", "当前源能凑出目标时不该换源");
  assert.equal(keyed(hse).get("RCC.SYSCLKSource"), "RCC_SYSCLKSOURCE_DIRECT_HSE");
  assert.equal(keyed(hse).get("RCC.SYSCLK32Divider"), undefined, "分频器是 CLKSYS 的，不该写");
  // 64 MHz 在 HSE（8/32 MHz）那一路凑不出来，必须换到 RC64MPLL，而不是报「不可达」
  const rc = planClockDirect({ request: { targetHz: 64_000_000 }, entries: e, facts: wb0Facts(), familyId: "STM32WB0" });
  assert.equal(rc.achieved.sysclkHz, 64_000_000);
  assert.equal(rc.achieved.pllSource, "rc64");
});

test("direct（WL3）：源键是 ROOTClkSource，48 MHz HSE 直接当 SYSCLK；凑不出的目标报最近档", () => {
  const facts = wb0Facts({
    sysclkSourceKey: "RCC.ROOTClkSource",
    sources: [
      { id: "hse", label: "HSE（外部晶振）", iocValue: "RCC_SYSCLKSOURCE_DIRECT_HSE", defaultHz: 48_000_000, hzKey: "RCC.HSE_VALUE", selectable: true, note: "" },
      { id: "rc64", label: "RC64MPLL（64 MHz 内部 RC）", iocValue: "RCC_SYSCLKSOURCE_RC64MPLL", defaultHz: 64_000_000, selectable: true, note: "" },
    ],
  });
  const e = new Map([
    ["RCC.HSE_VALUE", "48000000"],
    ["RCC.ROOTClkSource", "RCC_SYSCLKSOURCE_DIRECT_HSE"],
  ]);
  const hit = planClockDirect({ request: { targetHz: 48_000_000 }, entries: e, facts, familyId: "STM32WL3" });
  const map = keyed(hit);
  assert.equal(map.get("RCC.ROOTClkSource"), "RCC_SYSCLKSOURCE_DIRECT_HSE");
  assert.equal(map.get("RCC.SYSCLKSource"), undefined, "WL3 没有 SYSCLKSource 这个键");
  assert.equal(map.get("RCC.SYSCLK48Divider"), undefined, "SYSCLK48Divider 是 CLKSYS 预分频，不是 SYSCLK 分频");
  // 16 MHz 在 WL3 上做不到（源只有 48/64 MHz 两档，且没有 SYSCLK 分频器）：报最接近的 48 MHz，并说清不可达
  const miss = planClockDirect({ request: { targetHz: 16_000_000 }, entries: e, facts, familyId: "STM32WL3" });
  assert.equal(miss.reachable, false);
  assert.equal(miss.achieved.sysclkHz, 48_000_000);
});

test("direct：db 里没有能直连的源 → 空计划（不猜一个 HSI 出来）", () => {
  const plan = planClockDirect({ request: { targetHz: 48_000_000 }, entries, facts: c0Facts({ sources: [] }), familyId: "STM32C0" });
  assert.equal(plan.ok, false);
  assert.match(plan.note, /SYSCLKSource|源/u);
});
