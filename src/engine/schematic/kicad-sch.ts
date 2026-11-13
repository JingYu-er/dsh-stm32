/**
 * KiCad 10 原理图读取：把 `.kicad_sch` 拆成「图纸 → 符号实例 / 导线 / 标号 / 结点」。
 *
 * 只解析电气相关的节点，图形元素（矩形、文本、位图）直接丢弃：画不画得好看不是这一层的事。
 * 符号的引脚定义来自文件内嵌的 `lib_symbols`，所以读原理图不需要本机装 KiCad，
 * 也不依赖 `sym-lib-table` 指向的符号库是否还在。
 *
 * 版本口径：只在 KiCad 10（`version 20260306`）上验证；其它版本照常解析，
 * 但由上层给出「未验证版本」告警，不做版本分支适配。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { atomOf, childOf, childrenOf, headOf, numberOf, parseSexpr, type SExprNode } from "./sexpr.js";

export interface SchPoint {
  readonly x: number;
  readonly y: number;
}

/** 库符号里的一条引脚定义：`x / y` 是电气连接点（库坐标，+y 向上）。 */
export interface SchLibPin {
  readonly number: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly kind: string;
  /** 所属符号单元（0 = 公共单元）。 */
  readonly unit: number;
}

export interface SchSymbol {
  readonly ref: string;
  readonly value: string;
  readonly libId: string;
  readonly footprint: string;
  readonly at: SchPoint;
  readonly rot: number;
  readonly mirror: "x" | "y" | null;
  readonly unit: number;
  readonly dnp: boolean;
  /** 电源符号（`lib_id` 以 `power:` 开头，引用号 `#PWR*`）。 */
  readonly isPower: boolean;
}

export interface SchWire {
  readonly a: SchPoint;
  readonly b: SchPoint;
}

export type SchLabelKind = "label" | "global_label" | "hierarchical_label";

export interface SchLabel {
  readonly kind: SchLabelKind;
  readonly name: string;
  readonly at: SchPoint;
}

export interface SchSheetRef {
  readonly name: string;
  readonly file: string;
}

export interface SchFile {
  /** 绝对路径。 */
  readonly file: string;
  /** 相对工程根目录的路径，报告里用这个。 */
  readonly relFile: string;
  readonly name: string;
  readonly paper: string;
  readonly version: number;
  readonly generator: string;
  readonly symbols: readonly SchSymbol[];
  readonly wires: readonly SchWire[];
  readonly labels: readonly SchLabel[];
  readonly noConnects: readonly SchPoint[];
  readonly junctions: readonly SchPoint[];
  readonly sheetRefs: readonly SchSheetRef[];
  readonly libPins: ReadonlyMap<string, readonly SchLibPin[]>;
}

export interface SchTree {
  readonly rootFile: string;
  readonly rootName: string;
  readonly sheets: readonly SchFile[];
  readonly warnings: readonly string[];
}

function pointOf(node: SExprNode | null | undefined): SchPoint | null {
  const at = Array.isArray(node) ? node : null;
  if (at === null) return null;
  const x = numberOf(at, 1);
  const y = numberOf(at, 2);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function propertyMap(node: SExprNode): Map<string, string> {
  const out = new Map<string, string>();
  for (const property of childrenOf(node, "property")) {
    const name = atomOf(property, 1);
    const value = atomOf(property, 2);
    if (name !== "") out.set(name, value);
  }
  return out;
}

/** 符号单元名（`Device_R_1_1`）末尾的 `_unit_style`：引脚只属于某个单元。 */
function unitOfName(name: string): number {
  const match = /_(\d+)_(\d+)$/u.exec(name);
  return match === null ? 0 : Number(match[1]);
}

function readLibPins(doc: SExprNode): Map<string, SchLibPin[]> {
  const out = new Map<string, SchLibPin[]>();
  const libs = childOf(doc, "lib_symbols");
  for (const lib of childrenOf(libs, "symbol")) {
    const name = atomOf(lib, 1);
    if (name === "") continue;
    const pins: SchLibPin[] = [];
    const units = childrenOf(lib, "symbol");
    const collect = (container: SExprNode[], unit: number): void => {
      for (const pin of childrenOf(container, "pin")) {
        const at = childOf(pin, "at");
        const x = numberOf(at, 1);
        const y = numberOf(at, 2);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        pins.push({
          number: atomOf(childOf(pin, "number"), 1),
          name: atomOf(childOf(pin, "name"), 1),
          x,
          y,
          kind: atomOf(pin, 1),
          unit,
        });
      }
    };
    for (const unit of units) {
      collect(unit, unitOfName(atomOf(unit, 1)));
    }
    collect(lib, 0);
    out.set(name, pins);
  }
  return out;
}

function readSymbol(node: SExprNode[], relDir: string): SchSymbol | null {
  const libId = atomOf(childOf(node, "lib_id"), 1);
  if (libId === "") return null;
  const at = childOf(node, "at");
  const position = pointOf(at) ?? { x: 0, y: 0 };
  const rot = numberOf(at, 3);
  const mirrorNode = childOf(node, "mirror");
  const mirrorRaw = atomOf(mirrorNode, 1);
  const mirror = mirrorRaw === "x" || mirrorRaw === "y" ? mirrorRaw : null;
  const properties = propertyMap(node);
  const ref = properties.get("Reference") ?? "";
  const unit = numberOf(childOf(node, "unit"), 1);
  const dnpNode = childOf(node, "dnp");
  const dnp = atomOf(dnpNode, 1) === "yes";
  void relDir;
  return {
    ref,
    value: properties.get("Value") ?? "",
    libId,
    footprint: properties.get("Footprint") ?? "",
    at: position,
    rot: Number.isFinite(rot) ? rot : 0,
    mirror,
    unit: Number.isFinite(unit) ? unit : 1,
    dnp,
    isPower: libId.startsWith("power:"),
  };
}

/** 解析一张图纸。`relFile` 只用于报告，不影响解析。 */
export function parseSchText(text: string, file: string, relFile = file): SchFile {
  const doc = parseSexpr(text);
  if (headOf(doc) !== "kicad_sch") throw new Error("文件不是 KiCad 原理图（顶层不是 kicad_sch）");

  const symbols: SchSymbol[] = [];
  for (const node of childrenOf(doc, "symbol")) {
    const symbol = readSymbol(node, dirname(relFile));
    if (symbol !== null) symbols.push(symbol);
  }

  const wires: SchWire[] = [];
  for (const wire of childrenOf(doc, "wire")) {
    const xy = childrenOf(childOf(wire, "pts"), "xy");
    const a = pointOf(xy[0]);
    const b = pointOf(xy[1]);
    if (a !== null && b !== null) wires.push({ a, b });
  }

  const labels: SchLabel[] = [];
  for (const kind of ["label", "global_label", "hierarchical_label"] as const) {
    for (const label of childrenOf(doc, kind)) {
      const name = atomOf(label, 1);
      const at = pointOf(childOf(label, "at"));
      if (name !== "" && at !== null) labels.push({ kind, name, at });
    }
  }

  const noConnects: SchPoint[] = [];
  for (const marker of childrenOf(doc, "no_connect")) {
    const at = pointOf(childOf(marker, "at"));
    if (at !== null) noConnects.push(at);
  }

  const junctions: SchPoint[] = [];
  for (const junction of childrenOf(doc, "junction")) {
    const at = pointOf(childOf(junction, "at"));
    if (at !== null) junctions.push(at);
  }

  const sheetRefs: SchSheetRef[] = [];
  for (const sheet of childrenOf(doc, "sheet")) {
    const properties = propertyMap(sheet);
    const name = properties.get("Sheetname") ?? "";
    const sheetFile = properties.get("Sheetfile") ?? "";
    if (sheetFile !== "") sheetRefs.push({ name, file: sheetFile });
  }

  const version = numberOf(childOf(doc, "version"), 1);
  return {
    file,
    relFile,
    name: propertiesOf(doc).get("Title") ?? "",
    paper: atomOf(childOf(doc, "paper"), 1),
    version: Number.isFinite(version) ? version : 0,
    generator: atomOf(childOf(doc, "generator"), 1),
    symbols,
    wires,
    labels,
    noConnects,
    junctions,
    sheetRefs,
    libPins: readLibPins(doc),
  };
}

/** 只取图纸的 `title_block` 标题（`(title_block (title "..."))`）。 */
function propertiesOf(doc: SExprNode[]): Map<string, string> {
  const out = new Map<string, string>();
  const block = childOf(doc, "title_block");
  const title = atomOf(childOf(block, "title"), 1);
  if (title !== "") out.set("Title", title);
  return out;
}

/**
 * 从根图纸递归读取所有子图纸。
 *
 * 只跟随 `sheet` 引用，不扫描目录：工程里常见的 `col2.kicad_sch`、`.history/` 下的旧版本
 * 都不在根表里，属于历史文件，不能当成电路的一部分。
 */
export function readSchTree(rootFile: string): SchTree {
  if (!existsSync(rootFile)) throw new Error(`原理图不存在：${rootFile}`);
  const baseDir = dirname(rootFile);
  const root = parseSchText(readFileSync(rootFile, "utf8"), rootFile, relative(baseDir, rootFile));
  const sheets: SchFile[] = [root];
  const warnings: string[] = [];
  const seen = new Set<string>([resolve(rootFile)]);
  const queue: string[] = [];
  for (const ref of root.sheetRefs) queue.push(ref.file);
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    const absolute = resolve(baseDir, next);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    if (!existsSync(absolute)) {
      warnings.push(`子图纸文件不存在：${next}`);
      continue;
    }
    const parsed = parseSchText(readFileSync(absolute, "utf8"), absolute, relative(baseDir, absolute));
    sheets.push(parsed);
    for (const ref of parsed.sheetRefs) queue.push(resolve(dirname(absolute), ref.file));
  }
  return { rootFile, rootName: root.relFile, sheets, warnings };
}
