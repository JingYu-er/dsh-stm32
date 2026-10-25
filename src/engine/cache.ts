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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CACHE_INDEX_VERSION = 1 as const;

export interface CacheFile {
  /** 相对缓存条目根目录的路径（正斜杠）。 */
  path: string;
  bytes: number;
  /** 实际下载成功的那个 URL（换过源也能追溯）。 */
  url: string;
}

export interface CacheEntry {
  /** 稳定 id，例如 cmsis:F1:stm32f103xb。 */
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

export function writeCacheIndex(index: CacheIndex, env: NodeJS.ProcessEnv = process.env): string {
  const info = cacheRootInfo(env);
  fs.mkdirSync(path.dirname(info.indexPath), { recursive: true });
  const next: CacheIndex = { version: CACHE_INDEX_VERSION, updatedAt: new Date().toISOString(), entries: index.entries };
  const tmp = info.indexPath + ".tmp-" + String(process.pid);
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  try {
    fs.renameSync(tmp, info.indexPath);
  } catch {
    // Windows 上目标已存在时 rename 可能失败：先删再搬（索引是纯元数据，重算代价为零）。
    fs.rmSync(info.indexPath, { force: true });
    fs.renameSync(tmp, info.indexPath);
  }
  return info.indexPath;
}

/** 同 id 覆盖写（缓存条目重建时用）。 */
export function upsertCacheEntry(entry: CacheEntry, env: NodeJS.ProcessEnv = process.env): CacheIndex {
  const { index } = readCacheIndex(env);
  const entries = index.entries.filter((item) => item.id !== entry.id);
  entries.push(entry);
  entries.sort((a, b) => a.id.localeCompare(b.id));
  const next: CacheIndex = { version: CACHE_INDEX_VERSION, updatedAt: new Date().toISOString(), entries };
  writeCacheIndex(next, env);
  return next;
}

export function removeCacheEntry(id: string, env: NodeJS.ProcessEnv = process.env): { removed: boolean; indexPath: string } {
  const { index } = readCacheIndex(env);
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

export interface CacheHealth {
  entry: CacheEntry;
  missing: string[];
  changed: string[];
  ok: boolean;
}

/**
 * 校验条目里的文件还在不在、大小对不对。
 * 只比字节数：模板文件来自公网、每次下载都要重算 sha256 太贵；大小不符几乎必然是半截文件或被替换。
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
    if (size !== file.bytes) changed.push(file.path + "（" + String(size) + " ≠ " + String(file.bytes) + " 字节）");
  }
  return { entry, missing, changed, ok: missing.length === 0 && changed.length === 0 };
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
