import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { resolveF1Chip, F1_LINES, f1GroupsFor } from "../lib/data/stm32f1.js";

const FW_STARTUP = "D:/app/STM32CubeMX/Repository/STM32Cube_FW_F1_V1.8.7/Drivers/CMSIS/Device/ST/STM32F1xx/Source/Templates/gcc";

test("resolveF1Chip：蓝丸 C8T6 与已有 chips.ts 的事实一致", () => {
  const { chip, reason } = resolveF1Chip("STM32F103C8T6");
  assert.equal(reason, "");
  assert.ok(chip);
  assert.equal(chip.prefix, "STM32F103");
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

test("resolveF1Chip：该 line 不存在的容量档要明确拒绝", () => {
  const f107xb = resolveF1Chip("STM32F107RBT6");
  assert.equal(f107xb.chip, null);
  assert.match(f107xb.reason, /没有 xb 这一容量档/u);
  const f102xe = resolveF1Chip("STM32F102CET6");
  assert.equal(f102xe.chip, null);
  assert.match(f102xe.reason, /没有 xe/u);
});

test("resolveF1Chip：未知 line / 坏格式 / 空输入都返回原因", () => {
  assert.match(resolveF1Chip("STM32F109C8T6").reason, /没有 F109/u);
  assert.match(resolveF1Chip("ATMEGA328").reason, /不是 F1 的型号格式/u);
  assert.match(resolveF1Chip("").reason, /没有给型号/u);
  assert.match(resolveF1Chip("STM32F103C8Q6").reason, /封装后缀/u);
});

test("resolveF1Chip：没有温度后缀的写法也认", () => {
  const { chip } = resolveF1Chip("STM32F103C8");
  assert.ok(chip);
  assert.equal(chip.startup, "startup_stm32f103xb.s");
  assert.equal(chip.pinCount, 48);
});

test("resolveF1Chip：容量档直给（脚本用）与型号给法得到同一结果", () => {
  const byGroup = resolveF1Chip("F103:xb").chip;
  const byCpn = resolveF1Chip("STM32F103C8T6").chip;
  assert.ok(byGroup && byCpn);
  assert.equal(byGroup.startup, byCpn.startup);
  assert.equal(byGroup.deviceDefine, byCpn.deviceDefine);
  assert.equal(byGroup.pinCount, null);
});

test("F1_LINES：每条 line 的档位都能反推回启动文件名，且 F1 共 6 个 line", () => {
  assert.equal(F1_LINES.length, 6);
  for (const line of F1_LINES) {
    assert.ok(line.groups.length > 0, line.code);
    for (const group of line.groups) {
      const resolved = resolveF1Chip("F" + line.code + ":" + group);
      assert.ok(resolved.chip, line.code + " " + group + " → " + resolved.reason);
      assert.equal(resolved.chip.startup, "startup_" + line.prefix.toLowerCase() + group + ".s");
    }
  }
  assert.deepEqual(f1GroupsFor("103"), ["x6", "xb", "xe", "xg"]);
  assert.deepEqual(f1GroupsFor("999"), []);
});

test("RAM 未收录时必须给 note 而不是编数字", () => {
  const { chip } = resolveF1Chip("STM32F100C8T6");
  assert.ok(chip);
  assert.equal(chip.group, "xb");
  assert.equal(chip.ramBytes, null);
  assert.equal(chip.notes.length, 1);
  assert.match(chip.notes[0], /RAM 大小未收录/u);
});

test("本机有固件包时：每个解析出的启动文件都真实存在（无固件包则跳过）", (t) => {
  if (!existsSync(FW_STARTUP)) {
    t.skip("本机没有 F1 固件包");
    return;
  }
  for (const line of F1_LINES) {
    for (const group of line.groups) {
      const chip = resolveF1Chip("F" + line.code + ":" + group).chip;
      assert.ok(chip);
      const path = FW_STARTUP + "/" + chip.startup;
      assert.ok(existsSync(path), "上游没有这个启动文件：" + chip.startup);
      const headerPath = FW_STARTUP.replace("/Source/Templates/gcc", "/Include") + "/" + chip.deviceHeader;
      assert.ok(existsSync(headerPath), "上游没有这个设备头：" + chip.deviceHeader);
    }
  }
});
