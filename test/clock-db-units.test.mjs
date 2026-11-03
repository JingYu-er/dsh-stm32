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
    sysclkMaxDbHz: 48_000_000,
    busLimits: { apb1Hz: 24_000_000, apb2Hz: 48_000_000, adcHz: 12_000_000 },
    vco: null,
    muls: [{ mul: 2, iocValue: "RCC_PLL_MUL2" }, { mul: 3, iocValue: "RCC_PLL_MUL3" }],
    sources: [{ id: "hse", label: "HSE", iocValue: "RCC_PLLSOURCE_HSE", defaultHz: 8_000_000, selectable: true, note: "" }],
    apbDivs: [{ div: 1, iocValue: "RCC_HCLK_DIV1" }, { div: 2, iocValue: "RCC_HCLK_DIV2" }],
    ahbDivs: [{ div: 1, iocValue: "RCC_SYSCLK_DIV1" }, { div: 2, iocValue: "RCC_SYSCLK_DIV2" }],
    // direct 模型（C0）才用到的四项：pllmul/pllmn 合成时不该被读到
    directSources: [],
    srcDivs: [],
    srcDivKey: "",
    srcDivSources: [],
    apb2Divs: [],
    derivedNames: [],
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
  // db 也没读到总线上限的族（busLimits = null）且没有 override 表 → 拒
  assert.equal(clockFactsFromDb(dbFacts({ busLimits: null }), "STM32G0"), null);
  // 上限表里有、但枚举为空（db 读残了）→ 也拒
  assert.equal(clockFactsFromDb(dbFacts({ muls: [] }), "STM32F0"), null);
});

test("clockFactsFromDb：没有 override 表的族用 db 的总线上限（G0/U0 这类单 APB 族），SYSCLK 回退 SYSCLKFreq_VALUE", () => {
  // G0 不在 override 表里：上限与 VCO 都来自 db，pllmn 模型应当直接放行
  const facts = clockFactsFromDb(
    dbFacts({
      model: "pllmn",
      sysclkMaxHz: 0,
      sysclkMaxDbHz: 64_000_000,
      busLimits: { apb1Hz: 64_000_000, apb2Hz: 64_000_000, adcHz: 35_000_000 },
      vco: { minHz: 96_000_000, maxHz: 344_000_000, inMinHz: 2_660_000, inMaxHz: 16_000_000 },
      pllM: [{ div: 2, iocValue: "RCC_PLLM_DIV2" }],
      pllN: { min: 8, max: 86 },
      pllP: [{ div: 2, iocValue: "RCC_PLLP_DIV2" }],
    }),
    "STM32G0",
  );
  assert.notEqual(facts, null);
  assert.equal(facts.limits.sysclkHz, 64_000_000, "MCU xml 没写 <Frequency> 时用 db 的 SYSCLKFreq_VALUE Max");
  assert.equal(facts.limits.apb1Hz, 64_000_000);
  assert.equal(facts.limits.adcHz, 35_000_000);
  assert.deepEqual(facts.vco, { minHz: 96_000_000, maxHz: 344_000_000, inMinHz: 2_660_000, inMaxHz: 16_000_000 });
  // 核过的族仍然以 override 表为准（F4 的 APB1 是手册的 42 MHz，不是 db 变体里的最大值）
  const f4 = clockFactsFromDb(
    dbFacts({
      model: "pllmn",
      busLimits: { apb1Hz: 42_000_000, apb2Hz: 84_000_000, adcHz: 36_000_000 },
      vco: { minHz: 50_000_000, maxHz: 500_000_000 },
      pllM: [{ div: 2, iocValue: "RCC_PLLM_DIV2" }],
      pllN: { min: 50, max: 432 },
      pllP: [{ div: 2, iocValue: "RCC_PLLP_DIV2" }],
    }),
    "STM32F4",
  );
  assert.notEqual(f4, null);
  assert.equal(f4.limits.apb1Hz, BUS_LIMITS.STM32F4.apb1Hz);
  assert.deepEqual(f4.vco, { minHz: 100_000_000, maxHz: 432_000_000, inMinHz: 1_000_000, inMaxHz: 2_000_000 });
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

// AHB 分频的枚举名与 APB 不是同一套：写错不会报错，CubeMX 载入时直接死循环
// （F2 实测 >240 s 停在 setPackage），所以 AHB 也必须按 db 读。
test("真 db：AHB 分频枚举与 APB 不是同一套名字（F2 是 RCC_SYSCLK_DIVn，APB 是 RCC_HCLK_DIVn）", (t) => {
  const db = locateCubemxDb(["D:/app/STM32CubeMX"]);
  if (db === null) return t.skip("本机没有 CubeMX db");
  const mcu = readMcuFacts(db, "STM32F205R(B-C-E-F-G)Tx");
  if (mcu === null) return t.skip("本机 db 里没有 F205");
  const derived = readClockDbFacts(db, mcu);
  assert.notEqual(derived, null);
  assert.ok(derived.ahbDivs.length >= 4, "AHB 枚举应当读出来：" + JSON.stringify(derived.ahbDivs));
  assert.deepEqual(derived.ahbDivs.slice(0, 4).map((item) => item.iocValue), [
    "RCC_SYSCLK_DIV1",
    "RCC_SYSCLK_DIV2",
    "RCC_SYSCLK_DIV4",
    "RCC_SYSCLK_DIV8",
  ]);
  assert.equal(derived.ahbDivs[0].div, 1);
  assert.equal(derived.apbDivs[0].iocValue, "RCC_HCLK_DIV1");
  const facts = clockFactsFromDb(derived, "STM32F2");
  assert.notEqual(facts, null);
  assert.equal(facts.ahbDivs?.[0]?.iocValue, "RCC_SYSCLK_DIV1", "ClockFacts 要带上 db 的 AHB 枚举");
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

// 五族（F2/F3/G0/L1/U0）的时钟上限不再手抄：全部来自 db 的 RCC Modes（Max/Min）与 MCU xml。
// 这条用例是本机证据：db 换版本时数值变了要立刻看到，而不是等 ioc_verify 报差异。
test("真 db：F2/F3/G0/L1/U0 的总线上限与 VCO 区间从 db 读出来，clockFactsFromDb 放行", (t) => {
  const db = locateCubemxDb(["D:/app/STM32CubeMX"]);
  if (db === null) return t.skip("本机没有 CubeMX db");
  const cases = [
    { family: "STM32F2", mcu: "STM32F205R(B-C-E-F-G)Tx", model: "pllmn", sysclk: 120_000_000, apb1: 30_000_000, apb2: 60_000_000, vco: [192_000_000, 432_000_000, 1_000_000, 2_000_000] },
    { family: "STM32F3", mcu: "STM32F303C(B-C)Tx", model: "pllmul", sysclk: 72_000_000, apb1: 36_000_000, apb2: 72_000_000, vco: null },
    { family: "STM32G0", mcu: "STM32G030C(6-8)Tx", model: "pllmn", sysclk: 64_000_000, apb1: 64_000_000, apb2: 64_000_000, vco: [96_000_000, 344_000_000, 2_660_000, 16_000_000] },
    { family: "STM32L1", mcu: "STM32L100C6Ux", model: "pllmul", sysclk: 32_000_000, apb1: 32_000_000, apb2: 32_000_000, vco: null },
    // U0 的 MCU xml 没有 <Frequency>：SYSCLK 上限必须回退到 db 的 SYSCLKFreq_VALUE（56 MHz）
    { family: "STM32U0", mcu: "STM32U031C6Tx", model: "pllmn", sysclk: 56_000_000, apb1: 64_000_000, apb2: 64_000_000, vco: [96_000_000, 344_000_000, 2_660_000, 16_000_000] },
  ];
  for (const item of cases) {
    const mcu = readMcuFacts(db, item.mcu);
    if (mcu === null) {
      t.skip("本机 db 里没有 " + item.mcu);
      continue;
    }
    const derived = readClockDbFacts(db, mcu);
    assert.notEqual(derived, null, item.family + "：读不到 RCC Modes");
    assert.equal(derived.model, item.model, item.family + " 的 PLL 模型");
    const plan = clockFactsFromDb(derived, item.family);
    assert.notEqual(plan, null, item.family + "：clockFactsFromDb 应当放行");
    assert.equal(plan.limits.sysclkHz, item.sysclk, item.family + " 的 SYSCLK 上限");
    assert.equal(plan.limits.apb1Hz, item.apb1, item.family + " 的 APB1 上限");
    assert.equal(plan.limits.apb2Hz, item.apb2, item.family + " 的 APB2 上限");
    if (item.vco === null) {
      assert.equal(plan.vco, undefined, item.family + " 是 pllmul 模型，不该有 VCO 区间");
    } else {
      assert.deepEqual(
        plan.vco,
        { minHz: item.vco[0], maxHz: item.vco[1], inMinHz: item.vco[2], inMaxHz: item.vco[3] },
        item.family + " 的 VCO 区间",
      );
    }
  }
});
