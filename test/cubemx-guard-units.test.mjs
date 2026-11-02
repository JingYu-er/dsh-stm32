// CubeMX GUI 占用检测（src/engine/cube-mx-guard.ts）：只认 STM32CubeMX.exe，探测失败不拦人。
//
// 为什么值得单测：这个 guard 的唯一作用就是"别让人对着不动的进度条猜"，它自己误报（把无头 java 当 GUI）
// 会直接挡住正常生成；漏报则会重现"弹模态框卡 4 分钟"。两头都要钉住。
import assert from "node:assert/strict";
import { test } from "node:test";

import { describeCubeMxGuiConflict, findRunningCubeMxGui } from "../lib/engine/cube-mx-guard.js";

/** 假 subprocess：runCapture 只需要 spawn() 返回 collected + done。 */
function stubSubprocess(csv, options = {}) {
  const { exitCode = 0, spawnError = null } = options;
  return {
    resolveExecutable: (command) => command,
    spawn: () => {
      const stdout = { readFrom: (offset) => ({ text: csv.slice(offset), nextOffset: csv.length, lossy: false }) };
      const stderr = { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) };
      return {
        done: Promise.resolve({ exitCode, signal: null }),
        collected: { stdout, stderr },
        terminate: () => undefined,
        waitForExit: async () => undefined,
        spawnError,
      };
    },
  };
}

const CSV = [
  '"STM32CubeMX.exe","8124","Console","1","123,456 K"',
  '"java.exe","9911","Console","1","80,000 K"',
  '"explorer.exe","1000","Console","1","60,000 K"',
].join("\r\n");

test("检测到 STM32CubeMX.exe → 报出 PID；无头的 java.exe 不算", async () => {
  const found = await findRunningCubeMxGui(stubSubprocess(CSV));
  assert.deepEqual(found, [{ name: "STM32CubeMX.exe", pid: 8124 }]);
});

test("没有 GUI 进程时返回空数组（正常生成不该被拦）", async () => {
  const onlyJava = '"java.exe","9911","Console","1","80,000 K"';
  assert.deepEqual(await findRunningCubeMxGui(stubSubprocess(onlyJava)), []);
});

test("tasklist 失败（非 0 / spawn 报错）时返回空数组：探测失败不能挡住生成", async () => {
  assert.deepEqual(await findRunningCubeMxGui(stubSubprocess(CSV, { exitCode: 1 })), []);
  assert.deepEqual(await findRunningCubeMxGui(stubSubprocess(CSV, { exitCode: null, spawnError: "EPERM" })), []);
});

test("冲突文案要点名单实例 + 关掉 GUI 再重跑（而不是让人去点按钮）", () => {
  const text = describeCubeMxGuiConflict([{ name: "STM32CubeMX.exe", pid: 8124 }]);
  assert.match(text, /单实例/u);
  assert.match(text, /8124/u);
  assert.match(text, /关掉 CubeMX/u);
  assert.match(text, /模态框|弹窗/u);
});
