// 单元测试：源码文件编码探测与按原编码写回（审计 B2 / A5）。用 node test/text-encoding-units.test.mjs 跑。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { patchUserCode } from "../lib/engine/code-patch.js";
import {
  decodeText,
  describeEncoding,
  detectEncoding,
  encodeText,
  isAscii,
  lineStarts,
  readTextFile,
  replaceLineRange,
} from "../lib/engine/text-file.js";

/** "中文" 的 GBK 字节：用来验证写回时不重编码、不毁中文注释。 */
const GBK_ZHONGWEN = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
const UNKNOWN_BYTES = Buffer.from([0xff, 0xff, 0xfe]);

function ascii(text) {
  return Buffer.from(text, "latin1");
}

/** GBK 文件：一段 GBK 中文注释 + 一个 USER CODE 块。 */
function gbkSource() {
  return Buffer.concat([
    ascii("/* "),
    GBK_ZHONGWEN,
    ascii(" note */\r\n/* USER CODE BEGIN 3 */\r\nuint32_t old_value = 0;\r\n/* USER CODE END 3 */\r\n"),
  ]);
}

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-enc-" + tag + "-"));
}

function writeSource(dir, buffer) {
  fs.mkdirSync(path.join(dir, "Core", "Src"), { recursive: true });
  const file = path.join(dir, "Core", "Src", "main.c");
  fs.writeFileSync(file, buffer);
  return file;
}

test("detectEncoding：ASCII / UTF-8 / BOM / GB18030 / 认不出", () => {
  assert.equal(detectEncoding(Buffer.from("int main(void) {}\n")), "utf8");
  assert.equal(detectEncoding(Buffer.from("// 中文注释\n", "utf8")), "utf8");
  assert.equal(
    detectEncoding(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("x = 1;\n")])),
    "utf8-bom",
  );
  assert.equal(detectEncoding(gbkSource()), "gb18030");
  assert.equal(detectEncoding(UNKNOWN_BYTES), "unknown");
});

test("describeEncoding / isAscii：中文文案与纯 ASCII 判定", () => {
  assert.equal(describeEncoding("utf8"), "UTF-8");
  assert.equal(describeEncoding("utf8-bom"), "UTF-8（带 BOM）");
  assert.equal(describeEncoding("gb18030"), "GB18030/GBK");
  assert.match(describeEncoding("unknown"), /认不出/u);
  assert.equal(isAscii("uint32_t x;\n"), true);
  assert.equal(isAscii("中文"), false);
});

test("decodeText：GB18030 能解出中文，BOM 会被去掉", () => {
  assert.equal(decodeText(gbkSource(), "gb18030").startsWith("/* 中文 note */"), true);
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\n")]);
  assert.equal(decodeText(bom, "utf8-bom"), "a\n");
});

test("encodeText：GB18030 只接受纯 ASCII（Node 没有 GB18030 编码器）", () => {
  const ok = encodeText("uint32_t y = 2;\n", "gb18030");
  assert.equal(ok.ok, true);
  assert.equal(ok.bytes.equals(Buffer.from("uint32_t y = 2;\n", "latin1")), true);
  const bad = encodeText("// 中文\n", "gb18030");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /GB18030/u);
  assert.equal(encodeText("x\n", "unknown").ok, false);
});

test("lineStarts / replaceLineRange：只换目标行，块外字节原样保留", () => {
  const buffer = gbkSource();
  const starts = lineStarts(buffer);
  assert.equal(starts.length, 5, "4 个换行 → 5 个逻辑行起点");
  assert.equal(starts[0], 0);
  assert.equal(starts[1], buffer.indexOf(0x0a) + 1);
  const replaced = replaceLineRange(buffer, 2, 3, ["uint32_t fresh = 1;"], "\r\n", "gb18030");
  assert.equal(replaced.ok, true, replaced.error);
  assert.equal(replaced.bytes.includes(GBK_ZHONGWEN), true, "中文注释的字节必须原样保留");
  const latin = replaced.bytes.toString("latin1");
  assert.equal(latin.includes("fresh = 1"), true);
  assert.equal(latin.includes("old_value"), false);
  assert.equal(latin.split("\r\n").length, 5, "行数不变");
  assert.equal(replaceLineRange(buffer, 3, 1, ["x"], "\r\n", "gb18030").ok, false);
});

test("readTextFile：GBK 文件给出 encoding=gb18030 与 CRLF，读不了的文件干净失败", () => {
  const dir = tempDir("read");
  const file = writeSource(dir, gbkSource());
  const read = readTextFile(file);
  assert.equal(read.ok, true, read.error);
  assert.equal(read.encoding, "gb18030");
  assert.equal(read.eol, "\r\n");
  assert.equal(read.text.includes("中文"), true);
  const missing = readTextFile(path.join(dir, "missing.c"));
  assert.equal(missing.ok, false);
  assert.match(missing.error, /读不了文件/u);
  const unknownFile = path.join(dir, "binary.c");
  fs.writeFileSync(unknownFile, UNKNOWN_BYTES);
  const unknown = readTextFile(unknownFile);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /认不出来/u);
});

test("patchUserCode：GBK 文件里只改 USER CODE 块，中文注释字节不变", () => {
  const dir = tempDir("gbk");
  const file = writeSource(dir, gbkSource());
  const report = patchUserCode({
    projectDir: dir,
    file: "Core/Src/main.c",
    block: "3",
    code: "uint32_t fresh = 42;",
    mode: "replace",
  });
  assert.equal(report.ok, true, report.message);
  const after = fs.readFileSync(file);
  assert.equal(after.includes(GBK_ZHONGWEN), true, "中文注释的 GBK 字节必须还在");
  const latin = after.toString("latin1");
  assert.equal(latin.includes("fresh = 42"), true);
  assert.equal(latin.includes("old_value"), false);
  assert.equal(latin.split("\r\n").length, 5);
  assert.equal(typeof report.backupPath, "string");
  assert.equal(fs.existsSync(report.backupPath ?? ""), true, "覆盖前必须备份");
});

test("patchUserCode：编码认不出的文件拒绝改写，字节一个都不变", () => {
  const dir = tempDir("unknown");
  const original = Buffer.concat([
    ascii("/* USER CODE BEGIN 3 */\n"),
    UNKNOWN_BYTES,
    ascii("\n/* USER CODE END 3 */\n"),
  ]);
  const file = writeSource(dir, original);
  const report = patchUserCode({
    projectDir: dir,
    file: "Core/Src/main.c",
    block: "3",
    code: "int x;",
    mode: "replace",
  });
  assert.equal(report.ok, false);
  assert.match(report.message, /编码认不出来/u);
  assert.equal(fs.readFileSync(file).equals(original), true);
});

test("patchUserCode：带 BOM 的 UTF-8 文件写回后仍带 BOM", () => {
  const dir = tempDir("bom");
  const body = "/* USER CODE BEGIN 3 */\nint a;\n/* USER CODE END 3 */\n";
  const file = writeSource(dir, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body)]));
  const report = patchUserCode({
    projectDir: dir,
    file: "Core/Src/main.c",
    block: "3",
    code: "int b;",
    mode: "replace",
  });
  assert.equal(report.ok, true, report.message);
  const after = fs.readFileSync(file);
  assert.deepEqual([...after.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = after.toString("utf8");
  assert.equal(text.includes("int b;"), true);
  assert.equal(text.includes("int a;"), false);
});
