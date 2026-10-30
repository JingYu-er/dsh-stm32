# RTT（Real Time Transfer）在 HAL 工程里怎么加

这份文件是**说明**，不是代码：HAL 工程由 CubeMX 生成，`Core/**` 是生成区，
往里放自己的 `.c` 会被下次 `stm32_generate` 覆盖，也违反"只改 USER CODE"的红线。
所以 RTT 在你自己的目录里（默认 `App/`），只通过 `cmake/user/CMakeLists.txt` 挂进构建。

寄存器版工程（`stm32_project_create route=register`）**自带** `Core/Src/rtt.c` 与
`Core/Inc/rtt.h`，那边不需要这个文件；本文件只讲 HAL 版。

需要的两个源文件在插件的 `templates/register/Core/Src/rtt.c` 与
`templates/register/Core/Inc/rtt.h`（实现是同一份：SEGGER 兼容控制块 + 通道 0 的
`[4B 长度 LE][1B 级别][8B 时间戳 ms LE][UTF-8 payload]` 帧）。

## 三步

1) 拷文件（在工程根目录执行）：

```bash
mkdir -p App
cp <插件目录>/templates/register/Core/Src/rtt.c App/rtt.c
cp <插件目录>/templates/register/Core/Inc/rtt.h App/rtt.h
```

2) 挂进构建——编辑 `cmake/user/CMakeLists.txt`（CubeMX 不生成这个文件的内容）：

```cmake
target_sources(${CMAKE_PROJECT_NAME} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../../App/rtt.c)
target_include_directories(${CMAKE_PROJECT_NAME} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../../App)
```

3) 在 `Core/Src/main.c` 里只碰 USER CODE 块：

```c
/* USER CODE BEGIN Includes */
#include "rtt.h"
/* USER CODE END Includes */
```

```c
  /* USER CODE BEGIN 2 */
  rtt_init();   /* 必须在 SystemClock_Config() 之后：时间戳用 DWT 周期计数器按 SystemCoreClock 换算 */
  rtt_printf(RTT_LEVEL_INFO, "boot: sysclk=%lu Hz", (unsigned long)SystemCoreClock);
  /* USER CODE END 2 */
```

主循环里同理，写在 `USER CODE BEGIN WHILE` 与 `USER CODE END WHILE` 之间。

## 宿主侧怎么读

```bash
arm-none-eabi-nm build/<preset>/<工程名>.elf | findstr _SEGGER_RTT   # 控制块地址
```

```
stm32_rtt action=start addr=0x2000xxxx    # openocd: rtt setup <addr> 0x400 / rtt start / rtt server start <port> 0
stm32_rtt action=dump seconds=3 level=3  # 打印 {t, level, text}，level 是"保留到哪一级"的上限
stm32_rtt action=stop
```

`addr` 别写死：控制块是普通 `.bss` 变量，加一行代码重链接就会漂移，每次 `nm` 一遍。

## 代价与限制

- 默认 `RTT_UP_CHANNELS=3`、`RTT_BUF_SIZE=1024` → **3 KB RAM**（.bss）；
  `RTT_MSG_MAX=120` 是单条 payload 上限。RAM 紧就改 `rtt.h` 的这两个宏（例如 1 个通道 512 字节）。
- 工具链开了 `--gc-sections`：不调用 `rtt_init()` 时 `rtt.c` 的代码和那块缓冲会被链接器丢掉，不占 RAM/Flash。
- 环满时**整条丢弃**（不阻塞、不覆盖还没被读走的数据），`rtt_dropped_count()` 能看丢了几条。
- 时间戳默认用 DWT 周期计数器；已经有 `HAL_GetTick()` 的话覆盖弱符号更省事：

```c
uint64_t rtt_time_ms(void) { return (uint64_t)HAL_GetTick(); }
```

- 主循环和中断都能写，但它没加锁：多个上下文并发写要自己在外面关中断。
- `rtt_printf()` 用 newlib 的 `vsnprintf`，会牵进 `_sbrk`。HAL 工程本来就带 `Core/Src/syscalls.c`，不用管；
  寄存器版没有 syscalls.c，所以 `rtt.c` 里给了一份**弱符号** `_sbrk` 兜底（直接失败，等于没有堆），
  你自己实现 `_sbrk` 时那份强符号会自动覆盖它。只想要零依赖就用 `rtt_write(level, "已经格式化好的串")`。

## 报错对照

| `stm32_rtt` 报什么 | 说明 |
|---|---|
| 控制块是空的（读到全 0） | 没调用 `rtt_init()`，或者固件停/reset 过还没跑到初始化那一行 |
| 魔数不符（不是 "SEGGER RTT"） | `addr` 指错了地址；用 `nm` 重新拿 |
| 连不上 RTT 通道 / 连接超时 | `rtt server start` 没起来（目标没跑起来、openocd 会话掉了），或端口被别的进程占了 |
| 端口占用 | `rttPort` 换一个（默认 9090） |
