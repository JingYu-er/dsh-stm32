// 工程导出（stm32_project_export）的离线单测：node test/export-units.test.mjs
//
// 两条铁律的守卫：build/ 绝不进包（CMakeCache.txt 里是本机绝对路径）；"能烧"与"能改"分开。
// zip 写入器自己写的（零依赖），所以这里既验报告字段，也验真落盘的 zip 能被自己读回来。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

import { runExport } from "../lib/engine/project-export.js";
import { crc32, listZipEntries } from "../lib/engine/zip.js";
import { registerProjectExport } from "../lib/tools/project-export.js";

const roots = [];
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** 造一个假工程：既有该进包的源文件，也有四类必须被排除的目录。 */
function makeProject(name) {
  const base = mkdtempSync(join(tmpdir(), "dsh-stm32-export-"));
  roots.push(base);
  const projectDir = join(base, name);
  mkdirSync(join(projectDir, "Core", "Src"), { recursive: true });
  writeFileSync(join(projectDir, "Core", "Src", "main.c"), "int main(void) { return 0; }\n");
  writeFileSync(join(projectDir, "CMakeLists.txt"), "project(demo C)\n");
  mkdirSync(join(projectDir, ".vscode"), { recursive: true });
  writeFileSync(join(projectDir, ".vscode", "settings.json"), "{}\n");
  // 四类必须排除的目录
  mkdirSync(join(projectDir, "build", "Debug"), { recursive: true });
  writeFileSync(join(projectDir, "build", "Debug", "CMakeCache.txt"), "CMAKE_HOME_DIRECTORY=D:/someone/else\n");
  mkdirSync(join(projectDir, ".dsh-stm32", "backups"), { recursive: true });
  writeFileSync(join(projectDir, ".dsh-stm32", "backups", "old.txt"), "backup\n");
  mkdirSync(join(projectDir, "node_modules", "z"), { recursive: true });
  writeFileSync(join(projectDir, "node_modules", "z", "i.js"), "x\n");
  mkdirSync(join(projectDir, ".git"), { recursive: true });
  writeFileSync(join(projectDir, ".git", "HEAD"), "ref: refs/heads/main\n");
  return projectDir;
}

function writeElf(projectDir) {
  const buildDir = join(projectDir, "build", "Debug");
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(join(buildDir, "CMakeCache.txt"), "x\n");
  writeFileSync(join(buildDir, "demo.elf"), Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(96, 0x2e)]));
  writeFileSync(join(buildDir, "demo.hex"), ":00000001FF\n");
}

/** 收集注入的 zipImpl 看到了哪些条目。 */
function captureZip() {
  const seen = { outPath: "", sources: null };
  const zipImpl = async (outPath, sources) => {
    seen.outPath = outPath;
    seen.sources = sources;
    writeFileSync(outPath, "fake-zip");
  };
  return { seen, zipImpl };
}

test("默认排除 build/、.dsh-stm32/、node_modules/、.git/，并写内联 README", async () => {
  const projectDir = makeProject("demo");
  const { seen, zipImpl } = captureZip();
  const report = await runExport({ projectDir, zipImpl });
  assert.equal(report.ok, true, report.message);
  assert.deepEqual([...seen.sources.keys()].sort(), [
    ".vscode/settings.json",
    "CMakeLists.txt",
    "Core/Src/main.c",
    "README.md",
  ]);
  assert.equal(report.fileCount, 4);
  assert.equal(report.zipPath, resolve(join(projectDir, ".."), "demo-export.zip"));
  assert.equal(seen.outPath, report.zipPath);
  // README 是内联内容（__inline__ 前缀），不指向磁盘文件
  const readme = seen.sources.get("README.md");
  assert.match(readme, /^__inline__\n# demo\n/u);
  assert.match(readme, /拿到就能改/u);
  assert.match(readme, /build\/ 不在包里是有意的/u);
  assert.ok(report.notes.some((note) => note.includes("build/") && note.includes("绝对路径")), "notes 要说清 build/ 为什么被排除：" + report.notes.join(" | "));
  assert.equal(report.zipBytes, "fake-zip".length);
});

test("readme:false 时不写包内 README", async () => {
  const projectDir = makeProject("demo");
  const { seen, zipImpl } = captureZip();
  const report = await runExport({ projectDir, zipImpl, readme: false });
  assert.equal(report.ok, true, report.message);
  assert.equal(seen.sources.has("README.md"), false);
  assert.equal(report.fileCount, 3);
});

test("includePrebuilt 把 elf/hex 拷进 prebuilt/，README 写清怎么烧", async () => {
  const projectDir = makeProject("demo");
  writeElf(projectDir);
  const { seen, zipImpl } = captureZip();
  const report = await runExport({ projectDir, zipImpl, includePrebuilt: true });
  assert.equal(report.ok, true, report.message);
  assert.deepEqual([...seen.sources.keys()].sort(), [
    ".vscode/settings.json",
    "CMakeLists.txt",
    "Core/Src/main.c",
    "README.md",
    "prebuilt/demo.elf",
    "prebuilt/demo.hex",
  ]);
  assert.deepEqual(report.prebuilt.map((item) => item.path.split(/[\\/]/u).pop()).sort(), ["demo.elf", "demo.hex"]);
  const readme = seen.sources.get("README.md");
  assert.match(readme, /拿到就能烧/u);
  assert.match(readme, /prebuilt\/demo\.elf/u);
});

test("要 prebuilt 但构建目录里没有 elf：不报错，但 notes 教先编译", async () => {
  const projectDir = makeProject("demo");
  const { zipImpl } = captureZip();
  const report = await runExport({ projectDir, zipImpl, includePrebuilt: true });
  assert.equal(report.ok, true, report.message);
  assert.equal(report.prebuilt.length, 0);
  assert.ok(report.notes.some((note) => note.includes("没有 .elf")), "要提示先 stm32_build：" + report.notes.join(" | "));
});

test("真写 zip：能被自己读回来，内容按 store 原样落盘", async () => {
  const projectDir = makeProject("demo");
  const report = await runExport({ projectDir });
  assert.equal(report.ok, true, report.message);
  assert.equal(existsSync(report.zipPath), true);
  const buffer = readFileSync(report.zipPath);
  assert.equal(report.zipBytes, buffer.length);
  const names = listZipEntries(buffer);
  assert.deepEqual([...names].sort(), [".vscode/settings.json", "CMakeLists.txt", "Core/Src/main.c", "README.md"]);
  // store 不压缩：源文件字节应当原样出现在 zip 里
  assert.equal(buffer.includes(Buffer.from("int main(void) { return 0; }", "utf8")), true);
  assert.equal(buffer.includes(Buffer.from("CMAKE_HOME_DIRECTORY", "utf8")), false, "build/ 的内容不该出现在包里");
});

test("crc32 对得上已知值（zip 校验和的底线）", () => {
  assert.equal(crc32(Buffer.from("", "utf8")), 0);
  assert.equal(crc32(Buffer.from("hello", "utf8")), 0x3610a686);
});

test("已取消：不写 zip，报告里说明白", async () => {
  const projectDir = makeProject("demo");
  const controller = new AbortController();
  controller.abort();
  const { seen, zipImpl } = captureZip();
  const report = await runExport({ projectDir, zipImpl, signal: controller.signal });
  assert.equal(report.ok, false);
  assert.match(report.message, /取消/u);
  assert.equal(seen.outPath, "", "取消后不该走到打包");
});

test("工程目录不存在：干净失败，不抛异常", async () => {
  const report = await runExport({ projectDir: join(tmpdir(), "dsh-stm32-export-not-here-" + String(Date.now())) });
  assert.equal(report.ok, false);
  assert.match(report.message, /工程目录不存在/u);
  assert.equal(report.zipBytes, 0);
});

test("工具层：注册名与输出形状与 schema 一致", async () => {
  const projectDir = makeProject("demo");
  const definitions = new Map();
  const ctx = {
    tools: { register: (definition) => { definitions.set(definition.name, definition); return () => {}; } },
    get() { return undefined; },
  };
  registerProjectExport(ctx);
  const definition = definitions.get("stm32_project_export");
  assert.ok(definition, "应当注册 stm32_project_export");
  const value = await definition.execute({ projectDir, includePrebuilt: false }, { signal: new AbortController().signal });
  assert.equal(value.report.ok, true, value.message);
  assert.deepEqual(Object.keys(value).sort(), ["message", "report"]);
  for (const key of definition.output.schema.required) assert.ok(key in value, "缺字段 " + key);
  for (const key of definition.output.schema.properties.report.required) {
    assert.equal(key in value.report, true, "report 缺字段 " + key);
    assert.equal(value.report[key] === null || value.report[key] === undefined, false, "report." + key + " 不能是 null/undefined");
  }
  // 宿主按 lossless JSON 校验：报告必须能原样序列化回去
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
  const rendered = definition.output.render({}, value);
  assert.match(rendered[0].text, /导出完成/u);
});
