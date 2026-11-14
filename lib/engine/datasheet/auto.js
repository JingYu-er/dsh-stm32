/**
 * 工程级的数据手册补齐（S120）。
 *
 * 判据只有一个：circuit 源码里出现过 `footprint="jlcpcb:C…"`，这颗器件就该有手册。
 * 构建成功后自动补齐；面板与工具也能显式触发同一段逻辑，避免两条路径各写一份。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseJlcpcbFootprints } from "../ecad/jlcpcb.js";
import { planEcadWorkspace } from "../ecad/tsci.js";
import { resolveProjectLayout } from "../project-layout.js";
import { datasheetCacheDir, ensureDatasheet, isLcscCode, readIndex } from "./store.js";
/** 本工程 circuit 源码里出现的全部立创编号（去重、排序）。 */
export function projectJlcpcbCodes(projectDir) {
    const layout = resolveProjectLayout(projectDir);
    const workspace = planEcadWorkspace(projectDir, layout.hardwareDir);
    if (!existsSync(workspace.circuitDir))
        return [];
    const found = new Set();
    for (const name of readdirSync(workspace.circuitDir)) {
        if (!name.endsWith(".tsx"))
            continue;
        const parsed = parseJlcpcbFootprints(readFileSync(join(workspace.circuitDir, name), "utf8"));
        for (const item of parsed)
            found.add(item.code);
    }
    return [...found].sort();
}
/** 只看本地：哪些编号已有可用手册、哪些还缺（不联网）。 */
export function datasheetStatus(projectDir, cacheDir = datasheetCacheDir()) {
    const codes = projectJlcpcbCodes(projectDir);
    const index = readIndex(cacheDir);
    const cached = [];
    const missing = [];
    for (const code of codes) {
        if (index.entries[code] !== undefined)
            cached.push(code);
        else
            missing.push(code);
    }
    return { codes, cached, missing };
}
/** 补齐本工程全部器件：串行（同域限速在 store 里），失败不阻断构建。 */
export async function ensureProjectDatasheets(projectDir, options = {}) {
    const cacheDir = options.cacheDir ?? datasheetCacheDir();
    const codes = projectJlcpcbCodes(projectDir);
    const fetched = [];
    const failed = [];
    let cached = 0;
    for (const code of codes) {
        if (!isLcscCode(code))
            continue;
        const result = await ensureDatasheet(code, {
            cacheDir,
            offline: options.offline ?? false,
            refresh: options.refresh ?? false,
            signal: options.signal,
            fetchImpl: options.fetchImpl,
        });
        if (result.ok) {
            if (result.cached ?? false)
                cached += 1;
            else
                fetched.push(code);
        }
        else {
            failed.push({ code, error: result.error ?? "未知错误" });
        }
    }
    return { codes, fetched, cached, failed };
}
