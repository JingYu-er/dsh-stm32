/**
 * 数据手册本地缓存（S119）。
 *
 * 目标：同一颗非 STM32 器件只下第一份手册，之后一律读本地。缓存按立创编号分目录，
 * 文件名取 PDF 内容的 sha256 前缀，meta.json 记来源与抓取时间——出处可回溯、内容可校验。
 *
 * 失败也留痕：`_negative/<编号>.json` 记下原因与时间，24 小时内不再重试，避免每次构建都去撞墙。
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { fetchLcscProduct, type LcscOptions, type LcscProduct } from "./lcsc.js";

/** 缓存条目：一份手册的全部事实。 */
export interface DatasheetEntry {
  code: string;
  mpn: string;
  brand: string;
  title: string;
  sha256: string;
  bytes: number;
  pdfFile: string;
  sourceUrl: string;
  pdfUrl: string;
  fetchedAt: string;
}

interface DatasheetIndex {
  version: 1;
  entries: Record<string, DatasheetEntry>;
}

const INDEX_FILE = "index.json";
const NEGATIVE_DIR = "_negative";
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_MB = 40;
const DEFAULT_GAP_MS = 1500;

let lastRequestAt = 0;

/** 缓存根目录：`DSH_STM32_DATASHEETS` 优先，否则 `~/.dsh-stm32/datasheets`。 */
export function datasheetCacheDir(env: Record<string, string | undefined> = process.env): string {
  const explicit = (env["DSH_STM32_DATASHEETS"] ?? "").trim();
  if (explicit !== "") return explicit;
  return join(env["USERPROFILE"]?.trim() || homedir(), ".dsh-stm32", "datasheets");
}

export function isLcscCode(value: string): boolean {
  return /^(?:lcsc:)?C\d{3,}$/iu.test(value.trim());
}

export function normalizeCode(value: string): string {
  return value.trim().replace(/^lcsc:/iu, "").toUpperCase();
}

function emptyIndex(): DatasheetIndex {
  return { version: 1, entries: {} };
}

export function readIndex(cacheDir: string): DatasheetIndex {
  const file = join(cacheDir, INDEX_FILE);
  if (!existsSync(file)) return scanIndex(cacheDir);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as DatasheetIndex;
    if (parsed.version !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) return emptyIndex();
    return parsed;
  } catch {
    return emptyIndex();
  }
}

/** 索引丢了也能从各目录的 meta.json 重建（缓存目录被人手工动过时的自愈）。 */
function scanIndex(cacheDir: string): DatasheetIndex {
  const index = emptyIndex();
  if (!existsSync(cacheDir)) return index;
  for (const name of readdirSync(cacheDir)) {
    if (name.startsWith("_")) continue;
    const metaFile = join(cacheDir, name, "meta.json");
    if (!existsSync(metaFile)) continue;
    try {
      const entry = JSON.parse(readFileSync(metaFile, "utf8")) as DatasheetEntry;
      if (typeof entry.code === "string" && typeof entry.sha256 === "string") index.entries[entry.code] = entry;
    } catch {
      // 坏掉的 meta 跳过：宁缺，不要把脏数据带进索引。
    }
  }
  return index;
}

function writeIndex(cacheDir: string, index: DatasheetIndex): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, INDEX_FILE), JSON.stringify(index, null, 2) + "\n", "utf8");
}

export function entryFile(cacheDir: string, entry: DatasheetEntry): string {
  return join(cacheDir, entry.code, entry.pdfFile);
}

/** 缓存是否还在：meta 存在、PDF 存在、sha256 对得上。 */
export function entryUsable(cacheDir: string, entry: DatasheetEntry): boolean {
  const file = entryFile(cacheDir, entry);
  if (!existsSync(file)) return false;
  try {
    return sha256Of(readFileSync(file)) === entry.sha256;
  } catch {
    return false;
  }
}

export function sha256Of(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** 把 `C25137` / `lcsc:C25137` / MPN 解析成本地 PDF 路径。 */
export function resolveDatasheetRef(cacheDir: string, ref: string): { file: string; entry: DatasheetEntry } | null {
  if (existsSync(ref)) return null;
  const index = readIndex(cacheDir);
  const wanted = ref.trim();
  const byCode = index.entries[normalizeCode(wanted)];
  if (byCode !== undefined && entryUsable(cacheDir, byCode)) return { file: entryFile(cacheDir, byCode), entry: byCode };
  const lowered = wanted.toLowerCase();
  for (const entry of Object.values(index.entries)) {
    if (entry.mpn.toLowerCase() === lowered && entryUsable(cacheDir, entry)) {
      return { file: entryFile(cacheDir, entry), entry };
    }
  }
  return null;
}

function negativeFile(cacheDir: string, code: string): string {
  return join(cacheDir, NEGATIVE_DIR, code + ".json");
}

function negativeReason(cacheDir: string, code: string): string {
  const file = negativeFile(cacheDir, code);
  if (!existsSync(file)) return "";
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { error?: string; at?: number };
    if (typeof parsed.at !== "number" || Date.now() - parsed.at > NEGATIVE_TTL_MS) return "";
    return parsed.error ?? "上次抓取失败";
  } catch {
    return "";
  }
}

function writeNegative(cacheDir: string, code: string, error: string): void {
  mkdirSync(join(cacheDir, NEGATIVE_DIR), { recursive: true });
  writeFileSync(negativeFile(cacheDir, code), JSON.stringify({ code, error, at: Date.now() }) + "\n", "utf8");
}

function clearNegative(cacheDir: string, code: string): void {
  const file = negativeFile(cacheDir, code);
  if (existsSync(file)) rmSync(file, { force: true });
}

function gapMs(): number {
  const fromEnv = Number.parseInt(process.env["DSH_STM32_DS_MIN_GAP_MS"] ?? "", 10);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : DEFAULT_GAP_MS;
}

async function throttle(): Promise<void> {
  const wait = gapMs() - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

export interface EnsureOptions extends LcscOptions {
  cacheDir?: string;
  refresh?: boolean;
  offline?: boolean;
  maxMb?: number;
  env?: Record<string, string | undefined>;
}

export interface EnsureResult {
  ok: boolean;
  error?: string;
  cached?: boolean;
  entry?: DatasheetEntry;
  file?: string;
}

/**
 * 确保某颗器件的 PDF 在本地。
 * 命中缓存时零网络；`offline` 时不发请求；失败写入负缓存（24 小时）。
 */
export async function ensureDatasheet(codeSpec: string, options: EnsureOptions = {}): Promise<EnsureResult> {
  const cacheDir = options.cacheDir ?? datasheetCacheDir(options.env);
  const code = normalizeCode(codeSpec);
  if (!/^C\d{3,}$/u.test(code)) {
    return { ok: false, error: "编号不像立创商品编号：" + codeSpec + "（形如 C25137）" };
  }

  const index = readIndex(cacheDir);
  const existing = index.entries[code];
  if (existing !== undefined && !(options.refresh ?? false) && entryUsable(cacheDir, existing)) {
    return { ok: true, cached: true, entry: existing, file: entryFile(cacheDir, existing) };
  }
  if (options.offline ?? false) {
    return { ok: false, error: "离线模式（DSH_STM32_OFFLINE=1），本地没有 " + code + " 的手册" };
  }
  if (!(options.refresh ?? false)) {
    const reason = negativeReason(cacheDir, code);
    if (reason !== "") return { ok: false, error: "24 小时内抓取失败过，暂不重试：" + reason };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  await throttle();
  const page = await fetchLcscProduct(code, { fetchImpl, timeoutMs: options.timeoutMs, signal: options.signal });
  if (!page.ok) {
    writeNegative(cacheDir, code, page.error);
    return { ok: false, error: page.error };
  }

  await throttle();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  let buffer: Buffer;
  try {
    const response = await fetchImpl(page.product.pdfUrl, {
      signal: options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal]),
      redirect: "follow",
      headers: { "user-agent": "dsh-stm32 datasheet fetcher (pdf)" },
    });
    if (!response.ok) {
      const error = "PDF 返回 HTTP " + String(response.status) + "：" + page.product.pdfUrl;
      writeNegative(cacheDir, code, error);
      return { ok: false, error };
    }
    buffer = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    const reason = "下载 PDF 失败：" + (error instanceof Error ? error.message : String(error));
    writeNegative(cacheDir, code, reason);
    return { ok: false, error: reason };
  } finally {
    clearTimeout(timer);
  }

  const maxBytes = (options.maxMb ?? DEFAULT_MAX_MB) * 1024 * 1024;
  if (buffer.length > maxBytes) {
    const error = "PDF 超过上限（" + String(Math.round(buffer.length / 1024 / 1024)) + " MB > " + String(options.maxMb ?? DEFAULT_MAX_MB) + " MB）";
    writeNegative(cacheDir, code, error);
    return { ok: false, error };
  }
  if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
    const error = "下载到的不是 PDF（开头不是 %PDF-）：" + page.product.pdfUrl;
    writeNegative(cacheDir, code, error);
    return { ok: false, error };
  }

  const entry = storeBuffer(cacheDir, page.product, buffer);
  clearNegative(cacheDir, code);
  return { ok: true, cached: false, entry, file: entryFile(cacheDir, entry) };
}

/** 把一份 PDF 写进缓存（下载与手工导入共用）。 */
export function storeBuffer(cacheDir: string, product: LcscProduct, buffer: Buffer): DatasheetEntry {
  const sha256 = sha256Of(buffer);
  const dir = join(cacheDir, product.code);
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".pdf") && name !== sha256.slice(0, 12) + ".pdf") rmSync(join(dir, name), { force: true });
  }
  const pdfFile = sha256.slice(0, 12) + ".pdf";
  writeFileSync(join(dir, pdfFile), buffer);
  const entry: DatasheetEntry = {
    code: product.code,
    mpn: product.mpn,
    brand: product.brand,
    title: product.title,
    sha256,
    bytes: buffer.length,
    pdfFile,
    sourceUrl: product.sourceUrl,
    pdfUrl: product.pdfUrl,
    fetchedAt: new Date().toISOString(),
  };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(entry, null, 2) + "\n", "utf8");
  const index = readIndex(cacheDir);
  index.entries[product.code] = entry;
  writeIndex(cacheDir, index);
  return entry;
}

/** 手工导入：用户自己放一份 PDF 进来（离线/反爬时的退路）。 */
export function importDatasheet(cacheDir: string, file: string, product: Partial<LcscProduct> & { code?: string } = {}): EnsureResult {
  if (!existsSync(file)) return { ok: false, error: "文件不存在：" + file };
  const buffer = readFileSync(file);
  if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") return { ok: false, error: "不是 PDF：" + file };
  const code = normalizeCode(product.code ?? "");
  const product2: LcscProduct = {
    code: /^C\d{3,}$/u.test(code) ? code : "manual-" + sha256Of(buffer).slice(0, 8),
    mpn: product.mpn ?? "",
    brand: product.brand ?? "",
    title: product.title ?? file,
    pdfUrl: product.pdfUrl ?? "",
    sourceUrl: product.sourceUrl ?? file,
  };
  const entry = storeBuffer(cacheDir, product2, buffer);
  return { ok: true, cached: false, entry, file: entryFile(cacheDir, entry) };
}

export interface DatasheetListing {
  cacheDir: string;
  entries: DatasheetEntry[];
  totalBytes: number;
}

export function listDatasheets(cacheDir: string): DatasheetListing {
  const index = readIndex(cacheDir);
  const entries: DatasheetEntry[] = [];
  let totalBytes = 0;
  for (const entry of Object.values(index.entries)) {
    if (!entryUsable(cacheDir, entry)) continue;
    entries.push(entry);
    totalBytes += entry.bytes;
  }
  entries.sort((a, b) => a.code.localeCompare(b.code));
  return { cacheDir, entries, totalBytes };
}

/** 缓存占用（不影响列表）：目录里 PDF 的实际大小，含手写目录。 */
export function cacheBytes(cacheDir: string): number {
  if (!existsSync(cacheDir)) return 0;
  let total = 0;
  for (const name of readdirSync(cacheDir)) {
    const file = join(cacheDir, name);
    if (!statSync(file).isFile()) {
      const entry = readIndex(cacheDir).entries[name];
      if (entry !== undefined) total += entry.bytes;
    }
  }
  return total;
}

/** 手工导入的便捷封装：按位号名复制进缓存（面板/工具用）。 */
export function importDatasheetFile(cacheDir: string, source: string, code?: string, mpn?: string): EnsureResult {
  mkdirSync(cacheDir, { recursive: true });
  const temp = join(cacheDir, "_import.pdf");
  copyFileSync(source, temp);
  const result = importDatasheet(cacheDir, temp, { code, mpn });
  rmSync(temp, { force: true });
  return result;
}
