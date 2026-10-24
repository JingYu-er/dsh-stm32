/**
 * L3：stm32_ioc_inspect —— 只读解析 .ioc，回答"这个工程配成了什么样"。
 *
 * 不写盘、不起进程，毫秒级返回。重点是派生判断：Serial Wire 调试口是否启用
 * （没启用会生成 __HAL_AFIO_REMAP_SWJ_DISABLE()，烧录后 SWD 连不上）、
 * KeepUserCode 是否开启、目标工具链/落位目录是否与 CMake 工程一致。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { findIocFile } from "../engine/generate.js";
import { summarizeIoc } from "../engine/ioc.js";
import type { IocSummary } from "../engine/ioc.js";
import type { DshContext, JsonSchema, ToolExec } from "../types.js";
import { resolveProjectDir } from "./project-dir.js";

export const IOC_INSPECT_TOOL = "stm32_ioc_inspect";

const pinSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    pin: { type: "string" },
    signal: { type: "string" },
    label: { type: "string" },
    mode: { type: "string" },
    locked: { type: "boolean" },
    kind: { type: "string", enum: ["gpio", "debug", "clock", "virtual", "other"] },
  },
  required: ["pin", "signal", "label", "mode", "locked", "kind"],
};

const settingsSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    targetToolchain: { type: "string" },
    projectName: { type: "string" },
    mainLocation: { type: "string" },
    coupleFile: { type: "boolean" },
    keepUserCode: { type: "boolean" },
    heapSize: { type: "string" },
    stackSize: { type: "string" },
    compilerOptimize: { type: "string" },
    firmwarePackage: { type: "string" },
    mcuCubeVersion: { type: "string" },
  },
  required: [
    "targetToolchain",
    "projectName",
    "mainLocation",
    "coupleFile",
    "keepUserCode",
    "heapSize",
    "stackSize",
    "compilerOptimize",
    "firmwarePackage",
    "mcuCubeVersion",
  ],
};

const clocksSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    sysclkHz: { type: "string" },
    ahbHz: { type: "string" },
    apb1Hz: { type: "string" },
    apb2Hz: { type: "string" },
    sysclkSource: { type: "string" },
    pllSource: { type: "string" },
    pllMul: { type: "string" },
    apb1Divider: { type: "string" },
  },
  required: ["sysclkHz", "ahbHz", "apb1Hz", "apb2Hz", "sysclkSource", "pllSource", "pllMul", "apb1Divider"],
};

const debugSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    serialWire: { type: "boolean" },
    jtag: { type: "boolean" },
    pins: { type: "array", items: { type: "string" } },
    mode: { type: "string" },
  },
  required: ["serialWire", "jtag", "pins", "mode"],
};

export const outputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    found: { type: "boolean" },
    path: { type: "string" },
    message: { type: "string" },
    mcu: {
      type: "object",
      additionalProperties: false,
      properties: {
        cpn: { type: "string" },
        name: { type: "string" },
        family: { type: "string" },
        package: { type: "string" },
      },
      required: ["cpn", "name", "family", "package"],
    },
    settings: settingsSchema,
    debug: debugSchema,
    clocks: clocksSchema,
    pins: { type: "array", items: pinSchema },
    peripherals: { type: "array", items: { type: "string" } },
    nvicEnabled: { type: "array", items: { type: "string" } },
    warnings: { type: "array", items: { type: "string" } },
    entryCount: { type: "number" },
  },
  required: ["found", "path", "message", "warnings"],
};

interface IocInspectArgs {
  projectDir?: string;
  iocPath?: string;
}

interface EmptyValue {
  found: boolean;
  path: string;
  message: string;
  warnings: string[];
}

interface IocValue extends EmptyValue {
  mcu: IocSummary["mcu"];
  settings: IocSummary["settings"];
  debug: IocSummary["debug"];
  clocks: Record<keyof IocSummary["clocks"], string>;
  pins: IocSummary["pins"];
  peripherals: string[];
  nvicEnabled: string[];
  entryCount: number;
}

function hz(value: number | null): string {
  return value === null ? "" : String(value);
}

function toValue(summary: IocSummary): IocValue {
  return {
    found: true,
    path: summary.path,
    message: "已解析 " + summary.entryCount + " 个键，" + summary.pins.length + " 个引脚",
    mcu: summary.mcu,
    settings: summary.settings,
    debug: summary.debug,
    clocks: {
      sysclkHz: hz(summary.clocks.sysclkHz),
      ahbHz: hz(summary.clocks.ahbHz),
      apb1Hz: hz(summary.clocks.apb1Hz),
      apb2Hz: hz(summary.clocks.apb2Hz),
      sysclkSource: summary.clocks.sysclkSource,
      pllSource: summary.clocks.pllSource,
      pllMul: summary.clocks.pllMul,
      apb1Divider: summary.clocks.apb1Divider,
    },
    pins: summary.pins,
    peripherals: summary.peripherals,
    nvicEnabled: summary.nvicEnabled,
    warnings: summary.warnings,
    entryCount: summary.entryCount,
  };
}

function formatValue(value: IocValue): string[] {
  const lines: string[] = [];
  lines.push("MCU：" + (value.mcu.cpn || "?") + "（" + (value.mcu.name || "?") + "，" + (value.mcu.package || "?") + "）");
  lines.push("工程：" + (value.settings.projectName || "?") + "  工具链 " + (value.settings.targetToolchain || "?") + "  落位 " + (value.settings.mainLocation || "?"));
  lines.push(
    "调试口：" + (value.debug.serialWire ? "Serial Wire 已启用" : "未启用 Serial Wire") + (value.debug.pins.length === 0 ? "" : "（" + value.debug.pins.join(", ") + "）"),
  );
  lines.push(
    "时钟：SYSCLK " + (value.clocks.sysclkHz || "?") + " Hz，APB1 " + (value.clocks.apb1Hz || "?") + " Hz，APB2 " + (value.clocks.apb2Hz || "?") + " Hz",
  );
  const gpio = value.pins.filter((pin) => pin.kind === "gpio");
  if (gpio.length > 0) {
    lines.push("");
    lines.push("GPIO：");
    for (const pin of gpio) {
      lines.push("  " + pin.pin.padEnd(22) + pin.signal.padEnd(14) + (pin.label === "" ? "" : pin.label));
    }
  }
  if (value.peripherals.length > 0) lines.push("外设：" + value.peripherals.join(", "));
  if (value.nvicEnabled.length > 0) lines.push("中断：" + value.nvicEnabled.join(", "));
  for (const warning of value.warnings) lines.push("! " + warning);
  return lines;
}

export function registerIocInspect(ctx: DshContext): void {
  ctx.tools.register({
    name: IOC_INSPECT_TOOL,
    description:
      "只读解析 STM32CubeMX 的 .ioc：MCU 型号、引脚/信号/GPIO 标签、使能的外设与中断、时钟树频率、工程设置（工具链/落位/KeepUserCode/CoupleFile）。会给出风险提醒，尤其是「没启用 Serial Wire 调试口会生成 SWJ_DISABLE 导致烧录后连不上」。不写盘、不起进程。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectDir: { type: "string", description: "工程根目录；缺省为当前工作目录。" },
        iocPath: { type: "string", description: "显式 .ioc 路径（相对路径按 projectDir 解析）；缺省在 projectDir 里找唯一的 *.ioc。" },
      },
      required: [],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    output: {
      schema: outputSchema,
      render: (_args, value) => {
        const typed = value as IocValue | EmptyValue;
        if (!(typed as IocValue).found) {
          return [{ type: "text", text: typed.message }];
        }
        return [{ type: "text", text: formatValue(typed as IocValue).join("\n") }];
      },
    },
    async execute(rawArgs: IocInspectArgs | undefined, exec: ToolExec): Promise<IocValue | EmptyValue> {
      const args = rawArgs ?? {};
      const resolution = await resolveProjectDir(ctx, args.projectDir, exec);
      const projectDir = resolution.projectDir;
      const iocPath = args.iocPath === undefined ? findIocFile(projectDir) : resolve(projectDir, args.iocPath);
      if (iocPath === null) {
        return { found: false, path: "", message: "在 " + projectDir + " 里没找到唯一的 *.ioc，请用 iocPath 指定", warnings: [] };
      }
      let text: string;
      try {
        text = readFileSync(iocPath, "utf8");
      } catch (error) {
        return { found: false, path: iocPath, message: "读取 " + iocPath + " 失败：" + String(error), warnings: [] };
      }
      return toValue(summarizeIoc(text, iocPath));
    },
  });
}
