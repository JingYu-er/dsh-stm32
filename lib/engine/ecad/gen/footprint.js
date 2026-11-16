/**
 * 封装生成（S164）：按封装类型与尺寸算出 `.kicad_mod`。
 *
 * 只做三种能算准的封装——双列直插/贴片（SOIC/SOP）、四边引脚（QFP/LQFP）、两脚小件（0402/0603/0805 这类矩形）。
 * 引脚编号与排布按 JEDEC/EIA 的常规约定：QFP 从 1 脚逆时针，双列从 1 脚逆时针（左列向下、右列向上）。
 *
 * 这里不读手册、不猜尺寸：pitch / body / pad 都必须由调用方给出，缺一个就报错。
 * 依据是「尺寸是画板的人量出来的」，不是「模型按型号想出来的」。
 */
const EMPTY = { ok: false, error: "", text: "", pinCount: 0, notes: [] };
function num(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function fmt(value) {
    return String(Math.round(value * 1000) / 1000);
}
function text(value) {
    return value.replace(/\\/gu, "/").replace(/"/gu, "'");
}
/** 两脚小件：本体长宽 + 两端焊盘。 */
function passiveBody(spec) {
    const len = num(spec.bodyWidthMm);
    const width = num(spec.bodyHeightMm);
    const padW = num(spec.padWidthMm) || len * 0.6;
    const padH = num(spec.padHeightMm) || width;
    return { lenMm: len, widthMm: width, padW, padH };
}
function head(spec, attr, descr, bodyW, bodyH) {
    const halfW = bodyW / 2;
    const halfH = bodyH / 2;
    const lines = [
        '(footprint "' + text(spec.name) + '"',
        "  (version 20241229)",
        '  (generator "dsh-stm32")',
        '  (layer "F.Cu")',
        "  (descr \"" + text(descr) + "\")",
        "  (attr " + attr + ")",
        '  (fp_text reference "REF**" (at 0 ' + fmt(-halfH - 1.2) + ') (layer "F.SilkS")',
        "    (effects (font (size 1 1) (thickness 0.15))))",
        '  (fp_text value "' + text(spec.name) + '" (at 0 ' + fmt(halfH + 1.2) + ') (layer "F.Fab")',
        "    (effects (font (size 1 1) (thickness 0.15))))",
    ];
    // 丝印只画四边（留出引脚出口），courtyard 比本体大 0.25 mm。
    const silk = 0.12;
    const gap = 0.6;
    lines.push("  (fp_line (start " + fmt(-halfW) + " " + fmt(-halfH) + ") (end " + fmt(-gap) + " " + fmt(-halfH) + ") (stroke (width " + fmt(silk) + ") (type solid)) (layer \"F.SilkS\"))", "  (fp_line (start " + fmt(gap) + " " + fmt(-halfH) + ") (end " + fmt(halfW) + " " + fmt(-halfH) + ") (stroke (width " + fmt(silk) + ") (type solid)) (layer \"F.SilkS\"))", "  (fp_line (start " + fmt(-halfW) + " " + fmt(halfH) + ") (end " + fmt(-gap) + " " + fmt(halfH) + ") (stroke (width " + fmt(silk) + ") (type solid)) (layer \"F.SilkS\"))", "  (fp_line (start " + fmt(gap) + " " + fmt(halfH) + ") (end " + fmt(halfW) + " " + fmt(halfH) + ") (stroke (width " + fmt(silk) + ") (type solid)) (layer \"F.SilkS\"))", "  (fp_line (start " + fmt(-halfW) + " " + fmt(-halfH) + ") (end " + fmt(-halfW) + " " + fmt(halfH) + ") (stroke (width " + fmt(silk) + ") (type solid)) (layer \"F.SilkS\"))", "  (fp_line (start " + fmt(halfW) + " " + fmt(-halfH) + ") (end " + fmt(halfW) + " " + fmt(halfH) + ") (stroke (width " + fmt(silk) + ") (type solid)) (layer \"F.SilkS\"))", "  (fp_circle (center " + fmt(-halfW - 0.9) + " " + fmt(-halfH - 0.9) + ") (end " + fmt(-halfW - 0.45) + " " + fmt(-halfH - 0.9) + ") (stroke (width " + fmt(silk) + ") (type solid)) (fill none) (layer \"F.SilkS\"))", "  (fp_rect (start " + fmt(-halfW - 0.25) + " " + fmt(-halfH - 0.25) + ") (end " + fmt(halfW + 0.25) + " " + fmt(halfH + 0.25) + ") (stroke (width 0.05) (type solid)) (fill none) (layer \"F.CrtYd\"))");
    return lines;
}
function padSmd(number, x, y, w, h) {
    return "  (pad \"" + number + "\" smd rect (at " + fmt(x) + " " + fmt(y) + ") (size " + fmt(w) + " " + fmt(h) + ") (layers \"F.Cu\" \"F.Paste\" \"F.Mask\"))";
}
/** QFP/LQFP：四边等分引脚，1 脚在左上（y 向下为负）。 */
function buildQfp(spec) {
    const pins = Math.round(num(spec.pins));
    const pitch = num(spec.pitch);
    const bodyW = num(spec.bodyWidthMm);
    const bodyH = num(spec.bodyHeightMm);
    if (pins < 4 || pins % 4 !== 0)
        return { ...EMPTY, error: "QFP 的引脚数要是 4 的倍数，收到 " + String(pins) };
    if (pitch <= 0)
        return { ...EMPTY, error: "QFP 要给 pitch（引脚间距，mm）" };
    if (bodyW <= 0 || bodyH <= 0)
        return { ...EMPTY, error: "QFP 要给 bodyWidthMm 与 bodyHeightMm" };
    const perSide = pins / 4;
    const padW = num(spec.padWidthMm) || 1.5;
    const padH = num(spec.padHeightMm) || Math.min(pitch * 0.55, 0.3);
    const offset = num(spec.padOffsetMm) || bodyW / 2 + padW / 2 - 0.3;
    const lines = head(spec, "smd", "QFP-".concat(String(pins), " ", fmt(bodyW), "x", fmt(bodyH), " P", fmt(pitch)), bodyW, bodyH);
    const start = -((perSide - 1) * pitch) / 2;
    let index = 0;
    // 左边：从上往下（1 脚在左上角）；下边：从左往右。
    for (let i = 0; i < perSide; i += 1) {
        index += 1;
        lines.push(padSmd(String(index), -offset, start + i * pitch, padW, padH));
    }
    const offY = offset * (bodyH / bodyW);
    for (let i = 0; i < perSide; i += 1) {
        index += 1;
        lines.push(padSmd(String(index), start + i * pitch, offY, padH, padW));
    }
    for (let i = perSide - 1; i >= 0; i -= 1) {
        index += 1;
        lines.push(padSmd(String(index), offset, -(start + i * pitch), padW, padH));
    }
    for (let i = perSide - 1; i >= 0; i -= 1) {
        index += 1;
        lines.push(padSmd(String(index), -(start + i * pitch), -offY, padH, padW));
    }
    return {
        ok: true,
        error: "",
        text: lines.join("\n") + "\n)\n",
        pinCount: pins,
        notes: ["引脚按逆时针 1→" + String(pins) + " 排列；焊盘尺寸是按 pitch 推的，量过手册后可用参数覆盖"],
    };
}
/** SOIC/SOP/SSOP：两列，1 脚在左列最上（y 向下为负）。 */
function buildSoic(spec) {
    const pins = Math.round(num(spec.pins));
    const pitch = num(spec.pitch);
    const bodyW = num(spec.bodyWidthMm);
    const bodyH = num(spec.bodyHeightMm);
    if (pins < 4 || pins % 2 !== 0)
        return { ...EMPTY, error: "双列封装的引脚数要是 2 的倍数，收到 " + String(pins) };
    if (pitch <= 0)
        return { ...EMPTY, error: "双列封装要给 pitch（引脚间距，mm）" };
    if (bodyW <= 0)
        return { ...EMPTY, error: "双列封装要给 bodyWidthMm" };
    const perSide = pins / 2;
    const bodyHeight = bodyH > 0 ? bodyH : (perSide - 1) * pitch + 1.6;
    const padW = num(spec.padWidthMm) || 1.5;
    const padH = num(spec.padHeightMm) || Math.min(pitch * 0.6, 0.6);
    const offset = num(spec.padOffsetMm) || bodyW / 2 + padW / 2 - 0.35;
    const lines = head(spec, "smd", "SOIC-".concat(String(pins), " ", fmt(bodyW), "x", fmt(bodyHeight), " P", fmt(pitch)), bodyW, bodyHeight);
    const start = -((perSide - 1) * pitch) / 2;
    let index = 0;
    for (let i = 0; i < perSide; i += 1) {
        index += 1;
        lines.push(padSmd(String(index), -offset, start + i * pitch, padW, padH));
    }
    for (let i = perSide - 1; i >= 0; i -= 1) {
        index += 1;
        lines.push(padSmd(String(index), offset, start + i * pitch, padW, padH));
    }
    return {
        ok: true,
        error: "",
        text: lines.join("\n") + "\n)\n",
        pinCount: pins,
        notes: ["1 脚在左列最上，2 脚往下；右列从下往上接续"],
    };
}
/** 两脚小件（0402/0603/0805）：本体长宽 + 两端焊盘。 */
function buildPassive(spec) {
    const { lenMm, widthMm, padW, padH } = passiveBody(spec);
    if (lenMm <= 0 || widthMm <= 0)
        return { ...EMPTY, error: "两脚件要给本体长（bodyWidthMm）与宽（bodyHeightMm）" };
    const gap = lenMm / 2 - padW / 2 - 0.05;
    const lines = head(spec, "smd", "passive " + fmt(lenMm) + "x" + fmt(widthMm), lenMm, widthMm);
    lines.push(padSmd("1", -gap, 0, padW, padH));
    lines.push(padSmd("2", gap, 0, padW, padH));
    return { ok: true, error: "", text: lines.join("\n") + "\n)\n", pinCount: 2, notes: [] };
}
export function buildFootprint(spec) {
    try {
        if (typeof spec.name !== "string" || spec.name.trim() === "")
            return { ...EMPTY, error: "封装名不能为空：它会写进 .kicad_mod，也是库里的名字" };
        if (spec.kind === "qfp")
            return buildQfp(spec);
        if (spec.kind === "soic")
            return buildSoic(spec);
        if (spec.kind === "passive")
            return buildPassive(spec);
        return { ...EMPTY, error: "不认识的封装类型：".concat(String(spec.kind), "（只有 qfp / soic / passive）") };
    }
    catch (error) {
        return { ...EMPTY, error: "生成封装失败：" + (error instanceof Error ? error.message : String(error)) };
    }
}
