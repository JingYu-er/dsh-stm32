/**
 * 建网：把一张图纸上的导线、标号、电源符号、引脚算成连通分量。
 *
 * 做法是几何吸附 + 并查集：
 * 1. 坐标按 0.02 mm 取整做节点键，导线两端合并；
 * 2. 标号与引脚先吸附到最近的导线端点/线身（0.35 mm 内），吸附不到就落在自己坐标上；
 * 3. 同名电源符号合并（KiCad 里同名电源就是同一网络），电源优先于标号作为网络名；
 * 4. `no_connect` 标记单独记录，供检查规则判断「既接网络又标了不连接」。
 *
 * 这里只做单张图纸。跨图纸的全局标号与同名电源由 `model.ts` 合并；
 * 层级图纸引脚（hierarchical_label）暂不跨页解析，属于已知边界。
 */

import type { SchFile, SchLabelKind, SchPoint, SchSymbol } from "./kicad-sch.js";
import { placePin } from "./transform.js";

/** 坐标吸附精度（mm）。KiCad 的默认栅格是 1.27 mm，0.02 mm 足以区分同一点。 */
const GRID_MM = 0.02;
/** 标号/引脚吸附到导线的容差（mm）。 */
const SNAP_MM = 0.35;

export interface NetPin {
  readonly ref: string;
  readonly number: string;
  readonly name: string;
  /** 引脚电气类型（`power_in` / `bidirectional` / `passive`…），来自库定义。 */
  readonly type: string;
  readonly noConnect: boolean;
}

export interface SheetNet {
  /** 网络名；空串表示未命名，由上层分配 `N$n`。 */
  readonly name: string;
  readonly kind: "label" | "power" | "unnamed";
  readonly sheet: string;
  readonly labels: readonly string[];
  readonly power: readonly string[];
  readonly pins: readonly NetPin[];
  readonly hasNoConnect: boolean;
  /** 含全局标号或层级标号：跨图纸按名字合并。 */
  readonly global: boolean;
}

export interface SheetNetResult {
  readonly file: SchFile;
  readonly nets: readonly SheetNet[];
  /** `ref:number` → 网络下标（`nets` 中的位置）。 */
  readonly pinNet: ReadonlyMap<string, number>;
  /** 因吸附失败而未接任何导线的引脚数，用于告警。 */
  readonly floatingPins: readonly string[];
}

function pointKey(x: number, y: number): string {
  return `${Math.round(x / GRID_MM)}:${Math.round(y / GRID_MM)}`;
}

class DisjointSet {
  private readonly parent = new Map<string, string>();

  find(node: string): string {
    const current = this.parent.get(node);
    if (current === undefined) {
      this.parent.set(node, node);
      return node;
    }
    if (current === node) return node;
    const root = this.find(current);
    this.parent.set(node, root);
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootA, rootB);
  }
}

function distance(a: SchPoint, b: SchPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 把点吸附到最近的导线端点或线身；超出容差返回 null。 */
function snapToWire(wires: readonly { a: SchPoint; b: SchPoint }[], point: SchPoint): SchPoint | null {
  let best: SchPoint | null = null;
  let bestDistance = SNAP_MM;
  for (const wire of wires) {
    for (const end of [wire.a, wire.b]) {
      const d = distance(end, point);
      if (d < bestDistance) {
        bestDistance = d;
        best = end;
      }
    }
    const dx = wire.b.x - wire.a.x;
    const dy = wire.b.y - wire.a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) continue;
    const t = Math.max(0, Math.min(1, ((point.x - wire.a.x) * dx + (point.y - wire.a.y) * dy) / lengthSquared));
    const projection = { x: wire.a.x + t * dx, y: wire.a.y + t * dy };
    const d = distance(projection, point);
    if (d < bestDistance) {
      bestDistance = d;
      best = projection;
    }
  }
  return best;
}

function pinsOfSymbol(sheet: SchFile, symbol: SchSymbol): readonly { number: string; name: string; x: number; y: number; kind: string }[] {
  const pins = sheet.libPins.get(symbol.libId) ?? [];
  if (pins.length === 0) return [];
  const wanted = symbol.unit;
  const matched = pins.filter((pin) => pin.unit === 0 || pin.unit === wanted);
  const usable = matched.length > 0 ? matched : pins;
  return usable.map((pin) => {
    const placed = placePin(pin, symbol);
    return { number: pin.number, name: pin.name, x: placed.x, y: placed.y, kind: pin.kind };
  });
}

/** 读一张图纸的网络。 */
export function buildSheetNets(sheet: SchFile): SheetNetResult {
  const dsu = new DisjointSet();
  const node = (x: number, y: number): string => {
    const key = pointKey(x, y);
    dsu.find(key);
    return key;
  };

  for (const wire of sheet.wires) {
    dsu.union(node(wire.a.x, wire.a.y), node(wire.b.x, wire.b.y));
  }

  const attach = (point: SchPoint): string => {
    const snapped = snapToWire(sheet.wires, point);
    return snapped === null ? node(point.x, point.y) : node(snapped.x, snapped.y);
  };

  const labelRecords: { name: string; kind: SchLabelKind; node: string }[] = [];
  for (const label of sheet.labels) {
    labelRecords.push({ name: label.name, kind: label.kind, node: attach(label.at) });
  }

  const powerRecords: { name: string; node: string }[] = [];
  const pinRecords: {
    key: string;
    ref: string;
    node: string;
    pin: { number: string; name: string; kind: string };
    marker: string;
  }[] = [];
  const floating: string[] = [];

  for (const symbol of sheet.symbols) {
    const placedPins = pinsOfSymbol(sheet, symbol);
    if (symbol.isPower) {
      for (const pin of placedPins) powerRecords.push({ name: symbol.value, node: attach({ x: pin.x, y: pin.y }) });
      continue;
    }
    if (symbol.ref === "" || symbol.ref.startsWith("#")) continue;
    for (const pin of placedPins) {
      const snapped = snapToWire(sheet.wires, { x: pin.x, y: pin.y });
      if (snapped === null) floating.push(`${symbol.ref}.${pin.number}`);
      pinRecords.push({
        key: `${symbol.ref}:${pin.number}`,
        ref: symbol.ref,
        node: attach({ x: pin.x, y: pin.y }),
        pin: { number: pin.number, name: pin.name, kind: pin.kind },
        marker: pointKey(pin.x, pin.y),
      });
    }
  }

  const noConnectNodes = new Set<string>();
  for (const marker of sheet.noConnects) noConnectNodes.add(pointKey(marker.x, marker.y));

  // 同名电源合并：一个电源符号的引脚压在 MCU 引脚上时，几何上已经同节点，
  // 但两块 GND 符号之间的「同名即同网」必须显式合并，否则 GND 会被拆成多段。
  const byPower = new Map<string, string[]>();
  for (const record of powerRecords) {
    const list = byPower.get(record.name) ?? [];
    list.push(record.node);
    byPower.set(record.name, list);
  }
  for (const nodes of byPower.values()) {
    for (let i = 1; i < nodes.length; i += 1) {
      const first = nodes[0];
      const other = nodes[i];
      if (first !== undefined && other !== undefined) dsu.union(first, other);
    }
  }

  const labelNodes = new Map<string, string[]>();
  for (const record of labelRecords) {
    const list = labelNodes.get(record.name) ?? [];
    list.push(record.node);
    labelNodes.set(record.name, list);
  }
  for (const nodes of labelNodes.values()) {
    for (let i = 1; i < nodes.length; i += 1) {
      const first = nodes[0];
      const other = nodes[i];
      if (first !== undefined && other !== undefined) dsu.union(first, other);
    }
  }

  interface Group {
    labels: string[];
    power: string[];
    pins: NetPin[];
    noConnect: boolean;
    global: boolean;
  }
  const groups = new Map<string, Group>();
  const groupOf = (nodeKey: string): Group => {
    const root = dsu.find(nodeKey);
    let group = groups.get(root);
    if (group === undefined) {
      group = { labels: [], power: [], pins: [], noConnect: false, global: false };
      groups.set(root, group);
    }
    return group;
  };

  for (const record of labelRecords) {
    const group = groupOf(record.node);
    if (!group.labels.includes(record.name)) group.labels.push(record.name);
    if (record.kind !== "label") group.global = true;
  }
  for (const record of powerRecords) {
    const group = groupOf(record.node);
    if (!group.power.includes(record.name)) group.power.push(record.name);
  }
  for (const record of pinRecords) {
    const group = groupOf(record.node);
    const noConnect = noConnectNodes.has(record.marker);
    group.pins.push({
      ref: record.ref,
      number: record.pin.number,
      name: record.pin.name,
      type: record.pin.kind,
      noConnect,
    });
    if (noConnect) group.noConnect = true;
  }

  const nets: SheetNet[] = [];
  const pinNet = new Map<string, number>();
  let unnamed = 0;
  for (const group of groups.values()) {
    const labels = [...group.labels].sort();
    const power = [...group.power].sort();
    const kind: SheetNet["kind"] = power.length > 0 ? "power" : labels.length > 0 ? "label" : "unnamed";
    const name = power.length > 0 ? power.join("/") : labels.length > 0 ? labels.join("/") : `N$${unnamed += 1}`;
    const index = nets.length;
    nets.push({
      name,
      kind,
      sheet: sheet.relFile,
      labels,
      power,
      pins: group.pins,
      hasNoConnect: group.noConnect,
      global: group.global,
    });
    for (const pin of group.pins) pinNet.set(`${pin.ref}:${pin.number}`, index);
  }
  return { file: sheet, nets, pinNet, floatingPins: floating };
}
