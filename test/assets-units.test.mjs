// stm32_assets（资源包下载器）单元测试：全部离线。
//
// 怎么做到"一次网络都不发"：registerAssets() 接受 options.fetchImpl（生产不传），
// 测试注入一个假 fetch —— 它按 ASSETS_SOURCES 的真实 baseUrl 前缀切出相对路径，
// 从内存里的 Map 取内容，也可以按 host 假装 404（模拟某条线路不通）。
// 于是"多源回退""全源失败"这些分支都被真实走到，却不碰任何 socket。
// 本地目录也用 DSH_STM32_ASSETS 指到 mkdtemp 出来的临时目录，不碰真实 home。
//
// 运行：node --test test/assets-units.test.mjs（需先 npm run build）

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ASSETS_SOURCES,
  assetsRootInfo,
  fetchManifest,
  listInstalledVersions,
  localAssetsRoot,
  parseManifest,
  pruneOldVersions,
  readLocalManifest,
  resolveAssetFile,
  sha256Hex,
  verifyAndInstall,
  verifyInstalled,
} from "../lib/engine/assets.js";
import { ASSETS_TOOL, outputSchema, registerAssets } from "../lib/tools/assets.js";

/* ------------------------------ 宿主契约守卫 ------------------------------ */

/** 与 test/schema-guard.mjs 同语义的精简版：additionalProperties:false 严格、不许 null/undefined。 */
function checkSchema(schema, value, path = "value", problems = []) {
  if (schema === undefined) return problems;
  if (value === undefined) {
    problems.push(path + " 是 undefined（宿主 required 会失败）");
    return problems;
  }
  if (value === null) {
    problems.push(path + " 是 null（宿主不接受 null）");
    return problems;
  }
  const type = schema.type;
  if (type === "object") {
    if (typeof value !== "object" || Array.isArray(value)) {
      problems.push(path + " 应为 object（实际 " + typeof value + "）");
      return problems;
    }
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) problems.push(path + "." + key + " 缺失（schema required）");
    }
    for (const [key, item] of Object.entries(value)) {
      if (!Object.prototype.hasOwnProperty.call(props, key)) {
        problems.push(path + "." + key + " 未在 schema 里声明（additionalProperties:false 会拒收）");
        continue;
      }
      checkSchema(props[key], item, path + "." + key, problems);
    }
    return problems;
  }
  if (type === "array") {
    if (!Array.isArray(value)) {
      problems.push(path + " 应为 array（实际 " + typeof value + "）");
      return problems;
    }
    value.forEach((item, index) => checkSchema(schema.items, item, path + "[" + String(index) + "]", problems));
    return problems;
  }
  if (type === "string" && typeof value !== "string") problems.push(path + " 应为 string（实际 " + typeof value + "）");
  if (type === "number" && (typeof value !== "number" || Number.isNaN(value))) problems.push(path + " 应为 number（实际 " + typeof value + "）");
  if (type === "boolean" && typeof value !== "boolean") problems.push(path + " 应为 boolean（实际 " + typeof value + "）");
  return problems;
}

function reportProblems(label, schema, value) {
  const problems = checkSchema(schema, value);
  if (problems.length > 0) assert.fail(label + " 的输出不符合宿主契约：\n  - " + problems.join("\n  - "));
}

/* ------------------------------ 假仓库与假 fetch ------------------------------ */

const CORE_GLOBS = ["device/**", "ioc/**", "ld/**"];
const FULL_GLOBS = [...CORE_GLOBS, "chipdb/**", "diagrams/**"];

const CORPUS = [
  { path: "device/f1/chips.json", body: '{"chips":[{"cpn":"STM32F103C8T6"}]}\n' },
  { path: "device/f1/memory.json", body: '{"devices":[]}\n' },
  { path: "device/f1/svd/103.json", body: '{"peripherals":[]}\n' },
  { path: "ioc/minimal/STM32F103C8T6.ioc", body: "Mcu.CPN=STM32F103C8T6\n" },
  { path: "ld/f1/STM32F103C8T6_FLASH.ld", body: "MEMORY { FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 64K }\n" },
  { path: "chipdb/f1/TEST.xml", body: "<device/>\n" },
  { path: "diagrams/f1/TEST.svg", body: "<svg/>\n" },
];
const CORE_COUNT = 5;

function makeManifest({ version = "2026.10.30-1", files = CORPUS, profiles = { core: CORE_GLOBS, full: FULL_GLOBS } } = {}) {
  const entries = files.map((file) => ({
    path: file.path,
    bytes: Buffer.byteLength(file.body),
    sha256: sha256Hex(Buffer.from(file.body)),
    source: "test",
    profile: file.path.startsWith("chipdb/") || file.path.startsWith("diagrams/") ? "full" : "core",
  }));
  return { name: "dsh-stm32-assets", version, schema: 2, profiles, files: entries, skipped: [] };
}

/** 内存里的"源仓库"：相对路径 → 内容。 */
function servedMap(files = CORPUS, manifest = makeManifest()) {
  const served = new Map();
  served.set("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  for (const file of files) served.set(file.path, file.body);
  return served;
}

/**
 * 假 fetch：不联网。按 ASSETS_SOURCES 的 baseUrl 前缀切出相对路径后从 served 取内容；
 * failHosts 里的 host 一律回 404（用来测换源）；corrupt 里的路径换成坏内容（用来测 sha256）。
 */
function makeFakeFetch({ served = new Map(), failHosts = [], corrupt = new Map() } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const urlText = String(url);
    calls.push(urlText);
    const source = ASSETS_SOURCES.find((item) => urlText.startsWith(item.baseUrl));
    if (source === undefined) return new Response("unknown source", { status: 500 });
    if (failHosts.includes(new URL(urlText).host)) return new Response("not found", { status: 404 });
    const rel = decodeURIComponent(urlText.slice(source.baseUrl.length));
    if (!served.has(rel)) return new Response("not found", { status: 404 });
    const body = corrupt.has(rel) ? corrupt.get(rel) : served.get(rel);
    return new Response(body, { status: 200 });
  };
  return { fetchImpl, calls };
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "dsh-assets-"));
}

function envFor(root) {
  return { DSH_STM32_ASSETS: root };
}

/** 用假 ctx 收集工具定义（与宿主一致的注册方式），并注入假 fetch / 假环境。 */
function toolFor({ env, fetchImpl }) {
  const defs = new Map();
  const ctx = {
    tools: {
      register(definition) {
        defs.set(definition.name, definition);
        return () => undefined;
      },
    },
  };
  registerAssets(ctx, { env, ...(fetchImpl === undefined ? {} : { fetchImpl }) });
  const definition = defs.get(ASSETS_TOOL);
  assert.ok(definition, "stm32_assets 应已注册");
  return definition;
}

async function runTool(options, args) {
  const definition = toolFor(options);
  const value = await definition.execute(args, { signal: new AbortController().signal });
  // 每次工具调用都按 output.schema 校验：形状不合规在这里就炸，不留给宿主。
  reportProblems("stm32_assets(" + String(args.action ?? "list") + ")", outputSchema, value);
  return value;
}

/** 直接走引擎装一版（不经过工具层）。 */
async function installVersion(env, version, profile = "core") {
  const manifest = makeManifest({ version });
  const served = servedMap(CORPUS, manifest);
  const fake = makeFakeFetch({ served });
  const result = await verifyAndInstall({
    manifest,
    manifestText: served.get("manifest.json"),
    profile,
    env,
    fetchImpl: fake.fetchImpl,
  });
  assert.equal(result.ok, true, "夹具安装应成功：" + result.message);
  return { result, fake, manifest };
}

/* ------------------------------ 用例 ------------------------------ */

test("fetchManifest：假 fetch 从主源拉到 manifest，不联网也不换源", async () => {
  const manifest = makeManifest();
  const fake = makeFakeFetch({ served: servedMap(CORPUS, manifest) });
  const result = await fetchManifest({ sources: [ASSETS_SOURCES[0]], fetchImpl: fake.fetchImpl });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.source.id, "github");
  assert.equal(result.manifest.version, "2026.10.30-1");
  assert.equal(result.manifest.files.length, CORPUS.length);
  assert.deepEqual(result.attempts, [], "第一源就通，不应有失败记录");
  assert.equal(fake.calls.length, 1);
  assert.ok(fake.calls[0].startsWith(ASSETS_SOURCES[0].baseUrl), "请求应打在 github raw 上：" + fake.calls[0]);
});

test("refresh（默认 profile=core）逐文件 sha256 校验后装好，不碰 chipdb/diagrams", async () => {
  const root = tempRoot();
  try {
    const manifest = makeManifest();
    const fake = makeFakeFetch({ served: servedMap(CORPUS, manifest) });
    const value = await runTool({ env: envFor(root), fetchImpl: fake.fetchImpl }, { action: "refresh" });
    assert.equal(value.ok, true, value.message);
    assert.equal(value.profile, "core");
    assert.equal(value.fileCount, CORE_COUNT);
    assert.ok(value.files.every((file) => file.status === "ok"), "每个文件都应通过 sha256");
    assert.match(value.message, /github/u, "报告里要写清走了哪个源");
    const versionDir = join(root, manifest.version);
    assert.ok(existsSync(join(versionDir, "device/f1/chips.json")), "core 文件应落盘");
    assert.ok(existsSync(join(versionDir, "manifest.json")), "manifest 原文应随包保存");
    assert.ok(existsSync(join(versionDir, "install.json")), "安装记录应写盘");
    assert.equal(existsSync(join(versionDir, "chipdb/f1/TEST.xml")), false, "core 不该下 chipdb");
    assert.equal(existsSync(join(versionDir, "diagrams/f1/TEST.svg")), false, "core 不该下 diagrams");
    assert.ok(
      fake.calls.every((url) => !url.includes("chipdb") && !url.includes("diagrams")),
      "core 安装时连请求都不该发到 chipdb/diagrams：" + fake.calls.join(" | "),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sha256 不符：整次拒绝、删半成品，已装版本一个字节不动", async () => {
  const root = tempRoot();
  try {
    const env = envFor(root);
    const manifest = makeManifest();
    const first = await runTool({ env, fetchImpl: makeFakeFetch({ served: servedMap(CORPUS, manifest) }).fetchImpl }, { action: "refresh" });
    assert.equal(first.ok, true, first.message);
    const versionDir = join(root, manifest.version);
    const chipsPath = join(versionDir, "device/f1/chips.json");
    const original = readFileSync(chipsPath, "utf8");

    const corrupt = new Map([["device/f1/chips.json", '{"chips":["evil"]}\n']]);
    const fake = makeFakeFetch({ served: servedMap(CORPUS, manifest), corrupt });
    const value = await runTool({ env, fetchImpl: fake.fetchImpl }, { action: "refresh" });
    assert.equal(value.ok, false, "哈希不符必须整次失败");
    assert.match(value.message, /校验失败/u);
    assert.match(value.message, /device\/f1\/chips\.json/u, "要点名是哪个文件");
    assert.match(value.message, /sha256 对不上/u);
    assert.ok(value.offlineFallback.includes("chip-table.json"), "失败时要给离线兜底");
    assert.equal(readFileSync(chipsPath, "utf8"), original, "半成品不能覆盖已装好的文件");
    assert.equal(listInstalledVersions(env).length, 1, "仍然只有一版可用的安装");
    assert.deepEqual(readdirSync(root).filter((name) => name.includes(".tmp-")), [], "临时目录必须删干净");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manifest 列了但源上没有：失败点名文件与 404，且不留下版本目录", async () => {
  const root = tempRoot();
  try {
    const manifest = makeManifest();
    const served = servedMap(CORPUS, manifest);
    served.delete("ld/f1/STM32F103C8T6_FLASH.ld");
    const value = await runTool({ env: envFor(root), fetchImpl: makeFakeFetch({ served }).fetchImpl }, { action: "refresh" });
    assert.equal(value.ok, false);
    assert.match(value.message, /ld\/f1\/STM32F103C8T6_FLASH\.ld/u);
    assert.ok(value.attempts.some((line) => line.includes("404")), "尝试记录里要有 404：" + value.attempts.join(" | "));
    assert.deepEqual(readdirSync(root), [], "失败不应留下任何东西");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("多源回退：GitHub 404 后自动换 jsDelivr，报告写明实际源", async () => {
  const root = tempRoot();
  try {
    const manifest = makeManifest();
    const fake = makeFakeFetch({ served: servedMap(CORPUS, manifest), failHosts: ["raw.githubusercontent.com"] });
    const value = await runTool({ env: envFor(root), fetchImpl: fake.fetchImpl }, { action: "refresh" });
    assert.equal(value.ok, true, value.message);
    assert.ok(value.source.includes("jsdelivr"), "实际来源应是 jsdelivr：" + value.source);
    assert.ok(
      value.attempts.some((line) => line.includes("github") && line.includes("404")),
      "要记录第一源为什么不行：" + value.attempts.join(" | "),
    );
    assert.ok(value.files.every((file) => file.detail.includes("jsdelivr")), "每个文件都要标出实际来源");
    assert.ok(existsSync(join(root, manifest.version, "device/f1/chips.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("全源失败：ok=false、三个源都记下来，并明确说内置表仍可建工程", async () => {
  const root = tempRoot();
  try {
    const fake = makeFakeFetch({
      served: servedMap(CORPUS),
      failHosts: ["raw.githubusercontent.com", "cdn.jsdelivr.net", "raw.gitcode.com"],
    });
    const value = await runTool({ env: envFor(root), fetchImpl: fake.fetchImpl }, { action: "refresh" });
    assert.equal(value.ok, false);
    assert.equal(value.attempts.length, 3, "三个源都要有尝试记录：" + value.attempts.join(" | "));
    assert.ok(value.offlineFallback.includes("chip-table.json"));
    assert.ok(value.offlineFallback.includes("stm32f1.ts"));
    assert.ok(value.offlineFallback.includes("stm32_project_create"), "要指出还能用哪个工具建工程");
    assert.match(value.message, /刷新失败/u);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("profile=full 才装 chipdb/diagrams；core 装过再 full 会合并 profiles", async () => {
  const root = tempRoot();
  try {
    const env = envFor(root);
    const manifest = makeManifest();
    const coreFake = makeFakeFetch({ served: servedMap(CORPUS, manifest) });
    const core = await runTool({ env, fetchImpl: coreFake.fetchImpl }, { action: "refresh" });
    assert.equal(core.ok, true, core.message);
    const fullFake = makeFakeFetch({ served: servedMap(CORPUS, manifest) });
    const full = await runTool({ env, fetchImpl: fullFake.fetchImpl }, { action: "refresh", profile: "full" });
    assert.equal(full.ok, true, full.message);
    assert.equal(full.fileCount, CORPUS.length);
    assert.ok(fullFake.calls.some((url) => url.includes("chipdb/")), "full 才请求 chipdb");
    const versionDir = join(root, manifest.version);
    assert.ok(existsSync(join(versionDir, "chipdb/f1/TEST.xml")));
    assert.ok(existsSync(join(versionDir, "diagrams/f1/TEST.svg")));
    const versions = listInstalledVersions(env);
    assert.equal(versions.length, 1);
    assert.deepEqual(versions[0].profiles, ["core", "full"], "两次安装的 profile 应合并记录");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prune：只留当前与上一版，旧版本与 .tmp- 残留一起清", async () => {
  const root = tempRoot();
  try {
    const env = envFor(root);
    await installVersion(env, "2026.9.1");
    await installVersion(env, "2026.10.30-1");
    await installVersion(env, "2026.11.2");
    // 模拟下载中断留下的半成品目录
    const stale = join(root, "2026.9.1.tmp-999-1");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "half.bin"), "half");

    const pruned = pruneOldVersions(env, 2);
    assert.deepEqual(pruned.removed, ["2026.9.1"]);
    assert.deepEqual(pruned.kept, ["2026.11.2", "2026.10.30-1"]);
    assert.equal(existsSync(join(root, "2026.9.1")), false);
    assert.equal(existsSync(join(root, "2026.11.2")), true);
    assert.equal(existsSync(join(root, "2026.10.30-1")), true);
    assert.deepEqual(readdirSync(root).filter((name) => name.includes(".tmp-")), [], ".tmp- 残留要清掉");
    assert.ok(pruned.reclaimedBytes > 0, "要报告回收了多少字节");
    const versions = listInstalledVersions(env);
    assert.equal(versions.length, 2);
    assert.equal(versions[0].version, "2026.11.2");
    assert.equal(versions[0].current, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DSH_STM32_ASSETS 覆盖安装根；不设时退回 USERPROFILE/.dsh-stm32/assets", async () => {
  const root = tempRoot();
  try {
    assert.equal(localAssetsRoot({ DSH_STM32_ASSETS: root }), root);
    assert.equal(assetsRootInfo({ DSH_STM32_ASSETS: root }).origin, "DSH_STM32_ASSETS");
    const fakeHome = join(tmpdir(), "fake-home-" + String(process.pid));
    assert.equal(localAssetsRoot({ USERPROFILE: fakeHome }), join(fakeHome, ".dsh-stm32", "assets"));
    assert.equal(assetsRootInfo({ USERPROFILE: fakeHome }).origin, "USERPROFILE");

    // 覆盖不只是"算路径"：实际安装也必须落在覆盖目录里。
    const manifest = makeManifest();
    const value = await runTool({ env: envFor(root), fetchImpl: makeFakeFetch({ served: servedMap(CORPUS, manifest) }).fetchImpl }, { action: "refresh" });
    assert.equal(value.ok, true, value.message);
    assert.ok(existsSync(join(root, manifest.version, "device/f1/chips.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("action=list 形状：没装时可用、装好后报版本/文件/占用", async () => {
  const root = tempRoot();
  try {
    const env = envFor(root);
    const empty = await runTool({ env }, {});
    assert.equal(empty.action, "list");
    assert.equal(empty.ok, true);
    assert.deepEqual(empty.versions, []);
    assert.ok(empty.offlineFallback.includes("chip-table.json"), "没装时要提内置表");

    await installVersion(env, "2026.10.30-1");
    const listed = await runTool({ env }, { action: "list" });
    assert.equal(listed.ok, true);
    assert.equal(listed.version, "2026.10.30-1");
    assert.equal(listed.versions.length, 1);
    assert.equal(listed.versions[0].current, true);
    assert.equal(listed.fileCount, CORE_COUNT);
    assert.ok(listed.files.every((file) => file.status === "present"));
    assert.ok(listed.totalBytes > 0);
    assert.match(listed.message, /2026\.10\.30-1/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("action=verify：装好后逐个 sha256 通过；篡改一个文件会报 changed 并给出修复动作", async () => {
  const root = tempRoot();
  try {
    const env = envFor(root);
    const installed = await installVersion(env, "2026.10.30-1");
    const good = await runTool({ env }, { action: "verify" });
    assert.equal(good.ok, true, good.message);
    assert.equal(good.fileCount, CORE_COUNT);
    assert.ok(good.files.every((file) => file.status === "ok"));

    writeFileSync(join(root, "2026.10.30-1/device/f1/chips.json"), '{"chips":[]}\n');
    const bad = await runTool({ env }, { action: "verify" });
    assert.equal(bad.ok, false);
    const changed = bad.files.find((file) => file.status === "changed");
    assert.ok(changed, "要指出哪个文件变了：" + JSON.stringify(bad.files));
    assert.equal(changed.path, "device/f1/chips.json");
    assert.match(bad.message, /refresh/u, "要告诉用户怎么修");
    assert.equal(installed.result.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("action=prune 的工具形状：三个版本清理后剩两个，schema 仍合规", async () => {
  const root = tempRoot();
  try {
    const env = envFor(root);
    await installVersion(env, "2026.9.1");
    await installVersion(env, "2026.10.30-1");
    await installVersion(env, "2026.11.2");
    const value = await runTool({ env }, { action: "prune" });
    assert.equal(value.action, "prune");
    assert.equal(value.ok, true);
    assert.equal(value.versions.length, 2);
    assert.equal(value.version, "2026.11.2");
    assert.match(value.message, /回收/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveAssetFile：core 文件给本地路径，不属于该 profile 的文件被明确拒绝", async () => {
  const root = tempRoot();
  try {
    const env = envFor(root);
    await installVersion(env, "2026.10.30-1");
    const okFile = resolveAssetFile("core", "device/f1/chips.json", env);
    assert.equal(okFile.ok, true, okFile.error);
    assert.ok(existsSync(okFile.path));
    assert.equal(okFile.version, "2026.10.30-1");

    const notInCore = resolveAssetFile("core", "chipdb/f1/TEST.xml", env);
    assert.equal(notInCore.ok, false);
    assert.match(notInCore.error, /profile=full/u, "要说清它属于 full：" + notInCore.error);

    await installVersion(env, "2026.10.30-1", "full");
    const fullFile = resolveAssetFile("full", "chipdb/f1/TEST.xml", env);
    assert.equal(fullFile.ok, true, fullFile.error);
    assert.ok(existsSync(fullFile.path));

    // 没装任何东西的新环境：要提示 refresh，而不是抛异常。
    const emptyRoot = tempRoot();
    try {
      const missing = resolveAssetFile("core", "device/f1/chips.json", envFor(emptyRoot));
      assert.equal(missing.ok, false);
      assert.match(missing.error, /refresh/u);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("本地 manifest 坏了不抛：readLocalManifest / verify 都给出可修复的 error", async () => {
  const root = tempRoot();
  try {
    const env = envFor(root);
    await installVersion(env, "2026.10.30-1");
    writeFileSync(join(root, "2026.10.30-1/manifest.json"), "{ not json");
    const state = readLocalManifest(env);
    assert.equal(state.manifest, null);
    assert.match(state.error, /坏了/u);
    assert.match(state.error, /refresh/u);
    const verified = verifyInstalled({ profile: "core", env });
    assert.equal(verified.ok, false);
    assert.match(verified.message, /refresh/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parseManifest：缺 sha256 / 重复 path / 绝对路径都拒绝（不抛异常）", () => {
  const sha = sha256Hex(Buffer.from("x"));
  const good = parseManifest(JSON.stringify({ version: "1", files: [{ path: "a.json", bytes: 1, sha256: sha }] }));
  assert.ok(good.manifest);
  assert.equal(good.manifest.files[0].sha256, sha);

  const noHash = parseManifest(JSON.stringify({ version: "1", files: [{ path: "a.json", bytes: 1 }] }));
  assert.equal(noHash.manifest, null);
  assert.match(noHash.error, /sha256/u);

  const dup = parseManifest(
    JSON.stringify({ version: "1", files: [{ path: "a.json", bytes: 1, sha256: sha }, { path: "a.json", bytes: 1, sha256: sha }] }),
  );
  assert.equal(dup.manifest, null);
  assert.match(dup.error, /重复/u);

  const absolute = parseManifest(JSON.stringify({ version: "1", files: [{ path: "C:/evil.json", bytes: 1, sha256: sha }] }));
  assert.equal(absolute.manifest, null);
  assert.match(absolute.error, /不合法/u);
});
