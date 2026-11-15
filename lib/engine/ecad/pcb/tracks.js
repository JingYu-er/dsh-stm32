export function buildTrackScript(boardFile, segments, dryRun, vias = []) {
    return [
        "import json, sys",
        "import pcbnew",
        "board = pcbnew.LoadBoard(" + JSON.stringify(boardFile) + ")",
        "with open(sys.argv[1], encoding='utf-8') as handle:",
        "    payload = json.load(handle)",
        "units = 1000000.0",
        "def mm(value): return int(round(value * units))",
        "added = 0",
        "skipped = 0",
        "layer_map = {'F.Cu': pcbnew.F_Cu, 'B.Cu': pcbnew.B_Cu}",
        "for item in payload['segments']:",
        "    net = board.FindNet(item['net'])",
        "    if net is None:",
        "        skipped += 1",
        "        continue",
        "    layer = layer_map.get(item['layer'], pcbnew.F_Cu)",
        "    track = pcbnew.PCB_TRACK(board)",
        "    track.SetStart(pcbnew.VECTOR2I(mm(item['x1']), mm(item['y1'])))",
        "    track.SetEnd(pcbnew.VECTOR2I(mm(item['x2']), mm(item['y2'])))",
        "    track.SetWidth(mm(item['widthMm']))",
        "    track.SetLayer(layer)",
        "    track.SetNet(net)",
        "    if not payload['dryRun']:",
        "        board.Add(track)",
        "    added += 1",
        "added_vias = 0",
        "for item in payload.get('vias', []):",
        "    net = board.FindNet(item['net'])",
        "    if net is None:",
        "        skipped += 1",
        "        continue",
        "    via = pcbnew.PCB_VIA(board)",
        "    via.SetPosition(pcbnew.VECTOR2I(mm(item['x']), mm(item['y'])))",
        "    via.SetDrill(mm(item['drillMm']))",
        "    via.SetWidth(mm(item['diameterMm']))",
        "    via.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)",
        "    via.SetNet(net)",
        "    if not payload['dryRun']:",
        "        board.Add(via)",
        "    added_vias += 1",
        "if not payload['dryRun']:",
        "    pcbnew.SaveBoard(payload['boardFile'], board)",
        "with open(sys.argv[2], 'w', encoding='utf-8') as handle:",
        "    json.dump({'added': added, 'skipped': skipped, 'vias': added_vias}, handle)",
    ].join("\n");
}
export function parseTrackReport(text) {
    const empty = { ok: false, error: "", added: 0, skipped: 0, vias: 0 };
    const trimmed = text.trim();
    if (trimmed === "")
        return { ...empty, error: "没有写出走线结果文件" };
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch {
        return { ...empty, error: "走线结果不是合法 JSON" };
    }
    if (typeof parsed !== "object" || parsed === null)
        return { ...empty, error: "走线结果不是对象" };
    const record = parsed;
    return {
        ok: true, error: "",
        added: typeof record["added"] === "number" ? record["added"] : 0,
        skipped: typeof record["skipped"] === "number" ? record["skipped"] : 0,
        vias: typeof record["vias"] === "number" ? record["vias"] : 0,
    };
}
