/**
 * 从 `.kicad_pcb` 读板面几何（S151）。
 *
 * 面板要看见板子，工具要能回答「板多大、几个焊盘、线有多密」。这些信息全在
 * `.kicad_pcb` 里，但分散在板框（`gr_*`）、封装（`footprint` 的 `fp_*` 与 `pad`）、
 * 走线（`segment`/`arc`）、过孔（`via`）、铺铜（`zone`）五处，而且封装内的坐标是
 * 相对封装原点、还要叠加封装自身的旋转。
 *
 * 这里只做几何读取，不做判断：板框是否闭合、焊盘数量与网络对不对，分别由
 * `checks.ts`、`dfm.ts`、`schematic/pcb.ts` 负责。预览读不出几何时返回可读的失败，
 * 不抛异常——一块板打不开，不该让整个面板白屏。
 */

import { readFileSync } from "node:fs";

import { atomOf, childOf, childrenOf, numberOf, parseSexpr, type SExprNode } from "../../schematic/sexpr.js";

export type PcbSide = "top" | "bottom";

export interface PcbPoint {
  readonly x: number;
  readonly y: number;
}

export type PcbPadShape = "rect" | "roundrect" | "circle" | "oval" | "other";

export interface PcbPadView {
  readonly ref: string;
  readonly number: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** 绝对旋转角（度），已叠加封装旋转。 */
  readonly rotation: number;
  readonly shape: PcbPadShape;
  readonly side: PcbSide;
}

export interface PcbTrackView {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly width: number;
  readonly side: PcbSide;
}

export interface PcbViaView {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly drill: number;
}

export interface PcbSilkLine {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface PcbRefLabel extends PcbPoint {
  readonly text: string;
}

export interface PcbZoneView {
  readonly side: PcbSide;
  readonly points: readonly PcbPoint[];
}

export interface PcbBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PcbScene {
  readonly ok: boolean;
  readonly error: string;
  readonly file: string;
  /** 铜层数（来自 `(layers ...)` 里的 `*.Cu`）。 */
  readonly copperLayers: number;
  readonly outline: readonly PcbSilkLine[];
  readonly silk: readonly PcbSilkLine[];
  readonly pads: readonly PcbPadView[];
  readonly tracks: readonly PcbTrackView[];
  /** 内层（In1.Cu 等）走线条数：预览不画，但要在说明里交代清楚。 */
  readonly innerTracks: number;
  readonly vias: readonly PcbViaView[];
  readonly zones: readonly PcbZoneView[];
  readonly refs: readonly PcbRefLabel[];
  /** 板框包围盒（mm）；没有板框时退回焊盘与走线范围。 */
  readonly bbox: PcbBox | null;
  readonly notes: readonly string[];
}

const EMPTY_SCENE = {
  ok: false,
  error: "",
  file: "",
  copperLayers: 0,
  outline: [] as PcbSilkLine[],
  silk: [] as PcbSilkLine[],
  pads: [] as PcbPadView[],
  tracks: [] as PcbTrackView[],
  innerTracks: 0,
  vias: [] as PcbViaView[],
  zones: [] as PcbZoneView[],
  refs: [] as PcbRefLabel[],
  bbox: null as PcbBox | null,
  notes: [] as string[],
};

/** 旋转封装内的相对坐标：KiCad 的 y 轴向下，正角在屏幕上是逆时针。 */
function rotate(dx: number, dy: number, degrees: number): PcbPoint {
  if (degrees === 0) return { x: dx, y: dy };
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
}

function pointOf(node: SExprNode[] | null): PcbPoint | null {
  if (node === null) return null;
  const x = numberOf(node, 1);
  const y = numberOf(node, 2);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function atOf(node: SExprNode[] | null): { x: number; y: number; rotation: number } {
  if (node === null) return { x: 0, y: 0, rotation: 0 };
  const x = numberOf(node, 1);
  const y = numberOf(node, 2);
  const rotation = numberOf(node, 3);
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    rotation: Number.isFinite(rotation) ? rotation : 0,
  };
}

/** 层名：KiCad 10 与 tscircuit 都写不带引号的原子，这里只按文本比较。 */
function layerNameOf(node: SExprNode[] | null): string {
  if (node === null) return "";
  const name = atomOf(node, 1);
  return name;
}

function sideOfLayer(layer: string): PcbSide | "" {
  if (layer === "F.Cu") return "top";
  if (layer === "B.Cu") return "bottom";
  return "";
}

function sideOfLayers(node: SExprNode[] | null): PcbSide | "" {
  if (node === null) return "";
  for (const item of node.slice(1)) {
    if (typeof item !== "string") continue;
    const side = sideOfLayer(item);
    if (side !== "") return side;
  }
  return "";
}

function pointsOf(node: SExprNode[] | null): PcbPoint[] {
  if (node === null) return [];
  const out: PcbPoint[] = [];
  for (const item of node.slice(1)) {
    if (!Array.isArray(item)) continue;
    const point = pointOf(item);
    if (point !== null) out.push(point);
  }
  return out;
}

function lineOf(x1: number, y1: number, x2: number, y2: number): PcbSilkLine {
  return { x1, y1, x2, y2 };
}

function rectLines(start: PcbPoint, end: PcbPoint): PcbSilkLine[] {
  return [
    lineOf(start.x, start.y, end.x, start.y),
    lineOf(end.x, start.y, end.x, end.y),
    lineOf(end.x, end.y, start.x, end.y),
    lineOf(start.x, end.y, start.x, start.y),
  ];
}

function polyLines(points: readonly PcbPoint[]): PcbSilkLine[] {
  const out: PcbSilkLine[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (current === undefined || next === undefined) continue;
    out.push(lineOf(current.x, current.y, next.x, next.y));
  }
  return out;
}

/** 三点圆弧采样成折线：预览只需要形状，不需要精确的圆弧图元。 */
function arcLines(start: PcbPoint, mid: PcbPoint, end: PcbPoint, steps = 12): PcbSilkLine[] {
  const ax = start.x;
  const ay = start.y;
  const bx = mid.x;
  const by = mid.y;
  const cx = end.x;
  const cy = end.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return [lineOf(ax, ay, cx, cy)];
  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  const radius = Math.hypot(ax - ux, ay - uy);
  const angleOf = (point: PcbPoint): number => Math.atan2(point.y - uy, point.x - ux);
  const from = angleOf(start);
  const to = angleOf(end);
  const middle = angleOf(mid);
  // 选择经过 mid 的那一段：跨越 ±π 时角度差要按同一方向归一。
  const normalize = (value: number): number => {
    let angle = value;
    while (angle <= -Math.PI) angle += Math.PI * 2;
    while (angle > Math.PI) angle -= Math.PI * 2;
    return angle;
  };
  let delta = normalize(to - from);
  const middleDelta = normalize(middle - from);
  if (delta >= 0 !== middleDelta >= 0 || Math.abs(middleDelta) > Math.abs(delta)) {
    delta = delta >= 0 ? delta - Math.PI * 2 : delta + Math.PI * 2;
  }
  const points: PcbPoint[] = [];
  for (let index = 0; index <= steps; index += 1) {
    const angle = from + (delta * index) / steps;
    points.push({ x: ux + radius * Math.cos(angle), y: uy + radius * Math.sin(angle) });
  }
  return polyLines(points);
}

function padShapeOf(text: string): PcbPadShape {
  if (text === "rect") return "rect";
  if (text === "roundrect") return "roundrect";
  if (text === "circle") return "circle";
  if (text === "oval") return "oval";
  return "other";
}

function refOfFootprint(footprint: SExprNode[]): string {
  for (const property of childrenOf(footprint, "property")) {
    if (atomOf(property, 1) === "Reference") return atomOf(property, 2);
  }
  for (const text of childrenOf(footprint, "fp_text")) {
    if (atomOf(text, 1) === "reference") return atomOf(text, 2);
  }
  return "";
}

interface Transform {
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
}

function applyTransform(transform: Transform, point: PcbPoint): PcbPoint {
  const rotated = rotate(point.x, point.y, transform.rotation);
  return { x: transform.x + rotated.x, y: transform.y + rotated.y };
}

function transformLine(transform: Transform, line: PcbSilkLine): PcbSilkLine {
  const start = applyTransform(transform, { x: line.x1, y: line.y1 });
  const end = applyTransform(transform, { x: line.x2, y: line.y2 });
  return lineOf(start.x, start.y, end.x, end.y);
}

interface FootprintScan {
  readonly pads: PcbPadView[];
  readonly silk: PcbSilkLine[];
  readonly refs: PcbRefLabel[];
}

function scanFootprint(footprint: SExprNode[], fallbackRef: string): FootprintScan {
  const at = atOf(childOf(footprint, "at"));
  const transform: Transform = { x: at.x, y: at.y, rotation: at.rotation };
  const footprintLayer = layerNameOf(childOf(footprint, "layer"));
  const footprintSide: PcbSide = footprintLayer === "B.Cu" ? "bottom" : "top";
  const ref = refOfFootprint(footprint) === "" ? fallbackRef : refOfFootprint(footprint);
  const pads: PcbPadView[] = [];
  const silk: PcbSilkLine[] = [];
  const refs: PcbRefLabel[] = [];

  for (const item of footprint) {
    if (!Array.isArray(item)) continue;
    const head = atomOf(item, 0);
    if (head === "pad") {
      const padAt = atOf(childOf(item, "at"));
      const size = childOf(item, "size");
      const width = numberOf(size, 1);
      const height = numberOf(size, 2);
      if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
      const center = applyTransform(transform, { x: padAt.x, y: padAt.y });
      const side = sideOfLayers(childOf(item, "layers")) === "bottom" ? "bottom" : footprintSide;
      pads.push({
        ref,
        number: atomOf(item, 1),
        x: center.x,
        y: center.y,
        width,
        height,
        rotation: transform.rotation + padAt.rotation,
        shape: padShapeOf(atomOf(item, 3)),
        side,
      });
      continue;
    }
    if (head === "fp_text") {
      const kind = atomOf(item, 1);
      if (kind !== "reference" && kind !== "value") continue;
      const text = atomOf(item, 2);
      const textAt = atOf(childOf(item, "at"));
      if (text === "") continue;
      const position = applyTransform(transform, { x: textAt.x, y: textAt.y });
      refs.push({ x: position.x, y: position.y, text });
      continue;
    }
    const layer = layerNameOf(childOf(item, "layer"));
    if (!layer.endsWith("SilkS")) continue;
    if (head === "fp_line") {
      const start = pointOf(childOf(item, "start"));
      const end = pointOf(childOf(item, "end"));
      if (start !== null && end !== null) silk.push(transformLine(transform, lineOf(start.x, start.y, end.x, end.y)));
      continue;
    }
    if (head === "fp_rect") {
      const start = pointOf(childOf(item, "start"));
      const end = pointOf(childOf(item, "end"));
      if (start !== null && end !== null) {
        for (const line of rectLines(start, end)) silk.push(transformLine(transform, line));
      }
      continue;
    }
    if (head === "fp_circle") {
      const center = pointOf(childOf(item, "center"));
      const edge = pointOf(childOf(item, "end"));
      if (center !== null && edge !== null) {
        const radius = Math.hypot(edge.x - center.x, edge.y - center.y);
        const steps = 16;
        const points: PcbPoint[] = [];
        for (let index = 0; index < steps; index += 1) {
          const angle = (index / steps) * Math.PI * 2;
          points.push({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) });
        }
        for (const line of polyLines(points)) silk.push(transformLine(transform, line));
      }
      continue;
    }
    if (head === "fp_poly") {
      const points = pointsOf(childOf(item, "pts"));
      if (points.length >= 2) for (const line of polyLines(points)) silk.push(transformLine(transform, line));
      continue;
    }
    if (head === "fp_arc") {
      const start = pointOf(childOf(item, "start"));
      const mid = pointOf(childOf(item, "mid"));
      const end = pointOf(childOf(item, "end"));
      if (start !== null && mid !== null && end !== null) {
        for (const line of arcLines(start, mid, end)) silk.push(transformLine(transform, line));
      }
    }
  }
  return { pads, silk, refs };
}

function bboxOf(lines: readonly PcbSilkLine[], pads: readonly PcbPadView[], tracks: readonly PcbTrackView[]): PcbBox | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const grow = (x: number, y: number): void => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const line of lines) {
    grow(line.x1, line.y1);
    grow(line.x2, line.y2);
  }
  if (!Number.isFinite(minX)) {
    for (const pad of pads) {
      grow(pad.x - pad.width / 2, pad.y - pad.height / 2);
      grow(pad.x + pad.width / 2, pad.y + pad.height / 2);
    }
    for (const track of tracks) {
      grow(track.x1, track.y1);
      grow(track.x2, track.y2);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function parsePcbScene(text: string, file: string): PcbScene {
  // 括号不闭合这类语法错误要变成可读结果，让上层能提示而不是抛异常。
  let doc: SExprNode[];
  try {
    doc = parseSexpr(text);
  } catch (error) {
    return { ...EMPTY_SCENE, file, error: "读不懂这个 .kicad_pcb：" + (error instanceof Error ? error.message : String(error)) };
  }
  const outline: PcbSilkLine[] = [];
  const silk: PcbSilkLine[] = [];
  const pads: PcbPadView[] = [];
  const tracks: PcbTrackView[] = [];
  const vias: PcbViaView[] = [];
  const zones: PcbZoneView[] = [];
  const refs: PcbRefLabel[] = [];
  const notes: string[] = [];
  let copperLayers = 0;
  let innerTracks = 0;
  let arcs = 0;
  let footprintIndex = 0;

  const layersNode = childOf(doc, "layers");
  if (layersNode !== null) {
    for (const item of layersNode) {
      if (!Array.isArray(item)) continue;
      const name = atomOf(item, 1);
      if (name.endsWith(".Cu") || /^In\d+\.Cu$/u.test(name)) copperLayers += 1;
    }
  }

  for (const item of doc) {
    if (!Array.isArray(item)) continue;
    const head = atomOf(item, 0);
    if (head === "footprint" || head === "module") {
      footprintIndex += 1;
      const scan = scanFootprint(item, "U" + String(footprintIndex));
      pads.push(...scan.pads);
      silk.push(...scan.silk);
      refs.push(...scan.refs);
      continue;
    }
    if (head === "segment" || head === "arc") {
      const start = pointOf(childOf(item, "start"));
      const end = pointOf(childOf(item, "end"));
      if (start === null || end === null) continue;
      if (head === "arc") arcs += 1;
      const width = numberOf(childOf(item, "width"), 1);
      const layer = layerNameOf(childOf(item, "layer"));
      const side = sideOfLayer(layer);
      if (side === "") {
        if (/^In\d+\.Cu$/u.test(layer)) innerTracks += 1;
        continue;
      }
      tracks.push({
        x1: start.x,
        y1: start.y,
        x2: end.x,
        y2: end.y,
        width: Number.isFinite(width) ? width : 0.2,
        side,
      });
      continue;
    }
    if (head === "via") {
      const at = pointOf(childOf(item, "at"));
      if (at === null) continue;
      const size = numberOf(childOf(item, "size"), 1);
      const drill = numberOf(childOf(item, "drill"), 1);
      vias.push({
        x: at.x,
        y: at.y,
        size: Number.isFinite(size) ? size : 0.6,
        drill: Number.isFinite(drill) ? drill : 0.3,
      });
      continue;
    }
    if (head === "zone") {
      const side = sideOfLayer(layerNameOf(childOf(item, "layer")));
      if (side === "") continue;
      for (const polygon of childrenOf(item, "polygon")) {
        const points = pointsOf(childOf(polygon, "pts"));
        if (points.length >= 3) zones.push({ side, points });
      }
      for (const filled of childrenOf(item, "filled_polygon")) {
        const points = pointsOf(childOf(filled, "pts"));
        if (points.length >= 3) zones.push({ side, points });
      }
      continue;
    }
    if (head !== "gr_line" && head !== "gr_rect" && head !== "gr_arc" && head !== "gr_circle" && head !== "gr_poly") continue;
    const layer = layerNameOf(childOf(item, "layer"));
    const isOutline = layer === "Edge.Cuts";
    if (!isOutline) continue;
    if (head === "gr_line") {
      const start = pointOf(childOf(item, "start"));
      const end = pointOf(childOf(item, "end"));
      if (start !== null && end !== null) outline.push(lineOf(start.x, start.y, end.x, end.y));
      continue;
    }
    if (head === "gr_rect") {
      const start = pointOf(childOf(item, "start"));
      const end = pointOf(childOf(item, "end"));
      if (start !== null && end !== null) outline.push(...rectLines(start, end));
      continue;
    }
    if (head === "gr_arc") {
      const start = pointOf(childOf(item, "start"));
      const mid = pointOf(childOf(item, "mid"));
      const end = pointOf(childOf(item, "end"));
      if (start !== null && end !== null) outline.push(...(mid === null ? [lineOf(start.x, start.y, end.x, end.y)] : arcLines(start, mid, end)));
      continue;
    }
    if (head === "gr_circle") {
      const center = pointOf(childOf(item, "center"));
      const edge = pointOf(childOf(item, "end"));
      if (center !== null && edge !== null) {
        const radius = Math.hypot(edge.x - center.x, edge.y - center.y);
        const steps = 32;
        const points: PcbPoint[] = [];
        for (let index = 0; index < steps; index += 1) {
          const angle = (index / steps) * Math.PI * 2;
          points.push({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) });
        }
        outline.push(...polyLines(points));
      }
      continue;
    }
    const points = pointsOf(childOf(item, "pts"));
    if (points.length >= 2) outline.push(...polyLines(points));
  }

  if (outline.length === 0) notes.push("没有找到板框（Edge.Cuts）：预览按焊盘与走线的范围裁切。");
  if (arcs > 0) notes.push("有 " + String(arcs) + " 条弧形走线按直线近似绘制。");
  if (innerTracks > 0) notes.push("内层有 " + String(innerTracks) + " 条走线：预览只画顶层与底层。");

  return {
    ok: true,
    error: "",
    file,
    copperLayers,
    outline,
    silk,
    pads,
    tracks,
    innerTracks,
    vias,
    zones,
    refs,
    bbox: bboxOf(outline, pads, tracks),
    notes,
  };
}

export function readPcbScene(file: string): PcbScene {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...EMPTY_SCENE, error: "读不到板子文件：" + message };
  }
  try {
    return parsePcbScene(text, file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...EMPTY_SCENE, error: "板子文件不是合法的 KiCad 语法：" + message };
  }
}
