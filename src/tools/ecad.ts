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

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { exportStep, findUnnamedNets, runDrc, runErc, type KicadReport } from "../engine/ecad/checks.js";
import { exportEmbeddedLibraries } from "../engine/ecad/libs.js";
import { exportFabrication } from "../engine/ecad/fabrication.js";
import { locateEcadToolchain } from "../engine/ecad/toolchain.js";
import {
  dirSizeBytes,
  initEcadWorkspace,
  listCircuitEntries,
  planEcadWorkspace,
  runTsciBuild,
} from "../engine/ecad/tsci.js";
import { resolveProjectDir } from "./project-dir.js";
import { resolveProjectLayout } from "../engine/project-layout.js";
import type { DshContext, JsonSchema, ToolExec } from "../types.js";

export const ECAD_INIT_TOOL = "stm32_ecad_init";
export const ECAD_BUILD_TOOL = "stm32_ecad_build";
export const ECAD_CHECK_TOOL = "stm32_ecad_check";
export const ECAD_STEP_TOOL = "stm32_ecad_step";
export const ECAD_LIBS_TOOL = "stm32_ecad_libs";
export const ECAD_EXPORT_TOOL = "stm32_ecad_export";

export const ECAD_PACKAGE_TOOL = "stm32_ecad_package";

const fileSizeSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    bytes: { type: "number" },
  },
  required: ["name", "bytes"],
};

const findingSchema: JsonSchema = {
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

const checkSummarySchema: JsonSchema = {
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
function workspaceOf(projectDir: string) {
  const layout = resolveProjectLayout(projectDir);
  // 空串交给 planEcadWorkspace 处理：它会落到 <工程>/hardware，而不是把工程根当硬件目录。
  return planEcadWorkspace(projectDir, layout.hardwareDir);
}

async function projectDirOf(
  ctx: DshContext,
  raw: unknown,
  exec: ToolExec,
): Promise<{ ok: boolean; dir: string; error: string }> {
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

function formatReport(name: string, report: KicadReport): string[] {
  const lines = [name + "：" + String(report.summary.errors) + " error / " + String(report.summary.warnings) + " warning"];
  for (const finding of report.summary.findings.slice(0, 12)) {
    const items = finding.items.length > 0 ? "（" + finding.items.join("；") + "）" : "";
    lines.push("  [" + finding.severity + "] " + finding.rule + " " + finding.message + items);
  }
  if (report.summary.findings.length > 12) lines.push("  …还有 " + String(report.summary.findings.length - 12) + " 条");
  if (report.reportPath !== "") lines.push("  报告：" + report.reportPath);
  if (!report.ok && report.error !== "") lines.push("  命令输出：" + report.error.split(/\r?\n/u)[0]);
  return lines;
}

export function registerEcadTools(ctx: DshContext): void {
  ctx.tools.register({
    name: ECAD_INIT_TOOL,
    description:
      "初始化硬件工作区：在 hardware/ 下建 circuit/（tscircuit 工程）、kicad/、libs/、out/ 并写 package.json。不装依赖，装依赖按提示执行 npm install。",
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
        const result = value as {
          ok: boolean;
          error: string;
          root: string;
          circuitDir: string;
          created: string[];
          entries: string[];
          nodeModulesReady: boolean;
          notes: string[];
        };
        if (!result.ok) return [{ type: "text", text: "初始化失败：" + result.error }];
        const lines = ["工作区：" + result.root, "tscircuit 工程：" + result.circuitDir];
        lines.push(result.nodeModulesReady ? "依赖：已安装" : "依赖：未安装，先在该目录执行 npm install（约 730 MB）");
        if (result.created.length > 0) lines.push("新建：" + result.created.join("、"));
        lines.push(result.entries.length > 0 ? "入口：" + result.entries.join("、") : "入口：还没有 *.circuit.tsx");
        for (const note of result.notes) lines.push("- " + note);
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    execute: async (args: { projectDir?: string }, exec: ToolExec) => {
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
      const notes: string[] = [...toolchain.toolchain?.notes ?? []];
      if (toolchain.toolchain === null) notes.push(toolchain.error);
      if (installed) notes.push("node_modules 占用 " + String(Math.round(dirSizeBytes(join(workspace.circuitDir, "node_modules")) / 1048576)) + " MB");
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
    description:
      "构建电路：用 KiCad 自带的 bun 跑 tscircuit build，把 hardware/circuit 下的 .circuit.tsx 生成 circuit.json、原理图/PCB 的 SVG 与真 KiCad 工程（hardware/kicad）。不装依赖。",
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
        const result = value as {
          ok: boolean;
          error: string;
          durationMs: number;
          kicadDir: string;
          circuitJson: string;
          pcbSvg: string;
          schematicSvg: string;
          exitCode: number;
          notes: string[];
          stderrTail: string;
        };
        const lines = [
          result.ok
            ? "构建完成（" + String(Math.round(result.durationMs / 100) / 10) + " s）"
            : "构建失败（exit " + String(result.exitCode) + "）",
        ];
        if (result.kicadDir !== "") lines.push("KiCad 工程：" + result.kicadDir);
        if (result.circuitJson !== "") lines.push("circuit.json：" + result.circuitJson);
        if (result.pcbSvg !== "") lines.push("PCB 预览：" + result.pcbSvg);
        if (result.schematicSvg !== "") lines.push("原理图预览：" + result.schematicSvg);
        if (!result.ok && result.error !== "") lines.push("原因：" + result.error.split(/\r?\n/u).slice(0, 6).join("\n"));
        for (const note of result.notes) lines.push("- " + note);
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    timeoutMs: 330_000,
    isConcurrencySafe: () => false,
    execute: async (args: { projectDir?: string; entry?: string; svgs?: boolean }, exec: ToolExec) => {
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
    description:
      "检查电路：对生成的 KiCad 工程跑 kicad-cli ERC 与 DRC（含未连接项与原理图/PCB 一致性），把违规项收敛成清单。只读。",
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
          libsFootprints: { type: "number" },
          libsSymbols: { type: "number" },
          unnamedNets: { type: "array", items: { type: "string" } },
        },
        required: ["ok", "error", "kicadDir", "schematicFile", "pcbFile", "erc", "drc", "libsFootprints", "libsSymbols", "unnamedNets"],
      },
      render: (_args, value) => {
        const result = value as {
          ok: boolean;
          error: string;
          kicadDir: string;
          schematicFile: string;
          pcbFile: string;
          erc: { errors: number; warnings: number; findings: unknown[] };
          drc: { errors: number; warnings: number; findings: unknown[] };
          libsFootprints: number;
          libsSymbols: number;
          unnamedNets: string[];
        };
        if (!result.ok) return [{ type: "text", text: "检查未执行：" + result.error }];
        const erc = result.erc as unknown as KicadReport["summary"];
        const drc = result.drc as unknown as KicadReport["summary"];
        const lines = [
          ...formatReport("ERC", { ok: true, error: "", file: result.schematicFile, reportPath: "", summary: erc, raw: "" }),
          ...formatReport("DRC", { ok: true, error: "", file: result.pcbFile, reportPath: "", summary: drc, raw: "" }),
          "库：导出 " + String(result.libsFootprints) + " 个封装库 / " + String(result.libsSymbols) + " 个符号库（fp-lib-table / sym-lib-table 已补齐）",
        ];
        if (result.unnamedNets.length > 0) {
          lines.push("未命名网络 " + String(result.unnamedNets.length) + " 条：" + result.unnamedNets.slice(0, 3).join("；"));
          lines.push("  修法：在 tscircuit 里写 <net name=\"VDD\" />，trace 上加 net=\"VDD\"");
        }
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    timeoutMs: 240_000,
    isConcurrencySafe: () => true,
    execute: async (args: { projectDir?: string; severity?: string }, exec: ToolExec) => {
      const empty = { errors: 0, warnings: 0, findings: [] as unknown[] };
      const blank = {
        ok: false,
        error: "",
        kicadDir: "",
        schematicFile: "",
        pcbFile: "",
        erc: empty,
        drc: empty,
        libsFootprints: 0,
        libsSymbols: 0,
        unnamedNets: [] as string[],
      };
      const project = await projectDirOf(ctx, args.projectDir, exec);
      if (!project.ok) return { ...blank, error: project.error };
      const located = locateEcadToolchain();
      if (located.toolchain === null) return { ...blank, error: located.error };
      const workspace = workspaceOf(project.dir);
      const { findLatestKicadBuild } = await import("../engine/ecad/tsci.js");
      const latest = findLatestKicadBuild(workspace);
      if (!latest.ok) return { ...blank, error: latest.error };
      const sch = latest.schematicFile;
      const pcb = latest.pcbFile;
      // 先补齐库表：否则 DRC 会报「封装库 'tscircuit' 不在配置中」，那是在查环境而不是查电路。
      const libs = exportEmbeddedLibraries(workspace, pcb, sch);
      const unnamedNets = findUnnamedNets(readFileSync(pcb, "utf8"));
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
        libsFootprints: libs.footprintLibs.length,
        libsSymbols: libs.symbolLibs.length,
        unnamedNets,
      };
    },
  });

  ctx.tools.register({
    name: ECAD_LIBS_TOOL,
    description:
      "导出内嵌库：把生成的 KiCad 板与原理图里内嵌的封装/符号抽成 hardware/libs 下的真库，并补齐 fp-lib-table 与 sym-lib-table。不改 .kicad_pcb / .kicad_sch。",
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
          footprints: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { lib: { type: "string" }, count: { type: "number" } },
              required: ["lib", "count"],
            },
          },
          symbols: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { lib: { type: "string" }, count: { type: "number" } },
              required: ["lib", "count"],
            },
          },
          fpLibTable: { type: "string" },
          symLibTable: { type: "string" },
          notes: { type: "array", items: { type: "string" } },
        },
        required: ["ok", "error", "footprints", "symbols", "fpLibTable", "symLibTable", "notes"],
      },
      render: (_args, value) => {
        const result = value as {
          ok: boolean;
          error: string;
          footprints: { lib: string; count: number }[];
          symbols: { lib: string; count: number }[];
          fpLibTable: string;
          symLibTable: string;
          notes: string[];
        };
        if (!result.ok) return [{ type: "text", text: "库导出失败：" + result.error }];
        const lines: string[] = [];
        lines.push(
          "封装库：" +
            (result.footprints.length === 0
              ? "无内嵌封装"
              : result.footprints.map((item) => item.lib + "（" + String(item.count) + "）").join("、")),
        );
        lines.push(
          "符号库：" +
            (result.symbols.length === 0
              ? "无内嵌符号"
              : result.symbols.map((item) => item.lib + "（" + String(item.count) + "）").join("、")),
        );
        for (const note of result.notes) lines.push("- " + note);
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    execute: async (args: { projectDir?: string }, exec: ToolExec) => {
      const blank = { ok: false, error: "", footprints: [], symbols: [], fpLibTable: "", symLibTable: "", notes: [] as string[] };
      const project = await projectDirOf(ctx, args.projectDir, exec);
      if (!project.ok) return { ...blank, error: project.error };
      const workspace = workspaceOf(project.dir);
      const { findLatestKicadBuild } = await import("../engine/ecad/tsci.js");
      const latest = findLatestKicadBuild(workspace);
      if (!latest.ok) return { ...blank, error: latest.error };
      const exported = exportEmbeddedLibraries(workspace, latest.pcbFile, latest.schematicFile);
      return {
        ok: exported.ok,
        error: exported.error,
        footprints: exported.footprintLibs.map((item) => ({ lib: item.lib, count: item.count })),
        symbols: exported.symbolLibs.map((item) => ({ lib: item.lib, count: item.count })),
        fpLibTable: exported.fpLibTable,
        symLibTable: exported.symLibTable,
        notes: [...exported.notes],
      };
    },
  });

  ctx.tools.register({
    name: ECAD_EXPORT_TOOL,
    description:
      "导出制造文件：Gerber、钻孔、贴片坐标与 STEP 一起写到 hardware/out。缺 3D 模型或钻孔失败只记提示，不阻断其它产物。",
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
          outDir: { type: "string" },
          gerberDir: { type: "string" },
          gerbers: { type: "array", items: fileSizeSchema },
          stepFile: { type: "string" },
          stepBytes: { type: "number" },
          posFile: { type: "string" },
          drillFiles: { type: "array", items: fileSizeSchema },
          notes: { type: "array", items: { type: "string" } },
        },
        required: ["ok", "error", "outDir", "gerberDir", "gerbers", "stepFile", "stepBytes", "posFile", "drillFiles", "notes"],
      },
      render: (_args, value) => {
        const result = value as {
          ok: boolean;
          error: string;
          outDir: string;
          gerberDir: string;
          gerbers: { name: string; bytes: number }[];
          stepFile: string;
          stepBytes: number;
          posFile: string;
          drillFiles: { name: string; bytes: number }[];
          notes: string[];
        };
        if (!result.ok) return [{ type: "text", text: "导出失败：" + result.error }];
        const lines = [
          "Gerber：" + String(result.gerbers.length) + " 个文件 → " + result.gerberDir,
          "钻孔：" + String(result.drillFiles.length) + " 个文件",
          result.stepFile === "" ? "STEP：未导出" : "STEP：" + result.stepFile + "（" + String(Math.round(result.stepBytes / 1024)) + " KB）",
          result.posFile === "" ? "贴片坐标：未导出" : "贴片坐标：" + result.posFile,
        ];
        for (const note of result.notes) lines.push("- " + note);
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    timeoutMs: 330_000,
    isConcurrencySafe: () => false,
    execute: async (args: { projectDir?: string }, exec: ToolExec) => {
      const blank = {
        ok: false,
        error: "",
        outDir: "",
        gerberDir: "",
        gerbers: [] as { name: string; bytes: number }[],
        stepFile: "",
        stepBytes: 0,
        posFile: "",
        drillFiles: [] as { name: string; bytes: number }[],
        notes: [] as string[],
      };
      const project = await projectDirOf(ctx, args.projectDir, exec);
      if (!project.ok) return { ...blank, error: project.error };
      const located = locateEcadToolchain();
      if (located.toolchain === null) return { ...blank, error: located.error };
      const workspace = workspaceOf(project.dir);
      const { findLatestKicadBuild } = await import("../engine/ecad/tsci.js");
      const latest = findLatestKicadBuild(workspace);
      if (!latest.ok) return { ...blank, error: latest.error };
      const exported = await exportFabrication(ctx.subprocess, located.toolchain, latest.pcbFile, workspace.outDir, exec.signal);
      return {
        ok: exported.ok,
        error: exported.error,
        outDir: exported.outDir,
        gerberDir: exported.gerberDir,
        gerbers: exported.gerbers.map((item) => ({ name: item.name, bytes: item.bytes })),
        stepFile: exported.stepFile,
        stepBytes: exported.stepBytes,
        posFile: exported.posFile,
        drillFiles: exported.drillFiles.map((item) => ({ name: item.name, bytes: item.bytes })),
        notes: [...exported.notes],
      };
    },
  });

  ctx.tools.register({
    name: ECAD_PACKAGE_TOOL,
    description:
      "打包硬件交付物：把 hardware/ 下的电路源码、生成的 KiCad 工程、抽出的库与 out/ 制造文件打成一个 zip 写到 hardware/out，跳过 node_modules 与 dist，写完读回自检。",
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
          file: { type: "string" },
          bytes: { type: "number" },
          files: { type: "number" },
          skipped: { type: "array", items: { type: "string" } },
          notes: { type: "array", items: { type: "string" } },
        },
        required: ["ok", "error", "file", "bytes", "files", "skipped", "notes"],
      },
      render: (_args, value) => {
        const result = value as { ok: boolean; error: string; file: string; bytes: number; files: number; notes: string[] };
        if (!result.ok) return [{ type: "text", text: "打包失败：" + result.error }];
        const lines = [
          "交付包：" + result.file,
          "大小：" + String(Math.round(result.bytes / 1024)) + " KB，文件 " + String(result.files) + " 个",
        ];
        for (const note of result.notes) lines.push("- " + note);
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    execute: async (args: { projectDir?: string }, exec: ToolExec) => {
      void exec;
      const project = await projectDirOf(ctx, args.projectDir, exec);
      if (!project.ok) return { ok: false, error: project.error, file: "", bytes: 0, files: 0, skipped: [], notes: [] };
      const workspace = workspaceOf(project.dir);
      const { packageHardware, verifyPackage } = await import("../engine/ecad/package.js");
      const projectName = basename(dirname(workspace.root));
      const packed = packageHardware(workspace.root, projectName);
      if (!packed.ok) {
        return { ok: false, error: packed.error, file: "", bytes: 0, files: 0, skipped: packed.skipped, notes: [] };
      }
      const check = verifyPackage(packed.file);
      return {
        ok: check.ok,
        error: check.ok ? "" : check.error,
        file: packed.file,
        bytes: packed.bytes,
        files: packed.files,
        skipped: packed.skipped,
        notes: check.ok ? packed.notes : [...packed.notes, "读回自检失败，交付包可能损坏"],
      };
    },
  });

  ctx.tools.register({
    name: ECAD_STEP_TOOL,
    description:
      "导出 STEP：对生成的 KiCad 板跑 kicad-cli pcb export step，写到 hardware/out。3D 模型缺失只报告不阻断。",
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
        const result = value as {
          ok: boolean;
          error: string;
          stepFile: string;
          bytes: number;
          missingModels: string[];
        };
        if (!result.ok) return [{ type: "text", text: "STEP 导出失败：" + result.error }];
        const lines = ["STEP：" + result.stepFile + "（" + String(Math.round(result.bytes / 1024)) + " KB）"];
        lines.push(
          result.missingModels.length > 0
            ? "缺 3D 模型：" + result.missingModels.join("、")
            : "3D 模型齐全",
        );
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    timeoutMs: 330_000,
    isConcurrencySafe: () => false,
    execute: async (args: { projectDir?: string; outFile?: string }, exec: ToolExec) => {
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
      const exported = await exportStep(
        ctx.subprocess,
        located.toolchain,
        latest.pcbFile,
        join(workspace.outDir, name),
        exec.signal,
      );
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
