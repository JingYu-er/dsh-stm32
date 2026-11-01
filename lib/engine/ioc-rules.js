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
import { readIpModeNames, resolveDbPinName } from "./cubemx-db.js";
const IP_KEY = /^Mcu[.]IP[0-9]+$/u;
const NVIC_KEY = /^NVIC[.](.+_IRQn)$/u;
const DMA_KEY = /^Dma[.]([A-Za-z0-9_]+)[.]([0-9]+)[.]/u;
const ADC_RANK_KEY = /^(ADC[0-9]*)[.](Rank|Channel|SamplingTime)-([0-9]+)#/u;
/**
 * R7：<IP>.IPParameters 是「这个 IP 有哪些参数」的白名单。
 * 只写 <IP>.Prescaler=71 而不把它列进 IPParameters，CubeMX 会当没写（实测 TIM2 的 Prescaler/Period 就这么丢的）。
 */
function checkIpParameters(entries, report) {
    for (const [key, value] of entries) {
        if (!key.endsWith(".IPParameters"))
            continue;
        const ip = key.slice(0, key.length - ".IPParameters".length);
        if (ip.startsWith("Mcu.") || ip.startsWith("ProjectManager") || ip.startsWith("SH"))
            continue;
        const listed = new Set(value.split(",").map((item) => item.trim()).filter((item) => item !== ""));
        const missing = [];
        for (const other of entries.keys()) {
            if (!other.startsWith(ip + ".") || other === key)
                continue;
            const name = other.slice(ip.length + 1);
            if (name.includes(".") || name === "IPParameters")
                continue;
            if (!listed.has(name))
                missing.push(name);
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
function checkDmaIp(entries, report) {
    const dmaKeys = [...entries.keys()].filter((key) => DMA_KEY.test(key) || key === "Dma.RequestsNb");
    if (dmaKeys.length === 0)
        return;
    const hasDmaIp = [...entries.entries()].some(([key, value]) => IP_KEY.test(key) && value.trim() === "DMA");
    if (!hasDmaIp) {
        report.errors.push({
            rule: "R1",
            message: "写了 " + String(dmaKeys.length) + " 个 Dma.* 键，但 Mcu.IPn 里没有 DMA —— CubeMX 会整组丢弃（实测）",
        });
    }
}
/** R2：ADC 规则通道的 Rank/Channel/SamplingTime 要同 id，NbrOfConversion 与条数一致，Rank 值 1..N 连续。 */
function checkAdcRanks(entries, report) {
    const ranks = new Map();
    for (const [key, value] of entries) {
        const match = ADC_RANK_KEY.exec(key);
        if (match === null || match[2] !== "Rank")
            continue;
        const instance = match[1];
        const list = ranks.get(instance) ?? [];
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed))
            list.push(parsed);
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
        if (match === null)
            continue;
        const instance = match[1];
        const slot = match[3];
        if (match[2] !== "Rank")
            continue;
        if (!entries.has(instance + ".Channel-" + slot + "#ChannelRegularConversion")) {
            report.warnings.push({ rule: "R2", message: instance + " 的 Rank-" + slot + " 没有配对的 Channel-" + slot });
        }
    }
}
/** R3：NVIC 值必须是冒号分隔的 9 段（NvicVector 的 Enable/Preempt/Sub/… 顺序）。 */
function checkNvicValues(entries, report) {
    for (const [key, value] of entries) {
        const match = NVIC_KEY.exec(key);
        if (match === null)
            continue;
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
function checkAdcClock(entries, family, report) {
    if (family.toUpperCase() !== "STM32F1")
        return;
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
function checkPinReferences(entries, report) {
    const listed = new Set();
    for (const [key, value] of entries) {
        if (/^Mcu[.]Pin[0-9]+$/u.test(key))
            listed.add(value.trim());
    }
    if (listed.size === 0)
        return;
    const unknown = new Set();
    for (const key of entries.keys()) {
        const dot = key.indexOf(".");
        if (dot <= 0)
            continue;
        const prefix = key.slice(0, dot);
        const suffix = key.slice(dot + 1);
        if (!PIN_SUFFIXES.has(suffix))
            continue;
        if (prefix.startsWith("Mcu") || prefix.startsWith("SH"))
            continue;
        if (!listed.has(prefix))
            unknown.add(prefix);
    }
    for (const pin of unknown) {
        report.warnings.push({
            rule: "R4",
            message: pin + " 有配置键但没列进 Mcu.PinN —— CubeMX 只应用引脚表里的脚（补 Mcu.PinN 与 Mcu.PinsNb）",
        });
    }
}
/** R6：SH.<信号>.ConfNb 必须等于 SH.<信号>.<n> 的条数，值形如 <IP 信号>,<IP 模式> 或 GPIO_EXTIn。 */
function checkSharedSignals(entries, report) {
    const groups = new Map();
    for (const [key, value] of entries) {
        const match = /^SH[.](.+)[.]([0-9]+)$/u.exec(key);
        if (match === null)
            continue;
        const list = groups.get(match[1]) ?? [];
        list.push(value);
        groups.set(match[1], list);
    }
    for (const [signal, values] of groups) {
        const declared = Number.parseInt(entries.get("SH." + signal + ".ConfNb") ?? "", 10);
        if (!Number.isFinite(declared)) {
            report.warnings.push({ rule: "R6", message: "SH." + signal + " 有 " + String(values.length) + " 条映射但缺 ConfNb" });
        }
        else if (declared !== values.length) {
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
function checkIpPinCounts(entries, report) {
    const count = (pattern) => {
        let total = 0;
        for (const key of entries.keys())
            if (pattern.test(key))
                total += 1;
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
/** 形如 ADC1 / DAC1 / TIM2 / USART3 / SPI1 / I2C2 / CAN1 / SDIO / RTC / IWDG / WWDG 的外设实例名。 */
const IP_INSTANCE = /^(?:ADC|DAC|TIM|USART|UART|SPI|I2C|CAN|USB|SDIO|ETH|RTC|IWDG|WWDG)[0-9]*$/u;
/**
 * R15：外设参数键指向的实例不在 Mcu.IPn 里。
 *
 * 证据：CubeMX 的 ImportEngine 先按 Mcu.IPn 建「这次工程里有哪些外设实例」，再按实例名分发参数
 * （ImportParameterContext）。实例不存在时，挂在它下面的 USART2.BaudRate / TIM3.Prescaler 这类键
 * 没有接收方，会被静默丢掉——表现是「.ioc 里明明写了，生成出来的代码里没有」。
 *
 * 只查「首段看起来就是外设实例名」的键，RCC. / NVIC. / SH. / Dma. / Mcu. / ProjectManager. 这些
 * 都不是实例名，不参与（Dma.* 由 R1 管）。
 */
function checkIpInstanceKeys(entries, report) {
    const instances = new Set();
    for (const [key, value] of entries) {
        if (IP_KEY.test(key))
            instances.add(value.trim().toUpperCase());
    }
    const orphans = new Map();
    for (const key of entries.keys()) {
        const head = key.split(".")[0] ?? "";
        if (!IP_INSTANCE.test(head))
            continue;
        if (instances.has(head.toUpperCase()))
            continue;
        const list = orphans.get(head) ?? [];
        if (list.length < 4)
            list.push(key);
        orphans.set(head, list);
    }
    for (const [ip, keys] of orphans) {
        report.warnings.push({
            rule: "R15",
            message: ip + " 有参数键（" + keys.join("、") + "），但 Mcu.IPn 里没有 " + ip +
                " —— CubeMX 按 Mcu.IPn 建实例，这些键没有接收方，会被静默丢弃",
        });
    }
}
function checkModeSignalPairs(entries, report) {
    const pins = new Set();
    for (const key of entries.keys()) {
        if (!key.endsWith(".Mode"))
            continue;
        const pin = key.slice(0, key.length - ".Mode".length);
        // 只认真正的引脚键：引脚名里没有点（Dma.ADC1.0.Mode 这种是外设参数，不是引脚）
        if (pin.includes("."))
            continue;
        pins.add(pin);
    }
    for (const pin of pins) {
        if (pin.startsWith("VP_") || pin.startsWith("SH"))
            continue;
        if (!entries.has(pin + ".Signal")) {
            report.warnings.push({ rule: "R12", message: pin + " 有 .Mode 却没有 .Signal（CubeMX 不会把它当外设引脚）" });
        }
    }
}
/** 模式名归一：CubeMX 里 "Serial Wire" / "Serial_Wire"、"PWM Generation1 CH1" 混着用。 */
function normalizeModeText(text) {
    return text.trim().toLowerCase().replace(/[\s_-]+/gu, "_").replace(/^_+|_+$/gu, "");
}
/**
 * R13 的判定核心：.ioc 写的 Signal 是不是这根脚在 db 里支持的信号。
 * 要容忍三类 CubeMX 自己写出来的「伪信号」：
 *   - GPIO_Output / GPXTI8（GPIO 模式与外部中断）：等价于 db 的 GPIO；
 *   - ADCx_IN1：db 里是 ADC1_IN1 / ADC2_IN1（x 是占位符）；
 *   - S_TIM2_CH1_ETR：db 把共享信号拆成 TIM2_CH1 与 TIM2_ETR，认前缀即可。
 */
export function pinSignalSupported(signals, signal) {
    const raw = signal.trim();
    if (raw === "")
        return false;
    if (signals.has(raw))
        return true;
    const gpio = signals.has("GPIO");
    if (/^GPIO(?:_|$)/u.test(raw))
        return gpio;
    if (/^GPXTI[0-9]+$/u.test(raw))
        return gpio;
    const adc = /^ADCx_IN([0-9]+)$/u.exec(raw);
    if (adc !== null) {
        return [...signals.keys()].some((name) => name === "ADC1_IN" + adc[1] || name === "ADC2_IN" + adc[1] || name === "ADC3_IN" + adc[1]);
    }
    const stripped = raw.replace(/^S_/u, "");
    if (signals.has(stripped))
        return true;
    for (const name of signals.keys()) {
        if (name.length >= 5 && stripped.startsWith(name))
            return true;
    }
    return false;
}
/** 从信号名推外设实例（TIM3_CH1 → TIM3、USART1_TX → USART1）；推不出返回空串。 */
export function instanceFromSignal(signal) {
    const raw = signal.replace(/^S_/u, "");
    const match = /^([A-Z]+[0-9]+)_/u.exec(raw);
    if (match !== null)
        return match[1];
    if (/^SYS_/u.test(raw))
        return "SYS";
    return "";
}
/** 收集「引脚 → (Signal, Mode)」：键里带点的是外设参数（Dma.ADC1.0.Mode），不是引脚。 */
function collectPins(entries) {
    const out = [];
    for (const key of entries.keys()) {
        if (!key.endsWith(".Signal"))
            continue;
        const pin = key.slice(0, key.length - ".Signal".length);
        if (pin.includes("."))
            continue;
        if (pin.startsWith("VP_") || pin.startsWith("SH"))
            continue;
        const index = out.findIndex((item) => item.pin === pin);
        const signal = entries.get(pin + ".Signal") ?? "";
        const mode = entries.get(pin + ".Mode") ?? "";
        if (index >= 0)
            out[index] = { pin, signal, mode };
        else
            out.push({ pin, signal, mode });
    }
    return out;
}
/** R13：<pin>.Signal 必须是该脚在 db 里支持的信号（含 GPIO/ADCx_INn/S_ 共享名）。 */
function checkPinSignals(entries, facts, report) {
    for (const item of collectPins(entries)) {
        if (item.signal === "")
            continue;
        const dbPin = resolveDbPinName(facts, item.pin) ?? item.pin;
        const fact = facts.pins.get(dbPin);
        if (fact === undefined)
            continue;
        if (pinSignalSupported(fact.signals, item.signal))
            continue;
        const sample = [...fact.signals.keys()].slice(0, 8).join("、");
        report.warnings.push({
            rule: "R13",
            message: item.pin + ".Signal=" + item.signal + " 不是 db（" + facts.name + "）里 " + dbPin +
                " 支持的信号（该脚支持：" + sample + (fact.signals.size > 8 ? "…" : "") + "）",
        });
    }
}
/** R14：<pin>.Mode 必须是该信号允许的模式（GPIO 查 IOModes，外设查该 IP 的 RefMode 名单）。 */
function checkPinModes(entries, facts, db, report) {
    for (const item of collectPins(entries)) {
        if (item.mode === "")
            continue;
        const dbPin = resolveDbPinName(facts, item.pin) ?? item.pin;
        const fact = facts.pins.get(dbPin);
        if (fact === undefined)
            continue;
        if (/^GPIO(?:_|$)/u.test(item.signal) || /^GPXTI[0-9]+$/u.test(item.signal)) {
            const allowed = fact.signals.get("GPIO") ?? [];
            if (allowed.length === 0)
                continue;
            const wanted = normalizeModeText(item.mode.replace(/^GPIO_/u, ""));
            if (allowed.some((name) => normalizeModeText(name) === wanted))
                continue;
            report.warnings.push({ rule: "R14", message: item.pin + ".Mode=" + item.mode + " 不在 db 的 GPIO 模式里（" + allowed.join("、") + "）" });
            continue;
        }
        const instance = instanceFromSignal(item.signal);
        if (instance === "" || db === null || !facts.ips.has(instance))
            continue;
        const modes = readIpModeNames(db, facts, instance);
        if (modes.length === 0)
            continue;
        const wanted = normalizeModeText(item.mode);
        if (modes.some((name) => normalizeModeText(name) === wanted))
            continue;
        report.warnings.push({
            rule: "R14",
            message: item.pin + ".Mode=" + item.mode + " 不是 " + instance + " 在 db 里的合法模式（例：" + modes.slice(0, 6).join("、") + "…）",
        });
    }
}
/** R17：同一根物理引脚被写了两份（PA0 与 PA0-WKUP），或同一个外设信号挂到两根脚上。 */
function checkPinConflicts(entries, facts, report) {
    const byDbPin = new Map();
    const bySignal = new Map();
    for (const item of collectPins(entries)) {
        const dbPin = resolveDbPinName(facts, item.pin) ?? item.pin;
        byDbPin.set(dbPin, [...(byDbPin.get(dbPin) ?? []), item.pin]);
        if (item.signal === "" || /^GPIO(?:_|$)/u.test(item.signal) || /^GPXTI[0-9]+$/u.test(item.signal))
            continue;
        bySignal.set(item.signal, [...(bySignal.get(item.signal) ?? []), item.pin]);
    }
    for (const [dbPin, pins] of byDbPin) {
        const unique = [...new Set(pins)];
        if (unique.length < 2)
            continue;
        report.errors.push({
            rule: "R17",
            message: "同一个物理引脚写了多份：" + unique.join("、") + "（db 里都是 " + dbPin + "），CubeMX 只会认其中一份",
        });
    }
    for (const [signal, pins] of bySignal) {
        const unique = [...new Set(pins)];
        if (unique.length < 2)
            continue;
        report.errors.push({
            rule: "R17",
            message: "信号 " + signal + " 同时挂在 " + unique.join("、") + " 上：一个外设信号只能占一根脚",
        });
    }
}
/** 对外入口：跑一遍全部离线规则。 */
export function checkIocRules(entries, context = {}) {
    const report = { errors: [], warnings: [] };
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
    checkIpInstanceKeys(entries, report);
    // db 类规则：没有 db 就整体跳过（查不到 ≠ 写错了）。
    const facts = context.facts ?? null;
    if (facts !== null) {
        checkPinSignals(entries, facts, report);
        checkPinModes(entries, facts, context.db ?? null, report);
        checkPinConflicts(entries, facts, report);
    }
    return report;
}
