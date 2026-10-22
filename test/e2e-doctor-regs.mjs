// 端到端：真机跑 stm32_doctor 与 stm32_regs_read 的引擎（只读，不写 Flash）。
// 用法：node test/e2e-doctor-regs.mjs [工程目录]
import { spawn } from "node:child_process";

import { runDoctor } from "../lib/engine/doctor.js";
import { runRegsRead } from "../lib/engine/regs.js";
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
const subprocess = makeSubprocess();
let failed = 0;
const checks = [];
function check(label, ok) {
  checks.push([label, ok]);
}

console.log("==== doctor");
const doctor = await runDoctor(subprocess, { projectDir, port: 3333 });
console.log("ok=" + String(doctor.ok) + " message=" + doctor.message + " 耗时=" + ((doctor.durationMs / 1000).toFixed(1)) + " s");
for (const tool of doctor.tools) console.log("  " + (tool.found ? "OK  " : "MISS") + " " + tool.id + " " + tool.version);
console.log("进程=" + doctor.processes.map((p) => p.name + "(" + p.pid + ")").join(" ") + " 端口占用=" + String(doctor.portBusy));
console.log("固件=" + doctor.elfPath + " .ioc=" + doctor.iocPath + " 告警=" + String(doctor.iocWarnings.length));
for (const blocker of doctor.blockers) console.log("! " + blocker);
for (const note of doctor.notes) console.log("· " + note);
check("doctor ok", doctor.ok === true);
check("doctor 没漏必需组件", doctor.missingRequired.length === 0);
check("doctor 找到固件", doctor.elfPath.endsWith(".elf"));
check("doctor 没把 .ioc 报成致命", doctor.iocWarnings.length === 0);

console.log("");
console.log("==== regs_read（第一次）");
const first = await runRegsRead(subprocess, { projectDir, addresses: ["0x40010004", "0x4001100C", "0x20000028"], timeoutMs: 30000 });
console.log("ok=" + String(first.ok) + " message=" + first.message + " 耗时=" + ((first.durationMs / 1000).toFixed(1)) + " s");
console.log("pc=" + first.pc);
for (const sample of first.samples) console.log("  " + sample.address + " = " + (sample.ok ? sample.value : "读不到"));
check("regs ok", first.ok === true);
check("regs 读到 AFIO_MAPR", first.samples.find((s) => s.address === "0x40010004")?.ok === true);
check("regs 读到 pc", first.pc.startsWith("0x"));
// AFIO_MAPR 的 SWJ_CFG 在 bit26:24：000=全开、010=只有 SWD（Serial Wire）、100=全关。
// demo 用 Serial Wire，所以正常值是 0x02000000；只有 100 才是"调试口被关"。
const mapr = first.samples.find((s) => s.address === "0x40010004");
const swjCfg = mapr === undefined ? -1 : (Number.parseInt(mapr.value, 16) >> 24) & 0x7;
check("SWD 没被关（SWJ_CFG=" + String(swjCfg) + "，非 4）", mapr !== undefined && swjCfg !== 4);

await new Promise((r) => setTimeout(r, 700));
console.log("");
console.log("==== regs_read（700 ms 后再读 GPIOC_ODR）");
const second = await runRegsRead(subprocess, { projectDir, addresses: ["0x4001100C"], timeoutMs: 30000 });
console.log("ok=" + String(second.ok) + " ODR=" + (second.samples[0]?.value ?? "读不到"));
check("第二次 regs ok", second.ok === true);
check("固件在跑（GPIOC_ODR 读到 PC13 电平）", (second.samples[0]?.value ?? "") !== "");

// 收尾必须是 resume 而不是 reset run：reset run 会把芯片复位，固件里的计数器从头开始，
// "只读一眼"就带了副作用。demo 的 g_led_blink_count 在 0x2000002C（符号地址随链接变化，
// 这里按 demo 当前 .elf 取值），两次读之间隔 1.2 s，计数器必须单调增长且不归零。
console.log("");
console.log("==== regs_read ×2：确认读值不扰动固件（计数器不被复位）");
const counterBefore = await runRegsRead(subprocess, { projectDir, addresses: ["0x2000002C"], timeoutMs: 30000 });
const countBefore = Number.parseInt(counterBefore.samples[0]?.value ?? "", 16);
await new Promise((r) => setTimeout(r, 1200));
const counterAfter = await runRegsRead(subprocess, { projectDir, addresses: ["0x2000002C"], timeoutMs: 30000 });
const countAfter = Number.parseInt(counterAfter.samples[0]?.value ?? "", 16);
console.log("g_led_blink_count " + String(countBefore) + " → " + String(countAfter));
check("计数器在增长（芯片在跑）", Number.isFinite(countBefore) && Number.isFinite(countAfter) && countAfter > countBefore);
check("两次读之间没有复位（计数器没有归零）", Number.isFinite(countBefore) && countBefore > 20 && countAfter > countBefore);

console.log("");
for (const [label, ok] of checks) {
  console.log((ok ? "PASS " : "FAIL ") + label);
  if (!ok) failed += 1;
}
process.exit(failed === 0 ? 0 : 1);
