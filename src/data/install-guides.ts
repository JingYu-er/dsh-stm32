/**
 * L1：装不上（或不该由插件代装）的东西，怎么把话说清楚。
 *
 * 门禁把缺件分成两档，因为这两档的"下一步"完全不同：
 *   auto   —— MSYS2 里一条 pacman 就能补（gcc / gdb / openocd / cmake / ninja），
 *             插件能跑 stm32_env_install 出计划、确认后自己装；
 *   manual —— 装不了或不该代装：STM32CubeMX 是 InstallAnywhere 的 GUI 向导（要 ST 账号 +
 *             同意许可），固件包只由 CubeMX 的包管理器维护（st.com 包清单 + 22 个 git 子模块）。
 *             这两样只能给人一步步的指引，插件顶多帮它把路径写进配置。
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
  | "firmware";

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
};

export interface InstallStep {
  /** 一句话动作。 */
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
  /** 为什么不能（或不划算）自动装 —— 这句话要能直接回给用户。 */
  why: string;
  /** 体积/耗时预期，省得用户以为几十 MB 就完事。 */
  sizeHint: string;
  /** 是否需要 ST 账号 / 许可同意。 */
  needsAccount: boolean;
  steps: InstallStep[];
  /** 装完怎么自检（一条判据）。 */
  verify: string;
  /** 免安装路径：把已有安装拷过来就行。 */
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
      + "插件代装等于替你点同意、替你输账号 —— 这一步不做。",
    sizeHint: "安装包数百 MB，装完约 1.5 GB（不含固件包）；固件包另算，见固件包那条指引（实测 250 MB – 1.7 GB）。",
    needsAccount: true,
    steps: [
      {
        title: "下载 CubeMX 安装包",
        detail: "打开 https://www.st.com/en/development-tools/stm32cubemx.html → Get Software，登录/注册 ST 账号并同意许可后下载 Windows 安装包（.exe）。",
      },
      {
        title: "GUI 装一遍（默认选项即可）",
        detail: "双击安装包按向导走完；装到哪个盘都行，别放在受保护目录（例如 C:\\Program Files 需要管理员权限，插件写固件包时会失败）。",
      },
      {
        title: "把安装根写进配置",
        detail: "安装根 = 同时含 STM32CubeMX.exe 与 jre\\bin\\java.exe 的那个目录。让插件写：stm32_env_install 只做配置落盘，或手动编辑 %USERPROFILE%\\.dsh-stm32\\config.json 的 cubeMxRoot。",
      },
      {
        title: "自检",
        detail: "stm32_env_probe 的 tools 里 cubemx 与 cubemx-java 都应带 path；缺 jre 的话无头生成会直接报 java 找不到。",
      },
    ],
    verify: "stm32_env_probe → capabilities.generate 为 true（cubemx 与 cubemx-java 都找到）。",
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
 * 写死一句话会被别的系列看笑话：F1 293 MB、G4 471 MB、F4 1.67 GB，差 6 倍。
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
  "一个系列通常 250 MB – 1.7 GB / 一万到四万个文件（不同系列差很多，最多差 6 倍）；装完占盘同量级。";

/** 固件包体积提示：认识的系列精确、不认识给区间（别把 F1 的数字扣到 H7 头上）。 */
export function firmwareSizeHint(family: string): string {
  const key = family.trim().toUpperCase();
  return FIRMWARE_SIZE_HINTS[key] ?? FIRMWARE_SIZE_FALLBACK;
}

/**
 * 固件包（HAL + CMSIS + startup）的安装指引。
 *
 * 为什么不做成自动下载（2026-10 取证）：GitHub 上 STMicroelectronics/STM32CubeF1 有 v1.8.7 标签，
 * 但主仓库挂了 22 个 git 子模块，tarball 里 Drivers/CMSIS/Device/ST/STM32F1xx 与
 * Drivers/STM32F1xx_HAL_Driver 是**空目录**；拼出来的包 CubeMX 认不认还没验证。
 * 所以现在归 manual：让 CubeMX 自己的包管理器装（它写的 package.xml / 包清单才是权威）。
 */
export function firmwareGuide(input: FirmwareGuideInput): InstallGuide {
  const prefix = familyPrefix(input.family);
  const autoDownloadable = input.family !== "" && input.family.toUpperCase() in FIRMWARE_FAMILIES;
  const name = input.packageName === "" ? "STM32Cube_FW_" + (input.family === "" ? "<族>" : input.family) + "_V<版本>" : input.packageName;
  return {
    component: "firmware",
    label: "固件包 " + name,
    installability: "manual",
    why:
      "固件包不在 CubeMX 安装包里，而且不是单个压缩包：HAL 驱动、CMSIS 设备头、启动文件分在不同的 git 仓库里，"
      + "GitHub 的源码压缩包拿到的是空目录。可靠的来源只有 CubeMX 自己的包管理器（它写包清单与 package.xml）。",
    sizeHint: firmwareSizeHint(input.family),
    needsAccount: true,
    steps: [
      {
        title: autoDownloadable
          ? "先试插件代下（这一代已接入）"
          : "插件还不会代下这一代",
        detail: autoDownloadable
          ? "调 stm32_firmware_install（family 给 " + input.family + "，dryRun:false + confirm:true）：插件从 GitHub 拉 HAL 驱动与 CMSIS 设备两个子模块仓库 + 内核头，自己补 package.xml，实测 CubeMX 认；约 2 MB，几十秒。拉不到或想用官方包再走下面三步。"
          : "目前只有 F1 接入自动下载（其余代按同样字段补一条即可）；这一代请走下面的 CubeMX 包管理器。",
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
        detail: "从有网的机器把 " + name + " 整个目录（或整个 Repository 目录）拷到目标机同一位置即可，不需要重装 CubeMX。",
      },
      {
        title: "自检",
        detail: "目录里应同时有 Drivers\\" + prefix + "_HAL_Driver、Drivers\\CMSIS\\Include、Drivers\\CMSIS\\Device\\ST\\" + prefix + "\\Source\\Templates。",
      },
    ],
    verify: "stm32_generate 不再报「找不到 CubeMX 固件包」，或 stm32_route_plan 的 firmware.found 为 true。",
  };
}

/** 组件 id → 指引；auto 组件没有指引（它们走 stm32_env_install）。cubemx 与 cubemx-java 共用一份。 */
export function guideFor(component: string): InstallGuide | null {
  if (component === "cubemx" || component === "cubemx-java") return cubeMxGuide();
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
