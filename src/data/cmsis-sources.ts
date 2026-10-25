/**
 * CMSIS / 设备头 / 启动文件的下载清单。
 *
 * 为什么从网上拉而不是打进插件（用户 2026-10-24 决定）：插件要能覆盖任意 STM32，
 * 每颗芯片的 startup + 设备头 + CMSIS 内核头都打一份进 npm 包，包会大到不可用。
 * 这些都是 Apache-2.0 的 ST/ARM 公开源码，第一次用时拉到缓存目录，之后复用。
 *
 * 每个文件给多条候选 URL（见 fetch.ts：raw.githubusercontent 在有些网络里不通）。
 */

import type { FetchTarget } from "../engine/fetch.js";

const JS_DELIVR_FASTLY = (repo: string, ref: string, file: string): string =>
  "https://fastly.jsdelivr.net/gh/STMicroelectronics/" + repo + "@" + ref + "/" + file;
const JS_DELIVR_CDN = (repo: string, ref: string, file: string): string =>
  "https://cdn.jsdelivr.net/gh/STMicroelectronics/" + repo + "@" + ref + "/" + file;
const RAW_GITHUB = (repo: string, ref: string, file: string): string =>
  "https://raw.githubusercontent.com/STMicroelectronics/" + repo + "/" + ref + "/" + file;
const GHPROXY = (repo: string, ref: string, file: string): string =>
  "https://ghproxy.net/https://raw.githubusercontent.com/STMicroelectronics/" + repo + "/" + ref + "/" + file;

/** 一个文件的多条下载路线，顺序 = 优先级（实测 jsDelivr 最稳，raw 兜底）。 */
export function sourceUrls(repo: string, ref: string, file: string): string[] {
  return [JS_DELIVR_FASTLY(repo, ref, file), JS_DELIVR_CDN(repo, ref, file), RAW_GITHUB(repo, ref, file), GHPROXY(repo, ref, file)];
}

export interface CmsisFamilySpec {
  /** 芯片族，例如 F1。 */
  family: string;
  /** 设备头所在的仓库（ST 的 cmsis-device-* 仓库）。 */
  deviceRepo: string;
  deviceRef: string;
  /** 设备头目录（相对仓库根），例如 Include。 */
  deviceIncludeDir: string;
  /** 设备仓库里 Source/Templates 的目录。 */
  deviceTemplatesDir: string;
  /** CMSIS 内核头所在的仓库（ST 的 STM32Cube<族> 主仓库，内核头在主仓里而不是子模块）。 */
  cmsisRepo: string;
  cmsisRef: string;
  coreIncludeDir: string;
  /** 这一代用哪个内核头（core_cm3.h 等）。 */
  coreHeader: string;
  /** 设备头文件（不含 startup）：umbrella + system 头。 */
  deviceHeaders: string[];
  /** 设备宏前缀，例如 STM32F1 → STM32F1xx。 */
  deviceDefinePrefix: string;
}

/**
 * 目前验证过的一代：F1（2026-10 实测 10 个文件全部 200 + 大小，见 docs §12）。
 * 其它代按同样字段补一条即可（数据驱动，不改代码）。
 */
export const CMSIS_FAMILIES: Readonly<Record<string, CmsisFamilySpec>> = {
  F1: {
    family: "F1",
    deviceRepo: "cmsis-device-f1",
    deviceRef: "master",
    deviceIncludeDir: "Include",
    deviceTemplatesDir: "Source/Templates",
    cmsisRepo: "STM32CubeF1",
    cmsisRef: "master",
    coreIncludeDir: "Drivers/CMSIS/Include",
    coreHeader: "core_cm3.h",
    deviceHeaders: ["stm32f1xx.h", "system_stm32f1xx.h"],
    deviceDefinePrefix: "STM32F1",
  },
};

/**
 * F1 各容量档对应的启动文件、设备宏与设备头。
 *
 * 这里只有三档，因为 ST 上游就只提供三个文件（2026-10 实测 jsDelivr 上的真实文件名，
 * 探测 <x8 / <xC / <xD 三种写法都是 404）：
 *   x6（小容量 32 KiB）      → startup_stm32f103x6.s + STM32F103x6 + stm32f103x6.h
 *   x8 / xB（中容量 64/128KiB）→ startup_stm32f103xb.s + STM32F103xB + stm32f103xb.h
 *   xC / xD / xE（大容量）    → startup_stm32f103xe.s + STM32F103xE + stm32f103xe.h
 * 蓝丸 C8T6 的 64 KiB 属中容量：型号里的容量字母是 8，但要用 xB 的那套文件。
 */
const F1_STARTUP_BY_DENSITY: Readonly<Record<string, { startup: string; define: string; header: string }>> = {
  "6": { startup: "startup_stm32f103x6.s", define: "STM32F103x6", header: "stm32f103x6.h" },
  "8": { startup: "startup_stm32f103xb.s", define: "STM32F103xB", header: "stm32f103xb.h" },
  B: { startup: "startup_stm32f103xb.s", define: "STM32F103xB", header: "stm32f103xb.h" },
  C: { startup: "startup_stm32f103xe.s", define: "STM32F103xE", header: "stm32f103xe.h" },
  D: { startup: "startup_stm32f103xe.s", define: "STM32F103xE", header: "stm32f103xe.h" },
  E: { startup: "startup_stm32f103xe.s", define: "STM32F103xE", header: "stm32f103xe.h" },
};

export interface StartupChoice {
  family: string;
  /** 启动文件名（不含目录），例如 startup_stm32f103xb.s。 */
  startup: string;
  /** 设备宏，例如 STM32F103xB。 */
  define: string;
  /** 具体型号头文件，例如 stm32f103xb.h。 */
  deviceHeader: string;
}

/**
 * 从型号（或直接给容量档）推出启动文件与设备宏。
 *
 * STM32F103C8T6 → 容量档 8 → startup_stm32f103x8.s；STM32F103CBT6 → B → startup_stm32f103xb.s。
 * 认不出就返回 null：宁可明说"这一代还没做"，也不要编一个文件名让链接器报一堆奇怪错误。
 */
export function startupChoiceFor(mcu: string): StartupChoice | null {
  const text = mcu.trim().toUpperCase();
  const f103 = /^STM32F103([A-Z])([68BCDE])/u.exec(text);
  if (f103 !== null) {
    const density = f103[2] ?? "";
    const choice = F1_STARTUP_BY_DENSITY[density];
    if (choice === undefined) return null;
    return { family: "F1", startup: choice.startup, define: choice.define, deviceHeader: choice.header };
  }
  // 只给容量档（例如 F1:B）时也认，方便测试与脚本。
  const loose = /^F1:([68BCDE])$/u.exec(text);
  if (loose !== null) {
    const key = loose[1] ?? "";
    const choice = F1_STARTUP_BY_DENSITY[key];
    if (choice === undefined) return null;
    return { family: "F1", startup: choice.startup, define: choice.define, deviceHeader: choice.header };
  }
  return null;
}

export interface CmsisTemplatePlan {
  family: string;
  /** 缓存条目 id，例如 cmsis:F1:startup_stm32f103xb。 */
  id: string;
  /** 条目在缓存根下的相对目录，例如 F1/startup_stm32f103xb。 */
  dirName: string;
  choice: StartupChoice;
  /** 要落盘的文件（目标路径按 ST 固件包的 Drivers/CMSIS 布局摆）。 */
  targets: FetchTarget[];
  /** 许可证说明（写进缓存条目的 THIRD_PARTY_NOTICES.md）。 */
  license: string;
}

/**
 * 组装一代/一档模板的下载计划：路径全部按 ST 固件包布局摆，
 * 寄存器版工程直接 -I Drivers/CMSIS/Include -I Drivers/CMSIS/Device/ST/STM32F1xx/Include 就能编译，
 * 与 HAL 工程共用同一套 include 约定。
 */
export function cmsisTemplatePlan(choice: StartupChoice): CmsisTemplatePlan | null {
  const spec = CMSIS_FAMILIES[choice.family];
  if (spec === undefined) return null;
  const familyDir = spec.deviceDefinePrefix + "xx";
  const deviceBase = "Drivers/CMSIS/Device/ST/" + familyDir;
  const targets: FetchTarget[] = [];

  // 1) 设备头：umbrella + system 头 + 具体型号头
  for (const header of spec.deviceHeaders) {
    targets.push({
      path: deviceBase + "/Include/" + header,
      urls: sourceUrls(spec.deviceRepo, spec.deviceRef, spec.deviceIncludeDir + "/" + header),
      minBytes: 200,
    });
  }
  targets.push({
    path: deviceBase + "/Include/" + choice.deviceHeader,
    urls: sourceUrls(spec.deviceRepo, spec.deviceRef, spec.deviceIncludeDir + "/" + choice.deviceHeader),
    minBytes: 10_000,
  });

  // 2) system_stm32f1xx.c 与启动文件
  targets.push({
    path: deviceBase + "/Source/Templates/system_stm32f1xx.c",
    urls: sourceUrls(spec.deviceRepo, spec.deviceRef, spec.deviceTemplatesDir + "/system_stm32f1xx.c"),
    minBytes: 1_000,
  });
  targets.push({
    path: deviceBase + "/Source/Templates/gcc/" + choice.startup,
    urls: sourceUrls(spec.deviceRepo, spec.deviceRef, spec.deviceTemplatesDir + "/gcc/" + choice.startup),
    minBytes: 1_000,
  });

  // 3) CMSIS 内核头（ST 主仓库里就有，不是子模块）
  for (const header of [spec.coreHeader, "cmsis_compiler.h", "cmsis_gcc.h", "cmsis_version.h", "mpu_armv7.h"]) {
    targets.push({
      path: "Drivers/CMSIS/Include/" + header,
      urls: sourceUrls(spec.cmsisRepo, spec.cmsisRef, spec.coreIncludeDir + "/" + header),
      minBytes: 500,
    });
  }

  const license =
    "STMicroelectronics CMSIS device headers / startup / CMSIS core headers — Apache License 2.0."
    + "\n来源仓库：github.com/STMicroelectronics/" + spec.deviceRepo + "（" + spec.deviceRef + "）、"
    + "github.com/STMicroelectronics/" + spec.cmsisRepo + "（" + spec.cmsisRef + "）。"
    + "\n本目录是下载缓存，不是插件源码；删掉它不影响插件，下次用时会重新下载。\n";

  const stem = choice.startup.replace(/\.s$/u, "");
  return {
    family: choice.family,
    id: "cmsis:" + choice.family + ":" + stem,
    dirName: choice.family + "/" + stem,
    choice,
    targets,
    license,
  };
}
