/**
 * L1：无法安装（或不应由插件代装）的组件，如何清晰说明。
 *
 * 门禁把缺件分成两档，因为这两档的"下一步"完全不同：
 *   auto   —— MSYS2 里一条 pacman 就能补（gcc / gdb / openocd / cmake / ninja），
 *             插件能跑 stm32_env_install 出计划、确认后自己装；
 *   manual —— 装不了或不该代装：STM32CubeMX 是 InstallAnywhere 的 GUI 向导（要 ST 账号 +
 *             同意许可），固件包只由 CubeMX 的包管理器维护（st.com 包清单 + 22 个 git 子模块）。
 *             这两种只能提供分步指引，插件至多将其路径写入配置。
 *
 * 本文件只有文案与元数据，不起进程、不读盘，便于单测与审计（改文案不用碰引擎）。
 */

import { FIRMWARE_FAMILIES } from "./firmware-packages.js";

/** 缺件的安装方式：auto = 插件能装；manual = 只能人装，插件给指引。 */
export type Installability = "auto" | "manual";

/** 组件 id 与 probe.buildTargets 的 id 保持一致（firmware 不在探测列表里，由路由/生成工具单独判）。 */
export type InstallComponent =
  | "gcc"
  | "gdb"
  | "openocd"
  | "cmake"
  | "ninja"
  | "cubemx"
  | "cubemx-java"
  | "firmware"
  | "kicad"
  | "npm"
  | "poppler";

/** 组件 → 安装方式。没列的按 auto 处理（默认乐观：pacman 能补的居多）。 */
export const COMPONENT_INSTALLABILITY: Record<InstallComponent, Installability> = {
  gcc: "auto",
  gdb: "auto",
  openocd: "auto",
  cmake: "auto",
  ninja: "auto",
  // CubeMX 的主程序与其内置 JRE 永远一起出现，也可能一起缺：同一份指引。
  cubemx: "manual",
  "cubemx-java": "manual",
  firmware: "manual",
  // KiCad 是独立安装包（1.5 GB，带自有 Python 与 bun），装法与版本都由 ST 之外的厂商管；
  // npm 随 Node.js 来，可能先有 node 再有 npm，也可能反过来。
  kicad: "manual",
  npm: "manual",
  // poppler 在 MSYS2 的仓库里，一条 pacman 就能补；插件不代装，但能给准确命令。
  poppler: "auto",
};

export interface InstallStep {
  /** 简要动作。 */
  title: string;
  /** 具体怎么做（含点哪里、看什么）。 */
  detail: string;
  /** 可粘贴的命令（没有就不给）。 */
  command?: string;
}

export interface InstallGuide {
  component: InstallComponent;
  label: string;
  installability: Installability;
  /** 不能（或不适合）自动安装的原因 —— 该字段可直接回给用户。 */
  why: string;
  /** 体积/耗时预期，避免用户误以为仅数十 MB。 */
  sizeHint: string;
  /** 是否需要 ST 账号 / 许可同意。 */
  needsAccount: boolean;
  steps: InstallStep[];
  /** 装完怎么自检（一条判据）。 */
  verify: string;
  /** 免安装路径：复制已有安装即可。 */
  portable?: string;
}

const CUBEMX_LABEL = "STM32CubeMX（启动器）+ 内置 JRE";

/**
 * CubeMX 的安装指引。
 *
 * 事实依据（2026-10 取证）：安装器是 InstallAnywhere 生成的 GUI 向导，官方文档没有静默安装参数；
 * 下载要登录 ST 账号并同意许可；装完约 1.5 GB，且固件包**不在**里面（要另下 293 MB / 一万多个文件）。
 * 社区里唯一能看到的 /S 静默安装脚本，对 CubeMX 那一行是注释掉的 —— 所以不做自动装。
 */
export function cubeMxGuide(): InstallGuide {
  return {
    component: "cubemx",
    label: CUBEMX_LABEL,
    installability: "manual",
    why:
      "CubeMX 是 GUI 安装向导，没有官方静默参数，下载前还要登录 ST 账号并同意许可，"
      + "插件代为安装等于代用户确认许可、代用户输入账号 —— 此步骤不执行。",
    sizeHint: "安装包数百 MB，装完约 1.5 GB（不含固件包）；固件包另算，见固件包那条指引（实测 250 MB – 1.7 GB）。",
    needsAccount: true,
    steps: [
      {
        title: "下载 CubeMX 安装包",
        detail: "打开 https://www.st.com/en/development-tools/stm32cubemx.html → Get Software，登录/注册 ST 账号并同意许可后下载 Windows 安装包（.exe）。",
      },
      {
        title: "GUI 装一遍（默认选项即可）",
        detail: "双击安装包按向导走完；安装盘符不限，不要放在受保护目录（例如 C:\\Program Files 需要管理员权限，插件写固件包时会失败）。",
      },
      {
        title: "把安装根写进配置",
        detail: "安装根 = 同时含 STM32CubeMX.exe 与 jre\\bin\\java.exe 的那个目录。让插件写：stm32_env_install 只做配置落盘，或手动编辑 %USERPROFILE%\\.dsh-stm32\\config.json 的 cubeMxRoot。",
      },
      {
        title: "自检",
        detail: "stm32_doctor 的 tools 里 cubemx 与 cubemx-java 都应带 path；缺 jre 时无头生成会直接报 java 找不到。",
      },
    ],
    verify: "stm32_doctor → capabilities.generate 为 true（cubemx 与 cubemx-java 都找到）。",
    portable:
      "一台机器上 GUI 装一次，把整个安装目录拷到目标机任意路径（jre 在目录里，不依赖系统 Java），"
      + "再把 cubeMxRoot 指过去即可。",
  };
}

/** 芯片族 → CubeMX 固件包名前缀里那一段，例如 F1 → STM32F1xx。 */
export function familyPrefix(family: string): string {
  const trimmed = family.trim().toUpperCase();
  return trimmed === "" ? "STM32<族>xx" : "STM32" + trimmed + "xx";
}

export interface FirmwareGuideInput {
  /** 芯片族，例如 F1 / G4 / H7。 */
  family: string;
  /** 期望的包目录名，例如 STM32Cube_FW_F1_V1.8.7；不知道就给空串。 */
  packageName: string;
  /** CubeMX 的固件包仓库目录，例如 <cubeMxRoot>/Repository。 */
  repositoryDir: string;
}

/**
 * 各系列的固件包实测体积（2026-10 本机 D:\app\STM32CubeMX\Repository 直接量的）。
 *
 * 固定单一数字不适用于其他系列：F1 293 MB、G4 471 MB、F4 1.67 GB，相差 6 倍。
 * 表里没有的系列给区间，不给具体数字。
 */
const FIRMWARE_SIZE_HINTS: Readonly<Record<string, string>> = {
  F0: "258 MB / 一万七千个文件（实测 L0 同级，F0 同量级）；装完占盘约 260 MB。",
  F1: "293 MB / 10,778 个文件（v1.8.7 实测）；装完占盘约 293 MB。",
  F3: "约 300 MB / 一万多个文件；装完占盘约 300 MB。",
  F4: "1,674 MB / 43,397 个文件（v1.28.3 实测）；装完占盘约 1.7 GB。",
  G0: "约 400 MB / 两万个文件；装完占盘约 400 MB。",
  G4: "471 MB / 23,089 个文件（v1.6.2 实测）；装完占盘约 470 MB。",
  L0: "258 MB / 17,504 个文件（v1.12.4 实测）；装完占盘约 258 MB。",
  L4: "约 300 MB / 两万个文件；装完占盘约 300 MB。",
};

const FIRMWARE_SIZE_FALLBACK =
  "一个系列通常 250 MB – 1.7 GB / 一万到四万个文件（不同系列差异较大，最多相差 6 倍）；装完占盘同量级。";

/** 固件包体积提示：已知系列给精确值、未知系列给区间（不将 F1 的数字套用到 H7）。 */
export function firmwareSizeHint(family: string): string {
  const key = family.trim().toUpperCase();
  return FIRMWARE_SIZE_HINTS[key] ?? FIRMWARE_SIZE_FALLBACK;
}

/**
 * 固件包（HAL + CMSIS + startup）的安装指引。
 *
 * 为什么不做成自动下载（2026-10 取证）：GitHub 上 STMicroelectronics/STM32CubeF1 有 v1.8.7 标签，
 * 但主仓库包含 22 个 git 子模块，tarball 里 Drivers/CMSIS/Device/ST/STM32F1xx 与
 * Drivers/STM32F1xx_HAL_Driver 是**空目录**；拼接出的包 CubeMX 是否识别尚未验证。
 * 所以现在归入 manual：由 CubeMX 自身的包管理器安装（其写入的 package.xml / 包清单才是权威）。
 */
export function firmwareGuide(input: FirmwareGuideInput): InstallGuide {
  const prefix = familyPrefix(input.family);
  // 用 Object.hasOwn 而不是 `in`：`in` 会命中原型链（"constructor" / "__proto__" 之类会被当成有效族名，
  // 于是给出一份"插件能代下"的错误承诺）。审计 A37。
  const autoDownloadable = input.family !== "" && Object.hasOwn(FIRMWARE_FAMILIES, input.family.toUpperCase());
  const name = input.packageName === "" ? "STM32Cube_FW_" + (input.family === "" ? "<族>" : input.family) + "_V<版本>" : input.packageName;
  return {
    component: "firmware",
    label: "固件包 " + name,
    installability: "manual",
    why:
      "固件包不在 CubeMX 安装包里，而且不是单个压缩包：HAL 驱动、CMSIS 设备头、启动文件分在不同的 git 仓库里，"
      + "GitHub 的源码压缩包拿到的是空目录。可靠的来源只有 CubeMX 自己的包管理器（由 CubeMX 写入包清单与 package.xml）。",
    sizeHint: firmwareSizeHint(input.family),
    needsAccount: true,
    steps: [
      {
        title: autoDownloadable
          ? "先试插件代下载（该系列已接入）"
          : "插件尚不支持该系列代下载",
        detail: autoDownloadable
          ? "调 stm32_firmware_install（family 给 " + input.family + "，dryRun:false + confirm:true）：插件从 GitHub 拉取 HAL 驱动与 CMSIS 设备两个子模块仓库 + 内核头，自行补齐 package.xml，实测 CubeMX 可识别；约 2 MB，数十秒。拉取失败或需使用官方包时，按下面三步操作。"
          : "目前只有 F1 接入自动下载（其余系列按同样字段补充一条即可）；该系列请使用下面的 CubeMX 包管理器。",
      },
      {
        title: "在 CubeMX 里打开包管理器",
        detail: "CubeMX → Help → Manage embedded software packages → STM32Cube MCU Package for STM32" + (input.family === "" ? "<族>" : input.family) + " 那一栏 → 勾选目标版本 → Install。",
      },
      {
        title: "确认落到默认位置",
        detail: "装完应在 " + input.repositoryDir + "\\" + name + "；换过仓库目录的话以 CubeMX 的 Preferences 为准。",
      },
      {
        title: "离线机器：整目录拷贝",
        detail: "从联网机器把 " + name + " 整个目录（或整个 Repository 目录）拷到目标机同一位置即可，不需要重装 CubeMX。",
      },
      {
        title: "自检",
        detail: "目录里应同时有 Drivers\\" + prefix + "_HAL_Driver、Drivers\\CMSIS\\Include、Drivers\\CMSIS\\Device\\ST\\" + prefix + "\\Source\\Templates。",
      },
    ],
    verify: "stm32_generate 不再报「找不到 CubeMX 固件包」，或 stm32_route_plan 的 firmware.found 为 true。",
  };
}

/**
 * 组件 id → 指引；auto 组件无指引（走 stm32_env_install）。cubemx 与 cubemx-java 共用一份。
 *
 * firmware 需要族名/包名/仓库目录才说得具体，所以第二个参数是可选的补充信息：
 * 调用方（route_plan）手里有这些字段就传，只拿组件 id 的人（门禁、命令卡）也能拿到通用指引 ——
 * 否则 firmware 在这里恒为 null，和 route_plan 实际能给的东西不一致（审计 A37）。
 */
export function guideFor(
  component: string,
  firmware: FirmwareGuideInput = { family: "", packageName: "", repositoryDir: "" },
): InstallGuide | null {
  if (component === "cubemx" || component === "cubemx-java") return cubeMxGuide();
  if (component === "firmware") return firmwareGuide(firmware);
  if (component === "kicad") return kicadGuide();
  if (component === "npm") return npmGuide();
  if (component === "poppler") return popplerGuide();
  return null;
}

/** 一批组件 → 去重后的指引（cubemx + cubemx-java 只留一份，顺序稳定）。 */
export function guidesFor(components: readonly string[]): InstallGuide[] {
  const seen = new Set<string>();
  const out: InstallGuide[] = [];
  for (const component of components) {
    const guide = guideFor(component);
    if (guide === null) continue;
    if (seen.has(guide.component)) continue;
    seen.add(guide.component);
    out.push(guide);
  }
  return out;
}

/** 指引压成报告里的几行（gate.detail / notes 用）。 */
export function guideLines(guide: InstallGuide, maxSteps = 4): string[] {
  const lines: string[] = [];
  lines.push("【" + guide.label + "】" + guide.why);
  lines.push("体积：" + guide.sizeHint + (guide.needsAccount ? "；需要 ST 账号并同意许可。" : ""));
  const steps = guide.steps.slice(0, maxSteps);
  for (const [index, step] of steps.entries()) {
    lines.push("  " + String(index + 1) + ". " + step.title + " —— " + step.detail);
    if (step.command !== undefined && step.command !== "") lines.push("     " + step.command);
  }
  if (guide.steps.length > steps.length) lines.push("  …还有 " + String(guide.steps.length - steps.length) + " 步，见 guides[].steps");
  lines.push("  自检：" + guide.verify);
  if (guide.portable !== undefined && guide.portable !== "") lines.push("  免安装：" + guide.portable);
  return lines;
}

/**
 * KiCad 的安装指引。
 *
 * 事实依据（2026-11 取证）：电路设计的构建与检查全部落在 KiCad 自带的三件套上——
 * `bin/kicad-cli.exe`（ERC/DRC/Gerber/STEP）、`bin/bun.exe`（跑 tscircuit 的 TSX 入口，
 * Node 直接跑会报 `Unknown file extension ".tsx"`）、`bin/python.exe`（3.11，带 pcbnew）。
 * 所以「装了 tscircuit」不等于能用：必须装 KiCad 10。
 */
export function kicadGuide(): InstallGuide {
  return {
    component: "kicad",
    label: "KiCad 10（kicad-cli / bun / pcbnew）",
    installability: "manual",
    why: "电路设计的构建、检查与导出调用的是 KiCad 自带的 kicad-cli 与 bun，插件不自带 EDA 内核。",
    sizeHint: "约 1.5 GB（含符号库、封装库与 3D 模型）",
    needsAccount: false,
    steps: [
      {
        title: "官网下载 10.x 安装包",
        detail: "kicad.org/download 选 Windows 安装包；装到默认目录即可被自动发现。",
        command: "https://www.kicad.org/download/windows/",
      },
      {
        title: "非默认目录时指路径",
        detail: "把安装根目录（含 bin/ 与 share/kicad/）写进配置项 DSH_STM32_KICAD_ROOT。",
        command: 'setx DSH_STM32_KICAD_ROOT "D:/app/KiCad/10.0"',
      },
      {
        title: "确认版本是 10.x",
        detail: "原理图读取只认 KiCad 10 的文件格式（version 20260306），9 及更早的工程会明确拒绝。",
      },
    ],
    verify: "kicad-cli version（应输出 10.x）",
    portable: "把已有 KiCad 目录整个拷过来，设置 DSH_STM32_KICAD_ROOT 指向它即可。",
  };
}

/**
 * npm 的安装指引。
 *
 * tscircuit 的依赖（约 730 MB）由 `npm install` 拉进 hardware/circuit/node_modules；
 * 构建本身用 KiCad 的 bun 跑，不依赖 node 的模块解析，但装依赖这一步绕不开 npm。
 */
export function npmGuide(): InstallGuide {
  return {
    component: "npm",
    label: "Node.js 的 npm（安装 tscircuit 依赖）",
    installability: "manual",
    why: "首次构建要在 hardware/circuit 下执行 npm install 拉 tscircuit 及其 259 个依赖。",
    sizeHint: "Node.js 约 30 MB；依赖下载约 730 MB",
    needsAccount: false,
    steps: [
      {
        title: "安装 Node.js LTS",
        detail: "npm 随 Node.js 一起安装；装完新开终端确认 PATH 生效。",
        command: "winget install OpenJS.NodeJS.LTS",
      },
      {
        title: "已有 Node.js 时确认 npm 在 PATH",
        detail: "插件通过 PATH 找 npm；nvm 等多版本管理器需要先切到有 npm 的版本。",
      },
    ],
    verify: "npm --version",
  };
}

/**
 * poppler（S117）：PDF 的文字、页面渲染与图内位图。
 *
 * 选 poppler 而不是 pymupdf：一个 pacman 包同时给出 pdftotext / pdfinfo / pdftoppm /
 * pdftocairo，都是独立可执行文件，不需要往任何 Python 环境里装库。
 */
export function popplerGuide(): InstallGuide {
  return {
    component: "poppler",
    label: "poppler（PDF 文字与页面渲染）",
    installability: "auto",
    why: "读数据手册与原理图 PDF 时，文字与表格交给 pdftotext，曲线与控制框图交给 pdftoppm 渲染成图像。",
    sizeHint: "约 11 MB（含 poppler-data）",
    needsAccount: false,
    steps: [
      {
        title: "在 MSYS2 里装",
        detail: "打开 MSYS2 UCRT64 终端执行下面的命令；装到 ucrt64/bin，插件默认会检索这个目录。",
        command: "pacman -S --needed mingw-w64-ucrt-x86_64-poppler",
      },
      {
        title: "确认三个命令都在",
        detail: "pdftotext、pdfinfo、pdftoppm 都要能找到；缺一个就重装整包（poppler-data 一并装上）。",
        command: "pdftotext -v && pdfinfo -v && pdftoppm -v",
      },
      {
        title: "不在默认目录时指路径",
        detail: "把 bin 目录写进配置项 binDirs，或在会话里设 DSH_STM32_BIN_DIRS。",
        command: 'setx DSH_STM32_BIN_DIRS "C:/msys64/ucrt64/bin"',
      },
    ],
    verify: "stm32_doctor（poppler 一行应显示版本号）",
  };
}
