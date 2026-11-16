/**
 * 器件搜索（S163）：立创的公开搜索接口。
 *
 * 打的是前端自己在用的那个接口（`wmsc.lcsc.com/ftps/wm/search/third`），不需要登录：
 * 搜关键词回产品列表，含编号、型号、品牌、封装、库存、阶梯价、手册地址。
 *
 * 这一层只做三件事：拼请求、把回包削成稳定的形状、按查询缓存（默认 24 小时）。
 * 「该选哪个」不在这里判断——参数、温度等级、寿命都得人看手册。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export const LCSC_SEARCH_URL = "https://wmsc.lcsc.com/ftps/wm/search/third";
export function searchCachePath(env) {
    const home = env.DSH_STM32_HOME;
    return home !== undefined && home !== "" ? join(home, "part-search.json") : join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh-stm32", "part-search.json");
}
function readCache(file) {
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        if (parsed.version === 1 && typeof parsed.entries === "object" && parsed.entries !== null) {
            return { version: 1, entries: parsed.entries };
        }
    }
    catch {
        // 缓存坏了就当没有：搜索是只读操作，重下一份即可。
    }
    return { version: 1, entries: {} };
}
function writeCache(file, cache) {
    try {
        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, JSON.stringify(cache), "utf8");
    }
    catch {
        // 写不了缓存不影响搜索本身。
    }
}
function num(value) {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
function str(value) {
    return typeof value === "string" ? value : "";
}
/** 把一页回包削成 `PartHit[]`；字段名跟接口走，缺的下沉成空串/0。 */
export function parseProductList(payload) {
    const result = payload?.result;
    const list = Array.isArray(result?.productList) ? result.productList : [];
    const hits = [];
    for (const item of list) {
        const code = str(item["productCode"]);
        if (!/^C\d+$/u.test(code))
            continue;
        const rawLadder = Array.isArray(item["productPriceList"]) ? item["productPriceList"] : [];
        const ladder = [];
        for (const step of rawLadder) {
            const qty = num(step["ladder"]);
            const priceUsd = num(step["usdPrice"]);
            if (qty > 0 && priceUsd > 0)
                ladder.push({ qty, priceUsd });
        }
        ladder.sort((a, b) => a.qty - b.qty);
        const stock = num(item["stockNumber"]);
        hits.push({
            code,
            mpn: str(item["productModel"]),
            brand: str(item["brandNameEn"]) || str(item["lcOrderBrandNameEn"]),
            packageName: str(item["encapStandard"]),
            stock,
            minBuy: num(item["minBuyNumber"]),
            priceUsd: ladder.length > 0 ? ladder[0].priceUsd : 0,
            ladder,
            category: str(item["thirdWmCatalogNameEn"]) || str(item["wmCatalogNameEn"]),
            datasheetUrl: str(item["pdfUrl"]),
            inStock: stock > 0,
        });
    }
    return { total: num(result?.totalCount), hits };
}
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** 搜一次；命中缓存直接回，不回网络。 */
export async function searchParts(query, options = {}) {
    const keyword = query.trim();
    const limit = Math.min(Math.max(Math.round(options.limit ?? 10), 1), 50);
    const page = Math.max(Math.round(options.page ?? 1), 1);
    const empty = { ok: false, error: "", query: keyword, total: 0, hits: [], cached: false, notes: [] };
    if (keyword === "")
        return { ...empty, error: "搜索关键词不能为空：给型号、参数或立创编号，例如 `STM32F103C8T6`、`0603 100nF`" };
    const file = options.cacheFile ?? searchCachePath(process.env);
    const key = String(limit) + "|" + String(page) + "|" + keyword.toLowerCase();
    const now = options.now ?? (() => Date.now());
    if (options.noCache !== true && existsSync(file)) {
        const cache = readCache(file);
        const hit = cache.entries[key];
        if (hit !== undefined && now() - hit.at < (options.ttlMs ?? DEFAULT_TTL_MS)) {
            return { ok: true, error: "", query: keyword, total: hit.total, hits: hit.hits, cached: true, notes: ["这一页来自本地缓存（24 小时内有效）"] };
        }
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort);
    try {
        const response = await fetchImpl(LCSC_SEARCH_URL, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                accept: "application/json",
                origin: "https://www.lcsc.com",
                referer: "https://www.lcsc.com/",
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) dsh-stm32",
            },
            body: JSON.stringify({ keyword, currentPage: page, pageSize: limit }),
            signal: controller.signal,
        });
        if (!response.ok)
            return { ...empty, error: "立创搜索接口回了 HTTP " + String(response.status) + "：稍后再试，或换成更具体的关键词" };
        const payload = (await response.json());
        const code = num(payload.code);
        if (code !== 200)
            return { ...empty, error: "立创搜索接口回了错误码 " + String(code) + "：" + str(payload.msg) };
        const parsed = parseProductList(payload);
        const notes = [];
        if (parsed.hits.length === 0)
            notes.push("没有匹配结果：试试去掉封装或电压，只留型号主体");
        if (parsed.total > 0)
            notes.push("共 " + String(parsed.total) + " 条匹配，这里只给前 " + String(parsed.hits.length) + " 条");
        const cache = readCache(file);
        cache.entries[key] = { at: now(), total: parsed.total, hits: parsed.hits };
        const keys = Object.keys(cache.entries);
        if (keys.length > 200) {
            for (const stale of keys.slice(0, keys.length - 200))
                delete cache.entries[stale];
        }
        writeCache(file, cache);
        return { ok: true, error: "", query: keyword, total: parsed.total, hits: parsed.hits, cached: false, notes };
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { ...empty, error: controller.signal.aborted ? "搜索超时或已取消：" + reason : "搜索失败：" + reason };
    }
    finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
    }
}
