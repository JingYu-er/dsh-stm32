/**
 * 封装名归一化（S111）。
 *
 * tscircuit 导出的 `.kicad_pcb` 里，封装名是它自己的生成名（`tscircuit:resistor`、
 * `tscircuit:chip`），库名信息只存在于 `circuit.json` 的 `cad_component.model_step_url`：
 * `https://kicad-mod-cache.tscircuit.com/Resistor_SMD/R_0402_1005Metric.step`
 * 从中能还原出「真库名 : 真封装名」。这里把生成名换回真名，并把官方封装复制进
 * 工程的 `hardware/libs/footprints`，让别人拿到交付包也能按名字打开。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export interface CanonicalFootprint {
  /** 位号（`.kicad_pcb` 里 `(property "Reference" "R1")`）。 */
  readonly reference: string;
  /** 真库名，例如 `Resistor_SMD`。 */
  readonly lib: string;
  /** 真封装名，例如 `R_0402_1005Metric`。 */
  readonly name: string;
}

export interface CircuitFootprintIndex {
  readonly byReference: Map<string, { lib: string; name: string }>;
  /** 没有模型地址、还原不出的位号。 */
  readonly unresolved: string[];
}

const MODEL_LIB = /kicad-mod-cache\.tscircuit\.com\/[\d.]*\/?([^/]+)\/([^/.]+)\.(?:step|wrl)/iu;

/**
 * 从 `circuit.json` 还原「位号 → 真库名/真封装名」。
 *
 * 只用 `cad_component` 的模型地址：它由 `footprint="kicad:Lib/FP"` 直接决定。
 * 用 tscircuit 自己生成封装（`footprint="0402"`）时没有这个地址，这些位号归入 unresolved。
 */
export function readCanonicalFootprints(circuitJsonText: string): CircuitFootprintIndex {
  const byReference = new Map<string, { lib: string; name: string }>();
  const unresolved: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(circuitJsonText);
  } catch {
    return { byReference, unresolved };
  }
  if (!Array.isArray(parsed)) return { byReference, unresolved };

  const names = new Map<string, string>();
  const canonical = new Map<string, { lib: string; name: string }>();
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (record["type"] === "source_component") {
      const id = String(record["source_component_id"] ?? "");
      const name = String(record["name"] ?? "");
      if (id !== "" && name !== "") names.set(id, name);
    }
    if (record["type"] === "cad_component") {
      const sourceId = String(record["source_component_id"] ?? "");
      const url = String(record["model_step_url"] ?? record["model_wrl_url"] ?? "");
      const match = MODEL_LIB.exec(url);
      if (sourceId !== "" && match !== null) {
        canonical.set(sourceId, { lib: match[1] ?? "", name: match[2] ?? "" });
      }
    }
  }

  for (const [sourceId, name] of names) {
    const found = canonical.get(sourceId);
    if (found === undefined || found.lib === "" || found.name === "") {
      unresolved.push(name);
      continue;
    }
    byReference.set(name, found);
  }
  return { byReference, unresolved };
}

/** 按括号配对切成若干块（`kind` 例如 `footprint`）。 */
function blocks(text: string, kind: string): { start: number; end: number; body: string }[] {
  const found: { start: number; end: number; body: string }[] = [];
  const pattern = new RegExp(`\\(${kind}\\b`, "gu");
  let match = pattern.exec(text);
  while (match !== null) {
    const start = match.index;
    let depth = 0;
    let index = start;
    let inString = false;
    while (index < text.length) {
      const char = text[index] ?? "";
      if (inString) {
        if (char === "\\") index += 1;
        else if (char === '"') inString = false;
      } else if (char === '"') {
        inString = true;
      } else if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
      index += 1;
    }
    found.push({ start, end: index + 1, body: text.slice(start, index + 1) });
    match = pattern.exec(text);
  }
  return found;
}

export interface NormalizeReport {
  readonly ok: boolean;
  /** 换掉的封装（生成名 → 真库名:真封装名）。 */
  readonly renamed: readonly { from: string; to: string; reference: string }[];
  /** 仍是生成名的位号（tscircuit 自带封装，无法还原）。 */
  readonly unresolved: readonly string[];
  /** 已复制进工程库的官方封装数量。 */
  readonly copied: number;
  readonly notes: readonly string[];
}

const NAME_IN_BLOCK = /^\(footprint\s*\n?\s*"([^"]+)"/u;
const REFERENCE_IN_BLOCK = /\(property\s+"Reference"\s+"([^"]+)"/u;

/** 把 `.kicad_pcb` 里的生成封装名换回真库名（不写盘）。 */
export function normalizePcbFootprintNames(pcbText: string, index: CircuitFootprintIndex): { text: string; renamed: { from: string; to: string; reference: string }[]; unresolved: string[] } {
  const renamed: { from: string; to: string; reference: string }[] = [];
  const unresolved: string[] = [];
  let text = pcbText;
  // 从后往前替换，偏移不会失效。
  const list = blocks(pcbText, "footprint");
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const block = list[i];
    if (block === undefined) continue;
    const nameMatch = NAME_IN_BLOCK.exec(block.body);
    if (nameMatch === null) continue;
    const from = nameMatch[1] ?? "";
    if (!from.startsWith("tscircuit:")) continue;
    const reference = REFERENCE_IN_BLOCK.exec(block.body)?.[1] ?? "";
    const canonical = index.byReference.get(reference);
    if (canonical === undefined) {
      if (reference !== "") unresolved.push(reference);
      continue;
    }
    const to = canonical.lib + ":" + canonical.name;
    const replaced = block.body.replace(from, to);
    text = text.slice(0, block.start) + replaced + text.slice(block.end);
    renamed.push({ from, to, reference });
  }
  return { text, renamed, unresolved };
}

export interface NormalizeOptions {
  /** KiCad 官方封装库根（`share/kicad/footprints`）。 */
  readonly footprintRoot: string;
  /** 工程库目录（`hardware/libs/footprints`）。 */
  readonly libsDir: string;
}

/**
 * 归一化一个生成好的 KiCad 工程：改 `.kicad_pcb` 里的封装名，并把官方封装复制进工程库。
 *
 * 复制是为交付：别人拿到 `hardware/` 时，即使本机没装对应版本的 KiCad 库，
 * 工程自带的 `fp-lib-table` 也能按真名解析。
 */
export function normalizeKicadProject(kicadDir: string, circuitJsonText: string, options: NormalizeOptions): NormalizeReport {
  const notes: string[] = [];
  const index = readCanonicalFootprints(circuitJsonText);
  const pcbFile = readdirSync(kicadDir).find((name) => name.endsWith(".kicad_pcb"));
  if (pcbFile === undefined) {
    return { ok: false, renamed: [], unresolved: index.unresolved, copied: 0, notes: ["工程目录里没有 .kicad_pcb"] };
  }
  const pcbPath = join(kicadDir, pcbFile);
  const result = normalizePcbFootprintNames(readFileSync(pcbPath, "utf8"), index);
  if (result.renamed.length > 0) writeFileSync(pcbPath, result.text, "utf8");

  let copied = 0;
  for (const item of result.renamed) {
    const [lib, name] = [item.to.slice(0, item.to.indexOf(":")), item.to.slice(item.to.indexOf(":") + 1)];
    const source = join(options.footprintRoot, lib + ".pretty", name + ".kicad_mod");
    if (!existsSync(source)) {
      notes.push("本机 KiCad 库里没有 " + lib + ":" + name + "，交付包里不带这份封装");
      continue;
    }
    const targetDir = join(options.libsDir, lib + ".pretty");
    mkdirSync(targetDir, { recursive: true });
    const target = join(targetDir, name + ".kicad_mod");
    if (!existsSync(target)) {
      copyFileSync(source, target);
      copied += 1;
    }
  }
  if (result.renamed.length > 0) mergeFootprintTable(kicadDir, options.libsDir, result.renamed);
  return { ok: true, renamed: result.renamed, unresolved: result.unresolved, copied, notes };
}

/**
 * 把复制进工程的官方库登记到工程的 `fp-lib-table`。
 *
 * URI 用 `${KIPRJMOD}` 相对 KiCad 工程目录：交付包换机器、换盘符都能解析。
 */
function mergeFootprintTable(kicadDir: string, libsDir: string, renamed: readonly { to: string }[]): void {
  const table = join(kicadDir, "fp-lib-table");
  const libs = [...new Set(renamed.map((item) => item.to.slice(0, item.to.indexOf(":"))))].filter((lib) => lib !== "");
  const existing = existsSync(table) ? readFileSync(table, "utf8") : "(fp_lib_table\n)\n";
  let text = existing;
  for (const lib of libs) {
    if (text.includes('(name "' + lib + '")')) continue;
    const dir = join(libsDir, lib + ".pretty");
    const uri = "${KIPRJMOD}/" + relative(kicadDir, dir).replace(/\\/gu, "/");
    const entry = '  (lib (name "' + lib + '")(type "KiCad")(uri "' + uri + '")(options "")(descr ""))\n';
    text = text.replace(/\)\s*$/u, entry + ")\n");
  }
  writeFileSync(table, text, "utf8");
}
