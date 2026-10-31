// .ioc 事务单测：node test/ioc-plan-units.test.mjs（不要用 node --test：沙箱下 spawn EPERM）
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { applyIocPlan, compareIocKeys, inspectIocText, planIocChanges, renderIocText, rollbackIoc, sha256Hex } from "../lib/engine/ioc-plan.js";
import { parseIocEntries, summarizeIoc } from "../lib/engine/ioc.js";

import { FIXTURE_ASSETS, FIXTURE_PROJECT, e2eWorkDir } from "./fixtures.mjs";

// 引脚只查"名字是否合法"，但 doctor/型号相关代码会读资源包：统一指到夹具，绝不读真实 home 缓存。
process.env.DSH_STM32_ASSETS = FIXTURE_ASSETS;

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
  assert.match(badPin.errors.join(" "), /不是合法的 STM32 GPIO 引脚/u);
  assert.match(badPin.errors.join(" "), /不再内置引脚表/u);

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


function candidateText(projectDir, planId) {
  return readFileSync(join(projectDir, ".dsh-stm32", "plans", planId + ".ioc"), "utf8");
}

test("peripherals(USART1)：一次写全引脚 Mode+Signal、Mcu.IPn、IPParameters", () => {
  const { projectDir, iocPath } = freshProject();
  const report = planIocChanges({ projectDir, peripherals: [{ name: "USART1" }] });
  assert.equal(report.ok, true, report.message);
  const applied = applyIocPlan({ projectDir, planId: report.planId });
  assert.equal(applied.ok, true, applied.message);
  const entries = parseIocEntries(readFileSync(iocPath, "utf8"));
  // 引脚：Mode 是当初实测缺了就整段被 CubeMX 丢弃的那个键。
  assert.equal(entries.get("PA9.Mode"), "Asynchronous");
  assert.equal(entries.get("PA9.Signal"), "USART1_TX");
  assert.equal(entries.get("PA10.Mode"), "Asynchronous");
  assert.equal(entries.get("PA10.Signal"), "USART1_RX");
  assert.equal(entries.get("PA9.Locked"), "true");
  // IP 列表与计数自洽
  assert.equal(entries.get("Mcu.IP3"), "USART1");
  assert.equal(entries.get("Mcu.IPNb"), "4");
  // 参数与 IPParameters 列表
  assert.equal(entries.get("USART1.VirtualMode"), "VM_ASYNC");
  assert.equal(entries.get("USART1.IPParameters"), "VirtualMode");
  // 引脚进 Mcu.PinN
  assert.equal(entries.get("Mcu.Pin8"), "PA9");
  assert.equal(entries.get("Mcu.Pin9"), "PA10");
  assert.equal(entries.get("Mcu.PinsNb"), "10");
  // 自己写的东西不该触发"缺 Mode"告警
  assert.equal(report.warnings.join(" ").includes("没有 .Mode"), false, report.warnings.join(" "));
});

test("peripherals(TIM2)：PA0 换成 db 名 PA0-WKUP，带空格的子键要转义", () => {
  const { projectDir } = freshProject();
  const report = planIocChanges({ projectDir, peripherals: [{ name: "TIM2", parameters: { Prescaler: "71", Period: "999" } }] });
  assert.equal(report.ok, true, report.message);
  const entries = parseIocEntries(candidateText(projectDir, report.planId));
  assert.equal(entries.get("Mcu.Pin8"), "PA0-WKUP", "PA0 在 F1 db 里叫 PA0-WKUP");
  // 共享信号：引脚不带 .Mode，功能由 SH 块表达（CubeMX 自己的写法）
  assert.equal(entries.get("PA0-WKUP.Mode"), undefined);
  assert.equal(entries.get("PA0-WKUP.Signal"), "S_TIM2_CH1_ETR");
  assert.equal(entries.get("SH.S_TIM2_CH1_ETR.0"), "TIM2_CH1,PWM Generation1 CH1");
  assert.equal(entries.get("SH.S_TIM2_CH1_ETR.ConfNb"), "1");
  assert.equal(entries.get("TIM2.Prescaler"), "71");
  assert.equal(entries.get("TIM2.Period"), "999");
  assert.equal(
    entries.get("TIM2.Channel-PWM Generation1 CH1"),
    "TIM_CHANNEL_1",
    "键在 .ioc 里是转义的，解析回来必须还原成带空格的名字",
  );
  const raw = candidateText(projectDir, report.planId);
  assert.match(raw, /^TIM2\.Channel-PWM\\ Generation1\\ CH1=TIM_CHANNEL_1$/mu, "键里的空格必须转义成 \\ ");
  assert.match(raw, /^TIM2\.IPParameters=Channel-PWM Generation1 CH1,Prescaler,Period$/mu, "值里的空格不转义");
});

test("peripherals(ADC1)：# 要转义，并顺带把 ADC 预分频改成 ÷6", () => {
  const { projectDir } = freshProject();
  const report = planIocChanges({ projectDir, peripherals: [{ name: "ADC1" }] });
  assert.equal(report.ok, true, report.message);
  const raw = candidateText(projectDir, report.planId);
  assert.match(raw, /^ADC1\.Rank-0\\#ChannelRegularConversion=1$/mu, "值里的 # 要写成 \\#（CubeMX 自己的写法）");
  const entries = parseIocEntries(raw);
  assert.equal(entries.get("ADC1.Channel-0#ChannelRegularConversion"), "ADC_CHANNEL_1");
  assert.equal(entries.get("ADC1.SamplingTime-0#ChannelRegularConversion"), "ADC_SAMPLETIME_13CYCLES_5");
  assert.equal(entries.get("PA1.Mode"), undefined, "共享信号引脚不写 .Mode");
  assert.equal(entries.get("PA1.Signal"), "ADCx_IN1", "ADC 引脚用共享信号名 ADCx_INn");
  assert.equal(entries.get("SH.ADCx_IN1.0"), "ADC1_IN1,IN1");
  assert.equal(entries.get("SH.ADCx_IN1.ConfNb"), "1");
  // 72 MHz ÷6 = 12 MHz（F1 的 ADC 上限 14 MHz）
  assert.equal(entries.get("RCC.ADCPresc"), "RCC_ADCPCLK2_DIV6");
  assert.match(entries.get("RCC.IPParameters") ?? "", /(^|,)ADCPresc(,|$)/u, "RCC.IPParameters 必须合并进 ADCPresc");
});

test("peripherals：不认识的名字直接报错，并列出内置预设", () => {
  const { projectDir } = freshProject();
  const report = planIocChanges({ projectDir, peripherals: [{ name: "SPI1" }] });
  assert.equal(report.ok, false);
  assert.match(report.errors.join(" "), /不认识的外设预设/u);
  assert.match(report.errors.join(" "), /USART1/u);
});

test("peripherals：引脚已被别的功能占用时报错，不静默改信号", () => {
  const { projectDir } = freshProject();
  const report = planIocChanges({ projectDir, peripherals: [{ name: "USART1", pins: { tx: "PA13" } }] });
  assert.equal(report.ok, false);
  assert.match(report.errors.join(" "), /已经配成 SYS_JTMS-SWDIO/u);
});

test("自洽校验：外设进了 Mcu.IPn 却没有引脚 .Mode → 警告 CubeMX 会静默丢弃", () => {
  const { projectDir } = freshProject();
  const report = planIocChanges({
    projectDir,
    entries: [
      { key: "Mcu.IP3", value: "USART1" },
      { key: "Mcu.IPNb", value: "4" },
      { key: "PA9.Signal", value: "USART1_TX" },
    ],
  });
  assert.equal(report.ok, true, report.message);
  assert.match(report.warnings.join(" "), /PA9 既没有 \.Mode 也没有 SH\./u);
  assert.match(report.warnings.join(" "), /静默丢弃/u);
});

test("自洽校验：共享信号引脚缺 SH 块也要告警（定时器/ADC 的真实坑）", () => {
  const { projectDir } = freshProject();
  const report = planIocChanges({
    projectDir,
    entries: [
      { key: "Mcu.IP3", value: "TIM3" },
      { key: "Mcu.IPNb", value: "4" },
      { key: "Mcu.Pin8", value: "PA6" },
      { key: "Mcu.PinsNb", value: "9" },
      { key: "PA6.Signal", value: "S_TIM3_CH1" },
      { key: "TIM3.IPParameters", value: "Channel-PWM Generation1 CH1" },
      { key: "TIM3.Channel-PWM Generation1 CH1", value: "TIM_CHANNEL_1" },
    ],
  });
  assert.equal(report.ok, true, report.message);
  assert.match(report.warnings.join(" "), /PA6 既没有 \.Mode 也没有 SH\./u);
});

test("peripherals：共享信号块会追加第二个实例（ADC1 之后再加 ADC2 → ConfNb=2）", () => {
  const { projectDir } = freshProject();
  const report = planIocChanges({ projectDir, peripherals: [{ name: "ADC1" }, { name: "ADC2" }] });
  assert.equal(report.ok, true, report.message);
  const entries = parseIocEntries(candidateText(projectDir, report.planId));
  assert.equal(entries.get("SH.ADCx_IN1.ConfNb"), "2");
  assert.equal(entries.get("SH.ADCx_IN1.0"), "ADC1_IN1,IN1");
  assert.equal(entries.get("SH.ADCx_IN1.1"), "ADC2_IN1,IN1");
  assert.equal(entries.get("Mcu.IP3"), "ADC1");
  assert.equal(entries.get("Mcu.IP4"), "ADC2");
});

test("peripherals(TIM3)：预设自己写出的共享信号不该触发告警", () => {
  const { projectDir } = freshProject();
  const report = planIocChanges({ projectDir, peripherals: [{ name: "TIM3" }] });
  assert.equal(report.ok, true, report.message);
  assert.equal(report.warnings.join(" ").includes("既没有"), false, report.warnings.join(" "));
});

test("自洽校验：Mcu.IPNb 与实际 Mcu.IPn 条数不一致 → 警告", () => {
  const { projectDir } = freshProject();
  const report = planIocChanges({ projectDir, entries: [{ key: "Mcu.IPNb", value: "9" }] });
  assert.equal(report.ok, true, report.message);
  assert.match(report.warnings.join(" "), /Mcu\.IPNb=9 但实际有 3 个/u);
});

test("renderIocText：新增键按 key 排序插入，不再一律追加到文件末尾", () => {
  const source = ["Alpha.x=1", "Gamma.z=3", "", "# 注释"].join("\n") + "\n";
  const rendered = renderIocText(source, [
    { key: "Beta.y", before: null, after: "2" },
    { key: "Beta.a", before: null, after: "0" },
  ]);
  assert.equal(rendered, ["Alpha.x=1", "Beta.a=0", "Beta.y=2", "Gamma.z=3", "", "# 注释"].join("\n") + "\n");
});

test("renderIocText：数字按数值排序（Mcu.Pin10 排在 Mcu.Pin2 之后，与 CubeMX 一致）", () => {
  assert.ok(compareIocKeys("Mcu.Pin2", "Mcu.Pin10") < 0);
  assert.ok(compareIocKeys("Mcu.IP3", "Mcu.IPNb") < 0);
  assert.ok(compareIocKeys("ADC1.master", "CAD.formats") < 0, "official .ioc 里 ADC1.* 就在文件最前面");
  assert.ok(compareIocKeys("VP_SYS_VS_Systick.Mode", "board") < 0);
  const source = "Mcu.Pin2=PC1\n";
  const rendered = renderIocText(source, [
    { key: "Mcu.Pin10", before: null, after: "PC3" },
    { key: "Mcu.Pin9", before: null, after: "PC2" },
  ]);
  assert.equal(rendered, "Mcu.Pin2=PC1\nMcu.Pin9=PC2\nMcu.Pin10=PC3\n");
});

test("无损：没有任何改动时 renderIocText 必须逐字节还原原文（含 CRLF 与末尾换行有无）", () => {
  const lfWithNewline = "#c\na=1\nb=2\n";
  const crlfWithNewline = "#c\r\na=1\r\nb=2\r\n";
  const lfNoNewline = "#c\na=1\nb=2";
  const crlfNoNewline = "#c\r\na=1\r\nb=2";
  for (const text of [lfWithNewline, crlfWithNewline, lfNoNewline, crlfNoNewline]) {
    assert.equal(renderIocText(text, []), text);
  }
});

test("无损：改键时保留 CRLF，也不擅自补末尾换行", () => {
  const source = "#c\r\na=1\r\nb=2";
  const rendered = renderIocText(source, [{ key: "b", before: "2", after: "3" }]);
  assert.equal(rendered, "#c\r\na=1\r\nb=3", "原来没有末尾换行，改完也不能有");
  const withTail = renderIocText("#c\r\na=1\r\n", [{ key: "a", before: "1", after: "9" }]);
  assert.equal(withTail, "#c\r\na=9\r\n", "原来有末尾换行就得保留");
});

test("无损：新增键插在末尾空行之前，末尾空行原样保留", () => {
  const source = "#c\r\na=1\r\n\r\n";
  const rendered = renderIocText(source, [{ key: "b", before: null, after: "2" }]);
  assert.equal(rendered, "#c\r\na=1\r\nb=2\r\n\r\n", "保留末尾空行，新键插在它之前");
});

test("无损：混合换行（CRLF + LF）时统一成多数派，并在计划阶段告警", () => {
  const { projectDir, iocPath } = freshProject();
  const text = readFileSync(iocPath, "utf8").replace(/\r\n/gu, "\n") + "PA5.Signal=X\r\n";
  writeFileSync(iocPath, text, "utf8");
  const report = planIocChanges({ projectDir, pins: [{ pin: "PA6", label: "led3", signal: "output" }] });
  assert.equal(report.ok, true, report.message);
  assert.match(report.warnings.join(" "), /换行不一致/u);
});

test("编码：非 UTF-8（GBK）直接拒绝，不猜编码", () => {
  const { projectDir, iocPath } = freshProject();
  writeFileSync(iocPath, Buffer.from([0x23, 0x63, 0xd6, 0xd0, 0xce, 0xc4, 0x0a]), "binary");
  const report = planIocChanges({ projectDir, pins: [{ pin: "PA5", label: "led2", signal: "output" }] });
  assert.equal(report.ok, false);
  assert.match(report.errors.join(" "), /UTF-8/u);
  assert.match(report.errors.join(" "), /GBK/u);
});

test("坏行：既不是注释也没有等号 → 告警（CubeMX 会当垃圾行丢掉）", () => {
  const { projectDir, iocPath } = freshProject();
  const text = readFileSync(iocPath, "utf8") + "PA5.Signal\n";
  writeFileSync(iocPath, text, "utf8");
  const report = planIocChanges({ projectDir, pins: [{ pin: "PA6", label: "led3", signal: "output" }] });
  assert.equal(report.ok, true, report.message);
  assert.match(report.warnings.join(" "), /既不是 # 注释、也没有/u);
});

test("重复键：要改的键出现多次 → 拒绝，并说清 CubeMX 只认最后一个", () => {
  const { projectDir, iocPath } = freshProject();
  const text = readFileSync(iocPath, "utf8") + "ProjectManager.KeepUserCode=false\nProjectManager.KeepUserCode=false\n";
  writeFileSync(iocPath, text, "utf8");
  const report = planIocChanges({ projectDir, entries: [{ key: "ProjectManager.KeepUserCode", value: "true" }] });
  assert.equal(report.ok, false);
  assert.match(report.errors.join(" "), /出现了不止一次/u);
  assert.match(report.errors.join(" "), /KeepUserCode/u);
});

test("续行：反斜杠结尾的行与下一行拼成一个逻辑行（官方 .ioc 里真有这种折行值）", () => {
  const text = "ProjectManager.functionlistsort=1-SystemClock_Config-RCC-false-HAL-false,\\\n   2-MX_GPIO_Init-GPIO-false-HAL-true\n";
  const entries = parseIocEntries(text);
  assert.equal(
    entries.get("ProjectManager.functionlistsort"),
    "1-SystemClock_Config-RCC-false-HAL-false,2-MX_GPIO_Init-GPIO-false-HAL-true",
    "续行的前导空白要去掉，值要完整",
  );
  const diag = inspectIocText(text);
  assert.deepEqual(diag.malformedLines, [], "续行不是坏行");
  assert.equal(diag.multiLineKeys.has("ProjectManager.functionlistsort"), true);
});

test("续行：要改的键值跨多行时拒绝，并说明会留下续行残骸", () => {
  const { projectDir, iocPath } = freshProject();
  const text = readFileSync(iocPath, "utf8").replace(/\r?\n/gu, "\n") +
    "ProjectManager.functionlistsort=1-A-RCC-false-HAL-false,\\\n   2-B-GPIO-false-HAL-true\n";
  writeFileSync(iocPath, text, "utf8");
  const report = planIocChanges({ projectDir, entries: [{ key: "ProjectManager.functionlistsort", value: "x" }] });
  assert.equal(report.ok, false);
  assert.match(report.errors.join(" "), /跨了多行/u);
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
