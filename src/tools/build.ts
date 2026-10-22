/**
 * L3：stm32_build —— 编译工程（复用 CMakePresets 里的构建目录，产物与 VS Code 一致）。
 *
 * 默认走后台 job（首次全量编译可能 30 s 以上），返回 jobId；foreground=true 同步返回报告。
 */

import { runBuild } from "../engine/build.js";
import { releaseProbeFor } from "../engine/debug-session.js";
import type { BuildReport, MemoryUsage } from "../engine/build.js";
import type { DshContext, JobHandleForRun, JobsService, JsonSchema, SubprocessService, ToolExec } from "../types.js";

export const BUILD_TOOL = "stm32_build";

const memorySchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    region: { type: "string" },
    usedBytes: { type: "number" },
    totalBytes: { type: "number" },
    percent: { type: "number" },
    raw: { type: "string" },
  },
  required: ["region", "usedBytes", "totalBytes", "percent", "raw"],
};

const elfSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string" },
    size: { type: "number" },
    mtimeMs: { type: "number" },
  },
  required: ["path", "size", "mtimeMs"],
};

const reportSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    projectDir: { type: "string" },
    buildDir: { type: "string" },
    command: { type: "string" },
    durationMs: { type: "number" },
    exitCode: { type: "number" },
    errors: { type: "array", items: { type: "string" } },
    warningCount: { type: "number" },
    memoryUsage: { type: "array", items: memorySchema },
    elf: elfSchema,
    message: { type: "string" },
    logTail: { type: "string" },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["ok", "projectDir", "buildDir", "command", "durationMs", "errors", "warningCount", "memoryUsage", "message", "logTail", "notes"],
};

export const outputSchema: JsonSchema = {
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

interface BuildArgs {
  projectDir?: string;
  buildDir?: string;
  target?: string;
  clean?: boolean;
  foreground?: boolean;
  binDirs?: string[];
  timeoutMs?: number;
}

interface ToolValue {
  mode: "job" | "report";
  jobId: string;
  message: string;
  report?: BuildReport;
}

function formatReport(report: BuildReport): string[] {
  const lines: string[] = [];
  lines.push((report.ok ? "编译成功" : "编译失败") + "：" + report.message);
  if (report.buildDir !== "") lines.push("构建目录：" + report.buildDir);
  if (report.command !== "") lines.push("命令：" + report.command);
  if (report.elf !== undefined) lines.push("产物：" + report.elf.path + "（" + String(report.elf.size) + " B）");
  for (const usage of report.memoryUsage as MemoryUsage[]) {
    lines.push("占用：" + usage.raw);
  }
  for (const note of report.notes) lines.push("· " + note);
  for (const error of report.errors.slice(0, 10)) lines.push("! " + error);
  if (!report.ok && report.logTail !== "") {
    lines.push("");
    lines.push("日志尾部：");
    lines.push(report.logTail);
  }
  return lines;
}

export function registerBuild(ctx: DshContext): void {
  ctx.tools.register({
    name: BUILD_TOOL,
    description:
      "编译 STM32 工程：用 cmake --build 驱动工程自己的构建目录（自动从 CMakePresets.json / build/*/CMakeCache.txt 推断，优先 Debug），返回错误行（file:line:col）、警告数、FLASH/RAM 占用与 .elf 路径。默认后台 job；foreground=true 同步返回。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectDir: { type: "string", description: "工程根目录；缺省为当前工作目录。" },
        buildDir: { type: "string", description: "显式构建目录；缺省自动推断（优先含 Debug 的 preset 目录）。" },
        target: { type: "string", description: "只构建某个 CMake target（例如 demo.elf）。" },
        clean: { type: "boolean", description: "先 clean 再编译（全量，慢）。" },
        foreground: { type: "boolean", description: "同步返回完整报告（默认 false，走后台 job）。" },
        binDirs: { type: "array", items: { type: "string" }, description: "工具链目录候选，优先于默认值/环境变量。" },
        timeoutMs: { type: "number", description: "超时毫秒数，默认 300000（5 分钟）。" },
      },
      required: [],
    },
    timeoutMs: 10 * 60_000,
    isConcurrencySafe: () => false,
    output: {
      schema: outputSchema,
      render: (_args, value) => {
        const typed = value as ToolValue;
        const lines = typed.report === undefined ? [typed.message] : formatReport(typed.report);
        if (typed.mode === "job") lines.push("job：" + typed.jobId + "（用 job_output 读进度，job_kill 停止）");
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(rawArgs: BuildArgs | undefined, exec: ToolExec): Promise<ToolValue> {
      const args = rawArgs ?? {};
      const subprocess = ctx.get<SubprocessService>("subprocess");
      if (subprocess === undefined) return { mode: "report", jobId: "", message: "宿主缺少 subprocess 服务，无法编译" };
      const projectDir = args.projectDir ?? process.cwd();
      // 编译本身不碰探针，但 openocd 常驻会让 ninja 的进程环境变复杂；先让会话让出来更稳。
      const released = await releaseProbeFor("stm32_build");
      const jobs = ctx.get<JobsService>("jobs");
      if (args.foreground === true || jobs === undefined) {
        const report = await runBuild(subprocess, {
          projectDir,
          ...(args.buildDir === undefined ? {} : { buildDir: args.buildDir }),
          ...(args.target === undefined ? {} : { target: args.target }),
          ...(args.clean === undefined ? {} : { clean: args.clean }),
          ...(args.binDirs === undefined ? {} : { binDirs: args.binDirs }),
          ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
          signal: exec.signal,
        });
        if (released !== null) report.notes.push(released);
        return { mode: "report", jobId: "", message: report.message, report };
      }
      const controller = new AbortController();
      const jobId = jobs.start({
        kind: "stm32-build",
        label: "stm32_build " + projectDir,
        ...(exec.agent === undefined ? {} : { owner: exec.agent.id }),
        run: (handle: JobHandleForRun) => {
          handle.append("开始编译：" + projectDir + "\n");
          const done = runBuild(subprocess, {
            projectDir,
            ...(args.buildDir === undefined ? {} : { buildDir: args.buildDir }),
            ...(args.target === undefined ? {} : { target: args.target }),
            ...(args.clean === undefined ? {} : { clean: args.clean }),
            ...(args.binDirs === undefined ? {} : { binDirs: args.binDirs }),
            ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
            signal: controller.signal,
            onProgress: (line) => handle.append(line + "\n"),
          }).then((report) => {
            handle.append("\n" + formatReport(report).join("\n") + "\n");
            return { status: report.ok ? ("completed" as const) : ("failed" as const), detail: report.message };
          });
          return {
            done,
            cancel: (reason?: string) => {
              handle.append("\n被取消：" + (reason ?? "用户停止") + "\n");
              controller.abort();
            },
          };
        },
      });
      return { mode: "job", jobId, message: "已在后台开始编译 " + projectDir };
    },
  });
}
