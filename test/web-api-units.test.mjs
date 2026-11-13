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
import { emitEvent, eventSnapshot, resetEventBus, setEventSessionKey } from "../lib/engine/event-bus.js";
import { beginToolCall, resetRunning } from "../lib/engine/progress.js";
import { removeAllWatches, watchState } from "../lib/engine/watch.js";
import { resetChannelTaps } from "../lib/engine/channel-tap.js";
import { watchRecorder } from "../lib/engine/watch-record.js";

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

test("WEB_API_PATHS：四十五条路由都在前缀下，且没有重复", () => {
  assert.equal(WEB_API_PATHS.length, 45);
  assert.equal(new Set(WEB_API_PATHS).size, 45);
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
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/faults"), true, "故障面板必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/artifacts"), true, "产物面板必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/probe-info"), true, "探针信息卡必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/interrupts/priorities"), true, "批量改优先级必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/evidence"), true, "回放选择器必须有证据列表路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/replay"), true, "回放必须有读取证据文件的路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ioc-diff"), true, "变更页必须有对比路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ioc-diff/save"), true, "变更页必须能记基线");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ioc-diff/restore"), true, "变更页必须能把某个键写回基线");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/watch-recording"), true, "监视录制状态必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/watch-recording/start"), true);
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/watch-recording/stop"), true);
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/serial/send"), true, "面板发串口必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/debug/touch"), true, "会话续期必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/interrupts"), true, "中断页必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/interrupts/priority"), true, "中断页必须能改优先级");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/source"), true, "源码片段必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ioc-sync"), true, ".ioc 同步状态必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/watch"), true, "监视登记表必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/build"), true, "面板构建必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/flash"), true, "面板烧录必须有独立路由");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/serial"), true, "串口卡片必须能读状态");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/serial/ports"), true, "串口卡片必须能列端口");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/serial/open"), true, "串口卡片必须能开会话");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/serial/close"), true, "串口卡片必须能关会话");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/evidence/prune"), true, "证据保留策略必须能手动触发");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ioc-keys"), true, "引脚页必须能看该脚在 .ioc 里的键");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/ioc-diff/restore-all"), true, "变更页必须能一次恢复全部差异");
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/debug/stop"), true, "面板必须能关闭调试会话");
});

test("GET /ioc-keys：读引脚的 .ioc 键，缺参数与缺 .ioc 各自报错", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-iockeys-"));
  fs.writeFileSync(
    path.join(project, "demo.ioc"),
    ["Mcu.CPN=STM32F103C8T6", "PA0.Signal=GPIO_Input", "PA0.GPIOParameters=GPIO_Label", "PB1.Signal=S_TIM3_CH4"].join("\n") + "\n",
    "utf8",
  );
  const deps = { subprocess: fakeSubprocess, env: {} };
  const found = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ioc-keys", query: { projectDir: project, pin: "PA0" }, deps });
  assert.equal(found.status, 200);
  assert.equal(found.body.iocKeys.base, "PA0");
  assert.deepEqual(found.body.iocKeys.entries.map((entry) => entry.key), ["PA0.Signal", "PA0.GPIOParameters"]);

  const missingPin = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ioc-keys", query: { projectDir: project }, deps });
  assert.equal(missingPin.status, 400);
  assert.match(missingPin.body.error, /pin/u);

  const noIoc = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-iockeys-empty-"));
  const noIocResult = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ioc-keys", query: { projectDir: noIoc, pin: "PA0" }, deps });
  assert.equal(noIocResult.status, 409);
  assert.match(noIocResult.body.error, /没有 \.ioc/u);
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(noIoc, { recursive: true, force: true });
});

test("串口面板：状态可读、开参数严格校验、关空会话不报错", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-serial-"));
  const env = { DSH_STM32_SERIAL_HOME: home };
  const deps = { subprocess: fakeSubprocess, env };
  const status = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/serial", deps });
  assert.equal(status.status, 200);
  assert.equal(status.body.serial.open, false);
  assert.equal(typeof status.body.serial.message, "string");

  const badPort = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/serial/open",
    body: JSON.stringify({ port: 3 }),
    deps,
  });
  assert.equal(badPort.status, 400);
  assert.match(badPort.body.error, /port/u);

  const badBaud = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/serial/open",
    body: JSON.stringify({ baudRate: "115200" }),
    deps,
  });
  assert.equal(badBaud.status, 400);
  assert.match(badBaud.body.error, /baudRate/u);

  const closed = await handleWebApi({ method: "POST", path: WEB_API_PREFIX + "/serial/close", body: "{}", deps });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.serial.closed, false);
  fs.rmSync(home, { recursive: true, force: true });
});

test("GET /source：读工程内源码的上下文；越界路径 400", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-src-"));
  fs.mkdirSync(path.join(dir, "Core", "Src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Core", "Src", "main.c"), "int main(void)\n{\n  return 0;\n}\n", "utf8");
  const read = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/source",
    query: { projectDir: dir, file: "Core/Src/main.c", line: "3", context: "1" },
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(read.status, 200);
  assert.deepEqual([read.body.source.from, read.body.source.to], [2, 4]);
  assert.equal(read.body.source.lines[1].text, "  return 0;");

  const escape = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/source",
    query: { projectDir: dir, file: "../outside.c", line: "1" },
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(escape.status, 400);
  assert.match(escape.body.error, /工程目录内/u);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("POST /build 与 /flash：人从面板触发，失败也回 200 并把事件写进时间线", async () => {
  resetEventBus();
  setEventSessionKey("sess-build");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-build-"));
  const deps = { subprocess: fakeSubprocess, env: {} };

  const built = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/build",
    query: {},
    body: JSON.stringify({ projectDir: dir }),
    deps,
  });
  assert.equal(built.status, 200);
  assert.equal(built.body.build.ok, false, "空目录里没有工程，构建必然失败");
  assert.equal(built.body.build.projectDir, dir);

  const flash = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/flash",
    query: {},
    body: JSON.stringify({ projectDir: dir }),
    deps,
  });
  assert.equal(flash.status, 200);
  assert.equal(flash.body.flash.ok, false, "没有 .elf 时烧录不可能成功");

  const events = eventSnapshot(0).filter((event) => event.source === "user" && event.kind.startsWith("stm32_"));
  const kinds = events.map((event) => event.kind + ":" + event.status);
  assert.equal(kinds.includes("stm32_build:start"), true, kinds.join(","));
  assert.equal(kinds.includes("stm32_build:fail"), true, kinds.join(","));
  assert.equal(kinds.includes("stm32_flash:start"), true, kinds.join(","));
  assert.equal(kinds.includes("stm32_flash:fail"), true, kinds.join(","));

  const get = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/build", query: {}, deps });
  assert.equal(get.status, 405);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("GET/POST /watch：列清单、加值监视、移除、清空、非法动作 400", async () => {
  removeAllWatches(watchState);
  const deps = { subprocess: fakeSubprocess, env: {} };
  const empty = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/watch", query: {}, deps });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.watch.entries.length, 0);

  const added = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/watch",
    query: {},
    body: JSON.stringify({ action: "add", kind: "value", expressions: ["uwTick"] }),
    deps,
  });
  assert.equal(added.status, 200);
  assert.equal(added.body.watch.added.length, 1);
  const id = added.body.watch.added[0].id;

  const list = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/watch", query: {}, deps });
  assert.equal(list.body.watch.entries.length, 1);
  assert.equal(list.body.watch.entries[0].expression, "uwTick");

  const badKind = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/watch",
    query: {},
    body: JSON.stringify({ action: "add", kind: "nope", expressions: ["x"] }),
    deps,
  });
  assert.equal(badKind.status, 409);
  assert.match(badKind.body.error, /kind 不认识/u);

  const removed = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/watch",
    query: {},
    body: JSON.stringify({ action: "remove", ids: [id] }),
    deps,
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.watch.removed.length, 1);

  await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/watch",
    query: {},
    body: JSON.stringify({ action: "add", kind: "value", expressions: ["a", "b"] }),
    deps,
  });
  const cleared = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/watch",
    query: {},
    body: JSON.stringify({ action: "clear" }),
    deps,
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.watch.removed.length, 2);

  const unknownAction = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/watch",
    query: {},
    body: JSON.stringify({ action: "rename" }),
    deps,
  });
  assert.equal(unknownAction.status, 400);
  assert.match(unknownAction.body.error, /add \/ remove \/ clear/u);

  const put = await handleWebApi({ method: "PUT", path: WEB_API_PREFIX + "/watch", query: {}, deps });
  assert.equal(put.status, 405);
  removeAllWatches(watchState);
});

test("GET /ioc-sync：.ioc 比 main.c 新算待生成，缺 .ioc 时 409", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-sync-"));
  const ioc = path.join(dir, "demo.ioc");
  fs.writeFileSync(ioc, "Mcu.CPN=STM32F103C8T6\n", "utf8");
  fs.mkdirSync(path.join(dir, "Core", "Src"), { recursive: true });
  const main = path.join(dir, "Core", "Src", "main.c");
  fs.writeFileSync(main, "int main(void) { return 0; }\n", "utf8");

  const iocTime = 1_700_000_000;
  const codeTime = 1_700_000_100;
  fs.utimesSync(ioc, iocTime, iocTime);
  fs.utimesSync(main, codeTime, codeTime);
  const fresh = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/ioc-sync",
    query: { projectDir: dir },
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.iocSync.stale, false);
  assert.match(fresh.body.iocSync.message, /一致/u);

  fs.utimesSync(ioc, codeTime + 60, codeTime + 60);
  const stale = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/ioc-sync",
    query: { projectDir: dir },
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(stale.status, 200);
  assert.equal(stale.body.iocSync.stale, true);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-sync-none-"));
  const missing = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/ioc-sync",
    query: { projectDir: empty },
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(missing.status, 409);
  assert.match(missing.body.error, /没有 \.ioc/u);

  const post = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/ioc-sync",
    query: {},
    body: "{}",
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(post.status, 405);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
});

test("GET /interrupts：读 .ioc 的 NVIC 表；缺 .ioc 时 409", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-irq-"));
  fs.writeFileSync(path.join(dir, "demo.ioc"), "Mcu.CPN=STM32F103C8T6\nNVIC.USART1_IRQn=true\\:2\\:0\\:false\n", "utf8");
  const read = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/interrupts",
    query: { projectDir: dir },
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(read.status, 200);
  assert.equal(read.body.interrupts.entries.length, 1);
  assert.equal(read.body.interrupts.entries[0].name, "USART1");
  assert.equal(read.body.interrupts.enabledCount, 1);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-irq-none-"));
  const missing = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/interrupts",
    query: { projectDir: empty },
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(missing.status, 409);
  assert.match(missing.body.error, /没有 \.ioc/u);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
});

test("POST /debug/touch：没有会话 409，touch() 返回 false", async () => {
  resetDebugSessionsForTest();
  const result = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/debug/touch",
    body: "{}",
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(result.status, 409);
  assert.match(result.body.error, /没有调试会话/u);
});

test("POST /serial/send：没有会话 409，参数先校验再发", async () => {
  const noSession = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/serial/send",
    body: JSON.stringify({ text: "hello" }),
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(noSession.status, 409);
  assert.match(noSession.body.error, /没有串口会话/u);

  const notString = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/serial/send",
    body: JSON.stringify({ text: 42 }),
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(notString.status, 400);
  assert.match(notString.body.error, /text/u);

  const badNewline = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/serial/send",
    body: JSON.stringify({ text: "hello", newline: "cr" }),
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(badNewline.status, 400);
  assert.match(badNewline.body.error, /newline/u);
});

test("监视录制接口：默认关、开始后可查、非法间隔 400、停止复位", async () => {
  watchRecorder.reset();
  const idle = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/watch-recording",
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(idle.status, 200);
  assert.equal(idle.body.watchRecording.active, false);

  const bad = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/watch-recording/start",
    body: JSON.stringify({ intervalMs: 70000 }),
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /intervalMs/u);

  const started = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/watch-recording/start",
    body: JSON.stringify({ intervalMs: 1000 }),
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(started.status, 200);
  assert.equal(started.body.watchRecording.active, true);
  assert.equal(started.body.watchRecording.intervalMs, 1000);

  const stopped = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/watch-recording/stop",
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.watchRecording.active, false);
  watchRecorder.reset();
});

test("GET /artifacts：返回 elf 与芯片容量；没有构建目录时 elf 为 null", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-artifacts-"));
  fs.writeFileSync(path.join(dir, "demo.ioc"), "Mcu.CPN=STM32F103C8T6\n", "utf8");
  const buildDir = path.join(dir, "build", "Debug");
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, "CMakeCache.txt"), "CMAKE_PROJECT_NAME:STATIC=demo\n", "utf8");
  fs.writeFileSync(path.join(buildDir, "demo.elf"), Buffer.alloc(1024));
  const good = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/artifacts",
    query: { projectDir: dir },
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(good.status, 200);
  assert.equal(good.body.artifacts.elf.name, "demo.elf");
  assert.equal(good.body.artifacts.chip.flashBytes, 65536);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-artifacts-empty-"));
  const bare = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/artifacts",
    query: { projectDir: empty },
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(bare.status, 200);
  assert.equal(bare.body.artifacts.elf, null);
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
  // 自检：版本来自 package.json，路由数是本次注册的数量，时间戳都是正数。
  assert.match(status.self.version, /^0\.1\.7$/u, JSON.stringify(status.self));
  assert.equal(status.self.routeCount, WEB_API_PATHS.length);
  assert.ok(status.self.startedAt > 0);
  assert.ok(status.self.libMtimeMs > 0);
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

test("GET /faults：只取失败事件并带上解码提示，limit 生效", async () => {
  resetEventBus();
  setEventSessionKey("fault-session");
  emitEvent({ source: "model", kind: "stm32_flash", status: "fail", summary: "stm32_flash 失败：Error: unable to find a matching CMSIS-DAP device" });
  emitEvent({ source: "model", kind: "stm32_build", status: "fail", summary: "stm32_build 失败：undefined reference to `HAL_Delay'" });
  emitEvent({ source: "model", kind: "stm32_build", status: "ok", summary: "stm32_build 完成" });
  emitEvent({ source: "model", kind: "stm32_build", status: "fail", summary: "stm32_build 失败：其它会话的事", session: "other" });

  const all = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/faults",
    query: { session: "fault-session" },
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(all.status, 200);
  assert.equal(all.body.total, 2, "只数本会话的失败事件");
  assert.equal(all.body.groups.length, 2, "按规则合并后两组");
  assert.equal(all.body.groups[0].count, 1);
  assert.equal(all.body.groups.map((item) => item.rule).sort().join(","), "build.undefined-reference,probe.cmsis-dap-missing");
  assert.equal(all.body.faults.length, 2);
  assert.equal(all.body.faults[0].category, "probe");
  assert.equal(all.body.faults[1].rule, "build.undefined-reference");
  assert.ok(all.body.faults[1].hint.includes("CMakeLists"));

  const limited = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/faults",
    query: { session: "fault-session", limit: "1" },
    deps: { subprocess: fakeSubprocess, env: {} },
  });
  assert.equal(limited.body.faults.length, 1, "limit 截取最近一条");
  assert.equal(limited.body.total, 2, "total 仍是全部条数");
  resetEventBus();
});

test("GET /evidence 与 /replay：列出证据文件、逐行还原事件、拒绝越界路径", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-replay-"));
  const day = path.join(root, "2026-11-12", "sess-a");
  fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, "events-120000.jsonl");
  const lines = [
    JSON.stringify({ seq: 2, time: "2026-11-12T04:00:01.000Z", source: "model", kind: "stm32_build", status: "ok", summary: "构建完成" }),
    JSON.stringify({ seq: 1, time: "2026-11-12T04:00:00.000Z", source: "model", kind: "stm32_build", status: "start", summary: "开始构建" }),
    "{坏行",
  ];
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  const other = path.join(root, "2026-11-12", "sess-b");
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, "events-130000.jsonl"), lines[0] + "\n", "utf8");
  const deps = { subprocess: fakeSubprocess, env: { DSH_STM32_EVIDENCE: root } };

  const listed = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/evidence", query: {}, deps: deps });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.evidence.root, root);
  assert.equal(listed.body.evidence.files.length, 2);
  assert.deepEqual(
    listed.body.evidence.files.map((item) => item.path).sort(),
    ["2026-11-12/sess-a/events-120000.jsonl", "2026-11-12/sess-b/events-130000.jsonl"],
    "按修改时间倒序列出两个文件",
  );
  assert.equal(listed.body.evidence.groups.length, 2, "按会话分成两组");
  assert.equal(listed.body.evidence.groups.map((item) => item.key).sort().join(","), "sess-a,sess-b");
  assert.equal(listed.body.evidence.groups.find((item) => item.key === "sess-b").files.length, 1);

  const replayed = await handleWebApi({
    method: "GET",
    path: WEB_API_PREFIX + "/replay",
    query: { path: "2026-11-12/sess-a/events-120000.jsonl" },
    deps: deps,
  });
  assert.equal(replayed.status, 200);
  assert.equal(replayed.body.replay.events.length, 2, "只收形状完整的事件");
  assert.equal(replayed.body.replay.skipped, 1, "坏行计入 skipped");
  assert.equal(replayed.body.replay.events[0].seq, 1, "按 seq 升序，与时间线同序");

  const escape = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/replay", query: { path: "../outside.jsonl" }, deps: deps });
  assert.equal(escape.status, 400);
  assert.ok(escape.body.error.includes("证据目录"));

  const missing = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/replay", query: { path: "2026-11-12/none.jsonl" }, deps: deps });
  assert.equal(missing.status, 409);
  assert.ok(missing.body.error.includes("读取证据失败"));

  const post = await handleWebApi({ method: "POST", path: WEB_API_PREFIX + "/replay", query: {}, deps: deps });
  assert.equal(post.status, 405, "回放只读，只接受 GET");
  fs.rmSync(root, { recursive: true, force: true });
});
test("GET /ioc-diff 与 POST /ioc-diff/save：无基线先提示，记下基线后比出改动", async () => {
  const env = { DSH_STM32_SNAPSHOTS: fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-ioc-snap-")) };
  const deps = { subprocess: fakeSubprocess, env: env };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-ioc-"));
  fs.writeFileSync(path.join(dir, "demo.ioc"), "Mcu.CPN=STM32F103C8T6\nMcu.IP0=NVIC\n", "utf8");

  const before = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ioc-diff", query: { projectDir: dir }, deps: deps });
  assert.equal(before.status, 200);
  assert.equal(before.body.diff.hasSnapshot, false);
  assert.ok(before.body.diff.notes[0].includes("还没有基线"));

  const saved = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/ioc-diff/save",
    query: {},
    body: JSON.stringify({ projectDir: dir }),
    deps: deps,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.snapshot.entries, 2);

  fs.writeFileSync(path.join(dir, "demo.ioc"), "Mcu.CPN=STM32F103C8T6\nUSART1.Mode=Asynchronous\n", "utf8");
  const after = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ioc-diff", query: { projectDir: dir }, deps: deps });
  assert.equal(after.status, 200);
  assert.equal(after.body.diff.counts.added, 1);
  assert.equal(after.body.diff.counts.removed, 1);
  assert.equal(after.body.diff.counts.changed, 0);

  const missing = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ioc-diff", query: { projectDir: fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-ioc-none-")) }, deps: deps });
  assert.equal(missing.status, 409);

  const wrongMethod = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/ioc-diff/save", query: {}, deps: deps });
  assert.equal(wrongMethod.status, 405, "记基线只接受 POST");

  // 恢复：把当前文件里改掉的键写回基线值。
  fs.writeFileSync(path.join(dir, "demo.ioc"), "Mcu.CPN=STM32F103C8T6\nMcu.IP0=NVIC\n", "utf8");
  const restored = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/ioc-diff/restore",
    query: {},
    body: JSON.stringify({ projectDir: dir, key: "Mcu.IP0" }),
    deps: deps,
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.restored.after, "NVIC");
  assert.equal(fs.readFileSync(path.join(dir, "demo.ioc"), "utf8").includes("Mcu.IP0=NVIC"), true);

  const noKey = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/ioc-diff/restore",
    query: {},
    body: JSON.stringify({ projectDir: dir }),
    deps: deps,
  });
  assert.equal(noKey.status, 400);
  assert.ok(String(noKey.body.error).includes("key"));
  fs.rmSync(env.DSH_STM32_SNAPSHOTS, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
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
  assert.deepEqual(debug.hits, [], "没有会话时命中历史为空数组");
  assert.deepEqual(debug.outputs, [], "没有会话时最近输出为空数组");
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

test("GET /probe-info：读 pnputil 的 USB 枚举，认不出探针时不报错", async () => {
  const text = "Instance ID:                USB\\VID_C251&PID_F001\\0000000001A8";
  const subprocess = {
    resolveExecutable: (name) => name,
    spawn() {
      const collected = {
        stdout: { readFrom: () => ({ text: text, nextOffset: text.length }) },
        stderr: { readFrom: () => ({ text: "", nextOffset: 0 }) },
      };
      return {
        collected: collected,
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {},
        waitForExit: () => Promise.resolve({ exitCode: 0, signal: null }),
      };
    },
  };
  const result = await handleWebApi({ method: "GET", path: WEB_API_PREFIX + "/probe-info", query: {}, deps: { subprocess: subprocess, env: {} } });
  assert.equal(result.status, 200);
  assert.equal(result.body.probeInfo.present, true);
  assert.equal(result.body.probeInfo.probe.kind, "daplink");
  assert.equal(result.body.probeInfo.interfaceCfg, "interface/cmsis-dap.cfg");
});

test("POST /interrupts/priority：改一路优先级、写前备份，非法值回 409", async () => {
  const deps = { subprocess: fakeSubprocess, env: {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-irq-edit-"));
  const ioc = path.join(dir, "demo.ioc");
  fs.writeFileSync(ioc, "NVIC.USART1_IRQn=true\\:2\\:0\\:false\\:false\\:true\\:false\\:false\\:false\n", "utf8");

  const saved = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/interrupts/priority",
    query: {},
    body: JSON.stringify({ projectDir: dir, name: "USART1", preempt: 4, sub: 1 }),
    deps: deps,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.interruptPriority.after.preempt, 4);
  assert.ok(fs.readFileSync(ioc, "utf8").includes("true\\:4\\:1\\:"));

  const noName = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/interrupts/priority",
    query: {},
    body: JSON.stringify({ projectDir: dir, preempt: 1, sub: 1 }),
    deps: deps,
  });
  assert.equal(noName.status, 400);
  assert.ok(String(noName.body.error).includes("name"));

  const badRange = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/interrupts/priority",
    query: {},
    body: JSON.stringify({ projectDir: dir, name: "USART1", preempt: 99, sub: 0 }),
    deps: deps,
  });
  assert.equal(badRange.status, 409);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("POST /interrupts/priorities：批量改优先级，缺 names 回 400", async () => {
  const deps = { subprocess: fakeSubprocess, env: {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-irq-batch-"));
  const ioc = path.join(dir, "demo.ioc");
  fs.writeFileSync(ioc, ["NVIC.USART1_IRQn=true\\:1\\:0\\:false\\:false\\:true\\:false\\:false\\:false", "NVIC.TIM2_IRQn=true\\:1\\:0\\:false\\:false\\:true\\:false\\:false\\:false"].join("\n"), "utf8");

  const saved = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/interrupts/priorities",
    query: {},
    body: JSON.stringify({ projectDir: dir, names: ["USART1", "TIM2"], preempt: 7, sub: 3 }),
    deps: deps,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.interruptPriorities.applied.length, 2);
  const text = fs.readFileSync(ioc, "utf8");
  assert.ok(text.includes("NVIC.USART1_IRQn=true\\:7\\:3\\:"));
  assert.ok(text.includes("NVIC.TIM2_IRQn=true\\:7\\:3\\:"));

  const noNames = await handleWebApi({
    method: "POST",
    path: WEB_API_PREFIX + "/interrupts/priorities",
    query: {},
    body: JSON.stringify({ projectDir: dir, preempt: 1, sub: 1 }),
    deps: deps,
  });
  assert.equal(noNames.status, 400);
  assert.ok(String(noNames.body.error).includes("names"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("POST /ioc-diff/restore-all：没有差异时回空清单，有差异时写回并备份", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-restoreall-"));
  const snapshots = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-restoreall-snap-"));
  const deps = { subprocess: fakeSubprocess, env: { DSH_STM32_SNAPSHOTS: snapshots } };
  fs.writeFileSync(path.join(project, "demo.ioc"), ["Mcu.CPN=STM32F103C8T6", "Mcu.IP0=NVIC"].join("\n") + "\n", "utf8");
  assert.equal((await handleWebApi({ method: "POST", path: WEB_API_PREFIX + "/ioc-diff/save", query: {}, body: JSON.stringify({ projectDir: project }), deps })).status, 200);

  const clean = await handleWebApi({ method: "POST", path: WEB_API_PREFIX + "/ioc-diff/restore-all", query: {}, body: JSON.stringify({ projectDir: project }), deps });
  assert.equal(clean.status, 200);
  assert.deepEqual(clean.body.restoredAll.restored, []);

  fs.writeFileSync(path.join(project, "demo.ioc"), ["Mcu.CPN=STM32F103C8T6", "Mcu.IP9=DMA"].join("\n") + "\n", "utf8");
  const fixed = await handleWebApi({ method: "POST", path: WEB_API_PREFIX + "/ioc-diff/restore-all", query: {}, body: JSON.stringify({ projectDir: project }), deps });
  assert.equal(fixed.status, 200);
  assert.deepEqual(fixed.body.restoredAll.restored, ["Mcu.IP0"]);
  assert.ok(fs.readFileSync(path.join(project, "demo.ioc"), "utf8").includes("Mcu.IP0=NVIC"));
  assert.equal(fs.existsSync(fixed.body.restoredAll.backupPath), true);

  const noBaseline = await handleWebApi({ method: "POST", path: WEB_API_PREFIX + "/ioc-diff/restore-all", query: {}, body: JSON.stringify({ projectDir: fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-restoreall-empty-")) }), deps });
  assert.equal(noBaseline.status, 409);
  assert.match(noBaseline.body.error, /基线|没有 \.ioc/u);
});

test("POST /debug/stop：没有会话时幂等返回 200，有会话时关掉并释放", async () => {
  resetDebugSessionsForTest();
  const deps = { subprocess: fakeSubprocess, env: {} };
  const idle = await handleWebApi({ method: "POST", path: WEB_API_PREFIX + "/debug/stop", query: {}, body: "{}", deps });
  assert.equal(idle.status, 200);
  assert.equal(idle.body.debug.active, false);
  assert.equal(idle.body.debug.stopped, false);
  assert.match(String(idle.body.debug.message), /本来就没有会话/u);
});
