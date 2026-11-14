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
/** 在给定目录（以及 PATH 回退之前）解析一个候选。 */
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
/**
 * 引擎里找可执行文件的统一入口：先按显式目录（msys64 / binDirs）找文件，
 * 再交给宿主解析（等价于 PATH）。门禁（toolchain-gate）走的是同一套规则，
 * 两边不一致就会出现"门禁说齐全、引擎说找不到"的错位。
 */
export async function resolveToolIn(subprocess, names, binDirs, signal) {
    const dirs = [...binDirs];
    for (const name of names) {
        const hit = resolveFromDirs(name, dirs);
        if (hit !== null)
            return hit;
    }
    if (subprocess === null || subprocess === undefined)
        return null;
    if (typeof subprocess.resolveExecutable !== "function")
        return null;
    for (const name of names) {
        try {
            const resolved = await subprocess.resolveExecutable(name, undefined, signal);
            if (typeof resolved === "string" && resolved !== "")
                return resolved;
        }
        catch {
            // 宿主解析失败（命令不存在）就继续试下一个候选名。
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
    // 只认候选目录时到此为止：再往 PATH 退就分不清"装到了这个目录"和"机器上本来就有"。
    if (options.allowPathFallback === false)
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
                impact: target.impact,
                install: target.install,
                verify: target.verify,
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
            impact: target.impact,
            install: target.install,
            verify: target.verify,
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
        impact: target.impact,
        install: target.install,
        verify: target.verify,
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
/** 从 binDirs 里认出 MSYS2 根（<root>/ucrt64/bin 这种形状）。 */
export function msys64RootFromBinDirs(binDirs) {
    for (const dir of binDirs) {
        const match = /^(.*)\/(?:ucrt64|mingw64|clang64|mingw32)\/bin$/iu.exec(dir);
        const root = match?.[1] ?? "";
        if (root !== "")
            return root;
    }
    return "";
}
/**
 * 安装建议中的 pacman：已知用户的 MSYS2 位置时使用该路径，未知时给出 MSYS2 的默认安装位置。
 * 绝不写死开发机的 D:/app/msys64 —— 别人机器上没这个目录，贴出来的命令等于假的。
 */
function pacmanHint(config) {
    const root = msys64RootFromBinDirs(config.binDirs);
    return (root === "" ? "C:/msys64" : root) + "/usr/bin/pacman.exe -S ";
}
/** 本机需要的能力清单。路径全部来自配置，不在逻辑里硬编码。 */
export function buildTargets(config) {
    const pacman = pacmanHint(config);
    const cubeMxLaunchers = config.cubeMxRoots.map((dir) => dir + "/STM32CubeMX.exe");
    const cubeMxJavas = config.cubeMxRoots.map((dir) => dir + "/jre/bin/java.exe");
    const cubeMxDefaultRoot = "C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeMX";
    return [
        {
            id: "gcc",
            label: "arm-none-eabi-gcc",
            candidates: ["arm-none-eabi-gcc"],
            versionArgs: ["--version"],
            required: true,
            hint: "编译工具链：在MSYS2内执行 pacman 安装对应包",
            impact: "项目编译无法完成，无法生成可执行固件，烧录与调试功能全部失效。",
            install: [
                "已有MSYS2（推荐方案）：" + pacman + "mingw-w64-ucrt-x86_64-arm-none-eabi-gcc（13.3.0版本）",
                "无MSYS2环境：使用winget安装Arm官方工具链，安装后将工具bin目录添加到配置项STM32_BIN_DIRS",
                "安装自检命令：arm-none-eabi-gcc --version",
            ],
            verify: "arm-none-eabi-gcc --version",
        },
        {
            id: "gdb",
            label: "GDB（arm-none-eabi-gdb / gdb-multiarch）",
            candidates: ["arm-none-eabi-gdb", "gdb-multiarch"],
            versionArgs: ["--version"],
            required: false,
            hint: "在线调试必备程序，仅编译烧录可以不安装",
            impact: "断点调试功能无法启动；仅执行固件烧录不受影响。",
            install: [
                "MSYS2环境：" + pacman + "mingw-w64-ucrt-x86_64-gdb-multiarch（16.2版本，UCRT64仓库无arm-none-eabi-gdb包）",
                "不使用MSYS2：安装Arm官方GNU工具链，自带arm-none-eabi-gdb，把bin目录加入工具搜索路径",
                "安装自检命令：gdb-multiarch --version",
            ],
            verify: "gdb-multiarch --version",
        },
        {
            id: "openocd",
            label: "OpenOCD",
            candidates: ["openocd"],
            versionArgs: ["--version"],
            required: false,
            hint: "烧录与调试服务程序，可由CubeProgrammer替代",
            impact: "无法使用OpenOCD完成烧录与调试；仅代码生成、项目编译不受影响，可切换为CubeProgrammer完成烧录。",
            install: [
                "MSYS2环境：" + pacman + "mingw-w64-ucrt-x86_64-openocd（0.12.0版本）",
                "无MSYS2环境：winget安装xpack开源版本OpenOCD",
                "安装自检命令：openocd --version",
            ],
            verify: "openocd --version",
        },
        {
            id: "cmake",
            label: "CMake",
            candidates: ["cmake"],
            versionArgs: ["--version"],
            required: true,
            hint: "项目构建配置工具，CMake工程必须依赖",
            impact: "工程配置阶段直接失败，无法生成编译目录；仅烧录现成固件文件不受限制。",
            install: [
                "MSYS2环境：" + pacman + "mingw-w64-ucrt-x86_64-cmake（3.31.5版本）",
                "备选方案：winget安装Kitware.CMake，VS Code STM32插件通常自带CMake程序",
                "安装自检命令：cmake --version",
            ],
            verify: "cmake --version",
        },
        {
            id: "ninja",
            label: "Ninja",
            candidates: ["ninja"],
            versionArgs: ["--version"],
            required: true,
            hint: "高速编译构建工具，当前工程预设使用Ninja生成器",
            impact: "CMake配置失败，编译流程直接中断，无法构建项目。",
            install: [
                "MSYS2环境：" + pacman + "mingw-w64-ucrt-x86_64-ninja（1.12.1版本）",
                "备选方案：winget安装Ninja-build.Ninja",
                "安装自检命令：ninja --version",
            ],
            verify: "ninja --version",
        },
        {
            id: "kicad",
            label: "KiCad 10（kicad-cli / bun / pcbnew）",
            candidates: ["kicad-cli", ...config.binDirs.map((dir) => dir + "/kicad-cli.exe")],
            versionArgs: ["version"],
            required: false,
            hint: "电路设计：生成 KiCad 工程、ERC/DRC 检查、Gerber/STEP 导出都调用它自带的 kicad-cli 与 bun",
            impact: "原理图读取、电路设计的构建与检查、制造文件与交付包导出全部不可用；固件编译、烧录、调试不受影响。",
            install: [
                "官网安装：kicad.org/download 选 Windows 10.x 安装包，默认目录会被自动检索",
                "非默认目录：配置 DSH_STM32_KICAD_ROOT 指向安装根目录（内含 bin/ 与 share/kicad/）",
                "安装自检命令：kicad-cli version（应输出 10.x）",
            ],
            verify: "kicad-cli version",
        },
        {
            id: "npm",
            label: "npm（安装 tscircuit 依赖）",
            candidates: ["npm", ...config.binDirs.map((dir) => dir + "/npm.cmd")],
            versionArgs: ["--version"],
            required: false,
            hint: "电路设计首次构建要在 hardware/circuit 下执行 npm install（约 730 MB 依赖）",
            impact: "电路设计无法安装 tscircuit 依赖，构建、检查与导出都起不来；其余功能不受影响。",
            install: [
                "安装 Node.js LTS：winget install OpenJS.NodeJS.LTS（npm 随之安装）",
                "已有 Node.js：确认 npm 在 PATH；nvm 等多版本管理器先切到带 npm 的版本",
                "安装自检命令：npm --version",
            ],
            verify: "npm --version",
        },
        {
            id: "cubeprogrammer",
            label: "STM32CubeProgrammer（CLI备用烧录后端）",
            candidates: (config.cubePrgBins ?? []).map((dir) => dir + "/STM32_Programmer_CLI.exe"),
            versionArgs: [],
            required: false,
            hint: "备用烧录工具，仅支持ST-LINK调试探针",
            impact: "仅OpenOCD烧录失败时无法切换备用方案；代码生成、编译、调试均不受影响，DAPLink探针无需该工具。",
            install: [
                "下载安装：前往ST官网下载安装包，默认路径可被程序自动检索识别",
                "自定义安装路径：将程序bin目录写入配置STM32_CUBE_PRG_ROOT，或写入config.json配置文件",
            ],
            verify: "STM32_Programmer_CLI.exe -l（列出本机可用调试接口）",
        },
        {
            id: "cubemx",
            label: "STM32CubeMX（图形配置启动程序）",
            candidates: cubeMxLaunchers,
            versionArgs: [],
            required: false,
            hint: "仅新建工程、重新生成初始化代码时需要",
            impact: "无法创建新项目与重新生成外设初始化代码；编译、烧录、调试以及ioc文件只读分析功能均可正常使用。",
            install: [
                "安装方式：ST官网下载安装包（winget暂无该软件），默认安装路径会被自动检索",
                "自定义路径：配置STM32_CUBEMX_ROOT指向安装根目录，目录内必须包含exe与jre文件夹",
                "安装自检：运行stm32_doctor重新探测，cubemx项显示正常即可",
            ],
            verify: "重跑探测命令，cubemx条目检测状态为正常",
        },
        {
            id: "cubemx-java",
            label: "STM32CubeMX内置JRE（无头代码生成依赖）",
            candidates: cubeMxJavas,
            versionArgs: ["-version"],
            required: false,
            hint: "后台静默生成代码必须使用内置JRE，直接启动exe会异常退出",
            impact: "无头自动生成代码会执行失败；直接双击打开GUI软件不受影响。多数情况是只拷贝exe文件，缺少配套jre目录。",
            install: [
                "解决办法：使用官方完整安装包重装CubeMX，保证jre目录完整",
                "安装自检：<安装根目录>/jre/bin/java.exe -version 可正常输出版本号",
            ],
            verify: "重跑探测命令，cubemx-java条目检测状态为正常",
        },
    ];
}
