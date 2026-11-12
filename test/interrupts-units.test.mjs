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
  setInterruptPriority,
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

test("改优先级：只动这一条的第二、三段，其余段与其它行不变", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-irq-edit-"));
  const ioc = path.join(dir, "demo.ioc");
  const other = "NVIC.BusFault_IRQn=false\\:0\\:0\\:false\\:false\\:true\\:false\\:false\\:false";
  fs.writeFileSync(ioc, [NVIC_LINE("USART1", true, 2, 0), other].join("\n"), "utf8");

  const written = setInterruptPriority(dir, "USART1", 5, 3);
  assert.equal(written.ok, true);
  assert.equal(written.report.before.preempt, 2);
  assert.equal(written.report.before.sub, 0);
  assert.equal(written.report.after.preempt, 5);
  assert.equal(written.report.after.sub, 3);
  assert.equal(written.report.changed, true);
  const text = fs.readFileSync(ioc, "utf8");
  assert.ok(text.includes("NVIC.USART1_IRQn=true\\:5\\:3\\:false\\:false\\:true\\:false\\:false\\:false"));
  assert.ok(text.includes(other));
  assert.ok(fs.existsSync(written.report.backupPath));

  const reread = readInterrupts(dir);
  assert.equal(reread.ok, true);
  const entry = reread.report.entries.find((item) => item.name === "USART1");
  assert.equal(entry.preempt, 5);
  assert.equal(entry.sub, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("改优先级：非法值、未知中断、空目录都被拒", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-irq-edit-bad-"));
  fs.writeFileSync(path.join(dir, "demo.ioc"), NVIC_LINE("USART1", true, 0, 0), "utf8");
  const badPreempt = setInterruptPriority(dir, "USART1", 16, 0);
  assert.equal(badPreempt.ok, false);
  assert.match(badPreempt.error, /抢占优先级/u);
  const badSub = setInterruptPriority(dir, "USART1", 0, -1);
  assert.equal(badSub.ok, false);
  assert.match(badSub.error, /子优先级/u);
  const badName = setInterruptPriority(dir, "USART 1", 0, 0);
  assert.equal(badName.ok, false);
  assert.match(badName.error, /中断名/u);
  const unknown = setInterruptPriority(dir, "TIM9", 0, 0);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /没有这一路中断/u);
  const blank = setInterruptPriority("   ", "USART1", 0, 0);
  assert.equal(blank.ok, false);
  assert.match(blank.error, /projectDir/u);
  fs.rmSync(dir, { recursive: true, force: true });
});
