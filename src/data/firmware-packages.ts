/**
 * 固件包（STM32Cube_FW_<族>_V<版本>）的组装清单。
 *
 * 背景（2026-10 实测，见 docs §14）：ST 的固件包不是整体下载的，GitHub 上的 STM32Cube<族>
 * 主仓库把 HAL 驱动与 CMSIS 设备支持都挂成了 git 子模块 —— 只拉主仓库 tarball，
 * Drivers/STM32F1xx_HAL_Driver 与 Drivers/CMSIS/Device/ST/STM32F1xx 是**空目录**，
 * 编译必挂。所以要分别拉：
 *   ① HAL 驱动仓库（stm32f1xx-hal-driver）→ Drivers/STM32F1xx_HAL_Driver/{Inc,Src}
 *   ② CMSIS 设备仓库（cmsis-device-f1）  → Drivers/CMSIS/Device/ST/STM32F1xx/{Include,Source}
 *   ③ CMSIS 内核头（STM32CubeF1 主仓库 Drivers/CMSIS/Include 下的 5 个头文件，逐个拉）
 * 然后自己补一个 257 字节的 package.xml —— 实测 CubeMX 认这种手工组装的包（docs §14）。
 *
 * 只登记实测过的一代：F1。其它代按同样字段补一条即可（repo 名、目录名、内核头不同）。
 */

import { existsSync, readdirSync } from "node:fs";
import type { FetchTarget } from "../engine/fetch.js";
import { sourceUrls } from "./cmsis-sources.js";

export interface FirmwareArchiveSpec {
  /** 归档短名（日志与临时文件名）：hal / device。 */
  id: string;
  label: string;
  repo: string;
  ref: string;
  /** 归档内要的顶层目录 → 包内目标目录（都相对仓库根 / 包根，正斜杠）。 */
  dirs: { from: string; to: string }[];
  /** 多条候选下载地址，顺序 = 优先级。 */
  urls: string[];
}

export interface FirmwareFamilySpec {
  family: string;
  /** 包名前缀：STM32Cube_FW_F1。 */
  packageBase: string;
  /** 默认版本（不带 V）：1.8.7。 */
  defaultVersion: string;
  /** 包内 HAL 驱动目录（相对包根）：Drivers/STM32F1xx_HAL_Driver。 */
  halDir: string;
  /** 包内设备支持目录（相对包根）：Drivers/CMSIS/Device/ST/STM32F1xx。 */
  deviceDir: string;
  /** CMSIS 内核头所在仓库（主仓库，不是子模块）。 */
  coreRepo: string;
  coreRef: string;
  /** 主仓库里内核头的目录：Drivers/CMSIS/Include。 */
  coreIncludeDir: string;
  /** 这一代必须的内核头文件。 */
  coreHeaders: string[];
  archives: FirmwareArchiveSpec[];
}

/** codeload 直连是首选；GHProxy 走镜像；api.github.com 的 tarball 会 302 到 codeload，作最后兜底。 */
function archiveUrls(repo: string, ref: string): string[] {
  return [
    "https://codeload.github.com/STMicroelectronics/" + repo + "/tar.gz/refs/heads/" + ref,
    "https://ghproxy.net/https://github.com/STMicroelectronics/" + repo + "/archive/refs/heads/" + ref + ".tar.gz",
    "https://api.github.com/repos/STMicroelectronics/" + repo + "/tarball/refs/heads/" + ref,
  ];
}

export const FIRMWARE_FAMILIES: Readonly<Record<string, FirmwareFamilySpec>> = {
  F1: {
    family: "F1",
    packageBase: "STM32Cube_FW_F1",
    defaultVersion: "1.8.7",
    halDir: "Drivers/STM32F1xx_HAL_Driver",
    deviceDir: "Drivers/CMSIS/Device/ST/STM32F1xx",
    coreRepo: "STM32CubeF1",
    coreRef: "master",
    coreIncludeDir: "Drivers/CMSIS/Include",
    coreHeaders: ["core_cm3.h", "cmsis_compiler.h", "cmsis_gcc.h", "cmsis_version.h", "mpu_armv7.h"],
    archives: [
      {
        id: "hal",
        label: "HAL 驱动（stm32f1xx-hal-driver）",
        repo: "stm32f1xx-hal-driver",
        ref: "master",
        dirs: [
          { from: "Inc", to: "Drivers/STM32F1xx_HAL_Driver/Inc" },
          { from: "Src", to: "Drivers/STM32F1xx_HAL_Driver/Src" },
        ],
        urls: archiveUrls("stm32f1xx-hal-driver", "master"),
      },
      {
        id: "device",
        label: "CMSIS 设备支持（cmsis-device-f1）",
        repo: "cmsis-device-f1",
        ref: "master",
        dirs: [
          { from: "Include", to: "Drivers/CMSIS/Device/ST/STM32F1xx/Include" },
          { from: "Source", to: "Drivers/CMSIS/Device/ST/STM32F1xx/Source" },
        ],
        urls: archiveUrls("cmsis-device-f1", "master"),
      },
    ],
  },
};

/** 从型号（STM32F103C8T6）或族名（F1）里认族；认不出返回空串。 */
export function firmwareFamilyOf(text: string): string {
  const raw = text.trim().toUpperCase();
  if (raw in FIRMWARE_FAMILIES) return raw;
  const match = /^STM32([A-Z])(\d)/u.exec(raw);
  if (match === null) return "";
  const family = (match[1] ?? "") + (match[2] ?? "");
  return family in FIRMWARE_FAMILIES ? family : "";
}

/** 版本串规则（实测 ST 真包）：1.8.7 → Release FW.F1.1.8.0 / Patch FW.F1.1.8.7。 */
export function firmwareVersionTags(family: string, version: string): { release: string; patch: string } {
  const parts = version.split(".");
  const a = parts[0] ?? "0";
  const b = parts[1] ?? "0";
  const c = parts[2] ?? "0";
  return { release: "FW." + family + "." + a + "." + b + ".0", patch: "FW." + family + "." + a + "." + b + "." + c };
}

/** package.xml 全文：真包就 257 字节这么多，CubeMX 不看哈希也不校验来源。 */
export function packageXmlText(tags: { release: string; patch: string }): string {
  return [
    '<?xml version="1.0" encoding="ISO-8859-1" standalone="no"?>',
    '<Package DBVersion="2.0">',
    '  <PackDescription Release="' + tags.release + '" Patch="' + tags.patch + '">',
    '    <Note Release="ReleaseNotes.html" Patch="ReleaseNotes_Patch.html"/>',
    "  </PackDescription>",
    "</Package>",
    "",
  ].join("\n");
}

export interface FirmwarePackagePlan {
  ok: boolean;
  error: string;
  family: string;
  /** 不带 V：1.8.7。 */
  version: string;
  /** STM32Cube_FW_F1。 */
  packageBase: string;
  /** STM32Cube_FW_F1_V1.8.7（CubeMX 认的目录名）。 */
  dirName: string;
  releaseTag: string;
  patchTag: string;
  packageXml: string;
  halDir: string;
  deviceDir: string;
  archives: FirmwareArchiveSpec[];
  /** CMSIS 内核头（逐个下到 Drivers/CMSIS/Include）。 */
  coreTargets: FetchTarget[];
  /** 写进包的第三方声明。 */
  license: string;
}

function emptyPlan(error: string, family = "", version = ""): FirmwarePackagePlan {
  return {
    ok: false,
    error,
    family,
    version,
    packageBase: "",
    dirName: "",
    releaseTag: "",
    patchTag: "",
    packageXml: "",
    halDir: "",
    deviceDir: "",
    archives: [],
    coreTargets: [],
    license: "",
  };
}

/** 组一代固件包的下载/组装计划。纯计算，不碰磁盘也不联网。 */
export function firmwarePlanFor(request: { family?: string; mcu?: string; version?: string }): FirmwarePackagePlan {
  const hint = request.family ?? request.mcu ?? "";
  if (hint.trim() === "") return emptyPlan("没说清要哪一代的固件包：给 family（例如 F1）或 mcu（例如 STM32F103C8T6）");
  const family = firmwareFamilyOf(hint);
  if (family === "") {
    const known = Object.keys(FIRMWARE_FAMILIES).join("、");
    return emptyPlan("插件还不会给 " + hint.trim() + " 自动组装固件包（目前只会：" + known + "）。可以在 CubeMX 的包管理器里装，见 guides 里的手动安装步骤。");
  }
  const spec = FIRMWARE_FAMILIES[family];
  if (spec === undefined) return emptyPlan("插件里没有 " + family + " 的固件包清单");
  const version = (request.version ?? spec.defaultVersion).replace(/^[Vv]/u, "");
  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    return emptyPlan("版本号格式不对：" + version + "（要 1.8.7 这种三段式）", family);
  }
  const tags = firmwareVersionTags(family, version);
  const dirName = spec.packageBase + "_V" + version;
  const coreTargets: FetchTarget[] = spec.coreHeaders.map((header) => ({
    path: header,
    urls: sourceUrls(spec.coreRepo, spec.coreRef, spec.coreIncludeDir + "/" + header),
    minBytes: 500,
  }));
  const license = [
    "# 第三方声明",
    "",
    "本目录是 STM32 固件包的**手工组装件**，由 dsh-stm32 从 GitHub 公开仓库下载拼装而成，",
    "不是 ST 官方发布的安装包。各部分的许可如下：",
    "",
    "- HAL 驱动（stm32f1xx-hal-driver）：ST 发布，BSD-3-Clause（见 ST 原文 LICENSE.md）。",
    "- CMSIS 设备支持（cmsis-device-f1）：Apache-2.0。",
    "- CMSIS 内核头（STM32CubeF1 / Drivers/CMSIS/Include）：Apache-2.0。",
    "",
    "CubeMX 认这个目录（实测），但 ST 的包管理器不会维护它：要升级请用 CubeMX 包管理器重装官方包。",
    "",
  ].join("\n");
  return {
    ok: true,
    error: "",
    family,
    version,
    packageBase: spec.packageBase,
    dirName,
    releaseTag: tags.release,
    patchTag: tags.patch,
    packageXml: packageXmlText(tags),
    halDir: spec.halDir,
    deviceDir: spec.deviceDir,
    archives: spec.archives,
    coreTargets,
    license,
  };
}

function hasFiles(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/** 目录里有没有 startup_*.s（启动文件按容量档分好几个，有一个就够）。 */
function hasStartup(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => /^startup_.*\.s$/iu.test(name));
  } catch {
    return false;
  }
}

export interface FirmwareVerifyCheck {
  label: string;
  /** 检查的绝对路径（或目录）。 */
  path: string;
  ok: boolean;
}

export interface FirmwareVerifyResult {
  ok: boolean;
  checks: FirmwareVerifyCheck[];
  /** 缺什么（给卡片上的一句人话）。 */
  missing: string[];
}

/**
 * 三条判据（与 scaffold.ts 的 resolveFirmwareRoot 一致，多加一条 startup 检查）：
 *   ① Drivers/CMSIS/Include 有内核头   ② Drivers/<族>_HAL_Driver 有 Inc 与 Src
 *   ③ Drivers/CMSIS/Device/ST/<族>/{Include,Source/Templates/gcc/startup_*.s}
 * 为什么必须自查：CubeMX 找不到包时**不报错**（docs §14），只看它打印 Code succesfully generated 会被骗。
 */
export function verifyFirmwarePackage(root: string, family: string): FirmwareVerifyResult {
  const spec = FIRMWARE_FAMILIES[family];
  const checks: FirmwareVerifyCheck[] = [];
  if (spec === undefined) {
    return { ok: false, checks, missing: ["插件里没有 " + family + " 的固件包清单"] };
  }
  const join = (rel: string): string => root.replace(/[\\/]+$/u, "") + "/" + rel;

  const cmsisDir = join("Drivers/CMSIS/Include");
  checks.push({
    label: "CMSIS 内核头",
    path: cmsisDir,
    ok: spec.coreHeaders.every((header) => existsSync(join("Drivers/CMSIS/Include/" + header))),
  });

  const halInc = join(spec.halDir + "/Inc");
  const halSrc = join(spec.halDir + "/Src");
  checks.push({ label: "HAL 驱动 Inc", path: halInc, ok: hasFiles(halInc) });
  checks.push({ label: "HAL 驱动 Src", path: halSrc, ok: hasFiles(halSrc) });

  const deviceInclude = join(spec.deviceDir + "/Include");
  checks.push({ label: "设备头 Include", path: deviceInclude, ok: hasFiles(deviceInclude) });

  const templateDir = join(spec.deviceDir + "/Source/Templates/gcc");
  checks.push({ label: "启动文件（gcc）", path: templateDir, ok: hasStartup(templateDir) });

  const missing = checks.filter((check) => !check.ok).map((check) => check.label);
  return { ok: missing.length === 0, checks, missing };
}
/* ---------------------------- 找包 / 认包 ---------------------------- */

/** 插件在 CubeMX 安装根里自建的固件包目录（与 Repository 并列，绝不动 Repository）。 */
export const DSH_FIRMWARE_DIR_NAME = "dsh-firmware";

/** <cubeMxRoot>/dsh-firmware（正斜杠，去掉根尾部斜杠）。 */
export function dshFirmwareDir(cubeMxRoot: string): string {
  const base = cubeMxRoot.trim().split("\\").join("/").replace(/\/+$/u, "");
  return base + "/" + DSH_FIRMWARE_DIR_NAME;
}

export interface FirmwareNeed {
  /** 认出来的族（F1）；认不出是空串。 */
  family: string;
  /** 不带 V 的版本（1.8.7）；认不出是空串。 */
  version: string;
  /** STM32Cube_FW_F1_V1.8.7；认不出是空串。 */
  packageName: string;
}

/**
 * 从 .ioc 正文里读它要哪个固件包。
 * 首选 ProjectManager.FirmwarePackage=STM32Cube FW_F1 V1.8.7；
 * 缺这一条时退回 Mcu.CPN 推族 + 该族默认版本。
 */
export function firmwareNeedFromIoc(text: string): FirmwareNeed {
  const packaged = /ProjectManager\.FirmwarePackage\s*=\s*STM32Cube\s+FW_([A-Za-z]\d)\s+[Vv]?([0-9][0-9.]*)/u.exec(text);
  if (packaged !== null) {
    const family = (packaged[1] ?? "").toUpperCase();
    const version = (packaged[2] ?? "").replace(/\.+$/u, "");
    if (family !== "" && version !== "") {
      return { family, version, packageName: "STM32Cube_FW_" + family + "_V" + version };
    }
  }
  const mcu = /(?:Mcu\.CPN|Mcu\.Name)\s*=\s*(STM32[A-Za-z0-9]+)/u.exec(text);
  if (mcu !== null) {
    const family = firmwareFamilyOf(mcu[1] ?? "");
    const spec = family === "" ? undefined : FIRMWARE_FAMILIES[family];
    if (spec !== undefined) {
      return { family, version: spec.defaultVersion, packageName: spec.packageBase + "_V" + spec.defaultVersion };
    }
  }
  return { family: "", version: "", packageName: "" };
}

/**
 * 不认具体族也能判「这目录像个固件包」：CMSIS 内核头 + 至少一个 HAL 驱动的 Src。
 * 用在找包上（G4/H7 这类插件还没有清单的族也照样能找到官方包）。
 */
export function looksLikeFirmwarePackage(root: string): boolean {
  const dir = root.trim().replace(/[\\/]+$/u, "");
  const driversDir = dir + "/Drivers";
  if (!existsSync(driversDir + "/CMSIS/Include")) return false;
  let names: string[];
  try {
    names = readdirSync(driversDir);
  } catch {
    return false;
  }
  return names.some((name) => /_HAL_Driver$/u.test(name) && existsSync(driversDir + "/" + name + "/Src"));
}

export type FirmwarePackageSource = "repository" | "dsh-firmware" | "";

export interface FirmwareLocation {
  found: boolean;
  /** 包根目录（正斜杠）；没找到是空串。 */
  dir: string;
  /** STM32Cube_FW_F1_V1.8.7；没找到时回显要的那一个。 */
  packageName: string;
  family: string;
  /** 找到的那份是谁的地盘。 */
  source: FirmwarePackageSource;
  /** 找过的目录（给卡片上的一句人话）。 */
  checked: string[];
}

/**
 * 在 CubeMX 根下找 .ioc 要的固件包。两处都找：Repository（官方）与 dsh-firmware（插件组装）。
 * 排序：包名精确匹配最优先 → 版本号大的 → 同版本优先 Repository。
 * 为什么两处都找：官方包零拷贝直接用；没有官方包时才用我们组装的那份。
 */
export function locateFirmwarePackage(
  cubeMxRoots: readonly string[],
  request: { packageName?: string; family?: string } = {},
): FirmwareLocation {
  const wanted = (request.packageName ?? "").trim();
  const family = (request.family ?? "").trim().toUpperCase();
  const checked: string[] = [];
  const found: { dir: string; dirName: string; source: FirmwarePackageSource }[] = [];
  for (const root of cubeMxRoots) {
    const base = root.trim().replace(/[\\/]+$/u, "");
    if (base === "") continue;
    const bases: { source: FirmwarePackageSource; dir: string }[] = [
      { source: "repository", dir: base + "/Repository" },
      { source: "dsh-firmware", dir: dshFirmwareDir(base) },
    ];
    for (const candidate of bases) {
      checked.push(candidate.dir);
      let names: string[];
      try {
        names = readdirSync(candidate.dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!/^STM32Cube_FW_[A-Za-z0-9]+_V[0-9.]+$/u.test(name)) continue;
        if (family !== "" && !name.startsWith("STM32Cube_FW_" + family + "_")) continue;
        const dir = candidate.dir + "/" + name;
        if (!looksLikeFirmwarePackage(dir)) continue;
        found.push({ dir, dirName: name, source: candidate.source });
      }
    }
  }
  const ranked = found.sort((left, right) => {
    const leftExact = wanted !== "" && left.dirName === wanted ? 1 : 0;
    const rightExact = wanted !== "" && right.dirName === wanted ? 1 : 0;
    if (leftExact !== rightExact) return rightExact - leftExact;
    const leftVersion = left.dirName.replace(/^.*_V/u, "");
    const rightVersion = right.dirName.replace(/^.*_V/u, "");
    if (leftVersion !== rightVersion) return rightVersion.localeCompare(leftVersion, "en", { numeric: true });
    if (left.source !== right.source) return left.source === "repository" ? -1 : 1;
    return 0;
  });
  const best = ranked[0];
  if (best === undefined) {
    return { found: false, dir: "", packageName: wanted, family, source: "", checked };
  }
  return { found: true, dir: best.dir, packageName: best.dirName, family, source: best.source, checked };
}
