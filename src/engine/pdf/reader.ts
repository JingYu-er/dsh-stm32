/**
 * PDF 读取（S117）：把一份 PDF 摊成三种可核对的东西。
 *
 *   1. 元信息   —— pdfinfo：页数、纸张大小、是否加密、是否带文字层；
 *   2. 文字     —— pdftotext（-layout 保版面，-f/-l 限定页）：章节标题、表格、参数都靠它；
 *   3. 页面图像 —— pdftoppm：整页或局部渲染成 PNG，交给视觉读图（曲线、框图、丝印）。
 *
 * 不在这里做的事：把曲线数字化。渲染出来的像素由读图的一方解释，本模块只保证
 * 「给的是真实页面上那一块」，不猜坐标。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import type { SubprocessService } from "../../types.js";
import { runCapture } from "../subprocess-runner.js";
import type { PopplerTools } from "./toolchain.js";
import { extractTablesFromWords, parseBboxXml, type PdfTable } from "./tables.js";
import { decodePng } from "./png.js";
import { calibrateFromWords, chromaBounds, digitizeCurves, legendLabels } from "./curve.js";
import { readPdfSchematicWords, type PdfSchematic } from "./schematic.js";

export interface PdfInfo {
  ok: boolean;
  error: string;
  file: string;
  bytes: number;
  pages: number;
  title: string;
  producer: string;
  pageSize: string;
  encrypted: boolean;
  /** 有没有可用文字层：false 说明正文是描边字形（KiCad 默认导出的那种）。 */
  hasTextLayer: boolean;
  notes: string[];
}

export interface PdfText {
  ok: boolean;
  error: string;
  file: string;
  first: number;
  last: number;
  chars: number;
  /** 每条是「第 N 页」开头，便于定位。 */
  pages: { page: number; text: string }[];
  notes: string[];
}

export interface PdfRender {
  ok: boolean;
  error: string;
  file: string;
  page: number;
  dpi: number;
  imageFile: string;
  width: number;
  height: number;
  bytes: number;
  notes: string[];
}

export interface FigureRef {
  number: string;
  title: string;
  /** 目录行末尾的页码；正文里的图注没有页码时为 0。 */
  page: number;
}

function numberFrom(text: string, key: string): string {
  const match = new RegExp("^" + key + ":\\s*(.+)$", "mu").exec(text);
  return match === null ? "" : (match[1] ?? "").trim();
}

/** 页面文字里的控制字符比例：描边字体导出的 PDF 正文是 \u0001 这类码位。 */
function looksLikeGlyphCodes(text: string): boolean {
  if (text.trim() === "") return true;
  let control = 0;
  let total = 0;
  for (const char of text) {
    total += 1;
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 && char !== "\n" && char !== "\r" && char !== "\t") control += 1;
  }
  return total > 0 && control / total > 0.2;
}

export async function readPdfInfo(
  subprocess: SubprocessService,
  tools: PopplerTools,
  file: string,
  signal?: AbortSignal,
): Promise<PdfInfo> {
  const blank = {
    ok: false,
    file,
    bytes: 0,
    pages: 0,
    title: "",
    producer: "",
    pageSize: "",
    encrypted: false,
    hasTextLayer: true,
    notes: [] as string[],
  };
  if (!existsSync(file)) return { ...blank, error: "PDF 不存在：" + file };
  const size = statSync(file).size;
  const info = await runCapture(subprocess, {
    argv: [tools.pdfinfo, file],
    timeoutMs: 30_000,
    ...(signal === undefined ? {} : { signal }),
  });
  if (info.exitCode !== 0) {
    return { ...blank, bytes: size, error: "pdfinfo 执行失败：" + (info.stderr.trim() || String(info.exitCode)) };
  }
  const pages = Number(numberFrom(info.stdout, "Pages"));
  const notes: string[] = [];
  // 抽查第一页的文字层：只跑一页，避免整本转文本。
  const probe = await runCapture(subprocess, {
    argv: [tools.pdftotext, "-f", "1", "-l", "1", file, "-"],
    timeoutMs: 30_000,
    ...(signal === undefined ? {} : { signal }),
  });
  const hasTextLayer = probe.exitCode === 0 ? !looksLikeGlyphCodes(probe.stdout) : false;
  if (!hasTextLayer) notes.push("第一页取不到正常文字：正文可能是描边字形（KiCad 默认 PDF 字体），文字类问题只能按图看");
  return {
    ok: true,
    error: "",
    file,
    bytes: size,
    pages: Number.isFinite(pages) ? pages : 0,
    title: numberFrom(info.stdout, "Title"),
    producer: numberFrom(info.stdout, "Producer"),
    pageSize: numberFrom(info.stdout, "Page size"),
    encrypted: /^Encrypted:\s*yes$/mu.test(info.stdout),
    hasTextLayer,
    notes,
  };
}

export async function extractPdfText(
  subprocess: SubprocessService,
  tools: PopplerTools,
  file: string,
  options: { first?: number; last?: number; layout?: boolean } = {},
  signal?: AbortSignal,
): Promise<PdfText> {
  const first = Math.max(1, Math.floor(options.first ?? 1));
  const last = Math.max(first, Math.floor(options.last ?? first));
  const blank = { ok: false, file, first, last, chars: 0, pages: [] as { page: number; text: string }[], notes: [] as string[] };
  if (!existsSync(file)) return { ...blank, error: "PDF 不存在：" + file };
  const argv = [tools.pdftotext];
  if (options.layout !== false) argv.push("-layout");
  argv.push("-f", String(first), "-l", String(last), file, "-");
  const out = await runCapture(subprocess, {
    argv,
    timeoutMs: 60_000,
    maxBytes: 8 * 1024 * 1024,
    ...(signal === undefined ? {} : { signal }),
  });
  if (out.exitCode !== 0) {
    return { ...blank, error: "pdftotext 执行失败：" + (out.stderr.trim() || String(out.exitCode)) };
  }
  const raw = out.stdout;
  const notes: string[] = [];
  if (looksLikeGlyphCodes(raw)) notes.push("这一段的文字是字形码（描边字体），读不出可读正文：改用 render 模式看图");
  const pages: { page: number; text: string }[] = [];
  const chunks = raw.split("\f");
  for (const [index, chunk] of chunks.entries()) {
    const page = first + index;
    if (page > last) break;
    const text = chunk.replace(/[ \t]+$/gmu, "").trim();
    if (text !== "" || index === 0) pages.push({ page, text });
  }
  return { ok: true, error: "", file, first, last, chars: raw.length, pages, notes };
}

/** 图注与目录行：「Figure 14. VREFINT vs. temperature …… 44」。 */
export function listFigures(text: string, limit = 40): FigureRef[] {
  const out: FigureRef[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(Figure|Table)\s+([0-9]+[a-z]?)\s*[.:]?\s*(.+)$/iu.exec(line);
    if (match === null) continue;
    const kind = (match[1] ?? "").toLowerCase();
    if (kind !== "figure") continue;
    const number = match[2] ?? "";
    const rest = (match[3] ?? "").replace(/[.…\s]{2,}[0-9]+\s*$/u, "").trim();
    const pageMatch = /\s([0-9]{1,4})\s*$/u.exec(line);
    const page = pageMatch === null ? 0 : Number(pageMatch[1]);
    const key = number + "|" + (rest.slice(0, 24) || "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ number, title: rest.slice(0, 120), page: Number.isFinite(page) ? page : 0 });
    if (out.length >= limit) break;
  }
  return out;
}

function pngSize(file: string): { width: number; height: number } {
  try {
    const head = readFileSync(file).subarray(0, 33);
    if (head.length < 24) return { width: 0, height: 0 };
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } catch {
    return { width: 0, height: 0 };
  }
}

export interface PdfTables {
  ok: boolean;
  error: string;
  file: string;
  first: number;
  last: number;
  tables: PdfTable[];
  /** 原文一并给出：表切得对不对，可以就地核对。 */
  pages: { page: number; text: string }[];
  notes: string[];
}

/** 取若干页的表：-bbox 拿词框 → 按行列聚 → 返回表与同段原文。 */
export async function extractPdfTables(
  subprocess: SubprocessService,
  tools: PopplerTools,
  file: string,
  options: { first?: number; last?: number } = {},
  signal?: AbortSignal,
): Promise<PdfTables> {
  const first = Math.max(1, Math.floor(options.first ?? 1));
  const last = Math.max(first, Math.floor(options.last ?? first));
  const blank = { ok: false, file, first, last, tables: [] as PdfTable[], pages: [], notes: [] as string[] };
  if (!existsSync(file)) return { ...blank, error: "PDF 不存在：" + file };
  const bbox = await runCapture(subprocess, {
    argv: [tools.pdftotext, "-bbox", "-f", String(first), "-l", String(last), file, "-"],
    timeoutMs: 90_000,
    maxBytes: 16 * 1024 * 1024,
    ...(signal === undefined ? {} : { signal }),
  });
  if (bbox.exitCode !== 0) {
    return { ...blank, error: "pdftotext -bbox 执行失败：" + (bbox.stderr.trim() || String(bbox.exitCode)) };
  }
  const parsed = parseBboxXml(bbox.stdout);
  const tables: PdfTable[] = [];
  for (const [index, page] of parsed.entries()) {
    tables.push(...extractTablesFromWords(page, { page: first + index }));
  }
  const text = await extractPdfText(subprocess, tools, file, { first, last }, signal);
  const notes: string[] = [];
  if (tables.length === 0) notes.push("这一段没有切出表：可能是正文页，或表格由图片构成；改用 render 看图");
  const medium = tables.filter((table) => table.confidence !== "high").length;
  if (medium > 0) notes.push("有 " + String(medium) + " 张表是 medium：合并单元格或单元格换行会被展开，逐格核对原文");
  return {
    ok: true,
    error: "",
    file,
    first,
    last,
    tables,
    pages: text.ok ? text.pages : [],
    notes,
  };
}

export interface RenderOptions {
  page: number;
  /** 100–600；图表细节常用 200，抠数字用 400。 */
  dpi?: number;
  /** 页面像素坐标裁切（按该 dpi 渲染后的坐标），用于放大某一张图。 */
  crop?: { x: number; y: number; width: number; height: number };
  outDir?: string;
}

export async function renderPdfPage(
  subprocess: SubprocessService,
  tools: PopplerTools,
  file: string,
  options: RenderOptions,
  signal?: AbortSignal,
): Promise<PdfRender> {
  const page = Math.max(1, Math.floor(options.page));
  const dpi = Math.min(600, Math.max(72, Math.floor(options.dpi ?? 150)));
  const blank = {
    ok: false,
    file,
    page,
    dpi,
    imageFile: "",
    width: 0,
    height: 0,
    bytes: 0,
    notes: [] as string[],
  };
  if (!existsSync(file)) return { ...blank, error: "PDF 不存在：" + file };
  const dir = options.outDir ?? join(tmpdir(), "dsh-stm32-pdf");
  const stamp = createHash("sha1").update(file).digest("hex").slice(0, 10);
  const prefix = join(dir, stamp + "-p" + String(page) + "-r" + String(dpi));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  const argv = [tools.pdftoppm, "-f", String(page), "-l", String(page), "-r", String(dpi), "-png", "-singlefile"];
  if (options.crop !== undefined) {
    const c = options.crop;
    argv.push("-x", String(Math.max(0, Math.floor(c.x))), "-y", String(Math.max(0, Math.floor(c.y))));
    argv.push("-W", String(Math.max(1, Math.floor(c.width))), "-H", String(Math.max(1, Math.floor(c.height))));
  }
  argv.push(file, prefix);
  const out = await runCapture(subprocess, {
    argv,
    timeoutMs: 120_000,
    ...(signal === undefined ? {} : { signal }),
  });
  const imageFile = prefix + ".png";
  if (out.exitCode !== 0 || !existsSync(imageFile)) {
    return {
      ...blank,
      error: "pdftoppm 渲染失败：" + (out.stderr.trim() || String(out.exitCode)),
    };
  }
  const { width, height } = pngSize(imageFile);
  return {
    ok: true,
    error: "",
    file,
    page,
    dpi,
    imageFile,
    width,
    height,
    bytes: statSync(imageFile).size,
    notes: options.crop === undefined ? [] : ["已按 crop 裁切：坐标按该 dpi 渲染后的像素计"],
  };
}

export interface PdfCurves {
  ok: boolean;
  error: string;
  file: string;
  page: number;
  dpi: number;
  imageFile: string;
  calibration: import("./curve.js").Calibration | null;
  series: import("./curve.js").CurveSeries[];
  notes: string[];
}

/** 取一页曲线图并数字化：渲染位图 → 认刻度 → 按色相采样每条曲线（S122）。 */
export async function readPdfCurves(
  subprocess: SubprocessService,
  tools: PopplerTools,
  file: string,
  options: { page: number; dpi?: number; maxPoints?: number; signal?: AbortSignal },
): Promise<PdfCurves> {
  const dpi = options.dpi ?? 200;
  const empty: PdfCurves = {
    ok: false,
    error: "",
    file,
    page: options.page,
    dpi,
    imageFile: "",
    calibration: null,
    series: [],
    notes: [],
  };
  const rendered = await renderPdfPage(
    subprocess,
    tools,
    file,
    { page: options.page, dpi },
    options.signal,
  );
  if (!rendered.ok) return { ...empty, error: rendered.error };
  const image = decodePng(readFileSync(rendered.imageFile));
  if (!image.ok) return { ...empty, error: "渲染图无法解码：" + image.error, imageFile: rendered.imageFile };
  const boxed = await runCapture(
    subprocess,
    {
      argv: [tools.pdftotext, "-bbox", "-f", String(options.page), "-l", String(options.page), file, "-"],
      cwd: dirname(file),
      env: {},
      timeoutMs: 60_000,
      maxBytes: 16 * 1024 * 1024,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  if (boxed.exitCode !== 0) {
    return { ...empty, error: "取不到刻度文字：" + (boxed.stderr || boxed.spawnError || "pdftotext 失败"), imageFile: rendered.imageFile };
  }
  const pages = parseBboxXml(boxed.stdout);
  const words = pages[0]?.words ?? [];
  const scale = dpi / 72;
  // 先把彩色像素的外接框量出来：同页有两张图时，刻度只认这一块附近的（S124）。
  const bounds = chromaBounds(image.image, Math.round(8 * scale));
  const calibrated = calibrateFromWords(words, bounds === null ? { scale } : { scale, bounds });
  if (!calibrated.ok) {
    return { ...empty, error: calibrated.error, imageFile: rendered.imageFile };
  }
  const digitized = digitizeCurves(image.image, calibrated.calibration, options.maxPoints === undefined ? {} : { maxPoints: options.maxPoints });
  const labels = legendLabels(words, image.image, bounds, { scale });
  for (const item of digitized.series) {
    const index = ["red", "orange", "yellow", "green", "cyan", "blue", "violet", "magenta"].indexOf(item.hue);
    const label = labels.get(index);
    if (label !== undefined) item.label = label;
  }
  if (labels.size === 0) digitized.notes.push("图例文字没认出来（可能是字形轮廓），序列按色相命名");
  return {
    ok: digitized.series.length > 0,
    error: digitized.series.length > 0 ? "" : "没有采样到曲线像素",
    file,
    page: options.page,
    dpi,
    imageFile: rendered.imageFile,
    calibration: calibrated.calibration,
    series: digitized.series,
    notes: [...calibrated.calibration.notes, ...digitized.notes],
  };
}

/**
 * 原理图 PDF 的元件与标签清单（S125）。
 *
 * 只做清单：PDF 里没有「谁连谁」，网表从 KiCad 工程读。
 */
export async function readPdfSchematic(
  subprocess: SubprocessService,
  tools: PopplerTools,
  file: string,
  options: { first?: number; last?: number } = {},
  signal?: AbortSignal,
): Promise<PdfSchematic> {
  const first = Math.max(1, Math.floor(options.first ?? 1));
  const last = Math.max(first, Math.floor(options.last ?? first));
  const blank: PdfSchematic = { ok: false, error: "", file, pages: 0, components: [], labels: [], words: 0, notes: [] };
  if (!existsSync(file)) return { ...blank, error: "PDF 不存在：" + file };
  const run = await runCapture(subprocess, {
    argv: [tools.pdftotext, "-bbox", "-f", String(first), "-l", String(last), file, "-"],
    timeoutMs: 120_000,
    maxBytes: 16 * 1024 * 1024,
    ...(signal === undefined ? {} : { signal }),
  });
  if (run.exitCode !== 0) {
    return { ...blank, error: "取不到文字：" + (run.stderr || run.spawnError || "pdftotext 失败") };
  }
  const parsed = parseBboxXml(run.stdout);
  const report = readPdfSchematicWords(parsed.map((page, index) => ({ page: first + index, words: page.words })));
  return { ...report, file, pages: parsed.length };
}
