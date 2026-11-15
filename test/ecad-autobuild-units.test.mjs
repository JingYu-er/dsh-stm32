import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AUTO_BUILD_MIN_INTERVAL_MS,
  circuitDirty,
  decideAutoBuild,
  readAutoState,
  runAutoBuild,
  writeAutoState,
} from "../lib/engine/ecad/autobuild.js";
import {
  ecadRuntimeDir,
  ensureEcadRuntime,
  linkRuntimeIntoProject,
  readRuntimeMeta,
  runtimeInstallMode,
  runtimeReady,
} from "../lib/engine/ecad/runtime.js";

function tempRoot(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function fakeRuntime(root) {
  // 只造出「就绪」所需的两个文件：判断只认 node_modules/tscircuit/cli.mjs。
  mkdirSync(join(root, "node_modules", "tscircuit"), { recursive: true });
  writeFileSync(join(root, "node_modules", "tscircuit", "cli.mjs"), "// stub\n");
  writeFileSync(join(root, "package.json"), "{}\n");
}

function fakeWorkspace(root) {
  const workspace = {
    projectDir: join(root, "proj"),
    root: join(root, "proj", "hardware"),
    circuitDir: join(root, "proj", "hardware", "circuit"),
    kicadDir: join(root, "proj", "hardware", "kicad"),
    libsDir: join(root, "proj", "hardware", "libs"),
    outDir: join(root, "proj", "hardware", "out"),
    initialized: true,
  };
  mkdirSync(workspace.circuitDir, { recursive: true });
  mkdirSync(workspace.kicadDir, { recursive: true });
  mkdirSync(workspace.libsDir, { recursive: true });
  return workspace;
}

test("运行时目录：环境变量优先，其次用户主目录", () => {
  assert.equal(ecadRuntimeDir({ DSH_STM32_ECAD_RUNTIME: "D:/rt" }), "D:/rt");
  assert.equal(ecadRuntimeDir({ DSH_STM32_HOME: "D:/home" }), join("D:/home", "ecad-runtime"));
  const fallback = ecadRuntimeDir({ USERPROFILE: "C:/Users/x" });
  assert.match(fallback, /ecad-runtime$/u);
});

test("运行时就绪判定与元数据回写", async () => {
  const { dir, cleanup } = tempRoot("dsh-rt-");
  try {
    assert.equal(runtimeReady(dir), false);
    const asked = await ensureEcadRuntime({ subprocess: {}, dir, mode: "ask" });
    assert.equal(asked.ok, false);
    assert.match(asked.error, /npm(\.cmd)? install/u);
    fakeRuntime(dir);
    assert.equal(runtimeReady(dir), true);
    assert.equal(readRuntimeMeta(dir), null);
  } finally {
    cleanup();
  }
});

test("依赖联接：只在工程里造出指向共享运行时的 node_modules", () => {
  const { dir, cleanup } = tempRoot("dsh-link-");
  try {
    const runtime = join(dir, "runtime");
    fakeRuntime(runtime);
    const circuitDir = join(dir, "proj", "hardware", "circuit");
    mkdirSync(circuitDir, { recursive: true });
    writeFileSync(join(circuitDir, "package.json"), "{}\n");
    const first = linkRuntimeIntoProject(circuitDir, runtime);
    assert.equal(first.ok, true);
    assert.equal(first.kind, "created");
    // 联接指向运行时的 node_modules，所以判定要落在工程目录上（它有 node_modules/tscircuit）。
    assert.equal(runtimeReady(circuitDir), true);
    const second = linkRuntimeIntoProject(circuitDir, runtime);
    assert.equal(second.kind, "exists");
  } finally {
    cleanup();
  }
});

test("安装模式：环境变量解析为 auto / ask / off", () => {
  assert.equal(runtimeInstallMode({ DSH_STM32_ECAD_AUTO_INSTALL: "auto" }), "auto");
  assert.equal(runtimeInstallMode({ DSH_STM32_ECAD_AUTO_INSTALL: "off" }), "off");
  assert.equal(runtimeInstallMode({}), "ask");
});

test("脏判定：没有产物算脏，源码更新算脏，产物更新算干净", () => {
  const { dir, cleanup } = tempRoot("dsh-dirty-");
  try {
    const workspace = fakeWorkspace(dir);
    assert.equal(circuitDirty(workspace).dirty, false);
    writeFileSync(join(workspace.circuitDir, "board.circuit.tsx"), "export default 1\n");
    const first = circuitDirty(workspace);
    assert.equal(first.dirty, true);
    assert.equal(first.reason, "还没有可用产物");
    writeFileSync(join(workspace.kicadDir, "board.kicad_pcb"), "(kicad_pcb)\n");
    assert.equal(circuitDirty(workspace).dirty, false);
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(workspace.circuitDir, "board.circuit.tsx"), later, later);
    const again = circuitDirty(workspace);
    assert.equal(again.dirty, true);
    assert.equal(again.reason, "源码比产物新");
  } finally {
    cleanup();
  }
});

test("自动构建决策：干净不跑、同回合不跑、间隔不足不跑", () => {
  const dirty = { dirty: true, reason: "源码比产物新", sourceMtime: 10, productMtime: 5 };
  const clean = { dirty: false, reason: "产物已是最新", sourceMtime: 5, productMtime: 10 };
  const now = 1_000_000;
  assert.equal(decideAutoBuild({ dirty: clean, state: null, now, turn: "s1:1" }).go, false);
  assert.equal(decideAutoBuild({ dirty, state: null, now, turn: "s1:1" }).go, true);
  const state = { lastAttemptAt: now - 1_000, lastOk: false, lastError: "", lastDurationMs: 0, lastTurn: "s1:1" };
  assert.equal(decideAutoBuild({ dirty, state, now, turn: "s1:1" }).go, false);
  const old = { ...state, lastAttemptAt: now - AUTO_BUILD_MIN_INTERVAL_MS - 1 };
  assert.equal(decideAutoBuild({ dirty, state: old, now, turn: "s1:1" }).go, false);
  assert.equal(decideAutoBuild({ dirty, state: old, now, turn: "s1:2" }).go, true);
});

test("自动构建：通过后挂待导出标记，导出动作清掉（S137）", () => {
  const dir = mkdtempSync(join(tmpdir(), "ecad-state-"));
  const base = { lastAttemptAt: 1, lastOk: true, lastError: "", lastDurationMs: 5, lastTurn: "t1", pendingExport: true };
  writeAutoState(dir, base);
  assert.equal(readAutoState(dir).pendingExport, true);
  writeAutoState(dir, { ...base, pendingExport: false });
  assert.equal(readAutoState(dir).pendingExport, false);
  rmSync(dir, { recursive: true, force: true });
});

test("状态文件读写往返；缺依赖时不跑构建", async () => {
  const { dir, cleanup } = tempRoot("dsh-state-");
  try {
    const workspace = fakeWorkspace(dir);
    writeFileSync(join(workspace.circuitDir, "board.circuit.tsx"), "export default 1\n");
    assert.equal(readAutoState(workspace.projectDir), null);
    writeAutoState(workspace.projectDir, { lastAttemptAt: 42, lastOk: true, lastError: "", lastDurationMs: 7, lastTurn: "s1:1" });
    const state = readAutoState(workspace.projectDir);
    assert.equal(state?.lastAttemptAt, 42);
    assert.equal(state?.lastOk, true);
    const result = await runAutoBuild({ subprocess: {}, toolchain: { bun: "bun" }, workspace, turn: "s2:1" });
    assert.equal(result.ran, false);
    assert.match(result.reason, /依赖还没装/u);
  } finally {
    cleanup();
  }
});
