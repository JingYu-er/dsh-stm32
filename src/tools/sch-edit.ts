/**
 * 原理图编辑工具（S170）：把「连两根引脚、给引脚起名」存成指令，构建收尾时重放。
 *
 * 不直接改 `.kicad_sch`：那是 tscircuit 的产物，每次构建都会重写；
 * 直接改等于骗自己——下一次构建就没了。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DshContext, ToolExec } from "../types.js";
import { resolveProjectDir } from "./project-dir.js";
import { resolveProjectLayout } from "../engine/project-layout.js";
import { findLatestKicadBuild, planEcadWorkspace } from "../engine/ecad/tsci.js";
import {
  editStorePath,
  readSchEdits,
  replaySchEditsTo,
  writeSchEdits,
  type SchReplayReport,
  type SchEdit,
} from "../engine/schematic/edit.js";

export const SCH_EDIT_TOOL = "stm32_sch_edit";

interface EditArgs {
  projectDir?: string;
  mode?: "list" | "add" | "clear";
  a?: { ref?: string; pin?: string };
  b?: { ref?: string; pin?: string };
  text?: string;
}

interface EditValue {
  ok: boolean;
  error: string;
  store: string;
  edits: { op: string; a: string; b: string; text: string }[];
  applied: number;
  skipped: number;
  failed: string[];
  notes: string[];
}

function describe(edit: SchEdit): { op: string; a: string; b: string; text: string } {
  if (edit.op === "connect") {
    return { op: "connect", a: `${edit.a.ref}.${edit.a.pin}`, b: `${edit.b.ref}.${edit.b.pin}`, text: "" };
  }
  return { op: "label", a: `${edit.at.ref}.${edit.at.pin}`, b: "", text: edit.text };
}

/** 把指令重放到当前最新构建出来的原理图上；没有构建产物就只存指令。 */
function replayNow(projectDir: string, edits: readonly SchEdit[]): SchReplayReport {
  const layout = resolveProjectLayout(projectDir);
  const workspace = planEcadWorkspace(projectDir, layout.hardwareDir);
  const latest = findLatestKicadBuild(workspace);
  const kicadDir = latest.ok ? latest.kicadDir : "";
  return replaySchEditsTo(kicadDir, edits);
}

export function registerSchEditTools(ctx: DshContext): void {
  ctx.tools.register({
    name: SCH_EDIT_TOOL,
    description:
      "编辑原理图的电气连接：把两个引脚连起来（connect），或给某个引脚标网络名（label）。指令存在 circuit/schematic-edits.json，每次 stm32_ecad_build 收尾重放，因此不会被下一次构建抹掉；重放失败会明确报出是哪个引脚找不到。mode=list 看已有指令，clear 清空。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectDir: { type: "string", description: "工程根目录；缺省为会话工作目录。" },
        mode: { type: "string", enum: ["list", "add", "clear"], description: "默认 list。" },
        a: {
          type: "object",
          additionalProperties: false,
          description: "connect 的第一端，或 label 的目标引脚。",
          properties: { ref: { type: "string" }, pin: { type: "string" } },
        },
        b: {
          type: "object",
          additionalProperties: false,
          description: "connect 的第二端。",
          properties: { ref: { type: "string" }, pin: { type: "string" } },
        },
        text: { type: "string", description: "label 的网络名。" },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          error: { type: "string" },
          store: { type: "string" },
          edits: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { op: { type: "string" }, a: { type: "string" }, b: { type: "string" }, text: { type: "string" } },
              required: ["op", "a", "b", "text"],
            },
          },
          applied: { type: "number" },
          skipped: { type: "number" },
          failed: { type: "array", items: { type: "string" } },
          notes: { type: "array", items: { type: "string" } },
        },
        required: ["ok", "error", "store", "edits", "applied", "skipped", "failed", "notes"],
      },
      render: (_args, value) => {
        const report = value as EditValue;
        const lines: string[] = [];
        if (!report.ok) return [{ type: "text", text: report.error }];
        lines.push(`原理图指令：${String(report.edits.length)} 条（${report.store}）`);
        for (const edit of report.edits) {
          lines.push(
            edit.op === "connect" ? `  连线 ${edit.a} ↔ ${edit.b}` : `  标名 ${edit.a} → ${edit.text}`,
          );
        }
        if (report.applied > 0) lines.push(`这次画上 ${String(report.applied)} 条`);
        if (report.skipped > 0) lines.push(`已在图上 ${String(report.skipped)} 条`);
        for (const failure of report.failed) lines.push(`失败：${failure}`);
        for (const note of report.notes) lines.push(note);
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    async execute(rawArgs: EditArgs | undefined, exec: ToolExec): Promise<EditValue> {
      const args = rawArgs ?? {};
      const resolution = await resolveProjectDir(ctx, args.projectDir, exec);
      const projectDir = resolution.projectDir;
      const layout = resolveProjectLayout(projectDir);
      const workspace = planEcadWorkspace(projectDir, layout.hardwareDir);
      const store = editStorePath(workspace.circuitDir);
      const existing = readSchEdits(store);
      const mode = args.mode ?? "list";
      const base = () => ({
        ok: true,
        error: "",
        store,
        edits: existing.map(describe),
        applied: 0,
        skipped: 0,
        failed: [] as string[],
        notes: resolution.note === null ? [] : [resolution.note],
      });

      if (mode === "clear") {
        writeSchEdits(store, []);
        return { ...base(), edits: [], notes: [...base().notes, "指令表已清空；已经画在图纸上的线要等下次构建才会消失"] };
      }

      const next: SchEdit[] = [...existing];
      if (mode === "add") {
        const a = { ref: (args.a?.ref ?? "").trim(), pin: (args.a?.pin ?? "").trim() };
        if (a.ref === "" || a.pin === "") {
          return { ...base(), ok: false, error: "a.ref 与 a.pin 都要给：先说明连哪个元件的哪一脚" };
        }
        if ((args.text ?? "").trim() !== "") {
          next.push({ op: "label", at: a, text: (args.text ?? "").trim() });
        } else {
          const b = { ref: (args.b?.ref ?? "").trim(), pin: (args.b?.pin ?? "").trim() };
          if (b.ref === "" || b.pin === "") {
            return { ...base(), ok: false, error: "connect 需要 a 与 b 两端；只给一端就带 text 当 label 用" };
          }
          if (a.ref === b.ref && a.pin === b.pin) {
            return { ...base(), ok: false, error: "两端是同一个引脚：这不是连线" };
          }
          next.push({ op: "connect", a, b });
        }
        writeSchEdits(store, next);
      }

      const replay = replayNow(projectDir, next);
      return { ...base(), edits: next.map(describe), applied: replay.applied, skipped: replay.skipped, failed: [...replay.failed], notes: [...replay.notes] };
    },
  });
}
