/**
 * 从 pdftotext -bbox 的词矩形里还原二维表（S118）。
 *
 * 为什么不用 -layout 文本按空格切：版面上「同一列的空白」会被跨列长单元格、图形线条
 * 和单元格内换行打断，切出来的常是半张表。改用词框坐标后，行按 y 聚、列按「同行里
 * 词与词之间的大间隙」聚——行与列都是几何量，不受空格排布影响。
 *
 * 局限（写在文档里，不藏在代码里）：合并单元格会被展开成「左上格有字、其余为空」；
 * 单元格内换行会变成两行文字落进同一列。两种情况都会写进 warnings。
 */
const WORD = /<word[^>]*xMin="([0-9.]+)"[^>]*yMin="([0-9.]+)"[^>]*xMax="([0-9.]+)"[^>]*yMax="([0-9.]+)"[^>]*>([^<]*)<\/word>/gu;
const PAGE = /<page[^>]*width="([0-9.]+)"[^>]*height="([0-9.]+)"[^>]*>/gu;
function decodeXml(text) {
    return text
        .replace(/&lt;/gu, "<")
        .replace(/&gt;/gu, ">")
        .replace(/&quot;/gu, "\"")
        .replace(/&apos;/gu, "'")
        .replace(/&amp;/gu, "&");
}
/** 解析 -bbox 输出：每页的宽度、高度与词框。 */
export function parseBboxXml(xml) {
    const pageStarts = [...xml.matchAll(PAGE)];
    const pages = [];
    for (const [index, match] of pageStarts.entries()) {
        const from = match.index ?? 0;
        const to = pageStarts[index + 1]?.index ?? xml.length;
        const chunk = xml.slice(from, to);
        const words = [];
        for (const word of chunk.matchAll(WORD)) {
            words.push({
                x0: Number(word[1]),
                y0: Number(word[2]),
                x1: Number(word[3]),
                y1: Number(word[4]),
                text: decodeXml(word[5] ?? ""),
            });
        }
        pages.push({ width: Number(match[1]), height: Number(match[2]), words });
    }
    return pages;
}
/** 按 y 聚行：同一行内的词基线相差不超过 tol。 */
function clusterRows(words, tol = 3.2) {
    const sorted = [...words].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    const rows = [];
    for (const word of sorted) {
        const last = rows[rows.length - 1];
        if (last !== undefined && Math.abs(last.y - word.y0) <= tol) {
            last.words.push(word);
            continue;
        }
        rows.push({ y: word.y0, words: [word] });
    }
    for (const row of rows)
        row.words.sort((a, b) => a.x0 - b.x0);
    return rows;
}
/**
 * 列分隔点：同一行里词与词之间的间隙 ≥ gapPt 算候选，跨行聚位置；
 * 在足够多行都出现的候选才是列边界。
 *
 * 按间隙而不是按词左边界：一个单元格里的多个词也各自左对齐，
 * 按左边界聚会把一个格子拆成很多列。
 */
function headerRow(rows) {
    return rows.find((row) => row.words.length >= 3 && row.words.some((word) => /[A-Za-z]{2,}/u.test(word.text)));
}
/** 表头那一行的间隙直接给出列边界：表头通常只占一行，词与词之间就是列的分界。 */
function headerSeparators(row, gapPt = 6) {
    const mids = [];
    for (let index = 1; index < row.words.length; index += 1) {
        const previous = row.words[index - 1];
        const current = row.words[index];
        if (previous === undefined || current === undefined)
            continue;
        if (current.x0 - previous.x1 >= gapPt)
            mids.push((previous.x1 + current.x0) / 2);
    }
    return mids;
}
function columnSeparators(rows, gapPt = 8) {
    const perRow = [];
    for (const row of rows) {
        const mids = [];
        for (let index = 1; index < row.words.length; index += 1) {
            const previous = row.words[index - 1];
            const current = row.words[index];
            if (previous === undefined || current === undefined)
                continue;
            if (current.x0 - previous.x1 >= gapPt)
                mids.push((previous.x1 + current.x0) / 2);
        }
        if (mids.length > 0)
            perRow.push(mids);
    }
    const clusters = [];
    for (const mids of perRow) {
        for (const mid of mids) {
            const hit = clusters.find((cluster) => Math.abs(cluster.x - mid) <= 8);
            if (hit === undefined)
                clusters.push({ x: mid, support: 1 });
            else {
                hit.x = (hit.x * hit.support + mid) / (hit.support + 1);
                hit.support += 1;
            }
        }
    }
    const need = Math.max(2, Math.ceil(rows.length * 0.3));
    const body = clusters
        .filter((cluster) => cluster.support >= need)
        .map((cluster) => cluster.x)
        .sort((a, b) => a - b);
    const header = headerRow(rows);
    const base = header === undefined ? [] : headerSeparators(header);
    const merged = [...base];
    for (const x of body) {
        if (!merged.some((existing) => Math.abs(existing - x) <= 30))
            merged.push(x);
    }
    return merged.sort((a, b) => a - b);
}
/** 竖排单元格（「Main / flash memory」）会被切成两行：把只有一格有字的行并进下一行同列。 */
function mergeVertical(cells) {
    const dense = (row) => row !== undefined && row.filter((cell) => cell !== "").length >= 2;
    const out = [];
    for (const [position, row] of cells.entries()) {
        const filled = row.filter((cell) => cell !== "");
        if (filled.length === 1) {
            const index = row.findIndex((cell) => cell !== "");
            const cell = row[index] ?? "";
            // 往上找：上一行够密就并进去（竖排单元格的下半截）；否则看下一行（上半截先出现的情形）。
            const previous = out[out.length - 1];
            if (previous !== undefined && dense(previous)) {
                previous[index] = (previous[index] === "" ? cell : previous[index] + " " + cell).trim();
                continue;
            }
            const next = cells[position + 1];
            if (next !== undefined && dense(next)) {
                next[index] = (next[index] === "" ? cell : cell + " " + next[index]).trim();
                continue;
            }
        }
        out.push([...row]);
    }
    return out;
}
/** 按分隔点把一行的词分进格子：词中心落在哪一段就归哪一格。 */
function assign(row, separators) {
    const buckets = separators.map(() => []);
    const last = [];
    buckets.push(last);
    for (const word of row.words) {
        const center = (word.x0 + word.x1) / 2;
        let index = separators.length;
        for (const [position, x] of separators.entries()) {
            if (center < x) {
                index = position;
                break;
            }
        }
        buckets[index]?.push(word.text);
    }
    return buckets.map((parts) => parts.join(" ").trim());
}
/**
 * 切表。要求至少 minRows 行、minColumns 列；表块之间由标题行或长正文行分隔。
 * page 只记录来源页。
 */
export function extractTablesFromWords(page, options = {}) {
    const pageNumber = options.page ?? 0;
    const minRows = Math.max(2, options.minRows ?? 3);
    const minColumns = Math.max(2, options.minColumns ?? 2);
    const rows = clusterRows(page.words);
    const tables = [];
    let block = [];
    let blockTitle = "";
    let pendingTitle = "";
    const flush = () => {
        const usable = block.filter((row) => row.words.length > 0);
        block = [];
        if (usable.length < minRows)
            return;
        const separators = columnSeparators(usable);
        if (separators.length + 1 < minColumns)
            return;
        const cells = mergeVertical(usable.map((row) => assign(row, separators)));
        const filled = cells.filter((row) => row.filter((cell) => cell !== "").length >= 2);
        if (filled.length < minRows)
            return;
        const warnings = [];
        const empties = cells.reduce((count, row) => count + row.filter((cell) => cell === "").length, 0);
        if (empties > 0)
            warnings.push("有 " + String(empties) + " 个空单元格：合并单元格会被展开");
        // 「像数字」指单元格以数字（或 ≤ ≥ ± 之类的量号）开头；RM0490 这种型号不算。
        const looksNumeric = (cell) => /^[≤≥±<>~\s]*[0-9]/u.test(cell.trim());
        const numeric = cells.filter((row) => row.some((cell) => looksNumeric(cell))).length;
        const flat = cells.flat().filter((cell) => cell !== "");
        const averageLength = flat.reduce((sum, cell) => sum + cell.length, 0) / Math.max(1, flat.length);
        const longRatio = flat.filter((cell) => cell.length > 30).length / Math.max(1, flat.length);
        // 正文段落与编号步骤也会被切成「两列」：句子长、几乎没有数字。这类块直接丢掉，不冒充表格。
        if (longRatio >= 0.5)
            return;
        if (numeric / cells.length < 0.3)
            return;
        if (averageLength > 35 && numeric / cells.length < 0.5)
            return;
        if (numeric / cells.length < 0.5)
            warnings.push("多数行不含数字：这块可能是文字段落而不是参数表");
        tables.push({
            title: blockTitle !== ""
                ? blockTitle
                : (pageNumber === 0 ? "" : "第 " + String(pageNumber) + " 页表 ") + String(tables.length + 1),
            page: pageNumber,
            rows: cells.length,
            columns: cells[0] ?? [],
            cells,
            confidence: warnings.length === 0 && separators.length + 1 >= 3 ? "high" : "medium",
            warnings,
        });
    };
    for (const row of rows) {
        const text = row.words.map((word) => word.text).join(" ");
        const looksLikeCaption = /^(Table|Figure)\s+[0-9]+/iu.test(text);
        // 正文段落与表格行的区别在间距：表格的列之间一定有大间隙，句子内部的词间距很小。
        let maxGap = 0;
        for (let index = 1; index < row.words.length; index += 1) {
            const previous = row.words[index - 1];
            const current = row.words[index];
            if (previous === undefined || current === undefined)
                continue;
            maxGap = Math.max(maxGap, current.x0 - previous.x1);
        }
        const looksLikeProse = (row.words.length >= 3 && maxGap < 14) || (row.words.length <= 2 && text.length > 24);
        if (looksLikeCaption || looksLikeProse) {
            flush();
            if (looksLikeCaption)
                pendingTitle = text.replace(/\s+[0-9]{1,4}$/u, "").trim();
            continue;
        }
        if (block.length === 0 && pendingTitle !== "") {
            blockTitle = pendingTitle;
            pendingTitle = "";
        }
        block.push(row);
    }
    flush();
    return tables;
}
