// stm32_ioc_verify 的纯函数单测：node test/ioc-verify-units.test.mjs
import assert from "node:assert/strict";

import {
  diffIocForVerify, isDerivedClockKey, isDerivedClockName, isIocValueNormalized, misorderedKeysOf, plannedFunctionOf,
} from "../lib/engine/ioc-verify.js";

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
  assert.match(diff.hints.join(" "), /TIM3 没有引脚指向该外设/u);
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

test("派生频率键判定：只认 RCC 的 *Freq_Value/*FreqValue，SYSCLKFreq_VALUE 不算派生", () => {
  assert.equal(isDerivedClockKey("RCC.I2SClocksFreq_Value"), true);
  assert.equal(isDerivedClockKey("RCC.ADCFreqValue"), true);
  assert.equal(isDerivedClockKey("RCC.VcooutputI2S"), true);
  // 这两个是我们自己写的「设定」，被改写就必须报出来，不能塞进派生桶。
  assert.equal(isDerivedClockKey("RCC.SYSCLKFreq_VALUE"), false);
  assert.equal(isDerivedClockKey("RCC.PLLM"), false);
  // 同名键在别的实例下不是 RCC 的派生频率（别把任意外设的 Freq_Value 也放过）。
  assert.equal(isDerivedClockKey("TIM2.TIMFreq_Value"), false);
  assert.equal(isDerivedClockName("APB1Freq_Value"), true);
  assert.equal(isDerivedClockName("APB1TimFreq_Value"), true);
  assert.equal(isDerivedClockName("PLLCLKFreq_Value"), true);
});

test("归因：派生频率被 CubeMX 重算（计划里没写过）→ derivedRecomputed，benign 为真", () => {
  const before = "RCC.PLLM=20\nRCC.I2SClocksFreq_Value=96000000\nRCC.TIM2Freq_Value=8000000\n";
  const after = "RCC.PLLM=20\nRCC.I2SClocksFreq_Value=120000000\nRCC.TIM2Freq_Value=72000000\n";
  const diff = diffIocForVerify(before, after);
  assert.deepEqual(diff.changedValues.map((item) => item.key), ["RCC.I2SClocksFreq_Value", "RCC.TIM2Freq_Value"]);
  assert.deepEqual(
    diff.attribution.derivedRecomputed.map((item) => item.key),
    ["RCC.I2SClocksFreq_Value", "RCC.TIM2Freq_Value"],
  );
  assert.deepEqual(diff.attribution.valueChanged, [], "派生频率是它算出来的，不能算成我们写错");
  assert.equal(diff.attribution.benign, true);
});

test("归因：计划里写过的派生频率被改写 → 仍留在 valueChanged（benign 为假）", () => {
  const before = "RCC.TIM2Freq_Value=8000000\n";
  const after = "RCC.TIM2Freq_Value=72000000\n";
  const diff = diffIocForVerify(before, after, null, new Set(["RCC.TIM2Freq_Value"]));
  assert.deepEqual(diff.attribution.derivedRecomputed, [], "我们写了它，对不上就是算错了");
  assert.deepEqual(diff.attribution.valueChanged.map((item) => item.key), ["RCC.TIM2Freq_Value"]);
  assert.equal(diff.attribution.benign, false);
});

test("归因：CubeMX 自己补的派生键 → derivedAdded，benign 为真", () => {
  const before = "RCC.PLLM=20\n";
  const after = "RCC.PLLM=20\nRCC.EthernetFreq_Value=120000000\n";
  const diff = diffIocForVerify(before, after);
  assert.deepEqual(diff.addedKeys, ["RCC.EthernetFreq_Value"], "原始字段照旧留着");
  assert.deepEqual(diff.attribution.derivedAdded, ["RCC.EthernetFreq_Value"]);
  assert.deepEqual(diff.attribution.addedKeys, [], "它按树自己补的不算我们多写");
  assert.equal(diff.attribution.benign, true);
});

test("归因：RCC.IPParameters 只被追加派生名（顺序也变了）→ ipParametersAdded，benign 为真", () => {
  // F2 实测就是这样：我们的名单是它的子集，它保存时把重算出来的频率名一并登记并按 ASCII 重排。
  const before = "RCC.IPParameters=PLLM,AHBCLKDivider,APB1Freq_Value\n";
  const after = "RCC.IPParameters=AHBCLKDivider,APB1Freq_Value,EthernetFreq_Value,I2SClocksFreq_Value,PLLM\n";
  const diff = diffIocForVerify(before, after);
  assert.deepEqual(diff.attribution.ipParametersAdded, ["EthernetFreq_Value", "I2SClocksFreq_Value"]);
  assert.deepEqual(diff.attribution.valueChanged, []);
  assert.equal(diff.attribution.benign, true);
});

test("归因：RCC.IPParameters 少了名字或插进非派生名 → 仍然报 valueChanged", () => {
  const removed = diffIocForVerify(
    "RCC.IPParameters=PLLM,AHBCLKDivider\n",
    "RCC.IPParameters=PLLM,AHBCLKDivider,EthernetFreq_Value,USBPrescaler\n",
  );
  assert.deepEqual(removed.attribution.ipParametersAdded, [], "USBPrescaler 不是派生频率名，不能放过");
  assert.deepEqual(removed.attribution.valueChanged.map((item) => item.key), ["RCC.IPParameters"]);
  const dropped = diffIocForVerify("RCC.IPParameters=PLLM,AHBCLKDivider\n", "RCC.IPParameters=PLLM\n");
  assert.deepEqual(dropped.attribution.ipParametersAdded, []);
  assert.deepEqual(dropped.attribution.valueChanged.map((item) => item.key), ["RCC.IPParameters"]);
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
  assert.match(text, /NVIC\.USART1_IRQn 被 CubeMX 删除了：USART1 不在 CubeMX 认的外设表里/u);
  // EXTI 向量是例外，不能误报
  const exti = diffIocForVerify("Mcu.IPNb=0\nNVIC.EXTI9_5_IRQn=true:0:0:false:false:true:true:true:true\n", "Mcu.IPNb=0\n");
  assert.deepEqual(exti.hints, []);
});

test("归因成因：没有 db 上下文时 droppedReasons 只报键名（verdict 空串），不猜原因", () => {
  const diff = diffIocForVerify(BEFORE, AFTER_DROPPED);
  assert.ok(diff.attribution.droppedReasons.length > 0, "被丢的键逐条都要有记录");
  for (const reason of diff.attribution.droppedReasons) {
    assert.equal(reason.verdict, "", "没 db 就不判成因");
    assert.match(reason.detail, /没有 db 上下文/u);
  }
  assert.deepEqual(
    diff.attribution.droppedReasons.map((item) => item.key),
    diff.attribution.missingKeys,
    "与 missingKeys 同序同集合",
  );
});

test("归因成因：参数名不在 db 清单 → unknown-parameter 并点名基名提示", () => {
  const before = "Mcu.IP0=USART1\nMcu.IPNb=1\nUSART1.Baudrate=115200\nUSART1.VirtualMode=VM_ASYNC\n";
  const after = "Mcu.IP0=USART1\nMcu.IPNb=1\nUSART1.VirtualMode=VM_ASYNC\n";
  const audit = {
    paramNamesOf: (instance) => (instance === "USART1" ? ["VirtualMode", "BaudRate"] : null),
  };
  const diff = diffIocForVerify(before, after, audit);
  assert.deepEqual(diff.attribution.missingKeys, ["USART1.Baudrate"]);
  const reason = diff.attribution.droppedReasons.find((item) => item.key === "USART1.Baudrate");
  assert.equal(reason.verdict, "unknown-parameter");
  assert.match(reason.detail, /USART1 的 db 参数清单里没有 Baudrate/u);
});

test("归因成因：外设没进 Mcu.IPn → inactive-instance；它本来在 before 里则补一句因果", () => {
  const audit = { dbInstances: ["USART1", "TIM3"] };
  // (a) 从没启用过 USART1：参数键没有接收方。
  const orphan = diffIocForVerify("Mcu.IP0=RCC\nMcu.IPNb=1\nUSART1.BaudRate=9600\n", "Mcu.IP0=RCC\nMcu.IPNb=1\n", audit);
  const reasonA = orphan.attribution.droppedReasons.find((item) => item.key === "USART1.BaudRate");
  assert.equal(reasonA.verdict, "inactive-instance");
  assert.doesNotMatch(reasonA.detail, /本来有该外设/u);
  // (b) before 里 IPn 有 USART1，是 CubeMX 回写时把外设整个删了：成因要指向「引脚/模式不完整」。
  const dropped = diffIocForVerify("Mcu.IP0=USART1\nMcu.IPNb=1\nUSART1.BaudRate=9600\n", "Mcu.IPNb=0\n", audit);
  const reasonB = dropped.attribution.droppedReasons.find((item) => item.key === "USART1.BaudRate");
  assert.equal(reasonB.verdict, "inactive-instance");
  assert.match(reasonB.detail, /本来有该外设/u);
});

test("归因成因：引脚名写进 ip 位、属性又没登记 → pin-attribute（真值表登记的引脚属性照旧算 ok）", () => {
  const before = "Mcu.Pin0=PA6\nMcu.PinsNb=1\nPA6.GPIO_Bogus=1\nPA6.PinState=GPIO_PIN_SET\n";
  const after = "Mcu.Pin0=PA6\nMcu.PinsNb=1\n";
  const diff = diffIocForVerify(before, after, { pins: ["PA6"] });
  const bogus = diff.attribution.droppedReasons.find((item) => item.key === "PA6.GPIO_Bogus");
  assert.equal(bogus.verdict, "pin-attribute");
  assert.match(bogus.detail, /逐条登记进真值表/u);
  const known = diff.attribution.droppedReasons.find((item) => item.key === "PA6.PinState");
  assert.equal(known.verdict, "ok", "真值表里登记过的引脚属性不该被报成拼错");
});

test("归因成因：它补的键分「已登记形状」与「连形状都没登记」两类", () => {
  const before = "Mcu.IPNb=0\n";
  const after = "Mcu.IPNb=0\nSH.S_TIM3_CH1.0=TIM3_CH1\nSomething=1\n";
  // 给了上下文（哪怕空对象）才会真的跑去判定；不给就只有键名。
  const diff = diffIocForVerify(before, after, {});
  const byKey = new Map(diff.attribution.addedVerdicts.map((item) => [item.key, item]));
  assert.equal(byKey.get("SH.S_TIM3_CH1.0").verdict, "ok");
  assert.equal(byKey.get("Something").verdict, "unregistered");
});

test("归因：只有 Mcu.IP<i> 槽位重排（外设集合相同）→ ipOrderOnly，benign 为真", () => {
  const before = "Mcu.IP0=NVIC\nMcu.IP1=RCC\nMcu.IP2=TIM2\nMcu.IPNb=3\n";
  const after = "Mcu.IP0=NVIC\nMcu.IP1=TIM2\nMcu.IP2=RCC\nMcu.IPNb=3\n";
  const diff = diffIocForVerify(before, after);
  assert.deepEqual(diff.attribution.ipOrderOnly, ["Mcu.IP1", "Mcu.IP2"]);
  assert.deepEqual(diff.attribution.valueChanged, [], "槽位重排不该算值被改写");
  assert.deepEqual(diff.changedValues, []);
  assert.deepEqual(diff.droppedPeripherals, []);
  assert.equal(diff.attribution.benign, true);
});

test("归因：槽位重排 + 外设集合变了 → 仍算 valueChanged（不能拿 ipOrderOnly 洗掉真差异）", () => {
  const before = "Mcu.IP0=NVIC\nMcu.IP1=RCC\nMcu.IP2=TIM2\nMcu.IPNb=3\n";
  const after = "Mcu.IP0=NVIC\nMcu.IP1=TIM2\nMcu.IP2=TIM4\nMcu.IPNb=3\n";
  const diff = diffIocForVerify(before, after);
  assert.deepEqual(diff.attribution.ipOrderOnly, []);
  assert.deepEqual(diff.attribution.valueChanged.map((item) => item.key), ["Mcu.IP1", "Mcu.IP2"]);
  assert.deepEqual(diff.droppedPeripherals, ["RCC"]);
  assert.equal(diff.attribution.benign, false);
});

test("归因成因：形状已登记但键还是被丢 → 明说「只能真机确认」，不装作我们写对了", () => {
  const before = "Mcu.IP0=RCC\nMcu.IPNb=1\nRCC.SYSCLKFreq_VALUE=72000000\n";
  const after = "Mcu.IP0=RCC\nMcu.IPNb=1\n";
  const diff = diffIocForVerify(before, after, {});
  const reason = diff.attribution.droppedReasons.find((item) => item.key === "RCC.SYSCLKFreq_VALUE");
  assert.equal(reason.verdict, "ok", "形状在真值表里，这一层判不出来");
  assert.match(reason.detail, /仍然被丢弃/u);
  assert.match(reason.detail, /真机/u);
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
