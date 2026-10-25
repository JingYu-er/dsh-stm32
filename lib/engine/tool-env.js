/**
 * L2：给子进程准备环境变量（主要是 PATH）。
 *
 * 为什么单独有它：binDirs（配置 / msys64 推导出来的工具目录）以前只用来**找可执行文件**，
 * 找到之后 spawn 的还是宿主进程的 env。于是出现这种情况——用户刚用安装器把工具装好、
 * PATH 也写进了 HKCU，但 DSH 宿主进程还没重启（进程 env 还是旧的）：
 * 门禁按目录找到了 gcc，cmake 却在内部调 `arm-none-eabi-gcc` 时 not found。
 * 所以凡是"跑起来之后还要再调别的工具"的子进程（cmake → gcc/ninja/objcopy），都要带上这份 PATH。
 */
import path from "node:path";
function dedupe(entries) {
    return [...new Set(entries.map((entry) => entry.trim()).filter((entry) => entry !== ""))];
}
/** 找出 env 里 PATH 的实际键名（Windows 上常见是 `Path`，大小写不固定）。 */
function pathKey(env) {
    for (const key of Object.keys(env)) {
        if (key.toLowerCase() === "path")
            return key;
    }
    return "PATH";
}
/**
 * 复制一份 env，并把 binDirs 放到 PATH 最前面（其余原样保留）。
 *
 * - 不改调用方的 env 对象；
 * - binDirs 为空时原样返回副本（不凭空造 PATH）；
 * - Windows 大小写不敏感：只留一个 PATH 键，避免同时出现 PATH 与 Path 导致子进程看不到工具。
 */
export function envWithBinDirs(binDirs, base = process.env) {
    const env = { ...base };
    const clean = dedupe(binDirs);
    if (clean.length === 0)
        return env;
    const key = pathKey(base);
    for (const existing of Object.keys(env)) {
        if (existing !== key && existing.toLowerCase() === "path")
            delete env[existing];
    }
    const current = base[key] ?? "";
    env[key] = clean.join(path.delimiter) + (current === "" ? "" : path.delimiter + current);
    return env;
}
/**
 * 找可执行文件时该看哪些目录：显式给的 binDirs 在前，PATH 里的目录在后（去重、去空）。
 *
 * 与门禁的顺序一致——配置里点名的目录优先，PATH 兜底；不忽略 PATH（用户机器上工具常常就在 PATH 里）。
 */
export function toolSearchDirs(binDirs, base = process.env) {
    const fromPath = (base[pathKey(base)] ?? "").split(path.delimiter);
    return dedupe([...binDirs.filter((dir) => dir.trim() !== ""), ...fromPath]);
}
