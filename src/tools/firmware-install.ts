/**
 * L3：stm32_firmware_install —— 把"这台机器缺固件包"变成一次可复核的下载。
 *
 * 为什么默认只出计划：要联网下 ~2 MB、要往 CubeMX 目录（dsh-firmware）或用户缓存里写目录，
 * 用户看过"装哪、下多少、做哪几步"再说 confirm:true + dryRun:false 才真下。
 *
 * 为什么不代装 CubeMX 本体：那是 GUI 向导 + 要 ST 账号，没法静默装（见 install-guides.ts）。
 * 固件包不一样 —— 它就是一棵目录树 + 一个 257 字节的 package.xml，可以完全自动化。
 */

import { firmwareInstallPlan, installFirmware, type FirmwareInstallResult, type FirmwareInstallStep } from "../engine/firmware-install.js";
import { resolveSearchConfig } from "../data/search-roots.js";
import type { DshContext, JobHandleForRun, JobsService, JsonSchema, ToolExec } from "../types.js";

export const FIRMWARE_INSTALL_TOOL = "stm32_firmware_install";

interface FirmwareInstallArgs {
  family?: string;
  mcu?: string;
  version?: string;
  target?: "auto" | "repository" | "cache";
  targetDir?: string;
  cubeMxRoot?: string;
  dryRun?: boolean;
  confirm?: boolean;
  foreground?: boolean;
}

const STEP_MARK: Record<FirmwareInstallStep["status"], string> = {
  pending: "[  ]",
  running: "[..]",
  done: "[OK]",
  skipped: "[--]",
  failed: "[!!]",
};

/* ------------------------------ schema ------------------------------ */

const stepSchema: JsonSchema = {
  type: "object",
  description: "安装步骤及其结果",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    status: { type: "string", enum: ["pending", "running", "done", "skipped", "failed"] },
    detail: { type: "string" },
  },
  required: ["id", "label", "status", "detail"],
};

const checkSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    label: { type: "string" },
    path: { type: "string" },
    ok: { type: "boolean" },
  },
  required: ["label", "path", "ok"],
};

const reportSchema: JsonSchema = {
  type: "object",
  description: "固件包下载/组装计划或结果",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    mode: { type: "string", enum: ["plan", "install"] },
    family: { type: "string" },
    version: { type: "string" },
    packageName: { type: "string", description: "STM32Cube_FW_F1_V1.8.7 这样的目录名" },
    targetKind: { type: "string", enum: ["existing", "cubeMx", "repository", "cache", "custom", ""] },
    targetDir: { type: "string" },
    cacheRoot: { type: "string" },
    cubeMxRoots: { type: "array", items: { type: "string" } },
    steps: { type: "array", items: stepSchema },
    verify: {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { type: "boolean" },
        checks: { type: "array", items: checkSchema },
      },
      required: ["ok", "checks"],
    },
    download: {
      type: "object",
      additionalProperties: false,
      properties: {
        files: { type: "number" },
        bytes: { type: "number" },
      },
      required: ["files", "bytes"],
    },
    notes: { type: "array", items: { type: "string" } },
    message: { type: "string" },
    nextStep: { type: "string" },
  },
  required: [
    "ok",
    "mode",
    "family",
    "version",
    "packageName",
    "targetKind",
    "targetDir",
    "cacheRoot",
    "cubeMxRoots",
    "steps",
    "verify",
    "download",
    "notes",
    "message",
    "nextStep",
  ],
};

interface ToolValue {
  mode: "job" | "report";
  jobId: string;
  message: string;
  report: FirmwareInstallResult;
}

export const outputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { type: "string", enum: ["job", "report"] },
    jobId: { type: "string" },
    message: { type: "string" },
    report: reportSchema,
  },
  required: ["mode", "jobId", "message", "report"],
};

/* ------------------------------ 文字卡 ------------------------------ */

export function formatFirmwareReport(report: FirmwareInstallResult): string[] {
  const lines: string[] = [];
  lines.push(report.message);
  if (report.packageName !== "") {
    lines.push("固件包：" + report.packageName + "（" + report.version + "）");
  }
  if (report.targetDir !== "") {
    lines.push("位置：" + report.targetDir + "（" + report.targetKind + "）");
  }
  if (report.steps.length > 0) {
    lines.push("步骤：");
    for (const step of report.steps) {
      lines.push("  " + STEP_MARK[step.status] + "  " + step.label);
      if (step.detail !== "") {
        for (const part of step.detail.split("\n")) lines.push("        " + part);
      }
    }
  }
  if (report.verify.checks.length > 0) {
    lines.push("自检：" + (report.verify.ok ? "三条判据全过" : "有缺失"));
    for (const check of report.verify.checks) {
      lines.push("  " + (check.ok ? "OK  " : "MISS") + "  " + check.label);
    }
  }
  if (report.notes.length > 0) {
    lines.push("说明：");
    for (const note of report.notes) lines.push("  · " + note);
  }
  if (report.nextStep !== "") lines.push("下一步：" + report.nextStep);
  return lines;
}

/* ------------------------------ 注册 ------------------------------ */

export function registerFirmwareInstall(ctx: DshContext): void {
  ctx.tools.register({
    name: FIRMWARE_INSTALL_TOOL,
    description:
      "下载并组装 STM32 固件包（STM32Cube_FW_<族>_V<版本>），默认装到 <CubeMX>/dsh-firmware（与 Repository 并列，不动官方包）。" +
      "从 GitHub 拉 HAL 驱动与 CMSIS 设备支持两个子模块仓库 + 5 个内核头，自己补 package.xml。" +
      "重要：实测把自造版本号丢进 Repository 会被 CubeMX 静默忽略，真正生效的是生成脚本里的 project setCustomFWPath —— 那一步由 stm32_generate 自动做。" +
      "默认只出计划：列出装到哪、下多大、做哪几步，不下载、不建目录。真装必须同时给 dryRun:false 与 confirm:true。已有官方包时什么都不做。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        family: { type: "string", description: "芯片族，例如 F1；不给就用 mcu 推" },
        mcu: { type: "string", description: "芯片型号，例如 STM32F103C8T6" },
        version: { type: "string", description: "包版本（不带 V），默认 1.8.7" },
        target: {
          type: "string",
          enum: ["auto", "repository", "cache"],
          description: "装哪：auto（默认，装到 <CubeMX>/dsh-firmware；CubeMX 目录不可写才落用户缓存）/ repository（硬塞官方仓库）/ cache（只落用户缓存）",
        },
        targetDir: { type: "string", description: "直接指定包目录（自定义布局用，跳过自动选址）" },
        cubeMxRoot: { type: "string", description: "CubeMX 安装根；不给就用配置/自动发现" },
        dryRun: { type: "boolean", description: "默认 true：只出计划。必须是 false 才可能真下" },
        confirm: { type: "boolean", description: "确认真的联网下载并写磁盘；默认 false" },
        foreground: { type: "boolean", description: "true = 同步等装完；默认后台 job" },
      },
      required: [],
    },
    timeoutMs: 15 * 60_000,
    isConcurrencySafe: () => false,
    output: {
      schema: outputSchema,
      render: (_args, value) => {
        const typed = value as ToolValue;
        const lines = formatFirmwareReport(typed.report);
        if (typed.mode === "job") {
          lines.unshift(typed.message);
          lines.push("job：" + typed.jobId + "（用 job_output 读进度，job_kill 停止）");
        }
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(rawArgs: FirmwareInstallArgs | undefined, exec: ToolExec): Promise<ToolValue> {
      const args = rawArgs ?? {};
      const realInstall = args.dryRun === false && args.confirm === true;
      const config = resolveSearchConfig(process.env, args.cubeMxRoot === undefined ? {} : { cubeMxRoots: [args.cubeMxRoot] });
      const base = {
        ...(args.family === undefined ? {} : { family: args.family }),
        ...(args.mcu === undefined ? {} : { mcu: args.mcu }),
        ...(args.version === undefined ? {} : { version: args.version }),
        ...(args.target === undefined ? {} : { target: args.target }),
        ...(args.targetDir === undefined ? {} : { targetDir: args.targetDir }),
        cubeMxRoots: config.cubeMxRoots,
      };

      const plan = firmwareInstallPlan({ ...base, env: process.env });
      if (!realInstall || plan.targetKind === "existing" || !plan.ok) {
        return { mode: "report", jobId: "", message: plan.message, report: plan };
      }

      const jobs = ctx.get<JobsService>("jobs");
      if (args.foreground === true || jobs === undefined) {
        const report = await installFirmware({ ...base, mode: "install", env: process.env, signal: exec.signal });
        return { mode: "report", jobId: "", message: report.message, report };
      }

      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      exec.signal.addEventListener("abort", onAbort, { once: true });
      const jobId = jobs.start({
        kind: "stm32-firmware-install",
        label: FIRMWARE_INSTALL_TOOL + " " + plan.packageName,
        ...(exec.agent === undefined ? {} : { owner: exec.agent.id }),
        run: (handle: JobHandleForRun) => {
          handle.append("开始下载 " + plan.packageName + " → " + plan.targetDir + "\n");
          const done = installFirmware({
            ...base,
            mode: "install",
            env: process.env,
            signal: controller.signal,
            onProgress: (line: string) => handle.append(line + "\n"),
          }).then((report) => {
            handle.append("\n" + formatFirmwareReport(report).join("\n") + "\n");
            return { status: report.ok ? ("completed" as const) : ("failed" as const), detail: report.message };
          });
          return {
            done,
            cancel: (reason?: string) => {
              handle.append("\n被取消：" + (reason ?? "用户停止") + "\n");
              controller.abort();
            },
          };
        },
      });
      exec.signal.removeEventListener("abort", onAbort);
      const startMessage = "已在后台下载固件包 " + plan.packageName + " → " + plan.targetDir + "，进度看 job 输出。";
      return {
        mode: "job",
        jobId,
        message: startMessage,
        report: { ...plan, mode: "install", message: startMessage },
      };
    },
  });
}
