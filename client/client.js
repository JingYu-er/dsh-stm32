window.__ModuleLoader__.load({
  id: "dsh-stm32",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /*
     * dsh-stm32 浏览器端设置面板（手写纯 JS，不经 tsc）。
     *
     * 为什么文件第一行就是 load({：宿主客户端模块加载器按这个自执行包装取走并执行本文件，
     * 注释放在包装外面会被当成"包装前有别的语句"，与 dsh-client-ui-* 的产物形状不一致。
     *
     * 为什么是纯 JS：本文件由宿主加载器直接执行，不经过插件的 TS 构建链；
     * 写成 TS/JSX 会多出一份由 tsc 决定产物路径的中间层，而面板的正确产物就是
     * client/client.js 原文（scripts/copy-client.mjs 把它原样复制到 lib/client.js）。
     * 所以这里只用手写 React.createElement，且只 require 外壳种子词：
     * react / react/jsx-runtime / primitives。
     *
     * 面板只做三件事：读配置、跑探测、走安装（出计划 → 确认 → 轮询日志）。
     * 数据全部来自 src/engine/web-api.ts 暴露的 /dsh-stm32/api/*；路径按
     * document.baseURI 相对解析（与 web-api 的注释同一口径），宿主把 Web
     * 部署在子路径下也能用。
     */

    const React = require("react");
    const { useCallback, useEffect, useState } = React;

    /* ------------------------------ 接口层 ------------------------------ */

    /** 与 web-api.ts 的 WEB_API_PREFIX 对应，去掉前导 / 以便相对 baseURI 解析。 */
    const API_RELATIVE = "dsh-stm32/api/";
    const POLL_INTERVAL_MS = 1200;

    function describeError(error) {
      if (error instanceof Error) return error.message;
      return String(error);
    }

    function apiUrl(path) {
      const base = typeof document === "object" && document !== null && typeof document.baseURI === "string"
        ? document.baseURI
        : "http://127.0.0.1/";
      try {
        return new URL(API_RELATIVE + path, base).toString();
      } catch {
        // 极早的加载时机（document 还没就位）：退回根路径，至少不会让面板整个炸掉。
        return "/dsh-stm32/api/" + path;
      }
    }

    /**
     * 调一次面板接口。返回值刻意统一成 { ok, value } / { ok:false, error }：
     * 面板上每个操作只要关心"成了没成、为什么没成"，不用各自解析 HTTP 语义。
     */
    async function callApi(method, path, body) {
      const url = apiUrl(path);
      const init = { method: method, credentials: "same-origin", headers: {} };
      if (body !== undefined) {
        init.headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      let response;
      try {
        response = await fetch(url, init);
      } catch (error) {
        return { ok: false, error: "请求接口失败（" + url + "）：" + describeError(error) };
      }
      let text = "";
      try {
        text = await response.text();
      } catch (error) {
        return { ok: false, error: "读取接口响应失败：" + describeError(error) };
      }
      let payload;
      try {
        payload = text === "" ? {} : JSON.parse(text);
      } catch {
        return {
          ok: false,
          error: "接口返回的不是 JSON（HTTP " + String(response.status) + "）：" + text.slice(0, 200),
        };
      }
      if (payload !== null && typeof payload === "object" && payload.ok === true) return { ok: true, value: payload };
      const message =
        payload !== null && typeof payload === "object" && typeof payload.error === "string" && payload.error !== ""
          ? payload.error
          : "接口返回失败（HTTP " + String(response.status) + "）";
      return { ok: false, error: message };
    }

    /* ------------------------------ 小工具 ------------------------------ */

    /** 每行一个目录，空行与重复项丢掉；空数组等于"不覆盖"。 */
    function parseBinDirs(text) {
      const out = [];
      for (const line of String(text ?? "").split(/\r?\n/gu)) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        if (!out.includes(trimmed)) out.push(trimmed);
      }
      return out;
    }

    function formatBytes(bytes) {
      const value = typeof bytes === "number" && Number.isFinite(bytes) ? bytes : 0;
      if (value <= 0) return "0 B";
      const mb = value / (1024 * 1024);
      if (mb >= 1) return mb.toFixed(1) + " MB";
      return (value / 1024).toFixed(0) + " KB";
    }

    function toolSummaryLine(tool) {
      if (tool === null || typeof tool !== "object") return "";
      if (tool.found !== true) return String(tool.hint ?? "");
      const version = typeof tool.version === "string" ? tool.version : "";
      if (version !== "") return version;
      const where = typeof tool.path === "string" ? tool.path : "";
      return where;
    }

    const CAPABILITIES = [
      ["build", "编译"],
      ["flash", "烧录"],
      ["debug", "调试"],
      ["generate", "生成代码"],
    ];

    const STEP_ICONS = {
      done: "✔",
      running: "…",
      failed: "✘",
      skipped: "–",
      pending: "·",
    };

    /* ------------------------------ 样式 ------------------------------ */

    // 样式全部内联：客户端插件没有外部 CSS 通道（宿主不加载插件的 .css），
    // 颜色尽量跟随 currentColor，深浅主题都不至于看不清。
    const styles = {
      root: {
        display: "flex",
        flexDirection: "column",
        gap: "16px",
        padding: "4px 4px 32px",
        maxWidth: "880px",
        color: "inherit",
        fontSize: "13px",
        lineHeight: "1.55",
      },
      title: { margin: "0", fontSize: "16px", fontWeight: 600 },
      lead: { margin: "0", opacity: 0.72 },
      card: {
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        padding: "14px 16px",
        border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
        borderRadius: "10px",
      },
      cardHead: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "12px" },
      cardTitle: { margin: "0", fontSize: "13px", fontWeight: 600 },
      cardNote: { margin: "0", opacity: 0.62, fontSize: "12px" },
      row: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
      label: { minWidth: "104px", opacity: 0.8 },
      input: {
        flex: "1 1 320px",
        minWidth: "220px",
        padding: "6px 8px",
        font: "inherit",
        color: "inherit",
        background: "transparent",
        border: "1px solid color-mix(in srgb, currentColor 25%, transparent)",
        borderRadius: "6px",
      },
      textarea: {
        width: "100%",
        boxSizing: "border-box",
        minHeight: "62px",
        padding: "6px 8px",
        font: "inherit",
        color: "inherit",
        background: "transparent",
        border: "1px solid color-mix(in srgb, currentColor 25%, transparent)",
        borderRadius: "6px",
        resize: "vertical",
      },
      button: {
        padding: "5px 12px",
        font: "inherit",
        color: "inherit",
        background: "transparent",
        border: "1px solid color-mix(in srgb, currentColor 30%, transparent)",
        borderRadius: "6px",
        cursor: "pointer",
      },
      buttonPrimary: {
        padding: "5px 12px",
        font: "inherit",
        color: "#ffffff",
        background: "#2563eb",
        border: "1px solid #2563eb",
        borderRadius: "6px",
        cursor: "pointer",
      },
      buttonDanger: {
        padding: "5px 12px",
        font: "inherit",
        color: "#ffffff",
        background: "#b91c1c",
        border: "1px solid #b91c1c",
        borderRadius: "6px",
        cursor: "pointer",
      },
      mono: { fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontSize: "12px", wordBreak: "break-all" },
      chips: { display: "flex", gap: "8px", flexWrap: "wrap" },
      chipOk: {
        padding: "2px 8px",
        borderRadius: "999px",
        border: "1px solid color-mix(in srgb, currentColor 20%, transparent)",
        background: "color-mix(in srgb, #16a34a 16%, transparent)",
      },
      chipBad: {
        padding: "2px 8px",
        borderRadius: "999px",
        border: "1px solid color-mix(in srgb, currentColor 20%, transparent)",
        background: "color-mix(in srgb, #b91c1c 16%, transparent)",
      },
      list: { display: "flex", flexDirection: "column", gap: "4px", margin: "0", padding: "0", listStyle: "none" },
      toolRow: { display: "flex", gap: "8px", alignItems: "baseline" },
      toolLabel: { minWidth: "220px" },
      toolDetail: { opacity: 0.66 },
      note: { margin: "0", fontSize: "12px", opacity: 0.86, whiteSpace: "pre-wrap" },
      pre: {
        margin: "0",
        padding: "8px 10px",
        maxHeight: "220px",
        overflow: "auto",
        fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
        fontSize: "12px",
        border: "1px solid color-mix(in srgb, currentColor 16%, transparent)",
        borderRadius: "6px",
        whiteSpace: "pre-wrap",
      },
      error: { margin: "0", fontSize: "12px", color: "#dc2626", whiteSpace: "pre-wrap" },
      ok: { margin: "0", fontSize: "12px", color: "#16a34a", whiteSpace: "pre-wrap" },
      muted: { margin: "0", fontSize: "12px", opacity: 0.62 },
    };

    const e = React.createElement;

    /* ------------------------------ 纯渲染件 ------------------------------ */

    function toolRow(tool, index) {
      const found = tool !== null && typeof tool === "object" && tool.found === true;
      const error = tool !== null && typeof tool === "object" && typeof tool.error === "string" ? tool.error : "";
      return e(
        "li",
        { key: String(tool?.id ?? index), style: { display: "flex", flexDirection: "column", gap: "2px" } },
        e(
          "div",
          { style: styles.toolRow },
          e("span", { "aria-hidden": "true" }, found ? "✔" : "✘"),
          e("span", { style: styles.toolLabel }, String(tool?.label ?? tool?.id ?? "")),
          e("span", { style: { opacity: 0.66, wordBreak: "break-all" } }, toolSummaryLine(tool)),
        ),
        error === "" ? null : e("div", { style: styles.muted }, error),
      );
    }

    function capabilityChips(capabilities) {
      return e(
        "div",
        { style: styles.chips },
        CAPABILITIES.map(([id, label]) => {
          const ok = capabilities !== null && typeof capabilities === "object" && capabilities[id] === true;
          return e("span", { key: id, style: ok ? styles.chipOk : styles.chipBad }, (ok ? "✔ " : "✘ ") + label);
        }),
      );
    }

    function stepList(steps) {
      if (!Array.isArray(steps) || steps.length === 0) return null;
      return e(
        "ul",
        { style: styles.list },
        steps.map((step, index) =>
          e(
            "li",
            { key: String(step?.id ?? index) },
            e(
              "div",
              null,
              (STEP_ICONS[step?.status] ?? "·") + " " + String(step?.label ?? step?.id ?? ""),
            ),
            String(step?.detail ?? "") === ""
              ? null
              : e("div", { style: styles.muted }, String(step.detail)),
          ),
        ),
      );
    }

    /* ------------------------------ 面板主体 ------------------------------ */

    /**
     * 设置页里的「STM32 工具链」一节。
     * 组件自己取数据：注册时不传 locale、不传 inject，宿主只负责把这块内容
     * 摆进设置面板的内容列（settings.section 的所有者只保证一个 close 回调）。
     */
    function Stm32Section() {
      const [snapshot, setSnapshot] = useState(null);
      const [configError, setConfigError] = useState("");
      const [loadingConfig, setLoadingConfig] = useState(true);

      const [msys64, setMsys64] = useState("");
      const [cubeMxRoot, setCubeMxRoot] = useState("");
      const [binDirsText, setBinDirsText] = useState("");
      const [saving, setSaving] = useState(false);
      const [saveNote, setSaveNote] = useState(null);

      const [probing, setProbing] = useState(false);
      const [probe, setProbe] = useState(null);
      const [probeError, setProbeError] = useState("");

      const [planning, setPlanning] = useState(false);
      const [plan, setPlan] = useState(null);
      const [planError, setPlanError] = useState("");
      const [confirmInstall, setConfirmInstall] = useState(false);
      const [starting, setStarting] = useState(false);

      const [taskId, setTaskId] = useState("");
      const [installState, setInstallState] = useState(null);
      const [installError, setInstallError] = useState("");

      const applySnapshot = useCallback((next) => {
        if (next === null || typeof next !== "object") return;
        setSnapshot(next);
        const config = next.config !== null && typeof next.config === "object" ? next.config : null;
        setMsys64(config === null ? "" : String(config.msys64 ?? ""));
        setCubeMxRoot(config === null ? "" : String(config.cubeMxRoot ?? ""));
        const dirs = Array.isArray(next.binDirs) ? next.binDirs : [];
        setBinDirsText(dirs.map((item) => String(item)).join("\n"));
      }, []);

      const loadConfig = useCallback(async () => {
        setLoadingConfig(true);
        const result = await callApi("GET", "config");
        setLoadingConfig(false);
        if (!result.ok) {
          setConfigError(result.error);
          return;
        }
        setConfigError("");
        applySnapshot(result.value.snapshot);
      }, [applySnapshot]);

      // 打开面板读一次配置：配置是唯一"用户已经决定的"状态，其余都是探测结果。
      useEffect(() => {
        void loadConfig();
      }, [loadConfig]);

      // 安装任务轮询：宿主把安装跑在后台，面板只读状态。任务结束就停表并重读配置
      // （安装器成功时会把 msys64 / binDirs 写回配置文件）。
      useEffect(() => {
        if (taskId === "") return undefined;
        let cancelled = false;
        let timer = null;
        const tick = async () => {
          const result = await callApi("GET", "install/state?taskId=" + encodeURIComponent(taskId));
          if (cancelled) return;
          if (!result.ok) {
            setInstallError(result.error);
            setTaskId("");
            return;
          }
          const state = result.value.state;
          setInstallState(state);
          setInstallError("");
          if (state !== null && typeof state === "object" && state.status === "running") {
            timer = setTimeout(tick, POLL_INTERVAL_MS);
            return;
          }
          setTaskId("");
          void loadConfig();
        };
        timer = setTimeout(tick, 300);
        return () => {
          cancelled = true;
          if (timer !== null) clearTimeout(timer);
        };
      }, [taskId, loadConfig]);

      const save = async () => {
        setSaving(true);
        setSaveNote(null);
        const result = await callApi("POST", "config/save", {
          msys64: msys64.trim(),
          cubeMxRoot: cubeMxRoot.trim(),
          binDirs: parseBinDirs(binDirsText),
        });
        setSaving(false);
        if (!result.ok) {
          setSaveNote({ ok: false, text: result.error });
          return;
        }
        if (result.value.snapshot !== undefined) applySnapshot(result.value.snapshot);
        setSaveNote({ ok: true, text: "已保存到 " + String(result.value.path ?? "") });
      };

      const runProbe = async () => {
        setProbing(true);
        setProbeError("");
        const result = await callApi("POST", "probe", {
          binDirs: parseBinDirs(binDirsText),
          cubeMxRoot: cubeMxRoot.trim(),
        });
        setProbing(false);
        if (!result.ok) {
          setProbeError(result.error);
          return;
        }
        setProbe(result.value.summary);
      };

      const runPlan = async () => {
        setPlanning(true);
        setPlanError("");
        setConfirmInstall(false);
        const result = await callApi("POST", "install/plan", {});
        setPlanning(false);
        if (!result.ok) {
          setPlanError(result.error);
          return;
        }
        setPlan(result.value.plan);
      };

      const startInstall = async () => {
        setStarting(true);
        setInstallError("");
        const body = { confirm: true, writePath: true };
        if (plan !== null && typeof plan === "object" && typeof plan.msys64 === "string" && plan.msys64 !== "") {
          body.targetDir = plan.msys64;
        }
        const result = await callApi("POST", "install/start", body);
        setStarting(false);
        setConfirmInstall(false);
        if (!result.ok) {
          setInstallError(result.error);
          return;
        }
        setInstallState(null);
        setTaskId(String(result.value.taskId ?? ""));
      };

      const configPath = snapshot !== null && typeof snapshot === "object" ? String(snapshot.path ?? "") : "";
      const configExists = snapshot !== null && typeof snapshot === "object" && snapshot.exists === true;
      const configDisabled = snapshot !== null && typeof snapshot === "object" && snapshot.readingDisabled === true;
      const configProblems = snapshot !== null && typeof snapshot === "object" && Array.isArray(snapshot.errors) ? snapshot.errors : [];

      const configCard = e(
        "section",
        { style: styles.card },
        e(
          "div",
          { style: styles.cardHead },
          e("h3", { style: styles.cardTitle }, "装在哪"),
          e("p", { style: styles.cardNote }, loadingConfig ? "读取配置中…" : configExists ? "配置文件已存在" : "还没有配置文件（保存时创建）"),
        ),
        e("p", { style: styles.mono }, configPath === "" ? "（配置路径未知）" : "配置： " + configPath),
        configDisabled
          ? e("p", { style: styles.muted }, "当前进程用 DSH_STM32_NO_CONFIG 关掉了配置读取，这里的保存仍然会写文件，但本次运行不会生效。")
          : null,
        configProblems.length === 0 ? null : e("p", { style: styles.error }, "配置里有问题：" + configProblems.join("；")),
        configError === "" ? null : e("p", { style: styles.error }, configError),
        e(
          "div",
          { style: styles.row },
          e("label", { style: styles.label, htmlFor: "dsh-stm32-msys64" }, "MSYS2 根"),
          e("input", {
            id: "dsh-stm32-msys64",
            style: styles.input,
            type: "text",
            value: msys64,
            spellCheck: false,
            placeholder: "例如 D:/app/msys64（空 = 不指定）",
            onChange: (event) => setMsys64(event.target.value),
          }),
        ),
        e(
          "div",
          { style: styles.row },
          e("label", { style: styles.label, htmlFor: "dsh-stm32-cubemx" }, "CubeMX 根"),
          e("input", {
            id: "dsh-stm32-cubemx",
            style: styles.input,
            type: "text",
            value: cubeMxRoot,
            spellCheck: false,
            placeholder: "例如 D:/app/STM32CubeMX（空 = 自动找）",
            onChange: (event) => setCubeMxRoot(event.target.value),
          }),
        ),
        e(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "4px" } },
          e("label", { style: { opacity: 0.8 }, htmlFor: "dsh-stm32-bindirs" }, "额外 bin 目录（每行一个，留空 = 用 MSYS2 推导 / 自动发现）"),
          e("textarea", {
            id: "dsh-stm32-bindirs",
            style: styles.textarea,
            value: binDirsText,
            spellCheck: false,
            placeholder: "D:/app/msys64/ucrt64/bin",
            onChange: (event) => setBinDirsText(event.target.value),
          }),
        ),
        e(
          "div",
          { style: styles.row },
          e("button", { type: "button", style: styles.buttonPrimary, disabled: saving, onClick: () => void save() }, saving ? "保存中…" : "保存配置"),
          saveNote === null ? null : e("p", { style: saveNote.ok ? styles.ok : styles.error }, String(saveNote.text)),
        ),
        e("p", { style: styles.cardNote }, "改完立即生效（插件每次自己读配置文件，不用重开 DSH）。"),
      );

      const tools = probe !== null && typeof probe === "object" && Array.isArray(probe.tools) ? probe.tools : [];
      const probeCard = e(
        "section",
        { style: styles.card },
        e(
          "div",
          { style: styles.cardHead },
          e("h3", { style: styles.cardTitle }, "缺什么"),
          e("p", { style: styles.cardNote }, "按上面三个框里的值探测；留空就走自动发现。"),
        ),
        e(
          "div",
          { style: styles.row },
          e("button", { type: "button", style: styles.button, disabled: probing, onClick: () => void runProbe() }, probing ? "探测中…" : "探测工具链"),
        ),
        probeError === "" ? null : e("p", { style: styles.error }, probeError),
        probe === null
          ? e("p", { style: styles.muted }, "还没探测过。探测会跑一次各工具的版本命令，不会装任何东西。")
          : e(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: "8px" } },
              e("p", { style: styles.note }, String(probe.message ?? "")),
              capabilityChips(probe.capabilities),
              e("ul", { style: styles.list }, tools.map((tool, index) => toolRow(tool, index))),
            ),
      );

      const planSteps = plan !== null && typeof plan === "object" ? plan.steps : null;
      const planDownload = plan !== null && typeof plan === "object" ? plan.download : null;
      const installLines =
        installState !== null && typeof installState === "object" && Array.isArray(installState.lines) ? installState.lines : [];
      const installSteps = installState !== null && typeof installState === "object" ? installState.steps : null;

      const installCard = e(
        "section",
        { style: styles.card },
        e(
          "div",
          { style: styles.cardHead },
          e("h3", { style: styles.cardTitle }, "装工具链"),
          e("p", { style: styles.cardNote }, "先出计划（不下载、不写盘），确认后才真装。"),
        ),
        e(
          "div",
          { style: styles.row },
          e("button", { type: "button", style: styles.button, disabled: planning, onClick: () => void runPlan() }, planning ? "算计划中…" : "出安装计划"),
          plan !== null && !confirmInstall && taskId === ""
            ? e("button", { type: "button", style: styles.buttonDanger, onClick: () => setConfirmInstall(true) }, "开始安装…")
            : null,
        ),
        planError === "" ? null : e("p", { style: styles.error }, planError),
        plan === null
          ? null
          : e(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: "8px" } },
              e("p", { style: styles.note }, String(plan.message ?? "")),
              // 没有可做的步骤时（工具链已完整）只留那一句话：不再画"目标/包/下载"与七行"已跳过"，
              // 否则一张"什么都不用装"的卡片看起来比要装的还长。
              Array.isArray(planSteps) && planSteps.length > 0
                ? e(
                    "p",
                    { style: styles.muted },
                    "目标：" + String(plan.msys64 ?? "（未知）") +
                      " · 包：" + (Array.isArray(plan.packages) ? plan.packages.join(" ") : "") +
                      " · 下载：" + formatBytes(planDownload !== null && typeof planDownload === "object" ? planDownload.bytes : 0) +
                      (planDownload !== null && typeof planDownload === "object" && planDownload.cached === true ? "（已缓存）" : ""),
                  )
                : null,
              Array.isArray(planSteps) && planSteps.length > 0 ? stepList(planSteps) : null,
              String(plan.nextStep ?? "") === "" ? null : e("p", { style: styles.muted }, "下一步：" + String(plan.nextStep)),
              Array.isArray(plan.notes) && plan.notes.length > 0
                ? e("ul", { style: styles.list }, plan.notes.map((note, index) => e("li", { key: index, style: styles.muted }, String(note))))
                : null,
            ),
        confirmInstall
          ? e(
              "div",
              { style: { ...styles.row, gap: "10px" } },
              e("p", { style: styles.note }, "确认在这台机器上真装？会下载安装包、解压到目标目录，需要几分钟。"),
              e("button", { type: "button", style: styles.buttonDanger, disabled: starting, onClick: () => void startInstall() }, starting ? "启动中…" : "确认安装"),
              e("button", { type: "button", style: styles.button, disabled: starting, onClick: () => setConfirmInstall(false) }, "取消"),
            )
          : null,
        installError === "" ? null : e("p", { style: styles.error }, installError),
        // 结果块用 installState 而不是 taskId 做判据：轮询结束时组件会清掉 taskId 去重读配置，
        // 只看 taskId 的话「安装成功 / 失败」会连同日志一起从面板上消失，用户看不到最终结论。
        taskId === "" && installState === null
          ? null
          : e(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: "8px" } },
              taskId === ""
                ? null
                : e(
                    "p",
                    { style: styles.muted },
                    "安装任务 " + taskId + " · " +
                      (installState !== null && typeof installState === "object" ? String(installState.status ?? "running") : "running"),
                  ),
              installState !== null && typeof installState === "object" && String(installState.message ?? "") !== ""
                ? e("p", { style: styles.note }, String(installState.message))
                : null,
              stepList(installSteps),
              installLines.length === 0
                ? null
                : e("pre", { style: styles.pre }, installLines.slice(-60).join("\n")),
            ),
      );

      return e(
        "div",
        { style: styles.root },
        e("h2", { style: styles.title }, "STM32 工具链"),
        e(
          "p",
          { style: styles.lead },
          "这里只负责「这台机器把工具装在哪、缺什么、怎么装」。工程本身的编译 / 烧录 / 调试仍走斜杠命令与工具，面板不碰你的工程。",
        ),
        configCard,
        probeCard,
        installCard,
      );
    }

    /* ------------------------------ 插件入口 ------------------------------ */

    /** 客户端插件只声明 slots（注册 settings.section 需要它）。 */
    const inject = ["slots"];

    function apply(ctx) {
      // ctx.effect 是宿主客户端插件 API：回调里返回的注销函数随插件 fiber 一起释放，
      // 面板卸载/热重载时不会在槽位账本里留下野条目。
      ctx.effect(
        () =>
          ctx.slots.inject("settings.section", () =>
            ctx.slots.register(
              {
                name: "settings.section",
                id: "stm32",
                order: 40,
                label: () => "STM32 工具链",
              },
              Stm32Section,
            ),
          ),
        "dsh-stm32: settings section",
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
