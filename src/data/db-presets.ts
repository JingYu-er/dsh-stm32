/**
 * 按族从 CubeMX db 派生 .ioc 外设预设（串口 / 定时器 PWM / ADC 单通道）。
 *
 * 为什么不维护手写预设表：脚位、复用信号名、参数默认值三样都随族与型号变，
 * 手抄一份表等于把手册抄一遍，抄错一根脚的表现是「plan 成功、CubeMX 一打开就丢」。
 * CubeMX 自己就有这些事实：`db/mcu/<Mcu.Name>.xml` 里每个 <Pin> 的 <Signal> 就是「这根脚能做什么」。
 *
 * 与手写表的边界（`src/data/ioc-presets.ts`）：
 *   - 能从 db 推出来的一律走这里：USART/UART/LPUART、TIMx 的 CH1..CH4 PWM、ADC 的单通道规则转换；
 *   - db 推不出来的留手写表：`TIMx:timebase`（不占脚、只有 Prescaler/Period 取值）、
 *     `DMA:<IP>`（DMA 请求表不在 db 的引脚信息里）、`ADC1:1,4,5`（多 Rank 扫描的通道顺序）。
 *
 * 两个「.ioc 里的写法与 db 不同」的坑（语料实证：CubeMX 官方板级 .ioc 504 份）：
 *   1. 定时器通道：db 写 `TIM2_CH1`，.ioc 里的 <pin>.Signal 要写 `S_TIM2_CH1`（共享信号加 S_ 前缀）；
 *   2. ADC 通道：db 写 `ADC1_IN1`，.ioc 里统一写 `ADCx_IN1`（x = 任意 ADC 实例），
 *      具体是哪个 ADC 由 SH 块的 `ADC1_IN1,IN1` 表达。
 * 这两条不能靠猜：写错就会被 CubeMX 静默丢掉（§60 记过这个坑）。
 */

import { logicalPinName, type CubemxMcuFacts } from "../engine/cubemx-db.js";
import type { PeripheralPinRole, PeripheralPreset } from "./ioc-presets.js";

/** 派生结果：preset 非空就是能用；否则 reason 说清为什么不能（直接给用户看）。 */
export interface DbPresetResult {
  preset: PeripheralPreset | null;
  reason: string;
}

/** 派生时要知道族（个别参数值是族相关的，例如 F1 的 ADC 预分频）。 */
export interface DbPresetOptions {
  familyId?: string;
}

const SERIAL_RE = /^(USART|UART|LPUART)([0-9]+)$/u;
const TIMER_RE = /^(TIM|HRTIM)([0-9A-Z]+)$/u;
const ADC_RE = /^(ADC)([0-9])$/u;

interface PinHit {
  /** db 里的引脚名（PA0-WKUP）——选脚时按它去查信号。 */
  dbPin: string;
  /** 逻辑名（PA0）——预设里写它，落键前由 ioc-plan 的 pinNameResolver 换回 db 名。 */
  logical: string;
  port: string;
  number: number;
  /** 命中的 db 信号名（TIM2_CH1 / USART1_TX / ADC1_IN1）。 */
  signal: string;
}

/** PA9 → { port: "A", number: 9 }；带后缀的 db 名也吃（PA0-WKUP → A/0）。 */
function splitPin(pin: string): { port: string; number: number } | null {
  const matched = /^P([A-Z])([0-9]{1,2})/u.exec(pin.trim().toUpperCase());
  if (matched === null) return null;
  return { port: matched[1] as string, number: Number(matched[2]) };
}

/** 按端口、脚号升序（同端口的 TX/RX 才配得成一对）。 */
function pinOrder(hit: PinHit): number {
  return (hit.port.charCodeAt(0) - 65) * 100 + hit.number;
}

/**
 * db 里带某条复用例信号的引脚，按端口/脚号升序。
 *
 * 为什么用 `logicalPinName` 而不是直接丢带后缀的引脚：F1 的 PA0 在 db 里叫 PA0-WKUP，
 * 它就是 TIM2_CH1 的默认脚。按「带 - 就跳过」会把它整根脚丢掉（F1 上 TIM2 就再也选不到脚）。
 */
function pinsWithSignal(facts: CubemxMcuFacts, signal: string): PinHit[] {
  const wanted = signal.trim().toUpperCase();
  const hits: PinHit[] = [];
  for (const [pin, fact] of facts.pins) {
    const dbPin = pin.toUpperCase();
    if (dbPin.startsWith("VP_")) continue;
    const signals = [...fact.signals.keys()].map((name) => name.toUpperCase());
    if (!signals.includes(wanted)) continue;
    const split = splitPin(dbPin);
    if (split === null) continue;
    hits.push({ dbPin, logical: logicalPinName(dbPin), port: split.port, number: split.number, signal: wanted });
  }
  hits.sort((left, right) => pinOrder(left) - pinOrder(right));
  const seen = new Set<string>();
  return hits.filter((hit) => {
    if (seen.has(hit.logical)) return false;
    seen.add(hit.logical);
    return true;
  });
}

/** db 里有没有这个 IP 实例（`Mcu.IP` 清单的真值；大小写照 CubeMX 写）。 */
function instanceNameOf(facts: CubemxMcuFacts, ip: string): string | null {
  const wanted = ip.trim().toUpperCase();
  for (const name of facts.ips.keys()) {
    if (name.toUpperCase() === wanted) return name;
  }
  return null;
}

/**
 * 串口预设：TX/RX 各自挑一根脚。
 *
 * 选脚规则（可复现，不依赖型号特例）：
 *   1. 优先同端口的一对（PA9/PA10 这种），取「端口字母最小、脚号最小」的那一对；
 *   2. 没有同端口的对，就各取一根（TX 取最小、RX 取最小），并在 notes 里说明是跨端口；
 *   3. 缺 TX 或缺 RX 直接拒绝 —— 只有单向的串口预设在这里没有意义。
 */
function deriveSerial(facts: CubemxMcuFacts, ip: string): DbPresetResult {
  const tx = pinsWithSignal(facts, ip + "_TX");
  const rx = pinsWithSignal(facts, ip + "_RX");
  if (tx.length === 0 || rx.length === 0) {
    const missing = [tx.length === 0 ? "TX" : "", rx.length === 0 ? "RX" : ""].filter((item) => item !== "");
    return {
      preset: null,
      reason:
        ip + " 在 db 里找不到可用的 " + missing.join("/") + " 引脚（这颗芯片的 " + ip +
        " 可能没引出，或只支持同步/单线模式）：换一个实例，或用 pins + entries 手写该族的键",
    };
  }
  const samePort = tx.find((left) => rx.some((right) => right.port === left.port));
  let txPick = tx[0] as PinHit;
  let rxPick = rx[0] as PinHit;
  const notes: string[] = [];
  if (samePort !== undefined) {
    txPick = samePort;
    rxPick = rx.find((hit) => hit.port === samePort.port) as PinHit;
  } else {
    notes.push(ip + "：TX(" + txPick.logical + ") 与 RX(" + rxPick.logical + ") 不在同一个端口，接线时注意");
  }
  const pins: PeripheralPinRole[] = [
    { role: "tx", defaultPin: txPick.logical, signal: ip + "_TX", mode: "Asynchronous" },
    { role: "rx", defaultPin: rxPick.logical, signal: ip + "_RX", mode: "Asynchronous" },
  ];
  return {
    preset: {
      name: ip,
      label: ip + " 异步串口（按 db 选脚 " + txPick.logical + "/" + rxPick.logical + "）",
      ip,
      pins,
      parameters: [{ name: "VirtualMode", value: "VM_ASYNC" }],
      notes: [
        ip + "：引脚是从本机 CubeMX db 里该型号的复用例表选的（" + txPick.logical + " TX / " + rxPick.logical + " RX）；" +
          "波特率等参数按 CubeMX 缺省（8N1 / 115200），要改请用 entries 设 " + ip + ".IPParameters 与对应键",
        ...notes,
      ],
    },
    reason: "",
  };
}

/**
 * 定时器 PWM 预设：`TIM2` → CH1。
 *
 * 通道信号在 db 里可能有两种写法（`TIM2_CH1` / 合并过的 `TIM2_CH1_ETR`）：两种都接受，
 * 命中哪个用哪个，但 .ioc 里统一写成 `S_<db 名>`。
 */
function deriveTimer(facts: CubemxMcuFacts, ip: string, channel: number, familyId: string): DbPresetResult {
  const base = ip + "_CH" + String(channel);
  const candidates: PinHit[] = [];
  for (const signal of [base, base + "_ETR"]) {
    candidates.push(...pinsWithSignal(facts, signal));
  }
  candidates.sort((left, right) => pinOrder(left) - pinOrder(right));
  const pick = candidates[0];
  if (pick === undefined) {
    return {
      preset: null,
      reason: ip + " 的 CH" + String(channel) + " 在 db 里没有引出引脚（这颗芯片可能没有这个通道）：" +
        "换一个通道，或用 pins + entries 手写该族的键",
    };
  }
  const mode = "PWM Generation" + String(channel) + " CH" + String(channel);
  const iocSignal = "S_" + pick.signal;
  return {
    preset: {
      name: ip,
      label: ip + " CH" + String(channel) + " PWM 输出（按 db 选脚 " + pick.logical + "）",
      ip,
      pins: [{
        role: "ch" + String(channel),
        defaultPin: pick.logical,
        signal: iocSignal,
        mode: "",
        shared: { key: iocSignal, ipSignal: base, ipMode: mode },
      }],
      parameters: [{ name: "Channel-" + mode, value: "TIM_CHANNEL_" + String(channel) }],
      notes: [
        ip + " PWM：Prescaler/Period 未设，CubeMX 缺省 0 / 65535；" +
          "要 1 kHz 请用 entries 设 " + ip + ".Prescaler / " + ip + ".Period（按 " + familyId + " 的定时器时钟算）",
      ],
    },
    reason: "",
  };
}

/**
 * ADC 单通道规则转换：`ADC1` → 优先 IN1（历史默认），没有就取最小的可用通道。
 *
 * `.ioc` 里引脚信号写 `ADCx_INn`（不是 db 的 `ADC1_INn`），具体实例由 SH 块表达。
 * ADC 时钟预分频是族相关的（F1 的 ADC 上限 14 MHz，缺省 ÷2 会超规格），所以只在 F1 上带
 * `RCC.ADCPresc`，别的族留给调用方（不猜一个该族可能不认的键）。
 */
function deriveAdc(facts: CubemxMcuFacts, ip: string, familyId: string): DbPresetResult {
  const available: Array<{ channel: number; pin: PinHit }> = [];
  for (let channel = 0; channel <= 19; channel += 1) {
    const hits = pinsWithSignal(facts, ip + "_IN" + String(channel));
    if (hits.length > 0) available.push({ channel, pin: hits[0] as PinHit });
  }
  if (available.length === 0) {
    return {
      preset: null,
      reason: ip + " 在 db 里没有任何已引出的规则通道：换一个 ADC 实例，或用 pins + entries 手写",
    };
  }
  const chosen = available.find((item) => item.channel === 1) ?? (available[0] as { channel: number; pin: PinHit });
  const channel = chosen.channel;
  const iocSignal = "ADCx_IN" + String(channel);
  const isF1 = familyId.trim().toUpperCase() === "STM32F1";
  return {
    preset: {
      name: ip,
      label: ip + " 规则通道 IN" + String(channel) + "（按 db 选脚 " + chosen.pin.logical + "）",
      ip,
      pins: [{
        role: "in" + String(channel),
        defaultPin: chosen.pin.logical,
        signal: iocSignal,
        mode: "",
        shared: { key: iocSignal, ipSignal: ip + "_IN" + String(channel), ipMode: "IN" + String(channel) },
      }],
      parameters: [
        { name: "Rank-0#ChannelRegularConversion", value: "1" },
        { name: "Channel-0#ChannelRegularConversion", value: "ADC_CHANNEL_" + String(channel) },
        { name: "SamplingTime-0#ChannelRegularConversion", value: "ADC_SAMPLETIME_13CYCLES_5" },
        { name: "master", value: "1" },
        { name: "NbrOfConversionFlag", value: "1" },
      ],
      ...(isF1 ? { extraEntries: [{ key: "RCC.ADCPresc", value: "RCC_ADCPCLK2_DIV6" }] } : {}),
      notes: [
        isF1
          ? "ADC：已顺带把 RCC.ADCPresc 设成 ÷6（F1 的 ADC 上限 14 MHz，72 MHz÷6=12 MHz）"
          : "ADC：" + familyId + " 的 ADC 时钟预分频没设（CubeMX 缺省值），要降频请用 entries 设 RCC.ADCPresc",
        channel === 1 ? "" : "ADC：" + ip + " 没有已引出的 IN1，用了最小的可用通道 IN" + String(channel),
      ].filter((note) => note !== ""),
    },
    reason: "",
  };
}

/**
 * 按名字派生预设。认识的名字：`USART1` / `UART4` / `LPUART1` / `TIM2`（默认 CH1）/ `ADC1`（默认 IN1）。
 * 带变体的名字（`TIM3:timebase`、`ADC1:1,4,5`）与 DMA 不在这里派生 —— 那些是手写表的活。
 */
export function derivePeripheralPreset(
  facts: CubemxMcuFacts | null,
  name: string,
  options: DbPresetOptions = {},
): DbPresetResult {
  const raw = name.trim().toUpperCase();
  const familyId = (options.familyId ?? "").trim();
  if (raw.includes(":") || raw.startsWith("DMA:")) {
    return { preset: null, reason: raw + " 是变体/DMA 预设，db 里没有对应事实（由手写表提供）" };
  }
  if (facts === null) {
    return { preset: null, reason: "读不到本机 CubeMX db（没有 .ioc 的 Mcu.Name 或没装 CubeMX）：没法按族选脚" };
  }
  const instance = instanceNameOf(facts, raw);
  if (instance === null) {
    return {
      preset: null,
      reason: raw + " 不在这颗芯片的 db IP 清单里（可用：" + [...facts.ips.keys()].join("、") + "）",
    };
  }
  if (SERIAL_RE.test(instance)) return deriveSerial(facts, instance);
  if (TIMER_RE.test(instance)) return deriveTimer(facts, instance, 1, familyId);
  if (ADC_RE.test(instance)) return deriveAdc(facts, instance, familyId);
  return {
    preset: null,
    reason:
      raw + " 的预设还没派生（db 只给了引脚复用例，「这根脚做什么功能」还要按族规则拼参数）：" +
      "现在请用 pins + entries 手写该族的键，或换用 USART/UART/LPUART/TIM/ADC 预设",
  };
}
