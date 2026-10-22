/**
 * L3：stm32_code_patch —— 只往 USER CODE 块里写代码的机械保证。
 *
 * 为什么不直接让模型 edit 文件：生成区（MX_*_Init、main() 骨架、HAL 配置）手改
 * 会在下一次 stm32_generate 时被 CubeMX 无声覆盖（规格 §7 R1/R2）。
 * 这个工具把"只改 USER CODE 块"变成工具契约：块不存在就失败，块外字节原样保留。
 */

import { patchUserCode } from "../engine/code-patch.js";
import type { CodePatchReport } from "../engine/code-patch.js";
import type { DshContext, JsonSchema, ToolExec } from "../types.js";

export const CODE_PATCH_TOOL = "stm32_code_patch";

const reportSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    file: { type: "string" },
    block: { type: "string" },
    mode: { type: "string" },
    labels: { type: "array", items: { type: "string" } },
    linesBefore: { type: "number" },
    linesAfter: { type: "number" },
    backupPath: { type: "string" },
    errors: { type: "array", items: { type: "string" } },
    message: { type: "string" },
  },
  required: ["ok", "file", "block", "mode", "labels", "linesBefore", "linesAfter", "errors", "message"],
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

interface CodePatchArgs {
  projectDir?: string;
  file: string;
  block: string;
  code: string;
  mode?: "replace" | "append";
}

interface ToolValue {
  message: string;
  report: CodePatchReport;
}

export function formatCodePatchReport(report: CodePatchReport): string[] {
  const lines: string[] = [];
  lines.push((report.ok ? "写入完成" : "写入失败") + "：" + report.message);
  if (report.ok) lines.push("块：" + report.block + "（" + report.mode + "，" + String(report.linesBefore) + " → " + String(report.linesAfter) + " 行）");
  if (report.backupPath !== undefined) lines.push("备份：" + report.backupPath);
  if (report.labels.length > 0 && !report.ok) lines.push("可用标签：" + report.labels.join("、"));
  for (const error of report.errors) lines.push("! " + error);
  return lines;
}

export function registerCodePatch(ctx: DshContext): void {
  ctx.tools.register({
    name: CODE_PATCH_TOOL,
    description:
      "把 C 代码写进某个文件的 USER CODE 块（BEGIN 与 END 标记之间），块外字节原样保留；块不存在就失败并列出可用标签。写入前自动备份到 .dsh-stm32/backups，写完请接着 stm32_build。replace 替换块内全部内容，append 追加到块尾。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectDir: { type: "string", description: "工程根目录；缺省为当前工作目录。" },
        file: { type: "string", description: "相对工程目录的源文件，例如 Core/Src/main.c。" },
        block: { type: "string", description: "USER CODE 标签，例如 3、WHILE、Init、Private variables。" },
        code: { type: "string", description: "要写入的 C 代码（不含 USER CODE 标记行）。" },
        mode: { type: "string", enum: ["replace", "append"], description: "replace（默认）替换块内内容；append 追加到块尾。" },
      },
      required: ["file", "block", "code"],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    output: {
      schema: outputSchema,
      render: (_args, value) => {
        const typed = value as ToolValue;
        return [{ type: "text", text: formatCodePatchReport(typed.report).join("\n") }];
      },
    },
    async execute(rawArgs: CodePatchArgs | undefined, _exec: ToolExec): Promise<ToolValue> {
      const args = rawArgs ?? ({} as CodePatchArgs);
      const report = patchUserCode({
        projectDir: args.projectDir ?? process.cwd(),
        file: args.file,
        block: args.block,
        code: args.code,
        ...(args.mode === undefined ? {} : { mode: args.mode }),
      });
      return { message: report.message, report };
    },
  });
}
