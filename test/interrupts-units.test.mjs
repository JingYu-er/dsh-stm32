/**
 * 中断表解析：只测纯函数与真实 .ioc 片段，不启动 CubeMX。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  collectInterrupts,
  interruptName,
  parseNvicValue,
  readInterrupts,
} from "../lib/engine/interrupts.js";

/** 与 CubeMX 写进 .ioc 的格式一致：冒号转义成 \:，八段。 */
const NVIC_LINE = (name, enabled, preempt, sub) =>
  "NVIC." + name + "_IRQn=" + (enabled ? "true" : "false") + "\\:" + String(preempt) + "\\:" + String(sub) + "\\:false\\:false\\:true\\:false\\:false\\:false";

test("中断表：键名归一与值解析", () => {
  assert.equal(interruptName("NVIC.USART1_IRQn"), "USART1");
  assert.equal(interruptName("NVIC.ForceEnableDMAVector"), "");
  assert.equal(interruptName("RCC.SYSCLKSource"), "");
  assert.deepEqual(parseNvicValue("true\\:2\\:1\\:false"), { enabled: true, preempt: 2, sub: 1 });
  assert.deepEqual(parseNvicValue("false\\:0\\:0"), { enabled: false, preempt: 0, sub: 0 });
  // 段数不足：优先级给 -1，不冒充 0。
  assert.deepEqual(parseNvicValue("true"), { enabled: true, preempt: -1, sub: -1 });
});

test("中断表：排序按抢占 → 子 → 名字，并跳过非中断键", () => {
  const entries = collectInterrupts([
    { key: "NVIC.ForceEnableDMAVector", value: "true" },
    { key: "NVIC.USART1_IRQn", value: "true\\:2\\:0\\:false" },
    { key: "NVIC.TIM2_IRQn", value: "true\\:0\\:1\\:false" },
    { key: "NVIC.EXTI0_IRQn", value: "true\\:0\\:0\\:false" },
    { key: "RCC.SYSCLKSource", value: "RCC_SYSCLKSOURCE_PLLCLK" },
  ]);
  assert.deepEqual(entries.map((entry) => entry.name), ["EXTI0", "TIM2", "USART1"]);
  assert.equal(entries.length, 3);
});

test("中断表：读真实形状的 .ioc，统计使能数", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-irq-"));
  fs.writeFileSync(
    path.join(dir, "demo.ioc"),
    [
      "Mcu.CPN=STM32F103C8T6",
      NVIC_LINE("USART1", true, 2, 0),
      NVIC_LINE("TIM2", true, 0, 1),
      NVIC_LINE("I2C1_EV", false, 3, 0),
      "NVIC.ForceEnableDMAVector=true",
      "",
    ].join("\n"),
    "utf8",
  );
  const read = readInterrupts(dir);
  assert.equal(read.ok, true);
  const report = read.report;
  assert.equal(report.entries.length, 3);
  assert.equal(report.enabledCount, 2);
  assert.equal(report.entries[0].name, "TIM2");
  assert.equal(report.iocName, "demo.ioc");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("中断表：空目录与空参数给出可读错误", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-irq-empty-"));
  const none = readInterrupts(dir);
  assert.equal(none.ok, false);
  assert.match(none.error, /没有 \.ioc/u);
  const blank = readInterrupts("   ");
  assert.equal(blank.ok, false);
  assert.match(blank.error, /projectDir/u);
  fs.rmSync(dir, { recursive: true, force: true });
});
