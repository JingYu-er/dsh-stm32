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
import { decodeIocKey, iocLogicalLines, parseIocEntries, summarizeIoc } from "./ioc.js";
import { checkIocRules } from "./ioc-rules.js";
import { findPeripheralPreset, peripheralPresetNames, pinDbName } from "../data/ioc-presets.js";
import { locateCubemxDb, readMcuFacts, resolveDbPinName } from "./cubemx-db.js";
import type { CubemxDb, CubemxMcuFacts } from "./cubemx-db.js";
import { resolveSearchConfig } from "../data/search-roots.js";
import type { IocSummary } from "./ioc.js";
import { emptyClockPlan, formatHz, planClock } from "./clock-plan.js";
import type { ClockPlan, ClockPlanRequest } from "./clock-plan.js";
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

/** 启用一个外设：按预设一次写全"引脚 Mode/Signal + Mcu.IPn + IPParameters"。 */
export interface PeripheralEnableRequest {
  /** 预设名（= 实例名）：USART1 / TIM2 / ADC1…。 */
  name: string;
  /** 覆盖预设的默认引脚，key 是角色名（tx/rx/ch1/in1…），value 是逻辑引脚名（PA2）。 */
  pins?: Record<string, string>;
  /** 覆盖预设的默认参数，key 是 <ip>.IPParameters 里的参数名（BaudRate/Prescaler…）。 */
  parameters?: Record<string, string>;
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
  /**
   * 启用外设（预设）。为什么需要这个东西：CubeMX 不认"只写 USART1.VirtualMode"，
   * 它按引脚的 Mode+Signal 反推复用模式；缺 <pin>.Mode 就静默丢弃整个外设。
   */
  peripherals?: PeripheralEnableRequest[];
  /** 确保 Serial Wire 调试口（PA13/PA14），并清掉 No_Debug 遗留。 */
  serialWire?: boolean;
  /**
   * 改时钟：{ targetHz } 就近搜，或 { pllSource, pllMul, apb1Div, adcDiv } 定点。
   * 和 entries 一样只是"算进候选文件"，真正的写入仍然走 applyIocPlan。
   */
  clock?: ClockPlanRequest;
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
  /** 这次用的 CubeMX db 版本（例如 DB.6.0.150）；没有 db 时为空串。报 bug 时一眼看出 db 差异。 */
  dbVersion: string;
  /** db 根目录（例如 D:/app/STM32CubeMX/db）；没有 db 时为空串。 */
  dbRoot: string;
  /** 时钟报告：没请求 clock 时是 .ioc 现状（只读），请求了就是规划结果。永远有值。 */
  clockPlan: ClockPlan;
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

/**
 * 写回时的转义。值里要转义 "\\"、":"（NVIC 的 true\:0…）和 "#"
 * （ADC1.IPParameters=Rank-0\#ChannelRegularConversion 是 CubeMX 自己的写法）。
 */
export function encodeIocValue(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/:/gu, "\\:").replace(/#/gu, "\\#");
}

/**
 * 键名里的转义。键里出现空格/括号时**必须**转义：.ioc 走 java properties 语义，
 * 未转义的空格会把键截断，于是 "TIM2.Channel-PWM Generation1 CH1" 变成
 * "TIM2.Channel-PWM" —— CubeMX 读不到，通道配置静默失效。
 */
export function encodeIocKey(key: string): string {
  return key.replace(/\\/gu, "\\\\").replace(/ /gu, "\\ ").replace(/#/gu, "\\#").replace(/:/gu, "\\:");
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
  /** 本次原地改写的键数：一个都没改时直接返回原文，保证 round-trip 逐字节相同。 */
  changedKeys: number;
}

/**
 * .ioc 的键排序：CubeMX 自己写盘时是按 key 的字典序（ADC1.* 在最前，board= 在最后），
 * 但数字要按数值比 —— 字典序会把 Mcu.Pin10 排到 Mcu.Pin2 前面，diff 和人眼都别扭。
 */
export function compareIocKeys(left: string, right: string): number {
  const a = left.split(/(\d+)/u);
  const b = right.split(/(\d+)/u);
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const x = a[index] as string;
    const y = b[index] as string;
    if (x === y) continue;
    const nx = /^\d+$/u.test(x) ? Number(x) : null;
    const ny = /^\d+$/u.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) return nx - ny;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

/** 一行对应的（解码后的）键；注释行、空行、没有 "=" 的垃圾行返回空串。 */
function lineKey(line: string): string {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return "";
  const eq = trimmed.indexOf("=");
  if (eq <= 0) return "";
  return decodeIocKey(trimmed.slice(0, eq).trim());
}

/** .ioc 文本层面的体检结果（都是「CubeMX 会因此丢配置或看错」的真问题，不是风格洁癖）。 */
export interface IocTextDiagnostics {
  /** 同一个键出现多次（CubeMX 只有最后一个生效）→ 键 → 次数。 */
  duplicates: Map<string, number>;
  /** 既不是注释、也不含 "=" 的行号（1 起；Java properties 的续行不算坏行）。 */
  malformedLines: number[];
  /** 值跨了多行的键（续行）——改它会破坏续行结构，计划阶段要拒绝。 */
  multiLineKeys: Set<string>;
  /** 文件里既有 CRLF 又有 LF。 */
  mixedEol: boolean;
  /** 文件末尾有没有换行（CubeMX 自己写的文件有，手工改坏的常常没有）。 */
  finalNewline: boolean;
}

export function inspectIocText(text: string): IocTextDiagnostics {
  const counts = new Map<string, number>();
  const malformedLines: number[] = [];
  const multiLineKeys = new Set<string>();
  for (const item of iocLogicalLines(text)) {
    const trimmed = item.line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      malformedLines.push(item.startIndex + 1);
      continue;
    }
    const key = decodeIocKey(trimmed.slice(0, eq).trim());
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (item.lineCount > 1) multiLineKeys.add(key);
  }
  const duplicates = new Map<string, number>();
  for (const [key, count] of counts) if (count > 1) duplicates.set(key, count);
  return {
    duplicates,
    malformedLines,
    multiLineKeys,
    mixedEol: text.includes("\r\n") && text.replace(/\r\n/gu, "").includes("\n"),
    finalNewline: /(\r?\n)$/u.test(text),
  };
}

/**
 * 读 .ioc：只接受 UTF-8（与 CubeMX 一致），别的编码直接报错。
 *
 * 为什么不做「猜编码」：CubeMX 写的是 UTF-8；文件被中文编辑器另存成 GBK 时，
 * 按 UTF-8 解码会得到一堆替换字符，写回去就把整份工程改坏了。
 * 这里用 fatal 解码器，宁可拒绝也不静默乱码。
 * BOM 用 ignoreBOM 保留在字符串里，写回时原样往返。
 */
export function readIocText(path: string): string {
  const raw = readFileSync(path);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  try {
    return decoder.decode(raw);
  } catch {
    throw new Error(
      "不是合法的 UTF-8：" + path +
        "（多半是中文编辑器另存成了 GBK/ANSI）。请用 VS Code 以 UTF-8 另存后再改；" +
        "插件不会替你猜编码，以免把整份 .ioc 写坏",
    );
  }
}

function buildLineTable(text: string): LineTable {
  const lines = splitLines(text);
  const index = new Map<string, number[]>();
  lines.forEach((line, position) => {
    const key = lineKey(line);
    if (key === "") return;
    const list = index.get(key) ?? [];
    list.push(position);
    index.set(key, list);
  });
  return { lines, index, changedKeys: 0 };
}

/**
 * 把变更应用到 .ioc 文本上：已有键原地改、重复键只留第一条、新增键按 key 排序插入。
 *
 * 为什么是"插入"而不是"追加"：CubeMX 自己写盘时整个文件按 key 排序
 * （CAD.* → File.Version → GPIO.* → KeepUserPlacement → Mcu.* → MxCube.Version →
 * MxDb.Version → NVIC.* → 引脚键 → PinOutPanel.* → ProjectManager.* → RCC.* → SH.* →
 * VP_* → board）。以前新键一律追加到末尾，结果落在 Mcu.IPNb / Mcu.PinsNb 之后，
 * 谁看 diff 都对不上 CubeMX 的格式，也让人误以为键没写进去。
 */
export function renderIocText(text: string, changes: IocPlanChange[]): string {
  const table = buildLineTable(text);
  const removed = new Set<number>();
  const added: IocPlanChange[] = [];
  for (const change of changes) {
    const positions = table.index.get(change.key) ?? [];
    if (change.after === null) {
      for (const position of positions) removed.add(position);
      continue;
    }
    const line = encodeIocKey(change.key) + "=" + encodeIocValue(change.after);
    if (positions.length === 0) {
      added.push(change);
      continue;
    }
    const first = positions[0] as number;
    table.lines[first] = line;
    table.changedKeys += 1;
    for (const position of positions.slice(1)) removed.add(position);
  }
  if (added.length === 0 && removed.size === 0 && table.changedKeys === 0) return text;
  const eol = dominantEol(text);
  const out: Array<{ key: string; line: string }> = [];
  table.lines.forEach((line, position) => {
    if (!removed.has(position)) out.push({ key: lineKey(line), line });
  });
  // 新增键按 key 排序插到对应位置；末尾的空行是原文件的（可能是"文件末尾有换行"的表现），
  // 不能吃掉，新键要插在它们**之前**。
  let tail = out.length;
  while (tail > 0 && (out[tail - 1] as { line: string }).line.trim() === "") tail -= 1;
  added.sort((left, right) => compareIocKeys(left.key, right.key));
  for (const change of added) {
    const item = { key: change.key, line: encodeIocKey(change.key) + "=" + encodeIocValue(change.after as string) };
    let at = -1;
    for (let index = 0; index < tail; index += 1) {
      const key = (out[index] as { key: string }).key;
      if (key !== "" && compareIocKeys(key, change.key) > 0) { at = index; break; }
    }
    if (at < 0) at = tail;
    out.splice(at, 0, item);
    tail += 1;
  }
  // 按行 split 后，文件末尾有换行会多出一个空串，join 回去正好还原原文，所以不再补 eol。
  return out.map((item) => item.line).join(eol);
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
  return changes.sort((left, right) => compareIocKeys(left.key, right.key));
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

/** 两串引脚名是否完全一致（顺序也要一致）：没变就别重写 Mcu.PinN，保持原字节。 */
function samePinOrder(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** 把引脚列表整体重编号写回 entries（新增/删除都可能让下标变化，重写最稳）。 */
function writePinOrder(entries: Map<string, string>, order: string[]): void {
  const previous = Number.parseInt(entries.get("Mcu.PinsNb") ?? "0", 10);
  const oldCount = Number.isFinite(previous) ? previous : 0;
  order.forEach((pin, position) => entries.set("Mcu.Pin" + String(position), pin));
  for (let position = order.length; position < oldCount; position += 1) entries.delete("Mcu.Pin" + String(position));
  entries.set("Mcu.PinsNb", String(order.length));
}

function addPin(table: PinTable, request: PinAddRequest): void {
  const pin = request.pin.trim();
  if (pin === "") {
    table.errors.push("pins 里有空引脚名");
    return;
  }
  if (table.order.includes(pin)) {
    table.errors.push("引脚 " + pin + " 已经在 .ioc 里配置过了（要改请用 entries 直接设置对应键）");
    return;
  }
  if (!isKnownPin(pin)) {
    table.errors.push(
      "引脚名 " + pin + " 不是合法的 STM32 GPIO 引脚（形如 PA0..PG15，或 VP_ 开头的虚拟引脚）；" +
        "插件不再内置引脚表，这个封装到底有没有这根脚请用 stm32_doctor 对着本机 CubeMX db 校验",
    );
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

/**
 * 写共享信号块：`SH.<key>.<n>=<IP 信号>,<IP 模式>` + `SH.<key>.ConfNb=<条数>`。
 *
 * 2026-10-31 实测（C8T6 + CubeMX 6.15.0）：定时器与 ADC 的引脚在 .ioc 里是共享信号
 * （`PA0-WKUP.Signal=S_TIM2_CH1_ETR`、`PA1.Signal=ADCx_IN1`），CubeMX 靠
 * `SH.S_TIM2_CH1_ETR.0=TIM2_CH1,PWM Generation1 CH1` 才能把「这根脚 → TIM2 CH1 PWM」
 * 这件事还原出来。只写引脚 Signal + <ip>.IPParameters 时，TIM2/TIM3/TIM4/ADC1 全被
 * 静默丢弃（生成结果里没有 MX_xxx_Init，日志里也没有任何报错）。
 */
function enableSharedSignal(
  table: PinTable,
  shared: { key: string; ipSignal: string; ipMode: string },
): void {
  const prefix = "SH." + shared.key + ".";
  const value = shared.ipSignal + "," + shared.ipMode;
  const declared = Number.parseInt(table.entries.get(prefix + "ConfNb") ?? "", 10);
  const count = Number.isFinite(declared) ? declared : 0;
  for (let index = 0; index < count; index += 1) {
    if ((table.entries.get(prefix + String(index)) ?? "").trim() === value) return;
  }
  table.entries.set(prefix + String(count), value);
  table.entries.set(prefix + "ConfNb", String(count + 1));
}

/**
 * 启用一个外设预设：占 Mcu.IPn 槽位、写引脚 Mode/Signal/Locked、合并 IPParameters。
 *
 * 三条实测约束都写在这里：
 * - 引脚名必须用 CubeMX db 名（PA0 → PA0-WKUP），否则认不出这根脚；
 * - 多模式外设的引脚必须带 .Mode，缺了 CubeMX 静默丢弃整个外设；
 * - Mcu.IPNb 必须与 Mcu.IPn 条数一致，所以这里统一重算，不再"追加了事"。
 */
/**
 * R16：逻辑引脚名 → 要写进 .ioc 的引脚名。
 *
 * 首选本机 CubeMX 的 db/mcu/<Mcu.Name>.xml：同一根脚在 db 里常常带后缀（PA0 是 PA0-WKUP、
 * PC13 是 PC13-TAMPER-RTC、PC14/PC15 是 PC14-OSC32_IN/PC15-OSC32_OUT、PD0/PD1 是 PD0-OSC_IN/PD1-OSC_OUT），
 * 名字写错 CubeMX 认不到这根脚，整段外设配置会被静默丢弃。
 *
 * db 不可用时（没装 CubeMX / db 里没有这颗 / 该版本里没这根脚）才退回 ioc-presets 的 PIN_DB_ALIASES：
 * 那张表只收 F1 的 6 根脚，CubeMX 换版本就可能漂，所以只是离线兜底，且会在 warnings 里说清楚。
 */
export interface PinNameResolver {
  /** 逻辑名（PA0）→ 写进 .ioc 的名字（PA0-WKUP）。 */
  resolve(logical: string): string;
  /** 这次用的 db（没有则为 null）：R13/R14/R17 需要它查引脚信号与 IP 模式。 */
  db: CubemxDb | null;
  /** 这颗芯片的 db 事实（没有则为 null）。 */
  facts: CubemxMcuFacts | null;
  /** 这次用的哪个来源（进 notes）。 */
  describe(): string;
  /** 用了内置别名表时的提醒（db 可用时为空串）。 */
  warning(): string;
}

export function createPinNameResolver(options: {
  /** .ioc 里的 Mcu.Name，例如 STM32F103C(8-B)Tx。 */
  mcuName: string;
  /** Mcu.Family（只用于兜底别名表）。 */
  family: string;
  cubeMxRoots?: readonly string[];
  env?: Record<string, string | undefined>;
}): PinNameResolver {
  const roots =
    options.cubeMxRoots !== undefined
      ? [...options.cubeMxRoots]
      : resolveSearchConfig(options.env ?? process.env, {}).cubeMxRoots;
  const mcuName = options.mcuName.trim();
  let facts: CubemxMcuFacts | null = null;
  let dbVersion = "";
  if (mcuName !== "") {
    const db = locateCubemxDb(roots);
    if (db !== null) {
      facts = readMcuFacts(db, mcuName);
      if (facts !== null) dbVersion = db.version;
    }
  }
  const hit = facts;
  if (hit !== null) {
    return {
      resolve: (logical) => resolveDbPinName(hit, logical) ?? logical,
      db: locateCubemxDb(roots),
      facts: hit,
      describe: () => "引脚名按本机 CubeMX db 解析（" + hit.name + "，" + dbVersion + "）",
      warning: () => "",
    };
  }
  return {
    resolve: (logical) => pinDbName(options.family, logical),
    db: null,
    facts: null,
    describe: () =>
      "引脚名按内置别名表解析（本机没有可用的 CubeMX db：Mcu.Name=" + (mcuName === "" ? "（空）" : mcuName) + "）",
    warning: () =>
      "没找到 CubeMX 的 db/mcu/" + (mcuName === "" ? "<Mcu.Name>" : mcuName) + ".xml（找过 " +
      (roots.length === 0 ? "（无候选目录）" : roots.join("、")) +
      "），引脚名退回内置别名表：只覆盖 F1 的 6 根带后缀的脚，db 里换过名的话会写错脚",
  };
}

function enablePeripheral(
  table: PinTable,
  request: PeripheralEnableRequest,
  pinNames: PinNameResolver,
  notes: string[],
): void {
  const preset = findPeripheralPreset(request.name);
  if (preset === null) {
    table.errors.push(
      "不认识的外设预设 " + JSON.stringify(request.name) + "；内置：" + peripheralPresetNames().join("、") +
        "（要配别的请直接用 entries 逐键写，键集可参考官方板级 .ioc）",
    );
    return;
  }

  // Mcu.IPn：占了槽位就把 IPNb 按实际条数重算。
  const used = new Set<string>();
  let slots = 0;
  for (const [key, value] of table.entries) {
    if (!/^Mcu\.IP\d+$/u.test(key)) continue;
    slots += 1;
    used.add(value.trim());
  }
  if (!used.has(preset.ip)) {
    table.entries.set("Mcu.IP" + String(slots), preset.ip);
    slots += 1;
  }
  table.entries.set("Mcu.IPNb", String(slots));

  // 引脚：Mode + Signal + Locked。
  const overrodePins = request.pins !== undefined && Object.keys(request.pins).length > 0;
  for (const role of preset.pins) {
    const logical = (request.pins?.[role.role] ?? role.defaultPin).trim().toUpperCase();
    if (logical === "") {
      table.errors.push(preset.name + " 的引脚 " + role.role + " 被指定成空串");
      continue;
    }
    if (!isKnownPin(logical)) {
      table.errors.push("引脚名 " + logical + " 不是合法的 STM32 GPIO 引脚（形如 PA0..PG15）");
      continue;
    }
    const dbName = pinNames.resolve(logical);
    const existingSignal = (table.entries.get(dbName + ".Signal") ?? "").trim();
    if (table.order.includes(dbName) && existingSignal !== "" && existingSignal !== role.signal) {
      table.errors.push(
        preset.name + " 想用 " + dbName + " 做 " + role.signal + "，但这根脚已经配成 " + existingSignal +
          "（同一根脚不能同时做两件事，换引脚请传 pins）",
      );
      continue;
    }
    if (!table.order.includes(dbName)) table.order.push(dbName);
    table.entries.set(dbName + ".Locked", "true");
    table.entries.set(dbName + ".Signal", role.signal);
    if (role.shared === undefined) {
      if (role.mode !== "") table.entries.set(dbName + ".Mode", role.mode);
    } else {
      // 共享信号引脚：CubeMX 自己的 .ioc 里不带 .Mode，功能由 SH 块表达。
      table.entries.delete(dbName + ".Mode");
      enableSharedSignal(table, role.shared);
    }
  }

  // 参数：写 <ip>.<名字>=值，并把名字合并进 <ip>.IPParameters。
  const paramsKey = preset.ip + ".IPParameters";
  const names = (table.entries.get(paramsKey) ?? "").split(",").map((item) => item.trim()).filter((item) => item !== "");
  for (const param of preset.parameters) {
    table.entries.set(preset.ip + "." + param.name, request.parameters?.[param.name] ?? param.value);
    if (!names.includes(param.name)) names.push(param.name);
    if (overrodePins && request.parameters?.[param.name] === undefined && param.name.startsWith("Channel-")) {
      table.warnings.push(
        preset.name + " 换了引脚，但 " + param.name + " 仍是 " + param.value +
          "：通道号必须与引脚一致，请一并用 parameters 改",
      );
    }
  }
  for (const [name, value] of Object.entries(request.parameters ?? {})) {
    if (names.includes(name)) continue;
    names.push(name);
    table.entries.set(preset.ip + "." + name, value);
  }
  table.entries.set(paramsKey, names.join(","));

  for (const extra of preset.extraEntries ?? []) {
    table.entries.set(extra.key, extra.value);
    if (!extra.key.startsWith("RCC.")) continue;
    const name = extra.key.slice("RCC.".length);
    const rccNames = (table.entries.get("RCC.IPParameters") ?? "").split(",").map((item) => item.trim()).filter((item) => item !== "");
    if (!rccNames.includes(name)) {
      rccNames.push(name);
      table.entries.set("RCC.IPParameters", rccNames.join(","));
    }
  }

  notes.push("已启用预设 " + preset.name + "（" + preset.label + "）");
  for (const note of preset.notes ?? []) notes.push(note);
}

/**
 * 自洽校验（都按 CubeMX 的真实推导规则，不是风格洁癖）：
 * - Mcu.IPNb 必须等于 Mcu.IPn 的条数；
 * - 外设进了 Mcu.IPn 就得有引脚 .Signal 指向它；
 * - 多模式外设的引脚还得表达功能：普通外设（USART）用 `.Mode`，共享信号外设（定时器/ADC）
 *   用 `SH.<pin信号>.<n>=<IP 信号>,<IP 模式>` —— 两者都缺时 CubeMX 静默丢弃整个外设，不报错。
 */
function validatePeripheralWiring(entries: Map<string, string>, warnings: string[]): void {
  let slots = 0;
  const devices = new Set<string>();
  for (const [key, value] of entries) {
    if (!/^Mcu\.IP\d+$/u.test(key)) continue;
    slots += 1;
    devices.add(value.trim());
  }
  const declared = Number.parseInt(entries.get("Mcu.IPNb") ?? "", 10);
  if (Number.isFinite(declared) && declared !== slots) {
    warnings.push("Mcu.IPNb=" + String(declared) + " 但实际有 " + String(slots) + " 个 Mcu.IPn 键（CubeMX 打开时会自己重算）");
  }
  const pinsByDevice = new Map<string, string[]>();
  for (const [key, value] of entries) {
    if (!key.endsWith(".Signal")) continue;
    const pin = key.slice(0, key.length - ".Signal".length);
    for (const device of devicesOfSignal(entries, value.trim())) {
      const list = pinsByDevice.get(device) ?? [];
      list.push(pin);
      pinsByDevice.set(device, list);
    }
  }
  for (const device of devices) {
    // 伪外设：没有自己的引脚（DMA/NVIC/RCC/SYS 以及 Cortex 内核项），不按「必须有引脚」校验。
    if (device === "" || device === "NVIC" || device === "RCC" || device === "SYS" || device === "DMA") continue;
    const pins = pinsByDevice.get(device) ?? [];
    if (pins.length === 0) {
      warnings.push(device + " 在 Mcu.IPn 里，但没有引脚的 .Signal 指向它 → CubeMX 会忽略这个外设");
      continue;
    }
    const noMode = pins.filter((pin) => {
      const signal = (entries.get(pin + ".Signal") ?? "").trim();
      if (signal.startsWith("GPIO_")) return false;
      if ((entries.get(pin + ".Mode") ?? "").trim() !== "") return false;
      // 共享信号（定时器/ADC）本来就不带 .Mode，改由 SH.<signal>.<n>=<IP 信号>,<IP 模式> 表达。
      return (entries.get("SH." + signal + ".ConfNb") ?? "") === "";
    });
    if (noMode.length > 0) {
      warnings.push(
        device + " 的引脚 " + noMode.join("、") + " 既没有 .Mode 也没有 SH." + " 共享信号块 → " +
          "CubeMX 实测会静默丢弃整个外设（用 peripherals 预设，或自己补 <pin>.Mode / SH 块）",
      );
    }
  }
}

/**
 * 一根脚的 .Signal 指向哪个外设实例。
 *
 * 名字有三种来源：`USART1_TX`（普通外设）、`S_TIM2_CH1_ETR`（定时器共享信号，前缀 S_）、
 * `ADCx_IN1`（ADC 共享信号，本身不含实例名 —— 实例名在 `SH.ADCx_IN1.0=ADC1_IN1,IN1` 里）。
 */
function devicesOfSignal(entries: Map<string, string>, signal: string): string[] {
  const found = new Set<string>();
  const add = (name: string): void => {
    const match = /^([A-Z][A-Z0-9]*)_/u.exec(name);
    if (match === null) return;
    const device = match[1] ?? "";
    if (device === "" || device.endsWith("x")) return;
    found.add(device);
  };
  add(signal);
  if (signal.startsWith("S_")) add(signal.slice(2));
  const declared = Number.parseInt(entries.get("SH." + signal + ".ConfNb") ?? "", 10);
  const count = Number.isFinite(declared) ? declared : 0;
  for (let index = 0; index < count; index += 1) {
    const value = (entries.get("SH." + signal + "." + String(index)) ?? "").trim();
    const target = value.split(",")[0] ?? "";
    add(target);
  }
  return [...found];
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
    dbVersion: "", dbRoot: "",
    clockPlan: emptyClockPlan("还没读到 .ioc，时钟没算"),
  };
  if (iocPath === null || !existsSync(iocPath)) {
    return { ...empty, errors: ["找不到 .ioc（工程根目录下必须有且只有一个 *.ioc，或用 iocPath 指定）"], message: "没生成计划：找不到 .ioc" };
  }

  let source = "";
  try {
    source = readIocText(iocPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...empty, iocPath, errors: [message], message: "没生成计划：" + message };
  }
  const sourceSha256 = sha256Hex(source);
  const errors: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  const diagnostics = inspectIocText(source);
  if (diagnostics.mixedEol) {
    warnings.push("这份 .ioc 的换行不一致（既有 CRLF 又有 LF）：写回时会统一成多数的那种（CRLF）");
  }
  if (!diagnostics.finalNewline) {
    notes.push("源文件末尾没有换行：写回时保持原样（CubeMX 自己写的文件是有换行的，手工改出来的常常没有）");
  }
  if (diagnostics.malformedLines.length > 0) {
    warnings.push(
      "这些行既不是 # 注释、也没有 \"=\"，CubeMX 会当垃圾行丢掉（行号：" +
        diagnostics.malformedLines.slice(0, 8).join("、") +
        (diagnostics.malformedLines.length > 8 ? "…" : "") + "）",
    );
  }

  const before = parseIocEntries(source);
  // 深拷贝成可写 Map（parseIocEntries 返回的就是新 Map，直接改即可）。
  const after = new Map(before);

  const pinTable = readPinTable(after, errors, warnings);
  // 先记下原始引脚表：只有真的变了才重写 Mcu.PinN，顺序没变就一个字节都不碰。
  const originalOrder = [...pinTable.order];
  for (const pin of request.pins ?? []) addPin(pinTable, pin);
  if (request.serialWire === true) ensureSerialWire(pinTable);
  const family = (after.get("Mcu.Family") ?? "").trim();
  if (family === "" && (request.peripherals ?? []).length > 0) {
    warnings.push("读不到 Mcu.Family，引脚名按原样写入：F1 的 PA0 实际 db 名是 PA0-WKUP，写错会被 CubeMX 丢弃");
  }
  const pinNames = createPinNameResolver({ mcuName: (after.get("Mcu.Name") ?? "").trim(), family });
  // db 指纹写进报告：任何一条返回路径（包括"没有变化"、失败）都要带上，报 bug 时能一眼看出 db 版本差异。
  empty.dbVersion = pinNames.db?.version ?? "";
  empty.dbRoot = pinNames.db?.root ?? "";
  if ((request.peripherals ?? []).length > 0) {
    notes.push(pinNames.describe());
    const pinWarning = pinNames.warning();
    if (pinWarning !== "") warnings.push(pinWarning);
  }
  for (const item of request.peripherals ?? []) enablePeripheral(pinTable, item, pinNames, notes);
  // 引脚表变化过才重写 Mcu.PinN。
  // 为什么不再按"有没有 .Signal"过滤：F1 的 PB2 在 CubeMX 里只有 PB2.Mode=B2-BOOT1（BOOT1 是复用功能，
  // 不带 .Signal）。按 .Signal 过滤会把它从 Mcu.PinN 里静默剔除——PinsNb 缩水，PB2.Mode / PB2.GPIO_*
  // 成了没有引脚指向的孤儿键，CubeMX 下次打开就丢这段配置。所以：已在表里的引脚一个都不删，只追加。
  // 虚拟引脚（VP_*）的清理归 ensureSerialWire 管，这里不掺和。
  if (!samePinOrder(originalOrder, pinTable.order)) writePinOrder(after, pinTable.order);

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

  // 时钟：.ioc 里的一段键，和 entries 一起算（不单开工具）。复用 after，所以同一调用里的
  // entries（例如 RCC.MCOSource）对时钟规划是可见的；规划出的键也是"候选文件"的一部分。
  const clockPlan = request.clock === undefined
    ? planClock(undefined, { entries: after })
    : planClock(request.clock, { entries: after });
  if (request.clock === undefined) {
    const achieved = clockPlan.achieved;
    notes.push(
      "时钟（只读，未请求改动）：SYSCLK " + formatHz(achieved.sysclkHz) +
      " / APB1 " + formatHz(achieved.apb1Hz) +
      " / APB2 " + formatHz(achieved.apb2Hz) +
      " / ADC " + formatHz(achieved.adcHz),
    );
  } else {
    warnings.push(...clockPlan.warnings);
    if (clockPlan.note !== "") notes.push("时钟：" + clockPlan.note);
    for (const item of clockPlan.entries) after.set(item.key, item.value);
    for (const key of clockPlan.unset) after.delete(key);
    for (const error of clockPlan.errors) errors.push("时钟：" + error);
  }

  // 外设接线自洽性（IPNb 条数、外设有没有引脚指向、多模式引脚缺不缺 .Mode）。
  validatePeripheralWiring(after, warnings);

  // 从 CubeMX 字节码还原出来的离线规则（docs §35）：IPParameters 白名单、DMA 需要 Mcu.IP=DMA、
  // ADC Rank 一致性、NVIC 值 9 段、F1 的 ADC 时钟上限。
  const ruleReport = checkIocRules(after, { db: pinNames.db, facts: pinNames.facts });
  for (const issue of ruleReport.errors) errors.push("[" + issue.rule + "] " + issue.message);
  for (const issue of ruleReport.warnings) warnings.push("[" + issue.rule + "] " + issue.message);

  // 重复键 / 跨行值：CubeMX 只认最后一个键值，而跨行值（Java properties 续行）改第一行会留下续行残骸。
  const planned = compareEntries(before, after);
  const multiLine = planned.filter((change) => diagnostics.multiLineKeys.has(change.key));
  if (multiLine.length > 0) {
    errors.push(
      "这些键的值跨了多行（Java properties 的续行）：" + multiLine.map((change) => change.key).join("、") +
        "。改第一行会留下续行残骸，请先在 CubeMX 里重新保存一次再改",
    );
  }
  const duplicated = planned.filter((change) => diagnostics.duplicates.has(change.key));
  if (duplicated.length > 0) {
    errors.push(
      "这些键在 .ioc 里出现了不止一次（CubeMX 只认最后一个）：" +
        duplicated.map((change) => change.key + "×" + String(diagnostics.duplicates.get(change.key) ?? 0)).join("、") +
        "。先在 CubeMX 里重新保存一次把重复键清掉，再来改",
    );
  }

  // 安全闸：这两条是踩过坑的硬约束，不满足就不给 plan。
  const candidateText = renderIocText(source, planned);
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
    return { ...empty, iocPath, sourceSha256, errors, warnings, notes, clockPlan, message: "没生成计划：" + (errors[0] as string) };
  }

  const changes = planned;
  if (changes.length === 0) {
    return { ...empty, iocPath, sourceSha256, warnings, notes, clockPlan, message: "没有变化：这些键本来就是这个值" };
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
    dbVersion: pinNames.db?.version ?? "",
    dbRoot: pinNames.db?.root ?? "",
    message: "已生成计划 " + planId + "：" + String(changes.length) + " 个键变化（新增 " + String(added) + "、删除 " + String(removedCount) + "、修改 " + String(changes.length - added - removedCount) + "）",
    summaryAfter: summary,
    clockPlan,
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
