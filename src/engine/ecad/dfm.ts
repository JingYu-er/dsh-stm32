/**
 * 可制造性（DFM）与打板成本（S109）。
 *
 * 规则取自嘉立创（JLCPCB）常规双面板工艺的公开参数，取的是「不加价也不想返工」的那一档：
 * 线宽/间距 0.2 mm、孔径 0.3 mm、环宽 0.13 mm、丝印字高 0.8 mm、板边留 0.3 mm。
 * 落在这一档之外不是不能做，而是要么进特殊工艺加价，要么良率下降。
 *
 * 规则同时写进生成的 KiCad 工程（`<name>.kicad_dru`），
 * 这样 `kicad-cli pcb drc` 报的就是「按嘉立创工艺能不能做」，而不是 KiCad 的默认约束。
 */

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/** 嘉立创常规工艺参数（单位 mm）。改这里等于改全链路的判据。 */
export interface FabRules {
  /** 最小线宽：低于它进特殊工艺。 */
  readonly minTrackMm: number;
  /** 最小线间距。 */
  readonly minClearanceMm: number;
  /** 最小成品孔径：0.3 常规，0.2 起加价。 */
  readonly minDrillMm: number;
  /** 最小焊盘环宽。 */
  readonly minAnnularMm: number;
  /** 丝印最小字高。 */
  readonly minSilkTextMm: number;
  /** 板边到铜的最小距离。 */
  readonly minEdgeClearanceMm: number;
  /** 最低价档的板宽上限（单边）。 */
  readonly cheapMaxMm: number;
  /** 标准板厚。 */
  readonly standardThicknessMm: number;
  /** 标准层数。 */
  readonly standardLayers: number;
  /** 打样片数。 */
  readonly sampleQty: number;
}

export const JLC_STANDARD: FabRules = {
  minTrackMm: 0.2,
  minClearanceMm: 0.2,
  minDrillMm: 0.3,
  minAnnularMm: 0.13,
  minSilkTextMm: 0.8,
  minEdgeClearanceMm: 0.3,
  cheapMaxMm: 100,
  standardThicknessMm: 1.6,
  standardLayers: 2,
  sampleQty: 5,
};

/** 把规则写成 KiCad 自定义设计规则文件，供 `kicad-cli pcb drc` 使用。 */
export function renderDru(rules: FabRules = JLC_STANDARD): string {
  return [
    "(version 1)",
    `(rule "嘉立创 最小线宽" (constraint track_width (min ${rules.minTrackMm.toFixed(3)}mm)))`,
    `(rule "嘉立创 最小间距" (constraint clearance (min ${rules.minClearanceMm.toFixed(3)}mm)))`,
    `(rule "嘉立创 最小孔径" (constraint hole_size (min ${rules.minDrillMm.toFixed(3)}mm)))`,
    `(rule "嘉立创 最小环宽" (constraint annular_width (min ${rules.minAnnularMm.toFixed(3)}mm)))`,
    `(rule "嘉立创 丝印字高" (constraint text_height (min ${rules.minSilkTextMm.toFixed(3)}mm)))`,
    `(rule "嘉立创 板边到铜" (constraint edge_clearance (min ${rules.minEdgeClearanceMm.toFixed(3)}mm)))`,
    "",
  ].join("\n");
}

export interface DruWriteResult {
  readonly ok: boolean;
  readonly error: string;
  readonly file: string;
}

/**
 * 在生成的 KiCad 工程目录里写 `<工程名>.kicad_dru`。
 *
 * 目录里应当只有一个 `.kicad_pro`；找不到时不写（构建失败时会走别的分支）。
 */
export function writeDru(kicadDir: string, rules: FabRules = JLC_STANDARD): DruWriteResult {
  if (!existsSync(kicadDir)) return { ok: false, error: `目录不存在：${kicadDir}`, file: "" };
  const project = readdirSync(kicadDir).find((name) => name.endsWith(".kicad_pro"));
  if (project === undefined) return { ok: false, error: `没有 .kicad_pro：${kicadDir}`, file: "" };
  const stem = basename(project, ".kicad_pro");
  const file = join(kicadDir, `${stem}.kicad_dru`);
  try {
    writeFileSync(file, renderDru(rules), "utf8");
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), file: "" };
  }
  return { ok: true, error: "", file };
}

export interface BoardFacts {
  readonly widthMm: number;
  readonly heightMm: number;
  readonly layers: number;
  /** 全板最细的走线；没有走线时为 0。 */
  readonly minTrackMm: number;
  /** 全板最小钻孔；没有任何孔时为 0。 */
  readonly minDrillMm: number;
  readonly viaCount: number;
}


/** 取出所有落在某层上的图形块（`gr_*` 且块内出现该层名）。 */
function blocksOnLayer(text: string, layer: string): string[] {
  const blocks: string[] = [];
  const pattern = /\(gr_[a-z]+/gu;
  let match = pattern.exec(text);
  while (match !== null) {
    const start = match.index;
    let depth = 0;
    let index = start;
    let inString = false;
    while (index < text.length) {
      const char = text[index] ?? "";
      if (inString) {
        if (char === "\\") index += 1;
        else if (char === '"') inString = false;
      } else if (char === '"') {
        inString = true;
      } else if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
      index += 1;
    }
    const block = text.slice(start, index + 1);
    // KiCad 10 写 `(layer Edge.Cuts)`，老版本写 `(layer "Edge.Cuts")`：两种都认。
    if (block.includes(layer)) blocks.push(block);
    match = pattern.exec(text);
  }
  return blocks;
}

const MM = (text: string): number => Number.parseFloat(text);

/**
 * 从 `.kicad_pcb` 文本里读板子事实。
 *
 * 板框取 `Edge.Cuts` 上的 `gr_rect` / `gr_line` / `gr_arc` 端点范围；
 * 走线宽度取所有 `(segment ... (width X))`；孔径取 `(via ... (drill X))` 与焊盘 `(drill X)`。
 */
export function readBoardFacts(pcbText: string): BoardFacts {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const grow = (x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  const edgeBlocks = blocksOnLayer(pcbText, "Edge.Cuts");
  for (const block of edgeBlocks) {
    const start = block.match(/\(start\s+(-?[\d.]+)\s+(-?[\d.]+)\)/u);
    const end = block.match(/\(end\s+(-?[\d.]+)\s+(-?[\d.]+)\)/u);
    if (start !== null) grow(MM(start[1] ?? "0"), MM(start[2] ?? "0"));
    if (end !== null) grow(MM(end[1] ?? "0"), MM(end[2] ?? "0"));
    const center = block.match(/\(center\s+(-?[\d.]+)\s+(-?[\d.]+)\)/u);
    if (center !== null) grow(MM(center[1] ?? "0"), MM(center[2] ?? "0"));
    for (const point of block.matchAll(/\(xy\s+(-?[\d.]+)\s+(-?[\d.]+)\)/gu)) {
      grow(MM(point[1] ?? "0"), MM(point[2] ?? "0"));
    }
  }

  let minTrack = 0;
  for (const match of pcbText.matchAll(/\(segment\b[\s\S]*?\(width\s+([\d.]+)\)/gu)) {
    const width = MM(match[1] ?? "0");
    if (width > 0 && (minTrack === 0 || width < minTrack)) minTrack = width;
  }

  let minDrill = 0;
  let viaCount = 0;
  for (const match of pcbText.matchAll(/\(via\b[\s\S]*?\(drill\s+([\d.]+)\)/gu)) {
    viaCount += 1;
    const drill = MM(match[1] ?? "0");
    if (drill > 0 && (minDrill === 0 || drill < minDrill)) minDrill = drill;
  }
  for (const match of pcbText.matchAll(/\(drill\s+([\d.]+)\)/gu)) {
    const drill = MM(match[1] ?? "0");
    if (drill > 0 && (minDrill === 0 || drill < minDrill)) minDrill = drill;
  }

  const layers = /"In\d+\.Cu"/u.test(pcbText) ? 4 : 2;
  const widthMm = Number.isFinite(minX) && Number.isFinite(maxX) ? Math.round((maxX - minX) * 100) / 100 : 0;
  const heightMm = Number.isFinite(minY) && Number.isFinite(maxY) ? Math.round((maxY - minY) * 100) / 100 : 0;
  return { widthMm, heightMm, layers, minTrackMm: minTrack, minDrillMm: minDrill, viaCount };
}

export interface DfmFinding {
  readonly rule: string;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly fix: string;
}

/** 成本估算：给的是「这个参数组合大概落在哪一档」，下单前仍需看官网报价。 */
export interface CostEstimate {
  readonly qty: number;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly layers: number;
  /** 估算价（人民币），整数元。 */
  readonly approxCny: number;
  /** 计价依据，逐条给人看。 */
  readonly basis: readonly string[];
  /** 会明显加价的项。 */
  readonly surcharges: readonly string[];
}

const PERF_BOARD_CNY = 30; // 5 片、100×100 内、双面、1.6 mm、HASL、绿油的常见档位

function sizeFactor(widthMm: number, heightMm: number): { factor: number; note: string } {
  const area = Math.max(widthMm, 0) * Math.max(heightMm, 0);
  if (area <= 0) return { factor: 1, note: "板框未识别，按最低价档估算" };
  if (area <= 100 * 100) return { factor: 1, note: `面积 ${Math.round(area)} mm²，在 100×100 最低价档内` };
  if (area <= 150 * 100) return { factor: 1.6, note: `面积 ${Math.round(area)} mm²，超出最低价档，约 1.6 倍` };
  if (area <= 200 * 150) return { factor: 2.6, note: `面积 ${Math.round(area)} mm²，约 2.6 倍` };
  return { factor: 4, note: `面积 ${Math.round(area)} mm²，超出常用尺寸，按 4 倍估` };
}

function layerFactor(layers: number): { factor: number; note: string } {
  if (layers <= 2) return { factor: 1, note: "双面板（最低价档）" };
  if (layers <= 4) return { factor: 3.2, note: "四层板约 3.2 倍" };
  return { factor: 6, note: `${layers} 层板约 6 倍` };
}

/** 估算 5 片打样价与主要在加价项。 */
export function estimateCost(facts: BoardFacts, rules: FabRules = JLC_STANDARD, qty = rules.sampleQty): CostEstimate {
  const size = sizeFactor(facts.widthMm, facts.heightMm);
  const layers = layerFactor(facts.layers);
  const basis: string[] = [size.note, layers.note, `打样 ${qty} 片`];
  const surcharges: string[] = [];

  let total = PERF_BOARD_CNY * size.factor * layers.factor;

  if (facts.minTrackMm > 0 && facts.minTrackMm < rules.minTrackMm) {
    surcharges.push(`最细走线 ${facts.minTrackMm.toFixed(3)} mm 低于 ${rules.minTrackMm} mm：进特殊工艺，按 +50 元估`);
    total += 50;
  }
  if (facts.minDrillMm > 0 && facts.minDrillMm < rules.minDrillMm) {
    surcharges.push(`最小孔径 ${facts.minDrillMm.toFixed(3)} mm 小于 ${rules.minDrillMm} mm：小孔加价，按 +50 元估`);
    total += 50;
  }
  if (facts.widthMm > 0 && facts.heightMm > 0 && Math.min(facts.widthMm, facts.heightMm) < 20) {
    surcharges.push("有一边短于 20 mm：可能需要拼板，拼板与铣边另计");
  }
  if (qty > rules.sampleQty) {
    const extra = Math.ceil(total * ((qty - rules.sampleQty) / rules.sampleQty) * 0.6);
    basis.push(`超出 ${rules.sampleQty} 片的部分按 0.6 倍单价估`);
    total += extra;
  }

  return {
    qty,
    widthMm: facts.widthMm,
    heightMm: facts.heightMm,
    layers: facts.layers,
    approxCny: Math.max(0, Math.round(total)),
    basis,
    surcharges,
  };
}

export interface DfmReport {
  readonly ok: boolean;
  readonly facts: BoardFacts;
  readonly findings: readonly DfmFinding[];
  readonly cost: CostEstimate;
  readonly druFile: string;
}

/** 按嘉立创常规工艺检查一块板，并给出成本档位。 */
export function checkDfm(pcbText: string, rules: FabRules = JLC_STANDARD): Omit<DfmReport, "druFile"> {
  const facts = readBoardFacts(pcbText);
  const findings: DfmFinding[] = [];

  if (facts.widthMm <= 0 || facts.heightMm <= 0) {
    findings.push({
      rule: "dfm.board-outline",
      severity: "warning",
      message: "没在 Edge.Cuts 上读到板框：尺寸与成本都按最低价档估",
      fix: "在 tscircuit 里给 <board> 设 width/height，或用 outline 画板框",
    });
  }
  if (facts.minTrackMm > 0 && facts.minTrackMm < rules.minTrackMm) {
    findings.push({
      rule: "dfm.track-width",
      severity: "error",
      message: `最细走线 ${facts.minTrackMm.toFixed(3)} mm，低于嘉立创常规工艺 ${rules.minTrackMm} mm`,
      fix: `给 trace 显式指定宽度，例如 <trace width="0.25mm" …>；0.2–0.3 mm 属常规档`,
    });
  }
  if (facts.minDrillMm > 0 && facts.minDrillMm < rules.minDrillMm) {
    findings.push({
      rule: "dfm.hole-size",
      severity: "error",
      message: `最小孔径 ${facts.minDrillMm.toFixed(3)} mm，低于常规 ${rules.minDrillMm} mm`,
      fix: `过孔/插件孔开到 ${rules.minDrillMm} mm 以上；更小的孔要进特殊工艺`,
    });
  }
  if (facts.layers > rules.standardLayers) {
    findings.push({
      rule: "dfm.layers",
      severity: "info",
      message: `${facts.layers} 层板：价格约为双面板的 3 倍以上`,
      fix: "能用双面解决就不要升层；必须升层时先确认层数与叠层",
    });
  }
  if (facts.widthMm > rules.cheapMaxMm || facts.heightMm > rules.cheapMaxMm) {
    findings.push({
      rule: "dfm.board-size",
      severity: "info",
      message: `板子 ${facts.widthMm}×${facts.heightMm} mm，超出 100×100 最低价档`,
      fix: "能拆板或缩尺寸就缩；拼板不降单价，只省运费与贴片费",
    });
  }
  if (facts.viaCount === 0 && facts.layers <= 2) {
    findings.push({
      rule: "dfm.via-free",
      severity: "info",
      message: "没有过孔：双面板单面走线，成本与良率都最好",
      fix: "保持现状即可",
    });
  }

  return { ok: findings.every((finding) => finding.severity !== "error"), facts, findings, cost: estimateCost(facts, rules) };
}
