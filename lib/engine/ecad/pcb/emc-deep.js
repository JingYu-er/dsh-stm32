/**
 * EMC 进阶体检（S167）：差分对间距、回流路径、并行串扰。
 *
 * 三条判据都只在「几何能证明」的范围内成立：
 * - 差分对间距：同一对两条线的最近距离，太近做不出目标阻抗、太远就不成对；
 * - 回流路径：信号线在参考层上有多少投影点落在接地铺铜之外（没有铺铜就明说无法判断）；
 * - 串扰：同层两条不同网络、间距小于阈值且并行长度超过阈值的线段。
 *
 * 不做场强、不做阻抗仿真——那需要叠层介电常数与频域模型，板子里没有。
 */
import { parenBlocks } from "./emc.js";
const EMPTY = {
    ok: false,
    error: "",
    boardFile: "",
    pairs: [],
    returnPaths: [],
    crosstalk: [],
    findings: [],
    notes: [],
};
/** 差分对的命名后缀；顺序有意义，先长后短。 */
const PAIR_SUFFIXES = [
    ["_POS", "_NEG"],
    ["_DP", "_DM"],
    ["_DP", "_DN"],
    ["_P", "_N"],
    ["+", "-"],
];
/** 这两条网络是不是同一对差分线：同一基准名、后缀一正一负。 */
function isPairOf(left, right) {
    for (const [positive, negative] of PAIR_SUFFIXES) {
        if (!left.endsWith(positive) || !right.endsWith(negative))
            continue;
        if (left.slice(0, left.length - positive.length) === right.slice(0, right.length - negative.length))
            return true;
    }
    return false;
}
/** 并行串扰的默认阈值：间距 < 0.2 mm、并行长度 ≥ 10 mm。 */
const GAP_MM = 0.2;
const PARALLEL_MM = 10;
export function analyzeEmcDeep(pcbText, boardFile) {
    try {
        const parsed = parseBoard(pcbText);
        if (!parsed.ok)
            return { ...EMPTY, boardFile, error: parsed.error };
        const notes = [...parsed.notes];
        const pairs = analyzePairs(parsed.segments, parsed.netNames);
        const returnPaths = analyzeReturnPaths(parsed.segments, parsed.zones, parsed.netNames);
        const crosstalk = analyzeCrosstalk(parsed.segments);
        const findings = [];
        for (const pair of pairs) {
            if (pair.samples === 0)
                continue;
            if (!pair.ok) {
                findings.push({
                    id: "emc.pair-spacing",
                    severity: "warning",
                    message: "差分对 " + pair.id + " 最近间距 " + String(pair.minMm) + " mm" +
                        (pair.minMm < 0.1 ? "（太近：做不出目标阻抗，也容易蚀刻偏差）" : "（太远：两条线不耦合，差分意义有限）"),
                    fix: "按叠层算出的目标间距重布这对线（stm32_stackup 给的是单端线宽，差分间距按目标阻抗另算）",
                });
            }
        }
        for (const path of returnPaths) {
            if (!path.ok) {
                findings.push({
                    id: "emc.return-path-gap",
                    severity: "warning",
                    message: "信号线在参考层 " + path.referenceLayer + " 上有 " + String(Math.round(path.ratio * 100)) + "% 的采样点落在铺铜外" +
                        (path.offPlane === 0 ? "" : "（" + String(path.offPlane) + " / " + String(path.onPlane + path.offPlane) + "）"),
                    fix: "补铺铜或调整走线，让每条高速线在参考层上都有连续的接地面",
                });
            }
        }
        for (const run of crosstalk) {
            if (run.ok)
                continue;
            findings.push({
                id: "emc.crosstalk",
                severity: "warning",
                message: "串扰风险：" + run.aggressor + " 与 " + run.victim + " 在 " + run.layer + " 并行 " + String(run.parallelMm) + " mm，间距 " + String(run.gapMm) + " mm",
                fix: "拉开间距到 3 倍线宽以上，或在中间加一根地线做隔离",
            });
        }
        if (parsed.segments.length === 0)
            notes.push("这块板没有走线：没什么可量的。");
        if (parsed.zones.length === 0 && !notes.some((note) => note.includes("只有轮廓")))
            notes.push("板上没有铺铜区：回流路径无法判断，不当作合格。");
        return {
            ok: true,
            error: "",
            boardFile,
            pairs,
            returnPaths,
            crosstalk,
            findings,
            notes,
        };
    }
    catch (error) {
        return { ...EMPTY, boardFile, error: "读不动这块板子：" + (error instanceof Error ? error.message : String(error)) };
    }
}
export function readEmcDeep(boardFile, readText) {
    try {
        return analyzeEmcDeep(readText(boardFile), boardFile);
    }
    catch (error) {
        return { ...EMPTY, boardFile, error: "读不到板子文件：" + (error instanceof Error ? error.message : String(error)) };
    }
}
function parseBoard(pcbText) {
    const notes = [];
    const netNames = new Map();
    for (const net of parenBlocks(pcbText, "net")) {
        const id = /\bnet\s+(\d+)\s+"([^"]*)"/u.exec(net);
        if (id !== null)
            netNames.set(Number(id[1]), id[2]);
    }
    const segments = [];
    for (const raw of parenBlocks(pcbText, "segment")) {
        const start = /\(start\s+(-?[\d.]+)\s+(-?[\d.]+)\)/u.exec(raw);
        const end = /\(end\s+(-?[\d.]+)\s+(-?[\d.]+)\)/u.exec(raw);
        const width = /\(width\s+(-?[\d.]+)\)/u.exec(raw);
        const layer = /\(layer\s+"?([A-Za-z0-9.]+)"?\)/u.exec(raw);
        const net = /\(net\s+(\d+)\)/u.exec(raw);
        if (start === null || end === null || layer === null)
            continue;
        const netId = net === null ? 0 : Number(net[1]);
        segments.push({
            net: netId,
            netName: netNames.get(netId) ?? "",
            layer: layer[1],
            x1: Number(start[1]),
            y1: Number(start[2]),
            x2: Number(end[1]),
            y2: Number(end[2]),
            width: width === null ? 0.25 : Number(width[1]),
        });
    }
    // 只认**已填充**的铜：`(polygon …)` 是铺铜的边界，`(filled_polygon …)` 才是真的铜皮。
    // 只有轮廓没有填充的板子（导出前没 refill）按未铺铜处理，并明说该先 refill。
    const zones = [];
    let outlinedZones = 0;
    for (const raw of parenBlocks(pcbText, "zone")) {
        const net = /\(net\s+(\d+)\)/u.exec(raw);
        const layer = /\(layer\s+"?([A-Za-z0-9.]+)"?\)/u.exec(raw);
        if (layer === null)
            continue;
        const netId = net === null ? 0 : Number(net[1]);
        const fills = parenBlocks(raw, "filled_polygon");
        if (fills.length === 0) {
            outlinedZones += 1;
            continue;
        }
        for (const fill of fills) {
            const fillLayer = /\(layer\s+"?([A-Za-z0-9.]+)"?\)/u.exec(fill);
            const points = [];
            for (const match of fill.matchAll(/\(xy\s+(-?[\d.]+)\s+(-?[\d.]+)\)/gu)) {
                points.push({ x: Number(match[1]), y: Number(match[2]) });
            }
            if (points.length < 3)
                continue;
            zones.push({
                net: netId,
                netName: netNames.get(netId) ?? "",
                layer: fillLayer === null ? layer[1] : fillLayer[1],
                points,
            });
        }
    }
    if (outlinedZones > 0)
        notes.push("有 " + String(outlinedZones) + " 个铺铜区只有轮廓、没有填充（导出前没 refill）：按未铺铜处理，先跑一次 stm32_pcb_ipc action=refill 再体检。");
    if (pcbText.indexOf("(kicad_pcb") < 0) {
        return { ok: false, error: "没有找到完整的 (kicad_pcb 块，文件可能被截断", segments: [], zones: [], netNames, notes };
    }
    if (parenBlocks(pcbText, "segment").length > 0 && segments.length === 0) {
        notes.push("有 segment 块但没解析出坐标：格式可能不是 KiCad 10。");
    }
    return { ok: true, error: "", segments, zones, netNames, notes };
}
function analyzePairs(segments, netNames) {
    const names = new Set();
    for (const segment of segments)
        if (segment.netName !== "")
            names.add(segment.netName);
    for (const name of netNames.values())
        if (name !== "")
            names.add(name);
    const pairs = [];
    const used = new Set();
    for (const [positive, negative] of PAIR_SUFFIXES) {
        for (const name of names) {
            if (!name.endsWith(positive))
                continue;
            const base = name.slice(0, name.length - positive.length);
            const counterpart = base + negative;
            if (!names.has(counterpart))
                continue;
            const id = base === "" ? name : base;
            if (used.has(id))
                continue;
            used.add(id);
            const pSegments = segments.filter((segment) => segment.netName === name);
            const nSegments = segments.filter((segment) => segment.netName === counterpart);
            const layers = [...new Set([...pSegments, ...nSegments].map((segment) => segment.layer))].sort();
            let minMm = Number.POSITIVE_INFINITY;
            let samples = 0;
            for (const a of pSegments) {
                for (const b of nSegments) {
                    if (a.layer !== b.layer)
                        continue;
                    const distance = segmentDistance(a, b);
                    samples += 1;
                    if (distance < minMm)
                        minMm = distance;
                }
            }
            if (samples === 0) {
                pairs.push({ id, positive: name, negative: counterpart, minMm: 0, layers, samples: 0, ok: false, note: "两条线没有画在同一个层上" });
                continue;
            }
            const rounded = Math.round(minMm * 1000) / 1000;
            const ok = rounded >= 0.1 && rounded <= 1;
            pairs.push({
                id,
                positive: name,
                negative: counterpart,
                minMm: rounded,
                layers,
                samples,
                ok,
                note: ok ? "" : rounded < 0.1 ? "两条线贴得太近" : "两条线离得太远，没有耦合",
            });
        }
    }
    return pairs;
}
function analyzeReturnPaths(segments, zones, netNames) {
    const groundZones = zones.filter((zone) => isGroundNet(zone.netName));
    if (groundZones.length === 0)
        return [];
    const planeLayers = [...new Set(groundZones.map((zone) => zone.layer))];
    const reports = [];
    for (const planeLayer of planeLayers) {
        const polygons = groundZones.filter((zone) => zone.layer === planeLayer).map((zone) => zone.points);
        // 离这层最近的信号层：外层取相邻内层，内层取上下相邻的信号层。
        const signalLayer = adjacentSignalLayer(planeLayer);
        const tracks = segments.filter((segment) => segment.layer === signalLayer);
        if (tracks.length === 0)
            continue;
        let onPlane = 0;
        let offPlane = 0;
        for (const track of tracks) {
            const length = Math.hypot(track.x2 - track.x1, track.y2 - track.y1);
            const steps = Math.max(1, Math.ceil(length));
            for (let index = 0; index <= steps; index += 1) {
                const t = index / steps;
                const x = track.x1 + (track.x2 - track.x1) * t;
                const y = track.y1 + (track.y2 - track.y1) * t;
                if (polygons.some((polygon) => pointInPolygon(x, y, polygon)))
                    onPlane += 1;
                else
                    offPlane += 1;
            }
        }
        const total = onPlane + offPlane;
        if (total === 0)
            continue;
        const ratio = offPlane / total;
        reports.push({
            referenceLayer: planeLayer,
            onPlane,
            offPlane,
            ratio: Math.round(ratio * 1000) / 1000,
            ok: ratio <= 0.2,
            note: signalLayer,
        });
    }
    void netNames;
    return reports;
}
function analyzeCrosstalk(segments) {
    const runs = [];
    for (let i = 0; i < segments.length; i += 1) {
        const a = segments[i];
        if (a.netName === "")
            continue;
        for (let j = i + 1; j < segments.length; j += 1) {
            const b = segments[j];
            if (a.layer !== b.layer || a.net === b.net || b.netName === "")
                continue;
            // 差分对内部两条线本来就贴着走：那是设计意图，不算串扰；串扰只看「与别的网络并行」。
            if (isPairOf(a.netName, b.netName) || isPairOf(b.netName, a.netName))
                continue;
            const gap = segmentDistance(a, b);
            if (gap >= GAP_MM)
                continue;
            const parallel = parallelRun(a, b);
            if (parallel < PARALLEL_MM)
                continue;
            runs.push({
                aggressor: a.netName,
                victim: b.netName,
                layer: a.layer,
                parallelMm: Math.round(parallel * 10) / 10,
                gapMm: Math.round(gap * 1000) / 1000,
                ok: false,
            });
        }
    }
    runs.sort((left, right) => right.parallelMm - left.parallelMm);
    // 同一对网络只留最严重的一条，避免刷屏。
    const seen = new Set();
    const unique = [];
    for (const run of runs) {
        const key = [run.aggressor, run.victim].sort().join("|") + "|" + run.layer;
        if (seen.has(key))
            continue;
        seen.add(key);
        unique.push(run);
        if (unique.length >= 10)
            break;
    }
    return unique;
}
/** 两条平行线沿走向的重叠长度（mm）。 */
function parallelRun(a, b) {
    const dx = a.x2 - a.x1;
    const dy = a.y2 - a.y1;
    const length = Math.hypot(dx, dy);
    if (length < 1e-6)
        return 0;
    const ux = dx / length;
    const uy = dy / length;
    const project = (x, y) => (x - a.x1) * ux + (y - a.y1) * uy;
    const ta1 = 0;
    const ta2 = length;
    const tb1 = project(b.x1, b.y1);
    const tb2 = project(b.x2, b.y2);
    const overlap = Math.min(Math.max(ta1, ta2), Math.max(tb1, tb2)) - Math.max(Math.min(ta1, ta2), Math.min(tb1, tb2));
    if (overlap <= 0)
        return 0;
    // 方向必须大致相同：反向并行的投影重叠是负值，上面已经排除；再查一次点积。
    const bLength = Math.hypot(b.x2 - b.x1, b.y2 - b.y1);
    if (bLength < 1e-6)
        return 0;
    const dot = ((b.x2 - b.x1) * ux + (b.y2 - b.y1) * uy) / bLength;
    return Math.abs(dot) < 0.9 ? 0 : overlap;
}
function segmentDistance(a, b) {
    const d1 = pointSegmentDistance(a.x1, a.y1, b);
    const d2 = pointSegmentDistance(a.x2, a.y2, b);
    const d3 = pointSegmentDistance(b.x1, b.y1, a);
    const d4 = pointSegmentDistance(b.x2, b.y2, a);
    return Math.min(d1, d2, d3, d4);
}
function pointSegmentDistance(px, py, segment) {
    const dx = segment.x2 - segment.x1;
    const dy = segment.y2 - segment.y1;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared < 1e-12)
        return Math.hypot(px - segment.x1, py - segment.y1);
    let t = ((px - segment.x1) * dx + (py - segment.y1) * dy) / lengthSquared;
    if (t < 0)
        t = 0;
    if (t > 1)
        t = 1;
    return Math.hypot(px - (segment.x1 + dx * t), py - (segment.y1 + dy * t));
}
function pointInPolygon(x, y, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
        const pi = polygon[i];
        const pj = polygon[j];
        if (pi.y > y !== pj.y > y && x < ((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y) + pi.x)
            inside = !inside;
    }
    return inside;
}
function isGroundNet(name) {
    return /^(?:GND|AGND|DGND|VSS|GND\d*|EARTH)$/u.test(name.trim());
}
function adjacentSignalLayer(planeLayer) {
    if (planeLayer === "In1.Cu")
        return "F.Cu";
    if (planeLayer === "In2.Cu")
        return "B.Cu";
    if (planeLayer === "In3.Cu")
        return "In4.Cu";
    if (planeLayer === "In4.Cu")
        return "In3.Cu";
    return "F.Cu";
}
