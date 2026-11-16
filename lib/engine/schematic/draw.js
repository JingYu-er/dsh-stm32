/**
 * 图纸手绘层：直接改 `.kicad_sch` 文本，不依赖 KiCad 进程。
 *
 * 为什么不写生成目录：tscircuit 每次 `ecad_build` 都重写
 * `hardware/circuit/dist/<工程>/kicad/*.kicad_sch`，画在那里下次构建就没了。
 * 所以手绘层固定在 `hardware/schematic/`，构建从不触碰；需要底图时用 `seed` 从最近一次
 * 构建拷一份过来。
 *
 * 本模块只做四件事：连线、标名、克隆元件、挪元件。都按「平衡括号取块」改写文本，
 * 改完的图纸可以用 `kicad-cli sch export netlist` 校验。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { parseSchText } from "./kicad-sch.js";
import { placePin } from "./transform.js";
export function drawSheetPath(projectDir, name = "schematic") {
    return join(projectDir, "hardware", "schematic", name + ".kicad_sch");
}
function num(value) {
    return String(Math.round(value * 10000) / 10000);
}
function samePoint(left, right) {
    return Math.abs(left.x - right.x) < 0.001 && Math.abs(left.y - right.y) < 0.001;
}
/** 从 `index` 处的 `(` 起按括号平衡找到块尾（含）。找不到返回 -1。 */
function blockEnd(text, index) {
    let depth = 0;
    let inString = false;
    for (let cursor = index; cursor < text.length; cursor += 1) {
        const char = text[cursor];
        if (inString) {
            if (char === "\\")
                cursor += 1;
            else if (char === '"')
                inString = false;
            continue;
        }
        if (char === '"')
            inString = true;
        else if (char === "(")
            depth += 1;
        else if (char === ")") {
            depth -= 1;
            if (depth === 0)
                return cursor + 1;
        }
    }
    return -1;
}
/** 图纸里 `(symbol (lib_id …) …)` 实例块的起止位置。 */
export function symbolBlocks(text) {
    const blocks = [];
    let cursor = 0;
    while (cursor < text.length) {
        const index = text.indexOf("(symbol", cursor);
        if (index < 0)
            break;
        const end = blockEnd(text, index);
        if (end < 0)
            break;
        const body = text.slice(index, end);
        if (body.includes("(lib_id ") && !body.includes("(lib_name ")) {
            const match = /\(property "Reference" "([^"]*)"/u.exec(body);
            blocks.push({ ref: match?.[1] ?? "", start: index, end });
            cursor = end;
            continue;
        }
        cursor = index + "(symbol".length;
    }
    return blocks;
}
function labelText(text, at) {
    const escaped = text.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
    return ('  (label "' +
        escaped +
        '" (at ' +
        num(at.x) +
        " " +
        num(at.y) +
        " 0)\n" +
        "    (effects (font (size 1.27 1.27)) (justify left bottom))\n" +
        '    (uuid "' +
        randomUUID() +
        '")\n' +
        "  )\n");
}
function wireText(points) {
    const pts = points.map((point) => `(xy ${num(point.x)} ${num(point.y)})`).join(" ");
    return ("  (wire (pts " +
        pts +
        ")\n" +
        "    (stroke (width 0) (type default))\n" +
        '    (uuid "' +
        randomUUID() +
        '")\n' +
        "  )\n");
}
function resolvePoint(sheet, point) {
    if (typeof point.x === "number" && typeof point.y === "number")
        return { x: point.x, y: point.y };
    if (typeof point.ref === "string" && typeof point.pin === "string") {
        const symbol = sheet.symbols.find((item) => item.ref === point.ref);
        if (symbol === undefined)
            return null;
        const pins = sheet.libPins.get(symbol.libId) ?? [];
        const unitPins = pins.filter((pin) => pin.unit === 0 || pin.unit === symbol.unit);
        const pin = (unitPins.length > 0 ? unitPins : pins).find((item) => item.number === point.pin);
        if (pin === undefined)
            return null;
        return placePin({ x: pin.x, y: pin.y }, symbol);
    }
    return null;
}
function insert(text, addition) {
    const end = text.lastIndexOf(")");
    if (end < 0)
        return text;
    const head = text.slice(0, end).replace(/\s*$/u, "\n");
    return head + addition + text.slice(end);
}
function cloneBlock(block, ref, at, value) {
    let next = block.replace(/\(uuid [^)]*\)/gu, '(uuid "' + randomUUID() + '")');
    next = next.replace(/(\(property "Reference" ")[^"]*(")/u, "$1" + ref + "$2");
    if (value !== undefined)
        next = next.replace(/(\(property "Value" ")[^"]*(")/u, "$1" + value + "$2");
    next = next.replace(/\(at [^)]*\)/u, "(at " + num(at.x) + " " + num(at.y) + " 0)");
    next = next.replace(/(\(path "[^"]*"\s*\(reference ")[^"]*(")/u, "$1" + ref + "$2");
    return next.startsWith("  ") ? next : "  " + next;
}
function moveBlock(block, at) {
    return block.replace(/\(at [^)]*\)/u, "(at " + num(at.x) + " " + num(at.y) + " 0)");
}
function refsOf(sheet) {
    const map = new Map();
    for (const symbol of sheet.symbols)
        map.set(symbol.ref, symbol);
    return map;
}
/**
 * 把一组动作画到图纸文本上。`file` 只用于解析报错出处，不改盘。
 * 返回的 `text` 由调用方决定写不写。
 */
export function drawOnSheet(text, file, ops) {
    const empty = { ok: true, error: "", text, applied: 0, skipped: 0, failed: [], notes: [] };
    if (ops.length === 0)
        return empty;
    let sheet;
    try {
        sheet = parseSchText(text, file, file);
    }
    catch (error) {
        return { ...empty, ok: false, error: "读不懂这个 .kicad_sch：" + error.message };
    }
    let next = text;
    const failed = [];
    const notes = [];
    let applied = 0;
    let skipped = 0;
    for (const op of ops) {
        if (op.op === "wire") {
            const from = resolvePoint(sheet, op.a);
            const to = resolvePoint(sheet, op.b);
            if (from === null) {
                failed.push("连线起点找不到：" + describePoint(op.a));
                continue;
            }
            if (to === null) {
                failed.push("连线终点找不到：" + describePoint(op.b));
                continue;
            }
            const points = Math.abs(from.x - to.x) < 0.001 || Math.abs(from.y - to.y) < 0.001
                ? [from, to]
                : [from, { x: to.x, y: from.y }, to];
            const first = points[0];
            const last = points[points.length - 1];
            const exists = sheet.wires.some((wire) => (samePoint(wire.a, first) && samePoint(wire.b, last)) ||
                (samePoint(wire.a, last) && samePoint(wire.b, first)));
            if (exists) {
                skipped += 1;
                continue;
            }
            next = insert(next, wireText(points));
            sheet = parseSchText(next, file, file);
            applied += 1;
            notes.push("连线 " + describePoint(op.a) + " ↔ " + describePoint(op.b));
            continue;
        }
        if (op.op === "label") {
            const at = resolvePoint(sheet, op.at);
            if (at === null) {
                failed.push("标名位置找不到：" + describePoint(op.at));
                continue;
            }
            if (sheet.labels.some((label) => label.name === op.text && samePoint(label.at, at))) {
                skipped += 1;
                continue;
            }
            next = insert(next, labelText(op.text, at));
            sheet = parseSchText(next, file, file);
            applied += 1;
            notes.push("标名 " + op.text + " @" + describePoint(op.at));
            continue;
        }
        const blocks = symbolBlocks(next);
        if (op.op === "clone") {
            const source = blocks.find((block) => block.ref === op.from);
            if (source === undefined) {
                failed.push("图纸里没有 " + op.from + "，无法克隆");
                continue;
            }
            if (blocks.some((block) => block.ref === op.ref)) {
                skipped += 1;
                continue;
            }
            const origin = refsOf(sheet).get(op.from);
            const at = op.at ?? {
                x: (origin?.at.x ?? 0) + 25.4,
                y: origin?.at.y ?? 0,
            };
            next = insert(next, cloneBlock(next.slice(source.start, source.end), op.ref, at, op.value));
            sheet = parseSchText(next, file, file);
            applied += 1;
            notes.push("克隆 " + op.from + " → " + op.ref + " @" + num(at.x) + "," + num(at.y));
            continue;
        }
        const target = blocks.find((block) => block.ref === op.ref);
        if (target === undefined) {
            failed.push("图纸里没有 " + op.ref);
            continue;
        }
        if (op.op === "move") {
            next = next.slice(0, target.start) + moveBlock(next.slice(target.start, target.end), op.at) + next.slice(target.end);
            sheet = parseSchText(next, file, file);
            applied += 1;
            notes.push("挪动 " + op.ref + " → " + num(op.at.x) + "," + num(op.at.y));
            continue;
        }
        next = next.slice(0, target.start) + next.slice(target.end);
        sheet = parseSchText(next, file, file);
        applied += 1;
        notes.push("删除 " + op.ref);
    }
    return { ok: failed.length === 0, error: failed.join("；"), text: next, applied, skipped, failed, notes };
}
function describePoint(point) {
    if (typeof point.ref === "string" && typeof point.pin === "string")
        return point.ref + "." + point.pin;
    if (typeof point.x === "number" && typeof point.y === "number")
        return "(" + num(point.x) + "," + num(point.y) + ")";
    return "未指定位置";
}
/** 手绘层是否存在；不存在时返回空串。 */
export function readDrawSheet(file) {
    return existsSync(file) ? readFileSync(file, "utf8") : "";
}
export function writeDrawSheet(file, text) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, "utf8");
}
/** 以最近一次构建的图纸为底图；已存在的底图不覆盖。 */
export function seedDrawSheet(buildSheet, target) {
    if (existsSync(target))
        return { ok: true, error: "", seeded: false };
    if (!existsSync(buildSheet))
        return { ok: false, error: "还没有可用的构建图纸：" + buildSheet, seeded: false };
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(buildSheet, "utf8"), "utf8");
    return { ok: true, error: "", seeded: true };
}
