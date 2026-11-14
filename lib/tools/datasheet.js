/**
 * L3：数据手册缓存工具（S119）。
 *
 *   stm32_ds_fetch 补抓手册：按立创编号、按本工程用到的立创器件、或手工导入一份 PDF
 *   stm32_ds_list  看缓存：编号、型号、页数、占用、来源
 *
 * 为什么单独一层：原理图、PCB、程序都要靠手册说话（引脚、电气参数、时序），
 * 而手册是外部资源，必须「下一份、校验、记住出处」，而不是每次现查。
 */
import { datasheetCacheDir, ensureDatasheet, importDatasheetFile, isLcscCode, listDatasheets, } from "../engine/datasheet/store.js";
import { projectJlcpcbCodes } from "../engine/datasheet/auto.js";
import { resolveProjectDir } from "./project-dir.js";
export const DS_FETCH_TOOL = "stm32_ds_fetch";
export const DS_LIST_TOOL = "stm32_ds_list";
const cacheDirOf = (env) => datasheetCacheDir(env);
const entryView = {
    type: "object",
    additionalProperties: false,
    properties: {
        code: { type: "string" },
        mpn: { type: "string" },
        brand: { type: "string" },
        bytes: { type: "number" },
        fetchedAt: { type: "string" },
        sourceUrl: { type: "string" },
    },
    required: ["code", "mpn", "brand", "bytes", "fetchedAt", "sourceUrl"],
};
function view(entry) {
    return {
        code: entry.code,
        mpn: entry.mpn,
        brand: entry.brand,
        bytes: entry.bytes,
        fetchedAt: entry.fetchedAt,
        sourceUrl: entry.sourceUrl,
    };
}
export function registerDatasheetTools(ctx) {
    ctx.tools.register({
        name: DS_FETCH_TOOL,
        description: "补齐器件的数据手册到本地缓存（~/.dsh-stm32/datasheets）：按立创编号（C25137）、按本工程用到的立创器件（all），或手工导入一份 PDF（file）。命中缓存时不联网；抓取失败会记 24 小时负缓存。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                projectDir: { type: "string", description: "工程根目录；缺省为会话工作目录。" },
                code: { type: "string", description: "立创商品编号，例如 C25137。与 all / file 三选一。" },
                all: { type: "boolean", description: "补齐本工程 circuit 源码里出现的全部 jlcpcb 器件。" },
                file: { type: "string", description: "手工导入的 PDF 路径（反爬或无编号时的退路）。" },
                mpn: { type: "string", description: "手工导入时一并记录的型号。" },
                refresh: { type: "boolean", description: "忽略缓存与负缓存，强制重抓。" },
            },
            required: [],
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    ok: { type: "boolean" },
                    error: { type: "string" },
                    cacheDir: { type: "string" },
                    cached: { type: "number" },
                    fetched: { type: "array", items: entryView },
                    failed: { type: "array", items: { type: "object", additionalProperties: false, properties: { code: { type: "string" }, error: { type: "string" } }, required: ["code", "error"] } },
                    notes: { type: "array", items: { type: "string" } },
                },
                required: ["ok", "error", "cacheDir", "cached", "fetched", "failed", "notes"],
            },
            render: (_args, value) => {
                const result = value;
                if (!result.ok)
                    return [{ type: "text", text: "补齐失败：" + result.error }];
                const lines = [
                    "缓存目录：" + result.cacheDir,
                    "本次命中 " + String(result.cached) + " 个，新抓 " + String(result.fetched.length) + " 个，失败 " + String(result.failed.length) + " 个",
                ];
                for (const item of result.fetched)
                    lines.push("  + " + item.code + " · " + item.mpn + " · " + String(Math.round(item.bytes / 1024)) + " KB");
                for (const item of result.failed)
                    lines.push("  ! " + item.code + "：" + item.error);
                for (const note of result.notes)
                    lines.push("· " + note);
                return [{ type: "text", text: lines.join("\n") }];
            },
        },
        timeoutMs: 240_000,
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const env = process.env;
            const cacheDir = cacheDirOf(env);
            const offline = (env["DSH_STM32_OFFLINE"] ?? "").trim() === "1";
            const notes = [];
            const fetched = [];
            const failed = [];
            let cached = 0;
            const handle = async (code) => {
                const result = await ensureDatasheet(code, { cacheDir, refresh: args.refresh ?? false, offline, env, signal: exec.signal });
                if (result.ok && result.entry !== undefined) {
                    if (result.cached ?? false)
                        cached += 1;
                    else
                        fetched.push(result.entry);
                    return;
                }
                failed.push({ code, error: result.error ?? "未知错误" });
            };
            if (typeof args.file === "string" && args.file.trim() !== "") {
                const imported = importDatasheetFile(cacheDir, args.file.trim(), args.code, args.mpn);
                if (imported.ok && imported.entry !== undefined)
                    fetched.push(imported.entry);
                else
                    failed.push({ code: args.code ?? args.file, error: imported.error ?? "导入失败" });
            }
            else if (typeof args.code === "string" && args.code.trim() !== "") {
                if (!isLcscCode(args.code)) {
                    return { ok: false, error: "编号不像立创商品编号：" + args.code + "（形如 C25137）", cacheDir, cached: 0, fetched: [], failed: [], notes };
                }
                await handle(args.code);
            }
            else if (args.all === true) {
                const project = await resolveProjectDir(ctx, args.projectDir, exec);
                if (project.projectDir === "") {
                    return { ok: false, error: "projectDir 不能为空：从工具栏「工程」下拉里选一个，或先打开调试会话", cacheDir, cached: 0, fetched: [], failed: [], notes };
                }
                const codes = projectJlcpcbCodes(project.projectDir);
                if (codes.length === 0)
                    notes.push("工程里没有 jlcpcb 编号：先在 circuit 源码里用 footprint=\"jlcpcb:C…\"");
                for (const code of codes)
                    await handle(code);
            }
            else {
                return { ok: false, error: "要指定 code、all 或 file 之一", cacheDir, cached: 0, fetched: [], failed: [], notes };
            }
            if (failed.length > 0)
                notes.push("失败项已记入负缓存，24 小时内不重试；可用 refresh 强制重试，或手工导入 PDF。");
            if (offline)
                notes.push("离线模式：只查本地缓存，没有发起请求。");
            return { ok: failed.length === 0, error: failed.length === 0 ? "" : "有 " + String(failed.length) + " 个器件未完成", cacheDir, cached, fetched: fetched.map(view), failed, notes };
        },
    });
    ctx.tools.register({
        name: DS_LIST_TOOL,
        description: "列出本地数据手册缓存：编号、型号、品牌、大小、抓取时间与来源，附缓存目录与总占用。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {},
            required: [],
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    ok: { type: "boolean" },
                    error: { type: "string" },
                    cacheDir: { type: "string" },
                    totalBytes: { type: "number" },
                    entries: { type: "array", items: entryView },
                },
                required: ["ok", "error", "cacheDir", "totalBytes", "entries"],
            },
            render: (_args, value) => {
                const result = value;
                if (!result.ok)
                    return [{ type: "text", text: "读取失败：" + result.error }];
                const lines = [
                    "缓存目录：" + result.cacheDir,
                    "共 " + String(result.entries.length) + " 份，占 " + String(Math.round(result.totalBytes / 1024)) + " KB",
                ];
                for (const entry of result.entries) {
                    lines.push("  " + String(entry["code"]) + " · " + String(entry["mpn"]) + " · " + String(Math.round(Number(entry["bytes"]) / 1024)) + " KB · " + String(entry["fetchedAt"]).slice(0, 10));
                }
                return [{ type: "text", text: lines.join("\n") }];
            },
        },
        timeoutMs: 30_000,
        isConcurrencySafe: () => true,
        execute: async () => {
            const env = process.env;
            const cacheDir = cacheDirOf(env);
            try {
                const listing = listDatasheets(cacheDir);
                return { ok: true, error: "", cacheDir, totalBytes: listing.totalBytes, entries: listing.entries.map(view) };
            }
            catch (error) {
                return { ok: false, error: error instanceof Error ? error.message : String(error), cacheDir, totalBytes: 0, entries: [] };
            }
        },
    });
}
