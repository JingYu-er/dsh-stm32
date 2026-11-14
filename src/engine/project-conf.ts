/**
 * `dsh-stm32.conf`：工程与工作区的自描述文件（S81）。
 *
 * 两处同名文件、两种用途：
 * - 工程根：记录检测这个工程需要的最小事实（型号、.ioc、构建配置名）。
 * - 工作区根：记录这个工作区里有哪些工程，供面板的工程选择器用。
 *
 * 格式是有意的极简 `key=value`：一行一条、`#` 开头是注释、`project=` 可重复。
 * 不用 JSON——这个文件会被人手工改，多一行缩进就多一种改坏的方式。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/** 两个位置用同一个文件名。 */
export const CONF_FILE_NAME = "dsh-stm32.conf";

/** 解析后的一对：单值键与可重复键。 */
export interface ConfDocument {
  readonly path: string;
  readonly single: Map<string, string>;
  readonly multi: Map<string, string[]>;
}

/** 工作区索引里的一条工程。 */
export interface WorkspaceProject {
  readonly name: string;
  /** 绝对路径（相对路径按工作区根解析）。 */
  readonly dir: string;
  /** 目录是否真的存在；不存在时面板标灰，不删记录。 */
  readonly exists: boolean;
}

export interface WorkspaceIndex {
  readonly workspaceRoot: string;
  readonly confPath: string;
  readonly exists: boolean;
  readonly projects: readonly WorkspaceProject[];
}

export interface ProjectConf {
  readonly projectDir: string;
  readonly confPath: string;
  readonly exists: boolean;
  readonly name: string;
  readonly mcu: string;
  readonly ioc: string;
  readonly build: string;
  /** 程序目录（相对工程根）；空串表示「按约定自动找」（S95）。 */
  readonly firmware: string;
  /** KiCad 目录（相对工程根）；空串表示「按约定自动找」（S95）。 */
  readonly hardware: string;
}

/** 把文本解析成 `key=value` 文档；非法行跳过，不抛。 */
export function parseConf(text: string, confPath = ""): ConfDocument {
  const single = new Map<string, string>();
  const multi = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key === "") continue;
    if (key === "project") {
      const list = multi.get(key) ?? [];
      list.push(value);
      multi.set(key, list);
      continue;
    }
    if (!single.has(key)) single.set(key, value);
  }
  return { path: confPath, single, multi };
}

/** 读文件；不存在或读不了一律返回空文档，由调用方按「没有描述」处理。 */
export function readConf(confPath: string): ConfDocument {
  try {
    return parseConf(readFileSync(confPath, "utf8"), confPath);
  } catch {
    return parseConf("", confPath);
  }
}

/** 工作区根：相对路径解析到这里。 */
function resolveWorkspaceRoot(workspaceRoot: string): string {
  const trimmed = workspaceRoot.trim();
  return resolve(trimmed === "" ? process.cwd() : trimmed);
}

/** 读工作区索引：`project=` 每行一个，可写目录名或相对路径。 */
export function readWorkspaceIndex(workspaceRoot: string): WorkspaceIndex {
  const root = resolveWorkspaceRoot(workspaceRoot);
  const confPath = join(root, CONF_FILE_NAME);
  const doc = readConf(confPath);
  const names = doc.multi.get("project") ?? [];
  const seen = new Set<string>();
  const projects: WorkspaceProject[] = [];
  for (const raw of names) {
    const dir = resolve(root, raw);
    if (seen.has(dir)) continue;
    seen.add(dir);
    projects.push({ name: basename(dir), dir, exists: existsSync(dir) });
  }
  return { workspaceRoot: root, confPath, exists: existsSync(confPath), projects };
}

/** 把工程登记进工作区索引；已存在则不重复写，返回是否真的追加了。 */
export function registerWorkspaceProject(workspaceRoot: string, projectDir: string): boolean {
  const root = resolveWorkspaceRoot(workspaceRoot);
  const target = resolve(projectDir);
  const index = readWorkspaceIndex(root);
  if (index.projects.some((item) => item.dir === target)) return false;
  // 用相对于工作区根的路径，工作区整体搬家后仍然成立。
  const relative = target.startsWith(root + "\\") || target.startsWith(root + "/")
    ? target.slice(root.length + 1).replace(/\\/gu, "/")
    : target.replace(/\\/gu, "/");
  const header = [
    "# dsh-stm32 工作区索引：由插件写入，手工增删也可。",
    "# 一行一个工程，写相对路径或目录名。",
    "version=1",
  ].join("\n");
  const body = index.exists ? readFileSync(index.confPath, "utf8").replace(/\s*$/u, "\n") : header + "\n";
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(index.confPath, body + "project=" + relative + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

/** 读工程描述；缺字段返回空串，面板据此判断「这个工程还没被插件创建过」。 */
export function readProjectConf(projectDir: string): ProjectConf {
  const dir = resolve(projectDir.trim() === "" ? "." : projectDir);
  const confPath = join(dir, CONF_FILE_NAME);
  const doc = readConf(confPath);
  return {
    projectDir: dir,
    confPath,
    exists: existsSync(confPath),
    name: doc.single.get("name") ?? basename(dir),
    mcu: doc.single.get("mcu") ?? "",
    ioc: doc.single.get("ioc") ?? "",
    build: doc.single.get("build") ?? "",
    firmware: doc.single.get("firmware") ?? "",
    hardware: doc.single.get("hardware") ?? "",
  };
}

/**
 * 写工程描述：只写检测该工程所需的最小事实，写入是覆盖式的。
 *
 * `createdAt` 保留首次创建时间——重写不改变它，便于回答「这个工程什么时候建的」。
 */
export function writeProjectConf(
  projectDir: string,
  facts: { name?: string; mcu?: string; ioc?: string; build?: string; firmware?: string; hardware?: string },
): boolean {
  const dir = resolve(projectDir.trim() === "" ? "." : projectDir);
  const existing = readConf(join(dir, CONF_FILE_NAME));
  const createdAt = existing.single.get("createdAt") ?? new Date().toISOString();
  const lines = [
    "# dsh-stm32 工程描述：由插件写入，手工改也可。",
    "version=1",
    "name=" + (facts.name ?? existing.single.get("name") ?? basename(dir)),
    "mcu=" + (facts.mcu ?? existing.single.get("mcu") ?? ""),
    "ioc=" + (facts.ioc ?? existing.single.get("ioc") ?? ""),
    "build=" + (facts.build ?? existing.single.get("build") ?? ""),
    "firmware=" + (facts.firmware ?? existing.single.get("firmware") ?? ""),
    "hardware=" + (facts.hardware ?? existing.single.get("hardware") ?? ""),
    "createdAt=" + createdAt,
  ];
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, CONF_FILE_NAME), lines.join("\n") + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * 扫描工作区里的工程（S82）：深度 ≤2 的目录里，含 `*.ioc` 或 `CMakeLists.txt` 就算一个。
 *
 * 只在工作区索引缺失或用户想「找回来」时用；结果与索引合并展示，不写回索引。
 */
export function scanWorkspaceProjects(workspaceRoot: string, maxDepth = 2): WorkspaceProject[] {
  const root = resolveWorkspaceRoot(workspaceRoot);
  const found: WorkspaceProject[] = [];

  /** 目录是不是一个工程：认四种标记里的任意一种（S95）。 */
  const isProjectDir = (dir: string): boolean => {
    let names: string[] = [];
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((item) => item.isFile())
        .map((item) => item.name);
    } catch {
      return false;
    }
    if (names.some((name) => name.endsWith(".ioc") || name === "CMakeLists.txt")) return true;
    if (names.some((name) => name.endsWith(".kicad_pro"))) return true;
    // 单有 conf 不算工程：工作区根也用同名文件，它记的是索引而不是工程事实。
    // 只有写了工程字段（mcu= / firmware= / hardware=）的 conf 才算。
    if (names.includes(CONF_FILE_NAME)) {
      try {
        const text = readFileSync(join(dir, CONF_FILE_NAME), "utf8");
        if (/^(mcu|firmware|hardware)=/mu.test(text)) return true;
      } catch {
        /* 读不了就按「不是工程」处理 */
      }
    }
    // 约定式工程：根上没有标记，但程序与硬件各在一个子目录里。
    try {
      const dirs = readdirSync(dir, { withFileTypes: true })
        .filter((item) => item.isDirectory())
        .map((item) => item.name.toLowerCase());
      return dirs.includes("program") || dirs.includes("firmware") || dirs.includes("hardware");
    } catch {
      return false;
    }
  };

  /** 往下扫时跳过的目录：构建产物、工具链源码、插件自有数据。 */
  const skip = new Set(["build", "drivers", "node_modules", ".dsh-stm32", "cmake", "gerber", "bom", "core"]);

  // 工作区根自己就是工程时只列它一个：再往下扫必然扫到工程内部构件（S84 的教训）。
  if (isProjectDir(root)) return [{ name: basename(root), dir: root, exists: true }];

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((item) => item.isDirectory() && !item.name.startsWith(".") && !skip.has(item.name.toLowerCase()))
        .map((item) => item.name);
    } catch {
      return;
    }
    for (const name of entries) {
      const child = join(dir, name);
      if (isProjectDir(child)) {
        found.push({ name, dir: child, exists: true });
        // 工程内部不再下钻：里面的 program/、hardware/ 是它的组成部分，不是兄弟工程。
        continue;
      }
      walk(child, depth + 1);
    }
  };
  walk(root, 1);
  return found;
}
