/**
 * L3：stm32_generate —— 无头生成 CubeMX 代码并落位到工程结构。
 *
 * 默认走后台 job（3–4 分钟，超过工具超时阈值），进度可读；foreground=true 时
 * 同步等待并直接返回完整报告（调试用）。
 */
import { runGenerate } from "../engine/generate.js";
import { releaseProbeFor } from "../engine/debug-session.js";
export const GENERATE_TOOL = "stm32_generate";
const verdictSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        ok: { type: "boolean" },
        successLine: { type: "string" },
        errors: { type: "array", items: { type: "string" } },
        knownNoise: { type: "array", items: { type: "string" } },
    },
    required: ["ok", "successLine", "errors", "knownNoise"],
};
const fileSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        source: { type: "string" },
        target: { type: "string" },
        action: {
            type: "string",
            enum: ["created", "overwritten", "skipped-no-user-code-markers", "would-write"],
        },
        preserved: { type: "array", items: { type: "string" } },
        droppedLabels: { type: "array", items: { type: "string" } },
    },
    required: ["source", "target", "action", "preserved", "droppedLabels"],
};
const reportSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        ok: { type: "boolean" },
        projectDir: { type: "string" },
        iocPath: { type: "string" },
        layout: { type: "string", enum: ["coupled", "per-ip"] },
        durationMs: { type: "number" },
        message: { type: "string" },
        script: { type: "string" },
        command: { type: "string" },
        logTail: { type: "string" },
        backupDir: { type: "string" },
        verdict: verdictSchema,
        files: { type: "array", items: fileSchema },
        notes: { type: "array", items: { type: "string" } },
    },
    required: ["ok", "projectDir", "iocPath", "layout", "durationMs", "message", "script", "command", "logTail", "backupDir", "verdict", "files", "notes"],
};
export const outputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        mode: { type: "string", enum: ["job", "report"] },
        jobId: { type: "string" },
        message: { type: "string" },
        report: reportSchema,
    },
    required: ["mode", "jobId", "message"],
};
function formatReport(report) {
    const lines = [];
    lines.push((report.ok ? "生成成功" : "生成失败") + "：" + report.message);
    lines.push("工程：" + report.projectDir);
    if (report.iocPath !== "")
        lines.push(".ioc：" + report.iocPath + "（布局 " + report.layout + "）");
    if (report.durationMs > 0)
        lines.push("耗时：" + (report.durationMs / 1000).toFixed(1) + " s");
    if (report.verdict.successLine !== "")
        lines.push("CubeMX：" + report.verdict.successLine);
    for (const error of report.verdict.errors.slice(0, 5))
        lines.push("! " + error);
    if (report.files.length > 0) {
        lines.push("");
        for (const file of report.files) {
            const extra = file.preserved.length === 0 ? "" : "  保活 " + file.preserved.join(",");
            const drop = file.droppedLabels.length === 0 ? "" : "  未搬运 " + file.droppedLabels.join(",");
            lines.push(file.action.padEnd(30) + file.target + extra + drop);
        }
    }
    if (report.backupDir !== "")
        lines.push("备份：" + report.backupDir);
    for (const note of report.notes)
        lines.push("· " + note);
    if (!report.ok && report.logTail !== "") {
        lines.push("");
        lines.push("日志尾部：");
        lines.push(report.logTail);
    }
    return lines;
}
function summarize(report) {
    return report.message;
}
export function registerGenerate(ctx) {
    ctx.tools.register({
        name: GENERATE_TOOL,
        description: "用 STM32CubeMX 无头模式（java -jar STM32CubeMX.exe -q）按 .ioc 生成代码，并把产物从 Src/Inc 落位到工程的 Core/Src、Core/Inc；目标文件已存在时搬运 USER CODE 区内容，覆盖前备份到 .dsh-stm32/backups。默认后台运行（3–4 分钟），返回 jobId，用 job_output 看进度；foreground=true 则同步返回完整报告。dryRun=true 只生成不改工程（CubeMX 仍会写 Src/Inc）。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                projectDir: { type: "string", description: "工程根目录（含 .ioc 与 CMakeLists.txt）；缺省为当前工作目录。" },
                iocPath: { type: "string", description: "显式指定 .ioc 路径；缺省在工程根目录里找唯一的 *.ioc。" },
                layout: {
                    type: "string",
                    enum: ["auto", "coupled", "per-ip"],
                    description: "生成布局。auto 按现有 Core/Src/main.c 的 USER CODE 标签推断；coupled 把外设初始化并入 main.c（ST 默认工程）；per-ip 每外设一对 .c/.h。",
                },
                dryRun: { type: "boolean", description: "只跑 CubeMX 并给出落位计划，不改动 Core/**。" },
                foreground: { type: "boolean", description: "同步执行并返回完整报告（默认 false，走后台 job）。" },
                cubeMxRoots: { type: "array", items: { type: "string" }, description: "STM32CubeMX 安装根目录候选，优先于默认值/环境变量。" },
                timeoutMs: { type: "number", description: "超时毫秒数，默认 600000（10 分钟）。" },
            },
            required: [],
        },
        timeoutMs: 20 * 60_000,
        isConcurrencySafe: () => false,
        output: {
            schema: outputSchema,
            render: (_args, value) => {
                const typed = value;
                const lines = typed.report === undefined ? [typed.message] : formatReport(typed.report);
                if (typed.mode === "job")
                    lines.push("job：" + typed.jobId + "（用 job_output 读进度，job_kill 停止）");
                return [{ type: "text", text: lines.join("\n") }];
            },
        },
        async execute(rawArgs, exec) {
            const args = rawArgs ?? {};
            const subprocess = ctx.get("subprocess");
            if (subprocess === undefined) {
                return { mode: "report", jobId: "", message: "宿主缺少 subprocess 服务，无法生成代码" };
            }
            const projectDir = args.projectDir ?? process.cwd();
            // CubeMX 生成期间别让 openocd 占着探针（单飞，规格 I5）。
            const released = await releaseProbeFor("stm32_generate");
            const jobs = ctx.get("jobs");
            const useJob = args.foreground !== true && jobs !== undefined;
            if (!useJob) {
                const report = await runGenerate(subprocess, {
                    projectDir,
                    ...(args.iocPath === undefined ? {} : { iocPath: args.iocPath }),
                    ...(args.layout === undefined ? {} : { layout: args.layout }),
                    ...(args.dryRun === undefined ? {} : { dryRun: args.dryRun }),
                    ...(args.cubeMxRoots === undefined ? {} : { cubeMxRoots: args.cubeMxRoots }),
                    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
                    signal: exec.signal,
                });
                if (released !== null)
                    report.notes.push(released);
                return { mode: "report", jobId: "", message: summarize(report), report };
            }
            const registry = jobs;
            const controller = new AbortController();
            let report = null;
            const jobId = registry.start({
                kind: "stm32-generate",
                label: "stm32_generate " + projectDir,
                ...(exec.agent === undefined ? {} : { owner: exec.agent.id }),
                run: (handle) => {
                    handle.append("开始无头生成：" + projectDir + "\n");
                    const done = runGenerate(subprocess, {
                        projectDir,
                        ...(args.iocPath === undefined ? {} : { iocPath: args.iocPath }),
                        ...(args.layout === undefined ? {} : { layout: args.layout }),
                        ...(args.dryRun === undefined ? {} : { dryRun: args.dryRun }),
                        ...(args.cubeMxRoots === undefined ? {} : { cubeMxRoots: args.cubeMxRoots }),
                        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
                        signal: controller.signal,
                        onProgress: (line) => handle.append(line + "\n"),
                    }).then((result) => {
                        report = result;
                        handle.append("\n" + formatReport(result).join("\n") + "\n");
                        return {
                            status: result.ok ? "completed" : "failed",
                            detail: result.ok ? result.message : result.message,
                        };
                    });
                    return {
                        done,
                        cancel: (reason) => {
                            handle.append("\n被取消：" + (reason ?? "用户停止") + "\n");
                            controller.abort();
                        },
                    };
                },
            });
            void report;
            return {
                mode: "job",
                jobId,
                message: "已在后台开始生成 " + projectDir + "（CubeMX 启动约 90–150 s，整体 3–4 分钟）",
            };
        },
    });
}
