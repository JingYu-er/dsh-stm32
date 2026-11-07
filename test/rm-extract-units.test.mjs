// rm-extract 双机检离线单测：引文/表格回查 + SVD 交叉。运行：node --test test/rm-extract-units.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test as t } from "node:test";
import { fileURLToPath } from "node:url";
import { extractRmFacts, assembleRmFacts, normalizedPage, normQuote } from "../lib/engine/rm-extract.js";

// 微型语料：一条真命中的页 + 一条他页干扰
const PAGES = [
  { page: 53, text: "The user can select the boot area through the boot configuration pin BOOT0 and bits\nnBOOT1, nBOOT_SEL, and nBOOT0\nof the User option byte.\n0 x 0 0 x Main flash\n0 1 1 0 x System memory\nBOOT_LOCK bit forces boot" },
  { page: 90, text: "Bits 7:0 RDP[7:0]: Read protection level\n0xAA: Level 0, read protection not active\n0xCC: Level 2, chip read protection active\nOther: Level 1, memories read protection active" },
];
const SVDS = {
  STM32C031: { FLASH_OPTR: { description: "", fields: [{ name: "NBOOT_SEL", bitOffset: 24, bitWidth: 1, description: "", enums: [] }, { name: "NBOOT0", bitOffset: 26, bitWidth: 1, description: "", enums: [] }, { name: "RDP", bitOffset: 0, bitWidth: 8, description: "", enums: [{ value: "0xAA", description: "" }, { value: "0xCC", description: "" }] }] }, FLASH_SECR: { description: "", fields: [{ name: "BOOT_LOCK", bitOffset: 16, bitWidth: 1, description: "", enums: [{ value: "0x0", description: "" }, { value: "0x1", description: "" }] }] } },
  // C071 是小写名 —— 交叉必须大小写不敏感
  STM32C071: { FLASH_OPTR: { description: "", fields: [{ name: "nBOOT_SEL", bitOffset: 24, bitWidth: 1, description: "", enums: [] }, { name: "nBOOT0", bitOffset: 26, bitWidth: 1, description: "", enums: [] }, { name: "RDP", bitOffset: 0, bitWidth: 8, description: "", enums: [{ value: "0xAA", description: "" }, { value: "0xCC", description: "" }] }] }, FLASH_SECR: { description: "", fields: [{ name: "BOOT_LOCK", bitOffset: 16, bitWidth: 1, description: "", enums: [{ value: "0x0", description: "" }, { value: "0x1", description: "" }] }] } },
  // 缺 BOOT_LOCK 的坏线：交叉应剔除
  STM32C999: { FLASH_OPTR: { description: "", fields: [{ name: "RDP", bitOffset: 0, bitWidth: 8, description: "", enums: [] }] } },
};
const baseSpec = (over = {}) => ({
  family: "STM32C0",
  lines: ["STM32C031", "STM32C071", "STM32C999"],
  doc: { id: "RM0490", rev: "Rev 6" },
  topics: [{
    id: "c0.boot.table",
    statement: "自举区域由 BOOT_LOCK/nBOOT1/BOOT0/nBOOT_SEL/nBOOT0 选择",
    page: 53,
    anchors: ["select the boot area through the boot configuration pin BOOT0"],
    rows: [["0", "x", "0", "0", "x", "Main flash"], ["0", "1", "1", "0", "x", "System memory"]],
    svd: [{ reg: "FLASH_OPTR", field: "NBOOT_SEL", bitOffset: 24 }, { reg: "FLASH_SECR", field: "BOOT_LOCK", bitOffset: 16 }],
    ...over.topics,
  }],
  ...over,
});

t("正样本：锚点+表格+SVD 全过；C071 小写字段名照样命中、缺件的 C999 被剔出 appliesTo", () => {
  const rep = extractRmFacts(baseSpec(), PAGES, SVDS);
  assert.equal(rep.rejected.length, 0, rep.rejected.map((x) => x.reason).join(";"));
  const it = rep.items[0];
  assert.deepEqual(it.appliesTo, ["STM32C031", "STM32C071"]);
  assert.equal(it.source.page, 53);
  assert.ok(it.evidence.quote.startsWith("select the boot area"), "引文从锚点起：" + it.evidence.quote.slice(0, 40));
  assert.equal(it.table.length, 2);
});

t("锚点被改一个字 → 整条拒收（伪造结论进不来）", () => {
  const rep = extractRmFacts(baseSpec({ topics: [{ id: "x", statement: "s", page: 53, anchors: ["select the boot area throught the boot configuration pin BOOT0"] }] }), PAGES, SVDS);
  assert.equal(rep.items.length, 0);
  assert.match(rep.rejected[0].reason, /逐字回查没过/);
});

t("旧推断说法（SYSCLK 第 4 上升沿）在 EN 语料里没有锚点 → 拒收", () => {
  const rep = extractRmFacts(baseSpec({ topics: [{ id: "c0.boot.latch", statement: "锁存", page: 53, anchors: ["latched on the 4th rising edge of SYSCLK"] }] }), PAGES, SVDS);
  assert.match(rep.rejected[0].reason, /逐字回查没过/);
});

t("表格行被篡改（System memory 改成 Main flash）→ 逐行回查拒收", () => {
  const rep = extractRmFacts(baseSpec({
    topics: [{ id: "t", statement: "s", page: 53, anchors: ["select the boot area through the boot configuration pin BOOT0"], rows: [["0", "1", "1", "0", "x", "Main flash"]] }],
  }), PAGES, SVDS);
  assert.match(rep.rejected[0].reason, /表格有 1 行/);
});

t("SVD 位偏移对不上 → 全线剔除、条目拒收", () => {
  const rep = extractRmFacts(baseSpec({
    topics: [{ id: "rdp", statement: "s", page: 90, anchors: ["Other: Level 1"], svd: [{ reg: "FLASH_OPTR", field: "RDP", bitOffset: 8 }] }],
  }), PAGES, SVDS);
  assert.equal(rep.items.length, 0);
  assert.match(rep.rejected[0].reason, /SVD 交叉/);
  assert.ok(rep.lineNotes.every((n) => n.dropped.some((d) => d.includes("位不对(0≠8)"))));
});

t("页窗口：锚点在 p50/p53 都算命中，source.page 记实际页；p60 单独有也不算", () => {
  const pages = [{ page: 50, text: "select the boot area through the boot configuration pin BOOT0 here" }, { page: 60, text: "select the boot area through the boot configuration pin BOOT0 far" }];
  const rep = extractRmFacts(baseSpec({ topics: [{ id: "t", statement: "s", page: 53, anchors: ["select the boot area through the boot configuration pin BOOT0"] }] }), pages, SVDS);
  assert.equal(rep.items[0].source.page, 50, "窗口内先按离期望页近的排序：50 与 56 都进窗，只有 50 有锚点");
});

t("多锚点：两个都必须出现（防单锚词巧合）", () => {
  const rep = extractRmFacts(baseSpec({ topics: [{ id: "t", statement: "s", page: 53, anchors: ["select the boot area", "this phrase is nowhere in the manual"] }] }), PAGES, SVDS);
  assert.equal(rep.rejected.length, 1);
});

t("assembleRmFacts：doc.lines = 条目适用线并集，dedup 排序稳定", () => {
  const rep = extractRmFacts(baseSpec(), PAGES, SVDS);
  const { doc, items } = assembleRmFacts({ id: "RM0490", rev: "Rev 6" }, rep.items);
  assert.deepEqual(doc.lines, ["STM32C031", "STM32C071"]);
  assert.equal(items[0].appliesTo.length, 2);
});

t("normalizedPage/normQuote：折叠空白口径一致，且大小写只对匹配不只对引文", () => {
  assert.equal(normalizedPage("a\n\nb  c"), "a b c");
  assert.equal(normQuote("A\nB"), "a b");
});

t("空锚点规格：直接拒（无语料=没核验）", () => {
  const rep = extractRmFacts(baseSpec({ topics: [{ id: "t", statement: "s", page: 53, anchors: [] }] }), PAGES, SVDS);
  assert.match(rep.rejected[0].reason, /没给锚点/);
});

t("SVD 整线缺失：该线进 dropped，不因缺对照物而放行", () => {
  const rep = extractRmFacts(baseSpec(), PAGES, { STM32C031: SVDS.STM32C031, STM32C071: SVDS.STM32C071 });
  assert.deepEqual(rep.items[0].appliesTo, ["STM32C031", "STM32C071"]);
  const c999 = rep.lineNotes.find((n) => n.line === "STM32C999");
  assert.ok(c999.dropped.some((d) => d.includes("该线 SVD 没取到")));
});
