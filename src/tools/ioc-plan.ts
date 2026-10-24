/**
 * L3：stm32_ioc_plan —— 改 .ioc 的第一步：只算不写（规格 I3、§11 A8）。
 *
 * 返回 planId + 源文件 SHA-256 + 逐键 diff。确认之后必须调用 stm32_ioc_apply({ planId })，
 * apply 会核对源文件 SHA-256 是否还是 plan 时那份（期间你若用 CubeMX GUI 改过就会被拒绝）。
 */

import { planIocChanges } from "../engine/ioc-plan.js";
import type { IocPlanChange, PinAddRequest } from "../engine/ioc-plan.js";
import type { DshContext, JsonSchema, ToolExec } from "../types.js";
import { resolveProjectDir } from "./project-dir.js";

export const IOC_PLAN_TOOL = "stm32_ioc_plan";

const changeSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    key: { type: "string" },
    kind: { type: "string", enum: ["added", "removed", "changed"] },
    before: { type: "string" },
    after: { type: "string" },
  },
  required: ["key", "kind", "before", "after"],
};

export const outputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: { type: "string" },
    ok: { type: "boolean" },
    projectDir: { type: "string" },
    iocPath: { type: "string" },
    planId: { type: "string" },
    sourceSha256: { type: "string" },
    candidateSha256: { type: "string" },
    changes: { type: "array", items: changeSchema },
    pinsAfter: { type: "array", items: { type: "string" } },
    warnings: { type: "array", items: { type: "string" } },
    notes: { type: "array", items: { type: "string" } },
    errors: { type: "array", items: { type: "string" } },
    nextStep: { type: "string" },
  },
  required: [
    "message", "ok", "projectDir", "iocPath", "planId", "sourceSha256", "candidateSha256",
    "changes", "pinsAfter", "warnings", "notes", "errors", "nextStep",
  ],
};

interface IocPlanArgs {
  projectDir?: string;
  iocPath?: string;
  entries?: { key: string; value: string }[];
  unset?: string[];
  pins?: PinAddRequest[];
  serialWire?: boolean;
}

interface ChangeView {
  key: string;
  kind: "added" | "removed" | "changed";
  before: string;
  after: string;
}

/** 宿主不接受 null（声明为 string 的字段给 null 会被拒），所以"不存在"用空串表达。 */
function toViews(changes: IocPlanChange[]): ChangeView[] {
  return changes.map((change) => ({
    key: change.key,
    kind: change.before === null ? "added" : change.after === null ? "removed" : "changed",
    before: change.before ?? "",
    after: change.after ?? "",
  }));
}

function format(changes: ChangeView[], message: string, warnings: string[], errors: string[], nextStep: string): string[] {
  const lines: string[] = [message];
  for (const change of changes.slice(0, 40)) {
    if (change.kind === "added") lines.push("  + " + change.key + "=" + change.after);
    else if (change.kind === "removed") lines.push("  - " + change.key + " (原值 " + change.before + ")");
    else lines.push("  ~ " + change.key + ": " + change.before + " -> " + change.after);
  }
  if (changes.length > 40) lines.push("  … 还有 " + String(changes.length - 40) + " 个键");
  for (const warning of warnings) lines.push("! " + warning);
  for (const error of errors.slice(0, 8)) lines.push("x " + error);
  if (nextStep !== "") lines.push("", nextStep);
  return lines;
}

export function registerIocPlan(ctx: DshContext): void {
  ctx.tools.register({
    name: IOC_PLAN_TOOL,
    description:
      "改 STM32CubeMX .ioc 的第一步：只读源文件、算出逐键 diff 与源 SHA-256，返回 planId，不写盘。支持 entries(设键)/unset(删键)/pins(加 GPIO 引脚)/serialWire(补 Serial Wire 调试口)。确认 diff 之后必须用 stm32_ioc_apply({planId}) 才真正写入。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectDir: { type: "string", description: "工程根目录；缺省为当前工作目录。" },
        iocPath: { type: "string", description: "显式指定 .ioc（相对工程目录）；默认找工程里唯一的 *.ioc。" },
        entries: {
          type: "array",
          description: "直接设置/新增的键，例如 RCC.SYSCLKSource。",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { key: { type: "string" }, value: { type: "string" } },
            required: ["key", "value"],
          },
        },
        unset: { type: "array", items: { type: "string" }, description: "要删除的键。" },
        pins: {
          type: "array",
          description: "新增 GPIO 引脚（会重写 Mcu.PinN / Mcu.PinsNb 并校验芯片引脚表）。",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              pin: { type: "string", description: "引脚名，如 PA0、PC13。" },
              signal: { type: "string", enum: ["input", "output"], description: "缺省 output。" },
              label: { type: "string", description: "GPIO 标签（合法 C 标识符，生成 <label>_Pin）。" },
              pull: { type: "string", enum: ["none", "up", "down"] },
              speed: { type: "string", enum: ["low", "medium", "high"] },
            },
            required: ["pin"],
          },
        },
        serialWire: { type: "boolean", description: "确保 PA13/PA14 是 Serial Wire，并清掉 No_Debug（VP_SYS_VS_ND）残留。" },
      },
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    output: {
      schema: outputSchema,
      render: (_args, value) => {
        const typed = value as { changes: ChangeView[]; message: string; warnings: string[]; errors: string[]; nextStep: string };
        return [{ type: "text", text: format(typed.changes, typed.message, typed.warnings, typed.errors, typed.nextStep).join("\n") }];
      },
    },
    async execute(rawArgs: IocPlanArgs, exec: ToolExec) {
      const resolution = await resolveProjectDir(ctx, rawArgs.projectDir, exec);
      const report = planIocChanges({
        projectDir: resolution.projectDir,
        ...(rawArgs.iocPath === undefined ? {} : { iocPath: rawArgs.iocPath }),
        ...(rawArgs.entries === undefined ? {} : { entries: rawArgs.entries }),
        ...(rawArgs.unset === undefined ? {} : { unset: rawArgs.unset }),
        ...(rawArgs.pins === undefined ? {} : { pins: rawArgs.pins }),
        ...(rawArgs.serialWire === undefined ? {} : { serialWire: rawArgs.serialWire }),
      });
      if (resolution.note !== null) report.notes.push(resolution.note);
      const changes = toViews(report.changes);
      const nextStep = report.ok
        ? "确认无误后：stm32_ioc_apply({ projectDir: \"" + report.projectDir.replace(/\\/gu, "/") + "\", planId: \"" + report.planId + "\" })，然后 stm32_generate 重新生成代码。"
        : "";
      return {
        message: report.message,
        ok: report.ok,
        projectDir: report.projectDir,
        iocPath: report.iocPath,
        planId: report.planId,
        sourceSha256: report.sourceSha256,
        candidateSha256: report.candidateSha256,
        changes,
        pinsAfter: (report.summaryAfter?.pins ?? []).map((pin) => pin.pin),
        warnings: report.warnings,
        notes: report.notes,
        errors: report.errors,
        nextStep,
      };
    },
  });
}
