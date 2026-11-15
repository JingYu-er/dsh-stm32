import { test } from "node:test";
import assert from "node:assert/strict";
import { readCircuitNetlist } from "../lib/engine/ecad/pcb/netlist.js";
import { planPlacement } from "../lib/engine/ecad/pcb/placement.js";
import * as krt from "../lib/engine/ecad/pcb/krt.js";

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

test("电源布线脚本：默认只算不写，铺铜只填充已有区域", async () => {
  const { buildRouteScript, DEFAULT_POWER_NETS } = await import("../lib/engine/ecad/pcb/route.js");
  const script = buildRouteScript({
    boardFile: "b.kicad_pcb", powerNets: [...DEFAULT_POWER_NETS], powerWidthMm: 0.5,
    planeNet: "GND", planeLayer: "B.Cu", planeClearanceMm: 0.5, keepTracks: false,
  });
  assert.match(script, /dryRun = bool\(payload\.get\('dryRun', True\)\)/u);
  assert.match(script, /if not dryRun:/u);
  assert.match(script, /ZONE_FILLER/u);
  assert.match(script, /sys\.argv\[2\]/u);
});

test("铺铜：网络没有编号时拒绝写入并说清原因", async () => {
  const { appendGroundZone } = await import("../lib/engine/ecad/pcb/route.js");
  const bare = '(kicad_pcb (pad "1" (net "GND")))';
  const refused = appendGroundZone(bare, { x0: 0, y0: 0, x1: 10, y1: 10 });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /没有编号/u);

  const numbered = '(kicad_pcb (pad "1" (net 7 "GND")))';
  const plan = appendGroundZone(numbered, { x0: 0, y0: 0, x1: 10, y1: 10 });
  assert.equal(plan.ok, true);
  assert.equal(plan.netNumber, 7);
  assert.match(plan.text, /\(zone/u);
});

test("布线结果解析：认 JSON，拒空与非 JSON", async () => {
  const { parseRouteOutput } = await import("../lib/engine/ecad/pcb/route.js");
  const ok = parseRouteOutput('{"tracks":4,"vias":0,"nets":[{"net":"GND","pads":3,"segments":4}],"plane":null,"notes":[]}');
  assert.equal(ok.ok, true);
  assert.equal(ok.tracks, 4);
  assert.equal(ok.nets[0].net, "GND");
  assert.equal(parseRouteOutput("").ok, false);
  assert.equal(parseRouteOutput("oops").ok, false);
});

test("网格布线器：两焊盘一根线、不穿墙", async () => {
  const { planRouting } = await import("../lib/engine/ecad/pcb/router.js");
  const geo = {
    ok: true, error: "", widthMm: 20, heightMm: 20, x0: 0, y0: 0, notes: [],
    pads: [
      { ref: "U1", number: "1", net: "VCC", x: 2, y: 2, width: 1, height: 1 },
      { ref: "U2", number: "1", net: "VCC", x: 18, y: 18, width: 1, height: 1 },
    ],
    tracks: [],
  };
  const plan = planRouting(geo, { resolutionMm: 0.5 });
  assert.equal(plan.ok, true);
  assert.equal(plan.nets[0].net, "VCC");
  assert.ok(plan.segments.length >= 1, "应该布出至少一段");
  assert.equal(plan.nets[0].connected, true);
});

test("板子几何解析：认 JSON、算范围", async () => {
  const { parseGeometry } = await import("../lib/engine/ecad/pcb/geometry.js");
  const geo = parseGeometry('noise {"x0":1,"y0":2,"widthMm":10,"heightMm":20,"pads":[{"ref":"U1","number":"1","net":"GND","x":3,"y":4,"width":1,"height":2}],"tracks":[]} tail');
  assert.equal(geo.ok, true);
  assert.equal(geo.widthMm, 10);
  assert.equal(geo.pads[0].net, "GND");
  assert.equal(parseGeometry("no json").ok, false);
});

test("走线写入结果解析", async () => {
  const { parseTrackReport } = await import("../lib/engine/ecad/pcb/tracks.js");
  assert.deepEqual(parseTrackReport('{"added":12,"skipped":1,"vias":3}'), { ok: true, error: "", added: 12, skipped: 1, vias: 3 });
  assert.equal(parseTrackReport('{"added":1,"skipped":0}').vias, 0);
  assert.equal(parseTrackReport("").ok, false);
});

test("落盘前自检：压到别网焊盘的走线被丢掉", async () => {
  const { validateSegments } = await import("../lib/engine/ecad/pcb/router.js");
  const geo = {
    ok: true, error: "", widthMm: 10, heightMm: 10, x0: 0, y0: 0, notes: [],
    pads: [{ ref: "U1", number: "1", net: "VCC", x: 5, y: 5, width: 1, height: 1 }],
    tracks: [],
  };
  const crossed = { net: "GND", layer: "F.Cu", widthMm: 0.25, x1: 1, y1: 5, x2: 9, y2: 5 };
  const clear = { net: "GND", layer: "F.Cu", widthMm: 0.25, x1: 1, y1: 8, x2: 9, y2: 8 };
  const checked = validateSegments(geo, [crossed, clear], 0.2);
  assert.equal(checked.rejected.length, 1);
  assert.equal(checked.accepted.length, 1);
  assert.equal(checked.accepted[0].y1, 8);
});

test("KiCadRoutingTools：层名补引号只碰单行的 layer/layers，不改层表（S145）", () => {
  const { quoteLayerNames } = krt;
  const src = [
    "(kicad_pcb",
    "  (layers",
    '    (0 "F.Cu" signal)',
    '    (31 "B.Cu" signal)',
    "  )",
    "  (segment (start 1 2) (end 3 4) (width 0.25) (layer F.Cu) (net 32))",
    "  (via (at 5 6) (size 0.6) (drill 0.3) (layers F.Cu B.Cu) (net 0))",
    ")",
  ].join("\n");
  const out = quoteLayerNames(src);
  assert.ok(out.text.includes('(layer "F.Cu")'), "单行 layer 要补引号");
  assert.ok(out.text.includes('(layers "F.Cu" "B.Cu")'), "via 的 layers 要补引号");
  assert.ok(out.text.includes('    (0 "F.Cu" signal)'), "层表那几行不能动");
  assert.equal(out.quoted, 2);
});

test("KiCadRoutingTools：从 autoroute 日志里读出计划、未连接数与告警（S145）", () => {
  const { parseAutorouteLog } = krt;
  const text = [
    "WARNING: 4 footprint block(s) share 1 reference(s)",
    'AUTOROUTE_PLAN: {"steps": [{"tag": "planes", "tool": "planes", "what": "pour GND", "why": "next to every signal layer", "optional": false}, {"tag": "route", "tool": "route", "what": "route every net", "why": "grid 0.05 mm", "optional": false}]}',
    'AUTOROUTE_SUMMARY: {"open_nets": 0, "drc_items": 0, "steps": 2, "seconds": 146.3}',
  ].join("\n");
  const parsed = parseAutorouteLog(text);
  assert.equal(parsed.steps.length, 2);
  assert.equal(parsed.steps[0].tag, "planes");
  assert.equal(parsed.openNets, 0);
  assert.equal(parsed.drc, 0);
  assert.equal(parsed.warnings.length, 1);
  assert.equal(parsed.error, "");
});
