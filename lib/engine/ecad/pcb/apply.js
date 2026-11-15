/** 生成交给 KiCad 自带 python 执行的脚本；坐标与板文件都从入参走。 */
export function buildApplyScript(request) {
    const payload = {
        boardFile: request.boardFile,
        keepTracks: request.keepTracks === true,
        items: request.plan.items.map((item) => ({ ref: item.ref, x: item.x, y: item.y, rotation: item.rotation })),
        board: request.plan.board,
    };
    return [
        "import json, sys, pcbnew",
        "payload = json.loads(sys.argv[1])",
        "board = pcbnew.LoadBoard(payload['boardFile'])",
        "by_ref = {fp.GetReference(): fp for fp in board.GetFootprints()}",
        "moved, missing = 0, []",
        "for item in payload['items']:",
        "    fp = by_ref.get(item['ref'])",
        "    if fp is None:",
        "        missing.append(item['ref'])",
        "        continue",
        "    fp.SetPosition(pcbnew.VECTOR2I(int(round(item['x'] * 1e6)), int(round(item['y'] * 1e6))))",
        "    fp.SetOrientationDegrees(item['rotation'])",
        "    moved += 1",
        "removed = 0",
        "if not payload['keepTracks']:",
        "    for track in list(board.GetTracks()):",
        "        board.Remove(track)",
        "        removed += 1",
        "pcbnew.SaveBoard(payload['boardFile'], board)",
        "with open(sys.argv[2], 'w', encoding='utf-8') as handle:",
        "    json.dump({'moved': moved, 'missing': missing, 'removedTracks': removed}, handle)",
    ].join("\n");
}
/** 从脚本输出里取结果；输出里没有 JSON 就按失败处理，不把"没报错"当成功。 */
export function parseApplyOutput(stdout) {
    const line = stdout
        .split(/\r?\n/u)
        .reverse()
        .find((row) => row.trim().startsWith("{") && row.includes("\"moved\""));
    if (line === undefined)
        return { ok: false, moved: 0, missing: [], removedTracks: 0 };
    try {
        const parsed = JSON.parse(line);
        return {
            ok: true,
            moved: typeof parsed.moved === "number" ? parsed.moved : 0,
            missing: Array.isArray(parsed.missing) ? parsed.missing : [],
            removedTracks: typeof parsed.removedTracks === "number" ? parsed.removedTracks : 0,
        };
    }
    catch {
        return { ok: false, moved: 0, missing: [], removedTracks: 0 };
    }
}
