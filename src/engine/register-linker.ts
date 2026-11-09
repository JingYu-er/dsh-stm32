/**
 * 寄存器路线的链接脚本（按芯片型号渲染一份 <DeviceId>_FLASH.ld）。
 *
 * 为什么必须按型号渲染：templates/scaffold/STM32F103XX_FLASH.ld 是给 F103C8T6 写的——
 * MEMORY 里写死 LENGTH = 64K FLASH / 20K RAM。拿它去链 F103RBT6（128K/20K）还能跑，
 * 但链 F103ZET6（512K/64K）就只用到前 64K，超出部分链接器直接报 overflow；
 * 反过来链 F100C6（16K/4K）更糟：链接器以为有 64K Flash，把 .data/.bss 摆到不存在的
 * 内存上，烧进去就是 HardFault。所以寄存器路线不从模板拷死脚本，而是改 MEMORY 两行。
 *
 * 时间/复杂度上这也是最省的做法：链接脚本是 ASCII 文本，改两行比引一个链接脚本生成器简单。
 *
 * 例外：H7/U5 的 RAM 不是一块连续内存（H7 = DTCM 128K + AXI SRAM；U5 = 主 SRAM + SRAM4@0x28000000）。
 * 这时 chips.json 的 ramBytes 会把不相邻的区域加在一起，按它写 LENGTH 会让 _estack 落进空洞。
 * 这类族在 chips.json 里带 linkerRam（连续窗口的 origin/sizeBytes），本文件优先用它并同时改 ORIGIN。
 */

import type { DeviceLinkerRam } from "../data/device-facts.js";

/**
 * 链接脚本只需要这几项事实：Flash/RAM 尺寸 + 一个像样的器件代号。
 * F1Chip 与 chips.json 的 DeviceFactsChip 都满足它（后者带 deviceId，直接用它）。
 */
export interface RegisterLinkerChip {
  readonly cpn: string;
  /** F1Chip 才有：STM32F103。用于推 line 与器件代号。 */
  readonly prefix?: string;
  readonly group: string;
  /** chips.json 里的 ST 器件代号，例如 STM32F401CBUx。 */
  readonly deviceId?: string;
  readonly flashBytes: number | null;
  readonly ramBytes: number | null;
  /**
   * 可选：链接脚本真正可用的连续 RAM 窗口（chips.json 的 linkerRam）。
   * H7/U5 这类 RAM 分区的族必须给；没有就按 ramBytes 整块生成（F1 等连续族的行为不变）。
   */
  readonly linkerRam?: DeviceLinkerRam;
}

/**
 * F100/F101/F102 的 RAM 兜底表（KB），取值来自 STM32CubeMX 的 db/mcu/*.xml：
 * 同一 line+档位在 db 里是一个合并条目，<Ram> 取的是该组内最小封装的值。
 * 为什么用最小值：链接脚本把 RAM 写小只会"少用"，写大才会把栈顶伸到不存在的空间；
 * 所以兜底宁可小，同时往 report 里写一条 warning 让用户去确认。
 * （F103/F105/F107 用 stm32f1.ts 里已核对的 RAM_BY_LINE_LETTER，不走这张表。）
 */
const RAM_FALLBACK_KB: Readonly<Record<string, number>> = {
  "100x6": 4,
  "100xb": 8,
  "100xe": 24,
  "101x6": 4,
  "101xb": 10,
  "101xe": 32,
  "101xg": 80,
  "102x6": 4,
  "102xb": 10,
  "103x6": 6,
  "103xb": 20,
  "103xe": 48,
  "103xg": 96,
  "105xc": 64,
  "107xc": 64,
};

export interface RegisterLinkerPlan {
  mcu: string;
  /** ST 的器件代号，例如 STM32F103C8Tx（链接脚本名、注释都用它）。 */
  deviceId: string;
  /** 链接脚本文件名，例如 STM32F103C8Tx_FLASH.ld。 */
  fileName: string;
  flashBytes: number;
  ramBytes: number;
  /** 链接脚本 RAM 的起始地址（F1 等连续族是 0x20000000；H7 是 DTCM 起点）。 */
  ramOrigin: number;
  /** linkerRam 的区域名（DTCM / SRAM），只用于摘要与警告文案。 */
  ramRegion?: string;
  /** RAM 是不是从兜底表来的（false 表示不是精确值，要提醒）。 */
  ramExact: boolean;
  /** 一行摘要（进 main.c 注释与 report）：64K FLASH + 20K RAM。 */
  summary: string;
  warnings: string[];
}

/** line 代号：STM32F103 → 103；通用事实没有 prefix 时给空串。 */
function lineOf(chip: RegisterLinkerChip): string {
  return (chip.prefix ?? "").slice(6);
}

/**
 * ST 的器件代号：完整型号去掉温度/封装尾号换成 x（STM32F103C8T6 → STM32F103C8Tx），
 * 只给容量档的写法（F103）用 STM32F103xB 这种"档位代号"。
 * 为什么要凑出这个名字：CubeMX 生成工程里链接脚本就叫 <DeviceId>_FLASH.ld，
 * 沿用同一约定，用户从 HAL 工程切过来时一眼认得出这是哪颗芯片的脚本。
 */
export function deviceIdFor(chip: RegisterLinkerChip): string {
  // chips.json 已经把 CubeMX 的 DeviceId 算好了（STM32F401CBUx 这种），直接用；
  // 只有 F1Chip 走下面按型号命名的兜底。
  if (chip.deviceId !== undefined && chip.deviceId !== "") return chip.deviceId;
  const prefix = chip.prefix ?? chip.cpn.slice(0, "STM32F103".length);
  const cpn = chip.cpn.toUpperCase();
  if (/^STM32F\d{3}[A-Z][0-9A-G]/u.test(cpn) && cpn.length >= 11) {
    if (/[67]$/u.test(cpn) && cpn.length >= 12) return cpn.slice(0, -1) + "x";
    if (/^STM32F\d{3}[A-Z][0-9A-G]$/u.test(cpn)) return cpn + "Tx";
    return cpn.slice(0, -1) + "x";
  }
  return prefix + "x" + chip.group.slice(1).toUpperCase();
}

function kbOf(bytes: number): number {
  return Math.round(bytes / 1024);
}

/** 给一颗芯片算链接脚本参数（只读、纯函数）。 */
export function planRegisterLinker(chip: RegisterLinkerChip): RegisterLinkerPlan {
  const warnings: string[] = [];
  const line = lineOf(chip);
  const key = line + chip.group;
  const deviceId = deviceIdFor(chip);

  const flashBytes = chip.flashBytes ?? 0;
  if (flashBytes <= 0) {
    warnings.push("这颗芯片的 Flash 大小没收录（内置资源 chips.json 里这一档没有 flashBytes），链接脚本按 64K 生成；确认后请更新内置资源。");
  }
  const exactRam = chip.ramBytes ?? null;
  // 连续窗口优先：ramBytes 只是「芯片共有多少 RAM」，H7/U5 里包含不相邻区域。
  const window = chip.linkerRam !== undefined && chip.linkerRam.sizeBytes > 0 ? chip.linkerRam : null;
  const fallbackKb = RAM_FALLBACK_KB[key];
  const ramBytes = window !== null ? window.sizeBytes : (exactRam !== null ? exactRam : (fallbackKb ?? 20) * 1024);
  if (window !== null && exactRam !== null && exactRam > window.sizeBytes) {
    warnings.push(
      "这颗芯片共 " + kbOf(exactRam) + "K RAM，但其中有不连续区域；链接脚本按官方连续窗口 0x" +
        window.origin.toString(16).toUpperCase().padStart(8, "0") + " 起 " + kbOf(window.sizeBytes) + "K 生成，栈顶 = 0x" +
        (window.origin + window.sizeBytes).toString(16).toUpperCase().padStart(8, "0") +
        "（" + (window.region ?? "连续 RAM") + "）。需要更多 RAM 时手工在 MEMORY 里加分区，别直接把 LENGTH 改大。",
    );
  }
  if (exactRam === null && fallbackKb === undefined) {
    warnings.push((line === "" ? "这颗芯片" : "F" + line + " 的档位 " + chip.group) + " 的 RAM 大小没收录，链接脚本按 20K 兜底；确认后请更新内置资源（chips.json 的 ramBytes）。");
  } else if (exactRam === null) {
    warnings.push("F" + line + " 的档位 " + chip.group + " 的 RAM 没收录，链接脚本按 CubeMX db 的最小值 " + kbOf(ramBytes) + "K 生成（宁可小，栈不会越界）；封装更大时可以把 LENGTH 改大。");
  }
  if (ramBytes > 0 && ramBytes <= 8 * 1024) {
    warnings.push("这颗芯片只有 " + kbOf(ramBytes) + "K RAM，链接脚本仍保留默认的 1K 栈 + 512B 堆（_Min_Stack_Size/_Min_Heap_Size），紧张时请调小。");
  }

  const flashKb = flashBytes > 0 ? kbOf(flashBytes) : 64;
  const ramKb = kbOf(ramBytes);
  const ramRegion = window?.region;
  return {
    mcu: chip.cpn,
    deviceId,
    fileName: deviceId + "_FLASH.ld",
    flashBytes: flashKb * 1024,
    ramBytes: ramBytes,
    ramOrigin: window?.origin ?? 0x20000000,
    ...(ramRegion === undefined || ramRegion === "" ? {} : { ramRegion }),
    ramExact: window !== null || exactRam !== null,
    summary: flashKb + "K FLASH + " + ramKb + "K RAM" + (ramRegion === undefined || ramRegion === "" ? "" : "（" + ramRegion + "）"),
    warnings,
  };
}

/**
 * 把模板链接脚本里写死 C8T6 的四处改掉：
 *   注释 :9 "Linker script for STM32F103C8Tx series"
 *   注释 :10 "64Kbytes FLASH and 20Kbytes RAM"
 *   MEMORY :58 RAM  ORIGIN = 0x20000000, LENGTH = 20K
 *   MEMORY :59 FLASH LENGTH = 64K
 * RAM 的 ORIGIN 也要改：H7 的连续窗口虽然从 0x20000000 起，但别的族可能有偏移；
 * 统一按 plan.ramOrigin 写，F1 的输出逐字不变（还是 0x20000000）。
 * 任何一处找不到（模板被人改过）就返回 null，让调用方明确报错，而不是生成一个尺寸错的脚本。
 */
export function renderLinkerScript(plan: RegisterLinkerPlan, template: string): string | null {
  const flashKb = kbOf(plan.flashBytes);
  const ramKb = kbOf(plan.ramBytes);
  let text = template;
  let patched = 0;

  const commentTitle = /^(\*\*\s+Abstract\s+:\s+Linker script for ).*$/mu;
  if (commentTitle.test(text)) {
    text = text.replace(commentTitle, "$1" + plan.deviceId + " series");
    patched++;
  }
  const commentSizes = /^(\*\*\s+)([0-9]+Kbytes FLASH and [0-9]+Kbytes RAM)\s*$/mu;
  if (commentSizes.test(text)) {
    text = text.replace(commentSizes, "$1" + flashKb + "Kbytes FLASH and " + ramKb + "Kbytes RAM");
    patched++;
  }
  // ORIGIN 与 LENGTH 一起改：模板写死的 0x20000000 只对连续族成立（H7/U5 靠 linkerRam 给真值）。
  const ramLine = /^([ \t]*RAM \(xrw\)[ \t]*:[ \t]*ORIGIN = )0x[0-9A-Fa-f]+, LENGTH = [0-9]+[KM][ \t]*$/mu;
  if (ramLine.test(text)) {
    const origin = "0x" + Math.trunc(plan.ramOrigin).toString(16).toUpperCase().padStart(8, "0");
    text = text.replace(ramLine, "$1" + origin + ", LENGTH = " + ramKb + "K");
    patched++;
  }
  const flashLine = /^([ \t]*FLASH \(rx\)[ \t]*:[ \t]*ORIGIN = 0x8000000, LENGTH = )[0-9]+[KM][ \t]*$/mu;
  if (flashLine.test(text)) {
    text = text.replace(flashLine, "$1" + flashKb + "K");
    patched++;
  }
  return patched === 4 ? text : null;
}
