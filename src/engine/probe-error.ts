/**
 * B2：结构化探针错误 —— flash / debug / session 三条路径共用一份分类。
 *
 * 为什么要有它：2d 的错误码只是一张枚举，失败时模型还得去读中文 message 才知道下一步。
 * 现在一次分类就给全五样东西：
 *   - kind：契约字段（模型可以按它分支），旧错误码字段直接删掉，不做兼容别名（用户已定）；
 *   - cause：一句话根因，给人看也够；
 *   - hint：可执行的下一步（四类真机验过的故障各自有专属文案）；
 *   - evidence：原始日志行，逐字保留，别让模型凭二手转述猜；
 *   - retryable：照 hint 弄完再调一次同一个工具有没有意义（true＝值得重试）。
 *
 * 归类顺序敏感：先 no-probe 再 probe-busy —— 把"被占用"读成"没插"会让人白拔线。
 * 同一套规则同时服务 flash（openocd program）与 debug（openocd + gdb），改一处两边一起变。
 */

import type { JsonSchema } from "../types.js";

/** 探针失败的八类：前六类是日志特征，timeout 由调用方给，unknown 是兜底。 */
export type ProbeErrorKind =
  | "no-probe"
  | "probe-busy"
  | "swd-locked"
  | "flash-protected"
  | "no-power"
  | "target-mismatch"
  | "timeout"
  | "unknown";

/** 枚举的运行时形态（工具 schema 的 enum 也用它，避免第二个真相）。 */
export const PROBE_ERROR_KINDS: readonly ProbeErrorKind[] = [
  "no-probe",
  "probe-busy",
  "swd-locked",
  "flash-protected",
  "no-power",
  "target-mismatch",
  "timeout",
  "unknown",
];

/** 失败发生在哪一步：烧录、一次性调试快照、常驻调试会话。 */
export type ProbeFailureStage = "flash" | "debug" | "session";

export interface ProbeError {
  kind: ProbeErrorKind;
  cause: string;
  hint: string;
  evidence: string[];
  retryable: boolean;
}

export interface ProbeFailureInput {
  /** openocd / gdb 的原始日志行（顺序即日志顺序，归类按首个命中判定）。 */
  lines: readonly string[];
  /** 进程退出码；还没结算时给 null（例如 openocd 15 s 没开始监听）。 */
  exitCode?: number | null;
  stage: ProbeFailureStage;
  /** 调用方判定为超时（flash 的 runStreaming、gdb 的 runStreaming 都会给）。 */
  timedOut?: boolean;
  /** 进程压根没起来（ENOENT 之类）。 */
  spawnError?: string | null;
}

// ── 文案：hint 是给用户的下一步，cause 是一句话根因 ────────────────────────────────

export const HINT_PROBE =
  "找不到 CMSIS-DAP 探针：检查 USB、是否被 openocd/调试会话占用（先停掉正在跑的调试），必要时换一根数据线再试。";
export const HINT_BUSY =
  "探针没有正常响应：先确认没有第二个 openocd / 调试会话在同时用它（两个 openocd 抢同一个 CMSIS-DAP 时不报错，而是满屏 transfer count mismatch）；如果确认只有一个进程，那就是探针固件卡住了——把探针拔下来等 3 秒再插回，然后重试。";
export const HINT_DP =
  "连不上芯片（Error connecting DP）：固件里可能关了 SWD（__HAL_AFIO_REMAP_SWJ_DISABLE），需要 BOOT0=1 重启进系统 bootloader 再烧，或按住复位键在连接瞬间松开。";
export const HINT_FLASH_PROTECTED =
  "Flash 被写保护/读保护挡住：先做一次全片擦除（openocd 的 stm32f1x mass_erase）或解除读保护（RDP）再烧；量产片上确实要保持保护时，这次烧录就不可能成功，别再原地重试。";
export const HINT_NO_POWER =
  "目标板没供电：量一下 3V3/GND，检查 BOOT0/BOOT1 跳线与杜邦线接触，USB 供电不足时换独立电源再试。";
export const HINT_TARGET_MISMATCH =
  "连上的不是目标芯片：openocd 的 target 配置（stm32f1x）与实测 device id 不符——确认板上确实是 STM32F103 系列，或把 .ioc / 芯片型号参数改对再试。";
export const HINT_TIMEOUT =
  "超时：目标没在等（断点没命中、程序跑飞）或探针链路太慢——先把 adapter speed 降到 1000 或 100，确认固件真的会跑到断点，再适度加大 timeoutMs 重试。";
export const HINT_UNKNOWN =
  "日志里没有能归类的特征：把 evidence 或日志尾部贴出来核对，并用 stm32_doctor 看探针占用与工具链状态，别盲目重试。";

const HINT_BY_KIND: Record<ProbeErrorKind, string> = {
  "no-probe": HINT_PROBE,
  "probe-busy": HINT_BUSY,
  "swd-locked": HINT_DP,
  "flash-protected": HINT_FLASH_PROTECTED,
  "no-power": HINT_NO_POWER,
  "target-mismatch": HINT_TARGET_MISMATCH,
  timeout: HINT_TIMEOUT,
  unknown: HINT_UNKNOWN,
};

/**
 * retryable 的判据只有一个：「照 hint 处理完，再调一次同一个工具有没有意义」。
 * 需要换流程/换芯片/改工程配置才能过的，一律 false——否则模型会拿同一条命令空转。
 */
const RETRYABLE_BY_KIND: Record<ProbeErrorKind, boolean> = {
  "no-probe": true, // 插好线 / 停掉占用就能再烧
  "probe-busy": true, // 让出探针即可重试
  "swd-locked": true, // 按 hint 用 BOOT0 进 bootloader 后同一条命令能成
  "flash-protected": false, // 要先解保护，不属于"再试一次"
  "no-power": true, // 供电接好就能再烧
  "target-mismatch": false, // 芯片或配置不对，重试只会得到同样的报错
  timeout: true, // 降速/加大超时是有效调整
  unknown: false, // 没有依据，重试等于赌
};

const CAUSE_TIMEOUT: Record<ProbeFailureStage, string> = {
  flash: "烧录超时：openocd 没在 timeoutMs 内跑完 program",
  debug: "调试超时：gdb 没在 timeoutMs 内命中断点或没能收尾",
  session: "会话超时：openocd 没在超时前开始监听 gdb 端口",
};

interface Matcher {
  kind: ProbeErrorKind;
  cause: string;
  re: RegExp;
}

/**
 * 日志特征表（顺序即优先级）：判据全部沿用 2d 的那套正则，一条都没改，
 * 只是从"返回枚举"变成"带根因的有序表"。
 */
const MATCHERS: readonly Matcher[] = [
  {
    kind: "no-probe",
    cause: "openocd 找不到 CMSIS-DAP 探针（没插好 / 被占用 / 本机没认到 USB 设备）",
    re: /unable to find a matching cmsis-dap device|no device found/u,
  },
  {
    kind: "probe-busy",
    cause: "探针被另一个进程攥着（adapter 初始化没抢到）",
    re: /adapter speed could not be limited|target is openocd and must be halted/u,
  },
  {
    // 真板子取证（2026-10-28）：两个 openocd 同时抓同一个 CMSIS-DAP 时，openocd 不会报"忙"，
    // 而是两边交替收发导致 DAP 事务错位——满屏 transfer count mismatch / command mismatch。
    kind: "probe-busy",
    // 实测两种成因都会落到这里：① 两个 openocd 同时抓探针 → transfer/command mismatch；
    // ② 探针固件卡住（上一次会话被硬杀）→ CMSIS-DAP command CMD_INFO failed，此时没有任何
    //    并发进程，Windows 里 HID 设备状态也正常，只能拔插恢复（2026-10-31 复现两次）。
    cause: "探针没有正常响应（被另一个进程同时访问，或探针固件卡住）",
    re: /cmsis-dap (transfer count mismatch|command mismatch)|cmsis-dap command cmd_\w+ failed|libusb_error_busy/u,
  },
  {
    kind: "swd-locked",
    cause: "芯片侧 SWD 连不上（固件关了调试口 / 调试访问口被锁）",
    re: /error connecting dp|cannot read idr|ap lock|sticky error/u,
  },
  {
    kind: "flash-protected",
    cause: "Flash 被写保护/读保护挡住",
    re: /flash programming|write protected|read protected|memory protected/u,
  },
  {
    kind: "no-power",
    cause: "目标芯片供电不足或没供电",
    re: /target voltage may be too low|no power/u,
  },
  {
    kind: "target-mismatch",
    cause: "连上的芯片 ID 与 target 配置（stm32f1x）不一致",
    re: /device id|cannot identify|unexpected idcode/u,
  },
];

/** 一条"看起来像根因"的行；只用于 unknown / 超时的 evidence 兜底。 */
const PROBLEM_LINE_RE = /error|unable to find|no device found|couldn't bind|cannot open|invalid/u;

const MAX_EVIDENCE = 4;

function nonEmpty(lines: readonly string[]): string[] {
  return lines.filter((line) => line.trim() !== "");
}

/** 命中同一特征的所有原始行（逐字保留，去重，最多 MAX_EVIDENCE 条）。 */
function evidenceOf(lines: readonly string[], re: RegExp): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (!re.test(line.toLowerCase())) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    kept.push(line);
    if (kept.length >= MAX_EVIDENCE) break;
  }
  return kept;
}

/** 日志里第一条真正说明问题的行（给 message 用，避免只报"起不来"）。 */
export function firstProblemLine(lines: readonly string[]): string {
  const hit = lines.find((line) => /^Error|unable to find|no device found|couldn't bind|cannot open|invalid/i.test(line));
  return (hit ?? lines[lines.length - 1] ?? "").trim();
}

/** openocd 报"找不到设备"的那几行错误行（2a 的判定基准，纯函数便于单测）。 */
export function probeMissingLines(errors: readonly string[]): string[] {
  return errors.filter((line) => /CMSIS-DAP device|no device found/iu.test(line));
}

/** USB 形态诊断的结论该以什么 note 呈现（unknown 静默：诊断失败不能把失败报告搞得更吵）。 */
export function usbNoteFor(kind: string, detail: string): string | null {
  if (kind === "unknown") return null;
  return "USB 形态：" + detail;
}

/** 每一类的默认根因（调用方没给更准的说法时用它，避免出现"未知原因"这种废话）。 */
const CAUSE_BY_KIND: Record<ProbeErrorKind, string> = {
  "no-probe": "找不到 CMSIS-DAP 探针（没插好 / 被占用 / 本机没认到 USB 设备）",
  "probe-busy": "探针或探针口被另一个进程占着",
  "swd-locked": "芯片侧 SWD 连不上（固件关了调试口 / 调试访问口被锁）",
  "flash-protected": "Flash 被写保护/读保护挡住",
  "no-power": "目标芯片供电不足或没供电",
  "target-mismatch": "连上的芯片 ID 与 target 配置（stm32f1x）不一致",
  timeout: "超时",
  unknown: "有失败但日志特征都不命中，分不出是哪一类原因",
};

export function buildProbeError(kind: ProbeErrorKind, cause: string, evidence: string[]): ProbeError {
  return { kind, cause, hint: HINT_BY_KIND[kind], evidence, retryable: RETRYABLE_BY_KIND[kind] };
}

/**
 * 直接按类构造一条 ProbeError（B3 端口被占这种"没有 openocd 日志可归类"的场景用）。
 * hint / retryable 仍然只有一份真相：都来自同一张表。
 */
export function makeProbeError(kind: ProbeErrorKind, detail: { cause?: string; evidence?: string[] } = {}): ProbeError {
  return buildProbeError(kind, detail.cause ?? CAUSE_BY_KIND[kind], detail.evidence ?? []);
}

/**
 * 把一次失败归到 8 类之一（B2 的唯一分类入口）。
 *
 * 判定顺序：日志特征（MATCHERS，先见者优先）→ 超时 → 进程没起来 → unknown。
 * 具体特征优先于超时：既打印了 "Error connecting DP" 又超时的，说"锁片"比说"超时"有用。
 */
export function classifyProbeFailure(input: ProbeFailureInput): ProbeError {
  const lines = nonEmpty(input.lines);
  for (const matcher of MATCHERS) {
    const evidence = evidenceOf(lines, matcher.re);
    if (evidence.length > 0) return buildProbeError(matcher.kind, matcher.cause, evidence);
  }

  if (input.timedOut === true) {
    const timeoutLines = evidenceOf(lines, /timed out|timeout/u);
    const evidence = timeoutLines.length > 0 ? timeoutLines : lines.slice(-1);
    return buildProbeError("timeout", CAUSE_TIMEOUT[input.stage], evidence);
  }

  const spawnError = input.spawnError ?? "";
  if (spawnError.trim() !== "") {
    return buildProbeError("unknown", input.stage === "flash" ? "openocd 启动失败：" + spawnError.trim() : "调试进程启动失败：" + spawnError.trim(), [spawnError.trim()]);
  }

  const problems = evidenceOf(lines, PROBLEM_LINE_RE);
  const evidence = problems.length > 0 ? problems : lines.slice(-MAX_EVIDENCE);
  const exitText = input.exitCode === undefined || input.exitCode === null ? "" : "（退出码 " + String(input.exitCode) + "）";
  return buildProbeError("unknown", "有失败但日志特征都不命中，分不出是哪一类原因" + exitText, evidence);
}

/**
 * 工具层 output schema 里的 probeError 片段：flash / debug（以及后续会话）共用同一份，
 * 加一个 kind 只改这里。**不进 required** —— 成功路径引擎给 null，而宿主不接受 null，
 * 工具层会用 flashReportForHost / debugReportForHost 把 null 摘掉再交给宿主。
 */
export const PROBE_ERROR_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: [...PROBE_ERROR_KINDS] },
    cause: { type: "string" },
    hint: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    retryable: { type: "boolean" },
  },
  required: ["kind", "cause", "hint", "evidence", "retryable"],
};

/** 报告卡片与 errors 摘要统一用这句：「错误：<kind> — <cause>；建议：<hint>」。 */
export function formatProbeError(error: ProbeError): string {
  return "错误：" + error.kind + " — " + error.cause + "；建议：" + error.hint;
}
