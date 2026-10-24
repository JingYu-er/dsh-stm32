/**
 * 工具链门禁（L2）：干这件事之前，先确认这台机器干得了。
 *
 * 现状是靠"跑起来才报错"发现问题：stm32_build 会真的起 cmake，缺 ninja 时用户在
 * 一屏 cmake 输出里找原因。这里改成事前一次轻量判断：
 *   - 快路径只做文件存在性检查（resolveFromDirs，不 spawn），命中就零成本放行；
 *   - 没命中才跑 probeAll（一次版本命令，60 s 进程内缓存），拿到版本号和安装建议。
 *
 * 三个档位由工具参数 envCheck 决定：block（默认，缺就拒绝干活）/ warn（只警告）/ off（跳过）。
 * 拒绝时返回的是一句人话 + 一条可粘贴的安装动作，不是一个退出码。
 */

import {
  resolveSearchConfig,
  searchConfigWarnings,
  type SearchConfig,
} from "../data/search-roots.js";
import { readToolchainConfig, toolchainConfigPath } from "../data/toolchain-config.js";
import type { DshContext, SubprocessService } from "../types.js";
import {
  buildTargets,
  probeTarget,
  resolveFromDirs,
  type ProbeResult,
  type ProbeTarget,
} from "./probe.js";

/** 能力的粒度按"用户想干的事"分，不按工具分：编译/烧录/调试/代码生成。 */
export type ToolchainCapability = "build" | "flash" | "debug" | "generate";

/** 门禁档位：block 拒绝、warn 照做但写警告、off 完全不查。 */
export type EnvCheckMode = "block" | "warn" | "off";

/** 能力 → 必需组件（id 与 probe.buildTargets 一致）。 */
export const CAPABILITY_COMPONENTS: Record<ToolchainCapability, readonly string[]> = {
  build: ["gcc", "cmake", "ninja"],
  flash: ["openocd"],
  debug: ["openocd", "gdb"],
  generate: ["cubemx", "cubemx-java"],
};

const CAPABILITY_LABEL: Record<ToolchainCapability, string> = {
  build: "编译",
  flash: "烧录",
  debug: "调试",
  generate: "生成代码",
};

export interface GateMissing {
  id: string;
  label: string;
  /** 一句话：缺了它干不成什么。 */
  hint: string;
  /** 影响面（能干什么 / 干不了什么）。 */
  impact: string;
  /** 推荐安装步骤（第一条最省事，可直接粘贴）。 */
  install: string[];
  /** 装完怎么自检。 */
  verify: string;
  /** 探测时的错误（诊断用；「宿主没 subprocess」这类信息就落在这里）。 */
  error?: string;
}

export interface GateResult {
  ok: boolean;
  capability: ToolchainCapability;
  mode: EnvCheckMode;
  /** 这次判断关注的组件 id（全部命中才是 ok）。 */
  checked: string[];
  missing: GateMissing[];
  /** 一句话人话，给 tool card 第一行。ok 时也有一句"齐全"，便于确认确实查过。 */
  message: string;
  /** 下一步建议（一句）。 */
  nextStep: string;
  /** 配置里认的 MSYS2 根；空串表示还没配置。 */
  msys64: string;
  configPath: string;
  /** 是否命中 60 s 探测缓存（诊断卡用）。 */
  cacheHit: boolean;
  durationMs: number;
  /** 面板/报告里可直接贴的多行说明。 */
  detail: string;
  /** 配置/环境变量里点名但本机不存在的目录（只提示，不改配置）。 */
  warnings: string[];
}

export interface ToolchainGateRequest {
  capability: ToolchainCapability;
  /** 与引擎层保持一致的搜索覆盖（工具参数）。 */
  binDirs?: string[];
  cubeMxRoots?: string[];
  /** 工具参数 envCheck，容错解析：不认识的值按 block。 */
  envCheck?: unknown;
  /** 额外超时（探测版本命令用）。 */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const PROBE_CACHE_TTL_MS = 60_000;
const probeCache = new Map<string, { at: number; results: ProbeResult[] }>();

/** 单测 / 换机器后清缓存。 */
export function resetGateCache(): void {
  probeCache.clear();
}

/** 容错解析 envCheck：缺省 block，写了不认识的值也按 block（保守）。 */
export function normalizeEnvCheck(value: unknown): EnvCheckMode {
  if (value === "off" || value === "warn" || value === "block") return value;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "off" || lowered === "warn" || lowered === "block") return lowered;
  }
  return "block";
}

function targetById(targets: readonly ProbeTarget[], id: string): ProbeTarget | undefined {
  return targets.find((target) => target.id === id);
}

/** 纯文件存在性判断：不走 PATH、不 spawn。命中就说明"这个目录里确实有"。 */
function locateFast(target: ProbeTarget, config: SearchConfig): string | null {
  for (const candidate of target.candidates) {
    const hit = resolveFromDirs(candidate, config.binDirs);
    if (hit !== null) return hit;
  }
  return null;
}

function toMissing(target: ProbeTarget, probe?: ProbeResult): GateMissing {
  const missing: GateMissing = {
    id: target.id,
    label: target.label,
    hint: target.hint,
    impact: target.impact,
    install: target.install,
    verify: target.verify,
  };
  const error = probe?.error ?? "";
  if (error !== "") missing.error = error;
  return missing;
}

function joinLabels(items: readonly GateMissing[]): string {
  return items.map((item) => item.label).join("、");
}

function buildMessage(
  capability: ToolchainCapability,
  mode: EnvCheckMode,
  missing: readonly GateMissing[],
): { message: string; nextStep: string } {
  const label = CAPABILITY_LABEL[capability];
  if (missing.length === 0) {
    return {
      message: "工具链齐全，" + label + "可以开始。",
      nextStep: "直接重跑当前工具即可。",
    };
  }
  const names = joinLabels(missing);
  const effect = missing.map((item) => item.hint).join("；");
  if (mode === "warn") {
    return {
      message: "⚠ 工具链不齐（缺 " + names + "），按 envCheck=warn 仍然继续，" + label + "大概率会失败。",
      nextStep: "失败原因大概率就是这个；装好再重跑，或把 envCheck 设成 block 先拦住。",
    };
  }
  return {
    message: "缺 " + names + "，这次没有开始" + label + "：" + effect + "。",
    nextStep:
      "要我装吗？回一句「装」，我先跑 stm32_env_install 出计划（只列大小与步骤、不下载），确认后才真装；"
      + "想自己装就看下面 missing[0].install 的第一条。",
  };
}

function buildDetail(
  capability: ToolchainCapability,
  mode: EnvCheckMode,
  checked: readonly string[],
  missing: readonly GateMissing[],
  msys64: string,
  configPath: string,
  cacheHit: boolean,
  warnings: readonly string[],
): string {
  const lines: string[] = [];
  lines.push("能力：" + CAPABILITY_LABEL[capability] + "（" + capability + "），envCheck=" + mode);
  lines.push("必需组件：" + checked.join("、"));
  if (missing.length === 0) {
    lines.push("结果：齐全。");
  } else {
    lines.push("结果：缺 " + String(missing.length) + " 项 ——");
    for (const item of missing) {
      lines.push("  · " + item.label + "：" + item.hint);
      lines.push("    影响：" + item.impact);
      lines.push("    安装：" + (item.install[0] ?? "（无建议）"));
      lines.push("    自检：" + item.verify);
    }
  }
  lines.push("MSYS2 配置：" + (msys64 === "" ? "未配置" : msys64) + "（" + configPath + "）");
  for (const warning of warnings) lines.push("⚠ " + warning);
  if (cacheHit) lines.push("（探测结果来自 60 s 缓存）");
  return lines.join("\n");
}

/**
 * 判断并给出结论。不抛异常：宿主缺 subprocess 时按"只做了文件存在性检查"处理。
 */
export async function ensureToolchain(
  ctx: DshContext,
  request: ToolchainGateRequest,
): Promise<GateResult> {
  const started = Date.now();
  const capability = request.capability;
  const mode = normalizeEnvCheck(request.envCheck);
  const checked = [...CAPABILITY_COMPONENTS[capability]];
  const configPath = toolchainConfigPath(process.env);
  const userConfig = readToolchainConfig(process.env).config;
  const msys64 = userConfig?.msys64 ?? "";
  const overrides: Partial<SearchConfig> = {};
  if (request.binDirs !== undefined) overrides.binDirs = request.binDirs;
  if (request.cubeMxRoots !== undefined) overrides.cubeMxRoots = request.cubeMxRoots;
  const config = resolveSearchConfig(process.env, overrides);
  const warnings = searchConfigWarnings(process.env).map((warning) => warning.message);

  if (mode === "off") {
    const { message, nextStep } = buildMessage(capability, mode, []);
    return {
      ok: true,
      capability,
      mode,
      checked,
      missing: [],
      message: message + "（envCheck=off，没有检查）",
      nextStep,
      msys64,
      configPath,
      cacheHit: false,
      durationMs: Date.now() - started,
      detail: "envCheck=off：跳过工具链检查。",
      warnings,
    };
  }

  const targets = buildTargets(config);
  const wanted: ProbeTarget[] = [];
  for (const id of checked) {
    const target = targetById(targets, id);
    if (target !== undefined) wanted.push(target);
  }

  // 快路径：文件都在就放行，一次 spawn 都不做。
  const unresolved: ProbeTarget[] = [];
  for (const target of wanted) {
    if (locateFast(target, config) === null) unresolved.push(target);
  }
  if (unresolved.length === 0) {
    return {
      ok: true,
      capability,
      mode,
      checked,
      missing: [],
      message: "工具链齐全（" + wanted.map((target) => target.label).join("、") + "），" + CAPABILITY_LABEL[capability] + "可以开始。",
      nextStep: "直接继续。",
      msys64,
      configPath,
      cacheHit: false,
      durationMs: Date.now() - started,
      detail: buildDetail(capability, mode, checked, [], msys64, configPath, false, warnings),
      warnings,
    };
  }

  // 慢路径：解析 + 一次版本命令（可能从 PATH 里找到），带 60 s 缓存。
  const cacheKey = [
    capability,
    config.binDirs.join(";"),
    config.cubeMxRoots.join(";"),
  ].join("|");
  let cacheHit = false;
  let probed: ProbeResult[] = [];
  const cached = probeCache.get(cacheKey);
  if (cached !== undefined && Date.now() - cached.at < PROBE_CACHE_TTL_MS) {
    cacheHit = true;
    probed = cached.results;
  } else {
    const subprocess = ctx.get<SubprocessService>("subprocess");
    if (subprocess === undefined) {
      probed = unresolved.map((target) => ({
        id: target.id,
        label: target.label,
        found: false,
        path: "",
        version: "",
        required: target.required,
        hint: target.hint,
        impact: target.impact,
        install: target.install,
        verify: target.verify,
        error: "宿主没有提供 subprocess 服务，只能做文件存在性检查",
      }));
    } else {
      const options: { timeoutMs: number; signal?: AbortSignal } = {
        timeoutMs: request.timeoutMs ?? 15_000,
      };
      if (request.signal !== undefined) options.signal = request.signal;
      for (const target of wanted) {
        probed.push(await probeTarget(subprocess, target, config, options));
        if (request.signal?.aborted === true) break;
      }
    }
    probeCache.set(cacheKey, { at: Date.now(), results: probed });
  }

  const missing: GateMissing[] = [];
  for (const target of wanted) {
    // 快路径已经确认过存在的组件不重复判缺：probe 失败只可能是版本命令本身有问题。
    if (!unresolved.includes(target)) continue;
    const probe = probed.find((item) => item.id === target.id);
    if (probe !== undefined && probe.found) continue;
    missing.push(toMissing(target, probe));
  }
  const { message, nextStep } = buildMessage(capability, mode, missing);
  return {
    ok: missing.length === 0,
    capability,
    mode,
    checked,
    missing,
    message,
    nextStep,
    msys64,
    configPath,
    cacheHit,
    durationMs: Date.now() - started,
    detail: buildDetail(capability, mode, checked, missing, msys64, configPath, cacheHit, warnings),
    warnings,
  };
}

/** 报告里的 notes 行：只在 blocked/warn 时写，免得成功路径噪音。 */
export function gateReportNotes(result: GateResult): string[] {
  // 配置告警与成败无关：即使这次齐全，也值得让用户知道"你配的某个路径本机没有"。
  if (result.ok) return result.warnings.map((warning) => "⚠ " + warning);
  const lines: string[] = [];
  lines.push(result.message);
  for (const item of result.missing) {
    lines.push("缺 " + item.label + "：" + item.hint);
    if (item.install[0] !== undefined) lines.push("  安装：" + item.install[0]);
  }
  if (result.nextStep !== "") lines.push(result.nextStep);
  for (const warning of result.warnings) lines.push("⚠ " + warning);
  return lines;
}

/** 一句话给别的工具拼失败报告用（tool card 第一行）。 */
export function gateBlockedMessage(result: GateResult): string {
  return result.message;
}
