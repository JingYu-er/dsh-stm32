// A5：.ioc 里把 SWD 关掉（No_Debug）→ 烧录必须被拒绝，并给出 SWJ_DISABLE 级别的警告与修复命令。
// 跑法：node test\e2e-a5-flash-guard.mjs
import assert from "node:assert/strict";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { checkNoDebugGuard, runFlash } from "../lib/engine/flash.js";
import { freshCopy, log, makeSubprocess } from "./harness.mjs";
import { e2eProject, e2eWorkDir } from "./fixtures.mjs";

const SOURCE = e2eProject();
const TARGET = e2eWorkDir("a5");
const subprocess = makeSubprocess();

// ── 夹具：一个把 PA13/PA14 从 Serial_Wire 改成 No_Debug 的工程 ──────────────────
freshCopy(SOURCE, TARGET);
const iocPath = join(TARGET, "blink.ioc");
const original = readFileSync(iocPath, "utf8");
const broken = original
  .split(/\r?\n/u)
  .filter((line) => !(line.startsWith("PA13.") && /Signal=/u.test(line)))
  .filter((line) => !(line.startsWith("PA14.") && /Signal=/u.test(line)))
  .map((line) => line.replace(/^(PA1[34]\.Mode=).*$/u, "$1No_Debug"))
  .join("\r\n");
assert.notEqual(broken, original, "夹具必须真的改到 .ioc");
writeFileSync(iocPath, broken);

// 固件仍然存在（否则拦的是“没 elf”而不是“没调试口”）。整个 build/ 一起复制过来：
// detectBuildDir 靠 CMakeCache.txt 认定构建目录，flash 不跑 cmake，缓存里的旧路径没有影响。
cpSync(join(SOURCE, "build"), join(TARGET, "build"), { recursive: true });

// ── 1) 守卫本身 ───────────────────────────────────────────────────────────────
const guard = checkNoDebugGuard(TARGET);
log("守卫：", guard.blocked, "|", guard.errors[0] ?? "（放行）");
assert.equal(guard.blocked, true, "No_Debug 的 .ioc 必须被拦");
assert.match(guard.errors[0], /Serial Wire/u, "警告里必须点明 Serial Wire");
assert.ok(guard.notes.some((note) => /ioc_plan|Serial_Wire/u.test(note)), "必须给出修复方向（补 PA13/PA14 或 allowNoDebug）");

// ── 2) runFlash：拒绝时不能碰硬件 ─────────────────────────────────────────────
const refused = await runFlash(subprocess, { projectDir: TARGET });
log("runFlash：", refused.ok, "|", refused.message, "| guard=", refused.guard);
assert.equal(refused.ok, false, "必须拒绝烧录");
assert.equal(refused.guard, "no-debug");
assert.equal(refused.programmed, false);
assert.equal(refused.verified, false);
assert.deepEqual(refused.args, [], "拒绝时不该构造 openocd 参数");
assert.match(refused.message, /Serial Wire/u);

// ── 3) allowNoDebug：用户明确接受风险才放行 ───────────────────────────────────
const enforced = await runFlash(subprocess, { projectDir: TARGET, allowNoDebug: true });
log("allowNoDebug 后：", enforced.ok, "|", enforced.message, "| guard=", enforced.guard);
assert.notEqual(enforced.guard, "no-debug", "显式 allowNoDebug 时不能再按 A5 拦");

log("A5 PASS：No_Debug 的 .ioc 被拦在烧录之前（未执行 openocd），并给出修复方向");
