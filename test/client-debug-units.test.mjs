// 为什么要有这个套件：lib/client.js 是手写浏览器模块，不经 tsc，也没有浏览器测试环境。
// 它一旦写错（少一个 require、hooks 用错、槽位注册名写错），表现是"标签不出现"，
// 而且在插件日志里往往无声无息。这里用最小 React/存档器桩把模块跑起来，
// 钉住两件事：两个槽位都注册了；调试台组件能完成一次渲染。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
    assert.ok(text.includes("引脚"), "工作区标签要有引脚页：" + text.slice(0, 400));
    assert.ok(text.includes("时钟"), "工作区标签要有时钟页：" + text.slice(0, 400));
    assert.ok(text.includes("故障"), "工作区标签要有故障页：" + text.slice(0, 500));
    assert.ok(text.includes("产物"), "工作区标签要有产物页：" + text.slice(0, 500));
    assert.ok(text.includes("概览"), "工作区标签要有概览页：" + text.slice(0, 500));
    assert.ok(text.includes("回放…"), "时间线工具栏要有回放入口：" + text.slice(0, 500));
    assert.ok(text.includes("变更"), "工作区标签要有变更页：" + text.slice(0, 500));
    assert.ok(text.includes("导出 JSONL"), "时间线工具栏要能导出当前视图：" + text.slice(0, 500));
    assert.ok(text.includes("全部事件"), "时间线工具栏要有状态筛选：" + text.slice(0, 500));
    assert.ok(text.includes("命中历史"), "断点面板要有命中历史：" + text.slice(0, 500));
    assert.ok(text.includes("自动采样"), "监视曲线要有自动采样开关：" + text.slice(0, 500));
    assert.ok(text.includes("发送"), "串口通道要有发送输入框：" + text.slice(0, 500));
    assert.ok(text.includes("引脚") || text.includes("点行复制引用"), "引脚页要有入口：" + text.slice(0, 500));
    assert.ok(text.includes("错误") && text.includes("警告"), "RTT 通道要有级别过滤：" + text.slice(0, 600));
    assert.ok(text.includes("回放…") && text.includes("变更") && text.includes("中断"), "工具栏与工作区标签要齐全：" + text.slice(0, 600));
    assert.ok(text.includes("复制已选"), "批量复制引用的按钮要常驻：" + text.slice(0, 600));
    // 概览页不在默认标签里，渲染文本看不到它；改从源码钉住「工具链一行」的实现。
    const source = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
    assert.ok(source.includes("useProbeSummary"), "概览页要用工具链探测摘要");
    assert.ok(source.includes("capabilitiesText"), "概览页要显示编译/烧录/调试/生成四项能力");
    assert.ok(source.includes('"工具链"'), "概览页要有工具链一行");
    assert.ok(source.includes("复制 payload"), "事件详情要能复制 payload");
    assert.ok(source.includes("parseHitLocation"), "停点要能解析出源码位置");
    assert.ok(source.includes("parseCompileError") && source.includes("CompileErrors"), "编译错误要能点击跳源码");
    assert.ok(source.includes("SerialCard") && source.includes("刷新端口"), "串口卡片要能开会话、列端口");
    assert.ok(source.includes("onShowFailures") && source.includes("只看失败"), "概览的失败数要能跳到失败视图");
    assert.ok(source.includes("清理旧证据") && source.includes("evidence/prune"), "证据目录要能显示占用并清理旧证据");
    assert.ok(source.includes("useIocSync"), "引脚页要显示 .ioc 与生成代码是否同步");
    assert.ok(source.includes("WatchAdmin") && source.includes("监视登记表"), "实时通道要能编辑监视登记表");
    assert.ok(source.includes("BuildCard") && source.includes("构建与烧录"), "面板要能直接构建与烧录");
    assert.ok(source.includes("pinMapRows") && source.includes("PinMap"), "引脚页要有按端口排布的图");
    assert.ok(source.includes("ioc-diff/restore") && source.includes("恢复中…"), "变更页要能把某个键写回基线");
    assert.ok(source.includes("interrupts/priority") && source.includes("保存中…"), "中断页要能改优先级");
    assert.ok(source.includes("已回填当前参数"), "串口卡片要能把当前参数填回输入框");
    assert.ok(source.includes("staleLib") && source.includes("有新构建"), "状态条要能看出 lib 比进程新");
    assert.ok(source.includes("最近发送") && source.includes("resend"), "串口发送要有历史与重发");
    assert.ok(source.includes("校验和"), "产物页要显示 elf 校验和");
    assert.ok(source.includes("clockFlowRows") && source.includes("ClockFlow"), "时钟页要有流向图");
    assert.ok(source.includes("fault-chip-"), "故障页要能按分类筛选");
    assert.ok(source.includes("readDebugEventSeq") && source.includes("writeDebugEventSeq"), "事件要能深链到地址栏");
    assert.ok(source.includes("ProbeCard") && source.includes("probe-info"), "探针信息卡要读 /probe-info");
    assert.ok(text.includes("当前没有在途的工具调用"), text.slice(0, 800));
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});
