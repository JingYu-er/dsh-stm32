/**
 * L1：工具链探测。
 *
 * 纯解析 + 一次版本执行。候选路径来自数据（search-roots），这里只负责
 * "找到可执行文件 → 跑一次版本命令 → 归纳成一条结论"。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runCapture } from "./subprocess-runner.js";
const WINDOWS = process.platform === "win32";
function isAbsoluteCandidate(value) {
    return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\") || value.startsWith("/");
}
function executableVariants(value) {
    if (!WINDOWS)
        return [value];
    if (/\.(exe|cmd|bat)$/iu.test(value))
        return [value];
    return [value + ".exe", value + ".cmd", value];
}
/** 在给定目录（以及 PATH 兜底前）解析一个候选。 */
export function resolveFromDirs(candidate, binDirs) {
    if (isAbsoluteCandidate(candidate)) {
        for (const variant of executableVariants(candidate))
            if (existsSync(variant))
                return variant;
        return null;
    }
    for (const dir of binDirs) {
        for (const variant of executableVariants(join(dir, candidate))) {
            if (existsSync(variant))
                return variant;
        }
    }
    return null;
}
function firstMeaningfulLine(text) {
    for (const line of text.split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (trimmed !== "")
            return trimmed;
    }
    return "";
}
async function resolveCandidate(subprocess, candidate, config, options) {
    const fromDirs = resolveFromDirs(candidate, config.binDirs);
    if (fromDirs !== null)
        return fromDirs;
    if (isAbsoluteCandidate(candidate))
        return null;
    try {
        return await subprocess.resolveExecutable(candidate, undefined, options.signal);
    }
    catch {
        return null;
    }
}
export async function probeTarget(subprocess, target, config, options = {}) {
    let lastError = "";
    for (const candidate of target.candidates) {
        const resolved = await resolveCandidate(subprocess, candidate, config, options);
        if (resolved === null)
            continue;
        if (target.versionArgs.length === 0) {
            return {
                id: target.id,
                label: target.label,
                found: true,
                path: resolved,
                version: "",
                required: target.required,
                hint: target.hint,
                error: "",
            };
        }
        const outcome = await runCapture(subprocess, {
            argv: [resolved, ...target.versionArgs],
            timeoutMs: options.timeoutMs ?? 15_000,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (outcome.spawnError !== null) {
            lastError = candidate + ": " + outcome.spawnError;
            continue;
        }
        if (outcome.timedOut) {
            lastError = candidate + ": 版本命令超时";
            continue;
        }
        if (outcome.exitCode !== 0) {
            lastError =
                candidate + ": 退出码 " + String(outcome.exitCode) + " " + firstMeaningfulLine(outcome.stderr);
            continue;
        }
        const version = firstMeaningfulLine(outcome.stdout) || firstMeaningfulLine(outcome.stderr);
        return {
            id: target.id,
            label: target.label,
            found: true,
            path: resolved,
            version,
            required: target.required,
            hint: target.hint,
            error: "",
        };
    }
    return {
        id: target.id,
        label: target.label,
        found: false,
        path: "",
        version: "",
        required: target.required,
        hint: target.hint,
        error: lastError,
    };
}
export async function probeAll(subprocess, targets, config, options = {}) {
    const results = [];
    for (const target of targets) {
        results.push(await probeTarget(subprocess, target, config, options));
        if (options.signal?.aborted === true)
            break;
    }
    return results;
}
/** 本机需要的能力清单。路径全部来自配置，不在逻辑里硬编码。 */
export function buildTargets(config) {
    const cubeMxLaunchers = config.cubeMxRoots.map((dir) => dir + "/STM32CubeMX.exe");
    const cubeMxJavas = config.cubeMxRoots.map((dir) => dir + "/jre/bin/java.exe");
    return [
        {
            id: "gcc",
            label: "arm-none-eabi-gcc",
            candidates: ["arm-none-eabi-gcc"],
            versionArgs: ["--version"],
            required: true,
            hint: "安装 GNU Arm 工具链（msys64: pacman -S mingw-w64-ucrt-x86_64-arm-none-eabi-gcc）",
        },
        {
            id: "gdb",
            label: "GDB（arm-none-eabi-gdb 或 gdb-multiarch）",
            candidates: ["arm-none-eabi-gdb", "gdb-multiarch"],
            versionArgs: ["--version"],
            required: true,
            hint: "调试与烧录链路需要 gdb；msys64 包 mingw-w64-ucrt-x86_64-arm-none-eabi-gdb 或 gdb-multiarch",
        },
        {
            id: "openocd",
            label: "OpenOCD",
            candidates: ["openocd"],
            versionArgs: ["--version"],
            required: true,
            hint: "烧录/调试服务端；msys64 包 mingw-w64-ucrt-x86_64-openocd",
        },
        {
            id: "cmake",
            label: "CMake",
            candidates: ["cmake"],
            versionArgs: ["--version"],
            required: true,
            hint: "msys64 包 mingw-w64-ucrt-x86_64-cmake（或 ST 扩展自带 bundle）",
        },
        {
            id: "ninja",
            label: "Ninja",
            candidates: ["ninja"],
            versionArgs: ["--version"],
            required: true,
            hint: "msys64 包 mingw-w64-ucrt-x86_64-ninja",
        },
        {
            id: "cubemx",
            label: "STM32CubeMX（启动器）",
            candidates: cubeMxLaunchers,
            versionArgs: [],
            required: false,
            hint: "只有生成工程需要；可用 STM32_CUBEMX_ROOT 指定安装根目录",
        },
        {
            id: "cubemx-java",
            label: "STM32CubeMX 内置 JRE（无头调用必需）",
            candidates: cubeMxJavas,
            versionArgs: ["-version"],
            required: false,
            hint: "必须用 jre/bin/java.exe -jar STM32CubeMX.exe -q <script> 调用，直接跑 exe 会 detach 后假退出",
        },
    ];
}
