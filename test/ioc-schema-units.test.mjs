// .ioc schema 真值表单测：node test/ioc-schema-units.test.mjs（不要用 node --test：沙箱下 spawn EPERM）
//
// 为什么有这份测试：ioc-schema.ts 是「键名真值表」，生成器写键名走 renderIocKey()。
// 表错一条、或者调用点传错占位符，写到 .ioc 里的就是 CubeMX 不认识的键——它不报错、直接丢弃，
// 于是外设被静默丢、生成代码少一个外设。所以这里既查表本身的形状，也用一次真 plan 做端到端回归。
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  IOC_SCHEMA,
  compileIocKeyTemplate,
  iocSchemaCoverage,
  iocSpecById,
  matchIocKey,
  renderIocKey,
} from "../lib/data/ioc-schema.js";
import { planIocChanges } from "../lib/engine/ioc-plan.js";
import { parseIocEntries } from "../lib/engine/ioc.js";

import { FIXTURE_ASSETS, FIXTURE_PROJECT, e2eWorkDir } from "./fixtures.mjs";

process.env.DSH_STM32_ASSETS = FIXTURE_ASSETS;

const DEMO_IOC = join(FIXTURE_PROJECT, "demo.ioc");
const TMP = e2eWorkDir("ioc-schema-test");

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

function candidateText(projectDir, planId) {
  return readFileSync(join(projectDir, ".dsh-stm32", "plans", planId + ".ioc"), "utf8");
}

const ENTITIES = ["mcu", "pin", "shared-signal", "nvic", "dma", "peripheral", "rcc", "project"];
const VALUE_KINDS = ["count", "index", "bool", "enum", "csv", "nvic9", "hz", "text"];
const ORDERS = ["dictionary", "insertion", "sorted-members", "index", "sequence"];

test("schema 形状：id 唯一、enum 字段合法、证据与写者齐全", () => {
  assert.equal(IOC_SCHEMA.length, 48, "spec 条数变了就要同步改这个数字（它是表的规模声明）");
  const ids = new Set();
  for (const spec of IOC_SCHEMA) {
    assert.match(spec.id, /^[a-z_]+\.[a-z0-9_]+$/u, "id 形状： domain.name → " + spec.id);
    assert.equal(ids.has(spec.id), false, "id 重复：" + spec.id);
    ids.add(spec.id);
    assert.ok(spec.key.length > 0, spec.id + " 的 key 模板不能为空");
    assert.ok(ENTITIES.includes(spec.entity), spec.id + " 的 entity 非法：" + spec.entity);
    assert.ok(VALUE_KINDS.includes(spec.valueKind), spec.id + " 的 valueKind 非法：" + spec.valueKind);
    assert.ok(ORDERS.includes(spec.order), spec.id + " 的 order 非法：" + spec.order);
    assert.ok(spec.valueNote.length > 0, spec.id + " 缺少值编码说明");
    assert.ok(spec.trigger.length > 0, spec.id + " 缺少触发条件说明");
    assert.ok(Array.isArray(spec.evidence) && spec.evidence.length > 0, spec.id + " 缺少证据");
    for (const item of spec.evidence) assert.equal(typeof item, "string", spec.id + " 的证据必须是字符串");
    assert.ok(spec.writer === null || typeof spec.writer === "string", spec.id + " 的 writer 只能是字符串或 null");
  }
});

test("iocSpecById：认识的 id 取得到，不认识的给 null", () => {
  assert.equal(iocSpecById("nvic.vector")?.key, "NVIC.{name}_IRQn");
  assert.equal(iocSpecById("不存在的id"), null);
});

test("compileIocKeyTemplate：抽出占位符、正则能匹配", () => {
  const nvic = compileIocKeyTemplate("NVIC.{name}_IRQn");
  assert.deepEqual(nvic.names, ["name"]);
  assert.match("NVIC.TIM2_IRQn", nvic.regex);
  assert.doesNotMatch("NVICX.TIM2_IRQn", nvic.regex);

  const pinIndex = compileIocKeyTemplate("Mcu.Pin{index}");
  assert.match("Mcu.Pin12", pinIndex.regex);
  assert.doesNotMatch("Mcu.PinsNb", pinIndex.regex);

  const catchAll = compileIocKeyTemplate("RCC.{*}");
  assert.deepEqual(catchAll.names, [], "catch-all 不取参");
  assert.match("RCC.SYSCLKFreq_VALUE", catchAll.regex);
});

test("matchIocKey：具体模板优先，宽模板不会抢走已知键", () => {
  const check = (key, id) => {
    const hit = matchIocKey(key);
    assert.equal(hit === null ? null : hit.spec.id, id, key + " → " + id);
  };
  check("RCC.SYSCLKFreq_VALUE", "rcc.derived");
  check("RCC.IPParameters", "rcc.ip_parameters");
  check("NVIC.TIM2_IRQn", "nvic.vector");
  check("NVIC.PriorityGroup", "nvic.priority_group");
  check("Mcu.Pin7", "mcu.pin_index");
  check("Mcu.PinsNb", "mcu.pins_nb");
  check("PA9.Signal", "pin.signal");
  check("PB4(NJRST).ContextOwner", "pin.context_owner");
  check("SH.S_TIM3_CH1.0", "shared_signal.slot");
  check("SH.S_TIM3_CH1.ConfNb", "shared_signal.conf_nb");
  check("Dma.ADC1.0.RequestParameters", "dma.request_parameters");
  check("Dma.Request3", "dma.request_index");
  check("Dma.RequestsNb", "dma.requests_nb");
  check("TIM3.IPParameters", "periph.ip_parameters");
  check("TIM3.Channel-PWM Generation1 CH1", "periph.parameter");
  check("KeepUserPlacement", "project.keep_user_placement");
  check("ProjectManager.functionlistsort", "project.functionlistsort");

  const nvic = matchIocKey("NVIC.TIM2_IRQn");
  assert.deepEqual(nvic.params, { name: "TIM2" });
  const slot = matchIocKey("SH.S_TIM3_CH1.0");
  assert.deepEqual(slot.params, { signal: "S_TIM3_CH1", n: "0" });
});

test("renderIocKey：正常渲染 + 四种拼错都要抛错", () => {
  assert.equal(renderIocKey("mcu.pin_index", { index: 5 }), "Mcu.Pin5");
  assert.equal(renderIocKey("mcu.pins_nb"), "Mcu.PinsNb");
  // spec 模板自带 _IRQn 后缀 → 调用方只传向量名（传 TIM2_IRQn 会拼出 TIM2_IRQn_IRQn）
  assert.equal(renderIocKey("nvic.vector", { name: "TIM2" }), "NVIC.TIM2_IRQn");
  assert.equal(renderIocKey("shared_signal.slot", { signal: "S_TIM3_CH1", n: 0 }), "SH.S_TIM3_CH1.0");
  assert.equal(renderIocKey("periph.parameter", { ip: "TIM3", name: "Prescaler" }), "TIM3.Prescaler");

  assert.throws(() => renderIocKey("不存在"), /未知 spec id/u);
  assert.throws(() => renderIocKey("nvic.vector", {}), /缺少占位符 \{name\}/u);
  assert.throws(() => renderIocKey("mcu.pins_nb", { index: 1 }), /不接受占位符 \{index\}/u);
  assert.throws(() => renderIocKey("rcc.derived"), /catch-all/u);
});

test("iocSchemaCoverage：认识的全部算覆盖，不认识的单独列出来", () => {
  // 注意：带点号的键几乎都被 {ip}.{name} 兜住（Custom.NewKey → periph.parameter），
  // 所以覆盖率闸门只能拦「形状上不可能存在」的键；拼错的点号键靠真机 ioc_verify 的 added/removed 对比。
  const coverage = iocSchemaCoverage([
    "Mcu.Pin3", "NVIC.TIM2_IRQn", "RCC.ADCPresc", "TIM3.Prescaler", "KeepUserPlacement", "WeirdKeyWithoutDot",
  ]);
  assert.deepEqual(coverage.uncovered, ["WeirdKeyWithoutDot"]);
  assert.equal(coverage.covered.length, 5);
  assert.ok(coverage.specIds.includes("nvic.vector"));
  assert.deepEqual(iocSchemaCoverage(["Custom.NewKey"]).uncovered, [], "点号键由 {ip}.{name} 兜底（已知取舍）");
});

test("夹具 demo.ioc 的每个键都被真值表覆盖（0 未覆盖）", () => {
  const entries = parseIocEntries(readFileSync(DEMO_IOC, "utf8"));
  const coverage = iocSchemaCoverage(entries.keys());
  assert.deepEqual(coverage.uncovered, [], "有键不在真值表里：补 spec 或改生成器");
});

test("真 plan 回归：候选文件里所有键都被覆盖，且不出现 _IRQn_IRQn 这种拼错的向量键", () => {
  const { projectDir } = freshProject();
  const report = planIocChanges({
    projectDir,
    pins: [
      { pin: "PA6", label: "led2", outputType: "od", initial: "high" },
      { pin: "PA0-WKUP", interrupt: "falling", pull: "up" },
    ],
    interrupts: ["USART1"],
    serialWire: true,
  });
  assert.equal(report.ok, true, report.message);
  const entries = parseIocEntries(candidateText(projectDir, report.planId));
  const coverage = iocSchemaCoverage(entries.keys());
  assert.deepEqual(coverage.uncovered, [], "生成器写出来的键必须都在真值表里");
  for (const key of entries.keys()) {
    assert.doesNotMatch(key, /_IRQn_IRQn/u, "向量名重复了 _IRQn 后缀：" + key);
  }
  // schema 化的键名要真的落到候选文件里
  assert.equal(entries.get("NVIC.USART1_IRQn")?.startsWith("true:0:0:"), true, "USART1 中断要被打开");
  assert.equal(entries.get("NVIC.EXTI0_IRQn")?.startsWith("true:0:0:"), true, "EXTI0 中断要被打开");
  assert.equal(entries.get("PA0-WKUP.GPIO_ModeDefaultEXTI"), "GPIO_MODE_IT_FALLING");
  assert.equal(entries.get("SH.GPXTI0.0"), "GPIO_EXTI0");
  assert.equal(entries.get("PA6.GPIO_Mode"), "GPIO_MODE_OUTPUT_OD");
  assert.equal(entries.get("PA6.GPIOParameters")?.includes("GPIO_Mode"), true, "GPIO_Mode 必须列进 GPIOParameters");
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
