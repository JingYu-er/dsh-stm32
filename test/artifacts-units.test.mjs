import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ARTIFACT_HASH_MAX_BYTES, hasBuildDir, readArtifacts } from "../lib/engine/artifacts.js";

const IOC_TEXT = [
  "#MicroXplorer Configuration settings - do not modify",
  "Mcu.CPN=STM32F103C8T6",
  "Mcu.Family=STM32F1",
  "Mcu.Package=LQFP48",
].join("\n");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 造一个「已配置、已构建」的工程：build/Debug 下 CMakeCache.txt 与产物。 */
function projectWithArtifacts(options = {}) {
  const dir = tempDir("artifacts-");
  fs.writeFileSync(path.join(dir, "demo.ioc"), IOC_TEXT, "utf8");
  const buildDir = path.join(dir, "build", "Debug");
  fs.mkdirSync(buildDir, { recursive: true });
  const projectName = options.projectName ?? "demo";
  fs.writeFileSync(
    path.join(buildDir, "CMakeCache.txt"),
    "CMAKE_PROJECT_NAME:STATIC=" + projectName + "\n",
    "utf8",
  );
  const elf = path.join(buildDir, projectName + ".elf");
  fs.writeFileSync(elf, Buffer.alloc(options.elfBytes ?? 4836));
  if (options.hex !== false) fs.writeFileSync(path.join(buildDir, projectName + ".hex"), "hex");
  if (options.bin !== false) fs.writeFileSync(path.join(buildDir, projectName + ".bin"), Buffer.alloc(1024));
  for (const extra of options.extraElves ?? []) {
    fs.writeFileSync(path.join(buildDir, extra), Buffer.alloc(16));
  }
  return { dir, buildDir, elf };
}

test("readArtifacts：elf 与同名 hex/bin、芯片容量、无提示", () => {
  const { dir, buildDir, elf } = projectWithArtifacts();
  const read = readArtifacts(dir);
  assert.equal(read.ok, true);
  const report = read.report;
  assert.equal(report.buildDir, buildDir);
  assert.equal(report.elf.path, elf);
  assert.equal(report.elf.size, 4836);
  assert.equal(report.hex.name, "demo.hex");
  assert.equal(report.bin.size, 1024);
  assert.equal(report.otherElves.length, 0);
  assert.equal(report.chip.cpn, "STM32F103C8T6");
  assert.equal(report.chip.flashBytes, 65536, "F103C8 的 Flash 是 64 KB");
  assert.equal(report.chip.ramBytes, 20480, "F103C8 的 RAM 是 20 KB");
  assert.match(report.sha256, /^[0-9a-f]{64}$/u, "elf 很小，应给完整 SHA-256");
  assert.deepEqual(report.notes, []);
});

test("readArtifacts：缺 hex/bin 时给 null，不编造文件", () => {
  const { dir } = projectWithArtifacts({ hex: false, bin: false });
  const read = readArtifacts(dir);
  assert.equal(read.ok, true);
  assert.equal(read.report.hex, null);
  assert.equal(read.report.bin, null);
  assert.equal(read.report.elf === null, false);
});

test("readArtifacts：多个 elf 时列 others，并提示只显示一个", () => {
  const { dir } = projectWithArtifacts({ extraElves: ["other.elf"] });
  const read = readArtifacts(dir);
  assert.equal(read.ok, true);
  assert.equal(read.report.otherElves.length, 1);
  assert.equal(read.report.otherElves[0].name, "other.elf");
  assert.equal(read.report.notes.some((note) => note.includes("2 个 .elf")), true, "应提示 elf 数量");
});

test("readArtifacts：没有构建目录时 notes 说明下一步，elf 为 null", () => {
  const dir = tempDir("artifacts-empty-");
  fs.writeFileSync(path.join(dir, "demo.ioc"), IOC_TEXT, "utf8");
  const read = readArtifacts(dir);
  assert.equal(read.ok, true);
  assert.equal(read.report.buildDir, "");
  assert.equal(read.report.elf, null);
  assert.equal(hasBuildDir(dir), false);
  assert.equal(read.report.notes.some((note) => note.includes("stm32_build")), true);
  assert.equal(read.report.sha256, "", "没有 elf 时校验和为空串");
});

test("readArtifacts：elf 超过上限时不算校验和，并在 notes 说明", () => {
  const { dir, elf } = projectWithArtifacts();
  fs.writeFileSync(elf, Buffer.alloc(ARTIFACT_HASH_MAX_BYTES + 1));
  const read = readArtifacts(dir);
  assert.equal(read.ok, true);
  assert.equal(read.report.sha256, "");
  assert.equal(read.report.notes.some((note) => note.includes("跳过校验和")), true, "要说清为什么没有校验和");
});

test("readArtifacts：没有 .ioc 时 chip 为 null 并说明原因；空目录名报错", () => {
  const dir = tempDir("artifacts-noioc-");
  const read = readArtifacts(dir);
  assert.equal(read.ok, true);
  assert.equal(read.report.chip, null);
  assert.equal(read.report.notes.some((note) => note.includes(".ioc")), true);
  assert.deepEqual(readArtifacts("  "), { ok: false, error: "projectDir 不能为空" });
});
