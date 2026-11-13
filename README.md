# dsh-stm32

[![GitHub stars](https://img.shields.io/github/stars/JingYu-er/dsh-stm32?color=4a6cf7)](https://github.com/JingYu-er/dsh-stm32)
[![license](https://img.shields.io/github/license/JingYu-er/dsh-stm32)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-4a6cf7)](#已知限制)
[![MCU](https://img.shields.io/badge/MCU-STM32%20family-4a6cf7)](#已知限制)
[![version](https://img.shields.io/badge/version-0.1.8-orange)](https://github.com/JingYu-er/dsh-stm32/releases)

STM32 全流程工具层，以 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件形式分发：25 个工具、7 条斜杠命令与 1 个随包下发的 SKILL，把「工具链探测 → 建工程 → 改 `.ioc`（含时钟）→ 生成代码 → 编译 → 烧录 → 调试 → 回读寄存器」这条链交给模型执行，另含串口交互（Windows）与会话内的「调试台」面板。

在支持范围内，同一套工具从 F1 到 H7 用法一致；遇到不支持的芯片或功能，调用时会直接说明缺什么，不会给出一份猜出来的结果。

| 能力面 | 覆盖范围 |
| --- | --- |
| 芯片族 | 27 个族：C0 / F0 / F1 / F2 / F3 / F4 / F7 / G0 / G4 / H5 / H7 / L0 / L1 / L4 / L4+ / L5 / MP1 / MP2 / N6 / U0 / U3 / U5 / WB / WB0 / WBA / WL / WL3 |
| HAL 建工程 | 21 个单核族：C0 / F0 / F1 / F2 / F3 / F4 / F7 / G0 / G4 / H5 / H7 / L0 / L1 / L4 / L4+ / L5 / U0 / U3 / U5 / WBA / WL |
| 寄存器建工程 | 21 族，均通过 create→build 编译矩阵 |
| 时钟规划 | 18 族；其中 PLL1 为 H5 / U5 / WBA / L4+ |
| `.ioc` 外设预设 | 按 CubeMX 官方数据派生：串口 / TIM PWM / ADC |
| 寄存器名与位域 | F1 |

**English:** [README_EN.md](./README_EN.md)

[快速开始](#快速开始最小验证空目录到灯在闪) · [工具参考](#工具参考) · [斜杠命令](#斜杠命令) · [调试台](#调试台面板) · [配置](#配置) · [已知限制](#已知限制) · [排错](#排错) · [规格书](docs/dsh-stm32-plugin-规格.md)

## 它能做什么

多数「让 AI 编写 STM32 代码」的方案止于代码层：产出一段 `main.c`，能否编译、烧录后灯是否按预期闪烁，仍要在 CubeMX、终端与调试器之间手工确认。模型看不到板子，也就无法对结果负责。

本插件把硬件侧接入 DSH：`.ioc` 可读可改（事务 + 回滚），代码只写入 `USER CODE` 块，生成与编译返回真实报错行，烧录不与调试器抢占探针，烧录后读回寄存器状态。每一步都有可核对的结果（计划编号、`文件:行:列`、`Verified OK`、`GPIOC.ODR` 的 bit13，有寄存器表时直接给出 `ODR13=1`），模型据此决定下一步。

| 环节 | 手工流程 | 本插件 |
| --- | --- | --- |
| 建工程 | GUI 配置时钟树、引脚与工程参数，生成 CMake，手写 `launch.json` | `stm32_project_create` 约 2 秒产出模板工程（与 CubeMX GUI 产物一致，`.vscode` 内两份配置就位） |
| 改配置 | GUI 修改后重新生成，担心 `USER CODE` 丢失 | `stm32_ioc_plan` 先出差异（不写盘）→ 确认 → `stm32_ioc_apply` 带校验、备份与失败回滚 |
| 写代码 | 整文件编辑，易写入生成区，重新生成后丢失 | `stm32_code_patch` 只写 `USER CODE` 块，块外逐字节保留 |
| 编译 | Keil，或自行维护 CMake 与 VS Code 任务 | `/stm32-build [目录] [--clean]` |
| 烧录 | Keil，或手写 `tasks.json` 调 openocd | `/stm32-flash [目录]` |
| 验证 | 断点调试，手工查看寄存器 | `stm32_regs_read` 回读状态：`GPIOC.ODR` 两次采样确认计数递增，`AFIO.MAPR` 确认 SWD 未被固件关闭 |
| 调试 | 按 F5 手动下断点，结束再关会话 | `stm32_debug_run` 停在 `main` 抓取一次现场后释放探针；连续调试才开 `stm32_debug_session`，空闲自动关闭 |

## 安装

### 安装插件

只需先具备 DSH 本体，工具链可以稍后补。

```powershell
dsh plugin --profile desktop add dsh-stm32
```

`dsh plugin` 等价于在 profile 目录执行 `pnpm add`，并把 `dsh-stm32` 写入该 profile 的 `dsh.profile.bundles`。安装后完全退出 DSH 再启动（插件层只在进程启动时加载）。

- 校验：`dsh plugin --profile desktop why dsh-stm32` 显示 `0.1.8`
- 卸载：`dsh plugin --profile desktop remove dsh-stm32`，随后重启 DSH
- 装到 Web：把 `desktop` 换成 `web`

### 补齐工具链

插件装好后即可解析 `.ioc`、查看引脚 / 时钟 / 中断、预览计划；真正编译、烧录、调试时才需要编译器与探针工具。

| 要做什么 | 需要什么 | 怎么补 |
| --- | --- | --- |
| 编译 | `arm-none-eabi-gcc`、`cmake`、`ninja` | `/stm32-setup` 一条命令装齐（MSYS2 + 工具链，约 300 MB），或自行安装后由插件自动发现 |
| 烧录、调试 | `openocd`、`arm-none-eabi-gdb`（或 `gdb-multiarch`）、CMSIS-DAP / ST-Link 探针 | 同上；探针驱动由系统识别，无需额外配置 |
| 生成代码、建 HAL 工程 | STM32CubeMX（含内置 JRE）与其固件包 | 从 ST 官网安装 CubeMX（需 ST 账号），插件自动定位安装位置；固件包在 CubeMX 包管理器内安装 |

不确定缺什么时，先看诊断：

```text
/stm32-env      # 编译 / 烧录 / 调试 / 生成四项能力逐项列出缺件、安装位置与安装方式
/stm32-setup    # 先出计划，确认后执行安装，结束后自检
```

`/stm32-env` 在没有装任何工具链时也能用：它只执行版本查询，不写盘、不联网。

### 开工前检查

```text
/stm32-doctor
```

只读体检：工具链是否齐备、是否有残留的 openocd / gdb 进程占用探针、gdb 端口是否被占用、工程内 `.elf` 与 `.ioc` 是否就位、`.ioc` 是否存在会导致烧录后失联的配置。

### 内置资源

芯片型号到启动文件、设备宏、Flash / RAM 容量的映射，以及 `.ioc` 模板、链接脚本与寄存器表，随插件一起分发，安装后离线可用，不需要下载资源包。`stm32_assets verify` 校验完整性；报缺文件时按提示重装插件即可。

### 从源码安装

仅开发或需要改代码时使用。`npm install` 与 `npm run build` 的说明见[开发与测试](#开发与测试)。

```powershell
git clone https://github.com/JingYu-er/dsh-stm32.git
cd dsh-stm32
npm install --no-audit --no-fund   # 仅安装 typescript
npm run build                      # tsc -> lib/，提交前必须执行
```

挂载到 profile 时用 `link:`，不要用 `file:`：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add "link:D:\path\to\dsh-stm32"

# 在同一目录的 package.json 中把 "dsh-stm32" 追加到 dsh.profile.bundles
# 随后重启 dsh（插件层只在进程启动时加载）
```

原因：`nodeLinker: hoisted` 下 `file:` 会被复制成真实目录，重新编译出的 `lib/` 不会被宿主读取，表现为「改完代码、重启仍为旧行为」。`link:` 读取工作区里的 `lib/`，改完仍需重启 DSH 重新加载。

## 快速开始：最小验证（空目录到灯在闪）

这条链路已在真板验证，全程由模型调用工具完成。各步使用同一套工具，闪灯只是最小样例。

| 步 | 动作 | 工具 | 实测耗时 |
| --- | --- | --- | --- |
| 1 | 体检：工具链、被占用探针、端口、`.elf`、`.ioc` 告警 | `stm32_doctor` | 约 2 秒 |
| 2 | 空目录建 CMake 工程骨架（含已配置 SWD 的 `.ioc`） | `stm32_project_create` | 约 2 秒 |
| 3 | 按 `.ioc` 无头运行 CubeMX，产物落到 `Core/` | `stm32_generate` | 首次 130–175 秒；`.ioc` 与产物未变时跳过（小于 1 秒） |
| 4 | 编译（首次自动 `cmake --preset`） | `stm32_build` | 配置约 5 秒 + 编译 3 秒 |
| 5 | 只烧录：program + verify + reset | `stm32_flash` | 2.1–2.6 秒 |
| 6 | 回读 `GPIOC.ODR`（或地址 `0x4001100C`），确认状态翻转 | `stm32_regs_read` | 0.4–1.3 秒 |

第 6 步的符号写法依赖内置寄存器表；安装不完整时可改用地址 `0x4001100C`，报告中不会有寄存器名与位域解释。

模型侧只需一句：「在 `D:\work\blink` 建一个 STM32F103C8T6 的闪灯工程，编译并烧录」。

最小验证覆盖「建工程 → 生成 → 编译 → 烧录 → 回读」整条链路，没有闪灯专用步骤；真实项目走同一链路，差异在于 `.ioc` 里的外设数量、`USER CODE` 块数量与代码规模。

| 完整项目中的操作 | 路径 | 验证状态 |
| --- | --- | --- |
| 外设配置：GPIO / 定时器 / USART / I2C / SPI / ADC / DMA / 中断 | `stm32_ioc_plan`（GPIO 按芯片引脚表校验）→ `stm32_ioc_apply` → `stm32_generate` | GPIO、时钟、SWD 已上板实测；其余外设机制相同，未逐项实测 |
| 新增外设后补 HAL 源 | 在 `cmake/stm32cubemx/CMakeLists.txt` 的 `STM32_Drivers_Src` 中加入 `stm32f1xx_hal_<外设>.c`，或写入 `cmake/user/CMakeLists.txt` | 需手工补齐：插件只放置 `Src/` 与 `Inc/`，CubeMX 生成的 `cmake/**` 不搬运 |
| 多源文件与自定义模块 | 写入 `cmake/user/CMakeLists.txt`，模板已留位置 | 位置就位，未单独实测 |
| 业务代码 | `stm32_code_patch` 按块写入，重新生成时按标签搬回 | 已实测（追加 / 替换；标签写错时会列出全部可用标签） |
| 调参、改时钟 | `.ioc` 事务：先出差异 → 校验 → 备份 → 失败回滚 | 已实测 |
| 确认外设运行 | `stm32_regs_read` 读任意外设寄存器：符号名 `TIM2.CNT` / `USART1.SR` / `ADC1.DR`，或物理地址 `0x40000024`；只写外设名 `GPIOC` 时输出该外设全部寄存器 | 地址写法已上板实测；符号名与位域复测中 |
| 查看现场 | `stm32_debug_run` 停在 `main` 抓取一次；连续调试用 `stm32_debug_session` + `stm32_debug_eval` | 已实测（停在 `main () at main.c:67`） |

边界集中在[已知限制](#已知限制)：HAL 建工程覆盖 21 个单核族，寄存器建工程覆盖 21 族（验证板为 C8T6），宿主仅在 Windows 验证，探针默认 CMSIS-DAP，新增外设需手工补 HAL 源。外设种类不受工具限制：`.ioc` 里能配置的能力都走同一链路；除闪灯外的外设尚未逐项上板实测，正式开工前建议先执行 `/stm32-doctor`。

## 工具参考

### 环境与工程

| 工具 | 用途 |
| --- | --- |
| `stm32_doctor` | 只读体检：工具链是否齐备、是否有残留 openocd / gdb、gdb 端口是否占用、`.elf` 与 `.ioc` 是否就位；按芯片输出能力与已知问题 |
| `stm32_route_plan` | 按具体工程与需求评估 HAL 路线与寄存器路线的开发代价，并区分可自动安装与需人工安装的缺件 |
| `stm32_env_install` | 安装 MSYS2 与工具链组件（gcc / gdb / openocd / cmake / ninja），默认只出计划，`dryRun:false` + `confirm:true` 才执行；只写用户级 PATH，不请求管理员权限 |
| `stm32_download` | 只下载不安装：J-Link 官方直链 + 校验和；CubeMX / CubeProgrammer 打开官方页或校验本地文件 |
| `stm32_firmware_install` | 下载并组装 STM32Cube 固件包，优先官方压缩包，失败回退 GitHub 拼包；默认只出计划 |
| `stm32_assets` | 查看、校验、清理包内资源（芯片数据、`.ioc` 模板、链接脚本、启动文件、寄存器表） |
| `stm32_cache` | 查看、校验、拉取、清理下载缓存（寄存器版 CMSIS 模板） |
| `stm32_project_create` | 建工程：`route:"hal"` 用模板 + 固件包，`route:"register"` 建不依赖 CubeMX 的寄存器工程；两条路线均生成 `openocd.cfg` |
| `stm32_project_export` | 工程打包为 zip，默认排除 `build/`、`.dsh-stm32/`、`node_modules/`、`.git/`，可附编译产物 |

### `.ioc`：查看与修改

| 工具 | 用途 |
| --- | --- |
| `stm32_ioc_inspect` | 只读解析：型号、引脚、信号、使能外设、中断、时钟树、工程设置与风险提示 |
| `stm32_ioc_plan` | 计算逐键差异（不写盘）：支持外设预设、引脚、中断、调试口、时钟规划与批量置键 |
| `stm32_ioc_apply` | 写入计划：源文件校验 → 备份 → 原子替换；支持按备份回滚 |
| `stm32_ioc_verify` | 由 CubeMX 自己重读 `.ioc`，指出被静默丢弃的外设与缺失的初始化 |

### 代码与构建

| 工具 | 用途 |
| --- | --- |
| `stm32_code_patch` | 只写 `USER CODE BEGIN/END` 块内内容，块外逐字节保留；写前备份 |
| `stm32_generate` | 无头运行 CubeMX，产物落到 `Core/`，`USER CODE` 按标签搬回；`.ioc` 未变时跳过 |
| `stm32_build` | 编译：自动推断构建目录与 `.elf`，返回错误行、警告数、FLASH / RAM 占用；可转出 hex / bin |

### 烧录、调试与运行时

| 工具 | 用途 |
| --- | --- |
| `stm32_flash` | 只烧录：program + verify + reset，烧完释放探针；烧前检查 Serial Wire；失败时给出探针错误的分类与处理建议 |
| `stm32_debug_run` | 烧录后停在 `main`，抓取寄存器、调用栈与局部变量，随后复位运行并释放探针 |
| `stm32_debug_session` | 开启长调试会话（空闲与总时长受限），供 `stm32_debug_eval` 连续使用 |
| `stm32_debug_eval` | 在调试会话中执行 gdb 命令：读变量、寄存器、调用栈、内存 |
| `stm32_debug_stop` | 关闭调试会话并释放探针 |
| `stm32_regs_read` | 按地址或符号名读寄存器，有寄存器表时解析位域；读取时短暂暂停，读完继续运行，不复位芯片 |
| `stm32_watch` | 登记表达式并采样（含差值）；`kind=write/read/access` 装为硬件观察点，受芯片观察点数量限制 |
| `stm32_rtt` | RTT 通道：固件侧把控制块放在 RAM，主机侧经 openocd 读取，输出带级别与时间戳 |
| `stm32_serial` | 串口交互（Windows）：`list` / `open` / `read` / `send` / `transact` / `status` / `close` |

### 固件中的 RTT 接入（最短示例）

```c
/* USER CODE BEGIN 0 */
static char rtt_buf[3][1024];
static void rtt_init(void) {
  /* 控制块按 SEGGER 约定放在 RAM：acId / acName / 三个环，见 templates/ 中的 rtt.h */
}
/* USER CODE END 0 */
```

完整实现见 `templates/` 内的 RTT 模板；通道数与环大小由 `RTT_UP_CHANNELS` / `RTT_BUF_SIZE` 控制（默认 3×1 KB = 3 KB `.bss`，C8T6 只有 20 KB RAM）。

## 斜杠命令

| 命令 | 说明 |
| --- | --- |
| `/stm32-doctor` | 体检：工具链、残留进程、端口、`.elf` 与 `.ioc` 告警 |
| `/stm32-env` | 工具链体检：编译 / 烧录 / 调试 / 生成四项能力缺什么、装在哪、如何安装 |
| `/stm32-setup` | 体检 → 安装计划 → 确认后安装 → 自检 |
| `/stm32-build [目录] [--clean]` | 编译（CMake + Ninja，默认 `build/Debug`），`--clean` 先全清 |
| `/stm32-flash [目录]` | 只烧录：program + verify + reset，结束后释放探针 |
| `/stm32-debug [目录]` | 烧录并进入调试，停在 `main`，之后可用 `stm32_debug_eval` |
| `/stm32-stop` | 关闭调试会话、释放探针，之后可在 VS Code 中按 F5 |

## 调试台（面板）

会话页签内的「调试台」用于人机同看同一条时间线：`stm32_*` 调用的开始、成功、失败与耗时，以及串口、RTT、监视、引脚、时钟、中断与 `.ioc` 变更。

| 页签 | 内容 | 操作 |
| --- | --- | --- |
| 概览 | 工程、型号、SYSCLK、容量、调试会话、工具链、构建与烧录、证据占用、告警摘要 | 跳转失败筛选与实时通道，导出操作记录 Markdown |
| 事件 | 调用起止、耗时、慢调用标记、参数摘要 | 只看失败、按工具筛选、按耗时排序、批量引用、导出 JSONL、事件深链 |
| 实时通道 | 串口 / RTT / 监视输出 | 暂停、清空、关键字过滤、RTT 级别过滤、发送串口行、常驻采集、导出 |
| 引脚 | 按外设分组、按端口排布、按封装方框 | 筛选、复制引用、查看 `.ioc` 键、导出 CSV |
| 时钟 | 树与流向两种视图、各节点频率与分频 | 超限标记与「改为 ÷N」建议（按父时钟计算） |
| 中断 | NVIC 使能、抢占与子优先级 | 筛选、排序、就地修改、批量修改 |
| 故障 | 失败事件原文、规则解码、按规则合并 | 分类筛选、复制组提示、导出 CSV |
| 产物 | elf / hex / bin、大小、校验和、容量、两次构建对比 | 复制校验和 |
| 变更 | `.ioc` 与基线的差异 | 记基线、恢复单键、一次恢复全部 |

打开面板会先补齐本会话最近的记录，之后实时追加。事件每 30 秒写入 `~/.dsh-stm32/evidence/<日期>/<会话>/`，可回放、导出；默认保留 7 天、最近 20 个会话，可在配置里调整。面板只展示本插件自己的工具调用，不含其他工具的调用。

## 串口（Windows）

`stm32_serial` 提供七个动作：`list` / `open` / `read` / `send` / `transact` / `status` / `close`。打开端口后由插件持有，一次一个端口，默认 115200 8N1、无流控、DTR / RTS 不拉高，回合结束时自动关闭。

- 平台：仅 Windows；Linux 与 macOS 返回 `unsupported-platform`。
- 端口：`list` 枚举可用端口；端口参数按设备记忆，换 COM 号后可复用。
- 读：`read` 支持游标，只返回游标之后的新行。
- 写入：`send` 发送一行，`transact` 发送并等待匹配回包（正则）。
- 保留：`persist=true` 跨回合保留端口。

参考验证板为 CH340（`1A86:7523`，COM5，115200）。同一板上的 DAPLink 虚拟串口（`c251:f001`，COM4）不承载应用串口数据。

## 设计要点

- **只写自有文件**：`.ioc` 走事务（计划 → 校验 → 备份 → 替换），生成区只写 `USER CODE` 块，其余生成文件不由插件修改。
- **烧录与调试分离**：`stm32_flash` 不建立调试会话，烧完即释放探针；需要调试时才开 `stm32_debug_session`，空闲自动关闭，避免与 VS Code 抢占探针。
- **结论附证据**：失败时给出编译器 `文件:行:列`、探针错误分类、寄存器读数，而不是模糊描述。
- **缺什么就说什么**：芯片、时钟或调试脚本不受支持时，报错直接说明缺哪一项，不猜测、不静默跳过。
- **不接管宿主**：面板只展示状态与执行明确的工程动作，不做代码编辑与 Git 操作。

## 配置

### 配置文件（`~/.dsh-stm32/config.json`）

工具链位置由插件维护：`stm32_env_install` 安装后写入该文件，后续工具直接读取，无需重启 DSH 或设置环境变量。也可手工编辑：

```json
{
  "version": 1,
  "msys64": "E:/msys64",
  "binDirs": [],
  "packages": ["mingw-w64-ucrt-x86_64-arm-none-eabi-gcc", "mingw-w64-ucrt-x86_64-cmake"],
  "cubeMxRoot": "",
  "updatedAt": "2026-02-01T00:00:00.000Z"
}
```

`binDirs` 为空时由 `msys64` 推导 `<msys64>/ucrt64/bin`。文件损坏（JSON 非法）视为不存在，不影响其他功能。

优先级：工具参数（`binDirs` / `cubeMxRoots`）> 环境变量 > 配置文件 > 内置默认值。内置默认值只含 Windows 常见位置，不含任何机器专属路径。

### 设置面板

DSH 设置内的「STM32 工具链」页提供三张卡片：

- **装在哪**：读取并保存 `msys64` / `cubeMxRoot` / 额外 `binDirs`，保存后下一条工具调用即生效。
- **缺什么**：执行一次探测（只读版本查询），逐项显示路径、版本、缺失原因，以及编译 / 烧录 / 调试 / 生成四项能力徽章。
- **装工具链**：先出计划（步骤、下载体积、PATH 与配置变更），确认后执行；过程显示步骤与日志尾部。

### 下载缓存与固件包

- 寄存器版 CMSIS 模板首次使用时下载到缓存（默认 `%LOCALAPPDATA%\dsh-stm32\cache`），之后复用；逐文件校验，变更即拒收。`stm32_cache` 可查看、校验、拉取与清理。
- HAL 路线使用本机 CubeMX 固件包：F1 默认 `STM32Cube_FW_F1_V1.8.7`，其他族取已安装的最高版本；可用 `firmwarePackage` 指定。缺失时先在 CubeMX 包管理器中安装，或用 `stm32_firmware_install` 下载组装。
- `stm32_download` 只下载或校验安装包（默认目录 `%LOCALAPPDATA%\dsh-stm32\downloads`），不执行安装器，不请求管理员权限。

### 环境变量（可选）

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `STM32_BIN_DIRS` | 工具链目录候选，`;` 分隔，整份替换内置列表（自动发现仍追加在尾部） | `C:/msys64/ucrt64/bin`、`C:/msys64/mingw64/bin` |
| `STM32_CUBEMX_ROOT` | CubeMX 安装根，整份替换内置列表 | `C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeMX` |
| `STM32_NO_DISCOVER` | 设为 `1` 关闭自动发现（仅用内置列表） | 不设 |
| `DSH_STM32_CONFIG` | 替换配置文件路径 | `%USERPROFILE%\.dsh-stm32\config.json` |
| `DSH_STM32_NO_CONFIG` | 设为 `1` 完全不读配置文件 | 不设 |
| `DSH_STM32_CACHE` | 下载缓存根目录，支持 `~` | `%LOCALAPPDATA%\dsh-stm32\cache` |
| `DSH_STM32_DOWNLOADS` | 安装包下载目录，支持 `~` | `%LOCALAPPDATA%\dsh-stm32\downloads` |
| `DSH_STM32_HOME` | 插件数据根目录（配置、证据、快照、备忘） | `%USERPROFILE%\.dsh-stm32` |
| `DSH_STM32_EVIDENCE` | 证据目录 | `~/.dsh-stm32/evidence` |
| `DSH_STM32_EVIDENCE_FLUSH_SECONDS` | 证据落盘间隔（5–3600 秒） | 30 |
| `DSH_STM32_EVIDENCE_KEEP_DAYS` | 证据保留天数（0–365，0 = 不清理） | 7 |
| `DSH_STM32_EVIDENCE_KEEP_SESSIONS` | 证据保留会话数（1–200） | 20 |
| `DSH_STM32_SNAPSHOTS` | `.ioc` 基线目录 | `~/.dsh-stm32/ioc-snapshots` |
| `DSH_STM32_OFFLINE` | 设为 `1` 禁止联网下载（模板与固件包仅用本地缓存） | 不设 |
| `MSYS2_MIRROR` | 安装包镜像，必须与 `MSYS2_INSTALLER_SHA256` 同时设置 | 官方 → TUNA → NJU → 阿里云 |
| `MSYS2_INSTALLER_URL` / `MSYS2_INSTALLER_SHA256` | 覆盖安装包地址与校验和，必须成对设置 | 官方固定版本 |
| `DSH_STM32_JLINK_URL` / `DSH_STM32_JLINK_SHA256` | 覆盖 J-Link 直链与校验和，必须成对设置 | SEGGER 官方 |

工具参数与上述变量等价：烧录与调试类接受 `binDirs`、`elfPath`、`buildDir`、`configFile`、`adapterSpeed`；生成与建工程类接受 `cubeMxRoots`、`firmwarePackage`。

工具链位置通常无需配置：未指定 `binDirs` / `STM32_BIN_DIRS` 时，插件会在常见位置查找并追加候选——`<盘>/msys64`、`<盘>/msys2`、`<盘>/app/msys64`、`<盘>/tools/msys64`、`%LOCALAPPDATA%/Programs/msys64` 下的 `ucrt64/bin`、`mingw64/bin`、`clang64/bin`，以及 `STM32CubeMX_PATH` 环境变量、CubeMX 卸载登记项、`Program Files\STMicroelectronics\STM32Cube` 等位置下的 CubeMX。找不到时，错误与 `stm32_doctor` 会列出已检查的目录。

### openocd.cfg（工程内优先）

CMSIS-DAP（默认）：

```text
source [find interface/cmsis-dap.cfg]
source [find target/stm32f1x.cfg]
adapter speed 4000
```

ST-Link：

```text
source [find interface/stlink.cfg]
transport select hla_swd
source [find target/stm32f1x.cfg]
```

工程内没有 `openocd.cfg` 时按 `.ioc` 的芯片族选择调试脚本（F1 → `stm32f1x`、F4 → `stm32f4x`、G4 → `stm32g4x`；L4 与 L4+ 共用 `stm32l4x`）。C0 / U0 的脚本随插件提供并在建工程时复制到工程的 `openocd/` 目录；H5 / N6 / U3 / WBA / WB0 / WL3 / MP2 暂无脚本，烧录会被明确拒绝。

### `.ioc` 的两个硬要求

1. **SYS 调试口为 Serial Wire**（PA13 = `SYS_JTMS-SWDIO`、PA14 = `SYS_JTCK-SWCLK`）；缺失时用 `stm32_ioc_plan` 的 `serialWire: true` 补齐。
2. **`ProjectManager.KeepUserCode=true`**；否则重新生成时 `USER CODE` 内容不保留。

## 已知限制

| 限制 | 说明 | 处理方式 |
| --- | --- | --- |
| 仅在 Windows 验证 | 生成代码依赖 CubeMX 的 Windows 安装形态 | 暂无可替代方案；烧录、调试、读寄存器在其他平台理论可用，未验证 |
| 部分芯片暂无官方调试脚本 | C0 / U0 用插件自带的适配脚本（未上板验证）；H5 / N6 / U3 / WBA / WB0 / WL3 / MP2 暂无脚本 | 烧录前会明确说明，不会静默失败 |
| HAL 建工程不覆盖双核与 MPU 系列 | 双核 WB、MP1 / MP2 / N6、WB0 / WL3 不在范围内 | 建工程时直接说明不支持 |
| 深层能力按族分级 | HAL 21 族、寄存器 21 族、时钟 18 族；寄存器名与位域目前只有 F1 | 缺哪项就在调用时说明哪项 |
| 探针按 USB 实见选择 | ST-Link、DAPLink / CMSIS-DAP、J-Link 自动区分；工程内 `openocd.cfg` 优先 | 需要固定选择时手写 `openocd.cfg` |
| 新增外设需手工补 HAL 源 | 插件只放置 `Src/` 与 `Inc/`，CubeMX 生成的 `cmake/**` 不搬运 | 修改 `STM32_Drivers_Src` 或写入 `cmake/user/CMakeLists.txt` |
| 生成与建工程需要 CubeMX 与对应固件包 | F1 默认 `STM32Cube_FW_F1_V1.8.7` | 传 `firmwarePackage`，或先在 CubeMX 内安装固件包 |
| RTT 仅通道 0，帧头为自定义格式 | 13 字节头（长度 + 级别 + 时间戳 + UTF-8 正文） | 用级别过滤；结构化内容写入正文；通道与环大小见 `rtt.h` |
| 串口仅 Windows | 不含推流、自动重连，一次一个端口 | 使用系统串口工具，或等待后续版本 |
| 寄存器名与位域依赖内置寄存器表 | 目前覆盖 F1 的 100 / 101 / 102 / 103 / 105 / 107 | 使用 `0x` 开头的地址；`stm32_assets verify` 检查安装完整性 |

## 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 插件未加载 | profile 的 `dsh.profile.bundles` 未包含 `dsh-stm32`，或未重启 | 重装并重启 DSH；用 `dsh plugin --profile desktop why dsh-stm32` 校验 |
| 修改代码后行为未变 | 用 `file:` 安装，宿主读取的是拷贝 | 改用 `link:`，重新 `npm run build` 并重启 DSH |
| 报缺工具链 | 未安装或路径未收录 | 先跑 `/stm32-env` 看缺什么，再 `/stm32-setup` 安装；或手工设置 `binDirs` |
| 烧录报探针占用 | 其他调试器（VS Code、残留 openocd）持有探针 | `/stm32-stop`，关闭其他调试器后重试；`stm32_doctor` 会列出残留进程 |
| 烧录后 SWD 失联 | `.ioc` 未启用 Serial Wire | 用 `stm32_ioc_plan` 的 `serialWire: true` 补齐后重新生成并烧录 |
| 生成后外设被丢弃 | `.ioc` 键与外设推导不一致 | 用 `stm32_ioc_verify` 让 CubeMX 诊断 |
| 面板空白或数据不更新 | 服务端改动未重启，或 `lib` 比进程新 | 完全退出 DSH 再启动；面板状态条会提示「有新构建」 |
| 串口无数据 | 端口选择错误（如选到 DAPLink 虚拟串口） | `stm32_serial list` 确认端口；应用串口通常在 CH340 等 USB 转串口设备上 |

## 开发与测试

| 命令 | 作用 |
| --- | --- |
| `npm run build` | `tsc` 编译到 `lib/`，并复制客户端与数据资源 |
| `node test/run-units.mjs` | 离线单测：80 个套件 / 1088 个用例，不需要板子 |
| `node .dsh-stm32/acceptance.mjs` | 本机验收脚本：面板 API、事件流、证据、产物、故障、中断、串口与探针 |
| `npm run test:pack` | 打包 tarball、解包、用解包产物实际建一次寄存器工程 |
| `npm run test:size` | 包体与资产护栏 |

发布形态：随包发布的内容限定在 `package.json` 的 `files`（`lib`、`client`、`templates`、`assets`、`docs/reading-guide.md`、`cordis.patch.yml`、两份 README、`LICENSE`）。开发用的 `docs/`、`test/`、`scripts/` 不进包。

开发调试用的环境变量（日常使用无需设置）：`DSH_STM32_ASSETS`、`DSH_STM32_FACTS` 覆盖资源目录，`DSH_STM32_SERIAL_BRIDGE`、`DSH_STM32_SERIAL_POWERSHELL` 覆盖串口桥路径，`DSH_STM32_PYTHON` 指定解析用的 Python 解释器。

## 目录结构

```text
src/
  index.ts          插件入口：注册工具、斜杠命令、面板 API 与 SKILL
  tools/            25 个工具的注册与参数校验
  engine/           引擎：工程、.ioc、生成、构建、烧录、调试、事件与面板 API
  data/             芯片数据、CubeMX 数据、时钟、搜索根、工具链配置
  commands/         7 条斜杠命令
  skill/            随包下发的 stm32-workflow SKILL
client/client.js    面板源码（纯 JS + react，无打包器）
lib/                tsc 产物与复制后的资源（随包发布）
assets/             芯片数据、.ioc 模板、链接脚本、启动文件、寄存器表
templates/          建工程模板、寄存器模板、串口桥与 RTT 模板
test/               80 个离线套件与 e2e 脚本
scripts/            构建、打包、体积与冒烟脚本
docs/               开发笔记、精读指南、规格书、图表
```

## 文档

- [规格书](docs/dsh-stm32-plugin-规格.md)：工具契约、状态机、验收判定标准
- [开发笔记](docs/development-notes.md)：里程碑、宿主契约问题、各工具实现细节与实测数据
- [源码精读指南](docs/reading-guide.md)：分层阅读顺序、文件职责与关键导出、流程图与不变量
- 发布说明：按版本随发布页提供，历史见 git 历史与开发笔记
- 可视化：[架构总览](docs/diagrams/dsh-stm32-architecture.html) / [主线旅程](docs/diagrams/dsh-stm32-journey.html)（单文件 HTML，离线可开）

## 许可证

[MIT](LICENSE)
