/**
 * L0：子进程执行封装。
 *
 * 只做三件事：把一次执行变成 { exitCode, signal, stdout, stderr, timedOut }、
 * 用宿主 subprocess 服务的 Job 范围保证终止时连带子进程树、把超时表达为 abort。
 * 不做命令解析、不做 shell 解释——argv 永远是数组。
 */

import type { ProcessHandle, SubprocessService } from "../types.js";

export interface RunRequest {
  argv: string[];
  cwd?: string;
  /** 超时（含启动耗时）。到点 abort，由宿主 subprocess 服务终止进程范围。 */
  timeoutMs?: number;
  /** 每条流保留的最大字节数。 */
  maxBytes?: number;
  /** 调用方取消信号（工具级 signal）。 */
  signal?: AbortSignal;
  /** 结算后是否等待进程范围完全停稳（长命进程如 openocd 需要）。 */
  awaitQuiescence?: boolean;
  /**
   * 子进程的环境变量（给就整体替换，不给就是宿主的 env）。
   *
   * 审计 B4：binDirs 以前只用来**找可执行文件**，找到之后 spawn 的还是宿主 env ——
   * 用户刚用安装器装好、PATH 写进了注册表但宿主进程没重启时，cmake 内部调
   * `arm-none-eabi-gcc` 会 not found。要用 envWithBinDirs() 构造这份 env（见 tool-env.ts）。
   */
  env?: Record<string, string | undefined>;
}

export interface RunOutcome {
  exitCode: number | null;
  /** 非 null 表示被信号杀死。 */
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** spawn 阶段就失败（可执行文件不可用等）时的原因。 */
  spawnError: string | null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function runCapture(
  subprocess: SubprocessService,
  request: RunRequest,
): Promise<RunOutcome> {
  const maxBytes = request.maxBytes ?? 256 * 1024;
  const timeoutMs = request.timeoutMs ?? 10_000;
  // 宿主的 subprocess 服务要求 cwd 必填（dsh-subprocess-local 的 targetEnvironment 直接对
  // spec.cwd 调 includes，缺省时抛 "Cannot read properties of undefined (reading 'includes')"）。
  const cwd = request.cwd ?? process.cwd();
  const controller = new AbortController();
  const external = request.signal;
  const onExternalAbort = (): void => controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (external !== undefined) {
    if (external.aborted) {
      clearTimeout(timer);
      return {
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        aborted: true,
        spawnError: null,
      };
    }
    external.addEventListener("abort", onExternalAbort, { once: true });
  }

  let handle: ProcessHandle | null = null;
  try {
    handle = subprocess.spawn({
      argv: request.argv,
      cwd,
      stdio: {
        stdin: "ignore",
        stdout: { maxBytes },
        stderr: { maxBytes },
      },
      graceMs: 3_000,
      signal: controller.signal,
      ...(request.env === undefined ? {} : { env: request.env }),
    });
    const outcome = await handle.done;
    const stdout = handle.collected.stdout?.readFrom(0).text ?? "";
    const stderr = handle.collected.stderr?.readFrom(0).text ?? "";
    return {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout,
      stderr,
      timedOut,
      aborted: external?.aborted === true && !timedOut,
      spawnError: null,
    };
  } catch (error) {
    return {
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut,
      aborted: external?.aborted === true && !timedOut,
      spawnError: messageOf(error),
    };
  } finally {
    clearTimeout(timer);
    if (external !== undefined) external.removeEventListener("abort", onExternalAbort);
    if (handle !== null && request.awaitQuiescence === true) {
      await handle.waitForExit().catch(() => undefined);
    }
  }
}
export interface StreamingRunRequest extends RunRequest {
  /** 增量回调：每段新输出调用一次（已去掉末尾空行，保留原始换行）。 */
  onOutput?: (stream: "stdout" | "stderr", text: string) => void;
  /** 轮询间隔，默认 400 ms。 */
  pollMs?: number;
  /** 心跳回调，用于长任务（CubeMX 启动 90–150 s 无输出）报进度。 */
  onHeartbeat?: (elapsedMs: number) => void;
  /** 心跳间隔，默认 15 s。 */
  heartbeatMs?: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal !== undefined) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    }
  });
}

/**
 * 与 runCapture 同样语义，但在进程运行期间增量读取两条流。
 * 用于 3–4 分钟的 CubeMX 生成：调用方可以先把日志推给 job，而不是等结束。
 */
export async function runStreaming(
  subprocess: SubprocessService,
  request: StreamingRunRequest,
): Promise<RunOutcome> {
  const maxBytes = request.maxBytes ?? 2 * 1024 * 1024;
  const timeoutMs = request.timeoutMs ?? 600_000;
  const pollMs = request.pollMs ?? 400;
  const heartbeatMs = request.heartbeatMs ?? 15_000;
  const cwd = request.cwd ?? process.cwd();
  const controller = new AbortController();
  const external = request.signal;
  let timedOut = false;
  const startedAt = Date.now();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (external !== undefined) {
    if (external.aborted) {
      clearTimeout(timer);
      return { exitCode: null, signal: null, stdout: "", stderr: "", timedOut: false, aborted: true, spawnError: null };
    }
    external.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let handle: ProcessHandle | null = null;
  try {
    handle = subprocess.spawn({
      argv: request.argv,
      cwd,
      stdio: { stdin: "ignore", stdout: { maxBytes }, stderr: { maxBytes } },
      graceMs: 5_000,
      signal: controller.signal,
      ...(request.env === undefined ? {} : { env: request.env }),
    });
    const current = handle;
    let settled = false;
    void current.done.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    let outOffset = 0;
    let errOffset = 0;
    const drain = (): void => {
      const stdoutReader = current.collected.stdout;
      if (stdoutReader !== undefined) {
        const chunk = stdoutReader.readFrom(outOffset);
        if (chunk.nextOffset > outOffset) {
          outOffset = chunk.nextOffset;
          if (chunk.text !== "") request.onOutput?.("stdout", chunk.text);
        }
      }
      const stderrReader = current.collected.stderr;
      if (stderrReader !== undefined) {
        const chunk = stderrReader.readFrom(errOffset);
        if (chunk.nextOffset > errOffset) {
          errOffset = chunk.nextOffset;
          if (chunk.text !== "") request.onOutput?.("stderr", chunk.text);
        }
      }
    };
    let lastBeat = Date.now();
    while (!settled) {
      await sleep(pollMs, controller.signal);
      drain();
      if (request.onHeartbeat !== undefined && Date.now() - lastBeat >= heartbeatMs) {
        lastBeat = Date.now();
        request.onHeartbeat(Date.now() - startedAt);
      }
    }
    drain();
    const outcome = await current.done;
    return {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout: current.collected.stdout?.readFrom(0).text ?? "",
      stderr: current.collected.stderr?.readFrom(0).text ?? "",
      timedOut,
      aborted: external?.aborted === true && !timedOut,
      spawnError: null,
    };
  } catch (error) {
    return { exitCode: null, signal: null, stdout: "", stderr: "", timedOut, aborted: false, spawnError: messageOf(error) };
  } finally {
    clearTimeout(timer);
    if (handle !== null && request.awaitQuiescence === true) {
      await handle.waitForExit().catch(() => undefined);
    }
  }
}
