/**
 * L2：regs_read —— 在不停在调试会话里的前提下读一眼内存映射寄存器。
 *
 * 一次 openocd 调用：init → halt → 读 pc → 逐个 mdw → resume → shutdown。
 * 读的是物理地址（例如 GPIOC_ODR=0x4001100C），不需要调试器常驻，跑完探针就释放。
 *
 * 收尾用 resume 而不是 reset run：reset run 会把芯片复位，固件里的计数/状态全部从头开始，
 * "只读一眼"就变成了副作用（实测 led_prg 的计数器被清零）。halt 只是暂停，resume 原样继续跑。
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { resolveSearchConfig } from "../data/search-roots.js";
import type { SubprocessService } from "../types.js";
import { STATE_DIR } from "./generate.js";
import { defaultConfigs, findProjectConfig, quoteForDisplay, toOpenOcdPath } from "./flash.js";
import { resolveToolIn } from "./probe.js";
import { runStreaming } from "./subprocess-runner.js";
import type { RunOutcome } from "./subprocess-runner.js";

export interface RegsRequest {
  projectDir: string;
  /** 物理地址，可带或不带 0x（"0x4001100C" / "4001100C"）。 */
  addresses: string[];
  configFile?: string;
  adapterSpeed?: number;
  openOcdPath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  binDirs?: string[];
  onProgress?: (line: string) => void;
}

export interface RegsSample {
  address: string;
  value: string;
  ok: boolean;
}

export interface RegsReport {
  ok: boolean;
  projectDir: string;
  configFile: string;
  command: string;
  script: string;
  pc: string;
  samples: RegsSample[];
  durationMs: number;
  /** 没有退出码时省略（宿主输出校验不允许 null）。 */
  exitCode?: number;
  errors: string[];
  message: string;
  logTail: string;
  notes: string[];
}

/** "4001100c" / "0x4001100C" → "0x4001100C"；非法返回 null。 */
export function normalizeAddress(input: string): string | null {
  const trimmed = input.trim();
  const match = /^(?:0[xX])?([0-9a-fA-F]{1,8})$/u.exec(trimmed);
  if (match === null) return null;
  return "0x" + (match[1] ?? "").toUpperCase().padStart(8, "0");
}

export function buildRegsScript(addresses: string[]): string {
  // openocd 的 reg / mdw 在 Tcl 里返回的是列表，直接 echo 会带上 "pc (/32):" 或
  // "0x4001100c: " 之类的前缀，所以先 lindex 取出值再打印，日志更好解析。
  const lines = ["init", "halt", 'echo "PC [lindex [reg pc] 1]"'];
  for (const address of addresses) lines.push('echo "REG ' + address + ' [lindex [mdw ' + address + '] 1]"');
  lines.push("resume", "shutdown");
  return lines.join("\n") + "\n";
}

/** openocd 打出来的字可能是 "00002000"，也可能是 "0x4001100c: 00000000"；统一成 0x + 8 位小写。 */
function normalizeWordValue(raw: string): string {
  const colon = /:([^:]*)$/u.exec(raw);
  const tail = colon === null ? raw : (colon[1] ?? "");
  const hex = /([0-9a-fA-F]{1,8})/u.exec(tail.trim());
  if (hex === null) return "";
  return "0x" + (hex[1] ?? "").toLowerCase().padStart(8, "0");
}

/** 从 openocd 输出里抽 PC 与各地址的值；读失败的地址 ok=false、value=""。 */
export function parseRegsLog(text: string, addresses: string[]): { pc: string; samples: RegsSample[] } {
  const values = new Map<string, string>();
  let pc = "";
  let pcFromEcho = "";
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    // halt 横幅 xPSR: 0x21000000 pc: 0x08000210 msp: 0x20004fdc 是最可靠的 pc 来源
    const bannerMatch = /\bpc:\s*(0x[0-9a-fA-F]+)/u.exec(trimmed);
    if (bannerMatch !== null && pc === "") pc = (bannerMatch[1] ?? "").toLowerCase();
    const echoPcMatch = /^PC\b[^\n]*?(0x[0-9a-fA-F]+)/u.exec(trimmed);
    if (echoPcMatch !== null) pcFromEcho = (echoPcMatch[1] ?? "").toLowerCase();
    const regMatch = /^REG\s+(?:0[xX])?([0-9a-fA-F]{1,8})\s+(.*)$/u.exec(trimmed);
    if (regMatch !== null) {
      const address = "0x" + (regMatch[1] ?? "").toLowerCase().padStart(8, "0");
      const value = normalizeWordValue(regMatch[2] ?? "");
      if (value !== "") values.set(address, value);
    }
  }
  if (pc === "") pc = pcFromEcho;
  const samples: RegsSample[] = addresses.map((address) => {
    const key = "0x" + address.replace(/^0[xX]/u, "").toLowerCase().padStart(8, "0");
    const value = values.get(key) ?? "";
    return { address, value, ok: value !== "" };
  });
  return { pc, samples };
}

export async function runRegsRead(subprocess: SubprocessService, request: RegsRequest): Promise<RegsReport> {
  const projectDir = resolve(request.projectDir);
  const startedAt = Date.now();
  const progress = request.onProgress ?? ((): void => undefined);
  const errors: string[] = [];
  const notes: string[] = [];
  const base: Omit<RegsReport, "ok" | "message"> = {
    projectDir,
    configFile: "",
    command: "",
    script: "",
    pc: "",
    samples: [],
    durationMs: 0,
    errors,
    logTail: "",
    notes,
  };

  const addresses: string[] = [];
  for (const raw of request.addresses) {
    const normalized = normalizeAddress(raw);
    if (normalized === null) {
      errors.push("地址不合法：" + raw + "（要 1–8 位十六进制，例如 0x4001100C）");
      continue;
    }
    if (!addresses.includes(normalized)) addresses.push(normalized);
  }
  if (errors.length > 0) {
    return { ...base, ok: false, errors, message: "参数有误，没读寄存器" };
  }
  if (addresses.length === 0) {
    return { ...base, ok: false, errors: ["至少要给一个地址"], message: "参数有误，没读寄存器" };
  }

  const config = resolveSearchConfig(process.env, request.binDirs === undefined ? {} : { binDirs: request.binDirs });
  const openOcd = request.openOcdPath !== undefined && request.openOcdPath !== ""
    ? request.openOcdPath
    : await resolveToolIn(subprocess, ["openocd"], config.binDirs);
  if (openOcd === null) {
    return { ...base, ok: false, errors: ["找不到 openocd"], message: "没读：找不到 openocd" };
  }

  const configs: string[] = [];
  const projectConfig = findProjectConfig(projectDir, request.configFile);
  if (projectConfig !== null) {
    configs.push(toOpenOcdPath(projectConfig));
  } else {
    const fallback = defaultConfigs();
    configs.push(fallback.interfaceConfig, fallback.targetConfig);
    notes.push("工程里没有 openocd 配置文件，回退到 " + configs.join(" + "));
  }

  const script = buildRegsScript(addresses);
  const tmpDir = join(projectDir, STATE_DIR, "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const scriptPath = join(tmpDir, "regs-" + String(startedAt) + ".tcl");
  writeFileSync(scriptPath, script, "utf8");

  const args: string[] = [openOcd];
  for (const cfg of configs) args.push("-f", cfg);
  if (request.adapterSpeed !== undefined) args.push("-c", "adapter speed " + String(request.adapterSpeed));
  args.push("-c", "source " + toOpenOcdPath(scriptPath));
  const command = args.map(quoteForDisplay).join(" ");
  progress("读寄存器：" + addresses.join(" "));

  let outcome: RunOutcome;
  try {
    outcome = await runStreaming(subprocess, {
      argv: args,
      cwd: projectDir,
      timeoutMs: request.timeoutMs ?? 30_000,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      onOutput: (stream, text) => {
        for (const line of text.split(/\r?\n/u)) if (line.trim() !== "") progress(line.trim());
      },
    });
  } finally {
    rmSync(scriptPath, { force: true });
  }

  const log = outcome.stdout + "\n" + outcome.stderr;
  const parsed = parseRegsLog(log, addresses);
  for (const line of log.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (/^Error:/u.test(trimmed) && !errors.includes(trimmed)) errors.push(trimmed);
  }
  if (outcome.spawnError !== null) errors.push("openocd 启动失败：" + outcome.spawnError);
  if (outcome.timedOut) errors.push("超时（" + String(request.timeoutMs ?? 30_000) + " ms）：没读完");
  const missing = parsed.samples.filter((sample) => !sample.ok).map((sample) => sample.address);
  if (missing.length > 0) errors.push("这些地址没读到：" + missing.join(", "));
  if (errors.some((line) => /Error connecting DP/u.test(line))) {
    notes.push("连不上芯片：固件可能关了 SWD（__HAL_AFIO_REMAP_SWJ_DISABLE），用 BOOT0=1 进系统 bootloader 救回来后重新烧。");
  }

  const ok = outcome.exitCode === 0 && outcome.spawnError === null && !outcome.timedOut && errors.length === 0;
  if (!ok && errors.length === 0) errors.push("openocd 退出码 " + String(outcome.exitCode));
  const readValues = parsed.samples.filter((sample) => sample.ok).length;
  const message = ok
    ? "读到 " + String(readValues) + " 个地址（pc=" + (parsed.pc === "" ? "未知" : parsed.pc) + "）"
    : "读寄存器失败：" + (errors[0] ?? "未知原因");

  return {
    ok,
    projectDir,
    configFile: configs.join(" "),
    command,
    script,
    pc: parsed.pc,
    samples: parsed.samples,
    durationMs: Date.now() - startedAt,
    ...(outcome.exitCode === null ? {} : { exitCode: outcome.exitCode }),
    errors,
    message,
    logTail: log.split(/\r?\n/u).slice(-20).join("\n"),
    notes,
  };
}

export function describeSample(sample: RegsSample): string {
  return sample.address + " = " + (sample.ok ? sample.value : "（读不到）");
}
