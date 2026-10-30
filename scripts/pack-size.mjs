#!/usr/bin/env node
/**
 * 包体护栏：npm 包必须保持轻量。
 *
 * 规则（docs/development-notes.md 的「随包 / 进仓库 / 现造」三分法）：
 *   - tarball ≤ 1.2 MB —— 超出就说明有大文件混进来了（图、固件包、板级 .ioc）。
 *   - templates/** ≤ 60 KB —— 模板是随包的运行时资产，超过就该挪到远端仓库按需下载。
 *   - 包内不许出现 png/jpg/gif/html/pdf/zip/exe —— 这些都是文档或二进制资产，
 *     要分享就挂 gh-pages，不要进 npm 包。
 *
 * 用 npm pack --dry-run --json 拿清单，不写盘、不依赖网络。
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const MAX_TARBALL = 1_200_000;
const MAX_TEMPLATES = 60 * 1024;
const FORBIDDEN = /\.(png|jpe?g|gif|webp|bmp|pdf|html?|zip|7z|exe|dll)$/i;
/** 这些文档必须在包里（docs/*.md 是白名单，别把整个 docs 排除掉）。 */
const REQUIRED = ["README.md", "README_EN.md", "LICENSE", "cordis.patch.yml", "docs/reading-guide.md"];

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
const templateBytes = files.filter((f) => f.path.startsWith("templates/")).reduce((sum, f) => sum + Number(f.size ?? 0), 0);
if (templateBytes > MAX_TEMPLATES) {
  problems.push("templates/ 共 " + kb(templateBytes) + " 超过上限 " + kb(MAX_TEMPLATES) + "（大资产应走远端仓库按需下载）");
}
for (const f of files) {
  if (FORBIDDEN.test(f.path)) problems.push("包内不许有二进制/文档资产：" + f.path + "（" + kb(Number(f.size ?? 0)) + "）");
}
for (const need of REQUIRED) {
  if (!files.some((f) => f.path === need)) problems.push("包里缺必需文件：" + need);
}
const biggest = [...files].sort((a, b) => Number(b.size ?? 0) - Number(a.size ?? 0)).slice(0, 5);

console.log("包体：" + kb(tarball) + "（上限 " + kb(MAX_TARBALL) + "），解包 " + kb(unpacked) + "，" + files.length + " 个文件");
console.log("模板：" + kb(templateBytes) + "（上限 " + kb(MAX_TEMPLATES) + "）");
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
