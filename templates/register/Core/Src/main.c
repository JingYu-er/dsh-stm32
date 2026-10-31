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
#include "rtt.h"   /* 模板自带的极简 RTT；不用就把这行和下面 USER CODE BEGIN 2 的示例一起删掉 */

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
    /* 保存 SysTick 现场：调用方可能已经把它当成 1 ms 时基（TICKINT 打开）。
     * 早期版本结束时直接写 CTRL = 0，会把那个时基一起掐掉——这里用完原样恢复。 */
    const uint32_t ctrl_save = SysTick->CTRL;
    const uint32_t load_save = SysTick->LOAD;

    SysTick->CTRL = 0u;                                             /* 先停，才能安全改 LOAD/VAL */
    SysTick->LOAD = (uint32_t)(SystemCoreClock / 1000u) - 1u;
    SysTick->VAL = 0u;
    SysTick->CTRL = SysTick_CTRL_CLKSOURCE_Msk | SysTick_CTRL_ENABLE_Msk;

    while (ms-- > 0u) {
        while ((SysTick->CTRL & SysTick_CTRL_COUNTFLAG_Msk) == 0u) {
        }
    }

    SysTick->CTRL = 0u;                                             /* 停掉忙等用的配置 */
    SysTick->LOAD = load_save;                                      /* 还原现场 */
    SysTick->VAL = 0u;
    SysTick->CTRL = ctrl_save;
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

    /* USER CODE BEGIN 2 */
    /*
     * RTT 调试输出（可选，默认没开）：模板里 rtt.c/rtt.h 已经就位，但 rtt_init()
     * 不强制调用——工具链开了 --gc-sections，没调用时 rtt.c 的代码和 3 KB 控制块
     * 缓冲会被整个丢掉，不占 RAM/Flash。要用就取消下面两行的注释：
     *
     *     rtt_init();                     // 必须在 clock_init() 之后（时间戳要用 DWT 周期计数器）
     *     rtt_printf(RTT_LEVEL_INFO, "boot: sysclk=%lu Hz", (unsigned long)SystemCoreClock);
     *
     * 之后在宿主侧这样读（openocd 的 rtt 命令 + TCP 端口，插件已经封装好）：
     *     arm-none-eabi-nm build/<preset>/<工程名>.elf | findstr _SEGGER_RTT   // 拿控制块地址
     *     stm32_rtt action=start addr=0x2000xxxx    // 地址就是 nm 出来的那个，size 用默认 0x400
     *     stm32_rtt action=dump                     // 打印 {t, level, text} 记录
     *     stm32_rtt action=stop
     *
     * 代价与限制：
     *   - 3 个上行通道 × 1 KB = 3 KB RAM（C8T6 只有 20 KB）。嫌多就改 rtt.h 里的
     *     RTT_UP_CHANNELS=1、RTT_BUF_SIZE=256；
     *   - 控制块是普通 .bss 变量，地址随重链接漂移，所以别把地址写死，每次 nm 一遍；
     *   - 环满时整条记录丢弃（不阻塞、不覆盖未读数据），rtt_dropped_count() 能看丢了几条；
     *   - 主循环和中断都能写，但它没加锁：多个上下文并发写要自己关中断。
     */
    /* USER CODE END 2 */

    while (1) {
        led_toggle();
        g_led_blink_count++;
        delay_ms(500u);
    }
}
