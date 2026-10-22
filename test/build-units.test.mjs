// 编译引擎单测：node test/build-units.test.mjs
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { countWarnings, detectBuildDir, findElf, parseBuildErrors, parseMemoryUsage } from "../lib/engine/build.js";

import { FIXTURE_PROJECT as DEMO } from "./fixtures.mjs";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test("parseMemoryUsage 解析 ld --print-memory-usage 表格", () => {
  const text = [
    "Memory region         Used Size  Region Size  %age Used",
    "             RAM:        1584 B        20 KB      7.73%",
    "          FLASH:        4716 B        64 KB      7.20%",
  ].join("\n");
  const usages = parseMemoryUsage(text);
  assert.equal(usages.length, 2);
  assert.deepEqual(usages.map((item) => item.region), ["RAM", "FLASH"]);
  assert.equal(usages[0].usedBytes, 1584);
  assert.equal(usages[0].totalBytes, 20480);
  assert.equal(usages[0].percent, 7.73);
  assert.equal(usages[1].totalBytes, 65536);
});

test("parseBuildErrors 挑出 gcc/ld/cmake/ninja 错误并去重", () => {
  const text = [
    "C:/p/Core/Src/main.c:12:5: error: 'foo' undeclared (first use in this function)",
    "C:/p/Core/Src/main.c:12:5: error: 'foo' undeclared (first use in this function)",
    "core/Src/main.c:20: undefined reference to `HAL_Bar'",
    "collect2.exe: error: ld returned 1 exit status",
    "ninja: build stopped: subcommand failed.",
    "C:/p/Core/Src/main.c:9:3: warning: unused variable 'x'",
    "[2/19] Building C object CMakeFiles/demo.elf.dir/Core/Src/gpio.c.obj",
  ].join("\n");
  const errors = parseBuildErrors(text);
  // gcc 错误（重复行去重后 1 条）+ undefined reference + collect2 + ninja 停止 = 4
  assert.equal(errors.length, 4);
  assert.match(errors[0], /main\.c:12:5: error/);
  assert.equal(countWarnings(text), 1);
});

test("detectBuildDir 命中 demo 的 build/Debug", () => {
  const dir = detectBuildDir(DEMO);
  assert.equal(dir !== null, true);
  assert.match(dir.replace(/\\/g, "/"), /build\/Debug$/);
  assert.equal(existsSync(dir + "/CMakeCache.txt"), true);
});

test("findElf 找到与构建目录同名的 .elf", () => {
  const dir = detectBuildDir(DEMO);
  const elf = findElf(dir);
  assert.equal(elf !== null, true);
  assert.match(elf.path.replace(/\\/g, "/"), /build\/Debug\/demo\.elf$/);
  assert.equal(elf.size > 1000, true);
});

test("不存在的目录：detectBuildDir/findElf 返回 null", () => {
  assert.equal(detectBuildDir("D:/definitely-not-here"), null);
  assert.equal(findElf("D:/definitely-not-here"), null);
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
