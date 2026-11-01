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
/** 按名字找预设（大小写不敏感）。 */
export function findPeripheralPreset(name) {
    const wanted = name.trim().toUpperCase();
    return PERIPHERAL_PRESETS.find((preset) => preset.name.toUpperCase() === wanted) ?? null;
}
/** 支持的外设名列表（报错时给用户看）。 */
export function peripheralPresetNames() {
    return PERIPHERAL_PRESETS.map((preset) => preset.name);
}
