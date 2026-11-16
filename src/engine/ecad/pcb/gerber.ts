/**
 * Gerber / Excellon 预览（S166）：把导出的制造文件读回来画成一张图。
 *
 * 目的不是做 CAM 校验，而是交付前「看一眼」：板框对不对、铜有没有铺满、
 * 丝印有没有压到焊盘、钻孔是不是都在板上。所以这里只实现 KiCad 实际会写的那部分：
 * RS-274X 的 D01/D02/D03、圆/矩形/椭圆光圈、G36/G37 区域、圆弧（折线近似），
 * Excellon 的 T 刀具与 XY 孔位。
 *
 * 读不懂的构造（多边形光圈、LPC 挖空、宏光圈）不猜，计入 notes 明说「没有画」。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type GerberKind = "copper" | "silk" | "mask" | "paste" | "edge" | "other";

export interface GerberLayerView {
  readonly name: string;
  readonly file: string;
  readonly kind: GerberKind;
  readonly segments: number;
  readonly flashes: number;
  readonly regions: number;
  readonly skipped: number;
}

export interface GerberView {
  readonly ok: boolean;
  readonly error: string;
  readonly dir: string;
  readonly layers: GerberLayerView[];
  readonly svg: string;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly drillHoles: number;
  readonly notes: string[];
}

export interface GerberOptions {
  /** 只画这些层（按层名，含 F_Cu / Edge_Cuts 这类后缀匹配）；不给就画全部。 */
  readonly layers?: readonly string[];
  /** 最长边像素，默认 760。 */
  readonly maxPx?: number;
}

const EMPTY: GerberView = {
  ok: false,
  error: "",
  dir: "",
  layers: [],
  svg: "",
  widthMm: 0,
  heightMm: 0,
  drillHoles: 0,
  notes: [],
};

/** 一层的绘制结果：全部折算成毫米世界坐标里的图元。 */
interface LayerDraw {
  readonly name: string;
  readonly kind: GerberKind;
  readonly file: string;
  readonly lines: { x1: number; y1: number; x2: number; y2: number; width: number }[];
  readonly rects: { x: number; y: number; w: number; h: number; rotation: number }[];
  readonly circles: { x: number; y: number; r: number }[];
  readonly polygons: { points: { x: number; y: number }[] }[];
  segments: number;
  flashes: number;
  regions: number;
  skipped: number;
}

type Aperture = { shape: "circle"; size: number } | { shape: "rect"; w: number; h: number } | { shape: "obround"; w: number; h: number } | { shape: "other" };

interface ParsedLayer {
  readonly draw: LayerDraw;
  readonly holes: { x: number; y: number; d: number }[];
  readonly notes: string[];
}

/** 读一个 Gerber 输出目录（`hardware/out/gerbers`）里的所有层与钻孔，画成一张 SVG。 */
export function readGerberSet(dir: string, options: GerberOptions = {}): GerberView {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch (error) {
    return { ...EMPTY, dir, error: "读不到 Gerber 目录：" + (error instanceof Error ? error.message : String(error)) };
  }
  const wanted = options.layers ?? [];
  const files = names
    .filter((name) => /\.(gbr|gtl|gbl|gts|gbs|gto|gbo|gtp|gbp|gm1|g1|g2|g3|g4|gba|gta|drl)$/iu.test(name))
    // 钻孔不属于任何一层：选层不影响孔位，交付前总要看到。
    .filter((name) => /.drl$/iu.test(name) || wanted.length === 0 || wanted.some((layer) => name.toLowerCase().includes(layer.toLowerCase())))
    .sort();
  if (files.length === 0) return { ...EMPTY, dir, error: "这个目录里没有 Gerber 文件：先跑一次 stm32_ecad_export" };

  const layers: LayerDraw[] = [];
  const holes: { x: number; y: number; d: number }[] = [];
  const notes: string[] = [];
  let drillHoles = 0;
  for (const file of files) {
    const full = join(dir, file);
    let text = "";
    try {
      text = readFileSync(full, "utf8");
    } catch {
      notes.push(file + "：读不出来，跳过");
      continue;
    }
    if (/\.drl$/iu.test(file)) {
      const drill = parseExcellon(text);
      holes.push(...drill.holes);
      drillHoles += drill.holes.length;
      for (const note of drill.notes) notes.push(file + "：" + note);
      continue;
    }
    const parsed = parseGerber(text, file);
    layers.push(parsed.draw);
    for (const note of parsed.notes) notes.push(file + "：" + note);
  }
  if (layers.length === 0) return { ...EMPTY, dir, error: "只找到钻孔文件：铜层与板框一个都没读到" };
  return render(wanted.length === 0 ? layers : layers, holes, options, dir, drillHoles, notes);
}

function render(
  layers: readonly LayerDraw[],
  holes: readonly { x: number; y: number; d: number }[],
  options: GerberOptions,
  dir: string,
  drillHoles: number,
  notes: string[],
): GerberView {
  const maxPx = options.maxPx ?? 760;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const grow = (x: number, y: number, pad: number): void => {
    minX = Math.min(minX, x - pad);
    minY = Math.min(minY, y - pad);
    maxX = Math.max(maxX, x + pad);
    maxY = Math.max(maxY, y + pad);
  };
  for (const layer of layers) {
    for (const line of layer.lines) {
      grow(line.x1, line.y1, line.width / 2);
      grow(line.x2, line.y2, line.width / 2);
    }
    for (const rect of layer.rects) {
      grow(rect.x - rect.w / 2, rect.y - rect.h / 2, 0.2);
      grow(rect.x + rect.w / 2, rect.y + rect.h / 2, 0.2);
    }
    for (const circle of layer.circles) grow(circle.x, circle.y, circle.r);
    for (const polygon of layer.polygons) for (const point of polygon.points) grow(point.x, point.y, 0);
  }
  for (const hole of holes) grow(hole.x, hole.y, hole.d / 2);
  if (minX === Number.POSITIVE_INFINITY) return { ...EMPTY, dir, error: "这些 Gerber 里没有任何可画的图元" };
  const marginMm = 1.2;
  minX -= marginMm;
  minY -= marginMm;
  maxX += marginMm;
  maxY += marginMm;
  const widthMm = maxX - minX;
  const heightMm = maxY - minY;
  const scale = Math.min(maxPx / widthMm, maxPx / heightMm, 10);
  const px = (value: number): number => Math.round(value * scale * 100) / 100;
  // Gerber 的 y 轴向上，SVG 向下：用变换把整层翻过来，坐标仍按毫米写。
  const parts: string[] = [];
  parts.push(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + String(px(widthMm)) + " " + String(px(heightMm)) +
      '" width="' + String(px(widthMm)) + '" height="' + String(px(heightMm)) +
      '" style="background:var(--dsw-alias-bg-base,#111);display:block;max-width:100%;height:auto">',
  );
  parts.push('<g transform="translate(' + String(px(-minX)) + " " + String(px(maxY)) + ") scale(" + String(scale) + " -" + String(scale) + ')">');
  const colorOf = (kind: GerberKind): { stroke: string; fill: string; width: number } => {
    switch (kind) {
      case "copper":
        return { stroke: "var(--dsw-alias-state-business-primary,#4c8bf5)", fill: "var(--dsw-alias-state-business-primary,#4c8bf5)", width: 0.08 };
      case "silk":
        return { stroke: "var(--dsw-alias-label-tertiary,#9aa4b2)", fill: "var(--dsw-alias-label-tertiary,#9aa4b2)", width: 0.12 };
      case "mask":
        return { stroke: "var(--dsw-alias-state-warn-primary,#e8b339)", fill: "none", width: 0.08 };
      case "paste":
        return { stroke: "var(--dsw-alias-state-success-primary,#3fb950)", fill: "none", width: 0.08 };
      case "edge":
        return { stroke: "var(--dsw-alias-label-secondary,#c9d1d9)", fill: "none", width: 0.15 };
      default:
        return { stroke: "var(--dsw-alias-label-dimmed,#6b7280)", fill: "none", width: 0.08 };
    }
  };
  // 先画铜与丝印，板框最后画，才压得住线宽。
  const ordered = [...layers].sort((a, b) => rank(a.kind) - rank(b.kind));
  for (const layer of ordered) {
    const style = colorOf(layer.kind);
    parts.push('<g data-layer="' + escapeText(layer.name) + '">');
    for (const polygon of layer.polygons) {
      const d = polygon.points.map((point, index) => (index === 0 ? "M" : "L") + String(point.x.toFixed(3)) + " " + String(point.y.toFixed(3))).join(" ") + " Z";
      parts.push('<path d="' + d + '" fill="' + style.fill + '" fill-opacity="0.55" stroke="none"/>');
    }
    for (const line of layer.lines) {
      parts.push(
        '<line x1="' + line.x1.toFixed(3) + '" y1="' + line.y1.toFixed(3) + '" x2="' + line.x2.toFixed(3) + '" y2="' + line.y2.toFixed(3) +
          '" stroke="' + style.stroke + '" stroke-width="' + Math.max(0.02, line.width).toFixed(3) + '" stroke-linecap="round" opacity="0.9"/>',
      );
    }
    for (const rect of layer.rects) {
      parts.push(
        '<rect x="' + (rect.x - rect.w / 2).toFixed(3) + '" y="' + (rect.y - rect.h / 2).toFixed(3) + '" width="' + rect.w.toFixed(3) + '" height="' + rect.h.toFixed(3) +
          '" fill="' + style.fill + '" fill-opacity="0.85"' + (rect.rotation === 0 ? "" : ' transform="rotate(' + String(rect.rotation) + " " + rect.x.toFixed(3) + " " + rect.y.toFixed(3) + ')"') + "/>",
      );
    }
    for (const circle of layer.circles) {
      parts.push('<circle cx="' + circle.x.toFixed(3) + '" cy="' + circle.y.toFixed(3) + '" r="' + circle.r.toFixed(3) + '" fill="' + style.fill + '" fill-opacity="0.9"/>');
    }
    parts.push("</g>");
  }
  if (holes.length > 0) {
    parts.push('<g data-layer="DRILL">');
    for (const hole of holes) {
      parts.push(
        '<circle cx="' + hole.x.toFixed(3) + '" cy="' + hole.y.toFixed(3) + '" r="' + (hole.d / 2).toFixed(3) +
          '" fill="var(--dsw-alias-bg-base,#111)" stroke="var(--dsw-alias-label-dimmed,#6b7280)" stroke-width="0.05"/>',
      );
    }
    parts.push("</g>");
  }
  parts.push("</g></svg>");
  return {
    ok: true,
    error: "",
    dir,
    layers: layers.map((layer) => ({
      name: layer.name,
      file: layer.file,
      kind: layer.kind,
      segments: layer.segments,
      flashes: layer.flashes,
      regions: layer.regions,
      skipped: layer.skipped,
    })),
    svg: parts.join(""),
    widthMm: Math.round(widthMm * 100) / 100,
    heightMm: Math.round(heightMm * 100) / 100,
    drillHoles,
    notes,
  };
}

function rank(kind: GerberKind): number {
  if (kind === "copper") return 0;
  if (kind === "paste") return 1;
  if (kind === "mask") return 2;
  if (kind === "silk") return 3;
  if (kind === "edge") return 4;
  return 5;
}

function kindOf(file: string): GerberKind {
  const name = file.toLowerCase();
  if ((name.includes("courtyard") || name.includes("fab") || name.includes("adhesive"))) return "other";
  if (/edge|\.gm1$/u.test(name)) return "edge";
  if (/silk|\.(gto|gbo)$/u.test(name)) return "silk";
  if (/mask|\.(gts|gbs)$/u.test(name)) return "mask";
  if (/paste|\.(gtp|gbp)$/u.test(name)) return "paste";
  if (/\.(gtl|gbl|g\d+)$/u.test(name)) return "copper";
  return "other";
}

/** `tetris-F_Cu.gtl` → `F_Cu`：去工程前缀与扩展名，只留层名。 */
function layerName(file: string): string {
  const base = file.replace(/\.[a-z0-9]+$/iu, "");
  const dashed = base.indexOf("-");
  return dashed >= 0 ? base.slice(dashed + 1) : base;
}

function parseGerber(text: string, file: string): ParsedLayer {
  const draw: LayerDraw = {
    name: layerName(file),
    kind: kindOf(file),
    file,
    lines: [],
    rects: [],
    circles: [],
    polygons: [],
    segments: 0,
    flashes: 0,
    regions: 0,
    skipped: 0,
  };
  const notes: string[] = [];
  const apertures = new Map<string, Aperture>();
  let scale = 1e-6; // FSLAX46 → 6 位小数；MO 再决定单位
  let unitScale = 1; // mm = 1，inch = 25.4
  let current: Aperture | null = null;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let interpolation = "linear";
  let inRegion = false;
  let contour: { x: number; y: number }[] = [];
  let polarityClear = false;

  const extended = text.match(/%[^%]*%/gu) ?? [];
  for (const block of extended) {
    const body = block.slice(1, -1);
    for (const command of body.split("*")) {
      if (command.startsWith("FSLA")) {
        const m = /^FSLAX(\d)(\d)Y(\d)(\d)$/u.exec(command);
        if (m !== null) scale = Math.pow(10, -Number(m[2]));
      } else if (command.startsWith("MOMM")) {
        unitScale = 1;
      } else if (command.startsWith("MOIN")) {
        unitScale = 25.4;
      } else if (command.startsWith("ADD")) {
        const m = /^ADD(\d+)([A-Za-z_]+),?([\d.X]*)$/u.exec(command);
        if (m === null) continue;
        const id = m[1] as string;
        const shape = (m[2] as string).toUpperCase();
        const params = (m[3] ?? "").split("X").filter((item) => item !== "").map(Number);
        if (shape === "C" && params.length >= 1) apertures.set(id, { shape: "circle", size: params[0] as number });
        else if (shape === "R" && params.length >= 2) apertures.set(id, { shape: "rect", w: params[0] as number, h: params[1] as number });
        else if (shape === "O" && params.length >= 2) apertures.set(id, { shape: "obround", w: params[0] as number, h: params[1] as number });
        else apertures.set(id, { shape: "other" });
      } else if (command.startsWith("LP")) {
        polarityClear = command.startsWith("LPC");
      }
    }
  }

  const body = text.replace(/%[^%]*%/gu, "").split("*");
  for (const raw of body) {
    const command = raw.replace(/\s+/gu, "");
    if (command === "" || command.startsWith("G04")) continue;
    if (command === "G36") {
      inRegion = true;
      contour = [];
      continue;
    }
    if (command === "G37") {
      inRegion = false;
      if (contour.length >= 3) {
        if (polarityClear) {
          draw.skipped += 1;
          notes.push("有 LPC 挖空区域没有画（极性为负）");
        } else {
          draw.polygons.push({ points: contour });
          draw.regions += 1;
        }
      }
      contour = [];
      continue;
    }
    if (command === "G01" || command === "G1") {
      interpolation = "linear";
      continue;
    }
    if (command === "G02" || command === "G2") {
      interpolation = "cw";
      continue;
    }
    if (command === "G03" || command === "G3") {
      interpolation = "ccw";
      continue;
    }
    if (/^D(\d+)$/u.test(command)) {
      const id = (/^D(\d+)$/u.exec(command) as RegExpExecArray)[1] as string;
      if (id.length >= 2) current = apertures.get(id) ?? { shape: "other" };
      continue;
    }
    if (!/^[XYIJ]?[\d-]/.test(command) && !command.startsWith("M02")) continue;
    if (command.startsWith("M02")) break;
    const coords = parseCoords(command, Math.round(1 / scale));
    if (coords === null) continue;
    const nx = coords.x ?? x;
    const ny = coords.y ?? y;
    const operation = coords.d;
    if (operation === 1) {
      const points = interpolation === "linear"
        ? [{ x, y }, { x: nx, y: ny }]
        : arcPoints(x, y, nx, ny, coords.i ?? 0, coords.j ?? 0, interpolation === "cw");
      for (let index = 1; index < points.length; index += 1) {
        const a = points[index - 1] as { x: number; y: number };
        const b = points[index] as { x: number; y: number };
        if (inRegion) {
          if (contour.length === 0) contour.push(a);
          contour.push(b);
        } else {
          const width = current === null ? 0.1 : current.shape === "circle" ? current.size : current.shape === "rect" || current.shape === "obround" ? Math.min(current.w, current.h) : 0.1;
          draw.lines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, width: width * unitScale });
          draw.segments += 1;
        }
      }
    } else if (operation === 2) {
      startX = nx;
      startY = ny;
      if (inRegion && contour.length > 0) {
        contour.push({ x: nx, y: ny });
      }
    } else if (operation === 3) {
      flash(draw, current, nx, ny, unitScale, notes);
    }
    x = nx;
    y = ny;
  }
  void startX;
  void startY;
  // 单位换算：解析出的坐标是 `scale` 单位的整数 → mm。
  for (const line of draw.lines) {
    line.x1 *= unitScale;
    line.y1 *= unitScale;
    line.x2 *= unitScale;
    line.y2 *= unitScale;
  }
  for (const rect of draw.rects) {
    rect.x *= unitScale;
    rect.y *= unitScale;
    rect.w *= unitScale;
    rect.h *= unitScale;
  }
  for (const circle of draw.circles) {
    circle.x *= unitScale;
    circle.y *= unitScale;
    circle.r *= unitScale;
  }
  for (const polygon of draw.polygons) {
    for (const point of polygon.points) {
      point.x *= unitScale;
      point.y *= unitScale;
    }
  }
  return { draw, holes: [], notes: [...new Set(notes)] };
}

function flash(
  draw: LayerDraw,
  aperture: Aperture | null,
  x: number,
  y: number,
  unitScale: number,
  notes: string[],
): void {
  if (aperture === null || aperture.shape === "other") {
    draw.skipped += 1;
    notes.push("有不支持的光圈（多边形/宏）没有画");
    return;
  }
  if (aperture.shape === "circle") {
    draw.circles.push({ x: x * unitScale, y: y * unitScale, r: (aperture.size / 2) * unitScale });
  } else {
    draw.rects.push({ x: x * unitScale, y: y * unitScale, w: aperture.w * unitScale, h: aperture.h * unitScale, rotation: 0 });
  }
  draw.flashes += 1;
}

interface Coords {
  readonly x: number | null;
  readonly y: number | null;
  readonly i: number | null;
  readonly j: number | null;
  readonly d: number | null;
}

function parseCoords(command: string, divisor: number): Coords | null {
  const m = /^(?:X(-?\d+))?(?:Y(-?\d+))?(?:I(-?\d+))?(?:J(-?\d+))?(?:D0?([123]))?$/u.exec(command);
  if (m === null) return null;
  const toMm = (value: string | undefined): number | null => (value === undefined ? null : Number(value) / divisor);
  return {
    x: toMm(m[1]),
    y: toMm(m[2]),
    i: toMm(m[3]),
    j: toMm(m[4]),
    d: m[5] === undefined ? null : Number(m[5]),
  };
}

/** 圆弧按弦长 0.2 mm 采样成折线；圆心用 I/J（相对起点）。 */
function arcPoints(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  i: number,
  j: number,
  clockwise: boolean,
): { x: number; y: number }[] {
  const cx = x1 + i;
  const cy = y1 + j;
  const r = Math.hypot(x1 - cx, y1 - cy);
  if (r < 1e-6) return [{ x: x1, y: y1 }, { x: x2, y: y2 }];
  let a1 = Math.atan2(y1 - cy, x1 - cx);
  let a2 = Math.atan2(y2 - cy, x2 - cx);
  if (clockwise && a2 >= a1) a2 -= Math.PI * 2;
  if (!clockwise && a2 <= a1) a2 += Math.PI * 2;
  const steps = Math.max(2, Math.ceil(Math.abs(a2 - a1) * r / 0.2));
  const points: { x: number; y: number }[] = [];
  for (let index = 0; index <= steps; index += 1) {
    const angle = a1 + ((a2 - a1) * index) / steps;
    points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  }
  return points;
}

/** Excellon：只认 KiCad 写的 T 刀具 + 绝对坐标 XY + G90，单位取 METRIC/INCH。 */
function parseExcellon(text: string): { holes: { x: number; y: number; d: number }[]; notes: string[] } {
  const notes: string[] = [];
  const tools = new Map<string, number>();
  const holes: { x: number; y: number; d: number }[] = [];
  let unit = 1; // mm
  let current = "";
  let routing = false;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "" || line.startsWith(";")) continue;
    if (/^INCH/u.test(line)) {
      unit = 25.4;
      continue;
    }
    if (/^METRIC/u.test(line)) {
      unit = 1;
      continue;
    }
    // Excellon：G05 = 钻孔模式，G00/M15 = 铣槽模式（KiCad 只有前者，但别写反）。
    if (/^G0?5/u.test(line) || /^M1[56]/u.test(line)) {
      routing = /^M15/u.test(line);
      continue;
    }
    if (/^G0?0/u.test(line)) {
      routing = true;
      continue;
    }
    const tool = /^T(\d+)C([\d.]+)$/u.exec(line);
    if (tool !== null) {
      tools.set(tool[1] as string, Number(tool[2]));
      continue;
    }
    const select = /^T(\d+)$/u.exec(line);
    if (select !== null) {
      current = select[1] as string;
      continue;
    }
    const hit = /^X(-?[\d.]+)Y(-?[\d.]+)$/u.exec(line);
    if (hit !== null) {
      if (routing) {
        notes.push("铣槽（G05）里的一段没有画");
        continue;
      }
      const d = tools.get(current) ?? 0;
      if (d > 0) holes.push({ x: Number(hit[1]) * unit, y: Number(hit[2]) * unit, d: d * unit });
      continue;
    }
  }
  return { holes, notes: [...new Set(notes)] };
}

function escapeText(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}
