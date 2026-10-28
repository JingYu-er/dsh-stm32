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
import { describeDroppedPlaceholder, detectVscodeFill, fillVscodeTemplate } from "./vscode-config.js";

export const DEFAULT_FIRMWARE_PACKAGE = "STM32Cube_FW_F1_V1.8.7";
export const DEFAULT_MCU_CUBE_VERSION = "6.15.0";
export const SCAFFOLD_PROJECT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * 工程内的状态目录名。这里自己写一份常量而不是 import generate.ts 的 STATE_DIR：
 * 两个引擎互不依赖（避免 generate → scaffold 的循环），改名时以 ioc-plan / code-patch 的约定为准。
 */
const STATE_DIR = ".dsh-stm32";

export interface ScaffoldRequest {
  targetDir: string;
  projectName?: string;
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

/** 目录里是不是一个能拿来建工程的固件包（三条判据与 CubeMX 包管理器装的包一致）。 */
function isUsableFirmwareRoot(candidate: string): boolean {
  return (
    fs.existsSync(path.join(candidate, "Drivers", "STM32F1xx_HAL_Driver")) &&
    fs.existsSync(path.join(candidate, "Drivers", "CMSIS", "Include")) &&
    fs.existsSync(path.join(candidate, "Drivers", "CMSIS", "Device", "ST", "STM32F1xx", "Source", "Templates", "gcc", "startup_stm32f103xb.s"))
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
): { root?: string; checked: string[] } {
  const checked: string[] = [];
  for (const cubeRoot of cubeMxRoots) {
    // 官方仓库优先，其次插件自己的 dsh-firmware（与 Repository 并列，见 firmware-packages.ts）。
    for (const parent of ["Repository", DSH_FIRMWARE_DIR_NAME]) {
      const candidate = path.join(cubeRoot, parent, packageName);
      checked.push(candidate);
      if (isUsableFirmwareRoot(candidate)) return { root: candidate, checked };
    }
  }
  for (const extra of extraDirs) {
    // extra.dir 可能是"放包的父目录"，也可能本身就是包（显式 targetDir 指到包上）。
    const candidates = path.basename(extra.dir) === packageName ? [extra.dir] : [path.join(extra.dir, packageName)];
    for (const candidate of candidates) {
      checked.push(candidate);
      if (isUsableFirmwareRoot(candidate)) return { root: candidate, checked };
    }
  }
  return { checked };
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
function overwriteTargetsFor(tpl: string, projectName: string): string[] {
  return [...templateTargets(tpl, projectName).values(), "startup_stm32f103xb.s", "Core/Src/system_stm32f1xx.c"];
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
  const firmwarePackage = request.firmwarePackage ?? DEFAULT_FIRMWARE_PACKAGE;
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
  });

  const refusal = preflightTarget({ targetDir, projectName, route: "hal", ...(request.overwrite === undefined ? {} : { overwrite: request.overwrite }) });
  if (refusal !== null) return fail(refusal);

  const tpl = templateDir();
  if (!fs.existsSync(tpl)) return fail("插件模板目录缺失：" + tpl + "（重新安装插件）");

  const firmware = resolveFirmwareRoot(request.cubeMxRoots ?? [], firmwarePackage, firmwareExtraDirs());
  if (firmware.root === undefined) {
    return fail(
      "找不到 CubeMX 固件包 " + firmwarePackage + "（找过：" + firmware.checked.join("；") + "）。" +
        "固件包是 Drivers/ 与 startup 的唯一合法来源，插件不内嵌 ST 代码。",
    );
  }

  // —— 写盘从这里开始：先把将被覆盖的同名文件备份；备份失败就一个字节都不写 ——
  let backup: OverwriteBackup;
  try {
    backup = backupBeforeOverwrite(targetDir, overwriteTargetsFor(tpl, projectName), "scaffold");
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
  const vscodeFill = detectVscodeFill(request.binDirs ?? []);
  const droppedVscode = new Set<string>();
  let templateFiles = 0;
  let driverFiles = 0;
  try {
    mkdirTracked(targetDir, createdDirs);
    mkdirTracked(path.join(targetDir, "Core", "Src"), createdDirs);
    mkdirTracked(path.join(targetDir, "Core", "Inc"), createdDirs);

    // 1) 模板快照：CMake 工程文件 / 链接脚本 / .vscode / .ioc（只替换工程名）
    //    .vscode 里的调试/构建路径按本机探测填（模板只留占位符，绝不写死开发机的 D:/… 路径）。
    for (const [source, destRel] of templateTargets(tpl, projectName)) {
      let text = fs.readFileSync(source, "utf8");
      if (destRel !== ".gitignore" && destRel !== "STM32F103XX_FLASH.ld") {
        text = text.split("__PROJECT_NAME__").join(projectName);
      }
      if (destRel.startsWith(".vscode/")) {
        const filled = fillVscodeTemplate(text, vscodeFill);
        text = filled.text;
        for (const token of filled.dropped) droppedVscode.add(token);
      }
      const dest = path.join(targetDir, destRel);
      mkdirTracked(path.dirname(dest), createdDirs);
      fs.writeFileSync(dest, text);
      templateFiles += 1;
    }

    // 2) 固件包：Drivers 全量 + startup + system（与 GUI 新工程逐字节一致）
    driverFiles = copyTreeLong(path.join(firmware.root, "Drivers"), path.join(targetDir, "Drivers"), DRIVER_SKIP_PREFIXES, createdDirs);
    const templatesDir = path.join(firmware.root, "Drivers", "CMSIS", "Device", "ST", "STM32F1xx", "Source", "Templates");
    copyFileLong(path.join(templatesDir, "gcc", "startup_stm32f103xb.s"), path.join(targetDir, "startup_stm32f103xb.s"));
    copyFileLong(path.join(templatesDir, "system_stm32f1xx.c"), path.join(targetDir, "Core", "Src", "system_stm32f1xx.c"));
  } catch (error) {
    const cleanup = cleanupAfterFailure(targetDir, targetExistedBefore, createdDirs);
    return fail(
      "写盘失败（已写 " + String(templateFiles) + " 个模板文件、" + String(driverFiles) + " 个固件文件）：" +
        String((error as Error).message) + "；路径：" + targetDir + "。" + cleanup,
      backupWarnings,
    );
  }

  const iocPath = path.join(targetDir, projectName + ".ioc");
  const warnings: string[] = [];
  if (backupNote !== null) warnings.push(backupNote);
  if (gitignoreMissing) {
    warnings.push(
      "插件包里没有 .gitignore（npm 打包会排除它）：工程功能不受影响，只是 git 状态会多出 build/ 目录。" +
        "想干净就在工程根目录建一个 .gitignore，内容一行：build/",
    );
  }
  for (const token of droppedVscode) warnings.push(describeDroppedPlaceholder(token));
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
    message:
      "工程骨架已建好（" + String(templateFiles) + " 个工程文件 + " + String(driverFiles) + " 个固件文件）：" + targetDir +
      (backupNote === null ? "" : "；" + backupNote),
  };
}
