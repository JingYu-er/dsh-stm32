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
import { factsRoot, partToFamilyLine, readFactsFor } from "./facts.js";
import { loadRmTopics } from "../data/rm-topics.js";
import { defaultPdfTextBridge } from "./rm-text.js";
import { extractRmFacts, assembleRmFacts } from "./rm-extract.js";
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
/**
 * 从 SVD XML 抽 FLASH 外设的寄存器结构（含枚举）。
 *
 * 收集策略两级（2026-11-07 实测教训）：
 *   A. 首选按外设收：<peripheral> 的 name==FLASH 下的**全部** <register>。
 *      modm 的寄存器命名逐族不同——C0 带前缀（FLASH_ACR/FLASH_OPTR/FLASH_SECR）、
 *      F1 不带（ACR/OBR/CR…）；写死名字清单等于拿 C0 约定套全族，F1 会解析出 0 寄存器
 *      （自愈真链路就是这么炸的）。名字清单只是兜底口径，不是主口径。
 *   B. 退回全局按 FACTS_REGISTERS 名单过滤：微型片段 SVD 可能没有 peripheral 包装
 *      （单测夹具就是那形状）。
 */
export function parseSvdStructure(xml, registers = FACTS_REGISTERS) {
    const result = {};
    const collectFrom = (chunk, filterByName) => {
        for (const m of chunk.matchAll(/<register>([\s\S]*?)<\/register>/g)) {
            const reg = m?.[1] ?? "";
            const name = nodeText(reg, "name");
            if (name === "")
                continue;
            if (filterByName && !registers.includes(name))
                continue;
            const fields = [];
            for (const fm of reg.matchAll(/<field>([\s\S]*?)<\/field>/g)) {
                const fl = fm?.[1] ?? "";
                const enums = [];
                for (const em of fl.matchAll(/<enumeratedValue>([\s\S]*?)<\/enumeratedValue>/g)) {
                    const ebody = em?.[1] ?? "";
                    enums.push({ value: nodeText(ebody, "value"), description: nodeText(ebody, "description") });
                }
                fields.push({
                    name: nodeText(fl, "name"),
                    bitOffset: Number(nodeText(fl, "bitOffset")),
                    bitWidth: Number(nodeText(fl, "bitWidth")),
                    description: nodeText(fl, "description"),
                    enums,
                });
            }
            fields.sort((a, b) => a.bitOffset - b.bitOffset);
            result[name] = { description: nodeText(reg, "description"), fields };
        }
    };
    for (const pm of xml.matchAll(/<peripheral>([\s\S]*?)<\/peripheral>/g)) {
        const block = pm?.[1] ?? "";
        if (nodeText(block, "name").toUpperCase() !== "FLASH")
            continue;
        collectFrom(block, false);
    }
    if (Object.keys(result).length === 0)
        collectFrom(xml, true);
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
        ? { kind: "rm-pdf", doc: acquired.docId, file: acquired.file.split(/[\\/]/).pop() ?? "", path: acquired.file, sha256: acquired.sha256, bytes: acquired.bytes, url: acquired.url, origin: "auto:" + acquired.channel, coveredLines: Object.keys(acquired.coverage) }
        : null;
    // spec 自动抽取：人没喂 rm-facts 而且这颗芯片有主题清单时，用可用的载体 PDF 自动抽取。
    // 载体两种都要认：双通道自动下的，和显式 --rm-pdf/--rm-url 给的（用户本地手册场景）。
    const explicitPdfSource = rm.sources.find((s) => s.kind === "rm-pdf" && typeof s.path === "string" && s.path !== "");
    const explicitPdfPath = typeof explicitPdfSource?.path === "string" ? explicitPdfSource.path : "";
    const specPdf = acquired !== null && acquired.ok ? acquired.file : explicitPdfPath;
    if (rm.items.length === 0 && specPdf !== "" && fs.existsSync(specPdf) && o.autoSpec !== false) {
        const loaded = loadRmTopics(target.family, target.line, factsRoot(env));
        if (loaded.hasSpec) {
            const pageSet = new Set();
            for (const tp of loaded.topics)
                for (let n = Math.max(1, tp.page - 3); n <= tp.page + 3; n += 1)
                    pageSet.add(n);
            const bridge = o.pdfTextBridge ?? defaultPdfTextBridge;
            const got = await bridge(specPdf, [...pageSet]);
            if (got.ok) {
                // SVD 交叉要 spec 里每条线的结构；目标线现成，其余线懒取（取不到记「该线 SVD 没取到」，不炸）
                const svdByLine = { [target.line]: svd.structure };
                for (const l of loaded.lines) {
                    if (svdByLine[l] !== undefined)
                        continue;
                    const one = await acquireSvd(l, o);
                    if (one.ok)
                        svdByLine[l] = one.structure;
                }
                const rep = extractRmFacts({ family: target.family, lines: loaded.lines, topics: loaded.topics }, got.pages, svdByLine);
                const asm = assembleRmFacts({ id: loaded.docId !== "" ? loaded.docId : (acquired?.docId ?? "RM?"), source: "auto:rm-topics", origins: loaded.origins }, rep.items);
                rm.items.push(...asm.items);
                if (rm.doc === null)
                    rm.doc = asm.doc;
                notes.push("spec 自动抽取：" + String(rep.items.length) + " 条采信 / " + String(rep.rejected.length) + " 条拒收（清单 " + loaded.origins.join(" + ") + "）");
                for (const x of rep.rejected)
                    notes.push("  REJECT " + x.id + "：" + x.reason);
            }
            else {
                notes.push("有 rm-topics 清单但 pymupdf 桥不可用：" + got.error + "（" + got.tried.join("；") + "）");
            }
        }
    }
    // 语义按线分级：声明过的适用范围（--rm-lines 优先，其次 rm-facts 的 doc.lines）
    // 不含目标线时一律拒收，宁可降级只读也不把别的线的 RM 结论套过来。
    const declaredLines = (o.rmLines !== undefined && o.rmLines.length > 0 ? o.rmLines : [])
        .concat(typeof rm.doc?.lines === "string" || Array.isArray(rm.doc?.lines)
        ? (Array.isArray(rm.doc?.lines) ? rm.doc?.lines : [String(rm.doc?.lines)]).map((x) => String(x).toUpperCase())
        : []);
    const uniqueLines = [...new Set(declaredLines)];
    // 采信口径：条目级 appliesTo（自动抽取产出）优先，其次包级 doc.lines，都没有就整批按人声明走。
    let items = rm.items.filter((it) => {
        const ap = Array.isArray(it.appliesTo) ? it.appliesTo.map((x) => String(x).toUpperCase()) : [];
        if (ap.length > 0)
            return ap.includes(target.line);
        // 老式条目（无 appliesTo）：仍受包级 doc.lines/--rm-lines 约束——修一个刚引入的回归：
        // 若这里直接放行，「doc.lines 不含目标线」的整批门禁对混合数据就失效了。
        return uniqueLines.length === 0 || uniqueLines.includes(target.line);
    });
    const needs = [];
    const wholeBatchRejected = rm.items.length > 0 && items.length === 0;
    if (wholeBatchRejected && uniqueLines.length > 0 && !uniqueLines.includes(target.line)) {
        needs.push("rm-facts 声明只覆盖 " + uniqueLines.join("/") + "，不含 " + target.line + "：语义 " + String(rm.items.length) + " 条已拒收，需要 " + target.line + " 自己的 RM 抽取");
        items = [];
    }
    else if (wholeBatchRejected) {
        needs.push("rm-facts 里没有任何条目声明适用于 " + target.line + "（appliesTo 逐条筛完为空）：需要这条线的 RM 抽取");
        items = [];
    }
    else if (rm.items.length > 0 && uniqueLines.length === 0 && !rm.items.some((it) => Array.isArray(it.appliesTo))) {
        notes.push("提醒：rm-facts 没声明适用线（doc.lines/--rm-lines/条目 appliesTo），本次按目标线 " + target.line + " 原样采信；抽取语义的人要自己核对 RM 是否覆盖该线");
    }
    if (items.length === 0 && rm.items.length === 0) {
        if (acquired !== null && acquired.ok) {
            // 载体已经到位：要么这颗芯片没主题清单（不拦烧录，路径可反查），要么有清单但机检没过。
            const hasSpecHere = loadRmTopics(target.family, target.line, factsRoot(env)).hasSpec;
            needs.push(hasSpecHere
                ? target.line + " 有 rm-topics 清单但机检没过/桥不可用：逐条原因见 notes；修好清单或 PDF 改版前，本线按只读对待"
                : "这颗芯片没有 rm-topics 主题清单：只有结构、无语义（不拦烧录）；RM 已缓存在本地，调试遇怪行为可按 sources.rm-pdf 的路径反查原文");
        }
        else {
            needs.push("本线只有结构、语义未核实：需要 " + target.line + " 的 RM 手册与 rm-facts 抽取（SVD 只给结构，不给组合规则/流程/引脚）");
        }
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
/**
 * 自愈读：查到就信，查不到/有清单但没核过就当场补一次书（SVD+RM 载体+结构，
 * 有 rm-topics 还带语义抽取），再读一遍返回。用户决定（2026-11-07）：
 * 各族一律自动准备资产、无需人为干预；门禁严格与否由「这颗芯片有没有主题清单」决定。
 *
 * 何时重建：facts 不存在，或有清单但没 verified（常见于用户刚放了芯片级 spec）。
 * 已经 verified 的直接返回，不反复下载。构建失败不炸——返回失败后的现状，
 * 由调用方（flash 门禁/风险行）按三态处理。
 */
export async function ensureFacts(part, env = process.env, o = {}) {
    const first = readFactsFor(part, env);
    const needsBuild = !first.found || (first.hasSpec && !first.verified);
    if (!needsBuild)
        return { summary: first, built: { attempted: false, ok: true, message: "" } };
    const rep = await buildFacts({
        part,
        env,
        ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
        ...(o.allowNetwork === undefined ? {} : { allowNetwork: o.allowNetwork }),
        ...(o.signal === undefined ? {} : { signal: o.signal }),
        ...(o.fetchImpl === undefined ? {} : { fetchImpl: o.fetchImpl }),
        ...(o.pdfTextBridge === undefined ? {} : { pdfTextBridge: o.pdfTextBridge }),
        ...(o.svdPath === undefined ? {} : { svdPath: o.svdPath }),
        ...(o.svdRoots === undefined ? {} : { svdRoots: o.svdRoots }),
        ...(o.rmPdfPath === undefined ? {} : { rmPdfPath: o.rmPdfPath }),
    });
    const after = readFactsFor(part, env);
    return { summary: after, built: { attempted: true, ok: rep.ok, message: rep.message } };
}
