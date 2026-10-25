/*
 * 寄存器版 main.c（dsh-stm32 生成，模板来源 templates/register/Core/Src/main.c）。
 *
 * 这块代码不依赖 HAL / CubeMX：只用 CMSIS 设备头里的寄存器定义。
 * 板子假设：STM32F103C8T6 蓝丸，板载 LED 在 PC13（低电平点亮）。
 * 换成自己的板子时只改 LED_PORT / LED_PIN 两个宏即可。
 */

#include <stdint.h>
#include "stm32f1xx.h"

/* 换板子改这两行 */
#define LED_PORT GPIOC
#define LED_PIN  13u

/* 便于用 gdb / 串口观察：每翻转一次加一（stm32_debug_eval 可以直接读它） */
volatile uint32_t g_led_blink_count = 0u;

/* SysTick 延时：忙等 COUNTFLAG，参数单位毫秒。SystemCoreClock 由 system_stm32f1xx.c 维护。 */
static void delay_ms(uint32_t ms)
{
    SysTick->LOAD = (uint32_t)(SystemCoreClock / 1000u) - 1u;
    SysTick->VAL = 0u;
    SysTick->CTRL = SysTick_CTRL_CLKSOURCE_Msk | SysTick_CTRL_ENABLE_Msk;
    while (ms-- > 0u) {
        while ((SysTick->CTRL & SysTick_CTRL_COUNTFLAG_Msk) == 0u) {
        }
    }
    SysTick->CTRL = 0u;
}

static void led_init(void)
{
#if LED_PIN == 13u
    RCC->APB2ENR |= RCC_APB2ENR_IOPCEN;
    /* CRH 管 8..15 号脚：清掉 13 号脚的 MODE/CNF，再设成 10 MHz 推挽输出 */
    GPIOC->CRH &= ~(GPIO_CRH_MODE13 | GPIO_CRH_CNF13);
    GPIOC->CRH |= GPIO_CRH_MODE13_0;
    GPIOC->BSRR = GPIO_BSRR_BS13; /* 先熄灭（PC13 低电平点亮） */
#else
#error "只写好了 PC13 的初始化；换引脚请在 led_init() 里补对应的 CRL/CRH 设置"
#endif
}

static void led_toggle(void)
{
#if LED_PIN == 13u
    GPIOC->ODR ^= GPIO_ODR_ODR13;
#else
#error "只写好了 PC13 的翻转；换引脚请改这里"
#endif
}

int main(void)
{
    led_init();

    while (1) {
        led_toggle();
        g_led_blink_count++;
        delay_ms(500u);
    }
}
