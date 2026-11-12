// 生成 src/data/firmware-pins.ts：把固件包要用到的每个归档与内核头钉到 sha256。
// 用法：node scripts/firmware/pin-firmware.mjs [--cache]
// --cache 复用本机 ../.dsh-stm32/firmware-pins-cache.json（断网重跑时省流量）；默认全部重下。
// 只在维护时跑（需要联网）；运行时不联网取哈希，只校验下载内容。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FIRMWARE_FAMILIES } from "../../lib/data/firmware-packages.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "src", "data", "firmware-pins.ts");
const CACHE = join(ROOT, "..", ".dsh-stm32", "firmware-pins-cache.json");
const CONCURRENCY = 6;
const USE_CACHE = process.argv.includes("--cache");
const MAX_ATTEMPTS = 4;

// 只在本机重跑时省流量：--cache 明确要求才读，默认永远重新下载（上游一变就该发现）。
const cache = USE_CACHE && existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};
function saveCache() {
  mkdirSync(join(ROOT, "..", ".dsh-stm32"), { recursive: true });
  const tmp = CACHE + ".tmp";
  writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
  renameSync(tmp, CACHE);
}

function archiveUrl(repo, ref) {
  return "https://codeload.github.com/STMicroelectronics/" + repo + "/tar.gz/refs/heads/" + ref;
}

// 内核头用 jsDelivr 取：raw.githubusercontent 在批量并发下经常 ECONNRESET（实测一批几十个里七成失败），
// jsDelivr 回源的是同一份 GitHub 文件；运行时四条镜像都按这个哈希校验。
function rawUrl(repo, ref, file) {
  return "https://fastly.jsdelivr.net/gh/STMicroelectronics/" + repo + "@" + ref + "/" + file;
}

async function hashUrl(url) {
  if (cache[url] !== undefined) return cache[url];
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
      if (!response.ok) throw new Error("HTTP " + String(response.status) + " " + url);
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        hash.update(buffer);
      }
      const pin = { sha256: hash.digest("hex"), bytes };
      cache[url] = pin;
      saveCache();
      return pin;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  throw new Error("重试 " + String(MAX_ATTEMPTS) + " 次仍失败：" + url + "（" + String(lastError) + "）");
}

async function hashAny(urls) {
  let lastError;
  for (const url of urls) {
    try {
      return await hashUrl(url);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

const archiveKeys = new Map();
const coreKeys = new Map();
for (const spec of Object.values(FIRMWARE_FAMILIES)) {
  for (const archive of spec.archives) {
    archiveKeys.set(archive.repo + "@" + archive.ref, { repo: archive.repo, ref: archive.ref });
  }
  for (const header of spec.coreHeaders) {
    const file = spec.coreIncludeDir + "/" + header;
    coreKeys.set(spec.coreRepo + "@" + spec.coreRef + "/" + file, { repo: spec.coreRepo, ref: spec.coreRef, file });
  }
}

const archives = [...archiveKeys.values()];
const cores = [...coreKeys.values()];
console.log("归档 " + String(archives.length) + " 个，内核头 " + String(cores.length) + " 个");

async function pinAll(label, items, keyOf, urlOf) {
  const pins = {};
  const failures = [];
  await mapLimit(items, CONCURRENCY, async (item) => {
    const key = keyOf(item);
    try {
      const target = urlOf(item);
      const pin = await hashAny(Array.isArray(target) ? target : [target]);
      pins[key] = pin;
      console.log(label + " " + key + " " + String(pin.bytes) + " B " + pin.sha256.slice(0, 12));
    } catch (error) {
      failures.push(String(error));
      console.error("失败 " + key + "：" + String(error));
    }
  });
  if (failures.length > 0) {
    console.error("有 " + String(failures.length) + " 项失败，未写 " + OUT + "；修好网络后加 --cache 重跑，已完成项会复用。");
    process.exitCode = 1;
    return null;
  }
  return pins;
}

const archivePins = await pinAll("归档", archives, (item) => item.repo + "@" + item.ref, (item) => archiveUrl(item.repo, item.ref));
if (archivePins === null) process.exit(1);
const corePins = await pinAll("头文件", cores, (item) => item.repo + "@" + item.ref + "/" + item.file, (item) => [
  "https://fastly.jsdelivr.net/gh/STMicroelectronics/" + item.repo + "@" + item.ref + "/" + item.file,
  "https://cdn.jsdelivr.net/gh/STMicroelectronics/" + item.repo + "@" + item.ref + "/" + item.file,
  "https://raw.githubusercontent.com/STMicroelectronics/" + item.repo + "/" + item.ref + "/" + item.file,
  "https://ghproxy.net/https://raw.githubusercontent.com/STMicroelectronics/" + item.repo + "/" + item.ref + "/" + item.file,
]);
if (corePins === null) process.exit(1);

function block(name, comment, pins) {
  const keys = Object.keys(pins).sort();
  return (
    "/** " + comment + " */\n" +
    "export const " + name + ": Readonly<Record<string, FirmwarePin>> = {\n" +
    keys.map((key) => "  " + JSON.stringify(key) + ": { sha256: " + JSON.stringify(pins[key].sha256) + ", bytes: " + String(pins[key].bytes) + " },").join("\n") +
    "\n};\n"
  );
}

const text = [
  "// 由 scripts/firmware/pin-firmware.mjs 生成，不要手改。",
  "// 上游 master 一变，哈希就对不上：重新跑脚本并提交这份文件。",
  "",
  "export interface FirmwarePin {",
  "  /** 64 位小写 sha256。 */",
  "  sha256: string;",
  "  bytes: number;",
  "}",
  "",
  block("FIRMWARE_ARCHIVE_PINS", "归档 key = <repo>@<ref>（codeload tar.gz）。", archivePins),
  block("FIRMWARE_CORE_PINS", "内核头 key = <repo>@<ref>/<包内路径>（raw.githubusercontent）。", corePins),
].join("\n");

writeFileSync(OUT, text, "utf8");
console.log("已写 " + OUT + "（" + String(text.length) + " 字符）");