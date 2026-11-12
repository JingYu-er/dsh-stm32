/**
 * 固件包（STM32Cube_FW_<族>_V<版本>）的组装清单。
 *
 * 背景（2026-10 实测，见 docs §14）：ST 的固件包不是整体下载的，GitHub 上的 STM32Cube<族>
 * 主仓库将 HAL 驱动与 CMSIS 设备支持均设为 git 子模块 —— 仅拉取主仓库 tarball，
 * Drivers/STM32F1xx_HAL_Driver 与 Drivers/CMSIS/Device/ST/STM32F1xx 是**空目录**，
 * 编译必然失败。因此需分别拉取：
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
import { FIRMWARE_ARCHIVE_PINS, FIRMWARE_CORE_PINS } from "./firmware-pins.js";

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

/** 计划里的归档：清单字段 + 钉死的哈希（缺失时 firmwarePlanFor 直接失败，不会走到这里）。 */
export interface FirmwareArchivePlan extends FirmwareArchiveSpec {
  sha256: string;
  bytes: number;
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

/**
 * 归档只有一条官方地址（P0-2）：codeload 直连。
 *
 * 移除 ghproxy / api 回退的原因：同一个 commit 经不同入口打包，gzip 头与顶层目录名不同，
 * 字节哈希不一致——单个 sha256 不能同时校验三条链路。保留这类回退要么使「校验形同虚设」，
 * 要么使「第二条始终失败」。ghproxy 还为第三方中间人，固件包不应依赖该服务。
 */
function archiveUrls(repo: string, ref: string): string[] {
  return ["https://codeload.github.com/STMicroelectronics/" + repo + "/tar.gz/refs/heads/" + ref];
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
  F2: {
    family: "F2",
    packageBase: "STM32Cube_FW_F2",
    defaultVersion: "1.9.3",
    halDir: "Drivers/STM32F2xx_HAL_Driver",
    deviceDir: "Drivers/CMSIS/Device/ST/STM32F2xx",
    coreRepo: "STM32CubeF2",
    coreRef: "master",
    coreIncludeDir: "Drivers/CMSIS/Include",
    coreHeaders: ["cmsis_compiler.h", "cmsis_gcc.h", "cmsis_version.h", "mpu_armv7.h", "core_cm3.h"],
    archives: [
      {
        id: "hal",
        label: "HAL 驱动（stm32f2xx-hal-driver）",
        repo: "stm32f2xx-hal-driver",
        ref: "master",
        dirs: [
          { from: "Inc", to: "Drivers/STM32F2xx_HAL_Driver/Inc" },
          { from: "Src", to: "Drivers/STM32F2xx_HAL_Driver/Src" },
        ],
        urls: archiveUrls("stm32f2xx-hal-driver", "master"),
      },
      {
        id: "device",
        label: "CMSIS 设备支持（cmsis-device-f2）",
        repo: "cmsis-device-f2",
        ref: "master",
        dirs: [
          { from: "Include", to: "Drivers/CMSIS/Device/ST/STM32F2xx/Include" },
          { from: "Source", to: "Drivers/CMSIS/Device/ST/STM32F2xx/Source" },
        ],
        urls: archiveUrls("cmsis-device-f2", "master"),
      },
    ],
  },
  F3: {
    family: "F3",
    packageBase: "STM32Cube_FW_F3",
    defaultVersion: "1.11.5",
    halDir: "Drivers/STM32F3xx_HAL_Driver",
    deviceDir: "Drivers/CMSIS/Device/ST/STM32F3xx",
    coreRepo: "STM32CubeF3",
    coreRef: "master",
    coreIncludeDir: "Drivers/CMSIS/Include",
    coreHeaders: ["cmsis_compiler.h", "cmsis_gcc.h", "cmsis_version.h", "mpu_armv7.h", "core_cm4.h"],
    archives: [
      {
        id: "hal",
        label: "HAL 驱动（stm32f3xx-hal-driver）",
        repo: "stm32f3xx-hal-driver",
        ref: "master",
        dirs: [
          { from: "Inc", to: "Drivers/STM32F3xx_HAL_Driver/Inc" },
          { from: "Src", to: "Drivers/STM32F3xx_HAL_Driver/Src" },
        ],
        urls: archiveUrls("stm32f3xx-hal-driver", "master"),
      },
      {
        id: "device",
        label: "CMSIS 设备支持（cmsis-device-f3）",
        repo: "cmsis-device-f3",
        ref: "master",
        dirs: [
          { from: "Include", to: "Drivers/CMSIS/Device/ST/STM32F3xx/Include" },
          { from: "Source", to: "Drivers/CMSIS/Device/ST/STM32F3xx/Source" },
        ],
        urls: archiveUrls("cmsis-device-f3", "master"),
      },
    ],
  },
  F7: {
    family: "F7",
    packageBase: "STM32Cube_FW_F7",
    defaultVersion: "1.17.4",
    halDir: "Drivers/STM32F7xx_HAL_Driver",
    deviceDir: "Drivers/CMSIS/Device/ST/STM32F7xx",
    coreRepo: "STM32CubeF7",
    coreRef: "master",
    coreIncludeDir: "Drivers/CMSIS/Include",
    // F7 这份 CMSIS 的 core_cm7.h 只 include cmsis_version/cmsis_compiler/mpu_armv7；
    // 实测仓库里没有 cachel1_armv7.h（H7 才有），别照 H7 抄成六个头，否则安装必 404。
    coreHeaders: ["cmsis_compiler.h", "cmsis_gcc.h", "cmsis_version.h", "mpu_armv7.h", "core_cm7.h"],
    archives: [
      {
        id: "hal",
        label: "HAL 驱动（stm32f7xx-hal-driver）",
        repo: "stm32f7xx-hal-driver",
        ref: "master",
        dirs: [
          { from: "Inc", to: "Drivers/STM32F7xx_HAL_Driver/Inc" },
          { from: "Src", to: "Drivers/STM32F7xx_HAL_Driver/Src" },
        ],
        urls: archiveUrls("stm32f7xx-hal-driver", "master"),
      },
      {
        id: "device",
        label: "CMSIS 设备支持（cmsis-device-f7）",
        repo: "cmsis-device-f7",
        ref: "master",
        dirs: [
          { from: "Include", to: "Drivers/CMSIS/Device/ST/STM32F7xx/Include" },
          { from: "Source", to: "Drivers/CMSIS/Device/ST/STM32F7xx/Source" },
        ],
        urls: archiveUrls("cmsis-device-f7", "master"),
      },
    ],
  },
  G0: {
    family: "G0",
    packageBase: "STM32Cube_FW_G0",
    defaultVersion: "1.6.2",
    halDir: "Drivers/STM32G0xx_HAL_Driver",
    deviceDir: "Drivers/CMSIS/Device/ST/STM32G0xx",
    coreRepo: "STM32CubeG0",
    coreRef: "master",
    coreIncludeDir: "Drivers/CMSIS/Include",
    coreHeaders: ["cmsis_compiler.h", "cmsis_gcc.h", "cmsis_version.h", "mpu_armv7.h", "core_cm0plus.h"],
    archives: [
      {
        id: "hal",
        label: "HAL 驱动（stm32g0xx-hal-driver）",
        repo: "stm32g0xx-hal-driver",
        ref: "master",
        dirs: [
          { from: "Inc", to: "Drivers/STM32G0xx_HAL_Driver/Inc" },
          { from: "Src", to: "Drivers/STM32G0xx_HAL_Driver/Src" },
        ],
        urls: archiveUrls("stm32g0xx-hal-driver", "master"),
      },
      {
        id: "device",
        label: "CMSIS 设备支持（cmsis-device-g0）",
        repo: "cmsis-device-g0",
        ref: "master",
        dirs: [
          { from: "Include", to: "Drivers/CMSIS/Device/ST/STM32G0xx/Include" },
          { from: "Source", to: "Drivers/CMSIS/Device/ST/STM32G0xx/Source" },
        ],
        urls: archiveUrls("cmsis-device-g0", "master"),
      },
    ],
  },
  L1: {
    family: "L1",
    packageBase: "STM32Cube_FW_L1",
    defaultVersion: "1.10.6",
    halDir: "Drivers/STM32L1xx_HAL_Driver",
    deviceDir: "Drivers/CMSIS/Device/ST/STM32L1xx",
    coreRepo: "STM32CubeL1",
    coreRef: "master",
    coreIncludeDir: "Drivers/CMSIS/Include",
    coreHeaders: ["cmsis_compiler.h", "cmsis_gcc.h", "cmsis_version.h", "mpu_armv7.h", "core_cm3.h"],
    archives: [
      {
        id: "hal",
        label: "HAL 驱动（stm32l1xx-hal-driver）",
        repo: "stm32l1xx-hal-driver",
        ref: "master",
        dirs: [
          { from: "Inc", to: "Drivers/STM32L1xx_HAL_Driver/Inc" },
          { from: "Src", to: "Drivers/STM32L1xx_HAL_Driver/Src" },
        ],
        urls: archiveUrls("stm32l1xx-hal-driver", "master"),
      },
      {
        id: "device",
        label: "CMSIS 设备支持（cmsis-device-l1）",
        repo: "cmsis-device-l1",
        ref: "master",
        dirs: [
          { from: "Include", to: "Drivers/CMSIS/Device/ST/STM32L1xx/Include" },
          { from: "Source", to: "Drivers/CMSIS/Device/ST/STM32L1xx/Source" },
        ],
        urls: archiveUrls("cmsis-device-l1", "master"),
      },
    ],
  },
  L4: {
    family: "L4",
    packageBase: "STM32Cube_FW_L4",
    defaultVersion: "1.18.2",
    halDir: "Drivers/STM32L4xx_HAL_Driver",
    deviceDir: "Drivers/CMSIS/Device/ST/STM32L4xx",
    coreRepo: "STM32CubeL4",
    coreRef: "master",
    coreIncludeDir: "Drivers/CMSIS/Include",
    coreHeaders: ["cmsis_compiler.h", "cmsis_gcc.h", "cmsis_version.h", "mpu_armv7.h", "core_cm4.h"],
    archives: [
      {
        id: "hal",
        label: "HAL 驱动（stm32l4xx-hal-driver）",
        repo: "stm32l4xx-hal-driver",
        ref: "master",
        dirs: [
          { from: "Inc", to: "Drivers/STM32L4xx_HAL_Driver/Inc" },
          { from: "Src", to: "Drivers/STM32L4xx_HAL_Driver/Src" },
        ],
        urls: archiveUrls("stm32l4xx-hal-driver", "master"),
      },
      {
        id: "device",
        label: "CMSIS 设备支持（cmsis-device-l4）",
        repo: "cmsis-device-l4",
        ref: "master",
        dirs: [
          { from: "Include", to: "Drivers/CMSIS/Device/ST/STM32L4xx/Include" },
          { from: "Source", to: "Drivers/CMSIS/Device/ST/STM32L4xx/Source" },
        ],
        urls: archiveUrls("cmsis-device-l4", "master"),
      },
    ],
  },
  U0: {
    family: "U0",
    packageBase: "STM32Cube_FW_U0",
    defaultVersion: "1.2.0",
    halDir: "Drivers/STM32U0xx_HAL_Driver",
    deviceDir: "Drivers/CMSIS/Device/ST/STM32U0xx",
    coreRepo: "STM32CubeU0",
    coreRef: "main",
    coreIncludeDir: "Drivers/CMSIS/Include",
    coreHeaders: ["cmsis_compiler.h", "cmsis_gcc.h", "cmsis_version.h", "mpu_armv7.h", "core_cm0plus.h"],
    archives: [
      {
        id: "hal",
        label: "HAL 驱动（stm32u0xx-hal-driver）",
        repo: "stm32u0xx-hal-driver",
        ref: "main",
        dirs: [
          { from: "Inc", to: "Drivers/STM32U0xx_HAL_Driver/Inc" },
          { from: "Src", to: "Drivers/STM32U0xx_HAL_Driver/Src" },
        ],
        urls: archiveUrls("stm32u0xx-hal-driver", "main"),
      },
      {
        id: "device",
        label: "CMSIS 设备支持（cmsis-device-u0）",
        repo: "cmsis-device-u0",
        ref: "main",
        dirs: [
          { from: "Include", to: "Drivers/CMSIS/Device/ST/STM32U0xx/Include" },
          { from: "Source", to: "Drivers/CMSIS/Device/ST/STM32U0xx/Source" },
        ],
        urls: archiveUrls("cmsis-device-u0", "main"),
      },
    ],
  },
  C0: {
    family: "C0",
    packageBase: "STM32Cube_FW_C0",
    defaultVersion: "1.4.1",
    halDir: "Drivers/STM32C0xx_HAL_Driver",
    deviceDir: "Drivers/CMSIS/Device/ST/STM32C0xx",
    coreRepo: "STM32CubeC0",
    coreRef: "main",
    coreIncludeDir: "Drivers/CMSIS/Include",
    coreHeaders: ["cmsis_compiler.h", "cmsis_gcc.h", "cmsis_version.h", "mpu_armv7.h", "core_cm0plus.h"],
    archives: [
      {
        id: "hal",
        label: "HAL 驱动（stm32c0xx-hal-driver）",
        repo: "stm32c0xx-hal-driver",
        ref: "main",
        dirs: [
          { from: "Inc", to: "Drivers/STM32C0xx_HAL_Driver/Inc" },
          { from: "Src", to: "Drivers/STM32C0xx_HAL_Driver/Src" },
        ],
        urls: archiveUrls("stm32c0xx-hal-driver", "main"),
      },
      {
        id: "device",
        label: "CMSIS 设备支持（cmsis-device-c0）",
        repo: "cmsis-device-c0",
        ref: "main",
        dirs: [
          { from: "Include", to: "Drivers/CMSIS/Device/ST/STM32C0xx/Include" },
          { from: "Source", to: "Drivers/CMSIS/Device/ST/STM32C0xx/Source" },
        ],
        urls: archiveUrls("cmsis-device-c0", "main"),
      },
    ],
  },
  H5: {
    family: "H5",
    packageBase: "STM32Cube_FW_H5",
    defaultVersion: "1.5.1",
    halDir: "Drivers/STM32H5xx_HAL_Driver",
    deviceDir: "Drivers/CMSIS/Device/ST/STM32H5xx",
    coreRepo: "STM32CubeH5",
    coreRef: "main",
    coreIncludeDir: "Drivers/CMSIS/Include",
    coreHeaders: ["cmsis_compiler.h", "cmsis_gcc.h", "cmsis_version.h", "mpu_armv8.h", "core_cm33.h"],
    archives: [
      {
        id: "hal",
        label: "HAL 驱动（stm32h5xx_hal_driver）",
        repo: "stm32h5xx_hal_driver",
        ref: "main",
        dirs: [
          { from: "Inc", to: "Drivers/STM32H5xx_HAL_Driver/Inc" },
          { from: "Src", to: "Drivers/STM32H5xx_HAL_Driver/Src" },
        ],
        urls: archiveUrls("stm32h5xx_hal_driver", "main"),
      },
      {
        id: "device",
        label: "CMSIS 设备支持（cmsis_device_h5）",
        repo: "cmsis_device_h5",
        ref: "main",
        dirs: [
          { from: "Include", to: "Drivers/CMSIS/Device/ST/STM32H5xx/Include" },
          { from: "Source", to: "Drivers/CMSIS/Device/ST/STM32H5xx/Source" },
        ],
        urls: archiveUrls("cmsis_device_h5", "main"),
      },
    ],
  },
  U5: {
    family: "U5",
    packageBase: "STM32Cube_FW_U5",
    defaultVersion: "1.8.0",
    halDir: "Drivers/STM32U5xx_HAL_Driver",
    deviceDir: "Drivers/CMSIS/Device/ST/STM32U5xx",
    coreRepo: "STM32CubeU5",
    coreRef: "main",
    coreIncludeDir: "Drivers/CMSIS/Include",
    coreHeaders: ["cmsis_compiler.h", "cmsis_gcc.h", "cmsis_version.h", "mpu_armv8.h", "core_cm33.h"],
    archives: [
      {
        id: "hal",
        label: "HAL 驱动（stm32u5xx_hal_driver）",
        repo: "stm32u5xx_hal_driver",
        ref: "main",
        dirs: [
          { from: "Inc", to: "Drivers/STM32U5xx_HAL_Driver/Inc" },
          { from: "Src", to: "Drivers/STM32U5xx_HAL_Driver/Src" },
        ],
        urls: archiveUrls("stm32u5xx_hal_driver", "main"),
      },
      {
        id: "device",
        label: "CMSIS 设备支持（cmsis_device_u5）",
        repo: "cmsis_device_u5",
        ref: "main",
        dirs: [
          { from: "Include", to: "Drivers/CMSIS/Device/ST/STM32U5xx/Include" },
          { from: "Source", to: "Drivers/CMSIS/Device/ST/STM32U5xx/Source" },
        ],
        urls: archiveUrls("cmsis_device_u5", "main"),
      },
    ],
  },
  WBA: {
    family: "WBA",
    packageBase: "STM32Cube_FW_WBA",
    defaultVersion: "1.7.0",
    halDir: "Drivers/STM32WBAxx_HAL_Driver",
    deviceDir: "Drivers/CMSIS/Device/ST/STM32WBAxx",
    coreRepo: "STM32CubeWBA",
    coreRef: "main",
    coreIncludeDir: "Drivers/CMSIS/Include",
    coreHeaders: ["cmsis_compiler.h", "cmsis_gcc.h", "cmsis_version.h", "mpu_armv8.h", "core_cm33.h"],
    archives: [
      {
        id: "hal",
        label: "HAL 驱动（stm32wbaxx_hal_driver）",
        repo: "stm32wbaxx_hal_driver",
        ref: "main",
        dirs: [
          { from: "Inc", to: "Drivers/STM32WBAxx_HAL_Driver/Inc" },
          { from: "Src", to: "Drivers/STM32WBAxx_HAL_Driver/Src" },
        ],
        urls: archiveUrls("stm32wbaxx_hal_driver", "main"),
      },
      {
        id: "device",
        label: "CMSIS 设备支持（cmsis_device_wba）",
        repo: "cmsis_device_wba",
        ref: "main",
        dirs: [
          { from: "Include", to: "Drivers/CMSIS/Device/ST/STM32WBAxx/Include" },
          { from: "Source", to: "Drivers/CMSIS/Device/ST/STM32WBAxx/Source" },
        ],
        urls: archiveUrls("cmsis_device_wba", "main"),
      },
    ],
  },
  L5: {
    family: "L5",
    packageBase: "STM32Cube_FW_L5",
    defaultVersion: "1.5.0",
    halDir: "Drivers/STM32L5xx_HAL_Driver",
    deviceDir: "Drivers/CMSIS/Device/ST/STM32L5xx",
    coreRepo: "STM32CubeL5",
    coreRef: "master",
    coreIncludeDir: "Drivers/CMSIS/Include",
    coreHeaders: ["cmsis_compiler.h", "cmsis_gcc.h", "cmsis_version.h", "mpu_armv8.h", "core_cm33.h"],
    archives: [
      {
        id: "hal",
        label: "HAL 驱动（stm32l5xx_hal_driver）",
        repo: "stm32l5xx_hal_driver",
        ref: "master",
        dirs: [
          { from: "Inc", to: "Drivers/STM32L5xx_HAL_Driver/Inc" },
          { from: "Src", to: "Drivers/STM32L5xx_HAL_Driver/Src" },
        ],
        urls: archiveUrls("stm32l5xx_hal_driver", "master"),
      },
      {
        id: "device",
        label: "CMSIS 设备支持（cmsis_device_l5）",
        repo: "cmsis_device_l5",
        ref: "master",
        dirs: [
          { from: "Include", to: "Drivers/CMSIS/Device/ST/STM32L5xx/Include" },
          { from: "Source", to: "Drivers/CMSIS/Device/ST/STM32L5xx/Source" },
        ],
        urls: archiveUrls("cmsis_device_l5", "master"),
      },
    ],
  },
  WB: {
    family: "WB",
    packageBase: "STM32Cube_FW_WB",
    defaultVersion: "1.23.0",
    halDir: "Drivers/STM32WBxx_HAL_Driver",
    deviceDir: "Drivers/CMSIS/Device/ST/STM32WBxx",
    coreRepo: "STM32CubeWB",
    coreRef: "master",
    coreIncludeDir: "Drivers/CMSIS/Include",
    coreHeaders: ["cmsis_compiler.h", "cmsis_gcc.h", "cmsis_version.h", "mpu_armv7.h", "core_cm4.h"],
    archives: [
      {
        id: "hal",
        label: "HAL 驱动（stm32wbxx_hal_driver）",
        repo: "stm32wbxx_hal_driver",
        ref: "master",
        dirs: [
          { from: "Inc", to: "Drivers/STM32WBxx_HAL_Driver/Inc" },
          { from: "Src", to: "Drivers/STM32WBxx_HAL_Driver/Src" },
        ],
        urls: archiveUrls("stm32wbxx_hal_driver", "master"),
      },
      {
        id: "device",
        label: "CMSIS 设备支持（cmsis_device_wb）",
        repo: "cmsis_device_wb",
        ref: "master",
        dirs: [
          { from: "Include", to: "Drivers/CMSIS/Device/ST/STM32WBxx/Include" },
          { from: "Source", to: "Drivers/CMSIS/Device/ST/STM32WBxx/Source" },
        ],
        urls: archiveUrls("cmsis_device_wb", "master"),
      },
    ],
  },
  WL: {
    family: "WL",
    packageBase: "STM32Cube_FW_WL",
    defaultVersion: "1.3.0",
    halDir: "Drivers/STM32WLxx_HAL_Driver",
    deviceDir: "Drivers/CMSIS/Device/ST/STM32WLxx",
    coreRepo: "STM32CubeWL",
    coreRef: "main",
    coreIncludeDir: "Drivers/CMSIS/Include",
    coreHeaders: ["cmsis_compiler.h", "cmsis_gcc.h", "cmsis_version.h", "mpu_armv7.h", "core_cm4.h"],
    archives: [
      {
        id: "hal",
        label: "HAL 驱动（stm32wlxx_hal_driver）",
        repo: "stm32wlxx_hal_driver",
        ref: "main",
        dirs: [
          { from: "Inc", to: "Drivers/STM32WLxx_HAL_Driver/Inc" },
          { from: "Src", to: "Drivers/STM32WLxx_HAL_Driver/Src" },
        ],
        urls: archiveUrls("stm32wlxx_hal_driver", "main"),
      },
      {
        id: "device",
        label: "CMSIS 设备支持（cmsis_device_wl）",
        repo: "cmsis_device_wl",
        ref: "main",
        dirs: [
          { from: "Include", to: "Drivers/CMSIS/Device/ST/STM32WLxx/Include" },
          { from: "Source", to: "Drivers/CMSIS/Device/ST/STM32WLxx/Source" },
        ],
        urls: archiveUrls("cmsis_device_wl", "main"),
      },
    ],
  },
  H7: {
    family: "H7",
    packageBase: "STM32Cube_FW_H7",
    defaultVersion: "1.11.0",
    halDir: "Drivers/STM32H7xx_HAL_Driver",
    deviceDir: "Drivers/CMSIS/Device/ST/STM32H7xx",
    coreRepo: "STM32CubeH7",
    coreRef: "master",
    coreIncludeDir: "Drivers/CMSIS/Include",
    // CM7 的 core_cm7.h 会 include cachel1_armv7.h（L1 cache 维护）：缺失该文件将导致编译直接 fatal error。
    coreHeaders: ["cmsis_compiler.h", "cmsis_gcc.h", "cmsis_version.h", "mpu_armv7.h", "cachel1_armv7.h", "core_cm7.h"],
    archives: [
      {
        id: "hal",
        label: "HAL 驱动（stm32h7xx_hal_driver）",
        repo: "stm32h7xx_hal_driver",
        ref: "master",
        dirs: [
          { from: "Inc", to: "Drivers/STM32H7xx_HAL_Driver/Inc" },
          { from: "Src", to: "Drivers/STM32H7xx_HAL_Driver/Src" },
        ],
        urls: archiveUrls("stm32h7xx_hal_driver", "master"),
      },
      {
        id: "device",
        label: "CMSIS 设备支持（cmsis_device_h7）",
        repo: "cmsis_device_h7",
        ref: "master",
        dirs: [
          { from: "Include", to: "Drivers/CMSIS/Device/ST/STM32H7xx/Include" },
          { from: "Source", to: "Drivers/CMSIS/Device/ST/STM32H7xx/Source" },
        ],
        urls: archiveUrls("cmsis_device_h7", "master"),
      },
    ],
  },
  U3: {
    family: "U3",
    packageBase: "STM32Cube_FW_U3",
    defaultVersion: "1.2.0",
    halDir: "Drivers/STM32U3xx_HAL_Driver",
    deviceDir: "Drivers/CMSIS/Device/ST/STM32U3xx",
    coreRepo: "STM32CubeU3",
    coreRef: "main",
    coreIncludeDir: "Drivers/CMSIS/Include",
    coreHeaders: ["cmsis_compiler.h", "cmsis_gcc.h", "cmsis_version.h", "mpu_armv8.h", "core_cm33.h"],
    archives: [
      {
        id: "hal",
        label: "HAL 驱动（stm32u3xx-hal-driver）",
        repo: "stm32u3xx-hal-driver",
        ref: "main",
        dirs: [
          { from: "Inc", to: "Drivers/STM32U3xx_HAL_Driver/Inc" },
          { from: "Src", to: "Drivers/STM32U3xx_HAL_Driver/Src" },
        ],
        urls: archiveUrls("stm32u3xx-hal-driver", "main"),
      },
      {
        id: "device",
        label: "CMSIS 设备支持（cmsis-device-u3）",
        repo: "cmsis-device-u3",
        ref: "main",
        dirs: [
          { from: "Include", to: "Drivers/CMSIS/Device/ST/STM32U3xx/Include" },
          { from: "Source", to: "Drivers/CMSIS/Device/ST/STM32U3xx/Source" },
        ],
        urls: archiveUrls("cmsis-device-u3", "main"),
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
  archives: FirmwareArchivePlan[];
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
  const missingPins: string[] = [];
  const archives = spec.archives.map((archive) => {
    const pin = FIRMWARE_ARCHIVE_PINS[archive.repo + "@" + archive.ref];
    if (pin === undefined) missingPins.push(archive.repo + "@" + archive.ref);
    return { ...archive, sha256: pin?.sha256 ?? "", bytes: pin?.bytes ?? 0 };
  });
  const coreTargets: FetchTarget[] = spec.coreHeaders.map((header) => {
    const key = spec.coreRepo + "@" + spec.coreRef + "/" + spec.coreIncludeDir + "/" + header;
    const pin = FIRMWARE_CORE_PINS[key];
    if (pin === undefined) missingPins.push(key);
    return {
      path: header,
      urls: sourceUrls(spec.coreRepo, spec.coreRef, spec.coreIncludeDir + "/" + header),
      minBytes: 500,
      ...(pin === undefined ? {} : { sha256: pin.sha256 }),
    };
  });
  if (missingPins.length > 0) {
    return emptyPlan(
      "固件包清单缺 sha256（" + missingPins.join("、") + "）。请先跑 scripts/firmware/pin-firmware.mjs 并提交 src/data/firmware-pins.ts。",
      family,
      version,
    );
  }
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
    "CubeMX 识别该目录（实测），但 ST 的包管理器不会维护该目录：升级时请用 CubeMX 包管理器重装官方包。",
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
    archives,
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
 * 必须自查的原因：CubeMX 找不到包时**不报错**（docs §14），仅凭其打印 Code succesfully generated 会造成误判。
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
 * 从 .ioc 正文中读取所需的固件包。
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

export type FirmwarePackageSource = "repository" | "dsh-firmware" | "cache" | "custom" | "";

/**
 * 额外搜索位置（generate 用）：下载缓存 <cacheRoot>/firmware 里放的是包目录们，
 * 而调用方指定的 targetDir 本身就是包目录 —— 两种形状都由 locateFirmwarePackage 认。
 * 需要该逻辑的原因：固件包安装到 cache 或自定义目录后，仅搜索 CubeMX 根的 generate 在结构上无法发现该包，
 * 于是打印「可以用 stm32_firmware_install 装到 dsh-firmware 下」把用户指回刚做过的事。
 */
export interface FirmwareExtraDir {
  dir: string;
  source: "cache" | "custom";
}

/** 来源的人话。报告、进度、终端文案都从这里取，避免各处各写一份两值三元把 cache/custom 漏成空标签。 */
export function firmwareSourceLabel(source: FirmwarePackageSource): string {
  switch (source) {
    case "repository":
      return "CubeMX 仓库";
    case "dsh-firmware":
      return "插件的 dsh-firmware 目录";
    case "cache":
      return "插件的下载缓存";
    case "custom":
      return "调用方指定的目录";
    default:
      return "";
  }
}

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
 * 两处都查找的原因：官方包零拷贝直接使用；没有官方包时才使用插件组装的那份。
 */
export function locateFirmwarePackage(
  cubeMxRoots: readonly string[],
  request: { packageName?: string; family?: string; extraDirs?: readonly FirmwareExtraDir[] } = {},
): FirmwareLocation {
  const wanted = (request.packageName ?? "").trim();
  const family = (request.family ?? "").trim().toUpperCase();
  const checked: string[] = [];
  const found: { dir: string; dirName: string; source: FirmwarePackageSource }[] = [];
  const accept = (parent: string, source: FirmwarePackageSource): void => {
    let names: string[];
    try {
      names = readdirSync(parent);
    } catch {
      return;
    }
    for (const name of names) {
      if (!/^STM32Cube_FW_[A-Za-z0-9]+_V[0-9.]+$/u.test(name)) continue;
      if (family !== "" && !name.startsWith("STM32Cube_FW_" + family + "_")) continue;
      const dir = parent + "/" + name;
      if (!looksLikeFirmwarePackage(dir)) continue;
      found.push({ dir, dirName: name, source });
    }
  };
  for (const root of cubeMxRoots) {
    const base = root.trim().replace(/[\\/]+$/u, "");
    if (base === "") continue;
    // <root>/Repository 里是包目录们；<root>/dsh-firmware 同理。
    checked.push(base + "/Repository");
    accept(base + "/Repository", "repository");
    checked.push(dshFirmwareDir(base));
    accept(dshFirmwareDir(base), "dsh-firmware");
  }
  for (const extra of request.extraDirs ?? []) {
    const dir = extra.dir.trim().split("\\").join("/").replace(/\/+$/u, "");
    if (dir === "") continue;
    checked.push(dir);
    const own = dir.split("/").pop() ?? "";
    if (/^STM32Cube_FW_[A-Za-z0-9]+_V[0-9.]+$/u.test(own)) {
      // 显式 targetDir 就是包本身，不是包目录的父目录。
      if (family !== "" && !own.startsWith("STM32Cube_FW_" + family + "_")) continue;
      if (looksLikeFirmwarePackage(dir)) found.push({ dir, dirName: own, source: extra.source });
      continue;
    }
    accept(dir, extra.source);
  }
  const ranked = found.sort((left, right) => {
    const leftExact = wanted !== "" && left.dirName === wanted ? 1 : 0;
    const rightExact = wanted !== "" && right.dirName === wanted ? 1 : 0;
    if (leftExact !== rightExact) return rightExact - leftExact;
    const leftVersion = left.dirName.replace(/^.*_V/u, "");
    const rightVersion = right.dirName.replace(/^.*_V/u, "");
    if (leftVersion !== rightVersion) return rightVersion.localeCompare(leftVersion, "en", { numeric: true });
    // 同一个包名+版本出现在多处时：官方仓库 > dsh-firmware > 指定目录 > 下载缓存。
    const rank = (source: FirmwarePackageSource): number =>
      source === "repository" ? 0 : source === "dsh-firmware" ? 1 : source === "custom" ? 2 : source === "cache" ? 3 : 9;
    if (left.source !== right.source) return rank(left.source) - rank(right.source);
    return 0;
  });
  const best = ranked[0];
  if (best === undefined) {
    return { found: false, dir: "", packageName: wanted, family, source: "", checked };
  }
  return { found: true, dir: best.dir, packageName: best.dirName, family, source: best.source, checked };
}
