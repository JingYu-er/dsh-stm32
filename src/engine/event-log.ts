/**
 * 把被环形缓冲挤出的事件定期落到证据目录。
 *
 * 分工：event-bus.ts 只管内存与序号，本文件只管「什么时候写、写到哪」。
 * 这样事件流在面板里永远是内存直读（毫秒级），磁盘写失败也不会拖慢工具调用。
 *
 * 落盘布局（每个会话一个目录）：
 *   <root>/<yyyy-mm-dd>/<sessionKey>/events-<HHmmss>.jsonl
 * 每批一个文件，按批次的起始时刻命名，复盘时按文件名排序即为时间顺序。
 */

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  drainEvicted,
  eventSessionKey,
  requeueEvicted,
  takeDroppedCount,
  type DebugEvent,
} from "./event-bus.js";

/** 默认落盘间隔。一批之内的事件共用一个文件。 */
export const EVENT_LOG_INTERVAL_MS = 30_000;

/** 证据目录根：允许用环境变量改到别处（例如放到工程内便于随工程归档）。 */
export function evidenceRoot(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.DSH_STM32_EVIDENCE;
  if (typeof custom === "string" && custom.trim() !== "") return path.resolve(custom.trim());
  return path.join(homedir(), ".dsh-stm32", "evidence");
}

/** 会话键要能当目录名：只留安全字符，空的退回 unbound。 */
export function safeSessionKey(key: string): string {
  const cleaned = key.trim().replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return cleaned === "" ? "unbound" : cleaned.slice(0, 80);
}

function pad(value: number): string {
  return value < 10 ? "0" + String(value) : String(value);
}

/** 日期目录：按本地日期分，便于人找。 */
export function dateFolder(now: Date): string {
  return now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
}

function timeName(now: Date): string {
  return pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
}

/** 某会话在某一时刻的证据目录。 */
export function sessionEvidenceDir(root: string, key: string, now: Date): string {
  return path.join(root, dateFolder(now), safeSessionKey(key));
}

function eventLine(event: DebugEvent): string {
  return JSON.stringify(event) + "\n";
}

/**
 * 写一批被挤出的事件。成功返回写入条数；失败把事件放回队列并抛出，由调用方决定是否重试。
 */
export async function flushEvicted(options: {
  root?: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<{ written: number; file: string | null; dropped: number }> {
  const now = options.now ?? new Date();
  const dropped = takeDroppedCount();
  const events = drainEvicted();
  if (events.length === 0 && dropped === 0) return { written: 0, file: null, dropped: 0 };
  const key = eventSessionKey() === "" ? "unbound" : eventSessionKey();
  const root = options.root ?? evidenceRoot(options.env);
  const dir = sessionEvidenceDir(root, key, now);
  const file = path.join(dir, "events-" + timeName(now) + ".jsonl");
  const lines: string[] = [];
  if (dropped > 0) {
    // 缺口本身要留痕：否则证据目录看起来连续，实际中间丢了条目。
    lines.push(
      eventLine({
        seq: events.length > 0 ? (events[0]?.seq ?? 0) : 0,
        time: now.toISOString(),
        source: "system",
        kind: "log",
        status: "fail",
        summary: "落盘通道积压，丢弃 " + String(dropped) + " 条事件",
        payload: { dropped },
      }),
    );
  }
  for (const event of events) lines.push(eventLine(event));
  try {
    await mkdir(dir, { recursive: true });
    await appendFile(file, lines.join(""), "utf8");
  } catch (error) {
    requeueEvicted(events);
    throw error;
  }
  return { written: events.length, file, dropped };
}

/**
 * 启动定期落盘。返回停止函数（停止时再冲一次，尽量把内存里的挤出条目落完）。
 *
 * onError 只用于把失败报给宿主日志；默认静默，避免磁盘问题刷屏。
 */
export function startEventLog(options: {
  intervalMs?: number;
  root?: string;
  env?: NodeJS.ProcessEnv;
  onError?: (error: unknown) => void;
} = {}): () => Promise<void> {
  const intervalMs = options.intervalMs ?? EVENT_LOG_INTERVAL_MS;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await flushEvicted({ root: options.root, env: options.env });
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return async () => {
    clearInterval(timer);
    await tick();
  };
}
