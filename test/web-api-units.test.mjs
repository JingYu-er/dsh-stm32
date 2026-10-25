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

test("WEB_API_PATHS：六条路由都在前缀下，且没有重复", () => {
  assert.equal(WEB_API_PATHS.length, 6);
  assert.equal(new Set(WEB_API_PATHS).size, 6);
  for (const route of WEB_API_PATHS) {
    assert.equal(route.startsWith(WEB_API_PREFIX + "/"), true, route);
  }
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/config"), true);
  assert.equal(WEB_API_PATHS.includes(WEB_API_PREFIX + "/install/state"), true);
});
