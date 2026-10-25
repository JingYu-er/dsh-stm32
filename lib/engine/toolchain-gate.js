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
import { resolveSearchConfig, searchConfigWarnings, } from "../data/search-roots.js";
import { readToolchainConfig, toolchainConfigPath } from "../data/toolchain-config.js";
import { COMPONENT_INSTALLABILITY, guideLines, guidesFor, } from "../data/install-guides.js";
import { buildTargets, probeTarget, resolveFromDirs, } from "./probe.js";
/** 能力 → 必需组件（id 与 probe.buildTargets 一致）。 */
export const CAPABILITY_COMPONENTS = {
    build: ["gcc", "cmake", "ninja"],
    flash: ["openocd"],
    debug: ["openocd", "gdb"],
    generate: ["cubemx", "cubemx-java"],
};
const CAPABILITY_LABEL = {
    build: "编译",
    flash: "烧录",
    debug: "调试",
    generate: "生成代码",
};
const PROBE_CACHE_TTL_MS = 60_000;
const probeCache = new Map();
/** 单测 / 换机器后清缓存。 */
export function resetGateCache() {
    probeCache.clear();
}
/** 容错解析 envCheck：缺省 block，写了不认识的值也按 block（保守）。 */
export function normalizeEnvCheck(value) {
    if (value === "off" || value === "warn" || value === "block")
        return value;
    if (typeof value === "string") {
        const lowered = value.trim().toLowerCase();
        if (lowered === "off" || lowered === "warn" || lowered === "block")
            return lowered;
    }
    return "block";
}
function targetById(targets, id) {
    return targets.find((target) => target.id === id);
}
/** 纯文件存在性判断：不走 PATH、不 spawn。命中就说明"这个目录里确实有"。 */
function locateFast(target, config) {
    for (const candidate of target.candidates) {
        const hit = resolveFromDirs(candidate, config.binDirs);
        if (hit !== null)
            return hit;
    }
    return null;
}
/** 组件 → 安装方式；表里没有的按 auto（pacman 能补的居多）。 */
function installabilityOf(id) {
    const entry = COMPONENT_INSTALLABILITY[id];
    return entry === undefined ? "auto" : entry;
}
function toMissing(target, probe) {
    const missing = {
        id: target.id,
        label: target.label,
        hint: target.hint,
        impact: target.impact,
        install: target.install,
        verify: target.verify,
        installability: installabilityOf(target.id),
    };
    const error = probe?.error ?? "";
    if (error !== "")
        missing.error = error;
    return missing;
}
function joinLabels(items) {
    return items.map((item) => item.label).join("、");
}
function buildMessage(capability, mode, missing) {
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
    const auto = missing.filter((item) => item.installability === "auto");
    const manual = missing.filter((item) => item.installability === "manual");
    let nextStep;
    if (manual.length === 0) {
        nextStep =
            "要我装吗？回一句「装」，我先跑 stm32_env_install 出计划（只列大小与步骤、不下载），确认后才真装；"
                + "想自己装就看下面 missing[0].install 的第一条。";
    }
    else if (auto.length === 0) {
        nextStep =
            "这几项插件不代装（CubeMX 是 GUI 向导 + 要 ST 账号，固件包只由 CubeMX 的包管理器维护）："
                + "照着 guides[].steps 走，装完把路径写进配置再重跑；离线机器可以整目录拷过来（看 guides[].portable）。";
    }
    else {
        nextStep =
            "能自动装的（" + joinLabels(auto) + "）回一句「装」，我先出计划（不下载）；"
                + joinLabels(manual) + " 得你自己装，步骤见 guides[].steps。";
    }
    return {
        message: "缺 " + names + "，这次没有开始" + label + "：" + effect + "。",
        nextStep,
    };
}
function buildDetail(capability, mode, checked, missing, msys64, configPath, cacheHit, warnings, guides) {
    const lines = [];
    lines.push("能力：" + CAPABILITY_LABEL[capability] + "（" + capability + "），envCheck=" + mode);
    lines.push("必需组件：" + checked.join("、"));
    if (missing.length === 0) {
        lines.push("结果：齐全。");
    }
    else {
        lines.push("结果：缺 " + String(missing.length) + " 项 ——");
        for (const item of missing) {
            lines.push("  · " + item.label + "：" + item.hint);
            lines.push("    方式：" + (item.installability === "auto" ? "自动（插件可代装：stm32_env_install）" : "手动（插件不代装，按下面的指引）"));
            lines.push("    影响：" + item.impact);
            lines.push("    安装：" + (item.install[0] ?? "（无建议）"));
            lines.push("    自检：" + item.verify);
        }
        for (const guide of guides) {
            for (const line of guideLines(guide))
                lines.push(line);
        }
    }
    lines.push("MSYS2 配置：" + (msys64 === "" ? "未配置" : msys64) + "（" + configPath + "）");
    for (const warning of warnings)
        lines.push("⚠ " + warning);
    if (cacheHit)
        lines.push("（探测结果来自 60 s 缓存）");
    return lines.join("\n");
}
/**
 * 判断并给出结论。不抛异常：宿主缺 subprocess 时按"只做了文件存在性检查"处理。
 */
export async function ensureToolchain(ctx, request) {
    const started = Date.now();
    const capability = request.capability;
    const mode = normalizeEnvCheck(request.envCheck);
    const checked = [...CAPABILITY_COMPONENTS[capability]];
    const configPath = toolchainConfigPath(process.env);
    const userConfig = readToolchainConfig(process.env).config;
    const msys64 = userConfig?.msys64 ?? "";
    const overrides = {};
    if (request.binDirs !== undefined)
        overrides.binDirs = request.binDirs;
    if (request.cubeMxRoots !== undefined)
        overrides.cubeMxRoots = request.cubeMxRoots;
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
            installability: "none",
            guides: [],
        };
    }
    const targets = buildTargets(config);
    const wanted = [];
    for (const id of checked) {
        const target = targetById(targets, id);
        if (target !== undefined)
            wanted.push(target);
    }
    // 快路径：文件都在就放行，一次 spawn 都不做。
    const unresolved = [];
    for (const target of wanted) {
        if (locateFast(target, config) === null)
            unresolved.push(target);
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
            detail: buildDetail(capability, mode, checked, [], msys64, configPath, false, warnings, []),
            warnings,
            installability: "none",
            guides: [],
        };
    }
    // 慢路径：解析 + 一次版本命令（可能从 PATH 里找到），带 60 s 缓存。
    const cacheKey = [
        capability,
        config.binDirs.join(";"),
        config.cubeMxRoots.join(";"),
    ].join("|");
    let cacheHit = false;
    let probed = [];
    const cached = probeCache.get(cacheKey);
    if (cached !== undefined && Date.now() - cached.at < PROBE_CACHE_TTL_MS) {
        cacheHit = true;
        probed = cached.results;
    }
    else {
        const subprocess = ctx.get("subprocess");
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
        }
        else {
            const options = {
                timeoutMs: request.timeoutMs ?? 15_000,
            };
            if (request.signal !== undefined)
                options.signal = request.signal;
            for (const target of wanted) {
                probed.push(await probeTarget(subprocess, target, config, options));
                if (request.signal?.aborted === true)
                    break;
            }
        }
        probeCache.set(cacheKey, { at: Date.now(), results: probed });
    }
    const missing = [];
    for (const target of wanted) {
        // 快路径已经确认过存在的组件不重复判缺：probe 失败只可能是版本命令本身有问题。
        if (!unresolved.includes(target))
            continue;
        const probe = probed.find((item) => item.id === target.id);
        if (probe !== undefined && probe.found)
            continue;
        missing.push(toMissing(target, probe));
    }
    const { message, nextStep } = buildMessage(capability, mode, missing);
    const guides = guidesFor(missing.map((item) => item.id));
    const installability = missing.length === 0 ? "none" : missing.some((item) => item.installability === "manual") ? "manual" : "auto";
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
        detail: buildDetail(capability, mode, checked, missing, msys64, configPath, cacheHit, warnings, guides),
        warnings,
        installability,
        guides,
    };
}
/** 报告里的 notes 行：只在 blocked/warn 时写，免得成功路径噪音。 */
export function gateReportNotes(result) {
    // 配置告警与成败无关：即使这次齐全，也值得让用户知道"你配的某个路径本机没有"。
    if (result.ok)
        return result.warnings.map((warning) => "⚠ " + warning);
    const lines = [];
    lines.push(result.message);
    for (const item of result.missing) {
        lines.push("缺 " + item.label + "：" + item.hint);
        if (item.install[0] !== undefined)
            lines.push("  安装：" + item.install[0]);
    }
    if (result.nextStep !== "")
        lines.push(result.nextStep);
    // manual 缺件：卡片上就给前两步，够用户判断"这事要不要我自己动手"。
    for (const guide of result.guides) {
        for (const line of guideLines(guide, 2))
            lines.push(line);
    }
    for (const warning of result.warnings)
        lines.push("⚠ " + warning);
    return lines;
}
/** 一句话给别的工具拼失败报告用（tool card 第一行）。 */
export function gateBlockedMessage(result) {
    return result.message;
}
