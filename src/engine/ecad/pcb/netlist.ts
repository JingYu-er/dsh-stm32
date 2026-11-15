/**
 * 从 circuit.json 读 PCB 侧需要的模型（S138）。
 *
 * 放置与布线只关心四件事：板上有什么、各自多大、谁跟谁连、板子多大。
 * circuit.json 里这些信息分散在 source_component / pcb_component / pcb_courtyard_rect /
 * pcb_port / source_trace 里，这里合并成一份扁平模型，供放置与布线共用。
 */
export interface CircuitPin {
  /** 所属元件位号。 */
  ref: string;
  /** 引脚编号，来自 pcb_port。 */
  number: number;
  /** 网络名；未命名的网络在 circuit.json 里只有 display_name。 */
  net: string;
  /** 元件中心到引脚的相对坐标（mm）。 */
  dx: number;
  dy: number;
}

export interface CircuitPart {
  ref: string;
  /** 功能分类，决定放置分区。 */
  kind: PartKind;
  /** 封装外部尺寸（mm），取自 pcb_component.width/height。 */
  width: number;
  height: number;
  /** courtyard 尺寸（mm），缺失时退回 width/height。 */
  courtyardWidth: number;
  courtyardHeight: number;
  layer: "top" | "bottom";
  /** 引脚数；没有 pcb_port 的元素为 0。 */
  pinCount: number;
  /** 立创编号（有就记下来，供器件表与采购用）。 */
  jlcpcb: string;
  /** 封装标识（kicad 库名或 tsci 生成名），用于取封装几何。 */
  footprint: string;
}

export type PartKind = "mcu" | "ic" | "connector" | "keys" | "passive" | "other";

export interface CircuitBoard {
  width: number;
  height: number;
}

export interface CircuitNet {
  name: string;
  pins: { ref: string; number: number }[];
}

export interface CircuitModel {
  ok: boolean;
  error: string;
  board: CircuitBoard;
  parts: CircuitPart[];
  nets: CircuitNet[];
  notes: string[];
}

const KIND_BY_PREFIX: { pattern: RegExp; kind: PartKind }[] = [
  { pattern: /^U\d+/u, kind: "ic" },
  { pattern: /^(J|CN|P)\d+/u, kind: "connector" },
  { pattern: /^(SW|S)\d+/u, kind: "keys" },
  { pattern: /^(R|C|L|D|Q|F|FB|Y|X|TP|FID)\d+/u, kind: "passive" },
];

const KIND_BY_FOOTPRINT: { pattern: RegExp; kind: PartKind }[] = [
  { pattern: /(U_chip|MCU|QFP|LQFP|TQFP|BGA|WLCSP|DFN|QFN)/iu, kind: "ic" },
  { pattern: /(connector|Conn_|USB|HDMI|FPC|JST)/iu, kind: "connector" },
  { pattern: /(SW_|switch|Button)/iu, kind: "keys" },
];

function kindOf(ref: string, footprint: string, pinCount: number): PartKind {
  for (const rule of KIND_BY_PREFIX) {
    if (rule.pattern.test(ref)) {
      if (rule.kind === "ic" && pinCount >= 24) return "mcu";
      return rule.kind;
    }
  }
  for (const rule of KIND_BY_FOOTPRINT) {
    if (rule.pattern.test(footprint) || rule.pattern.test(ref)) return rule.kind;
  }
  return "other";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 读 circuit.json 文本，得到放置与布线共用的模型。 */
export function readCircuitNetlist(circuitJsonText: string): CircuitModel {
  const empty: CircuitModel = { ok: false, error: "", board: { width: 0, height: 0 }, parts: [], nets: [], notes: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(circuitJsonText);
  } catch (error) {
    return { ...empty, error: "circuit.json 不是有效 JSON：" + (error instanceof Error ? error.message : String(error)) };
  }
  if (!Array.isArray(parsed)) return { ...empty, error: "circuit.json 顶层不是数组：先跑一次构建" };

  const notes: string[] = [];
  const byId = new Map<string, Record<string, unknown>>();
  const parts: Record<string, CircuitPart> = {};
  const courtyards = new Map<string, { width: number; height: number }>();
  const netByPort = new Map<string, string>();
  const ports: Record<string, unknown>[] = [];
  let board: CircuitBoard = { width: 0, height: 0 };

  for (const element of parsed) {
    const record = asRecord(element);
    const type = str(record.type);
    if (type === "pcb_component" || type === "source_component" || type === "cad_component" || type === "pcb_board") {
      const id = str(record[type + "_id"]);
      if (id !== "") byId.set(id, record);
    }
    if (type === "pcb_courtyard_rect") {
      const parent = str(record.pcb_component_id);
      courtyards.set(parent, { width: num(record.width), height: num(record.height) });
    }
    if (type === "pcb_port") ports.push(record);
    if (type === "pcb_board") {
      board = { width: num(record.width), height: num(record.height) };
    }
    if (type === "source_trace") {
      const name = str(record.display_name);
      for (const portId of (record.connected_source_port_ids as unknown[]) ?? []) {
        if (typeof portId === "string") netByPort.set(portId, name);
      }
    }
  }

  // 先用 pcb_component 建元件骨架，再从 source_component 补位号与立创编号。
  for (const [id, record] of byId) {
    if (str(record.type) !== "pcb_component") continue;
    void id;
    const sourceId = str(record.source_component_id);
    const source = byId.get(sourceId);
    const ref = str(source?.name) === "" ? sourceId : str(source?.name);
    const cad = byId.get(str(record.pcb_component_id) === "" ? "" : sourceId);
    void cad;
    const courtyard = courtyards.get(str(record.pcb_component_id)) ?? { width: num(record.width), height: num(record.height) };
    const jlc = asRecord(source?.supplier_part_numbers)["jlcpcb"];
    const part: CircuitPart = {
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
  const nets = new Map<string, { ref: string; number: number }[]>();
  for (const port of ports) {
    const pcbComponentId = str(port.pcb_component_id);
    const parent = byId.get(pcbComponentId);
    if (parent === undefined) continue;
    const sourceId = str(parent.source_component_id);
    const ref = str(byId.get(sourceId)?.name) === "" ? sourceId : str(byId.get(sourceId)?.name);
    const part = parts[ref];
    if (part === undefined) continue;
    const net = netByPort.get(str(port.source_port_id)) ?? "";
    const number = part.pinCount + 1;
    part.pinCount = number;
    if (net === "") continue;
    const list = nets.get(net) ?? [];
    list.push({ ref, number });
    nets.set(net, list);
  }

  for (const part of Object.values(parts)) {
    part.kind = kindOf(part.ref, part.footprint, part.pinCount);
  }

  const partsList = Object.values(parts).sort((a, b) => a.ref.localeCompare(b.ref));
  if (partsList.length === 0) notes.push("circuit.json 里没有元件：先写 hardware/circuit/*.circuit.tsx 再构建");
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
