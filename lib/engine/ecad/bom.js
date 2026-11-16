/**
 * BOM 与元件成本（S156）。
 *
 * 数据源是 tscircuit 的 `circuit.json`：`source_component` 给位号、值、立创编号候选，
 * `cad_component.model_step_url` 给「真库名/真封装名」。价格来自缓存（`price.ts`），
 * 拿不到价就空着并计入「未定价」，不按型号猜价。
 *
 * 立创的 `supplier_part_numbers.jlcpcb` 是多选一：第一个是主选，后面是替代料。
 * BOM 只按主选计价，替代料在「替代」列里列出来，便于缺货时换料。
 */
import { readFileSync } from "node:fs";
const EMPTY_REPORT = {
    ok: false,
    error: "",
    circuitFile: "",
    lines: [],
    componentCount: 0,
    priced: 0,
    pricedComponents: 0,
    partsUsd: 0,
    missingLcsc: 0,
    notes: [],
};
const MODEL_LIB = /kicad-mod-cache\.tscircuit\.com\/[\d.]*\/?([^/]+)\/([^/.]+)\.(?:step|wrl)/iu;
const VALUE_KEYS = [
    "display_resistance",
    "display_capacitance",
    "display_inductance",
    "display_value",
    "display_name",
    "display_current",
    "display_voltage",
    "display_frequency",
];
function textOf(value) {
    return typeof value === "string" ? value.trim() : "";
}
function numberOrNull(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
/** 元件值的展示文本：优先 tscircuit 给的 `display_*`，否则退到型号。 */
function valueOf(component) {
    for (const key of VALUE_KEYS) {
        const text = textOf(component[key]);
        if (text !== "")
            return text;
    }
    const mpn = textOf(component["manufacturer_part_number"]);
    if (mpn !== "")
        return mpn;
    // tscircuit 的类型名形如 `simple_connector`：去掉前缀当兜底值，比空白好认。
    return textOf(component["ftype"]).replace(/^simple_/u, "");
}
function lcscCodes(component) {
    const supplier = component["supplier_part_numbers"];
    const list = supplier?.jlcpcb;
    if (!Array.isArray(list))
        return [];
    return list.map((item) => textOf(item)).filter((code) => /^C\d+$/u.test(code));
}
function refCompare(a, b) {
    const split = (ref) => {
        const found = /^([A-Za-z_]+)(\d+)$/u.exec(ref);
        return found === null ? [ref, 0] : [found[1] ?? ref, Number(found[2] ?? 0)];
    };
    const [prefixA, numA] = split(a);
    const [prefixB, numB] = split(b);
    return prefixA === prefixB ? numA - numB : prefixA.localeCompare(prefixB);
}
/** 解析 `circuit.json`，按「主选编号 + 值 + 封装」分组。 */
export function buildBom(circuitJsonText, circuitFile = "") {
    let parsed;
    try {
        parsed = JSON.parse(circuitJsonText);
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { ...EMPTY_REPORT, circuitFile, error: "读不懂 circuit.json：" + reason };
    }
    if (!Array.isArray(parsed)) {
        return { ...EMPTY_REPORT, circuitFile, error: "circuit.json 不是数组，应该是一串元件与走线" };
    }
    const elements = parsed;
    const footprints = new Map();
    for (const element of elements) {
        if (element.type !== "cad_component")
            continue;
        const model = textOf(element["model_step_url"]);
        const found = MODEL_LIB.exec(model);
        const sourceId = textOf(element["source_component_id"]);
        if (found === null || sourceId === "")
            continue;
        footprints.set(sourceId, (found[1] ?? "") + ":" + (found[2] ?? ""));
    }
    const groups = new Map();
    let componentCount = 0;
    for (const element of elements) {
        if (element.type !== "source_component")
            continue;
        const ref = textOf(element["name"]);
        if (ref === "")
            continue;
        componentCount += 1;
        const codes = lcscCodes(element);
        const lcsc = codes[0] ?? "";
        const alternatives = codes.slice(1);
        const footprint = footprints.get(textOf(element["source_component_id"])) ?? "";
        const value = valueOf(element);
        const key = lcsc + "|" + value + "|" + footprint;
        const group = groups.get(key) ?? { refs: [], value, footprint, lcsc, alternatives };
        group.refs.push(ref);
        for (const code of alternatives) {
            if (!group.alternatives.includes(code))
                group.alternatives.push(code);
        }
        groups.set(key, group);
    }
    const lines = [...groups.entries()]
        .map(([key, group]) => {
        const refs = group.refs.slice().sort(refCompare);
        return {
            key,
            refs,
            qty: refs.length,
            value: group.value,
            footprint: group.footprint,
            lcsc: group.lcsc,
            alternatives: group.alternatives,
            unitPriceUsd: null,
            stock: null,
            mpn: "",
            brand: "",
            subtotalUsd: null,
        };
    })
        .sort((a, b) => refCompare(a.refs[0] ?? "", b.refs[0] ?? ""));
    const missingLcsc = lines.filter((line) => line.lcsc === "").length;
    const notes = [];
    if (missingLcsc > 0)
        notes.push(missingLcsc + " 行没有立创编号：这些行按位号照列，价格留空");
    if (lines.some((line) => line.alternatives.length > 0))
        notes.push("有替代料的行只按主选计价，替代编号列在表里");
    return {
        ...EMPTY_REPORT,
        ok: true,
        circuitFile,
        lines,
        componentCount,
        missingLcsc,
        notes,
    };
}
/** 把缓存里的报价贴到 BOM 上，重算合计。 */
export function applyQuotes(report, quotes) {
    const lines = report.lines.map((line) => {
        const quote = quotes[line.lcsc];
        if (quote === undefined)
            return line;
        return {
            ...line,
            unitPriceUsd: quote.priceUsd,
            stock: quote.stock,
            mpn: quote.mpn,
            brand: quote.brand,
            subtotalUsd: Math.round(quote.priceUsd * line.qty * 10000) / 10000,
        };
    });
    const priced = lines.filter((line) => line.unitPriceUsd !== null);
    const partsUsd = Math.round(priced.reduce((sum, line) => sum + (line.subtotalUsd ?? 0), 0) * 10000) / 10000;
    const unpriced = lines.length - priced.length;
    const notes = report.notes.slice();
    if (unpriced > 0 && priced.length > 0)
        notes.push(unpriced + " 行还没有价格：点「查价」联网取，或稍后再看");
    return {
        ...report,
        lines,
        priced: priced.length,
        pricedComponents: priced.reduce((sum, line) => sum + line.qty, 0),
        partsUsd,
        notes,
    };
}
/** 读工程里的 `circuit.json`（与 kicad 目录同级）并出 BOM。 */
export function readBom(circuitFile) {
    try {
        return buildBom(readFileSync(circuitFile, "utf8"), circuitFile);
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { ...EMPTY_REPORT, circuitFile, error: "读不到 circuit.json：" + reason };
    }
}
const money = (value) => (value === null ? "" : value.toFixed(4));
export function renderBomMarkdown(report) {
    const rows = [
        "| 位号 | 数量 | 值 | 封装 | 立创 | 替代 | 单价 USD | 小计 USD | 库存 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ...report.lines.map((line) => "| " +
            [
                line.refs.join(", "),
                String(line.qty),
                line.value,
                line.footprint,
                line.lcsc,
                line.alternatives.join(", "),
                money(line.unitPriceUsd),
                money(line.subtotalUsd),
                line.stock === null ? "" : String(line.stock),
            ].join(" | ") +
            " |"),
        "",
        "共 " + String(report.lines.length) + " 行 / " + String(report.componentCount) + " 个元件；元件成本 $" + report.partsUsd.toFixed(4) +
            "（" + String(report.priced) + "/" + String(report.lines.length) + " 行有价）",
    ];
    if (report.notes.length > 0)
        rows.push("", ...report.notes.map((note) => "- " + note));
    return rows.join("\n") + "\n";
}
function csvCell(value) {
    return /[",\n]/u.test(value) ? '"' + value.replace(/"/gu, '""') + '"' : value;
}
/** 嘉立创贴片 BOM 的常用列顺序；价格列放最后，方便直接导入表格。 */
export function renderBomCsv(report) {
    const header = ["Comment", "Designator", "Footprint", "LCSC Part #", "Quantity", "MPN", "Brand", "Unit Price USD", "Subtotal USD", "Alternatives"];
    const rows = report.lines.map((line) => [
        line.value,
        line.refs.join(","),
        line.footprint,
        line.lcsc,
        String(line.qty),
        line.mpn,
        line.brand,
        money(line.unitPriceUsd),
        money(line.subtotalUsd),
        line.alternatives.join(","),
    ]);
    return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
