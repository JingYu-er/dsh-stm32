/**
 * L3：长调试会话三件套（规格 §6）。
 *
 * - stm32_debug_session：显式申请会话（租约：空闲 90 s / 总 10 min），常驻的只有 openocd；
 * - stm32_debug_eval：在会话里跑 gdb 命令（临时 `gdb -batch` 连上去，跑完 monitor resume + detach）；
 * - stm32_debug_stop：立刻释放探针。
 *
 * 会话在 `turn/end`（agent 输出完、等你回复）时由 index.ts 自动关掉，所以你想在 VS Code 里按 F5 时
 * 探针一定是空闲的。build / flash / generate 动手前也会先让会话让出探针。
 */

import { debugSessions } from "../engine/debug-session.js";
import type { EvalReport, SessionReport } from "../engine/debug-session.js";

import type { DshContext, JsonSchema, ToolExec } from "../types.js";
import { resolveProjectDir } from "./project-dir.js";

export const DEBUG_SESSION_TOOL = "stm32_debug_session";
export const DEBUG_EVAL_TOOL = "stm32_debug_eval";
export const DEBUG_STOP_TOOL = "stm32_debug_stop";

export const sessionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    active: { type: "boolean" },
    sessionId: { type: "string" },
    port: { type: "number" },
    projectDir: { type: "string" },
    elfPath: { type: "string" },
    startedAt: { type: "number" },
    idleTtlMs: { type: "number" },
    hardTtlMs: { type: "number" },
    remainingMs: { type: "number" },
    errors: { type: "array", items: { type: "string" } },
    message: { type: "string" },
  },
  required: [
    "ok", "active", "sessionId", "port", "projectDir", "elfPath", "startedAt",
    "idleTtlMs", "hardTtlMs", "remainingMs", "errors", "message",
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

interface SessionArgs {
  projectDir?: string;
  elfPath?: string;
  port?: number;
  adapterSpeed?: number;
  configFile?: string;
  idleTtlMs?: number;
  hardTtlMs?: number;
  reset?: "none" | "halt" | "run";
  binDirs?: string[];
}

function describeSession(report: SessionReport): string[] {
  const lines: string[] = [report.message];
  if (report.active) {
    lines.push("会话 " + report.sessionId + "：端口 " + String(report.port) + "，剩余租约 " + String(Math.ceil(report.remainingMs / 1000)) + " s（空闲 " + String(Math.round(report.idleTtlMs / 1000)) + " s / 总上限 " + String(Math.round(report.hardTtlMs / 1000)) + " s）");
    if (report.elfPath !== "") lines.push("符号：" + report.elfPath);
    lines.push("→ 用 stm32_debug_eval 执行 gdb 命令；用完 stm32_debug_stop 立刻还探针（turn 结束也会自动关）");
  }
  for (const error of report.errors.slice(0, 6)) lines.push("x " + error);
  return lines;
}

export function registerDebugSession(ctx: DshContext): void {
  ctx.tools.register({
    name: DEBUG_SESSION_TOOL,
    description:
      "显式开一个长调试会话（租约：空闲 90 s、总上限 10 min），常驻只有 openocd，然后用 stm32_debug_eval 读变量/寄存器/栈。turn 结束（我输出完等你回复）时自动关闭，保证你随时能在 VS Code 里按 F5。短任务请直接用 stm32_debug_run，它一次调用内开关会话。",
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
        binDirs: { type: "array", items: { type: "string" }, description: "工具链目录候选。" },
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
    async execute(rawArgs: SessionArgs, exec: ToolExec) {
      const resolution = await resolveProjectDir(ctx, rawArgs.projectDir, exec);
      const projectDir = resolution.projectDir;
      debugSessions.configure(ctx.subprocess, rawArgs.binDirs ?? []);
      const session = await debugSessions.start({
        projectDir,
        ...(rawArgs.elfPath === undefined ? {} : { elfPath: rawArgs.elfPath }),
        ...(rawArgs.port === undefined ? {} : { port: rawArgs.port }),
        ...(rawArgs.adapterSpeed === undefined ? {} : { adapterSpeed: rawArgs.adapterSpeed }),
        ...(rawArgs.configFile === undefined ? {} : { configFile: rawArgs.configFile }),
        ...(rawArgs.idleTtlMs === undefined ? {} : { idleTtlMs: rawArgs.idleTtlMs }),
        ...(rawArgs.hardTtlMs === undefined ? {} : { hardTtlMs: rawArgs.hardTtlMs }),
        ...(rawArgs.reset === undefined ? {} : { reset: rawArgs.reset }),
        ...(rawArgs.binDirs === undefined ? {} : { binDirs: rawArgs.binDirs }),
      });
      void exec;
      return {
        message: resolution.note === null ? session.message : session.message + "\n· " + resolution.note,
        session,
      };
    },
  });

  ctx.tools.register({
    name: DEBUG_EVAL_TOOL,
    description:
      "在已开启的调试会话里执行 gdb 命令（例如 \"print g_led_blink_count\"、\"info registers pc\"、\"bt\"、\"x/4xb 0x20000000\"）。每次临时起一个 gdb -batch：连上 → monitor halt → 执行 → monitor resume → detach，跑完目标继续运行、不在插件里留 gdb 进程。",
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
    async execute(rawArgs: { commands?: string[]; expression?: string; keepHalted?: boolean; timeoutMs?: number }, exec: ToolExec) {
      const report = await debugSessions.eval({
        ...(rawArgs.commands === undefined ? {} : { commands: rawArgs.commands }),
        ...(rawArgs.expression === undefined ? {} : { expression: rawArgs.expression }),
        ...(rawArgs.keepHalted === undefined ? {} : { keepHalted: rawArgs.keepHalted }),
        ...(rawArgs.timeoutMs === undefined ? {} : { timeoutMs: rawArgs.timeoutMs }),
        signal: exec.signal,
      });
      return { message: report.message, report };
    },
  });

  ctx.tools.register({
    name: DEBUG_STOP_TOOL,
    description: "立刻关闭调试会话并释放探针（turn 结束时也会自动关；显式关掉更稳，例如你要去 VS Code 里按 F5 之前）。",
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
