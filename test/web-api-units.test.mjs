// 单元测试：设置面板的宿主 API（web-api）。用 node test/web-api-units.test.mjs 跑。
//
// 只测纯逻辑那一层：配置读写、能力归纳、错误分支、安装任务的登记。
// HTTP 适配（web-routes.ts）与浏览器端（lib/client.js）不在这里测。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  capabilitiesOf,
  configSnapshot,
  handleWebApi,
  installStart,
  installTaskState,
  resetInstallTasks,
  saveConfig,
  summarizeProbe,
  WEB_API_PATHS,
  WEB_API_PREFIX,
} from "../lib/engine/web-api.js";
import { resetToolchainConfigCache } from "../lib/data/toolchain-config.js";
import { resetDebugSessionsForTest } from "../lib/engine/debug-session.js";
import { emitEvent, resetEventBus, setEventSessionKey } from "../lib/engine/event-bus.js";
import { beginToolCall, resetRunning } from "../lib/engine/progress.js";
import { resetChannelTaps } from "../lib/engine/channel-tap.js";

/** 假的宿主 subprocess：本套件里没有任何路径会真的起进程。 */
const fakeSubprocess = {
  resolveExecutable: async (name) => name,
  spawn: () => {
    throw new Error("web-api 单测不该起进程");
  },
};

function tempEnv(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-webapi-" + tag + "-"));
  resetToolchainConfigCache();
  return {
    dir,
    file: path.join(dir, "config.json"),
    // 显式构造 env：不能带 DSH_STM32_NO_CONFIG（run-units 会给子进程设它）。
    env: { DSH_STM32_CONFIG: path.join(dir, "config.json") },
  };
}

function makeResult(id, label, found, required) {
  return {
    id,
    label,
    found,
    path: found ? "C:/tools/" + id : "",
    version: found ? id + " 1.0" : "",
    required,
    hint: id + " hint",
    impact: id + " impact",
    install: ["pacman -S " + id],
    verify: id + " --version",
    error: found ? "" : "没找到",
  };
}

test("configSnapshot：没有配置文件时给出路径与空配置", () => {
  const box = tempEnv("empty");
  const snapshot = configSnapshot(box.env);
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.exists, false);
  assert.equal(snapshot.config, null);
  assert.equal(snapshot.path, box.file);
  assert.deepEqual(snapshot.binDirs, []);
  assert.deepEqual(snapshot.cubeMxRoots, []);
});

test("saveConfig：写进去后能读回来，binDirs 由 msys64 推出来", () => {
  const box = tempEnv("save");
  const saved = saveConfig({ msys64: " D:/app/msys64 " }, box.env);
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.path, box.file);
  assert.equal(saved.config !== null && saved.config.msys64, "D:/app/msys64");
  assert.equal(fs.existsSync(box.file), true);

  const snapshot = configSnapshot(box.env);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.exists, true);
  assert.deepEqual(snapshot.binDirs, ["D:/app/msys64/ucrt64/bin"]);
  assert.deepEqual(snapshot.cubeMxRoots, []);
});

test("saveConfig：类型不对、包名注入、空补丁都在动手前拒掉", () => {
  const box = tempEnv("reject");
  const badBin = saveConfig({ binDirs: "D:/one" }, box.env);
  assert.equal(badBin.ok, false);
  assert.match(badBin.error, /binDirs 必须是字符串数组/u);

  const badPkg = saveConfig({ packages: ["-Syu"] }, box.env);
  assert.equal(badPkg.ok, false);
  assert.match(badPkg.error, /不能以 - 开头/u);

  const badSpace = saveConfig({ packages: ["mingw-w64 ; rm -rf /"] }, box.env);
  assert.equal(badSpace.ok, false);
  assert.match(badSpace.error, /空白或 shell 特殊字符/u);

  const empty = saveConfig({}, box.env);
  assert.equal(empty.ok, false);
  assert.match(empty.error, /没有要保存的字段/u);

  const badRoot = saveConfig({ msys64: 5 }, box.env);
  assert.equal(badRoot.ok, false);
  assert.match(badRoot.error, /msys64 必须是字符串/u);

  // 一次都没写成功：配置文件不该被创建。
  assert.equal(fs.existsSync(box.file), false);
});

test("capabilitiesOf + summarizeProbe：四项能力按 id 组合，缺件走必需项", () => {
  const tools = [
    makeResult("gcc", "arm-none-eabi-gcc", true, true),
    makeResult("cmake", "CMake", true, true),
    makeResult("ninja", "Ninja", true, true),
    makeResult("openocd", "OpenOCD", true, true),
    makeResult("gdb", "gdb-multiarch", false, true),
    makeResult("cubemx", "STM32CubeMX", true, false),
    makeResult("cubemx-java", "STM32CubeMX 内置 JRE", false, false),
  ];
  const capabilities = capabilitiesOf(tools);
  assert.deepEqual(capabilities, { build: true, flash: true, debug: false, generate: false });

  const summary = summarizeProbe(tools, { binDirs: ["C:/msys64/ucrt64/bin"], cubeMxRoots: [] });
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.missingRequired, ["gdb-multiarch"]);
  assert.match(summary.message, /缺 gdb-multiarch/u);
  assert.equal(summary.tools.length, 7);
  assert.deepEqual(summary.binDirs, ["C:/msys64/ucrt64/bin"]);

  const allFound = tools.map((tool) => ({ ...tool, found: true }));
  const ready = summarizeProbe(allFound, { binDirs: [], cubeMxRoots: [] });
  assert.equal(ready.ok, true);
  assert.deepEqual(ready.missingRequired, []);
  assert.match(ready.message, /工具链就绪：7\/7 项可用/u);
});

test("handleWebApi：GET /config 返回快照，方法不对 405", async () => {
  const box = tempEnv("dispatch");
  const deps = { subprocess: fakeSubprocess, env: box.env };
  const got = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/config", deps });
  assert.equal(got.status, 200);
  assert.equal(got.body.ok, true);
  assert.equal(got.body.snapshot.path, box.file);

  const wrong = await handleWebApi({ method: "POST", path: WEB_API_PREFIX + "/config", body: "{}", deps });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.body.ok, false);
  assert.match(String(wrong.body.error), /只接受 GET/u);
});

test("handleWebApi：未知路径 404、坏 JSON 400、install/state 缺 taskId 400", async () => {
  const box = tempEnv("errors");
  const deps = { subprocess: fakeSubprocess, env: box.env };

  const unknown = await handleWebApi({ method: "POST", path: WEB_API_PREFIX + "/nope", body: "{}", deps });
  assert.equal(unknown.status, 404);
  assert.match(String(unknown.body.error), /没有这个接口/u);

  const broken = await handleWebApi({ method: "POST", path: WEB_API_PREFIX + "/config/save", body: "{oops", deps });
  assert.equal(broken.status, 400);
  assert.match(String(broken.body.error), /不是合法 JSON/u);

  const noId = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/install/state", deps });
  assert.equal(noId.status, 400);
  assert.match(String(noId.body.error), /缺少 taskId/u);

  resetInstallTasks();
  const missing = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/install/state", query: { taskId: "nope" }, deps });
  assert.equal(missing.status, 404);
  assert.match(String(missing.body.error), /没有这个安装任务/u);
  assert.equal(installTaskState("nope"), null);
});

test("installStart：confirm 不是 true 一律拒，且不登记任务", async () => {
  const box = tempEnv("confirm");
  const deps = { subprocess: fakeSubprocess, env: box.env };
  resetInstallTasks();

  const direct = installStart({}, deps);
  assert.equal(direct.ok, false);
  assert.equal(direct.taskId, "");
  assert.match(direct.error, /confirm:true/u);

  const viaApi = await handleWebApi({ method: "POST", path: WEB_API_PREFIX + "/install/start", body: "{}", deps });
  assert.equal(viaApi.status, 400);
  assert.equal(viaApi.body.ok, false);
  assert.match(String(viaApi.body.error), /confirm:true/u);
});

test("handleWebApi：探测与安装计划的入参校验在动手之前", async () => {
  const box = tempEnv("validate");
  const deps = { subprocess: fakeSubprocess, env: box.env };

  const badProbe = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/probe",
    body: JSON.stringify({ binDirs: "D:/one" }),
    deps,
  });
  assert.equal(badProbe.status, 400);
  assert.match(String(badProbe.body.error), /binDirs 必须是字符串数组/u);

  const badRoot = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/probe",
    body: JSON.stringify({ cubeMxRoot: 7 }),
    deps,
  });
  assert.equal(badRoot.status, 400);
  assert.match(String(badRoot.body.error), /cubeMxRoot 必须是字符串/u);

  const badTarget = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/install/plan",
    body: JSON.stringify({ targetDir: 7 }),
    deps,
  });
  assert.equal(badTarget.status, 400);
  assert.match(String(badTarget.body.error), /targetDir 必须是字符串/u);

  const badPkg = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/install/plan",
    body: JSON.stringify({ packages: ["--noconfirm"] }),
    deps,
  });
  assert.equal(badPkg.status, 400);
  assert.match(String(badPkg.body.error), /不能以 - 开头/u);
});

test("WEB_API_PATHS：十六条路由都在前缀下，且没有重复", () => {
  assert.equal(WEB_API_PATHS.length, 16);
  assert.equal(new Set(WEB_API_PATHS).size, 16);
  for (const route of WEB_API_PATHS) {
    assert.equal(route.startsWith(WEB_API_PREFIX + "/"), true, route);
  }
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/config"), true);
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/install/state"), true);
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/events"), true, "调试台的事件流必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/status"), true);
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/debug"), true, "调试会话摘要必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/debug/breakpoints"), true, "断点面板必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/abort"), true, "在途调用中止必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/channels"), true, "常驻通道状态必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/channels/start"), true);
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/channels/stop"), true);
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/pinout"), true, "引脚面板必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/clocks"), true, "时钟面板必须有独立路由");
});

test("GET /status：返回事件计数、会话键与证据目录", async () => {
  resetEventBus();
  setEventSessionKey("sess-status");
  emitEvent({ source: "system", kind: "probe", summary: "一条事件" });
  const result = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/status",
    deps: { subprocess: fakeSubprocess, env: { DSH_STM32_EVIDENCE: "D:/evidence" } },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  const status = result.body.status;
  assert.equal(status.sessionKey, "sess-status");
  assert.equal(status.eventCount, 1);
  assert.equal(status.latestSeq, 1);
  assert.equal(status.ringLimit, 5000);
  assert.equal(status.evidenceOverride, true);
  assert.ok(String(status.evidenceRoot).replace(/\\/gu, "/").endsWith("D:/evidence"), String(status.evidenceRoot));
  // 事件流路由不接受 JSON 分发
  const wrong = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/status", deps: { subprocess: fakeSubprocess, env: {} } });
  assert.equal(wrong.status, 200);
});

test("GET /status?session：按会话计数，sessionKey 回显请求的会话", async () => {
  resetEventBus();
  setEventSessionKey("sess-status");
  emitEvent({ source: "system", kind: "probe", summary: "全局一", session: "sess-a" });
  emitEvent({ source: "system", kind: "probe", summary: "全局二", session: "sess-b" });
  const result = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/status",
    query: { session: "sess-a" },
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(result.status, 200);
  const status = result.body.status;
  assert.equal(status.eventCount, 1, "只数本会话事件");
  assert.equal(status.latestSeq, 1);
  assert.equal(status.sessionKey, "sess-a");
  const all = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/status",
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(all.body.status.eventCount, 2, "不带 session 时数全部");
  assert.equal(all.body.status.sessionKey, "sess-status", "不带 session 时回显绑定键");
});

test("POST /abort：参数与在途调用校验，只中止登记过的调用", async () => {
  resetRunning();
  const empty = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/abort",
    body: "{}",
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(empty.status, 400, "缺 callId 又没 all 必须 400");
  assert.ok(String(empty.body.error).includes("callId"));

  const missing = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/abort",
    body: JSON.stringify({ callId: "call-404" }),
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(missing.status, 404);
  assert.ok(String(missing.body.error).includes("call-404"));

  const handle = beginToolCall({ name: "stm32_build", session: "sess-abort" });
  const aborted = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/abort",
    body: JSON.stringify({ callId: handle.info.id }),
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(aborted.status, 200);
  assert.equal(aborted.body.abort.count, 1);
  assert.equal(aborted.body.abort.calls[0].name, "stm32_build");
  assert.equal(handle.signal.aborted, true, "接口必须真的触发派生信号");
  handle.end();
  resetRunning();
});

test("GET /clocks：读工程 .ioc 的 RCC 频率与分频，缺 .ioc 回 409", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-clocks-"));
  fs.writeFileSync(
    path.join(dir, "demo.ioc"),
    [
      "Mcu.CPN=STM32F103C8T6",
      "RCC.SYSCLKSource=RCC_SYSCLKSOURCE_PLLCLK",
      "RCC.PLLSourceVirtual=RCC_PLLSOURCE_HSE",
      "RCC.PLLMUL=RCC_PLL_MUL9",
      "RCC.SYSCLKFreq_VALUE=72000000",
      "RCC.APB1Freq_Value=36000000",
      "RCC.APB1CLKDivider=RCC_HCLK_DIV2",
    ].join("\n"),
    "utf8",
  );
  const good = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/clocks",
    query: { projectDir: dir },
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(good.status, 200);
  assert.equal(good.body.clocks.cpn, "STM32F103C8T6");
  assert.equal(good.body.clocks.sysclkSourceLabel, "PLL");
  const apb1 = good.body.clocks.nodes.find((node) => node.label === "PCLK1 / APB1");
  assert.equal(apb1.hz, 36000000);
  assert.equal(apb1.divider, "÷2");

  const missing = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/clocks",
    query: { projectDir: fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-clocks-empty-")) },
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(missing.status, 409);
  assert.ok(String(missing.body.error).includes(".ioc"));
});

test("GET /pinout：读工程 .ioc 分组，缺 .ioc 回 409", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-pinout-"));
  fs.writeFileSync(
    path.join(dir, "demo.ioc"),
    [
      "Mcu.CPN=STM32F103C8T6",
      "Mcu.PinsNb=2",
      "Mcu.Pin0=PA0",
      "Mcu.Pin1=PA9",
      "PA0.Signal=GPIO_Output",
      "PA9.Signal=USART1_TX",
    ].join("\n"),
    "utf8",
  );
  const good = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/pinout",
    query: { projectDir: dir },
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(good.status, 200);
  assert.equal(good.body.pinout.mcu.cpn, "STM32F103C8T6");
  assert.equal(good.body.pinout.pins.length, 2);
  assert.deepEqual(
    good.body.pinout.groups.map((group) => group.name),
    ["USART1", "GPIO"],
  );

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-pinout-empty-"));
  const missing = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/pinout",
    query: { projectDir: empty },
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(missing.status, 409);
  assert.ok(String(missing.body.error).includes(".ioc"));
});

test("常驻通道接口：默认关、开关改状态、非法值 400", async () => {
  resetChannelTaps();
  const idle = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/channels",
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(idle.status, 200);
  assert.deepEqual(
    idle.body.channels.map((item) => item.name),
    ["serial", "rtt"],
  );
  assert.equal(idle.body.channels.every((item) => item.active === false), true);

  const started = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/channels/start",
    body: JSON.stringify({ rtt: true }),
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(started.status, 200);
  assert.equal(started.body.channels.find((item) => item.name === "rtt")?.active, true);
  assert.equal(started.body.channels.find((item) => item.name === "serial")?.active, false);

  const bad = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/channels/start",
    body: JSON.stringify({ serial: 1 }),
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(bad.status, 400);
  assert.ok(String(bad.body.error).includes("serial"));

  const stopped = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/channels/stop",
    body: JSON.stringify({ rtt: true }),
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.channels.every((item) => item.active === false), true);
  resetChannelTaps();
});

test("GET /status：running 列出在途调用，按会话过滤", async () => {
  resetRunning();
  resetEventBus();
  const a = beginToolCall({ name: "stm32_flash", session: "sess-a" });
  const b = beginToolCall({ name: "stm32_build", session: "sess-b" });
  const scoped = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/status",
    query: { session: "sess-a" },
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(scoped.body.status.running.length, 1);
  assert.equal(scoped.body.status.running[0].name, "stm32_flash");
  const all = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/status",
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(all.body.status.running.length, 2);
  a.end();
  b.end();
  resetRunning();
});

test("GET /debug：没有会话时返回空闲摘要，且不接受 POST", async () => {
  resetDebugSessionsForTest();
  const result = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/debug",
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  const debug = result.body.debug;
  assert.equal(debug.active, false, "没有会话时必须明确 active=false");
  assert.equal(debug.sessionId, "");
  assert.equal(typeof debug.message, "string");
  assert.ok(debug.message.length > 0);
  const wrong = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/debug",
    body: "{}",
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(wrong.status, 405, "只读接口不接受 POST");
});

test("POST /debug/breakpoints：白名单动作、位置与编号先校验，没有会话时回 409", async () => {
  resetDebugSessionsForTest();
  const post = (body) =>
    handleWebApi({
      method: "POST",
      path: WEB_API_PREFIX + "/debug/breakpoints",
      body: JSON.stringify(body),
      deps: { subprocess: fakeSubprocess, env: {} },
    });

  const badAction = await post({ action: "eval", commands: ["shell rm -rf /"] });
  assert.equal(badAction.status, 400, "只接受 add / remove / list");
  assert.match(String(badAction.body.error), /add \/ remove \/ list/u);

  const badLocation = await post({ action: "add", location: "main; shell echo hi" });
  assert.equal(badLocation.status, 400);
  assert.match(String(badLocation.body.error), /location/u);

  const emptyLocation = await post({ action: "add", location: "   " });
  assert.equal(emptyLocation.status, 400);

  const badId = await post({ action: "remove", id: 0 });
  assert.equal(badId.status, 400);
  assert.match(String(badId.body.error), /id/u);

  const noSession = await post({ action: "list" });
  assert.equal(noSession.status, 409);
  assert.match(String(noSession.body.error), /没有调试会话/u);
});
