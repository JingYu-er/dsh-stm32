/**
 * L3：stm32_regs_read —— 读物理地址上的寄存器（例如 GPIOC_ODR、AFIO_MAPR）。
 *
 * 只读不写、跑完 resume 让芯片原样继续跑、探针立刻释放。用来"自证"烧进去的固件真的在动，
 * 比看 LED 更可靠。
 */

import { describeSample, runRegsRead } from "../engine/regs.js";
import { debugSessions } from "../engine/debug-session.js";
import type { RegsReport } from "../engine/regs.js";
import type { DshContext, JsonSchema, SubprocessService, ToolExec } from "../types.js";
import { resolveProjectDir, validateToolArgs } from "./project-dir.js";

export const REGS_TOOL = "stm32_regs_read";

const sampleSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    address: { type: "string" },
    value: { type: "string" },
    ok: { type: "boolean" },
  },
  required: ["address", "value", "ok"],
};

export const outputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: { type: "string" },
    report: {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { type: "boolean" },
        projectDir: { type: "string" },
        configFile: { type: "string" },
        command: { type: "string" },
        script: { type: "string" },
        pc: { type: "string" },
        samples: { type: "array", items: sampleSchema },
        durationMs: { type: "number" },
        exitCode: { type: "number" },
        errors: { type: "array", items: { type: "string" } },
        message: { type: "string" },
        logTail: { type: "string" },
        notes: { type: "array", items: { type: "string" } },
      },
      required: [
        "ok", "projectDir", "configFile", "command", "script", "pc", "samples",
        "durationMs", "errors", "message", "logTail", "notes",
      ],
    },
  },
  required: ["message", "report"],
};

interface RegsArgs {
  projectDir?: string;
  addresses: string[];
  configFile?: string;
  adapterSpeed?: number;
  timeoutMs?: number;
  binDirs?: string[];
}

interface ToolValue {
  message: string;
  report: RegsReport;
}

function formatReport(report: RegsReport): string[] {
  const lines: string[] = [];
  lines.push((report.ok ? "读取完成" : "读取失败") + "：" + report.message);
  if (report.pc !== "") lines.push("pc = " + report.pc);
  for (const sample of report.samples) lines.push("  " + describeSample(sample));
  if (report.configFile !== "") lines.push("openocd 配置：" + report.configFile);
  for (const note of report.notes) lines.push("· " + note);
  for (const error of report.errors.slice(0, 8)) lines.push("! " + error);
  if (!report.ok && report.logTail !== "") {
    lines.push("");
    lines.push("日志尾部：");
    lines.push(report.logTail);
  }
  return lines;
}

function failureReport(projectDir: string, message: string, errors: string[]): RegsReport {
  return {
    ok: false, projectDir, configFile: "", command: "", script: "", pc: "",
    samples: [], durationMs: 0, errors, message, logTail: "", notes: [],
  };
}

export function registerRegsRead(ctx: DshContext): void {
  ctx.tools.register({
    name: REGS_TOOL,
    description:
      "读 STM32 内存映射寄存器（物理地址，如 GPIOC_ODR=0x4001100C、AFIO_MAPR=0x40010004）：起 openocd → halt → mdw → resume → shutdown，不复位芯片、一次性拿值后立刻释放探针。用来自证固件在跑（例如看 ODR 位在翻转）。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectDir: { type: "string", description: "工程根目录（用于找 openocd.cfg）；缺省为当前工作目录。" },
        addresses: { type: "array", items: { type: "string" }, description: "要读的物理地址，可带或不带 0x，例如 [\"0x4001100C\"]。" },
        configFile: { type: "string", description: "openocd 配置文件（相对工程目录）。" },
        adapterSpeed: { type: "number", description: "adapter speed（kHz）。" },
        timeoutMs: { type: "number", description: "超时毫秒数，默认 30000。" },
        binDirs: { type: "array", items: { type: "string" }, description: "工具链目录候选。" },
      },
      required: ["addresses"],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    output: {
      schema: outputSchema,
      render: (_args, value) => {
        const typed = value as ToolValue;
        return [{ type: "text", text: formatReport(typed.report).join("\n") }];
      },
    },
    async execute(rawArgs: RegsArgs | undefined, exec: ToolExec): Promise<ToolValue> {
      const args = rawArgs ?? ({} as RegsArgs);
      // 洞 C：参数名写错（例如把 addresses 写成 addresses_list）时先给一句人话，不要让宿主去报
      // "returned invalid output: value is not lossless JSON"。
      const invalid = validateToolArgs(REGS_TOOL, args as unknown as Record<string, unknown>, [
        { name: "addresses", kind: "string[]" },
      ]);
      if (invalid !== null) {
        return { message: invalid, report: failureReport(typeof args.projectDir === "string" ? args.projectDir : "", invalid, [invalid]) };
      }

      const resolution = await resolveProjectDir(ctx, args.projectDir, exec);
      // 洞 D：有调试会话时不能再起一个 openocd —— 同一块 CMSIS-DAP 被两个进程抢会报
      // "CMSIS-DAP transfer count mismatch"。直接借会话的 gdb 读，halt → 读 → resume。
      if (debugSessions.isActive()) {
        const words = await debugSessions.readWords({
          addresses: args.addresses,
          ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
          signal: exec.signal,
        });
        const notes = ["复用调试会话（端口 " + String(words.port) + "）的 openocd，没有另起一个"];
        if (resolution.note !== null) notes.push(resolution.note);
        if (words.projectDir !== "" && words.projectDir !== resolution.projectDir) {
          notes.push("会话的工程目录是 " + words.projectDir + "，与本次参数的 " + resolution.projectDir + " 不同（读值用的是会话里的那个）");
        }
        return {
          message: words.message,
          report: {
            ok: words.ok,
            projectDir: words.projectDir === "" ? resolution.projectDir : words.projectDir,
            configFile: "",
            command: words.command,
            script: "",
            pc: words.pc,
            samples: words.samples,
            durationMs: words.durationMs,
            errors: words.errors,
            message: words.message,
            logTail: words.output.split(/\r?\n/u).slice(-12).join("\n"),
            notes,
          },
        };
      }

      const subprocess = ctx.get<SubprocessService>("subprocess");
      if (subprocess === undefined) {
        const message = "宿主缺少 subprocess 服务，无法读寄存器";
        return { message, report: failureReport(resolution.projectDir, message, [message]) };
      }
      const report = await runRegsRead(subprocess, {
        projectDir: resolution.projectDir,
        addresses: args.addresses,
        ...(args.configFile === undefined ? {} : { configFile: args.configFile }),
        ...(args.adapterSpeed === undefined ? {} : { adapterSpeed: args.adapterSpeed }),
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
        ...(args.binDirs === undefined ? {} : { binDirs: args.binDirs }),
        signal: exec.signal,
      });
      if (resolution.note !== null) report.notes.push(resolution.note);
      return { message: report.message, report };
    },
  });
}
