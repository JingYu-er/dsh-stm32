/**
 * 回合末自动构建（S136）。
 *
 * 目标：你在对话里改完电路源码，回到 KiCad 就能看到最新的原理图与 PCB，不必先想起点按钮。
 * 三条约束换来「不烦人」：
 *   1. 只在源码比产物新、或上次构建失败时才跑；
 *   2. 每回合最多一次，两次之间至少 60 s；
 *   3. 只跑构建 + 检查（ERC/DRC/DFM），不导出 Gerber/STEP——导出是一次性交付动作，留在按钮里。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { SubprocessService } from "../../types.js";
import { runEcadDesign, type DesignResult } from "./design.js";
import type { EcadToolchain } from "./toolchain.js";
import { runtimeReady } from "./runtime.js";
import type { EcadWorkspace } from "./tsci.js";

/** 两次自动构建之间的最小间隔：防止连续小改动把机器拖满。 */
export const AUTO_BUILD_MIN_INTERVAL_MS = 60_000;

export interface EcadAutoState {
  readonly lastAttemptAt: number;
  readonly lastOk: boolean;
  readonly lastError: string;
  readonly lastDurationMs: number;
  /** 触发这次构建的回合标识（一般用会话 id + 时间），用于「每回合一次」判定。 */
  readonly lastTurn: string;
  /** 设计通过检查、但还没导出 STEP/Gerber：向用户提示一次，导出后清掉。 */
  readonly pendingExport: boolean;
}

export function ecadStateFile(projectDir: string): string {
  return join(projectDir, ".dsh-stm32", "ecad-state.json");
}

export function readAutoState(projectDir: string): EcadAutoState | null {
  const file = ecadStateFile(projectDir);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<EcadAutoState>;
    return {
      lastAttemptAt: typeof raw.lastAttemptAt === "number" ? raw.lastAttemptAt : 0,
      lastOk: raw.lastOk === true,
      lastError: typeof raw.lastError === "string" ? raw.lastError : "",
      lastDurationMs: typeof raw.lastDurationMs === "number" ? raw.lastDurationMs : 0,
      lastTurn: typeof raw.lastTurn === "string" ? raw.lastTurn : "",
      pendingExport: raw.pendingExport === true,
    };
  } catch {
    return null;
  }
}

export function writeAutoState(projectDir: string, state: EcadAutoState): void {
  const file = ecadStateFile(projectDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2) + "\n", "utf8");
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".history", ".git", "build"]);

/** 目录里最新的修改时间；不存在返回 0。 */
function newestMtime(path: string, accept: (name: string) => boolean, depth = 0): number {
  if (depth > 6 || !existsSync(path)) return 0;
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return 0;
  }
  if (stat.isFile()) return accept("") ? stat.mtimeMs : 0;
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      newest = Math.max(newest, newestMtime(join(path, entry.name), accept, depth + 1));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!accept(entry.name)) continue;
    try {
      newest = Math.max(newest, statSync(join(path, entry.name)).mtimeMs);
    } catch {
      // 读不到就跳过：这是启发式判断，不值得中断。
    }
  }
  return newest;
}

const isSourceFile = (name: string): boolean =>
  name.endsWith(".circuit.tsx") || name.endsWith(".circuit.ts") || name.endsWith(".kicad_mod") || name.endsWith(".kicad_sym");

const isProductFile = (name: string): boolean => name.endsWith(".kicad_pcb") || name.endsWith(".kicad_sch");

export interface DirtyReport {
  readonly dirty: boolean;
  readonly reason: string;
  readonly sourceMtime: number;
  readonly productMtime: number;
}

/** 电路源码是否比产物新。产物缺失也算脏（从没成功构建过）。 */
export function circuitDirty(workspace: EcadWorkspace): DirtyReport {
  const sourceMtime = Math.max(
    newestMtime(workspace.circuitDir, isSourceFile),
    newestMtime(workspace.libsDir, isSourceFile),
  );
  const productMtime = newestMtime(workspace.kicadDir, isProductFile);
  if (productMtime === 0) {
    return { dirty: sourceMtime > 0, reason: sourceMtime > 0 ? "还没有可用产物" : "没有电路源码", sourceMtime, productMtime };
  }
  if (sourceMtime > productMtime) {
    return { dirty: true, reason: "源码比产物新", sourceMtime, productMtime };
  }
  return { dirty: false, reason: "产物已是最新", sourceMtime, productMtime };
}

export interface AutoBuildDecision {
  readonly go: boolean;
  readonly reason: string;
}

export interface DecideInput {
  readonly dirty: DirtyReport;
  readonly state: EcadAutoState | null;
  readonly now: number;
  readonly turn: string;
  readonly minIntervalMs?: number;
}

/** 是否该跑一次自动构建。纯函数，便于单测覆盖三种拒绝理由。 */
export function decideAutoBuild(input: DecideInput): AutoBuildDecision {
  if (!input.dirty.dirty) return { go: false, reason: input.dirty.reason };
  const minInterval = input.minIntervalMs ?? AUTO_BUILD_MIN_INTERVAL_MS;
  const state = input.state;
  if (state !== null) {
    if (state.lastTurn === input.turn && state.lastTurn !== "") {
      return { go: false, reason: "本回合已经构建过" };
    }
    if (input.now - state.lastAttemptAt < minInterval) {
      const wait = Math.ceil((minInterval - (input.now - state.lastAttemptAt)) / 1000);
      return { go: false, reason: "距上次构建不足 " + String(wait) + " s" };
    }
  }
  return { go: true, reason: input.dirty.reason };
}

export interface AutoBuildRequest {
  readonly subprocess: SubprocessService;
  readonly toolchain: EcadToolchain;
  readonly workspace: EcadWorkspace;
  readonly turn: string;
  readonly now?: number;
  readonly minIntervalMs?: number;
  readonly signal?: AbortSignal;
}

export interface AutoBuildResult {
  readonly ran: boolean;
  readonly reason: string;
  readonly ok: boolean;
  readonly error: string;
  readonly durationMs: number;
  readonly design: DesignResult | null;
}

/**
 * 跑一次回合末自动构建。
 *
 * 运行时还没装时直接跳过——安装 730 MB 必须由用户点一次确认，不能藏在回合结束里。
 */
export async function runAutoBuild(request: AutoBuildRequest): Promise<AutoBuildResult> {
  const { subprocess, toolchain, workspace } = request;
  const now = request.now ?? Date.now();
  const dirty = circuitDirty(workspace);
  const state = readAutoState(workspace.projectDir);
  const decision = decideAutoBuild({ dirty, state, now, turn: request.turn, minIntervalMs: request.minIntervalMs });
  if (!decision.go) return { ran: false, reason: decision.reason, ok: false, error: "", durationMs: 0, design: null };
  if (!existsSync(join(workspace.circuitDir, "node_modules", "tscircuit", "cli.mjs"))) {
    return { ran: false, reason: "依赖还没装：先在一键设计里确认安装共享运行时", ok: false, error: "", durationMs: 0, design: null };
  }
  const started = Date.now();
  const design = await runEcadDesign({
    subprocess,
    toolchain,
    workspace,
    artifacts: false,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  const durationMs = Date.now() - started;
  writeAutoState(workspace.projectDir, {
    lastAttemptAt: now,
    lastOk: design.ok,
    lastError: design.error,
    lastDurationMs: durationMs,
    lastTurn: request.turn,
    // 通过检查就挂一个「待导出」标记：STEP/Gerber 是交付动作，等用户点头再导。
    pendingExport: design.ok,
  });
  return { ran: true, reason: decision.reason, ok: design.ok, error: design.error, durationMs, design };
}

/** 运行时是否已就绪（面板用一句话说明「依赖装在哪」）。 */
export function runtimeLinked(circuitDir: string): boolean {
  return existsSync(join(circuitDir, "node_modules", "tscircuit", "cli.mjs"));
}

export { runtimeReady };
