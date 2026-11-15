/**
 * 同坐标焊盘合并（S131）。
 *
 * 16P USB-C 这类封装把同一块铜拆成两个脚（A1/B12）。KiCad 允许一个焊盘写多编号
 * （`(pad "A1,B12" …)`），合并后 DRC 不再报「间距 0 mm」，手工布线也只需连一次。
 *
 * 只做三件确定的事：同一个封装块内、坐标与尺寸都相同、网络也相同；网络不同就不合，
 * 因为那说明网表本身有问题，合并只会把它藏起来。
 */
function blockEnd(text, start) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i += 1) {
        const ch = text[i];
        if (inString) {
            if (ch === "\\")
                i += 1;
            else if (ch === "\"")
                inString = false;
            continue;
        }
        if (ch === "\"") {
            inString = true;
            continue;
        }
        if (ch === "(")
            depth += 1;
        else if (ch === ")") {
            depth -= 1;
            if (depth === 0)
                return i + 1;
        }
    }
    return text.length;
}
function padBlocks(body, offset) {
    const found = [];
    const pattern = /\(pad\s+"([^"]*)"/gu;
    let match = pattern.exec(body);
    while (match !== null) {
        const start = match.index;
        const end = blockEnd(body, start);
        const raw = body.slice(start, end);
        const at = /\(at\s+(-?[\d.]+)\s+(-?[\d.]+)/u.exec(raw);
        const size = /\(size\s+([\d.]+)\s+([\d.]+)\)/u.exec(raw);
        const net = /\(net\s+\d+\s+"([^"]*)"\)/u.exec(raw);
        if (at !== null && size !== null) {
            found.push({
                start: start + offset,
                end: end + offset,
                raw,
                name: match[1] ?? "",
                x: Number(at[1]),
                y: Number(at[2]),
                w: Number(size[1]),
                h: Number(size[2]),
                net: net === null ? "" : (net[1] ?? ""),
            });
        }
        pattern.lastIndex = end;
        match = pattern.exec(body);
    }
    return found;
}
function footprintBlocks(text) {
    const out = [];
    const pattern = /\(footprint\s+"([^"]*)"/gu;
    let match = pattern.exec(text);
    while (match !== null) {
        const start = match.index;
        const end = blockEnd(text, start);
        out.push({ name: match[1] ?? "", start, end, bodyStart: start });
        pattern.lastIndex = end;
        match = pattern.exec(text);
    }
    return out;
}
/** 同一封装块内、坐标尺寸网络都一致的焊盘合并成一个多编号焊盘。 */
export function mergeCoincidentPads(pcbText) {
    const merged = [];
    const skipped = [];
    const edits = [];
    for (const fp of footprintBlocks(pcbText)) {
        const body = pcbText.slice(fp.bodyStart, fp.end);
        const pads = padBlocks(body, fp.bodyStart);
        const groups = new Map();
        for (const pad of pads) {
            const key = [pad.x, pad.y, pad.w, pad.h].join(":");
            const list = groups.get(key);
            if (list === undefined)
                groups.set(key, [pad]);
            else
                list.push(pad);
        }
        for (const [, list] of groups) {
            if (list.length < 2)
                continue;
            const names = list.map((pad) => pad.name);
            const nets = new Set(list.map((pad) => pad.net));
            if (nets.size > 1) {
                skipped.push({
                    footprint: fp.name,
                    names,
                    reason: "同坐标焊盘的网络不同：网表本身有问题，合并会把它藏起来",
                });
                continue;
            }
            const net = list[0]?.net ?? "";
            const mergedName = names.filter((name) => name !== "").join(",");
            if (mergedName === "")
                continue;
            const first = list[0];
            if (first === undefined)
                continue;
            const head = first.raw.replace(/^\(pad\s+"[^"]*"/u, '(pad "' + mergedName + '"');
            edits.push({ start: first.start, end: first.end, text: head });
            for (const pad of list.slice(1))
                edits.push({ start: pad.start, end: pad.end, text: "" });
            merged.push({ footprint: fp.name, names, net });
        }
    }
    let text = pcbText;
    edits.sort((a, b) => b.start - a.start);
    for (const edit of edits) {
        text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    }
    return { text, merged, skipped };
}
