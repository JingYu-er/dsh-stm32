// .ioc 事务单测：node test/ioc-plan-units.test.mjs（不要用 node --test：沙箱下 spawn EPERM）
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { applyIocPlan, compareIocKeys, encodeIocValue, inspectIocText, planIocChanges, renderIocText, rollbackIoc, sha256Hex } from "../lib/engine/ioc-plan.js";
import { parseIocEntries, summarizeIoc } from "../lib/engine/ioc.js";

import { FIXTURE_ASSETS, FIXTURE_PROJECT, e2eWorkDir } from "./fixtures.mjs";

// 引脚只查"名字是否合法"，但 doctor/型号相关代码会读资源包：统一指到夹具，绝不读真实 home 缓存。
process.env.DSH_STM32_ASSETS = FIXTURE_ASSETS;

const DEMO_IOC = join(FIXTURE_PROJECT, "demo.ioc");
const TMP = e2eWorkDir("ioc-test");

function writeFakeCubeMxDb(root, mcuName, pins) {
  mkdirSync(join(root, "db", "mcu"), { recursive: true });
  const packageXml = '<PackDescription Release="DB.6.0.150"/>' + "\n";
  writeFileSync(join(root, "db", "package.xml"), packageXml, "utf8");
  const body = pins
    .map((pin, index) =>
      '  <Pin Name="' + pin + '" Position="' + String(index + 1) + '" Type="I/O">' +
        '\n    <Signal Name="GPIO"/>\n  </Pin>',
    )
    .join("\n");
  const mcuXml = '<Mcu Family="STM32F1" Package="LQFP48" RefName="' + mcuName + '">' + "\n" + body + "\n</Mcu>\n";
  writeFileSync(join(root, "db", "mcu", mcuName + ".xml"), mcuXml, "utf8");
}
/** 临时切环境变量跑 fn，跑完还原（这些开关是全局的，不能漏）。 */
function withEnv(pairs, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(pairs)) {
    saved[key] = process.env[key];
    if (value === null) delete process.env[key]; else process.env[key] = value;
  }
  try { return fn(); }
  finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

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
  // Mcu.Pin<i> 按 db Position 升序写（虚拟脚最后），所以新脚具体落在哪个下标不固定——按下标断言会假失败。
  const candidate = parseIocEntries(candidateText(projectDir, report.planId));
  const pinOrder = [];
  for (let index = 0; ; index += 1) {
    const pin = candidate.get("Mcu.Pin" + String(index));
    if (pin === undefined) break;
    pinOrder.push(pin);
  }
  assert.ok(pinOrder.includes("PA5"), "PA5 要进引脚表：" + JSON.stringify(pinOrder));
  assert.equal(pinOrder[pinOrder.length - 1], "VP_SYS_VS_Systick", "虚拟脚永远在最后");
  // 候选内容的语义：新引脚真的进了引脚表
  assert.equal(report.summaryAfter?.pins.some((pin) => pin.pin === "PA5" && pin.label === "led2"), true);
});

test("GPIO 只写非默认属性：默认输出脚没有 GPIO_PuPd/GPIO_Speed，GPIOParameters 只列写了的名字", () => {
  const { projectDir } = freshProject();
  const report = planIocChanges({ projectDir, pins: [{ pin: "PA5", label: "led2", signal: "output" }] });
  assert.equal(report.ok, true, report.message);
  const entries = parseIocEntries(candidateText(projectDir, report.planId));
  // CubeMX 自己的 demo.ioc:45-48：PC13 输出脚只有 GPIO_Label，没有 PuPd/Speed
  assert.equal(entries.get("PA5.GPIOParameters"), "GPIO_Label");
  assert.equal(entries.get("PA5.GPIO_Label"), "led2");
  assert.equal(entries.get("PA5.GPIO_PuPd"), undefined, "默认无上下拉不该写 GPIO_PuPd");
  assert.equal(entries.get("PA5.GPIO_Speed"), undefined, "默认低速不该写 GPIO_Speed");
  // 显式给了非默认值才写，并且按 CubeMX 的顺序列进 GPIOParameters
  const second = planIocChanges({ projectDir, pins: [{ pin: "PA6", signal: "input", pull: "up", speed: "high" }] });
  const entries2 = parseIocEntries(candidateText(projectDir, second.planId));
  assert.equal(entries2.get("PA6.GPIO_PuPd"), "GPIO_PULLUP");
  assert.equal(entries2.get("PA6.GPIO_Speed"), "GPIO_SPEED_FREQ_HIGH");
  assert.equal(entries2.get("PA6.GPIOParameters"), "GPIO_Speed,GPIO_PuPd");
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
  // 引脚进 Mcu.PinN（顺序按 db Position，VP_* 最后）
  const pinOrder = [];
  for (let index = 0; ; index += 1) {
    const pin = entries.get("Mcu.Pin" + String(index));
    if (pin === undefined) break;
    pinOrder.push(pin);
  }
  assert.ok(pinOrder.includes("PA9") && pinOrder.includes("PA10"), JSON.stringify(pinOrder));
  assert.equal(entries.get("Mcu.PinsNb"), String(pinOrder.length));
  assert.equal(pinOrder[pinOrder.length - 1], "VP_SYS_VS_Systick", "虚拟脚永远在最后");
  // 自己写的东西不该触发"缺 Mode"告警
  assert.equal(report.warnings.join(" ").includes("没有 .Mode"), false, report.warnings.join(" "));
});

test("peripherals(TIM2)：PA0 换成 db 名 PA0-WKUP，带空格的子键要转义", () => {
  const { projectDir } = freshProject();
  const report = planIocChanges({ projectDir, peripherals: [{ name: "TIM2", parameters: { Prescaler: "71", Period: "999" } }] });
  assert.equal(report.ok, true, report.message);
  const entries = parseIocEntries(candidateText(projectDir, report.planId));
  const pinValues = [...entries.entries()].filter(([key]) => /^Mcu\.Pin[0-9]+$/u.test(key)).map(([, value]) => value);
  assert.ok(pinValues.includes("PA0-WKUP"), "PA0 在 F1 db 里叫 PA0-WKUP：" + JSON.stringify(pinValues));
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
  // B3：分频改了，ADCFreqValue 必须跟着重算——夹具里是 ÷2 的 36000000，÷6 之后必须是 12000000，
  // 否则 .ioc 自相矛盾（语料 4 份带 ADCPresc 的文件全都满足 ADCFreqValue == APB2/分频）。
  assert.equal(entries.get("RCC.ADCFreqValue"), "12000000");
  // B1：RCC.IPParameters 必须是字典序（jar.md：RCCService 自己 Collections.sort；语料 429/504）
  const rccNames = (entries.get("RCC.IPParameters") ?? "").split(",");
  assert.deepEqual(rccNames, [...rccNames].sort(), "RCC.IPParameters 必须字典序：" + rccNames.join(","));
});

test("值开头的空格要转义（java.util.Properties 会把前导空白吃掉）", () => {
  // 直接测编码器（标签必须是 C 标识符，走不到这里；但 entries 可以写任意值）
  assert.equal(encodeIocValue(" x"), "\\ x");
  assert.equal(encodeIocValue("a b"), "a b", "值内部空格不转义");
  const { projectDir } = freshProject();
  const report = planIocChanges({ projectDir, entries: [{ key: "ProjectManager.DeviceId", value: " xyz" }] });
  assert.equal(report.ok, true, report.message);
  const raw = candidateText(projectDir, report.planId);
  assert.match(raw, /^ProjectManager\.DeviceId=\\ xyz$/mu, "前导空格写成 \\ 空格");
  assert.equal(parseIocEntries(raw).get("ProjectManager.DeviceId"), " xyz", "解析回来要还原成带前导空格的原文");
});

test("纯 LF 的 .ioc：写回保持 LF，但计划阶段要告警（CubeMX 另存是 CRLF）", () => {
  const { projectDir } = freshProject();
  const iocPath = join(projectDir, "demo.ioc");
  writeFileSync(iocPath, readFileSync(iocPath, "utf8").replace(/\r\n/gu, "\n"), "utf8");
  const report = planIocChanges({ projectDir, pins: [{ pin: "PA7", label: "led7", signal: "output" }] });
  assert.equal(report.ok, true, report.message);
  assert.ok(
    report.warnings.some((warning) => warning.includes("纯 LF")),
    "应告警纯 LF：\n" + JSON.stringify(report.warnings),
  );
  assert.equal(candidateText(projectDir, report.planId).includes("\r"), false, "保持 LF，不擅自改换行");
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
  // Mcu.IP<i> 按 natural 序重排（CubeMX 回写时也这么排）：ADC1/ADC2 字典序在 NVIC 之前。
  assert.equal(entries.get("Mcu.IP0"), "ADC1");
  assert.equal(entries.get("Mcu.IP1"), "ADC2");
  assert.equal(entries.get("Mcu.IP2"), "NVIC");
});

test("Mcu.IPn 排序：natural 序（数字段按数值比，TIM15 在 TIM4 之后、TIM2 之前）", () => {
  const { projectDir } = freshProject();
  const report = planIocChanges({
    projectDir,
    entries: [
      { key: "Mcu.IP3", value: "TIM4" },
      { key: "Mcu.IP4", value: "TIM15" },
      { key: "Mcu.IP5", value: "TIM2" },
    ],
  });
  assert.equal(report.ok, true, report.message);
  const entries = parseIocEntries(candidateText(projectDir, report.planId));
  assert.equal(entries.get("Mcu.IPNb"), "6");
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((index) => entries.get("Mcu.IP" + String(index))),
    ["NVIC", "RCC", "SYS", "TIM2", "TIM4", "TIM15"],
  );
});

test("Mcu.IPn 排序：伪实例（板名，含 -）永远在最后，哪怕字典序最靠前", () => {
  const { projectDir } = freshProject();
  const report = planIocChanges({
    projectDir,
    entries: [
      { key: "Mcu.IP3", value: "AAA-BOARD" },
      { key: "Mcu.IP4", value: "ADC1" },
    ],
  });
  const entries = parseIocEntries(candidateText(projectDir, report.planId));
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((index) => entries.get("Mcu.IP" + String(index))),
    ["ADC1", "NVIC", "RCC", "SYS", "AAA-BOARD"],
  );
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

// 键序必须和 CubeMX 落盘逐字一致：java.util.Properties 写盘前 Collections.sort → String.compareTo，
// 是 UTF-16 纯字典序（jar.md「落盘」；语料 6.x 261/266 = 98.1%）。所以 Mcu.Pin10 **排在** Mcu.Pin2 之前——
// 以前这条断言写反了（按数值排），会让我们的 .ioc 与 CubeMX 另存的结果满屏错行。
test("renderIocText：键序是纯字典序（Mcu.Pin10 在 Mcu.Pin2 之前，与 CubeMX 的 SortedProperties 一致）", () => {
  assert.ok(compareIocKeys("Mcu.Pin10", "Mcu.Pin2") < 0);
  assert.ok(compareIocKeys("Mcu.IP3", "Mcu.IPNb") < 0);
  assert.ok(compareIocKeys("ADC1.master", "CAD.formats") < 0, "official .ioc 里 ADC1.* 就在文件最前面");
  assert.ok(compareIocKeys("VP_SYS_VS_Systick.Mode", "board") < 0);
  const source = "Mcu.Pin2=PC1\n";
  const rendered = renderIocText(source, [
    { key: "Mcu.Pin10", before: null, after: "PC3" },
    { key: "Mcu.Pin9", before: null, after: "PC2" },
  ]);
  assert.equal(rendered, "Mcu.Pin10=PC3\nMcu.Pin2=PC1\nMcu.Pin9=PC2\n");
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

test("引脚名查询化：有 CubeMX db 时按 db 解析（db 里带后缀的脚不再靠内置别名表）", () => {
  const { projectDir } = freshProject();
  const dbRoot = join(TMP, "fake-cubemx");
  // db 里 PA2 故意叫 PA2-ALT：内置别名表里没有这条，只有真读 db 才会写对。
  writeFakeCubeMxDb(dbRoot, "STM32F103C(8-B)Tx", ["PA2-ALT", "PA3"]);
  const report = withEnv(
    { STM32_CUBEMX_ROOT: dbRoot, STM32_NO_DISCOVER: "1", DSH_STM32_NO_CONFIG: "1" },
    () => planIocChanges({ projectDir, peripherals: [{ name: "USART2" }] }),
  );
  assert.equal(report.ok, true, report.message);
  assert.equal(report.changes.find((change) => change.key === "PA2-ALT.Signal")?.after, "USART2_TX");
  assert.equal(report.changes.some((change) => change.key === "PA2.Signal"), false, "不该再写逻辑名 PA2");
  assert.match(report.notes.join(" "), /按本机 CubeMX db 解析/u);
});

test("引脚名查询化：没有 CubeMX db 时退回内置别名表，并在 warnings 里说清楚", () => {
  const { projectDir } = freshProject();
  const emptyRoot = join(TMP, "no-cubemx");
  mkdirSync(emptyRoot, { recursive: true });
  const report = withEnv(
    { STM32_CUBEMX_ROOT: emptyRoot, STM32_NO_DISCOVER: "1", DSH_STM32_NO_CONFIG: "1" },
    () => planIocChanges({ projectDir, peripherals: [{ name: "TIM2" }] }),
  );
  assert.equal(report.ok, true, report.message);
  // TIM2 CH1 走共享信号（S_TIM2_CH1_ETR），关键是引脚名仍要是 db 名 PA0-WKUP。
  assert.match(String(report.changes.find((change) => change.key === "PA0-WKUP.Signal")?.after), /TIM2_CH1/u);
  assert.match(report.notes.join(" "), /内置别名表/u);
  const warning = report.warnings.find((item) => /内置别名表/u.test(item));
  assert.ok(warning, "缺 db 必须在 warnings 里说明只覆盖 6 根脚");
  assert.match(warning, /6 根/u);
});

test("peripherals(TIM3:timebase)：纯时基定时器不占引脚，只写 Prescaler/Period", () => {
  const { projectDir } = freshProject();
  const report = planIocChanges({ projectDir, peripherals: [{ name: "TIM3:timebase" }] });
  assert.equal(report.ok, true, report.message);
  const entries = parseIocEntries(candidateText(projectDir, report.planId));
  assert.equal(entries.get("TIM3.Prescaler"), "71");
  assert.equal(entries.get("TIM3.Period"), "999");
  assert.equal(entries.get("TIM3.CounterMode"), "TIM_COUNTERMODE_UP");
  assert.match(entries.get("TIM3.IPParameters") ?? "", /Prescaler/u);
  const ipValues = [...entries.entries()].filter(([key]) => /^Mcu\.IP[0-9]+$/u.test(key)).map(([, value]) => value);
  assert.ok(ipValues.includes("TIM3"), "Mcu.IPn 里要有 TIM3：" + JSON.stringify(ipValues));
  // 夹具工程本来就有调试口/晶振脚；这里只要求「纯时基不新增引脚」。
  const before = parseIocEntries(readFileSync(DEMO_IOC, "utf8"));
  const countPins = (map) => [...map.keys()].filter((key) => /^Mcu\.Pin[0-9]+$/u.test(key)).length;
  assert.equal(countPins(entries), countPins(before), "纯时基不该新增引脚");
  const tim3Pins = [...entries.entries()].filter(([key, value]) => key.endsWith(".Signal") && value.includes("TIM3"));
  assert.equal(tim3Pins.length, 0, "纯时基不该写任何 TIM3 引脚：" + JSON.stringify(tim3Pins));
});

test("peripherals(ADC1:1,4,5)：多 Rank 三路扫描，Rank 从 1 连续、NbrOfConversion=3", () => {
  const { projectDir } = freshProject();
  const report = planIocChanges({ projectDir, peripherals: [{ name: "ADC1:1,4,5" }] });
  assert.equal(report.ok, true, report.message);
  const entries = parseIocEntries(candidateText(projectDir, report.planId));
  assert.equal(entries.get("ADC1.NbrOfConversion"), "3");
  assert.equal(entries.get("ADC1.Rank-0#ChannelRegularConversion"), "1");
  assert.equal(entries.get("ADC1.Rank-1#ChannelRegularConversion"), "2");
  assert.equal(entries.get("ADC1.Rank-2#ChannelRegularConversion"), "3");
  assert.equal(entries.get("ADC1.Channel-0#ChannelRegularConversion"), "ADC_CHANNEL_1");
  assert.equal(entries.get("ADC1.Channel-1#ChannelRegularConversion"), "ADC_CHANNEL_4");
  assert.equal(entries.get("ADC1.Channel-2#ChannelRegularConversion"), "ADC_CHANNEL_5");
  assert.match(entries.get("ADC1.SamplingTime-2#ChannelRegularConversion") ?? "", /SAMPLETIME/u);
  const signals = [...entries.entries()].filter(([, value]) => value.startsWith("ADCx_IN"));
  assert.equal(signals.length, 3, "三根脚各一个 ADCx_INn 信号：" + JSON.stringify(signals));
  const shKeys = [...entries.keys()].filter((key) => /^SH\.ADCx_IN[0-9]+\.ConfNb$/u.test(key));
  assert.equal(shKeys.length, 3, "每路都要有一个 SH 块：" + JSON.stringify(shKeys));
});

test("peripherals(DMA:ADC1)：写八个 Dma 字段，RequestsNb 按组数算，Mcu.IPn 里有 DMA", () => {
  const { projectDir } = freshProject();
  const report = planIocChanges({ projectDir, peripherals: [{ name: "ADC1:1,4,5" }, { name: "DMA:ADC1" }] });
  assert.equal(report.ok, true, report.message);
  const entries = parseIocEntries(candidateText(projectDir, report.planId));
  assert.equal(entries.get("Dma.RequestsNb"), "1");
  // G1/G2：三件套 —— 白名单（CubeMX 只认名单里的字段）与请求号绑定
  assert.equal(
    entries.get("Dma.ADC1.0.RequestParameters"),
    "Instance,Direction,PeriphInc,MemInc,PeriphDataAlignment,MemDataAlignment,Mode,Priority",
  );
  assert.equal(entries.get("Dma.Request0"), "ADC1");
  assert.equal(entries.get("Dma.ADC1.0.Instance"), "DMA1_Channel1");
  assert.equal(entries.get("Dma.ADC1.0.Direction"), "DMA_PERIPH_TO_MEMORY");
  assert.equal(entries.get("Dma.ADC1.0.PeriphInc"), "DMA_PINC_DISABLE");
  assert.equal(entries.get("Dma.ADC1.0.MemInc"), "DMA_MINC_ENABLE");
  assert.equal(entries.get("Dma.ADC1.0.PeriphDataAlignment"), "DMA_PDATAALIGN_HALFWORD");
  assert.equal(entries.get("Dma.ADC1.0.MemDataAlignment"), "DMA_MDATAALIGN_HALFWORD");
  assert.equal(entries.get("Dma.ADC1.0.Mode"), "DMA_CIRCULAR");
  assert.equal(entries.get("Dma.ADC1.0.Priority"), "DMA_PRIORITY_LOW");
  // CubeMX 见到 DMA 通道会顺手打开它的中断（实测 6.15.0/F1 回写唯一多出的键），补上以免零 diff 失败
  assert.equal(entries.get("NVIC.DMA1_Channel1_IRQn"), "true:0:0:false:false:true:false:true:true");
  const ipValues = [...entries.entries()].filter(([key]) => /^Mcu\.IP[0-9]+$/u.test(key)).map(([, value]) => value);
  assert.ok(ipValues.includes("DMA"), "Mcu.IPn 必须有 DMA，否则整组 Dma.* 被丢：" + JSON.stringify(ipValues));
  assert.equal(report.errors.length, 0, "不该有错误：" + JSON.stringify(report.errors));
});

test("C6：entries 写的标量键自动补进 <IP>.IPParameters（不补会被 CubeMX 静默丢）", () => {
  const { projectDir } = freshProject();
  const report = planIocChanges({
    projectDir,
    peripherals: [{ name: "USART3" }],
    entries: [{ key: "USART3.BaudRate", value: "9600" }],
  });
  assert.equal(report.ok, true, report.message);
  const entries = parseIocEntries(candidateText(projectDir, report.planId));
  const listed = (entries.get("USART3.IPParameters") ?? "").split(",");
  assert.ok(listed.includes("BaudRate"), "BaudRate 必须被补进白名单：" + JSON.stringify(listed));
  assert.equal(entries.get("USART3.BaudRate"), "9600");
  assert.ok(report.notes.some((note) => note.includes("自动补 USART3.IPParameters")), "notes 要说明补了什么：" + JSON.stringify(report.notes));
});

test("pins 开漏 + 初始高电平：GPIO_Mode/PinState 都写，并且都列进 GPIOParameters", () => {
  const { projectDir } = freshProject();
  const report = planIocChanges({
    projectDir,
    pins: [{ pin: "PA6", label: "led2", outputType: "od", initial: "high" }],
  });
  assert.equal(report.ok, true, report.message);
  const entries = parseIocEntries(candidateText(projectDir, report.planId));
  // 真机 6.15.0：这两个值 CubeMX 逐字保留，能不能表达开漏/初始电平只取决于我们写不写。
  assert.equal(entries.get("PA6.GPIO_Mode"), "GPIO_MODE_OUTPUT_OD");
  assert.equal(entries.get("PA6.PinState"), "GPIO_PIN_SET");
  assert.equal(entries.get("PA6.Signal"), "GPIO_Output");
  // 顺序按 CubeMX 回写实测：PinState 在 GPIO_Mode 之前。
  assert.equal(entries.get("PA6.GPIOParameters"), "PinState,GPIO_Label,GPIO_Mode");
  // 默认值不写（开漏/高电平是显式传了才写）
  const plain = planIocChanges({ projectDir, pins: [{ pin: "PA7", signal: "output" }] });
  const plainEntries = parseIocEntries(candidateText(projectDir, plain.planId));
  assert.equal(plainEntries.get("PA7.GPIO_Mode"), undefined, "推挽是默认值，不该写 GPIO_Mode");
  assert.equal(plainEntries.get("PA7.PinState"), undefined, "初始低电平是默认值，不该写 PinState");
});

test("pins EXTI：一次写全 GPXTI<line> 链路（Signal/ModeDefaultEXTI/GPIOParameters/SH/NVIC）", () => {
  const { projectDir } = freshProject();
  const report = planIocChanges({ projectDir, pins: [{ pin: "PA5", interrupt: "falling", pull: "up", label: "key" }] });
  assert.equal(report.ok, true, report.message);
  const entries = parseIocEntries(candidateText(projectDir, report.planId));
  assert.equal(entries.get("PA5.Signal"), "GPXTI5");
  assert.equal(entries.get("PA5.Mode"), undefined, "EXTI 脚在 .ioc 里没有 .Mode（模式由 SH 块表达）");
  assert.equal(entries.get("PA5.GPIO_ModeDefaultEXTI"), "GPIO_MODE_IT_FALLING");
  assert.equal(entries.get("PA5.GPIO_PuPd"), "GPIO_PULLUP");
  assert.equal(entries.get("PA5.GPIOParameters"), "GPIO_PuPd,GPIO_Label,GPIO_ModeDefaultEXTI");
  assert.equal(entries.get("SH.GPXTI5.0"), "GPIO_EXTI5", "EXTI 的 SH 值不带模式（不同于 TIM/ADC）");
  assert.equal(entries.get("SH.GPXTI5.ConfNb"), "1");
  // PA5 → 线 5 → EXTI9_5 组
  assert.equal(entries.get("NVIC.EXTI9_5_IRQn"), "true:0:0:false:false:true:true:true:true");
  assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
});

test("pins EXTI：PA10 落 EXTI15_10 组；虚拟脚/无上拉各有提醒", () => {
  const { projectDir } = freshProject();
  const report = planIocChanges({ projectDir, pins: [{ pin: "PA10", interrupt: "rising" }] });
  assert.equal(report.ok, true, report.message);
  const entries = parseIocEntries(candidateText(projectDir, report.planId));
  assert.equal(entries.get("PA10.Signal"), "GPXTI10");
  assert.equal(entries.get("PA10.GPIO_ModeDefaultEXTI"), "GPIO_MODE_IT_RISING");
  assert.equal(entries.get("NVIC.EXTI15_10_IRQn"), "true:0:0:false:false:true:true:true:true");
  assert.match(report.warnings.join(" "), /没有上\/下拉/u, "EXTI 无上下拉要提醒悬空乱触发");

  const bad = planIocChanges({ projectDir, pins: [{ pin: "VP_SYS_VS_RTC", interrupt: "rising" }] });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(" "), /不能做 EXTI/u);
});

test("pins EXTI：已有 NVIC 键不覆盖（用户自己设的优先级要留住）", () => {
  const { projectDir } = freshProject();
  const report = planIocChanges({
    projectDir,
    pins: [{ pin: "PA5", interrupt: "both" }],
    entries: [{ key: "NVIC.EXTI9_5_IRQn", value: "true:3:0:false:false:true:true:true:true" }],
  });
  assert.equal(report.ok, true, report.message);
  const entries = parseIocEntries(candidateText(projectDir, report.planId));
  assert.equal(entries.get("NVIC.EXTI9_5_IRQn"), "true:3:0:false:false:true:true:true:true");
  assert.equal(entries.get("PA5.GPIO_ModeDefaultEXTI"), "GPIO_MODE_IT_RISING_FALLING");
});

test("interrupts：写 9 段值、支持内联优先级、已存在时保留原值", () => {
  const { projectDir } = freshProject();
  // 夹具资源包没有 SVD、这里也不给 db → 只能告警不能报错（离线也要能算）
  const emptyRoot = join(TMP, "no-cubemx-irq");
  mkdirSync(emptyRoot, { recursive: true });
  const env = { STM32_CUBEMX_ROOT: emptyRoot, STM32_NO_DISCOVER: "1", DSH_STM32_NO_CONFIG: "1" };
  const report = withEnv(env, () => planIocChanges({ projectDir, interrupts: ["USART1", "EXTI9_5:2:3"] }));
  assert.equal(report.ok, true, report.message);
  const entries = parseIocEntries(candidateText(projectDir, report.planId));
  assert.equal(entries.get("NVIC.USART1_IRQn"), "true:0:0:false:false:true:true:true:true");
  assert.equal(entries.get("NVIC.EXTI9_5_IRQn"), "true:2:3:false:false:true:true:true:true");
  assert.match(report.warnings.join(" "), /没法校验/u);

  const keep = withEnv(env, () => planIocChanges({
    projectDir,
    interrupts: ["USART1"],
    entries: [{ key: "NVIC.USART1_IRQn", value: "true:7:0:false:false:true:true:true:true" }],
  }));
  assert.equal(keep.ok, true, keep.message);
  assert.equal(parseIocEntries(candidateText(projectDir, keep.planId)).get("NVIC.USART1_IRQn"), "true:7:0:false:false:true:true:true:true");
  assert.ok(keep.notes.some((note) => note.includes("保留原值")), JSON.stringify(keep.notes));
});

test("interrupts：名字/优先级不合法直接报错（有 db 时按 db 实例白名单校验）", () => {
  const { projectDir } = freshProject();
  const dbRoot = join(TMP, "fake-cubemx-irq");
  writeFakeCubeMxDb(dbRoot, "STM32F103C(8-B)Tx", ["PA5", "PB2"]);
  // 补 IP 列表：db 里只有 USART1/TIM2，写别的就是白写。
  const mcuXml = join(dbRoot, "db", "mcu", "STM32F103C(8-B)Tx.xml");
  writeFileSync(
    mcuXml,
    readFileSync(mcuXml, "utf8").replace(
      "</Mcu>",
      '  <IP InstanceName="USART1" Name="USART" Version="1.0"/>\n  <IP InstanceName="TIM2" Name="TIM" Version="1.0"/>\n</Mcu>',
    ),
    "utf8",
  );
  const env = { STM32_CUBEMX_ROOT: dbRoot, STM32_NO_DISCOVER: "1", DSH_STM32_NO_CONFIG: "1" };

  const unknown = withEnv(env, () => planIocChanges({ projectDir, interrupts: ["SPI9"] }));
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors.join(" "), /既不在本机 CubeMX db 的外设实例里/u);

  const known = withEnv(env, () => planIocChanges({ projectDir, interrupts: ["USART1:2:0"] }));
  assert.equal(known.ok, true, known.message);
  assert.equal(parseIocEntries(candidateText(projectDir, known.planId)).get("NVIC.USART1_IRQn"), "true:2:0:false:false:true:true:true:true");

  const badPriority = withEnv(env, () => planIocChanges({ projectDir, interrupts: ["USART1:99:0"] }));
  assert.equal(badPriority.ok, false);
  assert.match(badPriority.errors.join(" "), /preempt 必须是 0–15/u);
});

test("Mcu.Pin 排序：有 db 时按 <Pin Position> 升序，虚拟脚永远最后", () => {
  const { projectDir } = freshProject();
  const dbRoot = join(TMP, "fake-cubemx-order");
  // demo.ioc 原序：PC13-TAMPER-RTC, PC14-OSC32_IN, PC15-OSC32_OUT, PD0-OSC_IN, PD1-OSC_OUT, PA13, PA14, VP_*
  // 这里让 PC15/PD0/PD1 不在 db 里（查不到 → 排在已知脚后面），PA5 排在最前 → 能看出真的按 Position 重排。
  writeFakeCubeMxDb(dbRoot, "STM32F103C(8-B)Tx", ["PA5", "PC13-TAMPER-RTC", "PC14-OSC32_IN"]);
  const report = withEnv(
    { STM32_CUBEMX_ROOT: dbRoot, STM32_NO_DISCOVER: "1", DSH_STM32_NO_CONFIG: "1" },
    () => planIocChanges({ projectDir, pins: [{ pin: "PA5", signal: "output" }] }),
  );
  assert.equal(report.ok, true, report.message);
  const entries = parseIocEntries(candidateText(projectDir, report.planId));
  const order = [];
  for (let index = 0; ; index += 1) {
    const pin = entries.get("Mcu.Pin" + String(index));
    if (pin === undefined) break;
    order.push(pin);
  }
  assert.equal(order[0], "PA5", "db Position 最小的排最前：" + JSON.stringify(order));
  assert.equal(order[1], "PC13-TAMPER-RTC");
  assert.equal(order[2], "PC14-OSC32_IN");
  assert.equal(order[order.length - 1], "VP_SYS_VS_Systick", "虚拟脚必须在最后");
  assert.equal(order.includes("PA5"), true, "新脚要进表");
  assert.equal(entries.get("Mcu.PinsNb"), String(order.length));
});

test("Mcu.Pin 排序：没有 db 时保持原序（只把虚拟脚挪到最后），单测不依赖开发机", () => {
  const { projectDir } = freshProject();
  const emptyRoot = join(TMP, "no-cubemx-order");
  mkdirSync(emptyRoot, { recursive: true });
  const before = parseIocEntries(readFileSync(DEMO_IOC, "utf8"));
  const beforeOrder = [];
  for (let index = 0; ; index += 1) {
    const pin = before.get("Mcu.Pin" + String(index));
    if (pin === undefined) break;
    beforeOrder.push(pin);
  }
  const report = withEnv(
    { STM32_CUBEMX_ROOT: emptyRoot, STM32_NO_DISCOVER: "1", DSH_STM32_NO_CONFIG: "1" },
    () => planIocChanges({ projectDir, pins: [{ pin: "PA6", signal: "output" }] }),
  );
  assert.equal(report.ok, true, report.message);
  const entries = parseIocEntries(candidateText(projectDir, report.planId));
  const order = [];
  for (let index = 0; ; index += 1) {
    const pin = entries.get("Mcu.Pin" + String(index));
    if (pin === undefined) break;
    order.push(pin);
  }
  const expectedTail = beforeOrder.filter((pin) => !pin.startsWith("VP_"));
  assert.deepEqual(order.slice(0, expectedTail.length), expectedTail, "原有脚顺序不能乱");
  assert.equal(order[order.length - 1], "VP_SYS_VS_Systick");
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