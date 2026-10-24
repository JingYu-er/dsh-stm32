/**
 * L3：stm32_flash —— 只烧录，不进调试会话。
 *
 * 这是用户最初的痛点：VS Code 里 F5 与 Ctrl+F5 都会拉起调试适配器，
 * 而 openocd 的 `program ... verify reset exit` 本身就是"烧完就跑"。
 * 这个工具阻塞执行（通常 3–10 s），跑完立刻释放探针。
 */
import { runFlash } from "../engine/flash.js";
import { releaseProbeFor } from "../engine/debug-session.js";
import { resolveProjectDir } from "./project-dir.js";
export const FLASH_TOOL = "stm32_flash";
const reportSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        ok: { type: "boolean" },
        projectDir: { type: "string" },
        elfPath: { type: "string" },
        elfSize: { type: "number" },
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        configs: { type: "array", items: { type: "string" } },
        durationMs: { type: "number" },
        exitCode: { type: "number" },
        programmed: { type: "boolean" },
        verified: { type: "boolean" },
        errors: { type: "array", items: { type: "string" } },
        message: { type: "string" },
        logTail: { type: "string" },
        notes: { type: "array", items: { type: "string" } },
        guard: { type: "string" },
    },
    required: ["ok", "projectDir", "elfPath", "elfSize", "command", "args", "durationMs", "programmed", "verified", "errors", "message", "logTail", "notes"],
};
export const outputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        message: { type: "string" },
        report: reportSchema,
    },
    required: ["message", "report"],
};
export function formatFlashReport(report) {
    const lines = [];
    lines.push((report.ok ? "烧录成功" : "烧录失败") + "：" + report.message);
    if (report.elfPath !== "")
        lines.push("固件：" + report.elfPath + "（" + String(report.elfSize) + " B）");
    if (report.configs.length > 0)
        lines.push("配置：" + report.configs.join(" + "));
    if (report.command !== "")
        lines.push("命令：" + report.command);
    lines.push("写入=" + (report.programmed ? "是" : "否") + "，校验=" + (report.verified ? "是" : "否"));
    for (const note of report.notes)
        lines.push("· " + note);
    for (const error of report.errors.slice(0, 10))
        lines.push("! " + error);
    if (!report.ok && report.logTail !== "") {
        lines.push("");
        lines.push("日志尾部：");
        lines.push(report.logTail);
    }
    return lines;
}
export function registerFlash(ctx) {
    ctx.tools.register({
        name: FLASH_TOOL,
        description: "只烧录不调试：用 openocd 执行 program <elf> verify reset exit，烧完复位运行并立刻释放探针（不会拉起调试会话，也不停在 main）。自动复用工程里的 openocd.cfg；没有则回退 CMSIS-DAP + stm32f1x。烧录前会检查 .ioc 是否启用了 Serial Wire，没有就拒绝（避免烧完 SWD 失联），确实要烧带 allowNoDebug=true。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                projectDir: { type: "string", description: "工程根目录；缺省为当前工作目录。" },
                elfPath: { type: "string", description: "显式指定要烧的 .elf；缺省从构建目录推断。" },
                buildDir: { type: "string", description: "显式构建目录；缺省自动推断（优先 Debug）。" },
                configFile: { type: "string", description: "openocd 配置文件（相对工程目录）；缺省找 openocd.cfg。" },
                adapterSpeed: { type: "number", description: "adapter speed（kHz）；连不上时可降到 1000 或 100。" },
                timeoutMs: { type: "number", description: "超时毫秒数，默认 120000。" },
                allowNoDebug: { type: "boolean", description: ".ioc 里没有 Serial Wire 时是否仍然烧录（默认 false：拒绝，避免烧掉 SWD）。" },
                binDirs: { type: "array", items: { type: "string" }, description: "工具链目录候选，优先于默认值。" },
            },
            required: [],
        },
        timeoutMs: 3 * 60_000,
        isConcurrencySafe: () => false,
        output: {
            schema: outputSchema,
            render: (_args, value) => {
                const typed = value;
                return [{ type: "text", text: formatFlashReport(typed.report).join("\n") }];
            },
        },
        async execute(rawArgs, exec) {
            const args = rawArgs ?? {};
            const subprocess = ctx.get("subprocess");
            if (subprocess === undefined) {
                const report = emptyReport("宿主缺少 subprocess 服务，无法烧录");
                return { message: report.message, report };
            }
            // 探针只有一块：有调试会话占着就先让它让出来（规格 §6）。
            const released = await releaseProbeFor("stm32_flash");
            const resolution = await resolveProjectDir(ctx, args.projectDir, exec);
            const report = await runFlash(subprocess, {
                projectDir: resolution.projectDir,
                ...(args.elfPath === undefined ? {} : { elfPath: args.elfPath }),
                ...(args.buildDir === undefined ? {} : { buildDir: args.buildDir }),
                ...(args.configFile === undefined ? {} : { configFile: args.configFile }),
                ...(args.adapterSpeed === undefined ? {} : { adapterSpeed: args.adapterSpeed }),
                ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
                ...(args.binDirs === undefined ? {} : { binDirs: args.binDirs }),
                ...(args.allowNoDebug === undefined ? {} : { allowNoDebug: args.allowNoDebug }),
                signal: exec.signal,
            });
            if (released !== null)
                report.notes.push(released);
            if (resolution.note !== null)
                report.notes.push(resolution.note);
            return { message: report.message, report };
        },
    });
}
function emptyReport(message) {
    return {
        ok: false, projectDir: "", elfPath: "", elfSize: 0, command: "", args: [], configs: [],
        durationMs: 0, programmed: false, verified: false,
        errors: [message], message, logTail: "", notes: [],
    };
}
