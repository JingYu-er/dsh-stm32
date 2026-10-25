/**
 * L1：一条路线怎么走 —— HAL（.ioc + CubeMX 生成）还是寄存器（手写 main.c）。
 *
 * 为什么必须绑到具体工程才能答：同一个外设，"读一下温度"和"多通道 DMA 连续采样 + 过采样 + 校准"
 * 是两件事。抽象的"HAL vs 寄存器"对照表看着整齐，实际会让用户在一个他并没说清的场景上做选择。
 * 所以这里的输入是：这台芯片 + 这个工程 + 这句话要做什么；输出是逐个外设的代价与风险。
 *
 * 评判坐标只有两个，都按 1（最省）到 5（最费）：
 *   effort —— 写通它要动多少代码/多少个寄存器（开发效率）；
 *   risk   —— 时序/状态机/勘误上出错的机会（可靠性）。
 * 二者都不带"我更喜欢哪个"的偏好：寄存器版在 risk<=2 且 effort<=2 时才会被推荐。
 *
 * 纯函数：不读盘、不起进程，便于单测。固件包是否存在由 findFirmwarePackage 单独判（要读盘）。
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { FIRMWARE_FAMILIES } from "../data/firmware-packages.js";

export type RouteVerdict = "hal-only" | "both-viable" | "register-ok" | "unclear";
export type RouteAdvice = "hal" | "register" | "hal-required";
export type MatchSource = "requirement" | "explicit" | "ioc";

export interface RouteCost {
  effort: number;
  risk: number;
  /** 这条路线的关键动作（一句话，能当施工提示）。 */
  setup: string;
}

export interface PeripheralRule {
  id: string;
  label: string;
  /** 同族里只留命中的最高 rank（"串口中断" 命中时不再单列 "串口轮询"）。 */
  family: string;
  rank: number;
  /** 命中关键词（小写，与需求文本做 includes）。 */
  keywords: readonly string[];
  hal: RouteCost;
  /** null = 寄存器路线不做（复杂度/风险不可控）。 */
  reg: RouteCost | null;
  /** 寄存器路线相对 HAL 少掉了什么。 */
  regGap: string;
  halOnlyReason?: string;
}

const HAL_ONLY_CORE = "CubeMX 生成 + HAL 是唯一可靠路径";

/** 外设规则表。加外设只改这里（与 chips.ts 同一思路）。 */
export const PERIPHERAL_RULES: readonly PeripheralRule[] = [
  {
    id: "gpio",
    label: "GPIO（LED / 按键 / 继电器）",
    family: "gpio",
    rank: 1,
    keywords: ["gpio", "led", "灯", "按键", "按钮", "继电器", "蜂鸣器", "beep", "开关量", "io 口", "输出高低电平"],
    hal: { effort: 1, risk: 1, setup: "CubeMX 里点成 GPIO_Output/Input，代码里 HAL_GPIO_WritePin / HAL_GPIO_ReadPin" },
    reg: { effort: 1, risk: 1, setup: "RCC->APB2ENR 开时钟；GPIOx->CRL/CRH 配模式；写 BSRR/BRR 输出" },
    regGap: "没有（寄存器版 GPIO 比 HAL 还短）",
  },
  {
    id: "usart-poll",
    label: "USART 轮询（串口打印 / printf 重定向）",
    family: "usart",
    rank: 1,
    keywords: ["usart", "uart", "串口", "printf", "串口打印"],
    hal: { effort: 1, risk: 1, setup: "CubeMX 配 USART 异步 + 引脚；HAL_UART_Transmit；printf 重定向写 __io_putchar/fputc" },
    reg: { effort: 2, risk: 2, setup: "USARTx->BRR 按 PCLK 算波特率；CR1 使能 TE/UE；轮询 SR 的 TXE/TC 后写 DR" },
    regGap: "波特率要自己按当前 PCLK 算（改时钟树就得重算）；错误标志（ORE/FE/NE）要自己清",
  },
  {
    id: "usart-irq",
    label: "串口中断 / DMA 接收",
    family: "usart",
    rank: 2,
    keywords: ["串口中断", "串口接收中断", "串口 dma", "串口空闲中断", "uart irq", "usart irq", "idle 中断", "不定长接收"],
    hal: { effort: 2, risk: 2, setup: "CubeMX 勾 NVIC + DMA；HAL_UART_Receive_IT / ReceiveToIdle_DMA + 回调里搬缓冲" },
    reg: { effort: 3, risk: 4, setup: "CR1 开 RXNEIE；USARTx_IRQHandler 里读 DR 清标志；DMA 要配通道映射与环形缓冲" },
    regGap: "中断优先级、DMA 通道映射、溢出/错误恢复、环形缓冲全得自己写；漏清 ORE 会静默丢字节",
  },
  {
    id: "tim-base",
    label: "定时器（定时中断 / 精确计时）",
    family: "tim",
    rank: 1,
    keywords: ["定时器", "定时中断", "timer", "基准计时", "计时器"],
    hal: { effort: 1, risk: 1, setup: "CubeMX 配 TIM 内部时钟；HAL_TIM_Base_Start_IT + HAL_TIM_PeriodElapsedCallback" },
    reg: { effort: 2, risk: 2, setup: "RCC->APB1ENR 开时钟；TIMx->PSC/ARR 定时；DIER 开 UIE；SR 里清 UIF" },
    regGap: "预分频/重装值与 PCLK 的换算要自己算，溢出顺序（先清 SR 再算）错了会丢节拍",
  },
  {
    id: "tim-pwm",
    label: "PWM / 舵机 / 电机调速",
    family: "tim",
    rank: 2,
    keywords: ["pwm", "呼吸灯", "舵机", "电机调速", "占空比", "输出比较", "调光"],
    hal: { effort: 2, risk: 2, setup: "CubeMX 把通道配成 PWM Generation；HAL_TIM_PWM_Start；__HAL_TIM_SET_COMPARE 调占空比" },
    reg: { effort: 3, risk: 3, setup: "CCMRx 设 PWM 模式 1 + 预装载；CCER 开输出；CCRx 写占空比；引脚要配成复用推挽" },
    regGap: "复用功能映射（AFIO/GPIOx_AFR）、预装载与更新事件时序、死区（高级定时器）都得自己处理",
  },
  {
    id: "systick",
    label: "SysTick / 毫秒延时",
    family: "systick",
    rank: 1,
    keywords: ["systick", "毫秒延时", "延时", "hal_delay", "微秒延时"],
    hal: { effort: 1, risk: 1, setup: "CubeMX 默认就配好 SysTick；HAL_Delay / HAL_GetTick" },
    reg: { effort: 1, risk: 1, setup: "SysTick->LOAD = 节拍-1；CTRL 开时钟与中断；计数变量在 SysTick_Handler 里自增" },
    regGap: "没有（十几行就能写完，且不依赖 HAL 的 uwTick）",
  },
  {
    id: "exti",
    label: "外部中断（按键 / 脉冲计数）",
    family: "exti",
    rank: 1,
    keywords: ["exti", "外部中断", "按键中断", "中断唤醒", "脉冲计数"],
    hal: { effort: 1, risk: 1, setup: "CubeMX 把引脚配成 GPIO_EXTI + 勾 NVIC；HAL_GPIO_EXTI_Callback 里处理" },
    reg: { effort: 2, risk: 3, setup: "AFIO->EXTICR 选端口；EXTI->IMR/RTSR/FTSR；NVIC 使能；中断里清 EXTI->PR" },
    regGap: "忘了清 PR 会反复进中断；AFIO 时钟（RCC->APB2ENR 的 AFIOEN）漏开是最常见的坑",
  },
  {
    id: "adc-single",
    label: "ADC 单通道轮询",
    family: "adc",
    rank: 1,
    keywords: ["adc", "采样", "模拟量", "电压检测", "电池电压", "电位器", "热敏"],
    hal: { effort: 2, risk: 2, setup: "CubeMX 配 ADC 通道 + 采样时间；HAL_ADC_Start/PollForConversion/GetValue" },
    reg: { effort: 3, risk: 3, setup: "RCC 配 ADCCLK 分频；ADC1->SMPR2 采样时间；SQR1/2/3 排序列；CR2 开 ADON + 校准；等 EOC 读 DR" },
    regGap: "上电校准（RSTCAL/CAL）、采样时间与源阻抗匹配、EOC 顺序与 DMA 请求，错了读数是「看着有值但不准」",
  },
  {
    id: "adc-dma",
    label: "ADC 多通道 / 连续 / DMA",
    family: "adc",
    rank: 2,
    keywords: ["多通道 adc", "adc dma", "连续采样", "双通道 adc", "adc 扫描"],
    hal: { effort: 2, risk: 3, setup: "CubeMX 勾 Scan + Continuous + DMA；HAL_ADC_Start_DMA + 回调里换算" },
    reg: { effort: 4, risk: 4, setup: "SQR 排多通道 + CR2 连续 + DMA 通道映射 + 循环模式；DMA 半传输/传输完成回调自己写" },
    regGap: "通道顺序、DMA 通道与 ADC 的固定映射、循环缓冲的读写指针同步 —— 寄存器版这里最容易出脏数据",
  },
  {
    id: "dac",
    label: "DAC 模拟输出 / 波形",
    family: "dac",
    rank: 1,
    keywords: ["dac", "模拟输出", "波形输出", "正弦波"],
    hal: { effort: 2, risk: 2, setup: "CubeMX 开 DAC 通道；HAL_DAC_Start + HAL_DAC_SetValue；波形用定时器触发 + DMA" },
    reg: { effort: 3, risk: 3, setup: "RCC->APB1ENR 开 DAC；DHR12R 写值；CR 使能通道 + 触发源；配 DMA 做波形表" },
    regGap: "触发源选择、DMA 请求映射与双通道同步要自己配",
  },
  {
    id: "spi",
    label: "SPI 主机（传感器 / SPI Flash）",
    family: "spi",
    rank: 1,
    keywords: ["spi", "w25q", "spi flash", "spi 传感器", "屏幕 spi"],
    hal: { effort: 2, risk: 2, setup: "CubeMX 配 SPI 模式/CPOL/CPHA/分频；HAL_SPI_TransmitReceive；NSS 用软件 GPIO" },
    reg: { effort: 3, risk: 3, setup: "CR1 配 MSTR/BR/CPOL/CPHA/DFF；SPE 使能；轮询 SR 的 TXE/RXNE/BSY 收发" },
    regGap: "CPOL/CPHA 与从机器件手册对不上会「能发不能收」；NSS 时序与 BSY 等待要自己保证",
  },
  {
    id: "i2c",
    label: "I2C（OLED / EEPROM / 传感器）",
    family: "i2c",
    rank: 1,
    keywords: ["i2c", "iic", "oled", "eeprom", "mpu6050", "sht30", "bmp280", "aht20"],
    hal: { effort: 2, risk: 3, setup: "CubeMX 配 I2C 速度；HAL_I2C_Master_Transmit / Mem_Read；出错看 HAL 返回码" },
    reg: { effort: 4, risk: 5, setup: "CR2 产生 START；DR 写地址/数据；SR1/SR2 状态机逐位判 ADDR/TXE/RXNE/BTF/STOPF" },
    regGap: "这是寄存器版最容易卡死的外设：状态机顺序、时钟拉伸、总线忙时恢复（9 个时钟 + STOP）都得自己写",
  },
  {
    id: "can",
    label: "CAN / FDCAN 总线",
    family: "can",
    rank: 1,
    keywords: ["can", "fdcan", "can 总线", "canopen"],
    hal: { effort: 2, risk: 3, setup: "CubeMX 配位定时（波特率）+ 验收滤波器；HAL_FDCAN_Start + 收发回调" },
    reg: null,
    regGap: "位定时/采样点、验收滤波器寄存器布局、错误状态机（bus-off 恢复）差异极大",
    halOnlyReason: "位定时与验收滤波器寄存器在 F1/F4/G4/H7 上布局完全不同，错误状态机（bus-off 恢复）写错会整条总线掉线；" + HAL_ONLY_CORE,
  },
  {
    id: "usb",
    label: "USB（虚拟串口 / HID / U 盘）",
    family: "usb",
    rank: 1,
    keywords: ["usb", "cdc", "hid", "虚拟串口", "u 盘", "msc"],
    hal: { effort: 3, risk: 3, setup: "CubeMX 开 USB_DEVICE 中间件（CDC/HID）；只用生成的收发接口，别改中间件" },
    reg: null,
    regGap: "USB 协议栈 + 端点缓冲 + 枚举状态机，手写等于重写中间件",
    halOnlyReason: "USB 是协议栈级外设（枚举、端点、类驱动），寄存器版要重写整套中间件；" + HAL_ONLY_CORE,
  },
  {
    id: "eth",
    label: "以太网 / TCP-IP",
    family: "eth",
    rank: 1,
    keywords: ["以太网", "ethernet", "lwip", "网口", "tcp", "udp", "http"],
    hal: { effort: 4, risk: 4, setup: "CubeMX 开 ETH + LwIP 中间件；PHY 地址与 RMII/MII 引脚按板子配" },
    reg: null,
    regGap: "MAC/DMA 描述符环 + PHY 管理 + 协议栈",
    halOnlyReason: "要同时写 MAC/DMA 描述符环、PHY 管理与协议栈；" + HAL_ONLY_CORE,
  },
  {
    id: "sd",
    label: "SD 卡 / FatFs 文件系统",
    family: "sd",
    rank: 1,
    keywords: ["sd 卡", "sd卡", "sdmmc", "sdio", "fatfs", "文件系统"],
    hal: { effort: 3, risk: 3, setup: "CubeMX 开 SDIO/SDMMC + FATFS 中间件；用 f_mount/f_open 接口" },
    reg: null,
    regGap: "SD 协议命令序列 + 文件系统",
    halOnlyReason: "SD 命令序列（CMD0/CMD8/ACMD41…）+ 卡状态机 + 文件系统；" + HAL_ONLY_CORE,
  },
  {
    id: "fsmc",
    label: "FSMC/FMC 外部存储 / 并口屏",
    family: "fsmc",
    rank: 1,
    keywords: ["fsmc", "fmc", "外部 ram", "sram", "lcd 并口", "并口屏"],
    hal: { effort: 3, risk: 3, setup: "CubeMX 配 FSMC 时序（地址/数据建立保持）；用指针直接读写映射地址" },
    reg: null,
    regGap: "时序寄存器组合与芯片手册的 tAS/tDS/tWR 换算",
    halOnlyReason: "时序参数组合多且与具体器件手册绑定，写错表现为「偶尔读到错数据」；" + HAL_ONLY_CORE,
  },
  {
    id: "dma",
    label: "DMA 搬运",
    family: "dma",
    rank: 1,
    keywords: ["dma", "搬运", "内存到内存"],
    hal: { effort: 2, risk: 3, setup: "CubeMX 配 DMA 请求（外设固定通道）；HAL_DMA_Start_IT + 回调" },
    reg: { effort: 4, risk: 4, setup: "DMA_CPAR/CMAR/CNDTR/CCR 逐寄存器配；通道与外设的固定映射查参考手册表；中断标志按通道清" },
    regGap: "通道-外设映射是芯片固定表、多通道优先级与中断标志（IFCR）按位清，配错就是「数据只搬一半」",
  },
  {
    id: "rtc",
    label: "RTC 实时时钟 / 日历",
    family: "rtc",
    rank: 1,
    keywords: ["rtc", "实时时钟", "日历", "闹钟", "时间戳"],
    hal: { effort: 2, risk: 2, setup: "CubeMX 开 RTC（LSE 或 LSI）+ 备份域；HAL_RTC_SetTime/GetTime" },
    reg: { effort: 3, risk: 3, setup: "PWR->CR 开备份域访问；RCC->BDCR 选时钟源；RTC->PRLH/PRLL 分频；CNT/ALR 与进入初始化序列" },
    regGap: "备份域解锁顺序（PWR_CR 的 DBP）、进入/退出初始化模式、BCD 与二进制换算，错一步就写不进",
  },
  {
    id: "watchdog",
    label: "看门狗（IWDG / WWDG）",
    family: "wdg",
    rank: 1,
    keywords: ["看门狗", "iwdg", "wwdg", "watchdog", "喂狗"],
    hal: { effort: 1, risk: 1, setup: "CubeMX 开 IWDG（LSI 分频 + 重装值）；主循环里 HAL_IWDG_Refresh" },
    reg: { effort: 1, risk: 1, setup: "IWDG->KR 写 0xCCCC 启动；PR/RLR 前先写 0x5555 解锁；喂狗写 0xAAAA" },
    regGap: "没有（就四条写 KR 的魔数，但魔数写错会静默不生效）",
  },
  {
    id: "flash-param",
    label: "参数掉电保存（内部 Flash / EEPROM 模拟）",
    family: "flash",
    rank: 1,
    keywords: ["内部 flash", "参数保存", "掉电保存", "eeprom 模拟", "flash 读写", "配置保存"],
    hal: { effort: 2, risk: 3, setup: "HAL_FLASH_Unlock/Erase/Program；按页规划布局，写完回读校验" },
    reg: { effort: 3, risk: 3, setup: "FLASH->KEYR 写两个 key 解锁；CR 置 PER 擦页；SR 等 BSY；半字编程 + 回读" },
    regGap: "页地址/大小按型号变（F1 是 1 KB 页）、擦除期间的取指停顿、掉电中断会写坏整页 —— 需要双备份策略",
  },
  {
    id: "lowpower",
    label: "低功耗（Sleep/Stop/Standby + 唤醒）",
    family: "lowpower",
    rank: 1,
    keywords: ["低功耗", "待机", "休眠", "stop 模式", "standby", "睡眠模式", "电池供电"],
    hal: { effort: 3, risk: 3, setup: "HAL_PWR_EnterSTOPMode / EnterSTANDBYMode；唤醒后要重配时钟（Stop 会关 PLL）" },
    reg: null,
    regGap: "时钟恢复、唤醒源屏蔽、备份域与 IO 状态",
    halOnlyReason: "进入低功耗后时钟树/外设状态要成体系地恢复，写错表现为「睡下去就再也醒不来」或「电流没降」；" + HAL_ONLY_CORE,
  },
  {
    id: "rtos",
    label: "RTOS（FreeRTOS 任务）",
    family: "rtos",
    rank: 1,
    keywords: ["freertos", "rtos", "任务", "多线程", "信号量", "队列"],
    hal: { effort: 3, risk: 3, setup: "CubeMX 开 FREERTOS 中间件（CMSIS_V2）；中断里只用 FromISR 接口" },
    reg: null,
    regGap: "内核移植 + 上下文切换 + 中断优先级约束",
    halOnlyReason: "RTOS 不是外设而是内核（SysTick/PendSV 接管、优先级分组约束），没有「寄存器版」可言；" + HAL_ONLY_CORE,
  },
  {
    id: "clock",
    label: "时钟树（PLL / 外部晶振 / 变频）",
    family: "clock",
    rank: 1,
    keywords: ["时钟树", "pll", "超频", "外部晶振", "hse", "lse", "主频"],
    hal: { effort: 2, risk: 2, setup: "CubeMX 时钟树页面直接配；SystemClock_Config 由生成器写，别手改" },
    reg: { effort: 3, risk: 4, setup: "RCC->CR 开 HSE 等 HSERDY；CFGR 配 PLLMUL/PLLSRC + 总线分频；FLASH->ACR 配等待周期；切 SW 后确认 SWS" },
    regGap: "Flash 等待周期必须跟着主频走（跟不上会随机跑飞）、切换顺序错了会短暂无时钟",
  },
  {
    id: "qei",
    label: "编码器接口（正交解码）",
    family: "qei",
    rank: 1,
    keywords: ["编码器", "qei", "正交解码", "霍尔"],
    hal: { effort: 2, risk: 2, setup: "CubeMX 把 TIM 配成 Encoder Mode；读 CNT 即计数" },
    reg: { effort: 3, risk: 3, setup: "SMCR 配 SMS=001/010/011；CCMR 配输入滤波；CNT 直接读" },
    regGap: "输入滤波（ICF）与极性配置影响高速时丢脉冲",
  },
  {
    id: "boot",
    label: "Bootloader / IAP 在线升级",
    family: "boot",
    rank: 1,
    keywords: ["bootloader", "iap", "在线升级", "固件升级", "ota"],
    hal: { effort: 3, risk: 4, setup: "两份工程：boot 跳转到 app（改 SCB->VTOR）+ 校验；app 里写升级标志" },
    reg: { effort: 3, risk: 4, setup: "跳转 = 取 app 向量表首字当 SP、第二字当入口，__set_MSP + 函数指针跳转；Flash 写入同 flash-param" },
    regGap: "跳转本身寄存器版更直接，但 Flash 写入与向量表重定位的坑一样多；建议先 HAL 跑通再考虑换",
  },
];

function ruleById(id: string): PeripheralRule | undefined {
  return PERIPHERAL_RULES.find((rule) => rule.id === id);
}

/** 一段文本 → 命中的规则（同族只留 rank 最高的那条在最后算）。source 记录命中来源。 */
function matchText(text: string, into: Map<string, Set<MatchSource>>, source: MatchSource): void {
  const hay = text.toLowerCase();
  if (hay.trim() === "") return;
  for (const rule of PERIPHERAL_RULES) {
    if (!rule.keywords.some((keyword) => hay.includes(keyword))) continue;
    const sources = into.get(rule.id) ?? new Set<MatchSource>();
    sources.add(source);
    into.set(rule.id, sources);
  }
}

/** 显式列出的外设（id / 标签 / 关键词都能对上）。对不上的进 unknown。 */
function matchExplicit(tokens: readonly string[], into: Map<string, Set<MatchSource>>, unknown: string[]): void {
  for (const raw of tokens) {
    const token = raw.trim().toLowerCase();
    if (token === "") continue;
    const rule = PERIPHERAL_RULES.find(
      (item) =>
        item.id === token
        || item.label.toLowerCase().includes(token)
        || item.keywords.some((keyword) => keyword === token || token.includes(keyword)),
    );
    if (rule === undefined) {
      unknown.push(raw.trim());
      continue;
    }
    const sources = into.get(rule.id) ?? new Set<MatchSource>();
    sources.add("explicit");
    into.set(rule.id, sources);
  }
}

export interface RouteDevice {
  id: string;
  label: string;
  matchedBy: MatchSource[];
  hal: RouteCost;
  reg: RouteCost | null;
  advice: RouteAdvice;
  reason: string;
}

export interface RouteInput {
  /** 一句话需求，例如"按键控制 LED，串口打印状态"。 */
  requirement: string;
  /** 用户显式点名的外设（可选）。 */
  peripherals?: readonly string[];
  /** .ioc 里已使能的外设名（例如 USART1、TIM2），当作补充证据。 */
  iocPeripherals?: readonly string[];
}

export interface RouteAssessment {
  verdict: RouteVerdict;
  verdictLabel: string;
  devices: RouteDevice[];
  unknown: string[];
  delta: string[];
  halSteps: string[];
  regSteps: string[];
  recommendations: string[];
  notes: string[];
}

export const VERDICT_LABEL: Record<RouteVerdict, string> = {
  "hal-only": "只能走 HAL（.ioc + CubeMX 生成）",
  "both-viable": "两条都能走，HAL 更稳",
  "register-ok": "寄存器版够用（小而定型的外设）",
  unclear: "还没看出要做什么外设",
};

/** 判定单个外设走哪条路：寄存器只有在 effort<=2 且 risk<=2 时才被推荐。 */
function adviceFor(rule: PeripheralRule): RouteAdvice {
  if (rule.reg === null) return "hal-required";
  if (rule.reg.effort <= 2 && rule.reg.risk <= 2) return "register";
  return "hal";
}

function reasonFor(rule: PeripheralRule, advice: RouteAdvice): string {
  if (advice === "hal-required") return rule.halOnlyReason ?? (HAL_ONLY_CORE + "。");
  if (advice === "register") {
    return "寄存器版代价 " + String(rule.reg?.effort ?? 0) + "/5、风险 " + String(rule.reg?.risk ?? 0) + "/5（越低越省）："
      + (rule.regGap === "" ? "可以直接写。" : rule.regGap);
  }
  return "寄存器版风险 " + String(rule.reg?.risk ?? 0) + "/5 偏高，HAL 更省事：" + rule.regGap;
}

/** 逐个外设评估。纯函数。 */
export function assessRoute(input: RouteInput): RouteAssessment {
  const matched = new Map<string, Set<MatchSource>>();
  const unknown: string[] = [];
  matchText(input.requirement, matched, "requirement");
  matchExplicit(input.peripherals ?? [], matched, unknown);
  for (const name of input.iocPeripherals ?? []) matchText(name, matched, "ioc");

  const byFamily = new Map<string, PeripheralRule>();
  for (const id of matched.keys()) {
    const rule = ruleById(id);
    if (rule === undefined) continue;
    const current = byFamily.get(rule.family);
    if (current === undefined || rule.rank > current.rank) byFamily.set(rule.family, rule);
  }
  const chosen = [...byFamily.values()].sort((left, right) => left.id.localeCompare(right.id));

  const devices: RouteDevice[] = chosen.map((rule) => {
    const advice = adviceFor(rule);
    const sources = [...(matched.get(rule.id) ?? new Set<MatchSource>())].sort();
    return {
      id: rule.id,
      label: rule.label,
      matchedBy: sources,
      hal: rule.hal,
      reg: rule.reg,
      advice,
      reason: reasonFor(rule, advice),
    };
  });

  let verdict: RouteVerdict;
  if (devices.length === 0) verdict = "unclear";
  else if (devices.some((device) => device.advice === "hal-required")) verdict = "hal-only";
  else if (devices.every((device) => device.advice === "register")) verdict = "register-ok";
  else verdict = "both-viable";

  const halEffort = devices.reduce((sum, device) => sum + device.hal.effort, 0);
  const regEffort = devices.reduce((sum, device) => sum + (device.reg?.effort ?? 0), 0);
  const regRisk = devices.reduce((max, device) => Math.max(max, device.reg?.risk ?? 0), 0);

  const delta: string[] = [];
  if (verdict === "both-viable" || verdict === "register-ok") {
    delta.push(
      "开发效率：HAL 合计代价 " + String(halEffort) + "/" + String(devices.length * 5)
      + "，寄存器 " + String(regEffort) + "/" + String(devices.length * 5)
      + "（要手配的寄存器少，但每个都得按参考手册算对）。",
    );
    delta.push(
      "可读性：HAL 版是「初始化结构体 + 语义化函数」，别人接手能看懂；寄存器版是「位赋值 + 魔数」"
      + "（配合头部注释与宏能缓解，但没有 HAL 那样的现成文档）。",
    );
    delta.push(
      "工程形态：HAL 版必须有 .ioc + CubeMX（生成代码占几百 KB Flash）；寄存器版是一个 main.c + 启动文件，"
      + "不依赖 CubeMX，Flash 占用小一个量级。",
    );
    delta.push(
      "排错：HAL 出错会有 HAL 返回码与状态机（能定位到具体函数）；寄存器版出错只能读寄存器 + 看波形，"
      + "但反过来也没有 HAL 的版本兼容问题。",
    );
    if (regRisk >= 3) delta.push("⚠ 寄存器路线里风险最高的一项到 " + String(regRisk) + "/5：这一项建议单独用 HAL 或先用 stm32_regs_read 把寄存器读通再写逻辑。");
  }
  if (verdict === "hal-only") {
    delta.push("没法给「两版都写」的承诺：上面标 hal-required 的外设在寄存器版里等于重写协议栈/内核，风险不可控。");
  }

  const halSteps = [
    "先 stm32_ioc_plan 把外设配进 .ioc（CubeMX 会拒绝不认识的外设组合，等于替你校验一遍配置）。",
    "stm32_generate 用 CubeMX 无头生成 MX_*_Init / HAL_MspInit / 时钟树（生成区不要手改）。",
    "业务只写 USER CODE 段：改参数改 HAL_xxx_Init 的结构体，主循环放业务；中断里只置标志。",
    "用 stm32_build → stm32_flash → stm32_debug_run 验证（能停在断点看变量，是 HAL 路线最大的便利）。",
  ];
  const regSteps = [
    "不建 .ioc：寄存器版只有 main.c + CMakeLists.txt + 链接脚本；启动文件/设备头从缓存目录取（首次从网上下载，之后复用）。",
    "时钟与引脚在 main 里逐位配：RCC->APB2ENR 开时钟、GPIOx->CRL/CRH 配模式、AFIO->MAPR 配重映射。",
    "每个外设写完立刻用 stm32_regs_read 读回寄存器自证（例如 ODR 位在翻、BRR 与波特率对得上、CNT 在涨）。",
    "烧录后先看串口有没有输出：寄存器版没有 HAL 的返回值，串口打印是最便宜的观测手段。",
  ];

  const recommendations: string[] = [];
  if (verdict === "unclear") {
    recommendations.push("需求里没认出外设。把要做的事说具体些（例如「按键控制 LED，串口每秒打印一次状态」），或直接列 peripherals。");
  }
  if (verdict === "hal-only") {
    recommendations.push("走 HAL：需要 STM32CubeMX + 本芯片的固件包（工具链检查里会分开提示怎么装）。");
  }
  if (verdict === "register-ok") {
    recommendations.push("寄存器版够用：不需要 CubeMX，也不需要固件包，只要 gcc/cmake/ninja 与烧录工具。");
  }
  if (verdict === "both-viable") {
    const registerFriendly = devices.filter((device) => device.advice === "register").map((device) => device.label);
    const halNeeded = devices.filter((device) => device.advice === "hal").map((device) => device.label);
    recommendations.push("整体建议走 HAL；寄存器版只在这几项上划算 —— " + (registerFriendly.length === 0 ? "（没有）" : registerFriendly.join("、")) + "。");
    recommendations.push("这几项用 HAL 才有把握：" + (halNeeded.length === 0 ? "（没有）" : halNeeded.join("、")) + "。");
  }
  if (unknown.length > 0) {
    recommendations.push("这几个词我没认出对应的外设：" + unknown.join("、") + "；如果它们是别的东西，请换一种说法或直接给 peripherals。");
  }

  const notes: string[] = [];
  notes.push("代价/风险都是 1（最省）到 5（最费），按这台芯片的参考手册估的，不是通用评分。");
  if (input.iocPeripherals !== undefined && input.iocPeripherals.length > 0) {
    notes.push("已把 .ioc 里使能的 " + String(input.iocPeripherals.length) + " 个外设算作证据：" + input.iocPeripherals.join("、"));
  }

  return {
    verdict,
    verdictLabel: VERDICT_LABEL[verdict],
    devices,
    unknown,
    delta,
    halSteps,
    regSteps,
    recommendations,
    notes,
  };
}

// ── 固件包（要读盘）────────────────────────────────────────────────────────

/** 型号 → 芯片族：STM32F103C8T6 → F1，STM32G431 → G4，STM32H743 → H7；认不出返回空串。 */
export function familyOf(mcu: string): string {
  const match = /^STM32([A-Za-z])(\d)/u.exec(mcu.trim().toUpperCase());
  if (match === null) return "";
  return String(match[1]).toUpperCase() + String(match[2]);
}

export interface FirmwareCheck {
  found: boolean;
  family: string;
  packageName: string;
  path: string;
  repositoryDir: string;
  /** 目录在但缺 HAL/CMSIS/startup：半成品，等同于没装成。 */
  incomplete: boolean;
  message: string;
}

/** 目录里是不是一个能编译的固件包（与 scaffold.resolveFirmwareRoot 的三条判据一致）。 */
function isCompletePackage(dir: string, family: string): boolean {
  if (family === "") return false;
  const prefix = "STM32" + family + "xx";
  return (
    existsSync(join(dir, "Drivers", prefix + "_HAL_Driver"))
    && existsSync(join(dir, "Drivers", "CMSIS", "Include"))
    && existsSync(join(dir, "Drivers", "CMSIS", "Device", "ST", prefix))
  );
}

/**
 * 在 CubeMX 的 Repository 里找这台芯片的固件包。
 *
 * 判据与 scaffold 保持一致（HAL 驱动 + CMSIS 头 + 设备目录），并且允许同族多个版本：
 * 取目录名（含版本）字典序最大的那个 —— ST 的版本号补零不一致，但同族里逐位比较足够用。
 */
export function findFirmwarePackage(cubeMxRoots: readonly string[], mcuOrFamily: string): FirmwareCheck {
  const direct = /^([A-Za-z]\d)$/u.exec(mcuOrFamily.trim().toUpperCase());
  const family = direct !== null ? String(direct[1]).toUpperCase() : familyOf(mcuOrFamily);
  const empty: FirmwareCheck = {
    found: false,
    family,
    packageName: "",
    path: "",
    repositoryDir: "",
    incomplete: false,
    message:
      family === ""
        ? "不知道芯片族（没给 MCU 型号），没法判断固件包。"
        : "没找到 STM32Cube_FW_" + family + "_V* 固件包。",
  };
  if (family === "") return empty;

  const prefix = "STM32Cube_FW_" + family + "_";
  let bestComplete: { name: string; dir: string; root: string } | null = null;
  let partial: { name: string; dir: string; root: string } | null = null;

  for (const root of cubeMxRoots) {
    const repositoryDir = join(root, "Repository");
    let entries: string[];
    try {
      entries = readdirSync(repositoryDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const name of entries) {
      const dir = join(repositoryDir, name);
      if (isCompletePackage(dir, family)) {
        if (bestComplete === null || name.localeCompare(bestComplete.name) > 0) bestComplete = { name, dir, root };
      } else if (partial === null || name.localeCompare(partial.name) > 0) {
        partial = { name, dir, root };
      }
    }
  }

  if (bestComplete !== null) {
    return {
      found: true,
      family,
      packageName: bestComplete.name,
      path: bestComplete.dir,
      repositoryDir: join(bestComplete.root, "Repository"),
      incomplete: false,
      message: "固件包 " + bestComplete.name + " 在 " + bestComplete.dir + "（HAL + CMSIS + 设备头齐全）。",
    };
  }
  if (partial !== null) {
    return {
      found: false,
      family,
      packageName: partial.name,
      path: partial.dir,
      repositoryDir: join(partial.root, "Repository"),
      incomplete: true,
      message:
        "找到 " + partial.name + " 但它是半成品（缺 Drivers/STM32" + family + "xx_HAL_Driver 或 CMSIS 设备头），"
        + "编译会挂 —— 多半是只解压了 GitHub 源码包（子模块是空目录）。用 CubeMX 包管理器重装这一个包。",
    };
  }
  return {
    found: false,
    family,
    packageName: "",
    path: "",
    repositoryDir: cubeMxRoots.length === 0 ? "" : join(cubeMxRoots[0] ?? "", "Repository"),
    incomplete: false,
    message:
      "没找到 STM32Cube_FW_" + family + "_V* 固件包（找过 " + cubeMxRoots.join("、") + "）。"
      + (family in FIRMWARE_FAMILIES
        ? "这一代插件能自动下（stm32_firmware_install，约 2 MB）。"
        : "这一代插件还不会自动下，用 CubeMX 包管理器装（见 guides）。"),
  };
}
