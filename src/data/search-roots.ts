/**
 * 工具链搜索配置。
 *
 * 设计约定：路径是数据，不是逻辑。候选按优先级来自四处：
 *   1. 工具参数（binDirs / cubeMxRoots）—— 调用方显式指定，最高优先；
 *   2. 环境变量（STM32_BIN_DIRS / STM32_CUBEMX_ROOT）—— **整份替换**下面的值，不合并；
 *   3. 用户配置文件（toolchain-config：stm32_env_install 装好后自己写的，见下）——
 *      也整份替换默认值，但排在环境变量之后（环境变量是临时/脚本场景的活开关）；
 *   4. 默认候选表（DEFAULT_BIN_DIRS / DEFAULT_CUBEMX_ROOTS，本机常见安装位置）。
 * 之后再把**自动发现到的**安装目录追加到尾部：只做兜底，不覆盖上面任何一处，
 * 这样别人把 MSYS2 装在 E:\\msys64、CubeMX 装在 F:\\tools 也能直接跑。
 * 设 STM32_NO_DISCOVER=1 可关掉自动发现（CI / 单测里避免扫盘）；
 * 设 DSH_STM32_NO_CONFIG=1 可让第 3 档失效（单测里保证不读本机配置）。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";

import { binDirsFromConfig, configReadingDisabled, cubeMxRootsFromConfig, readToolchainConfig } from "./toolchain-config.js";

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

/**
 * 默认二进制目录：只放**任何 Windows 机器上都可能存在**的位置。
 *
 * 这里绝不能出现开发机专属路径（D:/app/msys64 之类）：插件是给别人下载的，
 * 那些路径在别人机器上必然搜不到，还会把「查过哪些地方」的文案污染成别人看不懂的样子。
 * 装在别处的情况由自动发现兜底（扫盘符 msys64/app/msys64/tools 等常见布局）。
 */
export const DEFAULT_BIN_DIRS: readonly string[] = [
  "C:/msys64/ucrt64/bin",
  "C:/msys64/mingw64/bin",
];

/** 默认 CubeMX 安装根目录候选（6.x 的 Windows 默认安装位置）。 */
export const DEFAULT_CUBEMX_ROOTS: readonly string[] = [
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

/** 解码结果：ok=false 时 text 一律是空串——调用方只能当"读不到"，绝不许拿它去比对或写回。 */
export interface RegistryTextDecode {
  ok: boolean;
  text: string;
  /** 实际用的解码方式；没解出来时是空串（"没试过"与"试了失败"不混）。 */
  encoding: "utf-8" | "gb18030" | "";
  error: string;
}

/** 解码失败的痕迹：非法字节被换成 U+FFFD。 */
const REPLACEMENT_CHAR = "\u{FFFD}";

/**
 * 把 reg.exe 的输出（原始字节，或已经被宿主解码过的字符串）变成可用文本。
 *
 * 为什么必须有这一步：reg.exe 是控制台程序，输出到管道/文件时用的是系统 ANSI 代码页
 * （中文 Windows 是 936/GBK），而宿主按 UTF-8 解码子进程 stdout。中文用户名下的安装路径
 * 于是变成一串 U+FFFD：existsSync 必然失败（CubeMX 发现退化成目录扫描），更糟的是这串乱码
 * 会被当成"用户原来的 PATH 旧值"原样写回注册表，把用户原有的中文条目永久写坏。
 *
 * 为什么按顺序探测而不是先读代码页：零依赖下拿不到 GetConsoleOutputCP / GetACP，而
 * "UTF-8 严格解码失败才回落 GB18030"对纯 ASCII 输出永远成立（两种编码对 ASCII 等价），
 * 只有真的有非 ASCII 字节时才需要判断，判断依据也就只有"解不解得出来"。
 * 两种都解不出来就返回 ok:false —— 宁可让用户手写一条，也不把乱码写进注册表。
 *
 * 备选方案（没采用）：用 powershell 先把 [Console]::OutputEncoding 设成 UTF8 再调 reg.exe。
 * 不用的原因：多一层 PowerShell 启动开销与引号转义，而且字节其实已经拿到了，直接探测更短。
 */
export function decodeRegistryText(
  value: string | Uint8Array | null | undefined,
  label = "reg.exe 输出",
): RegistryTextDecode {
  if (value === null || value === undefined) {
    return { ok: false, text: "", encoding: "", error: label + "是空的（什么都没读到）" };
  }
  if (typeof value === "string") {
    // 宿主已经用 UTF-8 解过一遍：真乱码在这里就已经变成 U+FFFD 了，原始字节救不回来。
    if (value.includes(REPLACEMENT_CHAR)) {
      return {
        ok: false,
        text: "",
        encoding: "",
        error: label + "里有无法解码的字节（已被替换成乱码字符），系统代码页可能不是 UTF-8",
      };
    }
    return { ok: true, text: value, encoding: "utf-8", error: "" };
  }
  if (value.length === 0) {
    return { ok: false, text: "", encoding: "", error: label + "是空的（什么都没读到）" };
  }
  for (const encoding of ["utf-8", "gb18030"] as const) {
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(value);
      if (text.includes(REPLACEMENT_CHAR)) continue;
      return { ok: true, text, encoding, error: "" };
    } catch {
      // 这个编码解不出来，试下一个
    }
  }
  return {
    ok: false,
    text: "",
    encoding: "",
    error: label + "既不是合法 UTF-8 也不是合法 GB18030（系统代码页可能不是中文/英文）",
  };
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
      // 按 buffer 收：reg.exe 写的是系统代码页的字节（中文系统是 GBK），交给宿主按 UTF-8
      // 解会把中文安装路径变成乱码，existsSync 随后必然失败。
      const raw = execFileSync("reg.exe", ["query", entry.key, "/v", entry.value], {
        encoding: "buffer",
        timeout: 4000,
        windowsHide: true,
        // 键不存在时 reg 会往 stderr 写字；默认继承会让这堆噪音漏到调用方终端里。
        stdio: ["ignore", "pipe", "pipe"],
      });
      const decoded = decodeRegistryText(raw, "reg query " + entry.key + " /v " + entry.value);
      // 解不出来就当这条没读到：一串乱码路径交给 existsSync 只是污染"查过哪些地方"的说明。
      if (!decoded.ok) continue;
      for (const line of decoded.text.split(/\r?\n/u)) {
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

/** 一条「点名了、本机却没有」的搜索结果告警。 */
export interface SearchConfigWarning {
  /** 目录从哪来：config = ~/.dsh-stm32/config.json，env = 环境变量。 */
  source: "config" | "env";
  /** 那个不存在的路径。 */
  path: string;
  /** 一句话人话（可直接贴进报告/notes）。 */
  message: string;
}

/**
 * 只读检查：配置/环境变量里点名的目录在这台机器上到底有没有。
 *
 * 为什么需要这一层：插件是给别人下载的，配置也可能从别的机器拷过来（D:/app/msys64 这种
 * 开发机专属路径）。这种路径不会让程序崩，但会让用户以为"我明明配了却没生效"。
 * 这里**只报告、不删条目**：路径可能是还没装（装完就存在），删掉反而抹掉用户意图。
 */
export function searchConfigWarnings(
  env: Record<string, string | undefined> = process.env,
  exists: (path: string) => boolean = existsSync,
): SearchConfigWarning[] {
  const warnings: SearchConfigWarning[] = [];
  const seen = new Set<string>();
  const push = (source: "config" | "env", raw: string): void => {
    const path = normalizePathEntry(raw);
    if (path === "" || seen.has(path.toLowerCase()) || exists(path)) return;
    seen.add(path.toLowerCase());
    warnings.push({
      source,
      path,
      message:
        (source === "config" ? "配置文件里的 " : "环境变量里的 ") +
        path +
        " 在本机不存在（配置可能是从别的机器拷来的），这一条搜不到工具；换机器后重跑 stm32_env_install，或手改 " +
        (source === "config" ? "~/.dsh-stm32/config.json（DSH_STM32_CONFIG 可改位置）" : "STM32_BIN_DIRS / STM32_CUBEMX_ROOT"),
    });
  };

  for (const dir of splitList(env["STM32_BIN_DIRS"])) push("env", dir);
  for (const dir of splitList(env["STM32_CUBEMX_ROOT"])) push("env", dir);

  const config = configReadingDisabled(env) ? null : readToolchainConfig(env).config;
  if (config !== null) {
    if (config.msys64 !== "") push("config", config.msys64);
    for (const dir of config.binDirs) push("config", dir);
    if (config.cubeMxRoot !== "") push("config", config.cubeMxRoot);
  }
  return warnings;
}

/**
 * 显式参数 / 环境变量 / 用户配置覆盖默认搜索配置。
 *
 * 优先级：显式参数 > 环境变量（整份替换，分号分隔）> 用户配置文件（整份替换）> 默认常量。
 * 自动发现的安装只追加在"没给显式参数"的那一档尾部：用参数点名目录时说明调用方
 * 心里有确切位置，再混进别处的同名工具会让"我明明指定了"变成假的。
 *
 * 用户配置文件在这里读，是因为**这一层是唯一的汇聚点**：所有工具/引擎都经过它，
 * 装完工具链后不必改任何调用方就能立即生效（不需要重启 DSH：路径是我们自己读的）。
 */
export function resolveSearchConfig(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<SearchConfig> = {},
  /** 单测注入用；生产代码不要传。 */
  discoveredOverride?: DiscoveredInstalls,
): SearchConfig {
  const binFromEnv = splitList(env["STM32_BIN_DIRS"]);
  const rootsFromEnv = splitList(env["STM32_CUBEMX_ROOT"]);
  const userConfig = configReadingDisabled(env) ? null : readToolchainConfig(env).config;
  const binFromConfig = binDirsFromConfig(userConfig);
  const rootsFromConfig = cubeMxRootsFromConfig(userConfig);
  const discovered = discoveryDisabled(env)
    ? { binDirs: [], cubeMxRoots: [] }
    : (discoveredOverride ?? discoverInstalls());
  const binBase = overrides.binDirs
    ?? (binFromEnv.length > 0
      ? binFromEnv
      : (binFromConfig.length > 0 ? binFromConfig : [...DEFAULT_BIN_DIRS]));
  const rootsBase = overrides.cubeMxRoots
    ?? (rootsFromEnv.length > 0
      ? rootsFromEnv
      : (rootsFromConfig.length > 0 ? rootsFromConfig : [...DEFAULT_CUBEMX_ROOTS]));
  return {
    binDirs: dedupePaths([...binBase, ...(overrides.binDirs === undefined ? discovered.binDirs : [])]),
    cubeMxRoots: dedupePaths([...rootsBase, ...(overrides.cubeMxRoots === undefined ? discovered.cubeMxRoots : [])]),
  };
}
