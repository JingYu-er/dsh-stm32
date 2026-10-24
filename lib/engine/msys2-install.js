/**
 * MSYS2 安装器（L2）：把"这台机器缺工具链"从一句建议变成一次可复核的安装。
 *
 * 三条设计红线，都是为了"只做用户授权过的事"：
 *   1. 默认只出计划。计划里连目标目录都不建、配置不写、注册表不碰——真装要写几百 MB 磁盘
 *      还要改用户级 PATH，这种动作必须由用户明确点一次（工具层 dryRun:false + confirm:true）。
 *   2. 绝不请求管理员。PATH 只改 HKCU\Environment（用户级），不碰 HKLM；也不用 setx
 *      （setx 会在 1024 字符处截断 PATH，还会丢掉 REG_EXPAND_SZ 的变量展开语义）。
 *   3. 不做卸载，也不删用户的任何东西。只清理自己建的暂存目录与 .part 半成品；目标目录非空
 *      就停下来报警——宁可让用户换目录，也不猜"这个 msys64 目录能不能覆盖"。
 *
 * 为什么装完不需要用户重读环境变量：插件自己读工具链配置（data/toolchain-config）里的绝对
 * 路径，装完立刻生效；PATH 只是顺手给命令行和其他工具用的。
 *
 * 下载只用系统 curl、解压只用官方 sfx，不引第三方包（插件保持零运行时依赖）。
 */
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync, } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { DEFAULT_BIN_DIRS, dedupePaths, discoverInstalls, discoveryDisabled, normalizePathEntry, splitList, } from "../data/search-roots.js";
import { readToolchainConfig, toolchainConfigPath, updateToolchainConfig, } from "../data/toolchain-config.js";
import { buildTargets, probeAll } from "./probe.js";
import { runCapture } from "./subprocess-runner.js";
/** 下载/解压/补包都是分钟级：默认给 15 分钟，调用方可用 timeoutMs 覆盖。 */
const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60_000;
/** 自检只跑版本命令，不该慢。 */
const PROBE_TIMEOUT_MS = 15_000;
const WINDOWS = process.platform === "win32";
/**
 * 官方自解压包。名字里必须带 base：GitHub releases 上**没有** msys2-x86_64-latest.sfx.exe
 * 这个资产（msys2-x86_64-latest.exe 是图形安装器），sfx 只有 msys2-base-x86_64-latest.sfx.exe。
 * 它解压出一个顶层 msys64 目录，所以官方文档写 -y -oC:\ 就会得到 C:\msys64。
 */
const INSTALLER_FILE = "msys2-base-x86_64-latest.sfx.exe";
export const MSYS2_INSTALLER_URL = "https://github.com/msys2/msys2-installer/releases/latest/download/" + INSTALLER_FILE;
/** 该资产的字节数（实测 43,060,392）；只用于计划里的用量估算，不参与校验。 */
export const MSYS2_INSTALLER_BYTES = 43_060_392;
/** 默认补的包：编译器 / 调试器 / 烧录服务端 / 构建系统 / 构建工具。 */
export const DEFAULT_MSYS2_PACKAGES = [
    "mingw-w64-ucrt-x86_64-arm-none-eabi-gcc",
    "mingw-w64-ucrt-x86_64-gdb-multiarch",
    "mingw-w64-ucrt-x86_64-openocd",
    "mingw-w64-ucrt-x86_64-cmake",
    "mingw-w64-ucrt-x86_64-ninja",
];
/** 配置与自动发现都没有时建议装这里；只作为建议，不自动采用（"装到哪"得用户点头）。 */
export const MSYS2_SUGGESTED_ROOT = "C:/msys64";
/** 自检关注的 5 个组件（覆盖 toolchain-gate 的 build/flash/debug 三项能力）。 */
const VERIFY_IDS = ["gcc", "cmake", "ninja", "openocd", "gdb"];
/** 每步的 id + 人话标签；顺序就是执行顺序。 */
const STEP_DEFS = [
    { id: "prepare", label: "准备安装目录" },
    { id: "download", label: "下载 MSYS2 安装包" },
    { id: "extract", label: "静默解压到目标目录" },
    { id: "pacman", label: "pacman 补装工具链组件" },
    { id: "path", label: "写用户级 PATH" },
    { id: "verify", label: "自检 5 个组件" },
    { id: "config", label: "写入工具链配置" },
];
/** 单包下载字节估算；只用于"计划总量"那句话，缺省值给个数量级即可。 */
const PACKAGE_BYTES = {
    "mingw-w64-ucrt-x86_64-arm-none-eabi-gcc": 62_000_000,
    "mingw-w64-ucrt-x86_64-gdb-multiarch": 22_000_000,
    "mingw-w64-ucrt-x86_64-openocd": 3_000_000,
    "mingw-w64-ucrt-x86_64-cmake": 33_000_000,
    "mingw-w64-ucrt-x86_64-ninja": 600_000,
};
const PACKAGE_BYTES_DEFAULT = 10_000_000;
const PATH_KEY = "HKCU\\Environment";
/* ------------------------------ 小工具 ------------------------------ */
function toPosix(value) {
    return normalizePathEntry(value);
}
function toWindowsDir(dir) {
    return dir.replace(/\//gu, "\\");
}
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
/** 人读的体量；估算值也走这里，保证卡片上单位一致。 */
export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0)
        return "0 MB";
    const value = bytes / (1024 * 1024);
    return (value >= 100 ? value.toFixed(0) : value.toFixed(1)) + " MB";
}
function dedupeStrings(values) {
    const seen = new Set();
    const out = [];
    for (const value of values) {
        const trimmed = value.trim();
        if (trimmed === "")
            continue;
        const key = trimmed.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(trimmed);
    }
    return out;
}
/** 取最后一行非空内容：把子进程噪音压成一句给用户看。 */
function lastLine(text) {
    const lines = text.split(/\r?\n/u);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const trimmed = (lines[index] ?? "").trim();
        if (trimmed !== "")
            return trimmed;
    }
    return "";
}
function fileSize(path) {
    try {
        const stat = statSync(path);
        return stat.isFile() ? stat.size : 0;
    }
    catch {
        return 0;
    }
}
/**
 * 缓存是不是一个真的 exe（MZ 头）。
 * 为什么查：下载中断留下的半截文件若只按 size>0 判断，会被下一次当成有效缓存，
 * 于是解压永远失败，用户只能自己猜该删哪个文件。
 */
function looksLikeExecutable(path) {
    if (fileSize(path) < 2)
        return false;
    let fd = -1;
    try {
        fd = openSync(path, "r");
        const buffer = Buffer.alloc(2);
        const read = readSync(fd, buffer, 0, 2, 0);
        return read === 2 && buffer[0] === 0x4d && buffer[1] === 0x5a;
    }
    catch {
        return false;
    }
    finally {
        if (fd >= 0) {
            try {
                closeSync(fd);
            }
            catch {
                // 关不掉不影响结论
            }
        }
    }
}
function safeList(dir) {
    try {
        return readdirSync(dir);
    }
    catch {
        return [];
    }
}
function removeFileQuietly(path) {
    try {
        if (existsSync(path))
            unlinkSync(path);
    }
    catch {
        // 清理失败不影响主结论
    }
}
/**
 * 清掉暂存目录/半成品。
 * 只对**我们自己建的**路径调用（.part 与 .dsh-msys2-staging）：用户的东西一个都不删。
 */
function removeDirQuietly(dir) {
    try {
        rmSync(dir, { recursive: true, force: true });
    }
    catch {
        // 删不掉就留着，不影响结论
    }
}
function isMsys2Root(dir) {
    return dir !== "" && existsSync(dir + "/usr/bin/bash.exe");
}
function msys2PackagesTotal(packages) {
    let total = 0;
    for (const name of packages)
        total += PACKAGE_BYTES[name] ?? PACKAGE_BYTES_DEFAULT;
    return total;
}
function isAborted(signal) {
    return signal?.aborted === true;
}
/**
 * 安装包地址：MSYS2_INSTALLER_URL 整体替换 > MSYS2_MIRROR 前缀替换 > 官方地址。
 * MSYS2_MIRROR 允许两种写法：给全（以 .exe/.7z/.zip 结尾）直接当完整地址用，否则当前缀拼文件名。
 */
export function resolveInstallerUrl(env) {
    const direct = (env["MSYS2_INSTALLER_URL"] ?? "").trim();
    if (direct !== "")
        return { url: direct, note: "安装包地址来自环境变量 MSYS2_INSTALLER_URL" };
    const mirror = (env["MSYS2_MIRROR"] ?? "").trim().replace(/\/+$/u, "");
    if (mirror !== "") {
        const full = /\.(exe|7z|zip)$/iu.test(mirror) ? mirror : mirror + "/" + INSTALLER_FILE;
        return {
            url: full,
            note: "安装包地址来自环境变量 MSYS2_MIRROR（镜像）；官方源是 " + MSYS2_INSTALLER_URL,
        };
    }
    return { url: MSYS2_INSTALLER_URL, note: "" };
}
/** 配置目录（与 toolchain-config 同目录）；不可用时退回系统临时目录。 */
function stateDir(env) {
    const configPath = toolchainConfigPath(env);
    const dir = toPosix(dirname(configPath));
    return dir === "" ? toPosix(tmpdir()) : dir;
}
function cacheFilePath(env) {
    // 固定文件名：换镜像/换版本不会堆一堆包体；要换版本就自己删这个文件。
    return stateDir(env) + "/msys2-latest.sfx.exe";
}
/** 路径所在盘符是否真的存在：跨机器的配置（配置里是 D:/app/msys64，本机没有 D 盘）不能当安装目标。 */
function driveUsable(path, exists = existsSync) {
    const match = /^([A-Za-z]):/u.exec(path);
    if (match === null || match[1] === undefined)
        return true;
    return exists(match[1].toUpperCase() + ":/");
}
/** "D:/app/msys64/ucrt64/bin" → "D:/app/msys64"；"C:/msys64/mingw64/bin" 同理。 */
function rootFromBinDir(binDir) {
    const normalized = toPosix(binDir);
    if (normalized === "")
        return "";
    const withoutBin = normalized.replace(/\/bin$/iu, "");
    return withoutBin.replace(/\/(ucrt64|mingw64|clang64|mingw32|usr)$/iu, "");
}
/** 候选根：默认候选表 + 自动发现的 bin 目录。纯计算，不 spawn。 */
function msys64Candidates(env) {
    const roots = [];
    for (const binDir of DEFAULT_BIN_DIRS) {
        const root = rootFromBinDir(binDir);
        if (root !== "")
            roots.push(root);
    }
    if (!discoveryDisabled(env)) {
        for (const binDir of discoverInstalls().binDirs) {
            const root = rootFromBinDir(binDir);
            if (root !== "")
                roots.push(root);
        }
    }
    return dedupePaths(roots);
}
/**
 * 决策顺序：显式 targetDir > 配置里的 msys64 > 自动发现的（判 <root>/usr/bin/bash.exe）> 都没有。
 * 都没有时**不猜**：装到哪必须由用户说一句。
 */
export function resolveTargetDir(explicit, config, env, 
/** 单测注入用；生产代码不要传（默认看真实文件系统）。 */
exists = existsSync) {
    const fromArg = explicit === undefined ? "" : toPosix(explicit);
    if (fromArg !== "")
        return { msys64: fromArg, via: "arg", warning: "" };
    const fromConfig = config === null ? "" : toPosix(config.msys64);
    if (fromConfig !== "") {
        if (driveUsable(fromConfig, exists))
            return { msys64: fromConfig, via: "config", warning: "" };
        // 配置可能是从别的机器拷来的：盘符都不存在，既不能当安装目标，也不能当"已装"。
        const warning = "配置里的 MSYS2 根 " +
            fromConfig +
            " 在本机不存在（盘符都没有，配置大概是从别的机器拷来的），已忽略，请指定 targetDir";
        for (const candidate of msys64Candidates(env)) {
            if (isMsys2Root(candidate))
                return { msys64: candidate, via: "discovered", warning };
        }
        return { msys64: "", via: "", warning };
    }
    for (const candidate of msys64Candidates(env)) {
        // 只认"能跑"的：目录在但缺 usr/bin/bash.exe 的半成品不算已安装。
        if (isMsys2Root(candidate))
            return { msys64: candidate, via: "discovered", warning: "" };
    }
    return { msys64: "", via: "", warning: "" };
}
/** 需要决策时建议装哪：发现表里已经存在的目录优先（可能是用户以前装过的位置），否则 C:/msys64。 */
function suggestMsys64Root(env) {
    for (const candidate of msys64Candidates(env)) {
        if (existsSync(candidate))
            return candidate;
    }
    return MSYS2_SUGGESTED_ROOT;
}
export function viaLabel(via) {
    switch (via) {
        case "arg":
            return "参数 targetDir";
        case "config":
            return "配置里的 msys64";
        case "discovered":
            return "自动发现";
        case "suggested":
            // 契约里的保留值：自动采用建议路径会把"装到哪"变成隐式决定，我们不这么做。
            return "建议路径（尚未确认）";
        default:
            return "还没决定";
    }
}
function emptyUserPath(error) {
    return { raw: "", entries: [], found: false, error };
}
/** 从 reg query 的输出里抠出值（形如：    Path    REG_EXPAND_SZ    C:\a;D:\b）。 */
function parseRegValue(text, name) {
    const lowered = name.toLowerCase();
    for (const line of text.split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (!trimmed.toLowerCase().startsWith(lowered))
            continue;
        const match = /^\S+\s{2,}(REG_[A-Z_]+)\s{2,}([\s\S]*)$/u.exec(trimmed);
        if (match !== null)
            return (match[2] ?? "").trim();
    }
    return "";
}
async function readUserPath(subprocess, signal) {
    if (!WINDOWS)
        return emptyUserPath("非 Windows：没有用户级 PATH 可写");
    const outcome = await runCapture(subprocess, {
        argv: ["reg.exe", "query", PATH_KEY, "/v", "Path"],
        timeoutMs: 10_000,
        ...(signal === undefined ? {} : { signal }),
    });
    if (outcome.spawnError !== null)
        return emptyUserPath(outcome.spawnError);
    if (outcome.timedOut)
        return emptyUserPath("reg query 超时");
    if (outcome.exitCode !== 0) {
        // 最常见的"失败"其实是用户变量里根本没有 Path：不是错误，当空值继续。
        return emptyUserPath(lastLine(outcome.stderr) || "reg query 退出码 " + String(outcome.exitCode));
    }
    const raw = parseRegValue(outcome.stdout, "Path");
    return { raw, entries: splitList(raw), found: true, error: "" };
}
function composeUserPath(raw, entry) {
    const base = raw.replace(/\s+$/u, "").replace(/;+$/u, "");
    return base === "" ? entry : base + ";" + entry;
}
function pathContains(current, entry) {
    const key = toPosix(entry).toLowerCase();
    if (key === "")
        return false;
    return current.entries.some((item) => item.toLowerCase() === key);
}
function planPathState(current, binDir, writePath) {
    const state = {
        done: false,
        changed: false,
        before: current.raw,
        after: current.raw,
        backup: "",
        error: "",
    };
    if (binDir === "" || !writePath)
        return state;
    const entry = toWindowsDir(binDir);
    // 已经在里面：after 与 before 相同，卡片上就看得出"不会变"。
    if (pathContains(current, entry))
        return state;
    state.after = composeUserPath(current.raw, entry);
    return state;
}
/** 旧 PATH 落盘备份（写注册表前）；备份失败就不写 PATH——有回滚能力比省一次点击重要。 */
function writePathBackup(raw, env) {
    const dir = stateDir(env);
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const path = dir + "/path-backup-" + stamp + ".txt";
    try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, raw + "\n", "utf8");
        return { path, error: "" };
    }
    catch (error) {
        return { path: "", error: describeError(error) };
    }
}
async function applyUserPath(subprocess, env, binDir, request) {
    // 就在要写之前再读一次：计划阶段到真装之间，用户可能自己动过环境变量。
    const current = await readUserPath(subprocess, request.signal);
    const state = planPathState(current, binDir, request.writePath);
    if (binDir === "" || !request.writePath)
        return state;
    const entry = toWindowsDir(binDir);
    if (pathContains(current, entry)) {
        state.done = true;
        return state;
    }
    if (!WINDOWS) {
        state.error =
            "只有 Windows 有 HKCU\\Environment；当前平台请自己把 " + binDir + " 加进 shell 的 PATH";
        return state;
    }
    const backup = writePathBackup(current.raw, env);
    if (backup.error !== "") {
        state.error = "备份旧 PATH 失败，为安全起见没写注册表：" + backup.error;
        return state;
    }
    state.backup = backup.path;
    const outcome = await runCapture(subprocess, {
        argv: ["reg.exe", "add", PATH_KEY, "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", state.after, "/f"],
        timeoutMs: 15_000,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (outcome.spawnError !== null) {
        state.error = "reg add 起不来：" + outcome.spawnError;
        return state;
    }
    if (outcome.exitCode !== 0) {
        state.error =
            "reg add 退出码 " +
                String(outcome.exitCode) +
                "：" +
                (lastLine(outcome.stderr) || lastLine(outcome.stdout));
        return state;
    }
    state.done = true;
    state.changed = true;
    return state;
}
/**
 * 静默解压。
 *
 * 为什么不直接 -o<targetParent>：官方 sfx 里带一个顶层 msys64 目录，只有目标目录名恰好叫
 * msys64 时"解压到父目录"才成立。先解到同级暂存目录再 rename，任何 targetDir 都成立；
 * 而且暂存目录建在 targetDir 的父目录下，rename 是同盘操作，不会真拷几百 MB。
 */
async function extractInstaller(subprocess, sfxPath, targetDir, request, timeoutMs) {
    const parent = toPosix(dirname(targetDir));
    const staging = parent + "/.dsh-msys2-staging";
    // 只清自己建的暂存目录（固定名字）：上次崩在中途，残渣也不会被当成成功。
    removeDirQuietly(staging);
    try {
        mkdirSync(staging, { recursive: true });
    }
    catch (error) {
        return {
            ok: false,
            detail: "建不了暂存目录 " + staging + "：" + describeError(error),
            staging: "",
        };
    }
    // 两种写法都试：7z SFX 认 -o<dir>，带引号的写法在含空格的路径上更稳。
    const variants = [
        ["-y", "-o" + staging],
        ["-y", '-o"' + staging + '"'],
    ];
    let lastError = "";
    let extractedRoot = "";
    for (const args of variants) {
        const outcome = await runCapture(subprocess, {
            argv: [sfxPath, ...args],
            cwd: staging,
            timeoutMs,
            maxBytes: 64 * 1024,
            awaitQuiescence: true,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        if (outcome.spawnError !== null) {
            lastError = "安装包起不来：" + outcome.spawnError;
            continue;
        }
        if (outcome.timedOut) {
            lastError = "解压超时（" + String(Math.round(timeoutMs / 1000)) + " s）";
            continue;
        }
        if (outcome.exitCode !== 0) {
            lastError =
                "退出码 " +
                    String(outcome.exitCode) +
                    "：" +
                    (lastLine(outcome.stderr) || lastLine(outcome.stdout) || "（无输出）");
            continue;
        }
        const found = [staging + "/msys64", staging].find((dir) => isMsys2Root(dir));
        if (found === undefined) {
            lastError =
                "解压完没找到 usr/bin/bash.exe；暂存目录内容：" + safeList(staging).slice(0, 8).join("、");
            continue;
        }
        extractedRoot = found;
        break;
    }
    if (extractedRoot === "") {
        removeDirQuietly(staging);
        return { ok: false, detail: lastError === "" ? "解压失败（没有更多信息）" : lastError, staging: "" };
    }
    try {
        if (existsSync(targetDir)) {
            if (safeList(targetDir).length > 0) {
                return {
                    ok: false,
                    detail: "解压好了，但目标目录在解压期间变成非空：" +
                        targetDir +
                        "（没有覆盖它）；解压结果留在 " +
                        extractedRoot,
                    staging,
                };
            }
            // 只删空目录（rmdir 不会带走任何文件）。
            rmdirSync(targetDir);
        }
        renameSync(extractedRoot, targetDir);
    }
    catch (error) {
        return {
            ok: false,
            detail: "移动解压结果失败：" + describeError(error) + "；解压结果留在 " + extractedRoot,
            staging,
        };
    }
    removeDirQuietly(staging);
    return { ok: true, detail: targetDir, staging: "" };
}
/* ---------------------------- pacman 补包 ---------------------------- */
function pacmanCommand(packages) {
    return "pacman -Sy --noconfirm && pacman -S --noconfirm --needed " + packages.join(" ");
}
/** 只用现有数据库补包：已有 MSYS2 上不先 -Sy，免得"局部升级"把依赖解析搞崩。 */
function pacmanInstallCommand(packages) {
    return "pacman -S --noconfirm --needed " + packages.join(" ");
}
/** `pacman -Q <包名…>` 的输出 → { 包名 → 已装版本 }；找不到的包只会出现在 stderr，这里天然收不到。 */
export function parsePacmanQuery(output) {
    const found = new Map();
    for (const raw of output.split(/\r?\n/u)) {
        const line = raw.trim();
        if (line === "")
            continue;
        const match = /^(\S+)\s+(\S+)$/u.exec(line);
        if (match === null || match[1] === undefined || match[2] === undefined)
            continue;
        found.set(match[1], match[2]);
    }
    return found;
}
function bashLine(msys64, command) {
    return (msys64 === "" ? "<msys64>" : msys64) + "/usr/bin/bash.exe -lc \"" + command + "\"";
}
/** keyring 没初始化时 pacman 会报这两类话：要先 pacman-key --init / --populate 再重试。 */
function needsKeyringInit(outcome) {
    const text = (outcome.stdout + "\n" + outcome.stderr).toLowerCase();
    return text.includes("keyring") || text.includes("invalid or corrupted package");
}
/* --------------------------- 步骤簿记 --------------------------- */
function makeSteps() {
    return STEP_DEFS.map((def) => ({ id: def.id, label: def.label, status: "pending", detail: "" }));
}
function stepOf(steps, id) {
    for (const step of steps) {
        if (step.id === id)
            return step;
    }
    const created = { id, label: id, status: "pending", detail: "" };
    steps.push(created);
    return created;
}
function setStep(step, status, detail) {
    step.status = status;
    step.detail = detail;
}
function beginStep(steps, step, onProgress) {
    step.status = "running";
    if (onProgress !== undefined) {
        onProgress("[" + String(steps.indexOf(step) + 1) + "/" + String(steps.length) + "] " + step.label + "…");
    }
}
/** 关键步骤失败后把后面还 pending 的标成 skipped，避免卡片上出现"一半 pending"的歧义。 */
function skipAfter(steps, id, detail) {
    let seen = false;
    for (const step of steps) {
        if (seen && step.status === "pending")
            setStep(step, "skipped", detail);
        if (step.id === id)
            seen = true;
    }
}
/** 计划模式下每步写清"将要做什么"：不下载也要让用户看得懂会动哪里。 */
function fillPlanDetails(steps, context) {
    const rootLabel = context.msys64 === "" ? "（装哪还没定）" : context.msys64;
    setStep(stepOf(steps, "prepare"), "pending", context.msys64 === ""
        ? "目标目录待定；定了之后先确保它的父目录存在"
        : "确保父目录存在：" +
            (context.parent === "" ? context.msys64 : context.parent) +
            "（已存在的完整 MSYS2 直接复用）");
    setStep(stepOf(steps, "download"), "pending", "curl.exe -L --fail --retry 3 -o " +
        context.cachePath +
        " " +
        context.cacheUrl +
        "（约 " +
        formatBytes(MSYS2_INSTALLER_BYTES) +
        "；缓存已有且是有效 exe 就直接复用）");
    setStep(stepOf(steps, "extract"), "pending", context.msys64 === ""
        ? "把安装包静默解压到同级暂存目录，再把解压出的 msys64 移到目标目录（不覆盖已有目录）"
        : context.cachePath +
            " -y -o" +
            context.parent +
            " → 再把解压出的 msys64 移到 " +
            context.msys64);
    setStep(stepOf(steps, "pacman"), "pending", bashLine(context.msys64, "pacman -Q " + context.packages.join(" ")) +
        "：先问一遍装没装，已装的直接跳过（不重复安装、也不升级，要升级自己跑 pacman -Syu）；只对缺的包跑 pacman -S --noconfirm --needed <缺的包>；整机一件都没有时才先 pacman -Sy 同步一次。");
    setStep(stepOf(steps, "path"), "pending", context.writePath
        ? context.binDir === ""
            ? "把 <msys64>/ucrt64/bin 追加到用户级 PATH"
            : "把 " +
                toWindowsDir(context.binDir) +
                " 追加到用户级 PATH（HKCU\\Environment，REG_EXPAND_SZ；旧值先备份，已在其中就不重复写）"
        : "writePath=false：不动 PATH（失败也不致命，插件按配置里的绝对路径找工具）");
    setStep(stepOf(steps, "verify"), "pending", context.binDir === ""
        ? "用装好的 bin 目录跑 gcc / cmake / ninja / openocd / gdb 的版本命令"
        : "用 " + context.binDir + " 跑 gcc / cmake / ninja / openocd / gdb 的版本命令");
    setStep(stepOf(steps, "config"), "pending", "写 " +
        context.configPath +
        "：msys64=" +
        rootLabel +
        "、binDirs、packages（与已有 packages 合并去重，不动 cubeMxRoot）");
}
/* ------------------------------ 文案 ------------------------------ */
function planMessage(msys64, via, packages, download) {
    return ("计划（还没动手）：把 MSYS2 装到 " +
        msys64 +
        "（来源：" +
        viaLabel(via) +
        "），再补 " +
        String(packages.length) +
        " 个组件；安装包 " +
        formatBytes(download.bytes) +
        (download.cached ? "（本机已有缓存，不会再下载）" : "（需要下载）") +
        "。确认后才真装——现在没有下载、没有建目录、没有写注册表、没有改配置。");
}
function decisionMessage(suggested, packages, download) {
    return ("需要你先决定装哪：这台机器上没有可用的 MSYS2（配置里没有、自动扫描也没找到 usr/bin/bash.exe），" +
        "我不猜路径。建议装到 " +
        suggested +
        "（安装包 " +
        formatBytes(download.bytes) +
        " + 分包约 " +
        formatBytes(msys2PackagesTotal(packages)) +
        " 估算）。给我 targetDir、或回一句「装到 " +
        suggested +
        "」，我再出计划；现在什么都没装。");
}
function verifySummary(verify) {
    const found = verify.tools.filter((tool) => tool.found);
    const missing = verify.tools.filter((tool) => !tool.found);
    if (missing.length === 0) {
        if (found.length === 0)
            return "自检没有可跑的组件";
        const versions = found
            .map((tool) => tool.id + (tool.version === "" ? "" : " " + tool.version))
            .join("、");
        return "5 个组件都能跑（" + versions + "）";
    }
    return "缺 " + missing.map((tool) => tool.label).join("、");
}
function toVerifyState(results) {
    return {
        ok: results.length > 0 && results.every((result) => result.found),
        tools: results.map((result) => ({
            id: result.id,
            label: result.label,
            found: result.found,
            version: result.version,
        })),
    };
}
/* ---------------------------- 主入口 ---------------------------- */
export async function planOrInstallMsys2(subprocess, request, env = process.env) {
    const started = Date.now();
    const configRead = readToolchainConfig(env);
    const target = resolveTargetDir(request.targetDir, configRead.config, env);
    const suggested = target.msys64 === "" ? suggestMsys64Root(env) : "";
    const packages = dedupeStrings(request.packages !== undefined && request.packages.length > 0
        ? request.packages
        : [...DEFAULT_MSYS2_PACKAGES]);
    const installer = resolveInstallerUrl(env);
    const cachePath = cacheFilePath(env);
    const cachedBytes = fileSize(cachePath);
    const cachedOk = cachedBytes > 0 && looksLikeExecutable(cachePath);
    const msys64 = target.msys64;
    const binDir = msys64 === "" ? "" : msys64 + "/ucrt64/bin";
    const parent = msys64 === "" ? "" : toPosix(dirname(msys64));
    let download = {
        url: installer.url,
        bytes: cachedOk ? cachedBytes : MSYS2_INSTALLER_BYTES,
        cached: cachedOk,
    };
    const steps = makeSteps();
    const userPath = await readUserPath(subprocess, request.signal);
    let pathState = planPathState(userPath, binDir, request.writePath);
    const notes = [];
    if (target.warning !== "")
        notes.push("⚠ " + target.warning);
    const warningPrefix = target.warning === "" ? "" : "⚠ " + target.warning + "；";
    notes.push("用量估算：安装包 " +
        formatBytes(download.bytes) +
        (download.cached ? "（已缓存）" : "") +
        " + pacman 分包下载约 " +
        formatBytes(msys2PackagesTotal(packages)) +
        "；装完磁盘占用约 " +
        formatBytes((MSYS2_INSTALLER_BYTES + msys2PackagesTotal(packages)) * 3) +
        "（估算，含解压后的文件）。");
    notes.push("装完后插件按配置里的绝对路径找工具" +
        (binDir === "" ? "" : "（" + binDir + "）") +
        "，本进程不需要重读环境变量，也不要求重开 DSH。");
    notes.push("刻意没做卸载：要删就删安装目录" +
        (msys64 === "" ? "" : " " + msys64) +
        " 并去掉配置里的 msys64 / binDirs 两项，PATH 里那条也手动删掉。");
    if (installer.note !== "")
        notes.push(installer.note);
    // -- 计划模式：零副作用 ------------------------------------------------
    if (request.mode !== "install") {
        fillPlanDetails(steps, {
            msys64,
            parent,
            binDir,
            packages,
            cachePath,
            cacheUrl: installer.url,
            configPath: configRead.path,
            writePath: request.writePath,
        });
        notes.push("这只是计划：没有下载、没有建目录、没有写注册表、没有改配置。");
        const decided = msys64 !== "";
        return {
            ok: decided,
            mode: "plan",
            needsDecision: decided ? "" : "msys64Dir",
            msys64,
            resolvedVia: target.via,
            binDirs: binDir === "" ? [] : [binDir],
            packages,
            steps,
            download,
            path: pathState,
            config: { path: configRead.path, written: false, error: "" },
            verify: { ok: false, tools: [] },
            message: warningPrefix +
                (decided ? planMessage(msys64, target.via, packages, download) : decisionMessage(suggested, packages, download)),
            nextStep: decided
                ? "确认无误就带 confirm:true、dryRun:false 再调一次（会真下载并安装）；只想装指定包就传 packages。"
                : "定下安装位置（targetDir，或回一句「装到 " + suggested + "」），我再出一份计划。",
            notes,
            durationMs: Date.now() - started,
        };
    }
    // -- 真装：不知道装哪就一步都不做 ------------------------------------
    if (msys64 === "") {
        fillPlanDetails(steps, {
            msys64,
            parent,
            binDir,
            packages,
            cachePath,
            cacheUrl: installer.url,
            configPath: configRead.path,
            writePath: request.writePath,
        });
        return {
            ok: false,
            mode: "install",
            needsDecision: "msys64Dir",
            msys64: "",
            resolvedVia: "",
            binDirs: [],
            packages,
            steps,
            download,
            path: pathState,
            config: { path: configRead.path, written: false, error: "" },
            verify: { ok: false, tools: [] },
            message: warningPrefix + decisionMessage(suggested, packages, download),
            nextStep: "带上 targetDir 再调一次（例如 targetDir=\"" + suggested + "\"）。",
            notes,
            durationMs: Date.now() - started,
        };
    }
    const timeoutMs = request.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const alreadyInstalled = isMsys2Root(msys64);
    let verifyState = { ok: false, tools: [] };
    let configState = { path: configRead.path, written: false, error: "" };
    const finish = (ok, message, nextStep) => ({
        ok,
        mode: "install",
        needsDecision: "",
        msys64,
        resolvedVia: target.via,
        binDirs: [binDir],
        packages,
        steps,
        download,
        path: pathState,
        config: configState,
        verify: verifyState,
        message,
        nextStep,
        notes,
        durationMs: Date.now() - started,
    });
    const prepareStep = stepOf(steps, "prepare");
    const downloadStep = stepOf(steps, "download");
    const extractStep = stepOf(steps, "extract");
    const pacmanStep = stepOf(steps, "pacman");
    const pathStep = stepOf(steps, "path");
    const verifyStep = stepOf(steps, "verify");
    const configStep = stepOf(steps, "config");
    const abortRest = (step) => {
        setStep(step, "failed", "已取消");
        skipAfter(steps, step.id, "上一步被取消，未执行");
        return finish(false, "已取消：已经做过的步骤都留着了（不删任何东西）。", "需要时再调一次；已完成的步骤会自动跳过，不会重复下载、不会重复写 PATH。");
    };
    // a) 准备目录
    beginStep(steps, prepareStep, request.onProgress);
    if (isAborted(request.signal))
        return abortRest(prepareStep);
    if (alreadyInstalled) {
        setStep(prepareStep, "done", msys64 + " 里已经有一份能用的 MSYS2（有 usr/bin/bash.exe），跳过下载与解压");
    }
    else {
        try {
            mkdirSync(parent, { recursive: true });
            if (existsSync(msys64)) {
                const entries = safeList(msys64);
                if (entries.length > 0) {
                    setStep(prepareStep, "failed", "目标目录已存在且非空（" +
                        String(entries.length) +
                        " 项），但不是完整 MSYS2（缺 usr/bin/bash.exe）");
                    skipAfter(steps, "prepare", "目标目录不可用，未执行");
                    return finish(false, "没有开始：目标目录 " + msys64 + " 已存在且不是一份完整 MSYS2，我不覆盖也不删除它。", "换一个空目录（例如 " +
                        (msys64 === MSYS2_SUGGESTED_ROOT ? "D:/msys64" : MSYS2_SUGGESTED_ROOT) +
                        "）再装，或先确认那个目录里放的是什么。");
                }
            }
            setStep(prepareStep, "done", "父目录就绪：" + parent);
        }
        catch (error) {
            const reason = describeError(error);
            setStep(prepareStep, "failed", reason);
            skipAfter(steps, "prepare", "父目录建不了，未执行");
            return finish(false, "没能准备安装目录：" + reason, "检查路径是否合法、有没有写权限，或换一个 targetDir。");
        }
    }
    // b) 下载安装包
    beginStep(steps, downloadStep, request.onProgress);
    if (isAborted(request.signal))
        return abortRest(downloadStep);
    if (alreadyInstalled) {
        setStep(downloadStep, "skipped", "目标里已有 MSYS2，不需要安装包");
    }
    else if (cachedOk) {
        download = { url: installer.url, bytes: cachedBytes, cached: true };
        setStep(downloadStep, "done", "复用缓存：" + cachePath + "（" + formatBytes(cachedBytes) + "）");
    }
    else {
        const cacheDir = toPosix(dirname(cachePath));
        // 先下到 .part 再改名：半截文件绝不能被下一次当成"有效缓存"。
        const partPath = cachePath + ".part";
        try {
            mkdirSync(cacheDir, { recursive: true });
        }
        catch (error) {
            const reason = describeError(error);
            setStep(downloadStep, "failed", "建不了缓存目录 " + cacheDir + "：" + reason);
            skipAfter(steps, "download", "缓存目录不可用，未执行");
            return finish(false, "没能下载安装包：" + reason, "换一个可写目录后重试。");
        }
        request.onProgress?.("下载 " + formatBytes(MSYS2_INSTALLER_BYTES) + "：" + installer.url);
        const outcome = await runCapture(subprocess, {
            argv: [
                WINDOWS ? "curl.exe" : "curl",
                "-L",
                "--fail",
                "--retry",
                "3",
                "-o",
                partPath,
                installer.url,
            ],
            cwd: cacheDir,
            timeoutMs,
            maxBytes: 64 * 1024,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        const downloadedBytes = fileSize(partPath);
        if (outcome.spawnError !== null ||
            outcome.timedOut ||
            outcome.exitCode !== 0 ||
            downloadedBytes === 0) {
            removeFileQuietly(partPath);
            const reason = outcome.spawnError !== null
                ? "curl 起不来：" + outcome.spawnError
                : outcome.timedOut
                    ? "下载超时（" + String(Math.round(timeoutMs / 1000)) + " s）"
                    : outcome.exitCode !== 0
                        ? "curl 退出码 " + String(outcome.exitCode) + "：" + (lastLine(outcome.stderr) || "（无输出）")
                        : "下载回来是空文件";
            setStep(downloadStep, "failed", reason);
            skipAfter(steps, "download", "安装包没下来，未执行");
            return finish(false, "下载安装包失败：" + reason, "先确认这台机器能不能访问 " +
                installer.url +
                "（内网/代理可用 MSYS2_MIRROR）；也可以自己下载到 " +
                cachePath +
                " 再重试，已存在的有效缓存会直接复用。");
        }
        try {
            renameSync(partPath, cachePath);
        }
        catch (error) {
            removeFileQuietly(partPath);
            const reason = describeError(error);
            setStep(downloadStep, "failed", "下载完成但改名失败：" + reason);
            skipAfter(steps, "download", "安装包落位失败，未执行");
            return finish(false, "安装包下载完成但没法落位：" + reason, "检查缓存目录权限后重试。");
        }
        download = { url: installer.url, bytes: fileSize(cachePath), cached: false };
        setStep(downloadStep, "done", "已下载：" + cachePath + "（" + formatBytes(download.bytes) + "）");
    }
    // c) 静默解压
    beginStep(steps, extractStep, request.onProgress);
    if (isAborted(request.signal))
        return abortRest(extractStep);
    if (alreadyInstalled) {
        setStep(extractStep, "skipped", "目标里已有 MSYS2，跳过解压");
    }
    else {
        const extracted = await extractInstaller(subprocess, cachePath, msys64, request, timeoutMs);
        if (!extracted.ok) {
            setStep(extractStep, "failed", extracted.detail);
            skipAfter(steps, "extract", "解压没成功，未执行");
            return finish(false, "解压失败：" + extracted.detail, "安装包已缓存在 " + cachePath + "，修好问题后重试不会重新下载；也可以手动把它解压到 " + msys64 + "。");
        }
        setStep(extractStep, "done", "已解压到 " + msys64);
    }
    // d) pacman 补包
    beginStep(steps, pacmanStep, request.onProgress);
    if (isAborted(request.signal))
        return abortRest(pacmanStep);
    const bashPath = msys64 + "/usr/bin/bash.exe";
    if (!existsSync(bashPath)) {
        setStep(pacmanStep, "failed", "找不到 " + bashPath + "，这份 MSYS2 不完整，没法补包");
        skipAfter(steps, "pacman", "MSYS2 不完整，未执行");
        return finish(false, "MSYS2 本体不完整（缺 usr/bin/bash.exe）：" + msys64, "删掉这个目录后重装（安装包已在缓存里，重装不用重新下载），或换一个 targetDir。");
    }
    const runPacman = (line) => runCapture(subprocess, {
        argv: [bashPath, "-lc", line],
        cwd: msys64,
        timeoutMs,
        maxBytes: 512 * 1024,
        awaitQuiescence: true,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    // 先问一句"哪些已经装了"。pacman -S 对已装的包不是"跳过"而是"顺手升级"，
    // 在第 4 步把用户整套 mingw 工具链升一个大版本不是本工具的活（那是 pacman -Syu 的事）。
    const query = await runPacman("pacman -Q " + packages.join(" "));
    const installed = parsePacmanQuery(query.stdout);
    const missing = packages.filter((name) => !installed.has(name));
    if (missing.length === 0) {
        setStep(pacmanStep, "skipped", packages.map((name) => name.replace("mingw-w64-ucrt-x86_64-", "") + " " + (installed.get(name) ?? "")).join("、") +
            " 都已经装了，没有重复安装，也没有升级（要升级自己跑 pacman -Syu）。");
    }
    else {
        // 全新解压的 MSYS2 里一个包都没有 → 必须先 -Sy 拉数据库；已有 MSYS2 只补缺的那几个，直接用现有数据库。
        const needsSync = installed.size === 0;
        const command = needsSync ? pacmanCommand(missing) : pacmanInstallCommand(missing);
        let pacman = await runPacman(command);
        if (needsKeyringInit(pacman)) {
            request.onProgress?.("pacman 的 keyring 没初始化：先 pacman-key --init / --populate msys2，再重试一次");
            const init = await runPacman("pacman-key --init && pacman-key --populate msys2");
            if (init.exitCode === 0) {
                pacman = await runPacman(command);
            }
            else {
                setStep(pacmanStep, "failed", "pacman-key 初始化失败（退出码 " +
                    String(init.exitCode) +
                    "）：" +
                    (lastLine(init.stderr) || lastLine(init.stdout) || "（无输出）") +
                    "\n手动：" +
                    bashLine(msys64, "pacman-key --init && pacman-key --populate msys2"));
                skipAfter(steps, "pacman", "补包失败，未执行");
                return finish(false, "pacman 的 keyring 初始化失败，包没装上。", "在 " +
                    msys64 +
                    " 里手动跑一遍 " +
                    bashLine(msys64, "pacman-key --init && pacman-key --populate msys2") +
                    " 后重试。");
            }
        }
        // 已有 MSYS2 上先用现有数据库补；万一数据库太旧、库里根本没有这个包，同步一次再试。
        if (!needsSync && pacman.spawnError === null && !pacman.timedOut && pacman.exitCode !== 0) {
            request.onProgress?.("补包失败，同步一次软件库（pacman -Sy）再试一遍");
            pacman = await runPacman(pacmanCommand(missing));
        }
        if (pacman.spawnError !== null || pacman.timedOut || pacman.exitCode !== 0) {
            const reason = pacman.spawnError !== null
                ? "bash 起不来：" + pacman.spawnError
                : pacman.timedOut
                    ? "pacman 超时（" + String(Math.round(timeoutMs / 1000)) + " s）"
                    : "退出码 " +
                        String(pacman.exitCode) +
                        "：" +
                        (lastLine(pacman.stderr) || lastLine(pacman.stdout) || "（无输出）");
            // 不当场放弃：MSYS2 本体在，PATH / 配置照写，报告里把失败点写清楚。
            setStep(pacmanStep, "failed", reason +
                "\n手动：" +
                bashLine(msys64, command) +
                (reason.includes("无法满足依赖关系")
                    ? "\n这条一般是 MSYS2 太久没整体升级（局部升级解不开依赖）：先在 " +
                        msys64 +
                        " 里跑 pacman -Syu，再重调本工具。"
                    : ""));
        }
        else {
            setStep(pacmanStep, "done", "pacman 退出码 0；补装的包：" + missing.join("、"));
        }
    }
    // e) 用户级 PATH
    beginStep(steps, pathStep, request.onProgress);
    if (isAborted(request.signal))
        return abortRest(pathStep);
    if (!request.writePath) {
        setStep(pathStep, "skipped", "writePath=false：没动 PATH；要给命令行用就自己把 " + toWindowsDir(binDir) + " 加进 PATH");
    }
    else {
        pathState = await applyUserPath(subprocess, env, binDir, request);
        if (pathState.done && !pathState.changed) {
            setStep(pathStep, "done", "用户 PATH 里已经有 " + toWindowsDir(binDir) + "，没有重复写");
        }
        else if (pathState.done) {
            setStep(pathStep, "done", "已把 " +
                toWindowsDir(binDir) +
                " 追加到用户级 PATH（REG_EXPAND_SZ）；旧值备份在 " +
                pathState.backup);
        }
        else {
            // 失败不致命：插件按配置里的绝对路径找工具，PATH 只是给命令行/其他工具用的。
            setStep(pathStep, "failed", pathState.error +
                "\n手动：把 " +
                toWindowsDir(binDir) +
                " 追加到「环境变量 → 用户变量 → Path」（不要用 setx，它会在 1024 字符处截断 PATH）");
        }
    }
    // f) 自检
    beginStep(steps, verifyStep, request.onProgress);
    if (isAborted(request.signal))
        return abortRest(verifyStep);
    const probeConfig = { binDirs: [binDir], cubeMxRoots: [] };
    const targets = buildTargets(probeConfig).filter((item) => VERIFY_IDS.includes(item.id));
    const probed = await probeAll(subprocess, targets, probeConfig, {
        timeoutMs: PROBE_TIMEOUT_MS,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    verifyState = toVerifyState(probed);
    setStep(verifyStep, verifyState.ok ? "done" : "failed", verifyState.ok
        ? verifySummary(verifyState)
        : "缺 " +
            verifyState.tools
                .filter((tool) => !tool.found)
                .map((tool) => tool.label)
                .join("、"));
    // g) 写配置（与已有 packages 合并去重，别的字段原样保留）
    beginStep(steps, configStep, request.onProgress);
    const beforeConfig = readToolchainConfig(env);
    const merged = dedupeStrings([...(beforeConfig.config?.packages ?? []), ...packages]);
    const written = updateToolchainConfig({ msys64, binDirs: [binDir], packages: merged }, env);
    configState = { path: written.path, written: written.ok, error: written.error };
    setStep(configStep, written.ok ? "done" : "failed", written.ok
        ? "已写入 " + written.path + "（msys64 / binDirs / packages " + String(merged.length) + " 个）"
        : written.error);
    // 只有 PATH 允许失败不致命：其余任何一步失败都算没装成。
    // 一个例外：pacman 补装失败，但 5 个组件自检全都跑得起来 —— 工具本来就在（可能来自 PATH 上另一份），
    // 那不是"没装成"，如实记一行、继续当成功。
    if (verifyState.ok && stepOf(steps, "pacman").status === "failed") {
        const compensated = stepOf(steps, "pacman");
        compensated.status = "done";
        compensated.detail =
            compensated.detail +
                "\n但自检显示 5 个组件都能跑，按「已装」处理（插件不替你升级，要升级自己跑 pacman -Syu）。";
    }
    const fatal = steps.find((step) => step.status === "failed" && step.id !== "path");
    const ok = fatal === undefined;
    const pathFailed = pathStep.status === "failed";
    const message = ok
        ? "MSYS2 装到 " +
            msys64 +
            " 了，" +
            verifySummary(verifyState) +
            "；现在可以编译 / 烧录 / 调试。" +
            (pathFailed ? "（用户 PATH 没写成功，不影响插件按绝对路径找工具）" : "")
        : "安装没全部成功：" +
            steps
                .filter((step) => step.status === "failed")
                .map((step) => step.label)
                .join("、") +
            "（每一步的原因都在 steps 里）。";
    return finish(ok, message, ok
        ? "直接重跑你刚才的工具（stm32_build / stm32_flash / stm32_debug_run）；也可以用 stm32_env_probe 复看一遍。"
        : "看 steps 里失败那一步的 detail；修好后重调本工具，已完成的步骤会自动跳过（不会重复下载、不会重复写 PATH）。");
}
