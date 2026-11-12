/**
 * 引脚表：从工程的 .ioc 读出「哪个引脚配成了什么」，供调试台的面板显示。
 *
 * 与 `stm32_ioc_inspect` 的分工：那个工具返回完整摘要（时钟树、NVIC、设置项、告警），
 * 面向一次性的命令行诊断；这里只取面板要画的部分，并额外补上「每个通信外设占哪几个脚」，
 * 面板据此分组显示。解析全部复用 `summarizeIoc`，不另写一套 .ioc 解析。
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { summarizeIoc, type IocPin } from "./ioc.js";

export interface PinoutGroup {
  /** 分组名：外设实例（USART1 / TIM2）或用途（GPIO / 调试口 / 时钟）。 */
  readonly name: string;
  readonly pins: readonly IocPin[];
}

export interface PinoutReport {
  /** 工程目录（面板显示用）。 */
  readonly projectDir: string;
  /** .ioc 路径。 */
  readonly iocPath: string;
  readonly mcu: { cpn: string; name: string; family: string; package: string };
  readonly clocks: {
    sysclkHz: number | null;
    ahbHz: number | null;
    apb1Hz: number | null;
    apb2Hz: number | null;
  };
  readonly debug: { serialWire: boolean; jtag: boolean; pins: readonly string[]; mode: string };
  /** 已使能中断个数。 */
  readonly nvicCount: number;
  readonly warnings: readonly string[];
  /** 全部引脚，按 .ioc 里 Mcu.PinN 的顺序。 */
  readonly pins: readonly IocPin[];
  /** 分组后的引脚：先外设，再 GPIO，最后调试口与时钟。 */
  readonly groups: readonly PinoutGroup[];
  /** 已使能外设实例。 */
  readonly peripherals: readonly string[];
}

export interface PinoutFailure {
  readonly ok: false;
  readonly error: string;
}

export type PinoutResult = { readonly ok: true; readonly report: PinoutReport } | PinoutFailure;

/**
 * 工程目录里第一个读得出来的 .ioc。
 *
 * 与 `readIocCpn` 保持同一套挑选规则（文件名排序后取第一个可读的），
 * 免得面板显示的芯片和断点预算用的芯片不是同一份。
 */
export function findIocPath(projectDir: string): string {
  let names: string[];
  try {
    names = readdirSync(projectDir);
  } catch {
    return "";
  }
  const candidates = names.filter((name) => name.toLowerCase().endsWith(".ioc")).sort();
  for (const name of candidates) {
    const full = join(projectDir, name);
    try {
      readFileSync(full, "utf8");
      return full;
    } catch {
      // 读不了就试下一个。
    }
  }
  return "";
}

/** 信号 → 分组名。`GPIO_Output` 归 GPIO；`SYS_JTMS-SWDIO` 归调试口；其余按外设实例归组。 */
export function groupOfPin(pin: IocPin): string {
  if (pin.kind === "debug") return "调试口";
  if (pin.kind === "clock") return "时钟";
  if (pin.kind === "virtual") return "虚拟引脚";
  // USART1_TX → USART1；S_TIM2_CH1_ETR → TIM2；ADC1_IN1 → ADC1。
  const match = /^(?:S_)?([A-Z][A-Z0-9]*\d+)[_]/u.exec(pin.signal);
  if (match === null || match[1] === undefined) return "GPIO";
  return match[1];
}

const GROUP_ORDER_TAIL: readonly string[] = ["GPIO", "调试口", "时钟", "虚拟引脚"];

/** 分组顺序：外设按名字（USART1 在 USART10 前），固定类别排最后。 */
export function groupPins(pins: readonly IocPin[]): PinoutGroup[] {
  const buckets = new Map<string, IocPin[]>();
  for (const pin of pins) {
    const name = groupOfPin(pin);
    const bucket = buckets.get(name);
    if (bucket === undefined) buckets.set(name, [pin]);
    else bucket.push(pin);
  }
  // 外设组 rank 0，固定类别从 1 起；同 rank 内按名字自然序（USART2 < USART10）。
  const rank = (name: string): number => {
    const tail = GROUP_ORDER_TAIL.indexOf(name);
    return tail === -1 ? 0 : tail + 1;
  };
  const names = [...buckets.keys()].sort((left, right) => {
    const delta = rank(left) - rank(right);
    return delta !== 0 ? delta : left.localeCompare(right, "en", { numeric: true });
  });
  return names.map((name) => ({ name, pins: buckets.get(name) ?? [] }));
}

/** 读工程引脚表。工程没有 .ioc、读失败、解析为空都返回 ok:false 并说明原因。 */
export function readPinout(projectDir: string): PinoutResult {
  const dir = projectDir.trim();
  if (dir === "") return { ok: false, error: "projectDir 不能为空" };
  const iocPath = findIocPath(dir);
  if (iocPath === "") return { ok: false, error: "工程目录里没有可读的 .ioc：" + dir };
  let text: string;
  try {
    text = readFileSync(iocPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: "读取 " + basename(iocPath) + " 失败：" + message };
  }
  const summary = summarizeIoc(text, iocPath);
  return {
    ok: true,
    report: {
      projectDir: dir,
      iocPath,
      mcu: summary.mcu,
      clocks: summary.clocks,
      debug: summary.debug,
      nvicCount: summary.nvicEnabled.length,
      warnings: summary.warnings,
      pins: summary.pins,
      groups: groupPins(summary.pins),
      peripherals: summary.peripherals,
    },
  };
}
