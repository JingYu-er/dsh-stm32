// A1/A2/A6 端到端：空目录 → 骨架 → CubeMX 生成 → 编译 → USER CODE 打补丁 → 编译 → 烧录 → 读计数器。
// 运行：node test/e2e-scaffold.mjs [目标目录]
// 需要能起子进程的环境（pwsh 工具下要 danger-full-access，否则 spawn EPERM）。
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { runBuild } from "../lib/engine/build.js";
import { patchUserCode } from "../lib/engine/code-patch.js";
import { runFlash } from "../lib/engine/flash.js";
import { runGenerate } from "../lib/engine/generate.js";
import { createProjectScaffold } from "../lib/engine/scaffold.js";
import { binDirs, e2eWorkDir } from "./fixtures.mjs";

const TARGET = resolve(process.argv[2] ?? e2eWorkDir("scaffold-blink"));
const CUBE_ROOT = process.env.STM32_CUBEMX_ROOT ?? "D:/app/STM32CubeMX";
const BIN = binDirs()[0];

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

const subprocess = makeSubprocess();
const log = (...parts) => console.log("[" + new Date().toISOString().slice(11, 19) + "]", ...parts);

/** 同步跑一条命令（只为本脚本自己用，不进宿主 subprocess 契约）。openocd 的日志在 stderr。 */
function sh(argv, cwd) {
  try {
    return execFileSync(argv[0], argv.slice(1), { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const detail = (error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "") + (error && typeof error === "object" && "stdout" in error ? String(error.stdout) : "");
    throw new Error("命令失败：" + argv.join(" ") + "\n" + detail);
  }
}

/** openocd 把日志写 stderr，execFileSync 只看 stdout 会丢；单独包一层。 */
function openocd(argv, cwd) {
  const { spawnSync } = process.getBuiltinModule("node:child_process");
  const result = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8", windowsHide: true });
  return (result.stdout ?? "") + (result.stderr ?? "");
}

// ── 1) 空目录 → 骨架 ───────────────────────────────────────────────────────────
rmSync(TARGET, { recursive: true, force: true });
mkdirSync(TARGET, { recursive: true });
log("骨架：", TARGET);
const scaffold = createProjectScaffold({ targetDir: TARGET, projectName: "blink", cubeMxRoots: [CUBE_ROOT] });
if (!scaffold.ok) throw new Error("建骨架失败：" + scaffold.message);
log("骨架 OK：", scaffold.templateFiles, "个工程文件 +", scaffold.driverFiles, "个固件文件，", scaffold.durationMs, "ms");

// ── 2) CubeMX 生成 Core/ ──────────────────────────────────────────────────────
log("generate 开始（CubeMX 无头，2–4 分钟）…");
const gen = await runGenerate(subprocess, {
  projectDir: TARGET,
  iocPath: scaffold.iocPath,
  cubeMxRoots: [CUBE_ROOT],
  timeoutMs: 8 * 60_000,
  onProgress: (line) => {
    if (/progress|succesfully|Error/i.test(line)) log("  gen:", line.slice(0, 160));
  },
});
log("generate:", gen.ok, gen.message, gen.durationMs + "ms");
if (!gen.ok) throw new Error("generate 失败：" + gen.message + "\n" + gen.logTail);
for (const file of gen.files) if (file.target.endsWith("main.c")) log("  main.c:", file.action, "preserved=", file.preserved.join(","));

// ── 3) 首次编译 ───────────────────────────────────────────────────────────────
log("build #1 …");
const build1 = await runBuild(subprocess, { projectDir: TARGET, binDirs: [BIN] });
log("build #1:", build1.ok, build1.message);
if (!build1.ok) throw new Error("build #1 失败：\n" + build1.logTail);

// ── 4) USER CODE 打补丁（A2：只改块内）────────────────────────────────────────
const mainC = join(TARGET, "Core/Src/main.c");
const text = readFileSync(mainC, "utf8");
if (!text.includes("/* USER CODE BEGIN 3 */")) throw new Error("main.c 没有 USER CODE 3 块，生成结构异常");
const pv = patchUserCode({
  projectDir: TARGET,
  file: "Core/Src/main.c",
  block: "PV",
  code: "volatile uint32_t g_e2e_count = 0;",
});
if (!pv.ok) throw new Error("patch PV 失败：" + pv.message);
const loop = patchUserCode({
  projectDir: TARGET,
  file: "Core/Src/main.c",
  block: "3",
  // 块 3 的原有内容里夹着 while(1) 的收尾 }，只能 append（replace 会被结构行守卫拒绝）。
  mode: "append",
  code: "    g_e2e_count++;\n    for (volatile uint32_t spin = 0; spin < 200000u; spin++) { }",
});
if (!loop.ok) throw new Error("patch 3 失败：" + loop.message);
log("patch OK：PV + 3，备份", loop.backupPath);

// ── 5) 二次编译 + 找符号地址 ──────────────────────────────────────────────────
log("build #2 …");
const build2 = await runBuild(subprocess, { projectDir: TARGET, binDirs: [BIN] });
log("build #2:", build2.ok, build2.message);
if (!build2.ok) throw new Error("build #2 失败：\n" + build2.logTail);
const elf = build2.elf?.path ?? join(TARGET, "build/Debug/blink.elf");
const nm = sh([join(BIN, "arm-none-eabi-nm.exe"), elf], TARGET);
const symbolLine = nm.split(/\r?\n/u).find((line) => line.endsWith(" g_e2e_count"));
if (symbolLine === undefined) throw new Error("nm 里没有 g_e2e_count：\n" + nm.slice(0, 500));
const address = symbolLine.trim().split(/\s+/u)[0];
log("g_e2e_count @", address);

// ── 6) 烧录（A3：只烧录，不进调试）────────────────────────────────────────────
log("flash …");
const flash = await runFlash(subprocess, { projectDir: TARGET, binDirs: [BIN] });
log("flash:", flash.ok, flash.message, "programmed=", flash.programmed, "verified=", flash.verified);
if (!flash.ok) throw new Error("flash 失败：" + flash.message + "\n" + flash.logTail);

// ── 7) 读计数器两次（A6：有证据，不靠"看起来好了"）─────────────────────────────
const readCount = () =>
  openocd([join(BIN, "openocd.exe"), "-f", "interface/cmsis-dap.cfg", "-f", "target/stm32f1x.cfg",
    // openocd 的 mdw 只吃 0x 前缀地址；nm 给的是裸十六进制。
    "-c", "init", "-c", "mdw 0x" + address + " 1", "-c", "resume", "-c", "shutdown"], TARGET);
const sample1 = readCount();
await new Promise((r) => setTimeout(r, 700));
const sample2 = readCount();
const parse = (out) => Number.parseInt((out.match(/0x[0-9a-f]{8}:\s+([0-9a-f]{8})/u) ?? [])[1] ?? "NaN", 16);
const v1 = parse(sample1);
const v2 = parse(sample2);
log("计数器：", v1, "→", v2);
if (!(Number.isFinite(v1) && Number.isFinite(v2) && v2 > v1)) {
  throw new Error("计数器没有增长（" + v1 + " → " + v2 + "）：\n" + sample1 + "\n---\n" + sample2);
}

log("A1/A2/A3/A6 全部通过：空目录 → 骨架 → 生成 → 编译 → 补丁 → 编译 → 烧录 → 计数器 " + v1 + " → " + v2);
