// .ioc 解析引擎单测：node test/ioc-units.test.mjs（不要用 node --test：沙箱下 spawn EPERM）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { decodeIocValue, parseIocEntries, summarizeIoc } from "../lib/engine/ioc.js";

import { FIXTURE_IOC as DEMO, FIXTURE_SCRATCH_IOC as SCRATCH } from "./fixtures.mjs";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test("decodeIocValue 还原 \\: 转义", () => {
  assert.equal(decodeIocValue("USB\\:Device"), "USB:Device");
  assert.equal(decodeIocValue("plain"), "plain");
});

test("parseIocEntries 跳过注释/空行，重复键后者覆盖", () => {
  const entries = parseIocEntries("# comment\n\nA=1\nB = 2 \nA=3\nnoEquals\n");
  assert.equal(entries.get("A"), "3");
  assert.equal(entries.get("B"), "2");
  assert.equal(entries.has("noEquals"), false);
  assert.equal(entries.size, 2);
});

test("demo.ioc：引脚、调试口、时钟、工程设置", () => {
  const summary = summarizeIoc(readFileSync(DEMO, "utf8"), DEMO);
  assert.equal(summary.mcu.cpn, "STM32F103C8T6");
  assert.equal(summary.pins.length, 8);
  const led = summary.pins.find((pin) => pin.pin === "PC13-TAMPER-RTC");
  assert.equal(led.signal, "GPIO_Output");
  assert.equal(led.label, "led");
  assert.equal(led.kind, "gpio");
  const swd = summary.pins.filter((pin) => pin.kind === "debug").map((pin) => pin.pin);
  assert.deepEqual(swd, ["PA13", "PA14"]);
  assert.equal(summary.debug.serialWire, true);
  assert.equal(summary.clocks.sysclkHz, 72000000);
  assert.equal(summary.clocks.apb1Hz, 36000000);
  assert.equal(summary.settings.targetToolchain, "CMake");
  assert.equal(summary.settings.mainLocation, "Core/Src");
  assert.equal(summary.settings.keepUserCode, true);
  assert.deepEqual(summary.peripherals, ["NVIC", "RCC", "SYS"]);
  assert.deepEqual(summary.warnings, []);
});

test("scratch.ioc：只有 Ports 相关的 4 个引脚，MainLocation=Src", () => {
  const summary = summarizeIoc(readFileSync(SCRATCH, "utf8"), SCRATCH);
  assert.deepEqual(summary.pins.map((pin) => pin.pin), ["PC13-TAMPER-RTC", "PA13", "PA14", "VP_SYS_VS_Systick"]);
  assert.equal(summary.debug.serialWire, true);
  assert.equal(summary.settings.mainLocation, "Src");
  assert.equal(summary.clocks.sysclkHz, null);
});

test("没启用 Serial Wire 的 .ioc 必须报警（SWJ_DISABLE 陷阱）", () => {
  const text = [
    "Mcu.CPN=STM32F103C8T6",
    "Mcu.PinsNb=1",
    "Mcu.Pin0=PC13-TAMPER-RTC",
    "PC13-TAMPER-RTC.Signal=GPIO_Output",
    "PC13-TAMPER-RTC.GPIO_Label=led",
    "ProjectManager.TargetToolchain=CMake",
    "ProjectManager.KeepUserCode=true",
  ].join("\n");
  const summary = summarizeIoc(text);
  assert.equal(summary.debug.serialWire, false);
  assert.equal(summary.warnings.length >= 1, true);
  assert.match(summary.warnings[0], /Serial Wire/);
});

test("KeepUserCode=false / 非 CMake 工具链 / CoupleFile=true 各报警", () => {
  const text = [
    "Mcu.PinsNb=2",
    "Mcu.Pin0=PA13",
    "PA13.Signal=SYS_JTMS-SWDIO",
    "PA13.Mode=Serial_Wire",
    "Mcu.Pin1=PA14",
    "PA14.Signal=SYS_JTCK-SWCLK",
    "ProjectManager.KeepUserCode=false",
    "ProjectManager.TargetToolchain=EWARM V8.32",
    "ProjectManager.CoupleFile=true",
  ].join("\n");
  const summary = summarizeIoc(text);
  assert.equal(summary.warnings.length, 3);
  assert.match(summary.warnings.join("\n"), /KeepUserCode/);
  assert.match(summary.warnings.join("\n"), /EWARM/);
  assert.match(summary.warnings.join("\n"), /CoupleFile/);
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
console.log("---");
console.log("tests " + cases.length + " / fail " + failed);
process.exit(failed === 0 ? 0 : 1);
