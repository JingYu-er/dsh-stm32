// 为什么要有这个套件：面板的「在途调用 / 中止」靠登记表与派生信号。
// 一旦桥接写错，表现会是「点了中止但子进程还在跑」，真机上很难分辨是面板没发还是信号没透传。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  abortAll,
  abortCall,
  beginToolCall,
  listRunning,
  resetRunning,
} from "../lib/engine/progress.js";
import { resetEventBus, subscribeEvents } from "../lib/engine/event-bus.js";
import { withToolEvents } from "../lib/engine/tool-events.js";

test("登记与结束：列表随调用进出，按会话过滤", () => {
  resetRunning();
  const first = beginToolCall({ name: "stm32_build", session: "sess-a" });
  const second = beginToolCall({ name: "stm32_flash", session: "sess-b" });
  assert.equal(first.info.id, "call-1");
  assert.equal(second.info.id, "call-2");
  assert.equal(listRunning().length, 2);
  assert.equal(listRunning("sess-a").length, 1);
  assert.equal(listRunning("sess-a")[0].name, "stm32_build");
  first.end();
  assert.equal(listRunning().length, 1, "结束后从在途表移除");
  second.end();
  assert.equal(listRunning().length, 0);
});

test("进度事件：阶段变化各发一条 progress，重复阶段不刷屏", () => {
  resetRunning();
  resetEventBus();
  const seen = [];
  const off = subscribeEvents((event) => seen.push(event));
  const handle = beginToolCall({ name: "stm32_generate", session: "sess-a" });
  handle.update("准备 CubeMX");
  handle.update("准备 CubeMX");
  handle.update("生成中");
  handle.end();
  off();
  assert.equal(seen.length, 2, "同一阶段连报两次只发一条");
  assert.deepEqual(
    seen.map((event) => event.summary),
    ["stm32_generate：准备 CubeMX", "stm32_generate：生成中"],
  );
  assert.equal(seen[0].kind, "progress");
  assert.equal(seen[0].session, "sess-a");
  assert.equal(seen[0].payload.callId, handle.info.id);
});

test("中止：abortCall 触发派生信号，找不到返回 null", () => {
  resetRunning();
  const handle = beginToolCall({ name: "stm32_env_install" });
  assert.equal(handle.signal.aborted, false);
  const aborted = abortCall(handle.info.id);
  assert.equal(aborted?.name, "stm32_env_install");
  assert.equal(handle.signal.aborted, true, "派生信号必须真的 abort");
  assert.equal(abortCall("call-404"), null);
  handle.end();
});

test("桥接：宿主 signal abort 时本地同步 abort；abortAll 只动本会话", () => {
  resetRunning();
  const outer = new AbortController();
  const bridged = beginToolCall({ name: "stm32_flash", outer: outer.signal });
  outer.abort();
  assert.equal(bridged.signal.aborted, true, "宿主取消要透传给工具");
  bridged.end();

  const a = beginToolCall({ name: "stm32_build", session: "sess-a" });
  const b = beginToolCall({ name: "stm32_build", session: "sess-b" });
  assert.equal(abortAll("sess-a"), 1);
  assert.equal(a.signal.aborted, true);
  assert.equal(b.signal.aborted, false, "别的会话不受影响");
  assert.equal(abortAll(), 2, "全部中止时要把两条都算进来");
  assert.equal(listRunning().length, 2, "中止不清理登记表，调用结束才移除");
  a.end();
  b.end();
  assert.equal(listRunning().length, 0);
});

test("工具埋点：中止在途调用会把 abort 传到工具拿到的 signal", async () => {
  resetRunning();
  resetEventBus();
  let seenSignal = null;
  const wrapped = withToolEvents({
    name: "stm32_build",
    description: "假工具",
    parameters: { type: "object" },
    output: { schema: { type: "object" }, render: () => [] },
    execute: async (_args, exec) => {
      seenSignal = exec.signal;
      await new Promise((resolve) => {
        if (exec.signal.aborted) resolve();
        else exec.signal.addEventListener("abort", resolve, { once: true });
      });
      throw new Error("已中止");
    },
  });
  const running = wrapped.execute({}, { signal: new AbortController().signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const live = listRunning();
  assert.equal(live.length, 1, "执行中的工具必须在途可见");
  assert.equal(live[0].name, "stm32_build");
  assert.ok(abortCall(live[0].id) !== null);
  await assert.rejects(running, /已中止/u);
  assert.equal(seenSignal?.aborted, true, "工具拿到的 signal 必须被 abort");
  assert.equal(listRunning().length, 0, "异常结束也要清理登记");
});
