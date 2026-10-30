/**
 * L3：stm32_assets —— 把资源仓库里"会随上游长大"的那部分按需下到本地。
 *
 * 为什么不塞进 npm 包：device 事实层（chips.json / memory.json / svd/<line>.json）、14 份 ioc 模板、
 * 12 份链接脚本已经是 90+ 个文件、几百 KB，chipdb/diagrams 更多；打进包里等于每次改一颗芯片就
 * 发一次版。所以放独立仓库，按 profile 下载 + sha256 校验 + 本地缓存，装好之后完全离线可用。
 *
 * 四个动作是给用户看的，不是藏在 error 里的：
 *   · list    本地装了哪些版本、profile=core 的文件齐不齐、占多大；
 *   · refresh 拉 manifest → 逐文件下载 → 逐文件 sha256 → 全绿才落盘（默认 core）；
 *   · verify  对本地文件逐个复核 sha256（怀疑装坏了就跑它）；
 *   · prune   只留当前与上一版（版本目录会越攒越多）。
 *
 * 离线兜底是硬约束：refresh 失败必须返回 ok:false + 人话原因，并说明内置表
 * （src/data/chip-table.json + src/data/stm32f1.ts）仍能建工程 —— 资源包只是补充，不是前置条件。
 */
import fs from "node:fs";
import path from "node:path";
import { assetsRootInfo, fetchManifest, listInstalledVersions, normalizeProfile, profileFiles, pruneOldVersions, readLocalManifest, resolveSources, verifyAndInstall, verifyInstalled, } from "../engine/assets.js";
export const ASSETS_TOOL = "stm32_assets";
/** 离线兜底话术：每次 refresh 失败都要原样带上，别让模型自己编"没有资源包就不能建工程"。 */
const OFFLINE_FALLBACK = "内置表不受影响：src/data/chip-table.json + src/data/stm32f1.ts 仍在插件里，建工程（stm32_project_create）不需要资源包；" +
    "资源包只是 device 事实层 / ioc 模板 / 链接脚本的补充，等网络好了再 action=refresh。";
const fileSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        path: { type: "string" },
        bytes: { type: "number" },
        sha256: { type: "string" },
        status: { type: "string" },
        detail: { type: "string" },
    },
    required: ["path", "bytes", "sha256", "status", "detail"],
};
const versionSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        version: { type: "string" },
        files: { type: "number" },
        bytes: { type: "number" },
        profiles: { type: "array", items: { type: "string" } },
        installedAt: { type: "string" },
        current: { type: "boolean" },
    },
    required: ["version", "files", "bytes", "profiles", "installedAt", "current"],
};
export const outputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        action: { type: "string" },
        ok: { type: "boolean" },
        root: { type: "string" },
        origin: { type: "string" },
        version: { type: "string" },
        profile: { type: "string" },
        source: { type: "string" },
        fileCount: { type: "number" },
        totalBytes: { type: "number" },
        files: { type: "array", items: fileSchema },
        versions: { type: "array", items: versionSchema },
        attempts: { type: "array", items: { type: "string" } },
        offlineFallback: { type: "string" },
        message: { type: "string" },
    },
    required: [
        "action",
        "ok",
        "root",
        "origin",
        "version",
        "profile",
        "source",
        "fileCount",
        "totalBytes",
        "files",
        "versions",
        "attempts",
        "offlineFallback",
        "message",
    ],
};
function toVersionView(item) {
    return {
        version: item.version,
        files: item.fileCount,
        bytes: item.totalBytes,
        profiles: item.profiles,
        installedAt: item.installedAt,
        current: item.current,
    };
}
function describeBytes(bytes) {
    if (bytes < 1024)
        return String(bytes) + " B";
    if (bytes < 1024 * 1024)
        return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(2) + " MB";
}
export function registerAssets(ctx, options = {}) {
    ctx.tools.register({
        name: ASSETS_TOOL,
        description: "按需下载资源包 dsh-stm32-assets（device 事实层 device/f1/chips.json·memory.json·svd/<line>.json、ioc 模板、链接脚本；profile=full 另含 chipdb/diagrams）到本地 ~/.dsh-stm32/assets/<version>/（DSH_STM32_ASSETS 可覆盖），逐文件按 manifest 的 sha256 校验，装好之后离线复用。action=list 看本地版本/文件/占用；refresh 拉 manifest 并按 profile 安装（默认 core，源顺序 GitHub → jsDelivr → GitCode 自动回退，报告里写明实际走的源）；verify 逐个 sha256 复核；prune 只留当前与上一版。下载失败不抛错：ok=false + 人话原因，内置表（src/data/chip-table.json + src/data/stm32f1.ts）仍可建工程。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                action: {
                    type: "string",
                    enum: ["list", "refresh", "verify", "prune"],
                    description: "list（默认，看本地版本/文件/占用）/ refresh（拉 manifest 并安装）/ verify（逐个 sha256 复核）/ prune（只留当前与上一版）。",
                },
                profile: {
                    type: "string",
                    enum: ["core", "full"],
                    description: "core（默认：device/ + ioc/ + ld/，建工程够用）/ full（再加 chipdb/ + diagrams/）。",
                },
                source: {
                    type: "string",
                    description: "只走某个源：github / jsdelivr / gitcode，或一个完整 base URL；不填按内置顺序自动回退。",
                },
                version: {
                    type: "string",
                    description: "list / verify 指定版本；不填用本地最新一版。",
                },
                keep: {
                    type: "number",
                    minimum: 1,
                    description: "prune 保留几个版本，默认 2（当前 + 上一版）。",
                },
            },
            required: [],
        },
        timeoutMs: 5 * 60_000,
        isConcurrencySafe: () => false,
        output: {
            schema: outputSchema,
            render: (_args, value) => {
                const typed = value;
                const lines = [typed.message];
                lines.push("资源目录：" + typed.root + "（来源：" + typed.origin + "）；profile=" + typed.profile);
                if (typed.source !== "")
                    lines.push("本次来源：" + typed.source);
                if (typed.versions.length > 0) {
                    const items = typed.versions.map((item) => item.version +
                        (item.current ? "（当前）" : "") +
                        "：" + String(item.files) + " 个文件、" + describeBytes(item.bytes) +
                        "，profile=" + item.profiles.join("+"));
                    lines.push("本地版本：" + items.join("；"));
                }
                if (typed.files.length > 0) {
                    const head = typed.files.slice(0, 10);
                    for (const file of head) {
                        lines.push("· " + file.path + "（" + describeBytes(file.bytes) + "）→ " + file.status + (file.detail === "" ? "" : "：" + file.detail));
                    }
                    if (typed.files.length > head.length)
                        lines.push("… 还有 " + String(typed.files.length - head.length) + " 个文件（action=list 看全量）");
                    lines.push("合计 " + String(typed.fileCount) + " 个文件、" + describeBytes(typed.totalBytes));
                }
                if (typed.attempts.length > 0)
                    lines.push("尝试记录：" + typed.attempts.join(" ｜ "));
                if (typed.offlineFallback !== "")
                    lines.push("离线兜底：" + typed.offlineFallback);
                return [{ type: "text", text: lines.join("\n") }];
            },
        },
        async execute(rawArgs, exec) {
            const args = rawArgs ?? {};
            const action = (args.action ?? "list").trim().toLowerCase();
            const env = options.env ?? process.env;
            const fetchImpl = options.fetchImpl;
            const info = assetsRootInfo(env);
            const profile = normalizeProfile(args.profile);
            const versionsOf = () => listInstalledVersions(env).map(toVersionView);
            const base = () => ({
                action,
                ok: false,
                root: info.root,
                origin: info.origin,
                version: "",
                profile: profile ?? (args.profile ?? "").trim(),
                source: "",
                fileCount: 0,
                totalBytes: 0,
                files: [],
                versions: versionsOf(),
                attempts: [],
                offlineFallback: "",
                message: "",
            });
            if (profile === null) {
                return {
                    ...base(),
                    message: "不认识的 profile：" + String(args.profile) + "（只有 core / full）。什么都没做。",
                };
            }
            /* ---------------------------- list ---------------------------- */
            if (action === "list") {
                const value = base();
                const state = readLocalManifest(env, args.version);
                value.ok = true;
                value.version = state.version;
                value.source = state.install?.source ?? "";
                if (state.manifest === null) {
                    value.offlineFallback = OFFLINE_FALLBACK;
                    value.message =
                        "本地还没装资源包（" + info.root + "）：" + state.error + "。action=refresh 下载 profile=core（device + ioc + ld，约 27 个文件）。";
                    return value;
                }
                for (const target of profileFiles(state.manifest, profile)) {
                    const localPath = path.join(state.versionDir, target.path);
                    let present = false;
                    try {
                        present = fs.statSync(localPath).isFile();
                    }
                    catch {
                        present = false;
                    }
                    value.files.push({
                        path: target.path,
                        bytes: target.bytes,
                        sha256: target.sha256,
                        status: present ? "present" : "missing",
                        detail: present ? "已装（未校验；action=verify 逐文件复核 sha256）" : "profile 里列了，但本地没有这个文件（action=refresh 修复）",
                    });
                }
                value.fileCount = value.files.length;
                value.totalBytes = value.files.reduce((sum, file) => sum + file.bytes, 0);
                value.message =
                    "本地已装 " + state.version + "（profile=" + profile + "）：" + String(value.fileCount) + " 个文件、约 " +
                        describeBytes(value.totalBytes) + "；目录 " + state.versionDir + "。";
                return value;
            }
            /* ---------------------------- refresh ---------------------------- */
            if (action === "refresh") {
                const value = base();
                const sources = resolveSources(args.source);
                const manifestResult = await fetchManifest({
                    sources,
                    ...(fetchImpl === undefined ? {} : { fetchImpl }),
                    timeoutMs: 20_000,
                    signal: exec.signal,
                });
                value.attempts = [...manifestResult.attempts];
                if (!manifestResult.ok || manifestResult.manifest === null || manifestResult.source === null) {
                    value.ok = false;
                    value.offlineFallback = OFFLINE_FALLBACK;
                    value.message = "刷新失败：拉不到 manifest.json。" + manifestResult.error + " 离线兜底见下。";
                    return value;
                }
                const manifestSource = manifestResult.source;
                // manifest 能拉到的源排在文件下载第一位：它证明这条线路是通的（自定义源时尤其重要）。
                const ordered = [manifestSource, ...sources.filter((source) => source.id !== manifestSource.id)];
                const install = await verifyAndInstall({
                    manifest: manifestResult.manifest,
                    manifestText: manifestResult.text,
                    profile,
                    sources: ordered,
                    env,
                    ...(fetchImpl === undefined ? {} : { fetchImpl }),
                    timeoutMs: 60_000,
                    signal: exec.signal,
                });
                value.version = install.version;
                value.source = install.source;
                value.versions = versionsOf();
                if (!install.ok) {
                    value.ok = false;
                    value.offlineFallback = OFFLINE_FALLBACK;
                    const failureLines = install.failures.map((failure) => failure.path + "：" + failure.reason + (failure.attempts.length === 0 ? "" : "（" + failure.attempts.join("；") + "）"));
                    value.attempts = [...value.attempts, ...failureLines];
                    value.message =
                        "安装失败（manifest 来自 " + manifestSource.id + "：" + manifestSource.label + "）。" + install.message;
                    return value;
                }
                value.ok = true;
                value.files = install.files.map((file) => ({
                    path: file.path,
                    bytes: file.bytes,
                    sha256: file.sha256,
                    status: "ok",
                    detail: "来自 " + file.source,
                }));
                value.fileCount = install.fileCount;
                value.totalBytes = install.totalBytes;
                value.message =
                    "已刷新：" + install.message + " manifest 来自 " + manifestSource.id + "（" + manifestSource.label + "）" +
                        (manifestResult.attempts.length === 0 ? "，第一源就通。" : "，前 " + String(manifestResult.attempts.length) + " 个源不通：" + manifestResult.attempts.join("；") + "。");
                return value;
            }
            /* ---------------------------- verify ---------------------------- */
            if (action === "verify") {
                const value = base();
                const result = verifyInstalled({
                    profile,
                    env,
                    ...(args.version === undefined ? {} : { version: args.version }),
                });
                value.ok = result.ok;
                value.version = result.version;
                value.fileCount = result.fileCount;
                value.totalBytes = result.totalBytes;
                value.files = result.files.map((file) => ({
                    path: file.path,
                    bytes: file.bytes,
                    sha256: file.sha256,
                    status: file.status,
                    detail: file.detail,
                }));
                value.message = result.message;
                if (!result.ok) {
                    value.offlineFallback = result.version === "" ? OFFLINE_FALLBACK : "本地已有版本 " + result.version + "，action=refresh 重装这一版即可；内置表不受影响。";
                }
                return value;
            }
            /* ---------------------------- prune ---------------------------- */
            if (action === "prune") {
                const value = base();
                const keep = typeof args.keep === "number" && Number.isFinite(args.keep) ? Math.floor(args.keep) : 2;
                const pruned = pruneOldVersions(env, keep);
                value.ok = true;
                value.versions = versionsOf();
                value.version = pruned.kept[0] ?? "";
                value.totalBytes = pruned.reclaimedBytes;
                value.message = pruned.message;
                return value;
            }
            // action 拼错不该被当成某个破坏性动作：说清有哪些，什么都不做。
            const value = base();
            value.message = "不认识的 action：" + action + "（只有 list / refresh / verify / prune）。什么都没做。";
            return value;
        },
    });
}
