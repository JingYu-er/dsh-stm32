# DSH STM32 插件 · 规格书 v0.2

> 状态：需求已定稿，未开始实现。全部结论都有实测证据（见 §8、§12）。
> 上一版 `dsh-stm32-plugin-需求-v0.1.md` 已合并进本文，不再维护（v0.1 的 18 章有大量重复，且其中 D3/D4 两项假设已被实验推翻）。

---

## 1. 定位与范围

**一句话**：给 STM32 工程提供"可编程的确定性执行层"——人/agent 负责意图，插件负责每一步的原子性、可验证性与回滚。

覆盖链路：建工程 → 改 `.ioc` → 生成代码 → 写 USER CODE → 编译 → 只烧录 / 烧录并调试 → 寄存器级验证。

**明确不做（v1）**：

| 项 | 原因 |
|---|---|
| 驱动 CubeMX GUI（UI 自动化） | 不稳定，且已有无头路径 |
| 时钟树可视化编辑 | 只读写 `.ioc` 的 RCC 键 |
| 接管 CubeMX2 / `.ioc2` | 格式不同，会把现有工程搞乱 |
| 升级固件包、HAL 迁移 | 只透传 `.ioc` 里的版本键 |
| FreeRTOS/LwIP 图形化配置 | 只透传键，不做语义理解 |
| 编码风格规范（MISRA 等） | 留给后续 skill，v1 只保证"只写 USER CODE 块" |

## 2. 痛点（全部来自实测，不是设想）

| # | 痛点 | 证据 |
|---|---|---|
| P1 | F5 和 Ctrl+F5 都进调试会话，"只烧录"做不到 | cortex-debug 的 `noDebug` 分支也会 `sendContinue`；CHANGELOG 记 ^F5 = Run Without Debugging（Experimental） |
| P2 | 配引脚/时钟必须开 GUI 手点 | CubeMX 无引脚级脚本 API |
| P3 | CubeMX 脚本模式有假成功 | `STM32CubeMX.exe` 是 launcher，detach 出 javaw 后立刻 exit 0；`load <mcu> + generate` 输出 "succesfully" 但无 `MX_GPIO_Init` |
| P4 | 默认 `No_Debug` → 生成 `__HAL_AFIO_REMAP_SWJ_DISABLE()` → 烧完 SWD 永久失联 | `_scratch/Src/stm32f1xx_hal_msp.c:77`，需 BOOT0 抢救 |
| P5 | 脚本模式只产 C 源，不产 startup / `.ld` / Drivers / CMake | E1/E2 实测（§8.3） |
| P6 | 验证只能"看灯闪不闪" | 最终靠 `AFIO_MAPR(0x40010004)` + `GPIOC_ODR` 采样才敢确认 |

## 3. 核心原则（不变量，实现时不许破）

| # | 原则 | 落地方式 |
|---|---|---|
| I1 | `.ioc` 是唯一真源 | 配置改动只改 `.ioc`，不改生成物 |
| I2 | USER CODE 块之外不许手写 | `code_patch` 只做锚点插入，锚点缺失则拒绝并列出可用锚点 |
| I3 | 改 `.ioc` 永远 plan → 确认 → apply | 无静默写盘；apply 必须带 `plan_id` 且源 SHA-256 与 plan 时一致 |
| I4 | 复刻不发明 | 布局复刻 CubeMX 产物（§7）；脚手架复制或模板快照，不手写 |
| I5 | 外部工具单飞 | 同一时刻只允许一个 CubeMX / openocd / ninja 进程 |
| I6 | 探针默认释放 | 调试默认在一次调用内开关；退出/取消必杀进程树 |
| I7 | 先 build 再 flash | 构建失败绝不烧录 |
| I8 | 每次交付都要可自证 | 寄存器值 / 断点命中 / 计数变量，而不是"看起来对" |

## 4. 工具清单（13 个）

| 工具 | 作用 | 副作用 | 耗时 | 形态 |
|---|---|---|---|---|
| `stm32_env_probe` | 探测 CubeMX、固件包、gcc/gdb/openocd/cmake/ninja、探针 | 只读 | <3 s | 阻塞 |
| `stm32_project_create` | 从 MCU 型号建工程骨架（`.ioc` + CMake 工程文件 + 固件包 Drivers） | 建目录 | ~2 s | 阻塞 |
| `stm32_ioc_inspect` | `.ioc` → 结构化 JSON（引脚/信号/标签/时钟/项目设置） | 只读 | <1 s | 阻塞 |
| `stm32_ioc_plan` | 变更计划：改哪些键、diff、源 SHA-256、`plan_id` | 只读 | <1 s | 阻塞 |
| `stm32_ioc_apply` | 校验暂存副本 → 备份 → 替换 `.ioc` | 改 1 文件 | 90–150 s | **job** |
| `stm32_generate` | CubeMX + 布局映射 + USER CODE 合并 + 补脚手架 | 改多文件 | 3–4 min | **job** |
| `stm32_code_patch` | 只在 USER CODE 块内写 C 代码 | 改 1 文件 | <1 s | 阻塞 |
| `stm32_build` | cmake + ninja，返回 flash/ram 占用与错误定位 | 改 `build/` | 20–60 s | **job** |
| `stm32_flash` | **只烧录**：program + verify + reset，不启 gdb | 改芯片 | 5–15 s | 阻塞 |
| `stm32_debug_run` | 一次调用内烧录 + 断点 + 取 bt/regs + 关闭 | 改芯片 | 5–20 s | 阻塞 |
| `stm32_debug_session` / `_stop` | 显式申请长会话（租约，§6） | 占用探针 | — | 阻塞 |
| `stm32_regs_read` | 直连 openocd 读任意地址（不启 gdb） | 只读 | 3–5 s | 阻塞 |
| `stm32_doctor` | 自检：SWD 是否启用、时钟、栈指针、向量表、USER CODE 完整性、探针被谁占 | 只读 | 5–20 s | 阻塞 |

**斜杠命令**（人直接触发）：`/stm32-flash`（只烧录）、`/stm32-debug`（烧录并调试）、`/stm32-build`、`/stm32-doctor`。这是 P1 的正面解法——烧录与调试点两下，互不干扰。

**随插件下发的 SKILL**：`stm32-workflow`，固化红线（I1–I8）与本次踩过的坑（SWJ_DISABLE、沙箱卡死、假成功）。

## 5. 工作流状态机

```
[0] env_probe -> [1] project_create -> [2] ioc_inspect/plan/apply -> [3] generate
                                                                  |
                       +------------------------------------------+
                       v
                 [4] code_patch (USER CODE 内) -> [5] build -> [6] flash（只烧录）
                                                      |           +-> [6q] debug_run（烧录并调试）
                                                      +- 失败回 [4] / [2]
                                                                  |
                                                                  v
                                                          [7] doctor / regs_read 自证
```

每阶段契约：**输入（前置产物）→ 输出（结构化 JSON）→ 失败回退点**。任何阶段失败不许"猜着继续"——generate 后必须做空壳检测（P3）。
## 6. 调试会话模型（租约式，默认用完就关）

### 6.1 硬约束

CMSIS-DAP 同一时刻只能被一个进程占用。「插件常驻 gdb」与「你在 VS Code 按 F5」互斥；冲突表现是 `Error: Error connecting DP: cannot read IDR`，**看不出被谁占**。

### 6.2 三种形态

| 形态 | 生命周期 | 适合 | 代价 |
|---|---|---|---|
| `debug_run`（默认） | 单次调用内 open→load→break→continue→取 bt/regs→close | 验证型调试（有没有到 main、卡在哪、变量值） | 不能交互 |
| `debug_session`（显式申请） | 空闲 60–90 s 自动关，操作续租，10 min 硬上限 | 交互式单步、反复读变量 | 期间占用探针 |
| 常驻 gdb | 直到手关 | 长时间连续调试 | **会挡住 VS Code**，不采用 |

### 6.3 关闭规则

1. 默认走 `debug_run`：一次调用把该看的都看回来，**天然用完就关**。
2. `debug_session` 必须显式申请，返回 `session_id` + 剩余租约；每次 `debug_eval` 续租。
3. `build` / `flash` / `generate` 开始前若存在会话，**先关闭并说明**（避免"烧录时探针被自己占着"）。
4. 插件进程退出 / job 取消 → 强制关闭，openocd 进程树 `taskkill /T /F`。
5. `doctor` 能回答"探针现在被谁占着"，冲突时给可操作提示而非裸错误。

### 6.4 T1 已确认：`turn/end` 钩子存在，按精确方式实现

用户要求："agent 工作时会话可留；**agent 输出完、等下一次回复期间必须关闭**"。

**已定论（2026-10-22 查 dsh 实现）**：插件能精确知道轮次结束，不需要降级 TTL。

```ts
// 会话事件流：turn/start、turn/end、tool/result ...
ctx.on("session/event", (session, event) => {
  if (event.type === "turn/end") closeDebugSession(session)   // event.data = { turn, reason }
})
ctx.on("session/disposed", (session) => closeDebugSession(session))
ctx.on("agent/turn-stopping", async ({ agent, turn }) => { /* 轮内提前收尾，可选 */ })
```

证据（本机 asar 内实现）：

| 位置 | 内容 |
|---|---|
| `dsh-agent-loop/lib/index.js:1029` | `this.session.append("turn/end", { turn, reason: turnEnds })` —— 每轮工具循环结束时追加，等于"我说完了" |
| `dsh-workspace-changes/lib/index.js:1055-1062` | 消费者写法：`ctx.on("session/event", (session, event) => { … event.type === "turn/end" … })` |
| `dsh-workspace-changes/lib/index.js:1064-1069` | 兜底 `session/disposed`，以及轮内钩子 `agent/turn-stopping`（`{ agent, turn }`） |
| `dsh-agent/lib/index.js:105-108` | `turn/end` 的 `data` 含 `{ turn, reason }` |

**实现约定（已在 M4 落地，见 §8.10）**：

1. `debug_session` 打开时向插件注册 `turn/end` 监听；事件到达 → 关闭会话并 `taskkill /T /F` openocd 进程树。
2. `session/disposed` 与插件 `dispose` 同路径清理，防进程泄漏。
3. 保留 TTL（60–90 s）+ 10 min 硬上限作为**安全网**，不是主路径：万一事件没到，探针也不会被永久占用。
4. `debug_run` 形态照旧（一次调用内开关），不依赖任何事件。
5. `build` / `flash` / `debug_run` / `generate` 开跑前先 `releaseProbeFor()`：会话开着就先关，避免"自己的会话占着探针"。

实际代码（`dsh-stm32/src/index.ts`）：

```ts
if (typeof ctx.on === "function") {
  ctx.on("session/event", (_session, event) => {
    if (event?.type !== "turn/end") return;
    void debugSessions.stop("turn/end：本轮输出结束，把探针还给你");
  });
  ctx.on("session/disposed", () => void debugSessions.closeAll("session/disposed"));
  ctx.on("dispose", () => void debugSessions.closeAll("dispose"));
}
```

## 7. 工程结构契约

### 7.1 目标布局（= 当前 `demo/` 的真实布局）

```
demo.ioc                     <- 配置源，唯一真源
.mxproject                   <- CubeMX 生成记录（增量生成依据）
CMakeLists.txt
CMakePresets.json            <- generator=Ninja, binaryDir=build/<preset>
cmake/{gcc-arm-none-eabi.cmake, starm-clang.cmake, stm32cubemx/CMakeLists.txt, user/CMakeLists.txt}
startup_stm32f103xb.s        <- 根目录
STM32F103XX_FLASH.ld         <- 根目录
Core/Inc/{main.h, stm32f1xx_hal_conf.h, stm32f1xx_it.h}
Core/Src/{main.c, stm32f1xx_hal_msp.c, stm32f1xx_it.c, syscalls.c, sysmem.c, system_stm32f1xx.c}
Drivers/{STM32F1xx_HAL_Driver, CMSIS}
.vscode/{launch.json, settings.json, c_cpp_properties.json}
build/<preset>/<ProjectName>.elf
```

### 7.2 契约

| ID | 要求 | 理由 |
|---|---|---|
| C1 | 新工程逐项复刻上表，不自创 `src/`、不重排 | `cmake/stm32cubemx/CMakeLists.txt` 的源文件清单是**写死**的（`Core/Src/main.c` 等，21–28 行），布局一变就"改了不生效且不报错" |
| C2 | 生成物必须落 `Core/Src`、`Core/Inc` | CLI 固定写 `Src`/`Inc`（§8.3 E2），插件必须做搬运 + 合并 |
| C3 | `.elf` 路径与名字一致（`build/<preset>/<ProjectName>.elf`） | 否则 VS Code F5 找不到可执行文件 |
| C4 | `launch.json` 只**新增**配置 | 保留已有的「① 只烧录 / ② 烧录并调试」两条 |
| C5 | 写入边界：只有 `Core/**` 的 USER CODE 区 + `.dsh-stm32/**` 可写，其余只读 | 防止"调试时项目文件被搞乱" |
| C6 | 脚手架（startup/`.ld`/CMake/Drivers）只许"复制项目自身"或"模板快照（记录来源版本）"，**禁止手写** | 手写必然与 CubeMX 版本漂移 |
| C7 | 任何非 USER CODE 区的写入必须 plan + 确认 + 备份 | 与 I3 一致 |
## 8. CubeMX 集成：实测事实与能力边界

### 8.1 调用方式（唯一可用）

```
& "<CubeMX>\jre\bin\java.exe" -jar "<CubeMX>\STM32CubeMX.exe" -q <script>
```

- **不能**直接跑 `STM32CubeMX.exe`：它是 launcher，detach 出 javaw 后立刻 exit 0（P3 的根源）。
- 输出**不在 stdout**，必须重定向到日志文件。
- 脚本命令：`config load <ioc>` / `generate code <dir>` / `exit`；`load <mcu>` 只选芯片、生成空壳，不可用于工程。

### 8.2 能力矩阵

| 能力 | 脚本模式 | GUI | 结论 |
|---|---|---|---|
| 生成 `Core/Src`、`Core/Inc` 的 `.c/.h` | 是（但落 `Src/`、`Inc/`） | 是 | 需搬运 |
| 按 `.ioc` 改变非 USER CODE 区内容 | 是 | 是 | **等价**（§8.4） |
| USER CODE 块保活 | 是（同一文件被重写时） | 是 | **等价** |
| `CMakeLists.txt` / `cmake/**` / `startup_*.s` / `*.ld` / `Drivers/` | 否 | 是 | 插件自补 |
| `.mxproject` 更新 | 否 | 是 | 插件自补 |
| 删除不再需要的旧生成文件 | 否 | 是（`DeletePrevious=true`） | 插件自补 |
| 按 `MainLocation` / `CoupleFile` 决定落点与拆文件 | 否（固定 `Src/Inc` + 按外设拆） | 是 | 需映射 |

### 8.3 四个决定性实验（2026-10-22，CubeMX 6.15.0）

| # | 做法 | 结果 |
|---|---|---|
| E1 | 空目录（只有 `demo.ioc`）生成 | 只产 `Inc/{gpio.h,main.h,stm32f1xx_hal_conf.h,stm32f1xx_it.h}` + `Src/{gpio.c,main.c,stm32f1xx_hal_msp.c,stm32f1xx_it.c}`；**无** CMake/startup/`.ld`/Drivers/`.mxproject`/`.vscode` |
| E2 | 完整工程副本（923 文件，含 `.mxproject`、`Core/Src`、`CMakeLists.txt`）原地重生成 | 仍写 `副本/Src`、`副本/Inc`；`Core/**`、`cmake/**`、`.mxproject` 零字节变化（22 项 SHA-256 全同）；日志只有 `Code succesfully generated under <dir>`，无 ProjectBuilder |
| E3 | `generate code` 参数换成 `.ioc` 文件路径 | 静默无操作（exit 0，无文件变化）→ 参数必须是目录 |
| E4 | 往 `e1/Src/main.c` 的 `USER CODE BEGIN 3` 插 `// MARKER_E4_USERCODE`，再对同目录重生成 | **标记存活**（第 100 行）→ 脚本模式同样遵守 USER CODE 块语义 |

**结论**：脚本模式只跑 CodeEngine、不跑 ProjectBuilder。所以"插件调 CubeMX 就能出完整工程"不成立——插件必须自己做**布局映射 + USER CODE 合并 + 脚手架**。

### 8.4 "配置变了，非 USER CODE 区跟着变"的证据

同一生成器、仅 `.ioc` 不同（`mxverify` 副本里手工加了 PA0=key/上拉输入、PA5=led2/输出）：

- `mxverify/Inc/main.h:62-65` → 新增 `#define key_Pin GPIO_PIN_0`、`key_GPIO_Port GPIOA`、`led2_Pin GPIO_PIN_5`、`led2_GPIO_Port GPIOA`
- `mxverify/Src/main.c:179-190` → 新增 `/*Configure GPIO pin : key_Pin */`、`GPIO_InitStruct.Pull = GPIO_PULLUP`、`HAL_GPIO_Init(key_GPIO_Port, ...)`、`HAL_GPIO_WritePin(led2_GPIO_Port, led2_Pin, ...)`
- 这些全在 USER CODE 之外，即**生成器按配置重写了非用户区**

时钟侧同样等价（`m0/e1/Src/main.c`）：`PLLMUL = RCC_PLL_MUL9`（122 行）、`APB1CLKDivider = RCC_HCLK_DIV2`（134 行）、`HAL_RCC_ClockConfig(..., FLASH_LATENCY_2)`（137 行）。

**但**：GUI 还会顺带更新 `CMakeLists.txt` 的源文件清单、`.mxproject`，并删除废弃文件；脚本模式不会。所以"效果相同"只在 `.c/.h` 内容层面成立，工程级文件由插件补齐（C6 / A13）。

### 8.5 运行成本与噪音

- 单次生成 **4–8 分钟**（实测一次成功 238.5 s；并发/排队时单次可跑到 8 分钟以上）→ 必须走 job + 进度流，插件默认超时 600 s。
- 插件侧**不需要** `danger-full-access`：`ctx.subprocess` 起的进程不受会话文件沙箱限制（实测 env_probe 7/7 正常）。
- 日志噪音：成功前有成批 `PDSC version is not supported` ERROR 与 `OptionalMessage_ERROR`（`Pin8 (VP_RIF_VS_RIF1) cannot be retrieved`、RCC 的 `ADCFreqValue/FamilyName/MCOFreq_Value/USBFreq_Value invalid`）。与本芯片无关，`doctor` 必须能区分"成功但有 warnings"。
- `workspace-write` 下卡死：进程停在 `IntegrityCheckThread` 之后，java CPU 冻结在 ~58 s。
### 8.6 插件端到端实测（2026-10-22，`dsh-stm32/test/e2e-generate.mjs`）

在 `demo` 的 12 文件精简副本（`.ioc` + `.mxproject` + `CMakeLists.txt` + `Core/**`）上跑真实生成：

- 耗时 **238.5 s**，`ok=true`，6 个文件落位（全部 `overwritten` + 备份）。
- `Core/Src/main.c` 保活 USER CODE 标签 `Header,PV,WHILE,3,Error_Handler_Debug,6`，`USER CODE 3` 里的
  `HAL_GPIO_TogglePin` / `g_led_blink_count++` / `HAL_Delay(500)` 全部存活。
- `coupled` 布局生效：`MX_GPIO_Init` 在 `main.c` 内，没有生成 `gpio.c`（`generate all_code_in_main` 确实被 CLI 执行）。
- 备份落 `.dsh-stm32/backups/<时间戳>/Core/{Src,Inc}/*`；生成用的 `Src/`、`Inc/` 已清理。
- 坑：Windows 上目录 `rm` 后可能处于 **delete pending**（`existsSync` 仍为 true，但枚举已看不到），e2e 断言必须轮询，否则假阴性。
- 坑：诊断长任务别用 PowerShell 管道（`| Out-File`）或 node 的管道 stdout，缓冲会让日志长时间为空；用 `cmd /c "… > file 2>&1"`。

## 9. 技术栈与分层

### 9.1 结论

**单语言 TypeScript，零运行时依赖，`tsc` 直出，`engines.node >= 20`。**

| 项 | 决定 | 依据 |
|---|---|---|
| 语言 | TypeScript | dsh 插件本身必须是 node 模块；`.ioc` 是纯 `key=value`，不需要 Python 生态 |
| 构建 | `tsc`（不用 tsup） | 零额外依赖、产物可读、直接对应 dsh 插件的 `main: dist/index.js`；本地插件不需要单文件打包 |
| Node 下限 | `>= 20` | 本机 node 为 v24.14.0；18 已 EOL，写 20 可用较新 API |
| 运行时依赖 | 0（只用 `node:child_process`/`fs`/`crypto`/`path`） | 参考 `dsh-git-graph` 的 `dependencies: []` |
| 宿主依赖 | `@deepseek-ai/dsh-tools`（`defineTool`）、`@deepseek-ai/cordis`（`Context`） | 官方 cookbook |

### 9.2 四层

```
L3  tools/        defineTool 适配器、job 注册表（依赖 L2）
L2  workflows/    generate / build / flash / debug / doctor（依赖 L1）
L1  domain/       ioc、plan、scaffold、diagnostics、chip/probe 数据（依赖 L0）
L0  transport/    spawn、log、timeout、kill-tree、lock、原子写（只依赖 node 标准库）
```

**规则 1**：只能向下依赖（L0 不 import L1，任何层不 import L3）。
**规则 2**：外部工具走端口接口，业务代码里不许硬编码 `D:\app\msys64` 或 `stm32f1x.cfg`。

只对"已知会变"的四样做抽象：

| 未来要加 | 只改 |
|---|---|
| STM32F401 等型号 | `data/chips/*.json` |
| ST-Link / J-Link | probe 适配器（L1） |
| CubeMX2 / `.ioc2` | generator 适配器（L1） |
| UI 面板 | 新 client 包调 L2 |

**反面警告**：不为分层而分层，其余保持直白函数。

### 9.3 目录草案

```
dsh-stm32/
  package.json          # main: dist/index.js, dsh.bundle.patch, engines.node >=20, deps: []
  cordis.patch.yml
  src/
    index.ts
    engine/             # L0 + L1
      ioc.ts plan.ts backup.ts spawn.ts cubemx.ts scaffold.ts
      build.ts flash.ts debug.ts doctor.ts
    workflows/          # L2
    tools/              # L3：13 个 defineTool 适配器
    data/chips/stm32f103c8t6.json
    data/probes/cmsis-dap.json
  test/                 # fixture: demo/ 与 _scratch/ 的真实产物
```

### 9.4 数据结构

inspect 输出：

```json
{ "mcu": {"cpn":"STM32F103C8T6","name":"STM32F103C(8-B)Tx","package":"LQFP48"},
  "clock": {"hse":"8MHz","sysclk_hz":72000000,"pll":{"mul":9,"source":"HSE"}},
  "debug": {"mode":"Serial_Wire","pins":["PA13","PA14"]},
  "pins": [{"pin":"PC13","signal":"GPIO_Output","label":"led","locked":true}],
  "project": {"name":"demo","toolchain":"CMake","main_location":"Core/Src","fw":"STM32Cube FW_F1 V1.8.7"},
  "sha256": "..." }
```

插件状态文件 `.dsh-stm32.json`（可提交）：

```json
{ "version": 1, "ioc": "demo.ioc", "elf": "build/Debug/demo.elf",
  "toolchain": {"gcc":"...","gdb":"gdb-multiarch","openocd":"openocd","cmake":"...","ninja":"..."},
  "probe": {"type":"cmsis-dap","speed_khz":1000},
  "openocd": {"interface":"interface/cmsis-dap.cfg","target":"target/stm32f1x.cfg","reset_config":"none"},
  "build": {"generator":"Ninja","preset":"Debug"} }
```

统一返回：

```json
{ "ok": true, "stage": "generate",
  "artifacts": [{"path":"Core/Src/main.c","sha256":"...","bytes":2711}],
  "diagnostics": [{"severity":"warning","code":"SWJ_DISABLE","message":"...","file":"...","line":77}],
  "duration_ms": 142000 }
```
### 9.5 插件 API 在哪（实测索引，写代码时直接照这个查）

插件 API 不是一个网站，而是**随 dsh 一起装在 checkout 里的一组 npm 包**，每个包自带一份 `README.zh.md`（front-matter 标 `kind: package-reference`）作为官方文档。位置：

```
D:\app\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\
  dsh-tools/README.zh.md          <- defineTool、ctx.tools.register/restrict/guard/schemas、PTC
  cordis/README.md                <- Context、inject、ctx.on、Service、fiber 生命周期
  dsh-session/README.zh.md        <- Session、append、事件流
  dsh-agent/README.zh.md          <- agent 事件（agent/status 等）
  dsh-jobs/README.zh.md           <- 后台 job（M1 之后要用）
  dsh-tool-todo/lib/index.js      <- 最小工具插件的完整范例（name/inject/Config/apply）
```

**是写插件时要调用的东西**——插件就是一个 cordis 插件模块，四个导出：

```ts
import type { Context } from "@deepseek-ai/cordis"
import { defineTool } from "@deepseek-ai/dsh-tools"

export const name = "stm32"
export const inject = ["tools", "subprocess"]      // 需要的服务（缺了不启动）
export const Config = /* schemastery */ undefined  // 可选配置 schema

export function apply(ctx: Context, config) {
  ctx.tools.register(defineTool({
    name: "stm32_flash",
    description: "只烧录，不进入调试会话",
    parameters: { /* string/number/boolean/array/object/oneOf */ },
    output: { schema: { /* ... */ }, render: (_args, value) => [{ type: "text", text: "..." }] },
    async execute(args, exec) { /* exec.signal 可取消 */ },
  }))
  ctx.on("session/event", (session, event) => { /* turn/end 关调试会话 */ })
  ctx.on("dispose", () => { /* 杀 openocd 进程树 */ })
  return () => { /* 卸载清理 */ }
})
```

**一个坑要先知道**：asar 里只发布了 `lib/**/*.js`，`package.json` 的 `types` 指向的 `lib/types/index.d.ts` **并不存在**。所以要么 `npm i -D @deepseek-ai/dsh-tools @deepseek-ai/cordis` 拿类型，要么按 README + 源码里的 JSDoc 写、用 `any` 兜底。M1 实验里会先确认哪一种可行。

**证据**：`dsh-tool-todo/lib/index.js:11-12`（`const name`/`const inject = ["tools", "sessionProjections"]`）、`:1097` 导出 `{ Config, apply, inject, name }`；`dsh-workspace-changes/lib/index.js:947-949`（`inject = ["subprocess", "fs"]`）。

#### 9.5.1 实测确认的宿主契约（M1 已跑通）

- **插件不需要 `defineTool`**：直接 `ctx.tools.register({ name, description, parameters:<JSON Schema>, timeoutMs, isConcurrencySafe, output:{ schema, render }, execute })` 即可，`defineTool` 只是同一个对象的轻量包装。已验证对象能通过 `assertSupportedJsonSchema` / `validateJsonSchemaValue`。
- **`ctx.subprocess.spawn(spec)`**：`spec = { argv: string[], cwd: string, stdio: { stdin:"ignore", stdout:{maxBytes}, stderr:{maxBytes} }, graceMs: 3000, signal }`，返回 `{ done: Promise<{exitCode, signal}>, collected: { stdout?: { readFrom(offset) }, stderr? }, terminate(), waitForExit() }`。`readFrom` 是偏移读取、不消费。
- **坑（已踩）**：`spec.cwd` 缺省不是"默认当前目录"，而是直接在 `targetEnvironment()` 里 `spec.cwd.includes("\0")` → `TypeError: Cannot read properties of undefined (reading 'includes')`（`dsh-subprocess-local/lib/runner-launch-B2zsQ1Dz.js:1520`）。所以 L0 封装一律填 `cwd = request.cwd ?? process.cwd()`，本地假宿主也复刻这条严格性。
- **输出校验**：`execute` 的返回值会被宿主的 ptc runtime 按工具的 `output.schema` 严格校验——未声明键直接拒（`additionalProperties: false`）、声明为 `string`/`number`/`object` 的字段不收 `null`。asar 的 `validateJsonSchemaValue` 宽松，不能当 oracle（§8.8 两个真实 bug）。
- **安装生效方式**：用 `link:` 而不是 `file:`（`nodeLinker: hoisted` 下 `file:` 是复制，改完 `lib/` 不生效）。`pnpm add link:<绝对路径>` 到 `~/.dsh/profiles/desktop` + 在 profile `package.json` 的 `dsh.profile.bundles` 登记包名；bundle 层**只在 dsh 进程启动时加载**，改完代码必须重启 dsh。
## 10. 安全、权限与清理

### 10.1 权限（硬约束）

| 场景 | 要求 | 证据 |
|---|---|---|
| CubeMX 生成 / 校验 | **全权限** | `workspace-write` 下卡死（§8.5）；且要写 `%USERPROFILE%\.stm32cubemx` 与注册表 |
| `ninja` 构建 | **全权限** | `workspace-write` 下挂死在启动第一个构建步骤前（最小 `build.ninja` 也挂）；全权限下 exit 0 |
| 其余（inspect / regs_read / doctor / flash） | 普通权限即可 | 只读或只碰探针；实测插件经 `ctx.subprocess` 起的进程**不受会话文件沙箱限制**（workspace-write 下 7/7 探测正常），所以插件内不需要升权限 |

不可控项：CubeMX 在全权限下会自行写 `%USERPROFILE%\.stm32cubemx` 与注册表，插件只能声明、不能约束。

### 10.2 风险与对策

| # | 风险 | 对策 |
|---|---|---|
| R1 | 残留进程占调试器 | 记录 PID + 启动时间 + 命令行；退出/取消 `taskkill /T /F`；`doctor` 可查 |
| R2 | 端口冲突（gdb 默认 3333） | 探测 3333+ 顺延 |
| R3 | 多 CubeMX 并发写全局库 | 单飞锁（同时只 1 个 CubeMX / openocd / build） |
| R4 | 磁盘膨胀 | 日志 5 MB 截断；备份保留最近 10 份 |
| R5 | PID 复用误杀 | 杀前比对启动时间与命令行 |

### 10.3 非功能要求

幂等（重复 flash 安全、重复 generate 不毁 USER CODE）；可观测（外部命令全部落 `.dsh-stm32/logs/<ts>-<stage>.log`，含 argv / exit code / 原始 stderr）；不留残留；诊断质量（编译错误解析成 `file:line:col`，openocd 错误分类）；Windows 优先，路径用原生分隔符。

## 11. 验收标准

| ID | 场景 | 判据 |
|---|---|---|
| A1 | 空目录 → 一条命令出工程 | F103C8T6 + PC13 输出，build exit 0，占用合理 |
| A2 | 改 `.ioc` 加 PA5（led2） | inspect 能看到；plan diff 正确；generate 后 `MX_GPIO_Init` 含 led2；**USER CODE 闪烁代码不丢** |
| A3 | 只烧录 | Verified OK，且**全程无 gdb 进程** |
| A4 | 烧录并调试 | gdb 命中 `main`，`bt` 正确，可 continue |
| A5 | 注入 `No_Debug` | **拒绝烧录**，报 SWJ_DISABLE 并给修复命令 |
| A6 | 注入语法错 | build 返回 `file:line:col` |
| A7 | 无探针 / 断线 | 明确错误，无残留进程，芯片可恢复 |
| A8 | apply 中途失败 | `.ioc` 字节级还原（SHA-256 一致） |
| A9 | 取消长任务 | CubeMX / build 被取消，进程树全灭 |
| **A10** | 同 `.ioc`，GUI 产物 vs 插件产物（`Core/Src`、`Core/Inc`） | ~~除 USER CODE 区外逐字节一致~~ → **语义等价**（实测 CLI 与 GUI 的空行数不同，逐字节不可达，见 §8.9 发现 1） |
| **A10q** | 插件产物 vs CLI 原始产物（`Src/`、`Inc/`） | 去掉 USER CODE 区后逐字节一致（证明未夹带风格） |
| A11 | 插件生成后 VS Code F5 | 命中 `main`，无红波浪线 |
| A12 | 插件运行中用户在 VS Code 烧录 | 能检测探针被占并提示，不损坏 |
| **A13** | 脚手架文件（`CMakeLists.txt`、`cmake/**`、`startup_*.s`、`*.ld`、`Drivers/**`、`.mxproject`、`.vscode/**`） | 与"同版本 CubeMX GUI 新工程"逐字节一致；来源只能是项目自身复制或模板快照 |

**逐条结论见 §8.12**（2026-10-22 M6 总验收：A1–A13 全部通过，其中 A11 为间接证据）。

### 8.7 M3 实测：build / flash / debug_run（2026-10-22，同一台机器同一块蓝丸）

| 场景 | 结果 | 证据 |
|---|---|---|
| `stm32_build` clean 全量 | ok，56.0 s，RAM 1584 B/20 KB (7.73%)、FLASH 4716 B/64 KB (7.20%)，0 错误 | `test/e2e-build.mjs` 5/5 PASS |
| `stm32_build` 增量 | ok，2.3 s；无链接就没有内存表 → 报告写"本次是增量构建…"，不报错 | 同上第一轮 |
| `stm32_flash` | ok，2.2 s，`** Programming Finished **` + `** Verified OK **`，用工程的 `openocd.cfg`，跑完 `Resetting Target` 退出 | `test/e2e-flash.mjs` 5/5 PASS |
| `stm32_debug_run` | ok，2.6 s，停在 `main () at demo/Core/Src/main.c:74`，pc=0x8000f58 / sp=0x20004ff8 / lr=0x80011ab，收尾 reset run + detach | `test/e2e-debug.mjs` 5/5 PASS |
| 调试后探针是否真的放掉 | 另起一次 openocd 连上读到 `g_led_blink_count=41065`（芯片一直在跑），说明 detach 后目标自由运行 | `dsh-stm32/verify-run.log` |

踩到的两个实现坑（都已修，写进 README/代码注释）：

1. **openocd 的日志走 stderr**。`debug_run` 起初只轮询 `collected.stdout` 等 `Listening on port`，永远等不到，15 s 判失败；
   两路都读之后立刻正常。
2. **删空目录必须用 `rmdirSync`**。`rmSync(dir, { recursive: false })` 对目录直接抛 `ERR_FS_EISDIR`，
   表现为"生成用的 Src/、Inc/ 删不掉"，连续三轮 e2e 都 FAIL——不是文件被占用，是 API 用错。
3. 附带发现：CubeMX 生成过程中可能出现 `[ERROR] WebUtils:398 - Updater is busy`，但同一次仍打印
   `Code succesfully generated under …`。判定规则改为**有成功行就以成功行为准**，过程 ERROR 降级为告警
   （否则会把成功的一次判成失败、一个字节都不落位）。

### 8.8 M2 剩余工具实测 + 宿主输出契约（2026-10-22）

| 场景 | 结果 | 证据 |
|---|---|---|
| `stm32_doctor` | ok，3.5 s：工具链 7/7（gcc 13.3.0 / gdb 16.2 / openocd 0.12.0 / cmake 3.31.5 / ninja 1.12.1 / CubeMX / JRE 21.0.3）、无残留 openocd/gdb 进程、3333 空闲、elf=demo\build\Debug\demo.elf、.ioc 告警 0 | `test/e2e-doctor-regs.mjs` 10/10 PASS |
| `stm32_regs_read` | ok，0.9 s，pc=0x0800020c；AFIO_MAPR=0x02000000（SWJ_CFG=2，Serial Wire 正常）、GPIOC_ODR=0x00002000（PC13 高电平）、g_led_blink_count=0x00013168 | 同上 |
| 探针是否释放 | 同一调用结束后再连一次 openocd 正常，计数器持续增长（芯片在跑） | 同上第二次读 |

**宿主输出校验的两条硬规则**（都真实翻过车，已用 `test/schema-guard.mjs` 6/6 固化成离线守卫）：

1. `additionalProperties: false` 必须严格遵守。`stm32_flash` 返回了 schema 未声明的 `args`，**烧录副作用已经发生**，调用却报 `"value.report.args" is not a declared property`。
2. 声明为 `string` / `number` / `object` 的字段不接受 `null`。`build` / `flash` 的失败路径写 `exitCode: null`、`elf: null` 会被拒：`"value.report.exitCode" must be a number`。改用可选字段 + 条件展开。

结论：**asar 里的 `validateJsonSchemaValue` 不是宿主校验的 oracle**（它对 null、多余键都放过），唯一 oracle 是 ptc runtime；所以断言要按 schema 自己离线走一遍。

### 8.9 宿主侧整体复验 + generate 端到端（2026-10-22，重启 dsh 后真实调用）

重启 dsh 后，8 个工具在真实宿主环境里逐个跑过（此前 §8.6 的 generate 只在本机脚本里验过）：

| 工具 | 结果 | 备注 |
|---|---|---|
| `stm32_doctor` | ok，工具链 7/7，无残留 openocd/gdb，3333 空闲，.ioc 告警 0 | — |
| `stm32_regs_read` | ok，1.3 s，pc=0x08000244；AFIO_MAPR=0x02000000、GPIOC_ODR 读到 PC13 电平 | — |
| `stm32_flash` | ok，2.1 s，编程 + 校验 + 复位运行，**修复后再无 `value.report.args` 报错** | 见 §8.8 硬规则 1 |
| `stm32_debug_run` | ok，2.4 s，停在 `main () at demo/Core/Src/main.c:74`，pc=0x8000f58 sp=0x20004ff8 lr=0x80011ab，收尾 reset run + detach | — |
| `stm32_generate`（job 形态） | job `stm32-generate-ae31921d2a554928` → completed，64.6 s，**6 个文件落位全部 overwritten，保活 USER CODE 标签 12 个** | 首次在真宿主验证 `ctx.jobs.start` + 进度流 |

generate 端到端带来的连锁验证（全部通过）：

- 备份：`.dsh-stm32/backups/20261022-175732/Core/{Src,Inc}/*`；
- 临时目录：生成用的 `Src/`、`Inc/`、`MXTmpFiles/` 全部消失，`.dsh-stm32/lock.json` 已释放；
- USER CODE 3 里的 `HAL_GPIO_TogglePin(led_GPIO_Port, led_Pin);` / `g_led_blink_count++;` / `HAL_Delay(500);` 原样保留；
- 重新编译：ok，4.2 s，0 错误 0 警告，RAM 1584 B (7.73%)、FLASH 4716 B (7.20%)，产物 656888 B；
- 重新烧录 + 读寄存器：计数器单调增长，固件照常闪灯。

**三条新发现（都已落到代码或本文档）**：

1. **CLI 产物与 GUI 产物在空行数量上不一致**。重新生成前后 `Core/Inc/main.h` 是 72 行 → 66 行，差异全是空行（`#define led_Pin`、`Error_Handler` 等语义内容完全一致）。
   → **A10"除 USER CODE 区外逐字节一致"在本机不可达**，验收改按 A10q 的精神执行：结构、路径、语义一致，允许空行/排版差异。这条把 §7.2 C1 的"逐字节"要求正式降级为"语义等价"。
2. **`stm32_regs_read` 原来的收尾 `reset run` 有副作用**：它会把芯片复位，固件里的计数器从头开始，"只读一眼"变成"重启一次"。第一次宿主复验里就看到计数器 917 → 1926（读到的是 `uwTick`）以及随后 29 → 4 → 4 → 4 的归零。
   → 收尾改为 `resume` + `shutdown`（halt 只是暂停，resume 原样继续跑）。`test/e2e-doctor-regs.mjs` 增加两条断言（计数器单调增长、两次读之间不归零），现在 **12/12 PASS**。
3. **符号地址会随重新生成/链接漂移**：`g_led_blink_count` 从 0x20000028 移到 0x2000002C，原地址 0x20000028 变成 `uwTick`（1 kHz 自增，一眼能看出异常）。
   → `stm32_regs_read` 只接受物理地址，不猜符号。后续可在 M5 加"按 `.elf` 符号名解析地址"（`arm-none-eabi-nm`），列入 §14 未定项。


**regs 解析的真实格式**（openocd 0.12.0）：`mdw` 打印 `0x4001100c: 00000000`（值是 8 位裸 hex），`[reg pc]` 打印 `pc (/32): 0x…`。脚本改为 `[lindex [mdw <addr>] 1]` / `[lindex [reg pc] 1]`，且 pc 仍优先取 halt 横幅 `xPSR: … pc: 0x…`——实测 `[lindex [reg pc] 1]` 会得到空值。

### 8.10 M4 实测：配置事务 + 调试会话租约（2026-10-22，同一台机器同一块蓝丸）

六个新工具：`stm32_ioc_plan`、`stm32_ioc_apply`、`stm32_debug_session`、`stm32_debug_eval`、`stm32_debug_stop`，
加上插件入口里的 `turn/end` 清理与四个既有工具的"先让出探针"。

| 验证 | 方式 | 结果 |
|---|---|---|
| 事务离线 | `node test\ioc-plan-units.test.mjs` | **9/9 PASS**（plan 不写源文件、apply 核 SHA、引脚校验、serialWire 补 PA13/PA14、rollback 只认 backups 下路径） |
| 会话离线 | `node test\session-units.test.mjs` | **8/8 PASS**（租约续租、空闲/硬上限自动关、重复 start、无会话时 eval 拒绝且不 spawn） |
| 输出契约 | `node test\schema-guard.mjs` | **12/12 PASS**（含新增的 plan/apply **成功路径**形状检查：kind ∈ added/removed/changed、before/after 一定是字符串、不出现 null） |
| 真板长会话 | `node test\e2e-session.mjs` | **9/9 PASS**：起会话 0.3 s、自动解析到 `build/Debug/demo.elf`、隔 1.2 s 读两次 `g_led_blink_count` 递增（芯片在跑）、读到 pc、关会话后探针释放且 3333 空闲 |
| 事务闭环 | `node test\e2e-plan-generate.mjs` | **9/9 PASS**：副本上 plan 加 PA5/`led2`（8 条键变更）→ apply（备份 `.dsh-stm32/backups/<时间戳>-ioc/demo.ioc`）→ 真 CubeMX 生成 91.4 s、6 个文件落位、保活 12 个 USER CODE 标签 → `main.h` 出现 `led2_Pin GPIO_PIN_5`/`led2_GPIO_Port GPIOA` 且 `led_Pin GPIO_PIN_13` 仍在 → 生成用的 `Src/``Inc/` 清干净 → rollback 后 `led2` 消失 |

**宿主侧复验（重启 dsh 后真实调用，2026-10-22）**：

| 工具 | 结果 |
|---|---|
| `stm32_ioc_plan` | ok、planId `c6e252e6877afd50`、8 条 diff、`kind`/`before`/`after` 符合 schema、无 warning |
| `stm32_ioc_apply` | ok、appliedChanges 8、`shaAfter === candidateSha256`、备份 `.dsh-stm32/backups/<时间戳>-ioc/demo.ioc`；写后 `.ioc` 真的多了 `Mcu.PinsNb=9`/`Mcu.Pin8=PA5`/`PA5.Signal=GPIO_Output` 等 8 行 |
| `stm32_debug_session` | ok、active、port 3333、自动解析到 `build/Debug/demo.elf` |
| `stm32_debug_eval` | 两次读 `g_led_blink_count` 得 2127 → 2136（隔 1.3 s，芯片在跑）；`info registers pc sp` → `pc=0x8000214 <HAL_GetTick+12>`、`sp=0x20004fdc` |
| `stm32_debug_stop` | stopped=true，探针释放 |
| `stm32_doctor` | ok、残留进程 `[]`、3333 空闲 |

事务验证在临时副本 `.tmp-host-apply` 上做（只放一份 `demo.ioc`），验完删除，真实工程 `demo.ioc` 未改动。

**`turn/end` 自动释放探针的实验**（刻意排除超时兜底）：用 `idleTtlMs=600000`、`hardTtlMs=600000` 开会话并**故意不关**，
结束本轮输出、用户回一句话后立刻检查 → `stm32_debug_eval` 报"没有调试会话（先 stm32_debug_session…）"、
`stm32_doctor` 残留进程 `[]`、3333 空闲、`stm32_debug_stop` 返回"本来就没有会话"。
租约 10 分钟、实际只过了几十秒，所以只可能是 `session/event` 的 `turn/end` 分支关的（实现见 `src/index.ts`）。
于是"agent 输出结束就把探针交还用户"这条要求（§6）成立。

**两个新踩到的坑**：

1. **ELF 解析必须在引擎里做，不能只放在工具层**。`e2e-session` 直接调 `DebugSessionManager.start()` 时没传 `elfPath`，
   gdb 于是报 `No symbol table is loaded.  Use the "file" command.`，会话起来了但什么都读不到。
   → `start()` 内部改为 `resolveElfPath(projectDir, {}) ?? ""`（调用方给就用自己的），工具层不再重复解析。
   教训：任何"工具层做了一半、引擎层没做"的默认值，在绕过工具层的测试里都会露馅。
2. **`IocPlanChange` 只有 `before`/`after`，没有 `kind`**（`kind` 是工具层按"before 为 null → added"派生的）。
   e2e 打印 `change.kind` 得到 `undefined`，看着像 bug 其实是打印错了位置。→ 已在 e2e 里改正，并在
   `schema-guard` 的成功路径用例里**断言 kind 一定是三个枚举之一**，以后工具层派生写错会被抓住。

### 8.11 M5 实测：斜杠命令 + SKILL（2026-10-22，真板）

命令层的宿主契约（`dsh-commands/lib/index.js` 实测）：`ctx.commands.register({ name, description, input?, handler })`；
名字必须匹配 `/^[a-z][a-z0-9_-]*$/u`；handler 收到 `{ commandId, agent, rawInput, attachments, signal }`，
返回 `{ kind: "success" | "error", text? }`——**抛异常不算正常返回**，五条命令都在 handler 内 try/catch。
SKILL 走 `ctx.skills.register({ name, description, content, invocation })`，名字匹配 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`。
两者都通过 `ctx.inject([...], scope => ...)` 挂载：服务不存在就不注册，不会让整个插件加载失败。

| 命令 | 真实结果（`test/e2e-commands.mjs`） |
|---|---|
| `/stm32-doctor` | 1.5 s，success，文本含「体检通过」「工具链」 |
| `/stm32-build` | 0.5 s，success，文本含「编译成功」 |
| `/stm32-debug` | 2.1 s，success：先烧录，再停在 `main`，文本含「烧录成功」「调试：停在」 |
| `/stm32-stop` | success，「会话已关闭（你敲了 /stm32-stop），探针已释放」 |
| `/stm32-flash` | 1.6 s，success，「写入=是，校验=是」 |

断言 14/14 全过。首次跑时 `/stm32-debug` 报「调试会话起不来：没开会话：插件未就绪」——
根因是 `DebugSessionManager` 原先只在 `tools/debug-session.ts` 的 execute 里 `configure()`。
修法：命令层在 `start()` 之前也调 `debugSessions.configure(subprocess, [])`，
让「只注册命令、不注册工具」的组合同样能起会话（e2e 与真实宿主都因此变健壮）。

SKILL（`stm32-workflow`）把用户 m02472 的要求写成硬规范：R1 代码只准落在 USER CODE 块之间；
R2 不许改 CubeMX 生成区（逐条列出 `main()` / `SystemClock_Config()` / `MX_*_Init()` / `main.h` 的 defines 段 /
`stm32f1xx_hal_msp.c` / `stm32f1xx_it.c` / `stm32f1xx_hal_conf.h` / startup / `.ld` / `CMakeLists.txt` /
`cmake/stm32cubemx/CMakeLists.txt` / `.mxproject` / `demo.ioc`，理由是源清单写死且重新生成会覆盖）；
R3 `.ioc` 只走 plan → 确认 → apply；R4 禁止 `No_Debug`（SWJ_DISABLE → SWD 失联）；
R5 烧录与调试分开、成功看 `** Programming Finished **` + `** Verified OK **`；R6 探针唯一；R7 先 build 再 flash；
R8 结论必须带寄存器证据。另附标准流程 8 步、命令对照表、10 条实测坑、自检清单。

离线套件 10 个全绿（含新增 `commands-units` 6/6）；`schema-guard` 对当时已注册的 13 个工具的输出做契约校验（M6 之后补齐到全部 15 个，见 §8.12）。
### 8.12 M6 实测：补缺口 + A1–A13 总验收（2026-10-22，同一台机器同一块蓝丸）

M5 收尾时对着规格自查，发现两个规格里的工具**从未实现**（`stm32_project_create`、`stm32_code_patch`），
以及 A5（`No_Debug` 时拒绝烧录）没有守卫。M6 补上，并把 §11 的验收逐条真跑。

| 新增/改动 | 位置 | 结果 |
|---|---|---|
| `stm32_project_create` | `src/engine/scaffold.ts` + `src/tools/project-create.ts` + `templates/scaffold/`（14 个工程文件） | 空目录 → 可编译工程 **2095 ms**（14 个模板文件 + 629 个固件文件） |
| `stm32_code_patch` | `src/engine/code-patch.ts` + `src/tools/code-patch.ts` | 只写 USER CODE 块；CRLF 原样；备份 + 原子写；四种拒绝情形 |
| A5 烧录守卫 | `checkNoDebugGuard()`（`src/engine/flash.ts`） | `.ioc` 没启用 Serial Wire → 烧录前拒绝，附修法与 `allowNoDebug` 逃生门 |
| 首次构建自动配置 | `pickConfigurePreset()`（`src/engine/build.ts`） | 没有 `CMakeCache.txt` 时先 `cmake --preset <Debug>`，不再"新工程一上来就 build 失败" |

**验收结论（§11 逐条）**

| ID | 结论 | 证据 |
|---|---|---|
| A1 | **通过** | `test/e2e-scaffold.mjs`：空目录 → 骨架 2095 ms/14 文件/629 固件文件 → CubeMX 生成 ~77 s（6 文件）→ build #1 5.2 s（含自动 `cmake --preset Debug`）→ 补丁 → build #2 1.8 s → flash 2.1 s（已校验）→ `g_e2e_count` **17 → 39** |
| A2 | **通过** | 同一轮：`code_patch` 写 `USER CODE Private variables` + `3`，CubeMX 生成时 USER CODE 内容不丢（e2e 里打补丁后再 build 仍在） |
| A3 | **通过** | 同一轮的 `stm32_flash`：`programmed=true / verified=true`，2.1 s，全程无 gdb（引擎只拼 openocd） |
| A4 | **通过** | §8.7 的 `stm32_debug_run`：停在 `main () at demo/Core/Src/main.c:74`，pc/sp/lr 正确，收尾 detach |
| A5 | **通过** | `test/e2e-a5-flash-guard.mjs`：拦下时报「没有启用 Serial Wire 调试口（缺 SYS_JTMS-SWDIO/SYS_JTCK-SWCLK）… `__HAL_AFIO_REMAP_SWJ_DISABLE()` …只能靠 BOOT0 救回来」，`guard="no-debug"`、未执行 openocd；`allowNoDebug=true` 时才放行（2.1 s 烧成功） |
| A6 | **通过** | `test/e2e-a6-build-error.mjs`：`.../Core/Src/main.c:102:15: error: expected expression before ';' token`；改回后 1.4 s 重新编译成功 |
| A7 | **通过** | `test/e2e-a7-a12-probe.mjs`：探针配置指向 J-Link → 「烧录失败：Error: No J-Link device found」，残留 openocd 进程 **0 → 0**，随后用正确配置能连上芯片（pc=0x08000fea） |
| A8 | **通过** | `test/e2e-a8-ioc-rollback.mjs`：apply 后 SHA `9d4e8d8e8073 → 5fde2c05f6e5`，rollback 回到 `9d4e8d8e8073`；plan 后手改源文件 → 拒写；手改候选文件 → 拒写；两种拒绝都不动文件 |
| A9 | **通过** | `test/e2e-a9-cancel.mjs`：预取消的 build 5 ms 返回；跑了 8 s 的 CubeMX 被取消后 8.4 s 内返回，`Src/``Inc/` 无残留、`.dsh-stm32/lock.json` 已释放、`STM32CubeMX.exe` 进程 0 → 0 |
| A10 | **通过（语义等价）** | §8.9 发现 1：GUI 与 CLI 的空行数不同，逐字节不可达；本轮用 A10q 证明插件没有夹带自己的风格 |
| A10q | **通过** | `test/e2e-a10q-product-parity.mjs`：同一个 `.ioc` 让 CubeMX 直接生成到独立目录 → 6 个文件去掉 USER CODE 后与插件 `Core/Src``Core/Inc` **逐字节一致**；插件只多出 `syscalls.c``sysmem.c``system_stm32f1xx.c`（模板/固件包补，GUI 工程同样放在 `Core/Src`） |
| A11 | **间接通过** | 需人在 VS Code 里按 F5，本轮没有自动化；依据是模板 `.vscode/launch.json` 与 `demo/` 的逐字节一致（仅工程名占位替换），而用户在 `demo/` 里已实际用过 F5 / Ctrl+F5 |
| A12 | **通过** | 同 `test/e2e-a7-a12-probe.mjs`：另起 openocd 占住探针 → 烧录失败（`Error: CMSIS-DAP transfer count mismatch: expected 3, got 2`），放掉占用后 1.6 s 烧录成功且已校验 |
| A13 | **通过** | 脚手架产物与同版本 GUI 工程：`CMakeLists.txt`、`CMakePresets.json`、`cmake/gcc-arm-none-eabi.cmake`、`cmake/starm-clang.cmake`、`cmake/stm32cubemx/CMakeLists.txt`、`STM32F103XX_FLASH.ld`、`.gitignore`、`.vscode/{settings,c_cpp_properties,launch}.json`、`*.ioc`、`startup_stm32f103xb.s`、`Core/Src/system_stm32f1xx.c` **逐字节一致**；唯一有意差异是 `cmake/user/CMakeLists.txt`（`demo/` 里那条 `test/test.c` 是脏数据，模板留空清单）；Drivers 共同文件 596 个内容 sha256 全等 |

**M6 修掉的 8 个真问题**（每条都是"先测出来、再改代码"）：

1. `code_patch` 的 append 落在 `while(1)` 收尾括号**之后** → 代码在 `main()` 外、不可达，链接器 `gc-sections` 把变量和自增一起丢掉（elf 里根本没有 `g_e2e_count`）。改成"退到最后一个纯括号行之前"。
2. `code_patch` 的 replace 会删掉块内的 `{`/`}`（CubeMX 的 `USER CODE 3` 之间就夹着 `while(1)` 的收尾括号）→ 现在直接拒绝并建议用 append。
3. 改写块内容时把整文件行尾统一成 LF，破坏"块外字节原样保留" → 按原文判定 `\r\n`/`\n` 再拼接。
4. 新工程第一次 build 必失败（没有 `CMakeCache.txt`，`runBuild` 只做 `cmake --build`）→ 自动先 `cmake --preset`。
5. **假成功**：把含 `build/` 的工程复制/改名后，cmake 打印 `CMake Error: The current CMakeCache.txt directory … is different`，但 ninja 仍旧 `no work to do`、退出码 **0** → 现在显式判失败（"build 目录是从别处复制或移动过来的"）。
6. 早先版本的脚手架把固件包 `Drivers/` 全量复制（5 392 文件、31 s），其中 4 493 个是 `CMSIS/docs/**`、DSP/NN 示例、`BSP/` → 加跳过清单后 629 文件、**~2 s**。
7. CLI 生成不产出 `sysmem.c`/`syscalls.c`，而 `cmake/stm32cubemx/CMakeLists.txt` 写死了引用 → 模板补进 `Core/Src/`（模板文件 12 → 14）。
8. 取消语义缺失：被中断的 build/generate 只会报"超时/失败" → 现在明确报"已取消"，且 generate 会清掉半成品 `Src/``Inc/`、释放锁。

**离线套件（10 个，80 个用例，0 失败）**：`build-units` 5、`commands-units` 6、`doctor-regs-units` 5、`engine-units` 8、`flash-units` 6、`ioc-plan-units` 9、`ioc-units` 6、`scaffold-patch-units` 11、`session-units` 8、`schema-guard` 16（覆盖全部 15 个工具的输出契约；M6 补了 `stm32_env_probe` 与 `stm32_ioc_inspect` 两个此前漏掉的工具，并用假 subprocess 让 `env_probe` 的成功路径也能离线断言）。

**宿主侧复核（重启 dsh 后，真进程注册的工具）**：`stm32_project_create` 空目录 **1690 ms**（14 个模板文件 + 629 个固件文件）
→ `stm32_generate` **61.0 s** / 6 文件 → `stm32_code_patch`（`PV` 声明 + `3` 自增）→ `stm32_build` 首次自动 `cmake --preset Debug` 5.4 s、编译 3.0 s、
RAM 7.73% / FLASH 7.21% → `stm32_flash` 2.5 s 校验通过 → `stm32_regs_read` 读 `g_host_check`（`0x2000000C`）`0x03f99ddd → 0x0484cfac`；
A5 在宿主侧同样拦下（`guard="no-debug"`、`args=[]`，未拼 openocd 参数）。宿主实跑另暴露一个使用细节：CLI 产出的 `main.c` 私有变量块标签是 `PV`，
把文档里的长名字 `Private variables` 当块名会被拒（工具列出 19 个真标签）——这是有意不猜同义词。

## 12. 分期

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M0** | 实验：D3（生成落点）、D4（USER CODE 保活）、A10 可行性 | **已完成**（§8.3；证据在 `demo/m0/`） |
| **M1** | 确认 T1；engine 层 `generate`（CLI 调用 → 布局映射 → USER CODE 合并）+ fixture 测试 | **已完成**（8 个单测 + 真实 e2e 6/6，§8.6） |
| **M2** | 只读层：`env_probe` / `ioc_inspect` / `regs_read` / `doctor` | **已完成**（单测 5，真实 e2e 10/10，§8.8） |
| **M3** | 构建与烧录：`build` / `flash` / `debug_run` | **已完成**（单测 5+6，真实 e2e 5/5 与 5/5，§8.7）——解决 P1"只想烧录不进调试" |
| **M4** | 事务层：`plan` / `apply` / 备份 / 回滚 / 会话租约 | **已完成**：单测 9+8、契约 12/12、真板会话 9/9、事务闭环 9/9、宿主复验全过；`turn/end` 自动释放探针已实测（§8.10） |
| **M5** | 打磨：斜杠命令、SKILL、日志、A1–A13 全绿 | **已完成**：五条斜杠命令 + `stm32-workflow` SKILL，单测 6/6、真板 e2e 14/14（§8.11） |
| **M6** | 补缺口：`project_create` / `code_patch` / 烧录守卫（A5）/ 首次构建自动配置；A1–A13 总验收 | **已完成**：A1–A13 全绿（A11 为间接证据），离线 80 个用例 0 失败、契约 16/16（覆盖全部 15 个工具），A1 真机端到端计数器 17 → 39（§8.12） |

## 13. 已定决策总表（单一真相源）

| # | 决定 | 备注 |
|---|---|---|
| 1 | 芯片只 STM32F103C8T6，型号表驱动（后续加 JSON 不改代码） | 引脚名、时钟、容量、链接脚本、openocd target 全从表取 |
| 2 | 代码只写 USER CODE 块；锚点缺失则拒绝并列出可用锚点 | 编码规范留给后续 skill |
| 3 | 工具链 msys64 优先（`D:\app\msys64\ucrt64\bin`），ST bundle fallback | gcc 13.3.0 / gdb-multiarch 16.2 / openocd 0.12.0 / cmake 3.31.5 / ninja 1.12.1 |
| 4 | 探针只 CMSIS-DAP | interface / target / reset_config 走型号表 + 探针表 |
| 5 | 不做 UI，v1 纯工具层 + 斜杠命令 | 无 client 侧代码 |
| 6 | 接受部分调用需全权限 | generate / apply / build / flash；README 明示原因 |
| 7 | `.ioc` 修改永远 plan → 确认 → apply；apply 带 `plan_id` + 源 SHA-256 校验 | 无静默写盘 |
| 8 | 长任务走 job（>20 s：apply / generate / build），其余阻塞 | generate 实测 3–4 min |
| 9 | 调试默认 `debug_run`（用完就关）；`debug_session` 显式申请，由 **`turn/end` 钩子**精确关闭（TTL 60–90 s 仅作安全网） | T1 已确认，见 §6.4 |
| 10 | 生成 = CLI 调用 + 布局映射 + USER CODE 合并 + 脚手架模板（四件事） | §8 实测结论 |
| 11 | 脚手架来源：项目自身复制 或 模板快照（记版本），禁止手写 | 建议以现有 `demo/` 作模板基线 |
| 12 | TypeScript + `tsc` + `engines.node >= 20` + 零运行时依赖 | §9.1 |
| 13 | 验收 A10 / A10q / A13 替代原"逐文件哈希全一致" | 用户已确认 |

## 14. 未定 / 待观察

| # | 项 | 什么时候定 |
|---|---|---|
| T2 | 是否需要"GUI 生成一次作为金标准基线"的回归测试流程 | M1 结束后 |
| T3 | 模板快照取自 `demo/` 还是另建一个最简工程 | M1 设计时 |
| T4 | CubeMX2 是否值得以后做 generator 适配器（`.ioc2`） | v2 视需求 |
| T5 | `regs_read` 是否支持"传符号名，内部用 `arm-none-eabi-nm` 解析成地址"（重新生成后符号地址会漂移，实测 `g_led_blink_count` 0x20000028 → 0x2000002C） | M5 |
| T6 | A10 已降级为"语义等价"（§8.9 发现 1：CLI 与 GUI 的空行数不同）；是否需要"归一化后比对"的自动回归脚本 | M5 |

## 15. 术语表

| 术语 | 含义 |
|---|---|
| 单飞锁 | 同一时刻只允许一个同类外部进程（CubeMX / openocd / ninja） |
| USER CODE 块 | `/* USER CODE BEGIN X */ ... /* USER CODE END X */`，CubeMX 重新生成时唯一保留的区域 |
| 空壳检测 | 生成后检查是否真产出 `MX_GPIO_Init` 等内容（防 P3 假成功） |
| 布局映射 | CLI 的 `Src/`、`Inc/` → 工程的 `Core/Src`、`Core/Inc`，并按 `CoupleFile` 决定是否合并进 `main.c` |
| 租约 | 调试会话的存活凭证，过期自动释放探针 |
| 金标准基线 | 用 GUI 生成一次的结果，作为逐字节对比基准 |

---

**证据索引**：`demo/m0/`（E1–E4 日志 e1–e4.log、清单 e2-before.txt / e2-after.txt）、`demo/.dsh-stm32/backups/20261022-175732/`（generate 落位前的备份，用于 A10 比对）、`demo/mxverify/`（配置变更 → 非 USER CODE 区变化）、`demo/_scratch/`（纯命令行建工程模板：build.ps1 / flash.ps1 / debug.ps1 / README.md）、`demo/.vscode/launch.json`（只烧录 / 烧录并调试两条）。
