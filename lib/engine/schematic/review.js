/**
 * 原理图一键评审（S135）。
 *
 * 把「读图 → 与 .ioc 对账 → 出 .ioc 草案」串成一次调用，并只给一个总判据：
 * 有 error 即不通过。所有需要人决策的项（例如某颗芯片的某个脚没有该复用功能）
 * 单独归到 decisions，避免与「必须修的错」混在一起。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { locateCubemxDb, readMcuFacts } from "../cubemx-db.js";
import { mcuFromIoc } from "../facts.js";
import { resolveProjectLayout } from "../project-layout.js";
import { resolveSearchConfig } from "../../data/search-roots.js";
import { checkSchematic } from "./checks.js";
import { findRootSchematic, readSchematic } from "./model.js";
import { draftIoc } from "./to-ioc.js";
function findRoot(projectDir, explicit) {
    if (explicit !== "")
        return { file: explicit, error: "" };
    // 硬件目录按工程约定解析（hardware/ 或 hardware/kicad），与流程图页用同一套判据（S135）。
    const layout = resolveProjectLayout(projectDir);
    const dirs = [layout.hardwareDir, layout.projectDir].filter((dir) => dir !== "");
    for (const dir of dirs) {
        const found = findRootSchematic(dir);
        if (found !== null)
            return { file: found, error: "" };
    }
    return { file: "", error: "工程里没有 .kicad_sch：先选择包含 KiCad 工程的目录，或在参数里给 rootFile" };
}
/** 从 .ioc 里取器件库的文件名（Mcu.Name），它比 CPN 更接近 db 里的命名。 */
function dbMcuNameOf(firmwareDir) {
    try {
        const name = readdirSync(firmwareDir).find((item) => item.endsWith(".ioc"));
        if (name === undefined)
            return "";
        const text = readFileSync(join(firmwareDir, name), "utf8");
        const match = /^Mcu\.Name=(.+)$/mu.exec(text);
        return match === null ? "" : (match[1] ?? "").trim();
    }
    catch {
        return "";
    }
}
/** 读图、对账、出草案，汇总成一份可读的评审结果。 */
export function runSchematicReview(request, tools = {}) {
    const steps = [];
    const notes = [];
    const started = Date.now();
    const root = findRoot(request.projectDir, request.rootFile ?? "");
    if (root.file === "") {
        return {
            ok: false,
            error: root.error,
            rootFile: "",
            steps,
            components: 0,
            nets: 0,
            mcu: null,
            findings: [],
            errors: 0,
            warnings: 0,
            ioc: null,
            decisions: [],
            notes,
        };
    }
    let mark = Date.now();
    const read = readSchematic(root.file);
    steps.push({ step: "读图", ok: true, detail: read.report.components.length + " 个元件 / " + read.report.nets.length + " 个网络", ms: Date.now() - mark });
    if (read.report.mcu === null)
        notes.push("没有识别出主控：流程图与引脚矩阵会为空");
    const schematic = read.report;
    mark = Date.now();
    const check = checkSchematic(schematic, {});
    steps.push({ step: "规则检查", ok: true, detail: check.summary.errors + " 错误 / " + check.summary.warnings + " 警告", ms: Date.now() - mark });
    mark = Date.now();
    let draft = null;
    const mcu = schematic.mcu;
    if (mcu !== null) {
        // 原理图里常常没写型号（tscircuit 导出的符号 Value 为空）：回落到 .ioc 里的芯片型号。
        const layout = resolveProjectLayout(request.projectDir);
        const firmware = layout.firmwareDir === "" ? layout.projectDir : layout.firmwareDir;
        const dbName = dbMcuNameOf(firmware);
        const wanted = mcu.value !== "" ? mcu.value : (dbName !== "" ? dbName : (mcuFromIoc(firmware) ?? ""));
        const roots = request.cubeMxRoots !== undefined && request.cubeMxRoots.length > 0
            ? [...request.cubeMxRoots]
            : resolveSearchConfig(process.env).cubeMxRoots;
        const db = locateCubemxDb(roots);
        if (db === null) {
            notes.push("没有找到 CubeMX 器件库：.ioc 草案只给网络名，信号建议要装 CubeMX 后才准");
        }
        else {
            const facts = wanted === "" ? null : readMcuFacts(db, wanted);
            if (wanted === "")
                notes.push("原理图与 .ioc 里都没有写芯片型号：先补型号再生成配置草案");
            else if (facts === null)
                notes.push("器件库里没有 " + wanted + "：跳过信号匹配");
            else
                draft = draftIoc(schematic, facts);
        }
    }
    steps.push({ step: "配置草案", ok: true, detail: draft === null ? "未生成" : draft.pins.length + " 个脚，待确认 " + String(draft.unresolved.length), ms: Date.now() - mark });
    const decisions = [];
    if (draft !== null) {
        for (const pin of draft.pins) {
            if (pin.signal !== "" || pin.net === "")
                continue;
            decisions.push({ pin: pin.number + " " + pin.name, net: pin.net, reason: pin.note === "" ? "器件库没有该脚的匹配信号" : pin.note });
        }
        for (const item of draft.softwareFallbacks) {
            decisions.push({ pin: item.pin, net: item.net, reason: "硬件复用对不上，可改用软件模拟 " + item.protocol + "：" + item.tradeoff });
        }
    }
    const errors = check.summary.errors;
    return {
        ok: errors === 0,
        error: errors === 0 ? "" : "原理图检查有 " + String(errors) + " 条错误",
        rootFile: root.file,
        steps,
        components: schematic.components.length,
        nets: schematic.nets.length,
        mcu: mcu === null ? null : { ref: mcu.ref, value: mcu.value },
        findings: check.findings.map((item) => ({ rule: item.rule, severity: item.severity, message: item.message })),
        errors: check.summary.errors,
        warnings: check.summary.warnings,
        ioc: draft === null ? null : {
            pins: draft.pins.length,
            unresolved: draft.unresolved.map((item) => item.number + " " + item.net),
            softwareFallbacks: draft.softwareFallbacks.map((item) => item.pin + " " + item.protocol),
        },
        decisions,
        notes: [...notes, ...(Date.now() - started > 3000 ? ["本次评审耗时 " + String(Date.now() - started) + " ms"] : [])],
    };
}
