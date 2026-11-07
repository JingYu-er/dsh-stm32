#!/usr/bin/env node
// RM PDF -> rm-facts 自动抽取：两道机检替代人核，过不了的一律拒收并给出原因。
//
// 用法：node scripts/facts/extract-rm-facts.mjs --pdf <rm.pdf> --spec <topics.json>
//         --svd-root <dir> [--out <file>]
//
// 页面文本来自 pymupdf（DSH_STM32_PYTHON 覆盖解释器，默认 python）。pymupdf 不可用时
// 明确失败：引文必须来自「被核验的那一份文本」，不能拿插件里的自研抽取器凑数
// （Node 侧压平索引没有页边界，做不了 page±3 回查；它负责的是覆盖判定那一层）。
//
// spec 写法见 demo/.dsh-stm32/rm-topics-c0.json：每主题给逐字锚点 anchors、
// 可选表格逐行 rows、可选 SVD 交叉要求 svd。

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const here = process.cwd();
const { extractRmFacts, assembleRmFacts } = await import(pathToFileURL(join(here, "lib/engine/rm-extract.js")).href);
const { parseSvdStructure } = await import(pathToFileURL(join(here, "lib/engine/facts-acquire.js")).href);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    out[key] = next === undefined || next.startsWith("--") ? true : next;
    if (out[key] !== true) i += 1;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (typeof args.pdf !== "string" || typeof args.spec !== "string") {
  console.error("用法: --pdf <rm.pdf> --spec <topics.json> --svd-root <dir> [--out <file>]");
  process.exit(2);
}
const spec = JSON.parse(readFileSync(resolve(args.spec), "utf8"));
const lines = Array.isArray(spec.lines) ? spec.lines : [];

const pages = new Set();
for (const topic of spec.topics) {
  for (let n = Math.max(1, topic.page - 3); n <= topic.page + 3; n += 1) pages.add(n);
}
const py = process.env.DSH_STM32_PYTHON || "python";
const pyCode = [
  "import json, sys",
  "import pymupdf",
  "d = pymupdf.open(sys.argv[1])",
  "want = [int(x) for x in sys.argv[2].split(',') if x]",
  "out = [{'page': n, 'text': d[n - 1].get_text()} for n in want if 0 < n <= d.page_count]",
  "print(json.dumps(out))",
].join("\n");
const r = spawnSync(py, ["-c", pyCode, resolve(args.pdf), [...pages].sort((a, b) => a - b).join(",")], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  timeout: 180000,
});
if (r.status !== 0) {
  const lastLine = String(r.stderr || "").split("\n").filter(Boolean).pop() || ("退出码 " + String(r.status));
  console.error("pymupdf 抽文本失败（" + py + "）：" + lastLine.slice(0, 200));
  console.error("提示：给这个解释器装 pymupdf，或用 DSH_STM32_PYTHON 指定一个装了它的解释器。");
  process.exit(2);
}
let pageTexts;
try {
  pageTexts = JSON.parse(r.stdout);
} catch (error) {
  console.error("pymupdf 输出解析不了：" + (error instanceof Error ? error.message : String(error)));
  process.exit(2);
}

const svdRoot = typeof args["svd-root"] === "string" ? resolve(args["svd-root"]) : null;
const famDir = "stm32" + String(spec.family || "").slice(5).toLowerCase();
const svdByLine = {};
for (const line of lines) {
  if (svdRoot === null) {
    console.error("没给 --svd-root：带 svd 要求的主题会被逐线拒收（机检不能没有对照物）");
    svdByLine[line] = undefined;
    continue;
  }
  const p = join(svdRoot, famDir, line + ".svd");
  if (!existsSync(p)) {
    console.error("SVD 缺失：" + p + "（这条线的 svd 交叉会被记为剔除）");
    svdByLine[line] = undefined;
    continue;
  }
  svdByLine[line] = parseSvdStructure(readFileSync(p, "utf8"));
}

const report = extractRmFacts(spec, pageTexts, svdByLine);
const { doc: outDoc, items } = assembleRmFacts(spec.doc, report.items);
const outFile = typeof args.out === "string" ? resolve(args.out) : resolve("rm-facts-" + String(spec.family || "").slice(5).toLowerCase() + ".json");
writeFileSync(outFile, JSON.stringify({ doc: outDoc, items }, null, 1) + "\n", "utf8");

console.log("rm-facts -> " + outFile);
console.log("  采信 " + String(items.length) + " 条；拒收 " + String(report.rejected.length) + " 条");
for (const x of report.rejected) console.log("  REJECT " + x.id + "：" + x.reason);
for (const n of report.lineNotes) {
  console.log("  " + n.line + "：" + String(n.accepted) + " 条适用" + (n.dropped.length > 0 ? "（剔除 " + n.dropped.join(", ") + "）" : ""));
}
if (report.rejected.length > 0) process.exitCode = 1;
