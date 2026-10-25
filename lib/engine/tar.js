/**
 * 最小的 tar.gz 解包器（只用 node:zlib，不依赖系统 tar.exe）。
 *
 * 为什么自己解：固件包要从 GitHub 拉两个子模块仓库的 tar.gz，机器上不保证有 tar
 * （Windows 10 1803 之前没有，busybox 环境也没有）。node:zlib 一定有，且解包过程
 * 可以在单测里用内存里造的 tar.gz 完整验证 —— 调外部命令就做不到这一点。
 *
 * 只支持 GitHub codeload 真正会发出的那几种条目：常规文件、目录（ustar 前缀）、
 * pax 扩展头（x/g）与 GNU 长名（L/K）。符号链接、硬链接、设备、FIFO 一律不落盘，
 * 只记进 skipped / skippedPaths —— 它们本来没有数据，写成 0 字节文件会被当成解包成功。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
const BLOCK = 512;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
function readString(buffer, offset, length) {
    const slice = buffer.subarray(offset, offset + length);
    const end = slice.indexOf(0);
    return (end === -1 ? slice : slice.subarray(0, end)).toString("utf8");
}
function readOctal(buffer, offset, length) {
    const text = readString(buffer, offset, length).trim();
    if (text === "")
        return 0;
    const value = Number.parseInt(text, 8);
    return Number.isFinite(value) ? value : 0;
}
function isZeroBlock(block) {
    for (let index = 0; index < block.length; index += 1) {
        if (block[index] !== 0)
            return false;
    }
    return true;
}
/** pax 扩展头：一串 长度 键=值 换行 记录。 */
function parsePax(data) {
    const fields = new Map();
    let offset = 0;
    while (offset < data.length) {
        const space = data.indexOf(0x20, offset);
        if (space === -1)
            break;
        const length = Number.parseInt(data.subarray(offset, space).toString("utf8"), 10);
        if (!Number.isFinite(length) || length <= 0)
            break;
        const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
        const equals = record.indexOf("=");
        if (equals > 0)
            fields.set(record.slice(0, equals), record.slice(equals + 1));
        offset += length;
    }
    return fields;
}
/**
 * 条目类型白名单：只有常规文件（0 / NUL / 空）与目录（5）会落盘，
 * 其余（1 硬链接、2 符号链接、3/4 设备、6 FIFO、7 连续文件及其他未知类型）一律跳过。
 */
function entryKind(typeflag, fullName) {
    if (typeflag === "5")
        return "dir";
    if (typeflag === "0" || typeflag === "\u0000" || typeflag === "") {
        return fullName.endsWith("/") ? "dir" : "file";
    }
    return "other";
}
/**
 * 相对路径安全检查：绝对路径、盘符、反斜杠、冒号、以及任何 . / .. 分段一律拒绝。
 *
 * 反斜杠必须单独挡：Windows 上 path.join 把 "\\" 当分隔符，条目名 "a\\..\\..\\x"
 * 按 "/" 切分只是一段、不满足「分段等于 ..」的旧判定，规范化之后却能跳出目标目录。
 */
function isSafeRelative(rel) {
    if (rel === "")
        return false;
    if (rel.includes("\\"))
        return false;
    if (rel.includes(":"))
        return false;
    if (rel.startsWith("/"))
        return false;
    const parts = rel.split("/");
    return parts.every((part) => part !== "" && part !== "." && part !== "..");
}
function joinSafe(destRoot, rel) {
    return path.join(destRoot, ...rel.split("/"));
}
/**
 * 解包 tar.gz 到 destRoot。
 *
 * 只写 destRoot 内部：任何带上跳、绝对路径或反斜杠的条目都算坏包，整次失败（不部分成功），
 * 这样调用方不会留下一个看起来解完了的半成品目录。
 */
export function extractTarGz(archive, destRoot, options = {}) {
    const strip = Math.max(0, options.stripComponents ?? 0);
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const mapPath = options.mapPath ?? ((rel) => rel);
    const files = [];
    const skippedPaths = [];
    let skipped = 0;
    let totalBytes = 0;
    let pendingPath = "";
    let pendingSize = 0;
    // gzip 魔数先做显式检查（A32）：代理/门户返回的 HTML 也能让 gunzip 抛错，
    // 但直接拿魔数说"这不是 tar.gz"比把 zlib 的报错原文抛给用户更清楚，也挡住"空文件当成功"。
    if (archive.length < 2 || archive[0] !== 0x1f || archive[1] !== 0x8b) {
        return {
            ok: false,
            files,
            totalBytes: 0,
            skipped: 0,
            skippedPaths: [],
            error: "这不是合法的 tar.gz（前两个字节不是 gzip 魔数 1f 8b，多半是下载到了网页或错误页）",
        };
    }
    let raw;
    try {
        raw = gunzipSync(archive);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, files, totalBytes: 0, skipped: 0, skippedPaths: [], error: "这不是合法的 tar.gz（" + message + "）" };
    }
    if (raw.length === 0) {
        return { ok: false, files, totalBytes: 0, skipped: 0, skippedPaths: [], error: "解包结果是空归档（0 字节），不当作成功" };
    }
    // 两遍：先把所有条目校验完（路径安全 + 总量上限），全部通过才落盘。
    // 否则踩到坏条目时前面已经写了一堆文件，调用方会留下一个看起来解完了的半成品目录。
    const planned = [];
    let offset = 0;
    while (offset + BLOCK <= raw.length) {
        const header = raw.subarray(offset, offset + BLOCK);
        if (isZeroBlock(header))
            break;
        const name = readString(header, 0, 100);
        const sizeField = readOctal(header, 124, 12);
        const typeflag = String.fromCharCode(header[156] ?? 48);
        const prefix = readString(header, 345, 155);
        const dataStart = offset + BLOCK;
        const dataEnd = dataStart + sizeField;
        const data = raw.subarray(dataStart, Math.min(dataEnd, raw.length));
        const padded = dataStart + Math.ceil(sizeField / BLOCK) * BLOCK;
        if (typeflag === "x") {
            const fields = parsePax(data);
            pendingPath = fields.get("path") ?? "";
            pendingSize = Number.parseInt(fields.get("size") ?? "0", 10);
            offset = padded;
            continue;
        }
        if (typeflag === "g") {
            offset = padded;
            continue;
        }
        if (typeflag === "L") {
            // GNU 长文件名：数据就是下一个条目的完整名字。
            pendingPath = data.toString("utf8").replace(/\u0000+$/u, "");
            offset = padded;
            continue;
        }
        if (typeflag === "K") {
            // GNU 长链接名：数据是下一个条目的 linkname，条目本身不是普通文件，会在下面被跳过。
            offset = padded;
            continue;
        }
        let fullName = prefix === "" ? name : prefix + "/" + name;
        let size = sizeField;
        if (pendingPath !== "") {
            fullName = pendingPath;
            if (pendingSize > 0)
                size = pendingSize;
            pendingPath = "";
            pendingSize = 0;
        }
        offset = padded;
        // 声明的大小超出实际数据 = 包被截断；宁可整次失败，也不要写出半截文件当成功。
        if (dataStart + size > raw.length) {
            return {
                ok: false,
                files,
                totalBytes,
                skipped,
                skippedPaths,
                error: "压缩包在「" + fullName + "」处被截断（声明 " + String(size) + " 字节），已中止解包",
            };
        }
        const parts = fullName.split("/").filter((part) => part !== "" && part !== ".");
        const rel = parts.slice(Math.min(strip, parts.length)).join("/");
        const kind = entryKind(typeflag, fullName);
        if (kind === "other") {
            skipped += 1;
            skippedPaths.push(rel === "" ? fullName : rel);
            continue;
        }
        if (rel === "") {
            skipped += 1;
            continue;
        }
        const mapped = mapPath(rel);
        if (mapped === null) {
            skipped += 1;
            skippedPaths.push(rel);
            continue;
        }
        // 目录条目本身不落盘（有文件落进来时 mkdir 会自己建）。
        if (kind === "dir")
            continue;
        if (!isSafeRelative(mapped)) {
            return {
                ok: false,
                files,
                totalBytes,
                skipped,
                skippedPaths,
                error: "压缩包里有可疑路径（" + mapped + "），已中止解包",
            };
        }
        totalBytes += data.length;
        if (totalBytes > maxBytes) {
            return {
                ok: false,
                files,
                totalBytes,
                skipped,
                skippedPaths,
                error: "解包后超过 " + String(Math.round(maxBytes / 1024 / 1024)) + " MiB，已中止（防止压缩炸弹）",
            };
        }
        planned.push({ mapped, data });
    }
    // 0 个可落盘条目也不是成功：上游仓改布局、proxy 页面骗过魔数、mapPath 把条目全过滤掉，
    // 都会走到这里。返回 ok:true 会让上层把空目录当"装好了"。
    if (planned.length === 0) {
        return {
            ok: false,
            files,
            totalBytes,
            skipped,
            skippedPaths,
            error: "压缩包里没有可落盘的文件（" + String(skipped) + " 个条目被跳过），不当作成功",
        };
    }
    mkdirSync(destRoot, { recursive: true });
    for (const item of planned) {
        const dest = joinSafe(destRoot, item.mapped);
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, item.data);
        files.push({ path: item.mapped, bytes: item.data.length });
    }
    return { ok: true, files, totalBytes, skipped, skippedPaths, error: "" };
}
