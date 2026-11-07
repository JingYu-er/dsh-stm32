// rm-topics 两层装载（插件族级 + 用户芯片级）与「这颗芯片要不要过机检」判据。
// 运行：node --test test/rm-topics-units.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as t } from "node:test";
import { loadRmTopics, userTopicsPath, bundledTopicsDir } from "../lib/data/rm-topics.js";

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), "topics-" + tag + "-"));

t("插件自带 C0 族级 spec：装载成功、主题都带锚点", () => {
  const dir = bundledTopicsDir();
  assert.ok(fs.existsSync(path.join(dir, "stm32c0.json")), "内置清单要在 " + dir);
  const loaded = loadRmTopics("stm32c0", "STM32C051", tmp("none"));
  assert.equal(loaded.hasSpec, true);
  assert.ok(loaded.topics.length >= 9, "C0 至少 9 条主题，实际 " + String(loaded.topics.length));
  assert.ok(loaded.topics.every((x) => x.anchors.length > 0));
  assert.ok(loaded.origins.some((o) => o.startsWith("bundled:")));
});

t("用户芯片级 spec：没有族级的族（stm32f1）也能单独成立——只覆盖这一颗", () => {
  const root = tmp("f1");
  const file = userTopicsPath(root, "stm32f1", "STM32F103");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    doc: { id: "RM0008" },
    topics: [{ id: "f1.boot0", statement: "BOOT0=1 进系统存储器", page: 60, anchors: ["BOOT0 must be held high"] }],
  }), "utf8");
  const loaded = loadRmTopics("stm32f1", "STM32F103", root);
  assert.equal(loaded.hasSpec, true);
  assert.deepEqual(loaded.lines, ["STM32F103"], "用户没写 lines 时只管这颗");
  // 同族另一颗没放清单 → 不受影响
  const other = loadRmTopics("stm32f1", "STM32F107", root);
  assert.equal(other.hasSpec, false);
});

t("同 id 主题用户赢；用户新主题追加；族级 lines 保留", () => {
  const root = tmp("merge");
  const file = userTopicsPath(root, "stm32c0", "STM32C051");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    doc: { id: "RM0490" },
    topics: [
      { id: "c0.boot.latch", statement: "用户改写版：reset 后锁存（踩坑订正版）", page: 53, anchors: ["boot mode configuration is latched"] },
      { id: "c0.mine", statement: "只有我踩过的坑", page: 90, anchors: ["some anchor"] },
    ],
  }), "utf8");
  const fam = loadRmTopics("stm32c0", "STM32C051", tmp("none2")).topics;
  const merged = loadRmTopics("stm32c0", "STM32C051", root);
  const latch = merged.topics.find((x) => x.id === "c0.boot.latch");
  assert.equal(latch.statement, "用户改写版：reset 后锁存（踩坑订正版）", "同 id 必须用户覆盖");
  assert.ok(merged.topics.some((x) => x.id === "c0.mine"), "新主题要并进来了");
  assert.equal(merged.topics.length, fam.length + 1, "并集 = 族级 + 用户新增 1 条");
  assert.ok(merged.origins.some((o) => o.startsWith("user:")));
});

t("坏文件（缺 anchors / JSON 烂）不炸也不给 hasSpec", () => {
  const root = tmp("bad");
  const file = userTopicsPath(root, "stm32l4", "STM32L412");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{oops", "utf8");
  assert.equal(loadRmTopics("stm32l4", "STM32L412", root).hasSpec, false);
  fs.writeFileSync(file, JSON.stringify({ topics: [{ id: "x", statement: "s", page: 1 }] }), "utf8");
  assert.equal(loadRmTopics("stm32l4", "STM32L412", root).hasSpec, false, "没锚点的主题不算数（阅卷人没得阅卷）");
});
