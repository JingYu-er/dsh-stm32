/**
 * L3：stm32_route_plan —— 这个工程该走 HAL 还是寄存器。
 *
 * 与"通用对照表"的区别：必须绑到一个真工程 + 一句真需求。同一个外设，读一次温度和
 * 多通道 DMA 连续采样不是一件事，抽象评分会逼用户在他没想清的场景上做选择。
 *
 * 它不做三件事：不写盘、不起进程（除了门禁的版本探测）、不替用户改 .ioc。
 * 输出是"每个外设的代价/风险 + 一条建议"，外加工具链分流：
 *   · pacman 能补的（gcc/gdb/openocd/cmake/ninja）→ 可代装，给 stm32_env_install 的路
 *   · CubeMX / 固件包 → 只能人装，给 guides[]（含离线整目录拷贝的做法）
 */

import { readFileSync } from "node:fs";

import { resolveSearchConfig } from "../data/search-roots.js";
import type { InstallGuide } from "../data/install-guides.js";
import { firmwareGuide } from "../data/install-guides.js";
import { findIocFile } from "../engine/generate.js";
import { summarizeIoc } from "../engine/ioc.js";
import {
  assessRoute,
  familyOf,
  findFirmwarePackage,
  type FirmwareCheck,
  type RouteAssessment,
} from "../engine/route-plan.js";
import { ensureToolchain, type GateResult } from "../engine/toolchain-gate.js";
import type { DshContext, JsonSchema, ToolExec } from "../types.js";
import { resolveProjectDir } from "./project-dir.js";

export const ROUTE_PLAN_TOOL = "stm32_route_plan";

/** CubeMX 在 .ioc 里会写这三条虚拟条目，它们不是外设，不能当"已使能"的证据。 */
const VIRTUAL_IOC_IPS: ReadonlySet<string> = new Set(["nvic", "rcc", "sys"]);

const deviceSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    matchedBy: { type: "array", items: { type: "string" } },
    advice: { type: "string", enum: ["hal", "register", "hal-required"] },
    halEffort: { type: "number" },
    halRisk: { type: "number" },
    halSetup: { type: "string" },
    regEffort: { type: "number" },
    regRisk: { type: "number" },
    regSetup: { type: "string" },
    reason: { type: "string" },
  },
  required: [
    "id",
    "label",
    "matchedBy",
    "advice",
    "halEffort",
    "halRisk",
    "halSetup",
    "regEffort",
    "regRisk",
    "regSetup",
    "reason",
  ],
};

const missingSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    installability: { type: "string", enum: ["auto", "manual"] },
    hint: { type: "string" },
    firstInstall: { type: "string" },
    verify: { type: "string" },
  },
  required: ["id", "label", "installability", "hint", "firstInstall", "verify"],
};

const firmwareSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    found: { type: "boolean" },
    family: { type: "string" },
    packageName: { type: "string" },
    path: { type: "string" },
    incomplete: { type: "boolean" },
    message: { type: "string" },
  },
  required: ["found", "family", "packageName", "path", "incomplete", "message"],
};

const stepSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    detail: { type: "string" },
    command: { type: "string" },
  },
  required: ["title", "detail", "command"],
};

const guideSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    component: { type: "string" },
    label: { type: "string" },
    why: { type: "string" },
    sizeHint: { type: "string" },
    needsAccount: { type: "boolean" },
    steps: { type: "array", items: stepSchema },
    verify: { type: "string" },
    portable: { type: "string" },
  },
  required: ["component", "label", "why", "sizeHint", "needsAccount", "steps", "verify", "portable"],
};

export const outputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    message: { type: "string" },
    projectDir: { type: "string" },
    mcu: { type: "string" },
    family: { type: "string" },
    requirement: { type: "string" },
    verdict: { type: "string", enum: ["hal-only", "both-viable", "register-ok", "unclear"] },
    verdictLabel: { type: "string" },
    devices: { type: "array", items: deviceSchema },
    unknown: { type: "array", items: { type: "string" } },
    delta: { type: "array", items: { type: "string" } },
    halSteps: { type: "array", items: { type: "string" } },
    regSteps: { type: "array", items: { type: "string" } },
    toolchainCapability: { type: "string" },
    toolchainOk: { type: "boolean" },
    toolchainMessage: { type: "string" },
    toolchainDetail: { type: "string" },
    missing: { type: "array", items: missingSchema },
    firmware: firmwareSchema,
    guides: { type: "array", items: guideSchema },
    recommendations: { type: "array", items: { type: "string" } },
    notes: { type: "array", items: { type: "string" } },
  },
  required: [
    "ok",
    "message",
    "projectDir",
    "mcu",
    "family",
    "requirement",
    "verdict",
    "verdictLabel",
    "devices",
    "unknown",
    "delta",
    "halSteps",
    "regSteps",
    "toolchainCapability",
    "toolchainOk",
    "toolchainMessage",
    "toolchainDetail",
    "missing",
    "firmware",
    "guides",
    "recommendations",
    "notes",
  ],
};

interface RoutePlanArgs {
  projectDir?: string;
  mcu?: string;
  requirement?: string;
  peripherals?: string[];
  envCheck?: string;
}

interface DeviceValue {
  id: string;
  label: string;
  matchedBy: string[];
  advice: string;
  halEffort: number;
  halRisk: number;
  halSetup: string;
  regEffort: number;
  regRisk: number;
  regSetup: string;
  reason: string;
}

interface MissingValue {
  id: string;
  label: string;
  installability: string;
  hint: string;
  firstInstall: string;
  verify: string;
}

interface FirmwareValue {
  found: boolean;
  family: string;
  packageName: string;
  path: string;
  incomplete: boolean;
  message: string;
}

interface GuideValue {
  component: string;
  label: string;
  why: string;
  sizeHint: string;
  needsAccount: boolean;
  steps: { title: string; detail: string; command: string }[];
  verify: string;
  portable: string;
}

export interface RoutePlanValue {
  ok: boolean;
  message: string;
  projectDir: string;
  mcu: string;
  family: string;
  requirement: string;
  verdict: string;
  verdictLabel: string;
  devices: DeviceValue[];
  unknown: string[];
  delta: string[];
  halSteps: string[];
  regSteps: string[];
  toolchainCapability: string;
  toolchainOk: boolean;
  toolchainMessage: string;
  toolchainDetail: string;
  missing: MissingValue[];
  firmware: FirmwareValue;
  guides: GuideValue[];
  recommendations: string[];
  notes: string[];
}

const ADVICE_LABEL: Record<string, string> = {
  hal: "用 HAL",
  register: "可以寄存器",
  "hal-required": "必须 HAL",
};

function emptyFirmware(family: string, message: string): FirmwareValue {
  return { found: false, family, packageName: "", path: "", incomplete: false, message };
}

/** 早退也得是完整形状（宿主按 output.schema 校验）。 */
function emptyValue(message: string, projectDir = ""): RoutePlanValue {
  return {
    ok: false,
    message,
    projectDir,
    mcu: "",
    family: "",
    requirement: "",
    verdict: "unclear",
    verdictLabel: "还没看出要做什么外设",
    devices: [],
    unknown: [],
    delta: [],
    halSteps: [],
    regSteps: [],
    toolchainCapability: "",
    toolchainOk: false,
    toolchainMessage: "",
    toolchainDetail: "",
    missing: [],
    firmware: emptyFirmware("", ""),
    guides: [],
    recommendations: [],
    notes: [],
  };
}

function toGuideValue(guide: InstallGuide): GuideValue {
  return {
    component: guide.component,
    label: guide.label,
    why: guide.why,
    sizeHint: guide.sizeHint,
    needsAccount: guide.needsAccount,
    steps: guide.steps.map((step) => ({ title: step.title, detail: step.detail, command: step.command ?? "" })),
    verify: guide.verify,
    portable: guide.portable ?? "",
  };
}

function toFirmwareValue(check: FirmwareCheck): FirmwareValue {
  return {
    found: check.found,
    family: check.family,
    packageName: check.packageName,
    path: check.path,
    incomplete: check.incomplete,
    message: check.message,
  };
}

function toDevices(assessment: RouteAssessment): DeviceValue[] {
  return assessment.devices.map((device) => ({
    id: device.id,
    label: device.label,
    matchedBy: [...device.matchedBy],
    advice: device.advice,
    halEffort: device.hal.effort,
    halRisk: device.hal.risk,
    halSetup: device.hal.setup,
    regEffort: device.reg?.effort ?? 0,
    regRisk: device.reg?.risk ?? 0,
    regSetup: device.reg?.setup ?? "",
    reason: device.reason,
  }));
}

function toMissing(gate: GateResult): MissingValue[] {
  return gate.missing.map((item) => ({
    id: item.id,
    label: item.label,
    installability: item.installability,
    hint: item.hint,
    firstInstall: item.install[0] ?? "",
    verify: item.verify,
  }));
}

/** 卡片正文：先给结论，再给每个外设一行，最后给路线步骤与缺件。 */
function formatValue(value: RoutePlanValue): string[] {
  const lines: string[] = [];
  lines.push(value.message);
  lines.push("");
  lines.push("MCU：" + (value.mcu === "" ? "（没说）" : value.mcu) + (value.family === "" ? "" : "，族 " + value.family) + "　工程：" + value.projectDir);
  lines.push("需求：" + value.requirement);
  if (value.devices.length > 0) {
    lines.push("");
    lines.push("外设（代价/风险 1 最省 → 5 最费）：");
    for (const device of value.devices) {
      const reg = device.advice === "hal-required" ? "寄存器：不做" : "寄存器：" + String(device.regEffort) + "/" + String(device.regRisk);
      lines.push(
        "  " + device.label.padEnd(28) + (ADVICE_LABEL[device.advice] ?? device.advice).padEnd(12)
        + "HAL：" + String(device.halEffort) + "/" + String(device.halRisk) + "　" + reg,
      );
      lines.push("    " + device.reason);
    }
  }
  if (value.delta.length > 0) {
    lines.push("");
    lines.push("两条路的差别：");
    for (const line of value.delta) lines.push("  · " + line);
  }
  const steps = value.verdict === "register-ok" ? value.regSteps : value.halSteps;
  if (steps.length > 0) {
    lines.push("");
    lines.push(value.verdict === "register-ok" ? "寄存器版怎么落地：" : "HAL 版怎么落地：");
    for (const [index, step] of steps.entries()) lines.push("  " + String(index + 1) + ". " + step);
  }
  lines.push("");
  lines.push("工具链（" + value.toolchainCapability + "）：" + value.toolchainMessage);
  if (value.toolchainCapability === "generate" || value.firmware.family !== "") {
    lines.push("固件包：" + value.firmware.message);
  }
  if (value.missing.length > 0) {
    lines.push("");
    lines.push("缺件：");
    for (const item of value.missing) {
      lines.push("  · " + item.label + "（" + (item.installability === "auto" ? "可代装" : "只能人装") + "）：" + item.hint);
      if (item.firstInstall !== "") lines.push("    " + item.firstInstall);
    }
  }
  if (value.guides.length > 0) {
    lines.push("");
    lines.push("要你自己装的部分：");
    for (const guide of value.guides) {
      lines.push("  【" + guide.label + "】" + guide.why);
      lines.push("    体积：" + guide.sizeHint);
      for (const [index, step] of guide.steps.entries()) {
        lines.push("    " + String(index + 1) + ". " + step.title + " —— " + step.detail);
      }
      lines.push("    自检：" + guide.verify);
      if (guide.portable !== "") lines.push("    免安装：" + guide.portable);
    }
  }
  if (value.recommendations.length > 0) {
    lines.push("");
    for (const line of value.recommendations) lines.push("→ " + line);
  }
  for (const note of value.notes) lines.push("· " + note);
  return lines;
}

export function registerRoutePlan(ctx: DshContext): void {
  ctx.tools.register({
    name: ROUTE_PLAN_TOOL,
    description:
      "评估一个具体工程该走 HAL（.ioc + CubeMX 生成）还是寄存器（手写 main.c）：按这句需求逐个外设给出开发代价与出错风险，并对工具链缺件分流（pacman 能补的 vs 只能人装的 CubeMX/固件包）。必须绑具体工程与一句需求；不做通用对照表。只读：不写盘、不改 .ioc。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        requirement: {
          type: "string",
          description: "一句话说清要做什么，例如「按键控制 LED，串口每秒打印状态」。识别外设靠这句话。",
        },
        peripherals: {
          type: "array",
          items: { type: "string" },
          description: "显式点名的外设（可选），例如 [\"usart-poll\", \"tim-pwm\", \"adc-single\"] 或中文「串口」「PWM」。",
        },
        projectDir: { type: "string", description: "工程根目录；缺省为会话工作目录。" },
        mcu: { type: "string", description: "芯片型号，例如 STM32F103C8T6；缺省取 .ioc 里的 Mcu.CPN。" },
        envCheck: {
          type: "string",
          enum: ["block", "warn", "off"],
          description: "工具链检查档位：block（默认，缺就明确告诉你）／warn（只警告）／off（不查）。",
        },
      },
      required: ["requirement"],
    },
    output: {
      schema: outputSchema,
      render: (_args, value) => {
        const typed = value as RoutePlanValue;
        if (typed.devices.length === 0 && typed.message !== "") return [{ type: "text", text: typed.message }];
        return [{ type: "text", text: formatValue(typed).join("\n") }];
      },
    },
    timeoutMs: 60_000,
    // A16：execute 会读工程目录并起子进程探版本命令，不是并发安全的。
    isConcurrencySafe: () => false,
    async execute(rawArgs: RoutePlanArgs | undefined, exec: ToolExec): Promise<RoutePlanValue> {
      const args = rawArgs ?? {};
      const requirement = typeof args.requirement === "string" ? args.requirement.trim() : "";
      if (requirement === "") {
        return emptyValue(
          "requirement 必填：一句话说清要做什么，例如「按键控制 LED，串口每秒打印一次状态」。"
          + "只有把要用的外设说出来，才能判断 HAL 与寄存器哪条划算。",
        );
      }

      const resolution = await resolveProjectDir(ctx, args.projectDir, exec);
      const projectDir = resolution.projectDir;
      const notes: string[] = [];
      if (resolution.note !== null) notes.push(resolution.note);

      let iocPeripherals: string[] = [];
      let iocMcu = "";
      const iocPath = findIocFile(projectDir);
      if (iocPath === null) {
        notes.push("工程里没有 .ioc（寄存器版工程本来就没有）：外设只按需求这句话和 peripherals 识别。");
      } else {
        try {
          const summary = summarizeIoc(readFileSync(iocPath, "utf8"), iocPath);
          // .ioc 里的 NVIC / RCC / SYS 是 CubeMX 的虚拟系统条目，不是用户外设：
          // 当成"证据"会让 notes 说「已把 3 个外设算作证据」而表里只有 2 个，纯噪声。
          iocPeripherals = summary.peripherals.filter((name) => !VIRTUAL_IOC_IPS.has(name.toLowerCase()));
          iocMcu = summary.mcu.cpn;
        } catch (error) {
          notes.push("读 .ioc 失败，已跳过它的外设证据：" + String(error));
        }
      }

      const mcu = typeof args.mcu === "string" && args.mcu.trim() !== "" ? args.mcu.trim() : iocMcu;
      const family = familyOf(mcu);
      const assessment = assessRoute({
        requirement,
        peripherals: Array.isArray(args.peripherals) ? args.peripherals : [],
        iocPeripherals,
      });

      // 寄存器版只要编译器；HAL 版必须有 CubeMX（生成代码的人不是我们）。
      const capability: "build" | "generate" = assessment.verdict === "register-ok" ? "build" : "generate";
      // A16：连外设都没认出来（unclear）时先别探工具链 —— 用户这会儿要补的是需求，不是装工具。
      const gate = assessment.verdict === "unclear" ? null : await ensureToolchain(ctx, {
        capability,
        ...(args.envCheck === undefined ? {} : { envCheck: args.envCheck }),
        signal: exec.signal,
      });

      const searchConfig = resolveSearchConfig(process.env);
      const firmwareCheck = findFirmwarePackage(searchConfig.cubeMxRoots, mcu);
      const firmware = toFirmwareValue(firmwareCheck);

      const guides: GuideValue[] = gate === null ? [] : gate.guides.map(toGuideValue);
      const needsHal = assessment.verdict !== "register-ok" && assessment.verdict !== "unclear";
      if (needsHal && !firmwareCheck.found) {
        const fallbackRepository = firmwareCheck.repositoryDir !== ""
          ? firmwareCheck.repositoryDir
          : (searchConfig.cubeMxRoots[0] === undefined ? "" : searchConfig.cubeMxRoots[0] + "/Repository");
        if (fallbackRepository === "") {
          notes.push("本机没探测到 CubeMX 安装根：guide 里的固件包落位要你自己填 <CubeMX安装目录>/Repository。");
        }
        const guide = firmwareGuide({
          family: firmwareCheck.family === "" ? family : firmwareCheck.family,
          packageName: firmwareCheck.packageName,
          repositoryDir: fallbackRepository,
        });
        guides.push(toGuideValue(guide));
      }

      const recommendations = [...assessment.recommendations];
      if (assessment.verdict !== "register-ok" && !firmwareCheck.found) {
        recommendations.push("固件包还没有：CubeMX 的包管理器里装一次（guide 里有步骤），装完 route_plan 会自己认出来。");
      }
      if (gate !== null && gate.missing.some((item) => item.installability === "auto")) {
        recommendations.push("能代装的缺件：回一句「装」，我先跑 stm32_env_install 出计划（只列大小与步骤，不下载）。");
      }

      // A16：ok 只回答「路线评估本身成了吗」。缺工具链只进 notes / guides / recommendations，
      // 以前和 gate.ok 相与会把「评估成功、只是这台机器还没装工具」吞成 ok:false。
      const ok =
        assessment.verdict !== "unclear"
        && (assessment.verdict === "register-ok" || firmwareCheck.found);
      if (gate !== null && !gate.ok) notes.push(gate.message);

      const parts: string[] = [];
      if (assessment.verdict === "unclear") {
        parts.push("这句需求里我没认出外设，先说说要用什么（或直接列 peripherals）。");
      } else if (assessment.verdict === "hal-only") {
        parts.push(
          "这条只能走 HAL（.ioc + CubeMX 生成）："
          + assessment.devices.filter((device) => device.advice === "hal-required").map((device) => device.label).join("、")
          + " 的寄存器版等于重写协议栈/内核。",
        );
      } else if (assessment.verdict === "register-ok") {
        parts.push("寄存器版够用：" + String(assessment.devices.length) + " 个外设都能直接写寄存器，不需要 CubeMX 与固件包。");
      } else {
        parts.push("两条路都能走，建议 HAL（省事、可读），寄存器版只在代价低的那几项上划算。");
      }
      if (assessment.verdict !== "register-ok" && assessment.verdict !== "unclear") {
        parts.push(firmwareCheck.found ? "固件包已就位。" : "固件包还没装（CubeMX 包管理器装一次）。");
      }
      if (gate !== null && !gate.ok) parts.push("工具链缺 " + gate.missing.map((item) => item.label).join("、") + "。");

      return {
        ok,
        message: parts.join(""),
        projectDir,
        mcu,
        family,
        requirement,
        verdict: assessment.verdict,
        verdictLabel: assessment.verdictLabel,
        devices: toDevices(assessment),
        unknown: [...assessment.unknown],
        delta: [...assessment.delta],
        halSteps: [...assessment.halSteps],
        regSteps: [...assessment.regSteps],
        toolchainCapability: gate === null ? "none" : capability,
        toolchainOk: gate === null ? false : gate.ok,
        toolchainMessage: gate === null ? "没检查：需求里的外设还没认出来，先补需求。" : gate.message,
        toolchainDetail: gate === null ? "unclear：按审计 A16 跳过工具链探测。" : gate.detail,
        missing: gate === null ? [] : toMissing(gate),
        firmware,
        guides,
        recommendations,
        notes: [...notes, ...assessment.notes],
      };
    },
  });
}
