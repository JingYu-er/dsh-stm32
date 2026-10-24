/**
 * L1：工具链探测。
 *
 * 纯解析 + 一次版本执行。候选路径来自数据（search-roots），这里只负责
 * "找到可执行文件 → 跑一次版本命令 → 归纳成一条结论"。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { SearchConfig } from "../data/search-roots.js";
import type { SubprocessService } from "../types.js";
import { runCapture } from "./subprocess-runner.js";

export interface ProbeTarget {
  id: string;
  label: string;
  /** 绝对路径或裸命令名，按顺序尝试。 */
  candidates: string[];
  /** 版本参数的 argv；空数组表示只确认文件存在、不执行（如 CubeMX 启动器会 detach JVM）。 */
  versionArgs: string[];
  /** 缺失是否算致命。 */
  required: boolean;
  /** 缺失时给用户看的一句话（命令行级别，不展开）。 */
  hint: string;
  /** 缺失会影响哪些功能（写清"能干什么、干不了什么"）。 */
  impact: string;
  /** 推荐安装步骤，第一条是最省事的那条；含可直接粘贴的命令。 */
  install: string[];
  /** 装完怎么自检（一条命令或一次调用）。 */
  verify: string;
}

export interface ProbeResult {
  id: string;
  label: string;
  found: boolean;
  path: string;
  version: string;
  required: boolean;
  hint: string;
  impact: string;
  install: string[];
  verify: string;
  error: string;
}

export interface ProbeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

const WINDOWS = process.platform === "win32";

function isAbsoluteCandidate(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\") || value.startsWith("/");
}

function executableVariants(value: string): string[] {
  if (!WINDOWS) return [value];
  if (/\.(exe|cmd|bat)$/iu.test(value)) return [value];
  return [value + ".exe", value + ".cmd", value];
}

/** 在给定目录（以及 PATH 兜底前）解析一个候选。 */
export function resolveFromDirs(candidate: string, binDirs: string[]): string | null {
  if (isAbsoluteCandidate(candidate)) {
    for (const variant of executableVariants(candidate)) if (existsSync(variant)) return variant;
    return null;
  }
  for (const dir of binDirs) {
    for (const variant of executableVariants(join(dir, candidate))) {
      if (existsSync(variant)) return variant;
    }
  }
  return null;
}

/**
 * 引擎里找可执行文件的统一入口：先按显式目录（msys64 / binDirs）找文件，
 * 再交给宿主解析（等价于 PATH）。门禁（toolchain-gate）走的是同一套规则，
 * 两边不一致就会出现"门禁说齐全、引擎说找不到"的错位。
 */
export async function resolveToolIn(
  subprocess: SubprocessService | null | undefined,
  names: readonly string[],
  binDirs: readonly string[],
  signal?: AbortSignal,
): Promise<string | null> {
  const dirs = [...binDirs];
  for (const name of names) {
    const hit = resolveFromDirs(name, dirs);
    if (hit !== null) return hit;
  }
  if (subprocess === null || subprocess === undefined) return null;
  if (typeof subprocess.resolveExecutable !== "function") return null;
  for (const name of names) {
    try {
      const resolved = await subprocess.resolveExecutable(name, undefined, signal);
      if (typeof resolved === "string" && resolved !== "") return resolved;
    } catch {
      // 宿主解析失败（命令不存在）就继续试下一个候选名。
    }
  }
  return null;
}

function firstMeaningfulLine(text: string): string {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

async function resolveCandidate(
  subprocess: SubprocessService,
  candidate: string,
  config: SearchConfig,
  options: ProbeOptions,
): Promise<string | null> {
  const fromDirs = resolveFromDirs(candidate, config.binDirs);
  if (fromDirs !== null) return fromDirs;
  if (isAbsoluteCandidate(candidate)) return null;
  try {
    return await subprocess.resolveExecutable(candidate, undefined, options.signal);
  } catch {
    return null;
  }
}

export async function probeTarget(
  subprocess: SubprocessService,
  target: ProbeTarget,
  config: SearchConfig,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  let lastError = "";
  for (const candidate of target.candidates) {
    const resolved = await resolveCandidate(subprocess, candidate, config, options);
    if (resolved === null) continue;
    if (target.versionArgs.length === 0) {
      return {
        id: target.id,
        label: target.label,
        found: true,
        path: resolved,
        version: "",
        required: target.required,
        hint: target.hint,
        impact: target.impact,
        install: target.install,
        verify: target.verify,
        error: "",
      };
    }
    const outcome = await runCapture(subprocess, {
      argv: [resolved, ...target.versionArgs],
      timeoutMs: options.timeoutMs ?? 15_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (outcome.spawnError !== null) {
      lastError = candidate + ": " + outcome.spawnError;
      continue;
    }
    if (outcome.timedOut) {
      lastError = candidate + ": 版本命令超时";
      continue;
    }
    if (outcome.exitCode !== 0) {
      lastError =
        candidate + ": 退出码 " + String(outcome.exitCode) + " " + firstMeaningfulLine(outcome.stderr);
      continue;
    }
    const version = firstMeaningfulLine(outcome.stdout) || firstMeaningfulLine(outcome.stderr);
    return {
      id: target.id,
      label: target.label,
      found: true,
      path: resolved,
      version,
      required: target.required,
      hint: target.hint,
      impact: target.impact,
      install: target.install,
      verify: target.verify,
      error: "",
    };
  }
  return {
    id: target.id,
    label: target.label,
    found: false,
    path: "",
    version: "",
    required: target.required,
    hint: target.hint,
    impact: target.impact,
    install: target.install,
    verify: target.verify,
    error: lastError,
  };
}

export async function probeAll(
  subprocess: SubprocessService,
  targets: ProbeTarget[],
  config: SearchConfig,
  options: ProbeOptions = {},
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const target of targets) {
    results.push(await probeTarget(subprocess, target, config, options));
    if (options.signal?.aborted === true) break;
  }
  return results;
}

/** 从 binDirs 里认出 MSYS2 根（<root>/ucrt64/bin 这种形状）。 */
export function msys64RootFromBinDirs(binDirs: readonly string[]): string {
  for (const dir of binDirs) {
    const match = /^(.*)\/(?:ucrt64|mingw64|clang64|mingw32)\/bin$/iu.exec(dir);
    const root = match?.[1] ?? "";
    if (root !== "") return root;
  }
  return "";
}

/**
 * 安装建议里的 pacman：知道用户的 MSYS2 在哪就用它，不知道就给 MSYS2 的默认安装位置。
 * 绝不写死开发机的 D:/app/msys64 —— 别人机器上没这个目录，贴出来的命令等于假的。
 */
function pacmanHint(config: SearchConfig): string {
  const root = msys64RootFromBinDirs(config.binDirs);
  return (root === "" ? "C:/msys64" : root) + "/usr/bin/pacman.exe -S ";
}

/** 本机需要的能力清单。路径全部来自配置，不在逻辑里硬编码。 */
export function buildTargets(config: SearchConfig): ProbeTarget[] {
  const pacman = pacmanHint(config);
  const cubeMxLaunchers = config.cubeMxRoots.map((dir) => dir + "/STM32CubeMX.exe");
  const cubeMxJavas = config.cubeMxRoots.map((dir) => dir + "/jre/bin/java.exe");
  const cubeMxDefaultRoot = "C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeMX";
  return [
    {
      id: "gcc",
      label: "arm-none-eabi-gcc",
      candidates: ["arm-none-eabi-gcc"],
      versionArgs: ["--version"],
      required: true,
      hint: "装 GNU Arm 工具链：msys64 里 pacman -S mingw-w64-ucrt-x86_64-arm-none-eabi-gcc",
      impact: "编译不了：没有 arm-none-eabi-gcc 就产不出 build/Debug/demo.elf，烧录和调试也无从谈起。",
      install: [
        "已有 MSYS2 时最省事：" + pacman + "mingw-w64-ucrt-x86_64-arm-none-eabi-gcc（13.3.0）",
        "没有 MSYS2：winget install --id Arm.ArmGnuToolchain；装完把它的 bin 目录加进 STM32_BIN_DIRS（分号分隔，整份替换默认值）",
        "装完自检：arm-none-eabi-gcc --version",
      ],
      verify: "arm-none-eabi-gcc --version",
    },
    {
      id: "gdb",
      label: "GDB（arm-none-eabi-gdb 或 gdb-multiarch）",
      candidates: ["arm-none-eabi-gdb", "gdb-multiarch"],
      versionArgs: ["--version"],
      required: true,
      hint: "调试要 GDB：msys64 里 pacman -S mingw-w64-ucrt-x86_64-gdb-multiarch",
      impact: "调试用不了（F5 / stm32_debug_run 起不来 GDB）；只烧录不受影响，纯烧录只需要 openocd。",
      install: [
        "MSYS2：" + pacman + "mingw-w64-ucrt-x86_64-gdb-multiarch（16.2；UCRT64 仓库里没有 arm-none-eabi-gdb 这个包）",
        "不想装 MSYS2：winget install --id Arm.ArmGnuToolchain，它自带 arm-none-eabi-gdb，装完加进 STM32_BIN_DIRS",
        "装完自检：gdb-multiarch --version",
      ],
      verify: "gdb-multiarch --version",
    },
    {
      id: "openocd",
      label: "OpenOCD",
      candidates: ["openocd"],
      versionArgs: ["--version"],
      required: true,
      hint: "烧录/调试服务端：msys64 里 pacman -S mingw-w64-ucrt-x86_64-openocd",
      impact: "烧录和调试都用不了（stm32_flash / stm32_debug_run / stm32_stop 全部失败）；生成代码、编译、改 USER CODE 不受影响。",
      install: [
        "MSYS2：" + pacman + "mingw-w64-ucrt-x86_64-openocd（0.12.0）",
        "不想装 MSYS2：winget install --id xpack-dev-tools.openocd-xpack",
        "装完自检：openocd --version",
      ],
      verify: "openocd --version",
    },
    {
      id: "cmake",
      label: "CMake",
      candidates: ["cmake"],
      versionArgs: ["--version"],
      required: true,
      hint: "配置/编译要 CMake：msys64 里 pacman -S mingw-w64-ucrt-x86_64-cmake",
      impact: "配置和编译都会失败（build/Debug 配不起来）；烧录现成的 elf 不受影响。",
      install: [
        "MSYS2：" + pacman + "mingw-w64-ucrt-x86_64-cmake（3.31.5）",
        "或者 winget install --id Kitware.CMake；装了 ST 的 VS Code 扩展通常也会带一份 CMake",
        "装完自检：cmake --version",
      ],
      verify: "cmake --version",
    },
    {
      id: "ninja",
      label: "Ninja",
      candidates: ["ninja"],
      versionArgs: ["--version"],
      required: true,
      hint: "CMakePresets 指定 Ninja 生成器：msys64 里 pacman -S mingw-w64-ucrt-x86_64-ninja",
      impact: "编译失败：CMakePresets 指定 Ninja 生成器，配置阶段就会报找不到 ninja。",
      install: [
        "MSYS2：" + pacman + "mingw-w64-ucrt-x86_64-ninja（1.12.1）",
        "或者 winget install --id Ninja-build.Ninja",
        "装完自检：ninja --version",
      ],
      verify: "ninja --version",
    },
    {
      id: "cubemx",
      label: "STM32CubeMX（启动器）",
      candidates: cubeMxLaunchers,
      versionArgs: [],
      required: false,
      hint: "可选：只有建工程/重新生成代码需要；可用 STM32_CUBEMX_ROOT 指定安装根",
      impact:
        "只影响建工程与重新生成代码：stm32_project_create 和改 .ioc 后的 stm32_generate 用不了；编译、烧录、调试、以及 stm32_ioc_inspect / stm32_ioc_plan 的只读分析都不受影响。",
      install: [
        "官网下载安装（winget 里没有）：https://www.st.com/en/development-tools/stm32cubemx.html；装到默认目录 " + cubeMxDefaultRoot + " 会被自动发现",
        "装在别处：设 STM32_CUBEMX_ROOT=<安装根>（根下要有 STM32CubeMX.exe 和 jre/bin/java.exe），或把路径传给 stm32_env_probe 的 cubeMxRoots",
        "装完自检：<安装根>/jre/bin/java.exe -version 能打印版本",
      ],
      verify: "重跑一次 stm32_env_probe，cubemx 与 cubemx-java 两项都变成 OK",
    },
    {
      id: "cubemx-java",
      label: "STM32CubeMX 内置 JRE（无头调用必需）",
      candidates: cubeMxJavas,
      versionArgs: ["-version"],
      required: false,
      hint: "无头生成必须用 jre/bin/java.exe -jar <root>/STM32CubeMX.exe，直接跑 exe 会 detach 后假退出",
      impact:
        "无头生成会失败：插件必须用 <root>/jre/bin/java.exe -jar STM32CubeMX.exe 调用，直接跑 exe 会 detach 后假退出。通常是 CubeMX 装得不完整，或只拷了 exe 没带 jre 目录。",
      install: [
        "用官网安装包重装 STM32CubeMX（自带 JRE）；只拷一个 exe 是不够的",
        "装完自检：<安装根>/jre/bin/java.exe -version",
      ],
      verify: "重跑一次 stm32_env_probe，cubemx-java 变成 OK",
    },
  ];
}
