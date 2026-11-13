/**
 * L3：长调试会话三件套（规格 §6）。
 *
 * - stm32_debug_session：显式申请会话（租约：空闲 90 s / 总 10 min），常驻的只有 openocd；
 * - stm32_debug_eval：在会话里跑 gdb 命令（P3 起优先用常驻 gdb MI 会话；连不上才退回临时 `gdb -batch`）；
 * - stm32_debug_stop：立刻释放探针。
 *
 * 会话在 `turn/end`（agent 输出结束、等待用户回复）时由 index.ts 自动关闭，因此在 VS Code 里按 F5 时
 * 探针一定是空闲的。build / flash / generate 动手前也会先让会话让出探针。
 */

import { F1_BREAKPOINT_BUDGET, quotaOf } from "../engine/breakpoints.js";
import { debugSessions } from "../engine/debug-session.js";

import { ensureToolchain, gateReportNotes } from "../engine/toolchain-gate.js";
import type { EvalReport, SessionReport } from "../engine/debug-session.js";
import type { GateResult } from "../engine/toolchain-gate.js";

import type { DshContext, JsonSchema, ToolExec } from "../types.js";
import { resolveProjectDir } from "./project-dir.js";

export const DEBUG_SESSION_TOOL = "stm32_debug_session";
export const DEBUG_EVAL_TOOL = "stm32_debug_eval";
export const DEBUG_STOP_TOOL = "stm32_debug_stop";

/** 断点预算三元组（B4）：与 stm32_debug_run 的报告同一个形状。 */
const quotaSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    used: { type: "number" },
    limit: { type: "number" },
    remaining: { type: "number" },
  },
  required: ["used", "limit", "remaining"],
};

export const sessionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    active: { type: "boolean" },
    sessionId: { type: "string" },
    port: { type: "number" },
    tclPort: { type: "number" },
    projectDir: { type: "string" },
    configFile: { type: "string" },
    elfPath: { type: "string" },
    startedAt: { type: "number" },
    idleTtlMs: { type: "number" },
    hardTtlMs: { type: "number" },
    remainingMs: { type: "number" },
    // B4：这次会话登记的断点数量与芯片上限（会话不跨 gdb 进程保存断点，但预算先校验）。
    breakpoints: quotaSchema,
    watchpoints: quotaSchema,
    errors: { type: "array", items: { type: "string" } },
    message: { type: "string" },
  },
  required: [
    "ok", "active", "sessionId", "port", "tclPort", "projectDir", "configFile", "elfPath", "startedAt",
    "idleTtlMs", "hardTtlMs", "remainingMs", "breakpoints", "watchpoints", "errors", "message",
  ],
};

export const outputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: { message: { type: "string" }, session: sessionSchema },
  required: ["message", "session"],
};

export const evalOutputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: { type: "string" },
    report: {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { type: "boolean" },
        output: { type: "string" },
        command: { type: "string" },
        durationMs: { type: "number" },
        remainingMs: { type: "number" },
        errors: { type: "array", items: { type: "string" } },
        message: { type: "string" },
      },
      required: ["ok", "output", "command", "durationMs", "remainingMs", "errors", "message"],
    },
  },
  required: ["message", "report"],
};

export const stopOutputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: { type: "string" },
    ok: { type: "boolean" },
    stopped: { type: "boolean" },
  },
  required: ["message", "ok", "stopped"],
};

/** 门禁档位参数：三个档位的说明文字与 build 工具保持一致。 */
const ENV_CHECK_SCHEMA: JsonSchema = {
  type: "string",
  enum: ["block", "warn", "off"],
  description: "工具链检查：block 缺件就拒绝（默认）、warn 只警告、off 不检查",
};

interface SessionArgs {
  projectDir?: string;
  elfPath?: string;
  port?: number;
  adapterSpeed?: number;
  configFile?: string;
  idleTtlMs?: number;
  hardTtlMs?: number;
  reset?: "none" | "halt" | "run";
  /** B4：这次会话打算用的断点（"main" / "watch:g_count"），起会话之前先对预算。 */
  breakpoints?: string[];
  binDirs?: string[];
  envCheck?: string;
}

/** stm32_debug_eval 的参数。单独一个类型是为了让 execute 能显式接受 undefined（审计 A31）。 */
interface EvalArgs {
  commands?: string[];
  expression?: string;
  keepHalted?: boolean;
  timeoutMs?: number;
}

function describeSession(report: SessionReport): string[] {
  const lines: string[] = [report.message];
  if (report.active) {
    const tclNote = report.tclPort > 0
      ? "（Tcl " + String(report.tclPort) + "，regs_read 走快路径）"
      : "（没有 Tcl 口，regs_read 走 gdb）";
    lines.push("会话 " + report.sessionId + "：端口 " + String(report.port) + tclNote + "，剩余租约 " + String(Math.ceil(report.remainingMs / 1000)) + " s（空闲 " + String(Math.round(report.idleTtlMs / 1000)) + " s / 总上限 " + String(Math.round(report.hardTtlMs / 1000)) + " s）");
    if (report.elfPath !== "") lines.push("符号：" + report.elfPath);
    lines.push("→ 用 stm32_debug_eval 执行 gdb 命令；用完 stm32_debug_stop 立刻还探针（turn 结束也会自动关）");
  }
  for (const error of report.errors.slice(0, 6)) lines.push("x " + error);
  return lines;
}

/**
 * 门禁拒绝时的会话报告。
 * sessionSchema 是 additionalProperties:false 且没有 notes，门禁的补充说明只能落在 errors 里
 * （首行就是 message，跳过以免重复）。
 */
function blockedSession(projectDir: string, gate: GateResult): SessionReport {
  return {
    ok: false, active: false, sessionId: "", port: 0, tclPort: 0, projectDir, configFile: "", elfPath: "",
    startedAt: 0, idleTtlMs: 0, hardTtlMs: 0, remainingMs: 0,
    breakpoints: quotaOf(0, F1_BREAKPOINT_BUDGET.code),
    watchpoints: quotaOf(0, F1_BREAKPOINT_BUDGET.data),
    owner: "",
    errors: gateReportNotes(gate).slice(1), message: gate.message,
  };
}

/**
 * 会话报告的对外副本（S91）：owner 是内部归属标记，只给 Web 面板判归属用，
 * 不进工具输出——sessionSchema 关了额外属性。
 */
type PublicSession = Omit<SessionReport, "owner">;

function publicSession(report: SessionReport): PublicSession {
  const { owner: _owner, ...rest } = report;
  return rest;
}

/** eval 没跑起来（多半是起会话失败）时的干净报告：字段一个不少，宿主 schema 才吃。 */
function failEvalReport(message: string, errors: string[]): EvalReport {
  return { ok: false, output: "", command: "", durationMs: 0, remainingMs: debugSessions.status().remainingMs, errors, message };
}

export function registerDebugSession(ctx: DshContext): void {
  ctx.tools.register({
    name: DEBUG_SESSION_TOOL,
    description:
      "显式开启长调试会话（租约：空闲 90 s、总上限 10 min），常驻进程只有 openocd，随后用 stm32_debug_eval 读取变量/寄存器/栈。turn 结束（agent 输出结束、等待用户回复）时自动关闭，保证在 VS Code 里随时可按 F5。短任务直接使用 stm32_debug_run，该工具在单次调用内开启并关闭会话。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectDir: { type: "string", description: "工程根目录；缺省为当前工作目录。" },
        elfPath: { type: "string", description: "调试符号 .elf；缺省自动找 build/<preset>/*.elf。" },
        port: { type: "number", description: "gdb server 端口；缺省 3333，占用则顺延。" },
        adapterSpeed: { type: "number", description: "adapter speed（kHz）。" },
        configFile: { type: "string", description: "openocd 配置文件（相对工程目录）。" },
        idleTtlMs: { type: "number", description: "空闲超时毫秒数，默认 90000。" },
        hardTtlMs: { type: "number", description: "总时长上限毫秒数，默认 600000。" },
        reset: { type: "string", enum: ["none", "halt", "run"], description: "起会话时对目标做什么，默认 none（不动芯片）。" },
        breakpoints: { type: "array", items: { type: "string" }, description: "这次会话打算用的断点（\"main\"、\"watch:g_count\"）：起会话之前先按芯片预算校验，F1 上限 6 个硬件断点 / 4 个观察点，超了不占探针直接失败。" },
        binDirs: { type: "array", items: { type: "string" }, description: "工具链目录候选。" },
        envCheck: ENV_CHECK_SCHEMA,
      },
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    output: {
      schema: outputSchema,
      render: (_args, value) => {
        const typed = value as { session: SessionReport };
        return [{ type: "text", text: describeSession(typed.session).join("\n") }];
      },
    },
    async execute(rawArgs: SessionArgs | undefined, exec: ToolExec) {
      // 宿主可能不传 arguments（无参数调用）→ 兜成 {}，让"缺参数"表现成正常报告而不是 TypeError（审计 A31）。
      const args = rawArgs ?? {};
      const resolution = await resolveProjectDir(ctx, args.projectDir, exec);
      const projectDir = resolution.projectDir;
      // 门禁：长调试会话同样要 openocd + GDB。开着会话再报"缺 openocd"只会让人以为探针坏了。
      const gate = await ensureToolchain(ctx, {
        capability: "debug",
        ...(args.binDirs === undefined ? {} : { binDirs: args.binDirs }),
        envCheck: args.envCheck,
        signal: exec.signal,
      });
      if (!gate.ok && gate.mode === "block") {
        return { message: gate.message, session: publicSession(blockedSession(resolution.projectDir, gate)) };
      }
      debugSessions.configure(ctx.subprocess, args.binDirs ?? []);
      const session = await debugSessions.start({
        projectDir,
        ...(args.elfPath === undefined ? {} : { elfPath: args.elfPath }),
        ...(args.port === undefined ? {} : { port: args.port }),
        ...(args.adapterSpeed === undefined ? {} : { adapterSpeed: args.adapterSpeed }),
        ...(args.configFile === undefined ? {} : { configFile: args.configFile }),
        ...(args.idleTtlMs === undefined ? {} : { idleTtlMs: args.idleTtlMs }),
        ...(args.hardTtlMs === undefined ? {} : { hardTtlMs: args.hardTtlMs }),
        ...(args.reset === undefined ? {} : { reset: args.reset }),
        ...(args.breakpoints === undefined ? {} : { breakpoints: args.breakpoints }),
        ...(args.binDirs === undefined ? {} : { binDirs: args.binDirs }),
        // A9：记下是谁开的会话，turn/end 只关自己的那个。
        ...(exec.agent?.id === undefined ? {} : { owner: exec.agent.id }),
      });
      void exec;
      const base = resolution.note === null ? session.message : session.message + "\n· " + resolution.note;
      // 会话报告的 schema 关了额外属性、又没有 notes 字段，warn 档只能把警告并回 message；
      // 而且 render 只打 session.message（不看外层 message），所以警告必须写进 session 里才看得见。
      session.message = gate.ok ? base : gate.message + "\n" + base;
      return { message: session.message, session: publicSession(session) };
    },
  });

  ctx.tools.register({
    name: DEBUG_EVAL_TOOL,
    description:
      "在调试会话里执行 gdb 命令（例如 \"print g_led_blink_count\"、\"info registers pc\"、\"bt\"、\"x/4xb 0x20000000\"）。B3 起没有会话时会先起一个（空闲 90 s 自动关、turn 结束也关）并复用该会话的 gdb server，不重复起 openocd。P3 起首次 eval 会启动一个常驻 gdb MI 进程（--interpreter=mi2）：断点/变量/栈跨调用保留，单条命令约 20–70 ms；MI 连不上（比如 VS Code 正连着）才退回每次 gdb -batch 的老路径（约 1.5 s）。continue/next/step/si/ni 走 MI 的 -exec-*（si/ni 是单指令步进），会等 *stopped 报「停在哪」（3 s 窗口）；目标在跑时下条命令先 -exec-interrupt 停下，不写 keepHalted 的命令结束会 monitor resume。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        commands: { type: "array", items: { type: "string" }, description: "gdb 命令列表，例如 [\"info registers pc sp\", \"bt\"]。" },
        expression: { type: "string", description: "单个表达式，等价于 commands:[\"print <expression>\"]。" },
        keepHalted: { type: "boolean", description: "true = 结束时不要 resume（默认会 resume，让芯片继续跑）。" },
        timeoutMs: { type: "number", description: "单次 gdb 超时毫秒数，默认 30000。" },
      },
    },
    timeoutMs: 90_000,
    isConcurrencySafe: () => false,
    output: {
      schema: evalOutputSchema,
      render: (_args, value) => {
        const typed = value as { report: EvalReport };
        const lines: string[] = [typed.report.ok ? "执行完成" : "执行有问题", typed.report.output.trim()];
        for (const error of typed.report.errors.slice(0, 6)) lines.push("x " + error);
        return [{ type: "text", text: lines.filter((line) => line !== "").join("\n") }];
      },
    },
    async execute(rawArgs: EvalArgs | undefined, exec: ToolExec) {
      // 同 A31：无参数调用按 {} 处理。未带 commands/expression 时引擎返回「未执行」报告，不视为失败。
      const args = rawArgs ?? {};
      // B3：eval 只复用会话里那个 gdb server，不另起 openocd（会话是唯一握着探针的进程）。
      // 没有会话时不偷偷起一个：探针是共享资源，起会话要显式（stm32_debug_session 或 stm32_regs_read）。
      const active = debugSessions.status();
      if (!active.active) {
        const message = "没有会话：先 stm32_debug_session 开一个（或用 stm32_debug_run 一次性跑）";
        return { message, report: failEvalReport(message, ["没有调试会话（eval 只复用会话里的 gdb server，不自己起 openocd）"]) };
      }
      const report = await debugSessions.eval({
        ...(args.commands === undefined ? {} : { commands: args.commands }),
        ...(args.expression === undefined ? {} : { expression: args.expression }),
        ...(args.keepHalted === undefined ? {} : { keepHalted: args.keepHalted }),
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
        signal: exec.signal,
      });
      return { message: report.message, report };
    },
  });

  ctx.tools.register({
    name: DEBUG_STOP_TOOL,
    description: "立刻关闭调试会话并释放探针（turn 结束时同样自动关闭；显式关闭更可靠，例如需要在 VS Code 里按 F5 之前）。",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    output: {
      schema: stopOutputSchema,
      render: (_args, value) => {
        const typed = value as { message: string };
        return [{ type: "text", text: typed.message }];
      },
    },
    async execute() {
      const stopped = await debugSessions.stop("调用方显式要求关闭");
      return { message: stopped.message, ok: stopped.ok, stopped: stopped.stopped };
    },
  });
}
