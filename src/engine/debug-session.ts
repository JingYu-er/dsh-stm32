/**
 * L2：租约式调试会话（规格 §6）。
 *
 * 三种形态里最危险的是"常驻 gdb"——会挡住用户在 VS Code 里按 F5。这里的做法：
 * - 常驻的**只有 openocd**（gdb server 占着探针，但这是唯一的占用者）；
 * - 每次 stm32_debug_eval 临时起一个 `gdb -batch` 连上去，跑完命令 → `monitor resume` → detach 退出，
 *   不在插件进程里留 gdb；
 * - 租约：空闲 90 s 自动关、总时长 10 min 硬上限；`turn/end`（agent 输出完、等你回复）立刻关；
 * - `build` / `flash` / `generate` 动手前先让会话让出探针（`releaseProbe`）。
 *
 * 探针只有一块：任何时刻只允许一个会话，重复 start 会先把旧的关掉。
 */

import { existsSync } from "node:fs";

import { resolveSearchConfig } from "../data/search-roots.js";
import type { SearchConfig } from "../data/search-roots.js";
import type { ProcessHandle, SubprocessService } from "../types.js";
import { pickPort, resolveElfPath } from "./debug.js";
import { defaultConfigs, findProjectConfig, toOpenOcdPath } from "./flash.js";
import { resolveFromDirs } from "./probe.js";
import { runCapture } from "./subprocess-runner.js";
import { waitForListening } from "./debug.js";

export interface SessionStartRequest {
  projectDir: string;
  /** 调试符号来源；缺省用 build/<preset>/*.elf（与 debug_run 一致）。 */
  elfPath?: string;
  port?: number;
  adapterSpeed?: number;
  configFile?: string;
  /** 空闲多久自动关（默认 90 s）。 */
  idleTtlMs?: number;
  /** 总时长硬上限（默认 10 min）。 */
  hardTtlMs?: number;
  /** 起会话时对目标做什么：none=不动、halt=复位并停住、run=复位并运行。 */
  reset?: "none" | "halt" | "run";
  binDirs?: string[];
  onProgress?: (line: string) => void;
}

export interface SessionReport {
  ok: boolean;
  active: boolean;
  sessionId: string;
  port: number;
  projectDir: string;
  elfPath: string;
  startedAt: number;
  idleTtlMs: number;
  hardTtlMs: number;
  remainingMs: number;
  errors: string[];
  message: string;
}

export interface EvalRequest {
  commands?: string[];
  /** gdb 表达式，等价于 commands: ["print <expression>"]。 */
  expression?: string;
  /** 结束时不要把目标 resume（默认会 resume，保持"看一眼就走"）。 */
  keepHalted?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface EvalReport {
  ok: boolean;
  output: string;
  command: string;
  durationMs: number;
  remainingMs: number;
  errors: string[];
  message: string;
}

export interface SessionWordSample {
  address: string;
  value: string;
  ok: boolean;
}

export interface SessionWordsRequest {
  addresses: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SessionWordsReport {
  ok: boolean;
  sessionId: string;
  port: number;
  projectDir: string;
  command: string;
  pc: string;
  samples: SessionWordSample[];
  durationMs: number;
  output: string;
  errors: string[];
  message: string;
}

interface InternalSession {
  id: string;
  projectDir: string;
  elfPath: string;
  port: number;
  handle: ProcessHandle;
  startedAt: number;
  lastUsedAt: number;
  idleTtlMs: number;
  hardTtlMs: number;
  logText: string;
  /** 起会话时解析出的工具链目录：eval 必须用同一份，否则换机器/换目录时会"找得到 openocd、找不到 gdb"。 */
  binDirs: string[];
}

const DEFAULT_IDLE_TTL_MS = 90_000;
const DEFAULT_HARD_TTL_MS = 10 * 60_000;
const SWEEP_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** 把 "0x4001100c" / "4001100C" 统一成 8 位小写 0x 形式；解析不了返回 null。 */
export function normalizeHexAddress(text: string): string | null {
  const body = text.trim().replace(/^0x/iu, "");
  if (!/^[0-9a-f]{1,8}$/iu.test(body)) return null;
  return "0x" + body.toLowerCase().padStart(8, "0");
}

/**
 * 从 gdb 输出里按出现顺序取 print/x 打印的十六进制值（形如 $1 = 0x4001100c）。
 *
 * gdb 只在成功打印时输出 `$N = 0x...`，被拒绝的表达式留一行 Cannot access memory，
 * 所以"少了一个"正好表示那个地址没读到。
 */
export function parseGdbPrintedHex(output: string): string[] {
  const values: string[] = [];
  for (const match of output.matchAll(/\$\d+\s*=\s*(0x[0-9a-fA-F]+)/gu)) {
    const value = match[1];
    if (value !== undefined) values.push(value.toLowerCase());
  }
  return values;
}

function emptyReport(errors: string[], message: string): SessionReport {
  return {
    ok: false, active: false, sessionId: "", port: 0, projectDir: "", elfPath: "",
    startedAt: 0, idleTtlMs: DEFAULT_IDLE_TTL_MS, hardTtlMs: DEFAULT_HARD_TTL_MS, remainingMs: 0, errors, message,
  };
}

export class DebugSessionManager {
  private subprocess: SubprocessService | null = null;
  private binDirs: string[] = [];
  private current: InternalSession | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? ((): number => Date.now());
  }

  configure(subprocess: SubprocessService, binDirs: string[] = []): void {
    this.subprocess = subprocess;
    this.binDirs = binDirs;
  }

  isActive(): boolean {
    return this.current !== null;
  }

  status(): SessionReport {
    const session = this.current;
    if (session === null) return emptyReport([], "没有调试会话（探针空闲）");
    return {
      ok: true, active: true, sessionId: session.id, port: session.port, projectDir: session.projectDir,
      elfPath: session.elfPath, startedAt: session.startedAt, idleTtlMs: session.idleTtlMs,
      hardTtlMs: session.hardTtlMs, remainingMs: this.remainingMs(session), errors: [],
      message: "调试会话进行中（端口 " + String(session.port) + "，剩余 " + String(Math.ceil(this.remainingMs(session) / 1000)) + " s）",
    };
  }

  private remainingMs(session: InternalSession): number {
    const idleDeadline = session.lastUsedAt + session.idleTtlMs;
    const hardDeadline = session.startedAt + session.hardTtlMs;
    return Math.max(0, Math.min(idleDeadline, hardDeadline) - this.now());
  }

  /** 扫一次租约：过期的会话立刻关。定时器与单测共用这一条路径。 */
  async sweepExpired(): Promise<boolean> {
    const session = this.current;
    if (session === null) return false;
    if (this.remainingMs(session) > 0) return false;
    await this.stop("租约到期（空闲 " + String(Math.round(session.idleTtlMs / 1000)) + " s 或总时长上限）");
    return true;
  }

  private ensureSweeper(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.sweepExpired();
    }, SWEEP_MS);
    // 不要因为一个定时器把宿主进程吊住（Node 的 Timeout 有 unref）。
    (this.timer as { unref?: () => void }).unref?.();
  }

  private stopSweeper(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async start(request: SessionStartRequest): Promise<SessionReport> {
    const subprocess = this.subprocess;
    if (subprocess === null) return emptyReport(["插件还没拿到 subprocess 服务"], "没开会话：插件未就绪");
    if (this.current !== null) {
      await this.stop("新的会话申请覆盖了旧会话");
    }

    const projectDir = request.projectDir;
    const config: SearchConfig = resolveSearchConfig(process.env, request.binDirs === undefined ? {} : { binDirs: request.binDirs });
    const openOcd = resolveFromDirs("openocd", config.binDirs);
    if (openOcd === null) return emptyReport(["找不到 openocd（先跑 stm32_env_probe）"], "没开会话：找不到 openocd");

    // 符号表在这里解析：调用方（工具层、e2e、以后可能的 CLI）都不用自己找 .elf。
    const elfPath = request.elfPath !== undefined && request.elfPath !== ""
      ? request.elfPath
      : (resolveElfPath(projectDir, {}) ?? "");
    const port = request.port ?? (await pickPort(3333));
    const argv: string[] = [openOcd];
    const projectConfig = findProjectConfig(projectDir, request.configFile);
    if (projectConfig !== null) {
      argv.push("-f", toOpenOcdPath(projectConfig));
    } else {
      const fallback = defaultConfigs();
      argv.push("-f", fallback.interfaceConfig, "-f", fallback.targetConfig);
    }
    if (request.adapterSpeed !== undefined) argv.push("-c", "adapter speed " + String(request.adapterSpeed));
    argv.push("-c", "gdb_port " + String(port));

    const handle = subprocess.spawn({
      argv,
      cwd: projectDir,
      stdio: { stdin: "ignore", stdout: { maxBytes: 512 * 1024 }, stderr: { maxBytes: 512 * 1024 } },
      graceMs: 2000,
    });
    const session: InternalSession = {
      id: "dbg-" + String(Date.now()) + "-" + Math.random().toString(16).slice(2, 8),
      projectDir,
      elfPath,
      port,
      handle,
      startedAt: this.now(),
      lastUsedAt: this.now(),
      idleTtlMs: request.idleTtlMs ?? DEFAULT_IDLE_TTL_MS,
      hardTtlMs: request.hardTtlMs ?? DEFAULT_HARD_TTL_MS,
      logText: "",
      binDirs: config.binDirs,
    };

    const listening = await waitForListening(handle, 15_000, (text) => {
      session.logText += text + "\n";
      request.onProgress?.(text);
    });
    if (!listening.ok) {
      handle.terminate();
      await handle.waitForExit().catch(() => undefined);
      const tail = listening.text.split(/\r?\n/u).slice(-12).join("\n");
      return emptyReport(
        [/Error connecting DP|no device found|CMSIS-DAP/iu.test(listening.text) ? "openocd 连不上探针/芯片（见日志）" : "openocd 没有在 15 s 内监听 " + String(port), tail],
        "没开会话：openocd 起不来",
      );
    }

    this.current = session;
    this.ensureSweeper();

    if (request.reset !== undefined && request.reset !== "none") {
      const resetResult = await this.eval({ commands: ["monitor reset " + request.reset], keepHalted: true, timeoutMs: 20_000 });
      if (!resetResult.ok) {
        await this.stop("起会话时复位失败");
        return emptyReport(["复位失败：" + resetResult.output.split(/\r?\n/u).slice(-5).join(" ")], "没开会话：复位失败");
      }
    }

    return this.status();
  }

  async eval(request: EvalRequest): Promise<EvalReport> {
    const session = this.current;
    const startedAt = this.now();
    if (session === null) {
      return {
        ok: false, output: "", command: "", durationMs: 0, remainingMs: 0,
        errors: ["没有调试会话（先 stm32_debug_session；短任务用 stm32_debug_run 更省事）"],
        message: "没执行：没有会话",
      };
    }
    const subprocess = this.subprocess;
    if (subprocess === null) {
      return { ok: false, output: "", command: "", durationMs: 0, remainingMs: this.remainingMs(session), errors: ["插件还没拿到 subprocess 服务"], message: "没执行：插件未就绪" };
    }
    // 用"起会话时那份"工具链目录：只读环境变量的话，调用方传了 binDirs 也会出现
    // "openocd 起来了、eval 却说缺 gdb"的错位（也便于离线单测给假目录）。
    const envConfig: SearchConfig = resolveSearchConfig(process.env, {});
    const searchDirs: string[][] = [session.binDirs, this.binDirs, envConfig.binDirs];
    let gdb: string | null = null;
    for (const dirs of searchDirs) {
      if (dirs.length === 0) continue;
      gdb = resolveFromDirs("gdb-multiarch", dirs) ?? resolveFromDirs("arm-none-eabi-gdb", dirs);
      if (gdb !== null) break;
    }
    if (gdb === null) {
      return { ok: false, output: "", command: "", durationMs: 0, remainingMs: this.remainingMs(session), errors: ["找不到 gdb"], message: "没执行：缺 gdb" };
    }

    const commands: string[] = [];
    if (request.expression !== undefined && request.expression.trim() !== "") commands.push("print " + request.expression.trim());
    for (const command of request.commands ?? []) if (command.trim() !== "") commands.push(command.trim());
    if (commands.length === 0) {
      return { ok: false, output: "", command: "", durationMs: 0, remainingMs: this.remainingMs(session), errors: ["没有命令"], message: "没执行：commands/expression 都是空的" };
    }

    const argv: string[] = [gdb, "-q", "-batch", "-nx", "-ex", "set confirm off", "-ex", "set pagination off"];
    if (session.elfPath !== "" && existsSync(session.elfPath)) argv.push("-ex", "file " + toOpenOcdPath(session.elfPath));
    argv.push("-ex", "target extended-remote 127.0.0.1:" + String(session.port), "-ex", "monitor halt");
    for (const command of commands) argv.push("-ex", command);
    if (request.keepHalted !== true) argv.push("-ex", "monitor resume");
    argv.push("-ex", "detach");

    const outcome = await runCapture(subprocess, {
      argv,
      cwd: session.projectDir,
      timeoutMs: request.timeoutMs ?? 30_000,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      awaitQuiescence: true,
    });
    session.lastUsedAt = this.now();
    const output = (outcome.stdout + "\n" + outcome.stderr).trim();
    const errors: string[] = [];
    if (outcome.spawnError !== null) errors.push("gdb 启动失败：" + outcome.spawnError);
    if (outcome.timedOut) errors.push("gdb 超时（" + String(request.timeoutMs ?? 30_000) + " ms）");
    if (outcome.exitCode !== 0) errors.push("gdb 退出码 " + String(outcome.exitCode));
    // 会话在 eval 期间可能被 turn/end 关掉。
    const stillActive = this.current === session;
    if (!stillActive) errors.push("会话在本次 eval 期间已关闭");
    return {
      ok: errors.length === 0,
      output,
      command: argv.map((item) => (item.includes(" ") ? '"' + item + '"' : item)).join(" "),
      durationMs: this.now() - startedAt,
      remainingMs: stillActive ? this.remainingMs(session) : 0,
      errors,
      message: errors.length === 0 ? "执行完成（" + String(this.now() - startedAt) + " ms）" : "执行有问题：" + (errors[0] as string),
    };
  }

  /**
   * 借正在跑的调试会话（它已经占着 openocd + CMSIS-DAP）读 32 位字。
   *
   * 为什么要借：再起一个 openocd 会抢同一块探针，实测报
   * "CMSIS-DAP transfer count mismatch: expected 3, got 2"。所以有会话时一律走 gdb 表达式
   * （print/x $pc + 每地址 print/x *(unsigned int *)0x...），halt 之后 resume，芯片照原样继续跑。
   */
  async readWords(request: SessionWordsRequest): Promise<SessionWordsReport> {
    const startedAt = this.now();
    const session = this.current;
    if (session === null) {
      return {
        ok: false, sessionId: "", port: 0, projectDir: "", command: "", pc: "", samples: [],
        durationMs: 0, output: "",
        errors: ["没有调试会话（先 stm32_debug_session，或短任务用 stm32_debug_run）"],
        message: "没读：没有调试会话",
      };
    }
    const addresses: string[] = [];
    const bad: string[] = [];
    for (const raw of request.addresses) {
      const normalized = normalizeHexAddress(raw);
      if (normalized === null) bad.push(raw);
      else addresses.push(normalized);
    }
    if (addresses.length === 0) {
      return {
        ok: false, sessionId: session.id, port: session.port, projectDir: session.projectDir,
        command: "", pc: "", samples: [], durationMs: this.now() - startedAt, output: "",
        errors: ["没有可读的地址" + (bad.length === 0 ? "" : "（解析不了：" + bad.join("、") + "）")],
        message: "没读：地址不合法",
      };
    }
    const commands = ["print/x $pc"];
    for (const address of addresses) commands.push("print/x *(unsigned int *)" + address);
    const evaluated = await this.eval({
      commands,
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const printed = parseGdbPrintedHex(evaluated.output);
    const pc = printed[0] ?? "";
    const samples: SessionWordSample[] = addresses.map((address, index) => {
      const value = printed[index + 1];
      return value === undefined ? { address, value: "", ok: false } : { address, value, ok: true };
    });
    const missing = samples.filter((sample) => !sample.ok).length;
    const errors = [...evaluated.errors];
    for (const raw of bad) errors.push("地址解析不了：" + raw);
    if (missing > 0) errors.push("有 " + String(missing) + " 个地址没读到值（地址没映射或没对齐）");
    if (pc === "") errors.push("没读到 pc");
    const ok = evaluated.ok && missing === 0 && pc !== "";
    return {
      ok,
      sessionId: session.id,
      port: session.port,
      projectDir: session.projectDir,
      command: evaluated.command,
      pc,
      samples,
      durationMs: this.now() - startedAt,
      output: evaluated.output,
      errors,
      message: ok
        ? "从调试会话（端口 " + String(session.port) + "）读了 " + String(samples.length) + " 个值"
        : "读失败：" + (errors[0] ?? "未知原因"),
    };
  }

  async stop(reason: string): Promise<{ ok: boolean; stopped: boolean; message: string }> {
    const session = this.current;
    this.current = null;
    this.stopSweeper();
    if (session === null) return { ok: true, stopped: false, message: "本来就没有会话（" + reason + "）" };
    session.handle.terminate();
    await Promise.race([session.handle.waitForExit().catch(() => undefined), sleep(3000)]);
    return { ok: true, stopped: true, message: "会话已关闭（" + reason + "），探针已释放" };
  }

  async closeAll(reason: string): Promise<void> {
    await this.stop(reason);
  }
}

/** 进程内单例：工具、turn/end 监听、dispose 共用同一个会话。 */
export const debugSessions = new DebugSessionManager();

/** 需要独占探针的动作（build / flash / generate / debug_run）动手前调用。 */
export async function releaseProbeFor(reason: string): Promise<string | null> {
  if (!debugSessions.isActive()) return null;
  const stopped = await debugSessions.stop("被 " + reason + " 占用探针，先关闭会话");
  return stopped.stopped ? "已先关闭调试会话（" + reason + " 要用探针）" : null;
}
