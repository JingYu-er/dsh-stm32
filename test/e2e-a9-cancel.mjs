// A9：取消长任务（CubeMX）→ 立刻停下、半成品清掉、进程树不留残余；build 的取消同样要有明确报告。
// 跑法：node test\e2e-a9-cancel.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { runBuild } from "../lib/engine/build.js";
import { runGenerate } from "../lib/engine/generate.js";
import { freshCopy, log, makeSubprocess } from "./harness.mjs";
import { binDirs, e2eProject, e2eWorkDir } from "./fixtures.mjs";

const SOURCE = e2eProject();
const TARGET = e2eWorkDir("a9");
const BIN = binDirs()[0];
const subprocess = makeSubprocess();

const javaProcs = () => {
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq STM32CubeMX.exe"], { encoding: "utf8", windowsHide: true });
    return (out.match(/STM32CubeMX\.exe/gu) ?? []).length;
  } catch {
    return -1;
  }
};

freshCopy(SOURCE, TARGET);

// ── 1) 预取消的 build：立刻返回，不启动任何进程 ────────────────────────────────
{
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  const report = await runBuild(subprocess, { projectDir: TARGET, binDirs: [BIN], signal: controller.signal });
  const elapsed = Date.now() - started;
  log("预取消 build：", report.ok, report.message, elapsed + "ms");
  assert.equal(report.ok, false);
  assert.match(report.message, /取消/u);
  assert.ok(elapsed < 3000, "预取消必须立刻返回，实际 " + elapsed + "ms");
}

// ── 2) 真跑 CubeMX 再取消 ────────────────────────────────────────────────────
const before = javaProcs();
log("取消前 STM32CubeMX 进程数：", before);

const controller = new AbortController();
const abortTimer = setTimeout(() => {
  log("abort() —— 模拟用户中断");
  controller.abort();
}, 8000);
const started = Date.now();
const report = await runGenerate(subprocess, {
  projectDir: TARGET,
  cubeMxRoots: ["D:/app/STM32CubeMX"],
  signal: controller.signal,
  timeoutMs: 300_000,
});
clearTimeout(abortTimer);
const elapsed = Date.now() - started;
log("generate 返回：", report.ok, "|", report.message, "|", (elapsed / 1000).toFixed(1) + "s");
assert.equal(report.ok, false, "取消后不能报成功");
assert.match(report.message, /取消/u, "报告必须明确说是取消，而不是笼统的失败");

// 半成品要清掉：CubeMX 可能已经写了 Src/Inc
const leftovers = ["Src", "Inc"].filter((dir) => existsSync(join(TARGET, dir)));
log("残留目录：", leftovers.length === 0 ? "（无）" : leftovers.join("、"));
assert.deepEqual(leftovers, [], "取消后半成品必须清理干净");
assert.equal(existsSync(join(TARGET, ".dsh-stm32/lock.json")), false, "取消后锁必须释放");

// ── 3) 进程树：给宿主 3 s 宽限（graceMs）把 JVM 收掉 ──────────────────────────
await new Promise((resolve) => setTimeout(resolve, 3000));
const after = javaProcs();
log("取消后 STM32CubeMX 进程数：", after);
assert.ok(after <= before, "取消后不应该多出 CubeMX 进程（" + before + " → " + after + "）");

log("A9 PASS：取消 " + (elapsed / 1000).toFixed(1) + " s 内返回，半成品已清，锁已释放，无多出进程");
