/**
 * 把 web-api 的分发器接到宿主的 webServer 服务上。
 *
 * 这一层刻意只做四件事：拼 URL、读请求体、调分发给、写 JSON 响应。
 * 参数校验、配置读写、探测、安装调度全在 web-api.ts 里，那边可以离线单测。
 *
 * 注册是"锦上添花"的层：宿主没组合 webServer 服务（例如纯 CLI 组合）时直接跳过，
 * 工具与斜杠命令照常可用。
 */
import { handleWebApi, WEB_API_PATHS } from "./web-api.js";
/** 请求体上限：面板最大的请求是配置对象，1 MB 已经非常宽松。 */
const MAX_BODY_BYTES = 1_000_000;
function readBody(request) {
    return new Promise((resolve) => {
        let text = "";
        let done = false;
        const finish = (value) => {
            if (done)
                return;
            done = true;
            resolve(value);
        };
        if (typeof request.on !== "function") {
            finish("");
            return;
        }
        request.on("data", (chunk) => {
            text += String(chunk);
            if (text.length > MAX_BODY_BYTES) {
                text = text.slice(0, MAX_BODY_BYTES);
                finish(text);
            }
        });
        request.on("end", () => finish(text));
        request.on("error", () => finish(text));
    });
}
function parseUrl(rawUrl) {
    const url = typeof rawUrl === "string" && rawUrl !== "" ? rawUrl : "/";
    try {
        const parsed = new URL(url, "http://127.0.0.1");
        const query = {};
        parsed.searchParams.forEach((value, key) => {
            query[key] = value;
        });
        return { path: parsed.pathname, query };
    }
    catch {
        return { path: url, query: {} };
    }
}
function send(response, status, body) {
    const text = JSON.stringify(body);
    if (typeof response.writeHead === "function") {
        response.writeHead(status, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "content-length": Buffer.byteLength(text),
        });
    }
    if (typeof response.end === "function")
        response.end(text);
}
export function registerWebRoutes(ctx) {
    if (typeof ctx.inject !== "function")
        return;
    ctx.inject(["webServer"], (scope) => {
        const server = scope.get("webServer");
        const subprocess = scope.get("subprocess");
        if (server === undefined || server === null || typeof server.register !== "function")
            return;
        if (subprocess === undefined || subprocess === null)
            return;
        const deps = { subprocess };
        for (const path of WEB_API_PATHS) {
            server.register({
                kind: "exact",
                path,
                handler: async (request, response) => {
                    const url = parseUrl(request?.url);
                    const body = request?.method === "GET" ? "" : await readBody(request);
                    try {
                        const result = await handleWebApi({
                            method: String(request?.method ?? "GET"),
                            path: url.path,
                            query: url.query,
                            body,
                            deps,
                        });
                        send(response, result.status, result.body);
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        send(response, 500, { ok: false, error: "面板接口异常：" + message });
                    }
                },
            });
        }
    });
}
