/**
 * 布线进阶体检（S165）：差分对、平面层、去耦距离。
 *
 * 三件事都只回答「板子上现在是什么样」，不改板子：
 *
 *   1. 差分对：按网络名认出成对的网络，算两条线的长度、过孔数、长度差；
 *   2. 平面层：每层是否有铺铜、上面还有多少条信号线（平面被割裂的直接证据）；
 *   3. 去耦距离：两脚电容的电源脚到同网络最近引脚的距离。
 *
 * 认不出成对网络、板上没有电容、没有铺铜层，都如实说「没有」，不猜、不补零。
 */
import { readFileSync } from "node:fs";
import { parenBlocks } from "./emc.js";
import { inferVoltage } from "./power.js";
const EMPTY = {
    ok: false,
    error: "",
    boardFile: "",
    copperLayers: 0,
    pairs: [],
    decaps: [],
    planes: [],
    findings: [],
    notes: [],
};
/** 读一块板并做三项体检。读不到或读不懂都回 `ok:false`，不抛。 */
export function readLinks(boardFile, options = {}) {
    let text = "";
    try {
        text = readFileSync(boardFile, "utf8");
    }
    catch (error) {
        return { ...EMPTY, boardFile, error: "读不到板子文件：" + (error instanceof Error ? error.message : String(error)) };
    }
    return analyzeLinks(text, boardFile, options);
}
export function analyzeLinks(pcbText, boardFile, options = {}) {
    const toleranceMm = options.toleranceMm ?? 0.5;
    const decapLimitMm = options.decapMm ?? 5;
    let parsed;
    try {
        parsed = parseBoard(pcbText);
    }
    catch (error) {
        return { ...EMPTY, boardFile, error: "读不懂这个 .kicad_pcb：" + (error instanceof Error ? error.message : String(error)) };
    }
    const pairs = analyzePairs(parsed, toleranceMm);
    const decaps = analyzeDecaps(parsed, decapLimitMm);
    const planes = analyzePlanes(parsed);
    const findings = [];
    for (const pair of pairs) {
        if (!pair.ok && (!pair.routedP || !pair.routedN)) {
            findings.push({
                id: "pair.not-routed",
                severity: "warning",
                message: pair.id + "：还有一半没布线（" + (pair.routedP ? pair.negative : pair.positive) + " 没有走线）",
                fix: "跑一次 stm32_pcb_autoroute，或在 KiCad 里手工补这一半。",
            });
        }
        else if (!pair.ok) {
            findings.push({
                id: "pair.length-skew",
                severity: "warning",
                message: pair.id + "：两条线相差 " + pair.deltaMm.toFixed(2) + " mm（上限 " + String(toleranceMm) + " mm）",
                fix: "在 KiCad 里对短线做蛇形补偿，或把差分对当普通网络重新布。",
            });
        }
    }
    for (const plane of planes) {
        if (plane.planeNets.length > 0 && plane.trackCount > 0) {
            findings.push({
                id: "plane.signals-on-plane-layer",
                severity: "warning",
                message: plane.layer + " 铺了 " + plane.planeNets.join("、") + " 平面，但这一层还有 " + String(plane.trackCount) + " 段信号线",
                fix: "信号改走外层或另开信号层；平面被割得越碎，回流越绕。",
            });
        }
    }
    const innerSignalOnly = planes.filter((plane) => plane.planeNets.length === 0 && plane.trackCount > 0);
    if (parsed.copperLayers >= 4 && planes.every((plane) => plane.planeNets.length === 0)) {
        findings.push({
            id: "plane.no-inner-pour",
            severity: "warning",
            message: "四层以上的板，内层一段铺铜都没有" + (innerSignalOnly.length > 0 ? "（内层全在走信号）" : ""),
            fix: "至少把一层内层铺成 GND 平面；没有参考平面的四层板等于四层信号板。",
        });
    }
    for (const decap of decaps) {
        if (!decap.ok) {
            findings.push({
                id: "decap.too-far",
                severity: "info",
                message: decap.ref + " 的 " + decap.powerNet + " 脚离最近的负载引脚 " + decap.distanceMm.toFixed(2) + " mm（建议 ≤ " + String(decapLimitMm) + " mm）",
                fix: "把电容挪到引脚旁边，或让电源先从电容经过再进引脚。",
            });
        }
    }
    const notes = [];
    if (pairs.length === 0)
        notes.push("没有认出差分对：网络名里没有 _P/_N、+/-、DP/DM、CANH/CANL 这类成对后缀。");
    if (decaps.length === 0)
        notes.push("没有找到两脚去耦电容：需要一个脚在 GND、另一个脚在电源网络上的两脚元件。");
    if (planes.every((plane) => plane.planeNets.length === 0))
        notes.push("板上没有任何铺铜区：平面层体检无对象。");
    return {
        ok: true,
        error: "",
        boardFile,
        copperLayers: parsed.copperLayers,
        pairs,
        decaps,
        planes,
        findings,
        notes,
    };
}
function parseBoard(text) {
    // 顶层块取不到就是文件截断或根本不是板子：此时回空报告比回「一切正常」安全。
    if (!text.includes("(kicad_pcb") || parenBlocks(text, "kicad_pcb").length === 0) {
        throw new Error("没有找到完整的 (kicad_pcb 块，文件可能被截断");
    }
    const nets = new Map();
    for (const block of parenBlocks(text, "net")) {
        const m = /^\(net (\d+) "([^"]*)"\)$/u.exec(block.trim());
        if (m !== null)
            nets.set(m[1], m[2]);
    }
    const nameOf = (raw) => nets.get(raw) ?? "#" + raw;
    const padByNet = new Map();
    const parts = [];
    for (const block of parenBlocks(text, "footprint")) {
        const ref = first(block, /\(property "Reference" "([^"]+)"/u) ?? first(block, /\(fp_text reference "([^"]+)"/u) ?? "";
        const value = first(block, /\(property "Value" "([^"]+)"/u) ?? first(block, /\(fp_text value "([^"]+)"/u) ?? "";
        const at = /\(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)/u.exec(block);
        if (at === null)
            continue;
        const fx = Number(at[1]);
        const fy = Number(at[2]);
        const fr = Number(at[3] ?? "0");
        const pads = [];
        for (const padBlock of parenBlocks(block, "pad")) {
            const number = first(padBlock, /^\(pad "([^"]*)"/u);
            const net = first(padBlock, /\(net (\d+)/u);
            const padAt = /\(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)/u.exec(padBlock);
            if (number === null || net === null || padAt === null)
                continue;
            const point = rotate(Number(padAt[1]), Number(padAt[2]), fr);
            const pad = { ref, number, net: nameOf(net), x: fx + point.x, y: fy + point.y };
            pads.push(pad);
            const list = padByNet.get(pad.net) ?? [];
            list.push(pad);
            padByNet.set(pad.net, list);
        }
        if (pads.length > 0)
            parts.push({ ref, value, pads });
    }
    const segments = [];
    for (const block of parenBlocks(text, "segment")) {
        const start = /\(start ([-\d.]+) ([-\d.]+)\)/u.exec(block);
        const end = /\(end ([-\d.]+) ([-\d.]+)\)/u.exec(block);
        const layer = first(block, /\(layer "?([^)"]+)"?\)/u);
        const net = first(block, /\(net (\d+)/u);
        if (start === null || end === null || layer === null || net === null)
            continue;
        segments.push({
            net: nameOf(net),
            layer,
            x1: Number(start[1]),
            y1: Number(start[2]),
            x2: Number(end[1]),
            y2: Number(end[2]),
        });
    }
    const viaCountByNet = new Map();
    for (const block of parenBlocks(text, "via")) {
        const net = first(block, /\(net (\d+)/u);
        if (net === null)
            continue;
        const name = nameOf(net);
        viaCountByNet.set(name, (viaCountByNet.get(name) ?? 0) + 1);
    }
    const zones = [];
    for (const block of parenBlocks(text, "zone")) {
        const net = first(block, /\(net (\d+)/u);
        const layer = first(block, /\(layer "?([^)"]+)"?\)/u);
        if (net !== null && layer !== null)
            zones.push({ net: nameOf(net), layer });
    }
    const layersBlock = parenBlocks(text, "layers")[0] ?? "";
    const copperLayers = new Set([...layersBlock.matchAll(/"((?:F|B|In\d+)\.Cu)"/gu)].map((m) => m[1])).size;
    return {
        copperLayers: copperLayers === 0 ? 2 : copperLayers,
        netNames: [...nets.values()].filter((name) => name !== ""),
        padByNet,
        segments,
        viaCountByNet,
        zones,
        parts,
    };
}
function analyzePairs(parsed, toleranceMm) {
    // 差分对要看「声明过的网络名」：一对线可能只出现走线里（焊盘上只有电气连接）。
    const names = [...new Set([...parsed.netNames, ...parsed.padByNet.keys()])];
    const byBase = new Map();
    for (const name of names) {
        const found = pairSuffix(name);
        if (found === null)
            continue;
        const existing = byBase.get(found.base);
        if (existing === undefined) {
            byBase.set(found.base, found.polarity === "P" ? { positive: name, negative: "" } : { positive: "", negative: name });
        }
        else if (found.polarity === "P") {
            existing.positive = name;
        }
        else {
            existing.negative = name;
        }
    }
    const reports = [];
    for (const [base, pair] of byBase) {
        if (pair.positive === "" || pair.negative === "")
            continue;
        const lengthP = netLength(parsed, pair.positive);
        const lengthN = netLength(parsed, pair.negative);
        const routedP = lengthP > 0;
        const routedN = lengthN > 0;
        const deltaMm = Math.abs(lengthP - lengthN);
        const viasP = parsed.viaCountByNet.get(pair.positive) ?? 0;
        const viasN = parsed.viaCountByNet.get(pair.negative) ?? 0;
        const notes = [];
        if (routedP && routedN && viasP !== viasN)
            notes.push("两条线的过孔数不同（" + String(viasP) + " vs " + String(viasN) + "），回流路径不对称");
        reports.push({
            id: base,
            positive: pair.positive,
            negative: pair.negative,
            routedP,
            routedN,
            lengthPMm: round(lengthP),
            lengthNMm: round(lengthN),
            deltaMm: round(deltaMm),
            viasP,
            viasN,
            ok: routedP && routedN && deltaMm <= toleranceMm,
            notes,
        });
    }
    reports.sort((a, b) => a.id.localeCompare(b.id));
    return reports;
}
function analyzeDecaps(parsed, limitMm) {
    const reports = [];
    // 只认位号以 C 开头的两脚件：电源与地之间的电池、跳线也会「跨在」两个网络上，
    // 但它们不是去耦电容，按距离评它们会得出误导的结论。
    const capRefs = new Set(parsed.parts
        .filter((part) => /^C\d/u.test(part.ref) && part.pads.length === 2)
        .map((part) => part.ref));
    // 两脚件（电容、电阻、电池）都不是「负载」，去耦要对准的是 IC 的电源脚。
    const passiveRefs = new Set(parsed.parts.filter((part) => part.pads.length <= 2).map((part) => part.ref));
    for (const part of parsed.parts) {
        if (!capRefs.has(part.ref))
            continue;
        if (part.pads.length !== 2)
            continue;
        const ground = part.pads.find((pad) => /^(GND|VSS)/u.test(pad.net));
        const power = part.pads.find((pad) => pad !== ground && inferVoltage(pad.net) !== null);
        if (ground === undefined || power === undefined)
            continue;
        // 负载引脚优先：同网络的 IC 引脚才算「去耦要对准的地方」；
        // 另一个电容的引脚不是负载，先排除，实在没有引脚再看全部。
        const sameNet = (parsed.padByNet.get(power.net) ?? []).filter((pad) => pad.ref !== part.ref);
        const loadPins = sameNet.filter((pad) => !passiveRefs.has(pad.ref));
        const others = loadPins.length > 0 ? loadPins : sameNet;
        if (others.length === 0) {
            reports.push({
                ref: part.ref,
                value: part.value,
                powerNet: power.net,
                groundNet: ground.net,
                distanceMm: 0,
                nearestRef: "",
                ok: true,
                note: "这个电源网络没有别的引脚：可能是孤立网络，或只有这一段铺铜。",
            });
            continue;
        }
        let best = others[0];
        let bestD = distance(power, best);
        for (const other of others) {
            const d = distance(power, other);
            if (d < bestD) {
                bestD = d;
                best = other;
            }
        }
        reports.push({
            ref: part.ref,
            value: part.value,
            powerNet: power.net,
            groundNet: ground.net,
            distanceMm: round(bestD),
            nearestRef: best.ref,
            ok: bestD <= limitMm,
            note: bestD > limitMm ? "离负载引脚偏远：高频去耦会失效" : "",
        });
    }
    reports.sort((a, b) => b.distanceMm - a.distanceMm);
    return reports;
}
function analyzePlanes(parsed) {
    const layers = new Set(["F.Cu", "B.Cu"]);
    for (const zone of parsed.zones)
        layers.add(zone.layer);
    for (const seg of parsed.segments)
        layers.add(seg.layer);
    const order = (layer) => {
        if (layer === "F.Cu")
            return -1;
        if (layer === "B.Cu")
            return 10_000;
        const m = /^In(\d+)\.Cu$/u.exec(layer);
        return m === null ? 500 : Number(m[1]);
    };
    return [...layers]
        .sort((a, b) => order(a) - order(b))
        .map((layer) => {
        const planeNets = [...new Set(parsed.zones.filter((zone) => zone.layer === layer).map((zone) => zone.net))];
        const onLayer = parsed.segments.filter((seg) => seg.layer === layer);
        return {
            layer,
            planeNets,
            trackCount: onLayer.length,
            signalNets: [...new Set(onLayer.map((seg) => seg.net))].slice(0, 8),
        };
    });
}
function netLength(parsed, net) {
    let total = 0;
    for (const seg of parsed.segments) {
        if (seg.net !== net)
            continue;
        total += Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1);
    }
    return total;
}
function pairSuffix(name) {
    const table = [
        [/_P$/u, "P"],
        [/_N$/u, "N"],
        [/_DP$/u, "P"],
        [/_DM$/u, "N"],
        [/_DN$/u, "N"],
        [/_POS$/u, "P"],
        [/_NEG$/u, "N"],
        [/\+$/u, "P"],
        [/-$/u, "N"],
    ];
    for (const [pattern, polarity] of table) {
        if (!pattern.test(name))
            continue;
        const base = name.replace(pattern, "");
        if (base !== "" && base !== name)
            return { base, polarity: polarity };
    }
    if (/DP$/u.test(name) && !/_DP$/u.test(name))
        return { base: name.slice(0, -2), polarity: "P" };
    if (/DM$/u.test(name) && !/_DM$/u.test(name))
        return { base: name.slice(0, -2), polarity: "N" };
    if (/CANH$/u.test(name))
        return { base: name.slice(0, -4), polarity: "P" };
    if (/CANL$/u.test(name))
        return { base: name.slice(0, -4), polarity: "N" };
    return null;
}
function first(text, pattern) {
    const m = pattern.exec(text);
    return m === null ? null : m[1];
}
function rotate(dx, dy, deg) {
    if (deg === 0)
        return { x: dx, y: dy };
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
}
function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}
function round(value) {
    return Math.round(value * 100) / 100;
}
