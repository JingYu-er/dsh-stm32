/**
 * L2：debug_run —— 一次调用完成"调试"：起 openocd → gdb 连上 → 断点停在指定位置 →
 * 抓一份现场（寄存器 / 调用栈 / 局部变量）→ 让目标继续跑 → 关 openocd。
 *
 * 为什么不常驻会话：用户要能在 agent 交还控制权时用 VS Code 自己调试，
 * 所以默认形态是"进来拿一次快照就走"，探针必释放（规格 §6）。
 */

import { existsSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";

import { resolveSearchConfig } from "../data/search-roots.js";
import type { SearchConfig } from "../data/search-roots.js";
import type { ProcessHandle, SubprocessService } from "../types.js";
import { detectBuildDir, elfSelectionNote, findElf } from "./build.js";
import { usbDiagnosis } from "./doctor.js";
import { defaultConfigs, findProjectConfig, quoteForDisplay, toOpenOcdPath } from "./flash.js";
import { collectBreakpointRequests, planBreakpoints, quotaOf, resolveBreakpointBudget } from "./breakpoints.js";
import type { BreakpointQuota } from "./breakpoints.js";
import { classifyProbeFailure, firstProblemLine, probeMissingLines, usbNoteFor } from "./probe-error.js";
import type { ProbeError } from "./probe-error.js";
import { resolveToolIn } from "./probe.js";
import { runStreaming } from "./subprocess-runner.js";

export interface DebugRunRequest {
  projectDir: string;
  elfPath?: string;
  buildDir?: string;
  /** 停在哪：默认 "main"；"none" 表示不复位到断点，只连上并读现状。 */
  breakAt?: string;
  /** gdb 附加命令（在 break 之后、continue 之前执行）。 */
  preCommands?: string[];
  /** B4：额外断点（"main" / "watch:g_count" / "break:*0x08000000"），与 breakAt、preCommands 一起算预算。 */
  breakpoints?: string[];
  /** gdb 收尾命令（默认 monitor reset run + detach）。 */
  postCommands?: string[];
  port?: number;
  openOcdPath?: string;
  configFile?: string;
  interfaceConfig?: string;
  targetConfig?: string;
  adapterSpeed?: number;
  /** gdb 总超时（默认 45000 ms，其中 continue 到断点通常 < 1 s）。 */
  timeoutMs?: number;
  signal?: AbortSignal;
  binDirs?: string[];
  onProgress?: (line: string) => void;
}

export interface RegisterValue {
  name: string;
  value: string;
}

export interface DebugRunReport {
  ok: boolean;
  /** 结构化探针错误（B2）：与 stm32_flash 共用一份分类，成功时是 null。 */
  probeError: ProbeError | null;
  projectDir: string;
  elfPath: string;
  port: number;
  breakAt: string;
  hitBreakpoint: boolean;
  location: string;
  /** B4：硬件断点预算（limit 来自芯片事实或 F1 默认 6）。 */
  breakpoints: BreakpointQuota;
  /** B4：数据观察点预算（F1 默认 4）。 */
  watchpoints: BreakpointQuota;
  registers: RegisterValue[];
  backtrace: string[];
  locals: string[];
  gdbCommand: string;
  gdbOutput: string;
  openOcdLogTail: string;
  durationMs: number;
  errors: string[];
  message: string;
  notes: string[];
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** 端口是否被占用（openocd 默认 3333 常被用户自己的调试会话占着）。 */
export function isPortBusy(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const finish = (busy: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      done(busy);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export async function pickPort(preferred = 3333): Promise<number> {
  for (let offset = 0; offset < 10; offset += 1) {
    const port = preferred + offset;
    if (!(await isPortBusy(port))) return port;
  }
  return preferred;
}

interface GdbProbe {
  hitBreakpoint: boolean;
  location: string;
  registers: RegisterValue[];
  backtrace: string[];
  locals: string[];
  errors: string[];
}

/** 从 gdb -batch 输出里抠出断点位置、寄存器、调用栈。 */
export function parseGdbOutput(text: string): GdbProbe {
  const errors: string[] = [];
  let hitBreakpoint = false;
  let location = "";
  const registers: RegisterValue[] = [];
  const backtrace: string[] = [];
  const locals: string[] = [];

  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "") continue;
    if (/^Breakpoint \d+,/u.test(line)) {
      hitBreakpoint = true;
      location = line.replace(/^Breakpoint \d+,\s*/u, "");
      continue;
    }
    if (/^0x[0-9a-fA-F]+ in /u.test(line) && location === "") {
      location = line;
      continue;
    }
    const registerMatch = /^(pc|sp|lr|xpsr)\s+(0x[0-9a-fA-F]+)/u.exec(line);
    if (registerMatch !== null && registerMatch[1] !== undefined && registerMatch[2] !== undefined) {
      registers.push({ name: registerMatch[1], value: registerMatch[2] });
      continue;
    }
    if (/^#\d+\s/u.test(line)) {
      backtrace.push(line);
      continue;
    }
    const localMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/u.exec(line);
    if (localMatch !== null && !/^(Info|Warn|Error)\b/u.test(line)) {
      locals.push(line);
      continue;
    }
    if (/^(Remote communication error|Cannot access memory|No symbol|error:|\.gdbinit)/iu.test(line)) errors.push(line);
  }
  return { hitBreakpoint, location, registers, backtrace, locals, errors };
}

/** 等 openocd 打出 "Listening on port"（或超时）。 */
export async function waitForListening(handle: ProcessHandle, timeoutMs: number, onText?: (text: string) => void): Promise<{ ok: boolean; text: string }> {
  const startedAt = Date.now();
  let outOffset = 0;
  let errOffset = 0;
  let text = "";
  const drain = (): boolean => {
    let sawListening = /Listening on port \d+/u.test(text);
    for (const [reader, key] of [[handle.collected.stdout, "out"], [handle.collected.stderr, "err"]] as const) {
      if (reader === undefined) continue;
      const chunk = reader.readFrom(key === "out" ? outOffset : errOffset);
      if (key === "out") outOffset = chunk.nextOffset;
      else errOffset = chunk.nextOffset;
      if (chunk.text === "") continue;
      text += chunk.text;
      onText?.(chunk.text.trim());
      if (/Listening on port \d+/u.test(chunk.text)) sawListening = true;
    }
    return sawListening;
  };
  while (Date.now() - startedAt < timeoutMs) {
    // openocd 的日志其实走 stderr，两路都要读，否则永远等不到 "Listening on port"。
    if (drain()) return { ok: true, text };
    const exit = await Promise.race([handle.done.then(() => true), sleep(200).then(() => false)]);
    if (exit === true) {
      drain();
      return { ok: false, text };
    }
  }
  drain();
  return { ok: false, text };
}

/** 失败时 log tail 的优先级：Error/adapter 那几行比"最后 15 行"有用得多。 */
function keyLogTail(lines: readonly string[], maxLines: number): string {
  const important = /error|unable to find|no device found|adapter|cmsis-dap|listening|couldn't bind|jtag|cannot/i;
  const kept = new Set<number>();
  for (let index = lines.length - 1; index >= 0 && kept.size < maxLines; index -= 1) {
    const line = lines[index];
    if (line === undefined) continue;
    if (important.test(line)) kept.add(index);
  }
  for (let index = lines.length - 1; index >= 0 && kept.size < maxLines; index -= 1) kept.add(index);
  return [...kept].sort((left, right) => left - right).map((index) => lines[index] as string).join("\n");
}

export async function runDebugRun(subprocess: SubprocessService, request: DebugRunRequest): Promise<DebugRunReport> {
  const projectDir = resolve(request.projectDir);
  const config: SearchConfig = resolveSearchConfig(process.env, request.binDirs === undefined ? {} : { binDirs: request.binDirs });
  const startedAt = Date.now();
  const notes: string[] = [];
  const errors: string[] = [];
  // B4：断点预算先算清楚（纯计算 + 读 .ioc/chips.json，不碰探针），下面所有报告共用同一份配额。
  const budgetInfo = resolveBreakpointBudget(projectDir);
  const collected = collectBreakpointRequests({
    ...(request.breakAt === undefined ? {} : { breakAt: request.breakAt }),
    ...(request.breakpoints === undefined ? {} : { breakpoints: request.breakpoints }),
    ...(request.preCommands === undefined ? {} : { preCommands: request.preCommands }),
  });
  const plan = planBreakpoints(collected.requested, budgetInfo.budget);
  const empty: DebugRunReport = {
    ok: false, projectDir, elfPath: "", port: 0, breakAt: request.breakAt ?? "main",
    hitBreakpoint: false, location: "", registers: [], backtrace: [], locals: [],
    gdbCommand: "", gdbOutput: "", openOcdLogTail: "", durationMs: 0,
    breakpoints: quotaOf(plan.used.code, plan.budget.code),
    watchpoints: quotaOf(plan.used.data, plan.budget.data),
    // 还没走到探针那一步（找不到 .elf / 缺工具链）就不算探针故障。
    probeError: null,
    errors, message: "", notes,
  };

  const elfPath = resolveElfPath(projectDir, request);
  if (elfPath === null) {
    errors.push("找不到 .elf（先跑 stm32_build）");
    return { ...empty, message: "没调试：找不到 .elf", durationMs: Date.now() - startedAt };
  }
  // B4：超预算就到此为止——不 spawn openocd（探针不动），也不让 gdb 报一串
  // "Cannot insert breakpoint" 再把整次调试带崩。文案直接给"超了几个"和"删哪个/换什么"。
  if (!plan.ok) {
    errors.push("断点超预算：" + plan.detail);
    notes.push(...collected.notes);
    notes.push(budgetInfo.note);
    notes.push(plan.suggestion);
    return {
      ...empty,
      elfPath,
      message: "没调试：断点超预算（硬件断点 " + String(plan.used.code) + "/" + String(plan.budget.code)
        + "，观察点 " + String(plan.used.data) + "/" + String(plan.budget.data) + "）",
      durationMs: Date.now() - startedAt,
    };
  }
  const selectionNote = elfSelectionNote(dirname(elfPath));
  if (selectionNote !== "") notes.push(selectionNote);
  const openOcd = request.openOcdPath !== undefined && request.openOcdPath !== ""
    ? request.openOcdPath
    : await resolveToolIn(subprocess, ["openocd"], config.binDirs);
  const gdb = await resolveToolIn(subprocess, ["gdb-multiarch", "arm-none-eabi-gdb"], config.binDirs);
  if (openOcd === null || gdb === null) {
    errors.push(openOcd === null ? "找不到 openocd" : "找不到 gdb（gdb-multiarch 或 arm-none-eabi-gdb）");
    return { ...empty, elfPath, message: "没调试：缺工具链（先跑 stm32_env_probe）", durationMs: Date.now() - startedAt };
  }

  const port = request.port ?? (await pickPort(3333));
  if (request.port === undefined && port !== 3333) notes.push("3333 被占用，本次改用 " + String(port));

  const openOcdArgs: string[] = [openOcd];
  const projectConfig = findProjectConfig(projectDir, request.configFile);
  if (projectConfig !== null) {
    openOcdArgs.push("-f", toOpenOcdPath(projectConfig));
  } else {
    const fallback = defaultConfigs();
    openOcdArgs.push("-f", request.interfaceConfig ?? fallback.interfaceConfig, "-f", request.targetConfig ?? fallback.targetConfig);
    notes.push("工程里没有 openocd 配置文件，回退到 CMSIS-DAP + stm32f1x");
  }
  if (request.adapterSpeed !== undefined) openOcdArgs.push("-c", "adapter speed " + String(request.adapterSpeed));
  openOcdArgs.push("-c", "gdb_port " + String(port));

  const openOcdHandle = subprocess.spawn({
    argv: openOcdArgs,
    cwd: projectDir,
    stdio: { stdin: "ignore", stdout: { maxBytes: 512 * 1024 }, stderr: { maxBytes: 512 * 1024 } },
    graceMs: 2000,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });

  let openOcdText = "";
  try {
    const listening = await waitForListening(openOcdHandle, 15_000, (text) => {
      openOcdText += text + "\n";
      request.onProgress?.(text);
    });
    if (!listening.ok) {
      // F2：旧版只回"openocd 起不来"+15 行尾巴，真正的 adapter init 失败常被挤掉。
      // 现在先归类（与 flash 同一套规则），再把有信息量的行留下，并顺手做一次 USB 形态诊断。
      const lines = listening.text.split(/\r?\n/u).filter((line) => line.trim() !== "");
      // 此时 openocd 还没结算，退出码未知（给 null）；归类规则与 flash 完全同一份。
      const probeError = classifyProbeFailure({ lines, exitCode: null, stage: "debug" });
      if (probeError.kind !== "unknown") notes.push(probeError.hint);
      if (probeError.kind === "no-probe" && probeMissingLines(lines).length > 0) {
        const usb = await usbDiagnosis(subprocess, request.signal);
        const extra = usbNoteFor(usb.kind, usb.detail);
        if (extra !== null) notes.push(extra);
      }
      const problem = firstProblemLine(lines);
      errors.push("openocd 起不来：" + (problem === "" ? "15 s 内没开始监听 " + String(port) : problem));
      return {
        ...empty, elfPath, port, openOcdLogTail: keyLogTail(lines, 40), probeError,
        message: "没调试：openocd 起不来",
        durationMs: Date.now() - startedAt,
      };
    }

    const breakAt = request.breakAt ?? "main";
    // B4：显式的额外断点（breakAt 已经单独处理；这里只补 breakpoints 参数里的）。
    const explicit = collectBreakpointRequests({
      ...(request.breakpoints === undefined ? {} : { breakpoints: request.breakpoints }),
    }).requested;
    // breakAt=none 但有额外断点时也要 continue，否则那些断点永远不会命中。
    const shouldContinue = (breakAt !== "none" && breakAt !== "") || explicit.length > 0;
    const gdbArgs: string[] = [gdb, "-q", "-batch", "-nx"];
    const ex = (command: string): void => {
      gdbArgs.push("-ex", command);
    };
    ex("set confirm off");
    ex("set pagination off");
    ex("set print pretty off");
    ex("file " + toOpenOcdPath(elfPath));
    ex("target extended-remote 127.0.0.1:" + String(port));
    ex("monitor reset halt");
    if (breakAt !== "none" && breakAt !== "") ex("break " + breakAt);
    for (const bp of explicit) ex((bp.kind === "data" ? "watch " : "break ") + bp.location);
    for (const command of request.preCommands ?? []) ex(command);
    if (shouldContinue) ex("continue");
    ex("info registers pc sp lr xpsr");
    ex("bt");
    ex("info locals");
    for (const command of request.postCommands ?? ["monitor reset run", "detach"]) ex(command);

    const gdbCommand = gdbArgs.map(quoteForDisplay).join(" ");
    request.onProgress?.("gdb：" + breakAt + (shouldContinue ? " 断点" : ""));
    const gdbOutcome = await runStreaming(subprocess, {
      argv: gdbArgs,
      cwd: projectDir,
      timeoutMs: request.timeoutMs ?? 45_000,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      onOutput: (stream, text) => {
        for (const line of text.split(/\r?\n/u)) if (line.trim() !== "") request.onProgress?.(line.trim());
      },
    });
    const gdbText = gdbOutcome.stdout + "\n" + gdbOutcome.stderr;
    const probe = parseGdbOutput(gdbText);
    errors.push(...probe.errors);
    if (gdbOutcome.spawnError !== null) errors.push("gdb 启动失败：" + gdbOutcome.spawnError);
    if (gdbOutcome.timedOut) errors.push("gdb 超时（" + String(request.timeoutMs ?? 45_000) + " ms）：断点没命中或目标没在跑");
    if (gdbOutcome.exitCode !== 0) errors.push("gdb 退出码 " + String(gdbOutcome.exitCode));
    const allLines = [...openOcdText.split(/\r?\n/u), ...gdbText.split(/\r?\n/u)].filter((line) => line.trim() !== "");

    // A26：ok 必须和 errors 一致 —— 退出码非 0、gdb 报的错（Cannot access memory 之类）都不算成功。
    const ok =
      gdbOutcome.spawnError === null
      && !gdbOutcome.timedOut
      && gdbOutcome.exitCode === 0
      && probe.errors.length === 0
      && (!shouldContinue || probe.hitBreakpoint);
    if (ok) notes.push("已在 " + (probe.location === "" ? breakAt : probe.location) + " 停住并抓过快照；收尾是 monitor reset run + detach，芯片现在自由运行，探针已释放");
    if (!ok && probe.hitBreakpoint) notes.push("命中了断点，但收尾阶段有问题");
    if (shouldContinue && !probe.hitBreakpoint && errors.length === 0) {
      const where = breakAt !== "none" && breakAt !== "" ? breakAt : "这 " + String(explicit.length) + " 个断点";
      errors.push("没有停在 " + where + "：可能是复位后没跑到这里，或符号对不上（.elf 与板上的固件不一致）");
    }
    // B4：只要这次真设了断点，就把预算和来源写进 notes（6/4 是芯片事实，不是插件随手定的）。
    if (collected.requested.length > 0) {
      notes.push(...collected.notes);
      notes.push("断点预算：" + String(plan.used.code) + "/" + String(plan.budget.code) + " 个硬件断点、"
        + String(plan.used.data) + "/" + String(plan.budget.data) + " 个观察点（" + budgetInfo.note + "）");
    }
    // B2：失败时只归一次类（成功时 probeError 是 null，报告里不带噪音）。
    let probeError: ProbeError | null = null;
    if (!ok) {
      probeError = classifyProbeFailure({
        lines: allLines,
        exitCode: gdbOutcome.exitCode,
        stage: "debug",
        timedOut: gdbOutcome.timedOut,
        spawnError: gdbOutcome.spawnError,
      });
      if (probeError.kind !== "unknown") notes.push(probeError.hint);
      if (probeError.kind === "no-probe" && probeMissingLines(allLines).length > 0) {
        const usb = await usbDiagnosis(subprocess, request.signal);
        const extra = usbNoteFor(usb.kind, usb.detail);
        if (extra !== null) notes.push(extra);
      }
    }

    return {
      ok,
      projectDir,
      elfPath,
      port,
      breakAt,
      hitBreakpoint: probe.hitBreakpoint,
      location: probe.location,
      registers: probe.registers,
      backtrace: probe.backtrace,
      locals: probe.locals,
      gdbCommand,
      gdbOutput: gdbText,
      openOcdLogTail: keyLogTail(allLines, 40),
      breakpoints: quotaOf(plan.used.code, plan.budget.code),
      watchpoints: quotaOf(plan.used.data, plan.budget.data),
      probeError,
      durationMs: Date.now() - startedAt,
      errors,
      message: ok
        ? "调试快照完成（" + ((Date.now() - startedAt) / 1000).toFixed(1) + " s）" + (probe.location === "" ? "" : "：" + probe.location)
        : "调试失败：" + (errors[0] ?? "未知原因"),
      notes,
    };
  } finally {
    // 无论成败都要把 openocd 收掉：探针必须释放，否则用户 F5 连不上。
    openOcdHandle.terminate();
    await openOcdHandle.waitForExit().catch(() => undefined);
  }
}

export function resolveElfPath(projectDir: string, request: { elfPath?: string; buildDir?: string }): string | null {
  if (request.elfPath !== undefined && request.elfPath !== "") {
    const abs = isAbsolute(request.elfPath) ? request.elfPath : resolve(projectDir, request.elfPath);
    return existsSync(abs) ? abs : null;
  }
  const buildDir = request.buildDir !== undefined && request.buildDir !== ""
    ? (isAbsolute(request.buildDir) ? request.buildDir : resolve(projectDir, request.buildDir))
    : detectBuildDir(projectDir);
  if (buildDir === null) return null;
  const elf = findElf(buildDir);
  if (elf === null) return null;
  statSync(elf.path);
  return elf.path;
}
