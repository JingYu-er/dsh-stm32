/**
 * 寄存器版模板里的 LED 初始化（GPIO）——按族给不同的寄存器写法。
 *
 * 为什么必须按族：GPIO 的时钟门与配置寄存器在两代之间都变了。
 *   · F1：RCC->APB2ENR 的 IOPxEN + CRL/CRH（每引脚 4 位 MODE/CNF）
 *   · F2/F4/F7：RCC->AHB1ENR + MODER（每引脚 2 位）
 *   · F0/F3/L1：RCC->AHBENR + MODER
 *   · G4/L4：RCC->AHB2ENR + MODER
 *   · C0/G0/L0/U0：RCC->IOPENR + MODER
 * 拿 F1 的写法去配 F4，编译就过（GPIOC->CRH 在 F4 头里不存在？实际是 GPIO_TypeDef 没有 CRH
 * 字段 → 编译期就报错），所以这张表不是"风格选择"，是能不能编过的问题。
 *
 * 这张表是按族实测编译过的（见 docs §82 的 build matrix）；新增族必须先真编一次再加进来。
 */

export type LedStyle = "f1-legacy" | "moder-ahb1" | "moder-ahb" | "moder-ahb2" | "moder-iopenr" | "none";

// 这张表是编译器逼出来的，不是抄手册的：F2 的 GPIO 已经是 MODER、时钟在 AHB1ENR（拿 F1 的 CRH
// 直接报 "GPIO_TypeDef has no member named CRH"）；F3 有 MODER 但时钟门叫 AHBENR（不是 AHB1ENR）。
const STYLE_BY_FAMILY: Readonly<Record<string, LedStyle>> = {
  F1: "f1-legacy",
  F2: "moder-ahb1",
  F3: "moder-ahb",
  F4: "moder-ahb1",
  F7: "moder-ahb1",
  F0: "moder-ahb",
  L1: "moder-ahb",
  G4: "moder-ahb2",
  L4: "moder-ahb2",
  C0: "moder-iopenr",
  G0: "moder-iopenr",
  L0: "moder-iopenr",
  U0: "moder-iopenr",
};

export function ledStyleOf(family: string): LedStyle {
  return STYLE_BY_FAMILY[family.toUpperCase()] ?? "none";
}

export interface LedRender {
  /** 直接替换 main.c 里的 __LED_INIT__：包含 led_init() 与 led_toggle() 两个函数。 */
  text: string;
  warnings: string[];
}

/** 生成 led_init()/led_toggle()。默认 PC13（蓝丸/多数最小系统板）。 */
export function renderLedFunctions(family: string): LedRender {
  const style = ledStyleOf(family);
  if (style === "none") {
    return {
      text: [
        "/* 这一族还没有验证过的 GPIO 写法：led_init()/led_toggle() 留空，工程照常编译/烧录。",
        " * 点灯请按本族参考手册的 GPIO 章补（时钟门 + MODER/CRL/CRH），或改用 HAL 路线。 */",
        "static void led_init(void)",
        "{",
        "}",
        "",
        "static void led_toggle(void)",
        "{",
        "}",
        "",
      ].join("\n"),
      warnings: ["这一族（" + family + "）还没有验证过的寄存器版 GPIO 写法：模板的 LED 是空函数，工程能编译能烧，但不会闪。"],
    };
  }

  const clockLine: Record<Exclude<LedStyle, "none" | "f1-legacy">, string> = {
    "moder-ahb1": "    RCC->AHB1ENR |= RCC_AHB1ENR_GPIOCEN;",
    "moder-ahb": "    RCC->AHBENR |= RCC_AHBENR_GPIOCEN;",
    "moder-ahb2": "    RCC->AHB2ENR |= RCC_AHB2ENR_GPIOCEN;",
    "moder-iopenr": "    RCC->IOPENR |= RCC_IOPENR_GPIOCEN;",
  };

  if (style === "f1-legacy") {
    return {
      text: [
        "static void led_init(void)",
        "{",
        "#if LED_PIN == 13u",
        "    RCC->APB2ENR |= RCC_APB2ENR_IOPCEN;",
        "    GPIOC->CRH &= ~(GPIO_CRH_MODE13 | GPIO_CRH_CNF13);",
        "    GPIOC->CRH |= GPIO_CRH_MODE13_0;   /* 推挽输出 10 MHz */",
        "    GPIOC->BSRR = GPIO_BSRR_BS13;      /* 先给高电平：PC13 低电平点亮 → LED 灭 */",
        "#else",
        "#error \"只写好了 PC13 的初始化；换引脚请在 led_init() 里补对应的 CRL/CRH 设置\"",
        "#endif",
        "}",
        "",
        "static void led_toggle(void)",
        "{",
        "#if LED_PIN == 13u",
        "    GPIOC->ODR ^= GPIO_ODR_ODR13;",
        "#else",
        "#error \"只写好了 PC13 的翻转；换引脚请改这里\"",
        "#endif",
        "}",
        "",
      ].join("\n"),
      warnings: [],
    };
  }

  return {
    text: [
      "static void led_init(void)",
      "{",
      "#if LED_PIN == 13u",
      clockLine[style],
      "    /* MODER：每引脚 2 位；01 = 通用输出 */",
      "    GPIOC->MODER = (GPIOC->MODER & ~(3u << (13u * 2u))) | (1u << (13u * 2u));",
      "    GPIOC->BSRR = (1u << 13u);   /* 先给高电平：PC13 低电平点亮 → LED 灭 */",
      "#else",
      "#error \"只写好了 PC13 的初始化；换引脚请改 MODER 的位\"",
      "#endif",
      "}",
      "",
      "static void led_toggle(void)",
      "{",
      "#if LED_PIN == 13u",
      "    GPIOC->ODR ^= (1u << 13u);",
      "#else",
      "#error \"只写好了 PC13 的翻转；换引脚请改这里\"",
      "#endif",
      "}",
      "",
    ].join("\n"),
    warnings: [],
  };
}
