/**
 * 原理图编辑：把「连两根引脚、给引脚起名」这类动作存成一份指令表，构建后重放。
 *
 * 为什么不是直接改文件：tscircuit 是原理图与 PCB 的唯一写者，每次 `ecad_build` 都会重写
 * `dist/<工程>/kicad/*.kicad_sch`。所以人工编辑只能落在「指令」这一层，由构建收尾时重放，
 * 否则下一次构建就没了。
 *
 * 指令只描述电气意图（哪两个引脚连起来、哪个引脚叫什么），坐标由当时的符号位置算出来；
 * 因此元件挪了位置、甚至换了封装，重放仍然对，只有引脚没了才会失败——失败要报出来，
 * 不能静默跳过。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parseSchText } from "./kicad-sch.js";
import { placePin } from "./transform.js";
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
const EMPTY = {
    ok: true,
    error: "",
    applied: 0,
    skipped: 0,
    failed: [],
    notes: [],
    text: "",
};
export function editStorePath(circuitDir) {
    return join(circuitDir, "schematic-edits.json");
}
export function readSchEdits(file) {
    if (!existsSync(file))
        return [];
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        const edits = Array.isArray(parsed.edits) ? parsed.edits : [];
        return edits.filter((edit) => typeof edit === "object" && edit !== null && "op" in edit);
    }
    catch {
        return [];
    }
}
export function writeSchEdits(file, edits) {
    const store = { version: 1, edits };
    writeFileSync(file, JSON.stringify(store, null, 2) + "\n", "utf8");
}
function findSymbol(sheet, ref) {
    for (const symbol of sheet.symbols) {
        if (symbol.ref === ref)
            return symbol;
    }
    return null;
}
function pinsOf(sheet, symbol) {
    const pins = sheet.libPins.get(symbol.libId) ?? [];
    const unitPins = pins.filter((pin) => pin.unit === 0 || pin.unit === symbol.unit);
    return unitPins.length > 0 ? unitPins : pins;
}
/** 引脚端点在图纸上的绝对坐标；找不到返回 null。 */
export function pinPoint(sheet, ref, number) {
    const symbol = findSymbol(sheet, ref);
    if (symbol === null)
        return null;
    const pin = pinsOf(sheet, symbol).find((item) => item.number === number);
    if (pin === undefined)
        return null;
    return placePin({ x: pin.x, y: pin.y }, symbol);
}
function samePoint(left, right) {
    return Math.abs(left.x - right.x) < 0.001 && Math.abs(left.y - right.y) < 0.001;
}
function wireExists(sheet, points) {
    const first = points[0];
    const last = points[points.length - 1];
    if (first === undefined || last === undefined)
        return false;
    for (const wire of sheet.wires) {
        if (samePoint(wire.a, first) && samePoint(wire.b, last))
            return true;
        if (samePoint(wire.a, last) && samePoint(wire.b, first))
            return true;
    }
    return false;
}
function labelExists(sheet, text, at) {
    return sheet.labels.some((label) => label.name === text && samePoint(label.at, at));
}
function num(value) {
    return String(Math.round(value * 10000) / 10000);
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
/**
 * 把指令画到图纸文本上。`file` 只用于解析时给出报错出处与多图纸路径，不改盘。
 * 返回的 `text` 由调用方决定写不写。
 */
export function applySchEdits(text, file, edits) {
    if (edits.length === 0)
        return { ...EMPTY, text };
    let sheet;
    try {
        sheet = parseSchText(text, file, file);
    }
    catch (error) {
        return { ...EMPTY, ok: false, error: "读不懂这个 .kicad_sch：" + error.message, text };
    }
    const additions = [];
    const failed = [];
    const notes = [];
    let applied = 0;
    let skipped = 0;
    for (const edit of edits) {
        if (edit.op === "connect") {
            const from = pinPoint(sheet, edit.a.ref, edit.a.pin);
            const to = pinPoint(sheet, edit.b.ref, edit.b.pin);
            if (from === null) {
                failed.push(`图纸里没有 ${edit.a.ref} 的 ${edit.a.pin} 脚`);
                continue;
            }
            if (to === null) {
                failed.push(`图纸里没有 ${edit.b.ref} 的 ${edit.b.pin} 脚`);
                continue;
            }
            // 正交走线：同轴直接连，否则在 (to.x, from.y) 拐一次。
            const points = Math.abs(from.x - to.x) < 0.001 || Math.abs(from.y - to.y) < 0.001
                ? [from, to]
                : [from, { x: to.x, y: from.y }, to];
            if (wireExists(sheet, points)) {
                skipped += 1;
                continue;
            }
            additions.push(wireText(points));
            applied += 1;
            notes.push(`连上 ${edit.a.ref}.${edit.a.pin} ↔ ${edit.b.ref}.${edit.b.pin}` +
                (points.length > 2 ? "（拐了一次）" : ""));
            continue;
        }
        const at = pinPoint(sheet, edit.at.ref, edit.at.pin);
        if (at === null) {
            failed.push(`图纸里没有 ${edit.at.ref} 的 ${edit.at.pin} 脚`);
            continue;
        }
        if (labelExists(sheet, edit.text, at)) {
            skipped += 1;
            continue;
        }
        additions.push(labelText(edit.text, at));
        applied += 1;
        notes.push(`给 ${edit.at.ref}.${edit.at.pin} 标名 ${edit.text}`);
    }
    if (additions.length === 0) {
        return { ok: true, error: "", applied, skipped, failed, notes, text };
    }
    // 顶层是一个表达式，最后那个 ')' 就是文档结尾；新图元插在它前面。
    const end = text.lastIndexOf(")");
    if (end < 0) {
        return { ok: false, error: "找不到文档结尾的 ')'：文件可能被截断", applied: 0, skipped, failed, notes, text };
    }
    const head = text.slice(0, end).replace(/\s*$/u, "\n");
    const tail = text.slice(end);
    return { ok: true, error: "", applied, skipped, failed, notes, text: head + additions.join("") + tail };
}
/**
 * 把指令重放到一个构建目录里的所有图纸上（S170）。
 * 工具与 HTTP 路由共用同一份实现：面板点「连起来」和模型调工具要走同一条路。
 */
export function replaySchEditsTo(kicadDir, edits, readDir = readdirSync, readText = (file) => readFileSync(file, "utf8"), writeText = (file, text) => writeFileSync(file, text, "utf8")) {
    if (kicadDir === "") {
        return { applied: 0, skipped: 0, failed: [], notes: ["还没有构建产物：指令已存，下次 stm32_ecad_build 时重放"] };
    }
    let applied = 0;
    let skipped = 0;
    const failed = [];
    const notes = [];
    for (const name of readDir(kicadDir)) {
        if (!name.endsWith(".kicad_sch"))
            continue;
        const file = join(kicadDir, name);
        let before;
        try {
            before = readText(file);
        }
        catch (error) {
            notes.push(`读不到 ${name}：${describeError(error)}`);
            continue;
        }
        const outcome = applySchEdits(before, file, edits);
        if (!outcome.ok) {
            notes.push(outcome.error);
            continue;
        }
        if (outcome.applied > 0)
            writeText(file, outcome.text);
        applied += outcome.applied;
        skipped += outcome.skipped;
        for (const failure of outcome.failed)
            failed.push(failure);
    }
    if (applied > 0)
        notes.push(`已重放 ${String(applied)} 条指令`);
    if (applied === 0 && skipped > 0 && failed.length === 0)
        notes.push("这些指令已经画在图纸上");
    return { applied, skipped, failed, notes };
}
