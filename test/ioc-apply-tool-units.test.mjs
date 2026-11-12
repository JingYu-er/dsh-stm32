// stm32_ioc_apply 工具入口的单测：走真的 tools.register → execute，确认写入成功后自动记 .ioc 基线。
import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { registerIocApply } from "../lib/tools/ioc-apply.js";
import { planIocChanges } from "../lib/engine/ioc-plan.js";
import { readIocDiff, snapshotPath } from "../lib/engine/ioc-diff.js";

import { FIXTURE_ASSETS, FIXTURE_PROJECT, e2eWorkDir } from "./fixtures.mjs";

process.env.DSH_STM32_ASSETS = FIXTURE_ASSETS;

const DEMO_IOC = join(FIXTURE_PROJECT, "demo.ioc");
const TMP = e2eWorkDir("ioc-apply-tool");
const SNAPSHOTS = e2eWorkDir("ioc-apply-tool-snapshots");
const exec = { signal: new AbortController().signal };

function freshProject() {
  rmSync(TMP, { recursive: true, force: true });
  rmSync(SNAPSHOTS, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  mkdirSync(SNAPSHOTS, { recursive: true });
  copyFileSync(DEMO_IOC, join(TMP, "demo.ioc"));
  return TMP;
}

/** 只提供 tools.register 的假 ctx：工具入口显式传了 projectDir，不需要 workingDirectory 服务。 */
function captureDefinition() {
  const captured = [];
  registerIocApply({ tools: { register: (definition) => captured.push(definition) }, get: () => undefined });
  assert.equal(captured.length, 1, "stm32_ioc_apply 应注册一个工具");
  return captured[0];
}

test("apply 成功后自动把写入后的 .ioc 记成基线，报告里说明这一点", async () => {
  const projectDir = freshProject();
  const plan = planIocChanges({ projectDir, pins: [{ pin: "PA0", label: "key", signal: "input", pull: "up" }] });
  assert.equal(plan.ok, true, plan.message);

  process.env.DSH_STM32_SNAPSHOTS = SNAPSHOTS;
  let value;
  try {
    value = await captureDefinition().execute({ projectDir, planId: plan.planId }, exec);
  } finally {
    delete process.env.DSH_STM32_SNAPSHOTS;
  }

  assert.equal(value.ok, true, value.message);
  assert.equal(value.appliedChanges > 0, true, "应真的写入变更");

  const target = snapshotPath(projectDir, { DSH_STM32_SNAPSHOTS: SNAPSHOTS });
  assert.equal(existsSync(target), true, "写入成功后应自动生成 .ioc 基线：" + target);
  assert.ok(readdirSync(SNAPSHOTS).some((name) => name.endsWith(".ioc")), "基线应落在 DSH_STM32_SNAPSHOTS 指向的目录");

  const note = value.notes.find((item) => item.includes("基线"));
  assert.ok(note !== undefined, "报告的 notes 要说明基线已更新：" + JSON.stringify(value.notes));
  assert.equal(note.includes(plan.planId), false, "注记不该把 planId 当文件名贴出来");

  process.env.DSH_STM32_SNAPSHOTS = SNAPSHOTS;
  try {
    const diff = readIocDiff(projectDir);
    assert.equal(diff.ok, true, diff.error);
    assert.equal(diff.report.hasSnapshot, true);
    assert.equal(diff.report.added.length + diff.report.removed.length + diff.report.changed.length, 0, "刚记的基线不应有差异");
  } finally {
    delete process.env.DSH_STM32_SNAPSHOTS;
  }

  rmSync(TMP, { recursive: true, force: true });
  rmSync(SNAPSHOTS, { recursive: true, force: true });
});
