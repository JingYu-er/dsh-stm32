/*
 * 寄存器版 main.c（dsh-stm32 生成，模板来源 templates/register/Core/Src/main.c）
 *
 * 目标芯片：__MCU_BANNER__
 * 板子假设：板载 LED 在 PC13（低电平点亮），引脚不同只改下面两行。
 *
 * 这条路线不用 HAL、不用 CubeMX 生成物、也不需要 STM32Cube 固件包：
 * 设备头 + 启动文件 + CMSIS 内核头都在 dsh-stm32 的下载缓存里（第一次联网，之后复用）。
 * 换芯片用 stm32_project_create(route="register", mcu=<型号>)：
 * 启动文件、设备宏、链接脚本（Flash/RAM 尺寸）、时钟初始化都会跟着型号重算。
 */

#include <stdint.h>

#include "stm32f1xx.h"

/* 换板子改这两行 */
#define LED_PORT GPIOC
#define LED_PIN  13u

/* 便于用 gdb / 串口观察：每闪一次 +1 */
volatile uint32_t g_led_blink_count = 0u;

__CLOCK_INIT__
/* 忙等延时：SysTick 数到 SystemCoreClock/1000 个时钟算 1 ms。
 * clock_init() 之后 SystemCoreClock 已经是真实频率，所以不需要手动填数字。 */
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
    GPIOC->CRH &= ~(GPIO_CRH_MODE13 | GPIO_CRH_CNF13);
    GPIOC->CRH |= GPIO_CRH_MODE13_0;   /* 推挽输出 10 MHz */
    GPIOC->BSRR = GPIO_BSRR_BS13;      /* 先给高电平：PC13 低电平点亮 → LED 灭 */
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
    clock_init();   /* 先把频率提到芯片能跑的上限，再配外设 */
    led_init();

    while (1) {
        led_toggle();
        g_led_blink_count++;
        delay_ms(500u);
    }
}
