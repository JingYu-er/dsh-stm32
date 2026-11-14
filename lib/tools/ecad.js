/**
 * L3：电路设计工具（S97）——用 tscircuit 画板，用 kicad-cli 验收，导出 STEP。
 *
 * 四个工具的分工：
 *   stm32_ecad_init  一次性的工作区初始化（circuit/ 骨架与四个目录）
 *   stm32_ecad_build 跑 tsci build：tsx → circuit.json + svg + 真 KiCad 工程
 *   stm32_ecad_check 跑 kicad-cli ERC/DRC：把违规项收敛成结构化清单
 *   stm32_ecad_step  从 KiCad 板导出 STEP，并报告缺失的 3D 模型
 *
 * 写者只有一个：`.kicad_sch` / `.kicad_pcb` 由 tscircuit 生成，本层不直接改它们。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { exportStep, runDrc, runErc } from "../engine/ecad/checks.js";
import { locateEcadToolchain } from "../engine/ecad/toolchain.js";
import { dirSizeBytes, initEcadWorkspace, listCircuitEntries, planEcadWorkspace, runTsciBuild, } from "../engine/ecad/tsci.js";
import { resolveProjectDir } from "./project-dir.js";
import { resolveProjectLayout } from "../engine/project-layout.js";
export const ECAD_INIT_TOOL = "stm32_ecad_init";
export const ECAD_BUILD_TOOL = "stm32_ecad_build";
export const ECAD_CHECK_TOOL = "stm32_ecad_check";
export const ECAD_STEP_TOOL = "stm32_ecad_step";
const findingSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        rule: { type: "string" },
        severity: { type: "string" },
        message: { type: "string" },
        items: { type: "array", items: { type: "string" } },
    },
    required: ["rule", "severity", "message", "items"],
};
const checkSummarySchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        errors: { type: "number" },
        warnings: { type: "number" },
        findings: { type: "array", items: findingSchema },
    },
    required: ["errors", "warnings", "findings"],
};
/** 工程根与 ECAD 工作区（`hardware/`），找不到硬件目录时按约定落到 `<工程>/hardware`。 */
function workspaceOf(projectDir) {
    const layout = resolveProjectLayout(projectDir);
    // 空串交给 planEcadWorkspace 处理：它会落到 <工程>/hardware，而不是把工程根当硬件目录。
    return planEcadWorkspace(projectDir, layout.hardwareDir);
}
async function projectDirOf(ctx, raw, exec) {
    const resolved = await resolveProjectDir(ctx, typeof raw === "string" ? raw : "", exec);
    if (resolved.projectDir === "") {
        return {
            ok: false,
            dir: "",
            error: "projectDir 不能为空：从工具栏「工程」下拉里选一个，或先打开调试会话",
        };
    }
    return { ok: true, dir: resolved.projectDir, error: "" };
}
function formatReport(name, report) {
    const lines = [name + "：" + String(report.summary.errors) + " error / " + String(report.summary.warnings) + " warning"];
    for (const finding of report.summary.findings.slice(0, 12)) {
        const items = finding.items.length > 0 ? "（" + finding.items.join("；") + "）" : "";
        lines.push("  [" + finding.severity + "] " + finding.rule + " " + finding.message + items);
    }
    if (report.summary.findings.length > 12)
        lines.push("  …还有 " + String(report.summary.findings.length - 12) + " 条");
    if (report.reportPath !== "")
        lines.push("  报告：" + report.reportPath);
    if (!report.ok && report.error !== "")
        lines.push("  命令输出：" + report.error.split(/\r?\n/u)[0]);
    return lines;
}
export function registerEcadTools(ctx) {
    ctx.tools.register({
        name: ECAD_INIT_TOOL,
        description: "初始化硬件工作区：在 hardware/ 下建 circuit/（tscircuit 工程）、kicad/、libs/、out/ 并写 package.json。不装依赖，装依赖按提示执行 npm install。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                projectDir: { type: "string", description: "工程根目录；缺省为会话工作目录。" },
            },
            required: [],
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    ok: { type: "boolean" },
                    error: { type: "string" },
                    root: { type: "string" },
                    circuitDir: { type: "string" },
                    created: { type: "array", items: { type: "string" } },
                    entries: { type: "array", items: { type: "string" } },
                    nodeModulesReady: { type: "boolean" },
                    notes: { type: "array", items: { type: "string" } },
                },
                required: ["ok", "error", "root", "circuitDir", "created", "entries", "nodeModulesReady", "notes"],
            },
            render: (_args, value) => {
                const result = value;
                if (!result.ok)
                    return [{ type: "text", text: "初始化失败：" + result.error }];
                const lines = ["工作区：" + result.root, "tscircuit 工程：" + result.circuitDir];
                lines.push(result.nodeModulesReady ? "依赖：已安装" : "依赖：未安装，先在该目录执行 npm install（约 730 MB）");
                if (result.created.length > 0)
                    lines.push("新建：" + result.created.join("、"));
                lines.push(result.entries.length > 0 ? "入口：" + result.entries.join("、") : "入口：还没有 *.circuit.tsx");
                for (const note of result.notes)
                    lines.push("- " + note);
                return [{ type: "text", text: lines.join("\n") }];
            },
        },
        timeoutMs: 60_000,
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const project = await projectDirOf(ctx, args.projectDir, exec);
            if (!project.ok) {
                return {
                    ok: false,
                    error: project.error,
                    root: "",
                    circuitDir: "",
                    created: [],
                    entries: [],
                    nodeModulesReady: false,
                    notes: [],
                };
            }
            const toolchain = locateEcadToolchain();
            const workspace = workspaceOf(project.dir);
            const init = initEcadWorkspace(workspace);
            const installed = existsSync(join(workspace.circuitDir, "node_modules", "tscircuit"));
            const notes = [...toolchain.toolchain?.notes ?? []];
            if (toolchain.toolchain === null)
                notes.push(toolchain.error);
            if (installed)
                notes.push("node_modules 占用 " + String(Math.round(dirSizeBytes(join(workspace.circuitDir, "node_modules")) / 1048576)) + " MB");
            return {
                ok: init.ok,
                error: init.error,
                root: workspace.root,
                circuitDir: workspace.circuitDir,
                created: [...init.created],
                entries: listCircuitEntries(workspace.circuitDir),
                nodeModulesReady: installed,
                notes,
            };
        },
    });
    ctx.tools.register({
        name: ECAD_BUILD_TOOL,
        description: "构建电路：用 KiCad 自带的 bun 跑 tscircuit build，把 hardware/circuit 下的 .circuit.tsx 生成 circuit.json、原理图/PCB 的 SVG 与真 KiCad 工程（hardware/kicad）。不装依赖。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                projectDir: { type: "string", description: "工程根目录；缺省为会话工作目录。" },
                entry: { type: "string", description: "入口文件（相对 hardware/circuit）；缺省让 tscircuit 自己找。" },
                svgs: { type: "boolean", description: "是否同时生成 SVG；默认 true。" },
            },
            required: [],
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    ok: { type: "boolean" },
                    error: { type: "string" },
                    durationMs: { type: "number" },
                    kicadDir: { type: "string" },
                    circuitJson: { type: "string" },
                    pcbSvg: { type: "string" },
                    schematicSvg: { type: "string" },
                    exitCode: { type: "number" },
                    notes: { type: "array", items: { type: "string" } },
                    stderrTail: { type: "string" },
                },
                required: ["ok", "error", "durationMs", "kicadDir", "circuitJson", "pcbSvg", "schematicSvg", "exitCode", "notes", "stderrTail"],
            },
            render: (_args, value) => {
                const result = value;
                const lines = [
                    result.ok
                        ? "构建完成（" + String(Math.round(result.durationMs / 100) / 10) + " s）"
                        : "构建失败（exit " + String(result.exitCode) + "）",
                ];
                if (result.kicadDir !== "")
                    lines.push("KiCad 工程：" + result.kicadDir);
                if (result.circuitJson !== "")
                    lines.push("circuit.json：" + result.circuitJson);
                if (result.pcbSvg !== "")
                    lines.push("PCB 预览：" + result.pcbSvg);
                if (result.schematicSvg !== "")
                    lines.push("原理图预览：" + result.schematicSvg);
                if (!result.ok && result.error !== "")
                    lines.push("原因：" + result.error.split(/\r?\n/u).slice(0, 6).join("\n"));
                for (const note of result.notes)
                    lines.push("- " + note);
                return [{ type: "text", text: lines.join("\n") }];
            },
        },
        timeoutMs: 330_000,
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const project = await projectDirOf(ctx, args.projectDir, exec);
            if (!project.ok) {
                return {
                    ok: false,
                    error: project.error,
                    durationMs: 0,
                    kicadDir: "",
                    circuitJson: "",
                    pcbSvg: "",
                    schematicSvg: "",
                    exitCode: -1,
                    notes: [],
                    stderrTail: "",
                };
            }
            const located = locateEcadToolchain();
            if (located.toolchain === null) {
                return {
                    ok: false,
                    error: located.error,
                    durationMs: 0,
                    kicadDir: "",
                    circuitJson: "",
                    pcbSvg: "",
                    schematicSvg: "",
                    exitCode: -1,
                    notes: [],
                    stderrTail: "",
                };
            }
            const workspace = workspaceOf(project.dir);
            const built = await runTsciBuild({
                subprocess: ctx.subprocess,
                toolchain: located.toolchain,
                workspace,
                ...(args.entry === undefined ? {} : { entry: args.entry }),
                ...(args.svgs === undefined ? {} : { svgs: args.svgs }),
                signal: exec.signal,
            });
            return {
                ok: built.ok,
                error: built.error,
                durationMs: built.durationMs,
                kicadDir: built.kicadProjectDir,
                circuitJson: built.circuitJson,
                pcbSvg: built.pcbSvg,
                schematicSvg: built.schematicSvg,
                exitCode: built.exitCode ?? -1,
                notes: [...built.notes],
                stderrTail: built.stderrTail,
            };
        },
    });
    ctx.tools.register({
        name: ECAD_CHECK_TOOL,
        description: "检查电路：对生成的 KiCad 工程跑 kicad-cli ERC 与 DRC（含未连接项与原理图/PCB 一致性），把违规项收敛成清单。只读。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                projectDir: { type: "string", description: "工程根目录；缺省为会话工作目录。" },
                severity: {
                    type: "string",
                    enum: ["all", "warning", "error"],
                    description: "只返回不低于该级别的发现；默认 all。",
                },
            },
            required: [],
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    ok: { type: "boolean" },
                    error: { type: "string" },
                    kicadDir: { type: "string" },
                    schematicFile: { type: "string" },
                    pcbFile: { type: "string" },
                    erc: checkSummarySchema,
                    drc: checkSummarySchema,
                },
                required: ["ok", "error", "kicadDir", "schematicFile", "pcbFile", "erc", "drc"],
            },
            render: (_args, value) => {
                const result = value;
                if (!result.ok)
                    return [{ type: "text", text: "检查未执行：" + result.error }];
                const erc = result.erc;
                const drc = result.drc;
                return [{ type: "text", text: [formatReport("ERC", { ok: true, error: "", file: result.schematicFile, reportPath: "", summary: erc, raw: "" }), ...formatReport("DRC", { ok: true, error: "", file: result.pcbFile, reportPath: "", summary: drc, raw: "" })].join("\n") }];
            },
        },
        timeoutMs: 240_000,
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const empty = { errors: 0, warnings: 0, findings: [] };
            const project = await projectDirOf(ctx, args.projectDir, exec);
            if (!project.ok) {
                return { ok: false, error: project.error, kicadDir: "", schematicFile: "", pcbFile: "", erc: empty, drc: empty };
            }
            const located = locateEcadToolchain();
            if (located.toolchain === null) {
                return { ok: false, error: located.error, kicadDir: "", schematicFile: "", pcbFile: "", erc: empty, drc: empty };
            }
            const workspace = workspaceOf(project.dir);
            const { findLatestKicadBuild } = await import("../engine/ecad/tsci.js");
            const latest = findLatestKicadBuild(workspace);
            if (!latest.ok) {
                return { ok: false, error: latest.error, kicadDir: "", schematicFile: "", pcbFile: "", erc: empty, drc: empty };
            }
            const sch = latest.schematicFile;
            const pcb = latest.pcbFile;
            const [erc, drc] = await Promise.all([
                runErc(ctx.subprocess, located.toolchain, sch, exec.signal),
                runDrc(ctx.subprocess, located.toolchain, pcb, exec.signal),
            ]);
            return {
                ok: erc.ok && drc.ok,
                error: erc.ok ? drc.error : erc.error,
                kicadDir: latest.kicadDir,
                schematicFile: sch,
                pcbFile: pcb,
                erc: erc.summary,
                drc: drc.summary,
            };
        },
    });
    ctx.tools.register({
        name: ECAD_STEP_TOOL,
        description: "导出 STEP：对生成的 KiCad 板跑 kicad-cli pcb export step，写到 hardware/out。3D 模型缺失只报告不阻断。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                projectDir: { type: "string", description: "工程根目录；缺省为会话工作目录。" },
                outFile: { type: "string", description: "输出文件名（相对 hardware/out）；默认 board.step。" },
            },
            required: [],
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    ok: { type: "boolean" },
                    error: { type: "string" },
                    stepFile: { type: "string" },
                    bytes: { type: "number" },
                    durationMs: { type: "number" },
                    missingModels: { type: "array", items: { type: "string" } },
                },
                required: ["ok", "error", "stepFile", "bytes", "durationMs", "missingModels"],
            },
            render: (_args, value) => {
                const result = value;
                if (!result.ok)
                    return [{ type: "text", text: "STEP 导出失败：" + result.error }];
                const lines = ["STEP：" + result.stepFile + "（" + String(Math.round(result.bytes / 1024)) + " KB）"];
                lines.push(result.missingModels.length > 0
                    ? "缺 3D 模型：" + result.missingModels.join("、")
                    : "3D 模型齐全");
                return [{ type: "text", text: lines.join("\n") }];
            },
        },
        timeoutMs: 330_000,
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const project = await projectDirOf(ctx, args.projectDir, exec);
            if (!project.ok) {
                return { ok: false, error: project.error, stepFile: "", bytes: 0, durationMs: 0, missingModels: [] };
            }
            const located = locateEcadToolchain();
            if (located.toolchain === null) {
                return { ok: false, error: located.error, stepFile: "", bytes: 0, durationMs: 0, missingModels: [] };
            }
            const workspace = workspaceOf(project.dir);
            const { findLatestKicadBuild } = await import("../engine/ecad/tsci.js");
            const latest = findLatestKicadBuild(workspace);
            if (!latest.ok) {
                return { ok: false, error: latest.error, stepFile: "", bytes: 0, durationMs: 0, missingModels: [] };
            }
            const name = (args.outFile ?? "board.step").replace(/[\\/:*?"<>|]/gu, "_");
            const exported = await exportStep(ctx.subprocess, located.toolchain, latest.pcbFile, join(workspace.outDir, name), exec.signal);
            return {
                ok: exported.ok,
                error: exported.error,
                stepFile: exported.stepFile,
                bytes: exported.bytes,
                durationMs: exported.durationMs,
                missingModels: [...exported.missingModels],
            };
        },
    });
}
