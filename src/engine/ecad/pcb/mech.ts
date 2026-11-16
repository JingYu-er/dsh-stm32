/**
 * 外壳与机械约束（S162）。
 *
 * 外壳设计师要的东西只有三样：**外形、孔位、最高的地方**。前两样能从 `.kicad_pcb` 直接读，
 * 第三样需要元件高度——板子里没有，所以不做。这里出的是「MCAD 能直接吃」的轮廓与孔位，
 * 外加几条能证实的检查：孔离边太近、板子没有定位孔、外形不是闭合矩形。
 *
 * DXF 只写 R12 的 ENTITIES（LINE / CIRCLE）——这是所有机械软件都认的最小集合。
 */

import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

import { blocksOnLayer, readBoardFacts } from "../dfm.js";
import { parenBlocks } from "./emc.js";

export interface MechHole {
  readonly ref: string;
  /** 相对板框左下角（导出 DXF 时用这个坐标系）。 */
  readonly x: number;
  readonly y: number;
  readonly drillMm: number;
  /** 非金属化孔按定位孔算；元件脚的金属化孔只计数，不进机械图。 */
  readonly plated: boolean;
}

export interface MechFinding {
  readonly id: string;
  readonly severity: "info" | "warning";
  readonly message: string;
  readonly fix: string;
}

export interface MechPoint {
  readonly x: number;
  readonly y: number;
}

export interface MechReport {
  readonly ok: boolean;
  readonly error: string;
  readonly boardFile: string;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly thicknessMm: number;
  readonly areaCm2: number;
  readonly outlinePoints: number;
  readonly holes: readonly MechHole[];
  readonly mountingHoles: number;
  readonly minHoleEdgeMm: number;
  readonly findings: readonly MechFinding[];
  readonly notes: readonly string[];
}

const BOARD_THICKNESS_MM = 1.6;

function num(value: string | undefined): number {
  const parsed = Number(value ?? "0");
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 读板框与孔位；只认 Edge.Cuts 的线段/圆弧端点与 `np_thru_hole`/`thru_hole` 的钻孔。 */
export function parseMech(pcbText: string, boardFile: string): MechReport {
  const facts = readBoardFacts(pcbText);
  const outlineBlocks = blocksOnLayer(pcbText, "Edge.Cuts");
  const outlinePoints = outlineBlocks.length;
  // 板框左下角：KiCad 坐标是绝对毫米，机械图要从 0,0 起，所以孔位统一减去它。
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const block of outlineBlocks) {
    for (const match of block.matchAll(/\((?:start|end|center|xy)\s+(-?[\d.]+)\s+(-?[\d.]+)\)/gu)) {
      const x = num(match[1]);
      const y = num(match[2]);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
    }
  }
  const originX = Number.isFinite(minX) ? minX : 0;
  const originY = Number.isFinite(minY) ? minY : 0;
  const holes: MechHole[] = [];
  const notes: string[] = [];
  const findings: MechFinding[] = [];

  if (facts.widthMm <= 0 || facts.heightMm <= 0) {
    return {
      ok: false,
      error: "没在 Edge.Cuts 上读到板框：机械图需要闭合外形，先在 KiCad 里补板框",
      boardFile,
      widthMm: 0,
      heightMm: 0,
      thicknessMm: BOARD_THICKNESS_MM,
      areaCm2: 0,
      outlinePoints,
      holes: [],
      mountingHoles: 0,
      minHoleEdgeMm: 0,
      findings: [],
      notes: ["板框缺失，孔位与边距都不判"],
    };
  }

  // 孔：封装块里 `(pad "" np_thru_hole … (drill d))`。封装原点的 `(at x y r)` 要参与旋转，
  // 与板图解析同一套变换（KiCad y 向下、正角度屏幕逆时针）。
  const footprintBlocks = parenBlocks(pcbText, "footprint");
  for (const block of footprintBlocks) {
    const refMatch = block.match(/\(property\s+"Reference"\s+"([^"]*)"/u) ?? block.match(/\(fp_text\s+reference\s+"([^"]*)"/u);
    const ref = refMatch?.[1] ?? "";
    const atMatch = block.match(/\(at\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s+(-?[\d.]+))?\)/u);
    const footprintX = num(atMatch?.[1]);
    const footprintY = num(atMatch?.[2]);
    const originRot = num(atMatch?.[3]);
    const rad = (originRot * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const padBlocks = parenBlocks(block, "pad");
    for (const pad of padBlocks) {
      const holeKind = pad.match(/\(pad\s+"[^"]*"\s+(np_thru_hole|thru_hole)\b/u);
      if (holeKind === null) continue;
      const drill = pad.match(/\(drill\s+([\d.]+)\)/u) ?? pad.match(/\(drill\s+oval\s+([\d.]+)\s+([\d.]+)\)/u);
      if (drill === null) continue;
      const drillMm = num(drill[1]);
      if (drillMm <= 0) continue;
      const padAt = pad.match(/\(at\s+(-?[\d.]+)\s+(-?[\d.]+)/u);
      const dx = num(padAt?.[1]);
      const dy = num(padAt?.[2]);
      holes.push({
        ref,
        x: round2(footprintX + dx * cos + dy * sin - originX),
        y: round2(footprintY - dx * sin + dy * cos - originY),
        drillMm: round2(drillMm),
        plated: holeKind[1] === "thru_hole",
      });
    }
  }

  if (holes.length === 0) {
    findings.push({
      id: "mech.no-holes",
      severity: "info",
      message: "板上没有通孔：如果要做外壳，至少需要两个定位孔（或螺丝孔）",
      fix: "在电路里加 mounting hole（tscircuit 用 hole，或在 KiCad 里放 MountingHole 封装）",
    });
  }

  // 孔到最近板边的距离：只看矩形包络（异形板另算）。
  let minHoleEdgeMm = Number.POSITIVE_INFINITY;
  for (const hole of holes) {
    const distances = [hole.x, facts.widthMm - hole.x, hole.y, facts.heightMm - hole.y];
    for (const distance of distances) {
      if (distance < minHoleEdgeMm) minHoleEdgeMm = distance;
    }
  }
  if (holes.length > 0) {
    minHoleEdgeMm = round2(minHoleEdgeMm);
    if (minHoleEdgeMm < 1.2) {
      findings.push({
        id: "mech.hole-too-close",
        severity: "warning",
        message: `有孔离板边只有 ${String(minHoleEdgeMm)} mm：钻孔与铣刀会把板边崩掉`,
        fix: "孔中心离板边至少 1.2 mm（M2 沉头建议 2.5 mm）",
      });
    }
  } else {
    minHoleEdgeMm = 0;
  }

  if (outlinePoints < 3) {
    notes.push("板框图元少于 3 段，外形可能不是闭合回路；DXF 仍按包络矩形导出");
  }
  const rectArea = facts.widthMm * facts.heightMm;
  notes.push("板厚按 1.6 mm 标（KiCad 里板厚在 `setup` 段，这里不解析）");

  return {
    ok: true,
    error: "",
    boardFile,
    widthMm: round2(facts.widthMm),
    heightMm: round2(facts.heightMm),
    thicknessMm: BOARD_THICKNESS_MM,
    areaCm2: round2(rectArea / 100),
    outlinePoints,
    holes,
    mountingHoles: holes.filter((hole) => !hole.plated).length,
    minHoleEdgeMm,
    findings,
    notes,
  };
}

export function readMech(boardFile: string, readText: (file: string) => string): MechReport {
  try {
    return parseMech(readText(boardFile), boardFile);
  } catch (error) {
    return {
      ok: false,
      error: "读不到板子文件：" + (error instanceof Error ? error.message : String(error)),
      boardFile,
      widthMm: 0,
      heightMm: 0,
      thicknessMm: 0,
      areaCm2: 0,
      outlinePoints: 0,
      holes: [],
      mountingHoles: 0,
      minHoleEdgeMm: 0,
      findings: [],
      notes: [],
    };
  }
}

/** DXF R12：板框矩形 + 每个孔一个 CIRCLE。坐标直接用 KiCad 的毫米值。 */
export function renderMechDxf(report: MechReport): string {
  const lines: string[] = [
    "0", "SECTION",
    "2", "ENTITIES",
  ];
  const rect: MechPoint[] = [
    { x: 0, y: 0 },
    { x: report.widthMm, y: 0 },
    { x: report.widthMm, y: report.heightMm },
    { x: 0, y: report.heightMm },
  ];
  for (let i = 0; i < rect.length; i += 1) {
    const from = rect[i] as MechPoint;
    const to = rect[(i + 1) % rect.length] as MechPoint;
    lines.push(
      "0", "LINE",
      "8", "BOARD_OUTLINE",
      "10", String(from.x), "20", String(from.y), "30", "0",
      "11", String(to.x), "21", String(to.y), "31", "0",
    );
  }
  for (const hole of report.holes.filter((item) => !item.plated)) {
    lines.push(
      "0", "CIRCLE",
      "8", "HOLES_MOUNT",
      "10", String(hole.x), "20", String(hole.y), "30", "0",
      "40", String(hole.drillMm / 2),
    );
  }
  lines.push("0", "ENDSEC", "0", "EOF", "");
  return lines.join("\n");
}

export function writeMechDxf(file: string, report: MechReport): number {
  const text = renderMechDxf(report);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
  return text.length;
}
