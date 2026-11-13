/**
 * 设置面板的宿主 API（Web 端）：浏览器插件 lib/client.js 用 fetch 调这里。
 *
 * 为什么走 HTTP 而不是 ctx.remote：面板只要读配置、跑探测、起安装三件事；
 * typert 的 remote 服务要另加一层协议定义与类型生成，对三个按钮的页面不值。
 * 路由由宿主 webServer 服务注册（与 dsh-market 同一做法），客户端相对 document.baseURI
 * 取路径，所以不论部署在根路径还是子路径都能用。
 *
 * 本文件分两层：
 *  - 纯函数（configSnapshot / saveConfig / probeTools / installPlan / 任务登记）—— 可离线单测；
 *  - handleWebApi 按路径分发，输入输出都是普通对象，不碰 Node 的 IncomingMessage。
 * HTTP 适配在 src/index.ts 里，保持极薄。
 */

import {
  binDirsFromConfig,
  configReadingDisabled,
  cubeMxRootsFromConfig,
  readToolchainConfig,
  toolchainConfigPath,
  updateToolchainConfig,
  type ToolchainConfig,
} from "../data/toolchain-config.js";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { resolveSearchConfig } from "../data/search-roots.js";
import { buildTargets, probeAll, type ProbeResult } from "./probe.js";
import { planOrInstallMsys2, type Msys2InstallResult } from "./msys2-install.js";
import {
  EVENT_RING_LIMIT,
  eventSessionKey,
  eventSnapshot,
  subscribeEvents,
  type DebugEvent,
} from "./event-bus.js";
import { evidenceRoot, pruneEvidence } from "./event-log.js";
import { abortAll, abortCall, listRunning } from "./progress.js";
import { channelTapStatus, setChannelTaps } from "./channel-tap.js";
import { watchRecorder } from "./watch-record.js";
import { closeSerial, listPorts, openSerial, sendSerial, serialStatus } from "./serial.js";
import { readInterrupts, setInterruptPriority } from "./interrupts.js";
import { readIocSync } from "./ioc-sync.js";
import { addWatches, clearWatches, listWatches, removeWatches } from "./watch-admin.js";
import { buildFromPanel, flashFromPanel } from "./panel-actions.js";
import { readSourceSlice } from "./source-slice.js";
import { readProbeInfo } from "./probe-info.js";
import { debugSessions } from "./debug-session.js";
import { readClockTree } from "./clocks.js";
import { readArtifacts } from "./artifacts.js";
import { decodeFault, groupFaults } from "./fault-hints.js";
import { readIocDiff, restoreIocKey, saveIocSnapshot } from "./ioc-diff.js";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { readPinout } from "./pinout.js";
import type { SubprocessService } from "../types.js";

/** 面板能看到的四类能力（与 stm32_doctor 同一口径）。 */
export interface WebCapabilities {
  build: boolean;
  flash: boolean;
  debug: boolean;
  generate: boolean;
}

export interface WebJson {
  status: number;
  body: Record<string, unknown>;
}

export interface WebApiDeps {
  /** 宿主 subprocess：版本探测与 pacman 执行均依赖该服务。 */
  subprocess: SubprocessService;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

function envOf(deps: WebApiDeps): Record<string, string | undefined> {
  return deps.env ?? process.env;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 只留非空字符串，顺带去重；用于面板传来的目录数组。null 表示不是字符串数组。 */
function stringList(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const trimmed = item.trim();
    if (trimmed === "") continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/** pacman 包名不允许以 - 开头：那会被当成选项，等于把安装变成任意标志注入。 */
function packageList(value: unknown): { ok: boolean; packages: string[]; error: string } {
  const list = stringList(value);
  if (list === null) return { ok: false, packages: [], error: "packages 必须是字符串数组" };
  for (const name of list) {
    if (name.startsWith("-")) return { ok: false, packages: [], error: "包名不能以 - 开头：" + name };
    if (/[\s"'|&;<>]/u.test(name)) return { ok: false, packages: [], error: "包名里有空白或 shell 特殊字符：" + name };
  }
  return { ok: true, packages: list, error: "" };
}

/* --------------------------- 配置读写 --------------------------- */

export interface ConfigSnapshot {
  ok: boolean;
  path: string;
  exists: boolean;
  readingDisabled: boolean;
  errors: string[];
  config: ToolchainConfig | null;
  binDirs: string[];
  cubeMxRoots: string[];
}

/** 面板打开时读取一次：配置内容，以及据此推导的 binDirs / CubeMX 根。 */
export function configSnapshot(env: Record<string, string | undefined> = process.env): ConfigSnapshot {
  const read = readToolchainConfig(env);
  return {
    ok: read.config !== null,
    path: read.path,
    exists: read.exists,
    readingDisabled: configReadingDisabled(env),
    errors: [...read.errors],
    config: read.config,
    binDirs: binDirsFromConfig(read.config),
    cubeMxRoots: cubeMxRootsFromConfig(read.config),
  };
}

export interface SaveResult {
  ok: boolean;
  error: string;
  path: string;
  config: ToolchainConfig | null;
}

/**
 * 保存面板上改过的字段。
 * 只接受认识的键，每个键都能单独缺省（缺省 = 保留原值），这样前端可以只发 diff。
 */
export function saveConfig(
  payload: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): SaveResult {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "请求体必须是 JSON 对象", path: toolchainConfigPath(env), config: null };
  }
  const patch: Partial<ToolchainConfig> = {};
  for (const key of ["msys64", "cubeMxRoot"] as const) {
    const value = payload[key];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      return { ok: false, error: key + " 必须是字符串", path: toolchainConfigPath(env), config: null };
    }
    patch[key] = value.trim();
  }
  if (payload["binDirs"] !== undefined) {
    const binDirs = stringList(payload["binDirs"]);
    if (binDirs === null) {
      return { ok: false, error: "binDirs 必须是字符串数组", path: toolchainConfigPath(env), config: null };
    }
    patch.binDirs = binDirs;
  }
  if (payload["packages"] !== undefined) {
    const packages = packageList(payload["packages"]);
    if (!packages.ok) {
      return { ok: false, error: packages.error, path: toolchainConfigPath(env), config: null };
    }
    patch.packages = packages.packages;
  }
  if (Object.keys(patch).length === 0) {
    return {
      ok: false,
      error: "没有要保存的字段（msys64 / binDirs / packages / cubeMxRoot）",
      path: toolchainConfigPath(env),
      config: null,
    };
  }
  const written = updateToolchainConfig(patch, env);
  const read = readToolchainConfig(env);
  return { ok: written.ok, error: written.error, path: written.path, config: read.config };
}

/* ----------------------------- 探测 ----------------------------- */

export interface ProbeSummary {
  ok: boolean;
  binDirs: string[];
  cubeMxRoots: string[];
  capabilities: WebCapabilities;
  missingRequired: string[];
  tools: ProbeResult[];
  message: string;
}

/** build 的 gcc/cmake/ninja 才算必需；CubeMX 两项是可选能力。 */
export function capabilitiesOf(tools: readonly ProbeResult[]): WebCapabilities {
  const has = (id: string): boolean => tools.some((tool) => tool.id === id && tool.found);
  return {
    build: has("gcc") && has("cmake") && has("ninja"),
    flash: has("openocd"),
    debug: has("openocd") && has("gdb"),
    generate: has("cubemx") && has("cubemx-java"),
  };
}

export function summarizeProbe(
  results: readonly ProbeResult[],
  config: { binDirs: string[]; cubeMxRoots: string[] },
): ProbeSummary {
  const capabilities = capabilitiesOf(results);
  const missingRequired = results.filter((item) => item.required && !item.found).map((item) => item.label);
  const found = results.filter((item) => item.found).length;
  const message =
    missingRequired.length === 0
      ? "工具链就绪：" + String(found) + "/" + String(results.length) + " 项可用，可以编译 / 烧录 / 调试"
      : "缺 " + missingRequired.join("、") + "：编译 / 烧录 / 调试会失败（CubeMX 两项只影响生成代码）";
  return {
    ok: missingRequired.length === 0,
    binDirs: config.binDirs,
    cubeMxRoots: config.cubeMxRoots,
    capabilities,
    missingRequired,
    tools: [...results],
    message,
  };
}

/** 面板点「探测工具链」：显式入参 > 环境变量 > 配置文件 > 默认值 + 自动发现。 */
export async function probeTools(
  payload: Record<string, unknown>,
  deps: WebApiDeps,
): Promise<{ ok: boolean; error: string; summary: ProbeSummary | null }> {
  const overrides: { binDirs?: string[]; cubeMxRoots?: string[] } = {};
  if (payload["binDirs"] !== undefined) {
    const binDirs = stringList(payload["binDirs"]);
    if (binDirs === null) return { ok: false, error: "binDirs 必须是字符串数组", summary: null };
    if (binDirs.length > 0) overrides.binDirs = binDirs;
  }
  if (payload["cubeMxRoot"] !== undefined) {
    if (typeof payload["cubeMxRoot"] !== "string") {
      return { ok: false, error: "cubeMxRoot 必须是字符串", summary: null };
    }
    const root = payload["cubeMxRoot"].trim();
    if (root !== "") overrides.cubeMxRoots = [root];
  }
  const config = resolveSearchConfig(envOf(deps), overrides);
  const targets = buildTargets(config);
  const options = deps.signal === undefined ? {} : { signal: deps.signal };
  const results = await probeAll(deps.subprocess, targets, config, options);
  return {
    ok: true,
    error: "",
    summary: summarizeProbe(results, { binDirs: [...config.binDirs], cubeMxRoots: [...config.cubeMxRoots] }),
  };
}

/* ----------------------------- 安装 ----------------------------- */

interface InstallTask {
  id: string;
  status: "running" | "done" | "failed";
  startedAt: number;
  finishedAt: number;
  lines: string[];
  result: Msys2InstallResult | null;
  error: string;
}

const INSTALL_LOG_LIMIT = 200;
const installTasks = new Map<string, InstallTask>();
let installSeq = 0;

function newInstallTask(): InstallTask {
  installSeq += 1;
  const id = "install-" + String(Date.now()) + "-" + String(installSeq);
  const task: InstallTask = { id, status: "running", startedAt: Date.now(), finishedAt: 0, lines: [], result: null, error: "" };
  installTasks.set(id, task);
  return task;
}

function appendLine(task: InstallTask, line: string): void {
  task.lines.push(line);
  if (task.lines.length > INSTALL_LOG_LIMIT) task.lines.splice(0, task.lines.length - INSTALL_LOG_LIMIT);
}

export interface InstallState {
  taskId: string;
  status: "running" | "done" | "failed";
  lines: string[];
  message: string;
  steps: { id: string; label: string; status: string; detail: string }[];
  ok: boolean;
  durationMs: number;
}

export function installTaskState(taskId: string): InstallState | null {
  const task = installTasks.get(taskId);
  if (task === undefined) return null;
  const result = task.result;
  const message =
    task.status === "running"
      ? "正在安装：步骤在跑，日志往下滚。"
      : task.error !== ""
        ? task.error
        : result === null
          ? ""
          : result.message;
  return {
    taskId: task.id,
    status: task.status,
    lines: [...task.lines],
    message,
    steps:
      result === null
        ? []
        : result.steps.map((step) => ({ id: step.id, label: step.label, status: step.status, detail: step.detail })),
    ok: result === null ? false : result.ok,
    durationMs: (task.finishedAt === 0 ? Date.now() : task.finishedAt) - task.startedAt,
  };
}

export interface InstallPlanResult {
  ok: boolean;
  error: string;
  plan: Msys2InstallResult | null;
}

/** 计划模式：只算大小与步骤，零副作用（不下载、不建目录、不写注册表）。 */
export async function installPlan(payload: Record<string, unknown>, deps: WebApiDeps): Promise<InstallPlanResult> {
  const request: { mode: "plan"; targetDir?: string; packages?: string[]; writePath: boolean; signal?: AbortSignal } = {
    mode: "plan",
    writePath: payload["writePath"] !== false,
  };
  if (payload["targetDir"] !== undefined) {
    if (typeof payload["targetDir"] !== "string") return { ok: false, error: "targetDir 必须是字符串", plan: null };
    request.targetDir = payload["targetDir"].trim();
  }
  if (payload["packages"] !== undefined) {
    const packages = packageList(payload["packages"]);
    if (!packages.ok) return { ok: false, error: packages.error, plan: null };
    if (packages.packages.length > 0) request.packages = packages.packages;
  }
  if (deps.signal !== undefined) request.signal = deps.signal;
  try {
    const plan = await planOrInstallMsys2(deps.subprocess, request, envOf(deps));
    return { ok: true, error: "", plan };
  } catch (error) {
    return { ok: false, error: "出计划失败：" + describeError(error), plan: null };
  }
}

/** 真装：立刻返回 taskId，安装跑在后台，面板轮询 install/state。 */
export function installStart(payload: Record<string, unknown>, deps: WebApiDeps): { ok: boolean; error: string; taskId: string } {
  if (payload["confirm"] !== true) {
    return { ok: false, error: "真装必须带 confirm:true（面板上要先点确认）", taskId: "" };
  }
  const request: {
    mode: "install";
    targetDir?: string;
    packages?: string[];
    writePath: boolean;
    signal?: AbortSignal;
    onProgress?: (line: string) => void;
  } = { mode: "install", writePath: payload["writePath"] !== false };
  if (payload["targetDir"] !== undefined) {
    if (typeof payload["targetDir"] !== "string") return { ok: false, error: "targetDir 必须是字符串", taskId: "" };
    request.targetDir = payload["targetDir"].trim();
  }
  if (payload["packages"] !== undefined) {
    const packages = packageList(payload["packages"]);
    if (!packages.ok) return { ok: false, error: packages.error, taskId: "" };
    if (packages.packages.length > 0) request.packages = packages.packages;
  }
  if (deps.signal !== undefined) request.signal = deps.signal;
  const task = newInstallTask();
  const env = envOf(deps);
  appendLine(task, "开始安装：" + new Date(task.startedAt).toLocaleTimeString());
  void planOrInstallMsys2(deps.subprocess, { ...request, onProgress: (line) => appendLine(task, line) }, env)
    .then((result) => {
      task.result = result;
      task.status = result.ok ? "done" : "failed";
      task.error = result.ok ? "" : result.message;
      appendLine(task, result.message);
    })
    .catch((error: unknown) => {
      task.status = "failed";
      task.error = "安装异常终止：" + describeError(error);
      appendLine(task, task.error);
    })
    .finally(() => {
      task.finishedAt = Date.now();
      if (installTasks.size > 20) {
        const oldest = [...installTasks.values()]
          .sort((left, right) => left.startedAt - right.startedAt)
          .slice(0, installTasks.size - 20);
        for (const item of oldest) installTasks.delete(item.id);
      }
    });
  return { ok: true, error: "", taskId: task.id };
}

/* ---------------------------- 分发 ---------------------------- */

export const WEB_API_PREFIX = "/dsh-stm32/api";

/** 模块加载时刻：用来判断运行中的进程是不是本次构建后的实例。 */
const PLUGIN_STARTED_AT = Date.now();

/**
 * 插件自检：版本、lib 构建时间、路由数。
 *
 * 面板拿到这三个值就能回答「页面功能是不是已经生效」——路由数是本次注册的数量，
 * 旧进程加载的是旧 lib，路由数与构建时间都会停在重启之前。
 */
function pluginSelfCheck(): { version: string; libMtimeMs: number; startedAt: number; routeCount: number } {
  let version = "";
  let libMtimeMs = 0;
  try {
    const text = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    version = String((JSON.parse(text) as { version?: unknown }).version ?? "");
  } catch {
    version = "";
  }
  try {
    libMtimeMs = statSync(fileURLToPath(import.meta.url)).mtimeMs;
  } catch {
    libMtimeMs = 0;
  }
  return { version, libMtimeMs, startedAt: PLUGIN_STARTED_AT, routeCount: WEB_API_PATHS.length };
}

export const WEB_API_PATHS: readonly string[] = [
  WEB_API_PREFIX + "/config",
  WEB_API_PREFIX + "/config/save",
  WEB_API_PREFIX + "/probe",
  WEB_API_PREFIX + "/install/plan",
  WEB_API_PREFIX + "/install/start",
  WEB_API_PREFIX + "/install/state",
  WEB_API_PREFIX + "/events",
  WEB_API_PREFIX + "/status",
  WEB_API_PREFIX + "/debug",
  WEB_API_PREFIX + "/debug/breakpoints",
  WEB_API_PREFIX + "/pinout",
  WEB_API_PREFIX + "/clocks",
  WEB_API_PREFIX + "/faults",
  WEB_API_PREFIX + "/artifacts",
  WEB_API_PREFIX + "/evidence",
  WEB_API_PREFIX + "/replay",
  WEB_API_PREFIX + "/evidence/prune",
  WEB_API_PREFIX + "/ioc-diff",
  WEB_API_PREFIX + "/ioc-diff/save",
  WEB_API_PREFIX + "/ioc-diff/restore",
  WEB_API_PREFIX + "/abort",
  WEB_API_PREFIX + "/channels",
  WEB_API_PREFIX + "/channels/start",
  WEB_API_PREFIX + "/channels/stop",
  WEB_API_PREFIX + "/watch-recording",
  WEB_API_PREFIX + "/watch-recording/start",
  WEB_API_PREFIX + "/watch-recording/stop",
  WEB_API_PREFIX + "/serial/send",
  WEB_API_PREFIX + "/debug/touch",
  WEB_API_PREFIX + "/interrupts",
  WEB_API_PREFIX + "/interrupts/priority",
  WEB_API_PREFIX + "/ioc-sync",
  WEB_API_PREFIX + "/watch",
  WEB_API_PREFIX + "/build",
  WEB_API_PREFIX + "/flash",
  WEB_API_PREFIX + "/source",
  WEB_API_PREFIX + "/probe-info",
  WEB_API_PREFIX + "/serial",
  WEB_API_PREFIX + "/serial/ports",
  WEB_API_PREFIX + "/serial/open",
  WEB_API_PREFIX + "/serial/close",
];

/** 证据文件最多列这么多条，面板只用来挑一个回放。 */
const EVIDENCE_FILE_LIMIT = 200;
/** 单个证据文件的读取上限：超出说明这个文件不该在面板里打开。 */
const REPLAY_MAX_BYTES = 8 * 1024 * 1024;
/** 一次回放最多载入多少条事件，与环形缓冲同量级。 */
const REPLAY_MAX_EVENTS = 5000;

/** 列证据目录下的 .jsonl，按修改时间倒序；最深到「日期 / 会话 / 文件」这一层。 */
/** 证据文件的分组键：`<日期>/<会话键>/events-….jsonl` 里的会话键。 */
export function evidenceSessionKey(filePath: string): string {
  const parts = filePath.split("/");
  return parts.length >= 3 ? parts[1] ?? "" : "";
}

/**
 * 按会话把证据文件分组（S48）。
 *
 * 目录结构已经是「日期/会话/文件」，列表却把 200 个文件平铺出来，找某个会话
 * 要自己筛。分组只做展示，文件路径仍是唯一标识。
 */
export function groupEvidenceFiles(
  files: readonly { path: string; size: number; mtimeMs: number }[],
): Array<{ key: string; bytes: number; latestMs: number; files: Array<{ path: string; size: number; mtimeMs: number }> }> {
  const groups = new Map<string, { key: string; bytes: number; latestMs: number; files: Array<{ path: string; size: number; mtimeMs: number }> }>();
  for (const file of files) {
    const key = evidenceSessionKey(file.path);
    const found = groups.get(key);
    if (found === undefined) {
      groups.set(key, { key, bytes: file.size, latestMs: file.mtimeMs, files: [file] });
      continue;
    }
    found.bytes += file.size;
    found.latestMs = Math.max(found.latestMs, file.mtimeMs);
    found.files.push(file);
  }
  return Array.from(groups.values()).sort((left, right) => right.latestMs - left.latestMs || left.key.localeCompare(right.key));
}

async function listEvidenceFiles(root: string): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
  const found: Array<{ path: string; size: number; mtimeMs: number }> = [];
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (found.length >= EVIDENCE_FILE_LIMIT || depth > 3) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= EVIDENCE_FILE_LIMIT) return;
      const relative = prefix === "" ? entry.name : prefix + "/" + entry.name;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), relative, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        const info = await stat(join(dir, entry.name));
        found.push({ path: relative, size: info.size, mtimeMs: info.mtimeMs });
      } catch {
        // 单个文件读不到就跳过，不影响其余条目。
      }
    }
  };
  await walk(resolve(root), "", 1);
  found.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return found.slice(0, EVIDENCE_FILE_LIMIT);
}

/** 把相对路径钉在证据目录内：绝对路径、`..` 与非 .jsonl 一律拒绝。 */
function evidenceTarget(root: string, relative: string): string | null {
  const trimmed = relative.trim();
  if (trimmed === "" || !trimmed.endsWith(".jsonl")) return null;
  const base = resolve(root);
  const target = resolve(base, trimmed);
  if (target === base || !target.startsWith(base + sep)) return null;
  return target;
}

/** 逐行解析 jsonl，只收形状完整的事件；坏行计入 skipped 不抛。 */
function parseEvidence(text: string): { events: DebugEvent[]; skipped: number } {
  const events: DebugEvent[] = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (events.length >= REPLAY_MAX_EVENTS) {
      skipped += 1;
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed === null || typeof parsed !== "object") {
        skipped += 1;
        continue;
      }
      const item = parsed as Record<string, unknown>;
      if (
        typeof item["seq"] !== "number" ||
        typeof item["time"] !== "string" ||
        typeof item["kind"] !== "string" ||
        typeof item["status"] !== "string" ||
        typeof item["summary"] !== "string"
      ) {
        skipped += 1;
        continue;
      }
      events.push(item as unknown as DebugEvent);
    } catch {
      skipped += 1;
    }
  }
  events.sort((left, right) => left.seq - right.seq);
  return { events, skipped };
}

function ok(body: Record<string, unknown>): WebJson {
  return { status: 200, body: { ok: true, ...body } };
}

function fail(status: number, error: string): WebJson {
  return { status, body: { ok: false, error } };
}

function parseJsonBody(text: string): { ok: boolean; value: Record<string, unknown>; error: string } {
  if (text.trim() === "") return { ok: true, value: {}, error: "" };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, value: {}, error: "请求体必须是 JSON 对象" };
    }
    return { ok: true, value: parsed as Record<string, unknown>, error: "" };
  } catch (error) {
    return { ok: false, value: {}, error: "请求体不是合法 JSON：" + describeError(error) };
  }
}

/**
 * 按路径分发。input.body 是原始文本（适配层读好的），input.query 已解析成普通对象。
 * 未知路径 404、方法不对 405：面板出错时能立刻看出是哪一层的问题。
 */
export async function handleWebApi(input: {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: string;
  deps: WebApiDeps;
}): Promise<WebJson> {
  const method = input.method.toUpperCase();
  const path = input.path.replace(/\/+$/u, "");
  const query = input.query ?? {};
  const needsBody =
    path !== WEB_API_PREFIX + "/config" &&
    path !== WEB_API_PREFIX + "/install/state" &&
    path !== WEB_API_PREFIX + "/status" &&
    path !== WEB_API_PREFIX + "/debug" &&
    path !== WEB_API_PREFIX + "/channels" &&
    path !== WEB_API_PREFIX + "/pinout" &&
    path !== WEB_API_PREFIX + "/clocks" &&
    path !== WEB_API_PREFIX + "/faults" &&
    path !== WEB_API_PREFIX + "/artifacts" &&
    path !== WEB_API_PREFIX + "/evidence" &&
    path !== WEB_API_PREFIX + "/replay" &&
    path !== WEB_API_PREFIX + "/ioc-diff" &&
    path !== WEB_API_PREFIX + "/watch-recording" &&
    path !== WEB_API_PREFIX + "/interrupts" &&
    path !== WEB_API_PREFIX + "/ioc-sync" &&
    path !== WEB_API_PREFIX + "/source" &&
    path !== WEB_API_PREFIX + "/probe-info" &&
    path !== WEB_API_PREFIX + "/serial" &&
    path !== WEB_API_PREFIX + "/serial/ports";
  // /watch 一个路径两种动词：GET 列清单、POST 改登记表。
  if (path === WEB_API_PREFIX + "/watch") {
    if (method !== "GET" && method !== "POST") return fail(405, "这个接口只接受 GET 或 POST");
  } else if (needsBody && method !== "POST") {
    return fail(405, "这个接口只接受 POST");
  } else if (!needsBody && method !== "GET") {
    return fail(405, "这个接口只接受 GET");
  }
  const parsed = needsBody || (path === WEB_API_PREFIX + "/watch" && method === "POST") ? parseJsonBody(input.body ?? "") : { ok: true, value: {} as Record<string, unknown>, error: "" };
  if (!parsed.ok) return fail(400, parsed.error);
  const env = envOf(input.deps);
  if (path === WEB_API_PREFIX + "/config") {
    return ok({ snapshot: configSnapshot(env) });
  }
  if (path === WEB_API_PREFIX + "/config/save") {
    const saved = saveConfig(parsed.value, env);
    if (!saved.ok) return fail(400, saved.error);
    return ok({ path: saved.path, config: saved.config, snapshot: configSnapshot(env) });
  }
  if (path === WEB_API_PREFIX + "/probe") {
    try {
      const probed = await probeTools(parsed.value, input.deps);
      if (!probed.ok) return fail(400, probed.error);
      return ok({ summary: probed.summary });
    } catch (error) {
      return fail(500, "探测失败：" + describeError(error));
    }
  }
  if (path === WEB_API_PREFIX + "/install/plan") {
    const planned = await installPlan(parsed.value, input.deps);
    if (!planned.ok) return fail(400, planned.error);
    return ok({ plan: planned.plan });
  }
  if (path === WEB_API_PREFIX + "/install/start") {
    const started = installStart(parsed.value, input.deps);
    if (!started.ok) return fail(400, started.error);
    return ok({ taskId: started.taskId });
  }
  if (path === WEB_API_PREFIX + "/install/state") {
    const taskId = query["taskId"] ?? "";
    if (taskId === "") return fail(400, "缺少 taskId");
    const state = installTaskState(taskId);
    if (state === null) return fail(404, "没有这个安装任务：" + taskId);
    return ok({ state });
  }
  if (path === WEB_API_PREFIX + "/debug") {
    // 调试面板用：当前调试会话、断点与观察点预算、剩余租约。只读，不碰探针。
    const report = debugSessions.status();
    return ok({
      debug: {
        active: report.active,
        sessionId: report.sessionId,
        port: report.port,
        tclPort: report.tclPort,
        projectDir: report.projectDir,
        elfPath: report.elfPath,
        remainingMs: report.remainingMs,
        idleTtlMs: report.idleTtlMs,
        hardTtlMs: report.hardTtlMs,
        breakpoints: report.breakpoints,
        watchpoints: report.watchpoints,
        hits: debugSessions.hitHistory(),
        message: report.message,
      },
    });
  }
  if (path === WEB_API_PREFIX + "/source") {
    // 源码片段：只读工程目录内的文件，给「文件:行」补上下文。
    const projectDir = typeof query["projectDir"] === "string" ? query["projectDir"] : process.cwd();
    const file = typeof query["file"] === "string" ? query["file"] : "";
    const line = Number.parseInt(typeof query["line"] === "string" ? query["line"] : "", 10);
    const context = Number.parseInt(typeof query["context"] === "string" ? query["context"] : "3", 10);
    const read = readSourceSlice(projectDir, file, Number.isFinite(line) ? line : Number.NaN, Number.isFinite(context) ? context : 3);
    if (!read.ok) return fail(400, read.error);
    return ok({ source: read.slice });
  }
  if (path === WEB_API_PREFIX + "/watch") {
    // 监视登记表：与 stm32_watch 共用同一份状态；硬件观察点要活动会话。
    if (method === "GET") return ok({ watch: listWatches() });
    const action = typeof parsed.value.action === "string" ? parsed.value.action : "";
    if (action === "add") {
      const kind = typeof parsed.value.kind === "string" ? parsed.value.kind : "value";
      const expressions = Array.isArray(parsed.value.expressions)
        ? parsed.value.expressions.filter((item): item is string => typeof item === "string")
        : [];
      const report = await addWatches({ kind, expressions });
      if (!report.ok && report.added.length === 0) return fail(409, report.message);
      return ok({ watch: report });
    }
    if (action === "remove") {
      const ids = Array.isArray(parsed.value.ids)
        ? parsed.value.ids.filter((item): item is number => typeof item === "number")
        : [];
      const report = await removeWatches(ids);
      if (!report.ok && report.removed.length === 0) return fail(404, report.message);
      return ok({ watch: report });
    }
    if (action === "clear") return ok({ watch: await clearWatches() });
    return fail(400, "action 必须是 add / remove / clear 之一");
  }
  if (path === WEB_API_PREFIX + "/build") {
    // 人在面板上点构建：不经过模型，但结果按同一种事件写进时间线。
    const projectDir = typeof parsed.value.projectDir === "string" && parsed.value.projectDir.trim() !== ""
      ? parsed.value.projectDir.trim()
      : process.cwd();
    const clean = parsed.value.clean === true;
    const target = typeof parsed.value.target === "string" ? parsed.value.target : undefined;
    const artifacts = Array.isArray(parsed.value.artifacts)
      ? parsed.value.artifacts.filter((item): item is "elf" | "hex" | "bin" => item === "elf" || item === "hex" || item === "bin")
      : undefined;
    const report = await buildFromPanel(
      { subprocess: input.deps.subprocess, env: envOf(input.deps) },
      {
        projectDir,
        ...(clean ? { clean: true } : {}),
        ...(target === undefined ? {} : { target }),
        ...(artifacts === undefined || artifacts.length === 0 ? {} : { artifacts }),
      },
    );
    return ok({ build: report });
  }
  if (path === WEB_API_PREFIX + "/flash") {
    const projectDir = typeof parsed.value.projectDir === "string" && parsed.value.projectDir.trim() !== ""
      ? parsed.value.projectDir.trim()
      : process.cwd();
    const adapterSpeed = typeof parsed.value.adapterSpeed === "number" && Number.isFinite(parsed.value.adapterSpeed)
      ? parsed.value.adapterSpeed
      : undefined;
    const report = await flashFromPanel(
      { subprocess: input.deps.subprocess, env: envOf(input.deps) },
      {
        projectDir,
        ...(adapterSpeed === undefined ? {} : { adapterSpeed }),
        ...(parsed.value.allowNoDebug === true ? { allowNoDebug: true } : {}),
      },
    );
    return ok({ flash: report });
  }
  if (path === WEB_API_PREFIX + "/ioc-sync") {
    // .ioc 与生成代码是否同步：只比修改时间，不读内容、不跑 CubeMX。
    const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
    const projectDir = requested !== "" ? requested : process.cwd();
    const read = readIocSync(projectDir);
    if (!read.ok) return fail(409, read.error);
    return ok({ iocSync: read.report });
  }
  if (path === WEB_API_PREFIX + "/probe-info") {
    // 探针信息：只读 pnputil 的 USB 枚举，不连目标、不动探针。
    const report = await readProbeInfo({
      subprocess: input.deps.subprocess,
      ...(input.deps.signal === undefined ? {} : { signal: input.deps.signal }),
    });
    return ok({ probeInfo: report });
  }
  if (path === WEB_API_PREFIX + "/interrupts/priority") {
    // 中断页改优先级：只改 NVIC.<name>_IRQn 那一条，写前备份。
    const requested = typeof parsed.value.projectDir === "string" ? parsed.value.projectDir.trim() : "";
    const name = typeof parsed.value.name === "string" ? parsed.value.name : "";
    if (name.trim() === "") return fail(400, "name 不能为空（例如 USART1）");
    const preempt = typeof parsed.value.preempt === "number" ? parsed.value.preempt : Number.NaN;
    const sub = typeof parsed.value.sub === "number" ? parsed.value.sub : Number.NaN;
    const written = setInterruptPriority(requested !== "" ? requested : process.cwd(), name, preempt, sub);
    if (!written.ok) return fail(409, written.error);
    return ok({ interruptPriority: written.report });
  }
  if (path === WEB_API_PREFIX + "/interrupts") {
    // 中断页：只读 .ioc 的 NVIC.*，不启动 CubeMX、不改配置。
    const projectDir = typeof query["projectDir"] === "string" ? query["projectDir"] : process.cwd();
    const read = readInterrupts(projectDir);
    if (!read.ok) return fail(409, read.error);
    return ok({ interrupts: read.report });
  }
  if (path === WEB_API_PREFIX + "/pinout") {
    // 引脚面板：读工程 .ioc，按外设分组。只读文件，不跑 CubeMX、不碰探针。
    const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
    const projectDir = requested !== "" ? requested : process.cwd();
    const read = readPinout(projectDir);
    if (!read.ok) return fail(409, read.error);
    return ok({ pinout: read.report });
  }
  if (path === WEB_API_PREFIX + "/clocks") {
    // 时钟页：读工程 .ioc 里 CubeMX 已经写下的各路频率，只读不改。
    const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
    const projectDir = requested !== "" ? requested : process.cwd();
    const read = readClockTree(projectDir);
    if (!read.ok) return fail(409, read.error);
    return ok({ clocks: read.report });
  }
  if (path === WEB_API_PREFIX + "/faults") {
    // 故障页：把本会话最近的失败事件按规则翻成「先看哪里」。只读事件流，不碰探针。
    const wanted = (query["session"] ?? "").trim();
    const since = Number(query["since"] ?? "0");
    const limitRaw = Number(query["limit"] ?? "50");
    const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, Math.trunc(limitRaw))) : 50;
    const failures = eventSnapshot(Number.isFinite(since) ? since : 0, wanted).filter((item) => item.status === "fail");
    const faults = failures.slice(-limit).map((item) => {
      const decoded = decodeFault(item.summary);
      return {
        seq: item.seq,
        time: item.time,
        kind: item.kind,
        summary: item.summary,
        category: decoded.category,
        hint: decoded.hint,
        rule: decoded.rule,
      };
    });
    return ok({ faults, total: failures.length, groups: groupFaults(faults) });
  }
  if (path === WEB_API_PREFIX + "/ioc-diff") {
    // 变更页：当前 .ioc 与上次基线逐键比较。只读工程文件。
    const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
    const projectDir = requested !== "" ? requested : process.cwd();
    const read = readIocDiff(projectDir, env);
    if (!read.ok) return fail(409, read.error);
    return ok({ diff: read.report });
  }
  if (path === WEB_API_PREFIX + "/ioc-diff/save") {
    // 记录基线：把当前 .ioc 复制到用户目录。只写自己的基线文件，不动工程。
    const requested = typeof parsed.value.projectDir === "string" ? parsed.value.projectDir.trim() : "";
    const projectDir = requested !== "" ? requested : process.cwd();
    const saved = saveIocSnapshot(projectDir, env);
    if (!saved.ok) return fail(409, saved.error);
    return ok({ snapshot: saved.report });
  }
  if (path === WEB_API_PREFIX + "/ioc-diff/restore") {
    // 把 baseline 里的一个键写回 .ioc：只改这一行，写前备份。
    const requested = typeof parsed.value.projectDir === "string" ? parsed.value.projectDir.trim() : "";
    const key = typeof parsed.value.key === "string" ? parsed.value.key : "";
    if (key.trim() === "") return fail(400, "key 不能为空");
    const restored = restoreIocKey(requested !== "" ? requested : process.cwd(), key, env);
    if (!restored.ok) return fail(409, restored.error);
    return ok({ restored: restored.report });
  }
  if (path === WEB_API_PREFIX + "/evidence") {
    // 回放：列出证据目录里可载入的 jsonl 文件。只读目录，不读内容。
    const root = evidenceRoot(env);
    const files = await listEvidenceFiles(root);
    const bytes = files.reduce((sum, file) => sum + file.size, 0);
    return ok({ evidence: { root, files, groups: groupEvidenceFiles(files), usage: { count: files.length, bytes } } });
  }
  if (path === WEB_API_PREFIX + "/evidence/prune") {
    // 保留策略：日期目录超过 7 天、或会话目录超过 20 个时清掉最旧的；面板也给一个手动入口。
    const pruned = await pruneEvidence({ env });
    return ok({ pruned });
  }
  if (path === WEB_API_PREFIX + "/replay") {
    // 回放：把一份证据文件读成事件数组，面板把它铺到时间线上。路径必须落在证据目录内。
    const root = evidenceRoot(env);
    const requested = typeof query["path"] === "string" ? query["path"] : "";
    const target = evidenceTarget(root, requested);
    if (target === null) return fail(400, "path 必须是证据目录下的 .jsonl 相对路径");
    try {
      const info = await stat(target);
      if (info.size > REPLAY_MAX_BYTES) {
        return fail(413, "证据文件过大（" + String(Math.round(info.size / 1024)) + " KB），不在面板里打开");
      }
      const text = await readFile(target, "utf8");
      const replay = parseEvidence(text);
      return ok({ replay: { file: requested.trim(), events: replay.events, skipped: replay.skipped } });
    } catch (error) {
      return fail(409, "读取证据失败：" + describeError(error));
    }
  }
  if (path === WEB_API_PREFIX + "/artifacts") {
    // 产物页：elf / hex / bin 的文件信息与芯片容量。只读文件属性，不起子进程。
    const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
    const projectDir = requested !== "" ? requested : process.cwd();
    const read = readArtifacts(projectDir, env);
    if (!read.ok) return fail(409, read.error);
    return ok({ artifacts: read.report });
  }
  if (path === WEB_API_PREFIX + "/debug/breakpoints") {
    // 断点面板：只放行三种动作，位置与编号在这里先校验，避免把任意 gdb 命令搬上 HTTP。
    const action = typeof parsed.value.action === "string" ? parsed.value.action : "";
    if (action !== "add" && action !== "remove" && action !== "list") {
      return fail(400, "action 必须是 add / remove / list 之一");
    }
    let command = "info breakpoints";
    if (action === "add") {
      const location = typeof parsed.value.location === "string" ? parsed.value.location.trim() : "";
      if (location === "" || location.length > 120 || !/^[A-Za-z0-9_.:$*/+\-]+$/u.test(location)) {
        return fail(400, "location 只接受符号名或 文件:行（字母、数字与 . _ : $ * / + -），长度 1–120");
      }
      command = "break " + location;
    }
    if (action === "remove") {
      const raw = parsed.value.id;
      const id = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isInteger(id) || id < 1 || id > 9999) return fail(400, "id 必须是 1–9999 的整数");
      command = "delete " + String(id);
    }
    // 参数先校验、再看会话：没有会话时，参数错误也应当得到 400 而不是一句笼统的 409。
    if (!debugSessions.isActive()) return fail(409, "当前没有调试会话（先开 stm32_debug_session）");
    const report = await debugSessions.eval({ commands: [command], keepHalted: true });
    if (!report.ok) {
      return fail(409, report.message === "" ? report.errors.join("；") : report.message);
    }
    return ok({
      breakpoints: { action, command, output: report.output, message: report.message, durationMs: report.durationMs },
    });
  }
  if (path === WEB_API_PREFIX + "/status") {
    // 面板状态条用：事件计数、当前会话键、证据目录。都是只读的诊断信息。
    const wanted = (query["session"] ?? "").trim();
    const ring = eventSnapshot(0, wanted);
    return ok({
      status: {
        eventCount: ring.length,
        latestSeq: ring.length === 0 ? 0 : (ring[ring.length - 1]?.seq ?? 0),
        sessionKey: wanted === "" ? eventSessionKey() : wanted,
        evidenceRoot: evidenceRoot(env),
        ringLimit: EVENT_RING_LIMIT,
        evidenceOverride:
          typeof env.DSH_STM32_EVIDENCE === "string" && env.DSH_STM32_EVIDENCE.trim() !== "",
        running: listRunning(wanted),
        self: pluginSelfCheck(),
      },
    });
  }
  if (path === WEB_API_PREFIX + "/channels") {
    return ok({ channels: channelTapStatus() });
  }
  if (path === WEB_API_PREFIX + "/channels/start" || path === WEB_API_PREFIX + "/channels/stop") {
    // 只认 serial / rtt 两个开关；不传就是两个都动，免得面板为「全开」多发一次请求。
    const wantOn = path.endsWith("/start");
    const picked: { serial?: boolean; rtt?: boolean } = {};
    for (const name of ["serial", "rtt"] as const) {
      const raw = parsed.value[name];
      if (raw === undefined) continue;
      if (typeof raw !== "boolean") return fail(400, name + " 必须是布尔值");
      picked[name] = wantOn ? raw : !raw;
    }
    if (Object.keys(picked).length === 0) {
      picked.serial = wantOn;
      picked.rtt = wantOn;
    }
    return ok({ channels: setChannelTaps(picked) });
  }
  if (path === WEB_API_PREFIX + "/debug/touch") {
    // 续租：只重置空闲计时，总时长上限不变（面板轮询不该无限延长一次调试）。
    if (!debugSessions.touch()) return fail(409, "当前没有调试会话（先开 stm32_debug_session）");
    return ok({ debug: debugSessions.status() });
  }
  if (path === WEB_API_PREFIX + "/serial") {
    // 面板上的串口卡片：人自己开会话，不必先让 AI 调 stm32_serial。
    const status = await serialStatus({ env });
    return ok({
      serial: {
        open: status.open,
        sessionId: status.session?.sessionId ?? "",
        port: status.session?.port ?? "",
        baudRate: status.session?.settings.baudRate ?? 0,
        bridgePid: status.bridge.pid,
        bridgeAlive: status.bridge.alive,
        message: status.message,
        notes: status.notes,
      },
    });
  }
  if (path === WEB_API_PREFIX + "/serial/ports") {
    const listed = await listPorts({ env });
    return ok({
      serialPorts: {
        ok: listed.ok,
        ports: listed.ports.map((port) => ({ port: port.port, description: port.description, vid: port.vid, pid: port.pid })),
        message: listed.message,
      },
    });
  }
  if (path === WEB_API_PREFIX + "/serial/open") {
    const port = parsed.value.port;
    if (port !== undefined && typeof port !== "string") return fail(400, "port 必须是字符串（例如 COM3）");
    const baudRate = parsed.value.baudRate;
    if (baudRate !== undefined && (typeof baudRate !== "number" || !Number.isFinite(baudRate))) {
      return fail(400, "baudRate 必须是数字（例如 115200）");
    }
    const opened = await openSerial({
      ...(typeof port === "string" && port.trim() !== "" ? { port: port.trim() } : {}),
      ...(typeof baudRate === "number" ? { baudRate } : {}),
      env,
    });
    return ok({
      serial: {
        ok: opened.ok,
        message: opened.message,
        notes: opened.notes,
        sessionId: opened.session?.sessionId ?? "",
        port: opened.session?.port ?? "",
        bridgePid: opened.bridge.pid,
      },
    });
  }
  if (path === WEB_API_PREFIX + "/serial/close") {
    const force = parsed.value.force;
    if (force !== undefined && typeof force !== "boolean") return fail(400, "force 必须是布尔值");
    const closed = await closeSerial({ ...(force === true ? { force: true } : {}), env });
    return ok({
      serial: {
        ok: closed.ok,
        closed: closed.closed,
        forced: closed.forced,
        message: closed.message,
        notes: closed.notes,
      },
    });
  }
  if (path === WEB_API_PREFIX + "/serial/send") {
    // 面板直接发一行：与 stm32_serial action=send 同一条桥命令，只是入口在人这边。
    const text = parsed.value.text;
    if (typeof text !== "string") return fail(400, "text 必须是字符串（空串表示只发换行）");
    const newline = parsed.value.newline;
    if (newline !== undefined && newline !== "crlf" && newline !== "lf" && newline !== "none") {
      return fail(400, "newline 只能是 crlf / lf / none");
    }
    const raw = parsed.value.raw;
    if (raw !== undefined && typeof raw !== "boolean") return fail(400, "raw 必须是布尔值");
    const sent = await sendSerial({
      text,
      ...(newline === undefined ? {} : { newline }),
      ...(raw === true ? { raw: true } : {}),
      env,
    });
    const payload = {
      ok: sent.ok,
      id: sent.id,
      bytes: sent.bytes,
      ackMs: sent.ackMs,
      message: sent.message,
    };
    if (!sent.ok && sent.session === null) return fail(409, sent.message);
    return ok({ serial: payload });
  }
  if (path === WEB_API_PREFIX + "/watch-recording") {
    return ok({ watchRecording: watchRecorder.status() });
  }
  if (path === WEB_API_PREFIX + "/watch-recording/start" || path === WEB_API_PREFIX + "/watch-recording/stop") {
    if (path.endsWith("/stop")) return ok({ watchRecording: watchRecorder.stop() });
    const raw = parsed.value.intervalMs;
    if (raw !== undefined) {
      // 夹紧放在录制器里，这里只拒掉明显不是「毫秒数」的输入。
      if (typeof raw !== "number" || !Number.isFinite(raw) || Math.trunc(raw) !== raw) {
        return fail(400, "intervalMs 必须是 500–60000 的整数（毫秒）");
      }
      if (raw < 500 || raw > 60_000) {
        return fail(400, "intervalMs 必须是 500–60000 的整数（毫秒）");
      }
    }
    const started = watchRecorder.start(raw === undefined ? {} : { intervalMs: raw });
    return ok({ watchRecording: started });
  }
  if (path === WEB_API_PREFIX + "/abort") {
    // 面板「中止」：只中止登记过的在途调用，不碰调试会话与后台 job。
    const callId = typeof parsed.value.callId === "string" ? parsed.value.callId.trim() : "";
    const all = parsed.value.all === true;
    const session = typeof parsed.value.session === "string" ? parsed.value.session.trim() : "";
    if (callId === "" && !all) return fail(400, "callId 不能为空（全部中止请传 all: true）");
    if (callId !== "") {
      const aborted = abortCall(callId);
      if (aborted === null) return fail(404, "没有这条在途调用：" + callId);
      return ok({ abort: { count: 1, calls: [aborted] } });
    }
    const count = abortAll(session);
    return ok({ abort: { count, calls: [] } });
  }
  return fail(404, "没有这个接口：" + path);
}

/** 单测用：清空安装任务表。 */
export function resetInstallTasks(): void {
  installTasks.clear();
}

/* ------------------------------ 事件流 ------------------------------ */

/** 事件流的路径（SSE，长连接，不用 JSON 分发器）。 */
export const EVENT_STREAM_PATH = WEB_API_PREFIX + "/events";

/** 心跳间隔：反代与浏览器都会掐掉长时间无数据的连接。 */
const EVENT_HEARTBEAT_MS = 15_000;

function writeEvent(response: any, event: DebugEvent): void {
  if (typeof response.write !== "function") return;
  response.write("id: " + String(event.seq) + "\n");
  response.write("data: " + JSON.stringify(event) + "\n\n");
}

/**
 * 打开一条事件流：先补发 since 之后的存量事件，再持续推送新事件。
 *
 * 返回停止函数；请求方断开时自动停止，调用方也可显式停止。
 * 这里直接写原始 response，交给 registerWebRoutes 注册，不走 handleWebApi 的 JSON 分发。
 */
export function openEventStream(
  request: any,
  response: any,
  options: { since?: number; session?: string; heartbeatMs?: number } = {},
): () => void {
  let closed = false;
  let unsubscribe: () => void = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stop = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe();
    if (heartbeat !== undefined) clearInterval(heartbeat);
    if (typeof response.end === "function") {
      try {
        response.end();
      } catch {
        // 对端已断开，忽略。
      }
    }
  };
  if (typeof response.writeHead === "function") {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
  }
  if (typeof response.write === "function") response.write(": connected\n\n");
  const since = typeof options.since === "number" && Number.isFinite(options.since) ? options.since : 0;
  const wanted = (options.session ?? "").trim();
  for (const event of eventSnapshot(since, wanted)) writeEvent(response, event);
  unsubscribe = subscribeEvents((event) => {
    if (closed) return;
    // 带 session 的订阅只推本会话事件：多标签页同时开着时各看各的。
    if (wanted !== "" && event.session !== wanted) return;
    writeEvent(response, event);
  });
  heartbeat = setInterval(() => {
    if (closed) return;
    if (typeof response.write === "function") response.write(": ping\n\n");
  }, options.heartbeatMs ?? EVENT_HEARTBEAT_MS);
  if (typeof heartbeat.unref === "function") heartbeat.unref();
  if (typeof request?.on === "function") {
    request.on("close", stop);
    request.on("error", stop);
  }
  return stop;
}
