/*
 * 极简 RTT（Real Time Transfer）——寄存器版模板自带
 *
 * 它做三件事：
 *   1) 在 RAM 里放一块**与 SEGGER RTT 兼容**的控制块（首 10 字节是 "SEGGER RTT"、
 *      3 个上行通道、每个通道一个环形缓冲），这样 openocd 原生的 rtt 命令
 *      （rtt setup / rtt start / rtt server start）能直接认它；
 *   2) 提供 rtt_printf()/rtt_write() 把一条记录写进通道 0；
 *   3) 给出控制块地址，供 dsh-stm32 的 stm32_rtt action=start addr=... 使用。
 *
 * 记录格式是 dsh-stm32 自己的约定（不抄 SEGGER，SEGGER 没有级别和时间戳）：
 *   [4B 长度 LE][1B 级别][8B 时间戳 ms LE][payload UTF-8]
 *   长度字段 = 9 + payload 字节数（不含这 4 字节本身），级别 1..4 = error/warn/info/debug。
 *   src/engine/rtt.ts 里的 parseRttFrames() 就是按这个顺序解的。
 *
 * RAM 成本：RTT_UP_CHANNELS × RTT_BUF_SIZE = 3 × 1 KB = 3 KB（.bss）。
 *   C8T6 只有 20 KB，RAM 紧就把 RTT_UP_CHANNELS 改成 1，或把 RTT_BUF_SIZE 改成 256。
 *   注意：模板默认**不调用** rtt_init()，工具链开了 --gc-sections，所以未启用时
 *   这块内存与 rtt.c 的代码都会被链接器丢掉，不占 RAM/Flash；取消了 main.c 里
 *   USER CODE BEGIN 2 的注释才会真正进来。
 *
 * 地址怎么拿（start 时 addr 填它）：
 *   arm-none-eabi-nm build/<preset>/<工程名>.elf | findstr _SEGGER_RTT
 *   或 gdb 里：p &_SEGGER_RTT
 *   也可以在运行时把 rtt_control_block_addr() 打出来看，但别把地址写死到别的工程里。
 */

#ifndef DSH_STM32_RTT_H
#define DSH_STM32_RTT_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* 级别：与 stm32_rtt 的 dump level 过滤一致（dump 的 level 是"保留到哪一级"的上限） */
#define RTT_LEVEL_ERROR 1u
#define RTT_LEVEL_WARN  2u
#define RTT_LEVEL_INFO  3u
#define RTT_LEVEL_DEBUG 4u

/* 上行通道数：通道 0 是 stm32_rtt 读的那一条（"Terminal"），1/2 留给应用自己分用途。 */
#ifndef RTT_UP_CHANNELS
#define RTT_UP_CHANNELS 3u
#endif

/* 每个上行通道的环形缓冲字节数（3 × 1024 = 3 KB .bss）。 */
#ifndef RTT_BUF_SIZE
#define RTT_BUF_SIZE 1024u
#endif

/* 单条记录的 payload 上限（字节，不含结尾 0）；超长截断，不会写半条帧。 */
#ifndef RTT_MSG_MAX
#define RTT_MSG_MAX 120u
#endif

/* 控制块起始地址：stm32_rtt action=start addr=<这个值>。 */
uint32_t rtt_control_block_addr(void);

/* 控制块占的字节数：给 rtt setup <addr> <size> 的 size 用（传大一点也无害）。 */
uint32_t rtt_control_block_size(void);

/*
 * 初始化控制块：清空环、填好 3 个通道描述符，最后才写 ID 魔数
 * （这样 openocd/stm32_rtt 看到魔数时描述符一定已经就绪）。
 * 可重复调用。会打开 DWT 周期计数器给时间戳用，所以要在时钟初始化之后调用。
 */
void rtt_init(void);

/*
 * 写一条记录到通道 0。level 取 RTT_LEVEL_*（越界会被夹到 1..4）。
 * text 是已经格式化好的字符串（结尾 0 会被 strlen 截掉，不写进环）。
 * 返回写进去的 payload 字节数；环满/放不下完整一条时返回 0（整条丢，不写半条）。
 * 可以从主循环和中断里调用；但它不加锁，多个上下文同时写会互相踩（要并发就在外面关中断）。
 */
uint32_t rtt_write(uint32_t level, const char *text);

/*
 * printf 风格：先 vsnprintf 到内部缓冲（最多 RTT_MSG_MAX 字节），再走 rtt_write。
 *
 * 链接提示：vsnprintf 会牵进 newlib 的 _sbrk（堆延伸）。寄存器版模板没有 syscalls.c，
 * 所以 rtt.c 里给了一份**弱符号** _sbrk 兜底（直接失败，等于没有堆），保证只加
 * rtt_init() + rtt_printf() 就能链接过。你自己有 syscalls.c 时那份强符号会自动覆盖它。
 * 完全不想碰 newlib 就用 rtt_write(level, "已经格式化好的字符串")。
 */
uint32_t rtt_printf(uint32_t level, const char *fmt, ...);

/*
 * 时间戳（毫秒）。默认实现用 DWT 周期计数器按 SystemCoreClock 换算；
 * 应用可以覆盖它（弱符号）来用 HAL_GetTick / 自己的 RTC：
 *   uint64_t rtt_time_ms(void) { return HAL_GetTick(); }
 */
uint64_t rtt_time_ms(void);

/* 因为环满而整条丢掉的记录数（只在本地可见，dump 的 dropped 只统计按级别过滤掉的）。 */
uint32_t rtt_dropped_count(void);

#ifdef __cplusplus
}
#endif

#endif /* DSH_STM32_RTT_H */
