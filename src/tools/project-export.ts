/**
 * L3：stm32_project_export —— 把"能编译的工程"打成一个 zip 交给别人（发同学、发板厂、存档）。
 *
 * 为什么要这个工具：直接把工程目录压缩的常见做法会把 build/ 一起带走，而 build/CMakeCache.txt
 * 里记的是本机绝对路径 —— 对方 cmake 退出码 0，产物却是旧的（实测）。所以排除规则必须由插件负责，
 * 不能指望用户自己记得。
 */

import { runExport } from "../engine/project-export.js";
import type { ExportReport } from "../engine/project-export.js";
import type { DshContext, JsonSchema, ToolExec } from "../types.js";
import { resolveProjectDir } from "./project-dir.js";

export const EXPORT_TOOL = "stm32_project_export";

const prebuiltSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string" },
    size: { type: "number" },
  },
  required: ["path", "size"],
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
        zipPath: { type: "string" },
        zipBytes: { type: "number" },
        fileCount: { type: "number" },
        prebuilt: { type: "array", items: prebuiltSchema },
        durationMs: { type: "number" },
        message: { type: "string" },
        notes: { type: "array", items: { type: "string" } },
      },
      required: ["ok", "projectDir", "zipPath", "zipBytes", "fileCount", "prebuilt", "durationMs", "message", "notes"],
    },
  },
  required: ["message", "report"],
};

interface ExportArgs {
  projectDir?: string;
  outDir?: string;
  includePrebuilt?: boolean;
  readme?: boolean;
}

interface ToolValue {
  message: string;
  report: ExportReport;
}

function formatReport(report: ExportReport): string[] {
  const lines: string[] = [];
  lines.push((report.ok ? "导出完成" : "导出失败") + "：" + report.message);
  if (report.ok) {
    lines.push("zip：" + report.zipPath + "（" + String(report.zipBytes) + " 字节）");
    lines.push("进包文件：" + String(report.fileCount) + " 个；耗时 " + String(report.durationMs) + " ms");
    if (report.prebuilt.length > 0) {
      lines.push("prebuilt/ 里的产物：");
      for (const item of report.prebuilt) lines.push("  · " + item.path + "（" + String(item.size) + " 字节）");
    }
  }
  for (const note of report.notes) lines.push("· " + note);
  return lines;
}

export function registerProjectExport(ctx: DshContext): void {
  ctx.tools.register({
    name: EXPORT_TOOL,
    description:
      "把工程打成一个 zip（默认放在工程同级 <工程名>-export.zip）：排除 build/、.dsh-stm32/、node_modules/、.git/，因为 build 里的缓存记着本机绝对路径，带过去会让对方 cmake 静默复用旧缓存；可选 includePrebuilt 把 build 里的 elf/hex/bin 拷进包内 prebuilt/（拿到就能烧），并自动写一份包内 README（怎么编译、build 为什么不在）。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectDir: { type: "string", description: "工程根目录；缺省为当前工作目录。" },
        outDir: { type: "string", description: "zip 输出目录；缺省为工程目录的上一级。" },
        includePrebuilt: { type: "boolean", description: "把编译产物（elf/hex/bin）拷进包内 prebuilt/；默认 false（只带源码）。" },
        readme: { type: "boolean", description: "是否自动写包内 README（怎么编译、build/ 为什么不在）；默认 true。" },
      },
      required: [],
    },
    timeoutMs: 3 * 60_000,
    isConcurrencySafe: () => false,
    output: {
      schema: outputSchema,
      render: (_args, value) => {
        const typed = value as ToolValue;
        return [{ type: "text", text: formatReport(typed.report).join("\n") }];
      },
    },
    async execute(rawArgs: ExportArgs | undefined, exec: ToolExec): Promise<ToolValue> {
      const args = rawArgs ?? ({} as ExportArgs);
      const resolution = await resolveProjectDir(
        ctx,
        typeof args.projectDir === "string" ? args.projectDir : undefined,
        exec,
      );
      const request = {
        projectDir: resolution.projectDir,
        includePrebuilt: args.includePrebuilt === true,
        readme: args.readme !== false,
        signal: exec.signal,
        ...(typeof args.outDir === "string" && args.outDir.trim() !== "" ? { outDir: args.outDir } : {}),
      };
      const report = await runExport(request);
      if (resolution.note !== null) report.notes.push(resolution.note);
      return { message: report.message, report };
    },
  });
}
