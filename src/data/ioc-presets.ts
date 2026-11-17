/**
 * L2 数据：`.ioc` 外设预设 —— "启用一个外设"到底要写哪些键。
 *
 * 为什么必须做成预设：CubeMX **不是**「读到 USART1.VirtualMode 就建 USART1」。
 * CubeMX 按「某根脚的 Mode + Signal」推导复用模式，再核对 Mcu.IPn 中有该实例，才生成
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

/** 外设预设里的一根脚。 */
export interface PeripheralPinRole {
  /** 角色名（`pins` 覆盖时用）：tx/rx/ch1/in1… */
  role: string;
  /** 默认引脚，写"逻辑名"（PA0、PA9），落键前按族别名换成 db 名（PA0-WKUP）。 */
  defaultPin: string;
  /** `<pin>.Signal` 的值。共享信号用 CubeMX 的规范化名（`S_TIM2_CH1_ETR`、`ADCx_IN1`）。 */
  signal: string;
  /** `<pin>.Mode` 的值；共享信号引脚与单模式引脚留空串（都不写 .Mode）。 */
  mode: string;
  /**
   * 共享信号（定时器 / ADC）：这类引脚在 CubeMX 自己的 .ioc 里**没有 .Mode**，
   * 靠 `SH.<key>.0=<IP 信号>,<IP 模式>` + `SH.<key>.ConfNb=1` 表达“这根脚做哪个外设的哪个功能”。
   * 缺了 SH 块时 CubeMX 会把整个外设静默丢掉（2026-10-31 实测：TIM3/ADC1 全部不生成）。
   */
  shared?: { key: string; ipSignal: string; ipMode: string };
}

/** 一个外设预设。 */
export interface PeripheralPreset {
  /** 预设名（= Mcu.IPn 里的实例名）：USART1 / TIM2 / ADC1。 */
  name: string;
  /** 人话名，报告里用。 */
  label: string;
  /** Mcu.IPn 里写的实例名（多数与 name 相同）。 */
  ip: string;
  /** 需要占用的引脚。 */
  pins: PeripheralPinRole[];
  /** `<ip>.<参数名>` = 值；名字相同的参数会被合并进 `<ip>.IPParameters`。 */
  parameters: Array<{ name: string; value: string }>;
  /**
   * 参数键名随芯片的 IP 版本变时置 true（目前只有 I2C：F1/F2/F4/L1 与 F0/F3/L0+/L4 两代键名不同）。
   * ioc-plan 见到它就用 `i2cParameters(家族, 速率)` 重新生成参数，而不是照抄 `parameters`。
   */
  parametersByFamily?: boolean;
  /** 额外的全局键（例如 ADC 的 RCC.ADCPresc）。 */
  extraEntries?: Array<{ key: string; value: string }>;
  /**
   * 逐字写入的键（不受 `<ip>.<名字>` 约束、也不进 IPParameters）。
   * DMA 就靠这个：真键是 `Dma.ADC1.0.Instance`，跟预设的 ip 名对不上。
   */
  rawEntries?: Array<{ key: string; value: string }>;
  /** 该预设的注意点，plan 的时候原样报给用户。 */
  notes?: string[];
}

/**
 * 族相关的引脚别名：**离线回退表**，仅在读不到 CubeMX db 时使用。
 *
 * 正常路径是 src/engine/ioc-plan.ts 的 createPinNameResolver：该解析器按 .ioc 里的 Mcu.Name 去本机
 * CubeMX 的 `db/mcu/<Mcu.Name>.xml` 查真实引脚名（R16），db 里叫什么就写什么。
 * 这张表只收 F1 的 6 根带后缀的脚（PA0→PA0-WKUP、PC13→PC13-TAMPER-RTC、PC14/PC15、PD0/PD1），
 * 没装 CubeMX 或 db 里没有这颗时才会用到；CubeMX 换版本后 db 名可能变，那时这里就会写错脚，
 * 所以缺 db 时 ioc-plan 会在 warnings 里明确提醒。
 */
export const PIN_DB_ALIASES: Record<string, Record<string, string>> = {
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
export function pinDbName(family: string, pin: string): string {
  const table = PIN_DB_ALIASES[family.trim().toUpperCase()];
  if (table === undefined) return pin;
  return table[pin.trim().toUpperCase()] ?? pin;
}

function usart(name: string, tx: string, rx: string): PeripheralPreset {
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


/**
 * SPI 主机预设（S187）：键集与「引脚 .Mode 必须与模式配套」这两点都是实测出来的。
 *
 * 实测（F303 + CubeMX 6.18.1）：`Full_Duplex_Master` 只配了 SCK/MOSI、缺 MISO 时，
 * CubeMX **静默丢弃整个 SPI1**——不出 spi.c、`HAL_SPI_MODULE_ENABLED` 仍是注释，
 * 日志里连 `Load IP Config File for SPI1` 都没有。补齐 PA6(MISO) 后立刻生成 MX_SPI1_Init；
 * 把 Direction 改成 1LINE、两根脚改成 `TransmitOnly_Master`（只发不收）也能生成。
 * 所以 SPI 的 .Mode 不是装饰：它决定这套脚是否构成一个完整配置。
 */
function spi(
  name: string,
  mode: "Full_Duplex_Master" | "TransmitOnly_Master" | "ReceiveOnly_Master",
  pins: Array<{ role: string; pin: string }>,
): PeripheralPreset {
  const direction = mode === "Full_Duplex_Master" ? "SPI_DIRECTION_2LINES" : "SPI_DIRECTION_1LINE";
  const suffix = mode === "Full_Duplex_Master" ? "" : "（" + (mode === "TransmitOnly_Master" ? "只发" : "只收") + "）";
  return {
    name: mode === "Full_Duplex_Master" ? name : name + (mode === "TransmitOnly_Master" ? ":tx" : ":rx"),
    label: name + " SPI 主机" + suffix,
    ip: name,
    pins: pins.map((entry) => ({ role: entry.role, defaultPin: entry.pin, signal: name + "_" + entry.role.toUpperCase(), mode })),
    parameters: [
      { name: "VirtualType", value: "VM_MASTER" },
      { name: "Mode", value: "SPI_MODE_MASTER" },
      { name: "Direction", value: direction },
      { name: "TIMode", value: "SPI_TIMODE_DISABLE" },
      { name: "DataSize", value: "SPI_DATASIZE_8BIT" },
      { name: "FirstBit", value: "SPI_FIRSTBIT_MSB" },
      { name: "BaudRatePrescaler", value: "SPI_BAUDRATEPRESCALER_4" },
      { name: "CalculateBaudRate", value: "true" },
      { name: "CLKPolarity", value: "SPI_POLARITY_LOW" },
      { name: "CLKPhase", value: "SPI_PHASE_1EDGE" },
      { name: "NSS", value: "SPI_NSS_SOFT" },
      { name: "CRCCalculation", value: "SPI_CRCCALCULATION_DISABLE" },
      { name: "CRCPolynomial", value: "7" },
    ],
    notes: [
      name + "：" + (mode === "Full_Duplex_Master"
        ? "全双工要求 SCK+MISO+MOSI 三根脚齐全，缺一根 CubeMX 会把整个外设静默丢掉"
        : "只发/只收模式用 " + String(direction) + "，只占 " + String(pins.length) + " 根脚"),
      "默认 8Bit / MSB / CPOL=Low / CPHA=1Edge / NSS=软件 / 分频 4（72 MHz 下 18 MHz）；" +
        "要看实际时钟用 entries 设 " + name + ".BaudRatePrescaler",
    ],
  };
}

/**
 * I2C 主机预设（S187）：键名分两代，**按芯片用的 IP 版本选**。
 *
 * - 老的 I2C v1（i2c1_v1_0/v1_1，F1/F2/F4/L1 等）：`ClockSpeed` + `DutyCycle` + `OwnAddress1`；
 * - 新的 I2C v2（i2c2_v1_1，F0/F3/L0+/L4/G0/G4 等）：`I2C_Speed_Mode` + `Speed` + `Timing` + `OwnAddress`
 *   （见 `db/mcu/IP/I2C-F0-i2c2_v1_1_Cube_Modes.xml` 的 RefMode I2C 参数表）。
 *
 * 写错代的键不会报错——CubeMX 只是不认，然后安静地什么都不生成（实测 F303 上第一版用了
 * `ClockSpeed/DutyCycle`，生成阶段直接 CodeEngine 报错、连 main.c 都没有）。所以这一条按族分派。
 * 引脚 `.Mode` 两代都是 `I2C`，缺了同样不生成。
 */
const I2C_LEGACY_FAMILIES = new Set(["F1", "F2", "F4", "L1"]);

/** 从 `Mcu.Name`（例如 STM32F303C(B-C)Tx）里取家族代号：F3 / F1 / L4 … */
export function chipFamily(iocText: string): string {
  const name = /^Mcu\.Name=(.+)$/mu.exec(iocText)?.[1] ?? "";
  const family = /^STM32([A-Z]\d)/u.exec(name.trim());
  return family === null ? "" : family[1]!;
}

export function i2cParameters(family: string, speed: number): { name: string; value: string }[] {
  if (I2C_LEGACY_FAMILIES.has(family)) {
    return [
      { name: "ClockSpeed", value: String(speed) },
      { name: "DutyCycle", value: "I2C_DUTYCYCLE_2" },
      { name: "OwnAddress1", value: "0" },
      { name: "AddressingMode", value: "I2C_ADDRESSINGMODE_7BIT" },
    ];
  }
  return [
    { name: "I2C_Speed_Mode", value: speed > 100000 ? "I2C_Fast" : "I2C_Standard" },
    { name: "Speed", value: String(speed / 1000) },
    { name: "Analog_Filter", value: "I2C_ANALOGFILTER_ENABLE" },
    { name: "OwnAddress", value: "0" },
    { name: "DualAddressMode", value: "I2C_DUALADDRESS_DISABLE" },
    { name: "GeneralCallMode", value: "I2C_GENERALCALL_DISABLE" },
    { name: "NoStretchMode", value: "I2C_NOSTRETCH_DISABLE" },
    { name: "AddressingMode", value: "I2C_ADDRESSINGMODE_7BIT" },
  ];
}

function i2c(name: string, scl: string, sda: string, speed = 100000): PeripheralPreset {
  return {
    name,
    label: name + " I2C 主机（" + String(speed / 1000) + " kHz）",
    ip: name,
    pins: [
      { role: "scl", defaultPin: scl, signal: name + "_SCL", mode: "I2C" },
      { role: "sda", defaultPin: sda, signal: name + "_SDA", mode: "I2C" },
    ],
    // 占位：真正的键在 ioc-plan 里按 MCU 家族从 i2cParameters() 取（两代键名不同）。
    parameters: i2cParameters("", speed),
    parametersByFamily: true,
    notes: [
      name + "：SCL/SDA 都要外接上拉（模块板一般不带上拉）；默认 7 位地址、主机模式、" + String(speed / 1000) + " kHz",
      "键名按芯片的 I2C IP 代分派：F1/F2/F4/L1 用 ClockSpeed+DutyCycle，F0/F3/L0+/L4/G0/G4 用 I2C_Speed_Mode+Speed",
    ],
  };
}

function timerPwm(name: string, channel: number, pin: string, dbSignal: string): PeripheralPreset {
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
function adc(name: string, pin: string, channel: number): PeripheralPreset {
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
/** 允许配 DMA 的外设（F103 的 DMA 请求表：ADC1/SPI/I2C/USART/TIM 都能接到 DMA1 的某个通道）。 */
const ALLOWED_DMA_IP = ["ADC1", "ADC2", "ADC3", "SPI1", "SPI2", "I2C1", "I2C2", "USART1", "USART2", "USART3", "TIM1", "TIM2", "TIM3", "TIM4"];

const ADC_PIN_BY_CHANNEL: Record<number, string> = {
  0: "PA0", 1: "PA1", 4: "PA4", 5: "PA5", 6: "PA6", 7: "PA7", 8: "PB0", 9: "PB1",
};

/**
 * 多 Rank ADC（C5）：一次扫多路，写成 `ADC1:1,4,5`。
 *
 * 键的形状来自 ImportADCParameter 的反汇编：每条转换占三个同下标键
 * （Rank-n / Channel-n / SamplingTime-n），`NbrOfConversion` 必须等于条数，
 * Rank 从 1 开始连续（R2 规则会盯着这三点）。引脚用 ADCx_INn 共享信号 + SH 块表达。
 */
function adcMulti(name: string, channels: number[]): PeripheralPreset {
  const pins: PeripheralPinRole[] = channels.map((channel) => ({
    role: "in" + String(channel),
    defaultPin: ADC_PIN_BY_CHANNEL[channel] ?? "",
    signal: "ADCx_IN" + String(channel),
    mode: "",
    shared: { key: "ADCx_IN" + String(channel), ipSignal: name + "_IN" + String(channel), ipMode: "IN" + String(channel) },
  }));
  const parameters: Array<{ name: string; value: string }> = channels.flatMap((channel, index) => [
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
function timerBase(name: string): PeripheralPreset {
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

/**
 * DMA 通道预设（C3）：`DMA:ADC1` → 给 ADC1 配一条 DMA 通道。
 *
 * 八个字段的顺序来自 ImportDMAParameter 的反汇编：Instance、Direction、PeriphInc、MemInc、
 * PeriphDataAlignment、MemDataAlignment、Mode、Priority。缺 `Mcu.IPn=DMA` 时 CubeMX 会把整组
 * Dma.* 丢掉（R1 规则专盯这一条），所以预设的 ip 就是 "DMA"。
 * `Dma.RequestsNb` 由 ioc-plan 按实际 Dma.<IP>.<n> 组数重算，不在这里写死。
 */
function dmaPreset(ip: string, channel: string): PeripheralPreset {
  const base = "Dma." + ip + ".0.";
  const isAdc = ip.startsWith("ADC");
  return {
    name: "DMA:" + ip,
    label: ip + " 的 DMA 通道（" + channel + "）",
    ip: "DMA",
    pins: [],
    parameters: [],
    rawEntries: [
      { key: base + "Instance", value: channel },
      { key: base + "Direction", value: "DMA_PERIPH_TO_MEMORY" },
      { key: base + "PeriphInc", value: "DMA_PINC_DISABLE" },
      { key: base + "MemInc", value: "DMA_MINC_ENABLE" },
      { key: base + "PeriphDataAlignment", value: isAdc ? "DMA_PDATAALIGN_HALFWORD" : "DMA_PDATAALIGN_BYTE" },
      { key: base + "MemDataAlignment", value: isAdc ? "DMA_MDATAALIGN_HALFWORD" : "DMA_MDATAALIGN_BYTE" },
      { key: base + "Mode", value: "DMA_CIRCULAR" },
      { key: base + "Priority", value: "DMA_PRIORITY_LOW" },
    ],
    notes: [
      ip + " 的 DMA：circular + MINC，外设/内存都是半字（ADC 是 12 位右对齐，用 uint16_t 缓冲最省事）；" +
        "要改通道/优先级用 parameters 覆盖 Instance / Mode / Priority",
    ],
  };
}

/** 内置预设表（按名字查）。 */
export const PERIPHERAL_PRESETS: PeripheralPreset[] = [
  usart("USART1", "PA9", "PA10"),
  usart("USART2", "PA2", "PA3"),
  usart("USART3", "PB10", "PB11"),
  // S187：SPI/I2C 之前完全没有预设，模型只能自己拼键——拼错一根脚就会被 CubeMX 静默丢弃。
  spi("SPI1", "Full_Duplex_Master", [
    { role: "sck", pin: "PA5" },
    { role: "miso", pin: "PA6" },
    { role: "mosi", pin: "PA7" },
  ]),
  spi("SPI1", "TransmitOnly_Master", [
    { role: "sck", pin: "PA5" },
    { role: "mosi", pin: "PA7" },
  ]),
  spi("SPI1", "ReceiveOnly_Master", [
    { role: "sck", pin: "PA5" },
    { role: "miso", pin: "PA6" },
  ]),
  spi("SPI2", "Full_Duplex_Master", [
    { role: "sck", pin: "PB13" },
    { role: "miso", pin: "PB14" },
    { role: "mosi", pin: "PB15" },
  ]),
  i2c("I2C1", "PB6", "PB7"),
  i2c("I2C2", "PB10", "PB11"),
  // PA0 的定时器信号在 db 里与 TIM2_ETR 合并成 S_TIM2_CH1_ETR，必须用这个名字。
  timerPwm("TIM2", 1, "PA0", "S_TIM2_CH1_ETR"),
  timerPwm("TIM3", 1, "PA6", "S_TIM3_CH1"),
  timerPwm("TIM4", 1, "PB6", "S_TIM4_CH1"),
  adc("ADC1", "PA1", 1),
  adc("ADC2", "PA1", 1),
];

/** 按名字找预设（大小写不敏感）。支持 `TIM3:timebase` 这种"变体"写法。 */
export function findPeripheralPreset(name: string): PeripheralPreset | null {
  const raw = name.trim().toUpperCase();
  const [base, variant] = raw.split(":");
  // ADC1:1,4,5 —— 多 Rank（通道号列表）
  if (variant !== undefined && /^[0-9]+(?:,[0-9]+)*$/u.test(variant)) {
    if (!/^ADC[1-3]$/u.test(base ?? "")) return null;
    const channels = [...new Set(variant.split(",").map((item) => Number.parseInt(item, 10)))].filter((item) => Number.isFinite(item));
    if (channels.length === 0 || channels.some((channel) => ADC_PIN_BY_CHANNEL[channel] === undefined)) return null;
    return adcMulti(base as string, channels);
  }
  if (variant !== undefined && /^[A-Z]+[0-9]+$/u.test(variant) && base === "DMA") {
    const ip = variant;
    const channel = ip.startsWith("ADC") ? "DMA1_Channel1" : "DMA1_Channel" + String((ALLOWED_DMA_IP.indexOf(ip) % 7) + 2);
    return ALLOWED_DMA_IP.includes(ip) ? dmaPreset(ip, channel) : null;
  }
  if (variant === "TIMEBASE") {
    if (!/^TIM[1-8]$/u.test(base ?? "")) return null;
    return timerBase(base as string);
  }
  return PERIPHERAL_PRESETS.find((preset) => preset.name.toUpperCase() === raw) ?? null;
}

/** 支持的外设名列表（报错时给用户看）。 */
export function peripheralPresetNames(): string[] {
  // 纯时基是"变体"写法：TIM2/3/4:timebase，不占引脚。
  return [...PERIPHERAL_PRESETS.map((preset) => preset.name), "TIM1..TIM8:timebase", "ADC1:1,4,5（多 Rank，通道号列表）", "DMA:ADC1（给该外设配 DMA 通道）"];
}
