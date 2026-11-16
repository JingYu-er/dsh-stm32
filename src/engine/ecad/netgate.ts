/**
 * 网表与板子的一致性门禁（S169）。
 *
 * 一次性对账（stm32_sch_check）解决「现在对不对」；门禁解决「改完之后有没有回去同步」：
 * 1. 原理图比板子新，说明改完没更新 PCB——这是硬件设计里最常见的断裂点；
 * 2. 原理图与 PCB 的网络对不上（拆分、缺焊盘、名字不同）；
 * 3. 两边元件数不同（少放/多放了器件）。
 *
 * 判据只认板子上与图纸上都能读到的证据，读不到就说读不到。
 */
import { existsSync, readFileSync, statSync } from "node:fs";

import { resolveProjectLayout } from "../project-layout.js";
import { findLatestKicadBuild, planEcadWorkspace } from "./tsci.js";
import { readSchematic } from "../schematic/model.js";
import { crossCheckPcb, readPcb, type PcbCheckReport } from "../schematic/pcb.js";
import { buildSheetNets } from "../schematic/nets.js";
import { parseSchText } from "../schematic/kicad-sch.js";
import { drawSheetPath } from "../schematic/draw.js";

export type NetGateState = "ok" | "stale" | "mismatch" | "unknown";

/** 手绘层与生成图纸的差异（S176）：只比元件与每个引脚所在的网络，不比坐标。 */
export interface HandDiff {
  readonly file: string;
  readonly exists: boolean;
  readonly partsOnlyInHand: readonly string[];
  readonly partsOnlyInBuild: readonly string[];
  /** 同一个引脚在两边落在不同网络上的描述（`R1.2`）。 */
  readonly pinsChanged: readonly string[];
}

export interface NetGateFinding {
  readonly id: string;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly fix: string;
}

export interface NetGateReport {
  readonly ok: boolean;
  readonly error: string;
  readonly projectDir: string;
  readonly schematicFile: string;
  readonly pcbFile: string;
  readonly state: NetGateState;
  readonly staleSeconds: number;
  readonly schematicComponents: number;
  readonly pcbFootprints: number;
  readonly compared: number;
  readonly matched: number;
  readonly split: number;
  readonly nameMismatches: number;
  readonly missingPads: number;
  readonly hand: HandDiff;
  readonly findings: readonly NetGateFinding[];
  readonly notes: readonly string[];
}

const EMPTY: NetGateReport = {
  ok: false,
  error: "",
  projectDir: "",
  schematicFile: "",
  pcbFile: "",
  state: "unknown",
  staleSeconds: 0,
  schematicComponents: 0,
  pcbFootprints: 0,
  compared: 0,
  matched: 0,
  split: 0,
  nameMismatches: 0,
  missingPads: 0,
  hand: { file: "", exists: false, partsOnlyInHand: [], partsOnlyInBuild: [], pinsChanged: [] },
  findings: [],
  notes: [],
};

/** 板子比图纸旧多少秒（只在图纸更新时为正）。 */
function staleSecondsOf(schematicMs: number, pcbMs: number): number {
  if (schematicMs <= 0 || pcbMs <= 0) return 0;
  const delta = schematicMs - pcbMs;
  return delta > 2000 ? Math.round(delta / 1000) : 0;
}

function findingsOf(
  staleSeconds: number,
  check: PcbCheckReport | null,
  schematicRefs: readonly string[],
  boardRefs: readonly string[],
  connectedRefs: readonly string[],
): NetGateFinding[] {
  const findings: NetGateFinding[] = [];
  if (staleSeconds > 0) {
    findings.push({
      id: "gate.stale-board",
      severity: "warning",
      message: `原理图比板子新 ${staleSeconds} 秒：改完原理图没把变更同步到 PCB`,
      fix: "在 KiCad 里打开 PCB 编辑器执行「从原理图更新 PCB」（Update PCB from Schematic），或重新导一次网表再布线。",
    });
  }
  if (check !== null) {
    if (check.split.length > 0) {
      const sample = check.split.slice(0, 3).map((item) => item.net).join("、");
      findings.push({
        id: "gate.net-split",
        severity: "error",
        message: `${check.split.length} 条 PCB 网络在原理图里被拆成多段（${sample}）`,
        fix: "多半是电源符号或标签只压在一段导线上：在原理图里把同一网络的两段连起来，再更新 PCB。",
      });
    }
    if (check.missingPads.length > 0) {
      const sample = check.missingPads.slice(0, 3).map((item) => `${item.ref}.${item.number}`).join("、");
      findings.push({
        id: "gate.pad-missing",
        severity: "warning",
        message: `${check.missingPads.length} 个原理图引脚在 PCB 上没有对应焊盘（${sample}）`,
        fix: "确认封装引脚数一致；封装被替换成引脚更少的型号时，原理图也要跟着改。",
      });
    }
    if (check.nameMismatches.length > 0) {
      const sample = check.nameMismatches[0];
      findings.push({
        id: "gate.net-name-mismatch",
        severity: "info",
        message: `${check.nameMismatches.length} 个焊盘的网络名与图纸不同（连通性一致）`,
        fix: `例如 ${sample === undefined ? "" : `${sample.ref}.${sample.number}：PCB ${sample.pcbNet} / 图纸 ${sample.schematicNet}`}——不影响连接，但搜网络名时会找不到。`,
      });
    }
  }
  const boardSet = new Set(boardRefs);
  const connectedSet = new Set(connectedRefs);
  const notOnBoard = schematicRefs.filter((ref) => !boardSet.has(ref));
  if (notOnBoard.length > 0) {
    findings.push({
      id: "gate.component-missing",
      severity: "warning",
      message: `${notOnBoard.length} 个原理图元件没放进板子：${notOnBoard.slice(0, 5).join("、")}`,
      fix: "在 KiCad 里执行「Update PCB from Schematic」，或确认这些是不是只做标注用的虚拟件。",
    });
  }
  const floating = schematicRefs.filter((ref) => boardSet.has(ref) && !connectedSet.has(ref));
  if (floating.length > 0) {
    findings.push({
      id: "gate.component-unconnected",
      severity: "info",
      message: `${floating.length} 个元件在板子上没有任何网络连接：${floating.slice(0, 5).join("、")}`,
      fix: "确认它们是不是本来就只做定位或装饰（安装孔、测试点）；不是的话回原理图接上网络再更新 PCB。",
    });
  }
  return findings;
}

export interface NetGateOptions {
  /** 直接指定板子与图纸（工具/测试用），跳过工程布局发现。 */
  readonly pcbFile?: string;
  readonly schematicFile?: string;
}

export function checkNetGate(projectDir: string, options: NetGateOptions = {}): NetGateReport {
  if (options.pcbFile !== undefined && options.schematicFile !== undefined) {
    return evaluateGate(projectDir, options.schematicFile, options.pcbFile);
  }
  if (projectDir.trim() === "") return { ...EMPTY, error: "projectDir 不能为空" };
  const layout = resolveProjectLayout(projectDir);
  const workspace = planEcadWorkspace(projectDir, layout.hardwareDir);
  const latest = findLatestKicadBuild(workspace);
  if (!latest.ok || latest.pcbFile === "") {
    return { ...EMPTY, projectDir, error: latest.ok ? "还没有 .kicad_pcb：先构建一次，或在 KiCad 里存一次板子。" : latest.error };
  }
  if (latest.schematicFile === "") {
    return {
      ...EMPTY,
      projectDir,
      pcbFile: latest.pcbFile,
      error: "板子旁边没有 .kicad_sch：没有图纸就无法对账（tscircuit 生成的板子请用 stm32_sch_check 看 circuit.json 的网表）。",
    };
  }
  return evaluateGate(projectDir, latest.schematicFile, latest.pcbFile);
}

/** 每个引脚 `ref.number` → 它所在网络的引脚签名；未连网络的引脚不在表里。 */
function pinSignatures(sheetFile: string): Map<string, string> {
  const text = readFileSync(sheetFile, "utf8");
  const sheet = parseSchText(text, sheetFile, sheetFile);
  const built = buildSheetNets(sheet);
  const signatures = new Map<string, string>();
  for (const net of built.nets) {
    if (net.pins.length < 2) continue;
    const signature = net.pins
      .map((pin) => pin.ref + "." + pin.number)
      .sort()
      .join(",");
    for (const pin of net.pins) signatures.set(pin.ref + "." + pin.number, signature);
  }
  return signatures;
}

function diffHand(buildSheet: string, handSheet: string): HandDiff {
  if (!existsSync(handSheet)) {
    return { file: handSheet, exists: false, partsOnlyInHand: [], partsOnlyInBuild: [], pinsChanged: [] };
  }
  let hand;
  let build;
  try {
    hand = readSchematic(handSheet).report;
    build = readSchematic(buildSheet).report;
  } catch {
    return { file: handSheet, exists: true, partsOnlyInHand: [], partsOnlyInBuild: [], pinsChanged: [] };
  }
  const handRefs = new Set(hand.components.map((component) => component.ref));
  const buildRefs = new Set(build.components.map((component) => component.ref));
  const partsOnlyInHand = [...handRefs].filter((ref) => !buildRefs.has(ref)).sort();
  const partsOnlyInBuild = [...buildRefs].filter((ref) => !handRefs.has(ref)).sort();
  let pinsChanged: string[] = [];
  try {
    const handPins = pinSignatures(handSheet);
    const buildPins = pinSignatures(buildSheet);
    const keys = new Set([...handPins.keys(), ...buildPins.keys()]);
    pinsChanged = [...keys]
      .filter((key) => (handPins.get(key) ?? "") !== (buildPins.get(key) ?? ""))
      .filter((key) => {
        const ref = key.slice(0, key.indexOf("."));
        return handRefs.has(ref) && buildRefs.has(ref);
      })
      .sort();
  } catch {
    pinsChanged = [];
  }
  return { file: handSheet, exists: true, partsOnlyInHand, partsOnlyInBuild, pinsChanged };
}

function evaluateGate(projectDir: string, schematicFile: string, pcbFile: string): NetGateReport {
  let schematicMs = 0;
  let pcbMs = 0;
  try {
    schematicMs = statSync(schematicFile).mtimeMs;
    pcbMs = statSync(pcbFile).mtimeMs;
  } catch {
    // 拿不到时间戳：staleness 按未知处理，其余照常对账。
  }
  const staleSeconds = staleSecondsOf(schematicMs, pcbMs);

  let schematicReport;
  try {
    schematicReport = readSchematic(schematicFile).report;
  } catch (error) {
    return { ...EMPTY, projectDir, schematicFile: schematicFile, pcbFile: pcbFile, error: "原理图读不懂：" + (error instanceof Error ? error.message : String(error)) };
  }
  let check: PcbCheckReport | null = null;
  let pcbFootprints = 0;
  try {
    const pcb = readPcb(pcbFile);
    pcbFootprints = pcb.footprints;
    check = crossCheckPcb(schematicReport, pcb);
  } catch (error) {
    return {
      ...EMPTY,
      projectDir,
      schematicFile: schematicFile,
      pcbFile: pcbFile,
      schematicComponents: schematicReport.components.length,
      error: "板子读不懂：" + (error instanceof Error ? error.message : String(error)),
    };
  }

  const boardReport = readPcb(pcbFile);
  const connectedRefs = new Set<string>();
  for (const pads of boardReport.nets.values()) {
    for (const pad of pads) connectedRefs.add(pad.ref);
  }
  const schematicRefs = schematicReport.components.map((component) => component.ref);
  const findings = findingsOf(staleSeconds, check, schematicRefs, [...boardReport.refs], [...connectedRefs]);

  // 手绘层：只比元件与网络，不比坐标（坐标每次构建都会被重排）。
  const hand = diffHand(schematicFile, drawSheetPath(projectDir));
  if (hand.partsOnlyInHand.length > 0) {
    findings.push({
      id: "hand.part-not-in-build",
      severity: "warning",
      message: "手绘层多了元件：" + hand.partsOnlyInHand.slice(0, 8).join("、") + (hand.partsOnlyInHand.length > 8 ? " 等" : ""),
      fix: "这些元件只在 hardware/schematic 里：要么用 stm32_sch_import 把它们吸收回 circuit.tsx，要么明确手绘层就是最终图纸",
    });
  }
  if (hand.pinsChanged.length > 0) {
    findings.push({
      id: "hand.net-diff",
      severity: "warning",
      message: "手绘层有 " + String(hand.pinsChanged.length) + " 个引脚的网络与生成图纸不同：" + hand.pinsChanged.slice(0, 8).join("、"),
      fix: "先确认哪一边是想要的；要保留手绘改法就吸收回源，否则用 seed 重新拷底图",
    });
  }
  const state: NetGateState =
    findings.some((finding) => finding.id === "gate.net-split") || findings.some((finding) => finding.id === "gate.pad-missing")
      ? "mismatch"
      : staleSeconds > 0
        ? "stale"
        : "ok";
  const notes: string[] = [];
  if (check.compared === 0) notes.push("没有可比较的网络：图纸与板子上都没有至少两个可对上的焊盘。");
  if (check.missingPads.length === 40) notes.push("缺焊盘只统计到 40 个（工具上限），实际可能更多。");
  if (boardReport.refs.length > connectedRefs.size) {
    notes.push(`板子上有 ${boardReport.refs.length - connectedRefs.size} 个带位号的封装没接到任何网络（安装孔、测试点常见），不计入连通性对账。`);
  }
  if (schematicReport.warnings.length > 0) notes.push("图纸解析提示：" + schematicReport.warnings.slice(0, 3).join("；"));

  return {
    ok: true,
    error: "",
    projectDir,
    schematicFile: schematicFile,
    pcbFile: pcbFile,
    state,
    staleSeconds,
    schematicComponents: schematicReport.components.length,
    pcbFootprints,
    compared: check.compared,
    matched: check.matched,
    split: check.split.length,
    nameMismatches: check.nameMismatches.length,
    missingPads: check.missingPads.length,
    hand,
    findings,
    notes,
  };
}

/** 一句话状态，面板与工具共用。 */
export function netGateSummary(report: NetGateReport): string {
  if (!report.ok) return report.error;
  if (report.state === "ok") return `一致：${report.compared} 条网络对上 ${report.matched} 条`;
  if (report.state === "stale") return `板子比图纸旧 ${report.staleSeconds} 秒`;
  return `不一致：拆开 ${report.split} 条、缺焊盘 ${report.missingPads} 个`;
}
