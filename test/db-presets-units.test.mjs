// db 派生预设（src/data/db-presets.ts）的离线单测：选脚规则、拒绝理由、范围边界。
//
// 为什么要单测选脚：这一层不读手册、只读 db 的复用例表，规则一旦写歪就会挑出一根
// "db 里能做 USART1_TX、但和 RX 不同端口"的脚，或者干脆挑到虚拟脚（VP_*）。
// 真机往返（plan → apply → CubeMX 回写）太慢（一次 2–3 分钟），不能当每次改动的闸门。
//
// 运行：node --test test/db-presets-units.test.mjs（需先 npm run build）
import assert from "node:assert/strict";
import { test } from "node:test";

import { derivePeripheralPreset } from "../lib/data/db-presets.js";

/** 造一份最小 McuFacts：pins 给 { 引脚名: [信号名…] }，ips 给实例名列表。 */
function fakeFacts(pins, ips = ["USART1", "USART2", "TIM2", "ADC1", "SPI1"]) {
  const pinMap = new Map();
  let position = 0;
  for (const [name, signals] of Object.entries(pins)) {
    position += 1;
    pinMap.set(name, { name, position, signals: new Map(signals.map((signal) => [signal, ["Input", "Output"]])) });
  }
  const ipMap = new Map();
  for (const instance of ips) {
    ipMap.set(instance, { instanceName: instance, name: instance.replace(/[0-9]+$/u, ""), version: "v1", configFile: "" });
  }
  return { name: "STM32F407V(E-G)Tx", packageName: "LQFP100", frequencyMhz: 168, pins: pinMap, ips: ipMap };
}

test("USART：同端口的一对优先（PA9/PA10），且写 Asynchronous + VM_ASYNC", () => {
  const facts = fakeFacts({
    "PB6": ["USART1_TX"],                 // 更小的端口字母，但没有配对 → 不该被选中
    "PA9": ["USART1_TX", "TIM1_CH2"],
    "PA10": ["USART1_RX"],
    "PB7": ["USART1_RX"],
  });
  const derived = derivePeripheralPreset(facts, "usart1");
  assert.notEqual(derived.preset, null, derived.reason);
  const preset = derived.preset;
  assert.equal(preset.name, "USART1");
  assert.deepEqual(preset.pins.map((pin) => [pin.role, pin.defaultPin, pin.signal, pin.mode]), [
    ["tx", "PA9", "USART1_TX", "Asynchronous"],
    ["rx", "PA10", "USART1_RX", "Asynchronous"],
  ]);
  assert.deepEqual(preset.parameters, [{ name: "VirtualMode", value: "VM_ASYNC" }]);
});

test("USART：没有同端口的一对时各取一根，并在 notes 里说明跨端口", () => {
  const facts = fakeFacts({ "PA9": ["USART1_TX"], "PB7": ["USART1_RX"] });
  const derived = derivePeripheralPreset(facts, "USART1");
  assert.notEqual(derived.preset, null, derived.reason);
  assert.equal(derived.preset.pins[0].defaultPin, "PA9");
  assert.equal(derived.preset.pins[1].defaultPin, "PB7");
  assert.match(derived.preset.notes.join(" "), /不在同一个端口/u);
});

test("USART：缺 RX（只有 TX）时拒绝，理由点名缺哪一路", () => {
  const facts = fakeFacts({ "PA9": ["USART1_TX"] });
  const derived = derivePeripheralPreset(facts, "USART1");
  assert.equal(derived.preset, null);
  assert.match(derived.reason, /RX/u);
});

test("USART：db 里没有这个实例时拒绝，并列出这颗芯片真实有的 IP", () => {
  const facts = fakeFacts({ "PA9": ["USART1_TX"], "PA10": ["USART1_RX"] });
  const derived = derivePeripheralPreset(facts, "USART7");
  assert.equal(derived.preset, null);
  assert.match(derived.reason, /USART7/u);
  assert.match(derived.reason, /USART1/u);
});

test("虚拟脚（VP_*）不参与选脚；带后缀的 db 引脚参与，但要返回逻辑名", () => {
  const facts = fakeFacts({
    "VP_USART1_TX": ["USART1_TX"],   // 虚拟脚：不能写进 .ioc
    "PA9-WKUP": ["USART1_TX"],       // F1 的 PA9 在 db 里不带后缀，这里造一个带后缀的验证映射
    "PA10": ["USART1_RX"],
  });
  const derived = derivePeripheralPreset(facts, "USART1");
  assert.notEqual(derived.preset, null, derived.reason);
  // 带后缀的 PA9-WKUP 必须被认成 PA9（逻辑名），且不能因为"名字里有 -"就把整根脚丢掉
  assert.equal(derived.preset.pins[0].defaultPin, "PA9");
  assert.equal(derived.preset.pins[1].defaultPin, "PA10");

  // 只有虚拟脚能做 TX 时才是拒绝
  const onlyVirtual = derivePeripheralPreset(fakeFacts({ "VP_USART1_TX": ["USART1_TX"], "PA10": ["USART1_RX"] }), "USART1");
  assert.equal(onlyVirtual.preset, null);
  assert.match(onlyVirtual.reason, /TX/u);
});

test("TIM：db 信号要写成 S_ 前缀的共享信号，通道参数按 CHn 拼", () => {
  // F1 的真实形状：PA0 在 db 里叫 PA0-WKUP，信号是 TIM2_CH1；PA1 也有 TIM2_CH2
  const facts = fakeFacts({ "PA0-WKUP": ["TIM2_CH1"], "PA1": ["TIM2_CH2"], "PA6": ["TIM3_CH1"] });
  const derived = derivePeripheralPreset(facts, "TIM2", { familyId: "STM32F1" });
  assert.notEqual(derived.preset, null, derived.reason);
  const preset = derived.preset;
  assert.equal(preset.pins[0].defaultPin, "PA0");            // 逻辑名，落键时再换 PA0-WKUP
  assert.equal(preset.pins[0].signal, "S_TIM2_CH1");         // .ioc 里是共享信号名
  assert.equal(preset.pins[0].shared.key, "S_TIM2_CH1");
  assert.equal(preset.pins[0].shared.ipSignal, "TIM2_CH1");
  assert.equal(preset.pins[0].shared.ipMode, "PWM Generation1 CH1");
  assert.deepEqual(preset.parameters, [{ name: "Channel-PWM Generation1 CH1", value: "TIM_CHANNEL_1" }]);

  // 合并过的 db 信号（TIM2_CH1_ETR）同样接受
  const etr = derivePeripheralPreset(fakeFacts({ "PA0": ["TIM2_CH1_ETR"] }), "TIM2");
  assert.equal(etr.preset.pins[0].signal, "S_TIM2_CH1_ETR");
});

test("ADC：引脚信号写 ADCx_INn，实例由 SH 块表达；F1 才带 RCC.ADCPresc", () => {
  const facts = fakeFacts({ "PA0": ["ADC1_IN0"], "PA1": ["ADC1_IN1"], "PC0": ["ADC1_IN10"] }, ["ADC1"]);
  const derived = derivePeripheralPreset(facts, "ADC1", { familyId: "STM32F1" });
  assert.notEqual(derived.preset, null, derived.reason);
  const preset = derived.preset;
  assert.equal(preset.pins[0].defaultPin, "PA1");           // 优先 IN1（历史默认）
  assert.equal(preset.pins[0].signal, "ADCx_IN1");
  assert.equal(preset.pins[0].shared.ipSignal, "ADC1_IN1");
  assert.deepEqual(preset.parameters.find((param) => param.name === "Channel-0#ChannelRegularConversion"), {
    name: "Channel-0#ChannelRegularConversion", value: "ADC_CHANNEL_1",
  });
  assert.equal(preset.extraEntries?.[0]?.key, "RCC.ADCPresc");

  // 非 F1：不猜该族的 ADC 预分频，只提醒
  const f4 = derivePeripheralPreset(facts, "ADC1", { familyId: "STM32F4" });
  assert.equal(f4.preset.extraEntries, undefined);
  assert.match(f4.preset.notes.join(" "), /ADC 时钟预分频/u);

  // 没有 IN1 时取最小可用通道
  const noIn1 = derivePeripheralPreset(fakeFacts({ "PA0": ["ADC1_IN0"], "PC0": ["ADC1_IN10"] }, ["ADC1"]), "ADC1");
  assert.equal(noIn1.preset.pins[0].defaultPin, "PA0");
  assert.match(noIn1.preset.notes.join(" "), /IN1/u);
});

test("变体与 DMA 不派生（留给手写表），SPI 等未覆盖的名字给人话", () => {
  const facts = fakeFacts({ "PA0": ["TIM2_CH1"] });
  assert.match(derivePeripheralPreset(facts, "TIM3:timebase").reason, /变体|DMA/u);
  assert.match(derivePeripheralPreset(facts, "ADC1:1,4,5").reason, /变体|DMA/u);
  assert.match(derivePeripheralPreset(facts, "DMA:ADC1").reason, /变体|DMA/u);
  const spi = derivePeripheralPreset(facts, "SPI1");
  assert.equal(spi.preset, null);
  assert.match(spi.reason, /还没派生/u);
});

test("读不到 db 时拒绝，并说清是缺 db（而不是缺这个外设）", () => {
  const derived = derivePeripheralPreset(null, "USART1");
  assert.equal(derived.preset, null);
  assert.match(derived.reason, /db/u);
});

test("LPUART / UART 与 USART 同一套规则", () => {
  const facts = fakeFacts({ "PA2": ["LPUART1_TX"], "PA3": ["LPUART1_RX"] }, ["LPUART1", "UART4"]);
  const lpuart = derivePeripheralPreset(facts, "LPUART1");
  assert.notEqual(lpuart.preset, null, lpuart.reason);
  assert.equal(lpuart.preset.pins[0].defaultPin, "PA2");
  assert.equal(lpuart.preset.pins[1].defaultPin, "PA3");
});
