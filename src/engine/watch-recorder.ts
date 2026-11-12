/**
 * 监视自动采样：按固定间隔调一次 sampleWatches，把结果当通道事件发出去。
 *
 * 复用面板已有的 `channel:watch` 形状，曲线不用改；采样本体仍是 debug-session 的
 * 「临时停下 → 逐项读 → 按原状态放回」，只是把「人手点一次」换成定时器。
 *
 * 默认关：自动采样会在目标运行时反复打断它，联调多久就打断多久，必须显式打开。
 */

import type { WatchSample } from "./debug-session.js";

/** 采样间隔下限：再密就得长时间把目标按在停止态，打断感明显。 */
export const WATCH_RECORD_MIN_MS = 500;
/** 采样间隔上限：太稀就看不出变化。 */
export const WATCH_RECORD_INTERVAL_MAX_MS = 60_000;
/** 默认间隔。 */
export const WATCH_RECORD_INTERVAL_MS = 2_000;
/** 一次录制的时长上限：忘记关也不会一直打断目标。 */
export const WATCH_RECORD_MAX_MS = 10 * 60_000;

export interface WatchRecordStatus {
  active: boolean;
  intervalMs: number;
  recorded: number;
  startedAt: string;
  lastAt: string;
  lastError: string;
  remainingMs: number;
}

export interface WatchRecordDeps {
  /** 采一次；失败时 ok=false 并给 errors。 */
  sample: () => Promise<{ ok: boolean; samples: WatchSample[]; errors?: string[] }>;
  /** 把一批样本发出去（面板按 `channel:watch` 收）。 */
  emit: (samples: WatchSample[]) => void;
  now: () => number;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearTimer?: (timer: ReturnType<typeof setInterval>) => void;
}

export interface WatchRecorder {
  start(options?: { intervalMs?: number }): WatchRecordStatus;
  stop(): WatchRecordStatus;
  status(): WatchRecordStatus;
  reset(): void;
}

/** 建一个录制器。抽成工厂是为了单测能注入假采样与假定时器，不碰 gdb。 */
export function createWatchRecorder(deps: WatchRecordDeps): WatchRecorder {
  const setTimer = deps.setTimer ?? ((callback: () => void, ms: number): ReturnType<typeof setInterval> => {
    const timer = setInterval(callback, ms);
    // 定时器不该拖住宿主退出。
    if (typeof timer === "object" && timer !== null && typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    return timer;
  });
  const clearTimer = deps.clearTimer ?? ((timer: ReturnType<typeof setInterval>): void => {
    clearInterval(timer);
  });

  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;
  let intervalMs = WATCH_RECORD_INTERVAL_MS;
  let startedMs = 0;
  let lastMs = 0;
  let lastError = "";
  let recorded = 0;

  const expired = (): boolean => startedMs !== 0 && deps.now() - startedMs >= WATCH_RECORD_MAX_MS;

  const status = (): WatchRecordStatus => ({
    active: timer !== null,
    intervalMs: intervalMs,
    recorded: recorded,
    startedAt: startedMs === 0 ? "" : new Date(startedMs).toISOString(),
    lastAt: lastMs === 0 ? "" : new Date(lastMs).toISOString(),
    lastError: lastError,
    remainingMs: startedMs === 0 ? 0 : Math.max(0, WATCH_RECORD_MAX_MS - (deps.now() - startedMs)),
  });

  const halt = (reason: string): WatchRecordStatus => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    lastError = reason;
    return status();
  };

  const tick = async (): Promise<void> => {
    if (busy) return;
    if (expired()) {
      halt("录制到达上限（" + String(Math.round(WATCH_RECORD_MAX_MS / 60_000)) + " 分钟），已停止");
      return;
    }
    busy = true;
    try {
      const result = await deps.sample();
      if (result.ok) {
        recorded += result.samples.length;
        lastMs = deps.now();
        lastError = "";
        if (result.samples.length > 0) deps.emit(result.samples);
      } else {
        lastError = (result.errors ?? []).join("；") === "" ? "采样失败" : (result.errors ?? []).join("；");
        lastMs = deps.now();
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  };

  return {
    start(options: { intervalMs?: number } = {}): WatchRecordStatus {
      const requested = options.intervalMs ?? intervalMs;
      intervalMs = Math.min(WATCH_RECORD_INTERVAL_MAX_MS, Math.max(WATCH_RECORD_MIN_MS, Math.trunc(requested)));
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      startedMs = deps.now();
      lastMs = 0;
      lastError = "";
      recorded = 0;
      timer = setTimer(() => {
        void tick();
      }, intervalMs);
      return status();
    },
    stop(): WatchRecordStatus {
      return halt("");
    },
    status: status,
    reset(): void {
      if (timer !== null) clearTimer(timer);
      timer = null;
      busy = false;
      startedMs = 0;
      lastMs = 0;
      lastError = "";
      recorded = 0;
      intervalMs = WATCH_RECORD_INTERVAL_MS;
    },
  };
}
