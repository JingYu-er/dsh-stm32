import { test } from "node:test";
import assert from "node:assert/strict";
import { readCircuitNetlist } from "../lib/engine/ecad/pcb/netlist.js";
import { planPlacement } from "../lib/engine/ecad/pcb/placement.js";

function sample() {
  return JSON.stringify([
    { type: "pcb_board", pcb_board_id: "board_0", width: 40, height: 40 },
    {
      type: "source_component", source_component_id: "sc_0", name: "U1", ftype: "simple_chip",
      supplier_part_numbers: { jlcpcb: ["C12345"] },
    },
    {
      type: "pcb_component", pcb_component_id: "pc_0", source_component_id: "sc_0",
      width: 7, height: 7, layer: "top", footprint: "kicad:Package_QFP/TQFP-48_7x7mm_P0.5mm",
    },
    { type: "pcb_courtyard_rect", pcb_component_id: "pc_0", width: 8, height: 8, layer: "top" },
    { type: "source_component", source_component_id: "sc_1", name: "C1", ftype: "simple_capacitor" },
    {
      type: "pcb_component", pcb_component_id: "pc_1", source_component_id: "sc_1",
      width: 1, height: 0.5, layer: "top", footprint: "kicad:Capacitor_SMD/C_0402_1005Metric",
    },
    { type: "pcb_courtyard_rect", pcb_component_id: "pc_1", width: 1.4, height: 0.9, layer: "top" },
    { type: "pcb_port", pcb_port_id: "p0", pcb_component_id: "pc_0", source_port_id: "sp_0", x: -3, y: 0 },
    { type: "pcb_port", pcb_port_id: "p1", pcb_component_id: "pc_1", source_port_id: "sp_1", x: -0.5, y: 0 },
    { type: "source_trace", source_trace_id: "t0", display_name: "VDD", connected_source_port_ids: ["sp_0", "sp_1"] },
  ]);
}

test("circuit.json → 模型：位号、封装、引脚数、网络、立创编号", () => {
  const model = readCircuitNetlist(sample());
  assert.equal(model.ok, true, model.error);
  assert.equal(model.parts.length, 2);
  const u1 = model.parts.find((part) => part.ref === "U1");
  assert.ok(u1);
  assert.ok(["mcu", "ic"].includes(u1.kind), "位号 U 开头应识别为芯片类，实际 " + u1.kind);
  assert.equal(u1.jlcpcb, "C12345");
  assert.equal(u1.footprint.startsWith("kicad:Package_QFP"), true);
  assert.equal(model.nets.length, 1);
  assert.equal(model.nets[0].name, "VDD");
  assert.equal(model.nets[0].pins.length, 2);
});

test("circuit.json 里没有板框时按元件面积估算，并给说明", () => {
  const text = JSON.stringify([
    { type: "source_component", source_component_id: "sc_0", name: "U1" },
    { type: "pcb_component", pcb_component_id: "pc_0", source_component_id: "sc_0", width: 10, height: 10, layer: "top" },
  ]);
  const model = readCircuitNetlist(text);
  assert.equal(model.ok, true);
  assert.ok(model.board.width >= 30, "板宽至少 30 mm");
  assert.match(model.notes.join(" "), /按元件面积估算/u);
});

test("放置：主控在中间，小件贴近所连元件，互不重叠", () => {
  const model = readCircuitNetlist(sample());
  const plan = planPlacement(model);
  assert.equal(plan.ok, true, plan.error);
  assert.equal(plan.unplaced.length, 0);
  const u1 = plan.items.find((item) => item.ref === "U1");
  const c1 = plan.items.find((item) => item.ref === "C1");
  assert.ok(u1 && c1);
  assert.equal(Math.round(u1.x), 20);
  assert.equal(Math.round(u1.y), 20);
  const distance = Math.hypot(u1.x - c1.x, u1.y - c1.y);
  assert.ok(distance < 20, "小件应靠近主控，实际 " + distance.toFixed(1));
});

test("放置：板子装不下时进 unplaced 并给说明，而不是静默丢掉", () => {
  const parts = [{ type: "pcb_board", pcb_board_id: "b", width: 12, height: 12 }];
  for (let index = 0; index < 12; index += 1) {
    parts.push({ type: "source_component", source_component_id: "sc_" + String(index), name: "U" + String(index) });
    parts.push({
      type: "pcb_component", pcb_component_id: "pc_" + String(index), source_component_id: "sc_" + String(index),
      width: 4, height: 4, layer: "top",
    });
    parts.push({ type: "pcb_courtyard_rect", pcb_component_id: "pc_" + String(index), width: 4.4, height: 4.4, layer: "top" });
  }
  const plan = planPlacement(readCircuitNetlist(JSON.stringify(parts)));
  assert.equal(plan.ok, true);
  assert.ok(plan.unplaced.length > 0, "应当有放不下的元件");
  assert.match(plan.notes.join(" "), /没放下/u);
});

test("落板脚本：只搬位号、清旧走线，结果写文件而不是靠 stdout", async () => {
  const { buildApplyScript, parseApplyOutput } = await import("../lib/engine/ecad/pcb/apply.js");
  const script = buildApplyScript({
    boardFile: "C:/tmp/board.kicad_pcb",
    keepTracks: false,
    plan: {
      ok: true, error: "", board: { width: 40, height: 40 },
      items: [{ ref: "U1", x: 20, y: 20, rotation: 0, kind: "mcu" }],
      unplaced: [], notes: [],
    },
  });
  assert.match(script, /SetPosition/u);
  assert.match(script, /GetTracks/u);
  assert.match(script, /sys\.argv\[2\]/u);
  assert.match(script, /json\.dump/u);
  assert.ok(!script.includes("print("), "结果不靠 stdout：pcbnew 会吞掉它");

  assert.deepEqual(parseApplyOutput('{"moved":3,"missing":[],"removedTracks":8}'), { ok: true, moved: 3, missing: [], removedTracks: 8 });
  assert.equal(parseApplyOutput("not json").ok, false);
});

test("落板脚本：keepTracks 时不清走线", async () => {
  const { buildApplyScript } = await import("../lib/engine/ecad/pcb/apply.js");
  const script = buildApplyScript({
    boardFile: "b.kicad_pcb", keepTracks: true,
    plan: { ok: true, error: "", board: { width: 10, height: 10 }, items: [], unplaced: [], notes: [] },
  });
  assert.match(script, /if not payload\['keepTracks'\]/u);
});
