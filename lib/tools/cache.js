/**
 * L3：stm32_cache —— 看/验/拉/清 下载缓存。
 *
 * 缓存里放的是"不属于插件、但建工程要用"的东西：目前是 CMSIS 设备头 + 启动文件 + 内核头。
 * 用户要能自己看见"下到哪了、对不对、占多大、能不能清"，所以这四个动作必须是一等公民，
 * 而不是藏在 error 信息里。
 */
import { cacheRootInfo, checkCacheEntry, describeCacheBytes, readCacheIndex, removeCacheEntry, } from "../engine/cache.js";
import { ensureCmsisTemplate } from "../engine/register-template.js";
export const CACHE_TOOL = "stm32_cache";
const entrySchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        id: { type: "string" },
        kind: { type: "string" },
        family: { type: "string" },
        label: { type: "string" },
        root: { type: "string" },
        files: { type: "number" },
        bytes: { type: "number" },
        createdAt: { type: "string" },
        status: { type: "string" },
        detail: { type: "string" },
    },
    required: ["id", "kind", "family", "label", "root", "files", "bytes", "createdAt"],
};
export const outputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        action: { type: "string" },
        ok: { type: "boolean" },
        cacheRoot: { type: "string" },
        indexPath: { type: "string" },
        origin: { type: "string" },
        totalBytes: { type: "number" },
        entries: { type: "array", items: entrySchema },
        message: { type: "string" },
    },
    required: ["action", "ok", "cacheRoot", "indexPath", "origin", "totalBytes", "entries", "message"],
};
function listEntries(index, verify) {
    return index.entries.map((entry) => {
        const base = {
            id: entry.id,
            kind: entry.kind,
            family: entry.family,
            label: entry.label,
            root: entry.root,
            files: entry.files.length,
            bytes: entry.totalBytes,
            createdAt: entry.createdAt,
        };
        if (!verify)
            return base;
        const health = checkCacheEntry(entry);
        return {
            ...base,
            status: health.ok ? "ok" : "broken",
            detail: health.ok
                ? "文件齐全、大小对得上"
                : "缺 " + String(health.missing.length) + " 个、大小不对 " + String(health.changed.length) + " 个：" + [...health.missing, ...health.changed].slice(0, 5).join("；"),
        };
    });
}
export function registerCache(ctx) {
    ctx.tools.register({
        name: CACHE_TOOL,
        description: "看 / 验 / 拉 / 清 插件的下载缓存（默认 %LOCALAPPDATA%\\dsh-stm32\\cache，可用 DSH_STM32_CACHE 覆盖）：寄存器版模板（CMSIS 设备头 + 启动文件 + 内核头）第一次用时从网上下载到这里，之后复用。action=list 列出条目、verify 逐文件校验、fetch 按型号拉一次（已缓存则直接复用）、purge 删条目（不给 id 就清空）。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                action: { type: "string", enum: ["list", "verify", "fetch", "purge"], description: "list（默认）/ verify / fetch / purge" },
                id: { type: "string", description: "条目 id，例如 cmsis:F1:startup_stm32f103xb（purge/verify 用）。" },
                mcu: { type: "string", description: "芯片型号，例如 STM32F103C8T6（fetch 用）。" },
                family: { type: "string", description: "只给族时写这里，例如 F1（fetch 用；按中容量档处理）。" },
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
                lines.push("缓存目录：" + typed.cacheRoot + "（来源：" + typed.origin + "）");
                lines.push("索引：" + typed.indexPath + "；共 " + String(typed.entries.length) + " 个条目、" + describeCacheBytes(typed.totalBytes));
                for (const entry of typed.entries) {
                    lines.push("· " + entry.id + "（" + entry.kind + "）" + describeCacheBytes(entry.bytes) + "、" + String(entry.files) + " 个文件" + (entry.status === undefined ? "" : " → " + entry.status));
                    if (entry.detail !== undefined)
                        lines.push("    " + entry.detail);
                }
                return [{ type: "text", text: lines.join("\n") }];
            },
        },
        async execute(rawArgs, exec) {
            void exec;
            const args = rawArgs ?? {};
            const action = (args.action ?? "list").trim().toLowerCase();
            const info = cacheRootInfo(process.env);
            const { index, error } = readCacheIndex(process.env);
            const empty = (message, ok = false) => ({
                action,
                ok,
                cacheRoot: info.root,
                indexPath: info.indexPath,
                origin: info.origin,
                totalBytes: 0,
                entries: [],
                message,
            });
            if (action === "list" || action === "verify") {
                const entries = listEntries(index, action === "verify");
                if (args.id !== undefined) {
                    const kept = entries.filter((entry) => entry.id === args.id);
                    return {
                        action,
                        ok: error === null,
                        cacheRoot: info.root,
                        indexPath: info.indexPath,
                        origin: info.origin,
                        totalBytes: kept.reduce((sum, entry) => sum + entry.bytes, 0),
                        entries: kept,
                        message: (error ?? "") + (kept.length === 0 ? "缓存里没有条目 " + args.id + "。" : "缓存里有 " + String(kept.length) + " 个条目。"),
                    };
                }
                return {
                    action,
                    ok: error === null,
                    cacheRoot: info.root,
                    indexPath: info.indexPath,
                    origin: info.origin,
                    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
                    entries,
                    message: (error ?? "") + (entries.length === 0 ? "缓存是空的：第一次建寄存器版工程（或 action=fetch）时会从网上下载模板。" : "缓存里有 " + String(entries.length) + " 个条目。"),
                };
            }
            if (action === "fetch") {
                if ((args.mcu ?? "") === "" && (args.family ?? "") === "") {
                    return empty("fetch 至少给一个 mcu（例如 STM32F103C8T6）或 family（例如 F1）。");
                }
                const result = await ensureCmsisTemplate({
                    ...(args.mcu === undefined ? {} : { mcu: args.mcu }),
                    ...(args.family === undefined ? {} : { family: args.family }),
                });
                const after = readCacheIndex(process.env).index;
                const entries = listEntries(after, false);
                return {
                    action,
                    ok: result.ok,
                    cacheRoot: info.root,
                    indexPath: info.indexPath,
                    origin: info.origin,
                    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
                    entries: entries.filter((entry) => result.id === "" || entry.id === result.id),
                    message: result.message,
                };
            }
            // purge
            if (args.id !== undefined) {
                const removed = removeCacheEntry(args.id, process.env);
                const after = readCacheIndex(process.env).index;
                const entries = listEntries(after, false);
                return {
                    action: "purge",
                    ok: true,
                    cacheRoot: info.root,
                    indexPath: info.indexPath,
                    origin: info.origin,
                    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
                    entries,
                    message: removed.removed ? "已删掉缓存条目 " + args.id + "（目录也清了）。" : "缓存里没有条目 " + args.id + "，什么都没删。",
                };
            }
            const all = readCacheIndex(process.env).index.entries;
            for (const entry of all)
                removeCacheEntry(entry.id, process.env);
            return {
                action: "purge",
                ok: true,
                cacheRoot: info.root,
                indexPath: info.indexPath,
                origin: info.origin,
                totalBytes: 0,
                entries: [],
                message: all.length === 0 ? "缓存本来就是空的。" : "已清空缓存（删了 " + String(all.length) + " 个条目）。下次建工程会重新下载。",
            };
        },
    });
}
