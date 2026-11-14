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
    // 时间线与详情合并进「事件」页签（S86）：默认标签是实时通道，用页签名钉住入口。
    assert.ok(text.includes("事件"), text.slice(0, 200));
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
    assert.ok(source.includes("fault-group-"), "故障页要能按规则合并显示");
    assert.ok(source.includes("按规则合并"), "故障页要显示分组标题");
    assert.ok(source.includes("toolDurations"), "时间线要能算每次调用的耗时");
    assert.ok(source.includes("TOOL_SLOW_MS"), "慢调用要有阈值常量");
    assert.ok(source.includes("按耗时"), "时间线要能按耗时排序");
    assert.ok(source.includes("evidence-group-"), "证据列表要按会话分组");
    assert.ok(source.includes("最近 gdb 输出"), "会话卡要显示最近的 gdb 原始输出");
    assert.ok(source.includes("ioc-keys?"), "引脚页要能查该脚在 .ioc 里的键");
    assert.ok(source.includes("exportChannelLines"), "通道要能导出当前窗口的文本");
    assert.ok(source.includes("ioc-diff/restore-all"), "变更页要能一次恢复全部差异");
    assert.ok(source.includes("pinMatches"), "引脚页要能按引脚/信号筛选");
    assert.ok(source.includes('"最近事件"'), "概览要能看到最近事件时间");
    assert.ok(source.includes("筛选中断名"), "中断页要能按名字筛选");
    assert.ok(source.includes("关闭会话"), "会话卡要能关闭会话");
    assert.ok(source.includes("kindCounts"), "时间线要能按工具名快速筛选");
    assert.ok(source.includes("copyGroup"), "故障组要能复制规则与提示");
    assert.ok(source.includes("exportPinsCsv"), "引脚表要能导出 CSV");
    assert.ok(source.includes("runningNow"), "概览要显示在途调用");
    assert.ok(source.includes("onShowChannels"), "在途行要能跳到实时通道");
    assert.ok(source.includes("按优先级"), "中断页要能切换排序");
    assert.ok(source.includes("function pinBoxSides("), "方框视图按封装脚位排布（S77）");
    assert.ok(source.includes("只看分类") && source.includes("只看规则"), "分类与规则同时生效时要能一键退回单条件");
    assert.ok(source.includes("function PinBox("), "方框视图组件要在（S77）");
    assert.ok(source.includes("批量应用"), "中断页要能批量改优先级");
    assert.ok(source.includes("summaryMarkdown"), "操作记录要能整理成 Markdown");
    assert.ok(source.includes("CompileWarnings"), "编译警告要能在详情里列出");
    assert.ok(source.includes("function ClockFlow("), "时钟图模式必须真有组件实现（S76）");
    assert.ok(source.includes("d32-page"), "面板根节点要挂样式类（S85）");
    assert.ok(source.includes("ensureDebugStyleTag"), "样式表只注入一次（S85）");
    assert.ok(source.includes("--d32-accent") && source.includes("--dsw-alias-state-business-primary"), "强调色取宿主令牌并落到 --d32-accent（S89）");
    assert.ok(source.includes("D32_WARN"), "警告色不再写死 #e8b339（S88）");
    assert.ok(source.includes("D32_LABEL_MONO") && source.includes("textTransform: \"uppercase\""), "小标走等宽大写（S89）");
    assert.ok(source.includes("data-active=") && source.includes("border-bottom-color: var(--d32-accent)"), "选中页签用下划线而不是填充（S89）");
    assert.ok(!source.includes("boxShadow: \"var(--dsw-shadow-lv1)\""), "面板不再套卡片阴影（S89）");
    assert.ok(source.includes("d32-events"), "时间线与详情合并成一个「事件」页签（S86）");
    assert.ok(source.includes("DEBUG_LABELS.detail") && source.includes("事件详情"), "事件详情仍是独立组件（S86）");
    assert.ok(source.includes("exportFaultsCsv"), "失败事件要能导出 CSV");
    assert.ok(source.includes("unseenFails"), "失败未读角标要能看见");
    assert.ok(source.includes("overLimit"), "时钟页要标出超限频率");
    assert.ok(source.includes("exportWatchCsv"), "监视采样明细要能导出 CSV");
    assert.ok(source.includes("collectBuildShas"), "产物页要能比较两次构建的 elf");
    assert.ok(source.includes("warnParts"), "概览要把在途与失败合成一行告警");
    assert.ok(source.includes("failToast") && source.includes("新失败"), "新失败要在面板顶部主动提示");
    assert.ok(source.includes("readDebugEventSeq") && source.includes("writeDebugEventSeq"), "事件要能深链到地址栏");
    assert.ok(source.includes("ProbeCard") && source.includes("probe-info"), "探针信息卡要读 /probe-info");
    assert.ok(source.includes("DEBUG_PROJECT_KEY"), "工程选择要按会话记住");
    assert.ok(source.includes("function useProjects("), "面板要读工程索引");
    assert.ok(source.includes("已载入最近一份历史记录"), "打开面板时应自动载入最近证据");
    assert.ok(source.includes("fallbackProjectDir"), "没有会话时要退到工作区里的第一个工程");
    assert.ok(text.includes("当前没有在途的工具调用"), text.slice(0, 800));
    assert.ok(source.includes("function useSchematic("), "原理图页签要读 /schematic（S90）");
    assert.ok(source.includes("function layoutSchematic(") && source.includes("function SchematicPanel("), "原理图页要能画模块框图（S90）");
    assert.ok(source.includes('tabButton("schematic"'), "原理图要有独立页签（S90）");
    assert.ok(source.includes('tab === "schematic"') && source.includes("schematic?projectDir="), "页签要带工程目录请求（S90）");
    assert.ok(source.includes("powerNets") && source.includes("d32-sch-grid"), "框图要有网格底与电源网络（S90）");
    assert.ok(source.includes('schematic: "流程图"'), "页签名改为流程图（S101）");
    assert.ok(source.includes("function sideToward") && source.includes("function portAnchor"), "连线要能从框的四个方向进出（S103）");
    assert.ok(source.includes('paintOrder: "stroke"'), "连线标签要描底色，压线时仍然可读（S101）");
    assert.ok(source.includes("const ringX") && source.includes("const ringY"), "模块要绕主控环形摆放，图不能拉成一条长竖线（S103）");
    assert.ok(source.includes("const mcuHeight") && source.includes("function roundedPath"), "主控框按连线数长高，拐角走圆角（S103）");
    assert.ok(source.includes("function blockWidth"), "框宽要跟着文字长度走（S104）");
    assert.ok(source.includes("const sameAxis"), "同一根轴上的两侧要能拉直，不能为了拐弯而拐弯（S104）");
    assert.ok(source.includes("strokeWidth: 1.5"), "整框用模块色描边，保留一条左侧竖线会让人猜（S104）");
    assert.ok(source.includes("function setApiSessionId(") && source.includes("function withSessionParam("), "请求要带会话 id（S91）");
    assert.ok(source.includes("setApiSessionId(sessionId)"), "面板挂载时写入当前会话 id（S91）");
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});

test("电路设计页签：读 /ecad 并给出下一步动作（S99）", () => {
  const source = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
  assert.equal(source.includes("function useEcad("), true);
  assert.equal(source.includes("function EcadPanel("), true);
  assert.equal(source.includes('callApi("GET", "ecad?projectDir="'), true);
  assert.equal(source.includes('tabButton("ecad", DEBUG_LABELS.ecad)'), true);
  assert.equal(source.includes('tab === "ecad"'), true);
  assert.match(source, /stm32_ecad_init/u);
  assert.match(source, /ecad\/action/u);
  assert.match(source, /const runAction/u);
});
