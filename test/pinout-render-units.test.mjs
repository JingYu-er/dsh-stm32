/**
 * 引脚面板渲染回归（S84d）。
 *
 * 为什么要有这一条：S59 给 head 加了「导出 CSV」按钮，按钮里读了 `totalPins`，
 * 而 `totalPins` 声明在 head 之后 —— 数据没回来时走加载分支不报错，等 `/pinout`
 * 真返回数据才抛 `ReferenceError: Cannot access 'totalPins' before initialization`，
 * 整个面板随之空白。静态检查看不出这种「声明在使用之后」，只有真渲染一遍才知道。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const CLIENT = fs.readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
const SOURCE = CLIENT
  .replace("function PinoutPanel(props) {", "globalThis.__PINOUT__ = function PinoutPanel(props) {")
  .replace("function ClockPanel(props) {", "globalThis.__CLOCK__ = function ClockPanel(props) {");

const PIN = { pin: "PA9", signal: "USART1_TX", label: "", mode: "Asynchronous", locked: false, kind: "peripheral" };

const PINOUT = {
  projectDir: "D:/demo",
  iocPath: "D:/demo/demo.ioc",
  iocName: "demo.ioc",
  mcu: { cpn: "STM32F103C8T6", family: "STM32F1", package: "LQFP48" },
  clocks: { sysclkHz: 72000000, hclkHz: 72000000, apb1Hz: 36000000, apb2Hz: 72000000 },
  debug: { serialWire: true },
  nvicCount: 9,
  warnings: [],
  pins: [PIN],
  groups: [{ name: "USART1", pins: [PIN] }],
  peripherals: [],
  physical: {
    available: true,
    packageName: "LQFP48",
    pinCount: 48,
    reason: "",
    positions: [{ pin: "PA9", position: 30 }, { pin: "PA0-WKUP", position: 10 }, { pin: "VBAT", position: 1 }],
  },
};

function harness() {
  const queue = [];
  const React = {
    useState: (init) => [queue.length > 0 ? queue.shift() : init, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    createElement: (type, props, ...children) => ({
      type,
      props: Object.assign({}, props, { children: children.length <= 1 ? children[0] : children }),
    }),
    Fragment: "fragment",
  };
  const stub = {
    React,
    document: { createElement: () => ({ style: {}, click() {}, remove() {} }), body: { appendChild() {}, removeChild() {} } },
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: { clipboard: { writeText: async () => {} } },
    location: { hash: "", href: "http://x/" },
    EventSource: class { close() {} },
  };
  let factory = null;
  const window = Object.assign({ __ModuleLoader__: { load: (definition) => { factory = definition.factory; } } }, stub);
  const requireStub = (name) =>
    name === "react" ? React : name === "react/jsx-runtime" ? { jsx: React.createElement, jsxs: React.createElement } : {};
  const run = new Function(
    "globalThis",
    "window",
    "document",
    "localStorage",
    "navigator",
    "location",
    "EventSource",
    "setInterval",
    "clearInterval",
    "setTimeout",
    "clearTimeout",
    SOURCE,
  );
  run(globalThis, window, stub.document, stub.localStorage, stub.navigator, stub.location, stub.EventSource, setInterval, clearInterval, setTimeout, clearTimeout);
  assert.equal(typeof factory, "function", "client.js 应通过 __ModuleLoader__.load 交出一个 factory");
  factory(requireStub);
  return { Panel: globalThis.__PINOUT__, Clock: globalThis.__CLOCK__, queue };
}

/**
 * useState 顺序（真渲染时数出来的 8 个）：usePinout(pinout, error, tick) →
 * useIocSync(sync) → PinoutPanel(copiedPin, mode, pinKeys, needle)。
 * 第一个值塞 pinout 就等于「/pinout 已经回来了」。
 */
/** 把 createElement 树展开成文本：函数组件要真调用一次，否则 box 视图里只有组件引用。 */
function renderText(node) {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(renderText).join(" ");
  if (typeof node.type === "function") {
    return renderText(node.type(Object.assign({}, node.props, { children: node.props?.children })));
  }
  return renderText(node.props?.children);
}

function renderPanel(mode) {
  const { Panel, queue } = harness();
  queue.push(PINOUT, "", 0, null, "", mode, null, "");
  return Panel({ projectDir: "D:/demo" });
}

for (const mode of ["table", "map", "box"]) {
  test(`引脚面板在「${mode}」视图下能渲染（S84d）`, () => {
    const tree = renderPanel(mode);
    const text = renderText(tree);
    assert.ok(text.includes(mode === "table" ? "USART1" : mode === "map" ? "PA9" : "LQFP48"), "渲染结果里应带上该视图的内容：" + text.slice(0, 80));
  });
}

test("引脚面板：没有工程目录时给出可读提示，而不是空白（S84d）", () => {
  const { Panel, queue } = harness();
  queue.push(null, "", 0, null, "", "table", null, "");
  const text = renderText(Panel({ projectDir: "" }));
  assert.ok(text.includes("当前没有可用的工程目录"), "空工程目录要有提示");
});

/* ---------------- 时钟面板（S84e） ---------------- */

const CLOCKS = {
  projectDir: "D:/demo",
  iocPath: "D:/demo/demo.ioc",
  cpn: "STM32F103C8T6",
  sysclkSource: "RCC_SYSCLKSOURCE_PLLCLK",
  sysclkSourceLabel: "PLL",
  pll: { source: "RCC_PLLSOURCE_HSE", sourceLabel: "HSE", mul: "RCC_PLL_MUL9", mulLabel: "×9" },
  nodes: [
    { label: "SYSCLK", hz: 72000000, key: "RCC.SYSCLKFreq_VALUE", divider: "", limitHz: null, overLimit: false, suggest: "" },
    { label: "PCLK1 / APB1", hz: 36000000, key: "RCC.APB1Freq_Value", divider: "÷2", limitHz: 36000000, overLimit: false, suggest: "" },
    {
      label: "ADC",
      hz: 36000000,
      key: "RCC.ADCFreqValue",
      divider: "÷2",
      limitHz: 14000000,
      overLimit: true,
      suggest: "把分频改成 ÷4（9 MHz）",
    },
  ],
  others: [],
  limits: { family: "STM32F1", apb1Hz: 36000000, apb2Hz: 72000000, adcHz: 14000000 },
};

/** useState 顺序：ClockPanel(mode) → useClockTree(clocks, error, tick)（钩子已提到早退之前）。 */
function renderClock(mode) {
  const { Clock, queue } = harness();
  queue.push(mode, CLOCKS, "", 0);
  return Clock({ projectDir: "D:/demo" });
}

for (const mode of ["table", "flow"]) {
  test(`时钟面板在「${mode}」视图下能渲染（S84e）`, () => {
    const text = renderText(renderClock(mode));
    assert.ok(text.includes("STM32F103C8T6"), "应显示型号：" + text.slice(0, 80));
    assert.ok(text.includes("SYSCLK"), "应显示 SYSCLK 一路");
    assert.ok(text.includes("÷4"), "超限行应带分频建议");
  });
}

test("时钟面板：没有工程目录时不调用钩子也能给出提示（S84e）", () => {
  const { Clock, queue } = harness();
  queue.push("table", null, "", 0);
  const text = renderText(Clock({ projectDir: "" }));
  assert.ok(text.includes("当前没有可用的工程目录"), "空工程目录要有提示");
});
