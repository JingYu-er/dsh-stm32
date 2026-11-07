// generationRiskNotes（R5）：generate/project_create 的「生成前风险一行」三态口径。
// 运行：node --test test/generation-risk-units.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as t } from "node:test";
import { fileURLToPath } from "node:url";
import { generationRiskNotes, readFactsFor } from "../lib/engine/facts.js";

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), "grisk-" + tag + "-"));
const writeFacts = (root, family, line, pkg) => {
  const dir = path.join(root, family, line);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "facts.json"), JSON.stringify(pkg), "utf8");
};

t("未生成：指路到具体型号命令，并点明后果是 stm32_flash 只读拒烧", () => {
  const env = { DSH_STM32_FACTS: tmp("none") };
  const notes = generationRiskNotes("STM32C051C6T6", env);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /build-facts\.mjs --part STM32C051C6T6/u);
  assert.match(notes[0], /无 facts 的族只提示/u);
  assert.ok(!notes[0].includes("拒烧"), "未生成 ≠ 拒烧：门禁只拦「facts 存在但语义 0」");
});

t("只有结构：说明缺 rm-facts 抽取，并带 allowUnknownFacts 出路", () => {
  const root = tmp("struct");
  writeFacts(root, "stm32c0", "STM32C051", {
    schema: 2, part: "STM32C051C6T6", family: "STM32C0", line: "STM32C051",
    semantics: [], needs: ["rm-facts 声明只覆盖 X，不含 STM32C051"], registers: {},
  });
  const notes = generationRiskNotes("STM32C051C6T6", { DSH_STM32_FACTS: root });
  assert.match(notes[0], /只有结构、语义未核实/u);
  assert.match(notes[0], /allowUnknownFacts=true 可强制/u);
  assert.match(notes[0], /不含 STM32C051/u, "needs 首条要并进去");
});

t("已核实：一句放行口径，指向 doctor 看逐条", () => {
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
  assert.deepEqual(generationRiskNotes("not-a-part", env).length, 1, "认不出的型号走未生成分支");
});

t("与 readFactsFor 口径一致：verified=false 的行绝不会出现「放行」文案", () => {
  const root = tmp("consist");
  writeFacts(root, "stm32c0", "STM32C071", {
    schema: 2, part: "STM32C071CBU6", family: "STM32C0", line: "STM32C071",
    semantics: [], registers: {},
  });
  const env = { DSH_STM32_FACTS: root };
  const s = readFactsFor("STM32C071CBU6", env);
  const notes = generationRiskNotes("STM32C071CBU6", env);
  assert.equal(s.verified, false);
  assert.ok(!notes.join("").includes("不会因只读门禁拦"), "两口径不能打架：" + notes.join(""));
});
