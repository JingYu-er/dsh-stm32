/**
 * .ioc 与生成代码是否同步：只比文件修改时间，不启动 CubeMX、不读 .ioc 内容。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { readIocSync } from "../lib/engine/ioc-sync.js";

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ioc-sync-"));
  fs.writeFileSync(path.join(dir, "demo.ioc"), "Mcu.CPN=STM32F103C8T6\n");
  return dir;
}

function setMtime(file, ms) {
  const seconds = ms / 1000;
  fs.utimesSync(file, seconds, seconds);
}

function withMain(dir, text = "int main(void) { return 0; }\n") {
  const core = path.join(dir, "Core", "Src");
  fs.mkdirSync(core, { recursive: true });
  const file = path.join(core, "main.c");
  fs.writeFileSync(file, text);
  return file;
}

test("同步判定：代码比 .ioc 新算一致，反之算待生成", () => {
  const dir = project();
  const main = withMain(dir);
  const ioc = path.join(dir, "demo.ioc");
  setMtime(ioc, 1_700_000_000_000);
  setMtime(main, 1_700_000_010_000);

  const fresh = readIocSync(dir);
  assert.equal(fresh.ok, true, fresh.error);
  assert.equal(fresh.report.stale, false);
  assert.equal(fresh.report.message, ".ioc 与生成的代码一致。");
  assert.equal(fresh.report.codePath, main);
  assert.equal(fresh.report.iocMtimeMs, 1_700_000_000_000);
  assert.equal(fresh.report.codeMtimeMs, 1_700_000_010_000);

  // 改过 .ioc 但没重新生成：.ioc 更新。
  setMtime(ioc, 1_700_000_020_000);
  const stale = readIocSync(dir);
  assert.equal(stale.ok, true);
  assert.equal(stale.report.stale, true);
  assert.equal(stale.report.message, ".ioc 比生成的代码新：配置改了但还没重新生成，编译烧录仍是旧代码。");
});

test("同步判定：1 秒以内的抖动不算待生成", () => {
  const dir = project();
  const main = withMain(dir);
  setMtime(main, 1_700_000_000_000);
  setMtime(path.join(dir, "demo.ioc"), 1_700_000_000_500);
  assert.equal(readIocSync(dir).report.stale, false);
});

test("同步判定：没有 Core/Src/main.c 时不下结论，只提示先生成", () => {
  const dir = project();
  const result = readIocSync(dir);
  assert.equal(result.ok, true);
  assert.equal(result.report.stale, false);
  assert.equal(result.report.codeMtimeMs, 0);
  assert.match(result.report.message, /还没有生成过代码/u);
  assert.match(result.report.message, /stm32_generate/u);
});

test("同步判定：空参数与没有 .ioc 都给出明确错误", () => {
  assert.deepEqual(readIocSync("  "), { ok: false, error: "projectDir 不能为空" });

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ioc-sync-empty-"));
  const missing = readIocSync(empty);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /没有 \.ioc/u);
  assert.equal(missing.error.includes(empty), true, "错误里要带上找过的目录");
});
