/**
 * L1：CubeMX 无头脚本与日志判定。
 *
 * 只做字符串层面的确定性工作：把参数拼成 CubeMX 的脚本命令、把 CubeMX 的
 * 日志读成 { ok, errors, warnings }。不启动进程、不碰文件系统，便于单测。
 *
 * 脚本语法来自实测（M0）：config load <ioc> / generate <layout> / generate code <dir> / exit。
 */

export type GenerateLayout = "coupled" | "per-ip";

/** 生成布局：coupled = 外设初始化写进 main.c（与 ST VS Code 扩展的默认工程一致）。 */
export function layoutCommand(layout: GenerateLayout): string {
  return layout === "coupled" ? "generate all_code_in_main" : "generate one_file_per_ip";
}

/**
 * CubeMX -q 脚本正文。
 *
 * 注意：generate code 的参数必须是**目录**；传 .ioc 路径会静默无操作（M0 E3）。
 */
export function buildGenerateScript(
  iocPath: string,
  outDir: string,
  layout: GenerateLayout,
): string {
  return [
    "config load " + iocPath,
    layoutCommand(layout),
    "generate code " + outDir,
    "exit",
    "",
  ].join("\n");
}

export interface GenerateVerdict {
  ok: boolean;
  /** 命中的成功行（CubeMX 原文，含其拼写成功 succesfully）。 */
  successLine: string;
  errors: string[];
  /** 已知噪音：与本芯片无关的 PDSC/RCC 提示，单独归类，不当作失败。 */
  knownNoise: string[];
}

/** CubeMX 自己拼写为 "Code succesfully generated under ..."。 */
const SUCCESS_PATTERN = /Code succesfully generated under/iu;

/**
 * 与本芯片无关的噪音（M0 实测：每次生成都有，永远不消失）。
 * 每条都说明为什么可以忽略，避免以后误判成回归。
 */
const KNOWN_NOISE: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /PDSC version is not supported/iu, reason: "第三方包索引版本提示" },
  { pattern: /OptionalMessage_ERROR/iu, reason: "CubeMX 的提示级日志" },
  { pattern: /Pin8 \(VP_RIF_VS_RIF1\)/iu, reason: "该虚拟引脚不属于 F103" },
  { pattern: /(ADCFreqValue|FamilyName|MCOFreq_Value|USBFreq_Value)/u, reason: "RCC 内部占位参数校验提示" },
  { pattern: /Updater is busy/iu, reason: "CubeMX 自带更新器的瞬时忙状态（实测出现在生成成功的那次）" },
];

function isKnownNoise(line: string): boolean {
  return KNOWN_NOISE.some((entry) => entry.pattern.test(line));
}

/** 把 CubeMX 输出判成结论。只要出现成功行就算成功，其余按错误归类。 */
export function parseGenerateLog(text: string): GenerateVerdict {
  const errors: string[] = [];
  const knownNoise: string[] = [];
  let successLine = "";
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (SUCCESS_PATTERN.test(line)) {
      successLine = line;
      continue;
    }
    // 先认噪音再认错误：噪音行（如 OptionalMessage_ERROR）里也带 ERROR 字样。
    if (isKnownNoise(line)) {
      knownNoise.push(line.slice(0, 200));
      continue;
    }
    const looksLikeError = /\bERROR\b|\bError\s*:|\bException\b|\bFAILED\b|\bFATAL\b/u.test(line);
    if (!looksLikeError) continue;
    errors.push(line.slice(0, 300));
  }
  // 有成功行就以成功行为准：CubeMX 过程中偶发的 ERROR（如 Updater is busy）不代表生成失败。
  if (successLine !== "") {
    for (const error of errors) knownNoise.push("（生成成功时的过程告警）" + error);
    errors.length = 0;
  }
  return { ok: successLine !== "", successLine, errors, knownNoise };
}
