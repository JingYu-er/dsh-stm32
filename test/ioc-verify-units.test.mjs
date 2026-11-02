// stm32_ioc_verify 的纯函数单测：node test/ioc-verify-units.test.mjs
import assert from "node:assert/strict";

import { diffIocForVerify, isIocValueNormalized, misorderedKeysOf, plannedFunctionOf } from "../lib/engine/ioc-verify.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

const BEFORE = [
  "Mcu.Family=STM32F1",
  "Mcu.IP0=NVIC",
  "Mcu.IP1=RCC",
  "Mcu.IP2=SYS",
  "Mcu.IP3=TIM3",
  "Mcu.IP4=USART1",
  "Mcu.IPNb=5",
  "Mcu.Pin7=PA6",
  "Mcu.Pin8=PA9",
  "Mcu.PinsNb=9",
  "PA6.Signal=TIM3_CH1",
  "TIM3.Channel-PWM\\ Generation1\\ CH1=TIM_CHANNEL_1",
  "TIM3.IPParameters=Channel-PWM Generation1 CH1",
  "PA9.Mode=Asynchronous",
  "PA9.Signal=USART1_TX",
  "USART1.IPParameters=VirtualMode",
  "USART1.VirtualMode=VM_ASYNC",
  "",
].join("\n");

// CubeMX 的实际表现：TIM3 整段被丢掉，只留下引脚信号被规范化 + 自己补的 SH 块。
const AFTER_DROPPED = [
  "Mcu.IP0=NVIC",
  "Mcu.IP1=RCC",
  "Mcu.IP2=SYS",
  "Mcu.IP3=USART1",
  "Mcu.IPNb=4",
  "PA6.Signal=S_TIM3_CH1",
  "SH.S_TIM3_CH1.0=TIM3_CH1",
  "SH.S_TIM3_CH1.ConfNb=1",
  "PA9.Mode=Asynchronous",
  "PA9.Signal=USART1_TX",
  "ProjectManager.functionlistsort=2-MX_GPIO_Init-GPIO-false-HAL-true,3-MX_USART1_UART_Init-USART1-false-HAL-true",
  "USART1.IPParameters=VirtualMode",
  "USART1.VirtualMode=VM_ASYNC",
  "",
].join("\n");

test("plannedFunctionOf：从 functionlistsort 条目里取出 MX_* 名字", () => {
  assert.equal(plannedFunctionOf("3-MX_USART1_UART_Init-USART1-false-HAL-true"), "MX_USART1_UART_Init");
  assert.equal(plannedFunctionOf("MX_ADC1_Init"), "MX_ADC1_Init");
  assert.equal(plannedFunctionOf("1-SystemClock_Config-RCC-false-HAL-false"), "");
});

test("diff：外设被丢、引脚信号被规范化、SH 块被补出来、计划函数只剩 USART", () => {
  const diff = diffIocForVerify(BEFORE, AFTER_DROPPED);
  assert.deepEqual(diff.droppedPeripherals, ["TIM3"]);
  assert.deepEqual(diff.afterPeripherals.sort(), ["NVIC", "RCC", "SYS", "USART1"]);
  assert.deepEqual(diff.plannedFunctions, ["MX_GPIO_Init", "MX_USART1_UART_Init"], "计划函数按 functionlistsort 顺序，GPIO 也在里面");
  assert.deepEqual(
    diff.signalRewrites.map((item) => item.pin + ":" + item.before + "->" + item.after),
    ["PA6:TIM3_CH1->S_TIM3_CH1"],
  );
  assert.deepEqual(diff.sharedSignals.map((item) => item.key), ["S_TIM3_CH1"]);
  assert.ok(diff.removedKeys.includes("TIM3.IPParameters"), "被删掉的键要能看见");
  assert.ok(diff.addedKeys.includes("SH.S_TIM3_CH1.0"), "它自己补的键要能看见");
});

test("diff：引脚在 Mcu.PinN 里、但没有 .Mode 也没有 SH 块 → 提示缺功能表达", () => {
  const diff = diffIocForVerify(BEFORE, AFTER_DROPPED);
  const text = diff.hints.join(" ");
  assert.match(text, /TIM3 的引脚 PA6 缺功能表达/u);
  assert.match(text, /SH\.<pin信号>\.0=/u);
});

test("diff：引脚没列进 Mcu.PinN → 单独提示", () => {
  const before = BEFORE.replace("Mcu.Pin7=PA6\n", "").replace("Mcu.PinsNb=9", "Mcu.PinsNb=8");
  const diff = diffIocForVerify(before, AFTER_DROPPED);
  assert.match(diff.hints.join(" "), /PA6 没列进 Mcu\.PinN/u);
});

test("diff：完全没引脚指向的外设 → 提示补 <pin>.Signal", () => {
  const before = BEFORE.replace("PA6.Signal=TIM3_CH1\n", "");
  const diff = diffIocForVerify(before, AFTER_DROPPED);
  assert.match(diff.hints.join(" "), /TIM3 没有引脚指向它/u);
});

test("diff：两边一样时没有任何丢弃与改写（健康配置）", () => {
  const diff = diffIocForVerify(BEFORE, BEFORE);
  assert.deepEqual(diff.droppedPeripherals, []);
  assert.deepEqual(diff.signalRewrites, []);
  assert.deepEqual(diff.changedValues, []);
  assert.deepEqual(diff.hints, []);
});

test("diff：键还在但值被 CubeMX 改写 → 必须报 changedValues（零 diff 不能只看键）", () => {
  // CubeMX 会把派生频率之类按自己的不变量重算，键名不变。
  const diff = diffIocForVerify(BEFORE + "RCC.SYSCLKFreq_VALUE=72000000\n", BEFORE + "RCC.SYSCLKFreq_VALUE=64000000\n");
  assert.deepEqual(diff.changedValues, [{ key: "RCC.SYSCLKFreq_VALUE", before: "72000000", after: "64000000" }]);
  assert.deepEqual(diff.removedKeys, [], "键没被删，只改了值");
  assert.deepEqual(diff.addedKeys, []);
});

test("diff：functionlistsort 只被 CubeMX 追加 MX_*_Init → 单独归到 autoAddedFunctions，不算值改写", () => {
  const before = BEFORE + "ProjectManager.functionlistsort=1-SystemClock_Config-RCC-false-HAL-false,2-MX_GPIO_Init-GPIO-false-HAL-true\n";
  const after = BEFORE + "ProjectManager.functionlistsort=1-SystemClock_Config-RCC-false-HAL-false,2-MX_GPIO_Init-GPIO-false-HAL-true,3-MX_USART1_UART_Init-USART1-false-HAL-true\n";
  const diff = diffIocForVerify(before, after);
  assert.deepEqual(diff.autoAddedFunctions, ["3-MX_USART1_UART_Init-USART1-false-HAL-true"]);
  assert.deepEqual(diff.changedValues, [], "纯追加不该再算成值被改写");
});

test("diff：functionlistsort 被删条目（不是纯追加）→ 仍然报 changedValues", () => {
  const before = BEFORE + "ProjectManager.functionlistsort=1-SystemClock_Config-RCC-false-HAL-false,2-MX_GPIO_Init-GPIO-false-HAL-true\n";
  const after = BEFORE + "ProjectManager.functionlistsort=1-SystemClock_Config-RCC-false-HAL-false\n";
  const diff = diffIocForVerify(before, after);
  assert.deepEqual(diff.autoAddedFunctions, []);
  assert.deepEqual(diff.changedValues.map((item) => item.key), ["ProjectManager.functionlistsort"]);
});

test("归因：键序被重排、值不变 → 只算 orderOnly，benign 为真", () => {
  const before = "A.x=1\nB.y=2\nC.z=3\nD.w=4\n";
  const after = "D.w=4\nC.z=3\nB.y=2\nA.x=1\n";
  const diff = diffIocForVerify(before, after);
  assert.deepEqual(diff.changedValues, [], "值没变");
  assert.deepEqual(diff.attribution.valueChanged, []);
  assert.ok(diff.attribution.orderOnly.length >= 3, "被重排的键要能看见：" + JSON.stringify(diff.attribution.orderOnly));
  assert.equal(diff.misorderedKeys.length, diff.attribution.orderOnly.length);
  assert.equal(diff.attribution.benign, true, "只有行序不同算零实质差异");
});

test("归因：键序没动但行序无损（只是插了新键）→ 不算 orderOnly", () => {
  const before = "A.x=1\nC.z=3\n";
  const after = "A.x=1\nB.y=2\nC.z=3\n";
  const diff = diffIocForVerify(before, after);
  assert.deepEqual(diff.attribution.orderOnly, []);
  assert.deepEqual(diff.attribution.addedKeys, ["B.y"]);
  assert.equal(diff.attribution.benign, false, "多写了它不认的键要算实质差异");
});

test("归因：值只是成员顺序被规范化（语义不变）→ valueNormalized，benign 为真", () => {
  const before = "PA6.GPIOParameters=GPIO_Mode,PinState\n";
  const after = "PA6.GPIOParameters=PinState,GPIO_Mode\n";
  const diff = diffIocForVerify(before, after);
  assert.deepEqual(diff.changedValues.map((item) => item.key), ["PA6.GPIOParameters"]);
  assert.deepEqual(diff.attribution.valueNormalized.map((item) => item.key), ["PA6.GPIOParameters"]);
  assert.deepEqual(diff.attribution.valueChanged, []);
  assert.equal(diff.attribution.benign, true);
});

test("归因：值真被改（数字变了）→ valueChanged，benign 为假", () => {
  const before = "RCC.SYSCLKFreq_VALUE=72000000\n";
  const after = "RCC.SYSCLKFreq_VALUE=64000000\n";
  const diff = diffIocForVerify(before, after);
  assert.deepEqual(diff.attribution.valueChanged.map((item) => item.key), ["RCC.SYSCLKFreq_VALUE"]);
  assert.deepEqual(diff.attribution.valueNormalized, []);
  assert.equal(diff.attribution.benign, false);
});

test("归因：missingKeys/addedKeys/droppedPeripherals 与旧字段一致", () => {
  const diff = diffIocForVerify(BEFORE, AFTER_DROPPED);
  assert.deepEqual(diff.attribution.missingKeys, diff.removedKeys);
  assert.deepEqual(diff.attribution.addedKeys, diff.addedKeys);
  assert.deepEqual(diff.attribution.droppedPeripherals, diff.droppedPeripherals);
  assert.equal(diff.attribution.benign, false, "外设被丢 + 信号被改写都不是良性的");
});

test("isIocValueNormalized：空白折叠算规范化，单值不同不算", () => {
  assert.equal(isIocValueNormalized("Channel-PWM Generation1 CH1", "Channel-PWM  Generation1  CH1"), true);
  assert.equal(isIocValueNormalized("1,2,3", "3,1,2"), true);
  assert.equal(isIocValueNormalized("1,2,3", "1,2,3,4"), false);
  assert.equal(isIocValueNormalized("true:0:0:false", "false:0:0:true"), false);
});

test("提示：中断所属外设未被认（Mcu.IPn 里没有）→ 说明为什么 NVIC 键被删", () => {
  const before = "Mcu.IP0=NVIC\nMcu.IP1=RCC\nMcu.IPNb=2\nNVIC.USART1_IRQn=true:0:0:false:false:true:true:true:true\n";
  const after = "Mcu.IP0=NVIC\nMcu.IP1=RCC\nMcu.IPNb=2\n";
  const diff = diffIocForVerify(before, after);
  assert.deepEqual(diff.attribution.missingKeys, ["NVIC.USART1_IRQn"]);
  const text = diff.hints.join(" ");
  assert.match(text, /NVIC\.USART1_IRQn 被 CubeMX 删掉了：USART1 不在它认的外设表里/u);
  // EXTI 向量是例外，不能误报
  const exti = diffIocForVerify("Mcu.IPNb=0\nNVIC.EXTI9_5_IRQn=true:0:0:false:false:true:true:true:true\n", "Mcu.IPNb=0\n");
  assert.deepEqual(exti.hints, []);
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
console.log("---");
console.log("tests " + String(cases.length) + " / fail " + String(failed));
if (failed > 0) process.exit(1);
