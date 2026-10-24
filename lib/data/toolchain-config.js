/**
 * 用户级工具链配置：插件自己记住"这台机器把工具装在哪"。
 *
 * 为什么要有它：以前只认三个写死的候选目录 + 两个环境变量，用户把 MSYS2 装在
 * E:/msys64 时，每次都得自己去设 STM32_BIN_DIRS，还得重开 DSH 才生效。这里把
 * 路径落到一个纯文本 JSON 里，插件每次自己读——装完立刻能用，与进程环境变量无关。
 *
 * 位置：%USERPROFILE%/.dsh-stm32/config.json；DSH_STM32_CONFIG 可整体改指到别处
 * （单测与多工程隔离用）。DSH_STM32_NO_CONFIG=1 让所有读配置的地方当它不存在。
 *
 * 文件是可选增强，不是前提：读不到、写坏了都只是"没配置"，不抛异常给调用方。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute } from "node:path";
export const TOOLCHAIN_CONFIG_VERSION = 1;
let cache = null;
function envValue(env, key) {
    const value = env[key];
    return value === undefined ? "" : value.trim();
}
/** 用户主目录：Windows 上 USERPROFILE 最准，其余退回 os.homedir()。 */
function homeDir(env) {
    const userProfile = envValue(env, "USERPROFILE");
    if (userProfile !== "")
        return userProfile;
    const home = envValue(env, "HOME");
    if (home !== "")
        return home;
    return homedir();
}
/** 配置文件路径。DSH_STM32_CONFIG 优先（相对路径按当前工作目录解析）。 */
export function toolchainConfigPath(env = process.env) {
    const override = envValue(env, "DSH_STM32_CONFIG");
    if (override !== "")
        return isAbsolute(override) ? override : homeDir(env) + "/" + override;
    return toPosix(homeDir(env)) + "/.dsh-stm32/config.json";
}
/** 关掉配置读取（单测 / 想完全走环境变量时用）。 */
export function configReadingDisabled(env = process.env) {
    const flag = envValue(env, "DSH_STM32_NO_CONFIG");
    return flag === "1" || flag === "true";
}
function toPosix(value) {
    return value.replace(/\\/gu, "/").replace(/\/+$/u, "");
}
function asString(value) {
    return typeof value === "string" ? value.trim() : "";
}
function asStringArray(value) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    for (const item of value) {
        if (typeof item !== "string")
            continue;
        const trimmed = item.trim();
        if (trimmed !== "")
            out.push(toPosix(trimmed));
    }
    return out;
}
function dedupe(values) {
    const seen = new Set();
    const out = [];
    for (const value of values) {
        const key = value.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(value);
    }
    return out;
}
export function defaultToolchainConfig() {
    return {
        version: TOOLCHAIN_CONFIG_VERSION,
        msys64: "",
        binDirs: [],
        packages: [],
        cubeMxRoot: "",
        updatedAt: "",
    };
}
/** 把任意 JSON 归一成合法配置：未知字段丢掉，类型不对的字段按空处理并记一条 errors。 */
export function normalizeToolchainConfig(raw, errors) {
    const base = defaultToolchainConfig();
    if (raw === null || typeof raw !== "object") {
        errors.push("配置内容不是对象，已按空配置处理");
        return base;
    }
    const record = raw;
    const version = typeof record["version"] === "number" ? record["version"] : TOOLCHAIN_CONFIG_VERSION;
    if (typeof record["version"] !== "number")
        errors.push("version 不是数字，按 " + String(TOOLCHAIN_CONFIG_VERSION));
    const msys64 = toPosix(asString(record["msys64"]));
    const binDirs = dedupe(asStringArray(record["binDirs"]));
    const packages = dedupe(asStringArray(record["packages"]));
    const cubeMxRoot = toPosix(asString(record["cubeMxRoot"]));
    return {
        version,
        msys64,
        binDirs,
        packages,
        cubeMxRoot,
        updatedAt: asString(record["updatedAt"]),
    };
}
/** 读配置；坏文件不抛异常，返回 config=null + errors，并把原文错误写进 errors。 */
export function readToolchainConfig(env = process.env) {
    const path = toolchainConfigPath(env);
    if (configReadingDisabled(env)) {
        return { path, exists: false, config: null, errors: [] };
    }
    let mtimeMs = 0;
    let size = -1;
    try {
        const stat = statSync(path);
        mtimeMs = stat.mtimeMs;
        size = stat.size;
    }
    catch {
        cache = null;
        return { path, exists: false, config: null, errors: [] };
    }
    if (cache !== null && cache.path === path && cache.mtimeMs === mtimeMs && cache.size === size) {
        return cache.read;
    }
    let text = "";
    try {
        text = readFileSync(path, "utf8");
    }
    catch (error) {
        const read = {
            path,
            exists: true,
            config: null,
            errors: ["配置文件读不了：" + describeError(error)],
        };
        cache = { path, mtimeMs, size, read };
        return read;
    }
    const errors = [];
    let parsed = null;
    try {
        parsed = text.trim() === "" ? null : JSON.parse(text);
    }
    catch (error) {
        const read = {
            path,
            exists: true,
            config: null,
            errors: ["配置文件不是合法 JSON：" + describeError(error) + "；已按未配置处理（重新写入会覆盖它）"],
        };
        cache = { path, mtimeMs, size, read };
        return read;
    }
    const config = parsed === null ? defaultToolchainConfig() : normalizeToolchainConfig(parsed, errors);
    const read = { path, exists: true, config, errors };
    cache = { path, mtimeMs, size, read };
    return read;
}
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * 原子写入：先写同目录 tmp 再 rename。
 * 半截写入比没有配置更糟（下次启动直接坏 JSON），所以不做原地覆盖。
 */
export function writeToolchainConfig(config, env = process.env) {
    const path = toolchainConfigPath(env);
    const normalized = {
        version: TOOLCHAIN_CONFIG_VERSION,
        msys64: toPosix(config.msys64),
        binDirs: dedupe(config.binDirs.map(toPosix)),
        packages: dedupe(config.packages.map((name) => name.trim()).filter((name) => name !== "")),
        cubeMxRoot: toPosix(config.cubeMxRoot),
        updatedAt: new Date().toISOString(),
    };
    const body = JSON.stringify(normalized, null, 2) + "\n";
    const tmpPath = path + ".tmp-" + String(process.pid);
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(tmpPath, body, "utf8");
        renameSync(tmpPath, path);
    }
    catch (error) {
        try {
            if (existsSync(tmpPath))
                unlinkSync(tmpPath);
        }
        catch {
            // 清理失败不影响主错误
        }
        cache = null;
        return { ok: false, path, error: "写配置失败：" + describeError(error) };
    }
    cache = null;
    return { ok: true, path, error: "" };
}
/** 只改一部分字段（其余保持原样）。读不到原配置时按默认值起步。 */
export function updateToolchainConfig(patch, env = process.env) {
    const read = readToolchainConfig(env);
    const base = read.config ?? defaultToolchainConfig();
    const next = {
        version: TOOLCHAIN_CONFIG_VERSION,
        msys64: patch.msys64 ?? base.msys64,
        binDirs: patch.binDirs ?? base.binDirs,
        packages: patch.packages ?? base.packages,
        cubeMxRoot: patch.cubeMxRoot ?? base.cubeMxRoot,
        updatedAt: base.updatedAt,
    };
    const written = writeToolchainConfig(next, env);
    return { ...written, config: next };
}
/**
 * 配置里认的工具链 bin 目录。
 * binDirs 为空但有 msys64 时按 MSYS2 的 UCRT64 布局推导——这是安装器写配置的唯一形状。
 */
export function binDirsFromConfig(config) {
    if (config === null)
        return [];
    if (config.binDirs.length > 0)
        return [...config.binDirs];
    if (config.msys64 !== "")
        return [config.msys64 + "/ucrt64/bin"];
    return [];
}
/** 配置里认的 CubeMX 安装根。 */
export function cubeMxRootsFromConfig(config) {
    if (config === null || config.cubeMxRoot === "")
        return [];
    return [config.cubeMxRoot];
}
/** 单测用：清掉 mtime 缓存。 */
export function resetToolchainConfigCache() {
    cache = null;
}
/** 给报告 / 命令卡片用的一句话描述。 */
export function describeToolchainConfig(read) {
    if (!read.exists)
        return "还没有配置（没有 " + read.path + "）";
    if (read.config === null)
        return "配置读不了：" + (read.errors[0] ?? "未知原因");
    const parts = [];
    parts.push(read.config.msys64 === "" ? "MSYS2 未配置" : "MSYS2 " + read.config.msys64);
    if (read.config.packages.length > 0)
        parts.push("包 " + String(read.config.packages.length) + " 个");
    if (read.config.cubeMxRoot !== "")
        parts.push("CubeMX " + read.config.cubeMxRoot);
    return parts.join("；") + "（" + read.path + "）";
}
