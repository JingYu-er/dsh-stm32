// stm32_ioc_verify 的纯函数单测：node test/ioc-verify-units.test.mjs
import assert from "node:assert/strict";

import { diffIocForVerify, plannedFunctionOf } from "../lib/engine/ioc-verify.js";

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
  assert.deepEqual(diff.hints, []);
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
