// 为什么要有这个套件：route_plan 的价值全在"评估"这一步的判断上（哪个外设能寄存器、哪个必须 HAL），
// 以及门禁对"能代装 / 只能人装"的分流。这两处写错的表现不是崩溃，而是给用户一条走不通的路
// （例如让他手写 USB 协议栈，或在缺 CubeMX 时告诉他"回一句装"）。所以逐条钉住判断与文案。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { familyOf, findFirmwarePackage } from "../lib/engine/route-plan.js";
import { assessRoute } from "../lib/engine/route-plan.js";
import { ensureToolchain, resetGateCache } from "../lib/engine/toolchain-gate.js";
import { cubeMxGuide, firmwareGuide, firmwareSizeHint, guideFor, guidesFor } from "../lib/data/install-guides.js";

function tempDir(tag) {
  return mkdtempSync(join(tmpdir(), "dsh-stm32-route-" + tag + "-"));
}

// ── 评估：外设识别 ────────────────────────────────────────────────────────

test("小而定型的外设（LED + 串口轮询）判成 register-ok，且两个外设都给寄存器建议", () => {
  const result = assessRoute({ requirement: "按键控制 LED，串口每秒打印一次状态" });
  assert.equal(result.verdict, "register-ok");
  const ids = result.devices.map((device) => device.id).sort();
  assert.deepEqual(ids, ["gpio", "usart-poll"]);
  for (const device of result.devices) assert.equal(device.advice, "register");
  assert.ok(result.devices.every((device) => device.reg !== null));
  assert.ok(result.recommendations.some((line) => line.includes("寄存器版够用")));
});

test("协议栈级外设（USB / RTOS）判成 hal-only，且说明为什么没有寄存器版", () => {
  const result = assessRoute({ requirement: "用 FreeRTOS 跑两个任务，并通过 USB HID 上报状态" });
  assert.equal(result.verdict, "hal-only");
  assert.ok(result.devices.length >= 2);
  for (const device of result.devices) {
    assert.equal(device.advice, "hal-required");
    assert.equal(device.reg, null);
    assert.ok(device.reason.length > 10);
  }
  assert.ok(result.delta.some((line) => line.includes("hal-required")));
});

test("能做但风险高（I2C）判成 both-viable，delta 里给效率/可读性/排错四条对比", () => {
  const result = assessRoute({ requirement: "用 I2C 读 MPU6050 的加速度" });
  assert.equal(result.verdict, "both-viable");
  const device = result.devices.find((item) => item.id === "i2c");
  assert.ok(device, "应该识别出 i2c");
  assert.equal(device.advice, "hal");
  assert.ok(device.reg !== null && device.reg.risk >= 3);
  assert.ok(result.delta.length >= 4);
  assert.ok(result.recommendations.some((line) => line.includes("用 HAL 才有把握")));
});

test("同族只留最具体的一条：说「串口中断」时不再单列「串口轮询」", () => {
  const result = assessRoute({ requirement: "串口中断收不定长数据，再转发" });
  const usart = result.devices.filter((device) => device.id.startsWith("usart"));
  assert.equal(usart.length, 1);
  assert.equal(usart[0].id, "usart-irq");
});

test("显式 peripherals 与需求文本合并；认不出的词进 unknown 并给出提示", () => {
  const result = assessRoute({
    requirement: "读一个传感器",
    peripherals: ["spi", "量子纠缠模块"],
  });
  const ids = result.devices.map((device) => device.id);
  assert.deepEqual(ids, ["spi"]);
  assert.deepEqual(result.unknown, ["量子纠缠模块"]);
  assert.ok(result.recommendations.some((line) => line.includes("量子纠缠模块")));
});

test("什么都没识别出来时判 unclear，而不是瞎猜一条路线", () => {
  const result = assessRoute({ requirement: "" });
  assert.equal(result.verdict, "unclear");
  assert.equal(result.devices.length, 0);
  assert.ok(result.recommendations[0].includes("把要做的事说具体些"));
});

test(".ioc 里已使能的外设被算作证据（matchedBy 里有 ioc）", () => {
  const result = assessRoute({ requirement: "把已有工程加一个按键", iocPeripherals: ["USART1", "TIM2"] });
  const usart = result.devices.find((device) => device.id === "usart-poll");
  assert.ok(usart, "USART1 应该被识别");
  assert.ok(usart.matchedBy.includes("ioc"));
  assert.ok(result.notes.some((line) => line.includes("2 个外设")));
});

// ── 芯片族与固件包 ────────────────────────────────────────────────────────

test("型号 → 芯片族：F103C8T6→F1、G431→G4、H743→H7，认不出给空串", () => {
  assert.equal(familyOf("STM32F103C8T6"), "F1");
  assert.equal(familyOf("stm32g431cb"), "G4");
  assert.equal(familyOf("STM32H743ZIT6"), "H7");
  assert.equal(familyOf("ESP32"), "");
  assert.equal(familyOf(""), "");
});

test("固件包：完整包（HAL + CMSIS + 设备头）算找到，同族多版本取字典序最大的", () => {
  const root = tempDir("fw-ok");
  const repo = join(root, "Repository");
  for (const name of ["STM32Cube_FW_F1_V1.8.0", "STM32Cube_FW_F1_V1.8.7"]) {
    const dir = join(repo, name);
    mkdirSync(join(dir, "Drivers", "STM32F1xx_HAL_Driver"), { recursive: true });
    mkdirSync(join(dir, "Drivers", "CMSIS", "Include"), { recursive: true });
    mkdirSync(join(dir, "Drivers", "CMSIS", "Device", "ST", "STM32F1xx"), { recursive: true });
  }
  const check = findFirmwarePackage([root], "STM32F103C8T6");
  assert.equal(check.found, true);
  assert.equal(check.packageName, "STM32Cube_FW_F1_V1.8.7");
  assert.equal(check.incomplete, false);
  rmSync(root, { recursive: true, force: true });
});

test("固件包：只有外壳目录（GitHub 源码包解开的样子）算半成品，并说明重装哪个包", () => {
  const root = tempDir("fw-broken");
  const dir = join(root, "Repository", "STM32Cube_FW_F1_V1.8.7");
  mkdirSync(join(dir, "Drivers", "STM32F1xx_HAL_Driver"), { recursive: true });
  const check = findFirmwarePackage([root], "F1");
  assert.equal(check.found, false);
  assert.equal(check.incomplete, true);
  assert.equal(check.packageName, "STM32Cube_FW_F1_V1.8.7");
  assert.ok(check.message.includes("半成品"));
  rmSync(root, { recursive: true, force: true });
});

test("固件包：没有 Repository 目录时如实说没找到，不抛异常", () => {
  const root = tempDir("fw-none");
  const check = findFirmwarePackage([root, join(root, "nope")], "F1");
  assert.equal(check.found, false);
  assert.equal(check.incomplete, false);
  assert.ok(check.message.includes("STM32Cube_FW_F1"));
  assert.ok(check.repositoryDir.endsWith("Repository"));
  rmSync(root, { recursive: true, force: true });
});

// ── 门禁：可代装 vs 只能人装 ──────────────────────────────────────────────

const fakeCtx = { get: () => undefined };

test("缺 CubeMX 时门禁标 manual + 给指引，且不再说「回一句装」", async () => {
  resetGateCache();
  const gate = await ensureToolchain(fakeCtx, {
    capability: "generate",
    cubeMxRoots: ["D:/__dsh_missing_cubemx__"],
    envCheck: "block",
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.installability, "manual");
  assert.ok(gate.missing.every((item) => item.installability === "manual"));
  assert.equal(gate.guides.length, 1, "cubemx 与 cubemx-java 应合并成一份指引");
  assert.equal(gate.guides[0].component, "cubemx");
  assert.ok(gate.guides[0].steps.length >= 3);
  assert.ok(gate.message.includes("没有开始生成代码"));
  assert.ok(!gate.nextStep.includes("回一句「装」"));
  assert.ok(gate.nextStep.includes("guides[]"));
  assert.ok(gate.detail.includes("方式：手动"));
  resetGateCache();
});

test("缺 gcc/cmake/ninja 时门禁标 auto，仍可代装（指引为空）", async () => {
  resetGateCache();
  const gate = await ensureToolchain(fakeCtx, {
    capability: "build",
    binDirs: ["D:/__dsh_missing_bin__"],
    envCheck: "block",
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.installability, "auto");
  assert.deepEqual(gate.guides, []);
  assert.ok(gate.missing.length >= 1);
  assert.ok(gate.missing.every((item) => item.installability === "auto"));
  assert.ok(gate.nextStep.includes("回一句「装」"));
  resetGateCache();
});

test("自动项与手动项混在一起时，两句话分开说清楚谁归谁", async () => {
  resetGateCache();
  // generate 只查 cubemx/cubemx-java（都 manual），这里用 build + 一份假 cubemx 缺件组合不出来，
  // 所以直接校验分流函数本身：auto 项走「装」，manual 项走 guides。
  const manualOnly = guidesFor(["cubemx", "cubemx-java", "gcc"]);
  assert.equal(manualOnly.length, 1);
  assert.equal(manualOnly[0].component, "cubemx");
  assert.equal(guideFor("gcc"), null);
  assert.ok(guideFor("cubemx").why.includes("ST 账号"));
  resetGateCache();
});

// ── 指引文案：体积提示必须跟着系列走 ────────────────────────────────────

test("固件包体积提示跟着系列走，不把 F1 的数字扣给 H7", () => {
  const f1 = firmwareGuide({ family: "F1", packageName: "STM32Cube_FW_F1_V1.8.7", repositoryDir: "C:/repo" });
  const f4 = firmwareGuide({ family: "F4", packageName: "", repositoryDir: "C:/repo" });
  const h7 = firmwareGuide({ family: "H7", packageName: "", repositoryDir: "C:/repo" });

  assert.ok(f1.sizeHint.includes("293"), "F1 是实测过的系列，应给准确数字");
  assert.ok(f4.sizeHint.includes("1,674"), "F4 与 F1 差 6 倍，不能被写成同一个数");
  assert.notEqual(f1.sizeHint, f4.sizeHint);

  assert.ok(!h7.sizeHint.includes("F1"), "没实测过的系列不能借用别的系列的说法");
  assert.ok(h7.sizeHint.includes("250 MB – 1.7 GB"), "没实测过的系列给区间");
  assert.ok(h7.label.includes("STM32Cube_FW_H7_V<版本>"), "包名占位符也要跟着系列走");

  assert.equal(firmwareSizeHint("g4"), firmwareSizeHint("G4"), "小写族名应等价");
  assert.ok(!cubeMxGuide().sizeHint.includes("F1"), "CubeMX 那条指引不该提具体哪一代固件包");
});
