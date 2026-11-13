/**
 * 原理图检查：把模型里「不像是有意为之」的地方翻成可执行的告警。
 *
 * 规则只做能给出证据的判断：每个发现都带元件位号/引脚号或网络名。
 * 无法从原理图确定的事（引脚复用该选哪一路、外部上拉该多大）不猜，留在模型里给人看。
 *
 * 与 `.ioc` 的对照只看引脚是否配置，不看配置成了什么信号：信号选择需要 CubeMX db 的
 * 复用表（`stm32_sch_pins` 给出候选），不属于检查规则。
 */

import { readFileSync } from "node:fs";

import type { SchematicReport } from "./model.js";
import { crossCheckPcb, readPcb, type PcbCheckReport } from "./pcb.js";

export type Severity = "error" | "warning" | "info";

export interface CheckFinding {
  readonly rule: string;
  readonly severity: Severity;
  readonly message: string;
  readonly evidence: string;
}

export interface IocCompare {
  readonly file: string;
  /** `.ioc` 里配置的引脚数。 */
  readonly configured: number;
  /** `.ioc` 配了、原理图里没有接网络的主控引脚。 */
  readonly unconnected: readonly string[];
  /** 原理图里接了网络、但 `.ioc` 没有配置的主控引脚。 */
  readonly notConfigured: readonly string[];
}

export interface CheckReport {
  readonly findings: readonly CheckFinding[];
  readonly summary: { readonly errors: number; readonly warnings: number; readonly infos: number };
  readonly pcb: PcbCheckReport | null;
  readonly ioc: IocCompare | null;
}

/** 支持版本：KiCad 10 的文件版本号。其它版本照常解析，但只当作未验证。 */
export const KICAD_SCH_VERSION = 20260306;

/** 从 `.ioc` 文本里取「引脚 → 配置键」。只认 `PA9.S_USART1_TX` 这类引脚键。 */
export function readIocPins(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([A-Z][A-Z0-9]*\d+)\.([A-Za-z0-9_]+) *=/u.exec(line.trim());
    if (match === null) continue;
    const pin = match[1] as string;
    const key = match[2] as string;
    if (!/^P[A-Z]\d+$/u.test(pin)) continue;
    if (key === "GPIO_Label" || key === "Locked") continue;
    const list = out.get(pin) ?? [];
    list.push(key);
    out.set(pin, list);
  }
  return out;
}

export function checkSchematic(schematic: SchematicReport, options: { pcbFile?: string; iocFile?: string } = {}): CheckReport {
  const findings: CheckFinding[] = [];
  const add = (rule: string, severity: Severity, message: string, evidence: string): void => {
    findings.push({ rule, severity, message, evidence });
  };

  if (schematic.version !== KICAD_SCH_VERSION) {
    add(
      "sch.version-unsupported",
      "warning",
      `原理图文件版本 ${schematic.version} 未验证：当前只按 KiCad 10（${KICAD_SCH_VERSION}）解析`,
      schematic.rootFile,
    );
  }
  if (schematic.generator !== "" && schematic.generator !== "eeschema") {
    add("sch.generator-unknown", "warning", `生成器不是 eeschema：${schematic.generator}`, schematic.rootFile);
  }

  for (const component of schematic.components) {
    if (component.value === "") add("component.no-value", "warning", `元件 ${component.ref} 没有填写值`, component.ref);
    if (component.footprint === "" && (component.ref.startsWith("U") || component.ref.startsWith("J"))) {
      add("component.no-footprint", "warning", `元件 ${component.ref} 没有绑定封装，PCB 对账会跳过它`, component.ref);
    }
  }

  for (const net of schematic.nets) {
    if (net.kind === "power" && net.labels.length > 0) {
      add("net.power-label-conflict", "warning", `电源网络 ${net.name} 上同时有标号 ${net.labels.join("、")}`, net.name);
    }
    if (net.pins.length > 1 && net.name.startsWith("N$")) {
      add("net.unnamed", "info", `网络 ${net.name} 连了 ${net.pins.length} 个引脚但没有名字`, net.name);
    }
  }

  const mcu = schematic.mcu;
  if (mcu === null) {
    add("mcu.missing", "error", "没有识别到 STM32 主控：无法检查调试口与电源", schematic.rootFile);
  } else {
    // KiCad 的 STM32 符号通常把 PA13/PA14 当普通引脚，调试口靠网络标号表达
    // （本工程是 SYS_SWDIO / SYS_SWCLK）。两种来源都认，避免只看引脚名漏判。
    const pinNetNames = mcu.pins.map((pin) => `${pin.name.toUpperCase()}=${pin.net.toUpperCase()}`);
    const hasNet = (pattern: RegExp): boolean => mcu.pins.some((pin) => pattern.test(pin.name) || pattern.test(pin.net));
    const netOfPin = (pattern: RegExp): string => {
      const pin = mcu.pins.find((item) => pattern.test(item.name));
      if (pin !== undefined) return pin.net;
      const net = schematic.nets.find((item) => pattern.test(item.name));
      return net === undefined ? "" : net.name;
    };
    void pinNetNames;
    if (!hasNet(/SWDIO/u)) {
      add("mcu.swd-missing", "error", `${mcu.ref} 的 SWDIO 未连接：原理图里既没有该引脚名，也没有含 SWDIO 的网络`, mcu.ref);
    }
    if (!hasNet(/SWCLK/u)) {
      add("mcu.swd-missing", "error", `${mcu.ref} 的 SWCLK 未连接：原理图里既没有该引脚名，也没有含 SWCLK 的网络`, mcu.ref);
    }
    if (netOfPin(/BOOT0/u) === "" && !mcu.pins.some((pin) => /BOOT0/u.test(pin.net))) {
      add("mcu.boot0-missing", "warning", `${mcu.ref} 的 BOOT0 未连接：启动方式不确定`, mcu.ref);
    }
    const powerOpen = mcu.pins.filter((pin) => pin.type === "power_in" && pin.net === "").map((pin) => pin.name);
    if (powerOpen.length > 0) {
      add("mcu.power-missing", "error", `${mcu.ref} 有电源引脚未连接：${powerOpen.join("、")}`, mcu.ref);
    }
    const floating = mcu.pins
      .filter((pin) => pin.net === "" && !pin.noConnect && pin.type !== "power_in" && pin.name !== "~")
      .map((pin) => pin.name);
    if (floating.length > 0) {
      add("mcu.pins-open", "info", `${mcu.ref} 有 ${floating.length} 个引脚未连接：${floating.slice(0, 12).join("、")}`, mcu.ref);
    }
  }

  for (const component of schematic.components) {
    for (const pin of component.pins) {
      if (pin.noConnect && pin.net !== "" && !pin.net.startsWith("N$")) {
        add("no-connect.conflict", "warning", `${component.ref}.${pin.number} 标了不连接，却接在 ${pin.net} 上`, `${component.ref}.${pin.number}`);
      }
    }
  }

  let pcb: PcbCheckReport | null = null;
  if (options.pcbFile !== undefined) {
    try {
      const report = readPcb(options.pcbFile);
      pcb = crossCheckPcb(schematic, report);
      if (pcb.split.length > 0) {
        add(
          "pcb.net-split",
          "warning",
          `${pcb.split.length} 条 PCB 网络在原理图里被拆成多段（常见原因：电源符号直接压在引脚上）：${pcb.split.slice(0, 3).map((item) => item.net).join("、")}`,
          options.pcbFile,
        );
      }
      if (pcb.nameMismatches.length > 0) {
        add(
          "pcb.net-name-mismatch",
          "info",
          `${pcb.nameMismatches.length} 个焊盘的原理图网络名与 PCB 不同（连通性一致）`,
          pcb.nameMismatches[0] === undefined ? "" : `${pcb.nameMismatches[0].ref}.${pcb.nameMismatches[0].number}`,
        );
      }
      if (pcb.missingPads.length > 0) {
        add(
          "pcb.pad-missing",
          "warning",
          `${pcb.missingPads.length} 个原理图引脚在 PCB 上没有同名焊盘`,
          `${pcb.missingPads[0]?.ref ?? ""}.${pcb.missingPads[0]?.number ?? ""}`,
        );
      }
    } catch (error) {
      add("pcb.read-failed", "error", `PCB 读取失败：${error instanceof Error ? error.message : String(error)}`, options.pcbFile);
    }
  }

  let ioc: IocCompare | null = null;
  if (options.iocFile !== undefined) {
    try {
      const pins = readIocPins(readFileSync(options.iocFile, "utf8"));
      const mcuPins = schematic.mcu?.pins ?? [];
      const netByPin = new Map(mcuPins.map((pin) => [pin.name.toUpperCase(), pin.net]));
      const unconnected = [...pins.keys()].filter((pin) => (netByPin.get(pin) ?? "") === "");
      const notConfigured = [...netByPin.entries()]
        .filter(([name, net]) => /^P[A-Z]\d+$/u.test(name) && net !== "" && !pins.has(name))
        .map(([name]) => name);
      ioc = { file: options.iocFile, configured: pins.size, unconnected: unconnected.sort(), notConfigured: notConfigured.sort() };
      if (unconnected.length > 0) {
        add("ioc.pin-unused", "info", `.ioc 配置了 ${unconnected.length} 个引脚，原理图里没有连网络：${unconnected.slice(0, 8).join("、")}`, options.iocFile);
      }
      if (notConfigured.length > 0) {
        add("ioc.pin-missing", "warning", `原理图里接了网络、.ioc 没有配置：${notConfigured.slice(0, 8).join("、")}`, options.iocFile);
      }
    } catch (error) {
      add("ioc.read-failed", "error", `.ioc 读取失败：${error instanceof Error ? error.message : String(error)}`, options.iocFile);
    }
  }

  for (const warning of schematic.warnings) {
    add("sch.warning", "info", warning, schematic.rootFile);
  }

  const summary = {
    errors: findings.filter((item) => item.severity === "error").length,
    warnings: findings.filter((item) => item.severity === "warning").length,
    infos: findings.filter((item) => item.severity === "info").length,
  };
  return { findings, summary, pcb, ioc };
}
