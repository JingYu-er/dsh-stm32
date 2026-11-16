/**
 * 功耗与电源树电流预算（S160）。
 *
 * 只做能算的部分：板上每个电源网络上有哪些元件、最窄走线多宽、按电流该多宽、合计多少瓦。
 * 电流从哪来按优先级：用户给的 > 板子名能认出的默认值（VBUS 1 A、3V3 0.5 A，同 EMC）> 未知。
 * 未知的**不当 0 算**，单列「未填」——预算表里有空格比有假数字安全。
 *
 * 器件自身的 IDD 不在这里猜：那要从数据手册的电气特性表读，随器件而变；
 * 需要时用 `stm32_pdf_read` 的 `table` 模式把 IDD 表抽出来，再填进 `currents`。
 */

import type { CircuitModel } from "./netlist.js";
import { defaultCurrentForNet, parenBlocks, requiredWidthMm } from "./emc.js";

export interface PowerRail {
  readonly net: string;
  /** 从网络名认出的电压；认不出为 null。 */
  readonly voltageV: number | null;
  /** 参与合计的电流；未填为 null。 */
  readonly currentA: number | null;
  /** 电流是按名字估的（不是用户填的）。 */
  readonly assumed: boolean;
  /** 该网络的元件位号（来自 circuit.json，没有 netlist 时为空）。 */
  readonly refs: readonly string[];
  /** 该网络最窄的走线宽（mm）；没有走线为 0。 */
  readonly minTrackMm: number;
  /** 按电流算的需求线宽（mm）；电流未知为 0。 */
  readonly requiredMm: number;
  /** 线宽是否够；电流未知或没有走线时为 null。 */
  readonly ok: boolean | null;
}

export interface PowerBudget {
  readonly ok: boolean;
  readonly error: string;
  readonly boardFile: string;
  readonly rails: readonly PowerRail[];
  readonly groundNets: readonly string[];
  /** 已填电流的合计（A，按各网络电压分别计入总功率）。 */
  /** 用户填了电流的网络合计（A）——这才是预算。 */
  readonly totalA: number;
  /** 用户填了电流的网络合计功率（W）。 */
  readonly totalW: number;
  /** 按名字估出来的电流合计（A），仅供参考，不计入预算。 */
  readonly estimatedA: number;
  /** 按名字估出来的合计功率（W）。 */
  readonly estimatedW: number;
  /** 按输入电压与效率折算的输入电流；无输入电压时为 0。 */
  readonly inputA: number;
  readonly inputV: number;
  readonly efficiency: number;
  /** 电流未填的网络个数。 */
  readonly unfilled: number;
  readonly notes: readonly string[];
}

const EMPTY: PowerBudget = {
  ok: false,
  error: "",
  boardFile: "",
  rails: [],
  groundNets: [],
  totalA: 0,
  totalW: 0,
  estimatedA: 0,
  estimatedW: 0,
  inputA: 0,
  inputV: 0,
  efficiency: 0.85,
  unfilled: 0,
  notes: [],
};

/** 从网络名认电压：只认常见写法，认不出返回 null（不猜）。 */
export function inferVoltage(net: string): number | null {
  const name = net.trim().toUpperCase();
  if (/^(?:5V|VBUS|VIN|VSYS)$/u.test(name)) return 5;
  if (/^(?:3V3|V3V3|3\.3V|VDD|VCC|VDDA|VDDIO)$/u.test(name)) return 3.3;
  if (/^(?:1V8|V1V8|1\.8V)$/u.test(name)) return 1.8;
  if (/^(?:VBAT|BAT|VBATT)$/u.test(name)) return 3.7;
  if (/^(?:12V|V12)$/u.test(name)) return 12;
  if (/^(?:24V|V24)$/u.test(name)) return 24;
  return null;
}

function isGround(net: string): boolean {
  return /^(?:GND|VSS|AGND|DGND|PGND|GROUND)$/u.test(net.trim().toUpperCase());
}

/** 该网络算不算电源轨：认得出电压，或按名字能认成电源。 */
function isPowerRail(net: string): boolean {
  return inferVoltage(net) !== null || defaultCurrentForNet(net) > 0;
}

interface SegmentInfo {
  net: string;
  width: number;
}

/** 从 .kicad_pcb 里取「每个网络的最窄走线」；跨行与单行都能读。 */
export function readNetTrackWidths(pcbText: string): Map<string, number> {
  const widths = new Map<string, number>();
  const numberByNet = new Map<string, string>();
  // 先读 (net N "NAME") 声明，再按 (segment … (net N) …) 里的编号反查名字。
  const declRe = /\(net\s+(\d+)\s+"([^"]*)"\)/gu;
  let decl = declRe.exec(pcbText);
  while (decl !== null) {
    numberByNet.set(decl[1] ?? "", decl[2] ?? "");
    decl = declRe.exec(pcbText);
  }
  // 走线块按平衡括号取（真文件跨行、夹具一行写完，用换行判断块尾会漏）。
  const segments: SegmentInfo[] = [];
  for (const body of parenBlocks(pcbText, "segment")) {
    const widthMatch = /\(width\s+([\d.]+)\)/u.exec(body);
    const netMatch = /\(net\s+(\d+)\)/u.exec(body);
    if (widthMatch === null || netMatch === null) continue;
    const name = numberByNet.get(netMatch[1] ?? "") ?? "";
    const width = Number(widthMatch[1] ?? "");
    if (name !== "" && Number.isFinite(width)) segments.push({ net: name, width });
  }
  for (const item of segments) {
    const current = widths.get(item.net);
    if (current === undefined || item.width < current) widths.set(item.net, item.width);
  }
  return widths;
}

export interface PowerInput {
  /** 用户给的电流：键是网络名。 */
  readonly currents?: Readonly<Record<string, number>>;
  /** 用户给的电压：键是网络名。 */
  readonly voltages?: Readonly<Record<string, number>>;
  /** 输入电压（折算输入电流用）；不给就取最高的电源轨电压。 */
  readonly inputV?: number;
  /** 电源效率（DC-DC 0.85、LDO 让输入电压等于输出时按 1）。 */
  readonly efficiency?: number;
}

/**
 * 算一份电源预算。`netlist` 只用来补「每个电源网络上挂着哪些元件」，
 * 没有也能算（只是不知道元件）。
 */
export function analyzePowerBudget(
  pcbText: string,
  boardFile: string,
  netlist: CircuitModel | null,
  input: PowerInput = {},
): PowerBudget {
  if (!pcbText.includes("(kicad_pcb")) {
    return { ...EMPTY, error: "读不懂这个 .kicad_pcb：没有 kicad_pcb 头", boardFile };
  }
  const widths = readNetTrackWidths(pcbText);
  const efficiency = input.efficiency !== undefined && input.efficiency > 0 ? input.efficiency : 0.85;
  const netNames = new Set<string>(widths.keys());
  for (const net of netlist?.nets ?? []) netNames.add(net.name);
  const declared = /\(net\s+\d+\s+"([^"]*)"\)/gu;
  let match = declared.exec(pcbText);
  while (match !== null) {
    netNames.add(match[1] ?? "");
    match = declared.exec(pcbText);
  }

  // circuit.json 的网络名是「.C1 > .pin1 to net.V3V3」这种走线名：网络在 `to net.` 之后，
  // 元件位号在开头的 `.REF >` 里。按这两段还原每个电源网络挂着哪些元件。
  const refsByNet = new Map<string, string[]>();
  for (const net of netlist?.nets ?? []) {
    const netName = /to net\.(\S+)$/u.exec(net.name.trim())?.[1] ?? "";
    const refName = /^\.([^ ]+) >/u.exec(net.name.trim())?.[1] ?? "";
    if (netName === "") continue;
    for (const pin of net.pins) {
      const key = refName === "" ? pin.ref : refName;
      const list = refsByNet.get(netName) ?? [];
      if (!list.includes(key)) list.push(key);
      refsByNet.set(netName, list);
    }
  }
  for (const name of refsByNet.keys()) netNames.add(name);

  const rails: PowerRail[] = [];
  const groundNets: string[] = [];
  const notes: string[] = [];
  for (const net of [...netNames].sort()) {
    if (isGround(net)) {
      groundNets.push(net);
      continue;
    }
    if (!isPowerRail(net)) continue;
    const given = input.currents?.[net];
    const assumed = given === undefined;
    const currentA = given !== undefined ? given : defaultCurrentForNet(net) > 0 ? defaultCurrentForNet(net) : null;
    const minTrackMm = widths.get(net) ?? 0;
    const requiredMm = currentA !== null && currentA > 0 ? Math.round(requiredWidthMm(currentA) * 1000) / 1000 : 0;
    const ok = currentA === null || minTrackMm === 0 ? null : minTrackMm + 1e-6 >= requiredMm;
    const voltageV = input.voltages?.[net] ?? inferVoltage(net);
    rails.push({
      net,
      voltageV,
      currentA,
      assumed: assumed && currentA !== null,
      refs: refsByNet.get(net) ?? [],
      minTrackMm: Math.round(minTrackMm * 1000) / 1000,
      requiredMm,
      ok,
    });
  }
  rails.sort((a, b) => (b.voltageV ?? 0) - (a.voltageV ?? 0) || a.net.localeCompare(b.net));

  let totalA = 0;
  let totalW = 0;
  let estimatedA = 0;
  let estimatedW = 0;
  let unfilled = 0;
  for (const rail of rails) {
    if (rail.currentA === null) {
      unfilled += 1;
      continue;
    }
    // 用户填的才算预算；按名字估的另计——否则 VBUS 1 A + VBAT 1 A + 3V3 0.5 A
    // 会被读成「这块板真的要 4 A」。
    if (rail.assumed) {
      estimatedA += rail.currentA;
      if (rail.voltageV !== null) estimatedW += rail.voltageV * rail.currentA;
      continue;
    }
    totalA += rail.currentA;
    if (rail.voltageV !== null) totalW += rail.voltageV * rail.currentA;
  }
  const highest = rails.reduce((best, rail) => (rail.voltageV !== null && rail.voltageV > best ? rail.voltageV : best), 0);
  const inputV = input.inputV !== undefined && input.inputV > 0 ? input.inputV : highest;
  const inputA = inputV > 0 && totalW > 0 ? Math.round((totalW / (inputV * efficiency)) * 1000) / 1000 : 0;

  for (const net of Object.keys(input.currents ?? {})) {
    if (!rails.some((rail) => rail.net === net)) notes.push("给了电流但没有这个电源网络：" + net + "（板上叫法可能不同）");
  }
  if (rails.some((rail) => rail.assumed)) notes.push("预算只合计你填的电流；按名字估的另计 " + String(Math.round(estimatedA * 1000) / 1000) + " A，不当作需求");
  if (unfilled > 0) notes.push("有 " + String(unfilled) + " 个电源网络没填电流：预算里单列，不当 0 算");
  if (netlist === null) notes.push("没有 circuit.json：不知道每个电源网络上挂着哪些元件");
  if (inputV > 0 && totalW > 0) notes.push("输入电流按 " + String(inputV) + " V、" + String(Math.round(efficiency * 100)) + "% 效率折算，仅作电源选型参考");
  if (groundNets.length > 0) notes.push("地网络 " + groundNets.join("、") + " 不参与合计");

  return {
    ok: true,
    error: "",
    boardFile,
    rails,
    groundNets,
    totalA: Math.round(totalA * 1000) / 1000,
    totalW: Math.round(totalW * 1000) / 1000,
    estimatedA: Math.round(estimatedA * 1000) / 1000,
    estimatedW: Math.round(estimatedW * 1000) / 1000,
    inputA,
    inputV,
    efficiency,
    unfilled,
    notes,
  };
}
