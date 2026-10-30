// 时钟规划单测：node test/clock-units.test.mjs（不要用 node --test：沙箱下 spawn EPERM）
// 注意：test/run-units.mjs 是硬编码清单，本文件按 t3 的约束没有加进去；要并入请由维护者把它加进清单。
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { emptyClockPlan, formatHz, planClock } from "../lib/engine/clock-plan.js";
import { planIocChanges } from "../lib/engine/ioc-plan.js";
import { parseIocEntries } from "../lib/engine/ioc.js";

import { FIXTURE_PROJECT, e2eWorkDir } from "./fixtures.mjs";

const DEMO_IOC = join(FIXTURE_PROJECT, "demo.ioc");
const TMP = e2eWorkDir("clock-test");

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function demoEntries() {
  return parseIocEntries(readFileSync(DEMO_IOC, "utf8"));
}

function freshProject() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  copyFileSync(DEMO_IOC, join(TMP, "demo.ioc"));
  return join(TMP, "demo.ioc");
}

function entryValue(plan, key) {
  const found = plan.entries.find((entry) => entry.key === key);
  return found === undefined ? undefined : found.value;
}

test("就近：60 MHz 不可达 → 64 MHz，note 明写「不可达，已选 64」", () => {
  const plan = planClock({ targetHz: 60_000_000 }, { entries: demoEntries() });
  assert.equal(plan.ok, true, plan.errors.join("；"));
  assert.equal(plan.mode, "nearest");
  assert.equal(plan.reachable, false);
  assert.equal(plan.achieved.sysclkHz, 64_000_000);
  assert.equal(plan.achieved.pllMul, 8);
  assert.equal(plan.achieved.pllSource, "hse");
  assert.equal(plan.deltaHz, 4_000_000);
  assert.match(plan.note, /不可达，已选 64 MHz/u);
  assert.match(plan.note, /HSI÷2/u, "要提示 HSI÷2×15 能正好凑出 60 MHz（但精度差）");
  assert.equal(plan.alternatives[0]?.sysclkHz, 56_000_000, "另一侧 56 MHz 排第一");
  assert.equal(entryValue(plan, "RCC.PLLMUL"), "RCC_PLL_MUL8");
});

test("72 MHz 精确命中：APB1 自动 ÷2、ADC 自动 ÷6", () => {
  const plan = planClock({ targetHz: 72_000_000 }, { entries: demoEntries() });
  assert.equal(plan.reachable, true);
  assert.equal(plan.achieved.sysclkHz, 72_000_000);
  assert.equal(plan.achieved.pllMul, 9);
  assert.equal(plan.achieved.apb1Div, 2);
  assert.equal(plan.achieved.apb1Hz, 36_000_000);
  assert.equal(plan.achieved.apb1TimHz, 72_000_000);
  assert.equal(plan.achieved.apb2Hz, 72_000_000);
  assert.equal(plan.achieved.adcDiv, 6);
  assert.equal(plan.achieved.adcHz, 12_000_000);
  assert.match(plan.note, /可达/u);
  assert.equal(plan.alternatives.length, 0, "命中了就不给备选");
});

test("72 MHz + 要 USB：÷1.5 拿 48 MHz，写 RCC.USBPrescaler", () => {
  const plan = planClock({ targetHz: 72_000_000, usb: true }, { entries: demoEntries() });
  assert.equal(plan.ok, true, plan.errors.join("；"));
  assert.equal(plan.achieved.usbAvailable, true);
  assert.equal(plan.achieved.usbPrescaled, true);
  assert.equal(plan.achieved.usbHz, 48_000_000);
  assert.equal(entryValue(plan, "RCC.USBPrescaler"), "RCC_USBCLKSOURCE_PLL_DIV1_5");
  assert.equal(entryValue(plan, "RCC.USBFreq_Value"), "48000000");
  assert.equal(plan.unset.includes("RCC.USBPrescaler"), false);
  assert.equal(plan.warnings.some((item) => item.includes("USB 不可用")), false);
});

test("64 MHz + 要 USB：拿不到 48 MHz，警告并把 USBFreq_Value 记成 PLLCLK", () => {
  const plan = planClock({ targetHz: 64_000_000, usb: true }, { entries: demoEntries() });
  assert.equal(plan.ok, true, plan.errors.join("；"));
  assert.equal(plan.achieved.usbAvailable, false);
  assert.equal(plan.achieved.usbPrescaled, false);
  assert.equal(plan.achieved.usbHz, 64_000_000);
  assert.equal(entryValue(plan, "RCC.USBFreq_Value"), "64000000");
  assert.equal(entryValue(plan, "RCC.USBPrescaler"), undefined);
  assert.ok(plan.warnings.some((item) => item.includes("USB 不可用")), "必须有 USB 不可用警告");
});

test("ADC 上限：64 MHz 自动 ÷6；显式 adcDiv 2 时给错误而不是硬写", () => {
  const auto = planClock({ targetHz: 64_000_000 }, { entries: demoEntries() });
  assert.equal(auto.achieved.adcDiv, 6);
  assert.equal(auto.achieved.adcHz, Math.round(64_000_000 / 6));
  assert.match(auto.note, /ADC 时钟 10.667 MHz 不是整数/u);

  const bad = planClock({ pllMul: 9, adcDiv: 2 }, { entries: demoEntries() });
  assert.equal(bad.ok, false);
  assert.equal(bad.entries.length, 0, "有错时一个键都不许写");
  assert.ok(bad.errors.some((item) => item.includes("ADC") && item.includes("14 MHz")), bad.errors.join("；"));
});

test("APB1 上限：72 MHz 显式 ÷1 被拒，报错点名 APB1 36 MHz", () => {
  const bad = planClock({ pllMul: 9, apb1Div: 1 }, { entries: demoEntries() });
  assert.equal(bad.ok, false);
  assert.equal(bad.entries.length, 0);
  assert.ok(bad.errors.some((item) => item.includes("APB1") && item.includes("36 MHz")), bad.errors.join("；"));
  assert.match(bad.errors.join("；"), /APB1CLKDivider 至少要 ÷2/u);
});

test("SYSCLK 上限：HSE ×16 = 128 MHz 被拒；就近模式对 100 MHz 也给最接近的 72", () => {
  const bad = planClock({ pllMul: 16 }, { entries: demoEntries() });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((item) => item.includes("SYSCLK") && item.includes("72 MHz")), bad.errors.join("；"));

  const nearest = planClock({ targetHz: 100_000_000 }, { entries: demoEntries() });
  assert.equal(nearest.achieved.sysclkHz, 72_000_000);
  assert.equal(nearest.reachable, false);
  assert.match(nearest.note, /上限是 72 MHz/u);
});

test("未知目标 50 MHz：给最近档 48 与备选清单", () => {
  const plan = planClock({ targetHz: 50_000_000 }, { entries: demoEntries() });
  assert.equal(plan.reachable, false);
  assert.equal(plan.achieved.sysclkHz, 48_000_000);
  assert.equal(plan.deltaHz, -2_000_000);
  assert.ok(plan.alternatives.length >= 3, "要给备选");
  assert.equal(plan.alternatives[0]?.sysclkHz, 56_000_000);
  assert.equal(plan.alternatives[0]?.deltaHz, 6_000_000);
});

test("板上没 HSE 晶振 → 用 HSI÷2 4 MHz，60 MHz 正好可达（×15）", () => {
  const entries = demoEntries();
  for (const [key, value] of [...entries]) {
    if (key.endsWith(".Signal") && (value === "RCC_OSC_IN" || value === "RCC_OSC_OUT")) entries.delete(key);
  }
  const plan = planClock({ targetHz: 60_000_000 }, { entries });
  assert.equal(plan.achieved.pllSource, "hsi-div2");
  assert.equal(plan.reachable, true);
  assert.equal(plan.achieved.pllMul, 15);
  assert.equal(plan.achieved.sysclkHz, 60_000_000);
  assert.equal(entryValue(plan, "RCC.PLLSourceVirtual"), "RCC_PLLSOURCE_HSI_DIV2");
  assert.ok(plan.warnings.some((item) => item.includes("HSI÷2") && item.includes("±1%")), plan.warnings.join("；"));
});

test("逐外设频率表：USART1/SPI1/TIM1 走 APB2，USART2/TIM2/I2C 走 APB1，TIM ×2 规则生效", () => {
  const plan = planClock({ targetHz: 64_000_000 }, { entries: demoEntries() });
  const byId = new Map(plan.peripherals.map((item) => [item.id, item]));
  assert.equal(byId.get("USART1")?.bus, "apb2");
  assert.equal(byId.get("USART1")?.clockHz, 64_000_000);
  assert.equal(byId.get("USART2")?.bus, "apb1");
  assert.equal(byId.get("USART2")?.clockHz, 32_000_000);
  assert.equal(byId.get("SPI1")?.bus, "apb2");
  assert.equal(byId.get("SPI2")?.bus, "apb1");
  assert.equal(byId.get("I2C1")?.bus, "apb1");
  assert.equal(byId.get("TIM1")?.bus, "apb2");
  assert.equal(byId.get("TIM1")?.clockHz, 64_000_000, "APB2 ÷1 → 定时器不翻倍");
  assert.equal(byId.get("TIM2")?.clockHz, 64_000_000, "APB1 ÷2 → 定时器时钟 ×2");
  assert.equal(byId.get("ADC1")?.clockHz, plan.achieved.adcHz);
  assert.ok(byId.get("TIM2")?.note.includes("定时器时钟 ×2"));
  assert.ok(byId.get("USART1")?.note.includes("未在 .ioc 启用"), "demo.ioc 没开 USART1，要如实标注");
});

test("UART 波特率整除误差：16 倍过采样，全部档位误差 < 1%", () => {
  const plan = planClock({ targetHz: 72_000_000 }, { entries: demoEntries() });
  assert.equal(plan.bauds.length, 3, "USART1/2/3 各一张表");
  const usart1 = plan.bauds.find((table) => table.id === "USART1");
  const usart2 = plan.bauds.find((table) => table.id === "USART2");
  assert.equal(usart1?.clockHz, 72_000_000);
  assert.equal(usart2?.clockHz, 36_000_000);
  const row115200 = usart1?.rows.find((row) => row.baud === 115200);
  assert.equal(row115200?.brr, 625);
  assert.equal(row115200?.errorPercent, 0, "72 MHz / 115200 = 625 整除，误差 0");
  for (const table of plan.bauds) {
    for (const row of table.rows) {
      assert.ok(Math.abs(row.errorPercent) < 1, table.id + "@" + String(row.baud) + " 误差 " + String(row.errorPercent) + "%");
    }
  }
});

test("写盘时 20 个 RCC 派生键全部重算（含 RCC.IPParameters 合并），.ioc 本体不动", () => {
  const iocPath = freshProject();
  const before = readFileSync(iocPath, "utf8");
  const plan = planIocChanges({ projectDir: TMP, clock: { targetHz: 64_000_000 } });
  assert.equal(plan.ok, true, plan.message);
  assert.equal(readFileSync(iocPath, "utf8"), before, "plan 阶段一个字节都不许改 .ioc");
  assert.equal(plan.clockPlan.mode, "nearest");
  assert.equal(plan.clockPlan.achieved.sysclkHz, 64_000_000);

  const changed = new Map(plan.changes.map((change) => [change.key, change.after]));
  // 只断言"真的变了"的键（demo.ioc 里 SYSCLKSource/PLLSourceVirtual/APB1CLKDivider 本来就是这个值，不该出现在 diff 里）
  const expected = {
    "RCC.PLLMUL": "RCC_PLL_MUL8",
    "RCC.SYSCLKFreq_VALUE": "64000000",
    "RCC.HCLKFreq_Value": "64000000",
    "RCC.AHBFreq_Value": "64000000",
    "RCC.FCLKCortexFreq_Value": "64000000",
    "RCC.APB1Freq_Value": "32000000",
    "RCC.APB1TimFreq_Value": "64000000",
    "RCC.APB2Freq_Value": "64000000",
    "RCC.APB2TimFreq_Value": "64000000",
    "RCC.ADCPresc": "RCC_ADCPCLK2_DIV6",
    "RCC.ADCFreqValue": String(Math.round(64_000_000 / 6)),
    "RCC.PLLCLKFreq_Value": "64000000",
    "RCC.PLLMCOFreq_Value": "32000000",
    "RCC.MCOFreq_Value": "64000000",
    "RCC.TimSysFreq_Value": "64000000",
    "RCC.USBFreq_Value": "64000000",
  };
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(changed.get(key), value, key + " 没重算对");
  }
  const ipParameters = changed.get("RCC.IPParameters");
  assert.ok(typeof ipParameters === "string", "RCC.IPParameters 必须一起重算");
  for (const name of ["SYSCLKFreq_VALUE", "HCLKFreq_Value", "APB1Freq_Value", "APB1TimFreq_Value", "APB2TimFreq_Value", "ADCFreqValue", "ADCPresc", "PLLCLKFreq_Value", "PLLMCOFreq_Value", "VCOOutput2Freq_Value", "MCOFreq_Value", "TimSysFreq_Value", "USBFreq_Value", "FCLKCortexFreq_Value", "AHBFreq_Value"]) {
    assert.ok(ipParameters.includes(name), "RCC.IPParameters 漏了 " + name);
  }
  assert.equal(changed.has("RCC.FamilyName"), false, "FamilyName 不该被改");
  assert.equal(changed.has("RCC.SYSCLKSource"), false, "SYSCLKSource 本来就是 PLLCLK，不用改");
  assert.equal(String(plan.summaryAfter?.clocks.sysclkHz), "64000000", "候选文件回读的 SYSCLK 要跟着变");

  // 候选文件回读：20 个派生键逐个核对（不能只改 PLLMUL 就交差）
  const candidate = parseIocEntries(readFileSync(join(TMP, ".dsh-stm32", "plans", plan.planId + ".ioc"), "utf8"));
  const want = {
    "RCC.SYSCLKSource": "RCC_SYSCLKSOURCE_PLLCLK",
    "RCC.PLLSourceVirtual": "RCC_PLLSOURCE_HSE",
    "RCC.PLLMUL": "RCC_PLL_MUL8",
    "RCC.SYSCLKFreq_VALUE": "64000000",
    "RCC.HCLKFreq_Value": "64000000",
    "RCC.AHBFreq_Value": "64000000",
    "RCC.FCLKCortexFreq_Value": "64000000",
    "RCC.APB1CLKDivider": "RCC_HCLK_DIV2",
    "RCC.APB1Freq_Value": "32000000",
    "RCC.APB1TimFreq_Value": "64000000",
    "RCC.APB2Freq_Value": "64000000",
    "RCC.APB2TimFreq_Value": "64000000",
    "RCC.ADCPresc": "RCC_ADCPCLK2_DIV6",
    "RCC.ADCFreqValue": String(Math.round(64_000_000 / 6)),
    "RCC.PLLCLKFreq_Value": "64000000",
    "RCC.PLLMCOFreq_Value": "32000000",
    "RCC.VCOOutput2Freq_Value": "8000000",
    "RCC.MCOFreq_Value": "64000000",
    "RCC.TimSysFreq_Value": "64000000",
    "RCC.USBFreq_Value": "64000000",
    "RCC.FamilyName": "M",
  };
  for (const [key, value] of Object.entries(want)) {
    assert.equal(candidate.get(key), value, "候选文件里 " + key + " 不对");
  }
  assert.equal(candidate.size, parseIocEntries(before).size + 1, "只该多出一个 RCC.ADCPresc，别乱加键");
});

test("只读快照：不传 clock 时 clockPlan 是 .ioc 现状（mode=snapshot、一个键都不改）", () => {
  const iocPath = freshProject();
  const plan = planIocChanges({ projectDir: TMP });
  assert.equal(plan.ok, false, "没改动时 plan 本来就该说没事可做");
  assert.equal(plan.clockPlan.mode, "snapshot");
  assert.equal(plan.clockPlan.achieved.sysclkHz, 72_000_000);
  assert.equal(plan.clockPlan.achieved.apb1Div, 2);
  assert.equal(plan.clockPlan.entries.length, 0);
  assert.deepEqual(plan.changes, []);
  assert.equal(readFileSync(iocPath, "utf8").includes("RCC.PLLMUL=RCC_PLL_MUL9"), true);
});

test("formatHz 与 emptyClockPlan 的形状（宿主不接受 null）", () => {
  assert.equal(formatHz(72_000_000), "72 MHz");
  assert.equal(formatHz(10_666_667), "10.667 MHz");
  assert.equal(formatHz(250_000), "250 kHz");
  const blank = emptyClockPlan("还没算");
  assert.equal(blank.mode, "none");
  assert.equal(blank.ok, false);
  assert.deepEqual(blank.entries, []);
  assert.equal(typeof blank.achieved.sysclkHz, "number");
  assert.equal(blank.requested.targetHz, 0);
});

let failed = 0;
for (const item of cases) {
  try {
    item.fn();
    console.log("ok   " + item.name);
  } catch (error) {
    failed += 1;
    console.log("FAIL " + item.name);
    console.log(String(error && error.message ? error.message : error));
  }
}
rmSync(TMP, { recursive: true, force: true });
console.log("---");
console.log("tests " + cases.length + " / fail " + failed);
process.exit(failed === 0 ? 0 : 1);
