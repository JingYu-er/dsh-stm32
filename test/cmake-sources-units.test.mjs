// L0 纯逻辑单测：cmake 源清单（老洞 —— CubeMX 从不重写 cmake/stm32cubemx/CMakeLists.txt）。
// 运行：node --test test/cmake-sources-units.test.mjs（需先 npm run build）
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CUBEMX_CMAKE_REL,
  collectCmakeSources,
  describeRefresh,
  deviceDefineFromStartup,
  familyTokensFromStartup,
  listStartupFiles,
  refreshCubemxCmakeLists,
} from "../lib/engine/cmake-sources.js";
import { cacheKeyFor, entryFromFiles, writeCache } from "../lib/engine/generate-cache.js";
import { runGenerate } from "../lib/engine/generate.js";

const TEMPLATE = fileURLToPath(new URL("../templates/scaffold/cmake/stm32cubemx/CMakeLists.txt", import.meta.url));
const DRIVER_DIR = "Drivers/STM32F1xx_HAL_Driver/Src";

// 模板里写死的那 11 个驱动源文件（去掉 system 与启动文件）。
const BASELINE_DRIVERS = [
  "gpio_ex",
  "",
  "rcc",
  "rcc_ex",
  "gpio",
  "dma",
  "cortex",
  "pwr",
  "flash",
  "flash_ex",
  "exti",
];

// 真实 hal_conf.h 里出现的 include 清单：每个模块都列一遍，但被 #ifdef 包住 —— 不能当「用到」。
const CONF_INCLUDES = [
  "adc", "can", "cec", "cortex", "crc", "dac", "dma", "eth", "exti", "flash", "gpio",
  "hcd", "i2c", "i2s", "irda", "iwdg", "mmc", "nand", "nor", "pccard", "pcd", "pwr",
  "rcc", "rtc", "sd", "smartcard", "spi", "sram", "tim", "uart", "usart", "wwdg",
];

const BASELINE_MODULES = ["cortex", "dma", "exti", "flash", "gpio", "pwr", "rcc"];

function touch(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function halConfText(modules) {
  const lines = ["#ifndef STM32F1xx_HAL_CONF_H", "#define STM32F1xx_HAL_CONF_H"];
  for (const module of modules) lines.push("#define HAL_" + module.toUpperCase() + "_MODULE_ENABLED");
  for (const module of CONF_INCLUDES) lines.push("#include \"stm32f1xx_hal_" + module + ".h\"");
  lines.push("#endif");
  return lines.join("\n") + "\n";
}

function mkProject(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-cmake-"));
  const startups = options.startups === undefined ? ["startup_stm32f103xb.s"] : options.startups;
  const modules = options.modules === undefined ? BASELINE_MODULES : options.modules;
  const extraDrivers = options.extraDrivers === undefined ? [] : options.extraDrivers;
  const driverBasenames = options.driverBasenames === undefined ? BASELINE_DRIVERS : options.driverBasenames;
  if (options.withCmake !== false) {
    touch(join(dir, CUBEMX_CMAKE_REL), readFileSync(TEMPLATE, "utf8"));
  }
  for (const startup of startups) touch(join(dir, startup), "/* startup */\n");
  touch(join(dir, "Core/Src/main.c"), "#include \"main.h\"\n");
  touch(join(dir, "Core/Src/stm32f1xx_it.c"), "/* it */\n");
  touch(join(dir, "Core/Src/stm32f1xx_hal_msp.c"), "/* msp */\n");
  touch(join(dir, "Core/Src/sysmem.c"), "/* sysmem */\n");
  touch(join(dir, "Core/Src/syscalls.c"), "/* syscalls */\n");
  touch(join(dir, "Core/Src/system_stm32f1xx.c"), "/* system */\n");
  touch(join(dir, "Core/Inc/main.h"), "#pragma once\n#include \"stm32f1xx_hal.h\"\n");
  touch(join(dir, "Core/Inc/stm32f1xx_hal_conf.h"), halConfText(modules));
  for (const name of [...driverBasenames, ...extraDrivers]) {
    const file = name === "" ? "stm32f1xx_hal.c" : "stm32f1xx_hal_" + name + ".c";
    touch(join(dir, DRIVER_DIR, file), "/* " + file + " */\n");
  }
  return dir;
}

function readCmake(dir) {
  return readFileSync(join(dir, CUBEMX_CMAKE_REL), "utf8");
}

test("deviceDefineFromStartup / familyTokensFromStartup：按文件名反推，不查表", () => {
  assert.equal(deviceDefineFromStartup("startup_stm32f103xb.s"), "STM32F103xB");
  assert.equal(deviceDefineFromStartup("startup_stm32f103xe.s"), "STM32F103xE");
  assert.equal(deviceDefineFromStartup("startup_stm32f107xc.s"), "STM32F107xC");
  assert.equal(deviceDefineFromStartup("startup_stm32f100xb.s"), "STM32F100xB");
  assert.deepEqual(familyTokensFromStartup("startup_stm32f103xb.s"), { token: "stm32f1xx", upper: "STM32F1xx" });
  assert.equal(familyTokensFromStartup("startup_stm32f407vg.s").upper, "STM32F4xx");
  assert.equal(familyTokensFromStartup("startup_nonsense.s"), null);
});

test("listStartupFiles：只认工程根的 startup_stm32*.s，且排序稳定", () => {
  const dir = mkProject({ startups: ["startup_stm32f103xe.s", "startup_stm32f103xb.s"] });
  try {
    assert.deepEqual(listStartupFiles(dir), ["startup_stm32f103xb.s", "startup_stm32f103xe.s"]);
    assert.deepEqual(listStartupFiles(join(dir, "nope")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("原样工程：算出来和文件一模一样，一个字节都不写", () => {
  const dir = mkProject();
  try {
    const before = readCmake(dir);
    const result = refreshCubemxCmakeLists(dir);
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.equal(result.startup, "startup_stm32f103xb.s");
    assert.equal(result.deviceDefine, "STM32F103xB");
    assert.deepEqual(result.modules, BASELINE_MODULES);
    assert.deepEqual(result.added, []);
    assert.equal(readCmake(dir), before);
    assert.match(describeRefresh(result), /cmake 源清单：已是最新/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("换芯片：启动文件与设备宏一起换掉，旧启动文件从清单里摘掉", () => {
  const dir = mkProject({ startups: ["startup_stm32f103xe.s"] });
  try {
    const result = refreshCubemxCmakeLists(dir);
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    const text = readCmake(dir);
    assert.ok(text.includes("startup_stm32f103xe.s"));
    assert.ok(!text.includes("startup_stm32f103xb.s"));
    assert.ok(text.includes("STM32F103xE"));
    assert.ok(!text.includes("STM32F103xB"));
    assert.ok(result.dropped.includes("startup_stm32f103xb.s"));
    // 再跑一次必须幂等
    assert.equal(refreshCubemxCmakeLists(dir).changed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("开 UART：只加真有的 stm32f1xx_hal_uart.c，第二次幂等（老洞的正例）", () => {
  const dir = mkProject({ modules: [...BASELINE_MODULES, "uart"], extraDrivers: ["uart"] });
  try {
    const result = refreshCubemxCmakeLists(dir);
    assert.equal(result.changed, true);
    assert.deepEqual(result.added, [DRIVER_DIR + "/stm32f1xx_hal_uart.c"]);
    assert.ok(readCmake(dir).includes("stm32f1xx_hal_uart.c"));
    assert.match(describeRefresh(result), /cmake 源清单：已更新/u);
    const again = refreshCubemxCmakeLists(dir);
    assert.equal(again.changed, false);
    assert.deepEqual(again.modules, ["cortex", "dma", "exti", "flash", "gpio", "pwr", "rcc", "uart"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hal_conf 开着但驱动包缺 .c：不写进清单，并说明缺哪个", () => {
  const dir = mkProject({ modules: [...BASELINE_MODULES, "can"] });
  try {
    const result = refreshCubemxCmakeLists(dir);
    assert.deepEqual(result.added, []);
    assert.ok(!readCmake(dir).includes("stm32f1xx_hal_can.c"));
    assert.ok(result.notes.some((note) => note.includes("can") && note.includes("没有对应 .c")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hal_conf 里那一圈 #include 不算「用到」：模块清单只认 MODULE_ENABLED 与源码 include", () => {
  const dir = mkProject();
  try {
    const facts = collectCmakeSources(dir);
    assert.ok(!("error" in facts));
    assert.deepEqual(facts.modules, BASELINE_MODULES);
    assert.ok(!facts.modules.includes("eth"));
    assert.ok(!facts.modules.includes("can"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("源码里手写 #include \"stm32f1xx_hal_uart.h\"（hal_conf 没开）：也算用到", () => {
  const dir = mkProject({ extraDrivers: ["uart"] });
  try {
    touch(join(dir, "Core/Src/main.c"), "#include \"main.h\"\n#include \"stm32f1xx_hal_uart.h\"\n");
    const result = refreshCubemxCmakeLists(dir);
    assert.equal(result.changed, true);
    assert.deepEqual(result.added, [DRIVER_DIR + "/stm32f1xx_hal_uart.c"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("带 _ex 的模块：_ex.c 存在就一起加（ADC）", () => {
  const dir = mkProject({ modules: [...BASELINE_MODULES, "adc"], extraDrivers: ["adc", "adc_ex"] });
  try {
    const result = refreshCubemxCmakeLists(dir);
    assert.deepEqual(result.added, [DRIVER_DIR + "/stm32f1xx_hal_adc.c", DRIVER_DIR + "/stm32f1xx_hal_adc_ex.c"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("磁盘上删掉的驱动文件：从清单里摘掉并进 notes", () => {
  const dir = mkProject();
  try {
    unlinkSync(join(dir, DRIVER_DIR, "stm32f1xx_hal_dma.c"));
    const result = refreshCubemxCmakeLists(dir);
    assert.equal(result.changed, true);
    assert.ok(result.dropped.includes(DRIVER_DIR + "/stm32f1xx_hal_dma.c"));
    assert.ok(!readCmake(dir).includes("stm32f1xx_hal_dma.c"));
    assert.ok(result.notes.some((note) => note.includes("摘掉")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dryRun：报告 changed=true 但文件不动", () => {
  const dir = mkProject({ modules: [...BASELINE_MODULES, "uart"], extraDrivers: ["uart"] });
  try {
    const before = readCmake(dir);
    const result = refreshCubemxCmakeLists(dir, { dryRun: true });
    assert.equal(result.changed, true);
    assert.match(result.message, /dryRun/u);
    assert.equal(readCmake(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("不是 ST CMake 布局 / 没有启动文件：ok=false 且给得出原因，不写盘", () => {
  const noCmake = mkProject({ withCmake: false });
  const noStartup = mkProject({ startups: [] });
  try {
    const a = refreshCubemxCmakeLists(noCmake);
    assert.equal(a.ok, false);
    assert.match(a.message, /cmake\/stm32cubemx\/CMakeLists\.txt/u);
    assert.match(describeRefresh(a), /未处理/u);
    const b = refreshCubemxCmakeLists(noStartup);
    assert.equal(b.ok, false);
    assert.match(b.message, /startup_stm32/u);
  } finally {
    rmSync(noCmake, { recursive: true, force: true });
    rmSync(noStartup, { recursive: true, force: true });
  }
});

test("stm32_generate 跳过 CubeMX（缓存命中）时也会把源清单对齐（接线回归）", async () => {
  const dir = mkProject({ modules: [...BASELINE_MODULES, "uart"], extraDrivers: ["uart"] });
  try {
    const fakeRoot = join(dir, "cubemx");
    touch(join(fakeRoot, "jre/bin/java.exe"), "");
    touch(join(fakeRoot, "STM32CubeMX.exe"), "");
    const iocText = "Mcu.CPN=STM32F103C8T6\n";
    touch(join(dir, "board.ioc"), iocText);
    const key = cacheKeyFor(iocText, join(fakeRoot, "jre/bin/java.exe"), join(fakeRoot, "STM32CubeMX.exe"), "coupled");
    const entry = entryFromFiles(key.key, key.iocSha256, key.cubeMxStamp, "coupled", dir, ["Core/Src/main.c"]);
    assert.ok(entry !== null);
    writeCache(join(dir, ".dsh-stm32"), entry);
    const before = readCmake(dir);
    assert.ok(!before.includes("stm32f1xx_hal_uart.c"));
    const neverSpawn = {
      spawn: () => {
        throw new Error("缓存命中时不该起任何进程");
      },
    };
    const report = await runGenerate(neverSpawn, { projectDir: dir, cubeMxRoots: [fakeRoot], layout: "coupled" });
    assert.equal(report.ok, true);
    assert.equal(report.skipped, true);
    assert.ok(report.notes.some((note) => note.startsWith("cmake 源清单：")));
    assert.ok(readCmake(dir).includes("stm32f1xx_hal_uart.c"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("注释掉的 #define 不算启用：真实 CubeMX hal_conf 里没用到的模块全被包在注释里", () => {
  // 这一条是差分构建验证时抓到的真缺陷：refresh 第一次跑把整个 HAL 的 30 多个 .c 全加了进去。
  const dir = mkProject({ extraDrivers: ["adc", "can", "uart", "spi"] });
  try {
    touch(join(dir, "Core/Inc/stm32f1xx_hal_conf.h"), [
      "#define HAL_MODULE_ENABLED",
      "  /*#define HAL_ADC_MODULE_ENABLED   */",
      "/* #define HAL_CAN_MODULE_ENABLED */",
      "// #define HAL_UART_MODULE_ENABLED",
      "#define HAL_GPIO_MODULE_ENABLED",
      "#define HAL_CORTEX_MODULE_ENABLED",
      "#define HAL_DMA_MODULE_ENABLED",
      "#define HAL_EXTI_MODULE_ENABLED",
      "#define HAL_FLASH_MODULE_ENABLED",
      "#define HAL_PWR_MODULE_ENABLED",
      "#define HAL_RCC_MODULE_ENABLED",
      "",
    ].join("\n"));
    // 源码里被注释掉的 include 同样不算
    touch(join(dir, "Core/Src/main.c"), "#include \"main.h\"\n// #include \"stm32f1xx_hal_spi.h\"\n/* #include \"stm32f1xx_hal_can.h\" */\n");
    const result = refreshCubemxCmakeLists(dir);
    assert.deepEqual(result.modules, BASELINE_MODULES);
    assert.deepEqual(result.added, []);
    assert.equal(result.changed, false);
    const text = readCmake(dir);
    assert.doesNotMatch(text, /hal_adc\.c|hal_can\.c|hal_uart\.c|hal_spi\.c/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CRLF 与 LF 混排：内容没变就不写（不能因为行尾把整文件翻掉）", () => {
  const dir = mkProject();
  try {
    const text = readCmake(dir);
    // 前 3 行改成 CRLF，其余保持 LF —— 真实工程里手工改过的文件就是这个样子
    const mixed = text.split("\n").map((line, index) => (index < 3 ? line + "\r" : line)).join("\n");
    touch(join(dir, CUBEMX_CMAKE_REL), mixed);
    const result = refreshCubemxCmakeLists(dir);
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.equal(readCmake(dir), mixed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});