/**
 * 立创商城的商品页解析（S119）。
 *
 * 只有商品详情页是稳定入口：`/datasheet/<编号>.pdf` 返回的是反爬 HTML，
 * 真正的 PDF 在 `datasheet.lcsc.com/datasheet/pdf/<hash>.pdf`，链接写在详情页里。
 * 因此这里做两件事：抓详情页、从页面里取「MPN / 品牌 / 正版 PDF 直链」。
 */
const PDF_URL = /(https:\/\/datasheet\.lcsc\.com\/datasheet\/pdf\/[A-Za-z0-9]+\.pdf)/u;
const MPN = /"mpn"\s*:\s*"([^"]{1,80})"/u;
const BRAND = /"brandName"\s*:\s*"([^"]{1,80})"/u;
const TITLE = /<title>([^<]{1,200})<\/title>/u;
export function lcscDetailUrl(code) {
    return "https://www.lcsc.com/product-detail/" + encodeURIComponent(code) + ".html";
}
function firstMatch(pattern, text) {
    const found = pattern.exec(text);
    return found === null ? "" : (found[1] ?? "").trim();
}
/** 从详情页 HTML 里取元信息；取不到 PDF 直链时返回错误，不猜。 */
export function parseLcscPage(code, html, sourceUrl = lcscDetailUrl(code)) {
    // 页面里的 JSON 会把斜杠转义成 `\/`，先统一回原样，再按同一套正则取字段。
    const text = html.replace(/\\\//gu, "/");
    const pdfUrl = firstMatch(PDF_URL, text);
    if (pdfUrl === "") {
        return { ok: false, error: "详情页里没有数据手册直链：" + sourceUrl + "（可能是页面结构变化，或该商品没有公开手册）" };
    }
    const title = firstMatch(TITLE, text);
    const parts = title.split("|").map((part) => part.trim());
    const mpn = firstMatch(MPN, text) || (parts[0] ?? "");
    const brand = firstMatch(BRAND, text) || (parts.length >= 3 ? (parts[parts.length - 1] ?? "") : "");
    return { ok: true, product: { code, mpn, brand, title, pdfUrl, sourceUrl } };
}
/** 抓详情页并解析。`fetchImpl` 可注入，测试不联网。 */
export async function fetchLcscProduct(code, options = {}) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
    const signals = [controller.signal];
    if (options.signal !== undefined)
        signals.push(options.signal);
    const url = lcscDetailUrl(code);
    try {
        const response = await fetchImpl(url, {
            signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
            redirect: "follow",
            headers: { "user-agent": "dsh-stm32 datasheet fetcher (lcsc product page)" },
        });
        if (!response.ok) {
            return { ok: false, error: "商品页返回 HTTP " + String(response.status) + "：" + url };
        }
        return parseLcscPage(code, await response.text(), url);
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { ok: false, error: "抓商品页失败：" + reason };
    }
    finally {
        clearTimeout(timer);
    }
}
