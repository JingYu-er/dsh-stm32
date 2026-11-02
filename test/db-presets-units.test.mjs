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

test("虚拟脚（VP_*）与带后缀的引脚不参与选脚", () => {
  const facts = fakeFacts({
    "VP_USART1_TX": ["USART1_TX"],
    "PA9-WKUP": ["USART1_TX"],
    "PA10": ["USART1_RX"],
  });
  const derived = derivePeripheralPreset(facts, "USART1");
  // 只剩 PA10 能做 RX、没有合法 TX → 拒绝（而不是把虚拟脚写进 .ioc）
  assert.equal(derived.preset, null);
  assert.match(derived.reason, /TX/u);
});

test("TIM / ADC 还没派生：给的是人话（说清下一步用手写键），不是错配置", () => {
  const facts = fakeFacts({ "PA0": ["TIM2_CH1_ETR"], "PA1": ["ADC1_IN1"] });
  for (const name of ["TIM2", "ADC1"]) {
    const derived = derivePeripheralPreset(facts, name);
    assert.equal(derived.preset, null, name);
    assert.match(derived.reason, /还没按族派生|还没派生/u, name);
  }
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
