/**
 * PCB 对账：把 `.kicad_pcb` 的焊盘网络与原理图解析出的网络对照。
 *
 * 为什么值得做：原理图解析是几何推算，PCB 是同一份设计的另一种表示，
 * 两者一致才说明解析器没有把线接错。对账只读 PCB，不写回、不改 `.ioc`。
 *
 * 判据用「连通性」而不是「名字相等」：同一条 PCB 网络上所有焊盘在原理图里必须落在
 * 同一个网络；名字差异（如 `/col1/GND` 与 `GND`）单独列出，不计为连通错误。
 */

import { readFileSync } from "node:fs";

import { atomOf, childOf, childrenOf, numberOf, parseSexpr, type SExprNode } from "./sexpr.js";
import type { SchematicReport } from "./model.js";

export interface PcbPad {
  readonly ref: string;
  readonly number: string;
  readonly net: string;
}

export interface PcbReport {
  readonly file: string;
  readonly version: number;
  readonly generator: string;
  readonly footprints: number;
  readonly pads: number;
  readonly nets: ReadonlyMap<string, readonly PcbPad[]>;
}

export interface PcbMismatch {
  readonly ref: string;
  readonly number: string;
  readonly pcbNet: string;
  readonly schematicNet: string;
}

export interface PcbCheckReport {
  /** 参与对账的 PCB 网络数（有名字、且至少两个焊盘能在原理图里找到）。 */
  readonly compared: number;
  /** 连通性完全一致的网络数。 */
  readonly matched: number;
  /** 被拆成多段的网络。 */
  readonly split: readonly { net: string; pins: readonly string[] }[];
  /** 焊盘级网络名不一致（名字不同但可能同网）。 */
  readonly nameMismatches: readonly PcbMismatch[];
  /** 原理图里有该引脚但 PCB 上没有对应焊盘（或反之）。 */
  readonly missingPads: readonly { ref: string; number: string }[];
  readonly summary: string;
}

function netNameOf(node: SExprNode[] | null): string {
  if (node === null) return "";
  const first = node[1];
  const second = node[2];
  const firstName = typeof first === "string" ? first : "";
  const secondName = typeof second === "string" ? second : "";
  // KiCad 10 写 (net "GND")，老版本写 (net 12 "GND")：首项不是数字时它才是网络名。
  if (firstName !== "" && !Number.isFinite(Number(firstName))) return firstName;
  return secondName;
}

function refOf(footprint: SExprNode[]): string {
  for (const property of childrenOf(footprint, "property")) {
    if (atomOf(property, 1) === "Reference") return atomOf(property, 2);
  }
  return "";
}

export function parsePcbText(text: string, file: string): PcbReport {
  const doc = parseSexpr(text);
  const nets = new Map<string, PcbPad[]>();
  let footprints = 0;
  let pads = 0;
  for (const footprint of childrenOf(doc, "footprint")) {
    footprints += 1;
    const ref = refOf(footprint);
    for (const pad of childrenOf(footprint, "pad")) {
      pads += 1;
      const number = atomOf(pad, 1);
      const net = netNameOf(childOf(pad, "net"));
      if (net === "" || net.startsWith("unconnected-")) continue;
      const list = nets.get(net) ?? [];
      list.push({ ref, number, net });
      nets.set(net, list);
    }
  }
  const version = numberOf(childOf(doc, "version"), 1);
  return {
    file,
    version: Number.isFinite(version) ? version : 0,
    generator: atomOf(childOf(doc, "generator"), 1),
    footprints,
    pads,
    nets,
  };
}

export function readPcb(file: string): PcbReport {
  return parsePcbText(readFileSync(file, "utf8"), file);
}

/** 去掉 KiCad 网络名的图纸路径前缀（`/col1/GND` → `GND`）。 */
export function normalizeNetName(name: string): string {
  return name.replace(/^\/[^/]+\//u, "");
}

interface PinNet {
  readonly name: string;
  readonly labels: readonly string[];
}

/** 原理图：`ref:number` → 网络名与它用到的标号。 */
function schematicPinNets(schematic: SchematicReport): Map<string, PinNet> {
  const out = new Map<string, PinNet>();
  for (const net of schematic.nets) {
    for (const pin of net.pins) {
      if (pin.ref === "") continue;
      const key = `${pin.ref}:${pin.number}`;
      if (!out.has(key)) out.set(key, { name: net.name, labels: net.labels });
    }
  }
  return out;
}

/**
 * 对账：以 PCB 网络为真值，检查同一条 PCB 网络上的焊盘在原理图里是否落在同一网络。
 */
export function crossCheckPcb(schematic: SchematicReport, pcb: PcbReport): PcbCheckReport {
  const pinNets = schematicPinNets(schematic);
  const split: { net: string; pins: string[] }[] = [];
  const nameMismatches: PcbMismatch[] = [];
  const seenMismatch = new Set<string>();
  let compared = 0;
  let matched = 0;
  for (const [net, pads] of pcb.nets) {
    if (pads.length < 2) continue;
    const resolved = pads
      .map((pad) => ({ pad, schematic: pinNets.get(`${pad.ref}:${pad.number}`) }))
      .filter((item): item is { pad: PcbPad; schematic: PinNet } => item.schematic !== undefined);
    if (resolved.length < 2) continue;
    compared += 1;
    const distinct = new Set(resolved.map((item) => item.schematic.name));
    if (distinct.size === 1) {
      matched += 1;
      const schematicNet = [...distinct][0] as string;
      // 两边都是自动名（原理图 N$n / PCB Net-(...)）时不报：没有标号，名字不可比。
      const pcbName = normalizeNetName(net);
      const labels = new Set(resolved.flatMap((item) => item.schematic.labels.map(normalizeNetName)));
      const named = !schematicNet.startsWith("N$") && !net.startsWith("Net-(");
      if (named && pcbName !== normalizeNetName(schematicNet) && !labels.has(pcbName)) {
        for (const item of resolved) {
          const key = `${item.pad.ref}:${item.pad.number}`;
          if (seenMismatch.has(key)) continue;
          seenMismatch.add(key);
          nameMismatches.push({ ref: item.pad.ref, number: item.pad.number, pcbNet: net, schematicNet });
        }
      }
    } else {
      split.push({ net, pins: resolved.map((item) => `${item.pad.ref}.${item.pad.number}=${item.schematic.name}`) });
    }
  }
  const pcbPads = new Set<string>();
  for (const pads of pcb.nets.values()) {
    for (const pad of pads) pcbPads.add(`${pad.ref}:${pad.number}`);
  }
  const missingPads = schematic.components
    .flatMap((component) => component.pins.map((pin) => ({ ref: component.ref, number: pin.number })))
    .filter((pin) => !pcbPads.has(`${pin.ref}:${pin.number}`))
    .slice(0, 40);
  return {
    compared,
    matched,
    split,
    nameMismatches: nameMismatches.slice(0, 40),
    missingPads,
    summary:
      `PCB 上有名字且能对上的网络 ${compared} 个：连通一致 ${matched} 个，` +
      `被拆开 ${split.length} 个，名字不一致 ${nameMismatches.length} 个`,
  };
}
