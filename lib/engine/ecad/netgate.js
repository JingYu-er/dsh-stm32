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
import { statSync } from "node:fs";
import { resolveProjectLayout } from "../project-layout.js";
import { findLatestKicadBuild, planEcadWorkspace } from "./tsci.js";
import { readSchematic } from "../schematic/model.js";
import { crossCheckPcb, readPcb } from "../schematic/pcb.js";
const EMPTY = {
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
    findings: [],
    notes: [],
};
/** 板子比图纸旧多少秒（只在图纸更新时为正）。 */
function staleSecondsOf(schematicMs, pcbMs) {
    if (schematicMs <= 0 || pcbMs <= 0)
        return 0;
    const delta = schematicMs - pcbMs;
    return delta > 2000 ? Math.round(delta / 1000) : 0;
}
function findingsOf(staleSeconds, check, schematicRefs, boardRefs, connectedRefs) {
    const findings = [];
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
export function checkNetGate(projectDir, options = {}) {
    if (options.pcbFile !== undefined && options.schematicFile !== undefined) {
        return evaluateGate(projectDir, options.schematicFile, options.pcbFile);
    }
    if (projectDir.trim() === "")
        return { ...EMPTY, error: "projectDir 不能为空" };
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
function evaluateGate(projectDir, schematicFile, pcbFile) {
    let schematicMs = 0;
    let pcbMs = 0;
    try {
        schematicMs = statSync(schematicFile).mtimeMs;
        pcbMs = statSync(pcbFile).mtimeMs;
    }
    catch {
        // 拿不到时间戳：staleness 按未知处理，其余照常对账。
    }
    const staleSeconds = staleSecondsOf(schematicMs, pcbMs);
    let schematicReport;
    try {
        schematicReport = readSchematic(schematicFile).report;
    }
    catch (error) {
        return { ...EMPTY, projectDir, schematicFile: schematicFile, pcbFile: pcbFile, error: "原理图读不懂：" + (error instanceof Error ? error.message : String(error)) };
    }
    let check = null;
    let pcbFootprints = 0;
    try {
        const pcb = readPcb(pcbFile);
        pcbFootprints = pcb.footprints;
        check = crossCheckPcb(schematicReport, pcb);
    }
    catch (error) {
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
    const connectedRefs = new Set();
    for (const pads of boardReport.nets.values()) {
        for (const pad of pads)
            connectedRefs.add(pad.ref);
    }
    const schematicRefs = schematicReport.components.map((component) => component.ref);
    const findings = findingsOf(staleSeconds, check, schematicRefs, [...boardReport.refs], [...connectedRefs]);
    const state = findings.some((finding) => finding.id === "gate.net-split") || findings.some((finding) => finding.id === "gate.pad-missing")
        ? "mismatch"
        : staleSeconds > 0
            ? "stale"
            : "ok";
    const notes = [];
    if (check.compared === 0)
        notes.push("没有可比较的网络：图纸与板子上都没有至少两个可对上的焊盘。");
    if (check.missingPads.length === 40)
        notes.push("缺焊盘只统计到 40 个（工具上限），实际可能更多。");
    if (boardReport.refs.length > connectedRefs.size) {
        notes.push(`板子上有 ${boardReport.refs.length - connectedRefs.size} 个带位号的封装没接到任何网络（安装孔、测试点常见），不计入连通性对账。`);
    }
    if (schematicReport.warnings.length > 0)
        notes.push("图纸解析提示：" + schematicReport.warnings.slice(0, 3).join("；"));
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
        findings,
        notes,
    };
}
/** 一句话状态，面板与工具共用。 */
export function netGateSummary(report) {
    if (!report.ok)
        return report.error;
    if (report.state === "ok")
        return `一致：${report.compared} 条网络对上 ${report.matched} 条`;
    if (report.state === "stale")
        return `板子比图纸旧 ${report.staleSeconds} 秒`;
    return `不一致：拆开 ${report.split} 条、缺焊盘 ${report.missingPads} 个`;
}
