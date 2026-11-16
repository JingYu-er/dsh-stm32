/**
 * 图纸手绘工具（S174）：在 `.kicad_sch` 文本上连线、标名、克隆元件、挪元件。
 *
 * 不需要 KiCad 进程：只改文件；校验用 `kicad-cli sch export netlist`（命令行，不开窗口）。
 * 目标文件固定在 `hardware/schematic/<name>.kicad_sch`，构建从不触碰它。
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import type { DshContext, JsonSchema, SubprocessService, ToolExec } from "../types.js";
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

import {
  backupBoardFile,
  buildHandSyncScript,
  parseHandSyncOutput,
  planHandSync,
} from "../engine/ecad/pcb/hand-sync.js";

export const SCH_DRAW_TOOL = "stm32_sch_draw";
export const SCH_SYNC_TOOL = "stm32_sch_sync";

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
              op: { type: "string", enum: ["wire", "label", "clone", "move", "remove", "place"] },
              a: { type: "object", additionalProperties: true, description: "wire 起点：{ref,pin} 或 {x,y}。" },
              b: { type: "object", additionalProperties: true, description: "wire 终点：{ref,pin} 或 {x,y}。" },
              at: { type: "object", additionalProperties: true, description: "label 位置 {ref,pin}|{x,y}；clone/move 的目标坐标 {x,y}。" },
              text: { type: "string", description: "label 的网络名。" },
              from: { type: "string", description: "clone 的源位号。" },
              libId: { type: "string", description: "place 的符号库编号，形如 Device:R_Small 或 MyLib:SOIC-8（来自 libs/symbols 或 KiCad 官方库）。" },
              footprint: { type: "string", description: "clone/place 时写进 Footprint 属性的封装 Lib:Name（补到 PCB 时按它找库）。" },
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
  // 手绘层新放的器件补到板子上（S177）：默认只出计划，apply 才写盘。
  const syncOutput: JsonSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      ok: { type: "boolean" },
      error: { type: "string" },
      schematicFile: { type: "string" },
      boardFile: { type: "string" },
      applied: { type: "boolean" },
      added: { type: "number" },
      skipped: { type: "array", items: { type: "string" } },
      missingLib: { type: "array", items: { type: "string" } },
      unassigned: { type: "number" },
      parts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            ref: { type: "string" },
            value: { type: "string" },
            footprint: { type: "string" },
            x: { type: "number" },
            y: { type: "number" },
            nets: { type: "number" },
          },
          required: ["ref", "value", "footprint", "x", "y", "nets"],
        },
      },
      alreadyOnBoard: { type: "number" },
      noFootprint: { type: "array", items: { type: "string" } },
      notes: { type: "array", items: { type: "string" } },
    },
    required: ["ok", "error", "schematicFile", "boardFile", "applied", "added", "skipped", "missingLib", "unassigned", "parts", "alreadyOnBoard", "noFootprint", "notes"],
  };

  ctx.tools.register({
    name: SCH_SYNC_TOOL,
    description:
      "把手绘层（hardware/schematic）里新放的器件补到 PCB：按位号找板上没有的元件，按 Footprint 属性从库加载封装，赋板上已有的同名网络。默认只出计划（apply=false），写盘前留 .bak。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectDir: { type: "string", description: "工程根目录；缺省为会话工作目录。" },
        boardFile: { type: "string", description: "指定 .kicad_pcb；缺省取最近一次构建的板子。" },
        schematicFile: { type: "string", description: "指定手绘层；缺省 hardware/schematic/schematic.kicad_sch。" },
        apply: { type: "boolean", description: "true 才真的写进板子（默认 false，只出计划）。" },
      },
      required: [],
    },
    output: {
      schema: syncOutput,
      render: (_args, value) => {
        const report = value as {
          ok: boolean;
          error: string;
          applied: boolean;
          added: number;
          parts: { ref: string; footprint: string; x: number; y: number; nets: number }[];
          alreadyOnBoard: number;
          noFootprint: string[];
          missingLib: string[];
          skipped: string[];
          unassigned: number;
          notes: string[];
        };
        if (!report.ok) return [{ type: "text", text: "补封装没跑起来：" + report.error }];
        const lines: string[] = [];
        lines.push(report.applied ? "已补进板子：" + String(report.added) + " 个" : "计划（未写盘）：" + String(report.parts.length) + " 个");
        for (const part of report.parts.slice(0, 12)) {
          lines.push("  " + part.ref + " · " + part.footprint + " @ " + String(part.x) + "," + String(part.y) + " · " + String(part.nets) + " 个网络");
        }
        if (report.parts.length > 12) lines.push("  另有 " + String(report.parts.length - 12) + " 个");
        lines.push("已在板上：" + String(report.alreadyOnBoard));
        if (report.missingLib.length > 0) lines.push("库里找不到封装：" + report.missingLib.join("、"));
        if (report.skipped.length > 0) lines.push("跳过（已存在）：" + report.skipped.join("、"));
        if (report.unassigned > 0) lines.push("有 " + String(report.unassigned) + " 个引脚的网络在板上不存在，没赋上");
        for (const note of report.notes) lines.push(note);
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const shaped = args as { projectDir?: string; boardFile?: string; schematicFile?: string; apply?: boolean };
      const project = await resolveProjectDir(ctx, shaped.projectDir, exec);
      const located = locateEcadToolchain();
      const toolchain = located.toolchain;
      const footprintDirs = located.ok && toolchain !== null ? [toolchain.footprintDir] : [];
      const plan = planHandSync(project.projectDir, {
        boardFile: shaped.boardFile,
        schematicFile: shaped.schematicFile,
        footprintDirs,
      });
      const empty = {
        ok: false,
        error: "",
        schematicFile: plan.schematicFile,
        boardFile: plan.boardFile,
        applied: false,
        added: 0,
        skipped: [] as string[],
        missingLib: [] as string[],
        unassigned: 0,
        parts: [] as { ref: string; value: string; footprint: string; x: number; y: number; nets: number }[],
        alreadyOnBoard: plan.alreadyOnBoard.length,
        noFootprint: [...plan.noFootprint],
        notes: [...plan.notes],
      };
      if (!plan.ok) return { ...empty, error: plan.error };
      const shapedParts = plan.parts.map((part) => ({
        ref: part.ref,
        value: part.value,
        footprint: part.footprint,
        x: part.x,
        y: part.y,
        nets: part.nets.length,
      }));
      if (shaped.apply !== true) {
        return { ...empty, ok: true, parts: shapedParts, notes: [...plan.notes, "这是计划：加 apply=true 才写进板子"] };
      }
      if (!located.ok || toolchain === null) return { ...empty, ok: false, error: "没有找到 KiCad 工具链：补封装要用 KiCad 自带的 python", parts: shapedParts };
      if (plan.parts.length === 0) return { ...empty, ok: true, applied: false, parts: shapedParts };

      backupBoardFile(plan.boardFile);
      const stamp = String(Date.now());
      const scriptFile = join(tmpdir(), "dsh-stm32-handsync-" + stamp + ".py");
      const resultFile = join(tmpdir(), "dsh-stm32-handsync-" + stamp + ".json");
      writeFileSync(scriptFile, buildHandSyncScript(plan), "utf8");
      const payload = JSON.stringify({
        boardFile: plan.boardFile,
        libraryDirs: [...plan.libraryDirs],
        parts: plan.parts.map((part) => ({
          ref: part.ref,
          value: part.value,
          library: part.library,
          footprintName: part.footprintName,
          x: part.x,
          y: part.y,
          nets: part.nets.map((net) => ({ number: net.number, net: net.net })),
        })),
      });
      const run = await runCapture(ctx.subprocess, {
        argv: [toolchain.python, scriptFile, payload, resultFile],
        cwd: dirname(plan.boardFile),
        env: toolchain.env,
        timeoutMs: 120_000,
        maxBytes: 256_000,
        signal: exec.signal,
      });
      if (run.exitCode !== 0) {
        return {
          ...empty,
          ok: false,
          error: "KiCad python 执行失败：" + (run.stderr === "" ? run.stdout : run.stderr).slice(-400),
          parts: shapedParts,
        };
      }
      const parsed = existsSync(resultFile) ? parseHandSyncOutput(readFileSync(resultFile, "utf8")) : null;
      if (parsed === null || !parsed.ok) {
        return { ...empty, ok: false, error: "没读到补封装结果：脚本没有写出结果文件（板子可能被锁定或路径不可写）", parts: shapedParts };
      }
      const notes = [...plan.notes];
      if (parsed.unassigned > 0) notes.push("有 " + String(parsed.unassigned) + " 个引脚的网络在板上不存在，没赋上");
      return {
        ok: true,
        error: "",
        schematicFile: plan.schematicFile,
        boardFile: plan.boardFile,
        applied: true,
        added: parsed.added,
        skipped: parsed.skipped,
        missingLib: parsed.missingLib,
        unassigned: parsed.unassigned,
        parts: shapedParts,
        alreadyOnBoard: plan.alreadyOnBoard.length,
        noFootprint: [...plan.noFootprint],
        notes,
      };
    },
  });
}
