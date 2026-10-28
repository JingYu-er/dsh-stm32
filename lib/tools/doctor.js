/**
 * L3：stm32_doctor —— 一次性体检：工具链、残留调试进程、gdb 端口、构建产物、.ioc 告警。
 *
 * 只读工具（除了跑一下 tasklist/版本命令）。回答的是"为什么现在烧不了/调不了"，
 * 特别是"探针被谁占着"这个在 VS Code 调试与命令行工具之间最容易互相踩的问题。
 */
import { runDoctor } from "../engine/doctor.js";
import { resolveProjectDir } from "./project-dir.js";
export const DOCTOR_TOOL = "stm32_doctor";
const toolSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        id: { type: "string" },
        label: { type: "string" },
        found: { type: "boolean" },
        path: { type: "string" },
        version: { type: "string" },
        required: { type: "boolean" },
        hint: { type: "string" },
        impact: { type: "string" },
        install: { type: "array", items: { type: "string" } },
        verify: { type: "string" },
        error: { type: "string" },
    },
    required: [
        "id",
        "label",
        "found",
        "path",
        "version",
        "required",
        "hint",
        "impact",
        "install",
        "verify",
        "error",
    ],
};
const processSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        name: { type: "string" },
        pid: { type: "number" },
    },
    required: ["name", "pid"],
};
export const outputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        message: { type: "string" },
        report: {
            type: "object",
            additionalProperties: false,
            properties: {
                ok: { type: "boolean" },
                projectDir: { type: "string" },
                message: { type: "string" },
                durationMs: { type: "number" },
                missingRequired: { type: "array", items: { type: "string" } },
                tools: { type: "array", items: toolSchema },
                processes: { type: "array", items: processSchema },
                usb: {
                    type: "object",
                    properties: {
                        kind: { type: "string", enum: ["no-usb", "no-dap", "driver-error", "ok", "unknown"] },
                        detail: { type: "string" },
                    },
                    required: ["kind", "detail"],
                },
                port: { type: "number" },
                portBusy: { type: "boolean" },
                buildDir: { type: "string" },
                elfPath: { type: "string" },
                elfSize: { type: "number" },
                iocPath: { type: "string" },
                iocWarnings: { type: "array", items: { type: "string" } },
                blockers: { type: "array", items: { type: "string" } },
                notes: { type: "array", items: { type: "string" } },
            },
            required: [
                "ok", "projectDir", "message", "durationMs", "missingRequired", "tools", "processes",
                "port", "portBusy", "buildDir", "elfPath", "elfSize", "iocPath", "iocWarnings", "usb", "blockers", "notes",
            ],
        },
    },
    required: ["message", "report"],
};
function formatReport(report) {
    const lines = [];
    lines.push((report.ok ? "环境就绪" : "有阻塞项") + "：" + report.message);
    lines.push("工程：" + report.projectDir);
    for (const tool of report.tools) {
        lines.push((tool.found ? "  OK   " : "  MISS ") + tool.id + (tool.version === "" ? "" : "  " + tool.version) +
            (tool.found ? "" : "  → " + tool.hint));
    }
    if (report.processes.length > 0) {
        lines.push("可疑进程：" + report.processes.map((process) => process.name + "(" + String(process.pid) + ")").join(" "));
    }
    lines.push("gdb 端口：" + String(report.port) + (report.portBusy ? "（被占用）" : "（空闲）"));
    lines.push("USB：" + report.usb.kind + " — " + report.usb.detail);
    if (report.buildDir !== "")
        lines.push("构建目录：" + report.buildDir);
    if (report.elfPath !== "")
        lines.push("固件：" + report.elfPath + "（" + String(report.elfSize) + " B）");
    if (report.iocPath !== "")
        lines.push(".ioc：" + report.iocPath);
    if (report.blockers.length > 0) {
        lines.push("");
        lines.push("阻塞项：");
        for (const blocker of report.blockers)
            lines.push("  ! " + blocker);
    }
    for (const note of report.notes)
        lines.push("· " + note);
    return lines;
}
export function registerDoctor(ctx) {
    ctx.tools.register({
        name: DOCTOR_TOOL,
        description: "STM32 环境体检（只读）：工具链版本是否齐全、有没有残留的 openocd/gdb 占着 CMSIS-DAP 探针、gdb 端口是否被占、构建目录与 .elf 是否就位、.ioc 有没有致命告警（例如没启用 Serial Wire）。烧录/调试失败时先跑它。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                projectDir: { type: "string", description: "工程根目录；缺省为当前工作目录。" },
                binDirs: { type: "array", items: { type: "string" }, description: "工具链目录候选，优先于默认值/环境变量。" },
                cubeMxRoots: { type: "array", items: { type: "string" }, description: "STM32CubeMX 安装根目录候选。" },
                port: { type: "number", description: "gdb 端口，默认 3333。" },
                timeoutMs: { type: "number", description: "单项版本命令超时，默认 15000。" },
            },
            required: [],
        },
        timeoutMs: 2 * 60_000,
        isConcurrencySafe: () => true,
        output: {
            schema: outputSchema,
            render: (_args, value) => {
                const typed = value;
                return [{ type: "text", text: formatReport(typed.report).join("\n") }];
            },
        },
        async execute(rawArgs, exec) {
            const args = rawArgs ?? {};
            const subprocess = ctx.get("subprocess");
            if (subprocess === undefined) {
                return {
                    message: "宿主缺少 subprocess 服务，无法体检",
                    report: {
                        ok: false, projectDir: args.projectDir ?? "", message: "宿主缺少 subprocess 服务", durationMs: 0,
                        missingRequired: ["subprocess"], tools: [], processes: [], usb: { kind: "unknown", detail: "宿主没有 subprocess 服务，无法诊断 USB/探针形态。" }, port: args.port ?? 3333, portBusy: false,
                        buildDir: "", elfPath: "", elfSize: 0, iocPath: "", iocWarnings: [], blockers: ["宿主缺少 subprocess 服务"], notes: [],
                    },
                };
            }
            const resolution = await resolveProjectDir(ctx, args.projectDir, exec);
            const report = await runDoctor(subprocess, {
                projectDir: resolution.projectDir,
                ...(args.binDirs === undefined ? {} : { binDirs: args.binDirs }),
                ...(args.cubeMxRoots === undefined ? {} : { cubeMxRoots: args.cubeMxRoots }),
                ...(args.port === undefined ? {} : { port: args.port }),
                ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
                signal: exec.signal,
            });
            if (resolution.note !== null)
                report.notes.push(resolution.note);
            return { message: report.message, report };
        },
    });
}
