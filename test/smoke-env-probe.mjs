/**
 * 冒烟测试：用真实子进程验证 stm32_env_probe。
 *
 * 宿主 subprocess 服务在普通 node 里不可用，这里用 child_process 实现同一份契约
 * （spawn -> { done, collected, terminate, waitForExit }），从而验证：
 *   1) lib/index.js 能被干净加载（无第三方依赖、无 asar 依赖）；
 *   2) apply() 注册工具、execute() 真的调起 gcc/gdb/openocd/cmake/ninja 并解析版本；
 *   3) 输出满足声明的 output schema 形状。
 *
 * 运行：node test/smoke-env-probe.mjs
 */
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

function collectedReader(getText) {
  return { readFrom: () => ({ text: getText(), lossy: false, nextOffset: getText().length }) };
}

function realSpawn(spec) {
  // 复刻宿主 dsh-subprocess-local 的严格性：cwd 缺失时它会抛 TypeError，这里也要抛，
  // 否则本地测试会掩盖插件在真实宿主里的失败。
  if (typeof spec.cwd !== "string") {
    throw new TypeError("Cannot read properties of undefined (reading 'includes')");
  }
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolveDone, rejectDone) => {
    child.once("error", (error) => rejectDone(error));
    child.once("close", (code, signal) => resolveDone({ exitCode: code, signal }));
  });
  return {
    done,
    collected: { stdout: collectedReader(() => stdout), stderr: collectedReader(() => stderr) },
    terminate() { try { child.kill(); } catch { /* 已退出 */ } },
    async waitForExit() { await done.catch(() => undefined); },
  };
}

const subprocess = {
  spawn: realSpawn,
  async resolveExecutable(command) {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("where.exe", [command], { encoding: "utf8" });
    const first = out.split(/\r?\n/).find((line) => line.trim() !== "");
    if (!first) throw new Error("not found: " + command);
    return first.trim();
  },
};

const plugin = await import(pathToFileURL(resolve(import.meta.dirname, "..", "lib", "index.js")).href);
const registered = [];
const ctx = {
  tools: { register: (tool) => { registered.push(tool); return () => {}; } },
  subprocess,
  get: (name) => (name === "subprocess" ? subprocess : undefined),
};
plugin.apply(ctx);

const envProbe = registered.find((tool) => tool.name === "stm32_env_probe");
if (envProbe === undefined) {
  console.error("FAIL: 没注册 stm32_env_probe：" + JSON.stringify(registered.map((t) => t.name)));
  process.exit(1);
}
console.log("已注册工具:", registered.map((t) => t.name).join(", "));

const value = await envProbe.execute({}, { signal: new AbortController().signal });
const required = value.tools.filter((tool) => tool.required);
const missing = required.filter((tool) => !tool.found);
console.log("summary:", value.summary);
for (const tool of value.tools) {
  console.log((tool.found ? "  OK   " : "  MISS ") + tool.id + (tool.version ? "  " + tool.version : ""));
}
if (missing.length > 0) {
  console.error("FAIL: 必需组件缺失：" + missing.map((t) => t.id + " (" + t.error + ")").join("; "));
  process.exit(1);
}
if (typeof value.summary !== "string" || !Array.isArray(value.tools) || !Array.isArray(value.missingRequired)) {
  console.error("FAIL: 输出形状不符");
  process.exit(1);
}
console.log("PASS: 真实进程探测通过（必需组件 " + String(required.length) + " 项全部找到）");
