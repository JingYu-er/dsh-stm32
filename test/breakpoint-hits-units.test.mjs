import { test } from "node:test";
import assert from "node:assert/strict";

import { HIT_LIMIT, HitHistory, parseStops } from "../lib/engine/breakpoint-hits.js";

test("从 gdb 输出认出普通断点、观察点与「已停下」描述", () => {
  const stops = parseStops(
    [
      "Breakpoint 1, main () at ../Core/Src/main.c:67",
      "Hardware watchpoint 2: g_led_blink_count",
      "Old value = 19",
      "New value = 20",
      "continue：已停下 —— HAL_Delay (ms=100) at ../Core/Src/stm32f1xx_hal.c:373（本次 eval 结束会按默认再 resume；要停在那里用 keepHalted=true）",
      "Reading symbols from build/Debug/demo.elf...",
    ].join("\n"),
  );
  assert.equal(stops.length, 3);
  assert.deepEqual(stops[0], { id: 1, text: "main () at ../Core/Src/main.c:67" });
  assert.equal(stops[1].id, 2);
  assert.ok(stops[1].text.includes("原值 19"));
  assert.ok(stops[1].text.includes("新值 20"));
  assert.equal(stops[2].id, 0);
  assert.ok(stops[2].text.includes("HAL_Delay"));
  assert.ok(!stops[2].text.includes("keepHalted"), "resume 提示不该进停点描述");
});

test("历史是环形：超过上限丢最旧，list 返回副本", () => {
  const history = new HitHistory(3);
  const first = history.record("Breakpoint 1, a () at a.c:1", 1_700_000_000_000);
  const second = history.record("Breakpoint 2, b () at b.c:2", 1_700_000_001_000);
  const third = history.record("Breakpoint 3, c () at c.c:3", 1_700_000_002_000);
  const fourth = history.record("Breakpoint 4, d () at d.c:4", 1_700_000_003_000);
  assert.equal(first, 1);
  assert.equal(second, 1);
  assert.equal(third, 1);
  assert.equal(fourth, 1);
  const listed = history.list();
  assert.equal(listed.length, 3);
  assert.deepEqual(listed.map((hit) => hit.id), [2, 3, 4]);
  assert.equal(listed[0].time, new Date(1_700_000_001_000).toISOString());

  listed.pop();
  assert.equal(history.list().length, 3, "list 的改动不影响内部记录");

  history.clear();
  assert.deepEqual(history.list(), []);
  assert.equal(HIT_LIMIT, 50);
});

test("没有停点的输出不产生记录", () => {
  const history = new HitHistory();
  assert.equal(history.record("(gdb) info breakpoints\nNo breakpoints or watchpoints.", 0), 0);
  assert.deepEqual(history.list(), []);
});
