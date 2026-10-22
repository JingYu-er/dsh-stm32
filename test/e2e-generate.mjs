// 端到端：真实调 STM32CubeMX（3–4 分钟）在工程副本上生成，并校验落位 / USER CODE / 备份。
// 运行：node test/e2e-generate.mjs <工程副本目录>
// 需要能起子进程的环境（pwsh 工具下要 danger-full-access，否则 spawn EPERM）。
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, sep as jsep } from "node:path";

import { runGenerate } from "../lib/engine/generate.js";
import { e2eProject } from "./fixtures.mjs";

const SOURCE_PROJECT = e2eProject({ argv: false });
// 只复制 generate 真正需要的东西：.ioc 与 Core/**（落位与 USER CODE 合并都只碰这里）。
// 复制整个工程会把 Drivers/.npm-cache 上千个文件拖进沙箱逐个写入，慢到没法测。
const COPY_ROOT_FILES = ["demo.ioc", ".mxproject", "CMakeLists.txt"];
const COPY_DIRS = ["Core"];

/** 复刻宿主 subprocess 契约的最小实现（cwd 必填、collected.readFrom 偏移读取）。 */
function makeSubprocess() {
  return {
    resolveExecutable(command) {
      return command;
    },
    spawn(spec) {
      if (typeof spec.cwd !== "string") throw new TypeError("Cannot read properties of undefined (reading 'includes')");
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
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
          const text = buffers[key].slice(offset);
          return { text, nextOffset: buffers[key].length, lossy: false };
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

/** 自己实现递归复制：目标目录在源目录内部时 fs.cpSync 会直接报 ERR_FS_CP_EINVAL。 */
function copyProject(target) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const walk = (rel) => {
    const srcDir = join(SOURCE_PROJECT, rel);
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      const childRel = rel === "" ? entry.name : join(rel, entry.name);
      if (entry.isDirectory()) {
        mkdirSync(join(target, childRel), { recursive: true });
        walk(childRel);
      } else if (entry.isFile()) {
        copyFileSync(join(SOURCE_PROJECT, childRel), join(target, childRel));
      }
    }
  };
  for (const name of COPY_ROOT_FILES) {
    const abs = join(SOURCE_PROJECT, name);
    if (existsSync(abs)) copyFileSync(abs, join(target, name));
  }
  for (const name of COPY_DIRS) walk(name);
}

function countFiles(dir) {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFiles(join(dir, entry.name));
    else count += 1;
  }
  return count;
}

const target = resolve(process.argv[2] ?? join(SOURCE_PROJECT, ".tmp-e2e"));
console.log("工程副本：" + target);
copyProject(target);
console.log("已复制 " + String(countFiles(target)) + " 个文件");

const startedAt = Date.now();
const progress = [];
const report = await runGenerate(makeSubprocess(), {
  projectDir: target,
  onProgress: (line) => {
    progress.push(line);
    if (/命令|脚本|布局|生成|ERROR|Error|失败|超时|…CubeMX/u.test(line)) console.log("[进度] " + line.slice(0, 220));
  },
});

console.log("---- 报告 ----");
console.log("ok=" + String(report.ok) + " layout=" + report.layout + " 耗时=" + ((Date.now() - startedAt) / 1000).toFixed(1) + " s");
console.log("message=" + report.message);
for (const file of report.files) console.log("  " + file.action.padEnd(30) + file.target + "  保活=" + file.preserved.join(",") + " 未搬运=" + file.droppedLabels.join(","));
for (const note of report.notes) console.log("· " + note);
if (!report.ok) {
  console.log("日志尾部：\n" + report.logTail);
  process.exit(1);
}

const mainC = readFileSync(join(target, "Core", "Src", "main.c"), "utf8");
/**
 * Windows 上目录被 rm 后可能处于 "delete pending"：名字还能解析（existsSync 为 true），
 * 但枚举时已经看不到。用轮询消除这种假阴性。
 */
function waitGone(absPath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(absPath)) return true;
    const root = resolve(absPath, "..");
    if (!readdirSync(root).includes(absPath.split(jsep).pop())) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  return !existsSync(absPath);
}
const checks = [
  ["USER CODE 3 的闪烁代码被保活", mainC.includes("g_led_blink_count++") && mainC.includes("HAL_Delay(500);")],
  ["coupled 布局：MX_GPIO_Init 在 main.c 内", mainC.includes("static void MX_GPIO_Init(void)")],
  ["生成用的 Src/ 已被清理", waitGone(join(target, "Src"))],
  ["生成用的 Inc/ 已被清理", waitGone(join(target, "Inc"))],
  ["备份目录存在且含被覆盖文件", report.backupDir !== "" && existsSync(join(report.backupDir, "Core", "Src", "main.c"))],
  ["other 文件未被 Src 顶替（Core/Inc/main.h 仍在）", existsSync(join(target, "Core", "Inc", "main.h"))],
];
let failed = 0;
for (const [label, ok] of checks) {
  console.log((ok ? "PASS " : "FAIL ") + label);
  if (!ok) failed += 1;
}
console.log("progress lines=" + String(progress.length));
process.exit(failed === 0 ? 0 : 1);
