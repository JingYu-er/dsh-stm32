/**
 * 立创商城的元件价格（S156）。
 *
 * 价格只出现在商品详情页的结构化数据里（`<script type="application/ld+json">` 的
 * `Product.offers`）：`price` / `priceCurrency` / `inventoryLevel`。这里把它单独缓存成
 * `~/.dsh-stm32/prices.json`，与手册缓存分开——手册是几十 MB 的 PDF、价格是几十字节的数字，
 * 生命周期也不一样（价格 7 天过期，手册长期有效）。
 *
 * 不联网也能用：BOM 先读缓存，缺价的行明确标出来，不猜价格。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { lcscDetailUrl } from "./lcsc.js";
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_GAP_MS = 800;
/** 价格缓存文件：`DSH_STM32_HOME/prices.json` 优先，否则 `~/.dsh-stm32/prices.json`。 */
export function priceCachePath(env = process.env) {
    const home = (env["DSH_STM32_HOME"] ?? "").trim();
    const base = home !== "" ? home : join(env["USERPROFILE"]?.trim() || homedir(), ".dsh-stm32");
    return join(base, "prices.json");
}
export function readPriceCache(path) {
    if (!existsSync(path))
        return { version: 1, quotes: {} };
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (typeof parsed !== "object" || parsed === null)
            return { version: 1, quotes: {} };
        const quotes = parsed.quotes;
        if (typeof quotes !== "object" || quotes === null)
            return { version: 1, quotes: {} };
        const out = {};
        for (const [code, value] of Object.entries(quotes)) {
            const quote = value;
            if (typeof quote.priceUsd !== "number" || !Number.isFinite(quote.priceUsd))
                continue;
            out[code] = {
                priceUsd: quote.priceUsd,
                currency: typeof quote.currency === "string" ? quote.currency : "USD",
                stock: typeof quote.stock === "number" ? quote.stock : null,
                mpn: typeof quote.mpn === "string" ? quote.mpn : "",
                brand: typeof quote.brand === "string" ? quote.brand : "",
                fetchedAt: typeof quote.fetchedAt === "string" ? quote.fetchedAt : "",
            };
        }
        return { version: 1, quotes: out };
    }
    catch {
        return { version: 1, quotes: {} };
    }
}
export function writePriceCache(path, cache) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache, null, 2) + "\n", "utf8");
}
/** 从商品页的 JSON-LD 里取报价；拿不到数字就回 null，不按标题猜。 */
export function parseLcscPrice(html) {
    const blocks = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gu) ?? [];
    for (const block of blocks) {
        const json = block.replace(/^<script[^>]*>/u, "").replace(/<\/script>$/u, "");
        let parsed;
        try {
            parsed = JSON.parse(json);
        }
        catch {
            continue;
        }
        const product = parsed;
        if (product["@type"] !== "Product")
            continue;
        const offers = product.offers;
        const price = typeof offers?.price === "number" ? offers.price : Number(offers?.price);
        if (!Number.isFinite(price) || price <= 0)
            continue;
        const brand = product.brand;
        return {
            priceUsd: price,
            currency: typeof offers?.priceCurrency === "string" ? offers.priceCurrency : "USD",
            stock: typeof offers?.inventoryLevel === "number" ? offers.inventoryLevel : null,
            mpn: typeof product.mpn === "string" ? product.mpn : "",
            brand: typeof brand?.name === "string" ? brand.name : "",
        };
    }
    return null;
}
function isFresh(quote, nowMs, ttlMs) {
    if (quote === undefined)
        return false;
    const at = Date.parse(quote.fetchedAt);
    if (!Number.isFinite(at))
        return false;
    return nowMs - at < ttlMs;
}
async function fetchPrice(code, options) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
    const signals = [controller.signal];
    if (options.signal !== undefined)
        signals.push(options.signal);
    try {
        const response = await fetchImpl(lcscDetailUrl(code), {
            signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
            redirect: "follow",
            headers: { "user-agent": "dsh-stm32 bom price fetcher (lcsc product page)" },
        });
        if (!response.ok)
            return null;
        return parseLcscPrice(await response.text());
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * 取一批编号的报价：缓存里新鲜的直接用，其余按需联网。
 *
 * 只写成功的结果；失败的编号在返回值里列出来，不写负缓存（价格随时会变，下次还该试）。
 */
export async function ensurePrices(codes, options = {}) {
    const path = priceCachePath(options.env);
    const cache = readPriceCache(path);
    const nowMs = (options.now ?? Date.now)();
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const gapMs = options.gapMs ?? DEFAULT_GAP_MS;
    const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const fetched = [];
    const failed = [];
    const unique = [...new Set(codes.filter((code) => code !== ""))];
    let waited = false;
    for (const code of unique) {
        if (isFresh(cache.quotes[code], nowMs, ttlMs))
            continue;
        if (waited)
            await sleep(gapMs);
        waited = true;
        const quote = await fetchPrice(code, options);
        if (quote === null) {
            failed.push(code);
            continue;
        }
        cache.quotes[code] = { ...quote, fetchedAt: new Date(nowMs).toISOString() };
        fetched.push(code);
    }
    if (fetched.length > 0)
        writePriceCache(path, cache);
    return { quotes: cache.quotes, fetched, failed };
}
