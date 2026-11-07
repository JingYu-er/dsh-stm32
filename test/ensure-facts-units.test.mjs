// ensureFacts 自愈：查不到书就当场写书（SVD+RM 载体+spec 语义抽取），全程离线注入。
// 运行：node --test test/ensure-facts-units.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as t } from "node:test";
import { fileURLToPath } from "node:url";
import { ensureFacts } from "../lib/engine/facts-acquire.js";
import { loadRmTopics, bundledTopicsDir } from "../lib/data/rm-topics.js";

const SVD_FIX = fileURLToPath(new URL("./fixtures/svd/stm32c031-excerpt.svd", import.meta.url));
const RM_FIX = fileURLToPath(new URL("./fixtures/rm/fake-en-rm.pdf", import.meta.url));
const SITEMAP_FIX = fileURLToPath(new URL("./fixtures/rm/sitemap-sample.xml", import.meta.url));
const svdText = fs.readFileSync(SVD_FIX, "utf8");
const rmBytes = fs.readFileSync(RM_FIX);
const sitemapText = fs.readFileSync(SITEMAP_FIX, "utf8");

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), "ensure-" + tag + "-"));

function bufResp(buf) {
  let done = false;
  return {
    status: 200, ok: true,
    headers: { get: () => null },
    text: async () => buf.toString("utf8"),
    body: { getReader: () => ({ read: async () => { if (done) return { done: true }; done = true; return { done: false, value: buf }; } }) },
  };
}

/** 假站点：sitemap、任意族 SVD、C0 载体 PDF（fake-en-rm 里只有 C011/031/051/071 线名）。
 * SVD 填充到 60 KB：acquireSvd 默认 minBytes=50000（真 SVD 都是 MB 级，太小判「不像真文件」），
 * 3 KB 的 fixture 原样喂会被护栏正确拒收——注释填充不改变解析结果。 */
const PADDED_SVD = svdText.replace("</device>", "<!-- " + "p".repeat(60_000) + " -->\n</device>");
function siteFetch() {
  return async (url) => {
    const u = String(url);
    if (u.includes("sitemap")) return bufResp(Buffer.from(sitemapText, "utf8"));
    const svd = u.match(/stm32[a-z0-9]+\/(STM32[A-Z0-9]+)\.svd/);
    if (svd !== null) return bufResp(Buffer.from(PADDED_SVD, "utf8"));
    if (u.includes("rm0490")) return bufResp(rmBytes);
    return { status: 404, ok: false, text: async () => "nf", body: null };
  };
}

/** 假 pymupdf 桥：按内置 C0 spec 的锚点/表格行现造页面文本（同源口径在真桥里由 pymupdf 保证）。 */
function specBridge() {
  const loaded = loadRmTopics("stm32c0", "STM32C051", tmp("read"));
  const byPage = new Map();
  for (const tp of loaded.topics) {
    const chunks = [...tp.anchors];
    for (const row of tp.rows ?? []) chunks.push(row.join(" "));
    const list = byPage.get(tp.page) ?? [];
    list.push(chunks.join("  "));
    byPage.set(tp.page, list);
  }
  return async (_pdf, pages) => ({
    ok: true,
    error: "",
    tried: [],
    pages: pages.filter((n) => byPage.has(n)).map((n) => ({ page: n, text: byPage.get(n).join(" ") })),
  });
}

t("自愈全流程：查无书 → 自动 SVD+载体+spec 抽取 → verified，二次调用不再建", async () => {
  const root = tmp("full");
  const env = { DSH_STM32_FACTS: root };
  const first = await ensureFacts("STM32C051C6T6", env, { allowNetwork: true, fetchImpl: siteFetch(), pdfTextBridge: specBridge() });
  assert.equal(first.built.attempted, true, "查无书必须动笔");
  assert.equal(first.built.ok, true, first.built.message);
  assert.equal(first.summary.found, true);
  assert.equal(first.summary.verified, true, "内置 C0 spec 在场，语义应被自动抽出：" + JSON.stringify(first.summary.needs));
  assert.ok(first.summary.semantics >= 9, "语义条数 " + String(first.summary.semantics));
  assert.equal(first.summary.hasSpec, true);
  assert.match(first.summary.rmPath, /rm0490\.pdf/u, "载体本地路径要暴露（反查入口）");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "stm32c0", "STM32C051", "facts.json"), "utf8"));
  const pdf = pkg.sources.find((s) => s.kind === "rm-pdf");
  assert.equal(pdf.origin, "auto:sitemap");
  const second = await ensureFacts("STM32C051C6T6", env, { allowNetwork: true, fetchImpl: siteFetch(), pdfTextBridge: specBridge() });
  assert.equal(second.built.attempted, false, "已 verified 不许重下");
});

t("没 spec 的芯片（F103）：书照建（SVD 成功、载体覆盖不过也没关系），found 但不拦烧", async () => {
  const root = tmp("nospec");
  const env = { DSH_STM32_FACTS: root };
  const r = await ensureFacts("STM32F103C8T6", env, { allowNetwork: true, fetchImpl: siteFetch(), pdfTextBridge: specBridge() });
  assert.equal(r.built.attempted, true);
  assert.equal(r.summary.hasSpec, false, "没有主题清单就不能拦用户");
  assert.equal(r.summary.found, true, "结构层照样落盘：" + r.built.message);
});

t("离线且无缓存：不炸，summary 是 found=false 的未生成态", async () => {
  const root = tmp("offline");
  const env = { DSH_STM32_FACTS: root };
  const r = await ensureFacts("STM32L412KBT6", env, { allowNetwork: false, svdRoots: [tmp("empty")] });
  assert.equal(r.built.attempted, true);
  assert.equal(r.built.ok, false);
  assert.equal(r.summary.found, false);
  assert.equal(r.summary.hasSpec, false);
});

t("pymupdf 桥坏了：有清单但抽不出 → needs 指「机检没过」，不是「没清单」", async () => {
  const root = tmp("bridgefail");
  const env = { DSH_STM32_FACTS: root };
  const deadBridge = async () => ({ ok: false, pages: [], error: "python 没装 pymupdf", tried: ["python → ModuleNotFound"] });
  const r = await ensureFacts("STM32C051C6T6", env, { allowNetwork: true, fetchImpl: siteFetch(), pdfTextBridge: deadBridge });
  assert.equal(r.summary.found, true, "结构层不受桥影响");
  assert.equal(r.summary.verified, false);
  assert.equal(r.summary.hasSpec, true, "内置清单在场");
  assert.ok(r.summary.needs.join(" ").includes("机检没过"), r.summary.needs.join("；"));
});
