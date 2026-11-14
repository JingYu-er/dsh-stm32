/**
 * 工程目录约定（S95）。
 *
 * 一个工程根下允许分成几块，各自独立演进：
 *
 * ```
 * <project>/
 *   program/     STM32 程序：.ioc 与 CMakeLists.txt（缺省名，可用 conf 改）
 *   hardware/    KiCad 工程：.kicad_pro 与 .kicad_sch（缺省名，可用 conf 改）
 *   .dsh-stm32/  插件自己的数据（证据、备份、快照），类似 .vscode
 *   dsh-stm32.conf
 * ```
 *
 * 为什么不是「把所有东西都放根目录」：程序目录与硬件目录来自不同工具链，
 * 版本节奏也不同（硬件改版比代码慢得多），混在一起时两边都会扫到对方的中间产物。
 *
 * 兼容：老工程把程序放在根目录（`.ioc` 就在根上）时 `firmwareDir` 等于根，
 * 行为与改造前一致；`hardwareDir` 找不到时返回空串，由调用方给出「没有原理图」的提示。
 */

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { readProjectConf } from "./project-conf.js";

/** 程序目录的候选名，按优先级排；`""` 表示根目录本身。 */
const FIRMWARE_CANDIDATES: readonly string[] = ["program", "firmware", "app", "user", ""];

/** KiCad 目录的候选名，按优先级排。 */
const HARDWARE_CANDIDATES: readonly string[] = ["hardware", "kicad", "hw", "pcb"];

/** 扫描 KiCad 工程时跳过的目录名：历史版本、构建产物、插件自己的数据。 */
const SCAN_SKIP: readonly string[] = [".history", "build", "node_modules", ".dsh-stm32", "Gerber", "bom"];

export interface ProjectLayout {
  /** 工程根（用户选中的那层）。 */
  readonly projectDir: string;
  /** 程序目录：.ioc、CMakeLists.txt、构建产物在这里。 */
  readonly firmwareDir: string;
  /** KiCad 目录；找不到时为空串。 */
  readonly hardwareDir: string;
  /** 插件数据目录（`<project>/.dsh-stm32`），可能存在也可能不存在。 */
  readonly configDir: string;
  /** 判定依据，写进报告便于解释「为什么选了这个目录」。 */
  readonly notes: readonly string[];
}

function isDir(path: string): boolean {
  try {
    return existsSync(path) && readdirSync(path) !== null;
  } catch {
    return false;
  }
}

function hasFile(dir: string, predicate: (name: string) => boolean): boolean {
  try {
    return readdirSync(dir, { withFileTypes: true }).some((item) => item.isFile() && predicate(item.name));
  } catch {
    return false;
  }
}

function hasFirmwareMarker(dir: string): boolean {
  return hasFile(dir, (name) => name.endsWith(".ioc") || name === "CMakeLists.txt");
}

function hasKicadMarker(dir: string): boolean {
  return hasFile(dir, (name) => name.endsWith(".kicad_pro") || name.endsWith(".kicad_sch"));
}

/** 在 root 下按深度找第一个含 KiCad 标记的目录（只在候选名都不命中时用）。 */
function findKicadDir(root: string, depth: number): string {
  if (depth > 2) return "";
  let entries: string[] = [];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((item) => item.isDirectory() && !item.name.startsWith(".") && !SCAN_SKIP.includes(item.name))
      .map((item) => item.name);
  } catch {
    return "";
  }
  for (const name of entries) {
    const child = join(root, name);
    if (hasKicadMarker(child)) return child;
  }
  for (const name of entries) {
    const found = findKicadDir(join(root, name), depth + 1);
    if (found !== "") return found;
  }
  return "";
}

/**
 * 解析工程目录约定。
 *
 * 顺序：`dsh-stm32.conf` 里显式写的相对路径 → 候选名（含根）→ 深度 ≤2 的搜索。
 * 不做缓存：工程目录可能在会话中途被用户重排，读一次目录比缓存失效逻辑便宜。
 */
export function resolveProjectLayout(projectDir: string): ProjectLayout {
  const root = resolve(projectDir.trim() === "" ? "." : projectDir);
  const conf = readProjectConf(root);
  const notes: string[] = [];

  let firmwareDir = "";
  if (conf.firmware !== "") {
    firmwareDir = resolve(root, conf.firmware);
    notes.push("程序目录：conf 里写的是 " + conf.firmware);
  } else {
    for (const name of FIRMWARE_CANDIDATES) {
      const candidate = name === "" ? root : join(root, name);
      if (isDir(candidate) && hasFirmwareMarker(candidate)) {
        firmwareDir = candidate;
        notes.push(name === "" ? "程序目录：工程根（.ioc 或 CMakeLists.txt 在根上）" : "程序目录：" + name);
        break;
      }
    }
  }
  if (firmwareDir === "") {
    // 标记都不在根上时退回根目录：宁可让工具在根上找，也不猜一个不存在的目录。
    firmwareDir = root;
    notes.push("程序目录：没有找到 .ioc 或 CMakeLists.txt，按工程根处理");
  }

  let hardwareDir = "";
  if (conf.hardware !== "") {
    hardwareDir = resolve(root, conf.hardware);
    notes.push("硬件目录：conf 里写的是 " + conf.hardware);
  } else {
    for (const name of HARDWARE_CANDIDATES) {
      const candidate = join(root, name);
      if (isDir(candidate) && hasKicadMarker(candidate)) {
        hardwareDir = candidate;
        notes.push("硬件目录：" + name);
        break;
      }
    }
    if (hardwareDir === "" && hasKicadMarker(root)) {
      hardwareDir = root;
      notes.push("硬件目录：工程根（KiCad 工程与程序同级）");
    }
    if (hardwareDir === "") {
      const found = findKicadDir(root, 1);
      if (found !== "") {
        hardwareDir = found;
        notes.push("硬件目录：扫描找到 " + found);
      }
    }
  }

  return {
    projectDir: root,
    firmwareDir,
    hardwareDir,
    configDir: join(root, ".dsh-stm32"),
    notes,
  };
}

/** 原理图目录：没有硬件目录时返回空串，调用方据此给「把 KiCad 工程放 hardware/ 下」的提示。 */
export function hardwareDirOf(layout: ProjectLayout): string {
  return layout.hardwareDir;
}
