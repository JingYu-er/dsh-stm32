/**
 * .ioc 基线对比：把当前 CubeMX 配置与上一次手动记下的基线逐键比较。
 *
 * 为什么不看 git：工程可以不在版本库里，也可能是别人的机器；基线要能随手记、
 * 随手比，所以单独存一份到用户目录，按工程路径分文件。
 *
 * 只读工程文件、只写自己的基线目录；不跑 CubeMX，也不改 .ioc。
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { findIocPath } from "./pinout.js";

/** 键值条目：`Mcu.CPN=STM32F103C8T6` 这种行。 */
export interface IocEntry {
  key: string;
  value: string;
}

export interface IocChange {
  key: string;
  before: string;
  after: string;
}

export interface IocDiffReport {
  iocPath: string;
  iocName: string;
  snapshotPath: string;
  hasSnapshot: boolean;
  savedAt: string;
  added: IocEntry[];
  removed: IocEntry[];
  changed: IocChange[];
  counts: { added: number; removed: number; changed: number; total: number };
  notes: string[];
}

export type IocDiffResult = { ok: true; report: IocDiffReport } | { ok: false; error: string };

export type IocSnapshotResult = { ok: true; report: IocSnapshotReport } | { ok: false; error: string };

export interface IocSnapshotReport {
  iocPath: string;
  snapshotPath: string;
  savedAt: string;
  entries: number;
}

/** 基线目录：默认 `~/.dsh-stm32/ioc-snapshots`，可用 DSH_STM32_SNAPSHOTS 覆盖。 */
export function snapshotRoot(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.DSH_STM32_SNAPSHOTS;
  if (typeof custom === "string" && custom.trim() !== "") return resolve(custom.trim());
  return join(homedir(), ".dsh-stm32", "ioc-snapshots");
}

/** 一个工程一份基线，文件名取工程绝对路径的短哈希，换机器不冲突。 */
export function snapshotPath(projectDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const digest = createHash("sha256").update(resolve(projectDir)).digest("hex").slice(0, 16);
  return join(snapshotRoot(env), digest + ".ioc");
}

/**
 * 解析 .ioc：只收第一个 `=` 前的键与之后的值。
 * 注释行、空行、没有 `=` 的行都跳过——CubeMX 版本之间会插入说明行。
 */
export function parseIocEntries(text: string): IocEntry[] {
  const out: IocEntry[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, value });
  }
  return out;
}

/** 逐键比较：新增、删除、值变化各列一张表，按 key 排序，输出稳定。 */
export function diffIocEntries(
  before: IocEntry[],
  after: IocEntry[],
): { added: IocEntry[]; removed: IocEntry[]; changed: IocChange[] } {
  const beforeMap = new Map(before.map((entry) => [entry.key, entry.value]));
  const afterMap = new Map(after.map((entry) => [entry.key, entry.value]));
  const added: IocEntry[] = [];
  const removed: IocEntry[] = [];
  const changed: IocChange[] = [];
  for (const [key, value] of afterMap) {
    if (!beforeMap.has(key)) added.push({ key, value });
    else if (beforeMap.get(key) !== value) changed.push({ key, before: beforeMap.get(key) ?? "", after: value });
  }
  for (const [key, value] of beforeMap) {
    if (!afterMap.has(key)) removed.push({ key, value });
  }
  const byKey = (left: { key: string }, right: { key: string }): number => left.key.localeCompare(right.key);
  added.sort(byKey);
  removed.sort(byKey);
  changed.sort(byKey);
  return { added, removed, changed };
}

/** 把当前 .ioc 记为基线。已有基线直接覆盖，不留历史版本。 */
export function saveIocSnapshot(projectDir: string, env: NodeJS.ProcessEnv = process.env): IocSnapshotResult {
  const dir = projectDir.trim();
  if (dir === "") return { ok: false, error: "projectDir 不能为空" };
  const iocPath = findIocPath(dir);
  if (iocPath === "") return { ok: false, error: "工程目录里没有 .ioc：" + dir };
  const target = snapshotPath(dir, env);
  try {
    mkdirSync(snapshotRoot(env), { recursive: true });
    copyFileSync(iocPath, target);
    const text = readFileSync(iocPath, "utf8");
    return {
      ok: true,
      report: {
        iocPath: iocPath,
        snapshotPath: target,
        savedAt: new Date().toISOString(),
        entries: parseIocEntries(text).length,
      },
    };
  } catch (error) {
    return { ok: false, error: "记录基线失败：" + (error instanceof Error ? error.message : String(error)) };
  }
}

/** 恢复单个键的结果：写回前的值、写回后的值、备份路径。 */
export interface IocRestoreReport {
  iocPath: string;
  key: string;
  before: string;
  after: string;
  backupPath: string;
  changed: boolean;
}

export type IocRestoreResult = { ok: true; report: IocRestoreReport } | { ok: false; error: string };

/** 写 .ioc 前的备份目录：`<工程>/.dsh-stm32/backups`。 */
export function iocBackupDir(projectDir: string): string {
  return join(projectDir, ".dsh-stm32", "backups");
}

/**
 * 把一个键写回基线里的值（S42）。
 *
 * 只改这一行，其余字节原样保留；写之前先备份到 `.dsh-stm32/backups`。
 * 基线里没有的键直接拒绝——不猜该填什么。
 */
export function restoreIocKey(
  projectDir: string,
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): IocRestoreResult {
  const dir = projectDir.trim();
  if (dir === "") return { ok: false, error: "projectDir 不能为空" };
  const wanted = key.trim();
  if (wanted === "") return { ok: false, error: "key 不能为空" };
  if (!/^[A-Za-z0-9_.]+$/u.test(wanted)) return { ok: false, error: "key 只允许字母、数字、下划线与点：" + wanted };
  const iocPath = findIocPath(dir);
  if (iocPath === "") return { ok: false, error: "工程目录里没有 .ioc：" + dir };
  const target = snapshotPath(dir, env);
  if (!existsSync(target)) return { ok: false, error: "还没有基线：先点「记下当前配置」" };
  let baselineText: string;
  let currentText: string;
  try {
    baselineText = readFileSync(target, "utf8");
    currentText = readFileSync(iocPath, "utf8");
  } catch (error) {
    return { ok: false, error: "读取文件失败：" + (error instanceof Error ? error.message : String(error)) };
  }
  const baseline = parseIocEntries(baselineText).find((entry) => entry.key === wanted);
  if (baseline === undefined) return { ok: false, error: "基线里没有这个键：" + wanted };

  const lines = currentText.split(/\r?\n/u);
  let before = "";
  let hit = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq).trim() !== wanted) continue;
    before = trimmed.slice(eq + 1).trim();
    // 保留行尾的空白与 CRLF 由最终 join 决定；这里只换掉「键=值」本身。
    const indent = line.slice(0, line.indexOf(trimmed));
    lines[index] = indent + wanted + "=" + baseline.value;
    hit = true;
    break;
  }
  if (!hit) {
    // 当前文件里没有这个键（基线新增项之外被删掉的键）：追加到末尾。
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    lines.push(wanted + "=" + baseline.value);
  }
  const nextText = lines.join("\n");
  const backupPath = join(iocBackupDir(dir), "ioc-" + new Date().toISOString().replace(/[:.]/gu, "-") + ".ioc");
  try {
    mkdirSync(iocBackupDir(dir), { recursive: true });
    copyFileSync(iocPath, backupPath);
    writeFileSync(iocPath, nextText, "utf8");
  } catch (error) {
    return { ok: false, error: "写回 .ioc 失败：" + (error instanceof Error ? error.message : String(error)) };
  }
  return {
    ok: true,
    report: {
      iocPath: iocPath,
      key: wanted,
      before: before,
      after: baseline.value,
      backupPath: backupPath,
      changed: before !== baseline.value || !hit,
    },
  };
}

/** 读当前 .ioc 与基线的差异；没有基线时 hasSnapshot=false，其余为空。 */
export function readIocDiff(projectDir: string, env: NodeJS.ProcessEnv = process.env): IocDiffResult {
  const dir = projectDir.trim();
  if (dir === "") return { ok: false, error: "projectDir 不能为空" };
  const iocPath = findIocPath(dir);
  if (iocPath === "") return { ok: false, error: "工程目录里没有 .ioc：" + dir };
  let currentText: string;
  try {
    currentText = readFileSync(iocPath, "utf8");
  } catch (error) {
    return { ok: false, error: "读取 .ioc 失败：" + (error instanceof Error ? error.message : String(error)) };
  }
  const target = snapshotPath(dir, env);
  const empty: IocDiffReport = {
    iocPath: iocPath,
    iocName: basename(iocPath),
    snapshotPath: target,
    hasSnapshot: false,
    savedAt: "",
    added: [],
    removed: [],
    changed: [],
    counts: { added: 0, removed: 0, changed: 0, total: 0 },
    notes: [],
  };
  if (!existsSync(target)) {
    return { ok: true, report: { ...empty, notes: ["还没有基线：点「记下当前配置」后才有可比较的版本。"] } };
  }
  let beforeText: string;
  try {
    beforeText = readFileSync(target, "utf8");
  } catch (error) {
    return {
      ok: true,
      report: { ...empty, notes: ["基线文件读不出来：" + (error instanceof Error ? error.message : String(error))] },
    };
  }
  const diff = diffIocEntries(parseIocEntries(beforeText), parseIocEntries(currentText));
  let savedAt = "";
  try {
    savedAt = new Date(statSync(target).mtimeMs).toISOString();
  } catch {
    savedAt = "";
  }
  return {
    ok: true,
    report: {
      iocPath: iocPath,
      iocName: basename(iocPath),
      snapshotPath: target,
      hasSnapshot: true,
      savedAt: savedAt,
      added: diff.added,
      removed: diff.removed,
      changed: diff.changed,
      counts: {
        added: diff.added.length,
        removed: diff.removed.length,
        changed: diff.changed.length,
        total: diff.added.length + diff.removed.length + diff.changed.length,
      },
      notes: [],
    },
  };
}
