---
name: Bug report
about: 某个工具报错、构建失败、板子行为跟预期不一样
title: "[bug] "
labels: bug
assignees: ''
---

<!-- 中文或英文都可以。请尽量把每一项都填上：STM32 上的失败几乎都出在环境差异上，
     而环境差异正是别人帮你看问题时最需要的信息。填不出来的项写「不清楚」即可，别删行。 -->

### 一句话概括

<!-- 例：stm32_flash 报 "No device found"，但 VS Code 里按 F5 能正常烧。 -->


### 影响范围

- [ ] 装不上 / 加载不了插件（dsh 启动报错、工具列表里没有 stm32_*）
- [ ] 找不到工具链（gcc / openocd / gdb-multiarch / CubeMX / java）
- [ ] 建工程（`stm32_project_create`）
- [ ] 生成代码（`stm32_generate`，CubeMX 侧）
- [ ] 改 .ioc（`stm32_ioc_inspect` / `ioc_plan` / `ioc_apply`）
- [ ] 写代码（`stm32_code_patch`）
- [ ] 编译（`stm32_build`）
- [ ] 烧录（`stm32_flash` / `/stm32-flash`）
- [ ] 调试（`stm32_debug_run` / `stm32_debug_session` / `stm32_debug_eval` / `stm32_debug_stop`）
- [ ] 读寄存器（`stm32_regs_read`）
- [ ] 斜杠命令本身（命令不出现在补全里、按下无反应）
- [ ] 其它

失败频率：必现 / 偶发（约几次一次）/ 只在某台机器上


### 环境

| 项 | 值 |
| --- | --- |
| dsh-stm32 版本（`package.json` 的 `version`） | 0.1.0 |
| 安装方式 | `link:` 本地路径 / `dsh plugin add dsh-stm32`（npm）/ `github:JingYu-er/dsh-stm32` / 其它 |
| dsh 版本 / 启动方式（桌面端 / `dsh web` / CLI） | |
| Windows 版本（`winver`） | |
| Node 版本（`node -v`） | |
| arm-none-eabi-gcc 版本（`arm-none-eabi-gcc --version` 第一行） | |
| openocd 版本（`openocd --version` 第一行） | |
| gdb-multiarch 路径 | |
| 探针型号 + 固件版本 | CMSIS-DAP（DAPLink FW …）/ ST-Link V2 / 其它 |
| 板子 + MCU | STM32F103C8T6（Blue Pill）/ 其它 |
| CubeMX 版本 + 固件包 | STM32CubeMX 6.x + STM32Cube FW_F1 V1.8.7 |
| 是否设过环境变量 `STM32_BIN_DIRS` / `STM32_CUBEMX_ROOT` | 没设 / 值= |
| USB 直连还是经 hub、线是否只供电 | |

### 复现步骤

1.
2.
3.

<!-- 能给出最小复现最好：一个空目录 + 几句 .ioc 描述，或者把工程压成 zip 去掉 Drivers/
     （它 65 MB，全是固件包里的原样拷贝，不必重新发明）。 -->

### 期望结果


### 实际结果


### 以前能跑吗（回归判断）

- [ ] 第一次用，从没成功过
- [ ] 以前能跑，最近才坏
- [ ] 不确定

如果「以前能跑」：最近改了什么？（在 CubeMX 里动过引脚/时钟、跑过 `stm32_generate`、
换过探针或 USB 口、给工程改名或换过路径、升级过插件/工具链……）


### 已经试过的排查

- [ ] 跑过 `stm32_doctor` / `/stm32-doctor`（输出贴在下面）
- [ ] 跑过 `/stm32-stop` 收掉残留调试会话
- [ ] 关掉 VS Code 的 cortex-debug 会话（它也会占探针）
- [ ] 删掉 `build/Debug` 重新编译
- [ ] 换 USB 口 / 换线 / 拔插探针
- [ ] 换了另一块板子或另一个探针试
- [ ] 看过 `.ioc` 里 PA13 / PA14 是否还是 Serial Wire
- [ ] 其它：

### `stm32_doctor` 的输出

<!-- 它一次给出工具链 7 项、残留 openocd/gdb 进程、端口 3333 占用、.elf、.ioc 警告，
     多数问题到这一步就能定位。原样贴，别只贴结论行。 -->

```text

```

### 出错工具的完整返回

<!-- 把工具返回原样贴上来（`ok` / `guard` / `message` / `errors` / `notes` / `args` 全都要），
     不要只贴最后一行报错——`notes` 里通常已经写了下一步怎么修。 -->

```json

```

### 相关日志

<!-- 按需贴，不用全给：
     - 构建失败：`stm32_build` 返回里的 errors，或 build/Debug 下 ninja 的尾部几十行
     - 烧录/调试失败：openocd 的 `** Programming Finished **` / `Error:` 行，或 gdb 的 `Remote connection closed`
     - CubeMX 卡住：`stm32_generate` 的 job 输出（冷启动 60–150 s 属正常） -->

```text

```

### 其它线索

- 烧录相关：工程里是否有 `openocd.cfg` 覆盖了探针配置（ST-Link 必须写，默认走 CMSIS-DAP 的 `interface/cmsis-dap.cfg` + `target/stm32f1x.cfg`）
- `.ioc` 相关：PA13 / PA14 是否仍是 Serial Wire（改成 No_Debug 生成的固件会把 SWD 关掉，之后只能靠 BOOT0 进系统 bootloader 救回来）；`ProjectManager.KeepUserCode` 是否为 true
- 是否手改过 CubeMX 生成区（`Core/Src/main.c` 的非 USER CODE 段、`cmake/stm32cubemx/CMakeLists.txt` 等）——下次 `stm32_generate` 会覆盖掉
- 是否新开了定时器 / 串口 / ADC —— 新外设的 HAL 源文件要手工加进 `cmake/stm32cubemx/CMakeLists.txt` 的 `STM32_Drivers_Src`，否则链接会报 undefined reference
- 是否跨机器 / 改名复制过工程（`build/CMakeCache.txt` 里记着旧路径，会出现「ninja 退出码 0 但跑的是旧固件」）
- 备份在哪：`stm32_generate` 与 `stm32_code_patch` 都会在工程下的 `.dsh-stm32/backups/<时间戳>/` 留一份，需要对比时可以用
- 屏幕截图 / 万用表实测（如果是「烧完了但灯不亮」这类硬件侧现象）

### 提交前确认

- [ ] 上面该贴的输出是原样贴的，没有裁剪
- [ ] 已经搜过 issues，没有重复
- [ ] 没有贴 token、私钥、内网地址等敏感信息
