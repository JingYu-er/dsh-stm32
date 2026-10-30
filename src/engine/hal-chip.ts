/**
 * L2.5：HAL 路线的「具体型号 → 工程文件事实」派生。
 *
 * 为什么单独一层：脚手架里原本写死了 C8T6 的四样东西（startup_stm32f103xb.s、
 * 设备宏 STM32F103xB、链接脚本 STM32F103XX_FLASH.ld、demo.ioc 里的 Mcu.CPN）。
 * 要支持 F1 全系，这四样都得按型号算出来。算它们需要的数据来自三处，缺一不可：
 *
 *   1. 容量档 → 启动文件 / 设备宏 / 设备头 / Flash / RAM：src/data/stm32f1.ts 的 resolveF1Chip
 *      （上游启动文件是实测出来的事实，别在这里再抄一份）。
 *   2. 型号 → CubeMX 的 db/mcu 分组名（Mcu.Name，带括号，例如 STM32F103R(C-D-E)Tx）：
 *      本文件内置分组表，来源是本机 CubeMX db/mcu/*.xml 的真实文件名。
 *   3. 型号 → 工程文件里的名字：具体型号名（STM32F103RCTx）+ _FLASH.ld
 *      —— 和 ST 自己 Projects/<board>/SW4STM32/ 下的链接脚本命名一致（实测
 *      STM32F103RBTx_FLASH.ld / STM32F107VCTx_FLASH.ld）。
 *
 * 两种「名字」必须分清（.ioc 里同时出现，写错 CubeMX 会认不出芯片）：
 *   - ProjectManager.DeviceId = Mcu.UserName = 具体型号名 STM32F103C8Tx
 *   - Mcu.Name = db/mcu 的分组名 STM32F103C(8-B)Tx
 *
 * 本文件只做纯计算与纯渲染（不读盘、不依赖 CubeMX 是否装了），这样能单测。
 */

import { resolveF1Chip, type F1Chip } from "../data/stm32f1.js";

/** HAL 路线不给型号时按蓝丸（STM32F103C8T6）建，与历史行为一致。 */
export const DEFAULT_HAL_MCU = "STM32F103C8T6";

/**
 * 老工程兼容用的链接脚本名。模板里那份是 C8T6 的（64K/20K），
 * 新工程一律另有 <DeviceId>_FLASH.ld；这个旧名只为「已有工程的 cmake 还指着它」而留。
 */
export const LEGACY_LINKER_SCRIPT = "STM32F103XX_FLASH.ld";

/** 模板里写死的 C8T6 事实（渲染时被替换掉；C8T6 本身替换后逐字节不变）。 */
const TEMPLATE_DEVICE_DEFINE = "STM32F103xB";
const TEMPLATE_STARTUP = "startup_stm32f103xb.s";

/** 封装字母 → 引脚数（与 CubeMX db/mcu 的 LQFP48/64/100/144 对应）。 */
const PIN_COUNT_BY_PACKAGE: Readonly<Record<string, number>> = { T: 36, C: 48, R: 64, V: 100, Z: 144 };

/**
 * 型号 → CubeMX db/mcu 分组名用的「容量档分组」表。
 * 键：line（三位数字）→ 封装字母 → 该封装在 db 里真实出现过的分组（升序，靠前的先命中）。
 * 只收 Tx/Ux/Yx 这种带封装后缀的条目；特殊单型号（STM32F103C6Ux、STM32F107VCHx 之类）
 * 走「退回具体型号名」的兜底，不在这里硬编。
 */
const MCU_NAME_GROUPS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  "100": { C: ["4-6", "8-B"], R: ["4-6", "8-B", "C-D-E"], V: ["8-B", "C-D-E"], Z: ["C-D-E"] },
  "101": { C: ["4-6", "8-B"], R: ["4-6", "8-B", "C-D-E", "F-G"], T: ["4-6", "8-B"], V: ["8-B", "C-D-E", "F-G"], Z: ["C-D-E", "F-G"] },
  "102": { C: ["4-6", "8-B"], R: ["4-6", "8-B"] },
  "103": { C: ["4-6", "8-B"], R: ["4-6", "8-B", "C-D-E", "F-G"], T: ["4-6", "8-B"], V: ["8-B", "C-D-E", "F-G"], Z: ["C-D-E", "F-G"] },
  "105": { R: ["8-B-C"], V: ["8-B-C"] },
  "107": { R: ["B-C"], V: ["B-C"] },
};

/** 分组标签 → 它覆盖的容量字母。 */
const GROUP_LETTERS: Readonly<Record<string, readonly string[]>> = {
  "4-6": ["4", "6"],
  "8-B": ["8", "B"],
  "C-D-E": ["C", "D", "E"],
  "F-G": ["F", "G"],
  "B-C": ["B", "C"],
  "8-B-C": ["8", "B", "C"],
};

export interface HalChipFacts {
  /** 归一化后的完整型号，例如 STM32F103RCT6。 */
  readonly mcu: string;
  /** 具体型号名（CubeMX 的 ProjectManager.DeviceId / Mcu.UserName），例如 STM32F103RCTx。 */
  readonly deviceId: string;
  /** db/mcu 分组名（CubeMX 的 Mcu.Name），例如 STM32F103R(C-D-E)Tx。 */
  readonly mcuName: string;
  /** db/mcu 里的封装名，例如 LQFP64。 */
  readonly packageName: string;
  readonly pinCount: number | null;
  readonly startup: string;
  readonly deviceDefine: string;
  readonly deviceHeader: string;
  readonly flashBytes: number;
  readonly ramBytes: number;
  /** 链接脚本文件名（= deviceId + _FLASH.ld）。 */
  readonly linkerScript: string;
  /** 是否还要顺带写旧名 STM32F103XX_FLASH.ld（只有蓝丸 C8T6 需要）。 */
  readonly keepLegacyLinkerScript: boolean;
  /** 需要提醒用户的话（例如 db 里没有分组名、按具体型号名兜底）。 */
  readonly notes: readonly string[];
}

export interface HalChipResolution {
  readonly facts: HalChipFacts | null;
  /** 认不出时的原因（人话）。 */
  readonly reason: string;
}

/** 型号拆解：STM32F103RCT6 → line 103 / 封装 R / 容量 C / 后缀 T / 温度 6。 */
const PART_PATTERN = /^STM32F(\d{3})([A-Z])([0-9A-G])([A-Z])?([0-9])?$/u;

/**
 * 型号 → HAL 路线的芯片事实。
 *
 * 与 resolveF1Chip 的分工：那里回答「启动文件/设备宏/Flash/RAM」，这里再补上
 * 「.ioc 里的名字 + 链接脚本名 + 封装」，并拒绝 HAL 路线没法处理的输入：
 *   - 只给容量档（F103:xb）：定不了封装、引脚与型号名，HAL 路线必须给完整型号；
 *   - RAM 未收录：链接脚本的 RAM 大小不能猜（宁可报错也不生成一个错的内存布局）。
 */
export function resolveHalChip(input?: string): HalChipResolution {
  const raw = (input ?? "").trim();
  const mcu = raw.length === 0 ? DEFAULT_HAL_MCU : raw.toUpperCase();
  const resolved = resolveF1Chip(mcu);
  if (resolved.chip === null) {
    return {
      facts: null,
      reason:
        resolved.reason +
        "。HAL 路线要完整型号（封装字母要写全），例如 STM32F103C8T6 / STM32F103RCT6 / STM32F107VCT6",
    };
  }
  const chip: F1Chip = resolved.chip;
  const parts = PART_PATTERN.exec(mcu);
  if (parts === null) {
    return {
      facts: null,
      reason:
        "HAL 路线要完整型号（带封装字母），例如 STM32F103RCT6；" + mcu +
        " 只给了容量档，定不了 .ioc 里的封装与型号名",
    };
  }
  const code = parts[1] ?? "";
  const packageLetter = parts[2] ?? "";
  const suffixLetter = (parts[4] ?? "").length > 0 ? (parts[4] ?? "") : "T";
  if (suffixLetter !== "T" && suffixLetter !== "U" && suffixLetter !== "Y") {
    return {
      facts: null,
      reason: ".ioc 模板只覆盖 T/U/Y 三种封装后缀，认不出 " + suffixLetter + "：" + mcu,
    };
  }
  const flashBytes = chip.flashBytes;
  if (flashBytes === null) return { facts: null, reason: "认不出 " + mcu + " 的 Flash 大小，链接脚本没法渲染" };
  const ramBytes = chip.ramBytes;
  if (ramBytes === null) {
    return {
      facts: null,
      reason:
        (chip.notes.length > 0 ? chip.notes.join("；") + "；" : "") +
        "链接脚本里的 RAM 大小不能猜：先按 CubeMX 的 db/mcu 补上 " + chip.prefix + chip.densityLetter + " 的 RAM 再建",
    };
  }

  const notes: string[] = [];
  const pinCount = chip.pinCount ?? PIN_COUNT_BY_PACKAGE[packageLetter] ?? null;
  const deviceId = chip.prefix + packageLetter + chip.densityLetter + suffixLetter + "x";
  // db/mcu 的分组名只在「该封装 + 该后缀确实按分组收录」时成立：
  // Tx 全是分组名；Ux 只有 T 封装分组（STM32F103T(8-B)Ux），C 封装是单型号（STM32F103C6Ux）；
  // Yx 只有 R 封装分组（STM32F103R(C-D-E)Yx）。
  const grouped =
    suffixLetter === "T" || (suffixLetter === "U" && packageLetter === "T") || (suffixLetter === "Y" && packageLetter === "R");
  let mcuName = deviceId;
  if (grouped) {
    const groups = MCU_NAME_GROUPS[code]?.[packageLetter] ?? [];
    const hit = groups.find((entry) => (GROUP_LETTERS[entry] ?? []).includes(chip.densityLetter));
    if (hit === undefined) {
      notes.push(
        "CubeMX 的 db/mcu 里没有 " + deviceId + " 这一分组名，Mcu.Name 按具体型号名写（CubeMX 打不开 .ioc 的话把型号换成同容量档的常见型号）",
      );
    } else {
      mcuName = chip.prefix + packageLetter + "(" + hit + ")" + suffixLetter + "x";
    }
  }
  const packageKind = suffixLetter === "U" ? "VFQFPN" : suffixLetter === "Y" ? "WLCSP" : "LQFP";
  const packageName = pinCount === null ? packageKind : packageKind + String(pinCount);

  return {
    facts: {
      mcu,
      deviceId,
      mcuName,
      packageName,
      pinCount,
      startup: chip.startup,
      deviceDefine: chip.deviceDefine,
      deviceHeader: chip.deviceHeader,
      flashBytes,
      ramBytes,
      linkerScript: deviceId + "_FLASH.ld",
      // 旧名只有蓝丸（C8T6 的 64K Flash / 20K RAM）对得上；别的芯片写旧名 = 一份骗人的内存布局。
      keepLegacyLinkerScript: deviceId === "STM32F103C8Tx" && flashBytes === 64 * 1024 && ramBytes === 20 * 1024,
      notes,
    },
    reason: "",
  };
}

/** 一句话说清这款芯片会变成什么（报告/warning 里用）。 */
export function describeHalChip(facts: HalChipFacts): string {
  return (
    facts.mcu + "（" + facts.deviceId + "，" + facts.packageName + "）：启动文件 " + facts.startup +
    "、设备宏 " + facts.deviceDefine + "、链接脚本 " + facts.linkerScript
  );
}

function kiloText(bytes: number): string {
  return String(Math.round(bytes / 1024));
}

/**
 * 链接脚本按芯片渲染。
 *
 * 只改三处（其余 SECTIONS 与芯片无关；F1 全是 RAM 0x20000000 / FLASH 0x08000000）：
 *   - 头注释里的型号名
 *   - 头注释里的 "NKbytes FLASH and MKbytes RAM"
 *   - MEMORY 里的 LENGTH 值
 * 模板缺任何一处都抛错：宁可建不出来，也不生成一个 Flash/RAM 是错的链接脚本。
 */
export function renderLinkerScript(template: string, facts: HalChipFacts): string {
  const flashK = kiloText(facts.flashBytes);
  const ramK = kiloText(facts.ramBytes);
  const abstract = /(\*\*\s+Abstract\s+:\s+Linker script for )[^\r\n]+/u;
  const sizes = /\d+Kbytes FLASH and \d+Kbytes RAM/u;
  const ramLine = /(RAM \(xrw\)[ \t]*:[ \t]*ORIGIN = 0x20000000,[ \t]*LENGTH = )[^\r\n]+/u;
  const flashLine = /(FLASH \(rx\)[ \t]*:[ \t]*ORIGIN = 0x8000000,[ \t]*LENGTH = )[^\r\n]+/u;
  for (const [pattern, what] of [
    [abstract, "Abstract 行（Linker script for …）"],
    [sizes, "『NKbytes FLASH and MKbytes RAM』行"],
    [ramLine, "MEMORY 里的 RAM 行"],
    [flashLine, "MEMORY 里的 FLASH 行"],
  ] as const) {
    if (!pattern.test(template)) {
      throw new Error("链接脚本模板缺 " + what + "，没法按芯片渲染（模板被改过？）");
    }
  }
  let text = template.replace(abstract, (_match: string, head: string) => head + facts.deviceId + " series");
  text = text.replace(sizes, (_match: string) => flashK + "Kbytes FLASH and " + ramK + "Kbytes RAM");
  text = text.replace(ramLine, (_match: string, head: string) => head + ramK + "K");
  text = text.replace(flashLine, (_match: string, head: string) => head + flashK + "K");
  return text;
}

/**
 * .ioc 按芯片渲染：只改这五行，引脚/时钟树沿用模板的最小集（PA13/PA14 SWD + 一个 GPIO）。
 * 缺键就抛错——没把握的 .ioc 宁可不写，写一份 CubeMX 认不出的配置更糟。
 */
export function renderIoc(template: string, facts: HalChipFacts): string {
  const values: ReadonlyArray<readonly [string, string]> = [
    ["Mcu.CPN", facts.mcu],
    ["Mcu.Name", facts.mcuName],
    ["Mcu.Package", facts.packageName],
    ["Mcu.UserName", facts.deviceId],
    ["ProjectManager.DeviceId", facts.deviceId],
  ];
  const eol = template.includes("\r\n") ? "\r\n" : "\n";
  const seen = new Set<string>();
  const lines = template.split(/\r?\n/u).map((line: string) => {
    for (const [key, value] of values) {
      if (line.startsWith(key + "=")) {
        seen.add(key);
        return key + "=" + value;
      }
    }
    return line;
  });
  const missing = values.map(([key]) => key).filter((key) => !seen.has(key));
  if (missing.length > 0) {
    throw new Error(".ioc 模板缺这些键：" + missing.join("、") + "（模板被改过？）");
  }
  return lines.join(eol);
}

/** 工具链 cmake 文件里的 -T 指向渲染后的链接脚本名。 */
export function pointLinkerFlagAt(text: string, facts: HalChipFacts): string {
  if (!text.includes(LEGACY_LINKER_SCRIPT)) {
    throw new Error("工具链 cmake 文件里找不到 -T …" + LEGACY_LINKER_SCRIPT + "（模板被改过？）");
  }
  return text.split(LEGACY_LINKER_SCRIPT).join(facts.linkerScript);
}

/** cmake/stm32cubemx/CMakeLists.txt 里的设备宏与启动文件名按芯片替换。 */
export function renderStartupAndDefine(text: string, facts: HalChipFacts): string {
  if (!text.includes(TEMPLATE_DEVICE_DEFINE) || !text.includes(TEMPLATE_STARTUP)) {
    throw new Error(
      "cmake/stm32cubemx/CMakeLists.txt 里找不到 " + TEMPLATE_DEVICE_DEFINE + " 或 " + TEMPLATE_STARTUP + "（模板被改过？）",
    );
  }
  return text.split(TEMPLATE_DEVICE_DEFINE).join(facts.deviceDefine).split(TEMPLATE_STARTUP).join(facts.startup);
}
