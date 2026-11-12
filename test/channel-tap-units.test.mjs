// 为什么要有这个套件：常驻通道自己维护读取偏移，容易出两类错——
// 重复发同一批（偏移没更新）和丢半行（carry 处理错）。两种都只在真机上表现为
// 「串口输出看起来对，但偶尔少一行或多一行」，必须在这里钉住。
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  channelTapStatus,
  resetChannelTaps,
  setChannelTaps,
  tapSerialOnce,
} from "../lib/engine/channel-tap.js";
import { resetEventBus, subscribeEvents } from "../lib/engine/event-bus.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "dsh-stm32-tap-"));
}

function ndjson(text, partial) {
  return JSON.stringify(partial === true ? { d: text, p: true } : { d: text }) + "\n";
}

test("串口增量：只发新行，偏移与半行都跟着文件走", () => {
  resetChannelTaps();
  resetEventBus();
  const dir = tempDir();
  const file = join(dir, "rx.ndjson");
  writeFileSync(file, ndjson("boot ok"), "utf8");
  const seen = [];
  const off = subscribeEvents((event) => seen.push(event));

  assert.equal(tapSerialOnce(dir, "sess-1"), 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "channel:serial");
  assert.deepEqual(seen[0].payload.lines, ["boot ok"]);
  assert.equal(seen[0].payload.meta.action, "stream");
  assert.equal(seen[0].payload.meta.sessionId, "sess-1");

  // 同一份文件再读一次：没有新行，就不该再发事件。
  assert.equal(tapSerialOnce(dir, "sess-1"), 0);
  assert.equal(seen.length, 1, "偏移没推进就会重复发；这里必须为 0 行");

  // 追加一行，只发这一行。
  appendFileSync(file, ndjson("tick 1"), "utf8");
  assert.equal(tapSerialOnce(dir, "sess-1"), 1);
  assert.deepEqual(seen[1].payload.lines, ["tick 1"]);

  // 残行（p=true）先留在 carry 里，等下一段拼回同一行。
  appendFileSync(file, ndjson("tick ", true), "utf8");
  assert.equal(tapSerialOnce(dir, "sess-1"), 0, "残行不能当完整行发出去");
  appendFileSync(file, ndjson("2"), "utf8");
  assert.equal(tapSerialOnce(dir, "sess-1"), 1);
  assert.deepEqual(seen[2].payload.lines, ["tick 2"], "carry 与后续半行要拼回一行");
  off();
});

test("串口增量：会话换了就从文件头重读，文件被重写也不卡死", () => {
  resetChannelTaps();
  resetEventBus();
  const dir = tempDir();
  const file = join(dir, "rx.ndjson");
  writeFileSync(file, ndjson("first"), "utf8");
  const seen = [];
  const off = subscribeEvents((event) => seen.push(event));
  tapSerialOnce(dir, "sess-1");

  // 换会话：偏移归零，同一批内容按新会话再发一次。
  assert.equal(tapSerialOnce(dir, "sess-2"), 1);
  assert.equal(seen[1].payload.meta.sessionId, "sess-2");

  // 文件被重写成更短的内容：偏移越界，从头读。
  writeFileSync(file, ndjson("reborn"), "utf8");
  assert.equal(tapSerialOnce(dir, "sess-2"), 1);
  assert.deepEqual(seen[2].payload.lines, ["reborn"]);
  off();
});

test("开关：没开的通道不会被定时取，开关后的状态可读", () => {
  resetChannelTaps();
  const before = channelTapStatus();
  assert.deepEqual(
    before.map((item) => item.name),
    ["serial", "rtt"],
  );
  assert.equal(
    before.every((item) => item.active === false),
    true,
  );
  const started = setChannelTaps({ serial: true });
  assert.equal(started.find((item) => item.name === "serial")?.active, true);
  assert.equal(started.find((item) => item.name === "rtt")?.active, false);
  const stopped = setChannelTaps({ serial: false });
  assert.equal(stopped.find((item) => item.name === "serial")?.active, false);
  resetChannelTaps();
});
