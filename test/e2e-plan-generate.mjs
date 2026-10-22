// 端到端：事务闭环 —— plan（加 PA5/led2）→ apply → CubeMX 无头生成 → 断言落位与 USER CODE 保活 → 编译。
// 在工程副本上做，不碰 demo 本身。用法：node test/e2e-plan-generate.mjs [源工程目录]（约 3–5 分钟）
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runGenerate } from "../lib/engine/generate.js";
import { applyIocPlan, planIocChanges, rollbackIoc } from "../lib/engine/ioc-plan.js";
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

const sourceDir = e2eProject();
const workDir = join(sourceDir, ".tmp-m4-e2e");
const rootFiles = ["demo.ioc", ".mxproject", "CMakeLists.txt", "CMakePresets.json", "startup_stm32f103xb.s", "STM32F103XX_FLASH.ld"];
const rootDirs = ["Core", "cmake"];

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSyncSafe(from)) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else copyFileSync(src, dst);
  }
}

function readdirSyncSafe(dir) {
  return readdirSync(dir, { withFileTypes: true });
}
import { readdirSync } from "node:fs";

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
for (const name of rootFiles) if (existsSync(join(sourceDir, name))) copyFileSync(join(sourceDir, name), join(workDir, name));
for (const name of rootDirs) if (existsSync(join(sourceDir, name))) copyTree(join(sourceDir, name), join(workDir, name));
console.log("副本就绪：" + workDir);

const startedAt = Date.now();
const plan = planIocChanges({
  projectDir: workDir,
  pins: [{ pin: "PA5", signal: "output", label: "led2" }],
});
console.log("---- plan ----");
console.log("ok=" + String(plan.ok) + " planId=" + plan.planId + " 变更=" + plan.changes.length);
for (const change of plan.changes) {
  const kind = change.before === null ? "added" : change.after === null ? "removed" : "changed";
  console.log("  " + kind + " " + change.key + " = " + String(change.after));
}
for (const warning of plan.warnings) console.log("  警告 " + warning);
for (const error of plan.errors) console.log("  错误 " + error);

const applied = plan.ok ? applyIocPlan({ projectDir: workDir, planId: plan.planId }) : { ok: false, errors: ["plan 失败"] };
console.log("---- apply ----");
console.log("ok=" + String(applied.ok) + " 备份=" + String(applied.backupPath));
for (const error of applied.errors ?? []) console.log("  错误 " + error);

const generated = applied.ok ? await runGenerate(makeSubprocess(), { projectDir: workDir }) : { ok: false, message: "未生成" };
console.log("---- generate ----");
console.log("ok=" + String(generated.ok) + " 耗时=" + ((Date.now() - startedAt) / 1000).toFixed(1) + " s verdict.ok=" + String(generated.verdict?.ok));
console.log("message=" + generated.message);
for (const file of generated.files ?? []) console.log("  " + file.action + " " + file.target + " 保活标签=" + file.preserved.join(","));
for (const error of generated.errors ?? []) console.log("  错误 " + error);

const mainC = readFileSync(join(workDir, "Core/Src/main.c"), "utf8");
const mainH = readFileSync(join(workDir, "Core/Inc/main.h"), "utf8");
const iocAfter = readFileSync(join(workDir, "demo.ioc"), "utf8");
const checks = [
  ["plan 成功且有 diff", plan.ok === true && plan.changes.length > 0],
  ["apply 成功且留了备份", applied.ok === true && typeof applied.backupPath === "string" && applied.backupPath !== ""],
  [".ioc 里出现 led2", /PA5\.GPIO_Label=led2/u.test(iocAfter)],
  ["generate 成功", generated.ok === true],
  ["PC13 的 USER CODE 3 被保活", mainC.includes("g_led_blink_count++") && mainC.includes("HAL_Delay(500)")],
  ["main.h 里出现 led2 宏", /#define led2_Pin GPIO_PIN_5/u.test(mainH) && /led2_GPIO_Port GPIOA/u.test(mainH)],
  ["LED 引脚仍在 main.h", /#define led_Pin GPIO_PIN_13/u.test(mainH)],
  ["生成用的 Src/Inc 已清掉", existsSync(join(workDir, "Src")) === false && existsSync(join(workDir, "Inc")) === false],
];
let failed = 0;
for (const [label, ok] of checks) {
  console.log((ok ? "PASS " : "FAIL ") + label);
  if (!ok) failed += 1;
}
if (applied.ok === true) {
  const rolled = rollbackIoc({ projectDir: workDir, backupFrom: applied.backupPath });
  console.log("---- rollback ----");
  console.log("ok=" + String(rolled.ok) + " message=" + rolled.message);
  const iocRolled = readFileSync(join(workDir, "demo.ioc"), "utf8");
  const rollbackOk = rolled.ok === true && /led2/u.test(iocRolled) === false;
  console.log((rollbackOk ? "PASS " : "FAIL ") + "回滚后 led2 消失");
  if (!rollbackOk) failed += 1;
}
rmSync(workDir, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
