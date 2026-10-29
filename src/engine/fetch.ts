/**
 * 极简下载器：按候选 URL 逐个试，成功一个就停。
 *
 * 为什么要有"候选 URL"：同一份 ST 头文件，raw.githubusercontent.com 在有些网络里会超时、
 * jsDelivr 在另一些网络里被墙——写死一个源就是把插件的可用性押在某条线路上。
 * 实测（2026-10，本机）：raw.githubusercontent 超时、github.com/codeload/api 正常、
 * fastly.jsdelivr.net 与 ghproxy.net 正常 —— 所以候选顺序是 jsDelivr → raw → ghproxy。
 *
 * 只用全局 fetch（Node 18+ 自带），不引运行时依赖；测试可注入 fetchImpl。
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface FetchTarget {
  /** 相对 destRoot 的落盘路径（正斜杠）。 */
  path: string;
  /** 候选 URL，按优先级排列。 */
  urls: string[];
  /** 低于这个字节数就当作下载失败（防止把 404 页面当文件）。 */
  minBytes?: number;
  /**
   * 内容特征：至少命中其中一个才算数（A32）。
   * 字节数和「不是网页」都只是粗筛——代理换成登录页、CDN 返回同名但不同版本的文件，
   * 字节数照样对得上。这里钉的是「这份内容里必须有这个东西」。
   */
  markers?: string[];
  /**
   * 期望的 sha256（64 位十六进制，小写）。给了的文件在 markers 之后再校验哈希：
   * 上游 master 漂移、CDN 缓存了旧版、同名不同代的内容都会被它拦下。
   * 哈希对不上时错误信息带期望值与实际值——维护者一看就知道上游动了、该重新实测。
   * 不给（老数据/还没实测的族）就只走 minBytes + HTML + markers，行为不变。
   */
  sha256?: string;
}

export interface FetchOutcome {
  path: string;
  ok: boolean;
  bytes: number;
  /** 真正成功的那个 URL；失败时是空串。 */
  url: string;
  error: string;
  /** 每个候选 URL 的尝试结果，失败时要能说清"试过哪些源"。 */
  attempts: string[];
}

export interface FetchOptions {
  concurrency?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (outcome: FetchOutcome, done: number, total: number) => void;
  /** 低速判死的观察窗口（默认 10 s，F3c）。 */
  stallMs?: number;
  /** 窗口内平均低于这个速率就算"这条线不行"（默认 1 KB/s，F3c）。 */
  minBytesPerSec?: number;
}

const HTML_HEAD_BYTES = 512;

/** F3c：10 s 内平均不足 1 KB/s 就 abort。半截文件留在 .part 里，下一秒从断点续。 */
const DEFAULT_STALL_MS = 10_000;
const DEFAULT_MIN_BYTES_PER_SEC = 1024;

let partSeq = 0;

/** 单个 .part 文件的大小；没有就是 0。 */
function partSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

interface StreamOutcome {
  ok: boolean;
  bytes: number;
  /** 失败原因（ok 时为空串）。 */
  reason: string;
  /** 是不是"太慢/停滞"结束的：只有这种才值得在同一源上续传重试。 */
  slow: boolean;
}

/**
 * 下一次文件到 partPath（F3c）：支持从 startAt 字节续传。
 *
 * 三个必须的边界：
 *   1. 服务器回 200 而不是 206 = 它忽略了 Range，必须**从头写**（截断），不能接在旧字节后面；
 *   2. 10 s 观察窗口内平均速率不足 1 KB/s 就 abort（半截文件留着，交给上层续传或换源）；
 *   3. 外层 signal 取消要能立刻停（不能让一个 30 s 的下载拖住取消）。
 */
async function streamOnce(
  url: string,
  partPath: string,
  startAt: number,
  fetchImpl: typeof fetch,
  options: FetchOptions,
): Promise<StreamOutcome> {
  const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
  const minRate = options.minBytesPerSec ?? DEFAULT_MIN_BYTES_PER_SEC;
  const controller = new AbortController();
  const overall = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  const onAbort = (): void => controller.abort();
  if (options.signal !== undefined) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }
  let slow = false;
  let lastProgress = Date.now();
  let windowStart = Date.now();
  let windowBytes = 0;
  const watchdog = setInterval(() => {
    const now = Date.now();
    if (now - lastProgress > stallMs) {
      slow = true;
      controller.abort();
      return;
    }
    const elapsed = now - windowStart;
    if (elapsed >= stallMs) {
      if ((windowBytes * 1000) / elapsed < minRate) {
        slow = true;
        controller.abort();
        return;
      }
      windowStart = now;
      windowBytes = 0;
    }
  }, Math.min(1000, Math.max(100, Math.floor(stallMs / 4))));
  try {
    const headers: Record<string, string> = {};
    if (startAt > 0) headers["Range"] = "bytes=" + String(startAt) + "-";
    const response = await fetchImpl(url, { headers, signal: controller.signal, redirect: "follow" });
    if (startAt > 0 && response.status === 416) {
      return { ok: false, bytes: startAt, reason: "服务器说 Range 越界（416）", slow: false };
    }
    if (!response.ok && response.status !== 206) {
      return { ok: false, bytes: 0, reason: "HTTP " + String(response.status), slow: false };
    }
    // 只有 206 才是"接着上次的字节"；200 说明它整份重发，必须截断重写。
    const append = startAt > 0 && response.status === 206;
    const body = response.body;
    if (body === null) return { ok: false, bytes: 0, reason: "响应没有 body", slow: false };
    const reader = body.getReader();
    const fd = fs.openSync(partPath, append ? "a" : "w");
    let written = append ? startAt : 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const value = chunk.value;
        if (value === undefined) continue;
        fs.writeSync(fd, value);
        written += value.byteLength;
        windowBytes += value.byteLength;
        lastProgress = Date.now();
      }
    } finally {
      fs.closeSync(fd);
    }
    return { ok: true, bytes: written, reason: "", slow: false };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : String(error);
    if (slow) {
      return {
        ok: false,
        bytes: partSize(partPath),
        reason:
          "低速/停滞（" + String(Math.round(stallMs / 1000)) + " s 内平均不足 " + String(minRate) + " B/s）",
        slow: true,
      };
    }
    const timedOut = name === "AbortError";
    return {
      ok: false,
      bytes: partSize(partPath),
      reason: timedOut
        ? "超时/取消（" + String(options.timeoutMs ?? 30_000) + " ms）"
        : message,
      slow: false,
    };
  } finally {
    clearTimeout(overall);
    clearInterval(watchdog);
    options.signal?.removeEventListener?.("abort", onAbort);
  }
}

function looksLikeHtml(buffer: Buffer): boolean {
  const head = buffer.subarray(0, HTML_HEAD_BYTES).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

/** 内容特征校验：markers 是"至少命中一个"，命中返回空数组，否则返回没命中的那几个（给报错用）。 */
function missingMarkers(buffer: Buffer, markers: string[]): string[] {
  if (markers.length === 0) return [];
  const text = buffer.toString("utf8");
  return markers.some((marker) => text.includes(marker)) ? [] : markers;
}

function removeQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // 临时文件删不掉不影响这次的结论。
  }
}

/**
 * 下载单个文件（多候选，F3c：同一源内断点续传）。失败不抛，把原因写进 outcome
 * —— 上层要一次性报告所有失败。
 *
 * 为什么"同一个源内续传、换源必须从零"：同一条线路上的 Range 续的是同一份文件；
 * 换到另一个源时，镜像与上游的字节不保证是同一份（同步时点不同），接起来必然是坏文件。
 */
export async function fetchOne(target: FetchTarget, destRoot: string, options: FetchOptions = {}): Promise<FetchOutcome> {
  const attempts: string[] = [];
  const minBytes = target.minBytes ?? 16;
  const dest = path.join(destRoot, target.path);
  const fetchImpl = options.fetchImpl ?? fetch;
  partSeq += 1;
  const tag = String(process.pid) + "-" + String(partSeq);
  const part = dest + ".part-" + tag;
  const old = dest + ".old-" + tag;
  // 取消判定包一层：直接比较 signal.aborted 会被上面的分支narrow 成 false，续传那行的条件就永远不成立。
  const isCancelled = (): boolean => options.signal?.aborted === true;
  for (const url of target.urls) {
    if (isCancelled()) {
      attempts.push(url + " → 已取消（没再试）");
      break;
    }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
    } catch {
      // 目录建不了会在写盘那一步报出来，这里不抢戏。
    }
    removeQuietly(part);
    let streamed = await streamOnce(url, part, 0, fetchImpl, options);
    // 只有"太慢/停滞"才值得在同一源上续传一次：断点已落在 .part 里，再从那里接着要。
    if (!streamed.ok && streamed.slow && streamed.bytes > 0 && !isCancelled()) {
      attempts.push(url + " → " + streamed.reason + "，" + String(streamed.bytes) + " 字节已落盘，续传重试");
      streamed = await streamOnce(url, part, streamed.bytes, fetchImpl, options);
    }
    if (!streamed.ok) {
      attempts.push(url + " → " + streamed.reason);
      removeQuietly(part);
      continue;
    }
    try {
      const buffer = fs.readFileSync(part);
      if (buffer.byteLength < minBytes) {
        attempts.push(url + " → 只有 " + String(buffer.byteLength) + " 字节（< " + String(minBytes) + "，不像真文件）");
        continue;
      }
      if (looksLikeHtml(buffer)) {
        attempts.push(url + " → 拿回来是网页（代理拦截或 404 页），不是文件");
        continue;
      }
      const missed = missingMarkers(buffer, target.markers ?? []);
      if (missed.length > 0) {
        attempts.push(url + " → 内容对不上（找不到 " + missed.join(" / ") + "），不是要的那个文件");
        continue;
      }
      if (target.sha256 !== undefined && target.sha256 !== "") {
        const actual = createHash("sha256").update(buffer).digest("hex");
        if (actual !== target.sha256.toLowerCase()) {
          attempts.push(
            url + " → sha256 对不上（期望 " + target.sha256.toLowerCase().slice(0, 16) + "…，实际 " + actual.slice(0, 16) +
              "…）。多半是上游 master 挪动了内容：用真实 URL 重新实测哈希并更新 cmsis-sources。",
          );
          continue;
        }
      }
      // 先给旧文件改名、再把新课搬上来（A15）：旧写法是「先删旧文件再 rename」，
      // 第二步失败（Windows 上杀软扫描、目录只读、权限刚变）就新旧一起没了。
      let movedOld = false;
      try {
        if (fs.existsSync(dest)) {
          fs.renameSync(dest, old);
          movedOld = true;
        }
        fs.renameSync(part, dest);
      } catch (error) {
        try {
          if (movedOld && !fs.existsSync(dest)) fs.renameSync(old, dest);
        } catch {
          // 放不回去就只能留着 .old：把路径写进 attempts，至少人能手工找回。
        }
        removeQuietly(part);
        const message = error instanceof Error ? error.message : String(error);
        attempts.push(url + " → 写盘失败（" + message + "）" + (movedOld ? "，旧文件已改名成 " + old : ""));
        continue;
      }
      if (movedOld) removeQuietly(old);
      return { path: target.path, ok: true, bytes: buffer.byteLength, url, error: "", attempts };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempts.push(url + " → " + message);
      removeQuietly(part);
    }
  }
  return { path: target.path, ok: false, bytes: 0, url: "", error: "所有源都没下下来：" + attempts.join("；"), attempts };
}

/** 并发下载一批（默认 3 路）。一个失败不影响其它，最后一次性汇总。 */
export async function fetchAll(targets: FetchTarget[], destRoot: string, options: FetchOptions = {}): Promise<{
  results: FetchOutcome[];
  ok: number;
  failed: number;
  bytes: number;
}> {
  const results: FetchOutcome[] = [];
  const total = targets.length;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, total === 0 ? 1 : total));
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const target = targets[index];
      if (target === undefined) return;
      const outcome = await fetchOne(target, destRoot, options);
      results.push(outcome);
      done += 1;
      options.onProgress?.(outcome, done, total);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const ok = results.filter((item) => item.ok).length;
  return {
    results,
    ok,
    failed: results.length - ok,
    bytes: results.reduce((sum, item) => sum + item.bytes, 0),
  };
}
