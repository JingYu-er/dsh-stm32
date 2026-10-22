// A10q：插件产物 vs CubeMX CLI 原始产物。
// 做法：拿同一个 .ioc，直接让 CubeMX 无头生成到独立目录（原始 Src/Inc），
// 与插件的 Core/Src|Core/Inc 逐个文件比对——**去掉 USER CODE 块内容**后必须逐字节一致。
// 跑法：node test\e2e-a10q-product-parity.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { buildGenerateScript } from "../lib/engine/generate-script.js";
import { findIocFile } from "../lib/engine/generate.js";
import { detectLayout } from "../lib/engine/generate.js";
import { log, makeSubprocess } from "./harness.mjs";
import { e2eProject, e2eWorkDir } from "./fixtures.mjs";

const PROJECT = e2eProject();
const RAW = e2eWorkDir("a10q-raw");
const CUBEMX_ROOT = process.env.STM32_CUBEMX_ROOT ?? "D:/app/STM32CubeMX";

const MARKER = /^[ \t]*\/\* USER CODE (BEGIN|END) (.+?) \*\/[ \t]*$/u;

/** 去掉 USER CODE 块内的用户内容，只留 CubeMX 生成的行（两边同一把尺子）。 */
function stripUserCode(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const out = [];
  let inside = null;
  for (const line of text.split(/\r?\n/u)) {
    const marker = MARKER.exec(line);
    if (marker !== null) {
      const [, kind, label] = marker;
      if (kind === "BEGIN") inside = label;
      else if (inside === label) inside = null;
      out.push(line);
      continue;
    }
    if (inside === null) out.push(line);
  }
  return out.join(eol);
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

// ── 1) 用同一个 .ioc 让 CubeMX 生成到独立目录 ─────────────────────────────────
rmSync(RAW, { recursive: true, force: true });
mkdirSync(RAW, { recursive: true });
const iocPath = findIocFile(PROJECT);
assert.ok(iocPath !== null, "blink 里必须能找到 .ioc");
const layout = detectLayout(PROJECT);
const script = buildGenerateScript(iocPath.replace(/\\/g, "/"), RAW.replace(/\\/g, "/"), layout);
const scriptPath = join(RAW, "gen.txt");
writeFileSync(scriptPath, script, "utf8");

const java = join(CUBEMX_ROOT, "jre/bin/java.exe");
const jar = join(CUBEMX_ROOT, "STM32CubeMX.exe");
const started = Date.now();
log("CubeMX 原始生成开始（布局 " + layout + "）…");
const out = execFileSync(java, ["-jar", jar, "-q", scriptPath], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
});
log("CubeMX 原始生成结束：", ((Date.now() - started) / 1000).toFixed(1) + "s");

// ── 2) 逐文件比对（去 USER CODE） ────────────────────────────────────────────
const pairs = [
  { raw: join(RAW, "Src"), plugin: join(PROJECT, "Core", "Src"), name: "Core/Src" },
  { raw: join(RAW, "Inc"), plugin: join(PROJECT, "Core", "Inc"), name: "Core/Inc" },
];
let compared = 0;
const diffs = [];
const rawOnly = [];
const pluginOnly = [];
for (const pair of pairs) {
  const rawFiles = listFiles(pair.raw);
  assert.ok(rawFiles.length > 0, "CubeMX 没有在 " + pair.raw + " 产出文件（脚本/参数可能不对）");
  const rawSet = new Set(rawFiles.map((file) => relative(pair.raw, file)));
  const pluginSet = new Set(listFiles(pair.plugin).map((file) => relative(pair.plugin, file)));
  for (const rel of rawSet) {
    if (!pluginSet.has(rel)) {
      rawOnly.push(pair.name + "/" + rel);
      continue;
    }
    const a = stripUserCode(readFileSync(join(pair.raw, rel), "utf8"));
    const b = stripUserCode(readFileSync(join(pair.plugin, rel), "utf8"));
    compared += 1;
    if (a !== b) diffs.push(pair.name + "/" + rel);
  }
  for (const rel of pluginSet) if (!rawSet.has(rel)) pluginOnly.push(pair.name + "/" + rel);
}

log("比对文件数：", compared);
log("去 USER CODE 后不一致：", diffs.length === 0 ? "（无）" : diffs.join("、"));
log("CubeMX 有而插件没有：", rawOnly.length === 0 ? "（无）" : rawOnly.join("、"));
log("插件有而 CubeMX 没有：", pluginOnly.length === 0 ? "（无）" : pluginOnly.join("、"));

assert.deepEqual(diffs, [], "去 USER CODE 后必须逐字节一致");
assert.deepEqual(rawOnly, [], "插件不能丢 CubeMX 生成的文件");
// CubeMX 的 generate code 不产出这三件：sysmem.c / syscalls.c / system_stm32f1xx.c。
// 它们由脚手架从模板与固件包补齐（与 CubeMX GUI 新工程一致：GUI 也把它们放在 Core/Src），
// 所以属于预期差异，且不参与"插件是否夹带风格"的判定。
assert.deepEqual(
  pluginOnly.sort(),
  ["Core/Src/syscalls.c", "Core/Src/sysmem.c", "Core/Src/system_stm32f1xx.c"],
  "插件多出的只能是模板补的 sysmem/syscalls/system_stm32f1xx",
);

log("A10q PASS：" + compared + " 个文件去 USER CODE 后与 CubeMX 原始产物逐字节一致");
