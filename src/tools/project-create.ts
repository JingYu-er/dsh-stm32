/**
 * L3：stm32_project_create —— 空目录 → 可编译工程骨架（一条命令）。
 *
 * 只建"工程外壳"（CMake / 链接脚本 / startup / Drivers / .vscode / .ioc），
 * Core/ 下的 C 源仍然交给 stm32_generate（CubeMX 无头生成）。
 * 这是规格 §5 状态机的第 [1] 步。
 */

import { createProjectScaffold } from "../engine/scaffold.js";
import type { ScaffoldReport } from "../engine/scaffold.js";
import { resolveSearchConfig } from "../data/search-roots.js";
import type { DshContext, JsonSchema, ToolExec } from "../types.js";

export const PROJECT_CREATE_TOOL = "stm32_project_create";

const reportSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    targetDir: { type: "string" },
    projectName: { type: "string" },
    iocPath: { type: "string" },
    firmwareRoot: { type: "string" },
    templateDir: { type: "string" },
    templateFiles: { type: "number" },
    driverFiles: { type: "number" },
    durationMs: { type: "number" },
    warnings: { type: "array", items: { type: "string" } },
    message: { type: "string" },
  },
  required: ["ok", "targetDir", "projectName", "iocPath", "templateDir", "templateFiles", "driverFiles", "durationMs", "warnings", "message"],
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

interface ProjectCreateArgs {
  targetDir: string;
  projectName?: string;
  firmwarePackage?: string;
  cubeMxRoots?: string[];
  overwrite?: boolean;
}

interface ToolValue {
  message: string;
  report: ScaffoldReport;
}

export function formatScaffoldReport(report: ScaffoldReport): string[] {
  const lines: string[] = [];
  lines.push((report.ok ? "骨架已建好" : "建骨架失败") + "：" + report.message);
  if (report.ok) {
    lines.push("工程：" + report.projectName + " → " + report.targetDir);
    lines.push("文件：" + String(report.templateFiles) + " 个工程文件 + " + String(report.driverFiles) + " 个固件文件");
    lines.push(".ioc：" + report.iocPath);
    if (report.firmwareRoot !== undefined) lines.push("固件包：" + report.firmwareRoot);
  }
  for (const warning of report.warnings) lines.push("· " + warning);
  return lines;
}

export function registerProjectCreate(ctx: DshContext): void {
  ctx.tools.register({
    name: PROJECT_CREATE_TOOL,
    description:
      "空目录 → 可编译的 STM32F103 工程骨架（一条命令）：拷入 CMake 工程文件、64K 链接脚本、.vscode（只烧录 / 烧录并调试两份 launch 配置）、.ioc 模板，并从本机 CubeMX 固件包原样复制 Drivers/、startup、system。不生成 Core/ 的 C 源（那要接着调 stm32_generate）。目标目录非空时默认拒绝。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        targetDir: { type: "string", description: "新工程目录（可以是还不存在的路径）。" },
        projectName: { type: "string", description: "工程名（C 标识符）；缺省取目录名。" },
        firmwarePackage: { type: "string", description: "CubeMX 固件包目录名，默认 STM32Cube_FW_F1_V1.8.7。" },
        cubeMxRoots: { type: "array", items: { type: "string" }, description: "STM32CubeMX 安装根目录候选（固件包在 <root>/Repository 下）；缺省用默认值/环境变量。" },
        overwrite: { type: "boolean", description: "目标目录非空时是否继续（默认 false）。" },
      },
      required: ["targetDir"],
    },
    timeoutMs: 5 * 60_000,
    isConcurrencySafe: () => false,
    output: {
      schema: outputSchema,
      render: (_args, value) => {
        const typed = value as ToolValue;
        return [{ type: "text", text: formatScaffoldReport(typed.report).join("\n") }];
      },
    },
    async execute(rawArgs: ProjectCreateArgs | undefined, _exec: ToolExec): Promise<ToolValue> {
      const args = rawArgs ?? ({} as ProjectCreateArgs);
      const config = resolveSearchConfig(process.env, args.cubeMxRoots === undefined ? {} : { cubeMxRoots: args.cubeMxRoots });
      const report = createProjectScaffold({
        targetDir: args.targetDir,
        ...(args.projectName === undefined ? {} : { projectName: args.projectName }),
        ...(args.firmwarePackage === undefined ? {} : { firmwarePackage: args.firmwarePackage }),
        ...(args.overwrite === undefined ? {} : { overwrite: args.overwrite }),
        cubeMxRoots: config.cubeMxRoots,
      });
      return { message: report.message, report };
    },
  });
}
