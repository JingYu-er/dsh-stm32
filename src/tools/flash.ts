/**
 * L3：stm32_flash —— 只烧录，不进调试会话。
 *
 * 这是用户最初的痛点：VS Code 里 F5 与 Ctrl+F5 都会拉起调试适配器，
 * 而 openocd 的 `program ... verify reset exit` 本身就是"烧完就跑"。
 * 这个工具阻塞执行（通常 3–10 s），跑完立刻释放探针。
 */

import { runFlash } from "../engine/flash.js";
import { releaseProbeFor } from "../engine/debug-session.js";
import { ensureToolchain, gateReportNotes } from "../engine/toolchain-gate.js";
import type { FlashReport } from "../engine/flash.js";
import type { GateResult } from "../engine/toolchain-gate.js";
import type { DshContext, JsonSchema, SubprocessService, ToolExec } from "../types.js";
import { resolveProjectDir } from "./project-dir.js";

export const FLASH_TOOL = "stm32_flash";

const reportSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    projectDir: { type: "string" },
    elfPath: { type: "string" },
    elfSize: { type: "number" },
    command: { type: "string" },
    args: { type: "array", items: { type: "string" } },
    configs: { type: "array", items: { type: "string" } },
    durationMs: { type: "number" },
    exitCode: { type: "number" },
    programmed: { type: "boolean" },
    verified: { type: "boolean" },
    errors: { type: "array", items: { type: "string" } },
    message: { type: "string" },
    logTail: { type: "string" },
    notes: { type: "array", items: { type: "string" } },
    guard: { type: "string" },
    errorCode: { type: "string", enum: ["", "no-probe", "probe-busy", "swd-locked", "flash-protected", "no-power", "target-mismatch", "unknown"] },
  },
  required: ["ok", "projectDir", "elfPath", "elfSize", "command", "args", "durationMs", "programmed", "verified", "errors", "message", "logTail", "notes"],
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

interface FlashArgs {
  projectDir?: string;
  elfPath?: string;
  buildDir?: string;
  configFile?: string;
  iocPath?: string;
  adapterSpeed?: number;
  timeoutMs?: number;
  binDirs?: string[];
  allowNoDebug?: boolean;
  envCheck?: string;
}

interface ToolValue {
  message: string;
  report: FlashReport;
}

export function formatFlashReport(report: FlashReport): string[] {
  const lines: string[] = [];
  lines.push((report.ok ? "烧录成功" : "烧录失败") + "：" + report.message);
  if (report.elfPath !== "") lines.push("固件：" + report.elfPath + "（" + String(report.elfSize) + " B）");
  if (report.configs.length > 0) lines.push("配置：" + report.configs.join(" + "));
  if (report.command !== "") lines.push("命令：" + report.command);
  lines.push("写入=" + (report.programmed ? "是" : "否") + "，校验=" + (report.verified ? "是" : "否"));
  if (report.errorCode !== undefined && report.errorCode !== "") lines.push("错误码：[" + report.errorCode + "]");
  for (const note of report.notes) lines.push("· " + note);
  for (const error of report.errors.slice(0, 10)) lines.push("! " + error);
  if (!report.ok && report.logTail !== "") {
    lines.push("");
    lines.push("日志尾部：");
    lines.push(report.logTail);
  }
  return lines;
}

export function registerFlash(ctx: DshContext): void {
  ctx.tools.register({
    name: FLASH_TOOL,
    description:
      "只烧录不调试：用 openocd 执行 program <elf> verify reset exit，烧完复位运行并立刻释放探针（不会拉起调试会话，也不停在 main）。自动复用工程里的 openocd.cfg；没有则回退 CMSIS-DAP + stm32f1x。烧录前会检查 .ioc 是否启用了 Serial Wire，没有就拒绝（避免烧完 SWD 失联），确实要烧带 allowNoDebug=true。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectDir: { type: "string", description: "工程根目录；缺省为当前工作目录。" },
        elfPath: { type: "string", description: "显式指定要烧的 .elf；缺省从构建目录推断。" },
        buildDir: { type: "string", description: "显式构建目录；缺省自动推断（优先 Debug）。" },
        configFile: { type: "string", description: "openocd 配置文件（相对工程目录）；缺省找 openocd.cfg。" },
        iocPath: { type: "string", description: "SWD 守卫要看的 .ioc（工程里有多个 .ioc 时用它指定）。" },
        adapterSpeed: { type: "number", description: "adapter speed（kHz）；连不上时可降到 1000 或 100。" },
        timeoutMs: { type: "number", description: "超时毫秒数，默认 120000。" },
        allowNoDebug: { type: "boolean", description: ".ioc 里没有 Serial Wire 时是否仍然烧录（默认 false：拒绝，避免烧掉 SWD）。" },
        binDirs: { type: "array", items: { type: "string" }, description: "工具链目录候选，优先于默认值。" },
        envCheck: ENV_CHECK_SCHEMA,
      },
      required: [],
    },
    timeoutMs: 3 * 60_000,
    isConcurrencySafe: () => false,
    output: {
      schema: outputSchema,
      render: (_args, value) => {
        const typed = value as ToolValue;
        return [{ type: "text", text: formatFlashReport(typed.report).join("\n") }];
      },
    },
    async execute(rawArgs: FlashArgs | undefined, exec: ToolExec): Promise<ToolValue> {
      const args = rawArgs ?? {};
      const subprocess = ctx.get<SubprocessService>("subprocess");
      if (subprocess === undefined) {
        const report = emptyReport("宿主缺少 subprocess 服务，无法烧录");
        return { message: report.message, report };
      }
      const resolution = await resolveProjectDir(ctx, args.projectDir, exec);
      // 门禁：烧录只需要 openocd。缺件且 envCheck=block 时连 openocd 都不起，
      // 免得"探针被占 / 连不上"这类假象盖住真正的原因。
      const gate = await ensureToolchain(ctx, {
        capability: "flash",
        ...(args.binDirs === undefined ? {} : { binDirs: args.binDirs }),
        envCheck: args.envCheck,
        signal: exec.signal,
      });
      if (!gate.ok && gate.mode === "block") {
        const blocked = blockedReport(resolution.projectDir, gate);
        return { message: blocked.message, report: blocked };
      }
      // 探针只有一块：门禁通过后才让调试会话让出来（B16：缺件时不该把别人的探针收走）。
      const released = await releaseProbeFor("stm32_flash");
      const report = await runFlash(subprocess, {
        projectDir: resolution.projectDir,
        ...(args.elfPath === undefined ? {} : { elfPath: args.elfPath }),
        ...(args.buildDir === undefined ? {} : { buildDir: args.buildDir }),
        ...(args.configFile === undefined ? {} : { configFile: args.configFile }),
        ...(args.iocPath === undefined ? {} : { iocPath: args.iocPath }),
        ...(args.adapterSpeed === undefined ? {} : { adapterSpeed: args.adapterSpeed }),
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
        ...(args.binDirs === undefined ? {} : { binDirs: args.binDirs }),
        ...(args.allowNoDebug === undefined ? {} : { allowNoDebug: args.allowNoDebug }),
        signal: exec.signal,
      });
      if (!gate.ok) report.notes.unshift(gate.message);
      if (released !== null) report.notes.push(released);
      if (resolution.note !== null) report.notes.push(resolution.note);
      return { message: report.message, report };
    },
  });
}

/** 门禁拒绝时的报告：形如 emptyReport，但 notes 换成"缺什么、装在哪"。 */
function blockedReport(projectDir: string, gate: GateResult): FlashReport {
  return {
    ok: false, projectDir, elfPath: "", elfSize: 0, command: "", args: [], configs: [],
    durationMs: 0, programmed: false, verified: false,
    errors: [], message: gate.message, logTail: "", notes: gateReportNotes(gate),
  };
}

function emptyReport(message: string): FlashReport {
  return {
    ok: false, projectDir: "", elfPath: "", elfSize: 0, command: "", args: [], configs: [],
    durationMs: 0, programmed: false, verified: false,
    errors: [message], message, logTail: "", notes: [],
  };
}
