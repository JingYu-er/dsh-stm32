// CubeMX 内部 .ioc 阅读规则的离线检查单测：node test/ioc-rules-units.test.mjs
import assert from "node:assert/strict";

import { checkIocRules } from "../lib/engine/ioc-rules.js";

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

test("R12：只有 .Mode 没有 .Signal → 告警", () => {
  const report = checkIocRules(entries([["PA6.Mode", "PWM Generation1 CH1"]]));
  assert.equal(report.warnings.some((item) => item.rule === "R12"), true);
});

let failed = 0;
for (const item of cases) {
  try { item.fn(); console.log("ok   " + item.name); }
  catch (error) { failed += 1; console.log("FAIL " + item.name); console.log(String(error && error.message ? error.message : error)); }
}
console.log("---");
console.log("tests " + String(cases.length) + " / fail " + String(failed));
if (failed > 0) process.exit(1);
