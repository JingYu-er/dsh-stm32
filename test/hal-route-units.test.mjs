// 单元测试：HAL 路线的"型号 → 工程文件"派生（F1 全系）。
// 跑法：node test\hal-route-units.test.mjs
//
// 这里守的是三件最容易回退的事：
//   - 启动文件 / 设备宏按芯片取（不是写死 C8T6）；
//   - 链接脚本按芯片命名并渲染（<DeviceId>_FLASH.ld，MEMORY 跟着芯片走）；
//   - 旧名 STM32F103XX_FLASH.ld 只作为老工程兼容，不能拿它糊别的芯片。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  DEFAULT_HAL_MCU,
  describeHalChip,
  LEGACY_LINKER_SCRIPT,
  pointLinkerFlagAt,
  renderIoc,
  renderLinkerScript,
  renderStartupAndDefine,
  resolveHalChip,
} from "../lib/engine/hal-chip.js";
import { createProjectScaffold, DEFAULT_FIRMWARE_PACKAGE } from "../lib/engine/scaffold.js";

import { FIXTURE_ASSETS } from "./fixtures.mjs";

// 设备事实只从资源包缓存读（内置 chip-table.json / 手写容量表已删）：
// 单测统一指到 test/fixtures/assets，绝不读开发机真实 home 缓存。
process.env.DSH_STM32_ASSETS = FIXTURE_ASSETS;

const TEMPLATES = fileURLToPath(new URL("../templates/scaffold/", import.meta.url));
const CUBE_ROOT = "D:/app/STM32CubeMX";
const FIRMWARE_PACKAGE_EXISTS = fs.existsSync(path.join(CUBE_ROOT, "Repository", DEFAULT_FIRMWARE_PACKAGE));

function factsOf(mcu) {
  const resolved = resolveHalChip(mcu);
  assert.equal(resolved.facts === null, false, "认不出 " + mcu + "：" + resolved.reason);
  return resolved.facts;
}

function templateText(rel) {
  return fs.readFileSync(path.join(TEMPLATES, rel), "utf8");
}

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-stm32-" + tag + "-"));
}

test("C8T6（缺省芯片）：启动文件/设备宏/链接脚本名字都不能变", () => {
  const facts = factsOf(undefined);
  assert.equal(facts.mcu, DEFAULT_HAL_MCU);
  assert.equal(facts.deviceId, "STM32F103C8Tx");
  assert.equal(facts.mcuName, "STM32F103C(8-B)Tx", "Mcu.Name 是 CubeMX db/mcu 的分组名");
  assert.equal(facts.packageName, "LQFP48");
  assert.equal(facts.startup, "startup_stm32f103xb.s");
  assert.equal(facts.deviceDefine, "STM32F103xB");
  assert.equal(facts.deviceHeader, "stm32f103xb.h");
  assert.equal(facts.flashBytes, 64 * 1024);
  assert.equal(facts.ramBytes, 20 * 1024);
  assert.equal(facts.linkerScript, "STM32F103C8Tx_FLASH.ld");
  assert.equal(facts.keepLegacyLinkerScript, true, "蓝丸要留旧名兼容副本");
  assert.match(describeHalChip(facts), /STM32F103C8T6/u);
});

test("STM32F103RCT6（xE，LQFP64）：启动文件/设备宏/链接脚本按芯片算", () => {
  const facts = factsOf("STM32F103RCT6");
  assert.equal(facts.deviceId, "STM32F103RCTx");
  assert.equal(facts.mcuName, "STM32F103R(C-D-E)Tx");
  assert.equal(facts.packageName, "LQFP64");
  assert.equal(facts.pinCount, 64);
  assert.equal(facts.startup, "startup_stm32f103xe.s", "xE 档是 startup_stm32f103xe.s");
  assert.equal(facts.deviceDefine, "STM32F103xE");
  assert.equal(facts.deviceHeader, "stm32f103xe.h");
  assert.equal(facts.flashBytes, 256 * 1024);
  assert.equal(facts.ramBytes, 48 * 1024);
  assert.equal(facts.linkerScript, "STM32F103RCTx_FLASH.ld");
  assert.equal(facts.keepLegacyLinkerScript, false, "别的芯片不许留旧名（那是 64K/20K 的内存布局）");
});

test("STM32F107VCT6（xC，LQFP100）：启动文件是 startup_stm32f107xc.s", () => {
  const facts = factsOf("STM32F107VCT6");
  assert.equal(facts.deviceId, "STM32F107VCTx");
  assert.equal(facts.mcuName, "STM32F107V(B-C)Tx");
  assert.equal(facts.packageName, "LQFP100");
  assert.equal(facts.startup, "startup_stm32f107xc.s");
  assert.equal(facts.deviceDefine, "STM32F107xC");
  assert.equal(facts.deviceHeader, "stm32f107xc.h");
  assert.equal(facts.flashBytes, 256 * 1024);
  assert.equal(facts.ramBytes, 64 * 1024);
  assert.equal(facts.linkerScript, "STM32F107VCTx_FLASH.ld");
});

test("F100RET6 / F101VET6（xE 档）：按 ST 官方 .ld 的 32K / 48K 建，链接脚本跟着走", () => {
  // 事实来源：STM32F100XE_FLASH.ld → 512K FLASH / 32K RAM；STM32F101XE_FLASH.ld → 512K FLASH / 48K RAM。
  const f100 = factsOf("STM32F100RET6");
  assert.equal(f100.deviceId, "STM32F100RETx");
  assert.equal(f100.mcuName, "STM32F100R(C-D-E)Tx", "CubeMX db 里 100 的 R 封装确实有 C-D-E 分组");
  assert.equal(f100.packageName, "LQFP64");
  assert.equal(f100.startup, "startup_stm32f100xe.s");
  assert.equal(f100.deviceDefine, "STM32F100xE");
  assert.equal(f100.deviceHeader, "stm32f100xe.h");
  assert.equal(f100.flashBytes, 512 * 1024);
  assert.equal(f100.ramBytes, 32 * 1024);
  assert.equal(f100.linkerScript, "STM32F100RETx_FLASH.ld");
  assert.equal(f100.keepLegacyLinkerScript, false, "旧名是 64K/20K，F100xE 绝不能留");

  const f101 = factsOf("STM32F101VET6");
  assert.equal(f101.deviceId, "STM32F101VETx");
  assert.equal(f101.packageName, "LQFP100");
  assert.equal(f101.startup, "startup_stm32f101xe.s");
  assert.equal(f101.deviceDefine, "STM32F101xE");
  assert.equal(f101.flashBytes, 512 * 1024);
  assert.equal(f101.ramBytes, 48 * 1024);
  assert.equal(f101.linkerScript, "STM32F101VETx_FLASH.ld");

  const template = templateText(LEGACY_LINKER_SCRIPT);
  const rendered100 = renderLinkerScript(template, f100);
  assert.ok(rendered100.includes("Linker script for STM32F100RETx series"));
  assert.ok(rendered100.includes("512Kbytes FLASH and 32Kbytes RAM"), rendered100.slice(0, 600));
  assert.ok(rendered100.includes("RAM (xrw)      : ORIGIN = 0x20000000, LENGTH = 32K"));
  const rendered101 = renderLinkerScript(template, f101);
  assert.ok(rendered101.includes("Linker script for STM32F101VETx series"));
  assert.ok(rendered101.includes("512Kbytes FLASH and 48Kbytes RAM"), rendered101.slice(0, 600));
  assert.ok(rendered101.includes("RAM (xrw)      : ORIGIN = 0x20000000, LENGTH = 48K"));
});

test("链接脚本渲染：C8T6 逐字节等于模板（老工程兼容）", () => {
  const template = templateText(LEGACY_LINKER_SCRIPT);
  const rendered = renderLinkerScript(template, factsOf("STM32F103C8T6"));
  assert.equal(rendered, template, "默认芯片渲染必须是无损的，否则老工程会莫名其妙变化");
  assert.ok(rendered.includes("LENGTH = 20K"));
  assert.ok(rendered.includes("LENGTH = 64K"));
});

test("链接脚本渲染：RCT6 → 256K FLASH / 48K RAM，型号名进头注释", () => {
  const rendered = renderLinkerScript(templateText(LEGACY_LINKER_SCRIPT), factsOf("STM32F103RCT6"));
  assert.ok(rendered.includes("Linker script for STM32F103RCTx series"), rendered.slice(0, 600));
  assert.ok(rendered.includes("256Kbytes FLASH and 48Kbytes RAM"), rendered.slice(0, 600));
  assert.ok(rendered.includes("RAM (xrw)      : ORIGIN = 0x20000000, LENGTH = 48K"), rendered.split("\n").slice(50, 62).join("\n"));
  assert.ok(rendered.includes("FLASH (rx)      : ORIGIN = 0x8000000, LENGTH = 256K"));
  assert.equal(rendered.includes("STM32F103C8Tx"), false, "不许残留 C8T6 的型号名");
  assert.equal(rendered.includes("LENGTH = 64K"), false);
});

test("链接脚本渲染：F107VCT6 → 256K FLASH / 64K RAM，型号名进头注释", () => {
  const rendered = renderLinkerScript(templateText(LEGACY_LINKER_SCRIPT), factsOf("STM32F107VCT6"));
  assert.ok(rendered.includes("Linker script for STM32F107VCTx series"));
  assert.ok(rendered.includes("256Kbytes FLASH and 64Kbytes RAM"));
  assert.ok(rendered.includes("LENGTH = 64K"));
  assert.ok(rendered.includes("LENGTH = 256K"));
});

test(".ioc 渲染：五个键按芯片改写（C8T6 逐字节不变，RCT6/F107 换成自己的）", () => {
  const template = templateText("demo.ioc");
  const c8 = factsOf("STM32F103C8T6");
  assert.equal(renderIoc(template, c8), template, "C8T6 渲染必须无损");

  const rc = renderIoc(template, factsOf("STM32F103RCT6"));
  for (const line of [
    "Mcu.CPN=STM32F103RCT6",
    "Mcu.Name=STM32F103R(C-D-E)Tx",
    "Mcu.Package=LQFP64",
    "Mcu.UserName=STM32F103RCTx",
    "ProjectManager.DeviceId=STM32F103RCTx",
  ]) {
    assert.ok(rc.includes(line), "缺 " + line + "：\n" + rc.split("\n").slice(0, 30).join("\n"));
  }
  // 引脚最小集不许被动：SWD 两根 + 一个 GPIO
  assert.ok(rc.includes("PA13") && rc.includes("PA14") && rc.includes("PC13-TAMPER-RTC"));
  assert.ok(rc.includes("ProjectManager.ProjectName=__PROJECT_NAME__"), "工程名占位符留给 scaffold 替换");

  const f107 = renderIoc(template, factsOf("STM32F107VCT6"));
  assert.ok(f107.includes("Mcu.CPN=STM32F107VCT6"));
  assert.ok(f107.includes("Mcu.Name=STM32F107V(B-C)Tx"));
  assert.ok(f107.includes("Mcu.Package=LQFP100"));
  assert.ok(f107.includes("ProjectManager.DeviceId=STM32F107VCTx"));
  assert.equal(f107.includes("STM32F103C8T6"), false);
});

test("cmake 的 -T / 设备宏 / 启动文件按芯片改写（-T 永远指渲染后的名字）", () => {
  const c8 = factsOf(undefined);
  for (const rel of ["cmake/gcc-arm-none-eabi.cmake", "cmake/starm-clang.cmake"]) {
    const text = templateText(rel);
    // -T 一律指向按芯片渲染后的名字；旧名只是个兼容副本，不该再被 -T 引用
    const c8Text = pointLinkerFlagAt(text, c8);
    assert.match(c8Text, /\/STM32F103C8Tx_FLASH\.ld/u, rel + " 的 -T 要指到 C8T6 自己的名字：\n" + c8Text);
    assert.equal(c8Text.includes(LEGACY_LINKER_SCRIPT), false, rel + " 对 C8T6 也不许再指旧名");
    const rcText = pointLinkerFlagAt(text, factsOf("STM32F103RCT6"));
    assert.match(rcText, /\/STM32F103RCTx_FLASH\.ld/u, rel + " 的 -T 要指到新名字：\n" + rcText);
    assert.equal(rcText.includes(LEGACY_LINKER_SCRIPT), false, rel + " 不许再指旧名");
  }
  const cube = templateText("cmake/stm32cubemx/CMakeLists.txt");
  assert.equal(renderStartupAndDefine(cube, c8), cube, "C8T6 的设备宏/启动文件必须无损");
  const rcCube = renderStartupAndDefine(cube, factsOf("STM32F103RCT6"));
  assert.ok(rcCube.includes("STM32F103xE"));
  assert.ok(rcCube.includes("startup_stm32f103xe.s"));
  assert.equal(rcCube.includes("STM32F103xB\n"), false);
  assert.equal(rcCube.includes("startup_stm32f103xb.s"), false);
});

test("认不出的型号一律拒绝，且理由是给用户看的", () => {
  const cases = [
    ["STM32F407VGT6", /F1/u],
    ["F103:xb", /容量档|完整型号|封装/u],
    // RAM 优先取手写表（ST 官方 .ld），其次取 CubeMX db 的容量档值：F100C8T6 / F100xE / F101xE 都能建；
    // 两边都查不到的中间档（100xC / 101xC）仍然拒绝 —— 链接脚本的 RAM 长度不许猜。
    ["STM32F100RCT6", /RAM/u],
    ["STM32F101RCT6", /RAM/u],
    ["STM32F107VBT6", /容量档|xb/u],
    ["", /^$/u],
  ];
  for (const [mcu, pattern] of cases) {
    if (mcu === "") {
      assert.notEqual(resolveHalChip("").facts, null, "空型号按默认芯片处理");
      continue;
    }
    const resolved = resolveHalChip(mcu);
    assert.equal(resolved.facts, null, mcu + " 不该被认出来");
    assert.match(resolved.reason, pattern, mcu + " 的理由不对：" + resolved.reason);
  }
});

test("真建 C8T6 工程：两个链接脚本名都在，cmake 指新名（旧名兼容）", { skip: !FIRMWARE_PACKAGE_EXISTS }, () => {
  const root = tempDir("hal-c8");
  try {
    const targetDir = path.join(root, "blink");
    const report = createProjectScaffold({ targetDir, projectName: "blink", cubeMxRoots: [CUBE_ROOT] });
    assert.equal(report.ok, true, report.message);
    assert.equal(report.mcu, "STM32F103C8T6");
    assert.equal(report.startup, "startup_stm32f103xb.s");
    assert.equal(report.deviceDefine, "STM32F103xB");
    assert.equal(report.linkerScript, "STM32F103C8Tx_FLASH.ld");
    assert.ok(fs.existsSync(path.join(targetDir, "startup_stm32f103xb.s")));
    assert.ok(fs.existsSync(path.join(targetDir, "STM32F103C8Tx_FLASH.ld")), "新名必须在");
    assert.ok(fs.existsSync(path.join(targetDir, LEGACY_LINKER_SCRIPT)), "蓝丸的旧名兼容副本也要在");
    const ld = fs.readFileSync(path.join(targetDir, "STM32F103C8Tx_FLASH.ld"), "utf8");
    assert.ok(ld.includes("LENGTH = 64K") && ld.includes("LENGTH = 20K"));
    const cmake = fs.readFileSync(path.join(targetDir, "cmake/gcc-arm-none-eabi.cmake"), "utf8");
    assert.match(cmake, /\/STM32F103C8Tx_FLASH\.ld/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("真建 RCT6 工程：启动文件/设备宏/链接脚本全部换成本芯片的", { skip: !FIRMWARE_PACKAGE_EXISTS }, () => {
  const root = tempDir("hal-rc");
  try {
    const targetDir = path.join(root, "blink_rc");
    const report = createProjectScaffold({ targetDir, projectName: "blink_rc", cubeMxRoots: [CUBE_ROOT], mcu: "STM32F103RCT6" });
    assert.equal(report.ok, true, report.message);
    assert.equal(report.mcu, "STM32F103RCT6");
    assert.equal(report.startup, "startup_stm32f103xe.s");
    assert.equal(report.deviceDefine, "STM32F103xE");
    assert.equal(report.linkerScript, "STM32F103RCTx_FLASH.ld");
    // 启动文件：只有本芯片那份，不许把 C8T6 的也拖进来
    assert.ok(fs.existsSync(path.join(targetDir, "startup_stm32f103xe.s")));
    assert.equal(fs.existsSync(path.join(targetDir, "startup_stm32f103xb.s")), false);
    // 链接脚本：只有按芯片命名的那份
    assert.ok(fs.existsSync(path.join(targetDir, "STM32F103RCTx_FLASH.ld")));
    assert.equal(fs.existsSync(path.join(targetDir, LEGACY_LINKER_SCRIPT)), false, "旧名是 64K/20K，绝不能给 RCT6 用");
    const ld = fs.readFileSync(path.join(targetDir, "STM32F103RCTx_FLASH.ld"), "utf8");
    assert.ok(ld.includes("Linker script for STM32F103RCTx series"));
    assert.ok(ld.includes("LENGTH = 48K"), ld.split("\n").slice(50, 62).join("\n"));
    assert.ok(ld.includes("LENGTH = 256K"));
    // cmake：-T 指新名、设备宏与启动文件跟着换
    assert.match(fs.readFileSync(path.join(targetDir, "cmake/gcc-arm-none-eabi.cmake"), "utf8"), /\/STM32F103RCTx_FLASH\.ld/u);
    const cubeLists = fs.readFileSync(path.join(targetDir, "cmake/stm32cubemx/CMakeLists.txt"), "utf8");
    assert.ok(cubeLists.includes("STM32F103xE"));
    assert.ok(cubeLists.includes("startup_stm32f103xe.s"));
    // .ioc：五键与 db 分组名
    const ioc = fs.readFileSync(path.join(targetDir, "blink_rc.ioc"), "utf8");
    assert.ok(ioc.includes("Mcu.CPN=STM32F103RCT6"));
    assert.ok(ioc.includes("Mcu.Name=STM32F103R(C-D-E)Tx"));
    assert.ok(ioc.includes("Mcu.Package=LQFP64"));
    assert.ok(ioc.includes("ProjectManager.DeviceId=STM32F103RCTx"));
    assert.ok(ioc.includes("ProjectManager.ProjectName=blink_rc"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("型号写错时建不出来（不留半成品目录）", () => {
  const root = tempDir("hal-bad");
  try {
    const targetDir = path.join(root, "bad");
    const report = createProjectScaffold({ targetDir, projectName: "bad", cubeMxRoots: [CUBE_ROOT], mcu: "STM32F4xx" });
    assert.equal(report.ok, false);
    assert.match(report.message, /认不出芯片型号|F1/u);
    assert.equal(fs.existsSync(targetDir), false, "拒绝时不许建目录");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
