/**
 * 监视自动采样录制器：只测定时与状态，不碰 gdb。
 *
 * 采样与发事件都用假函数，定时器用可控的 setTimer/clearTimer，时间用可推进的 now。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createWatchRecorder,
  WATCH_RECORD_INTERVAL_MAX_MS,
  WATCH_RECORD_INTERVAL_MS,
  WATCH_RECORD_MAX_MS,
  WATCH_RECORD_MIN_MS,
} from "../lib/engine/watch-recorder.js";

/** 假时钟 + 假定时器：手动推进时间并触发 tick，避免真实等待。 */
function harness(options = {}) {
  let nowMs = 1_000_000;
  const timers = [];
  const emitted = [];
  const recorder = createWatchRecorder({
    sample: options.sample ?? (async () => ({
      ok: true,
      samples: [{ expression: "g_tick", value: "3", delta: "+1", ok: true }],
    })),
    emit: (samples) => {
      emitted.push(samples);
    },
    now: () => nowMs,
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  const advance = (ms) => {
    nowMs += ms;
  };
  const tick = async () => {
    const live = timers.filter((timer) => !timer.cleared);
    for (const timer of live) await timer.callback();
  };
  return { recorder, emitted, advance, tick, timers };
}

test("监视录制：默认关、开始后按间隔登记、停止后状态归零", () => {
  const { recorder, timers } = harness();
  const idle = recorder.status();
  assert.equal(idle.active, false);
  assert.equal(idle.intervalMs, WATCH_RECORD_INTERVAL_MS);
  assert.equal(idle.recorded, 0);
  assert.equal(idle.startedAt, "");
  assert.equal(idle.remainingMs, 0);

  const started = recorder.start();
  assert.equal(started.active, true);
  assert.equal(started.intervalMs, WATCH_RECORD_INTERVAL_MS);
  assert.equal(started.remainingMs, WATCH_RECORD_MAX_MS);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, WATCH_RECORD_INTERVAL_MS);
  assert.notEqual(started.startedAt, "");

  const stopped = recorder.stop();
  assert.equal(stopped.active, false);
  assert.equal(timers[0].cleared, true);
});

test("监视录制：间隔按 500–60000 夹紧，非法输入不会开出过密的定时器", () => {
  const { recorder, timers } = harness();
  assert.equal(recorder.start({ intervalMs: 1 }).intervalMs, WATCH_RECORD_MIN_MS);
  assert.equal(recorder.start({ intervalMs: WATCH_RECORD_INTERVAL_MAX_MS + 1 }).intervalMs, WATCH_RECORD_INTERVAL_MAX_MS);
  assert.equal(recorder.start({ intervalMs: 1500 }).intervalMs, 1500);
  const last = timers[timers.length - 1];
  assert.equal(last.cleared, false);
  assert.equal(recorder.status().recorded, 0);
});

test("监视录制：采到样本才发通道事件，并累计 recorded", async () => {
  const { recorder, emitted, tick } = harness();
  recorder.start({ intervalMs: 1000 });
  await tick();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][0].expression, "g_tick");
  const status = recorder.status();
  assert.equal(status.recorded, 1);
  assert.equal(status.lastError, "");
  assert.notEqual(status.lastAt, "");
});

test("监视录制：采样失败记 lastError，不推进 recorded，不停表", async () => {
  const { recorder, emitted, tick } = harness({
    sample: async () => ({ ok: false, samples: [], errors: ["没有调试会话"] }),
  });
  recorder.start();
  await tick();
  assert.deepEqual(emitted, []);
  const status = recorder.status();
  assert.equal(status.active, true);
  assert.equal(status.recorded, 0);
  assert.equal(status.lastError, "没有调试会话");
});

test("监视录制：上一次没采完不重叠，到时长上限自动停", async () => {
  let pending = 0;
  let release = () => {};
  const { recorder, advance, tick, emitted } = harness({
    sample: () => {
      pending += 1;
      return new Promise((resolve) => {
        release = () => resolve({ ok: true, samples: [{ expression: "a", value: "1", delta: "", ok: true }] });
      });
    },
  });
  recorder.start();
  const first = tick();
  await tick();
  assert.equal(pending, 1);
  release();
  await first;
  assert.equal(emitted.length, 1);

  // 推到超过录制上限：下一次 tick 应当停表并留下原因。
  advance(WATCH_RECORD_MAX_MS + 1);
  await tick();
  const status = recorder.status();
  assert.equal(status.active, false);
  assert.match(status.lastError, /上限/u);
  assert.equal(status.remainingMs, 0);
});
