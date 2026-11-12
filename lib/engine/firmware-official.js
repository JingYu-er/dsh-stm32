/**
 * "官网直取"通道：从 ST 的固件仓库直接下载官方 zip，再交给 CubeMX 自己记账（swmgr install）。
 *
 * 为什么值得单独一条路（2026-11 实测）：
 *   · swmgr install <本地 zip> ask 是 CubeMX 包管理器自己用的那条命令；装完包落在
 *     <CubeMX>/Repository/<包名>，GUI 与 project generate 都认，不像 dsh-firmware 只能靠
 *     project setCustomFWPath 指过去（该路径在 WBA 上实测会使 project generate 阻塞 400 s）。
 *   · 官方 zip 自带完整 HAL + CMSIS + 示例，比插件从 GitHub 拼装的 HAL+CMSIS 更完整，也无需维护
 *     22 张 coreHeaders 表。
 *
 * 不能仅依赖该通道的原因（因此默认 auto 并保留回退）：
 *   · 新族/新版本第一次装会弹许可协议（swmgr ... ask），无头进程等不到人点同意就卡住；
 *     这是许可协议，插件不代点，只能超时、说明、回退。
 *   · 没有 CubeMX（或没有 JRE）、CubeMX GUI 正开着、公司网络挡住 sw-center，都走不通。
 *
 * URL 规律（匿名 GET 200，实测 F1/H5/WBA/WL3）：
 *   https://sw-center.st.com/packs/resource/firmware/stm32cube_fw_<库名后缀小写>_v<版本去点>.zip
 *   例：STM32Cube_FW_F1 + 1.8.7 → stm32cube_fw_f1_v187.zip（56,220,914 B）
 */
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { runStreaming } from "./subprocess-runner.js";
const DEFAULT_BASE = "https://sw-center.st.com/packs/resource/firmware/";
/** 官网固件仓库根（末尾带斜杠）。DSH_STM32_FIRMWARE_BASE 可指向镜像/本地假服务器（测试用）。 */
export function officialFirmwareBaseUrl(env = process.env) {
    const override = env["DSH_STM32_FIRMWARE_BASE"];
    if (override !== undefined && override.trim() !== "") {
        const trimmed = override.trim();
        return trimmed.endsWith("/") ? trimmed : trimmed + "/";
    }
    return DEFAULT_BASE;
}
/**
 * 包名 + 版本 → 官方 zip 的 URL。
 * fwLibrary 是 db 的 <Mcu FwLibrary="STM32Cube_FW_H7RS">（没有这个属性的族就用 packageBase）。
 */
export function officialFirmwareUrl(fwLibrary, version, env = process.env) {
    const lib = fwLibrary.trim();
    const slug = lib.replace(/^STM32Cube_FW_/iu, "").toLowerCase();
    const digits = version.trim().replace(/\./gu, "");
    return officialFirmwareBaseUrl(env) + "stm32cube_fw_" + slug + "_v" + digits + ".zip";
}
/* ------------------------- db 里的 FwLibrary ------------------------- */
/**
 * 把 db 的 RefName 变成能匹配 CPN 的正则：RefName 是"一簇型号"的写法。
 *   例：STM32F103C(8-B)Tx → ^STM32F103C[8B]T.$（CPN STM32F103C8T6 命中）
 *       STM32H7R3A8Ix    → ^STM32H7R3A8I.$
 * 括号里是容量/温度档的枚举（连字符分隔），x/X 是封装字母通配。
 */
export function refNamePattern(refName) {
    let source = "";
    for (let i = 0; i < refName.length; i += 1) {
        const ch = refName[i];
        if (ch === "(") {
            const close = refName.indexOf(")", i);
            const inner = close === -1 ? "" : refName.slice(i + 1, close);
            source += "[" + inner.split("-").join("").replace(/[\\\]]/gu, (m) => "\\" + m) + "]";
            i = close === -1 ? i : close;
            continue;
        }
        if (ch === "x" || ch === "X") {
            source += ".";
            continue;
        }
        source += ch.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    }
    return new RegExp("^" + source + "$", "u");
}
/** 读某个 MCU xml 的 <Mcu FwLibrary="…">；没有这个属性返回空串（绝大多数族都是空的）。 */
export function readMcuFwLibrary(file) {
    let text;
    try {
        // 只需要开头那段：<Mcu> 是文件第一个元素。
        const fd = openSync(file, "r");
        try {
            const buf = Buffer.alloc(8192);
            const read = readSync(fd, buf, 0, buf.length, 0);
            text = buf.subarray(0, read).toString("utf8");
        }
        finally {
            closeSync(fd);
        }
    }
    catch {
        return "";
    }
    const tag = /<Mcu\b([^>]*)>/u.exec(text);
    if (tag === null)
        return "";
    return /(?:^|\s)FwLibrary="([^"]+)"/u.exec(tag[1])?.[1] ?? "";
}
/**
 * 按型号在 db 里找 FwLibrary：只有少数子系列（H7RS / MP13 / WB0 / WL3）才有这个属性，
 * 其余族返回 fallback（= 插件的 packageBase，例如 STM32Cube_FW_F1）。
 *
 * 为什么按型号而不是按族：STM32H7 里 H743 用 STM32Cube_FW_H7、H7R3 用 STM32Cube_FW_H7RS，
 * 同一族两个包；仅按族取用会误将 H7RS 的包应用到 H743。
 */
export function resolveFwLibrary(dbRoot, partNumber, fallback) {
    const part = partNumber.trim().toUpperCase();
    if (dbRoot === "" || part === "")
        return fallback;
    const mcuDir = path.join(dbRoot, "mcu");
    let names;
    try {
        names = readdirSync(mcuDir).filter((name) => name.endsWith(".xml") && name !== "families.xml");
    }
    catch {
        return fallback;
    }
    for (const name of names) {
        const pattern = refNamePattern(name.slice(0, -4));
        if (!pattern.test(part))
            continue;
        const lib = readMcuFwLibrary(path.join(mcuDir, name));
        if (lib !== "")
            return lib;
    }
    return fallback;
}
/* ------------------------------ zip 校验 ------------------------------ */
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1)
            c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();
/** CRC-32（zip 用的那个多项式）；seed 传上一段的返回值即可接着算。 */
export function crc32Of(bytes, seed = 0) {
    let c = (~seed) >>> 0;
    for (let i = 0; i < bytes.length; i += 1) {
        c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (~c) >>> 0;
}
function hex32(value) {
    return "0x" + (value >>> 0).toString(16).padStart(8, "0");
}
/** zip 结构签名与单条解压上限。 */
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_LOCAL_SIG = 0x04034b50;
/** 单条目解压上限：官方包里最大的 C 源远小于此，超过只可能是坏 zip / 压缩炸弹。 */
const ZIP_MAX_ENTRY_BYTES = 256 * 1024 * 1024;
/** 从 fd 的指定位置读满 len 字节；短读返回实际读到的（调用方判错）。 */
function readAt(fd, position, len) {
    const out = Buffer.allocUnsafe(len);
    let done = 0;
    while (done < len) {
        const n = readSync(fd, out, done, len - done, position + done);
        if (n <= 0)
            break;
        done += n;
    }
    return done === len ? out : out.subarray(0, done);
}
/**
 * 校验 zip：读中央目录 → 逐条解压 → 比 CRC-32。
 *
 * 为什么要全量比一遍而不是"能解开就行"：ST 的 zip 有 300+ MB（WBA 388,603,994 B），
 * 代理/断流/磁盘满都能留一个"结构完好但内容缺一块"的文件，swmgr 解包时才炸，
 * 而那时用户已经等了几分钟、包目录还是半截。这里先自证一遍，坏在哪一条也说得清。
 *
 * 内存边界：只把中央目录（通常几百 KB）读进内存，压缩数据按条目一条条 readSync +
 * inflate；峰值≈最大单条，不再整包 388 MB 进 Buffer。
 */
export function verifyZipCrc(file, onProgress) {
    const base = { ok: false, entries: 0, checked: 0, mismatches: [], error: "" };
    let size;
    try {
        size = statSync(file).size;
    }
    catch (error) {
        return { ...base, error: "读不了 zip：" + (error instanceof Error ? error.message : String(error)) };
    }
    if (size < 22)
        return { ...base, error: "不是 zip：文件只有 " + String(size) + " B" };
    let fd;
    try {
        fd = openSync(file, "r");
    }
    catch (error) {
        return { ...base, error: "打不开 zip：" + (error instanceof Error ? error.message : String(error)) };
    }
    try {
        // EOCD 在文件尾部，后面最多跟 65535 字节注释。
        const tailStart = Math.max(0, size - 65558);
        const tail = readAt(fd, tailStart, size - tailStart);
        let eocd = -1;
        for (let i = tail.length - 22; i >= 0; i -= 1) {
            if (tail.readUInt32LE(i) === ZIP_EOCD_SIG) {
                const commentLen = tail.readUInt16LE(i + 20);
                if (tailStart + i + 22 + commentLen === size) {
                    eocd = i;
                    break;
                }
            }
        }
        if (eocd === -1)
            return { ...base, error: "不是 zip：找不到中央目录结尾（EOCD）" };
        const total = tail.readUInt16LE(eocd + 10);
        const cdSize = tail.readUInt32LE(eocd + 12);
        const cdOffset = tail.readUInt32LE(eocd + 16);
        if (cdOffset + cdSize > size)
            return { ...base, entries: total, error: "中央目录越界：offset " + String(cdOffset) + " + " + String(cdSize) + " > " + String(size) };
        const cd = readAt(fd, cdOffset, cdSize);
        if (cd.length !== cdSize)
            return { ...base, entries: total, error: "中央目录读不全：" + String(cd.length) + "/" + String(cdSize) + " B" };
        const mismatches = [];
        let offset = 0;
        let checked = 0;
        for (let index = 0; index < total; index += 1) {
            if (offset + 46 > cd.length)
                return { ...base, entries: total, checked, mismatches, error: "中央目录第 " + String(index + 1) + " 条越界" };
            if (cd.readUInt32LE(offset) !== ZIP_CENTRAL_SIG) {
                return { ...base, entries: total, checked, mismatches, error: "中央目录第 " + String(index + 1) + " 条签名不对" };
            }
            const method = cd.readUInt16LE(offset + 10);
            const expectedCrc = cd.readUInt32LE(offset + 16);
            const compressedSize = cd.readUInt32LE(offset + 20);
            const nameLen = cd.readUInt16LE(offset + 28);
            const extraLen = cd.readUInt16LE(offset + 30);
            const commentLen = cd.readUInt16LE(offset + 32);
            const localOffset = cd.readUInt32LE(offset + 42);
            const name = cd.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
            offset += 46 + nameLen + extraLen + commentLen;
            if (method !== 0 && method !== 8) {
                // 其它算法（bzip2/lzma）官方包不用；不认识的条目跳过而不是判坏。
                continue;
            }
            if (localOffset + 30 > size)
                return { ...base, entries: total, checked, mismatches, error: "条目 " + name + " 的本地头越界" };
            const localHeader = readAt(fd, localOffset, 30);
            if (localHeader.length !== 30 || localHeader.readUInt32LE(0) !== ZIP_LOCAL_SIG) {
                return { ...base, entries: total, checked, mismatches, error: "条目 " + name + " 的本地头签名不对" };
            }
            const localNameLen = localHeader.readUInt16LE(26);
            const localExtraLen = localHeader.readUInt16LE(28);
            const dataStart = localOffset + 30 + localNameLen + localExtraLen;
            if (dataStart + compressedSize > size) {
                return { ...base, entries: total, checked, mismatches, error: "条目 " + name + " 的数据越界：" + String(dataStart) + " + " + String(compressedSize) + " > " + String(size) };
            }
            // 先按 central 里的压缩长度读；解压上限再兜一层压缩炸弹。
            const raw = readAt(fd, dataStart, compressedSize);
            if (raw.length !== compressedSize) {
                return { ...base, entries: total, checked, mismatches, error: "条目 " + name + " 的数据读不全：" + String(raw.length) + "/" + String(compressedSize) + " B" };
            }
            let data;
            try {
                data = method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: ZIP_MAX_ENTRY_BYTES });
            }
            catch (error) {
                return {
                    ...base,
                    entries: total,
                    checked,
                    mismatches,
                    error: "条目 " + name + " 解压失败：" + (error instanceof Error ? error.message : String(error)),
                };
            }
            const actual = crc32Of(data);
            checked += 1;
            if (actual !== (expectedCrc >>> 0)) {
                mismatches.push({ name, expected: hex32(expectedCrc), actual: hex32(actual) });
                if (mismatches.length > 5)
                    mismatches.pop();
            }
            if (onProgress !== undefined && checked % 200 === 0)
                onProgress(checked, total);
        }
        return { ok: mismatches.length === 0, entries: total, checked, mismatches, error: "" };
    }
    finally {
        closeSync(fd);
    }
}
/**
 * 下载官方 zip。判据两条：HTTP 200 + 落盘字节数等于 Content-Length。
 * 半截文件当场删掉——留着只会让后面的 CRC 校验报一堆看不懂的错。
 */
export async function downloadOfficialZip(request) {
    const outcome = { ok: false, bytes: 0, contentLength: 0, status: 0, error: "" };
    const fetchImpl = request.fetchImpl ?? fetch;
    const timeoutMs = request.timeoutMs ?? 600_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const external = request.signal;
    const onAbort = () => controller.abort();
    if (external !== undefined) {
        if (external.aborted) {
            clearTimeout(timer);
            return { ...outcome, error: "已取消" };
        }
        external.addEventListener("abort", onAbort, { once: true });
    }
    const remove = () => {
        try {
            rmSync(request.destFile, { force: true });
        }
        catch {
            // 删不掉只是留个残渣，不改变结论。
        }
    };
    try {
        const response = await fetchImpl(request.url, { signal: controller.signal, redirect: "follow" });
        outcome.status = response.status;
        if (!response.ok || response.body === null) {
            remove();
            return { ...outcome, error: "HTTP " + String(response.status) + " " + response.statusText };
        }
        const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
        outcome.contentLength = Number.isFinite(declared) ? declared : 0;
        mkdirSync(path.dirname(request.destFile), { recursive: true });
        const file = createWriteStream(request.destFile);
        let bytes = 0;
        let lastTick = 0;
        try {
            const reader = response.body[Symbol.asyncIterator]();
            for (;;) {
                const step = await reader.next();
                if (step.done === true)
                    break;
                const chunk = Buffer.from(step.value);
                bytes += chunk.length;
                if (!file.write(chunk))
                    await new Promise((resolve) => file.once("drain", () => resolve()));
                const now = Date.now();
                if (request.onProgress !== undefined && now - lastTick >= 1000) {
                    lastTick = now;
                    request.onProgress(bytes, outcome.contentLength);
                }
            }
            await new Promise((resolve, reject) => file.end(() => resolve()).on("error", reject));
        }
        catch (error) {
            file.destroy();
            remove();
            throw error;
        }
        outcome.bytes = bytes;
        if (outcome.contentLength > 0 && bytes !== outcome.contentLength) {
            remove();
            return { ...outcome, ok: false, error: "下载不完整：Content-Length " + String(outcome.contentLength) + " B，实际 " + String(bytes) + " B" };
        }
        return { ...outcome, ok: true };
    }
    catch (error) {
        remove();
        const message = error instanceof Error ? error.message : String(error);
        return { ...outcome, error: controller.signal.aborted ? "超时/取消：" + message : message };
    }
    finally {
        clearTimeout(timer);
        if (external !== undefined)
            external.removeEventListener("abort", onAbort);
    }
}
/** swmgr 等 CubeMX 的上限：许可已接受时实测 150 MB 的 C0 包 unpack+记账约 90 s，5 分钟足够；
 *  许可没接受时再等也没用（无头模式根本不会把对话框给出来），靠下面的许可检测提前收尾。 */
export const SWMGR_TIME_LIMIT_MS = 300_000;
/**
 * 从 CubeMX 日志里读「已接受的固件许可」清单。
 *
 * CubeMX 每次启动都会打一行：
 *   [INFO] AnalyticsPlugin:257 - Accepted Firmware Licenses: FW.C0.1.3.0,FW.C0.1.4.0,FW.F4.1.28.0
 * 实测许可按「族 + 版本」记账：同一个族的另一个版本也要重新点一次同意（FW.C0.1.3.0 与 FW.C0.1.4.0 各一条）。
 * 没记过的族/版本，swmgr 会阻塞并等待 GUI 弹框；无头 -q 模式下该弹框不会出现。
 */
export function parseAcceptedFirmwareLicences(log) {
    const seen = [];
    for (const match of log.matchAll(/Accepted Firmware Licenses:\s*([^\r\n]*)/gu)) {
        for (const item of String(match[1] ?? "").split(",")) {
            const tag = item.trim();
            if (tag !== "" && !seen.includes(tag))
                seen.push(tag);
        }
    }
    return seen;
}
/** CubeMX 的固件许可标签：FW.<族>.<主>.<次>.<补丁>，例如 FW.C0.1.3.0、FW.F4.1.28.0。 */
export function firmwareLicenceTag(family, version) {
    const fam = family.trim().toUpperCase().replace(/^STM32/u, "");
    const ver = version.trim().replace(/^[Vv]/u, "");
    if (!/^[A-Z0-9+]+$/u.test(fam))
        return "";
    if (!/^\d+\.\d+\.\d+$/u.test(ver))
        return "";
    return "FW." + fam + "." + ver;
}
/**
 * 跑 swmgr install <本地 zip> ask，让 CubeMX 自己把包装进 Repository 并记账。
 *
 * 许可协议：ask 模式在首次装某族/某版本时会弹 GUI 对话框等人点同意 —— 那是许可协议，
 * 插件不代点（代点等于替用户签合同）。所以这里只等 timeoutMs，等不到就带着日志回退，
 * 由调用方告诉用户"去 CubeMX 里点一次同意"。
 */
export async function installViaSwmgr(request) {
    const dir = path.join(request.root, "Repository", request.dirName);
    const present = () => existsSync(path.join(dir, "package.xml")) ||
        existsSync(path.join(dir, "Drivers")) ||
        existsSync(path.join(dir, "Utilities", "pc_software"));
    // 必须在跑之前取：swmgr 装成功会把目录建出来，跑之后再取就分不清"本来就有"和"这次装上的"。
    const existedBefore = present();
    const slug = request.dirName.replace(/[^A-Za-z0-9_.-]/gu, "_");
    mkdirSync(request.workDir, { recursive: true });
    const scriptPath = path.join(request.workDir, "swmgr-" + slug + ".txt");
    const zipForScript = request.zipFile.split("\\").join("/");
    writeFileSync(scriptPath, ["swmgr install \"" + zipForScript + "\" ask", "exit", ""].join("\n"), "utf8");
    const licenceTag = request.family === undefined || request.version === undefined
        ? ""
        : firmwareLicenceTag(request.family, request.version);
    const limitMs = request.timeoutMs ?? SWMGR_TIME_LIMIT_MS;
    // 自己拿一个 controller：许可没记录时提前结束等待，不必熬到超时。
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    if (request.signal !== undefined) {
        if (request.signal.aborted)
            controller.abort();
        else
            request.signal.addEventListener("abort", relayAbort, { once: true });
    }
    let seen = "";
    let acceptedLicences = [];
    let missingLicence = "";
    let outcome;
    try {
        outcome = await runStreaming(request.subprocess, {
            argv: [request.java, "-Dfile.encoding=UTF-8", "-jar", request.jar, "-q", scriptPath],
            cwd: request.workDir,
            timeoutMs: limitMs,
            maxBytes: 2 * 1024 * 1024,
            signal: controller.signal,
            onOutput: (_stream, text) => {
                if (missingLicence !== "")
                    return;
                seen = (seen + text).slice(-200_000);
                const list = parseAcceptedFirmwareLicences(seen);
                if (list.length === 0)
                    return;
                acceptedLicences = list;
                if (licenceTag !== "" && !list.includes(licenceTag)) {
                    missingLicence = licenceTag;
                    if (request.onProgress !== undefined) {
                        request.onProgress("CubeMX 还没接受 " + licenceTag + " 的许可协议（已接受：" + list.join("、") + "），不再等待。");
                    }
                    controller.abort();
                }
            },
        });
    }
    finally {
        if (request.signal !== undefined)
            request.signal.removeEventListener("abort", relayAbort);
    }
    const log = outcome.stdout + "\n" + outcome.stderr;
    // 回退：进程输出可能在 drain 之前就结束（或未走到 onOutput），结束后再从整段日志中读取一次许可清单。
    if (acceptedLicences.length === 0)
        acceptedLicences = parseAcceptedFirmwareLicences(log);
    if (missingLicence === "" && licenceTag !== "" && acceptedLicences.length > 0 && !acceptedLicences.includes(licenceTag)) {
        missingLicence = licenceTag;
    }
    const logTail = log.trim().split(/\r?\n/u).slice(-4).join(" | ");
    if (request.onProgress !== undefined)
        request.onProgress("CubeMX 安装日志末尾：" + logTail);
    if (present())
        return { ok: true, dir, logTail, error: "", reused: existedBefore, acceptedLicences, missingLicence: "" };
    if (missingLicence !== "") {
        const accepted = acceptedLicences.length === 0 ? "CubeMX 还没记录任何已接受的固件许可" : acceptedLicences.join("、");
        return {
            ok: false,
            dir,
            logTail,
            error: "CubeMX 还没接受 " + missingLicence + " 的许可协议，这一族/版本的首装要先点一次同意（已接受的许可：" + accepted +
                "）。在 CubeMX 里 Help → Manage embedded software packages 展开对应的 STM32Cube MCU Package、选这个版本 Install、" +
                "许可协议点 I Agree，之后这条通道就能自己装。",
            reused: false,
            acceptedLicences,
            missingLicence,
        };
    }
    const how = outcome.timedOut
        ? "超时 " + String(limitMs) + " ms（多半是在等许可协议对话框）"
        : "退出码 " + (outcome.exitCode === null ? "（没有）" : String(outcome.exitCode));
    return {
        ok: false,
        dir,
        logTail,
        error: "CubeMX 没把包装进 Repository（" + how + "）；日志末尾：" + logTail,
        reused: false,
        acceptedLicences,
        missingLicence: "",
    };
}
