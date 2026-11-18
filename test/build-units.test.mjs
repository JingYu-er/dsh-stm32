// 编译引擎单测：node test/build-units.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearCmakeCache, countWarnings, detectBuildDir, findElf, inspectCmakeCache, parseBerkeleySize, parseBuildErrors, parseMemoryUsage, runBuild } from "../lib/engine/build.js";

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

test("parseBerkeleySize：增量构建时量 elf 的 text/data/bss（S80）", () => {
  const text = [
    "   text\t   data\t    bss\t    dec\t    hex\tfilename",
    "   3852\t    984\t   1584\t   6420\t   1914\tdemo.elf",
  ].join("\n");
  assert.deepEqual(parseBerkeleySize(text), { text: 3852, data: 984, bss: 1584 });
  assert.equal(parseBerkeleySize("no numbers here"), null, "认不出就给 null");
  assert.equal(parseBerkeleySize(""), null);
});


// 无改动构建：链接器没输出占用时，用 arm-none-eabi-size 补一次，并在 notes 里说明来源（S80/S80-fix）。
function fakeNoopSubprocess(sizeStdout) {
  return {
    resolveExecutable: async (name) => "C:/fake/" + name + ".exe",
    spawn(spec) {
      const isSize = spec.argv.some((item) => String(item).includes("arm-none-eabi-size"));
      const text = isSize ? sizeStdout : "ninja: no work to do.\n";
      return {
        collected: {
          stdout: { readFrom: () => ({ text, nextOffset: text.length }) },
          stderr: { readFrom: () => ({ text: "", nextOffset: 0 }) },
        },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {},
        waitForExit: () => Promise.resolve({ exitCode: 0, signal: null }),
      };
    },
  };
}

test("runBuild：无改动构建时用 size 量 elf，并在 notes 说明来源（S80）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "build-size-"));
  mkdirSync(join(dir, "build", "Debug"), { recursive: true });
  writeFileSync(join(dir, "demo.ioc"), "Mcu.CPN=STM32F103C8T6\n", "utf8");
  writeFileSync(
    join(dir, "build", "Debug", "CMakeCache.txt"),
    "CMAKE_PROJECT_NAME:STATIC=demo\nCMAKE_BUILD_TYPE:STRING=Debug\n",
    "utf8",
  );
  writeFileSync(join(dir, "build", "Debug", "demo.elf"), "ELF", "utf8");

  const report = await runBuild({
    subprocess: fakeNoopSubprocess("   text\t   data\t    bss\t    dec\t    hex\tfilename\n   3852\t    984\t   1584\t   6420\t   1914\tdemo.elf\n"),
    projectDir: dir,
    env: {},
    binDirs: ["C:/fake/bin"],
  });
  assert.equal(report.ok, true, "构建应成功");
  assert.equal(report.memoryUsage.length, 2, "缺链接器输出时也要有占用");
  assert.equal(report.memoryUsage[0].region, "FLASH");
  assert.equal(report.memoryUsage[0].usedBytes, 4836, "FLASH = text + data");
  assert.equal(report.memoryUsage[1].usedBytes, 2568, "RAM = data + bss");
  assert.ok(report.notes.some((note) => note.includes("arm-none-eabi-size")), "notes 要说明占用是量出来的");
  assert.ok(report.notes.some((note) => note.includes("没有重新链接")), "notes 要说明本次没链接");
});


test("CMakeCache 与工程目录对不上时报出来（S191）", () => {
  const cache = [
    "# This is the CMakeCache file.",
    "CMAKE_HOME_DIRECTORY:INTERNAL=D:/old/place/demo",
    "CMAKE_C_COMPILER:FILEPATH=C:/msys64/ucrt64/bin/arm-none-eabi-gcc.exe",
    "CMAKE_MAKE_PROGRAM:FILEPATH=C:/msys64/ucrt64/bin/ninja.exe",
    "CMAKE_GENERATOR:INTERNAL=Ninja",
  ].join("\r\n");
  const okTool = (file) => file.endsWith("CMakeCache.txt") || file.endsWith("arm-none-eabi-gcc.exe") || file.endsWith("ninja.exe");
  const stale = inspectCmakeCache("D:/build/Debug", "D:/new/place/demo", {
    readText: () => cache,
    fileExists: okTool,
  });
  assert.equal(stale.present, true);
  assert.equal(stale.issues.length, 1, "只应报源码目录不一致");
  assert.match(stale.issues[0], /D:\/old\/place\/demo/u);

  const sameDir = inspectCmakeCache("D:/build/Debug", "d:/old/place/demo/", {
    readText: () => cache,
    fileExists: okTool,
  });
  assert.deepEqual(sameDir.issues, [], "大小写与末尾斜杠不该算不一致");

  const deadCompiler = inspectCmakeCache("D:/build/Debug", "D:/old/place/demo", {
    readText: () => cache,
    fileExists: (file) => file.endsWith("CMakeCache.txt"),
  });
  assert.equal(deadCompiler.issues.length, 2, "编译器与构建器都不存在");
  assert.ok(deadCompiler.issues.some((note) => note.includes("编译器不存在")));
});

test("没有 CMakeCache.txt 时不报问题，清缓存只删缓存相关项（S191）", () => {
  const none = inspectCmakeCache("D:/build/Debug", "D:/demo", { fileExists: () => false });
  assert.deepEqual(none, { present: false, issues: [] });

  const dir = mkdtempSync(join(tmpdir(), "dsh-stm32-cache-"));
  mkdirSync(join(dir, "CMakeFiles"), { recursive: true });
  writeFileSync(join(dir, "CMakeCache.txt"), "CMAKE_HOME_DIRECTORY:INTERNAL=D:/old\n", "utf8");
  writeFileSync(join(dir, "build.ninja"), "# keep\n", "utf8");
  const removed = clearCmakeCache(dir);
  assert.deepEqual(removed.sort(), ["CMakeCache.txt", "CMakeFiles"]);
  assert.equal(existsSync(join(dir, "CMakeCache.txt")), false);
  assert.equal(existsSync(join(dir, "build.ninja")), true, "别的文件不该被删");
  assert.deepEqual(clearCmakeCache(dir), [], "已经清干净后再清不报错");
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
