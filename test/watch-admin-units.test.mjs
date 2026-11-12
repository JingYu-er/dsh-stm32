/**
 * 面板用的监视登记表：与 stm32_watch 共用 watchState，这里只测登记/注销与校验，不采样。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { addWatches, clearWatches, listWatches, removeWatches } from "../lib/engine/watch-admin.js";
import { removeAllWatches, watchState } from "../lib/engine/watch.js";
import { resetDebugSessionsForTest } from "../lib/engine/debug-session.js";

function reset() {
  removeAllWatches(watchState);
  resetDebugSessionsForTest();
}

test("值监视：加一项进清单，重复加给明确错误", async () => {
  reset();
  const first = await addWatches({ kind: "value", expressions: ["g_tick_1k"] });
  assert.equal(first.ok, true, JSON.stringify(first.errors));
  assert.equal(first.added.length, 1);
  assert.equal(first.added[0].expression, "g_tick_1k");
  assert.equal(first.added[0].kindLabel, "值监视（每次 sample 求值）");
  assert.equal(first.message.includes("已登记 1 个"), true, first.message);

  const listed = listWatches();
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.entries[0].expression, "g_tick_1k");
  assert.equal(listed.entries[0].lastValue, "");

  const duplicate = await addWatches({ kind: "value", expressions: ["g_tick_1k"] });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.added.length, 0);
  assert.match(duplicate.errors[0], /已经登记过/u);
});

test("值监视：非法表达式与空清单被拒", async () => {
  reset();
  const bad = await addWatches({ kind: "value", expressions: ["   "] });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /没有表达式/u);

  const newline = await addWatches({ kind: "value", expressions: ["a\nb"] });
  assert.equal(newline.ok, false);
  assert.match(newline.errors[0], /换行/u);

  const unknownKind = await addWatches({ kind: "snapshot", expressions: ["x"] });
  assert.equal(unknownKind.ok, false);
  assert.match(unknownKind.errors[0], /kind 不认识/u);
});

test("硬件观察点：没有会话时明确报错，不登记", async () => {
  reset();
  const report = await addWatches({ kind: "write", expressions: ["g_led_blink_count"] });
  assert.equal(report.ok, false);
  assert.equal(report.added.length, 0);
  assert.match(report.message, /活动调试会话|会话/u);
  assert.equal(listWatches().entries.length, 0);
});

test("移除与清空：按 id 移除，清空后清单为空", async () => {
  reset();
  await addWatches({ kind: "value", expressions: ["a"] });
  await addWatches({ kind: "value", expressions: ["b"] });
  const ids = listWatches().entries.map((entry) => entry.id);
  assert.equal(ids.length, 2);

  const removed = await removeWatches([ids[0]]);
  assert.equal(removed.ok, true, JSON.stringify(removed.errors));
  assert.equal(removed.removed.length, 1);
  assert.equal(listWatches().entries.length, 1);

  const missing = await removeWatches([999]);
  assert.equal(missing.ok, false);
  assert.match(missing.message, /没有匹配的 id|没有这些登记项/u);

  const badIds = await removeWatches([0, -1]);
  assert.equal(badIds.ok, false);
  assert.match(badIds.errors[0], /正整数/u);

  const cleared = await clearWatches();
  assert.equal(cleared.ok, true);
  assert.equal(listWatches().entries.length, 0);

  const emptyAgain = await clearWatches();
  assert.equal(emptyAgain.ok, true);
  assert.match(emptyAgain.message, /已经是空的/u);
  reset();
});
