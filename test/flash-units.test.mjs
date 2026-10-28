// 单元测试：flash 引擎的纯函数（不连板子）。用 node test\flash-units.test.mjs 跑。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildProgramCommand,
  checkNoDebugGuard,
  errorCodeOfLines,
  findProjectConfig,
  parseFlashLog,
  probeMissingLines,
  resolveElf,
  toOpenOcdPath,
  usbNoteFor,
} from "../lib/engine/flash.js";

import { FIXTURE_PROJECT } from "./fixtures.mjs";

test("toOpenOcdPath 反斜杠转正斜杠（Tcl 会吃掉反斜杠）", () => {
  assert.equal(toOpenOcdPath("D:\\JingYu\\demo\\build\\Debug\\demo.elf"), "D:/JingYu/demo/build/Debug/demo.elf");
});

test("buildProgramCommand 默认带 verify/reset/exit 并给路径加引号", () => {
  assert.equal(
    buildProgramCommand("D:/x y/demo.elf"),
    'program "D:/x y/demo.elf" verify reset exit',
  );
  assert.equal(buildProgramCommand("D:/a.elf", { verify: false }), 'program "D:/a.elf" reset exit');
});

test("parseFlashLog 认出成功序列", () => {
  const log = [
    "Open On-Chip Debugger 0.12.0",
    "Info : CMSIS-DAP: SWD supported",
    "** Programming Started **",
    "Info : device id = 0x20036410",
    "** Programming Finished **",
    "** Verify Started **",
    "** Verified OK **",
    "** Resetting Target **",
    "shutdown command invoked",
  ].join("\n");
  const verdict = parseFlashLog(log);
  assert.equal(verdict.programmed, true);
  assert.equal(verdict.verified, true);
  assert.deepEqual(verdict.errors, []);
});

test("probeMissingLines 认出两类找不到设备的行（2a）", () => {
  const lines = [
    "Error: unable to find a matching CMSIS-DAP device",
    "Error: no device found",
    "Error: Error connecting DP: cannot read IDR",
  ];
  const missing = probeMissingLines(lines);
  assert.equal(missing.length, 2);
  assert.match(missing[0] ?? "", /CMSIS-DAP/u);
});

test("errorCodeOfLines（2d）：常见失败各归各码", () => {
  assert.equal(errorCodeOfLines(["Error: unable to find a matching CMSIS-DAP device"]), "no-probe");
  assert.equal(errorCodeOfLines(["Error: no device found"]), "no-probe");
  assert.equal(errorCodeOfLines(["Error: Error connecting DP: cannot read IDR"]), "swd-locked");
  assert.equal(errorCodeOfLines(["Error: flash programming failed: read protected"]), "flash-protected");
  assert.equal(errorCodeOfLines(["Error: target voltage may be too low"]), "no-power");
  assert.equal(errorCodeOfLines(["Error: unexpected idcode"]), "target-mismatch");
  assert.equal(errorCodeOfLines(["Error: something else entirely"]), "unknown");
});

test("parseFlashLog（2d）：失败时 errorCode 有值，成功时为空串", () => {
  const fail = parseFlashLog(["Info : started", "Error: unable to find a matching CMSIS-DAP device", "** Programming Failed **"].join("\n"));
  assert.equal(fail.errorCode, "no-probe");
  const okLog = parseFlashLog(["** Programming Finished **", "** Verified OK **"].join("\n"));
  assert.equal(okLog.errorCode, "");
});

test("SWD 守卫（2c）：没有 .ioc 时看 openocd.cfg 的 transport——swd 通过、jtag 警告", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-guard-cfg-"));
  try {
    // swd：插件生成的默认形态
    fs.writeFileSync(path.join(root, "openocd.cfg"), "source [find interface/cmsis-dap.cfg]\ntransport select hla_swd\nsource [find target/stm32f1x.cfg]\n");
    const swd = checkNoDebugGuard(root);
    assert.equal(swd.blocked, false);
    assert.ok(swd.notes.some((line) => line.includes("swd")), "swd 通过时要说明依据：" + swd.notes.join(" | "));

    // jtag：换探针形态后给警告
    fs.writeFileSync(path.join(root, "openocd.cfg"), "source [find interface/jlink.cfg]\ntransport select jtag\n");
    const jtag = checkNoDebugGuard(root);
    assert.equal(jtag.blocked, false);
    assert.ok(jtag.notes.some((line) => line.includes("jtag")), "jtag 要给出 PA13/PA14 复用提醒：" + jtag.notes.join(" | "));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("usbNoteFor：unknown 静默、其余以 USB 形态前缀呈现（2a）", () => {
  assert.equal(usbNoteFor("unknown", "诊断失败"), null);
  assert.match(usbNoteFor("no-usb", "这台机器没有 USB"), /USB 形态：/u);
  assert.match(usbNoteFor("no-dap", "没插好"), /USB 形态：/u);
});

test("errorCodeOfLines：两个 openocd 抢同一个 CMSIS-DAP 归到 probe-busy（真板子取证）", () => {
  // 下面是 2026-10-28 在蓝丸 + CMSIS-DAP 上真抓到的日志（两个 openocd 同时访问探针）。
  const log = [
    "Error: CMSIS-DAP command CMD_DISCONNECT failed.",
    "Error: CMSIS-DAP command mismatch. Sent 0x12 received 0x2",
    "Error: CMSIS-DAP transfer count mismatch: expected 5, got 1",
    "Error: Failed to write memory at 0x00000004",
  ];
  assert.equal(errorCodeOfLines(log), "probe-busy");
  assert.equal(errorCodeOfLines(["libusb_error_busy"]), "probe-busy");
});

test("parseFlashLog 挑出连不上 DP 的错误并去重", () => {
  const log = [
    "Info : CMSIS-DAP: Interface ready",
    "Error: Error connecting DP: cannot read IDR",
    "Error: Error connecting DP: cannot read IDR",
    "** Programming Failed **",
  ].join("\n");
  const verdict = parseFlashLog(log);
  assert.equal(verdict.programmed, false);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.errors.length, 2);
  assert.match(verdict.errors[0] ?? "", /Error connecting DP/u);
});

test("findProjectConfig 优先显式路径，其次 openocd.cfg", () => {
  const projectDir = FIXTURE_PROJECT;
  const found = findProjectConfig(projectDir);
  assert.ok(found !== null && found.endsWith("openocd.cfg"), String(found));
  assert.equal(findProjectConfig(projectDir, "nope.cfg"), null);
});

test("resolveElf 从构建目录推断出 .elf，显式不存在时报错", () => {
  const projectDir = FIXTURE_PROJECT;
  const resolved = resolveElf(projectDir, { projectDir });
  assert.ok(resolved.elf !== null && resolved.elf.endsWith("demo.elf"), String(resolved.elf));
  const missing = resolveElf(projectDir, { projectDir, elfPath: "build/Debug/none.elf" });
  assert.equal(missing.elf, null);
  assert.match(missing.note, /不存在/u);
});

test("checkNoDebugGuard：找不到唯一 .ioc 时明确说守卫没生效（审计 A6）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-flash-guard-"));
  const none = checkNoDebugGuard(dir);
  assert.equal(none.blocked, false, "没有 .ioc 时不拦，但必须说清楚");
  assert.equal(none.notes.length, 2);
  assert.match(none.notes[0] ?? "", /SWD 守卫没生效/u);
  assert.match(none.notes[0] ?? "", /没有 .ioc/u);
  assert.match(none.notes[1] ?? "", /iocPath/u);

  fs.writeFileSync(path.join(dir, "demo.ioc"), "");
  fs.writeFileSync(path.join(dir, "demo_backup.ioc"), "");
  const multi = checkNoDebugGuard(dir);
  assert.equal(multi.blocked, false);
  assert.match(multi.notes[0] ?? "", /2 个 .ioc/u);
  assert.match(multi.notes[0] ?? "", /demo.ioc/u);

  const explicit = checkNoDebugGuard(dir, false, "nope.ioc");
  assert.match(explicit.notes[0] ?? "", /指定的 .ioc 不存在/u);

  const allowed = checkNoDebugGuard(dir, true);
  assert.deepEqual(allowed, { blocked: false, errors: [], notes: [] });
});

test("模板 openocd.cfg 用 transport select swd，不能是 hla_swd（真板子回归）", () => {
  // 2c 第一版模板写的是 hla_swd，CMSIS-DAP 上 openocd 直接报
  // 「Debug adapter doesn't support 'hla_swd' transport」——寄存器工程一律烧不进去。
  const cfg = fs.readFileSync(new URL("../templates/scaffold/openocd.cfg", import.meta.url), "utf8");
  assert.match(cfg, /transport\s+select\s+swd\b/u);
  // 注释里可以解释为什么不能用 hla_swd，但生效行不许出现。
  assert.doesNotMatch(cfg, /^\s*transport\s+select\s+hla_swd\s*$/mu, "hla_swd 只有 st-link 系适配器支持");
  assert.match(cfg, /interface\/cmsis-dap\.cfg/u);
  assert.match(cfg, /target\/stm32f1x\.cfg/u);
  // 守卫读到这份配置时要说「swd，不会关调试口」，而不是「没有 transport select」。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-flash-tpl-"));
  fs.writeFileSync(path.join(dir, "openocd.cfg"), cfg);
  const guard = checkNoDebugGuard(dir);
  assert.equal(guard.blocked, false);
  assert.match(guard.notes.join("\n"), /transport 是 swd/u);
});

test("parseFlashLog：成功序列齐全时 Error: 行进 noise，不判失败（审计 A25）", () => {
  // openocd 在成功路径上也会打 Error: 前缀的行（无效 ACK 之类），原来一律判失败。
  const okLog = [
    "Info : device id = 0x20036410",
    "Error: invalid ack received",
    "** Programming Started **",
    "** Programming Finished **",
    "** Verified OK **",
    "** Resetting Target **",
  ].join("\n");
  const verdict = parseFlashLog(okLog);
  assert.equal(verdict.programmed, true);
  assert.equal(verdict.verified, true);
  assert.deepEqual(verdict.errors, []);
  assert.equal(verdict.noise.length, 1);

  const failLog = ["** Programming Started **", "Error: flash write failed", "** Programming Failed **"].join("\n");
  const failed = parseFlashLog(failLog);
  assert.equal(failed.programmed, false);
  assert.equal(failed.errors.length > 0, true);
  assert.deepEqual(failed.noise, []);
});
