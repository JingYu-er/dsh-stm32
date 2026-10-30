// 单元测试：F1 型号 → 芯片事实（解析逻辑 + 事实来源）。
//
// 内置表已经删了（用户 2026-10-31「内置表删了吧」）：事实只来自资源包缓存里的
// device/f1/chips.json，经 src/data/device-facts.ts 读入。所以这里的断言分两层：
//   1) 解析逻辑（型号写法 → 哪一颗、错误文案）；
//   2) 事实来源（夹具缓存 / 没有缓存时明确失败，而不是退回某张表）。
// 跑法：node test\stm32f1-units.test.mjs（需先 npm run build）
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveF1Chip, f1GroupsFor } from "../lib/data/stm32f1.js";
import { DeviceFactError, deviceFactsSource, findChipFact, loadDeviceFacts, requireChipFact } from "../lib/data/device-facts.js";

import { FIXTURE_ASSETS } from "./fixtures.mjs";

// 事实只从资源包缓存读：单测统一指到夹具（20 颗真实 CPN），绝不读开发机真实 home 缓存。
process.env.DSH_STM32_ASSETS = FIXTURE_ASSETS;

const FW_STARTUP = "D:/app/STM32CubeMX/Repository/STM32Cube_FW_F1_V1.8.7/Drivers/CMSIS/Device/ST/STM32F1xx/Source/Templates/gcc";

/** 夹具里 F1 的 line 全集（事实来自夹具 chips.json，不是插件里的表）。 */
const F1_LINE_CODES = ["100", "101", "102", "103", "105", "107"];

test("设备事实来自资源包缓存：夹具 chips.json 能读、版本对得上", () => {
  const source = deviceFactsSource();
  assert.ok(source.endsWith(join("2026.10.31-1", "device", "f1", "chips.json")), source);
  const facts = loadDeviceFacts();
  assert.equal(facts.ok, true, facts.error);
  assert.equal(facts.version, "2026.10.31-1");
  assert.equal(facts.chips.length, 20);
  assert.deepEqual(facts.lines.slice().sort(), F1_LINE_CODES);
  assert.equal(findChipFact("STM32F103C8T6")?.flashBytes, 64 * 1024);
});

test("resolveF1Chip：蓝丸 C8T6 的事实与资源包一致", () => {
  const { chip, reason } = resolveF1Chip("STM32F103C8T6");
  assert.equal(reason, "");
  assert.ok(chip);
  assert.equal(chip.cpn, "STM32F103C8T6");
  assert.equal(chip.prefix, "STM32F103");
  assert.equal(chip.densityLetter, "8");
  assert.equal(chip.group, "xb");
  assert.equal(chip.startup, "startup_stm32f103xb.s");
  assert.equal(chip.deviceDefine, "STM32F103xB");
  assert.equal(chip.deviceHeader, "stm32f103xb.h");
  assert.equal(chip.pinCount, 48);
  assert.equal(chip.flashBytes, 64 * 1024);
  assert.equal(chip.ramBytes, 20 * 1024);
  assert.deepEqual(chip.notes, []);
});

test("resolveF1Chip：RCT6 走 xE 档，Flash/RAM 与大容量一致", () => {
  const { chip } = resolveF1Chip("STM32F103RCT6");
  assert.ok(chip);
  assert.equal(chip.group, "xe");
  assert.equal(chip.startup, "startup_stm32f103xe.s");
  assert.equal(chip.deviceDefine, "STM32F103xE");
  assert.equal(chip.pinCount, 64);
  assert.equal(chip.flashBytes, 256 * 1024);
  assert.equal(chip.ramBytes, 48 * 1024);
});

test("resolveF1Chip：xE 档里 C/D/E 三个字母 RAM 不同，不能按档查", () => {
  const c = resolveF1Chip("STM32F103RCT6").chip;
  const e = resolveF1Chip("STM32F103RET6").chip;
  assert.ok(c && e);
  assert.equal(c.group, e.group);
  assert.equal(c.ramBytes, 48 * 1024);
  assert.equal(e.ramBytes, 64 * 1024);
  assert.equal(c.flashBytes, 256 * 1024);
  assert.equal(e.flashBytes, 512 * 1024);
});

test("resolveF1Chip：F107 只有 xC 一档，互联型认得出", () => {
  const { chip } = resolveF1Chip("STM32F107VCT6");
  assert.ok(chip);
  assert.equal(chip.prefix, "STM32F107");
  assert.equal(chip.group, "xc");
  assert.equal(chip.startup, "startup_stm32f107xc.s");
  assert.equal(chip.deviceDefine, "STM32F107xC");
  assert.equal(chip.pinCount, 100);
  assert.equal(chip.ramBytes, 64 * 1024);
});

test("resolveF1Chip：资源包里没收录的容量档要明确拒绝，并指向资源包/refresh", () => {
  const f107xb = resolveF1Chip("STM32F107RBT6");
  assert.equal(f107xb.chip, null);
  assert.match(f107xb.reason, /这一档没有收录/u);
  assert.match(f107xb.reason, /资源包/u);
  assert.match(f107xb.reason, /stm32_assets refresh/u);
  const f102xe = resolveF1Chip("STM32F102CET6");
  assert.equal(f102xe.chip, null);
  assert.match(f102xe.reason, /这一档没有收录/u);
});

test("resolveF1Chip：未知 line / 坏格式 / 空输入都返回原因", () => {
  assert.match(resolveF1Chip("STM32F109C8T6").reason, /没有 F109/u);
  assert.match(resolveF1Chip("ATMEGA328").reason, /不是 F1 的型号格式/u);
  assert.match(resolveF1Chip("").reason, /没有给型号/u);
  assert.match(resolveF1Chip("STM32F103C8Q6").reason, /封装后缀/u);
});

test("resolveF1Chip：没有温度后缀的写法也认（按 chips.json 归一化）", () => {
  const { chip } = resolveF1Chip("STM32F103C8");
  assert.ok(chip);
  assert.equal(chip.cpn, "STM32F103C8T6");
  assert.equal(chip.startup, "startup_stm32f103xb.s");
  assert.equal(chip.pinCount, 48);
});

test("resolveF1Chip：容量档直给（脚本用）与型号给法得到同一结果", () => {
  const byGroup = resolveF1Chip("F103:xb").chip;
  const byCpn = resolveF1Chip("STM32F103C8T6").chip;
  assert.ok(byGroup && byCpn);
  assert.equal(byGroup.cpn, byCpn.cpn);
  assert.equal(byGroup.startup, byCpn.startup);
  assert.equal(byGroup.deviceDefine, byCpn.deviceDefine);
  // 容量档只写档位、不写封装：取该档在资源包里的一个代表型号，引脚数就是那颗的
  assert.equal(byGroup.pinCount, byCpn.pinCount);
});

test("f1GroupsFor：档位从事实聚合（替代原来的 F1_LINES 表）", () => {
  assert.deepEqual(f1GroupsFor("103"), ["x6", "xb", "xe", "xg"]);
  assert.deepEqual(f1GroupsFor("999"), []);
  for (const code of F1_LINE_CODES) {
    const groups = f1GroupsFor(code);
    assert.ok(groups.length > 0, "line " + code + " 应当至少有一档");
    for (const group of groups) {
      const resolved = resolveF1Chip("F" + code + ":" + group);
      assert.ok(resolved.chip, code + " " + group + " → " + resolved.reason);
      assert.equal(resolved.chip.startup, "startup_stm32f" + code + group + ".s");
    }
  }
});

test("F100C8T6：RAM 8K 来自资源包，不再有「取自 db / 未收录」这类兜底口吻", () => {
  const { chip } = resolveF1Chip("STM32F100C8T6");
  assert.ok(chip);
  assert.equal(chip.group, "xb");
  assert.equal(chip.ramBytes, 8 * 1024);
  assert.deepEqual(chip.notes, []);
});

test("F100xE / F101xE：RAM 32K / 48K（同一容量档不同 line 的 RAM 仍不同）", () => {
  const f100 = resolveF1Chip("STM32F100CET6");
  assert.ok(f100.chip);
  assert.equal(f100.chip.group, "xe");
  assert.equal(f100.chip.startup, "startup_stm32f100xe.s");
  assert.equal(f100.chip.deviceDefine, "STM32F100xE");
  assert.equal(f100.chip.flashBytes, 512 * 1024);
  assert.equal(f100.chip.ramBytes, 32 * 1024);
  assert.deepEqual(f100.chip.notes, []);

  const f101 = resolveF1Chip("STM32F101CET6");
  assert.ok(f101.chip);
  assert.equal(f101.chip.group, "xe");
  assert.equal(f101.chip.startup, "startup_stm32f101xe.s");
  assert.equal(f101.chip.flashBytes, 512 * 1024);
  assert.equal(f101.chip.ramBytes, 48 * 1024);
  assert.deepEqual(f101.chip.notes, []);

  assert.equal(f100.chip.group, f101.chip.group);
  assert.notEqual(f100.chip.ramBytes, f101.chip.ramBytes);
});

test("资源包里没收录的型号：返回 chip=null + 人话（不再拿 ramBytes=null 硬凑一颗）", () => {
  for (const mcu of ["STM32F100RCT6", "STM32F101RCT6"]) {
    const { chip, reason } = resolveF1Chip(mcu);
    assert.equal(chip, null, mcu + " 不该再解析出半条事实");
    assert.match(reason, /资源包/u, mcu + " 要说清是资源包没收录");
    assert.match(reason, /stm32_assets refresh/u, mcu + " 要给 refresh 提示");
  }
});

test("没有资源包缓存时：findChipFact=null，requireChipFact 抛结构化错误并提示 refresh", () => {
  const emptyRoot = mkdtempSync(join(tmpdir(), "dsh-stm32-noassets-"));
  const env = { ...process.env, DSH_STM32_ASSETS: emptyRoot };

  assert.equal(deviceFactsSource(env), "none");
  const facts = loadDeviceFacts(env);
  assert.equal(facts.ok, false);
  assert.equal(facts.chips.length, 0);
  assert.match(facts.error, /stm32_assets refresh/u);
  assert.equal(findChipFact("STM32F103C8T6", env), null);

  assert.throws(
    () => requireChipFact("STM32F103C8T6", env),
    (error) => {
      assert.ok(error instanceof DeviceFactError);
      assert.equal(error.code, "facts-missing");
      assert.equal(error.cpn, "STM32F103C8T6");
      assert.match(error.message, /stm32_assets refresh/u);
      assert.match(error.message, /检查网络/u);
      return true;
    },
  );

  // resolveF1Chip 走同一份事实：没缓存就明确失败，不许静默成功
  const previous = process.env.DSH_STM32_ASSETS;
  process.env.DSH_STM32_ASSETS = emptyRoot;
  try {
    const { chip, reason } = resolveF1Chip("STM32F103C8T6");
    assert.equal(chip, null);
    assert.match(reason, /stm32_assets refresh/u);
  } finally {
    process.env.DSH_STM32_ASSETS = previous;
  }
});

test("requireChipFact：缓存里没有这颗时抛 chip-unknown（错误码可分辨）", () => {
  assert.throws(
    () => requireChipFact("STM32F103ZET6"),
    (error) => {
      assert.ok(error instanceof DeviceFactError);
      assert.equal(error.code, "chip-unknown");
      assert.match(error.message, /STM32F103ZET6/u);
      assert.match(error.message, /stm32_assets refresh/u);
      return true;
    },
  );
});

test("本机有固件包时：每个解析出的启动文件都真实存在（无固件包则跳过）", (t) => {
  if (!existsSync(FW_STARTUP)) {
    t.skip("本机没有 F1 固件包");
    return;
  }
  for (const line of F1_LINE_CODES) {
    for (const group of f1GroupsFor(line)) {
      const chip = resolveF1Chip("F" + line + ":" + group).chip;
      assert.ok(chip);
      const startupPath = FW_STARTUP + "/" + chip.startup;
      assert.ok(existsSync(startupPath), "上游没有这个启动文件：" + chip.startup);
      const headerPath = FW_STARTUP.replace("/Source/Templates/gcc", "/Include") + "/" + chip.deviceHeader;
      assert.ok(existsSync(headerPath), "上游没有这个设备头：" + chip.deviceHeader);
    }
  }
});
