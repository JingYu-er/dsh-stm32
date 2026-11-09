#!/usr/bin/env node
/**
 * 包体护栏：npm 包必须保持轻量。
 *
 * 规则（docs/development-notes.md 的「随包 / 进仓库 / 现造」三分法）：
 *   - tarball ≤ 4 MB —— assets/ 源文件约 12.5 MB，但主要是文本（设备头压缩率高），实测 1.76 MB。
     芯片事实、.ioc 模板、链接脚本、启动文件、CMSIS 设备头随包发布（2026-11 起不再拆独立资源仓，
     也就没有联网下载失败这条路）。超出上限说明混进了固件包、架构图或 RM 这类不该随包的东西。
 *   - templates/** 里的**运行时资产** ≤ 40 KB —— 这里只算工具真的会读进内存用的文件
 *     （.ioc / .xml / .ld / .json / .cfg / .svd / .csv）。Markdown 文档和 C/CMake 源码不算资产：
 *     前者是给人读的，后者是模板工程的一部分，二者都靠 tarball 上限兜住。单文件再过一道 24 KB。
 *   - 包内不许出现 png/jpg/gif/html/pdf/zip/exe —— 这些都是文档或二进制资产，
 *     要分享就挂 gh-pages，不要进 npm 包。
 *
 * 用 npm pack --dry-run --json 拿清单，不写盘、不依赖网络。
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const MAX_TARBALL = 4_000_000;
/** 运行时资产：会被工具读进内存解析的文件类型（.md 文档、.c/.h/.cmake 源码都不算）。 */
const ASSET_EXTS = [".ioc", ".xml", ".ld", ".json", ".cfg", ".svd", ".csv"];
const MAX_TEMPLATE_ASSETS = 40 * 1024;
/** 单个资产文件上限：超过就说明有人往里塞大资产了（0.1.3 最大的是 .ld 8 KB / .ioc 4 KB）。 */
const MAX_TEMPLATE_ASSET_FILE = 24 * 1024;

function isAsset(path) {
  const lower = path.toLowerCase();
  return ASSET_EXTS.some((ext) => lower.endsWith(ext));
}
const FORBIDDEN = /\.(png|jpe?g|gif|webp|bmp|pdf|html?|zip|7z|exe|dll)$/i;
/** 这些文档必须在包里（docs/*.md 是白名单，别把整个 docs 排除掉）。 */
const REQUIRED = [
  "README.md", "README_EN.md", "LICENSE", "cordis.patch.yml", "docs/reading-guide.md",
  "assets/manifest.json", "assets/device/f1/chips.json", "assets/ioc/minimal/STM32F103C8Tx.ioc",
];

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// 优先用 npm run 注入的 npm_execpath（跨平台、不经过 shell）；直接 node 跑本脚本时
// 退回到 shell 上的单条命令串（不用 args 数组，避免 Windows 的 .cmd 拼接告警）。
const npmCli = process.env.npm_execpath;
const run = npmCli
  ? spawnSync(process.execPath, [npmCli, "pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" })
  : spawnSync("npm pack --dry-run --json", { cwd: root, encoding: "utf8", shell: true });
if (run.status !== 0) {
  console.error("npm pack --dry-run 失败：");
  console.error(run.stderr || run.stdout);
  process.exit(1);
}

const text = run.stdout.trim();
const start = text.indexOf("[");
if (start < 0) {
  console.error("拿不到 npm pack 的 JSON 输出：");
  console.error(text.slice(0, 400));
  process.exit(1);
}
const report = JSON.parse(text.slice(start))[0];
const files = report.files ?? [];
const tarball = Number(report.size ?? 0);
const unpacked = Number(report.unpackedSize ?? 0);

const problems = [];
if (tarball > MAX_TARBALL) {
  problems.push("tarball " + kb(tarball) + " 超过上限 " + kb(MAX_TARBALL));
}
const templateFiles = files.filter((f) => f.path.startsWith("templates/"));
const templateBytes = templateFiles.reduce((sum, f) => sum + Number(f.size ?? 0), 0);
const assetFiles = templateFiles.filter((f) => isAsset(f.path));
const assetBytes = assetFiles.reduce((sum, f) => sum + Number(f.size ?? 0), 0);
if (assetBytes > MAX_TEMPLATE_ASSETS) {
  problems.push("templates/ 运行时资产共 " + kb(assetBytes) + " 超过上限 " + kb(MAX_TEMPLATE_ASSETS) + "（大资产放 assets/，不要塞进模板）");
}
for (const f of assetFiles) {
  const size = Number(f.size ?? 0);
  if (size > MAX_TEMPLATE_ASSET_FILE) {
    problems.push("模板里的资产文件过大：" + f.path + "（" + kb(size) + "，上限 " + kb(MAX_TEMPLATE_ASSET_FILE) + "）");
  }
}
for (const f of files) {
  if (FORBIDDEN.test(f.path)) problems.push("包内不许有二进制/文档资产：" + f.path + "（" + kb(Number(f.size ?? 0)) + "）");
}
for (const need of REQUIRED) {
  if (!files.some((f) => f.path === need)) problems.push("包里缺必需文件：" + need);
}
const biggest = [...files].sort((a, b) => Number(b.size ?? 0) - Number(a.size ?? 0)).slice(0, 5);

console.log("包体：" + kb(tarball) + "（上限 " + kb(MAX_TARBALL) + "），解包 " + kb(unpacked) + "，" + files.length + " 个文件");
console.log("模板：" + kb(templateBytes) + "，其中运行时资产 " + kb(assetBytes) + " / " + assetFiles.length + " 个（上限 " + kb(MAX_TEMPLATE_ASSETS) + "；.md 文档与源码不计入资产）");
console.log("最大的 5 个：" + biggest.map((f) => f.path + " " + kb(Number(f.size ?? 0))).join("、"));

if (problems.length > 0) {
  console.error("\n包体护栏不通过：");
  for (const p of problems) console.error(" - " + p);
  process.exit(1);
}
console.log("包体护栏通过");

function kb(bytes) {
  return (bytes / 1024).toFixed(1) + " KB";
}
