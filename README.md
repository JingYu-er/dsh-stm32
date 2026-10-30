# dsh-stm32

> 让 DSH 接管 **STM32F1 全系**（F100/101/102/103/105/107）的整条开发链：探测工具链 → 建工程 → 改 .ioc（含时钟） → 生成代码 → 编译 → 调试 → 烧录。

**English:** STM32F1 toolchain (F100/101/102/103/105/107) for DeepSeek Harness — probe the toolchain, scaffold a CMake project, edit .ioc as a transaction, build, flash without starting a debug session, and debug only when you ask for it.

[English](./README_EN.md) · [快速开始](#快速开始最小验证空目录到灯在闪) · [功能一览](#功能一览) · [工具参考](#工具参考) · [斜杠命令](#斜杠命令) · [设计要点](#设计要点) · [已知限制](#已知限制) · [排错](#排错) · [规格书](docs/dsh-stm32-plugin-规格.md)

[![GitHub stars](https://img.shields.io/github/stars/JingYu-er/dsh-stm32?color=4a6cf7)](https://github.com/JingYu-er/dsh-stm32)
[![license](https://img.shields.io/github/license/JingYu-er/dsh-stm32)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-4a6cf7)](#已知限制)
[![MCU](https://img.shields.io/badge/MCU-STM32F1xx-4a6cf7)](#已知限制)
[![version](https://img.shields.io/badge/version-0.1.2-orange)](https://github.com/JingYu-er/dsh-stm32/releases)

这是一个 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) **插件**：注册 20 个工具、7 条斜杠命令和 1 个随插件下发的 SKILL，让模型能直接探测工具链、建cubemx cmake工程、改 `.ioc`、跑 CubeMX、编译、烧录和调试，烧完再把寄存器里的状态读回来确认——实现更彻底的面向DSH硬件编程。

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


### 安装（推荐：一条命令）

```powershell
dsh plugin --profile desktop add github:JingYu-er/dsh-stm32#main
```

`dsh plugin` 做的事就是在 profile 目录里跑 `pnpm add`。装完它会把 `dsh-stm32` 写进该 profile 的 `dsh.profile.bundles`，重启 dsh 即生效（把 `desktop` 换成 `web` 就装到 web profile）。

装完确认：`dsh plugin --profile desktop why dsh-stm32` 应显示 `0.1.2`；重启后 `/stm32-doctor` 有输出。

> **首次使用要联网拉一次资源包**：插件不内置任何芯片表，设备事实（型号 → 启动文件 / 设备宏 / Flash·RAM 容量）在第一次用到时由 `stm32_assets` 自动装一次（`profile: "core"`，30 个文件约 237 KiB：芯片表 + 内存布局 + `.ioc` 模板 + 链接脚本）。装好之后整条链离线可用，换版本才会再联网。


**卸载**：`dsh plugin --profile desktop remove dsh-stm32`，重启 dsh。

### 源码安装（要改代码时）

```powershell
git clone https://github.com/JingYu-er/dsh-stm32.git
cd dsh-stm32
npm install --no-audit --no-fund   # 只装 typescript
npm run build                       # tsc -> lib/（提交前必须跑）
npm test                            # 可选：497 个离线用例、34 个套件，不需要板子
npm run test:pack                   # 打包 tarball → 解包 → 用解包出来的 lib 真建一次寄存器工程
npm run test:size                   # 包体护栏：tarball ≤1.2 MB、templates ≤60 KB、包内不许二进制/图表
```

挂进 dsh 的 profile——**改代码时必须用 `link:`，不要用 `file:`**：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add "link:D:\path\to\dsh-stm32"

# 然后在同一目录的 package.json 里，把 "dsh-stm32" 加到 dsh.profile.bundles 数组末尾
# 最后重启 dsh（bundle 层只在进程启动时加载）
```

> **为什么改代码必须 `link:`**：pnpm 在 `nodeLinker: hoisted` 下会把 `file:` 依赖复制成真实目录，之后你重新 `tsc` 出的 `lib/` 宿主读不到——表现为"改完代码、重启还是旧行为"。用 `link:` 时 `lib/` 是实时读的，但**仍然要重启 dsh** 才会重新加载插件。`github:` / npm 装的是拷贝，改代码后要重新构建、重新安装。

## 快速开始：最小验证（空目录到灯在闪）

下面这条链在真板上跑通过（A1 验收，2026-10-22），全程由模型调用工具完成。注意它只是**最小验证**——每一步用的都是同一套工具，闪灯只是最省的样例：

| 步 | 做什么 | 工具 | 实测耗时 |
| --- | --- | --- | --- |
| 1 | 体检：工具链、被占用的探针、端口、`.elf`、`.ioc` 告警 | `stm32_doctor` | ~2 s |
| 2 | 空目录建 CMake 工程骨架（14 个模板文件 + 629 个固件文件 + 配好 SWD 的 `.ioc`） | `stm32_project_create` | ~2 s |
| 3 | 按 `.ioc` 无头跑 CubeMX，产物落到 `Core/` | `stm32_generate` | 首次 130–175 s；之后再跑，`.ioc` 与产物都没变会**直接跳过**（<1 s） |
| 4 | 编译（首次自动 `cmake --preset`） | `stm32_build` | 配置 ~5 s + 编译 3 s |
| 5 | **只烧录**：program + verify + reset | `stm32_flash` | 2.1–2.6 s |
| 6 | 读回 `GPIOC_ODR`，确认状态确实在翻 | `stm32_regs_read` | 0.4–1.3 s |

模型侧就是一句话：「在 `D:\work\blink` 建一个 STM32F103C8T6 的闪灯工程，编译并烧进去」。想自己敲就：

```text
/stm32-doctor         # 开工前体检
/stm32-env            # 只看四项能力缺什么（缺件也能看）
/stm32-build          # 编译，打印内存占用与错误
/stm32-flash          # 只烧录，不进调试会话
/stm32-debug          # 烧录 + 停在 main
/stm32-stop           # 关掉调试会话，把探针还给 VS Code
/stm32-setup          # 体检 + 安装计划（说「装」才真装）
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

所以闪灯是验收用的最小样例，不是这套工具的能力上限：**它覆盖的是整条工程链，而不是一个 demo。** 真正的边界在[已知限制](#已知限制)里——芯片支持 F1 全系（F100/101/102/103/105/107，本机验证板是 C8T6）但只到 F1、宿主只在 Windows 上验证、探针默认 CMSIS-DAP，以及上面那条「新增外设要手工补 HAL 源」。外设种类本身不受工具限制：`.ioc` 里配得出来的，生成、编译、烧录、读回都走同一条链；只是除闪灯外还没有逐项上板实测，正式开项目前先跑一遍 `stm32_doctor`。

## 功能一览

| 能力 | 提供方式 |
| --- | --- |
| 环境体检 | `stm32_env_probe`（只读）、`stm32_doctor`（工具链 + 探针占用 + 端口 + 工程告警） |
| 开工前门禁 | 每个会动工具链的工具先过 `ensureToolchain`：缺件就拦住并写清装什么、缺了会怎样；`envCheck: "block"`（默认）/ `"warn"` / `"off"` 由调用方决定 |
| 装工具链 | `stm32_env_install`：先只出计划（下载什么、多大、要改哪条 PATH），你点头才真装 MSYS2 + 5 个 pacman 包 + 用户级 PATH，装完自己写进配置文件 |
| 选技术路线 | `stm32_route_plan`：先按**这个工程**的需求，把每个外设的 HAL 版与寄存器版代价摆出来（效率 / 可读性 / 排错），再告诉你缺的是「能代装的」还是「只能人装的」（CubeMX 是 GUI 向导 + 要 ST 账号、固件包只由 CubeMX 包管理器维护） |
| 设备事实（型号 → 启动文件 / 设备宏 / 容量） | 插件**不内置芯片表**：型号、启动文件、设备宏、Flash/RAM 这些事实只从本地资源包缓存读（`~/.dsh-stm32/assets/<版本>/device/f1/chips.json`，`DSH_STM32_ASSETS` 可换根目录），第一次用到时自动装一次（`stm32_assets` 的 `refresh`），装好之后离线可用。没网又没缓存时 `stm32_project_create` / `stm32_doctor` 会明说「先跑 stm32_assets refresh，或检查网络」，不会拿内置表凑一个可能错的启动文件名 |
| 从零建工程 | `stm32_project_create`：`route: "hal"` 用模板快照 + 固件包 Drivers（与 CubeMX GUI 新建的工程逐字节一致）；`route: "register"` 建不用 CubeMX 的寄存器版工程，CMSIS 模板首次从网上下到缓存、之后复用（每个文件都钉了上游 sha256，改过就拒绝落盘）；`mcu` 指定型号（两条路线都吃；HAL 路线按型号渲染启动文件 / 设备宏 / `<DeviceId>_FLASH.ld`）；两条路线都会带一份 `openocd.cfg`（CMSIS-DAP + `hla_swd` + 2 MHz） |
| 导出工程 | `stm32_project_export`：源码打成一个 zip（默认不带 `build/`、`.dsh-stm32/`、`node_modules/`、`.git/`），可选把 `.elf` 一起带上，并写一份开箱 README |
| `.ioc` 事务 | `stm32_ioc_inspect`（只读解析）→ `stm32_ioc_plan`（算 diff，不写盘）→ `stm32_ioc_apply`（SHA 校验 + 备份 + 回滚） |
| 只改 USER CODE | `stm32_code_patch`：只写 `/* USER CODE BEGIN X */` 与 `END X` 之间，块外逐字节不动 |
| 生成代码 | `stm32_generate`：无头 CubeMX + 按 ST 结构落位 + USER CODE 按标签搬回 |
| 编译 | `stm32_build`：构建目录与 `.elf` 自动推断、错误去重、链接后解析 RAM/FLASH 占用；`artifacts` 里要 `hex` / `bin` 就用同一套 `arm-none-eabi-objcopy` 转出来 |
| 烧录 | `stm32_flash`：openocd `program verify reset exit`，烧完释放探针；烧前检查 `.ioc` 是否开了 Serial Wire；失败时给结构化 `probeError`（`kind` / `cause` / `hint` / `evidence` / `retryable`，`kind` 收 8 类） |
| 调试 | `stm32_debug_run` / `stm32_debug_session` / `stm32_debug_eval` / `stm32_debug_stop` |
| 验证"真的在跑" | `stm32_regs_read`：按物理地址把任意外设寄存器读回来，halt 读值后 `resume`，不复位芯片 |
| 给模型的工作纪律 | 随插件下发 SKILL `stm32-workflow`（只改 USER CODE、不动生成区、烧录与调试分开、结论要带寄存器证据） |

## 工具参考

### 环境与工程

| 工具 | 作用 |
| --- | --- |
| `stm32_env_probe` | 探测 gcc / gdb / openocd / cmake / ninja / CubeMX / JRE 的路径与版本；缺什么会写清影响（编译不了 / 烧不了 / 调不了 / 建不了工程）、推荐装法（含可粘贴的 pacman / winget 命令）、装完自检命令，并给 `capabilities`（四项能力是否可用）与 `recommendations`（安装顺序 + 要不要我帮你装）。只读、可重复调 |
| `stm32_env_install` | 缺工具链时的一条龙：`dryRun`（默认）只给计划——官方 MSYS2 安装包多大、要装哪 5 个包、PATH 会加哪一条；`dryRun: false` + `confirm: true` 才真干活（下载 → 装 MSYS2 → `pacman -S` → 写 **用户级** PATH → 自检 → 写 `~/.dsh-stm32/config.json`）。已装 msys64 时只补包。不做卸载 |
| `stm32_route_plan` | 动手前先把路线问清楚：`requirement` 必填（如「按键控制 LED，串口每秒打印一次状态」），返回 `verdict`（`register-ok` / `both-viable` / `hal-only` / `unclear`）、逐外设的 `halEffort`/`regEffort` 与 `advice`、两种写法的差别、落地的下一步、工具链缺件（每条标 `installability`：`auto` 可代装 / `manual` 只能人装）与手动安装指引全文。不做通用对照表——结论只对当前需求成立 |
| `stm32_doctor` | 一次回答三件事：工具链齐不齐、探针被谁占（`openocd.exe` / gdb 进程 / 3333 端口）、这个工程能不能烧 |
| `stm32_project_create` | 空目录 → 完整 CMake 工程。`route: "hal"`（默认）走 CubeMX 那套（含 `.vscode` 里"① 只烧录 / ② 烧录并调试"两份配置）；`route: "register"` 建**不用 CubeMX、不用 HAL** 的寄存器版工程（`mcu` 指定型号——F1 全系都吃；寄存器版从缓存取 CMSIS 头与启动文件，HAL 版按型号渲染启动文件 / 设备宏 / `.ld`）。目标目录非空默认拒绝，`overwrite: true` 才覆盖 |
| `stm32_assets` | 管**设备事实资源包**（芯片表 / 内存布局 / .ioc 模板 / 链接脚本 / SVD，不是 CMSIS 下载缓存）：`action: "refresh"`（默认 `profile: "core"`，约 180 KB；已装同版本直接复用）从 GitHub → jsDelivr → gitcode 多源拉 `manifest.json`，逐文件钉 sha256 装到 `~/.dsh-stm32/assets/<版本>/`；`list` / `verify` / `prune` 管各版本。**插件不再内置任何芯片表**，设备事实只从这里读，第一次用要联网装一次，装好后离线可用 |
| `stm32_cache` | 看 / 验 / 拉 / 清下载缓存：`action: "list"`（默认）列条目、`"verify"` 逐文件校验、`"fetch"` 按 `mcu` 拉一次模板（已缓存则直接复用，不联网）、`"purge"` 删条目（不给 `id` 就清空）。缓存里放的是"不属于插件、但建工程要用"的 CMSIS 设备头 + 启动文件 + 内核头，第一次用时才下载，之后一直复用 |
| `stm32_project_export` | 把工程打成一个 zip 交给别人：默认收源码、CMake、`.vscode`、`.ioc`，跳过 `build/`、`.dsh-stm32/`、`node_modules/`、`.git/`；`includePrebuilt: true` 把 `.elf` 一起带上，`readme: false` 不写包内 README，`outDir` 指定落点（默认工程同级的 `<name>-export.zip`） |
| `stm32_firmware_install` | 缺固件包时的一条龙：`dryRun`（默认）只出计划——装到哪、下哪两个源码仓、几条自检判据；`dryRun: false` + `confirm: true` 才真下（GitHub 上 HAL 驱动与 CMSIS 设备支持两个源码包 + 内核头，合计约 2 MB），组装成与官方同构的 `STM32Cube_FW_<族>_V<版本>` 包（自写 `package.xml`）并过五条自检。已有官方包时什么都不做；默认装到 `<CubeMX 根>/dsh-firmware`（不是 `Repository`——塞自造版本号会被 CubeMX 静默忽略），生成时由 `stm32_generate` 用 `setCustomFWPath` 指过去 |

### .ioc：只读与事务

| 工具 | 作用 |
| --- | --- |
| `stm32_ioc_inspect` | 解析 MCU 型号、引脚/信号/标签、外设与中断、时钟树、工程设置；会报「没开 Serial Wire 会生成 `SWJ_DISABLE`」这类致命风险 |
| `stm32_ioc_plan` | 改 `.ioc` 的第一步：算出逐键 diff 与源 SHA-256，返回 `planId`，**不动源文件**。支持改键、删键、按引脚表加 GPIO、一键补 Serial Wire、按目标频率改时钟（`clock: { targetHz }`，就近取档 + 派生键重算 + 逐外设频率） |
| `stm32_ioc_apply` | 必须带 `planId`；写盘前再核 SHA（中途被手改就拒绝），备份后原子替换，写完重新解析校验，不过自动回滚。支持 `rollbackFrom` |

### 代码与构建

| 工具 | 作用 |
| --- | --- |
| `stm32_code_patch` | 只在 `USER CODE` 块内 replace/append；块外字节（含 CRLF）原样保留；写前备份、临时文件 + rename 原子替换。标签写错会把该文件所有可用标签列给你 |
| `stm32_generate` | 无头跑 `java -jar STM32CubeMX.exe -q`，成功后落位到 `Core/Src`、`Core/Inc`，旧文件的 USER CODE 按标签搬进新内容。默认后台 job。**`.ioc`、CubeMX 版本、产物 hash 都没变时直接复用上次结果**（`skipped: true`，约 1 s；传 `skipIfUnchanged: false` 或删 `.dsh-stm32/generate-cache.json` 可强制重跑）。工程没用 X-CUBE 扩展包时（`Mcu.ThirdPartyNb=0`）会自动把 `~/.stm32cubemx/thirdparties/pdsc` 临时停放、跑完还原，省约 25 s；要保留索引传 `thirdpartyPacks: "keep"`。**要不要索引不靠关键词猜**：`.ioc` 里的 `Mcu.ThirdParty0=STMicroelectronics.X-CUBE-ALGOBUILD.1.4.0` 会跟内置的 X-CUBE 包目录（67 个包，`scripts/gen-xcube-catalog.mjs` 生成）对名字，本机缺这个包会提前在 notes 里警告 |
| `stm32_build` | `cmake --build`，构建目录从 `CMakePresets.json` 与 `build/*/CMakeCache.txt` 推断；首次构建自动 configure；会拦住"CMakeCache 目录不一致但 ninja 退出码 0"的假成功。`artifacts: ["hex","bin"]` 时链接后用 `arm-none-eabi-objcopy` 转出，转换失败只记 note、不判编译失败 |

### 烧录与调试

| 工具 | 作用 |
| --- | --- |
| `stm32_flash` | **烧录**：openocd `program verify reset exit`，不建调试会话、不停 `main`。烧前读 `.ioc`，调试口没开就拒绝（见 [设计要点](#设计要点)）。失败会带结构化 `probeError`：`kind`（`no-probe` / `probe-busy` / `swd-locked` / `flash-protected` / `no-power` / `target-mismatch` / `timeout` / `unknown` 共 8 类）、`cause`（一句话根因）、`hint`（可执行的下一步，每类都有专属建议）、`evidence`（原始日志行）、`retryable`（照 hint 处理完再调一次有没有意义）；成功时这个字段根本不出现。日志里找不到设备时，还会把 USB 形态（这台机器没有 USB / 没插探针 / 驱动异常）写进 notes |
| `stm32_debug_run` | 起 openocd + gdb，`break main` → `continue` → 抓 pc/sp/lr/bt/locals → `reset run` + `detach`，不写 Flash、不常驻。硬件断点 / 观察点超芯片上限（F1 是 6 个断点 / 4 个观察点）会在起 openocd **之前**就报错，不占探针 |
| `stm32_debug_session` | 常驻 openocd 会话（`.elf` 自动解析），空闲 90 s 自动关、硬上限 10 min |
| `stm32_debug_eval` | 在会话里执行 gdb 命令或读表达式（如 `g_led_blink_count`），读完立刻 `resume` + `detach` |
| `stm32_debug_stop` | 立刻释放探针，幂等 |
| `stm32_regs_read` | 读 `GPIOC_ODR`、`AFIO_MAPR` 等物理地址；收尾用 `resume` 而不是 `reset run`，避免读一眼就把固件状态清零。连读时复用常驻 openocd 会话（毫秒级，不另起进程），没有会话才起一次并保留 90 s |

## 斜杠命令

工具是给模型调的；你要自己动手时用命令，一条命令一个动作，不经过模型决策。

| 命令 | 做什么 | 会不会动板子 |
| --- | --- | --- |
| `/stm32-doctor` | 体检：工具链、被占用的调试进程、端口、`.elf`、`.ioc` 告警 | 否 |
| `/stm32-setup` | 体检 + 安装计划一次跑完；命令里带「装」字才真装（例如 `/stm32-setup 装上缺的`） | 否 |
| `/stm32-env` | 看四项能力（编译 / 烧录 / 调试 / 生成代码）各缺什么、装什么、装完怎么自检；缺件也照常出卡片 | 否 |
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

## 芯片、链接脚本与时钟

- **型号是参数，不是常量。** `stm32_project_create` / `stm32_generate` 按 `mcu` 一起换三样：启动文件（`startup_stm32f103xe.s`）、设备宏（`STM32F103xE`）、链接脚本（`STM32F103RCTx_FLASH.ld`）。HAL 路线走 `src/engine/hal-chip.ts`（`resolveHalChip()` + `renderStartupAndDefine` / `renderLinkerScript` / `renderIoc`），寄存器路线走 `src/data/stm32f1.ts`（`resolveF1Chip()`，14 个容量档，每个启动文件都钉了上游 sha256）。认不出的型号直接给原因，不猜一个上游不存在的启动文件名。
- **链接脚本按 `DeviceId` 命名：`<DeviceId>_FLASH.ld`。** C8T6 → `STM32F103C8Tx_FLASH.ld`（64 KiB Flash / 20 KiB RAM），RCT6 → `STM32F103RCTx_FLASH.ld`（256 / 48），F107VCT6 → `STM32F107VCTx_FLASH.ld`（256 / 64）。模板里那份旧的 `STM32F103XX_FLASH.ld` 只作 C8T6 的兼容副本；CMake 的 `-T` 一律指向按型号渲染的那份（`pointLinkerFlagAt()` 把工具链文件里的旧名改指过去，避免两个 `-T` 让 ld 取错脚本）。
- **时钟就近，不可达就明说。** `stm32_ioc_plan` 的 `clock: { targetHz }`（也可 `pllMul` 钉死倍频、`pllSource` 选 HSE / HSI）枚举全部可行的 PLL 组合，取 |SYSCLK − 目标| 最小的一档，并把差距写进结论：要 60 MHz 时 F1 的 PLL 只能整数倍频、HSE 8 MHz 拼不出这一档，于是选 64 MHz 并标注「不可达，已选 64 MHz（+4 MHz）」（同距取更高档）。同一次 plan 里把 `SYSCLKFreq_VALUE` / `HCLKFre` / `PLLMUL` / APB1·APB2·ADC 分频这些派生键**全量重算**——只改 SYSCLK 不动它们，CubeMX 会按旧值重算或干脆不认；同时列出逐外设频率、UART 波特率的整除误差与几个备选档。超限（SYSCLK > 72 MHz、APB1 > 36 MHz、ADC > 14 MHz、USB 要 48 MHz 却不在 PLLCLK/1.5 这条路上）时**一个键都不写**。
- **烧前五项一致。** `stm32_doctor` 核对「`.ioc` 型号 ↔ 启动文件名 ↔ cmake 里的设备宏 ↔ `.ld` 的 MEMORY 容量 ↔ `.elf` 的 Flash 占用」，任一错配报 blocker。`.elf` 那份占用是读 ELF program header 的 `p_filesz` 累加，不是文件大小——带 `-g3` 时 20 KiB 固件的 `.elf` 能有 600 KB，按文件大小判会误报「超 Flash」。
## 配置

### 用户配置文件（`~/.dsh-stm32/config.json`）

工具装在哪，插件自己记。`stm32_env_install` 装完会写这个文件，之后所有工具读它——**不用重启 DSH、也不用设环境变量**。手写也行：

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

`binDirs` 留空时由 `msys64` 推出 `<msys64>/ucrt64/bin`——安装器写的就是这个形状。文件坏了（JSON 不合法）不会让工具报错，只是当它不存在。

**优先级**：工具参数（`binDirs` / `cubeMxRoots`）> 环境变量 > 这个配置文件 > 内置默认值；自动发现只追加在"没点名参数"的那一档尾部。

**内置默认值里没有任何"某台机器专属"的路径**：只有 `C:/msys64/...` 与 `C:/Program Files/...` 这种 Windows 默认安装位置，装在别处靠自动发现兜底。配置或环境变量里点名的目录如果在本机不存在（典型情况：配置是从别的机器拷过来的，带着 `D:/app/msys64` 这种路径），门禁与 `stm32_env_probe` 会明确写一句「配置文件里的 X 在本机不存在……这一条搜不到工具」，而**不会**悄悄改你的配置；安装器也不会拿这种路径当安装目标（盘符都没有时只提示、并要求你给 `targetDir`）。

### 设置面板（GUI）

上面那个配置文件也能不碰命令行改：DSH 的 **设置 → STM32 工具链**（插件自带的浏览器端面板，与宿主同源，零额外依赖）。三张卡：

- **装在哪**：读当前配置，改 `msys64` / `cubeMxRoot` / 额外 `binDirs` 后保存——写的就是上面那个文件，下一条工具调用就读得到，不用重开 DSH；
- **缺什么**：跑一次探测（会执行各工具的版本命令，不装任何东西），逐项显示找到的路径与版本、缺件的 `hint`，以及编译 / 烧录 / 调试 / 生成四项能力徽章；
- **装工具链**：先出计划（步骤、下载体积、PATH 与配置会怎么改），**再点一次确认**才真装；装的过程实时显示步骤与日志尾巴，实际执行与 `stm32_env_install` 是同一个安装器。工具链已经完整时，计划只回一句话「工具链完整，不需要装任何东西」，不列那七行「已跳过」。

接口是插件注册在宿主上的六条 `/dsh-stm32/api/*`（读配置、存配置、探测、安装计划、开始安装、安装进度）；面板产物是 `lib/client.js`，源码在 `client/client.js`，由 `npm run build` 原样复制——手写纯 JS、只 `require("react")`，不引入打包器或运行时依赖。宿主没有 `webServer` 服务时（纯 CLI 组合）这层注册自动跳过，工具与斜杠命令不受影响。

### 下载缓存（寄存器版模板）

寄存器版工程要的 CMSIS 设备头、启动文件、内核头**不预置进插件**（要覆盖任意 STM32，每颗都打一份会让包大到不可用），而是第一次用时从网上下载，落到一个可检索的缓存目录，之后一直复用：

- 位置：`DSH_STM32_CACHE`（支持 `~`）> `%LOCALAPPDATA%\dsh-stm32\cache`；
- 索引：缓存根下 `index.json` 记录每条源 URL、字节数、许可（`THIRD_PARTY_NOTICES.md` 随条目一起写）；
- 下载源：按 `fastly.jsdelivr` → `cdn.jsdelivr` → `raw.githubusercontent` → `ghproxy` 的顺序回退，HTTP 错误 / 内容像网页 / 字节数明显不对都算该源失败；
- 半截缓存会被整条删掉（比没有缓存更糟）；条目文件缺失或大小对不上时下次自动重下；
- 看得见、清得掉：`stm32_cache` 的 `list` / `verify` / `fetch` / `purge`。

### 固件包下载（HAL 路线）

CubeMX 装好也不一定有**这一颗芯片**的固件包（安装包里不带，得在包管理器里另装）。插件能代下的那一代，`stm32_firmware_install` 会从 GitHub 拉两个源码包组装出来：

- 下什么：`stm32f1xx-hal-driver`（HAL 驱动，BSD-3-Clause）+ `cmsis-device-f1`（设备头与启动文件，Apache-2.0）+ 5 个 CMSIS 内核头，合计约 2 MB、几秒钟；
- 为什么不能直接解压 `STM32CubeF1` 的源码包：它的 HAL 与 CMSIS 设备目录是 **git 子模块**，tarball 里是空目录——解压出来编译必挂（缺 startup、缺 HAL 源文件）；
- 装到哪：默认 `<CubeMX 根>/dsh-firmware/<包名>`（与 `Repository` 并列、插件自建，不动官方包）；这个根写不进去才退回用户缓存目录。**别往 `Repository` 里塞自造版本号**——实测 CubeMX 认不出那个版本名，不报错地退回它自己认识的包（生成「成功」，HAL 却是旧版）；
- 生成时怎么用上它：`stm32_generate` 按 `.ioc` 的 `ProjectManager.FirmwarePackage` 找包（`Repository` 与 `<CubeMX 根>/dsh-firmware` 都找），并在 CubeMX 脚本里发 `project setCustomFWPath <包目录>`——这是唯一被实测有效的机制，不往 `.ioc` 里写绝对路径；
- 组装包与官方包同构：自写 6 行 `package.xml`（版本串 `FW.<族>.<x.y.z>`）与 `THIRD_PARTY_NOTICES.md`，**不含任何哈希/清单**——CubeMX 也不校验来源（已实测：用 `setCustomFWPath` 指过去生成，拷出的 HAL 源文件逐字节来自我们目录）；
- 但「生成成功」不能当验收：`.ioc` 点名了不存在的包时 CubeMX 不报错、退出码 0、只是不拷 HAL。所以装完必须过五条判据（内核头 / HAL Inc / HAL Src / 设备头 / `startup_*.s`），插件装完自己就验一遍。

### 环境变量（可选）

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `STM32_BIN_DIRS` | 工具链目录候选，`;` 分隔，**整份替换**内置列表（之后的自动发现仍追加在尾部） | `C:/msys64/ucrt64/bin`、`C:/msys64/mingw64/bin` |
| `STM32_CUBEMX_ROOT` | STM32CubeMX 安装根目录，**整份替换**内置列表 | `C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeMX` |
| `STM32_NO_DISCOVER` | 设为 `1` / `true` 关掉下面的自动发现（CI、只想用内置列表时） | 不设 = 开着 |
| `DSH_STM32_CONFIG` | 换一个配置文件路径（多份工具链 / 多工程隔离） | `%USERPROFILE%\.dsh-stm32\config.json` |
| `DSH_STM32_NO_CONFIG` | 设为 `1` / `true` 完全不读配置文件（只想走环境变量时） | 不设 = 读 |
| `DSH_STM32_CACHE` | 下载缓存根目录（寄存器版模板等），支持 `~` | `%LOCALAPPDATA%\dsh-stm32\cache` |
| `DSH_STM32_E2E_PROJECT` | 真机 e2e 用的工程（含 `openocd.cfg` 与 `build/Debug/*.elf`） | 无 |
| `DSH_STM32_E2E_ROOT` | e2e 临时副本目录 | 系统临时目录 |

也可以按调用传参：烧录/调试类工具都接受 `binDirs`、`elfPath`、`buildDir`、`configFile`、`adapterSpeed`；生成/建工程类接受 `cubeMxRoots`、`firmwarePackage`。

**自动发现（换台机器通常不用配任何变量）。** 没给 `binDirs` / `STM32_BIN_DIRS` 时，插件会扫一遍常见位置，把找到的目录**追加**在候选列表尾部：

- 工具链：`<盘>/msys64`、`<盘>/msys2`、`<盘>/app/msys64`、`<盘>/tools/msys64`、`%LOCALAPPDATA%/Programs/msys64` 下的 `ucrt64/bin`、`mingw64/bin`、`clang64/bin`（该目录里得真有 `arm-none-eabi-gcc.exe` / `openocd.exe` / `cmake.exe`）。
- CubeMX：注册表 `HKLM|HKCU\SOFTWARE\STMicroelectronics\STM32CubeMX` 的 `InstallDir`、`...\Uninstall\STM32CubeMX` 的 `InstallLocation`，以及 `<盘>/`、`<盘>/app`、`<盘>/tools`、`Program Files\STMicroelectronics\STM32Cube`、`%LOCALAPPDATA%/Programs` 下的 `STM32CubeMX`（要求 `STM32CubeMX.exe` 与 `jre/bin/java.exe` 都在）。

扫一次约 1 s，进程内缓存。**用工具参数点名 `binDirs` / `cubeMxRoots` 时不追加**——你指哪儿就用哪儿，免得"我明明指定了"变成假的。环境变量里的路径会先净化（去引号、反斜杠转正斜杠、折叠重复斜杠），不用怕 `setx "D:\app\msys64\ucrt64\bin"` 带进来的引号。找不到工具时，报错和 `stm32_doctor` 的 notes 都会列出「查过哪些目录」。

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
| 只覆盖 **STM32F1 全系** | 型号 → 启动文件 / 设备宏 / 链接脚本的映射只做了 F1（`src/data/stm32f1.ts` + `src/engine/hal-chip.ts`，14 个容量档）；时钟树也只认 F1（HSE 8 MHz、PLL ×2..×16、SYSCLK ≤72 MHz） | 加其它族要补真实仓库名与逐文件实测 sha256（`src/data/cmsis-sources.ts`、`src/data/firmware-packages.ts`）并补一份时钟上限表；引脚表可由本机 CubeMX `db/mcu/*.xml` 派生（`deriveChipPinTable`） |
| 默认探针是 **CMSIS-DAP** | 没有 `openocd.cfg` 时回退 cmsis-dap | 用 `openocd.cfg` 换 `interface/stlink.cfg`（见上） |
| 新增外设要**手工补 HAL 源** | 插件只落位 CubeMX 的 `Src/` 与 `Inc/`（→ `Core/Src`、`Core/Inc`），CubeMX 生成的 `cmake/stm32cubemx/CMakeLists.txt` 不搬；开了定时器/串口/ADC 之后要自己把 `stm32f1xx_hal_<外设>.c` 加进源清单 | 改工程里 `cmake/stm32cubemx/CMakeLists.txt` 的 `STM32_Drivers_Src`，或写进 `cmake/user/CMakeLists.txt` 的 `target_sources` |
| 生成/建工程需要 **CubeMX + F1 固件包** | 固件包版本默认 `STM32Cube_FW_F1_V1.8.7` | 换版本传 `firmwarePackage` |
| 未在别人的机器上验证 | 本机：Windows 10 + MSYS2 UCRT64 + DAPLink + 蓝丸；其余组合靠反馈 | 遇到问题请附 `stm32_doctor` 的完整输出开 issue |

## 排错

| 现象 | 原因与处理 |
| --- | --- |
| 装插件时 `ERR_PNPM_GIT_UNKNOWN_ERROR … connect ETIMEDOUT …:443` | 这是**取包这一跳**连不上 GitHub（`dsh plugin add github:…` 会走 git 去拉仓库），跟 pnpm 11 的 `allowBuilds` 白名单、包体签名、包本身都没关系——换个网络就能装上。三条路按省事程度排：① 用 npm 上的正式包：`dsh plugin --profile desktop add dsh-stm32`（走 npm registry，不碰 GitHub）；② 一定要从 GitHub 装，就只给这一条命令挂代理，用进程级 `GIT_CONFIG_*` 临时生效、**不动你的全局 git 配置**：`$env:GIT_CONFIG_COUNT="1"; $env:GIT_CONFIG_KEY_0="http.https://github.com.proxy"; $env:GIT_CONFIG_VALUE_0="http://127.0.0.1:7890"; dsh plugin --profile desktop add github:JingYu-er/dsh-stm32#main`（端口换成你自己的）；③ 绕开 git、直接吃 HTTPS 包：`dsh plugin --profile desktop add https://codeload.github.com/JingYu-er/dsh-stm32/tar.gz/refs/heads/main`。**装最新**永远用 `github:JingYu-er/dsh-stm32#main`，已经 publish 的版本用 `dsh-stm32@latest`——两者内容一致，后者不依赖 GitHub |
| 烧完连不上、SWD 失联 | 固件里生成了 `__HAL_AFIO_REMAP_SWJ_DISABLE()`。按住 BOOT0 上电进系统 bootloader 重烧，然后把 SYS 设回 Serial Wire——`stm32_flash` 现在会先拦这种情况 |
| `Error: No device found` / `transfer count mismatch` | 探针被别的进程占着。先 `/stm32-stop`，再用 `stm32_doctor` 看 openocd / gdb 进程与 3333 端口。调试会话开着时读寄存器不会再有这个问题：`stm32_regs_read` 复用会话的 openocd，不另起第二个 |
| 调试会话开着时读寄存器，`report.command` 是一条 `gdb-multiarch … target extended-remote 127.0.0.1:3333` | 这是「复用会话」的正常形态：`stm32_debug_session` 活着时，`stm32_regs_read` 借用会话里那个 openocd，notes 会写清「复用调试会话（gdb 端口 N，tcl 端口 M），没有另起 openocd」。B3 之后默认走 **Tcl RPC 直读**（一条 TCP 连接：halt → 读 pc → 连续 `mdw` → resume，毫秒级），所以 `report.command` 是 `gdb-multiarch …` 只说明 Tcl 快路径没成、回退到了会话里的 gdb，原因写在 notes 里；只有没有会话时才另起 openocd。旧版在这里会报 `CMSIS-DAP transfer count mismatch: expected N, got M` |
| 编译"成功"但跑的是旧固件 | 复制或改名过带 `build/` 的工程：CMakeCache 里的目录对不上，ninja 仍退出 0。`stm32_build` 会判失败；按提示 clean 或删 `build/Debug` |
| 工具直接回「缺 arm-none-eabi-gcc…，这次没有开始编译」 | 这是开工前门禁（`envCheck` 默认 `block`）拦下来的，不是 bug：它比跑到一半才发现省时间。回一句「装」，模型调 `stm32_env_install` 出计划；确认后装好并写配置文件，**下一条命令就能用，不必重启**。想先看全貌就 `/stm32-env`；只想先跑起来就传 `envCheck: "warn"`（照做但写警告）或 `"off"`（不查） |
| 第一次建工程回「设备事实还没就绪……先跑 stm32_assets refresh，或检查网络」 | 插件不内置芯片表：型号 → 启动文件 / 设备宏 / Flash / RAM 的事实只从本地资源包缓存（`~/.dsh-stm32/assets/<版本>/`）读。联网跑一次 `stm32_assets`（`action: "refresh"`，默认 `profile: "core"`，约 180 KB），装好后离线可用；`DSH_STM32_ASSETS` 可换根目录 |
| `stm32_doctor` 说找不到 gcc / openocd | 先看 doctor 的 notes / 报错里的「查过 …」列表与自动发现结果；装上后还找不到就设 `STM32_BIN_DIRS` 或给工具传 `binDirs`。**不知道装什么就先跑 `stm32_env_probe`**：每条缺失项都带 `impact`（缺了影响哪些功能）、`install`（推荐装法，第一条最省事）、`verify`（装完自检），顶层 `recommendations` 给出安装顺序，还会问要不要帮你装 |
| `stm32_generate` 很慢或像卡住 | 首次（冷启动、无缓存）3.5–4 分钟属正常，之后 .ioc 与产物没变会直接跳过（<1 s）。默认后台 job，用 `job_output` 看进度，或传 `foreground: true` 同步等。想确认是不是漏命中缓存，看返回里的 `skipped` 与 notes 给的 reason |
| 生成没变化却每次都跑满 3 分钟 | 缓存键里含 CubeMX 的 size+mtime 与产物 hash：换过 CubeMX、改过生成区文件、或改过落位布局都会失效。看 notes 里的 reason，或删 `.dsh-stm32/generate-cache.json` 从干净状态重来 |
| 生成变快了，但 CubeMX GUI 里看不到扩展包了 | `thirdpartyPacks: "auto"` 会在不需要扩展包时把 `thirdparties/pdsc` 停放成 `pdsc.dsh-parked`，生成结束自动还原。若正在 CubeMX GUI 里手工选包，传 `thirdpartyPacks: "keep"` |
| notes 说「本机第三方包索引里没有这个包」 | 工程要用的 X-CUBE 包本机没装（判定靠 `.ioc` 里的 `Mcu.ThirdParty<k>` 与内置包目录对名字）。在 CubeMX 的 Manage embedded software packages 里装上它再生成。这条在**生成失败的报告里也会出现**（超时/报错时照样带 notes，先看 notes 再猜原因）。内置目录是快照，装了新包后重跑 `node scripts/gen-xcube-catalog.mjs` 更新（旧的目录只是不认识新包，不会误判成「不需要」） |
| `stm32_code_patch` 说块不存在 | `main.c` 里是短标签（`PV`=私有变量、`PFP`=函数原型、`2`=while 前初始化、`3`=循环体）；报错会列出该文件全部可用标签，照抄即可 |

## 开发与测试

```powershell
npm run build            # tsc -> lib/（lib/ 入库，改完 src 必须重建后一起提交）
npm test                 # 34 个离线套件、497 个用例；不需要板子、CubeMX、工具链
npm run test:pack        # 把包打成 tarball、解开、用解包出来的 lib 真建一次寄存器工程
npm run test:size        # 包体护栏：tarball ≤1.2 MB、templates ≤60 KB、包内不许二进制/图表
```

CI（`.github/workflows/ci.yml`）在每次 push / PR 上跑 `npm ci → build → 检查提交的 lib/ 是否与 src/ 同步 → npm test → test:pack → test:size`（windows-latest）。

GitHub runner 上没有 msys64 / CubeMX，所以有两条依赖真固件包的脚手架用例会 skip：CI 上是 **495 pass + 2 skipped**，开发机上是 497 全跑。离线套件只读仓库自带的 [`test/fixtures/`](test/fixtures/README.md)；会话类用例用 `fakeBinDirs()` 在临时目录造空文件占位的 openocd / gdb，不依赖本机装了什么。

### 发布形态三分法（先把东西放哪想清楚，再写包）

| 放哪 | 内容 | 量级 |
| --- | --- | --- |
| 随包（npm tarball） | `lib/**`（含 `lib/client.js`）、`client/client.js`、`templates/scaffold/**`、`cordis.patch.yml`、两份 README、`LICENSE`、`docs/*.md` | 99 个文件 / 525.7 KB，解包 1538.3 KB；其中 `templates/**` 38.5 KB |
| 进 git 不进包 | `src/**`、`test/**`、`scripts/**`、`docs/diagrams/**`（两张可交互 HTML） | diagrams 2 MB 原始 / 891 KB gz；`package.json` 的 `files` 把 `docs` 收窄成 `docs/*.md` |
| 远端按需下载 | CMSIS 设备头 / 启动文件 / 内核头（寄存器版首次用时下到缓存，逐文件钉 sha256）；HAL 固件包；**设备事实资源包**（chips.json / memory.json / .ioc 模板 / .ld / SVD，core 约 180 KB；插件不再内置芯片表，首次使用要联网拉一次 `stm32_assets refresh`，之后离线可用） | 缓存可用 `stm32_cache list/verify/purge` 与 `stm32_assets list/verify/prune` 管 |
| 现造 | `.ioc` 内容（`renderIoc`）、`.ld` 的 MEMORY（`renderLinkerScript`）、cmake 源清单 | 按型号渲染，模板里不落盘 |

护栏是 `scripts/pack-size.mjs`（`npm run test:size`）：tarball ≤ 1.2 MB（1 200 000 B）、`templates/**` ≤ 60 KB、包内禁止 `.png/.jpg/.gif/.webp/.bmp/.pdf/.html/.zip/.7z/.exe/.dll`，且必须含 `README.md` / `README_EN.md` / `LICENSE` / `cordis.patch.yml` / `docs/reading-guide.md`。

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
  tools/                   20 个工具的 L3 层（参数 schema + 输出契约 + 渲染）
  engine/                  纯逻辑与工作流（generate / build / flash / debug / ioc / scaffold …）
  commands/register.ts     7 条斜杠命令
  skill/stm32-workflow.ts  随插件下发的 SKILL
  data/                    路径与芯片数据（路径是数据不是逻辑）
templates/scaffold/        建工程用的模板快照（CMake / .ld / .vscode / .ioc）
test/                      离线套件（31 个）+ fixtures + 真机 e2e
scripts/                   护栏与生成脚本（pack-size / pack-smoke / gen-xcube-catalog / copy-client）
docs/                      规格书 + 开发笔记 + 精读指南 + diagrams/（不进 npm 包）
```

## 文档

- [规格书](docs/dsh-stm32-plugin-规格.md)：工具契约、状态机、验收 A1–A13 的判定标准
- [开发笔记](docs/development-notes.md)：里程碑、宿主契约踩坑、每个工具的实现细节与实测数据
- [源码精读指南](docs/reading-guide.md)：分层阅读顺序、每个文件的职责与关键导出、14 张流程图、20 条不变量
- 可视化：[架构总览](docs/diagrams/dsh-stm32-architecture.html) / [主线旅程](docs/diagrams/dsh-stm32-journey.html)（单文件 HTML，离线可开，可导出 PNG/SVG）

## 许可证

[MIT](LICENSE)
