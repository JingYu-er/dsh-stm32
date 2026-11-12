# RTT（Real Time Transfer）在 HAL 工程中的接入方式

本文件为说明文档，不含代码。HAL 工程由 CubeMX 生成，`Core/**` 属于生成区，向其中放入自定义 `.c` 文件会被后续 `stm32_generate` 覆盖，同时违反"只改 USER CODE"的红线。因此 RTT 源文件放在独立目录（默认 `App/`），仅通过 `cmake/user/CMakeLists.txt` 挂入构建。

寄存器版工程（`stm32_project_create route=register`）自带 `Core/Src/rtt.c` 与 `Core/Inc/rtt.h`，无需本文件。本文件仅针对 HAL 版。

所需两个源文件位于插件的 `templates/register/Core/Src/rtt.c` 与 `templates/register/Core/Inc/rtt.h`；两者实现一致（SEGGER 兼容控制块与通道 0 的 `[4B 长度 LE][1B 级别][8B 时间戳 ms LE][UTF-8 payload]` 帧）。

## 三个步骤

1) 拷贝文件（在工程根目录执行）：

```bash
mkdir -p App
cp <插件目录>/templates/register/Core/Src/rtt.c App/rtt.c
cp <插件目录>/templates/register/Core/Inc/rtt.h App/rtt.h
```

2) 挂入构建——编辑 `cmake/user/CMakeLists.txt`（CubeMX 不生成该文件的内容）：

```cmake
target_sources(${CMAKE_PROJECT_NAME} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../../App/rtt.c)
target_include_directories(${CMAKE_PROJECT_NAME} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../../App)
```

3) 在 `Core/Src/main.c` 中仅修改 USER CODE 块：

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

主循环同理，写入 `USER CODE BEGIN WHILE` 与 `USER CODE END WHILE` 之间。

## 宿主侧读取方式

```bash
arm-none-eabi-nm build/<preset>/<工程名>.elf | findstr _SEGGER_RTT   # 控制块地址
```

```
stm32_rtt action=start addr=0x2000xxxx    # openocd: rtt setup <addr> 0x400 / rtt start / rtt server start <port> 0
stm32_rtt action=dump seconds=3 level=3  # 打印 {t, level, text}，level 为"保留到哪一级"的上限
stm32_rtt action=stop
```

`addr` 不要写死：控制块是普通 `.bss` 变量，增加一行代码并重新链接后地址会漂移，每次用 `nm` 重新获取。

## 代价与限制

- 默认 `RTT_UP_CHANNELS=3`、`RTT_BUF_SIZE=1024` → **3 KB RAM**（.bss）；`RTT_MSG_MAX=120` 为单条 payload 上限。RAM 紧张时修改 `rtt.h` 的这两个宏（例如 1 个通道 512 字节）。
- 工具链启用 `--gc-sections`：未调用 `rtt_init()` 时，`rtt.c` 的代码与该缓冲会被链接器丢弃，不占 RAM/Flash。
- 环满时**整条丢弃**（不阻塞、不覆盖尚未读走的数据），`rtt_dropped_count()` 可查看丢弃条数；建议按模板在周期日志中输出 `drop=%u`，否则丢帧不可见。
- 容量：可容纳条数 = `RTT_BUF_SIZE` ÷ 单条帧字节数（`13 + 正文长度`），1024 缓冲 + 80 字节正文 ≈ 12 条；可维持时长 = 条数 × 打印间隔（200 ms 一条 ≈ 2.4 s）。掉电前需要保留的关键日志不应依赖环缓冲。
- `WrOff`/`RdOff` 必须始终落在 `[0, RTT_BUF_SIZE)`：早期模板曾发布 `WrOff` 只增不减的版本，越界后 openocd 无法计算剩余容量且不再推进 `RdOff`，环缓冲写满一次后永久冻结（现象：每次 dump 返回相同字节、重复记录刷屏、`drop` 持续增长）。现已在 `rtt_ring_write()` 中回绕，并按环长计算 `used`。
- **RTT 不是 SWO**：openocd 通过 SWD 读取目标 RAM 中的环缓冲，不占用 ITM/引脚，也与中断优先级无关（修改 SysTick 优先级不会改变是否丢帧）。
- 时间戳默认使用 DWT 周期计数器；已有 `HAL_GetTick()` 时可覆盖弱符号：

```c
uint64_t rtt_time_ms(void) { return (uint64_t)HAL_GetTick(); }
```

- 主循环与中断均可写入：`rtt_write()` 内部已进入临界区（`rtt_lock()`/`rtt_unlock()` 弱符号，默认保存并恢复 PRIMASK），无需在调用处关闭中断。
- 使用 RTOS 时覆盖上述两个弱符号即可（`rtt.h` 头注释中有 FreeRTOS 示例）：以 mutex 包裹并在内部关闭中断，裸机与 RTOS 均可使用。
- `rtt_printf()` 使用 newlib 的 `vsnprintf`，会引入 `_sbrk`。HAL 工程自带 `Core/Src/syscalls.c`，无需处理；寄存器版没有 syscalls.c，`rtt.c` 中提供弱符号 `_sbrk` 回退（直接失败，等同于无堆），自行实现 `_sbrk` 时该强符号会自动覆盖。若需零依赖，使用 `rtt_write(level, "已格式化的字符串")`。

## 报错对照

| `stm32_rtt` 报什么 | 说明 |
|---|---|
| 控制块是空的（读到全 0） | 未调用 `rtt_init()`，或固件处于停止/复位状态且尚未执行到初始化 |
| 魔数不符（不是 "SEGGER RTT"） | `addr` 指向了错误地址；用 `nm` 重新获取 |
| 连不上 RTT 通道 / 连接超时 | `rtt server start` 未启动（目标未运行、openocd 会话中断），或端口被其它进程占用 |
| 端口占用 | `rttPort` 更换一个（默认 9090） |
