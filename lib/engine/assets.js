/**
 * 资源包（dsh-stm32-assets）下载器：manifest → 逐文件 sha256 → 本地缓存。
 *
 * 为什么要有这一层：插件自带的 chip-table.json / stm32f1.ts / templates 只覆盖"能离线就离线"的
 * 那一部分；device 事实层（chips.json / memory.json / svd-f1.json）、ioc 模板、链接脚本属于
 * "会随上游长大"的资源，塞进 npm 包会让包体无限膨胀（用户 2026-10-24 的决定）。做法是把它们
 * 放进独立仓库 dsh-stm32-assets，按 profile 按需下载到 <home>/.dsh-stm32/assets/<version>/，
 * 之后复用；每个文件都带 sha256，装坏/装半截宁可整次拒绝，也不给上层一份"看起来装好了"的目录。
 *
 * 关键约定：
 *   · 多源：GitHub raw → jsDelivr → GitCode，manifest 与文件各自逐源回退（写死一个源就是押注线路）；
 *   · 失败不抛：下载/校验失败都变成 ok:false + 人话原因，工具卡片照常渲染；
 *   · 离线兜底：refresh 失败时上层仍能用内置表（chip-table.json + stm32f1.ts）建工程，
 *     所以这里的报错必须说清"缺的是什么、还能做什么"；
 *   · 半成品必须删干净：先下到 <version>.tmp-<pid>-<seq>/，全部哈希通过才搬进 <version>/，
 *     中途失败只删临时目录，旧版本一个字节都不动。
 *
 * 零运行时依赖：只用 node:fs / node:path / node:crypto / node:os 与全局 fetch（Node 18+），
 * 测试通过 fetchImpl 注入假 fetch，一次网络都不发。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export const ASSETS_MANIFEST_FILE = "manifest.json";
export const ASSETS_INSTALL_FILE = "install.json";
/**
 * 候选源与顺序。顺序不是随便排的：GitHub raw 是上游真身（版本与 README 一致），
 * jsDelivr 在部分网络里更快、且能吃缓存，GitCode 是最后一条独立线路（前两个同源）。
 */
export const ASSETS_SOURCES = [
    {
        id: "github",
        label: "GitHub raw（主源）",
        baseUrl: "https://raw.githubusercontent.com/JingYu-er/dsh-stm32-assets/main/",
    },
    {
        id: "jsdelivr",
        label: "jsDelivr CDN（备用）",
        baseUrl: "https://cdn.jsdelivr.net/gh/JingYu-er/dsh-stm32-assets@main/",
    },
    {
        id: "gitcode",
        label: "GitCode 镜像（再备用）",
        baseUrl: "https://raw.gitcode.com/qq_66375182/dsh-stm32-assets/raw/main/",
    },
];
/** 只给 core / full；空串按 core 处理，别的值返回 null（由调用方给可读报错，不瞎猜）。 */
export function normalizeProfile(value) {
    const text = (value ?? "core").trim().toLowerCase();
    if (text === "")
        return "core";
    if (text === "core" || text === "full")
        return text;
    return null;
}
/**
 * 解析调用方指定的源：认 github / jsdelivr / gitcode，或者一个完整的 base URL。
 * 显式指定 = 只走它（用户说"我只想从 GitHub 下"时不该偷偷换源）；
 * 不指定 = 按 ASSETS_SOURCES 顺序回退。
 */
export function resolveSources(override) {
    const text = (override ?? "").trim();
    if (text === "")
        return [...ASSETS_SOURCES];
    const match = ASSETS_SOURCES.find((source) => source.id === text.toLowerCase());
    if (match !== undefined)
        return [match];
    const baseUrl = text.endsWith("/") ? text : text + "/";
    return [{ id: "custom", label: "调用方指定的源", baseUrl }];
}
function expandHome(value, env) {
    if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
        const home = (env.USERPROFILE ?? env.HOME ?? "").trim();
        if (home !== "")
            return path.join(home, value.slice(1));
    }
    return value;
}
/** 资源根目录：DSH_STM32_ASSETS 覆盖，默认 ~/.dsh-stm32/assets（每个版本一个子目录）。 */
export function assetsRootInfo(env = process.env) {
    const override = (env.DSH_STM32_ASSETS ?? "").trim();
    if (override !== "") {
        return { root: path.resolve(expandHome(override, env)), origin: "DSH_STM32_ASSETS" };
    }
    const userProfile = (env.USERPROFILE ?? "").trim();
    if (userProfile !== "") {
        return { root: path.join(userProfile, ".dsh-stm32", "assets"), origin: "USERPROFILE" };
    }
    const home = (env.HOME ?? "").trim();
    if (home !== "")
        return { root: path.join(home, ".dsh-stm32", "assets"), origin: "HOME" };
    return { root: path.join(os.homedir(), ".dsh-stm32", "assets"), origin: "用户主目录" };
}
/** 资源根（不含版本号）。测试里用 DSH_STM32_ASSETS 指到临时目录，绝不碰真实 home。 */
export function localAssetsRoot(env = process.env) {
    return assetsRootInfo(env).root;
}
/** 某个版本的安装目录：<root>/<version>/。 */
export function versionDir(version, env = process.env) {
    return path.join(localAssetsRoot(env), version);
}
const SHA256_RE = /^[0-9a-f]{64}$/u;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function sha256Hex(buffer) {
    return createHash("sha256").update(buffer).digest("hex");
}
export function errText(error) {
    if (error instanceof Error) {
        const cause = error.cause;
        if (cause !== undefined && cause !== null && cause !== "") {
            const causeText = cause instanceof Error ? cause.message : String(cause);
            return error.message + "（" + causeText + "）";
        }
        return error.message;
    }
    return String(error);
}
function shortHash(value) {
    return value.length > 16 ? value.slice(0, 16) + "…" : value;
}
/**
 * 解析并校验 manifest。校验不过返回 error（调用方换源），不抛异常。
 * 为什么严：manifest 是"装什么、装成后该是什么"的唯一事实来源，少一个 sha256 就等于放弃校验。
 */
export function parseManifest(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        return { manifest: null, error: "manifest.json 不是合法 JSON：" + errText(error) };
    }
    if (!isRecord(parsed))
        return { manifest: null, error: "manifest.json 顶层不是对象" };
    const version = parsed["version"];
    if (typeof version !== "string" || version.trim() === "") {
        return {
            manifest: null,
            error: "manifest.json 缺 version（没有版本号就不知道该往哪个目录装）。" +
                "如果资源仓库里还是老的 v1 manifest（只有 plugin/cubeMx 路径、没有 version/schema/profiles），" +
                "先把带 version 与 profiles 的 schema 2 manifest 推上去再刷新。",
        };
    }
    const rawFiles = parsed["files"];
    if (!Array.isArray(rawFiles))
        return { manifest: null, error: "manifest.json 缺 files 数组" };
    const files = [];
    const seen = new Set();
    for (let index = 0; index < rawFiles.length; index += 1) {
        const item = rawFiles[index];
        const where = "files[" + String(index) + "]";
        if (!isRecord(item))
            return { manifest: null, error: where + " 不是对象" };
        const relPath = item["path"];
        if (typeof relPath !== "string" || relPath.trim() === "") {
            return { manifest: null, error: where + " 缺 path" };
        }
        const normalized = normalizeAssetPath(relPath);
        if (normalized === null)
            return { manifest: null, error: where + " 的 path 不合法（必须是资源根内的相对路径）：" + relPath };
        if (seen.has(normalized))
            return { manifest: null, error: "manifest.json 里 path 重复：" + normalized };
        seen.add(normalized);
        const sha256 = item["sha256"];
        if (typeof sha256 !== "string" || !SHA256_RE.test(sha256.toLowerCase())) {
            return { manifest: null, error: where + "（" + normalized + "）缺 sha256 或不是 64 位十六进制；没有哈希就无法校验，拒绝安装" };
        }
        const bytes = item["bytes"];
        if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
            return { manifest: null, error: where + "（" + normalized + "）的 bytes 不是非负数" };
        }
        const profile = typeof item["profile"] === "string" && item["profile"] !== "" ? item["profile"] : "core";
        const source = typeof item["source"] === "string" ? item["source"] : "";
        files.push({ path: normalized, bytes, sha256: sha256.toLowerCase(), source, profile });
    }
    const profiles = {};
    const rawProfiles = parsed["profiles"];
    if (isRecord(rawProfiles)) {
        for (const [key, value] of Object.entries(rawProfiles)) {
            if (!Array.isArray(value))
                return { manifest: null, error: "manifest.json 的 profiles." + key + " 不是数组" };
            const globs = [];
            for (const glob of value) {
                if (typeof glob !== "string" || glob.trim() === "") {
                    return { manifest: null, error: "manifest.json 的 profiles." + key + " 里有非字符串 glob" };
                }
                globs.push(glob);
            }
            profiles[key] = globs;
        }
    }
    const skipped = Array.isArray(parsed["skipped"]) ? parsed["skipped"].filter((item) => typeof item === "string") : [];
    const name = typeof parsed["name"] === "string" ? parsed["name"] : "dsh-stm32-assets";
    const schema = typeof parsed["schema"] === "number" ? parsed["schema"] : 1;
    return { manifest: { ...parsed, name, version, schema, profiles, files, skipped }, error: "" };
}
/** 相对路径规整：反斜杠转正斜杠、拒绝绝对路径/盘符/.. —— 防止 manifest 把文件写到资源根以外。 */
export function normalizeAssetPath(raw) {
    const text = raw.split("\\").join("/").trim();
    if (text === "" || text.startsWith("/") || /^[A-Za-z]:/u.test(text))
        return null;
    const parts = text.split("/").filter((part) => part !== "" && part !== ".");
    if (parts.length === 0)
        return null;
    if (parts.some((part) => part === ".."))
        return null;
    return parts.join("/");
}
function urlPath(relPath) {
    return relPath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}
function joinUrl(baseUrl, relPath) {
    const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
    return base + urlPath(relPath);
}
/** glob → 正则：** 跨目录，* 不跨目录，? 单字符。manifest 的 profiles 就靠它筛文件。 */
function globToRegExp(pattern) {
    let out = "^";
    let index = 0;
    while (index < pattern.length) {
        const ch = pattern.charAt(index);
        if (ch === "*") {
            if (pattern.charAt(index + 1) === "*") {
                const followedBySlash = pattern.charAt(index + 2) === "/";
                out += followedBySlash ? "(?:[^/]+/)*" : ".*";
                index += followedBySlash ? 3 : 2;
                continue;
            }
            out += "[^/]*";
            index += 1;
            continue;
        }
        if (ch === "?") {
            out += "[^/]";
            index += 1;
            continue;
        }
        out += ch.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        index += 1;
    }
    return new RegExp(out + "$", "u");
}
/**
 * profile 里的文件。优先用 manifest.profiles 的 glob（v2 的标准做法）；
 * 老 manifest 没有 profiles 时退回每条的 profile 字段（full 包含 core）。
 */
export function profileFiles(manifest, profile) {
    const globs = manifest.profiles[profile];
    if (globs !== undefined) {
        const patterns = globs.map((glob) => globToRegExp(glob));
        return manifest.files.filter((file) => patterns.some((pattern) => pattern.test(file.path)));
    }
    return manifest.files.filter((file) => file.profile === profile || (profile === "full" && file.profile === "core"));
}
async function requestBuffer(url, fetchImpl, timeoutMs, signal) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    if (signal !== undefined) {
        if (signal.aborted)
            controller.abort();
        else
            signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
        const response = await fetchImpl(url, { signal: controller.signal, redirect: "follow" });
        if (!response.ok) {
            const hint = response.status === 404 ? "（源上没有这个文件）" : response.status === 403 ? "（被拒绝或限流）" : "";
            throw new Error("HTTP " + String(response.status) + hint);
        }
        return Buffer.from(await response.arrayBuffer());
    }
    catch (error) {
        if (timedOut)
            throw new Error("超时（" + String(timeoutMs) + " ms 没响应）");
        if (signal?.aborted === true)
            throw new Error("已取消");
        throw new Error(errText(error));
    }
    finally {
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
    }
}
/** 拉 manifest：逐源试，成功一个就停；全失败返回 ok:false + 每个源的原因（不抛）。 */
export async function fetchManifest(options = {}) {
    const sources = options.sources ?? ASSETS_SOURCES;
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? 20_000;
    const attempts = [];
    for (const source of sources) {
        if (options.signal?.aborted === true) {
            attempts.push(source.id + " → 已取消（没再试）");
            break;
        }
        const url = joinUrl(source.baseUrl, ASSETS_MANIFEST_FILE);
        try {
            const buffer = await requestBuffer(url, fetchImpl, timeoutMs, options.signal);
            const text = buffer.toString("utf8");
            const parsed = parseManifest(text);
            if (parsed.manifest === null) {
                attempts.push(source.id + "（" + source.label + "）→ " + parsed.error);
                continue;
            }
            return { ok: true, manifest: parsed.manifest, text, source, attempts, error: "" };
        }
        catch (error) {
            attempts.push(source.id + "（" + source.label + "）→ " + errText(error));
        }
    }
    return {
        ok: false,
        manifest: null,
        text: "",
        source: null,
        attempts,
        error: attempts.length === 0 ? "没有可用的源（sources 为空）" : "所有源都没拉到 manifest.json：" + attempts.join("；"),
    };
}
let stagingSeq = 0;
async function downloadAsset(relPath, sources, fetchImpl, timeoutMs, signal) {
    const attempts = [];
    for (const source of sources) {
        if (signal?.aborted === true) {
            attempts.push(source.id + " → 已取消（没再试）");
            break;
        }
        const url = joinUrl(source.baseUrl, relPath);
        try {
            const buffer = await requestBuffer(url, fetchImpl, timeoutMs, signal);
            return { ok: true, buffer, source, attempts, reason: "" };
        }
        catch (error) {
            attempts.push(source.id + "（" + source.label + "）→ " + errText(error));
        }
    }
    return {
        ok: false,
        buffer: Buffer.alloc(0),
        source: null,
        attempts,
        reason: attempts.length === 0 ? "没有可用的源" : "所有源都没下下来：" + attempts.join("；"),
    };
}
function scanDirStats(dir, skipNames = []) {
    let files = 0;
    let bytes = 0;
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return { files, bytes };
    }
    for (const entry of entries) {
        if (skipNames.includes(entry.name))
            continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const nested = scanDirStats(full, skipNames);
            files += nested.files;
            bytes += nested.bytes;
            continue;
        }
        if (!entry.isFile())
            continue;
        files += 1;
        try {
            bytes += fs.statSync(full).size;
        }
        catch {
            // 统计不到大小不影响"有几个文件"的结论。
        }
    }
    return { files, bytes };
}
/**
 * 按 profile 安装到本地：逐文件下载 → 逐文件 sha256 → 全绿才搬进 <version>/。
 *
 * 失败语义（这是这一层的硬承诺）：
 *   · 任何一个文件下载失败 / 哈希不符 / 字节数不符 → 整次 ok:false；
 *   · 临时目录 <version>.tmp-* 一定删掉，<version>/ 里不留半成品；
 *     之前装好的同版本内容不被这次失败影响（旧文件不动）；
 *   · failures 里点名是哪个文件、期望与实际的哈希，调用方能直接说人话。
 */
export async function verifyAndInstall(request) {
    const env = request.env ?? process.env;
    const base = request.root !== undefined && request.root !== "" ? request.root : localAssetsRoot(env);
    const version = request.manifest.version;
    const destRoot = path.join(base, version);
    const profile = normalizeProfile(request.profile);
    const common = {
        root: base,
        versionDir: destRoot,
        version,
        profile: profile ?? (request.profile ?? "").trim(),
        source: "",
        files: [],
        failures: [],
        fileCount: 0,
        totalBytes: 0,
        attempts: [],
    };
    const fail = (message, extra = {}) => ({
        ...common,
        ...extra,
        ok: false,
        message,
    });
    if (profile === null) {
        return fail("不认识的 profile：" + String(request.profile) + "（只有 core / full）。什么都没装。");
    }
    const targets = profileFiles(request.manifest, profile);
    if (targets.length === 0) {
        return fail("manifest 的 profile=" + profile + " 里一个文件都没有，拒绝安装（检查 manifest.profiles 与 files[].profile）。");
    }
    for (const target of targets) {
        const normalized = normalizeAssetPath(target.path);
        if (normalized === null || normalized !== target.path) {
            return fail("manifest 里的路径不合法：" + target.path + "（必须是资源根内的相对路径）。什么都没装。");
        }
    }
    const sources = request.sources ?? ASSETS_SOURCES;
    const fetchImpl = request.fetchImpl ?? fetch;
    const timeoutMs = request.timeoutMs ?? 30_000;
    stagingSeq += 1;
    const staging = path.join(base, version + ".tmp-" + String(process.pid) + "-" + String(stagingSeq));
    const destExisted = fs.existsSync(destRoot);
    const installed = [];
    const usedSources = [];
    let totalBytes = 0;
    try {
        fs.rmSync(staging, { recursive: true, force: true });
        fs.mkdirSync(staging, { recursive: true });
        for (const target of targets) {
            if (request.signal?.aborted === true) {
                return fail("已取消：装到 " + String(installed.length) + "/" + String(targets.length) + " 个文件时被取消，临时文件已清掉，旧版本没动。");
            }
            const download = await downloadAsset(target.path, sources, fetchImpl, timeoutMs, request.signal);
            if (!download.ok || download.source === null) {
                return fail("下载失败：" + target.path + " —— " + download.reason + "。已回滚（临时文件删掉，" + (destExisted ? "原有 " + version + " 内容没动" : "没有留下半成品") + "）。", { failures: [{ path: target.path, expected: target.sha256, actual: "", reason: download.reason, attempts: download.attempts }], attempts: download.attempts });
            }
            const actual = sha256Hex(download.buffer);
            if (actual !== target.sha256) {
                const reason = "sha256 对不上（期望 " + shortHash(target.sha256) + "，实际 " + shortHash(actual) + "）";
                return fail("校验失败：" + target.path + " 的 " + reason + "。已回滚 —— 临时文件删掉，" + (destExisted ? "原有 " + version + " 内容没动" : "没有留下半成品") + "。", {
                    failures: [{ path: target.path, expected: target.sha256, actual, reason, attempts: download.attempts }],
                    attempts: download.attempts,
                });
            }
            if (target.bytes > 0 && download.buffer.byteLength !== target.bytes) {
                const reason = "字节数对不上（manifest 写 " + String(target.bytes) + "，实际 " + String(download.buffer.byteLength) + "）";
                return fail("校验失败：" + target.path + " 的 " + reason + "。已回滚 —— 临时文件删掉，" + (destExisted ? "原有 " + version + " 内容没动" : "没有留下半成品") + "。", {
                    failures: [{ path: target.path, expected: target.sha256, actual, reason, attempts: download.attempts }],
                    attempts: download.attempts,
                });
            }
            const dest = path.join(staging, target.path);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, download.buffer);
            installed.push({ path: target.path, bytes: download.buffer.byteLength, sha256: actual, source: download.source.id, status: "ok", detail: "" });
            totalBytes += download.buffer.byteLength;
            if (!usedSources.includes(download.source.id))
                usedSources.push(download.source.id);
        }
        // 全部校验通过才动正式目录：先搬文件，再写 manifest / install.json。
        fs.mkdirSync(destRoot, { recursive: true });
        try {
            for (const file of installed) {
                const from = path.join(staging, file.path);
                const to = path.join(destRoot, file.path);
                fs.mkdirSync(path.dirname(to), { recursive: true });
                fs.rmSync(to, { force: true });
                fs.renameSync(from, to);
            }
            const manifestPath = path.join(destRoot, ASSETS_MANIFEST_FILE);
            fs.writeFileSync(manifestPath, request.manifestText ?? JSON.stringify(request.manifest, null, 2) + "\n", "utf8");
            const previous = readInstallRecord(destRoot);
            const profiles = new Set(previous?.profiles ?? []);
            profiles.add(profile);
            const stats = scanDirStats(destRoot, [ASSETS_MANIFEST_FILE, ASSETS_INSTALL_FILE]);
            const record = {
                version,
                profiles: [...profiles].sort(),
                installedAt: new Date().toISOString(),
                source: usedSources.join("+"),
                schema: request.manifest.schema,
                fileCount: stats.files,
                totalBytes: stats.bytes,
            };
            fs.writeFileSync(path.join(destRoot, ASSETS_INSTALL_FILE), JSON.stringify(record, null, 2) + "\n", "utf8");
        }
        catch (error) {
            // 搬文件途中失败：至少把这次新出现的版本目录整个撤掉，别留"半个版本"。
            if (!destExisted)
                fs.rmSync(destRoot, { recursive: true, force: true });
            return fail("写盘失败（" + errText(error) + "）：已回滚" + (destExisted ? "，原有 " + version + " 内容没动" : "，没有留下半成品") + "。");
        }
        return {
            ...common,
            ok: true,
            source: usedSources.join("+"),
            files: installed,
            fileCount: installed.length,
            totalBytes,
            message: "已安装资源包 " + version + "（profile=" + profile + "）：" + String(installed.length) + " 个文件、" +
                String(totalBytes) + " 字节，来源 " + usedSources.join("+") + "；目录 " + destRoot + "。",
        };
    }
    catch (error) {
        if (!destExisted)
            fs.rmSync(destRoot, { recursive: true, force: true });
        return fail("安装中断（" + errText(error) + "）：临时文件已清掉，没有留下半成品。");
    }
    finally {
        fs.rmSync(staging, { recursive: true, force: true });
    }
}
function readInstallRecord(dir) {
    try {
        const raw = fs.readFileSync(path.join(dir, ASSETS_INSTALL_FILE), "utf8");
        const parsed = JSON.parse(raw);
        if (!isRecord(parsed))
            return null;
        const version = parsed["version"];
        if (typeof version !== "string" || version === "")
            return null;
        const profiles = Array.isArray(parsed["profiles"])
            ? parsed["profiles"].filter((item) => typeof item === "string")
            : [];
        return {
            version,
            profiles,
            installedAt: typeof parsed["installedAt"] === "string" ? parsed["installedAt"] : "",
            source: typeof parsed["source"] === "string" ? parsed["source"] : "",
            schema: typeof parsed["schema"] === "number" ? parsed["schema"] : 0,
            fileCount: typeof parsed["fileCount"] === "number" ? parsed["fileCount"] : 0,
            totalBytes: typeof parsed["totalBytes"] === "number" ? parsed["totalBytes"] : 0,
        };
    }
    catch {
        return null;
    }
}
/** 版本比较：按数字段比（2026.10.30-1 > 2026.9.1），非数字段按字典序。 */
export function compareVersions(a, b) {
    const tokenize = (value) => value.match(/\d+|[A-Za-z]+/gu) ?? [];
    const left = tokenize(a);
    const right = tokenize(b);
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        const l = left[index];
        const r = right[index];
        if (l === undefined)
            return r === undefined ? 0 : -1;
        if (r === undefined)
            return 1;
        const ln = /^\d+$/u.test(l);
        const rn = /^\d+$/u.test(r);
        if (ln && rn) {
            const diff = Number(l) - Number(r);
            if (diff !== 0)
                return diff;
            continue;
        }
        if (l !== r)
            return l < r ? -1 : 1;
    }
    return 0;
}
/** 扫描本地装过哪些版本（有新到旧）。只认带 install.json 的目录，所以半成品不会被当成"已安装"。 */
export function listInstalledVersions(env = process.env, root) {
    const base = root !== undefined && root !== "" ? root : localAssetsRoot(env);
    let entries;
    try {
        entries = fs.readdirSync(base, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const found = [];
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        if (entry.name.startsWith("."))
            continue;
        if (entry.name.includes(".tmp-"))
            continue;
        const dir = path.join(base, entry.name);
        const record = readInstallRecord(dir);
        if (record === null)
            continue;
        const stats = scanDirStats(dir, [ASSETS_MANIFEST_FILE, ASSETS_INSTALL_FILE]);
        found.push({
            version: record.version,
            dir,
            profiles: record.profiles.length > 0 ? record.profiles : ["core"],
            installedAt: record.installedAt,
            fileCount: stats.files,
            totalBytes: stats.bytes,
            current: false,
        });
    }
    found.sort((left, right) => {
        const byVersion = compareVersions(right.version, left.version);
        if (byVersion !== 0)
            return byVersion;
        return right.installedAt.localeCompare(left.installedAt);
    });
    const first = found[0];
    if (first !== undefined)
        first.current = true;
    return found;
}
/**
 * 读本地装好的 manifest（默认最新一版）。读不到/坏 JSON 不抛：返回 error 文本，
 * 调用方（工具卡片）把"还没装 / 装坏了"讲清楚，action=refresh 就能修。
 */
export function readLocalManifest(env = process.env, version) {
    const info = assetsRootInfo(env);
    const versions = listInstalledVersions(env);
    const wanted = (version ?? "").trim();
    const picked = wanted === ""
        ? versions[0]
        : versions.find((item) => item.version === wanted) ?? null;
    if (picked === undefined || picked === null) {
        return {
            manifest: null,
            install: null,
            root: info.root,
            version: "",
            versionDir: "",
            error: wanted === "" ? "本地还没装资源包（先 action=refresh 下载）" : "本地没有版本 " + wanted + "（action=list 看已装版本）",
        };
    }
    const manifestPath = path.join(picked.dir, ASSETS_MANIFEST_FILE);
    let text;
    try {
        text = fs.readFileSync(manifestPath, "utf8");
    }
    catch (error) {
        return {
            manifest: null,
            install: null,
            root: info.root,
            version: picked.version,
            versionDir: picked.dir,
            error: "本地 manifest 读不了（" + manifestPath + "）：" + errText(error) + "；action=refresh 可以重装。",
        };
    }
    const parsed = parseManifest(text);
    if (parsed.manifest === null) {
        return {
            manifest: null,
            install: null,
            root: info.root,
            version: picked.version,
            versionDir: picked.dir,
            error: "本地 manifest 坏了（" + manifestPath + "）：" + parsed.error + "；action=refresh 可以重装。",
        };
    }
    return {
        manifest: parsed.manifest,
        install: readInstallRecord(picked.dir),
        root: info.root,
        version: picked.version,
        versionDir: picked.dir,
        error: "",
    };
}
/**
 * 把"profile + 相对路径"解析成本地文件：要判断三件事——装了没、这份文件属不属于该 profile、
 * 本地文件在不在。三者都过才返回路径，否则给一句能照着修的话。
 */
export function resolveAssetFile(profile, relPath, env = process.env) {
    const empty = (error) => ({ ok: false, path: "", version: "", bytes: 0, error });
    const normalizedProfile = normalizeProfile(profile);
    if (normalizedProfile === null)
        return empty("不认识的 profile：" + String(profile) + "（只有 core / full）");
    const normalized = normalizeAssetPath(relPath);
    if (normalized === null)
        return empty("路径不合法：" + String(relPath) + "（必须是资源根内的相对路径）");
    const state = readLocalManifest(env);
    if (state.manifest === null)
        return empty(state.error === "" ? "本地还没装资源包" : state.error);
    const entry = state.manifest.files.find((file) => file.path === normalized);
    if (entry === undefined)
        return empty("资源包里没有这个文件：" + normalized + "（action=list 看这一版有哪些文件）");
    const allowed = profileFiles(state.manifest, normalizedProfile).some((file) => file.path === normalized);
    if (!allowed) {
        return empty("文件 " + normalized + " 不在 profile=" + normalizedProfile + " 里（它属于 profile=" + entry.profile + "）；用 profile=full 装一次，或改问 core 里的文件。");
    }
    const localPath = path.join(state.versionDir, normalized);
    try {
        const stat = fs.statSync(localPath);
        if (!stat.isFile())
            return empty("本地路径不是文件：" + localPath + "；action=refresh 可以重装。");
        return { ok: true, path: localPath, version: state.version, bytes: stat.size, error: "" };
    }
    catch {
        return empty("本地缺这个文件：" + localPath + "（action=refresh 可以重装 " + state.version + "）");
    }
}
/** 逐文件 sha256 复核本地安装。缺文件算 missing，哈希/大小不对算 changed。 */
export function verifyInstalled(request = {}) {
    const env = request.env ?? process.env;
    const profile = normalizeProfile(request.profile);
    const info = assetsRootInfo(env);
    const state = readLocalManifest(env, request.version);
    const common = {
        root: info.root,
        version: state.version,
        versionDir: state.versionDir,
        profile: profile ?? (request.profile ?? "").trim(),
        files: [],
        fileCount: 0,
        totalBytes: 0,
    };
    if (profile === null)
        return { ...common, ok: false, message: "不认识的 profile：" + String(request.profile) + "（只有 core / full）。" };
    if (state.manifest === null)
        return { ...common, ok: false, message: state.error + (state.error === "" ? "" : "。") };
    const targets = profileFiles(state.manifest, profile);
    let bad = 0;
    for (const target of targets) {
        const localPath = path.join(state.versionDir, target.path);
        let buffer;
        try {
            buffer = fs.readFileSync(localPath);
        }
        catch {
            bad += 1;
            common.files.push({ path: target.path, bytes: 0, sha256: "", status: "missing", detail: "本地缺这个文件（action=refresh 修复）" });
            continue;
        }
        const actual = sha256Hex(buffer);
        if (actual !== target.sha256 || (target.bytes > 0 && buffer.byteLength !== target.bytes)) {
            bad += 1;
            common.files.push({
                path: target.path,
                bytes: buffer.byteLength,
                sha256: actual,
                status: "changed",
                detail: "sha256 对不上（期望 " + shortHash(target.sha256) + "，实际 " + shortHash(actual) + "）",
            });
            continue;
        }
        common.files.push({ path: target.path, bytes: buffer.byteLength, sha256: actual, status: "ok", detail: "" });
        common.totalBytes += buffer.byteLength;
    }
    common.fileCount = common.files.length;
    return {
        ...common,
        ok: bad === 0 && common.files.length > 0,
        message: "校验 " + state.version + "（profile=" + profile + "）：" + String(common.files.length) + " 个文件里 " +
            String(bad) + " 个有问题" + (bad === 0 ? "，全部对得上。" : "。action=refresh 重装这一版即可。"),
    };
}
/**
 * 只留当前与上一版（keep=2），其它版本目录删掉；顺手清掉 .tmp-* 残留（下载中断留下的）。
 * 版本按版本号排序，不按目录名，避免 "2026.9.1" 排到 "2026.10.30" 后面。
 */
export function pruneOldVersions(env = process.env, keep = 2, root) {
    const base = root !== undefined && root !== "" ? root : localAssetsRoot(env);
    const versions = listInstalledVersions(env, base);
    const keepCount = Math.max(1, Math.floor(keep));
    const removed = [];
    const kept = [];
    let reclaimedBytes = 0;
    versions.forEach((item, index) => {
        if (index < keepCount) {
            kept.push(item.version);
            return;
        }
        const stats = scanDirStats(item.dir);
        try {
            fs.rmSync(item.dir, { recursive: true, force: true });
            removed.push(item.version);
            reclaimedBytes += stats.bytes;
        }
        catch {
            // 删不掉的版本保留在磁盘上，但也不谎报 removed。
        }
    });
    // 半成品（.tmp-*）一律清：它们不参与安装判断，只会占地方。
    try {
        for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
            if (!entry.isDirectory() || !entry.name.includes(".tmp-"))
                continue;
            const dir = path.join(base, entry.name);
            const stats = scanDirStats(dir);
            try {
                fs.rmSync(dir, { recursive: true, force: true });
                reclaimedBytes += stats.bytes;
            }
            catch {
                // 同上。
            }
        }
    }
    catch {
        // 根目录不存在：没什么可清的。
    }
    const message = versions.length === 0
        ? "本地没有装过资源包，没什么可清理的。"
        : removed.length === 0
            ? "保留 " + kept.join("、") + "（不超过 " + String(keepCount) + " 个版本），没有旧版本要删。"
            : "删掉 " + String(removed.length) + " 个旧版本（" + removed.join("、") + "），回收 " + String(reclaimedBytes) + " 字节；保留 " + kept.join("、") + "。";
    return { removed, kept, reclaimedBytes, message };
}
