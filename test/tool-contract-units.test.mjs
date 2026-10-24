/**
 * 工具入口契约的离线单测：洞 A（缺省工程目录）、洞 C（参数写错要给人话）、洞 D 的纯函数部分。
 *
 * 不起任何进程：subprocess 桩在 spawn 时直接抛错，openocd/gdb 一律没机会跑。
 * 运行：node test\tool-contract-units.test.mjs（不要用 node --test，沙箱下它会 spawn 失败）
 */

import { registerCodePatch } from "../lib/tools/code-patch.js";
import { registerRegsRead } from "../lib/tools/regs.js";
import { registerIocInspect } from "../lib/tools/ioc-inspect.js";
import { resolveProjectDir, validateToolArgs } from "../lib/tools/project-dir.js";
import { debugSessions, normalizeHexAddress, parseGdbPrintedHex } from "../lib/engine/debug-session.js";

let pass = 0;
let fail = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass += 1;
      console.log("PASS " + name);
    })
    .catch((error) => {
      fail += 1;
      console.log("FAIL " + name + " -> " + (error instanceof Error ? error.message : String(error)));
    });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const signal = () => new AbortController().signal;

function makeToolContext(workdir) {
  const tools = new Map();
  const subprocess = {
    spawn() {
      throw new TypeError("spawn 被离线单测禁用");
    },
    async resolveExecutable() {
      throw new Error("resolveExecutable 被离线单测禁用");
    },
  };
  const ctx = {
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {}; } },
    subprocess,
    get(name) {
      if (name === "subprocess") return subprocess;
      if (name === "workingDirectory") {
        if (workdir === undefined) return undefined;
        if (workdir instanceof Error) {
          return { ensure: async () => { throw workdir; } };
        }
        return { ensure: async () => workdir };
      }
      return undefined;
    },
  };
  return { ctx, tools };
}

// ---------------- 洞 A：缺省工程目录 ----------------

await check("resolveProjectDir：显式目录优先，且不带说明", async () => {
  const { ctx } = makeToolContext("D:/session");
  const resolved = await resolveProjectDir(ctx, "D:/explicit", { signal: signal() });
  assert(resolved.projectDir === "D:/explicit", "应当用显式目录，实际 " + resolved.projectDir);
  assert(resolved.note === null, "显式目录不该产生说明");
  assert(resolved.fallbackToProcessCwd === false, "显式目录不算回退");
});

await check("resolveProjectDir：缺省取会话工作目录并说明来源", async () => {
  const { ctx } = makeToolContext("D:/session");
  const resolved = await resolveProjectDir(ctx, undefined, { signal: signal() });
  assert(resolved.projectDir === "D:/session", "应当用会话工作目录，实际 " + resolved.projectDir);
  assert(typeof resolved.note === "string" && resolved.note.includes("会话工作目录"), "说明里应当写清来源：" + resolved.note);
  assert(resolved.fallbackToProcessCwd === false, "会话目录不算回退");
});

await check("resolveProjectDir：拿不到会话目录时退回进程 cwd 并警告", async () => {
  const { ctx } = makeToolContext(undefined);
  const resolved = await resolveProjectDir(ctx, undefined, { signal: signal() });
  assert(resolved.projectDir === process.cwd(), "应当退回插件进程 cwd，实际 " + resolved.projectDir);
  assert(resolved.fallbackToProcessCwd === true, "必须标出这是回退");
  assert(resolved.note !== null && resolved.note.includes("projectDir"), "警告里应当教用户显式传 projectDir：" + resolved.note);
});

await check("resolveProjectDir：workingDirectory.ensure 抛错也不炸", async () => {
  const { ctx } = makeToolContext(new Error("宿主还没打开目录"));
  const resolved = await resolveProjectDir(ctx, undefined, { signal: signal() });
  assert(resolved.fallbackToProcessCwd === true, "抛错也要走回退");
  assert(resolved.note !== null && resolved.note.includes("宿主还没打开目录"), "说明里应带上失败原因：" + resolved.note);
});

await check("stm32_ioc_inspect：省略 projectDir 时用会话工作目录找 .ioc", async () => {
  const { ctx, tools } = makeToolContext("D:/dsh-session-probe-not-exist");
  registerIocInspect(ctx);
  const definition = tools.get("stm32_ioc_inspect");
  assert(definition !== undefined, "工具没注册");
  const value = await definition.execute({}, { signal: signal() });
  assert(value.found === false, "不存在的目录里不该找到 .ioc");
  assert(value.message.includes("D:/dsh-session-probe-not-exist") || value.message.includes("dsh-session-probe-not-exist"),
    "报错信息里应当出现会话目录（证明没退回插件进程 cwd）：" + value.message);
});

// ---------------- 洞 C：参数校验 ----------------

await check("validateToolArgs：缺参时给出缺哪个的中文说明", async () => {
  const message = validateToolArgs("stm32_code_patch", { edits: [] }, [
    { name: "file", kind: "string" },
    { name: "block", kind: "string" },
    { name: "code", kind: "string" },
  ]);
  assert(message !== null, "缺参必须报错");
  assert(message.includes("缺少 file、block、code"), "要点名缺什么：" + message);
  assert(message.includes("必填参数"), "要顺带说清必填参数有哪些：" + message);
});

await check("validateToolArgs：类型不对时点名而不是静默", async () => {
  const message = validateToolArgs("stm32_regs_read", { addresses: "0x4001100C" }, [{ name: "addresses", kind: "string[]" }]);
  assert(message !== null, "类型不对必须报错");
  assert(message.includes("addresses 的类型不对"), "要点名哪个参数类型不对：" + message);
});

await check("validateToolArgs：参数齐全返回 null", async () => {
  const message = validateToolArgs("stm32_code_patch", { file: "Core/Src/main.c", block: "3", code: "int x = 0;" }, [
    { name: "file", kind: "string" },
    { name: "block", kind: "string" },
    { name: "code", kind: "string" },
  ]);
  assert(message === null, "参数齐全不该报错：" + String(message));
});

await check("stm32_code_patch 缺参：报告字段齐全、提示可读（不再让宿主报 is not lossless JSON）", async () => {
  const { ctx, tools } = makeToolContext("D:/proj");
  registerCodePatch(ctx);
  const definition = tools.get("stm32_code_patch");
  const value = await definition.execute({ edits: [{ range: "1-2" }] }, { signal: signal() });
  assert(value.report.ok === false, "缺参应当失败");
  for (const key of ["ok", "file", "block", "mode", "labels", "linesBefore", "linesAfter", "errors", "message"]) {
    assert(value.report[key] !== undefined, key + " 不能是 undefined（否则宿主序列化会报 value is not lossless JSON）");
  }
  assert(value.message.includes("缺少 file、block、code"), "提示里要写清缺什么：" + value.message);
  assert(value.report.errors.length === 1, "错误列表里要有一条原因");
});

await check("stm32_regs_read 缺 addresses：可读报错，且报告字段齐全", async () => {
  const { ctx, tools } = makeToolContext("D:/proj");
  registerRegsRead(ctx);
  const definition = tools.get("stm32_regs_read");
  const value = await definition.execute({}, { signal: signal() });
  assert(value.report.ok === false, "缺参应当失败");
  assert(value.message.includes("缺少 addresses"), "提示里要写清缺 addresses：" + value.message);
  for (const key of ["ok", "projectDir", "configFile", "command", "script", "pc", "samples", "durationMs", "errors", "message", "logTail", "notes"]) {
    assert(value.report[key] !== undefined, key + " 不能是 undefined");
  }
});

// ---------------- 洞 D：gdb 输出的纯函数部分 ----------------

await check("parseGdbPrintedHex：按出现顺序取 print/x 的十六进制值", async () => {
  const output = ["$1 = 0x0800024c", "$2 = 0x4001100c", "Cannot access memory at address 0x10", "$3 = 0x0"].join("\n");
  const values = parseGdbPrintedHex(output);
  assert(JSON.stringify(values) === JSON.stringify(["0x0800024c", "0x4001100c", "0x0"]), "解析结果不对：" + JSON.stringify(values));
});

await check("parseGdbPrintedHex：没有打印值的输出返回空数组", async () => {
  assert(parseGdbPrintedHex("Remote communication error. Target disconnected.").length === 0, "没有 $N = 0x.. 时应当为空");
});

await check("normalizeHexAddress：补 0x、补零、小写；非法返回 null", async () => {
  assert(normalizeHexAddress("4001100C") === "0x4001100c", "应当补 0x 并小写");
  assert(normalizeHexAddress(" 0x4001100C ") === "0x4001100c", "应当容忍空白与已有 0x");
  assert(normalizeHexAddress("0x24C") === "0x0000024c", "应当补足 8 位");
  assert(normalizeHexAddress("GPIOC_ODR") === null, "非地址必须返回 null");
  assert(normalizeHexAddress("0x4001100CCC") === null, "超过 32 位必须返回 null");
});

await check("readWords：没有调试会话时返回可读错误而不是抛异常", async () => {
  const result = await debugSessions.readWords({ addresses: ["0x4001100C"] });
  assert(result.ok === false, "没有会话不该成功");
  assert(result.errors.some((item) => item.includes("没有调试会话")), "错误里要点明没有会话：" + result.errors.join(" | "));
  assert(result.samples.length === 0, "没有会话时不该编造采样值");
});

console.log("\ntool-contract-units: " + pass + " pass / " + fail + " fail");
process.exitCode = fail === 0 ? 0 : 1;
