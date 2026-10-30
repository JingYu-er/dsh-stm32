/*
 * 极简 RTT 实现（dsh-stm32 寄存器版模板自带）——配套 rtt.h，接口与约定都写在那里面。
 *
 * 这里只强调三件容易被改坏的事：
 *
 * 1) 控制块布局必须与 SEGGER RTT 一致，否则 openocd 的 rtt setup 找不到/解析不了：
 *      char acID[16] = "SEGGER RTT"  →  两个 u32 通道数  →  N 个上行描述符  →  下行描述符
 *    每个描述符 6 个 32 位字段：sName、pBuffer、SizeOfBuffer、WrOff、RdOff、Flags。
 *    下面的 _Static_assert 把"ID 在最前""描述符 24 字节""上行数组偏移 24"钉住了，
 *    改动结构体时编译会直接失败，而不是等烧进板子才发现 openocd 报错。
 *
 * 2) 帧格式必须与 src/engine/rtt.ts 的 parseRttFrames() 一致：
 *      [4B 长度 LE][1B 级别][8B 时间戳 ms LE][payload]
 *    长度 = 9 + payload。写半条帧会让 dump 端判失步（它宁可报错也不猜）。
 *
 * 3) openocd 是"消费者"：它读走数据后会改 RdOff。所以写数据一定要先写环、
 *    最后才推进 WrOff；并且放不下完整一条时整条丢掉，不能覆盖还没被读走的字节。
 */

#include "rtt.h"

#include <stdarg.h>   /* va_list / va_start：rtt_printf 用（没引 stdio 的配置下也要能编） */
#include <stddef.h>   /* offsetof：下面的 _Static_assert 用 */
#include <string.h>

#if defined(__has_include)
#  if __has_include(<stdio.h>)
#    include <stdio.h>
#    define RTT_HAVE_STDIO 1
#  endif
#  if __has_include("stm32f1xx.h")
#    include "stm32f1xx.h"
#    define RTT_HAVE_CMSIS 1
#  endif
#endif

#if !defined(RTT_HAVE_CMSIS)
/* 非 F1 / 没有 CMSIS 时也能编：时间戳退化（见 rtt_time_ms）。 */
extern uint32_t SystemCoreClock;
#endif

/* ---------------- 帧格式常量（与引擎一一对应） ---------------- */

/* 4B 长度 + 1B 级别 + 8B 时间戳 */
#define RTT_FRAME_OVERHEAD 13u
/* 长度字段允许的最小值：空 payload 时 = 1 + 8 */
#define RTT_FRAME_MIN_BYTES 9u

/* ---------------- SEGGER RTT 控制块 ---------------- */

/* 通道描述符：必须正好 24 字节（6 个 32 位字段），否则 openocd 解析会错位。 */
typedef struct {
    const char *sName;          /* 通道名，给 openocd 打印用 */
    uint8_t *pBuffer;           /* 环形缓冲 */
    uint32_t SizeOfBuffer;      /* 环大小（字节） */
    uint32_t WrOff;             /* 写偏移：只由固件改 */
    volatile uint32_t RdOff;    /* 读偏移：由 openocd 改 */
    uint32_t Flags;             /* 0 = NO_BLOCK_SKIP（环满就丢新记录，不阻塞） */
} rtt_buffer_desc_t;

/* 控制块：ID 在最前，紧跟两个通道数，然后是上行描述符数组。
 * MaxNumDownBuffers = 0：不做下行通道，aDown 只占位保证布局不越界。 */
typedef struct {
    char acID[16];
    uint32_t MaxNumUpBuffers;
    uint32_t MaxNumDownBuffers;
    rtt_buffer_desc_t aUp[RTT_UP_CHANNELS];
    rtt_buffer_desc_t aDown[1];
} rtt_control_block_t;

_Static_assert(sizeof(rtt_buffer_desc_t) == 24u, "通道描述符必须 24 字节（sName/pBuffer/Size/WrOff/RdOff/Flags 各 4 字节）");
_Static_assert(offsetof(rtt_control_block_t, acID) == 0u, "控制块必须以 ID 开头");
_Static_assert(offsetof(rtt_control_block_t, MaxNumUpBuffers) == 16u, "ID 之后是上行通道数");
_Static_assert(offsetof(rtt_control_block_t, aUp) == 24u, "ID(16) + 两个通道数(4+4) 之后才是上行通道描述符");

/* ID 文本单独拿出来：memcpy 的时候连结尾 0 一起写（sizeof 包含它）。 */
static const char RTT_ID_TEXT[] = "SEGGER RTT";

/* 3 个上行通道的环形缓冲（.bss；模板默认不启用 rtt.c，--gc-sections 会把它丢掉）。 */
static uint8_t s_up_buf[RTT_UP_CHANNELS][RTT_BUF_SIZE];

/* 控制块本体。名字保持 _SEGGER_RTT，方便 nm / map / gdb 一眼找到地址。 */
__attribute__((used)) rtt_control_block_t _SEGGER_RTT;

static uint32_t s_dropped;
static uint8_t s_initialized;
#if defined(RTT_HAVE_CMSIS)
static uint32_t s_cycles_per_ms;
#endif

static const char *rtt_up_name(uint32_t index)
{
    switch (index) {
    case 0u:
        return "Terminal";
    case 1u:
        return "Channel 1";
    default:
        return "Channel 2";
    }
}

uint32_t rtt_control_block_addr(void)
{
    return (uint32_t)(uintptr_t)&_SEGGER_RTT;
}

uint32_t rtt_control_block_size(void)
{
    /* 控制块本身只有 ~120 字节，但 openocd 是按 [addr, addr+size) 扫 ID 的，
     * 传大一点（例如 0x400）也无害，能把紧跟其后的描述符都覆盖住。 */
    return (uint32_t)sizeof(_SEGGER_RTT);
}

/*
 * 往一个环里写一整块数据。返回写进去的字节数，放不下返回 0。
 * 关键顺序：先 memcpy 数据、最后写 WrOff；RdOff 只读不改（openocd 的）。
 */
static uint32_t rtt_ring_write(rtt_buffer_desc_t *desc, const uint8_t *data, uint32_t len)
{
    uint32_t size = desc->SizeOfBuffer;
    uint32_t wr = desc->WrOff;
    uint32_t rd = desc->RdOff;
    uint32_t used;      /* 无符号相减：只要 used < size 就说明没追尾 */
    uint32_t wr_pos;
    uint32_t first;

    if (size == 0u || data == NULL || len == 0u) {
        return 0u;
    }
    used = wr - rd;
    if (used >= size) {
        return 0u;  /* 满：整条丢掉（NO_BLOCK_SKIP），不覆盖还没被读走的数据 */
    }
    if (len > size - used) {
        return 0u;  /* 放不下完整一条：宁可丢，也不写半条让对端失步 */
    }

    wr_pos = wr % size;     /* 环大小是 2 的幂时编译器会把它优化成 & (size-1) */
    first = size - wr_pos;
    if (first > len) {
        first = len;
    }
    memcpy(&desc->pBuffer[wr_pos], data, first);
    if (len > first) {
        memcpy(desc->pBuffer, data + first, len - first);
    }
    desc->WrOff = wr + len; /* 最后一步：对端看到写指针前进时数据已经就位 */
    return len;
}

void rtt_init(void)
{
    uint32_t index;

    memset(&_SEGGER_RTT, 0, sizeof(_SEGGER_RTT));
    _SEGGER_RTT.MaxNumUpBuffers = (uint32_t)RTT_UP_CHANNELS;
    _SEGGER_RTT.MaxNumDownBuffers = 0u;
    for (index = 0u; index < (uint32_t)RTT_UP_CHANNELS; index++) {
        _SEGGER_RTT.aUp[index].sName = rtt_up_name(index);
        _SEGGER_RTT.aUp[index].pBuffer = s_up_buf[index];
        _SEGGER_RTT.aUp[index].SizeOfBuffer = (uint32_t)RTT_BUF_SIZE;
        _SEGGER_RTT.aUp[index].WrOff = 0u;
        _SEGGER_RTT.aUp[index].RdOff = 0u;
        _SEGGER_RTT.aUp[index].Flags = 0u;
    }

#if defined(RTT_HAVE_CMSIS)
    /* DWT 周期计数器：F103 的 Cortex-M3 有，用来做毫秒时间戳（不需要额外中断）。 */
    CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
    DWT->CYCCNT = 0u;
    DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
    s_cycles_per_ms = (uint32_t)(SystemCoreClock / 1000u);
#endif

    s_dropped = 0u;
    s_initialized = 1u;

    /* ID 最后写：看到 "SEGGER RTT" 时通道描述符一定已经就绪。 */
    memcpy(_SEGGER_RTT.acID, RTT_ID_TEXT, sizeof(RTT_ID_TEXT));
}

__attribute__((weak)) uint64_t rtt_time_ms(void)
{
#if defined(RTT_HAVE_CMSIS)
    static uint32_t s_last_cycles;
    static uint64_t s_ms;
    uint32_t now = DWT->CYCCNT;
    uint32_t delta = now - s_last_cycles;   /* 无符号相减，计数器回绕也对 */

    s_last_cycles = now;
    if (s_cycles_per_ms != 0u) {
        s_ms += (uint64_t)(delta / s_cycles_per_ms);   /* 不足 1 ms 的零头在这里丢掉 */
    }
    return s_ms;
#else
    return 0u;
#endif
}

static void rtt_put_u32(uint8_t *dst, uint32_t value)
{
    dst[0] = (uint8_t)(value & 0xFFu);
    dst[1] = (uint8_t)((value >> 8) & 0xFFu);
    dst[2] = (uint8_t)((value >> 16) & 0xFFu);
    dst[3] = (uint8_t)((value >> 24) & 0xFFu);
}

static void rtt_put_u64(uint8_t *dst, uint64_t value)
{
    uint32_t index;

    for (index = 0u; index < 8u; index++) {
        dst[index] = (uint8_t)((value >> (8u * index)) & 0xFFu);
    }
}

uint32_t rtt_write(uint32_t level, const char *text)
{
    uint8_t frame[RTT_FRAME_OVERHEAD + RTT_MSG_MAX];
    uint32_t payload = 0u;
    uint32_t total;
    size_t length = 0u;

    if (s_initialized == 0u) {
        rtt_init();     /* 忘了初始化也能用：第一条记录时补上 */
    }
    if (level < RTT_LEVEL_ERROR) {
        level = RTT_LEVEL_ERROR;
    }
    if (level > RTT_LEVEL_DEBUG) {
        level = RTT_LEVEL_DEBUG;
    }
    if (text != NULL) {
        length = strlen(text);
        if (length > (size_t)RTT_MSG_MAX) {
            length = (size_t)RTT_MSG_MAX;   /* 超长截断：保证 record 长度可预期 */
        }
        memcpy(&frame[RTT_FRAME_OVERHEAD], text, length);
        payload = (uint32_t)length;
    }

    total = RTT_FRAME_OVERHEAD + payload;
    rtt_put_u32(&frame[0], RTT_FRAME_MIN_BYTES + payload);
    frame[4] = (uint8_t)level;
    rtt_put_u64(&frame[5], rtt_time_ms());

    if (rtt_ring_write(&_SEGGER_RTT.aUp[0], frame, total) == 0u) {
        s_dropped++;
        return 0u;
    }
    return payload;
}

#if defined(RTT_HAVE_STDIO)
/*
 * vsnprintf 会牵进 newlib 的 _sbrk（堆延伸）。寄存器版模板不带 syscalls.c，
 * 缺了它会链接失败：undefined reference to `_sbrk'。
 * 这里给一份**弱符号**兜底：失败返回，等于"没有堆"。你自己的 syscalls.c 里
 * 那份强符号会自动覆盖它，malloc 照旧能用（HAL 骨架就带 Core/Src/syscalls.c）。
 */
__attribute__((weak)) void *_sbrk(ptrdiff_t increment)
{
    (void)increment;
    return (void *)-1;
}
#endif

uint32_t rtt_printf(uint32_t level, const char *fmt, ...)
{
#if defined(RTT_HAVE_STDIO)
    char message[RTT_MSG_MAX + 1u];
    va_list args;
    int written;

    if (fmt == NULL) {
        return 0u;
    }
    va_start(args, fmt);
    written = vsnprintf(message, sizeof(message), fmt, args);
    va_end(args);
    if (written < 0) {
        return 0u;
    }
    /* vsnprintf 会截断并保证结尾 0；rtt_write 再按 RTT_MSG_MAX 兜一次。 */
    return rtt_write(level, message);
#else
    (void)level;
    (void)fmt;
    return 0u;
#endif
}

uint32_t rtt_dropped_count(void)
{
    return s_dropped;
}
