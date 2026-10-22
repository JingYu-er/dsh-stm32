// 端到端：真实板子上的长调试会话（起会话 → 两次读变量 → 读 pc → 关会话 → 探针释放）。
// 用法：node test/e2e-session.mjs [工程目录]
import { spawn } from "node:child_process";

import { DebugSessionManager } from "../lib/engine/debug-session.js";
import { isPortBusy } from "../lib/engine/debug.js";
import { e2eProject } from "./fixtures.mjs";

function makeSubprocess() {
  return {
    resolveExecutable(command) {
      return command;
    },
    spawn(spec) {
      if (typeof spec.cwd !== "string") throw new TypeError("Cannot read properties of undefined (reading 'includes')");
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const buffers = { stdout: "", stderr: "" };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffers.stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        buffers.stderr += chunk;
      });
      const done = new Promise((resolveDone, rejectDone) => {
        child.on("error", rejectDone);
        child.on("close", (code) => resolveDone({ exitCode: code, signal: null }));
      });
      const reader = (key) => ({
        readFrom(offset) {
          return { text: buffers[key].slice(offset), nextOffset: buffers[key].length, lossy: false };
        },
      });
      spec.signal?.addEventListener("abort", () => child.kill(), { once: true });
      return {
        done,
        collected: { stdout: reader("stdout"), stderr: reader("stderr") },
        terminate() {
          child.kill();
        },
        waitForExit() {
          return done.catch(() => undefined);
        },
      };
    },
  };
}

const projectDir = e2eProject();
const manager = new DebugSessionManager();
manager.configure(makeSubprocess(), []);
const startedAt = Date.now();

const started = await manager.start({ projectDir });
console.log("---- 会话 ----");
console.log("ok=" + String(started.ok) + " active=" + String(started.active) + " port=" + String(started.port) + " 耗时=" + ((Date.now() - startedAt) / 1000).toFixed(1) + " s");
console.log("message=" + started.message);
console.log("符号=" + started.elfPath);
for (const error of started.errors) console.log("! " + error);

const first = await manager.eval({ expression: "g_led_blink_count" });
console.log("---- 第一次读计数 ----");
console.log(first.output.split(/\r?\n/u).slice(-2).join("\n"));
await new Promise((done) => setTimeout(done, 1200));
const second = await manager.eval({ expression: "g_led_blink_count" });
console.log("---- 1.2 s 后第二次读计数 ----");
console.log(second.output.split(/\r?\n/u).slice(-2).join("\n"));

const regs = await manager.eval({ commands: ["info registers pc sp"] });
console.log("---- 读寄存器 ----");
console.log(regs.output.split(/\r?\n/u).slice(-2).join("\n"));

const status = manager.status();
console.log("---- 状态 ----");
console.log(status.message);

const stopped = await manager.stop("e2e 收尾");
console.log("---- 关闭 ----");
console.log(stopped.message);
await new Promise((done) => setTimeout(done, 500));
const portStillBusy = await isPortBusy(started.port, 800);

function pickNumber(text) {
  const matches = [...text.matchAll(/=\s*(0x[0-9a-fA-F]+|\d+)/gu)].map((match) => match[1]);
  if (matches.length === 0) return null;
  const raw = matches[matches.length - 1];
  return raw.startsWith("0x") ? Number.parseInt(raw.slice(2), 16) : Number.parseInt(raw, 10);
}
const firstValue = pickNumber(first.output);
const secondValue = pickNumber(second.output);

const checks = [
  ["会话开起来", started.ok === true && started.active === true],
  ["拿到自动解析的 .elf", started.elfPath.toLowerCase().endsWith(".elf")],
  ["第一次读计数成功", first.ok === true && firstValue !== null],
  ["第二次读计数成功", second.ok === true && secondValue !== null],
  ["两次之间计数在增长（芯片没停）", firstValue !== null && secondValue !== null && secondValue > firstValue],
  ["读寄存器成功", regs.ok === true && /pc\s+0x[0-9a-fA-F]+/u.test(regs.output)],
  ["会话期间是 active", status.active === true && status.remainingMs > 0],
  ["关闭后释放", stopped.stopped === true && manager.isActive() === false],
  ["端口已空闲", portStillBusy === false],
];
let failed = 0;
for (const [label, ok] of checks) {
  console.log((ok ? "PASS " : "FAIL ") + label);
  if (!ok) failed += 1;
}
if (manager.isActive()) await manager.stop("失败兜底");
process.exit(failed === 0 ? 0 : 1);
