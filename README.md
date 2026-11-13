# dsh-stm32

[![GitHub stars](https://img.shields.io/github/stars/JingYu-er/dsh-stm32?color=4a6cf7)](https://github.com/JingYu-er/dsh-stm32)
[![license](https://img.shields.io/github/license/JingYu-er/dsh-stm32)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-4a6cf7)](#已知限制)
[![MCU](https://img.shields.io/badge/MCU-STM32%20family-4a6cf7)](#已知限制)
[![version](https://img.shields.io/badge/version-0.1.8-orange)](https://github.com/JingYu-er/dsh-stm32/releases)

STM32 全流程工具层，以 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件形式分发：注册 25 个工具、7 条斜杠命令与 1 个随包下发的 SKILL，覆盖工具链探测 → 建工程 → 修改 `.ioc`（含时钟）→ 生成代码 → 编译 → 烧录 → 调试 → 回读寄存器，另含串口交互（Windows P1）与会话内的「调试台」面板。

族画像按 `.ioc` 的 `Mcu.Family` 判定：引脚名、SWD 调试信号名、EXTI 的 NVIC 向量分组、openocd target、硬件断点与观察点预算均随族与内核变化。

| 能力面 | 覆盖范围 |
| --- | --- |
| 族画像 | 27 个族：C0 / F0 / F1 / F2 / F3 / F4 / F7 / G0 / G4 / H5 / H7 / L0 / L1 / L4 / L4+ / L5 / MP1 / MP2 / N6 / U0 / U3 / U5 / WB / WB0 / WBA / WL / WL3 |
| HAL 建工程 | 21 个单核族：C0 / F0 / F1 / F2 / F3 / F4 / F7 / G0 / G4 / H5 / H7 / L0 / L1 / L4 / L4+ / L5 / U0 / U3 / U5 / WBA / WL |
| 寄存器建工程 | 21 族，均通过 create→build 编译矩阵 |
| 时钟规划 | 18 族；其中 PLL1 为 H5 / U5 / WBA / L4+ |
| `.ioc` 外设预设 | 按 CubeMX db 派生：串口 / TIM PWM / ADC |
| SVD 符号与位域 | F1 |

未覆盖的能力明确拒绝并说明原因，不回退到 F1 表。

**English:** [README_EN.md](./README_EN.md)

[快速开始](#快速开始最小验证空目录到灯在闪) · [工具参考](#工具参考) · [斜杠命令](#斜杠命令) · [调试台](#调试台面板) · [配置](#配置) · [已知限制](#已知限制) · [排错](#排错) · [规格书](docs/dsh-stm32-plugin-规格.md)

## 为什么需要它

多数「让 AI 编写 STM32 代码」的方案止于代码层：产出一段 `main.c`，至于能否编译、烧录后灯是否按预期闪烁，仍需在 CubeMX、终端与调试器之间手工完成。模型看不到板子，也就无法对自己的代码负责。

本插件把硬件侧接入 DSH：`.ioc` 可读可改（事务 + 回滚），代码写入 `USER CODE` 块，生成与编译返回真实报错行，烧录走不经过调试器的独立路径，烧录后读回寄存器状态。每一步返回结构化证据（`planId`、`file:line:col`、`Verified OK`、`GPIOC.ODR` 的 bit13，有 SVD 时直接给出 `ODR13=1`），模型据此决定下一步，无需猜测。

| 环节 | 手工流程 | 本插件 |
| --- | --- | --- |
| 建工程 | GUI 配置时钟树、引脚与工程参数，生成 CMake，手写 `launch.json` | `stm32_project_create` 约 2 s 产出模板工程，与 GUI 产物逐字节一致，`.vscode` 内两份配置就位 |
| 改配置 | GUI 修改后重新生成，担心 `USER CODE` 丢失 | `stm32_ioc_plan` 先出 diff（不写盘）→ 确认 → `stm32_ioc_apply` 带 SHA 校验、备份与失败回滚 |
| 写代码 | 整文件编辑，易写入生成区，重新生成后丢失 | `stm32_code_patch` 只写 `USER CODE` 块，块外逐字节保留 |
| 编译 | Keil，或自行维护 CMake 与 VS Code 任务 | `/stm32-build [dir] [--clean]` |
| 烧录 | Keil，或手写 `tasks.json` 调 openocd | `/stm32-debug [dir]` |
| 验证 | 断点调试，手工查看寄存器 | `stm32_regs_read` 回读状态：`GPIOC.ODR` 两次采样确认计数递增，`AFIO.MAPR` 确认 SWD 未被固件关闭 |
| 调试 | F5 手动下断点，结束再关会话 | `stm32_debug_run` 停在 `main` 抓取一次现场后释放；连续调试才开 `stm32_debug_session`，空闲自动关闭 |

## 安装

### 前置条件

| 依赖 | 用途 | 缺失影响 |
| --- | --- | --- |
| dsh（可加载 bundle 层） | 宿主 | 插件不加载 |
| Node ≥ 20 | 构建与测试 | `npm run build` 失败 |
| `arm-none-eabi-gcc`、`arm-none-eabi-gdb`（或 `gdb-multiarch`） | 编译与调试 | `stm32_doctor` 逐项提示缺失位置与安装方式 |
| `openocd` | 烧录与调试 | 烧录、调试不可用，只读工具正常 |
| `cmake` + `ninja` | 构建 | `stm32_build` 失败 |
| STM32CubeMX（含内置 JRE） | `stm32_generate`、`stm32_project_create` | 生成类工具不可用，其余正常 |
| STM32Cube 固件包 F1（随 CubeMX 安装） | 建骨架时复制 Drivers | 报「找不到固件包」 |

### 安装（推荐）

```powershell
dsh plugin --profile desktop add dsh-stm32
```

`dsh plugin` 等价于在 profile 目录执行 `pnpm add`，并将 `dsh-stm32` 写入该 profile 的 `dsh.profile.bundles`；重启 dsh 生效。将 `desktop` 换成 `web` 即安装到 web profile。

校验：`dsh plugin --profile desktop why dsh-stm32` 应显示 `0.1.8`；重启后 `/stm32-doctor` 有输出。

卸载：`dsh plugin --profile desktop remove dsh-stm32`，随后重启 dsh。

### 内置资源

芯片事实随插件分发：型号到启动文件、设备宏、Flash/RAM 容量的映射来自包内 `assets/device/<族>/chips.json`（core 75 个文件，full 105 个文件：芯片表、内存布局、`.ioc` 模板、链接脚本与 SVD），安装后离线可用，无需下载资源包。`stm32_assets verify` 校验完整性；文件缺失通常表示安装不完整。

### 源码安装

```powershell
git clone https://github.com/JingYu-er/dsh-stm32.git
cd dsh-stm32
npm install --no-audit --no-fund   # 仅安装 typescript
npm run build                       # tsc -> lib/，提交前必须执行
npm test                            # 可选：离线用例，不需要板子
npm run test:pack                   # 打包 tarball、解包、用解包产物建一次寄存器工程
npm run test:size                   # 包体护栏：tarball ≤ 3.9 MB，运行时资产 ≤ 40 KB
```

挂载到 profile 时，修改代码必须使用 `link:`，不使用 `file:`：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add "link:D:\path\to\dsh-stm32"

# 在同一目录的 package.json 中把 "dsh-stm32" 追加到 dsh.profile.bundles
# 随后重启 dsh（bundle 层只在进程启动时加载）
```

原因：`nodeLinker: hoisted` 下 `file:` 会被复制成真实目录，重新 `tsc` 产出的 `lib/` 宿主读取不到，表现为「改完代码、重启仍为旧行为」。`link:` 实时读取 `lib/`，但仍需重启 dsh 重新加载插件。`github:` 与 npm 安装均为拷贝，修改后需重新构建并重新安装。

## 快速开始：最小验证（空目录到灯在闪）

该链路已在真板验证（A1 验收，2026-10-22），全程由模型调用工具完成。各步使用同一套工具，闪灯只是最小样例。

| 步 | 动作 | 工具 | 实测耗时 |
| --- | --- | --- | --- |
| 1 | 体检：工具链、被占用探针、端口、`.elf`、`.ioc` 告警 | `stm32_doctor` | 约 2 s |
| 2 | 空目录建 CMake 工程骨架（14 个模板文件、629 个固件文件、已配置 SWD 的 `.ioc`） | `stm32_project_create` | 约 2 s |
| 3 | 按 `.ioc` 无头运行 CubeMX，产物落到 `Core/` | `stm32_generate` | 首次 130–175 s；`.ioc` 与产物未变时直接跳过（< 1 s） |
| 4 | 编译（首次自动 `cmake --preset`） | `stm32_build` | 配置约 5 s + 编译 3 s |
| 5 | 只烧录：program + verify + reset | `stm32_flash` | 2.1–2.6 s |
| 6 | 回读 `GPIOC.ODR`（或地址 `0x4001100C`），确认状态翻转 | `stm32_regs_read` | 0.4–1.3 s |

第 6 步的符号写法依赖内置 SVD 表（`assets/device/f1/svd/`，full 层）。仅安装 core 或安装不完整时仍可读，但需写地址 `0x4001100C`，报告中无寄存器名与位域解释。

模型侧只需一句：「在 `D:\work\blink` 建一个 STM32F103C8T6 的闪灯工程，编译并烧录」。手工执行时使用下列命令：

```text
/stm32-doctor         # 开工前体检
/stm32-env            # 查看四项能力的缺失项（缺件也可查看）
/stm32-build          # 编译，输出内存占用与错误
/stm32-flash          # 只烧录，不进入调试会话
/stm32-debug          # 烧录并停在 main
/stm32-stop           # 关闭调试会话，释放探针给 VS Code
/stm32-setup          # 体检与安装计划（确认后执行安装）
```

最小验证覆盖「建工程 → 生成 → 编译 → 烧录 → 回读」整条链路，没有闪灯专用步骤；真实项目走同一链路，差异在于 `.ioc` 中的外设数量、`USER CODE` 块数量与代码规模。

| 完整项目中的操作 | 路径 | 验证状态 |
| --- | --- | --- |
| 外设配置：GPIO / 定时器 / USART / I2C / SPI / ADC / DMA / 中断 | `stm32_ioc_plan`（GPIO 按芯片引脚表校验，外设写 `Mcu.IP*` / `Periph.*` 键）→ `stm32_ioc_apply` → `stm32_generate` | GPIO、时钟、SWD 已实测；其余外设机制相同，未逐项实测 |
| 新增外设后补 HAL 源 | 在 `cmake/stm32cubemx/CMakeLists.txt` 的 `STM32_Drivers_Src` 中加入 `stm32f1xx_hal_<外设>.c`，或写入 `cmake/user/CMakeLists.txt` | 需手工补齐：插件只落位 `Src/` 与 `Inc/`，CubeMX 生成的 `cmake/**` 不搬运 |
| 多源文件与自定义模块 | 写入 `cmake/user/CMakeLists.txt`，模板已留位置 | 位置就位，未单独实测 |
| 业务代码 | `stm32_code_patch` 按块写入，重新生成时按标签搬回 | 已实测（append / replace；标签写错时列出全部可用标签） |
| 调参、改时钟 | `.ioc` 事务：先 diff → SHA 校验 → 备份 → 失败回滚 | 已实测 |
| 确认外设运行 | `stm32_regs_read` 读任意外设寄存器：符号名 `TIM2.CNT` / `USART1.SR` / `ADC1.DR`，或物理地址 `0x40000024`；只写外设名 `GPIOC` 时输出该外设全部寄存器 | 地址写法已上板实测；符号名与位域解释经内置 SVD 与假探针验证，真机待复测（development-notes §31.11） |
| 查看现场 | `stm32_debug_run` 停在 `main` 抓取一次；连续调试用 `stm32_debug_session` + `stm32_debug_eval` | 已实测（停在 `main () at main.c:67`） |

边界集中在[已知限制](#已知限制)：HAL 建工程覆盖 21 个单核族，寄存器建工程覆盖 21 族（验证板为 C8T6），宿主仅在 Windows 验证，探针默认 CMSIS-DAP，新增外设需手工补 HAL 源。外设种类不受工具限制：`.ioc` 可配置的能力均走同一链路；除闪灯外的外设尚未逐项上板实测，正式开工前建议先执行 `stm32_doctor`。

## 工具参考

### 环境与工程

| 工具 | 用途 |
| --- | --- |
| `stm32_doctor` | 只读体检：工具链是否齐备、是否有残留 openocd/gdb、gdb 端口是否占用、`.elf` 与 `.ioc` 是否就位；按芯片输出能力与已知问题 |
| `stm32_route_plan` | 按具体工程与需求评估 HAL 路线与寄存器路线的开发代价，并区分可自动安装与需人工安装的缺件 |
| `stm32_env_install` | 安装 MSYS2 与工具链组件（gcc / gdb / openocd / cmake / ninja），默认只出计划，`dryRun:false` + `confirm:true` 才执行；PATH 只写用户级 |
| `stm32_download` | 只下载不安装：J-Link 官方直链 + SHA256；CubeMX / CubeProgrammer 打开官方页或校验本地文件 |
| `stm32_firmware_install` | 下载并组装 STM32Cube 固件包，优先官方 zip，失败回退 GitHub 拼包；默认只出计划 |
| `stm32_assets` | 查看、校验、清理包内资源（设备事实、`.ioc` 模板、链接脚本、启动文件、SVD） |
| `stm32_cache` | 查看、校验、拉取、清理下载缓存（寄存器版 CMSIS 模板） |
| `stm32_project_create` | 建工程：`route:"hal"` 用模板 + 固件包，`route:"register"` 建不依赖 CubeMX 的寄存器工程；两条路线均生成 `openocd.cfg` |
| `stm32_project_export` | 工程打包为 zip，默认排除 `build/`、`.dsh-stm32/`、`node_modules/`、`.git/`，可附预编译产物 |

### `.ioc`：只读与事务

| 工具 | 用途 |
| --- | --- |
| `stm32_ioc_inspect` | 只读解析：型号、引脚、信号、使能外设、中断、时钟树、工程设置与风险提示 |
| `stm32_ioc_plan` | 计算逐键 diff（不写盘）：支持外设预设、引脚、中断、调试口、时钟规划与批量置键 |
| `stm32_ioc_apply` | 写入计划：源文件 SHA 校验 → 备份 → 原子替换；支持按备份回滚 |
| `stm32_ioc_verify` | 由 CubeMX 自身诊断 `.ioc`：对比「CubeMX 的理解」与计划，定位被静默丢弃的外设与缺失的初始化 |

### 代码与构建

| 工具 | 用途 |
| --- | --- |
| `stm32_code_patch` | 只写 `USER CODE BEGIN/END` 块内内容，块外逐字节保留；写前备份 |
| `stm32_generate` | 无头运行 CubeMX，产物按 ST 结构落位，`USER CODE` 按标签搬回；`.ioc` 未变时跳过 |
| `stm32_build` | 编译：自动推断构建目录与 `.elf`，返回错误行、警告数、FLASH/RAM 占用；可转出 hex/bin |

### 烧录、调试与运行时

| 工具 | 用途 |
| --- | --- |
| `stm32_flash` | 只烧录：openocd `program verify reset exit`，烧完释放探针；烧前校验 Serial Wire；失败返回结构化 `probeError`（`kind` / `cause` / `hint` / `evidence` / `retryable`） |
| `stm32_debug_run` | 烧录后停在 `main` 抓取寄存器、调用栈与局部变量，随后复位运行并释放探针 |
| `stm32_debug_session` | 开启长调试会话（空闲与总时长受限），供 `stm32_debug_eval` 连续使用 |
| `stm32_debug_eval` | 在调试会话中执行 gdb 命令：读变量、寄存器、调用栈、内存 |
| `stm32_debug_stop` | 关闭调试会话并释放探针 |
| `stm32_regs_read` | 按地址或符号名读寄存器，有 SVD 时解析位域；halt 读取后 `resume`，不复位芯片 |
| `stm32_watch` | 登记表达式并采样（含差值）；`kind=write/read/access` 装为硬件观察点，受数据比较器预算约束 |
| `stm32_rtt` | RTT 通道：控制块置于 RAM，openocd 将通道 0 转为 TCP 流，按 13 字节头解析级别与时间戳 |
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

完整实现见 `templates/` 内的 RTT 模板；通道数与环大小由 `RTT_UP_CHANNELS` / `RTT_BUF_SIZE` 控制（默认 3×1 KB = 3 KB `.bss`，C8T6 仅 20 KB RAM）。

## 斜杠命令

| 命令 | 说明 |
| --- | --- |
| `/stm32-doctor` | 体检：工具链、残留进程、端口、`.elf` 与 `.ioc` 告警 |
| `/stm32-env` | 工具链体检：编译 / 烧录 / 调试 / 生成四项能力缺什么、装在哪、如何安装 |
| `/stm32-setup` | 体检 → 安装计划 → 确认后安装 → 自检 |
| `/stm32-build [dir] [--clean]` | 编译（CMake + Ninja，默认 `build/Debug`），`--clean` 先全清 |
| `/stm32-flash [dir]` | 只烧录：program + verify + reset，结束后释放探针 |
| `/stm32-debug [dir]` | 烧录并进入调试，停在 `main`，之后可用 `stm32_debug_eval` |
| `/stm32-stop` | 关闭调试会话、释放探针，之后可在 VS Code 中按 F5 |

## 调试台（面板）

会话页签内的「调试台」（`conversation.view`，id `stm32-debug`）用于人机同看同一条时间线：`stm32_*` 调用的开始、成功、失败与耗时，以及串口、RTT、监视、引脚、时钟、中断与 `.ioc` 变更。

| 页签 | 内容 | 操作 |
| --- | --- | --- |
| 概览 | 工程、型号、SYSCLK、容量、调试会话、工具链、构建与烧录、证据占用、告警摘要 | 跳转失败筛选与实时通道，导出操作记录 Markdown |
| 事件 | 调用起止、耗时、慢调用标记、参数摘要 | 只看失败、按工具筛选、按耗时排序、批量引用、导出 JSONL、事件深链 |
| 实时通道 | 串口 / RTT / 监视输出 | 暂停、清空、关键字过滤、RTT 级别过滤、发送串口行、常驻采集、导出 |
| 引脚 | 按外设分组、按端口排布、按封装方框 | 筛选、复制引用、查看 `.ioc` 键、导出 CSV |
| 时钟 | 树与流向两种视图、各节点频率与分频 | 超限标记与「改为 ÷N」建议（按父时钟计算） |
| 中断 | NVIC 使能、抢占与子优先级 | 筛选、排序、就地修改、批量修改 |
| 故障 | 失败事件原文、规则解码、按规则合并 | 分类筛选、复制组提示、导出 CSV |
| 产物 | elf / hex / bin、大小、SHA-256、容量、两次构建对比 | 复制校验和 |
| 变更 | `.ioc` 与基线的差异 | 记基线、恢复单键、一次恢复全部 |

数据面：46 条 `/dsh-stm32/api/*` 路由；事件流经 SSE（`/events?since=<seq>&session=<id>`）先补发存量再增量推送。环形缓冲 5000 条，单条 payload 截 8 KB；每 30 秒将未落盘事件写入 `~/.dsh-stm32/evidence/<日期>/<会话>/events-<时分秒>.jsonl`。保留策略可配（flush 间隔、保留天数与会话数），环境变量优先于配置。事件源仅限本插件的 `stm32_*` 调用。

## 串口（Windows P1）

`stm32_serial` 提供七个动作：`list` / `open` / `read` / `send` / `transact` / `status` / `close`。实现为零 npm 依赖的 PowerShell 5.1 常驻桥（`System.IO.Ports`），由桥进程持有 COM 口；默认 115200 8N1、无流控、DTR/RTS 不拉高、`persist=false`、单会话。

- 平台：仅 Windows。Linux 与 macOS 返回 `unsupported-platform`。
- 端口：`list` 枚举可用端口；按 USB 序列号记忆端口参数，换 COM 号后可复用。
- 读：`read` 支持游标，只返回游标之后的新行；字节层数据写入 `rx.ndjson`。
- 写入：`send` 发送一行，`transact` 发送并等待匹配回包（正则）。
- 结束：默认在回合结束时关闭端口，`persist=true` 跨回合保留。

典型验证板为 CH340（`1A86:7523`，COM5，115200）。同一板上的 DAPLink 虚拟串口（`c251:f001`，COM4）不承载应用串口数据。

## 设计要点

- **只写自有文件**：`.ioc` 走事务（计划 → 校验 → 备份 → 替换），生成区只写 `USER CODE` 块，其余生成文件不由插件修改。
- **烧录与调试分离**：`stm32_flash` 不建立调试会话，烧完即释放探针；需要调试时才开 `stm32_debug_session`，空闲自动关闭，避免与 VS Code 抢占探针。
- **结论附证据**：失败返回结构化字段（编译器 `file:line:col`、探针错误分类、寄存器读数），不返回模糊描述。
- **未覆盖即拒绝**：族画像、时钟规划、SVD 覆盖与 openocd target 缺失时明确拒绝并说明原因。
- **不接管宿主**：面板只展示与执行明确的工程动作，不做代码编辑与 Git 操作。

## 配置

### 配置文件（`~/.dsh-stm32/config.json`）

工具链位置由插件自行维护：`stm32_env_install` 安装后写入该文件，后续工具读取，无需重启 DSH 或设置环境变量。也可手工编辑：

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

优先级：工具参数（`binDirs` / `cubeMxRoots`）> 环境变量 > 配置文件 > 内置默认值。自动发现仅追加在未显式指定的候选之后。

内置默认值不含机器专属路径，仅含 `C:/msys64/...` 与 `C:/Program Files/...` 等 Windows 默认位置。配置中指定但本机不存在的目录（例如从其他机器拷贝的配置）会由门禁与 `stm32_doctor` 明确报告，插件不自动改写配置，安装器也不会将其作为安装目标。

### 设置面板

DSH 设置内的「STM32 工具链」页（插件自带的浏览器端面板，与宿主同源，零额外依赖）提供三张卡片：

- **装在哪**：读取并保存 `msys64` / `cubeMxRoot` / 额外 `binDirs`，保存后下一条工具调用即生效。
- **缺什么**：执行一次探测（只读版本命令），逐项显示路径、版本、缺失项的 `hint`，以及编译 / 烧录 / 调试 / 生成四项能力徽章。
- **装工具链**：先出计划（步骤、下载体积、PATH 与配置变更），确认后执行；过程显示步骤与日志尾部，执行器与 `stm32_env_install` 相同。

面板产物为 `lib/client.js`，源码 `client/client.js`，由 `npm run build` 复制。宿主无 `webServer` 服务时该层注册自动跳过，工具与斜杠命令不受影响。

### 下载缓存与固件包

- 寄存器版 CMSIS 模板首次使用时下载至缓存（默认 `%LOCALAPPDATA%\dsh-stm32\cache`），之后复用；逐文件钉上游 sha256，变更即拒收。`stm32_cache` 可查看、校验、拉取与清理。
- HAL 路线使用本机 CubeMX 固件包：F1 默认 `STM32Cube_FW_F1_V1.8.7`，其他族取本机已安装的最高版本；可用 `firmwarePackage` 指定。缺失时先在 CubeMX 包管理器中安装，或用 `stm32_firmware_install` 下载组装。
- `stm32_download` 仅下载或校验安装包（默认目录 `%LOCALAPPDATA%\dsh-stm32\downloads`），不执行安装器，不请求管理员权限。

### 环境变量（可选）

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `STM32_BIN_DIRS` | 工具链目录候选，`;` 分隔，整份替换内置列表（自动发现仍追加在尾部） | `C:/msys64/ucrt64/bin`、`C:/msys64/mingw64/bin` |
| `STM32_CUBEMX_ROOT` | CubeMX 安装根，整份替换内置列表 | `C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeMX` |
| `STM32_NO_DISCOVER` | 设为 `1` 关闭自动发现（CI 或仅用内置列表） | 不设 |
| `DSH_STM32_CONFIG` | 替换配置文件路径 | `%USERPROFILE%\.dsh-stm32\config.json` |
| `DSH_STM32_NO_CONFIG` | 设为 `1` 完全不读配置文件 | 不设 |
| `DSH_STM32_CACHE` | 下载缓存根目录，支持 `~` | `%LOCALAPPDATA%\dsh-stm32\cache` |
| `DSH_STM32_DOWNLOADS` | 安装包下载目录，支持 `~` | `%LOCALAPPDATA%\dsh-stm32\downloads` |
| `DSH_STM32_HOME` | 插件数据根目录（配置、证据、快照、备忘） | `%USERPROFILE%\.dsh-stm32` |
| `DSH_STM32_ASSETS` | 资源目录覆盖（开发用） | 包内 `assets/` |
| `DSH_STM32_FACTS` | 设备事实目录覆盖（开发用） | 包内 `assets/device` |
| `DSH_STM32_EVIDENCE` | 证据目录覆盖 | `~/.dsh-stm32/evidence` |
| `DSH_STM32_EVIDENCE_FLUSH_SECONDS` | 落盘间隔（5–3600 s） | 30 |
| `DSH_STM32_EVIDENCE_KEEP_DAYS` | 证据保留天数（0–365，0 = 不清理） | 7 |
| `DSH_STM32_EVIDENCE_KEEP_SESSIONS` | 证据保留会话数（1–200） | 20 |
| `DSH_STM32_SNAPSHOTS` | `.ioc` 基线目录 | `~/.dsh-stm32/ioc-snapshots` |
| `DSH_STM32_JLINK_URL` | 覆盖 J-Link 直链，必须同时设 `DSH_STM32_JLINK_SHA256` | SEGGER 官方直链 |
| `DSH_STM32_JLINK_SHA256` | 覆盖源 sha256 | 官方哈希 |
| `DSH_STM32_SERIAL_BRIDGE` / `DSH_STM32_SERIAL_POWERSHELL` | 串口桥脚本与 PowerShell 路径覆盖 | 内置桥 / `powershell.exe` |
| `DSH_STM32_OFFLINE` | 设为 `1` 禁止联网下载（模板与固件包仅用本地缓存） | 不设 |
| `DSH_STM32_PYTHON` | 指定 Python 解释器（SVD/尺寸解析辅助） | 自动探测 |
| `MSYS2_INSTALLER_URL` / `MSYS2_INSTALLER_SHA256` | 覆盖安装包地址与哈希，必须成对设置 | 官方固定 release |
| `MSYS2_MIRROR` | 覆盖安装包目录，必须带哈希 | 官方 release → TUNA → NJU → 阿里云 |

工具参数与上述变量等价：烧录与调试类接受 `binDirs`、`elfPath`、`buildDir`、`configFile`、`adapterSpeed`；生成与建工程类接受 `cubeMxRoots`、`firmwarePackage`。

自动发现（通常无需配置）：未指定 `binDirs` / `STM32_BIN_DIRS` 时，插件扫描常见位置并把结果追加在候选尾部。

- 工具链：`<盘>/msys64`、`<盘>/msys2`、`<盘>/app/msys64`、`<盘>/tools/msys64`、`%LOCALAPPDATA%/Programs/msys64` 下的 `ucrt64/bin`、`mingw64/bin`、`clang64/bin`（目录内需存在 `arm-none-eabi-gcc.exe`、`openocd.exe` 或 `cmake.exe`）。
- CubeMX：环境变量 `STM32CubeMX_PATH`、卸载键 `DisplayIcon` / `UninstallString`、`<盘>/`、`<盘>/app`、`<盘>/tools`、`Program Files\STMicroelectronics\STM32Cube`、`%LOCALAPPDATA%/Programs` 下的 `STM32CubeMX`（要求 `STM32CubeMX.exe` 与 `jre/bin/java.exe` 同时存在）。

扫描约 1 s，进程内缓存。显式指定 `binDirs` / `cubeMxRoots` 时不追加候选。环境变量中的路径会净化（去引号、反斜杠转正斜杠、折叠重复斜杠）。找不到工具时，错误与 `stm32_doctor` 的 notes 会列出已检查的目录。

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

无 `openocd.cfg` 时按 `.ioc` 的 `Mcu.Family` 选择 target（F1 → `target/stm32f1x.cfg`、F4 → `target/stm32f4x.cfg`、G4 → `target/stm32g4x.cfg`；L4 与 L4+ 共用 `stm32l4x`）。C0 / U0 在 openocd 0.12 中无官方脚本，插件自带适配版并在建工程时复制到工程的 `openocd/` 目录；H5 / N6 / U3 / WBA / WB0 / WL3 / MP2 无脚本，烧录会被明确拒绝。

### `.ioc` 的两个硬要求

1. **SYS 调试口为 Serial Wire**（PA13 = `SYS_JTMS-SWDIO`、PA14 = `SYS_JTCK-SWCLK`）；缺失时用 `stm32_ioc_plan` 的 `serialWire: true` 补齐。
2. **`ProjectManager.KeepUserCode=true`**；否则重新生成时 `USER CODE` 内容不保留。

## 已知限制

| 限制 | 说明 | 处理方式 |
| --- | --- | --- |
| 仅在 Windows 验证 | `stm32_generate` 依赖 `<CubeMX>/STM32CubeMX.exe` 与 `jre/bin/java.exe` | 暂无；烧录、调试、读寄存器在其他平台上理论可用，未验证 |
| C0 / U0 的 target 脚本为插件自带 | openocd 0.12 无 `stm32c0x.cfg` / `stm32u0x.cfg`，插件内置适配版 | 已验证脚本可完整加载；无真板烧写证据 |
| HAL 建工程覆盖 21 个单核族 | 双核 WB、MP1 / MP2 / N6、WB0 / WL3 不在范围内 | 未覆盖的族明确拒绝，`stm32_assets verify` 定位缺件 |
| 深层能力按族分级 | 族画像 27 族；HAL 21 族、寄存器 21 族、时钟 18 族、SVD 仅 F1 | 能力缺失时明确拒绝并说明原因 |
| 探针按 USB 实见选择 | ST-Link → `stlink-dap.cfg`，DAPLink / CMSIS-DAP → `cmsis-dap.cfg`，J-Link → `jlink.cfg`；工程内 `openocd.cfg` 优先 | 需固定时手写 `openocd.cfg` |
| 新增外设需手工补 HAL 源 | 插件只落位 `Src/` 与 `Inc/`，CubeMX 生成的 `cmake/**` 不搬运 | 修改 `STM32_Drivers_Src` 或写入 `cmake/user/CMakeLists.txt` |
| 生成与建工程需要 CubeMX 与对应固件包 | F1 默认 `STM32Cube_FW_F1_V1.8.7` | 传 `firmwarePackage`，或先安装固件包 |
| RTT 仅通道 0，帧头为自定义格式 | 13 字节头（4 B 长度 + 1 B 级别 + 8 B 时间戳 + UTF-8 正文），非 defmt，也非 SEGGER 原生裸字节 | 用 `level` 过滤；结构化内容写入 `text`；通道与环大小见 `rtt.h` |
| 串口仅 Windows（P1） | 桥为 PowerShell 5.1 + `System.IO.Ports`；不含推流、自动重连，一次一个端口 | 使用系统串口工具，或等待后续版本 |
| 寄存器符号名与位域依赖内置 SVD | 仅覆盖 F1 的 100 / 101 / 102 / 103 / 105 / 107 | 使用 `0x` 开头的地址；`stm32_assets verify` 检查安装完整性 |

## 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 插件未加载 | profile 的 `dsh.profile.bundles` 未包含 `dsh-stm32`，或未重启 | 重装并重启 dsh；`dsh plugin --profile desktop why dsh-stm32` 校验 |
| 修改代码后行为未变 | 使用 `file:` 安装，宿主读取的是拷贝 | 改用 `link:`，重新 `npm run build` 并重启 dsh |
| `stm32_doctor` 报缺工具链 | 未安装或路径未收录 | `/stm32-setup` 生成安装计划；或手工设置 `binDirs` |
| 烧录报探针占用 | 其他调试器（VS Code、残留 openocd）持有探针 | `/stm32-stop`，关闭其他调试器后重试；`stm32_doctor` 列出残留进程 |
| 烧录后 SWD 失联 | `.ioc` 未启用 Serial Wire | `stm32_ioc_plan` 的 `serialWire: true` 补齐后重新生成并烧录 |
| 生成后被静默丢弃 | `.ioc` 键与外设推导不一致 | `stm32_ioc_verify` 由 CubeMX 诊断 |
| 面板空白或数据不更新 | 服务端改动未重启，或 `lib` 比进程新 | 完全退出 dsh 再启动；面板状态条会提示「有新构建」 |
| 串口无数据 | 端口选择错误（如选到 DAPLink 虚拟串口） | `stm32_serial list` 确认端口；应用串口通常在 CH340 等 USB 转串口设备上 |

## 开发与测试

| 命令 | 作用 |
| --- | --- |
| `npm run build` | `tsc` 编译到 `lib/`，并复制客户端与数据资源 |
| `node test/run-units.mjs` | 离线单测：80 个套件 / 1088 个用例，不需要板子 |
| `node .dsh-stm32/acceptance.mjs` | 本机验收脚本：面板 API、事件流、证据、产物、故障、中断、串口与探针 |
| `npm run test:pack` | 打包 tarball、解包、用解包产物实际建一次寄存器工程 |
| `npm run test:size` | 包体与资产护栏 |

发布形态：随包发布的内容限定在 `package.json` 的 `files`（`lib`、`client`、`templates`、`assets`、`docs/reading-guide.md`、`cordis.patch.yml`、两份 README、`LICENSE`）。开发用的 `docs/`、`test/`、`scripts/` 不进包；发布文本不写入仓库，按版本随发布页提供。

## 目录结构

```text
src/
  index.ts          插件入口：注册工具、斜杠命令、面板 API 与 SKILL
  tools/            25 个工具的注册与参数校验
  engine/           引擎：工程、.ioc、生成、构建、烧录、调试、事件与面板 API
  data/             设备事实、CubeMX db、时钟、搜索根、工具链配置
  commands/         7 条斜杠命令
  skill/            随包下发的 stm32-workflow SKILL
client/client.js    面板源码（纯 JS + react，无打包器）
lib/                tsc 产物与复制后的资源（随包发布）
assets/             设备事实、.ioc 模板、链接脚本、启动文件、SVD
templates/          建工程模板、寄存器模板、串口桥与 RTT 模板
test/               80 个离线套件与 e2e 脚本
scripts/            构建、打包、体积与冒烟脚本
docs/               开发笔记、精读指南、规格书、图表
```

## 文档

- [规格书](docs/dsh-stm32-plugin-规格.md)：工具契约、状态机、验收 A1–A13 判定标准
- [开发笔记](docs/development-notes.md)：里程碑、宿主契约问题、各工具实现细节与实测数据
- [源码精读指南](docs/reading-guide.md)：分层阅读顺序、文件职责与关键导出、流程图与不变量
- 发布说明：按版本随发布页提供，历史见 git 历史与开发笔记
- 可视化：[架构总览](docs/diagrams/dsh-stm32-architecture.html) / [主线旅程](docs/diagrams/dsh-stm32-journey.html)（单文件 HTML，离线可开）

## 许可证

[MIT](LICENSE)
