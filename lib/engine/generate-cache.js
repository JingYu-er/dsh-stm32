/**
 * L2：generate 的复用缓存 —— 让「.ioc 没变」的再次生成零成本。
 *
 * 实测依据（docs/development-notes.md 的「generate 为什么慢」一节）：
 * 同一个 .ioc、同一个 CubeMX 版本、同一种布局，两次生成的 6 个文件字节完全一致
 * （整树 sha256 = a78a451d…b8f5d99）；把 thirdparties/pdsc 停放掉再生成，产物依然
 * 一模一样。所以产物可以按「.ioc 内容 + CubeMX 二进制指纹 + 布局」缓存：
 * 命中且工程里每个目标文件的 hash 都对得上时，直接跳过 CubeMX（3–4 分钟 → 毫秒）。
 *
 * 这里只做确定性计算与读写，不启动进程、不碰工程源码，便于单测。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
/** 缓存文件名（放在工程的 .dsh-stm32/ 下，跟着工程走）。 */
export const CACHE_FILE = "generate-cache.json";
/** 缓存格式版本：结构变了就 +1，旧缓存自动失效。 */
export const CACHE_VERSION = 1;
/** 文本/内容的 sha256（hex）。 */
export function sha256Text(text) {
    return createHash("sha256").update(text, "utf8").digest("hex");
}
/** 文件内容的 sha256；文件不存在或读不到时返回 null。 */
export function sha256File(absPath) {
    try {
        if (!existsSync(absPath))
            return null;
        return createHash("sha256").update(readFileSync(absPath)).digest("hex");
    }
    catch {
        return null;
    }
}
/**
 * CubeMX 二进制指纹：java + jar 的大小与 mtime。
 *
 * 不用版本号字符串：CubeMX 的 jar 里没有稳定可解析的版本入口，而大小+mtime
 * 在「升级/重装 CubeMX」时一定会变，这正是缓存该失效的时刻。
 */
export function cubeMxStamp(javaPath, jarPath) {
    const part = (p) => {
        try {
            const st = statSync(p);
            return String(st.size) + ":" + String(Math.round(st.mtimeMs));
        }
        catch {
            return "missing";
        }
    };
    return part(javaPath) + "|" + part(jarPath);
}
export function computeCacheKey(iocSha256, cubeMxStampValue, layout) {
    return sha256Text("v" + String(CACHE_VERSION) + "\n" + iocSha256 + "\n" + cubeMxStampValue + "\n" + layout);
}
/** 一次算齐键的三部分（ioc 内容、CubeMX 指纹、布局）。 */
export function cacheKeyFor(iocText, javaPath, jarPath, layout) {
    const iocSha256 = sha256Text(iocText);
    const stamp = cubeMxStamp(javaPath, jarPath);
    return { key: computeCacheKey(iocSha256, stamp, layout), iocSha256, cubeMxStamp: stamp };
}
/** 读缓存；文件缺失/损坏/版本不符都返回 null（当作没有缓存）。 */
export function readCache(stateDir) {
    const path = join(stateDir, CACHE_FILE);
    if (!existsSync(path))
        return null;
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (parsed === null || typeof parsed !== "object")
            return null;
        if (parsed.version !== CACHE_VERSION)
            return null;
        if (typeof parsed.key !== "string" || !Array.isArray(parsed.files))
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
export function writeCache(stateDir, entry) {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, CACHE_FILE), JSON.stringify(entry, null, 1) + "\n", "utf8");
}
/** 按本次真正落位的文件算一条缓存记录；任何一个文件 hash 取不到就返回 null（不缓存）。 */
export function entryFromFiles(key, iocSha256, cubeMxStampValue, layout, projectDir, targets, now = Date.now()) {
    const files = [];
    for (const target of targets) {
        const hash = sha256File(join(projectDir, target));
        if (hash === null)
            return null;
        files.push({ target, sha256: hash });
    }
    return { version: CACHE_VERSION, key, iocSha256, cubeMxStamp: cubeMxStampValue, layout, createdAt: now, files };
}
/**
 * 判断缓存能否直接复用。
 *
 * 三重校验：键一致（.ioc + CubeMX 指纹 + 布局）、文件都在、每个文件内容 hash 对得上。
 * 只要有一个文件被手改/删掉，就不算命中——宁可重跑 CubeMX，也不把过期产物当好结果。
 */
export function cacheHit(entry, key, projectDir) {
    if (entry === null)
        return { hit: false, reason: "没有可用缓存（本工程还没成功生成过）", entry: null, fileCount: 0 };
    if (entry.key !== key) {
        return { hit: false, reason: ".ioc 内容、CubeMX 版本或布局变过（缓存键不一致）", entry: null, fileCount: 0 };
    }
    if (entry.files.length === 0)
        return { hit: false, reason: "缓存里没有文件清单", entry: null, fileCount: 0 };
    for (const file of entry.files) {
        const actual = sha256File(join(projectDir, file.target));
        if (actual === null)
            return { hit: false, reason: "缓存里的产物不见了：" + file.target, entry: null, fileCount: 0 };
        if (actual !== file.sha256) {
            return { hit: false, reason: "产物与缓存不一致（被改过）：" + file.target, entry: null, fileCount: 0 };
        }
    }
    return { hit: true, reason: "", entry, fileCount: entry.files.length };
}
