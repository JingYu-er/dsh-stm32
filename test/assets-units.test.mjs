// stm32_assets（插件内置资源）单元测试：全部离线，不碰真实 assets/ 之外的任何目录。
//
// 2026-11 起资源随插件包发布（assets/ 是 flat 布局：manifest.json 与 device/、ioc/ 同层），
// 下载器已经删除。这里覆盖四件事：flat/历史布局的发现、manifest 校验、逐文件完整性检查、
// 以及"内置根绝不被 prune 删除"这条安全边界。
//
// 运行：node --test test/assets-units.test.mjs（需先 npm run build）

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  assetsRootInfo,
  bundledAssetsRoot,
  ensureAssets,
  listInstalledVersions,
  parseManifest,
  profileFiles,
  pruneOldVersions,
  readLocalManifest,
  resolveAssetFile,
  sha256Hex,
  verifyInstalled,
} from "../lib/engine/assets.js";
import { ASSETS_TOOL, outputSchema, registerAssets } from "../lib/tools/assets.js";

/* ------------------------------ 宿主契约守卫 ------------------------------ */

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

/* ------------------------------ 夹具 ------------------------------ */

const CORE_GLOBS = ["device/**", "ioc/**", "ld/**"];
const FULL_GLOBS = [...CORE_GLOBS, "startup/**", "headers/**"];
const CORPUS = [
  { path: "device/f1/chips.json", body: '{"chips":[{"cpn":"STM32F103C8T6","flashBytes":65536,"ramBytes":20480}]}\n' },
  { path: "device/f1/svd/103.json", body: '{"peripherals":[]}\n' },
  { path: "ioc/minimal/STM32F103C8Tx.ioc", body: "Mcu.CPN=STM32F103C8T6\n" },
  { path: "ld/f1/STM32F103C8Tx_FLASH.ld", body: "MEMORY { FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 64K }\n" },
  { path: "headers/f1/stm32f1xx.h", body: "#ifndef __STM32F1XX_H\n#endif\n" },
  { path: "startup/f1/startup_stm32f103xb.s", body: ".syntax unified\n_estack: .word 0\n" },
];
const CORE_COUNT = CORPUS.filter((file) => !file.path.startsWith("headers/") && !file.path.startsWith("startup/")).length;

function makeManifest({ version = "2026.11.09-1", files = CORPUS } = {}) {
  const entries = files.map((file) => ({
    path: file.path,
    bytes: Buffer.byteLength(file.body),
    sha256: sha256Hex(Buffer.from(file.body)),
    source: "test",
    profile: file.path.startsWith("headers/") || file.path.startsWith("startup/") ? "full" : "core",
  }));
  return { name: "dsh-stm32-assets", version, schema: 2, profiles: { core: CORE_GLOBS, full: FULL_GLOBS }, files: entries, skipped: [] };
}

/** 在 dir 里写一份 flat 资源（manifest.json 与 device/… 同层）。 */
function writeFlat(dir, { version = "2026.11.09-1", files = CORPUS, skip = [] } = {}) {
  const manifest = makeManifest({ version, files });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  for (const file of files) {
    if (skip.includes(file.path)) continue;
    const target = join(dir, ...file.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.body);
  }
  return manifest;
}

/** 老布局：<root>/<version>/manifest.json + install.json。 */
function writeVersioned(root, version) {
  const dir = join(root, version);
  writeFlat(dir, { version });
  writeFileSync(
    join(dir, "install.json"),
    JSON.stringify({ version, profiles: ["core", "full"], installedAt: "2026-11-01T00:00:00.000Z" }, null, 2) + "\n",
  );
  return dir;
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "dsh-assets-"));
}

function envFor(root) {
  return { DSH_STM32_ASSETS: root };
}

/* ------------------------------ 工具宿主 ------------------------------ */

function toolFor(env) {
  const defs = new Map();
  const ctx = {
    tools: {
      register(definition) {
        defs.set(definition.name, definition);
        return () => undefined;
      },
    },
  };
  registerAssets(ctx, { env });
  const definition = defs.get(ASSETS_TOOL);
  assert.ok(definition, "stm32_assets 应已注册");
  return definition;
}

async function runTool(env, args) {
  const definition = toolFor(env);
  const value = await definition.execute(args, { signal: new AbortController().signal });
  reportProblems("stm32_assets(" + String(args.action ?? "list") + ")", outputSchema, value);
  return value;
}

const BUNDLED_ENV = { DSH_STM32_ASSETS: "" };

/* ------------------------------ 用例 ------------------------------ */

test("assetsRootInfo：默认指向插件内置 assets/，DSH_STM32_ASSETS 仍可覆盖", () => {
  const bundled = assetsRootInfo(BUNDLED_ENV);
  assert.equal(bundled.root, bundledAssetsRoot());
  assert.match(bundled.origin, /插件内置/u);
  assert.ok(existsSync(join(bundled.root, "manifest.json")), "内置 assets/ 必须有 manifest.json");

  const override = assetsRootInfo({ DSH_STM32_ASSETS: "D:/tmp/some-assets" });
  assert.match(override.origin, /DSH_STM32_ASSETS/u);
  assert.match(override.root, /some-assets/u);
});

test("真实内置 manifest：v2、core 与 full 分层、21 族事实都在", () => {
  const root = bundledAssetsRoot();
  const parsed = parseManifest(readFileSync(join(root, "manifest.json"), "utf8"));
  assert.equal(parsed.error, "");
  const manifest = parsed.manifest;
  assert.ok(manifest);
  assert.equal(manifest.schema, 2);
  assert.ok(manifest.files.length >= 100, "内置文件数应 >= 100，实际 " + String(manifest.files.length));
  const core = profileFiles(manifest, "core");
  const full = profileFiles(manifest, "full");
  assert.equal(core.length, 75, "core 应含 75 个文件（device 27 + ioc 34 + ld 14）");
  assert.equal(full.length, 105, "full 应含 105 个文件");
  assert.ok(full.length > core.length);
  assert.ok(core.some((file) => file.path === "device/f1/chips.json"));
  assert.ok(full.some((file) => file.path === "headers/f1/stm32f1xx.h"));
  assert.ok(!core.some((file) => file.path.startsWith("headers/")), "headers 只在 full");
  assert.ok(!core.some((file) => file.path.startsWith("startup/")), "startup 只在 full");
  const missing = manifest.files.filter((file) => !existsSync(join(root, ...file.path.split("/"))));
  assert.deepEqual(missing.map((file) => file.path), [], "manifest 里每个文件都应真的在 assets/ 里");
});

test("flat 根：listInstalledVersions 认作 bundled 当前版本，versionDir 就是根", () => {
  const root = tempRoot();
  try {
    const manifest = writeFlat(root);
    const versions = listInstalledVersions(envFor(root));
    assert.equal(versions.length, 1);
    assert.equal(versions[0].version, manifest.version);
    assert.equal(versions[0].bundled, true);
    assert.equal(versions[0].current, true);
    assert.deepEqual(versions[0].profiles, ["core", "full"]);
    const state = readLocalManifest(envFor(root));
    assert.equal(state.bundled, true);
    assert.equal(state.versionDir, root);
    assert.equal(state.error, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("老布局仍可读：只有 <version>/install.json 时也能发现与读取", () => {
  const root = tempRoot();
  try {
    const dir = writeVersioned(root, "2026.10.01-1");
    const versions = listInstalledVersions(envFor(root));
    assert.equal(versions.length, 1);
    assert.equal(versions[0].bundled, false);
    assert.equal(versions[0].current, true);
    const state = readLocalManifest(envFor(root), "2026.10.01-1");
    assert.equal(state.versionDir, dir);
    assert.equal(state.bundled, false);
    assert.equal(state.error, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("flat 与历史版本并存：flat 优先且只有它 current", () => {
  const root = tempRoot();
  try {
    writeVersioned(root, "2026.10.01-1");
    const flat = writeFlat(root, { version: "2026.11.09-1" });
    const versions = listInstalledVersions(envFor(root));
    assert.equal(versions.length, 2);
    assert.equal(versions[0].version, flat.version);
    assert.equal(versions[0].bundled, true);
    assert.equal(versions[0].current, true);
    assert.equal(versions[1].current, false);
    assert.equal(readLocalManifest(envFor(root)).versionDir, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureAssets：内置真实资源 ok/cache/bundled；缺 chips.json 时 missing 并指向重装插件", async () => {
  const bundled = await ensureAssets({ env: BUNDLED_ENV });
  assert.equal(bundled.ok, true, bundled.message);
  assert.equal(bundled.status, "cache");
  assert.equal(bundled.source, "bundled");
  assert.ok(bundled.filePath.endsWith(join("device", "f1", "chips.json")));
  assert.match(bundled.message, /插件内置资源/u);

  const root = tempRoot();
  try {
    writeFlat(root, { skip: ["device/f1/chips.json"] });
    const missing = await ensureAssets({ env: envFor(root) });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, "missing");
    assert.match(missing.message, /插件安装不完整/u);
    assert.match(missing.message, /重装插件/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveAssetFile：core 能取 device/，full-only 文件在 core 里被拒，缺文件点名", () => {
  const root = tempRoot();
  try {
    writeFlat(root);
    const env = envFor(root);
    const chips = resolveAssetFile("core", "device/f1/chips.json", env);
    assert.equal(chips.ok, true, chips.error);
    assert.ok(chips.path.endsWith(join("device", "f1", "chips.json")));

    const header = resolveAssetFile("core", "headers/f1/stm32f1xx.h", env);
    assert.equal(header.ok, false);
    assert.match(header.error, /profile=full/u);

    const full = resolveAssetFile("full", "headers/f1/stm32f1xx.h", env);
    assert.equal(full.ok, true, full.error);

    rmSync(join(root, "headers/f1/stm32f1xx.h"), { force: true });
    const gone = resolveAssetFile("full", "headers/f1/stm32f1xx.h", env);
    assert.equal(gone.ok, false);
    assert.match(gone.error, /本地缺这个文件/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyInstalled：逐文件 sha256 对上才 ok；改一个字节变成 changed 并点名", () => {
  const root = tempRoot();
  try {
    writeFlat(root);
    const env = envFor(root);
    const good = verifyInstalled({ profile: "full", env });
    assert.equal(good.ok, true, good.message);
    assert.equal(good.fileCount, CORPUS.length);
    assert.ok(good.files.every((file) => file.status === "ok"));

    writeFileSync(join(root, "device/f1/chips.json"), '{"chips":["tampered"]}\n');
    const bad = verifyInstalled({ profile: "core", env });
    assert.equal(bad.ok, false);
    const hit = bad.files.find((file) => file.path === "device/f1/chips.json");
    assert.equal(hit.status, "changed");
    assert.match(bad.message, /重装插件/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prune：内置根绝不删除；历史版本按 keep 清理，.tmp- 残留一起清", () => {
  const bundled = pruneOldVersions(BUNDLED_ENV, 2);
  assert.deepEqual(bundled.removed, []);
  assert.match(bundled.message, /不会被删除/u);
  assert.ok(existsSync(join(bundledAssetsRoot(), "manifest.json")));

  const root = tempRoot();
  try {
    writeVersioned(root, "2026.09.01-1");
    const second = writeVersioned(root, "2026.10.01-1");
    const third = writeVersioned(root, "2026.11.09-1");
    const tmp = join(root, "2026.11.09-1.tmp-abc");
    mkdirSync(tmp, { recursive: true });
    const result = pruneOldVersions(envFor(root), 2);
    assert.deepEqual(result.removed, ["2026.09.01-1"]);
    assert.ok(!existsSync(join(root, "2026.09.01-1")));
    assert.ok(existsSync(second));
    assert.ok(existsSync(third));
    assert.ok(!existsSync(tmp), ".tmp- 残留应被清掉");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parseManifest：重复 path 与绝对路径都拒绝", () => {
  const manifest = makeManifest();
  const duplicate = { ...manifest, files: [...manifest.files, manifest.files[0]] };
  assert.match(parseManifest(JSON.stringify(duplicate)).error, /重复/u);
  const absolute = {
    ...manifest,
    files: [{ path: "D:/evil.txt", bytes: 1, sha256: "0".repeat(64), source: "x", profile: "core" }],
  };
  assert.match(parseManifest(JSON.stringify(absolute)).error, /不合法/u);
});

test("工具 list：内置资源报版本/文件数/来源，输出形状符合宿主 schema", async () => {
  const value = await runTool(BUNDLED_ENV, { action: "list" });
  assert.equal(value.ok, true, value.message);
  assert.equal(value.source, "bundled（插件内置）");
  assert.match(value.origin, /插件内置/u);
  assert.ok(value.fileCount >= 60, "core 文件数应 >= 60，实际 " + String(value.fileCount));
  assert.ok(value.totalBytes > 0);
  assert.equal(value.files.length, value.fileCount);
  assert.ok(value.files.every((file) => file.status === "present"));
  assert.ok(value.versions.some((item) => item.current));
});

test("工具 verify/refresh：flat 资源通过；改文件后 ok=false 并点名", async () => {
  const root = tempRoot();
  try {
    writeFlat(root);
    const env = envFor(root);
    const verified = await runTool(env, { action: "verify", profile: "full" });
    assert.equal(verified.ok, true, verified.message);
    assert.equal(verified.fileCount, CORPUS.length);
    assert.ok(verified.files.every((file) => file.status === "ok"));

    const refreshed = await runTool(env, { action: "refresh" });
    assert.equal(refreshed.ok, true, refreshed.message);
    assert.match(refreshed.message, /不需要下载/u);

    writeFileSync(join(root, "device/f1/chips.json"), "tampered\n");
    const bad = await runTool(env, { action: "verify", profile: "core" });
    assert.equal(bad.ok, false);
    assert.ok(bad.files.some((file) => file.path === "device/f1/chips.json" && file.status === "changed"));
    assert.match(bad.offlineFallback, /重装插件/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("工具 list：没有 manifest 时 ok=false 且建议重装；prune 内置根安全", async () => {
  const empty = tempRoot();
  try {
    const value = await runTool(envFor(empty), { action: "list" });
    assert.equal(value.ok, false);
    assert.match(value.message, /找不到内置资源/u);
    assert.match(value.offlineFallback, /重装插件/u);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  const pruned = await runTool(BUNDLED_ENV, { action: "prune" });
  assert.equal(pruned.ok, true);
  assert.match(pruned.message, /不会被删除/u);
});
