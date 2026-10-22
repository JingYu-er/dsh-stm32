/**
 * L2：\`.ioc\` 变更事务 —— plan（只读算 diff）→ 人确认 → apply（备份 + 原子替换）→ 可回滚。
 *
 * 设计要点（规格 §3 I3、§8、§11 A8）：
 * - 插件**永远不静默改 \`.ioc\`**：plan 只算、不写源文件；apply 必须带 planId，且源文件 SHA-256
 *   与 plan 时一致，否则拒绝（防止"plan 之后你自己又用 CubeMX GUI 改过"）。
 * - plan 的候选文件先落在 \`.dsh-stm32/plans/<planId>.ioc\`，apply 前重新核对它的 SHA-256，
 *   保证"确认的那份"就是"写进去的那份"。
 * - apply 前再跑一遍安全校验（Serial Wire 在、KeepUserCode 开），是第二道闸：plan 通过之后
 *   候选文件也可能被人手改过。
 * - 覆盖前一律备份到 \`.dsh-stm32/backups/<时间戳>/<原文件名>\`，回滚就是把备份写回去。
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

import { findIocFile, STATE_DIR } from "./generate.js";
import { parseIocEntries, summarizeIoc } from "./ioc.js";
import type { IocSummary } from "./ioc.js";
import { isKnownPin } from "../data/chips.js";

export interface PinAddRequest {
  /** 引脚名，例如 PA0、PC13。 */
  pin: string;
  /** input=GPIO_Input，output=GPIO_Output；缺省 output。 */
  signal?: "input" | "output";
  /** GPIO 标签（生成 C 变量前缀），必须是合法 C 标识符。 */
  label?: string;
  pull?: "none" | "up" | "down";
  speed?: "low" | "medium" | "high";
}

export interface IocPlanRequest {
  projectDir: string;
  iocPath?: string;
  /** 直接设置/新增的键值对。 */
  entries?: { key: string; value: string }[];
  /** 要删除的键。 */
  unset?: string[];
  /** 新增 GPIO 引脚。 */
  pins?: PinAddRequest[];
  /** 确保 Serial Wire 调试口（PA13/PA14），并清掉 No_Debug 遗留。 */
  serialWire?: boolean;
}

export interface IocPlanChange {
  key: string;
  /** 变更前（null = 新增）。 */
  before: string | null;
  /** 变更后（null = 删除）。 */
  after: string | null;
}

export interface IocPlan {
  planId: string;
  createdAt: string;
  projectDir: string;
  iocPath: string;
  sourceSha256: string;
  candidateSha256: string;
  changes: IocPlanChange[];
  warnings: string[];
  notes: string[];
  candidatePath: string;
  planPath: string;
}

export interface IocPlanReport {
  ok: boolean;
  projectDir: string;
  iocPath: string;
  planId: string;
  sourceSha256: string;
  candidateSha256: string;
  changes: IocPlanChange[];
  warnings: string[];
  notes: string[];
  errors: string[];
  message: string;
  summaryAfter?: IocSummary;
}

export interface IocApplyReport {
  ok: boolean;
  projectDir: string;
  iocPath: string;
  planId: string;
  appliedChanges: number;
  shaBefore: string;
  shaAfter: string;
  backupPath: string;
  warnings: string[];
  notes: string[];
  message: string;
}

export interface IocRollbackReport {
  ok: boolean;
  projectDir: string;
  iocPath: string;
  restoredFrom: string;
  shaBefore: string;
  shaAfter: string;
  backupPath: string;
  message: string;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 写回时的转义：CubeMX 在值里把 ":" 和 "\\" 写成 "\\" 前缀。 */
export function encodeIocValue(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/:/gu, "\\:");
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/u);
}

function dominantEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

interface LineTable {
  /** 原始行（不含换行符）。 */
  lines: string[];
  /** key → 行下标（可能重复）。 */
  index: Map<string, number[]>;
}

function buildLineTable(text: string): LineTable {
  const lines = splitLines(text);
  const index = new Map<string, number[]>();
  lines.forEach((line, position) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) return;
    const key = trimmed.slice(0, eq).trim();
    const list = index.get(key) ?? [];
    list.push(position);
    index.set(key, list);
  });
  return { lines, index };
}

/** 把变更应用到 .ioc 文本上：已有键原地改、重复键只留第一条、新增键追加到末尾。 */
export function renderIocText(text: string, changes: IocPlanChange[]): string {
  const table = buildLineTable(text);
  const removed = new Set<number>();
  const appended: string[] = [];
  for (const change of changes) {
    const positions = table.index.get(change.key) ?? [];
    if (change.after === null) {
      for (const position of positions) removed.add(position);
      continue;
    }
    const line = change.key + "=" + encodeIocValue(change.after);
    if (positions.length === 0) {
      appended.push(line);
      continue;
    }
    const first = positions[0] as number;
    table.lines[first] = line;
    for (const position of positions.slice(1)) removed.add(position);
  }
  const eol = dominantEol(text);
  const out: string[] = [];
  table.lines.forEach((line, position) => {
    if (!removed.has(position)) out.push(line);
  });
  // 去掉末尾的空行，再把新增键接上，最后统一补一个换行。
  while (out.length > 0 && (out[out.length - 1] as string).trim() === "") out.pop();
  out.push(...appended);
  return out.join(eol) + eol;
}

export function compareEntries(before: Map<string, string>, after: Map<string, string>): IocPlanChange[] {
  const changes: IocPlanChange[] = [];
  const keys = new Set<string>([...before.keys(), ...after.keys()]);
  for (const key of keys) {
    const old = before.get(key) ?? null;
    const next = after.get(key) ?? null;
    if (old === next) continue;
    changes.push({ key, before: old, after: next });
  }
  return changes.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
}

const LABEL_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const PULL_VALUES: Record<NonNullable<PinAddRequest["pull"]>, string> = {
  none: "GPIO_NOPULL",
  up: "GPIO_PULLUP",
  down: "GPIO_PULLDOWN",
};
const SPEED_VALUES: Record<NonNullable<PinAddRequest["speed"]>, string> = {
  low: "GPIO_SPEED_FREQ_LOW",
  medium: "GPIO_SPEED_FREQ_MEDIUM",
  high: "GPIO_SPEED_FREQ_HIGH",
};

interface PinTable {
  /** 按 Mcu.PinN 顺序的引脚名。 */
  order: string[];
  entries: Map<string, string>;
  errors: string[];
  warnings: string[];
}

function readPinTable(entries: Map<string, string>, errors: string[], warnings: string[]): PinTable {
  const count = Number.parseInt(entries.get("Mcu.PinsNb") ?? "0", 10);
  if (!Number.isFinite(count) || count < 0) {
    errors.push("Mcu.PinsNb 不是合法数字（" + (entries.get("Mcu.PinsNb") ?? "<缺失>") + "）");
    return { order: [], entries, errors, warnings };
  }
  const order: string[] = [];
  for (let position = 0; position < count; position += 1) {
    const pin = entries.get("Mcu.Pin" + String(position));
    if (pin === undefined) {
      errors.push("Mcu.Pin" + String(position) + " 缺失（Mcu.PinsNb=" + String(count) + " 但列表不连续）");
      continue;
    }
    order.push(pin);
  }
  return { order, entries, errors, warnings };
}

/** 把引脚列表整体重编号写回 entries（新增/删除都可能让下标变化，重写最稳）。 */
function writePinOrder(entries: Map<string, string>, order: string[]): void {
  const previous = Number.parseInt(entries.get("Mcu.PinsNb") ?? "0", 10);
  const oldCount = Number.isFinite(previous) ? previous : 0;
  order.forEach((pin, position) => entries.set("Mcu.Pin" + String(position), pin));
  for (let position = order.length; position < oldCount; position += 1) entries.delete("Mcu.Pin" + String(position));
  entries.set("Mcu.PinsNb", String(order.length));
}

function addPin(
  table: PinTable,
  request: PinAddRequest,
  chip: { cpn: string },
): void {
  const pin = request.pin.trim();
  if (pin === "") {
    table.errors.push("pins 里有空引脚名");
    return;
  }
  if (table.order.includes(pin)) {
    table.errors.push("引脚 " + pin + " 已经在 .ioc 里配置过了（要改请用 entries 直接设置对应键）");
    return;
  }
  if (!isKnownPin(chip.cpn, pin)) {
    table.errors.push("引脚 " + pin + " 不在 " + (chip.cpn === "" ? "当前 MCU" : chip.cpn) + " 的引脚表里（见 src/data/chips.ts）");
    return;
  }
  const label = (request.label ?? "").trim();
  if (label !== "" && !LABEL_PATTERN.test(label)) {
    table.errors.push("标签 " + JSON.stringify(label) + " 不是合法 C 标识符（会生成 " + label + "_Pin 变量）");
    return;
  }
  if (label !== "") {
    for (const [key, value] of table.entries) {
      if (!key.endsWith(".GPIO_Label")) continue;
      if (value === label) {
        table.errors.push("标签 " + label + " 已被 " + key.slice(0, key.length - ".GPIO_Label".length) + " 占用，生成的 C 变量会重名");
        return;
      }
    }
  }
  const signal = request.signal === "input" ? "GPIO_Input" : "GPIO_Output";
  const pull = request.pull === undefined ? "none" : request.pull;
  const speed = request.speed === undefined ? "low" : request.speed;
  const parameters = ["GPIO_Label", "GPIO_PuPd", "GPIO_Speed"];
  table.entries.set(pin + ".GPIOParameters", parameters.join(","));
  if (label !== "") table.entries.set(pin + ".GPIO_Label", label);
  table.entries.set(pin + ".Locked", "true");
  table.entries.set(pin + ".Signal", signal);
  table.entries.set(pin + ".GPIO_PuPd", PULL_VALUES[pull]);
  table.entries.set(pin + ".GPIO_Speed", SPEED_VALUES[speed]);
  if (signal === "GPIO_Input" && pull === "none") {
    table.warnings.push("引脚 " + pin + " 配成输入但没有上/下拉：悬空时读数会乱（常见做法是 pull=up）");
  }
  table.order.push(pin);
}

/** 确保 Serial Wire 调试口：PA13/PA14 用调试信号，同时清掉 VP_SYS_VS_ND（No_Debug）残留。 */
function ensureSerialWire(table: PinTable): void {
  const noDebugPins = table.order.filter((pin) => pin === "VP_SYS_VS_ND");
  for (const pin of noDebugPins) {
    table.order = table.order.filter((item) => item !== pin);
    for (const key of [...table.entries.keys()]) {
      if (key === pin || key.startsWith(pin + ".")) table.entries.delete(key);
    }
    table.warnings.push("已删除 " + pin + "（No_Debug 会让 CubeMX 生成 __HAL_AFIO_REMAP_SWJ_DISABLE()）");
  }
  const debugPins: { pin: string; signal: string }[] = [
    { pin: "PA13", signal: "SYS_JTMS-SWDIO" },
    { pin: "PA14", signal: "SYS_JTCK-SWCLK" },
  ];
  for (const item of debugPins) {
    if (!table.order.includes(item.pin)) {
      table.order.push(item.pin);
      table.entries.set(item.pin + ".Locked", "true");
    }
    table.entries.set(item.pin + ".Mode", "Serial_Wire");
    table.entries.set(item.pin + ".Signal", item.signal);
  }
}

function planPaths(projectDir: string, planId: string): { planPath: string; candidatePath: string } {
  const dir = join(projectDir, STATE_DIR, "plans");
  return { planPath: join(dir, planId + ".json"), candidatePath: join(dir, planId + ".ioc") };
}

function prunePlans(planDir: string, keep = 20): void {
  if (!existsSync(planDir)) return;
  const files = readdirSync(planDir).filter((name) => name.endsWith(".json"));
  if (files.length <= keep) return;
  const withTime = files.map((name) => ({ name, mtime: statSync(join(planDir, name)).mtimeMs }));
  withTime.sort((left, right) => right.mtime - left.mtime);
  for (const item of withTime.slice(keep)) {
    const planId = item.name.slice(0, -".json".length);
    rmSync(join(planDir, item.name), { force: true });
    rmSync(join(planDir, planId + ".ioc"), { force: true });
  }
}

/** 生成变更计划：只读源文件，把候选文本写到 .dsh-stm32/plans/，不碰 .ioc。 */
export function planIocChanges(request: IocPlanRequest): IocPlanReport {
  const projectDir = resolve(request.projectDir);
  const iocPath = request.iocPath !== undefined && request.iocPath !== ""
    ? (isAbsolute(request.iocPath) ? request.iocPath : resolve(projectDir, request.iocPath))
    : findIocFile(projectDir);
  const empty: IocPlanReport = {
    ok: false, projectDir, iocPath: iocPath ?? "", planId: "", sourceSha256: "", candidateSha256: "",
    changes: [], warnings: [], notes: [], errors: [], message: "",
  };
  if (iocPath === null || !existsSync(iocPath)) {
    return { ...empty, errors: ["找不到 .ioc（工程根目录下必须有且只有一个 *.ioc，或用 iocPath 指定）"], message: "没生成计划：找不到 .ioc" };
  }

  const source = readFileSync(iocPath, "utf8");
  const sourceSha256 = sha256Hex(source);
  const errors: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];

  const before = parseIocEntries(source);
  // 深拷贝成可写 Map（parseIocEntries 返回的就是新 Map，直接改即可）。
  const after = new Map(before);
  const chipCpn = before.get("Mcu.CPN") ?? "";

  const pinTable = readPinTable(after, errors, warnings);
  for (const pin of request.pins ?? []) addPin(pinTable, pin, { cpn: chipCpn });
  // 引脚表变化过才重写 Mcu.PinN（否则一个键都不碰）。
  const pinsTouched = (request.pins ?? []).length > 0 || request.serialWire === true;
  if (request.serialWire === true) ensureSerialWire(pinTable);
  if (pinsTouched) {
    const remaining = pinTable.order.filter((pin) => after.get(pin + ".Signal") !== undefined || pin.startsWith("VP_"));
    writePinOrder(after, remaining);
  }

  for (const item of request.entries ?? []) {
    const key = item.key.trim();
    if (key === "" || key.includes("=")) {
      errors.push("键名非法：" + JSON.stringify(item.key));
      continue;
    }
    if (/[\r\n]/u.test(item.value)) {
      errors.push("键 " + key + " 的值里有换行，.ioc 不能表达");
      continue;
    }
    after.set(key, item.value);
  }
  for (const key of request.unset ?? []) {
    const trimmed = key.trim();
    if (!after.has(trimmed)) {
      warnings.push("要删除的键 " + trimmed + " 本来就不存在，跳过");
      continue;
    }
    after.delete(trimmed);
  }

  // 安全闸：这两条是踩过坑的硬约束，不满足就不给 plan。
  const candidateText = renderIocText(source, compareEntries(before, after));
  const summary = summarizeIoc(candidateText, iocPath);
  if (!summary.debug.serialWire) {
    errors.push(
      "改完之后没有 Serial Wire 调试口（PA13/PA14）：CubeMX 会生成 __HAL_AFIO_REMAP_SWJ_DISABLE()，烧录后 SWD 连不上。加 serialWire:true 让插件补上。",
    );
  }
  if (!summary.settings.keepUserCode) {
    errors.push("改完之后 ProjectManager.KeepUserCode=false：重新生成会丢掉 USER CODE 区，拒绝。");
  }

  if (errors.length > 0) {
    return { ...empty, iocPath, sourceSha256, errors, warnings, notes, message: "没生成计划：" + (errors[0] as string) };
  }

  const changes = compareEntries(before, after);
  if (changes.length === 0) {
    return { ...empty, iocPath, sourceSha256, warnings, notes, message: "没有变化：这些键本来就是这个值" };
  }

  const candidateSha256 = sha256Hex(candidateText);
  const planId = sha256Hex(sourceSha256 + "\n" + candidateSha256).slice(0, 16);
  const paths = planPaths(projectDir, planId);
  mkdirSync(join(projectDir, STATE_DIR, "plans"), { recursive: true });
  writeFileSync(paths.candidatePath, candidateText, "utf8");

  const plan: IocPlan = {
    planId, createdAt: new Date().toISOString(), projectDir, iocPath,
    sourceSha256, candidateSha256, changes, warnings, notes,
    candidatePath: paths.candidatePath, planPath: paths.planPath,
  };
  writeFileSync(paths.planPath, JSON.stringify(plan, null, 1), "utf8");
  prunePlans(join(projectDir, STATE_DIR, "plans"));

  const added = changes.filter((change) => change.before === null).length;
  const removedCount = changes.filter((change) => change.after === null).length;
  notes.push("候选文件：" + paths.candidatePath);
  notes.push("确认后调用 stm32_ioc_apply({ planId: \"" + planId + "\" })；apply 会核对源文件 SHA-256=" + sourceSha256.slice(0, 16) + "…");
  if (pinTable.order.length !== summary.pins.length) {
    notes.push("提示：写成 Mcu.PinsNb=" + String(summary.pins.length) + "，其中 " + String(pinTable.order.length) + " 个引脚有信号定义");
  }

  return {
    ok: true, projectDir, iocPath, planId, sourceSha256, candidateSha256,
    changes, warnings, notes,
    errors: [],
    message: "已生成计划 " + planId + "：" + String(changes.length) + " 个键变化（新增 " + String(added) + "、删除 " + String(removedCount) + "、修改 " + String(changes.length - added - removedCount) + "）",
    summaryAfter: summary,
  };
}

export function loadPlan(projectDir: string, planId: string): IocPlan | null {
  const paths = planPaths(resolve(projectDir), planId);
  if (!existsSync(paths.planPath)) return null;
  try {
    return JSON.parse(readFileSync(paths.planPath, "utf8")) as IocPlan;
  } catch {
    return null;
  }
}

function nowStamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
  );
}

function backupIoc(projectDir: string, iocPath: string): string {
  const dir = join(projectDir, STATE_DIR, "backups", nowStamp() + "-ioc");
  mkdirSync(dir, { recursive: true });
  const target = join(dir, basename(iocPath));
  copyFileSync(iocPath, target);
  return target;
}

/** 原子替换：先写同目录临时文件，再 rename 覆盖，避免写一半断电留下半截 .ioc。 */
function writeFileAtomic(target: string, text: string): void {
  const tmp = target + ".dsh-tmp-" + String(process.pid) + "-" + String(Date.now());
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, target);
}

export function applyIocPlan(request: { projectDir: string; planId: string }): IocApplyReport {
  const projectDir = resolve(request.projectDir);
  const empty: IocApplyReport = {
    ok: false, projectDir, iocPath: "", planId: request.planId, appliedChanges: 0,
    shaBefore: "", shaAfter: "", backupPath: "", warnings: [], notes: [], message: "",
  };
  const plan = loadPlan(projectDir, request.planId);
  if (plan === null) {
    return { ...empty, message: "没写入：找不到计划 " + request.planId + "（可能已被清理，请重新 plan）" };
  }
  const iocPath = resolve(plan.iocPath);
  if (!existsSync(iocPath)) return { ...empty, iocPath, message: "没写入：.ioc 不存在了：" + iocPath };

  const current = readFileSync(iocPath, "utf8");
  const currentSha = sha256Hex(current);
  if (currentSha !== plan.sourceSha256) {
    return {
      ...empty, iocPath, shaBefore: currentSha,
      message:
        "没写入：.ioc 在 plan 之后被改过（当前 SHA-256=" + currentSha.slice(0, 16) + "，plan 时=" + plan.sourceSha256.slice(0, 16) +
        "）。这是故意的保护——请重新 plan 确认新内容。",
    };
  }
  if (!existsSync(plan.candidatePath)) {
    return { ...empty, iocPath, shaBefore: currentSha, message: "没写入：候选文件不在了（" + plan.candidatePath + "），请重新 plan" };
  }
  const candidate = readFileSync(plan.candidatePath, "utf8");
  const candidateSha = sha256Hex(candidate);
  if (candidateSha !== plan.candidateSha256) {
    return { ...empty, iocPath, shaBefore: currentSha, message: "没写入：候选文件的 SHA-256 与 plan 时不一致（可能被手改），请重新 plan" };
  }

  // 第二道闸：候选内容也必须满足安全约束。
  const summary = summarizeIoc(candidate, iocPath);
  if (!summary.debug.serialWire || !summary.settings.keepUserCode) {
    return { ...empty, iocPath, shaBefore: currentSha, message: "没写入：候选 .ioc 不满足安全约束（Serial Wire 或 KeepUserCode），请重新 plan" };
  }

  const backupPath = backupIoc(projectDir, iocPath);
  writeFileAtomic(iocPath, candidate);
  const writtenSha = sha256Hex(readFileSync(iocPath, "utf8"));
  if (writtenSha !== plan.candidateSha256) {
    // 极端情况：写盘后哈希不一致 → 立刻回滚，别留半成品。
    writeFileAtomic(iocPath, current);
    return { ...empty, iocPath, shaBefore: currentSha, shaAfter: writtenSha, backupPath, message: "写入后校验失败，已自动回滚" };
  }

  const warnings: string[] = [...plan.warnings];
  const notes: string[] = [
    "备份：" + backupPath,
    "回滚：stm32_ioc_apply({ rollbackFrom: \"" + backupPath + "\" })",
  ];
  if (summary.warnings.length > 0) notes.push("改完后的 .ioc 仍有 " + String(summary.warnings.length) + " 条告警，可用 stm32_ioc_inspect 查看");
  notes.push("下一步：stm32_generate（CubeMX 会按新 .ioc 重写非 USER CODE 区，USER CODE 保活）");

  return {
    ok: true, projectDir, iocPath, planId: plan.planId, appliedChanges: plan.changes.length,
    shaBefore: currentSha, shaAfter: writtenSha, backupPath, warnings, notes,
    message: "已写入 " + String(plan.changes.length) + " 个键变化（备份在 " + backupPath + "）",
  };
}

/** 回滚：把某次备份的 .ioc 写回去（写之前先备份当前文件，回滚也能再回滚）。 */
export function rollbackIoc(request: { projectDir: string; backupFrom: string }): IocRollbackReport {
  const projectDir = resolve(request.projectDir);
  const empty: IocRollbackReport = {
    ok: false, projectDir, iocPath: "", restoredFrom: request.backupFrom,
    shaBefore: "", shaAfter: "", backupPath: "", message: "",
  };
  const iocPath = findIocFile(projectDir);
  if (iocPath === null) return { ...empty, message: "没回滚：工程里找不到唯一的 .ioc" };

  const backupRoot = join(projectDir, STATE_DIR, "backups");
  const resolved = isAbsolute(request.backupFrom) ? resolve(request.backupFrom) : resolve(projectDir, request.backupFrom);
  const relative = resolved.startsWith(backupRoot + sep) ? resolved.slice(backupRoot.length + 1) : null;
  if (relative === null || !resolved.toLowerCase().endsWith(".ioc") || relative.includes("..")) {
    return { ...empty, iocPath, message: "没回滚：只接受 .dsh-stm32/backups/ 下的 .ioc 备份路径（收到 " + resolved + "）" };
  }
  if (!existsSync(resolved)) return { ...empty, iocPath, message: "没回滚：备份文件不存在：" + resolved };

  const restored = readFileSync(resolved, "utf8");
  const current = readFileSync(iocPath, "utf8");
  const currentSha = sha256Hex(current);
  const backupPath = backupIoc(projectDir, iocPath);
  writeFileAtomic(iocPath, restored);
  const afterSha = sha256Hex(readFileSync(iocPath, "utf8"));
  return {
    ok: true, projectDir, iocPath, restoredFrom: resolved,
    shaBefore: currentSha, shaAfter: afterSha, backupPath,
    message: "已把 " + basename(resolved) + " 写回 .ioc（当前内容先备份到 " + backupPath + "）",
  };
}
