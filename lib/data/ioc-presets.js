/**
 * L2 数据：`.ioc` 外设预设 —— "启用一个外设"到底要写哪些键。
 *
 * 为什么必须做成预设：CubeMX **不是**「读到 USART1.VirtualMode 就建 USART1」。
 * 它按「某根脚的 Mode + Signal」推导复用模式，再核对 Mcu.IPn 里有这个实例，才生成
 * MX_xxx_Init。实测（C8T6 + CubeMX 6.15.0 + STM32Cube_FW_F1_V1.8.7）：只写
 * Mcu.IPn=USART1 + USART1.IPParameters/VirtualMode + PA9.Signal=USART1_TX 时，
 * CubeMX 静默丢弃整个 USART1（生成结果里没有 MX_USART1_UART_Init，
 * HAL_UART_MODULE_ENABLED 仍注释）；补上 PA9/PA10 的 .Mode=Asynchronous 之后
 * 立刻生成成功，真机 USART1->BRR=0x271（115200@72 MHz）实测通过。
 *
 * 另一条实测结论：GPIO 脚（Signal=GPIO_Output/Input）**没有** .Mode —— 单模式信号。
 * 只有多模式外设（USART/TIM/ADC…）才靠 .Mode 区分复用功能。
 *
 * 这些键集来自 504 个官方板级 .ioc 的写法 + 本机 CubeMX 实测，不是猜的；
 * 换族时按同样的规则加一份表即可（`family` 字段是唯一的族相关入口）。
 */
/**
 * 族相关的引脚别名：**离线兜底表**，只在读不到 CubeMX db 时用。
 *
 * 正常路径是 src/engine/ioc-plan.ts 的 createPinNameResolver：它按 .ioc 里的 Mcu.Name 去本机
 * CubeMX 的 `db/mcu/<Mcu.Name>.xml` 查真实引脚名（R16），db 里叫什么就写什么。
 * 这张表只收 F1 的 6 根带后缀的脚（PA0→PA0-WKUP、PC13→PC13-TAMPER-RTC、PC14/PC15、PD0/PD1），
 * 没装 CubeMX 或 db 里没有这颗时才会用到；CubeMX 换版本后 db 名可能变，那时这里就会写错脚，
 * 所以缺 db 时 ioc-plan 会在 warnings 里明确提醒。
 */
export const PIN_DB_ALIASES = {
    STM32F1: {
        PA0: "PA0-WKUP",
        PC13: "PC13-TAMPER-RTC",
        PC14: "PC14-OSC32_IN",
        PC15: "PC15-OSC32_OUT",
        PD0: "PD0-OSC_IN",
        PD1: "PD1-OSC_OUT",
    },
};
/** 把逻辑引脚名换成 .ioc 里要用的 db 名（族未知时原样返回）。 */
export function pinDbName(family, pin) {
    const table = PIN_DB_ALIASES[family.trim().toUpperCase()];
    if (table === undefined)
        return pin;
    return table[pin.trim().toUpperCase()] ?? pin;
}
function usart(name, tx, rx) {
    return {
        name,
        label: name + " 异步串口",
        ip: name,
        pins: [
            { role: "tx", defaultPin: tx, signal: name + "_TX", mode: "Asynchronous" },
            { role: "rx", defaultPin: rx, signal: name + "_RX", mode: "Asynchronous" },
        ],
        parameters: [{ name: "VirtualMode", value: "VM_ASYNC" }],
        notes: [name + "：默认 8N1 / 115200（CubeMX 缺省值），要改波特率请用 entries 设 " + name + ".IPParameters 与对应键"],
    };
}
function timerPwm(name, channel, pin, dbSignal) {
    const mode = "PWM Generation" + String(channel) + " CH" + String(channel);
    return {
        name,
        label: name + " CH" + String(channel) + " PWM 输出",
        ip: name,
        pins: [{
                role: "ch" + String(channel),
                defaultPin: pin,
                signal: dbSignal,
                mode: "",
                shared: { key: dbSignal, ipSignal: name + "_CH" + String(channel), ipMode: mode },
            }],
        parameters: [{ name: "Channel-" + mode, value: "TIM_CHANNEL_" + String(channel) }],
        notes: [
            name + " PWM：默认 Prescaler=0 / Period=65535（CubeMX 缺省），" +
                '要 1 kHz 请配 parameters {"Prescaler":"71","Period":"999"}（72 MHz 定时器时钟）',
        ],
    };
}
/**
 * F1 的 ADC 预设：一个规则通道（Rank 1）。
 * `Channel-0#ChannelRegularConversion` 必须与引脚一致（PA1 → ADC_CHANNEL_1），
 * 换引脚时这两个参数要一起改，所以 pins 覆盖时会上报提醒。
 */
function adc(name, pin, channel) {
    return {
        name,
        label: name + " 规则通道 IN" + String(channel),
        ip: name,
        pins: [{
                role: "in" + String(channel),
                defaultPin: pin,
                signal: "ADCx_IN" + String(channel),
                mode: "",
                shared: { key: "ADCx_IN" + String(channel), ipSignal: name + "_IN" + String(channel), ipMode: "IN" + String(channel) },
            }],
        parameters: [
            { name: "Rank-0#ChannelRegularConversion", value: "1" },
            { name: "Channel-0#ChannelRegularConversion", value: "ADC_CHANNEL_" + String(channel) },
            { name: "SamplingTime-0#ChannelRegularConversion", value: "ADC_SAMPLETIME_13CYCLES_5" },
            { name: "master", value: "1" },
            { name: "NbrOfConversionFlag", value: "1" },
        ],
        // F1 的 ADC 时钟上限 14 MHz：RCC 缺省 ADCPRE=÷2 会跑在 36 MHz（超规格）。
        extraEntries: [{ key: "RCC.ADCPresc", value: "RCC_ADCPCLK2_DIV6" }],
        notes: ["ADC：已顺带把 RCC.ADCPresc 设成 ÷6（F1 的 ADC 上限 14 MHz，72 MHz÷6=12 MHz）"],
    };
}
/** F103C8 上 ADC 通道 → 默认引脚（只收这颗片子上真实存在的 IN0..IN9）。 */
const ADC_PIN_BY_CHANNEL = {
    0: "PA0", 1: "PA1", 4: "PA4", 5: "PA5", 6: "PA6", 7: "PA7", 8: "PB0", 9: "PB1",
};
/**
 * 多 Rank ADC（C5）：一次扫多路，写成 `ADC1:1,4,5`。
 *
 * 键的形状来自 ImportADCParameter 的反汇编：每条转换占三个同下标键
 * （Rank-n / Channel-n / SamplingTime-n），`NbrOfConversion` 必须等于条数，
 * Rank 从 1 开始连续（R2 规则会盯着这三点）。引脚用 ADCx_INn 共享信号 + SH 块表达。
 */
function adcMulti(name, channels) {
    const pins = channels.map((channel) => ({
        role: "in" + String(channel),
        defaultPin: ADC_PIN_BY_CHANNEL[channel] ?? "",
        signal: "ADCx_IN" + String(channel),
        mode: "",
        shared: { key: "ADCx_IN" + String(channel), ipSignal: name + "_IN" + String(channel), ipMode: "IN" + String(channel) },
    }));
    const parameters = channels.flatMap((channel, index) => [
        { name: "Rank-" + String(index) + "#ChannelRegularConversion", value: String(index + 1) },
        { name: "Channel-" + String(index) + "#ChannelRegularConversion", value: "ADC_CHANNEL_" + String(channel) },
        { name: "SamplingTime-" + String(index) + "#ChannelRegularConversion", value: "ADC_SAMPLETIME_13CYCLES_5" },
    ]);
    parameters.push({ name: "NbrOfConversion", value: String(channels.length) });
    parameters.push({ name: "master", value: "1" });
    parameters.push({ name: "NbrOfConversionFlag", value: "1" });
    return {
        name,
        label: name + " 规则通道 " + channels.map((channel) => "IN" + String(channel)).join("+"),
        ip: name,
        pins,
        parameters,
        extraEntries: [{ key: "RCC.ADCPresc", value: "RCC_ADCPCLK2_DIV6" }],
        notes: [
            name + " 多 Rank：" + String(channels.length) + " 路扫描（通道 " + channels.join("、") +
                "），DMA 要自己配（Dma.* 由 entries 写；ADC 用 DMA 时 Mode=Circular 才会连续搬）",
        ],
    };
}
/**
 * 纯时基定时器（C4）：只有 Prescaler/Period，不占任何引脚。
 *
 * 为什么单独一条：TIM2/3/4 的 PWM 预设会占 CH1 引脚；只想"每 1 ms 中断一次"时占引脚反而添乱，
 * 而 CubeMX 对"没有引脚的定时器"是完全支持的（生成 MX_TIM3_Init，HAL_TIM_Base_Start_IT 就能用）。
 * 调用方式：peripherals: [{ name: "TIM3:timebase" }]。
 */
function timerBase(name) {
    return {
        name,
        label: name + " 纯时基（无引脚）",
        ip: name,
        pins: [],
        parameters: [
            { name: "Prescaler", value: "71" },
            { name: "Period", value: "999" },
            { name: "CounterMode", value: "TIM_COUNTERMODE_UP" },
            { name: "ClockDivision", value: "TIM_CLOCKDIVISION_DIV1" },
            { name: "AutoReloadPreload", value: "TIM_AUTORELOAD_PRELOAD_DISABLE" },
        ],
        notes: [
            name + " 纯时基：只生成 MX_" + name + "_Init，不占引脚。要中断再在 entries 里加 NVIC." + name + "_IRQn；" +
                "Prescaler/Period 是 72 MHz 下的 1 kHz（71 / 999），换频率用 parameters 覆盖",
        ],
    };
}
/** 内置预设表（按名字查）。 */
export const PERIPHERAL_PRESETS = [
    usart("USART1", "PA9", "PA10"),
    usart("USART2", "PA2", "PA3"),
    usart("USART3", "PB10", "PB11"),
    // PA0 的定时器信号在 db 里与 TIM2_ETR 合并成 S_TIM2_CH1_ETR，必须用这个名字。
    timerPwm("TIM2", 1, "PA0", "S_TIM2_CH1_ETR"),
    timerPwm("TIM3", 1, "PA6", "S_TIM3_CH1"),
    timerPwm("TIM4", 1, "PB6", "S_TIM4_CH1"),
    adc("ADC1", "PA1", 1),
    adc("ADC2", "PA1", 1),
];
/** 按名字找预设（大小写不敏感）。支持 `TIM3:timebase` 这种"变体"写法。 */
export function findPeripheralPreset(name) {
    const raw = name.trim().toUpperCase();
    const [base, variant] = raw.split(":");
    // ADC1:1,4,5 —— 多 Rank（通道号列表）
    if (variant !== undefined && /^[0-9]+(?:,[0-9]+)*$/u.test(variant)) {
        if (!/^ADC[1-3]$/u.test(base ?? ""))
            return null;
        const channels = [...new Set(variant.split(",").map((item) => Number.parseInt(item, 10)))].filter((item) => Number.isFinite(item));
        if (channels.length === 0 || channels.some((channel) => ADC_PIN_BY_CHANNEL[channel] === undefined))
            return null;
        return adcMulti(base, channels);
    }
    if (variant === "TIMEBASE") {
        if (!/^TIM[1-8]$/u.test(base ?? ""))
            return null;
        return timerBase(base);
    }
    return PERIPHERAL_PRESETS.find((preset) => preset.name.toUpperCase() === raw) ?? null;
}
/** 支持的外设名列表（报错时给用户看）。 */
export function peripheralPresetNames() {
    // 纯时基是"变体"写法：TIM2/3/4:timebase，不占引脚。
    return [...PERIPHERAL_PRESETS.map((preset) => preset.name), "TIM1..TIM8:timebase", "ADC1:1,4,5（多 Rank，通道号列表）"];
}
