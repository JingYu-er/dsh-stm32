// 为什么要有这个套件：调试台的事件流是「模型做了什么」的唯一事实源，
// 面板回看、SSE 续播、证据目录都按 seq 对齐。环形上限、截断、挤出落盘任何一处错了，
// 表现都是"时间线看起来连续但中间缺段"，很难在真机上发现，所以这里逐条钉住。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EVENT_PAYLOAD_LIMIT,
  EVENT_PENDING_LIMIT,
  EVENT_RING_LIMIT,
  drainEvicted,
  emitEvent,
  eventCount,
  eventSessionKey,
  eventSnapshot,
  resetEventBus,
  requeueEvicted,
  setEventSessionKey,
  subscribeEvents,
  takeDroppedCount,
} from "../lib/engine/event-bus.js";
import {
  dateFolder,
  evidenceRoot,
  flushEvicted,
  flushPending,
  pruneEvidence,
  resetArchiveCursor,
  safeSessionKey,
  sessionEvidenceDir,
} from "../lib/engine/event-log.js";
import { instrumentContext, withToolEvents } from "../lib/engine/tool-events.js";
import { openEventStream } from "../lib/engine/web-api.js";
import { CHANNEL_LINE_LIMIT, emitChannel } from "../lib/engine/channels.js";

function tempDir(tag) {
  return mkdtempSync(join(tmpdir(), "dsh-stm32-" + tag + "-"));
}

test("事件序号递增、时间可解析、snapshot 按 since 过滤", () => {
  resetEventBus();
  const a = emitEvent({ source: "model", kind: "stm32_build", summary: "第一条" });
  const b = emitEvent({ source: "model", kind: "stm32_build", status: "ok", summary: "第二条" });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.ok(!Number.isNaN(Date.parse(a.time)), "time 必须是可解析的 ISO 时间");
  assert.equal(eventCount(), 2);
  assert.deepEqual(eventSnapshot(0).map((e) => e.seq), [1, 2]);
  assert.deepEqual(eventSnapshot(1).map((e) => e.seq), [2]);
  assert.deepEqual(eventSnapshot(2), []);
});

test("payload 超上限时截断并保留预览", () => {
  resetEventBus();
  const big = { blob: "x".repeat(EVENT_PAYLOAD_LIMIT * 2) };
  const event = emitEvent({ source: "system", kind: "test", summary: "大 payload", payload: big });
  assert.equal(event.truncated, true);
  assert.equal(typeof event.payload.preview, "string");
  assert.ok(event.payload.preview.length > 0);
  const small = emitEvent({ source: "system", kind: "test", summary: "小 payload", payload: { a: 1 } });
  assert.equal(small.truncated, undefined);
  assert.deepEqual(small.payload, { a: 1 });
});

test("环形缓冲只保留最近 5000 条，挤出的进待落盘队列", () => {
  resetEventBus();
  for (let i = 0; i < EVENT_RING_LIMIT + 3; i += 1) {
    emitEvent({ source: "model", kind: "stress", summary: "第 " + String(i) + " 条" });
  }
  assert.equal(eventCount(), EVENT_RING_LIMIT);
  const ring = eventSnapshot(0);
  assert.equal(ring[0].seq, 4, "最旧的 3 条应被挤出");
  const evicted = drainEvicted();
  assert.deepEqual(evicted.map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(drainEvicted(), [], "取走后再取应为空");
});

test("待落盘队列有上限，超出的计入缺口计数", () => {
  resetEventBus();
  const total = EVENT_RING_LIMIT + EVENT_PENDING_LIMIT + 7;
  for (let i = 0; i < total; i += 1) {
    emitEvent({ source: "model", kind: "stress", summary: "第 " + String(i) + " 条" });
  }
  // 挤出总数 = total - 环形上限；待落盘队列只留最新 2000 条，其余计缺口。
  assert.equal(takeDroppedCount(), 7);
  const pending = drainEvicted();
  assert.equal(pending.length, EVENT_PENDING_LIMIT);
  assert.equal(pending[pending.length - 1].seq, total - EVENT_RING_LIMIT);
  assert.equal(pending[0].seq, total - EVENT_RING_LIMIT - EVENT_PENDING_LIMIT + 1);
  // 放回后仍受同一上限约束，且不会打乱顺序。
  requeueEvicted(pending.slice(0, 10));
  assert.equal(drainEvicted().length, 10);
});

test("订阅收到新事件，注销后不再收到，单个监听器抛错不影响其它", () => {
  resetEventBus();
  const seen = [];
  const bad = () => {
    throw new Error("监听器自己炸了");
  };
  const offBad = subscribeEvents(bad);
  const off = subscribeEvents((event) => seen.push(event.seq));
  emitEvent({ source: "user", kind: "panel", summary: "点击" });
  off();
  offBad();
  emitEvent({ source: "user", kind: "panel", summary: "再点一次" });
  assert.deepEqual(seen, [1]);
});

test("会话键参与证据目录路径，非法字符被归一", () => {
  resetEventBus();
  assert.equal(safeSessionKey("  "), "unbound");
  assert.equal(safeSessionKey("agent/12 3"), "agent-12-3");
  assert.equal(safeSessionKey("a".repeat(200)).length, 80);
  const now = new Date(2026, 10, 12, 9, 8, 7);
  assert.equal(dateFolder(now), "2026-11-12");
  const dir = sessionEvidenceDir("C:/evidence", "sess-1", now);
  assert.ok(dir.endsWith(join("2026-11-12", "sess-1")), dir);
  setEventSessionKey("sess-1");
  assert.equal(eventSessionKey(), "sess-1");
  const env = { DSH_STM32_EVIDENCE: "D:/custom" };
  assert.ok(evidenceRoot(env).replace(/\\/gu, "/").endsWith("D:/custom"));
});

test("挤出事件按批写入证据目录，一行一条 JSON", async () => {
  resetEventBus();
  setEventSessionKey("sess-write");
  const root = tempDir("evidence");
  try {
    for (let i = 0; i < EVENT_RING_LIMIT + 2; i += 1) {
      emitEvent({ source: "model", kind: "stm32_build", status: "ok", summary: "第 " + String(i) + " 条" });
    }
    const now = new Date(2026, 10, 12, 9, 8, 7);
    const result = await flushEvicted({ root, now });
    assert.equal(result.written, 2);
    assert.ok(result.file !== null && existsSync(result.file), "批次文件应存在");
    const lines = readFileSync(result.file, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const parsed = lines.map((line) => JSON.parse(line));
    assert.deepEqual(parsed.map((e) => e.seq), [1, 2]);
    assert.equal(parsed[0].kind, "stm32_build");
    // 目录按 日期/会话键 分层。
    const [day] = readdirSync(root);
    assert.equal(day, "2026-11-12");
    const [sess] = readdirSync(join(root, day));
    assert.equal(sess, "sess-write");
    // 没有挤出时再冲一次什么也不写。
    const empty = await flushEvicted({ root, now });
    assert.equal(empty.written, 0);
    assert.equal(empty.file, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("未溢出的事件也落盘：同一事件只写一次，会话换了重新记基线", async () => {
  resetEventBus();
  resetArchiveCursor();
  setEventSessionKey("sess-archive");
  const root = tempDir("evidence-archive");
  const now = new Date(2026, 10, 12, 10, 0, 0);
  try {
    emitEvent({ source: "model", kind: "stm32_build", status: "ok", summary: "第一条" });
    emitEvent({ source: "model", kind: "stm32_flash", status: "ok", summary: "第二条" });
    const first = await flushPending({ root, now });
    assert.equal(first.written, 2, "没溢出也要把新事件写下去");
    assert.ok(first.file !== null && existsSync(first.file));
    const again = await flushPending({ root, now });
    assert.equal(again.written, 0, "没有新事件时不应重复写");
    assert.equal(again.file, null);

    emitEvent({ source: "model", kind: "stm32_build", status: "ok", summary: "第三条" });
    const third = await flushPending({ root, now });
    assert.equal(third.written, 1, "只写新增的那一条");
    const lines = readFileSync(String(third.file), "utf8").trim().split(String.fromCharCode(10));
    const parsed = lines.map((line) => JSON.parse(line));
    assert.equal(parsed[parsed.length - 1].seq, 3, "游标之后的序号才写");

    setEventSessionKey("sess-archive-2");
    emitEvent({ source: "model", kind: "stm32_build", status: "ok", summary: "新会话第一条" });
    const switched = await flushPending({ root, now });
    assert.equal(switched.written, 1, "换会话后游标归零，新会话的事件要写进去");
    assert.ok(String(switched.file).includes("sess-archive-2"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetArchiveCursor();
  }
});

test("证据保留：超过 7 天的日期目录、超过 20 个的旧会话目录被清掉", async () => {
  const root = tempDir("evidence-prune");
  try {
    const now = new Date(2026, 10, 12, 12, 0, 0);
    // 一个过期日期目录，两个新日期目录；新日期里放 21 个会话目录。
    mkdirSync(join(root, "2026-10-01", "sess-old"), { recursive: true });
    writeFileSync(join(root, "2026-10-01", "sess-old", "a.jsonl"), "{}\n", "utf8");
    for (let i = 0; i < 21; i += 1) {
      const day = i < 11 ? "2026-11-11" : "2026-11-12";
      mkdirSync(join(root, day, "sess-" + String(i).padStart(2, "0")), { recursive: true });
      writeFileSync(join(root, day, "sess-" + String(i).padStart(2, "0"), "a.jsonl"), "{}\n", "utf8");
    }
    const result = await pruneEvidence({ root, now });
    assert.equal(existsSync(join(root, "2026-10-01")), false, "过期日期目录应被删");
    assert.ok(result.removedDirs.length >= 2, JSON.stringify(result.removedDirs));
    assert.ok(result.removedFiles >= 2, String(result.removedFiles));
    assert.ok(result.removedBytes > 0, String(result.removedBytes));
    let left = 0;
    for (const day of readdirSync(root)) left += readdirSync(join(root, day)).length;
    assert.equal(left, 20, "只保留 20 个会话目录");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("有缺口时先写一条缺口事件，避免证据看起来连续", async () => {
  resetEventBus();
  setEventSessionKey("sess-gap");
  const root = tempDir("evidence-gap");
  try {
    const total = EVENT_RING_LIMIT + EVENT_PENDING_LIMIT + 5;
    for (let i = 0; i < total; i += 1) {
      emitEvent({ source: "model", kind: "stress", summary: "第 " + String(i) + " 条" });
    }
    const now = new Date(2026, 10, 12, 10, 0, 0);
    const result = await flushEvicted({ root, now });
    assert.ok(result.file !== null);
    const lines = readFileSync(result.file, "utf8").trim().split("\n");
    const first = JSON.parse(lines[0]);
    assert.equal(first.kind, "log");
    assert.equal(first.status, "fail");
    assert.equal(first.payload.dropped, 5);
    assert.equal(lines.length, EVENT_PENDING_LIMIT + 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("工具埋点：start / ok 成对，失败时记 fail 并重新抛出", async () => {
  resetEventBus();
  const calls = [];
  const ctx = {
    tools: { register: (definition) => calls.push(definition) },
    get: () => "ok",
  };
  const scoped = instrumentContext(ctx);
  assert.equal(scoped.get("x"), "ok", "非 tools 属性应原样转发");
  const tool = {
    name: "stm32_build",
    description: "构建",
    parameters: { type: "object" },
    output: { schema: { type: "object" }, render: () => [] },
    execute: async () => ({ ok: true, summary: "构建完成" }),
  };
  scoped.tools.register(tool);
  assert.equal(calls.length, 1);
  const wrapped = calls[0];
  const value = await wrapped.execute({ projectDir: "demo" }, { signal: new AbortController().signal, agent: { id: "agent-7" } });
  assert.deepEqual(value, { ok: true, summary: "构建完成" });
  assert.equal(eventSessionKey(), "agent-7");
  const events = eventSnapshot(0);
  assert.deepEqual(events.map((e) => e.status), ["start", "ok"]);
  assert.equal(events[0].kind, "stm32_build");
  assert.equal(events[1].payload.result.summary, "构建完成");

  // 编译错误与工程目录要进摘要：面板靠它们跳源码，靠 projectDir 判断读哪个工程的源码。
  const withErrors = withToolEvents({
    name: "stm32_build",
    description: "构建",
    parameters: { type: "object" },
    output: { schema: { type: "object" }, render: () => [] },
    execute: async () => ({ ok: false, projectDir: "D:/demo", errors: Array.from({ length: 25 }, (_, i) => "Core/Src/main.c:" + String(i + 1) + ":3: error: boom") }),
  });
  await withErrors.execute({}, { signal: new AbortController().signal, agent: { id: "agent-7" } });
  const digest = eventSnapshot(0).at(-1).payload.result;
  assert.equal(digest.projectDir, "D:/demo");
  assert.equal(digest.errors.length, 20, "编译错误最多带 20 条");
  assert.match(digest.errors[0], /main\.c:1:3/u);

  const failing = withToolEvents({
    ...tool,
    execute: async () => {
      throw new Error("gcc 不存在\n第二行细节");
    },
  });
  await assert.rejects(() => failing.execute({}, {}), /gcc 不存在/u);
  const tail = eventSnapshot(0).slice(-1)[0];
  assert.equal(tail.status, "fail");
  assert.ok(tail.summary.includes("gcc 不存在"), tail.summary);
  assert.ok(!tail.summary.includes("第二行细节"), "摘要只取首行");
});

test("工具埋点：非 stm32_ 前缀的工具不包一层", () => {
  resetEventBus();
  const calls = [];
  const scoped = instrumentContext({ tools: { register: (definition) => calls.push(definition) } });
  const other = { name: "web_search", description: "x", parameters: { type: "object" }, output: { schema: { type: "object" }, render: () => [] }, execute: async () => 1 };
  scoped.tools.register(other);
  assert.equal(calls[0], other, "其它插件的工具应原样注册");
});

test("事件流：先补发存量、再推送增量，断开时清理订阅", () => {
  resetEventBus();
  emitEvent({ source: "model", kind: "stm32_build", summary: "存量一" });
  emitEvent({ source: "model", kind: "stm32_build", status: "ok", summary: "存量二" });
  const writes = [];
  const handlers = {};
  const response = {
    writeHead: (status, headers) => writes.push({ head: { status, headers } }),
    write: (chunk) => writes.push({ chunk }),
    end: () => writes.push({ end: true }),
  };
  const request = {
    on: (name, handler) => {
      handlers[name] = handler;
    },
  };
  const stop = openEventStream(request, response, { heartbeatMs: 100000 });
  const head = writes[0].head;
  assert.equal(head.status, 200);
  assert.ok(String(head.headers["content-type"]).startsWith("text/event-stream"));
  const text = writes.filter((item) => item.chunk !== undefined).map((item) => item.chunk).join("");
  assert.ok(text.includes("存量一"));
  assert.ok(text.includes("id: 2"));
  emitEvent({ source: "user", kind: "panel", status: "ok", summary: "增量" });
  assert.ok(writes.filter((item) => item.chunk !== undefined).map((item) => item.chunk).join("").includes("增量"));
  // 请求方断开后不再写，并调用 end。
  handlers.close();
  const before = writes.length;
  emitEvent({ source: "user", kind: "panel", summary: "断开之后" });
  assert.equal(writes.length, before, "close 之后不应再写");
  assert.equal(writes[writes.length - 1].end, true);
  stop();
});

test("通道事件：统一 kind 前缀、单行截断、总量超限只留前面部分", () => {
  resetEventBus();
  assert.equal(emitChannel({ channel: "serial", lines: [] }), null, "没有内容就不发事件");
  const one = emitChannel({ channel: "serial", lines: ["boot ok", ""] });
  assert.equal(one.kind, "channel:serial");
  assert.equal(one.source, "model");
  assert.equal(one.summary, "串口 1 行");
  assert.deepEqual(one.payload.lines, ["boot ok"], "空行不算一行");

  resetEventBus();
  const long = "x".repeat(500);
  const tooMany = Array.from({ length: CHANNEL_LINE_LIMIT + 5 }, (_unused, index) => "line " + String(index));
  const bulk = emitChannel({ channel: "rtt", lines: [long, ...tooMany], meta: { action: "dump" } });
  assert.equal(bulk.kind, "channel:rtt");
  assert.equal(bulk.payload.lines.length, CHANNEL_LINE_LIMIT);
  assert.equal(bulk.payload.omitted, 6);
  assert.ok(String(bulk.payload.lines[0]).endsWith("…"), "超长行要被截断");
  assert.equal(bulk.payload.meta.action, "dump");
  assert.ok(bulk.summary.includes("面板保留前"), bulk.summary);

  // 监视通道带结构化样本：面板据此画历史曲线，不必解析文本行。
  resetEventBus();
  const watch = emitChannel({
    channel: "watch",
    lines: ["g_tick_1k = 42（+1）"],
    meta: { action: "sample", samples: [{ expression: "g_tick_1k", value: "42", delta: "+1", ok: true }] },
  });
  assert.equal(watch.kind, "channel:watch");
  assert.equal(watch.payload.meta.samples.length, 1);
  assert.equal(watch.payload.meta.samples[0].expression, "g_tick_1k");
  assert.equal(watch.payload.meta.samples[0].value, "42");
  assert.equal(watch.summary, "监视 1 行");
});

test("会话过滤：快照与计数只认本会话，未带会话键的事件不误入", () => {
  resetEventBus();
  emitEvent({ source: "model", kind: "stm32_build", summary: "A 一", session: "session-a" });
  emitEvent({ source: "model", kind: "stm32_build", summary: "B 一", session: "session-b" });
  emitEvent({ source: "system", kind: "log", summary: "无会话" });
  setEventSessionKey("session-a");
  const fallback = emitEvent({ source: "model", kind: "stm32_flash", summary: "A 二" });

  assert.equal(fallback.session, "session-a", "省略 session 时用当前绑定键");
  assert.equal(eventSnapshot(0).length, 4, "不带会话时保留全部");
  assert.deepEqual(
    eventSnapshot(0, "session-a").map((event) => event.summary),
    ["A 一", "A 二"],
  );
  assert.equal(eventCount("session-a"), 2);
  assert.equal(eventCount("session-b"), 1);
  assert.equal(eventCount(), 4);
  assert.equal(eventSnapshot(2, "session-a").length, 1, "since 与 session 同时生效");
});

test("事件流：带 session 时只补发并只推送本会话事件", () => {
  resetEventBus();
  emitEvent({ source: "model", kind: "stm32_build", summary: "A 存量", session: "session-a" });
  emitEvent({ source: "model", kind: "stm32_build", summary: "B 存量", session: "session-b" });
  const writes = [];
  const response = {
    writeHead: () => {},
    write: (chunk) => writes.push(chunk),
    end: () => {},
  };
  const stop = openEventStream({ on: () => {} }, response, { session: "session-a", heartbeatMs: 100000 });
  const text = () => writes.join("");
  assert.ok(text().includes("A 存量"));
  assert.ok(!text().includes("B 存量"), "别的会话的存量不应补发");
  emitEvent({ source: "model", kind: "stm32_flash", summary: "B 增量", session: "session-b" });
  assert.ok(!text().includes("B 增量"), "别的会话的增量不应推送");
  emitEvent({ source: "model", kind: "stm32_flash", summary: "A 增量", session: "session-a" });
  assert.ok(text().includes("A 增量"));
  stop();
});
