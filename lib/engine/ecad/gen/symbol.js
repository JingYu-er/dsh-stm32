/**
 * 符号生成（S164）：按引脚表算出 `.kicad_sym`。
 *
 * 只做「矩形本体 + 左右两列引脚」这一种画法：它没有刻意美化，但每个引脚的编号、名字、类型都来自调用方给的表，
 * 不替人分配引脚功能，也不猜引脚在芯片哪一侧——表里的顺序就是画出来的顺序（左边自上而下，右边自下而上）。
 *
 * 为什么要它：`stm32_pdf_read` 的 table 模式能从手册抽出引脚表，`stm32_sch_to_ioc` 能从原理图读出连接；
 * 有了这两头，符号本身只是排版，不该靠人手点。
 */
const EMPTY = { ok: false, error: "", text: "", pinCount: 0, bodyWidthMm: 0, bodyHeightMm: 0, notes: [] };
const GRID = 2.54;
function fmt(value) {
    return String(Math.round(value * 1000) / 1000);
}
function text(value) {
    return value.replace(/\\/gu, "/").replace(/"/gu, "'");
}
const KIND_MAP = {
    input: "input",
    output: "output",
    bidirectional: "bidirectional",
    power_in: "power_in",
    passive: "passive",
    unspecified: "unspecified",
};
/** 引脚名越长、本体越宽：每 6 个字符留一格 2.54 mm，最少 10 mm。 */
function bodyWidthOf(pins, requested) {
    const longest = pins.reduce((max, pin) => Math.max(max, pin.name.length), 0);
    const byText = Math.max(10, Math.ceil((longest * 1.1 + 4) / GRID) * GRID);
    return requested > 0 ? Math.max(requested, byText) : byText;
}
export function buildSymbol(spec) {
    try {
        if (typeof spec.name !== "string" || spec.name.trim() === "") {
            return { ...EMPTY, error: "符号名不能为空：它会写进 .kicad_sym，也是原理图里显示的名字" };
        }
        const pins = Array.isArray(spec.pins) ? spec.pins : [];
        if (pins.length === 0)
            return { ...EMPTY, error: "引脚表是空的：至少要有一个 { number, name }" };
        const seen = new Set();
        for (const pin of pins) {
            const number = typeof pin.number === "string" ? pin.number.trim() : "";
            if (number === "")
                return { ...EMPTY, error: "有引脚缺 number：编号是网表对上的唯一依据" };
            if (seen.has(number))
                return { ...EMPTY, error: "引脚编号重复：" + number };
            seen.add(number);
        }
        const width = bodyWidthOf(pins, typeof spec.bodyWidthMm === "number" ? spec.bodyWidthMm : 0);
        const perSide = Math.ceil(pins.length / 2);
        const height = Math.max(GRID * 2, (perSide + 1) * GRID);
        const halfW = width / 2;
        const halfH = height / 2;
        const ref = typeof spec.referencePrefix === "string" && spec.referencePrefix !== "" ? spec.referencePrefix : "U";
        const out = [
            "(kicad_symbol_lib",
            "  (version 20241209)",
            '  (generator "dsh-stm32")',
            '  (symbol "' + text(spec.name) + '"',
            "    (pin_names (offset 0.508))",
            "    (exclude_from_sim no)",
            "    (in_bom yes)",
            "    (on_board yes)",
            '    (property "Reference" "' + text(ref) + '" (at ' + fmt(-halfW) + " " + fmt(halfH + 1.27) + ' 0)',
            "      (effects (font (size 1.27 1.27)) (justify left)))",
            '    (property "Value" "' + text(spec.name) + '" (at ' + fmt(-halfW) + " " + fmt(-halfH - 1.27) + ' 0)',
            "      (effects (font (size 1.27 1.27)) (justify left)))",
            '    (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))',
            '    (property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))',
            '    (symbol "' + text(spec.name) + '_0_1"',
            "      (rectangle (start " + fmt(-halfW) + " " + fmt(halfH) + ") (end " + fmt(halfW) + " " + fmt(-halfH) + ")",
            "        (stroke (width 0.254) (type default)) (fill (type background)))",
            "    )",
            '    (symbol "' + text(spec.name) + '_1_1"',
        ];
        const firstRowY = halfH - GRID;
        pins.forEach((pin, index) => {
            const left = index < perSide;
            const slot = left ? index : index - perSide;
            const y = firstRowY - slot * GRID;
            const kind = KIND_MAP[pin.kind ?? "unspecified"];
            const x = left ? -halfW - GRID : halfW + GRID;
            const angle = left ? 0 : 180;
            out.push("      (pin " + kind + " line (at " + fmt(x) + " " + fmt(y) + " " + String(angle) + ") (length " + fmt(GRID) + ")", '        (name "' + text(pin.name) + '" (effects (font (size 1.27 1.27))))', '        (number "' + text(pin.number) + '" (effects (font (size 1.27 1.27)))))');
        });
        out.push("    )", "  )", ")", "");
        return {
            ok: true,
            error: "",
            text: out.join("\n"),
            pinCount: pins.length,
            bodyWidthMm: Math.round(width * 1000) / 1000,
            bodyHeightMm: Math.round(height * 1000) / 1000,
            notes: [
                "画法是矩形 + 左右两列：左列自上而下取前一半，右列自下而上取后一半，顺序与引脚表一致",
                "引脚功能只按表里的 kind 写，不按名字猜；表里没给 kind 的写成 unspecified",
            ],
        };
    }
    catch (error) {
        return { ...EMPTY, error: "生成符号失败：" + (error instanceof Error ? error.message : String(error)) };
    }
}
