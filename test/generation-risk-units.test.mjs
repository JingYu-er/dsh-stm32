// generationRiskNotes（R5/三态门禁）：「这颗芯片有没有主题清单」决定话术与门禁。
// 运行：node --test test/generation-risk-units.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as t } from "node:test";
import { generationRiskNotes, readFactsFor } from "../lib/engine/facts.js";

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), "grisk-" + tag + "-"));
const writeFacts = (root, family, line, pkg) => {
  const dir = path.join(root, family, line);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "facts.json"), JSON.stringify(pkg), "utf8");
};

t("未生成且没清单（H5 无内置 spec）：指路命令 + 明说不拦烧", () => {
  const env = { DSH_STM32_FACTS: tmp("none") };
  const notes = generationRiskNotes("STM32H563MKIP", env);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /build-facts\.mjs --part STM32H563MKIP/u);
  assert.match(notes[0], /只提示不拦/u);
  assert.ok(!notes[0].includes("会拒烧"), "没清单的芯片 ≠ 拒烧");
});

t("未生成但有清单（C051 命中内置族级 spec）：按「机检没过→拒烧」说，不安抚", () => {
  const env = { DSH_STM32_FACTS: tmp("none2") };
  const notes = generationRiskNotes("STM32C051C6T6", env);
  assert.match(notes[0], /有 rm-topics 主题清单但机检没过/u);
  assert.match(notes[0], /会拒烧/u);
  assert.match(notes[0], /allowUnknownFacts=true 可强制/u);
});

t("只有结构 + 有清单：拒烧口径，needs 首条并进同一行", () => {
  const root = tmp("struct");
  writeFacts(root, "stm32c0", "STM32C051", {
    schema: 2, part: "STM32C051C6T6", family: "STM32C0", line: "STM32C051",
    semantics: [], needs: ["rm-facts 声明只覆盖 X，不含 STM32C051"], registers: {},
  });
  const notes = generationRiskNotes("STM32C051C6T6", { DSH_STM32_FACTS: root });
  assert.match(notes[0], /有 rm-topics 主题清单但机检没过/u);
  assert.match(notes[0], /allowUnknownFacts=true 可强制/u);
  assert.match(notes[0], /不含 STM32C051/u, "needs 首条要并进去");
});

t("只有结构 + 没清单：明说「不拦烧录，直接烧」；载体在场要印反查路径", () => {
  const root = tmp("struct-nospec");
  writeFacts(root, "stm32l4", "STM32L412", {
    schema: 2, part: "STM32L412KBT6", family: "STM32L4", line: "STM32L412",
    semantics: [], sources: [], registers: {},
  });
  const notes = generationRiskNotes("STM32L412KBT6", { DSH_STM32_FACTS: root });
  assert.match(notes[0], /只有结构、没有主题清单：不拦烧录，直接烧/u);
  const pdf = path.join(root, "rm", "rm0394.pdf");
  fs.mkdirSync(path.dirname(pdf), { recursive: true });
  fs.writeFileSync(pdf, "%PDF fake");
  writeFacts(root, "stm32l4", "STM32L412", {
    schema: 2, part: "STM32L412KBT6", family: "STM32L4", line: "STM32L412",
    semantics: [], registers: {},
    sources: [{ kind: "rm-pdf", path: pdf, file: "rm0394.pdf" }],
  });
  const withPdf = generationRiskNotes("STM32L412KBT6", { DSH_STM32_FACTS: root });
  assert.ok(withPdf[0].includes(pdf), "要印真实载体路径：" + withPdf[0]);
});

t("已核实：一句放行口径，指向 doctor", () => {
  const root = tmp("ok");
  writeFacts(root, "stm32c0", "STM32C051", {
    schema: 2, part: "STM32C051C6T6", family: "STM32C0", line: "STM32C051",
    semantics: [{ id: "a", statement: "x", appliesTo: ["STM32C051"] }, { id: "b", statement: "y", appliesTo: ["STM32C051"] }],
    registers: {},
  });
  const notes = generationRiskNotes("STM32C051C6T6", { DSH_STM32_FACTS: root });
  assert.match(notes[0], /已核实 2 条语义/u);
  assert.match(notes[0], /不会因只读门禁拦/u);
  assert.match(notes[0], /stm32_doctor/u);
});

t("型号缺失/不可解析：不打扰（空数组）", () => {
  const env = { DSH_STM32_FACTS: tmp("null") };
  assert.deepEqual(generationRiskNotes(null, env), []);
  assert.deepEqual(generationRiskNotes("", env), []);
  assert.equal(generationRiskNotes("not-a-part", env).length, 1, "认不出的型号走未生成分支");
});

t("口径一致性：hasSpec=true 的行必含拒烧，hasSpec=false 的行必不含", () => {
  const root = tmp("consist");
  writeFacts(root, "stm32c0", "STM32C071", {
    schema: 2, part: "STM32C071CBU6", family: "STM32C0", line: "STM32C071", semantics: [], registers: {},
  });
  const s = readFactsFor("STM32C071CBU6", { DSH_STM32_FACTS: root });
  assert.equal(s.hasSpec, true, "C0 内置 spec 在场");
  assert.equal(s.verified, false);
  const notes = generationRiskNotes("STM32C071CBU6", { DSH_STM32_FACTS: root });
  assert.ok(notes[0].includes("拒烧"), "有清单没核过必须明说拦：" + notes[0]);
  const notesH5 = generationRiskNotes("STM32H563MKIP", { DSH_STM32_FACTS: root });
  assert.ok(!notesH5[0].includes("拒烧"), "H5 没清单不许吓唬：" + notesH5[0]);
});
