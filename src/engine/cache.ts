/**
 * 下载缓存（"可检索的缓存目录"）。
 *
 * 为什么要有它：寄存器版模板、未来的各类模板与工具链产物都不能预置进插件（用户 2026-10-24 决定：
 * 插件要能覆盖任意 STM32，不可能每颗芯片都打一份进 npm 包）。做法是第一次用时从网上下载，
 * 落到一个**可检索**的本地缓存目录，之后一律复用——所以缓存必须自带一份 index.json：
 * 谁、哪一代、从哪个 URL 下的、多大、什么时候下的，都要能直接读出来，而不是靠猜目录里有什么。
 *
 * 目录：DSH_STM32_CACHE 覆盖，默认 %LOCALAPPDATA%\dsh-stm32\cache。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cmsisEntryAliases } from "../data/cmsis-sources.js";

export const CACHE_INDEX_VERSION = 1 as const;

export interface CacheFile {
  /** 相对缓存条目根目录的路径（正斜杠）。 */
  path: string;
  bytes: number;
  /** 实际下载成功的那个 URL（换过源也能追溯）。 */
  url: string;
  /**
   * 下载完成时的内容 sha256（小写 hex）。老条目没有这一项，校验时退回只看字节数（A38）。
   * 字节数挡不住"同样大小、内容被换掉"——代理塞登录页、杀软替换文件、同名不同版本的启动文件，
   * 大小都可能刚好一样。
   */
  sha256?: string;
}

export interface CacheEntry {
  /**
   * 稳定 id，例如 cmsis:F1:103xb（0.2 起 = cmsis:<族>:<line><容量档>）。
   * 0.1 用过 cmsis:F1:startup_stm32f103xb / cmsis:F1:stm32f103xb，靠 cmsisEntryAliases()
   * 兼容读取，见 resolveCacheEntry()。
   */
  id: string;
  kind: "cmsis";
  family: string;
  label: string;
  /** 条目根目录（绝对路径）。 */
  root: string;
  createdAt: string;
  totalBytes: number;
  files: CacheFile[];
  sources: string[];
  license: string;
}

export interface CacheIndex {
  version: number;
  updatedAt: string;
  entries: CacheEntry[];
}

export interface CacheRootInfo {
  root: string;
  indexPath: string;
  /** 从哪个环境变量/默认规则来的，卡片上要说明白。 */
  origin: string;
}

/** 缓存根目录：环境变量优先，其次 LOCALAPPDATA，再退 USERPROFILE、临时目录。 */
export function cacheRootInfo(env: NodeJS.ProcessEnv = process.env): CacheRootInfo {
  const override = (env.DSH_STM32_CACHE ?? "").trim();
  if (override !== "") {
    const root = path.resolve(expandHome(override, env));
    return { root, indexPath: path.join(root, "index.json"), origin: "DSH_STM32_CACHE" };
  }
  const localAppData = (env.LOCALAPPDATA ?? "").trim();
  if (localAppData !== "") {
    const root = path.join(localAppData, "dsh-stm32", "cache");
    return { root, indexPath: path.join(root, "index.json"), origin: "LOCALAPPDATA" };
  }
  const userProfile = (env.USERPROFILE ?? "").trim();
  if (userProfile !== "") {
    const root = path.join(userProfile, "AppData", "Local", "dsh-stm32", "cache");
    return { root, indexPath: path.join(root, "index.json"), origin: "USERPROFILE" };
  }
  const root = path.join(os.tmpdir(), "dsh-stm32-cache");
  return { root, indexPath: path.join(root, "index.json"), origin: "临时目录（没有 LOCALAPPDATA/USERPROFILE）" };
}

export function cacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  return cacheRootInfo(env).root;
}

function expandHome(value: string, env: NodeJS.ProcessEnv): string {
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    const home = (env.USERPROFILE ?? env.HOME ?? "").trim();
    if (home !== "") return path.join(home, value.slice(1));
  }
  return value;
}

export function emptyCacheIndex(): CacheIndex {
  return { version: CACHE_INDEX_VERSION, updatedAt: "", entries: [] };
}

/**
 * 读索引。坏 JSON 不抛：缓存是可以重建的，读到坏文件就当作空索引 + 一条错误说明，
 * 让调用方（工具卡片）把话讲清楚，而不是整个工具炸掉。
 */
export function readCacheIndex(env: NodeJS.ProcessEnv = process.env): { index: CacheIndex; error: string | null; path: string } {
  const info = cacheRootInfo(env);
  if (!fs.existsSync(info.indexPath)) return { index: emptyCacheIndex(), error: null, path: info.indexPath };
  try {
    const raw = fs.readFileSync(info.indexPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<CacheIndex>;
    const entries = Array.isArray(parsed.entries) ? parsed.entries.filter(isCacheEntry) : [];
    return {
      index: { version: typeof parsed.version === "number" ? parsed.version : CACHE_INDEX_VERSION, updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "", entries },
      error: null,
      path: info.indexPath,
    };
  } catch (error) {
    return { index: emptyCacheIndex(), error: "缓存索引读不了（" + info.indexPath + "）：" + errorText(error) + "；当作空索引，重新下载会覆盖它。", path: info.indexPath };
  }
}

function isCacheEntry(value: unknown): value is CacheEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<CacheEntry>;
  return typeof entry.id === "string" && typeof entry.kind === "string" && typeof entry.root === "string" && Array.isArray(entry.files);
}

/**
 * 写索引失败（可识别、带路径）。单独一个类型是为了让调用方把「索引没写成」和
 * 「网络挂了」分开，并且能依赖一条硬承诺：抛错时旧索引逐字节没动。
 */
export class CacheIndexWriteError extends Error {
  readonly indexPath: string;

  constructor(indexPath: string, detail: string) {
    super("缓存索引写不进去（" + indexPath + "）：" + detail);
    this.name = "CacheIndexWriteError";
    this.indexPath = indexPath;
  }
}

/** 注入点：单测里换掉 rename 才能确定性地验证「写失败时旧索引没变」（只读属性/独占锁不可移植）。 */
export interface CacheIndexIo {
  rename?: (from: string, to: string) => void;
  writeFile?: (file: string, text: string) => void;
  remove?: (file: string) => void;
}

let tmpSeq = 0;

/** 唯一的临时名：pid + 自增序号 + 随机，同进程连续写、多进程同时写都不会撞。 */
function uniqueIndexTmp(indexPath: string): string {
  tmpSeq += 1;
  const rand = Math.random().toString(16).slice(2, 10);
  return indexPath + ".tmp-" + String(process.pid) + "-" + String(tmpSeq) + "-" + rand;
}

/** Windows 文件名不允许冒号，时间戳里的 : 与 . 都换成 -。 */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

/** 备份名：index.json.broken-<ts> / index.json.bak-<ts>；同一毫秒撞上就加序号。 */
function freeBackupPath(indexPath: string, tag: "broken" | "bak"): string {
  const base = indexPath + "." + tag + "-" + stamp();
  if (!fs.existsSync(base)) return base;
  for (let extra = 2; extra < 1000; extra += 1) {
    const candidate = base + "-" + String(extra);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return base + "-" + String(Date.now());
}

function safeRemove(remove: (file: string) => void, file: string): void {
  try {
    remove(file);
  } catch {
    // 临时文件删不掉不影响结论。
  }
}

/**
 * 索引读不出来时先留一份 index.json.broken-<ts> 再重建：
 * 坏文件里其它条目还有人工救回来的价值，直接覆盖等于把它们一起抹掉。
 */
function preserveBrokenIndex(indexPath: string, reason: string): string {
  const backup = freeBackupPath(indexPath, "broken");
  try {
    fs.renameSync(indexPath, backup);
    return backup;
  } catch (renameError) {
    try {
      fs.copyFileSync(indexPath, backup);
      return backup;
    } catch (copyError) {
      throw new CacheIndexWriteError(
        indexPath,
        reason + "；留一份备份也没成功（" + errorText(renameError) + " / " + errorText(copyError) + "），为免覆盖掉还能救回来的条目，这次不写索引。",
      );
    }
  }
}

/**
 * 原子换索引：tmp 用唯一名 → rename；rename 失败（Windows 上目标被占用是常见原因）
 * 就先把旧索引改名成 index.json.bak-<ts>（**不删**）再搬一次；第二次仍失败就把备份原样放回。
 * 硬承诺：函数抛错时旧索引仍在，绝不出现「删了好索引、新的又没搬过来」。
 */
export function writeCacheIndex(index: CacheIndex, env: NodeJS.ProcessEnv = process.env, io: CacheIndexIo = {}): string {
  const info = cacheRootInfo(env);
  const rename = io.rename ?? ((from: string, to: string): void => { fs.renameSync(from, to); });
  const writeFile = io.writeFile ?? ((file: string, text: string): void => { fs.writeFileSync(file, text, "utf8"); });
  const remove = io.remove ?? ((file: string): void => { fs.rmSync(file, { force: true }); });

  fs.mkdirSync(path.dirname(info.indexPath), { recursive: true });
  const next: CacheIndex = { version: CACHE_INDEX_VERSION, updatedAt: new Date().toISOString(), entries: index.entries };
  const tmp = uniqueIndexTmp(info.indexPath);
  try {
    writeFile(tmp, JSON.stringify(next, null, 2) + "\n");
  } catch (error) {
    safeRemove(remove, tmp);
    throw new CacheIndexWriteError(info.indexPath, "临时文件写不进去（" + errorText(error) + "），旧索引没有动。");
  }

  try {
    rename(tmp, info.indexPath);
    return info.indexPath;
  } catch (first) {
    if (!fs.existsSync(info.indexPath)) {
      safeRemove(remove, tmp);
      throw new CacheIndexWriteError(info.indexPath, "换索引失败（" + errorText(first) + "），旧索引没有动。");
    }
  }

  const backup = freeBackupPath(info.indexPath, "bak");
  try {
    rename(info.indexPath, backup);
  } catch (error) {
    safeRemove(remove, tmp);
    throw new CacheIndexWriteError(info.indexPath, "旧索引既换不动也备份不了（" + errorText(error) + "），旧索引没有动。");
  }
  try {
    rename(tmp, info.indexPath);
    return info.indexPath;
  } catch (second) {
    let restored = false;
    try {
      rename(backup, info.indexPath);
      restored = true;
    } catch {
      restored = false;
    }
    safeRemove(remove, tmp);
    throw new CacheIndexWriteError(
      info.indexPath,
      "换索引失败（" + errorText(second) + "）" + (restored ? "，旧索引已原样放回。" : "，旧索引备份留在 " + backup + "，请手工改回 index.json。"),
    );
  }
}

/** 同 id 覆盖写（缓存条目重建时用）。索引读坏了先备份成 index.json.broken-<ts> 再重建。 */
export function upsertCacheEntry(entry: CacheEntry, env: NodeJS.ProcessEnv = process.env): CacheIndex {
  const read = readCacheIndex(env);
  if (read.error !== null && fs.existsSync(read.path)) preserveBrokenIndex(read.path, read.error);
  const index = read.index;
  const entries = index.entries.filter((item) => item.id !== entry.id);
  entries.push(entry);
  entries.sort((a, b) => a.id.localeCompare(b.id));
  const next: CacheIndex = { version: CACHE_INDEX_VERSION, updatedAt: new Date().toISOString(), entries };
  writeCacheIndex(next, env);
  return next;
}

export function removeCacheEntry(id: string, env: NodeJS.ProcessEnv = process.env): { removed: boolean; indexPath: string } {
  const read = readCacheIndex(env);
  // 索引读坏时删条目同样会把别的条目一起写没：先备份坏文件再动手（A2 同源缺陷）。
  if (read.error !== null && fs.existsSync(read.path)) preserveBrokenIndex(read.path, read.error);
  const index = read.index;
  const target = index.entries.find((item) => item.id === id);
  if (target === undefined) return { removed: false, indexPath: cacheRootInfo(env).indexPath };
  const rest = index.entries.filter((item) => item.id !== id);
  writeCacheIndex({ version: CACHE_INDEX_VERSION, updatedAt: "", entries: rest }, env);
  if (isInside(cacheRootInfo(env).root, target.root)) fs.rmSync(target.root, { recursive: true, force: true });
  return { removed: true, indexPath: cacheRootInfo(env).indexPath };
}

export function findCacheEntry(index: CacheIndex, kind: CacheEntry["kind"], id: string): CacheEntry | null {
  return index.entries.find((item) => item.kind === kind && item.id === id) ?? null;
}

/**
 * 按"用户可能怎么写"找缓存条目：先精确命中 id，再按 cmsis 条目的别名找。
 *
 * 为什么需要：条目 id 的规范写法变过（0.1 是 cmsis:F1:startup_stm32f103xb，0.2 是
 * cmsis:F1:103xb），而用户是照着文档/旧报错/记忆敲的（cmsis:F1:startup_stm32f103xb、
 * F1:B、STM32F103C8T6 都可能）。只做精确匹配的后果是：缓存里明明有一份健康的 14 个文件，
 * 却被判"没缓存"重下一遍；purge 更是删不掉——用户以为删了，下次还是旧文件。
 */
export function resolveCacheEntry(index: CacheIndex, ref: string): CacheEntry | null {
  const direct = findCacheEntry(index, "cmsis", ref);
  if (direct !== null) return direct;
  for (const candidate of cmsisEntryAliases(ref)) {
    const found = findCacheEntry(index, "cmsis", candidate);
    if (found !== null) return found;
  }
  return null;
}

export interface CacheHealth {
  entry: CacheEntry;
  missing: string[];
  changed: string[];
  ok: boolean;
}

/**
 * 校验条目里的文件还在不在、内容对不对。
 * 有 sha256 的条目比内容哈希（A38）：字节数只能挡半截文件，挡不住"同样大小、内容被换掉"。
 * 老条目没有 sha256 时退回只比字节数，不把已存在的缓存判死。
 */
export function checkCacheEntry(entry: CacheEntry): CacheHealth {
  const missing: string[] = [];
  const changed: string[] = [];
  for (const file of entry.files) {
    const full = path.join(entry.root, file.path);
    if (!fs.existsSync(full)) {
      missing.push(file.path);
      continue;
    }
    const size = fs.statSync(full).size;
    if (size !== file.bytes) {
      changed.push(file.path + "（" + String(size) + " ≠ " + String(file.bytes) + " 字节）");
      continue;
    }
    if (file.sha256 !== undefined && file.sha256 !== "") {
      let actual = "";
      try {
        actual = sha256OfFile(full);
      } catch {
        missing.push(file.path);
        continue;
      }
      if (actual !== file.sha256) changed.push(file.path + "（内容 sha256 对不上，可能被替换过）");
    }
  }
  return { entry, missing, changed, ok: missing.length === 0 && changed.length === 0 };
}

/** 算文件内容的 sha256（小写 hex）。缓存登记与校验共用同一口径。 */
export function sha256OfFile(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function describeCacheBytes(bytes: number): string {
  if (bytes < 1024) return String(bytes) + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
