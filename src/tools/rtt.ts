/**
 * stm32_rtt：RTT 的入口工具。四个动作对应一条最短路径：
 *
 *   start  —— 确认目标里有控制块 → openocd rtt setup/start → 开通道 TCP 端口
 *   dump   —— 连上通道读一段时间的记录（可按级别过滤、按条数截断）
 *   stop   —— 断通道，让 openocd 收掉 rtt server
 *   status —— 只读快照
 *
 * 设计取舍：
 *   - 没有活跃调试会话时，start 自己起一个（ensureSession），用户不用记着先开会话；
 *   - dump/stop/status 不再跑工具链 gate：RTT 都跑起来了说明 openocd 在，再检查一遍只会碍事；
 *   - 失败也返回完整形状的 report（字段全是默认值 + probeError），免得宿主序列化时炸。
 */

import {
  DEFAULT_DUMP_SECONDS,
  DEFAULT_MAX_RECORDS,
  DEFAULT_RTT_PORT,
  DEFAULT_RTT_SIZE,
  RTT_LEVEL_NAMES,
  dumpRtt,
  rttStatus,
  startRtt,
  stopRtt,
} from "../engine/rtt.js";
import type { RttRecord, RttStatusSnapshot } from "../engine/rtt.js";
import type { ProbeError } from "../engine/probe-error.js";
import { PROBE_ERROR_SCHEMA } from "../engine/probe-error.js";
import { ensureSession, sessionInfo } from "../engine/probe-session.js";
import { ensureToolchain, gateReportNotes } from "../engine/toolchain-gate.js";
import type { DshContext, JsonSchema, SubprocessService, ToolExec } from "../types.js";
import { resolveProjectDir, validateToolArgs } from "./project-dir.js";

export const RTT_TOOL = "stm32_rtt";

const ENV_CHECK_SCHEMA: JsonSchema = {
  type: "string",
  enum: ["block", "warn", "off"],
  description: "工具链检查：block 缺件就拒绝（默认）、warn 只警告、off 不检查",
};

const RECORD_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    t: { type: "number", description: "模板写进来的毫秒时间戳（通常就是 HAL_GetTick）" },
    level: { type: "number", description: "级别：1=error 2=warn 3=info 4=debug" },
    text: { type: "string", description: "记录正文" },
  },
  required: ["t", "level", "text"],
};

const SESSION_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    port: { type: "number", description: "gdb 端口（0 表示当时没有会话）" },
    tclPort: { type: "number", description: "openocd 的 Tcl RPC 端口（0 表示没有）" },
  },
  required: ["port", "tclPort"],
};

export const outputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean", description: "这次动作成功没有" },
    action: { type: "string", description: "start / dump / stop / status" },
    projectDir: { type: "string", description: "工程目录" },
    addr: { type: "string", description: "RTT 控制块地址（十六进制）" },
    size: { type: "number", description: "控制块预留字节数" },
    banner: { type: "string", description: "控制块标识（rtt setup 的第三个参数）" },
    port: { type: "number", description: "RTT 通道的 TCP 端口" },
    running: { type: "boolean", description: "RTT 当前是否在跑" },
    startedAt: { type: "number", description: "start 的 Unix 毫秒时间戳；没跑时为 0" },
    runningMs: { type: "number", description: "已经跑了多少毫秒；没跑时为 0" },
    durationMs: { type: "number", description: "这次动作花了多少毫秒" },
    records: { type: "array", description: "dump 到的记录（按时间顺序）", items: RECORD_SCHEMA },
    dropped: { type: "number", description: "按 level 过滤掉的条数" },
    bytes: { type: "number", description: "从通道读到的字节数" },
    truncated: { type: "boolean", description: "是否因为 maxRecords 提前收尾" },
    stopped: { type: "boolean", description: "通道是否在窗口内被关掉（目标复位或 stop）" },
    session: SESSION_SCHEMA,
    errors: { type: "array", description: "失败原因（一条一行）", items: { type: "string" } },
    message: { type: "string", description: "一句话结论" },
    notes: { type: "array", description: "补充说明", items: { type: "string" } },
    probeError: PROBE_ERROR_SCHEMA,
  },
  required: [
    "ok",
    "action",
    "projectDir",
    "addr",
    "size",
    "banner",
    "port",
    "running",
    "startedAt",
    "runningMs",
    "durationMs",
    "records",
    "dropped",
    "bytes",
    "truncated",
    "stopped",
    "session",
    "errors",
    "message",
    "notes",
  ],
};

interface RttSessionWire {
  port: number;
  tclPort: number;
}

interface RttToolReport {
  ok: boolean;
  action: string;
  projectDir: string;
  addr: string;
  size: number;
  banner: string;
  port: number;
  running: boolean;
  startedAt: number;
  runningMs: number;
  durationMs: number;
  records: RttRecord[];
  dropped: number;
  bytes: number;
  truncated: boolean;
  stopped: boolean;
  session: RttSessionWire;
  errors: string[];
  message: string;
  notes: string[];
  probeError?: ProbeError;
}

interface ToolValue {
  message: string;
  report: RttToolReport;
}

const ACTIONS = ["start", "dump", "stop", "status"] as const;

function sessionWire(): RttSessionWire {
  const session = sessionInfo();
  if (session === null) return { port: 0, tclPort: 0 };
  return { port: session.port, tclPort: session.tclPort };
}

/** 报告先按默认值填满，再逐项覆盖：任何一条失败路径都不会漏字段。 */
function baseReport(action: string, projectDir: string): RttToolReport {
  const snapshot = rttStatus();
  return {
    ok: false,
    action,
    projectDir,
    addr: snapshot.addr,
    size: snapshot.size,
    banner: snapshot.banner,
    port: snapshot.port,
    running: snapshot.running,
    startedAt: snapshot.startedAt,
    runningMs: snapshot.runningMs,
    durationMs: 0,
    records: [],
    dropped: 0,
    bytes: 0,
    truncated: false,
    stopped: false,
    session: sessionWire(),
    errors: [],
    message: "",
    notes: [],
  };
}

function failure(action: string, projectDir: string, message: string, notes: string[] = [], probeError: ProbeError | null = null): ToolValue {
  const report = baseReport(action, projectDir);
  report.message = message;
  report.errors = [message];
  report.notes = notes;
  if (probeError !== null) report.probeError = probeError;
  return { message, report };
}

function formatReport(report: RttToolReport): string[] {
  const lines: string[] = [];
  lines.push((report.ok ? "完成" : "失败") + "（" + report.action + "）：" + report.message);
  if (report.running) {
    lines.push(
      "RTT 在跑：控制块 " + report.addr + "（" + String(report.size) + " 字节），通道端口 " + String(report.port) +
        (report.banner === "" ? "" : "，banner " + report.banner) + "，已跑 " + String(report.runningMs) + " ms",
    );
  }
  const shown = report.records.slice(0, 80);
  for (const record of shown) {
    const name = RTT_LEVEL_NAMES[record.level] ?? String(record.level);
    lines.push("  [" + String(record.t) + " ms][" + name + "] " + record.text);
  }
  if (report.records.length > shown.length) lines.push("  … 还有 " + String(report.records.length - shown.length) + " 条（调大 maxRecords 或分批 dump）");
  if (report.truncated) lines.push("· 达到 maxRecords 上限，提前收尾");
  if (report.stopped) lines.push("· RTT 通道已停（目标复位或 rtt stop）");
  lines.push("· 这次读 " + String(report.bytes) + " 字节" + (report.dropped > 0 ? "，按级别过滤掉 " + String(report.dropped) + " 条" : ""));
  for (const note of report.notes) lines.push("· " + note);
  for (const error of report.errors.slice(0, 6)) lines.push("! " + error);
  return lines;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function snapshotInto(report: RttToolReport, snapshot: RttStatusSnapshot): void {
  report.addr = snapshot.addr;
  report.size = snapshot.size;
  report.banner = snapshot.banner;
  report.port = snapshot.port;
  report.running = snapshot.running;
  report.startedAt = snapshot.startedAt;
  report.runningMs = snapshot.runningMs;
  report.session = sessionWire();
}

export function registerRtt(ctx: DshContext): void {
  ctx.tools.register({
    name: RTT_TOOL,
    description:
      "RTT（Real Time Transfer）：start 起 openocd 的 rtt 通道并给出 TCP 端口，dump 读一段时间的记录（级别过滤/条数截断），stop 收掉，status 看状态。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: [...ACTIONS], description: "start（起 RTT）/ dump（读记录）/ stop（停）/ status（看状态）" },
        projectDir: { type: "string", description: "工程目录；缺省取会话工作目录" },
        addr: { type: "string", description: "RTT 控制块起始地址（十六进制，例如 0x20000000）；action=start 必填" },
        size: { type: "number", description: "控制块预留字节数，默认 " + String(DEFAULT_RTT_SIZE) },
        banner: { type: "string", description: "控制块标识（openocd rtt setup 的第三个参数）；一般不用填" },
        rttPort: { type: "number", description: "RTT 通道的 TCP 端口，默认 " + String(DEFAULT_RTT_PORT) },
        seconds: { type: "number", description: "dump 的采集窗口（秒），默认 " + String(DEFAULT_DUMP_SECONDS) + "，范围 0.2..60" },
        level: { type: "number", description: "dump 保留到哪一级：1=error 2=warn 3=info 4=debug（默认 4，全要）" },
        maxRecords: { type: "number", description: "dump 最多返回多少条，默认 " + String(DEFAULT_MAX_RECORDS) },
        timeoutMs: { type: "number", description: "Tcl 往返 / 连通道的超时毫秒数" },
        binDirs: { type: "array", description: "工具链目录候选（覆盖默认搜索路径）", items: { type: "string" } },
        envCheck: ENV_CHECK_SCHEMA,
      },
      required: ["action"],
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    output: {
      schema: outputSchema,
      render: (_args, value) => [{ type: "text", text: formatReport((value as ToolValue).report).join("\n") }],
    },
    async execute(rawArgs: unknown, exec: ToolExec): Promise<ToolValue> {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const action = typeof args.action === "string" ? args.action.trim() : "";
      const resolution = await resolveProjectDir(ctx, readString(args.projectDir), exec);
      const projectDir = resolution.projectDir;
      const notes: string[] = resolution.note === null ? [] : [resolution.note];

      if (!(ACTIONS as readonly string[]).includes(action)) {
        return failure(action === "" ? "(缺 action)" : action, projectDir, "action 必须是 start / dump / stop / status（收到：" + JSON.stringify(args.action ?? null) + "）", notes);
      }

      // 这些参数都是可选的（addr 只在 start 时必填），所以只校验"用户真的传了的"那几个：
      // validateToolArgs 会把没传的一律算缺参，直接拿全表调用会误伤 dump/stop/status。
      const passed = [
        { name: "addr", kind: "string" as const },
        { name: "banner", kind: "string" as const },
        { name: "projectDir", kind: "string" as const },
        { name: "binDirs", kind: "string[]" as const },
      ].filter((spec) => args[spec.name] !== undefined);
      const invalid = passed.length === 0 ? null : validateToolArgs(RTT_TOOL, args, passed);
      if (invalid !== null) return failure(action, projectDir, invalid, notes);

      const binDirs = Array.isArray(args.binDirs) ? (args.binDirs as string[]) : undefined;

      if (action === "start") {
        const addr = readString(args.addr);
        if (addr === undefined) return failure(action, projectDir, "start 需要 addr：控制块起始地址（十六进制，例如 0x20000000）", notes);

        const gate = await ensureToolchain(ctx, {
          capability: "debug",
          ...(binDirs === undefined ? {} : { binDirs }),
          envCheck: args.envCheck,
          signal: exec.signal,
        });
        if (!gate.ok && gate.mode === "block") {
          return failure(action, projectDir, gate.message, [...notes, ...gateReportNotes(gate)]);
        }

        const gateNotes = gateReportNotes(gate);
        let session = sessionInfo();
        if (session === null) {
          const subprocess = ctx.get<SubprocessService>("subprocess");
          if (subprocess === undefined) {
            return failure(action, projectDir, "宿主没有 subprocess 服务，起不了 openocd 会话", [...notes, ...gateNotes]);
          }
          const ensured = await ensureSession(projectDir, {
            subprocess,
            ...(binDirs === undefined ? {} : { binDirs }),
            ...(exec.agent?.id === undefined ? {} : { owner: exec.agent.id }),
          });
          if (!ensured.ok || ensured.session === null) {
            const probeError = ensured.probeError;
            const report = baseReport(action, projectDir);
            report.message = ensured.message;
            report.errors = [ensured.message];
            report.notes = [...notes, ...gateNotes];
            if (probeError !== null) report.probeError = probeError;
            return { message: ensured.message, report };
          }
          session = ensured.session;
          notes.push("没有活跃会话，先起了一个调试会话（gdb 端口 " + String(session.port) + "，tcl 端口 " + String(session.tclPort) + "）");
        } else {
          notes.push("复用已有调试会话（tcl 端口 " + String(session.tclPort) + "）");
        }

        const started = await startRtt({
          addr,
          ...(readNumber(args.size) === undefined ? {} : { size: readNumber(args.size) ?? DEFAULT_RTT_SIZE }),
          ...(readString(args.banner) === undefined ? {} : { banner: readString(args.banner) ?? "" }),
          ...(readNumber(args.rttPort) === undefined ? {} : { port: readNumber(args.rttPort) ?? DEFAULT_RTT_PORT }),
          ...(readNumber(args.timeoutMs) === undefined ? {} : { timeoutMs: readNumber(args.timeoutMs) ?? 5_000 }),
          signal: exec.signal,
        });
        const report = baseReport(action, projectDir);
        report.ok = started.ok;
        report.addr = started.addr;
        report.size = started.size;
        report.banner = started.banner;
        report.port = started.port;
        report.durationMs = started.durationMs;
        report.message = started.message;
        report.notes = [...notes, ...gateNotes, ...started.notes];
        report.errors = started.ok ? [] : [started.message];
        snapshotInto(report, rttStatus());
        if (started.probeError !== null) report.probeError = started.probeError;
        return { message: started.message, report };
      }

      if (action === "dump") {
        const dumped = await dumpRtt({
          ...(readNumber(args.seconds) === undefined ? {} : { seconds: readNumber(args.seconds) ?? DEFAULT_DUMP_SECONDS }),
          ...(readNumber(args.level) === undefined ? {} : { level: readNumber(args.level) ?? 4 }),
          ...(readNumber(args.maxRecords) === undefined ? {} : { maxRecords: readNumber(args.maxRecords) ?? DEFAULT_MAX_RECORDS }),
          ...(readNumber(args.timeoutMs) === undefined ? {} : { timeoutMs: readNumber(args.timeoutMs) ?? 3_000 }),
          signal: exec.signal,
        });
        const report = baseReport(action, projectDir);
        report.ok = dumped.ok;
        report.durationMs = dumped.durationMs;
        report.records = dumped.records;
        report.dropped = dumped.dropped;
        report.bytes = dumped.bytes;
        report.truncated = dumped.truncated;
        report.stopped = dumped.stopped;
        report.message = dumped.message;
        report.notes = [...notes, ...dumped.notes];
        report.errors = dumped.ok ? [] : [dumped.message];
        snapshotInto(report, rttStatus());
        report.port = dumped.port;
        report.addr = dumped.addr === "" ? report.addr : dumped.addr;
        if (dumped.probeError !== null) report.probeError = dumped.probeError;
        return { message: dumped.message, report };
      }

      if (action === "stop") {
        const stopped = await stopRtt();
        const report = baseReport(action, projectDir);
        report.ok = stopped.ok;
        report.durationMs = stopped.durationMs;
        report.stopped = stopped.stopped;
        report.port = stopped.port;
        report.dropped = stopped.dropped;
        report.bytes = stopped.bytes;
        report.message = stopped.message;
        report.notes = [...notes, ...stopped.notes];
        report.errors = stopped.ok ? [] : [stopped.message];
        snapshotInto(report, rttStatus());
        if (stopped.probeError !== null) report.probeError = stopped.probeError;
        return { message: stopped.message, report };
      }

      const snapshot = rttStatus();
      const report = baseReport(action, projectDir);
      report.ok = true;
      report.notes = notes;
      snapshotInto(report, snapshot);
      report.dropped = snapshot.dropped;
      report.bytes = snapshot.bytes;
      report.message = snapshot.running
        ? "RTT 在跑：控制块 " + snapshot.addr + "，通道端口 " + String(snapshot.port) + "，已收 " + String(snapshot.records) + " 条 / " + String(snapshot.bytes) + " 字节" +
          (snapshot.lastError === null ? "" : "；上次出错：" + snapshot.lastError)
        : "RTT 没在跑" + (snapshot.lastError === null ? "" : "；上次出错：" + snapshot.lastError);
      return { message: report.message, report };
    },
  });
}
