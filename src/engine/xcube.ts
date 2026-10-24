/**
 * L1：第三方包（X-CUBE / I-CUBE）身份识别。
 *
 * 为什么要有这张表：判断「这个工程要不要 thirdparties/pdsc」有两件事要做对 ——
 *   1. 认得出 .ioc 里用的是什么包。CubeMX 写的是 `Mcu.ThirdParty0=STMicroelectronics.X-CUBE-ALGOBUILD.1.4.0`，
 *      形如 <vendor>.<pack>.<version>，与 pdsc 文件名（<vendor>.<pack>[.<version>].pdsc）同构；
 *   2. 说得清本机有没有这个包。目录里的 159 个 .pdsc 就是 CubeMX 能加载的全部索引。
 *
 * 所以：包目录由 scripts/gen-xcube-catalog.mjs 从 CubeMX 的 pdsc 目录生成成快照（xcube-catalog.ts），
 * 这里负责把 .ioc 文本解析成包引用、再跟「本机索引」和「程序里的快照」对一遍。
 *
 * 不变量：认不出就保守（宁可多加载 25 s 的索引，也不要漏包生成错代码）。
 */

import { readdirSync } from "node:fs";

import { XCUBE_PACK_CATALOG } from "./xcube-catalog.js";
import type { XCubeCatalogEntry } from "./xcube-catalog.js";

/** 原始行截断长度（进证据/报错，别把一整行 5 KB 的键塞进去）。 */
const MAX_RAW = 160;

/** 证据里最多列几个包。 */
const MAX_LISTED_PACKS = 3;

/** 本机是否装了这个包。 */
export type PackInstalled = "exact" | "other-version" | "missing" | "unknown";

/** 本机 pdsc 索引里的一个包。 */
export interface InstalledPack {
  vendor: string;
  name: string;
  versions: string[];
}

/** .ioc 里引用到的一个第三方包。 */
export interface PackRef {
  /** 命中的原始行（截断到 160 字符）。 */
  raw: string;
  vendor: string;
  name: string;
  /** 工程要求的版本；.ioc 没写版本时为 null。 */
  requestedVersion: string | null;
  /** 本机索引的安装情况。 */
  installed: PackInstalled;
  /** 本机装了这个包的哪些版本。 */
  installedVersions: string[];
}

/** 扫描 .ioc 得到的第三方包视图。 */
export interface IocPackScan {
  /** Mcu.ThirdPartyNb 的值；没有这个键时为 null。 */
  thirdPartyNb: number | null;
  /** Mcu.ThirdPartyNb 原始行（值为正时留作证据）。 */
  nbLine: string | null;
  /** 引用到的包（同一 vendor.name 合并成一条）。 */
  packs: PackRef[];
  /** 命中了目录包名、但凑不出 vendor.name 的行（例如 ProjectManager.ProjectName=X-CUBE-AI-demo）。 */
  markers: string[];
  /** Mcu.ThirdParty 行但内容解析不了（保守当作需要索引）。 */
  malformed: string[];
}

export interface ScanOptions {
  /** 本机 pdsc 索引（由 listInstalledPacks 得到）；不给就一律 unknown，不做存在性判断。 */
  installed?: InstalledPack[] | null;
}

/** 目录条目按 vendor.name 长度降序：先匹配更长的包名，免得 X-CUBE-AI 抢走 X-CUBE-AI-xxx 的行。 */
const BY_LENGTH: XCubeCatalogEntry[] = XCUBE_PACK_CATALOG.slice().sort(
  (a, b) => b.vendor.length + b.name.length - (a.vendor.length + a.name.length),
);

function isNumericSegment(text: string | undefined): boolean {
  return text !== undefined && /^[0-9]+$/u.test(text);
}

function clip(text: string): string {
  return text.length > MAX_RAW ? text.slice(0, MAX_RAW) + "…" : text;
}

/** 在快照里按 vendor + name 找包（大小写不敏感）。 */
export function findCatalogPack(vendor: string, name: string): XCubeCatalogEntry | null {
  const v = vendor.toLowerCase();
  const n = name.toLowerCase();
  for (const entry of XCUBE_PACK_CATALOG) {
    if (entry.vendor.toLowerCase() === v && entry.name.toLowerCase() === n) return entry;
  }
  return null;
}

/** 人读的包名：STMicroelectronics.X-CUBE-ALGOBUILD 1.4.0。 */
export function describePack(ref: PackRef): string {
  const id = ref.vendor + "." + ref.name;
  return ref.requestedVersion === null ? id : id + " " + ref.requestedVersion;
}

/** 把 pdsc 文件名解析成包列表（规则与 scripts/gen-xcube-catalog.mjs 一致，测试会对齐两边）。 */
export function parsePdscNames(names: string[]): InstalledPack[] {
  const map = new Map<string, InstalledPack>();
  for (const fileName of names) {
    if (!fileName.toLowerCase().endsWith(".pdsc")) continue;
    const stem = fileName.slice(0, -".pdsc".length);
    const dot = stem.indexOf(".");
    if (dot <= 0) continue;
    const vendor = stem.slice(0, dot);
    const segments = stem.slice(dot + 1).split(".");
    const versionParts: string[] = [];
    while (segments.length > 1 && isNumericSegment(segments[segments.length - 1])) {
      const popped = segments.pop();
      if (popped === undefined) break;
      versionParts.unshift(popped);
    }
    const name = segments.join(".");
    if (name === "") continue;
    const key = (vendor + "." + name).toLowerCase();
    const entry = map.get(key) ?? { vendor, name, versions: [] };
    const version = versionParts.length > 0 ? versionParts.join(".") : null;
    if (version !== null && !entry.versions.includes(version)) entry.versions.push(version);
    map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => (a.vendor + "." + a.name).localeCompare(b.vendor + "." + b.name));
}

/** 读本机 pdsc 索引目录；读不到返回 null（调用方按 unknown 处理）。 */
export function listInstalledPacks(pdscDir: string): InstalledPack[] | null {
  try {
    return parsePdscNames(readdirSync(pdscDir));
  } catch {
    return null;
  }
}

/** 把 `Vendor.Pack[.version]` 拆成三段；认不出来返回 null。 */
export function identifyPackId(value: string): { vendor: string; name: string; version: string | null } | null {
  const id = value.trim();
  if (id === "" || id.includes(" ")) return null;
  const lower = id.toLowerCase();
  for (const entry of BY_LENGTH) {
    const prefix = (entry.vendor + "." + entry.name).toLowerCase();
    if (!lower.startsWith(prefix)) continue;
    const rest = id.slice(prefix.length);
    if (rest === "") return { vendor: entry.vendor, name: entry.name, version: null };
    if (!rest.startsWith(".")) continue;
    const version = rest.slice(1);
    if (version === "" || /\s/u.test(version)) return null;
    return { vendor: entry.vendor, name: entry.name, version };
  }
  // 目录里没有的包（私有包 / 新包）：第一段当 vendor、结尾纯数字段当版本，剩下的都算包名。
  const segments = id.split(".");
  if (segments.length < 2 || segments[0] === "" || segments[1] === "") return null;
  const versionParts: string[] = [];
  while (segments.length > 2 && isNumericSegment(segments[segments.length - 1])) {
    const popped = segments.pop();
    if (popped === undefined) break;
    versionParts.unshift(popped);
  }
  const vendor = segments[0];
  if (vendor === undefined) return null;
  return {
    vendor,
    name: segments.slice(1).join("."),
    version: versionParts.length > 0 ? versionParts.join(".") : null,
  };
}

function versionsOf(installed: InstalledPack[] | null, vendor: string, name: string): string[] | null {
  if (installed === null) return null;
  const v = vendor.toLowerCase();
  const n = name.toLowerCase();
  for (const pack of installed) {
    if (pack.vendor.toLowerCase() === v && pack.name.toLowerCase() === n) return pack.versions;
  }
  return [];
}

function installStatus(versions: string[] | null, requested: string | null): PackInstalled {
  if (versions === null) return "unknown";
  if (versions.length === 0) return "missing";
  if (requested === null) return "exact";
  return versions.includes(requested) ? "exact" : "other-version";
}

/** 在一行里找「目录里的 vendor.name」，返回命中的条目与紧随其后的版本号。 */
function packOnLine(line: string): { entry: XCubeCatalogEntry; version: string | null } | null {
  const lower = line.toLowerCase();
  for (const entry of BY_LENGTH) {
    const prefix = (entry.vendor + "." + entry.name).toLowerCase();
    const at = lower.indexOf(prefix);
    if (at < 0) continue;
    const rest = line.slice(at + prefix.length);
    const version = /^\.([0-9]+(?:\.[0-9]+)*)/u.exec(rest);
    const captured = version === null ? undefined : version[1];
    return { entry, version: captured === undefined ? null : captured };
  }
  return null;
}

/** 一行里是否出现了目录包名（哪怕凑不出 vendor，例如 X-CUBE-AI-demo）。 */
function barePackNameOnLine(line: string): string | null {
  const lower = line.toLowerCase();
  for (const entry of BY_LENGTH) {
    if (lower.includes(entry.name.toLowerCase())) return entry.name;
  }
  return null;
}

/**
 * 扫描 .ioc 正文，找出第三方包引用与 Mcu.ThirdPartyNb。
 *
 * 判定顺序：Mcu.ThirdPartyNb → Mcu.ThirdParty<k>（权威）→ 任意行里的 vendor.name → 任意行里的裸包名。
 */
export function scanIocPacks(iocText: string, options: ScanOptions = {}): IocPackScan {
  const installed = options.installed ?? null;
  const packs: PackRef[] = [];
  const byId = new Map<string, PackRef>();
  const markers: string[] = [];
  const malformed: string[] = [];
  let thirdPartyNb: number | null = null;
  let nbLine: string | null = null;

  const add = (vendor: string, name: string, version: string | null, raw: string): void => {
    const key = (vendor + "." + name).toLowerCase();
    const existing = byId.get(key);
    if (existing !== undefined) {
      // 同一包可能出现在 Mcu.ThirdParty0 与 STMicroelectronics.X-CUBE-X.Y.Z.IPParameters 两处；补全版本即可。
      // 证据优先留 Mcu.ThirdParty<k> 这种「声明行」，比 VP_/IPParameters 行更好读。
      if (/^Mcu\.ThirdParty[0-9]+\s*=/u.test(raw) && !/^Mcu\.ThirdParty[0-9]+\s*=/u.test(existing.raw)) {
        existing.raw = clip(raw);
      }
      if (existing.requestedVersion === null && version !== null) {
        const versions = versionsOf(installed, vendor, name);
        existing.requestedVersion = version;
        existing.installed = installStatus(versions, version);
      }
      return;
    }
    const versions = versionsOf(installed, vendor, name);
    const ref: PackRef = {
      raw: clip(raw),
      vendor,
      name,
      requestedVersion: version,
      installed: installStatus(versions, version),
      installedVersions: versions ?? [],
    };
    byId.set(key, ref);
    packs.push(ref);
  };

  for (const raw of iocText.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const nb = /^Mcu\.ThirdPartyNb\s*=\s*(-?[0-9]+)\s*$/u.exec(line);
    if (nb !== null) {
      const digits = nb[1];
      const parsed = digits === undefined ? null : Number(digits);
      thirdPartyNb = parsed;
      if (parsed !== null && parsed > 0) nbLine = clip(line);
      continue;
    }
    // 值可能是空的（Mcu.ThirdParty0=），那也算解析不了 —— 保守一点，宁可加载索引。
    const declared = /^Mcu\.ThirdParty[0-9]+\s*=\s*(.*)$/u.exec(line);
    if (declared !== null) {
      const value = declared[1];
      if (value === undefined) {
        malformed.push(clip(line));
        continue;
      }
      const id = identifyPackId(value.trim());
      if (id === null) {
        malformed.push(clip(line));
      } else {
        add(id.vendor, id.name, id.version, line);
      }
      continue;
    }
    const found = packOnLine(line);
    if (found !== null) {
      add(found.entry.vendor, found.entry.name, found.version, line);
      continue;
    }
    if (barePackNameOnLine(line) !== null && markers.length < MAX_LISTED_PACKS) markers.push(clip(line));
  }
  return { thirdPartyNb, nbLine, packs, markers, malformed };
}

/** 把包列表写成一句话（证据/原因里用）。 */
export function summarizePacks(packs: PackRef[]): string {
  if (packs.length === 0) return "";
  const listed = packs.slice(0, MAX_LISTED_PACKS).map(describePack).join("、");
  return packs.length > MAX_LISTED_PACKS ? listed + " 等 " + String(packs.length) + " 个" : listed;
}
