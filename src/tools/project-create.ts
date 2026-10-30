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

import { ensureAssets } from "../engine/assets.js";
import { createProjectScaffold, preflightTarget } from "../engine/scaffold.js";
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
  /** 两条路线都有的芯片事实 */
  mcu?: string;
  family?: string;
  startup?: string;
  deviceDefine?: string;
  /** HAL 路线：按芯片命名并渲染的链接脚本，例如 STM32F103RCTx_FLASH.ld。 */
  linkerScript?: string;
  /** 两条路线都有的：ST 器件代号（.ld 与 .ioc 里的名字）与容量。 */
  deviceId?: string;
  flashBytes?: number;
  ramBytes?: number;
  /** 寄存器路线：clock_init() 算出的 SYSCLK 与摘要。 */
  sysclkHz?: number;
  clockSummary?: string;
  /** 寄存器路线 */
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
    linkerScript: { type: "string" },
    deviceId: { type: "string" },
    flashBytes: { type: "number" },
    ramBytes: { type: "number" },
    sysclkHz: { type: "number" },
    clockSummary: { type: "string" },
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
    if (report.route === "hal" && report.mcu !== undefined) {
      lines.push(
        "芯片：" + report.mcu + "，启动文件 " + (report.startup ?? "") + "，设备宏 " + (report.deviceDefine ?? "") +
          "，链接脚本 " + (report.linkerScript ?? ""),
      );
    }
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
        mcu: {
          type: "string",
          description:
            "芯片型号，例如 STM32F103C8T6 / STM32F103RCT6 / STM32F107VCT6（两条路线都吃）。route=hal：决定启动文件、设备宏与链接脚本（按 <DeviceId>_FLASH.ld 命名），缺省 STM32F103C8T6；route=register：决定启动文件与设备宏，缺省按 F103C8T6 处理。",
        },
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

      // 先判目标目录能不能写，再谈"要不要装工具"：顺序反过来的话，用户会先被要求装 CubeMX，
      // 装完才发现目录非空（HAL 路线还可能发现里面有份 .ioc）——白折腾一趟。
      // 判定逻辑与引擎共用同一份（preflightTarget），不在这里另写一套。
      const refusal = preflightTarget({
        targetDir: args.targetDir,
        route,
        ...(args.projectName === undefined ? {} : { projectName: args.projectName }),
        ...(args.overwrite === undefined ? {} : { overwrite: args.overwrite }),
      });
      if (refusal !== null) {
        return {
          message: refusal,
          report: {
            ok: false,
            route,
            targetDir: args.targetDir,
            projectName: args.projectName ?? "",
            message: refusal,
            templateFiles: 0,
            driverFiles: 0,
            durationMs: 0,
            warnings: [refusal],
          },
        };
      }

      // 设备事实（型号 → 启动文件/设备宏/Flash/RAM）只从资源包缓存读：插件不再内置芯片表，
      // 第一次用在这里自动装一次（缓存命中时最坏只是几次 stat，不发网络请求）。
      const assets = await ensureAssets({ signal: exec.signal });
      if (!assets.ok) {
        const message =
          "设备事实还没就绪，型号 → 启动文件/设备宏/容量都算不出来：插件不再内置芯片表，这些事实只从资源包缓存读。" +
          assets.message;
        const blocked: ProjectReport = {
          ok: false,
          route,
          targetDir: args.targetDir,
          projectName: args.projectName ?? "",
          message,
          templateFiles: 0,
          driverFiles: 0,
          durationMs: 0,
          warnings: [message],
        };
        return { message, report: blocked };
      }

      // 门禁：两条路线要的东西不一样。
      //   register（寄存器版）建完就能编译 → 按 build 能力查 gcc/cmake/ninja。
      //   hal（默认）这一步**只拷文件**（CMake 工程文件 / 链接脚本 / Drivers），既不需要
      //   STM32CubeMX 启动器，也不需要它的内置 JRE，所以以前用 generate 能力来的门禁是过度的：
      //   用户会被要求装一整套 GUI 才能拷几个文件。缺固件包由 scaffold 自己报（会列出找过的路径）。
      const gate =
        route === "register"
          ? await ensureToolchain(ctx, {
              capability: "build",
              ...(args.cubeMxRoots === undefined ? {} : { cubeMxRoots: args.cubeMxRoots }),
              envCheck: args.envCheck,
              signal: exec.signal,
            })
          : null;
      if (gate !== null && !gate.ok && gate.mode === "block") {
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
          // 两条路线的报告字段对齐（HAL 与寄存器都能看到链接脚本、器件代号与容量）。
          linkerScript: report.linkerScript,
          deviceId: report.deviceId,
          flashBytes: report.flashBytes,
          ramBytes: report.ramBytes,
          sysclkHz: report.sysclkHz,
          clockSummary: report.clockSummary,
          cacheDir: report.cacheRoot,
          cacheHit: report.cacheHit,
        };
        if (gate !== null && !gate.ok) normalized.warnings.unshift(gate.message);
        if (assets.status === "refreshed") normalized.warnings.unshift(assets.message);
        return { message: normalized.message, report: normalized };
      }

      const config = resolveSearchConfig(process.env, args.cubeMxRoots === undefined ? {} : { cubeMxRoots: args.cubeMxRoots });
      const scaffold = createProjectScaffold({
        targetDir: args.targetDir,
        ...(args.projectName === undefined ? {} : { projectName: args.projectName }),
        ...(args.mcu === undefined ? {} : { mcu: args.mcu }),
        ...(args.firmwarePackage === undefined ? {} : { firmwarePackage: args.firmwarePackage }),
        ...(args.overwrite === undefined ? {} : { overwrite: args.overwrite }),
        cubeMxRoots: config.cubeMxRoots,
        binDirs: config.binDirs,
      });
      // ScaffoldReport 没有 notes 字段，warn 档的警告并进 warnings（卡片照样打出来）。
      if (gate !== null && !gate.ok) scaffold.warnings.unshift(gate.message);
      if (assets.status === "refreshed") scaffold.warnings.unshift(assets.message);
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
        ...(scaffold.mcu === undefined ? {} : { mcu: scaffold.mcu }),
        ...(scaffold.startup === undefined ? {} : { startup: scaffold.startup }),
        ...(scaffold.deviceDefine === undefined ? {} : { deviceDefine: scaffold.deviceDefine }),
        ...(scaffold.linkerScript === undefined ? {} : { linkerScript: scaffold.linkerScript }),
      };
      return { message: halReport.message, report: halReport };
    },
  });
}
