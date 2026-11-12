/**
 * 监视登记表的读写入口（面板用）。
 *
 * 工具 stm32_watch 与面板操作的是同一份 `watchState`：面板加一项，下一次 sample 就会读到它。
 * 这里只做登记/注销与列清单，不采样、不发通道事件——采样仍由 `stm32_watch` 触发。
 * 硬件观察点（write/read/access）必须装进 gdb，所以要活动会话；值监视（value）只登记表达式。
 */

import { debugSessions } from "./debug-session.js";
import {
  registerWatch,
  removeAllWatches,
  removeWatchByIds,
  watchState,
  isWatchKind,
  WATCH_KIND_LABELS,
  type WatchEntry,
  type WatchKind,
} from "./watch.js";

export interface WatchView {
  id: number;
  expression: string;
  kind: WatchKind;
  kindLabel: string;
  lastValue: string;
  lastAt: number;
  lastError: string;
}

export interface WatchList {
  entries: WatchView[];
  budget: { used: number; limit: number; remaining: number };
  /** 只有活动会话才能加硬件观察点。 */
  canAddWatchpoint: boolean;
}

function view(entry: WatchEntry): WatchView {
  return {
    id: entry.id,
    expression: entry.expression,
    kind: entry.kind,
    kindLabel: WATCH_KIND_LABELS[entry.kind],
    lastValue: entry.lastValue,
    lastAt: entry.lastAt,
    lastError: entry.lastError,
  };
}

export function listWatches(): WatchList {
  return {
    entries: watchState.entries.map(view),
    budget: debugSessions.status().watchpoints,
    canAddWatchpoint: debugSessions.isActive(),
  };
}

export interface WatchEditReport {
  ok: boolean;
  added: WatchView[];
  removed: WatchView[];
  errors: string[];
  message: string;
}

const emptyEdit = (message: string, errors: string[] = []): WatchEditReport => ({
  ok: false,
  added: [],
  removed: [],
  errors,
  message,
});

/** 加监视项：value 只登记；write/read/access 走 gdb 装硬件观察点。 */
export async function addWatches(request: { kind: string; expressions: readonly string[] }): Promise<WatchEditReport> {
  const kind = request.kind;
  if (!isWatchKind(kind)) return emptyEdit("kind 不认识：" + kind + "（只认 value/write/read/access）", ["kind 不认识：" + kind]);
  const wanted = request.expressions.map((item) => item.trim()).filter((item) => item !== "");
  if (wanted.length === 0) return emptyEdit("没有表达式", ["没有表达式"]);

  if (kind === "value") {
    const added: WatchView[] = [];
    const errors: string[] = [];
    for (const expression of wanted) {
      const registered = registerWatch(watchState, expression, "value", Date.now());
      if (registered.entry === null) errors.push(registered.error);
      else added.push(view(registered.entry));
    }
    return {
      ok: errors.length === 0,
      added,
      removed: [],
      errors,
      message: errors.length === 0
        ? "已登记 " + String(added.length) + " 个值监视项"
        : "登记部分失败：" + errors[0],
    };
  }

  if (!debugSessions.isActive()) {
    return emptyEdit("硬件观察点需要活动调试会话（先 stm32_debug_session）", ["没有调试会话"]);
  }
  const report = await debugSessions.addWatchpoints({ entries: wanted.map((expression) => ({ expression, kind })) });
  return {
    ok: report.ok,
    added: report.added.map(view),
    removed: [],
    errors: report.errors,
    message: report.message,
  };
}

export async function removeWatches(ids: readonly number[]): Promise<WatchEditReport> {
  const wanted = ids.filter((id) => Number.isInteger(id) && id > 0);
  if (wanted.length === 0) return emptyEdit("ids 必须是正整数数组", ["ids 必须是正整数数组"]);
  // 硬件观察点住在 gdb 里：交给 DebugSessionManager 删，它同时清登记表、必要时执行 gdb 的 delete。
  const report = await debugSessions.removeWatchpoints(wanted);
  return {
    ok: report.ok,
    added: [],
    removed: report.removed.map(view),
    errors: report.errors,
    message: report.message,
  };
}

export async function clearWatches(): Promise<WatchEditReport> {
  const ids = watchState.entries.map((entry) => entry.id);
  if (ids.length === 0) return { ok: true, added: [], removed: [], errors: [], message: "登记表已经是空的" };
  const report = await debugSessions.removeWatchpoints(ids);
  return {
    ok: report.ok,
    added: [],
    removed: report.removed.map(view),
    errors: report.errors,
    message: report.message,
  };
}
