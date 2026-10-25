/**
 * L2：编译工作流 —— 复用工程自己的 CMake 配置（不另建构建系统）。
 *
 * 之所以不直接调 ninja：工程可能有多个 preset（build/Debug、build/Release），
 * CMakeCache 里已经记住了生成器与编译器路径，`cmake --build` 最不容易跑偏。
 * 产物路径与 CMakePresets.json 的 binaryDir 一致，这样 VS Code 的 F5 与插件看到同一个 .elf。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { resolveSearchConfig } from "../data/search-roots.js";
import { runStreaming } from "./subprocess-runner.js";
import { envWithBinDirs } from "./tool-env.js";
import type { SubprocessService } from "../types.js";

export interface BuildRequest {
  projectDir: string;
  buildDir?: string;
  target?: string;
  clean?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
  binDirs?: string[];
}

export interface MemoryUsage {
  region: string;
  usedBytes: number;
  totalBytes: number;
  percent: number;
  raw: string;
}

export interface ElfInfo {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface BuildReport {
  ok: boolean;
  projectDir: string;
  buildDir: string;
  command: string;
  durationMs: number;
  /** 没有退出码时省略（宿主输出校验不允许 null）。 */
  exitCode?: number;
  errors: string[];
  warningCount: number;
  memoryUsage: MemoryUsage[];
  /** 没有产物时省略（宿主输出校验不允许 null）。 */
  elf?: ElfInfo;
  message: string;
  logTail: string;
  notes: string[];
}

const DEFAULT_TIMEOUT_MS = 300_000;

function toBytes(value: string, unit: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(unit.toUpperCase() === "KB" ? parsed * 1024 : parsed);
}

/** 解析 ld 的 --print-memory-usage 表格行，例如 "RAM:        1584 B        20 KB       7.73%"。 */
export function parseMemoryUsage(text: string): MemoryUsage[] {
  const usages: MemoryUsage[] = [];
  const pattern = /^\s*([A-Za-z0-9_]+):\s+(\d+)\s*B\s+(\d+(?:\.\d+)?)\s*(KB|B)\s+(\d+(?:\.\d+)?)%\s*$/gmu;
  for (const match of text.matchAll(pattern)) {
    const usedBytes = Number.parseInt(match[2] as string, 10);
    const totalBytes = toBytes(match[3] as string, match[4] as string);
    usages.push({
      region: match[1] as string,
      usedBytes,
      totalBytes,
      percent: Number.parseFloat(match[5] as string),
      raw: match[0].trim(),
    });
  }
  return usages;
}

/** 从编译器/链接器输出里挑出错误行；重复行去重（同一头文件可能被多个 translation unit 报一次）。 */
export function parseBuildErrors(text: string): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const isError =
      /:\d+:\d+: error:/u.test(line) ||
      /^FAILED:/u.test(line) ||
      /\bundefined reference to\b/u.test(line) ||
      /\bld returned \d+ exit status\b/u.test(line) ||
      /^CMake Error/u.test(line) ||
      /\bninja: build stopped\b/u.test(line) ||
      /\bNo such file or directory\b/u.test(line);
    if (!isError) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    errors.push(line);
  }
  return errors;
}

export function countWarnings(text: string): number {
  let count = 0;
  for (const rawLine of text.split(/\r?\n/u)) {
    if (/:\d+:\d+: warning:/u.test(rawLine)) count += 1;
  }
  return count;
}

/** 读 CMakePresets.json 的 configurePresets，把 ${sourceDir}/${presetName} 展开成真实目录（带 preset 名）。 */
export function presetDirs(projectDir: string): { name: string; dir: string }[] {
  const presetsFile = join(projectDir, "CMakePresets.json");
  if (!existsSync(presetsFile)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(presetsFile, "utf8"));
  } catch {
    return [];
  }
  const presets = (parsed as { configurePresets?: unknown }).configurePresets;
  if (!Array.isArray(presets)) return [];
  const out: { name: string; dir: string }[] = [];
  for (const item of presets) {
    const record = item as { name?: unknown; binaryDir?: unknown; hidden?: unknown };
    if (typeof record.name !== "string" || record.hidden === true) continue;
    const binaryDir = typeof record.binaryDir === "string" ? record.binaryDir : "${sourceDir}/build";
    const expanded = binaryDir
      .replace(/\$\{sourceDir\}/gu, projectDir.replace(/\\/gu, "/"))
      .replace(/\$\{presetName\}/gu, record.name);
    out.push({ name: record.name, dir: resolve(expanded) });
  }
  return out;
}

function presetBuildDirs(projectDir: string): string[] {
  return presetDirs(projectDir).map((entry) => entry.dir);
}

/**
 * 找构建目录：先按 CMakePresets.json 的 binaryDir，再扫 build/ 下所有带 CMakeCache.txt 的目录。
 * 多个候选时优先含 "Debug" 的（ST 扩展默认 preset 就是 Debug）。
 */
export function detectBuildDir(projectDir: string): string | null {
  const candidates: string[] = [];
  for (const dir of presetBuildDirs(projectDir)) {
    if (existsSync(join(dir, "CMakeCache.txt"))) candidates.push(dir);
  }
  const buildRoot = join(projectDir, "build");
  if (candidates.length === 0 && existsSync(buildRoot)) {
    for (const entry of readdirSync(buildRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(buildRoot, entry.name);
      if (existsSync(join(dir, "CMakeCache.txt"))) candidates.push(dir);
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => {
    const leftDebug = /debug/iu.test(left) ? 0 : 1;
    const rightDebug = /debug/iu.test(right) ? 0 : 1;
    return leftDebug - rightDebug;
  });
  return candidates[0] as string;
}

/** 选一个用来首次配置的 preset：优先名字带 Debug 的，否则第一个。 */
export function pickConfigurePreset(projectDir: string): { name: string; dir: string } | null {
  const presets = presetDirs(projectDir);
  if (presets.length === 0) return null;
  const sorted = [...presets].sort((left, right) => {
    const leftDebug = /debug/iu.test(left.name) ? 0 : 1;
    const rightDebug = /debug/iu.test(right.name) ? 0 : 1;
    return leftDebug - rightDebug;
  });
  return sorted[0] ?? null;
}

/** 构建目录里的 .elf：优先与目录同名的（demo/build/Debug/demo.elf）。 */
export function findElf(buildDir: string): ElfInfo | null {
  if (!existsSync(buildDir)) return null;
  const names = readdirSync(buildDir).filter((name) => name.toLowerCase().endsWith(".elf"));
  if (names.length === 0) return null;
  const buildName = buildDir.replace(/\\/gu, "/").split("/").pop() ?? "";
  names.sort((left, right) => {
    const leftMatch = left.toLowerCase() === buildName.toLowerCase() + ".elf" ? 0 : 1;
    const rightMatch = right.toLowerCase() === buildName.toLowerCase() + ".elf" ? 0 : 1;
    return leftMatch - rightMatch;
  });
  const path = join(buildDir, names[0] as string);
  const stat = statSync(path);
  return { path, size: stat.size, mtimeMs: stat.mtimeMs };
}

/** 解析 cmake 可执行文件：优先显式 binDirs（msys64），否则交给 PATH。 */
function resolveCmake(subprocess: SubprocessService, binDirs: string[]): string {
  for (const dir of binDirs) {
    for (const name of ["cmake.exe", "cmake"]) {
      const abs = join(dir, name);
      if (existsSync(abs)) return abs;
    }
  }
  return "cmake";
}

function tail(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/u).filter((line) => line.trim() !== "");
  return lines.slice(-maxLines).join("\n");
}

function fail(request: BuildRequest, message: string, extra: Partial<BuildReport> = {}): BuildReport {
  const projectDir = resolve(request.projectDir);
  return {
    ok: false,
    projectDir,
    buildDir: "",
    command: "",
    durationMs: 0,
    errors: [],
    warningCount: 0,
    memoryUsage: [],
    message,
    logTail: "",
    notes: [],
    ...extra,
  };
}

export async function runBuild(subprocess: SubprocessService, request: BuildRequest): Promise<BuildReport> {
  const projectDir = resolve(request.projectDir);
  if (!existsSync(projectDir)) return fail(request, "工程目录不存在：" + projectDir);
  const config = resolveSearchConfig(process.env, request.binDirs === undefined ? {} : { binDirs: request.binDirs });
  const cmake = resolveCmake(subprocess, config.binDirs);
  // 子进程带上 binDirs 组成的 PATH：cmake 会再去调 arm-none-eabi-gcc / ninja / objcopy，
  // 只把这些目录用于"找 cmake 本身"是不够的（宿主进程的 PATH 可能还是安装前的旧值）。
  const childEnv = envWithBinDirs(config.binDirs);
  const progress = request.onProgress ?? ((): void => undefined);
  const preNotes: string[] = [];
  let buildDir = request.buildDir === undefined ? detectBuildDir(projectDir) : resolve(projectDir, request.buildDir);

  // 首次构建：CMakeCache.txt 还不存在（新建的工程就是这样）→ 按 CMakePresets.json 自动配置一次。
  // 等价于 VS Code 里第一次 "CMake: Configure"，省掉用户手动跑 cmake 的一步。
  if (buildDir === null) {
    const preset = pickConfigurePreset(projectDir);
    if (preset === null) {
      return fail(
        request,
        "在 " + projectDir + " 下找不到已配置的构建目录，也没有可用的 CMakePresets.json；先手动 cmake 配置一次，或让 stm32_project_create / stm32_generate 建工程",
      );
    }
    const configureArgv = [cmake, "--preset", preset.name];
    progress("首次构建：先配置（" + configureArgv.join(" ") + "）");
    const configureStartedAt = Date.now();
    const configured = await runStreaming(subprocess, {
      argv: configureArgv,
      cwd: projectDir,
      timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: 1024 * 1024,
      env: childEnv,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      onOutput: (stream, text) => {
        for (const line of text.split(/\r?\n/u)) {
          if (line.trim() !== "") progress((stream === "stderr" ? "! " : "") + line.trim().slice(0, 300));
        }
      },
    });
    const configureLog = configured.stdout + "\n" + configured.stderr;
    const configureSeconds = ((Date.now() - configureStartedAt) / 1000).toFixed(1);
    if (configured.spawnError !== null) {
      return fail(request, "cmake 配置失败：无法启动 " + cmake + "（" + configured.spawnError + "）");
    }
    if (configured.aborted) {
      return fail(request, "cmake 配置已取消（调用方中断，没有继续编译）");
    }
    if (configured.timedOut) {
      return fail(request, "cmake 配置超时（" + String(request.timeoutMs ?? DEFAULT_TIMEOUT_MS) + " ms）");
    }
    if (configured.exitCode !== 0) {
      const configureErrors = parseBuildErrors(configureLog);
      const first = configureErrors.length > 0 ? configureErrors[0] as string : "exit code " + String(configured.exitCode);
      return fail(request, "cmake 配置失败：" + first, {
        errors: configureErrors.length > 0 ? configureErrors : [first],
        logTail: tail(configureLog, 30),
        notes: ["配置命令：" + configureArgv.join(" ")],
      });
    }
    buildDir = detectBuildDir(projectDir);
    if (buildDir === null) {
      return fail(request, "cmake --preset " + preset.name + " 跑完了，但 " + preset.dir + " 下没有 CMakeCache.txt", {
        logTail: tail(configureLog, 30),
      });
    }
    preNotes.push("首次构建：自动执行了 cmake --preset " + preset.name + "（" + configureSeconds + " s，省掉手动配置）");
  }

  const argv = [cmake, "--build", buildDir];
  if (request.target !== undefined) argv.push("--target", request.target);
  if (request.clean === true) argv.push("--clean-first");
  argv.push("--parallel");
  const command = argv.map((part) => (part.includes(" ") ? '"' + part + '"' : part)).join(" ");
  progress("命令：" + command);

  const startedAt = Date.now();
  const outcome = await runStreaming(subprocess, {
    argv,
    cwd: projectDir,
    timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: 2 * 1024 * 1024,
    env: childEnv,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    onOutput: (stream, text) => {
      for (const line of text.split(/\r?\n/u)) {
        if (line.trim() !== "") progress((stream === "stderr" ? "! " : "") + line.trim().slice(0, 300));
      }
    },
    onHeartbeat: (elapsed) => progress("…编译中 " + String(Math.round(elapsed / 1000)) + " s"),
  });

  const durationMs = Date.now() - startedAt;
  const log = outcome.stdout + "\n" + outcome.stderr;
  const errors = parseBuildErrors(log);
  const memoryUsage = parseMemoryUsage(log);
  const elf = findElf(buildDir);
  const base = {
    projectDir,
    buildDir,
    command,
    durationMs,
    ...(outcome.exitCode === null ? {} : { exitCode: outcome.exitCode }),
    errors,
    warningCount: countWarnings(log),
    memoryUsage,
    ...(elf === null ? {} : { elf }),
    logTail: tail(log, 30),
  };
  const notes: string[] = [...preNotes];
  if (elf !== null) notes.push("产物：" + elf.path + "（" + String(elf.size) + " B）");
  if (memoryUsage.length > 0) notes.push("占用：" + memoryUsage.map((item) => item.region + " " + String(item.percent) + "%").join("，"));
  else if (elf !== null) notes.push("本次是增量构建，没有重新链接，因此没有内存占用数据（需要时用 clean 构建）");

  if (outcome.spawnError !== null) {
    return fail(request, "cmake 启动失败：" + outcome.spawnError, { ...base, errors: [outcome.spawnError] });
  }
  if (outcome.aborted) return fail(request, "编译已取消（调用方中断；已产出的目标文件会在下次构建时复用）", base);
  if (outcome.timedOut) return fail(request, "编译超时（" + String(request.timeoutMs ?? DEFAULT_TIMEOUT_MS) + " ms）", base);
  if (outcome.exitCode !== 0) {
    const first = errors.length > 0 ? errors[0] as string : "exit code " + String(outcome.exitCode);
    return fail(request, "编译失败：" + first, { ...base, notes });
  }
  // 实测：把整个工程（含 build/）复制/改名后，cmake 会先打印
  // "CMake Error: The current CMakeCache.txt directory ... is different than ..."，
  // 然后 ninja 仍然是 "no work to do"、退出码 0 —— 不显式拦下就会报“编译成功”，
  // 而实际上是拿着旧缓存跑的，产出的 elf 并不属于这个目录。
  const cacheMismatch = errors.find((line) => line.includes("CMake Error: The current CMakeCache.txt directory"));
  if (cacheMismatch !== undefined) {
    return fail(
      request,
      "build 目录是从别处复制或移动过来的：CMakeCache.txt 里记的绝对路径对不上（cmake 报错但退出码是 0，不拦会误报成功）。先 clean 或删掉 " + base.buildDir + " 再编译。",
      { ...base, errors, notes },
    );
  }
  return {
    ok: true,
    ...base,
    notes,
    message: "编译成功（" + (durationMs / 1000).toFixed(1) + " s，" + String(errors.length) + " 个错误、" + String(base.warningCount) + " 个警告）",
  };
}
