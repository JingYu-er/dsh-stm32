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
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { evidencePolicy, evidenceRoot, pruneEvidence } from "./event-log.js";
import { readProjectConf, readWorkspaceIndex, scanWorkspaceProjects } from "./project-conf.js";
import { resolveProjectLayout } from "./project-layout.js";
import { applyLayoutFix, planLayoutFix } from "./project-repair.js";
import { runCapture } from "./subprocess-runner.js";
import {
  backupBoardFile,
  buildHandSyncScript,
  parseHandSyncOutput,
  planHandSync,
} from "./ecad/pcb/hand-sync.js";
import { abortAll, abortCall, listRunning } from "./progress.js";
import { channelTapStatus, setChannelTaps } from "./channel-tap.js";
import { watchRecorder } from "./watch-record.js";
import { agentOfSession } from "./session-context.js";
import { closeSerial, listPorts, openSerial, sendSerial, serialStatus } from "./serial.js";
import { readInterrupts, setInterruptPriorities, setInterruptPriority } from "./interrupts.js";
import { readIocSync } from "./ioc-sync.js";
import { addWatches, clearWatches, listWatches, removeWatches } from "./watch-admin.js";
import { buildFromPanel, flashFromPanel } from "./panel-actions.js";
import { readSourceSlice } from "./source-slice.js";
import { readProbeInfo } from "./probe-info.js";
import { debugSessions } from "./debug-session.js";
import { readClockTree } from "./clocks.js";
import { readArtifacts } from "./artifacts.js";
import { decodeFault, groupFaults } from "./fault-hints.js";
import { readIocDiff, readIocKeysForPin, restoreAllIocKeys, restoreIocKey, saveIocSnapshot } from "./ioc-diff.js";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { readPinout } from "./pinout.js";
import { findRootSchematic, readSchematic } from "./schematic/model.js";
import { checkSchematic } from "./schematic/checks.js";
import { findLatestKicadBuild, listCircuitEntries, planEcadWorkspace, runTsciBuild } from "./ecad/tsci.js";
import { exportEmbeddedLibraries } from "./ecad/libs.js";
import { exportStep, runDrc, runErc } from "./ecad/checks.js";
import { checkDfm, writeDru } from "./ecad/dfm.js";
import { exportFabrication } from "./ecad/fabrication.js";
import { packageHardware, verifyPackage } from "./ecad/package.js";
import { locateEcadToolchain } from "./ecad/toolchain.js";
import { readPcbScene } from "./ecad/pcb/scene.js";
import { connectPcbIpc, runPcbIpc } from "./ecad/pcb/ipc.js";
import { renderPcbSvg } from "./ecad/pcb/pcb-svg.js";
import { applyQuotes, readBom } from "./ecad/bom.js";
import { analyzeStackup, DEFAULT_TARGETS } from "./ecad/pcb/stackup.js";
import { analyzeEmc } from "./ecad/pcb/emc.js";
import { readEmcDeep } from "./ecad/pcb/emc-deep.js";
import { readLinks } from "./ecad/pcb/links.js";
import { editStorePath, readSchEdits, replaySchEditsTo, writeSchEdits } from "./schematic/edit.js";
import { readGerberSet } from "./ecad/pcb/gerber.js";
import { EMPTY_RENDER3D, renderBoard3d } from "./ecad/pcb/render3d.js";
import { suggestModelFixes } from "./ecad/pcb/model-fix.js";
import { analyzePowerBudget } from "./ecad/pcb/power.js";
import { collectBriefFacts, writeBriefs } from "./ecad/brief.js";
import { readImpedancePlan } from "./ecad/pcb/impedance.js";
import { checkNetGate, netGateSummary } from "./ecad/netgate.js";
import { readMech, writeMechDxf } from "./ecad/pcb/mech.js";
import { readCircuitNetlist } from "./ecad/pcb/netlist.js";
import { ensurePrices, priceCachePath, readPriceCache } from "./datasheet/price.js";
import { searchParts, searchCachePath } from "./datasheet/search.js";
import { runEcadDesign } from "./ecad/design.js";
import { readAutoState, writeAutoState } from "./ecad/autobuild.js";
import { ecadRuntimeDir, runtimeBytes, runtimeInstallMode, runtimeReady } from "./ecad/runtime.js";
import { runSchematicReview } from "./schematic/review.js";
import { datasheetStatus, ensureProjectDatasheets } from "./datasheet/auto.js";
import { krtRoot, krtStatus, krtVersion } from "./ecad/pcb/krt.js";
import { cacheBytes, datasheetCacheDir } from "./datasheet/store.js";
import { findIocFile } from "./generate.js";
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
/** 工程类接口缺 projectDir 时的统一提示：不再回落到进程工作目录（S84）。 */
const PROJECT_DIR_REQUIRED = "projectDir 不能为空：从工具栏「工程」下拉里选一个，或先打开调试会话";

/**
 * 会话工作目录解析器（S84）：宿主 `workingDirectory` 服务由 `src/index.ts` 注入。
 * 面板没传 projectDir 时先问它，避免把插件进程的 profile 目录当成工程。
 */
let sessionWorkspaceResolver: ((sessionId: string) => Promise<string>) | null = null;

export function setSessionWorkspaceResolver(
  resolver: ((sessionId: string) => Promise<string>) | null,
): void {
  sessionWorkspaceResolver = resolver;
}

/**
 * 请求会话对应的 agent id（S91）：调试会话记的是启动它的 agent id，
 * 面板请求带的是会话 id，两者要对上才允许看／改这条调试会话。
 */
function callerAgentIdOf(sessionId: string): string {
  if (sessionId === "") return "";
  const agent = agentOfSession(sessionId) as { id?: unknown } | undefined;
  if (agent === undefined || agent === null) return "";
  return typeof agent.id === "string" ? agent.id : "";
}

/**
 * 调试会话归属判定（S91）：owner 是启动它的 agent id，请求里带的是会话 id。
 * 两边都查得到且不相等才算「别人的」；查不到时不拦，保持老行为。
 */
export function debugSessionForeign(sessionId: string, owner: string): boolean {
  if (sessionId === "" || owner === "") return false;
  const mine = callerAgentIdOf(sessionId);
  if (mine === "") return false;
  return owner !== mine;
}

/** 当前调试会话是否属于另一条会话：是则面板不能把它当成自己的。 */
function isForeignDebugSession(sessionId: string): boolean {
  return debugSessionForeign(sessionId, debugSessions.status().owner);
}

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
  WEB_API_PREFIX + "/ioc-diff/restore-all",
  WEB_API_PREFIX + "/ioc-keys",
  WEB_API_PREFIX + "/abort",
  WEB_API_PREFIX + "/channels",
  WEB_API_PREFIX + "/channels/start",
  WEB_API_PREFIX + "/channels/stop",
  WEB_API_PREFIX + "/watch-recording",
  WEB_API_PREFIX + "/watch-recording/start",
  WEB_API_PREFIX + "/watch-recording/stop",
  WEB_API_PREFIX + "/serial/send",
  WEB_API_PREFIX + "/debug/touch",
  WEB_API_PREFIX + "/debug/stop",
  WEB_API_PREFIX + "/interrupts",
  WEB_API_PREFIX + "/interrupts/priority",
  WEB_API_PREFIX + "/interrupts/priorities",
  WEB_API_PREFIX + "/ioc-sync",
  WEB_API_PREFIX + "/watch",
  WEB_API_PREFIX + "/build",
  WEB_API_PREFIX + "/projects",
  WEB_API_PREFIX + "/flash",
  WEB_API_PREFIX + "/source",
  WEB_API_PREFIX + "/probe-info",
  WEB_API_PREFIX + "/serial",
  WEB_API_PREFIX + "/serial/ports",
  WEB_API_PREFIX + "/serial/open",
  WEB_API_PREFIX + "/serial/close",
  WEB_API_PREFIX + "/schematic",
  WEB_API_PREFIX + "/schematic/review",
  WEB_API_PREFIX + "/ecad",
  // 板图要单独登记：host 只给 WEB_API_PATHS 里的路径注册 handler，没登记就是 404。
  WEB_API_PREFIX + "/ecad/pcb",
  WEB_API_PREFIX + "/ecad/bom",
  WEB_API_PREFIX + "/ecad/stackup",
  WEB_API_PREFIX + "/ecad/emc",
  WEB_API_PREFIX + "/ecad/links",
  WEB_API_PREFIX + "/ecad/gerber",
  WEB_API_PREFIX + "/ecad/render3d",
  WEB_API_PREFIX + "/ecad/power",
  WEB_API_PREFIX + "/ecad/brief",
  WEB_API_PREFIX + "/ecad/impedance",
  WEB_API_PREFIX + "/ecad/netgate",
  WEB_API_PREFIX + "/schematic/edit",
  WEB_API_PREFIX + "/schematic/sync",
  WEB_API_PREFIX + "/ecad/mech",
  // 器件搜索也要单独登记（S163）：GET /ecad/parts?q=… 直接查立创，不依赖工程。
  WEB_API_PREFIX + "/ecad/parts",
  WEB_API_PREFIX + "/ecad/ipc",
  WEB_API_PREFIX + "/ecad/action",
  WEB_API_PREFIX + "/layout",
];

/** 面板要看的库清单：封装按 .pretty 目录数封装，符号按 .kicad_sym 里的符号数。 */
async function scanEcadLibs(libsDir: string): Promise<{ footprints: Array<{ lib: string; count: number }>; symbols: Array<{ lib: string; count: number }> }> {
  const footprints: Array<{ lib: string; count: number }> = [];
  const symbols: Array<{ lib: string; count: number }> = [];
  try {
    for (const name of await readdir(join(libsDir, "footprints"))) {
      if (!name.endsWith(".pretty")) continue;
      const files = await readdir(join(libsDir, "footprints", name));
      footprints.push({ lib: name.slice(0, -".pretty".length), count: files.filter((file) => file.endsWith(".kicad_mod")).length });
    }
  } catch {
    // 还没导出过库：空列表即正确状态。
  }
  try {
    for (const name of await readdir(join(libsDir, "symbols"))) {
      if (!name.endsWith(".kicad_sym")) continue;
      const text = await readFile(join(libsDir, "symbols", name), "utf8");
      const count = (text.match(/\(symbol\s+"/gu) ?? []).length;
      symbols.push({ lib: name.slice(0, -".kicad_sym".length), count: count });
    }
  } catch {
    // 同上。
  }
  return { footprints: footprints, symbols: symbols };
}

/** 面板要看的导出产物：out 根目录下的文件 + gerbers 目录里的文件数。 */
async function scanEcadArtifacts(outDir: string): Promise<Array<{ name: string; bytes: number }>> {
  const artifacts: Array<{ name: string; bytes: number }> = [];
  try {
    for (const name of await readdir(outDir)) {
      const info = await stat(join(outDir, name));
      if (!info.isFile()) continue;
      artifacts.push({ name: name, bytes: info.size });
    }
  } catch {
    // 还没导出过：空列表即正确状态。
  }
  try {
    const gerbers = await readdir(join(outDir, "gerbers"));
    artifacts.push({ name: "gerbers/（" + String(gerbers.length) + " 个文件）", bytes: 0 });
  } catch {
    // 没有 gerbers 目录时不列。
  }
  return artifacts;
}

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
  // 请求里的会话 id 决定用哪条会话的工作目录（S91）。缺省或查不到时解析为空串，
  // 由路由回 400 说明缺什么——不回落到「最近一个 agent」或进程工作目录，
  // 否则在别的工作区打开调试台会看到本工作区的工程。
  const requestSession = typeof (input.query ?? {})["session"] === "string"
    ? ((input.query ?? {})["session"] as string).trim()
    : "";
  let sessionDir = "";
  if (sessionWorkspaceResolver !== null && requestSession !== "") {
    try {
      sessionDir = (await sessionWorkspaceResolver(requestSession)).trim();
    } catch {
      sessionDir = "";
    }
  }
  // 兜底顺序（S91）：显式 projectDir → 本会话工作目录 → 空（由路由回 400）。
  const withProject = (raw: string): string => {
    const trimmed = raw.trim();
    if (trimmed !== "") return trimmed;
    return sessionDir;
  };
  /**
   * 程序目录（S95）：工程根可能把程序放在 `program/` 或 `firmware/` 下。
   *
   * 读 `.ioc`、跑构建、烧录都应以程序目录为准；工程根仍用于「选工程」与原理图。
   */
  const firmwareProject = (raw: string): string => {
    const root = withProject(raw);
    if (root === "") return "";
    return resolveProjectLayout(root).firmwareDir;
  };
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
    path !== WEB_API_PREFIX + "/ioc-keys" &&
    path !== WEB_API_PREFIX + "/watch-recording" &&
    path !== WEB_API_PREFIX + "/interrupts" &&
    path !== WEB_API_PREFIX + "/ioc-sync" &&
    path !== WEB_API_PREFIX + "/source" &&
    path !== WEB_API_PREFIX + "/probe-info" &&
    path !== WEB_API_PREFIX + "/serial" &&
    path !== WEB_API_PREFIX + "/serial/ports" &&
    path !== WEB_API_PREFIX + "/schematic" &&
    path !== WEB_API_PREFIX + "/ecad" &&
    path !== WEB_API_PREFIX + "/ecad/pcb" &&
    path !== WEB_API_PREFIX + "/ecad/bom" &&
    path !== WEB_API_PREFIX + "/ecad/stackup" &&
    path !== WEB_API_PREFIX + "/ecad/emc" &&
    path !== WEB_API_PREFIX + "/ecad/links" &&
    path !== WEB_API_PREFIX + "/ecad/gerber" &&
    path !== WEB_API_PREFIX + "/ecad/render3d" &&
    path !== WEB_API_PREFIX + "/ecad/power" &&
    path !== WEB_API_PREFIX + "/ecad/brief" &&
    path !== WEB_API_PREFIX + "/ecad/impedance" &&
    path !== WEB_API_PREFIX + "/ecad/netgate" &&
    path !== WEB_API_PREFIX + "/ecad/mech" &&
    path !== WEB_API_PREFIX + "/ecad/parts" &&
    path !== WEB_API_PREFIX + "/ecad/ipc" &&
    path !== WEB_API_PREFIX + "/projects";
  // /watch 与 /ecad/brief 一个路径两种动词：GET 读、POST 写（改登记表 / 生成文档）。
  if (path === WEB_API_PREFIX + "/watch" || path === WEB_API_PREFIX + "/ecad/brief" || path === WEB_API_PREFIX + "/ecad/mech" || path === WEB_API_PREFIX + "/ecad/impedance" || path === WEB_API_PREFIX + "/schematic/edit" || path === WEB_API_PREFIX + "/schematic/sync") {
    if (method !== "GET" && method !== "POST") return fail(405, "这个接口只接受 GET 或 POST");
  } else if (needsBody && method !== "POST") {
    return fail(405, "这个接口只接受 POST");
  } else if (!needsBody && method !== "GET") {
    return fail(405, "这个接口只接受 GET");
  }
  const twoVerb = (path === WEB_API_PREFIX + "/watch" || path === WEB_API_PREFIX + "/ecad/brief" || path === WEB_API_PREFIX + "/ecad/mech" || path === WEB_API_PREFIX + "/ecad/impedance" || path === WEB_API_PREFIX + "/schematic/edit" || path === WEB_API_PREFIX + "/schematic/sync") && method === "POST";
  const parsed = needsBody || twoVerb ? parseJsonBody(input.body ?? "") : { ok: true, value: {} as Record<string, unknown>, error: "" };
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
    if (isForeignDebugSession(requestSession)) {
      // 别的会话在调试：这条会话的面板看不到它的工程与输出，避免跨会话串信息（S91）。
      return ok({
        debug: {
          active: false,
          sessionId: "",
          port: 0,
          tclPort: 0,
          projectDir: "",
          elfPath: "",
          remainingMs: 0,
          idleTtlMs: 0,
          hardTtlMs: 0,
          breakpoints: [],
          watchpoints: [],
          hits: [],
          outputs: [],
          foreign: true,
          message: "调试会话由另一条会话启动，这条会话看不到它的工程与输出",
        },
      });
    }
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
        outputs: debugSessions.recentTraces(),
        message: report.message,
      },
    });
  }
  if (path === WEB_API_PREFIX + "/source") {
    // 源码片段：只读工程目录内的文件，给「文件:行」补上下文。
    // 源码在程序目录下（program/Core、fw/Core），不是工程根（S129）。
    const projectDir = firmwareProject(typeof query["projectDir"] === "string" ? query["projectDir"] : "");
    if (projectDir === "") return fail(400, PROJECT_DIR_REQUIRED);
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
    // cmake 在程序目录里跑，工程根上没有 CMakeLists.txt（S129）。
    const projectDir = firmwareProject(typeof parsed.value.projectDir === "string"
      ? parsed.value.projectDir
      : "");
    if (projectDir === "") return fail(400, PROJECT_DIR_REQUIRED);
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
    const projectDir = firmwareProject(typeof parsed.value.projectDir === "string"
      ? parsed.value.projectDir
      : "");
    if (projectDir === "") return fail(400, PROJECT_DIR_REQUIRED);
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
  if (path === WEB_API_PREFIX + "/projects") {
    // 工程选择器（S82）：工作区索引 + 现场扫描合并，附当前工程描述。
    const rootParam = typeof query["root"] === "string" ? query["root"].trim() : "";
    const projectParam = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
    const workspaceRoot = rootParam !== ""
      ? rootParam
      : (projectParam !== "" ? dirname(resolve(projectParam)) : sessionDir);
    if (workspaceRoot === "") {
      // 没有会话工作目录就没有可列的工作区：宁可空列表，也不猜一个别的工作区（S91）。
      return ok({
        projects: {
          workspaceRoot: "",
          confPath: "",
          hasConf: false,
          entries: [],
          current: null,
          note: "没有可用的会话工作目录：先在这条会话里调用一次 STM32 工具，或从工具栏「工程」下拉里选一个工程",
        },
      });
    }
    const index = readWorkspaceIndex(workspaceRoot);
    const scanned = scanWorkspaceProjects(workspaceRoot);
    const seen = new Set(index.projects.map((item) => item.dir));
    const merged = [...index.projects];
    for (const item of scanned) {
      if (seen.has(item.dir)) continue;
      seen.add(item.dir);
      merged.push(item);
    }
    const current = projectParam !== "" ? readProjectConf(projectParam) : null;
    return ok({
      projects: {
        workspaceRoot: index.workspaceRoot,
        confPath: index.confPath,
        hasConf: index.exists,
        entries: merged.slice(0, 50),
        current,
      },
    });
  }
  if (path === WEB_API_PREFIX + "/ioc-sync") {
    // .ioc 与生成代码是否同步：只比修改时间，不读内容、不跑 CubeMX。
    const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
    const projectDir = firmwareProject(requested);
    if (projectDir === "") return fail(400, PROJECT_DIR_REQUIRED);
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
  if (path === WEB_API_PREFIX + "/interrupts/priorities") {
    // 批量改优先级（S74）：一次备份、一次写盘，逐路返回结果。
    const requested = typeof parsed.value.projectDir === "string" ? parsed.value.projectDir.trim() : "";
    const names = Array.isArray(parsed.value.names) ? parsed.value.names.filter((name) => typeof name === "string") : [];
    if (names.length === 0) return fail(400, "names 不能为空（要改的中断名数组）");
    const preempt = typeof parsed.value.preempt === "number" ? parsed.value.preempt : Number.NaN;
    const sub = typeof parsed.value.sub === "number" ? parsed.value.sub : Number.NaN;
    const dir = firmwareProject(requested);
    if (dir === "") return fail(400, PROJECT_DIR_REQUIRED);
    const written = setInterruptPriorities(dir, names, preempt, sub);
    if (!written.ok) return fail(409, written.error);
    return ok({ interruptPriorities: written.report });
  }
  if (path === WEB_API_PREFIX + "/interrupts/priority") {
    // 中断页改优先级：只改 NVIC.<name>_IRQn 那一条，写前备份。
    const requested = typeof parsed.value.projectDir === "string" ? parsed.value.projectDir.trim() : "";
    const name = typeof parsed.value.name === "string" ? parsed.value.name : "";
    if (name.trim() === "") return fail(400, "name 不能为空（例如 USART1）");
    const preempt = typeof parsed.value.preempt === "number" ? parsed.value.preempt : Number.NaN;
    const sub = typeof parsed.value.sub === "number" ? parsed.value.sub : Number.NaN;
    const dir = firmwareProject(requested);
    if (dir === "") return fail(400, PROJECT_DIR_REQUIRED);
    const written = setInterruptPriority(dir, name, preempt, sub);
    if (!written.ok) return fail(409, written.error);
    return ok({ interruptPriority: written.report });
  }
  if (path === WEB_API_PREFIX + "/interrupts") {
    // 中断页：只读 .ioc 的 NVIC.*，不启动 CubeMX、不改配置。
    // 读的是 .ioc，所以要走程序目录而不是工程根——.ioc 常放在 fw/、program/ 之下（S129）。
    const projectDir = firmwareProject(typeof query["projectDir"] === "string" ? query["projectDir"] : "");
    if (projectDir === "") return fail(400, PROJECT_DIR_REQUIRED);
    const read = readInterrupts(projectDir);
    if (!read.ok) return fail(409, read.error);
    return ok({ interrupts: read.report });
  }
  if (path === WEB_API_PREFIX + "/pinout") {
    // 引脚面板：读工程 .ioc，按外设分组。只读文件，不跑 CubeMX、不碰探针。
    const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
    const projectDir = firmwareProject(requested);
    if (projectDir === "") return fail(400, PROJECT_DIR_REQUIRED);
    const read = readPinout(projectDir, env);
    if (!read.ok) return fail(409, read.error);
    return ok({ pinout: read.report });
  }
  if (path === WEB_API_PREFIX + "/schematic/review") {
    // 原理图一键评审：读图 → 规则检查 → 配置草案，只读不写盘（S135）。
    const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
    const projectDir = withProject(requested);
    if (projectDir === "") return fail(400, PROJECT_DIR_REQUIRED);
    const rootFile = typeof query["rootFile"] === "string" ? query["rootFile"].trim() : "";
    return ok({ review: runSchematicReview({ projectDir, ...(rootFile === "" ? {} : { rootFile }) }) });
  }

  if (path === WEB_API_PREFIX + "/schematic") {
    // 原理图页：读 KiCad 工程，给模块框图与检查结果；只读文件，不碰探针。
    const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
    const projectDir = withProject(requested);
    if (projectDir === "") return fail(400, PROJECT_DIR_REQUIRED);
    const layout = resolveProjectLayout(projectDir);
    const hardwareDir = layout.hardwareDir;
    if (hardwareDir === "") {
      return fail(404, "工程里没有 KiCad 原理图：把 KiCad 工程放到 hardware/ 下，或在 dsh-stm32.conf 里写 hardware=目录名");
    }
    const rootFile = findRootSchematic(hardwareDir);
    if (rootFile === null || rootFile === "") return fail(404, `硬件目录里没有 .kicad_sch：${hardwareDir}`);
    let schematic: ReturnType<typeof readSchematic>;
    try {
      schematic = readSchematic(rootFile);
    } catch (error) {
      return fail(409, `原理图解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const report = schematic.report;
    // PCB 对账跟着工程走：目录里有 .kicad_pcb 就一起对，没有就只查原理图本身。
    const pcbName = (await readdir(hardwareDir)).find((name) => name.endsWith(".kicad_pcb")) ?? "";
    const iocFile = findIocFile(layout.firmwareDir);
    const check = checkSchematic(report, {
      ...(pcbName === "" ? {} : { pcbFile: join(hardwareDir, pcbName) }),
      ...(iocFile === null ? {} : { iocFile }),
    });
    return ok({
      schematic: {
        rootFile: report.rootFile,
        version: report.version,
        generator: report.generator,
        sheets: report.sheets,
        components: report.components.length,
        nets: report.nets.length,
        mcu: report.mcu === null ? null : { ref: report.mcu.ref, value: report.mcu.value, pins: report.mcu.pins },
        pinIndex: report.components.flatMap((component) =>
          component.pins.map((pin) => ({ ref: component.ref, pin: pin.number, name: pin.name, net: pin.net })),
        ),
        diagram: report.diagram,
        warnings: report.warnings,
        findings: check.findings,
        summary: check.summary,
        pcb: check.pcb,
        layout: { projectDir: layout.projectDir, firmwareDir: layout.firmwareDir, hardwareDir: layout.hardwareDir, notes: layout.notes },
      },
    });
  }
  if (path === WEB_API_PREFIX + "/ecad") {
    // 电路设计页：只报工作区状态（有没有初始化、依赖装没装、最近一次构建、导出的 STEP）。
    // 构建与检查要跑子进程，留在工具里由模型显式触发，面板不替用户做决定。
    const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
    const projectDir = withProject(requested);
    if (projectDir === "") return fail(400, PROJECT_DIR_REQUIRED);
    const layout = resolveProjectLayout(projectDir);
    const workspace = planEcadWorkspace(projectDir, layout.hardwareDir);
    const installed = existsSync(join(workspace.circuitDir, "node_modules", "tscircuit"));
    const latest = findLatestKicadBuild(workspace);
    const steps: Array<{ name: string; bytes: number; mtimeMs: number }> = [];
    try {
      const names = await readdir(workspace.outDir);
      for (const name of names) {
        if (!name.toLowerCase().endsWith(".step")) continue;
        const info = await stat(join(workspace.outDir, name));
        steps.push({ name, bytes: info.size, mtimeMs: info.mtimeMs });
      }
    } catch {
      // 还没导出过 STEP：空列表就是正确状态。
    }
    steps.sort((left, right) => right.mtimeMs - left.mtimeMs);
    return ok({
      ecad: {
        workspace: {
          projectDir: workspace.projectDir,
          root: workspace.root,
          circuitDir: workspace.circuitDir,
          kicadDir: workspace.kicadDir,
          libsDir: workspace.libsDir,
          outDir: workspace.outDir,
        },
        initialized: existsSync(join(workspace.circuitDir, "package.json")),
        installed,
        entries: listCircuitEntries(workspace.circuitDir),
        latest: latest.ok
          ? { ok: true, error: "", kicadDir: latest.kicadDir, pcbFile: latest.pcbFile, schematicFile: latest.schematicFile }
          : { ok: false, error: latest.error, kicadDir: "", pcbFile: "", schematicFile: "" },
        steps: steps.slice(0, 20),
        libs: await scanEcadLibs(workspace.libsDir),
        datasheets: { ...datasheetStatus(projectDir), bytes: cacheBytes(datasheetCacheDir()) },
        // 两个层次分开报：共享运行时是机器级的一份（装一次所有工程共用），
        // installed 只表示"这个工程把它挂上了"，不能用它给共享运行时下结论。
        runtime: (() => {
          const dir = ecadRuntimeDir(env);
          const ready = runtimeReady(dir);
          return { ready, linked: installed, dir, mode: runtimeInstallMode(), bytes: ready ? runtimeBytes(dir) : 0 };
        })(),
        autoBuild: readAutoState(projectDir),
        autoroute: (() => {
          const root = krtRoot();
          const status = krtStatus(root);
          return { ready: status.ok, error: status.ok ? "" : status.error, version: status.ok ? krtVersion(root) : "", root };
        })(),
        artifacts: await scanEcadArtifacts(workspace.outDir),
        layout: { projectDir: layout.projectDir, firmwareDir: layout.firmwareDir, hardwareDir: layout.hardwareDir, notes: layout.notes },
      },
    });
  }
  if (path === WEB_API_PREFIX + "/ecad/ipc") {
    // 面板上的「检查 KiCad」：只报能不能连上编辑器里的板子。真改板子走工具，面板不替用户动手。
    const located = locateEcadToolchain();
    if (located.toolchain === null) {
      return ok({ ipc: { ok: false, kind: "FAILED_PRECONDITION", error: located.error, version: "", boardName: "", footprints: 0, tracks: 0, vias: 0, zones: 0, nets: 0 } });
    }
    // open=1：连不上就替用户把最近一次构建的板子交给 pcbnew 打开，等 IPC 就绪（S154）。
    const autoOpen = query["open"] === "1" || query["open"] === "true";
    const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
    const projectDir = withProject(requested);
    let boardFile = "";
    if (autoOpen && projectDir !== "") {
      const layout = resolveProjectLayout(projectDir);
      const latest = findLatestKicadBuild(planEcadWorkspace(projectDir, layout.hardwareDir));
      if (latest.ok) boardFile = latest.pcbFile;
    }
    const connected = await connectPcbIpc({
      subprocess: input.deps.subprocess,
      python: located.toolchain.python,
      kicadRoot: located.toolchain.root,
      env,
      autoOpen,
      boardFile,
    });
    const result = connected.status;
    if (!result.ok) {
      return ok({ ipc: { ok: false, kind: result.kind, error: result.error, version: "", boardName: "", footprints: 0, tracks: 0, vias: 0, zones: 0, nets: 0, opened: connected.opened, notes: connected.notes } });
    }
    const data = result.data as { version?: string; board?: { name?: string; counts?: Record<string, number> } };
    const counts = data.board?.counts ?? {};
    return ok({ ipc: {
      ok: true,
      kind: "",
      error: "",
      version: data.version ?? "",
      boardName: data.board?.name ?? "",
      footprints: counts["footprints"] ?? 0,
      tracks: counts["tracks"] ?? 0,
      vias: counts["vias"] ?? 0,
      zones: counts["zones"] ?? 0,
      nets: counts["nets"] ?? 0,
      opened: connected.opened,
      notes: connected.notes,
    } });
  }
  if (path === WEB_API_PREFIX + "/ecad/bom") {
    // BOM 与元件成本（S156）：读 circuit.json 分组，价格只从缓存里取；`prices=1` 才联网补价。
    const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
    const projectDir = withProject(requested);
    if (projectDir === "") return fail(400, PROJECT_DIR_REQUIRED);
    const layout = resolveProjectLayout(projectDir);
    const workspace = planEcadWorkspace(projectDir, layout.hardwareDir);
    const latest = findLatestKicadBuild(workspace);
    const emptyBom = {
      ok: false,
      error: latest.ok
        ? "还没有 circuit.json：先构建一次电路，再回来看 BOM。"
        : latest.error,
      circuitFile: "",
      lines: [] as Array<Record<string, unknown>>,
      componentCount: 0,
      priced: 0,
      pricedComponents: 0,
      partsUsd: 0,
      missingLcsc: 0,
      notes: [] as string[],
    };
    if (!latest.ok || latest.kicadDir === "") return ok({ bom: emptyBom });
    const circuitFile = join(dirname(latest.kicadDir), "circuit.json");
    const base = readBom(circuitFile);
    if (!base.ok) return ok({ bom: { ...emptyBom, circuitFile, error: base.error } });
    let report = applyQuotes(base, readPriceCache(priceCachePath(envOf(input.deps))).quotes);
    const fetched: string[] = [];
    const failed: string[] = [];
    if (query["prices"] === "1") {
      const lookup = await ensurePrices(
        report.lines.map((line) => line.lcsc).filter((code) => code !== ""),
        { env: envOf(input.deps), signal: input.deps.signal },
      );
      fetched.push(...lookup.fetched);
      failed.push(...lookup.failed);
      report = applyQuotes(base, lookup.quotes);
    }
    return ok({
      bom: {
        ok: true,
        error: "",
        circuitFile,
        lines: report.lines,
        componentCount: report.componentCount,
        priced: report.priced,
        pricedComponents: report.pricedComponents,
        partsUsd: report.partsUsd,
        missingLcsc: report.missingLcsc,
        notes: report.notes.concat(
          fetched.length > 0 ? ["这次联网取到 " + String(fetched.length) + " 个编号的报价"] : [],
          failed.length > 0 ? ["有 " + String(failed.length) + " 个编号没取到报价：" + failed.slice(0, 6).join("、")] : [],
        ),
      },
    });
  }


  if (path === WEB_API_PREFIX + "/ecad/parts") {
    // 器件搜索（S163）：只读、不依赖工程；结果按查询缓存 24 小时。
    const q = typeof query["q"] === "string" ? query["q"].trim() : "";
    if (q === "") return fail(400, "q 不能为空：给型号、参数或立创编号，例如 C8734、0603 100nF");
    const limitRaw = Number(query["limit"] ?? "10");
    const pageRaw = Number(query["page"] ?? "1");
    const result = await searchParts(q, {
      limit: Number.isFinite(limitRaw) ? limitRaw : 10,
      page: Number.isFinite(pageRaw) ? pageRaw : 1,
      ...(query["refresh"] === "1" ? { noCache: true } : {}),
      cacheFile: searchCachePath(env),
      ...(input.deps.signal !== undefined ? { signal: input.deps.signal } : {}),
    });
    const notes = [...result.notes];
    if (result.ok && result.hits.length > 0 && result.hits.every((hit) => hit.packageName === "")) {
      notes.push("接口没给封装字段：封装要去商品页或手册确认，别按型号猜。");
    }
    return ok({
      parts: {
        ok: result.ok,
        error: result.error,
        query: result.query,
        total: result.total,
        cached: result.cached,
        hits: result.hits,
        notes,
      },
    });
  }

  if (path === WEB_API_PREFIX + "/ecad/mech") {
    // 外壳与机械约束（S162）：GET 出报告；POST {export:true} 才写 DXF。
    const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
    const projectDir = withProject(requested);
    if (projectDir === "") return fail(400, PROJECT_DIR_REQUIRED);
    const workspace = planEcadWorkspace(projectDir, resolveProjectLayout(projectDir).hardwareDir);
    const latest = findLatestKicadBuild(workspace);
    const emptyMech = {
      ok: false,
      error: latest.ok ? "还没有构建产物：先跑一次 stm32_ecad_build" : latest.error,
      boardFile: "",
      savedTo: "",
      bytes: 0,
      widthMm: 0,
      heightMm: 0,
      thicknessMm: 0,
      areaCm2: 0,
      outlinePoints: 0,
      holes: [] as Array<Record<string, unknown>>,
      mountingHoles: 0,
      minHoleEdgeMm: 0,
      findings: [] as Array<Record<string, unknown>>,
      notes: [] as string[],
    };
    if (!latest.ok || latest.pcbFile === "") return ok({ mech: emptyMech });
    const report = readMech(latest.pcbFile, (file) => readFileSync(file, "utf8"));
    if (!report.ok) return ok({ mech: { ...emptyMech, boardFile: latest.pcbFile, error: report.error } });
    let savedTo = "";
    let bytes = 0;
    if (method === "POST" && parsed.value.export === true) {
      const target = typeof parsed.value.saveAs === "string" && parsed.value.saveAs !== ""
        ? resolve(projectDir, parsed.value.saveAs)
        : join(projectDir, "mech", "board.dxf");
      bytes = writeMechDxf(target, report);
      savedTo = target;
    }
    return ok({
      mech: {
        ok: true,
        error: "",
        boardFile: report.boardFile,
        savedTo,
        bytes,
        widthMm: report.widthMm,
        heightMm: report.heightMm,
        thicknessMm: report.thicknessMm,
        areaCm2: report.areaCm2,
        outlinePoints: report.outlinePoints,
        holes: report.holes.map((hole) => ({ ...hole })),
        mountingHoles: report.mountingHoles,
        minHoleEdgeMm: report.minHoleEdgeMm,
        findings: report.findings.map((finding) => ({ ...finding })),
        notes: [...report.notes],
      },
    });
  }

  if (path === WEB_API_PREFIX + "/schematic/edit") {
    const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
    const projectDir = withProject(requested);
    if (projectDir === "") return fail(400, PROJECT_DIR_REQUIRED);
    const layout = resolveProjectLayout(projectDir);
    const workspace = planEcadWorkspace(projectDir, layout.hardwareDir);
    const store = editStorePath(workspace.circuitDir);
    if (method === "GET") {
      const edits = readSchEdits(store);
      return ok({ snippet: { store, edits } });
    }
    const body = parseJsonBody(input.body ?? "");
    if (!body.ok) return fail(400, body.error);
    const mode = typeof body.value["mode"] === "string" ? String(body.value["mode"]) : "add";
    const existing = readSchEdits(store);
    if (mode === "clear") {
      writeSchEdits(store, []);
      return ok({ snippet: { store, edits: [], cleared: true } });
    }
    const a = body.value["a"] as { ref?: unknown; pin?: unknown } | undefined;
    const b = body.value["b"] as { ref?: unknown; pin?: unknown } | undefined;
    const textValue = typeof body.value["text"] === "string" ? body.value["text"].trim() : "";
    const aRef = typeof a?.ref === "string" ? a.ref.trim() : "";
    const aPin = typeof a?.pin === "string" ? a.pin.trim() : "";
    if (aRef === "" || aPin === "") return fail(400, "a.ref 与 a.pin 都要给");
    const next = [...existing];
    if (textValue !== "") {
      next.push({ op: "label", at: { ref: aRef, pin: aPin }, text: textValue });
    } else {
      const bRef = typeof b?.ref === "string" ? b.ref.trim() : "";
      const bPin = typeof b?.pin === "string" ? b.pin.trim() : "";
      if (bRef === "" || bPin === "") return fail(400, "connect 需要 a 与 b 两端；只给一端就带 text");
      if (bRef === aRef && bPin === aPin) return fail(400, "两端是同一个引脚");
      next.push({ op: "connect", a: { ref: aRef, pin: aPin }, b: { ref: bRef, pin: bPin } });
    }
    writeSchEdits(store, next);
    // 面板上点「连起来」要立刻看见线：重放和工具走同一份实现。
    const latest = findLatestKicadBuild(workspace);
    const replay = replaySchEditsTo(latest.ok ? latest.kicadDir : "", next);
    return ok({
      snippet: {
        store,
        edits: next,
        replay: {
          applied: replay.applied,
          skipped: replay.skipped,
          failed: [...replay.failed],
          notes: [...replay.notes],
        },
      },
    });
  }

  if (path === WEB_API_PREFIX + "/schematic/sync") {
    // 手绘层新放的器件补到板子（S177）：GET 出计划，POST { apply: true } 才写。
    const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
    const projectDir = withProject(requested);
    if (projectDir === "") return fail(400, PROJECT_DIR_REQUIRED);
    const apply = method === "POST";
    const plan = planHandSync(projectDir, {
      boardFile: typeof query["boardFile"] === "string" ? query["boardFile"] : undefined,
      schematicFile: typeof query["schematicFile"] === "string" ? query["schematicFile"] : undefined,
    });
    if (!plan.ok) return ok({ sync: { ok: false, error: plan.error, schematicFile: plan.schematicFile, boardFile: plan.boardFile, parts: [], added: 0, skipped: [], missingLib: [], unassigned: 0, notes: [] } });
    if (!apply) {
      return ok({
        sync: {
          ok: true,
          error: "",
          schematicFile: plan.schematicFile,
          boardFile: plan.boardFile,
          parts: plan.parts.map((part) => ({ ref: part.ref, footprint: part.footprint, nets: part.nets.length })),
          added: 0,
          skipped: [...plan.alreadyOnBoard],
          missingLib: [],
          unassigned: plan.noNet,
          notes: [...plan.notes],
        },
      });
    }
    const located = locateEcadToolchain(envOf(input.deps));
    if (!located.ok || located.toolchain === null) {
      return ok({ sync: { ok: false, error: "没有找到 KiCad 工具链：补封装要用 KiCad 自带的 python", schematicFile: plan.schematicFile, boardFile: plan.boardFile, parts: [], added: 0, skipped: [], missingLib: [], unassigned: 0, notes: [...plan.notes] } });
    }
    if (plan.parts.length === 0) {
      return ok({ sync: { ok: true, error: "", schematicFile: plan.schematicFile, boardFile: plan.boardFile, parts: [], added: 0, skipped: [...plan.alreadyOnBoard], missingLib: [], unassigned: plan.noNet, notes: [...plan.notes, "板上已经有这些位号：没有要补的"] } });
    }
    backupBoardFile(plan.boardFile);
    const stamp = String(Date.now());
    const scriptFile = join(tmpdir(), "dsh-stm32-handsync-" + stamp + ".py");
    const resultFile = join(tmpdir(), "dsh-stm32-handsync-" + stamp + ".json");
    writeFileSync(scriptFile, buildHandSyncScript(plan), "utf8");
    const payload = JSON.stringify({
      boardFile: plan.boardFile,
      libraryDirs: [...plan.libraryDirs, located.toolchain.footprintDir],
      parts: plan.parts.map((part) => ({
        ref: part.ref,
        value: part.value,
        library: part.library,
        footprintName: part.footprintName,
        x: part.x,
        y: part.y,
        nets: part.nets.map((net) => ({ number: net.number, net: net.net })),
      })),
    });
    const run = await runCapture(input.deps.subprocess, {
      argv: [located.toolchain.python, scriptFile, payload, resultFile],
      cwd: dirname(plan.boardFile),
      env: located.toolchain.env,
      timeoutMs: 120_000,
      maxBytes: 256_000,
    });
    if (run.exitCode !== 0) {
      return ok({ sync: { ok: false, error: "KiCad python 执行失败：" + (run.stderr === "" ? run.stdout : run.stderr).slice(-400), schematicFile: plan.schematicFile, boardFile: plan.boardFile, parts: [], added: 0, skipped: [], missingLib: [], unassigned: 0, notes: [] } });
    }
    const parsed = existsSync(resultFile) ? parseHandSyncOutput(readFileSync(resultFile, "utf8")) : null;
    if (parsed === null || !parsed.ok) {
      return ok({ sync: { ok: false, error: "没读到补封装结果：脚本没有写出结果文件", schematicFile: plan.schematicFile, boardFile: plan.boardFile, parts: [], added: 0, skipped: [], missingLib: [], unassigned: 0, notes: [] } });
    }
    return ok({
      sync: {
        ok: true,
        error: "",
        schematicFile: plan.schematicFile,
        boardFile: plan.boardFile,
        parts: plan.parts.map((part) => ({ ref: part.ref, footprint: part.footprint, nets: part.nets.length })),
        added: parsed.added,
        skipped: parsed.skipped,
        missingLib: parsed.missingLib,
        unassigned: parsed.unassigned,
        notes: [...plan.notes],
      },
    });
  }

  if (path === WEB_API_PREFIX + "/ecad/netgate") {
    // 网表与板子的一致性门禁（S169）：只读，结论 + 修法一起给。
    const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
    const projectDir = withProject(requested);
    if (projectDir === "") return fail(400, PROJECT_DIR_REQUIRED);
    const report = checkNetGate(projectDir);
    return ok({
      netgate: {
        ok: report.ok,
        error: report.error,
        state: report.state,
        summary: netGateSummary(report),
        staleSeconds: report.staleSeconds,
        schematicFile: report.schematicFile,
        pcbFile: report.pcbFile,
        schematicComponents: report.schematicComponents,
        pcbFootprints: report.pcbFootprints,
        compared: report.compared,
        matched: report.matched,
        split: report.split,
        nameMismatches: report.nameMismatches,
        missingPads: report.missingPads,
        hand: {
          file: report.hand.file,
          exists: report.hand.exists,
          partsOnlyInHand: [...report.hand.partsOnlyInHand],
          partsOnlyInBuild: [...report.hand.partsOnlyInBuild],
          pinsChanged: [...report.hand.pinsChanged],
        },
        findings: report.findings.map((finding) => ({ ...finding })),
        notes: [...report.notes],
      },
    });
  }

  if (path === WEB_API_PREFIX + "/ecad/impedance") {
    // 阻抗规则写回（S168）：GET 只回规则文本，POST { write: true } 才写进 <工程>.kicad_dru。
    const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
    const projectDir = withProject(requested);
    if (projectDir === "") return fail(400, PROJECT_DIR_REQUIRED);
    const layout = resolveProjectLayout(projectDir);
    const workspace = planEcadWorkspace(projectDir, layout.hardwareDir);
    const latest = findLatestKicadBuild(workspace);
    const emptyPlan = {
      ok: false,
      error: latest.ok ? "还没有 .kicad_pcb：先构建一次，或在 KiCad 里存一次板子。" : latest.error,
      boardFile: "",
      rulesFile: "",
      copperLayers: 0,
      preset: "",
      written: false,
      rules: [] as string[],
      suggestions: [] as Array<Record<string, unknown>>,
      notes: [] as string[],
    };
    if (!latest.ok || latest.pcbFile === "") return ok({ impedance: emptyPlan });
    const singles = typeof query["nets"] === "string" && query["nets"].trim() !== ""
      ? query["nets"].split(",").map((name) => name.trim()).filter((name) => name !== "")
      : [];
    const plan = readImpedancePlan(dirname(latest.pcbFile), latest.pcbFile, {
      singles,
      spacingMm: typeof query["spacing"] === "string" && Number(query["spacing"]) > 0 ? Number(query["spacing"]) : undefined,
      write: method === "POST" && parsed.value.write === true,
    });
    if (!plan.ok) return ok({ impedance: { ...emptyPlan, boardFile: plan.boardFile, rulesFile: plan.rulesFile, error: plan.error } });
    return ok({
      impedance: {
        ok: true,
        error: "",
        boardFile: plan.boardFile,
        rulesFile: plan.rulesFile,
        copperLayers: plan.copperLayers,
        preset: plan.presetLabel,
        written: plan.written,
        rules: [...plan.rules],
        suggestions: plan.suggestions.map((item) => ({ ...item, nets: [...item.nets] })),
        notes: [...plan.notes],
      },
    });
  }

  if (path === WEB_API_PREFIX + "/ecad/brief") {
    // 需求文档（S161）：GET 看三份文档在不在、多大；POST 才生成骨架（默认不覆盖）。
    const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
    const projectDir = withProject(requested);
    if (projectDir === "") return fail(400, PROJECT_DIR_REQUIRED);
    const docsDir = join(projectDir, "docs");
    const files = ["01-MRD.md", "02-hardware-PRD.md", "03-design-brief.md"].map((name) => {
      const file = join(docsDir, name);
      let bytes = 0;
      let updatedMs = 0;
      try {
        const info = statSync(file);
        bytes = info.size;
        updatedMs = info.mtimeMs;
      } catch {
        // 文件不存在：bytes 0 即正确状态。
      }
      return { name, exists: bytes > 0, bytes, updatedMs };
    });
    const facts = collectBriefFacts(projectDir);
    const emptyBrief = {
      ok: false,
      error: facts.ok ? "" : facts.error,
      projectDir,
      docsDir,
      files,
      mcu: "",
      clocks: "",
      peripherals: [] as string[],
      notes: [] as string[],
      written: [] as string[],
      skipped: [] as string[],
    };
    if (!facts.ok) return ok({ brief: emptyBrief });
    if (method === "POST" && parsed.value.write === true) {
      const force = parsed.value.force === true;
      const result = writeBriefs(projectDir, facts, force);
      if (!result.ok) return ok({ brief: { ...emptyBrief, error: result.error } });
      return ok({
        brief: {
          ok: true,
          error: "",
          projectDir,
          docsDir,
          files: files.map((file) => {
            let bytes = file.bytes;
            try {
              bytes = statSync(join(docsDir, file.name)).size;
            } catch {
              bytes = 0;
            }
            return { ...file, exists: bytes > 0, bytes };
          }),
          mcu: facts.mcu.cpn,
          clocks: facts.clocks.sysclkHz === null ? "" : String(Math.round((facts.clocks.sysclkHz / 1_000_000) * 10) / 10) + " MHz",
          peripherals: [...facts.peripherals],
          notes: [...facts.notes],
          written: [...result.written],
          skipped: [...result.skipped],
        },
      });
    }
    return ok({
      brief: {
        ...emptyBrief,
        ok: true,
        mcu: facts.mcu.cpn,
        clocks: facts.clocks.sysclkHz === null ? "" : String(Math.round((facts.clocks.sysclkHz / 1_000_000) * 10) / 10) + " MHz",
        peripherals: [...facts.peripherals],
        notes: [...facts.notes],
      },
    });
  }

  if (path === WEB_API_PREFIX + "/ecad/power") {
    // 功耗与电源树（S160）：只合计用户填的电流，按名字估的另计；线宽判据复用 EMC 的 IPC-2221。
    const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
    const projectDir = withProject(requested);
    if (projectDir === "") return fail(400, PROJECT_DIR_REQUIRED);
    const layout = resolveProjectLayout(projectDir);
    const workspace = planEcadWorkspace(projectDir, layout.hardwareDir);
    const latest = findLatestKicadBuild(workspace);
    const emptyPower = {
      ok: false,
      error: latest.ok ? "还没有 .kicad_pcb：先构建一次，或在 KiCad 里存一次板子。" : latest.error,
      boardFile: "",
      rails: [] as Array<Record<string, unknown>>,
      totalA: 0,
      totalW: 0,
      estimatedA: 0,
      estimatedW: 0,
      inputA: 0,
      inputV: 0,
      efficiency: 0,
      unfilled: 0,
      notes: [] as string[],
    };
    if (!latest.ok || latest.pcbFile === "") return ok({ power: emptyPower });
    let netlist = null;
    const circuitFile = join(dirname(latest.kicadDir), "circuit.json");
    if (existsSync(circuitFile)) {
      try {
        netlist = readCircuitNetlist(readFileSync(circuitFile, "utf8"));
      } catch {
        netlist = null;
      }
    }
    const budget = analyzePowerBudget(readFileSync(latest.pcbFile, "utf8"), latest.pcbFile, netlist);
    if (!budget.ok) return ok({ power: { ...emptyPower, boardFile: latest.pcbFile, error: budget.error } });
    return ok({
      power: {
        ok: true,
        error: "",
        boardFile: budget.boardFile,
        rails: budget.rails.map((rail) => ({ ...rail, voltageV: rail.voltageV ?? 0, currentA: rail.currentA ?? 0, known: rail.currentA !== null, ok: rail.ok === true })),
        totalA: budget.totalA,
        totalW: budget.totalW,
        estimatedA: budget.estimatedA,
        estimatedW: budget.estimatedW,
        inputA: budget.inputA,
        inputV: budget.inputV,
        efficiency: budget.efficiency,
        unfilled: budget.unfilled,
        notes: budget.notes,
      },
    });
  }

  if (path === WEB_API_PREFIX + "/ecad/links") {
    // 布线进阶体检（S165）：差分对长度差、平面层被信号割裂、去耦电容到负载引脚的距离。
    const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
    const projectDir = withProject(requested);
    if (projectDir === "") return fail(400, PROJECT_DIR_REQUIRED);
    const layout = resolveProjectLayout(projectDir);
    const workspace = planEcadWorkspace(projectDir, layout.hardwareDir);
    const latest = findLatestKicadBuild(workspace);
    const emptyLinks = {
      ok: false,
      error: latest.ok ? "还没有 .kicad_pcb：先构建一次，或在 KiCad 里存一次板子。" : latest.error,
      boardFile: "",
      copperLayers: 0,
      pairs: [] as Array<Record<string, unknown>>,
      decaps: [] as Array<Record<string, unknown>>,
      planes: [] as Array<Record<string, unknown>>,
      findings: [] as Array<Record<string, unknown>>,
      notes: [] as string[],
    };
    if (!latest.ok || latest.pcbFile === "") return ok({ links: emptyLinks });
    const report = readLinks(latest.pcbFile);
    if (!report.ok) return ok({ links: { ...emptyLinks, boardFile: latest.pcbFile, error: report.error } });
    return ok({
      links: {
        ok: true,
        error: "",
        boardFile: report.boardFile,
        copperLayers: report.copperLayers,
        pairs: report.pairs.map((item) => ({ ...item, notes: [...item.notes] })),
        decaps: report.decaps.map((item) => ({ ...item })),
        planes: report.planes.map((item) => ({ ...item, planeNets: [...item.planeNets], signalNets: [...item.signalNets] })),
        findings: report.findings.map((item) => ({ ...item })),
        notes: [...report.notes],
      },
    });
  }

  if (path === WEB_API_PREFIX + "/ecad/render3d") {
    // 3D 预览（S180）：交给 KiCad 的 `pcb render`，顺手报出哪些封装的 3D 模型缺文件。
    const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
    const projectDir = withProject(requested);
    if (projectDir === "") return fail(400, PROJECT_DIR_REQUIRED);
    const base = { ...EMPTY_RENDER3D, dataUrl: "" } as Record<string, unknown>;
    const located = locateEcadToolchain(envOf(input.deps));
    if (!located.ok || located.toolchain === null) {
      return ok({ render3d: { ...base, error: "找不到 KiCad 工具链：" + located.error, models: [], missing: [], notes: [] } });
    }
    const latest = findLatestKicadBuild(planEcadWorkspace(projectDir, resolveProjectLayout(projectDir).hardwareDir));
    if (latest === null || latest.pcbFile === "") {
      return ok({ render3d: { ...base, error: "还没有可用的 .kicad_pcb：先跑一次 stm32_ecad_build，或在 KiCad 里存一次板子", models: [], missing: [], notes: [] } });
    }
    const sideParam = typeof query["side"] === "string" && query["side"].trim() !== "" ? query["side"].trim() : "top";
    const side = ["top", "bottom", "left", "right", "front", "back"].includes(sideParam) ? sideParam : "top";
    const rotateParam = typeof query["rotate"] === "string" && query["rotate"].trim() !== "" ? query["rotate"].trim() : "";
    const result = await renderBoard3d(
      {
        kicadCli: located.toolchain.kicadCli,
        model3dDir: located.toolchain.model3dDir,
        run: async (argv, timeoutMs) => {
          const outcome = await runCapture(input.deps.subprocess, { argv: [...argv], cwd: dirname(latest.pcbFile), timeoutMs });
          return { exitCode: outcome.exitCode ?? 1, stdout: outcome.stdout, stderr: outcome.stderr };
        },
      },
      latest.pcbFile,
      {
        side: side as "top" | "bottom" | "left" | "right" | "front" | "back",
        ...(rotateParam === "" ? {} : { rotate: rotateParam }),
        ...(query["perspective"] === "1" ? { perspective: true } : {}),
        width: 1200,
        height: 900,
        output: join(projectDir, "hardware", "out", "board-3d-" + side + ".png"),
      },
    );
    const fixes =
      result.missing.length > 0 && located.toolchain.footprintDir !== ""
        ? suggestModelFixes(readFileSync(latest.pcbFile, "utf8"), latest.pcbFile, { model3dDir: located.toolchain.model3dDir, footprintDir: located.toolchain.footprintDir })
        : [];
    let dataUrl = "";
    const notes = [...result.notes];
    if (result.ok && result.bytes > 0 && result.bytes <= 1_500_000) {
      dataUrl = "data:image/png;base64," + readFileSync(result.file).toString("base64");
    } else if (result.ok && result.bytes > 1_500_000) {
      notes.push("图片 " + String(Math.round(result.bytes / 1024)) + " KB，超过 1.5 MB 没有内嵌；直接打开文件看。");
    }
    return ok({
      render3d: {
        ok: result.ok,
        error: result.error,
        file: result.file,
        bytes: result.bytes,
        side: result.side,
        width: result.width,
        height: result.height,
        dataUrl,
        models: result.models.map((model) => ({ ...model })),
        missing: [...result.missing],
        fixes: fixes.map((fix) => ({ ...fix, candidates: fix.candidates.map((candidate) => ({ ...candidate })) })),
        notes,
      },
    });
  }

  if (path === WEB_API_PREFIX + "/ecad/gerber") {
    // 制造文件回看（S166）：把导出的 Gerber 与钻孔读回来画成一张图，交付前核对板框、铜、丝印与孔位。
    const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
    const projectDir = withProject(requested);
    if (projectDir === "") return fail(400, PROJECT_DIR_REQUIRED);
    const layersParam = typeof query["layers"] === "string" && query["layers"].trim() !== "" ? query["layers"].split(",").map((item) => item.trim()).filter((item) => item !== "") : [];
    const dir = join(projectDir, "hardware", "out", "gerbers");
    const view = readGerberSet(dir, { ...(layersParam.length > 0 ? { layers: layersParam } : {}) });
    if (!view.ok) {
      return ok({
        gerber: {
          ok: false,
          error: view.error,
          dir,
          svg: "",
          widthMm: 0,
          heightMm: 0,
          drillHoles: 0,
          layers: [] as Array<Record<string, unknown>>,
          notes: [] as string[],
        },
      });
    }
    return ok({
      gerber: {
        ok: true,
        error: "",
        dir: view.dir,
        svg: view.svg,
        widthMm: view.widthMm,
        heightMm: view.heightMm,
        drillHoles: view.drillHoles,
        layers: view.layers.map((item) => ({ ...item })),
        notes: [...view.notes],
      },
    });
  }

  if (path === WEB_API_PREFIX + "/ecad/emc") {
    // EMC 与热（S158）：电源线载流、铺铜与参考平面、换层过孔回流；不做磁场仿真。
    const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
    const projectDir = withProject(requested);
    if (projectDir === "") return fail(400, PROJECT_DIR_REQUIRED);
    const layout = resolveProjectLayout(projectDir);
    const workspace = planEcadWorkspace(projectDir, layout.hardwareDir);
    const latest = findLatestKicadBuild(workspace);
    const emptyEmc = {
      ok: false,
      error: latest.ok ? "还没有 .kicad_pcb：先构建一次，或在 KiCad 里存一次板子。" : latest.error,
      boardFile: "",
      copperLayers: 0,
      nets: 0,
      zonesByLayer: {} as Record<string, number>,
      powerTraces: [] as Array<Record<string, unknown>>,
      findings: [] as Array<Record<string, unknown>>,
      notes: [] as string[],
      deep: { pairs: [] as Array<Record<string, unknown>>, returnPaths: [] as Array<Record<string, unknown>>, crosstalk: [] as Array<Record<string, unknown>>, findings: [] as Array<Record<string, unknown>>, notes: [] as string[] },
    };
    if (!latest.ok || latest.pcbFile === "") return ok({ emc: emptyEmc });
    const report = analyzeEmc(readFileSync(latest.pcbFile, "utf8"), latest.pcbFile);
    if (!report.ok) return ok({ emc: { ...emptyEmc, boardFile: latest.pcbFile, error: report.error } });
    // 深度体检（S167）：差分对间距、回流路径覆盖、并行串扰——数不出来就说数不出来，不编。
    const deepReport = readEmcDeep(latest.pcbFile, (file) => readFileSync(file, "utf8"));
    return ok({
      emc: {
        ok: true,
        error: "",
        boardFile: report.boardFile,
        copperLayers: report.copperLayers,
        nets: report.nets,
        zonesByLayer: report.zonesByLayer,
        powerTraces: report.powerTraces,
        findings: [...report.findings, ...deepReport.findings],
        notes: [...report.notes, ...deepReport.notes],
        deep: {
          pairs: deepReport.pairs,
          returnPaths: deepReport.returnPaths,
          crosstalk: deepReport.crosstalk,
          findings: deepReport.findings,
          notes: deepReport.notes,
        },
      },
    });
  }

  if (path === WEB_API_PREFIX + "/ecad/stackup") {
    // 叠层与阻抗（S157）：板子里没有 stackup 段就按层数取嘉立创常规叠层，再给 50/90/100 Ω 的线宽。
    const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
    const projectDir = withProject(requested);
    if (projectDir === "") return fail(400, PROJECT_DIR_REQUIRED);
    const layout = resolveProjectLayout(projectDir);
    const workspace = planEcadWorkspace(projectDir, layout.hardwareDir);
    const latest = findLatestKicadBuild(workspace);
    const emptyStackup = {
      ok: false,
      error: latest.ok ? "还没有 .kicad_pcb：先构建一次，或在 KiCad 里存一次板子。" : latest.error,
      boardFile: "",
      copperLayers: 0,
      preset: "",
      traceWidths: [] as number[],
      suggestions: [] as Array<Record<string, unknown>>,
      notes: [] as string[],
    };
    if (!latest.ok || latest.pcbFile === "") return ok({ stackup: emptyStackup });
    const spacing = Number(query["spacing"]);
    const spacingMm = Number.isFinite(spacing) && spacing > 0 ? spacing : 0.2;
    const analysis = analyzeStackup(readFileSync(latest.pcbFile, "utf8"), latest.pcbFile, spacingMm, DEFAULT_TARGETS);
    if (!analysis.ok) return ok({ stackup: { ...emptyStackup, boardFile: latest.pcbFile, error: analysis.error } });
    return ok({
      stackup: {
        ok: true,
        error: "",
        boardFile: analysis.boardFile,
        copperLayers: analysis.copperLayers,
        preset: analysis.preset.label,
        traceWidths: analysis.traceWidths,
        suggestions: analysis.suggestions,
        notes: analysis.notes,
      },
    });
  }

  if (path === WEB_API_PREFIX + "/ecad/pcb") {
    // 板图预览（S151）：只读 .kicad_pcb 出 SVG。不改板、不跑子进程，板子打不开时回可读错误。
    const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
    const projectDir = withProject(requested);
    if (projectDir === "") return fail(400, PROJECT_DIR_REQUIRED);
    const layout = resolveProjectLayout(projectDir);
    const workspace = planEcadWorkspace(projectDir, layout.hardwareDir);
    const latest = findLatestKicadBuild(workspace);
    const board = latest.ok ? latest.pcbFile : "";
    const emptyPcbView = {
      ok: false,
      error: latest.ok ? "还没有 .kicad_pcb：先构建一次，或在 KiCad 里存一次板子。" : latest.error,
      file: "",
      copperLayers: 0,
      svg: "",
      width: 0,
      height: 0,
      widthMm: 0,
      heightMm: 0,
      pads: 0,
      tracks: 0,
      innerTracks: 0,
      vias: 0,
      elements: 0,
      notes: [] as string[],
    };
    if (board === "") return ok({ pcbView: emptyPcbView });
    const scene = readPcbScene(board);
    if (!scene.ok) return ok({ pcbView: { ...emptyPcbView, error: scene.error } });
    // 查询参数按“关掉哪一层”读：默认全开，传 0 才隐藏；位号默认关（排布密集时压线）。
    const flagOf = (name: string): boolean => query[name] !== "0";
    const rendered = renderPcbSvg(scene, {
      show: {
        top: flagOf("top"),
        bottom: flagOf("bottom"),
        pads: flagOf("pads"),
        vias: flagOf("vias"),
        silk: flagOf("silk"),
        edge: flagOf("edge"),
        zones: flagOf("zones"),
        refs: query["refs"] === "1",
      },
    });
    return ok({
      pcbView: {
        ok: rendered.ok,
        error: rendered.error,
        file: board,
        copperLayers: scene.copperLayers,
        svg: rendered.svg,
        width: rendered.width,
        height: rendered.height,
        widthMm: rendered.widthMm,
        heightMm: rendered.heightMm,
        pads: rendered.pads,
        tracks: rendered.tracks,
        innerTracks: scene.innerTracks,
        vias: rendered.vias,
        elements: rendered.elements,
        notes: scene.notes,
      },
    });
  }
  if (path === WEB_API_PREFIX + "/layout") {
    // 工程结构与配置文件归位（S128）：GET 只规划，POST 才动文件。
    const requested = typeof parsed.value.workspaceRoot === "string" ? parsed.value.workspaceRoot.trim() : "";
    const workspaceRoot = requested === "" ? withProject("") : resolve(requested);
    if (workspaceRoot === "") return ok({ layoutFix: { ok: false, error: PROJECT_DIR_REQUIRED, workspaceRoot: "", actions: [], notes: [] } });
    if (input.method !== "POST") {
      const plan = planLayoutFix(workspaceRoot);
      return ok({ layoutFix: { ok: plan.ok, error: plan.error, workspaceRoot: plan.workspaceRoot, actions: plan.actions, notes: plan.notes } });
    }
    const fixed = applyLayoutFix(workspaceRoot);
    return ok({ layoutFix: { ok: fixed.ok, error: fixed.error, workspaceRoot: fixed.workspaceRoot, actions: fixed.actions, notes: fixed.notes } });
  }
  if (path === WEB_API_PREFIX + "/ecad/action") {
    // 面板上的八个动作：都对应一个工具在做的事，只是不必让用户去对话里敲一遍。
    // 面板上的六个动作：都对应一个工具在做的事，只是不必让用户去对话里敲一遍。
    // 构建与检查要几十秒，面板在请求返回前只显示「执行中」，不做乐观更新。
    const requested = typeof parsed.value.projectDir === "string" ? parsed.value.projectDir.trim() : "";
    const projectDir = withProject(requested);
    if (projectDir === "") return fail(400, PROJECT_DIR_REQUIRED);
    const action = typeof parsed.value.action === "string" ? parsed.value.action : "";
    if (!["build", "check", "libs", "step", "export", "package", "datasheets", "design"].includes(action)) {
      return fail(400, "action 只能是 build / check / libs / step / export / package / datasheets / design");
    }
    const layout = resolveProjectLayout(projectDir);
    const workspace = planEcadWorkspace(projectDir, layout.hardwareDir);
    const started = Date.now();
    // 一键设计：构建 → 合并焊盘 → 导库 → ERC/DRC → 可制造性 → 制造文件（S134）。
    if (action === "design") {
      const located = locateEcadToolchain();
      if (located.toolchain === null) return fail(409, located.error);
      const result = await runEcadDesign({
        subprocess: input.deps.subprocess,
        toolchain: located.toolchain,
        workspace,
        mergePads: parsed.value.mergePads !== false,
        pcb: parsed.value.pcb === true,
        artifacts: parsed.value.artifacts !== false,
      });
      return ok({
        ecadAction: {
          action,
          ok: result.ok,
          error: result.error,
          durationMs: Date.now() - started,
          steps: [...result.steps],
          notes: [...result.notes],
          file: "",
          bytes: 0,
          files: 0,
          skipped: 0,
        },
      });
    }
    // 补手册只读 circuit 源码与网络，不需要 KiCad：放在工具链探测之前（S120）。
    if (action === "datasheets") {
      const ds = await ensureProjectDatasheets(projectDir, {
        offline: (envOf(input.deps)["DSH_STM32_OFFLINE"] ?? "").trim() === "1",
      });
      const notes = [
        "本工程 " + String(ds.codes.length) + " 个立创器件",
        "缓存命中 " + String(ds.cached) + " 个，新抓 " + String(ds.fetched.length) + " 个，失败 " + String(ds.failed.length) + " 个",
        ...ds.failed.map((item) => item.code + "：" + item.error),
      ];
      return ok({
        ecadAction: {
          action: action,
          ok: ds.failed.length === 0,
          error: ds.failed.length === 0 ? "" : "有 " + String(ds.failed.length) + " 个器件未完成",
          durationMs: Date.now() - started,
          file: "",
          bytes: 0,
          files: ds.fetched.length,
          skipped: ds.cached,
          notes,
        },
      });
    }
    // 打包只读 hardware/ 目录，不需要 KiCad 与 tscircuit：先处理，免得没装工具链的机器连包都打不了。
    if (action === "package") {
      const packed = packageHardware(workspace.root, basename(projectDir));
      const check = packed.ok ? verifyPackage(packed.file) : { ok: false, error: packed.error, files: 0 };
      return ok({
        ecadAction: {
          action: action,
          ok: packed.ok && check.ok,
          error: packed.ok ? check.error : packed.error,
          durationMs: Date.now() - started,
          file: packed.file,
          bytes: packed.bytes,
          files: packed.files,
          skipped: packed.skipped,
          notes: packed.notes,
        },
      });
    }

    const located = locateEcadToolchain(envOf(input.deps));
    if (located.toolchain === null) return fail(409, located.error);
    const latestForCheck = () => findLatestKicadBuild(workspace);
    const runLibs = async (pcbFile: string, schFile: string) => {
      const libs = exportEmbeddedLibraries(workspace, pcbFile, schFile);
      return {
        ok: libs.ok,
        error: libs.error,
        footprints: libs.footprintLibs.map((item) => ({ lib: item.lib, count: item.count })),
        symbols: libs.symbolLibs.map((item) => ({ lib: item.lib, count: item.count })),
      };
    };
    if (action === "build") {
      const build = await runTsciBuild({ subprocess: input.deps.subprocess, toolchain: located.toolchain, workspace, svgs: true });
      const latest = latestForCheck();
      return ok({
        ecadAction: {
          action: action,
          ok: build.ok,
          error: build.error,
          durationMs: Date.now() - started,
          kicadDir: latest.ok ? latest.kicadDir : "",
          notes: build.notes,
        },
      });
    }
    const latest = latestForCheck();
    if (!latest.ok) return fail(409, latest.error);
    if (action === "libs") {
      const libs = await runLibs(latest.pcbFile, latest.schematicFile);
      return ok({ ecadAction: { action: action, ok: libs.ok, error: libs.error, durationMs: Date.now() - started, libs: libs, notes: [] } });
    }
    if (action === "check") {
      const libs = await runLibs(latest.pcbFile, latest.schematicFile);
      const [erc, drc] = await Promise.all([
        runErc(input.deps.subprocess, located.toolchain, latest.schematicFile),
        runDrc(input.deps.subprocess, located.toolchain, latest.pcbFile),
      ]);
      const findings = [...(erc.summary.findings ?? []), ...(drc.summary.findings ?? [])];
      const dru = writeDru(latest.kicadDir);
      const dfm = checkDfm(readFileSync(latest.pcbFile, "utf8"));
      return ok({
        ecadAction: {
          action: action,
          ok: erc.ok && drc.ok && dfm.ok,
          error: erc.ok ? drc.error : erc.error,
          durationMs: Date.now() - started,
          summary: { errors: erc.summary.errors + drc.summary.errors, warnings: erc.summary.warnings + drc.summary.warnings },
          findings: findings.slice(0, 40),
          libs: libs,
          dfm: {
            ok: dfm.ok,
            widthMm: dfm.facts.widthMm,
            heightMm: dfm.facts.heightMm,
            layers: dfm.facts.layers,
            minTrackMm: dfm.facts.minTrackMm,
            minDrillMm: dfm.facts.minDrillMm,
            approxCny: dfm.cost.approxCny,
            basis: [...dfm.cost.basis],
            surcharges: [...dfm.cost.surcharges],
            findings: dfm.findings.slice(0, 20).map((finding) => ({ ...finding })),
            druFile: dru.file,
          },
          notes: dru.ok ? [] : [`设计规则没写进工程：${dru.error}`],
        },
      });
    }
    if (action === "step") {
      const out = join(workspace.outDir, "board.step");
      const step = await exportStep(input.deps.subprocess, located.toolchain, latest.pcbFile, out, undefined, { libsDir: workspace.libsDir });
      return ok({
        ecadAction: {
          action: action,
          ok: step.ok,
          error: step.error,
          durationMs: Date.now() - started,
          artifacts: step.ok ? [{ name: "board.step", bytes: step.bytes }] : [],
          notes: step.missingModels.length > 0 ? ["缺 3D 模型：" + step.missingModels.slice(0, 4).join("、")] : [],
        },
      });
    }
    const fabricated = await exportFabrication(input.deps.subprocess, located.toolchain, latest.pcbFile, workspace.outDir);
    // 导出成功即清掉「待导出」标记：面板不再提示，避免重复追问（S137）。
    if (fabricated.ok) {
      const previous = readAutoState(projectDir);
      if (previous !== null && previous.pendingExport) {
        writeAutoState(projectDir, { ...previous, pendingExport: false });
      }
    }
    const artifacts = [
      ...fabricated.gerbers.map((item) => ({ name: "gerbers/" + item.name, bytes: item.bytes })),
      ...fabricated.drillFiles.map((item) => ({ name: "drill/" + item.name, bytes: item.bytes })),
    ];
    if (fabricated.stepBytes > 0) artifacts.push({ name: "board.step", bytes: fabricated.stepBytes });
    return ok({
      ecadAction: {
        action: action,
        ok: fabricated.ok,
        error: fabricated.error,
        durationMs: Date.now() - started,
        artifacts: artifacts.slice(0, 40),
        notes: fabricated.notes,
      },
    });
  }
  if (path === WEB_API_PREFIX + "/clocks") {
    // 时钟页：读工程 .ioc 里 CubeMX 已经写下的各路频率，只读不改。
    const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
    const projectDir = firmwareProject(requested);
    if (projectDir === "") return fail(400, PROJECT_DIR_REQUIRED);
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
    const projectDir = firmwareProject(requested);
    if (projectDir === "") return fail(400, PROJECT_DIR_REQUIRED);
    const read = readIocDiff(projectDir, env);
    if (!read.ok) return fail(409, read.error);
    return ok({ diff: read.report });
  }
  if (path === WEB_API_PREFIX + "/ioc-diff/save") {
    // 记录基线：把当前 .ioc 复制到用户目录。只写自己的基线文件，不动工程。
    const requested = typeof parsed.value.projectDir === "string" ? parsed.value.projectDir.trim() : "";
    const projectDir = firmwareProject(requested);
    if (projectDir === "") return fail(400, PROJECT_DIR_REQUIRED);
    const saved = saveIocSnapshot(projectDir, env);
    if (!saved.ok) return fail(409, saved.error);
    return ok({ snapshot: saved.report });
  }
  if (path === WEB_API_PREFIX + "/ioc-diff/restore") {
    // 把 baseline 里的一个键写回 .ioc：只改这一行，写前备份。
    const requested = typeof parsed.value.projectDir === "string" ? parsed.value.projectDir.trim() : "";
    const key = typeof parsed.value.key === "string" ? parsed.value.key : "";
    if (key.trim() === "") return fail(400, "key 不能为空");
    const dir = firmwareProject(requested);
    if (dir === "") return fail(400, PROJECT_DIR_REQUIRED);
    const restored = restoreIocKey(dir, key, env);
    if (!restored.ok) return fail(409, restored.error);
    return ok({ restored: restored.report });
  }
  if (path === WEB_API_PREFIX + "/ioc-keys") {
    // 引脚页点「ioc」：读这个引脚在 .ioc 里占的键，只读。
    const requested = typeof query["projectDir"] === "string" ? query["projectDir"].trim() : "";
    const pin = typeof query["pin"] === "string" ? query["pin"] : "";
    if (pin.trim() === "") return fail(400, "pin 不能为空");
    const dir = firmwareProject(requested);
    if (dir === "") return fail(400, PROJECT_DIR_REQUIRED);
    const keys = readIocKeysForPin(dir, pin, env);
    if (!keys.ok) return fail(409, keys.error);
    return ok({ iocKeys: keys.report });
  }
  if (path === WEB_API_PREFIX + "/ioc-diff/restore-all") {
    // 一次性把改动/删除的键恢复成基线值，整批只备份一次。
    const requested = typeof parsed.value.projectDir === "string" ? parsed.value.projectDir.trim() : "";
    const dir = firmwareProject(requested);
    if (dir === "") return fail(400, PROJECT_DIR_REQUIRED);
    const restored = restoreAllIocKeys(dir, env);
    if (!restored.ok) return fail(409, restored.error);
    return ok({ restoredAll: restored.report });
  }
  if (path === WEB_API_PREFIX + "/evidence") {
    // 回放：列出证据目录里可载入的 jsonl 文件。只读目录，不读内容。
    const root = evidenceRoot(env);
    const files = await listEvidenceFiles(root);
    const bytes = files.reduce((sum, file) => sum + file.size, 0);
    return ok({
      evidence: { root, files, groups: groupEvidenceFiles(files), usage: { count: files.length, bytes }, policy: evidencePolicy(env) },
    });
  }
  if (path === WEB_API_PREFIX + "/evidence/prune") {
    // 保留策略：按配置的天数与会话数清最旧的；面板也给一个手动入口。
    const policy = evidencePolicy(env);
    const pruned = await pruneEvidence({ env, keepDays: policy.keepDays, keepSessions: policy.keepSessions });
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
    const projectDir = firmwareProject(requested);
    if (projectDir === "") return fail(400, PROJECT_DIR_REQUIRED);
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
    if (isForeignDebugSession(requestSession)) {
      return fail(409, "当前调试会话由另一条会话启动：断点要在启动它的会话里操作");
    }
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
  if (path === WEB_API_PREFIX + "/debug/stop") {
    // 人在面板上关会话：释放 gdb/openocd 与探针；没有会话时也返回 200（关闭是幂等的）。
    const stopped = await debugSessions.stop("面板关闭");
    return ok({ debug: { ...debugSessions.status(), stopped: stopped.stopped, message: stopped.message } });
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
