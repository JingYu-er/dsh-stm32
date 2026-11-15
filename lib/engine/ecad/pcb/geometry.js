export function buildGeometryScript(boardFile) {
    return [
        "import json, sys",
        "import pcbnew",
        "board = pcbnew.LoadBoard(" + JSON.stringify(boardFile) + ")",
        "units = 1000000.0",
        "def mm(value): return round(value / units, 4)",
        "box = board.GetBoardEdgesBoundingBox()",
        "pads = []",
        "for footprint in board.GetFootprints():",
        "    ref = footprint.GetReference()",
        "    for pad in footprint.Pads():",
        "        size = pad.GetSize()",
        "        pos = pad.GetPosition()",
        "        pads.append({'ref': ref, 'number': pad.GetNumber(), 'net': pad.GetNetname(), 'x': mm(pos.x), 'y': mm(pos.y), 'width': mm(size.x), 'height': mm(size.y)})",
        "tracks = []",
        "for track in board.GetTracks():",
        "    if track.Type() != pcbnew.PCB_TRACE_T:",
        "        continue",
        "    tracks.append({'net': track.GetNetname(), 'layer': board.GetLayerName(track.GetLayer()), 'width': mm(track.GetWidth()), 'x1': mm(track.GetStart().x), 'y1': mm(track.GetStart().y), 'x2': mm(track.GetEnd().x), 'y2': mm(track.GetEnd().y)})",
        "print(json.dumps({'x0': mm(box.GetLeft()), 'y0': mm(box.GetTop()), 'widthMm': mm(box.GetWidth()), 'heightMm': mm(box.GetHeight()), 'pads': pads, 'tracks': tracks}))",
    ].join("\n");
}
export function parseGeometry(stdout) {
    const empty = { ok: false, error: "", widthMm: 0, heightMm: 0, x0: 0, y0: 0, pads: [], tracks: [], notes: [] };
    const start = stdout.indexOf('{"');
    if (start < 0)
        return { ...empty, error: "几何导出没有输出 JSON" };
    const end = stdout.lastIndexOf('}');
    if (end <= start)
        return { ...empty, error: "几何导出的 JSON 不完整" };
    let parsed;
    try {
        parsed = JSON.parse(stdout.slice(start, end + 1));
    }
    catch {
        return { ...empty, error: "几何导出的 JSON 解析失败" };
    }
    if (typeof parsed !== "object" || parsed === null)
        return { ...empty, error: "几何导出不是对象" };
    const record = parsed;
    const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
    const pads = Array.isArray(record["pads"]) ? record["pads"].map((item) => {
        const pad = item;
        return {
            ref: String(pad["ref"] ?? ""), number: String(pad["number"] ?? ""), net: String(pad["net"] ?? ""),
            x: num(pad["x"]), y: num(pad["y"]), width: num(pad["width"]), height: num(pad["height"]),
        };
    }) : [];
    const tracks = Array.isArray(record["tracks"]) ? record["tracks"].map((item) => {
        const track = item;
        return {
            net: String(track["net"] ?? ""), layer: String(track["layer"] ?? ""), width: num(track["width"]),
            x1: num(track["x1"]), y1: num(track["y1"]), x2: num(track["x2"]), y2: num(track["y2"]),
        };
    }) : [];
    return {
        ok: true, error: "",
        x0: num(record["x0"]), y0: num(record["y0"]),
        widthMm: num(record["widthMm"]), heightMm: num(record["heightMm"]),
        pads, tracks, notes: [],
    };
}
