// CubeMX 内部 .ioc 阅读规则的离线检查单测：node test/ioc-rules-units.test.mjs
import assert from "node:assert/strict";

import { checkIocRules } from "../lib/engine/ioc-rules.js";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }
function entries(pairs) { return new Map(pairs); }

test("R7：IPParameters 没列出的参数要告警（实测 TIM2 的 Prescaler/Period 就这么被丢）", () => {
  const report = checkIocRules(entries([
    ["Mcu.Family", "STM32F1"],
    ["TIM2.IPParameters", "Channel-PWM Generation1 CH1"],
    ["TIM2.Channel-PWM Generation1 CH1", "TIM_CHANNEL_1"],
    ["TIM2.Prescaler", "71"],
    ["TIM2.Period", "999"],
  ]));
  const text = report.warnings.map((item) => item.rule + " " + item.message).join(" | ");
  assert.match(text, /R7/u);
  assert.match(text, /Prescaler/u);
  assert.match(text, /Period/u);
});

test("R7：白名单齐了就不告警", () => {
  const report = checkIocRules(entries([
    ["Mcu.Family", "STM32F1"],
    ["TIM2.IPParameters", "Prescaler,Period"],
    ["TIM2.Prescaler", "71"],
    ["TIM2.Period", "999"],
  ]));
  assert.equal(report.warnings.some((item) => item.rule === "R7"), false);
});

test("R1：有 Dma.* 但 Mcu.IPn 没有 DMA → 报错（实测整组被丢）", () => {
  const report = checkIocRules(entries([
    ["Mcu.IP0", "ADC1"],
    ["Mcu.IP1", "NVIC"],
    ["Dma.RequestsNb", "1"],
    ["Dma.ADC1.0.Instance", "DMA1_Channel1"],
  ]));
  assert.equal(report.errors.some((item) => item.rule === "R1"), true);
});

test("R1：Mcu.IPn 里有 DMA 就不报错", () => {
  const report = checkIocRules(entries([
    ["Mcu.IP0", "ADC1"],
    ["Mcu.IP1", "DMA"],
    ["Dma.RequestsNb", "1"],
    ["Dma.ADC1.0.Instance", "DMA1_Channel1"],
  ]));
  assert.equal(report.errors.some((item) => item.rule === "R1"), false);
});

test("R2：NbrOfConversion 与 Rank 组数不一致 → 告警", () => {
  const report = checkIocRules(entries([
    ["Mcu.Family", "STM32F1"],
    ["ADC1.Rank-0#ChannelRegularConversion", "1"],
    ["ADC1.Channel-0#ChannelRegularConversion", "ADC_CHANNEL_1"],
    ["ADC1.Rank-1#ChannelRegularConversion", "2"],
    ["ADC1.Channel-1#ChannelRegularConversion", "ADC_CHANNEL_4"],
    ["ADC1.NbrOfConversion", "4"],
  ]));
  assert.equal(report.warnings.some((item) => item.rule === "R2" && item.message.includes("NbrOfConversion=4")), true);
});

test("R2：Rank 值不连续（1 和 3）→ 告警", () => {
  const report = checkIocRules(entries([
    ["ADC1.Rank-0#ChannelRegularConversion", "1"],
    ["ADC1.Channel-0#ChannelRegularConversion", "ADC_CHANNEL_1"],
    ["ADC1.Rank-1#ChannelRegularConversion", "3"],
    ["ADC1.Channel-1#ChannelRegularConversion", "ADC_CHANNEL_5"],
  ]));
  assert.equal(report.warnings.some((item) => item.rule === "R2" && item.message.includes("不连续")), true);
});

test("R3：NVIC 值段数不足 → 告警，9 段则通过", () => {
  const bad = checkIocRules(entries([["NVIC.TIM2_IRQn", "true:1"]]));
  assert.equal(bad.warnings.some((item) => item.rule === "R3"), true);
  const good = checkIocRules(entries([["NVIC.TIM2_IRQn", "true:1:0:false:false:true:false:false:false"]]));
  assert.equal(good.warnings.some((item) => item.rule === "R3"), false);
});

test("R5：F1 的 ADCPresc 不是除 6 或缺省 → 告警", () => {
  const missing = checkIocRules(entries([["Mcu.Family", "STM32F1"]]));
  assert.equal(missing.warnings.some((item) => item.rule === "R5"), true);
  const wrong = checkIocRules(entries([["Mcu.Family", "STM32F1"], ["RCC.ADCPresc", "RCC_ADCPCLK2_DIV2"]]));
  assert.equal(wrong.warnings.some((item) => item.rule === "R5"), true);
  const good = checkIocRules(entries([["Mcu.Family", "STM32F1"], ["RCC.ADCPresc", "RCC_ADCPCLK2_DIV6"]]));
  assert.equal(good.warnings.some((item) => item.rule === "R5"), false);
});


test("R4：引脚有配置键但没列进 Mcu.PinN → 报错", () => {
  const report = checkIocRules(entries([
    ["Mcu.Pin0", "PC13-TAMPER-RTC"],
    ["Mcu.PinsNb", "1"],
    ["PA5.Signal", "GPIO_Output"],
  ]));
  assert.equal(report.warnings.some((item) => item.rule === "R4" && item.message.includes("PA5")), true);
});

test("R4：列进 Mcu.PinN 之后就不报错", () => {
  const report = checkIocRules(entries([
    ["Mcu.Pin0", "PC13-TAMPER-RTC"],
    ["Mcu.Pin1", "PA5"],
    ["Mcu.PinsNb", "2"],
    ["PA5.Signal", "GPIO_Output"],
  ]));
  assert.equal(report.warnings.some((item) => item.rule === "R4"), false);
});

test("R6：SH 的 ConfNb 与条数不符、值不是 <信号>,<模式> → 告警", () => {
  const report = checkIocRules(entries([
    ["SH.S_TIM3_CH1.0", "TIM3_CH1,PWM Generation1 CH1"],
    ["SH.S_TIM3_CH1.ConfNb", "2"],
  ]));
  assert.equal(report.warnings.some((item) => item.rule === "R6" && item.message.includes("ConfNb=2")), true);
  const bad = checkIocRules(entries([["SH.S_TIM3_CH1.0", "TIM3_CH1"], ["SH.S_TIM3_CH1.ConfNb", "1"]]));
  assert.equal(bad.warnings.some((item) => item.rule === "R6" && item.message.includes("既不是")), true);
});

test("R6：EXTI 的 GPIO_EXTIn 形态不告警", () => {
  const report = checkIocRules(entries([["SH.GPXTI8.0", "GPIO_EXTI8"], ["SH.GPXTI8.ConfNb", "1"]]));
  assert.equal(report.warnings.some((item) => item.rule === "R6"), false);
});

test("R8：IPNb / PinsNb 与实际条数不符 → 告警", () => {
  const report = checkIocRules(entries([
    ["Mcu.IP0", "NVIC"],
    ["Mcu.IP1", "RCC"],
    ["Mcu.IPNb", "4"],
    ["Mcu.Pin0", "PA0-WKUP"],
    ["Mcu.PinsNb", "3"],
  ]));
  assert.equal(report.warnings.some((item) => item.rule === "R8" && item.message.includes("IPNb=4")), true);
  assert.equal(report.warnings.some((item) => item.rule === "R8" && item.message.includes("PinsNb=3")), true);
});

test("R15：外设参数键的实例不在 Mcu.IPn 里 → 告警（CubeMX 建实例只认 Mcu.IPn）", () => {
  const report = checkIocRules(entries([
    ["Mcu.Family", "STM32F1"],
    ["Mcu.IP0", "USART1"],
    ["Mcu.IPNb", "1"],
    ["USART1.IPParameters", "BaudRate"],
    ["USART1.BaudRate", "115200"],
    ["USART2.IPParameters", "BaudRate"],
    ["USART2.BaudRate", "9600"],
    ["TIM3.Prescaler", "71"],
  ]));
  const text = report.warnings.filter((item) => item.rule === "R15").map((item) => item.message).join(" | ");
  assert.match(text, /USART2/u, "USART2 不在 Mcu.IPn，应告警");
  assert.match(text, /TIM3/u, "TIM3 不在 Mcu.IPn，应告警");
  assert.equal(text.includes("USART1"), false, "USART1 在 Mcu.IPn 里，不该告警");
});

test("R15：Mcu.IPn 齐了就不告警（RCC/NVIC/SH/Dma 这些不是实例名，别误报）", () => {
  const report = checkIocRules(entries([
    ["Mcu.Family", "STM32F1"],
    ["Mcu.IP0", "USART2"],
    ["Mcu.IP1", "RCC"],
    ["Mcu.IP2", "NVIC"],
    ["Mcu.IPNb", "3"],
    ["USART2.IPParameters", "BaudRate"],
    ["USART2.BaudRate", "115200"],
    ["RCC.ADCPresc", "RCC_ADCPCLK2_DIV6"],
    ["NVIC.USART1_IRQn", "true:0:0:false:false:true:false:false:false"],
    ["SH.ADCx_IN1.ConfNb", "1"],
  ]));
  assert.equal(report.warnings.some((item) => item.rule === "R15"), false, report.warnings.map((w) => w.rule + ":" + w.message).join(" | "));
});

test("R12：只有 .Mode 没有 .Signal → 告警", () => {
  const report = checkIocRules(entries([["PA6.Mode", "PWM Generation1 CH1"]]));
  assert.equal(report.warnings.some((item) => item.rule === "R12"), true);
});

// ---------------------------------------------------------------- db 类规则（R13/R14/R17）

/** 造一份最小的 db 事实：只填 R13/R14/R17 用得到的字段。 */
function facts(pinSpecs, ipSpecs = []) {
  const pins = new Map();
  for (const [name, signalSpecs] of Object.entries(pinSpecs)) {
    const signals = new Map();
    for (const [signal, ioModes] of Object.entries(signalSpecs)) signals.set(signal, ioModes ?? []);
    pins.set(name, { name, position: 0, signals });
  }
  const ips = new Map();
  for (const spec of ipSpecs) ips.set(spec.instanceName, spec);
  return { name: "STM32F103C(8-B)Tx", packageName: "LQFP48", frequencyMhz: 72, pins, ips };
}

const GPIO_MODES = ["Input", "Output", "Analog", "EVENTOUT", "EXTI"];

test("R13：GPIO_ / GPXTI / ADCx_INn / S_ 共享信号都是 CubeMX 的合法写法，不能报", () => {
  const dbFacts = facts({
    "PA0-WKUP": { GPIO: GPIO_MODES, TIM2_CH1: [], TIM2_ETR: [], ADC1_IN0: [] },
    "PA1": { GPIO: GPIO_MODES, ADC1_IN1: [], ADC2_IN1: [] },
    "PA8": { GPIO: GPIO_MODES, TIM1_CH1: [] },
    "PC13-TAMPER-RTC": { GPIO: GPIO_MODES },
    "PA13": { GPIO: GPIO_MODES, "SYS_JTMS-SWDIO": [] },
  });
  const report = checkIocRules(entries([
    ["PA0-WKUP.Signal", "S_TIM2_CH1_ETR"],
    ["PA1.Signal", "ADCx_IN1"],
    ["PA8.Signal", "GPXTI8"],
    ["PC13-TAMPER-RTC.Signal", "GPIO_Output"],
    ["PA13.Signal", "SYS_JTMS-SWDIO"],
  ]), { facts: dbFacts });
  assert.equal(report.warnings.filter((item) => item.rule === "R13").length, 0, JSON.stringify(report.warnings));
});

test("R13：信号不在该脚的支持列表里要告警（并列出该脚真支持哪些）", () => {
  const dbFacts = facts({ "PA9": { GPIO: GPIO_MODES, USART1_TX: [], TIM1_CH2: [] } });
  const report = checkIocRules(entries([["PA9.Signal", "USART3_TX"]]), { facts: dbFacts });
  const r13 = report.warnings.filter((item) => item.rule === "R13");
  assert.equal(r13.length, 1);
  assert.match(r13[0].message, /USART3_TX/u);
  assert.match(r13[0].message, /USART1_TX/u);
});

test("R13：没有 db 时整体跳过（查不到 ≠ 写错了）", () => {
  const report = checkIocRules(entries([["PA9.Signal", "USART3_TX"]]));
  assert.equal(report.warnings.some((item) => item.rule === "R13"), false);
});

test("R14：GPIO 模式必须在 db 的 IOModes 里", () => {
  const dbFacts = facts({ "PC13-TAMPER-RTC": { GPIO: GPIO_MODES } });
  const ok = checkIocRules(entries([
    ["PC13-TAMPER-RTC.Signal", "GPIO_Output"],
    ["PC13-TAMPER-RTC.Mode", "GPIO_Output"],
  ]), { facts: dbFacts });
  assert.equal(ok.warnings.some((item) => item.rule === "R14"), false);
  const bad = checkIocRules(entries([
    ["PC13-TAMPER-RTC.Signal", "GPIO_Output"],
    ["PC13-TAMPER-RTC.Mode", "GPIO_Bogus"],
  ]), { facts: dbFacts });
  const r14 = bad.warnings.filter((item) => item.rule === "R14");
  assert.equal(r14.length, 1);
  assert.match(r14[0].message, /GPIO_Bogus/u);
});

test("R14：外设模式要能在该 IP 的 RefMode 名单里找到", () => {
  const root = mkdtempSync(join(tmpdir(), "iocrules-db-"));
  try {
    writeFileSync(join(root, "package.xml"), "<PackDescription Release=\"DB.6.0.150\"/>");
    mkdirSync(join(root, "mcu", "IP"), { recursive: true });
    writeFileSync(
      join(root, "mcu", "IP", "USART-STM32F1xx-usart_v1_0_Modes.xml"),
      "<RefMode Name=\"Asynchronous\"/><RefMode Name=\"Synchronous\"/>",
    );
    const db = { root, version: "DB.6.0.150" };
    const dbFacts = facts(
      { PA9: { GPIO: GPIO_MODES, USART1_TX: [], USART1_RX: [] } },
      [{ instanceName: "USART1", name: "USART", version: "STM32F1xx-usart_v1_0", configFile: "USART-STM32F1xx" }],
    );
    const ok = checkIocRules(entries([
      ["PA9.Signal", "USART1_TX"],
      ["PA9.Mode", "Asynchronous"],
    ]), { db, facts: dbFacts });
    assert.equal(ok.warnings.some((item) => item.rule === "R14"), false, JSON.stringify(ok.warnings));
    const bad = checkIocRules(entries([
      ["PA9.Signal", "USART1_TX"],
      ["PA9.Mode", "Synchronous Slave"],
    ]), { db, facts: dbFacts });
    const r14 = bad.warnings.filter((item) => item.rule === "R14");
    assert.equal(r14.length, 1);
    assert.match(r14[0].message, /USART1/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R17：同一个物理引脚写了两份（PA0 与 PA0-WKUP）→ 报错", () => {
  const dbFacts = facts({ "PA0-WKUP": { GPIO: GPIO_MODES, TIM2_CH1: [] } });
  const report = checkIocRules(entries([
    ["PA0.Signal", "GPIO_Input"],
    ["PA0-WKUP.Signal", "TIM2_CH1"],
  ]), { facts: dbFacts });
  const r17 = report.errors.filter((item) => item.rule === "R17");
  assert.equal(r17.length, 1);
  assert.match(r17[0].message, /PA0-WKUP/u);
});

test("R17：同一个外设信号挂到两根脚上 → 报错", () => {
  const dbFacts = facts({
    "PA0-WKUP": { GPIO: GPIO_MODES, TIM2_CH1: [] },
    "PA1": { GPIO: GPIO_MODES, TIM2_CH2: [] },
  });
  const report = checkIocRules(entries([
    ["PA0-WKUP.Signal", "TIM2_CH1"],
    ["PA1.Signal", "TIM2_CH1"],
  ]), { facts: dbFacts });
  const r17 = report.errors.filter((item) => item.rule === "R17");
  assert.equal(r17.length, 1);
  assert.match(r17[0].message, /TIM2_CH1/u);
});

test("R18：主频超过 db 上限报错，恰好等于上限不报", () => {
  const dbFacts = facts({ "PA9": { GPIO: GPIO_MODES } });
  const ok = checkIocRules(entries([["RCC.SYSCLKFreq_VALUE", "72000000"]]), { facts: dbFacts });
  assert.equal(ok.errors.some((item) => item.rule === "R18"), false, JSON.stringify(ok.errors));
  const bad = checkIocRules(entries([["RCC.SYSCLKFreq_VALUE", "96000000"]]), { facts: dbFacts });
  const r18 = bad.errors.filter((item) => item.rule === "R18");
  assert.equal(r18.length, 1);
  assert.match(r18[0].message, /96000000/u);
  assert.match(r18[0].message, /72 MHz/u);
});

test("R18：没有 SYSCLKFreq_VALUE 或缺 db 时不判", () => {
  const dbFacts = facts({ "PA9": { GPIO: GPIO_MODES } });
  assert.equal(checkIocRules(entries([["Mcu.Family", "STM32F1"]]), { facts: dbFacts }).errors.some((i) => i.rule === "R18"), false);
  assert.equal(checkIocRules(entries([["RCC.SYSCLKFreq_VALUE", "96000000"]])).errors.some((i) => i.rule === "R18"), false);
});
let failed = 0;
for (const item of cases) {
  try { item.fn(); console.log("ok   " + item.name); }
  catch (error) { failed += 1; console.log("FAIL " + item.name); console.log(String(error && error.message ? error.message : error)); }
}
console.log("---");
console.log("tests " + String(cases.length) + " / fail " + String(failed));
if (failed > 0) process.exit(1);
