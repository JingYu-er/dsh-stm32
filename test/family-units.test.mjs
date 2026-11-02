// 全系列支持（src/data/family.ts）：族画像、型号→族、内核预算、openocd target 选择。
//
// 为什么要这层：db 只写"这颗芯片是什么"（Family/Core/Flash/引脚），
// 不写"我们能不能把它跑起来"（openocd 有没有 target 脚本、有没有固件包、
// 时钟规划/预设表/SVD 校验实现到哪一族）。能力闸门就落在这里，
// 免得非 F1 的族被悄悄按 F1 的表去写 .ioc。
//
// 运行：node --test test/family-units.test.mjs（需先 npm run build）
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { instancesWithPins, parseMcuXml } from "../lib/engine/cubemx-db.js";
import {
  FALLBACK_DEBUG_BUDGET,
  bundledOpenocdConfig,
  chooseOpenocdTarget,
  debugBudgetForCore,
  debugBudgetOfFamily,
  extiVectorNameOf,
  extiVectorsOf,
  familyIdOfPart,
  familyProfileOf,
  familyProfiles,
  isF1,
  isKnownFamily,
  readIocFamilyId,
  readProjectFamily,
  unknownFamilyProfile,
} from "../lib/data/family.js";

/** 只带一份 .ioc 的临时工程。 */
function iocProject(text, name = "demo.ioc") {
  const dir = mkdtempSync(join(tmpdir(), "dsh-family-"));
  writeFileSync(join(dir, name), text);
  return dir;
}

test("族表覆盖 db 里的 27 个 Family，且只有 F1 是全能力", () => {
  const profiles = familyProfiles();
  assert.equal(profiles.length, 27);
  const ids = profiles.map((item) => item.id).sort();
  assert.deepEqual(ids, [
    "STM32C0", "STM32F0", "STM32F1", "STM32F2", "STM32F3", "STM32F4", "STM32F7",
    "STM32G0", "STM32G4", "STM32H5", "STM32H7", "STM32L0", "STM32L1", "STM32L4",
    "STM32L4+", "STM32L5", "STM32MP1", "STM32MP2", "STM32N6", "STM32U0", "STM32U3",
    "STM32U5", "STM32WB", "STM32WB0", "STM32WBA", "STM32WL", "STM32WL3",
  ]);
  const full = profiles.filter((item) => Object.values(item.capabilities).every((value) => value === true));
  assert.deepEqual(full.map((item) => item.id), ["STM32F1"], "只有 F1 的所有能力都为 true");
  // 每条都要能说清"为什么不能"——note 是拒绝理由的来源，不能空。
  for (const item of profiles) assert.ok(item.note.length > 0, item.id + " 缺 note");
});

test("familyIdOfPart：型号前缀 → 族（三段前缀必须先于两段判）", () => {
  const cases = [
    ["STM32F103C8T6", "STM32F1"],
    ["STM32F030C8T6", "STM32F0"],
    ["STM32F407VGT6", "STM32F4"],
    ["STM32G431CBU6", "STM32G4"],
    ["STM32L4R5ZIT6", "STM32L4+"],
    ["STM32L476RGT6", "STM32L4"],
    ["STM32WBA55CG", "STM32WBA"],
    ["STM32WB55RG", "STM32WB"],
    // 真实零件名（db 里的文件名）：WB0/WL3 的族段后面紧跟数字，WBA/MP2 也是。
    ["STM32WB05KZV6", "STM32WB0"],
    ["STM32WL55JC", "STM32WL"],
    ["STM32WL30K8V6", "STM32WL3"],
    ["STM32MP211AAL", "STM32MP2"],
    ["STM32H563ZI", "STM32H5"],
    ["STM32U575ZI", "STM32U5"],
    ["STM32G071RB", "STM32G0"],
    ["STM32MP157F", "STM32MP1"],
  ];
  for (const [part, family] of cases) {
    assert.equal(familyIdOfPart(part), family, part);
  }
  // 认不出就是空串：宁可"不知道"，也不要猜成 F1。
  assert.equal(familyIdOfPart(""), "");
  assert.equal(familyIdOfPart("NEOPIXEL"), "");
  assert.equal(familyIdOfPart("STM32"), "");
});

test("familyProfileOf：族 id、型号、缩写都认；认不出的族返回画像但能力全 false", () => {
  assert.equal(familyProfileOf("STM32F4").openocdTarget, "stm32f4x");
  assert.equal(familyProfileOf("F4").id, "STM32F4");
  assert.equal(familyProfileOf("L4+").id, "STM32L4+");
  assert.equal(familyProfileOf("STM32L4R5ZIT6").id, "STM32L4+");
  assert.equal(familyProfileOf("STM32H743ZIT6").openocdTarget, "stm32h7x");
  assert.equal(familyProfileOf("STM32F103C8T6").capabilities.clockPlan, true);

  // 非 F1：HAL 建工程已按族实现（增量 1：固件包按族找、启动文件/设备宏/链接脚本从芯片表来），
  // 但预设表与时钟规划仍然只有 F1 —— 诚实降级的是这两项，不是 halScaffold。
  const f4 = familyProfileOf("STM32F4");
  assert.equal(f4.capabilities.iocPresets, false);
  assert.equal(f4.capabilities.clockPlan, false);
  assert.equal(f4.capabilities.halScaffold, true);
  assert.equal(isF1(f4), false);

  const unknown = familyProfileOf("STM32ZZ9");
  assert.deepEqual(unknown.capabilities, {
    halScaffold: false, registerScaffold: false, iocPresets: false, clockPlan: false, svdValidation: false,
  });
  assert.equal(unknown.openocdTarget, null);
  assert.match(unknown.note, /画像/u);
  assert.deepEqual(unknownFamilyProfile("X").id, "X");
  assert.equal(isKnownFamily(unknown), false);
  assert.equal(isKnownFamily(f4), true);
});

test("没有 openocd target 脚本的族标成 null，并在 note 里说明", () => {
  for (const family of ["STM32C0", "STM32H5", "STM32N6", "STM32U0", "STM32U3", "STM32WBA", "STM32WB0", "STM32WL3", "STM32MP2"]) {
    const profile = familyProfileOf(family);
    assert.equal(profile.openocdTarget, null, family);
    assert.match(profile.note, /openocd/u, family);
  }
  // C0 / U0 有插件内置的适配版脚本；其它没脚本的族没有（不猜）。
  for (const [family, name] of [["STM32C0", "stm32c0x"], ["STM32U0", "stm32u0x"]]) {
    const profile = familyProfileOf(family);
    assert.equal(profile.bundledTarget, name, family + " 应内置 " + name);
    assert.notEqual(bundledOpenocdConfig(name), null, name + ".cfg 必须在 templates/openocd 里");
  }
  assert.equal(familyProfileOf("STM32H5").bundledTarget, null);
});

test("debugBudgetForCore：比较器个数按内核（M0 4/2、M3・M4 6/4、M7・M33・M55 8/4）", () => {
  assert.deepEqual({ ...debugBudgetForCore("Arm Cortex-M0") }, { code: 4, data: 2 });
  assert.deepEqual({ ...debugBudgetForCore("ARM Cortex-M0+") }, { code: 4, data: 2 });
  assert.deepEqual({ ...debugBudgetForCore("Arm Cortex-M3") }, { code: 6, data: 4 });
  assert.deepEqual({ ...debugBudgetForCore("Arm Cortex-M4") }, { code: 6, data: 4 });
  assert.deepEqual({ ...debugBudgetForCore("Arm Cortex-M7") }, { code: 8, data: 4 });
  assert.deepEqual({ ...debugBudgetForCore("Arm Cortex-M33") }, { code: 8, data: 4 });
  assert.deepEqual({ ...debugBudgetForCore("Arm Cortex-M55") }, { code: 8, data: 4 });
  // 双核写法（H7/H5 的 db 里就是 "Arm Cortex-M7/ARM Cortex-M7"）按第一个命中算。
  assert.deepEqual({ ...debugBudgetForCore("Arm Cortex-M7/ARM Cortex-M7") }, { code: 8, data: 4 });
  // 读不到内核：不猜，给兜底数值。
  assert.deepEqual({ ...debugBudgetForCore("") }, { ...FALLBACK_DEBUG_BUDGET });
  assert.deepEqual({ ...debugBudgetOfFamily(familyProfileOf("STM32F407VGT6")) }, { code: 6, data: 4 });
});

test("debugBudgetOfFamily：Cortex-A（MP1/MP2）不走比较器模型，返回 null", () => {
  assert.equal(debugBudgetOfFamily(familyProfileOf("STM32MP157F")), null);
  assert.equal(debugBudgetOfFamily(unknownFamilyProfile("X")), null);
});

test("chooseOpenocdTarget：按族给 target；没脚本的族拒绝硬连；认不出族才回退 F1", () => {
  const f1 = chooseOpenocdTarget(familyProfileOf("STM32F1"));
  assert.equal(f1.targetConfig, "target/stm32f1x.cfg");
  assert.equal(f1.error, "");
  assert.equal(chooseOpenocdTarget(familyProfileOf("STM32G4")).targetConfig, "target/stm32g4x.cfg");
  assert.equal(chooseOpenocdTarget(familyProfileOf("STM32L4+")).targetConfig, "target/stm32l4x.cfg");

  // C0 / U0：openocd 0.12 没有官方脚本，但有插件内置的适配版 → 给绝对路径，不报错。
  const c0 = chooseOpenocdTarget(familyProfileOf("STM32C0"));
  assert.equal(c0.error, "");
  assert.equal(c0.bundled, true);
  assert.match(c0.targetConfig, /templates[\\/]openocd[\\/]stm32c0x\.cfg$/u);
  const u0 = chooseOpenocdTarget(familyProfileOf("STM32U0"));
  assert.match(u0.targetConfig, /stm32u0x\.cfg$/u);

  // 既没有官方脚本也没有内置脚本的族：必须报错（拿别的族硬连会连不上或读错 flash 布局），不能悄悄回退。
  const h5 = chooseOpenocdTarget(familyProfileOf("STM32H5"));
  assert.ok(h5.error.length > 0);
  assert.match(h5.error, /openocd.cfg/u);
  assert.equal(h5.targetConfig, "");
  assert.equal(h5.bundled, false);

  // .ioc 都没有（认不出族）：回退 F1，但要说清楚。
  const none = chooseOpenocdTarget(null);
  assert.equal(none.targetConfig, "target/stm32f1x.cfg");
  assert.equal(none.error, "");
  assert.match(none.note, /stm32f1x/u);
});

test("readIocFamilyId：先 Mcu.Family，再 Mcu.CPN；都没有才是空串", () => {
  const withFamily = iocProject("Mcu.CPN=STM32F407VGT6\nMcu.Family=STM32F4\nMcu.Name=STM32F407VGTx\n");
  const cpnOnly = iocProject("Mcu.CPN=STM32F030C8T6\nMcu.Name=STM32F030C8Tx\n");
  const empty = mkdtempSync(join(tmpdir(), "dsh-family-empty-"));
  try {
    assert.equal(readIocFamilyId(withFamily), "STM32F4");
    assert.equal(readIocFamilyId(cpnOnly), "STM32F0");
    assert.equal(readIocFamilyId(empty), "");
    assert.equal(readProjectFamily(withFamily).id, "STM32F4");
    assert.equal(readProjectFamily(cpnOnly).id, "STM32F0");
    assert.equal(readProjectFamily(empty), null);
    // 读不到族时不能默认成 F1：null 才能让调用方说"认不出"。
    assert.equal(readProjectFamily(iocProject("Mcu.Package=LQFP48\n")), null);
  } finally {
    for (const dir of [withFamily, cpnOnly, empty]) rmSync(dir, { recursive: true, force: true });
  }
});

test("parseMcuXml：族/产品线/内核/RAM/Flash 档/引脚总数都从 db 读出来", () => {
  const xml = [
    '<Mcu ClockTree="STM32F103" Family="STM32F1" Line="STM32F103" Package="LQFP48" RefName="STM32F103C(8-B)Tx" xmlns="http://mcd.rou.st.com/modules.php?name=mcu">',
    "<Core>Arm Cortex-M3</Core>",
    "<Frequency>72</Frequency>",
    "<Ram>20</Ram>",
    "<IONb>37</IONb>",
    "<Flash>64</Flash>",
    "<Flash>128</Flash>",
    "<Flash>64</Flash>",
    '<IP InstanceName="USART1" Name="USART" Version="sci2_v1_1_Cube"/>',
    '<Pin Name="PA9" Position="30" Type="I/O"><Signal Name="USART1_TX"/><Signal IOModes="Input,Output" Name="GPIO"/></Pin>',
    "</Mcu>",
  ].join("\n");
  const facts = parseMcuXml(xml);
  assert.notEqual(facts, null);
  assert.equal(facts.family, "STM32F1");
  assert.equal(facts.line, "STM32F103");
  assert.equal(facts.core, "Arm Cortex-M3");
  assert.equal(facts.ramKb, 20);
  assert.equal(facts.ioNb, 37);
  assert.deepEqual(facts.flashKb, [64, 128], "Flash 档去重且保持出现顺序");
  assert.equal(facts.pins.get("PA9").position, 30);
  assert.ok(facts.ips.has("USART1"));
  assert.equal(parseMcuXml("not xml"), null);
});

test("extiVectorsOf：EXTI 的 NVIC 向量分组按内核分档（M0+ / M3 / M33 / Cortex-A）", () => {
  const c0 = familyProfileOf("STM32C031C6T3");
  assert.match(c0.core, /M0\+/u);
  assert.equal(extiVectorNameOf(0, c0), "EXTI0_1");
  assert.equal(extiVectorNameOf(2, c0), "EXTI2_3");
  assert.equal(extiVectorNameOf(4, c0), "EXTI4_15");
  assert.equal(extiVectorNameOf(13, c0), "EXTI4_15");

  const f1 = familyProfileOf("STM32F103C8T6");
  assert.equal(extiVectorNameOf(3, f1), "EXTI3");
  assert.equal(extiVectorNameOf(5, f1), "EXTI9_5");
  assert.equal(extiVectorNameOf(13, f1), "EXTI15_10");

  const u5 = familyProfileOf("STM32U575ZIT6");
  assert.equal(extiVectorNameOf(13, u5), "EXTI13");
  assert.equal(extiVectorsOf(u5).length, 16);

  const mp1 = familyProfileOf("STM32MP157AAC");
  assert.equal(extiVectorNameOf(13, mp1), "", "Cortex-A 不走 NVIC/EXTI 模型");

  // 认不出族（null）→ 按 M3 分组兜底（保持老行为）。
  assert.equal(extiVectorNameOf(13, null), "EXTI15_10");
  assert.equal(extiVectorNameOf(13, unknownFamilyProfile("")), "EXTI15_10");
});

test("instancesWithPins：db 引脚信号里出现过的外设（实例名与族名都给，内核项/板名不在）", () => {
  const xml = [
    '<Mcu Family="STM32C0" Package="LQFP48" RefName="STM32C031C(4-6)Tx">',
    '<Pin Name="PA9" Position="1" Type="I/O"><Signal Name="USART1_TX"/><Signal Name="ADCx_IN1"/><Signal Name="GPIO"/></Pin>',
    '<Pin Name="PA6" Position="2" Type="I/O"><Signal Name="S_TIM3_CH1"/><Signal Name="GPIO"/></Pin>',
    "</Mcu>",
  ].join("\n");
  const facts = parseMcuXml(xml);
  const set = instancesWithPins(facts);
  assert.ok(set.has("USART1") && set.has("USART"), "实例名与族名都要收");
  assert.ok(set.has("TIM3") && set.has("TIM"));
  assert.ok(set.has("ADC"), "ADCx_IN1 只有族名 ADCx → 归到 ADC");
  assert.equal(set.has("CORTEX_M0+"), false);
  assert.equal(set.has("NUCLEO-C031C6"), false);
});
