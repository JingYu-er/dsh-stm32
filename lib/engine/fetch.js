/**
 * 极简下载器：按候选 URL 逐个试，成功一个就停。
 *
 * 为什么要有"候选 URL"：同一份 ST 头文件，raw.githubusercontent.com 在有些网络里会超时、
 * jsDelivr 在另一些网络里被墙——写死一个源就是把插件的可用性押在某条线路上。
 * 实测（2026-10，本机）：raw.githubusercontent 超时、github.com/codeload/api 正常、
 * fastly.jsdelivr.net 与 ghproxy.net 正常 —— 所以候选顺序是 jsDelivr → raw → ghproxy。
 *
 * 只用全局 fetch（Node 18+ 自带），不引运行时依赖；测试可注入 fetchImpl。
 */
import fs from "node:fs";
import path from "node:path";
const HTML_HEAD_BYTES = 512;
function looksLikeHtml(buffer) {
    const head = buffer.subarray(0, HTML_HEAD_BYTES).toString("utf8").trimStart().toLowerCase();
    return head.startsWith("<!doctype html") || head.startsWith("<html");
}
/** 下载单个文件（多候选）。失败不抛，把原因写进 outcome —— 上层要一次性报告所有失败。 */
export async function fetchOne(target, destRoot, options = {}) {
    const attempts = [];
    const minBytes = target.minBytes ?? 16;
    const dest = path.join(destRoot, target.path);
    const fetchImpl = options.fetchImpl ?? fetch;
    for (const url of target.urls) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
        const onAbort = () => controller.abort();
        if (options.signal !== undefined) {
            if (options.signal.aborted)
                controller.abort();
            else
                options.signal.addEventListener("abort", onAbort, { once: true });
        }
        try {
            const response = await fetchImpl(url, { signal: controller.signal, redirect: "follow" });
            if (!response.ok) {
                attempts.push(url + " → HTTP " + String(response.status));
                continue;
            }
            const buffer = Buffer.from(await response.arrayBuffer());
            if (buffer.byteLength < minBytes) {
                attempts.push(url + " → 只有 " + String(buffer.byteLength) + " 字节（< " + String(minBytes) + "，不像真文件）");
                continue;
            }
            if (looksLikeHtml(buffer)) {
                attempts.push(url + " → 拿回来是网页（代理拦截或 404 页），不是文件");
                continue;
            }
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            const part = dest + ".part-" + String(process.pid);
            fs.writeFileSync(part, buffer);
            fs.rmSync(dest, { force: true });
            fs.renameSync(part, dest);
            return { path: target.path, ok: true, bytes: buffer.byteLength, url, error: "", attempts };
        }
        catch (error) {
            const name = error instanceof Error ? error.name : "";
            const message = error instanceof Error ? error.message : String(error);
            attempts.push(url + " → " + (name === "AbortError" ? "超时/取消（" + String(options.timeoutMs ?? 30_000) + " ms）" : message));
        }
        finally {
            clearTimeout(timer);
            options.signal?.removeEventListener?.("abort", onAbort);
        }
    }
    return { path: target.path, ok: false, bytes: 0, url: "", error: "所有源都没下下来：" + attempts.join("；"), attempts };
}
/** 并发下载一批（默认 3 路）。一个失败不影响其它，最后一次性汇总。 */
export async function fetchAll(targets, destRoot, options = {}) {
    const results = [];
    const total = targets.length;
    const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, total === 0 ? 1 : total));
    let next = 0;
    let done = 0;
    const worker = async () => {
        for (;;) {
            const index = next;
            next += 1;
            const target = targets[index];
            if (target === undefined)
                return;
            const outcome = await fetchOne(target, destRoot, options);
            results.push(outcome);
            done += 1;
            options.onProgress?.(outcome, done, total);
        }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    const ok = results.filter((item) => item.ok).length;
    return {
        results,
        ok,
        failed: results.length - ok,
        bytes: results.reduce((sum, item) => sum + item.bytes, 0),
    };
}
