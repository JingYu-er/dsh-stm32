/**
 * 按族从 CubeMX db 派生 .ioc 外设预设（第一步只做串口）。
 *
 * 为什么不在插件里手抄 14 族的预设表：脚位、复用信号名、参数默认值三样都随族/型号变，
 * 手抄 14 份表等于把 14 族的手册各抄一遍，抄错一个脚位就是"看起来配好了、CubeMX 一打开就丢"。
 * CubeMX 自己就有这些事实：`db/mcu/<Mcu.Name>.xml` 里每个 <Pin> 的 <Signal> 就是"这根脚能做什么"，
 * `db/mcu/IP/<IP>-<ver>_Modes.xml` 里 <RefParameter DefaultValue> 就是参数默认值。
 * 所以这里做的是"读 db 选脚"，不是"猜"。
 *
 * 范围（第一步）：USART / UART / LPUART 的异步收发（TX+RX 两根脚）。
 * TIM 的 PWM 与 ADC 的规则通道要处理共享信号（`S_TIMx_CHy` / `ADCx_INy` + SH 块）与
 * 通道/采样参数，先留给下一步 —— 现在请求这两种会拿到明确的"还没派生"的人话，而不是一个错配置。
 */
const SERIAL_RE = /^(USART|UART|LPUART)([0-9]+)$/u;
const TIMER_RE = /^(TIM|HRTIM)([0-9A-Z]+)$/u;
const ADC_RE = /^(ADC)([0-9])$/u;
/** PA9 → { port: "A", number: 9 }；不认识的形状返回 null。 */
function splitPin(pin) {
    const matched = /^P([A-Z])([0-9]{1,2})/u.exec(pin.trim().toUpperCase());
    if (matched === null)
        return null;
    return { port: matched[1], number: Number(matched[2]) };
}
/** 按端口、脚号升序（同端口的 TX/RX 才配得成一对）。 */
function pinOrder(hit) {
    return (hit.port.charCodeAt(0) - 65) * 100 + hit.number;
}
/**
 * db 里带某条复用例信号的所有引脚，按端口/脚号升序。
 *
 * 信号名必须**完全相等**：db 里 TIM 的通道信号有 `TIM2_CH1` 也有合并过的 `S_TIM2_CH1_ETR`，
 * 用 includes/前缀匹配会把"能做什么"和"做过什么"混在一起。
 */
function pinsWithSignal(facts, signal) {
    const wanted = signal.trim().toUpperCase();
    const hits = [];
    for (const [pin, fact] of facts.pins) {
        const upper = pin.toUpperCase();
        if (upper.startsWith("VP_") || upper.includes("/") || upper.includes("-"))
            continue;
        const signals = [...fact.signals.keys()].map((name) => name.toUpperCase());
        if (!signals.includes(wanted))
            continue;
        const split = splitPin(upper);
        if (split === null)
            continue;
        hits.push({ pin: upper, port: split.port, number: split.number, signals });
    }
    hits.sort((left, right) => pinOrder(left) - pinOrder(right));
    return hits;
}
/** db 里有没有这个 IP 实例（`Mcu.IP` 清单的真值；大小写照 CubeMX 写）。 */
function instanceNameOf(facts, ip) {
    const wanted = ip.trim().toUpperCase();
    for (const name of facts.ips.keys()) {
        if (name.toUpperCase() === wanted)
            return name;
    }
    return null;
}
/**
 * 串口预设：TX/RX 各自挑一根脚。
 *
 * 选脚规则（可复现，不依赖型号特例）：
 *   1. 优先同端口的一对（PA9/PA10 这种），取"端口字母最小、脚号最小"的那一对；
 *   2. 没有同端口的对，就各取一根（TX 取最小、RX 取最小），并在 notes 里说明是跨端口；
 *   3. 缺 TX 或缺 RX 直接拒绝 —— 只有单向的串口预设在这里没有意义。
 */
function deriveSerial(facts, ip) {
    const tx = pinsWithSignal(facts, ip + "_TX");
    const rx = pinsWithSignal(facts, ip + "_RX");
    if (tx.length === 0 || rx.length === 0) {
        const missing = [tx.length === 0 ? "TX" : "", rx.length === 0 ? "RX" : ""].filter((item) => item !== "");
        return {
            preset: null,
            reason: ip + " 在 db 里找不到可用的 " + missing.join("/") + " 引脚（这颗芯片的 " + ip +
                " 可能没引出，或只支持同步/单线模式）：换一个实例，或用 pins + entries 手写该族的键",
        };
    }
    const samePort = tx.find((left) => rx.some((right) => right.port === left.port));
    let txPick = tx[0];
    let rxPick = rx[0];
    const notes = [];
    if (samePort !== undefined) {
        txPick = samePort;
        rxPick = rx.find((hit) => hit.port === samePort.port);
    }
    else {
        notes.push(ip + "：TX(" + txPick.pin + ") 与 RX(" + rxPick.pin + ") 不在同一个端口，接线时注意");
    }
    const pins = [
        { role: "tx", defaultPin: txPick.pin, signal: ip + "_TX", mode: "Asynchronous" },
        { role: "rx", defaultPin: rxPick.pin, signal: ip + "_RX", mode: "Asynchronous" },
    ];
    return {
        preset: {
            name: ip,
            label: ip + " 异步串口（按 db 选脚 " + txPick.pin + "/" + rxPick.pin + "）",
            ip,
            pins,
            parameters: [{ name: "VirtualMode", value: "VM_ASYNC" }],
            notes: [
                ip + "：引脚是从本机 CubeMX db 里该型号的复用例表选的（" + txPick.pin + " TX / " + rxPick.pin + " RX）；" +
                    "波特率等参数按 CubeMX 缺省（8N1 / 115200），要改请用 entries 设 " + ip + ".IPParameters 与对应键",
                ...notes,
            ],
        },
        reason: "",
    };
}
/**
 * 按名字派生预设。认识的名字：`USART1` / `UART4` / `LPUART1`。
 * 其它名字返回 preset=null + reason（TIM/ADC/DMA 仍是 F1 手写表）。
 */
export function derivePeripheralPreset(facts, name) {
    const raw = name.trim().toUpperCase();
    if (facts === null) {
        return { preset: null, reason: "读不到本机 CubeMX db（没有 .ioc 的 Mcu.Name 或没装 CubeMX）：没法按族选脚" };
    }
    const instance = instanceNameOf(facts, raw);
    if (instance !== null && SERIAL_RE.test(instance)) {
        return deriveSerial(facts, instance);
    }
    if (SERIAL_RE.test(raw)) {
        return {
            preset: null,
            reason: raw + " 不在这颗芯片的 db IP 清单里（可用：" + [...facts.ips.keys()].join("、") + "）",
        };
    }
    if (TIMER_RE.test(raw) || ADC_RE.test(raw)) {
        return {
            preset: null,
            reason: raw + " 的预设还没按族派生（定时器通道要走共享信号 S_TIMx_CHy + SH 块，ADC 要定 Rank/采样时间）：" +
                "现在请用 pins + entries 手写该族的键，或换用 USART/UART/LPUART 预设",
        };
    }
    return { preset: null, reason: "认不出的外设名 " + JSON.stringify(name) };
}
