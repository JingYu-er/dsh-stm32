/**
 * L3：数据手册缓存工具（S119）。
 *
 *   stm32_ds_fetch 补抓手册：按立创编号、按本工程用到的立创器件、或手工导入一份 PDF
 *   stm32_ds_list  看缓存：编号、型号、页数、占用、来源
 *
 * 为什么单独一层：原理图、PCB、程序都要靠手册说话（引脚、电气参数、时序），
 * 而手册是外部资源，必须「下一份、校验、记住出处」，而不是每次现查。
 */
import { join } from "node:path";
import { datasheetCacheDir, ensureDatasheet, importDatasheetFile, isLcscCode, listDatasheets, pruneDatasheets, } from "../engine/datasheet/store.js";
import { projectJlcpcbCodes } from "../engine/datasheet/auto.js";
import { searchParts, searchCachePath } from "../engine/datasheet/search.js";
import { buildDigest, readDigest, writeDigest } from "../engine/datasheet/digest.js";
import { resolveDatasheetRef } from "../engine/datasheet/store.js";
import { locatePoppler } from "../engine/pdf/toolchain.js";
import { extractPdfText } from "../engine/pdf/reader.js";
import { popplerDirs } from "./pdf.js";
import { resolveProjectDir } from "./project-dir.js";
export const DS_FETCH_TOOL = "stm32_ds_fetch";
export const DS_LIST_TOOL = "stm32_ds_list";
export const DS_LOOKUP_TOOL = "stm32_ds_lookup";
export const DS_SEARCH_TOOL = "stm32_part_search";
const LOOKUP_KINDS = ["pinout", "absolute-maximum", "electrical", "timing", "package"];
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
        name: DS_LOOKUP_TOOL,
        description: "按用途查已缓存的手册：引脚（pinout）、绝对最大额定值（absolute-maximum）、电气特性（electrical）、时序（timing）、封装（package）。返回页号、标题与该页开头正文；索引不存在时会先建索引。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                code: { type: "string", description: "立创商品编号或型号，例如 C25137。" },
                kind: { type: "string", enum: [...LOOKUP_KINDS, "all"], description: "查哪一类；默认 all。" },
                excerptChars: { type: "number", description: "每段附带的正文长度，默认 1200，最多 4000。" },
            },
            required: ["code"],
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    ok: { type: "boolean" },
                    error: { type: "string" },
                    code: { type: "string" },
                    mpn: { type: "string" },
                    pages: { type: "number" },
                    sections: {
                        type: "array",
                        items: {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                                kind: { type: "string" },
                                page: { type: "number" },
                                heading: { type: "string" },
                                excerpt: { type: "string" },
                            },
                            required: ["kind", "page", "heading", "excerpt"],
                        },
                    },
                    notes: { type: "array", items: { type: "string" } },
                },
                required: ["ok", "error", "code", "mpn", "pages", "sections", "notes"],
            },
            render: (_args, value) => {
                const result = value;
                if (!result.ok)
                    return [{ type: "text", text: "查询失败：" + result.error }];
                const lines = [result.code + " · " + result.mpn + " · 索引覆盖前 " + String(result.pages) + " 页"];
                for (const section of result.sections) {
                    lines.push("", "[" + section.kind + "] 第 " + String(section.page) + " 页 · " + section.heading, section.excerpt);
                }
                for (const note of result.notes)
                    lines.push("· " + note);
                return [{ type: "text", text: lines.join("\n") }];
            },
        },
        timeoutMs: 120_000,
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const cacheDir = datasheetCacheDir(process.env);
            const blank = { ok: false, error: "", code: args.code, mpn: "", pages: 0, sections: [], notes: [] };
            const ref = resolveDatasheetRef(cacheDir, args.code);
            if (ref === null)
                return { ...blank, error: "本地没有 " + args.code + " 的手册：先跑 stm32_ds_fetch code=" + args.code };
            const located = locatePoppler(popplerDirs());
            if (located.tools === null)
                return { ...blank, error: located.error, mpn: ref.entry.mpn };
            const dir = join(cacheDir, ref.entry.code);
            let digest = readDigest(dir);
            const notes = [];
            if (digest === null) {
                const built = await buildDigest(ctx.subprocess, located.tools, ref.file, { signal: exec.signal });
                if (!built.ok || built.digest === undefined) {
                    return { ...blank, error: built.error ?? "建立索引失败", mpn: ref.entry.mpn };
                }
                digest = built.digest;
                writeDigest(dir, digest);
                notes.push("首次查询，已建立索引：" + String(digest.scanned) + " 页");
            }
            const wanted = args.kind === undefined || args.kind === "all" ? digest.sections : digest.sections.filter((item) => item.kind === args.kind);
            if (!digest.textLayer)
                notes.push("这份 PDF 没有可读文字层：索引为空，请改用 stm32_pdf_read mode=render 看图");
            if (wanted.length === 0)
                notes.push("没有匹配的章节：换 kind，或直接按页号用 stm32_pdf_read mode=text 翻");
            const excerptChars = Math.min(4000, Math.max(200, Math.floor(args.excerptChars ?? 1200)));
            const sections = [];
            for (const section of wanted) {
                const pageText = await extractPdfText(ctx.subprocess, located.tools, ref.file, { first: section.page, last: section.page }, exec.signal);
                const firstPage = pageText.pages[0];
                const text = pageText.ok && firstPage !== undefined ? firstPage.text : "";
                sections.push({ kind: section.kind, page: section.page, heading: section.heading, excerpt: text.slice(0, excerptChars) });
            }
            return { ok: true, error: "", code: ref.entry.code, mpn: ref.entry.mpn, pages: digest.scanned, sections, notes };
        },
    });
    ctx.tools.register({
        name: DS_LIST_TOOL,
        description: "列出本地数据手册缓存：编号、型号、品牌、大小、抓取时间与来源，附缓存目录与总占用。传 remove 或 olderThanDays 时顺带清理——不做自动过期，删多少由人决定。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                remove: { type: "array", items: { type: "string" }, description: "要删的编号（C25137 或 lcsc:C25137）；先看不传参数的列表。" },
                olderThanDays: { type: "number", description: "删掉超过这么多天没再抓过的条目；不给表示不按时间删。" },
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
                    totalBytes: { type: "number" },
                    entries: { type: "array", items: entryView },
                    removed: {
                        type: "array",
                        items: {
                            type: "object",
                            additionalProperties: false,
                            properties: { code: { type: "string" }, bytes: { type: "number" } },
                            required: ["code", "bytes"],
                        },
                    },
                    freedBytes: { type: "number" },
                    notes: { type: "array", items: { type: "string" } },
                },
                required: ["ok", "error", "cacheDir", "totalBytes", "entries", "removed", "freedBytes", "notes"],
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
                if (result.removed.length > 0) {
                    lines.push("已清理 " + String(result.removed.length) + " 份，释放 " + String(Math.round(result.freedBytes / 1024)) + " KB：" + result.removed.map((item) => item.code).join("、"));
                }
                for (const note of result.notes)
                    lines.push("  ! " + note);
                return [{ type: "text", text: lines.join("\n") }];
            },
        },
        timeoutMs: 30_000,
        isConcurrencySafe: () => true,
        execute: async (rawArgs) => {
            const env = process.env;
            const cacheDir = cacheDirOf(env);
            const args = rawArgs ?? {};
            try {
                const removed = [];
                const notes = [];
                let freedBytes = 0;
                if (Array.isArray(args.remove) || typeof args.olderThanDays === "number") {
                    const pruned = pruneDatasheets(cacheDir, {
                        ...(Array.isArray(args.remove) ? { remove: args.remove } : {}),
                        ...(typeof args.olderThanDays === "number" ? { olderThanDays: args.olderThanDays } : {}),
                    });
                    removed.push(...pruned.removed);
                    freedBytes = pruned.bytes;
                    notes.push(...pruned.notes);
                }
                const listing = listDatasheets(cacheDir);
                return { ok: true, error: "", cacheDir, totalBytes: listing.totalBytes, entries: listing.entries.map(view), removed, freedBytes, notes };
            }
            catch (error) {
                return {
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                    cacheDir,
                    totalBytes: 0,
                    entries: [],
                    removed: [],
                    freedBytes: 0,
                    notes: [],
                };
            }
        },
    });
    ctx.tools.register({
        name: DS_SEARCH_TOOL,
        description: "按型号、参数或立创编号搜器件：回编号、型号、品牌、库存、到手价与阶梯价、手册地址。立创的公开搜索接口不需要登录；结果按查询缓存 24 小时。接口不给封装字段时如实留空，不用型号猜。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                query: { type: "string", description: "搜索关键词：型号（STM32F103C8T6）、参数（0603 100nF 50V）或立创编号（C8734）。" },
                limit: { type: "number", description: "返回条数，默认 10，最多 50。" },
                page: { type: "number", description: "第几页，从 1 开始。" },
                refresh: { type: "boolean", description: "跳过本地缓存，重新联网。" },
            },
            required: ["query"],
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    ok: { type: "boolean" },
                    error: { type: "string" },
                    query: { type: "string" },
                    total: { type: "number" },
                    cached: { type: "boolean" },
                    hits: {
                        type: "array",
                        items: {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                                code: { type: "string" },
                                mpn: { type: "string" },
                                brand: { type: "string" },
                                packageName: { type: "string" },
                                stock: { type: "number" },
                                minBuy: { type: "number" },
                                priceUsd: { type: "number" },
                                ladder: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        additionalProperties: false,
                                        properties: { qty: { type: "number" }, priceUsd: { type: "number" } },
                                        required: ["qty", "priceUsd"],
                                    },
                                },
                                category: { type: "string" },
                                datasheetUrl: { type: "string" },
                                inStock: { type: "boolean" },
                            },
                            required: [
                                "code",
                                "mpn",
                                "brand",
                                "packageName",
                                "stock",
                                "minBuy",
                                "priceUsd",
                                "ladder",
                                "category",
                                "datasheetUrl",
                                "inStock",
                            ],
                        },
                    },
                    notes: { type: "array", items: { type: "string" } },
                },
                required: ["ok", "error", "query", "total", "cached", "hits", "notes"],
            },
            render: (_args, value) => {
                const result = value;
                if (!result.ok)
                    return [{ type: "text", text: "搜索失败：" + result.error }];
                const lines = [
                    "「" + result.query + "」共 " + String(result.total) + " 条匹配" + (result.cached ? "（来自本地缓存）" : ""),
                ];
                for (const hit of result.hits) {
                    const money = hit.priceUsd > 0 ? "$" + hit.priceUsd.toFixed(4) : "无报价";
                    const pkg = hit.packageName === "" ? "" : " · " + hit.packageName;
                    lines.push("  " + hit.code + " · " + hit.mpn + (hit.brand === "" ? "" : " · " + hit.brand) + pkg +
                        " · 库存 " + String(hit.stock) + " · " + money + (hit.minBuy > 1 ? "（起订 " + String(hit.minBuy) + "）" : ""));
                }
                for (const note of result.notes)
                    lines.push("· " + note);
                return [{ type: "text", text: lines.join("\\n") }];
            },
        },
        timeoutMs: 40_000,
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const env = process.env;
            const query = typeof args?.query === "string" ? args.query : "";
            const offline = (env["DSH_STM32_OFFLINE"] ?? "").trim() === "1";
            if (offline) {
                return { ok: false, error: "离线模式（DSH_STM32_OFFLINE=1）下不能搜索：这是联网查询", query, total: 0, cached: false, hits: [], notes: [] };
            }
            const result = await searchParts(query, {
                ...(typeof args?.limit === "number" ? { limit: args.limit } : {}),
                ...(typeof args?.page === "number" ? { page: args.page } : {}),
                ...(args?.refresh === true ? { noCache: true } : {}),
                cacheFile: searchCachePath(env),
                signal: exec.signal,
            });
            const notes = [...result.notes];
            if (result.hits.length > 0 && result.hits.every((hit) => hit.packageName === "")) {
                notes.push("接口没给封装字段：封装要去商品页或手册确认，别按型号猜。");
            }
            return { ...result, notes };
        },
    });
}
