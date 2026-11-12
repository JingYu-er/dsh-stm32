/**
 * L3：stm32_ioc_verify —— 使 CubeMX 输出「这份 .ioc 被识别出哪些内容」，用于排查「外设被静默丢弃」。
 *
 * 背景：CubeMX 遇到不认识的键不报错、直接丢弃。USART 写入正确、而 TIM/ADC 丢失时，
 * 生成日志中没有任何 ERROR。唯一可靠的办法是令 CubeMX 把「理解结果」写回后再对比。
 *
 * 做法：把 .ioc 复制到 .dsh-stm32/verify/<stamp>/，用无头脚本 `config load` + `config save`
 * 令 CubeMX 重写这份副本（约 25–40 s，不生成代码），再 diff 出：丢失了哪些外设、引脚信号被改成什么、
 * CubeMX 补了哪些 SH 共享信号块、计划生成哪些 MX_*_Init。工程里的 .ioc 一个字节都不改动。
 */
import { resolve } from "node:path";
import { findIocFile } from "../engine/generate.js";
import { runIocVerify } from "../engine/ioc-verify.js";
import { resolveProjectDir } from "./project-dir.js";
export const IOC_VERIFY_TOOL = "stm32_ioc_verify";
const valueChangeList = {
    type: "array",
    items: {
        type: "object",
        additionalProperties: false,
        properties: { key: { type: "string" }, before: { type: "string" }, after: { type: "string" } },
        required: ["key", "before", "after"],
    },
};
const explanationList = {
    type: "array",
    items: {
        type: "object",
        additionalProperties: false,
        properties: {
            key: { type: "string" },
            verdict: { type: "string" },
            detail: { type: "string" },
        },
        required: ["key", "verdict", "detail"],
    },
};
const diffSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        afterPeripherals: { type: "array", items: { type: "string" } },
        droppedPeripherals: { type: "array", items: { type: "string" } },
        addedPeripherals: { type: "array", items: { type: "string" } },
        plannedFunctions: { type: "array", items: { type: "string" } },
        plannedFunctionsRaw: { type: "array", items: { type: "string" } },
        signalRewrites: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                properties: { pin: { type: "string" }, before: { type: "string" }, after: { type: "string" } },
                required: ["pin", "before", "after"],
            },
        },
        sharedSignals: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                properties: { key: { type: "string" }, entries: { type: "array", items: { type: "string" } } },
                required: ["key", "entries"],
            },
        },
        removedKeys: { type: "array", items: { type: "string" } },
        addedKeys: { type: "array", items: { type: "string" } },
        changedValues: valueChangeList,
        misorderedKeys: { type: "array", items: { type: "string" } },
        attribution: {
            type: "object",
            additionalProperties: false,
            properties: {
                orderOnly: { type: "array", items: { type: "string" } },
                valueNormalized: valueChangeList,
                valueChanged: valueChangeList,
                missingKeys: { type: "array", items: { type: "string" } },
                addedKeys: { type: "array", items: { type: "string" } },
                droppedPeripherals: { type: "array", items: { type: "string" } },
                autoAddedFunctions: { type: "array", items: { type: "string" } },
                droppedReasons: explanationList,
                addedVerdicts: explanationList,
                ipOrderOnly: { type: "array", items: { type: "string" } },
                derivedRecomputed: valueChangeList,
                derivedAdded: { type: "array", items: { type: "string" } },
                ipParametersAdded: { type: "array", items: { type: "string" } },
                benign: { type: "boolean" },
            },
            required: [
                "orderOnly", "valueNormalized", "valueChanged", "missingKeys", "addedKeys",
                "droppedPeripherals", "autoAddedFunctions", "droppedReasons", "addedVerdicts",
                "ipOrderOnly", "derivedRecomputed", "derivedAdded", "ipParametersAdded", "benign",
            ],
        },
        autoAddedFunctions: { type: "array", items: { type: "string" } },
        hints: { type: "array", items: { type: "string" } },
    },
    required: [
        "afterPeripherals", "droppedPeripherals", "addedPeripherals", "plannedFunctions", "plannedFunctionsRaw",
        "signalRewrites", "sharedSignals", "removedKeys", "addedKeys", "changedValues", "misorderedKeys",
        "attribution", "autoAddedFunctions", "hints",
    ],
};
export const outputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        ok: { type: "boolean" },
        projectDir: { type: "string" },
        iocPath: { type: "string" },
        snapshotPath: { type: "string" },
        durationMs: { type: "number" },
        message: { type: "string" },
        notes: { type: "array", items: { type: "string" } },
        errors: { type: "array", items: { type: "string" } },
        diff: diffSchema,
    },
    required: ["ok", "projectDir", "iocPath", "snapshotPath", "durationMs", "message", "notes", "errors", "diff"],
};
function format(report) {
    const lines = [];
    lines.push(report.message);
    if (report.errors.length > 0) {
        for (const error of report.errors)
            lines.push("! " + error);
        return lines;
    }
    const diff = report.diff;
    lines.push("CubeMX 认了：" + (diff.afterPeripherals.join(", ") || "（没有外设）"));
    if (diff.droppedPeripherals.length > 0)
        lines.push("被丢弃：" + diff.droppedPeripherals.join(", "));
    if (diff.plannedFunctions.length > 0)
        lines.push("计划生成：" + diff.plannedFunctions.join(", "));
    for (const rewrite of diff.signalRewrites) {
        lines.push("信号被改写： " + rewrite.pin + "  " + rewrite.before + " → " + rewrite.after);
    }
    for (const block of diff.sharedSignals) {
        lines.push("共享信号块：SH." + block.key + " → " + block.entries.join("  "));
    }
    for (const change of diff.attribution.valueChanged) {
        lines.push("值被改写： " + change.key + "  " + change.before + " → " + change.after);
    }
    for (const change of diff.attribution.valueNormalized) {
        lines.push("值仅重排（语义不变）： " + change.key + "  " + change.before + " → " + change.after);
    }
    if (diff.attribution.orderOnly.length > 0) {
        lines.push("行序不同（值相同，CubeMX 按自己的顺序重排）：" + diff.attribution.orderOnly.join("、"));
    }
    if (diff.attribution.ipOrderOnly.length > 0) {
        lines.push("外设槽位重排（Mcu.IP<i> 换位置但外设集合相同，语义不变）：" + diff.attribution.ipOrderOnly.join("、"));
    }
    // 每个被丢弃的键都给出一句「CubeMX 不识别的原因」——这是排查时真正需要的信息。
    for (const reason of diff.attribution.droppedReasons) {
        if (reason.verdict === "ok")
            continue;
        lines.push("被丢键：" + reason.key + "  " + reason.detail);
    }
    const derived = diff.attribution;
    if (derived.derivedRecomputed.length > 0) {
        lines.push("派生频率被重算（*Freq_Value 由 CubeMX 按 PLL/分频算出，不是本插件写入的设定）：" +
            derived.derivedRecomputed.map((change) => change.key + "  " + change.before + " → " + change.after).join("、"));
    }
    if (derived.derivedAdded.length > 0) {
        lines.push("CubeMX 自行补的派生键（本插件未写入）：" + derived.derivedAdded.join("、"));
    }
    if (derived.ipParametersAdded.length > 0) {
        lines.push("RCC.IPParameters 中 CubeMX 自行追加的派生名：" + derived.ipParametersAdded.join("、"));
    }
    const cosmetic = derived.orderOnly.length > 0 ||
        derived.valueNormalized.length > 0 ||
        derived.derivedRecomputed.length > 0 ||
        derived.derivedAdded.length > 0 ||
        derived.ipParametersAdded.length > 0;
    lines.push(derived.benign
        ? "结论：零实质差异" + (cosmetic
            ? "（只有行序/成员序规范化与 CubeMX 自己重算的派生频率）" : "")
        : "结论：有实质差异，见上面各条");
    if (diff.autoAddedFunctions.length > 0) {
        lines.push("CubeMX 自行补的初始化清单（本插件未写入，CubeMX 保存时按既有编号追加；不影响生成正确性）：" +
            diff.autoAddedFunctions.join("、"));
    }
    for (const hint of diff.hints)
        lines.push("* " + hint);
    lines.push("副本：" + report.snapshotPath + "（工程 .ioc 未改动）");
    return lines;
}
export function registerIocVerify(ctx) {
    ctx.tools.register({
        name: IOC_VERIFY_TOOL,
        description: "由 CubeMX 自身诊断一份 .ioc：把 .ioc 复制到 .dsh-stm32/verify/ 后用无头脚本 config load + config save 写回「CubeMX 的理解结果」，再对比出「哪些外设被静默丢弃、引脚信号被规范成什么、CubeMX 补了哪些 SH 共享信号块、计划生成哪些 MX_*_Init」，并给出缺失项提示。实测一次 100–180 s（load 约需 98 s，保存完成后进程有时不退出，按日志里的 SaveConfig 判定），不生成代码、不改动工程 .ioc。改完 .ioc 却不生效、或生成结果缺少某个外设时用该工具定位。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                projectDir: { type: "string", description: "工程根目录；缺省为当前工作目录。" },
                iocPath: { type: "string", description: "显式 .ioc 路径（相对路径按 projectDir 解析）；缺省在 projectDir 里找唯一的 *.ioc。" },
                timeoutMs: { type: "number", description: "超时毫秒数，默认 180000。" },
            },
            required: [],
        },
        timeoutMs: 240_000,
        isConcurrencySafe: () => false,
        output: {
            schema: outputSchema,
            render: (_args, value) => [{ type: "text", text: format(value).join("\n") }],
        },
        async execute(rawArgs, exec) {
            const args = rawArgs ?? {};
            const subprocess = ctx.get("subprocess");
            const resolution = await resolveProjectDir(ctx, args.projectDir, exec);
            const empty = {
                ok: false, projectDir: resolution.projectDir, iocPath: "", snapshotPath: "", durationMs: 0,
                message: "", notes: [], errors: [], diff: {
                    afterPeripherals: [], droppedPeripherals: [], addedPeripherals: [], plannedFunctions: [],
                    plannedFunctionsRaw: [], signalRewrites: [], sharedSignals: [], removedKeys: [], addedKeys: [],
                    changedValues: [], misorderedKeys: [], autoAddedFunctions: [], hints: [],
                    attribution: {
                        orderOnly: [], valueNormalized: [], valueChanged: [], missingKeys: [], addedKeys: [],
                        droppedPeripherals: [], autoAddedFunctions: [], droppedReasons: [], addedVerdicts: [],
                        ipOrderOnly: [], derivedRecomputed: [], derivedAdded: [], ipParametersAdded: [], benign: true,
                    },
                },
            };
            if (subprocess === undefined) {
                return { ...empty, errors: ["宿主缺少 subprocess 服务，无法运行 CubeMX"], message: "没诊断：缺 subprocess 服务" };
            }
            const iocPath = args.iocPath === undefined ? findIocFile(resolution.projectDir) : resolve(resolution.projectDir, args.iocPath);
            if (iocPath === null) {
                return { ...empty, errors: ["在 " + resolution.projectDir + " 里没找到唯一的 *.ioc，请用 iocPath 指定"], message: "没诊断：找不到 .ioc" };
            }
            return runIocVerify(subprocess, {
                projectDir: resolution.projectDir,
                iocPath,
                ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
            });
        },
    });
}
