// CubeMX db 查询层单测：node test/cubemx-db-units.test.mjs
import assert from "node:assert/strict";

import { hasIpInstance, ipModesPath, locateCubemxDb, parseMcuXml, readIpModeNames, readMcuFacts, resolveDbPinName } from "../lib/engine/cubemx-db.js";

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

let failed = 0;
for (const item of cases) {
  try { item.fn(); console.log("ok   " + item.name); }
  catch (error) { failed += 1; console.log("FAIL " + item.name); console.log(String(error && error.message ? error.message : error)); }
}
console.log("---");
console.log("tests " + String(cases.length) + " / fail " + String(failed));
if (failed > 0) process.exit(1);
