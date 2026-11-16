/**
 * S172：把 KiCad 里的改动吸收回 tscircuit 源。
 *
 * 只做两件事：读板子得出「元件与网络」，按 B 方案把新源写回 `index.circuit.tsx`。
 * 不吸收坐标与画法——构建会重排，输出里每次都提示。
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { absorbFromKicad } from "../engine/ecad/import.js";
import { findLatestKicadBuild, planEcadWorkspace } from "../engine/ecad/tsci.js";
import { resolveProjectDir } from "./project-dir.js";
import type { DshContext, TextPart, ToolDefinition, ToolExec } from "../types.js";

export const SCH_IMPORT_TOOL = "stm32_sch_import";

interface ImportRenderValue {
  ok: boolean;
  error: string;
  sourceFile: string;
  written: boolean;
  parts: { ref: string; kind: string; value: string; footprint: string }[];
  nets: { name: string; pins: string[] }[];
  diff: { added: string[]; removed: string[]; changed: string[]; previousNets: number };
  source: string;
  notes: string[];
}

function renderImport(result: ImportRenderValue): TextPart[] {
  if (!result.ok) return [{ type: "text", text: "吸收失败：" + result.error }];
  const lines: string[] = [];
  lines.push((result.written ? "已写回：" : "预览（未写盘）：") + result.sourceFile);
  lines.push("元件 " + String(result.parts.length) + " 个：" + result.parts.map((part) => part.ref + "(" + part.kind + ")").join("、"));
  lines.push(
    "命名网络 " + String(result.nets.length) + " 条" + (result.nets.length > 0 ? "：" + result.nets.map((net) => net.name + "(" + String(net.pins.length) + " 脚)").join("、") : ""),
  );
  if (result.diff.added.length > 0) lines.push("新增：" + result.diff.added.join("、"));
  if (result.diff.removed.length > 0) lines.push("移除：" + result.diff.removed.join("、"));
  if (result.diff.changed.length > 0) lines.push("改值：" + result.diff.changed.join("、"));
  for (const note of result.notes) lines.push("说明：" + note);
  lines.push("—— 生成的新源 ——");
  lines.push(result.source);
  return [{ type: "text", text: lines.join("\n") }];
}

const importOutput = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    error: { type: "string" },
    projectDir: { type: "string" },
    sourceFile: { type: "string" },
    written: { type: "boolean" },
    parts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          ref: { type: "string" },
          kind: { type: "string" },
          value: { type: "string" },
          footprint: { type: "string" },
          suppliers: { type: "array", items: { type: "string" } },
        },
        required: ["ref", "kind", "value", "footprint", "suppliers"],
      },
    },
    nets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { name: { type: "string" }, pins: { type: "array", items: { type: "string" } } },
        required: ["name", "pins"],
      },
    },
    diff: {
      type: "object",
      additionalProperties: false,
      properties: {
        added: { type: "array", items: { type: "string" } },
        removed: { type: "array", items: { type: "string" } },
        changed: { type: "array", items: { type: "string" } },
        previousParts: { type: "number" },
        previousNets: { type: "number" },
      },
      required: ["added", "removed", "changed", "previousParts", "previousNets"],
    },
    source: { type: "string" },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["ok", "error", "projectDir", "sourceFile", "written", "parts", "nets", "diff", "source", "notes"],
};

export function registerImportTools(ctx: DshContext): void {
  const tool: ToolDefinition = {
    name: SCH_IMPORT_TOOL,
    description:
      "把 KiCad 里的改动吸收回 tscircuit 源：读最近一次构建的 .kicad_pcb，得出元件清单与网络，生成新的 hardware/circuit/index.circuit.tsx。默认只出差异与新源（diff），write 才落盘（先留 .bak）。坐标与画法不保留，构建时会重排。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectDir: { type: "string", description: "工程根目录；缺省为会话工作目录。" },
        mode: { type: "string", enum: ["diff", "write"], description: "diff（默认）只出结果；write 写回源文件。" },
        boardFile: { type: "string", description: "指定 .kicad_pcb；缺省取最近一次构建的板子。" },
        sourceFile: { type: "string", description: "要写的 tscircuit 源；缺省 hardware/circuit/index.circuit.tsx。" },
      },
    },
    output: { schema: importOutput, render: (_args, value) => renderImport(value as ImportRenderValue) },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    execute: async (args: { projectDir?: string; mode?: "diff" | "write"; boardFile?: string; sourceFile?: string }, exec: ToolExec) => {
      const empty = {
        ok: false,
        error: "",
        projectDir: "",
        sourceFile: "",
        written: false,
        parts: [] as { ref: string; kind: string; value: string; footprint: string; suppliers: string[] }[],
        nets: [] as { name: string; pins: string[] }[],
        diff: { added: [] as string[], removed: [] as string[], changed: [] as string[], previousParts: 0, previousNets: 0 },
        source: "",
        notes: [] as string[],
      };
      const resolved = await resolveProjectDir(ctx, args.projectDir, exec);
      if (resolved.projectDir === "") return { ...empty, error: "projectDir 不能为空：从工具栏「工程」下拉里选一个，或先打开调试会话" };
      const workspace = planEcadWorkspace(resolved.projectDir, join(resolved.projectDir, "hardware"));
      const latest = findLatestKicadBuild(workspace);
      const boardFile = args.boardFile !== undefined && args.boardFile !== "" ? args.boardFile : latest.ok ? latest.pcbFile : "";
      if (boardFile === "" || !existsSync(boardFile)) {
        return { ...empty, error: "还没有 .kicad_pcb：先跑一次 stm32_ecad_build，或在 KiCad 里存一次板子", projectDir: resolved.projectDir };
      }
      const sourceFile = args.sourceFile !== undefined && args.sourceFile !== "" ? args.sourceFile : join(workspace.circuitDir, "index.circuit.tsx");
      const circuitJsonFile = join(dirname(boardFile), "..", "circuit.json");
      const report = absorbFromKicad(resolved.projectDir, {
        boardFile,
        sourceFile,
        circuitJsonFile,
        write: args.mode === "write",
      });
      if (!report.ok) return { ...empty, projectDir: resolved.projectDir, sourceFile, error: report.error, notes: report.notes };
      return {
        ok: true,
        error: "",
        projectDir: resolved.projectDir,
        sourceFile: report.sourceFile,
        written: report.written,
        parts: report.state.parts.map((part) => ({ ref: part.ref, kind: part.kind, value: part.value, footprint: part.footprint, suppliers: part.suppliers })),
        nets: report.state.nets.map((net) => ({ name: net.name, pins: net.pins.map((pin) => pin.ref + "." + pin.pin) })),
        diff: report.diff,
        source: report.source,
        notes: report.notes,
      };
    },
  };
  ctx.tools.register(tool);
}
