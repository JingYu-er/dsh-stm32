/**
 * facts 获取自动化：SVD（结构）与 RM（语义载体）的取得与降级。
 *
 * SVD 上游取证（2026-11-07，GitHub API 实测）：github.com/modm-io/cmsis-svd-stm32，
 * default_branch=main、261★、未归档、pushed_at=2026-07-09。布局 <族小写>/<LINE>.svd，
 * 例如 stm32c0/STM32C031.svd（API contents 实测：C0 6 份、F1 5 份、L4 16 份、H5 10 份，命名同规则）。
 * 本机 D:/JingYu/STM32/cmsis-svd-stm32 的 origin 就是该仓。
 *
 * 为什么 SVD 不锁 sha256：本机旧快照（e79021a）与 main 当前内容对同名文件已经漂移
 * （STM32C031.svd 两边字节不同），上游每次 "Update STM32 SVD files" 都可能改。
 * 这里用 minBytes + markers 认「是不是 SVD」，把**实际取到**的 sha256 记进 facts.sources：
 * 可追溯，但不作为失败条件。
 *
 * RM 通道（两条，都不猜）：
 *   · 本机 PDF：--rm-pdf <路径>，只哈希登记，不解析（语义抽取是下一项工作）。
 *   · 显式 URL：--rm-url <https 直链>，下载后按 %PDF 特征校验。
 * 不手搓「RM 号 → st.com 长 slug」表：实测 rm0490 长 slug 直链 200（11.5 MB application/pdf）、
 * 短链 rm0490.pdf 404 —— slug 含整篇标题，只能人从官网页面拿，写死进插件就是失真快照。
 * 语义仍来自人工抽取的 rm-facts JSON（{doc, items}）；拿不到就 semantics=0，
 * facts.needs 说明缺什么，工具层（flash 门禁/describeFacts）自动走只读降级。
 *
 * 联网禁止：opts.allowNetwork=false 或环境变量 DSH_STM32_OFFLINE=1 时只走本地，
 * 本地也没有 → 明确失败并把试过的路径写进 attempts。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fetchOne } from "./fetch.js";
import { acquireRmViaSitemap, acquireRmViaStmcu } from "./rm-sources.js";
import { factsRoot, partToFamilyLine } from "./facts.js";
/** SVD 上游仓库与引用（实测见文件头）。 */
export const SVD_REPO = "modm-io/cmsis-svd-stm32";
export const SVD_REF = "main";
/** facts 关注的寄存器（RM/SVD 交叉验证启动与调试门禁就用这三个）。 */
export const FACTS_REGISTERS = ["FLASH_OPTR", "FLASH_ACR", "FLASH_SECR"];
function nodeText(node, tag) {
    const m = node.match(new RegExp("<" + tag + ">([^<]*)</" + tag + ">"));
    const value = m?.[1] ?? "";
    return value.replace(/\s+/gu, " ").trim();
}
/** 从 SVD XML 抽 FLASH_OPTR / FLASH_ACR / FLASH_SECR 的字段结构（含枚举）。 */
export function parseSvdStructure(xml, registers = FACTS_REGISTERS) {
    const result = {};
    for (const m of xml.matchAll(/<register>([\s\S]*?)<\/register>/g)) {
        const reg = m?.[1] ?? "";
        const name = nodeText(reg, "name");
        if (!registers.includes(name))
            continue;
        const fields = [];
        for (const fm of reg.matchAll(/<field>([\s\S]*?)<\/field>/g)) {
            const f = fm?.[1] ?? "";
            const enums = [];
            for (const em of f.matchAll(/<enumeratedValue>([\s\S]*?)<\/enumeratedValue>/g)) {
                const ebody = em?.[1] ?? "";
                enums.push({ value: nodeText(ebody, "value"), description: nodeText(ebody, "description") });
            }
            fields.push({
                name: nodeText(f, "name"),
                bitOffset: Number(nodeText(f, "bitOffset")),
                bitWidth: Number(nodeText(f, "bitWidth")),
                description: nodeText(f, "description"),
                enums,
            });
        }
        fields.sort((a, b) => a.bitOffset - b.bitOffset);
        result[name] = { description: nodeText(reg, "description"), fields };
    }
    return result;
}
function sha256(buf) {
    return createHash("sha256").update(buf).digest("hex");
}
/** SVD 的候选下载 URL，顺序 = 优先级（同 cmsis-sources 的实测结论：jsDelivr 最稳，raw 兜底）。 */
export function svdSourceUrls(relFile, repo = SVD_REPO, ref = SVD_REF) {
    return [
        "https://fastly.jsdelivr.net/gh/" + repo + "@" + ref + "/" + relFile,
        "https://cdn.jsdelivr.net/gh/" + repo + "@" + ref + "/" + relFile,
        "https://raw.githubusercontent.com/" + repo + "/" + ref + "/" + relFile,
        "https://ghproxy.net/https://raw.githubusercontent.com/" + repo + "/" + ref + "/" + relFile,
    ];
}
/** 取一份 SVD：显式路径 → 本地仓库根 → 下载缓存 →（允许时）网络下载。 */
export async function acquireSvd(part, o = {}) {
    const attempts = [];
    const fail = (error) => ({
        ok: false, file: "", source: "", url: "", sha256: "", bytes: 0, attempts, error, structure: {},
    });
    const target = partToFamilyLine(part);
    if (target === null)
        return fail("认不出型号：" + part);
    const rel = target.family + "/" + target.line + ".svd";
    const env = o.env ?? process.env;
    const cacheDir = o.cacheDir ?? path.join(factsRoot(env), "svd");
    const allowNetwork = o.allowNetwork ?? (env.DSH_STM32_OFFLINE ?? "").trim() !== "1";
    const candidates = [];
    if (o.svdPath !== undefined && o.svdPath !== "")
        candidates.push(path.resolve(o.svdPath));
    for (const root of o.svdRoots ?? [])
        candidates.push(path.join(root, rel));
    candidates.push(path.join(cacheDir, rel));
    for (const cand of candidates) {
        if (!fs.existsSync(cand)) {
            attempts.push(cand + " → 不存在");
            continue;
        }
        const buf = fs.readFileSync(cand);
        const structure = parseSvdStructure(buf.toString("utf8"));
        if (Object.keys(structure).length === 0) {
            attempts.push(cand + " → 找到了但没解析出 " + FACTS_REGISTERS.join("/") + "（不是预期内容）");
            return fail("本地 SVD 内容对不上：" + cand);
        }
        return { ok: true, file: cand, source: "local", url: "", sha256: sha256(buf), bytes: buf.byteLength, attempts, error: "", structure };
    }
    if (!allowNetwork)
        return fail("本地没有该 SVD，且联网被禁（DSH_STM32_OFFLINE）");
    const outcome = await fetchOne({
        path: rel,
        urls: svdSourceUrls(rel),
        minBytes: o.minBytes ?? 50_000,
        // markers 认「是不是 SVD」而不是「是不是某个版本」：上游会漂移，见文件头。
        markers: ["<device", "<cpu>"],
    }, cacheDir, { fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs ?? 240_000, signal: o.signal });
    for (const a of outcome.attempts)
        attempts.push(a);
    if (!outcome.ok)
        return fail(outcome.error);
    const svdFile = path.join(cacheDir, outcome.path === "" ? rel : outcome.path);
    const buf = fs.readFileSync(svdFile);
    const structure = parseSvdStructure(buf.toString("utf8"));
    if (Object.keys(structure).length === 0)
        return fail("下载内容解析不出 " + FACTS_REGISTERS.join("/") + "：" + outcome.url);
    return {
        ok: true,
        file: svdFile,
        source: "remote",
        url: outcome.url,
        sha256: sha256(buf),
        bytes: buf.byteLength,
        attempts,
        error: "",
        structure,
    };
}
/** RM 载体：rm-facts（语义）+ 本机 PDF 或显式 URL（只登记哈希，不解析）。 */
export async function acquireRm(o = {}) {
    const env = o.env ?? process.env;
    const items = [];
    const sources = [];
    const notes = [];
    let doc = null;
    let error = "";
    if (o.rmFactsPath !== undefined && o.rmFactsPath !== "") {
        try {
            const raw = fs.readFileSync(path.resolve(o.rmFactsPath), "utf8");
            const parsed = JSON.parse(raw);
            doc = parsed.doc ?? null;
            if (Array.isArray(parsed.items))
                items.push(...parsed.items);
            sources.push({ kind: "rm-facts", file: path.basename(o.rmFactsPath), sha256: sha256(Buffer.from(raw, "utf8")), path: path.resolve(o.rmFactsPath) });
        }
        catch (e) {
            error = "rm-facts 读不了（" + o.rmFactsPath + "）：" + (e instanceof Error ? e.message : String(e));
            notes.push(error);
        }
    }
    if (o.rmPdfPath !== undefined && o.rmPdfPath !== "") {
        const p = path.resolve(o.rmPdfPath);
        if (fs.existsSync(p)) {
            const buf = fs.readFileSync(p);
            if (!buf.subarray(0, 5).toString("latin1").startsWith("%PDF")) {
                notes.push("rm-pdf 不是 PDF 头（" + p + "），只登记不采信");
            }
            sources.push({ kind: "rm-pdf", file: path.basename(p), sha256: sha256(buf), bytes: buf.byteLength, path: p });
        }
        else {
            notes.push("rm-pdf 不存在：" + p);
        }
    }
    if (o.rmUrl !== undefined && o.rmUrl !== "") {
        const allowNetwork = o.allowNetwork ?? (env.DSH_STM32_OFFLINE ?? "").trim() !== "1";
        if (!allowNetwork) {
            notes.push("rm-url 被跳过（离线模式）：" + o.rmUrl);
        }
        else {
            const name = path.basename(new URL(o.rmUrl).pathname);
            const destRoot = o.cacheDir ?? path.join(factsRoot(env), "rm");
            const outcome = await fetchOne({ path: name, urls: [o.rmUrl], minBytes: 200_000, markers: ["%PDF"] }, destRoot, { fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs ?? 240_000, signal: o.signal, stallMs: 20_000, minBytesPerSec: 4096 });
            if (outcome.ok) {
                const buf = fs.readFileSync(path.join(destRoot, outcome.path));
                sources.push({ kind: "rm-pdf", file: name, sha256: sha256(buf), bytes: buf.byteLength, url: outcome.url });
                notes.push("RM PDF 已缓存：" + path.join(destRoot, outcome.path) + "（" + String(buf.byteLength) + " B）");
            }
            else {
                error = error === "" ? "RM 下载失败：" + outcome.error : error + "；RM 下载失败：" + outcome.error;
                notes.push("RM PDF 下载失败（语义不受影响）：" + outcome.error);
            }
        }
    }
    return { items, doc, sources, notes, error };
}
/**
 * 完整链路：SVD（本地→下载）+ RM（rm-facts/PDF/URL，可缺）→ facts.json。
 * SVD 拿不到 = 失败（结构是 facts 的底线）；RM 拿不到 = 降级（semantics=0 + needs 说明）。
 */
export async function buildFacts(o) {
    const env = o.env ?? process.env;
    const target = partToFamilyLine(o.part);
    const upper = o.part.trim().toUpperCase();
    if (target === null) {
        return { ok: false, message: "认不出型号：" + o.part, file: "", part: upper, family: "", line: "", structure: {}, registers: "", semantics: 0, needs: ["型号解析失败"], notes: [], sources: [] };
    }
    const svd = await acquireSvd(upper, o);
    if (!svd.ok) {
        return { ok: false, message: svd.error, file: "", part: upper, family: target.family, line: target.line, structure: {}, registers: "", semantics: 0, needs: ["SVD 没拿到（本地与下载都失败）"], notes: svd.attempts, sources: [] };
    }
    const rm = await acquireRm(o);
    const notes = [...rm.notes];
    // 自动载体通道：rm-facts 只给语义，PDF 本体（含哈希/页码定位）由这里补齐。
    const rmAuto = o.rmAuto ?? "auto";
    const allowNet = o.allowNetwork ?? ((o.env ?? process.env).DSH_STM32_OFFLINE ?? "").trim() !== "1";
    let acquired = null;
    if (rmAuto !== "off" && allowNet) {
        const hasPdfSource = rm.sources.some((s) => s.kind === "rm-pdf");
        if (!hasPdfSource) {
            const channelOpts = { fetchImpl: o.fetchImpl, cacheDir: o.rmCacheDir, env, timeoutMs: o.timeoutMs, signal: o.signal, minGapMs: o.minGapMs };
            const order = rmAuto === "sitemap" ? ["sitemap"] : rmAuto === "stmcu" ? ["stmcu"] : ["sitemap", "stmcu"];
            for (const ch of order) {
                const attempt = ch === "sitemap"
                    ? await acquireRmViaSitemap(target.family, target.line, channelOpts)
                    : await acquireRmViaStmcu(target.family, target.line, channelOpts);
                if (attempt.ok) {
                    acquired = attempt;
                    break;
                }
                notes.push("RM 自动通道 " + ch + " 失败：" + attempt.error);
                if (attempt.url !== "")
                    acquired = attempt; // 失败但也带着哈希/覆盖信息，留给 notes
            }
        }
    }
    const pdfSource = acquired !== null && acquired.ok
        ? { kind: "rm-pdf", doc: acquired.docId, file: acquired.file.split(/[\\/]/).pop() ?? "", sha256: acquired.sha256, bytes: acquired.bytes, url: acquired.url, origin: "auto:" + acquired.channel, coveredLines: Object.keys(acquired.coverage) }
        : null;
    // 语义按线分级：声明过的适用范围（--rm-lines 优先，其次 rm-facts 的 doc.lines）
    // 不含目标线时一律拒收，宁可降级只读也不把别的线的 RM 结论套过来。
    const declaredLines = (o.rmLines !== undefined && o.rmLines.length > 0 ? o.rmLines : [])
        .concat(typeof rm.doc?.lines === "string" || Array.isArray(rm.doc?.lines)
        ? (Array.isArray(rm.doc?.lines) ? rm.doc?.lines : [String(rm.doc?.lines)]).map((x) => String(x).toUpperCase())
        : []);
    const uniqueLines = [...new Set(declaredLines)];
    let items = rm.items;
    const needs = [];
    if (items.length > 0 && uniqueLines.length > 0 && !uniqueLines.includes(target.line)) {
        needs.push("rm-facts 声明只覆盖 " + uniqueLines.join("/") + "，不含 " + target.line + "：语义 " + String(items.length) + " 条已拒收，需要 " + target.line + " 自己的 RM 抽取");
        items = [];
    }
    else if (items.length > 0 && uniqueLines.length === 0) {
        notes.push("提醒：rm-facts 没声明适用线（doc.lines 或 --rm-lines），本次按目标线 " + target.line + " 原样采信；抽取语义的人要自己核对 RM 是否覆盖该线");
    }
    if (items.length === 0 && rm.items.length === 0) {
        needs.push("本线只有结构、语义未核实：需要 " + target.line + " 的 RM 手册与 rm-facts 抽取（SVD 只给结构，不给组合规则/流程/引脚）");
    }
    const outDir = o.outDir !== undefined && o.outDir !== "" ? path.resolve(o.outDir) : path.join(factsRoot(env), target.family, target.line);
    const outFile = path.join(outDir, "facts.json");
    const facts = {
        schema: 2,
        part: upper,
        family: "STM32" + target.family.slice(5).toUpperCase(),
        line: target.line,
        generatedAt: new Date().toISOString(),
        sources: [
            { kind: "svd", file: path.basename(svd.file), sha256: svd.sha256, bytes: svd.bytes, path: svd.file, origin: svd.source === "remote" ? svd.url : "local" },
            ...rm.sources,
            ...(pdfSource === null ? [] : [pdfSource]),
        ],
        registers: svd.structure,
        semantics: items,
        ...(rm.doc === null ? {} : { rmDoc: rm.doc }),
        ...(uniqueLines.length === 0 ? {} : { rmAppliesTo: uniqueLines }),
        needs,
    };
    if (o.write !== false) {
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(outFile, JSON.stringify(facts, null, 1), "utf8");
    }
    const regs = Object.entries(svd.structure).map(([k, v]) => k + "(" + String(v.fields.length) + ")").join(" ");
    const svdHow = svd.source === "remote" ? "下载（" + svd.url + "）" : "本地（" + svd.file + "）";
    return {
        ok: true,
        message: "facts -> " + outFile + "（SVD 来自" + svdHow + "；语义 " + String(items.length) + " 条）",
        file: outFile,
        part: upper,
        family: facts.family,
        line: target.line,
        structure: svd.structure,
        registers: regs,
        semantics: items.length,
        needs,
        notes,
        sources: facts.sources,
    };
}
