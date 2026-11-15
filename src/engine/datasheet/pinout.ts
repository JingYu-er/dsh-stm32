import type { PdfTable } from "../pdf/tables.js";
import { extractPdfTables } from "../pdf/reader.js";
import type { PopplerTools } from "../pdf/toolchain.js";
import type { SubprocessService } from "../../types.js";

/**
 * 厂商手册里的引脚表（S123）。
 *
 * CubeMX 器件库给的是「这个脚能做哪些复用功能」，厂商手册的引脚表给的是
 * 「这个脚在数据手册里怎么描述」。两者对不上时以器件库为准，但器件库缺这颗
 * 芯片（或某个脚没有信号）时，手册的引脚表是唯一能查的地方。
 */

export interface DatasheetPin {
  /** 手册里的引脚名，已规范成 PA5 这种写法。 */
  name: string;
  /** 别名或脚号（有的手册写 "PA5/ADC_IN5"）。 */
  aliases: string[];
  /** 复用功能与附加功能里的符号，如 SPI1_SCK、TIM2_CH1。 */
  functions: string[];
  /** 出自哪张表、第几页。 */
  page: number;
  table: string;
}

export interface PinoutReport {
  ok: boolean;
  error: string;
  pins: DatasheetPin[];
  /** 认出的引脚表（表名与列名），供人核对。 */
  tables: { page: number; title: string; columns: string[] }[];
  notes: string[];
}

const PIN_NAME = /^P[A-Z]\d{1,2}$/u;
const PIN_HEADER = /^(?:pin\s*(?:name|number|no\.?)?|symbol|name|引脚|引脚名)$/iu;
const FUNC_HEADER = /(?:alternate|additional|function|remap|复用|附加)/iu;
const FUNCTION_TOKEN = /^[A-Z][A-Z0-9]*(?:[_-][A-Z0-9]+)*$/u;
const AF_PREFIX = /^(?:AF\d+|ALT\d*)[:_\s-]*/iu;

/** 引脚名可能写成 "PB9-BOOT0" 或 "PA5/ADC_IN5"：取第一段做名字，其余进别名。 */
function nameParts(value: string): { name: string; aliases: string[] } {
  const parts = value
    .split(/[\s/,-]+/u)
    .map((part) => part.replace(/[^\w]/gu, "").toUpperCase())
    .filter((part) => part !== "");
  return { name: parts[0] ?? "", aliases: parts.slice(1) };
}

function cleanName(value: string): string {
  return nameParts(value).name;
}

function tokensOfCell(cell: string): string[] {
  const out: string[] = [];
  for (const raw of cell.split(/[\s,;/]+/u)) {
    const token = raw.replace(AF_PREFIX, "").replace(/[^\w]/gu, "");
    if (token === "" || token.length < 3 || token.length > 24) continue;
    if (!FUNCTION_TOKEN.test(token)) continue;
    if (!/\d/u.test(token)) continue;
    if (out.includes(token)) continue;
    out.push(token);
  }
  return out;
}

/** 从一张表里认出「引脚列」与「功能列」，读不出就返回 null。 */
function readTable(table: PdfTable): { pin: number; funcs: number[] } | null {
  const header = table.cells[0];
  if (header === undefined) return null;
  let pin = -1;
  const funcs: number[] = [];
  header.forEach((cell, index) => {
    if (pin < 0 && PIN_HEADER.test(cell.trim())) pin = index;
    else if (FUNC_HEADER.test(cell)) funcs.push(index);
  });
  if (pin < 0 || funcs.length === 0) return null;
  return { pin, funcs };
}

/** 把若干张表里的引脚行合并成一张「脚 → 功能」表。 */
export function readPinoutTables(tables: readonly PdfTable[]): PinoutReport {
  const pins = new Map<string, DatasheetPin>();
  const used: PinoutReport["tables"] = [];
  for (const table of tables) {
    const columns = readTable(table);
    if (columns === null) continue;
    used.push({ page: table.page, title: table.title, columns: table.columns });
    for (const row of table.cells.slice(1)) {
      const rawName = row[columns.pin] ?? "";
      const name = cleanName(rawName);
      if (!PIN_NAME.test(name)) continue;
      const aliases = nameParts(rawName).aliases.filter((part) => part !== name);
      const functions: string[] = [];
      for (const index of columns.funcs) {
        for (const token of tokensOfCell(row[index] ?? "")) {
          if (!functions.includes(token)) functions.push(token);
        }
      }
      const existing = pins.get(name);
      if (existing === undefined) {
        pins.set(name, { name, aliases, functions, page: table.page, table: table.title });
        continue;
      }
      for (const token of functions) if (!existing.functions.includes(token)) existing.functions.push(token);
      for (const alias of aliases) if (!existing.aliases.includes(alias)) existing.aliases.push(alias);
    }
  }
  const notes: string[] = [];
  if (pins.size === 0) notes.push("没有认出引脚表：需要表头含「Pin / Pin name / Symbol」与「Alternate / Additional / Function」两列");
  const withFunctions = [...pins.values()].filter((pin) => pin.functions.length > 0).length;
  if (pins.size > 0) notes.push(pins.size + " 个引脚，其中 " + String(withFunctions) + " 个带复用功能");
  return { ok: pins.size > 0, error: pins.size === 0 ? notes[0] ?? "" : "", pins: [...pins.values()], tables: used, notes };
}

/** 引脚名 → 功能清单，交给 sch_to_ioc 在器件库缺信号时兜底。 */
export function pinFunctionIndex(report: PinoutReport): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const pin of report.pins) {
    if (pin.functions.length === 0) continue;
    map.set(pin.name, [...pin.functions]);
    for (const alias of pin.aliases) if (!map.has(alias)) map.set(alias, [...pin.functions]);
  }
  return map;
}

/**
 * 从缓存里的手册读引脚表。
 *
 * 引脚表通常在手册前部（Pinout and pin description），这里只翻前 16 页：
 * 再往后是电气特性与封装图，翻多了慢且容易把别的表当引脚表。
 */
export async function readDatasheetPinout(
  subprocess: SubprocessService,
  tools: PopplerTools,
  file: string,
  options: { first?: number; last?: number } = {},
  signal?: AbortSignal,
): Promise<PinoutReport> {
  const tables = await extractPdfTables(subprocess, tools, file, { first: options.first ?? 1, last: options.last ?? 16 }, signal);
  if (!tables.ok) return { ok: false, error: tables.error, pins: [], tables: [], notes: tables.notes };
  const report = readPinoutTables(tables.tables);
  return { ...report, notes: [...report.notes, ...tables.notes] };
}
