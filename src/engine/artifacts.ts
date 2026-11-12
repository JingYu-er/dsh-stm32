/**
 * 产物与内存：读构建目录里的 elf / hex / bin，配上芯片的 Flash / RAM 容量，供调试台显示。
 *
 * 只读文件属性，不跑 size / objdump：内存占用来自上一次 `stm32_build` 的
 * `--print-memory-usage` 结果（面板从事件流里取），避免为了一个数字再起一个子进程。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { findChipFact } from "../data/device-facts.js";
import { detectBuildDir, findElf, type ElfInfo } from "./build.js";
import { readIocCpn } from "./breakpoints.js";

export interface ArtifactFile {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
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
  /** 需要人注意的地方（多个 elf、没有构建目录、型号未知）。 */
  readonly notes: readonly string[];
}

export type ArtifactsResult = { readonly ok: true; readonly report: ArtifactsReport } | { readonly ok: false; readonly error: string };

function statFile(file: string): ArtifactFile | null {
  try {
    const info = statSync(file);
    return { name: basename(file), path: file, size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

/** 与 elf 同名、扩展名不同的兄弟产物。 */
function sibling(elfPath: string, extension: string): ArtifactFile | null {
  const dot = elfPath.lastIndexOf(".");
  const base = dot === -1 ? elfPath : elfPath.slice(0, dot);
  return statFile(base + extension);
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
  const elf = elfInfo === null ? null : statFile(elfInfo.path);
  const hex = elf === null ? null : sibling(elf.path, ".hex");
  const bin = elf === null ? null : sibling(elf.path, ".bin");
  const otherElves = buildDir === "" ? [] : listElves(buildDir).filter((file) => file.path !== elf?.path);
  if (otherElves.length > 0) {
    notes.push("构建目录里有 " + String(otherElves.length + 1) + " 个 .elf，当前显示按工程名/修改时间挑出的那个。");
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
      notes,
    },
  };
}

/** 构建目录存在但还没有产物的判断，供面板给出下一步。 */
export function hasBuildDir(projectDir: string): boolean {
  const dir = detectBuildDir(projectDir);
  return dir !== null && existsSync(dir);
}
