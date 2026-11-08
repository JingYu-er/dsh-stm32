/**
 * L2：flash —— 只烧录，不进调试会话（用户最初的痛点：F5/Ctrl+F5 都会把调试器拉起来）。
 *
 * 干的事就是命令行等价物：
 *   openocd -f <cfg> -c "program <elf> verify reset exit"
 * 跑完 reset run 就退出，探针立刻释放，不留后台 server，也不停核。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { chooseOpenocdTarget, readProjectFamily } from "../data/family.js";
import type { Stm32FamilyProfile } from "../data/family.js";
import { describeSearchScope, resolveSearchConfig } from "../data/search-roots.js";
import type { SearchConfig } from "../data/search-roots.js";
import type { SubprocessService } from "../types.js";
import { liveProbeChoice, usbDiagnosis } from "./doctor.js";
import { cubeProgrammerBackendNote, findCubeProgrammerCli, runCubeProgrammerFlash } from "./cube-programmer.js";
import { classifyProbeFailure, makeProbeError, probeMissingLines, usbNoteFor } from "./probe-error.js";
import type { ProbeError } from "./probe-error.js";
import { detectBuildDir, elfSelectionNote, findElf } from "./build.js";
import { findIocFile } from "./generate.js";
import { summarizeIoc } from "./ioc.js";
import { resolveToolIn } from "./probe.js";
import { runStreaming } from "./subprocess-runner.js";

export type FlashBackend = "auto" | "openocd" | "cubeprogrammer";

export interface FlashRequest {
  projectDir: string;
  /** 显式 .elf；缺省按构建目录推断。 */
  elfPath?: string;
  buildDir?: string;
  /** openocd 可执行文件；缺省按 binDirs 解析。 */
  openOcdPath?: string;
  /** 工程内的 openocd 配置文件（相对 projectDir）；缺省依次找 openocd.cfg、openocd/openocd.cfg。 */
  configFile?: string;
  /** 显式指定 SWD 守卫要看的 .ioc（工程里有多个 .ioc 时用它指定）。 */
  iocPath?: string;
  /** 找不到工程配置时的兜底：接口与目标配置文件（相对 openocd scripts 目录）。 */
  interfaceConfig?: string;
  targetConfig?: string;
  /** -c "adapter speed <kHz>"；缺省不加（用探针默认）。 */
  adapterSpeed?: number;
  /**
   * 烧录后端：auto（默认，openocd 先烧、失败再试 CubeProgrammer CLI）/ openocd / cubeprogrammer。
   * CLI 只认 ST-LINK；H5/WBA/WB0/WL3 这类 openocd 根本没有 flash 驱动的族只能走它。
   */
  backend?: FlashBackend;
  /** 烧完是否复位并运行；默认 true（= "只烧录"，不进调试）。 */
  runAfterReset?: boolean;
  /** .ioc 里没有 Serial Wire 时是否仍然烧录（默认 false：拒绝，见 A5）。 */
  allowNoDebug?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  binDirs?: string[];
  onProgress?: (line: string) => void;
}

export interface FlashReport {
  ok: boolean;
  projectDir: string;
  elfPath: string;
  elfSize: number;
  command: string;
  args: string[];
  configs: string[];
  durationMs: number;
  /** 没有退出码时省略（宿主输出校验不允许 null）。 */
  exitCode?: number;
  programmed: boolean;
  verified: boolean;
  /** 结构化探针错误（B2）：失败给 kind/cause/hint/evidence/retryable，成功时是 null。 */
  probeError: ProbeError | null;
  errors: string[];
  message: string;
  logTail: string;
  notes: string[];
  /** 被守卫拦下时的原因标识（目前只有 "no-debug"）。 */
  guard?: string;
}

export interface NoDebugGuard {
  blocked: boolean;
  errors: string[];
  notes: string[];
}

/**
 * A5 守卫：.ioc 里没启用 Serial Wire 时，CubeMX 会生成 __HAL_AFIO_REMAP_SWJ_DISABLE()，
 * 烧完 SWD 就废了，下一次只能靠 BOOT0 进系统 bootloader 救回来。
 * 所以**烧录前**先看 .ioc，宁可拒绝也不要烧成砖。没有 .ioc 时不拦（可能是别人给的 hex 工程）。
 */
export function checkNoDebugGuard(projectDir: string, allowNoDebug = false, explicitIoc = ""): NoDebugGuard {
  if (allowNoDebug) return { blocked: false, errors: [], notes: [] };
  const iocPath = explicitIoc !== ""
    ? (isAbsolute(explicitIoc) ? explicitIoc : resolve(projectDir, explicitIoc))
    : findIocFile(projectDir);
  if (iocPath === null || !existsSync(iocPath)) {
    // 审计 A6：findIocFile 只认「唯一」，0 个或有多个都返回 null。以前这里静默放行，
    // 用户拿别人的工程（或 demo.ioc + demo_backup.ioc）时 SWD 守卫等于不存在，
    // 烧下去 SWD 被关掉只能 BOOT0 救砖。现在至少要把"守卫没生效"说清楚。
    let names: string[] = [];
    try {
      names = existsSync(projectDir)
        ? readdirSync(projectDir).filter((name) => name.toLowerCase().endsWith(".ioc"))
        : [];
    } catch {
      names = [];
    }
    const why = iocPath !== null && explicitIoc !== ""
      ? "指定的 .ioc 不存在：" + iocPath
      : names.length === 0
        ? "工程里没有 .ioc"
        : "工程里有 " + String(names.length) + " 个 .ioc（" + names.join("、") + "），分不清用哪个";
    // 2c：没有 .ioc（寄存器工程就是这样）时退回看 openocd.cfg 的 transport——
    // 插件生成的 cfg 固定是 hla_swd；用户换成 jtag 的 cfg 就给警告，守卫从此也覆盖寄存器工程。
    const cfg = findProjectConfig(projectDir);
    if (cfg !== null) {
      try {
        const cfgText = readFileSync(cfg, "utf8");
        const isSwd = /transport\s+select\s+(?:hla_)?swd/iu.test(cfgText);
        const isJtag = /transport\s+select\s+jtag/iu.test(cfgText);
        if (isSwd) {
          return {
            blocked: false,
            errors: [],
            notes: ["SWD 守卫（openocd.cfg 版）：transport 是 swd，探针侧不会关调试口；固件侧仍可能自己关 SWD，烧录前自行确认固件没动 AFIO_MAPR。"],
          };
        }
        if (isJtag) {
          return {
            blocked: false,
            errors: [],
            notes: [
              "SWD 守卫（openocd.cfg 版）：openocd.cfg 选了 jtag 而不是 swd。F103 的 JTAG 引脚与 SWD 引脚复用，" +
                "用 JTAG 烧录前确认固件没有把 PA13/PA14 改作他用。",
            ],
          };
        }
        return { blocked: false, errors: [], notes: ["SWD 守卫没生效：" + why + "；openocd.cfg 里也没有 transport select，无法判断。"] };
      } catch {
        return { blocked: false, errors: [], notes: ["读不了 openocd.cfg（" + cfg + "），跳过 SWD 守卫"] };
      }
    }
    return {
      blocked: false,
      errors: [],
      notes: [
        "SWD 守卫没生效：" + why + "。烧录前请自己确认 .ioc 里 PA13 是 SYS_JTMS-SWDIO、PA14 是 SYS_JTCK-SWCLK；" +
          "没启用 Serial Wire 时烧下去会关掉 SWD，之后只能 BOOT0=1 进系统 bootloader 救回来。",
        "想让它自动检查：工程根目录只留一个 .ioc，或给 stm32_flash 传 iocPath 指向正确的那份。",
      ],
    };
  }
  let summary;
  try {
    summary = summarizeIoc(readFileSync(iocPath, "utf8"), iocPath);
  } catch {
    return { blocked: false, errors: [], notes: ["读不了 .ioc（" + iocPath + "），跳过 SWD 守卫"] };
  }
  if (summary.debug.serialWire) return { blocked: false, errors: [], notes: [] };
  return {
    blocked: true,
    errors: [summary.warnings[0] ?? "没有启用 Serial Wire 调试口（缺 SYS_JTMS-SWDIO/SYS_JTCK-SWCLK）"],
    notes: [
      "没烧：.ioc 里没启用 Serial Wire，烧下去固件会关掉 SWD，之后只能靠 BOOT0=1 进系统 bootloader 才能再连上。",
      "修法一（推荐）：stm32_ioc_plan 里把 PA13 设为 SYS_JTMS-SWDIO、PA14 设为 SYS_JTCK-SWCLK → stm32_ioc_apply → stm32_generate，再烧。",
      "修法二（确认已经连不上、要救砖）：真的想烧就带 allowNoDebug=true，承认烧完要按 BOOT0 恢复。",
      "参考文件：" + iocPath,
    ],
  };
}

/** openocd 的相对路径参数一律换成正斜杠：反斜杠会被 Tcl 当转义吃掉。 */
export function toOpenOcdPath(path: string): string {
  return path.replace(/\\/gu, "/");
}

/** 把 program 参数拼成一条 openocd -c 命令。 */
export function buildProgramCommand(elfPath: string, options: { verify?: boolean; reset?: boolean; exit?: boolean } = {}): string {
  const parts = ["program", '"' + toOpenOcdPath(elfPath) + '"'];
  if (options.verify !== false) parts.push("verify");
  if (options.reset !== false) parts.push("reset");
  if (options.exit !== false) parts.push("exit");
  return parts.join(" ");
}

/** 只在展示时用：参数里已经带双引号时改用单引号，避免出现 "program "x.elf" verify"。 */
export function quoteForDisplay(item: string): string {
  if (!item.includes(" ")) return item;
  return item.includes('"') ? "'" + item + "'" : '"' + item + '"';
}

/**
 * 内置兜底配置：探针只 CMSIS-DAP（规格 §13），target 按芯片族取。
 *
 * family 省略/null 时保持历史行为回退 stm32f1x。真正的"按族选 target + 选不出来就拒绝"
 * 走 chooseOpenocdTarget（data/family.ts）——这里只负责拼相对路径。
 */
export function defaultConfigs(
  family?: Pick<Stm32FamilyProfile, "openocdTarget"> | null,
): { interfaceConfig: string; targetConfig: string } {
  const target = family === undefined || family === null ? "stm32f1x" : (family.openocdTarget ?? "stm32f1x");
  return { interfaceConfig: "interface/cmsis-dap.cfg", targetConfig: "target/" + target + ".cfg" };
}

export function findProjectConfig(projectDir: string, explicit?: string): string | null {
  if (explicit !== undefined && explicit !== "") {
    const abs = isAbsolute(explicit) ? explicit : resolve(projectDir, explicit);
    return existsSync(abs) ? abs : null;
  }
  for (const candidate of ["openocd.cfg", "openocd/openocd.cfg", "OpenOCD.cfg"]) {
    const abs = resolve(projectDir, candidate);
    if (existsSync(abs)) return abs;
  }
  return null;
}

export function resolveElf(projectDir: string, request: FlashRequest): { elf: string | null; buildDir: string | null; note: string } {
  if (request.elfPath !== undefined && request.elfPath !== "") {
    const abs = isAbsolute(request.elfPath) ? request.elfPath : resolve(projectDir, request.elfPath);
    if (existsSync(abs)) return { elf: abs, buildDir: null, note: "" };
    return { elf: null, buildDir: null, note: "指定的 .elf 不存在：" + abs };
  }
  const buildDir = request.buildDir !== undefined && request.buildDir !== ""
    ? (isAbsolute(request.buildDir) ? request.buildDir : resolve(projectDir, request.buildDir))
    : detectBuildDir(projectDir);
  if (buildDir === null) return { elf: null, buildDir: null, note: "找不到构建目录（先跑 stm32_build）" };
  const elfInfo = findElf(buildDir);
  if (elfInfo === null) return { elf: null, buildDir, note: "构建目录里没有 .elf（先跑 stm32_build）" };
  return { elf: elfInfo.path, buildDir, note: "" };
}

export interface FlashLogVerdict {
  programmed: boolean;
  verified: boolean;
  /** 真正导致失败的行；成功序列齐全时一律为空（A25）。 */
  errors: string[];
  /** 成功路径上照样会出现的 Error: 行（DAP / ACK 噪音），只当信息。 */
  noise: string[];
}

/**
 * 认 openocd 的 ** Programming Finished ** / ** Verified OK ** 与 Error: 行。
 * 归类不在这里做：失败原因要连退出码/超时/启动失败一起看，统一走 probe-error.ts 的
 * classifyProbeFailure（B2 之后只有这一个分类入口，避免两份规则漂移）。
 */
export function parseFlashLog(text: string): FlashLogVerdict {
  const programmed = /\*\*\s*Programming Finished\s*\*\*/u.test(text);
  const verified = /\*\*\s*Verified OK\s*\*\*/u.test(text);
  // A25：以成功序列为主判据。openocd 成功时也会打 Error: 前缀的行（无关 ACK / DAP 噪声），
  // 以前把它们一律当失败，于是「烧录成功、已校验」被判成失败。
  const succeeded = programmed && verified;
  const errors: string[] = [];
  const noise: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "") continue;
    const isError =
      /^Error:/u.test(line) ||
      /\*\*\s*(Programming|Verify|Reset)[^]*Failed[^]*\*\*/u.test(line) ||
      /^Error: Error connecting DP/u.test(line) ||
      /no device found/i.test(line) ||
      /unable to find a matching CMSIS-DAP device/iu.test(line);
    if (!isError) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    if (succeeded) noise.push(line);
    else errors.push(line);
  }
  return { programmed, verified, errors, noise };
}

interface FlashTarget {
  ok: true;
  projectDir: string;
  elfPath: string;
  elfSize: number;
  notes: string[];
}

/**
 * 两条后端共用的前置：找 .elf、按 .ioc 过 SWD 守卫、把"烧的是哪一个"说清楚。
 * 后端只决定"字节怎么进 Flash"；这些判断与后端无关——CubeProgrammer 同样会把 SWD 烧失联。
 */
function prepareFlashTarget(projectDir: string, request: FlashRequest, startedAt: number): FlashTarget | { ok: false; report: FlashReport } {
  const notes: string[] = [];
  const elfResolved = resolveElf(projectDir, request);
  if (elfResolved.elf === null) {
    return {
      ok: false,
      report: {
        ok: false, projectDir, elfPath: "", elfSize: 0, command: "", args: [], configs: [],
        durationMs: Date.now() - startedAt, programmed: false, verified: false,
        probeError: null,
        errors: [elfResolved.note], message: "没烧：找不到要烧的 .elf", logTail: "", notes,
      },
    };
  }
  const elfPath = elfResolved.elf;
  const elfSize = statSync(elfPath).size;
  // 多个 .elf 并存时说清"烧的是哪一个、为什么是它"。
  const selectionNote = elfSelectionNote(dirname(elfPath));
  if (selectionNote !== "") notes.push(selectionNote);

  // A5：先看 .ioc，别把 SWD 烧死。
  const guard = checkNoDebugGuard(projectDir, request.allowNoDebug === true, request.iocPath ?? "");
  if (!guard.blocked && guard.notes.length > 0) notes.push(...guard.notes);
  if (guard.blocked) {
    return {
      ok: false,
      report: {
        ok: false, projectDir, elfPath, elfSize, command: "", args: [], configs: [],
        durationMs: Date.now() - startedAt, programmed: false, verified: false,
        // 守卫拒绝不是探针故障：这次连烧录器都没起，probeError 保持 null。
        probeError: null,
        errors: guard.errors, message: "没烧：.ioc 里没启用 Serial Wire（SWD 会被关掉）",
        logTail: "", notes: [...notes, ...guard.notes], guard: "no-debug",
      },
    };
  }
  return { ok: true, projectDir, elfPath, elfSize, notes };
}

/**
 * CLI 的失败文本不在 openocd 的错误字符串里，classifyProbeFailure 认不出，
 * 这里只归两类有把握的：没看见 ST-Link（换探针/插好）与连不上目标（供电/接线/芯片）。
 */
function cliFailureProbeError(errors: readonly string[]): ProbeError | null {
  const text = errors.join("\n");
  if (/No ST-Link detected|no st-link/iu.test(text)) {
    return makeProbeError("no-probe", { cause: "CubeProgrammer 没看到 ST-LINK", evidence: errors.slice(0, 3) });
  }
  if (/Unable to connect|Cannot connect/iu.test(text)) {
    return makeProbeError("target-mismatch", { cause: "CubeProgrammer 连不上目标", evidence: errors.slice(0, 3) });
  }
  return null;
}

/** CubeProgrammer 后端（ST-LINK 官方 CLI）：不经过 openocd，也不依赖 target/flash 脚本。 */
async function runCubeProgrammerBackend(subprocess: SubprocessService, request: FlashRequest, probeNote: string): Promise<FlashReport> {
  const projectDir = resolve(request.projectDir);
  const startedAt = Date.now();
  const target = prepareFlashTarget(projectDir, request, startedAt);
  if (!target.ok) return target.report;
  const { elfPath, elfSize } = target;
  const notes = target.notes;
  if (probeNote !== "") notes.unshift(probeNote);

  const config = resolveSearchConfig(process.env, request.binDirs === undefined ? {} : { binDirs: request.binDirs });
  const cli = findCubeProgrammerCli(config.cubePrgBins);
  if (cli === null) {
    const searched = describeSearchScope(config.cubePrgBins, "STM32_CUBE_PRG_ROOT");
    return {
      ok: false, projectDir, elfPath, elfSize, command: "", args: [], configs: [],
      durationMs: Date.now() - startedAt, programmed: false, verified: false,
      probeError: null,
      errors: ["没找到 STM32_Programmer_CLI.exe（查过 " + searched + "）"],
      message: "没烧：backend=cubeprogrammer 需要 STM32CubeProgrammer 的 CLI，本机没找到",
      logTail: "", notes,
    };
  }
  const alt = await runCubeProgrammerFlash(subprocess, {
    projectDir,
    elfPath,
    cliPath: cli,
    ...(request.adapterSpeed === undefined ? {} : { adapterSpeed: request.adapterSpeed }),
    runAfterReset: request.runAfterReset !== false,
    timeoutMs: request.timeoutMs ?? 120_000,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress }),
  });
  if (alt.ok) notes.push(cubeProgrammerBackendNote(cli));
  return {
    ok: alt.ok,
    projectDir,
    elfPath,
    elfSize,
    command: alt.command,
    args: alt.args,
    configs: [],
    durationMs: Date.now() - startedAt,
    ...(alt.exitCode === null ? {} : { exitCode: alt.exitCode }),
    programmed: alt.programmed,
    verified: alt.verified,
    probeError: alt.ok ? null : cliFailureProbeError(alt.errors),
    errors: alt.errors,
    message: alt.message,
    logTail: alt.logTail,
    notes,
  };
}

/** openocd 后端主体；ifaceOverride 只在工程没有自己的 openocd.cfg 时参与兜底 interface 选择。 */
async function runOpenocdFlash(subprocess: SubprocessService, request: FlashRequest, ifaceOverride?: string): Promise<FlashReport> {
  const projectDir = resolve(request.projectDir);
  const config: SearchConfig = resolveSearchConfig(process.env, request.binDirs === undefined ? {} : { binDirs: request.binDirs });
  const startedAt = Date.now();
  const target = prepareFlashTarget(projectDir, request, startedAt);
  if (!target.ok) return target.report;
  const { elfPath, elfSize } = target;
  const notes = target.notes;

  const openOcd = request.openOcdPath !== undefined && request.openOcdPath !== ""
    ? request.openOcdPath
    : await resolveToolIn(subprocess, ["openocd"], config.binDirs);
  if (openOcd === null) {
    return {
      ok: false, projectDir, elfPath, elfSize, command: "", args: [], configs: [],
      durationMs: Date.now() - startedAt, programmed: false, verified: false,
      probeError: null,
      errors: ["找不到 openocd"],
      message:
        "没烧：找不到 openocd（msys64 里 pacman -S mingw-w64-ucrt-x86_64-openocd）；查过 " +
        describeSearchScope(config.binDirs, "PATH"),
      logTail: "",
      notes,
    };
  }

  const configs: string[] = [];
  const projectConfig = findProjectConfig(projectDir, request.configFile);
  if (projectConfig !== null) {
    configs.push(toOpenOcdPath(projectConfig));
  } else {
    // 按 .ioc 的 Mcu.Family 选 target：F1 仍是 stm32f1x，换了族不会再拿 F1 的脚本硬连。
    const family = readProjectFamily(projectDir);
    const choice = chooseOpenocdTarget(family);
    if (choice.error !== "") {
      return {
        ok: false, projectDir, elfPath, elfSize, command: "", args: [], configs: [],
        durationMs: Date.now() - startedAt, programmed: false, verified: false,
        probeError: null,
        errors: [choice.error],
        message: "没烧：" + (family === null ? "认不出芯片族" : "本机 openocd 没有 " + family.id + " 的 target 脚本"),
        logTail: "",
        notes,
      };
    }
    configs.push(request.interfaceConfig ?? ifaceOverride ?? "interface/cmsis-dap.cfg", request.targetConfig ?? choice.targetConfig);
    notes.push("工程里没有 openocd 配置文件，回退到 " + configs.join(" + "));
    if (family !== null) notes.push("芯片族按 .ioc 判定：" + family.id + "（内核 " + family.core + "）");
    if (choice.note !== "") notes.push(choice.note);
  }

  const args: string[] = [openOcd];
  for (const cfg of configs) args.push("-f", cfg);
  if (request.adapterSpeed !== undefined) args.push("-c", "adapter speed " + String(request.adapterSpeed));
  args.push("-c", buildProgramCommand(elfPath, { reset: request.runAfterReset !== false }));

  const command = args.map(quoteForDisplay).join(" ");
  request.onProgress?.("烧录：" + command);

  const outcome = await runStreaming(subprocess, {
    argv: args,
    cwd: projectDir,
    timeoutMs: request.timeoutMs ?? 120_000,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    onOutput: (stream, text) => {
      for (const line of text.split(/\r?\n/u)) {
        if (line.trim() !== "") request.onProgress?.(line.trim());
      }
    },
  });

  const log = outcome.stdout + "\n" + outcome.stderr;
  const verdict = parseFlashLog(log);
  const errors = [...verdict.errors];
  if (outcome.spawnError !== null) errors.push("openocd 启动失败：" + outcome.spawnError);
  if (outcome.timedOut) errors.push("超时（" + String(request.timeoutMs ?? 120_000) + " ms）：烧录没跑完");

  if (verdict.noise.length > 0) {
    notes.push(
      "openocd 成功路径上的 " + String(verdict.noise.length) + " 条 Error: 行按噪声处理（首条：" +
        (verdict.noise[0] ?? "") + "）",
    );
  }
  const ok = outcome.exitCode === 0 && outcome.spawnError === null && !outcome.timedOut && verdict.programmed && errors.length === 0;
  if (!ok && verdict.programmed && !verdict.verified) notes.push("写入成功但校验没过，建议重试或降低 adapter speed");
  if (ok) notes.push("产物：" + basename(elfPath) + "（" + String(elfSize) + " B）已写入并复位运行，探针已释放");

  // B2：失败时只归一次类。模型按 kind 分支、按 hint 动手，不用自己解析中文 message。
  // unknown 不往 notes 里推 hint：没有依据的"下一步"只会盖住真正的根因。
  const probeError: ProbeError | null = ok
    ? null
    : classifyProbeFailure({
      // 分类要看**完整日志**，不能只看解析出的 Error 行：target 不匹配这类故障，
      // openocd 只打一行 `Warn : Cannot identify target as a STM32 family.`（2026-10-31 实测，
      // 只看 errors 时就落到 unknown）。errors 里还有我们自己合成的行（spawn 失败/超时），排在后面。
      lines: [
        ...log.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== ""),
        ...errors,
      ],
      exitCode: outcome.exitCode,
      stage: "flash",
      timedOut: outcome.timedOut,
      spawnError: outcome.spawnError,
    });
  if (probeError !== null && probeError.kind !== "unknown") notes.push(probeError.hint);
  if (probeError !== null && probeError.kind === "no-probe" && probeMissingLines(errors).length > 0) {
    // 2a：找不到设备时顺手做一次 USB 形态诊断——"没插"与"这台机器根本没 USB"是两种答案。
    // 诊断失败静默（unknown 不进 notes），绝不能让诊断把失败报告搞得更吵。
    const usb = await usbDiagnosis(subprocess, request.signal);
    const extra = usbNoteFor(usb.kind, usb.detail);
    if (extra !== null) notes.push(extra);
  }

  const message = ok
    ? "烧录成功（" + ((Date.now() - startedAt) / 1000).toFixed(1) + " s" + (verdict.verified ? "，已校验" : "") + "）"
    : "烧录失败：" + (errors[0] ?? "openocd 退出码 " + String(outcome.exitCode));

  return {
    ok, projectDir, elfPath, elfSize, command, args, configs,
    durationMs: Date.now() - startedAt,
    ...(outcome.exitCode === null ? {} : { exitCode: outcome.exitCode }),
    programmed: verdict.programmed, verified: verdict.verified,
    probeError,
    errors, message, logTail: log.split(/\r?\n/u).slice(-25).join("\n"), notes,
  };
}


/**
 * 烧录编排器（2026-11-08 复盘后的两层修复）：
 *
 * 1. **interface 先探后选**：以前兜底硬编码 cmsis-dap（规格 §13 的旧前提），插 ST-Link 的
 *    用户直接被带偏——openocd 报 "unable to find a matching CMSIS-DAP device"，还得人肉猜。
 *    现在先 usbDiagnosis（VID:PID 分流）按实见探针选 interface；工程自带 openocd.cfg 时不插手
 *    （那是用户显式配置，只在失败后提示改哪一行）。
 * 2. **换 interface 自动重试一次**：仍报 probe-interface-mismatch 就切另一个驱动再跑。
 * 3. **CubeProgrammer 兜底**：openocd 两条都失败、实见探针是 ST-LINK、本机装了 CubeProgrammer、
 *    且失败不是「换后端也没用」类（swd-locked/no-power/flash-protected）时，走 CLI 第二后端。
 *    DAPLink 用户没有这条腿（CLI 只认 ST-LINK），报告里如实说。
 */
export async function runFlash(subprocess: SubprocessService, request: FlashRequest): Promise<FlashReport> {
  const backend: FlashBackend = request.backend ?? "auto";
  const hasProjectCfg = findProjectConfig(request.projectDir, request.configFile) !== null;
  let ifaceOverride: string | undefined;
  let probeNote = "";
  let sawStLink = false;
  let sawDapFamily = false;
  // CLI 后端也要知道探针类型（它只认 ST-LINK），所以不能只按 interfaceConfig 是否显式给来决定探不探。
  if (request.interfaceConfig === undefined || backend === "cubeprogrammer") {
    const live = await liveProbeChoice(subprocess, request.signal);
    sawStLink = live.swdProbes.some((p) => p.kind === "st-link");
    sawDapFamily = live.swdProbes.some((p) => p.kind === "cmsis-dap" || p.kind === "daplink");
    if (live.swdProbes.length > 0) {
      if (request.interfaceConfig === undefined && !hasProjectCfg) ifaceOverride = live.cfg;
      probeNote = "探针实见：" + live.swdProbes.map((p) => p.label).join("、") +
        (backend === "cubeprogrammer"
          ? ""
          : hasProjectCfg
            ? "（工程自带 openocd.cfg，interface 以它为准）"
            : "；interface 用 " + live.cfg + "（" + live.why + "）");
    }
  }

  if (backend === "cubeprogrammer") {
    // 实见的是 DAPLink/CMSIS-DAP：CLI 这条路根本不通，别让它跑一遍再报一句含糊的 "no ST-Link"。
    if (sawDapFamily && !sawStLink) {
      return {
        ok: false, projectDir: resolve(request.projectDir), elfPath: "", elfSize: 0, command: "", args: [], configs: [],
        durationMs: 0, programmed: false, verified: false, probeError: null,
        errors: ["CubeProgrammer CLI 的 SWD 路径只认 ST-LINK，实见的是 CMSIS-DAP/DAPLink 类探针"],
        message: "没烧：backend=cubeprogrammer 只认 ST-LINK；这块探针请用 backend=auto（openocd）",
        logTail: "", notes: probeNote === "" ? [] : [probeNote],
      };
    }
    return runCubeProgrammerBackend(subprocess, request, probeNote);
  }

  let report = await runOpenocdFlash(subprocess, request, ifaceOverride);
  if (probeNote !== "") report.notes.unshift(probeNote);

  // 2) 接口不匹配 → 换另一个 interface 重试一次（仅插件兜底配置的工程；手写 cfg 的让用户按 hint 改）
  if (!report.ok && !hasProjectCfg && report.probeError !== null && report.probeError.kind === "probe-interface-mismatch") {
    // 换哪条由**实见探针**决定，不是"把当前值取反"：取反在探针结论过期/缺失时会把重试引向
    // 与真实硬件无关的方向（CI 上 2 条用例就是这么挂的）。实见 ST-LINK 就先试 stlink。
    const firstIface = ifaceOverride ?? "interface/cmsis-dap.cfg";
    const guided = sawStLink ? "interface/stlink-dap.cfg" : sawDapFamily ? "interface/cmsis-dap.cfg" : "";
    const other = guided !== "" && guided !== firstIface
      ? guided
      : firstIface === "interface/cmsis-dap.cfg" ? "interface/stlink-dap.cfg" : "interface/cmsis-dap.cfg";
    const firstMessage = report.message;
    const retry = await runOpenocdFlash(subprocess, request, other);
    // notes 归属：retry 是新报告——探针实见行、换接口说明、第一次失败原因都得挂到它身上
    // （第一版把"自动换…"push 进了旧 report，随对象丢弃，测试当场抓到）。
    if (probeNote !== "") retry.notes.unshift(probeNote);
    retry.notes.push("openocd 报探针驱动不匹配，自动换 " + other + " 重试一次（第 1 次：" + firstMessage + "）");
    report = retry;
  }

  // 3) CubeProgrammer 第二后端
  const futile = report.probeError !== null && ["swd-locked", "no-power", "flash-protected", "probe-busy"].includes(report.probeError.kind);
  const fallbackAllowed = backend !== "openocd" && !futile && report.elfPath !== "" && sawStLink;
  if (!report.ok && fallbackAllowed) {
    const config = resolveSearchConfig(process.env, request.binDirs === undefined ? {} : { binDirs: request.binDirs });
    const cli = findCubeProgrammerCli(config.cubePrgBins);
    if (cli !== null) {
      report.notes.push(
        report.configs.length === 0
          ? "openocd 根本没起来（没有可用的 target 脚本），直接试 CubeProgrammer CLI（ST-LINK 后端）…"
          : "openocd 没烧成（" + String(report.configs.length) + " 个配置都试过），改试 CubeProgrammer CLI（ST-LINK 后端）…",
      );
      const alt = await runCubeProgrammerFlash(subprocess, {
        projectDir: request.projectDir,
        elfPath: report.elfPath,
        cliPath: cli,
        ...(request.adapterSpeed === undefined ? {} : { adapterSpeed: request.adapterSpeed }),
        runAfterReset: request.runAfterReset !== false,
        timeoutMs: request.timeoutMs ?? 120_000,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress }),
      });
      if (alt.ok) {
        return {
          ok: true,
          projectDir: report.projectDir,
          elfPath: report.elfPath,
          elfSize: report.elfSize,
          command: alt.command,
          args: alt.args,
          configs: [],
          durationMs: report.durationMs + alt.durationMs,
          ...(alt.exitCode === null ? {} : { exitCode: alt.exitCode }),
          programmed: alt.programmed,
          verified: alt.verified,
          probeError: null,
          errors: [],
          message: alt.message,
          logTail: alt.logTail,
          notes: [...report.notes, cubeProgrammerBackendNote(cli)],
        };
      }
      report.notes.push("CubeProgrammer 兜底也没成：" + alt.message + "（查过 " + alt.searched + "）");
    } else {
      report.notes.push(
        "实见 ST-LINK 但本机没装 STM32CubeProgrammer（CLI 没找到）：装上它，ST-Link 就多一条不依赖 openocd target 脚本的后端" +
          "（backend=cubeprogrammer 可直连；H5/WBA/WB0/WL3 只能走它）。",
      );
    }
  }
  if (!report.ok && !futile && report.probeError !== null && report.probeError.kind === "no-probe" && sawDapFamily && !sawStLink) {
    // DAPLink 用户走不了 CLI 这条腿，别让人以为还有救
    const config = resolveSearchConfig(process.env, {});
    if (findCubeProgrammerCli(config.cubePrgBins) !== null) {
      report.notes.push("本机装了 CubeProgrammer，但它的 SWD 路径只认 ST-LINK：你插的是 CMSIS-DAP/DAPLink 类探针，这条路帮不上（docs §79）。");
    }
  }
  return report;
}
