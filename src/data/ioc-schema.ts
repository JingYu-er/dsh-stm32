/**
 * CubeMX .ioc 键真值表（schema）。
 *
 * 目的：生成器不再逐处拼键名字符串，而是「按 schema 渲染 + 按 schema 校验」。本表是**证据登记表**，不是文档：
 * 每一条都要能指出证据来源（jar.md 行号 / 语料统计 / 真机回写实验）。
 *
 * 证据三源（详见 docs §61）：
 *   1. .dsh-stm32/cubemx-re/jar.md —— javap 反汇编 + 43,264 个 class 的字面量扫描得出的写键点与顺序结论；
 *   2. 504 份 boardmanager 板级 .ioc 语料统计（键出现频率、值 token 分布、顺序反例计数）；
 *   3. 真机实验：CubeMX 6.15.0 无头 config load + config save 回写比对（demo.ioc 副本）。
 *
 * 版本绑定：CubeMX 6.15.0 / db DB.6.0.150 / STM32Cube_FW_F1_V1.8.7。换版本必须重新取证。
 *
 * 约定：
 *   - key 用占位符模板，{pin} {index} {ip} {name} {n} {signal} 会被编译成正则分组，{*} 是 catch-all（不取参）；
 *   - writer 为 null 表示「由 CubeMX 写入，本插件有意不写」，并在 trigger 中说明原因；
 *   - rules 关联 docs 里的规则号（R6/R7/R22/R23…），规则与 schema 互为索引。
 */

export type IocEntityKind = "mcu" | "pin" | "shared-signal" | "nvic" | "dma" | "peripheral" | "rcc" | "project";

export type IocValueKind = "count" | "index" | "bool" | "enum" | "csv" | "nvic9" | "hz" | "text";

export type IocKeyOrder =
  | "dictionary"      // 字典序（键名排序），CubeMX 按 Map 遍历时就是这个顺序
  | "insertion"       // 该键的值是「成员插入序」，如 <IP>.IPParameters
  | "sorted-members"  // 值排过序，如 RCC.IPParameters
  | "index"           // 值是索引/序列（Mcu.Pin<i>、Dma.Request<i>）
  | "sequence";       // 值是业务序列（functionlistsort）

export interface IocKeySpec {
  /** 稳定 id（mcu.pin_index / nvic.vector / dma.request_index …），代码与单测均使用该 id。 */
  readonly id: string;
  /** 这条键属于哪类实体。 */
  readonly entity: IocEntityKind;
  /** 键名模板（含占位符）。 */
  readonly key: string;
  /** 值的编码类型。 */
  readonly valueKind: IocValueKind;
  /** 值的具体形态与取值范围。 */
  readonly valueNote: string;
  /** 写入触发条件（什么情况下写、什么情况下不写、不写的后果）。 */
  readonly trigger: string;
  /** 该键/该值的排序语义。 */
  readonly order: IocKeyOrder;
  /** 证据（文件:行号 / 语料计数 / 真机实验日期）。 */
  readonly evidence: readonly string[];
  /** 写这条键的实现位置；null = 由 CubeMX 写入、本插件不写。 */
  readonly writer: string | null;
  /** 关联的 docs 规则号。 */
  readonly rules?: readonly string[];
}

export interface IocKeyTemplate {
  readonly regex: RegExp;
  readonly names: readonly string[];
}

export interface IocKeyMatch {
  readonly spec: IocKeySpec;
  readonly params: Readonly<Record<string, string>>;
}

/** 真值表本体（49 条，按匹配优先级排列：先匹配者生效——具体模板在前，`{ip}.{name}` 这类回退模板在后）。 */
export const SPECS: readonly IocKeySpec[] = [
  {
    "id": "mcu.cpn",
    "entity": "mcu",
    "key": "Mcu.CPN",
    "valueKind": "text",
    "valueNote": "芯片订货号（STM32F103C8Tx）。",
    "trigger": "恒写（新建工程时由 CubeMX 写入，本插件仅替换模板中已有的值）。",
    "order": "dictionary",
    "evidence": [
      "jar.md:66-70",
      "语料 504/504"
    ],
    "writer": "src/engine/hal-chip.ts:242-266"
  },
  {
    "id": "mcu.name",
    "entity": "mcu",
    "key": "Mcu.Name",
    "valueKind": "text",
    "valueNote": "db 里的 Mcu.Name（STM32F103C8Tx）。",
    "trigger": "恒写；引脚/信号校验均以此为准。",
    "order": "dictionary",
    "evidence": [
      "jar.md:66-70",
      "语料 504/504"
    ],
    "writer": "src/engine/hal-chip.ts:242-266"
  },
  {
    "id": "mcu.user_name",
    "entity": "mcu",
    "key": "Mcu.UserName",
    "valueKind": "text",
    "valueNote": "工程名（生成 main.c 的头注释、启动工程 Target 名）。",
    "trigger": "恒写。",
    "order": "dictionary",
    "evidence": [
      "jar.md:66-70",
      "语料 504/504"
    ],
    "writer": "src/engine/hal-chip.ts:242-266"
  },
  {
    "id": "mcu.family",
    "entity": "mcu",
    "key": "Mcu.Family",
    "valueKind": "text",
    "valueNote": "族名（STM32F1）。",
    "trigger": "恒写。",
    "order": "dictionary",
    "evidence": [
      "jar.md:66-70",
      "语料 504/504"
    ],
    "writer": "src/engine/hal-chip.ts:242-266"
  },
  {
    "id": "mcu.package",
    "entity": "mcu",
    "key": "Mcu.Package",
    "valueKind": "text",
    "valueNote": "封装名（LQFP48）。",
    "trigger": "恒写。",
    "order": "dictionary",
    "evidence": [
      "jar.md:66-70",
      "语料 504/504"
    ],
    "writer": "src/engine/hal-chip.ts:242-266"
  },
  {
    "id": "mcu.pin_index",
    "entity": "mcu",
    "key": "Mcu.Pin{index}",
    "valueKind": "index",
    "valueNote": "引脚 db 名（PA0-WKUP、PC13-TAMPER-RTC、VP_SYS_VS_Systick）。索引 0..PinsNb-1 连续。",
    "trigger": "引脚表变化时才整体重写（没变不碰字节）。顺序 = db <Pin Position> 升序，虚拟脚 VP_* 恒最后。",
    "order": "index",
    "evidence": [
      "jar.md:75-76",
      "语料 30,830 行/504 文件",
      "真机 2026-11-02 四轮：回写顺序与 db Position 全一致"
    ],
    "writer": "src/engine/ioc-plan.ts:535"
  },
  {
    "id": "mcu.pins_nb",
    "entity": "mcu",
    "key": "Mcu.PinsNb",
    "valueKind": "count",
    "valueNote": "引脚表条数 = 上面的索引上限。",
    "trigger": "与 Mcu.Pin<i> 同进同退。",
    "order": "dictionary",
    "evidence": [
      "jar.md:75-76",
      "语料 504/504"
    ],
    "writer": "src/engine/ioc-plan.ts:537"
  },
  {
    "id": "mcu.ip_index",
    "entity": "mcu",
    "key": "Mcu.IP{index}",
    "valueKind": "index",
    "valueNote": "外设实例名（USART1、NVIC、RCC…）。索引 0..IPNb-1 连续。",
    "trigger": "启用/删除外设时按实有槽位重算；新外设追加到末尾（取值顺序 = CubeMX 内部遍历序，见 jar.md U1）。",
    "order": "index",
    "evidence": [
      "jar.md:73-74",
      "语料 4,686 行/504 文件，索引连续 502/504"
    ],
    "writer": "src/engine/ioc-plan.ts:873"
  },
  {
    "id": "mcu.ip_nb",
    "entity": "mcu",
    "key": "Mcu.IPNb",
    "valueKind": "count",
    "valueNote": "Mcu.IP<i> 条数。",
    "trigger": "与 Mcu.IP<i> 同进同退；漏写会让 CubeMX 只认前 N 个外设。",
    "order": "dictionary",
    "evidence": [
      "jar.md:73-74",
      "语料 504/504"
    ],
    "writer": "src/engine/ioc-plan.ts:876"
  },
  {
    "id": "pin.signal",
    "entity": "pin",
    "key": "{pin}.Signal",
    "valueKind": "enum",
    "valueNote": "信号名：GPIO_Input / GPIO_Output / <IP>_<信号> / 共享信号的规范化名（S_TIM2_CH1_ETR、ADCx_IN1）/ EXTI 用 GPXTI<线号>。",
    "trigger": "凡配了这根脚就写；无信号的脚只写 .Locked 就 return（jar.md:21）。",
    "order": "dictionary",
    "evidence": [
      "jar.md:165-168",
      "语料 29,521 脚实例 100%"
    ],
    "writer": "src/engine/ioc-plan.ts:611"
  },
  {
    "id": "pin.mode",
    "entity": "pin",
    "key": "{pin}.Mode",
    "valueKind": "enum",
    "valueNote": "复用模式名（Asynchronous、Serial_Wire、PWM Generation1 CH1…）。",
    "trigger": "仅多模式外设且该脚有模式时写；共享信号脚（TIM/ADC）与 EXTI 脚不写（功能由 SH 块 / GPIO_ModeDefaultEXTI 表达），GPIO 单模式脚不写。",
    "order": "dictionary",
    "evidence": [
      "jar.md:165-168",
      "语料 9,885 脚 = 33.5%",
      "真机 2026-11-02：EXTI 脚回写无 .Mode"
    ],
    "writer": "src/engine/ioc-plan.ts:903"
  },
  {
    "id": "pin.locked",
    "entity": "pin",
    "key": "{pin}.Locked",
    "valueKind": "bool",
    "valueNote": "字符串 true。",
    "trigger": "凡配了这根脚就恒写 true；语料里 Locked=false 出现 0 次。",
    "order": "dictionary",
    "evidence": [
      "jar.md:164",
      "语料 27,304 脚 = 92.4%（24,990 true / 0 false）"
    ],
    "writer": "src/engine/ioc-plan.ts:610"
  },
  {
    "id": "pin.gpio_parameters",
    "entity": "pin",
    "key": "{pin}.GPIOParameters",
    "valueKind": "csv",
    "valueNote": "该脚实际写了的 GPIO 属性名列表，顺序 Speed→PinState→PuPd→Label→ModeDefault*→Mode。",
    "trigger": "只在有属性时写；一个属性都没有就删键。写在脚上的 GPIO_* 属性必须列进这里，否则 CubeMX 静默删掉（R22）。",
    "order": "dictionary",
    "evidence": [
      "jar.md:170-171",
      "语料 24,571 脚 = 83.2%",
      "真机 2026-11-02：回写时顺序被 CubeMX 重排成上面那条",
      "266 份 6.x 语料 11,808 条两两先后统计（0 反例）"
    ],
    "writer": "src/engine/ioc-plan.ts:604",
    "rules": [
      "R22"
    ]
  },
  {
    "id": "pin.gpio_label",
    "entity": "pin",
    "key": "{pin}.GPIO_Label",
    "valueKind": "text",
    "valueNote": "用户标签（生成 C 宏 LED_Pin）。",
    "trigger": "给了标签才写；重名会被拦。",
    "order": "dictionary",
    "evidence": [
      "jar.md:170",
      "语料 14,357 次（最常见属性）"
    ],
    "writer": "src/engine/ioc-plan.ts:607"
  },
  {
    "id": "pin.gpio_pupd",
    "entity": "pin",
    "key": "{pin}.GPIO_PuPd",
    "valueKind": "enum",
    "valueNote": "GPIO_NOPULL / GPIO_PULLUP / GPIO_PULLDOWN。",
    "trigger": "非默认（none）才写。",
    "order": "dictionary",
    "evidence": [
      "jar.md:170",
      "语料 4,795 例 = 16.2%"
    ],
    "writer": "src/engine/ioc-plan.ts:607"
  },
  {
    "id": "pin.gpio_speed",
    "entity": "pin",
    "key": "{pin}.GPIO_Speed",
    "valueKind": "enum",
    "valueNote": "GPIO_SPEED_FREQ_LOW/MEDIUM/HIGH。",
    "trigger": "非默认（low）才写。",
    "order": "dictionary",
    "evidence": [
      "jar.md:170",
      "语料 4,114 例 = 13.9%"
    ],
    "writer": "src/engine/ioc-plan.ts:607"
  },
  {
    "id": "pin.pin_state",
    "entity": "pin",
    "key": "{pin}.PinState",
    "valueKind": "enum",
    "valueNote": "GPIO_PIN_SET / GPIO_PIN_RESET。",
    "trigger": "只在显式 initial=high 时写（默认低不写）；CubeMX 不规范化这两个 token。",
    "order": "dictionary",
    "evidence": [
      "语料 GPIO_PIN_SET 161 / GPIO_PIN_RESET 36",
      "真机 2026-11-02：两个 token 都逐字保留"
    ],
    "writer": "src/engine/ioc-plan.ts:607"
  },
  {
    "id": "pin.gpio_mode",
    "entity": "pin",
    "key": "{pin}.GPIO_Mode",
    "valueKind": "enum",
    "valueNote": "GPIO_MODE_INPUT / OUTPUT_PP / OUTPUT_OD / AF_PP / AF_OD / ANALOG / ANALOG_ADC_CONTROL。",
    "trigger": "非默认才写：输出默认推挽、输入默认不写（CubeMX 也不给输入脚补 INPUT）、AF 默认不写；开漏输出写 OUTPUT_OD。",
    "order": "dictionary",
    "evidence": [
      "语料 6 个 token；2,657 输出脚里 OUTPUT_PP 116、OUTPUT_OD 0 命中",
      "真机 2026-11-02：GPIO_MODE_OUTPUT_OD 逐字保留"
    ],
    "writer": "src/engine/ioc-plan.ts:607",
    "rules": [
      "R22"
    ]
  },
  {
    "id": "pin.gpio_mode_default_exti",
    "entity": "pin",
    "key": "{pin}.GPIO_ModeDefaultEXTI",
    "valueKind": "enum",
    "valueNote": "GPIO_MODE_IT_RISING / GPIO_MODE_IT_FALLING / GPIO_MODE_IT_RISING_FALLING（语料只有这三个 token）。",
    "trigger": "配了 EXTI 才写，并同时进 GPIOParameters；缺少该键时 CubeMX 不识别该引脚的 EXTI（R23）。",
    "order": "dictionary",
    "evidence": [
      "语料 GPIO_ModeDefaultEXTI 318 次",
      "真机 2026-11-02：EXTI 四件套逐字保留"
    ],
    "writer": "src/engine/ioc-plan.ts:596",
    "rules": [
      "R22",
      "R23"
    ]
  },
  {
    "id": "pin.gpio_mode_default_pp",
    "entity": "pin",
    "key": "{pin}.GPIO_ModeDefaultPP",
    "valueKind": "enum",
    "valueNote": "多模式引脚的上电默认模式。",
    "trigger": "本插件不写（CubeMX 需要时自行写入）；语料 90 次。",
    "order": "dictionary",
    "evidence": [
      "语料 90 次"
    ],
    "writer": null
  },
  {
    "id": "pin.gpio_mode_default_output_pp",
    "entity": "pin",
    "key": "{pin}.GPIO_ModeDefaultOutputPP",
    "valueKind": "enum",
    "valueNote": "输出脚的默认模式。",
    "trigger": "本插件不写；语料 418 次。",
    "order": "dictionary",
    "evidence": [
      "语料 418 次"
    ],
    "writer": null
  },
  {
    "id": "pin.pin_attribute",
    "entity": "pin",
    "key": "{pin}.PinAttribute",
    "valueKind": "text",
    "valueNote": "引脚属性标记字符串。",
    "trigger": "本插件不写；语料 4,763 次。",
    "order": "dictionary",
    "evidence": [
      "语料 4,763 次"
    ],
    "writer": null
  },
  {
    "id": "shared_signal.slot",
    "entity": "shared-signal",
    "key": "SH.{signal}.{n}",
    "valueKind": "csv",
    "valueNote": "<IP 信号>,<IP 模式> 两段（如 TIM2_CH1,PWM Generation1 CH1）。",
    "trigger": "每有一个「这根脚做这个外设的这个功能」占一个槽位；同值不重复写。缺整个 SH 块时 CubeMX 静默丢弃 TIM/ADC（R6）。",
    "order": "index",
    "evidence": [
      "jar.md:181-182",
      "语料 16,921 键/419 文件/695 子键",
      "2026-10-31 实测：缺 SH 块时 TIM3/ADC1 全被丢"
    ],
    "writer": "src/engine/ioc-plan.ts:750",
    "rules": [
      "R6"
    ]
  },
  {
    "id": "shared_signal.conf_nb",
    "entity": "shared-signal",
    "key": "SH.{signal}.ConfNb",
    "valueKind": "count",
    "valueNote": "该共享信号的槽位条数。",
    "trigger": "与槽位同进同退；和实际槽位数不符时 R6 告警。",
    "order": "dictionary",
    "evidence": [
      "jar.md:181-182",
      "语料 16,921 键/419 文件"
    ],
    "writer": "src/engine/ioc-plan.ts:751",
    "rules": [
      "R6"
    ]
  },
  {
    "id": "nvic.vector",
    "entity": "nvic",
    "key": "NVIC.{name}_IRQn",
    "valueKind": "nvic9",
    "valueNote": "9 段冒号值：Enabled:Preempt:Sub:Configurable:System:IrqHandlerGenerated:…（DMA 通道那串第 7 段是 false）。",
    "trigger": "interrupts 参数 / pins 的 interrupt（按线号选组）/ DMA 通道自动补；已有值且未显式给优先级时保留原值。段数不对 R3 告警，名字不在 SVD 里 R20 告警。",
    "order": "dictionary",
    "evidence": [
      "jar.md:137-149",
      "真机 2026-11-02：NVIC.USART1_IRQn / NVIC.EXTI9_5_IRQn 逐字保留、0 added"
    ],
    "writer": "src/engine/ioc-plan.ts:617",
    "rules": [
      "R3",
      "R20"
    ]
  },
  {
    "id": "nvic.priority_group",
    "entity": "nvic",
    "key": "NVIC.PriorityGroup",
    "valueKind": "enum",
    "valueNote": "NVIC_PRIORITYGROUP_0..4。",
    "trigger": "CubeMX 恒写；本插件不写（模板已含）。",
    "order": "dictionary",
    "evidence": [
      "jar.md:128"
    ],
    "writer": null
  },
  {
    "id": "nvic.force_enable_dma_vector",
    "entity": "nvic",
    "key": "NVIC.ForceEnableDMAVector",
    "valueKind": "bool",
    "valueNote": "true / false。",
    "trigger": "CubeMX 恒写；本插件不写。",
    "order": "dictionary",
    "evidence": [
      "jar.md:133"
    ],
    "writer": null
  },
  {
    "id": "nvic.time_base",
    "entity": "nvic",
    "key": "NVIC.TimeBase",
    "valueKind": "text",
    "valueNote": "时基用的向量名或 None。",
    "trigger": "CubeMX 恒写；本插件不写。",
    "order": "dictionary",
    "evidence": [
      "jar.md:129"
    ],
    "writer": null
  },
  {
    "id": "dma.request_parameters",
    "entity": "dma",
    "key": "Dma.{ip}.{n}.RequestParameters",
    "valueKind": "csv",
    "valueNote": "该请求实际写了的参数名，顺序按 DMA_PARAM_ORDER 白名单（Instance,Direction,PeriphInc,MemInc,PeriphDataAlignment,MemDataAlignment,Mode,Priority[,FIFOMode]）。",
    "trigger": "有该请求的参数键才写；不在白名单里的字段会被静默忽略（R21）。",
    "order": "insertion",
    "evidence": [
      "jar.md:157",
      "语料 17 份含 DMA 的文件三件套齐全",
      "richhal.ioc:30-32"
    ],
    "writer": "src/engine/ioc-plan.ts:948",
    "rules": [
      "R21"
    ]
  },
  {
    "id": "dma.request_group",
    "entity": "dma",
    "key": "Dma.{ip}.{n}.{name}",
    "valueKind": "enum",
    "valueNote": "实例名/方向/对齐/模式等原样值（DMA1_Channel1、DMA_PERIPH_TO_MEMORY…）。",
    "trigger": "随预设 rawEntries 写；必须同时进 RequestParameters。",
    "order": "dictionary",
    "evidence": [
      "jar.md:158"
    ],
    "writer": "src/engine/ioc-plan.ts:913",
    "rules": [
      "R21"
    ]
  },
  {
    "id": "dma.request_index",
    "entity": "dma",
    "key": "Dma.Request{n}",
    "valueKind": "index",
    "valueNote": "请求名 → 该请求所属 IP 名。",
    "trigger": "有 DMA 请求就按序号重写；孤立计数（只有 RequestsNb）CubeMX 不认。",
    "order": "index",
    "evidence": [
      "jar.md:156",
      "语料 64/64 的 Dma.Request<i> 值等于同号实例名"
    ],
    "writer": "src/engine/ioc-plan.ts:949",
    "rules": [
      "R21"
    ]
  },
  {
    "id": "dma.requests_nb",
    "entity": "dma",
    "key": "Dma.RequestsNb",
    "valueKind": "count",
    "valueNote": "DMA 请求条数（base 是小写 Dma，不是 DMA）。",
    "trigger": "与 Dma.Request<i> 同进同退。",
    "order": "dictionary",
    "evidence": [
      "jar.md:155"
    ],
    "writer": "src/engine/ioc-plan.ts:959",
    "rules": [
      "R21"
    ]
  },
  {
    "id": "periph.ip_parameters",
    "entity": "peripheral",
    "key": "{ip}.IPParameters",
    "valueKind": "csv",
    "valueNote": "该外设实际写了的参数名，顺序 = 插入序（LinkedHashMap），不是字典序。",
    "trigger": "参数计数 > 0 才写；不在名单里的参数键会被静默忽略（R7）。",
    "order": "insertion",
    "evidence": [
      "jar.md:105",
      "jar.md:108（语料有序 706 / 无序 681）"
    ],
    "writer": "src/engine/ioc-plan.ts:984",
    "rules": [
      "R7"
    ]
  },
  {
    "id": "periph.parameter",
    "entity": "peripheral",
    "key": "{ip}.{name}",
    "valueKind": "text",
    "valueNote": "参数值原样（db 里的枚举名/数值）。",
    "trigger": "预设参数或用户显式指定；写一个参数就要进 IPParameters。",
    "order": "dictionary",
    "evidence": [
      "jar.md:105"
    ],
    "writer": "src/engine/ioc-plan.ts:970",
    "rules": [
      "R7"
    ]
  },
  {
    "id": "periph.ip_parameters_without_check",
    "entity": "peripheral",
    "key": "{ip}.IPParametersWithoutCheck",
    "valueKind": "csv",
    "valueNote": "不做 db 校验的参数名单。",
    "trigger": "本插件不写（CubeMX 极少写入，且仅非空时写）。",
    "order": "insertion",
    "evidence": [
      "jar.md:106"
    ],
    "writer": null
  },
  {
    "id": "rcc.adc_presc",
    "entity": "rcc",
    "key": "RCC.ADCPresc",
    "valueKind": "enum",
    "valueNote": "RCC_ADCPCLK2_DIV2/4/6/8。",
    "trigger": "ADC 预设写（F1 上 R5 要求 DIV6）；必须同步 ADCFreqValue。",
    "order": "dictionary",
    "evidence": [
      "语料 4 份带 ADCPresc 的文件 4/4 满足 ADCFreqValue == APB2/分频"
    ],
    "writer": "src/data/ioc-presets.ts",
    "rules": [
      "R5"
    ]
  },
  {
    "id": "rcc.adc_freq",
    "entity": "rcc",
    "key": "RCC.ADCFreqValue",
    "valueKind": "hz",
    "valueNote": "ADC 时钟（Hz 十进制）= APB2 / ADCPresc。",
    "trigger": "改了 ADCPresc 就必须重算；否则 .ioc 自相矛盾（÷6 却写着 ÷2 的 36 MHz）。",
    "order": "dictionary",
    "evidence": [
      "语料 4/4 满足该不变量",
      "§59 真机：RCC.ADCFreqValue=12000000 被保留"
    ],
    "writer": "src/engine/ioc-plan.ts:1000",
    "rules": [
      "R5"
    ]
  },
  {
    "id": "rcc.ip_parameters",
    "entity": "rcc",
    "key": "RCC.IPParameters",
    "valueKind": "csv",
    "valueNote": "RCC 写过的键名列表，Collections.sort 之后（唯一一个排过序的 IPParameters）。",
    "trigger": "有 RCC 键变化才重写；顺序错会被真机 diff 出来。",
    "order": "sorted-members",
    "evidence": [
      "jar.md:118",
      "jar.md:248（语料 429 有序 / 75 反例全为旧版板文件）"
    ],
    "writer": "src/engine/ioc-plan.ts:1009"
  },
  {
    "id": "rcc.derived",
    "entity": "rcc",
    "key": "RCC.{member}",
    "valueKind": "text",
    "valueNote": "时钟树派生键（SYSCLKFreq_VALUE、PLLMUL、APB1Freq_Value…）。成员名是 [A-Za-z0-9_]+，取值由 RCC 树决定。",
    "trigger": "由 clock-plan.ts 按 RCC 树逐项重算；此表覆盖全部成员名，避免覆盖率检查将其视为未知键。S5 收尾将原来的 {*} 全通配改为 {member}：既能渲染键名（renderIocKey 现在拼得出 RCC.SYSCLKFreq_VALUE），也固定住「RCC.」这个命名空间本身（RCCF.X 不再命中）。",
    "order": "dictionary",
    "evidence": [
      "jar.md:118-121（RCCService 自己写）",
      "§59 真机：派生频率被同步重算"
    ],
    "writer": "src/engine/clock-plan.ts"
  },
  {
    "id": "project.functionlistsort",
    "entity": "project",
    "key": "ProjectManager.functionlistsort",
    "valueKind": "csv",
    "valueNote": "生成时按序调用的初始化清单：序号-MX_xxx_Init-IP-<bool>-HAL-<bool>。",
    "trigger": "本插件有意不写：CubeMX 保存时按既有编号自行追加，且每个外设的函数名后缀不统一（USART1→MX_USART1_UART_Init，TIM2→MX_TIM2_Init），猜测错误会破坏生成顺序。ioc_verify 将其单独归到 autoAddedFunctions。",
    "order": "sequence",
    "evidence": [
      "jar.md:212",
      "真机 2026-11-02 两轮：只追加 1 条、格式正确"
    ],
    "writer": null
  },
  {
    "id": "project.manager_key",
    "entity": "project",
    "key": "ProjectManager.{name}",
    "valueKind": "text",
    "valueNote": "工程管理项：ProjectName、TargetToolchain、KeepUserCode、HeapSize、MainLocation、DeviceId…（成员名就是 CubeMX 的字段名）。",
    "trigger": "本插件不写（仅在 apply 前读取 ProjectManager.KeepUserCode 作为安全闸）；CubeMX 每次保存都会写一整组。此前这些键被 {ip}.{name} 回退为 periph.parameter，等于把工程配置误记成外设参数——分出来之后，{ip}.{name} 命中时才能按「是否为真实外设」判定拼写错误。",
    "order": "dictionary",
    "evidence": [
      "语料 65 行 / 2 份 board 级文件（34 个不同成员）",
      "demo.ioc 41 个 ProjectManager.* 键（真工程文件里的主导形态）"
    ],
    "writer": null
  },
  {
    "id": "project.mxcube_version",
    "entity": "project",
    "key": "MxCube.Version",
    "valueKind": "text",
    "valueNote": "写这份 .ioc 的 CubeMX 版本（6.15.0）。",
    "trigger": "本插件不修改（修改等于伪造版本，会影响 CubeMX 的兼容分支）。",
    "order": "dictionary",
    "evidence": [
      "语料 504 份均带（4.5.0 … 4.21.0）"
    ],
    "writer": null
  },
{
    "id": "project.keep_user_placement",
    "entity": "project",
    "key": "KeepUserPlacement",
    "valueKind": "bool",
    "valueNote": "生成时是否保留用户代码区（true/false）。",
    "trigger": "CubeMX 恒写；本插件不写（模板自带）。",
    "order": "dictionary",
    "evidence": [
      "语料 504/504 均带",
      "demo.ioc:2"
    ],
    "writer": null
  },
  {
    "id": "project.board_ioc",
    "entity": "project",
    "key": "boardIOC",
    "valueKind": "bool",
    "valueNote": "这份 .ioc 是从板级配置导入的（true/false）。",
    "trigger": "CubeMX 恒写；本插件不写。",
    "order": "dictionary",
    "evidence": [
      "语料 504/504 均带"
    ],
    "writer": null
  },
  {
    "id": "project.board_name",
    "entity": "project",
    "key": "board",
    "valueKind": "text",
    "valueNote": "板名（NUCLEO-F030R8）或 custom。",
    "trigger": "CubeMX 恒写；本插件不写。",
    "order": "dictionary",
    "evidence": [
      "语料 501/504"
    ],
    "writer": null
  },
  {
    "id": "project.bsp_ip_name",
    "entity": "project",
    "key": "BSP_IP_NAME",
    "valueKind": "text",
    "valueNote": "BSP 组件名（只有板级配置带）。",
    "trigger": "本插件不写。",
    "order": "dictionary",
    "evidence": [
      "语料 65/504"
    ],
    "writer": null
  },
  {
    "id": "project.mmt_app_regions",
    "entity": "project",
    "key": "MMTAppRegionsCount",
    "valueKind": "count",
    "valueNote": "内存映射表（MMT）分区数（只有部分高端型号带）。",
    "trigger": "本插件不写。",
    "order": "dictionary",
    "evidence": [
      "语料 26/504"
    ],
    "writer": null
  },
  {
    "id": "project.mmt_applied",
    "entity": "project",
    "key": "MMTConfigApplied",
    "valueKind": "bool",
    "valueNote": "是否应用了 MMT 配置。",
    "trigger": "本插件不写。",
    "order": "dictionary",
    "evidence": [
      "语料 26/504"
    ],
    "writer": null
  },
{
    "id": "pin.context_owner",
    "entity": "pin",
    "key": "{pin}.ContextOwner",
    "valueKind": "text",
    "valueNote": "引脚上下文归属（只有板级 BSP 配置带，如 PB4(NJRST).ContextOwner）。",
    "trigger": "本插件不写。",
    "order": "dictionary",
    "evidence": [
      "语料 3 例（PB4(NJRST) / PH3-BOOT0）"
    ],
    "writer": null
  }
];
/** 占位符 → 正则片段。{*} 是 catch-all，不取参。 */
const PLACEHOLDER_PATTERN: Readonly<Record<string, string>> = {
  pin: ".+?",
  index: "\\d+",
  ip: "[A-Za-z0-9_]+",
  name: ".+?",
  n: "\\d+",
  signal: ".+?",
  member: "[A-Za-z0-9_]+",
  "*": ".*",
};

/** 正则里有特殊含义的字符（用于把模板里的字面量转义成安全的正则片段）。 */
const REGEX_SPECIALS = ".*+?^$()[]{}|\\";

function escapeRegexLiteral(text: string): string {
  let out = "";
  for (const ch of text) {
    out += REGEX_SPECIALS.includes(ch) ? "\\" + ch : ch;
  }
  return out;
}

function placeholderRegex(): RegExp {
  return /\{([a-z*]+)\}/gu;
}

/** 把键模板编译成锚定正则 + 占位符顺序。 */
export function compileIocKeyTemplate(template: string): IocKeyTemplate {
  const names: string[] = [];
  let pattern = "";
  let cursor = 0;
  const re = placeholderRegex();
  for (let m = re.exec(template); m !== null; m = re.exec(template)) {
    pattern += escapeRegexLiteral(template.slice(cursor, m.index));
    const token = m[1] ?? "";
    const fragment = PLACEHOLDER_PATTERN[token];
    if (fragment === undefined) {
      throw new Error("ioc-schema: 未知占位符 " + m[0] + " in " + template);
    }
    if (token === "*") {
      pattern += fragment;
    } else {
      pattern += "(" + fragment + ")";
      names.push(token);
    }
    cursor = m.index + m[0].length;
  }
  pattern += escapeRegexLiteral(template.slice(cursor));
  return { regex: new RegExp("^" + pattern + "$", "u"), names };
}

/** 模板里固定字面量的字符数（占位符与花括号都不算）——字面量越多，模板越具体。 */
function literalWeight(template: string): number {
  return template.replace(/\{[a-z*]+\}/gu, "").length;
}

/**
 * 匹配优先级：三条一起决定谁先匹配，避免宽模板抢走具体键。
 *
 * 0. 以字面量开头、没有 catch-all（Mcu.Pin{index} / NVIC.{name}_IRQn / {pin}.Signal 之外的都算）
 * 1. 以字面量开头、带 catch-all 的命名空间回退（RCC.{*}）
 * 2. 以占位符开头的通配模板（{ip}.{name} / {pin}.Signal / {ip}.IPParameters）
 *
 * 同级再按字面量长度降序：RCC.IPParameters(16) 要压住 {ip}.IPParameters(13)，
 * 而 USART1.IPParameters 匹配不上 RCC.IPParameters，自然落到 {ip}.IPParameters。
 */
function specMatchRank(spec: IocKeySpec): number {
  const startsWithPlaceholder = spec.key.startsWith("{");
  if (!startsWithPlaceholder) return spec.key.includes("{*}") ? 1 : 0;
  return 2;
}

const COMPILED: readonly { readonly spec: IocKeySpec; readonly compiled: IocKeyTemplate }[] = SPECS
  .map((spec, tableIndex) => ({ spec, tableIndex, compiled: compileIocKeyTemplate(spec.key) }))
  .sort((a, b) =>
    specMatchRank(a.spec) - specMatchRank(b.spec) ||
    literalWeight(b.spec.key) - literalWeight(a.spec.key) ||
    a.tableIndex - b.tableIndex)
  .map((entry) => ({ spec: entry.spec, compiled: entry.compiled }));

/** 真值表（对外只读别名）。 */
export const IOC_SCHEMA: readonly IocKeySpec[] = SPECS;

export function iocSpecById(id: string): IocKeySpec | null {
  return SPECS.find((spec) => spec.id === id) ?? null;
}

/** 按表内顺序做首次匹配；未登记返回 null。 */
export function matchIocKey(key: string): IocKeyMatch | null {
  for (const entry of COMPILED) {
    const hit = entry.compiled.regex.exec(key);
    if (hit === null) continue;
    const params: Record<string, string> = {};
    entry.compiled.names.forEach((name, i) => {
      params[name] = hit[i + 1] ?? "";
    });
    return { spec: entry.spec, params };
  }
  return null;
}

/** 生成器写键名的唯一入口：按 spec id + 占位符值渲染。参数缺失/多余都抛错（防止拼错键名）。 */
export function renderIocKey(id: string, params: Readonly<Record<string, string | number>> = {}): string {
  const spec = iocSpecById(id);
  if (spec === null) throw new Error("ioc-schema: 未知 spec id " + id);
  if (spec.key.includes("{*}")) {
    throw new Error("ioc-schema: " + id + " 是 catch-all 模板，只用于识别（matchIocKey），不能用来渲染键名");
  }
  const used = new Set<string>();
  const rendered = spec.key.replace(placeholderRegex(), (_all: string, token: string) => {
    if (token === "*") return "";
    const value = params[token];
    if (value === undefined) {
      throw new Error("ioc-schema: " + id + " 缺少占位符 {" + token + "} 的值");
    }
    used.add(token);
    return String(value);
  });
  for (const name of Object.keys(params)) {
    if (!used.has(name)) throw new Error("ioc-schema: " + id + " 不接受占位符 {" + name + "}");
  }
  return rendered;
}

/* ─────────────────── 覆盖率分层 + 键形状审计（S5 收尾） ───────────────────
 *
 * 为什么必须分层：{ip}.{name} 这条模板会把**任何**带点的键都兜住——ProjectManager.ProjectName、
 * PA9.随便什么、TIM3.Parameter 拼成 TIM3.Paramter，全都算「覆盖」。于是原来那句「覆盖率 100%」
 * 并不能说明键名写对了，闸门只在形状上拦得住「没有点号」的键。
 *
 * 这里把命中强度分三档（由模板形状自动推导，不在表里加字段，避免 49 条各写一遍）：
 *   exact     —— 模板里没有占位符（Mcu.PinsNb / NVIC.PriorityGroup）：键名逐字比对。
 *   shape     —— 占位符都带边界，或末尾还有字面量段（Mcu.Pin{index} / {pin}.Signal / Dma.{ip}.{n}.RequestParameters）：
 *                键名里「哪一段是什么」被核对过了，剩下的只是数值/名字。
 *    namespace —— 含自由文本占位符且以此为结尾（{ip}.{name} / SH.{signal}.{n} / Dma.{ip}.{n}.{name}）：
 *                只证明了「是「前缀.某东西」这个形状」，一个拼错的键也能命中。
 *
 * 所以闸门分两道：exact/shape 直接算 covered；namespace 级的键还要过 auditIocKeys()，
 * 按上下文（Mcu.IP<i> 里真实启用的实例 / db 引脚名 / db 参数清单）逐条判。 */

export type IocKeyTier = "exact" | "shape" | "namespace";

/** 这些占位符填的是自由文本（任意字符），填什么都能匹配上。 */
const FREE_FORM_PLACEHOLDERS: readonly string[] = ["pin", "name", "signal"];

const TIER_CACHE = new Map<string, IocKeyTier>();

/** 由键模板形状推导命中强度（纯函数，结果按 spec id 缓存）。 */
export function iocKeyTier(spec: IocKeySpec): IocKeyTier {
  const cached = TIER_CACHE.get(spec.id);
  if (cached !== undefined) return cached;
  const placeholders = [...spec.key.matchAll(placeholderRegex())].map((match) => match[1] ?? "");
  let tier: IocKeyTier;
  if (placeholders.length === 0) {
    tier = "exact";
  } else if (placeholders.includes("*")) {
    tier = "namespace";
  } else if (!placeholders.some((token) => FREE_FORM_PLACEHOLDERS.includes(token))) {
    tier = "shape";
  } else {
    // 自由文本占位符后面还有字面量（{pin}.Signal 的 ".Signal"、NVIC.{name}_IRQn 的 "_IRQn"）→ 属性/后缀被核对过。
    const tail = spec.key.slice(spec.key.lastIndexOf("}") + 1);
    tier = /[A-Za-z0-9_]/u.test(tail) ? "shape" : "namespace";
  }
  TIER_CACHE.set(spec.id, tier);
  return tier;
}

/**
 * 已知的「伪命名空间」：并非外设实例，但确实会以 `前缀.成员` 的形式出现。
 * 目的是让 auditIocKeys 别把这些报成拼错。计数来自 504 份 board 级语料（键出现行数）。
 */
export const IOC_NAMESPACE_PREFIXES: readonly string[] = [
  "ProjectManager",     // 65 行 / 2 份（工程配置组；真工程 demo.ioc 里 41 个键）
  "CAD",                // 624 行 / 208 份（引脚分配图视图状态）
  "File",               // 504 份均带 File.Version
  "MxDb",               // 501 份均带 MxDb.Version
  "PinOutPanel",        // 501 份（RotationAngle / Zoom）
  "GPIO",               // 179 份（GPIO.groupedBy）
  "Mcu",                // 1376 行（Mcu.ThirdPartyNb / Mcu.UserConstants 等）
  "STMicroelectronics", // 313 行（IDE 版本键）
  "RCC",                // 时钟树键的命名空间
  "NVIC",               // 中断控制器键的命名空间
  "Dma",                // DMA 键的命名空间
  "SH",                 // 共享信号块
];

/** 覆盖率检查：生成器实际产出的键里，有没有 schema 不认识的（按命中强度分层）。 */
export function iocSchemaCoverage(keys: Iterable<string>): {
  readonly covered: readonly string[];
  /** exact / shape 命中：键名形状被真正核对过。 */
  readonly strong: readonly string[];
  /** namespace 命中：只证明了「前缀.某东西」，拼错也能命中，要再过 auditIocKeys。 */
  readonly weak: readonly string[];
  readonly uncovered: readonly string[];
  readonly specIds: readonly string[];
} {
  const covered: string[] = [];
  const strong: string[] = [];
  const weak: string[] = [];
  const uncovered: string[] = [];
  const specIds = new Set<string>();
  for (const key of keys) {
    const hit = matchIocKey(key);
    if (hit === null) {
      uncovered.push(key);
      continue;
    }
    covered.push(key);
    specIds.add(hit.spec.id);
    if (iocKeyTier(hit.spec) === "namespace") weak.push(key);
    else strong.push(key);
  }
  return { covered, strong, weak, uncovered, specIds: [...specIds] };
}

/** 人读描述：命中哪条 spec、占位符取值是什么。 */
export function describeIocKey(key: string): string {
  const hit = matchIocKey(key);
  if (hit === null) return key + " → 未登记";
  const params = Object.entries(hit.params)
    .map(([name, value]) => name + "=" + value)
    .join(", ");
  return key + " → " + hit.spec.id + (params === "" ? "" : " (" + params + ")");
}

/* ─────────────────────── namespace 级键的上下文审计 ───────────────────────
 *
 * 闸门第二道：光命中 {ip}.{name} 不算数，还要看占位符填进来的东西是不是真的存在。
 * 三个判据都来自现场（.ioc 里的 Mcu.IP<i> 列表、本机 db 的引脚表与参数清单），不是猜：
 *   - ip 是已启用的外设实例 → 成员名必须在 db 给这个 IP 的 RefParameter 清单里（拼错 Baudrate 会被抓）；
 *   - ip 是 db 里的引脚名 → 说明写的是「引脚属性」，但引脚属性必须逐条登记进表（否则 CubeMX 会丢弃该属性）；
 *   - ip 是已知伪命名空间（ProjectManager/CAD/…）→ 放行；
 *   - 三者都不是 → 「疑似拼错」，这是本插件唯一能直接判错的一类。 */

/**
 * 这些前缀在 db 里是 IP 实例、但 CubeMX 从不将其登记进 Mcu.IP<i>，键直接归入伪命名空间。
 * 目前只有 GPIO：504 份板级 .ioc 里 Mcu.IPn=GPIO 出现 0 次，GPIO.groupedBy 实测只有
 * "Group By Peripherals"(110) / "Show All"(8) 两种值。加新前缀前先给语料计数。
 */
export const IOC_VIRTUAL_NAMESPACES: ReadonlySet<string> = new Set(["GPIO"]);

export interface IocKeyAuditContext {
  /** Mcu.IP<i> 的值：真正启用的外设实例（USART1、TIM3…）。比较时忽略大小写。 */
  readonly instances?: Iterable<string>;
  /** db 引脚名（PA0-WKUP、PB4(NJRST)…）。 */
  readonly pins?: Iterable<string>;
  /** db 里这个芯片有的 IP 实例（含未启用的）：用来区分「拼错实例名」和「有实例但没进 Mcu.IPn」。 */
  readonly dbInstances?: Iterable<string>;
  /** 额外认作命名空间的前缀（默认就是 IOC_NAMESPACE_PREFIXES）。 */
  readonly namespaces?: Iterable<string>;
  /** 某个实例在 db 里的参数名清单；返回 null = 查不到，这一条就不校验。 */
  readonly paramNamesOf?: (instance: string) => readonly string[] | null;
  /** Dma.<IP>.<n>.<name> 里合法的参数名（DMA_PARAM_ORDER 那种白名单）；不给就不校验。 */
  readonly dmaParamNames?: Iterable<string>;
}

export type IocKeyVerdict =
  | "ok"
  | "unregistered"
  | "unknown-namespace"
  | "pin-attribute"
  | "inactive-instance"
  | "unknown-parameter"
  | "unknown-dma-parameter";

export interface IocKeyAuditFinding {
  readonly key: string;
  /** 命中的 spec id；没登记时为空串。 */
  readonly specId: string;
  readonly tier: IocKeyTier | "none";
  readonly verdict: IocKeyVerdict;
  /** 人读说明（已含占位符取值），可直接拼进告警。 */
  readonly detail: string;
}

function upperSet(values: Iterable<string> | undefined): ReadonlySet<string> {
  const set = new Set<string>();
  for (const value of values ?? []) set.add(value.trim().toUpperCase());
  return set;
}

/**
 * 参数名是否在 db 清单里。
 * CubeMX 的部分参数是按实例/通道合成出来的（ADC 的 `Channel-0#ChannelRegularConversion`、
 * `Rank-0#ChannelRegularConversion`、`SamplingTime-0#…`），db 的 <RefParameter> 只登记基名
 * （`Channel`/`Rank`/`SamplingTime`）。所以先整体命中，再退一步判「-/# 之前的基名」命中。
 */
function parameterNameKnown(name: string, names: readonly string[]): boolean {
  if (names.includes(name)) return true;
  const cut = name.search(/[-#]/u);
  return cut > 0 && names.includes(name.slice(0, cut));
}

/** 逐键审计：形状命中 → 再看上下文。返回的 finding 顺序与输入一致（含 ok 项，便于测试断言）。 */
export function auditIocKeys(
  keys: Iterable<string>,
  context: IocKeyAuditContext = {},
): readonly IocKeyAuditFinding[] {
  const instances = upperSet(context.instances);
  const pins = upperSet(context.pins);
  const dbInstances = upperSet(context.dbInstances);
  const namespaces = upperSet([...IOC_NAMESPACE_PREFIXES, ...(context.namespaces ?? [])]);
  const dmaParams = context.dmaParamNames === undefined ? null : new Set(context.dmaParamNames);
  const findings: IocKeyAuditFinding[] = [];
  for (const key of keys) {
    const hit = matchIocKey(key);
    if (hit === null) {
      findings.push({ key, specId: "", tier: "none", verdict: "unregistered", detail: "真值表里没有这个键的形状" });
      continue;
    }
    const tier = iocKeyTier(hit.spec);
    const base = { key, specId: hit.spec.id, tier };
    if (tier !== "namespace") {
      findings.push({ ...base, verdict: "ok", detail: hit.spec.id });
      continue;
    }
    if (hit.spec.id === "periph.parameter") {
      const ip = (hit.params.ip ?? "").trim();
      const name = hit.params.name ?? "";
      const upper = ip.toUpperCase();
      // GPIO 是"伪实例"：db 里确实有 IP InstanceName="GPIO"，但 CubeMX 从不将其写入 Mcu.IP<i>
      // （504 份板级 .ioc 里 Mcu.IPn=GPIO 出现 0 次），其 <pin>.GPIO_* 走引脚名、GPIO.groupedBy 走面板设置。
      // 所以必须先判伪命名空间，否则会被判成"有实例但没启用"，把一个合法键报成错误。
      if (IOC_VIRTUAL_NAMESPACES.has(upper) && !instances.has(upper)) {
        findings.push({ ...base, verdict: "ok", detail: ip + " 是面板/全局设置用的伪命名空间（CubeMX 不将其列入 Mcu.IP<i>）" });
        continue;
      }
      if (instances.has(upper)) {
        const names = context.paramNamesOf?.(upper) ?? null;
        if (names !== null && !parameterNameKnown(name, names)) {
          const head = name.search(/[-#]/u) > 0 ? name.slice(0, name.search(/[-#]/u)) : "";
          findings.push({
            ...base,
            verdict: "unknown-parameter",
            detail:
              ip + " 的 db 参数清单里没有 " + name +
              (head === "" ? "" : "，也没有基名 " + head) +
              "（CubeMX 只认清单里的参数，拼错的键会被静默丢弃）",
          });
          continue;
        }
        findings.push({ ...base, verdict: "ok", detail: ip + " 是已启用实例，参数 " + name + (names === null ? "（无 db 清单，未校验）" : "）") });
        continue;
      }
      if (dbInstances.has(upper)) {
        findings.push({
          ...base,
          verdict: "inactive-instance",
          detail: ip + " 在这颗芯片的 db 里有，但 Mcu.IP<i> 里没启用：这些参数键没有接收方，先启用外设（peripherals）",
        });
        continue;
      }
      if (pins.has(upper)) {
        findings.push({
          ...base,
          verdict: "pin-attribute",
          detail: ip + " 是引脚名，" + name + " 是引脚属性；引脚属性必须逐条登记进真值表（否则 CubeMX 会丢弃该属性）",
        });
        continue;
      }
      if (namespaces.has(upper)) {
        findings.push({ ...base, verdict: "ok", detail: ip + " 是已知命名空间" });
        continue;
      }
      findings.push({
        ...base,
        verdict: "unknown-namespace",
        detail: ip + " 既不是已启用的外设实例，也不是 db 引脚名或已知命名空间",
      });
      continue;
    }
    if (hit.spec.id === "dma.request_group") {
      const ip = (hit.params.ip ?? "").trim();
      const name = hit.params.name ?? "";
      if (dmaParams !== null && !dmaParams.has(name)) {
        findings.push({
          ...base,
          verdict: "unknown-dma-parameter",
          detail: "Dma." + ip + " 的 " + name + " 不在 DMA 参数白名单里（写进去会被静默忽略）",
        });
        continue;
      }
      findings.push({ ...base, verdict: "ok", detail: "Dma." + ip + " 的参数 " + name });
      continue;
    }
    findings.push({ ...base, verdict: "ok", detail: hit.spec.id + "（命名空间级匹配，值未校验）" });
  }
  return findings;
}
