// 派生频率键“跟随改写”（src/engine/clock-derived.ts）的离线单测。
// 规则：旧值等于某个时钟域、且该域新旧都不分叉 → 跟着那个域改写；对不上或有歧义 → 不动。
import assert from "node:assert/strict";
import { test } from "node:test";

import { followDerivedClocks, isDerivedFrequencyKey, isFollowableDerivedName } from "../lib/engine/clock-derived.js";

/** C0 模板改写前的那一组（全部 12 MHz，只在 HSI÷4 下成立）。 */
function c0Before() {
  return new Map([
    ["RCC.SYSCLKFreq_VALUE", "12000000"],
    ["RCC.AHBFreq_Value", "12000000"],
    ["RCC.HCLKFreq_Value", "12000000"],
    ["RCC.APBFreq_Value", "12000000"],
    ["RCC.APBTimFreq_Value", "12000000"],
    ["RCC.ADCFreq_Value", "12000000"],
    ["RCC.USART1Freq_Value", "12000000"],
    ["RCC.I2C1Freq_Value", "12000000"],
    ["RCC.MCO1PinFreq_Value", "12000000"],
    ["RCC.WatchDogFreq_Value", "32000"],
    ["RCC.PWRFreq_Value", "12000000"],
  ]);
}

test("isDerivedFrequencyKey：Freq_Value / FreqValue 都认，SYSCLKFreq_VALUE 的大写 VALUE 也认", () => {
  assert.equal(isDerivedFrequencyKey("RCC.USART1Freq_Value"), true);
  assert.equal(isDerivedFrequencyKey("RCC.ADCFreqValue"), true);
  assert.equal(isDerivedFrequencyKey("RCC.SYSCLKFreq_VALUE"), true);
  assert.equal(isDerivedFrequencyKey("RCC.SYSCLKSource"), false);
  assert.equal(isDerivedFrequencyKey("RCC.HSE_VALUE"), false);
  assert.equal(isDerivedFrequencyKey("USART1Freq_Value"), false);
});

test("isFollowableDerivedName：MCO/VCO/PLL/振荡器/32k 域都不跟随（G4 回归翻车的两个键在这里）", () => {
  for (const name of ["MCO1PinFreq_Value", "MCO2PinFreq_Value", "VCOInputFreq_Value", "VCOOutputFreq_Value", "PLLCLKFreq_Value", "PLLI2SRCLKFreq_Value", "PLLSAI1PoutputFreq_Value", "HSE_VALUE", "HSIFreq_Value", "RTCFreq_Value", "WatchDogFreq_Value", "LSCOPinFreq_Value"]) {
    assert.equal(isFollowableDerivedName(name), false, name + " 不该跟随");
  }
  for (const name of ["USART1Freq_Value", "I2C1Freq_Value", "FDCANFreq_Value", "PWRFreq_Value", "APB1TimFreq_Value", "SYSCLKFreq_VALUE"]) {
    assert.equal(isFollowableDerivedName(name), true, name + " 应该跟随");
  }
});

test("MCO / VCOInput 的旧值等于旧 SYSCLK 时也不改（G4 @170 MHz 实证）", () => {
  const entries = new Map([
    ["RCC.SYSCLKFreq_VALUE", "16000000"],
    ["RCC.HCLKFreq_Value", "16000000"],
    ["RCC.APB1Freq_Value", "16000000"],
    ["RCC.MCO1PinFreq_Value", "16000000"],
    ["RCC.VCOInputFreq_Value", "16000000"],
    ["RCC.USART1Freq_Value", "16000000"],
  ]);
  const before = new Map(entries);
  for (const key of ["SYSCLKFreq_VALUE", "HCLKFreq_Value", "APB1Freq_Value"]) entries.set("RCC." + key, "170000000");
  const planned = new Set(["RCC.SYSCLKFreq_VALUE", "RCC.HCLKFreq_Value", "RCC.APB1Freq_Value"]);
  const result = followDerivedClocks(entries, before, planned);
  assert.equal(entries.get("RCC.MCO1PinFreq_Value"), "16000000");
  assert.equal(entries.get("RCC.VCOInputFreq_Value"), "16000000");
  assert.equal(entries.get("RCC.USART1Freq_Value"), "170000000");
  assert.deepEqual(result.written.map((item) => item.key), ["RCC.USART1Freq_Value"]);
  assert.deepEqual(result.skipped, []);
});

test("C0 @48 MHz：整棵树同步换挡时，没写过的派生键跟着走", () => {
  const entries = c0Before();
  const before = new Map(entries);
  // 规划器会把每个算得出的时钟域都写对，这里照它的行为铺满（含 ADCFreq_Value）。
  for (const key of ["SYSCLKFreq_VALUE", "AHBFreq_Value", "HCLKFreq_Value", "APBFreq_Value", "APBTimFreq_Value", "ADCFreq_Value"]) {
    entries.set("RCC." + key, "48000000");
  }
  const planned = new Set([
    "RCC.SYSCLKFreq_VALUE",
    "RCC.AHBFreq_Value",
    "RCC.HCLKFreq_Value",
    "RCC.APBFreq_Value",
    "RCC.APBTimFreq_Value",
    "RCC.ADCFreq_Value",
  ]);
  const result = followDerivedClocks(entries, before, planned);
  assert.equal(entries.get("RCC.USART1Freq_Value"), "48000000");
  assert.equal(entries.get("RCC.I2C1Freq_Value"), "48000000");
  // MCO 的源由 RCC.MCO1Source 选（C0 默认 HSI 48 MHz、G4 默认 HSI 16 MHz），和 SYSCLK 无关 → 不跟随，
  // 留给 CubeMX 重算（它只进 derivedRecomputed 桶，不参与 benign）。
  assert.equal(entries.get("RCC.MCO1PinFreq_Value"), "12000000");
  assert.equal(entries.get("RCC.PWRFreq_Value"), "48000000");
  // 走 LSI 的 WatchDogFreq_Value 不能被拽到 48 MHz。
  assert.equal(entries.get("RCC.WatchDogFreq_Value"), "32000");
  assert.ok(result.written.every((item) => item.to === 48_000_000));
  assert.deepEqual(result.skipped, []);
});

test("分叉时不动：SYSCLK 72 MHz 但 APB1 只有 36 MHz，旧值 16 MHz 对得上两个域", () => {
  const entries = new Map([
    ["RCC.SYSCLKFreq_VALUE", "16000000"],
    ["RCC.HCLKFreq_Value", "16000000"],
    ["RCC.APB1Freq_Value", "16000000"],
    ["RCC.USART2Freq_Value", "16000000"],
  ]);
  const before = new Map(entries);
  entries.set("RCC.SYSCLKFreq_VALUE", "72000000");
  entries.set("RCC.HCLKFreq_Value", "72000000");
  entries.set("RCC.APB1Freq_Value", "36000000");
  const result = followDerivedClocks(entries, before, new Set(["RCC.SYSCLKFreq_VALUE", "RCC.HCLKFreq_Value", "RCC.APB1Freq_Value"]));
  assert.equal(entries.get("RCC.USART2Freq_Value"), "16000000", "有歧义就不许改");
  assert.deepEqual(result.skipped.map((item) => item.key), ["RCC.USART2Freq_Value"]);
  assert.deepEqual(result.written, []);
});

test("计划已经写过的键不重复改（以规划器公式为准）", () => {
  const entries = new Map([
    ["RCC.SYSCLKFreq_VALUE", "8000000"],
    ["RCC.APB1Freq_Value", "8000000"],
    ["RCC.USART1Freq_Value", "8000000"],
  ]);
  const before = new Map(entries);
  entries.set("RCC.SYSCLKFreq_VALUE", "48000000");
  entries.set("RCC.APB1Freq_Value", "48000000");
  const result = followDerivedClocks(entries, before, new Set(["RCC.SYSCLKFreq_VALUE", "RCC.APB1Freq_Value", "RCC.USART1Freq_Value"]));
  assert.equal(entries.get("RCC.USART1Freq_Value"), "8000000");
  assert.deepEqual(result.written, []);
});

test("新值没写进条目（例如规划器只写设定键）时什么都不改", () => {
  const entries = c0Before();
  const before = new Map(entries);
  entries.set("RCC.APB1CLKDivider", "RCC_APB1_DIV1");
  const result = followDerivedClocks(entries, before, new Set(["RCC.APB1CLKDivider"]));
  assert.equal(entries.get("RCC.USART1Freq_Value"), "12000000");
  assert.deepEqual(result.written, []);
});
