/**
 * MSYS2 安装器（L2）：把"这台机器缺工具链"从一句建议变成一次可复核的安装。
 *
 * 三条设计红线，都是为了"只做用户授权过的事"：
 *   1. 默认只出计划。计划里连目标目录都不建、配置不写、注册表不碰——真装要写几百 MB 磁盘
 *      还要改用户级 PATH，这种动作必须由用户明确点一次（工具层 dryRun:false + confirm:true）。
 *   2. 绝不请求管理员。PATH 只改 HKCU\Environment（用户级），不碰 HKLM；也不用 setx
 *      （setx 会在 1024 字符处截断 PATH，还会丢掉 REG_EXPAND_SZ 的变量展开语义）。
 *   3. 不做卸载，也不删用户的任何东西。只清理自己建的暂存目录与 .part 半成品；目标目录非空
 *      就停下来报警——宁可让用户换目录，也不猜"这个 msys64 目录能不能覆盖"。
 *
 * 为什么装完不需要用户重读环境变量：插件自己读工具链配置（data/toolchain-config）里的绝对
 * 路径，装完立刻生效；PATH 只是顺手给命令行和其他工具用的。
 *
 * 下载只用系统 curl、解压只用官方 sfx，不引第三方包（插件保持零运行时依赖）。
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  DEFAULT_BIN_DIRS,
  decodeRegistryText,
  dedupePaths,
  discoverInstalls,
  discoveryDisabled,
  normalizePathEntry,
  splitList,
} from "../data/search-roots.js";
import {
  readToolchainConfig,
  toolchainConfigPath,
  updateToolchainConfig,
  type ToolchainConfig,
} from "../data/toolchain-config.js";
import type { SubprocessService } from "../types.js";
import { buildTargets, probeAll, type ProbeResult } from "./probe.js";
import { runCapture, type RunOutcome } from "./subprocess-runner.js";

/** 下载/解压/补包都是分钟级：默认给 15 分钟，调用方可用 timeoutMs 覆盖。 */
const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60_000;
/** 自检只跑版本命令，不该慢。 */
const PROBE_TIMEOUT_MS = 15_000;
/**
 * pacman -Q 的预算：比版本命令宽得多。MSYS2 的 pacman 在本机实测要 6–11 s
 * （bash -lc 起一遍 profile 更慢），拿 15 s 去问必然超时，计划就又把「已装齐」说成「缺 5 个」。
 */
const PACMAN_QUERY_TIMEOUT_MS = 60_000;

const WINDOWS = process.platform === "win32";

/**
 * 官方自解压包。名字里必须带 base：GitHub releases 上**没有** msys2-x86_64-latest.sfx.exe
 * 这个资产（msys2-x86_64-latest.exe 是图形安装器），sfx 只有 msys2-base-x86_64-latest.sfx.exe。
 * 它解压出一个顶层 msys64 目录，所以官方文档写 -y -oC:\ 就会得到 C:\msys64。
 */
const INSTALLER_FILE = "msys2-base-x86_64-latest.sfx.exe";
export const MSYS2_INSTALLER_URL =
  "https://github.com/msys2/msys2-installer/releases/latest/download/" + INSTALLER_FILE;

/** 该资产的字节数（实测 43,060,392）；只用于计划里的用量估算，不参与校验。 */
export const MSYS2_INSTALLER_BYTES = 43_060_392;

/** 默认补的包：编译器 / 调试器 / 烧录服务端 / 构建系统 / 构建工具。 */
export const DEFAULT_MSYS2_PACKAGES: readonly string[] = [
  "mingw-w64-ucrt-x86_64-arm-none-eabi-gcc",
  "mingw-w64-ucrt-x86_64-gdb-multiarch",
  "mingw-w64-ucrt-x86_64-openocd",
  "mingw-w64-ucrt-x86_64-cmake",
  "mingw-w64-ucrt-x86_64-ninja",
];

/** 配置与自动发现都没有时建议装这里；只作为建议，不自动采用（"装到哪"得用户点头）。 */
export const MSYS2_SUGGESTED_ROOT = "C:/msys64";

/** 自检关注的 5 个组件（覆盖 toolchain-gate 的 build/flash/debug 三项能力）。 */
const VERIFY_IDS: readonly string[] = ["gcc", "cmake", "ninja", "openocd", "gdb"];

/** 每步的 id + 人话标签；顺序就是执行顺序。 */
const STEP_DEFS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "prepare", label: "准备安装目录" },
  { id: "download", label: "下载 MSYS2 安装包" },
  { id: "extract", label: "静默解压到目标目录" },
  { id: "pacman", label: "pacman 补装工具链组件" },
  { id: "path", label: "写用户级 PATH" },
  { id: "verify", label: "自检 5 个组件" },
  { id: "config", label: "写入工具链配置" },
];

/** 单包下载字节估算；只用于"计划总量"那句话，缺省值给个数量级即可。 */
const PACKAGE_BYTES: Readonly<Record<string, number>> = {
  "mingw-w64-ucrt-x86_64-arm-none-eabi-gcc": 62_000_000,
  "mingw-w64-ucrt-x86_64-gdb-multiarch": 22_000_000,
  "mingw-w64-ucrt-x86_64-openocd": 3_000_000,
  "mingw-w64-ucrt-x86_64-cmake": 33_000_000,
  "mingw-w64-ucrt-x86_64-ninja": 600_000,
};
const PACKAGE_BYTES_DEFAULT = 10_000_000;

const PATH_KEY = "HKCU\\Environment";

export interface Msys2InstallStep {
  id: string;
  label: string;
  status: "pending" | "running" | "done" | "skipped" | "failed";
  detail: string;
}

export interface Msys2InstallRequest {
  mode: "plan" | "install";
  targetDir?: string;
  packages?: string[];
  writePath: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (line: string) => void;
}

export interface Msys2InstallDownload {
  url: string;
  bytes: number;
  cached: boolean;
}

export interface Msys2InstallPathState {
  done: boolean;
  changed: boolean;
  before: string;
  after: string;
  backup: string;
  error: string;
}

export interface Msys2InstallConfigState {
  path: string;
  written: boolean;
  error: string;
}

export interface Msys2InstallVerifyState {
  ok: boolean;
  tools: { id: string; label: string; found: boolean; version: string }[];
}

export interface Msys2InstallResult {
  ok: boolean;
  mode: "plan" | "install";
  needsDecision: "" | "msys64Dir";
  /** 实际/计划安装根（正斜杠绝对路径）；needsDecision 时为空串。 */
  msys64: string;
  /** 这个根从哪来：arg / config / discovered / suggested / ""。 */
  resolvedVia: "arg" | "config" | "discovered" | "suggested" | "";
  binDirs: string[];
  packages: string[];
  steps: Msys2InstallStep[];
  download: Msys2InstallDownload | null;
  path: Msys2InstallPathState;
  config: Msys2InstallConfigState;
  verify: Msys2InstallVerifyState;
  message: string;
  nextStep: string;
  notes: string[];
  durationMs: number;
}

/* ------------------------------ 小工具 ------------------------------ */

function toPosix(value: string): string {
  return normalizePathEntry(value);
}

function toWindowsDir(dir: string): string {
  return dir.replace(/\//gu, "\\");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 人读的体量；估算值也走这里，保证卡片上单位一致。
 * 十进制（1 MB = 1e6 B）：GitHub release 页面和 pacman 的 "Total Download Size" 都是十进制，
 * 用 1024 进制会凭空多报 4.86%，用户对不上号（43 060 392 B 应显示 43.1 MB，不是 41.1 MB）。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const value = bytes / 1_000_000;
  return (value >= 100 ? value.toFixed(0) : value.toFixed(1)) + " MB";
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed === "") continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/** 取最后一行非空内容：把子进程噪音压成一句给用户看。 */
function lastLine(text: string): string {
  const lines = text.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmed = (lines[index] ?? "").trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

function fileSize(path: string): number {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

/**
 * 缓存是不是一个真的 exe（MZ 头）。
 * 为什么查：下载中断留下的半截文件若只按 size>0 判断，会被下一次当成有效缓存，
 * 于是解压永远失败，用户只能自己猜该删哪个文件。
 */
function looksLikeExecutable(path: string): boolean {
  if (fileSize(path) < 2) return false;
  let fd = -1;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(2);
    const read = readSync(fd, buffer, 0, 2, 0);
    return read === 2 && buffer[0] === 0x4d && buffer[1] === 0x5a;
  } catch {
    return false;
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // 关不掉不影响结论
      }
    }
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function removeFileQuietly(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // 清理失败不影响主结论
  }
}

/**
 * 清掉暂存目录/半成品。
 * 只对**我们自己建的**路径调用（.part 与 .dsh-msys2-staging）：用户的东西一个都不删。
 */
function removeDirQuietly(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 删不掉就留着，不影响结论
  }
}

function isMsys2Root(dir: string): boolean {
  return dir !== "" && existsSync(dir + "/usr/bin/bash.exe");
}

function msys2PackagesTotal(packages: readonly string[]): number {
  let total = 0;
  for (const name of packages) total += PACKAGE_BYTES[name] ?? PACKAGE_BYTES_DEFAULT;
  return total;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/* -------------------------- 安装包地址与缓存 -------------------------- */

export interface UrlResolution {
  url: string;
  /** 这个地址是怎么来的：写进 notes，用户才知道自己设的变量生效没有。 */
  note: string;
}

/**
 * 安装包地址：MSYS2_INSTALLER_URL 整体替换 > MSYS2_MIRROR 前缀替换 > 官方地址。
 * MSYS2_MIRROR 允许两种写法：给全（以 .exe/.7z/.zip 结尾）直接当完整地址用，否则当前缀拼文件名。
 */
export function resolveInstallerUrl(env: Record<string, string | undefined>): UrlResolution {
  const direct = (env["MSYS2_INSTALLER_URL"] ?? "").trim();
  if (direct !== "") return { url: direct, note: "安装包地址来自环境变量 MSYS2_INSTALLER_URL" };
  const mirror = (env["MSYS2_MIRROR"] ?? "").trim().replace(/\/+$/u, "");
  if (mirror !== "") {
    const full = /\.(exe|7z|zip)$/iu.test(mirror) ? mirror : mirror + "/" + INSTALLER_FILE;
    return {
      url: full,
      note: "安装包地址来自环境变量 MSYS2_MIRROR（镜像）；官方源是 " + MSYS2_INSTALLER_URL,
    };
  }
  return { url: MSYS2_INSTALLER_URL, note: "" };
}

/** 配置目录（与 toolchain-config 同目录）；不可用时退回系统临时目录。 */
function stateDir(env: Record<string, string | undefined>): string {
  const configPath = toolchainConfigPath(env);
  const dir = toPosix(dirname(configPath));
  return dir === "" ? toPosix(tmpdir()) : dir;
}

function cacheFilePath(env: Record<string, string | undefined>): string {
  // 固定文件名：换镜像/换版本不会堆一堆包体；要换版本就自己删这个文件。
  return stateDir(env) + "/msys2-latest.sfx.exe";
}

/* --------------------------- 目标目录决策 --------------------------- */

interface TargetResolution {
  msys64: string;
  via: Msys2InstallResult["resolvedVia"];
  /** 非空时说明"配置里那个路径本机用不了"，要原样告诉用户（不静默改配置）。 */
  warning: string;
}

/** 路径所在盘符是否真的存在：跨机器的配置（配置里是 D:/app/msys64，本机没有 D 盘）不能当安装目标。 */
function driveUsable(path: string, exists: (target: string) => boolean = existsSync): boolean {
  const match = /^([A-Za-z]):/u.exec(path);
  if (match === null || match[1] === undefined) return true;
  return exists(match[1].toUpperCase() + ":/");
}

/** "D:/app/msys64/ucrt64/bin" → "D:/app/msys64"；"C:/msys64/mingw64/bin" 同理。 */
function rootFromBinDir(binDir: string): string {
  const normalized = toPosix(binDir);
  if (normalized === "") return "";
  const withoutBin = normalized.replace(/\/bin$/iu, "");
  return withoutBin.replace(/\/(ucrt64|mingw64|clang64|mingw32|usr)$/iu, "");
}

/** 候选根：默认候选表 + 自动发现的 bin 目录。纯计算，不 spawn。 */
function msys64Candidates(env: Record<string, string | undefined>): string[] {
  const roots: string[] = [];
  for (const binDir of DEFAULT_BIN_DIRS) {
    const root = rootFromBinDir(binDir);
    if (root !== "") roots.push(root);
  }
  if (!discoveryDisabled(env)) {
    for (const binDir of discoverInstalls().binDirs) {
      const root = rootFromBinDir(binDir);
      if (root !== "") roots.push(root);
    }
  }
  return dedupePaths(roots);
}

/**
 * 决策顺序：显式 targetDir > 配置里的 msys64 > 自动发现的（判 <root>/usr/bin/bash.exe）> 都没有。
 * 都没有时**不猜**：装到哪必须由用户说一句。
 */
export function resolveTargetDir(
  explicit: string | undefined,
  config: ToolchainConfig | null,
  env: Record<string, string | undefined>,
  /** 单测注入用；生产代码不要传（默认看真实文件系统）。 */
  exists: (target: string) => boolean = existsSync,
): TargetResolution {
  const fromArg = explicit === undefined ? "" : toPosix(explicit);
  if (fromArg !== "") return { msys64: fromArg, via: "arg", warning: "" };
  const fromConfig = config === null ? "" : toPosix(config.msys64);
  if (fromConfig !== "") {
    if (driveUsable(fromConfig, exists)) return { msys64: fromConfig, via: "config", warning: "" };
    // 配置可能是从别的机器拷来的：盘符都不存在，既不能当安装目标，也不能当"已装"。
    const warning =
      "配置里的 MSYS2 根 " +
      fromConfig +
      " 在本机不存在（盘符都没有，配置大概是从别的机器拷来的），已忽略，请指定 targetDir";
    for (const candidate of msys64Candidates(env)) {
      if (isMsys2Root(candidate)) return { msys64: candidate, via: "discovered", warning };
    }
    return { msys64: "", via: "", warning };
  }
  for (const candidate of msys64Candidates(env)) {
    // 只认"能跑"的：目录在但缺 usr/bin/bash.exe 的半成品不算已安装。
    if (isMsys2Root(candidate)) return { msys64: candidate, via: "discovered", warning: "" };
  }
  return { msys64: "", via: "", warning: "" };
}

/** 需要决策时建议装哪：发现表里已经存在的目录优先（可能是用户以前装过的位置），否则 C:/msys64。 */
function suggestMsys64Root(env: Record<string, string | undefined>): string {
  for (const candidate of msys64Candidates(env)) {
    if (existsSync(candidate)) return candidate;
  }
  return MSYS2_SUGGESTED_ROOT;
}

export function viaLabel(via: Msys2InstallResult["resolvedVia"]): string {
  switch (via) {
    case "arg":
      return "参数 targetDir";
    case "config":
      return "配置里的 msys64";
    case "discovered":
      return "自动发现";
    case "suggested":
      // 契约里的保留值：自动采用建议路径会把"装到哪"变成隐式决定，我们不这么做。
      return "建议路径（尚未确认）";
    default:
      return "还没决定";
  }
}

/* --------------------------- 用户级 PATH --------------------------- */

interface UserPathRead {
  raw: string;
  /** 分号拆开并归一化后的条目（大小写 / 尾斜杠不敏感比较用）。 */
  entries: string[];
  /** 用户变量里确实有 Path 这个值（值本身可以是空串）。 */
  found: boolean;
  /**
   * 这次读取本身可不可信。false = 读不到当前值（reg 起不来 / 超时 / 非 0 退出 / 输出格式不认识）。
   * 为什么必须和 found 分开：found=false 有两种完全不同的处境——「用户变量里确实没有 Path」
   * （可以放心新建）和「读失败」（这时若照旧按空值继续，reg add /f 会把用户原有的一整条 Path
   * 覆盖掉，备份也只剩空串，回滚都回不去）。
   */
  readable: boolean;
  error: string;
}

/** 读失败：raw 归成空串只是让类型上有个值，调用方必须先看 readable 再决定能不能写。 */
function emptyUserPath(error: string): UserPathRead {
  return { raw: "", entries: [], found: false, readable: false, error };
}

/** reg 明确回答"没有这个值"：可以新建，此时的空串不代表会丢数据。 */
function absentUserPath(): UserPathRead {
  return { raw: "", entries: [], found: false, readable: true, error: "" };
}

/** reg query 报"找不到"的本地化写法（zh-CN / en-US）；命中即"这个值不存在"。 */
const MISSING_VALUE_MARKERS = [
  "unable to find",
  "无法找到",
  "找不到指定的注册表",
  "cannot find",
  "does not exist",
  "不存在",
];

function looksLikeMissingValue(text: string): boolean {
  const lowered = text.toLowerCase();
  return MISSING_VALUE_MARKERS.some((marker) => lowered.includes(marker));
}

/** 从 reg query 的输出里抠出值（形如：    Path    REG_EXPAND_SZ    C:\a;D:\b）。 */
function parseRegLine(text: string, name: string): { found: boolean; value: string } {
  const lowered = name.toLowerCase();
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.toLowerCase().startsWith(lowered)) continue;
    const match = /^\S+\s{2,}(REG_[A-Z_]+)\s{2,}([\s\S]*)$/u.exec(trimmed);
    if (match !== null) return { found: true, value: (match[2] ?? "").trim() };
  }
  return { found: false, value: "" };
}

function parseRegValue(text: string, name: string): string {
  return parseRegLine(text, name).value;
}

interface UserPathQuery {
  /** 解码后的输出（stdout 与 stderr 已经合进同一份）。 */
  text: string;
  exitCode: number | null;
  spawnError: string | null;
  timedOut: boolean;
  /** 非空 = 字节解不出来，调用方必须按"读不到"处理。 */
  decodeError: string;
}

/**
 * 跑一次 reg query，并把**原始字节**拿回来。
 *
 * 为什么要绕一层 cmd.exe 重定向：宿主的 subprocess 只给解码后的字符串
 * （CollectedReader.readFrom().text），而 reg.exe 是控制台程序，写的是系统 ANSI 代码页的
 * 字节（中文 Windows 是 GBK）。直接从管道读，带中文的 PATH 条目必然变成 U+FFFD，
 * 再被当成"用户原来的旧值"写回注册表，就把整条用户级 PATH 写坏了（B3 的备份也会是乱码）。
 * 所以让 cmd 把输出重定向到临时文件，再用 readFileSync 取 Buffer，交给 decodeRegistryText
 * 按 UTF-8 / GB18030 探测。临时目录里只有这一次的输出，用完就删。
 */
async function queryUserPathBytes(
  subprocess: SubprocessService,
  signal: AbortSignal | undefined,
): Promise<UserPathQuery> {
  let dir = "";
  try {
    dir = mkdtempSync(join(tmpdir(), "dsh-msys2-reg-"));
  } catch (error) {
    return {
      text: "",
      exitCode: null,
      spawnError: "建临时目录失败：" + describeError(error),
      timedOut: false,
      decodeError: "",
    };
  }
  const dump = join(dir, "dump.txt");
  try {
    // 这一行故意不带任何引号、也不用绝对路径（cwd 就是临时目录）：cmd /c 对 \" 的转义规则
    // 很容易踩坑，而 HKCU\Environment 与 dump.txt 都不含空格，省事且最不容易出错。
    const outcome = await runCapture(subprocess, {
      argv: ["cmd.exe", "/d", "/s", "/c", "reg.exe query " + PATH_KEY + " /v Path > dump.txt 2>&1"],
      cwd: dir,
      timeoutMs: 10_000,
      ...(signal === undefined ? {} : { signal }),
    });
    let bytes: Buffer | null = null;
    try {
      bytes = readFileSync(dump);
    } catch {
      // 文件没写出来（安全软件拦了 cmd、或重定向被改写）：退回宿主给的文本——
      // 至少"系统找不到指定的注册表项或值"这类纯 ASCII 结论还认得出来。
      bytes = null;
    }
    const decoded = decodeRegistryText(
      bytes === null ? outcome.stdout + "\n" + outcome.stderr : bytes,
      "reg query 输出",
    );
    return {
      text: decoded.ok ? decoded.text : "",
      exitCode: outcome.exitCode,
      spawnError: outcome.spawnError,
      timedOut: outcome.timedOut,
      decodeError: decoded.ok ? "" : decoded.error,
    };
  } finally {
    removeDirQuietly(dir);
  }
}

async function readUserPath(
  subprocess: SubprocessService,
  signal: AbortSignal | undefined,
): Promise<UserPathRead> {
  if (!WINDOWS) return emptyUserPath("非 Windows：没有用户级 PATH 可写");
  const outcome = await queryUserPathBytes(subprocess, signal);
  if (outcome.spawnError !== null) return emptyUserPath("reg query 起不来：" + outcome.spawnError);
  if (outcome.timedOut) return emptyUserPath("reg query 超时（10 秒没有返回）");
  // 字节解不出来就当作读不到：宁可让用户手动加一条，也不把乱码写回注册表。
  if (outcome.decodeError !== "") {
    return emptyUserPath("reg query 的输出解不出来（" + outcome.decodeError + "）");
  }
  if (outcome.exitCode !== 0) {
    // 退出码非 0 分两类：①「系统找不到指定的注册表项或值」= 用户变量里真的没有 Path，可以新建；
    // ②被组策略 / EDR 拦住、参数不对等 = 读不可信，绝不能拿空串去 reg add 覆盖。
    if (looksLikeMissingValue(outcome.text)) return absentUserPath();
    const reason = lastLine(outcome.text) || "没有输出";
    return emptyUserPath("reg query 退出码 " + String(outcome.exitCode) + "：" + reason);
  }
  const parsed = parseRegLine(outcome.text, "Path");
  // 退出码 0 却一行都没认出来：多半是输出格式 / 系统语言与预期不符（也可能是值名被改过），
  // 一律按"读不到"处理——宁可让用户手动加一条，也不要 blind 覆盖。
  if (!parsed.found) {
    return emptyUserPath("reg query 的输出里没有 Path 那一行（输出格式与预期不符）");
  }
  return { raw: parsed.value, entries: splitList(parsed.value), found: true, readable: true, error: "" };
}

function composeUserPath(raw: string, entry: string): string {
  const base = raw.replace(/\s+$/u, "").replace(/;+$/u, "");
  return base === "" ? entry : base + ";" + entry;
}

function pathContains(current: UserPathRead, entry: string): boolean {
  const key = toPosix(entry).toLowerCase();
  if (key === "") return false;
  return current.entries.some((item) => item.toLowerCase() === key);
}

/** 读不到时的兜底说明：给可手动执行的写法，但要求用户自己先确认旧值（我们读不到就无法替他拼）。 */
function manualPathHint(entry: string): string {
  return (
    "先在命令行跑 reg query \"" +
    PATH_KEY +
    "\" /v Path 确认能读到旧值，再在「环境变量 → 用户变量 → Path」末尾加一条 " +
    entry +
    "；等价命令 reg add \"" +
    PATH_KEY +
    "\" /v Path /t REG_EXPAND_SZ /d \"<完整旧值>;" +
    entry +
    "\" /f —— 其中 <完整旧值> 必须换成真的旧值（别用空串；也别用 setx，setx 会在 1024 字符处截断 PATH）"
  );
}

/** 读失败时的统一开场白：卡片、步骤 detail、message 都用它，测试与用户都能一眼认出。 */
const UNREADABLE_PATH_PREFIX = "读不到当前用户 PATH";

function planPathState(
  current: UserPathRead,
  binDir: string,
  writePath: boolean,
): Msys2InstallPathState {
  const state: Msys2InstallPathState = {
    done: false,
    changed: false,
    before: current.raw,
    after: current.raw,
    backup: "",
    error: "",
  };
  if (binDir === "" || !writePath) return state;
  const entry = toWindowsDir(binDir);
  if (!current.readable) {
    // 读失败时连 after 都不算：拿空串拼出来的"新值"会把用户原有的一整条 Path 抹掉。
    state.error =
      UNREADABLE_PATH_PREFIX +
      "（" +
      (current.error === "" ? "原因不明" : current.error) +
      "），为安全起见不会写注册表；手动：" +
      manualPathHint(entry);
    return state;
  }
  // 已经在里面：after 与 before 相同，卡片上就看得出"不会变"。
  if (pathContains(current, entry)) return state;
  state.after = composeUserPath(current.raw, entry);
  return state;
}

/** 旧 PATH 落盘备份（写注册表前）；备份失败就不写 PATH——有回滚能力比省一次点击重要。 */
function writePathBackup(
  raw: string,
  env: Record<string, string | undefined>,
): { path: string; error: string } {
  const dir = stateDir(env);
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const path = dir + "/path-backup-" + stamp + ".txt";
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, raw + "\n", "utf8");
    return { path, error: "" };
  } catch (error) {
    return { path: "", error: describeError(error) };
  }
}

async function applyUserPath(
  subprocess: SubprocessService,
  env: Record<string, string | undefined>,
  binDir: string,
  request: Msys2InstallRequest,
): Promise<Msys2InstallPathState> {
  // 就在要写之前再读一次：计划阶段到真装之间，用户可能自己动过环境变量。
  const current = await readUserPath(subprocess, request.signal);
  const state = planPathState(current, binDir, request.writePath);
  if (binDir === "" || !request.writePath) return state;
  // 读失败：原因与手动命令已经由 planPathState 写进 error。这里既不备份空串，也不碰注册表——
  // 备份空串等于没有回滚能力，而带 /f 的 reg add 会把用户整条用户级 Path 换成一条。
  if (!current.readable) return state;
  const entry = toWindowsDir(binDir);
  if (pathContains(current, entry)) {
    state.done = true;
    return state;
  }
  if (!WINDOWS) {
    state.error =
      "只有 Windows 有 HKCU\\Environment；当前平台请自己把 " + binDir + " 加进 shell 的 PATH";
    return state;
  }
  const backup = writePathBackup(current.raw, env);
  if (backup.error !== "") {
    state.error = "备份旧 PATH 失败，为安全起见没写注册表：" + backup.error;
    return state;
  }
  state.backup = backup.path;
  const outcome = await runCapture(subprocess, {
    argv: ["reg.exe", "add", PATH_KEY, "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", state.after, "/f"],
    timeoutMs: 15_000,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  if (outcome.spawnError !== null) {
    state.error = "reg add 起不来：" + outcome.spawnError;
    return state;
  }
  if (outcome.exitCode !== 0) {
    state.error =
      "reg add 退出码 " +
      String(outcome.exitCode) +
      "：" +
      (lastLine(outcome.stderr) || lastLine(outcome.stdout));
    return state;
  }
  state.done = true;
  state.changed = true;
  return state;
}

/* ----------------------- 解压（暂存目录 → 目标） ----------------------- */

interface ExtractOutcome {
  ok: boolean;
  /** 用户中断（不是失败）：暂存目录要留着，下次进来第一条就是清它。 */
  cancelled: boolean;
  detail: string;
  /** 失败时也可能非空：解压结果留在这里，用户可以自己挪。 */
  staging: string;
}

/** 取消不是"解压失败"：文案上必须分开，别让用户以为安装包坏了。 */
const EXTRACT_CANCELLED = "已取消（解压还没做完）";

/**
 * 静默解压。
 *
 * 为什么不直接 -o<targetParent>：官方 sfx 里带一个顶层 msys64 目录，只有目标目录名恰好叫
 * msys64 时"解压到父目录"才成立。先解到同级暂存目录再 rename，任何 targetDir 都成立；
 * 而且暂存目录建在 targetDir 的父目录下，rename 是同盘操作，不会真拷几百 MB。
 */
async function extractInstaller(
  subprocess: SubprocessService,
  sfxPath: string,
  targetDir: string,
  request: Msys2InstallRequest,
  timeoutMs: number,
): Promise<ExtractOutcome> {
  const parent = toPosix(dirname(targetDir));
  const staging = parent + "/.dsh-msys2-staging";
  // 只清自己建的暂存目录（固定名字）：上次崩在中途，残渣也不会被当成成功。
  removeDirQuietly(staging);
  try {
    mkdirSync(staging, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      cancelled: false,
      detail: "建不了暂存目录 " + staging + "：" + describeError(error),
      staging: "",
    };
  }
  // 两种写法都试：7z SFX 认 -o<dir>，带引号的写法在含空格的路径上更稳。
  const variants: string[][] = [
    ["-y", "-o" + staging],
    ["-y", '-o"' + staging + '"'],
  ];
  let lastError = "";
  let extractedRoot = "";
  for (const args of variants) {
    const outcome = await runCapture(subprocess, {
      argv: [sfxPath, ...args],
      cwd: staging,
      timeoutMs,
      maxBytes: 64 * 1024,
      awaitQuiescence: true,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    // A29：用户按了停止（或被上层 abort）不是"解压失败"。先判取消，别走失败路径去删暂存目录：
    // 半份解压结果留着，下次进这里第一件事就是清它，不用用户自己收拾。
    if (outcome.aborted || isAborted(request.signal)) {
      return { ok: false, cancelled: true, detail: EXTRACT_CANCELLED, staging };
    }
    if (outcome.spawnError !== null) {
      lastError = "安装包起不来：" + outcome.spawnError;
      continue;
    }
    if (outcome.timedOut) {
      lastError = "解压超时（" + String(Math.round(timeoutMs / 1000)) + " s）";
      continue;
    }
    if (outcome.exitCode !== 0) {
      lastError =
        "退出码 " +
        String(outcome.exitCode) +
        "：" +
        (lastLine(outcome.stderr) || lastLine(outcome.stdout) || "（无输出）");
      continue;
    }
    const found = [staging + "/msys64", staging].find((dir) => isMsys2Root(dir));
    if (found === undefined) {
      lastError =
        "解压完没找到 usr/bin/bash.exe；暂存目录内容：" + safeList(staging).slice(0, 8).join("、");
      continue;
    }
    extractedRoot = found;
    break;
  }
  if (extractedRoot === "") {
    removeDirQuietly(staging);
    return {
      ok: false,
      cancelled: false,
      detail: lastError === "" ? "解压失败（没有更多信息）" : lastError,
      staging: "",
    };
  }
  try {
    if (existsSync(targetDir)) {
      if (safeList(targetDir).length > 0) {
        return {
          ok: false,
          cancelled: false,
          detail:
            "解压好了，但目标目录在解压期间变成非空：" +
            targetDir +
            "（没有覆盖它）；解压结果留在 " +
            extractedRoot,
          staging,
        };
      }
      // 只删空目录（rmdir 不会带走任何文件）。
      rmdirSync(targetDir);
    }
    renameSync(extractedRoot, targetDir);
  } catch (error) {
    return {
      ok: false,
      cancelled: false,
      detail: "移动解压结果失败：" + describeError(error) + "；解压结果留在 " + extractedRoot,
      staging,
    };
  }
  removeDirQuietly(staging);
  return { ok: true, cancelled: false, detail: targetDir, staging: "" };
}

/* ---------------------------- pacman 补包 ---------------------------- */

/**
 * 整体升级一次。
 * 为什么不再用 "pacman -Sy --noconfirm && pacman -S …"：那是 Arch/MSYS2 官方明确劝阻的"局部升级"，
 * 陈旧的部分库配上新包会解不开依赖，用户只会在同一条命令上反复失败。
 */
const PACMAN_UPGRADE_COMMAND = "pacman -Syu --noconfirm";

/** 一条 pacman 命令算不算成功（起不来 / 超时 / 非 0 都算失败）。 */
function pacmanOk(outcome: RunOutcome): boolean {
  return outcome.spawnError === null && !outcome.timedOut && outcome.exitCode === 0;
}

/** 只用现有数据库补包：已有 MSYS2 上不先 -Sy，免得"局部升级"把依赖解析搞崩。 */
function pacmanInstallCommand(packages: readonly string[]): string {
  return "pacman -S --noconfirm --needed " + packages.join(" ");
}

/** `pacman -Q <包名…>` 的输出 → { 包名 → 已装版本 }；找不到的包只会出现在 stderr，这里天然收不到。 */
export function parsePacmanQuery(output: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const raw of output.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "") continue;
    const match = /^(\S+)\s+(\S+)$/u.exec(line);
    if (match === null || match[1] === undefined || match[2] === undefined) continue;
    found.set(match[1], match[2]);
  }
  return found;
}

function bashLine(msys64: string, command: string): string {
  return (msys64 === "" ? "<msys64>" : msys64) + "/usr/bin/bash.exe -lc \"" + command + "\"";
}

/** keyring 没初始化时 pacman 会报这两类话：要先 pacman-key --init / --populate 再重试。 */
function needsKeyringInit(outcome: RunOutcome): boolean {
  const text = (outcome.stdout + "\n" + outcome.stderr).toLowerCase();
  return text.includes("keyring") || text.includes("invalid or corrupted package");
}

/* --------------------------- 步骤簿记 --------------------------- */

/**
 * 安装中卡片的步骤骨架。
 *
 * 计划在"什么都不用做"时只返回一句话（steps 为空），但真装 job 的卡片仍需列出 7 步，
 * 否则用户看到一个没有步骤的"安装中"卡片，不知道在等什么。
 */
export function msys2StepSkeleton(): Msys2InstallStep[] {
  return makeSteps();
}

function makeSteps(): Msys2InstallStep[] {
  return STEP_DEFS.map((def) => ({ id: def.id, label: def.label, status: "pending", detail: "" }));
}

function stepOf(steps: Msys2InstallStep[], id: string): Msys2InstallStep {
  for (const step of steps) {
    if (step.id === id) return step;
  }
  const created: Msys2InstallStep = { id, label: id, status: "pending", detail: "" };
  steps.push(created);
  return created;
}

function setStep(step: Msys2InstallStep, status: Msys2InstallStep["status"], detail: string): void {
  step.status = status;
  step.detail = detail;
}

function beginStep(
  steps: Msys2InstallStep[],
  step: Msys2InstallStep,
  onProgress: ((line: string) => void) | undefined,
): void {
  step.status = "running";
  if (onProgress !== undefined) {
    onProgress(
      "[" + String(steps.indexOf(step) + 1) + "/" + String(steps.length) + "] " + step.label + "…",
    );
  }
}

/** 关键步骤失败后把后面还 pending 的标成 skipped，避免卡片上出现"一半 pending"的歧义。 */
function skipAfter(steps: Msys2InstallStep[], id: string, detail: string): void {
  let seen = false;
  for (const step of steps) {
    if (seen && step.status === "pending") setStep(step, "skipped", detail);
    if (step.id === id) seen = true;
  }
}

/** 计划模式的现场事实：决定每一步是"要做"还是"已经不用做"。全部只读。 */
interface PlanFacts {
  /** 目标目录里已经有一份能用的 MSYS2（有 usr/bin/bash.exe）。 */
  existing: boolean;
  /** 已装的包 → 版本（问不到 pacman 时为空）。 */
  installed: Map<string, string>;
  /** 还缺的包（existing=false 时就是全部）。 */
  missing: string[];
  /** 缓存里已经有有效的安装包。 */
  cacheOk: boolean;
  /** pacman -Q 没问出来（超时 / 起不来）：此时不能说"缺 N 个"，只能说"真装时会先问"。 */
  pacmanUnknown: boolean;
  /** 用户 PATH 里已经包含这个 bin 目录。 */
  pathEntryPresent: boolean;
  /** 读 PATH 失败时的原因（非空表示"真装时这一步会失败"）。 */
  pathError: string;
  /** 现有配置已经就是这个样子，不用改。 */
  configMatches: boolean;
  /** 计划模式真跑过自检：结论与内容（空字符串表示没跑）。 */
  verifyOk: boolean;
  verifyText: string;
}

interface PlanDetailContext extends PlanFacts {
  msys64: string;
  parent: string;
  binDir: string;
  packages: string[];
  cachePath: string;
  /** 安装包地址：计划卡片上要说清"从哪下"。 */
  cacheUrl: string;
  configPath: string;
  writePath: boolean;
}

function shortPackageName(name: string): string {
  return name.replace("mingw-w64-ucrt-x86_64-", "");
}

/**
 * 计划模式下每步写清"将要做什么"，**以及已经不需要做什么**。
 *
 * 这里最容易犯的错是把"用户机器上早就装齐了"也写成"待执行"：
 * 计划卡片一边说"已存在的完整 MSYS2 直接复用"，一边说"下载 43.1 MB 安装包"，
 * 用户会以为要重装。所以凡是能只读判断出来的，都据实标 skipped 并写原因。
 */
function fillPlanDetails(steps: Msys2InstallStep[], context: PlanDetailContext): void {
  const rootLabel = context.msys64 === "" ? "（装哪还没定）" : context.msys64;
  setStep(
    stepOf(steps, "prepare"),
    context.existing ? "skipped" : "pending",
    context.msys64 === ""
      ? "目标目录待定；定了之后先确保它的父目录存在"
      : context.existing
        ? context.msys64 + " 里已经有一份能用的 MSYS2（有 usr/bin/bash.exe），不用建目录、不用重装"
        : "确保父目录存在：" +
            (context.parent === "" ? context.msys64 : context.parent) +
            "（目标目录不存在或不是完整 MSYS2 时才会装）",
  );
  setStep(
    stepOf(steps, "download"),
    context.existing ? "skipped" : "pending",
    context.existing
      ? "已有完整 MSYS2，不需要安装包（省 " + formatBytes(MSYS2_INSTALLER_BYTES) + " 下载）"
      : context.cacheOk
        ? "复用缓存：" + context.cachePath + "（" + formatBytes(MSYS2_INSTALLER_BYTES) + "，不会再下载）"
        : "curl.exe -L --fail --retry 3 -o " +
            context.cachePath +
            " " +
            context.cacheUrl +
            "（约 " +
            formatBytes(MSYS2_INSTALLER_BYTES) +
            "；缓存已有且是有效 exe 就直接复用）",
  );
  setStep(
    stepOf(steps, "extract"),
    context.existing ? "skipped" : "pending",
    context.existing
      ? "已有 MSYS2，不需要解压"
      : context.msys64 === ""
        ? "把安装包静默解压到同级暂存目录，再把解压出的 msys64 移到目标目录（不覆盖已有目录）"
        : context.cachePath + " -y -o" + context.parent + " → 再把解压出的 msys64 移到 " + context.msys64,
  );
  const missingDetail =
    context.pacmanUnknown
      ? "计划里没问出来（pacman 超时或起不来）：真装时会先 pacman -Q 问一遍，只补缺的包，已装的包不动、也不升级（要升级自己跑 pacman -Syu）"
      : context.missing.length === 0
      ? context.packages
          .map((name) => shortPackageName(name) + " " + (context.installed.get(name) ?? ""))
          .join("、") + " 都已经装了，不会重复安装，也不升级（要升级自己跑 pacman -Syu）"
      : context.existing
        ? "先 pacman -Q 问过一遍：缺 " +
          String(context.missing.length) +
          " 个（" +
          context.missing.map(shortPackageName).join("、") +
          "）；将跑 pacman -S --noconfirm --needed " +
          context.missing.join(" ") +
          "（已装的 " +
          String(context.installed.size) +
          " 个不动，也不升级）"
        : bashLine(context.msys64, "pacman -Q " + context.packages.join(" ")) +
          "：先问一遍装没装，已装的直接跳过（不重复安装、也不擅自升级）；只对缺的包跑 pacman -S --noconfirm --needed <缺的包>；" +
          "刚解压出来、一件包都还没装的那种空库，会先整体升级一次（pacman -Syu --noconfirm）再补包 —— " +
          "不会做「-Sy 之后立刻 -S 单个包」那种局部升级，那在 MSYS2 上会解不开依赖。";
  setStep(stepOf(steps, "pacman"), context.missing.length === 0 ? "skipped" : "pending", missingDetail);
  setStep(
    stepOf(steps, "path"),
    !context.writePath || context.pathEntryPresent ? "skipped" : "pending",
    !context.writePath
      ? "writePath=false：不动 PATH（失败也不致命，插件按配置里的绝对路径找工具）"
      : context.binDir === ""
        ? "把 <msys64>/ucrt64/bin 追加到用户级 PATH"
        : context.pathEntryPresent
          ? "用户 PATH 里已经有 " + toWindowsDir(context.binDir) + "，不会重复写"
          : context.pathError !== ""
            ? "⚠ 会失败：" + context.pathError
            : "把 " +
              toWindowsDir(context.binDir) +
              " 追加到用户级 PATH（HKCU\\Environment，REG_EXPAND_SZ；旧值先备份）",
  );
  setStep(
    stepOf(steps, "verify"),
    context.verifyOk ? "done" : "pending",
    context.verifyText !== ""
      ? context.verifyOk
        ? context.verifyText + "（计划模式只读跑了一遍，没装任何东西）"
        : "现在：" + context.verifyText + "；补完包会再跑一次"
      : context.binDir === ""
        ? "用装好的 bin 目录跑 gcc / cmake / ninja / openocd / gdb 的版本命令"
        : "用 " + context.binDir + " 跑 gcc / cmake / ninja / openocd / gdb 的版本命令",
  );
  setStep(
    stepOf(steps, "config"),
    context.configMatches ? "skipped" : "pending",
    context.configMatches
      ? "配置已经是这个样子（" + context.configPath + " 里 msys64 与 packages 都对得上），不用改"
      : "写 " +
        context.configPath +
        "：msys64=" +
        rootLabel +
        "、binDirs、packages（与已有 packages 合并去重，不动 cubeMxRoot）",
  );
}


/* ------------------------------ 文案 ------------------------------ */

/**
 * 计划卡片的第一句话：按"实际要做什么"分三档，别把"已经装好了"说成"要装"。
 *
 * 三种现场：
 *  1. 已装齐（existing && 无缺件）→ 什么都不用做；
 *  2. 已有 MSYS2 但缺包 → 只补缺的，不下载安装包；
 *  3. 全新安装 → 原来的文案（下载安装包 + 补全部组件）。
 */
function planMessage(
  msys64: string,
  via: Msys2InstallResult["resolvedVia"],
  packages: readonly string[],
  download: Msys2InstallDownload,
  facts: PlanFacts,
): string {
  if (facts.existing && facts.missing.length === 0) {
    return (
      "什么都不用装：MSYS2 已经在 " +
      msys64 +
      "（来源：" +
      viaLabel(via) +
      "，有 usr/bin/bash.exe），" +
      String(packages.length) +
      " 个组件也都装着" +
      (facts.pathEntryPresent ? "，用户 PATH 里也有它" : "") +
      (facts.configMatches ? "，配置已经写好" : "") +
      "。没有下载、没有建目录、没有写注册表、没有改配置。"
    );
  }
  if (facts.existing && facts.pacmanUnknown) {
    return (
      "计划（还没动手）：复用 " +
      msys64 +
      " 里已有的 MSYS2（来源：" +
      viaLabel(via) +
      "）；计划里没问出这 " +
      String(packages.length) +
      " 个组件装没装（pacman 超时或起不来），真装时会先 pacman -Q 问一遍，只补缺的，已装的包不动、也不升级。" +
      "确认后才真装——现在没有下载、没有建目录、没有写注册表、没有改配置。"
    );
  }
  if (facts.existing) {
    return (
      "计划（还没动手）：复用 " +
      msys64 +
      " 里已有的 MSYS2（来源：" +
      viaLabel(via) +
      "），只补 " +
      String(facts.missing.length) +
      " 个组件（缺 " +
      facts.missing.map(shortPackageName).join("、") +
      "）；不用下载安装包，已装的 " +
      String(facts.installed.size) +
      " 个不动、也不升级。确认后才真装——现在什么都没动。"
    );
  }
  return (
    "计划（还没动手）：把 MSYS2 装到 " +
    msys64 +
    "（来源：" +
    viaLabel(via) +
    "），再补 " +
    String(packages.length) +
    " 个组件；安装包 " +
    formatBytes(download.bytes) +
    (download.cached ? "（本机已有缓存，不会再下载）" : "（需要下载）") +
    "。确认后才真装——现在没有下载、没有建目录、没有写注册表、没有改配置。"
  );
}


/** 没有现场事实时（真装路径、目录还没定时）的默认值：一律按"没装过"处理。 */
function emptyFacts(packages: readonly string[]): PlanFacts {
  return {
    existing: false,
    installed: new Map<string, string>(),
    missing: [...packages],
    cacheOk: false,
    pacmanUnknown: false,
    pathEntryPresent: false,
    pathError: "",
    configMatches: false,
    verifyOk: false,
    verifyText: "",
  };
}

/** 用量估算：已装齐就明说"不用下载任何东西"，别让用户以为要重装。 */
function usageNote(facts: PlanFacts | null, download: Msys2InstallDownload, packages: readonly string[]): string {
  if (facts !== null && facts.existing && facts.missing.length === 0) {
    return "用量估算：不用下载任何东西（MSYS2 与 " + String(packages.length) + " 个组件都已在本机）。";
  }
  if (facts !== null && facts.existing && facts.pacmanUnknown) {
    return "用量估算：不用下载安装包；缺几个包要等真装时 pacman -Q 才知道（已装的包不动、也不升级）。";
  }
  if (facts !== null && facts.existing) {
    return (
      "用量估算：不用下载安装包；只补 " +
      String(facts.missing.length) +
      " 个包，pacman 下载约 " +
      formatBytes(msys2PackagesTotal(facts.missing)) +
      "（按单包大小估算，实际以 pacman 为准）。"
    );
  }
  return (
    "用量估算：安装包 " +
    formatBytes(download.bytes) +
    (download.cached ? "（已缓存）" : "") +
    " + pacman 分包下载约 " +
    formatBytes(msys2PackagesTotal(packages)) +
    "；装完磁盘占用约 " +
    formatBytes((MSYS2_INSTALLER_BYTES + msys2PackagesTotal(packages)) * 3) +
    "（估算：安装包 + 分包的总量按 3 倍粗算，含解压后的文件与 pacman 缓存，不是精确占用）。"
  );
}

function decisionMessage(
  suggested: string,
  packages: readonly string[],
  download: Msys2InstallDownload,
): string {
  return (
    "需要你先决定装哪：这台机器上没有可用的 MSYS2（配置里没有、自动扫描也没找到 usr/bin/bash.exe），" +
    "我不猜路径。建议装到 " +
    suggested +
    "（安装包 " +
    formatBytes(download.bytes) +
    " + 分包约 " +
    formatBytes(msys2PackagesTotal(packages)) +
    " 估算）。给我 targetDir、或回一句「装到 " +
    suggested +
    "」，我再出计划；现在什么都没装。"
  );
}

function verifySummary(verify: Msys2InstallVerifyState): string {
  const found = verify.tools.filter((tool) => tool.found);
  const missing = verify.tools.filter((tool) => !tool.found);
  if (missing.length === 0) {
    if (found.length === 0) return "自检没有可跑的组件";
    const versions = found
      .map((tool) => tool.id + (tool.version === "" ? "" : " " + tool.version))
      .join("、");
    return "5 个组件都能跑（" + versions + "）";
  }
  return "缺 " + missing.map((tool) => tool.label).join("、");
}

/**
 * path 是不是在 dir 之下（大小写与斜杠不敏感）。
 * 自检用它确认"跑起来的那个工具"确实来自目标 binDir，而不是 PATH 上的同名文件。
 */
function isInsideDir(path: string, dir: string): boolean {
  const base = toPosix(dir).replace(/\/+$/u, "").toLowerCase();
  const target = toPosix(path).replace(/\/+$/u, "").toLowerCase();
  if (base === "" || target === "") return false;
  return target === base || target.startsWith(base + "/");
}

function toVerifyState(results: readonly ProbeResult[]): Msys2InstallVerifyState {
  return {
    ok: results.length > 0 && results.every((result) => result.found),
    tools: results.map((result) => ({
      id: result.id,
      label: result.label,
      found: result.found,
      version: result.version,
    })),
  };
}

/* ---------------------------- 主入口 ---------------------------- */

export async function planOrInstallMsys2(
  subprocess: SubprocessService,
  request: Msys2InstallRequest,
  env: Record<string, string | undefined> = process.env,
): Promise<Msys2InstallResult> {
  const started = Date.now();
  const configRead = readToolchainConfig(env);
  const target = resolveTargetDir(request.targetDir, configRead.config, env);
  const suggested = target.msys64 === "" ? suggestMsys64Root(env) : "";
  const packages = dedupeStrings(
    request.packages !== undefined && request.packages.length > 0
      ? request.packages
      : [...DEFAULT_MSYS2_PACKAGES],
  );
  const installer = resolveInstallerUrl(env);
  const cachePath = cacheFilePath(env);
  const cachedBytes = fileSize(cachePath);
  const cachedOk = cachedBytes > 0 && looksLikeExecutable(cachePath);
  const msys64 = target.msys64;
  const binDir = msys64 === "" ? "" : msys64 + "/ucrt64/bin";
  const parent = msys64 === "" ? "" : toPosix(dirname(msys64));
  let download: Msys2InstallDownload = {
    url: installer.url,
    bytes: cachedOk ? cachedBytes : MSYS2_INSTALLER_BYTES,
    cached: cachedOk,
  };

  const steps = makeSteps();
  const userPath = await readUserPath(subprocess, request.signal);
  let pathState = planPathState(userPath, binDir, request.writePath);

  const notes: string[] = [];
  if (target.warning !== "") notes.push("⚠ " + target.warning);
  const warningPrefix = target.warning === "" ? "" : "⚠ " + target.warning + "；";
  notes.push(
    "装完后插件按配置里的绝对路径找工具" +
      (binDir === "" ? "" : "（" + binDir + "）") +
      "，本进程不需要重读环境变量，也不要求重开 DSH。",
  );
  notes.push(
    "刻意没做卸载：要删就删安装目录" +
      (msys64 === "" ? "" : " " + msys64) +
      " 并去掉配置里的 msys64 / binDirs 两项，PATH 里那条也手动删掉。",
  );
  if (installer.note !== "") notes.push(installer.note);

  // -- 计划模式：零副作用（只做只读判断：pacman -Q、版本命令、读注册表）--------
  if (request.mode !== "install") {
    const existing = isMsys2Root(msys64);
    const bashPath = msys64 === "" ? "" : msys64 + "/usr/bin/bash.exe";
    const pacmanExe = msys64 === "" ? "" : msys64 + "/usr/bin/pacman.exe";
    let installed = new Map<string, string>();
    let missing = [...packages];
    let pacmanUnknown = false;
    if (existing && (pacmanExe !== "" && existsSync(pacmanExe) || existsSync(bashPath))) {
      // 只读：问一句"装没装"，与真装第 4 步同一个命令。
      // 计划因此不会把"已经装好的 5 个包"说成"再补 5 个组件"。
      // 优先直接跑 pacman.exe：少了 bash 起 profile 那一步（本机实测 11 s → 6.5 s）。
      const argv =
        pacmanExe !== "" && existsSync(pacmanExe)
          ? [pacmanExe, "-Q", ...packages]
          : [bashPath, "-lc", "pacman -Q " + packages.join(" ")];
      const query = await runCapture(subprocess, {
        argv,
        cwd: msys64,
        timeoutMs: PACMAN_QUERY_TIMEOUT_MS,
        maxBytes: 512 * 1024,
        awaitQuiescence: true,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (query.spawnError === null && !query.timedOut) {
        installed = parsePacmanQuery(query.stdout);
        missing = packages.filter((name) => !installed.has(name));
        // 一条都没解析出来、退出码又不是 0：多半是 pacman 自己在报错（不是"全都没装"）。
        if (installed.size === 0 && (query.exitCode ?? 1) !== 0) pacmanUnknown = true;
      } else {
        pacmanUnknown = true;
        notes.push(
          "⚠ 计划里问不了 pacman（" +
            (query.spawnError !== null ? query.spawnError : "超时") +
            "）：真装时会先 pacman -Q 再决定装哪几个，这里不猜。",
        );
      }
    }

    // 计划模式也真跑一遍自检：只读、只跑版本命令，结论能直接回答"现在到底能不能用"。
    let planProbed: ProbeResult[] = [];
    let verifyOk = false;
    let verifyText = "";
    if (binDir !== "" && existsSync(binDir)) {
      const probeConfig = { binDirs: [binDir], cubeMxRoots: [] };
      const probeWanted = buildTargets(probeConfig).filter((item) => VERIFY_IDS.includes(item.id));
      planProbed = await probeAll(subprocess, probeWanted, probeConfig, {
        timeoutMs: PROBE_TIMEOUT_MS,
        allowPathFallback: false,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const probedState = toVerifyState(planProbed);
      verifyOk = probedState.ok;
      verifyText = probedState.ok
        ? verifySummary(probedState)
        : "缺 " +
          probedState.tools
            .filter((tool) => !tool.found)
            .map((tool) => tool.label)
            .join("、");
    }

    const currentConfig = configRead.config;
    const configMatches =
      currentConfig !== null &&
      toPosix(currentConfig.msys64) === toPosix(msys64) &&
      (currentConfig.binDirs.length === 0 ||
        currentConfig.binDirs.some((dir) => toPosix(dir) === toPosix(binDir))) &&
      packages.every((name) => currentConfig.packages.includes(name));
    const facts: PlanFacts = {
      existing,
      installed,
      missing,
      cacheOk: cachedOk,
      pacmanUnknown,
      pathEntryPresent: binDir !== "" && userPath.readable && pathContains(userPath, toWindowsDir(binDir)),
      pathError: pathState.error,
      configMatches,
      verifyOk,
      verifyText,
    };
    // 已有 MSYS2 时"下载 0 字节"才是实话：安装包根本不会碰。
    if (existing) download = { url: installer.url, bytes: 0, cached: cachedOk };
    const decided = msys64 !== "";
    const nothingToDo = decided && existing && missing.length === 0 && !pacmanUnknown;
    // 什么都不用做时只回一句话：不列 7 个"已跳过"的步骤，也不贴 notes。
    // 卡片上把"没有可做的事"画成七行详情，用户会以为还有一堆动作在排队。
    if (nothingToDo && verifyOk) {
      return {
        ok: true,
        mode: "plan",
        needsDecision: "",
        msys64,
        resolvedVia: target.via,
        binDirs: binDir === "" ? [] : [binDir],
        packages,
        steps: [],
        download,
        path: pathState,
        config: { path: configRead.path, written: false, error: "" },
        verify: toVerifyState(planProbed),
        message:
          warningPrefix +
          "工具链完整，不需要装任何东西：" +
          packages.length +
          " 个组件都能跑，PATH 与配置都已就位（" +
          (binDir === "" ? msys64 : binDir) +
          "）。",
        nextStep: "",
        notes: [],
        durationMs: Date.now() - started,
      };
    }
    fillPlanDetails(steps, {
      ...facts,
      msys64,
      parent,
      binDir,
      packages,
      cachePath,
      cacheUrl: installer.url,
      configPath: configRead.path,
      writePath: request.writePath,
    });
    notes.push(usageNote(facts, download, packages));
    notes.push("这只是计划：没有下载、没有建目录、没有写注册表、没有改配置。");
    const confirmHint = nothingToDo
      ? "已经齐了：直接 stm32_env_probe 看四项能力，或 stm32_build 编译；要换一份 MSYS2 就传 targetDir。"
      : existing && pacmanUnknown
        ? "确认无误就带 confirm:true、dryRun:false 再调一次（真装时会先 pacman -Q，只补缺的包，不升级已装的）；想只装指定包就传 packages。"
      : existing
        ? "确认无误就带 confirm:true、dryRun:false 再调一次（只补缺的 " +
          String(missing.length) +
          " 个包，不升级已装的）；想只装指定包就传 packages。"
        : "确认无误就带 confirm:true、dryRun:false 再调一次（会真下载并安装）；只想装指定包就传 packages。";
    return {
      ok: decided,
      mode: "plan",
      needsDecision: decided ? "" : "msys64Dir",
      msys64,
      resolvedVia: target.via,
      binDirs: binDir === "" ? [] : [binDir],
      packages,
      steps,
      download,
      path: pathState,
      config: { path: configRead.path, written: false, error: "" },
      verify: toVerifyState(planProbed),
      message:
        warningPrefix +
        (decided
          ? planMessage(msys64, target.via, packages, download, facts)
          : decisionMessage(suggested, packages, download)),
      nextStep: decided
        ? confirmHint
        : "定下安装位置（targetDir，或回一句「装到 " + suggested + "」），我再出一份计划。",
      notes,
      durationMs: Date.now() - started,
    };
  }
  // -- 真装：不知道装哪就一步都不做 ------------------------------------
  if (msys64 === "") {
    fillPlanDetails(steps, {
      ...emptyFacts(packages),
      msys64,
      parent,
      binDir,
      packages,
      cachePath,
      cacheUrl: installer.url,
      configPath: configRead.path,
      writePath: request.writePath,
    });
    return {
      ok: false,
      mode: "install",
      needsDecision: "msys64Dir",
      msys64: "",
      resolvedVia: "",
      binDirs: [],
      packages,
      steps,
      download,
      path: pathState,
      config: { path: configRead.path, written: false, error: "" },
      verify: { ok: false, tools: [] },
      message: warningPrefix + decisionMessage(suggested, packages, download),
      nextStep: "带上 targetDir 再调一次（例如 targetDir=\"" + suggested + "\"）。",
      notes,
      durationMs: Date.now() - started,
    };
  }

  const timeoutMs = request.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const alreadyInstalled = isMsys2Root(msys64);
  let verifyState: Msys2InstallVerifyState = { ok: false, tools: [] };
  let configState: Msys2InstallConfigState = { path: configRead.path, written: false, error: "" };

  const finish = (ok: boolean, message: string, nextStep: string): Msys2InstallResult => ({
    ok,
    mode: "install",
    needsDecision: "",
    msys64,
    resolvedVia: target.via,
    binDirs: [binDir],
    packages,
    steps,
    download,
    path: pathState,
    config: configState,
    verify: verifyState,
    message,
    nextStep,
    notes,
    durationMs: Date.now() - started,
  });

  const prepareStep = stepOf(steps, "prepare");
  const downloadStep = stepOf(steps, "download");
  const extractStep = stepOf(steps, "extract");
  const pacmanStep = stepOf(steps, "pacman");
  const pathStep = stepOf(steps, "path");
  const verifyStep = stepOf(steps, "verify");
  const configStep = stepOf(steps, "config");

  const abortRest = (step: Msys2InstallStep): Msys2InstallResult => {
    setStep(step, "failed", "已取消");
    skipAfter(steps, step.id, "上一步被取消，未执行");
    return finish(
      false,
      "已取消：已经做过的步骤都留着了（不删任何东西）。",
      "需要时再调一次；已完成的步骤会自动跳过，不会重复下载、不会重复写 PATH。",
    );
  };

  // a) 准备目录
  beginStep(steps, prepareStep, request.onProgress);
  if (isAborted(request.signal)) return abortRest(prepareStep);
  if (alreadyInstalled) {
    setStep(
      prepareStep,
      "done",
      msys64 + " 里已经有一份能用的 MSYS2（有 usr/bin/bash.exe），跳过下载与解压",
    );
  } else {
    try {
      mkdirSync(parent, { recursive: true });
      if (existsSync(msys64)) {
        const entries = safeList(msys64);
        if (entries.length > 0) {
          setStep(
            prepareStep,
            "failed",
            "目标目录已存在且非空（" +
              String(entries.length) +
              " 项），但不是完整 MSYS2（缺 usr/bin/bash.exe）",
          );
          skipAfter(steps, "prepare", "目标目录不可用，未执行");
          return finish(
            false,
            "没有开始：目标目录 " + msys64 + " 已存在且不是一份完整 MSYS2，我不覆盖也不删除它。",
            "换一个空目录（例如 " +
              (msys64 === MSYS2_SUGGESTED_ROOT ? "D:/msys64" : MSYS2_SUGGESTED_ROOT) +
              "）再装，或先确认那个目录里放的是什么。",
          );
        }
      }
      setStep(prepareStep, "done", "父目录就绪：" + parent);
    } catch (error) {
      const reason = describeError(error);
      setStep(prepareStep, "failed", reason);
      skipAfter(steps, "prepare", "父目录建不了，未执行");
      return finish(
        false,
        "没能准备安装目录：" + reason,
        "检查路径是否合法、有没有写权限，或换一个 targetDir。",
      );
    }
  }

  // b) 下载安装包
  beginStep(steps, downloadStep, request.onProgress);
  if (isAborted(request.signal)) return abortRest(downloadStep);
  if (alreadyInstalled) {
    setStep(downloadStep, "skipped", "目标里已有 MSYS2，不需要安装包");
  } else if (cachedOk) {
    download = { url: installer.url, bytes: cachedBytes, cached: true };
    setStep(downloadStep, "done", "复用缓存：" + cachePath + "（" + formatBytes(cachedBytes) + "）");
  } else {
    const cacheDir = toPosix(dirname(cachePath));
    // 先下到 .part 再改名：半截文件绝不能被下一次当成"有效缓存"。
    const partPath = cachePath + ".part";
    try {
      mkdirSync(cacheDir, { recursive: true });
    } catch (error) {
      const reason = describeError(error);
      setStep(downloadStep, "failed", "建不了缓存目录 " + cacheDir + "：" + reason);
      skipAfter(steps, "download", "缓存目录不可用，未执行");
      return finish(false, "没能下载安装包：" + reason, "换一个可写目录后重试。");
    }
    request.onProgress?.("下载 " + formatBytes(MSYS2_INSTALLER_BYTES) + "：" + installer.url);
    const outcome = await runCapture(subprocess, {
      argv: [
        WINDOWS ? "curl.exe" : "curl",
        "-L",
        "--fail",
        "--retry",
        "3",
        "-o",
        partPath,
        installer.url,
      ],
      cwd: cacheDir,
      timeoutMs,
      maxBytes: 64 * 1024,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const downloadedBytes = fileSize(partPath);
    if (
      outcome.spawnError !== null ||
      outcome.timedOut ||
      outcome.exitCode !== 0 ||
      downloadedBytes === 0
    ) {
      removeFileQuietly(partPath);
      const reason =
        outcome.spawnError !== null
          ? "curl 起不来：" + outcome.spawnError
          : outcome.timedOut
            ? "下载超时（" + String(Math.round(timeoutMs / 1000)) + " s）"
            : outcome.exitCode !== 0
              ? "curl 退出码 " + String(outcome.exitCode) + "：" + (lastLine(outcome.stderr) || "（无输出）")
              : "下载回来是空文件";
      setStep(downloadStep, "failed", reason);
      skipAfter(steps, "download", "安装包没下来，未执行");
      return finish(
        false,
        "下载安装包失败：" + reason,
        "先确认这台机器能不能访问 " +
          installer.url +
          "（内网/代理可用 MSYS2_MIRROR）；也可以自己下载到 " +
          cachePath +
          " 再重试，已存在的有效缓存会直接复用。",
      );
    }
    try {
      renameSync(partPath, cachePath);
    } catch (error) {
      removeFileQuietly(partPath);
      const reason = describeError(error);
      setStep(downloadStep, "failed", "下载完成但改名失败：" + reason);
      skipAfter(steps, "download", "安装包落位失败，未执行");
      return finish(false, "安装包下载完成但没法落位：" + reason, "检查缓存目录权限后重试。");
    }
    download = { url: installer.url, bytes: fileSize(cachePath), cached: false };
    setStep(downloadStep, "done", "已下载：" + cachePath + "（" + formatBytes(download.bytes) + "）");
  }

  // c) 静默解压
  beginStep(steps, extractStep, request.onProgress);
  if (isAborted(request.signal)) return abortRest(extractStep);
  if (alreadyInstalled) {
    setStep(extractStep, "skipped", "目标里已有 MSYS2，跳过解压");
  } else {
    const extracted = await extractInstaller(subprocess, cachePath, msys64, request, timeoutMs);
    if (extracted.cancelled) {
      // 取消 ≠ 失败：什么都没坏，安装包还在缓存里，暂存目录也留着（下次进来先清掉重来）。
      setStep(extractStep, "failed", EXTRACT_CANCELLED);
      skipAfter(steps, "extract", "已取消，未执行");
      return finish(
        false,
        "已取消：解压还没做完，安装包已缓存在 " +
          cachePath +
          (extracted.staging === "" ? "" : "，暂存目录 " + extracted.staging + " 保留着") +
          "。",
        "取消不等于失败——要接着装就再调一次（已下载的安装包直接用），暂存目录会在下次解压开始时自动清掉，不用你先收拾。",
      );
    }
    if (!extracted.ok) {
      setStep(extractStep, "failed", extracted.detail);
      skipAfter(steps, "extract", "解压没成功，未执行");
      return finish(
        false,
        "解压失败：" + extracted.detail,
        "安装包已缓存在 " + cachePath + "，修好问题后重试不会重新下载；也可以手动把它解压到 " + msys64 + "。",
      );
    }
    setStep(extractStep, "done", "已解压到 " + msys64);
  }

  // d) pacman 补包
  beginStep(steps, pacmanStep, request.onProgress);
  if (isAborted(request.signal)) return abortRest(pacmanStep);
  const bashPath = msys64 + "/usr/bin/bash.exe";
  if (!existsSync(bashPath)) {
    setStep(pacmanStep, "failed", "找不到 " + bashPath + "，这份 MSYS2 不完整，没法补包");
    skipAfter(steps, "pacman", "MSYS2 不完整，未执行");
    return finish(
      false,
      "MSYS2 本体不完整（缺 usr/bin/bash.exe）：" + msys64,
      "删掉这个目录后重装（安装包已在缓存里，重装不用重新下载），或换一个 targetDir。",
    );
  }
  const runPacman = (line: string): Promise<RunOutcome> =>
    runCapture(subprocess, {
      argv: [bashPath, "-lc", line],
      cwd: msys64,
      timeoutMs,
      maxBytes: 512 * 1024,
      awaitQuiescence: true,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  // 先问一句"哪些已经装了"。pacman -S 对已装的包不是"跳过"而是"顺手升级"，
  // 在第 4 步把用户整套 mingw 工具链升一个大版本不是本工具的活（那是 pacman -Syu 的事）。
  const query = await runPacman("pacman -Q " + packages.join(" "));
  const installed = parsePacmanQuery(query.stdout);
  const missing = packages.filter((name) => !installed.has(name));
  if (missing.length === 0) {
    setStep(
      pacmanStep,
      "skipped",
      packages.map((name) => name.replace("mingw-w64-ucrt-x86_64-", "") + " " + (installed.get(name) ?? "")).join("、") +
        " 都已经装了，没有重复安装，也没有升级（要升级自己跑 pacman -Syu）。",
    );
  } else {
    // 全新解压出来的 MSYS2 里一个包都没有（库也是空的）：先整体升级一次把库与基包拉到最新，
    // 再补缺的包。已有 MSYS2 只补缺的那几个 —— 在第 4 步把用户整套 mingw 工具链升一个大版本不是本工具的活。
    const needsSync = installed.size === 0;
    const installCommand = pacmanInstallCommand(missing);
    // B14：不再 "-Sy 之后立刻 -S <pkg>"。官方把那种局部升级列为会解不开依赖的操作，
    // 用户只会在同一条命令上反复失败；新解压的基包里 -Syu 本来就是该做的第一件事。
    let command = needsSync ? PACMAN_UPGRADE_COMMAND : installCommand;
    if (needsSync) {
      request.onProgress?.(
        "刚解压出来的 MSYS2 里还没有包数据库：先整体升级一次（pacman -Syu --noconfirm），再补包",
      );
    }
    let pacman = await runPacman(command);
    if (isAborted(request.signal)) return abortRest(pacmanStep);
    if (needsKeyringInit(pacman)) {
      request.onProgress?.("pacman 的 keyring 没初始化：先 pacman-key --init / --populate msys2，再重试一次");
      const init = await runPacman("pacman-key --init && pacman-key --populate msys2");
      if (isAborted(request.signal)) return abortRest(pacmanStep);
      if (init.exitCode === 0) {
        pacman = await runPacman(command);
        if (isAborted(request.signal)) return abortRest(pacmanStep);
      } else {
        setStep(
          pacmanStep,
          "failed",
          "pacman-key 初始化失败（退出码 " +
            String(init.exitCode) +
            "）：" +
            (lastLine(init.stderr) || lastLine(init.stdout) || "（无输出）") +
            "\n手动：" +
            bashLine(msys64, "pacman-key --init && pacman-key --populate msys2"),
        );
        skipAfter(steps, "pacman", "补包失败，未执行");
        return finish(
          false,
          "pacman 的 keyring 初始化失败，包没装上。",
          "在 " +
            msys64 +
            " 里手动跑一遍 " +
            bashLine(msys64, "pacman-key --init && pacman-key --populate msys2") +
            " 后重试。",
        );
      }
    }
    // -Syu 成功只代表库和基包是新的，我们缺的 5 个组件还得单独补。
    if (needsSync && command === PACMAN_UPGRADE_COMMAND && pacmanOk(pacman)) {
      command = installCommand;
      pacman = await runPacman(command);
      if (isAborted(request.signal)) return abortRest(pacmanStep);
    }
    if (!pacmanOk(pacman)) {
      const reason =
        pacman.spawnError !== null
          ? "bash 起不来：" + pacman.spawnError
          : pacman.timedOut
            ? "pacman 超时（" + String(Math.round(timeoutMs / 1000)) + " s）"
            : "退出码 " +
              String(pacman.exitCode) +
              "：" +
              (lastLine(pacman.stderr) || lastLine(pacman.stdout) || "（无输出）");
      // A30：上次被强杀/断电留下的锁文件会让 pacman 一律拒绝开工；给具体命令，但不替用户删。
      const lockPath = msys64 + "/var/lib/pacman/db.lck";
      if (existsSync(lockPath)) {
        notes.push(
          "pacman 的锁还在：" +
            lockPath +
            "（一般是被中断或强杀留下的）。先确认没有 pacman / bash 进程在跑，删掉它再重试：" +
            bashLine(msys64, "rm -f /var/lib/pacman/db.lck") +
            "；锁在的时候 pacman 会一律拒绝开工。",
        );
      }
      // A30：文件冲突不是靠重试能过去的，指条明路就行（不自动 --overwrite，那会覆盖别人的文件）。
      if (/conflicting files|exists in filesystem|conflicts with/u.test((pacman.stdout + " " + pacman.stderr).toLowerCase())) {
        notes.push(
          "pacman 报的是文件冲突（conflicting files / exists in filesystem）：先整体升级一次（" +
            bashLine(msys64, PACMAN_UPGRADE_COMMAND) +
            "）；确认某几个文件被别的包占着、确实要顶掉时再自己加 --overwrite。本工具不会替你覆盖别人的文件。",
        );
      }
      // 不当场放弃：MSYS2 本体在，PATH / 配置照写，报告里把失败点写清楚。
      setStep(
        pacmanStep,
        "failed",
        reason +
          "\n手动：" +
          bashLine(msys64, command) +
          (reason.includes("无法满足依赖关系") || needsSync
            ? "\n这条一般是 MSYS2 的库与已装包不同步（局部升级解不开依赖）：先在 " +
              msys64 +
              " 里跑 pacman -Syu（整体升级），再重调本工具 —— 别只同步库就补单个包。"
            : ""),
      );
    } else {
      setStep(pacmanStep, "done", "pacman 退出码 0；补装的包：" + missing.join("、"));
    }
  }

  // e) 用户级 PATH
  beginStep(steps, pathStep, request.onProgress);
  if (isAborted(request.signal)) return abortRest(pathStep);
  if (!request.writePath) {
    setStep(
      pathStep,
      "skipped",
      "writePath=false：没动 PATH；要给命令行用就自己把 " + toWindowsDir(binDir) + " 加进 PATH",
    );
  } else {
    pathState = await applyUserPath(subprocess, env, binDir, request);
    if (pathState.done && !pathState.changed) {
      setStep(pathStep, "done", "用户 PATH 里已经有 " + toWindowsDir(binDir) + "，没有重复写");
    } else if (pathState.done) {
      setStep(
        pathStep,
        "done",
        "已把 " +
          toWindowsDir(binDir) +
          " 追加到用户级 PATH（REG_EXPAND_SZ）；旧值备份在 " +
          pathState.backup,
      );
    } else {
      // 失败不致命：插件按配置里的绝对路径找工具，PATH 只是给命令行/其他工具用的。
      // 读失败的情形 error 里已经带了手动命令，别把两套"手动："叠在一起让人误读。
      const manual = pathState.error.includes("手动：")
        ? ""
        : "\n手动：把 " +
          toWindowsDir(binDir) +
          " 追加到「环境变量 → 用户变量 → Path」（不要用 setx，它会在 1024 字符处截断 PATH）";
      setStep(pathStep, "failed", pathState.error + manual);
    }
  }

  // f) 自检
  beginStep(steps, verifyStep, request.onProgress);
  if (isAborted(request.signal)) return abortRest(verifyStep);
  const probeConfig = { binDirs: [binDir], cubeMxRoots: [] };
  const targets = buildTargets(probeConfig).filter((item) => VERIFY_IDS.includes(item.id));
  const probed = await probeAll(subprocess, targets, probeConfig, {
    timeoutMs: PROBE_TIMEOUT_MS,
    // 自检只认这个目录。允许 PATH 兜底的话，机器上另一份同名工具（STM32CubeIDE 自带、
    // xpack、旧的 msys64）会让"没装进目标目录"看起来像"装好了"。
    allowPathFallback: false,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  verifyState = toVerifyState(probed);
  // 绝对候选理论上仍可能指到目录之外，兜一层：只有命中的工具都真的躺在 binDir 里，
  // "这个目录装好了"才成立。
  const strayTools = probed.filter((result) => result.found && !isInsideDir(result.path, binDir));
  setStep(
    verifyStep,
    verifyState.ok ? "done" : "failed",
    verifyState.ok
      ? verifySummary(verifyState) +
          (strayTools.length === 0
            ? ""
            : "（其中 " + strayTools.map((tool) => tool.path).join("、") + " 不在 " + binDir + " 里）")
      : "缺 " +
          verifyState.tools
            .filter((tool) => !tool.found)
            .map((tool) => tool.label)
            .join("、") +
          "（只在 " + binDir + " 里找：PATH 上另一份同名工具不算装到这个目录）",
  );

  // g) 写配置（与已有 packages 合并去重，别的字段原样保留）
  beginStep(steps, configStep, request.onProgress);
  const beforeConfig = readToolchainConfig(env);
  const merged = dedupeStrings([...(beforeConfig.config?.packages ?? []), ...packages]);
  // A28：带上刚才读到的快照做 CAS。读和写之间要是别的进程（另开的 DSH 窗口、用户手改）动了配置，
  // 就重读、重新合并再写一次，而不是把对方那份直接覆盖掉。
  const written = updateToolchainConfig({ msys64, binDirs: [binDir], packages: merged }, env, {
    expect: { mtimeMs: beforeConfig.mtimeMs, updatedAt: beforeConfig.config?.updatedAt ?? "" },
  });
  configState = { path: written.path, written: written.ok, error: written.error };
  const conflictNote = written.attempts > 1 ? "（配置文件刚被别人改过，已重读后重试一次）" : "";
  setStep(
    configStep,
    written.ok ? "done" : "failed",
    written.ok
      ? "已写入 " + written.path + "（msys64 / binDirs / packages " + String(merged.length) + " 个）" + conflictNote
      : written.error,
  );

  // 只有 PATH 允许失败不致命：其余任何一步失败都算没装成。
  // 一个例外：pacman 补装失败，但 5 个组件都**从 binDir 里**跑起来了（自检通过且没有外来工具），
  // 说明这个目录本来就不缺东西——那不是"没装成"，如实记一行、继续当成功。
  // 反过来，只要有一个工具来自 binDir 之外，就不能改判：配置里最终指的是这个目录，
  // 而它其实没装好，用户下次编译才会撞上。
  if (verifyState.ok && strayTools.length === 0 && pacmanStep.status === "failed") {
    pacmanStep.status = "done";
    pacmanStep.detail =
      pacmanStep.detail +
      "\n但自检显示 5 个组件都是在 " +
      binDir +
      " 里跑起来的，按「已装」处理（插件不替你升级，要升级自己跑 pacman -Syu）。";
  }
  const fatal = steps.find((step) => step.status === "failed" && step.id !== "path");
  const ok = fatal === undefined;
  const pathFailed = pathStep.status === "failed";
  const message = ok
    ? "MSYS2 装到 " +
      msys64 +
      " 了，" +
      verifySummary(verifyState) +
      "；现在可以编译 / 烧录 / 调试。" +
      // 读不到 PATH 与"写了但失败"是两种事：前者一句"没写成功"会让用户以为是我们写坏了，
      // 所以这里把"为安全起见没动注册表"直接写进 message。
      (pathFailed
        ? pathState.error.startsWith(UNREADABLE_PATH_PREFIX)
          ? "（用户级 PATH 没动：读不到当前值，为安全起见不会写注册表；不影响插件按绝对路径找工具）"
          : "（用户 PATH 没写成功，不影响插件按绝对路径找工具）"
        : "")
    : "安装没全部成功：" +
      steps
        .filter((step) => step.status === "failed")
        .map((step) => step.label)
        .join("、") +
      "（每一步的原因都在 steps 里）。" +
      // 自检禁用了 PATH 兜底，这里必须说清"能跑"不等于"装到了目标目录"，
      // 否则用户看着别处的 gcc 好好的，会以为是我们判错了。
      (strayTools.length > 0
        ? " 能跑的那几个不在 " +
          binDir +
          " 里（" +
          strayTools.map((tool) => tool.path).join("、") +
          "），说明它们本来就在别的目录，这个目录并没有装好。"
        : pacmanStep.status === "failed" && !verifyState.ok
          ? " 自检只在 " + binDir + " 里找：PATH 上另一份同名工具不算装到这个目录。"
          : "") +
      // B14：pacman 那步失败时把「先 -Syu 整体升级」提到 message，别让用户重调同一条命令循环失败。
      (pacmanStep.status === "failed"
        ? " pacman 那一步的修法：先在 " + msys64 + " 里跑 " + bashLine(msys64, PACMAN_UPGRADE_COMMAND) + "（整体升级），再重调本工具；只同步软件库再补单个包属于局部升级，依赖会解不开。"
        : "");
  return finish(
    ok,
    message,
    ok
      ? "直接重跑你刚才的工具（stm32_build / stm32_flash / stm32_debug_run）；也可以用 stm32_env_probe 复看一遍。"
      : "看 steps 里失败那一步的 detail；修好后重调本工具，已完成的步骤会自动跳过（不会重复下载、不会重复写 PATH）。",
  );
}
