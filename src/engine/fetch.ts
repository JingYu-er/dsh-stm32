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
}

const HTML_HEAD_BYTES = 512;

let partSeq = 0;

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

/** 下载单个文件（多候选）。失败不抛，把原因写进 outcome —— 上层要一次性报告所有失败。 */
export async function fetchOne(target: FetchTarget, destRoot: string, options: FetchOptions = {}): Promise<FetchOutcome> {
  const attempts: string[] = [];
  const minBytes = target.minBytes ?? 16;
  const dest = path.join(destRoot, target.path);
  const fetchImpl = options.fetchImpl ?? fetch;
  for (const url of target.urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
    const onAbort = (): void => controller.abort();
    if (options.signal !== undefined) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const response = await fetchImpl(url, { signal: controller.signal, redirect: "follow" });
      if (!response.ok) {
        attempts.push(url + " → HTTP " + String(response.status));
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
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
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      partSeq += 1;
      const tag = String(process.pid) + "-" + String(partSeq);
      const part = dest + ".part-" + tag;
      const old = dest + ".old-" + tag;
      fs.writeFileSync(part, buffer);
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
      const name = error instanceof Error ? error.name : "";
      const message = error instanceof Error ? error.message : String(error);
      attempts.push(url + " → " + (name === "AbortError" ? "超时/取消（" + String(options.timeoutMs ?? 30_000) + " ms）" : message));
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener?.("abort", onAbort);
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
