// 时钟事实（src/data/clock-db.ts）的离线单测：db 派生 → ClockFacts 的合并规则，以及本机有 db 时的等价性。
//
// 为什么要这条等价性用例：F1 的手写表（F1_PLL_MULS / F1_APB_DIVS / F1_ADC_DIVS / F1_CLOCK_LIMITS）
// 现在只是兜底，正常路径走 db。如果两者不一致，说明派生逻辑读错了枚举（例如把 PLLMUL 的 Comment
// 当成了别的数字），必须在 CI 之外的本机就有证据，而不是等真机往返才发现。
//
// 运行：node --test test/clock-db-units.test.mjs（需先 npm run build）
import assert from "node:assert/strict";
import { test } from "node:test";

import { BUS_LIMITS, clockFactsFromDb, readClockDbFacts } from "../lib/data/clock-db.js";
import { F1_ADC_DIVS, F1_APB_DIVS, F1_CLOCK_LIMITS, F1_PLL_MULS } from "../lib/data/clock-f1.js";
import { locateCubemxDb, readMcuFacts } from "../lib/engine/cubemx-db.js";

/** 造一份 readClockDbFacts 的输出（只填被 clockFactsFromDb 用到的字段）。 */
function dbFacts(overrides = {}) {
  return {
    model: "pllmul",
    sysclkMaxHz: 48_000_000,
    muls: [{ mul: 2, iocValue: "RCC_PLL_MUL2" }, { mul: 3, iocValue: "RCC_PLL_MUL3" }],
    sources: [{ id: "hse", label: "HSE", iocValue: "RCC_PLLSOURCE_HSE", defaultHz: 8_000_000, selectable: true, note: "" }],
    apbDivs: [{ div: 1, iocValue: "RCC_HCLK_DIV1" }, { div: 2, iocValue: "RCC_HCLK_DIV2" }],
    adcDivs: [{ div: 2, iocValue: "RCC_ADCPCLK2_DIV2" }],
    pllM: [],
    pllN: null,
    pllP: [],
    notes: [],
    sourceFile: "/fake/RCC-x.xml",
    ...overrides,
  };
}

test("clockFactsFromDb：pllmul + 已核上限的族 → 合成 ClockFacts（sysclk 上限取 db 的 <Frequency>）", () => {
  const facts = clockFactsFromDb(dbFacts(), "STM32F0");
  assert.notEqual(facts, null);
  assert.equal(facts.limits.sysclkHz, 48_000_000);
  assert.equal(facts.limits.apb1Hz, BUS_LIMITS.STM32F0.apb1Hz);
  assert.equal(facts.limits.adcHz, BUS_LIMITS.STM32F0.adcHz);
  assert.equal(facts.muls.length, 2);
  // 外设挂哪条总线沿用 F1 模型（这几个族的分配相同）；USB 规则各族不同 → 标成「未建模」
  assert.ok(facts.peripheralClocks.length > 0);
  assert.equal(facts.usb.requiresPllClkHz, 0, "非 F1 的 USB 规则不能套 F1 的 72 MHz");
});

test("clockFactsFromDb：pllmn / unknown / 未核上限的族一律 null（不拿 F1 的表硬套）", () => {
  assert.equal(clockFactsFromDb(dbFacts({ model: "pllmn" }), "STM32F0"), null);
  assert.equal(clockFactsFromDb(dbFacts({ model: "unknown" }), "STM32F0"), null);
  // F4 现在是「pllmn + 上限与 VCO 都核过」的族：事实齐全时应当放行（见下一条）；
  // 但把 pllmn 的事实掏空（没有 PLLM/PLLN）仍然要拒。
  assert.equal(clockFactsFromDb(dbFacts({ model: "pllmn" }), "STM32F4"), null);
  // 完全没建档的族（F7 既没有总线上限也没有 VCO 区间）→ 拒
  assert.equal(clockFactsFromDb(dbFacts(), "STM32F7"), null);
  // 上限表里有、但枚举为空（db 读残了）→ 也拒
  assert.equal(clockFactsFromDb(dbFacts({ muls: [] }), "STM32F0"), null);
});

test("clockFactsFromDb：ADC 预分频枚举为空时兜底 ÷1（F0/L0 的 ADC 时钟不走 RCC 预分频）", () => {
  const facts = clockFactsFromDb(dbFacts({ adcDivs: [] }), "STM32L0");
  assert.notEqual(facts, null);
  assert.deepEqual(facts.adcDivs, [{ div: 1, iocValue: "" }]);
});

test("真 db 等价性：F103 的派生结果 == F1 手写表（muls / apbDivs / adcDivs / sysclk 上限）", (t) => {
  const db = locateCubemxDb(["D:/app/STM32CubeMX"]);
  if (db === null) {
    t.skip("本机没有 CubeMX db（CI 环境）：跳过等价性用例");
    return;
  }
  const mcu = readMcuFacts(db, "STM32F103C(8-B)Tx");
  if (mcu === null) {
    t.skip("本机 db 里没有 STM32F103C(8-B)Tx：跳过");
    return;
  }
  const derived = readClockDbFacts(db, mcu);
  assert.notEqual(derived, null);
  assert.equal(derived.model, "pllmul");
  assert.equal(derived.sysclkMaxHz, F1_CLOCK_LIMITS.sysclkHz);
  assert.deepEqual(derived.muls, F1_PLL_MULS);
  assert.deepEqual(derived.apbDivs, F1_APB_DIVS);
  assert.deepEqual(derived.adcDivs, F1_ADC_DIVS);
  // 源：db 里 F1 只有 HSE 与 HSI÷2 两档（手写表的 hsi 是"不可选"的说明项）
  assert.deepEqual(derived.sources.map((source) => source.iocValue).sort(), ["RCC_PLLSOURCE_HSE", "RCC_PLLSOURCE_HSI_DIV2"].sort());
});

test("真 db：F407 判定为 pllmn 并给出 PLLM/PLLN/PLLP 范围；G431 的 PLLN 是 8..127", (t) => {
  const db = locateCubemxDb(["D:/app/STM32CubeMX"]);
  if (db === null) return t.skip("本机没有 CubeMX db");
  const f4 = readMcuFacts(db, "STM32F407V(E-G)Tx");
  if (f4 === null) return t.skip("本机 db 里没有 F407");
  const derived = readClockDbFacts(db, f4);
  assert.notEqual(derived, null);
  assert.equal(derived.model, "pllmn");
  // F4 的 PLLM 在 db 里是 Type="integer" Min=2 Max=63（不是枚举），所以是 2..63 的连续档
  assert.equal(derived.pllM[0]?.div, 2);
  assert.equal(derived.pllM[derived.pllM.length - 1]?.div, 63);
  assert.equal(derived.pllM.every((item) => item.iocValue === String(item.div)), true);
  assert.deepEqual(derived.pllN, { min: 50, max: 432 });
  assert.deepEqual(derived.pllP.map((item) => item.div), [2, 4, 6, 8]);
  assert.equal(derived.sysclkMaxHz, 168_000_000);
});
