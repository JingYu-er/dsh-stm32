/**
 * STM32F1 时钟树事实表（只放"书上写的数字"，不放算法）。
 *
 * 为什么单独一张表：F1 的时钟上限、PLL 可选倍频、外设挂在哪条总线，这些是芯片事实，
 * 而"给定目标频率怎么挑组合"是策略（src/engine/clock-plan.ts）。事实和策略分开，
 * 以后扩 F0/F4 只换这张表，算法不用动。
 *
 * 依据：RM0008 §7（RCC）、DS5319（F103x8/xB）电气特性。F1 全系（value / connectivity）
 * 的 SYSCLK 上限都是 72 MHz；connectivity（105/107）多一级 PREDIV1，本插件暂不规划。
 */
export const F1_PLL_SOURCES = [
    {
        id: "hse",
        label: "HSE 8 MHz",
        iocValue: "RCC_PLLSOURCE_HSE",
        defaultHz: 8_000_000,
        selectable: true,
        note: "外部晶振（板上 8 MHz，值料号 HSE 范围 4–16 MHz）。精度由晶振决定，通常 ≤50 ppm，UART 波特率靠它就够准。",
    },
    {
        id: "hsi-div2",
        label: "HSI÷2 4 MHz",
        iocValue: "RCC_PLLSOURCE_HSI_DIV2",
        defaultHz: 4_000_000,
        selectable: true,
        note: "内部 RC 8 MHz ÷2。全温区 ±1%，UART 波特率会跟着漂，只在不接晶振时用。",
    },
    {
        id: "hsi",
        label: "HSI 8 MHz",
        iocValue: "RCC_PLLSOURCE_HSI",
        defaultHz: 8_000_000,
        selectable: false,
        note: "F1 值料号的 PLLSRC 只有 HSE / HSI÷2 两档；HSI 直接进 PLL 是互联型（105/107）经 PREDIV1 才有的路，本插件不规划。",
    },
];
export function pllSourceById(id) {
    return F1_PLL_SOURCES.find((source) => source.id === id) ?? null;
}
export const F1_PLL_MULS = Array.from({ length: 15 }, (_unused, index) => {
    const mul = index + 2;
    return { mul, iocValue: "RCC_PLL_MUL" + String(mul) };
});
export function pllMulValue(mul) {
    return "RCC_PLL_MUL" + String(mul);
}
/** 从 RCC.PLLMUL 的值（RCC_PLL_MUL9）反解倍频；认不出来返回 null。 */
export function pllMulFromValue(value) {
    const matched = /^RCC_PLL_MUL(\d{1,2})$/u.exec(value.trim());
    if (matched === null)
        return null;
    const mul = Number.parseInt(matched[1], 10);
    return Number.isFinite(mul) && mul >= 2 && mul <= 16 ? mul : null;
}
/** AHB / APB1 / APB2 分频：÷1、2、4、8、16（RM0008 RCC_CFGR.HPRE/PPRE1/PPRE2）。 */
export const F1_APB_DIVS = [1, 2, 4, 8, 16].map((div) => ({
    div,
    iocValue: "RCC_HCLK_DIV" + String(div),
}));
/** ADC 预分频：÷2、4、6、8（RCC_CFGR.ADCPRE）。 */
export const F1_ADC_DIVS = [2, 4, 6, 8].map((div) => ({
    div,
    iocValue: "RCC_ADCPCLK2_DIV" + String(div),
}));
/** USB 时钟：只能从 PLLCLK ÷1.5 来，所以 PLLCLK 必须是 72 MHz（→48 MHz）。 */
export const F1_USB_PRESCALER = {
    iocValue: "RCC_USBCLKSOURCE_PLL_DIV1_5",
    hz: 48_000_000,
    requiresPllClkHz: 72_000_000,
    note: "F1 的 USB 只有 PLLCLK÷1.5 一路：PLLCLK=72 MHz 时 48 MHz 可用，其它频率下 USB 跑不起来。",
};
export function apbDivValue(div) {
    return "RCC_HCLK_DIV" + String(div);
}
export function adcDivValue(div) {
    return "RCC_ADCPCLK2_DIV" + String(div);
}
export function apbDivFromValue(value) {
    const matched = /^RCC_HCLK_DIV(\d{1,2})$/u.exec(value.trim());
    if (matched === null)
        return null;
    const div = Number.parseInt(matched[1], 10);
    return [1, 2, 4, 8, 16].includes(div) ? div : null;
}
export function adcDivFromValue(value) {
    const matched = /^RCC_ADCPCLK2_DIV(\d{1,2})$/u.exec(value.trim());
    if (matched === null)
        return null;
    const div = Number.parseInt(matched[1], 10);
    return [2, 4, 6, 8].includes(div) ? div : null;
}
/** 上限（Hz）。USB 不是"上限"而是"必须等于"：必须正好 48 MHz。 */
export const F1_CLOCK_LIMITS = {
    sysclkHz: 72_000_000,
    apb1Hz: 36_000_000,
    apb2Hz: 72_000_000,
    adcHz: 14_000_000,
    usbHz: 48_000_000,
};
/** 上限的人读标签，报告里拼错误消息用。 */
export const F1_CLOCK_LIMIT_LABELS = {
    sysclkHz: "SYSCLK",
    apb1Hz: "APB1",
    apb2Hz: "APB2",
    adcHz: "ADC",
    usbHz: "USB",
};
/**
 * 外设 → 总线（RM0008 的 memory map 与 RCC 使能寄存器分组）：
 * APB2 = USART1 / SPI1 / ADC1-3 / TIM1 / TIM8 / GPIO / AFIO；
 * APB1 = USART2-5 / SPI2-3 / I2C1-2 / TIM2-7 / USB / CAN / DAC。
 * 这里只列报告要展示的那批，够覆盖 F1 值料号常见的用法。
 */
export const F1_PERIPHERAL_CLOCKS = [
    { id: "USART1", label: "USART1", bus: "apb2", kind: "usart" },
    { id: "USART2", label: "USART2", bus: "apb1", kind: "usart" },
    { id: "USART3", label: "USART3", bus: "apb1", kind: "usart" },
    { id: "SPI1", label: "SPI1", bus: "apb2", kind: "spi" },
    { id: "SPI2", label: "SPI2", bus: "apb1", kind: "spi" },
    { id: "I2C1", label: "I2C1", bus: "apb1", kind: "i2c" },
    { id: "I2C2", label: "I2C2", bus: "apb1", kind: "i2c" },
    { id: "ADC1", label: "ADC1/2", bus: "apb2", kind: "adc" },
    { id: "TIM1", label: "TIM1", bus: "apb2", kind: "tim" },
    { id: "TIM2", label: "TIM2", bus: "apb1", kind: "tim" },
    { id: "TIM3", label: "TIM3", bus: "apb1", kind: "tim" },
    { id: "TIM4", label: "TIM4", bus: "apb1", kind: "tim" },
    { id: "USB", label: "USB", bus: "apb1", kind: "usb" },
    { id: "Cortex", label: "Cortex-SysTick", bus: "ahb", kind: "core" },
];
/** UART 波特率整除误差默认算这几档（F1 值料号常用档）。 */
export const F1_BAUD_LIST = [9600, 19200, 38400, 57600, 115200, 230400];
/**
 * templates/scaffold/demo.ioc 里 RCC.IPParameters 列出的那 20 个键。
 * 改时钟时必须成套重算——只改 RCC.PLLMUL 会让 CubeMX 下次打开按旧 Freq_Value 生成
 * SystemClock_Config，HAL_RCC_ClockConfig 直接算错（这是本插件最容易埋雷的地方）。
 */
export const F1_RCC_IP_KEYS = [
    "ADCFreqValue",
    "AHBFreq_Value",
    "APB1CLKDivider",
    "APB1Freq_Value",
    "APB1TimFreq_Value",
    "APB2Freq_Value",
    "APB2TimFreq_Value",
    "FCLKCortexFreq_Value",
    "FamilyName",
    "HCLKFreq_Value",
    "MCOFreq_Value",
    "PLLCLKFreq_Value",
    "PLLMCOFreq_Value",
    "PLLMUL",
    "PLLSourceVirtual",
    "SYSCLKFreq_VALUE",
    "SYSCLKSource",
    "TimSysFreq_Value",
    "USBFreq_Value",
    "VCOOutput2Freq_Value",
];
