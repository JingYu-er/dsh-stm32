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
 */

import type { F1Chip } from "../data/stm32f1.js";

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
  /** RAM 是不是从兜底表来的（false 表示不是精确值，要提醒）。 */
  ramExact: boolean;
  /** 一行摘要（进 main.c 注释与 report）：64K FLASH + 20K RAM。 */
  summary: string;
  warnings: string[];
}

/** line 代号：STM32F103 → 103。 */
function lineOf(chip: F1Chip): string {
  return chip.prefix.slice(6);
}

/**
 * ST 的器件代号：完整型号去掉温度/封装尾号换成 x（STM32F103C8T6 → STM32F103C8Tx），
 * 只给容量档的写法（F103）用 STM32F103xB 这种"档位代号"。
 * 为什么要凑出这个名字：CubeMX 生成工程里链接脚本就叫 <DeviceId>_FLASH.ld，
 * 沿用同一约定，用户从 HAL 工程切过来时一眼认得出这是哪颗芯片的脚本。
 */
export function deviceIdFor(chip: F1Chip): string {
  const cpn = chip.cpn.toUpperCase();
  if (/^STM32F\d{3}[A-Z][0-9A-G]/u.test(cpn) && cpn.length >= 11) {
    if (/[67]$/u.test(cpn) && cpn.length >= 12) return cpn.slice(0, -1) + "x";
    if (/^STM32F\d{3}[A-Z][0-9A-G]$/u.test(cpn)) return cpn + "Tx";
    return cpn.slice(0, -1) + "x";
  }
  return chip.prefix + "x" + chip.group.slice(1).toUpperCase();
}

function kbOf(bytes: number): number {
  return Math.round(bytes / 1024);
}

/** 给一颗芯片算链接脚本参数（只读、纯函数）。 */
export function planRegisterLinker(chip: F1Chip): RegisterLinkerPlan {
  const warnings: string[] = [];
  const line = lineOf(chip);
  const key = chip.prefix.slice(6) + chip.group;
  const deviceId = deviceIdFor(chip);

  const flashBytes = chip.flashBytes ?? 0;
  if (flashBytes <= 0) {
    warnings.push("这颗芯片的 Flash 大小没收录（stm32f1.ts 的 FLASH_BY_LETTER 里查不到档位 " + chip.group + "），链接脚本按 64K 生成；确认后请补表。");
  }
  const exactRam = chip.ramBytes ?? null;
  const fallbackKb = RAM_FALLBACK_KB[key];
  const ramBytes = exactRam !== null ? exactRam : (fallbackKb ?? 20) * 1024;
  if (exactRam === null && fallbackKb === undefined) {
    warnings.push("F" + line + " 的档位 " + chip.group + " 的 RAM 大小没收录，链接脚本按 20K 兜底；确认后请补 stm32f1.ts 的 RAM_BY_LINE_LETTER 或 register-linker.ts 的 RAM_FALLBACK_KB。");
  } else if (exactRam === null) {
    warnings.push("F" + line + " 的档位 " + chip.group + " 的 RAM 没收录在 stm32f1.ts 里，链接脚本按 CubeMX db 的最小值 " + kbOf(ramBytes) + "K 生成（宁可小，栈不会越界）；封装更大时可以把 LENGTH 改大。");
  }
  if (ramBytes > 0 && ramBytes <= 8 * 1024) {
    warnings.push("这颗芯片只有 " + kbOf(ramBytes) + "K RAM，链接脚本仍保留默认的 1K 栈 + 512B 堆（_Min_Stack_Size/_Min_Heap_Size），紧张时请调小。");
  }

  const flashKb = flashBytes > 0 ? kbOf(flashBytes) : 64;
  const ramKb = kbOf(ramBytes);
  return {
    mcu: chip.cpn,
    deviceId,
    fileName: deviceId + "_FLASH.ld",
    flashBytes: flashKb * 1024,
    ramBytes: ramBytes,
    ramExact: exactRam !== null,
    summary: flashKb + "K FLASH + " + ramKb + "K RAM",
    warnings,
  };
}

/**
 * 把模板链接脚本里写死 C8T6 的四处改掉：
 *   注释 :9 "Linker script for STM32F103C8Tx series"
 *   注释 :10 "64Kbytes FLASH and 20Kbytes RAM"
 *   MEMORY :58 RAM  LENGTH = 20K
 *   MEMORY :59 FLASH LENGTH = 64K
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
  const ramLine = /^([ \t]*RAM \(xrw\)[ \t]*:[ \t]*ORIGIN = 0x20000000, LENGTH = )[0-9]+[KM][ \t]*$/mu;
  if (ramLine.test(text)) {
    text = text.replace(ramLine, "$1" + ramKb + "K");
    patched++;
  }
  const flashLine = /^([ \t]*FLASH \(rx\)[ \t]*:[ \t]*ORIGIN = 0x8000000, LENGTH = )[0-9]+[KM][ \t]*$/mu;
  if (flashLine.test(text)) {
    text = text.replace(flashLine, "$1" + flashKb + "K");
    patched++;
  }
  return patched === 4 ? text : null;
}
