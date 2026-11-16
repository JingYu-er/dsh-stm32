/**
 * S172：把 KiCad 里的改动吸收回 tscircuit 源。
 *
 * 口径（与用户确认过的 B 方案一致）：
 * - **源仍是 circuit.tsx**；KiCad 里画的图纸与板子只作为「改动的事实来源」。
 * - 吸收的是**元件清单与网络**（谁在、值是什么、哪些脚连在一起），不吸收坐标与画法——
 *   构建会重排布局，这一点每次都要在输出里说明，不能让人以为位置也被保留。
 * - 读的是 `.kicad_pcb`：人在 KiCad 里连线并 Update PCB 之后，板的网络就是事实；
 *   原理图与板子不一致时以板为准（S169 的门禁会另行提示图纸旧了）。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { parenBlocks } from "./pcb/emc.js";
import { parsePcbScene } from "./pcb/scene.js";

export interface ImportedPart {
  ref: string;
  /** 元件类型（resistor / capacitor / inductor / led / diode / 其他）。 */
  kind: string;
  /** 值字段（10kΩ、100nF、LED…）。 */
  value: string;
  /** 封装库名（`Lib:Name` 或 tscircuit 的内部名）。 */
  libId: string;
  /** tscircuit 用的封装写法（0402 / 0603 / kicad:Lib:Name）。 */
  footprint: string;
  suppliers: string[];
}

export interface ImportedNet {
  name: string;
  pins: { ref: string; pin: string }[];
}

export interface ImportState {
  ok: boolean;
  error: string;
  boardFile: string;
  widthMm: number;
  heightMm: number;
  parts: ImportedPart[];
  nets: ImportedNet[];
  notes: string[];
}

export interface ImportDiff {
  added: string[];
  removed: string[];
  changed: string[];
  previousParts: number;
  previousNets: number;
}

export interface ImportReport {
  ok: boolean;
  error: string;
  projectDir: string;
  sourceFile: string;
  written: boolean;
  state: ImportState;
  diff: ImportDiff;
  source: string;
  notes: string[];
}

/** 从 `Lib:Name` 或 tscircuit 内部名推一个 tscircuit 认的封装写法。 */
export function tscircuitFootprint(libId: string): string {
  const name = libId.toLowerCase();
  const metric = /(?:r|c|l|led|d|q)_(0201|0402|0603|0805|1206|1210|2010|2512)\b/u.exec(name);
  if (metric !== null) return metric[1] ?? "";
  const plain = /\b(0201|0402|0603|0805|1206)\b/u.exec(name);
  if (plain !== null) return plain[1] ?? "";
  const tail = /([a-z]*)_?(\d{4})(?:_|$)/u.exec(name);
  if (tail !== null && (tail[2] === "0402" || tail[2] === "0603" || tail[2] === "0805")) return tail[2];
  return "kicad:" + libId;
}

function kindOf(libId: string, value: string): string {
  const text = (libId + " " + value).toLowerCase();
  if (/resistor|\bres\b|r_\d{4}/u.test(text)) return "resistor";
  if (/capacitor|\bcap\b|c_\d{4}/u.test(text)) return "capacitor";
  if (/inductor|\bind\b|l_\d{4}/u.test(text)) return "inductor";
  if (/\bled\b/u.test(text)) return "led";
  if (/diode|\bd_\d{4}/u.test(text)) return "diode";
  return "other";
}

/** tscircuit 写的网络名是把两端引脚拼起来：`.R1 > .pin2 to .C1 > .pin1`。 */
const TRACE_NET = /^\.([^\s>]+)\s*>\s*\.([^\s]+)\s+to\s+\.([^\s>]+)\s*>\s*\.([^\s]+)$/u;

type PinKey = string;

/** 并查集：把「同一条线上的脚」合成一个网络。 */
class Unions {
  private readonly parent = new Map<PinKey, PinKey>();

  find(key: PinKey): PinKey {
    const parent = this.parent.get(key);
    if (parent === undefined || parent === key) {
      this.parent.set(key, key);
      return key;
    }
    const root = this.find(parent);
    this.parent.set(key, root);
    return root;
  }

  union(left: PinKey, right: PinKey): void {
    const a = this.find(left);
    const b = this.find(right);
    if (a !== b) this.parent.set(a, b);
  }

  groups(): Map<PinKey, PinKey[]> {
    const out = new Map<PinKey, PinKey[]>();
    for (const key of this.parent.keys()) {
      const root = this.find(key);
      const list = out.get(root) ?? [];
      list.push(key);
      out.set(root, list);
    }
    return out;
  }
}

/** 把网络名里的引脚写法（`.pin2`、`.anode`）解析成焊盘编号。 */
function pinNumberOf(token: string, aliases: Map<string, string>): string {
  const numeric = /^pin(\d+)$/u.exec(token);
  if (numeric !== null) return numeric[1] ?? "";
  return aliases.get(token) ?? "";
}

/** 封装名里带了逻辑脚名与编号的对应（`anodepin2_cathodepin1`），用它把 anode 映射成 2。 */
function pinAliases(libId: string): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const match of libId.toLowerCase().matchAll(/([a-z_]+?)pin(\d+)/gu)) {
    const name = (match[1] ?? "").replace(/^_+/u, "");
    const number = match[2] ?? "";
    if (name !== "" && number !== "") aliases.set(name, number);
  }
  return aliases;
}

/** 从板子上把「哪些脚连在一起」读出来：先认 tscircuit 的 `A to B` 网络名，再按网络名或网络编号分组。 */
function readNets(pcbText: string): ImportedNet[] {
  const unions = new Unions();
  const byName = new Map<string, PinKey[]>();
  const allAliases = new Map<string, Map<string, string>>();
  for (const footprint of parenBlocks(pcbText, "footprint")) {
    const ref = /\(property\s+"Reference"\s+"([^"]+)"/u.exec(footprint)?.[1] ?? "";
    const libId = /^\(footprint\s+"([^"]+)"/u.exec(footprint)?.[1] ?? "";
    if (ref !== "") allAliases.set(ref, pinAliases(libId));
  }
  for (const footprint of parenBlocks(pcbText, "footprint")) {
    const ref = /\(property\s+"Reference"\s+"([^"]+)"/u.exec(footprint)?.[1] ?? "";
    if (ref === "") continue;
    const libId = /^\(footprint\s+"([^"]+)"/u.exec(footprint)?.[1] ?? "";
    const aliases = pinAliases(libId);
    for (const pad of parenBlocks(footprint, "pad")) {
      const pin = /^\(pad\s+"([^"]*)"/u.exec(pad)?.[1] ?? "";
      if (pin === "") continue;
      const numbered = /\(net\s+(\d+)(?:\s+"([^"]*)")?/u.exec(pad);
      const namedOnly = numbered === null ? /\(net\s+"([^"]*)"/u.exec(pad) : null;
      if (numbered === null && namedOnly === null) continue;
      const name = numbered === null ? (namedOnly?.[1] ?? "") : (numbered[2] ?? "");
      const code = numbered === null ? "" : (numbered[1] ?? "");
      const key = ref + "." + pin;
      unions.find(key);
      const trace = TRACE_NET.exec(name);
      if (trace !== null) {
        const leftRef = trace[1] ?? "";
        const leftPin = pinNumberOf(trace[2] ?? "", allAliases.get(leftRef) ?? new Map<string, string>());
        const rightRef = trace[3] ?? "";
        const rightPin = pinNumberOf(trace[4] ?? "", allAliases.get(rightRef) ?? new Map<string, string>());
        if (leftRef !== "" && leftPin !== "") unions.union(key, leftRef + "." + leftPin);
        if (rightRef !== "" && rightPin !== "") unions.union(key, rightRef + "." + rightPin);
        continue;
      }
      const label = name !== "" ? name : code === "" || code === "0" ? "" : "#" + code;
      if (label === "") continue;
      const list = byName.get(label) ?? [];
      list.push(key);
      byName.set(label, list);
    }
  }
  for (const pins of byName.values()) {
    const first = pins[0];
    if (first === undefined) continue;
    for (const pin of pins.slice(1)) unions.union(first, pin);
  }
  const named = new Map<string, string>();
  for (const [name, pins] of byName.entries()) {
    if (name.startsWith("#")) continue;
    for (const pin of pins) {
      const root = unions.find(pin);
      if (!named.has(root)) named.set(root, name);
    }
  }
  const nets: ImportedNet[] = [];
  for (const [root, pins] of unions.groups().entries()) {
    if (pins.length < 2) continue;
    const split = pins.map((pin) => {
      const dot = pin.indexOf(".");
      return { ref: pin.slice(0, dot), pin: pin.slice(dot + 1) };
    });
    split.sort((left, right) => left.ref.localeCompare(right.ref, "en") || left.pin.localeCompare(right.pin, "en"));
    nets.push({ name: named.get(root) ?? "", pins: split });
  }
  nets.sort((left, right) => (left.name === right.name ? 0 : left.name < right.name ? -1 : 1));
  return nets;
}

const START_POINT = /\(start\s+(-?[\d.]+)\s+(-?[\d.]+)\)/u;
const END_POINT = /\(end\s+(-?[\d.]+)\s+(-?[\d.]+)\)/u;

/** 从板框线段算板子尺寸：只认 Edge.Cuts 上的 gr_line。 */
function boardSize(pcbText: string): { widthMm: number; heightMm: number } {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const line of parenBlocks(pcbText, "gr_line")) {
    const start = START_POINT.exec(line);
    const end = END_POINT.exec(line);
    if (start === null || end === null || !/Edge\.Cuts/u.test(line)) continue;
    for (const [x, y] of [
      [Number(start[1] ?? "0"), Number(start[2] ?? "0")],
      [Number(end[1] ?? "0"), Number(end[2] ?? "0")],
    ] as [number, number][]) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return { widthMm: 0, heightMm: 0 };
  return { widthMm: Math.round((maxX - minX) * 10) / 10, heightMm: Math.round((maxY - minY) * 10) / 10 };
}

/** 读板子，得到「谁在、值是什么、哪些脚连在一起」。 */
export function readImportState(boardFile: string, readText: (file: string) => string = (file) => readFileSync(file, "utf8")): ImportState {
  const empty: ImportState = { ok: false, error: "", boardFile, widthMm: 0, heightMm: 0, parts: [], nets: [], notes: [] };
  if (boardFile === "" || !existsSync(boardFile)) return { ...empty, error: "找不到板子文件：" + (boardFile === "" ? "没有最近一次构建的 .kicad_pcb" : boardFile) };
  let text: string;
  try {
    text = readText(boardFile);
  } catch (error) {
    return { ...empty, error: "读不到板子文件：" + (error instanceof Error ? error.message : String(error)) };
  }
  if (!text.includes("(kicad_pcb")) return { ...empty, error: "这不是一个 .kicad_pcb：文件里没有 (kicad_pcb 块" };

  const parts: ImportedPart[] = [];
  for (const block of parenBlocks(text, "footprint")) {
    const ref = /\(property\s+"Reference"\s+"([^"]+)"/u.exec(block)?.[1] ?? "";
    if (ref === "") continue;
    const value = /\(property\s+"Value"\s+"([^"]+)"/u.exec(block)?.[1] ?? "";
    const libId = /^\(footprint\s+"([^"]+)"/u.exec(block)?.[1] ?? "";
    const suppliers = (/\(property\s+"Supplier Part Number"\s+"([^"]+)"/u.exec(block)?.[1] ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => /^C\d+$/u.test(item));
    parts.push({ ref, kind: kindOf(libId, value), value, libId, footprint: tscircuitFootprint(libId), suppliers });
  }
  const netList = readNets(text);

  parts.sort((left, right) => left.ref.localeCompare(right.ref, "en"));
  const size = boardSize(text);
  const notes: string[] = [];
  const unknown = parts.filter((part) => part.kind === "other");
  if (unknown.length > 0) notes.push("有 " + String(unknown.length) + " 个元件类型不认识：" + unknown.map((part) => part.ref).join(", ") + "（不会写进 circuit.tsx）");
  if (netList.length === 0) notes.push("板子上没有命名的网络：连好线并 Update PCB 之后再来吸收。");
  return { ok: true, error: "", boardFile, widthMm: size.widthMm, heightMm: size.heightMm, parts, nets: netList, notes };
}

function valueAttr(part: ImportedPart): string {
  const value = part.value.replace(/Ω$/u, "").trim();
  switch (part.kind) {
    case "resistor": return part.value === "" ? "" : ' resistance="' + value + '"';
    case "capacitor": return part.value === "" ? "" : ' capacitance="' + value + '"';
    case "inductor": return part.value === "" ? "" : ' inductance="' + value + '"';
    default: return "";
  }
}

/** 二极管类的逻辑脚名要显式告诉 tscircuit，否则极性校验会拒（anode/cathode 与编号的对应在封装名里）。 */
function pinLabelsFor(part: ImportedPart): string {
  const aliases = pinAliases(part.libId);
  if (aliases.size === 0) return "";
  const pairs = [...aliases.entries()]
    .map(([name, number]) => [number, name] as [string, string])
    .sort((left, right) => Number(left[0]) - Number(right[0]));
  if (pairs.length === 0) return "";
  const body = pairs.map(([number, name]) => '"pin' + number + '": "' + name + '"').join(", ");
  return " pinLabels={{ " + body + " }}";
}

/** 生成新的 circuit.tsx：元件清单与网络来自 KiCad；坐标不写，构建时重排。 */
export function renderCircuitSource(state: ImportState): string {
  const lines: string[] = [];
  lines.push("// 由 dsh-stm32 从 KiCad 工程吸收（S172）。");
  lines.push("// 元件与网络以 KiCad 为准；坐标与画法不保留，构建时会重新排布。");
  lines.push("export default () => (");
  const size = state.widthMm > 0 && state.heightMm > 0 ? ' width="' + String(state.widthMm) + 'mm" height="' + String(state.heightMm) + 'mm"' : "";
  lines.push("  <board" + size + ">");
  for (const part of state.parts) {
    if (part.kind === "other") continue;
    const suppliers =
      part.suppliers.length === 0
        ? ""
        : ' supplierPartNumbers={{ jlcpcb: ["' + part.suppliers.join('", "') + '"] }}';
    lines.push(
      "    <" + part.kind + ' name="' + part.ref + '"' + valueAttr(part) + ' footprint="' + part.footprint + '"' + suppliers + pinLabelsFor(part) + " />",
    );
  }
  for (const net of state.nets) {
    if (net.pins.length < 2) continue;
    for (let index = 1; index < net.pins.length; index += 1) {
      const from = net.pins[index - 1];
      const to = net.pins[index];
      if (from === undefined || to === undefined) continue;
      lines.push('    <trace from=".' + from.ref + " > .pin" + from.pin + '" to=".' + to.ref + " > .pin" + to.pin + '" />');
    }
  }
  lines.push("  </board>");
  lines.push(");");
  return lines.join("\n") + "\n";
}

/** 与上一次构建的 circuit.json 比：谁新增、谁没了、哪个改值了。 */
export function diffImport(state: ImportState, circuitJsonText: string): ImportDiff {
  const previousParts: { name: string; value: string }[] = [];
  let previousNets = 0;
  if (circuitJsonText !== "") {
    try {
      const parsed = JSON.parse(circuitJsonText) as unknown;
      const items = Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
      for (const item of items) {
        if (item["type"] === "source_component" && typeof item["name"] === "string") {
          previousParts.push({ name: item["name"], value: typeof item["value"] === "string" ? item["value"] : "" });
        }
        if (item["type"] === "source_net" && typeof item["name"] === "string" && item["name"] !== "") previousNets += 1;
      }
    } catch {
      // 毁掉的 circuit.json 就当没有：只说新增，不猜删除。
    }
  }
  const previous = new Map(previousParts.map((part) => [part.name, normalizeValue(part.value)]));
  const current = new Map(state.parts.map((part) => [part.ref, normalizeValue(part.value)]));
  const added = [...current.keys()].filter((ref) => !previous.has(ref)).sort();
  const removed = [...previous.keys()].filter((ref) => !current.has(ref)).sort();
  const changed = [...current.keys()]
    .filter((ref) => previous.has(ref) && previous.get(ref) !== current.get(ref))
    .sort()
    .map((ref) => ref + "：" + (previous.get(ref) ?? "") + " → " + (current.get(ref) ?? ""));
  return { added, removed, changed, previousParts: previousParts.length, previousNets };
}

/** 比较值之前去掉单位后缀：`10kΩ` 与 `10k` 是同一个值。 */
function normalizeValue(value: string): string {
  return value.replace(/[Ωμu]?F$/u, "").replace(/Ω$/u, "").trim().toLowerCase();
}

/** 读板子 → 比对 → 生成新源；write 才落盘（先留 .bak）。 */
export function absorbFromKicad(
  projectDir: string,
  options: { boardFile: string; sourceFile: string; circuitJsonFile?: string; write?: boolean; readText?: (file: string) => string; writeText?: (file: string, text: string) => void },
): ImportReport {
  const readText = options.readText ?? ((file: string) => readFileSync(file, "utf8"));
  const writeText = options.writeText ?? ((file: string, text: string) => writeFileSync(file, text, "utf8"));
  const state = readImportState(options.boardFile, readText);
  const empty: ImportReport = {
    ok: false,
    error: state.error,
    projectDir,
    sourceFile: options.sourceFile,
    written: false,
    state,
    diff: { added: [], removed: [], changed: [], previousParts: 0, previousNets: 0 },
    source: "",
    notes: state.notes,
  };
  if (!state.ok) return empty;
  let circuitJsonText = "";
  if (options.circuitJsonFile !== undefined && options.circuitJsonFile !== "" && existsSync(options.circuitJsonFile)) {
    try {
      circuitJsonText = readText(options.circuitJsonFile);
    } catch {
      circuitJsonText = "";
    }
  }
  const diff = diffImport(state, circuitJsonText);
  const source = renderCircuitSource(state);
  let written = false;
  if (options.write === true) {
    if (existsSync(options.sourceFile)) {
      const backup = options.sourceFile + ".bak";
      try {
        writeText(backup, readText(options.sourceFile));
      } catch {
        // 备份失败就不写，宁可不改也不丢原文。
        return { ...empty, ok: false, error: "备份失败，没有改动 " + options.sourceFile, diff, source };
      }
    }
    writeText(options.sourceFile, source);
    written = true;
  }
  const notes = [...state.notes];
  if (state.widthMm > 0) notes.push("板框 " + String(state.widthMm) + " × " + String(state.heightMm) + " mm（写进 board 尺寸，坐标不保留）");
  notes.push("元件 " + String(state.parts.length) + " 个、命名网络 " + String(state.nets.length) + " 条");
  return { ok: true, error: "", projectDir, sourceFile: options.sourceFile, written, state, diff, source, notes };
}
