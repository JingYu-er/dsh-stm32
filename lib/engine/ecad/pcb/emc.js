/**
 * EMC 与热的基础体检（S158）。
 *
 * 只看板子文件里**能证实**的东西，不猜：
 * - 电源线的载流能力（IPC-2221 外层 1 oz、温升 10 ℃ 的经验式）；
 * - 铺铜与参考平面是否有（决定回流路径与散热）；
 * - 换层过孔旁边有没有地过孔（回流路径是否连续）；
 * - 两层板的回流要额外提醒。
 *
 * 不做磁场仿真、不估结温——那需要器件功耗与热阻，板子文件里没有。
 */
/** 默认按网络名猜电流（A）：这些是「小家电级」的常见值，可以用 currentPerNet 覆盖。 */
export function defaultCurrentForNet(name) {
    if (/^VBUS|^VIN|^VBAT/iu.test(name))
        return 1;
    if (/^VCC|^VDD|^V3V3|^3V3|^5V/iu.test(name))
        return 0.5;
    if (/^GND|^VSS/iu.test(name))
        return 1;
    return 0;
}
/**
 * IPC-2221 外层走线：A[mil²] = (I / (k·ΔT^0.44))^(1/0.725)，k = 0.048（外层）。
 * 铜厚 1 oz = 1.37 mil，线宽 [mil] = A / 1.37。
 */
export function requiredWidthMm(currentA, deltaTc = 10, thicknessOz = 1) {
    if (currentA <= 0)
        return 0;
    const area = Math.pow(currentA / (0.048 * Math.pow(deltaTc, 0.44)), 1 / 0.725);
    const widthMil = area / (1.37 * thicknessOz);
    return Math.round((widthMil * 0.0254) * 1000) / 1000;
}
/** `(net 32 "V3V3")` 声明；`(net 32)` 是走线上的引用，不能当名字。 */
export function readNetNames(pcbText) {
    const names = new Map();
    for (const match of pcbText.matchAll(/\(net (\d+) "([^"]*)"\)/gu)) {
        const id = match[1] ?? "";
        if (id !== "")
            names.set(id, (match[2] ?? "").trim());
    }
    return names;
}
/**
 * 按平衡括号取顶层块：`(segment …)` 在真实 KiCad 文件里跨行，在测试夹具里可能是一行，
 * 所以不能靠「换行 + 右括号」判断结束。
 */
export function parenBlocks(text, head) {
    const blocks = [];
    const needle = "(" + head;
    let index = text.indexOf(needle);
    while (index >= 0) {
        let depth = 0;
        let end = index;
        for (let i = index; i < text.length; i += 1) {
            const ch = text[i];
            if (ch === "(")
                depth += 1;
            else if (ch === ")") {
                depth -= 1;
                if (depth === 0) {
                    end = i + 1;
                    break;
                }
            }
        }
        if (end <= index)
            break;
        blocks.push(text.slice(index, end));
        index = text.indexOf(needle, end);
    }
    return blocks;
}
function readSegments(pcbText) {
    const segments = [];
    for (const body of parenBlocks(pcbText, "segment")) {
        const start = /\(start ([-\d.]+) ([-\d.]+)\)/u.exec(body);
        const end = /\(end ([-\d.]+) ([-\d.]+)\)/u.exec(body);
        const width = /\(width ([-\d.]+)\)/u.exec(body);
        const layer = /\(layer "([^"]+)"\)|\(layer ([A-Za-z0-9_.]+)\)/u.exec(body);
        const net = /\(net (\d+)\)/u.exec(body);
        if (start === null || end === null || width === null || net === null)
            continue;
        segments.push({
            net: net[1] ?? "",
            width: Number(width[1]),
            layer: (layer?.[1] ?? layer?.[2] ?? "").trim(),
            x1: Number(start[1]),
            y1: Number(start[2]),
            x2: Number(end[1]),
            y2: Number(end[2]),
        });
    }
    return segments;
}
function readVias(pcbText) {
    const vias = [];
    for (const body of parenBlocks(pcbText, "via")) {
        const at = /\(at ([-\d.]+) ([-\d.]+)\)/u.exec(body);
        if (at === null)
            continue;
        vias.push({ x: Number(at[1]), y: Number(at[2]) });
    }
    return vias;
}
function readZones(pcbText) {
    const byLayer = {};
    const nets = new Set();
    for (const body of parenBlocks(pcbText, "zone")) {
        const layer = /\(layer "([^"]+)"\)|\(layer ([A-Za-z0-9_.]+)\)/u.exec(body);
        const name = (layer?.[1] ?? layer?.[2] ?? "").trim();
        if (name === "")
            continue;
        byLayer[name] = (byLayer[name] ?? 0) + 1;
        const net = /\(net (\d+)\)/u.exec(body);
        if (net !== null)
            nets.add(net[1] ?? "");
    }
    return { byLayer, nets };
}
function countCopper(pcbText) {
    // 只数 `(layers …)` 那一块：整篇扫会把走线的 `(layer "In2.Cu")` 也算进去。
    const block = parenBlocks(pcbText, "layers")[0] ?? "";
    const copper = new Set();
    for (const match of block.matchAll(/"((?:F|B|In\d+)\.Cu)"/gu))
        copper.add(match[1] ?? "");
    if (copper.size === 0) {
        for (const match of pcbText.matchAll(/"((?:F|B|In\d+)\.Cu)"/gu))
            copper.add(match[1] ?? "");
    }
    return copper.size === 0 ? 4 : copper.size;
}
function distance(ax, ay, bx, by) {
    return Math.hypot(ax - bx, ay - by);
}
export function analyzeEmc(pcbText, boardFile = "", currentPerNet = {}, 
/** 换层过孔旁多远处算「有地过孔」：默认 1.5 mm。 */
returnViaMm = 1.5) {
    const empty = {
        ok: false,
        error: "",
        boardFile,
        copperLayers: 0,
        nets: 0,
        zonesByLayer: {},
        powerTraces: [],
        findings: [],
        notes: [],
    };
    if (pcbText.trim() === "")
        return { ...empty, error: "板子文件是空的" };
    const names = readNetNames(pcbText);
    const segments = readSegments(pcbText);
    const vias = readVias(pcbText);
    const zones = readZones(pcbText);
    const copperLayers = countCopper(pcbText);
    // 电源网络：按名字认，取该网络最窄的一段与需要的线宽比。
    const powerTraces = [];
    const findings = [];
    const powerNetIds = new Set();
    for (const [id, name] of names) {
        const current = currentPerNet[name] ?? defaultCurrentForNet(name);
        if (current <= 0)
            continue;
        powerNetIds.add(id);
        const widths = segments.filter((segment) => segment.net === id).map((segment) => segment.width);
        if (widths.length === 0)
            continue;
        // 有整层铺铜的网络靠铜皮载流，不该拿最窄的一段走线判它不够宽。
        if (zones.nets.has(id))
            continue;
        const widthMm = Math.min(...widths);
        const requiredMm = requiredWidthMm(current);
        const ok = widthMm + 0.0005 >= requiredMm;
        powerTraces.push({ net: name, widthMm, requiredMm, currentA: current, ok });
        if (!ok) {
            findings.push({
                id: "emc.power-trace-width",
                severity: "warning",
                message: name + " 按 " + String(current) + " A 算需要 " + String(requiredMm) + " mm 线宽（外层 1 oz、温升 10 ℃），实际最窄 " + String(widthMm) + " mm",
                fix: "把这根线加宽到 " + String(requiredMm) + " mm 以上，或换到内层并增加铜厚；大电流回路尽量短。",
            });
        }
    }
    // 铺铜：四层板靠内层平面做参考与散热；两层板铺铜少就要靠走线。
    const zoneLayers = Object.keys(zones.byLayer);
    if (zoneLayers.length === 0) {
        findings.push({
            id: "emc.no-copper-pour",
            severity: "warning",
            message: "板子上没有任何铺铜区：回流路径与散热都只有走线",
            fix: "至少给 GND 铺一次整板铜（stm32_ecad_design 的 DFM 步会写 .kicad_dru，铺铜请用 KiCad 的 ZONE_FILLER 或 pcb_ipc refill）。",
        });
    }
    if (copperLayers <= 2) {
        findings.push({
            id: "emc.two-layer-return",
            severity: "info",
            message: "两层板：长距离高速线的回流要走同一层的地线或对面的铺铜",
            fix: "高速线（SPI/晶振/USB）不要跨过地线缺口；必要时沿线加地过孔缝合，或改四层板。",
        });
    }
    else {
        const innerPlanes = zoneLayers.filter((layer) => /^In\d+\.Cu$/u.test(layer));
        if (innerPlanes.length === 0) {
            findings.push({
                id: "emc.no-plane",
                severity: "warning",
                message: "四层板的两个内层都没有铺铜：等于四层信号、没有参考平面",
                fix: "把 In1 或 In2 整层铺 GND，作为回流参考面；铺完记得重铺（refill）。",
            });
        }
    }
    // 换层：同一坐标上顶层与底层都有线头，就是换层过孔；旁边没有地过孔则回流绕远。
    const layerSet = new Set(copperLayers <= 2 ? ["F.Cu", "B.Cu"] : ["F.Cu", "B.Cu", "In1.Cu", "In2.Cu"]);
    const endpoints = new Map();
    for (const segment of segments) {
        if (!layerSet.has(segment.layer))
            continue;
        for (const [x, y] of [[segment.x1, segment.y1], [segment.x2, segment.y2]]) {
            const key = x.toFixed(2) + ":" + y.toFixed(2);
            const layers = endpoints.get(key) ?? new Set();
            layers.add(segment.layer);
            endpoints.set(key, layers);
        }
    }
    // 地网络的线头先收集好：换层点附近有没有地过孔，就看这些点。
    const groundPoints = [];
    for (const segment of segments) {
        const name = names.get(segment.net) ?? "";
        if (!/^GND|^VSS/iu.test(name))
            continue;
        groundPoints.push([segment.x1, segment.y1], [segment.x2, segment.y2]);
    }
    let layerChanges = 0;
    let unstitched = 0;
    for (const [key, layers] of endpoints) {
        if (layers.size < 2)
            continue;
        layerChanges += 1;
        const [xs, ys] = key.split(":");
        const x = Number(xs);
        const y = Number(ys);
        const hasVia = vias.some((via) => distance(x, y, via.x, via.y) <= 0.3);
        if (!hasVia)
            continue;
        const nearGround = groundPoints.some(([gx, gy]) => distance(x, y, gx, gy) <= returnViaMm);
        if (!nearGround)
            unstitched += 1;
    }
    if (unstitched > 0) {
        findings.push({
            id: "emc.return-path-via",
            severity: "info",
            message: String(unstitched) + " 个换层过孔（共 " + String(layerChanges) + " 处换层）旁 " + String(returnViaMm) + " mm 内没有地过孔",
            fix: "换层处补一个地过孔做回流缝合，信号频率越高越要紧（SPI 时钟、USB、晶振）。",
        });
    }
    const notes = [];
    if (powerNetIds.size === 0)
        notes.push("没有按名字认出的电源网络：载流检查跳过");
    const named = [...names.values()].filter((name) => name !== "").length;
    if (named === 0)
        notes.push("板子里没有网络名（只有编号）：EMC 检查只能按几何做");
    return {
        ok: true,
        error: "",
        boardFile,
        copperLayers,
        nets: names.size,
        zonesByLayer: zones.byLayer,
        powerTraces,
        findings,
        notes,
    };
}
