/**
 * tscircuit 运行时（S136）。
 *
 * 一个工程装一次 730 MB 的依赖不现实：同一台机器上十几个工程，装十几遍既慢又占盘。
 * 这里把依赖装到用户目录下的共享运行时，再用目录联接把它挂到各工程的
 * `hardware/circuit/node_modules`——ESM 解析要求 node_modules 出现在工程树里，
 * 联接让它"看起来像"本地安装，磁盘只占一份。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { SubprocessService } from "../../types.js";
import { runCapture } from "../subprocess-runner.js";

/** 运行时自描述的版本号：结构变了就加一，读到旧版本按"未就绪"处理。 */
export const RUNTIME_META_VERSION = 1;
export const RUNTIME_PACKAGES = ["tscircuit", "typescript"] as const;

export interface EcadRuntimeMeta {
  readonly version: number;
  readonly packages: readonly string[];
  readonly installedAt: string;
  readonly nodeVersion: string;
}

export interface EnsureRuntimeOptions {
  readonly subprocess: SubprocessService;
  readonly dir: string;
  /** auto = 缺就装；ask = 只报告缺什么；off = 一律不装。 */
  readonly mode?: "auto" | "ask" | "off";
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface EnsureRuntimeResult {
  readonly ok: boolean;
  readonly error: string;
  readonly dir: string;
  /** 本次是否真的跑了 npm install。 */
  readonly installed: boolean;
  readonly meta: EcadRuntimeMeta | null;
  readonly notes: readonly string[];
}

/** 共享运行时目录：`DSH_STM32_ECAD_RUNTIME` 优先，否则 `~/.dsh-stm32/ecad-runtime`。 */
export function ecadRuntimeDir(env: Record<string, string | undefined> = process.env): string {
  const explicit = (env["DSH_STM32_ECAD_RUNTIME"] ?? "").trim();
  if (explicit !== "") return explicit;
  const home = (env["DSH_STM32_HOME"] ?? "").trim();
  if (home !== "") return join(home, "ecad-runtime");
  const userHome = (env["USERPROFILE"] ?? env["HOME"] ?? "").trim();
  return join(userHome === "" ? "." : userHome, ".dsh-stm32", "ecad-runtime");
}

export function runtimeMetaFile(dir: string): string {
  return join(dir, "runtime.json");
}

/** 运行时是否就绪：只看 `node_modules/tscircuit/cli.mjs` 在不在，不看 meta。 */
export function runtimeReady(dir: string): boolean {
  return existsSync(join(dir, "node_modules", "tscircuit", "cli.mjs"));
}

export function readRuntimeMeta(dir: string): EcadRuntimeMeta | null {
  const file = runtimeMetaFile(dir);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<EcadRuntimeMeta>;
    if (raw.version !== RUNTIME_META_VERSION) return null;
    return {
      version: RUNTIME_META_VERSION,
      packages: Array.isArray(raw.packages) ? raw.packages.map(String) : [...RUNTIME_PACKAGES],
      installedAt: typeof raw.installedAt === "string" ? raw.installedAt : "",
      nodeVersion: typeof raw.nodeVersion === "string" ? raw.nodeVersion : "",
    };
  } catch {
    return null;
  }
}

function writeRuntimeMeta(dir: string): EcadRuntimeMeta {
  const meta: EcadRuntimeMeta = {
    version: RUNTIME_META_VERSION,
    packages: [...RUNTIME_PACKAGES],
    installedAt: new Date().toISOString(),
    nodeVersion: process.versions.node,
  };
  writeFileSync(runtimeMetaFile(dir), JSON.stringify(meta, null, 2) + "\n", "utf8");
  return meta;
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

/**
 * 确保共享运行时可用。
 *
 * `mode: "ask"` 不安装，只回一句「缺什么、怎么装」——面板据此提示，避免点一下按钮
 * 就悄悄下 730 MB。`auto` 才真的执行 `npm install`。
 */
export async function ensureEcadRuntime(options: EnsureRuntimeOptions): Promise<EnsureRuntimeResult> {
  const { subprocess, dir } = options;
  const mode = options.mode ?? "ask";
  const notes: string[] = [];
  if (runtimeReady(dir)) {
    return { ok: true, error: "", dir, installed: false, meta: readRuntimeMeta(dir), notes: ["运行时已就绪"] };
  }
  const installHint =
    "装一次共享运行时（约 730 MB，所有工程共用）：" + npmCommand() + " install --no-audit --no-fund " +
    RUNTIME_PACKAGES.join(" ") + "（在 " + dir + " 下执行；或把 DSH_STM32_ECAD_AUTO_INSTALL 设为 auto 让插件自己装）";
  if (mode === "off" || mode === "ask") {
    return { ok: false, error: "tscircuit 运行时还没安装：" + installHint, dir, installed: false, meta: null, notes };
  }
  mkdirSync(dir, { recursive: true });
  const pkgFile = join(dir, "package.json");
  if (!existsSync(pkgFile)) {
    writeFileSync(
      pkgFile,
      JSON.stringify({ name: "dsh-stm32-ecad-runtime", private: true, version: "0.0.0" }, null, 2) + "\n",
      "utf8",
    );
  }
  const started = Date.now();
  const run = await runCapture(subprocess, {
    argv: [npmCommand(), "install", "--no-audit", "--no-fund", ...RUNTIME_PACKAGES],
    cwd: dir,
    env: { ...process.env } as Record<string, string>,
    timeoutMs: options.timeoutMs ?? 15 * 60_000,
    maxBytes: 2_000_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (run.exitCode !== 0 || !runtimeReady(dir)) {
    return {
      ok: false,
      error:
        "运行时安装失败（" + String(Math.round((Date.now() - started) / 1000)) + " s，exit " + String(run.exitCode) + "）：" +
        (run.stderr || run.stdout || run.spawnError || "npm 没有输出").slice(-400),
      dir,
      installed: true,
      meta: null,
      notes,
    };
  }
  const meta = writeRuntimeMeta(dir);
  notes.push("运行时安装完成：" + dir);
  return {
    ok: true,
    error: "",
    dir,
    installed: true,
    meta,
    notes,
  };
}

export interface LinkResult {
  readonly ok: boolean;
  readonly error: string;
  readonly kind: "created" | "exists" | "skipped";
  readonly target: string;
}

/**
 * 把共享运行时挂到工程的 `circuit/node_modules`。
 *
 * Windows 用目录联接（`fs.symlinkSync(target, path, "junction")`）——不需要管理员权限；
 * 其它平台用普通符号链接。已经存在时只检查指向，不覆盖（避免拆掉用户自己装的依赖）。
 */
export function linkRuntimeIntoProject(circuitDir: string, runtimeDir: string): LinkResult {
  const target = join(circuitDir, "node_modules");
  // 联接到运行时的 node_modules 本身，不是运行时根目录：工程里要的是 `node_modules/tscircuit`。
  const source = join(runtimeDir, "node_modules");
  if (!runtimeReady(runtimeDir)) {
    return { ok: false, error: "运行时还不就绪：" + runtimeDir, kind: "skipped", target };
  }
  if (!existsSync(join(circuitDir, "package.json"))) {
    return { ok: false, error: "工程还没初始化：" + circuitDir, kind: "skipped", target };
  }
  if (existsSync(target)) {
    return { ok: true, error: "", kind: "exists", target };
  }
  try {
    mkdirSync(dirname(target), { recursive: true });
    // 一次性建立联接，失败要立刻反馈给调用方，所以用同步调用。
    symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
    return { ok: true, error: "", kind: "created", target };
  } catch (error) {
    return {
      ok: false,
      error: "建立依赖联接失败：" + (error instanceof Error ? error.message : String(error)),
      kind: "skipped",
      target,
    };
  }
}

/** 运行时占用字节数（面板显示用）；读不到返回 0。 */
export function runtimeBytes(dir: string, limitEntries = 40_000): number {
  const modules = join(dir, "node_modules");
  if (!existsSync(modules)) return 0;
  let total = 0;
  let seen = 0;
  const walk = (path: string): void => {
    if (seen > limitEntries) return;
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > limitEntries) return;
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile()) {
        try {
          total += statSync(child).size;
        } catch {
          // 读不到大小就跳过：统计用途，不值得为它中断。
        }
      }
    }
  };
  walk(modules);
  return total;
}

/** 环境变量 `DSH_STM32_ECAD_AUTO_INSTALL`：auto / ask / off，默认 ask。 */
export function runtimeInstallMode(env: Record<string, string | undefined> = process.env): "auto" | "ask" | "off" {
  const raw = (env["DSH_STM32_ECAD_AUTO_INSTALL"] ?? "").trim().toLowerCase();
  if (raw === "auto" || raw === "true" || raw === "1") return "auto";
  if (raw === "off" || raw === "false" || raw === "0") return "off";
  return "ask";
}

export interface ProjectRuntimeResult {
  readonly ok: boolean;
  readonly error: string;
  readonly notes: readonly string[];
  readonly dir: string;
  readonly installed: boolean;
  readonly linked: boolean;
}

/**
 * 让一个工程具备可用的 tscircuit 依赖：共享运行时就绪 → 建联接；缺就按 mode 决定装不装。
 *
 * 这是构建前的唯一入口：工具层与面板都走它，免得两处各写一套判断。
 */
export async function ensureProjectRuntime(input: {
  readonly subprocess: SubprocessService;
  readonly circuitDir: string;
  readonly env?: Record<string, string | undefined>;
  readonly mode?: "auto" | "ask" | "off";
  readonly signal?: AbortSignal;
}): Promise<ProjectRuntimeResult> {
  const env = input.env ?? process.env;
  const dir = ecadRuntimeDir(env);
  const mode = input.mode ?? runtimeInstallMode(env);
  const notes: string[] = [];
  if (runtimeReady(join(input.circuitDir))) {
    return { ok: true, error: "", notes: ["依赖已就绪（工程内直接安装）"], dir: join(input.circuitDir, "node_modules"), installed: false, linked: false };
  }
  const ensured = await ensureEcadRuntime({
    subprocess: input.subprocess,
    dir,
    mode,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  notes.push(...ensured.notes);
  if (!ensured.ok) return { ok: false, error: ensured.error, notes, dir, installed: ensured.installed, linked: false };
  const link = linkRuntimeIntoProject(input.circuitDir, dir);
  notes.push(link.kind === "created" ? "依赖已联接到工程：" + link.target : "依赖联接已存在");
  if (!link.ok) return { ok: false, error: link.error, notes, dir, installed: ensured.installed, linked: false };
  return { ok: true, error: "", notes, dir, installed: ensured.installed, linked: link.kind === "created" };
}
