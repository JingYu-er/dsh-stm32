/**
 * MCU 事实文件（S184）：dsh-stm32 把 .ioc 里的事实写成一份 JSON，别的插件只读它。
 *
 * 设计约束：单一写者、工程相对路径、带来源指纹（sha256 + mtime）、字段稳定排序，
 * 同一输入同字节，便于提交与 diff。事实不是配置：手改这个文件没有意义，下一次生成会覆盖。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { readPinout } from "./pinout.js";
import { resolveProjectLayout } from "./project-layout.js";

/** 契约版本：别的插件按这个号判断能不能读。 */
export const MCU_INFO_SCHEMA = "dsh-mcu/1";

export interface McuInfoPin {
  readonly pin: string;
  readonly signal: string;
  readonly label: string;
  readonly mode: string;
}

export interface McuInfo {
  readonly schema: string;
  readonly generator: { readonly plugin: string; readonly version: string };
  readonly generatedAt: string;
  readonly source: { readonly ioc: string; readonly iocSha256: string; readonly iocMtimeMs: number };
  readonly mcu: { readonly cpn: string; readonly name: string; readonly family: string; readonly package: string };
  readonly clock: {
    readonly sysclkHz: number | null;
    readonly ahbHz: number | null;
    readonly apb1Hz: number | null;
    readonly apb2Hz: number | null;
  };
  readonly debug: { readonly serialWire: boolean; readonly jtag: boolean; readonly pins: readonly string[] };
  readonly nvicCount: number;
  readonly pins: readonly McuInfoPin[];
  readonly peripherals: readonly string[];
  readonly notes: readonly string[];
}

export interface McuInfoResult {
  readonly ok: boolean;
  readonly error: string;
  readonly file: string;
  readonly written: boolean;
  readonly info: McuInfo | null;
}

export const EMPTY_MCU_INFO: McuInfoResult = { ok: false, error: "", file: "", written: false, info: null };

/** 事实文件位置：<工程>/dsh/mcu.json（与 hardware/、program/ 并列，不进构建产物目录）。 */
export function mcuInfoPath(projectDir: string): string {
  return join(projectDir, "dsh", "mcu.json");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function pluginVersion(): string {
  try {
    const text = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(text) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "";
  } catch {
    return "";
  }
}

/** 把 .ioc 的事实收成契约对象；.ioc 都没有就直说，不编造。 */
export function collectMcuInfo(projectDir: string, env: NodeJS.ProcessEnv = process.env): McuInfoResult {
  const dir = projectDir.trim();
  if (dir === "") return { ...EMPTY_MCU_INFO, error: "projectDir 不能为空" };
  // .ioc 常在 program/ 或 fw/ 下：先按工程约定找到程序目录，再读引脚。
  const layout = resolveProjectLayout(dir);
  const pinout = readPinout(layout.firmwareDir, env);
  if (!pinout.ok) return { ...EMPTY_MCU_INFO, error: pinout.error };
  const report = pinout.report;
  let iocText = "";
  let iocMtimeMs = 0;
  try {
    iocText = readFileSync(report.iocPath, "utf8");
    iocMtimeMs = Math.round(statSync(report.iocPath).mtimeMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...EMPTY_MCU_INFO, error: "读取 .ioc 失败：" + message };
  }
  const notes: string[] = [];
  if (report.clocks.sysclkHz === null) notes.push("时钟树里没有算出 SYSCLK：.ioc 可能没配 RCC。");
  if (!report.debug.serialWire) notes.push("没有启用 Serial Wire：烧录后可能连不上调试口。");
  if (report.warnings.length > 0) notes.push("引脚检查有 " + String(report.warnings.length) + " 条提醒，见 stm32_ioc_inspect。");
  const info: McuInfo = {
    schema: MCU_INFO_SCHEMA,
    generator: { plugin: "dsh-stm32", version: pluginVersion() },
    generatedAt: new Date().toISOString(),
    source: {
      ioc: relative(dir, report.iocPath).replace(/\\/gu, "/"),
      iocSha256: sha256(iocText),
      iocMtimeMs,
    },
    mcu: { cpn: report.mcu.cpn, name: report.mcu.name, family: report.mcu.family, package: report.mcu.package },
    clock: {
      sysclkHz: report.clocks.sysclkHz,
      ahbHz: report.clocks.ahbHz,
      apb1Hz: report.clocks.apb1Hz,
      apb2Hz: report.clocks.apb2Hz,
    },
    debug: { serialWire: report.debug.serialWire, jtag: report.debug.jtag, pins: [...report.debug.pins] },
    nvicCount: report.nvicCount,
    pins: report.pins.map((pin) => ({ pin: pin.pin, signal: pin.signal, label: pin.label, mode: pin.mode })),
    peripherals: [...report.peripherals],
    notes,
  };
  return { ok: true, error: "", file: mcuInfoPath(dir), written: false, info };
}

/** 读一份已有的事实文件；坏 JSON 与不认识的 schema 都当「读不了」。 */
export function readMcuInfo(file: string): { ok: boolean; error: string; info: McuInfo | null } {
  if (!existsSync(file)) return { ok: false, error: "还没有 MCU 事实文件：" + file, info: null };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as McuInfo;
    if (typeof parsed.schema !== "string" || !parsed.schema.startsWith("dsh-mcu/")) {
      return { ok: false, error: "事实文件的 schema 不认识：" + String(parsed.schema), info: null };
    }
    return { ok: true, error: "", info: parsed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: "事实文件不是合法 JSON：" + message, info: null };
  }
}

/** 原子写：先写 .tmp 再 rename，避免消费方读到半截文件。 */
export function writeMcuInfo(file: string, info: McuInfo): { ok: boolean; error: string } {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const temp = file + ".tmp";
    writeFileSync(temp, JSON.stringify(info, null, 2) + "\n", "utf8");
    renameSync(temp, file);
    return { ok: true, error: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: "写 MCU 事实文件失败：" + message };
  }
}

/**
 * 陈旧判定：拿文件里的 iocSha256 与当前 .ioc 比。
 * 不拿 mtime 当唯一依据——git checkout、复制工程都会让 mtime 变但内容没变。
 */
export function mcuInfoFreshness(info: McuInfo, projectDir: string): { stale: boolean; reason: string } {
  const iocFile = join(projectDir, info.source.ioc);
  if (!existsSync(iocFile)) return { stale: true, reason: "事实文件指向的 .ioc 不存在：" + info.source.ioc };
  let text = "";
  try {
    text = readFileSync(iocFile, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { stale: true, reason: "读 .ioc 失败：" + message };
  }
  if (sha256(text) !== info.source.iocSha256) {
    return { stale: true, reason: ".ioc 改过了（内容指纹不同）：重新跑一次 stm32_board_info 并 write" };
  }
  return { stale: false, reason: "" };
}
