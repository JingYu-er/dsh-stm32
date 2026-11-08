/**
 * L3：stm32_flash —— 只烧录，不进调试会话。
 *
 * 这是用户最初的痛点：VS Code 里 F5 与 Ctrl+F5 都会拉起调试适配器，
 * 而 openocd 的 `program ... verify reset exit` 本身就是"烧完就跑"。
 * 这个工具阻塞执行（通常 3–10 s），跑完立刻释放探针。
 */

import { runFlash } from "../engine/flash.js";
import { PROBE_ERROR_SCHEMA, formatProbeError } from "../engine/probe-error.js";
import { releaseProbeFor } from "../engine/debug-session.js";
import { ensureToolchain, gateReportNotes } from "../engine/toolchain-gate.js";
import type { FlashReport } from "../engine/flash.js";
import type { ProbeError } from "../engine/probe-error.js";
import type { GateResult } from "../engine/toolchain-gate.js";
import type { DshContext, JsonSchema, SubprocessService, ToolExec } from "../types.js";
import { resolveProjectDir } from "./project-dir.js";
import { describeFacts, mcuFromIoc } from "../engine/facts.js";
import { ensureFacts } from "../engine/facts-acquire.js";

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
    // B2：结构化探针错误（旧错误码字段已删除，不做兼容别名）。成功路径不出现该字段。
    probeError: PROBE_ERROR_SCHEMA,
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
  allowUnknownFacts?: boolean;
  envCheck?: string;
}

/**
 * 交给宿主看的报告：probeError(null) 直接摘掉。
 * 引擎侧保留 ProbeError | null（空值语义清楚），但宿主 schema 不接受 null，
 * 声明成 object 的字段一旦是 null 会被整个判成"非法输出"。
 */
export type FlashReportForHost = Omit<FlashReport, "probeError"> & { probeError?: ProbeError };

export function flashReportForHost(report: FlashReport): FlashReportForHost {
  const { probeError, ...rest } = report;
  return probeError === null ? rest : { ...rest, probeError };
}

interface ToolValue {
  message: string;
  report: FlashReportForHost;
}

export function formatFlashReport(report: FlashReport | FlashReportForHost): string[] {
  const lines: string[] = [];
  lines.push((report.ok ? "烧录成功" : "烧录失败") + "：" + report.message);
  if (report.elfPath !== "") lines.push("固件：" + report.elfPath + "（" + String(report.elfSize) + " B）");
  if (report.configs.length > 0) lines.push("配置：" + report.configs.join(" + "));
  if (report.command !== "") lines.push("命令：" + report.command);
  lines.push("写入=" + (report.programmed ? "是" : "否") + "，校验=" + (report.verified ? "是" : "否"));
  const probeError = report.probeError ?? null;
  if (probeError !== null) lines.push(formatProbeError(probeError));
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
      "只烧录不调试：用 openocd 执行 program <elf> verify reset exit，烧完复位运行并立刻释放探针（不会拉起调试会话，也不停在 main）。烧录前过三道门禁：工具链缺件直接拒；.ioc 没启用 Serial Wire 也拒（会把 SWD 烧失联，确实要烧带 allowNoDebug=true）；这颗芯片有 rm-topics 主题清单但 facts 机检没过同样拒（allowUnknownFacts=true 强制）。探针按 USB 实见结果选 interface（ST-Link → interface/stlink.cfg，DAPLink/CMSIS-DAP → interface/cmsis-dap.cfg），工程自带 openocd.cfg 时以它为准；没自带时 openocd 报驱动不匹配会自动换另一个 interface 重试一次，实见 ST-Link 且装了 STM32CubeProgrammer 时两条都失败再用 CLI 兜底。成功的证据是 Programming Finished + Verified OK。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectDir: { type: "string", description: "工程根目录；缺省为当前工作目录。" },
        elfPath: { type: "string", description: "显式指定要烧的 .elf；缺省从构建目录推断。" },
        buildDir: { type: "string", description: "显式构建目录；缺省自动推断（优先 Debug）。" },
        configFile: { type: "string", description: "openocd 配置文件（相对工程目录）；缺省找 openocd.cfg。给了且存在时以它为准：不按探针改 interface，也不自动换 interface 重试。" },
        iocPath: { type: "string", description: "SWD 守卫要看的 .ioc（工程里有多个 .ioc 时用它指定）。" },
        adapterSpeed: { type: "number", description: "adapter speed（kHz）；连不上时可降到 1000 或 100。openocd 与 CubeProgrammer 兜底都用它。" },
        timeoutMs: { type: "number", description: "超时毫秒数，默认 120000。" },
        allowNoDebug: { type: "boolean", description: ".ioc 里没有 Serial Wire 时是否仍然烧录（默认 false：拒绝，避免烧掉 SWD）。" },
        allowUnknownFacts: { type: "boolean", description: "这颗芯片有 rm-topics 主题清单（踩过坑）但 facts 语义没机检通过时，是否仍然烧录（默认 false：拒绝）。" },
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
        return { message: report.message, report: flashReportForHost(report) };
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
        return { message: blocked.message, report: flashReportForHost(blocked) };
      }
      let flashFactsNote = "";
      // 事实层门禁（2026-11-07 用户决定改成三态）：先自愈补书，再按「这颗芯片有没有
      // rm-topics 主题清单」判——有清单必须机检过（verified）才烧；没清单直接放行，
      // 载体照下、路径照报（族级判据太粗：坑是芯片级的，用户踩坑就给他这颗建 spec）。
      const mcu = mcuFromIoc(resolution.projectDir);
      const ensured = mcu === null ? null : await ensureFacts(mcu, process.env, { timeoutMs: 150_000, signal: exec.signal });
      const facts = ensured === null ? null : ensured.summary;
      if (ensured !== null && ensured.built.attempted) {
        flashFactsNote = (ensured.built.ok ? "facts 已自动补齐" : "facts 自动补齐没成功（不拦烧录，除非这颗芯片有主题清单）：" + ensured.built.message);
      }
      if (facts !== null && facts.hasSpec && !facts.verified && args.allowUnknownFacts !== true) {
        const blocked = emptyReport(
          "没烧：" + facts.line + " 有 rm-topics 主题清单但机检没过——这颗芯片的 RM 结论没被逐字核实，烧下去出坑没人兜底。修清单/重跑 build-facts，或传 allowUnknownFacts=true 强制烧。",
        );
        blocked.notes.push(...describeFacts(facts));
        return { message: blocked.message, report: flashReportForHost(blocked) };
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
      if (flashFactsNote !== "") report.notes.push(flashFactsNote);
      if (facts !== null) report.notes.push(...describeFacts(facts));
      if (!gate.ok) report.notes.unshift(gate.message);
      if (released !== null) report.notes.push(released);
      if (resolution.note !== null) report.notes.push(resolution.note);
      return { message: report.message, report: flashReportForHost(report) };
    },
  });
}

/** 门禁拒绝时的报告：形如 emptyReport，但 notes 换成"缺什么、装在哪"。 */
function blockedReport(projectDir: string, gate: GateResult): FlashReport {
  return {
    ok: false, projectDir, elfPath: "", elfSize: 0, command: "", args: [], configs: [],
    durationMs: 0, programmed: false, verified: false,
    probeError: null,
    errors: [], message: gate.message, logTail: "", notes: gateReportNotes(gate),
  };
}

function emptyReport(message: string): FlashReport {
  return {
    ok: false, projectDir: "", elfPath: "", elfSize: 0, command: "", args: [], configs: [],
    durationMs: 0, programmed: false, verified: false,
    probeError: null,
    errors: [message], message, logTail: "", notes: [],
  };
}
