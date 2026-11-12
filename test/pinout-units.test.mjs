import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { findIocPath, groupOfPin, groupPins, readPinout } from "../lib/engine/pinout.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function pin(pinName, signal, extra = {}) {
  return {
    pin: pinName,
    signal,
    label: extra.label ?? "",
    mode: extra.mode ?? "",
    locked: extra.locked ?? false,
    kind: extra.kind ?? "gpio",
  };
}

const IOC_TEXT = [
  "#MicroXplorer Configuration settings - do not modify",
  "Mcu.CPN=STM32F103C8T6",
  "Mcu.Family=STM32F1",
  "Mcu.Package=LQFP48",
  "Mcu.PinsNb=3",
  "Mcu.Pin0=PA0-WKUP",
  "Mcu.Pin1=PA9",
  "Mcu.Pin2=PA13",
  "PA0-WKUP.Signal=GPIO_Output",
  "PA0-WKUP.GPIO_Label=LED",
  "PA0-WKUP.Mode=Output",
  "PA9.Signal=USART1_TX",
  "PA9.Mode=Asynchronous",
  "PA13.Mode=Serial_Wire",
  "PA13.Signal=SYS_JTMS-SWDIO",
  "Mcu.IPNb=1",
  "Mcu.IP0=USART1",
  "NVIC.USART1_IRQn=true\\:0\\:0\\:false\\:false\\:true\\:true\\:true\\:true",
  "RCC.SYSCLKFreq_VALUE=72000000",
].join("\n");

test("groupOfPin：外设实例、GPIO、调试口与时钟各自归类", () => {
  assert.equal(groupOfPin(pin("PA9", "USART1_TX")), "USART1", "USART1_TX 归 USART1");
  assert.equal(groupOfPin(pin("PA0", "S_TIM2_CH1_ETR")), "TIM2", "S_ 前缀不影响实例名");
  assert.equal(groupOfPin(pin("PA1", "ADC1_IN1")), "ADC1");
  assert.equal(groupOfPin(pin("PB0", "GPIO_Output")), "GPIO", "普通 GPIO 不按实例分组");
  assert.equal(groupOfPin(pin("PA13", "SYS_JTMS-SWDIO", { kind: "debug" })), "调试口");
  assert.equal(groupOfPin(pin("PD0", "RCC_OSC_IN", { kind: "clock" })), "时钟");
  assert.equal(groupOfPin(pin("VP_SYS_VS_Systick", "SYS_VS_Systick", { kind: "virtual" })), "虚拟引脚");
});

test("groupPins：外设按名字自然序，GPIO/调试口/时钟排最后", () => {
  const groups = groupPins([
    pin("PA13", "SYS_JTMS-SWDIO", { kind: "debug" }),
    pin("PA2", "USART2_TX"),
    pin("PA0", "GPIO_Output"),
    pin("PA9", "USART1_TX"),
    pin("PD0", "RCC_OSC_IN", { kind: "clock" }),
    pin("PA3", "USART10_TX"),
  ]);
  assert.deepEqual(
    groups.map((group) => group.name),
    ["USART1", "USART2", "USART10", "GPIO", "调试口", "时钟"],
    "USART2 必须排在 USART10 前（数字自然序）",
  );
  assert.equal(groups.find((group) => group.name === "USART1")?.pins.length, 1);
});

test("readPinout：按 Mcu.PinN 读出引脚、芯片、时钟与中断数", () => {
  const dir = tempDir("dsh-pinout-");
  fs.writeFileSync(path.join(dir, "demo.ioc"), IOC_TEXT, "utf8");
  const read = readPinout(dir);
  assert.equal(read.ok, true, read.ok ? "" : read.error);
  if (!read.ok) return;
  assert.equal(read.report.mcu.cpn, "STM32F103C8T6");
  assert.equal(read.report.iocPath, path.join(dir, "demo.ioc"));
  assert.equal(read.report.pins.length, 3);
  assert.deepEqual(
    read.report.pins.map((item) => item.pin),
    ["PA0-WKUP", "PA9", "PA13"],
    "顺序必须与 Mcu.PinN 一致",
  );
  assert.equal(read.report.pins[0]?.label, "LED", "GPIO_Label 要读出来");
  assert.equal(read.report.clocks.sysclkHz, 72000000);
  assert.equal(read.report.nvicCount, 1);
  assert.equal(read.report.debug.serialWire, true);
  assert.deepEqual(
    read.report.groups.map((group) => [group.name, group.pins.length]),
    [
      ["USART1", 1],
      ["GPIO", 1],
      ["调试口", 1],
    ],
  );
});

test("readPinout：没有 .ioc、空目录、目录不存在都给出可读原因", () => {
  const empty = tempDir("dsh-pinout-empty-");
  const noIoc = readPinout(empty);
  assert.equal(noIoc.ok, false);
  if (noIoc.ok) return;
  assert.ok(noIoc.error.includes(".ioc"), noIoc.error);

  const missing = readPinout(path.join(empty, "nope"));
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.ok(missing.error.includes(".ioc"), missing.error);

  const blank = readPinout("   ");
  assert.equal(blank.ok, false);
  if (blank.ok) return;
  assert.ok(blank.error.includes("projectDir"), blank.error);
});

test("findIocPath：有多个 .ioc 时按文件名排序取第一个", () => {
  const dir = tempDir("dsh-pinout-multi-");
  fs.writeFileSync(path.join(dir, "b.ioc"), IOC_TEXT, "utf8");
  fs.writeFileSync(path.join(dir, "a.ioc"), IOC_TEXT, "utf8");
  assert.equal(path.basename(findIocPath(dir)), "a.ioc");
});
