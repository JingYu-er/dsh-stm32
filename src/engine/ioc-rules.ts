/**
 * L2：.ioc 的「CubeMX 会怎么读它」离线规则检查。
 *
 * 规则来源不是猜的：把 D:/app/STM32CubeMX/STM32CubeMX.exe（其实是 227 MB 的 jar）解开，
 * 反汇编 com.st.microxplorer.importproject 包得到的。证据链见 docs/development-notes.md 第 35 节：
 *   - ImportParameterContext 按 IP 名分发 ADC / DAC / RCC / DMA / NVIC；
 *   - ImportDMAParameter 读 Dma.RequestsNb（默认 0）、按冒号切子字段、认 MEMTOMEM；
 *   - ImportADCParameter 有 addRegularConversionRank(int, String) 与 setParamValueWithId(...)；
 *   - NvicVector 的字段顺序：Enable、preemptionPriority、subPriority、configurablePriority、
 *     systemHandler、irqHandlerGenerated、enableCodeNeeded 等。
 * 这些规则在这里离线执行：不启动 CubeMX 就能报出这份 .ioc 会不会被丢键或被覆盖。
 */

export interface IocRuleIssue {
  rule: string;
  message: string;
}

export interface IocRuleReport {
  errors: IocRuleIssue[];
  warnings: IocRuleIssue[];
}

const IP_KEY = /^Mcu[.]IP[0-9]+$/u;
const NVIC_KEY = /^NVIC[.](.+_IRQn)$/u;
const DMA_KEY = /^Dma[.]([A-Za-z0-9_]+)[.]([0-9]+)[.]/u;
const ADC_RANK_KEY = /^(ADC[0-9]*)[.](Rank|Channel|SamplingTime)-([0-9]+)#/u;

/**
 * R7：<IP>.IPParameters 是「这个 IP 有哪些参数」的白名单。
 * 只写 <IP>.Prescaler=71 而不把它列进 IPParameters，CubeMX 会当没写（实测 TIM2 的 Prescaler/Period 就这么丢的）。
 */
function checkIpParameters(entries: Map<string, string>, report: IocRuleReport): void {
  for (const [key, value] of entries) {
    if (!key.endsWith(".IPParameters")) continue;
    const ip = key.slice(0, key.length - ".IPParameters".length);
    if (ip.startsWith("Mcu.") || ip.startsWith("ProjectManager") || ip.startsWith("SH")) continue;
    const listed = new Set(value.split(",").map((item) => item.trim()).filter((item) => item !== ""));
    const missing: string[] = [];
    for (const other of entries.keys()) {
      if (!other.startsWith(ip + ".") || other === key) continue;
      const name = other.slice(ip.length + 1);
      if (name.includes(".") || name === "IPParameters") continue;
      if (!listed.has(name)) missing.push(name);
    }
    if (missing.length > 0) {
      report.warnings.push({
        rule: "R7",
        message: ip + ".IPParameters 没列出这些参数：" + missing.join("、") +
          "（CubeMX 只认白名单里的参数，其余会被忽略）",
      });
    }
  }
}

/** R1：有 Dma.* 就必须有 Mcu.IPn=DMA，否则整组 DMA 会被丢（实测）。 */
function checkDmaIp(entries: Map<string, string>, report: IocRuleReport): void {
  const dmaKeys = [...entries.keys()].filter((key) => DMA_KEY.test(key) || key === "Dma.RequestsNb");
  if (dmaKeys.length === 0) return;
  const hasDmaIp = [...entries.entries()].some(([key, value]) => IP_KEY.test(key) && value.trim() === "DMA");
  if (!hasDmaIp) {
    report.errors.push({
      rule: "R1",
      message: "写了 " + String(dmaKeys.length) + " 个 Dma.* 键，但 Mcu.IPn 里没有 DMA —— CubeMX 会整组丢弃（实测）",
    });
  }
}

/** R2：ADC 规则通道的 Rank/Channel/SamplingTime 要同 id，NbrOfConversion 与条数一致，Rank 值 1..N 连续。 */
function checkAdcRanks(entries: Map<string, string>, report: IocRuleReport): void {
  const ranks = new Map<string, number[]>();
  for (const [key, value] of entries) {
    const match = ADC_RANK_KEY.exec(key);
    if (match === null || (match[2] as string) !== "Rank") continue;
    const instance = match[1] as string;
    const list = ranks.get(instance) ?? [];
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) list.push(parsed);
    ranks.set(instance, list);
  }
  for (const [instance, list] of ranks) {
    const declared = Number.parseInt(entries.get(instance + ".NbrOfConversion") ?? "", 10);
    if (Number.isFinite(declared) && declared !== list.length) {
      report.warnings.push({
        rule: "R2",
        message: instance + ".NbrOfConversion=" + String(declared) + " 但找到 " + String(list.length) + " 组 Rank",
      });
    }
    const sorted = [...list].sort((a, b) => a - b);
    const expected = sorted.map((_, index) => index + 1);
    if (sorted.join(",") !== expected.join(",")) {
      report.warnings.push({
        rule: "R2",
        message: instance + " 的 Rank 值不连续（" + sorted.join(",") + "），CubeMX 按 1..N 生成，建议改成连续",
      });
    }
  }
  for (const [key] of entries) {
    const match = ADC_RANK_KEY.exec(key);
    if (match === null) continue;
    const instance = match[1] as string;
    const slot = match[3] as string;
    if ((match[2] as string) !== "Rank") continue;
    if (!entries.has(instance + ".Channel-" + slot + "#ChannelRegularConversion")) {
      report.warnings.push({ rule: "R2", message: instance + " 的 Rank-" + slot + " 没有配对的 Channel-" + slot });
    }
  }
}

/** R3：NVIC 值必须是冒号分隔的 9 段（NvicVector 的 Enable/Preempt/Sub/… 顺序）。 */
function checkNvicValues(entries: Map<string, string>, report: IocRuleReport): void {
  for (const [key, value] of entries) {
    const match = NVIC_KEY.exec(key);
    if (match === null) continue;
    const fields = value.split(":");
    if (fields.length < 6) {
      report.warnings.push({
        rule: "R3",
        message: "NVIC." + String(match[1]) + " 的值只有 " + String(fields.length) +
          " 段（应为 Enable:Preempt:Sub:Configurable:System:IrqHandlerGenerated 共 9 段），CubeMX 会按默认值覆盖",
      });
      continue;
    }
    if (fields[0] !== "true" && fields[0] !== "false") {
      report.warnings.push({ rule: "R3", message: "NVIC." + String(match[1]) + " 的第一段应是 true/false，实际是 " + fields[0] });
    }
  }
}

/** R5：F1 的 ADC 时钟上限 14 MHz；ADCPresc 不是除 6 时提醒（实测生成的代码会写成除 2）。 */
function checkAdcClock(entries: Map<string, string>, family: string, report: IocRuleReport): void {
  if (family.toUpperCase() !== "STM32F1") return;
  const presc = (entries.get("RCC.ADCPresc") ?? "").trim();
  if (presc === "") {
    report.warnings.push({ rule: "R5", message: "没有 RCC.ADCPresc：F1 的 ADC 上限 14 MHz，缺省除 2 会让 72 MHz 系统跑出 36 MHz" });
    return;
  }
  if (presc !== "RCC_ADCPCLK2_DIV6") {
    report.warnings.push({
      rule: "R5",
      message: "RCC.ADCPresc=" + presc + "（F1 上限 14 MHz，72 MHz 系统建议 RCC_ADCPCLK2_DIV6）；" +
        "另外实测 CubeMX 生成的 SystemClock_Config 不一定采纳这个键，生成后要看一眼 AdcClockSelection",
    });
  }
}


/** 伪外设：在 Mcu.IPn 里出现但没有自己的引脚，不能按「必须有引脚指向」去校验。 */
const PSEUDO_IPS = new Set([
  "NVIC", "RCC", "SYS", "DMA", "USB", "USB_OTG_FS", "USB_OTG_HS",
  "CORTEX_M0", "CORTEX_M3", "CORTEX_M4", "CORTEX_M7", "FREERTOS",
]);

/** 会出现在引脚名后面的键后缀（ImportEngine 里按引脚前缀 + 后缀收集）。 */
const PIN_SUFFIXES = new Set([
  "Signal", "Mode", "Locked", "GPIOParameters", "GPIO_Label", "GPIO_PuPd", "GPIO_Speed",
  "GPIO_OType", "GPIO_Mode", "GPIO_ModeDefaultEXTI", "GPIO_ModeDefaultPP", "GPIO_ModeDefaultOutputPP",
]);

/** R4：引脚的键必须对应 Mcu.PinN 里的引脚，否则 CubeMX 不会应用（实测）。 */
function checkPinReferences(entries: Map<string, string>, report: IocRuleReport): void {
  const listed = new Set<string>();
  for (const [key, value] of entries) {
    if (/^Mcu[.]Pin[0-9]+$/u.test(key)) listed.add(value.trim());
  }
  if (listed.size === 0) return;
  const unknown = new Set<string>();
  for (const key of entries.keys()) {
    const dot = key.indexOf(".");
    if (dot <= 0) continue;
    const prefix = key.slice(0, dot);
    const suffix = key.slice(dot + 1);
    if (!PIN_SUFFIXES.has(suffix)) continue;
    if (prefix.startsWith("Mcu") || prefix.startsWith("SH")) continue;
    if (!listed.has(prefix)) unknown.add(prefix);
  }
  for (const pin of unknown) {
    report.warnings.push({
      rule: "R4",
      message: pin + " 有配置键但没列进 Mcu.PinN —— CubeMX 只应用引脚表里的脚（补 Mcu.PinN 与 Mcu.PinsNb）",
    });
  }
}

/** R6：SH.<信号>.ConfNb 必须等于 SH.<信号>.<n> 的条数，值形如 <IP 信号>,<IP 模式> 或 GPIO_EXTIn。 */
function checkSharedSignals(entries: Map<string, string>, report: IocRuleReport): void {
  const groups = new Map<string, string[]>();
  for (const [key, value] of entries) {
    const match = /^SH[.](.+)[.]([0-9]+)$/u.exec(key);
    if (match === null) continue;
    const list = groups.get(match[1] as string) ?? [];
    list.push(value);
    groups.set(match[1] as string, list);
  }
  for (const [signal, values] of groups) {
    const declared = Number.parseInt(entries.get("SH." + signal + ".ConfNb") ?? "", 10);
    if (!Number.isFinite(declared)) {
      report.warnings.push({ rule: "R6", message: "SH." + signal + " 有 " + String(values.length) + " 条映射但缺 ConfNb" });
    } else if (declared !== values.length) {
      report.warnings.push({
        rule: "R6",
        message: "SH." + signal + ".ConfNb=" + String(declared) + " 但实际有 " + String(values.length) + " 条映射",
      });
    }
    for (const value of values) {
      if (!value.includes(",") && !value.startsWith("GPIO_EXTI")) {
        report.warnings.push({
          rule: "R6",
          message: "SH." + signal + " 的值 " + value + " 既不是 <IP 信号>,<IP 模式> 也不是 GPIO_EXTIn",
        });
      }
    }
  }
}

/** R8：Mcu.IPNb / Mcu.PinsNb 必须与实际条数一致（CubeMX 自己会重算，不一致说明文件被手改过）。 */
function checkIpPinCounts(entries: Map<string, string>, report: IocRuleReport): void {
  const count = (pattern: RegExp): number => {
    let total = 0;
    for (const key of entries.keys()) if (pattern.test(key)) total += 1;
    return total;
  };
  const ipCount = count(/^Mcu[.]IP[0-9]+$/u);
  const pinCount = count(/^Mcu[.]Pin[0-9]+$/u);
  const ipNb = Number.parseInt(entries.get("Mcu.IPNb") ?? "", 10);
  const pinsNb = Number.parseInt(entries.get("Mcu.PinsNb") ?? "", 10);
  if (Number.isFinite(ipNb) && ipNb !== ipCount) {
    report.warnings.push({ rule: "R8", message: "Mcu.IPNb=" + String(ipNb) + " 但实际有 " + String(ipCount) + " 个 Mcu.IPn 键" });
  }
  if (Number.isFinite(pinsNb) && pinsNb !== pinCount) {
    report.warnings.push({ rule: "R8", message: "Mcu.PinsNb=" + String(pinsNb) + " 但实际有 " + String(pinCount) + " 个 Mcu.PinN 键" });
  }
}

/** R12：引脚只有 .Mode 或只有 .Signal —— 外设引脚两种缺一不可（GPIO 脚只有 .Signal 是正常的）。 */
function checkModeSignalPairs(entries: Map<string, string>, report: IocRuleReport): void {
  const pins = new Set<string>();
  for (const key of entries.keys()) {
    if (!key.endsWith(".Mode")) continue;
    const pin = key.slice(0, key.length - ".Mode".length);
    // 只认真正的引脚键：引脚名里没有点（Dma.ADC1.0.Mode 这种是外设参数，不是引脚）
    if (pin.includes(".")) continue;
    pins.add(pin);
  }
  for (const pin of pins) {
    if (pin.startsWith("VP_") || pin.startsWith("SH")) continue;
    if (!entries.has(pin + ".Signal")) {
      report.warnings.push({ rule: "R12", message: pin + " 有 .Mode 却没有 .Signal（CubeMX 不会把它当外设引脚）" });
    }
  }
}
/** 对外入口：跑一遍全部离线规则。 */
export function checkIocRules(entries: Map<string, string>): IocRuleReport {
  const report: IocRuleReport = { errors: [], warnings: [] };
  const family = (entries.get("Mcu.Family") ?? "").trim();
  checkIpParameters(entries, report);
  checkDmaIp(entries, report);
  checkAdcRanks(entries, report);
  checkNvicValues(entries, report);
  checkAdcClock(entries, family, report);
  checkPinReferences(entries, report);
  checkSharedSignals(entries, report);
  checkIpPinCounts(entries, report);
  checkModeSignalPairs(entries, report);
  return report;
}
