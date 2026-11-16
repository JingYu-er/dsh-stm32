/**
 * ECAD 库层（S98）：把 tscircuit 产物里内嵌的封装与符号抽成 KiCad 能读的库，并登记工程库表。
 *
 * 背景：tscircuit 导出的 `.kicad_pcb` / `.kicad_sch` 把几何内嵌在文件里，库名写成
 * `tscircuit:chip`、`Device:boxresistor_right`，工程目录里又没有 `fp-lib-table` /
 * `sym-lib-table`，于是 kicad-cli 的 DRC/ERC 报「封装库 'tscircuit' 不在配置中」。
 * 这里把内嵌定义写成真库文件，再补两张库表，让同一份板子在 KiCad 里打开时库是齐的。
 *
 * 只读源文件：改写的是新生成的库与库表，`.kicad_pcb` / `.kicad_sch` 一个字节都不动。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
/** 从 `open` 处的 `(` 找到配对的 `)`；字符串与转义里的括号不参与计数。 */
function matchParen(text, open) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = open; index < text.length; index += 1) {
        const char = text[index];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (char === "\\")
                escaped = true;
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
                return index;
        }
    }
    return -1;
}
/** 读 `(head "name" …)` 里的名字：允许 head 与名字之间换行（tscircuit 的封装就换行）。 */
function nameAfterHead(text, headEnd) {
    let index = headEnd;
    while (index < text.length && /\s/u.test(text[index] ?? ""))
        index += 1;
    if (text[index] !== '"')
        return null;
    const quote = index;
    index += 1;
    let name = "";
    while (index < text.length) {
        const char = text[index];
        if (char === "\\") {
            name += text[index + 1] ?? "";
            index += 2;
            continue;
        }
        if (char === '"')
            return { name, quote, end: index + 1 };
        name += char;
        index += 1;
    }
    return null;
}
/** 扫出所有 `(footprint "lib:name" …)`：pcb 里封装是顶层元素。 */
export function scanPcbFootprints(text) {
    const found = [];
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (char === "\\")
                escaped = true;
            else if (char === '"')
                inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === "(") {
            depth += 1;
            if (depth === 2 && text.startsWith("footprint", index + 1)) {
                const named = nameAfterHead(text, index + 1 + "footprint".length);
                if (named !== null) {
                    const close = matchParen(text, index);
                    if (close > 0) {
                        const [lib, name] = splitLibName(named.name);
                        found.push({ lib, name, raw: text.slice(index, close + 1) });
                        index = close;
                        depth -= 1;
                        continue;
                    }
                }
            }
            continue;
        }
        if (char === ")")
            depth -= 1;
    }
    return found;
}
/** 扫出 `(lib_symbols …)` 里的 `(symbol "lib:name" …)`；子单元符号名里没有冒号，自然被排除。 */
export function scanSchSymbols(text) {
    const found = [];
    const libSymbolsAt = text.indexOf("(lib_symbols");
    if (libSymbolsAt < 0)
        return found;
    const end = matchParen(text, libSymbolsAt);
    if (end < 0)
        return found;
    const body = text.slice(libSymbolsAt, end + 1);
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < body.length; index += 1) {
        const char = body[index];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (char === "\\")
                escaped = true;
            else if (char === '"')
                inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === "(") {
            depth += 1;
            if (depth === 2 && body.startsWith("symbol", index + 1)) {
                const named = nameAfterHead(body, index + 1 + "symbol".length);
                if (named !== null && named.name.includes(":")) {
                    const close = matchParen(body, index);
                    if (close > 0) {
                        const [lib, name] = splitLibName(named.name);
                        // 把块里的名字换成不带库前缀的单名，KiCad 的库文件里符号名就是这个形式。
                        // nameAfterHead 的偏移是相对 body 的整数，切片前要先减掉块的起点。
                        const base = index;
                        const raw = body.slice(base, close + 1);
                        found.push({
                            lib,
                            name,
                            raw: raw.slice(0, named.quote - base) + '"' + name + '"' + raw.slice(named.end - base),
                        });
                        index = close;
                        depth -= 1;
                        continue;
                    }
                }
            }
            continue;
        }
        if (char === ")")
            depth -= 1;
    }
    return found;
}
function splitLibName(full) {
    const at = full.indexOf(":");
    if (at <= 0)
        return ["", full];
    return [full.slice(0, at), full.slice(at + 1)];
}
function libTableEntry(lib, uri) {
    return ('  (lib (name "' + lib + '") (type "KiCad") (uri "' + uri.replace(/\\/gu, "/") + '")' +
        ' (options "") (descr "dsh-stm32 导出"))\n');
}
/**
 * 抽取库表里每个 `(lib …)` 块。
 *
 * 不能按「第一个 `(` 到最后一个 `)`」切：那样会把表头关键字一起当内容，
 * 下次写盘再拼一次表头，于是每构建一次多一行 `fp_lib_table`，
 * KiCad 打开时直接判定库表未初始化（`has type UNINITIALIZED but expected FOOTPRINT`）。
 */
function libBlocks(tableText) {
    const blocks = [];
    let at = tableText.indexOf("(lib ");
    while (at >= 0) {
        let depth = 0;
        let end = at;
        for (let i = at; i < tableText.length; i += 1) {
            if (tableText[i] === "(")
                depth += 1;
            else if (tableText[i] === ")") {
                depth -= 1;
                if (depth === 0) {
                    end = i + 1;
                    break;
                }
            }
        }
        if (end <= at)
            break;
        blocks.push(tableText.slice(at, end));
        at = tableText.indexOf("(lib ", end);
    }
    return blocks;
}
/**
 * 读-改-写库表：按 `(lib …)` 块重建，保留已有条目，只追加缺失的库。
 *
 * 表头固定为 `<kind>_lib_table` + `(version 7)`，与 KiCad 自己写出的格式一致。
 */
export function upsertLibEntries(path, kind, wanted) {
    let existing = "";
    if (existsSync(path)) {
        try {
            existing = readFileSync(path, "utf8");
        }
        catch {
            existing = "";
        }
    }
    const header = kind === "fp" ? "fp_lib_table" : "sym_lib_table";
    const kept = [];
    const known = new Set();
    for (const block of libBlocks(existing)) {
        const name = /\(name\s+"([^"]+)"/u.exec(block)?.[1] ?? "";
        if (name === "" || known.has(name))
            continue;
        known.add(name);
        kept.push(block.trim());
    }
    for (const item of wanted) {
        if (known.has(item.lib))
            continue;
        known.add(item.lib);
        kept.push(libTableEntry(item.lib, item.uri).trim());
    }
    const body = kept.map((block) => "  " + block + "\n").join("");
    writeFileSync(path, "(" + header + "\n  (version 7)\n" + body + ")\n", "utf8");
    return path;
}
/**
 * 把内嵌库导出成真库，并补齐工程库表。
 *
 * 落点：`hardware/libs/footprints/<lib>.pretty/<name>.kicad_mod`、
 * `hardware/libs/symbols/<lib>.kicad_sym`；库表写在 KiCad 工程目录（`.kicad_pcb` 同级），
 * URI 用 `${KIPRJMOD}/../libs/...` 相对工程。
 */
export function exportEmbeddedLibraries(workspace, pcbFile, schFile) {
    const notes = [];
    if (pcbFile === "" || !existsSync(pcbFile)) {
        return {
            ok: false,
            error: "还没有 .kicad_pcb：先跑一次 stm32_ecad_build",
            footprintLibs: [],
            symbolLibs: [],
            fpLibTable: "",
            symLibTable: "",
            notes,
        };
    }
    const projectDir = dirname(pcbFile);
    const footprints = scanPcbFootprints(readFileSync(pcbFile, "utf8"));
    const symbols = schFile !== "" && existsSync(schFile) ? scanSchSymbols(readFileSync(schFile, "utf8")) : [];
    const footprintGroups = new Map();
    for (const footprint of footprints) {
        if (footprint.lib === "")
            continue;
        const list = footprintGroups.get(footprint.lib) ?? [];
        list.push(footprint);
        footprintGroups.set(footprint.lib, list);
    }
    const footprintLibs = [];
    for (const [lib, items] of footprintGroups) {
        const dir = join(workspace.libsDir, "footprints", lib + ".pretty");
        mkdirSync(dir, { recursive: true });
        const seen = new Set();
        for (const item of items) {
            if (seen.has(item.name))
                continue;
            seen.add(item.name);
            const body = item.raw.replace(/^\(footprint\s+"[^"]*"/u, '(footprint "' + item.name + '" (version 20240108) (generator "dsh-stm32")');
            writeFileSync(join(dir, item.name + ".kicad_mod"), body + "\n", "utf8");
        }
        footprintLibs.push({ lib, count: seen.size, dir });
    }
    const symbolGroups = new Map();
    for (const symbol of symbols) {
        if (symbol.lib === "")
            continue;
        const list = symbolGroups.get(symbol.lib) ?? [];
        list.push(symbol);
        symbolGroups.set(symbol.lib, list);
    }
    const symbolLibs = [];
    for (const [lib, items] of symbolGroups) {
        const dir = join(workspace.libsDir, "symbols");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, lib + ".kicad_sym");
        const body = items.map((item) => "  " + item.raw + "\n").join("");
        writeFileSync(file, '(kicad_symbol_lib (version 20231120) (generator "dsh-stm32") (generator_version "1.0")\n' + body + ")\n", "utf8");
        symbolLibs.push({ lib, count: items.length, file });
    }
    // 库表写在 KiCad 工程目录里，URI 必须相对该目录（产物在 dist/<name>/kicad 下，离 libs 有距离）。
    const rel = (target) => "${KIPRJMOD}/" + relative(projectDir, target).replace(/\\/gu, "/");
    const fpWanted = footprintLibs.map((item) => ({ lib: item.lib, uri: rel(item.dir) }));
    const symWanted = symbolLibs.map((item) => ({ lib: item.lib, uri: rel(item.file) }));
    const fpLibTable = upsertLibEntries(join(projectDir, "fp-lib-table"), "fp", fpWanted);
    const symLibTable = upsertLibEntries(join(projectDir, "sym-lib-table"), "sym", symWanted);
    if (footprintLibs.length === 0)
        notes.push("没有内嵌封装需要导出：封装可能已经是 KiCad 官方库");
    if (symbolLibs.length === 0)
        notes.push("没有内嵌符号需要导出");
    notes.push("库表：" + basename(fpLibTable) + " / " + basename(symLibTable) + "（保留已有条目，只追加缺失的库）");
    return { ok: true, error: "", footprintLibs, symbolLibs, fpLibTable, symLibTable, notes };
}
