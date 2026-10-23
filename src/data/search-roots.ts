/**
 * 工具链搜索配置。
 *
 * 设计约定：路径是数据，不是逻辑。候选按优先级来自三处：
 *   1. 工具参数（binDirs / cubeMxRoots）—— 调用方显式指定，最高优先；
 *   2. 环境变量（STM32_BIN_DIRS / STM32_CUBEMX_ROOT）—— **整份替换**默认值，不合并；
 *   3. 默认候选表（DEFAULT_BIN_DIRS / DEFAULT_CUBEMX_ROOTS，本机常见安装位置）。
 * 之后再把**自动发现到的**安装目录追加到尾部：只做兜底，不覆盖上面任何一处，
 * 这样别人把 MSYS2 装在 E:\\msys64、CubeMX 装在 F:\\tools 也能直接跑。
 * 设 STM32_NO_DISCOVER=1 可关掉自动发现（CI / 单测里避免扫盘）。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";

export interface SearchConfig {
  /** 优先在这些目录里找裸命令名（gcc/openocd/...）。 */
  binDirs: string[];
  /** STM32CubeMX 安装根目录候选。 */
  cubeMxRoots: string[];
}

/** 自动发现到的安装位置（与默认值/环境变量分开，便于 doctor 展示）。 */
export interface DiscoveredInstalls {
  binDirs: string[];
  cubeMxRoots: string[];
}

/** 默认二进制目录：用户已确认的偏好是 msys64 优先。 */
export const DEFAULT_BIN_DIRS: readonly string[] = [
  "D:/app/msys64/ucrt64/bin",
  "C:/msys64/ucrt64/bin",
  "C:/msys64/mingw64/bin",
];

/** 默认 CubeMX 安装根目录候选（6.x）。 */
export const DEFAULT_CUBEMX_ROOTS: readonly string[] = [
  "D:/app/STM32CubeMX",
  "C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeMX",
];

/**
 * 规范化一条路径条目：去首尾引号（setx 时常被一起写进去）、反斜杠转正斜杠、
 * 折叠重复的斜杠、去掉尾部斜杠（盘根 "D:/" 除外）。
 */
export function normalizePathEntry(raw: string): string {
  let value = raw.trim();
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
  if (quoted && value.length >= 2) value = value.slice(1, -1).trim();
  if (value === "") return "";
  value = value.replace(/\\/gu, "/").replace(/\/{2,}/gu, "/");
  const isDriveRoot = /^[A-Za-z]:\/$/u.test(value);
  if (!isDriveRoot && value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);
  return value;
}

export function splitList(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  return value
    .split(";")
    .map((entry) => normalizePathEntry(entry))
    .filter((entry) => entry !== "");
}

/** 去重（Windows 路径大小写不敏感，尾部斜杠不影响同一性），保持首次出现的顺序。 */
export function dedupePaths(paths: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of paths) {
    const normalized = normalizePathEntry(candidate);
    if (normalized === "") continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

/** 一个目录是不是 CubeMX 安装根：无头调用需要 <root>/jre/bin/java.exe 与 <root>/STM32CubeMX.exe。 */
export function looksLikeCubeMxRoot(dir: string, exists: (path: string) => boolean = existsSync): boolean {
  return exists(dir + "/jre/bin/java.exe") && exists(dir + "/STM32CubeMX.exe");
}

/** 一个目录是不是能用的工具链 bin（至少有一个我们要的 exe）。 */
export function looksLikeBinDir(dir: string, exists: (path: string) => boolean = existsSync): boolean {
  return ["arm-none-eabi-gcc.exe", "openocd.exe", "cmake.exe"].some((name) => exists(dir + "/" + name));
}

/** 发现过程需要的系统能力；抽出来是为了单测能注入假文件系统。 */
export interface DiscoverProbe {
  exists(path: string): boolean;
  /** 目录的直接子目录（绝对路径）；读不了返回空数组。 */
  listDirs(dir: string): string[];
  /** 注册表里登记的安装目录（Windows）；其他平台返回空数组。 */
  registryInstallDirs(): string[];
  /** 要扫的盘符根，形如 ["C:", "D:"]（不带斜杠）。 */
  driveRoots(): string[];
  /** 用户级安装根，如 %LOCALAPPDATA%/Programs。 */
  userProgramDirs(): string[];
}

const MSYS_VARIANTS: readonly string[] = ["ucrt64/bin", "mingw64/bin", "clang64/bin"];

function msysBases(probe: DiscoverProbe): string[] {
  const bases: string[] = [];
  for (const drive of probe.driveRoots()) {
    bases.push(drive + "/msys64", drive + "/msys2", drive + "/app/msys64", drive + "/tools/msys64");
  }
  for (const dir of probe.userProgramDirs()) bases.push(dir + "/msys64");
  return bases;
}

/** 在常见安装位置里找 MSYS2 的 ucrt64/mingw64/clang64 bin。 */
export function discoverBinDirs(probe: DiscoverProbe): string[] {
  const found: string[] = [];
  for (const base of msysBases(probe)) {
    for (const variant of MSYS_VARIANTS) {
      const dir = base + "/" + variant;
      if (looksLikeBinDir(dir, probe.exists)) found.push(dir);
    }
  }
  return dedupePaths(found);
}

function cubeMxBases(probe: DiscoverProbe): string[] {
  const bases: string[] = [];
  for (const drive of probe.driveRoots()) {
    bases.push(
      drive + "/",
      drive + "/app",
      drive + "/tools",
      drive + "/Program Files/STMicroelectronics/STM32Cube",
      drive + "/Program Files (x86)/STMicroelectronics/STM32Cube",
    );
  }
  for (const dir of probe.userProgramDirs()) bases.push(dir);
  return bases;
}

/** 在常见安装位置里找 CubeMX 根目录（注册表优先，其次扫目录）。 */
export function discoverCubeMxRoots(probe: DiscoverProbe): string[] {
  const found: string[] = [];
  for (const dir of probe.registryInstallDirs()) {
    const normalized = normalizePathEntry(dir);
    if (normalized !== "" && looksLikeCubeMxRoot(normalized, probe.exists)) found.push(normalized);
  }
  for (const base of cubeMxBases(probe)) {
    const direct = base.replace(/\/+$/u, "") + "/STM32CubeMX";
    if (looksLikeCubeMxRoot(direct, probe.exists)) found.push(direct);
    for (const child of probe.listDirs(base)) {
      if (looksLikeCubeMxRoot(child, probe.exists)) found.push(child);
    }
  }
  return dedupePaths(found);
}

/** 读注册表里 ST 记下的安装位置；没有这些键是最常见的情况，不算错误。 */
function readRegistryInstallDirs(): string[] {
  if (process.platform !== "win32") return [];
  const keys: ReadonlyArray<{ key: string; value: string }> = [
    { key: "HKLM\\SOFTWARE\\STMicroelectronics\\STM32CubeMX", value: "InstallDir" },
    { key: "HKLM\\SOFTWARE\\WOW6432Node\\STMicroelectronics\\STM32CubeMX", value: "InstallDir" },
    { key: "HKCU\\SOFTWARE\\STMicroelectronics\\STM32CubeMX", value: "InstallDir" },
    { key: "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\STM32CubeMX", value: "InstallLocation" },
  ];
  const out: string[] = [];
  for (const entry of keys) {
    try {
      const text = execFileSync("reg.exe", ["query", entry.key, "/v", entry.value], {
        encoding: "utf8",
        timeout: 4000,
        windowsHide: true,
        // 键不存在时 reg 会往 stderr 写字；默认继承会让这堆噪音漏到调用方终端里。
        stdio: ["ignore", "pipe", "pipe"],
      });
      for (const line of text.split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith(entry.value)) continue;
        const parts = trimmed.split(/\s{2,}/u);
        const dir = parts[parts.length - 1];
        if (dir !== undefined && dir.trim() !== "") out.push(dir.trim());
      }
    } catch {
      // 键或值不存在：正常情况
    }
  }
  return out;
}

/** 真实系统的探针。 */
export function defaultDiscoverProbe(): DiscoverProbe {
  return {
    exists: (path) => existsSync(path),
    listDirs: (dir) => {
      try {
        const base = dir.replace(/\/+$/u, "");
        return readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => base + "/" + entry.name);
      } catch {
        return [];
      }
    },
    registryInstallDirs: readRegistryInstallDirs,
    driveRoots: () => {
      if (process.platform !== "win32") return ["/"];
      const roots: string[] = [];
      for (let code = "C".charCodeAt(0); code <= "Z".charCodeAt(0); code += 1) {
        const drive = String.fromCharCode(code) + ":";
        if (existsSync(drive + "/")) roots.push(drive);
      }
      return roots;
    },
    userProgramDirs: () => {
      const local = process.env["LOCALAPPDATA"];
      return local === undefined || local.trim() === "" ? [] : [normalizePathEntry(local) + "/Programs"];
    },
  };
}

let cached: DiscoveredInstalls | null = null;

/** 自动发现（进程内只扫一次：扫盘 + reg 查询没必要每次调用都重做）。 */
export function discoverInstalls(): DiscoveredInstalls {
  if (cached === null) {
    const probe = defaultDiscoverProbe();
    cached = {
      binDirs: discoverBinDirs(probe),
      cubeMxRoots: discoverCubeMxRoots(probe),
    };
  }
  return cached;
}

/** 清掉缓存（单测 / 换机器后重挂载时用）。 */
export function resetDiscoveryCache(): void {
  cached = null;
}

/** 是否关掉了自动发现（STM32_NO_DISCOVER=1）。 */
export function discoveryDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const flag = env["STM32_NO_DISCOVER"];
  return flag === "1" || flag === "true";
}

/** 错误消息里"查过哪些地方"的统一写法；tail 用来补充非目录来源（如 PATH）。 */
export function describeSearchScope(paths: readonly string[], tail?: string): string {
  const list = paths.length === 0 ? "（没有候选目录）" : paths.join("、");
  return tail === undefined ? list : list + "，以及 " + tail;
}

/**
 * 环境变量或显式参数覆盖默认搜索配置。
 *
 * 优先级：显式参数 > 环境变量（整份替换，分号分隔）> 默认常量。
 * 自动发现的安装只追加在"没给显式参数"的那一档尾部：用参数点名目录时说明调用方
 * 心里有确切位置，再混进别处的同名工具会让"我明明指定了"变成假的。
 */
export function resolveSearchConfig(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<SearchConfig> = {},
  /** 单测注入用；生产代码不要传。 */
  discoveredOverride?: DiscoveredInstalls,
): SearchConfig {
  const binFromEnv = splitList(env["STM32_BIN_DIRS"]);
  const rootsFromEnv = splitList(env["STM32_CUBEMX_ROOT"]);
  const discovered = discoveryDisabled(env)
    ? { binDirs: [], cubeMxRoots: [] }
    : (discoveredOverride ?? discoverInstalls());
  const binBase = overrides.binDirs ?? (binFromEnv.length > 0 ? binFromEnv : [...DEFAULT_BIN_DIRS]);
  const rootsBase = overrides.cubeMxRoots ?? (rootsFromEnv.length > 0 ? rootsFromEnv : [...DEFAULT_CUBEMX_ROOTS]);
  return {
    binDirs: dedupePaths([...binBase, ...(overrides.binDirs === undefined ? discovered.binDirs : [])]),
    cubeMxRoots: dedupePaths([...rootsBase, ...(overrides.cubeMxRoots === undefined ? discovered.cubeMxRoots : [])]),
  };
}
