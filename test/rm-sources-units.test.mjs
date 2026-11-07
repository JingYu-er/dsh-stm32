// RM 载体双通道（sitemap 主源 + stmcu 备案）与覆盖验证的离线单测。
// 全部注入假 fetch/本地 fixture，不碰真站点。运行：node --test test/rm-sources-units.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as t } from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseRmSitemap, matchRmForLine, fetchRmCatalog,
  extractPdfLatinText, normalizePdfText, pdfCoverageIndex, lineCovered,
  parseStmcuCategory, parseStmcuDetail,
  acquireRmViaSitemap, acquireRmViaStmcu,
} from "../lib/engine/rm-sources.js";

const FIX = (n) => fileURLToPath(new URL("./fixtures/rm/" + n, import.meta.url));
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), "rm-" + tag + "-"));

function fakeFetchWith(routes) {
  return async (url) => {
    for (const [pat, resp] of routes) {
      if (String(url).includes(pat)) {
        // 响应体流是一次性的：必须每次新建（旧版复用同一 bodyResp，第二次读到的就是空）
        return typeof resp === "function" ? resp(url) : bodyRespOf(resp);
      }
    }
    return { status: 404, ok: false, text: async () => "not found", body: null };
  };
}
/** resp 描述转成新鲜响应：字符串/Buffer 每次重包，对象（如 500）原样但 text 也重置。 */
function bodyRespOf(resp) {
  if (typeof resp === "string") return bodyResp(Buffer.from(resp, "utf8"));
  if (Buffer.isBuffer(resp)) return bodyResp(resp);
  return resp;
}
const bodyResp = (bufOrStr, status = 200) => {
  const buf = typeof bufOrStr === "string" ? Buffer.from(bufOrStr, "latin1") : bufOrStr;
  let done = false;
  return {
    status, ok: status >= 200 && status < 400,
    headers: { get: () => null },
    text: async () => buf.toString("utf8"),
    body: { getReader: () => ({ read: async () => { if (done) return { done: true }; done = true; return { done: false, value: buf }; } }) },
  };
};

t("parseRmSitemap：只认英文 reference_manual，抽 docId 与 tokens", () => {
  const list = parseRmSitemap(fs.readFileSync(FIX("sitemap-sample.xml"), "utf8"));
  assert.equal(list.length, 4, "6 条 pdf 里去掉 ja 版与 application_note");
  const c0 = list.find((x) => x.docId === "rm0490");
  assert.ok(c0 && c0.url.includes("resource/en/reference_manual"));
  assert.ok(c0.tokens.includes("stm32c0"), "tokens: " + c0.tokens.join(","));
});


t("matchRmForLine：C0 选 rm0490；L412 优先带线名的 rm0394 而不是 l4-series；F1 匹配 103xx", () => {
  const cat = parseRmSitemap(fs.readFileSync(FIX("sitemap-sample.xml"), "utf8"));
  const c0 = matchRmForLine(cat, "stm32c0", "STM32C051");
  assert.equal(c0.picked?.docId, "rm0490");
  const l412 = matchRmForLine(cat, "stm32l4", "STM32L412");
  assert.equal(l412.picked?.docId, "rm0394", "线名具体性必须赢过族级 series");
  assert.equal(l412.candidates.length, 2);
  const f1 = matchRmForLine(cat, "stm32f1", "STM32F103");
  assert.equal(f1.picked?.docId, "rm0008");
  const wb = matchRmForLine(cat, "stm32wb", "STM32WB55");
  assert.equal(wb.picked, null, "目录里没有就明说不匹配，不瞎选");
});

t("fetchRmCatalog：多张 sitemap 合并去重；单张坏不影响其余", async () => {
  const xml = fs.readFileSync(FIX("sitemap-sample.xml"), "utf8");
  const routes = [
    ["sitemap1.xml", xml],
    ["sitemap2.xml", { status: 500, ok: false, text: async () => "", body: null }],
    ["sitemap3.xml", xml],
  ];
  const r = await fetchRmCatalog({ fetchImpl: fakeFetchWith(routes), pages: 3 });
  assert.equal(r.entries.length, 4, "两好一坏去重后 4 条");
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /sitemap2 HTTP 500/);
});

t("extractPdfLatinText：kerning 小数不插空格、大间距负数才插（跨碎裂片段）", () => {
  const txt = extractPdfLatinText(fs.readFileSync(FIX("fake-en-rm.pdf")));
  const norm = normalizePdfText(txt);
  const flat = norm.replace(/[^a-z0-9]/g, "");
  assert.ok(norm.includes("addressing"), "TJ 内 kerning 小间距(-5) 不能变空格：" + JSON.stringify(norm));
  assert.ok(norm.includes("wide ok"), "≥200 的数组间距要还原成空格（旧实现判反了这个分支）");
  assert.ok(norm.includes("table 3"), "Table 与 3 之间的大间距保留成词边界");
  assert.ok(flat.includes("bootlock") && flat.includes("nbootsel") && flat.includes("dbgswen"), "下划线常量压平后可查：" + flat);
  assert.ok(flat.includes("0x08192a3b"), "OPTKEY 常数必须能原样压平命中");
  assert.ok(flat.includes("stm32c071xx"));
});

t("coverage：EN fixture 六线里 4 线可判；中文 CID fixture 判不出（只信英文的根据）", () => {
  const en = pdfCoverageIndex(fs.readFileSync(FIX("fake-en-rm.pdf")));
  assert.ok(lineCovered(en, "STM32C011"));
  assert.ok(lineCovered(en, "STM32C051"));
  assert.ok(lineCovered(en, "STM32C071"));
  assert.ok(!lineCovered(en, "STM32C091"), "fixture 没写的线不能误判有");
  const zh = pdfCoverageIndex(fs.readFileSync(FIX("fake-zh-rm.pdf")));
  assert.ok(!lineCovered(zh, "STM32C051"), "CID 八位组文本抽不出线名 → 覆盖判定对中文 PDF 必然保守");
});

t("parseStmcuCategory/parseStmcuDetail：按 RM 号筛、detailId 去重、CCC 直链与 file_name", () => {
  const items = parseStmcuCategory(fs.readFileSync(FIX("stmcu-category-sample.html"), "utf8"));
  assert.equal(items.length, 3, "两条 RM0490 + 一条 RM0434；无 RM 号的 CubeMonitor 被滤掉");
  assert.equal(items[0].detailId, "711523");
  assert.equal(new Set(items.map((x) => x.detailId)).size, 3);
  const d = parseStmcuDetail(fs.readFileSync(FIX("stmcu-detail-sample.html"), "utf8"));
  assert.equal(d.fileName, "en.DM00781702.pdf");
  assert.match(d.cccUrl, /st\.com\.cn\/content\/ccc\/.*translations\/zh\.DM00781702\.pdf$/);
});

t("acquireRmViaSitemap：目录→下载→覆盖验证成功；下载内容不覆盖该线时失败且带哈希", async () => {
  const xml = fs.readFileSync(FIX("sitemap-sample.xml"), "utf8");
  const pdfBuf = fs.readFileSync(FIX("fake-en-rm.pdf"));
  const routes = [["sitemap", xml], ["rm0490-stm32c0", pdfBuf]];
  const cache = tmp("sm");
  const r = await acquireRmViaSitemap("stm32c0", "STM32C051", { fetchImpl: fakeFetchWith(routes), cacheDir: cache });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.channel, "sitemap");
  assert.equal(r.docId, "RM0490");
  assert.equal(r.bytes, pdfBuf.length);
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  assert.ok(r.coverage.STM32C051XX);
  // 不覆盖的线：失败但哈希/file 都留着
  const r2 = await acquireRmViaSitemap("stm32c0", "STM32C091", { fetchImpl: fakeFetchWith(routes), cacheDir: tmp("sm2") });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /找不到 STM32C091xx/);
  assert.equal(r2.bytes, pdfBuf.length);
});

t("acquireRmViaStmcu：分类→详情→zh 直链改写 en→覆盖通过；CCC 缺失时列出尝试", async () => {
  const catHtml = fs.readFileSync(FIX("stmcu-category-sample.html"), "utf8");
  const detHtml = fs.readFileSync(FIX("stmcu-detail-sample.html"), "utf8");
  const pdfBuf = fs.readFileSync(FIX("fake-en-rm.pdf"));
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("list/STM32C0/document")) return bodyResp(catHtml);
    if (String(url).includes("detail/document/711523")) return bodyResp(detHtml);
    if (String(url).includes("translations/en.")) return bodyResp(pdfBuf);
    return bodyResp("", 404);
  };
  const r = await acquireRmViaStmcu("stm32c0", "STM32C051", { fetchImpl, cacheDir: tmp("st"), minGapMs: 0 });
  assert.equal(r.ok, true, r.error + " | calls=" + calls.join(" ; "));
  assert.equal(r.channel, "stmcu");
  assert.ok(calls.some((u) => u.includes("translations/en.")), "必须优先英文译文");
  // 他族混入要按族名筛掉：F1 页里没有 C0 条目时明确失败
  const r2 = await acquireRmViaStmcu("stm32f1", "STM32F103", { fetchImpl: async () => bodyResp(detHtml, 200), cacheDir: tmp("st2"), minGapMs: 0 });
  assert.equal(r2.ok, false);
});

t("stmcu 通道：详情页第一次 429、退避后第二次成功 → 全流程走通", async () => {
  const catHtml = fs.readFileSync(FIX("stmcu-category-sample.html"), "utf8");
  const detHtml = fs.readFileSync(FIX("stmcu-detail-sample.html"), "utf8");
  const pdfBuf = fs.readFileSync(FIX("fake-en-rm.pdf"));
  let detHits = 0;
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("list/STM32C0/document")) return bodyResp(catHtml);
    if (u.includes("detail/document/")) { detHits += 1; return detHits === 1 ? { status: 429, ok: false, text: async () => "slow", body: null } : bodyResp(detHtml); }
    if (u.includes("translations/en.")) return bodyResp(pdfBuf);
    return { status: 404, ok: false, text: async () => "", body: null };
  };
  const r = await acquireRmViaStmcu("stm32c0", "STM32C051", { fetchImpl, cacheDir: tmp("retry"), minGapMs: 0 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.channel, "stmcu");
});

t("politeGet 行为经 stmcu 通道验证：429 退避重试两次，第三次仍 429 就报人话", async () => {
  let n = 0;
  const fetchImpl = async () => { n += 1; return { status: 429, ok: false, text: async () => "slow down", body: null }; };
  const r = await acquireRmViaStmcu("stm32c0", "STM32C031", { fetchImpl, cacheDir: tmp("429"), minGapMs: 0 });
  assert.equal(r.ok, false);
  assert.match(r.error, /HTTP 429/);
  assert.equal(n, 3, "重试共两次封顶，不能无限打");
});
