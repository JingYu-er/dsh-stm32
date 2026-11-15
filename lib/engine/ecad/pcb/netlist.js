const KIND_BY_PREFIX = [
    { pattern: /^U\d+/u, kind: "ic" },
    { pattern: /^(J|CN|P)\d+/u, kind: "connector" },
    { pattern: /^(SW|S)\d+/u, kind: "keys" },
    { pattern: /^(R|C|L|D|Q|F|FB|Y|X|TP|FID)\d+/u, kind: "passive" },
];
const KIND_BY_FOOTPRINT = [
    { pattern: /(U_chip|MCU|QFP|LQFP|TQFP|BGA|WLCSP|DFN|QFN)/iu, kind: "ic" },
    { pattern: /(connector|Conn_|USB|HDMI|FPC|JST)/iu, kind: "connector" },
    { pattern: /(SW_|switch|Button)/iu, kind: "keys" },
];
function kindOf(ref, footprint, pinCount) {
    for (const rule of KIND_BY_PREFIX) {
        if (rule.pattern.test(ref)) {
            if (rule.kind === "ic" && pinCount >= 24)
                return "mcu";
            return rule.kind;
        }
    }
    for (const rule of KIND_BY_FOOTPRINT) {
        if (rule.pattern.test(footprint) || rule.pattern.test(ref))
            return rule.kind;
    }
    return "other";
}
function asRecord(value) {
    return typeof value === "object" && value !== null ? value : {};
}
function num(value, fallback = 0) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function str(value) {
    return typeof value === "string" ? value : "";
}
/** 读 circuit.json 文本，得到放置与布线共用的模型。 */
export function readCircuitNetlist(circuitJsonText) {
    const empty = { ok: false, error: "", board: { width: 0, height: 0 }, parts: [], nets: [], notes: [] };
    let parsed;
    try {
        parsed = JSON.parse(circuitJsonText);
    }
    catch (error) {
        return { ...empty, error: "circuit.json 不是有效 JSON：" + (error instanceof Error ? error.message : String(error)) };
    }
    if (!Array.isArray(parsed))
        return { ...empty, error: "circuit.json 顶层不是数组：先跑一次构建" };
    const notes = [];
    const byId = new Map();
    const parts = {};
    const courtyards = new Map();
    const netByPort = new Map();
    const ports = [];
    let board = { width: 0, height: 0 };
    for (const element of parsed) {
        const record = asRecord(element);
        const type = str(record.type);
        if (type === "pcb_component" || type === "source_component" || type === "cad_component" || type === "pcb_board") {
            const id = str(record[type + "_id"]);
            if (id !== "")
                byId.set(id, record);
        }
        if (type === "pcb_courtyard_rect") {
            const parent = str(record.pcb_component_id);
            courtyards.set(parent, { width: num(record.width), height: num(record.height) });
        }
        if (type === "pcb_port")
            ports.push(record);
        if (type === "pcb_board") {
            board = { width: num(record.width), height: num(record.height) };
        }
        if (type === "source_trace") {
            const name = str(record.display_name);
            for (const portId of record.connected_source_port_ids ?? []) {
                if (typeof portId === "string")
                    netByPort.set(portId, name);
            }
        }
    }
    // 先用 pcb_component 建元件骨架，再从 source_component 补位号与立创编号。
    for (const [id, record] of byId) {
        if (str(record.type) !== "pcb_component")
            continue;
        void id;
        const sourceId = str(record.source_component_id);
        const source = byId.get(sourceId);
        const ref = str(source?.name) === "" ? sourceId : str(source?.name);
        const cad = byId.get(str(record.pcb_component_id) === "" ? "" : sourceId);
        void cad;
        const courtyard = courtyards.get(str(record.pcb_component_id)) ?? { width: num(record.width), height: num(record.height) };
        const jlc = asRecord(source?.supplier_part_numbers)["jlcpcb"];
        const part = {
            ref,
            kind: "other",
            width: num(record.width),
            height: num(record.height),
            courtyardWidth: courtyard.width,
            courtyardHeight: courtyard.height,
            layer: str(record.layer) === "bottom" ? "bottom" : "top",
            pinCount: 0,
            jlcpcb: Array.isArray(jlc) && typeof jlc[0] === "string" ? jlc[0] : "",
            footprint: str(record.footprint) === "" ? str(asRecord(byId.get(sourceId)).footprinter_string) : str(record.footprint),
        };
        parts[ref] = part;
    }
    // 引脚：pcb_port 的坐标是元件中心系，直接存相对量。
    const nets = new Map();
    for (const port of ports) {
        const pcbComponentId = str(port.pcb_component_id);
        const parent = byId.get(pcbComponentId);
        if (parent === undefined)
            continue;
        const sourceId = str(parent.source_component_id);
        const ref = str(byId.get(sourceId)?.name) === "" ? sourceId : str(byId.get(sourceId)?.name);
        const part = parts[ref];
        if (part === undefined)
            continue;
        const net = netByPort.get(str(port.source_port_id)) ?? "";
        const number = part.pinCount + 1;
        part.pinCount = number;
        if (net === "")
            continue;
        const list = nets.get(net) ?? [];
        list.push({ ref, number });
        nets.set(net, list);
    }
    for (const part of Object.values(parts)) {
        part.kind = kindOf(part.ref, part.footprint, part.pinCount);
    }
    const partsList = Object.values(parts).sort((a, b) => a.ref.localeCompare(b.ref));
    if (partsList.length === 0)
        notes.push("circuit.json 里没有元件：先写 hardware/circuit/*.circuit.tsx 再构建");
    if (board.width === 0 || board.height === 0) {
        const area = partsList.reduce((sum, p) => sum + p.courtyardWidth * p.courtyardHeight, 0);
        const side = Math.max(30, Math.ceil(Math.sqrt(area * 2.2) / 5) * 5);
        board = { width: side, height: side };
        notes.push("circuit.json 里没有板框尺寸，按元件面积估算 " + String(side) + "×" + String(side) + " mm");
    }
    return {
        ok: true,
        error: "",
        board,
        parts: partsList,
        nets: [...nets.entries()].map(([name, pins]) => ({ name, pins })).sort((a, b) => a.name.localeCompare(b.name)),
        notes,
    };
}
