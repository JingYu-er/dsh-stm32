import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseLcscPage } from "../lib/engine/datasheet/lcsc.js";
import { detectSections } from "../lib/engine/datasheet/digest.js";
import {
  ensureDatasheet,
  importDatasheetFile,
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
