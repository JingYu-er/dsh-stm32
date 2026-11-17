/**
 * stm32_board_info：把 .ioc 里的事实写成 <工程>/dsh/mcu.json，给别的插件读（S184）。
 * 默认只回事实不落盘；write: true 才写，写完顺手报一次是否与当前 .ioc 同步。
 */

import type { DshContext, JsonSchema, ToolDefinition, ToolExec } from "../types.js";
import { collectMcuInfo, mcuInfoFreshness, mcuInfoPath, readMcuInfo, writeMcuInfo } from "../engine/mcu-info.js";
import { resolveProjectDir } from "./project-dir.js";

export const BOARD_INFO_TOOL = "stm32_board_info";

const infoOutput: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    error: { type: "string" },
    file: { type: "string" },
    written: { type: "boolean" },
    schema: { type: "string" },
    generatedAt: { type: "string" },
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
    clock: {
      type: "object",
      additionalProperties: false,
      properties: {
        sysclkHz: { type: "number" },
        ahbHz: { type: "number" },
        apb1Hz: { type: "number" },
        apb2Hz: { type: "number" },
      },
      required: ["sysclkHz", "ahbHz", "apb1Hz", "apb2Hz"],
    },
    debugPins: { type: "array", items: { type: "string" } },
    nvicCount: { type: "number" },
    peripheralCount: { type: "number" },
    pinCount: { type: "number" },
    pins: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          pin: { type: "string" },
          signal: { type: "string" },
          label: { type: "string" },
          mode: { type: "string" },
        },
        required: ["pin", "signal", "label", "mode"],
      },
    },
    stale: { type: "boolean" },
    staleReason: { type: "string" },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["ok", "error", "file", "written", "schema", "generatedAt", "mcu", "clock", "debugPins", "nvicCount", "peripheralCount", "pinCount", "pins", "stale", "staleReason", "notes"],
};

export function registerMcuInfoTools(ctx: DshContext): void {
  const tool: ToolDefinition = {
    name: BOARD_INFO_TOOL,
    description:
      "MCU 事实文件：把 .ioc 里的事实（型号、封装、时钟、调试口、引脚、外设、中断数）写成 <工程>/dsh/mcu.json，给别的插件或脚本读；默认只回事实，`write: true` 才落盘。文件带 .ioc 的 sha256 指纹，改过 .ioc 后要重新生成。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectDir: { type: "string", description: "工程根目录；缺省为当前调试会话的工程。" },
        write: { type: "boolean", description: "true 才写进 <工程>/dsh/mcu.json；默认只回事实。" },
        file: { type: "string", description: "覆盖输出路径（相对工程根）；缺省 dsh/mcu.json。" },
      },
      required: [],
    },
    output: {
      schema: infoOutput,
      render: (_args, value) => {
        const result = value as {
          ok: boolean;
          error: string;
          file: string;
          written: boolean;
          mcu: { cpn: string; name: string; family: string; package: string };
          clock: { sysclkHz: number; ahbHz: number; apb1Hz: number; apb2Hz: number };
          debugPins: string[];
          nvicCount: number;
          peripheralCount: number;
          pinCount: number;
          stale: boolean;
          staleReason: string;
          notes: string[];
        };
        if (!result.ok) return [{ type: "text", text: "读不到 MCU 事实：" + result.error }];
        const mhz = (hz: number): string => (hz > 0 ? String(hz / 1_000_000) + " MHz" : "—");
        const lines = [
          (result.written ? "已写入：" : "预览（未写盘）：") + result.file,
          result.mcu.cpn + "（" + result.mcu.package + " · " + result.mcu.family + "）· PIN " + String(result.pinCount) + " · 外设 " + String(result.peripheralCount) + " · 中断 " + String(result.nvicCount),
          "时钟 SYSCLK " + mhz(result.clock.sysclkHz) + " / APB1 " + mhz(result.clock.apb1Hz) + " / APB2 " + mhz(result.clock.apb2Hz),
          "调试口：" + (result.debugPins.length > 0 ? result.debugPins.join(" ") : "没有启用"),
        ];
        if (result.stale) lines.push("⚠ " + result.staleReason);
        for (const note of result.notes) lines.push("说明：" + note);
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    execute: async (args: { projectDir?: string; write?: boolean; file?: string }, exec: ToolExec) => {
      const empty = {
        ok: false,
        error: "",
        file: "",
        written: false,
        schema: "",
        generatedAt: "",
        mcu: { cpn: "", name: "", family: "", package: "" },
        clock: { sysclkHz: 0, ahbHz: 0, apb1Hz: 0, apb2Hz: 0 },
        debugPins: [] as string[],
        nvicCount: 0,
        peripheralCount: 0,
        pinCount: 0,
        pins: [] as Array<Record<string, string>>,
        stale: false,
        staleReason: "",
        notes: [] as string[],
      };
      const resolved = await resolveProjectDir(ctx, args.projectDir, exec);
      if (resolved.projectDir === "") return { ...empty, error: "projectDir 不能为空：从工具栏「工程」下拉里选一个，或先打开调试会话" };
      const collected = collectMcuInfo(resolved.projectDir);
      if (!collected.ok || collected.info === null) return { ...empty, error: collected.error };
      const info = collected.info;
      const target = args.file === undefined || args.file.trim() === "" ? mcuInfoPath(resolved.projectDir) : (args.file.trim().match(/^[A-Za-z]:/u) ? args.file.trim() : joinPath(resolved.projectDir, args.file.trim()));
      const shouldWrite = args.write === true;
      const written = shouldWrite ? writeMcuInfo(target, info) : { ok: true, error: "" };
      if (!written.ok) return { ...empty, error: written.error, file: target };
      const freshness = readMcuInfo(target);
      const stale = freshness.ok && freshness.info !== null ? mcuInfoFreshness(freshness.info, resolved.projectDir) : { stale: false, reason: "" };
      return {
        ok: true,
        error: "",
        file: target,
        written: shouldWrite,
        schema: info.schema,
        generatedAt: info.generatedAt,
        mcu: { ...info.mcu },
        clock: {
          sysclkHz: info.clock.sysclkHz ?? 0,
          ahbHz: info.clock.ahbHz ?? 0,
          apb1Hz: info.clock.apb1Hz ?? 0,
          apb2Hz: info.clock.apb2Hz ?? 0,
        },
        debugPins: [...info.debug.pins],
        nvicCount: info.nvicCount,
        peripheralCount: info.peripherals.length,
        pinCount: info.pins.length,
        pins: info.pins.map((pin) => ({ pin: pin.pin, signal: pin.signal, label: pin.label, mode: pin.mode })),
        stale: stale.stale,
        staleReason: stale.reason,
        notes: [...info.notes],
      };
    },
  };
  ctx.tools.register(tool);
}

function joinPath(base: string, rel: string): string {
  const normalized = rel.replace(/\\/gu, "/");
  return base.replace(/[\\/]+$/u, "") + "/" + normalized;
}
