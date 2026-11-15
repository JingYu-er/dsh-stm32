/**
 * KiCadRoutingTools 运行时（S145）。
 *
 * 我们不再自己写布线器：把 `drandyhaas/KiCadRoutingTools`（MIT）当作外部运行时，
 * 由它做平面、扇出、去耦、差分与布线，我们只负责调用、解析与呈现。
 * 运行时要落在一个固定目录（默认 `~/.dsh-stm32/kicad-routing-tools`），
 * 里面必须有 `py_router/autoroute.py` 与编译好的 `grid_router` 模块。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SubprocessService } from "../../../types.js";
import { runCapture } from "../../subprocess-runner.js";

export interface KrtRuntime {
  root: string;
  python: string;
}

export interface KrtLocate {
  runtime: KrtRuntime | null;
  error: string;
}

export interface KrtPlanStep {
  tag: string;
  tool: string;
  what: string;
  why: string;
  optional: boolean;
}

export interface KrtAutorouteReport {
  ok: boolean;
  error: string;
  output: string;
  dryRun: boolean;
  seconds: number;
  steps: KrtPlanStep[];
  openNets: number | null;
  drc: number | null;
  warnings: string[];
  log: string;
}

const AUTHOROUTE_REL = join("py_router", "autoroute.py");

/**
 * tscircuit 导出的 `.kicad_pcb` 把层名写成不带引号的形式（`(layer F.Cu)`），
 * KiCad 自己认，但 KiCadRoutingTools 的解析器只认带引号的写法，读不到就把
 * 800 多条既有走线当成「不存在」——布线器会从这些铜箔中间穿过去，结果全是短接。
 * 喂给引擎之前统一成带引号的写法（S145）。只处理单行、明确是层名的位置，
 * 不碰 `(layers ...)` 这种跨行表，否则会把文件写坏。
 */
/** 运行时根目录：显式变量优先，否则落在插件自己的 home 下。 */
export function krtRoot(env: Record<string, string | undefined> = process.env): string {
  const explicit = (env["DSH_STM32_KRT_ROOT"] ?? "").trim().replace(/\\/gu, "/");
  if (explicit !== "") return explicit;
  const home = (env["DSH_STM32_HOME"] ?? "").trim().replace(/\\/gu, "/");
  const base = home !== "" ? home : (env["USERPROFILE"] ?? env["HOME"] ?? "").trim().replace(/\\/gu, "/") + "/.dsh-stm32";
  return base + "/kicad-routing-tools";
}

/** 运行时是否可用：脚本在即可用；Rust 模块可能装在 python 的 site-packages 里。 */
export function krtStatus(root: string): { ok: boolean; error: string; hasModule: boolean } {
  if (!existsSync(join(root, AUTHOROUTE_REL))) {
    return { ok: false, error: "KiCadRoutingTools 还没安装：把仓库放到 " + root, hasModule: false };
  }
  const hasModule = existsSync(join(root, "grid_router.pyd")) || existsSync(join(root, "grid_router.so"));
  return { ok: true, error: "", hasModule };
}

/** 读取 VERSION，用于在报告里标注引擎版本。 */
export function krtVersion(root: string): string {
  const file = join(root, "VERSION");
  if (!existsSync(file)) return "";
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

export function quoteLayerNames(text: string): { text: string; quoted: number } {
  let quoted = 0;
  let out = text.replace(/\(layer ([A-Za-z0-9]+\.[A-Za-z0-9]+)\)/gu, (_whole, name: string) => {
    quoted += 1;
    return '(layer "' + name + '")';
  });
  out = out.replace(/\(layers ([^)\n]*)\)/gu, (whole, body: string) => {
    const names = body.split(/\s+/u).filter((item) => item !== "");
    if (names.length < 2 || names.some((item) => item.includes("("))) return whole;
    if (names.every((item) => item.startsWith('"'))) return whole;
    quoted += 1;
    return "(layers " + names.map((item) => (item.startsWith('"') ? item : '"' + item + '"')).join(" ") + ")";
  });
  return { text: out, quoted };
}

interface RawStep {
  tag?: string;
  tool?: string;
  what?: string;
  why?: string;
  optional?: boolean;
  state?: string;
  result?: string;
  seconds?: number;
}

function parseJsonLine(line: string, prefix: string): unknown {
  if (!line.startsWith(prefix)) return null;
  const body = line.slice(prefix.length).trim();
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/** 解析 autoroute.py 的 stdout：计划、步骤、摘要与告警。 */
export function parseAutorouteLog(text: string): {
  steps: KrtPlanStep[];
  openNets: number | null;
  drc: number | null;
  warnings: string[];
  error: string;
} {
  const steps: KrtPlanStep[] = [];
  const warnings: string[] = [];
  let openNets: number | null = null;
  let drc: number | null = null;
  let error = "";

  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("WARNING:")) {
      warnings.push(line.slice("WARNING:".length).trim());
      continue;
    }
    const plan = parseJsonLine(line, "AUTOROUTE_PLAN:") as { steps?: RawStep[] } | null;
    if (plan !== null && Array.isArray(plan.steps)) {
      for (const step of plan.steps) {
        steps.push({
          tag: step.tag ?? "",
          tool: step.tool ?? "",
          what: step.what ?? "",
          why: step.why ?? "",
          optional: step.optional === true,
        });
      }
      continue;
    }
    const summary = parseJsonLine(line, "AUTOROUTE_SUMMARY:") as {
      open_nets?: number | null;
      open?: number | null;
      drc_items?: number | null;
      error?: string | null;
    } | null;
    if (summary !== null) {
      // 不同版本里这个字段叫 open_nets 或 open，两个都认。
      if (typeof summary.open_nets === "number") openNets = summary.open_nets;
      else if (typeof summary.open === "number") openNets = summary.open;
      if (typeof summary.drc_items === "number") drc = summary.drc_items;
      if (typeof summary.error === "string" && summary.error !== "") error = summary.error;
      continue;
    }
  }
  return { steps, openNets, drc, warnings, error };
}

export interface KrtAutorouteRequest {
  subprocess: SubprocessService;
  runtime: KrtRuntime;
  inputPcb: string;
  outputPcb: string;
  dryRun: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * 跑一次 autoroute。`dryRun` 只出计划不落盘；非 dryRun 时输出到 `outputPcb`。
 * 注意：引擎的子进程会从临时工作目录启动，Rust 模块装在 python 的 site-packages 里才稳，
 * 所以这里额外把运行时根目录塞进 PYTHONPATH 作为兜底。
 */
export async function runKrtAutoroute(request: KrtAutorouteRequest): Promise<KrtAutorouteReport> {
  const args = [join(request.runtime.root, AUTHOROUTE_REL), request.inputPcb, request.outputPcb];
  if (request.dryRun) args.push("--dry-run");
  const started = Date.now();
  const result = await runCapture(request.subprocess, {
    argv: [request.runtime.python, ...args],
    cwd: request.runtime.root,
    env: { PYTHONPATH: [request.runtime.root, process.env["PYTHONPATH"] ?? ""].filter((item) => item !== "").join(";") },
    timeoutMs: request.timeoutMs ?? 1_800_000,
    maxBytes: 8 * 1024 * 1024,
    signal: request.signal,
  });
  const parsed = parseAutorouteLog(result.stdout);
  const seconds = Math.max(0.1, Math.round((Date.now() - started) / 100) / 10);
  const outputReady = request.dryRun || existsSync(request.outputPcb);
  const exitOk = result.exitCode === 0 && result.spawnError === null;
  const failure = parsed.error !== ""
    ? parsed.error
    : result.timedOut
      ? "路由超时（" + String(Math.round(seconds)) + " 秒）"
      : exitOk && outputReady
        ? ""
        : "路由没有产出板子：" + (result.stderr.split(/\r?\n/u).filter((line) => line.trim() !== "").slice(-1)[0] ?? "未知原因");
  return {
    ok: failure === "",
    error: failure,
    output: request.dryRun ? "" : request.outputPcb,
    dryRun: request.dryRun,
    seconds,
    steps: parsed.steps,
    openNets: parsed.openNets,
    drc: parsed.drc,
    warnings: parsed.warnings,
    log: result.stdout.slice(-4000),
  };
}

/** 连通性检查：`check_connected.py` 的文本输出里 "unconnected" 那几行最有用。 */
export async function runKrtConnectedCheck(request: {
  subprocess: SubprocessService;
  runtime: KrtRuntime;
  pcbFile: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; error: string; unconnected: number | null; text: string }> {
  const result = await runCapture(request.subprocess, {
    argv: [request.runtime.python, join(request.runtime.root, "py_router", "check_connected.py"), request.pcbFile],
    cwd: request.runtime.root,
    env: { PYTHONPATH: request.runtime.root },
    timeoutMs: request.timeoutMs ?? 300_000,
    maxBytes: 2 * 1024 * 1024,
    signal: request.signal,
  });
  const match = /(\d+)\s+(?:open|unconnected)\b/iu.exec(result.stdout);
  const unconnected = match === null ? null : Number.parseInt(match[1] ?? "0", 10);
  const exitOk = result.exitCode === 0 && result.spawnError === null;
  return {
    ok: exitOk,
    error: exitOk ? "" : "连通性检查失败：" + result.stderr.slice(-200),
    unconnected,
    text: result.stdout.slice(-2000),
  };
}
