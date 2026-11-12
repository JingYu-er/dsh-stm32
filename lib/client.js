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
     * 注释放在包装外面会被当成"包装前有其他语句"，与 dsh-client-ui-* 的产物形状不一致。
     *
     * 为什么是纯 JS：本文件由宿主加载器直接执行，不经过插件的 TS 构建链；
     * 写成 TS/JSX 会多出一份由 tsc 决定产物路径的中间层，而面板的正确产物就是
     * client/client.js 原文（scripts/copy-client.mjs 将其原样复制到 lib/client.js）。
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
        // 极早的加载时机（document 还没就位）：退回根路径，避免面板整体失效。
        return "/dsh-stm32/api/" + path;
      }
    }

    /**
     * 调一次面板接口。返回值刻意统一成 { ok, value } / { ok:false, error }：
     * 面板上每个操作只需关心"是否成功、失败原因"，无需各自解析 HTTP 语义。
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
          e("h3", { style: styles.cardTitle }, "工具链路径配置"),
          e("p", { style: styles.cardNote }, loadingConfig ? "读取配置中…" : configExists ? "配置文件已加载" : "暂无配置文件，保存时自动生成"),
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
            placeholder: "示例：C:/msys64，留空表示不指定",
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
            placeholder: "示例：C:/STM32CubeMX，留空自动检索",
            onChange: (event) => setCubeMxRoot(event.target.value),
          }),
        ),
        e(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "4px" } },
          e("label", { style: { opacity: 0.8 }, htmlFor: "dsh-stm32-bindirs" }, "附加 Bin 目录（每行一条，留空将基于 MSYS2 自动推导）"),
          e("textarea", {
            id: "dsh-stm32-bindirs",
            style: styles.textarea,
            value: binDirsText,
            spellCheck: false,
            placeholder: "C:/msys64/ucrt64/bin",
            onChange: (event) => setBinDirsText(event.target.value),
          }),
        ),
        e(
          "div",
          { style: styles.row },
          e("button", { type: "button", style: styles.buttonPrimary, disabled: saving, onClick: () => void save() }, saving ? "保存中…" : "保存配置"),
          saveNote === null ? null : e("p", { style: saveNote.ok ? styles.ok : styles.error }, String(saveNote.text)),
        ),
        e("p", { style: styles.cardNote }, "配置修改后即时生效，无需重启 DSH。"),
      );

      const tools = probe !== null && typeof probe === "object" && Array.isArray(probe.tools) ? probe.tools : [];
      const probeCard = e(
        "section",
        { style: styles.card },
        e(
          "div",
          { style: styles.cardHead },
          e("h3", { style: styles.cardTitle }, "工具链探测"),
          e("p", { style: styles.cardNote }, "依据上方配置路径执行探测，路径留空时启用自动检索。"),
        ),
        e(
          "div",
          { style: styles.row },
          e("button", { type: "button", style: styles.button, disabled: probing, onClick: () => void runProbe() }, probing ? "探测中…" : "探测工具链"),
        ),
        probeError === "" ? null : e("p", { style: styles.error }, probeError),
        probe === null
          ? e("p", { style: styles.muted }, "尚未执行探测。探测仅读取工具版本信息，不会执行安装操作。")
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
          e("h3", { style: styles.cardTitle }, "工具链安装"),
          e("p", { style: styles.cardNote }, "首先生成安装方案（不会下载或写入文件），确认后再执行安装。"),
        ),
        e(
          "div",
          { style: styles.row },
          e("button", { type: "button", style: styles.button, disabled: planning, onClick: () => void runPlan() }, planning ?"生成方案中…" : "生成安装方案"),
          plan !== null && !confirmInstall && taskId === ""
            ? e("button", { type: "button", style: styles.buttonDanger, onClick: () => setConfirmInstall(true) }, "执行安装")
            : null,
        ),
        planError === "" ? null : e("p", { style: styles.error }, planError),
        plan === null
          ? null
          : e(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: "8px" } },
              e("p", { style: styles.note }, String(plan.message ?? "")),
              // 没有可做的步骤时（工具链已完整）仅保留该说明：不再画"目标/包/下载"与七行"已跳过"，
              // 否则一张"无需安装"的卡片会显得比需要安装的还长。
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
              e("p", { style: styles.note }, "在本机执行安装：系统将下载安装包并解压至目标目录，该过程需要数分钟。"),
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
                    "安装任务ID： " + taskId + " · " +
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
          "本面板仅管理本机 STM32 工具链的位置、缺失检测与安装流程。项目编译、烧录、调试请继续使用斜杠命令，面板不会修改用户工程文件。",
        ),
        configCard,
        probeCard,
        installCard,
      );
    }

    /* ------------------------------ 调试台 ------------------------------ */

    /*
     * 调试台（conversation.view 标签，id: stm32-debug）。
     *
     * 数据只有一个来源：宿主侧事件总线的 SSE 流 /dsh-stm32/api/events。
     * 面板自己不留第二份账本，重连时按 lastSeq 续播，断线不会丢段。
     *
     * 布局是停靠网格：左时间线、中详情、右通道，面板可收起进抽屉、可拖分隔条改宽，
     * 宽度与收起状态存 localStorage，下次打开保持原样。
     */

    const DEBUG_LAYOUT_KEY = "dsh-stm32.debug.layout.v1";
    const DEBUG_EVENT_CAP = 2000;
    const DEBUG_RECONNECT_MS = 1500;

    const debugStyles = {
      page: {
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: "420px",
        gap: "8px",
        padding: "10px 12px 12px",
        color: "inherit",
        fontSize: "12px",
        lineHeight: "1.5",
        boxSizing: "border-box",
      },
      statusBar: {
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "6px 10px",
        border: "1px solid color-mix(in srgb, currentColor 16%, transparent)",
        borderRadius: "8px",
        flexWrap: "wrap",
      },
      chip: {
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "1px 8px",
        borderRadius: "999px",
        border: "1px solid color-mix(in srgb, currentColor 20%, transparent)",
        opacity: 0.9,
      },
      dot: { width: "7px", height: "7px", borderRadius: "999px", background: "currentColor" },
      spacer: { flex: "1 1 auto" },
      grid: { display: "flex", flex: "1 1 auto", gap: "0", minHeight: "0" },
      panel: {
        display: "flex",
        flexDirection: "column",
        minWidth: "0",
        minHeight: "0",
        border: "1px solid color-mix(in srgb, currentColor 16%, transparent)",
        borderRadius: "8px",
        overflow: "hidden",
      },
      panelHead: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "5px 10px",
        borderBottom: "1px solid color-mix(in srgb, currentColor 12%, transparent)",
        fontWeight: 600,
        cursor: "default",
        userSelect: "none",
      },
      panelBody: { flex: "1 1 auto", overflow: "auto", minHeight: "0" },
      divider: {
        flex: "0 0 6px",
        cursor: "col-resize",
        background: "transparent",
        position: "relative",
      },
      row: {
        display: "flex",
        gap: "8px",
        padding: "4px 10px",
        cursor: "pointer",
        borderBottom: "1px solid color-mix(in srgb, currentColor 7%, transparent)",
        alignItems: "baseline",
      },
      rowTime: { opacity: 0.55, fontVariantNumeric: "tabular-nums", flex: "0 0 auto" },
      rowKind: { fontWeight: 600, flex: "0 0 auto", maxWidth: "132px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      rowText: { flex: "1 1 auto", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      empty: { padding: "16px 12px", opacity: 0.6 },
      mono: { fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontSize: "11px" },
      pre: {
        margin: 0,
        padding: "10px 12px",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
        fontSize: "11px",
        opacity: 0.9,
      },
      input: {
        padding: "3px 8px",
        font: "inherit",
        color: "inherit",
        background: "transparent",
        border: "1px solid color-mix(in srgb, currentColor 22%, transparent)",
        borderRadius: "6px",
        minWidth: "120px",
      },
      button: {
        padding: "2px 8px",
        font: "inherit",
        color: "inherit",
        background: "transparent",
        border: "1px solid color-mix(in srgb, currentColor 22%, transparent)",
        borderRadius: "6px",
        cursor: "pointer",
      },
      drawer: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "6px 10px",
        border: "1px dashed color-mix(in srgb, currentColor 20%, transparent)",
        borderRadius: "8px",
        flexWrap: "wrap",
      },
    };

    function debugStorage() {
      try {
        return typeof window === "object" && window !== null ? window.localStorage : null;
      } catch {
        return null;
      }
    }

    function readDebugLayout() {
      const store = debugStorage();
      const fallback = { left: 300, right: 300, collapsed: {} };
      if (store === null) return fallback;
      try {
        const raw = store.getItem(DEBUG_LAYOUT_KEY);
        if (raw === null) return fallback;
        const parsed = JSON.parse(raw);
        const left = Number(parsed.left);
        const right = Number(parsed.right);
        return {
          left: Number.isFinite(left) && left >= 180 ? Math.min(left, 720) : fallback.left,
          right: Number.isFinite(right) && right >= 180 ? Math.min(right, 720) : fallback.right,
          collapsed: parsed.collapsed !== null && typeof parsed.collapsed === "object" ? parsed.collapsed : {},
        };
      } catch {
        return fallback;
      }
    }

    function writeDebugLayout(layout) {
      const store = debugStorage();
      if (store === null) return;
      try {
        store.setItem(DEBUG_LAYOUT_KEY, JSON.stringify(layout));
      } catch {
        // 隐私模式或配额满：布局存不下不影响使用。
      }
    }

    function clockText(iso) {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return String(iso);
      const pad = (value, width) => String(value).padStart(width, "0");
      return pad(date.getHours(), 2) + ":" + pad(date.getMinutes(), 2) + ":" + pad(date.getSeconds(), 2) + "." + pad(date.getMilliseconds(), 3);
    }

    const DEBUG_STATUS_SIGN = { start: "▶", ok: "✔", fail: "✘", info: "·" };
    const DEBUG_LABELS = { timeline: "时间线", detail: "事件详情", channels: "实时通道", overview: "概览", pinout: "引脚", clocks: "时钟", interrupts: "中断", faults: "故障", artifacts: "产物", changes: "变更" };

    /** 一条事件的对话引用：单行，贴进对话后模型能对上调试台的序号。 */
    function eventRefLine(event) {
      return "- #" + String(event.seq) + " " + clockText(event.time) + " " + String(event.kind) + " " + String(event.status) + "：" + String(event.summary);
    }

    /** 多条事件的引用块：首行给条数，其余每行一条，顺序按传入顺序（时间线自上而下）。 */
    function eventRefBlock(events) {
      if (!Array.isArray(events) || events.length === 0) return "";
      return ["调试台事件（" + String(events.length) + " 条）："].concat(events.map(eventRefLine)).join("\n");
    }

    /** 事件流地址：带上会话键，多标签页同时开着时只收本会话的事件。 */
    function debugEventsPath(lastSeq, sessionId) {
      const since = "events?since=" + String(lastSeq);
      if (typeof sessionId !== "string" || sessionId === "") return since;
      return since + "&session=" + encodeURIComponent(sessionId);
    }

    /** SSE 订阅：首连只补发本会话快照，断线按 lastSeq 续播。 */
    function useDebugEvents(sessionId) {
      const [events, setEvents] = useState([]);
      const [connection, setConnection] = useState("connecting");
      useEffect(() => {
        let closed = false;
        let source = null;
        let timer = null;
        let lastSeq = 0;
        const scheduleReconnect = () => {
          if (closed) return;
          setConnection("retry");
          timer = setTimeout(connect, DEBUG_RECONNECT_MS);
        };
        const connect = () => {
          if (closed) return;
          if (typeof EventSource !== "function") {
            setConnection("unsupported");
            return;
          }
          setConnection(lastSeq === 0 ? "connecting" : "retry");
          source = new EventSource(apiUrl(debugEventsPath(lastSeq, sessionId)));
          source.onopen = () => {
            if (!closed) setConnection("open");
          };
          source.onmessage = (message) => {
            if (closed) return;
            let event;
            try {
              event = JSON.parse(message.data);
            } catch {
              return;
            }
            if (event === null || typeof event !== "object" || typeof event.seq !== "number") return;
            lastSeq = event.seq;
            setEvents((previous) => {
              const next = previous.concat([event]);
              return next.length > DEBUG_EVENT_CAP ? next.slice(next.length - DEBUG_EVENT_CAP) : next;
            });
          };
          source.onerror = () => {
            if (source !== null) source.close();
            source = null;
            scheduleReconnect();
          };
        };
        connect();
        return () => {
          closed = true;
          if (timer !== null) clearTimeout(timer);
          if (source !== null) source.close();
        };
      }, [sessionId]);
      return { events, connection };
    }

    function DebugPanel(props) {
      const header = e(
        "div",
        { style: debugStyles.panelHead },
        props.title,
        e("span", { style: debugStyles.spacer }),
        props.onCollapse === undefined
          ? null
          : e(
              "button",
              {
                style: debugStyles.button,
                title: "收起到抽屉",
                onClick: (event) => {
                  event.stopPropagation();
                  props.onCollapse();
                },
              },
              "–",
            ),
      );
      return e(
        "div",
        { style: Object.assign({}, debugStyles.panel, { flex: props.flex === undefined ? "1 1 auto" : props.flex }) },
        header,
        e("div", { style: debugStyles.panelBody }, props.children),
      );
    }

    function StatusBar(props) {
      const connectionText = {
        connecting: "连接中",
        open: "已连接",
        retry: "重连中",
        unsupported: "浏览器不支持事件流",
      }[props.connection] ?? props.connection;
      const lastEvent = props.events.length === 0 ? null : props.events[props.events.length - 1];
      return e(
        "div",
        { style: debugStyles.statusBar },
        e("strong", null, "调试台"),
        e("span", { style: debugStyles.chip }, e("span", { style: debugStyles.dot }), connectionText),
        e("span", { style: debugStyles.chip }, "事件 " + String(props.events.length)),
        lastEvent === null
          ? null
          : e("span", { style: debugStyles.chip }, "序号 " + String(lastEvent.seq)),
        props.status === null || props.status === undefined
          ? null
          : e(
              "span",
              {
                style: Object.assign({}, debugStyles.chip, { maxWidth: "320px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }),
                title: String(props.status.evidenceRoot) + (props.status.evidenceOverride === true ? "（由 DSH_STM32_EVIDENCE 覆盖）" : ""),
              },
              "证据 " + String(props.status.evidenceRoot),
            ),
        e("span", { style: debugStyles.spacer }),
        e("span", { style: { opacity: 0.6 } }, "本页只读；事件自动落盘到证据目录"),
      );
    }

    function Timeline(props) {
      const body = props.events.length === 0
        ? e("div", { style: debugStyles.empty }, props.connection === "open" ? "尚无事件。调用任一 stm32_* 工具后在此出现。" : "等待事件流连接。")
        : props.events.map((event) =>
            e(
              "div",
              {
                key: String(event.seq),
                style: Object.assign(
                  {},
                  debugStyles.row,
                  (props.selectedSeq === event.seq ? { background: "color-mix(in srgb, currentColor 8%, transparent)" } : {}),
                  props.pickedSet && props.pickedSet.has(event.seq) ? { outline: "1px solid color-mix(in srgb, currentColor 35%, transparent)" } : {},
                ),
                onClick: () => props.onSelect(event),
              },
              e("input", {
                type: "checkbox",
                checked: props.pickedSet ? props.pickedSet.has(event.seq) : false,
                title: "勾选后可以批量复制引用",
                style: { margin: "0 2px 0 0" },
                onClick: (ev) => {
                  if (typeof ev.stopPropagation === "function") ev.stopPropagation();
                },
                onChange: () => props.onPick(event),
              }),
              e("span", { style: debugStyles.rowTime }, clockText(event.time)),
              e("span", { style: debugStyles.rowKind }, (DEBUG_STATUS_SIGN[event.status] ?? "·") + " " + String(event.kind)),
              e("span", { style: debugStyles.rowText, title: String(event.summary) }, String(event.summary)),
            ),
          );
      return e(DebugPanel, { title: DEBUG_LABELS.timeline, flex: "1 1 0", onCollapse: props.onCollapse }, body);
    }

    /** 编译错误列表：每条可点开源码上下文；解析不出「文件:行:列」的按纯文本列出。 */
    function CompileErrors(props) {
      const errors = Array.isArray(props.errors) ? props.errors : [];
      const [picked, setPicked] = useState(null);
      const [slice, setSlice] = useState(null);
      const [error, setError] = useState("");
      if (errors.length === 0) return null;
      const open = async (index, parsed) => {
        if (parsed === null) return;
        setPicked(index);
        setError("");
        const result = await fetchSource(props.projectDir, parsed.file, parsed.line, 2);
        if (result.ok) setSlice(result.value.source);
        else {
          setSlice(null);
          setError(String(result.error ?? "读取源码失败"));
        }
      };
      return e(
        "div",
        { style: { padding: "0 12px 8px", display: "flex", flexDirection: "column", gap: "2px" } },
        e("div", { style: { opacity: 0.65 } }, "编译错误（" + String(errors.length) + "）"),
        errors.map((line, index) => {
          const parsed = parseCompileError(line);
          return e(
            "div",
            {
              key: String(index),
              style: {
                fontFamily: "ui-monospace, monospace",
                fontSize: "11px",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                cursor: parsed === null ? "default" : "pointer",
                opacity: picked === index ? 0.95 : 0.8,
              },
              title: parsed === null ? String(line) : "点击看源码：" + parsed.file + ":" + String(parsed.line),
              onClick: () => open(index, parsed),
            },
            String(line),
          );
        }),
        error === "" ? null : e("div", { style: { fontSize: "11px", opacity: 0.7 } }, error),
        e(SourceBlock, { slice: slice }),
      );
    }

    function Detail(props) {
      const event = props.event;
      if (event === null) {
        return e(DebugPanel, { title: DEBUG_LABELS.detail, onCollapse: props.onCollapse }, e("div", { style: debugStyles.empty }, "在左侧选择一条事件查看参数与结果。"));
      }
      const refs = Array.isArray(event.refs) && event.refs.length > 0
        ? e(
            "div",
            { style: { padding: "0 12px 10px" } },
            e("div", { style: { opacity: 0.65, marginBottom: "4px" } }, "关联"),
            event.refs.map((ref, index) =>
              e("div", { key: String(index), style: debugStyles.mono }, [ref.file, ref.line === undefined ? "" : ":" + String(ref.line), ref.hash === undefined ? "" : " #" + String(ref.hash).slice(0, 12)].join("")),
            ),
          )
        : null;
      const payloadText =
        event.payload === undefined || event.payload === null ? "" : JSON.stringify(event.payload, null, 2);
      const copyPayload = () => {
        if (payloadText === "") return;
        const clipboard = typeof navigator === "object" && navigator !== null ? navigator.clipboard : null;
        if (clipboard !== null && clipboard !== undefined && typeof clipboard.writeText === "function") {
          clipboard.writeText(payloadText).catch(() => undefined);
        }
      };
      const copyRef = () => {
        const text = "[调试台事件 #" + String(event.seq) + "] " + String(event.kind) + " " + String(event.status) + "：" + String(event.summary);
        const clipboard = typeof navigator === "object" && navigator !== null ? navigator.clipboard : null;
        if (clipboard !== null && clipboard !== undefined && typeof clipboard.writeText === "function") {
          clipboard.writeText(text).catch(() => undefined);
        }
      };
      return e(
        DebugPanel,
        { title: DEBUG_LABELS.detail, onCollapse: props.onCollapse },
        e(
          "div",
          { style: { padding: "10px 12px 6px", display: "flex", flexDirection: "column", gap: "4px" } },
          e("div", null, "序号 " + String(event.seq) + " · " + clockText(event.time) + " · " + String(event.kind)),
          e("div", null, "来源 " + String(event.source) + " · 状态 " + String(event.status)),
          e("div", { style: { opacity: 0.85 } }, String(event.summary)),
          event.truncated === true ? e("div", { style: { opacity: 0.65 } }, "payload 超过上限，仅保留预览。") : null,
        ),
        refs,
        e(CompileErrors, {
          errors: event.payload !== null && typeof event.payload === "object" && event.payload.result !== null && typeof event.payload.result === "object" ? event.payload.result.errors : undefined,
          projectDir: event.payload !== null && typeof event.payload === "object" && event.payload.result !== null && typeof event.payload.result === "object" && typeof event.payload.result.projectDir === "string" ? event.payload.result.projectDir : (typeof props.projectDir === "string" ? props.projectDir : ""),
        }),
        payloadText === ""
          ? null
          : e(
              "div",
              { style: { padding: "0 12px 8px" } },
              e("div", { style: { opacity: 0.65, marginBottom: "4px" } }, "参数与结果"),
              e(
                "pre",
                {
                  style: {
                    margin: 0,
                    padding: "6px 8px",
                    maxHeight: "200px",
                    overflow: "auto",
                    fontSize: "11px",
                    lineHeight: "1.45",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
                    borderRadius: "4px",
                  },
                },
                payloadText,
              ),
            ),
        e(
          "div",
          { style: { padding: "0 12px 8px", display: "flex", gap: "6px", flexWrap: "wrap" } },
          e("button", { style: debugStyles.button, onClick: copyRef }, "复制引用（贴到对话里）"),
          payloadText === "" ? null : e("button", { style: debugStyles.button, onClick: copyPayload }, "复制 payload"),
        ),
        e("pre", { style: debugStyles.pre }, event.payload === undefined ? "（无 payload）" : JSON.stringify(event.payload, null, 2)),
      );
    }

    /** 会话卡一行：名称与值左右对齐。 */
    function metaRow(label, value) {
      return e(
        "div",
        { style: { display: "flex", gap: "8px", alignItems: "baseline" } },
        e("span", { style: { opacity: 0.6, flex: "0 0 auto" } }, label),
        e("span", { style: { flex: "1 1 auto", wordBreak: "break-all" } }, value),
      );
    }

    /** 调试会话状态：面板里与「当前会话」相关的块共用一次轮询。 */
    function useDebugStatus(intervalMs) {
      const [debug, setDebug] = useState(null);
      const [error, setError] = useState("");
      const [tick, setTick] = useState(0);
      useEffect(() => {
        let closed = false;
        const load = async () => {
          const result = await callApi("GET", "debug");
          if (closed) return;
          if (result.ok) {
            setDebug(result.value.debug);
            setError("");
          } else {
            setError(result.error);
          }
        };
        load();
        const timer = setInterval(load, intervalMs);
        return () => {
          closed = true;
          clearInterval(timer);
        };
      }, [tick]);
      return { debug, error, reload: () => setTick((value) => value + 1) };
    }

    /** 调试会话摘要：只读呈现 /debug 的结果，不触发探针动作。 */
    function SessionCard(props) {
      const debug = props.debug ?? null;
      const error = props.error ?? "";
      const quota = (value) => (value !== null && typeof value === "object" && value.used !== undefined ? String(value.used) + "/" + String(value.budget) : "—");
      const body = [];
      if (error !== "") {
        body.push(e("div", { key: "error", style: { opacity: 0.7 } }, "读取调试会话失败：" + error));
      } else if (debug === null) {
        body.push(e("div", { key: "loading", style: { opacity: 0.6 } }, "读取调试会话…"));
      } else if (debug.active !== true) {
        body.push(e("div", { key: "idle", style: { opacity: 0.7 } }, "当前没有调试会话（探针空闲）。"));
      } else {
        body.push(metaRow("状态", "进行中 · 剩余 " + String(Math.ceil(Number(debug.remainingMs) / 1000)) + " s"));
        body.push(metaRow("会话", String(debug.sessionId)));
        body.push(metaRow("端口", "gdb " + String(debug.port) + " · tcl " + String(debug.tclPort)));
        body.push(metaRow("工程", String(debug.projectDir)));
        body.push(metaRow("符号", String(debug.elfPath)));
        body.push(metaRow("断点", quota(debug.breakpoints)));
        body.push(metaRow("观察点", quota(debug.watchpoints)));
        body.push(
          e(
            "div",
            { key: "touch", style: { display: "flex", alignItems: "center", gap: "6px" } },
            e(
              "button",
              {
                style: debugStyles.button,
                title: "重置空闲计时，总时长上限不变",
                onClick: () => props.onTouch?.(),
              },
              "续期",
            ),
            props.touchMessage === ""
              ? null
              : e("span", { style: { opacity: 0.6, fontSize: "11px" } }, props.touchMessage),
          ),
        );
      }
      return e(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: "4px",
            padding: "6px 10px",
            borderBottom: "1px solid color-mix(in srgb, currentColor 8%, transparent)",
            fontSize: "12px",
          },
        },
        body,
      );
    }

    /** 读一段源码：给断点命中与编译错误共用，只读，越界由服务端拒绝。 */
    async function fetchSource(projectDir, file, line, context) {
      return callApi(
        "GET",
        "source?projectDir=" + encodeURIComponent(projectDir) +
          "&file=" + encodeURIComponent(file) +
          "&line=" + String(line) +
          "&context=" + String(context ?? 3),
      );
    }

    /** 源码片段：行号在左，焦点行加底色。 */
    function SourceBlock(props) {
      const slice = props.slice;
      if (slice === null || slice === undefined) return null;
      return e(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "1px", paddingTop: "2px" } },
        e(
          "div",
          { style: { fontSize: "11px", opacity: 0.7, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: slice.file },
          slice.file + ":" + String(slice.line) + "（共 " + String(slice.totalLines) + " 行）",
        ),
        slice.lines.map((item) =>
          e(
            "div",
            {
              key: String(item.line),
              style: {
                display: "flex",
                gap: "6px",
                fontFamily: "ui-monospace, monospace",
                fontSize: "11px",
                whiteSpace: "pre",
                overflow: "hidden",
                background: item.line === slice.line ? "color-mix(in srgb, currentColor 10%, transparent)" : "transparent",
              },
            },
            e("span", { style: { flex: "0 0 34px", textAlign: "right", opacity: 0.5 } }, String(item.line)),
            e("span", { style: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis" } }, item.text),
          ),
        ),
      );
    }

    /**
     * 从 gcc 的报错里取「文件:行:列」。
     *
     * 常见形状：`Core/Src/main.c:67:5: error: 'x' undeclared`；
     * 也有 `core/Src/main.c: In function 'main':` 这种无行号的，返回 null。
     */
    function parseCompileError(line) {
      const match = /^\s*(.+?):(\d+):(\d+):\s*(.*)$/u.exec(String(line ?? ""));
      if (match === null) return null;
      return { file: match[1], line: Number.parseInt(match[2], 10), column: Number.parseInt(match[3], 10), message: match[4] };
    }

    /**
     * 从 gdb 的停点文本里取「文件:行」。
     *
     * 真实文本形如 `Breakpoint 2 at 0x8000314: file stm32f1xx_hal.c, line 373.` 或
     * `... stm32f1xx_hal.c:373`；从右往左找最后一个「带扩展名:数字」，避免把地址当成行号。
     */
    function parseHitLocation(text) {
      const source = String(text ?? "");
      const pattern = /([A-Za-z0-9_.\/-]+\.(?:c|h|cc|cpp|hpp|s|S))(?::|, line )(\d+)/gu;
      let found = null;
      let match = pattern.exec(source);
      while (match !== null) {
        found = { file: match[1], line: Number.parseInt(match[2], 10) };
        match = pattern.exec(source);
      }
      return found;
    }

    /** 断点面板：只发 add / remove / list 三种动作，location 与 id 由服务端再校验一遍。 */
    function BreakpointPanel(props) {
      const active = props.debug !== null && typeof props.debug === "object" && props.debug.active === true;
      const [location, setLocation] = useState("");
      const [removeId, setRemoveId] = useState("");
      const [output, setOutput] = useState("");
      const [busy, setBusy] = useState(false);
      const [slice, setSlice] = useState(null);
      const [sliceError, setSliceError] = useState("");
      const hits = Array.isArray(props.debug?.hits) ? props.debug.hits.slice().reverse() : [];
      const projectDir = typeof props.debug?.projectDir === "string" ? props.debug.projectDir : "";
      const openHit = async (hit) => {
        const at = parseHitLocation(hit.text);
        if (at === null) {
          setSliceError("这条停点里没有源码位置。");
          setSlice(null);
          return;
        }
        setSliceError("");
        const result = await callApi(
          "GET",
          "source?projectDir=" + encodeURIComponent(projectDir) +
            "&file=" + encodeURIComponent(at.file) +
            "&line=" + String(at.line) +
            "&context=3",
        );
        if (result.ok) setSlice(result.value.source);
        else {
          setSlice(null);
          setSliceError(String(result.error ?? "读取源码失败"));
        }
      };
      const run = async (body) => {
        if (busy) return;
        setBusy(true);
        const result = await callApi("POST", "debug/breakpoints", body);
        setBusy(false);
        if (result.ok) {
          const payload = result.value.breakpoints;
          const text = String(payload.output ?? "").trim();
          setOutput(text === "" ? String(payload.message ?? "") : text);
          if (typeof props.onChanged === "function") props.onChanged();
        } else {
          setOutput(String(result.error ?? "请求失败"));
        }
      };
      const disabled = busy === true || active !== true;
      const button = (label, onClick) => e("button", { style: debugStyles.button, disabled, onClick }, label);
      return e(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: "4px",
            padding: "6px 10px",
            borderBottom: "1px solid color-mix(in srgb, currentColor 8%, transparent)",
            fontSize: "12px",
          },
        },
        e(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "6px" } },
          e("strong", null, "断点"),
          e("span", { style: { opacity: 0.55 } }, active ? "会话进行中" : "无会话"),
          e("span", { style: debugStyles.spacer }),
          button("列出", () => run({ action: "list" })),
        ),
        e(
          "div",
          { style: { display: "flex", gap: "6px" } },
          e("input", {
            style: Object.assign({}, debugStyles.input, { flex: "1 1 auto" }),
            placeholder: "符号名或 文件:行，例如 main",
            value: location,
            onChange: (event) => setLocation(event.target.value),
          }),
          button("添加", () => run({ action: "add", location: location.trim() })),
        ),
        e(
          "div",
          { style: { display: "flex", gap: "6px" } },
          e("input", {
            style: Object.assign({}, debugStyles.input, { flex: "0 0 90px" }),
            placeholder: "编号",
            value: removeId,
            onChange: (event) => setRemoveId(event.target.value),
          }),
          button("移除", () => run({ action: "remove", id: Number(removeId) })),
        ),
        output === ""
          ? null
          : e("pre", { style: Object.assign({}, debugStyles.pre, { padding: 0, maxHeight: "140px", overflow: "auto" }) }, output),
        e("div", { style: { display: "flex", alignItems: "center", gap: "6px", opacity: 0.7 } }, "命中历史（" + String(hits.length) + "）"),
        hits.length === 0
          ? e("div", { style: { fontSize: "11px", opacity: 0.5 } }, "还没有停点记录：跑一次 continue / next 后这里会出现停在哪。")
          : hits.map((hit) =>
              e(
                "div",
                {
                  key: String(hit.time) + ":" + String(hit.id) + ":" + hit.text,
                  style: { fontFamily: "ui-monospace, monospace", fontSize: "11px", opacity: 0.8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer" },
                  title: "点击看源码上下文：" + hit.text,
                  onClick: () => openHit(hit),
                },
                clockText(hit.time) + "  #" + String(hit.id) + "  " + hit.text,
              ),
            ),
        sliceError === ""
          ? null
          : e("div", { style: { fontSize: "11px", opacity: 0.7 } }, sliceError),
        e(SourceBlock, { slice: slice }),
      );
    }

    const WATCH_POINT_LIMIT = 120;

    /** 从 channel:watch 事件的结构化样本里取数字序列，按表达式分桶。 */
    function collectWatchSeries(events) {
      const series = {};
      for (const event of events) {
        if (event.kind !== "channel:watch") continue;
        const payload = event.payload !== null && typeof event.payload === "object" ? event.payload : null;
        const meta = payload !== null && payload.meta !== null && typeof payload.meta === "object" ? payload.meta : null;
        const samples = meta !== null && Array.isArray(meta.samples) ? meta.samples : [];
        for (const sample of samples) {
          if (sample === null || typeof sample !== "object" || sample.ok !== true) continue;
          const numeric = Number(String(sample.value).trim());
          if (!Number.isFinite(numeric)) continue;
          const key = String(sample.expression);
          if (series[key] === undefined) series[key] = [];
          series[key].push(numeric);
          if (series[key].length > WATCH_POINT_LIMIT) series[key].shift();
        }
      }
      return series;
    }

    /** 采样序列折线：宽度固定，纵向按本次序列的最小最大值铺满。 */
    function sparklinePath(values, width, height) {
      const min = Math.min(...values);
      const max = Math.max(...values);
      const span = max - min === 0 ? 1 : max - min;
      const step = values.length > 1 ? width / (values.length - 1) : 0;
      return values
        .map((value, index) => {
          const x = values.length > 1 ? index * step : width / 2;
          const y = height - 1 - ((value - min) / span) * (height - 2);
          return (index === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1);
        })
        .join(" ");
    }

    /** 监视历史曲线：数值采样画走势；结构体、指针等非数值只留在通道行里。 */
    function WatchCurves(props) {
      const series = collectWatchSeries(props.events);
      const keys = Object.keys(series).sort();
      const recording = props.recording ?? null;
      const header = e(
        "div",
        { style: { display: "flex", alignItems: "center", gap: "8px", padding: "6px 10px" } },
        e("span", { style: { flex: "1 1 auto", fontSize: "12px" } }, "监视采样"),
        e(
          "span",
          { style: { fontSize: "11px", opacity: 0.6 }, title: recording?.lastError ?? "" },
          recording?.active === true ? "自动采样中 · 每 " + String(recording.intervalMs) + " ms" : "手动",
        ),
        e(
          "button",
          {
            type: "button",
            onClick: recording?.active === true ? props.onStop : props.onStart,
            style: { fontSize: "11px", padding: "1px 8px" },
          },
          recording?.active === true ? "停止" : "自动采样",
        ),
      );
      if (keys.length === 0) {
        return e(
          "div",
          { style: { padding: "0 0 6px 0" } },
          header,
          e("div", { style: { padding: "0 10px 6px 10px", opacity: 0.55, fontSize: "12px" } }, "暂无数值型监视采样。"),
        );
      }
      return e(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: "4px",
            padding: "0 0 6px 0",
            borderBottom: "1px solid color-mix(in srgb, currentColor 8%, transparent)",
            fontSize: "12px",
          },
        },
        header,
        keys.map((key) => {
          const values = series[key];
          const last = values[values.length - 1];
          const min = Math.min(...values);
          const max = Math.max(...values);
          return e(
            "div",
            { key: key, style: { display: "flex", alignItems: "center", gap: "8px" } },
            e("span", { title: key, style: { flex: "0 0 40%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, key),
            e(
              "svg",
              { width: 110, height: 26, viewBox: "0 0 110 26", style: { flex: "0 0 auto", opacity: 0.9 } },
              e("path", { d: sparklinePath(values, 110, 26), fill: "none", stroke: "currentColor", strokeWidth: 1.2 }),
            ),
            e(
              "span",
              { style: { flex: "1 1 auto", textAlign: "right", fontVariantNumeric: "tabular-nums" } },
              String(last) + "（" + String(values.length) + " 点，" + String(min) + "…" + String(max) + "）",
            ),
          );
        }),
      );
    }

    /** 引脚表：读工程 .ioc 的分组结果；切到引脚标签时立即拉一次，之后 10 秒刷新。 */
    function usePinout(projectDir, intervalMs) {
      const [pinout, setPinout] = useState(null);
      const [error, setError] = useState("");
      const [tick, setTick] = useState(0);
      useEffect(() => {
        let closed = false;
        if (typeof projectDir !== "string" || projectDir === "") {
          setPinout(null);
          setError("");
          return () => {
            closed = true;
          };
        }
        const load = async () => {
          const result = await callApi("GET", "pinout?projectDir=" + encodeURIComponent(projectDir));
          if (closed) return;
          if (result.ok) {
            setPinout(result.value.pinout);
            setError("");
          } else {
            setError(result.error);
          }
        };
        load();
        const timer = setInterval(load, intervalMs);
        return () => {
          closed = true;
          clearInterval(timer);
        };
      }, [projectDir, tick]);
      return { pinout, error, reload: () => setTick((value) => value + 1) };
    }

    /** .ioc 与生成代码是否同步：只读两个文件的修改时间，不跑 CubeMX。 */
    function useIocSync(projectDir, intervalMs) {
      const [sync, setSync] = useState(null);
      useEffect(() => {
        let closed = false;
        if (typeof projectDir !== "string" || projectDir === "") {
          setSync(null);
          return () => {
            closed = true;
          };
        }
        const load = async () => {
          const result = await callApi("GET", "ioc-sync?projectDir=" + encodeURIComponent(projectDir));
          if (closed) return;
          setSync(result.ok ? result.value.iocSync : null);
        };
        load();
        const timer = setInterval(load, intervalMs);
        return () => {
          closed = true;
          clearInterval(timer);
        };
      }, [projectDir]);
      return sync;
    }

    /** 监视登记表：与 stm32_watch 共用同一份状态，面板加一项下一次 sample 就读到它。 */
    function useWatches(intervalMs) {
      const [watch, setWatch] = useState(null);
      const [error, setError] = useState("");
      const [tick, setTick] = useState(0);
      useEffect(() => {
        let closed = false;
        const load = async () => {
          const result = await callApi("GET", "watch");
          if (closed) return;
          if (result.ok) {
            setWatch(result.value.watch);
            setError("");
          } else {
            setError(result.error);
          }
        };
        load();
        const timer = setInterval(load, intervalMs);
        return () => {
          closed = true;
          clearInterval(timer);
        };
      }, [tick]);
      return { watch, error, reload: () => setTick((value) => value + 1) };
    }

    const WATCH_KIND_OPTIONS = [
      { key: "value", label: "值采样" },
      { key: "write", label: "写观察点" },
      { key: "read", label: "读观察点" },
      { key: "access", label: "读写观察点" },
    ];

    /** 监视登记表：表达式、类型、最近一次的值，可加可删。 */
    function WatchAdmin(props) {
      const state = useWatches(5000);
      const [expression, setExpression] = useState("");
      const [kind, setKind] = useState("value");
      const [note, setNote] = useState("");
      const post = async (body) => {
        const result = await callApi("POST", "watch", body);
        if (!result.ok) setNote(result.error);
        else {
          setNote(result.value?.watch?.message ?? "");
          state.reload();
        }
      };
      const add = () => {
        const text = expression.trim();
        if (text === "") return;
        post({ action: "add", kind: kind, expressions: [text] }).then(() => setExpression(""));
      };
      const entries = state.watch?.entries ?? [];
      const head = e(
        "div",
        { style: { display: "flex", alignItems: "center", gap: "6px", padding: "6px 10px 2px" } },
        e("span", { style: { flex: "1 1 auto", fontSize: "12px" } }, "监视登记表"),
        e(
          "span",
          { style: { fontSize: "11px", opacity: 0.6 }, title: state.watch === null ? state.error : "" },
          "观察点 " + String(state.watch?.budget?.used ?? 0) + "/" + String(state.watch?.budget?.limit ?? 0),
        ),
        e("button", { type: "button", onClick: () => post({ action: "clear" }), style: { fontSize: "11px", padding: "1px 8px" } }, "清空"),
      );
      const rows = entries.map((entry) =>
        e(
          "div",
          { key: String(entry.id), style: { display: "flex", alignItems: "center", gap: "6px", padding: "1px 10px", fontSize: "12px" } },
          e("span", { style: { flex: "0 0 6%", opacity: 0.55, fontVariantNumeric: "tabular-nums" } }, "#" + String(entry.id)),
          e("span", { style: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: entry.lastError }, entry.expression),
          e("span", { style: { flex: "0 0 auto", opacity: 0.6 } }, entry.kindLabel),
          e("span", { style: { flex: "0 0 22%", textAlign: "right", opacity: 0.8, fontVariantNumeric: "tabular-nums" } }, entry.lastValue === "" ? "—" : entry.lastValue),
          e("button", { type: "button", onClick: () => post({ action: "remove", ids: [entry.id] }), style: { fontSize: "11px", padding: "0 6px" } }, "移除"),
        ),
      );
      const form = e(
        "div",
        { style: { display: "flex", gap: "6px", padding: "4px 10px 6px" } },
        e("input", {
          value: expression,
          placeholder: "表达式，例如 g_tick_1k 或 *(unsigned int *)0x4001100C",
          onChange: (event) => setExpression(event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Enter") add();
          },
          style: Object.assign({}, debugStyles.input, { flex: "1 1 auto" }),
        }),
        e(
          "select",
          { value: kind, onChange: (event) => setKind(event.target.value), style: { fontSize: "11px" } },
          WATCH_KIND_OPTIONS.map((option) => e("option", { key: option.key, value: option.key }, option.label)),
        ),
        e("button", { type: "button", onClick: add, style: { fontSize: "11px", padding: "1px 8px" } }, "添加"),
      );
      return e(
        "div",
        { style: { padding: "0 0 4px 0", borderBottom: "1px solid color-mix(in srgb, currentColor 8%, transparent)" } },
        head,
        entries.length === 0 ? e("div", { style: { padding: "0 10px 4px", fontSize: "12px", opacity: 0.55 } }, "登记表是空的：加一个表达式后，下一次采样会出现在曲线里。") : rows,
        form,
        note === "" ? null : e("div", { style: { padding: "0 10px 4px", fontSize: "11px", opacity: 0.7 } }, note),
      );
    }

    const PIN_KIND_LABEL = { gpio: "GPIO", debug: "调试", clock: "时钟", virtual: "虚拟", other: "其它" };

    function PinRow(props) {
      const pin = props.pin;
      const parts = [];
      if (pin.label !== "") parts.push("标号 " + pin.label);
      if (pin.mode !== "") parts.push(pin.mode);
      if (pin.signal !== "") parts.push(pin.signal);
      return e(
        "div",
        { style: { display: "flex", gap: "8px", padding: "1px 0", fontSize: "12px" } },
        e("span", { style: { flex: "0 0 26%", fontVariantNumeric: "tabular-nums" } }, pin.pin),
        e(
          "span",
          { style: { flex: "1 1 auto", opacity: 0.8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: parts.join(" · ") },
          parts.join(" · ") === "" ? "（未配置）" : parts.join(" · "),
        ),
        e("span", { style: { flex: "0 0 auto", opacity: 0.55 } }, PIN_KIND_LABEL[pin.kind] ?? pin.kind),
        pin.locked === true ? e("span", { style: { flex: "0 0 auto", opacity: 0.55 }, title: "在 CubeMX 里锁定" }, "锁") : null,
      );
    }

    /** 引脚面板：芯片、时钟与按外设分组的引脚表。只读 .ioc，不触发 CubeMX。 */
    function PinoutPanel(props) {
      const projectDir = typeof props.projectDir === "string" ? props.projectDir : "";
      const state = usePinout(projectDir, 10000);
      const sync = useIocSync(projectDir, 10000);
      const pinout = state.pinout;
      const [copiedPin, setCopiedPin] = useState("");
      const copyPin = async (pin) => {
        const text = pin.signal === "" ? pin.pin : pin.pin + " " + pin.signal;
        try {
          await navigator.clipboard.writeText(text);
          setCopiedPin(pin.pin);
        } catch {
          setCopiedPin("");
        }
      };
      const head = [];
      if (projectDir === "") {
        head.push(e("div", { key: "no-project", style: { padding: "6px 0", opacity: 0.6 } }, "当前没有可用的工程目录；先打开调试会话或建工程。"));
      } else if (state.error !== "") {
        head.push(e("div", { key: "error", style: { padding: "6px 0", opacity: 0.75 } }, state.error));
      } else if (pinout === null) {
        head.push(e("div", { key: "loading", style: { padding: "6px 0", opacity: 0.6 } }, "读取引脚表…"));
      } else {
        const clocks = pinout.clocks ?? {};
        const mhz = (hz) => (typeof hz === "number" && hz > 0 ? String(Math.round(hz / 1000000)) + " MHz" : "—");
        head.push(
          e("div", { key: "head", style: { padding: "4px 0 6px", display: "flex", flexWrap: "wrap", gap: "10px", fontSize: "12px", opacity: 0.85 } },
            e("span", null, pinout.mcu?.cpn || "未知型号"),
            e("span", null, "SYSCLK " + mhz(clocks.sysclkHz)),
            e("span", null, "APB1 " + mhz(clocks.apb1Hz)),
            e("span", null, "APB2 " + mhz(clocks.apb2Hz)),
            e("span", null, "中断 " + String(pinout.nvicCount ?? 0)),
            e("span", null, "引脚 " + String((pinout.pins ?? []).length)),
            (pinout.debug?.serialWire ?? false) ? e("span", { title: "SWD 可用于烧录与调试" }, "SWD 开") : e("span", { style: { opacity: 0.9 } }, "SWD 关"),
            e("span", { style: { opacity: 0.55 }, title: "复制形如 PA9 USART1_TX 的引用，可直接贴进对话" }, "点行复制引用"),
            sync === null
              ? null
              : e("span", { title: sync.message, style: sync.stale === true ? { color: "#e8b339" } : { opacity: 0.7 } },
                  sync.stale === true ? "待重新生成" : "已同步"),
          ),
        );
        const warnings = pinout.warnings ?? [];
        if (warnings.length > 0) {
          head.push(
            e("div", { key: "warn", style: { padding: "2px 0 6px", fontSize: "12px", opacity: 0.8 } },
              warnings.slice(0, 3).map((warning, index) => e("div", { key: "w" + String(index) }, "注意：" + warning)),
            ),
          );
        }
      }
      const groups = pinout === null || state.error !== "" ? [] : (pinout.groups ?? []);
      return e(
        "div",
        { style: { display: "flex", flexDirection: "column", padding: "0 10px 8px" } },
        head,
        groups.map((group) =>
          e(
            "div",
            { key: group.name, style: { padding: "4px 0", borderTop: "1px solid color-mix(in srgb, currentColor 8%, transparent)" } },
            e(
              "div",
              { style: { fontSize: "12px", opacity: 0.7, paddingBottom: "2px" } },
              group.name + "（" + String(group.pins.length) + "）",
            ),
            group.pins.map((pin) =>
              e(PinRow, { key: pin.pin + ":" + pin.signal, pin: pin, copied: copiedPin === pin.pin, onCopy: copyPin }),
            ),
          ),
        ),
      );
    }

    /** 中断表：读 .ioc 的 NVIC.*，只显示使能状态与两级优先级。 */
    function useInterrupts(projectDir, intervalMs) {
      const [report, setReport] = useState(null);
      const [error, setError] = useState("");
      useEffect(() => {
        let closed = false;
        const load = async () => {
          const result = await callApi("GET", "interrupts?projectDir=" + encodeURIComponent(projectDir));
          if (closed) return;
          if (result.ok) {
            setReport(result.value.interrupts);
            setError("");
          } else {
            setError(result.error);
          }
        };
        load();
        const timer = setInterval(load, intervalMs);
        return () => {
          closed = true;
          clearInterval(timer);
        };
      }, [projectDir, intervalMs]);
      return { report, error };
    }

    function InterruptPanel(props) {
      const projectDir = typeof props.projectDir === "string" ? props.projectDir : "";
      const state = useInterrupts(projectDir, 10000);
      const report = state.report;
      const row = (entry) =>
        e(
          "div",
          { key: entry.name, style: { display: "flex", gap: "8px", padding: "1px 0", fontSize: "12px" } },
          e("span", { style: { flex: "0 0 46%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, entry.name),
          e("span", { style: { flex: "0 0 auto", opacity: 0.75 }, title: "抢占优先级" }, "抢 " + String(entry.preempt)),
          e("span", { style: { flex: "0 0 auto", opacity: 0.75 }, title: "子优先级" }, "子 " + String(entry.sub)),
          e("span", { style: { flex: "0 0 auto", opacity: entry.enabled ? 0.85 : 0.45 } }, entry.enabled ? "开" : "关"),
        );
      if (projectDir === "") return e("div", { style: { padding: "6px 10px", opacity: 0.6, fontSize: "12px" } }, "当前没有可用的工程目录。");
      if (state.error !== "") return e("div", { style: { padding: "6px 10px", opacity: 0.75, fontSize: "12px" } }, state.error);
      if (report === null) return e("div", { style: { padding: "6px 10px", opacity: 0.6, fontSize: "12px" } }, "读取中断表…");
      const entries = Array.isArray(report.entries) ? report.entries : [];
      return e(
        "div",
        { style: { display: "flex", flexDirection: "column", padding: "0 10px 8px" } },
        e(
          "div",
          { style: { padding: "4px 0 6px", fontSize: "12px", opacity: 0.85 } },
          report.iocName + "：使能 " + String(report.enabledCount) + " / " + String(entries.length) + " 路",
        ),
        entries.length === 0
          ? e("div", { style: { opacity: 0.6, fontSize: "12px" } }, "这个 .ioc 里没有 NVIC 中断配置。")
          : entries.map(row),
      );
    }

    /** 时钟树：读工程 .ioc 里已写下的 RCC 频率；与引脚页同一套刷新口径。 */
    function useClockTree(projectDir, intervalMs) {
      const [clocks, setClocks] = useState(null);
      const [error, setError] = useState("");
      const [tick, setTick] = useState(0);
      useEffect(() => {
        let closed = false;
        if (typeof projectDir !== "string" || projectDir === "") {
          setClocks(null);
          setError("");
          return () => {
            closed = true;
          };
        }
        const load = async () => {
          const result = await callApi("GET", "clocks?projectDir=" + encodeURIComponent(projectDir));
          if (closed) return;
          if (result.ok) {
            setClocks(result.value.clocks);
            setError("");
          } else {
            setError(result.error);
          }
        };
        load();
        const timer = setInterval(load, intervalMs);
        return () => {
          closed = true;
          clearInterval(timer);
        };
      }, [projectDir, tick]);
      return { clocks, error, reload: () => setTick((value) => value + 1) };
    }

    /** Hz → MHz 文本；0 与 null 都写成 —。 */
    function mhzText(hz) {
      if (typeof hz !== "number" || hz <= 0) return "—";
      const mhz = hz / 1000000;
      return (Number.isInteger(mhz) ? String(mhz) : mhz.toFixed(2)) + " MHz";
    }

    /**
     * 时钟页：按树顺序画一条横向比例条，一眼看出哪一路被分频压下来。
     * 比例按最高频归一，不取对数——分频是整数倍，线性更符合直觉。
     */
    function ClockPanel(props) {
      const projectDir = typeof props.projectDir === "string" ? props.projectDir : "";
      const state = useClockTree(projectDir, 10000);
      const clocks = state.clocks;
      if (projectDir === "") {
        return e("div", { style: { padding: "12px", opacity: 0.6, fontSize: "12px" } }, "当前没有可用的工程目录；先打开调试会话或建工程。");
      }
      if (state.error !== "") {
        return e("div", { style: { padding: "12px", opacity: 0.75, fontSize: "12px" } }, state.error);
      }
      if (clocks === null) {
        return e("div", { style: { padding: "12px", opacity: 0.6, fontSize: "12px" } }, "读取时钟树…");
      }
      const nodes = clocks.nodes ?? [];
      const peak = nodes.reduce((max, node) => (typeof node.hz === "number" && node.hz > max ? node.hz : max), 0);
      const row = (node) =>
        e(
          "div",
          { key: node.key, style: { display: "flex", alignItems: "center", gap: "8px", padding: "2px 0", fontSize: "12px" } },
          e("span", { style: { flex: "0 0 30%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: node.key }, node.label),
          e(
            "span",
            { style: { flex: "1 1 auto", height: "8px", background: "color-mix(in srgb, currentColor 8%, transparent)", borderRadius: "2px" } },
            e("span", {
              style: {
                display: "block",
                height: "100%",
                width: (peak > 0 && typeof node.hz === "number" ? Math.max(2, Math.round((node.hz / peak) * 100)) : 0) + "%",
                background: "color-mix(in srgb, currentColor 45%, transparent)",
                borderRadius: "2px",
              },
            }),
          ),
          e("span", { style: { flex: "0 0 84px", textAlign: "right", fontVariantNumeric: "tabular-nums" } }, mhzText(node.hz)),
          e("span", { style: { flex: "0 0 40px", opacity: 0.6 } }, node.divider),
        );
      return e(
        "div",
        { style: { display: "flex", flexDirection: "column", padding: "6px 10px 10px" } },
        e(
          "div",
          { style: { display: "flex", flexWrap: "wrap", gap: "10px", fontSize: "12px", opacity: 0.85, paddingBottom: "6px" } },
          e("span", null, clocks.cpn || "未知型号"),
          e("span", null, "SYSCLK ← " + (clocks.sysclkSourceLabel || "—")),
          e("span", null, "PLL ← " + (clocks.pll?.sourceLabel || "—") + " " + (clocks.pll?.mulLabel || "")),
        ),
        nodes.map(row),
        (clocks.others ?? []).length > 0
          ? e(
              "div",
              { key: "others", style: { paddingTop: "8px", fontSize: "11px", opacity: 0.6 } },
              "其它 RCC 频率：" + clocks.others.map((node) => node.label + " " + mhzText(node.hz)).join("；"),
            )
          : null,
      );
    }

    /** 故障页：读取本会话失败事件的解码结果；进页拉一次，失败事件变化时再刷。 */
    function useFaults(sessionId, intervalMs) {
      const [faults, setFaults] = useState(null);
      const [error, setError] = useState("");
      const [tick, setTick] = useState(0);
      useEffect(() => {
        let closed = false;
        const load = async () => {
          const suffix = typeof sessionId === "string" && sessionId !== "" ? "&session=" + encodeURIComponent(sessionId) : "";
          const result = await callApi("GET", "faults?limit=100" + suffix);
          if (closed) return;
          if (result.ok) {
            setFaults(result.value.faults ?? []);
            setError("");
          } else {
            setError(result.error);
          }
        };
        load();
        const timer = setInterval(load, intervalMs);
        return () => {
          closed = true;
          clearInterval(timer);
        };
      }, [sessionId, tick]);
      return { faults, error, reload: () => setTick((value) => value + 1) };
    }

    const FAULT_CATEGORY_LABEL = { probe: "探针", target: "目标", build: "编译", flash: "烧录", toolchain: "工具链", network: "网络", debug: "调试", tool: "文件", other: "其它" };

    function FaultPanel(props) {
      const state = useFaults(props.sessionId, 5000);
      if (state.error !== "") {
        return e("div", { style: { padding: "12px", opacity: 0.75, fontSize: "12px" } }, "读取故障失败：" + state.error);
      }
      const faults = state.faults;
      if (faults === null) {
        return e("div", { style: { padding: "12px", opacity: 0.6, fontSize: "12px" } }, "读取故障列表…");
      }
      if (faults.length === 0) {
        return e("div", { style: { padding: "12px", opacity: 0.6, fontSize: "12px" } }, "本会话还没有失败事件。");
      }
      return e(
        "div",
        { style: { display: "flex", flexDirection: "column", overflow: "auto", padding: "6px 10px 10px" } },
        faults
          .slice()
          .reverse()
          .map((fault) =>
            e(
              "div",
              { key: "fault-" + String(fault.seq), style: { padding: "6px 0", borderTop: "1px solid color-mix(in srgb, currentColor 8%, transparent)", fontSize: "12px" } },
              e(
                "div",
                { style: { display: "flex", gap: "8px", alignItems: "baseline" } },
                e("span", { style: { opacity: 0.55, fontVariantNumeric: "tabular-nums" } }, "#" + String(fault.seq)),
                e("span", { style: { opacity: 0.75 } }, String(fault.kind)),
                e(
                  "span",
                  { style: { marginLeft: "auto", padding: "0 6px", borderRadius: "999px", border: "1px solid color-mix(in srgb, currentColor 20%, transparent)", opacity: 0.8 } },
                  FAULT_CATEGORY_LABEL[fault.category] ?? fault.category,
                ),
              ),
              e("div", { style: { opacity: 0.9, paddingTop: "2px" } }, String(fault.summary)),
              fault.hint === ""
                ? null
                : e("div", { style: { opacity: 0.7, paddingTop: "2px" } }, "先看：" + String(fault.hint)),
            ),
          ),
      );
    }

    /** 产物页：构建目录里的 elf/hex/bin 与芯片容量；10 秒刷新。 */
    function useArtifacts(projectDir, intervalMs) {
      const [artifacts, setArtifacts] = useState(null);
      const [error, setError] = useState("");
      const [tick, setTick] = useState(0);
      useEffect(() => {
        let closed = false;
        if (typeof projectDir !== "string" || projectDir === "") {
          setArtifacts(null);
          setError("");
          return () => {
            closed = true;
          };
        }
        const load = async () => {
          const result = await callApi("GET", "artifacts?projectDir=" + encodeURIComponent(projectDir));
          if (closed) return;
          if (result.ok) {
            setArtifacts(result.value.artifacts);
            setError("");
          } else {
            setError(result.error);
          }
        };
        load();
        const timer = setInterval(load, intervalMs);
        return () => {
          closed = true;
          clearInterval(timer);
        };
      }, [projectDir, tick]);
      return { artifacts, error, reload: () => setTick((value) => value + 1) };
    }

    /** 字节数 → 人类可读；产物大小与容量上限共用。 */
    function bytesText(bytes) {
      if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "—";
      if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + " MB";
      if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " KB";
      return String(bytes) + " B";
    }

    /**
     * 最近一次构建的内存占用。
     * 数据来自 stm32_build 的 ok 事件（payload.result.memoryUsage），不另跑 size：
     * 构建时链接器已经打印过一次，复用同一份数字才不会出现两个口径。
     */
    function collectMemoryUsage(events) {
      let latest = null;
      for (const event of events) {
        if (event.kind !== "stm32_build" || event.status !== "ok") continue;
        const usage = event.payload?.result?.memoryUsage;
        if (Array.isArray(usage) && usage.length > 0) latest = { seq: event.seq, time: event.time, usage };
      }
      return latest;
    }

    function MemoryBar(props) {
      const region = props.region;
      const percent = typeof region.percent === "number" ? Math.max(0, Math.min(100, region.percent)) : 0;
      return e(
        "div",
        { style: { display: "flex", alignItems: "center", gap: "8px", padding: "2px 0", fontSize: "12px" } },
        e("span", { style: { flex: "0 0 26%" } }, region.region),
        e(
          "span",
          { style: { flex: "1 1 auto", height: "8px", background: "color-mix(in srgb, currentColor 8%, transparent)", borderRadius: "2px" } },
          e("span", {
            style: {
              display: "block",
              height: "100%",
              width: percent + "%",
              background: "color-mix(in srgb, currentColor 45%, transparent)",
              borderRadius: "2px",
            },
          }),
        ),
        e("span", { style: { flex: "0 0 150px", textAlign: "right", fontVariantNumeric: "tabular-nums" } },
          bytesText(region.usedBytes) + " / " + bytesText(region.totalBytes) + "（" + percent.toFixed(1) + "%）"),
      );
    }

    /** 产物页：文件清单 + 最近一次构建的 Flash/RAM 占用。 */
    function ArtifactPanel(props) {
      const projectDir = typeof props.projectDir === "string" ? props.projectDir : "";
      const state = useArtifacts(projectDir, 10000);
      if (projectDir === "") {
        return e("div", { style: { padding: "12px", opacity: 0.6, fontSize: "12px" } }, "当前没有可用的工程目录；先打开调试会话或建工程。");
      }
      if (state.error !== "") {
        return e("div", { style: { padding: "12px", opacity: 0.75, fontSize: "12px" } }, state.error);
      }
      const artifacts = state.artifacts;
      if (artifacts === null) {
        return e("div", { style: { padding: "12px", opacity: 0.6, fontSize: "12px" } }, "读取产物…");
      }
      const memory = collectMemoryUsage(props.events ?? []);
      const fileRow = (label, file) =>
        e(
          "div",
          { key: label, style: { display: "flex", gap: "8px", fontSize: "12px", padding: "1px 0" } },
          e("span", { style: { flex: "0 0 52px", opacity: 0.7 } }, label),
          file === null
            ? e("span", { style: { opacity: 0.5 } }, "—")
            : e(
                "span",
                { style: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: file.path },
                file.name + "  " + bytesText(file.size) + "  " + new Date(file.mtimeMs).toLocaleString(),
              ),
        );
      return e(
        "div",
        { style: { display: "flex", flexDirection: "column", padding: "6px 10px 10px" } },
        e(
          "div",
          { style: { fontSize: "12px", opacity: 0.8, paddingBottom: "4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: artifacts.buildDir },
          "构建目录：" + (artifacts.buildDir === "" ? "（未识别）" : artifacts.buildDir),
        ),
        fileRow("ELF", artifacts.elf),
        fileRow("HEX", artifacts.hex),
        fileRow("BIN", artifacts.bin),
        e(
          "div",
          { style: { paddingTop: "6px", fontSize: "12px", opacity: 0.8 } },
          "芯片：" + (artifacts.chip === null
            ? "容量未知"
            : artifacts.chip.cpn + "（Flash " + bytesText(artifacts.chip.flashBytes) + " / RAM " + bytesText(artifacts.chip.ramBytes) + "）"),
        ),
        memory === null
          ? e("div", { key: "no-memory", style: { paddingTop: "4px", fontSize: "12px", opacity: 0.6 } }, "还没有构建记录：跑一次 stm32_build 后这里显示 Flash / RAM 占用。")
          : e(
              "div",
              { key: "memory", style: { paddingTop: "4px" } },
              memory.usage.map((region) => e(MemoryBar, { key: String(region.region), region: region })),
            ),
        (artifacts.notes ?? []).length === 0
          ? null
          : e(
              "div",
              { key: "notes", style: { paddingTop: "6px", fontSize: "11px", opacity: 0.6 } },
              artifacts.notes.map((note, index) => e("div", { key: "n" + String(index) }, note)),
            ),
      );
    }

    const RTT_LEVEL_LABEL = { 1: "错误", 2: "警告", 3: "信息", 4: "调试" };

    const CHANNEL_DEFS = [
      { key: "serial", label: "串口" },
      { key: "rtt", label: "RTT" },
      { key: "watch", label: "监视" },
    ];

    /**
     * 把通道事件按通道名摊平成行尾。
     *
     * 通道没有独立序号的必要：面板只需要"最近 N 行"，重连时按事件 seq 续播即可。
     */
    function collectChannelTails(events) {
      const tails = {};
      for (const def of CHANNEL_DEFS) tails[def.key] = [];
      for (const event of events) {
        if (typeof event.kind !== "string" || !event.kind.startsWith("channel:")) continue;
        const name = event.kind.slice("channel:".length);
        const bucket = tails[name];
        if (!Array.isArray(bucket)) continue;
        const lines = event.payload !== null && typeof event.payload === "object" && Array.isArray(event.payload.lines)
          ? event.payload.lines
          : [];
        for (const line of lines) bucket.push(String(line));
        if (bucket.length > 400) tails[name] = bucket.slice(bucket.length - 400);
      }
      return tails;
    }

    function ChannelBlock(props) {
      const state = props.state;
      const lines = props.lines;
      const [draft, setDraft] = useState("");
      const [sendMsg, setSendMsg] = useState("");
      const send = async () => {
        if (props.onSend === undefined) return;
        setSendMsg("发送中…");
        setSendMsg(await props.onSend(draft));
      };
      const pauseAt = typeof state.pauseAt === "number" ? state.pauseAt : lines.length;
      const clearAt = typeof state.clearAt === "number" ? state.clearAt : 0;
      const window_ = lines.slice(clearAt, Math.max(clearAt, pauseAt));
      const paused = typeof state.pauseAt === "number";
      const [keyword, setKeyword] = useState("");
      const [level, setLevel] = useState(0);
      const needle = keyword.trim().toLowerCase();
      const shown = window_.filter((line) => {
        if (needle !== "" && !String(line).toLowerCase().includes(needle)) return false;
        if (level === 0) return true;
        const matched = /^\[(\d)\]/u.exec(String(line));
        return matched !== null && Number(matched[1]) === level;
      });
      return e(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "4px", padding: "6px 10px", borderBottom: "1px solid color-mix(in srgb, currentColor 8%, transparent)" } },
        e(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "6px" } },
          e("strong", null, props.label),
          e("span", { style: { opacity: 0.55 } }, shown.length === window_.length ? String(lines.length) + " 行" : String(shown.length) + " / " + String(window_.length) + " 行"),
          props.tap === undefined
            ? null
            : e(
                "span",
                { style: { opacity: 0.7 }, title: props.tap.lastError === "" ? "服务端定时取增量并写入事件流" : props.tap.lastError },
                props.tap.active ? "常驻开 " + String(props.tap.lines) + " 行" : "常驻关",
              ),
          e("span", { style: debugStyles.spacer }),
          props.tap === undefined
            ? null
            : e(
                "button",
                { style: debugStyles.button, onClick: () => props.onToggleTap(!props.tap.active) },
                props.tap.active ? "停常驻" : "开常驻",
              ),
          e(
            "button",
            {
              style: debugStyles.button,
              onClick: () => props.onTogglePause(),
            },
            paused ? "继续" : "暂停",
          ),
          e("button", { style: debugStyles.button, onClick: props.onClear }, "清空"),
        ),
        e(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "11px" } },
          e("input", {
            value: keyword,
            onChange: (event) => setKeyword(event.target.value),
            placeholder: "过滤关键字",
            style: { flex: "0 0 40%", fontSize: "11px", padding: "1px 6px" },
          }),
          props.channelKey === "rtt"
            ? [0, 1, 2, 3, 4].map((value) =>
                e(
                  "button",
                  {
                    key: "lv" + String(value),
                    style: Object.assign({}, debugStyles.button, level === value ? { fontWeight: 600, opacity: 1 } : { opacity: 0.55 }),
                    onClick: () => setLevel(value),
                  },
                  value === 0 ? "全部" : RTT_LEVEL_LABEL[value],
                ),
              )
            : null,
        ),
        props.onSend === undefined
          ? null
          : e(
              "div",
              { style: { display: "flex", alignItems: "center", gap: "6px" } },
              e("input", {
                value: draft,
                onChange: (event) => setDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === "Enter") void send();
                },
                placeholder: "输入一行，回车发送（空串表示只发换行）",
                style: { flex: "1 1 auto", fontSize: "12px", padding: "2px 6px" },
              }),
              e("button", { style: debugStyles.button, onClick: () => void send() }, "发送"),
              sendMsg === "" ? null : e("span", { style: { opacity: 0.6, fontSize: "11px" } }, sendMsg),
            ),
        shown.length === 0
          ? e("div", { style: { opacity: 0.5 } }, "暂无输出。")
          : e("pre", { style: Object.assign({}, debugStyles.pre, { padding: 0, maxHeight: "220px", overflow: "auto" }) }, shown.join("\n")),
      );
    }

    /**
     * 常驻通道状态：串口与 RTT 的服务端 tap 是否在跑。
     * 开关本身不落 localStorage——它对应真实的轮询任务，重启 DSH 就该回到关闭。
     */
    function useChannelTaps(intervalMs) {
      const [channels, setChannels] = useState([]);
      const [error, setError] = useState("");
      const [tick, setTick] = useState(0);
      useEffect(() => {
        let closed = false;
        const load = async () => {
          const result = await callApi("GET", "channels");
          if (closed) return;
          if (result.ok) {
            setChannels(Array.isArray(result.value?.channels) ? result.value.channels : []);
            setError("");
          } else {
            setError(result.error);
          }
        };
        load();
        const timer = setInterval(load, intervalMs);
        return () => {
          closed = true;
          clearInterval(timer);
        };
      }, [intervalMs, tick]);
      const toggle = async (name, on) => {
        const result = await callApi("POST", on ? "channels/start" : "channels/stop", { [name]: true });
        if (!result.ok) setError(result.error);
        else if (Array.isArray(result.value?.channels)) setChannels(result.value.channels);
        setTick((value) => value + 1);
      };
      return { channels, error, toggle };
    }

    /** 监视自动采样：状态与开关。采样结果由同一个事件流带回，面板不另拉数据。 */
    function useWatchRecording(intervalMs) {
      const [status, setStatus] = useState(null);
      const [error, setError] = useState("");
      const [tick, setTick] = useState(0);
      useEffect(() => {
        let closed = false;
        const load = async () => {
          const result = await callApi("GET", "watch-recording");
          if (closed) return;
          if (result.ok) {
            setStatus(result.value?.watchRecording ?? null);
            setError("");
          } else {
            setError(result.error);
          }
        };
        load();
        const timer = setInterval(load, intervalMs);
        return () => {
          closed = true;
          clearInterval(timer);
        };
      }, [intervalMs, tick]);
      const send = async (action) => {
        const result = await callApi("POST", "watch-recording/" + action, {});
        if (!result.ok) setError(result.error);
        else setStatus(result.value?.watchRecording ?? null);
        setTick((value) => value + 1);
      };
      return { status, error, start: () => send("start"), stop: () => send("stop") };
    }

    /** 面板里发一行串口：走与 stm32_serial 相同的那条桥命令。 */
    async function sendSerialLine(text) {
      const result = await callApi("POST", "serial/send", { text });
      if (!result.ok) return result.error;
      const serial = result.value?.serial ?? {};
      return serial.ok === true ? "已发送 " + String(serial.bytes) + " B（" + String(serial.ackMs) + " ms）" : String(serial.message ?? "发送失败");
    }

    /** 从事件流里算「谁还在跑」：start 未配对 ok/fail 即视为在途，progress 更新阶段。 */
    function collectRunning(events) {
      const order = [];
      const map = new Map();
      for (const event of events) {
        const payload = event.payload ?? {};
        const callId = typeof payload.callId === "string" ? payload.callId : "";
        if (callId === "") continue;
        if (event.kind === "progress") {
          const item = map.get(callId);
          if (item !== undefined) item.phase = String(payload.phase ?? "");
          continue;
        }
        if (event.status === "start") {
          if (!map.has(callId)) {
            map.set(callId, { callId, name: String(event.kind), startedAt: event.time, phase: "" });
            order.push(callId);
          }
        } else if (event.status === "ok" || event.status === "fail") {
          map.delete(callId);
        }
      }
      return order.filter((callId) => map.has(callId)).map((callId) => map.get(callId));
    }

    /** 在途调用列表：显示已跑时长与阶段，可逐条请求中止。 */
    function RunningTools(props) {
      const [now, setNow] = useState(Date.now());
      const [message, setMessage] = useState("");
      const [busy, setBusy] = useState("");
      useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, []);
      const running = collectRunning(props.events ?? []);
      const abortOne = async (callId) => {
        setBusy(callId);
        const result = await callApi("POST", "abort", { callId });
        setBusy("");
        if (result.ok) {
          const count = result.value?.abort?.count ?? 0;
          setMessage("已请求中止 " + callId + "（" + String(count) + " 条）");
        } else {
          setMessage(result.error);
        }
      };
      const elapsed = (startedAt) => {
        const start = Date.parse(String(startedAt));
        if (!Number.isFinite(start)) return "";
        const ms = Math.max(0, now - start);
        return (ms / 1000).toFixed(1) + " s";
      };
      return e(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "4px" } },
        e("div", { style: { opacity: 0.7, fontWeight: 600 } }, "在途调用"),
        running.length === 0
          ? e("div", { style: { opacity: 0.5 } }, "当前没有在途的工具调用。")
          : running.map((item) =>
              e(
                "div",
                { key: item.callId, style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" } },
                e("span", { style: { fontFamily: "monospace" } }, item.callId),
                e("span", null, item.name),
                e("span", { style: { opacity: 0.7 } }, elapsed(item.startedAt)),
                item.phase === "" ? null : e("span", { style: { opacity: 0.7 } }, item.phase),
                e(
                  "button",
                  { style: debugStyles.button, disabled: busy === item.callId, onClick: () => abortOne(item.callId) },
                  busy === item.callId ? "中止中…" : "中止",
                ),
              ),
            ),
        message === "" ? null : e("div", { style: { opacity: 0.7 } }, message),
      );
    }

    /** .ioc 变更页的数据：当前配置与基线的差异，轮询 + 手动刷新。 */
    function useIocDiff(projectDir, intervalMs) {
      const [value, setValue] = useState({ diff: null, error: "" });
      const [tick, setTick] = useState(0);
      useEffect(() => {
        let closed = false;
        const load = async () => {
          const path = projectDir === "" ? "ioc-diff" : "ioc-diff?projectDir=" + encodeURIComponent(projectDir);
          const result = await callApi("GET", path);
          if (closed) return;
          if (result.ok) setValue({ diff: result.value.diff, error: "" });
          else setValue({ diff: null, error: result.error });
        };
        load();
        const timer = setInterval(load, intervalMs);
        return () => {
          closed = true;
          clearInterval(timer);
        };
      }, [projectDir, intervalMs, tick]);
      return { diff: value.diff, error: value.error, reload: () => setTick((previous) => previous + 1) };
    }

    /** 变更页：把当前 .ioc 与基线逐键比较，并把当前配置记成新基线。 */
    function IocDiffPanel(props) {
      const projectDir = typeof props.projectDir === "string" ? props.projectDir : "";
      const state = useIocDiff(projectDir, 10000);
      const [message, setMessage] = useState("");
      const [saving, setSaving] = useState(false);
      const save = async () => {
        setSaving(true);
        const result = await callApi("POST", "ioc-diff/save", { projectDir: projectDir });
        setSaving(false);
        if (result.ok) {
          setMessage("已记下基线：" + String(result.value.snapshot.savedAt) + "（" + String(result.value.snapshot.entries) + " 个键）");
          state.reload();
        } else {
          setMessage("记录基线失败：" + result.error);
        }
      };
      if (state.error !== "") return e("div", { style: debugStyles.empty }, state.error);
      const diff = state.diff;
      if (diff === null) return e("div", { style: debugStyles.empty }, "读取 .ioc 中…");
      const line = (key, text) =>
        e(
          "div",
          { key: key, style: { fontFamily: "ui-monospace, monospace", fontSize: "11px", opacity: 0.85, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: text },
          text,
        );
      const section = (title, rows) =>
        e(
          "div",
          { key: title, style: { display: "flex", flexDirection: "column", gap: "1px", padding: "4px 0" } },
          e("div", { style: { fontSize: "12px", opacity: 0.7 } }, title + "（" + String(rows.length) + "）"),
          rows.length === 0 ? e("div", { style: { fontSize: "11px", opacity: 0.5 } }, "无") : rows,
        );
      return e(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "2px", padding: "8px 10px" } },
        e(
          "div",
          { style: { display: "flex", gap: "8px", alignItems: "center", fontSize: "12px" } },
          e("span", { style: { opacity: 0.7 } }, diff.iocName),
          e("span", { style: debugStyles.spacer }),
          e("button", { style: debugStyles.button, disabled: saving === true, onClick: save }, saving === true ? "记录中…" : "记下当前配置"),
        ),
        diff.hasSnapshot === false
          ? e("div", { style: { fontSize: "12px", opacity: 0.75 } }, diff.notes.join("；"))
          : e("div", { style: { fontSize: "11px", opacity: 0.6 } }, "基线 " + diff.savedAt + " · 新增 " + String(diff.counts.added) + " · 删除 " + String(diff.counts.removed) + " · 改动 " + String(diff.counts.changed)),
        message === "" ? null : e("div", { style: { fontSize: "11px", opacity: 0.8 } }, message),
        section("新增", diff.added.map((entry) => line(entry.key, "+ " + entry.key + "=" + entry.value))),
        section("删除", diff.removed.map((entry) => line(entry.key, "- " + entry.key + "=" + entry.value))),
        section("改动", diff.changed.map((entry) => line(entry.key, "~ " + entry.key + "：" + entry.before + " → " + entry.after))),
      );
    }

    /** 最近一次某类工具的成功事件，用于概览里的「上次构建 / 上次烧录」。 */
    function lastEventOf(events, kind) {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.kind === kind && event.status === "ok") return event;
      }
      return null;
    }

    /** 概览：把型号、时钟、容量与会话状态压成一屏，先看这里再看细节页。 */
    /** 工具链探测摘要：概览页只读用它，60 秒一次；探测本身会跑版本命令，不能太勤。 */
    function useProbeSummary(intervalMs) {
      const [summary, setSummary] = useState(null);
      useEffect(() => {
        let closed = false;
        const load = async () => {
          const result = await callApi("GET", "probe");
          if (!closed && result.ok) setSummary(result.value.summary);
        };
        load();
        const timer = setInterval(load, intervalMs);
        return () => {
          closed = true;
          clearInterval(timer);
        };
      }, [intervalMs]);
      return summary;
    }

    /** 能力四项一行：编译 / 烧录 / 调试 / 生成，缺哪项一眼能看出。 */
    function capabilitiesText(capabilities) {
      if (capabilities === null || capabilities === undefined) return "—";
      const marks = [
        ["编译", capabilities.build === true],
        ["烧录", capabilities.flash === true],
        ["调试", capabilities.debug === true],
        ["生成", capabilities.generate === true],
      ];
      return marks.map((pair) => pair[0] + (pair[1] ? " ✓" : " ✗")).join(" ");
    }

    function OverviewPanel(props) {
      const projectDir = typeof props.projectDir === "string" ? props.projectDir : "";
      const pinout = usePinout(projectDir, 10000);
      const clocks = useClockTree(projectDir, 10000);
      const artifacts = useArtifacts(projectDir, 10000);
      const probe = useProbeSummary(60000);
      const memory = collectMemoryUsage(props.events ?? []);
      const build = lastEventOf(props.events ?? [], "stm32_build");
      const flash = lastEventOf(props.events ?? [], "stm32_flash");
      const failed = (props.events ?? []).filter((event) => event.status === "fail").length;
      const chips = [];
      if (projectDir === "") {
        chips.push(["工程", "未绑定：先打开调试会话"]);
      } else {
        chips.push(["工程", projectDir]);
      }
      const mcu = pinout.pinout?.mcu;
      chips.push(["型号", mcu === undefined || mcu === null ? "—" : (mcu.cpn ?? "—") + (mcu.package ? " / " + mcu.package : "")]);
      const sysclk = (clocks.clocks?.nodes ?? []).find((node) => node.label === "SYSCLK");
      chips.push(["SYSCLK", sysclk === undefined ? "—" : mhzText(sysclk.hz)]);
      const chip = artifacts.artifacts?.chip ?? null;
      chips.push(["容量", chip === null ? "—" : "Flash " + bytesText(chip.flashBytes) + " / RAM " + bytesText(chip.ramBytes)]);
      const debug = props.debug ?? null;
      chips.push([
        "会话",
        debug === null
          ? "—"
          : debug.active === true
            ? "进行中 · " + (debug.sessionId ?? "") + " · 剩 " + Math.max(0, Math.round((debug.remainingMs ?? 0) / 1000)) + " s"
            : "空闲",
      ]);
      chips.push([
        "工具链",
        probe === null
          ? "—"
          : (probe.ok === true ? "就绪" : "缺 " + (probe.missingRequired ?? []).join("、")) +
            " · " + String((probe.tools ?? []).filter((tool) => tool.found === true).length) + "/" + String((probe.tools ?? []).length) +
            " 项 · " + capabilitiesText(probe.capabilities),
      ]);
      chips.push(["上次构建", build === null ? "—" : clockText(build.time)]);
      chips.push(["上次烧录", flash === null ? "—" : clockText(flash.time)]);
      const seen = chips.some((pair) => pair[0] === "失败事件");
      if (!seen) chips.push(["失败事件", String(failed)]);
      return e(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "2px", padding: "8px 10px" } },
        chips.map((pair) =>
          pair[0] === "失败事件" && failed > 0 && typeof props.onShowFailures === "function"
            ? e(
                "button",
                {
                  key: pair[0],
                  type: "button",
                  title: "跳到实时通道，只看失败事件",
                  onClick: () => props.onShowFailures(),
                  style: {
                    display: "flex",
                    gap: "8px",
                    fontSize: "12px",
                    padding: "1px 0",
                    background: "transparent",
                    border: "none",
                    color: "inherit",
                    textAlign: "left",
                    cursor: "pointer",
                  },
                },
                e("span", { style: { flex: "0 0 68px", opacity: 0.65 } }, pair[0]),
                e("span", { style: { flex: "1 1 auto", textDecoration: "underline" } }, pair[1] + "（点这里只看失败）"),
              )
            : e(
                "div",
                { key: pair[0], style: { display: "flex", gap: "8px", fontSize: "12px", padding: "1px 0" } },
                e("span", { style: { flex: "0 0 68px", opacity: 0.65 } }, pair[0]),
                e("span", { style: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: pair[1] }, pair[1]),
              ),
        ),
        memory === null
          ? null
          : e("div", { key: "memory", style: { paddingTop: "4px" } }, memory.usage.map((region) => e(MemoryBar, { key: String(region.region), region: region }))),
      );
    }

    function useSerialState(intervalMs) {
      const [state, setState] = useState({ serial: null, error: "" });
      const [tick, setTick] = useState(0);
      useEffect(() => {
        let alive = true;
        const load = async () => {
          const result = await callApi("GET", "serial");
          if (!alive) return;
          if (!result.ok) setState({ serial: null, error: result.error });
          else setState({ serial: result.value?.serial ?? null, error: "" });
        };
        load();
        const timer = setInterval(load, intervalMs);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [intervalMs, tick]);
      return { serial: state.serial, error: state.error, reload: () => setTick((n) => n + 1) };
    }

    function SerialCard(props) {
      const [port, setPort] = useState("");
      const [baudRate, setBaudRate] = useState("115200");
      const [ports, setPorts] = useState([]);
      const [note, setNote] = useState("");
      const serial = props.serial ?? null;
      const open = serial !== null && serial.open === true;
      const statusText = open
        ? serial.port + " · " + String(serial.baudRate) + " 8N1 · 桥 " + String(serial.bridgePid) + (serial.bridgeAlive ? "（活）" : "（已退）")
        : "未打开";
      const refreshPorts = async () => {
        const result = await callApi("GET", "serial/ports");
        if (!result.ok) {
          setNote(result.error);
          return;
        }
        setPorts(result.value?.serialPorts?.ports ?? []);
        setNote("可用端口 " + String((result.value?.serialPorts?.ports ?? []).length) + " 个");
      };
      const doOpen = async () => {
        const baud = Number(baudRate);
        const body = {};
        if (port.trim() !== "") body.port = port.trim();
        if (Number.isFinite(baud) && baud > 0) body.baudRate = baud;
        const result = await callApi("POST", "serial/open", body);
        setNote(result.ok ? String(result.value?.serial?.message ?? "") : result.error);
        if (result.ok) props.onChanged();
      };
      const doClose = async () => {
        const result = await callApi("POST", "serial/close", {});
        setNote(result.ok ? String(result.value?.serial?.message ?? "") : result.error);
        if (result.ok) props.onChanged();
      };
      return e(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: "2px",
            padding: "6px 10px",
            border: "1px solid color-mix(in srgb, currentColor 14%, transparent)",
            borderRadius: "8px",
          },
        },
        e(
          "div",
          { style: { display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" } },
          e("span", { style: { fontWeight: 600 } }, "串口"),
          e("span", { style: { opacity: 0.75 } }, statusText),
          e("span", { style: { flex: 1 } }),
          e("button", { type: "button", style: debugStyles.button, onClick: refreshPorts }, "刷新端口"),
          e("button", { type: "button", style: debugStyles.button, onClick: doOpen }, "打开"),
          e("button", { type: "button", style: debugStyles.button, onClick: doClose, disabled: !open }, "关闭"),
        ),
        e(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", marginTop: "6px" } },
          e("input", {
            value: port,
            placeholder: ports.length > 0 ? ports.map((item) => item.port).join(" / ") : "COM3",
            onChange: (event) => setPort(event.target.value),
            style: debugStyles.input,
          }),
          e("input", {
            value: baudRate,
            placeholder: "115200",
            onChange: (event) => setBaudRate(event.target.value),
            style: Object.assign({}, debugStyles.input, { minWidth: "92px", width: "92px" }),
          }),
        ),
        props.error ? e("div", { style: { color: "#c0392b", marginTop: "4px" } }, String(props.error)) : null,
        note === "" ? null : e("div", { style: { opacity: 0.75, marginTop: "4px" } }, note),
      );
    }

    function Channels(props) {
      const [view, setView] = useState({});
      const [tab, setTab] = useState("channels");
      useEffect(() => {
        if (typeof props.focusFailures === "number" && props.focusFailures > 0) setTab("channels");
      }, [props.focusFailures]);
      const debugInfo = useDebugStatus(5000);
      const [touchMessage, setTouchMessage] = useState("");
      const touchSession = async () => {
        const result = await callApi("POST", "debug/touch", {});
        if (!result.ok) setTouchMessage(result.error);
        else {
          setTouchMessage("已续期，剩余 " + String(Math.ceil(Number(result.value?.debug?.remainingMs ?? 0) / 1000)) + " s");
          debugInfo.reload();
        }
      };
      const taps = useChannelTaps(3000);
      const serialState = useSerialState(4000);
      const recording = useWatchRecording(3000);
      const tapOf = (key) => taps.channels.find((item) => item.name === key);
      const tails = collectChannelTails(props.events);
      const projectDir = debugInfo.debug?.projectDir ?? "";
      const setStateFor = (key, patch) => {
        setView((previous) => {
          const next = Object.assign({}, previous);
          next[key] = Object.assign({}, previous[key] ?? {}, patch);
          return next;
        });
      };
      const tabButton = (key, label) =>
        e(
          "button",
          {
            key: key,
            type: "button",
            onClick: () => setTab(key),
            style: {
              padding: "2px 10px",
              fontSize: "12px",
              borderRadius: "999px",
              border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
              background: tab === key ? "color-mix(in srgb, currentColor 14%, transparent)" : "transparent",
              color: "inherit",
              cursor: "pointer",
            },
          },
          label,
        );
      const header = e(
        "div",
        { key: "tabs", style: { display: "flex", gap: "6px", padding: "6px 10px", borderBottom: "1px solid color-mix(in srgb, currentColor 8%, transparent)" } },
        tabButton("overview", DEBUG_LABELS.overview),
        tabButton("channels", DEBUG_LABELS.channels),
        tabButton("pinout", DEBUG_LABELS.pinout),
        tabButton("clocks", DEBUG_LABELS.clocks),
        tabButton("interrupts", DEBUG_LABELS.interrupts),
        tabButton("faults", DEBUG_LABELS.faults),
        tabButton("artifacts", DEBUG_LABELS.artifacts),
        tabButton("changes", DEBUG_LABELS.changes),
      );
      const body =
        tab === "overview"
          ? [e(OverviewPanel, { key: "overview", projectDir: projectDir, debug: debugInfo.debug, events: props.events, onShowFailures: props.onShowFailures })]
          : tab === "pinout"
          ? [e(PinoutPanel, { key: "pinout", projectDir: projectDir })]
          : tab === "clocks"
            ? [e(ClockPanel, { key: "clocks", projectDir: projectDir })]
            : tab === "interrupts"
            ? [e(InterruptPanel, { key: "interrupts", projectDir: projectDir })]
            : tab === "faults"
            ? [e(FaultPanel, { key: "faults", sessionId: props.sessionId })]
            : tab === "artifacts"
            ? [e(ArtifactPanel, { key: "artifacts", projectDir: projectDir, events: props.events })]
            : tab === "changes"
            ? [e(IocDiffPanel, { key: "changes", projectDir: projectDir })]
            : [
              e(SessionCard, { key: "session", debug: debugInfo.debug, error: debugInfo.error, onTouch: touchSession, touchMessage: touchMessage }),
              e(SerialCard, { key: "serial-card", serial: serialState.serial, error: serialState.error, onChanged: serialState.reload }),
              e(RunningTools, { key: "running", events: props.events }),
              e(BreakpointPanel, { key: "breakpoints", debug: debugInfo.debug, onChanged: debugInfo.reload }),
              e(WatchAdmin, { key: "watch-admin" }),
              e(WatchCurves, { key: "curves", events: props.events, recording: recording.status, onStart: recording.start, onStop: recording.stop }),
            ];
      const channelBlocks = CHANNEL_DEFS.map((def) =>
          e(ChannelBlock, {
            key: def.key,
            label: def.label,
            channelKey: def.key,
            lines: tails[def.key],
            state: view[def.key] ?? {},
            tap: tapOf(def.key),
            onSend: def.key === "serial" ? sendSerialLine : undefined,
            onToggleTap: (on) => taps.toggle(def.key, on),
            onTogglePause: () =>
              setStateFor(def.key, { pauseAt: typeof (view[def.key] ?? {}).pauseAt === "number" ? undefined : tails[def.key].length }),
            onClear: () => setStateFor(def.key, { clearAt: tails[def.key].length, pauseAt: undefined }),
          }),
        );
      return e(
        DebugPanel,
        { title: tab === "channels" ? DEBUG_LABELS.channels : DEBUG_LABELS.channels + " / " + (DEBUG_LABELS[tab] ?? tab), onCollapse: props.onCollapse },
        header,
        body,
        tab === "channels" ? channelBlocks : null,
      );
    }

    /** 底部控制台：把当前可见事件按行铺开，便于一眼扫过整段联调。 */
    function ConsolePanel(props) {
      const lines = props.events.slice(-400).map((event) =>
        [
          clockText(event.time),
          DEBUG_STATUS_SIGN[event.status] ?? "·",
          String(event.kind),
          String(event.summary),
        ].join("  "),
      );
      return e(
        "div",
        { style: Object.assign({}, debugStyles.panel, { flex: "0 0 auto" }) },
        e(
          "div",
          { style: debugStyles.panelHead },
          "控制台",
          e("span", { style: debugStyles.spacer }),
          e("span", { style: { opacity: 0.6, fontWeight: 400 } }, String(props.events.length) + " 条"),
          e(
            "button",
            {
              style: debugStyles.button,
              onClick: props.onToggle,
            },
            props.collapsed === true ? "展开" : "收起",
          ),
        ),
        props.collapsed === true
          ? null
          : e(
              "div",
              { style: { maxHeight: "150px", overflow: "auto" } },
              lines.length === 0 ? e("div", { style: debugStyles.empty }, "控制台暂无输出。") : e("pre", { style: debugStyles.pre }, lines.join("\n")),
            ),
      );
    }

    /** 证据目录里的回放候选：打开选择器时才拉一次。 */
    function useEvidence(open) {
      const [value, setValue] = useState({ root: "", files: [], usage: null });
      const [error, setError] = useState("");
      const [tick, setTick] = useState(0);
      useEffect(() => {
        if (!open) return undefined;
        let closed = false;
        const load = async () => {
          const result = await callApi("GET", "evidence");
          if (closed) return;
          if (result.ok) {
            setValue({
              root: String(result.value.evidence.root ?? ""),
              files: result.value.evidence.files ?? [],
              usage: result.value.evidence.usage ?? null,
            });
            setError("");
          } else {
            setError(result.error);
          }
        };
        load();
        return () => {
          closed = true;
        };
      }, [open, tick]);
      return { root: value.root, files: value.files, usage: value.usage, error: error, reload: () => setTick((previous) => previous + 1) };
    }

    /** 载入一份证据文件。回放期间面板只读这份数据，不混入实时事件。 */
    function useReplay() {
      const [replay, setReplay] = useState(null);
      const [error, setError] = useState("");
      const [busy, setBusy] = useState(false);
      const load = async (path) => {
        setBusy(true);
        const result = await callApi("GET", "replay?path=" + encodeURIComponent(path));
        setBusy(false);
        if (result.ok) {
          const value = result.value.replay;
          setReplay({ file: String(value.file ?? path), events: value.events ?? [], skipped: Number(value.skipped ?? 0) });
          setError("");
        } else {
          setError(result.error);
        }
      };
      const clear = () => {
        setReplay(null);
        setError("");
      };
      return { replay: replay, error: error, busy: busy, load: load, clear: clear };
    }

    /** 把当前视图导出成证据格式的 JSONL，便于随对话一起交付。 */
    function exportEvents(events) {
      const text = events.map((event) => JSON.stringify(event)).join("\n") + (events.length === 0 ? "" : "\n");
      const blob = new Blob([text], { type: "application/x-ndjson" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "stm32-debug-" + new Date().toISOString().replace(/[:.]/gu, "-") + ".jsonl";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /** 回放选择器：列出证据目录里的 jsonl，点一个即载入。 */
    function ReplayPicker(props) {
      const evidence = useEvidence(true);
      const rows = evidence.files.length === 0
        ? [e("div", { key: "empty", style: debugStyles.empty }, evidence.error === "" ? "证据目录里还没有文件（环形缓冲溢出时才落盘）。" : evidence.error)]
        : evidence.files.map((file) =>
            e(
              "button",
              {
                key: file.path,
                type: "button",
                style: Object.assign({}, debugStyles.button, { textAlign: "left", marginBottom: "2px", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }),
                title: file.path,
                disabled: props.busy === true,
                onClick: () => props.onLoad(file.path),
              },
              file.path + "  " + bytesText(file.size),
            ),
          );
      const usage = evidence.usage;
      const usageText = usage === null ? "" : String(usage.count) + " 个文件 · " + bytesText(usage.bytes);
      const prune = async () => {
        const result = await callApi("POST", "evidence/prune", {});
        if (result.ok) {
          const pruned = result.value.pruned;
          props.onMessage(
            "清理 " + String((pruned.removedDirs ?? []).length) + " 个目录、删掉 " + String(pruned.removedFiles ?? 0) + " 个文件（" + bytesText(pruned.removedBytes ?? 0) + "）",
          );
          evidence.reload();
        } else {
          props.onMessage(result.error);
        }
      };
      return e(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "4px", padding: "6px 0" } },
        e("div", { style: { fontSize: "12px", opacity: 0.7, display: "flex", gap: "8px", flexWrap: "wrap" }, title: evidence.root },
          e("span", { style: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "证据目录：" + (evidence.root === "" ? "—" : evidence.root)),
          usageText === "" ? null : e("span", { style: { opacity: 0.75 } }, usageText),
          e("button", { type: "button", style: debugStyles.button, onClick: prune, title: "删掉 7 天前、或超出 20 个会话的旧证据" }, "清理旧证据"),
        ),
        rows,
      );
    }

    function DebugConsole(props) {
      const sessionId = props !== null && typeof props === "object" && typeof props.sessionId === "string" ? props.sessionId : "";
      const { events, connection } = useDebugEvents(sessionId);
      const [status, setStatus] = useState(null);
      useEffect(() => {
        let closed = false;
        const load = async () => {
          const result = await callApi("GET", sessionId === "" ? "status" : "status?session=" + encodeURIComponent(sessionId));
          if (!closed && result.ok) setStatus(result.value.status);
        };
        load();
        const timer = setInterval(load, 60_000);
        return () => {
          closed = true;
          clearInterval(timer);
        };
      }, [sessionId]);
      const [selectedSeq, setSelectedSeq] = useState(null);
      const [picked, setPicked] = useState([]);
      const [pickNote, setPickNote] = useState("");
      const [pickerOpen, setPickerOpen] = useState(false);
      const [pickerMessage, setPickerMessage] = useState("");
      const [onlyFail, setOnlyFail] = useState(false);
      const [focusFailures, setFocusFailures] = useState(0);
      const replayState = useReplay();
      const [filter, setFilter] = useState("");
      const [layout, setLayout] = useState(readDebugLayout);
      const dragRef = React.useRef(null);
      const selected = (replayState.replay === null ? events : replayState.replay.events).find((event) => event.seq === selectedSeq) ?? null;

      const matchedBase = onlyFail === true ? events.filter((event) => event.status === "fail") : events;
      const matched = filter.trim() === ""
        ? matchedBase
        : matchedBase.filter((event) => (String(event.kind) + " " + String(event.summary)).toLowerCase().includes(filter.trim().toLowerCase()));
      const visible = replayState.replay === null ? matched : replayState.replay.events;
      const pickedSet = new Set(picked);
      const pickedEvents = picked
        .map((seq) => visible.find((event) => event.seq === seq))
        .filter((event) => event !== undefined);

      const togglePick = (event) => {
        setPickNote("");
        setPicked((previous) => (previous.includes(event.seq) ? previous.filter((seq) => seq !== event.seq) : previous.concat([event.seq])));
      };

      const copyPicked = () => {
        const text = eventRefBlock(pickedEvents);
        if (text === "") {
          setPickNote("先勾选几条事件。");
          return;
        }
        const clipboard = typeof navigator === "object" && navigator !== null ? navigator.clipboard : null;
        if (clipboard !== null && clipboard !== undefined && typeof clipboard.writeText === "function") {
          clipboard
            .writeText(text)
            .then(() => setPickNote("已复制 " + String(pickedEvents.length) + " 条引用"))
            .catch(() => setPickNote("复制失败：浏览器没有给剪贴板权限"));
          return;
        }
        setPickNote("复制失败：当前环境没有剪贴板接口");
      };

      const updateLayout = (patch) => {
        setLayout((previous) => {
          const next = Object.assign({}, previous, patch);
          writeDebugLayout(next);
          return next;
        });
      };

      const startDrag = (side) => (event) => {
        event.preventDefault();
        dragRef.current = { side, startX: event.clientX, left: layout.left, right: layout.right };
      };

      useEffect(() => {
        const onMove = (event) => {
          const drag = dragRef.current;
          if (drag === null) return;
          const delta = event.clientX - drag.startX;
          if (drag.side === "left") {
            updateLayout({ left: Math.max(180, Math.min(720, drag.left + delta)) });
          } else {
            updateLayout({ right: Math.max(180, Math.min(720, drag.right - delta)) });
          }
        };
        const onUp = () => {
          dragRef.current = null;
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        return () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
      });

      const collapsed = layout.collapsed ?? {};
      const panels = [];
      if (collapsed.timeline !== true) {
        panels.push(
          e(Timeline, {
            key: "timeline",
            events: visible,
            connection,
            selectedSeq,
            pickedSet,
            onPick: togglePick,
            onSelect: (event) => setSelectedSeq(event.seq),
            onCollapse: () => updateLayout({ collapsed: Object.assign({}, collapsed, { timeline: true }) }),
            flex: "0 0 " + String(layout.left) + "px",
          }),
          e("div", {
            key: "divider-left",
            style: debugStyles.divider,
            onPointerDown: startDrag("left"),
            title: "拖动改宽；双击恢复默认",
            onDoubleClick: () => updateLayout({ left: 300 }),
          }),
        );
      }
      panels.push(e(Detail, { key: "detail", event: selected }));
      if (collapsed.channels !== true) {
        panels.push(
          e("div", {
            key: "divider-right",
            style: debugStyles.divider,
            onPointerDown: startDrag("right"),
            title: "拖动改宽；双击恢复默认",
            onDoubleClick: () => updateLayout({ right: 300 }),
          }),
          e(Channels, {
            key: "channels",
            events: visible,
            sessionId: sessionId,
            focusFailures: focusFailures,
            onShowFailures: () => {
              setOnlyFail(true);
              setFocusFailures((previous) => previous + 1);
            },
            onCollapse: () => updateLayout({ collapsed: Object.assign({}, collapsed, { channels: true }) }),
            flex: "0 0 " + String(layout.right) + "px",
          }),
        );
      }

      const drawerItems = [];
      if (collapsed.timeline === true) drawerItems.push({ key: "timeline", label: DEBUG_LABELS.timeline });
      if (collapsed.channels === true) drawerItems.push({ key: "channels", label: DEBUG_LABELS.channels });

      return e(
        "div",
        { style: debugStyles.page },
        e(StatusBar, { events, connection, status }),
        e(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "8px" } },
          e("input", {
            style: debugStyles.input,
            placeholder: "筛选工具名或摘要",
            value: filter,
            onChange: (event) => setFilter(event.target.value),
          }),
          e(
            "button",
            {
              style: Object.assign({}, debugStyles.button, onlyFail === true ? { borderColor: "color-mix(in srgb, currentColor 45%, transparent)" } : {}),
              onClick: () => setOnlyFail((value) => !value),
            },
            onlyFail === true ? "只看失败" : "全部事件",
          ),
          e("span", { style: { opacity: 0.6 } }, "显示 " + String(visible.length) + " / " + String(events.length)),
          e("span", { style: debugStyles.spacer }),
          e(
            "button",
            {
              style: Object.assign({}, debugStyles.button, picked.length === 0 ? { opacity: 0.5 } : {}),
              disabled: picked.length === 0,
              title: "把勾选的事件按时间线顺序拼成一段引用，贴进对话即可",
              onClick: copyPicked,
            },
            "复制已选（" + String(pickedEvents.length) + "）",
          ),
          picked.length === 0
            ? null
            : e("button", { style: debugStyles.button, onClick: () => { setPicked([]); setPickNote(""); } }, "清空勾选"),
          pickNote === ""
            ? null
            : e("span", { style: { opacity: 0.75, fontSize: "12px" } }, pickNote),
          e("button", { style: debugStyles.button, onClick: () => setSelectedSeq(null) }, "清除选择"),
          e("button", { style: debugStyles.button, onClick: () => exportEvents(visible) }, "导出 JSONL"),
          e(
            "button",
            {
              style: debugStyles.button,
              onClick: () => (replayState.replay === null ? setPickerOpen((open) => !open) : replayState.clear()),
            },
            replayState.replay === null ? "回放…" : "退出回放",
          ),
        ),
        pickerMessage === "" ? null : e("div", { style: { padding: "2px 10px", opacity: 0.75, fontSize: "12px" } }, pickerMessage),
        pickerOpen === true && replayState.replay === null ? e(ReplayPicker, { busy: replayState.busy, onLoad: (path) => replayState.load(path), onMessage: (text) => setPickerMessage(text) }) : null,
        replayState.error !== "" ? e("div", { style: { fontSize: "12px", opacity: 0.8, padding: "4px 0" } }, "回放失败：" + replayState.error) : null,
        replayState.replay === null
          ? null
          : e(
              "div",
              { style: { display: "flex", gap: "8px", alignItems: "center", fontSize: "12px", padding: "4px 0", opacity: 0.85 } },
              e("span", { style: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: replayState.replay.file }, "回放：" + replayState.replay.file + "（" + String(replayState.replay.events.length) + " 条" + (replayState.replay.skipped > 0 ? "，跳过 " + String(replayState.replay.skipped) : "") + "）"),
              e("span", { style: { opacity: 0.7 } }, "实时事件已暂停显示"),
            ),
        e("div", { style: debugStyles.grid }, panels),
        e(ConsolePanel, {
          events: visible,
          collapsed: collapsed.console === true,
          onToggle: () => updateLayout({ collapsed: Object.assign({}, collapsed, { console: collapsed.console !== true }) }),
        }),
        drawerItems.length === 0
          ? null
          : e(
              "div",
              { style: debugStyles.drawer },
              e("span", { style: { opacity: 0.7 } }, "已收起"),
              drawerItems.map((item) =>
                e(
                  "button",
                  {
                    key: item.key,
                    style: debugStyles.button,
                    onClick: () => {
                      const next = Object.assign({}, collapsed);
                      delete next[item.key];
                      updateLayout({ collapsed: next });
                    },
                  },
                  item.label + " ↗",
                ),
              ),
            ),
      );
    }

    /* ------------------------------ 插件入口 ------------------------------ */

    /** 客户端插件只声明 slots（注册 settings.section 与 conversation.view 需要该声明）。 */
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
      // 调试台：与「对话」「上下文」「编队」并列的主窗口标签，按会话渲染。
      ctx.effect(
        () =>
          ctx.slots.inject("conversation.view", () =>
            ctx.slots.register(
              {
                name: "conversation.view",
                id: "stm32-debug",
                order: 40,
                label: () => "调试台",
                inject: (sessionId) => ({ sessionId }),
              },
              DebugConsole,
            ),
          ),
        "dsh-stm32: debug console",
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
