import { resolveDbPinName } from "../cubemx-db.js";
const POWER_NET = /^(GND|VSS|VDD|VCC|VBAT|VBUS|VDDA|VSSA|\+?3V3|\+?5V)/u;
const NON_GPIO = /^(PA|PB|PC|PD|PE|PF|PG|PH|PI)\d+$/u;
function tokensOf(name) {
    return name
        .toUpperCase()
        .split(/[^A-Z0-9]+/u)
        .filter((token) => token.length > 1);
}
/** 匹配时剔掉引脚名本身（PB1 这类词元会把同名的 SYS_VREF_OUT_PB1 顶上来）。 */
function tokensForMatch(net, pinName) {
    const pin = pinName.toUpperCase();
    return tokensOf(net).filter((token) => token !== pin);
}
/** 候选信号按与网络名的词元重合度排序。 */
function scoreSignals(signals, netName, pinName) {
    const tokens = tokensForMatch(netName, pinName);
    const scored = signals.map((signal) => {
        const upper = signal.toUpperCase();
        const score = tokens.filter((token) => upper.includes(token)).length;
        return { signal, score };
    });
    scored.sort((a, b) => (b.score === a.score ? a.signal.localeCompare(b.signal) : b.score - a.score));
    return scored.map((item) => item.signal);
}
/** 引脚名在器件库里可能写作 PB9-BOOT0 这类复合名，先做一次解析。 */
function signalsOf(facts, name) {
    const dbName = resolveDbPinName(facts, name);
    const found = dbName === null ? facts.pins.get(name.toUpperCase()) : facts.pins.get(dbName);
    if (found === undefined)
        return [];
    return [...found.signals.keys()].sort((a, b) => a.localeCompare(b));
}
/** 网络名只是引脚默认名（PA4 这类）时不算连接信息。 */
function isUnnamedNet(pinName, net) {
    return net.toUpperCase() === pinName.toUpperCase();
}
/** 从网络名看出协议（只认最常见的三组）。 */
function protocolOf(net) {
    const upper = net.toUpperCase();
    if (/\bSCL\b|\bSDA\b/u.test(upper))
        return "I2C";
    if (/\bMOSI\b|\bMISO\b|\bSCK\b|\bCS\b/u.test(upper))
        return "SPI";
    if (/\bTX\b|\bRX\b/u.test(upper))
        return "UART";
    return "";
}
/** 软件模拟的代价：说清楚，不当作等价方案。 */
function softwareTradeoff(protocol) {
    if (protocol === "I2C")
        return "软件模拟 I2C：两个 GPIO 开漏 + 上拉，速率通常 100 kHz 以内，占 CPU，时序受中断影响";
    if (protocol === "SPI")
        return "软件模拟 SPI：GPIO 逐位翻转，速率与稳定性都低于硬件 SPI";
    return "软件模拟 UART：GPIO + 定时器采样，波特率误差与 CPU 占用都要算清楚";
}
function peripheralOf(signal) {
    const head = signal.split("_")[0] ?? "";
    return /[0-9]/u.test(head) && head !== "" ? head : "";
}
/** 纯 GPIO 网络才给 input/output 建议；外设信号交给 peripherals 预设。 */
function gpioSuggestion(name, net, signal) {
    if (signal !== "" && peripheralOf(signal) !== "" && !signal.startsWith("GPIO"))
        return null;
    const upper = net.toUpperCase();
    if (/BOOT0|NRST|SWDIO|SWCLK/u.test(upper))
        return null;
    if (/^(LED|D[0-9])/u.test(upper))
        return "output";
    if (/^(KEY|SW|BTN|BUTTON)/u.test(upper))
        return "input";
    return null;
}
export function draftIoc(schematic, facts) {
    const mcu = schematic.mcu === null ? null : { ref: schematic.mcu.ref, value: schematic.mcu.value };
    if (mcu === null) {
        return {
            ok: false,
            error: "原理图里没有识别出主控（按元件型号是否以 STM32/GD32 等开头判断）：先确认识别结果再生成配置草案",
            mcu: null,
            pins: [],
            unresolved: [],
            peripherals: [],
            gpioPins: [],
            softwareFallbacks: [],
            notes: [],
        };
    }
    if (facts === null) {
        return {
            ok: false,
            error: "没有可用的 CubeMX 器件库（" + mcu.value + "）：先装 CubeMX 或用 stm32_firmware_install 取器件包，才能把网络名对到库里的信号",
            mcu,
            pins: [],
            unresolved: [],
            peripherals: [],
            gpioPins: [],
            softwareFallbacks: [],
            notes: [],
        };
    }
    const pins = [];
    const unresolved = [];
    const gpioPins = [];
    const softwareFallbacks = [];
    const notes = [];
    let unnamed = 0;
    for (const pin of schematic.mcu?.pins ?? []) {
        const net = pin.net;
        if (net === "" || pin.noConnect)
            continue;
        if (POWER_NET.test(net.toUpperCase()))
            continue;
        if (isUnnamedNet(pin.name, net)) {
            unnamed += 1;
            continue;
        }
        const candidates = scoreSignals(signalsOf(facts, pin.name), net, pin.name);
        const best = candidates[0] ?? "";
        const tokens = tokensForMatch(net, pin.name);
        const matchCount = best === "" || tokens.length === 0 ? 0 : tokens.filter((token) => best.toUpperCase().includes(token)).length;
        const matched = best !== "" && matchCount > 0;
        const confidence = !matched ? "low" : matchCount >= 2 || best.toUpperCase() === net.toUpperCase() ? "high" : "medium";
        const note = !matched ? "库里找不到与网络名对得上的信号，按外设手册确认该脚复用" : "";
        const gpio = gpioSuggestion(pin.name, net, matched ? best : "");
        const dedicated = /BOOT0/u.test(net.toUpperCase());
        const resolvedBy = gpio !== null ? (gpio === "output" ? "GPIO 输出" : "GPIO 输入") : dedicated ? "BOOT0 专用脚" : "";
        if (resolvedBy !== "" && !matched) {
            pins.push({ number: pin.number, name: pin.name, net, signal: "", confidence: "high", candidates: candidates.slice(0, 6), note: resolvedBy + "（见 gpioPins 与说明）" });
            if (gpio !== null && NON_GPIO.test(pin.name))
                gpioPins.push({ pin: pin.name, signal: gpio, label: net.replace(/[^A-Za-z0-9_]/gu, "_") });
            continue;
        }
        const protocol = matched ? "" : protocolOf(net);
        const softwareOk = protocol !== "" && NON_GPIO.test(pin.name);
        if (!matched) {
            unresolved.push({ number: pin.number, name: pin.name, net, candidates: candidates.slice(0, 6) });
            if (softwareOk) {
                softwareFallbacks.push({
                    pin: pin.name,
                    net,
                    protocol,
                    suggestion: pin.name + " 配成 GPIO（" + protocol + " 模拟）",
                    tradeoff: softwareTradeoff(protocol),
                });
            }
        }
        pins.push({ number: pin.number, name: pin.name, net, signal: matched ? best : "", confidence, candidates: candidates.slice(0, 6), note });
        if (gpio !== null && NON_GPIO.test(pin.name))
            gpioPins.push({ pin: pin.name, signal: gpio, label: net.replace(/[^A-Za-z0-9_]/gu, "_") });
    }
    const byPeripheral = new Map();
    for (const pin of pins) {
        if (pin.signal === "")
            continue;
        const name = peripheralOf(pin.signal);
        if (name === "" || pin.signal.startsWith("GPIO"))
            continue;
        const entry = byPeripheral.get(name) ?? { signals: new Set(), pins: new Set() };
        entry.signals.add(pin.signal);
        entry.pins.add(pin.name);
        byPeripheral.set(name, entry);
    }
    if (softwareFallbacks.length > 0)
        notes.push("有 " + String(softwareFallbacks.length) + " 处硬件复用对不上，可用软件模拟顶上；先按协议换脚更稳");
    if (unnamed > 0)
        notes.push("有 " + String(unnamed) + " 个脚的网络名与脚名相同（PA4 这类默认名），未计入草案");
    if (unresolved.length > 0)
        notes.push("有 " + String(unresolved.length) + " 个脚对不上库信号，已列在 unresolved，需按外设手册确认后再落 .ioc");
    if (gpioPins.length > 0)
        notes.push("gpioPins 可直接作为 stm32_ioc_plan 的 pins 入参；外设信号用 peripherals 预设");
    return {
        ok: true,
        error: "",
        mcu,
        pins,
        unresolved,
        peripherals: [...byPeripheral.entries()].map(([name, entry]) => ({ name, signals: [...entry.signals], pins: [...entry.pins] })),
        gpioPins,
        softwareFallbacks,
        notes,
    };
}
