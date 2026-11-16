/**
 * 叠层与阻抗（S157）。
 *
 * 板子文件里通常没有 `(stackup …)` 段（tscircuit 导出的板子就没有），所以这里按
 * 「层数 + 板厚」推一个可复现的叠层，再按 IPC-2141 的常用经验公式算阻抗。
 *
 * 这些是**工程估算**：微带 ±10%、带状线 ±10%，用于「这根线该多宽」的初值；
 * 真要卡±5% 的阻抗，必须让板厂按他们的叠层与介质做阻抗测试（JLCPCB 的阻抗报告）。
 */

export type TraceKind = "microstrip" | "stripline" | "differential-microstrip" | "differential-stripline";

export interface StackupLayer {
  readonly name: string;
  readonly role: "copper" | "core" | "prepreg";
  readonly thicknessMm: number;
  readonly er: number;
}

export interface StackupPreset {
  readonly id: string;
  readonly label: string;
  readonly totalMm: number;
  readonly layers: readonly StackupLayer[];
}

/** 铜厚：1 oz = 0.035 mm。 */
export const COPPER_MM = 0.035;

/**
 * 嘉立创常规叠层（1.6 mm，4 层）。
 *
 * 取 JLC04161H-3313 的公开参数：L1–L2 介质 0.2104 mm、L2–L3 芯板 1.065 mm、
 * L3–L4 介质 0.2104 mm，四层铜各 0.035 mm，总厚 1.6 mm。
 */
export const JLC_4L_16: StackupPreset = {
  id: "jlc4-1.6",
  label: "嘉立创 4 层 1.6 mm（JLC04161H-3313 同档）",
  totalMm: 1.6,
  layers: [
    { name: "F.Cu", role: "copper", thicknessMm: COPPER_MM, er: 0 },
    { name: "Prepreg L1-L2", role: "prepreg", thicknessMm: 0.2104, er: 4.2 },
    { name: "In1.Cu", role: "copper", thicknessMm: COPPER_MM, er: 0 },
    { name: "Core L2-L3", role: "core", thicknessMm: 1.065, er: 4.6 },
    { name: "In2.Cu", role: "copper", thicknessMm: COPPER_MM, er: 0 },
    { name: "Prepreg L3-L4", role: "prepreg", thicknessMm: 0.2104, er: 4.2 },
    { name: "B.Cu", role: "copper", thicknessMm: COPPER_MM, er: 0 },
  ],
};

/** 两层板：1.6 mm 板厚减去两层铜，剩下算 FR4（er 4.5）。 */
export const JLC_2L_16: StackupPreset = {
  id: "jlc2-1.6",
  label: "嘉立创 2 层 1.6 mm",
  totalMm: 1.6,
  layers: [
    { name: "F.Cu", role: "copper", thicknessMm: COPPER_MM, er: 0 },
    { name: "Core", role: "core", thicknessMm: 1.6 - COPPER_MM * 2, er: 4.5 },
    { name: "B.Cu", role: "copper", thicknessMm: COPPER_MM, er: 0 },
  ],
};

export function presetForLayers(copperLayers: number): StackupPreset {
  return copperLayers <= 2 ? JLC_2L_16 : JLC_4L_16;
}

/** 微带线特征阻抗（IPC-2141 常用式，w/h 在 0.1–3 内误差约 ±10%）。 */
export function microstripZ0(w: number, h: number, t: number, er: number): number {
  if (w <= 0 || h <= 0 || er <= 1) return 0;
  return (87 / Math.sqrt(er + 1.41)) * Math.log((5.98 * h) / (0.8 * w + t));
}

/** 带状线特征阻抗（参考面间距 b，两侧都是介质）。 */
export function striplineZ0(w: number, b: number, t: number, er: number): number {
  if (w <= 0 || b <= 0 || er <= 1) return 0;
  return (60 / Math.sqrt(er)) * Math.log((4 * b) / (0.67 * Math.PI * (0.8 * w + t)));
}

/** 差分阻抗：由单端阻抗与间距推（微带 0.48、带状线 0.347 的经验耦合系数）。 */
export function differentialZ0(kind: TraceKind, single: number, spacing: number, referenceMm: number): number {
  if (single <= 0 || spacing <= 0 || referenceMm <= 0) return 0;
  const coupling = kind === "differential-stripline" ? 0.347 : 0.48;
  const decay = kind === "differential-stripline" ? 2.9 : 0.96;
  return 2 * single * (1 - coupling * Math.exp((-decay * spacing) / referenceMm));
}

/** 介电常数与参考面距离：微带用相邻 prepreg，带状线用两侧介质之和。 */
export function referenceOf(preset: StackupPreset, kind: TraceKind): { er: number; distanceMm: number } {
  const dielectrics = preset.layers.filter((layer) => layer.role !== "copper");
  const first = dielectrics[0];
  if (kind === "microstrip" || kind === "differential-microstrip") {
    return { er: first?.er ?? 4.2, distanceMm: first?.thicknessMm ?? 0.2104 };
  }
  const second = dielectrics[1] ?? first;
  return {
    er: ((first?.er ?? 4.2) + (second?.er ?? 4.6)) / 2,
    distanceMm: (first?.thicknessMm ?? 0.2104) / 2 + (second?.thicknessMm ?? 1.065) / 2,
  };
}

/** 二分找线宽：单端按目标阻抗，差分按目标差分阻抗（先反推需要的单端阻抗）。 */
export function solveWidth(kind: TraceKind, targetOhm: number, preset: StackupPreset, spacingMm = 0.2): number {
  const reference = referenceOf(preset, kind);
  const differential = kind === "differential-microstrip" || kind === "differential-stripline";
  const singleTarget = differential
    ? targetOhm / 2 / (1 - (kind === "differential-stripline" ? 0.347 : 0.48) * Math.exp((-(kind === "differential-stripline" ? 2.9 : 0.96) * spacingMm) / reference.distanceMm))
    : targetOhm;
  const z0Of = (w: number): number =>
    kind === "microstrip" || kind === "differential-microstrip"
      ? microstripZ0(w, reference.distanceMm, COPPER_MM, reference.er)
      : striplineZ0(w, reference.distanceMm, COPPER_MM, reference.er);
  let low = 0.05;
  let high = 4;
  for (let i = 0; i < 60; i += 1) {
    const mid = (low + high) / 2;
    // 线越宽阻抗越低：目标比当前高就往窄里走。
    if (z0Of(mid) > singleTarget) low = mid;
    else high = mid;
  }
  return Math.round(((low + high) / 2) * 1000) / 1000;
}

export interface ImpedanceSuggestion {
  readonly kind: TraceKind;
  readonly targetOhm: number;
  readonly widthMm: number;
  readonly spacingMm: number;
  readonly achievedOhm: number;
}

export interface StackupAnalysis {
  readonly ok: boolean;
  readonly error: string;
  readonly boardFile: string;
  readonly copperLayers: number;
  readonly preset: StackupPreset;
  /** 板子里实际用到的走线宽度（去重、升序）。 */
  readonly traceWidths: readonly number[];
  readonly suggestions: readonly ImpedanceSuggestion[];
  readonly notes: readonly string[];
}

/** 从 `.kicad_pcb` 里数铜层，并取走线宽度分布（`(segment … (width X) …)`）。 */
export function readBoardWidths(pcbText: string): { copperLayers: number; widths: number[] } {
  const block = /\(layers\b([\s\S]*?)\n\s*\)/u.exec(pcbText);
  const text = block === null ? pcbText : (block[1] ?? pcbText);
  const copper = new Set<string>();
  for (const match of text.matchAll(/"((?:F|B|In\d+)\.Cu)"/gu)) copper.add(match[1] ?? "");
  const widths = new Set<number>();
  for (const match of pcbText.matchAll(/\(segment\b[\s\S]{0,400}?\(width ([0-9.]+)\)/gu)) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0) widths.add(value);
  }
  return {
    copperLayers: copper.size === 0 ? 4 : copper.size,
    widths: [...widths].sort((a, b) => a - b),
  };
}

/** 单端 50 Ω、差分 90 Ω（USB 2.0）与 100 Ω（以太网/LVDS）的常见目标。 */
export const DEFAULT_TARGETS = [
  { kind: "microstrip" as TraceKind, targetOhm: 50 },
  { kind: "differential-microstrip" as TraceKind, targetOhm: 90 },
  { kind: "differential-microstrip" as TraceKind, targetOhm: 100 },
  { kind: "stripline" as TraceKind, targetOhm: 50 },
];

export function analyzeStackup(pcbText: string, boardFile = "", spacingMm = 0.2, targets = DEFAULT_TARGETS): StackupAnalysis {
  const empty = { ok: false, error: "", boardFile, copperLayers: 0, preset: JLC_4L_16, traceWidths: [] as number[], suggestions: [] as ImpedanceSuggestion[], notes: [] as string[] };
  if (pcbText.trim() === "") return { ...empty, error: "板子文件是空的" };
  const { copperLayers, widths } = readBoardWidths(pcbText);
  const preset = presetForLayers(copperLayers);
  const suggestions: ImpedanceSuggestion[] = targets.map((item) => {
    const widthMm = solveWidth(item.kind, item.targetOhm, preset, spacingMm);
    const reference = referenceOf(preset, item.kind);
    const single =
      item.kind === "microstrip" || item.kind === "differential-microstrip"
        ? microstripZ0(widthMm, reference.distanceMm, COPPER_MM, reference.er)
        : striplineZ0(widthMm, reference.distanceMm, COPPER_MM, reference.er);
    const achievedOhm =
      item.kind === "differential-microstrip" || item.kind === "differential-stripline"
        ? Math.round(differentialZ0(item.kind, single, spacingMm, reference.distanceMm) * 10) / 10
        : Math.round(single * 10) / 10;
    return { kind: item.kind, targetOhm: item.targetOhm, widthMm, spacingMm, achievedOhm };
  });
  const notes: string[] = [];
  if (!/\(stackup\b/u.test(pcbText)) notes.push("板子里没有叠层定义，按「" + preset.label + "」估算");
  if (widths.length > 0 && suggestions.length > 0) {
    const widestTarget = suggestions[0];
    const thinnest = widths[0];
    if (thinnest !== undefined && widestTarget !== undefined && thinnest < widestTarget.widthMm * 0.6) {
      notes.push("板上有 " + String(thinnest) + " mm 的细线：这类线做不了 50 Ω 单端，只能当普通信号线");
    }
  }
  return { ok: true, error: "", boardFile, copperLayers, preset, traceWidths: widths, suggestions, notes };
}
