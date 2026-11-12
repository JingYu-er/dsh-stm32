/**
 * stm32_serial：串口 P1 的工具入口（只做了 Windows 的 PowerShell 桥）。
 *
 * 七个动作对应一条最短路径：
 *   list     —— 列端口 + 每个端口记住的参数（按 USB 序列号记忆，换 COM 号也不丢）
 *   open     —— 起一个常驻桥，等 status.state=open（最多 5 s）
 *   read     —— 读 rx.ndjson 尾部；给 cursor 就只给那之后的新行（增量）
 *   send     —— 发一行，等桥的 done 回执（最多 2 s）
 *   transact —— 发一行并等期望的回包（until 是正则），适合 AT 命令 / 敲命令看输出
 *   status   —— 只读快照（会话、桥、文件大小、残留目录）
 *   close    —— 先礼后兵：发 close 等 3 s，还不退就杀 pid
 *
 * 设计取舍：
 *   - 只支持 Windows：串口 P1 用 PowerShell 常驻桥，Mac/Linux 上直接报 unsupported-platform，
 *     不假装能跑；
 *   - 单会话：一个进程同时只开一个口（engine 里 already-open 兜住了），
 *     因为「同时开两个口」在 AI 调用场景里几乎总是参数写错，而不是真实需求；
 *   - 无 UI：所有结果都落在 report 里，宿主的文本渲染仅负责呈现该报告；
 *   - 失败也返回完整形状的 report（字段全是默认值 + serialError），免得宿主序列化时炸。
 *
 * 工具层自己做了三件事（引擎没有对应参数，但调用方需要）：
 *   1) cursor 增量读：引擎只给尾部 N 字节，工具层按上次的 fileBytes 从文件偏移继续读，
 *      这样 AI 不会每次把整段历史重复贴进上下文；
 *   2) hex：把 "48 65 6C" 这类字节串按会话编码解成文本再发（UTF-8 会话下等价于发字节）；
 *   3) until：直接映射到引擎 transact 的 match（正则），超时只报 timedOut，不算错误。
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  SERIAL_DEFAULTS,
  SERIAL_ERROR_SCHEMA,
  SERIAL_LIMITS,
  SERIAL_SETTINGS_PROPERTIES,
  closeSerial,
  currentSerialSession,
  formatSerialError,
  listPorts,
  makeSerialError,
  openSerial,
  readSerial,
  sendSerial,
  serialStatus,
  transactSerial,
} from "../engine/serial.js";
import type {
  SerialError,
  SerialPortInfo,
  SerialRecord,
  SerialSessionView,
} from "../engine/serial.js";
import type { SerialNewline, SerialSettings } from "../data/serial-config.js";
import type { DshContext, JsonSchema, ToolExec } from "../types.js";
import { emitChannel } from "../engine/channels.js";

export const SERIAL_TOOL = "stm32_serial";

const ACTIONS = ["list", "open", "read", "send", "transact", "status", "close"] as const;
type SerialAction = (typeof ACTIONS)[number];

/** settings 的键（报告里 required 用；schema 的 properties 直接复用引擎那份，避免两处走样）。 */
const SETTINGS_KEYS = [
  "baudRate",
  "dataBits",
  "stopBits",
  "parity",
  "flow",
  "dtr",
  "rts",
  "encoding",
  "newline",
  "timeoutMs",
  "maxLines",
  "maxBytes",
  "idleTimeoutMs",
  "persist",
] as const;

const RECORD_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    t: { type: "number", description: "桥收到这一行的毫秒时间戳" },
    d: { type: "string", description: "行内容（不含换行）" },
    partial: { type: "boolean", description: "true = 没有换行收尾的残行（静默一段时间后 flush 出来的）" },
  },
  required: ["t", "d", "partial"],
};

const PORT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    port: { type: "string", description: "COM 号" },
    description: { type: "string", description: "PnP 设备名（通常就是芯片/驱动名）" },
    vid: { type: "string", description: "USB VID（十六进制）" },
    pid: { type: "string", description: "USB PID（十六进制）" },
    serialNumber: { type: "string", description: "USB 序列号；换 USB 口也认得出是同一块板子" },
    location: { type: "string", description: "USB 位置（总线路径）" },
    identity: { type: "string", description: "记忆用的身份：usb:VID:PID:序列号 / usb:VID:PID@位置 / com:COMx" },
    identityLabel: { type: "string", description: "身份的中文说明" },
    remembered: { type: "boolean", description: "serial.json 里有这个端口的记忆（上次通过）" },
    lastUsedPort: { type: "boolean", description: "上次最后用的就是这个 COM 号" },
    lastUsedAt: { type: "string", description: "上次成功打开的时间（ISO；没有就是空串）" },
    openCount: { type: "number", description: "成功打开过几次" },
  },
  required: ["port", "description", "vid", "pid", "serialNumber", "location", "identity", "identityLabel", "remembered", "lastUsedPort", "lastUsedAt", "openCount"],
};

const SETTINGS_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: SERIAL_SETTINGS_PROPERTIES,
  required: [...SETTINGS_KEYS],
};

export const reportSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean", description: "这次动作成功没有" },
    action: { type: "string", description: "list / open / read / send / transact / status / close" },
    message: { type: "string", description: "结论摘要" },
    port: { type: "string", description: "这次动作对应的 COM 号（没有就是空串）" },
    sessionId: { type: "string", description: "会话 id（没有就是空串）" },
    state: { type: "string", description: "桥的状态：opening / open / closed / error / 空串" },
    bridgePid: { type: "number", description: "桥进程 pid（0 = 没有）" },
    bridgeAlive: { type: "boolean", description: "桥进程是否存活" },
    persist: { type: "boolean", description: "会话是否跨 turn 保留" },
    settings: SETTINGS_SCHEMA,
    durationMs: { type: "number", description: "这次动作花了多少毫秒" },
    records: { type: "array", description: "读到/收到的行（按时间顺序）", items: RECORD_SCHEMA },
    bytes: { type: "number", description: "这次读/发的字节数" },
    fileBytes: { type: "number", description: "rx.ndjson 的总字节数（cursor 增量读的下一个起点）" },
    nextCursor: { type: "number", description: "下次 read 传这个 cursor 就只要新行" },
    truncated: { type: "boolean", description: "true = 只给了尾部（更早的行没返回）" },
    matched: { type: "boolean", description: "transact 的 until 命中没有" },
    matchedLine: { type: "string", description: "命中的那一行（没有就是空串）" },
    text: { type: "string", description: "这次发出去的文本" },
    ports: { type: "array", description: "list 的端口清单", items: PORT_SCHEMA },
    configPath: { type: "string", description: "serial.json 的位置" },
    platform: { type: "string", description: "process.platform" },
    notes: { type: "array", description: "补充说明（一条一行）", items: { type: "string" } },
    errors: { type: "array", description: "失败原因（一条一行）", items: { type: "string" } },
    serialError: SERIAL_ERROR_SCHEMA,
  },
  required: [
    "ok",
    "action",
    "message",
    "port",
    "sessionId",
    "state",
    "bridgePid",
    "bridgeAlive",
    "persist",
    "settings",
    "durationMs",
    "records",
    "bytes",
    "fileBytes",
    "nextCursor",
    "truncated",
    "matched",
    "matchedLine",
    "text",
    "ports",
    "configPath",
    "platform",
    "notes",
    "errors",
  ],
};

/** 宿主按 { message, report } 校验工具返回（与其他工具一致）；report 是上面这份扁平形状。
 *  不能把扁平 report 直接当 outputSchema：宿主会报 missing required property value.ok。 */
export const outputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: { type: "string" },
    report: reportSchema,
  },
  required: ["message", "report"],
};

export const parameters: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: [...ACTIONS],
      description:
        "list=列端口；open=打开端口（单会话）；read=读串口输出（给 cursor 就只返回新行）；" +
        "send=发一行；transact=发一行并等回包（until 是正则）；status=看会话/桥状态；close=关端口",
    },
    port: { type: "string", description: "COM 号，例如 COM3（open 省略时用 serial.json 里上次成功的端口）" },
    text: { type: "string", description: "send/transact 要发的文本（不含自动补的换行）" },
    hex: { type: "string", description: "要发的字节（十六进制，例如 \"48 65 6C\"）；和 text 二选一，按会话编码解成文本后发送" },
    raw: { type: "boolean", description: "true = 原样发，不补换行（默认 false）" },
    until: { type: "string", description: "transact 期望出现的行（正则，例如 \"OK|ERROR\"）；不给就只等 timeoutMs 收尾" },
    cursor: { type: "number", description: "read 的增量起点（上次返回的 nextCursor）；不给就读最新尾部" },
    sessionId: { type: "string", description: "显式指定会话 id（一般不用：单会话，省略就是当前那个）" },
    ...SERIAL_SETTINGS_PROPERTIES,
  },
  required: ["action"],
};

interface SettingsWire {
  baudRate: number;
  dataBits: number;
  stopBits: string;
  parity: string;
  flow: string;
  dtr: boolean;
  rts: boolean;
  encoding: string;
  newline: string;
  timeoutMs: number;
  maxLines: number;
  maxBytes: number;
  idleTimeoutMs: number;
  persist: boolean;
}

interface SerialToolReport {
  ok: boolean;
  action: string;
  message: string;
  port: string;
  sessionId: string;
  state: string;
  bridgePid: number;
  bridgeAlive: boolean;
  persist: boolean;
  settings: SettingsWire;
  durationMs: number;
  records: SerialRecord[];
  bytes: number;
  fileBytes: number;
  nextCursor: number;
  truncated: boolean;
  matched: boolean;
  matchedLine: string;
  text: string;
  ports: SerialPortInfo[];
  configPath: string;
  platform: string;
  notes: string[];
  errors: string[];
  serialError?: SerialError;
}

interface ToolValue {
  message: string;
  report: SerialToolReport;
}

/**
 * 报告里的 settings：前 9 个来自会话（会记忆、会随 open 参数变化），后 5 个是本次调用的
 * 超时/上限/persist。引擎的 SerialSettings 不包含后 5 个（后 5 个属于会话行为，不是线参数），
 * 所以这里单独补，缺省用 SERIAL_DEFAULTS。
 */
function settingsWire(settings: SerialSettings, extra: Partial<Pick<SettingsWire, "timeoutMs" | "maxLines" | "maxBytes" | "idleTimeoutMs" | "persist">> = {}): SettingsWire {
  return {
    baudRate: settings.baudRate,
    dataBits: settings.dataBits,
    stopBits: settings.stopBits,
    parity: settings.parity,
    flow: settings.flow,
    dtr: settings.dtr,
    rts: settings.rts,
    encoding: settings.encoding,
    newline: settings.newline,
    timeoutMs: extra.timeoutMs ?? SERIAL_DEFAULTS.timeoutMs,
    maxLines: extra.maxLines ?? SERIAL_DEFAULTS.maxLines,
    maxBytes: extra.maxBytes ?? SERIAL_DEFAULTS.maxBytes,
    idleTimeoutMs: extra.idleTimeoutMs ?? SERIAL_DEFAULTS.idleTimeoutMs,
    persist: extra.persist ?? SERIAL_DEFAULTS.persist,
  };
}

function defaultsWire(): SettingsWire {
  return settingsWire({
    baudRate: SERIAL_DEFAULTS.baudRate,
    dataBits: SERIAL_DEFAULTS.dataBits,
    stopBits: SERIAL_DEFAULTS.stopBits,
    parity: SERIAL_DEFAULTS.parity,
    flow: SERIAL_DEFAULTS.flow,
    dtr: SERIAL_DEFAULTS.dtr,
    rts: SERIAL_DEFAULTS.rts,
    encoding: SERIAL_DEFAULTS.encoding,
    newline: SERIAL_DEFAULTS.newline,
  });
}

/** 报告先按默认值填满，再逐项覆盖：任何一条失败路径都不会漏字段。 */
function baseReport(action: string): SerialToolReport {
  return {
    ok: false,
    action,
    message: "",
    port: "",
    sessionId: "",
    state: "",
    bridgePid: 0,
    bridgeAlive: false,
    persist: false,
    settings: defaultsWire(),
    durationMs: 0,
    records: [],
    bytes: 0,
    fileBytes: 0,
    nextCursor: 0,
    truncated: false,
    matched: false,
    matchedLine: "",
    text: "",
    ports: [],
    configPath: "",
    platform: process.platform,
    notes: [],
    errors: [],
  };
}

function failure(action: string, message: string, notes: string[] = [], error: SerialError | null = null): ToolValue {
  const report = baseReport(action);
  report.message = message;
  report.errors = [message];
  report.notes = notes;
  if (error !== null) report.serialError = error;
  return { message, report };
}

/** 把一次引擎调用的失败原因塞进报告（errors 一行、serialError 结构化）。 */
function applyError(report: SerialToolReport, error: SerialError | null, fallback: string): void {
  if (error !== null) {
    report.serialError = error;
    report.errors.push(formatSerialError(error));
    return;
  }
  if (fallback !== "") report.errors.push(fallback);
}

function formatReport(report: SerialToolReport): string[] {
  const lines: string[] = [];
  lines.push((report.ok ? "完成" : "失败") + "（" + report.action + "）：" + report.message);
  if (report.sessionId !== "") {
    lines.push(
      "会话 " + report.sessionId + "：" + report.port + "，状态 " + (report.state === "" ? "未知" : report.state) +
        "，桥 pid " + String(report.bridgePid) + (report.bridgeAlive ? "（活着）" : "（不在）") +
        (report.persist ? "，persist=true（跨 turn 保留）" : ""),
    );
  }
  if (report.ports.length > 0) {
    for (const port of report.ports) {
      const facts = [port.description, port.vid !== "" && port.pid !== "" ? "VID:PID " + port.vid + ":" + port.pid : "", port.serialNumber !== "" ? "SN " + port.serialNumber : ""]
        .filter((part) => part !== "")
        .join("，");
      lines.push(
        "  " + port.port + (facts === "" ? "" : "（" + facts + "）") +
          (port.remembered ? "，有记忆：" + String(port.settings.baudRate) + " " + String(port.settings.dataBits) + String(port.settings.parity.charAt(0).toUpperCase()) + port.settings.stopBits : "") +
          (port.lastUsedPort ? "，上次使用的端口" : ""),
      );
    }
  }
  const shown = report.records.slice(0, 80);
  for (const record of shown) {
    lines.push("  " + String(record.t) + " ms | " + record.d + (record.partial ? "  [没有换行]" : ""));
  }
  if (report.records.length > shown.length) {
    lines.push("  … 还有 " + String(report.records.length - shown.length) + " 行（调大 maxLines 或分批 read）");
  }
  if (report.text !== "") lines.push("· 发出：" + report.text);
  if (report.matched) lines.push("· until 命中：" + report.matchedLine);
  if (report.nextCursor > 0) lines.push("· 下一段从这里读：cursor=" + String(report.nextCursor) + "（rx 共 " + String(report.fileBytes) + " 字节）");
  if (report.truncated) lines.push("· 只给了尾部（更早的行没返回）");
  for (const note of report.notes) lines.push("· " + note);
  for (const error of report.errors.slice(0, 6)) lines.push("! " + error);
  return lines;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** 把参数里给了的串口设置挑出来（没给的交给引擎用记忆/缺省合并）。 */
function settingsFromArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SETTINGS_KEYS) {
    const value = args[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function sessionFields(report: SerialToolReport, session: SerialSessionView | null): void {
  if (session === null) {
    report.sessionId = "";
    report.port = "";
    report.state = "closed";
    report.bridgePid = 0;
    report.bridgeAlive = false;
    report.persist = false;
    return;
  }
  report.sessionId = session.sessionId;
  report.port = session.port;
  report.state = session.state;
  report.bridgePid = session.bridgePid;
  report.bridgeAlive = session.bridgeAlive;
  report.persist = session.persist;
  // 会话里存的是打开时真正生效的 timeoutMs/maxLines/...；只给 session.settings 的话
  // 这 5 个字段会永远显示默认值（open 传了 timeoutMs 也看不到）。
  report.settings = settingsWire(session.settings, {
    timeoutMs: session.timeoutMs,
    maxLines: session.maxLines,
    maxBytes: session.maxBytes,
    idleTimeoutMs: session.idleTimeoutMs,
    persist: session.persist,
  });
}

// ── hex 与 cursor：工具层补的两个能力 ────────────────────────────────────────

/** "48 65 6C" / "0x48,0x65" / "48656c" 都认；空串或奇数位返回 null。 */
function parseHexBytes(raw: string): number[] | null {
  const cleaned = raw.trim().toLowerCase().replace(/0x/gu, "").replace(/[^0-9a-f]/gu, "");
  if (cleaned === "" || cleaned.length % 2 !== 0) return null;
  const bytes: number[] = [];
  for (let index = 0; index < cleaned.length; index += 2) {
    bytes.push(Number.parseInt(cleaned.slice(index, index + 2), 16));
  }
  return bytes;
}

interface HexText {
  ok: boolean;
  text: string;
  message: string;
}

/**
 * 字节 → 文本。
 *
 * 为什么不做成「原样发字节」：桥的 send 只收文本，写进串口前用会话编码 GetBytes。
 * 所以 hex 只能在工具层反解：utf8 会话要求字节是合法 UTF-8（否则发出的是替换字符，
 * 比报错更难查）；要发任意字节就把会话 encoding 设成 latin1（1:1 映射）。
 */
function hexToText(bytes: number[], encoding: string): HexText {
  const buffer = Buffer.from(bytes);
  if (encoding === "latin1") return { ok: true, text: buffer.toString("latin1"), message: "" };
  if (encoding === "ascii") {
    if (bytes.some((byte) => byte > 0x7f)) {
      return { ok: false, text: "", message: "hex 里有大于 0x7F 的字节，但会话编码是 ascii；改成 latin1 才能 1:1 发出去" };
    }
    return { ok: true, text: buffer.toString("latin1"), message: "" };
  }
  const text = buffer.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buffer)) {
    return { ok: false, text: "", message: "hex 不是合法 UTF-8（会被编码成替换字符）；要发任意字节请把 encoding 设成 latin1" };
  }
  return { ok: true, text, message: "" };
}

interface RxWindow {
  records: SerialRecord[];
  bytes: number;
  fileBytes: number;
  truncated: boolean;
  badLines: number;
  /** true = cursor 比文件还大（文件被轮转/重建），这次从头读。 */
  reset: boolean;
}

function emptyWindow(): RxWindow {
  return { records: [], bytes: 0, fileBytes: 0, truncated: false, badLines: 0, reset: false };
}

/**
 * 从 rx.ndjson 的 cursor 偏移往后读。
 *
 * 引擎的 readSerial 只给「尾部 maxBytes 字节」，拿不到偏移；增量读只能工具层自己做。
 * 格式与桥一致：一行一个 {t,d[,p]}，行之间用 \n 分隔。
 */
function readRxFrom(session: SerialSessionView, cursor: number, maxBytes: number, maxLines: number): RxWindow {
  const path = join(session.ipcDir, "rx.ndjson");
  let fileBytes = 0;
  try {
    fileBytes = statSync(path).size;
  } catch {
    return emptyWindow();
  }
  let from = Math.max(0, Math.trunc(cursor));
  let reset = false;
  if (from > fileBytes) {
    from = 0;
    reset = true;
  }
  const start = Math.max(from, fileBytes - maxBytes);
  const length = fileBytes - start;
  if (length <= 0) return { ...emptyWindow(), fileBytes, reset };
  const buffer = Buffer.alloc(length);
  try {
    const fd = openSync(path, "r");
    try {
      readSync(fd, buffer, 0, length, start);
    } finally {
      closeSync(fd);
    }
  } catch {
    return { ...emptyWindow(), fileBytes, reset };
  }
  let text = buffer.toString("utf8");
  // 从文件中间开始时第一行可能是半截：丢弃该行（属于更早的字节区间）
  if (start > from) {
    const index = text.indexOf("\n");
    text = index >= 0 ? text.slice(index + 1) : "";
  }
  const records: SerialRecord[] = [];
  let badLines = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      records.push({
        t: typeof parsed["t"] === "number" ? parsed["t"] : 0,
        d: typeof parsed["d"] === "string" ? parsed["d"] : "",
        partial: parsed["p"] === true,
      });
    } catch {
      badLines += 1;
    }
  }
  const truncated = start > from || records.length > maxLines;
  return { records: records.slice(-maxLines), bytes: length, fileBytes, truncated, badLines, reset };
}

// ── 动作实现 ─────────────────────────────────────────────────────────────────

async function runList(exec: ToolExec): Promise<ToolValue> {
  const listed = await listPorts({ env: process.env, signal: exec.signal });
  const report = baseReport("list");
  report.ok = listed.ok;
  report.platform = listed.platform;
  report.configPath = listed.configPath;
  report.ports = listed.ports;
  report.message = listed.message;
  if (!listed.ok) applyError(report, listed.serialError, listed.errors.join("；"));
  return { message: report.message, report };
}

async function runOpen(args: Record<string, unknown>, exec: ToolExec): Promise<ToolValue> {
  const portName = readString(args.port);
  const opened = await openSerial({
    ...settingsFromArgs(args),
    ...(portName === undefined ? {} : { port: portName }),
    env: process.env,
    signal: exec.signal,
  });
  const report = baseReport("open");
  report.ok = opened.ok;
  report.durationMs = opened.durationMs;
  report.settings = settingsWire(opened.settings, {
    timeoutMs: readNumber(args.timeoutMs),
    maxLines: readNumber(args.maxLines),
    maxBytes: readNumber(args.maxBytes),
    idleTimeoutMs: readNumber(args.idleTimeoutMs),
    persist: readBoolean(args.persist),
  });
  report.notes = [...opened.notes];
  report.message = opened.message;
  sessionFields(report, opened.session);
  if (opened.session === null) {
    // open 失败时 sessionFields 会把 bridgePid 清零；但这里恰恰最需要那个 pid
    // （启动超时/失败时用户需据此确认是否有残留进程占用 COM 口）。
    if (opened.bridge.pid > 0) report.bridgePid = opened.bridge.pid;
    report.bridgeAlive = false;
  }
  if (!opened.ok) applyError(report, opened.serialError, "");
  else report.notes.push("桥：" + opened.bridge.host + " " + opened.bridge.exe + "，pid " + String(opened.bridge.pid));
  return { message: report.message, report };
}

async function runRead(args: Record<string, unknown>, exec: ToolExec): Promise<ToolValue> {
  const report = baseReport("read");
  const cursor = readNumber(args.cursor);
  const sessionId = readString(args.sessionId);
  const maxLines = readNumber(args.maxLines);
  const maxBytes = readNumber(args.maxBytes);

  if (cursor === undefined) {
    const read = await readSerial({
      ...(maxLines === undefined ? {} : { maxLines }),
      ...(maxBytes === undefined ? {} : { maxBytes }),
      ...(sessionId === undefined ? {} : { sessionId }),
      env: process.env,
      signal: exec.signal,
    });
    report.ok = read.ok;
    report.records = read.records;
    report.bytes = read.bytes;
    report.fileBytes = read.fileBytes;
    report.nextCursor = read.fileBytes;
    report.truncated = read.truncated;
    report.notes = read.badLines > 0 ? ["rx.ndjson 里有 " + String(read.badLines) + " 行不是合法 JSON（桥写坏了，或者文件被手工改过）"] : [];
    report.message = read.message;
    sessionFields(report, read.session);
    if (!read.ok) applyError(report, read.serialError, "");
    if (read.ok && read.records.length > 0) {
      emitChannel({
        channel: "serial",
        lines: read.records.map((record) => record.d),
        meta: { action: "read" },
      });
    }
    return { message: report.message, report };
  }

  // 增量读：先确认会话，再从偏移继续（引擎没有 offset 参数）
  const session = currentSerialSession();
  if (session === null) {
    const error = makeSerialError("no-session");
    const value = failure("read", "没有串口会话：" + error.hint, [], error);
    return value;
  }
  if (sessionId !== undefined && sessionId !== session.sessionId) {
    const error = makeSerialError("no-session", { cause: "会话 " + sessionId + " 不是当前会话（当前 " + session.sessionId + "）" });
    return failure("read", error.cause, [], error);
  }
  const window = readRxFrom(
    session,
    cursor,
    Math.min(maxBytes ?? SERIAL_DEFAULTS.maxBytes, SERIAL_LIMITS.maxBytes),
    Math.min(maxLines ?? SERIAL_DEFAULTS.maxLines, SERIAL_LIMITS.maxLines),
  );
  report.ok = true;
  report.records = window.records;
  report.bytes = window.bytes;
  report.fileBytes = window.fileBytes;
  report.nextCursor = window.fileBytes;
  report.truncated = window.truncated;
  if (window.reset) report.notes.push("cursor 比 rx.ndjson 还大（文件被轮转/重建），这次从头读");
  if (window.badLines > 0) report.notes.push("有 " + String(window.badLines) + " 行不是合法 JSON");
  report.message =
    window.records.length === 0
      ? "cursor 之后没有新行（rx.ndjson " + String(window.fileBytes) + " 字节）"
      : "读到 " + String(window.records.length) + " 行新输出";
  sessionFields(report, session);
  if (window.records.length > 0) {
    emitChannel({
      channel: "serial",
      lines: window.records.map((record) => record.d),
      meta: { action: "read", incremental: true },
    });
  }
  return { message: report.message, report };
}

interface Payload {
  ok: boolean;
  text: string;
  message: string;
}

/** send/transact 共用：text 与 hex 二选一，hex 按会话编码反解。 */
function resolvePayload(args: Record<string, unknown>, session: SerialSessionView | null): Payload {
  const text = typeof args.text === "string" ? args.text : undefined;
  const hex = readString(args.hex);
  if (text !== undefined && hex !== undefined) {
    return { ok: false, text: "", message: "text 与 hex 只能给一个" };
  }
  if (hex === undefined) {
    if (text === undefined) return { ok: false, text: "", message: "需要 text（要发的文本）或 hex（要发的字节）" };
    return { ok: true, text, message: "" };
  }
  const bytes = parseHexBytes(hex);
  if (bytes === null) return { ok: false, text: "", message: "hex 不是合法的十六进制字节串（例如 \"48 65 6C\"）" };
  const encoding = session?.settings.encoding ?? SERIAL_DEFAULTS.encoding;
  const converted = hexToText(bytes, encoding);
  if (!converted.ok) return { ok: false, text: "", message: converted.message };
  return { ok: true, text: converted.text, message: "" };
}

async function runSend(args: Record<string, unknown>, exec: ToolExec): Promise<ToolValue> {
  const session = currentSerialSession();
  const payload = resolvePayload(args, session);
  if (!payload.ok) {
    const error = makeSerialError("settings-invalid", { cause: payload.message });
    return failure("send", payload.message, [], error);
  }
  const newline = readString(args.newline);
  const raw = readBoolean(args.raw) === true;
  const sessionId = readString(args.sessionId);
  const sent = await sendSerial({
    text: payload.text,
    ...(newline === undefined ? {} : { newline: newline as SerialNewline }),
    ...(raw ? { raw: true } : {}),
    ...(sessionId === undefined ? {} : { sessionId }),
    env: process.env,
    signal: exec.signal,
  });
  const report = baseReport("send");
  report.ok = sent.ok;
  report.text = payload.text;
  report.bytes = sent.bytes;
  report.durationMs = sent.ackMs;
  report.message = sent.message;
  sessionFields(report, sent.session);
  if (!sent.ok) applyError(report, sent.serialError, "");
  return { message: report.message, report };
}

async function runTransact(args: Record<string, unknown>, exec: ToolExec): Promise<ToolValue> {
  const session = currentSerialSession();
  const payload = resolvePayload(args, session);
  if (!payload.ok) {
    const error = makeSerialError("settings-invalid", { cause: payload.message });
    return failure("transact", payload.message, [], error);
  }
  const until = readString(args.until);
  const newline = readString(args.newline);
  const raw = readBoolean(args.raw) === true;
  const sessionId = readString(args.sessionId);
  const timeoutMs = readNumber(args.timeoutMs);
  const maxLines = readNumber(args.maxLines);
  const maxBytes = readNumber(args.maxBytes);
  const result = await transactSerial({
    text: payload.text,
    ...(until === undefined ? {} : { match: until }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxLines === undefined ? {} : { maxLines }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(newline === undefined ? {} : { newline: newline as SerialNewline }),
    ...(raw ? { raw: true } : {}),
    ...(sessionId === undefined ? {} : { sessionId }),
    env: process.env,
    signal: exec.signal,
  });
  const report = baseReport("transact");
  report.ok = result.ok;
  report.text = payload.text;
  report.records = result.records;
  report.matched = result.matched;
  report.matchedLine = result.matchedLine;
  report.durationMs = result.durationMs;
  report.truncated = result.truncated;
  report.message = result.message;
  sessionFields(report, result.session);
  if (!result.ok) applyError(report, result.serialError, "");
  if (result.records.length > 0) {
    emitChannel({
      channel: "serial",
      lines: result.records.map((record) => record.d),
      meta: { action: "transact", ...(result.matchedLine === undefined ? {} : { matchedLine: result.matchedLine }) },
    });
  }
  if (result.timedOut) report.notes.push("等到 timeoutMs 也没有命中 until；如果只是要看输出，用 read 更省事");
  return { message: report.message, report };
}

async function runStatus(exec: ToolExec): Promise<ToolValue> {
  const status = await serialStatus({ env: process.env, includeFiles: true });
  const report = baseReport("status");
  report.ok = status.ok;
  report.platform = status.platform;
  report.configPath = status.configPath;
  report.records = [];
  report.bridgePid = status.bridge.pid;
  report.bridgeAlive = status.bridge.alive;
  report.state = status.bridge.state;
  report.message = status.message;
  report.notes = [...status.notes];
  report.notes.push("磁盘上 " + String(status.sessionDirs) + " 个会话目录，其中死的 " + String(status.staleDirs.length) + " 个");
  if (status.orphanDirs.length > 0) {
    report.notes.push("有 " + String(status.orphanDirs.length) + " 个活着的孤儿桥（不在当前会话里，可能占着 COM 口）：" + status.orphanDirs.join("、"));
  }
  report.notes.push("文件：rx " + String(status.files.rxBytes) + " B，tx " + String(status.files.txBytes) + " B，log " + String(status.files.logBytes) + " B");
  if (status.session !== null) sessionFields(report, status.session);
  else sessionFields(report, null);
  if (!status.ok) applyError(report, status.serialError, "");
  void exec;
  return { message: report.message, report };
}

async function runClose(args: Record<string, unknown>, exec: ToolExec): Promise<ToolValue> {
  const sessionId = readString(args.sessionId);
  const closed = await closeSerial({
    ...(sessionId === undefined ? {} : { sessionId }),
    env: process.env,
    signal: exec.signal,
  });
  const report = baseReport("close");
  report.ok = closed.ok;
  report.durationMs = closed.durationMs;
  report.message = closed.message;
  report.notes = [...closed.notes];
  sessionFields(report, closed.session);
  if (closed.closed) report.state = "closed";
  if (closed.forced) report.notes.push("桥没有按时退出，已强杀 pid");
  if (!closed.ok) applyError(report, closed.serialError, "");
  return { message: report.message, report };
}

// ── 注册 ─────────────────────────────────────────────────────────────────────

export function registerSerial(ctx: DshContext): void {
  ctx.tools.register({
    name: SERIAL_TOOL,
    description:
      "STM32 串口（仅 Windows，P1）：列端口 / 打开 / 读输出 / 发一行 / 发一行并等回包 / 看状态 / 关端口。" +
      "常驻 PowerShell 桥（System.IO.Ports），没有 UI，全程 AI 可调用；单会话（一个进程同时只开一个口）。" +
      "默认 115200 8N1、无流控、DTR/RTS 不拉高、UTF-8、自动补 CRLF；按 USB 序列号记住端口参数，" +
      "换 COM 号也能复用。turn 结束时默认自动关（persist=true 除外）。" +
      "典型用法：先 list 找 COM 号，再 open，然后 read（给上次的 nextCursor 就只拿新行）或 transact（等 OK/ERROR）。",
    parameters,
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    output: {
      schema: outputSchema,
      render: (_args, value) => [{ type: "text", text: formatReport((value as ToolValue).report).join("\n") }],
    },
    async execute(rawArgs: unknown, exec: ToolExec): Promise<ToolValue> {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const action = readString(args.action);
      if (action === undefined) {
        return failure("", "缺少 action：list / open / read / send / transact / status / close");
      }
      if (!(ACTIONS as readonly string[]).includes(action)) {
        return failure(action, "未知 action：" + action + "（只能是 " + ACTIONS.join(" / ") + "）");
      }
      try {
        switch (action as SerialAction) {
          case "list":
            return await runList(exec);
          case "open":
            return await runOpen(args, exec);
          case "read":
            return await runRead(args, exec);
          case "send":
            return await runSend(args, exec);
          case "transact":
            return await runTransact(args, exec);
          case "status":
            return await runStatus(exec);
          case "close":
            return await runClose(args, exec);
          default:
            return failure(action, "未知 action：" + action);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure(action, "工具内部异常：" + message);
      }
    },
  });
}
