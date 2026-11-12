/**
 * CubeMX 图形界面的占用检测。
 *
 * 为什么需要：CubeMX 是**单实例**应用。GUI 已经开着的时候再执行
 * `jre/bin/java.exe -jar STM32CubeMX.exe -q <script>`，命令行会被转发给那个 GUI 进程 ——
 * `-q`（无界面）失效，脚本在 GUI 里跑，于是弹出 "Warning: Load Project … would you like to save the project ?"
 * 这类**模态框**：无人点击时生成会一直阻塞（3–4 分钟的任务变为无限等待）。
 *
 * 插件无法代为点击按钮（SWT 原生窗口，UIA/SendKeys 均不稳定），只能**先发现、先拒绝**，
 * 让人把 GUI 关掉再重跑 —— 报错比卡死便宜。
 */
import { runCapture } from "./subprocess-runner.js";
import { parseTasklistCsv } from "./doctor.js";
import type { SubprocessService } from "../types.js";

export interface CubeMxGuiProcess {
  name: string;
  pid: number;
}

/**
 * 当前正在运行的 CubeMX GUI 进程（只认 STM32CubeMX.exe；无头调用自己跑的是 jre/bin/java.exe，不算）。
 * 拿不到进程列表（非 Windows / tasklist 不可用）时返回空数组：不因为探测失败就拦住用户。
 */
export async function findRunningCubeMxGui(
  subprocess: SubprocessService,
  signal?: AbortSignal,
): Promise<CubeMxGuiProcess[]> {
  let outcome;
  try {
    outcome = await runCapture(subprocess, {
      argv: ["tasklist", "/NH", "/FO", "CSV"],
      timeoutMs: 10_000,
      maxBytes: 512 * 1024,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    return [];
  }
  if (outcome.spawnError !== null || outcome.exitCode !== 0) return [];
  return parseTasklistCsv(outcome.stdout + "\n" + outcome.stderr, ["STM32CubeMX.exe"]).map((process) => ({
    name: process.name,
    pid: process.pid,
  }));
}

/** 检测到 GUI 时给用户的一句话（直接进 errors/message）。 */
export function describeCubeMxGuiConflict(processes: readonly CubeMxGuiProcess[]): string {
  const list = processes.map((process) => process.name + "#" + String(process.pid)).join("、");
  return (
    "检测到 STM32CubeMX 图形界面正在运行（" + list + "）：CubeMX 是单实例，命令行会被转发至该进程，" +
    "无头模式（-q）失效并可能弹出\"是否保存工程\"这类模态框，生成会一直等下去。" +
    "请先关掉 CubeMX 窗口（或保存后退出），再重跑；不想关也可以先用 CubeMX 自己 Generate Code，再回来跑 stm32_build"
  );
}
