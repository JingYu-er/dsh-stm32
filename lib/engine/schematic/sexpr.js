/**
 * S-expression 读写：KiCad 的原理图、封装、网表全部是这一种括号语法。
 *
 * 为什么不用正则按行扫：同一个文件里 `(symbol ...)` 既可能出现在 `lib_symbols`
 * （库定义，嵌套在符号单元里），也可能是顶层实例，缩进与层级都不同；行级统计会把
 * 实例数算成 0。只有按括号深度建树，才能同时拿到库引脚定义与实例坐标。
 *
 * 解析只做两件事：字符串字面量（含 `\"`、`\\` 转义）与括号列表；数值、布尔、
 * 关键字都保留为原子的原始文本，由调用方决定怎么解释。
 */
/** 列表判定，便于在 strict 模式下做类型收窄。 */
export function isList(node) {
    return Array.isArray(node);
}
/**
 * 解析一个完整的 S-expression 文档。
 *
 * 顶层必须是单个列表，多余内容（注释、尾随空白）忽略；结构不完整时报错，
 * 由调用方翻译成"文件不是合法的 KiCad 语法"。
 */
export function parseSexpr(text) {
    let index = 0;
    const length = text.length;
    const skipSpace = () => {
        while (index < length) {
            const char = text[index];
            if (char === " " || char === "\t" || char === "\n" || char === "\r") {
                index += 1;
                continue;
            }
            break;
        }
    };
    const readAtom = () => {
        if (text[index] === '"') {
            index += 1;
            let out = "";
            while (index < length) {
                const char = text[index];
                if (char === "\\") {
                    const next = text[index + 1];
                    if (next === undefined)
                        throw new Error("字符串未闭合");
                    out += next;
                    index += 2;
                    continue;
                }
                if (char === '"') {
                    index += 1;
                    return out;
                }
                out += char;
                index += 1;
            }
            throw new Error("字符串未闭合");
        }
        const start = index;
        while (index < length) {
            const char = text[index];
            if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === "(" || char === ")")
                break;
            index += 1;
        }
        if (index === start)
            throw new Error("空的原子");
        return text.slice(start, index);
    };
    const readList = () => {
        if (text[index] !== "(")
            throw new Error(`期望 (，位置 ${index}`);
        index += 1;
        const out = [];
        for (;;) {
            skipSpace();
            if (index >= length)
                throw new Error("括号未闭合");
            const char = text[index];
            if (char === ")") {
                index += 1;
                return out;
            }
            out.push(char === "(" ? readList() : readAtom());
        }
    };
    skipSpace();
    if (index >= length)
        throw new Error("文件为空");
    if (text[index] !== "(")
        throw new Error(`文档不是以 ( 开头，位置 ${index}`);
    return readList();
}
/** 列表的第一个原子（节点类型名），非列表或首项非原子时为空串。 */
export function headOf(node) {
    if (!Array.isArray(node))
        return "";
    const first = node[0];
    return typeof first === "string" ? first : "";
}
/** 取所有首项等于 `name` 的子列表。 */
export function childrenOf(node, name) {
    if (!Array.isArray(node))
        return [];
    const out = [];
    for (const item of node) {
        if (Array.isArray(item) && headOf(item) === name)
            out.push(item);
    }
    return out;
}
/** 取第一个首项等于 `name` 的子列表。 */
export function childOf(node, name) {
    if (!Array.isArray(node))
        return null;
    for (const item of node) {
        if (Array.isArray(item) && headOf(item) === name)
            return item;
    }
    return null;
}
/** 第 `index` 项按原子读；不是原子时为空串。 */
export function atomOf(node, index) {
    if (!Array.isArray(node))
        return "";
    const item = node[index];
    return typeof item === "string" ? item : "";
}
/** 第 `index` 项按数值读；缺失或非数值时返回 NaN，调用方用 Number.isFinite 判定。 */
export function numberOf(node, index) {
    const atom = atomOf(node, index);
    if (atom === "")
        return Number.NaN;
    const value = Number(atom);
    return Number.isFinite(value) ? value : Number.NaN;
}
