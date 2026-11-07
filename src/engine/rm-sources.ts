/**
 * RM（参考手册）载体获取：双通道 + 逐线覆盖验证。
 *
 * 取证（2026-11-07 实测，全部零登录匿名）：
 *   主通道 = ST 官方 sitemap：https://www.st.com/content/st_com/sitemap{1..10}.xml
 *     （37,647 条 <loc>，其中 132 条 /resource/en/reference_manual/*.pdf 直链；
 *      RM0490 直链 HEAD 200 application/pdf 11,536,384 B）。slug 含族名
 *      （rm0490-stm32c0-series-…），族级匹配可用；不锁「号→URL」表——清单每次从站点现取。
 *   备案通道 = ST 中国官网 stmcu.com.cn：分类页
 *     /Designresource/list/<族>/document/reference_manual（200 可解析 detail 链接；
 *     连打 3 次触发 429，必须节流）→ 详情页 /Designresource/detail/document/<id>
 *     （匿名 200）→ 内联 JS 里 window.open 的 www.st.com.cn/content/ccc/…/translations/
 *     zh.DMxxxxxx.pdf 直链（匿名 200；RM0490 中文实测与你本地那份逐字节同哈希）。
 *     stmcu 自己的 design_resource_download token 端点匿名 303 跳 SSO，**不可用**。
 *
 * 覆盖验证：Node 解流抽取（inflate content stream → 拼文本字面量 → 去噪归一化）。
 *   EN RM0490 实测命中 BOOT_LOCK/nBOOT_SEL/OPTKEY1/0x08192A3B/DBG_SWEN 与
 *   STM32C011xx…STM32C092xx 全部六线（Table 3..6 就是逐线边界地址表）。
 *   中文 PDF 是 CID 编码字体，这个抽取器抽不出线名——所以覆盖判定只信 EN 通道。
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { fetchOne } from "./fetch.js";
import { factsRoot, partToFamilyLine } from "./facts.js";

export interface RmCatalogEntry {
  url: string;
  /** rm0490 这样的小写文档号。 */
  docId: string;
  /** slug 里出现过的族 token（stm32c0、stm32f103xx、l4-series …）。 */
  tokens: string[];
}

const SITEMAP_BASE = "https://www.st.com/content/st_com/sitemap";
export const RM_SITEMAP_PAGES = 10;

function fetchText(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<{ status: number; body: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  return fetchImpl(url, { signal: ac.signal, redirect: "follow", headers: { "User-Agent": "dsh-stm32/facts" } })
    .then(async (r) => ({ status: r.status, body: await r.text() }))
    .finally(() => clearTimeout(timer));
}

/** 从 sitemap XML 文本抽英文 reference_manual 直链清单（纯函数，可单测）。 */
export function parseRmSitemap(xml: string): RmCatalogEntry[] {
  const out: RmCatalogEntry[] = [];
  for (const m of xml.matchAll(/<loc>(https:\/\/www\.st\.com\/resource\/en\/reference_manual\/[^<]+\.pdf)<\/loc>/g)) {
    const url = m[1] ?? "";
    const slug = url.split("/").pop() ?? "";
    const docId = (slug.match(/rm\d{4}/i) ?? [""])[0].toLowerCase();
    const tokens = [...new Set([...slug.toLowerCase().matchAll(/stm32[a-z0-9]+|cortex[a-z0-9+]+/g)].map((x) => x[0]))];
    out.push({ url, docId, tokens });
  }
  return out;
}

/** 抓全 10 张 sitemap 合成 RM 目录。串行、单张失败不炸（记进 errors）。 */
export async function fetchRmCatalog(o: { fetchImpl?: typeof fetch; timeoutMs?: number; pages?: number } = {}): Promise<{ entries: RmCatalogEntry[]; errors: string[] }> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? 30_000;
  const pages = o.pages ?? RM_SITEMAP_PAGES;
  const entries: RmCatalogEntry[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (let i = 1; i <= pages; i += 1) {
    try {
      const r = await fetchText(SITEMAP_BASE + String(i) + ".xml", fetchImpl, timeoutMs);
      if (r.status !== 200) { errors.push("sitemap" + String(i) + " HTTP " + String(r.status)); continue; }
      for (const e of parseRmSitemap(r.body)) {
        if (seen.has(e.url)) continue;
        seen.add(e.url);
        entries.push(e);
      }
    } catch (error) {
      errors.push("sitemap" + String(i) + " " + (error instanceof Error ? error.message : String(error)));
    }
  }
  return { entries, errors };
}

/** 目标线（STM32C051）/族（STM32C0）→ 从目录里选最匹配的 RM；返回候选（按优先级）与落选原因。 */
export function matchRmForLine(catalog: RmCatalogEntry[], family: string, line: string): { picked: RmCatalogEntry | null; candidates: RmCatalogEntry[] } {
  const fam = family.toLowerCase();          // stm32c0
  const ln = line.toLowerCase();             // stm32c051
  const lineXx = ln + "xx";
  const famSeries = fam + "-series";
  const scored = catalog
    .filter((e) => e.url.toLowerCase().includes(fam))
    .map((e) => {
      const u = e.url.toLowerCase();
      let score = 0;
      if (u.includes(lineXx)) score += 100;               // slug 直接列了这条线（stm32l41xxx 这类不含 412，走下一层）
      // 线号首位：STM32L412 → stm32l41（slug 写 stm32l41xxx）；slice(0,7) 恰好是族名，不能用
      const tail = ln.slice(fam.length).replace(/[^0-9]/gu, "");
      const stem = tail === "" ? "" : fam + tail.charAt(0);
      if (stem !== "" && u.includes(stem)) score += 60;
      if (u.includes(famSeries)) score += 40;             // 族级 series 手册（rm0490-stm32c0-series）
      if (u.includes(fam)) score += 20;
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.e.docId.localeCompare(b.e.docId));
  return { picked: scored[0]?.e ?? null, candidates: scored.map(x => x.e) };
}

/**
 * 解 PDF content stream 抽文本字面量（Tj/TJ 里的 (…)）。自研扫描器而不是正则：
 * 需要区分布局算子插入的负数间距（…) -2457 (… 是大间距→空格）与 kerning 小数
 * （[(a)-5(b)] 是同一个词）。失败退回 latin1 原文（会偏松，但只作为回退）。
 */
export function extractPdfLatinText(buf: Buffer): string {
  const latin = buf.toString("latin1");
  let hay = "";
  const re = /stream\r?\n?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(latin)) !== null) {
    const start = m.index + m[0].length;
    const stop = latin.indexOf("endstream", start);
    if (stop < 0) continue;
    const raw = buf.subarray(start, stop);
    try { hay += inflateSync(raw).toString("latin1"); } catch { hay += raw.toString("latin1"); }
  }
  let out = "";
  let i = 0;
  while (i < hay.length) {
    const ch = hay.charCodeAt(i);
    if (ch === 40) {
      i += 1;
      let s = "";
      while (i < hay.length) {
        const c = hay[i];
        if (c === "\\") { const nx = hay[i + 1]; if (nx !== undefined && /[0-7]/.test(nx)) { let oct = ""; let k = i + 1; while (k < hay.length && oct.length < 3 && /[0-7]/.test(hay[k] ?? "")) { oct += hay[k]; k += 1; } s += String.fromCharCode(parseInt(oct, 8)); i = k; continue; } s += nx ?? ""; i += 2; continue; }
        if (c === "(") { s += "("; i += 1; continue; }
        if (c === ")") { i += 1; break; }
        s += c; i += 1;
      }
      out += s;
      continue;
    }
    // TJ 数组里的元素间距：(str) -578 (str) —— 数字前必须是 ")"、后接 "(" 或 "]"。
    // kerning 小数（±100 以下）与坐标数不置空格；≥200 才当空格。
    if (ch === 45 || ch === 43 || ch === 46 || (ch >= 48 && ch <= 57)) {
      const prev = i > 0 ? hay.charCodeAt(i - 1) : -1;
      if (prev === 41) {
        let j = i;
        if (hay[j] === "-" || hay[j] === "+") j += 1;
        const d0 = j;
        while (j < hay.length && hay.charCodeAt(j) >= 48 && hay.charCodeAt(j) <= 57) j += 1;
        if (j > d0) {
          const after = j < hay.length ? hay.charCodeAt(j) : -1;
          if (after === 40 || after === 93) {
            const num = Number(hay.slice(i, j));
            if (Number.isFinite(num) && Math.abs(num) >= 200) out += " ";
            i = j;
            continue;
          }
        }
      }
    }
    i += 1;
  }
  return out;
}

/** 引文回查用的归一化：八位组/括号/反斜杠转义清掉、小写、非字母数字→单空格（保短语与常数）。 */
export function normalizePdfText(text: string): string {
  return text
    .replace(/\\[nrtbf]/g, " ")
    .replace(/\\[0-7]{1,3}/g, " ")
    .replace(/\\(.)/g, "$1")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** 全压平索引（只留字母数字小写）：覆盖判定与短语回查的公共底座。 */
export function pdfCoverageIndex(buf: Buffer): string {
  return normalizePdfText(extractPdfLatinText(buf)).replace(/[^a-z0-9]/g, "");
}

/** 线覆盖判定：压平索引里找 <line>xx（STM32C051 → stm32c051xx）。 */
export function lineCovered(index: string, line: string): boolean {
  return index.includes(line.toLowerCase() + "xx");
}

export interface StmcuDetail {
  detailId: string;
  docId: string;
  title: string;
  /** 详情页 JS 里的 file_name。 */
  fileName: string;
  /** is_outside_file=1 时页面直接 window.open 的 CCC 匿名直链；没有就空串。 */
  cccUrl: string;
}

/** 节流 + 429 退避的页面抓取（stmcu 连打 3 次就 429，实测）。 */
async function politeGet(url: string, o: { fetchImpl: typeof fetch; ua: string; minGapMs: number; retryGapMs: number; lastAtRef: { t: number }; timeoutMs: number }): Promise<{ status: number; body: string } | null> {
  // 429 是这站的礼貌闸：连打必触发（实测 3 次即 429），所以退避要真等，重试上限 2 次。
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    const wait = attempt === 0 ? o.minGapMs - (Date.now() - o.lastAtRef.t) : o.retryGapMs * attempt;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), o.timeoutMs);
    try {
      const res = await o.fetchImpl(url, { signal: ac.signal, redirect: "follow", headers: { "User-Agent": o.ua, Referer: "https://www.stmcu.com.cn/design_resource" } });
      o.lastAtRef.t = Date.now();
      const body = await res.text();
      if (res.status === 429) { if (attempt < 2) continue; }
      return { status: res.status, body };
    } catch (error) {
      o.lastAtRef.t = Date.now();
      if (attempt === 2) return null;
      void error;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}
export interface RmChannelOptions {
  fetchImpl?: typeof fetch;
  cacheDir?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** stmcu 节流下限；单测传 0。 */
  minGapMs?: number;
  signal?: AbortSignal;
}

export interface RmAcquired {
  ok: boolean;
  channel: "sitemap" | "stmcu" | "";
  file: string;
  url: string;
  docId: string;
  sha256: string;
  bytes: number;
  /** 压平索引里出现过的线名（仅 EN PDF 可信，见文件头）。 */
  coverage: Record<string, boolean>;
  notes: string[];
  error: string;
}

function shaHex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function baseAcquired(): RmAcquired {
  return { ok: false, channel: "", file: "", url: "", docId: "", sha256: "", bytes: 0, coverage: {}, notes: [], error: "" };
}

/** 主通道：sitemap 目录 → 族匹配 → 下载 → 覆盖验证。 */
export async function acquireRmViaSitemap(family: string, line: string, o: RmChannelOptions = {}): Promise<RmAcquired> {
  const base = baseAcquired();
  const fetchImpl = o.fetchImpl ?? fetch;
  const catalog = await fetchRmCatalog({ fetchImpl, timeoutMs: o.timeoutMs ?? 30000 });
  if (catalog.entries.length === 0) {
    return { ...base, error: "sitemap 没拿到任何 reference_manual（网络或站点变了）：" + catalog.errors.slice(0, 3).join("；") };
  }
  const matched = matchRmForLine(catalog.entries, family, line);
  const picked = matched.picked;
  if (picked === null) {
    return { ...base, error: "RM 目录里找不到 " + family + " 族（目录 " + String(catalog.entries.length) + " 条，族名不匹配）" };
  }
  if (matched.candidates.length > 1) {
    base.notes.push("族匹配到 " + String(matched.candidates.length) + " 份 RM，按线名具体性选 " + picked.docId.toUpperCase() + "（其余：" + matched.candidates.slice(1, 4).map((c) => c.docId.toUpperCase()).join(",") + "）");
  }
  const cacheDir = o.cacheDir ?? path.join(factsRoot(o.env ?? process.env), "rm");
  const name = picked.docId + ".pdf";
  const outcome = await fetchOne(
    { path: name, urls: [picked.url], minBytes: 200000, markers: ["%PDF"] },
    cacheDir,
    { fetchImpl, timeoutMs: o.timeoutMs ?? 240000, signal: o.signal, stallMs: 20000, minBytesPerSec: 4096 },
  );
  if (!outcome.ok) return { ...base, error: "RM 下载失败（" + picked.docId.toUpperCase() + "）：" + outcome.error };
  const file = path.join(cacheDir, name);
  const buf = fs.readFileSync(file);
  const index = pdfCoverageIndex(buf);
  const coverage: Record<string, boolean> = {};
  for (const m of index.matchAll(/stm32[a-z]\d{3}xx/g)) coverage[String(m[0]).toUpperCase()] = true;
  const info = { channel: "sitemap" as const, file, url: picked.url, docId: picked.docId.toUpperCase(), sha256: shaHex(buf), bytes: buf.byteLength, coverage, notes: base.notes };
  if (!lineCovered(index, line)) {
    return { ...base, ...info, error: "下载成功但正文索引里找不到 " + line + "xx——这份 " + picked.docId.toUpperCase() + " 不覆盖该线（中文 CID PDF 也会出现这个结果，所以覆盖判定只信英文通道）" };
  }
  return { ...base, ...info, ok: true, error: "" };
}
/** 备案通道：stmcu 分类页 → 详情页 → CCC 直链（zh→en 翻译替换）→ 下载 → 覆盖验证。 */
export async function acquireRmViaStmcu(family: string, line: string, o: RmChannelOptions = {}): Promise<RmAcquired> {
  const base = baseAcquired();
  const fetchImpl = o.fetchImpl ?? fetch;
  const opts = {
    fetchImpl,
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
    minGapMs: o.minGapMs ?? 3000,
    retryGapMs: o.minGapMs === undefined ? 8000 : o.minGapMs,
    lastAtRef: { t: 0 },
    timeoutMs: o.timeoutMs ?? 30000,
  };
  const famName = "STM32" + family.slice(5).toUpperCase();
  const cat = await politeGet("https://www.stmcu.com.cn/Designresource/list/" + famName + "/document/reference_manual", opts);
  if (cat === null) return { ...base, error: "stmcu 分类页两次都没拿到（网络或限流）" };
  if (cat.status !== 200) return { ...base, error: "stmcu 分类页 HTTP " + String(cat.status) + "（连打会 429，需要更长的 minGapMs）" };
  const items = parseStmcuCategory(cat.body).filter((x) => x.title.toUpperCase().includes(famName));
  if (items.length === 0) return { ...base, error: "stmcu 分类页里没有 " + famName + " 的 RM（该页混入他族条目，已按标题里的族名筛过）" };
  const cacheDir = o.cacheDir ?? path.join(factsRoot(o.env ?? process.env), "rm");
  const tried: string[] = [];
  for (const item of items) {
    const det = await politeGet("https://www.stmcu.com.cn/Designresource/detail/document/" + item.detailId, opts);
    if (det === null || det.status !== 200) {
      tried.push(item.docId + "(detail HTTP " + (det === null ? "n/a" : String(det.status)) + ")");
      continue;
    }
    const d = parseStmcuDetail(det.body);
    if (d.cccUrl === "") {
      // token 端点匿名 303 跳 SSO（实测），没有 CCC 直链就下不动
      tried.push(item.docId + "(页面没有 CCC 直链；token 端点要登录)");
      continue;
    }
    // CCC 直链默认指中文译文：zh. → en. 换英文版（RM0490 实测 200、11,536,384 B）。
    const enUrl = d.cccUrl.replace("/translations/zh.", "/translations/en.");
    const name = item.docId.toLowerCase() + "-stmcu.pdf";
    const outcome = await fetchOne(
      { path: name, urls: [enUrl, d.cccUrl], minBytes: 200000, markers: ["%PDF"] },
      cacheDir,
      { fetchImpl, timeoutMs: o.timeoutMs ?? 240000, signal: o.signal, stallMs: 20000, minBytesPerSec: 4096 },
    );
    if (!outcome.ok) {
      tried.push(item.docId + "(" + outcome.error.slice(0, 60) + ")");
      continue;
    }
    const file = path.join(cacheDir, name);
    const buf = fs.readFileSync(file);
    const index = pdfCoverageIndex(buf);
    const coverage: Record<string, boolean> = {};
    for (const m of index.matchAll(/stm32[a-z]\d{3}xx/g)) coverage[String(m[0]).toUpperCase()] = true;
    const usedEn = outcome.url === enUrl;
    const info = { channel: "stmcu" as const, file, url: outcome.url, docId: item.docId.toUpperCase(), sha256: shaHex(buf), bytes: buf.byteLength, coverage, notes: ["备案通道 stmcu→CCC（" + (usedEn ? "英文译文" : "中文原版") + "）"] };
    if (!lineCovered(index, line)) {
      return { ...base, ...info, error: "stmcu 拿到的 " + item.docId.toUpperCase() + " 索引里找不到 " + line + "xx" + (usedEn ? "" : "（拿到的是中文 CID PDF，覆盖判定只信英文文本）") };
    }
    return { ...base, ...info, ok: true, error: "" };
  }
  return { ...base, error: "stmcu 通道的 " + String(items.length) + " 条候选都没取到可用 PDF：" + tried.join("；") };
}

/** 分类页 HTML → detail 条目（纯函数）。立创页混他族条目，族名要出现在标题里才算。 */
export function parseStmcuCategory(html: string): StmcuDetail[] {
  const out: StmcuDetail[] = [];
  for (const m of html.matchAll(/href="https:\/\/www\.stmcu\.com\.cn\/Designresource\/detail\/document\/(\d+)"[^>]*title="([^"]{4,140})"/g)) {
    const id = m[1] ?? "";
    const title = (m[2] ?? "").trim();
    const docId = (title.match(/RM\d{4}/i) ?? [""])[0].toUpperCase();
    if (docId === "" || id === "") continue;
    out.push({ detailId: id, docId, title, fileName: "", cccUrl: "" });
  }
  const seen = new Set<string>();
  return out.filter((x) => (seen.has(x.detailId) ? false : (seen.add(x.detailId), true)));
}

/** 详情页 HTML → file_name / is_outside_file / CCC 直链（纯函数）。 */
export function parseStmcuDetail(html: string): { fileName: string; cccUrl: string } {
  const fn = html.match(/var sla = \d+, file_name = "([^"]+)"/);
  const ccc = html.match(/window\.open\("(https:\/\/www\.st\.com\.cn\/content\/ccc\/resource[^"]+)"/);
  return { fileName: fn?.[1] ?? "", cccUrl: ccc?.[1] ?? "" };
}
