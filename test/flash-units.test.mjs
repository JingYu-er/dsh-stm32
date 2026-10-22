// 单元测试：flash 引擎的纯函数（不连板子）。用 node test\flash-units.test.mjs 跑。
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildProgramCommand, findProjectConfig, parseFlashLog, resolveElf, toOpenOcdPath } from "../lib/engine/flash.js";

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
