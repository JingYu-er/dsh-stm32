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
import { resolveSearchConfig } from "../data/search-roots.js";
import { buildTargets, probeAll, type ProbeResult } from "./probe.js";
import { planOrInstallMsys2, type Msys2InstallResult } from "./msys2-install.js";
import type { SubprocessService } from "../types.js";

/** 面板能看到的四类能力（与 stm32_env_probe 同一口径）。 */
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
  /** 宿主 subprocess：探测版本、跑 pacman 都要它。 */
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

/** 面板打开时读一次：配置内容 + 由它推导出的 binDirs / CubeMX 根。 */
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

export const WEB_API_PATHS: readonly string[] = [
  WEB_API_PREFIX + "/config",
  WEB_API_PREFIX + "/config/save",
  WEB_API_PREFIX + "/probe",
  WEB_API_PREFIX + "/install/plan",
  WEB_API_PREFIX + "/install/start",
  WEB_API_PREFIX + "/install/state",
];

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
  const needsBody = path !== WEB_API_PREFIX + "/config" && path !== WEB_API_PREFIX + "/install/state";
  if (needsBody && method !== "POST") return fail(405, "这个接口只接受 POST");
  if (!needsBody && method !== "GET") return fail(405, "这个接口只接受 GET");
  const parsed = needsBody ? parseJsonBody(input.body ?? "") : { ok: true, value: {} as Record<string, unknown>, error: "" };
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
  return fail(404, "没有这个接口：" + path);
}

/** 单测用：清空安装任务表。 */
export function resetInstallTasks(): void {
  installTasks.clear();
}
