import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { dividerLabel, mulLabel, parseHz, readClockTree } from "../lib/engine/clocks.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const IOC = [
  "Mcu.CPN=STM32F103C8T6",
  "RCC.SYSCLKSource=RCC_SYSCLKSOURCE_PLLCLK",
  "RCC.PLLSourceVirtual=RCC_PLLSOURCE_HSE",
  "RCC.PLLMUL=RCC_PLL_MUL9",
  "RCC.SYSCLKFreq_VALUE=72000000",
  "RCC.AHBFreq_Value=72000000",
  "RCC.APB1Freq_Value=36000000",
  "RCC.APB1CLKDivider=RCC_HCLK_DIV2",
  "RCC.APB2Freq_Value=72000000",
  "RCC.APB1TimFreq_Value=72000000",
  "RCC.ADCFreqValue=36000000",
  "RCC.USBFreq_Value=48000000",
  "RCC.VCOOutput2Freq_Value=8000000",
].join("\n");

test("parseHz：只认十进制整数，带小数或非数字一律 null", () => {
  assert.equal(parseHz("72000000"), 72000000);
  assert.equal(parseHz(" 48000000 "), 48000000);
  assert.equal(parseHz("7.2e7"), null);
  assert.equal(parseHz("abc"), null);
  assert.equal(parseHz(undefined), null);
});

test("dividerLabel / mulLabel：RCC 枚举值转 ÷N 与 ×N，认不出原样返回", () => {
  assert.equal(dividerLabel("RCC_HCLK_DIV2"), "÷2");
  assert.equal(dividerLabel("RCC_SYSCLK_DIV1"), "÷1");
  assert.equal(dividerLabel("WEIRD"), "WEIRD");
  assert.equal(mulLabel("RCC_PLL_MUL9"), "×9");
  assert.equal(mulLabel("WEIRD"), "WEIRD");
});

test("readClockTree：读频率、系统时钟源、PLL 与分频，未列出的 RCC 频率进 others", () => {
  const dir = tempDir("dsh-clocks-");
  fs.writeFileSync(path.join(dir, "demo.ioc"), IOC, "utf8");
  const read = readClockTree(dir);
  assert.equal(read.ok, true, read.ok ? "" : read.error);
  if (!read.ok) return;
  const { report } = read;
  assert.equal(report.cpn, "STM32F103C8T6");
  assert.equal(report.sysclkSourceLabel, "PLL");
  assert.equal(report.pll.sourceLabel, "HSE");
  assert.equal(report.pll.mulLabel, "×9");
  const byLabel = new Map(report.nodes.map((node) => [node.label, node]));
  assert.equal(byLabel.get("SYSCLK")?.hz, 72000000);
  assert.equal(byLabel.get("HCLK / AHB")?.hz, 72000000);
  assert.equal(byLabel.get("PCLK1 / APB1")?.hz, 36000000);
  assert.equal(byLabel.get("PCLK1 / APB1")?.divider, "÷2");
  assert.equal(byLabel.get("PCLK2 / APB2")?.divider, "", "没有分频键时留空");
  assert.equal(byLabel.get("USB")?.hz, 48000000);
  assert.deepEqual(
    report.others.map((node) => node.label),
    ["VCOOutput2Freq_Value"],
    "只有未列入主树的 RCC 频率才进 others",
  );
});

test("readClockTree：缺 .ioc、空目录、空参数都返回 ok:false 并说明原因", () => {
  const empty = tempDir("dsh-clocks-empty-");
  const noIoc = readClockTree(empty);
  assert.equal(noIoc.ok, false);
  if (!noIoc.ok) assert.ok(noIoc.error.includes(".ioc"));
  const missing = readClockTree(path.join(empty, "nope"));
  assert.equal(missing.ok, false);
  const blank = readClockTree("");
  assert.equal(blank.ok, false);
  if (!blank.ok) assert.ok(blank.error.includes("projectDir"));
});

test("readClockTree：.ioc 没有 RCC 键时节点全为 null，不伪造频率", () => {
  const dir = tempDir("dsh-clocks-bare-");
  fs.writeFileSync(path.join(dir, "demo.ioc"), "Mcu.CPN=STM32F103C8T6\n", "utf8");
  const read = readClockTree(dir);
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.report.nodes.every((node) => node.hz === null), true);
  assert.equal(read.report.sysclkSourceLabel, "");
  assert.equal(read.report.others.length, 0);
});
