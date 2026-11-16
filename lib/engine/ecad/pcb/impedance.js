/**
 * 阻抗规则写回（S168）。
 *
 * 目的：把 S157 算出来的「多少欧该多宽」变成 KiCad 能执行的约束，而不是停在面板上一个数字。
 *
 * 三条口径：
 * 1. KiCad 10 的 DRC 约束里**没有 impedance 这个类型**（只有 track_width / clearance /
 *    diff_pair_gap / length 这些几何量），所以写进去的是「为了 50 Ω 该多宽」的宽度与间距，
 *    并在输出里说明：真正的阻抗要板厂按叠层打样验证。
 * 2. 规则只写**点名的网络**：差分对默认从板子里认出来（S167 的配对逻辑），单端 50 Ω 必须由调用方
 *    点名，避免给整板所有线都加同一个宽度约束。
 * 3. 与工艺规则同文件（`<工程>.kicad_dru`），一次写全、可重复写：基础档在前，阻抗规则在后。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { analyzeStackup, presetForLayers } from "./stackup.js";
import { analyzeEmcDeep } from "./emc-deep.js";
import { fabFloorForLayers } from "./rules.js";
const EMPTY = {
    ok: false,
    error: "",
    boardFile: "",
    rulesFile: "",
    copperLayers: 0,
    presetLabel: "",
    suggestions: [],
    rules: [],
    written: false,
    notes: [],
};
/** 从板子里认出差分对（复用 S167 的后缀配对）。 */
export function detectDiffNets(pcbText, boardFile = "") {
    const report = analyzeEmcDeep(pcbText, boardFile);
    if (!report.ok)
        return [];
    return report.pairs.map((pair) => ({ id: pair.id, positive: pair.positive, negative: pair.negative }));
}
/** 一条规则的 KiCad 语法：约束作用在满足 condition 的铜上。 */
function widthRule(label, condition, widthMm) {
    return `(rule "${label}" (condition "${condition}") (constraint track_width (opt ${widthMm.toFixed(3)}mm)))`;
}
function gapRule(label, condition, gapMm) {
    return `(rule "${label}" (condition "${condition}") (constraint diff_pair_gap (opt ${gapMm.toFixed(3)}mm)))`;
}
function quoteNames(names) {
    const clauses = names.map((name) => "A.NetName == '" + name.replace(/'/gu, "") + "'");
    return clauses.length === 1 ? clauses[0] : clauses.join(" || ");
}
/** 生成计划（可只回文本，不写盘）。 */
export function planImpedance(kicadDir, boardText, boardFile, options = {}) {
    const spacingMm = typeof options.spacingMm === "number" && options.spacingMm > 0 ? options.spacingMm : 0.2;
    const stackup = analyzeStackup(boardText, boardFile, spacingMm);
    if (!stackup.ok)
        return { ...EMPTY, boardFile, error: stackup.error };
    const preset = presetForLayers(stackup.copperLayers);
    const pairs = detectDiffNets(boardText, boardFile).slice(0, 12);
    const singles = (options.singles ?? []).filter((name) => name.trim() !== "");
    const suggestions = [];
    const rules = [];
    const notes = [];
    const singleSuggest = stackup.suggestions.find((item) => item.kind === "microstrip");
    const diffSuggest = stackup.suggestions.find((item) => item.kind === "differential-microstrip" && item.targetOhm === 90) ??
        stackup.suggestions.find((item) => item.kind === "differential-microstrip");
    for (const name of singles) {
        if (singleSuggest === undefined)
            break;
        rules.push(widthRule("阻抗 50Ω 单端 " + name, quoteNames([name]), singleSuggest.widthMm));
        suggestions.push({ ...singleSuggest, nets: [name] });
    }
    if (diffSuggest !== undefined) {
        for (const pair of pairs) {
            const condition = quoteNames([pair.positive, pair.negative]);
            rules.push(widthRule("阻抗 90Ω 差分 " + pair.id + " 线宽", condition, diffSuggest.widthMm));
            rules.push(gapRule("阻抗 90Ω 差分 " + pair.id + " 间距", condition, spacingMm));
            suggestions.push({ ...diffSuggest, nets: [pair.positive, pair.negative] });
        }
    }
    if (singles.length === 0)
        notes.push("没有点名单端网络：单端 50 Ω 的宽度需要你指定网络名（nets），不给就不写规则。");
    if (pairs.length === 0)
        notes.push("板子里没有认出差分对：差分规则没写。");
    notes.push("KiCad 的 DRC 没有 impedance 约束：这里写的是「为达到目标阻抗该用的线宽与间距」，阻抗本身要板厂按叠层打样验证。");
    notes.push("规则只作用于点名的网络；其它网络仍按工艺下限判。");
    if (!existsSync(kicadDir))
        return { ...EMPTY, boardFile, error: "KiCad 工程目录不存在：" + kicadDir };
    const project = readdirSync(kicadDir).find((name) => name.endsWith(".kicad_pro"));
    if (project === undefined)
        return { ...EMPTY, boardFile, error: "没有 .kicad_pro：" + kicadDir };
    const stem = basename(project, ".kicad_pro");
    const rulesFile = join(kicadDir, stem + ".kicad_dru");
    if (options.write !== true) {
        return { ...EMPTY, ok: true, boardFile, rulesFile, copperLayers: stackup.copperLayers, presetLabel: preset.label, suggestions, rules, written: false, notes };
    }
    const floor = fabFloorForLayers(stackup.copperLayers);
    const base = [
        "(version 1)",
        `(rule "嘉立创 最小线宽" (constraint track_width (min ${floor.trackWidthMm.toFixed(3)}mm)))`,
        `(rule "嘉立创 最小间距" (constraint clearance (min ${floor.clearanceMm.toFixed(3)}mm)))`,
        `(rule "嘉立创 最小孔径" (constraint hole_size (min ${floor.viaDrillMm.toFixed(3)}mm)))`,
        `(rule "嘉立创 最小环宽" (constraint annular_width (min 0.130mm)))`,
    ];
    const text = [...base, ...rules, ""].join("\n");
    try {
        writeFileSync(rulesFile, text, "utf8");
    }
    catch (error) {
        return { ...EMPTY, boardFile, rulesFile, error: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true, error: "", boardFile, rulesFile, copperLayers: stackup.copperLayers, presetLabel: preset.label, suggestions, rules, written: true, notes };
}
/** 读一个板子并生成计划（工具与路由共用）。 */
export function readImpedancePlan(kicadDir, boardFile, options = {}) {
    try {
        return planImpedance(kicadDir, readFileSync(boardFile, "utf8"), boardFile, options);
    }
    catch (error) {
        return { ...EMPTY, boardFile, error: error instanceof Error ? error.message : String(error) };
    }
}
