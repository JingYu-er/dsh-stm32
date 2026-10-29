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
import { runCapture, runStreaming } from "./subprocess-runner.js";
import { resolveToolIn } from "./probe.js";
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
  /**
   * 构建成功后额外转换的产物格式（2b）。默认不转换——现有用户行为一个字节都不变。
   * elf 恒有（编译链接本来就产它）；hex / bin 用同一工具链的 arm-none-eabi-objcopy 转出，
   * 产线烧录器、CubeProgrammer、J-Flash、串口 ISP 基本只认这两个格式。
   */
  artifacts?: ("elf" | "hex" | "bin")[];
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
  /** hex/bin 转换结果（2b）：请求了 artifacts 且转换成功时才有；失败进 notes 降级。 */
  converted?: { kind: "hex" | "bin"; path: string; size: number }[];
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

/** 构建目录里的一个 .elf 候选。 */
export interface ElfCandidate {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
}

/** CMakeCache 里记的工程名（CMAKE_PROJECT_NAME:<TYPE>=<名字>）；读不到返回空串。 */
function readCmakeProjectName(buildDir: string): string {
  try {
    const text = readFileSync(join(buildDir, "CMakeCache.txt"), "utf8");
    for (const raw of text.split(/\r?\n/u)) {
      const match = /^CMAKE_PROJECT_NAME:[A-Z]+=(.+)$/u.exec(raw.trim());
      if (match !== null && match[1] !== undefined && match[1].trim() !== "") return match[1].trim();
    }
  } catch {
    // 没有缓存文件或读不了：退回"最新的那个"，不影响出结果。
  }
  return "";
}

/** 构建目录里全部 .elf，按修改时间从新到旧。 */
export function elfCandidates(buildDir: string): ElfCandidate[] {
  let names: string[];
  try {
    names = readdirSync(buildDir).filter((name) => name.toLowerCase().endsWith(".elf"));
  } catch {
    return [];
  }
  const out: ElfCandidate[] = [];
  for (const name of names) {
    const file = join(buildDir, name);
    try {
      const stat = statSync(file);
      out.push({ name, path: file, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // 刚被删掉或被独占：跳过，下一次再找。
    }
  }
  out.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return out;
}

interface ElfPick {
  chosen: ElfCandidate;
  candidates: ElfCandidate[];
  /** true = 按 CMakeCache 的工程名选中（最权威）；false = 退回最新的那个。 */
  byProjectName: boolean;
}

function pickElf(buildDir: string): ElfPick | null {
  const candidates = elfCandidates(buildDir);
  if (candidates.length === 0) return null;
  const projectName = readCmakeProjectName(buildDir).toLowerCase();
  if (projectName !== "") {
    const exact = candidates.find((item) => item.name.toLowerCase() === projectName + ".elf");
    if (exact !== undefined) return { chosen: exact, candidates, byProjectName: true };
  }
  const newest = candidates[0];
  if (newest === undefined) return null;
  return { chosen: newest, candidates, byProjectName: false };
}

/**
 * 构建目录里的 .elf（F1）。
 *
 * 旧规则是"与构建目录同名的优先"，但构建目录叫 Debug、产物叫 demo.elf，两者永不相等，
 * 于是退化成 readdir 顺序——改过工程名重新生成之后，会把旧固件当产物烧进板子。
 * 现在的顺序：CMakeCache 里记的工程名（最权威）→ 修改时间最新（多产物时唯一有意义的判据）。
 */
export function findElf(buildDir: string): ElfInfo | null {
  const picked = pickElf(buildDir);
  if (picked === null) return null;
  const { chosen } = picked;
  return { path: chosen.path, size: chosen.size, mtimeMs: chosen.mtimeMs };
}

/** 多个 .elf 并存时给一句说明（只有一个时返回空串，报告不加噪音）。 */
export function elfSelectionNote(buildDir: string): string {
  const picked = pickElf(buildDir);
  if (picked === null || picked.candidates.length < 2) return "";
  const stamp = (ms: number): string => new Date(ms).toISOString().slice(11, 19);
  const others = picked.candidates.filter((item) => item.name !== picked.chosen.name);
  const list = others.slice(0, 4).map((item) => item.name + "（" + stamp(item.mtimeMs) + "）").join("、");
  return (
    "构建目录里有 " + String(picked.candidates.length) + " 个 .elf，用了 " + picked.chosen.name +
    "（" + stamp(picked.chosen.mtimeMs) + "，" +
    (picked.byProjectName ? "按 CMakeCache 的工程名选" : "按修改时间最新选") +
    "）；没动的 " + String(others.length) + " 个：" + list
  );
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
  if (elf !== null) {
    notes.push("产物：" + elf.path + "（" + String(elf.size) + " B）");
    const selectionNote = elfSelectionNote(buildDir);
    if (selectionNote !== "") notes.push(selectionNote);
  }
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
  // 2b：按请求转换 hex / bin。objcopy 失败不判 build 失败——编译本身成功了，
  // 转不出来只降级为 warning（给 CubeProgrammer 用户一句怎么自己转）。
  const wanted = new Set(request.artifacts ?? []);
  const converted: { kind: "hex" | "bin"; path: string; size: number }[] = [];
  if (elf !== null && (wanted.has("hex") || wanted.has("bin"))) {
    const objcopy = await resolveToolIn(subprocess, ["arm-none-eabi-objcopy"], config.binDirs, request.signal);
    for (const kind of ["hex", "bin"] as const) {
      if (!wanted.has(kind)) continue;
      if (objcopy === null) {
        notes.push("要 " + kind + " 但找不到 arm-none-eabi-objcopy（工具链不完整）；跳过转换，elf 仍可用");
        continue;
      }
      const out = elf.path.replace(/\.elf$/u, "") + (kind === "hex" ? ".hex" : ".bin");
      const conv = await runCapture(subprocess, {
        argv: [objcopy, "-O", kind === "hex" ? "ihex" : "binary", elf.path, out],
        cwd: buildDir,
        timeoutMs: 60_000,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (conv.spawnError === null && conv.exitCode === 0 && existsSync(out)) {
        const size = statSync(out).size;
        converted.push({ kind, path: out, size });
        notes.push(kind + "：" + out + "（" + String(size) + " B）");
      } else {
        notes.push(kind + " 转换失败（" + (conv.spawnError ?? "退出码 " + String(conv.exitCode)) + "）；elf 仍可用");
      }
    }
  }

  return {
    ok: true,
    ...base,
    ...(converted.length === 0 ? {} : { converted }),
    notes,
    message: "编译成功（" + (durationMs / 1000).toFixed(1) + " s，" + String(errors.length) + " 个错误、" + String(base.warningCount) + " 个警告）",
  };
}
