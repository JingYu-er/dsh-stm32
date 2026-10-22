// 端到端：在真实工程上跑 stm32_build 的引擎（需要能起子进程：pwsh 工具下要 danger-full-access）。
// 用法：node test/e2e-build.mjs [工程目录]
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { runBuild } from "../lib/engine/build.js";
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
// 用 clean 构建：增量构建不会重新链接，拿不到 ld 的内存占用输出。
const report = await runBuild(makeSubprocess(), {
  projectDir,
  clean: true,
  onProgress: (line) => {
    if (/命令|error|错误|Linking|Building C object|\.elf/u.test(line)) console.log("[进度] " + line.slice(0, 200));
  },
});
console.log("---- 报告 ----");
console.log("ok=" + String(report.ok) + " 耗时=" + ((Date.now() - startedAt) / 1000).toFixed(1) + " s exit=" + String(report.exitCode ?? "-"));
console.log("message=" + report.message);
console.log("buildDir=" + report.buildDir);
console.log("命令=" + report.command);
console.log("elf=" + (report.elf === undefined ? "无" : report.elf.path + " " + String(report.elf.size) + " B"));
for (const usage of report.memoryUsage) console.log("占用 " + usage.raw);
for (const note of report.notes) console.log("· " + note);
for (const error of report.errors) console.log("! " + error);
if (!report.ok) console.log("日志尾部：\n" + report.logTail);

const checks = [
  ["编译成功", report.ok === true],
  ["报告了构建目录", report.buildDir !== ""],
  ["产物 .elf 存在", report.elf !== undefined && existsSync(report.elf.path)],
  ["解析出 RAM/FLASH 占用", report.memoryUsage.length >= 2],
  ["无错误行", report.errors.length === 0],
];
let failed = 0;
for (const [label, ok] of checks) {
  console.log((ok ? "PASS " : "FAIL ") + label);
  if (!ok) failed += 1;
}
process.exit(failed === 0 ? 0 : 1);
