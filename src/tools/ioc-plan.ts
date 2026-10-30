/**
 * L3：stm32_ioc_plan —— 改 .ioc 的第一步：只算不写（规格 I3、§11 A8）。
 *
 * 返回 planId + 源文件 SHA-256 + 逐键 diff。确认之后必须调用 stm32_ioc_apply({ planId })，
 * apply 会核对源文件 SHA-256 是否还是 plan 时那份（期间你若用 CubeMX GUI 改过就会被拒绝）。
 *
 * 时钟（clock 入参）走同一个 plan：时钟就是 .ioc 里的一段键，单开工具会让"改引脚"和"改时钟"
 * 变成两次 plan/apply，中间还可能留下 PLL 与 APB 分频不自洽的中间态。详见 engine/clock-plan.ts。
 */

import { planIocChanges } from "../engine/ioc-plan.js";
import type { IocPlanChange, PinAddRequest } from "../engine/ioc-plan.js";
import { formatHz } from "../engine/clock-plan.js";
import type { ClockPlan, ClockPlanRequest } from "../engine/clock-plan.js";
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

const clockRequestedSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    targetHz: { type: "number" },
    pllSource: { type: "string" },
    pllMul: { type: "number" },
    apb1Div: { type: "number" },
    apb2Div: { type: "number" },
    adcDiv: { type: "number" },
  },
  required: ["targetHz", "pllSource", "pllMul", "apb1Div", "apb2Div", "adcDiv"],
};

const clockChainSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    pllSource: { type: "string" },
    pllSourceLabel: { type: "string" },
    pllInHz: { type: "number" },
    pllMul: { type: "number" },
    pllClkHz: { type: "number" },
    sysclkHz: { type: "number" },
    hclkHz: { type: "number" },
    apb1Div: { type: "number" },
    apb1Hz: { type: "number" },
    apb1TimHz: { type: "number" },
    apb2Div: { type: "number" },
    apb2Hz: { type: "number" },
    apb2TimHz: { type: "number" },
    adcDiv: { type: "number" },
    adcHz: { type: "number" },
    usbHz: { type: "number" },
    usbAvailable: { type: "boolean" },
    usbPrescaled: { type: "boolean" },
    mcoHz: { type: "number" },
  },
  required: [
    "pllSource", "pllSourceLabel", "pllInHz", "pllMul", "pllClkHz", "sysclkHz", "hclkHz",
    "apb1Div", "apb1Hz", "apb1TimHz", "apb2Div", "apb2Hz", "apb2TimHz", "adcDiv", "adcHz",
    "usbHz", "usbAvailable", "usbPrescaled", "mcoHz",
  ],
};

const clockAlternativeSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    sysclkHz: { type: "number" },
    pllSource: { type: "string" },
    pllSourceLabel: { type: "string" },
    pllMul: { type: "number" },
    apb1Div: { type: "number" },
    adcDiv: { type: "number" },
    usbAvailable: { type: "boolean" },
    deltaHz: { type: "number" },
  },
  required: ["sysclkHz", "pllSource", "pllSourceLabel", "pllMul", "apb1Div", "adcDiv", "usbAvailable", "deltaHz"],
};

const clockPeripheralSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    bus: { type: "string" },
    clockHz: { type: "number" },
    note: { type: "string" },
  },
  required: ["id", "label", "bus", "clockHz", "note"],
};

const clockBaudRowSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    baud: { type: "number" },
    brr: { type: "number" },
    actualBaud: { type: "number" },
    errorPercent: { type: "number" },
  },
  required: ["baud", "brr", "actualBaud", "errorPercent"],
};

const clockBaudTableSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    clockHz: { type: "number" },
    worstBaud: { type: "number" },
    worstErrorPercent: { type: "number" },
    rows: { type: "array", items: clockBaudRowSchema },
  },
  required: ["id", "clockHz", "worstBaud", "worstErrorPercent", "rows"],
};

const clockEntrySchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: { key: { type: "string" }, value: { type: "string" } },
  required: ["key", "value"],
};

const clockPlanSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { type: "string", enum: ["snapshot", "nearest", "explicit", "none"] },
    ok: { type: "boolean" },
    reachable: { type: "boolean" },
    deltaHz: { type: "number" },
    note: { type: "string" },
    requested: clockRequestedSchema,
    achieved: clockChainSchema,
    alternatives: { type: "array", items: clockAlternativeSchema },
    peripherals: { type: "array", items: clockPeripheralSchema },
    bauds: { type: "array", items: clockBaudTableSchema },
    entries: { type: "array", items: clockEntrySchema },
    unset: { type: "array", items: { type: "string" } },
    warnings: { type: "array", items: { type: "string" } },
    errors: { type: "array", items: { type: "string" } },
  },
  required: [
    "mode", "ok", "reachable", "deltaHz", "note", "requested", "achieved", "alternatives",
    "peripherals", "bauds", "entries", "unset", "warnings", "errors",
  ],
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
    clockPlan: clockPlanSchema,
  },
  required: [
    "message", "ok", "projectDir", "iocPath", "planId", "sourceSha256", "candidateSha256",
    "changes", "pinsAfter", "warnings", "notes", "errors", "nextStep", "clockPlan",
  ],
};

interface IocPlanArgs {
  projectDir?: string;
  iocPath?: string;
  entries?: { key: string; value: string }[];
  unset?: string[];
  pins?: PinAddRequest[];
  serialWire?: boolean;
  clock?: ClockPlanRequest;
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

/** 时钟段落：一行结论 + 总线/外设/波特率/备选，数字都从 clockPlan 里取，不重算。 */
function formatClock(plan: ClockPlan): string[] {
  if (plan.mode === "none" && plan.achieved.sysclkHz === 0) {
    return ["时钟：" + plan.note];
  }
  const chain = plan.achieved;
  const lines: string[] = [];
  lines.push("时钟：" + plan.note);
  lines.push(
    "  " + (plan.mode === "snapshot" ? "现状" : "结果") + "：SYSCLK " + formatHz(chain.sysclkHz) +
    " / HCLK " + formatHz(chain.hclkHz) +
    "（" + chain.pllSourceLabel + " ×" + String(chain.pllMul) + " = " + formatHz(chain.pllClkHz) + "）",
  );
  if (chain.sysclkHz > 0) {
    lines.push(
      "  总线：APB1 " + formatHz(chain.apb1Hz) + "（÷" + String(chain.apb1Div) + "，定时器 " + formatHz(chain.apb1TimHz) + "）" +
      " / APB2 " + formatHz(chain.apb2Hz) + "（÷" + String(chain.apb2Div) + "，定时器 " + formatHz(chain.apb2TimHz) + "）" +
      " / ADC " + formatHz(chain.adcHz) + "（÷" + String(chain.adcDiv) + "）" +
      " / USB " + (chain.usbAvailable ? formatHz(chain.usbHz) : "不可用") +
      " / MCO " + formatHz(chain.mcoHz),
    );
    for (const bus of ["apb2", "apb1", "ahb"] as const) {
      const rows = plan.peripherals.filter((item) => item.bus === bus);
      if (rows.length === 0) continue;
      const parts = rows.map((item) => {
        const tag = item.note.includes("未在 .ioc 启用") ? "（未启用）" : "";
        const clock = item.id === "USB" && !chain.usbAvailable ? "—" : formatHz(item.clockHz);
        return item.label + " " + clock + tag;
      });
      lines.push("  " + bus.toUpperCase() + " 外设：" + parts.join(" / "));
    }
    const baud = plan.bauds
      .filter((table) => table.clockHz > 0 && table.rows.length > 0)
      .map((table) => table.id + "@" + formatHz(table.clockHz) + " 最差 " + String(table.worstBaud) + " " +
        (table.worstErrorPercent > 0 ? "+" : "") + table.worstErrorPercent.toFixed(3) + "%");
    if (baud.length > 0) lines.push("  波特率误差（16 倍过采样，BRR=round(fCK/baud)）：" + baud.join(" / "));
  }
  if (!plan.reachable && plan.alternatives.length > 0) {
    const parts = plan.alternatives.map((item) => formatHz(item.sysclkHz) + "（差 " + (item.deltaHz >= 0 ? "+" : "-") + formatHz(Math.abs(item.deltaHz)) + "）");
    lines.push("  备选（按接近程度）：" + parts.join(" / "));
  }
  if (plan.entries.length > 0) {
    lines.push("  写入 " + String(plan.entries.length) + " 个 RCC 键（含 RCC.IPParameters 合并）；" +
      (plan.unset.length > 0 ? "删除 " + plan.unset.join("、") + "；" : "") + "逐个值见上面的 diff。");
  }
  return lines;
}

function format(
  changes: ChangeView[],
  message: string,
  warnings: string[],
  errors: string[],
  nextStep: string,
  clockPlan: ClockPlan,
): string[] {
  const lines: string[] = [message];
  for (const change of changes.slice(0, 40)) {
    if (change.kind === "added") lines.push("  + " + change.key + "=" + change.after);
    else if (change.kind === "removed") lines.push("  - " + change.key + " (原值 " + change.before + ")");
    else lines.push("  ~ " + change.key + ": " + change.before + " -> " + change.after);
  }
  if (changes.length > 40) lines.push("  … 还有 " + String(changes.length - 40) + " 个键");
  lines.push(...formatClock(clockPlan));
  for (const warning of warnings) lines.push("! " + warning);
  for (const error of errors.slice(0, 8)) lines.push("x " + error);
  if (nextStep !== "") lines.push("", nextStep);
  return lines;
}

export function registerIocPlan(ctx: DshContext): void {
  ctx.tools.register({
    name: IOC_PLAN_TOOL,
    description:
      "改 STM32CubeMX .ioc 的第一步：只读源文件、算出逐键 diff 与源 SHA-256，返回 planId，不写盘。支持 entries(设键)/unset(删键)/pins(加 GPIO 引脚)/serialWire(补 Serial Wire 调试口)/clock(改时钟：targetHz 就近或 pllMul 定点，自动重算整套 RCC 派生键并给逐外设频率与 UART 波特率误差)。确认 diff 之后必须用 stm32_ioc_apply({planId}) 才真正写入。",
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
        clock: {
          type: "object",
          additionalProperties: false,
          description:
            "改时钟：给 targetHz 就近取最接近的合法档（不可达时报告明写「不可达，已选 X MHz」），或给 pllMul 定点；只会重算 RCC 的派生键，不动引脚。",
          properties: {
            targetHz: { type: "number", description: "目标 SYSCLK（Hz），例如 60000000。" },
            pllSource: { type: "string", enum: ["hse", "hsi-div2", "hsi"], description: "PLL 输入源；缺省按 .ioc 有没有配 HSE 晶振决定。" },
            pllMul: { type: "number", minimum: 2, maximum: 16, description: "定点倍频 ×2..×16；给了就不再就近搜。" },
            apb1Div: { type: "number", description: "APB1 分频 1/2/4/8/16；缺省取满足 APB1≤36 MHz 的最小分频。" },
            apb2Div: { type: "number", description: "APB2 分频；缺省 1（降频只会拖慢外设）。" },
            adcDiv: { type: "number", description: "ADC 预分频 2/4/6/8；缺省取满足 ADC≤14 MHz 的最小分频。" },
            usb: { type: "boolean", description: "按「要用 USB」规划（写 RCC.USBPrescaler=÷1.5，只有 PLLCLK=72 MHz 才给得出 48 MHz）。" },
            bauds: { type: "array", items: { type: "number" }, description: "要算整除误差的波特率档，缺省 9600…230400。" },
          },
        },
      },
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    output: {
      schema: outputSchema,
      render: (_args, value) => {
        const typed = value as {
          changes: ChangeView[];
          message: string;
          warnings: string[];
          errors: string[];
          nextStep: string;
          clockPlan: ClockPlan;
        };
        return [{ type: "text", text: format(typed.changes, typed.message, typed.warnings, typed.errors, typed.nextStep, typed.clockPlan).join("\n") }];
      },
    },
    async execute(rawArgs: IocPlanArgs | undefined, exec: ToolExec) {
      // 宿主可能不传 arguments（无参数调用）→ 兜成 {}：缺参数要表现成"报告说没事可做"，
      // 而不是 rawArgs.projectDir 上的 TypeError（审计 A31）。
      const args = rawArgs ?? {};
      const resolution = await resolveProjectDir(ctx, args.projectDir, exec);
      const report = planIocChanges({
        projectDir: resolution.projectDir,
        ...(args.iocPath === undefined ? {} : { iocPath: args.iocPath }),
        ...(args.entries === undefined ? {} : { entries: args.entries }),
        ...(args.unset === undefined ? {} : { unset: args.unset }),
        ...(args.pins === undefined ? {} : { pins: args.pins }),
        ...(args.serialWire === undefined ? {} : { serialWire: args.serialWire }),
        ...(args.clock === undefined ? {} : { clock: args.clock }),
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
        clockPlan: report.clockPlan,
      };
    },
  });
}
