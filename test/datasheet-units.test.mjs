import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseLcscPage } from "../lib/engine/datasheet/lcsc.js";
import { detectSections } from "../lib/engine/datasheet/digest.js";
import { parseProductList, searchParts } from "../lib/engine/datasheet/search.js";
import {
  ensureDatasheet,
  importDatasheetFile,
  pruneDatasheets,
  listDatasheets,
  readIndex,
  resolveDatasheetRef,
} from "../lib/engine/datasheet/store.js";

process.env["DSH_STM32_DS_MIN_GAP_MS"] = "0";

const PDF = Buffer.from("%PDF-1.5\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "latin1");

function pageHtml(code, pdfUrl) {
  return [
    "<html><head><title>0402WGF931JTCE | Chip Resistor | UNI-ROYAL | LCSC</title></head>",
    '<body><script id="__NEXT_DATA__" type="application/json">',
    '{"props":{"mpn":"0402WGF931JTCE","brandName":"UNI-ROYAL",',
    '"datasheet":"' + pdfUrl.replaceAll("/", "\\/") + '"}}',
    "</script></body></html>",
  ].join("");
}

function fetchScript(page, pdf) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith(".pdf") && !String(url).includes("product-detail")) {
      return { ok: true, status: 200, arrayBuffer: async () => pdf, text: async () => pdf.toString("latin1") };
    }
    return { ok: true, status: 200, text: async () => page, arrayBuffer: async () => Buffer.from(page) };
  };
  return { impl, calls };
}

test("详情页解析：转义斜杠也能取到直链与型号", () => {
  const html = pageHtml("C25137", "https://datasheet.lcsc.com/datasheet/pdf/0a975aaa.pdf");
  const parsed = parseLcscPage("C25137", html);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.product.pdfUrl, "https://datasheet.lcsc.com/datasheet/pdf/0a975aaa.pdf");
  assert.equal(parsed.product.mpn, "0402WGF931JTCE");
  assert.equal(parsed.product.brand, "UNI-ROYAL");
});

test("详情页没有手册链接时明确报错，不猜", () => {
  const parsed = parseLcscPage("C99999", "<html><head><title>X | Y</title></head></html>");
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /没有数据手册直链/u);
});

test("首次下载落盘，再次调用零网络（缓存命中）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ds-"));
  try {
    const page = pageHtml("C25137", "https://datasheet.lcsc.com/datasheet/pdf/0a975aaa.pdf");
    const first = fetchScript(page, PDF);
    const one = await ensureDatasheet("C25137", { cacheDir: dir, fetchImpl: first.impl });
    assert.equal(one.ok, true);
    assert.equal(one.cached, false);
    assert.equal(existsSync(one.file), true);
    assert.equal(first.calls.length, 2);
    const meta = JSON.parse(readFileSync(join(dir, "C25137", "meta.json"), "utf8"));
    assert.equal(meta.mpn, "0402WGF931JTCE");
    assert.equal(meta.bytes, PDF.length);

    const second = fetchScript(page, PDF);
    const two = await ensureDatasheet("lcsc:c25137", { cacheDir: dir, fetchImpl: second.impl });
    assert.equal(two.ok, true);
    assert.equal(two.cached, true);
    assert.equal(second.calls.length, 0);
    assert.equal(resolveDatasheetRef(dir, "0402WGF931JTCE")?.entry.code, "C25137");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("抓取失败写负缓存，24 小时内不重试", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ds-"));
  try {
    let calls = 0;
    const impl = async () => {
      calls += 1;
      return { ok: false, status: 500, text: async () => "", arrayBuffer: async () => Buffer.alloc(0) };
    };
    const one = await ensureDatasheet("C84256", { cacheDir: dir, fetchImpl: impl });
    assert.equal(one.ok, false);
    assert.match(one.error, /HTTP 500/u);
    const before = calls;
    const two = await ensureDatasheet("C84256", { cacheDir: dir, fetchImpl: impl });
    assert.equal(two.ok, false);
    assert.match(two.error, /24 小时内抓取失败过/u);
    assert.equal(calls, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("离线模式只读缓存", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ds-"));
  try {
    const impl = async () => {
      throw new Error("should not be called");
    };
    const result = await ensureDatasheet("C25137", { cacheDir: dir, fetchImpl: impl, offline: true });
    assert.equal(result.ok, false);
    assert.match(result.error, /离线模式/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("手工导入一份 PDF 也能进缓存", () => {
  const dir = mkdtempSync(join(tmpdir(), "ds-"));
  try {
    const source = join(dir, "manual.pdf");
    writeFileSync(source, PDF);
    const imported = importDatasheetFile(dir, source, "C11702", "NCD0805R1");
    assert.equal(imported.ok, true);
    assert.equal(imported.entry.code, "C11702");
    const listing = listDatasheets(dir);
    assert.equal(listing.entries.length, 1);
    assert.equal(readIndex(dir).entries["C11702"].mpn, "NCD0805R1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("关键页索引：从章节标题认引脚/额定/电气/时序/封装（S121）", () => {
  const pages = [
    { page: 1, text: "General description\nPin configuration\nPA1  GPIO" },
    { page: 3, text: "5.2 Absolute Maximum Ratings\nVDD -0.3 to 6.0 V" },
    { page: 4, text: "7 Electrical Characteristics\nIDD 1.2 mA" },
    { page: 6, text: "8.1 Timing Characteristics\nSCL 100 kHz" },
    { page: 9, text: "10 Package Outline\nSOT-23-6" },
  ];
  const sections = detectSections(pages);
  assert.deepEqual(sections.map((item) => item.kind), [
    "pinout",
    "absolute-maximum",
    "electrical",
    "timing",
    "package",
  ]);
  assert.equal(sections[1].page, 3);
  assert.match(sections[1].heading, /Absolute Maximum Ratings/u);
});

test("关键页索引：正文里提到关键词不算章节，不误报", () => {
  const pages = [
    { page: 2, text: "The device has a pin configuration that is described below in the following section of this document, please read" },
  ];
  assert.deepEqual(detectSections(pages), []);
});

test("清理入口：按编号删、按天数删，都返回释放的字节（S124）", () => {
  const dir = mkdtempSync(join(tmpdir(), "ds-"));
  try {
    const source = join(dir, "a.pdf");
    writeFileSync(source, PDF);
    assert.equal(importDatasheetFile(dir, source, "C11702", "NCD0805R1").ok, true);
    assert.equal(importDatasheetFile(dir, source, "C25137", "0402WGF931JTCE").ok, true);
    const pruned = pruneDatasheets(dir, { remove: ["C11702", "C99999"] });
    assert.equal(pruned.ok, true);
    assert.deepEqual(pruned.removed.map((item) => item.code), ["C11702"]);
    assert.ok(pruned.bytes > 0, "要报出释放的字节数");
    assert.ok(pruned.notes.some((note) => note.includes("C99999")), "不存在的编号要说明");
    assert.deepEqual(pruned.kept, ["C25137"]);
    assert.equal(listDatasheets(dir).entries.length, 1);
    const fresh = pruneDatasheets(dir, { olderThanDays: 1 });
    assert.deepEqual(fresh.removed, [], "刚导入的条目不该被天数清掉");
    const index = readIndex(dir);
    index.entries["C25137"].fetchedAt = "2020-01-01T00:00:00.000Z";
    writeFileSync(join(dir, "index.json"), JSON.stringify(index), "utf8");
    const byAge = pruneDatasheets(dir, { olderThanDays: 1 });
    assert.deepEqual(byAge.removed.map((item) => item.code), ["C25137"], "改了抓取时间的旧条目按天数删");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("器件搜索：按接口字段削成 PartHit，缓存命中就不联网，错误码给人话（S163）", async () => {
  const payload = {
    code: 200,
    result: {
      totalCount: 7,
      productList: [
        {
          productCode: "C8734",
          productModel: "STM32F103C8T6",
          brandNameEn: "ST",
          encapStandard: null,
          stockNumber: 6000,
          minBuyNumber: 1,
          productPriceList: [
            { ladder: 100, usdPrice: 0.85 },
            { ladder: 1, usdPrice: 0.9402 },
          ],
          pdfUrl: "https://example.test/a.pdf",
          thirdWmCatalogNameEn: "MCU",
        },
        { productCode: "not-a-code", productModel: "x" },
      ],
    },
  };
  const parsed = parseProductList(payload);
  assert.equal(parsed.total, 7);
  assert.equal(parsed.hits.length, 1, "编号不像 C 开头的行要丢掉");
  const hit = parsed.hits[0];
  assert.equal(hit.code, "C8734");
  assert.equal(hit.packageName, "", "接口不给封装就留空，不拿型号猜");
  assert.equal(hit.priceUsd, 0.9402, "阶梯价取最小起订档");
  assert.deepEqual(hit.ladder.map((step) => step.qty), [1, 100]);

  const dir = mkdtempSync(join(tmpdir(), "dsh-search-"));
  try {
    const cacheFile = join(dir, "part-search.json");
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    };
    const first = await searchParts("C8734", { limit: 8, cacheFile, fetchImpl, now: () => 1_000_000 });
    assert.equal(first.ok, true, first.error);
    assert.equal(first.cached, false);
    assert.equal(calls, 1);
    assert.equal(existsSync(cacheFile), true);

    const second = await searchParts("C8734", { limit: 8, cacheFile, fetchImpl, now: () => 1_000_100 });
    assert.equal(second.cached, true, "24 小时内同一查询走缓存");
    assert.equal(calls, 1, "命中缓存不能再联网");

    const refreshed = await searchParts("C8734", { limit: 8, cacheFile, fetchImpl, now: () => 1_000_200, noCache: true });
    assert.equal(refreshed.cached, false);
    assert.equal(calls, 2, "noCache 要绕开缓存");

    const badCode = await searchParts("C8734", {
      limit: 8,
      cacheFile,
      now: () => 2_000_000,
      noCache: true,
      fetchImpl: async () => new Response(JSON.stringify({ code: 404, msg: "The static resource is unavailable." }), { status: 200 }),
    });
    assert.equal(badCode.ok, false);
    assert.match(badCode.error, /错误码 404/u);
    assert.match(badCode.error, /static resource/u);

    const empty = await searchParts("   ");
    assert.equal(empty.ok, false);
    assert.match(empty.error, /关键词不能为空/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
