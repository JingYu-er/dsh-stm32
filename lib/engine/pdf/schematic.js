const NUMERIC_REF = /^(?:R|C|L|D|Q|U|J|SW|Y|X|FB|TP|F|K)\d{1,4}$/u;
// 型号/阻值：不含下划线（下划线多半是网络名），且必须含数字（NRST 这种纯字母是标签）
const VALUE = /^(?=[A-Za-z0-9./+-]{4,40}$)(?=[^\s]*\d)[A-Za-z0-9][A-Za-z0-9./+-]*$/u;
const LABEL = /^[A-Z][A-Z0-9_]{1,24}$/u;
/** 按基线（y 中心）把词聚成行：PDF 里同一行的 y 只差零点几 pt。 */
function clusterLines(words, page) {
    const buckets = [];
    for (const word of [...words].sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0))) {
        const center = (word.y0 + word.y1) / 2;
        const last = buckets[buckets.length - 1];
        if (last !== undefined && Math.abs(last.y - center) <= 2.4) {
            last.parts.push(word);
            last.y = (last.y * (last.parts.length - 1) + center) / last.parts.length;
            if (word.x0 < last.x0)
                last.x0 = word.x0;
            continue;
        }
        buckets.push({ page, y: center, x0: word.x0, parts: [word] });
    }
    return buckets;
}
export function readPdfSchematicWords(pages) {
    const components = [];
    const labels = new Map();
    let words = 0;
    const notes = [];
    for (const page of pages) {
        words += page.words.length;
        for (const line of clusterLines(page.words, page.page)) {
            const sorted = [...line.parts]
                .map((part) => ({ ...part, text: part.text.trim() }))
                .filter((part) => part.text !== "")
                .sort((a, b) => a.x0 - b.x0);
            for (let index = 0; index < sorted.length; index += 1) {
                const current = sorted[index];
                if (current === undefined)
                    continue;
                const token = current.text;
                // 只认常见前缀的位号：KiCad 原理图里 BGA 的球号（A1、B1、AC0）也长这样，
                // 用「前缀白名单」把它们排掉，比按字母个数猜靠谱。
                if (NUMERIC_REF.test(token)) {
                    // 型号/值必须是紧贴右侧的同一个词（≤14 pt）：同一行可能有别的元件，
                    // 取「这行后面第一个像型号的词」会把隔壁器件的型号安错了——宁可空着。
                    const next = sorted[index + 1];
                    const right = next !== undefined && next.x0 - current.x1 <= 14 && VALUE.test(next.text) && !NUMERIC_REF.test(next.text)
                        ? next.text
                        : "";
                    // KiCad 把型号/值放在位号正下方：同一列、下移 2–16 pt 的那个词才是它的值。
                    const below = page.words.find((word) => {
                        const text = word.text.trim();
                        return (Math.abs(word.x0 - current.x0) <= 4 &&
                            word.y0 - current.y1 >= 1 &&
                            word.y0 - current.y1 <= 16 &&
                            VALUE.test(text) &&
                            !NUMERIC_REF.test(text));
                    });
                    const value = right !== "" ? right : (below === undefined ? "" : below.text.trim());
                    if (!components.some((item) => item.ref === token)) {
                        components.push({ ref: token, value, page: page.page });
                    }
                    continue;
                }
                if (LABEL.test(token) && token.length >= 3 && !NUMERIC_REF.test(token)) {
                    const existing = labels.get(token);
                    if (existing === undefined)
                        labels.set(token, { name: token, pages: [page.page], count: 1 });
                    else {
                        existing.count += 1;
                        if (!existing.pages.includes(page.page))
                            existing.pages.push(page.page);
                    }
                }
            }
        }
    }
    if (words === 0)
        notes.push("这张 PDF 没有可取的文字（描边字形）：先用 kicad-cli sch export pdf --default-font Arial 重新导出");
    if (components.length === 0 && words > 0)
        notes.push("没有认出位号：原理图 PDF 的文字可能是字形轮廓，或元件被画成了图片");
    notes.push("PDF 只给清单：连通性要从 KiCad 工程读（stm32_sch_read），线条与引脚号本身不含「谁连谁」");
    components.sort((a, b) => a.ref.localeCompare(b.ref, "en", { numeric: true }));
    const labelList = [...labels.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return {
        ok: components.length > 0 || labelList.length > 0,
        error: components.length === 0 && labelList.length === 0 ? notes[0] ?? "没有认出元件或标签" : "",
        file: "",
        pages: pages.length,
        components,
        labels: labelList,
        words,
        notes,
    };
}
