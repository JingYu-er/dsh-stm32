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

import { appendFile, mkdir, readdir, rm, stat } from "node:fs/promises";
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

/** 证据目录保留的会话数上限：超出时先删最老的会话目录。 */
export const EVENT_EVIDENCE_KEEP_SESSIONS = 20;
/** 证据目录保留天数上限：超过这个天数的日期目录整体删掉。 */
export const EVENT_EVIDENCE_KEEP_DAYS = 7;

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
 * 清理旧证据：按「日期目录超过 N 天」与「会话目录超过 M 个」两条规则，先算后删。
 *
 * 只删本插件自己的目录布局（<root>/<yyyy-mm-dd>/<会话>），遇到不合布局的条目跳过，
 * 绝不递归删 root 本身。
 */
export async function pruneEvidence(options: {
  root?: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  keepSessions?: number;
  keepDays?: number;
} = {}): Promise<{ removedDirs: string[]; removedFiles: number; removedBytes: number }> {
  const root = options.root ?? evidenceRoot(options.env);
  const now = options.now ?? new Date();
  const keepSessions = options.keepSessions ?? EVENT_EVIDENCE_KEEP_SESSIONS;
  const keepDays = options.keepDays ?? EVENT_EVIDENCE_KEEP_DAYS;
  const removedDirs: string[] = [];
  let removedFiles = 0;
  let removedBytes = 0;

  const measure = async (dir: string): Promise<{ files: number; bytes: number }> => {
    let files = 0;
    let bytes = 0;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return { files, bytes };
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const inner = await measure(full);
        files += inner.files;
        bytes += inner.bytes;
        continue;
      }
      try {
        const info = await stat(full);
        files += 1;
        bytes += info.size;
      } catch {
        // 文件刚被别处删掉：不计入即可。
      }
    }
    return { files, bytes };
  };

  let dayDirs: string[] = [];
  try {
    dayDirs = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/u.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return { removedDirs, removedFiles, removedBytes };
  }

  const cutoff = new Date(now.getTime() - keepDays * 24 * 60 * 60 * 1000);
  const liveDays: string[] = [];
  for (const day of dayDirs) {
    const at = new Date(day + "T00:00:00");
    if (Number.isNaN(at.getTime())) continue;
    if (at.getTime() < cutoff.getTime()) {
      const full = path.join(root, day);
      const size = await measure(full);
      await rm(full, { recursive: true, force: true });
      removedDirs.push(day);
      removedFiles += size.files;
      removedBytes += size.bytes;
      continue;
    }
    liveDays.push(day);
  }

  // 会话数按「最新 mtime 的会话目录」排序保留；跨日期目录一起算。
  const sessions: Array<{ full: string; relative: string; mtimeMs: number }> = [];
  liveDays.sort();
  for (const day of liveDays) {
    const dayDir = path.join(root, day);
    let entries;
    try {
      entries = await readdir(dayDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dayDir, entry.name);
      let mtimeMs = 0;
      try {
        mtimeMs = (await stat(full)).mtimeMs;
      } catch {
        continue;
      }
      sessions.push({ full, relative: day + "/" + entry.name, mtimeMs });
    }
  }
  if (sessions.length > keepSessions) {
    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of sessions.slice(keepSessions)) {
      const size = await measure(stale.full);
      await rm(stale.full, { recursive: true, force: true });
      removedDirs.push(stale.relative);
      removedFiles += size.files;
      removedBytes += size.bytes;
    }
  }
  return { removedDirs, removedFiles, removedBytes };
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
      await pruneEvidence({ root: options.root, env: options.env });
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
