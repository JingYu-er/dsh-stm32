/**
 * L3：stm32_debug_run —— 一次调用拿到调试快照，然后立刻把探针还给用户。
 *
 * 与 stm32_flash 的分工：flash 只写不调；debug_run 只调不写（不 load），
 * 停在 breakAt（默认 main）后抓寄存器/调用栈，收尾 monitor reset run + detach。
 */

import { runDebugRun } from "../engine/debug.js";
import { releaseProbeFor } from "../engine/debug-session.js";
import { ensureToolchain, gateReportNotes } from "../engine/toolchain-gate.js";
import type { DebugRunReport } from "../engine/debug.js";
import type { GateResult } from "../engine/toolchain-gate.js";
import type { DshContext, JsonSchema, SubprocessService, ToolExec } from "../types.js";
import { resolveProjectDir } from "./project-dir.js";

export const DEBUG_RUN_TOOL = "stm32_debug_run";

const registerSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    value: { type: "string" },
  },
  required: ["name", "value"],
};

const reportSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    projectDir: { type: "string" },
    elfPath: { type: "string" },
    port: { type: "number" },
    breakAt: { type: "string" },
    hitBreakpoint: { type: "boolean" },
    location: { type: "string" },
    registers: { type: "array", items: registerSchema },
    backtrace: { type: "array", items: { type: "string" } },
    locals: { type: "array", items: { type: "string" } },
    gdbCommand: { type: "string" },
    gdbOutput: { type: "string" },
    openOcdLogTail: { type: "string" },
    // F2：失败时带结构化错误码（与 stm32_flash 同一套枚举）。可选字段，成功路径不出现。
    errorCode: {
      type: "string",
      enum: ["", "no-probe", "probe-busy", "swd-locked", "flash-protected", "no-power", "target-mismatch", "unknown"],
    },
    durationMs: { type: "number" },
    errors: { type: "array", items: { type: "string" } },
    message: { type: "string" },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["ok", "projectDir", "elfPath", "port", "breakAt", "hitBreakpoint", "location", "registers", "backtrace", "locals", "durationMs", "errors", "message", "notes"],
};

export const outputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: { type: "string" },
    report: reportSchema,
  },
  required: ["message", "report"],
};

/** 门禁档位参数：三个档位的说明文字与 build 工具保持一致。 */
const ENV_CHECK_SCHEMA: JsonSchema = {
  type: "string",
  enum: ["block", "warn", "off"],
  description: "工具链检查：block 缺件就拒绝（默认）、warn 只警告、off 不检查",
};

interface DebugArgs {
  projectDir?: string;
  elfPath?: string;
  buildDir?: string;
  breakAt?: string;
  preCommands?: string[];
  port?: number;
  configFile?: string;
  adapterSpeed?: number;
  timeoutMs?: number;
  binDirs?: string[];
  envCheck?: string;
}

interface ToolValue {
  message: string;
  report: DebugRunReport;
}

export function formatDebugReport(report: DebugRunReport): string[] {
  const lines: string[] = [];
  lines.push((report.ok ? "调试快照完成" : "调试失败") + "：" + report.message);
  if (report.elfPath !== "") lines.push("固件：" + report.elfPath);
  if (report.errorCode !== undefined && report.errorCode !== "") lines.push("错误码：" + report.errorCode);
  if (report.port !== 0) lines.push("端口：" + String(report.port) + "，断点：" + report.breakAt);
  if (report.location !== "") lines.push("位置：" + report.location);
  if (report.registers.length > 0) lines.push("寄存器：" + report.registers.map((item) => item.name + "=" + item.value).join(" "));
  if (report.backtrace.length > 0) {
    lines.push("调用栈：");
    for (const frame of report.backtrace.slice(0, 8)) lines.push("  " + frame);
  }
  if (report.locals.length > 0) {
    lines.push("局部变量：");
    for (const local of report.locals.slice(0, 12)) lines.push("  " + local);
  }
  for (const note of report.notes) lines.push("· " + note);
  for (const error of report.errors.slice(0, 8)) lines.push("! " + error);
  if (report.errors.length > 0 && report.openOcdLogTail !== "") {
    lines.push("");
    lines.push("openocd 日志尾部：");
    lines.push(report.openOcdLogTail);
  }
  return lines;
}

/** 门禁拒绝时的报告：形如 emptyReport，但 notes 换成"缺什么、装在哪"。 */
function blockedReport(projectDir: string, gate: GateResult): DebugRunReport {
  return {
    ok: false, projectDir, elfPath: "", port: 0, breakAt: "main",
    hitBreakpoint: false, location: "", registers: [], backtrace: [], locals: [],
    gdbCommand: "", gdbOutput: "", openOcdLogTail: "", durationMs: 0,
    errors: [], message: gate.message, notes: gateReportNotes(gate),
  };
}

function emptyReport(message: string): DebugRunReport {
  return {
    ok: false, projectDir: "", elfPath: "", port: 0, breakAt: "main",
    hitBreakpoint: false, location: "", registers: [], backtrace: [], locals: [],
    gdbCommand: "", gdbOutput: "", openOcdLogTail: "", durationMs: 0,
    errors: [message], message, notes: [],
  };
}

export function registerDebugRun(ctx: DshContext): void {
  ctx.tools.register({
    name: DEBUG_RUN_TOOL,
    description:
      "烧录后想看一眼再走：起 openocd + gdb 连上目标，在 breakAt（默认 main）停住，抓寄存器/调用栈/局部变量，然后 monitor reset run + detach 让芯片继续跑并释放探针。不写 Flash、不常驻会话。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectDir: { type: "string", description: "工程根目录；缺省为当前工作目录。" },
        elfPath: { type: "string", description: "显式 .elf；缺省从构建目录推断。" },
        buildDir: { type: "string", description: "显式构建目录；缺省自动推断（优先 Debug）。" },
        breakAt: { type: "string", description: "断点位置，默认 main；none 表示只连上读现状不停。" },
        preCommands: { type: "array", items: { type: "string" }, description: "在 break 之后、continue 之前执行的 gdb 命令。" },
        port: { type: "number", description: "gdb 端口；缺省 3333，占用则顺延。" },
        configFile: { type: "string", description: "openocd 配置文件（相对工程目录）。" },
        adapterSpeed: { type: "number", description: "adapter speed（kHz）。" },
        timeoutMs: { type: "number", description: "gdb 超时，默认 45000。" },
        binDirs: { type: "array", items: { type: "string" }, description: "工具链目录候选。" },
        envCheck: ENV_CHECK_SCHEMA,
      },
      required: [],
    },
    timeoutMs: 2 * 60_000,
    isConcurrencySafe: () => false,
    output: {
      schema: outputSchema,
      render: (_args, value) => {
        const typed = value as ToolValue;
        return [{ type: "text", text: formatDebugReport(typed.report).join("\n") }];
      },
    },
    async execute(rawArgs: DebugArgs | undefined, exec: ToolExec): Promise<ToolValue> {
      const args = rawArgs ?? {};
      const subprocess = ctx.get<SubprocessService>("subprocess");
      if (subprocess === undefined) {
        const report = emptyReport("宿主缺少 subprocess 服务，无法调试");
        return { message: report.message, report };
      }
      const resolution = await resolveProjectDir(ctx, args.projectDir, exec);
      // 门禁：调试要 openocd + GDB 两件。缺件且 envCheck=block 时不占探针、不起进程。
      const gate = await ensureToolchain(ctx, {
        capability: "debug",
        ...(args.binDirs === undefined ? {} : { binDirs: args.binDirs }),
        envCheck: args.envCheck,
        signal: exec.signal,
      });
      if (!gate.ok && gate.mode === "block") {
        const blocked = blockedReport(resolution.projectDir, gate);
        return { message: blocked.message, report: blocked };
      }
      // debug_run 自己也要独占探针；缺件退出时不动别人的会话（B16）。
      const released = await releaseProbeFor("stm32_debug_run");
      const report = await runDebugRun(subprocess, {
        projectDir: resolution.projectDir,
        ...(args.elfPath === undefined ? {} : { elfPath: args.elfPath }),
        ...(args.buildDir === undefined ? {} : { buildDir: args.buildDir }),
        ...(args.breakAt === undefined ? {} : { breakAt: args.breakAt }),
        ...(args.preCommands === undefined ? {} : { preCommands: args.preCommands }),
        ...(args.port === undefined ? {} : { port: args.port }),
        ...(args.configFile === undefined ? {} : { configFile: args.configFile }),
        ...(args.adapterSpeed === undefined ? {} : { adapterSpeed: args.adapterSpeed }),
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
        ...(args.binDirs === undefined ? {} : { binDirs: args.binDirs }),
        signal: exec.signal,
      });
      if (!gate.ok) report.notes.unshift(gate.message);
      if (released !== null) report.notes.push(released);
      if (resolution.note !== null) report.notes.push(resolution.note);
      return { message: report.message, report };
    },
  });
}
