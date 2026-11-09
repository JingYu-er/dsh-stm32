// 增量 1（全系列 HAL 建工程）的离线单测：型号解析、资源包按族读、模板族替换、固件包按族找。
//
// 为什么这些必须离线可测：它们决定「非 F1 族到底能不能建出可编译的工程」，
// 而真机验收（C0/F0/F1/F4/G4/L0 各跑一遍 CubeMX）要 3–5 分钟一族，不能当每次改动的闸门。
//
// 运行：node --test test/family-facts-units.test.mjs（需先 npm run build）
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FIXTURE_ASSETS } from "./fixtures.mjs";

// 必须早于任何读设备事实的调用：插件不再内置芯片表，全从资源包缓存读。
process.env.DSH_STM32_ASSETS = FIXTURE_ASSETS;

import {
  defineSuffix,
  familyFactsRelOf,
  findChipFact,
  loadFamilyDeviceFacts,
  namingFrom,
} from "../lib/data/device-facts.js";
import { familyProfileOf } from "../lib/data/family.js";
import { renderCmakeLists, renderOpenocdTarget, resolveHalChip } from "../lib/engine/hal-chip.js";
import { assetsFamilyIocText, resolveFamilyFirmwareRoot } from "../lib/engine/scaffold.js";

/** 造一个假的 CubeMX 根：Repository/<包名>/Drivers 三条判据齐全。 */
function fakeCubeRoot(packages) {
  const root = mkdtempSync(join(tmpdir(), "dsh-cube-"));
  for (const packageName of packages) {
    const deviceLine = /^STM32Cube_FW_([A-Z0-9]+)_V/u.exec(packageName)?.[1] ?? "F1";
    const base = join(root, "Repository", packageName, "Drivers");
    mkdirSync(join(base, "STM32" + deviceLine + "xx_HAL_Driver"), { recursive: true });
    mkdirSync(join(base, "CMSIS", "Include"), { recursive: true });
    mkdirSync(join(base, "CMSIS", "Device", "ST", "STM32" + deviceLine + "xx", "Source", "Templates", "gcc"), { recursive: true });
  }
  return root;
}

test("族 id → 资源包路径：按族段原样拼目录（l4+/wba/wl 不是前两个字母），认不出才回退 F1", () => {
  assert.equal(familyFactsRelOf("STM32F1"), "device/f1/chips.json");
  assert.equal(familyFactsRelOf("STM32F4"), "device/f4/chips.json");
  // 目录名 = 族画像的族段（familyProfileOf(...).line）小写，保留 "+"：
  // 旧实现取前两个字符，L4+ 会读成 l4（那是另一份表）、WBA 会读成 wb（WB 的表）。
  assert.equal(familyFactsRelOf("STM32L4+"), "device/l4+/chips.json");
  assert.equal(familyFactsRelOf("STM32WBA"), "device/wba/chips.json");
  assert.equal(familyFactsRelOf("STM32WL"), "device/wl/chips.json");
  assert.equal(namingFrom("BA50", "xx", "STM32WBA50KGUx")?.startup, "startup_stm32wba50xx.s");
  // 族段也能直接传（familyProfileOf 接受 "C0" 这种写法）
  assert.equal(familyFactsRelOf("C0"), "device/c0/chips.json");
  // 认不出的族不猜路径：回退 F1 的老路径，让上层按「查不到」处理
  assert.equal(familyFactsRelOf("STM32XYZ"), "device/f1/chips.json");
});

test("启动文件尾缀 → 设备宏尾缀：xx 全小写、xb→xB、cx→Cx（按封装分档）", () => {
  assert.equal(defineSuffix("xx"), "xx");
  assert.equal(defineSuffix("xb"), "xB");
  assert.equal(defineSuffix("cx"), "Cx");
  assert.equal(defineSuffix("xe"), "xE");
  assert.equal(defineSuffix("xc"), "xC");
});

test("namingFrom 按型号里的族字母现算启动文件/设备头/设备宏，不写死 F", () => {
  assert.deepEqual(namingFrom("407", "xx", "STM32F407VGTx"), {
    startup: "startup_stm32f407xx.s",
    deviceDefine: "STM32F407xx",
    deviceHeader: "stm32f407xx.h",
    linkerScript: "STM32F407VGTx_FLASH.ld",
  });
  // L4+ 的 line 是 4P5（带字母）
  assert.deepEqual(namingFrom("4P5", "xx", "STM32L4P5AGIx"), {
    startup: "startup_stm32l4p5xx.s",
    deviceDefine: "STM32L4P5xx",
    deviceHeader: "stm32l4p5xx.h",
    linkerScript: "STM32L4P5AGIx_FLASH.ld",
  });
  // F410/F412 的启动文件按封装分档：startup_stm32f410cx.s
  assert.deepEqual(namingFrom("410", "cx", "STM32F410CBTx"), {
    startup: "startup_stm32f410cx.s",
    deviceDefine: "STM32F410Cx",
    deviceHeader: "stm32f410cx.h",
    linkerScript: "STM32F410CBTx_FLASH.ld",
  });
  // 形状不对（老资源包的显式字段缺失时）一律给空串，让上层报错而不是编一个名字
  assert.deepEqual(namingFrom("103", "garbage", "STM32F103C8Tx"), {
    startup: "",
    deviceDefine: "",
    deviceHeader: "",
    linkerScript: "",
  });
});

test("按族读芯片表：F4 读 device/f4/chips.json，不影响 F1", () => {
  const f4 = loadFamilyDeviceFacts("STM32F4");
  assert.equal(f4.ok, true, f4.error);
  assert.equal(f4.byCpn.get("STM32F407VGT6")?.flashBytes, 1048576);
  // 夹具里只摘了 4 颗；F1 那份仍是 20 颗，互不干扰
  const f1 = loadFamilyDeviceFacts("STM32F1");
  assert.equal(f1.byCpn.get("STM32F103C8T6")?.flashBytes, 65536);
  assert.equal(f1.byCpn.has("STM32F407VGT6"), false);
});

test("findChipFact 按型号推族去读对应的芯片表", () => {
  assert.equal(findChipFact("STM32F407VGT6")?.deviceDefine, "STM32F407xx");
  assert.equal(findChipFact("STM32F410CBT6")?.startup, "startup_stm32f410cx.s");
  assert.equal(findChipFact("STM32F103C8T6")?.deviceDefine, "STM32F103xB");
  // 资源包里没装的族：返回 null（上层给「先刷新资源包」的人话），不抛
  assert.equal(findChipFact("STM32H743ZIT6"), null);
});

test("resolveHalChip 非 F1 族走芯片表，事实里带族 id 与族段", () => {
  const f407 = resolveHalChip("STM32F407VGT6");
  assert.equal(f407.reason, "");
  assert.equal(f407.facts?.familyId, "STM32F4");
  assert.equal(f407.facts?.familyLine, "F4");
  assert.equal(f407.facts?.startup, "startup_stm32f407xx.s");
  assert.equal(f407.facts?.deviceDefine, "STM32F407xx");
  assert.equal(f407.facts?.linkerScript, "STM32F407VGTx_FLASH.ld");
  assert.equal(f407.facts?.ramBytes, 131072);
  // 非蓝丸：不写旧名链接脚本
  assert.equal(f407.facts?.keepLegacyLinkerScript, false);

  const f410 = resolveHalChip("STM32F410CBT6");
  assert.equal(f410.facts?.deviceDefine, "STM32F410Cx");
  assert.equal(f410.facts?.startup, "startup_stm32f410cx.s");

  // F1 仍走原来那条手写 RAM 表的路径（蓝丸留旧名兼容副本）
  const c8 = resolveHalChip("STM32F103C8T6");
  assert.equal(c8.facts?.familyId, "STM32F1");
  assert.equal(c8.facts?.keepLegacyLinkerScript, true);

  // 认不出族：说清型号要怎么写，而不是拿 F1 的模板建一个假工程
  const junk = resolveHalChip("ABC123");
  assert.equal(junk.facts, null);
  assert.match(junk.reason, /STM32/u);

  // 族认得出但资源包里没这个族的芯片表：提示刷新资源包
  const h7 = resolveHalChip("STM32H743ZIT6");
  assert.equal(h7.facts, null);
  assert.match(h7.reason, /chips|芯片表/u);
});

test("renderCmakeLists 把 F1 骨架里的目录名/设备宏/启动文件都换成目标族", () => {
  const template = [
    "set(MX_Defines_Syms",
    "\\tUSE_HAL_DRIVER",
    "\\tSTM32F103xB",
    ")",
    "set(MX_Include_Dirs",
    "    ../../Drivers/STM32F1xx_HAL_Driver/Inc/Legacy",
    "    ../../Drivers/STM32F1xx_HAL_Driver/Inc",
    "    ../../Drivers/CMSIS/Device/ST/STM32F1xx/Include",
    ")",
    "# Core/Inc/stm32f1xx_hal_conf.h 是 HAL 配置",
    "    ../../startup_stm32f103xb.s",
  ].join("\n");
  const facts = resolveHalChip("STM32F407VGT6").facts;
  assert.notEqual(facts, null);
  const out = renderCmakeLists(template, facts);
  assert.match(out, /STM32F407xx/u);
  assert.match(out, /Drivers\/STM32F4xx_HAL_Driver\/Inc\/Legacy/u);
  assert.match(out, /CMSIS\/Device\/ST\/STM32F4xx\/Include/u);
  assert.match(out, /stm32f4xx_hal_conf\.h/u);
  assert.match(out, /startup_stm32f407xx\.s/u);
  assert.equal(out.includes("STM32F1xx"), false);
  assert.equal(out.includes("stm32f1xx"), false);
  assert.equal(out.includes("STM32F103xB"), false);

  // 模板被动过（缺设备宏/启动文件）时抛错，不生成半改的 cmake
  assert.throws(() => renderCmakeLists("set(MX_Defines_Syms STM32F1xx)", facts), /STM32F103xB/u);
});

test("renderOpenocdTarget：有 target 的族换脚本名，没 target 的族原样保留并给 note", () => {
  const ioc = "source [find interface/cmsis-dap.cfg]\ntransport select swd\nsource [find target/stm32f1x.cfg]\n";
  const f4 = renderOpenocdTarget(ioc, resolveHalChip("STM32F407VGT6").facts);
  assert.match(f4.text, /target\/stm32f4x\.cfg/u);
  assert.equal(f4.note, "");

  const f1 = renderOpenocdTarget(ioc, resolveHalChip("STM32F103C8T6").facts);
  assert.match(f1.text, /target\/stm32f1x\.cfg/u);

  // C0：openocd 0.12 没有官方脚本，但有插件内置的适配版 → 工程内的 openocd/stm32c0x.cfg
  const c0Facts = {
    mcu: "STM32C031C6T6", deviceId: "STM32C031C6Tx", mcuName: "STM32C031C(6-8)Tx", packageName: "LQFP48",
    pinCount: 48, startup: "startup_stm32c031xx.s", deviceDefine: "STM32C031xx", deviceHeader: "stm32c031xx.h",
    flashBytes: 32768, ramBytes: 12288, linkerScript: "STM32C031C6Tx_FLASH.ld",
    familyId: "STM32C0", familyLine: "C0", keepLegacyLinkerScript: false, notes: [],
  };
  const c0 = renderOpenocdTarget(ioc, c0Facts, "openocd");
  assert.match(c0.text, /source \[find openocd\/stm32c0x\.cfg\]/u);
  assert.equal(c0.note, "");
  // launch.json 要的是工作区绝对路径
  const c0Launch = renderOpenocdTarget('"target/stm32f1x.cfg"', c0Facts, "launch");
  assert.equal(c0Launch.text, '"\${workspaceFolder}/openocd/stm32c0x.cfg"');

  // 既没有官方脚本也没有内置脚本的族（H5）：原样保留并给 note，绝不猜一个别的族
  const h5 = renderOpenocdTarget(ioc, {
    ...c0Facts, mcu: "STM32H563ZIT6", deviceId: "STM32H563ZITx", startup: "startup_stm32h563xx.s",
    deviceDefine: "STM32H563xx", deviceHeader: "stm32h563xx.h", familyId: "STM32H5", familyLine: "H5",
  });
  assert.equal(h5.text, ioc);
  assert.match(h5.note, /STM32H5/u);
});

test("resolveFamilyFirmwareRoot：取本机已装的最高版本，显式包名优先，装不到就给包名前缀", () => {
  const root = fakeCubeRoot(["STM32Cube_FW_F4_V1.27.0", "STM32Cube_FW_F4_V1.28.3", "STM32Cube_FW_F0_V1.11.6"]);
  try {
    const best = resolveFamilyFirmwareRoot("F4", [root]);
    assert.equal(best.packageName, "STM32Cube_FW_F4_V1.28.3");
    assert.match(best.root ?? "", /V1\.28\.3$/u);

    const explicit = resolveFamilyFirmwareRoot("F4", [root], [], "STM32Cube_FW_F4_V1.27.0");
    assert.equal(explicit.packageName, "STM32Cube_FW_F4_V1.27.0");
    assert.match(explicit.root ?? "", /V1\.27\.0$/u);

    const missing = resolveFamilyFirmwareRoot("G0", [root]);
    assert.equal(missing.root, undefined);
    assert.equal(missing.packageName, "STM32Cube_FW_G0");
    assert.equal(missing.checked.length > 0, true);

    // L4+ 与 L4 共用 STM32Cube_FW_L4（族段里的 + 不是目录名的一部分）
    const l4plus = resolveFamilyFirmwareRoot("L4+", [fakeCubeRoot(["STM32Cube_FW_L4_V1.18.1"])]);
    assert.equal(l4plus.packageName, "STM32Cube_FW_L4_V1.18.1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assetsFamilyIocText：资源包里有这个族的 .ioc 模板才返回文本", () => {
  const f4 = assetsFamilyIocText("F4");
  assert.notEqual(f4, null);
  assert.match(f4 ?? "", /^Mcu\.CPN=/mu);
  assert.match(f4 ?? "", /^Mcu\.Family=STM32F4$/mu);
  // 夹具里没有 G0 的模板
  assert.equal(assetsFamilyIocText("G0"), null);
});

test("族画像的 HAL 能力：21 个单核族放行，双核/MPU/范围外的族仍拒绝", () => {
  // 每一条都在 demo/.dsh-stm32/accept-*.log 里跑过 create→generate→build（0 warning）：
  // L5/H5/L4+/U3/U5/WBA/WL 是这一次补上的七族，此前只有 14 族。
  for (const family of ["STM32C0", "STM32F0", "STM32F1", "STM32F2", "STM32F3", "STM32F4", "STM32F7", "STM32G0", "STM32G4", "STM32H5", "STM32H7", "STM32L0", "STM32L1", "STM32L4", "STM32L4+", "STM32L5", "STM32U0", "STM32U3", "STM32U5", "STM32WBA", "STM32WL"]) {
    assert.equal(familyProfileOf(family).capabilities.halScaffold, true, family + " 应支持 HAL 建工程");
  }
  // WB 是双核（M4+M0），WB0/WL3 的时钟模型刚点亮但建工程没做；MP1/MP2/N6 不在范围里。
  for (const family of ["STM32WB", "STM32WB0", "STM32WL3", "STM32MP1", "STM32MP2", "STM32N6"]) {
    assert.equal(familyProfileOf(family).capabilities.halScaffold, false, family + " 不该宣称支持 HAL 建工程");
  }
  // 寄存器版模板：资源包有 chips.json 的 21 族（这一次把 H5/H7/L4+/L5/U3/U5/WBA/WL 八族补进了
  // CMSIS 下载清单）放行；其余族即便 HAL 放行也不该宣称寄存器版（能力闸门别被 HAL 的放行带跑）。
  for (const family of ["STM32C0", "STM32F0", "STM32F1", "STM32F2", "STM32F3", "STM32F4", "STM32F7", "STM32G0", "STM32G4", "STM32H5", "STM32H7", "STM32L0", "STM32L1", "STM32L4", "STM32L4+", "STM32L5", "STM32U0", "STM32U3", "STM32U5", "STM32WBA", "STM32WL"]) {
    assert.equal(familyProfileOf(family).capabilities.registerScaffold, true, family + " 应支持寄存器版建工程");
  }
  // WB 是双核、WB0/WL3 内置资源还没有 chips.json，MP1/MP2/N6 不在建工程范围里。
  for (const family of ["STM32WB", "STM32WB0", "STM32WL3", "STM32MP1", "STM32MP2", "STM32N6"]) {
    assert.equal(familyProfileOf(family).capabilities.registerScaffold, false, family + " 没有 CMSIS 下载清单，不该宣称寄存器版");
  }
});
