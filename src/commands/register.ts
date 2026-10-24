/**
 * L3：斜杠命令（人直接触发，不经过模型）。
 *
 * 为什么要有这一层：P1 的痛点就是"只想烧录却被迫进调试"。工具层解决的是模型调用；
 * 而人想按一下就烧，最省事的路径是 /stm32-flash —— 宿主直接执行 handler，不进模型、
 * 不消耗对话，结果像一条系统消息一样贴回对话里。
 *
 * 六条命令：
 *   /stm32-flash  [<工程目录>]              只烧录（program + verify + reset + exit），不进调试会话
 *   /stm32-debug  [<工程目录>]              烧录后起调试会话并停在 main，可继续读寄存器
 *   /stm32-stop                             提前关掉调试会话，把探针还给 VS Code
 *   /stm32-build  [<工程目录>] [--clean]     编译（默认走 CMake+Ninja 的 build/Debug）
 *   /stm32-doctor [<工程目录>]              体检：工具链 / 残留进程 / 端口 / .elf / .ioc 告警
 *   /stm32-env    [<工程目录>]              工具链体检卡：编译/烧录/调试/生成各缺什么、装在哪、怎么装
 *
 * 工程目录缺省取会话当前工作目录；也可以直接写路径（相对路径按当前目录解析）。
 */

import { resolve } from "node:path";

import { runBuild } from "../engine/build.js";
import { debugSessions, releaseProbeFor } from "../engine/debug-session.js";
import { runDoctor } from "../engine/doctor.js";
import { runFlash } from "../engine/flash.js";
import { ensureToolchain } from "../engine/toolchain-gate.js";
import { formatFlashReport } from "../tools/flash.js";
import type { BuildReport } from "../engine/build.js";
import type { DoctorReport } from "../engine/doctor.js";
import type { FlashReport } from "../engine/flash.js";
import type { GateResult, ToolchainCapability } from "../engine/toolchain-gate.js";
import type {
  CommandInvocation,
  CommandResult,
  DshContext,
  SubprocessService,
  WorkingDirectoryService,
} from "../types.js";

interface ParsedInvocation {
  projectDir: string;
  flags: Set<string>;
}

/** 把 `[<目录>] [--flag]` 解析成工程目录 + 开关；目录缺省用会话工作目录。 */
async function parseInvocation(ctx: DshContext, invocation: CommandInvocation): Promise<ParsedInvocation> {
  const flags = new Set<string>();
  const positional: string[] = [];
  for (const token of (invocation.rawInput ?? "").split(/\s+/u)) {
    if (token === "") continue;
    if (token.startsWith("--")) {
      flags.add(token.slice(2).toLowerCase());
      continue;
    }
    positional.push(token.replace(/^"(.*)"$/u, "$1").replace(/^'(.*)'$/u, "$1"));
  }
  const workingDirectory = ctx.get<WorkingDirectoryService>("workingDirectory");
  const cwd = workingDirectory === undefined ? process.cwd() : await workingDirectory.ensure(invocation.agent, invocation.signal);
  const first = positional[0];
  return { projectDir: first === undefined ? cwd : resolve(cwd, first), flags };
}

function needSubprocess(ctx: DshContext): SubprocessService | string {
  const subprocess = ctx.get<SubprocessService>("subprocess");
  return subprocess === undefined ? "宿主没有 subprocess 服务，命令无法执行" : subprocess;
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1) + " s";
}

function buildText(report: BuildReport): CommandResult {
  const lines: string[] = [];
  lines.push((report.ok ? "编译成功" : "编译失败") + "：" + report.message);
  if (report.durationMs > 0) lines.push("用时：" + seconds(report.durationMs));
  if (report.command !== "") lines.push("命令：" + report.command);
  for (const usage of report.memoryUsage) {
    lines.push(usage.region + "：" + String(usage.usedBytes) + " B / " + String(usage.totalBytes) + " B（" + String(usage.percent) + "%）");
  }
  const elf = report.elf;
  if (elf !== undefined) lines.push("固件：" + elf.path + "（" + String(elf.size) + " B）");
  if (report.warningCount > 0) lines.push("警告：" + String(report.warningCount) + " 条");
  for (const error of report.errors.slice(0, 8)) lines.push("! " + error);
  for (const note of report.notes) lines.push("· " + note);
  if (!report.ok && report.logTail !== "") {
    lines.push("");
    lines.push("日志尾部：");
    lines.push(report.logTail);
  }
  return { kind: report.ok ? "success" : "error", text: lines.join("\n") };
}

function doctorText(report: DoctorReport): CommandResult {
  const found = report.tools.filter((tool) => tool.found).length;
  const lines: string[] = [];
  lines.push((report.ok ? "体检通过" : "体检发现问题") + "：" + report.message);
  lines.push("工具链：" + String(found) + "/" + String(report.tools.length) + " 可用" + (report.missingRequired.length > 0 ? "（缺 " + report.missingRequired.join("、") + "）" : ""));
  lines.push("探针进程：" + (report.processes.length === 0 ? "无残留" : report.processes.map((p) => p.name + "#" + String(p.pid)).join("、")));
  lines.push("端口 " + String(report.port) + "：" + (report.portBusy ? "被占用" : "空闲"));
  if (report.elfPath !== "") lines.push("固件：" + report.elfPath + "（" + String(report.elfSize) + " B）");
  if (report.iocWarnings.length === 0) lines.push(".ioc：无告警");
  else for (const warning of report.iocWarnings) lines.push("! .ioc：" + warning);
  for (const blocker of report.blockers) lines.push("! " + blocker);
  for (const note of report.notes) lines.push("· " + note);
  return { kind: report.ok ? "success" : "error", text: lines.join("\n") };
}

function flashText(report: FlashReport, released: string | null): CommandResult {
  const lines = formatFlashReport(report);
  if (released !== null) lines.push("· " + released);
  return { kind: report.ok ? "success" : "error", text: lines.join("\n") };
}

function err(text: string): CommandResult {
  return { kind: "error", text };
}

/** 体检卡上的四项能力，顺序就是用户干的顺序：先能编译，再能烧、能调，最后才生成。 */
const ENV_CAPABILITIES: readonly ToolchainCapability[] = ["build", "flash", "debug", "generate"];

const ENV_CAPABILITY_LABEL: Record<ToolchainCapability, string> = {
  build: "编译",
  flash: "烧录",
  debug: "调试",
  generate: "生成代码",
};

/** 组件 id → 卡片上写的名字（齐全时点名用；缺的时候用门禁给的 label，那里写得更细）。 */
const ENV_COMPONENT_LABEL: Record<string, string> = {
  gcc: "gcc",
  cmake: "CMake",
  ninja: "Ninja",
  openocd: "OpenOCD",
  gdb: "GDB",
  cubemx: "CubeMX",
  "cubemx-java": "CubeMX 内置 JRE",
};

/** 四行体检结论：行的顺序固定，缺件时把第一条安装动作贴在后面（可直接粘贴）。 */
function envText(rows: readonly { capability: ToolchainCapability; gate: GateResult }[], configPath: string): CommandResult {
  const lines: string[] = ["工具链体检（配置：" + configPath + "）"];
  let anyMissing = false;
  for (const row of rows) {
    const label = ENV_CAPABILITY_LABEL[row.capability];
    if (row.gate.ok) {
      const names = row.gate.checked.map((id) => ENV_COMPONENT_LABEL[id] ?? id).join("、");
      // 单项时"OpenOCD 都在"读着别扭，按项数选量词。
      lines.push(label + "  ✔ " + names + (row.gate.checked.length > 1 ? " 都在" : " 在"));
      continue;
    }
    anyMissing = true;
    const missing = row.gate.missing.map((item) => item.label).join("、");
    const install = row.gate.missing[0]?.install[0];
    lines.push(label + "  ✘ 缺 " + missing + (install === undefined ? "" : " —— " + install));
  }
  // 缺件也是体检结果，不是命令错误；所以两种结尾都是 success。
  lines.push(anyMissing ? "要装：回「装」，我跑 stm32_env_install 出计划（先不下载）" : "都齐了：/stm32-build 就能编译");
  return { kind: "success", text: lines.join("\n") };
}

/** 注册五条斜杠命令；宿主没组合 commands 服务时直接返回（工具不受影响）。 */
export function registerCommands(ctx: DshContext): void {
  const commands = ctx.commands;
  if (commands === undefined) return;

  commands.register({
    definitionId: "dsh-stm32/stm32-flash",
    name: "stm32-flash",
    description: "只烧录不调试：openocd program + verify + reset + exit，烧完就跑，立刻释放探针",
    input: { hint: "[<工程目录>]" },
    handler: async (invocation) => {
      try {
        const subprocess = needSubprocess(ctx);
        if (typeof subprocess === "string") return err(subprocess);
        const { projectDir } = await parseInvocation(ctx, invocation);
        const released = await releaseProbeFor("stm32-flash");
        const report = await runFlash(subprocess, { projectDir, signal: invocation.signal });
        return flashText(report, released);
      } catch (error) {
        return err("烧录命令异常：" + (error instanceof Error ? error.message : String(error)));
      }
    },
  });

  commands.register({
    definitionId: "dsh-stm32/stm32-debug",
    name: "stm32-debug",
    description: "烧录并进入调试：起调试会话、停在 main，之后可用 stm32_debug_eval 读变量/寄存器",
    input: { hint: "[<工程目录>]" },
    handler: async (invocation) => {
      try {
        const subprocess = needSubprocess(ctx);
        if (typeof subprocess === "string") return err(subprocess);
        const { projectDir } = await parseInvocation(ctx, invocation);
        await releaseProbeFor("stm32-debug");
        const flash = await runFlash(subprocess, { projectDir, signal: invocation.signal });
        if (!flash.ok) return flashText(flash, null);
        // 会话管理器由工具层 configure；命令层也自己 configure 一次，
        // 这样"只注册命令不注册工具"的场合（测试、精简组合）同样能起会话。
        debugSessions.configure(subprocess, []);
        const session = await debugSessions.start({ projectDir, reset: "halt", idleTtlMs: 180_000, hardTtlMs: 10 * 60_000 });
        if (!session.ok) {
          return err(formatFlashReport(flash).join("\n") + "\n\n调试会话起不来：" + session.message);
        }
        const stopped = await debugSessions.eval({ commands: ["break main", "continue", "bt"], keepHalted: true, timeoutMs: 30_000 });
        const location = /^#0\s+(.+)$/mu.exec(stopped.output)?.[1] ?? (stopped.ok ? "已停在 main" : "没能停在 main：" + stopped.message);
        const lines = formatFlashReport(flash);
        lines.push("");
        lines.push("调试：停在 " + location);
        lines.push("端口：" + String(session.port) + "，探针由调试会话占着（空闲 " + String(Math.round(session.idleTtlMs / 1000)) + " s 自动关）");
        lines.push("· 读变量/寄存器：stm32_debug_eval（每次调用续租）");
        lines.push("· 想把探针交还给 VS Code：/stm32-stop，或者等我这一轮说完（turn/end 会自动关）");
        return { kind: "success", text: lines.join("\n") };
      } catch (error) {
        return err("调试命令异常：" + (error instanceof Error ? error.message : String(error)));
      }
    },
  });

  commands.register({
    definitionId: "dsh-stm32/stm32-stop",
    name: "stm32-stop",
    description: "关掉调试会话、释放探针（之后可以在 VS Code 里按 F5）",
    handler: async () => {
      try {
        const result = await debugSessions.stop("你敲了 /stm32-stop");
        return { kind: "success", text: result.message };
      } catch (error) {
        return err("关闭会话异常：" + (error instanceof Error ? error.message : String(error)));
      }
    },
  });

  commands.register({
    definitionId: "dsh-stm32/stm32-build",
    name: "stm32-build",
    description: "编译工程（CMake + Ninja，默认 build/Debug）；加 --clean 先全清再编译",
    input: { hint: "[<工程目录>] [--clean]" },
    handler: async (invocation) => {
      try {
        const subprocess = needSubprocess(ctx);
        if (typeof subprocess === "string") return err(subprocess);
        const { projectDir, flags } = await parseInvocation(ctx, invocation);
        await releaseProbeFor("stm32-build");
        const report = await runBuild(subprocess, { projectDir, clean: flags.has("clean"), signal: invocation.signal });
        return buildText(report);
      } catch (error) {
        return err("编译命令异常：" + (error instanceof Error ? error.message : String(error)));
      }
    },
  });

  commands.register({
    definitionId: "dsh-stm32/stm32-doctor",
    name: "stm32-doctor",
    description: "体检：工具链是否齐、有没有残留 openocd/gdb、调试端口是否空闲、.elf 与 .ioc 是否正常",
    input: { hint: "[<工程目录>]" },
    handler: async (invocation) => {
      try {
        const subprocess = needSubprocess(ctx);
        if (typeof subprocess === "string") return err(subprocess);
        const { projectDir } = await parseInvocation(ctx, invocation);
        const report = await runDoctor(subprocess, { projectDir, signal: invocation.signal });
        return doctorText(report);
      } catch (error) {
        return err("体检命令异常：" + (error instanceof Error ? error.message : String(error)));
      }
    },
  });

  commands.register({
    definitionId: "dsh-stm32/stm32-env",
    name: "stm32-env",
    description: "工具链体检：编译/烧录/调试/生成各缺什么、装在哪、怎么装",
    input: { hint: "[<工程目录>]" },
    handler: async (invocation) => {
      try {
        const subprocess = needSubprocess(ctx);
        if (typeof subprocess === "string") return err(subprocess);
        // 体检只问"这台机器能不能干这四件事"，不看工程目录；hint 里仍留着 [<工程目录>]，
        // 是因为用户习惯性地带路径，不想让人以为参数被吞了。
        // envCheck=warn：缺件也要拿到结论 + 安装建议，不能第一项缺就中断体检。
        // 门禁自带 60 s 探测缓存，四项连着查只真探一遍。
        const rows: Array<{ capability: ToolchainCapability; gate: GateResult }> = [];
        let configPath = "";
        for (const capability of ENV_CAPABILITIES) {
          const gate = await ensureToolchain(ctx, { capability, envCheck: "warn", signal: invocation.signal });
          if (configPath === "") configPath = gate.configPath;
          rows.push({ capability, gate });
        }
        return envText(rows, configPath);
      } catch (error) {
        return err("工具链体检异常：" + (error instanceof Error ? error.message : String(error)));
      }
    },
  });
}
