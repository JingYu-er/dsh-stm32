// P3 变量监视/观察点单测：node test/watch-units.test.mjs
// 全离线：只测纯状态函数与工具层参数/报告形状；不 spawn gdb、不碰探针。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_WATCH_ENTRIES,
  WATCH_KINDS,
  WATCH_KIND_LABELS,
  createWatchState,
  formatWatchDelta,
  formatWatchEntry,
  formatWatchLines,
  hardwareWatchpoints,
  isHardwareWatchpoint,
  isWatchKind,
  markWatchpointsStale,
  normalizeWatchExpression,
  numericWatchValue,
  parseWatchMarkers,
  parseWatchpointNumber,
  recordWatchSample,
  registerWatch,
  removeAllWatches,
  removeWatchByIds,
  resetWatchState,
  sampledWatches,
  watchState,
} from "../lib/engine/watch.js";
import { WATCH_TOOL, registerWatchTool, watchOutputSchema } from "../lib/tools/watch.js";

const signal = () => new AbortController().signal;

/** 最小工具上下文：只提供 register + subprocess 桩（spawn 一律禁用）。 */
function makeToolContext() {
  const tools = new Map();
  const subprocess = {
    spawn() {
      throw new TypeError("watch 单测不该起进程");
    },
    async resolveExecutable() {
      throw new Error("watch 单测不该找可执行文件");
    },
  };
  const ctx = {
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {}; } },
    subprocess,
    get() { return undefined; },
  };
  return { ctx, tools };
}

/** 每条用例用独立的登记表，别让前面用例的残留影响后面。 */
function freshState() {
  return createWatchState();
}

// ------------------------------------------------------------------ 纯状态

test("WATCH_KINDS 与标签、isWatchKind 一致", () => {
  assert.deepEqual(WATCH_KINDS, ["value", "write", "read", "access"]);
  for (const kind of WATCH_KINDS) {
    assert.equal(isWatchKind(kind), true);
    assert.equal(typeof WATCH_KIND_LABELS[kind], "string");
  }
  assert.equal(isWatchKind("bogus"), false);
});

test("normalizeWatchExpression：去空白、拒空/换行/超长", () => {
  assert.equal(normalizeWatchExpression("  g_tick_1k  "), "g_tick_1k");
  assert.equal(normalizeWatchExpression("   "), null);
  assert.equal(normalizeWatchExpression("a\nb"), null);
  assert.equal(normalizeWatchExpression("a" + String.fromCharCode(0) + "b"), null);
  assert.equal(normalizeWatchExpression("x".repeat(201)), null);
  assert.equal(normalizeWatchExpression("x".repeat(200)), "x".repeat(200));
});

test("registerWatch：编号自增、同表达式同类型去重、跨类型可并存", () => {
  const state = freshState();
  const first = registerWatch(state, "g_tick_1k", "value", 1000);
  assert.notEqual(first.entry, null);
  assert.equal(first.entry.id, 1);
  assert.equal(first.entry.kind, "value");
  assert.equal(first.entry.gdbNumber, 0);
  assert.equal(first.entry.lastValue, "");
  assert.equal(first.entry.addedAt, 1000);

  const duplicate = registerWatch(state, "  g_tick_1k ", "value", 1001);
  assert.equal(duplicate.entry, null);
  assert.ok(duplicate.error.includes("已经登记过"));
  assert.ok(duplicate.error.includes("id 1"));

  const other = registerWatch(state, "g_tick_1k", "write", 1002, 3);
  assert.notEqual(other.entry, null);
  assert.equal(other.entry.id, 2);
  assert.equal(other.entry.gdbNumber, 3);
  assert.equal(state.nextId, 3);
});

test("registerWatch：超过上限拒绝，且不消耗 id", () => {
  const state = freshState();
  for (let index = 0; index < MAX_WATCH_ENTRIES; index += 1) {
    assert.notEqual(registerWatch(state, "v" + String(index), "value", 1).entry, null);
  }
  const overflow = registerWatch(state, "one_more", "value", 1);
  assert.equal(overflow.entry, null);
  assert.ok(overflow.error.includes("太多"));
  assert.equal(state.nextId, MAX_WATCH_ENTRIES + 1);
});

test("removeWatchByIds / removeAllWatches / resetWatchState", () => {
  const state = freshState();
  registerWatch(state, "a", "value", 1);
  registerWatch(state, "b", "value", 1);
  registerWatch(state, "c", "write", 1, 7);
  const removed = removeWatchByIds(state, [2, 99]);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].expression, "b");
  assert.equal(state.entries.length, 2);
  assert.equal(removeAllWatches(state).length, 2);
  assert.equal(state.entries.length, 0);
  registerWatch(state, "d", "value", 1);
  resetWatchState(state);
  assert.equal(state.entries.length, 0);
  assert.equal(state.nextId, 1);
});

test("sampledWatches / hardwareWatchpoints 按 kind 分流", () => {
  const state = freshState();
  registerWatch(state, "v", "value", 1);
  registerWatch(state, "w", "write", 1, 1);
  registerWatch(state, "r", "read", 1, 2);
  registerWatch(state, "a", "access", 1, 3);
  assert.deepEqual(sampledWatches(state).map((entry) => entry.expression), ["v"]);
  assert.deepEqual(hardwareWatchpoints(state).map((entry) => entry.expression), ["w", "r", "a"]);
});

test("markWatchpointsStale：只清观察点编号并写原因，值监视不受影响", () => {
  const state = freshState();
  registerWatch(state, "v", "value", 1);
  registerWatch(state, "w", "write", 1, 5);
  const affected = markWatchpointsStale(state, "gdb 重建");
  assert.equal(affected.length, 1);
  const watchpoint = state.entries.find((entry) => entry.kind === "write");
  assert.equal(watchpoint.gdbNumber, 0);
  assert.equal(watchpoint.lastError, "gdb 重建");
  const sampled = state.entries.find((entry) => entry.kind === "value");
  assert.equal(sampled.lastError, "");
});

test("recordWatchSample：成功写值，失败保留旧值但更新时间与错误", () => {
  const state = freshState();
  const entry = registerWatch(state, "v", "value", 1).entry;
  recordWatchSample(entry, "1000", "", 10);
  assert.equal(entry.lastValue, "1000");
  assert.equal(entry.lastAt, 10);
  recordWatchSample(entry, "", "Cannot access memory", 20);
  assert.equal(entry.lastValue, "1000");
  assert.equal(entry.lastAt, 20);
  assert.ok(entry.lastError.includes("Cannot access"));
});

test("numericWatchValue / formatWatchDelta", () => {
  assert.equal(numericWatchValue("1000"), 1000);
  assert.equal(numericWatchValue("0x3e8"), 1000);
  assert.equal(numericWatchValue("-5"), -5);
  assert.equal(numericWatchValue("1.5"), 1.5);
  assert.equal(numericWatchValue("{a = 1, b = 2}"), null);
  assert.equal(numericWatchValue(""), null);

  assert.equal(formatWatchDelta("", "1000"), "首次");
  assert.equal(formatWatchDelta("1000", ""), "—");
  assert.equal(formatWatchDelta("1000", "1000"), "0");
  assert.equal(formatWatchDelta("1000", "1005"), "+5");
  assert.equal(formatWatchDelta("1005", "1000"), "-5");
  assert.equal(formatWatchDelta("0x1", "0x3"), "+2");
  assert.equal(formatWatchDelta("{a=1}", "{a=2}"), "变化");
});

test("formatWatchEntry / formatWatchLines 带 id、种类、值与失败原因", () => {
  const state = freshState();
  const entry = registerWatch(state, "g_tick_1k", "value", 1).entry;
  assert.ok(formatWatchEntry(entry).includes("（还没采过）"));
  recordWatchSample(entry, "1000", "", 2);
  const line = formatWatchEntry(entry);
  assert.ok(line.includes("#1"));
  assert.ok(line.includes("g_tick_1k"));
  assert.ok(line.includes("1000"));
  recordWatchSample(entry, "", "读不到", 3);
  assert.ok(formatWatchEntry(entry).includes("读不到"));
  assert.deepEqual(formatWatchLines([entry]).length, 1);
});

test("parseWatchMarkers：多标记、多行结构体、无 $N 记为错误", () => {
  const output = [
    "===DSH:W1===",
    "$1 = 1000",
    "===DSH:W2===",
    "$2 = {a = 1, b = 2}",
    "===DSH:W3===",
    "No symbol \"foo\" in current context.",
    "===DSH:W4===",
    "",
  ].join("\n");
  const parsed = parseWatchMarkers(output);
  assert.equal(parsed.get(1).value, "1000");
  assert.equal(parsed.get(1).error, "");
  assert.equal(parsed.get(2).value, "{a = 1, b = 2}");
  assert.ok(parsed.get(3).error.includes("No symbol"));
  assert.equal(parsed.get(3).value, "");
  assert.equal(parsed.get(4).error, "没有输出");
});

test("parseWatchpointNumber / isHardwareWatchpoint", () => {
  assert.equal(parseWatchpointNumber("Hardware watchpoint 2: g_tick_1k"), 2);
  assert.equal(parseWatchpointNumber("Watchpoint 3: foo"), 3);
  assert.equal(parseWatchpointNumber("Hardware read watchpoint 12: *(int *)0x20000000"), 12);
  assert.equal(parseWatchpointNumber("Breakpoint 1 at 0x8000"), null);

  assert.equal(isHardwareWatchpoint("Hardware watchpoint 2: g_tick_1k"), true);
  assert.equal(isHardwareWatchpoint("Hardware read watchpoint 3: x"), true);
  assert.equal(isHardwareWatchpoint("Hardware access watchpoint 4: y"), true);
  assert.equal(isHardwareWatchpoint("Watchpoint 3: foo"), false);
});

// ------------------------------------------------------------------ 工具层

test("stm32_watch：注册名与报告 schema 的必填字段齐全", () => {
  const { ctx, tools } = makeToolContext();
  registerWatchTool(ctx);
  const definition = tools.get(WATCH_TOOL);
  assert.notEqual(definition, undefined);
  assert.equal(WATCH_TOOL, "stm32_watch");
  assert.equal(typeof definition.description, "string");

  const reportProps = Object.keys(watchOutputSchema.properties.report.properties);
  assert.deepEqual([...watchOutputSchema.properties.report.required].sort(), reportProps.sort());
  const entryProps = Object.keys(watchOutputSchema.properties.report.properties.entries.items.properties);
  assert.deepEqual(
    [...watchOutputSchema.properties.report.properties.entries.items.required].sort(),
    entryProps.sort(),
  );
});

test("stm32_watch：空表 list / add 值监视 / 重复 add", async () => {
  resetWatchState(watchState);
  const { ctx, tools } = makeToolContext();
  registerWatchTool(ctx);
  const definition = tools.get(WATCH_TOOL);

  const empty = await definition.execute({ action: "list" }, { signal: signal() });
  assert.equal(empty.report.ok, true);
  assert.deepEqual(empty.report.entries, []);
  assert.ok(empty.message.includes("空"));

  const added = await definition.execute({ action: "add", expressions: ["g_tick_1k", "g_adc_dma[0]"] }, { signal: signal() });
  assert.equal(added.report.ok, true);
  assert.equal(added.report.entries.length, 2);
  assert.equal(added.report.entries[0].expression, "g_tick_1k");
  assert.equal(added.report.entries[0].kind, "value");
  assert.equal(added.report.entries[0].kindLabel, WATCH_KIND_LABELS.value);
  assert.equal(added.report.entries[0].lastValue, "");

  const duplicated = await definition.execute({ action: "add", expressions: ["g_tick_1k"] }, { signal: signal() });
  assert.equal(duplicated.report.ok, false);
  assert.ok(duplicated.report.errors[0].includes("已经登记过"));

  const listed = await definition.execute({ action: "list" }, { signal: signal() });
  assert.equal(listed.report.entries.length, 2);
  assert.ok(listed.message.includes("值监视 2"));
});

test("stm32_watch：坏 kind / 空 expressions / 未知 action / remove 无 ids 都给人话", async () => {
  resetWatchState(watchState);
  const { ctx, tools } = makeToolContext();
  registerWatchTool(ctx);
  const definition = tools.get(WATCH_TOOL);

  const badKind = await definition.execute({ action: "add", expressions: ["x"], kind: "bogus" }, { signal: signal() });
  assert.equal(badKind.report.ok, false);
  assert.ok(badKind.message.includes("kind"));

  const noExpr = await definition.execute({ action: "add" }, { signal: signal() });
  assert.equal(noExpr.report.ok, false);
  assert.ok(noExpr.message.includes("expressions"));

  const unknown = await definition.execute({ action: "explode" }, { signal: signal() });
  assert.equal(unknown.report.ok, false);
  assert.ok(unknown.message.includes("action"));

  const noIds = await definition.execute({ action: "remove" }, { signal: signal() });
  assert.equal(noIds.report.ok, false);
  assert.ok(noIds.message.includes("ids"));
});

test("stm32_watch：没有会话时 sample 给失败报告，不抛也不起进程", async () => {
  resetWatchState(watchState);
  const { ctx, tools } = makeToolContext();
  registerWatchTool(ctx);
  const definition = tools.get(WATCH_TOOL);
  await definition.execute({ action: "add", expressions: ["g_tick_1k"] }, { signal: signal() });
  const sampled = await definition.execute({ action: "sample" }, { signal: signal() });
  assert.equal(sampled.report.ok, false);
  assert.ok(sampled.message.includes("没有调试会话"));
  assert.equal(sampled.report.entries.length, 1);
  assert.equal(sampled.report.entries[0].expression, "g_tick_1k");

  const watchpoint = await definition.execute({ action: "add", expressions: ["g_tick_1k"], kind: "write" }, { signal: signal() });
  assert.equal(watchpoint.report.ok, false);
  assert.ok(watchpoint.message.includes("没有调试会话"));

  // 值监视项还在（观察点没登记上），clear 能一次清干净。
  const cleared = await definition.execute({ action: "clear" }, { signal: signal() });
  assert.equal(cleared.report.ok, true);
  const after = await definition.execute({ action: "list" }, { signal: signal() });
  assert.deepEqual(after.report.entries, []);
});
