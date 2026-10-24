/**
 * L3：stm32_env_probe —— 一次性回答"这台机器现在能不能编译/烧录/调试/生成工程"。
 *
 * 只读操作：不写文件、不改配置，可安全重复调用。它通常是"用插件的第一步"，
 * 所以输出要能直接照着做：
 *   - 每个组件带 found / path / version / required / hint / impact / install[] / verify；
 *   - 顶层给 capabilities（四项能力是否可用）、recommendations（先装什么、什么可选、要不要我帮你装）、
 *     searched（这次查了哪些目录），缺件时不必再猜路径。
 */

import { describeSearchScope, resolveSearchConfig, searchConfigWarnings } from "../data/search-roots.js";
import { buildTargets, probeAll } from "../engine/probe.js";
import type { ProbeResult } from "../engine/probe.js";
import type { DshContext, JsonSchema, SubprocessService, ToolExec } from "../types.js";

export const ENV_PROBE_TOOL = "stm32_env_probe";

const probeItemSchema: JsonSchema = {
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
    impact: { type: "string" },
    install: { type: "array", items: { type: "string" } },
    verify: { type: "string" },
    error: { type: "string" },
  },
  required: [
    "id",
    "label",
    "found",
    "path",
    "version",
    "required",
    "hint",
    "impact",
    "install",
    "verify",
    "error",
  ],
};

const capabilitiesSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    build: { type: "boolean" },
    flash: { type: "boolean" },
    debug: { type: "boolean" },
    generate: { type: "boolean" },
  },
  required: ["build", "flash", "debug", "generate"],
};

export const outputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    platform: { type: "string" },
    summary: { type: "string" },
    missingRequired: { type: "array", items: { type: "string" } },
    capabilities: capabilitiesSchema,
    recommendations: { type: "array", items: { type: "string" } },
    searched: { type: "array", items: { type: "string" } },
    tools: { type: "array", items: probeItemSchema },
  },
  required: [
    "platform",
    "summary",
    "missingRequired",
    "capabilities",
    "recommendations",
    "searched",
    "tools",
  ],
};

interface ProbeArgs {
  binDirs?: string[];
  cubeMxRoots?: string[];
}

interface Capabilities {
  build: boolean;
  flash: boolean;
  debug: boolean;
  generate: boolean;
}

interface EnvProbeOutput {
  platform: string;
  summary: string;
  missingRequired: string[];
  capabilities: Capabilities;
  recommendations: string[];
  searched: string[];
  tools: ProbeResult[];
}

function formatOutput(value: EnvProbeOutput): Array<{ type: "text"; text: string }> {
  const lines: string[] = [];
  lines.push(value.summary);
  const caps = value.capabilities;
  lines.push(
    "能力：" +
      (caps.build ? "可编译" : "编译缺组件") +
      " / " +
      (caps.flash ? "可烧录" : "烧录缺组件") +
      " / " +
      (caps.debug ? "可调试" : "调试缺组件") +
      " / " +
      (caps.generate ? "可建工程" : "建工程需装 CubeMX（可选）"),
  );
  for (const tool of value.tools) {
    const mark = tool.found ? "OK  " : tool.required ? "MISS" : "----";
    const optional = tool.required ? "" : "（可选）";
    const version = tool.version === "" ? "" : "  " + tool.version;
    const where = tool.path === "" ? "" : "  " + tool.path;
    lines.push(mark + "  " + tool.id + optional + version + where);
    if (tool.found) continue;
    if (tool.error !== "") lines.push("        探测错误：" + tool.error);
    if (tool.impact !== "") lines.push("        影响：" + tool.impact);
    tool.install.forEach((step, index) => {
      lines.push("        " + (index === 0 ? "怎么装：" : "      或：") + step);
    });
    if (tool.verify !== "") lines.push("        自检：" + tool.verify);
  }
  if (value.searched.length > 0) {
    lines.push("");
    for (const line of value.searched) lines.push(line);
  }
  if (value.recommendations.length > 0) {
    lines.push("");
    lines.push("下一步：");
    for (const line of value.recommendations) lines.push("- " + line);
  }
  return [{ type: "text", text: lines.join("\n") }];
}

/** 把探测结果压成"能干什么"的四项能力。只由 found 决定，与 required 无关。 */
function computeCapabilities(results: ProbeResult[]): Capabilities {
  const found = new Set(results.filter((item) => item.found).map((item) => item.id));
  const has = (id: string): boolean => found.has(id);
  return {
    build: has("gcc") && has("cmake") && has("ninja"),
    flash: has("openocd"),
    debug: has("openocd") && has("gdb"),
    generate: has("cubemx") && has("cubemx-java"),
  };
}

function computeRecommendations(
  results: ProbeResult[],
  missingRequired: string[],
  capabilities: Capabilities,
): string[] {
  const lines: string[] = [];
  const missing = results.filter((item) => item.required && !item.found);
  if (missing.length === 0) {
    lines.push(
      "必需组件齐全：" +
        (capabilities.build ? "可以编译" : "但编译还缺组件") +
        "、" +
        (capabilities.flash ? "可以只烧录" : "烧录还缺 openocd") +
        "、" +
        (capabilities.debug ? "可以烧录并调试" : "调试还缺 gdb") +
        "。",
    );
  } else {
    lines.push("缺 " + missingRequired.join("、") + "。按下面的顺序装，装一项就少一项：");
    for (const item of missing) {
      const step = item.install[0] ?? item.hint;
      lines.push(item.label + "：" + step + "（自检：" + item.verify + "）");
    }
    lines.push(
      "需要我帮你装吗？回一句「装 gcc」「装 openocd」或「把缺的都装上」，我就照上面的命令在这台机器上装，装完再跑一次 stm32_env_probe 复测；你也可以自己装完再跑一次。",
    );
  }
  const cubeMx = results.find((item) => item.id === "cubemx");
  const cubeMxJava = results.find((item) => item.id === "cubemx-java");
  if (cubeMx !== undefined && !cubeMx.found) {
    lines.push(
      "CubeMX 是可选的：不影响编译、烧录、调试和改 USER CODE，只影响建工程（stm32_project_create）与改 .ioc 后的重新生成（stm32_generate）。要建工程时再装，步骤见上面 cubemx / cubemx-java 两条。",
    );
  } else if (cubeMx !== undefined && cubeMx.found && cubeMxJava !== undefined && !cubeMxJava.found) {
    lines.push(
      "CubeMX 装上了但找不到内置 JRE：无头生成（stm32_generate / stm32_project_create）会失败，建议用官网安装包重装一次（只拷 exe 不够）。",
    );
  }
  return lines;
}

function computeSearched(binDirs: string[], cubeMxRoots: string[]): string[] {
  return [
    "工具链搜索范围：" + describeSearchScope(binDirs, "PATH"),
    "CubeMX 搜索范围：" + describeSearchScope(cubeMxRoots),
  ];
}

export function registerEnvProbe(ctx: DshContext): void {
  ctx.tools.register({
    name: ENV_PROBE_TOOL,
    description:
      "探测本机 STM32 工具链是否就绪（arm-none-eabi-gcc、GDB、OpenOCD、CMake、Ninja、STM32CubeMX 及内置 JRE），返回每个组件的路径、版本，以及缺什么、缺了影响哪些功能、推荐怎么装（含可粘贴命令与自检命令）、装完是否需要我代劳。只读、可重复调用。默认搜索 msys64 优先、自动发现兜底，可用参数或环境变量 STM32_BIN_DIRS / STM32_CUBEMX_ROOT 覆盖。开始任何 STM32 工作前先跑它。",
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
      render: (_args, value) => formatOutput(value as EnvProbeOutput),
    },
    async execute(rawArgs: ProbeArgs | undefined, exec: ToolExec) {
      const subprocess = ctx.get<SubprocessService>("subprocess");
      if (subprocess === undefined) {
        return {
          platform: process.platform + "/" + process.arch,
          summary: "宿主缺少 subprocess 服务，无法探测工具链",
          missingRequired: ["subprocess"],
          capabilities: { build: false, flash: false, debug: false, generate: false },
          recommendations: ["宿主没有 subprocess 服务，先确认 dsh-stm32 的依赖服务都加载了"],
          searched: [],
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
      const capabilities = computeCapabilities(results);
      const summary =
        (ready ? "工具链就绪" : "工具链不完整") +
        "：" +
        String(found) +
        "/" +
        String(results.length) +
        " 项可用" +
        (ready ? "，可以编译/烧录/调试" : "，缺 " + missingRequired.join(", "));
      return {
        platform: process.platform + "/" + process.arch,
        summary,
        missingRequired,
        capabilities,
        recommendations: [
          // 配置里点名但本机不存在的目录先说出来：否则"我明明配了"会变成一句莫名其妙的失败。
          ...searchConfigWarnings(process.env).map((warning) => "⚠ " + warning.message),
          ...computeRecommendations(results, missingRequired, capabilities),
        ],
        searched: computeSearched(config.binDirs, config.cubeMxRoots),
        tools: results,
      };
    },
  });
}
