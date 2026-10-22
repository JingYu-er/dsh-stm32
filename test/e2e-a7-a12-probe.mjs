// A7：探针连不上（配置指向不存在的探针）→ 明确报错、不留 openocd 进程、芯片还能被重新连上。
// A12：探针被别人占着（另一个 openocd 已连接）→ 烧录必须失败并说清原因，不写坏芯片。
// 跑法：node test\e2e-a7-a12-probe.mjs
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { runFlash } from "../lib/engine/flash.js";
import { freshCopy, log, makeSubprocess } from "./harness.mjs";
import { e2eProject, e2eWorkDir } from "./fixtures.mjs";

const SOURCE = e2eProject();
const TARGET = e2eWorkDir("a7a12");
const BIN = "D:/app/msys64/ucrt64/bin";
const OPENOCD = join(BIN, "openocd.exe");
const CFG = ["-f", "interface/cmsis-dap.cfg", "-f", "target/stm32f1x.cfg"];
const subprocess = makeSubprocess();

const openocdCount = () => {
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq openocd.exe"], { encoding: "utf8", windowsHide: true });
    return (out.match(/openocd\.exe/gu) ?? []).length;
  } catch {
    return -1;
  }
};

/** 直接问硬件："现在 pc 是多少"——能回话就说明探针与芯片都还活着。 */
function probePc() {
  // openocd 的日志全走 stderr，必须两路一起收
  const run = spawnSync(OPENOCD, [...CFG, "-c", "init; halt; reg pc; resume; shutdown"], { encoding: "utf8", windowsHide: true });
  const out = String(run.stdout ?? "") + String(run.stderr ?? "");
  // 两种格式都要认：reg pc 打印 "pc (/32 bits) = 0x…"，halt 日志打印 "pc: 0x…"
  const match = /(?:pc \(\/(?:32|16) bits\) = |pc: )(0x[0-9a-fA-F]+)/u.exec(out);
  return match === null ? { pc: null, tail: out.slice(-400) } : { pc: match[1], tail: "" };
}

// ── A7：探针配置错误 ──────────────────────────────────────────────────────────
freshCopy(SOURCE, TARGET);
// flash 要靠 CMakeCache.txt 认构建目录、并从中找 .elf；flash 不跑 cmake，缓存里的旧路径无影响
cpSync(join(SOURCE, "build"), join(TARGET, "build"), { recursive: true });
const before = openocdCount();
const failed = await runFlash(subprocess, {
  projectDir: TARGET,
  interfaceConfig: "interface/jlink.cfg",
  targetConfig: "target/stm32f1x.cfg",
  timeoutMs: 60_000,
});
log("A7 错误探针：", failed.ok, "|", failed.message.slice(0, 180));
assert.equal(failed.ok, false, "探针配置错误必须报失败");
assert.equal(failed.programmed, false);
assert.equal(failed.verified, false);
assert.ok(failed.errors.length > 0, "必须带 openocd 的原话");
await new Promise((resolve) => setTimeout(resolve, 1500));
const afterFail = openocdCount();
log("A7 残留 openocd：", before, "→", afterFail);
assert.ok(afterFail <= before, "失败后不能留下 openocd 进程");
const after = probePc();
log("A7 芯片仍可连：pc =", after.pc);
if (after.pc === null) log("openocd 尾巴：", after.tail.replace(/\s+/gu, " ").trim());
assert.match(String(after.pc), /^0x/u, "失败后探针必须还能连上芯片（没把芯片锁死）");

// ── A12：探针被别人占着 ───────────────────────────────────────────────────────
const holder = spawn(OPENOCD, [...CFG, "-c", "init"], { cwd: TARGET, windowsHide: true, stdio: "ignore" });
await new Promise((resolve) => setTimeout(resolve, 2000));
const occupied = await runFlash(subprocess, { projectDir: TARGET, timeoutMs: 60_000 });
log("A12 探针被占：", occupied.ok, "|", occupied.message.slice(0, 200));
assert.equal(occupied.ok, false, "探针被占用时必须失败，而不是装作成功");
assert.match(occupied.errors.join(" "), /(failed to|in use|Error)/iu, "必须带 openocd 的原话");
holder.kill();
await new Promise((resolve) => setTimeout(resolve, 1500));

// 占用的进程放掉后，同一份工程必须能正常烧录（没被写坏）
const recovered = await runFlash(subprocess, { projectDir: TARGET, timeoutMs: 90_000 });
log("A12 放掉占用后：", recovered.ok, "|", recovered.message);
assert.equal(recovered.ok, true, "占用释放后必须能烧");
assert.equal(recovered.verified, true);
assert.equal(readFileSync(join(TARGET, "blink.ioc"), "utf8").length > 0, true);

log("A7/A12 PASS：错误探针报错且无残留、占用时报错、释放后可正常烧录");
