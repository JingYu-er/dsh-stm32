// 为什么要有这个套件：lib/client.js 是手写浏览器模块，不经 tsc，也没有浏览器测试环境。
// 它一旦写错（少一个 require、hooks 用错、槽位注册名写错），表现是"标签不出现"，
// 而且在插件日志里往往无声无息。这里用最小 React/存档器桩把模块跑起来，
// 钉住两件事：两个槽位都注册了；调试台组件能完成一次渲染。
import { test } from "node:test";
import assert from "node:assert/strict";

/** 最小 React 桩：只实现 client/client.js 用到的 API。 */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: "Fragment",
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => undefined],
  useEffect: () => undefined,
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial ?? null }),
  createContext: () => ({ Provider: "Provider", Consumer: "Consumer" }),
};

function stubLocalStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

test("client.js：注册设置面板与调试台两个槽位，调试台可渲染", async () => {
  const registered = [];
  let loaded = null;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    __ModuleLoader__: {
      load: (definition) => {
        loaded = definition;
      },
    },
    localStorage: stubLocalStorage(),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  globalThis.document = { baseURI: "http://127.0.0.1/" };
  try {
    await import("../lib/client.js");
    assert.ok(loaded !== null, "client.js 必须调用 __ModuleLoader__.load");
    assert.equal(loaded.id, "dsh-stm32");
    const exports = loaded.factory((name) => {
      if (name === "react") return React;
      if (name === "react/jsx-runtime") return { jsx: React.createElement, jsxs: React.createElement };
      return {};
    });
    assert.deepEqual(exports.inject, ["slots"]);
    const ctx = {
      effect: (callback) => callback(),
      slots: {
        inject: (name, callback) => {
          assert.ok(name === "settings.section" || name === "conversation.view", name);
          return callback();
        },
        register: (definition, component) => {
          registered.push({ definition, component });
          return () => undefined;
        },
      },
    };
    exports.apply(ctx);
    assert.equal(registered.length, 2);
    const settings = registered.find((item) => item.definition.name === "settings.section");
    const debug = registered.find((item) => item.definition.name === "conversation.view");
    assert.ok(settings !== undefined, "设置面板槽位不能丢");
    assert.equal(settings.definition.id, "stm32");
    assert.equal(settings.definition.label(), "STM32 工具链");
    assert.ok(debug !== undefined, "调试台槽位必须注册");
    assert.equal(debug.definition.id, "stm32-debug");
    assert.equal(debug.definition.label(), "调试台");
    assert.equal(typeof debug.component, "function");
    assert.equal(typeof debug.definition.inject, "function", "必须从宿主拿 sessionId，否则不能按会话过滤事件");
    assert.deepEqual(debug.definition.inject("session-abc"), { sessionId: "session-abc" });

    // 渲染一次：桩 React 只造元素不执行组件，这里递归展开函数组件，
    // 能暴露"少字段/引用未定义"这类错误，也能验证关键文案确实进了树。
    const renderText = (node) => {
      if (node === null || node === undefined || node === false || node === true) return "";
      if (typeof node === "string" || typeof node === "number") return String(node);
      if (Array.isArray(node)) return node.map(renderText).join(" ");
      // 真 React 会把 children 塞进 props.children；桩把它留在 node.children，
      // 展开组件时补回去，否则面板正文（DebugPanel 的 props.children）会被吞掉。
      if (typeof node.type === "function") return renderText(node.type(Object.assign({}, node.props, { children: node.children })));
      return renderText(node.children);
    };
    const text = renderText(debug.component({}));
    assert.ok(text.includes("调试台"), text.slice(0, 200));
    assert.ok(text.includes("时间线"), text.slice(0, 200));
    assert.ok(text.includes("事件详情"), text.slice(0, 200));
    assert.ok(text.includes("调试会话"), text.slice(0, 400));
    assert.ok(text.includes("暂无数值型监视采样"), text.slice(0, 400));
    assert.ok(text.includes("断点"), text.slice(0, 600));
    // 输入框的 placeholder 是属性，不在文本树里；这里断言按钮文案与状态。
    assert.ok(text.includes("无会话"), text.slice(0, 600));
    assert.ok(text.includes("移除"), text.slice(0, 600));
    assert.ok(text.includes("在途调用"), text.slice(0, 800));
    assert.ok(text.includes("当前没有在途的工具调用"), text.slice(0, 800));
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});
