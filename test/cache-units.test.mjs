// 为什么要有这个套件：缓存 + 下载 + 寄存器版模板是三条"会碰外网、会写磁盘、会生成工程"的路径。
// 它们坏了的表现很难看：半截缓存被当模板用、404 页面被当头文件、生成的工程编译不过。
// 所以这里全部用**注入的 fetchImpl**（一次网络都不发）+ 临时目录，逐条钉住行为。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  cacheRootInfo,
  checkCacheEntry,
  findCacheEntry,
  readCacheIndex,
  removeCacheEntry,
  sha256OfFile,
  upsertCacheEntry,
  writeCacheIndex,
} from "../lib/engine/cache.js";
import { registerCache } from "../lib/tools/cache.js";
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
  // 内容特征（A32）：每个文件都要带上"真实文件里一定有"的那行，否则 fetch 会判内容不对。
  return text + "\n" + markerFor(name);
}

/**
 * 与 cmsis-sources.ts 里各 target 的 markers 对齐——用的是上游文件里的**真实守卫**。
 * 之前的版本按文件名猜（"#ifndef __MPU_ARMV7_H"），恰好撞上旧 markers 的 __MPU_，
 * 于是 mpu_armv7.h 的真实守卫 ARM_MPU_ARMV7_H 反而测不到。
 */
function markerFor(name) {
  if (name === "system_stm32f1xx.c") return "void SystemInit(void);";
  if (name.endsWith(".s")) return ".syntax unified\n_estack:";
  if (name === "core_cm3.h") return "#ifndef __CORE_CM3_H";
  if (name === "cmsis_compiler.h") return "#ifndef __CMSIS_COMPILER_H";
  if (name === "cmsis_gcc.h") return "#ifndef __CMSIS_GCC_H";
  if (name === "cmsis_version.h") return "#define __CMSIS_VERSION";
  if (name === "mpu_armv7.h") return "#ifndef ARM_MPU_ARMV7_H"; // ARM 原版守卫，没有前导下划线
  if (name === "stm32f1xx.h") return "#ifndef __STM32F1XX_H";
  if (name === "stm32f103xb.h") return "#ifndef __STM32F103xB_H";
  if (name === "system_stm32f1xx.h") return "#ifndef __SYSTEM_STM32F1XX_H";
  return "#ifndef __" + name.replace(/[^a-z0-9]/gi, "_").toUpperCase() + "_H";
}

/**
 * 假 fetch：按 URL 末尾的文件名返回内容；never = 永远 404；html = 返回一个网页。
 * 记录每次调用的 URL，用来断言"按候选顺序回退"。
 */
/** sha256（测试构造哈希用）。 */
function hashOf(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** 与 cmsisTemplatePlan 的 target.path 一一对应的示例内容（供哈希注入）。 */
const SAMPLE_PAYLOADS = {
  "Drivers/CMSIS/Device/ST/STM32F1xx/Include/stm32f1xx.h": payloadFor("stm32f1xx.h"),
  "Drivers/CMSIS/Device/ST/STM32F1xx/Include/system_stm32f1xx.h": payloadFor("system_stm32f1xx.h"),
  "Drivers/CMSIS/Device/ST/STM32F1xx/Include/stm32f103xb.h": payloadFor("stm32f103xb.h"),
  "Drivers/CMSIS/Device/ST/STM32F1xx/Source/Templates/system_stm32f1xx.c": payloadFor("system_stm32f1xx.c"),
  "Drivers/CMSIS/Device/ST/STM32F1xx/Source/Templates/gcc/startup_stm32f103xb.s": payloadFor("startup_stm32f103xb.s"),
  "Drivers/CMSIS/Include/core_cm3.h": payloadFor("core_cm3.h"),
  "Drivers/CMSIS/Include/cmsis_compiler.h": payloadFor("cmsis_compiler.h"),
  "Drivers/CMSIS/Include/cmsis_gcc.h": payloadFor("cmsis_gcc.h"),
  "Drivers/CMSIS/Include/cmsis_version.h": payloadFor("cmsis_version.h"),
  "Drivers/CMSIS/Include/mpu_armv7.h": payloadFor("mpu_armv7.h"),
};

/** path → sha256（注入 ensureCmsisTemplate 的测试点，验证哈希校验链路本身）。 */
function contentHashes(override = {}) {
  const out = {};
  for (const [key, text] of Object.entries(SAMPLE_PAYLOADS)) out[key] = hashOf(text);
  return { ...out, ...override };
}

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

test("缓存索引：坏 JSON 时 upsert 先备份成 index.json.broken-*，新索引只含新条目", () => {
  const root = tempDir("cache-broken");
  const env = { DSH_STM32_CACHE: root };
  const brokenText = "{ this is not json";
  try {
    writeFileSync(join(root, "index.json"), brokenText, "utf8");
    upsertCacheEntry(
      {
        id: "cmsis:F1:broken",
        kind: "cmsis",
        family: "F1",
        label: "broken",
        root: join(root, "F1", "broken"),
        createdAt: new Date().toISOString(),
        totalBytes: 0,
        files: [],
        sources: [],
        license: "",
      },
      env,
    );

    const backups = readdirSync(root).filter((name) => name.startsWith("index.json.broken-"));
    assert.equal(backups.length, 1, "坏索引要留一份能人工救回来的备份");
    assert.equal(readFileSync(join(root, backups[0]), "utf8"), brokenText, "备份必须是原来那串坏 JSON");

    const after = readCacheIndex(env);
    assert.equal(after.error, null);
    assert.deepEqual(after.index.entries.map((item) => item.id), ["cmsis:F1:broken"], "重建后只含新条目，不是把坏的当空索引又留着备份");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("缓存索引：换索引失败时旧索引逐字节不变、抛可识别的错、不留临时文件", () => {
  const root = tempDir("cache-write-fail");
  const env = { DSH_STM32_CACHE: root };
  const kept = {
    id: "cmsis:F1:keep",
    kind: "cmsis",
    family: "F1",
    label: "keep",
    root: join(root, "F1", "keep"),
    createdAt: new Date().toISOString(),
    totalBytes: 0,
    files: [],
    sources: [],
    license: "",
  };
  const fresh = { ...kept, id: "cmsis:F1:new" };
  const isWriteError = (error) => error?.name === "CacheIndexWriteError" && /索引写不进去/u.test(error.message);
  try {
    writeCacheIndex({ version: 1, updatedAt: "", entries: [kept] }, env);
    const before = readFileSync(join(root, "index.json"), "utf8");

    // 一、rename 全失败（Windows 上目标被占用就是这种表现）：旧索引逐字节不动，临时文件不残留。
    const denyRename = () => {
      const error = new Error("模拟目标被占用（EPERM）");
      error.code = "EPERM";
      throw error;
    };
    assert.throws(() => writeCacheIndex({ version: 1, updatedAt: "", entries: [fresh] }, env, { rename: denyRename }), isWriteError);
    assert.equal(readFileSync(join(root, "index.json"), "utf8"), before, "旧索引必须逐字节没动");
    assert.deepEqual(readdirSync(root), ["index.json"], "失败不许留下 .tmp-* / .bak-*");
    assert.deepEqual(readCacheIndex(env).index.entries.map((item) => item.id), ["cmsis:F1:keep"]);

    // 二、第一次 rename 失败、备份成功后搬新索引又失败：必须把旧索引原样放回。
    let calls = 0;
    const renameThenFail = (from, to) => {
      calls += 1;
      if (calls === 1 || calls === 3) throw new Error("模拟第 " + String(calls) + " 次 rename 失败");
      renameSync(from, to);
    };
    assert.throws(() => writeCacheIndex({ version: 1, updatedAt: "", entries: [fresh] }, env, { rename: renameThenFail }), isWriteError);
    assert.equal(readFileSync(join(root, "index.json"), "utf8"), before, "备份之后再失败要把旧索引放回去");
    assert.deepEqual(readdirSync(root), ["index.json"], "放回后不该留下备份或临时文件");
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

/** 造一个"给一半就停"的响应：abort 时让 stream 报错，模拟低速被 watchdog 掐断。 */
function stallingResponse(chunk, signal) {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(chunk));
        signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
      },
    }),
    { status: 200 },
  );
}

test("F3c 低速中断：同一个源带 Range 从断点续传，拼出来的文件是完整的", async () => {
  const root = tempDir("fetch-resume");
  try {
    const payload = "#ifndef __CORE_CM3_H\n#define __CORE_CM3_H\n" + "y".repeat(4000);
    const bytes = Buffer.from(payload, "utf8");
    const head = bytes.subarray(0, 1500);
    const tail = bytes.subarray(1500);
    const calls = [];
    const impl = async (url, init) => {
      const range = init?.headers?.Range ?? "";
      calls.push(range === "" ? "fresh" : range);
      if (range === "") return stallingResponse(head, init?.signal);
      return new Response(new Uint8Array(tail), {
        status: 206,
        headers: { "Content-Range": "bytes 1500-" + String(bytes.length - 1) + "/" + String(bytes.length) },
      });
    };
    const outcome = await fetchOne(
      { path: "core_cm3.h", urls: ["https://x/core_cm3.h"], minBytes: 100, markers: ["__CORE_CM3_H"] },
      root,
      { fetchImpl: impl, stallMs: 150, minBytesPerSec: 1024 },
    );
    assert.equal(outcome.ok, true, outcome.error);
    assert.deepEqual(calls, ["fresh", "bytes=1500-"], "第二次必须带 Range 从断点接着要");
    assert.equal(readFileSync(join(root, "core_cm3.h"), "utf8"), payload, "断点接起来的文件不能有重复或缺口");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F3c 服务器无视 Range 回 200：整份重写，不是接在旧字节后面", async () => {
  const root = tempDir("fetch-range-ignored");
  try {
    const payload = "#ifndef __CORE_CM3_H\n#define __CORE_CM3_H\n" + "z".repeat(4000);
    const bytes = Buffer.from(payload, "utf8");
    const calls = [];
    const impl = async (url, init) => {
      const range = init?.headers?.Range ?? "";
      calls.push(range === "" ? "fresh" : range);
      if (range === "") return stallingResponse(bytes.subarray(0, 1500), init?.signal);
      return new Response(new Uint8Array(bytes), { status: 200 });
    };
    const outcome = await fetchOne(
      { path: "core_cm3.h", urls: ["https://x/core_cm3.h"], minBytes: 100, markers: ["__CORE_CM3_H"] },
      root,
      { fetchImpl: impl, stallMs: 150, minBytesPerSec: 1024 },
    );
    assert.equal(outcome.ok, true, outcome.error);
    assert.equal(calls.length, 2, calls.join(" / "));
    const text = readFileSync(join(root, "core_cm3.h"), "utf8");
    assert.equal(text, payload, "200 是整份重发，必须截断写，绝不能变成 1500+4000 字节");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F3c 太慢之后换源：新源从零开始，旧源的半截 .part 不会被拼进来", async () => {
  const root = tempDir("fetch-switch");
  try {
    const good = "#ifndef __CORE_CM3_H\n#define __CORE_CM3_H\n" + "w".repeat(4000);
    const goodBytes = Buffer.from(good, "utf8");
    const calls = [];
    const impl = async (url, init) => {
      calls.push(url + " " + (init?.headers?.Range ?? "fresh"));
      if (url.includes("slow")) {
        // 两次都只给 800 字节就停：续传一次也还是慢 → 换源。
        const body = stallingResponse(Buffer.alloc(800, 0x41), init?.signal);
        return body;
      }
      return new Response(new Uint8Array(goodBytes), { status: 200 });
    };
    const outcome = await fetchOne(
      { path: "core_cm3.h", urls: ["https://slow/core_cm3.h", "https://fast/core_cm3.h"], minBytes: 100, markers: ["__CORE_CM3_H"] },
      root,
      { fetchImpl: impl, stallMs: 150, minBytesPerSec: 1024 },
    );
    assert.equal(outcome.ok, true, outcome.error);
    assert.equal(outcome.url, "https://fast/core_cm3.h");
    assert.equal(readFileSync(join(root, "core_cm3.h"), "utf8"), good, "换源必须重下整份，不能接前一个源的头");
    // slow 源试了两次（首次 + 续传），fast 源一次不带 Range。
    assert.equal(calls.filter((line) => line.startsWith("https://slow/")).length, 2, calls.join("\n"));
    assert.equal(calls.filter((line) => line.startsWith("https://fast/")).length, 1, calls.join("\n"));
    assert.ok(calls.at(-1).startsWith("https://fast/") && calls.at(-1).endsWith("fresh"), calls.at(-1));
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
    const first = await ensureCmsisTemplate({ mcu: "STM32F103C8T6", env, fetchImpl: fakeFetch(), hashes: contentHashes() });
    assert.equal(first.ok, true, first.message);
    assert.equal(first.cacheHit, false);
    assert.equal(first.files, 11, "10 个下载文件 + THIRD_PARTY_NOTICES.md（notices 也要进 files[]，A24）");
    assert.equal(existsSync(join(first.entryDir, "Drivers/CMSIS/Include/core_cm3.h")), true);
    assert.equal(existsSync(join(first.entryDir, "THIRD_PARTY_NOTICES.md")), true);
    const index = readCacheIndex(env).index;
    assert.equal(index.entries.length, 1);
    assert.equal(index.entries[0].id, "cmsis:F1:startup_stm32f103xb");
    const notices = index.entries[0].files.find((file) => file.path === "THIRD_PARTY_NOTICES.md");
    assert.ok(notices, "notices 必须在 files[] 里登记，否则 checkCacheEntry 永远不校验它");
    assert.equal(typeof notices.sha256, "string", "每个文件都要登记 sha256（A38）");
    assert.equal(checkCacheEntry(index.entries[0]).ok, true);

    const neverFetch = async () => {
      throw new Error("命中缓存时不该联网");
    };
    const second = await ensureCmsisTemplate({ mcu: "STM32F103C8T6", env, fetchImpl: neverFetch });
    assert.equal(second.ok, true);
    assert.equal(second.cacheHit, true);
    assert.equal(second.entryDir, first.entryDir);

    // 文件被删掉 → 自动重下
    rmSync(join(first.entryDir, "Drivers/CMSIS/Include/core_cm3.h"));
    const third = await ensureCmsisTemplate({ mcu: "STM32F103C8T6", env, fetchImpl: fakeFetch(), hashes: contentHashes() });
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
    const report = await createRegisterProject({ targetDir, projectName: "reg", mcu: "STM32F103C8T6", env, fetchImpl: fakeFetch(), hashes: contentHashes() });
    assert.equal(report.ok, true);
    assert.equal(report.route, "register");
    assert.equal(report.startup, "startup_stm32f103xb.s");
    assert.equal(report.deviceDefine, "STM32F103xB");
    assert.equal(report.templateFiles, 7);
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

    const second = await createRegisterProject({ targetDir, projectName: "reg", mcu: "STM32F103C8T6", env, fetchImpl: fakeFetch(), hashes: contentHashes(), overwrite: true });
    assert.equal(second.ok, true);
    assert.equal(second.cacheHit, true);
    assert.equal(readFileSync(join(env.DSH_STM32_CACHE, "F1", "startup_stm32f103xb", "THIRD_PARTY_NOTICES.md"), "utf8").length > 0, true);

    // 认不出的芯片：拒绝，而不是编一个启动文件
    const unsupported = await createRegisterProject({ targetDir: join(root, "g4"), projectName: "g4", mcu: "STM32G431CBT6", env, fetchImpl: fakeFetch(), hashes: contentHashes() });
    assert.equal(unsupported.ok, false);
    assert.match(unsupported.message, /认不出/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ---------------------- 内容校验 / sha256 / 工具行为 ---------------------- */

function cacheTool() {
  let definition;
  registerCache({ tools: { register(def) { definition = def; } } });
  return definition;
}

test("checkCacheEntry：同样大小、内容被换掉也要判出来（A38 sha256）", () => {
  const root = tempDir("sha");
  try {
    const dir = join(root, "cmsis", "F1", "x");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "core_cm3.h");
    writeFileSync(file, "abcde", "utf8");
    const entry = {
      id: "cmsis:F1:x",
      kind: "cmsis",
      family: "F1",
      label: "x",
      root: dir,
      createdAt: "",
      totalBytes: 5,
      files: [{ path: "core_cm3.h", bytes: 5, url: "", sha256: sha256OfFile(file) }],
      sources: [],
      license: "",
    };
    assert.equal(checkCacheEntry(entry).ok, true);
    writeFileSync(file, "abXde", "utf8");
    const health = checkCacheEntry(entry);
    assert.equal(health.ok, false);
    assert.match(health.changed.join("；"), /sha256/u);

    // 老条目没有 sha256：退回只看字节数，不能把别人的缓存判死
    const legacy = { ...entry, files: [{ path: "core_cm3.h", bytes: 5, url: "" }] };
    assert.equal(checkCacheEntry(legacy).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mpu_armv7.h 用 ARM 原版守卫 ARM_MPU_ARMV7_H，不再是 __MPU_（寄存器路线必下载失败的根因）", async () => {
  const root = tempDir("mpu");
  const env = { DSH_STM32_CACHE: join(root, "cache") };
  // 上游 V5.0.4 的真实开头：守卫没有前导下划线，旧 markers [__CMSIS,__CORE_,__MPU_] 一个都不命中。
  // hashes 注入的是这批假内容的真实哈希（mpu 用 upstream 的、其余用 payloadFor 的）。
  const upstream = "#ifndef ARM_MPU_ARMV7_H\n#define ARM_MPU_ARMV7_H\n" + "/* MPU */\n".repeat(80);
  const impl = fakeFetch({
    handler: (url) => {
      const name = url.split("/").pop();
      if (name === "mpu_armv7.h") return new Response(upstream, { status: 200 });
      return new Response(payloadFor(name), { status: 200 });
    },
  });
  const template = await ensureCmsisTemplate({
    mcu: "STM32F103C8T6",
    env,
    fetchImpl: impl,
    hashes: contentHashes({ "Drivers/CMSIS/Include/mpu_armv7.h": hashOf(upstream) }),
  });
  assert.equal(template.ok, true, template.message);
  const mpu = join(template.entryDir, "Drivers", "CMSIS", "Include", "mpu_armv7.h");
  assert.equal(existsSync(mpu), true, "mpu_armv7.h 应当能通过校验并落盘");
  assert.match(readFileSync(mpu, "utf8"), /ARM_MPU_ARMV7_H/u);
});

test("fetchOne：字节数够但内容特征不对，换源而不是落盘（A32 markers）", async () => {
  const root = tempDir("markers");
  try {
    const target = {
      path: "core_cm3.h",
      urls: ["https://a.example/core_cm3.h", "https://b.example/core_cm3.h"],
      minBytes: 10,
      markers: ["__CORE_CM3_H"],
    };
    const wrong = fakeFetch({ handler: () => new Response("<!-- 登录页 -->" + "x".repeat(400), { status: 200 }) });
    const bad = await fetchOne(target, root, { fetchImpl: wrong });
    assert.equal(bad.ok, false);
    assert.match(bad.attempts.join("；"), /内容对不上/u);
    assert.equal(existsSync(join(root, "core_cm3.h")), false, "对不上的内容不许落盘");

    writeFileSync(join(root, "core_cm3.h"), "旧内容", "utf8");
    const good = fakeFetch({ handler: () => new Response("#ifndef __CORE_CM3_H\n#define __CORE_CM3_H\n" + "x".repeat(400), { status: 200 }) });
    const ok = await fetchOne(target, root, { fetchImpl: good });
    assert.equal(ok.ok, true);
    assert.match(readFileSync(join(root, "core_cm3.h"), "utf8"), /__CORE_CM3_H/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sha256 校验（0a）：哈希对不上时拒绝落盘，错误信息带期望与实际", async () => {
  const root = tempDir("sha");
  const env = { DSH_STM32_CACHE: join(root, "cache") };
  const result = await ensureCmsisTemplate({
    mcu: "STM32F103C8T6",
    env,
    fetchImpl: fakeFetch(),
    // 故意给一个错的期望哈希：内容是 SAMPLE_PAYLOADS 的真哈希，期望值错开一位
    hashes: Object.fromEntries(
      Object.entries(contentHashes()).map(([key, value]) => [key, value === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64)]),
    ),
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /sha256/u);
  // 10 个文件全部被拒：错误信息里既有期望前缀也有实际前缀
  assert.match(result.message, /期望/u);
});

test("sha256 校验（0a）：期望哈希正确时全部落盘（与上面的 contentHashes 注入等价）", async () => {
  const root = tempDir("sha-ok");
  const env = { DSH_STM32_CACHE: join(root, "cache") };
  const result = await ensureCmsisTemplate({ mcu: "STM32F103C8T6", env, fetchImpl: fakeFetch(), hashes: contentHashes() });
  assert.equal(result.ok, true, result.message);
});

test("ensureCmsisTemplate：下载失败不把并发方在读的目录直接抽走，并说清半截目录去哪了（A24）", async () => {
  const root = tempDir("stale-dir");
  const env = { DSH_STM32_CACHE: root };
  try {
    const result = await ensureCmsisTemplate({ mcu: "STM32F103C8T6", env, fetchImpl: fakeFetch({ handler: () => new Response("nope", { status: 404 }) }) });
    assert.equal(result.ok, false);
    assert.match(result.message, /半截目录/u);
    assert.equal(existsSync(join(root, "F1", "startup_stm32f103xb")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stm32_cache：不认识的 action 不再等于清空缓存；清空要 confirm（A8）", async () => {
  const root = tempDir("cache-actions");
  const saved = process.env.DSH_STM32_CACHE;
  process.env.DSH_STM32_CACHE = root;
  const entryDir = join(root, "cmsis", "F1", "x");
  try {
    mkdirSync(entryDir, { recursive: true });
    writeCacheIndex(
      {
        version: 1,
        updatedAt: "",
        entries: [{ id: "cmsis:F1:x", kind: "cmsis", family: "F1", label: "x", root: entryDir, createdAt: "", totalBytes: 0, files: [], sources: [], license: "" }],
      },
      process.env,
    );
    const tool = cacheTool();
    const exec = { signal: new AbortController().signal };

    const unknown = await tool.execute({ action: "pruge" }, exec);
    assert.equal(unknown.ok, false);
    assert.match(unknown.message, /不认识的 action/u);
    assert.equal(readCacheIndex(process.env).index.entries.length, 1, "拼错的 action 不许动缓存数据");

    const noConfirm = await tool.execute({ action: "purge" }, exec);
    assert.equal(noConfirm.ok, false);
    assert.match(noConfirm.message, /confirm:true/u);
    assert.equal(readCacheIndex(process.env).index.entries.length, 1, "没确认就不许删");
    assert.equal(existsSync(entryDir), true);

    const cleared = await tool.execute({ action: "purge", confirm: true }, exec);
    assert.equal(cleared.ok, true);
    assert.match(cleared.message, /实际删掉 1 个/u);
    assert.equal(readCacheIndex(process.env).index.entries.length, 0);
    assert.equal(existsSync(entryDir), false);
  } finally {
    if (saved === undefined) delete process.env.DSH_STM32_CACHE;
    else process.env.DSH_STM32_CACHE = saved;
    rmSync(root, { recursive: true, force: true });
  }
});
