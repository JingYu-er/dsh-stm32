// CubeMX db 查询层单测：node test/cubemx-db-units.test.mjs
import assert from "node:assert/strict";

import {
  pinBaseOf, hasIpInstance, ipModesPath, locateCubemxDb, logicalPinName, parseMcuXml, readIpModeNames, readMcuFacts, resolveDbPinName } from "../lib/engine/cubemx-db.js";

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

const SAMPLE = [
  "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
  "<Mcu Family=\"STM32F1\" Package=\"LQFP48\" RefName=\"STM32F103C(8-B)Tx\">",
  "  <Frequency>72</Frequency>",
  "  <IP ConfigFile=\"TIM-STM32F1xx\" InstanceName=\"TIM3\" Name=\"TIM1_8F1\" Version=\"gptimer2_v1_x_Cube\"/>",
  "  <Pin Name=\"PA0-WKUP\" Position=\"10\" Type=\"I/O\">",
  "    <Signal Name=\"TIM2_CH1\"/>",
  "    <Signal IOModes=\"Input,Output,Analog,EVENTOUT,EXTI\" Name=\"GPIO\"/>",
  "  </Pin>",
  "  <Pin Name=\"PA8\" Position=\"29\" Type=\"I/O\">",
  "    <Signal Name=\"TIM1_CH1\"/>",
  "  </Pin>",
  "</Mcu>",
].join("\n");

test("parseMcuXml：读出芯片名/封装/频率/引脚 Signal/IP 实例", () => {
  const facts = parseMcuXml(SAMPLE);
  assert.equal(facts.name, "STM32F103C(8-B)Tx");
  assert.equal(facts.packageName, "LQFP48");
  assert.equal(facts.frequencyMhz, 72);
  assert.deepEqual([...facts.pins.get("PA8").signals.keys()], ["TIM1_CH1"]);
  assert.deepEqual(facts.pins.get("PA0-WKUP").signals.get("GPIO"), ["Input", "Output", "Analog", "EVENTOUT", "EXTI"]);
  assert.equal(facts.ips.get("TIM3").name, "TIM1_8F1");
});

test("resolveDbPinName：逻辑名换算成 db 名", () => {
  const facts = parseMcuXml(SAMPLE);
  assert.equal(resolveDbPinName(facts, "PA0"), "PA0-WKUP");
  assert.equal(resolveDbPinName(facts, "PA8"), "PA8");
  assert.equal(resolveDbPinName(facts, "PB7"), null);
});

test("hasIpInstance：不存在的实例返回 false", () => {
  const facts = parseMcuXml(SAMPLE);
  assert.equal(hasIpInstance(facts, "TIM3"), true);
  assert.equal(hasIpInstance(facts, "tim3"), true);
  assert.equal(hasIpInstance(facts, "TIM5"), false);
});

test("真实 db：定位、读芯片事实、读 IP 模式名（本机没装 CubeMX 时跳过）", () => {
  const db = locateCubemxDb(["D:/app/STM32CubeMX"]);
  if (db === null) { console.log("  （跳过：本机没有 CubeMX db）"); return; }
  assert.match(db.version, /^DB[.]/u);
  const facts = readMcuFacts(db, "STM32F103C(8-B)Tx");
  assert.equal(facts === null, false);
  assert.equal(facts.frequencyMhz, 72);
  assert.equal(facts.pins.size >= 40, true);
  assert.equal(hasIpInstance(facts, "TIM3"), true);
  assert.equal(hasIpInstance(facts, "TIM5"), false);
  assert.equal(resolveDbPinName(facts, "PC13"), "PC13-TAMPER-RTC");
  const modes = readIpModeNames(db, facts, "TIM3");
  assert.equal(modes.includes("PWM Generation1 CH1"), true);
  assert.equal(modes.includes("Encoder_Interface"), true);
  assert.equal(ipModesPath(db, facts, "TIM3") === null, false);
  console.log("  db=" + db.version + " pins=" + facts.pins.size + " ips=" + facts.ips.size + " TIM3modes=" + modes.length);
});

test("logicalPinName：db 名去掉 -XXX 后缀（反查用）", () => {
  assert.equal(logicalPinName("PA0-WKUP"), "PA0");
  assert.equal(logicalPinName("PC13-TAMPER-RTC"), "PC13");
  assert.equal(logicalPinName("PA8"), "PA8");
});

test("所有不同的 <Pin Name> 都会被解析（同一个名字出现多次只算一根）", () => {
  // 真实 db 里 LQFP48 的 MCU XML 有 48 个 <Pin> 标签，但只有 44 个不同名字：
  // VSS / VDD 各出现 3 次。所以「44 个引脚」是对的，别拿标签数当引脚数。
  const text = [
    "<Mcu Family=\"STM32F1\" Package=\"LQFP48\" RefName=\"STM32F103C(8-B)Tx\">",
    "  <Pin Name=\"VDD\" Position=\"1\" Type=\"Power\"/>",
    "  <Pin Name=\"VSS\" Position=\"2\" Type=\"Power\"/>",
    "  <Pin Name=\"VSS\" Position=\"3\" Type=\"Power\"/>",
    "  <Pin Name=\"VDD\" Position=\"4\" Type=\"Power\"/>",
    "  <Pin Name=\"PA0-WKUP\" Position=\"5\" Type=\"I/O\">",
    "    <Signal Name=\"GPIO\" IOModes=\"Input,Output\"/>",
    "  </Pin>",
    "  <Pin Name=\"PA1\" Position=\"6\" Type=\"I/O\"><Signal Name=\"GPIO\"/></Pin>",
    "</Mcu>",
  ].join("\n");
  const facts = parseMcuXml(text);
  assert.equal(facts.pins.size, 4, "VDD/VSS 各两份标签只应算两根");
  for (const name of ["VDD", "VSS", "PA0-WKUP", "PA1"]) assert.equal(facts.pins.has(name), true, name + " 应该被解析出来");
});

let failed = 0;
for (const item of cases) {
  try { item.fn(); console.log("ok   " + item.name); }
  catch (error) { failed += 1; console.log("FAIL " + item.name); console.log(String(error && error.message ? error.message : error)); }
}
console.log("---");
console.log("tests " + String(cases.length) + " / fail " + String(failed));
if (failed > 0) process.exit(1);
test("引脚名后缀两种写法都要能对上（PA0-WKUP 与 PA13 (JTMS-SWDIO)）", () => {
  // F1 的 db 用连字符后缀，L4 用「空格 + 括号里的复用功能」；两种都得能反查到逻辑名，
  // 否则写进 .ioc 的键名 CubeMX 不认、整根脚被静默丢掉（L4 实测丢过 PA13/PA14）。
  assert.equal(pinBaseOf("PA0-WKUP"), "PA0");
  assert.equal(pinBaseOf("PA13 (JTMS-SWDIO)"), "PA13");
  assert.equal(pinBaseOf("PC14-OSC32_IN"), "PC14");

  const facts = {
    name: "FAKE", packageName: "LQFP64", frequencyMhz: 80, family: "STM32L4", line: "STM32L476",
    core: "Arm Cortex-M4", ramKb: 128, flashKb: [512], ioNb: 64,
    pins: new Map([
      ["PA13 (JTMS-SWDIO)", { name: "PA13 (JTMS-SWDIO)", position: 1, signals: new Map() }],
      ["PA0-WKUP", { name: "PA0-WKUP", position: 2, signals: new Map() }],
    ]),
    ips: new Map(),
  };
  assert.equal(resolveDbPinName(facts, "PA13"), "PA13 (JTMS-SWDIO)");
  assert.equal(resolveDbPinName(facts, "PA0"), "PA0-WKUP");
});
