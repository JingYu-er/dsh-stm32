// 为什么要有这个套件：缓存 + 下载 + 寄存器版模板是三条"会碰外网、会写磁盘、会生成工程"的路径。
// 它们坏了的表现很难看：半截缓存被当模板用、404 页面被当头文件、生成的工程编译不过。
// 所以这里全部用**注入的 fetchImpl**（一次网络都不发）+ 临时目录，逐条钉住行为。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cacheRootInfo,
  checkCacheEntry,
  findCacheEntry,
  readCacheIndex,
  removeCacheEntry,
  upsertCacheEntry,
} from "../lib/engine/cache.js";
import { fetchAll, fetchOne } from "../lib/engine/fetch.js";
import { cmsisTemplatePlan, sourceUrls, startupChoiceFor } from "../lib/data/cmsis-sources.js";
import { createRegisterProject, ensureCmsisTemplate, resolveStartupChoice } from "../lib/engine/register-template.js";

function tempDir(tag) {
  return mkdtempSync(join(tmpdir(), "dsh-stm32-" + tag + "-"));
}

/** 每个文件的最小字节数不同（见 cmsis-sources 的 minBytes），这里按文件名给足量内容。 */
function payloadFor(name) {
  const sizes = {
    "stm32f1xx.h": 400,
    "stm32f103xb.h": 12_000,
    "system_stm32f1xx.h": 400,
    "system_stm32f1xx.c": 1_200,
    "startup_stm32f103xb.s": 1_200,
    "core_cm3.h": 600,
    "cmsis_compiler.h": 600,
    "cmsis_gcc.h": 600,
    "cmsis_version.h": 600,
    "mpu_armv7.h": 600,
  };
  const size = sizes[name] ?? 800;
  const line = "/* " + name + " */ ";
  let text = "";
  while (text.length < size) text += line;
  return text;
}

/**
 * 假 fetch：按 URL 末尾的文件名返回内容；never = 永远 404；html = 返回一个网页。
 * 记录每次调用的 URL，用来断言"按候选顺序回退"。
 */
function fakeFetch(options = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (typeof options.handler === "function") return options.handler(url, calls);
    const name = url.split("/").pop();
    const body = payloadFor(name);
    return new Response(body, { status: 200 });
  };
  impl.calls = calls;
  return impl;
}

test("缓存根目录：DSH_STM32_CACHE 优先，支持 ~ 展开，其次 LOCALAPPDATA", () => {
  const home = "C:\\Users\\tester";
  const withOverride = cacheRootInfo({ DSH_STM32_CACHE: "D:/tmp/my-cache", USERPROFILE: home });
  assert.equal(withOverride.origin, "DSH_STM32_CACHE");
  assert.equal(withOverride.root, "D:\\tmp\\my-cache".replace(/\\/g, "\\"));
  assert.equal(withOverride.indexPath.endsWith("index.json"), true);

  const withHome = cacheRootInfo({ DSH_STM32_CACHE: "~/cache-here", USERPROFILE: home });
  assert.equal(withHome.root.startsWith(home), true);

  const localApp = cacheRootInfo({ LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local", USERPROFILE: home });
  assert.equal(localApp.origin, "LOCALAPPDATA");
  assert.equal(localApp.root.endsWith(join("dsh-stm32", "cache")), true);
});

test("缓存索引：文件不存在当空索引，坏 JSON 不抛异常而是给一条中文错误", () => {
  const root = tempDir("cache-index");
  const env = { DSH_STM32_CACHE: root };
  try {
    const missing = readCacheIndex(env);
    assert.equal(missing.error, null);
    assert.equal(missing.index.entries.length, 0);

    writeFileSync(join(root, "index.json"), "{ this is not json", "utf8");
    const broken = readCacheIndex(env);
    assert.equal(broken.index.entries.length, 0);
    assert.equal(typeof broken.error, "string");
    assert.match(broken.error, /索引读不了/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("缓存条目：upsert 覆盖同 id，checkCacheEntry 能报出缺文件与大小不符", () => {
  const root = tempDir("cache-entry");
  const env = { DSH_STM32_CACHE: root };
  const entryDir = join(root, "F1", "demo");
  try {
    mkdirSync(entryDir, { recursive: true });
    writeFileSync(join(entryDir, "a.h"), "12345", "utf8");
    const entry = {
      id: "cmsis:F1:demo",
      kind: "cmsis",
      family: "F1",
      label: "demo",
      root: entryDir,
      createdAt: new Date().toISOString(),
      totalBytes: 5,
      files: [{ path: "a.h", bytes: 5, url: "https://example.invalid/a.h" }],
      sources: [],
      license: "",
    };
    upsertCacheEntry(entry, env);
    const index = readCacheIndex(env).index;
    assert.equal(findCacheEntry(index, "cmsis", "cmsis:F1:demo").id, "cmsis:F1:demo");
    assert.equal(checkCacheEntry(entry).ok, true);

    writeFileSync(join(entryDir, "a.h"), "123456789", "utf8");
    const changed = checkCacheEntry(entry);
    assert.equal(changed.ok, false);
    assert.equal(changed.changed.length, 1);

    rmSync(join(entryDir, "a.h"));
    const gone = checkCacheEntry(entry);
    assert.equal(gone.ok, false);
    assert.equal(gone.missing.length, 1);

    // 同 id 再写一次不该出现两条
    upsertCacheEntry(entry, env);
    assert.equal(readCacheIndex(env).index.entries.length, 1);

    assert.equal(removeCacheEntry("cmsis:F1:demo", env).removed, true);
    assert.equal(readCacheIndex(env).index.entries.length, 0);
    assert.equal(existsSync(entryDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fetchOne：第一个源 404 就换第二个；拿回网页或太短都不算成功", async () => {
  const root = tempDir("fetch-one");
  try {
    const impl = fakeFetch({
      handler: (url) => {
        if (url.includes("fastly")) return new Response("nope", { status: 404 });
        return new Response(payloadFor("stm32f1xx.h"), { status: 200 });
      },
    });
    const target = { path: "Include/stm32f1xx.h", urls: sourceUrls("cmsis-device-f1", "master", "Include/stm32f1xx.h"), minBytes: 200 };
    const outcome = await fetchOne(target, root, { fetchImpl: impl });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.attempts.length, 1);
    assert.match(outcome.url, /jsdelivr|raw\.githubusercontent|ghproxy/u);
    assert.equal(readFileSync(join(root, "Include", "stm32f1xx.h"), "utf8").startsWith("/*"), true);

    const htmlBody = "<!doctype html><html><body>" + "x".repeat(400) + "</body></html>";
    const htmlImpl = fakeFetch({ handler: () => new Response(htmlBody, { status: 200 }) });
    const htmlOutcome = await fetchOne(target, root, { fetchImpl: htmlImpl });
    assert.equal(htmlOutcome.ok, false);
    assert.match(htmlOutcome.error, /网页/u);

    const tinyImpl = fakeFetch({ handler: () => new Response("<html>", { status: 200 }) });
    const tinyOutcome = await fetchOne({ ...target, minBytes: 10_000 }, root, { fetchImpl: tinyImpl });
    assert.equal(tinyOutcome.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fetchAll：并发下每个文件各算一次，失败数能统计出来", async () => {
  const root = tempDir("fetch-all");
  try {
    const targets = [
      { path: "a.h", urls: ["https://x/a.h"], minBytes: 10 },
      { path: "b.h", urls: ["https://x/b.h"], minBytes: 10 },
      { path: "c.h", urls: ["https://x/c.h"], minBytes: 10 },
    ];
    const impl = fakeFetch({
      handler: (url) => (url.endsWith("b.h") ? new Response("no", { status: 500 }) : new Response(payloadFor("a.h"), { status: 200 })),
    });
    const result = await fetchAll(targets, root, { fetchImpl: impl, concurrency: 2 });
    assert.equal(result.ok, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.bytes > 0, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("启动文件映射：C8T6 的中容量档走 xB 那套（ST 只提供 x6/xB/xE 三个文件）", () => {
  const c8 = startupChoiceFor("STM32F103C8T6");
  assert.deepEqual(c8, { family: "F1", startup: "startup_stm32f103xb.s", define: "STM32F103xB", deviceHeader: "stm32f103xb.h" });
  assert.equal(startupChoiceFor("STM32F103C6T6").startup, "startup_stm32f103x6.s");
  assert.equal(startupChoiceFor("STM32F103VET6").startup, "startup_stm32f103xe.s");
  assert.equal(startupChoiceFor("STM32F103RBT6").deviceHeader, "stm32f103xb.h");
  assert.equal(startupChoiceFor("F1:8").startup, "startup_stm32f103xb.s");
  assert.equal(startupChoiceFor("STM32G431CBT6"), null);
  assert.equal(startupChoiceFor("不认识"), null);
  assert.equal(resolveStartupChoice({}).startup, "startup_stm32f103xb.s");
});

test("模板清单：10 个文件、路径按 ST 固件包布局、id 可检索", () => {
  const choice = startupChoiceFor("STM32F103C8T6");
  const plan = cmsisTemplatePlan(choice);
  assert.equal(plan.targets.length, 10);
  const paths = plan.targets.map((item) => item.path);
  assert.equal(paths.includes("Drivers/CMSIS/Device/ST/STM32F1xx/Include/stm32f103xb.h"), true);
  assert.equal(paths.includes("Drivers/CMSIS/Device/ST/STM32F1xx/Source/Templates/gcc/startup_stm32f103xb.s"), true);
  assert.equal(paths.includes("Drivers/CMSIS/Include/core_cm3.h"), true);
  assert.equal(plan.id, "cmsis:F1:startup_stm32f103xb");
  assert.equal(plan.dirName, "F1/startup_stm32f103xb");
  assert.match(plan.license, /Apache/u);
  assert.equal(plan.targets.every((item) => item.urls.length === 4), true);
});

test("ensureCmsisTemplate：缓存空且被要求不联网时，明说没下载而不是装作成功", async () => {
  const root = tempDir("ensure-offline");
  try {
    const result = await ensureCmsisTemplate({ mcu: "STM32F103C8T6", env: { DSH_STM32_CACHE: root }, download: false });
    assert.equal(result.ok, false);
    assert.equal(result.error, "not-cached");
    assert.match(result.message, /缓存/u);
    assert.equal(existsSync(join(root, "index.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureCmsisTemplate：下载成功写索引，第二次直接命中缓存（不再发请求）", async () => {
  const root = tempDir("ensure-online");
  const env = { DSH_STM32_CACHE: root };
  try {
    const first = await ensureCmsisTemplate({ mcu: "STM32F103C8T6", env, fetchImpl: fakeFetch() });
    assert.equal(first.ok, true);
    assert.equal(first.cacheHit, false);
    assert.equal(first.files, 10);
    assert.equal(existsSync(join(first.entryDir, "Drivers/CMSIS/Include/core_cm3.h")), true);
    assert.equal(existsSync(join(first.entryDir, "THIRD_PARTY_NOTICES.md")), true);
    const index = readCacheIndex(env).index;
    assert.equal(index.entries.length, 1);
    assert.equal(index.entries[0].id, "cmsis:F1:startup_stm32f103xb");

    const neverFetch = async () => {
      throw new Error("命中缓存时不该联网");
    };
    const second = await ensureCmsisTemplate({ mcu: "STM32F103C8T6", env, fetchImpl: neverFetch });
    assert.equal(second.ok, true);
    assert.equal(second.cacheHit, true);
    assert.equal(second.entryDir, first.entryDir);

    // 文件被删掉 → 自动重下
    rmSync(join(first.entryDir, "Drivers/CMSIS/Include/core_cm3.h"));
    const third = await ensureCmsisTemplate({ mcu: "STM32F103C8T6", env, fetchImpl: fakeFetch() });
    assert.equal(third.ok, true);
    assert.equal(third.cacheHit, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createRegisterProject：生成的工程是齐的（CMakeLists / main.c / Drivers / 启动文件）", async () => {
  const root = tempDir("register-proj");
  const targetDir = join(root, "reg");
  const env = { DSH_STM32_CACHE: join(root, "cache") };
  try {
    const report = await createRegisterProject({ targetDir, projectName: "reg", mcu: "STM32F103C8T6", env, fetchImpl: fakeFetch() });
    assert.equal(report.ok, true);
    assert.equal(report.route, "register");
    assert.equal(report.startup, "startup_stm32f103xb.s");
    assert.equal(report.deviceDefine, "STM32F103xB");
    assert.equal(report.templateFiles, 6);
    assert.equal(report.driverFiles, 10);

    const cmake = readFileSync(join(targetDir, "CMakeLists.txt"), "utf8");
    assert.match(cmake, /set\(CMAKE_PROJECT_NAME reg\)/u);
    assert.equal(cmake.includes("add_executable(${CMAKE_PROJECT_NAME}"), true);
    assert.match(cmake, /startup_stm32f103xb\.s/u);
    assert.match(cmake, /STM32F103xB/u);
    assert.equal(cmake.includes("__FAMILY_DIR__"), false);
    const main = readFileSync(join(targetDir, "Core", "Src", "main.c"), "utf8");
    assert.match(main, /g_led_blink_count/u);
    assert.equal(existsSync(join(targetDir, "STM32F103XX_FLASH.ld")), true);
    assert.equal(existsSync(join(targetDir, "cmake", "gcc-arm-none-eabi.cmake")), true);
    assert.equal(existsSync(join(targetDir, "Drivers/CMSIS/Device/ST/STM32F1xx/Source/Templates/gcc/startup_stm32f103xb.s")), true);

    const second = await createRegisterProject({ targetDir, projectName: "reg", mcu: "STM32F103C8T6", env, fetchImpl: fakeFetch(), overwrite: true });
    assert.equal(second.ok, true);
    assert.equal(second.cacheHit, true);

    // 认不出的芯片：拒绝，而不是编一个启动文件
    const unsupported = await createRegisterProject({ targetDir: join(root, "g4"), projectName: "g4", mcu: "STM32G431CBT6", env, fetchImpl: fakeFetch() });
    assert.equal(unsupported.ok, false);
    assert.match(unsupported.message, /认不出/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
