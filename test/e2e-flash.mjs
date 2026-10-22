// 端到端：真实烧录 demo 工程（会写板子上的 Flash）。
// 用法：node test/e2e-flash.mjs [工程目录]
import { spawn } from "node:child_process";

import { runFlash } from "../lib/engine/flash.js";
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
const report = await runFlash(makeSubprocess(), {
  projectDir,
  onProgress: (line) => {
    if (/Info|Warn|Error|\*\*/u.test(line)) console.log("[进度] " + line.slice(0, 180));
  },
});
console.log("---- 报告 ----");
console.log("ok=" + String(report.ok) + " 耗时=" + ((Date.now() - startedAt) / 1000).toFixed(1) + " s exit=" + String(report.exitCode));
console.log("message=" + report.message);
console.log("固件=" + report.elfPath + " (" + String(report.elfSize) + " B)");
console.log("配置=" + report.configs.join(" + "));
console.log("命令=" + report.command);
for (const note of report.notes) console.log("· " + note);
for (const error of report.errors) console.log("! " + error);
if (!report.ok) console.log("日志尾部：\n" + report.logTail);

const checks = [
  ["烧录成功", report.ok === true],
  ["openocd 报告写入完成", report.programmed === true],
  ["校验通过", report.verified === true],
  ["用的是工程的 openocd.cfg", report.configs.some((item) => item.endsWith("demo/openocd.cfg"))],
  ["无错误行", report.errors.length === 0],
];
let failed = 0;
for (const [label, ok] of checks) {
  console.log((ok ? "PASS " : "FAIL ") + label);
  if (!ok) failed += 1;
}
process.exit(failed === 0 ? 0 : 1);
