/**
 * STM32F1 时钟树事实表（只放"书上写的数字"，不放算法）。
 *
 * 单独成表的原因：F1 的时钟上限、PLL 可选倍频、外设所属总线，均属芯片事实，
 * 而"给定目标频率怎么挑组合"是策略（src/engine/clock-plan.ts）。事实和策略分开，
 * 以后扩 F0/F4 只换这张表，算法不用动。
 *
 * 依据：RM0008 §7（RCC）、DS5319（F103x8/xB）电气特性。F1 全系（value / connectivity）
 * 的 SYSCLK 上限都是 72 MHz；connectivity（105/107）多一级 PREDIV1，本插件暂不规划。
 */

/**
 * PLL/SYSCLK 的输入源。F1 值料号 PLLSRC 只有 HSE / HSI÷2 两种（RM0008 RCC_CFGR.PLLSRC）。
 * `rc64` 是无线 SoC（WB0/WL3）的 64 MHz 内部 RC 多相时钟（db 里叫 RC64MPLL，频率 PLL64_VALUE）：
 * RC64MPLL 的频率不从 .ioc 读取，固定 64 MHz，只能经 SYSCLK64Divider 分频。
 */
export type ClockSourceId = "hse" | "hsi-div2" | "hsi" | "rc64";

export interface PllSourceFact {
  id: ClockSourceId;
  /** 人读的名字。 */
  label: string;
  /** RCC.PLLSourceVirtual 的取值。 */
  iocValue: string;
  /** 默认输入频率（Hz）；HSE 以 RCC.HSE_VALUE 为准，这里是缺省值。 */
  defaultHz: number;
  /**
   * 这一路的标称频率写在 .ioc 的哪个键（`RCC.HSE_VALUE` / `RCC.HSI_VALUE`）。
   * 缺省（空）时按 id 猜：hse → HSE_VALUE、其它 → HSI_VALUE；固定频率源（RC64MPLL）不写。
   */
  hzKey?: string;
  /** 能不能当 PLL 输入。 */
  selectable: boolean;
  /** PLL 输入前的固定分频（F0/L0 的 RCC_PLLSOURCE_HSI 硬件上就是 HSI/2；缺省 1）。 */
  divider?: number;
  note: string;
}

export const F1_PLL_SOURCES: readonly PllSourceFact[] = [
  {
    id: "hse",
    label: "HSE 8 MHz",
    iocValue: "RCC_PLLSOURCE_HSE",
    defaultHz: 8_000_000,
    selectable: true,
    note: "外部晶振（开发板 8 MHz，值料号 HSE 范围 4–16 MHz）。精度由晶振决定，通常 ≤50 ppm，UART 波特率精度由晶振保证。",
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

export function pllSourceById(id: string, sources: readonly PllSourceFact[] = F1_PLL_SOURCES): PllSourceFact | null {
  return sources.find((source) => source.id === id) ?? null;
}

/** PLL 倍频：×2..×16（RCC_CFGR.PLLMUL，值料号没有 ×6.5/×8 之外的半档）。 */
export interface PllMulFact {
  mul: number;
  /** RCC.PLLMUL 的取值。 */
  iocValue: string;
}

export const F1_PLL_MULS: readonly PllMulFact[] = Array.from({ length: 15 }, (_unused, index) => {
  const mul = index + 2;
  return { mul, iocValue: "RCC_PLL_MUL" + String(mul) };
});

export function pllMulValue(mul: number): string {
  return "RCC_PLL_MUL" + String(mul);
}

export interface DividerFact {
  div: number;
  /** .ioc 里的取值，例如 RCC_HCLK_DIV2 / RCC_ADCPCLK2_DIV6。 */
  iocValue: string;
}

/** AHB / APB1 / APB2 分频：÷1、2、4、8、16（RM0008 RCC_CFGR.HPRE/PPRE1/PPRE2）。 */
export const F1_APB_DIVS: readonly DividerFact[] = [1, 2, 4, 8, 16].map((div) => ({
  div,
  iocValue: "RCC_HCLK_DIV" + String(div),
}));

/** ADC 预分频：÷2、4、6、8（RCC_CFGR.ADCPRE）。 */
export const F1_ADC_DIVS: readonly DividerFact[] = [2, 4, 6, 8].map((div) => ({
  div,
  iocValue: "RCC_ADCPCLK2_DIV" + String(div),
}));

/** USB 时钟：只能从 PLLCLK ÷1.5 来，所以 PLLCLK 必须是 72 MHz（→48 MHz）。 */
export const F1_USB_PRESCALER = {
  iocValue: "RCC_USBCLKSOURCE_PLL_DIV1_5",
  hz: 48_000_000,
  requiresPllClkHz: 72_000_000,
  note: "F1 的 USB 只有 PLLCLK÷1.5 一路：PLLCLK=72 MHz 时 48 MHz 可用，其它频率下 USB 跑不起来。",
} as const;

export function apbDivValue(div: number): string {
  return "RCC_HCLK_DIV" + String(div);
}

export function adcDivValue(div: number): string {
  return "RCC_ADCPCLK2_DIV" + String(div);
}

export function apbDivFromValue(value: string): number | null {
  const matched = /^RCC_HCLK_DIV(\d{1,2})$/u.exec(value.trim());
  if (matched === null) return null;
  const div = Number.parseInt(matched[1] as string, 10);
  return [1, 2, 4, 8, 16].includes(div) ? div : null;
}

export function adcDivFromValue(value: string): number | null {
  const matched = /^RCC_ADCPCLK2_DIV(\d{1,2})$/u.exec(value.trim());
  if (matched === null) return null;
  const div = Number.parseInt(matched[1] as string, 10);
  return [2, 4, 6, 8].includes(div) ? div : null;
}

/** 上限（Hz）。USB 不是"上限"而是"必须等于"：必须正好 48 MHz。 */
export const F1_CLOCK_LIMITS = {
  sysclkHz: 72_000_000,
  apb1Hz: 36_000_000,
  apb2Hz: 72_000_000,
  adcHz: 14_000_000,
  usbHz: 48_000_000,
} as const;

export type ClockBusId = "ahb" | "apb1" | "apb2";
export type PeripheralKind = "usart" | "spi" | "i2c" | "tim" | "adc" | "usb" | "core";

export interface PeripheralClockFact {
  /** 报告里的 id，也是 Mcu.IP* 里的名字（USB / ADC1 之类）。 */
  id: string;
  label: string;
  /** 看门狗式的一条：先看总线频率，再按 kind 决定要不要再除。 */
  bus: ClockBusId;
  kind: PeripheralKind;
  /** Mcu.IPn 里出现这个值就算启用（缺省 = id）。 */
  ip?: string;
}

/**
 * 外设 → 总线（RM0008 的 memory map 与 RCC 使能寄存器分组）：
 * APB2 = USART1 / SPI1 / ADC1-3 / TIM1 / TIM8 / GPIO / AFIO；
 * APB1 = USART2-5 / SPI2-3 / I2C1-2 / TIM2-7 / USB / CAN / DAC。
 * 这里只列报告要展示的那批，够覆盖 F1 值料号常见的用法。
 */
export const F1_PERIPHERAL_CLOCKS: readonly PeripheralClockFact[] = [
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
export const F1_BAUD_LIST: readonly number[] = [9600, 19200, 38400, 57600, 115200, 230400];

/** PLL 输入频段（H5/U5/WBA 的 VCI range）：输入区间 + 该段的 VCO 区间 + 要写的枚举值。 */
export interface VcoBand {
  /** 写进 RCC.PLL1_VCI_Range 的枚举值（db 的 PossibleValue）。 */
  value: string;
  /** 这一段覆盖的 PLL 输入频率。 */
  inMinHz: number;
  inMaxHz: number;
  /** 这一段允许的 VCO 输出频率。 */
  minHz: number;
  maxHz: number;
  /** 这一段要求的 RCC.PLL1_VCO_SEL 值（没有就不写）。 */
  vcoSel?: string;
}

/**
 * 一套完整的「时钟事实」：planClock 只认这一层，不再直接读 F1_* 常量。
 *
 * F1_FACTS 为回退数据（没有 CubeMX db 时使用），正常情况下由 src/data/clock-db.ts 从
 * db/mcu/<型号>.xml 与 db/mcu/IP/RCC-*.xml 现算出一份同形状的事实。
 * busLimits（APB1/APB2/ADC 上限）与 vco 区间由 clock-db.ts 从 db 的 RCC Modes 读，
 * 核过手册/真机的族用 override 表。
 */
export interface ClockFacts {
  /**
   * 时钟模型：
   *   pllmul —— 源 × PLLMUL（F0/F1/F3/L0/L1…）
   *   pllmn  —— 源 ÷ PLLM × PLLN ÷ PLLP|PLLR（F2/F4/F7/G4/L4…）
   *   direct —— 没有 PLL，SYSCLK 直接取源（÷ 可选源分频），C0 这类族
   * 缺省按 pllmul。
   */
  model?: "pllmul" | "pllmn" | "direct";
  muls: readonly PllMulFact[];
  /** pllmn 模型才用得到：PLLM 分频枚举、PLLN 范围、PLLP 分频枚举。 */
  pllM?: readonly DividerFact[];
  pllN?: { min: number; max: number } | null;
  pllP?: readonly DividerFact[];
  /** L4 这类族 SYSCLK 走 PLLR（PLLP 是 PLLSAI1 的输出）。 */
  pllR?: readonly DividerFact[];
  /** 用哪个 PLL 输出当 SYSCLK：P（F2/F4/F7/G4）或 R（L4）。缺省 P。 */
  sysclkOutput?: "P" | "R";
  /**
   * PLL1 族（H5/U5/WBA/L4+）的分频键是 RCC.PLL1P / RCC.PLL1R，不是 RCC.PLLP / RCC.PLLR。
   * 写错键名 CubeMX 不报错、只是当成未知键丢掉，PLL 就退回默认值 → 频率对不上。
   */
  pll1Naming?: boolean;
  /** 写 PLLM / PLLP / PLLR 用的键名（L4+ 是 RCC.PLLM1 / RCC.PLL1P；缺省走 PLLM/PLLP/PLLR）。 */
  pllMKey?: string;
  pllPKey?: string;
  pllRKey?: string;
  /** false = db 给了 Cortex 选择/分频参数，CortexFreq_Value 由 CubeMX 自己算，planner 别写。 */
  cortexFollowsHclk?: boolean;
  /**
   * PLL 输入频段（H5 的 PLL1_VCI_Range：1–2/2–4/4–8/≥8 MHz 各一段，段内 VCO 上限不同）。
   * 非空时 planner 必须先按输入频率选段，再把段值写回 RCC.PLL1_VCI_Range。
   */
  vcoBands?: readonly VcoBand[];
  /** 写输入频段用哪个键（RCC.PLL1_VCI_Range）；没有键名就不写。 */
  vciRangeKey?: string;
  /** 写 VCO 档位所用的键（RCC.PLL1_VCO_SEL，H5 通过该键切换 150–420/128–560 MHz）。 */
  vcoSelKey?: string;
  /** 打开 PLL 的键（H5/U5 的 RCC.PLLUsed=1 + RCC.PLLState=RCC_PLL_ON）。 */
  pllEnable?: { usedKey: string; usedValue: string; stateKey: string; stateValue: string };
  /** db 里这一族有的派生频率名（写派生键前先查，避免写进 CubeMX 会丢的名字）。 */
  knownDerivedNames?: readonly string[];
  sources: readonly PllSourceFact[];
  /**
   * 写 SYSCLK 源用哪个键：`RCC.SYSCLKSource`（多数族）或 `RCC.SYSCLKSourceVirtual`（F3 这类
   * 把源做成 Virtual 项的族）。由 clock-db 按 RCC Modes 里有没有 SYSCLKSourceVirtual 决定：
   * 键名写错时会被 CubeMX 静默丢弃（F303 实测），只能靠 PLL 键由 CubeMX 反推，结果不可靠。
   */
  sysclkSourceKey?: string;
  apbDivs: readonly DividerFact[];
  /**
   * AHB 分频枚举（`RCC.AHBCLKDivider` 的取值）：只有 pllmn 族写这个键。
   * 名字按族不同（F2/F4/F7 是 RCC_SYSCLK_DIVn，C0 是 RCC_HCLK_DIVn），必须从 db 读，
   * 写错不会报错：CubeMX 载入时直接死循环（F2 实测 >240 s 不返回）。
   */
  ahbDivs?: readonly DividerFact[];
  /**
   * APB2 分频枚举（`RCC.APB2CLKDivider` 的取值）。**没有这个参数就不是双 APB 族**（C0 只有
   * APB1CLKDivider）：不能写 `RCC.APB2CLKDivider`，写了 CubeMX 会当成未知键丢掉。
   */
  apb2Divs?: readonly DividerFact[];
  /**
   * direct 模型：源分频枚举（C0 的 HSISYSCLKDivider：÷1/2/4/…/128）与该枚举写入 .ioc 的键名。
   * 枚举为空表示这一族没有源分频（HSE 直连），planner 不写 `RCC.HSISYSCLKDivider`。
   */
  srcDivs?: readonly DividerFact[];
  srcDivKey?: string;
  /** 源分频只对这些源生效（C0 的 HSISYSCLKDivider 只管 HSI）。 */
  srcDivSources?: readonly ClockSourceId[];
  /**
   * 每个源各自的分频键（WB0/WL3 这种「一个源一套分频」的族：HSE 走 SYSCLK32Divider/SYSCLK48Divider，
   * RC64MPLL 走 SYSCLK64Divider）。有这张表时 planner 优先按该表查询，没有再回落到上面的单键写法。
   */
  srcDivBySource?: Partial<Record<ClockSourceId, { key: string; divs: readonly DividerFact[] }>>;
  /**
   * db 里这一族 RCC 的派生频率参数名（`SYSCLKFreq_VALUE` / `APBFreq_Value` …）。
   * direct 模型按名字算得出来的会写对，写不对的宁可留给 CubeMX 重算——写错值会让
   * ioc_verify 报「值被改写」而不是「派生值重算」，那是真差异。
   */
  derivedClockNames?: readonly string[];
  adcDivs: readonly DividerFact[];
  limits: { sysclkHz: number; apb1Hz: number; apb2Hz: number; adcHz: number };
  /** pllmn 模型才用得到：VCO 输出与 PLL 输入的允许区间（db 的 Min/Max 或 override 表）。 */
  vco?: { minHz: number; maxHz: number; inMinHz?: number; inMaxHz?: number };
  usb: { hz: number; requiresPllClkHz: number; iocValue: string };
  peripheralClocks: readonly PeripheralClockFact[];
  baudList: readonly number[];
}

export const F1_FACTS: ClockFacts = {
  muls: F1_PLL_MULS,
  sources: F1_PLL_SOURCES,
  apbDivs: F1_APB_DIVS,
  adcDivs: F1_ADC_DIVS,
  limits: F1_CLOCK_LIMITS,
  usb: F1_USB_PRESCALER,
  peripheralClocks: F1_PERIPHERAL_CLOCKS,
  baudList: F1_BAUD_LIST,
};
