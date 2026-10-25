/**
 * L3：stm32_env_install —— 把"这台机器缺工具链"变成一次可复核的安装。
 *
 * 为什么默认只出计划：装 MSYS2 要写几百 MB 磁盘、要从网上下安装包、还要改用户级 PATH，
 * 这些都不是"看一眼"能顺手做的事。所以本工具先给一张卡片（装哪、下多大、做哪几步、要不要
 * 决策），用户看过之后再说 confirm:true + dryRun:false 才真装。
 *
 * 为什么不做卸载：删目录这种事一旦做错没法撤销，而且用户自己的东西可能就放在那个目录里；
 * 需要卸载就自己删目录 + 删配置项（nextStep / notes 会写清楚）。
 *
 * 为什么 PATH 只写用户级：机器级 PATH 要管理员权限，插件不请求提权；用户级 PATH 已经够让
 * 命令行和其他工具找到 ucrt64\bin。
 */
import { formatBytes, msys2StepSkeleton, planOrInstallMsys2, viaLabel, } from "../engine/msys2-install.js";
export const ENV_INSTALL_TOOL = "stm32_env_install";
/** 步骤状态的短标记：卡片上一眼能扫出哪一步没过去。 */
const STEP_MARK = {
    pending: "[  ]",
    running: "[..]",
    done: "[OK]",
    skipped: "[--]",
    failed: "[!!]",
};
/**
 * 合法的 pacman 包名形状：字母/数字/@/./_/+，且不以 - 开头。
 * 为什么必须自己校验：包名会被原样拼进 "pacman -S --noconfirm --needed <包…>" 再交给 bash -lc——
 * 以 - 开头会被 pacman 当成选项（等于把开关交给调用方），带空格/引号/& | ; $ 的还会被 bash 二次解释。
 */
const PACKAGE_NAME_PATTERN = /^[A-Za-z0-9@._+][A-Za-z0-9@._+-]*$/u;
/** 挑出不合法的包名（原样返回，便于报错里点名）；全部合法时是空数组。 */
export function invalidPackageNames(packages) {
    return packages.filter((name) => !PACKAGE_NAME_PATTERN.test(name));
}
/* ------------------------------ schema ------------------------------ */
const stepSchema = {
    type: "object",
    description: "安装步骤及其结果",
    additionalProperties: false,
    properties: {
        id: { type: "string" },
        label: { type: "string" },
        status: {
            type: "string",
            enum: ["pending", "running", "done", "skipped", "failed"],
        },
        detail: { type: "string" },
    },
    required: ["id", "label", "status", "detail"],
};
const downloadSchema = {
    type: "object",
    description: "安装包地址与体量",
    additionalProperties: false,
    properties: {
        url: { type: "string" },
        bytes: { type: "number" },
        cached: { type: "boolean", description: "本机已有有效缓存，不会再下载" },
    },
    required: ["url", "bytes", "cached"],
};
const pathSchema = {
    type: "object",
    description: "用户级 PATH（HKCU\\Environment）的处理结果",
    additionalProperties: false,
    properties: {
        done: { type: "boolean" },
        changed: { type: "boolean" },
        before: { type: "string" },
        after: { type: "string" },
        backup: { type: "string", description: "旧 PATH 的备份文件；没写 PATH 时为空串" },
        error: { type: "string" },
    },
    required: ["done", "changed", "before", "after", "backup", "error"],
};
const configSchema = {
    type: "object",
    description: "工具链配置（~/.dsh-stm32/config.json）的写入结果",
    additionalProperties: false,
    properties: {
        path: { type: "string" },
        written: { type: "boolean" },
        error: { type: "string" },
    },
    required: ["path", "written", "error"],
};
const verifyToolSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        id: { type: "string" },
        label: { type: "string" },
        found: { type: "boolean" },
        version: { type: "string" },
    },
    required: ["id", "label", "found", "version"],
};
const verifySchema = {
    type: "object",
    description: "装完的自检结果",
    additionalProperties: false,
    properties: {
        ok: { type: "boolean" },
        tools: { type: "array", items: verifyToolSchema },
    },
    required: ["ok", "tools"],
};
const reportSchema = {
    type: "object",
    description: "安装计划 / 安装结果",
    additionalProperties: false,
    properties: {
        ok: { type: "boolean" },
        mode: { type: "string", enum: ["plan", "install"] },
        needsDecision: {
            type: "string",
            enum: ["", "msys64Dir"],
            description: "非空表示装哪还没定，什么都还没做",
        },
        msys64: { type: "string", description: "计划/实际安装根（正斜杠绝对路径）" },
        resolvedVia: {
            type: "string",
            enum: ["arg", "config", "discovered", "suggested", ""],
            description: "安装根是怎么定下来的",
        },
        binDirs: { type: "array", items: { type: "string" } },
        packages: { type: "array", items: { type: "string" } },
        steps: { type: "array", items: stepSchema },
        download: downloadSchema,
        path: pathSchema,
        config: configSchema,
        verify: verifySchema,
        message: { type: "string" },
        nextStep: { type: "string" },
        notes: { type: "array", items: { type: "string" } },
        durationMs: { type: "number" },
    },
    required: [
        "ok",
        "mode",
        "needsDecision",
        "msys64",
        "resolvedVia",
        "binDirs",
        "packages",
        "steps",
        "download",
        "path",
        "config",
        "verify",
        "message",
        "nextStep",
        "notes",
        "durationMs",
    ],
};
export const outputSchema = {
    type: "object",
    description: "stm32_env_install 的结果：后台作业句柄 + 计划/安装报告",
    additionalProperties: false,
    properties: {
        mode: {
            type: "string",
            enum: ["job", "report"],
            description: "job = 真装在后台跑（用 job_output 读进度）；report = 同步返回",
        },
        jobId: { type: "string" },
        message: { type: "string" },
        report: reportSchema,
    },
    required: ["mode", "jobId", "message", "report"],
};
/**
 * 缺服务/提前错误时也要给完整形状。
 * 为什么不能省字段：宿主按 output.schema 严格校验，缺字段或 null 会让整个工具结果不可读。
 */
function emptyReport(message, mode) {
    return {
        ok: false,
        mode,
        needsDecision: "",
        msys64: "",
        resolvedVia: "",
        binDirs: [],
        packages: [],
        steps: [],
        download: { url: "", bytes: 0, cached: false },
        path: { done: false, changed: false, before: "", after: "", backup: "", error: "" },
        config: { path: "", written: false, error: "" },
        verify: { ok: false, tools: [] },
        message,
        nextStep: "",
        notes: [],
        durationMs: 0,
    };
}
/** 引擎允许 download 为 null（没有下载这个概念），schema 不允许 null：这里归一成空结构。 */
function toToolReport(report) {
    return {
        ...report,
        download: report.download ?? { url: "", bytes: 0, cached: false },
    };
}
/* ------------------------------ 文字卡 ------------------------------ */
export function formatInstallReport(report, running = false) {
    const lines = [];
    // running：后台 job 还没跑完就返回的那张卡片。此时 report 是"要做的事"的骨架，
    // 套「安装未完成」会读成失败，所以单独给一个「安装进行中」的抬头。
    const headline = running
        ? "安装进行中"
        : report.mode === "install"
            ? report.ok
                ? "安装完成"
                : "安装未完成"
            : report.needsDecision === ""
                ? ""
                : "需要决定安装位置";
    // 计划模式的 message 自己已经把语气写全了（"计划（还没动手）：…"），再套一层标题会重复。
    lines.push(headline === "" ? report.message : headline + "：" + report.message);
    if (report.msys64 !== "") {
        lines.push("安装位置：" + report.msys64 + "（来源：" + viaLabel(report.resolvedVia) + "）");
    }
    if (report.download !== null) {
        lines.push("安装包：" +
            report.download.url +
            "（" +
            formatBytes(report.download.bytes) +
            (report.download.cached ? "，本机已缓存" : "，需要下载") +
            "）");
    }
    if (report.packages.length > 0)
        lines.push("组件：" + report.packages.join("、"));
    if (report.steps.length > 0) {
        lines.push("步骤：");
        for (const step of report.steps) {
            lines.push("  " + STEP_MARK[step.status] + "  " + step.label);
            if (step.detail !== "") {
                for (const part of step.detail.split("\n"))
                    lines.push("        " + part);
            }
        }
    }
    if (report.path.changed) {
        lines.push("用户 PATH：已追加" +
            (report.path.backup === "" ? "" : "（旧值备份 " + report.path.backup + "）"));
    }
    else if (report.path.done) {
        lines.push("用户 PATH：已包含目标 bin 目录，没有重复写");
    }
    else if (report.path.error !== "") {
        // 计划模式根本没去写注册表：措辞不能是「没写成功」（那读起来像写坏了）。
        const head = report.mode === "plan" ? "用户 PATH：不会写 —— " : "用户 PATH：没写成功 —— ";
        lines.push(head + (report.path.error.split("\n")[0] ?? ""));
    }
    else if (report.path.after !== "" && report.path.after !== report.path.before) {
        lines.push("用户 PATH：真装时会追加一条（写前先备份旧值）");
    }
    else {
        lines.push("用户 PATH：不动");
    }
    if (report.config.written) {
        lines.push("配置：已写入 " + report.config.path);
    }
    else if (report.config.error !== "") {
        lines.push("配置：写失败 —— " + report.config.error);
    }
    else if (report.config.path !== "") {
        lines.push("配置：" + report.config.path + "（还没写入）");
    }
    if (report.verify.tools.length > 0) {
        lines.push("自检：" + (report.verify.ok ? "全部可用" : "有缺失"));
        for (const item of report.verify.tools) {
            lines.push("  " + (item.found ? "OK  " : "MISS") + "  " + item.id + (item.version === "" ? "" : "  " + item.version));
        }
    }
    else if (report.mode === "plan") {
        lines.push("自检：真装完成后按安装目录跑 gcc / cmake / ninja / openocd / gdb 的版本命令");
    }
    if (report.notes.length > 0) {
        lines.push("说明：");
        for (const note of report.notes)
            lines.push("  · " + note);
    }
    if (report.nextStep !== "")
        lines.push("下一步：" + report.nextStep);
    return lines;
}
/* ------------------------------ 注册 ------------------------------ */
export function registerEnvInstall(ctx) {
    ctx.tools.register({
        name: ENV_INSTALL_TOOL,
        description: "安装/补装 STM32 工具链（MSYS2 + arm-none-eabi-gcc / gdb-multiarch / openocd / cmake / ninja）。" +
            "默认只出计划：列出装到哪、安装包多大、要做哪几步，不下载、不建目录、不写注册表、不改配置。" +
            "真装必须同时给 dryRun:false 与 confirm:true；装到哪先按 targetDir > 配置 msys64 > 自动发现决定，" +
            "都没有就返回 needsDecision 并建议 C:/msys64，绝不猜路径。" +
            "PATH 只写用户级（HKCU\\Environment，写前备份，已在其中就不重复写），不请求管理员权限。" +
            "刻意不做卸载：要删就删安装目录并去掉配置里的 msys64 / binDirs。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                targetDir: {
                    type: "string",
                    description: "MSYS2 安装根目录（正斜杠绝对路径，例如 D:/msys64）；不给就从配置/自动发现里找",
                },
                packages: {
                    type: "array",
                    items: { type: "string" },
                    description: "要 pacman 装的包；不给就用默认的 5 个工具链组件",
                },
                dryRun: {
                    type: "boolean",
                    description: "默认 true：只出计划。必须是 false 才可能真装（且还要 confirm:true）",
                },
                confirm: {
                    type: "boolean",
                    description: "确认真的动磁盘/网络/注册表；默认 false",
                },
                writePath: {
                    type: "boolean",
                    description: "是否把 <msys64>/ucrt64/bin 追加到用户级 PATH；默认 true（失败不致命）",
                },
                foreground: {
                    type: "boolean",
                    description: "true = 同步等装完再返回；默认后台 job（用 job_output 看进度）",
                },
                timeoutMs: {
                    type: "number",
                    description: "下载/解压/pacman 单步超时，默认 15 分钟",
                },
            },
            required: [],
        },
        timeoutMs: 30 * 60_000,
        isConcurrencySafe: () => false,
        output: {
            schema: outputSchema,
            render: (_args, value) => {
                const typed = value;
                // job 模式的 report 已经是 mode="install" 的骨架，抬头由 running 控制（不能再叠一遍 message）。
                const lines = formatInstallReport(typed.report, typed.mode === "job");
                if (typed.mode === "job") {
                    // 真正的进度在 job 输出里，卡片只负责说清"去哪儿看"。
                    lines.push("job：" + typed.jobId + "（用 job_output 读进度，job_kill 停止）");
                }
                return [{ type: "text", text: lines.join("\n") }];
            },
        },
        async execute(rawArgs, exec) {
            const args = rawArgs ?? {};
            const subprocess = ctx.get("subprocess");
            // 只有"明确说不 dryRun"且"明确确认"才算真装：两个开关都到位，用户才真的点了头。
            const realInstall = args.dryRun === false && args.confirm === true;
            const mode = realInstall ? "install" : "plan";
            if (subprocess === undefined) {
                const report = emptyReport("宿主缺少 subprocess 服务，无法安装工具链", mode);
                return { mode: "report", jobId: "", message: report.message, report };
            }
            // A33：包名先过一遍白名单。绝不把调用方给的字符串直接拼进 pacman 命令行（也不做猜测式改名）。
            if (args.packages !== undefined) {
                const invalid = invalidPackageNames(args.packages);
                if (invalid.length > 0) {
                    const report = emptyReport("包名不合法：" +
                        invalid.map((name) => JSON.stringify(name)).join("、") +
                        "；没有执行任何命令，也没下载任何东西（不会替你猜或改名）。", mode);
                    report.nextStep =
                        "用 pacman 的完整包名重试，例如 mingw-w64-ucrt-x86_64-cmake；多个包用数组分别给。";
                    report.notes = [
                        "包名会原样拼进 pacman 的命令行：以 - 开头会被 pacman 当成选项，带空格或引号、& | ; $ 等字符会被 bash 二次解释，所以这里先拒掉。",
                        "合法形状：字母 / 数字 / @ / . / _ / +，且第一个字符不能是 -。",
                    ];
                    return { mode: "report", jobId: "", message: report.message, report };
                }
            }
            const base = {
                ...(args.targetDir === undefined ? {} : { targetDir: args.targetDir }),
                ...(args.packages === undefined ? {} : { packages: args.packages }),
                writePath: args.writePath !== false,
                ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
            };
            // 真装前也先算一次计划：卡片上先把"装哪、多大、做什么"讲清楚 —— 计划本身零副作用，
            // 而且装了没定位置时正好在这里把 needsDecision 交给用户。
            const plan = toToolReport(await planOrInstallMsys2(subprocess, { ...base, mode: "plan", signal: exec.signal }, process.env));
            if (!realInstall) {
                return { mode: "report", jobId: "", message: plan.message, report: plan };
            }
            if (plan.needsDecision !== "") {
                // 装哪都不知道就别开 job：先说清楚需要用户决定什么。
                return { mode: "report", jobId: "", message: plan.message, report: plan };
            }
            const jobs = ctx.get("jobs");
            if (args.foreground === true || jobs === undefined) {
                const report = toToolReport(await planOrInstallMsys2(subprocess, { ...base, mode: "install", signal: exec.signal }, process.env));
                return { mode: "report", jobId: "", message: report.message, report };
            }
            // 下载 + 解压 + pacman 是分钟级：默认丢后台，前端可以边看进度边等。
            const controller = new AbortController();
            const jobId = jobs.start({
                kind: "stm32-env-install",
                label: ENV_INSTALL_TOOL + " " + plan.msys64,
                ...(exec.agent === undefined ? {} : { owner: exec.agent.id }),
                run: (handle) => {
                    handle.append("开始安装 MSYS2：" + plan.msys64 + "（来源：" + viaLabel(plan.resolvedVia) + "）\n");
                    // A36：工具被取消时 job 也得停。job_kill 走下面的 cancel()，宿主取消整个工具（或用户按了停止）
                    // 走 exec.signal —— 两条路都要把 controller 掐掉，否则后台还在下载/解压。
                    const bridgeAbort = () => controller.abort();
                    if (exec.signal.aborted)
                        controller.abort();
                    exec.signal.addEventListener("abort", bridgeAbort);
                    const detach = () => exec.signal.removeEventListener("abort", bridgeAbort);
                    const done = planOrInstallMsys2(subprocess, {
                        ...base,
                        mode: "install",
                        signal: controller.signal,
                        // 每步开始一行：用户能在 job 输出里看到"现在在干什么"，而不是干等。
                        onProgress: (line) => handle.append(line + "\n"),
                    }, process.env)
                        .then((result) => {
                        detach();
                        const report = toToolReport(result);
                        handle.append("\n" + formatInstallReport(report).join("\n") + "\n");
                        return {
                            status: report.ok ? "completed" : "failed",
                            detail: report.message,
                        };
                    })
                        // 引擎正常情况下不抛（失败都写进 report），但取消/内部异常若漏出来，
                        // 不能让 job 卡在 running：留一句中文原因，job 标记失败。
                        .catch((error) => {
                        detach();
                        const reason = error instanceof Error ? error.message : String(error);
                        const text = (controller.signal.aborted ? "已取消：" : "安装异常终止：") + reason;
                        handle.append("\n" + text + "\n");
                        return { status: "failed", detail: text };
                    });
                    return {
                        done,
                        cancel: (reason) => {
                            handle.append("\n被取消：" + (reason ?? "用户停止") + "\n");
                            controller.abort();
                        },
                    };
                },
            });
            // 卡片上的 message 必须说"正在装"，不能把计划模式的"还没动手"贴在一个真在跑的 job 上。
            const startMessage = "已在后台安装 MSYS2 到 " +
                plan.msys64 +
                "（来源：" +
                viaLabel(plan.resolvedVia) +
                "）：7 步依次跑，进度看 job 输出。";
            // A21：卡片不能贴计划快照（那会写着"还没动手 / 全 pending / 配置没写"，跟真在跑的 job 打架）。
            // 这里给"安装中"的骨架：mode=install、步骤全 pending（detail 保留将要执行的命令）、
            // 配置/自检/PATH 的结论都留空，等 job 输出里再报。
            const runningReport = {
                ...plan,
                mode: "install",
                ok: false,
                // 计划在"什么都不用做"时只回一句话（steps 为空），但真装 job 仍要把 7 步列出来。
                steps: (plan.steps.length > 0 ? plan.steps : msys2StepSkeleton()).map((step) => ({
                    ...step,
                    status: "pending",
                })),
                path: { done: false, changed: false, before: plan.path.before, after: plan.path.after, backup: "", error: "" },
                config: { path: plan.config.path, written: false, error: "" },
                verify: { ok: false, tools: [] },
                message: startMessage,
                nextStep: "",
                notes: plan.notes.filter((note) => !note.startsWith("这只是计划")),
            };
            return { mode: "job", jobId, message: startMessage, report: runningReport };
        },
    });
}
