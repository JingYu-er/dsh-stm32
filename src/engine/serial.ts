/**
 * 串口引擎（P1，只做 Windows）：Node 侧是一个「文件 IPC 客户端」，真正的串口握在
 * 一个 detached 的 PowerShell 进程里（templates/serial/bridge.ps1）。
 *
 * 为什么这么绕：插件有硬性的零 npm 依赖要求，而 Node 没有内建串口；Windows 自带
 * PowerShell + System.IO.Ports.SerialPort，于是把「谁持有 COM 口」这件事隔离到桥进程：
 *   - 桥进程 detached + unref：DSH 的工具调用是短命的，串口不能跟着一次调用结束；
 *   - 桥自己每 5 s 查一次 parent PID：DSH 被杀（关窗口 / 重启宿主）时它必须自己退，
 *     否则那个 COM 口就永远是「被占用」，用户只能重启机器；
 *   - 通信只走文件：不用 socket、不用额外端口，出问题能直接 cat 目录里的东西复现。
 *
 * 文件布局（%USERPROFILE%/.dsh-stm32/serial/<sessionId>/，DSH_STM32_SERIAL_HOME 可改根）：
 *   session.json  open 前写好的打开参数（桥只读一次）
 *   status.json   opening / open / closed / error + 计数器 + 错误分类
 *   rx.ndjson     收到的行 {t,d[,p]}；p=true 表示「没有换行的残行」（提示符这类）
 *   tx.ndjson     发出去的内容 {t,d,n}
 *   cmd/<id>.json 命令（先写临时文件再 rename，桥不会读到半截 JSON）
 *   done/<id>.json 命令回执（send 最多等 2 s）
 *   bridge.pid / bridge.log
 *
 * 生命周期与超时（全部是契约，改之前先看这里）：
 *   open   等 status.state=open 最多 5 s（OPEN_WAIT_MS）
 *   send   等 done/<id>.json 最多 2 s（ACK_WAIT_MS）
 *   close  先发 close 命令等 3 s（CLOSE_GRACE_MS），还不走就强杀
 *   桥自检 parent PID 每 5 s 一次；空闲 idleTimeoutMs（默认 10 min）自动放口
 *
 * 单会话：模块级 active 只允许一个。重复 open 报 already-open（提示先 close），
 * 这样「同一个 COM 口被两个逻辑会话抢」这种最难查的问题在源头就不存在。
 *
 * 环境变量（都是为了可测与隔离）：
 *   DSH_STM32_SERIAL_BRIDGE    覆盖 bridge 脚本路径；指向 .js/.mjs/.cjs 时改用 node 跑（假桥，单测用）
 *   DSH_STM32_SERIAL_POWERSHELL 覆盖 powershell 可执行文件（默认 powershell.exe，退回 pwsh.exe）
 *   DSH_STM32_SERIAL_HOME      覆盖 IPC 根目录（默认 %USERPROFILE%/.dsh-stm32/serial）
 *   DSH_STM32_SERIAL_PORTS     直接给出端口清单 JSON（跳过 WMI 查询，单测用）
 *   DSH_STM32_SERIAL_CONFIG    serial.json 路径（见 data/serial-config.ts）
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SERIAL_BAUD_MAX,
  SERIAL_BAUD_MIN,
  SERIAL_DATA_BITS_MAX,
  SERIAL_DATA_BITS_MIN,
  SERIAL_ENCODINGS,
  SERIAL_FLOWS,
  SERIAL_NEWLINES,
  SERIAL_PARITIES,
  SERIAL_STOP_BITS,
  defaultSerialSettings,
  normalizeSerialSettings,
  portIdentity,
  readSerialConfig,
  recallPortSettings,
  rememberPort,
  serialConfigPath,
} from "../data/serial-config.js";
import type {
  SerialEncoding,
  SerialFlow,
  SerialNewline,
  SerialParity,
  SerialPortFacts,
  SerialSettings,
  SerialStopBits,
} from "../data/serial-config.js";
import type { JsonSchema } from "../types.js";

// ── 默认值与上限 ─────────────────────────────────────────────────────────────

/** 一次 open 之后的通信缺省值；工具层 schema 的 default 也从这里取（只有一份真相）。 */
export const SERIAL_DEFAULTS = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: "1" as SerialStopBits,
  parity: "none" as SerialParity,
  flow: "none" as SerialFlow,
  dtr: false,
  rts: false,
  encoding: "utf8" as SerialEncoding,
  newline: "crlf" as SerialNewline,
  /** 读/等回包的单次超时（ms）；transact 的采集窗口也用它。 */
  timeoutMs: 1000,
  /** read 一次最多返回多少行。 */
  maxLines: 200,
  /** read 一次最多读多少字节（从文件尾往前读）。 */
  maxBytes: 65_536,
  /** 多久没人碰就自动放口（ms）；0 = 不自动关。 */
  idleTimeoutMs: 600_000,
  /** rx/tx/bridge.log 单个文件的上限（字节），超了桥自己留最新一半。 */
  maxLogBytes: 8 * 1024 * 1024,
  /** true = 会话跨 turn 保留（turn/end 清理时不动它）。 */
  persist: false,
} as const;

export const SERIAL_LIMITS = {
  timeoutMs: 30_000,
  maxLines: 2000,
  maxBytes: 1_048_576,
  maxLogBytes: 64 * 1024 * 1024,
  minLogBytes: 64 * 1024,
  idleTimeoutMs: 24 * 60 * 60 * 1000,
  /** 一次 send 的正文上限（字符数），超了直接拒绝：串口不是传文件的地方。 */
  textChars: 65_536,
} as const;

/** open 等 status.state=open 的上限。 */
export const OPEN_WAIT_MS = 5_000;
/** send 等 done 回执的上限。 */
export const ACK_WAIT_MS = 2_000;
/** close 先礼后兵：等这么久还不退就强杀。 */
export const CLOSE_GRACE_MS = 3_000;
/** 轮询间隔（文件 IPC 的代价就是延迟，20–50 ms 足够）。 */
const POLL_MS = 40;
/**
 * 串口参数的 JSON Schema 片段（平铺），给工具层拼 parameters.properties 用。
 * 单独放一份的理由：白名单/范围/默认值只有一处定义，工具 schema 与 normalizeSerialSettings
 * 就不会各说各话（schema 说 1…4M、代码只认到 1M 这种错最难发现）。
 *
 * 注意：宿主 0.2.2 起 schema 子集不再接受 minimum/maximum（UNSUPPORTED_SCHEMA），
 * 所以范围只写进 description；真正的范围校验在 normalizeSerialSettings（越界记 errors，
 * 保持默认值），这里不重复。唯一的例外是 dataBits：只有 5…8 四个值，用 enum 表达。
 */
export const SERIAL_SETTINGS_PROPERTIES: Record<string, JsonSchema> = {
  baudRate: { type: "integer", description: "波特率 " + String(SERIAL_BAUD_MIN) + "…" + String(SERIAL_BAUD_MAX) + "，默认 " + String(SERIAL_DEFAULTS.baudRate), default: SERIAL_DEFAULTS.baudRate },
  dataBits: { type: "integer", enum: [5, 6, 7, 8], description: "数据位 " + String(SERIAL_DATA_BITS_MIN) + "…" + String(SERIAL_DATA_BITS_MAX) + "，默认 " + String(SERIAL_DEFAULTS.dataBits), default: SERIAL_DEFAULTS.dataBits },
  stopBits: { type: "string", enum: [...SERIAL_STOP_BITS], description: "停止位，默认 1", default: SERIAL_DEFAULTS.stopBits },
  parity: { type: "string", enum: [...SERIAL_PARITIES], description: "校验位，默认 none", default: SERIAL_DEFAULTS.parity },
  flow: { type: "string", enum: [...SERIAL_FLOWS], description: "流控，默认 none（STM32 板子一般不用）", default: SERIAL_DEFAULTS.flow },
  dtr: { type: "boolean", description: "打开时把 DTR 拉低（默认 false；有的板子拉高会复位）", default: SERIAL_DEFAULTS.dtr },
  rts: { type: "boolean", description: "打开时把 RTS 拉低（默认 false）", default: SERIAL_DEFAULTS.rts },
  encoding: { type: "string", enum: [...SERIAL_ENCODINGS], description: "文本编码，默认 utf8", default: SERIAL_DEFAULTS.encoding },
  newline: { type: "string", enum: [...SERIAL_NEWLINES], description: "send 自动补的换行，默认 crlf", default: SERIAL_DEFAULTS.newline },
  timeoutMs: { type: "integer", description: "读/等回包超时（ms）0…" + String(SERIAL_LIMITS.timeoutMs) + "，默认 " + String(SERIAL_DEFAULTS.timeoutMs), default: SERIAL_DEFAULTS.timeoutMs },
  maxLines: { type: "integer", description: "read 一次最多返回多少行 1…" + String(SERIAL_LIMITS.maxLines) + "，默认 " + String(SERIAL_DEFAULTS.maxLines), default: SERIAL_DEFAULTS.maxLines },
  maxBytes: { type: "integer", description: "read 一次最多读多少字节 256…" + String(SERIAL_LIMITS.maxBytes) + "，默认 " + String(SERIAL_DEFAULTS.maxBytes), default: SERIAL_DEFAULTS.maxBytes },
  idleTimeoutMs: { type: "integer", description: "多久没人碰就自动放口（ms）0…" + String(SERIAL_LIMITS.idleTimeoutMs) + "，0 = 不自动关，默认 " + String(SERIAL_DEFAULTS.idleTimeoutMs), default: SERIAL_DEFAULTS.idleTimeoutMs },
  persist: { type: "boolean", description: "true = 会话跨 turn 保留（默认 false：turn 结束就关）", default: SERIAL_DEFAULTS.persist },
};

/** 端口清单缓存多久（open 与 list 都要用；WMI 查询一次约 0.5 s，不缓存会拖慢一切）。 */
const PORT_CACHE_MS = 5_000;
/** 桥脚本缺失时的提示（安装不完整的唯一特征）。 */
const BRIDGE_REL_PATH = "../../templates/serial/bridge.ps1";

// ── 错误分类 ─────────────────────────────────────────────────────────────────

/**
 * 串口失败的分类。前七个是环境/参数问题，后四个是会话状态问题——
 * 分清这两组的意义：前者要用户动手（插线、关串口助手、改参数），后者重试或重开就有救。
 */
export type SerialErrorKind =
  | "unsupported-platform"
  | "powershell-missing"
  | "port-not-found"
  | "port-busy"
  | "access-denied"
  | "settings-invalid"
  | "bridge-start-timeout"
  | "bridge-crashed"
  | "disconnected"
  | "already-open"
  | "no-session";

export const SERIAL_ERROR_KINDS: readonly SerialErrorKind[] = [
  "unsupported-platform",
  "powershell-missing",
  "port-not-found",
  "port-busy",
  "access-denied",
  "settings-invalid",
  "bridge-start-timeout",
  "bridge-crashed",
  "disconnected",
  "already-open",
  "no-session",
];

/** 统一错误形状（与 ProbeError 同构：kind 给模型分支，cause/hint 给人看，evidence 是原始行）。 */
export interface SerialError {
  kind: SerialErrorKind;
  cause: string;
  hint: string;
  evidence: string[];
  retryable: boolean;
}

const HINT_BY_KIND: Record<SerialErrorKind, string> = {
  "unsupported-platform":
    "串口 P1 只支持 Windows（靠 PowerShell 的 System.IO.Ports 常驻进程）。在 mac/Linux 上先用别的串口工具，或等后续版本。",
  "powershell-missing":
    "找不到可用的 PowerShell：Windows 自带 powershell.exe（5.1），若被精简/改路径，就用 DSH_STM32_SERIAL_POWERSHELL 指向 pwsh.exe 或 powershell.exe。",
  "port-not-found":
    "这个 COM 号当前不存在：换根 USB 数据线、确认板子供电，再 stm32_serial action=list 看现有端口（插拔后 Windows 常把 COM5 变成 COM7）。",
  "port-busy":
    "端口被别的程序占着：关掉串口助手 / 另一个 stm32_serial 会话 / 驱动自带的监视工具，再试一次。",
  "access-denied":
    "文件或目录权限不足：检查 %USERPROFILE%\\.dsh-stm32\\serial 是否可写，或把 DSH_STM32_SERIAL_HOME 指到可写目录。",
  "settings-invalid":
    "参数不合法：波特率 50…4000000、数据位 5…8、停止位 1/1.5/2、校验 none/odd/even/mark/space、流控 none/xonxoff/rtscts、timeoutMs ≤30000；端口名形如 COM3。",
  "bridge-start-timeout":
    "桥进程 5 s 内没有把 status.state 变成 open：看 evidence 里的 bridge.log 末尾，常见是 PowerShell 启动慢、脚本被安全软件拦下，或端口打不开。重试一次；反复失败就用 DSH_STM32_SERIAL_BRIDGE 换一份脚本路径确认不是安装问题。",
  "bridge-crashed":
    "桥进程已经退出（pid 不在了）：会话随之失效，重新 open 即可；反复崩溃就看 evidence 里 bridge.log 的异常栈。",
  disconnected:
    "串口连接已经断了（拔线 / 板子复位 / 端口被系统回收）：重新 open；若一直断，换数据线并确认板子没有掉电。",
  "already-open": "已经有一个串口会话开着（P1 只支持单会话）：先 stm32_serial action=close 再开新的。",
  "no-session": "当前没有开着的串口会话：先 stm32_serial action=open（端口可以 stm32_serial action=list 查）。",
};

const RETRYABLE_BY_KIND: Record<SerialErrorKind, boolean> = {
  "unsupported-platform": false,
  "powershell-missing": false,
  "port-not-found": true,
  "port-busy": true,
  "access-denied": false,
  "settings-invalid": false,
  "bridge-start-timeout": true,
  "bridge-crashed": true,
  disconnected: true,
  "already-open": false,
  "no-session": true,
};

/** cause 的缺省文案（调用方没给更准的说法时用，避免出现「未知原因」这种废话）。 */
const CAUSE_BY_KIND: Record<SerialErrorKind, string> = {
  "unsupported-platform": "当前平台不是 Windows，串口 P1 没有实现",
  "powershell-missing": "找不到 powershell.exe / pwsh.exe",
  "port-not-found": "串口不存在",
  "port-busy": "串口被另一个进程占用",
  "access-denied": "权限不足（文件或目录不可写）",
  "settings-invalid": "串口参数不合法",
  "bridge-start-timeout": "桥进程没有在 5 s 内就绪",
  "bridge-crashed": "桥进程已退出",
  disconnected: "串口连接已断开",
  "already-open": "已有一个串口会话开着",
  "no-session": "没有开着的串口会话",
};

export function makeSerialError(
  kind: SerialErrorKind,
  detail: { cause?: string; hint?: string; evidence?: string[] } = {},
): SerialError {
  return {
    kind,
    cause: detail.cause ?? CAUSE_BY_KIND[kind],
    hint: detail.hint ?? HINT_BY_KIND[kind],
    evidence: detail.evidence ?? [],
    retryable: RETRYABLE_BY_KIND[kind],
  };
}

/** 报告与 message 统一用这句：「错误：<kind> — <cause>；建议：<hint>」。 */
export function formatSerialError(error: SerialError): string {
  return "错误：" + error.kind + " — " + error.cause + "；建议：" + error.hint;
}

/**
 * 工具 output schema 里的 serialError 片段（与 PROBE_ERROR_SCHEMA 同构）。
 * **不进 required**：成功时引擎给 null，而宿主不接受 null，工具层要把它摘掉再交出去。
 */
export const SERIAL_ERROR_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: [...SERIAL_ERROR_KINDS] },
    cause: { type: "string" },
    hint: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    retryable: { type: "boolean" },
  },
  required: ["kind", "cause", "hint", "evidence", "retryable"],
};

// ── 环境与路径 ───────────────────────────────────────────────────────────────

type Env = Record<string, string | undefined>;

function envValue(env: Env, key: string): string {
  const value = env[key];
  return value === undefined ? "" : value.trim();
}

function homeDir(env: Env): string {
  const userProfile = envValue(env, "USERPROFILE");
  if (userProfile !== "") return userProfile;
  const home = envValue(env, "HOME");
  if (home !== "") return home;
  return homedir();
}

function toPosix(value: string): string {
  return value.replace(/\\/gu, "/").replace(/\/+$/u, "");
}

/** IPC 根目录：%USERPROFILE%/.dsh-stm32/serial（DSH_STM32_SERIAL_HOME 可整体改指）。 */
export function serialSessionsRoot(env: Env = process.env): string {
  const override = envValue(env, "DSH_STM32_SERIAL_HOME");
  if (override !== "") return toPosix(isAbsolute(override) ? override : homeDir(env) + "/" + override);
  return toPosix(homeDir(env)) + "/.dsh-stm32/serial";
}

/** 某个会话的 IPC 目录。 */
export function serialIpcDir(sessionId: string, env: Env = process.env): string {
  return serialSessionsRoot(env) + "/" + sessionId;
}

/** 随包发布的桥脚本路径（lib/engine/serial.js → ../../templates/serial/bridge.ps1）。 */
export function defaultBridgeScriptPath(): string {
  return fileURLToPath(new URL(BRIDGE_REL_PATH, import.meta.url));
}

/** 实际用的桥脚本：DSH_STM32_SERIAL_BRIDGE 覆盖（单测用假桥）。 */
export function serialBridgeScriptPath(env: Env = process.env): string {
  const override = envValue(env, "DSH_STM32_SERIAL_BRIDGE");
  if (override === "") return defaultBridgeScriptPath();
  return isAbsolute(override) ? override : toPosix(homeDir(env) + "/" + override);
}

function isNodeScript(path: string): boolean {
  return /\.(?:c|m)?js$/iu.test(path);
}

function isWindows(env: Env = process.env): boolean {
  // 显式给了 OS 就以它为准（单测/CI 里模拟别的平台）；否则看真实进程平台。
  const declared = env["OS"];
  if (declared !== undefined && declared !== "") return declared === "Windows_NT";
  return process.platform === "win32";
}

// ── 子进程小工具 ─────────────────────────────────────────────────────────────

interface CaptureResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error: string;
}

/** 跑一个短命令把输出抓回来（只给「探测」用；桥进程走 detached，绝不用这个）。 */
function runCapture(exe: string, args: string[], timeoutMs: number, env: Env = process.env): Promise<CaptureResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let child: ChildProcess;
    const finish = (code: number | null, error: string): void => {
      if (settled) return;
      settled = true;
      resolve({ ok: code === 0 && !timedOut && error === "", code, stdout, stderr, timedOut, error });
    };
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: env as NodeJS.ProcessEnv });
    } catch (error) {
      finish(null, error instanceof Error ? error.message : String(error));
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // 已经退了
      }
      finish(null, "超时 " + String(timeoutMs) + " ms");
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 4 * 1024 * 1024) stdout = stdout.slice(-1024 * 1024);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 1024 * 1024) stderr = stderr.slice(-256 * 1024);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish(null, error.message);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code, "");
    });
  });
}

let powershellCache: { key: string; exe: string; ok: boolean; version: string } | null = null;

interface PowerShellResolution {
  ok: boolean;
  exe: string;
  version: string;
  errors: string[];
}

/**
 * 找到一台 Windows 上真能用的 PowerShell。
 *
 * 顺序：DSH_STM32_SERIAL_POWERSHELL → powershell.exe（5.1，Windows 必有）→ pwsh.exe（7）。
 * 探一次缓存住：这条命令约 200–600 ms，每个操作都探一次会让 list/open 都变慢。
 */
export async function resolvePowerShell(env: Env = process.env): Promise<PowerShellResolution> {
  const override = envValue(env, "DSH_STM32_SERIAL_POWERSHELL");
  const candidates = override !== "" ? [override] : ["powershell.exe", "pwsh.exe"];
  const key = candidates.join("|");
  if (powershellCache !== null && powershellCache.key === key) {
    return { ok: powershellCache.ok, exe: powershellCache.exe, version: powershellCache.version, errors: [] };
  }
  const errors: string[] = [];
  for (const candidate of candidates) {
    const probe = await runCapture(candidate, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], 15_000, env);
    if (probe.ok && probe.stdout.trim() !== "") {
      powershellCache = { key, exe: candidate, ok: true, version: probe.stdout.trim() };
      return { ok: true, exe: candidate, version: probe.stdout.trim(), errors };
    }
    errors.push(candidate + "：" + (probe.error !== "" ? probe.error : "版本探测失败（exit " + String(probe.code) + "）" + (probe.stderr.trim() !== "" ? " " + probe.stderr.trim().slice(0, 200) : "")));
  }
  powershellCache = { key, exe: candidates[0] ?? "powershell.exe", ok: false, version: "" };
  return { ok: false, exe: candidates[0] ?? "powershell.exe", version: "", errors };
}

/** 单测用：清掉 powershell 探测缓存（同一个进程里换 DSH_STM32_SERIAL_POWERSHELL 时）。 */
export function resetSerialCaches(): void {
  powershellCache = null;
  portCache = null;
}

// ── 平台能力自检 ─────────────────────────────────────────────────────────────

export interface SerialSupport {
  ok: boolean;
  platform: string;
  /** 启动桥用的可执行文件。 */
  exe: string;
  /** 启动桥的参数（含 "-File <script>"；node 假桥只有脚本路径）。 */
  exeArgs: string[];
  bridgeScript: string;
  bridgeHost: "powershell" | "node";
  powershellVersion: string;
  errors: string[];
  serialError: SerialError | null;
  message: string;
}

/**
 * 串口能不能用：平台 + PowerShell + 桥脚本三件都齐才算 ok。
 * 每次操作前都调它（有缓存，几乎不要钱），省得把「环境缺件」报成「端口打不开」。
 */
export async function serialSupport(env: Env = process.env): Promise<SerialSupport> {
  const scriptPath = serialBridgeScriptPath(env);
  const base: SerialSupport = {
    ok: false,
    platform: process.platform,
    exe: "",
    exeArgs: [],
    bridgeScript: scriptPath,
    bridgeHost: "powershell",
    powershellVersion: "",
    errors: [],
    serialError: null,
    message: "",
  };
  if (!isWindows(env)) {
    return {
      ...base,
      serialError: makeSerialError("unsupported-platform", { cause: "当前平台是 " + process.platform + "，串口 P1 只做了 Windows 的 PowerShell 桥" }),
      message: "当前平台不是 Windows：串口 P1 没有实现",
    };
  }
  if (!existsSync(scriptPath)) {
    return {
      ...base,
      errors: ["桥脚本不存在：" + scriptPath],
      serialError: makeSerialError("bridge-crashed", {
        cause: "插件安装不完整：缺少 " + scriptPath,
        hint: "重装插件（templates/serial/bridge.ps1 随包发布）；若只是临时换了路径，用 DSH_STM32_SERIAL_BRIDGE 指回去。",
      }),
      message: "桥脚本缺失，串口不可用",
    };
  }
  if (isNodeScript(scriptPath)) {
    // 假桥（单测用）：直接 node 跑，不需要 PowerShell。
    return {
      ...base,
      ok: true,
      exe: process.execPath,
      exeArgs: [scriptPath],
      bridgeHost: "node",
      message: "串口桥用 node 跑测试脚本：" + scriptPath,
    };
  }
  const shell = await resolvePowerShell(env);
  if (!shell.ok) {
    return {
      ...base,
      errors: shell.errors,
      serialError: makeSerialError("powershell-missing", {
        cause: "找不到可用的 PowerShell（试过：" + shell.errors.map((line) => line.split("：")[0]).join("、") + "）",
        evidence: shell.errors,
      }),
      message: "没有可用的 PowerShell，串口不可用",
    };
  }
  return {
    ...base,
    ok: true,
    exe: shell.exe,
    exeArgs: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    powershellVersion: shell.version,
    message: "串口桥可用（" + shell.exe + " " + shell.version + "）",
  };
}

// ── 端口枚举 ─────────────────────────────────────────────────────────────────

/** 端口清单里的一个端口（facts + 记忆状态）。 */
export interface SerialPortInfo extends SerialPortFacts {
  identity: string;
  identityLabel: string;
  /** 该身份在 serial.json 里有记忆（上次通过）。 */
  remembered: boolean;
  /** 这次要用的参数：记忆值 + 缺省值。 */
  settings: SerialSettings;
  lastUsedAt: string;
  openCount: number;
  /** 上次最后用的就是这个 COM 号。 */
  lastUsedPort: boolean;
}

interface PortEnumeration {
  ok: boolean;
  names: string[];
  ports: SerialPortFacts[];
  error: string;
  /** 用的是哪条路（wmi / 环境变量覆盖 / GetPortNames 兜底），报告里写清楚。 */
  source: string;
}

let portCache: { key: string; at: number; value: PortEnumeration } | null = null;

/** PowerShell：拿端口名（权威）+ PnP 事实（VID/PID/序列号/位置）。 */
function portQueryScript(): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$items = @()",
    "foreach ($p in [System.IO.Ports.SerialPort]::GetPortNames()) {",
    "  $items += [pscustomobject]@{ port = $p; description = ''; pnpId = ''; manufacturer = '' }",
    "}",
    "foreach ($d in (Get-CimInstance -ClassName Win32_PnPEntity -Filter \"Name LIKE '%(COM%'\")) {",
    "  $name = [string]$d.Name",
    "  $m = [regex]::Match($name, '\\((COM\\d+)\\)')",
    "  if (-not $m.Success) { continue }",
    "  $com = $m.Groups[1].Value",
    "  $hit = $items | Where-Object { $_.port -eq $com } | Select-Object -First 1",
    "  if ($null -eq $hit) {",
    "    $items += [pscustomobject]@{ port = $com; description = $name; pnpId = [string]$d.PNPDeviceID; manufacturer = [string]$d.Manufacturer }",
    "  } else {",
    "    $hit.description = $name",
    "    $hit.pnpId = [string]$d.PNPDeviceID",
    "    $hit.manufacturer = [string]$d.Manufacturer",
    "  }",
    "}",
    "$names = @([System.IO.Ports.SerialPort]::GetPortNames())",
    "[pscustomobject]@{ ports = @($items); names = @($names) } | ConvertTo-Json -Compress -Depth 5",
  ].join("\n");
}

interface RawPortRow {
  port?: unknown;
  description?: unknown;
  pnpId?: unknown;
  manufacturer?: unknown;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** PNPDeviceID → VID/PID/序列号/位置。总线路径当序列号（5&2c1a&0&1）不能算身份，退成位置。 */
export function parsePnpId(pnpId: string): { vid: string; pid: string; serialNumber: string; location: string } {
  const upper = pnpId.toUpperCase();
  const vid = /VID_([0-9A-F]{4})/u.exec(upper)?.[1] ?? "";
  const pid = /PID_([0-9A-F]{4})/u.exec(upper)?.[1] ?? "";
  const segments = pnpId.split("\\");
  const instance = segments.length >= 3 ? segments[segments.length - 1] ?? "" : "";
  const busPath = /^\d+&/u.test(instance);
  const serialNumber = instance !== "" && !busPath && instance !== "0000" ? instance : "";
  const location = busPath ? instance : "";
  return { vid, pid, serialNumber, location };
}

function factsFromRow(row: RawPortRow, names: readonly string[]): SerialPortFacts | null {
  const port = asText(row.port).toUpperCase();
  if (!/^COM\d+$/u.test(port)) return null;
  if (!names.includes(port)) return null;
  const pnpId = asText(row.pnpId);
  const parsed = parsePnpId(pnpId);
  return {
    port,
    description: asText(row.description),
    vid: parsed.vid,
    pid: parsed.pid,
    serialNumber: parsed.serialNumber,
    location: parsed.location,
    pnpId,
  };
}

/** 从环境变量读端口清单（单测 / 无 WMI 的机器）。格式：[{port,description,vid,pid,serialNumber,location}] */
function portsFromEnv(env: Env): PortEnumeration | null {
  const raw = envValue(env, "DSH_STM32_SERIAL_PORTS");
  if (raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : [];
    const ports: SerialPortFacts[] = [];
    for (const row of rows) {
      if (row === null || typeof row !== "object") continue;
      const record = row as Record<string, unknown>;
      const port = asText(record["port"]).toUpperCase();
      if (!/^COM\d+$/u.test(port)) continue;
      ports.push({
        port,
        description: asText(record["description"]),
        vid: asText(record["vid"]).toUpperCase(),
        pid: asText(record["pid"]).toUpperCase(),
        serialNumber: asText(record["serialNumber"]),
        location: asText(record["location"]),
        pnpId: asText(record["pnpId"]),
      });
    }
    return { ok: true, names: ports.map((port) => port.port), ports, error: "", source: "环境变量 DSH_STM32_SERIAL_PORTS" };
  } catch (error) {
    return { ok: false, names: [], ports: [], error: "DSH_STM32_SERIAL_PORTS 不是合法 JSON：" + describeError(error), source: "环境变量 DSH_STM32_SERIAL_PORTS" };
  }
}

/**
 * 枚举端口（5 s 缓存）。WMI 查询会漏掉一些虚拟串口，所以「权威名单」始终是
 * GetPortNames()，PnP 只用来补 VID/PID/序列号。
 */
async function enumeratePorts(env: Env = process.env): Promise<PortEnumeration> {
  const fromEnv = portsFromEnv(env);
  if (fromEnv !== null) return fromEnv;
  const key = serialBridgeScriptPath(env) + "|" + envValue(env, "DSH_STM32_SERIAL_POWERSHELL");
  if (portCache !== null && portCache.key === key && Date.now() - portCache.at < PORT_CACHE_MS) return portCache.value;

  const shell = await resolvePowerShell(env);
  if (!shell.ok) {
    const value: PortEnumeration = { ok: false, names: [], ports: [], error: "找不到可用的 PowerShell：" + shell.errors.join("；"), source: "powershell" };
    portCache = { key, at: Date.now(), value };
    return value;
  }
  const probe = await runCapture(shell.exe, ["-NoProfile", "-NonInteractive", "-Command", portQueryScript()], 20_000, env);
  if (!probe.ok) {
    const value: PortEnumeration = { ok: false, names: [], ports: [], error: "端口查询失败：" + (probe.error !== "" ? probe.error : probe.stderr.trim().slice(0, 300)), source: "powershell" };
    portCache = { key, at: Date.now(), value };
    return value;
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(probe.stdout.trim());
  } catch (error) {
    const value: PortEnumeration = { ok: false, names: [], ports: [], error: "端口查询输出不是 JSON：" + describeError(error) + "；" + probe.stdout.trim().slice(0, 200), source: "powershell" };
    portCache = { key, at: Date.now(), value };
    return value;
  }
  const record = (parsed !== null && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const namesRaw = Array.isArray(record["names"]) ? record["names"] : [];
  const names = namesRaw.map((name) => asText(name).toUpperCase()).filter((name) => /^COM\d+$/u.test(name));
  const rowsRaw = record["ports"];
  const rows: RawPortRow[] = Array.isArray(rowsRaw) ? (rowsRaw as RawPortRow[]) : rowsRaw !== null && typeof rowsRaw === "object" ? [rowsRaw as RawPortRow] : [];
  const ports: SerialPortFacts[] = [];
  for (const row of rows) {
    const facts = factsFromRow(row, names);
    if (facts !== null) ports.push(facts);
  }
  // GetPortNames 里有、WMI 里没有的（蓝牙串口、部分虚拟口）：补一条没有 USB 身份的记录。
  for (const name of names) {
    if (ports.some((port) => port.port === name)) continue;
    ports.push({ port: name, description: "", vid: "", pid: "", serialNumber: "", location: "", pnpId: "" });
  }
  const value: PortEnumeration = { ok: true, names, ports, error: "", source: "powershell（GetPortNames + Win32_PnPEntity）" };
  portCache = { key, at: Date.now(), value };
  return value;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function findFacts(list: readonly SerialPortFacts[], port: string): SerialPortFacts | null {
  const wanted = port.toUpperCase();
  return list.find((facts) => facts.port === wanted) ?? null;
}

/** 端口名归一：接受 com3 / COM3 / \\.\COM3，返回 COM3；其它返回 null。 */
export function normalizePortName(raw: unknown): string | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return null;
  const match = /^(?:\\\\.\\)?(?:com)(\d{1,3})$/iu.exec(text);
  if (match === null) return null;
  return "COM" + String(Number.parseInt(match[1] ?? "0", 10));
}

// ── listPorts ────────────────────────────────────────────────────────────────

export interface ListPortsRequest {
  env?: Env;
  signal?: AbortSignal;
}

export interface ListPortsResult {
  ok: boolean;
  platform: string;
  ports: SerialPortInfo[];
  configPath: string;
  /** 采集方式（powershell / 环境变量覆盖）。 */
  source: string;
  errors: string[];
  serialError: SerialError | null;
  message: string;
}

export async function listPorts(request: ListPortsRequest = {}): Promise<ListPortsResult> {
  const env = request.env ?? process.env;
  const support = await serialSupport(env);
  const configPath = serialConfigPath(env);
  if (!support.ok) {
    return { ok: false, platform: process.platform, ports: [], configPath, source: "", errors: support.errors, serialError: support.serialError, message: support.message };
  }
  const enumeration = await enumeratePorts(env);
  if (!enumeration.ok) {
    return {
      ok: false,
      platform: process.platform,
      ports: [],
      configPath,
      source: enumeration.source,
      errors: [enumeration.error],
      serialError: makeSerialError("port-not-found", {
        cause: "列端口失败：" + enumeration.error,
        hint: "powershell 的 WMI 查询不可用时先确认 Get-CimInstance 能跑；也可以直接指定 COM 号 open（跳过枚举）。",
      }),
      message: "列端口失败：" + enumeration.error,
    };
  }
  const config = readSerialConfig(env).config;
  const ports: SerialPortInfo[] = enumeration.ports.map((facts) => {
    const identity = portIdentity(facts);
    const memory = config?.ports.find((entry) => entry.identity === identity) ?? null;
    return {
      ...facts,
      identity,
      identityLabel: identity.startsWith("usb:") ? "USB " + identity.slice(4) : "端口名 " + identity.slice(4),
      remembered: memory !== null,
      settings: memory !== null ? { ...memory.settings } : defaultSerialSettings(),
      lastUsedAt: memory?.lastUsedAt ?? "",
      openCount: memory?.openCount ?? 0,
      lastUsedPort: memory !== null && memory.comPort === facts.port,
    };
  });
  const remembered = ports.filter((port) => port.remembered);
  const notes: string[] = [];
  if (ports.length === 0) notes.push("没有发现串口：插上板子（USB 数据线，不是充电线）再试，或确认驱动装好了。");
  if (remembered.length > 0) notes.push("带记忆的端口：" + remembered.map((port) => port.port + "（" + port.identityLabel + "）").join("、"));
  return {
    ok: true,
    platform: process.platform,
    ports,
    configPath,
    source: enumeration.source,
    errors: [],
    serialError: null,
    message: "发现 " + String(ports.length) + " 个串口" + (notes.length > 0 ? "；" + notes.join("；") : ""),
  };
}

// ── 会话状态 ─────────────────────────────────────────────────────────────────

interface BridgeStatusFile {
  state: string;
  pid: number;
  sessionId: string;
  port: string;
  openedAt: string;
  updatedAt: string;
  rxBytes: number;
  txBytes: number;
  reason: string;
  error: { kind: string; cause: string; hint: string } | null;
}

function readJsonFile<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8").trim();
    if (text === "") return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function readPidFile(ipcDir: string): number {
  try {
    const text = readFileSync(join(ipcDir, "bridge.pid"), "utf8").trim();
    const pid = Number.parseInt(text, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

function readStatusFile(ipcDir: string): BridgeStatusFile | null {
  const raw = readJsonFile<Record<string, unknown>>(join(ipcDir, "status.json"));
  if (raw === null) return null;
  const error = raw["error"];
  return {
    state: asText(raw["state"]),
    pid: typeof raw["pid"] === "number" ? raw["pid"] : 0,
    sessionId: asText(raw["sessionId"]),
    port: asText(raw["port"]),
    openedAt: asText(raw["openedAt"]),
    updatedAt: asText(raw["updatedAt"]),
    rxBytes: typeof raw["rxBytes"] === "number" ? raw["rxBytes"] : 0,
    txBytes: typeof raw["txBytes"] === "number" ? raw["txBytes"] : 0,
    reason: asText(raw["reason"]),
    error:
      error !== null && typeof error === "object"
        ? {
            kind: asText((error as Record<string, unknown>)["kind"]),
            cause: asText((error as Record<string, unknown>)["cause"]),
            hint: asText((error as Record<string, unknown>)["hint"]),
          }
        : null,
  };
}

/** bridge.log 的末尾几行：失败报告里最值钱的证据。 */
export function bridgeLogTail(ipcDir: string, lines = 8): string[] {
  try {
    const path = join(ipcDir, "bridge.log");
    if (!existsSync(path)) return [];
    const size = statSync(path).size;
    const readBytes = Math.min(size, 16 * 1024);
    const buffer = Buffer.alloc(readBytes);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buffer, 0, readBytes, size - readBytes);
    } finally {
      closeSync(fd);
    }
    const text = buffer.toString("utf8").replace(/^[^\n]*\n/u, "");
    return text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .slice(-lines);
  } catch {
    return [];
  }
}

/** 进程还在不在（Windows 上 process.kill(pid, 0) 只是查存在，不会真发信号）。 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM = 进程在，只是不归我们杀（比如另一个用户起的）：算活着。
    return code === "EPERM";
  }
}

/** 一个串口会话的公开快照（报告/status 用，不含内部句柄）。 */
export interface SerialSessionView {
  sessionId: string;
  port: string;
  identity: string;
  settings: SerialSettings;
  ipcDir: string;
  bridgePid: number;
  bridgeAlive: boolean;
  state: string;
  persist: boolean;
  /** 打开时定的等待窗口（send/transact 不给 timeoutMs 时用）。 */
  timeoutMs: number;
  /** 打开时定的 read 上限：不给参数就读这么多，而不是永远用默认值。 */
  maxLines: number;
  maxBytes: number;
  idleTimeoutMs: number;
  openedAtMs: number;
  uptimeMs: number;
  rxBytes: number;
  txBytes: number;
}

interface ActiveSession extends SerialSessionView {
  bridgeHost: "powershell" | "node";
  bridgeScript: string;
  bridgeExe: string;
}

let active: ActiveSession | null = null;

/** 当前会话（没有就是 null）；给工具层做 turn/end 与并发判断用。 */
export function currentSerialSession(): SerialSessionView | null {
  if (active === null) return null;
  const status = readStatusFile(active.ipcDir);
  return snapshotOf(active, status);
}

function snapshotOf(session: ActiveSession, status: BridgeStatusFile | null): SerialSessionView {
  const alive = pidAlive(session.bridgePid);
  return {
    sessionId: session.sessionId,
    port: session.port,
    identity: session.identity,
    settings: session.settings,
    ipcDir: session.ipcDir,
    bridgePid: session.bridgePid,
    bridgeAlive: alive,
    state: status?.state ?? (alive ? "open" : "closed"),
    persist: session.persist,
    timeoutMs: session.timeoutMs,
    maxLines: session.maxLines,
    maxBytes: session.maxBytes,
    idleTimeoutMs: session.idleTimeoutMs,
    openedAtMs: session.openedAtMs,
    uptimeMs: Date.now() - session.openedAtMs,
    rxBytes: status?.rxBytes ?? 0,
    txBytes: status?.txBytes ?? 0,
  };
}

/** 会话还活着吗：pid 在 + 状态不是 closed/error。桥死了就把 active 清掉（stale 自愈）。 */
function liveSession(): ActiveSession | null {
  if (active === null) return null;
  const status = readStatusFile(active.ipcDir);
  if (!pidAlive(active.bridgePid)) {
    active = null;
    return null;
  }
  if (status !== null && (status.state === "closed" || status.state === "error")) {
    active = null;
    return null;
  }
  return active;
}

// ── open ─────────────────────────────────────────────────────────────────────

export interface OpenSerialRequest {
  /** 端口名（COM3）。省略时用 serial.json 里最后一次成功的端口（persist 语义之外的便利）。 */
  port?: string;
  baudRate?: number;
  dataBits?: number;
  stopBits?: SerialStopBits;
  parity?: SerialParity;
  flow?: SerialFlow;
  dtr?: boolean;
  rts?: boolean;
  encoding?: SerialEncoding;
  newline?: SerialNewline;
  timeoutMs?: number;
  maxLines?: number;
  maxBytes?: number;
  idleTimeoutMs?: number;
  maxLogBytes?: number;
  persist?: boolean;
  env?: Env;
  signal?: AbortSignal;
}

export interface OpenSerialResult {
  ok: boolean;
  session: SerialSessionView | null;
  /** 这次实际用的参数（记忆/缺省合并之后）。 */
  settings: SerialSettings;
  /** 采集/启动方式，出问题时贴进报告用。 */
  bridge: { exe: string; script: string; host: string; pid: number };
  durationMs: number;
  serialError: SerialError | null;
  message: string;
  notes: string[];
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function writeSessionFile(ipcDir: string, session: Record<string, unknown>): void {
  const path = join(ipcDir, "session.json");
  const tmp = path + ".tmp-" + String(process.pid);
  writeFileSync(tmp, JSON.stringify(session, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等一个条件成立（返回 true）或超时（false）。 */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return true;
    if (signal?.aborted === true) return false;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

/** 把桥的 status.error 映射成我们的分类（桥只会给 4 个 kind，其余兜底）。 */
function bridgeErrorToSerial(status: BridgeStatusFile | null, evidence: string[]): SerialError {
  const kindRaw = status?.error?.kind ?? "";
  const known = SERIAL_ERROR_KINDS.find((kind) => kind === kindRaw);
  if (known !== undefined) {
    return makeSerialError(known, { cause: status?.error?.cause ?? CAUSE_BY_KIND[known], evidence });
  }
  const message = (status?.error?.cause ?? status?.state ?? "").trim();
  if (/denied|in use|busy|being used/iu.test(message)) return makeSerialError("port-busy", { cause: message !== "" ? message : undefined, evidence });
  if (/does not exist|not exist|no such/iu.test(message)) return makeSerialError("port-not-found", { cause: message !== "" ? message : undefined, evidence });
  if (/access .*path|permission|EACCES/iu.test(message)) return makeSerialError("access-denied", { cause: message !== "" ? message : undefined, evidence });
  return makeSerialError("bridge-crashed", { cause: message !== "" ? message : "桥没有给出可识别的错误", evidence });
}

// 并发 open 的互斥：工具层的 isConcurrencySafe 只挡住同时发起的工具调用，挡不住两次
// open 各起一个桥（第二个覆盖 active，第一个就成了没人认领的孤儿）。这里用一条 promise
// 链串行化：后一个 open 等前一个彻底结束，然后撞上 already-open，而不是再起一个桥。
let openChain: Promise<unknown> = Promise.resolve();

export async function openSerial(request: OpenSerialRequest): Promise<OpenSerialResult> {
  const run = openChain.then(
    () => openSerialLocked(request),
    () => openSerialLocked(request),
  );
  openChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function openSerialLocked(request: OpenSerialRequest): Promise<OpenSerialResult> {
  const started = Date.now();
  const env = request.env ?? process.env;
  const notes: string[] = [];
  const base: OpenSerialResult = {
    ok: false,
    session: null,
    settings: defaultSerialSettings(),
    bridge: { exe: "", script: serialBridgeScriptPath(env), host: "", pid: 0 },
    durationMs: 0,
    serialError: null,
    message: "",
    notes,
  };

  const support = await serialSupport(env);
  base.bridge = { exe: support.exe, script: support.bridgeScript, host: support.bridgeHost, pid: 0 };
  if (!support.ok) return { ...base, serialError: support.serialError, message: support.message, durationMs: Date.now() - started };

  // 1) 已经有一个活着的会话：拒绝（单会话），但先自愈一下 stale 的
  const existing = liveSession();
  if (existing !== null) {
    return {
      ...base,
      settings: existing.settings,
      session: snapshotOf(existing, readStatusFile(existing.ipcDir)),
      serialError: makeSerialError("already-open", {
        cause: "会话 " + existing.sessionId + " 还开着（" + existing.port + "）",
        evidence: [existing.ipcDir],
      }),
      message: "已有串口会话开着：" + existing.port,
      durationMs: Date.now() - started,
    };
  }

  // 2) 端口与参数：先用端口枚举拿到 USB 身份，再按身份取记忆参数
  const enumeration = await enumeratePorts(env);
  let portText = normalizePortName(request.port);
  if (portText === null && asText(request.port) !== "") {
    return {
      ...base,
      serialError: makeSerialError("settings-invalid", { cause: "端口名不合法：" + String(request.port), evidence: ["形如 COM3（大小写都行，也接受 \\\.\\COM3）"] }),
      message: "端口名不合法",
      durationMs: Date.now() - started,
    };
  }
  if (portText === null) {
    const config = readSerialConfig(env).config;
    const candidates = (config?.ports ?? [])
      .filter((entry) => enumeration.names.includes(entry.comPort))
      .sort((left, right) => (right.lastUsedAt > left.lastUsedAt ? 1 : right.lastUsedAt < left.lastUsedAt ? -1 : 0));
    const remembered = candidates[0] ?? null;
    if (remembered === null) {
      return {
        ...base,
        serialError: makeSerialError("settings-invalid", {
          cause: "没有给 port，也没有能复用的历史端口",
          hint: "先 stm32_serial action=list 看端口，再 open 并显式给 port（例如 COM3）。",
        }),
        message: "缺少 port 参数",
        durationMs: Date.now() - started,
      };
    }
    portText = remembered.comPort;
    notes.push("没给 port，沿用上次成功的端口 " + portText + "（" + remembered.identity + "）");
  }

  if (!enumeration.ok) {
    notes.push("端口枚举失败（" + enumeration.error + "），跳过「端口是否存在」预检，交给桥去判定");
  } else if (!enumeration.names.includes(portText)) {
    return {
      ...base,
      serialError: makeSerialError("port-not-found", {
        cause: "本机现在没有 " + portText + "（现有：" + (enumeration.names.length > 0 ? enumeration.names.join(", ") : "一个都没有") + "）",
        evidence: [enumeration.source],
      }),
      message: "端口 " + portText + " 不存在",
      durationMs: Date.now() - started,
    };
  }

  const facts: SerialPortFacts =
    findFacts(enumeration.ports, portText) ?? {
      port: portText,
      description: "",
      vid: "",
      pid: "",
      serialNumber: "",
      location: "",
      pnpId: "",
    };
  const identity = portIdentity(facts);
  const recall = recallPortSettings(facts, env);
  if (recall.remembered) {
    notes.push(
      "参数取自这块板子上次的记录（" + facts.port + " → " + (facts.vid !== "" ? "USB " + facts.vid + ":" + facts.pid : identity) + (recall.lastUsedAt !== "" ? "，" + recall.lastUsedAt : "") + "）",
    );
    if (recall.comPort !== "" && recall.comPort !== portText) notes.push("上次它在 " + recall.comPort + "（换过 USB 口，COM 号会变，参数照旧）");
  }

  // 显式参数覆盖记忆值：记忆只是基准。
  const settingsErrors: string[] = [];
  const explicit: Record<string, unknown> = {};
  for (const key of ["baudRate", "dataBits", "stopBits", "parity", "flow", "dtr", "rts", "encoding", "newline"] as const) {
    const value = request[key];
    if (value !== undefined) explicit[key] = value;
  }
  const settings = normalizeSerialSettings(explicit, settingsErrors, recall.settings);
  const timeoutMs = clampInteger(request.timeoutMs, 0, SERIAL_LIMITS.timeoutMs, SERIAL_DEFAULTS.timeoutMs);
  const maxLines = clampInteger(request.maxLines, 1, SERIAL_LIMITS.maxLines, SERIAL_DEFAULTS.maxLines);
  const maxBytes = clampInteger(request.maxBytes, 256, SERIAL_LIMITS.maxBytes, SERIAL_DEFAULTS.maxBytes);
  const idleTimeoutMs = clampInteger(request.idleTimeoutMs, 0, SERIAL_LIMITS.idleTimeoutMs, SERIAL_DEFAULTS.idleTimeoutMs);
  const maxLogBytes = clampInteger(request.maxLogBytes, SERIAL_LIMITS.minLogBytes, SERIAL_LIMITS.maxLogBytes, SERIAL_DEFAULTS.maxLogBytes);
  const persist = request.persist === true;
  if (settingsErrors.length > 0) {
    return {
      ...base,
      settings,
      serialError: makeSerialError("settings-invalid", { cause: settingsErrors.join("；"), evidence: settingsErrors }),
      message: "串口参数不合法",
      durationMs: Date.now() - started,
    };
  }

  // 3) IPC 目录 + session.json（桥只读一次，之后一切都靠 cmd/）
  const sessionId = makeSessionId();
  const ipcDir = serialIpcDir(sessionId, env);
  try {
    mkdirSync(join(ipcDir, "cmd"), { recursive: true });
    mkdirSync(join(ipcDir, "done"), { recursive: true });
    writeSessionFile(ipcDir, {
      sessionId,
      port: portText,
      baudRate: settings.baudRate,
      dataBits: settings.dataBits,
      stopBits: settings.stopBits,
      parity: settings.parity,
      flow: settings.flow,
      dtr: settings.dtr,
      rts: settings.rts,
      encoding: settings.encoding,
      newline: settings.newline,
      timeoutMs,
      maxLines,
      maxBytes,
      idleTimeoutMs,
      maxLogBytes,
      parentPid: process.pid,
      startedAt: new Date().toISOString(),
      persist,
    });
  } catch (error) {
    return {
      ...base,
      serialError: makeSerialError("access-denied", { cause: "创建会话目录失败：" + describeError(error), evidence: [ipcDir] }),
      message: "无法创建串口会话目录",
      durationMs: Date.now() - started,
    };
  }

  // 4) 把桥进程「放生」：stdio 全 ignore + unref，工具调用结束不该把串口带走。
  //
  // 这里刻意**不用** detached: true。Node 在 Windows 上把 detached 翻成 DETACHED_PROCESS，
  // 而 powershell.exe 5.1 在没有控制台时启动即退出（连脚本都不执行，exit 0、无任何输出）——
  // 实测四台机器都一样。非 detached + unref 已经满足需求：Windows 上父进程退出不会带走子进程，
  // unref 只是不让它拖住事件循环；真正的「防残留」由桥自己的 parent-PID 看门狗负责。
  let child: ChildProcess;
  try {
    child = spawn(support.exe, support.exeArgs, {
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, ...env, DSH_STM32_SERIAL_IPC: ipcDir } as NodeJS.ProcessEnv,
    });
  } catch (error) {
    cleanupDir(ipcDir);
    return {
      ...base,
      serialError: makeSerialError("powershell-missing", { cause: "启动桥进程失败：" + describeError(error), evidence: [support.exe] }),
      message: "桥进程启动失败",
      durationMs: Date.now() - started,
    };
  }
  // 记下退出信息：桥没写 status 就死了的话，这行是唯一线索
  const bridgeExit: { code: number | null; signal: string | null } = { code: null, signal: null };
  child.once("exit", (code, signal) => {
    bridgeExit.code = code;
    bridgeExit.signal = signal;
  });
  child.unref();
  const spawnError = await new Promise<string>((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve("");
      }
    }, 500);
    child.once("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(error.message);
    });
    child.once("spawn", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve("");
    });
  });
  if (spawnError !== "") {
    cleanupDir(ipcDir);
    return {
      ...base,
      serialError: makeSerialError("powershell-missing", { cause: "桥进程起不来：" + spawnError, evidence: [support.exe] }),
      message: "桥进程启动失败",
      durationMs: Date.now() - started,
    };
  }

  // 5) 等 status.state=open（最多 5 s）；桥出错会先写 status.error 再退出
  await waitFor(() => {
    const status = readStatusFile(ipcDir);
    if (status === null) return false;
    return status.state === "open" || status.state === "error" || status.state === "closed";
  }, OPEN_WAIT_MS, request.signal);

  const status = readStatusFile(ipcDir);
  const pid = readPidFile(ipcDir) || status?.pid || child.pid || 0;
  if (status === null || status.state !== "open") {
    const evidence = bridgeLogTail(ipcDir);
    let serialError: SerialError;
    if (status !== null && status.state === "error") {
      serialError = bridgeErrorToSerial(status, evidence);
    } else if (bridgeExit.code !== null) {
      // 进程退了、status 一个字都没写：脚本根本没跑起来（路径不对 / 被执行策略或安全软件拦下）
      serialError = makeSerialError("bridge-crashed", {
        cause: "桥进程一启动就退出（exit " + String(bridgeExit.code) + "），没写出 status.json",
        hint:
          "多半是桥脚本跑不起来：确认 " +
          support.bridgeScript +
          " 存在；再手动执行 powershell -NoProfile -ExecutionPolicy Bypass -File \"" +
          support.bridgeScript +
          "\" 看报错（DSH_STM32_SERIAL_BRIDGE 可临时换脚本路径）。",
        evidence: evidence.length > 0 ? evidence : ["bridge.log 没有生成"],
      });
    } else if (pid !== 0 && !pidAlive(pid)) {
      serialError = makeSerialError("bridge-crashed", { evidence: evidence.length > 0 ? evidence : ["bridge.pid=" + String(pid) + " 已不在"] });
    } else {
      serialError = makeSerialError("bridge-start-timeout", { evidence: evidence.length > 0 ? evidence : ["status.json 没有出现 open"] });
    }
    // 启动失败也要收尸：慢桥可能在 5 s 窗口之后才把串口打开，这时只报错不 kill，
    // 就会留下一个活着却没人认领的进程占住 COM 口（active 里没有它，close/status 都碰不到）。
    const abandoned = await abandonBridge(ipcDir, pid, notes);
    if (abandoned.initialAlive) {
      notes.push(
        abandoned.alive
          ? "桥进程 " + String(pid) + " 杀不掉，可能还占着 " + portText + "；目录已用 abandoned.json 标记：" + ipcDir
          : "已终止启动失败的桥进程 pid " + String(pid) + "（避免占住 " + portText + "）；目录保留供排查：" + ipcDir,
      );
    } else {
      notes.push("桥进程已不在（pid " + String(pid) + "）；会话目录保留供排查：" + ipcDir);
    }
    return {
      ...base,
      bridge: { ...base.bridge, pid },
      serialError,
      message: "串口没有打开：" + formatSerialError(serialError),
      durationMs: Date.now() - started,
      notes,
    };
  }

  const session: ActiveSession = {
    sessionId,
    port: portText,
    identity,
    settings,
    ipcDir,
    bridgePid: pid,
    bridgeAlive: true,
    state: "open",
    persist,
    timeoutMs,
    maxLines,
    maxBytes,
    idleTimeoutMs,
    openedAtMs: Date.now(),
    uptimeMs: 0,
    rxBytes: status.rxBytes,
    txBytes: status.txBytes,
    bridgeHost: support.bridgeHost,
    bridgeScript: support.bridgeScript,
    bridgeExe: support.exe,
  };
  active = session;

  // 6) 记一笔（按 USB 身份）：只有真的打开了才写，失败参数不进记忆
  const remembered = rememberPort(facts, settings, env);
  if (!remembered.ok && remembered.error !== "") notes.push("端口记忆没写进去：" + remembered.error);
  if (identity.startsWith("com:")) notes.push("这个端口没有 USB 身份（虚拟串口 / 板载 UART），只能按 COM 号记参数");

  const view = snapshotOf(session, status);
  return {
    ok: true,
    session: view,
    settings,
    bridge: { exe: support.exe, script: support.bridgeScript, host: support.bridgeHost, pid },
    durationMs: Date.now() - started,
    serialError: null,
    message:
      "串口已打开：" +
      portText +
      "（" +
      String(settings.baudRate) +
      " " +
      String(settings.dataBits) +
      (settings.parity === "none" ? "N" : settings.parity[0]?.toUpperCase() ?? "?") +
      settings.stopBits +
      "，流控 " +
      settings.flow +
      "）",
    notes,
  };
}

function makeSessionId(): string {
  return new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14) + "-" + randomBytes(3).toString("hex");
}

function cleanupDir(ipcDir: string): void {
  try {
    rmSync(ipcDir, { recursive: true, force: true });
  } catch {
    // 清不掉就算了：反正它是死的，turn/end 还会再扫一遍
  }
}

interface AbandonOutcome {
  /** 收尸前 pid 还活着吗（活着才谈得上「收掉」）。 */
  initialAlive: boolean;
  /** 收尸之后还活着吗（true = 杀不掉，仍可能占着串口）。 */
  alive: boolean;
}

/**
 * 收掉一个启动失败的桥。
 *
 * 为什么必须专门收尾：open 只等 5 s，但 PowerShell 桥可能更晚才把串口打开。如果这时只是
 * 报错返回，桥会继续活着占住 COM 口，而 active 里没有它，close/status 都碰不到它。
 * 先发 close 命令让它自己体面退出，等不到再 kill；目录不删（bridge.log 是唯一线索），
 * 写 abandoned.json 标记，serialStatus 会把这种「活着但不在当前会话里」的目录算成 orphanDirs。
 */
async function abandonBridge(ipcDir: string, pid: number, notes: string[]): Promise<AbandonOutcome> {
  const initialAlive = pid !== 0 && pidAlive(pid);
  if (!initialAlive) return { initialAlive: false, alive: false };
  try {
    writeCommandFile(ipcDir, makeCommandId(), { action: "close" });
  } catch {
    // 目录不可写就跳过礼数，直接动手
  }
  if (!(await waitFor(() => !pidAlive(pid), 800))) {
    try {
      process.kill(pid);
    } catch (error) {
      notes.push("杀桥进程失败：" + describeError(error));
    }
    await waitFor(() => !pidAlive(pid), 1_500);
  }
  const alive = pidAlive(pid);
  try {
    writeFileSync(join(ipcDir, "abandoned.json"), JSON.stringify({ at: new Date().toISOString(), pid, alive, reason: "open-failed" }) + "\n", "utf8");
  } catch {
    // 标记写不进去不影响主流程
  }
  return { initialAlive, alive };
}

// ── read ─────────────────────────────────────────────────────────────────────

export interface SerialRecord {
  /** 毫秒时间戳（桥侧收到这行的时刻）。 */
  t: number;
  /** 行内容（不含换行）；partial=true 表示这是没有换行收尾的残行。 */
  d: string;
  partial: boolean;
}

export interface ReadSerialRequest {
  maxLines?: number;
  maxBytes?: number;
  sessionId?: string;
  env?: Env;
  signal?: AbortSignal;
}

export interface ReadSerialResult {
  ok: boolean;
  records: SerialRecord[];
  /** 这次读了多少字节。 */
  bytes: number;
  /** rx.ndjson 的总字节数（增量读取用：下次只在它变大时再读）。 */
  fileBytes: number;
  /** true = 文件比 maxBytes 大，只读了尾部（更早的行没给）。 */
  truncated: boolean;
  /** 被 JSON.parse 丢掉的行数（正常情况下 0）。 */
  badLines: number;
  session: SerialSessionView | null;
  serialError: SerialError | null;
  message: string;
}

interface TailRead {
  records: SerialRecord[];
  bytes: number;
  fileBytes: number;
  truncated: boolean;
  badLines: number;
}

/** 从 NDJSON 文件尾部读最多 maxBytes 字节、再取最后 maxLines 条。 */
function readNdjsonTail(path: string, maxBytes: number, maxLines: number): TailRead {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return { records: [], bytes: 0, fileBytes: 0, truncated: false, badLines: 0 };
  }
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  if (length <= 0) return { records: [], bytes: 0, fileBytes: size, truncated: false, badLines: 0 };
  const buffer = Buffer.alloc(length);
  try {
    const fd = openSync(path, "r");
    try {
      readSync(fd, buffer, 0, length, start);
    } finally {
      closeSync(fd);
    }
  } catch {
    return { records: [], bytes: 0, fileBytes: size, truncated: false, badLines: 0 };
  }
  let text = buffer.toString("utf8");
  // 从文件中间开始时，第一行可能是半截：丢掉它（它的完整内容在更早的位置，反正已经超出 maxBytes）
  if (start > 0) {
    const index = text.indexOf("\n");
    text = index >= 0 ? text.slice(index + 1) : "";
  }
  const lines = text.split("\n");
  const records: SerialRecord[] = [];
  let badLines = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const t = typeof parsed["t"] === "number" ? parsed["t"] : 0;
      const d = typeof parsed["d"] === "string" ? parsed["d"] : "";
      records.push({ t, d, partial: parsed["p"] === true });
    } catch {
      badLines += 1;
    }
  }
  const truncated = start > 0 || records.length > maxLines;
  return { records: records.slice(-maxLines), bytes: length, fileBytes: size, truncated, badLines };
}

export async function readSerial(request: ReadSerialRequest = {}): Promise<ReadSerialResult> {
  const env = request.env ?? process.env;
  const session = liveSession();
  if (session === null) {
    const error = makeSerialError("no-session");
    return { ok: false, records: [], bytes: 0, fileBytes: 0, truncated: false, badLines: 0, session: null, serialError: error, message: "没有串口会话：" + error.hint };
  }
  if (request.sessionId !== undefined && request.sessionId !== "" && request.sessionId !== session.sessionId) {
    const error = makeSerialError("no-session", { cause: "会话 " + request.sessionId + " 不是当前会话（当前 " + session.sessionId + "）" });
    return { ok: false, records: [], bytes: 0, fileBytes: 0, truncated: false, badLines: 0, session: snapshotOf(session, readStatusFile(session.ipcDir)), serialError: error, message: error.cause };
  }
  // 不给参数时用「打开会话时定的上限」，而不是永远回落到编译期默认值：
  // 用户在 open 时写了 maxLines=50，read 就该按 50 来，不然那个参数等于白给。
  const maxLines = clampInteger(request.maxLines, 1, SERIAL_LIMITS.maxLines, session.maxLines);
  const maxBytes = clampInteger(request.maxBytes, 256, SERIAL_LIMITS.maxBytes, session.maxBytes);
  const tail = readNdjsonTail(join(session.ipcDir, "rx.ndjson"), maxBytes, maxLines);
  const view = snapshotOf(session, readStatusFile(session.ipcDir));
  const bytesText = tail.fileBytes >= 1024 ? (tail.fileBytes / 1024).toFixed(1) + " KiB" : String(tail.fileBytes) + " B";
  return {
    ok: true,
    records: tail.records,
    bytes: tail.bytes,
    fileBytes: tail.fileBytes,
    truncated: tail.truncated,
    badLines: tail.badLines,
    session: view,
    serialError: null,
    message:
      tail.records.length === 0
        ? "没有收到数据（rx.ndjson " + bytesText + "）"
        : "读到 " + String(tail.records.length) + " 行（rx.ndjson " + bytesText + (tail.truncated ? "，只给了尾部" : "") + "）",
  };
}

// ── send ─────────────────────────────────────────────────────────────────────

export interface SendSerialRequest {
  text: string;
  /** 覆盖这次发送的换行；不给就用会话设置（默认 crlf）。 */
  newline?: SerialNewline;
  /** true = 原样发（不补换行）。 */
  raw?: boolean;
  sessionId?: string;
  env?: Env;
  signal?: AbortSignal;
}

export interface SendSerialResult {
  ok: boolean;
  /** 命令 id（done/<id>.json 的名字）。 */
  id: string;
  bytes: number;
  ackMs: number;
  session: SerialSessionView | null;
  serialError: SerialError | null;
  message: string;
}

interface DoneFile {
  ok: boolean;
  action: string;
  error: { kind: string; cause: string } | null;
  data: Record<string, unknown> | null;
}

function readDoneFile(ipcDir: string, id: string): DoneFile | null {
  const raw = readJsonFile<Record<string, unknown>>(join(ipcDir, "done", id + ".json"));
  if (raw === null) return null;
  const error = raw["error"];
  return {
    ok: raw["ok"] === true,
    action: asText(raw["action"]),
    error:
      error !== null && typeof error === "object"
        ? { kind: asText((error as Record<string, unknown>)["kind"]), cause: asText((error as Record<string, unknown>)["cause"]) }
        : null,
    data: dataOf(raw["data"]),
  };
}

function dataOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** 命令写临时文件再 rename：桥只认 *.json，永远不会读到半截。 */
function writeCommandFile(ipcDir: string, id: string, command: Record<string, unknown>): void {
  const dir = join(ipcDir, "cmd");
  const tmp = join(dir, "." + id + ".tmp");
  const target = join(dir, id + ".json");
  writeFileSync(tmp, JSON.stringify({ id, ...command }) + "\n", "utf8");
  renameSync(tmp, target);
}

export async function sendSerial(request: SendSerialRequest): Promise<SendSerialResult> {
  const started = Date.now();
  const env = request.env ?? process.env;
  const empty: SendSerialResult = { ok: false, id: "", bytes: 0, ackMs: 0, session: null, serialError: null, message: "" };
  const session = liveSession();
  if (session === null) {
    const error = makeSerialError("no-session");
    return { ...empty, serialError: error, message: "没有串口会话：" + error.hint };
  }
  if (request.sessionId !== undefined && request.sessionId !== "" && request.sessionId !== session.sessionId) {
    const error = makeSerialError("no-session", { cause: "会话 " + request.sessionId + " 不是当前会话（当前 " + session.sessionId + "）" });
    return { ...empty, session: snapshotOf(session, readStatusFile(session.ipcDir)), serialError: error, message: error.cause };
  }
  const text = typeof request.text === "string" ? request.text : "";
  // 空正文也可以：只发换行是合法操作（敲回车、flush 一行）。但「空正文 + 不补换行」等于什么都没发，
  // 这种调用几乎一定是参数写错了，直接说清楚比让它静默成功好。
  const effectiveNewline = request.raw === true ? "none" : request.newline ?? session.settings.newline;
  if (text === "" && effectiveNewline === "none") {
    const error = makeSerialError("settings-invalid", { cause: "text 是空的且 newline=none：这条命令什么都不会发出去" });
    return { ...empty, session: snapshotOf(session, readStatusFile(session.ipcDir)), serialError: error, message: "没有内容可发（text 为空且不补换行）" };
  }
  if (text.length > SERIAL_LIMITS.textChars) {
    const error = makeSerialError("settings-invalid", { cause: "text 太长（" + String(text.length) + " 字符，上限 " + String(SERIAL_LIMITS.textChars) + "）" });
    return { ...empty, session: snapshotOf(session, readStatusFile(session.ipcDir)), serialError: error, message: "text 太长" };
  }
  let newline = request.newline;
  if (request.raw === true) newline = "none";
  if (newline !== undefined && !SERIAL_NEWLINES.includes(newline)) {
    const error = makeSerialError("settings-invalid", { cause: "newline 只能是 crlf / lf / none" });
    return { ...empty, session: snapshotOf(session, readStatusFile(session.ipcDir)), serialError: error, message: "newline 不合法" };
  }
  const id = makeCommandId();
  const command: Record<string, unknown> = { action: "send", text };
  if (newline !== undefined) command["newline"] = newline;
  if (request.raw === true) command["raw"] = true;
  try {
    writeCommandFile(session.ipcDir, id, command);
  } catch (error) {
    const serialError = makeSerialError("access-denied", { cause: "写命令文件失败：" + describeError(error), evidence: [session.ipcDir] });
    return { ...empty, id, session: snapshotOf(session, readStatusFile(session.ipcDir)), serialError, message: "写命令文件失败" };
  }
  await waitFor(() => readDoneFile(session.ipcDir, id) !== null, ACK_WAIT_MS, request.signal);
  const done = readDoneFile(session.ipcDir, id);
  const ackMs = Date.now() - started;
  if (done === null) {
    const alive = pidAlive(session.bridgePid);
    const serialError = alive
      ? makeSerialError("bridge-start-timeout", {
          cause: "桥 " + String(ACK_WAIT_MS) + " ms 内没有确认命令 " + id,
          hint: "重试一次；若反复没有回执，先 close 再 open（桥可能卡在写串口上）。",
          evidence: bridgeLogTail(session.ipcDir),
        })
      : makeSerialError("bridge-crashed", { evidence: bridgeLogTail(session.ipcDir) });
    return { ...empty, id, ackMs, session: snapshotOf(session, readStatusFile(session.ipcDir)), serialError, message: "命令没有回执：" + serialError.cause };
  }
  const view = snapshotOf(session, readStatusFile(session.ipcDir));
  if (!done.ok) {
    const errorKind = done.error?.kind === "disconnected" ? "disconnected" : "bridge-crashed";
    const serialError = makeSerialError(errorKind, { cause: done.error?.cause ?? "桥拒绝了 send", evidence: bridgeLogTail(session.ipcDir) });
    return { ...empty, id, ackMs, session: view, serialError, message: "发送失败：" + serialError.cause };
  }
  const bytes = typeof done.data?.["bytes"] === "number" ? (done.data["bytes"] as number) : 0;
  return {
    ok: true,
    id,
    bytes,
    ackMs,
    session: view,
    serialError: null,
    message: "已发送 " + String(bytes) + " 字节（" + String(ackMs) + " ms 内确认）",
  };
}

function makeCommandId(): string {
  return Date.now().toString(36) + "-" + randomBytes(3).toString("hex");
}

// ── transact ─────────────────────────────────────────────────────────────────

export interface TransactSerialRequest {
  text: string;
  /** 期望出现的行（正则）；不给就只等到 timeoutMs 收尾。 */
  match?: string;
  /** 采集窗口（ms，默认 1000，上限 30000）。 */
  timeoutMs?: number;
  maxLines?: number;
  maxBytes?: number;
  newline?: SerialNewline;
  raw?: boolean;
  sessionId?: string;
  env?: Env;
  signal?: AbortSignal;
}

export interface TransactSerialResult {
  ok: boolean;
  /** 期望的 pattern 命中了没有；没给 match 时恒为 false。 */
  matched: boolean;
  /** 采集窗口内新产生的行（按时间顺序，不含打开会话之前的旧数据）。 */
  records: SerialRecord[];
  /** 命中的那一行（没有就是空串）。 */
  matchedLine: string;
  text: string;
  durationMs: number;
  timedOut: boolean;
  /** true = 采集窗口里读到的只是尾部（更早的行没进 records），与「等不到 until」是两件事。 */
  truncated: boolean;
  session: SerialSessionView | null;
  serialError: SerialError | null;
  message: string;
}

export async function transactSerial(request: TransactSerialRequest): Promise<TransactSerialResult> {
  const started = Date.now();
  const empty: TransactSerialResult = {
    ok: false,
    matched: false,
    records: [],
    matchedLine: "",
    text: typeof request.text === "string" ? request.text : "",
    durationMs: 0,
    timedOut: false,
    truncated: false,
    session: null,
    serialError: null,
    message: "",
  };
  let pattern: RegExp | null = null;
  if (request.match !== undefined && request.match !== "") {
    try {
      pattern = new RegExp(request.match, "u");
    } catch (error) {
      const serialError = makeSerialError("settings-invalid", { cause: "match 不是合法正则：" + describeError(error) });
      return { ...empty, serialError, message: serialError.cause };
    }
  }
  // 先记下当前 rx 文件长度：transact 只关心「这次发出去之后」的回包
  const session = liveSession();
  if (session === null) {
    const serialError = makeSerialError("no-session");
    return { ...empty, serialError, message: "没有串口会话：" + serialError.hint };
  }
  const rxPath = join(session.ipcDir, "rx.ndjson");
  let beforeBytes = 0;
  try {
    beforeBytes = statSync(rxPath).size;
  } catch {
    beforeBytes = 0;
  }
  const sent = await sendSerial({ ...request, sessionId: session.sessionId });
  if (!sent.ok) {
    return { ...empty, durationMs: Date.now() - started, session: sent.session, serialError: sent.serialError, message: sent.message };
  }
  const windowMs = clampInteger(request.timeoutMs, 0, SERIAL_LIMITS.timeoutMs, SERIAL_DEFAULTS.timeoutMs);
  const maxLines = clampInteger(request.maxLines, 1, SERIAL_LIMITS.maxLines, SERIAL_DEFAULTS.maxLines);
  const maxBytes = clampInteger(request.maxBytes, 256, SERIAL_LIMITS.maxBytes, SERIAL_DEFAULTS.maxBytes);
  const deadline = Date.now() + windowMs;
  let matchedLine = "";
  for (;;) {
    const tail = readNdjsonTail(rxPath, maxBytes, maxLines);
    const fresh = recordsAfter(tail, beforeBytes, session.ipcDir);
    if (pattern !== null) {
      const hit = fresh.find((record) => pattern.test(record.d));
      if (hit !== undefined) {
        matchedLine = hit.d;
        break;
      }
    }
    if (request.signal?.aborted === true) break;
    if (Date.now() >= deadline) break;
    await sleep(POLL_MS);
  }
  const tail = readNdjsonTail(rxPath, maxBytes, maxLines);
  const fresh = recordsAfter(tail, beforeBytes, session.ipcDir);
  const matched = pattern !== null && matchedLine !== "";
  const timedOut = !matched && Date.now() >= deadline;
  return {
    ok: true,
    matched,
    records: fresh,
    matchedLine,
    text: empty.text,
    durationMs: Date.now() - started,
    timedOut,
    truncated: tail.truncated,
    session: snapshotOf(session, readStatusFile(session.ipcDir)),
    serialError: null,
    message:
      (matched ? "命中期望的行：" + matchedLine : pattern === null ? "已发送（没有给 match，未等待特定回包）" : "窗口内没有出现期望的行") +
      "；本次收到 " +
      String(fresh.length) +
      " 行",
  };
}

/**
 * 只留「这次发出去之后」的行。
 * rx.ndjson 会被桥轮转（超 maxLogBytes 只留一半），所以不能只按文件偏移切：
 * 先把文件里第一条记录的 t 与发送前的文件大小对上，文件变短了就整份当新的。
 */
function recordsAfter(tail: TailRead, beforeBytes: number, ipcDir: string): SerialRecord[] {
  if (beforeBytes <= 0) return tail.records;
  let sizeNow = 0;
  try {
    sizeNow = statSync(join(ipcDir, "rx.ndjson")).size;
  } catch {
    return tail.records;
  }
  if (sizeNow < beforeBytes) return tail.records;
  const newBytes = sizeNow - beforeBytes;
  if (newBytes <= 0) return [];
  // 尾部读取只覆盖 byteLength 字节；用「新增字节数」从尾部再裁一刀，近似但足够稳
  let budget = newBytes;
  const out: SerialRecord[] = [];
  for (let i = tail.records.length - 1; i >= 0; i -= 1) {
    const record = tail.records[i];
    if (record === undefined) break;
    const size = Buffer.byteLength(JSON.stringify({ t: record.t, d: record.d, ...(record.partial ? { p: true } : {}) }) + "\n", "utf8");
    if (size > budget) break;
    budget -= size;
    out.unshift(record);
  }
  return out;
}

// ── status ───────────────────────────────────────────────────────────────────

export interface SerialStatusRequest {
  env?: Env;
  includeFiles?: boolean;
}

export interface SerialStatusResult {
  ok: boolean;
  open: boolean;
  session: SerialSessionView | null;
  /** 磁盘上还留着几个会话目录（含已死的），turn/end 会清。 */
  sessionDirs: number;
  staleDirs: string[];
  /** 目录里的 bridge.pid 还活着、但它不是当前会话：多半是 open 超时/宿主重启留下的孤儿桥。 */
  orphanDirs: string[];
  bridge: { pid: number; alive: boolean; state: string; reason: string; lastError: string };
  files: { rxBytes: number; txBytes: number; logBytes: number; pidBytes: number };
  configPath: string;
  platform: string;
  serialError: SerialError | null;
  message: string;
  notes: string[];
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function listSessionDirs(env: Env): string[] {
  const root = serialSessionsRoot(env);
  try {
    return readdirSync(root)
      .filter((name) => {
        try {
          return lstatSync(join(root, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .map((name) => root + "/" + name);
  } catch {
    return [];
  }
}

export async function serialStatus(request: SerialStatusRequest = {}): Promise<SerialStatusResult> {
  const env = request.env ?? process.env;
  const dirs = listSessionDirs(env);
  const session = liveSession();
  const staleDirs: string[] = [];
  const orphanDirs: string[] = [];
  for (const dir of dirs) {
    if (session !== null && dir === session.ipcDir) continue;
    const pid = readPidFile(dir);
    if (pid === 0 || !pidAlive(pid)) staleDirs.push(dir);
    else orphanDirs.push(dir);
  }
  const base: SerialStatusResult = {
    ok: true,
    open: session !== null,
    session: null,
    sessionDirs: dirs.length,
    staleDirs,
    orphanDirs,
    bridge: { pid: 0, alive: false, state: "", reason: "", lastError: "" },
    files: { rxBytes: 0, txBytes: 0, logBytes: 0, pidBytes: 0 },
    configPath: serialConfigPath(env),
    platform: process.platform,
    serialError: null,
    message: "",
    notes: [],
  };
  if (session === null) {
    const notes: string[] = [];
    if (staleDirs.length > 0) notes.push("死会话目录会由 turn/end 清理，也可以手动删：" + staleDirs.join("、"));
    if (orphanDirs.length > 0) {
      notes.push(
        "有 " + String(orphanDirs.length) + " 个桥进程还活着但不在当前会话里（可能占着 COM 口）：" +
          orphanDirs.join("、") +
          "；先用任务管理器结束对应的 powershell.exe/node，再删目录",
      );
    }
    return {
      ...base,
      message:
        dirs.length === 0
          ? "没有开着的串口会话"
          : "没有开着的串口会话（磁盘上还有 " + String(dirs.length) + " 个历史会话目录，其中 " + String(staleDirs.length) + " 个是死的" +
            (orphanDirs.length > 0 ? "，" + String(orphanDirs.length) + " 个还占着桥进程" : "") + "）",
      notes,
    };
  }
  const status = readStatusFile(session.ipcDir);
  const view = snapshotOf(session, status);
  const notes: string[] = [];
  if (status !== null && status.reason !== "" && status.state === "closed") notes.push("桥已自行关闭：" + status.reason);
  if (view.persist) notes.push("persist=true：turn/end 不会自动关这个会话");
  if (orphanDirs.length > 0) {
    notes.push("另有 " + String(orphanDirs.length) + " 个桥进程活着但不属于当前会话（可能是 open 超时/宿主重启的残留，占着 COM 口）：" + orphanDirs.join("、"));
  }
  return {
    ...base,
    session: view,
    bridge: {
      pid: session.bridgePid,
      alive: pidAlive(session.bridgePid),
      state: status?.state ?? "unknown",
      reason: status?.reason ?? "",
      lastError: status?.error?.cause ?? "",
    },
    files: {
      rxBytes: fileSize(join(session.ipcDir, "rx.ndjson")),
      txBytes: fileSize(join(session.ipcDir, "tx.ndjson")),
      logBytes: fileSize(join(session.ipcDir, "bridge.log")),
      pidBytes: fileSize(join(session.ipcDir, "bridge.pid")),
    },
    message: "会话 " + session.sessionId + " 开着：" + session.port + "（" + String(session.bridgePid) + "）",
    notes,
  };
}

// ── close ────────────────────────────────────────────────────────────────────

export interface CloseSerialRequest {
  sessionId?: string;
  /** true = 不发礼数，直接杀 pid。 */
  force?: boolean;
  env?: Env;
  signal?: AbortSignal;
}

export interface CloseSerialResult {
  ok: boolean;
  closed: boolean;
  forced: boolean;
  reason: string;
  session: SerialSessionView | null;
  durationMs: number;
  serialError: SerialError | null;
  message: string;
  notes: string[];
}

export async function closeSerial(request: CloseSerialRequest = {}): Promise<CloseSerialResult> {
  const started = Date.now();
  const env = request.env ?? process.env;
  const notes: string[] = [];
  const session = liveSession();
  if (session === null) {
    const serialError = makeSerialError("no-session");
    return { ok: false, closed: false, forced: false, reason: "", session: null, durationMs: Date.now() - started, serialError, message: "没有开着的串口会话（不需要关）", notes };
  }
  if (request.sessionId !== undefined && request.sessionId !== "" && request.sessionId !== session.sessionId) {
    const serialError = makeSerialError("no-session", { cause: "会话 " + request.sessionId + " 不是当前会话（当前 " + session.sessionId + "）" });
    return { ok: false, closed: false, forced: false, reason: "", session: snapshotOf(session, readStatusFile(session.ipcDir)), durationMs: Date.now() - started, serialError, message: serialError.cause, notes };
  }
  const view = snapshotOf(session, readStatusFile(session.ipcDir));
  const pid = session.bridgePid;
  let forced = false;

  // 先礼：发 close 命令，让桥自己关串口、写好 status 再退出。
  // 后兵：桥说「关了」不等于进程立刻消失（PowerShell 收尾要几十毫秒），
  //       所以要单独等 pid 真的没了；等到窗口用完还在，就动手杀。
  if (request.force !== true) {
    const id = makeCommandId();
    try {
      writeCommandFile(session.ipcDir, id, { action: "close" });
    } catch (error) {
      notes.push("写 close 命令失败（" + describeError(error) + "），直接杀进程");
      forced = true;
    }
    if (!forced) {
      const acknowledged = await waitFor(() => {
        const status = readStatusFile(session.ipcDir);
        if (status !== null && status.state === "closed") return true;
        return !pidAlive(pid);
      }, CLOSE_GRACE_MS, request.signal);
      if (!acknowledged) {
        notes.push("桥 " + String(CLOSE_GRACE_MS) + " ms 内没有优雅退出，强杀 pid " + String(pid));
        forced = true;
      } else if (!(await waitFor(() => !pidAlive(pid), 2_000, request.signal))) {
        notes.push("桥已关闭串口，但进程 " + String(pid) + " 还在，强杀");
        forced = true;
      }
    }
  } else {
    forced = true;
  }

  if (forced) {
    try {
      process.kill(pid);
    } catch (error) {
      notes.push("杀进程失败：" + describeError(error));
    }
    await waitFor(() => !pidAlive(pid), 1_000, request.signal);
  }

  const stillAlive = pidAlive(pid);
  const reason = readStatusFile(session.ipcDir)?.reason ?? "";
  active = null;
  if (stillAlive) {
    const serialError = makeSerialError("bridge-crashed", {
      cause: "桥进程 " + String(pid) + " 还活着（强杀没成功）",
      hint: "用任务管理器结束 powershell.exe（pid " + String(pid) + "），否则这个 COM 口会一直被占着。",
    });
    return { ok: false, closed: false, forced, reason, session: view, durationMs: Date.now() - started, serialError, message: serialError.cause, notes };
  }
  return {
    ok: true,
    closed: true,
    forced,
    reason,
    session: view,
    durationMs: Date.now() - started,
    serialError: null,
    message: (forced ? "会话已强制关闭：" : "会话已关闭：") + session.port + (reason !== "" ? "（" + reason + "）" : ""),
    notes,
  };
}

// ── turn/end 清理（留给工具层调用） ──────────────────────────────────────────

export interface TurnEndCleanupResult {
  closed: boolean;
  /** 被清掉的死会话目录。 */
  removedSessions: string[];
  keptSession: string;
  notes: string[];
}

/**
 * turn/end 的收尾：persist=false 的会话在这里关掉，顺手清死掉的会话目录。
 *
 * 为什么要由工具层触发而不是引擎自己定时：插件在 turn 结束时有明确的生命周期钩子，
 * 那边调用一次比在引擎里挂定时器更准（定时器全关掉不影响，漏关会一直占着 COM 口）。
 */
export async function cleanupSerialOnTurnEnd(request: { env?: Env } = {}): Promise<TurnEndCleanupResult> {
  const env = request.env ?? process.env;
  const notes: string[] = [];
  let closed = false;
  let keptSession = "";
  const session = liveSession();
  if (session !== null) {
    if (session.persist) {
      keptSession = session.sessionId;
      notes.push("persist=true，保留会话 " + session.sessionId + "（" + session.port + "）");
    } else {
      const result = await closeSerial({ env });
      closed = result.closed;
      notes.push(result.message);
    }
  }
  const removedSessions: string[] = [];
  for (const dir of listSessionDirs(env)) {
    if (keptSession !== "" && dir.endsWith("/" + keptSession)) continue;
    const pid = readPidFile(dir);
    if (pid !== 0 && pidAlive(pid)) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
      removedSessions.push(dir);
    } catch {
      notes.push("清不掉：" + dir);
    }
  }
  return { closed, removedSessions, keptSession, notes };
}
