// .ioc 事务单测：node test/ioc-plan-units.test.mjs（不要用 node --test：沙箱下 spawn EPERM）
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { applyIocPlan, planIocChanges, rollbackIoc, sha256Hex } from "../lib/engine/ioc-plan.js";
import { summarizeIoc } from "../lib/engine/ioc.js";

import { FIXTURE_PROJECT, e2eWorkDir } from "./fixtures.mjs";

const DEMO_IOC = join(FIXTURE_PROJECT, "demo.ioc");
const TMP = e2eWorkDir("ioc-test");

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function freshProject() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  copyFileSync(DEMO_IOC, join(TMP, "demo.ioc"));
  return { projectDir: TMP, iocPath: join(TMP, "demo.ioc") };
}

test("plan 只算不写：源文件 SHA-256 不变，候选文件已落盘", () => {
  const { projectDir, iocPath } = freshProject();
  const before = sha256Hex(readFileSync(iocPath, "utf8"));
  const report = planIocChanges({ projectDir, pins: [{ pin: "PA5", label: "led2", signal: "output" }] });
  assert.equal(report.ok, true, report.message);
  assert.equal(sha256Hex(readFileSync(iocPath, "utf8")), before, "plan 不许改 .ioc");
  assert.equal(existsSync(join(projectDir, ".dsh-stm32", "plans", report.planId + ".ioc")), true);
  const keys = report.changes.map((change) => change.key);
  assert.ok(keys.includes("PA5.Signal"), "应写入 PA5.Signal");
  assert.ok(keys.includes("PA5.GPIO_Label"));
  assert.equal(report.changes.find((change) => change.key === "Mcu.PinsNb")?.after, "9");
  assert.equal(report.changes.find((change) => change.key === "Mcu.Pin8")?.after, "PA5");
  // 候选内容的语义：新引脚真的进了引脚表
  assert.equal(report.summaryAfter?.pins.some((pin) => pin.pin === "PA5" && pin.label === "led2"), true);
});

test("apply 成功：SHA 与候选一致、备份存在、引脚真的落地", () => {
  const { projectDir, iocPath } = freshProject();
  const plan = planIocChanges({ projectDir, pins: [{ pin: "PA0", label: "key", signal: "input", pull: "up" }] });
  const applied = applyIocPlan({ projectDir, planId: plan.planId });
  assert.equal(applied.ok, true, applied.message);
  assert.equal(applied.shaAfter, plan.candidateSha256);
  assert.equal(existsSync(applied.backupPath), true);
  const summary = summarizeIoc(readFileSync(iocPath, "utf8"), iocPath);
  const key = summary.pins.find((pin) => pin.pin === "PA0");
  assert.equal(key?.signal, "GPIO_Input");
  assert.equal(key?.label, "key");
  // 备份就是原文件
  assert.equal(sha256Hex(readFileSync(applied.backupPath, "utf8")), plan.sourceSha256);
});

test("apply 拒绝：plan 之后 .ioc 被人改过（SHA 不一致）", () => {
  const { projectDir, iocPath } = freshProject();
  const plan = planIocChanges({ projectDir, entries: [{ key: "ProjectManager.HeapSize", value: "0x400" }] });
  writeFileSync(iocPath, readFileSync(iocPath, "utf8").replace("HeapSize=0x200", "HeapSize=0x300"), "utf8");
  const applied = applyIocPlan({ projectDir, planId: plan.planId });
  assert.equal(applied.ok, false);
  assert.match(applied.message, /SHA-256/u);
  // 拒绝时一个字节都不能写
  assert.match(readFileSync(iocPath, "utf8"), /HeapSize=0x300/u);
});

test("apply 拒绝：planId 不存在（不猜、不写）", () => {
  const { projectDir } = freshProject();
  const applied = applyIocPlan({ projectDir, planId: "deadbeefdeadbeef" });
  assert.equal(applied.ok, false);
  assert.match(applied.message, /找不到计划/u);
});

test("没有变化时 plan 直接返回（不产生空计划）", () => {
  const { projectDir } = freshProject();
  const report = planIocChanges({ projectDir, entries: [{ key: "ProjectManager.HeapSize", value: "0x200" }] });
  assert.equal(report.ok, false);
  assert.match(report.message, /没有变化/u);
});

test("引脚校验：未知引脚 / 重复引脚 / 非法标签 / 标签重名", () => {
  const { projectDir } = freshProject();
  const badPin = planIocChanges({ projectDir, pins: [{ pin: "PA99" }] });
  assert.equal(badPin.ok, false);
  assert.match(badPin.errors.join(" "), /不在 STM32F103C8T6 的引脚表里/u);

  const dupPin = planIocChanges({ projectDir, pins: [{ pin: "PC13-TAMPER-RTC" }] });
  assert.equal(dupPin.ok, false);
  assert.match(dupPin.errors.join(" "), /已经/u);

  const badLabel = planIocChanges({ projectDir, pins: [{ pin: "PA1", label: "1bad" }] });
  assert.equal(badLabel.ok, false);
  assert.match(badLabel.errors.join(" "), /合法 C 标识符/u);

  const dupLabel = planIocChanges({ projectDir, pins: [{ pin: "PA1", label: "led" }] });
  assert.equal(dupLabel.ok, false);
  assert.match(dupLabel.errors.join(" "), /占用/u);
});

test("serialWire：清掉 No_Debug 遗留并补上 PA13/PA14", () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const iocPath = join(TMP, "scratch.ioc");
  writeFileSync(iocPath, [
    "Mcu.CPN=STM32F103C8T6",
    "Mcu.PinsNb=2",
    "Mcu.Pin0=PC13-TAMPER-RTC",
    "Mcu.Pin1=VP_SYS_VS_ND",
    "PC13-TAMPER-RTC.Signal=GPIO_Output",
    "PC13-TAMPER-RTC.GPIO_Label=led",
    "VP_SYS_VS_ND.Mode=No_Debug",
    "VP_SYS_VS_ND.Signal=SYS_VS_ND",
    "ProjectManager.TargetToolchain=CMake",
    "ProjectManager.KeepUserCode=true",
  ].join("\n"), "utf8");
  // 起点没有 Serial Wire → 不给 plan（安全闸）
  const blocked = planIocChanges({ projectDir: TMP });
  assert.equal(blocked.ok, false);
  assert.match(blocked.errors.join(" "), /Serial Wire/u);

  const plan = planIocChanges({ projectDir: TMP, serialWire: true });
  assert.equal(plan.ok, true, plan.message);
  const keys = plan.changes.map((change) => change.key);
  assert.ok(keys.includes("PA13.Signal"));
  assert.ok(keys.includes("PA14.Signal"));
  assert.ok(keys.includes("VP_SYS_VS_ND.Mode") && plan.changes.find((c) => c.key === "VP_SYS_VS_ND.Mode")?.after === null);
  assert.equal(plan.summaryAfter?.debug.serialWire, true);
  const applied = applyIocPlan({ projectDir: TMP, planId: plan.planId });
  assert.equal(applied.ok, true, applied.message);
});

test("rollback：把备份写回去，内容与 plan 前一致", () => {
  const { projectDir, iocPath } = freshProject();
  const original = readFileSync(iocPath, "utf8");
  const plan = planIocChanges({ projectDir, entries: [{ key: "ProjectManager.StackSize", value: "0x800" }] });
  const applied = applyIocPlan({ projectDir, planId: plan.planId });
  assert.equal(applied.ok, true);
  assert.notEqual(readFileSync(iocPath, "utf8"), original);
  const rolled = rollbackIoc({ projectDir, backupFrom: applied.backupPath });
  assert.equal(rolled.ok, true, rolled.message);
  assert.equal(sha256Hex(readFileSync(iocPath, "utf8")), sha256Hex(original));
});

test("rollback 拒绝：不在 backups 目录下的路径", () => {
  const { projectDir, iocPath } = freshProject();
  const rolled = rollbackIoc({ projectDir, backupFrom: iocPath });
  assert.equal(rolled.ok, false);
  assert.match(rolled.message, /backups/u);
});

test("保留没有 .Signal 的引脚（PB2/BOOT1）：重写引脚表时不剔除，也不留孤儿键", () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const iocPath = join(TMP, "boot1.ioc");
  writeFileSync(iocPath, [
    "Mcu.CPN=STM32F103C8T6",
    "Mcu.PinsNb=3",
    "Mcu.Pin0=PC13-TAMPER-RTC",
    "Mcu.Pin1=PB2",
    "Mcu.Pin2=VP_SYS_VS_ND",
    "PC13-TAMPER-RTC.Signal=GPIO_Output",
    "PC13-TAMPER-RTC.GPIO_Label=led",
    // BOOT1 是复用功能：CubeMX 只写 .Mode，没有 .Signal（正是当初被按 .Signal 过滤掉的那种引脚）。
    "PB2.Mode=B2-BOOT1",
    "PB2.GPIO_Label=boot1",
    "VP_SYS_VS_ND.Mode=No_Debug",
    "VP_SYS_VS_ND.Signal=SYS_VS_ND",
    "ProjectManager.TargetToolchain=CMake",
    "ProjectManager.KeepUserCode=true",
  ].join("\n") + "\n", "utf8");

  const plan = planIocChanges({
    projectDir: TMP,
    serialWire: true,
    pins: [{ pin: "PA5", label: "led2", signal: "output" }],
  });
  assert.equal(plan.ok, true, plan.message);
  const applied = applyIocPlan({ projectDir: TMP, planId: plan.planId });
  assert.equal(applied.ok, true, applied.message);

  const text = readFileSync(iocPath, "utf8");
  const pins = [];
  for (let index = 0; ; index += 1) {
    const match = new RegExp("^Mcu\\.Pin" + index + "=(.+)$", "mu").exec(text);
    if (match === null) break;
    pins.push((match[1] ?? "").trim());
  }
  const declared = Number(/^Mcu\.PinsNb=(\d+)$/mu.exec(text)?.[1]);
  assert.equal(pins.length, declared, "PinsNb 必须与实际写出的 Mcu.PinN 项数一致");
  assert.ok(pins.includes("PB2"), "PB2 不能被从引脚表里剔除");
  assert.ok(pins.includes("PA5"), "新引脚要真的追加进引脚表");
  assert.ok(pins.includes("PA13") && pins.includes("PA14"), "serialWire 补的调试口也要在表里");
  assert.equal(pins.includes("VP_SYS_VS_ND"), false, "No_Debug 的虚拟引脚仍要清掉");
  assert.deepEqual(pins.slice(0, 3), ["PC13-TAMPER-RTC", "PB2", "PA5"], "已有引脚顺序不能乱");
  assert.match(text, /^PB2\.Mode=B2-BOOT1$/mu, "PB2 的配置不能变成没人指向的孤儿键");
  assert.match(text, /^PB2\.GPIO_Label=boot1$/mu);
});

test("引脚表没变就不重写 Mcu.PinN（serialWire 已就位时一个 Mcu.Pin* 键都不碰）", () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const iocPath = join(TMP, "sw-ok.ioc");
  writeFileSync(iocPath, [
    "Mcu.CPN=STM32F103C8T6",
    "Mcu.PinsNb=4",
    "Mcu.Pin0=PC13-TAMPER-RTC",
    "Mcu.Pin1=PB2",
    "Mcu.Pin2=PA13",
    "Mcu.Pin3=PA14",
    "PC13-TAMPER-RTC.Signal=GPIO_Output",
    "PB2.Mode=B2-BOOT1",
    "PA13.Mode=Serial_Wire",
    "PA13.Signal=SYS_JTMS-SWDIO",
    "PA14.Mode=Serial_Wire",
    "PA14.Signal=SYS_JTCK-SWCLK",
    "ProjectManager.TargetToolchain=CMake",
    "ProjectManager.KeepUserCode=true",
  ].join("\n") + "\n", "utf8");

  const plan = planIocChanges({
    projectDir: TMP,
    serialWire: true,
    entries: [{ key: "ProjectManager.HeapSize", value: "0x400" }],
  });
  assert.equal(plan.ok, true, plan.message);
  const keys = plan.changes.map((change) => change.key);
  assert.equal(
    keys.some((key) => key.startsWith("Mcu.Pin")),
    false,
    "引脚表没变化时不该出现任何 Mcu.Pin* 改动（否则会白改字节）",
  );
  assert.ok(keys.includes("ProjectManager.HeapSize"));
});

let failed = 0;
for (const item of cases) {
  try {
    item.fn();
    console.log("ok   " + item.name);
  } catch (error) {
    failed += 1;
    console.log("FAIL " + item.name);
    console.log(String(error && error.message ? error.message : error));
  }
}
rmSync(TMP, { recursive: true, force: true });
console.log("---");
console.log("tests " + cases.length + " / fail " + failed);
process.exit(failed === 0 ? 0 : 1);
