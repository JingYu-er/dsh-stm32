/**
 * L3：stm32_project_create —— 空目录 → 可编译工程骨架（一条命令）。
 *
 * 两条路线（用户 2026-10-24 决定：不能只有 HAL 一条路）：
 *   route=hal（默认）：拷模板 + 从本机 CubeMX 固件包复制 Drivers/startup/system，
 *                      Core/ 下的 C 源接着交给 stm32_generate（CubeMX 无头生成）。
 *                      —— 复杂外设（USB/ETH/FDCAN/SDIO…）只有这条路。
 *   route=register：  不用 CubeMX、不用固件包；CMSIS 设备头与启动文件从**下载缓存**取
 *                      （第一次联网、之后复用），main.c 是寄存器版示例，生成即可编译。
 *                      —— 小而定型的外设（GPIO/USART 轮询/TIM/EXTI/单通道 ADC）够用。
 *
 * 两条路线的门禁不同：HAL 路线要 CubeMX（capability=generate），
 * 寄存器路线只要编译工具链（capability=build）——这正是"缺 CubeMX 也能干活"的落点。
 */

import { createProjectScaffold } from "../engine/scaffold.js";
import { createRegisterProject } from "../engine/register-template.js";
import { ensureToolchain, gateReportNotes } from "../engine/toolchain-gate.js";
import type { GateResult } from "../engine/toolchain-gate.js";
import { resolveSearchConfig } from "../data/search-roots.js";
import type { DshContext, JsonSchema, ToolExec } from "../types.js";
import { validateToolArgs } from "./project-dir.js";

export const PROJECT_CREATE_TOOL = "stm32_project_create";

/** 两条路线归一化后的报告（schema 只强制两边都有的字段，其余可选）。 */
export interface ProjectReport {
  ok: boolean;
  route: "hal" | "register";
  targetDir: string;
  projectName: string;
  message: string;
  templateFiles: number;
  driverFiles: number;
  durationMs: number;
  warnings: string[];
  /** HAL 路线 */
  iocPath?: string;
  firmwareRoot?: string;
  templateDir?: string;
  /** 寄存器路线 */
  mcu?: string;
  family?: string;
  startup?: string;
  deviceDefine?: string;
  cacheDir?: string;
  cacheHit?: boolean;
}

const reportSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    route: { type: "string", enum: ["hal", "register"] },
    targetDir: { type: "string" },
    projectName: { type: "string" },
    message: { type: "string" },
    templateFiles: { type: "number" },
    driverFiles: { type: "number" },
    durationMs: { type: "number" },
    warnings: { type: "array", items: { type: "string" } },
    iocPath: { type: "string" },
    firmwareRoot: { type: "string" },
    templateDir: { type: "string" },
    mcu: { type: "string" },
    family: { type: "string" },
    startup: { type: "string" },
    deviceDefine: { type: "string" },
    cacheDir: { type: "string" },
    cacheHit: { type: "boolean" },
  },
  required: ["ok", "route", "targetDir", "projectName", "message", "templateFiles", "driverFiles", "durationMs", "warnings"],
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

interface ProjectCreateArgs {
  targetDir: string;
  route?: string;
  projectName?: string;
  firmwarePackage?: string;
  cubeMxRoots?: string[];
  mcu?: string;
  family?: string;
  overwrite?: boolean;
  envCheck?: string;
}

interface ToolValue {
  message: string;
  report: ProjectReport;
}

export function formatProjectReport(report: ProjectReport): string[] {
  const lines: string[] = [];
  const routeLabel = report.route === "register" ? "寄存器版" : "HAL 版";
  lines.push((report.ok ? "骨架已建好（" + routeLabel + "）" : "建骨架失败（" + routeLabel + "）") + "：" + report.message);
  if (report.ok) {
    lines.push("工程：" + report.projectName + " → " + report.targetDir);
    lines.push("文件：" + String(report.templateFiles) + " 个工程文件 + " + String(report.driverFiles) + " 个驱动源文件");
    if (report.route === "hal" && report.iocPath !== undefined) lines.push(".ioc：" + report.iocPath);
    if (report.route === "hal" && report.firmwareRoot !== undefined) lines.push("固件包：" + report.firmwareRoot);
    if (report.route === "register") {
      lines.push("芯片：" + (report.mcu ?? "") + "（" + (report.family ?? "") + "），启动文件 " + (report.startup ?? "") + "，设备宏 " + (report.deviceDefine ?? ""));
      lines.push("模板：" + (report.cacheHit === true ? "复用缓存" : "本次下载") + (report.cacheDir === undefined ? "" : "（" + report.cacheDir + "）"));
    }
  }
  for (const warning of report.warnings) lines.push("· " + warning);
  return lines;
}

/** 门禁拒绝时的报告：targetDir 保持参数值，好让用户知道"本来要建在哪"。 */
function blockedReport(targetDir: string, projectName: string, route: "hal" | "register", gate: GateResult): ProjectReport {
  return {
    ok: false,
    route,
    targetDir,
    projectName,
    message: gate.message,
    templateFiles: 0,
    driverFiles: 0,
    durationMs: 0,
    warnings: gateReportNotes(gate),
  };
}

function normalizeRoute(value: string | undefined): "hal" | "register" | null {
  const text = (value ?? "hal").trim().toLowerCase();
  if (text === "hal" || text === "cube" || text === "cubemx") return "hal";
  if (text === "register" || text === "reg" || text === "bare") return "register";
  return null;
}

export function registerProjectCreate(ctx: DshContext): void {
  ctx.tools.register({
    name: PROJECT_CREATE_TOOL,
    description:
      "空目录 → 可编译的 STM32 工程骨架。route=hal（默认）：拷 CMake 工程文件、链接脚本、.ioc 与 .vscode，并从本机 CubeMX 固件包复制 Drivers/、startup、system（Core/ 的 C 源还要 stm32_generate 生成，要 CubeMX）。route=register：不用 CubeMX、不用固件包，CMSIS 设备头与启动文件从下载缓存取（第一次联网、之后复用），直接给出寄存器版 main.c，建完即可编译（需要 gcc/cmake/ninja）。目标目录非空时默认拒绝。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        targetDir: { type: "string", description: "新工程目录（可以是还不存在的路径）。" },
        route: { type: "string", enum: ["hal", "register"], description: "hal（默认，要 CubeMX 固件包）或 register（寄存器版，不要 CubeMX）" },
        projectName: { type: "string", description: "工程名（C 标识符）；缺省取目录名。" },
        mcu: { type: "string", description: "芯片型号，例如 STM32F103C8T6（route=register 时用；缺省按 F103C8T6 处理）。" },
        family: { type: "string", description: "只给族时写这里，例如 F1（route=register；按中容量档处理）。" },
        firmwarePackage: { type: "string", description: "CubeMX 固件包目录名，默认 STM32Cube_FW_F1_V1.8.7（只 route=hal 用）。" },
        cubeMxRoots: { type: "array", items: { type: "string" }, description: "STM32CubeMX 安装根目录候选（固件包在 <root>/Repository 下）；缺省用默认值/环境变量（只 route=hal 用）。" },
        envCheck: ENV_CHECK_SCHEMA,
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
        return [{ type: "text", text: formatProjectReport(typed.report).join("\n") }];
      },
    },
    async execute(rawArgs: ProjectCreateArgs | undefined, exec: ToolExec): Promise<ToolValue> {
      const args = rawArgs ?? ({} as ProjectCreateArgs);
      // 洞 C：缺 targetDir 时以前会带着 undefined 一路走下去，宿主只报 "value is not lossless JSON"。
      const invalid = validateToolArgs(PROJECT_CREATE_TOOL, args as unknown as Record<string, unknown>, [
        { name: "targetDir", kind: "string" },
      ]);
      if (invalid !== null) {
        return {
          message: invalid,
          report: {
            ok: false,
            route: "hal",
            targetDir: typeof args.targetDir === "string" ? args.targetDir : "",
            projectName: args.projectName ?? "",
            message: invalid,
            templateFiles: 0,
            driverFiles: 0,
            durationMs: 0,
            warnings: [invalid],
          },
        };
      }

      const route = normalizeRoute(args.route);
      if (route === null) {
        const message = "route 只能是 hal 或 register（收到：" + String(args.route) + "）。";
        return {
          message,
          report: {
            ok: false,
            route: "hal",
            targetDir: args.targetDir,
            projectName: args.projectName ?? "",
            message,
            templateFiles: 0,
            driverFiles: 0,
            durationMs: 0,
            warnings: [message],
          },
        };
      }

      // 门禁：两条路线要的东西不一样——HAL 要 CubeMX，寄存器版只要编译工具链。
      const capability = route === "register" ? "build" : "generate";
      const gate = await ensureToolchain(ctx, {
        capability,
        ...(args.cubeMxRoots === undefined ? {} : { cubeMxRoots: args.cubeMxRoots }),
        envCheck: args.envCheck,
        signal: exec.signal,
      });
      if (!gate.ok && gate.mode === "block") {
        const blocked = blockedReport(args.targetDir, args.projectName ?? "", route, gate);
        return { message: blocked.message, report: blocked };
      }

      if (route === "register") {
        const report = await createRegisterProject({
          targetDir: args.targetDir,
          ...(args.projectName === undefined ? {} : { projectName: args.projectName }),
          ...(args.mcu === undefined ? {} : { mcu: args.mcu }),
          ...(args.family === undefined ? {} : { family: args.family }),
          ...(args.overwrite === undefined ? {} : { overwrite: args.overwrite }),
          onProgress: () => undefined,
        });
        const normalized: ProjectReport = {
          ok: report.ok,
          route: "register",
          targetDir: report.targetDir,
          projectName: report.projectName,
          message: report.message,
          templateFiles: report.templateFiles,
          driverFiles: report.driverFiles,
          durationMs: report.durationMs,
          warnings: report.warnings,
          mcu: report.mcu,
          family: report.family,
          startup: report.startup,
          deviceDefine: report.deviceDefine,
          cacheDir: report.cacheRoot,
          cacheHit: report.cacheHit,
        };
        if (!gate.ok) normalized.warnings.unshift(gate.message);
        return { message: normalized.message, report: normalized };
      }

      const config = resolveSearchConfig(process.env, args.cubeMxRoots === undefined ? {} : { cubeMxRoots: args.cubeMxRoots });
      const scaffold = createProjectScaffold({
        targetDir: args.targetDir,
        ...(args.projectName === undefined ? {} : { projectName: args.projectName }),
        ...(args.firmwarePackage === undefined ? {} : { firmwarePackage: args.firmwarePackage }),
        ...(args.overwrite === undefined ? {} : { overwrite: args.overwrite }),
        cubeMxRoots: config.cubeMxRoots,
      });
      // ScaffoldReport 没有 notes 字段，warn 档的警告并进 warnings（卡片照样打出来）。
      if (!gate.ok) scaffold.warnings.unshift(gate.message);
      const halReport: ProjectReport = {
        ok: scaffold.ok,
        route: "hal",
        targetDir: scaffold.targetDir,
        projectName: scaffold.projectName,
        message: scaffold.message,
        templateFiles: scaffold.templateFiles,
        driverFiles: scaffold.driverFiles,
        durationMs: scaffold.durationMs,
        warnings: scaffold.warnings,
        iocPath: scaffold.iocPath,
        ...(scaffold.firmwareRoot === undefined ? {} : { firmwareRoot: scaffold.firmwareRoot }),
        templateDir: scaffold.templateDir,
      };
      return { message: halReport.message, report: halReport };
    },
  });
}
