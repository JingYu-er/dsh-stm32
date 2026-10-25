/**
 * L1：CubeMX 无头脚本与日志判定。
 *
 * 只做字符串层面的确定性工作：把参数拼成 CubeMX 的脚本命令、把 CubeMX 的
 * 日志读成 { ok, errors, warnings }。不启动进程、不碰文件系统，便于单测。
 *
 * 脚本语法来自实测（M0）：config load <ioc> / generate <layout> / generate code <dir> / exit。
 */
/** 生成布局：coupled = 外设初始化写进 main.c（与 ST VS Code 扩展的默认工程一致）。 */
export function layoutCommand(layout) {
    return layout === "coupled" ? "generate all_code_in_main" : "generate one_file_per_ip";
}
/** 路径里有空格就加引号（CubeMX 脚本按空格切参数）。 */
function quoteArg(value) {
    return value.includes(" ") ? '"' + value + '"' : value;
}
/**
 * CubeMX -q 脚本正文。
 *
 * 注意：generate code 的参数必须是**目录**；传 .ioc 路径会静默无操作（M0 E3）。
 *
 * firmwareDir 非空时插一行 project setCustomFWPath —— 这是实测**唯一**能让 CubeMX
 * 真的用上指定固件包的机制（docs §14：丢进 Repository 会被静默忽略、只改 .ioc 会挂死）。
 * 它必须排在 config load 之后、generate code 之前。
 */
export function buildGenerateScript(iocPath, outDir, layout, firmwareDir = "") {
    const lines = ["config load " + iocPath];
    const firmware = firmwareDir.trim();
    if (firmware !== "")
        lines.push("project setCustomFWPath " + quoteArg(firmware));
    lines.push(layoutCommand(layout), "generate code " + outDir, "exit", "");
    return lines.join("\n");
}
/** CubeMX 自己拼写为 "Code succesfully generated under ..."。 */
const SUCCESS_PATTERN = /Code succesfully generated under/iu;
/**
 * 与本芯片无关的噪音（M0 实测：每次生成都有，永远不消失）。
 * 每条都说明为什么可以忽略，避免以后误判成回归。
 */
const KNOWN_NOISE = [
    { pattern: /PDSC version is not supported/iu, reason: "第三方包索引版本提示" },
    { pattern: /OptionalMessage_ERROR/iu, reason: "CubeMX 的提示级日志" },
    { pattern: /Pin8 \(VP_RIF_VS_RIF1\)/iu, reason: "该虚拟引脚不属于 F103" },
    { pattern: /(ADCFreqValue|FamilyName|MCOFreq_Value|USBFreq_Value)/u, reason: "RCC 内部占位参数校验提示" },
    { pattern: /Updater is busy/iu, reason: "CubeMX 自带更新器的瞬时忙状态（实测出现在生成成功的那次）" },
];
function isKnownNoise(line) {
    return KNOWN_NOISE.some((entry) => entry.pattern.test(line));
}
/**
 * 脚本命令不认（CubeMX 版本换了命令名）时的标志。
 * 为什么单独判：setCustomFWPath 被忽略时 CubeMX 照样打印生成成功，
 * 于是会拿到一个「成功但用错固件包」的结果 —— 比直接失败更难查。
 */
const UNKNOWN_COMMAND_PATTERN = /Unknown command|Unrecognized command|Invalid command|command not found|Command not recognized/iu;
/** 把 CubeMX 输出判成结论。只要出现成功行就算成功，其余按错误归类。 */
export function parseGenerateLog(text) {
    const errors = [];
    const commandErrors = [];
    const knownNoise = [];
    let successLine = "";
    for (const rawLine of text.split(/\r?\n/u)) {
        const line = rawLine.trim();
        if (line === "")
            continue;
        if (UNKNOWN_COMMAND_PATTERN.test(line)) {
            commandErrors.push(line.slice(0, 300));
            continue;
        }
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
        if (!looksLikeError)
            continue;
        errors.push(line.slice(0, 300));
    }
    // 脚本命令不被认（例如 setCustomFWPath）时，成功行也不作数。
    if (commandErrors.length > 0) {
        return { ok: false, successLine, errors: [...commandErrors, ...errors], knownNoise };
    }
    // 有成功行就以成功行为准：CubeMX 过程中偶发的 ERROR（如 Updater is busy）不代表生成失败。
    if (successLine !== "") {
        for (const error of errors)
            knownNoise.push("（生成成功时的过程告警）" + error);
        errors.length = 0;
    }
    return { ok: successLine !== "", successLine, errors, knownNoise };
}
