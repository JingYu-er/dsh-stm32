/**
 * 电源与地布线（S140）。
 *
 * 几何在 pcbnew 里算：焊盘坐标只有 KiCad 知道，搬回 TS 再算一遍等于重写一份
 * 封装几何。这里只生成脚本并解析脚本写回的 JSON。
 */
export interface RouteRequest {
  boardFile: string;
  powerNets: string[];
  powerWidthMm: number;
  planeNet: string;
  planeLayer: string;
  planeClearanceMm: number;
  keepTracks: boolean;
  /** 只算不写：默认预览，等避开障碍的布线器落地后再允许真正写板。 */
  dryRun?: boolean;
}

export interface RouteReport {
  ok: boolean;
  error: string;
  tracks: number;
  vias: number;
  nets: { net: string; pads: number; segments: number }[];
  plane: { net: string; layer: string; filled: boolean } | null;
  notes: string[];
}

export const DEFAULT_POWER_NETS = ["GND", "VCC", "VDD", "+3V3", "3V3", "+5V", "5V", "VBUS", "VSS"];

export function buildRouteScript(request: RouteRequest): string {
  return [
    "import json, math, sys",
    "import pcbnew",
    "payload = json.loads(sys.argv[1])",
    "board = pcbnew.LoadBoard(payload['boardFile'])",
    "units = 1000000.0",
    "def mm(value): return int(round(value * units))",
    "def to_mm(value): return round(value / units, 4)",
    "notes = []",
    "if not payload['keepTracks']:",
    "    for track in list(board.GetTracks()):",
    "        board.Remove(track)",
    "wanted = set(payload['powerNets'])",
    "groups = {}",
    "for footprint in board.GetFootprints():",
    "    for pad in footprint.Pads():",
    "        net = pad.GetNetname()",
    "        if net not in wanted:",
    "            continue",
    "        groups.setdefault(net, []).append((footprint.GetReference(), pad.GetNumber(), pad.GetPosition()))",
    "report = []",
    "added = 0",
    "vias = 0",
    "",
    "def segments(src, dst):",
    "    dx = dst[0] - src[0]",
    "    dy = dst[1] - src[1]",
    "    adx, ady = abs(dx), abs(dy)",
    "    if adx < 2 and ady < 2:",
    "        return [src, dst]",
    "    if adx > ady:",
    "        corner = (dst[0] - (1 if dx > 0 else -1) * ady, src[1])",
    "    else:",
    "        corner = (src[0], dst[1] - (1 if dy > 0 else -1) * adx)",
    "    return [src, corner, dst]",
    "",
    "dryRun = bool(payload.get('dryRun', True))",
    "for net, pads in groups.items():",
    "    if len(pads) < 2:",
    "        continue",
    "    netinfo = board.FindNet(net)",
    "    if netinfo is None:",
    "        notes.append(net + '：板子里没有这个网络')",
    "        continue",
    "    width = mm(0.5 if net not in ('GND', 'VSS') else 0.5)",
    "    layer = pcbnew.F_Cu",
    "    remaining = list(range(1, len(pads)))",
    "    built = [0]",
    "    count = 0",
    "    while remaining:",
    "        best = None",
    "        for i in built:",
    "            for j in remaining:",
    "                a, b = pads[i][2], pads[j][2]",
    "                dist = abs(a.x - b.x) + abs(a.y - b.y)",
    "                if best is None or dist < best[0]:",
    "                    best = (dist, i, j)",
    "        _, i, j = best",
    "        src = (pads[i][2].x, pads[i][2].y)",
    "        dst = (pads[j][2].x, pads[j][2].y)",
    "        points = segments(src, dst)",
    "        for k in range(len(points) - 1):",
    "            track = pcbnew.PCB_TRACK(board)",
    "            track.SetStart(pcbnew.VECTOR2I(int(points[k][0]), int(points[k][1])))",
    "            track.SetEnd(pcbnew.VECTOR2I(int(points[k + 1][0]), int(points[k + 1][1])))",
    "            track.SetWidth(width)",
    "            track.SetLayer(layer)",
    "            track.SetNet(netinfo)",
    "            if not dryRun:",
    "                board.Add(track)",
    "            added += 1",
    "            count += 1",
    "        built.append(j)",
    "        remaining.remove(j)",
    "    report.append({'net': net, 'pads': len(pads), 'segments': count})",
    "",
    "plane = None",
    "planeNet = payload['planeNet']",
    "if planeNet:",
    "    zones = list(board.Zones())",
    "    if zones:",
    "        filler = pcbnew.ZONE_FILLER(board)",
    "        filler.Fill(board.Zones())",
    "        plane = {'net': planeNet, 'layer': payload['planeLayer'], 'filled': True}",
    "    else:",
    "        notes.append('板上没有铺铜区：先在导出时写入 GND 区')",
    "pcbnew.SaveBoard(payload['boardFile'], board)",
    "result = {'tracks': added, 'vias': vias, 'nets': report, 'plane': plane, 'notes': notes}",
    "with open(sys.argv[2], 'w', encoding='utf-8') as handle:",
    "    json.dump(result, handle)",
  ].join("\n");
}


export interface GroundZonePlan {
  ok: boolean;
  error: string;
  text: string;
  net: string;
  netNumber: number;
  layer: string;
  rect: { x0: number; y0: number; x1: number; y1: number };
}

/** 在 `.kicad_pcb` 文本里补一块 GND 铺铜区（填充交给 pcbnew 的 ZONE_FILLER）。 */
export function appendGroundZone(
  pcbText: string,
  bounds: { x0: number; y0: number; x1: number; y1: number },
  options: { net?: string; layer?: string; marginMm?: number } = {},
): GroundZonePlan {
  const net = options.net ?? "GND";
  const layer = options.layer ?? "B.Cu";
  const margin = options.marginMm ?? 0.5;
  const escaped = net.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const numbered = new RegExp('\\(net\\s+(\\d+)\\s+"' + escaped + '"\\)', "u").exec(pcbText);
  const bare = new RegExp('\\(net\\s+"' + escaped + '"\\)', "u").test(pcbText);
  if (numbered === null) {
    const reason = bare
      ? "网络表里只有网络名、没有编号（tscircuit 导出的格式），暂时无法写入铺铜区；GND 先用加粗走线连接"
      : "板子里没有网络：" + net;
    return { ok: false, error: reason, text: pcbText, net, netNumber: 0, layer, rect: { x0: 0, y0: 0, x1: 0, y1: 0 } };
  }
  const netNumber = Number(numbered[1]);
  const rect = { x0: bounds.x0 + margin, y0: bounds.y0 + margin, x1: bounds.x1 - margin, y1: bounds.y1 - margin };
  const zone = [
    "  (zone",
    '    (net ' + String(netNumber) + ')',
    '    (net_name "' + net + '")',
    '    (layer "' + layer + '")',
    "    (hatch edge 0.5)",
    "    (connect_pads yes)",
    "    (min_thickness 0.25)",
    "    (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))",
    "    (polygon",
    "      (pts",
    "        (xy " + rect.x0.toFixed(3) + " " + rect.y0.toFixed(3) + ")",
    "        (xy " + rect.x1.toFixed(3) + " " + rect.y0.toFixed(3) + ")",
    "        (xy " + rect.x1.toFixed(3) + " " + rect.y1.toFixed(3) + ")",
    "        (xy " + rect.x0.toFixed(3) + " " + rect.y1.toFixed(3) + ")",
    "        (xy " + rect.x0.toFixed(3) + " " + rect.y0.toFixed(3) + ")",
    "      )",
    "    )",
    "  )",
    "",
  ].join("\n");
  const close = pcbText.lastIndexOf(")");
  if (close < 0) return { ok: false, error: "板文件不完整", text: pcbText, net, netNumber, layer, rect };
  const text = pcbText.slice(0, close) + zone + pcbText.slice(close);
  return { ok: true, error: "", text, net, netNumber, layer, rect };
}

export function parseRouteOutput(text: string): RouteReport {
  const empty: RouteReport = { ok: false, error: "", tracks: 0, vias: 0, nets: [], plane: null, notes: [] };
  const trimmed = text.trim();
  if (trimmed === "") return { ...empty, error: "没有写出布线结果文件" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ...empty, error: "布线结果不是合法 JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) return { ...empty, error: "布线结果不是对象" };
  const record = parsed as Record<string, unknown>;
  const nets = Array.isArray(record["nets"]) ? record["nets"] as RouteReport["nets"] : [];
  const planeRaw = record["plane"];
  const plane = typeof planeRaw === "object" && planeRaw !== null
    ? planeRaw as RouteReport["plane"]
    : null;
  return {
    ok: true,
    error: "",
    tracks: typeof record["tracks"] === "number" ? record["tracks"] : 0,
    vias: typeof record["vias"] === "number" ? record["vias"] : 0,
    nets,
    plane,
    notes: Array.isArray(record["notes"]) ? record["notes"].map((item) => String(item)) : [],
  };
}
