/**
 * L3：原理图工具 —— 读 KiCad 10 原理图，产出元件/引脚/网络事实，并做检查与对账。
 *
 * 三个工具的分工：
 *   stm32_sch_read  看全貌：图纸树、元件、网络、模块框图（给人和模型同一份事实）
 *   stm32_sch_pins  看主控：每个引脚的当前网络 + CubeMX 里的复用候选（写 .ioc 前先确认）
 *   stm32_sch_check 看问题：原理图自身规则、与 PCB 的连通性对账、与 .ioc 的引脚对照
 *
 * 只读：不改原理图、不写 `.ioc`。要改配置走 `stm32_ioc_plan` 的事务。
 */
import { locateCubemxDb, readMcuFacts, resolveDbPinName } from "../engine/cubemx-db.js";
import { resolveSearchConfig } from "../data/search-roots.js";
import { checkSchematic } from "../engine/schematic/checks.js";
import { findRootSchematic, readSchematic } from "../engine/schematic/model.js";
import { resolveProjectDir } from "./project-dir.js";
import { resolveProjectLayout } from "../engine/project-layout.js";
export const SCH_READ_TOOL = "stm32_sch_read";
export const SCH_PINS_TOOL = "stm32_sch_pins";
export const SCH_CHECK_TOOL = "stm32_sch_check";
/** 一次最多列出多少个元件/网络；超出部分只给计数，避免报告压垮上下文。 */
const LIST_LIMIT = 200;
/** 每个引脚最多给几个复用候选。 */
const CANDIDATE_LIMIT = 8;
const pinViewSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        number: { type: "string" },
        name: { type: "string" },
        net: { type: "string" },
        type: { type: "string" },
        noConnect: { type: "boolean" },
    },
    required: ["number", "name", "net", "type", "noConnect"],
};
/**
 * 按 rootFile 或工程目录找入口图纸并解析。
 *
 * 传进来的是**工程根**（S95 约定）：KiCad 工程可能在 `hardware/` 下，也可能与程序同级。
 * 具体在哪儿由 `resolveProjectLayout()` 判断，这里只负责「取到目录 → 找入口 → 解析」。
 */
export function loadSchematic(projectDir, rootFile) {
    let root = rootFile;
    if (root === "") {
        const hardwareDir = resolveProjectLayout(projectDir).hardwareDir;
        if (hardwareDir === "") {
            return {
                report: null,
                error: "工程里没有 KiCad 原理图：把 KiCad 工程放到 hardware/ 下，或在 dsh-stm32.conf 里写 hardware=目录名",
            };
        }
        const found = findRootSchematic(hardwareDir);
        if (found === null || found === "") {
            return { report: null, error: `硬件目录里没有 .kicad_sch：${hardwareDir}` };
        }
        root = found;
    }
    try {
        return { report: readSchematic(root).report, error: "" };
    }
    catch (error) {
        return { report: null, error: `原理图解析失败：${error instanceof Error ? error.message : String(error)}` };
    }
}
function sheetsOf(report) {
    return report.sheets.map((sheet) => ({ file: sheet.file, paper: sheet.paper, symbols: sheet.symbols, nets: sheet.nets }));
}
function componentList(report) {
    return report.components.slice(0, LIST_LIMIT).map((component) => ({
        ref: component.ref,
        value: component.value,
        footprint: component.footprint,
        sheet: component.sheet,
        isMcu: report.mcu !== null && report.mcu.ref === component.ref,
        pins: component.pins.map((pin) => ({
            number: pin.number,
            name: pin.name,
            net: pin.net,
            type: pin.type,
            noConnect: pin.noConnect,
        })),
    }));
}
function formatRead(value) {
    if (value.message !== "")
        return [value.message];
    const lines = [
        `原理图：${value.rootFile}`,
        `版本 ${value.version}；图纸 ${value.sheets.length} 张；元件 ${value.components} 个；网络 ${value.nets} 个`,
        `主控：${value.mcu === "" ? "未识别" : value.mcu}`,
        `模块框图：${value.diagram.blocks.length} 个块、${value.diagram.links.length} 条连线`,
    ];
    for (const sheet of value.sheets)
        lines.push(`  · ${sheet.file}（${sheet.symbols} 个符号 / ${sheet.nets} 个网络）`);
    for (const warning of value.warnings)
        lines.push(`  ! ${warning}`);
    return lines;
}
const readOutputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        ok: { type: "boolean" },
        message: { type: "string" },
        rootFile: { type: "string" },
        version: { type: "number" },
        generator: { type: "string" },
        components: { type: "number" },
        nets: { type: "number" },
        mcu: { type: "string" },
        sheets: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                properties: {
                    file: { type: "string" },
                    paper: { type: "string" },
                    symbols: { type: "number" },
                    nets: { type: "number" },
                },
                required: ["file", "paper", "symbols", "nets"],
            },
        },
        componentList: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                properties: {
                    ref: { type: "string" },
                    value: { type: "string" },
                    footprint: { type: "string" },
                    sheet: { type: "string" },
                    isMcu: { type: "boolean" },
                    pins: { type: "array", items: pinViewSchema },
                },
                required: ["ref", "value", "footprint", "sheet", "isMcu", "pins"],
            },
        },
        netList: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                properties: {
                    name: { type: "string" },
                    kind: { type: "string" },
                    labels: { type: "array", items: { type: "string" } },
                    pins: { type: "array", items: { type: "string" } },
                },
                required: ["name", "kind", "labels", "pins"],
            },
        },
        diagram: {
            type: "object",
            additionalProperties: false,
            properties: {
                blocks: {
                    type: "array",
                    items: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            id: { type: "string" },
                            label: { type: "string" },
                            kind: { type: "string" },
                            refs: { type: "array", items: { type: "string" } },
                        },
                        required: ["id", "label", "kind", "refs"],
                    },
                },
                links: {
                    type: "array",
                    items: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            from: { type: "string" },
                            to: { type: "string" },
                            label: { type: "string" },
                            nets: { type: "array", items: { type: "string" } },
                        },
                        required: ["from", "to", "label", "nets"],
                    },
                },
                powerNets: { type: "array", items: { type: "string" } },
            },
            required: ["blocks", "links", "powerNets"],
        },
        warnings: { type: "array", items: { type: "string" } },
        notes: { type: "array", items: { type: "string" } },
    },
    required: ["ok", "message", "rootFile", "version", "generator", "components", "nets", "mcu", "sheets", "componentList", "netList", "diagram", "warnings", "notes"],
};
function emptyRead(message) {
    return {
        ok: false,
        message,
        rootFile: "",
        version: 0,
        generator: "",
        components: 0,
        nets: 0,
        mcu: "",
        sheets: [],
        componentList: [],
        netList: [],
        diagram: { blocks: [], links: [], powerNets: [] },
        warnings: [],
        notes: [],
    };
}
const pinSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        number: { type: "string" },
        name: { type: "string" },
        net: { type: "string" },
        type: { type: "string" },
        noConnect: { type: "boolean" },
        candidates: { type: "array", items: { type: "string" } },
    },
    required: ["number", "name", "net", "type", "noConnect", "candidates"],
};
const pinsOutputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        ok: { type: "boolean" },
        message: { type: "string" },
        mcu: { type: "string" },
        dbVersion: { type: "string" },
        pins: { type: "array", items: pinSchema },
        notes: { type: "array", items: { type: "string" } },
    },
    required: ["ok", "message", "mcu", "dbVersion", "pins", "notes"],
};
/**
 * 复用候选：CubeMX db 里这个引脚的信号名，按与网络名的吻合度排序。
 *
 * 吻合度只看词元（SCL/SDA/TX/RX…）：网络名常写成 `PA4/SCL`，库里写 `I2C1_SCL`，
 * 两边共同出现的词元越多越可能是同一个用途。
 */
export function rankSignals(signals, netName) {
    const tokens = netName.toUpperCase().split(/[^A-Z0-9]+/u).filter((token) => token.length > 1);
    const scored = signals.map((signal) => {
        const upper = signal.toUpperCase();
        let score = tokens.filter((token) => upper.includes(token)).length;
        if (upper.includes("GPIO"))
            score -= 1;
        return { signal, score };
    });
    scored.sort((a, b) => (b.score === a.score ? a.signal.localeCompare(b.signal) : b.score - a.score));
    return scored.map((item) => item.signal).slice(0, CANDIDATE_LIMIT);
}
const checkFindingSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        rule: { type: "string" },
        severity: { type: "string", enum: ["error", "warning", "info"] },
        message: { type: "string" },
        evidence: { type: "string" },
    },
    required: ["rule", "severity", "message", "evidence"],
};
const checkOutputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        ok: { type: "boolean" },
        message: { type: "string" },
        findings: { type: "array", items: checkFindingSchema },
        errors: { type: "number" },
        warnings: { type: "number" },
        infos: { type: "number" },
        pcbSummary: { type: "string" },
        pcbCompared: { type: "number" },
        pcbMatched: { type: "number" },
        iocConfigured: { type: "number" },
        notes: { type: "array", items: { type: "string" } },
    },
    required: ["ok", "message", "findings", "errors", "warnings", "infos", "pcbSummary", "pcbCompared", "pcbMatched", "iocConfigured", "notes"],
};
export function registerSchematicTools(ctx) {
    ctx.tools.register({
        name: SCH_READ_TOOL,
        description: "读 KiCad 10 原理图（.kicad_sch，文件版本 20260306）：图纸树、元件与引脚网络、网络表、模块框图（按功能模块聚合：主控、NFC 天线与标签、光检测、供电、调试接口、按键，模块之间按总线类型连线，不逐元件罗列）。只读，不写盘；接 PCB 对账与 .ioc 对照用 stm32_sch_check。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                projectDir: { type: "string", description: "工程根目录；缺省为会话工作目录。" },
                rootFile: { type: "string", description: "入口 .kicad_sch 路径；缺省按 .kicad_pro 同名文件推断。" },
                includeComponents: { type: "boolean", description: "是否列出元件明细（含每个引脚的当前网络）；默认 false，只给主控。" },
                includeNets: { type: "boolean", description: "是否列出网络明细；默认 false，只给数量。" },
            },
        },
        output: { schema: readOutputSchema, render: (_args, value) => [{ type: "text", text: formatRead(value).join("\n") }] },
        timeoutMs: 60_000,
        isConcurrencySafe: () => true,
        async execute(rawArgs, exec) {
            const args = rawArgs ?? {};
            const resolution = await resolveProjectDir(ctx, args.projectDir, exec);
            const loaded = loadSchematic(resolution.projectDir, typeof args.rootFile === "string" ? args.rootFile : "");
            if (loaded.report === null)
                return emptyRead(loaded.error);
            const report = loaded.report;
            const notes = [];
            if (resolution.note !== null)
                notes.push(resolution.note);
            const mcu = report.mcu === null ? "" : `${report.mcu.ref} ${report.mcu.value}`;
            const components = args.includeComponents === true ? componentList(report) : report.components
                .filter((component) => report.mcu !== null && component.ref === report.mcu.ref)
                .map((component) => ({
                ref: component.ref,
                value: component.value,
                footprint: component.footprint,
                sheet: component.sheet,
                isMcu: true,
                pins: component.pins.map((pin) => ({ number: pin.number, name: pin.name, net: pin.net, type: pin.type, noConnect: pin.noConnect })),
            }));
            const netList = args.includeNets === true
                ? report.nets.slice(0, LIST_LIMIT).map((net) => ({
                    name: net.name,
                    kind: net.kind,
                    labels: [...net.labels],
                    pins: net.pins.map((pin) => `${pin.ref}.${pin.number}`),
                }))
                : [];
            return {
                ok: true,
                message: "",
                rootFile: report.rootFile,
                version: report.version,
                generator: report.generator,
                components: report.components.length,
                nets: report.nets.length,
                mcu,
                sheets: sheetsOf(report),
                componentList: components,
                netList,
                diagram: {
                    blocks: report.diagram.blocks.map((block) => ({ id: block.id, label: block.label, kind: block.kind, refs: [...block.refs] })),
                    links: report.diagram.links.map((link) => ({ from: link.from, to: link.to, label: link.label, nets: [...link.nets] })),
                    powerNets: [...report.diagram.powerNets],
                },
                warnings: [...report.warnings],
                notes,
            };
        },
    });
    ctx.tools.register({
        name: SCH_PINS_TOOL,
        description: "列出主控每个引脚的当前网络，并从 CubeMX 器件库里给出复用候选（按与网络名的吻合度排序）。写 .ioc 前用它确认引脚用途；只读。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                projectDir: { type: "string", description: "工程根目录；缺省为会话工作目录。" },
                rootFile: { type: "string", description: "入口 .kicad_sch 路径；缺省按 .kicad_pro 同名文件推断。" },
                cubeMxRoots: { type: "array", items: { type: "string" }, description: "CubeMX 安装根目录候选。" },
            },
        },
        output: { schema: pinsOutputSchema, render: (_args, value) => [{ type: "text", text: formatPins(value).join("\n") }] },
        timeoutMs: 60_000,
        isConcurrencySafe: () => true,
        async execute(rawArgs, exec) {
            const args = rawArgs ?? {};
            const resolution = await resolveProjectDir(ctx, args.projectDir, exec);
            const loaded = loadSchematic(resolution.projectDir, typeof args.rootFile === "string" ? args.rootFile : "");
            if (loaded.report === null || loaded.report.mcu === null) {
                return { ok: false, message: loaded.error !== "" ? loaded.error : "原理图里没有识别到 STM32 主控", mcu: "", dbVersion: "", pins: [], notes: [] };
            }
            const mcu = loaded.report.mcu;
            const notes = [];
            if (resolution.note !== null)
                notes.push(resolution.note);
            const config = resolveSearchConfig(process.env, args.cubeMxRoots === undefined ? {} : { cubeMxRoots: args.cubeMxRoots });
            const db = locateCubemxDb(config.cubeMxRoots);
            if (db === null) {
                notes.push("没有找到 CubeMX 器件库：复用候选为空，其余字段照常。");
                return {
                    ok: true,
                    message: "",
                    mcu: `${mcu.ref} ${mcu.value}`,
                    dbVersion: "",
                    pins: mcu.pins.map((pin) => ({ number: pin.number, name: pin.name, net: pin.net, type: pin.type, noConnect: pin.noConnect, candidates: [] })),
                    notes,
                };
            }
            const facts = readMcuFacts(db, mcu.value);
            if (facts === null) {
                notes.push(`CubeMX 器件库里没有 ${mcu.value}：复用候选为空。`);
            }
            return {
                ok: true,
                message: "",
                mcu: `${mcu.ref} ${mcu.value}`,
                dbVersion: db.version,
                pins: mcu.pins.map((pin) => {
                    const dbName = facts === null ? null : resolveDbPinName(facts, pin.name);
                    const fact = dbName === null || facts === null ? undefined : facts.pins.get(dbName);
                    const signals = fact === undefined ? [] : [...fact.signals.keys()];
                    return {
                        number: pin.number,
                        name: pin.name,
                        net: pin.net,
                        type: pin.type,
                        noConnect: pin.noConnect,
                        candidates: rankSignals(signals, pin.net === "" ? pin.name : `${pin.name} ${pin.net}`),
                    };
                }),
                notes,
            };
        },
    });
    ctx.tools.register({
        name: SCH_CHECK_TOOL,
        description: "检查 KiCad 原理图：调试口/电源/BOOT0 是否接好、元件缺值、网络冲突；可同时对 PCB 做连通性对账、对 .ioc 做引脚对照。只读。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                projectDir: { type: "string", description: "工程根目录；缺省为会话工作目录。" },
                rootFile: { type: "string", description: "入口 .kicad_sch 路径；缺省按 .kicad_pro 同名文件推断。" },
                pcbFile: { type: "string", description: "同工程的 .kicad_pcb 路径；缺省不对比。" },
                iocFile: { type: "string", description: "同工程的 .ioc 路径；缺省不对比。" },
                severity: { type: "string", enum: ["all", "warning", "error"], description: "只返回不低于该级别的发现；默认 all。" },
            },
        },
        output: { schema: checkOutputSchema, render: (_args, value) => [{ type: "text", text: formatCheck(value).join("\n") }] },
        timeoutMs: 60_000,
        isConcurrencySafe: () => true,
        async execute(rawArgs, exec) {
            const args = rawArgs ?? {};
            const resolution = await resolveProjectDir(ctx, args.projectDir, exec);
            const loaded = loadSchematic(resolution.projectDir, typeof args.rootFile === "string" ? args.rootFile : "");
            if (loaded.report === null) {
                return {
                    ok: false,
                    message: loaded.error,
                    findings: [],
                    errors: 0,
                    warnings: 0,
                    infos: 0,
                    pcbSummary: "",
                    pcbCompared: 0,
                    pcbMatched: 0,
                    iocConfigured: 0,
                    notes: [],
                };
            }
            const notes = [];
            if (resolution.note !== null)
                notes.push(resolution.note);
            const check = checkSchematic(loaded.report, {
                ...(typeof args.pcbFile === "string" && args.pcbFile !== "" ? { pcbFile: args.pcbFile } : {}),
                ...(typeof args.iocFile === "string" && args.iocFile !== "" ? { iocFile: args.iocFile } : {}),
            });
            const floor = args.severity === "error" ? 0 : args.severity === "warning" ? 1 : 2;
            const rank = { error: 0, warning: 1, info: 2 };
            const findings = check.findings
                .filter((finding) => rank[finding.severity] <= floor)
                .map((finding) => ({ rule: finding.rule, severity: finding.severity, message: finding.message, evidence: finding.evidence }));
            return {
                ok: true,
                message: "",
                findings,
                errors: check.summary.errors,
                warnings: check.summary.warnings,
                infos: check.summary.infos,
                pcbSummary: check.pcb === null ? "" : check.pcb.summary,
                pcbCompared: check.pcb === null ? 0 : check.pcb.compared,
                pcbMatched: check.pcb === null ? 0 : check.pcb.matched,
                iocConfigured: check.ioc === null ? 0 : check.ioc.configured,
                notes,
            };
        },
    });
}
function formatPins(value) {
    if (!value.ok)
        return [value.message];
    const lines = [`主控：${value.mcu}${value.dbVersion === "" ? "" : `（CubeMX 器件库 ${value.dbVersion}）`}`];
    for (const pin of value.pins) {
        const candidates = pin.candidates.length === 0 ? "" : `  候选：${pin.candidates.join(" / ")}`;
        lines.push(`  ${pin.number.padStart(2)}. ${pin.name}${pin.net === "" ? "（未接）" : ` → ${pin.net}`}${candidates}`);
    }
    for (const note of value.notes)
        lines.push(`  ! ${note}`);
    return lines;
}
function formatCheck(value) {
    if (!value.ok)
        return [value.message];
    const lines = [`发现 ${value.errors} 个错误 / ${value.warnings} 个告警 / ${value.infos} 条信息`];
    if (value.pcbSummary !== "")
        lines.push(`PCB 对账：${value.pcbSummary}`);
    for (const finding of value.findings)
        lines.push(`  [${finding.severity}] ${finding.rule}：${finding.message}（${finding.evidence}）`);
    for (const note of value.notes)
        lines.push(`  ! ${note}`);
    return lines;
}
