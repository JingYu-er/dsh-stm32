/**
 * PCB 放置工具（S139）：把算好的落位写进 .kicad_pcb。
 *
 * 只做一件事：读 circuit.json 算落位 → 调 KiCad 自带 python 搬元件存盘。
 * 布线、铺铜、检查都在后面的工具里，这里不越界。
 */
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import type { DshContext, JsonSchema, ToolDefinition, ToolExec } from "../types.js";
import { runCapture } from "../engine/subprocess-runner.js";
import { locateEcadToolchain } from "../engine/ecad/toolchain.js";
import { planEcadWorkspace } from "../engine/ecad/tsci.js";
import { readCircuitNetlist } from "../engine/ecad/pcb/netlist.js";
import { planPlacement } from "../engine/ecad/pcb/placement.js";
import { buildApplyScript, parseApplyOutput } from "../engine/ecad/pcb/apply.js";
import { appendGroundZone, buildRouteScript, DEFAULT_POWER_NETS, parseRouteOutput } from "../engine/ecad/pcb/route.js";
import { readBoardFacts } from "../engine/ecad/dfm.js";
import { resolveProjectDir } from "./project-dir.js";

export const PCB_PLACE_TOOL = "stm32_pcb_place";
export const PCB_ROUTE_TOOL = "stm32_pcb_route";

const output: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    error: { type: "string" },
    boardFile: { type: "string" },
    moved: { type: "number" },
    missing: { type: "array", items: { type: "string" } },
    removedTracks: { type: "number" },
    parts: { type: "number" },
    boardWidth: { type: "number" },
    boardHeight: { type: "number" },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["ok", "error", "boardFile", "moved", "missing", "removedTracks", "parts", "boardWidth", "boardHeight", "notes"],
};

function newestFile(dir: string, pattern: RegExp, depth = 3): string {
  if (!existsSync(dir)) return "";
  let best = "";
  let bestTime = -1;
  const walk = (current: string, level: number): void => {
    if (level > depth) return;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(current, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (name === "node_modules" || name === ".history") continue;
        walk(full, level + 1);
        continue;
      }
      if (!pattern.test(name)) continue;
      if (stat.mtimeMs > bestTime) {
        bestTime = stat.mtimeMs;
        best = full;
      }
    }
  };
  walk(dir, 0);
  return best;
}

export function registerPcbTools(ctx: DshContext): void {
  const tool: ToolDefinition = {
    name: PCB_PLACE_TOOL,
    description:
      "按 circuit.json 的网表与元件尺寸计算落位，再调 KiCad 自带 python 把元件搬进 .kicad_pcb；默认清掉旧走线（重新放置后它们已失效）。只放置，不布线、不铺铜。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectDir: { type: "string", description: "工程根目录；缺省为会话工作目录。" },
        boardFile: { type: "string", description: "指定要改的 .kicad_pcb；缺省取 hardware/kicad 下最新的一份。" },
        keepTracks: { type: "boolean", description: "保留既有走线（默认 false：重新放置会清掉）。" },
      },
      required: [],
    },
    output: {
      schema: output,
      render: (_args, value) => {
        const result = value as { ok: boolean; error: string; boardFile: string; moved: number; missing: string[]; removedTracks: number; parts: number; boardWidth: number; boardHeight: number; notes: string[] };
        if (!result.ok) return [{ type: "text", text: "放置未执行：" + result.error }];
        const lines = [
          "放置完成：搬了 " + String(result.moved) + " / " + String(result.parts) + " 个元件，板框 " + String(result.boardWidth) + "×" + String(result.boardHeight) + " mm",
          "板文件：" + result.boardFile,
          "清掉的旧走线：" + String(result.removedTracks) + " 条",
        ];
        if (result.missing.length > 0) lines.push("板上找不到的位号：" + result.missing.join("、"));
        for (const note of result.notes) lines.push("说明：" + note);
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    execute: async (args: { projectDir?: string; boardFile?: string; keepTracks?: boolean }, exec: ToolExec) => {
      const empty = { ok: false, error: "", boardFile: "", moved: 0, missing: [] as string[], removedTracks: 0, parts: 0, boardWidth: 0, boardHeight: 0, notes: [] as string[] };
      const resolved = await resolveProjectDir(ctx, args.projectDir, exec);
      if (resolved.projectDir === "") return { ...empty, error: "projectDir 不能为空：从工具栏「工程」下拉里选一个，或先打开调试会话" };
      const located = locateEcadToolchain();
      if (located.toolchain === null) return { ...empty, error: located.error };
      const workspace = planEcadWorkspace(resolved.projectDir, join(resolved.projectDir, "hardware"));

      const circuitFile = newestFile(workspace.circuitDir, /^circuit\.json$/u);
      if (circuitFile === "") return { ...empty, error: "还没有 circuit.json：先跑一次 stm32_ecad_build" };
      const model = readCircuitNetlist(readFileSync(circuitFile, "utf8"));
      if (!model.ok) return { ...empty, error: model.error };

      const boardFile = args.boardFile !== undefined && args.boardFile !== "" ? args.boardFile : newestFile(workspace.kicadDir, /\.kicad_pcb$/u);
      if (boardFile === "" || !existsSync(boardFile)) return { ...empty, error: "还没有 .kicad_pcb：先跑一次构建，或传 boardFile 指定板子" };

      const plan = planPlacement(model);
      if (!plan.ok) return { ...empty, error: plan.error };

      copyFileSync(boardFile, boardFile + ".bak");
      const script = buildApplyScript({ plan, boardFile, keepTracks: args.keepTracks === true });
      const scriptFile = join(tmpdir(), "dsh-stm32-place-" + String(Date.now()) + ".py");
      writeFileSync(scriptFile, script, "utf8");
      const payload = JSON.stringify({ boardFile, keepTracks: args.keepTracks === true, items: plan.items, board: plan.board });
      const resultFile = join(tmpdir(), "dsh-stm32-place-" + String(Date.now()) + ".json");
      const run = await runCapture(ctx.subprocess, {
        argv: [located.toolchain.python, scriptFile, payload, resultFile],
        cwd: dirname(boardFile),
        env: located.toolchain.env,
        timeoutMs: 90_000,
        maxBytes: 256_000,
        signal: exec.signal,
      });
      if (run.exitCode !== 0) {
        return { ...empty, boardFile, error: "KiCad python 执行失败：" + (run.stderr === "" ? run.stdout : run.stderr).slice(-400) };
      }
      const parsedText = existsSync(resultFile) ? readFileSync(resultFile, "utf8") : "";
      const parsed = parseApplyOutput(parsedText);
      if (!parsed.ok) return { ...empty, boardFile, error: "没读到放置结果：脚本没有写出结果文件（板子可能已被锁定或路径不可写）" };

      const notes = [...model.notes, ...plan.notes];
      if (parsed.missing.length > 0) notes.push("板上没有这些位号：多半是构建产物与 circuit.json 不同步，重跑构建后再放置");
      return {
        ok: true,
        error: "",
        boardFile,
        moved: parsed.moved,
        missing: parsed.missing,
        removedTracks: parsed.removedTracks,
        parts: plan.items.length,
        boardWidth: plan.board.width,
        boardHeight: plan.board.height,
        notes,
      };
    },
  };
  ctx.tools.register(tool);

  const routeTool: ToolDefinition = {
    name: PCB_ROUTE_TOOL,
    description:
      "在已放置的板上布电源与地：按网络把焊盘用最近邻链连起来（F.Cu，0.5 mm），并尝试补一块 GND 铺铜区后填充；不处理信号线。默认保留既有走线。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectDir: { type: "string", description: "工程根目录；缺省为会话工作目录。" },
        boardFile: { type: "string", description: "显式指定 .kicad_pcb；缺省取最近一次构建产物。" },
        keepTracks: { type: "boolean", description: "保留板上的既有走线；默认清掉（重新布线前它们多半已失效）。" },
        nets: { type: "array", items: { type: "string" }, description: "要布的网络名；缺省用 GND/VCC/3V3/5V/VBUS 这些常见电源网。" },
        apply: { type: "boolean", description: "真的写进板子；默认只预览（先算段数与走向，不改文件）。" },
      },
      required: [],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          error: { type: "string" },
          boardFile: { type: "string" },
          tracks: { type: "number" },
          vias: { type: "number" },
          nets: { type: "array", items: { type: "object", additionalProperties: false, properties: { net: { type: "string" }, pads: { type: "number" }, segments: { type: "number" } }, required: ["net", "pads", "segments"] } },
          plane: { type: "string" },
          notes: { type: "array", items: { type: "string" } },
        },
        required: ["ok", "error", "boardFile", "tracks", "vias", "nets", "plane", "notes"],
      },
      render: (_args, value) => {
        const result = value as { ok: boolean; error: string; tracks: number; vias: number; nets: { net: string; segments: number }[]; plane: string; notes: string[] };
        if (!result.ok) return [{ type: "text", text: "布线未执行：" + result.error }];
        const lines = ["已布 " + String(result.tracks) + " 段电源与地，过孔 " + String(result.vias) + " 个"];
        for (const item of result.nets) lines.push("- " + item.net + "：" + String(item.segments) + " 段");
        lines.push(result.plane === "" ? "铺铜：未写入（见提示）" : "铺铜：" + result.plane);
        for (const note of result.notes) lines.push("· " + note);
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    timeoutMs: 180_000,
    isConcurrencySafe: () => false,
    execute: async (args: { projectDir?: string; boardFile?: string; keepTracks?: boolean; nets?: string[]; apply?: boolean }, exec: ToolExec) => {
      const empty = { ok: false, error: "", boardFile: "", tracks: 0, vias: 0, nets: [] as { net: string; pads: number; segments: number }[], plane: "", notes: [] as string[] };
      const resolved = await resolveProjectDir(ctx, args.projectDir, exec);
      if (resolved.projectDir === "") return { ...empty, error: "projectDir 不能为空：从工具栏「工程」下拉里选一个，或先打开调试会话" };
      const located = locateEcadToolchain();
      if (located.toolchain === null) return { ...empty, error: located.error };
      const workspace = planEcadWorkspace(resolved.projectDir, join(resolved.projectDir, "hardware"));
      const boardFile = args.boardFile !== undefined && args.boardFile !== ""
        ? args.boardFile
        : newestFile(workspace.kicadDir, /\.kicad_pcb$/u);
      if (boardFile === "" || !existsSync(boardFile)) return { ...empty, error: "还没有可用的 .kicad_pcb：先跑 stm32_ecad_build 或 stm32_pcb_place" };

      const notes: string[] = [];
      const nets = args.nets ?? [...DEFAULT_POWER_NETS];
      copyFileSync(boardFile, boardFile + ".bak");
      const facts = readBoardFacts(readFileSync(boardFile, "utf8"));
      const zone = appendGroundZone(readFileSync(boardFile, "utf8"), { x0: 0, y0: 0, x1: facts.widthMm, y1: facts.heightMm });
      if (zone.ok) writeFileSync(boardFile, zone.text);
      else notes.push(zone.error);

      const payload = JSON.stringify({ boardFile, powerNets: nets, powerWidthMm: 0.5, planeNet: zone.ok ? "GND" : "", planeLayer: "B.Cu", planeClearanceMm: 0.5, keepTracks: args.keepTracks === true, dryRun: args.apply !== true });
      const scriptFile = join(tmpdir(), "dsh-stm32-route-" + String(Date.now()) + ".py");
      writeFileSync(scriptFile, buildRouteScript({ boardFile, powerNets: nets, powerWidthMm: 0.5, planeNet: zone.ok ? "GND" : "", planeLayer: "B.Cu", planeClearanceMm: 0.5, keepTracks: args.keepTracks === true, dryRun: args.apply !== true }), "utf8");
      const resultFile = join(tmpdir(), "dsh-stm32-route-" + String(Date.now()) + ".json");
      const run = await runCapture(ctx.subprocess, {
        argv: [located.toolchain.python, scriptFile, payload, resultFile],
        cwd: resolved.projectDir,
        timeoutMs: 120_000,
        maxBytes: 1 << 20,
        signal: exec.signal,
      });
      if (run.exitCode !== 0) {
        return { ...empty, boardFile, error: "KiCad python 执行失败：" + (run.stderr === "" ? run.stdout : run.stderr).slice(-400) };
      }
      const parsed = parseRouteOutput(existsSync(resultFile) ? readFileSync(resultFile, "utf8") : "");
      if (!parsed.ok) return { ...empty, boardFile, error: parsed.error };
      return {
        ok: true,
        error: "",
        boardFile,
        tracks: parsed.tracks,
        vias: parsed.vias,
        nets: parsed.nets,
        plane: parsed.plane === null ? "" : parsed.plane.net + "@" + parsed.plane.layer,
        notes: [...notes, ...parsed.notes],
      };
    },
  };
  ctx.tools.register(routeTool);
}

