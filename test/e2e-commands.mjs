// 端到端：真实跑五条斜杠命令的 handler（会烧板子、会起调试会话，跑完自动释放探针）。
// 用法：node test/e2e-commands.mjs [工程目录]
import { spawn } from "node:child_process";

import { registerCommands } from "../lib/commands/register.js";
import { debugSessions } from "../lib/engine/debug-session.js";
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
const commands = new Map();
const ctx = {
  tools: { register() {} },
  subprocess,
  get(name) {
    if (name === "subprocess") return subprocess;
    if (name === "workingDirectory") return { ensure: async () => projectDir };
    return undefined;
  },
  commands: { register: (definition) => { commands.set(definition.name, definition); return () => {}; } },
};
registerCommands(ctx);

const invocation = (rawInput = "") => ({ commandId: "e2e", agent: { id: "e2e" }, rawInput, signal: new AbortController().signal });
const checks = [];
const run = async (name, raw, expectKind, mustInclude) => {
  const startedAt = Date.now();
  const result = await commands.get(name).handler(invocation(raw));
  const took = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("\n===== /" + name + " （" + took + " s, kind=" + result.kind + "）=====");
  console.log(result.text ?? "(无文本)");
  checks.push(["/" + name + " 返回 " + expectKind, result.kind === expectKind]);
  for (const needle of mustInclude) checks.push(["/" + name + " 文本含 \"" + needle + "\"", (result.text ?? "").includes(needle)]);
  return result;
};

try {
  await run("stm32-doctor", "", "success", ["体检通过", "工具链"]);
  await run("stm32-build", "", "success", ["编译成功"]);
  await run("stm32-debug", "", "success", ["烧录成功", "调试：停在", "main"]);
  const stop = await run("stm32-stop", "", "success", []);
  checks.push(["/stm32-stop 关掉了会话", (stop.text ?? "").includes("关闭") || (stop.text ?? "").includes("没有会话")]);
  await run("stm32-flash", "", "success", ["烧录成功", "校验=是"]);
} finally {
  const closed = await debugSessions.stop("e2e 收尾");
  if (closed.stopped) console.log("\n收尾：" + closed.message);
}

let failed = 0;
console.log("\n---- 断言 ----");
for (const [label, ok] of checks) {
  console.log((ok ? "PASS " : "FAIL ") + label);
  if (!ok) failed += 1;
}
console.log("e2e-commands: " + (checks.length - failed) + "/" + checks.length + " PASS");
process.exit(failed === 0 ? 0 : 1);
