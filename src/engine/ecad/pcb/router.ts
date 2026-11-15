/**
 * 双层网格 A* 布线器（S143）。
 *
 * 状态是 (层, 行, 列)：同层走 8 邻域，换层要打过孔。障碍来自焊盘与既有走线，
 * 都按「对角线半径 + 间距」膨胀。目标是「不短接、不压线、尽量布通」，不追求最短。
 */
import type { BoardGeometry, GeoPad } from "./geometry.js";

export interface RouterOptions {
  resolutionMm?: number;
  clearanceMm?: number;
  powerWidthMm?: number;
  signalWidthMm?: number;
  /** 一个过孔折算成多少毫米的走线代价。 */
  viaCostMm?: number;
  turnCostMm?: number;
  maxPadsPerNet?: number;
  onlyPower?: boolean;
  /** 只布顶层（不打通孔），调试用。 */
  singleLayer?: boolean;
}

export interface RoutedSegment {
  net: string;
  layer: "F.Cu" | "B.Cu";
  widthMm: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface RoutedVia {
  net: string;
  x: number;
  y: number;
  drillMm: number;
  diameterMm: number;
}

export interface RoutedNet {
  net: string;
  pads: number;
  segments: number;
  vias: number;
  connected: boolean;
  reason: string;
}

export interface RouterReport {
  ok: boolean;
  error: string;
  segments: RoutedSegment[];
  vias: RoutedVia[];
  nets: RoutedNet[];
  unrouted: string[];
  grid: { cols: number; rows: number; resolutionMm: number };
  notes: string[];
}

const POWER_NET = /^(GND|VCC|VDD|VSS|VBUS|\+?\d+V\d*|\+?3V3|\+?5V)$/iu;
const LAYER_F = 0;
const LAYER_B = 1;

export function isPowerNet(net: string): boolean {
  return POWER_NET.test(net.trim());
}

interface Grid {
  cols: number;
  rows: number;
  res: number;
  x0: number;
  y0: number;
  blockedF: Uint8Array;
  blockedB: Uint8Array;
}

function cell(grid: Grid, layer: number, col: number, row: number): number {
  return layer * grid.cols * grid.rows + row * grid.cols + col;
}

function toCol(grid: Grid, x: number): number {
  return Math.round((x - grid.x0) / grid.res);
}

function toRow(grid: Grid, y: number): number {
  return Math.round((y - grid.y0) / grid.res);
}

function markDisc(grid: Grid, layer: number, cx: number, cy: number, radiusMm: number, value: 0 | 1): void {
  const radius = Math.max(1, Math.ceil(radiusMm / grid.res));
  const col = toCol(grid, cx);
  const row = toRow(grid, cy);
  const target = layer === LAYER_F ? grid.blockedF : grid.blockedB;
  for (let dr = -radius; dr <= radius; dr += 1) {
    for (let dc = -radius; dc <= radius; dc += 1) {
      if (dc * dc + dr * dr > radius * radius) continue;
      const c = col + dc;
      const r = row + dr;
      if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) continue;
      target[r * grid.cols + c] = value;
    }
  }
}

function markLine(grid: Grid, layer: number, x1: number, y1: number, x2: number, y2: number, radiusMm: number, value: 0 | 1): void {
  const length = Math.hypot(x2 - x1, y2 - y1);
  const steps = Math.max(1, Math.ceil(length / (grid.res * 0.5)));
  for (let step = 0; step <= steps; step += 1) {
    const ratio = step / steps;
    markDisc(grid, layer, x1 + (x2 - x1) * ratio, y1 + (y2 - y1) * ratio, radiusMm, value);
  }
}

const DIRS: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

interface HeapItem {
  key: number;
  estimate: number;
  cost: number;
}

class MinHeap {
  private items: HeapItem[] = [];
  public push(item: HeapItem): void {
    this.items.push(item);
    let child = this.items.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      const a = this.items[child];
      const b = this.items[parent];
      if (a === undefined || b === undefined || a.estimate >= b.estimate) break;
      this.items[child] = b;
      this.items[parent] = a;
      child = parent;
    }
  }
  public pop(): HeapItem | undefined {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0 && last !== undefined) {
      this.items[0] = last;
      let parent = 0;
      for (;;) {
        const left = parent * 2 + 1;
        const right = left + 1;
        let smallest = parent;
        const best = this.items[smallest];
        const l = this.items[left];
        const r = this.items[right];
        if (l !== undefined && best !== undefined && l.estimate < best.estimate) smallest = left;
        const best2 = this.items[smallest];
        if (r !== undefined && best2 !== undefined && r.estimate < best2.estimate) smallest = right;
        if (smallest === parent) break;
        const a = this.items[parent];
        const b = this.items[smallest];
        if (a === undefined || b === undefined) break;
        this.items[parent] = b;
        this.items[smallest] = a;
        parent = smallest;
      }
    }
    return top;
  }
  public get size(): number {
    return this.items.length;
  }
}

function nearestOrder(pads: GeoPad[], from = 0): number[] {
  const order = [from];
  const rest = new Set(pads.map((_pad, i) => i).filter((i) => i !== from));
  while (rest.size > 0) {
    const last = pads[order[order.length - 1] ?? 0];
    let best = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const candidate of rest) {
      const pad = pads[candidate];
      if (pad === undefined || last === undefined) continue;
      const dist = Math.abs(pad.x - last.x) + Math.abs(pad.y - last.y);
      if (dist < bestDist) {
        bestDist = dist;
        best = candidate;
      }
    }
    if (best < 0) break;
    order.push(best);
    rest.delete(best);
  }
  return order;
}

interface RouteResult {
  segments: RoutedSegment[];
  vias: RoutedVia[];
  failed: boolean;
  reason: string;
}

function nearestOf(grid: Grid, layer: number, col: number, row: number): number[] {
  const result: number[] = [];
  for (const [dc, dr] of DIRS) {
    const c = col + dc;
    const r = row + dr;
    if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) continue;
    const value = (layer === LAYER_F ? grid.blockedF : grid.blockedB)[r * grid.cols + c];
    result.push(value === undefined ? 1 : value);
  }
  return result;
}

function routePair(
  grid: Grid,
  from: GeoPad,
  to: GeoPad,
  widthMm: number,
  options: { clearanceMm: number; viaCostMm: number; turnCostMm: number; singleLayer: boolean; viaDrillMm: number; viaDiameterMm: number },
): { segments: RoutedSegment[]; vias: RoutedVia[]; ok: boolean; reason: string } {
  const startCol = toCol(grid, from.x);
  const startRow = toRow(grid, from.y);
  const goalCol = toCol(grid, to.x);
  const goalRow = toRow(grid, to.y);
  if (startCol === goalCol && startRow === goalRow) return { segments: [], vias: [], ok: true, reason: "" };
  const escape = Math.hypot(from.width, from.height) / 2 + grid.res * 1.4;
  markDisc(grid, LAYER_F, from.x, from.y, escape, 0);
  markDisc(grid, LAYER_F, to.x, to.y, escape, 0);
  markDisc(grid, LAYER_B, from.x, from.y, escape, 0);
  markDisc(grid, LAYER_B, to.x, to.y, escape, 0);

  const total = grid.cols * grid.rows * 2;
  const cost = new Float32Array(total).fill(Number.POSITIVE_INFINITY);
  const previous = new Int32Array(total).fill(-1);
  const layers = options.singleLayer ? [LAYER_F] : [LAYER_F, LAYER_B];
  const start = cell(grid, LAYER_F, startCol, startRow);
  cost[start] = 0;
  const open = new MinHeap();
  const heuristic = (col: number, row: number): number => Math.hypot(goalCol - col, goalRow - row);
  open.push({ key: start, cost: 0, estimate: heuristic(startCol, startRow) });
  let goalKey = -1;
  let visited = 0;
  while (open.size > 0 && visited < 200000) {
    const current = open.pop();
    if (current === undefined) break;
    visited += 1;
    const layer = Math.floor(current.key / (grid.cols * grid.rows));
    const rest = current.key - layer * grid.cols * grid.rows;
    const col = rest % grid.cols;
    const row = Math.floor(rest / grid.cols);
    if (col === goalCol && row === goalRow) {
      goalKey = current.key;
      break;
    }
    const blocked = layer === LAYER_F ? grid.blockedF : grid.blockedB;
    for (const [dc, dr] of DIRS) {
      const nc = col + dc;
      const nr = row + dr;
      if (nc < 0 || nr < 0 || nc >= grid.cols || nr >= grid.rows) continue;
      if (blocked[nr * grid.cols + nc] === 1) continue;
      const key = cell(grid, layer, nc, nr);
      if (cost[key] !== undefined && cost[key] !== Number.POSITIVE_INFINITY) continue;
      let next = (cost[current.key] ?? 0) + Math.hypot(dc, dr);
      const prevKey = previous[current.key];
      if (prevKey !== undefined && prevKey >= 0) {
        const pc = prevKey % grid.cols;
        const pr = Math.floor(prevKey / grid.cols);
        if ((pc !== col && col - pc !== dc) || (pr !== row && row - pr !== dr)) next += options.turnCostMm / grid.res;
      }
      if (next < (cost[key] ?? Number.POSITIVE_INFINITY)) {
        cost[key] = next;
        previous[key] = current.key;
        open.push({ key, cost: next, estimate: next + heuristic(nc, nr) });
      }
    }
    // 过孔：同格换层，两层都必须是空的。
    if (layers.length > 1) {
      const other = layer === LAYER_F ? LAYER_B : LAYER_F;
      const otherBlocked = other === LAYER_F ? grid.blockedF : grid.blockedB;
      if (otherBlocked[row * grid.cols + col] !== 1) {
        const key = cell(grid, other, col, row);
        if (cost[key] === undefined || cost[key] === Number.POSITIVE_INFINITY) {
          const next = (cost[current.key] ?? 0) + options.viaCostMm / grid.res;
          cost[key] = next;
          previous[key] = current.key;
          open.push({ key, cost: next, estimate: next + heuristic(col, row) });
        }
      }
    }
  }
  if (goalKey < 0) {
    return { segments: [], vias: [], ok: false, reason: "布不通（探索 " + String(visited) + " 格）" };
  }
  const path: { layer: number; col: number; row: number }[] = [];
  let cursor = goalKey;
  while (cursor >= 0) {
    const layer = Math.floor(cursor / (grid.cols * grid.rows));
    const rest = cursor - layer * grid.cols * grid.rows;
    path.push({ layer, col: rest % grid.cols, row: Math.floor(rest / grid.cols) });
    cursor = previous[cursor] ?? -1;
  }
  path.reverse();
  const segments: RoutedSegment[] = [];
  const vias: RoutedVia[] = [];
  const sameDirection = (a: { col: number; row: number }, b: { col: number; row: number }, c: { col: number; row: number }): boolean => {
    const d1c = Math.sign(b.col - a.col);
    const d1r = Math.sign(b.row - a.row);
    const d2c = Math.sign(c.col - b.col);
    const d2r = Math.sign(c.row - b.row);
    return d1c === d2c && d1r === d2r;
  };
  let anchor = path[0];
  for (let i = 1; i < path.length; i += 1) {
    const here = path[i];
    const prev = path[i - 1];
    const next = path[i + 1];
    if (anchor === undefined || here === undefined || prev === undefined) break;
    const layerChange = here.layer !== prev.layer;
    const directionChange = next !== undefined && next.layer === here.layer && !sameDirection(prev, here, next);
    const isEnd = i === path.length - 1;
    if (!layerChange && !directionChange && !isEnd) continue;
    const sx = grid.x0 + anchor.col * grid.res;
    const sy = grid.y0 + anchor.row * grid.res;
    const ex = grid.x0 + here.col * grid.res;
    const ey = grid.y0 + here.row * grid.res;
    if (Math.hypot(ex - sx, ey - sy) > 0.001) {
      segments.push({ net: from.net, layer: prev.layer === LAYER_F ? "F.Cu" : "B.Cu", widthMm, x1: sx, y1: sy, x2: ex, y2: ey });
    }
    if (layerChange) {
      vias.push({ net: from.net, x: ex, y: ey, drillMm: options.viaDrillMm, diameterMm: options.viaDiameterMm });
    }
    anchor = here;
  }
  const first = path[0];
  const last = path[path.length - 1];
  if (first !== undefined) {
    const fx = grid.x0 + first.col * grid.res;
    const fy = grid.y0 + first.row * grid.res;
    if (Math.hypot(fx - from.x, fy - from.y) > 0.001) {
      segments.unshift({ net: from.net, layer: first.layer === LAYER_F ? "F.Cu" : "B.Cu", widthMm, x1: from.x, y1: from.y, x2: fx, y2: fy });
    }
  }
  if (last !== undefined) {
    const lx = grid.x0 + last.col * grid.res;
    const ly = grid.y0 + last.row * grid.res;
    if (Math.hypot(lx - to.x, ly - to.y) > 0.001) {
      segments.push({ net: to.net, layer: last.layer === LAYER_F ? "F.Cu" : "B.Cu", widthMm, x1: lx, y1: ly, x2: to.x, y2: to.y });
    }
  }
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1];
    const b = path[i];
    if (a === undefined || b === undefined) continue;
    const layer = a.layer;
    const radius = widthMm / 2 + options.clearanceMm;
    markLine(grid, layer, grid.x0 + a.col * grid.res, grid.y0 + a.row * grid.res, grid.x0 + b.col * grid.res, grid.y0 + b.row * grid.res, radius * 0.5, 1);
  }
  for (const via of vias) markDisc(grid, LAYER_F, via.x, via.y, (via.diameterMm / 2) + options.clearanceMm, 1);
  return { segments, vias, ok: true, reason: "" };
}

export function planRouting(geometry: BoardGeometry, options: RouterOptions = {}): RouterReport {
  const resolution = Math.max(0.15, options.resolutionMm ?? 0.25);
  const clearance = options.clearanceMm ?? 0.2;
  const powerWidth = options.powerWidthMm ?? 0.5;
  const signalWidth = options.signalWidthMm ?? 0.25;
  const empty: RouterReport = {
    ok: false, error: "", segments: [], vias: [], nets: [], unrouted: [],
    grid: { cols: 0, rows: 0, resolutionMm: resolution }, notes: [],
  };
  if (!geometry.ok) return { ...empty, error: geometry.error };
  const margin = 2;
  const cols = Math.ceil(geometry.widthMm / resolution) + 2 * margin;
  const rows = Math.ceil(geometry.heightMm / resolution) + 2 * margin;
  const notes: string[] = [];

  const buildGrid = (excludeNet: string, committed: RoutedSegment[], committedVias: RoutedVia[]): Grid => {
    const grid: Grid = {
      cols, rows, res: resolution,
      x0: geometry.x0 - margin * resolution,
      y0: geometry.y0 - margin * resolution,
      blockedF: new Uint8Array(cols * rows),
      blockedB: new Uint8Array(cols * rows),
    };
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const x = grid.x0 + col * resolution;
        const y = grid.y0 + row * resolution;
        const outside = x < geometry.x0 - 0.5 || y < geometry.y0 - 0.5
          || x > geometry.x0 + geometry.widthMm + 0.5 || y > geometry.y0 + geometry.heightMm + 0.5;
        if (outside) {
          grid.blockedF[row * cols + col] = 1;
          grid.blockedB[row * cols + col] = 1;
        }
      }
    }
    for (const pad of geometry.pads) {
      if (pad.net === excludeNet) continue;
      const radius = Math.hypot(pad.width, pad.height) / 2 + clearance + resolution * 0.5;
      markDisc(grid, LAYER_F, pad.x, pad.y, radius, 1);
      markDisc(grid, LAYER_B, pad.x, pad.y, radius, 1);
    }
    for (const track of geometry.tracks) {
      const radius = track.width / 2 + clearance;
      markLine(grid, track.layer === "B.Cu" ? LAYER_B : LAYER_F, track.x1, track.y1, track.x2, track.y2, radius, 1);
    }
    for (const track of committed) {
      const radius = track.widthMm / 2 + clearance;
      markLine(grid, track.layer === "B.Cu" ? LAYER_B : LAYER_F, track.x1, track.y1, track.x2, track.y2, radius, 1);
    }
    for (const via of committedVias) {
      markDisc(grid, LAYER_F, via.x, via.y, via.diameterMm / 2 + clearance, 1);
      markDisc(grid, LAYER_B, via.x, via.y, via.diameterMm / 2 + clearance, 1);
    }
    return grid;
  };

  const byNet = new Map<string, GeoPad[]>();
  for (const pad of geometry.pads) {
    if (pad.net === "") continue;
    const list = byNet.get(pad.net) ?? [];
    list.push(pad);
    byNet.set(pad.net, list);
  }
  const nets = [...byNet.entries()]
    .filter(([net, pads]) => pads.length > 1 && (options.onlyPower !== true || isPowerNet(net)))
    .sort((a, b) => (isPowerNet(b[0]) ? 1 : 0) - (isPowerNet(a[0]) ? 1 : 0) || b[1].length - a[1].length);

  const segments: RoutedSegment[] = [];
  const vias: RoutedVia[] = [];
  const reports: RoutedNet[] = [];
  const unrouted: string[] = [];
  for (const [net, pads] of nets) {
    const capped = pads.slice(0, options.maxPadsPerNet ?? 40);
    const grid = buildGrid(net, segments, vias);
    const width = isPowerNet(net) ? powerWidth : signalWidth;
    const order = nearestOrder(capped);
    let netSegments = 0;
    let netVias = 0;
    let failed = false;
    let reason = "";
    for (let step = 1; step < order.length; step += 1) {
      const fromPad = capped[order[step - 1] ?? 0];
      const toPad = capped[order[step] ?? 0];
      if (fromPad === undefined || toPad === undefined) continue;
      const result = routePair(grid, fromPad, toPad, width, {
        clearanceMm: clearance,
        viaCostMm: options.viaCostMm ?? 25,
        turnCostMm: options.turnCostMm ?? 2,
        singleLayer: options.singleLayer === true,
        viaDrillMm: 0.3,
        viaDiameterMm: 0.6,
      });
      if (!result.ok) {
        failed = true;
        reason = result.reason;
        continue;
      }
      segments.push(...result.segments);
      vias.push(...result.vias);
      netSegments += result.segments.length;
      netVias += result.vias.length;
    }
    reports.push({ net, pads: capped.length, segments: netSegments, vias: netVias, connected: !failed, reason: failed ? reason : "" });
    if (failed) unrouted.push(net);
  }
  const checked = validateSegments(geometry, segments, clearance, vias);
  if (checked.rejected.length > 0) {
    notes.push("落盘前自检丢掉 " + String(checked.rejected.length) + " 段（与别的网络间距不足）");
    for (const report of reports) {
      const alive = checked.accepted.filter((segment) => segment.net === report.net).length;
      report.segments = alive;
      if (alive === 0 && report.connected) {
        report.connected = false;
        report.reason = "布线结果全部被自检拦下";
      }
    }
  }
  return {
    ok: true, error: "", segments: checked.accepted, vias, nets: reports, unrouted,
    grid: { cols, rows, resolutionMm: resolution }, notes,
  };
}

interface Obstacle {
  net: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  radius: number;
}

function pointSegmentDistance(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** 落盘前自检：逐段 0.1 mm 采样，与别网间距不足就整段丢掉。 */
export function validateSegments(
  geometry: BoardGeometry,
  segments: readonly RoutedSegment[],
  clearanceMm: number,
  vias: readonly RoutedVia[] = [],
): { accepted: RoutedSegment[]; rejected: RoutedSegment[] } {
  const obstacles: Obstacle[] = [];
  for (const pad of geometry.pads) {
    obstacles.push({ net: pad.net, x1: pad.x, y1: pad.y, x2: pad.x, y2: pad.y, radius: Math.hypot(pad.width, pad.height) / 2 });
  }
  for (const track of geometry.tracks) {
    obstacles.push({ net: track.net, x1: track.x1, y1: track.y1, x2: track.x2, y2: track.y2, radius: track.width / 2 });
  }
  for (const via of vias) {
    obstacles.push({ net: via.net, x1: via.x, y1: via.y, x2: via.x, y2: via.y, radius: via.diameterMm / 2 });
  }
  const accepted: RoutedSegment[] = [];
  const rejected: RoutedSegment[] = [];
  for (const segment of segments) {
    const length = Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
    const steps = Math.max(2, Math.ceil(length / 0.1));
    let bad = false;
    for (const obstacle of obstacles) {
      if (obstacle.net === segment.net) continue;
      const allowed = obstacle.radius + segment.widthMm / 2 + clearanceMm;
      for (let step = 0; step <= steps; step += 1) {
        const ratio = step / steps;
        const px = segment.x1 + (segment.x2 - segment.x1) * ratio;
        const py = segment.y1 + (segment.y2 - segment.y1) * ratio;
        if (pointSegmentDistance(px, py, obstacle.x1, obstacle.y1, obstacle.x2, obstacle.y2) < allowed) {
          bad = true;
          break;
        }
      }
      if (bad) break;
    }
    if (bad) {
      rejected.push(segment);
      continue;
    }
    accepted.push(segment);
    obstacles.push({ net: segment.net, x1: segment.x1, y1: segment.y1, x2: segment.x2, y2: segment.y2, radius: segment.widthMm / 2 });
  }
  return { accepted, rejected };
}
