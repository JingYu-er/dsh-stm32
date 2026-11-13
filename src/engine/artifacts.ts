/**
 * 产物与内存：读构建目录里的 elf / hex / bin，配上芯片的 Flash / RAM 容量，供调试台显示。
 *
 * 只读文件属性，不跑 size / objdump：内存占用来自上一次 `stm32_build` 的
 * `--print-memory-usage` 结果（面板从事件流里取），避免为了一个数字再起一个子进程。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { findChipFact } from "../data/device-facts.js";
import { detectBuildDir, findElf, type ElfInfo } from "./build.js";
import { readIocCpn } from "./breakpoints.js";

export interface ArtifactFile {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  /** 文件的 SHA-256（十六进制小写）；超过上限或读不出时为空串（S62）。 */
  readonly sha256: string;
}

export interface ChipBudget {
  readonly cpn: string;
  readonly flashBytes: number;
  readonly ramBytes: number;
}

export interface ArtifactsReport {
  readonly projectDir: string;
  /** 选中的构建目录；工程没配过或还没构建时为空串。 */
  readonly buildDir: string;
  readonly elf: ArtifactFile | null;
  readonly hex: ArtifactFile | null;
  readonly bin: ArtifactFile | null;
  /** 同一构建目录里的其它 .elf（多目标工程）。 */
  readonly otherElves: readonly ArtifactFile[];
  /** 芯片容量；.ioc 里没有型号或资源包没有这颗芯片时为 null。 */
  readonly chip: ChipBudget | null;
  /** elf 的 SHA-256（十六进制小写）；没有 elf、或文件超过上限时为空串。 */
  readonly sha256: string;
  /** 需要人注意的地方（多个 elf、没有构建目录、型号未知、校验和跳过）。 */
  readonly notes: readonly string[];
}

export type ArtifactsResult = { readonly ok: true; readonly report: ArtifactsReport } | { readonly ok: false; readonly error: string };

function statFile(file: string): ArtifactFile | null {
  try {
    const info = statSync(file);
    return { name: basename(file), path: file, size: info.size, mtimeMs: info.mtimeMs, sha256: "" };
  } catch {
    return null;
  }
}

/** 给一个产物补上校验和；超过上限的文件保持空串，调用方据此提示（S62）。 */
function withHash(file: ArtifactFile | null): ArtifactFile | null {
  if (file === null) return null;
  return { ...file, sha256: hashFile(file) };
}

/** 与 elf 同名、扩展名不同的兄弟产物。 */
function sibling(elfPath: string, extension: string): ArtifactFile | null {
  const dot = elfPath.lastIndexOf(".");
  const base = dot === -1 ? elfPath : elfPath.slice(0, dot);
  return statFile(base + extension);
}

/** 超过这个大小的 elf 不算校验和：调试台每 10 秒轮询一次，不值得。 */
export const ARTIFACT_HASH_MAX_BYTES = 8 * 1024 * 1024;

/** 单个文件的 SHA-256（S68）：构建摘要用它标出「这次 elf 和上次是不是同一个」。 */
export function sha256OfPath(filePath: string): string {
  const file = statFile(filePath);
  return file === null ? "" : hashFile(file);
}

function hashFile(file: ArtifactFile): string {
  if (file.size > ARTIFACT_HASH_MAX_BYTES) return "";
  try {
    return createHash("sha256").update(readFileSync(file.path)).digest("hex");
  } catch {
    return "";
  }
}

function listElves(buildDir: string): ArtifactFile[] {
  let names: string[];
  try {
    names = readdirSync(buildDir);
  } catch {
    return [];
  }
  const files: ArtifactFile[] = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".elf")) continue;
    const file = statFile(join(buildDir, name));
    if (file !== null) files.push(file);
  }
  return files;
}

export function readArtifacts(projectDir: string, env: NodeJS.ProcessEnv = process.env): ArtifactsResult {
  const dir = projectDir.trim();
  if (dir === "") return { ok: false, error: "projectDir 不能为空" };
  const notes: string[] = [];
  const buildDir = detectBuildDir(dir) ?? "";
  if (buildDir === "") {
    notes.push("还没有可识别的构建目录：先执行 stm32_build 或 cmake --preset。");
  }
  let elfInfo: ElfInfo | null = null;
  if (buildDir !== "") elfInfo = findElf(buildDir);
  const elf = withHash(elfInfo === null ? null : statFile(elfInfo.path));
  const hex = withHash(elf === null ? null : sibling(elf.path, ".hex"));
  const bin = withHash(elf === null ? null : sibling(elf.path, ".bin"));
  const otherElves = buildDir === "" ? [] : listElves(buildDir).filter((file) => file.path !== elf?.path);
  if (otherElves.length > 0) {
    notes.push("构建目录里有 " + String(otherElves.length + 1) + " 个 .elf，当前显示按工程名/修改时间挑出的那个。");
  }
  const sha256 = elf?.sha256 ?? "";
  if (elf !== null && sha256 === "") {
    notes.push("elf 超过 " + String(Math.round(ARTIFACT_HASH_MAX_BYTES / 1024 / 1024)) + " MB，跳过校验和。");
  }
  const cpn = readIocCpn(dir);
  let chip: ChipBudget | null = null;
  if (cpn !== "") {
    const fact = findChipFact(cpn, env);
    if (fact === null) notes.push("资源包里没有 " + cpn + " 的容量数据，内存占用只能看构建输出。");
    else chip = { cpn, flashBytes: fact.flashBytes, ramBytes: fact.ramBytes };
  } else {
    notes.push("工程里没有 .ioc 的 Mcu.CPN，无法给出容量上限。");
  }
  return {
    ok: true,
    report: {
      projectDir: dir,
      buildDir,
      elf,
      hex,
      bin,
      otherElves,
      chip,
      sha256,
      notes,
    },
  };
}

/** 构建目录存在但还没有产物的判断，供面板给出下一步。 */
export function hasBuildDir(projectDir: string): boolean {
  const dir = detectBuildDir(projectDir);
  return dir !== null && existsSync(dir);
}
