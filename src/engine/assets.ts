/**
 * 内置资源层：assets/ 随插件包发布，读 manifest + 逐文件 sha256 校验。
 *
 * 2026-11 之前资源放在独立仓库 dsh-stm32-assets，第一次用要联网下载到 ~/.dsh-stm32/assets/<version>/。
 * 资产总共 12.5 MB，拆两个仓库的维护成本（发版要对齐、下载会失败、离线不可用）大于收益，于是整体并入插件：
 *   · 默认根 = 插件包内的 assets/（flat：manifest.json 与 device/、ioc/ 同层）；
 *   · DSH_STM32_ASSETS 仍可覆盖（测试夹具、以及老用户留着旧版本缓存时继续可读）；
 *   · 老布局 <root>/<version>/install.json 继续认，flat 优先。
 *
 * 关键约定：
 *   · 不再有网络下载器：ensureAssets 是纯本地检查，缺文件只可能是插件安装不完整；
 *   · sha256 仍逐文件校验（verify）：内置不等于可信，装坏/被杀软改过要能查出来；
 *   · 失败不抛：都变成 ok:false + 人话原因，工具卡片照常渲染；
 *   · prune 绝不删内置 flat 根，只清 DSH_STM32_ASSETS 下的历史版本目录。
 *
 * 零运行时依赖：只用 node:fs / node:path / node:crypto / node:url。
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ASSETS_MANIFEST_FILE = "manifest.json";
/** 老版本安装布局的标记文件（flat 内置资源没有它）。 */
export const ASSETS_INSTALL_FILE = "install.json";

/** 设备事实在资源根里的相对路径（插件唯一的芯片事实来源）。 */
export const ASSETS_DEVICE_FACTS_FILE = "device/f1/chips.json";

/** 缺资源时对用户说的那句话（工具卡片、错误、note 都复用它，避免各写一套）。 */
export const ASSETS_REFRESH_HINT =
  "资源随插件内置（assets/）：缺文件说明插件安装不完整，重装插件后重试；stm32_assets verify 可定位缺了哪些";

export type AssetsProfile = "core" | "full";

/** 只给 core / full；空串按 core 处理，别的值返回 null（由调用方给可读报错，不瞎猜）。 */
export function normalizeProfile(value: string | undefined): AssetsProfile | null {
  const text = (value ?? "core").trim().toLowerCase();
  if (text === "") return "core";
  if (text === "core" || text === "full") return text;
  return null;
}

/* ------------------------------ 本地目录 ------------------------------ */

export interface AssetsRootInfo {
  root: string;
  /** 目录是从哪来的（插件内置 / DSH_STM32_ASSETS），卡片上要说明白。 */
  origin: string;
}

/** 插件包内的 assets/：lib/engine/assets.js 往上两级就是包根。 */
export function bundledAssetsRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "assets");
}

function expandHome(value: string, env: NodeJS.ProcessEnv): string {
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    const home = (env.USERPROFILE ?? env.HOME ?? "").trim();
    if (home !== "") return path.join(home, value.slice(1));
  }
  return value;
}

/** 资源根目录：DSH_STM32_ASSETS 覆盖，默认插件包内 assets/。 */
export function assetsRootInfo(env: NodeJS.ProcessEnv = process.env): AssetsRootInfo {
  const override = (env.DSH_STM32_ASSETS ?? "").trim();
  if (override !== "") {
    return { root: path.resolve(expandHome(override, env)), origin: "DSH_STM32_ASSETS（覆盖内置资源）" };
  }
  return { root: bundledAssetsRoot(), origin: "插件内置（assets/）" };
}

/** 资源根（不含版本号）。测试里用 DSH_STM32_ASSETS 指到临时目录，绝不碰真实 assets/。 */
export function localAssetsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return assetsRootInfo(env).root;
}

/** 老布局里某个版本的安装目录：<root>/<version>/。 */
export function versionDir(version: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(localAssetsRoot(env), version);
}

/* ------------------------------ manifest ------------------------------ */

export interface AssetsManifestFile {
  /** 相对资源根的正斜杠路径，例如 device/f1/chips.json。 */
  path: string;
  bytes: number;
  /** 64 位小写十六进制 sha256。 */
  sha256: string;
  source: string;
  /** 这份文件属于哪个 profile（"core" / "full"）。 */
  profile: string;
}

export interface AssetsManifest {
  name: string;
  version: string;
  schema: number;
  /** profile → glob 列表（core = device/ioc/ld；full = core + startup/headers，SVD 也在 full）。 */
  profiles: Record<string, string[]>;
  files: AssetsManifestFile[];
  skipped: string[];
  /** 其它字段（counts / device / generatedBy...）原样保留。 */
  [key: string]: unknown;
}

const SHA256_RE = /^[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function errText(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== undefined && cause !== null && cause !== "") {
      const causeText = cause instanceof Error ? cause.message : String(cause);
      return error.message + "（" + causeText + "）";
    }
    return error.message;
  }
  return String(error);
}

function shortHash(value: string): string {
  return value.length > 16 ? value.slice(0, 16) + "…" : value;
}

/**
 * 解析并校验 manifest。校验不过返回 error，不抛异常。
 * 为什么严：manifest 是"有哪些文件、该是什么内容"的唯一事实来源，少一个 sha256 就等于放弃校验。
 */
export function parseManifest(text: string): { manifest: AssetsManifest | null; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { manifest: null, error: "manifest.json 不是合法 JSON：" + errText(error) };
  }
  if (!isRecord(parsed)) return { manifest: null, error: "manifest.json 顶层不是对象" };
  const version = parsed["version"];
  if (typeof version !== "string" || version.trim() === "") {
    return {
      manifest: null,
      error:
        "manifest.json 缺 version。资源现在随插件内置，正常安装不会缺；用 scripts/assets/build-assets.mjs 重新生成。",
    };
  }
  const rawFiles = parsed["files"];
  if (!Array.isArray(rawFiles)) return { manifest: null, error: "manifest.json 缺 files 数组" };
  const files: AssetsManifestFile[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < rawFiles.length; index += 1) {
    const item: unknown = rawFiles[index];
    const where = "files[" + String(index) + "]";
    if (!isRecord(item)) return { manifest: null, error: where + " 不是对象" };
    const relPath = item["path"];
    if (typeof relPath !== "string" || relPath.trim() === "") {
      return { manifest: null, error: where + " 缺 path" };
    }
    const normalized = normalizeAssetPath(relPath);
    if (normalized === null) return { manifest: null, error: where + " 的 path 不合法（必须是资源根内的相对路径）：" + relPath };
    if (seen.has(normalized)) return { manifest: null, error: "manifest.json 里 path 重复：" + normalized };
    seen.add(normalized);
    const sha256 = item["sha256"];
    if (typeof sha256 !== "string" || !SHA256_RE.test(sha256.toLowerCase())) {
      return { manifest: null, error: where + "（" + normalized + "）缺 sha256 或不是 64 位十六进制；没有哈希就无法校验" };
    }
    const bytes = item["bytes"];
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
      return { manifest: null, error: where + "（" + normalized + "）的 bytes 不是非负数" };
    }
    const profile = typeof item["profile"] === "string" && item["profile"] !== "" ? item["profile"] : "core";
    const source = typeof item["source"] === "string" ? item["source"] : "";
    files.push({ path: normalized, bytes, sha256: sha256.toLowerCase(), source, profile });
  }
  const profiles: Record<string, string[]> = {};
  const rawProfiles = parsed["profiles"];
  if (isRecord(rawProfiles)) {
    for (const [key, value] of Object.entries(rawProfiles)) {
      if (!Array.isArray(value)) return { manifest: null, error: "manifest.json 的 profiles." + key + " 不是数组" };
      const globs: string[] = [];
      for (const glob of value) {
        if (typeof glob !== "string" || glob.trim() === "") {
          return { manifest: null, error: "manifest.json 的 profiles." + key + " 里有非字符串 glob" };
        }
        globs.push(glob);
      }
      profiles[key] = globs;
    }
  }
  const skipped = Array.isArray(parsed["skipped"]) ? parsed["skipped"].filter((item): item is string => typeof item === "string") : [];
  const name = typeof parsed["name"] === "string" ? parsed["name"] : "dsh-stm32-assets";
  const schema = typeof parsed["schema"] === "number" ? parsed["schema"] : 1;
  return { manifest: { ...parsed, name, version, schema, profiles, files, skipped }, error: "" };
}

/** 相对路径规整：反斜杠转正斜杠、拒绝绝对路径/盘符/.. —— 防止 manifest 把文件指到资源根以外。 */
export function normalizeAssetPath(raw: string): string | null {
  const text = raw.split("\\").join("/").trim();
  if (text === "" || text.startsWith("/") || /^[A-Za-z]:/u.test(text)) return null;
  const parts = text.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0) return null;
  if (parts.some((part) => part === "..")) return null;
  return parts.join("/");
}

/** glob → 正则：** 跨目录，* 不跨目录，? 单字符。manifest 的 profiles 就靠它筛文件。 */
function globToRegExp(pattern: string): RegExp {
  let out = "^";
  let index = 0;
  while (index < pattern.length) {
    const ch = pattern.charAt(index);
    if (ch === "*") {
      if (pattern.charAt(index + 1) === "*") {
        const followedBySlash = pattern.charAt(index + 2) === "/";
        out += followedBySlash ? "(?:[^/]+/)*" : ".*";
        index += followedBySlash ? 3 : 2;
        continue;
      }
      out += "[^/]*";
      index += 1;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      index += 1;
      continue;
    }
    out += ch.replace(/[.*+?^$()|[\]\\]/gu, "\\$&");
    index += 1;
  }
  return new RegExp(out + "$", "u");
}

/**
 * profile 里的文件。优先用 manifest.profiles 的 glob（v2 的标准做法）；
 * 老 manifest 没有 profiles 时退回每条的 profile 字段（full 包含 core）。
 */
export function profileFiles(manifest: AssetsManifest, profile: AssetsProfile): AssetsManifestFile[] {
  const globs = manifest.profiles[profile];
  if (globs !== undefined) {
    const patterns = globs.map((glob) => globToRegExp(glob));
    return manifest.files.filter((file) => patterns.some((pattern) => pattern.test(file.path)));
  }
  return manifest.files.filter((file) => file.profile === profile || (profile === "full" && file.profile === "core"));
}

/* ------------------------------ 本地安装 ------------------------------ */

function scanDirStats(dir: string, skipNames: readonly string[] = []): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skipNames.includes(entry.name)) continue;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      try {
        const stat = fs.statSync(abs);
        files += 1;
        bytes += stat.size;
      } catch {
        // 读不到就跳过，不因为一个坏文件让整份统计失败。
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

export interface LocalInstallRecord {
  version: string;
  /** 装过哪些 profile（先后装 core 与 full 时合并）。 */
  profiles: string[];
  installedAt: string;
  source: string;
  schema: number;
  fileCount: number;
  totalBytes: number;
}

function readInstallRecord(dir: string): LocalInstallRecord | null {
  try {
    const raw = fs.readFileSync(path.join(dir, ASSETS_INSTALL_FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const version = parsed["version"];
    if (typeof version !== "string" || version === "") return null;
    const profiles = Array.isArray(parsed["profiles"])
      ? parsed["profiles"].filter((item): item is string => typeof item === "string")
      : [];
    return {
      version,
      profiles,
      installedAt: typeof parsed["installedAt"] === "string" ? parsed["installedAt"] : "",
      source: typeof parsed["source"] === "string" ? parsed["source"] : "",
      schema: typeof parsed["schema"] === "number" ? parsed["schema"] : 0,
      fileCount: typeof parsed["fileCount"] === "number" ? parsed["fileCount"] : 0,
      totalBytes: typeof parsed["totalBytes"] === "number" ? parsed["totalBytes"] : 0,
    };
  } catch {
    return null;
  }
}

export interface InstalledVersion {
  version: string;
  dir: string;
  profiles: string[];
  installedAt: string;
  fileCount: number;
  totalBytes: number;
  /** 最新一版（list 里标成「当前」）。 */
  current: boolean;
  /** true = 插件内置 flat 根（assets/manifest.json），false = DSH_STM32_ASSETS 下的历史版本目录。 */
  bundled: boolean;
}

/** 版本比较：按数字段比（2026.10.30-1 > 2026.9.1），非数字段按字典序。 */
export function compareVersions(a: string, b: string): number {
  const tokenize = (value: string): string[] => value.match(/\d+|[A-Za-z]+/gu) ?? [];
  const left = tokenize(a);
  const right = tokenize(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const l = left[index];
    const r = right[index];
    if (l === undefined) return r === undefined ? 0 : -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/u.test(l);
    const rn = /^\d+$/u.test(r);
    if (ln && rn) {
      const diff = Number(l) - Number(r);
      if (diff !== 0) return diff;
      continue;
    }
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

interface FlatState {
  manifest: AssetsManifest | null;
  error: string;
  present: boolean;
}

/** 读 flat 资源根的 manifest（有文件但坏了与根本没装要分开报）。 */
function readFlatManifest(dir: string): FlatState {
  const manifestPath = path.join(dir, ASSETS_MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) return { manifest: null, error: "", present: false };
  let text: string;
  try {
    text = fs.readFileSync(manifestPath, "utf8");
  } catch (error) {
    return { manifest: null, error: "内置资源 manifest 读不了（" + manifestPath + "）：" + errText(error), present: true };
  }
  const parsed = parseManifest(text);
  if (parsed.manifest === null) {
    return { manifest: null, error: "内置资源 manifest 坏了（" + manifestPath + "）：" + parsed.error, present: true };
  }
  return { manifest: parsed.manifest, error: "", present: true };
}

/**
 * 扫描本地有哪些资源版本（有新到旧）。flat 内置根排第一（current=true），
 * 然后是 DSH_STM32_ASSETS 下带 install.json 的历史版本目录（半成品不算）。
 */
export function listInstalledVersions(env: NodeJS.ProcessEnv = process.env, root?: string): InstalledVersion[] {
  const base = root !== undefined && root !== "" ? root : localAssetsRoot(env);
  const found: InstalledVersion[] = [];
  const flat = readFlatManifest(base);
  if (flat.manifest !== null) {
    const stats = scanDirStats(base, [ASSETS_MANIFEST_FILE]);
    found.push({
      version: flat.manifest.version,
      dir: base,
      profiles: Object.keys(flat.manifest.profiles).length > 0 ? Object.keys(flat.manifest.profiles) : ["core"],
      installedAt: "插件内置",
      fileCount: stats.files,
      totalBytes: stats.bytes,
      current: true,
      bundled: true,
    });
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return found;
  }
  const older: InstalledVersion[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    if (entry.name.includes(".tmp-")) continue;
    const dir = path.join(base, entry.name);
    const record = readInstallRecord(dir);
    if (record === null) continue;
    const stats = scanDirStats(dir, [ASSETS_MANIFEST_FILE, ASSETS_INSTALL_FILE]);
    older.push({
      version: record.version,
      dir,
      profiles: record.profiles.length > 0 ? record.profiles : ["core"],
      installedAt: record.installedAt,
      fileCount: stats.files,
      totalBytes: stats.bytes,
      current: found.length === 0,
      bundled: false,
    });
  }
  older.sort((left, right) => {
    const byVersion = compareVersions(right.version, left.version);
    if (byVersion !== 0) return byVersion;
    return right.installedAt.localeCompare(left.installedAt);
  });
  if (found.length === 0) {
    const first = older[0];
    if (first !== undefined) first.current = true;
  }
  return [...found, ...older];
}

export interface LocalManifestState {
  manifest: AssetsManifest | null;
  install: LocalInstallRecord | null;
  root: string;
  version: string;
  versionDir: string;
  error: string;
  /** true = 读的是插件内置 flat 根（没有 install.json），false = 历史版本目录。 */
  bundled: boolean;
}

/**
 * 读本地资源 manifest（默认内置 flat；指定 version 时到历史版本目录里找）。
 * 读不到/坏 JSON 不抛：返回 error 文本，调用方把「装坏了」讲清楚。
 */
export function readLocalManifest(env: NodeJS.ProcessEnv = process.env, version?: string): LocalManifestState {
  const info = assetsRootInfo(env);
  const wanted = (version ?? "").trim();
  const flat = readFlatManifest(info.root);
  const flatMatches = flat.manifest !== null && (wanted === "" || flat.manifest.version === wanted);
  if (flatMatches) {
    return {
      manifest: flat.manifest,
      install: null,
      root: info.root,
      version: flat.manifest?.version ?? "",
      versionDir: info.root,
      error: "",
      bundled: true,
    };
  }
  if (flat.present && wanted === "" && flat.manifest === null) {
    return {
      manifest: null,
      install: null,
      root: info.root,
      version: "",
      versionDir: info.root,
      error: flat.error + "。" + ASSETS_REFRESH_HINT,
      bundled: true,
    };
  }
  const versions = listInstalledVersions(env, info.root);
  const picked = wanted === "" ? versions[0] : versions.find((item) => item.version === wanted) ?? null;
  if (picked === undefined || picked === null) {
    return {
      manifest: null,
      install: null,
      root: info.root,
      version: "",
      versionDir: "",
      error: wanted === "" ? "找不到资源：" + info.root + " 下没有 manifest.json（" + ASSETS_REFRESH_HINT + "）" : "本地没有资源版本 " + wanted + "（action=list 看已装版本）",
      bundled: false,
    };
  }
  const manifestPath = path.join(picked.dir, ASSETS_MANIFEST_FILE);
  let text: string;
  try {
    text = fs.readFileSync(manifestPath, "utf8");
  } catch (error) {
    return {
      manifest: null,
      install: null,
      root: info.root,
      version: picked.version,
      versionDir: picked.dir,
      error: "资源 manifest 读不了（" + manifestPath + "）：" + errText(error) + "。" + ASSETS_REFRESH_HINT,
      bundled: picked.bundled,
    };
  }
  const parsed = parseManifest(text);
  if (parsed.manifest === null) {
    return {
      manifest: null,
      install: null,
      root: info.root,
      version: picked.version,
      versionDir: picked.dir,
      error: "资源 manifest 坏了（" + manifestPath + "）：" + parsed.error + "。" + ASSETS_REFRESH_HINT,
      bundled: picked.bundled,
    };
  }
  return {
    manifest: parsed.manifest,
    install: picked.bundled ? null : readInstallRecord(picked.dir),
    root: info.root,
    version: picked.version,
    versionDir: picked.dir,
    error: "",
    bundled: picked.bundled,
  };
}

/* --------------------------- 首次使用检查 --------------------------- */

export type EnsureAssetsStatus = "cache" | "refreshed" | "missing";

export interface EnsureAssetsOptions {
  /** 要检查哪个 profile（默认 core：设备事实 + ioc 模板 + 链接脚本）。 */
  profile?: string;
  env?: NodeJS.ProcessEnv;
  /** 已废弃：资源内置后不再下载；保留签名只为不惊动调用方。 */
  source?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface EnsureAssetsResult {
  ok: boolean;
  status: EnsureAssetsStatus;
  root: string;
  version: string;
  versionDir: string;
  /** 设备事实文件（device/f1/chips.json）的本地绝对路径；ok=false 时为空串。 */
  filePath: string;
  profile: string;
  /** 资源来源：内置 flat 为 bundled，历史版本目录为 cache。 */
  source: string;
  /** 保留字段（内置后恒为空数组），调用方输出 schema 还带着它。 */
  attempts: string[];
  message: string;
}

/**
 * 设备事实的就绪保证：读内置 assets/manifest.json，确认 device/f1/chips.json 真在磁盘上。
 *
 * 三条硬约定：
 *   · 不发网络请求（资源随包发布，没有任何需要下载的东西）；
 *   · 缺文件返回 ok:false + status="missing"，message 里一定有 ASSETS_REFRESH_HINT；
 *   · 只有 manifest 可读并且 device/f1/chips.json 确实落盘才算 ok。
 */
export async function ensureAssets(options: EnsureAssetsOptions = {}): Promise<EnsureAssetsResult> {
  const env = options.env ?? process.env;
  const normalizedProfile = normalizeProfile(options.profile) ?? "core";
  const state = readLocalManifest(env);
  const base = {
    root: state.root === "" ? assetsRootInfo(env).root : state.root,
    version: state.version,
    versionDir: state.versionDir,
    profile: normalizedProfile,
    source: state.bundled ? "bundled" : "cache",
    attempts: [] as string[],
  };
  if (state.manifest === null) {
    return {
      ok: false,
      status: "missing",
      ...base,
      filePath: "",
      message: "读不到内置资源：" + (state.error === "" ? "assets/manifest.json 不存在" : state.error) + "。" + ASSETS_REFRESH_HINT + "。",
    };
  }
  const filePath = path.join(state.versionDir, ASSETS_DEVICE_FACTS_FILE);
  if (!fs.existsSync(filePath)) {
    return {
      ok: false,
      status: "missing",
      ...base,
      filePath: "",
      message:
        "内置资源 " + state.version + " 里没有 " + ASSETS_DEVICE_FACTS_FILE + "（profile=" + normalizedProfile +
        "，资源目录 " + state.versionDir + "）：插件安装不完整。" + ASSETS_REFRESH_HINT + "。",
    };
  }
  return {
    ok: true,
    status: "cache",
    ...base,
    filePath,
    message:
      "设备事实来自" + (state.bundled ? "插件内置资源" : "本地资源缓存") + " " + state.version + "（" + filePath + "）",
  };
}

export interface ResolvedAssetFile {
  ok: boolean;
  /** 本地绝对路径（ok=false 时是空串）。 */
  path: string;
  version: string;
  bytes: number;
  error: string;
}

/**
 * 把"profile + 相对路径"解析成本地文件：要判断三件事——资源在不在、这份文件属不属于该 profile、
 * 本地文件在不在。三者都过才返回路径，否则给一句能照着修的话。
 */
export function resolveAssetFile(
  profile: AssetsProfile | string,
  relPath: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAssetFile {
  const empty = (error: string): ResolvedAssetFile => ({ ok: false, path: "", version: "", bytes: 0, error });
  const normalizedProfile = normalizeProfile(profile);
  if (normalizedProfile === null) return empty("不认识的 profile：" + String(profile) + "（只有 core / full）");
  const normalized = normalizeAssetPath(relPath);
  if (normalized === null) return empty("路径不合法：" + String(relPath) + "（必须是资源根内的相对路径）");
  const state = readLocalManifest(env);
  if (state.manifest === null) return empty(state.error === "" ? "找不到内置资源" : state.error);
  const entry = state.manifest.files.find((file) => file.path === normalized);
  if (entry === undefined) return empty("资源清单里没有这个文件：" + normalized + "（action=list 看这一版有哪些文件）");
  const allowed = profileFiles(state.manifest, normalizedProfile).some((file) => file.path === normalized);
  if (!allowed) {
    return empty(
      "文件 " + normalized + " 不在 profile=" + normalizedProfile + " 里（它属于 profile=" + entry.profile + "）；用 profile=full 查一次。",
    );
  }
  const localPath = path.join(state.versionDir, normalized);
  try {
    const stat = fs.statSync(localPath);
    if (!stat.isFile()) return empty("本地路径不是文件：" + localPath + "。" + ASSETS_REFRESH_HINT);
    return { ok: true, path: localPath, version: state.version, bytes: stat.size, error: "" };
  } catch {
    return empty("本地缺这个文件：" + localPath + "（资源 " + state.version + "）。" + ASSETS_REFRESH_HINT);
  }
}

export interface VerifyFileResult {
  path: string;
  bytes: number;
  sha256: string;
  status: "ok" | "missing" | "changed";
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  root: string;
  version: string;
  versionDir: string;
  profile: string;
  files: VerifyFileResult[];
  fileCount: number;
  /** 校验通过的文件字节数合计。 */
  totalBytes: number;
  message: string;
}

/** 逐文件 sha256 复核本地资源。缺文件算 missing，哈希/大小不对算 changed。 */
export function verifyInstalled(request: { profile?: string; env?: NodeJS.ProcessEnv; version?: string; root?: string } = {}): VerifyResult {
  const env = request.env ?? process.env;
  const profile = normalizeProfile(request.profile);
  const info = assetsRootInfo(env);
  const state = readLocalManifest(env, request.version);
  const common = {
    root: info.root,
    version: state.version,
    versionDir: state.versionDir,
    profile: profile ?? (request.profile ?? "").trim(),
    files: [] as VerifyFileResult[],
    fileCount: 0,
    totalBytes: 0,
  };
  if (profile === null) return { ...common, ok: false, message: "不认识的 profile：" + String(request.profile) + "（只有 core / full）。" };
  if (state.manifest === null) return { ...common, ok: false, message: state.error + (state.error === "" ? "" : "。") };
  const targets = profileFiles(state.manifest, profile);
  let bad = 0;
  for (const target of targets) {
    const localPath = path.join(state.versionDir, target.path);
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(localPath);
    } catch {
      bad += 1;
      common.files.push({ path: target.path, bytes: 0, sha256: "", status: "missing", detail: "本地缺这个文件（重装插件修复）" });
      continue;
    }
    const actual = sha256Hex(buffer);
    if (actual !== target.sha256 || (target.bytes > 0 && buffer.byteLength !== target.bytes)) {
      bad += 1;
      common.files.push({
        path: target.path,
        bytes: buffer.byteLength,
        sha256: actual,
        status: "changed",
        detail: "sha256 对不上（期望 " + shortHash(target.sha256) + "，实际 " + shortHash(actual) + "）",
      });
      continue;
    }
    common.files.push({ path: target.path, bytes: buffer.byteLength, sha256: actual, status: "ok", detail: "" });
    common.totalBytes += buffer.byteLength;
  }
  common.fileCount = common.files.length;
  return {
    ...common,
    ok: bad === 0 && common.files.length > 0,
    message:
      "校验 " + state.version + "（profile=" + profile + "）：" + String(common.files.length) + " 个文件里 " +
      String(bad) + " 个有问题" + (bad === 0 ? "，全部对得上。" : "。重装插件即可恢复（内置资源不能被 refresh 改写）。"),
  };
}

export interface PruneResult {
  removed: string[];
  kept: string[];
  reclaimedBytes: number;
  message: string;
}

/**
 * 只清 DSH_STM32_ASSETS 下 .tmp-* 与超出 keep 的历史版本目录；内置 flat 根永不删。
 * 版本按版本号排序，不按目录名，避免 "2026.9.1" 排到 "2026.10.30" 后面。
 */
export function pruneOldVersions(env: NodeJS.ProcessEnv = process.env, keep = 2, root?: string): PruneResult {
  const info = assetsRootInfo(env);
  const base = root !== undefined && root !== "" ? root : info.root;
  const bundledRoot = path.resolve(bundledAssetsRoot());
  if (path.resolve(base) === bundledRoot) {
    return {
      removed: [],
      kept: [],
      reclaimedBytes: 0,
      message: "资源随插件内置（" + base + "），没有可清理的历史版本；内置文件不会被删除。",
    };
  }
  const versions = listInstalledVersions(env, base).filter((item) => !item.bundled);
  const keepCount = Math.max(1, Math.floor(keep));
  const removed: string[] = [];
  const kept: string[] = [];
  let reclaimedBytes = 0;
  versions.forEach((item, index) => {
    if (index < keepCount) {
      kept.push(item.version);
      return;
    }
    const stats = scanDirStats(item.dir);
    try {
      fs.rmSync(item.dir, { recursive: true, force: true });
      removed.push(item.version);
      reclaimedBytes += stats.bytes;
    } catch {
      // 删不掉的版本保留在磁盘上，但也不谎报 removed。
    }
  });
  try {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.includes(".tmp-")) continue;
      const dir = path.join(base, entry.name);
      const stats = scanDirStats(dir);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        reclaimedBytes += stats.bytes;
      } catch {
        // 同上。
      }
    }
  } catch {
    // 根目录不存在：没什么可清的。
  }
  const message =
    versions.length === 0
      ? "DSH_STM32_ASSETS 下没有历史版本，没什么可清理的（内置资源不受影响）。"
      : removed.length === 0
        ? "保留 " + kept.join("、") + "（不超过 " + String(keepCount) + " 个版本），没有旧版本要删。"
        : "删掉 " + String(removed.length) + " 个旧版本（" + removed.join("、") + "），回收 " + String(reclaimedBytes) + " 字节；保留 " + kept.join("、") + "。";
  return { removed, kept, reclaimedBytes, message };
}
