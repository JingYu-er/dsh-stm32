/**
 * L2：从零建工程骨架。
 *
 * 为什么需要它：CubeMX 的脚本模式**只产 Core/ 下的 C 源**（实测 E1–E4，见规格书 §8.3），
 * 不产 CMakeLists.txt / cmake\** / startup / .ld / Drivers / .vscode。
 * 所以"空目录 → 一条命令出工程"必须由插件补脚手架，而脚手架只能**复刻、不发明**（规格 §7 C1/C6）：
 *
 * - CMake 工程文件、链接脚本、.vscode、.ioc 模板：随插件下发的**模板快照**
 *   （来源 = 同版本 CubeMX GUI 真实生成的工程，逐字节原样，只替换工程名）；
 * - Drivers/**、startup_*.s、system_stm32f1xx.c：从本机 CubeMX 固件包
 *   `<cubeRoot>/Repository/STM32Cube_FW_F1_<ver>` **原样复制**（实测与 GUI 工程逐字节一致）。
 *
 * 产物里没有 .mxproject：那是 GUI 独有的工程元数据，插件不伪造（伪造成本高低不平、还容易和 .ioc 不一致）。
 *
 * 覆盖（overwrite=true）是**破坏性**操作，所以这里的顺序是硬规定：
 *   先判能不能写（preflightTarget）→ 再把将被覆盖的同名文件备份（backupBeforeOverwrite）
 *   → 备份成功才开始写；备份失败就一个字节都不写。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DSH_FIRMWARE_DIR_NAME, type FirmwareExtraDir } from "../data/firmware-packages.js";
import { firmwareExtraDirs } from "./firmware-install.js";
import { copyFileLong, copyTreeLong, mkdirTrackedLong } from "./fs-longpath.js";
import {
  describeHalChip,
  LEGACY_LINKER_SCRIPT,
  pointLinkerFlagAt,
  renderIoc,
  renderCmakeLists,
  renderLinkerScript,
  renderOpenocdTarget,
  renderStartupAndDefine,
  resolveHalChip,
  type HalChipFacts,
} from "./hal-chip.js";
import { describeDroppedPlaceholder, detectVscodeFill, fillVscodeTemplate } from "./vscode-config.js";
import { readLocalManifest } from "./assets.js";
import { bundledOpenocdConfig, familyProfileOf } from "../data/family.js";

export const DEFAULT_FIRMWARE_PACKAGE = "STM32Cube_FW_F1_V1.8.7";
export const SCAFFOLD_PROJECT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * 工程内的状态目录名。这里自己写一份常量而不是 import generate.ts 的 STATE_DIR：
 * 两个引擎互不依赖（避免 generate → scaffold 的循环），改名时以 ioc-plan / code-patch 的约定为准。
 */
const STATE_DIR = ".dsh-stm32";

export interface ScaffoldRequest {
  targetDir: string;
  projectName?: string;
  /**
   * 芯片型号（HAL 路线必给的"具体型号"，例如 STM32F103RCT6）。
   * 缺省按 DEFAULT_HAL_MCU（STM32F103C8T6）建，与加参数之前的行为一致。
   */
  mcu?: string;
  firmwarePackage?: string;
  cubeMxRoots?: string[];
  /** 目标目录已有文件时是否继续（默认 false，宁可拒绝也不覆盖别人的工程）。 */
  overwrite?: boolean;
  /**
   * 找 gdb / cmake 用的目录（配置里的 binDirs 或 msys64 推导出来的）。
   * 只影响 .vscode 模板的填充：模板里的路径占位符按这里探测，探不到就整行删掉。
   */
  binDirs?: string[];
}

export interface ScaffoldReport {
  ok: boolean;
  targetDir: string;
  projectName: string;
  iocPath: string;
  firmwareRoot?: string;
  templateDir: string;
  templateFiles: number;
  driverFiles: number;
  durationMs: number;
  warnings: string[];
  message: string;
  /** 这次按哪款芯片建的（归一化后的完整型号）。 */
  mcu?: string;
  /** 从固件包拷进来的启动文件，例如 startup_stm32f103xe.s。 */
  startup?: string;
  /** 工程里用的设备宏，例如 STM32F103xE。 */
  deviceDefine?: string;
  /** 按芯片命名并渲染的链接脚本，例如 STM32F103RCTx_FLASH.ld。 */
  linkerScript?: string;
}

/** 模板目录随插件走：lib/engine/scaffold.js → ../../templates/scaffold。 */
export function templateDir(): string {
  return fileURLToPath(new URL("../../templates/scaffold/", import.meta.url));
}

/**
 * 模板目录里**不算工程文件**的东西：本地在 templates/scaffold 里跑过一次 cmake
 * 就会留下 build/（CMakeCache、CompilerId 之类），它们既不该被拷进新工程，
 * 也不该被当作"工程文件"计数——否则 scaffold 出来的工程会带着别人的构建缓存。
 */
const TEMPLATE_SKIP_PREFIXES = ["build/"];

function listFiles(root: string, skipPrefixes: string[] = []): string[] {
  const out: string[] = [];
  const walk = (dir: string, relDir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = relDir === "" ? entry.name : relDir + "/" + entry.name;
      if (entry.isDirectory()) {
        if (skipPrefixes.some((prefix) => (rel + "/").startsWith(prefix))) continue;
        walk(path.join(dir, entry.name), rel);
      } else {
        out.push(path.join(dir, entry.name));
      }
    }
  };
  walk(root, "");
  return out;
}

/**
 * 固件包里**不拷**的东西（相对 Drivers/）。实测固件包 Drivers 有 5392 个文件、31 s 拷完，
 * 其中 4493 个是 CMSIS 文档站（docs/）、DSP/NN 示例与自测套件、BSP 板级组件——
 * 这些对"给 F1 CMake 工程编译 HAL"没有任何作用，只让工程变大、scaffold 变慢。
 */
const DRIVER_SKIP_PREFIXES = [
  "CMSIS/docs/",
  "CMSIS/DSP/Examples/",
  "CMSIS/DSP/DSP_Lib_TestSuite/",
  "CMSIS/DSP/Projects/",
  "CMSIS/NN/Examples/",
  "CMSIS/NN/NN_Lib_Tests/",
  "BSP/",
];

/**
 * mkdir -p，同时记下**这次真正新建**的目录。
 * 为什么要记：写盘中途失败时要清掉半成品目录，而"清"必须精确到本次新建的，
 * 用户原有的目录一个都不能动（递归删用户目录 = 把审计里的丢数据问题换个地方重演）。
 */
export function mkdirTracked(dir: string, created: string[]): void {
  // 实现搬到了 fs-longpath（那里要处理 \\?\ 前缀，且复制树也要用它）。
  // 这里留这个名字是因为 register-template 与备份/写盘都在用；改名只会制造无谓的改动面。
  mkdirTrackedLong(dir, created);
}

/**
 * 写盘失败后的收尾：
 * - 目标目录是本次新建的 → 整棵删掉（里面只可能有本次写的文件）；
 * - 目标目录本来就有 → 只删本次新建且现在仍是空的目录，**绝不递归删**（用户文件一个都不碰）。
 */
export function cleanupAfterFailure(targetDir: string, targetExistedBefore: boolean, created: string[]): string {
  if (!targetExistedBefore) {
    try {
      fs.rmSync(targetDir, { recursive: true, force: true });
      return "目标目录是本次新建的，已整个删掉，不留半成品。";
    } catch (error) {
      return "目标目录是本次新建的，但删不干净（" + String((error as Error).message) + "），请手动删：" + targetDir + "。";
    }
  }
  const deepestFirst = [...new Set(created)].sort((a, b) => b.length - a.length);
  let removed = 0;
  for (const dir of deepestFirst) {
    try {
      fs.rmdirSync(dir);
      removed += 1;
    } catch {
      // 非空（里面有用户文件或本次已写入的文件）→ 留着。宁可留半成品，也不动用户的文件。
    }
  }
  return removed === 0 ? "" : "已清掉本次新建的 " + String(removed) + " 个空目录。";
}

/**
 * 目录里是不是一个能拿来建工程的固件包（三条判据与 CubeMX 包管理器装的包一致）。
 *
 * 第三条只看 gcc 目录在不在，不再点名 startup_stm32f103xb.s：那是 C8T6 的启动文件，
 * 用它当判据等于「不是 C8T6 的工程就别想建」。具体型号要哪个启动文件由
 * createProjectScaffold 按芯片查（缺了会列出包里真实带的那些）。
 */
function isUsableFirmwareRoot(candidate: string, deviceLine = "F1"): boolean {
  return (
    fs.existsSync(path.join(candidate, "Drivers", "STM32" + deviceLine + "xx_HAL_Driver")) &&
    fs.existsSync(path.join(candidate, "Drivers", "CMSIS", "Include")) &&
    fs.existsSync(path.join(candidate, "Drivers", "CMSIS", "Device", "ST", "STM32" + deviceLine + "xx", "Source", "Templates", "gcc"))
  );
}

/**
 * 找固件包：先扫 CubeMX 根（官方仓库 → 插件的 dsh-firmware），再扫 extraDirs
 * （<cacheRoot>/firmware 与 installed.json 里记的落点，见 firmware-install.firmwareExtraDirs）。
 *
 * 为什么要带 extraDirs：stm32_firmware_install 在 CubeMX 根写不进去时会落到下载缓存或调用方指定目录。
 * 只扫 CubeMX 根的话，用户明明装好了，建工程却报"找不到固件包"（审计 B10）。
 */
export function resolveFirmwareRoot(
  cubeMxRoots: string[],
  packageName = DEFAULT_FIRMWARE_PACKAGE,
  extraDirs: readonly FirmwareExtraDir[] = [],
  deviceLine = "F1",
): { root?: string; checked: string[] } {
  const checked: string[] = [];
  for (const cubeRoot of cubeMxRoots) {
    // 官方仓库优先，其次插件自己的 dsh-firmware（与 Repository 并列，见 firmware-packages.ts）。
    for (const parent of ["Repository", DSH_FIRMWARE_DIR_NAME]) {
      const candidate = path.join(cubeRoot, parent, packageName);
      checked.push(candidate);
      if (isUsableFirmwareRoot(candidate, deviceLine)) return { root: candidate, checked };
    }
  }
  for (const extra of extraDirs) {
    // extra.dir 可能是"放包的父目录"，也可能本身就是包（显式 targetDir 指到包上）。
    const candidates = path.basename(extra.dir) === packageName ? [extra.dir] : [path.join(extra.dir, packageName)];
    for (const candidate of candidates) {
      checked.push(candidate);
      if (isUsableFirmwareRoot(candidate, deviceLine)) return { root: candidate, checked };
    }
  }
  return { checked };
}

/**
 * 按族找固件包：STM32Cube_FW_<族>_V<version> 的最高已装版本（官方 Repository 优先，其次 dsh-firmware、再其次下载缓存）。
 *
 * 为什么不能沿用 resolveFirmwareRoot 的固定包名：F1 的默认包名是写死的 V1.8.7，而其它族的版本号
 * 取决于用户装了哪一版；写死任何一个都会在用户装的是别的版本时误报"找不到固件包"。
 * 显式给了 firmwarePackage 就仍旧按精确名找（用户可强制某个版本）。
 */
export function resolveFamilyFirmwareRoot(
  familyLine: string,
  cubeMxRoots: string[],
  extraDirs: readonly FirmwareExtraDir[] = [],
  explicitPackage = "",
): { root?: string; packageName: string; checked: string[] } {
  const deviceLine = familyLine.replace("+", "");
  const prefix = "STM32Cube_FW_" + deviceLine;
  if (explicitPackage !== "") {
    const exact = resolveFirmwareRoot(cubeMxRoots, explicitPackage, extraDirs, deviceLine);
    return {
      ...(exact.root === undefined ? {} : { root: exact.root }),
      packageName: explicitPackage,
      checked: exact.checked,
    };
  }
  const checked: string[] = [];
  const parents = cubeMxRoots.flatMap((root) => [path.join(root, "Repository"), path.join(root, DSH_FIRMWARE_DIR_NAME)]);
  parents.push(...extraDirs.map((extra) => extra.dir));
  const pattern = new RegExp("^" + prefix + "_V(\\d+)\\.(\\d+)\\.(\\d+)$", "u");
  const found: Array<{ root: string; packageName: string; version: readonly number[] }> = [];
  for (const parent of parents) {
    checked.push(parent);
    let entries: string[];
    try {
      entries = fs.readdirSync(parent);
    } catch {
      continue;
    }
    for (const name of entries) {
      const match = pattern.exec(name);
      if (match === null) continue;
      const candidate = path.join(parent, name);
      if (!isUsableFirmwareRoot(candidate, deviceLine)) continue;
      found.push({ root: candidate, packageName: name, version: [Number(match[1]), Number(match[2]), Number(match[3])] });
    }
  }
  found.sort((left, right) => left.version[0]! - right.version[0]! || left.version[1]! - right.version[1]! || left.version[2]! - right.version[2]!);
  const best = found.pop();
  if (best === undefined) return { packageName: prefix, checked };
  return { root: best.root, packageName: best.packageName, checked };
}

/**
 * 非 F1 族的 .ioc 模板：资源包里的 ioc/family/<族>.ioc（CubeMX 6.15 无头 config save 出来的认证配置）。
 *
 * 为什么不能套 F1 的模板：.ioc 的时钟树/IP 列表是逐族的（RCC 键名、PLL 参数、Mcu.IP 清单全不同），
 * 拿 F1 的骨架改成 F4 的型号，CubeMX 打开就会报配置不一致。
 */
export function assetsFamilyIocText(familyLine: string): string | null {
  const state = readLocalManifest();
  if (state.versionDir === "") return null;
  const file = path.join(state.versionDir, "ioc", "family", familyLine.toUpperCase() + ".ioc");
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}

export interface TargetPreflightRequest {
  targetDir: string;
  projectName?: string;
  route: "hal" | "register";
  overwrite?: boolean;
}

/**
 * 动手之前就能判定的拒绝条件（纯读，不写盘）。
 *
 * 为什么单独抽出来：工具层要在**门禁（工具链检查）之前**先跑它——否则用户会先被要求装 CubeMX，
 * 装完才发现目标目录根本不能写，白折腾一趟。引擎自己也调它，保证只有一份判定。
 */
export function preflightTarget(request: TargetPreflightRequest): string | null {
  const targetDir = path.resolve(request.targetDir);
  const projectName = request.projectName ?? path.basename(targetDir);
  if (!SCAFFOLD_PROJECT_NAME.test(projectName)) {
    return "工程名必须是 C 标识符（字母/下划线开头，只含字母数字下划线）：" + projectName;
  }
  if (!fs.existsSync(targetDir)) return null;
  const entries = fs.readdirSync(targetDir);
  if (entries.length === 0) return null;
  if (request.overwrite !== true) {
    return (
      "目标目录不是空的（" + String(entries.length) + " 项）：" + targetDir +
      "。换一个目录；确定要往里写请显式 overwrite=true（同名的工程文件会先备份到 " + STATE_DIR + "/backups 再覆盖）。"
    );
  }
  if (request.route === "hal") {
    // HAL 路线模板里那份 .ioc 是空白配置：覆盖它等于把引脚/时钟树全丢掉，且没有任何"合并"的可能。
    // 所以不做备份+覆盖那一套，直接拒绝，把用户指回 .ioc 事务。
    const iocPath = path.join(targetDir, projectName + ".ioc");
    if (fs.existsSync(iocPath)) {
      return (
        "目标工程里已有 " + projectName + ".ioc：" + iocPath +
        "。模板只能给一份空白配置，覆盖它等于把引脚/时钟树全丢掉，所以这里直接拒绝。" +
        "要改配置请走 stm32_ioc_plan → stm32_ioc_apply（会先备份 .ioc）；确实要用模板重建请先自己备份或删掉它。"
      );
    }
  }
  return null;
}

export interface OverwriteBackup {
  /** 备份目录（绝对路径）；没有需要备份的文件时是空串。 */
  dir: string;
  /** 备份下来的文件（相对工程目录，正斜杠）。 */
  files: string[];
}

/** 备份目录名：时间戳 + 来源（与 ioc-plan 的 <stamp>-ioc、code-patch 的 <stamp>-patch 同一套写法）。 */
function backupStamp(tag: string): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + "-" + tag
  );
}

/**
 * 覆盖前把**将被模板覆盖**的同名文件复制到 `<工程>/.dsh-stm32/backups/<stamp>-<tag>/` 下（保留相对路径）。
 *
 * 为什么要备份：overwrite=true 是用户为了"快速重建"点的头，不该顺手丢掉 .ioc 的引脚/时钟、
 * 或 main.c 里的 USER CODE。备份失败会**抛错**，由调用方转成失败报告——一个字节都不写。
 */
export function backupBeforeOverwrite(targetDir: string, relatives: string[], tag: string): OverwriteBackup {
  const existing = relatives.filter((rel) => fs.existsSync(path.join(targetDir, rel)));
  if (existing.length === 0) return { dir: "", files: [] };
  const root = path.join(targetDir, STATE_DIR, "backups");
  let dir = path.join(root, backupStamp(tag));
  // 同一秒内连续两次覆盖要各留一份：撞名就加序号，绝不覆盖上一次的备份。
  for (let extra = 2; fs.existsSync(dir); extra += 1) dir = path.join(root, backupStamp(tag) + "-" + String(extra));
  fs.mkdirSync(dir, { recursive: true });
  for (const rel of existing) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    copyFileLong(path.join(targetDir, rel), dest);
  }
  return { dir, files: existing };
}

/**
 * 模板文件 → 工程里的目标（相对工程目录，正斜杠）。
 * scaffold 的写盘与"覆盖前备份"共用这一份映射：两处各写一遍迟早对不上，备份就会漏文件。
 */
function templateTargets(tpl: string, projectName: string): Map<string, string> {
  const targets = new Map<string, string>();
  for (const source of listFiles(tpl, TEMPLATE_SKIP_PREFIXES)) {
    const rel = path.relative(tpl, source).replace(/\\/gu, "/");
    const destRel = rel.startsWith("vscode/")
      ? ".vscode/" + rel.slice("vscode/".length)
      : rel === "demo.ioc"
        ? projectName + ".ioc"
        : rel;
    targets.set(source, destRel);
  }
  return targets;
}

/** 被模板/固件包直接覆盖的工程文件（Drivers/ 整棵树不在内：那是 ST 源码，不是用户文件）。 */
function overwriteTargetsFor(writtenRels: readonly string[], facts: HalChipFacts): string[] {
  return [...writtenRels, facts.startup, systemFileRel(facts), facts.linkerScript];
}

/** 固件包里的系统文件在本工程里的相对路径（F1 → Core/Src/system_stm32f1xx.c）。 */
function systemFileRel(facts: HalChipFacts): string {
  return "Core/Src/system_stm32" + facts.familyLine.replace("+", "").toLowerCase() + "xx.c";
}

/** 备份说明（写进 warnings，卡片上第一眼就能看到原件在哪）。 */
export function backupWarning(backup: OverwriteBackup): string | null {
  if (backup.files.length === 0) return null;
  return "已把被覆盖的文件备份到 " + backup.dir + "：" + backup.files.join("、");
}

/**
 * 建工程骨架（不调用 CubeMX；生成 Core/ 由 stm32_generate 负责）。
 */
export function createProjectScaffold(request: ScaffoldRequest): ScaffoldReport {
  const startedAt = Date.now();
  const targetDir = path.resolve(request.targetDir);
  const projectName = request.projectName ?? path.basename(targetDir);
  // 芯片事实先算出来：连失败报告都要说清"本来是按哪款芯片建"。
  const chip = resolveHalChip(request.mcu);
  const facts = chip.facts;
  const chipFields = (): Partial<ScaffoldReport> =>
    facts === null
      ? {}
      : { mcu: facts.mcu, startup: facts.startup, deviceDefine: facts.deviceDefine, linkerScript: facts.linkerScript };
  const fail = (message: string, warnings: string[] = []): ScaffoldReport => ({
    ok: false,
    targetDir,
    projectName,
    iocPath: path.join(targetDir, projectName + ".ioc"),
    templateDir: templateDir(),
    templateFiles: 0,
    driverFiles: 0,
    durationMs: Date.now() - startedAt,
    warnings,
    message,
    ...chipFields(),
  });

  const refusal = preflightTarget({ targetDir, projectName, route: "hal", ...(request.overwrite === undefined ? {} : { overwrite: request.overwrite }) });
  if (refusal !== null) return fail(refusal);

  // 1) 芯片：认不出 / 缺 RAM 就拒绝（reason 是人话，直接给用户看）
  if (facts === null) return fail("认不出芯片型号：" + chip.reason);

  const tpl = templateDir();
  if (!fs.existsSync(tpl)) return fail("插件模板目录缺失：" + tpl + "（重新安装插件）");

  // 固件包按族找（F1 的默认版本仍是 V1.8.7；其它族取本机已装的最高版本，用户也可显式指定包名）。
  // F1 不给包名时仍按历史默认（V1.8.7）：同一台机器上装了 1.8.4/1.8.5 时，"最高版本"会让老工程换基线。
  const explicitPackage = request.firmwarePackage ?? (facts.familyLine === "F1" ? DEFAULT_FIRMWARE_PACKAGE : "");
  const firmware = resolveFamilyFirmwareRoot(facts.familyLine, request.cubeMxRoots ?? [], firmwareExtraDirs(), explicitPackage);
  const firmwarePackage = firmware.packageName;
  if (firmware.root === undefined) {
    // 显式给了包名就报那个名字；没给就说明找的是该族任意版本（_V*）。
    const wanted = explicitPackage === "" ? firmwarePackage + "_V*" : firmwarePackage;
    return fail(
      "找不到 " + facts.familyId + " 的 CubeMX 固件包 " + wanted + "（找过：" + firmware.checked.join("；") + "）。" +
        "固件包是 Drivers/ 与 startup 的唯一合法来源，插件不内嵌 ST 代码；先用 CubeMX 的包管理器装这个族的固件包。",
    );
  }

  // 2) 固件包里必须真有这款芯片的启动文件与设备头：认不出就停在这里，别建出个编译不过的工程
  //    （startup 是 copy 进工程的，设备头随 Drivers/ 整树拷过来，所以只校验存在性）。
  const deviceDir = path.join(firmware.root, "Drivers", "CMSIS", "Device", "ST", "STM32" + facts.familyLine.replace("+", "") + "xx");
  const templatesDir = path.join(deviceDir, "Source", "Templates");
  const gccDir = path.join(templatesDir, "gcc");
  const startupSource = path.join(gccDir, facts.startup);
  const headerSource = path.join(deviceDir, "Include", facts.deviceHeader);
  if (!fs.existsSync(startupSource)) {
    const available = fs.existsSync(gccDir)
      ? fs.readdirSync(gccDir).filter((name) => /^startup_.*\.s$/u.test(name)).sort()
      : [];
    return fail(
      "固件包里没有 " + facts.mcu + " 需要的启动文件 " + facts.startup + "：" + startupSource +
        "。这份固件包真实带的启动文件：" + (available.length === 0 ? "（一个都没有）" : available.join("、")),
    );
  }
  if (!fs.existsSync(headerSource)) {
    return fail(
      "固件包里没有 " + facts.deviceDefine + " 的设备头 " + facts.deviceHeader + "：" + headerSource +
        "。设备头随 Drivers/ 一起复制，缺它说明这份固件包不完整（换一个版本的 " + firmwarePackage + "）。",
    );
  }

  // 非 F1 族的 .ioc 模板来自资源包（逐族的时钟树 / Mcu.IP 清单 / RCC 键名）；没有就拒绝，
  // 绝不拿 F1 的骨架改个型号名——CubeMX 打开会报配置不一致（那是"看起来建成了但打不开"的工程）。
  let familyIocText: string | null = null;
  if (facts.familyLine !== "F1") {
    familyIocText = assetsFamilyIocText(facts.familyLine);
    if (familyIocText === null) {
      return fail(
        "资源包里没有 " + facts.familyLine + " 的 .ioc 模板（ioc/family/" + facts.familyLine.toUpperCase() + ".ioc）：" +
          "先跑 stm32_assets refresh 更新资源包；F1 之外的族不能套 F1 的模板（时钟树与外设清单逐族不同）。",
      );
    }
  }

  // 3) 模板全部读进内存并按芯片渲染好——这一步一个字节都不写：
  //    渲染失败只可能是模板被改过，宁可在动手前拒绝，也不留下一半 C8T6 一半新芯片的工程。
  const vscodeFill = detectVscodeFill(request.binDirs ?? []);
  const droppedVscode = new Set<string>();
  const written: Array<{ rel: string; text: string }> = [];
  let linkerScriptText = "";
  let openocdNote = "";
  try {
    // 链接脚本按芯片渲染；模板里那份（C8T6 的 64K/20K）只作渲染源 + 蓝丸的兼容副本。
    linkerScriptText = renderLinkerScript(fs.readFileSync(path.join(tpl, LEGACY_LINKER_SCRIPT), "utf8"), facts);
    for (const [source, destRel] of templateTargets(tpl, projectName)) {
      // 旧名的链接脚本只在蓝丸上留一份：别的芯片写旧名 = 一份骗人的内存布局。
      if (destRel === LEGACY_LINKER_SCRIPT && !facts.keepLegacyLinkerScript) continue;
      // .ioc 用族模板（非 F1）或插件模板（F1）；其余文件仍从模板目录读。
      let text = destRel === projectName + ".ioc" && familyIocText !== null ? familyIocText : fs.readFileSync(source, "utf8");
      if (destRel !== ".gitignore" && destRel !== LEGACY_LINKER_SCRIPT) {
        text = text.split("__PROJECT_NAME__").join(projectName);
      }
      if (destRel === projectName + ".ioc") text = renderIoc(text, facts, projectName);
      if (destRel === "cmake/gcc-arm-none-eabi.cmake" || destRel === "cmake/starm-clang.cmake") {
        text = pointLinkerFlagAt(text, facts);
      }
      // Cmake 与 openocd 配置里的族相关字面量（STM32F1xx / stm32f1x）都按芯片换掉。
      if (destRel === "cmake/stm32cubemx/CMakeLists.txt") text = renderCmakeLists(text, facts);
      if (destRel === "openocd.cfg" || destRel === ".vscode/launch.json") {
        const rendered = renderOpenocdTarget(text, facts, destRel === "openocd.cfg" ? "openocd" : "launch");
        text = rendered.text;
        if (rendered.note !== "") openocdNote = rendered.note;
      }
      if (destRel.startsWith(".vscode/")) {
        const filled = fillVscodeTemplate(text, vscodeFill);
        text = filled.text;
        for (const token of filled.dropped) droppedVscode.add(token);
      }
      written.push({ rel: destRel, text });
    }
    // 该族在 openocd 0.12 里没有 target 脚本（C0 / U0）：把插件内置的那份复制进工程，
    // 让 openocd.cfg / launch.json 里那条 source openocd/<name>.cfg 真能找到文件。
    const bundled = familyProfileOf(facts.familyId).bundledTarget;
    if (bundled !== null) {
      const source = bundledOpenocdConfig(bundled);
      if (source === null) {
        throw new Error(
          "插件缺少内置 target 脚本 templates/openocd/" + bundled + ".cfg（安装不完整）：" + facts.familyId + " 靠它烧录/调试",
        );
      }
      written.push({ rel: "openocd/" + bundled + ".cfg", text: fs.readFileSync(source, "utf8") });
    }
  } catch (error) {
    return fail(
      "没写任何文件：模板按芯片渲染失败（" + String((error as Error).message) + "）。目标目录 " + targetDir + " 未被改动。",
    );
  }
  const templateFiles = written.length;

  // —— 写盘从这里开始：先把将被覆盖的同名文件备份；备份失败就一个字节都不写 ——
  let backup: OverwriteBackup;
  try {
    backup = backupBeforeOverwrite(targetDir, overwriteTargetsFor(written.map((item) => item.rel), facts), "scaffold");
  } catch (error) {
    return fail(
      "没写任何文件：覆盖前的备份失败（" + String((error as Error).message) + "）。目标目录 " + targetDir + " 未被改动。",
    );
  }
  const backupNote = backupWarning(backup);
  const backupWarnings = backupNote === null ? [] : [backupNote];

  const targetExistedBefore = fs.existsSync(targetDir);
  // npm 打包永远排除 .gitignore（它同时是 npm 的忽略过滤器）：npm 安装的用户模板里必然没有。
  // 缺它工程照建，只是 git 状态会多出 build/；warning 里说明白，别让人以为是装坏了。
  const gitignoreMissing = !fs.existsSync(path.join(tpl, ".gitignore"));
  const createdDirs: string[] = [];
  let driverFiles = 0;
  try {
    mkdirTracked(targetDir, createdDirs);
    mkdirTracked(path.join(targetDir, "Core", "Src"), createdDirs);
    mkdirTracked(path.join(targetDir, "Core", "Inc"), createdDirs);

    // 1) 模板快照（已按芯片渲染）：CMake 工程文件 / 链接脚本 / .vscode / .ioc
    //    .vscode 里的调试/构建路径按本机探测填（模板只留占位符，绝不写死开发机的 D:/… 路径）。
    for (const item of written) {
      const dest = path.join(targetDir, item.rel);
      mkdirTracked(path.dirname(dest), createdDirs);
      fs.writeFileSync(dest, item.text);
    }
    // 链接脚本：按芯片命名的那份（蓝丸另有一份旧名兼容副本，已经作为模板项写过了）
    fs.writeFileSync(path.join(targetDir, facts.linkerScript), linkerScriptText);

    // 2) 固件包：Drivers 全量 + 本芯片的 startup + system（与 GUI 新工程逐字节一致）
    driverFiles = copyTreeLong(path.join(firmware.root, "Drivers"), path.join(targetDir, "Drivers"), DRIVER_SKIP_PREFIXES, createdDirs);
    copyFileLong(startupSource, path.join(targetDir, facts.startup));
    copyFileLong(path.join(templatesDir, path.basename(systemFileRel(facts))), path.join(targetDir, ...systemFileRel(facts).split("/")));
  } catch (error) {
    const cleanup = cleanupAfterFailure(targetDir, targetExistedBefore, createdDirs);
    return fail(
      "写盘失败（已写 " + String(written.length) + " 个模板文件、" + String(driverFiles) + " 个固件文件）：" +
        String((error as Error).message) + "；路径：" + targetDir + "。" + cleanup,
      backupWarnings,
    );
  }

  const iocPath = path.join(targetDir, projectName + ".ioc");
  const warnings: string[] = [];
  if (backupNote !== null) warnings.push(backupNote);
  for (const note of facts.notes) warnings.push(note);
  if (!facts.keepLegacyLinkerScript) {
    warnings.push(
      "链接脚本按芯片命名为 " + facts.linkerScript + "（cmake 的 -T 已指到它）；旧名 " + LEGACY_LINKER_SCRIPT +
        " 只在 C8T6 上留兼容副本，别的芯片写它是错的内存布局。",
    );
  }
  if (gitignoreMissing) {
    warnings.push(
      "插件包里没有 .gitignore（npm 打包会排除它）：工程功能不受影响，只是 git 状态会多出 build/ 目录。" +
        "想干净就在工程根目录建一个 .gitignore，内容一行：build/",
    );
  }
  for (const token of droppedVscode) warnings.push(describeDroppedPlaceholder(token));
  if (openocdNote !== "") warnings.push(openocdNote);
  warnings.push(
    "没有生成 .mxproject：那是 CubeMX GUI 的工程元数据，插件不伪造；用 GUI 打开并生成一次即可补上。",
    "Core/ 下的 main.c 等还没生成：接着调 stm32_generate（3–4 分钟，需要 CubeMX 全权限）。",
  );
  return {
    ok: true,
    targetDir,
    projectName,
    iocPath,
    firmwareRoot: firmware.root,
    templateDir: tpl,
    templateFiles,
    driverFiles,
    durationMs: Date.now() - startedAt,
    warnings,
    mcu: facts.mcu,
    startup: facts.startup,
    deviceDefine: facts.deviceDefine,
    linkerScript: facts.linkerScript,
    message:
      "工程骨架已建好（" + String(templateFiles) + " 个工程文件 + " + String(driverFiles) + " 个固件文件）：" + targetDir +
      "；芯片 " + describeHalChip(facts) + (backupNote === null ? "" : "；" + backupNote),
  };
}
