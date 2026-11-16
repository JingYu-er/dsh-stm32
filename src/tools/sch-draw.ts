/**
 * 图纸手绘工具（S174）：在 `.kicad_sch` 文本上连线、标名、克隆元件、挪元件。
 *
 * 不需要 KiCad 进程：只改文件；校验用 `kicad-cli sch export netlist`（命令行，不开窗口）。
 * 目标文件固定在 `hardware/schematic/<name>.kicad_sch`，构建从不触碰它。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { DshContext, SubprocessService, ToolExec } from "../types.js";
import { resolveProjectDir } from "./project-dir.js";
import { resolveProjectLayout } from "../engine/project-layout.js";
import { findLatestKicadBuild, planEcadWorkspace } from "../engine/ecad/tsci.js";
import { locateEcadToolchain } from "../engine/ecad/toolchain.js";
import { runCapture } from "../engine/subprocess-runner.js";
import {
  drawOnSheet,
  drawSheetPath,
  readDrawSheet,
  seedDrawSheet,
  writeDrawSheet,
  type DrawOp,
  type DrawReport,
} from "../engine/schematic/draw.js";

export const SCH_DRAW_TOOL = "stm32_sch_draw";

interface DrawArgs {
  projectDir?: string;
  name?: string;
  seed?: boolean;
  check?: boolean;
  ops?: DrawOp[];
}

interface DrawValue {
  ok: boolean;
  error: string;
  sheet: string;
  seeded: boolean;
  applied: number;
  skipped: number;
  failed: string[];
  notes: string[];
  netlist: string;
}

function describeOp(op: DrawOp): string {
  if (op.op === "wire") return "wire";
  if (op.op === "label") return "label " + op.text;
  if (op.op === "clone") return "clone " + op.from + " → " + op.ref;
  if (op.op === "place") return "place " + op.libId + " → " + op.ref;
  if (op.op === "move") return "move " + op.ref;
  return "remove " + op.ref;
}

/**
 * 符号库来源：先工程里的 `libs/symbols/<Name>.kicad_sym`（S173 器件导入的落点），
 * 再 KiCad 官方库 `symbolDir/<Lib>.kicad_sym`。找不到返回 null，由调用方报错。
 */
function symbolLibrary(projectDir: string, symbolDir: string): (libId: string) => string | null {
  const cache = new Map<string, string | null>();
  return (libId) => {
    if (cache.has(libId)) return cache.get(libId) ?? null;
    const colon = libId.indexOf(":");
    const lib = colon >= 0 ? libId.slice(0, colon) : libId;
    const name = colon >= 0 ? libId.slice(colon + 1) : libId;
    const candidates = [
      join(projectDir, "libs", "symbols", name + ".kicad_sym"),
      join(projectDir, "libs", "symbols", lib + ".kicad_sym"),
      join(symbolDir, lib + ".kicad_sym"),
    ];
    for (const file of candidates) {
      if (!existsSync(file)) continue;
      const text = readFileSync(file, "utf8");
      if (text.includes('(symbol "' + name + '"')) {
        cache.set(libId, text);
        return text;
      }
    }
    if (existsSync(symbolDir)) {
      for (const file of readdirSync(symbolDir)) {
        if (!file.endsWith(".kicad_sym")) continue;
        const full = join(symbolDir, file);
        if (!file.startsWith(lib)) continue;
        const text = readFileSync(full, "utf8");
        if (text.includes('(symbol "' + name + '"')) {
          cache.set(libId, text);
          return text;
        }
      }
    }
    cache.set(libId, null);
    return null;
  };
}

/** 用 kicad-cli 导一次网表当验收；没装工具链就跳过，不判失败。 */
async function checkNetlist(
  subprocess: SubprocessService,
  sheet: string,
  outDir: string,
): Promise<{ ok: boolean; note: string }> {
  const located = locateEcadToolchain(process.env);
  if (!located.ok || located.toolchain === null) return { ok: true, note: "没找到 KiCad：跳过网表校验" };
  const capture = await runCapture(subprocess, {
    argv: [located.toolchain.kicadCli, "sch", "export", "netlist", "--output", outDir, sheet],
    timeoutMs: 60_000,
  });
  const text = capture.stdout + capture.stderr;
  if (capture.exitCode !== 0) return { ok: false, note: "kicad-cli 网表校验失败：" + text.trim().split("\n").slice(-2).join(" ") };
  return { ok: true, note: "kicad-cli 网表已导出：" + outDir };
}

export function registerSchDrawTools(ctx: DshContext): void {
  ctx.tools.register({
    name: SCH_DRAW_TOOL,
    description:
      "在原理图手绘层上画东西（不需要打开 KiCad）：wire 连两脚或两点、label 标网络名、clone 从图纸里已有元件复制一个（新位号/新位置）、move 挪元件、remove 删元件。文件固定在 hardware/schematic/<name>.kicad_sch，构建不会重写它；首次用 seed=true 从最近一次构建拷一份底图。写盘后用 kicad-cli 导一次网表校验（check 默认 true）。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectDir: { type: "string", description: "工程根目录；缺省为会话工作目录。" },
        name: { type: "string", description: "手绘图纸文件名（不含扩展名），默认 schematic。" },
        seed: { type: "boolean", description: "为 true 时，若手绘层不存在就从最近一次构建的图纸拷一份底图。" },
        check: { type: "boolean", description: "写盘后用 kicad-cli 导网表校验，默认 true。" },
        ops: {
          type: "array",
          description: "要执行的动作，按顺序应用。",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              op: { type: "string", enum: ["wire", "label", "clone", "move", "remove"] },
              a: { type: "object", additionalProperties: true, description: "wire 起点：{ref,pin} 或 {x,y}。" },
              b: { type: "object", additionalProperties: true, description: "wire 终点：{ref,pin} 或 {x,y}。" },
              at: { type: "object", additionalProperties: true, description: "label 位置 {ref,pin}|{x,y}；clone/move 的目标坐标 {x,y}。" },
              text: { type: "string", description: "label 的网络名。" },
              from: { type: "string", description: "clone 的源位号。" },
              libId: { type: "string", description: "place 的符号库编号，形如 Device:R_Small 或 MyLib:SOIC-8（来自 libs/symbols 或 KiCad 官方库）。" },
              footprint: { type: "string", description: "place 时顺手写的封装 Lib:Name。" },
              rotation: { type: "number", description: "place 的旋转角度，默认 0。" },
              ref: { type: "string", description: "clone 的新位号，或 move/remove 的目标位号。" },
              value: { type: "string", description: "clone 时顺手改 Value（如 10k）。" },
            },
            required: ["op"],
          },
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          error: { type: "string" },
          sheet: { type: "string" },
          seeded: { type: "boolean" },
          applied: { type: "number" },
          skipped: { type: "number" },
          failed: { type: "array", items: { type: "string" } },
          notes: { type: "array", items: { type: "string" } },
          netlist: { type: "string" },
        },
        required: ["ok", "error", "sheet", "seeded", "applied", "skipped", "failed", "notes", "netlist"],
      },
      render: (_args, value) => {
        const report = value as DrawValue;
        const lines: string[] = [];
        if (!report.ok && report.error !== "") lines.push(report.error);
        lines.push(`手绘图纸：${report.sheet}`);
        if (report.seeded) lines.push("已从最近一次构建拷来底图");
        if (report.applied > 0) lines.push(`这次画上 ${String(report.applied)} 个动作`);
        if (report.skipped > 0) lines.push(`已在图上跳过 ${String(report.skipped)} 个`);
        for (const failure of report.failed) lines.push(`失败：${failure}`);
        for (const note of report.notes) lines.push(note);
        if (report.netlist !== "") lines.push(report.netlist);
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    timeoutMs: 90_000,
    isConcurrencySafe: () => false,
    async execute(rawArgs: DrawArgs | undefined, exec: ToolExec): Promise<DrawValue> {
      const args = rawArgs ?? {};
      const resolution = await resolveProjectDir(ctx, args.projectDir, exec);
      const projectDir = resolution.projectDir;
      const layout = resolveProjectLayout(projectDir);
      const workspace = planEcadWorkspace(projectDir, layout.hardwareDir);
      const sheet = drawSheetPath(projectDir, (args.name ?? "schematic").trim() || "schematic");
      const notes: string[] = [];
      if (resolution.note !== null) notes.push(resolution.note);

      let seeded = false;
      if (args.seed === true && !existsSync(sheet)) {
        const latest = findLatestKicadBuild(workspace);
        if (!latest.ok) {
          return {
            ok: false,
            error: "还没有构建产物，无法拷底图：先跑一次 stm32_ecad_build",
            sheet,
            seeded: false,
            applied: 0,
            skipped: 0,
            failed: [],
            notes,
            netlist: "",
          };
        }
        const seededResult = seedDrawSheet(latest.schematicFile, sheet);
        if (!seededResult.ok) {
          return {
            ok: false,
            error: seededResult.error,
            sheet,
            seeded: false,
            applied: 0,
            skipped: 0,
            failed: [],
            notes,
            netlist: "",
          };
        }
        seeded = seededResult.seeded;
        if (seeded) notes.push("底图来自 " + latest.schematicFile);
      }

      const text = readDrawSheet(sheet);
      if (text === "") {
        return {
          ok: false,
          error: "手绘图纸还不存在：" + sheet + "。先带 seed=true 从构建产物拷一份底图。",
          sheet,
          seeded,
          applied: 0,
          skipped: 0,
          failed: [],
          notes,
          netlist: "",
        };
      }

      const ops = Array.isArray(args.ops) ? args.ops : [];
      if (ops.length === 0) {
        return { ok: true, error: "", sheet, seeded, applied: 0, skipped: 0, failed: [], notes: [...notes, "没有给 ops：只看了图纸"], netlist: "" };
      }

      const toolchain = locateEcadToolchain(process.env);
      const library = symbolLibrary(
        projectDir,
        toolchain.ok && toolchain.toolchain !== null ? toolchain.toolchain.symbolDir : "",
      );
      const report: DrawReport = drawOnSheet(text, sheet, ops, library);
      if (report.applied > 0) writeDrawSheet(sheet, report.text);
      notes.push(...report.notes.map((note) => "· " + note));
      notes.push("动作：" + ops.map(describeOp).join("、"));

      let netlist = "";
      if (args.check !== false) {
        const outDir = sheet.replace(/\.kicad_sch$/u, ".netlist.xml");
        const checked = await checkNetlist(ctx.subprocess, sheet, outDir);
        netlist = checked.note;
        if (!checked.ok) notes.push("网表校验没过：图纸可能还没连完整，这不等于写盘失败");
      }

      return {
        ok: report.ok,
        error: report.error,
        sheet,
        seeded,
        applied: report.applied,
        skipped: report.skipped,
        failed: [...report.failed],
        notes,
        netlist,
      };
    },
  });
}
