/**
 * L0：文件系统与 Windows 长路径（> 260 字符）的适配。
 *
 * 为什么单独一个模块：建工程要做的两件事全踩在这条线上 ——
 *   ① 从固件包原样拷 Drivers/**（层级深：Drivers/CMSIS/Device/ST/STM32F1xx/Source/Templates/gcc/…）；
 *   ② 目标工程常在长路径下（C:\Users\<长用户名>\OneDrive\…\工程）。
 * 两条路径一拼就可能超过 Windows 的 MAX_PATH，表现是 fs 抛 ENAMETOOLONG / ENOENT，
 * 而报告里只说"写盘失败"，看不出是路径长度问题（审计 B17）。
 *
 * 做法：Windows 上把**绝对**路径规范成 \\?\ 扩展长度形式再交给 fs（相对路径不碰：
 * 加了前缀反而会指到别的根）。POSIX 原样返回 —— 那边没有 260 字符上限，加前缀只会让路径不存在。
 *
 * 目录追踪（mkdirTrackedLong）也放这里，而不是留在 scaffold：写完要能"精确清掉本次新建的目录"，
 * 两个实现各写一份迟早会对不上（清理漏一个 = 留下半成品目录）。
 */
import fs from "node:fs";
import path from "node:path";
/** Windows 的扩展长度前缀。 */
const LONG_PREFIX = "\\\\?\\";
/** UNC 路径（\\server\share）要用 \\?\UNC\ 而不是 \\?\ 直接拼。 */
const UNC_PREFIX = "\\\\?\\UNC\\";
/**
 * 把路径规范成 Windows 扩展长度形式（只在需要时加前缀）。
 * 已经是 \\?\ 开头的原样返回；相对路径也原样返回（前缀化会让它指到错误的根）。
 */
export function toLongPath(p) {
    if (process.platform !== "win32")
        return p;
    if (p === "" || p.startsWith(LONG_PREFIX))
        return p;
    if (!path.isAbsolute(p))
        return p;
    // \\?\ 之后 Windows 不再做任何规范化：正斜杠、"."、".." 都会被当字面量，
    // 所以这里只把分隔符统一成反斜杠，其余原样交给调用方（scaffold 传进来的都是 path.join 的结果）。
    const normalized = p.replace(/\//gu, "\\");
    if (normalized.startsWith("\\\\"))
        return UNC_PREFIX + normalized.slice(2);
    return LONG_PREFIX + normalized;
}
/** 存在性检查（长路径安全）。 */
export function existsLong(p) {
    return fs.existsSync(toLongPath(p));
}
/**
 * mkdir -p，同时记下**这次真正新建**的目录。
 * 为什么要记：写盘中途失败时要清掉半成品目录，而"清"必须精确到本次新建的，
 * 用户原有的目录一个都不能动（递归删用户目录 = 把审计里的丢数据问题换个地方重演）。
 */
export function mkdirTrackedLong(dir, created) {
    const missing = [];
    let cursor = path.resolve(dir);
    while (!existsLong(cursor)) {
        missing.push(cursor);
        const parent = path.dirname(cursor);
        if (parent === cursor)
            break;
        cursor = parent;
    }
    fs.mkdirSync(toLongPath(dir), { recursive: true });
    created.push(...missing);
}
/** 复制失败时的中文说明：把"路径太长"这个最容易被误判成权限/杀软的原因写清楚。 */
export function describeCopyFailure(from, to, error) {
    const code = error?.code ?? "";
    const detail = error instanceof Error ? error.message : String(error);
    const tooLong = code === "ENAMETOOLONG" || Math.max(from.length, to.length) > 240;
    const hint = tooLong
        ? "路径太长（Windows 默认上限 260 字符，已尝试 \\?\ 前缀）：把工程或固件包挪到更短的目录（例如 D:\\work\\blink）再试。"
        : "检查源文件是否存在、目标目录是否可写。";
    return "复制失败（" + (code === "" ? "未知错误" : code) + "）：" + from + " -> " + to + "。" + hint + " 原始错误：" + detail;
}
/** 单文件复制（长路径安全）。目标目录必须由调用方先建好（用 mkdirTrackedLong）。 */
export function copyFileLong(from, to) {
    try {
        fs.copyFileSync(toLongPath(from), toLongPath(to));
    }
    catch (error) {
        throw new Error(describeCopyFailure(from, to, error));
    }
}
/**
 * 整树复制（长路径安全），返回复制的文件数。
 * skipPrefixes 是相对源根、带结尾斜杠的前缀（"CMSIS/docs/"），命中就整棵跳过。
 * created 收集本次新建的目录，供写盘失败时精确清理。
 */
export function copyTreeLong(from, to, skipPrefixes = [], created = []) {
    let count = 0;
    const walk = (src, dest, relDir) => {
        mkdirTrackedLong(dest, created);
        for (const entry of fs.readdirSync(toLongPath(src), { withFileTypes: true })) {
            const rel = relDir === "" ? entry.name : relDir + "/" + entry.name;
            const source = path.join(src, entry.name);
            const target = path.join(dest, entry.name);
            if (entry.isDirectory()) {
                if (skipPrefixes.some((prefix) => (rel + "/").startsWith(prefix)))
                    continue;
                walk(source, target, rel);
            }
            else {
                copyFileLong(source, target);
                count += 1;
            }
        }
    };
    walk(from, to, "");
    return count;
}
