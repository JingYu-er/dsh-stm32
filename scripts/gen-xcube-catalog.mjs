#!/usr/bin/env node
/**
 * 从 CubeMX 的第三方包索引目录生成 src/engine/xcube-catalog.ts。
 *
 *   node scripts/gen-xcube-catalog.mjs [pdscDir] [outFile]
 *
 * 默认 pdscDir = <STM32CUBEMX_HOME 或 USERPROFILE/.stm32cubemx>/thirdparties/pdsc
 * 默认 outFile = src/engine/xcube-catalog.ts
 *
 * pdsc 文件名形如 <vendor>.<packName>[.<version>].pdsc，例如
 *   STMicroelectronics.X-CUBE-ALGOBUILD.1.4.0.pdsc
 *   wolfSSL.I-CUBE-wolfMQTT.pdsc
 * 与 .ioc 里的 Mcu.ThirdParty0=STMicroelectronics.X-CUBE-ALGOBUILD.1.4.0 一一对应。
 */
import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function defaultPdscDir(env) {
  const explicit = (env.STM32CUBEMX_HOME ?? "").trim();
  if (explicit !== "") return join(explicit, "thirdparties", "pdsc");
  const home = (env.USERPROFILE ?? env.HOME ?? "").trim();
  if (home === "") throw new Error("找不到 CubeMX 用户目录：请传 pdscDir 参数，或设置 STM32CUBEMX_HOME / USERPROFILE");
  return join(home, ".stm32cubemx", "thirdparties", "pdsc");
}

/** 版本号按段做数字比较（字符串比较会把 1.10.0 排到 1.9.0 前面）。 */
function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.localeCompare(b);
}

/**
 * 把 pdsc 文件名解析成 { vendor, name, versions[] }。
 * 文件名里没有版本号的那些（CubeMX 的「最新版」快捷索引）也会被收进来。
 */
export function parsePdscFileNames(names) {
  const packs = new Map();
  for (const fileName of names) {
    if (!fileName.toLowerCase().endsWith(".pdsc")) continue;
    const stem = fileName.slice(0, -".pdsc".length);
    const dot = stem.indexOf(".");
    if (dot <= 0) continue;
    const vendor = stem.slice(0, dot);
    let rest = stem.slice(dot + 1);
    // 版本号是结尾连续的若干段纯数字（1.4.0 要整段剥掉，只剥最后一段会得到 name=...ALGOBUILD.1.4）。
    const segments = rest.split(".");
    const versionParts = [];
    while (segments.length > 1 && /^[0-9]+$/.test(segments[segments.length - 1])) {
      versionParts.unshift(segments.pop());
    }
    const version = versionParts.length > 0 ? versionParts.join(".") : null;
    rest = segments.join(".");
    if (rest === "") continue;
    const key = vendor.toLowerCase() + "." + rest.toLowerCase();
    const entry = packs.get(key) ?? { vendor, name: rest, versions: [] };
    if (version !== null && !entry.versions.includes(version)) entry.versions.push(version);
    packs.set(key, entry);
  }
  return [...packs.values()]
    .map((e) => ({ vendor: e.vendor, name: e.name, versions: e.versions.slice().sort(compareVersions) }))
    .sort((a, b) => (a.vendor + "." + a.name).localeCompare(b.vendor + "." + b.name));
}

function render(packs, source, generatedAt, fileCount) {
  const out = [];
  out.push("/**");
  out.push(" * X-CUBE / I-CUBE 第三方包目录（快照）。");
  out.push(" *");
  out.push(" * 由 scripts/gen-xcube-catalog.mjs 从 CubeMX 的包索引目录生成，不要手改；想要最新的目录，重跑一次生成脚本。");
  out.push(" *");
  out.push(" * 来源：" + source);
  out.push(" * 生成时间：" + generatedAt);
  out.push(" * 索引文件数：" + String(fileCount));
  out.push(" *");
  out.push(" * 用途：.ioc 里第三方包的身份有两种写法，都靠这张表认出来 ——");
  out.push(" *   Mcu.ThirdParty0=STMicroelectronics.X-CUBE-ALGOBUILD.1.4.0");
  out.push(" *   STMicroelectronics.X-CUBE-ALGOBUILD.1.4.0.IPParameters=...");
  out.push(" * 有了目录才能判断这个工程到底用不用第三方包，进而决定 thirdparties/pdsc 要不要加载。");
  out.push(" */");
  out.push("");
  out.push("export interface XCubeCatalogEntry {");
  out.push("  /** 包供应商（pdsc 文件名第一段），例如 STMicroelectronics。 */");
  out.push("  vendor: string;");
  out.push("  /** 包名（pdsc 文件名第二段），例如 X-CUBE-ALGOBUILD。 */");
  out.push("  name: string;");
  out.push("  /** 本机索引里出现过的版本（升序，可能为空）。 */");
  out.push("  versions: string[];");
  out.push("}");
  out.push("");
  out.push("/** 生成这份快照时 CubeMX 包索引目录里的 .pdsc 文件数。 */");
  out.push("export const XCUBE_CATALOG_FILE_COUNT = " + String(fileCount) + ";");
  out.push("");
  out.push("/** 快照来源（进报告 notes，便于判断新旧）。 */");
  out.push("export const XCUBE_CATALOG_SOURCE = " + JSON.stringify(source) + ";");
  out.push("");
  out.push("/** 生成时间（ISO 字符串）。 */");
  out.push("export const XCUBE_CATALOG_GENERATED_AT = " + JSON.stringify(generatedAt) + ";");
  out.push("");
  out.push("export const XCUBE_PACK_CATALOG: XCubeCatalogEntry[] = [");
  for (const pack of packs) {
    const versions = pack.versions.map((v) => JSON.stringify(v)).join(", ");
    out.push("  { vendor: " + JSON.stringify(pack.vendor) + ", name: " + JSON.stringify(pack.name) + ", versions: [" + versions + "] },");
  }
  out.push("];");
  out.push("");
  return out.join("\n");
}

function main(argv) {
  const env = process.env;
  const pdscDir = argv[2] ? resolve(argv[2]) : defaultPdscDir(env);
  const outFile = argv[3] ? resolve(argv[3]) : join(repoRoot, "src", "engine", "xcube-catalog.ts");
  const names = readdirSync(pdscDir);
  const packs = parsePdscFileNames(names);
  if (packs.length === 0) throw new Error("在 " + pdscDir + " 里没解析出任何包（目录选错了？）");
  const source = pdscDir.replace(/\\/g, "/") + "（" + String(names.length) + " 个 .pdsc）";
  const text = render(packs, source, new Date().toISOString(), names.length);
  writeFileSync(outFile, text, "utf8");
  console.log("packages=" + String(packs.length) + " files=" + String(names.length) + " -> " + outFile);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv);
}
