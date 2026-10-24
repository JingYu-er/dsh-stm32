// L0 纯逻辑单测：生成缓存（键计算、读写、命中三重校验）。
// 运行：node --test test/generate-cache-units.test.mjs（需先 npm run build）
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  CACHE_FILE,
  CACHE_VERSION,
  cacheHit,
  cacheKeyFor,
  computeCacheKey,
  cubeMxStamp,
  entryFromFiles,
  readCache,
  sha256File,
  sha256Text,
  writeCache,
} from "../lib/engine/generate-cache.js";

const tmp = () => mkdtempSync(join(tmpdir(), "dsh-cache-"));

function touch(path, content) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

test("sha256Text：同内容同 hash，改一个字节就变", () => {
  const a = sha256Text("Mcu.ThirdPartyNb=0\n");
  assert.equal(a, sha256Text("Mcu.ThirdPartyNb=0\n"));
  assert.equal(a.length, 64);
  assert.notEqual(a, sha256Text("Mcu.ThirdPartyNb=1\n"));
});

test("sha256File：文件不存在返回 null，存在则与内容 hash 一致", () => {
  const dir = tmp();
  try {
    assert.equal(sha256File(join(dir, "nope.c")), null);
    const p = join(dir, "main.c");
    writeFileSync(p, "int main(void) { return 0; }\n", "utf8");
    assert.equal(sha256File(p), sha256Text("int main(void) { return 0; }\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cubeMxStamp：大小或 mtime 变了指纹就变（升级 CubeMX 自动失效）", () => {
  const dir = tmp();
  try {
    const java = join(dir, "java.exe");
    const jar = join(dir, "STM32CubeMX.exe");
    writeFileSync(java, "java", "utf8");
    writeFileSync(jar, "jar-v1", "utf8");
    const first = cubeMxStamp(java, jar);
    assert.match(first, /^\d+:\d+\|\d+:\d+$/u);
    assert.equal(first, cubeMxStamp(java, jar));
    writeFileSync(jar, "jar-v2-longer", "utf8");
    assert.notEqual(first, cubeMxStamp(java, jar));
    assert.match(cubeMxStamp(join(dir, "missing.exe"), jar), /^missing\|/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cacheKeyFor：.ioc / CubeMX 指纹 / 布局任一变化都换键", () => {
  const dir = tmp();
  try {
    const java = join(dir, "java.exe");
    const jar = join(dir, "STM32CubeMX.exe");
    writeFileSync(java, "java", "utf8");
    writeFileSync(jar, "jar", "utf8");
    const a = cacheKeyFor("Mcu.ThirdPartyNb=0\n", java, jar, "coupled");
    assert.equal(a.key, cacheKeyFor("Mcu.ThirdPartyNb=0\n", java, jar, "coupled").key);
    assert.notEqual(a.key, cacheKeyFor("Mcu.ThirdPartyNb=1\n", java, jar, "coupled").key);
    assert.notEqual(a.key, cacheKeyFor("Mcu.ThirdPartyNb=0\n", java, jar, "per-ip").key);
    assert.notEqual(a.key, computeCacheKey(a.iocSha256, "other-stamp", "coupled"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeCache / readCache：往返一致；坏 JSON 与版本不符都当没有缓存", () => {
  const dir = tmp();
  try {
    const stateDir = join(dir, ".dsh-stm32");
    const entry = {
      version: CACHE_VERSION,
      key: "k1",
      iocSha256: "i1",
      cubeMxStamp: "s1",
      layout: "coupled",
      createdAt: 1,
      files: [{ target: "Core/Src/main.c", sha256: "h1" }],
    };
    writeCache(stateDir, entry);
    assert.deepEqual(readCache(stateDir), entry);
    writeFileSync(join(stateDir, CACHE_FILE), "{ not json", "utf8");
    assert.equal(readCache(stateDir), null);
    writeFileSync(join(stateDir, CACHE_FILE), JSON.stringify({ ...entry, version: CACHE_VERSION + 1 }), "utf8");
    assert.equal(readCache(stateDir), null);
    assert.equal(readCache(join(dir, "no-such-state")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("entryFromFiles + cacheHit：产物都在且 hash 一致才算命中", () => {
  const projectDir = tmp();
  try {
    touch(join(projectDir, "Core/Src/main.c"), "generated main\n");
    touch(join(projectDir, "Core/Inc/main.h"), "generated header\n");
    const entry = entryFromFiles("key-1", "ioc-1", "stamp-1", "coupled", projectDir, [
      "Core/Src/main.c",
      "Core/Inc/main.h",
    ]);
    assert.notEqual(entry, null);
    assert.equal(entry.version, CACHE_VERSION);
    assert.equal(entry.files.length, 2);

    const hit = cacheHit(entry, "key-1", projectDir);
    assert.equal(hit.hit, true);
    assert.equal(hit.fileCount, 2);
    assert.equal(hit.reason, "");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("cacheHit 不命中：没缓存 / 键不一致 / 文件被删 / 文件被改", () => {
  const projectDir = tmp();
  try {
    touch(join(projectDir, "Core/Src/main.c"), "generated main\n");
    const entry = entryFromFiles("key-1", "ioc-1", "stamp-1", "coupled", projectDir, ["Core/Src/main.c"]);

    const none = cacheHit(null, "key-1", projectDir);
    assert.equal(none.hit, false);
    assert.match(none.reason, /没有可用缓存/u);

    const wrongKey = cacheHit(entry, "key-2", projectDir);
    assert.equal(wrongKey.hit, false);
    assert.match(wrongKey.reason, /缓存键不一致/u);

    writeFileSync(join(projectDir, "Core/Src/main.c"), "手改过\n", "utf8");
    const tampered = cacheHit(entry, "key-1", projectDir);
    assert.equal(tampered.hit, false);
    assert.match(tampered.reason, /被改过/u);

    rmSync(join(projectDir, "Core/Src/main.c"));
    const missing = cacheHit(entry, "key-1", projectDir);
    assert.equal(missing.hit, false);
    assert.match(missing.reason, /产物不见了/u);

    const noFiles = cacheHit({ ...entry, files: [] }, "key-1", projectDir);
    assert.equal(noFiles.hit, false);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("entryFromFiles：目标文件缺失时返回 null（不写半份缓存）", () => {
  const projectDir = tmp();
  try {
    assert.equal(entryFromFiles("k", "i", "s", "coupled", projectDir, ["Core/Src/not-there.c"]), null);
    assert.equal(entryFromFiles("k", "i", "s", "coupled", projectDir, []).files.length, 0);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});
