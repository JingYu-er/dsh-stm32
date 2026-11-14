/**
 * PDF 读取（S117）：把一份 PDF 摊成三种可核对的东西。
 *
 *   1. 元信息   —— pdfinfo：页数、纸张大小、是否加密、是否带文字层；
 *   2. 文字     —— pdftotext（-layout 保版面，-f/-l 限定页）：章节标题、表格、参数都靠它；
 *   3. 页面图像 —— pdftoppm：整页或局部渲染成 PNG，交给视觉读图（曲线、框图、丝印）。
 *
 * 不在这里做的事：把曲线数字化。渲染出来的像素由读图的一方解释，本模块只保证
 * 「给的是真实页面上那一块」，不猜坐标。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCapture } from "../subprocess-runner.js";
function numberFrom(text, key) {
    const match = new RegExp("^" + key + ":\\s*(.+)$", "mu").exec(text);
    return match === null ? "" : (match[1] ?? "").trim();
}
/** 页面文字里的控制字符比例：描边字体导出的 PDF 正文是 \u0001 这类码位。 */
function looksLikeGlyphCodes(text) {
    if (text.trim() === "")
        return true;
    let control = 0;
    let total = 0;
    for (const char of text) {
        total += 1;
        const code = char.codePointAt(0) ?? 0;
        if (code < 0x20 && char !== "\n" && char !== "\r" && char !== "\t")
            control += 1;
    }
    return total > 0 && control / total > 0.2;
}
export async function readPdfInfo(subprocess, tools, file, signal) {
    const blank = {
        ok: false,
        file,
        bytes: 0,
        pages: 0,
        title: "",
        producer: "",
        pageSize: "",
        encrypted: false,
        hasTextLayer: true,
        notes: [],
    };
    if (!existsSync(file))
        return { ...blank, error: "PDF 不存在：" + file };
    const size = statSync(file).size;
    const info = await runCapture(subprocess, {
        argv: [tools.pdfinfo, file],
        timeoutMs: 30_000,
        ...(signal === undefined ? {} : { signal }),
    });
    if (info.exitCode !== 0) {
        return { ...blank, bytes: size, error: "pdfinfo 执行失败：" + (info.stderr.trim() || String(info.exitCode)) };
    }
    const pages = Number(numberFrom(info.stdout, "Pages"));
    const notes = [];
    // 抽查第一页的文字层：只跑一页，避免整本转文本。
    const probe = await runCapture(subprocess, {
        argv: [tools.pdftotext, "-f", "1", "-l", "1", file, "-"],
        timeoutMs: 30_000,
        ...(signal === undefined ? {} : { signal }),
    });
    const hasTextLayer = probe.exitCode === 0 ? !looksLikeGlyphCodes(probe.stdout) : false;
    if (!hasTextLayer)
        notes.push("第一页取不到正常文字：正文可能是描边字形（KiCad 默认 PDF 字体），文字类问题只能按图看");
    return {
        ok: true,
        error: "",
        file,
        bytes: size,
        pages: Number.isFinite(pages) ? pages : 0,
        title: numberFrom(info.stdout, "Title"),
        producer: numberFrom(info.stdout, "Producer"),
        pageSize: numberFrom(info.stdout, "Page size"),
        encrypted: /^Encrypted:\s*yes$/mu.test(info.stdout),
        hasTextLayer,
        notes,
    };
}
export async function extractPdfText(subprocess, tools, file, options = {}, signal) {
    const first = Math.max(1, Math.floor(options.first ?? 1));
    const last = Math.max(first, Math.floor(options.last ?? first));
    const blank = { ok: false, file, first, last, chars: 0, pages: [], notes: [] };
    if (!existsSync(file))
        return { ...blank, error: "PDF 不存在：" + file };
    const argv = [tools.pdftotext];
    if (options.layout !== false)
        argv.push("-layout");
    argv.push("-f", String(first), "-l", String(last), file, "-");
    const out = await runCapture(subprocess, {
        argv,
        timeoutMs: 60_000,
        maxBytes: 8 * 1024 * 1024,
        ...(signal === undefined ? {} : { signal }),
    });
    if (out.exitCode !== 0) {
        return { ...blank, error: "pdftotext 执行失败：" + (out.stderr.trim() || String(out.exitCode)) };
    }
    const raw = out.stdout;
    const notes = [];
    if (looksLikeGlyphCodes(raw))
        notes.push("这一段的文字是字形码（描边字体），读不出可读正文：改用 render 模式看图");
    const pages = [];
    const chunks = raw.split("\f");
    for (const [index, chunk] of chunks.entries()) {
        const page = first + index;
        if (page > last)
            break;
        const text = chunk.replace(/[ \t]+$/gmu, "").trim();
        if (text !== "" || index === 0)
            pages.push({ page, text });
    }
    return { ok: true, error: "", file, first, last, chars: raw.length, pages, notes };
}
/** 图注与目录行：「Figure 14. VREFINT vs. temperature …… 44」。 */
export function listFigures(text, limit = 40) {
    const out = [];
    const seen = new Set();
    for (const line of text.split(/\r?\n/u)) {
        const match = /^\s*(Figure|Table)\s+([0-9]+[a-z]?)\s*[.:]?\s*(.+)$/iu.exec(line);
        if (match === null)
            continue;
        const kind = (match[1] ?? "").toLowerCase();
        if (kind !== "figure")
            continue;
        const number = match[2] ?? "";
        const rest = (match[3] ?? "").replace(/[.…\s]{2,}[0-9]+\s*$/u, "").trim();
        const pageMatch = /\s([0-9]{1,4})\s*$/u.exec(line);
        const page = pageMatch === null ? 0 : Number(pageMatch[1]);
        const key = number + "|" + (rest.slice(0, 24) || "");
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push({ number, title: rest.slice(0, 120), page: Number.isFinite(page) ? page : 0 });
        if (out.length >= limit)
            break;
    }
    return out;
}
function pngSize(file) {
    try {
        const head = readFileSync(file).subarray(0, 33);
        if (head.length < 24)
            return { width: 0, height: 0 };
        return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
    }
    catch {
        return { width: 0, height: 0 };
    }
}
export async function renderPdfPage(subprocess, tools, file, options, signal) {
    const page = Math.max(1, Math.floor(options.page));
    const dpi = Math.min(600, Math.max(72, Math.floor(options.dpi ?? 150)));
    const blank = {
        ok: false,
        file,
        page,
        dpi,
        imageFile: "",
        width: 0,
        height: 0,
        bytes: 0,
        notes: [],
    };
    if (!existsSync(file))
        return { ...blank, error: "PDF 不存在：" + file };
    const dir = options.outDir ?? join(tmpdir(), "dsh-stm32-pdf");
    const stamp = createHash("sha1").update(file).digest("hex").slice(0, 10);
    const prefix = join(dir, stamp + "-p" + String(page) + "-r" + String(dpi));
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    const argv = [tools.pdftoppm, "-f", String(page), "-l", String(page), "-r", String(dpi), "-png", "-singlefile"];
    if (options.crop !== undefined) {
        const c = options.crop;
        argv.push("-x", String(Math.max(0, Math.floor(c.x))), "-y", String(Math.max(0, Math.floor(c.y))));
        argv.push("-W", String(Math.max(1, Math.floor(c.width))), "-H", String(Math.max(1, Math.floor(c.height))));
    }
    argv.push(file, prefix);
    const out = await runCapture(subprocess, {
        argv,
        timeoutMs: 120_000,
        ...(signal === undefined ? {} : { signal }),
    });
    const imageFile = prefix + ".png";
    if (out.exitCode !== 0 || !existsSync(imageFile)) {
        return {
            ...blank,
            error: "pdftoppm 渲染失败：" + (out.stderr.trim() || String(out.exitCode)),
        };
    }
    const { width, height } = pngSize(imageFile);
    return {
        ok: true,
        error: "",
        file,
        page,
        dpi,
        imageFile,
        width,
        height,
        bytes: statSync(imageFile).size,
        notes: options.crop === undefined ? [] : ["已按 crop 裁切：坐标按该 dpi 渲染后的像素计"],
    };
}
