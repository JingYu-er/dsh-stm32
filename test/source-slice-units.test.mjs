/**
 * 源码片段：路径守卫与行号夹取的纯函数测试。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { readSourceSlice, resolveSourceFile, SOURCE_CONTEXT_MAX } from "../lib/engine/source-slice.js";

function projectWithSource(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-src-"));
  fs.mkdirSync(path.join(dir, "Core", "Src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Core", "Src", "main.c"), lines.join("\n") + "\n", "utf8");
  return dir;
}

test("源码片段：读焦点行与上下文，行号从 1 起", () => {
  const dir = projectWithSource(["a", "b", "c", "d", "e", "f", "g"]);
  const read = readSourceSlice(dir, "Core/Src/main.c", 4, 2);
  assert.equal(read.ok, true);
  assert.equal(read.slice.line, 4);
  assert.deepEqual([read.slice.from, read.slice.to], [2, 6]);
  assert.deepEqual(read.slice.lines.map((item) => item.text), ["b", "c", "d", "e", "f"]);
  assert.equal(read.slice.totalLines, 7);
  assert.equal(read.slice.lines[2].line, 4);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("源码片段：行号越界夹到首尾，上下文上限封顶", () => {
  const dir = projectWithSource(["a", "b", "c"]);
  const tail = readSourceSlice(dir, "Core/Src/main.c", 99, 5);
  assert.equal(tail.ok, true);
  assert.equal(tail.slice.line, 3);
  assert.deepEqual([tail.slice.from, tail.slice.to], [1, 3]);
  const wide = readSourceSlice(dir, "Core/Src/main.c", 2, 999);
  assert.equal(wide.slice.to - wide.slice.from, Math.min(SOURCE_CONTEXT_MAX * 2, 2));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("源码片段：路径守卫只放行工程目录内的文件", () => {
  const dir = projectWithSource(["a"]);
  assert.notEqual(resolveSourceFile(dir, "Core/Src/main.c"), null);
  assert.notEqual(resolveSourceFile(dir, "Core\\Src\\main.c"), null);
  assert.equal(resolveSourceFile(dir, "../outside.c"), null);
  assert.equal(resolveSourceFile(dir, "C:/Windows/win.ini"), null);
  assert.equal(resolveSourceFile(dir, "."), null);
  const escape = readSourceSlice(dir, "../outside.c", 1, 1);
  assert.equal(escape.ok, false);
  assert.match(escape.error, /工程目录内/u);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("源码片段：非法行号与不存在的文件给出可读错误", () => {
  const dir = projectWithSource(["a"]);
  const badLine = readSourceSlice(dir, "Core/Src/main.c", Number.NaN, 2);
  assert.equal(badLine.ok, false);
  assert.match(badLine.error, /line/u);
  const missing = readSourceSlice(dir, "Core/Src/none.c", 1, 2);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /读取源码失败/u);
  fs.rmSync(dir, { recursive: true, force: true });
});
