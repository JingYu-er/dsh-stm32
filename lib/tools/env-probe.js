/**
 * L3：stm32_env_probe —— 一次性回答"这台机器现在能不能编译/烧录/调试/生成工程"。
 *
 * 只读操作：不写文件、不改配置，可安全重复调用。结果里每条能力都带
 * found / path / version / hint，缺什么、怎么补一目了然。
 */
import { resolveSearchConfig } from "../data/search-roots.js";
import { buildTargets, probeAll } from "../engine/probe.js";
export const ENV_PROBE_TOOL = "stm32_env_probe";
const probeItemSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        id: { type: "string" },
        label: { type: "string" },
        found: { type: "boolean" },
        path: { type: "string" },
        version: { type: "string" },
        required: { type: "boolean" },
        hint: { type: "string" },
        error: { type: "string" },
    },
    required: ["id", "label", "found", "path", "version", "required", "hint", "error"],
};
export const outputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        platform: { type: "string" },
        summary: { type: "string" },
        missingRequired: { type: "array", items: { type: "string" } },
        tools: { type: "array", items: probeItemSchema },
    },
    required: ["platform", "summary", "missingRequired", "tools"],
};
function formatOutput(value) {
    const lines = [];
    lines.push(value.summary);
    for (const tool of value.tools) {
        const mark = tool.found ? "OK  " : tool.required ? "MISS" : "----";
        const version = tool.version === "" ? "" : "  " + tool.version;
        const where = tool.path === "" ? "" : "  " + tool.path;
        lines.push(mark + "  " + tool.id + version + where);
        if (!tool.found && tool.error !== "")
            lines.push("        " + tool.error);
    }
    if (value.missingRequired.length > 0) {
        lines.push("");
        lines.push("缺失的必需组件：" + value.missingRequired.join(", "));
        for (const tool of value.tools) {
            if (!tool.found && tool.required)
                lines.push("- " + tool.id + ": " + tool.hint);
        }
    }
    return [{ type: "text", text: lines.join("\n") }];
}
export function registerEnvProbe(ctx) {
    ctx.tools.register({
        name: ENV_PROBE_TOOL,
        description: "探测本机 STM32 工具链是否就绪（arm-none-eabi-gcc、GDB、OpenOCD、CMake、Ninja、STM32CubeMX 及内置 JRE），返回每个组件的路径、版本与缺失时的修复提示。只读、可重复调用。默认搜索 msys64 优先、ST bundle 兜底，可用参数或环境变量 STM32_BIN_DIRS / STM32_CUBEMX_ROOT 覆盖。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                binDirs: {
                    type: "array",
                    items: { type: "string" },
                    description: "额外的二进制目录（正斜杠路径），优先于默认 msys64 列表；不传则用默认值。",
                },
                cubeMxRoots: {
                    type: "array",
                    items: { type: "string" },
                    description: "STM32CubeMX 安装根目录候选；不传则用默认值。",
                },
            },
            required: [],
        },
        timeoutMs: 120_000,
        isConcurrencySafe: () => true,
        output: {
            schema: outputSchema,
            render: (_args, value) => formatOutput(value),
        },
        async execute(rawArgs, exec) {
            const subprocess = ctx.get("subprocess");
            if (subprocess === undefined) {
                return {
                    platform: process.platform + "/" + process.arch,
                    summary: "宿主缺少 subprocess 服务，无法探测工具链",
                    missingRequired: ["subprocess"],
                    tools: [],
                };
            }
            const args = rawArgs ?? {};
            const config = resolveSearchConfig(process.env, {
                ...(args.binDirs === undefined ? {} : { binDirs: args.binDirs }),
                ...(args.cubeMxRoots === undefined ? {} : { cubeMxRoots: args.cubeMxRoots }),
            });
            const results = await probeAll(subprocess, buildTargets(config), config, {
                signal: exec.signal,
            });
            const found = results.filter((item) => item.found).length;
            const missingRequired = results
                .filter((item) => item.required && !item.found)
                .map((item) => item.id);
            const ready = missingRequired.length === 0;
            const summary = (ready ? "工具链就绪" : "工具链不完整") +
                "：" +
                String(found) +
                "/" +
                String(results.length) +
                " 项可用" +
                (missingRequired.length === 0 ? "" : "，缺 " + missingRequired.join(", "));
            return {
                platform: process.platform + "/" + process.arch,
                summary,
                missingRequired,
                tools: results,
            };
        },
    });
}
