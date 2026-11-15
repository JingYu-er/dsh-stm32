/**
 * 一键设计（S134）。
 *
 * 电路设计不是「点七个按钮」，而是一条流水线：构建 → 归一化 → 合并焊盘 → 导库 →
 * ERC/DRC → 可制造性与成本 → 制造文件。这里把它们串起来，每一步都留下痕迹，
 * 失败也继续往下走（只读检查与导出不依赖上一步的「全部成功」）。
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportFabrication } from "./fabrication.js";
import { exportStep, runDrc, runErc } from "./checks.js";
import { checkDfm } from "./dfm.js";
import { exportEmbeddedLibraries } from "./libs.js";
import { mergeCoincidentPads } from "./padmerge.js";
import { precheckFootprints } from "./padprecheck.js";
import { runTsciBuild } from "./tsci.js";
function pcbOf(kicadDir) {
    const name = readdirSync(kicadDir).find((item) => item.endsWith(".kicad_pcb"));
    return name === undefined ? "" : join(kicadDir, name);
}
function schOf(kicadDir) {
    const name = readdirSync(kicadDir).find((item) => item.endsWith(".kicad_sch"));
    return name === undefined ? "" : join(kicadDir, name);
}
export async function runEcadDesign(request) {
    const { subprocess, toolchain, workspace } = request;
    const steps = [];
    const notes = [];
    const record = (step, ok, detail, startedAt) => {
        steps.push({ step, ok, detail, ms: Date.now() - startedAt });
    };
    // 1. 预检封装：同坐标焊盘会让布线器放弃整板，先看清再决定要不要降级。
    let started = Date.now();
    const entries = readdirSync(workspace.circuitDir).filter((name) => name.endsWith(".circuit.tsx"));
    const entry = request.entry === undefined || request.entry === "" ? (entries[0] ?? "") : request.entry;
    const tsxFile = entry === "" ? "" : join(workspace.circuitDir, entry);
    const precheck = tsxFile === ""
        ? { ok: true, error: "", checked: 0, blockers: [], notes: [] }
        : await precheckFootprints(tsxFile, { signal: request.signal });
    record("预检", precheck.ok, precheck.blockers.length === 0
        ? "封装检查通过（" + String(precheck.checked) + " 个）"
        : "发现 " + String(precheck.blockers.length) + " 组同坐标焊盘，构建将跳过自动布线", started);
    // 2. 构建：内部已包含封装名归一化、立创封装固化、设计规则落盘。
    started = Date.now();
    const built = await runTsciBuild({
        subprocess,
        toolchain,
        workspace,
        ...(entry === "" ? {} : { entry }),
        ...(precheck.blockers.length > 0 ? { routingDisabled: true } : {}),
        signal: request.signal,
    });
    notes.push(...built.notes);
    record("构建", built.ok, built.ok ? "KiCad 工程已生成（" + String(Math.round(built.durationMs / 1000)) + " s）" : built.error, started);
    const kicadDir = built.kicadProjectDir;
    if (!built.ok || kicadDir === "") {
        return { ok: false, error: built.error, steps, kicadDir: "", pcbFile: "", schematicFile: "", notes };
    }
    const pcbFile = pcbOf(kicadDir);
    const schematicFile = schOf(kicadDir);
    // 3. 合并焊盘（可选）：同坐标、同网络的焊盘并成一个多编号焊盘。
    if (request.mergePads !== false && pcbFile !== "") {
        started = Date.now();
        const merged = mergeCoincidentPads(readFileSync(pcbFile, "utf8"));
        if (merged.merged.length > 0)
            writeFileSync(pcbFile, merged.text, "utf8");
        const detail = merged.merged.length === 0
            ? "没有需要合并的焊盘"
            : "合并 " + String(merged.merged.length) + " 组（" + merged.merged.map((group) => group.names.join("/")).join("、") + "）";
        notes.push(...merged.skipped.map((skip) => "未合并：" + skip.names.join("/") + "——" + skip.reason));
        record("合并焊盘", true, detail, started);
    }
    // 4. 导库：把内嵌封装与符号抽成工程自带库，KiCad 打开时不必再配库路径。
    started = Date.now();
    const libs = exportEmbeddedLibraries(workspace, pcbFile, schematicFile);
    record("导库", libs.ok, libs.ok
        ? "封装库 " + String(libs.footprintLibs.length) + " 个、符号库 " + String(libs.symbolLibs.length) + " 个"
        : libs.error, started);
    // 5. ERC / DRC：只读检查，失败也继续（结果本身就是产物）。
    started = Date.now();
    const erc = await runErc(subprocess, toolchain, schematicFile, request.signal);
    record("ERC", erc.ok, erc.ok ? String(erc.summary.errors) + " 错误 / " + String(erc.summary.warnings) + " 警告" : erc.error, started);
    started = Date.now();
    const drc = await runDrc(subprocess, toolchain, pcbFile, request.signal);
    record("DRC", drc.ok, drc.ok ? String(drc.summary.errors) + " 错误 / " + String(drc.summary.warnings) + " 警告" : drc.error, started);
    // 6. 可制造性与成本：判据是嘉立创常规工艺，只有提示，不阻断。
    started = Date.now();
    const dfm = checkDfm(readFileSync(pcbFile, "utf8"));
    record("可制造性", true, String(dfm.facts.widthMm.toFixed(1)) + "×" + String(dfm.facts.heightMm.toFixed(1)) + " mm、" +
        String(dfm.facts.layers) + " 层、最细走线 " + String(dfm.facts.minTrackMm) + " mm、打样约 " + String(dfm.cost.approxCny) + " 元", started);
    // 7. 制造文件：STEP 与 Gerber/钻孔/坐标。
    if (request.artifacts !== false) {
        started = Date.now();
        const step = await exportStep(subprocess, toolchain, pcbFile, join(workspace.outDir, "board.step"), request.signal, { libsDir: workspace.libsDir });
        record("STEP", step.ok, step.ok ? String(Math.round(step.bytes / 1024)) + " KB（模型缺 " + String(step.missingModels.length) + " 个）" : step.error, started);
        started = Date.now();
        const fab = await exportFabrication(subprocess, toolchain, pcbFile, workspace.outDir, request.signal);
        record("制造文件", fab.ok, fab.ok
            ? "Gerber " + String(fab.gerbers.length) + " 个、钻孔 " + String(fab.drillFiles.length) + " 个、坐标 " + (fab.posFile === "" ? "无" : "有")
            : fab.error, started);
    }
    const failed = steps.filter((step) => !step.ok);
    const checkErrors = (erc.ok ? erc.summary.errors : 0) + (drc.ok ? drc.summary.errors : 0);
    const problems = [
        ...failed.map((step) => step.step + "：" + step.detail),
        ...(checkErrors > 0 ? ["ERC/DRC 共 " + String(checkErrors) + " 条错误"] : []),
    ];
    return {
        ok: failed.length === 0 && checkErrors === 0,
        error: problems.join("；"),
        steps,
        kicadDir,
        pcbFile,
        schematicFile,
        notes,
    };
}
