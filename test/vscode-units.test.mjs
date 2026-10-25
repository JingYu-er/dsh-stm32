// 单元测试：模板占位符填充（审计 B1/B6）与子进程 PATH 注入（审计 B4）。
// 跑法：node test\vscode-units.test.mjs
//
// 为什么单开一个套件：这两块的错法是"在开发机上看不出来"——
// 开发机的 gdb/cmake 都在 PATH 里、模板里的 D:/app 路径也刚好有效，
// 换台机器才会炸。所以这里直接钉住"模板里不许有开发机路径"和"探测不到就删行"。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { envWithBinDirs, toolSearchDirs } from "../lib/engine/tool-env.js";
import {
  VSCODE_PLACEHOLDERS,
  describeDroppedPlaceholder,
  detectVscodeFill,
  fillVscodeTemplate,
} from "../lib/engine/vscode-config.js";

const TEMPLATE_VSCODE = fileURLToPath(new URL("../templates/scaffold/vscode/", import.meta.url));

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-stm32-" + tag + "-"));
}

/** JSONC → JSON：去掉整行注释与行尾 // 注释（模板里只有这两种）。 */
function stripJsonc(text) {
  return text
    .split(/\r?\n/u)
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//")) return "";
      const at = line.indexOf("//");
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");
}

test("模板里的 .vscode 不再带开发机绝对路径（B1）", () => {
  const files = fs.readdirSync(TEMPLATE_VSCODE).filter((name) => name.endsWith(".json"));
  assert.ok(files.length >= 2, "至少要有 launch.json 与 settings.json");
  for (const name of files) {
    const text = fs.readFileSync(path.join(TEMPLATE_VSCODE, name), "utf8");
    assert.ok(!/D:\/(app|JingYu)/u.test(text), name + " 里还有开发机路径");
    assert.ok(!/C:\/Users\//u.test(text), name + " 里还有用户目录路径");
  }
  const launch = fs.readFileSync(path.join(TEMPLATE_VSCODE, "launch.json"), "utf8");
  assert.ok(launch.includes(VSCODE_PLACEHOLDERS.gdb), "launch.json 要留 gdb 占位符");
  assert.ok(launch.includes(VSCODE_PLACEHOLDERS.toolchain), "launch.json 要留工具链目录占位符");
  assert.ok(!launch.includes("svdPath\": \"D:"), "不该再写死某个人的 SVD 路径");
});

test("模板的 settings.json 解绑 ST 官方扩展（B6）", () => {
  const settings = fs.readFileSync(path.join(TEMPLATE_VSCODE, "settings.json"), "utf8");
  assert.ok(settings.includes(VSCODE_PLACEHOLDERS.cmake), "cmake 路径要留占位符");
  assert.ok(!settings.includes("cube-cmake"), "不该依赖 ST 的 cube-cmake 包装器");
  assert.ok(!settings.includes("CUBE_BUNDLE_PATH"), "不该依赖 ST 扩展的 CUBE_BUNDLE_PATH");
  assert.ok(!settings.includes("stm32cube-ide-clangd"), "不该绑死 ST 的 clangd 扩展");
  assert.doesNotThrow(() => JSON.parse(stripJsonc(settings)), "去掉注释后要是合法 JSON");
});

test("detectVscodeFill：binDirs 里找到 gdb 与 cmake，工具链目录取 gdb 所在目录", () => {
  const bin = tempDir("vscode-fill");
  try {
    fs.writeFileSync(path.join(bin, "gdb-multiarch.exe"), "");
    fs.writeFileSync(path.join(bin, "cmake.exe"), "");
    const fill = detectVscodeFill([bin], {});
    assert.equal(fill.gdbPath, path.join(bin, "gdb-multiarch.exe"));
    assert.equal(fill.armToolchainPath, bin);
    assert.equal(fill.cmakePath, path.join(bin, "cmake.exe"));
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("detectVscodeFill：binDirs 没有时从 PATH 兜底；都没有就是空串（不编路径）", () => {
  const bin = tempDir("vscode-path");
  try {
    fs.writeFileSync(path.join(bin, "arm-none-eabi-gdb.exe"), "");
    // 用大写 Path：Windows 上进程 env 的键名不固定，要都能认。
    const fromPath = detectVscodeFill([], { Path: bin });
    assert.equal(fromPath.gdbPath, path.join(bin, "arm-none-eabi-gdb.exe"));
    assert.equal(fromPath.cmakePath, "", "PATH 里没有 cmake 就该是空串");
    const none = detectVscodeFill([], {});
    assert.deepEqual(none, { gdbPath: "", armToolchainPath: "", cmakePath: "" });
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("fillVscodeTemplate：填得上就不留占位符，整份仍是合法 JSONC", () => {
  const template = fs.readFileSync(path.join(TEMPLATE_VSCODE, "launch.json"), "utf8");
  const filled = fillVscodeTemplate(template, {
    gdbPath: "E:/tools/gdb-multiarch.exe",
    armToolchainPath: "E:/tools",
    cmakePath: "E:/tools/cmake.exe",
  });
  assert.deepEqual(filled.dropped, []);
  assert.ok(!filled.text.includes("__GDB_PATH__"));
  assert.ok(filled.text.includes("E:/tools/gdb-multiarch.exe"));
  const parsed = JSON.parse(stripJsonc(filled.text.split("__PROJECT_NAME__").join("blink")));
  assert.equal(parsed.configurations.length, 2);
  assert.equal(parsed.configurations[0].gdbPath, "E:/tools/gdb-multiarch.exe");
  assert.equal(parsed.configurations[1].armToolchainPath, "E:/tools");
});

test("fillVscodeTemplate：值为空时整行删掉并回报占位符（不写空字符串）", () => {
  const template = fs.readFileSync(path.join(TEMPLATE_VSCODE, "launch.json"), "utf8");
  const filled = fillVscodeTemplate(template, { gdbPath: "", armToolchainPath: "", cmakePath: "" });
  assert.deepEqual(
    filled.dropped.sort(),
    [VSCODE_PLACEHOLDERS.gdb, VSCODE_PLACEHOLDERS.toolchain].sort(),
  );
  assert.ok(!filled.text.includes("__GDB_PATH__"));
  assert.ok(!filled.text.includes('"gdbPath"'), "整行都该消失，而不是留一个空串");
  const parsed = JSON.parse(stripJsonc(filled.text.split("__PROJECT_NAME__").join("blink")));
  assert.equal(parsed.configurations.length, 2, "删行之后 JSONC 仍要能解析");
  assert.equal(parsed.configurations[0].gdbPath, undefined);
});

test("describeDroppedPlaceholder：每个占位符都有人话，未知占位符也不炸", () => {
  for (const token of Object.values(VSCODE_PLACEHOLDERS)) {
    const text = describeDroppedPlaceholder(token);
    assert.ok(text.length > 10, token + " 的说明太短");
    assert.ok(text.includes(token) || text.includes("svd") || text.includes("gdb") || text.includes("cmake"), text);
  }
  assert.match(describeDroppedPlaceholder("__WHATEVER__"), /__WHATEVER__/u);
});

test("envWithBinDirs：binDirs 放 PATH 最前面、保留原 PATH、不改进来的对象（B4）", () => {
  const before = { PATH: "C:/orig/bin", OTHER: "1" };
  const env = envWithBinDirs(["E:/msys64/ucrt64/bin"], before);
  assert.equal(env.PATH, "E:/msys64/ucrt64/bin" + path.delimiter + "C:/orig/bin");
  assert.equal(env.OTHER, "1");
  assert.equal(before.PATH, "C:/orig/bin", "调用方的 env 不能被改");
  // Windows 上进程 env 的键名常是 Path：不能同时留下 PATH 与 Path 两个键。
  const mixed = envWithBinDirs(["E:/bin"], { Path: "C:/orig" });
  const pathKeys = Object.keys(mixed).filter((key) => key.toLowerCase() === "path");
  assert.equal(pathKeys.length, 1, "只能有一个 PATH 类键：" + pathKeys.join(","));
  assert.ok(String(mixed[pathKeys[0]]).startsWith("E:/bin"));
});

test("envWithBinDirs / toolSearchDirs：binDirs 为空就不凭空造 PATH，搜索顺序是 binDirs 在前", () => {
  const empty = envWithBinDirs([], {});
  assert.deepEqual(empty, {}, "空 binDirs 不该塞进一个空 PATH");
  const bare = envWithBinDirs(["  ", ""], { APP: "x" });
  assert.deepEqual(bare, { APP: "x" });
  assert.deepEqual(toolSearchDirs(["X:/a", "X:/a"], { Path: "Y:/b;Z:/c" }), ["X:/a", "Y:/b", "Z:/c"]);
  assert.deepEqual(toolSearchDirs([], {}), []);
});

test("填进 JSON 字符串的 Windows 路径必须是合法 JSON（反斜杠要转正斜杠）", () => {
  // 实测缺陷：原来把 path.join 的结果原样插入，launch.json 里得到 "D:\app\..." 这种
  // 非法转义，VS Code 直接拒绝加载（Bad escaped character）。fixture 用反斜杠复现。
  const fill = {
    gdbPath: "D:\\app\\msys64\\ucrt64\\bin\\gdb-multiarch.exe",
    armToolchainPath: "D:\\app\\msys64\\ucrt64\\bin",
    cmakePath: "D:\\app\\msys64\\ucrt64\\bin\\cmake.exe",
  };
  const text = [
    "{",
    '  "gdbPath": "__GDB_PATH__",',
    '  "armToolchainPath": "__ARM_TOOLCHAIN_PATH__",',
    '  "cmake.cmakePath": "__CMAKE_PATH__"',
    "}",
  ].join("\n");
  const { text: filled, dropped } = fillVscodeTemplate(text, fill);
  assert.deepEqual(dropped, []);
  assert.equal(filled.includes("\\"), false, "填完的文本里不该再有反斜杠");
  const parsed = JSON.parse(filled);
  assert.equal(parsed.gdbPath, "D:/app/msys64/ucrt64/bin/gdb-multiarch.exe");
  assert.equal(parsed["cmake.cmakePath"], "D:/app/msys64/ucrt64/bin/cmake.exe");
});
