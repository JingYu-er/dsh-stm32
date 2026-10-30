import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pruneLegacyEntries, writeCacheIndex, readCacheIndex } from "../lib/engine/cache.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dsh-gc-"));
  return { root, env: { ...process.env, DSH_STM32_CACHE: root } };
}

function entry(root, id, dir, bytes) {
  const target = join(root, "cache", dir);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "startup.s"), "x".repeat(bytes), "utf8");
  return {
    id,
    kind: "cmsis",
    family: "F1",
    label: id,
    root: target,
    createdAt: new Date().toISOString(),
    totalBytes: bytes,
    files: [],
    sources: [],
    license: "test",
  };
}

test("gc：新 id 存在时删掉旧 id（并回收目录）", () => {
  const { root, env } = fixture();
  const legacy = entry(root, "cmsis:F1:startup_stm32f103xb", "F1/startup_stm32f103xb", 100);
  const fresh = entry(root, "cmsis:F1:103xb", "F1/103xb", 200);
  writeCacheIndex({ version: 1, updatedAt: "", entries: [legacy, fresh] }, env);

  const result = pruneLegacyEntries(env);
  assert.deepEqual(result.removed, ["cmsis:F1:startup_stm32f103xb"]);
  assert.deepEqual(result.kept, []);
  assert.equal(result.reclaimedBytes, 100);
  assert.equal(existsSync(legacy.root), false, "旧条目的目录要一起删");
  assert.ok(existsSync(fresh.root), "新条目不能被误删");
  const after = readCacheIndex(env).index;
  assert.deepEqual(after.entries.map((e) => e.id), ["cmsis:F1:103xb"]);
});

test("gc：只有旧 id 时保留（删了下次还得重下）", () => {
  const { root, env } = fixture();
  const legacy = entry(root, "cmsis:F1:startup_stm32f103xb", "F1/startup_stm32f103xb", 100);
  writeCacheIndex({ version: 1, updatedAt: "", entries: [legacy] }, env);

  const result = pruneLegacyEntries(env);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.kept, ["cmsis:F1:startup_stm32f103xb"]);
  assert.ok(existsSync(legacy.root));
});

test("gc：没有旧条目时是空操作", () => {
  const { root, env } = fixture();
  writeCacheIndex({ version: 1, updatedAt: "", entries: [entry(root, "cmsis:F1:103xb", "F1/103xb", 10)] }, env);
  const result = pruneLegacyEntries(env);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.kept, []);
  assert.equal(result.reclaimedBytes, 0);
});
