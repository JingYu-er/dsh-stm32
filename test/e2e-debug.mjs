// 端到端：在真实板子上跑一次调试快照（连 openocd + gdb，停在 main，读寄存器后释放探针）。
// 用法：node test/e2e-debug.mjs [工程目录]
import { spawn } from "node:child_process";

import { runDebugRun } from "../lib/engine/debug.js";
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
const startedAt = Date.now();
const report = await runDebugRun(makeSubprocess(), { projectDir, breakAt: "main" });
console.log("---- 报告 ----");
console.log("ok=" + String(report.ok) + " 耗时=" + ((Date.now() - startedAt) / 1000).toFixed(1) + " s port=" + String(report.port));
console.log("message=" + report.message);
console.log("位置=" + report.location);
console.log("寄存器=" + report.registers.map((item) => item.name + "=" + item.value).join(" "));
for (const frame of report.backtrace.slice(0, 4)) console.log("栈 " + frame);
for (const note of report.notes) console.log("· " + note);
for (const error of report.errors) console.log("! " + error);
if (!report.ok) console.log("gdb 输出尾部：\n" + report.gdbOutput.split(/\r?\n/u).slice(-18).join("\n"));

const pc = report.registers.find((item) => item.name === "pc")?.value ?? "";
const mainAddress = /main/u.test(report.location) || /main/u.test(report.backtrace[0] ?? "");
const checks = [
  ["调试成功", report.ok === true],
  ["命中 main 断点", report.hitBreakpoint === true && mainAddress],
  ["拿到 pc 寄存器", /^0x[0-9a-fA-F]+$/u.test(pc)],
  ["有调用栈", report.backtrace.length >= 1],
  ["无错误行", report.errors.length === 0],
];
let failed = 0;
for (const [label, ok] of checks) {
  console.log((ok ? "PASS " : "FAIL ") + label);
  if (!ok) failed += 1;
}
process.exit(failed === 0 ? 0 : 1);
