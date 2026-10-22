// L1 纯逻辑单测：脚本拼装、日志判定、落位映射、USER CODE 合并。
// 运行：node --test test/engine-units.test.mjs（需先 npm run build）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { buildGenerateScript, layoutCommand, parseGenerateLog } from "../lib/engine/generate-script.js";
import { mapGeneratedPath } from "../lib/engine/layout.js";
import { canMergeUserCode, mergeUserCode, parseUserCodeRegions } from "../lib/engine/usercode-merge.js";

import { FIXTURE_PROJECT as PROJECT } from "./fixtures.mjs";

test("脚本按 config load → 布局 → generate code → exit 排列，且出参必须是目录", () => {
  const script = buildGenerateScript("D:/p/demo.ioc", "D:/p", "coupled");
  assert.deepEqual(script.trimEnd().split("\n"), [
    "config load D:/p/demo.ioc",
    "generate all_code_in_main",
    "generate code D:/p",
    "exit",
  ]);
  assert.equal(layoutCommand("per-ip"), "generate one_file_per_ip");
});

test("日志判定：成功行即成功，已知噪音不算错误", () => {
  const ok = parseGenerateLog(
    ["OptionalMessage_ERROR", "PDSC version is not supported ERROR", "Code succesfully generated under D:/p"].join("\n"),
  );
  assert.equal(ok.ok, true);
  assert.match(ok.successLine, /succesfully generated/u);
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.knownNoise.length, 2);

  const bad = parseGenerateLog("ERROR: ioc file not found");
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 1);
});

test("日志判定：有成功行时过程里的 ERROR 只算告警（Updater is busy 实测）", () => {
  const verdict = parseGenerateLog(
    [
      "2026-10-22 17:18:32,574 [ERROR] WebUtils:398 - Updater is busy",
      "Code succesfully generated under D:/p",
      "OK",
      "Bye bye",
    ].join("\n"),
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.errors.length, 0);
  assert.equal(verdict.knownNoise.some((line) => /Updater is busy/u.test(line)), true);
});

test("落位映射：Src/Inc → Core/Src、Core/Inc，其它返回 null", () => {
  assert.equal(mapGeneratedPath("Src/main.c"), "Core/Src/main.c");
  assert.equal(mapGeneratedPath("Inc/main.h"), "Core/Inc/main.h");
  assert.equal(mapGeneratedPath("Src/sub/gpio.c"), "Core/Src/sub/gpio.c");
  assert.equal(mapGeneratedPath("README.md"), null);
});

test("USER CODE 合并：同标签覆盖、缺失标签上报", () => {
  const oldText = [
    "void f(void) {",
    "  /* USER CODE BEGIN 3 */",
    "  HAL_Delay(500);",
    "  /* USER CODE END 3 */",
    "}",
    "/* USER CODE BEGIN OnlyOld */",
    "keep me",
    "/* USER CODE END OnlyOld */",
  ].join("\n");
  const newText = [
    "void f(void) {",
    "  /* USER CODE BEGIN 3 */",
    "  /* USER CODE END 3 */",
    "}",
  ].join("\n");
  const result = mergeUserCode(oldText, newText);
  assert.deepEqual(result.preserved, ["3"]);
  assert.deepEqual(result.droppedLabels, ["OnlyOld"]);
  assert.match(result.merged, /HAL_Delay\(500\);/u);
  assert.equal(result.merged.split("\n").length, 5);
  assert.equal(canMergeUserCode(newText), true);
  assert.equal(canMergeUserCode("int x;\n"), false);
});

test("CRLF 文件：标记能被识别，行尾不被改写成 LF", () => {
  const oldText = ["  /* USER CODE BEGIN 3 */", "  HAL_Delay(1);", "  /* USER CODE END 3 */", ""].join("\r\n");
  const newText = ["  /* USER CODE BEGIN 3 */", "  /* USER CODE END 3 */", ""].join("\r\n");
  assert.deepEqual(parseUserCodeRegions(oldText).map((r) => r.label), ["3"]);
  const result = mergeUserCode(oldText, newText);
  assert.deepEqual(result.preserved, ["3"]);
  assert.match(result.merged, /HAL_Delay\(1\);/u);
  assert.equal(result.merged.includes("\r\n  HAL_Delay(1);"), true);
  assert.equal(/[^\r]\n/u.test(result.merged), false, "不应混入裸 LF");
});

test("USER CODE 解析：缩进标记也算，未闭合忽略", () => {
  const regions = parseUserCodeRegions(["a", "  /* USER CODE BEGIN Header */", "h", "  /* USER CODE END Header */", "/* USER CODE BEGIN Broken */"].join("\n"));
  assert.deepEqual(regions.map((r) => r.label), ["Header"]);
  assert.equal(regions[0].body, "h");
});

test("真实文件：用项目 main.c 的 USER CODE 覆盖 CubeMX 生成结果", () => {
  const oldText = readFileSync(PROJECT + "/Core/Src/main.c", "utf8");
  const newText = readFileSync(PROJECT + "/_scratch/Src/main.c", "utf8");
  const result = mergeUserCode(oldText, newText);
  assert.ok(result.preserved.includes("3"), "USER CODE 3 应被保活");
  assert.match(result.merged, /g_led_blink_count\+\+/u);
  assert.match(result.merged, /HAL_Delay\(500\);/u);
  assert.deepEqual(result.droppedLabels, [], "两份文件的标签集合相同，不应有丢失");
});
