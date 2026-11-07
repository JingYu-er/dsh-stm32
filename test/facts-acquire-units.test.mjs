// facts 获取自动化（SVD 本地→缓存→下载、RM 载体登记、缺语义降级）离线单测。
// 网络一律注入假 fetch；不碰真上游。运行：node --test test/facts-acquire-units.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as t } from "node:test";
import { fileURLToPath } from "node:url";
import { acquireSvd, acquireRm, buildFacts, svdSourceUrls, SVD_REPO, SVD_REF, FACTS_REGISTERS } from "../lib/engine/facts-acquire.js";
import { readFactsFor } from "../lib/engine/facts.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/svd/stm32c031-excerpt.svd", import.meta.url));
const RMFIX = fileURLToPath(new URL("./fixtures/rm-facts-c0.json", import.meta.url));
const fixtureText = fs.readFileSync(FIXTURE, "utf8");

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), "facts-" + tag + "-"));
}

/** 假 fetch：按 URL 返回内容；对 jsDelivr 首个候选返回 404，验证换源。 */
function fakeFetch(body, { failFirst = 0 } = {}) {
  let n = 0;
  return async (url) => {
    n += 1;
    if (n <= failFirst) return { ok: false, status: 404, body: null };
    const buf = Buffer.from(body);
    let done = false;
    return {
      ok: true,
      status: 200,
      body: { getReader: () => ({ read: async () => { if (done) return { done: true }; done = true; return { done: false, value: buf }; } }) },
    };
  };
}

t("svdSourceUrls：四候选、仓名与 ref 来自实测常量", () => {
  const urls = svdSourceUrls("stm32c0/STM32C031.svd");
  assert.equal(urls.length, 4);
  assert.match(urls[0], /fastly\.jsdelivr\.net\/gh\//);
  assert.ok(urls.every((u) => u.includes(SVD_REPO) && u.includes(SVD_REF)), "每条 URL 都指向 " + SVD_REPO + "@" + SVD_REF);
  assert.ok(urls[2].includes("raw.githubusercontent.com"));
});

t("acquireSvd：显式 --svd 文件命中本地，sha256 与内容一致", async () => {
  const r = await acquireSvd("STM32C031F6P6", { svdPath: FIXTURE, allowNetwork: false });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.source, "local");
  assert.equal(r.file, FIXTURE);
  assert.equal(r.sha256, createHash("sha256").update(fixtureText).digest("hex"));
  assert.ok(FACTS_REGISTERS.every((reg) => r.structure[reg] !== undefined), "三寄存器都要解析出来");
});

t("acquireSvd：svdRoots 按 <族>/<线>.svd 布局找；找不到就明说，不编内容", async () => {
  const root = tmpDir("root");
  fs.mkdirSync(path.join(root, "stm32c0"), { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(root, "stm32c0", "STM32C031.svd"));
  const hit = await acquireSvd("STM32C031F6P6", { svdRoots: [root], allowNetwork: false });
  assert.equal(hit.ok, true, hit.error);
  assert.equal(hit.source, "local");
  // 独立空缓存：默认缓存可能已被之前的真实下载填上（那正是离线复用要测的另一条用例），这里要验"哪都没有"
  const miss = await acquireSvd("STM32C051C6T6", { svdRoots: [root], cacheDir: tmpDir("miss"), allowNetwork: false });
  assert.equal(miss.ok, false);
  assert.match(miss.error, /联网被禁|离线/u);
  assert.ok(miss.attempts.some((a) => a.includes("STM32C051.svd") && a.includes("不存在")), "要说清试过哪个路径");
});

t("acquireSvd：本地没有 → 下载缓存命中（写盘后二次调用不再联网）", async () => {
  const cache = tmpDir("cache");
  let calls = 0;
  const countingFetch = async (url) => { calls += 1; return fakeFetch(fixtureText)(url); };
  const first = await acquireSvd("STM32C031F6P6", { cacheDir: cache, allowNetwork: true, fetchImpl: countingFetch, minBytes: 100, svdRoots: [] });
  assert.equal(first.ok, true, first.error + " " + first.attempts.join(";"));
  assert.equal(first.source, "remote");
  assert.equal(calls, 1, "第一次只请求一条候选就成了（首源 200）");
  const second = await acquireSvd("STM32C031F6P6", { cacheDir: cache, allowNetwork: true, fetchImpl: async () => { throw new Error("不该再联网"); }, svdRoots: [] });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.source, "local", "第二次必须走 <facts>/svd 缓存");
});

t("acquireSvd：首候选 404 自动换源；全挂时把每个源的原因列出来", async () => {
  const cache = tmpDir("swap");
  const ok = await acquireSvd("STM32C031F6P6", { cacheDir: cache, allowNetwork: true, fetchImpl: fakeFetch(fixtureText, { failFirst: 1 }), minBytes: 100, svdRoots: [] });
  assert.equal(ok.ok, true, ok.error);
  assert.ok(ok.attempts.some((a) => a.includes("HTTP 404")), "换源轨迹要能看见");
  const dead = await acquireSvd("STM32L412KBT6", { cacheDir: tmpDir("dead"), allowNetwork: true, fetchImpl: fakeFetch("<html>blocked</html>"), minBytes: 100, svdRoots: [] });
  assert.equal(dead.ok, false);
  assert.match(dead.error, /所有源都没下下来/u);
});

t("acquireRm：rm-facts 正常读入；坏 JSON 记 error 但不炸", async () => {
  const good = await acquireRm({ rmFactsPath: RMFIX });
  assert.equal(good.items.length, 7);
  assert.equal(good.doc.id, "RM0490");
  assert.equal(good.error, "");
  const bad = tmpDir("bad");
  const f = path.join(bad, "rm.json");
  fs.writeFileSync(f, "{oops");
  const r = await acquireRm({ rmFactsPath: f });
  assert.match(r.error, /rm-facts 读不了/u);
  assert.equal(r.items.length, 0);
});

t("buildFacts：SVD + rm-facts → schema2、sources 双类、needs 空；readFactsFor 判定已验证", async () => {
  const facts = tmpDir("full");
  const rep = await buildFacts({ part: "STM32C031F6P6", svdPath: FIXTURE, rmFactsPath: RMFIX, outDir: path.join(facts, "stm32c0", "STM32C031"), env: { DSH_STM32_FACTS: facts }, allowNetwork: false });
  assert.equal(rep.ok, true, rep.message);
  assert.equal(rep.semantics, 7);
  assert.deepEqual(rep.needs, []);
  assert.equal(rep.family, "STM32C0");
  const kinds = rep.sources.map((s) => s.kind);
  assert.ok(kinds.includes("svd") && kinds.includes("rm-facts"), kinds.join(","));
  const pkg = JSON.parse(fs.readFileSync(path.join(facts, "stm32c0", "STM32C031", "facts.json"), "utf8"));
  assert.equal(pkg.schema, 2);
  assert.equal(pkg.rmDoc.id, "RM0490");
  const sum = readFactsFor("STM32C031F6P6", { DSH_STM32_FACTS: facts });
  assert.equal(sum.found, true);
  assert.equal(sum.verified, true);
  assert.equal(sum.semantics, 7);
});

t("buildFacts：缺 rm-facts → 降级：semantics=0、needs 指路、readFactsFor 只读", async () => {
  const facts = tmpDir("degraded");
  const rep = await buildFacts({ part: "STM32C031F6P6", svdPath: FIXTURE, outDir: path.join(facts, "stm32c0", "STM32C031"), env: { DSH_STM32_FACTS: facts }, allowNetwork: false });
  assert.equal(rep.ok, true, rep.message);
  assert.equal(rep.semantics, 0);
  assert.equal(rep.needs.length, 1);
  assert.match(rep.needs[0], /RM 手册与 rm-facts 抽取/u);
  const sum = readFactsFor("STM32C031F6P6", { DSH_STM32_FACTS: facts });
  assert.equal(sum.verified, false, "flash 门禁据此拒绝");
  assert.match(sum.needs[0], /rm-facts/u, "needs 从 pkg.needs 读回");
});

t("buildFacts：SVD 完全拿不到 → 失败并列出尝试，不写 facts.json", async () => {
  const facts = tmpDir("nosvd");
  const rep = await buildFacts({ part: "STM32C051C6T6", svdRoots: [tmpDir("empty")], outDir: path.join(facts, "stm32c0", "STM32C051"), env: { DSH_STM32_FACTS: facts }, allowNetwork: false });
  assert.equal(rep.ok, false);
  assert.match(rep.message, /SVD/u);
  assert.equal(fs.existsSync(path.join(facts, "stm32c0", "STM32C051", "facts.json")), false);
});

t("buildFacts：rm-facts 声明只覆盖 C011/C031，套到 C051 → 语义拒收、needs 指路", async () => {
  const facts = tmpDir("lines");
  const rep = await buildFacts({ part: "STM32C051C6T6", svdPath: FIXTURE, rmFactsPath: RMFIX, outDir: path.join(facts, "stm32c0", "STM32C051"), env: { DSH_STM32_FACTS: facts }, allowNetwork: false });
  assert.equal(rep.ok, true, rep.message);
  assert.equal(rep.semantics, 0, "doc.lines 不含 STM32C051，7 条语义必须全部拒收");
  assert.ok(rep.needs.some((n) => n.includes("不含 STM32C051")), rep.needs.join("|"));
  const sum = readFactsFor("STM32C051C6T6", { DSH_STM32_FACTS: facts });
  assert.equal(sum.verified, false, "flash 门禁据此拒绝烧录");
  // 显式 --rm-lines 覆盖同一份 rm-facts 时可以采信（给 C031 用）
  const ok31 = await buildFacts({ part: "STM32C031F6P6", svdPath: FIXTURE, rmFactsPath: RMFIX, rmLines: ["STM32C031"], outDir: path.join(facts, "stm32c0", "STM32C031"), env: { DSH_STM32_FACTS: facts }, allowNetwork: false });
  assert.equal(ok31.semantics, 7);
});

t("readFactsFor：没有 facts → needs 指向 build-facts CLI", () => {
  const sum = readFactsFor("STM32H563MKIP", { DSH_STM32_FACTS: tmpDir("none") });
  assert.equal(sum.found, false);
  assert.match(sum.needs[0], /build-facts\.mjs --part STM32H563MKIP/u);
});
