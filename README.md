# dsh-stm32

> 让 DSH 接管 STM32F103C8T6 的整条开发链：探测工具链 → 建工程 → 改 .ioc → 生成代码 → 编译 → 调试 → 烧录。

**English:** STM32F103C8T6 toolchain for DeepSeek Harness — probe the toolchain, scaffold a CMake project, edit .ioc as a transaction, build, flash without starting a debug session, and debug only when you ask for it.

[English](./README_EN.md) · [快速开始](#快速开始最小验证空目录到灯在闪) · [功能一览](#功能一览) · [工具参考](#工具参考) · [斜杠命令](#斜杠命令) · [设计要点](#设计要点) · [已知限制](#已知限制) · [排错](#排错) · [规格书](docs/dsh-stm32-plugin-规格.md)

[![GitHub stars](https://img.shields.io/github/stars/JingYu-er/dsh-stm32?color=4a6cf7)](https://github.com/JingYu-er/dsh-stm32)
[![license](https://img.shields.io/github/license/JingYu-er/dsh-stm32)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-4a6cf7)](#已知限制)
[![MCU](https://img.shields.io/badge/MCU-STM32F103C8T6-4a6cf7)](#已知限制)
[![version](https://img.shields.io/badge/version-0.1.0-orange)](https://github.com/JingYu-er/dsh-stm32/releases)

这是一个 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) **插件**：注册 15 个工具、5 条斜杠命令和 1 个随插件下发的 SKILL，让模型能直接探测工具链、建cubemx cmake工程、改 `.ioc`、跑 CubeMX、编译、烧录和调试，烧完再把寄存器里的状态读回来确认——实现更彻底的面向DSH硬件编程。

## 为什么需要它

大多数「让 AI 帮忙写 STM32」的做法停在代码层：它给你一段 `main.c`，至于这段代码能不能编译、烧进去灯到底闪没闪，还是你自己开 CubeMX、切终端、按 F5。**模型看不到板子，也就没法对自己的代码负责。**

这个插件把硬件侧也接到 DSH 上：`.ioc` 能读能改（事务 + 回滚）、代码落在 `USER CODE` 块里、生成和编译能拿到真实的报错行、烧录是一条**不经过调试器**的独立路径、烧完还能用寄存器把状态读回来。每一步都返回结构化证据（`planId`、`file:line:col`、`Verified OK`、`GPIOC_ODR` 的 bit13），模型据此决定下一步，而不是猜。

这就是「更彻底的面向 DSH 硬件编程」：**模型不只是写代码——它能把代码烧进板子，再把板子上的状态从寄存器里读回来跟自己的预期对账。**

| 环节 | 以前（手写 + CubeMX GUI） | 现在（DSH 全流程） |
| --- | --- | --- |
| 建工程 | GUI 里点时钟树、引脚、工程设置，生成 CMake，再手写 `launch.json` | 一句话：`stm32_project_create` 2 s 出模板工程（与 GUI 产物逐字节一致），`.vscode` 里两份配置已就位 |
| 改配置 | GUI 里改完重新生成，祈祷 USER CODE 不丢 | `stm32_ioc_plan` 先给 diff（不动源文件）→ 你点头 → `stm32_ioc_apply` 带 SHA 校验、备份、失败回滚 |
| 写代码 | 整文件编辑，一不小心写进生成区，重新生成就没了 | `stm32_code_patch` 只写 `USER CODE` 块，块外逐字节不动 |
| 编译 | 使用keil编译或使用vscode插件编写cmake文件 | DSH 通过/stm32-build [dir] [--clean] 自动编译 |
| 烧录 | 使用keil烧录或自己写 `tasks.json` 调 openocd | DSH 通过/stm32-debug [dir]自动烧录 |
| 验证 | 断点调试，自己查看寄存器的值 | 烧完用 `stm32_regs_read` 把状态读回来：`GPIOC_ODR` 两次采样看计数器递增，`AFIO_MAPR` 确认 SWD 没被固件关掉 |
| 调试 | `F5` + 手动下断点、看完再关会话 | `stm32_debug_run` 停在 `main` 抓一次现场即释放；要连续调才开 `stm32_debug_session`，空闲自动关 |


## 安装

### 前置条件

| 依赖 | 用途 | 缺了会怎样 |
| --- | --- | --- |
| dsh（能加载 bundle 层） | 宿主 | 插件不会被加载 |
| Node ≥ 20 | 构建 / 测试 | `npm run build` 失败 |
| `arm-none-eabi-gcc`、`arm-none-eabi-gdb`（或 `gdb-multiarch`） | 编译 / 调试 | `stm32_doctor` 逐个提示缺哪个、去哪装 |
| `openocd` | 烧录 / 调试 | 烧录与调试不可用，只读工具照常 |
| `cmake` + `ninja` | 构建 | `stm32_build` 失败 |
| STM32CubeMX（含内置 JRE） | `stm32_generate`、`stm32_project_create` | 生成类工具不可用，其余照常 |
| STM32Cube 固件包 F1（随 CubeMX 装） | 建骨架时抄 Drivers | 报「找不到固件包」 |

默认按 MSYS2（`D:/app/msys64/ucrt64/bin`、`C:/msys64/ucrt64/bin`）→ ST 官方包搜索，CubeMX 默认 `D:/app/STM32CubeMX`；装在别处用环境变量覆盖（见 [配置](#配置)）。

### 从 GitHub 安装

```powershell
git clone https://github.com/JingYu-er/dsh-stm32.git
cd dsh-stm32
npm install --no-audit --no-fund   # 只装 typescript
npm run build                       # tsc -> lib/
npm test                            # 可选：80 个离线用例，不需要板子
```

挂进 dsh 的 profile——**必须用 `link:`，不要用 `file:`**：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add "link:D:\path\to\dsh-stm32"

# 然后在同一目录的 package.json 里，把 "dsh-stm32" 加到 dsh.profile.bundles 数组末尾
# 最后重启 dsh（bundle 层只在进程启动时加载）
```

> **为什么必须 `link:`**：pnpm 在 `nodeLinker: hoisted` 下会把 `file:` 依赖复制成真实目录，之后你重新 `tsc` 出的 `lib/` 宿主读不到——表现为"改完代码、重启还是旧行为"。用 `link:` 时 `lib/` 是实时读的，但**仍然要重启 dsh** 才会重新加载插件。

安装成功的判断：重启后输入 `/stm32-doctor` 有输出，或让模型调 `stm32_doctor`。

> npm 包尚未发布。发布后可直接 `dsh plugin --profile desktop add dsh-stm32`，不必再克隆。

**卸载**：从 `package.json` 的 `dsh.profile.bundles` 删掉 `dsh-stm32`，再 `pnpm remove dsh-stm32`，重启 dsh。

## 快速开始：最小验证（空目录到灯在闪）

下面这条链在真板上跑通过（A1 验收，2026-10-22），全程由模型调用工具完成。注意它只是**最小验证**——每一步用的都是同一套工具，闪灯只是最省的样例：

| 步 | 做什么 | 工具 | 实测耗时 |
| --- | --- | --- | --- |
| 1 | 体检：工具链、被占用的探针、端口、`.elf`、`.ioc` 告警 | `stm32_doctor` | ~2 s |
| 2 | 空目录建 CMake 工程骨架（14 个模板文件 + 629 个固件文件 + 配好 SWD 的 `.ioc`） | `stm32_project_create` | ~2 s |
| 3 | 按 `.ioc` 无头跑 CubeMX，产物落到 `Core/` | `stm32_generate` | 61–77 s |
| 4 | 编译（首次自动 `cmake --preset`） | `stm32_build` | 配置 ~5 s + 编译 3 s |
| 5 | **只烧录**：program + verify + reset | `stm32_flash` | 2.1–2.6 s |
| 6 | 读回 `GPIOC_ODR`，确认状态确实在翻 | `stm32_regs_read` | 0.4–1.3 s |

模型侧就是一句话：「在 `D:\work\blink` 建一个 STM32F103C8T6 的闪灯工程，编译并烧进去」。想自己敲就：

```text
/stm32-doctor         # 开工前体检
/stm32-build          # 编译，打印内存占用与错误
/stm32-flash          # 只烧录，不进调试会话
/stm32-debug          # 烧录 + 停在 main
/stm32-stop           # 关掉调试会话，把探针还给 VS Code
```

### 这只是最小验证，不是能力上限

闪灯是这条链的**最小 smoke test**：它把「建工程 → 生成 → 编译 → 烧录 → 读回状态」每一步走了一遍，用的都是同一套工具，没有一步是闪灯专用的。真实项目走的是同一条链，区别只在 `.ioc` 里多几个外设、`USER CODE` 多几个块、代码更长：

| 完整项目里要做的事 | 走哪条路径 | 上板实测情况 |
| --- | --- | --- |
| 外设配置：GPIO / 定时器 / USART / I2C / SPI / ADC / DMA / 中断 | `stm32_ioc_plan` 改 `.ioc`（GPIO 按芯片引脚表校验，外设写 `Mcu.IP*` / `Periph.*` 键）→ `stm32_ioc_apply` → `stm32_generate` | GPIO、时钟、SWD 已实测；其他外设同一机制，未逐个实测 |
| 新增外设后补 HAL 源 | 在 `cmake/stm32cubemx/CMakeLists.txt` 的 `STM32_Drivers_Src` 里加 `stm32f1xx_hal_<外设>.c`，或写进 `cmake/user/CMakeLists.txt` | **这一步要手工补**：插件只落位 `Src/` 与 `Inc/`，CubeMX 生成的 `cmake/**` 不搬 |
| 多源文件、自己写的模块 | 写进 `cmake/user/CMakeLists.txt`，模板已留好位置 | 位置就位；未单独实测 |
| 业务代码 | `stm32_code_patch` 按块写入，重新生成时按标签搬回 | 已实测（append / replace / 标签写错会列出全部可用标签） |
| 调参数、改时钟 | `.ioc` 事务：先 diff → SHA 校验 → 备份 → 失败回滚 | 已实测 |
| 烧完确认外设真的在动 | `stm32_regs_read` 读任意外设寄存器（`TIM2_CNT`、`USART1_SR`、`ADC1_DR`…），或 `stm32_debug_eval` 读变量 | 按物理地址读寄存器已实测（`GPIOC_ODR` / `AFIO_MAPR`） |
| 出问题要看现场 | `stm32_debug_run` 停在 `main` 抓一次；要连续调就开 `stm32_debug_session` + `stm32_debug_eval` | 已实测（停在 `main () at main.c:67`） |

所以闪灯是验收用的最小样例，不是这套工具的能力上限：**它覆盖的是整条工程链，而不是一个 demo。** 真正的边界在[已知限制](#已知限制)里——芯片只支持 F103C8T6、宿主只在 Windows 上验证、探针默认 CMSIS-DAP，以及上面那条「新增外设要手工补 HAL 源」。外设种类本身不受工具限制：`.ioc` 里配得出来的，生成、编译、烧录、读回都走同一条链；只是除闪灯外还没有逐项上板实测，正式开项目前先跑一遍 `stm32_doctor`。

## 功能一览

| 能力 | 提供方式 |
| --- | --- |
| 环境体检 | `stm32_env_probe`（只读）、`stm32_doctor`（工具链 + 探针占用 + 端口 + 工程告警） |
| 从零建工程 | `stm32_project_create`：模板快照 + 固件包 Drivers，与 CubeMX GUI 新建的工程逐字节一致 |
| `.ioc` 事务 | `stm32_ioc_inspect`（只读解析）→ `stm32_ioc_plan`（算 diff，不写盘）→ `stm32_ioc_apply`（SHA 校验 + 备份 + 回滚） |
| 只改 USER CODE | `stm32_code_patch`：只写 `/* USER CODE BEGIN X */` 与 `END X` 之间，块外逐字节不动 |
| 生成代码 | `stm32_generate`：无头 CubeMX + 按 ST 结构落位 + USER CODE 按标签搬回 |
| 编译 | `stm32_build`：构建目录与 `.elf` 自动推断、错误去重、链接后解析 RAM/FLASH 占用 |
| 烧录 | `stm32_flash`：openocd `program verify reset exit`，烧完释放探针；烧前检查 `.ioc` 是否开了 Serial Wire |
| 调试 | `stm32_debug_run` / `stm32_debug_session` / `stm32_debug_eval` / `stm32_debug_stop` |
| 验证"真的在跑" | `stm32_regs_read`：按物理地址把任意外设寄存器读回来，halt 读值后 `resume`，不复位芯片 |
| 给模型的工作纪律 | 随插件下发 SKILL `stm32-workflow`（只改 USER CODE、不动生成区、烧录与调试分开、结论要带寄存器证据） |

## 工具参考

### 环境与工程

| 工具 | 作用 |
| --- | --- |
| `stm32_env_probe` | 探测 gcc / gdb / openocd / cmake / ninja / CubeMX / JRE 的路径与版本，缺什么给安装提示。只读、可重复调 |
| `stm32_doctor` | 一次回答三件事：工具链齐不齐、探针被谁占（`openocd.exe` / gdb 进程 / 3333 端口）、这个工程能不能烧 |
| `stm32_project_create` | 空目录 → 完整 CMake 工程（含 `.vscode` 里"① 只烧录 / ② 烧录并调试"两份配置）。目标目录非空默认拒绝，`overwrite: true` 才覆盖 |

### .ioc：只读与事务

| 工具 | 作用 |
| --- | --- |
| `stm32_ioc_inspect` | 解析 MCU 型号、引脚/信号/标签、外设与中断、时钟树、工程设置；会报「没开 Serial Wire 会生成 `SWJ_DISABLE`」这类致命风险 |
| `stm32_ioc_plan` | 改 `.ioc` 的第一步：算出逐键 diff 与源 SHA-256，返回 `planId`，**不动源文件**。支持改键、删键、按引脚表加 GPIO、一键补 Serial Wire |
| `stm32_ioc_apply` | 必须带 `planId`；写盘前再核 SHA（中途被手改就拒绝），备份后原子替换，写完重新解析校验，不过自动回滚。支持 `rollbackFrom` |

### 代码与构建

| 工具 | 作用 |
| --- | --- |
| `stm32_code_patch` | 只在 `USER CODE` 块内 replace/append；块外字节（含 CRLF）原样保留；写前备份、临时文件 + rename 原子替换。标签写错会把该文件所有可用标签列给你 |
| `stm32_generate` | 无头跑 `java -jar STM32CubeMX.exe -q`，成功后落位到 `Core/Src`、`Core/Inc`，旧文件的 USER CODE 按标签搬进新内容。默认后台 job |
| `stm32_build` | `cmake --build`，构建目录从 `CMakePresets.json` 与 `build/*/CMakeCache.txt` 推断；首次构建自动 configure；会拦住"CMakeCache 目录不一致但 ninja 退出码 0"的假成功 |

### 烧录与调试

| 工具 | 作用 |
| --- | --- |
| `stm32_flash` | **烧录**：openocd `program verify reset exit`，不建调试会话、不停 `main`。烧前读 `.ioc`，调试口没开就拒绝（见 [设计要点](#设计要点)） |
| `stm32_debug_run` | 起 openocd + gdb，`break main` → `continue` → 抓 pc/sp/lr/bt/locals → `reset run` + `detach`，不写 Flash、不常驻 |
| `stm32_debug_session` | 常驻 openocd 会话（`.elf` 自动解析），空闲 90 s 自动关、硬上限 10 min |
| `stm32_debug_eval` | 在会话里执行 gdb 命令或读表达式（如 `g_led_blink_count`），读完立刻 `resume` + `detach` |
| `stm32_debug_stop` | 立刻释放探针，幂等 |
| `stm32_regs_read` | 读 `GPIOC_ODR`、`AFIO_MAPR` 等物理地址；收尾用 `resume` 而不是 `reset run`，避免读一眼就把固件状态清零 |

## 斜杠命令

工具是给模型调的；你要自己动手时用命令，一条命令一个动作，不经过模型决策。

| 命令 | 做什么 | 会不会动板子 |
| --- | --- | --- |
| `/stm32-doctor` | 体检：工具链、被占用的调试进程、端口、`.elf`、`.ioc` 告警 | 否 |
| `/stm32-build [dir] [--clean]` | 编译，打印内存占用 / `.elf` / 错误 | 否 |
| `/stm32-flash [dir]` | **烧录**：program + verify + reset，不建调试会话、不下断点 | 是 |
| `/stm32-debug [dir]` | **烧录 + 调试**：烧完停到 `main`，会话保留（空闲 3 分钟 / 上限 10 分钟，本轮结束也会自动关） | 是 |
| `/stm32-stop` | 关掉 `/stm32-debug` 开的会话，把探针还给 VS Code | 否 |

`[dir]` 省略时用当前会话的工作目录。

## 设计要点

- **烧录与调试是两条路。** `stm32_flash` 只用 openocd 的 `program/verify/reset/exit`，成功证据是日志里出现 `** Programming Finished **` 与 `** Verified OK **`，不是"没报错"。
- **只写 USER CODE。** 改逻辑用 `stm32_code_patch`；`stm32_generate` 重新生成时按标签把旧内容搬回新文件，所以手改生成区或整文件重写在重新生成后都会丢。
- **`.ioc` 是事务。** `plan` 只算 diff 出 `planId`，`apply` 才写盘，写前核 SHA、写后重新解析、失败回滚。
- **烧前守卫。** 如果 `.ioc` 的 SYS 调试口不是 Serial Wire（PA13/PA14 缺失或被设成 `No_Debug`），CubeMX 会生成 `__HAL_AFIO_REMAP_SWJ_DISABLE()`——烧进去 SWD 立刻失联，只能 BOOT0 救砖。这种工程 `stm32_flash` 直接拒绝；确实要烧得显式传 `allowNoDebug: true`。
- **探针只有一块。** 烧录、调试、后台会话同一时刻只能有一个；`build` / `flash` / `debug_run` / `generate` 开跑前会先把占着探针的会话关掉。

## 配置

### 环境变量（可选）

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `STM32_BIN_DIRS` | 工具链目录候选，`;` 分隔，优先于内置列表 | `D:/app/msys64/ucrt64/bin`、`C:/msys64/ucrt64/bin`、`C:/msys64/mingw64/bin` |
| `STM32_CUBEMX_ROOT` | STM32CubeMX 安装根目录 | `D:/app/STM32CubeMX`、`C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeMX` |
| `DSH_STM32_E2E_PROJECT` | 真机 e2e 用的工程（含 `openocd.cfg` 与 `build/Debug/*.elf`） | 无 |
| `DSH_STM32_E2E_ROOT` | e2e 临时副本目录 | 系统临时目录 |

也可以按调用传参：烧录/调试类工具都接受 `binDirs`、`elfPath`、`buildDir`、`configFile`、`adapterSpeed`；生成/建工程类接受 `cubeMxRoots`、`firmwarePackage`。

### openocd.cfg（工程内，优先于内置回退）

CMSIS-DAP（默认）：

```text
source [find interface/cmsis-dap.cfg]
source [find target/stm32f1x.cfg]
adapter speed 4000
```

ST-Link（换成你的探针）：

```text
source [find interface/stlink.cfg]
transport select hla_swd
source [find target/stm32f1x.cfg]
```

没有 `openocd.cfg` 时回退 `interface/cmsis-dap.cfg` + `target/stm32f1x.cfg`。ST-Link 用户请把上面第二段写进工程根目录的 `openocd.cfg`。

### .ioc 的两个硬要求

1. **SYS 调试口必须是 Serial Wire**（PA13 = `SYS_JTMS-SWDIO`、PA14 = `SYS_JTCK-SWCLK`）；没有就用 `stm32_ioc_plan` 的 `serialWire: true` 补上。
2. **`ProjectManager.KeepUserCode=true`**；否则重新生成时 USER CODE 不会被保留。

## 已知限制

| 限制 | 说明 | 有没有办法 |
| --- | --- | --- |
| 只在 **Windows** 上验证 | `stm32_generate` 依赖 `<CubeMX>/STM32CubeMX.exe` + `jre/bin/java.exe`，Linux/macOS 上的 CubeMX 不是这个形态 | 暂无；烧录/调试/读寄存器在 Linux 上若 openocd 与 gdb 齐全可能可用，但未验证 |
| 只支持 **STM32F103C8T6** | 引脚表、`.ioc` 引脚校验、链接脚本模板都按 64 KiB Flash / 20 KiB RAM 的 C8T6 写 | 换芯片要改 `src/data/chips.ts` 与 `templates/` |
| 默认探针是 **CMSIS-DAP** | 没有 `openocd.cfg` 时回退 cmsis-dap | 用 `openocd.cfg` 换 `interface/stlink.cfg`（见上） |
| 新增外设要**手工补 HAL 源** | 插件只落位 CubeMX 的 `Src/` 与 `Inc/`（→ `Core/Src`、`Core/Inc`），CubeMX 生成的 `cmake/stm32cubemx/CMakeLists.txt` 不搬；开了定时器/串口/ADC 之后要自己把 `stm32f1xx_hal_<外设>.c` 加进源清单 | 改工程里 `cmake/stm32cubemx/CMakeLists.txt` 的 `STM32_Drivers_Src`，或写进 `cmake/user/CMakeLists.txt` 的 `target_sources` |
| 生成/建工程需要 **CubeMX + F1 固件包** | 固件包版本默认 `STM32Cube_FW_F1_V1.8.7` | 换版本传 `firmwarePackage` |
| 未在别人的机器上验证 | 本机：Windows 10 + MSYS2 UCRT64 + DAPLink + 蓝丸；其余组合靠反馈 | 遇到问题请附 `stm32_doctor` 的完整输出开 issue |

## 排错

| 现象 | 原因与处理 |
| --- | --- |
| 烧完连不上、SWD 失联 | 固件里生成了 `__HAL_AFIO_REMAP_SWJ_DISABLE()`。按住 BOOT0 上电进系统 bootloader 重烧，然后把 SYS 设回 Serial Wire——`stm32_flash` 现在会先拦这种情况 |
| `Error: No device found` / `transfer count mismatch` | 探针被别的进程占着。先 `/stm32-stop`，再用 `stm32_doctor` 看 openocd / gdb 进程与 3333 端口 |
| 编译"成功"但跑的是旧固件 | 复制或改名过带 `build/` 的工程：CMakeCache 里的目录对不上，ninja 仍退出 0。`stm32_build` 会判失败；按提示 clean 或删 `build/Debug` |
| `stm32_doctor` 说找不到 gcc / openocd | 装上后设 `STM32_BIN_DIRS`，或给工具传 `binDirs`；`stm32_env_probe` 会给出每个组件缺什么 |
| `stm32_generate` 很慢或像卡住 | CubeMX 冷启动 60–150 s 属正常；默认后台 job，用 `job_output` 看进度，或传 `foreground: true` 同步等 |
| `stm32_code_patch` 说块不存在 | `main.c` 里是短标签（`PV`=私有变量、`PFP`=函数原型、`2`=while 前初始化、`3`=循环体）；报错会列出该文件全部可用标签，照抄即可 |

## 开发与测试

```powershell
npm run build            # tsc -> lib/
npm test                 # 10 个离线套件、80 个用例，不需要板子 / CubeMX / 工具链
```

CI（`.github/workflows/ci.yml`）在每次 push / PR 上跑 `npm ci → build → 80 个用例`（windows-latest）。

真机 e2e 会写板子，需要你指一个能构建的工程：

```powershell
$env:DSH_STM32_E2E_PROJECT = 'D:\work\my-stm32'
node test\e2e-flash.mjs
```

分档与每个脚本的用途见 [开发笔记](docs/development-notes.md)。

## 目录结构

```text
src/
  index.ts                 插件入口（name / inject / apply）
  tools/                   15 个工具的 L3 层（参数 schema + 输出契约 + 渲染）
  engine/                  纯逻辑与工作流（generate / build / flash / debug / ioc / scaffold …）
  commands/register.ts     5 条斜杠命令
  skill/stm32-workflow.ts  随插件下发的 SKILL
  data/                    路径与芯片数据（路径是数据不是逻辑）
templates/scaffold/        建工程用的模板快照（CMake / .ld / .vscode / .ioc）
test/                      离线套件 + fixtures + 真机 e2e
docs/                      规格书 + 开发笔记
```

## 文档

- [规格书](docs/dsh-stm32-plugin-规格.md)：工具契约、状态机、验收 A1–A13 的判定标准
- [开发笔记](docs/development-notes.md)：里程碑、宿主契约踩坑、每个工具的实现细节与实测数据

## 许可证

[MIT](LICENSE)
