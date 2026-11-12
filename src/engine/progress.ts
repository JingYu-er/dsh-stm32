/**
 * 在途工具调用表：面板据此显示「谁在跑、跑了多久」，并支持中止。
 *
 * 为什么自己做一层 AbortController 桥：宿主传来的 `exec.signal` 由调用方持有，
 * 插件不能也不该从内部 abort 它。这里派生一个本地 controller，把宿主的 abort
 * 转发进来，面板的中止则 abort 本地这一支——工具本来就把 `exec.signal` 透传给
 * 子进程，因此中止会一路传到 cmake / openocd / gdb，而不是只把面板状态改掉。
 */

import { emitEvent } from "./event-bus.js";

/** 面板与 `/status` 看到的一条在途调用。 */
export interface RunningCall {
  id: string;
  name: string;
  session: string;
  startedMs: number;
  startedAt: string;
  phase: string;
}

/** 调用方拿到的句柄：更新进度、结束登记。 */
export interface RunningHandle {
  info: RunningCall;
  signal: AbortSignal;
  update(phase: string): void;
  end(): void;
}

interface Entry {
  info: RunningCall;
  controller: AbortController;
}

let counter = 0;
const entries = new Map<string, Entry>();

/**
 * 登记一次在途调用并派生中止信号。
 *
 * `outer` 是宿主给的 signal：它被 abort 时本地同步 abort，工具看到的仍是同一语义。
 */
export function beginToolCall(input: {
  name: string;
  session?: string;
  outer?: AbortSignal;
}): RunningHandle {
  counter += 1;
  const controller = new AbortController();
  const info: RunningCall = {
    id: "call-" + String(counter),
    name: input.name,
    session: (input.session ?? "").trim(),
    startedMs: Date.now(),
    startedAt: new Date().toISOString(),
    phase: "",
  };
  entries.set(info.id, { info, controller });

  const outer = input.outer;
  const bridge = (): void => {
    if (!controller.signal.aborted) controller.abort();
  };
  if (outer !== undefined) {
    if (outer.aborted) bridge();
    else outer.addEventListener("abort", bridge);
  }

  const cleanup = (): void => {
    if (outer !== undefined) outer.removeEventListener("abort", bridge);
  };

  return {
    info,
    signal: controller.signal,
    update(phase: string): void {
      const text = phase.trim();
      if (text === "" || text === info.phase) return;
      info.phase = text;
      emitEvent({
        source: "model",
        kind: "progress",
        status: "info",
        summary: info.name + "：" + text,
        payload: { callId: info.id, tool: info.name, phase: text },
        session: info.session,
      });
    },
    end(): void {
      cleanup();
      entries.delete(info.id);
    },
  };
}

/** 在途调用列表；传 session 时只列该会话的。 */
export function listRunning(session?: string): RunningCall[] {
  const wanted = (session ?? "").trim();
  const all = [...entries.values()].map((entry) => ({ ...entry.info }));
  if (wanted === "") return all;
  return all.filter((info) => info.session === wanted);
}

/** 中止一条在途调用；返回它中止前的信息，找不到返回 null。 */
export function abortCall(id: string): RunningCall | null {
  const entry = entries.get(id);
  if (entry === undefined) return null;
  entry.controller.abort();
  return { ...entry.info };
}

/** 中止某个会话（或全部）的在途调用，返回中止条数。 */
export function abortAll(session?: string): number {
  const targets = listRunning(session);
  let count = 0;
  for (const info of targets) {
    if (abortCall(info.id) !== null) count += 1;
  }
  return count;
}

/** 单测用：清空登记表。 */
export function resetRunning(): void {
  for (const entry of entries.values()) entry.controller.abort();
  entries.clear();
  counter = 0;
}
