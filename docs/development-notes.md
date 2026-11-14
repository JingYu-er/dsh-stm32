# 开发笔记（原 README）

> 这是 0.1.0 发布前的开发记录：里程碑、宿主契约踩坑、19 个工具的实现细节、A1–A13 验收与宿主侧复验。
> 面向使用者的说明已移到仓库根目录的 [README.md](../README.md)。
# dsh-stm32

DSH 插件（宿主侧，无 UI）：把 STM32F1 全系（F100/101/102/103/105/107；0.1.x 时只有 STM32F103C8T6 一块板）的 **环境探测 → .ioc 事务（含时钟）→ 生成工程 → 编译 → 烧录 → 调试** 变成一组可被模型调用的工具。

> **2026-10-30 更新**：F1 全系已支持，HAL 与寄存器两条路线都吃任意 F1 型号，时钟配置已并入 `stm32_ioc_plan`。本文件正文里凡是「只支持 / 只覆盖 C8T6」的句子都是当时的历史记录（按时间记账的要求保留原文），最新口径见 §28。

规格书：[`docs/dsh-stm32-plugin-规格.md`](docs/dsh-stm32-plugin-规格.md)（v0.2）。

## 现在有什么

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M0 | CubeMX 无头调用实测（E1–E4） | 完成，结论见规格书 §8 |
| M1 | 最小可加载插件 + `stm32_env_probe` + `stm32_generate` | 完成（端到端 6/6 通过，见下） |
| M2 | 只读层：ioc_inspect / regs_read / doctor | 完成（三个工具都已实现并真机实测） |
| M3 | build / flash / debug_run（"只烧录不调试"） | 完成（三个工具已实现，真板 e2e 全过） |
| M4 | 事务层：ioc_plan / ioc_apply / 备份 / 回滚 / 调试会话租约 | 完成（六个工具已实现；宿主复验全过，`turn/end` 在我这轮说完话时自动释放探针，已实测） |
| M5 | 打磨 | 完成（五条斜杠命令 + 随插件下发的 `stm32-workflow` SKILL；单测 6/6、真板 e2e 14/14） |
| M6 | 补缺口：`stm32_project_create` / `stm32_code_patch` / 烧录守卫（A5）/ 首次构建自动配置 | 完成（离线 80 个用例 0 失败、契约 16/16 覆盖全部 15 个工具；A1–A13 逐条验收通过，A1 真机计数器 17 → 39，见下与规格书 §8.12） |

## 快速开始（从 GitHub 克隆）

```powershell
git clone git@github.com:JingYu-er/dsh-stm32.git        # 或 https://github.com/JingYu-er/dsh-stm32.git
cd dsh-stm32
npm install --no-audit --no-fund                   # 只装 typescript
npm run build                                       # tsc -> lib/
npm test                                            # 可选：497 个离线用例（34 个套件）
```

然后把 `lib/` 用 `link:` 挂进 dsh 的 profile 并重启 dsh（见下一节）。宿主要求：

| 依赖 | 用途 | 缺了会怎样 |
| --- | --- | --- |
| dsh（能加载 bundle 层） | 宿主 | 插件不会被加载 |
| Node ≥ 20 | 构建 / 测试 | — |
| `openocd`、`gdb-multiarch`、`arm-none-eabi-*`（MSYS2 UCRT64 或 ARM GNU Toolchain） | 编译 / 烧录 / 调试 | `stm32_doctor` 逐个列出缺哪个，并给出该装到哪 |
| STM32CubeMX | `stm32_generate`、首次建工程 | 生成类工具不可用，其余照常 |
| STM32Cube 固件包 F1（随 CubeMX 安装） | `stm32_project_create` 抄 Drivers | 建骨架报「找不到固件包」 |

默认路径在 [`src/data/search-roots.ts`](src/data/search-roots.ts)（msys64 优先），可用 `STM32_BIN_DIRS` / `STM32_CUBEMX_ROOT` 覆盖。型号覆盖 **STM32F1 全系**（F100/101/102/103/105/107，2026-10-30 起；本机验证板仍是 C8T6）：启动文件 / 设备宏 / 链接脚本由 [`src/data/stm32f1.ts`](src/data/stm32f1.ts) + [`src/engine/hal-chip.ts`](src/engine/hal-chip.ts) 派生，引脚表内置一份、也可由本机 CubeMX `db/mcu/*.xml` 派生（见 §28）。
## 开发

```powershell
cd dsh-stm32
npm install --no-audit --no-fund        # 只装 typescript（devDependency）
npm run build                            # tsc -> lib/
```

零运行时依赖：`lib/` 里只有本包自己的 JS，不 require 任何第三方包。

### 为什么自己写类型 shim

dsh 的 asar 只发布 `lib/**/*.js`；各包 `package.json` 的 `types` 指向的
`lib/types/index.d.ts` 并不随包分发。所以 `src/types.ts` 手写本项目用到的那一小部分
宿主契约（tools / subprocess / 句柄字段），保证离线可编译。

## 安装到 dsh

```powershell
# 1) 在 dsh 的 profile 目录里把这个包加为依赖——必须用 link:，不要用 file:
#    file: 在 nodeLinker=hoisted 下是"复制一份"，改了 lib/ 重装才生效，且极易忘
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add "link:<克隆目录>\dsh-stm32"   # 例如 link:D:\work\dsh-stm32
# 若此前用 file: 装过，先删掉复制出来的目录再装，否则 pnpm 可能保留旧副本：
# Remove-Item node_modules\dsh-stm32 -Recurse -Force

# 2) 在 profile 的 package.json 的 dsh.profile.bundles 末尾加 "dsh-stm32"
# 3) 重启 dsh（bundle 层只在进程启动时加载）
```

本包的 `cordis.patch.yml` 会把 `stm32` 这一行插入宿主组合。

安装状态（我这台机器，2026-10-22）：已用 `link:` 装进 `~/.dsh/profiles/desktop`，
`node_modules/dsh-stm32` 现在是 **Junction**（LinkType=Junction，Target=仓库目录），
并在该 profile 的 `dsh.profile.bundles` 末尾登记 `dsh-stm32`；profile 的 `package.json`
留有回滚备份 `package.json.bak-dsh-stm32`。

> 踩过的坑：一开始用 `file:` 装，pnpm 在 `nodeLinker: hoisted` 下把包**复制**成真实目录，
> 于是改完 `src/` + 重新 `tsc` 后，宿主加载的仍是安装那一刻的旧 `lib/`——连重启两次都还是旧代码
> （表现为修好的 bug 依旧复现）。改用 `link:` 后 `lib/` 改动才会被宿主读到。
> 无论哪种装法，bundle 层只在进程启动时加载，改完 `lib/` 仍需重启 dsh 才生效（但不再需要重装）。

## 宿主 subprocess 契约的一个坑

`ctx.subprocess.spawn(spec)` 的 `spec.cwd` **必须显式给字符串**。宿主的
`targetEnvironment()` 会直接对 `spec.cwd` 调 `includes()`，缺省时报
`Cannot read properties of undefined (reading 'includes')`（表现为"命令启动失败"而不是
"cwd 缺省"）。`engine/subprocess-runner.ts` 因此总是填 `cwd = request.cwd ?? process.cwd()`，
`test/smoke-env-probe.mjs` 的假宿主也复刻了这条严格性，避免本地测试掩盖真实宿主里的失败。

## 宿主 skill 契约的一个坑

`ctx.skills.register()` 只校验 `name` / `description` / `invocation`，缺字段照样注册成功（skill 会出现在模型看到的目录里）；
但那份定义在**被读取时**还会过一遍 `validateDefinition()`：`name` / `description` / `source` / `provider` / `content`
必须都是字符串，否则 `skill` 工具直接报 `loaded skill "…" source must be a string`。
`provider` 由 `register()` 兜底成 `runtime`，**`source` 必须自己给**（本插件给的是
`dsh-stm32:src/skill/stm32-workflow.ts`）。教训与 subprocess 的 `cwd` 那条同源：
注册期校验 ≠ 使用期校验，离线测试要按**使用期**校验来断言（`test/commands-units.test.mjs` 现在逐个字段断言）。

## stm32_project_create：空目录 → 一条命令出工程

CubeMX 的 CLI 只产 `Core/` 下的 C 源，不产 CMake 工程文件（§8.3）。所以"从零建工程"要靠脚手架，
而这个工具的原则是**复刻、不发明**：

| 产物 | 来源 | 为什么 |
| --- | --- | --- |
| `CMakeLists.txt`、`CMakePresets.json`、`cmake/**`、`STM32F103XX_FLASH.ld`、`.gitignore` | 随插件下发的**模板快照**（`templates/scaffold/`） | 与同版本 CubeMX GUI 新建工程逐字节一致，只把工程名占位符换掉 |
| `.vscode/{launch,settings,c_cpp_properties}.json` | 同上 | 顺手把"① 只烧录 / ② 烧录并调试"两份配置也给你 |
| `.ioc` | 同上（`demo.ioc` → `<工程名>.ioc`） | 8 个引脚 + RCC + SWD 已配好，`KeepUserCode=true` |
| `Core/Src/{sysmem.c,syscalls.c}` | 模板快照 | GUI 会生成、CLI **不**生成；缺了 `cmake/stm32cubemx/CMakeLists.txt` 的源清单里就有两个不存在的文件，配置直接失败 |
| `Drivers/**`、`startup_stm32f103xb.s`、`Core/Src/system_stm32f1xx.c` | 本机固件包 `<cubeRoot>/Repository/STM32Cube_FW_F1_V1.8.7` | 99 MB 的 ST 代码不内嵌进插件；实测与 GUI 工程同文件逐字节一致 |

- 目标目录非空默认拒绝（宁可报错也不覆盖别人的工程），`overwrite: true` 才继续；
- 工程名必须是 C 标识符（`^[A-Za-z_][A-Za-z0-9_]*$`），否则 `blink-1` 这种名字会进 `set(CMAKE_PROJECT_NAME …)` 和 `.elf` 名里；
- 固件包 Drivers 里有 5392 个文件，4000+ 是 CMSIS 文档站、DSP/NN 示例与自测套件、BSP 板级组件——
  对编译 HAL 毫无用处，只会让工程变大、建工程变慢，所以**明确跳过**（`CMSIS/docs/`、`CMSIS/DSP/{Examples,DSP_Lib_TestSuite,Projects}/`、
  `CMSIS/NN/{Examples,NN_Lib_Tests}/`、`BSP/`）。实测：629 个文件、**~2 s**；
- 不产 `.mxproject`（那是 GUI 的工程元数据，伪造容易和 `.ioc` 不一致）；`Core/` 下的 `main.c` 由 `stm32_generate` 生成。

## stm32_ioc_inspect：只读解析 .ioc

把 `.ioc`（CubeMX 的纯文本配置：每行 `key=value`，值里的 `:` 写成 `\:`）解析成结构化摘要：
MCU 型号、每个引脚的信号/GPIO 标签/模式/归类（gpio / debug / clock / virtual）、使能的外设与中断、
时钟频率（SYSCLK / AHX / APB1 / APB2、PLL 倍频与源）、工程设置（工具链 / 落位目录 / KeepUserCode / CoupleFile）。

毫秒级、不写盘、不起进程（`isConcurrencySafe: true`）。派生判断里最重要的两条：

- **没启用 Serial Wire**（缺 `SYS_JTMS-SWDIO` / `SYS_JTCK-SWCLK`）：CubeMX 会生成
  `__HAL_AFIO_REMAP_SWJ_DISABLE()`，固件一上电就关掉 SWD，烧录后再也连不上（本项目实测踩过，
  只能用 BOOT0 进系统 bootloader 救回来）。工具会直接报这条警告。
- `KeepUserCode=false`、`CoupleFile=true`、非 CMake 工具链、`MainLocation` 不是 `Src`/`Core/Src`：
  都会影响"重新生成时 USER CODE 能不能保住"和落位，逐条报警。

## stm32_generate：无头生成 + 落位

CubeMX 的 CLI 模式（`java -jar STM32CubeMX.exe -q <script>`）**只把 C 代码写到工程根的
`Src/`、`Inc/`**，不管 `.ioc` 里的 `ProjectManager.MainLocation`（M0 实测 E2）。所以 generate
分两步：先让 CubeMX 生成，再按 ST 的工程结构落位。

1. 脚本 = `config load <ioc>` → `generate all_code_in_main`（coupled）或 `generate one_file_per_ip`（per-ip）→ `generate code <工程根目录>` → `exit`；
   参数必须是**目录**，传 `.ioc` 会静默无操作（E3）。
2. 日志里出现 `Code succesfully generated under …`（CubeMX 自己拼错）才算成功，**失败一个字节都不写工程**；
   `PDSC version is not supported` 等已知噪音单独归类，不算失败。
3. 成功后才落位：`Src/x` → `Core/Src/x`、`Inc/x` → `Core/Inc/x`；目标文件已存在时
   把旧文件里 **USER CODE `BEGIN/END <label>` 的正文按标签搬进新内容**（CRLF 原样保留），
   旧有新无的标签记进 `droppedLabels` 提醒人工确认；覆盖前把旧文件备份到
   `.dsh-stm32/backups/<时间戳>/<相对路径>`。
4. 收尾只删本次搬运过的 `Src/`、`Inc/` 文件与随之变空的目录——**不会** `rm -rf` 整个 `Src/`
   （有的工程本来就用 `Src/` 当源码目录）。
5. 全程单飞：`.dsh-stm32/lock.json` 30 分钟内视为被占用，避免两个 CubeMX 同时写用户级数据库。

工具默认走后台 job（一次 3–4 分钟，CubeMX 启动就要 90–150 s），返回 `jobId`，进度用 `job_output` 读；
`foreground: true` 则同步返回完整报告。

## stm32_build：编译

`cmake --build <构建目录> --parallel`，构建目录自动推断：先读 `CMakePresets.json` 的
`binaryDir`，再扫 `build/*/CMakeCache.txt`（优先含 Debug），所以插件与 VS Code 看到同一个 `.elf`。

- 错误行按文件去重后返回（`file:line:col: error:`、`undefined reference`、`collect2`、`ninja: build stopped` 等都认）；
- 命中链接时会解析 `ld --print-memory-usage` 的 RAM/FLASH 占用；增量构建没链接就没有这份数据，报告里会说明；
- 默认后台 job（全量编译实测 56 s），`foreground: true` 同步返回；
- **首次构建自动配置**：`build/<preset>/CMakeCache.txt` 不存在时（新建工程就是这样），先用
  `cmake --preset <名字带 Debug 的那个>` 配置一次，再编译；配置失败会把 `CMake Error` 原样返回，
  不会用一个空构建目录糊过去。省掉"新建完工程还得自己跑一遍 cmake"这一步。
- **拦住"假成功"**：把含 `build/` 的工程复制或改名后，cmake 会打印
  `CMake Error: The current CMakeCache.txt directory … is different than …`，但 ninja 仍旧 `no work to do`、
  **退出码 0**——只看退出码就会报"编译成功"，实际拿的是别人的旧缓存。现在这种行一出现就判失败，
  并提示"先 clean 或删掉 build/Debug 再编译"（验收脚本 `harness.mjs` 的 `freshCopy` 也因此不再复制 `build/`）。

## stm32_flash：只烧录，不进调试（用户最初的痛点）

等价于命令行：

```
openocd -f <工程的 openocd.cfg> -c "program <elf> verify reset exit"
```

跑完 `reset` 就退出：芯片复位运行、探针立刻释放，**不拉起调试会话、不停在 main**（F5 与 Ctrl+F5 都会进调试适配器，
这个工具不会）。实测 2.2 s，`** Programming Finished **` + `** Verified OK **` 才算成功。

- 配置优先用工程里的 `openocd.cfg`；没有则回退 `interface/cmsis-dap.cfg` + `target/stm32f1x.cfg`；
- 连不上 DP 时给的是可执行建议（BOOT0 进系统 bootloader / 按住复位抢时序），不是一句"失败"。
- **烧前守卫（验收 A5）**：先读工程 `.ioc`，SYS 调试口不是 Serial Wire（PA13/PA14 缺失或 `No_Debug`）就
  **拒绝烧录**并给修法——因为那种配置会生成 `__HAL_AFIO_REMAP_SWJ_DISABLE()`，烧进去 SWD 直接失联，
  只能靠 BOOT0 进系统 bootloader 救回来。真要在这种板子上烧，得显式 `allowNoDebug: true` 认领风险；
  没有 `.ioc` 的工程（别人给的 hex）不拦。

## stm32_code_patch：只写 USER CODE 块

改 `main.c` 里的逻辑不该靠"整文件重写"——那会把 CubeMX 生成区碰坏，重新 generate 就全没了。
这个工具只认标签：

```json
{ "projectDir": "…", "file": "Core/Src/main.c", "block": "3", "code": "g_count++;", "mode": "replace" }
```

- 按行找 `/* USER CODE BEGIN <block> */` 与 `/* USER CODE END <block> */`，只替换/追加两者之间；
- **块外字节原样保留**（含 CRLF——有工程是 CRLF，统一成 LF 会让整文件在 diff 里"全变"）；
- 写前把原文件备份到 `.dsh-stm32/backups/<时间戳>-<文件名>-patch/`，然后临时文件 + `rename` 原子替换；
- 拒绝三种输入：`code` 里带 `USER CODE BEGIN/END` 标记（会破坏配对）、`file` 是绝对路径或含 `..`（会跑出工程目录）、
  块不存在——失败时把该文件里**所有可用标签**列出来，不用猜。
- CubeMX 产出的 `main.c` 用的是**短标签**：私有变量是 `PV`、函数原型是 `PFP`、`while(1)` 前的初始化是 `2`、
  循环体是 `3`。把文档里的长名字（`Private variables`）当 `block` 传会被拒并把 19 个真标签全列出来（真宿主实测），
  照抄标签即可——工具不猜同义词，是因为猜错就会把代码写进错的块、编译期还不一定报错。

## stm32_debug_run：要调试时才调试

一次调用：起 openocd（端口 3333 被占则顺延）→ gdb 连上 → `monitor reset halt` → `break main` → `continue` →
抓 `pc/sp/lr/xpsr`、`bt`、`info locals` → `monitor reset run` + `detach` → 关掉 openocd。

所以它**不常驻**：交还控制权那一刻探针已经释放，用户随时可以自己用 VS Code F5 接着调。
（规格 §6 的常驻会话形态留给 M4，届时用宿主 `turn/end` 事件在轮次结束时强制关闭。）

## stm32_doctor：开工前先体检

一次调用回答三个问题，2 s 左右，只读：

1. **工具链齐不齐**：gcc / gdb / openocd / cmake / ninja 逐项探测（cubemx、JRE 是加分项，不阻塞）；
2. **探针被谁占**：`tasklist` 里是否有 `openocd.exe` / `gdb-multiarch.exe` / `arm-none-eabi-gdb.exe`，
   以及 gdb 端口（默认 3333）是否已被监听——"调试器连不上"最常见的两个原因都在这里暴露；
3. **工程能不能烧**：推断构建目录与 `.elf`、解析 `.ioc` 的致命告警（例如没开 Serial Wire 会生成
   `__HAL_AFIO_REMAP_SWJ_DISABLE()`）。

`ok=false` 时 `blockers` 里是逐条可执行的原因，`notes` 是补充说明。

## stm32_regs_read：读外设寄存器验证"程序真的在跑"

按地址读 32 位字，例如 "0x4001100C"（GPIOC_ODR）、"0x40010004"（AFIO_MAPR）。做法是写一个临时
Tcl 给 openocd：`init` → `halt` → 读 pc 与每个地址 → `resume` → `shutdown`，跑完删脚本，
**探针一定被释放、芯片继续原样运行**（不复位）。实测 0.4–1.3 s。

- 地址接受 `4001100c` / `0x4001100C` 混写，输出统一 `0x` + 8 位小写；
- `pc` 取自 openocd 的 halt 横幅（`xPSR: … pc: 0x…`）——比 `[reg pc]` 的列表格式稳定；
- 用途：确认 LED 真的在翻转（GPIOC_ODR 的 bit13 交替）、确认 SWD 没被固件关掉
  （AFIO_MAPR 的 SWJ_CFG，`2`=Serial Wire 正常、`4`=调试口已关）；
- 收尾是 `resume` 不是 `reset run`：`reset run` 会复位芯片，固件里的计数器/状态从头开始，
  "只读一眼"就带了副作用。实测踩过这个坑，`test/e2e-doctor-regs.mjs` 里有两条断言盯着它；
- 只接受**物理地址**，不猜符号：符号地址会随重新生成/链接漂移（实测 `g_led_blink_count`
  从 0x20000028 挪到 0x2000002C，老地址变成了 `uwTick`）。要用符号就先
  `arm-none-eabi-nm build/Debug/demo.elf | findstr g_led_blink_count` 查地址。

## stm32_ioc_plan / stm32_ioc_apply：配置是"事务"，不是随便写盘

改 `.ioc` 一律两步，中间必须有人点头：

1. `stm32_ioc_plan` 只读算 diff，把候选文件写到 `.dsh-stm32/plans/<planId>.ioc`，返回
   `planId` + 源文件 SHA-256 + 逐键 `added/removed/changed`（**不动源文件**）。
2. `stm32_ioc_apply` 必须带 `planId`；写盘前再核一次源文件 SHA-256，被人在中间改过就拒绝。

`plan` 能做四类改动：`entries[{key,value}]` 改已有键、`unset[]` 删键、`pins[{pin,signal,label,pull,speed}]`
按芯片引脚表加 GPIO（自动重编号 `Mcu.PinN`/`Mcu.PinsNb`、查重名与非法标签）、`serialWire:true`
补 PA13/PA14 的 Serial Wire（顺手删掉 `VP_SYS_VS_ND`——那是 `__HAL_AFIO_REMAP_SWJ_DISABLE()` 的源头）。

写盘前有三道闸：没有 Serial Wire、`KeepUserCode=false` 直接拒绝；写盘是"备份到
`.dsh-stm32/backups/<时间戳>-ioc/` → tmp+rename 原子替换 → 写完重新解析校验"，校验不过自动回滚。
`rollbackFrom` 可传某个备份路径把 `.ioc` 退回（只接受 `.dsh-stm32/backups/` 下的路径，避免误删别的文件）。

## stm32_debug_session / stm32_debug_eval / stm32_debug_stop：要连着调才开会话

- `stm32_debug_session`：起一个常驻 openocd（`.elf` 自动解析），空闲 90 s 自动关、硬上限 10 min。
- `stm32_debug_eval`：每次临时起 `gdb -batch`，`monitor halt` → 命令 → `monitor resume` → `detach`，
  所以芯片读完立刻接着跑；支持 `commands[]` 或 `expression`（如 `g_led_blink_count`）。
- `stm32_debug_stop`：立刻释放探针，幂等。

**自动关的时机**：插件的 `apply` 里挂了 `session/event` 的 `turn/end` 监听——也就是说
"我（模型）这一轮输出结束、把控制权交回给你"的瞬间就会 `taskkill` openocd，探针立刻归你，
不用等我记起来关。`session/disposed` 与插件 `dispose` 走同一条清理路径。

另外 `build` / `flash` / `debug_run` / `generate` 开跑前会先调 `releaseProbeFor()`：
会话开着就先关掉，避免"我自己的会话占着探针，导致烧录失败"。

## 宿主输出契约的坑（两次真实翻车）

宿主的 ptc runtime 会在 `execute` 返回后校验输出，规则比 asar 里那个
`@deepseek-ai/dsh-tools` 的 `validateJsonSchemaValue` 严格得多：

1. `additionalProperties: false` 必须严格遵守——`stm32_flash` 曾经返回了 schema 里没声明的
   `args`，**烧录副作用已经发生**，调用却报
   `"value.report.args" is not a declared property`；
2. 声明为 `string` / `number` / `object` 的字段**不接受 `null`**——`build` / `flash` 失败时写
   `exitCode: null` 被拒（`"value.report.exitCode" must be a number`）。失败信息改用可选字段
   （`exitCode?: number`）+ 条件展开，samples 之类用数组留空代替 null。

因此 `test/schema-guard.mjs` 用假 subprocess 触发每个工具的失败早退路径，按 schema 离线复刻这两条
校验（未声明键 / null / 类型 / required），避免再次"线上才发现"。

## 斜杠命令：不想让我绕路时直接敲

工具是给我（agent）调的；你要自己动手时用命令，一条命令一个动作，不经过模型决策：

| 命令 | 做什么 | 会不会动板子 |
| --- | --- | --- |
| `/stm32-doctor` | 体检：工具链、被占用的调试进程、端口、`.elf`、`.ioc` 告警 | 否 |
| `/stm32-build [dir] [--clean]` | 编译，打印内存占用 / `.elf` / 错误 | 否 |
| `/stm32-flash [dir]` | **只烧录**：program + verify + reset，不建调试会话、不下断点 | 是 |
| `/stm32-debug [dir]` | **烧录 + 调试**：烧完停到 `main`，会话保留（空闲 3 分钟 / 上限 10 分钟，我这一轮说完话也会自动关） | 是 |
| `/stm32-stop` | 关掉 `/stm32-debug` 开的会话，把探针还给 VS Code | 否 |

`[dir]` 省略时用当前会话的工作目录（`ctx.workingDirectory.ensure`）。这正是最初那个痛点的答案：
烧录和调试是两条路，`/stm32-flash` 永远不进调试会话，想调的时候再 `/stm32-debug`。

## SKILL：`stm32-workflow`

插件加载时会向 dsh 注册一个运行时 skill，名字 `stm32-workflow`。它把我这一路踩出来的纪律写成硬规范，
在任何「改这个 STM32 工程」的会话里都会先被加载：

- R1 写代码只准落在 `/* USER CODE BEGIN X */` 与 `/* USER CODE END X */` 之间；
- R2 **不许改 CubeMX 生成区**：`main()`、`SystemClock_Config()`、`MX_*_Init()`、`main.h` 的 Private defines 段、
  `stm32f1xx_hal_msp.c`、`stm32f1xx_it.c`、`stm32f1xx_hal_conf.h`、startup、`.ld`、`CMakeLists.txt`、
  `cmake/stm32cubemx/CMakeLists.txt`、`.mxproject`、`demo.ioc`——理由：`cmake/stm32cubemx/CMakeLists.txt:21-28` 把源清单写死，
  而 `.ioc` 一旦重新生成，任何手改都会被覆盖；
- R3 `.ioc` 的改动只能走 `stm32_ioc_plan` → 人确认 → `stm32_ioc_apply`；
- R4 不许把 SYS 调试模式设成 `No_Debug`（会生成 `__HAL_AFIO_REMAP_SWJ_DISABLE()`，烧进去 SWD 永久失联）；
- R5 烧录与调试分开；烧录成功的证据是 `** Programming Finished **` 和 `** Verified OK **`，不是「没报错」；
- R6 探针只有一块：烧录 / 调试 / 后台会话同一时刻只能有一个；
- R7 先 build 再 flash；
- R8 结论要带寄存器证据（`stm32_regs_read`），不许只说「应该没问题」。

## 本地测试

分两档：**离线套件**只用仓库自带的 `test/fixtures/`（合成 .ioc、CMake 缓存占位、main.c 样本），不需要板子 / CubeMX / 工具链，也不写 Flash，CI 只跑这一档；**真机 e2e** 要你自己指一个能构建的工程。

### 脚本清单（前 10 个是离线套件，CI 只跑它们；e2e 见下一节）

```powershell
npm run build
node test\run-units.mjs             # 10 个套件、80 个用例一次跑完（下面逐个列）

# 单套件：
node test\engine-units.test.mjs   # 8 个纯逻辑用例：脚本拼装 / 日志判定（含"成功行压过过程 ERROR"）/ 落位映射 / USER CODE 合并（含 CRLF）
node test\ioc-units.test.mjs      # 6 个 .ioc 解析用例：转义 / 重复键 / demo.ioc 与 scratch.ioc 全量 / SWJ_DISABLE 等告警
node test\smoke-env-probe.mjs     # 用真实进程跑 stm32_env_probe 的引擎
node test\build-units.test.mjs    # 5 个构建报告解析用例：ld 内存表 / 错误去重 / 构建目录与 .elf 推断
node test\flash-units.test.mjs    # 6 个烧录用例：openocd 命令拼装 / 日志判定 / 配置与 .elf 定位
node test\doctor-regs-units.mjs   # 5 个用例：tasklist 解析 / 地址归一化 / regs 的 Tcl 脚本 / openocd 真实日志格式
node test\ioc-plan-units.test.mjs  # 9 个事务用例：plan 不写源文件 / apply 核 SHA / 引脚校验 / rollback
node test\session-units.test.mjs  # 8 个会话用例：租约、续租、超时自动关、重复 start、无会话时 eval
node test\schema-guard.mjs        # 17 个工具的输出契约守卫（未声明键 / null / 类型），离线复刻宿主校验
node test\e2e-generate.mjs D:\tmp\copy-of-demo   # 真调 CubeMX（2–4 分钟），在副本上验证落位与 USER CODE 保活
node test\e2e-build.mjs          # 真编译 demo（clean，约 1 分钟）
node test\e2e-flash.mjs          # 真烧录 demo（会写板子）
node test\e2e-debug.mjs          # 真调试快照（停在 main 读寄存器后释放探针）
node test\e2e-doctor-regs.mjs    # 真体检 + 真读寄存器（AFIO_MAPR / GPIOC_ODR / g_led_blink_count）
node test\e2e-session.mjs        # 真板长会话：两次读计数递增 → 读 pc → 关会话 → 端口释放
node test\e2e-plan-generate.mjs  # 事务闭环：plan 加 PA5/led2 → apply → 真 CubeMX 生成 → USER CODE 保活 → rollback
node test\commands-units.test.mjs # 6 个命令/SKILL 用例：五条命令注册、名字合法、路径解析、SKILL 硬规范关键词、缺服务不炸
node test\e2e-commands.mjs       # 真板跑五条斜杠命令（doctor/build/debug/stop/flash），14 条断言
node test\e2e-scaffold.mjs        # A1 全家桶：空目录→骨架→生成→build→补丁→build→烧录→读计数器（约 2 分钟，会写板子）
node test\e2e-a5-flash-guard.mjs  # A5：No_Debug 的 .ioc 必须被拦在烧录之前；allowNoDebug 才放行（会写板子）
node test\e2e-a6-build-error.mjs  # A6：注入语法错 → build 返回 file:line:col；改回后重新编译成功
node test\e2e-a7-a12-probe.mjs    # A7/A12：错误探针报错且无残留；探针被占时报错，释放后能正常烧录
node test\e2e-a8-ioc-rollback.mjs # A8：apply→rollback 的 SHA 往返、源被手改/候选被手改都拒写
node test\e2e-a9-cancel.mjs       # A9：取消 build（5 ms）与取消 CubeMX（8.4 s）——无残留、锁已释放
node test\e2e-a10q-product-parity.mjs # A10q：同一 .ioc 让 CubeMX 直接生成，和插件产物去 USER CODE 后逐字节比对（约 70 s）
```

### 真机 / 真 CubeMX 的 e2e（需要自己指工程）

```powershell
$env:DSH_STM32_E2E_PROJECT = 'D:\work\my-stm32'   # 任何能构建的工程：有 openocd.cfg + build\Debug\*.elf
node test\e2e-flash.mjs                            # 也可把目录当第 1 个参数传
```

| 脚本 | 额外需要 |
| --- | --- |
| `e2e-build` / `e2e-flash` / `e2e-debug` / `e2e-doctor-regs` / `e2e-session` / `e2e-commands` | 板子 + 探针 + `DSH_STM32_E2E_PROJECT` |
| `e2e-generate` / `e2e-plan-generate` / `e2e-a10q-product-parity` | 同上 + 本机 CubeMX（`STM32_CUBEMX_ROOT`） |
| `e2e-scaffold` | 板子 + CubeMX + 工具链；目标目录用参数或 `DSH_STM32_E2E_ROOT` 指定 |
| `e2e-a5` / `e2e-a6` / `e2e-a7-a12` / `e2e-a8` / `e2e-a9` | 板子 + CubeMX + 工具链 + `DSH_STM32_E2E_PROJECT` |

没给 `DSH_STM32_E2E_PROJECT` 也没给参数时，脚本直接报错并打印用法，不会“悄悄用夹具糊过去”——夹具里的 `.elf` 是 4 KB 占位文件，烧了只会白白浪费一次刷写。

### 验收结论（A1–A13，2026-10-22 实跑）

| ID | 结论 | 关键证据 |
| --- | --- | --- |
| A1 | 通过 | `e2e-scaffold`：骨架 2095 ms（14 文件 + 629 固件文件）→ 生成 77 s → build 5.2 s → 补丁 → build 1.8 s → 烧录 2.1 s → 计数器 **17 → 39** |
| A2 | 通过 | 同一轮：`code_patch` 写的 USER CODE 内容在重新生成与编译后仍在 |
| A3 | 通过 | 同一轮 `stm32_flash`：programmed/verified 均 true，全程无 gdb |
| A4 | 通过 | `e2e-debug`：停在 `main.c:74`，pc/sp/lr 正确，收尾 detach |
| A5 | 通过 | `e2e-a5-flash-guard`：拦在烧录之前、`guard="no-debug"`、给修法；`allowNoDebug` 才放行 |
| A6 | 通过 | `e2e-a6-build-error`：`main.c:102:15: error: expected expression before ';' token` |
| A7 | 通过 | `e2e-a7-a12-probe`：`Error: No J-Link device found`、残留 openocd 0 → 0、随后仍能连上芯片 |
| A8 | 通过 | `e2e-a8-ioc-rollback`：SHA `9d4e8d8e8073 → 5fde2c05f6e5 → 9d4e8d8e8073`；两种手改都拒写 |
| A9 | 通过 | `e2e-a9-cancel`：预取消 build 5 ms；CubeMX 取消后 8.4 s 返回、无残留、锁释放、无多出进程 |
| A10 | 通过（语义等价） | GUI 与 CLI 空行数不同（规格书 §8.9），逐字节不可达；A10q 证明插件没夹带风格 |
| A10q | 通过 | `e2e-a10q-product-parity`：6 个文件去 USER CODE 后逐字节一致；只多 `syscalls.c`/`sysmem.c`/`system_stm32f1xx.c` |
| A11 | 间接通过 | 需人在 VS Code 里按 F5（本轮未自动化）；模板 `launch.json` 与 `demo/` 逐字节一致，用户已在 `demo/` 用过 F5/Ctrl+F5 |
| A12 | 通过 | 同 `e2e-a7-a12-probe`：探针被占 → 报 `CMSIS-DAP transfer count mismatch`；释放后 1.6 s 烧录成功 |
| A13 | 通过 | 13 个工程文件与 GUI 新工程逐字节一致；唯一有意差异是 `cmake/user/CMakeLists.txt`（`demo/` 里是脏数据） |

注意：`node --test` 在受限沙箱下会 `spawn EPERM`，直接用 `node <file>` 进程内运行即可。

### 宿主侧复验（重启 dsh 后，2026-10-22）

离线套件证明的是引擎；下面这轮是**真宿主**重跑——工具由 dsh 进程注册、经 SDK 调用，不是直接 import `lib/`：

| 步骤 | 宿主调用 | 结果 |
| --- | --- | --- |
| 建工程 | `stm32_project_create`（空目录 `_host-verify/m6`，工程名 `m6probe`） | ok、**1690 ms**、14 个模板文件 + 629 个固件文件、`.ioc` 与固件包路径都正确 |
| 生成 | `stm32_generate`（后台 job） | 完成、CubeMX **61.0 s**、6 个文件 created、布局 coupled、备份 `.dsh-stm32/backups/20261022-192156` |
| 补丁 | `stm32_code_patch` | `block="3"` append 成功（1 → 2 行）；`block="Private variables"` 被拒并列出 19 个真标签（真标签是 `PV`） |
| 编译 | `stm32_build`（foreground） | 首次构建自动 `cmake --preset Debug`（5.4 s），编译 **3.0 s**、0 错 0 警告、RAM 7.73% / FLASH 7.21% |
| 烧录 | `stm32_flash` | **2.5 s**、programmed=true / verified=true（纯 openocd，无 gdb） |
| 回读 | `stm32_regs_read`（`g_host_check` @ `0x2000000C`，地址用 `nm` 取） | `0x03f99ddd` → `0x0484cfac`（间隔 2 s），证明烧完的固件自己在跑，随时能“想调试再调” |
| A5 守卫 | `stm32_flash`（No_Debug 的 `a5.ioc` + 复制来的 `build/`） | ok=false、`guard="no-debug"`、`args=[]`（连 openocd 参数都没拼），修法与逃生门都在 notes 里 |

结论：`project_create → generate → code_patch → build → flash → regs_read` 在真宿主上是一条不断的链，
A1 的“一条命令出工程”与 A5 的“拒绝烧录”在宿主侧同样成立。

## 开源 / 发布

仓库地址是 `https://github.com/JingYu-er/dsh-stm32`（`package.json` 的 repository / homepage / bugs 已指向它，已有一份首次提交）。

在 GitHub 上新建一个**空**仓库 `JingYu-er/dsh-stm32`（不要勾 README / .gitignore / LICENSE，否则首推要先 `git pull --rebase`），然后：

```powershell
git remote add origin git@github.com:JingYu-er/dsh-stm32.git   # 或 https://github.com/JingYu-er/dsh-stm32.git
git push -u origin main
```

走 SSH：先把 `~/.ssh/id_rsa.pub` 的内容加进 GitHub → Settings → SSH and GPG keys，再 `ssh -T git@github.com` 确认返回 `Hi JingYu-er!`。走 HTTPS：由 Git Credential Manager 弹窗登录。

- CI：`.github/workflows/ci.yml` 会在每次 push / PR 跑 `npm ci → build → 80 个离线用例`（windows-latest，因为插件面向 Windows 上的 MSYS2 / CubeMX）。
- 发 npm（可选）：`npm publish`。若 `dsh-stm32` 已被占用，改 `package.json` 的 `name`，并同步 README 的安装命令；`files` 已包含 `lib/`、`templates/`、`docs/`，`templates/` 是脚手架必需的（漏了 `stm32_project_create` 会在别的机器上找不到模板）。
- 别人装的时候仍然建议 `link:` 到本地克隆（见上一节），因为插件要跟着 `lib/` 重编译、且烧录/调试依赖本机工具链。
## 环境变量（可选）

- `STM32_BIN_DIRS`：工具链目录列表，`;` 分隔；默认 `D:/app/msys64/ucrt64/bin` 优先。
- `STM32_CUBEMX_ROOT`：CubeMX 安装根目录；默认 `D:/app/STM32CubeMX`。
- `DSH_STM32_E2E_PROJECT`：真机 e2e 用的工程目录（含 `openocd.cfg` 与 `build\Debug\*.elf`）；也可直接当脚本第 1 个参数传。
- `DSH_STM32_E2E_ROOT`：e2e 临时副本放哪；默认系统临时目录。

## 目录

```
src/
  index.ts                 插件入口：name / inject / apply
  types.ts                 宿主契约的最小类型声明
  data/search-roots.ts     工具链路径数据（路径是数据不是逻辑）
  engine/subprocess-runner.ts  L0 子进程封装（Job 范围、超时、runCapture/runStreaming）
  engine/probe.ts          L1 工具链探测（纯逻辑 + 一次版本执行）
  engine/generate-script.ts    L1 生成脚本拼装 + 日志判定（纯字符串）
  engine/usercode-merge.ts     L1 USER CODE 保活（按标签搬运，保留行尾）
  engine/layout.ts             L1 生成物落位映射（Src/Inc → Core/Src、Core/Inc）
  engine/generate.ts           L2 生成工作流（锁 → 跑 CubeMX → 判定 → 落位 → 备份 → 清理）
  engine/ioc.ts                L1 .ioc 解析与派生判断（纯逻辑，含 SWJ_DISABLE 等告警）
  engine/scaffold.ts           L2 空目录建骨架（模板快照 + 固件包 Drivers + startup/system）
  engine/code-patch.ts         L1 只写 USER CODE 块（行级扫描、CRLF 原样、备份、原子写）
  engine/build.ts              L2 编译（构建目录/elf 推断、错误归类、内存占用解析）
  engine/flash.ts              L2 只烧录（openocd program/verify/reset/exit）
  engine/debug.ts              L2 调试快照（openocd + gdb，抓现场后释放探针）
  engine/doctor.ts             L2 体检（工具链 + 占用的探针进程 + 端口 + 固件/.ioc 告警）
  engine/regs.ts               L2 读寄存器（临时 Tcl，halt 读值后 resume 释放探针，不复位芯片）
  data/chips.ts                芯片数据（STM32F103C8T6 引脚表 / Flash / RAM）
  engine/ioc-plan.ts          L2 .ioc 事务（diff → 候选文件 → 备份 → 原子写 → 校验回滚）
  engine/debug-session.ts     L2 调试会话（常驻 openocd + 临时 gdb，租约与探针让出）
  templates/scaffold/         随插件下发的模板快照（CMake 工程文件 / .ld / .vscode / .ioc，工程名占位符 __PROJECT_NAME__）
docs/dsh-stm32-plugin-规格.md  规格书（与 README 的验收结论同源）
test/fixtures/               离线套件用的夹具工程（合成 .ioc / CMake 缓存占位 / main.c 样本，见该目录 README）
test/fixtures.mjs            测试路径唯一的来源：夹具、e2e 工作目录、e2e 工程（环境变量优先）
.github/workflows/ci.yml     CI：node 20 + npm ci + build + 离线套件
  tools/env-probe.ts       L3 stm32_env_probe 工具
  tools/project-create.ts  L3 stm32_project_create 工具（空目录建骨架，~2 s）
  tools/code-patch.ts      L3 stm32_code_patch 工具（只写 USER CODE 块）
  tools/generate.ts        L3 stm32_generate 工具（默认 job 形态）
  tools/ioc-inspect.ts     L3 stm32_ioc_inspect 工具（只读）
  tools/build.ts           L3 stm32_build 工具（默认 job 形态）
  tools/flash.ts           L3 stm32_flash 工具（阻塞，烧完释放）
  tools/debug.ts           L3 stm32_debug_run 工具（阻塞，抓完快照释放）
  tools/doctor.ts          L3 stm32_doctor 工具（只读体检）
  tools/regs.ts            L3 stm32_regs_read 工具（只读，阻塞）
  tools/ioc-plan.ts        L3 stm32_ioc_plan 工具（只读算 diff，不写源文件）
  tools/ioc-apply.ts       L3 stm32_ioc_apply 工具（带 planId 才写盘，支持 rollbackFrom）
  tools/debug-session.ts   L3 stm32_debug_session / _eval / _stop 三个工具
  commands/register.ts     L3 五条斜杠命令（/stm32-flash、/stm32-debug、/stm32-stop、/stm32-build、/stm32-doctor）
  skill/stm32-workflow.ts  L3 随插件下发的 SKILL（USER CODE 硬规范 + 实测坑清单）
```

## CI 上的一个坑：`node:test` 的输出格式跟着 reporter 变

`test/run-units.mjs` 要汇总 10 个套件的用例数，其中 5 个套件用 `node:test`
（doctor-regs / engine / flash / scaffold-patch / schema-guard）。坑在于 `node:test`
的默认 reporter 不是固定的：

| 环境 | 结尾长什么样 | 旧版 `parseCounts` |
| --- | --- | --- |
| 本机 Node 24（spec reporter） | `ℹ pass 16` / `ℹ fail 0` | 认得 |
| CI 的 Node 20（非 TTY → tap reporter） | `# pass 16` / `# fail 0` | **认不出** |

后果：同一个提交本机 `TOTAL pass=80 fail=0`，GitHub 上 `npm test` 直接红——
5 个套件被判成"用例数无法解析"并让退出码变 1。首两次 CI（`fca08ff`、`3d25d48`）
都栽在这一步，`npm ci` 与 `npm run build` 其实都过了，所以红得莫名其妙。

现在 `parseCounts` 认四种结尾：spec（`ℹ pass`）、tap（`# pass`）、自写断言
（`tests N / fail M`）、commands（`commands-units: N pass / M fail`）；
解析不到时把该套件**结尾 6 行**打进日志，套件退出码非 0 也一律算失败
（以前只要它自报 `fail=0` 就放过，崩溃会被吞掉）。

验收方式：把 Node 20 的可移植包解到本地，直接用它跑汇总脚本，不复用系统 Node：

```powershell
& 'D:\path\to\node-v20.19.0-win-x64\node.exe' test/run-units.mjs
# doctor-regs/engine/flash/scaffold-patch/schema-guard 都显示 (tap)，TOTAL pass=80 fail=0
```

教训与 subprocess 的 cwd 坑、skill 的 source 坑同源：**只在真环境里暴露的契约**。
本地 Node 版本比 CI 新时，"我这能跑"的结论对 CI 无效，要么对齐版本，要么让解析层容忍两种格式。

## 离线套件的 hermeticity：不 spawn ≠ 不依赖环境

起因是这样一个问题：「GitHub 上没有能调用的 msys64 和 CubeMX，也能测试吗？」

审计结论（10 个离线套件）：

- 只有 `commands-units` 与 `session-units` 出现 `spawn(`，且都是**假 subprocess 注入**
  （`makeSubprocess()` 记录 argv，不真起进程）；
- 只有 `scaffold-patch-units` 真依赖 CubeMX：两条用例写着
  `skip: !existsSync(path.join(CUBE_ROOT, "Repository", DEFAULT_FIRMWARE_PACKAGE))` → runner 上是 SKIP；
- 但 `session-units` 用的是 `fixtures.binDirs()`，环境变量未设时返回开发机默认值
  `D:/app/msys64/ucrt64/bin`、`C:/msys64/ucrt64/bin` —— runner 上都不存在。

于是出现了一个假象：subprocess 明明是假的，套件照样红。原因是**路径解析仍会打真实磁盘**：
`src/engine/probe.ts:57` 的 `resolveFromDirs()` 用 `existsSync()` 判存在，
`src/engine/debug-session.ts:174` 解析不到 openocd 就返回「找不到 openocd」，`:254` 解析不到 gdb 返回「找不到 gdb」。

复现办法（也是验收办法）：干净副本里把 `CUBE_ROOT` 改成不存在的路径，再设
`STM32_BIN_DIRS=C:/__no_such_bin__`、`STM32_CUBEMX_ROOT=C:/__no_such_cubemx__`、
`PATH` 只留 node 与 System32，用 Node 20 跑 `test/run-units.mjs`。
修复前：`TOTAL pass=78 fail=6`（全在 session-units）；修复后：`TOTAL pass=78 fail=0` + 2 skipped。

修复分两处：

1. `test/fixtures.mjs` 新增 `fakeBinDirs(tag = "bin")`：用 `mkdtempSync` 建临时目录，写入
   空文件占位的 `openocd` / `openocd.exe` / `gdb-multiarch` / `gdb-multiarch.exe` /
   `arm-none-eabi-gcc(.exe)`，返回 `[dir]`；`session-units` 改用它。
2. 顺手修了产品侧一处错位：`debug_session` 的 `eval` 过去只读 `resolveSearchConfig(process.env, {})`，
   **无视调用方传进来的 `binDirs`** ⇒ 换台机器会出现「openocd 起来了，eval 却说缺 gdb」。
   现在 `InternalSession` 记下起会话时解析出的 `binDirs`（`start()` 里 `binDirs: config.binDirs`），
   `eval()` 依次查 `session.binDirs` → `this.binDirs`（`configure()` 传入）→ 环境默认值。

最终数字：开发机 80 全跑；hermetic 模拟（Node 20、PATH 里没有工具链、没有 CubeMX）78 pass + 2 skipped、退出码 0。
结论：**「不 spawn」不等于「不依赖环境」** —— 只要代码里有 `existsSync` / `resolveFromDirs`，就得给它可控的目录。

## 安装路径的坑：为什么别人一条命令就能装，我们得 clone + build

用户问（m04070 附近）：别人的插件一条命令就装上了

```text
dsh plugin --profile web add github:2768651338/dsh-plugin-manager#main
```

为什么我们得 `git clone` + `npm install` + `npm run build`？查清了，结论是：**`dsh plugin add github:` 本身就能一条命令装完（还会自动写 `dsh.profile.bundles`），
但 pnpm 不会替 git 依赖跑构建 —— 谁的仓库里带着编译产物，谁才能一条命令装上。**

### 1. 实测：一条命令装得上，但没有 `lib/`

拿当时还没提交 `lib/` 的仓库试（profile `probe2`）：

```text
dsh: initialized profile probe2 at C:\Users\JingYu\.dsh\profiles\probe2
+ dsh-stm32 0.1.0
Done in 2m 13.4s using pnpm v11.28.5
```

`package.json` 里 `dependencies` 写了 `github:JingYu-er/dsh-stm32#main`、`dsh.profile.bundles` 自动多了 `dsh-stm32` —— 看起来一切正常。
但安装目录里只有：

```text
cordis.patch.yml  docs  LICENSE  package.json  README.md  README_EN.md  templates
```

**没有 `lib/`**。`cordis.patch.yml` 指向 `lib/index.js`，所以宿主重启后加载不到这个 bundle —— 装上了等于没装。
（`files` 白名单对 git 依赖同样生效，所以 `src/`、`test/` 不会进 profile，这点是对的。）

### 2. pnpm 的构建触发器只有三个（加上一个权限门）

内置 pnpm 11.28.5（`resources/runtime/primary-runtime/dependencies/pnpm`）里 `packageShouldBeBuilt(manifest, pkgDir)`：

- `scripts.prepare` 非空 → 构建；
- 否则看 `prepublish` / `prepack` / `publish` —— 而且还得 `main` 指向的文件不存在。

> **`prepublishOnly` 不在这个名单里。** 我们原来只有它（给 `npm publish` 用），所以 pnpm 直接认定"没有构建脚本"。

就算写了 `prepare` 也未必顺：pnpm 11 会先问一句"允许这个依赖执行构建脚本吗"，不给授权就抛
`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，要往 `pnpm-workspace.yaml` 加 `allowBuilds`。
而这个 key 对 git 依赖是 **lockfile 里 depPath 去掉 `#sha` 的那段**，实测本机是：

```yaml
dsh-stm32@git+ssh://git@github.com/JingYu-er/dsh-stm32.git#28a8901cb5a7...:
```

即用户得手写 `git+ssh://git@github.com/JingYu-er/dsh-stm32.git: true`。specifier 明明写的是 `github:...`，
pnpm 却归一化成 ssh 形式 —— 换台机器、换传输方式（https / ssh）这个 key 就可能变，写进文档是给自己埋雷。

### 3. 别人的做法：把 `lib/` 提交进仓库

拉了参考插件 `2768651338/dsh-plugin-manager`（codeload tarball，635 KB）看包结构：

- `package.json` 的 scripts 只有 `build` / `typecheck` / `lint` / `test`，**没有 `prepare`、没有 `prepublish`**；
- `.gitignore` 只忽略 `lib/types/`、`*.map`、`*.tsbuildinfo` —— **`lib/` 本身是入库的**；
- `files` 明写 `lib/index.js`、`lib/client.js`、`lib/typert.host.js`。

所以"一条命令装"的真相是：**它不需要构建，因为产物就在仓库里**。pnpm 只是把仓库内容按 `files` 拷进 profile。

### 4. 我们的改法

- `.gitignore` 去掉 `lib/`（保留 `*.tsbuildinfo`）；
- `package.json` 去掉 `prepare`（保留 `prepublishOnly`，`npm publish` 前仍会重建）；
- `lib/` 共 35 个 `.js`、约 300 KB。tsconfig 里 `declaration: false`、`sourceMap: false`，产物很干净，没有 `.map` / `.d.ts` 噪音。

代价是一条纪律：**改完 `src/` 必须 `npm run build` 再提交**，否则别人（和 `github:` 安装路径）拿到的是旧代码。
CI 里 `npm ci → npm run build → 检查 lib/ 与 src/ 同步 → npm test` 把"忘了重建"也拦住了：
`git status --porcelain -- lib` 非空就 `throw`，不用再靠 reviewer 肉眼比对 `src/` 与 `lib/`。

教训：**给 dsh 写插件，分发面和构建面要一起设计。** gitignore 掉构建产物，就等于放弃了 `github:` 安装路径，
只能要求用户 clone + build + `link:`（或者等 npm 发布）。这不只是文档问题。

## 搜索路径：自动发现（A/B/C）与两个测试陷阱

### 1. 为什么改

用户的原话是「换台机器就找不到工具了」：`DEFAULT_BIN_DIRS` 里硬编码了 `D:/app/msys64/ucrt64/bin`，
`DEFAULT_CUBEMX_ROOTS` 硬编码了 `D:/app/STM32CubeMX`；别的机器路径不同就只能自己去设环境变量，
而且缺件时的报错只说「找不到 openocd」，不告诉你**查过哪些目录**。三项改动：

- **A 报错可诊断**：`src/engine/flash.ts` / `generate.ts` / `doctor.ts` 的缺件消息统一带 `describeSearchScope(...)`；
  doctor 的每条 blocker 附带该组件的 `hint`，notes 里给「工具搜索范围」「CubeMX 搜索范围」「自动发现（已追加到候选尾部）」。
- **B 自动发现**：`src/data/search-roots.ts` 新增 `discoverBinDirs` / `discoverCubeMxRoots` / `discoverInstalls`（进程内缓存、
  扫一次约 1 s），`resolveSearchConfig(env, overrides, discoveredOverride?)` 把发现项追加在候选尾部。
- **C 路径净化**：`normalizePathEntry`（剥引号、反斜杠转正斜杠、折叠重复斜杠、去尾斜杠但保留盘根）、`dedupePaths`（大小写不敏感），
  `splitList` 也走同一套净化——`setx "D:\app\msys64\ucrt64\bin"` 带进来的引号不会再变成目录名的一部分。

顺序契约：**显式参数 > 环境变量（整份替换）> 默认常量**，自动发现只追加在「没给显式参数」的那一档尾部。

### 2. 坑一：自动发现别往「显式参数」上追加

第一版按「永远追加」实现，`npm test` 立刻掉 2 条（`schema-guard.mjs` pass=14 fail=2）：

- `stm32_debug_session 找不到 openocd 时符合 output schema`：测试用 `binDirs: ["D:/__nope__"]` 假装没装工具，
  但自动发现把真机上的 `D:/app/msys64/ucrt64/bin` 追了进来 → 找到 openocd → 真去 spawn，
  报 `TypeError: Cannot read properties of undefined (reading 'spawn')`（该测试的假 subprocess 故意没实现 spawn）。
- `stm32_env_probe 输出符合 output schema`：同样点名的 `cubeMxRoots` 被追加了真机 CubeMX，
  `cubemx found=true` 但假 subprocess 给的是 gcc 版本串 → `found=true 时应有版本号` 断言失败。

教训：**默认值 + 发现 = 便利；显式参数 + 发现 = 坑。** 参数是调用方在说「就用这个」，再混进别处的同名工具，
「我明明指定了」就成了假的。现在是「哪一档点名就哪一档不追加」——环境变量仍会追加发现项（用户多半只是补齐，不是排他）。

### 3. 坑二：`execFileSync` 默认继承 stderr，注册表查询的噪音直接糊进测试输出

`readRegistryInstallDirs` 用 `execFileSync("reg.exe", ["query", key, "/v", value], {...})` 查 `InstallDir` / `InstallLocation`。
键不存在是最常见的情况（本机就没装注册表项），`reg.exe` 会往 **stderr** 写一行「错误: 系统找不到指定的注册表项或值。」；
`execFileSync` 不给 `stdio` 时 stderr 是**继承**的，于是 `npm test` 结尾糊了 10 行 GBK 乱码，
既像测试失败又干扰套件计数解析。

修法两处：

- 探针里显式 `stdio: ["ignore", "pipe", "pipe"]`（stdout 要解析，stderr 要吞掉）；
- `test/run-units.mjs` 跑各套件的 `execFileSync` 也改成 `stdio: ["ignore", "pipe", "pipe"]`，
  子进程噪音不再直通终端——套件自身打印的失败原因还在它的 stdout 里。

### 4. 本机实测

```text
discover 耗时=969ms  disabled=false
discovered.binDirs=["D:/app/msys64/ucrt64/bin"]
discovered.cubeMxRoots=["D:/app/STM32CubeMX"]
cfg.binDirs=["D:/app/msys64/ucrt64/bin","C:/msys64/ucrt64/bin","C:/msys64/mingw64/bin"]   # 发现项与默认值重复 → 去重后不变
scope(bin)=D:/app/msys64/ucrt64/bin、C:/msys64/ucrt64/bin、C:/msys64/mingw64/bin，以及 PATH
env.binDirs=["D:/app/msys64/ucrt64/bin","E:/x/y"]   # 输入是 ' "D:\\app\\msys64\\ucrt64\\bin" ;; E:/x//y/ '
```

`STM32_NO_DISCOVER=1` 关掉发现（CI / 只想用内置列表）；`resetDiscoveryCache()` 给单测用。

### 5. 测试计数

新增 `test/search-roots-units.test.mjs`（9 条：净化 / splitList / dedupe / looksLike* / 两种发现 / 优先级与追加 / 开关 / 缓存）。
套件 10 → 11，用例 80 → **89 pass / 0 fail**；CI 上是 **87 pass + 2 skipped**（脚手架那两条依赖真固件包）。

## 环境体检要“教人装东西”：env_probe 的引导面（M6 补）

用户的要求很直接：`stm32_env_probe` 是“用插件的第一步”，那它不能只说“缺 openocd”，
得说清**缺了影响什么、推荐怎么装、装完怎么验、要不要我代劳**，并且把“CubeMX 是可选的”讲明白。

### 1. 数据形状（`src/engine/probe.ts`）

`ProbeTarget` / `ProbeResult` 在原来的 `hint` 之外各加三个字段：

| 字段 | 作用 |
| --- | --- |
| `impact` | 缺了影响哪些功能，写清“能干什么、干不了什么”（例如 gdb 缺 → 只影响调试，纯烧录只要 openocd） |
| `install` | 推荐安装步骤数组，**第一条是最省事的那条**，含可直接粘贴的命令 |
| `verify` | 装完的自检命令 |

`src/tools/env-probe.ts` 顶层再加三项：

- `capabilities`：`build`（gcc∧cmake∧ninja）、`flash`（openocd）、`debug`（openocd∧gdb）、`generate`（cubemx∧cubemx-java）；
- `recommendations`：缺必需项时按 `install[0]` 列安装顺序，最后一条主动问「需要我帮你装吗？」；CubeMX 缺失时补一条“CubeMX 是可选的：不影响编译/烧录/调试/改 USER CODE，只影响建工程与重新生成”；装了 CubeMX 但没有内置 JRE 时提示“安装不完整，用官网包重装”；
- `searched`：`describeSearchScope` 出的两条范围（工具链 / CubeMX），缺件时不用再猜路径。

`render` 把 `impact / install / verify / 搜索范围 / 下一步` 都渲染出来，人在终端里看到的就是一份安装清单。

### 2. 实测过的安装事实（别再猜包名）

MSYS2 UCRT64（`D:/app/msys64/usr/bin/pacman.exe -Ss`）：`mingw-w64-ucrt-x86_64-arm-none-eabi-gcc` 13.3.0、
`mingw-w64-ucrt-x86_64-gdb-multiarch` 16.2、`mingw-w64-ucrt-x86_64-openocd` 0.12.0、
`mingw-w64-ucrt-x86_64-cmake` 3.31.5、`mingw-w64-ucrt-x86_64-ninja` 1.12.1。
**UCRT64 仓库里没有 `arm-none-eabi-gdb` 这个包**（旧提示写错的那个），要找 arm 版 gdb 只能用 ARM 官方工具链。

winget（`winget search`）：`Kitware.CMake`、`Ninja-build.Ninja`、`Arm.ArmGnuToolchain`（自带 gcc/gdb）、
`xpack-dev-tools.openocd-xpack`。**STM32CubeMX 不在 winget 里**，只能官网下载
（https://www.st.com/en/development-tools/stm32cubemx.html ），装到默认目录会被自动发现。

### 3. 一个坑：改 ProbeResult 必须同步 doctor 的 schema

`src/tools/doctor.ts` 里的 `toolSchema` 是 env_probe 探测项的复制，且两者都 `additionalProperties: false`。
给 `ProbeResult` 加字段而漏改 doctor 的话，`stm32_doctor` 的 `tools` 数组会被宿主的输出校验拒收——
表现是工具“成功执行但结果不合法”。两处 schema 与 `src/engine/probe.ts` 的 interface 必须一起改。

### 4. 真机冒烟

`node test/smoke-env-probe.mjs`（本机）：summary = `工具链就绪：7/7 项可用，可以编译/烧录/调试`，
capabilities = `{"build":true,"flash":true,"debug":true,"generate":true}`，searched 两条，
recommendations = 「必需组件齐全：可以编译、可以只烧录、可以烧录并调试。」

### 5. 测试计数

`schema-guard` 16 → **17**：原有用例补了 `impact/install/verify`、`capabilities`、`recommendations`、`searched` 断言；
新增一条“resolveExecutable 一律抛错”的全缺分支，断言 `missingRequired` 五项、能力全 false、建议里出现
`pacman.exe -S` 与「需要我帮你装吗」。套件 11 个，用例 89 → **90 pass / 0 fail**。

## generate 为什么慢：把它测成一条时间线，然后缓存 + 按需停放第三方包索引

用户的诉求（原话）：「a直接执行，b如果不使用x-cube扩展包就不加载thirdparties/pdsc，使用的时候再加载」——
(a) 生成没变化就别重跑，(b) 只在真的用到 X-CUBE 扩展包时才让 CubeMX 去挂那套 PDSC 索引。

### 1. 先量化：一次生成到底花在哪

同一工程（`_timing_m7/blink`，F103C8T6 + HSE 8 MHz + 1 GPIO）连跑四次完整生成，
墙钟 **216.8 → 170.6 → 155.6 → 130.3 s**（第一次含冷启动与 Windows 文件缓存预热）。
只把 JVM 拉起来、等 `Code succesfully generated` 之外什么都不干，约 **26 s**——所以"启动 26 s + 剩下全是配置解析"。

从 CubeMX 自己的 `*.log` 时间戳拆出来（单位 s，相对进程启动）：

| 时间窗 | 阶段 | 说明 |
| --- | --- | --- |
| 0–12 | JVM 启动 + 18 个 GUI 插件 | 无头模式也照装不误 |
| 13–16 | 扫 60+ 个 `*.IP` jar | 枚举可用 IP |
| 16–28 | 扫 `thirdparties/pdsc` 下 **159 个 PDSC** | 就是用户说的那套扩展包索引 |
| 21–31 | 联网：HomeAdPanel、URL 文件、md5 清单 | 断网时会等超时，更慢 |
| 32 | UserAuth + JxBrowser 初始化 | 无头也初始化 |
| 34.8–90.8 | `LoadConfig` | **56 s**，一次性解析 MxCube 的 XML 配置 |
| 91.6–121.5 | change project 后**再次**枚举 | **≈30 s**，同一批 IP/PDSC 被扫第二遍 |
| 121.5–160.3 | 真正生成 6 个文件 | **≈39 s** |
| 160–170 | 退出 | 关 JxBrowser、刷日志 |

两个结论直接决定了改法：

1. **pdsc 那 159 个文件被扫了两遍**（16–28 s、91.6–121.5 s 里各一次）。把 `pdsc` 临时改名停放后
   整跑降到 **130.3 s**，即省 **≈25 s**。停放不影响产物：同一工程在"停放"与"已还原"两种状态下生成的
   6 个文件整树 sha256 都是 `a78a451dff0ab876d4abf09cd4c8e86791d648f6e509901f31219e379b8f5d99`。
2. **剩下的 100+ s 全在重复干同一件事**。工程没变就没有理由再跑一遍——这就是 (a)。

顺手证伪了一个想法：**不能用 mtime 判断是否需要重新生成**。CubeMX 对内容相同的文件并不重写，
只打一行 `oldGeneratedFile`，mtime 不动；反过来一次异常慢跑（508 s）里文件也没更新。
要判断"变了没有"只能比内容 hash。

### 2. (a) 缓存跳过：`src/engine/generate-cache.ts`

缓存文件 `.dsh-stm32/generate-cache.json`（`CACHE_VERSION=1`），一条 entry = 键 + 每个产物的 sha256。

缓存键 = `.ioc` 正文 sha256 + **CubeMX 指纹** + 布局版本：

- CubeMX 指纹取 `STM32CubeMX.exe` 旁 `jre` 的 `size:mtime`（`cubeMxStamp`）——
  jar 里没有稳定可解析的版本号入口，升级/换装时 size 与 mtime 必有一个变。
- 布局版本是落位规则的常量（`layout`），改落位逻辑就自动失效。

命中判定 `cacheHit()` 做三重校验，任何一环不满足都退回真跑，并把原因通过 progress 打出来：

| 校验 | 不满足时的 reason |
| --- | --- |
| 键一致 | `.ioc 内容、CubeMX 版本或布局变过（缓存键不一致）` |
| 产物都还在 | `缓存里的产物不见了：<target>` |
| 每个产物 hash 与缓存一致 | `产物与缓存不一致（被改过）：<target>` |

命中即直接返回 ok 报告：`skipped: true`、`durationMs ≈ 0`、
`successLine = "（跳过 CubeMX：复用上次生成结果）"`、`files` 全是 `unchanged-cached`，
notes 提示逃生口（`skipIfUnchanged=false`，或删掉缓存文件）。
只有确认要真跑时才 `acquireLock`（不白占探针/锁），成功后才写缓存，写缓存失败只加一条 note、不影响生成结果。

### 3. (b) pdsc 按需停放：`src/engine/thirdparty.ts`

`needsThirdpartyPacks(iocText)` 判断这份 `.ioc` 是否真的用扩展包：

| 条件 | 判定 |
| --- | --- |
| `Mcu.ThirdPartyNb > 0` | 需要 |
| `Mcu.ThirdPartyNb < 0` | 当 0 处理 |
| **`Mcu.ThirdPartyNb` 键缺失** | 保守判"需要"（reason 写明"保守保留"） |
| 正文出现 `X-CUBE` / `I-CUBE` / `STM32CubeExpansion` / `FP-SNS` / `FP-ATR` / `FP-AI` / `FP-LOOP` / `*ThirdParty*=` | 需要 |
| `Mcu.ThirdPartyNb = 0` 且无上述标记 | 不需要 → 停放 |

> 注：这张表是 M7 当时的判定。M8 之后「正文出现标记」这一行已被**包目录实名匹配**取代
> （`Mcu.ThirdParty0=STMicroelectronics.X-CUBE-ALGOBUILD.1.4.0` 直接对快照），见下文
> 「X-CUBE 判定从「关键词猜」改成「实名查目录」」。

不需要时把 `~/.stm32cubemx/thirdparties/pdsc` 改名成 `pdsc.dsh-parked`（同盘 rename，瞬时），
`runStreaming` 的 `finally` 里无论成功失败都 `restore()`。

还原这里有个坑：**CubeMX 运行时发现没有 pdsc 目录会自己建一个空的**。所以 `restore()` 不能直接
rename 回去，要先 `rmdir` 那个空目录；如果它非空（真被写了东西），就两份都保留并给备注
「CubeMX 运行中重新生成了 …（非空），原索引仍在 …，请手动合并或删除其一」，绝不静默丢数据。

用户家目录用 `cubeMxUserHome(env)` 推：`STM32CUBEMX_HOME` 优先，否则 `USERPROFILE`/`HOME` + `/.stm32cubemx`
（统一转成 `/`）；都拿不到就跳过停放、只记 detail。
`thirdpartyPacks: "keep"` 可强制保留索引（例如正在 CubeMX GUI 里手工选扩展包）。

### 4. 真机验证（`_gen_probe/verify-cache.mjs`，直接 import 构建产物 `lib/engine/generate.js`）

| | run1（真跑） | run2（命中缓存） |
| --- | --- | --- |
| 墙钟 | **175,120 ms** | **688 ms**（自报 11 ms） |
| `skipped` | false | **true** |
| 产物 | 6 个 `overwritten`，保活 USER CODE 标签 11 个（`main.c`：Header/WHILE/3/Error_Handler_Debug/6） | 6 个 `unchanged-cached` |
| thirdparty | `parked: true` | `未探测（本次跳过 CubeMX）` |
| pdsc 状态 | 跑前 159 文件 / 跑后 **159 文件，`parked=false`** | 仍 159 / false |

即：**首次 3 分钟左右，之后只要 `.ioc`、CubeMX 版本、产物都没动，重新生成 ≈0.7 s。**

### 5. 测试计数

新增 `test/generate-cache-units.test.mjs`（8 条：sha256/键稳定性/CubeMX 指纹/读写/三重校验各自的失败 reason/entryFromFiles）
与 `test/thirdparty-units.test.mjs`（11 条：ThirdPartyNb 三分支/键缺失保守/七类标记/家目录推导/停放与还原/非空冲突保留）。
套件 11 → 13，用例 90 → **109 pass / 0 fail**；两套件插在 `flash-units.test.mjs` 与 `session-units.test.mjs` 之后。



## X-CUBE 判定从「关键词猜」改成「实名查目录」（M8 补）

### 1. 为什么要改

原来 `needsThirdpartyPacks` 靠 `X-CUBE` / `I-CUBE` 之类的模糊标记判断要不要加载 `thirdparties/pdsc`，
两类误判都会咬人：

- **真用了包却没写标记** → 索引被停放，生成时报缺包；
- **工程名里带 `X-CUBE-xxx`**（例如 `ProjectManager.ProjectName=X-CUBE-AI-demo`）→ 白加载 25 s 的索引。

用户的原话是「我觉得应该把 x-cube 里的目录列表先提前存到程序中，工程真的要用 X-CUBE 扩展包时检索一下就知道是否要 thirdparties/pdsc 了」——
即：判定不该猜，该拿**包名**去对**目录**。

### 2. 目录快照从哪来

本机 `~/.stm32cubemx/thirdparties/pdsc` 下有 **159 个 `.pdsc`**（11.6 MB），文件名形如
`<vendor>.<pack>[.<version>].pdsc`，例如 `STMicroelectronics.X-CUBE-ALGOBUILD.1.4.0.pdsc`、
`wolfSSL.I-CUBE-wolfMQTT.pdsc`。去掉版本、大小写不敏感合并后是 **67 个包**（`X-CUBE-DPower` 无版本的那条
与 `X-CUBE-DPOWER.1.3.0` 合并成一条）。

快照由 `scripts/gen-xcube-catalog.mjs` 生成成源码，跟着插件一起发布：

```powershell
# 默认：读 <STM32CUBEMX_HOME 或 %USERPROFILE%/.stm32cubemx>/thirdparties/pdsc，写 src/engine/xcube-catalog.ts
node scripts/gen-xcube-catalog.mjs
node scripts/gen-xcube-catalog.mjs D:/some/pdsc src/engine/xcube-catalog.ts   # 也可以显式给目录
```

生成物 `src/engine/xcube-catalog.ts` **不要手改**：里面是 `XCUBE_PACK_CATALOG`（67 条 `{vendor,name,versions}`）、
`XCUBE_CATALOG_FILE_COUNT`、`XCUBE_CATALOG_SOURCE`、`XCUBE_CATALOG_GENERATED_AT`。
在 CubeMX 里装了新扩展包之后目录会旧，重跑一次脚本即可（旧的目录仍然可用，只是不认识新包）。

踩过的坑：版本号必须从结尾**连续**剥纯数字段。只剥最后一段会把 `X-CUBE-ALGOBUILD.1.4.0` 拆成
`name = X-CUBE-ALGOBUILD.1.4` + `version = 0`，条目数变成 154（错的）；修好后 67 条。

### 3. `.ioc` 里包的身份

真实样本 `8110_foc.ioc`（497 行，见 `.ioc` 里能查到这几行）：

| 行 | 内容 |
| --- | --- |
| 206 | `Mcu.Pin35=VP_STMicroelectronics.X-CUBE-ALGOBUILD_VS_DSPOoLibraryJjLibrary_1.4.0_1.4.0` |
| 214 | `Mcu.ThirdParty0=STMicroelectronics.X-CUBE-ALGOBUILD.1.4.0` |
| 215 | `Mcu.ThirdPartyNb=1` |
| 436-438 | `STMicroelectronics.X-CUBE-ALGOBUILD.1.4.0.<key>=…` |
| 482 | `VP_STMicroelectronics.X-CUBE-ALGOBUILD_VS_DSPOoLibraryJjLibrary_1.4.0_1.4.0.Mode=…` |

⇒ 包身份就是 `<vendor>.<pack>.<version>`，与 `.pdsc` 文件名同构，所以「目录 ↔ `.ioc`」可以直接对名字。
本机其它 `.ioc`（`demo`、`_timing_m7`、ODrive 等）只有 `Mcu.ThirdPartyNb=0`，没有任何第三方包。

### 4. 判定规则（现行，覆盖第 3 节那张表里的「标记」行）

`scanIocPacks()` 先扫出包引用，`needsThirdpartyPacks()` 再按顺序下结论：

| 依据 | 结论 |
| --- | --- |
| `Mcu.ThirdPartyNb > 0` | 需要，reason 列出包名与本机安装情况 |
| `.ioc` 引用了目录里的包（`Mcu.ThirdParty<k>` 或任意行里的 `vendor.name`） | 需要；若同时 `Nb=0`，reason 注明「两处对不上，保守保留索引」 |
| 只命中裸包名（凑不出 vendor，例如 `ProjectManager.ProjectName=X-CUBE-AI-demo`） | 需要（保守），整行进 `markers` 当证据 |
| `Mcu.ThirdParty<k>` 行解析不了（含空值 `Mcu.ThirdParty0=`） | 需要（保守），进 `malformed` |
| `Mcu.ThirdPartyNb = 0` 且无以上证据 | **不需要 → 停放** |
| 没有 `Mcu.ThirdPartyNb` 且无证据 | 需要（保守） |

安装状态 `installed`：`exact`（本机就有这个版本）/ `other-version`（本机只有别的版本）/ `missing`（本机没有）/
`unknown`（调用方没给本机索引，不做存在性判断）。

给 `needsThirdpartyPacks(ioc, { pdscDir })` 传本机索引目录时，还会产出 `warnings`：

| 情况 | warning |
| --- | --- |
| `missing` | `工程要用 …，但本机第三方包索引里没有这个包（先在 CubeMX 的 Manage embedded software packages 里装上它，否则生成会报缺包）：<pdscDir>` |
| `other-version` | `工程要用 …，本机索引里只有 1.5.0（CubeMX 会按可用版本处理，必要时在它里面 Migrate）` |
| 索引目录读不到 | `读不到本机第三方包索引目录（<pdscDir>），没法判断工程要的包在不在本机` |

`src/engine/generate.ts` 把 `warnings` 直接并进报告 `notes`，所以**缺包在生成前就能看到**，不用等 CubeMX 报错。

### 5. 测试

新增 `test/xcube-units.test.mjs`（14 条）：目录快照自检（≥60 条、含 `X-CUBE-ALGOBUILD` 1.4.0、无大小写重复、版本号形如数字点号）、
两处解析器（生成脚本 `parsePdscFileNames` 与运行时 `parsePdscNames`）对同一 fixture 输出一致、
`identifyPackId` 四类情形（目录命中带/不带版本、目录外的包通用拆法、认不出来返回 null）、
用 `8110_foc.ioc` 真实片段跑 `scanIocPacks`（`nb=1`、版本由 `Mcu.ThirdParty0` 补全）、
`installed` 三态、`markers` 与 `malformed`、`listInstalledPacks`、`summarizePacks`、
带 `pdscDir` 的三类 warning、纯 HAL 工程（`Nb=0`）不告警。

套件 13 → 14，用例 109 → **123 pass / 0 fail**。

### 6. 教训

- 快照是「这台机器上装了什么」的静态镜像；版本更新靠重跑脚本，不靠写更聪明的正则。宁可旧，也不猜。
- 生成脚本与运行时各有一份解析器，必须有测试对齐，否则快照和判定会慢慢漂。
- 空值行也算 malformed：`Mcu.ThirdParty0=` 什么都不写，比写错更常见。
- 保守的方向只有一个：**判不准就加载索引**。多花 25 s 可以接受，漏包生成错代码不行。

### 7. 真机验证（`_gen_probe/verify-thirdparty.mjs`，`skipIfUnchanged: false` 强制真跑）

| 项 | 结果 |
| --- | --- |
| 工程 | `D:/JingYu/Desktop/c8t6_vscode_test/_timing_m7/blink`（`Mcu.ThirdPartyNb=0`） |
| 墙钟 / 自报 | 117,397 ms / 116,405 ms（ok=true，`skipped=false`） |
| `thirdparty` | `parked: true`，detail = `已临时停放第三方包索引（…\pdsc.dsh-parked），生成结束后自动还原；判定依据：工程没有第三方包（Mcu.ThirdPartyNb=0），本次生成不需要包索引` |
| pdsc 状态 | 跑前 159 文件 / `parked=false` → 跑后 **159 文件 / `parked=false`**（自动还原） |

同一份代码对真实 `.ioc` 的判定（`needsThirdpartyPacks` 直接调用）：

| `.ioc` | 结论 |
| --- | --- |
| `8110_foc.ioc`（G431 FOC 工程） | needed=true，`工程声明了 1 个第三方包（STMicroelectronics.X-CUBE-ALGOBUILD 1.4.0）`，本机 `exact`（装了 1.4.0 / 1.5.0），无 warning，证据行 `Mcu.ThirdPartyNb=1`、`Mcu.ThirdParty0=STMicroelectronics.X-CUBE-ALGOBUILD.1.4.0` |
| `demo.ioc`（本机 C8T6 工程） | needed=false，`工程没有第三方包（Mcu.ThirdPartyNb=0），本次生成不需要包索引`，无包无 warning |

本机 pdsc 目录 159 个文件 → `listInstalledPacks()` 解析出 **67 个包**，与快照条数一致。

## 调试会话活着时读寄存器：复用它的 openocd（洞 D）

### 1. 现象

`stm32_debug_session`（`reset: "halt"`）开着的时候调 `stm32_regs_read`，两个采样全部 `ok: false`：

```text
读寄存器失败：Error: CMSIS-DAP transfer count mismatch: expected 3, got 2
```

同一批地址在**没有会话**时是好的（`0x4001100C = 0x00000000`、`0x40010004 = 0x02000000`、`pc = 0x08000248`）。也就是说不是地址写错、也不是探针坏了，是「谁先占着探针」的问题。

### 2. 根因

两条路各自起一个 openocd：

- `stm32_debug_session` → `DebugSessionManager.start()`，openocd 监听 `127.0.0.1:3333`，gdb 通过 `target extended-remote` 连它。
- `stm32_regs_read` → `runRegsRead()`，**又**起一个 openocd（同一份 `configFiles`、同样绑定 3333），脚本里 `init → halt → mdw <addr> → resume → shutdown`。

CMSIS-DAP 探针同一时刻只允许一个调试会话，第二个 openocd 抢到的是「半个探针」：它自己的 transfer 队列和第一个会话交错，于是 `expected 3, got 2` 这种计数错。修 `regs_read` 的脚本写法没用——错在两个 openocd 同时在跑。

### 3. 修法：会话活着就借它的 gdb

`src/engine/debug-session.ts` 新增 `readWords({ addresses, timeoutMs?, signal? })`：

- 没有会话 → 立刻返回 `ok: false`，`errors: ["没有调试会话（先 stm32_debug_session，或短任务用 stm32_debug_run）"]`，不假装读过。
- 有会话 → `commands = ["print/x $pc", "print/x *(unsigned int *)0x…", …]` 交给已有的 `eval()`。`eval` 自己会 `monitor halt` → 逐条执行 → `monitor resume` → `detach`，所以读值不动固件状态，也不额外占探针。
- 解析：`parseGdbPrintedHex()` 用 `/\$\d+\s*=\s*(0x[0-9a-fA-F]+)/gu` 按出现顺序取值，第 0 个是 pc；缺值只把那一条标 `ok: false` 并在 `errors` 里说「有 N 个地址没读到值（地址没映射或没对齐）」。
- 地址规整：`normalizeHexAddress()` 剥 `0x`、限 1–8 位十六进制、统一成 8 位小写（`0x0000024c`），避免 `0X4001100C` 这种写法进 gdb 表达式。

工具层 `src/tools/regs.ts` 只做一个分支：

```ts
if (debugSessions.isActive()) {
  const words = await debugSessions.readWords({ addresses, timeoutMs, signal });
  // 组装成同一个 RegsReport：configFile / script 留空，logTail = 输出末 12 行
  notes.unshift("复用调试会话（端口 N）的 openocd，没有另起一个");
} else {
  runRegsRead(...);   // 原路径，一点没改
}
```

报告形状对调用方不变（还是 `RegsReport`），但 `report.command` 变成那条 gdb 命令行，`logTail` 里能看到 `$1 = 0x8001178` 这样的原始输出，出事时能对着看。

### 4. 真机验证

会话活着时，仓库里的探针脚本（`_probe/probe-holes.mjs`，验证完已删）直接 import `lib/engine/debug-session.js`：

| 项 | 结果 |
| --- | --- |
| `debugSessions.start({ projectDir, reset: "halt" })` | ok，`port=3333` |
| `readWords(["0x4001100C","0x40010004"])` | ok=true，`pc=0x8001178`，两值 `0x0` / `0x0` |
| 走工具层（省略 `projectDir`，靠会话工作目录） | ok=true，notes = `["复用调试会话（端口 3333）的 openocd，没有另起一个","工程目录缺省取会话工作目录：D:/…/demo"]` |

重启 dsh 后在真宿主里再打一遍（`stm32_debug_session` → `stm32_regs_read` → `stm32_debug_stop`）：

| 字段 | 值 |
| --- | --- |
| `message` | 从调试会话（端口 3333）读了 2 个值 |
| `report.ok` / `durationMs` | `true` / 2124 |
| `report.command` | `gdb-multiarch … -ex "target extended-remote 127.0.0.1:3333" -ex "monitor halt" -ex "print/x $pc" -ex "print/x *(unsigned int *)0x4001100c" -ex "print/x *(unsigned int *)0x40010004" -ex "monitor resume" -ex detach` |
| `report.pc` | `0x8001178`（会话停在 `Reset_Handler`） |
| `report.samples` | `0x4001100c=0x0`、`0x40010004=0x0`，都 `ok: true` |
| `report.logTail` | 含 `$1 = 0x8001178` / `$2 = 0x0` / `$3 = 0x0` 与 `[Inferior 1 (Remote target) detached]` |

对照：同一地址在**无会话**时走 `runRegsRead` 仍然成功（`0x4001100C = 0x00002000`，那是固件跑到 `while` 之后的值），说明两条路都还在，只是不再同时跑。

### 5. 教训

- 一个探针上只能有一个 openocd。凡是「自己起 openocd 读点东西」的工具，都得先问一句会话是不是活着。
- 复用会话比新起进程简单得多：gdb 已经连着，`print/x *(unsigned int *)0x…` 一句就够，不用再写 openocd 脚本、不用管 `shutdown`。
- 会话活着时读值会**暂停再恢复**（`monitor halt` / `monitor resume`），停在断点时读寄存器不会让程序多跑一步——这正是想要的语义，但要写进 notes 里让人知道。
- 错误要能自己承认：没有会话时返回可读错误，比抛 gdb 的 `transfer count mismatch` 好定位。

### 6. 测试计数

套件 14 → 15，用例 123 → **137 pass / 0 fail**。新增的 `test/tool-contract-units.test.mjs`（14 例）覆盖 `normalizeHexAddress`、`parseGdbPrintedHex`、无会话时 `readWords` 的可读错误，以及工具层省略 `projectDir` 时确实取会话工作目录。

## 缺包警告的真机验证：失败报告也必须带 notes

### 1. 目的

`needsThirdpartyPacks()` 产出的 `warnings` 此前只有单测覆盖，没在真 CubeMX 上验过。本机 C8T6 工程全是 `Mcu.ThirdPartyNb=0`，所以要造一个「声明了包、但本机缺包或缺版本」的工程真跑一遍。

### 2. 选包：ALGOBUILD 为什么在 F103C8T6 上能用

159 个 pdsc 里 **0 个**出现 `STM32F103` / `STM32F1xx` 字样——pdsc 不按型号写死，靠条件匹配。`STMicroelectronics.X-CUBE-ALGOBUILD.pdsc` 的兼容条件写的是内核：

```xml
<condition id="Cortex-M Device"><accept Dcore="Cortex-M3"/> …</condition>
```

F103C8T6 正是 Cortex-M3，所以它在 F1 工程里「能用」；本机装了 1.4.0 / 1.5.0，正好可以构造「版本不存在」。

### 3. 造测试工程

- `D:/JingYu/Desktop/c8t6_vscode_test/_xcube_probe` = demo 的完整拷贝（3055 文件，排除 `build`、`_probe`、`dsh-stm32`、`.git`、`.dsh-stm32`）。不能拷到 demo 的子目录里，Node 会报 `ERR_FS_CP_EINVAL: cp returned EINVAL (cannot copy … to a subdirectory of self …)`。
- 往 `_xcube_probe/demo.ioc` 写入两条假引用（其余行不动）：

```ini
Mcu.ThirdPartyNb=2
Mcu.ThirdParty0=STMicroelectronics.X-CUBE-ALGOBUILD.9.9.9
Mcu.ThirdParty1=STMicroelectronics.X-CUBE-F103DEMO.1.0.0
```

一个「包在、版本不在」，一个「包不在」。

预期（直接调 `lib/engine/thirdparty.js`，`pdscDir=C:/Users/JingYu/.stm32cubemx/thirdparties/pdsc`）：

| 字段 | 值 |
| --- | --- |
| `needed` | `true` |
| `reason` | `工程声明了 2 个第三方包（STMicroelectronics.X-CUBE-ALGOBUILD 9.9.9、STMicroelectronics.X-CUBE-F103DEMO 1.0.0）` |
| `warnings[0]` | `工程要用 STMicroelectronics.X-CUBE-ALGOBUILD 9.9.9，本机索引里只有 1.4.0、1.5.0（CubeMX 会按可用版本处理，必要时在它里面 Migrate）` |
| `warnings[1]` | `工程要用 STMicroelectronics.X-CUBE-F103DEMO 1.0.0，但本机第三方包索引里没有这个包（先在 CubeMX 的 Manage embedded software packages 里装上它，否则生成会报缺包）：C:/Users/JingYu/.stm32cubemx/thirdparties/pdsc` |

### 4. 第一次跑：`ok=true`，但报告里没有 warning——**探针的错，不是产品的错**

第一次只声明了 ALGOBUILD 9.9.9，真跑 CubeMX 成功（470,354 ms，6 文件落位，保活 12 个 USER CODE 标签），`notes` 里却只有「第三方包索引：保留第三方包索引：工程声明了 1 个第三方包（…9.9.9）」，没有版本不符的警告。

原因在探针：脚本由 `run_code` 起，子进程 `process.env` 是空的 → `cubeMxUserHome(process.env)` 返回 `null` → `pdscDir` 为 `undefined` → 只判「要不要索引」，不去比对本机装了哪些包。

```
home({})                                  = null
home({ USERPROFILE: "C:/Users/JingYu" })  = C:/Users/JingYu/.stm32cubemx
```

宿主进程有 `USERPROFILE`，所以产品侧没问题；但**任何脱离 DSH 宿主跑的探针都必须自己补 env**，否则测的是「没装 CubeMX 的机器」那条分支。

### 5. 顺带发现的真缺陷：失败报告把 notes 写死成空数组

`src/engine/generate.ts` 的 `fail()` 默认值是 `notes: []`：

```ts
function fail(request: GenerateRequest, message: string, extra: Partial<GenerateReport> = {}): GenerateReport {
  return { … notes: [], …extra };
}
```

而第三方包的 `warnings` 在 `parkNotes` 里（`src/engine/generate.ts:411` 的 `parkNotes.push(...decision.warnings)`），只在成功分支 `src/engine/generate.ts:516` 的 `notes.push(...parkNotes)` 被并入。

后果很刺眼：**CubeMX 恰恰在最需要那条警告的时候失败**——缺包导致生成报错，而报告里的 notes 是空的，用户看不出缺了什么。

修法（`src/engine/generate.ts`）：

```ts
const failureNotes: string[] = [];
if (thirdparty.detail !== "") failureNotes.push("第三方包索引：" + thirdparty.detail);
failureNotes.push(...parkNotes);
const baseReport = { …, notes: failureNotes, … };
```

四处失败出口（`spawnError` / `aborted` / `timedOut` / `!verdict.ok`）都走 `fail(request, …, baseReport)`，一并继承。

### 6. 第二次跑：失败也把两条警告带出来了

同一工程、`skipIfUnchanged: false`、`thirdpartyPacks: "auto"`、`timeoutMs: 480000`，探针顶部补 `process.env.USERPROFILE = "C:/Users/JingYu"`：

| 项 | 结果 |
| --- | --- |
| 墙钟 | 481,553 ms，`ok=false`，`message = CubeMX 生成超时`（16:24:31 载入工程后再无输出，被 480 s 杀掉） |
| `thirdparty` | `parked: false`，detail = `保留第三方包索引：工程声明了 2 个第三方包（…ALGOBUILD 9.9.9、…X-CUBE-F103DEMO 1.0.0）`（需要包时不停放，符合设计） |
| `notes` | 3 条：第三方包索引那行 + **两条警告原文**（见 §3 表） |
| pdsc | 159 个原位，无 `pdsc.dsh-parked`（不需要停放） |

也就是说：**警告在失败报告里也能看到**，第 5 节的修复生效。CubeMX 自己的日志里也有旁证（`ThirdParty IPModes/IPconfigs doesn't exist for :STMicroelectronics.X-CUBE-ALGOBUILD.9.9.9`），被 `parseGenerateLog` 归入 knownNoise。

### 7. 教训

- 报告的 `notes` 是**给失败看**的，不是给成功看的。任何 `fail()` 都必须带上「为什么会失败」的上下文；把 `notes` 默认写成 `[]` 等于在最需要信息时静音。
- 判定依赖 `process.env` 的代码（`cubeMxUserHome`）在探针里必须显式喂 env，否则测到的是另一条分支，而且「看起来正常」。
- 造「缺包」比造「包都在」便宜：改两行 `.ioc` 就够，不必真装一个 X-CUBE 包。
- 声明了不存在的包时 CubeMX 不是「报错退出」，而是弹出**模态 Warning 等人点 OK**：`The CMSIS-Pack : STMicroelectronics.X-CUBE-ALGOBUILD.9.9.9 is unknown` / `You must Use the Embedded Software Packages Manager to install this CMSIS-pack from your local environment.` / `Now, STM32CubeMX tools continue to load this project without CMSIS-Pack contains.` / `Please,do not save this project to avoid to corrupt it`。`-q` 无头模式没有人能点这个对话框，于是日志停在 `ThirdParty:883 - exiting critical section [close project]`，直到超时被杀——这就是第二次跑 481 s `ok=false` 的全部原因。
- 正因为 CubeMX 在缺包时会弹框卡死，**插件必须提前把这条警告说出来**（§3、§6 的 notes）：用户先看到「本机索引里没有 X-CUBE-F103DEMO」「只有 1.4.0、1.5.0」，就不会白等 8 分钟去撞同一个框。

## L2：用户级工具链配置、开工前门禁与安装器（方案1）

### 1. 目的

三件互相咬合的事，起因都是「换台机器就得从头教一遍」：

| 痛点 | 具体表现 | 这次的做法 |
| --- | --- | --- |
| 工具链位置无处安放 | 只认环境变量与写死的 `DEFAULT_BIN_DIRS`，换台机器把 msys64 装到别处就得设环境变量 | 加用户级配置文件，装在哪写一次、所有工具都认 |
| 缺件时跑一半才炸 | `stm32_build` 会 spawn `cmake`，缺 gcc 时报的是 cmake 的内部错误 | 每个动作工具入口先过门禁，缺件就直接给「缺什么、怎么装」 |
| 装工具链全靠人肉 | 新手不知道要装 5 个包、不知道要进 PATH | `stm32_env_install` 先出计划（不下载），确认后才真装，PATH 只写用户级 |

### 2. 用户级配置（`src/data/toolchain-config.ts`）

配置文件放在 `%USERPROFILE%/.dsh-stm32/config.json`（可用 `DSH_STM32_CONFIG` 指到别处，`DSH_STM32_NO_CONFIG=1` 整体关掉）：

```json
{
  "version": 1,
  "msys64": "D:/app/msys64",
  "binDirs": [],
  "packages": ["mingw-w64-ucrt-x86_64-arm-none-eabi-gcc"],
  "cubeMxRoot": "D:/app/STM32CubeMX",
  "updatedAt": "2026-02-11T12:00:00.000Z"
}
```

几个定死的选择：

- **放 `data` 层，不放 `engine` 层**：`data/search-roots.ts` 的 `resolveSearchConfig()` 要读它，放 engine 会形成 `data → engine` 的循环依赖。分层不是审美，是编译器会真的报错。
- **`binDirs` 留空就由 `msys64` 推导**（`binDirsFromConfig()` 返回 `[msys64 + "/ucrt64/bin"]`）。用户只写一个 msys64 路径就能用，不必知道 ucrt64/clang64 的区别。
- **优先级四层**：显式参数 > `STM32_BIN_DIRS` / `STM32_CUBEMX_ROOT`（整份替换）> 用户配置（整份替换）> `DEFAULT_BIN_DIRS` / `DEFAULT_CUBEMX_ROOTS`。自动发现（扫盘 + 注册表）只在「没给显式参数」那一档追加到尾部，不会盖掉用户写的。
- **坏 JSON 当没配置**：`readToolchainConfig()` 返回 `config: null` + `errors[0] = "配置文件不是合法 JSON：…；已按未配置处理（重新写入会覆盖它）"`。绝不因为一个坏文件让所有工具罢工。
- **原子写**：写 `<path>.tmp-<pid>` 再 `rename`，避免写一半断电留下半截 JSON。
- **读缓存按 `path + mtimeMs + size`**：门禁每次工具调用都要读一次配置，每次 `stat + readFile` 不贵但没必要；写完立刻失效。

### 3. 门禁（`src/engine/toolchain-gate.ts`）

能力 → 必需组件的映射是唯一事实来源：

```ts
export const CAPABILITY_COMPONENTS = {
  build:    ["gcc", "cmake", "ninja"],
  flash:    ["openocd"],
  debug:    ["openocd", "gdb"],
  generate: ["cubemx", "cubemx-java"],
};
```

`ensureToolchain(ctx, { capability, binDirs?, cubeMxRoots?, envCheck?, signal? })` 的判定顺序：

1. **快路径先走文件存在性**（`resolveFromDirs`，只 `existsSync`，**不 spawn**）。门禁挂在每个工具入口上，如果每次都 `--version` 一遍，编译一次就多五个进程、几百毫秒，还会被杀毒软件拖成秒级。
2. 快路径没全命中，才 `probeTarget` 逐个真探测（拿版本号，报告里能显示 `13.3.0` 这种实话），结果按「能力 + binDirs + cubeMxRoots」缓存 **60 s**（`PROBE_CACHE_TTL_MS`）。
3. `envCheck` 三档：`block`（默认，缺件不干活，返回 schema 齐全的失败报告）、`warn`（照干，把警告放报告首行）、`off`（不检查，报告里写「（envCheck=off，没有检查）」）。**默认档是 block**：宁可不动手，也不要给一个「跑到一半才炸」的失败。

blocked 时的 `message` 是一句人话，不是字段堆砌：

```
缺 arm-none-eabi-gcc、CMake、Ninja，这次没有开始编译：arm-none-eabi-gcc 没找到（编译 C 代码用）…。要我装吗？回一句「装」，我先跑 stm32_env_install 出计划（只列大小与步骤、不下载），确认后才真装；想自己装就看下面 missing[0].install 的第一条。
```

`gateReportNotes()` 把它摊成报告 `notes`：首行 message、每个缺件一行「缺 X：hint」+ 一行缩进的「安装：…」、末行 nextStep。**失败报告也必须有 nextStep**——见「缺包警告的真机验证」那节的教训。

### 4. 安装器（`src/engine/msys2-install.ts` + `src/tools/env-install.ts`）

默认 `dryRun` 是 `true`：`stm32_env_install` 被调一次，只出计划（7 步、下载大小、PATH 前后对比），**零下载、零写注册表、零建目录**。真装必须 `dryRun: false` **且** `confirm: true` 两个开关同时在。

计划模式在本机的实测：

| 字段 | 值 |
| --- | --- |
| `report.mode` | `plan` |
| `report.msys64` / `resolvedVia` | `D:/app/msys64` / `discovered`（正确复用已有工具链，不重复装一份 2.5 GB） |
| `report.steps` | 7 步全 `pending` |
| `report.config.written` / `report.path.done` | `false` / `false` |
| 副作用 | 临时目录零新文件、零 `curl`、零 `reg add` |

真装的四个技术决定：

- **下载官方 sfx**：`https://github.com/msys2/msys2-installer/releases/latest/download/msys2-base-x86_64-latest.sfx.exe`（43,060,392 字节）。原本任务书里写的 `msys2-x86_64-latest.sfx.exe` 在 GitHub 上**不存在**，是资产名写错——下载 URL 一定要真访问一次再写进代码。缓存 `<配置目录>/msys2-latest.sfx.exe`，先写 `.part` 再 rename，复用前验 `MZ` 头（`0x4d 0x5a`）。
- **sfx 解出来自带一层 `msys64`**：所以先解到 `<targetParent>/.dsh-msys2-staging`，确认里面有 `usr/bin/bash.exe`，再同盘 rename 到 `targetDir`。`-y -o<dir>` 与 `-y -o"<dir>"` 两种写法都试（7z 自解压对带空格路径的引号处理不一致）。
- **补包用 pacman，不整包重下**：`<msys64>/usr/bin/bash.exe -lc "pacman -Sy --noconfirm && pacman -S --noconfirm --needed <5 包>"`，5 个包是 `mingw-w64-ucrt-x86_64-arm-none-eabi-gcc`、`-gdb-multiarch`、`-openocd`、`-cmake`、`-ninja`。stderr 命中 keyring 或 `invalid or corrupted package` 就先 `pacman-key --init && pacman-key --populate msys2` 再重试一次（新解压的 MSYS2 第一次 `-Sy` 几乎必然撞签名）。pacman 失败不停整体流程：PATH 与配置照写，报告里 `ok` 由「除 path 外有无 failed 步骤」决定。
- **PATH 只写用户级，而且先备份**：`reg query "HKCU\Environment" /v Path` 读出 `REG_EXPAND_SZ`，按 `normalizePathEntry` + 小写比较做幂等，写前备份到 `<配置目录>/path-backup-<ISO>.txt`，**备份失败就不写**。写用 `reg add HKCU\Environment /v Path /t REG_EXPAND_SZ /d <新值> /f`：`setx` 会在 1024 字符处截断，还会把 `%USERPROFILE%` 这类变量展开成死路径。绝不碰 `HKLM`。
- **不做卸载**：删工具链要判断「是不是用户自己的目录」，误删代价远大于留着一份。

### 5. 接入点

七个动作工具 + 一条命令，能力映射：

| 工具 | 能力 | 门禁位置 |
| --- | --- | --- |
| `stm32_build` | build | `src/tools/build.ts:167`（block `:172`） |
| `stm32_flash` | flash | `src/tools/flash.ts:137`（block `:142`） |
| `stm32_debug_run` | debug | `src/tools/debug.ts:177`（block `:182`） |
| `stm32_debug_session` | debug | `src/tools/debug-session.ts:167`（block `:172`） |
| `stm32_regs_read` | debug | `src/tools/regs.ts:149`（block `:154`，在「借活跃会话」分支之前） |
| `stm32_generate` | generate | `src/tools/generate.ts:215`（block `:220`，在 `releaseProbeFor` 之前，不占探针） |
| `stm32_project_create` | generate | `src/tools/project-create.ts:143`（block `:148`） |
| `/stm32-env` | 全部四项 | `src/commands/register.ts:271` |

门禁统一插在「取到 subprocess + 解析工程目录 + 参数校验之后、调用引擎之前」：早退（工程名非法、目录不存在）比门禁更优先，否则用户会收到「缺 gcc」而不是「工程名不对」。`stm32_doctor` 与 `stm32_env_probe` 不接门禁——它们本身就是体检工具。

`/stm32-env` 的真实卡片（本机）：

```
工具链体检（配置：C:/Users/JingYu/.dsh-stm32/config.json）
编译  ✔ gcc、CMake、Ninja 都在
烧录  ✔ OpenOCD 在
调试  ✔ OpenOCD、GDB 都在
生成代码  ✔ CubeMX、CubeMX 内置 JRE 都在
都齐了：/stm32-build 就能编译
```

缺件那行是「编译  ✘ 缺 arm-none-eabi-gcc、CMake —— winget install …」这种形状，**缺件也算 success**：体检结果不是错误，是信息。

### 6. 踩坑

- **`stm32_env_install` 有两层 mode**：工具的返回体是宿主卡片形态 `{ mode: "report" | "job", jobId, message, report }`，引擎侧的 `plan` / `install` 在 `report.mode` 里。第一版 schema-guard 断言 `value.mode === "plan"` 直接红（`'report' !== 'plan'`）。断言必须写成 `value.mode !== "job"` + `value.report.mode === "plan"`。
- **schema-guard 的假 ctx 只有 `tools.register` 和 `get("subprocess")`**：门禁如果插在参数校验之前，一大批「非法参数也能拿到完整失败报告」的既有断言会被门禁文案替代。blocked 报告还必须满足各自的 `output.schema`：`stm32_project_create` 的 `report.firmwareRoot` 不能赋 `undefined`（要干脆不赋），`stm32_debug_session` 的 `session.ok` 必须是 `false`。
- **`test/run-units.mjs` 必须给子进程 `DSH_STM32_NO_CONFIG=1`**：开发机上真实存在 `~/.dsh-stm32/config.json` 时，`search-roots-units` 里「没给参数就用默认候选」的断言会红。而 `toolchain-units.test.mjs` 顶部自己 `delete process.env.DSH_STM32_NO_CONFIG`——它测的就是配置层。这是个典型的「测试互相污染」，用环境变量在进程边界切开最省事。**二次事故**：真装把 `~/.dsh-stm32/config.json` 写出来之后，`search-roots-units` 里那两条「没给参数就该吃默认候选」的断言直接红了（actual 变成 `D:/app/msys64/ucrt64/bin`）——这几条把 env 当参数**显式传** `{}`，`run-units` 给子进程设的 `DSH_STM32_NO_CONFIG=1` 传不进这个参数。现在该文件顶部有 `cleanEnv(extra)` = `{ DSH_STM32_NO_CONFIG: "1", ...extra }`，四条断言都走它：断言的是「默认层」，就不该让「本机装没装过」参与决定。
- **没有 subprocess 也不能只说「没找到」**：门禁在 `subprocess` 缺失时合成 `found: false` 的探测结果，并且把 `error`（`宿主没有提供 subprocess 服务，只能做文件存在性检查`）落进 `missing[].error`。否则用户看到「缺 gcc」，实际是宿主少注入了服务。
- **工具数/命令数是硬断言**：`test/commands-units.test.mjs` 里有一份命令名数组、`schema-guard` 头注释、README 的「N 个工具 / N 条命令」、`docs/development-notes.md` 的头部说明，新增一个工具要一起改，否则红的是三处不相关的地方。

### 7. 测试计数

套件 15 → 17，用例 137 → **170 pass / 0 fail**（CI 上是 168 pass + 2 skipped，跳过的仍是那两条需要真固件包的脚手架用例）。新增：

- `test/toolchain-units.test.mjs`（22 例）：配置读写往返（`DSH_STM32_CONFIG` 指到临时目录、反斜杠与大小写重复归并、写完无 `.tmp` 残留）、坏 JSON → `config: null` + errors、`normalize` 丢非法字段、`binDirsFromConfig` 推导、`toolchainConfigPath` 三种优先级、`updateToolchainConfig` 合并、`resolveSearchConfig` 四层优先级；门禁的 `CAPABILITY_COMPONENTS` / `normalizeEnvCheck`、快路径不 spawn、缺件 block 文案与 detail、warn 前缀、off 放行、60 s 缓存 `cacheHit` 与 `resetGateCache`、`generate` 报 `[cubemx, cubemx-java]`、无 subprocess 时 `missing[0].error`；以及引擎/门禁共用的 `resolveToolIn`（显式目录命中就不问宿主、目录没有才回退 PATH、哪都没有返回 null 不抛、老式假 subprocess 不带 `resolveExecutable` 也不炸）；再加大三例（§10）：外来配置的告警透传到 `warnings` / `gateReportNotes`、`buildTargets` 的 pacman 建议按 `binDirs` 推导且全文不出现开发机路径、`resolveTargetDir` 拒绝「盘符都不存在」的配置 msys64。`test/search-roots-units.test.mjs` 9 → 11：内置默认候选不含任何某台机器专属路径、`searchConfigWarnings` 只报不存在的条目（含 `source: "env"` 与存在项不报）。
- `test/install-units.test.mjs`（6 例，§11 那次真装事故换来的）：`parsePacmanQuery` 只收「包名 版本」行；五包已装时 pacman 步 `skipped` 且一条 `pacman -S` 都没执行（断言 calls 里没有该前缀）、`ok` / `verify.ok` / `config.written` 全 true 且写出的配置 `msys64` 对得上；pacman 失败但自检全过 → 步 `done`、detail 含「已装」与 `pacman -Syu`、`ok` true；依赖解不开且自检失败 → `failed`、detail 含「无法满足依赖关系」与 `-Syu`、`ok` false；工具真装返回 `mode: "job"`、`message` 含「已在后台安装」且不含「还没动手」、`report.notes` 里没有「这只是计划」、job label 含 `stm32_env_install`。假件只实现 `spawn` 的四个成员（`done` / `collected` / `terminate` / `waitForExit`），按命令内容回答，不跑真 pacman。第 6 例盯的是**计划文案与实际执行的偏差**：计划里 pacman 步必须写出「先 `pacman -Q` 问一遍、已装跳过」，且不能再预告一条无条件 `-Sy --noconfirm && pacman -S` 的命令；计划模式除了一次只读的 `reg.exe query HKCU\Environment /v Path`（用来预告「会不会重复写 PATH」）之外不跑任何命令，尤其不跑 pacman。
- `test/schema-guard.mjs` 17 → 20：`stm32_env_install` 缺开关停在计划（不写 PATH、不开 job）、门禁缺件时 `stm32_build` 返回 schema 齐全的失败报告、`envCheck: "off"` 不被门禁文案替代。

### 8. 还没验证的

- **真装只跑通了一半**（2026-10-24 在开发机真跑过一次，见 §11）：复用已有 MSYS2 → `prepare` 命中、`download` / `extract` 跳过、`pacman -Q` 判已装 → `skipped`、`verify` 5/5、`config` 写入，整条链是真通的。**仍然没跑过**：真下载 43 MB、解压、真装 247 MB（这台的五个包本来就在）、`reg add` 成功路径（PATH 里早就有这条目录，走的是「已存在不重复写」）、超长 PATH 的变量展开、跨卷 rename、`pacman-key` 重试分支、`needsDecision: "msys64Dir"` 分支。
- **`needsDecision: "msys64Dir"` 分支**：本机因为已有 `D:/app/msys64` 走的是 `discovered`，没有目标的机器上该返回「装哪？」而不是替用户决定。
- **block 档的真机复现**：只能真在缺件机器上跑。本机 `binDirs: ["D:/__dsh_stm32_missing_bin__"]` **模拟不出来**——探测层会回退到 PATH，`D:/app/msys64/ucrt64/bin` 在用户级 PATH 里，于是门禁照样放行；本机用 `generate` 能力（CubeMX 走绝对路径候选、PATH 供不上）验过 block 生效。

### 9. 0.1.1 真机验证揪出的不一致：门禁看 PATH、引擎不看（已修）

- **现象**：真宿主上 `stm32_build({binDirs: ["D:/__dsh_missing_bin__"], envCheck: "block"})` 照样编译成功（0.9 s）；`stm32_flash` / `stm32_regs_read` / `stm32_debug_session` 同参数却报引擎自己的旧文案「找不到 openocd（…）；查过 D:/__dsh_missing_bin__，以及 PATH」。同一次调用里门禁说齐全、引擎说找不到，用户看到的是自相矛盾的两句话。
- **根因**：门禁的探测（`probe.ts` 的 `resolveCandidate`）找不到目录就走 `subprocess.resolveExecutable`（= PATH）；而 `engine/flash.ts:214`、`engine/regs.ts:150`、`engine/debug.ts:201-202`、`engine/debug-session.ts:223`/`:311` 只调 `resolveFromDirs`（只看 `config.binDirs`），文件不存在就直接返回失败——**文案里那句「以及 PATH」其实没查**。`engine/build.ts` 的 `resolveCmake` 反而有 PATH 兜底（找不到就返回裸 `cmake` 交给宿主），所以只有它跑得通。
- **修法**：`src/engine/probe.ts` 新增 `resolveToolIn(subprocess, names, binDirs, signal)`：先按目录找文件（零 spawn），miss 再依次问宿主；宿主没有 `resolveExecutable`（老式假 subprocess / 离线单测）就返回 null 不抛。flash / regs / debug / debug-session 五处调用点全部换成它，门禁与引擎从此同一条规则。这也正是 `docs/development-notes.md:673` 早就写下的设计意图（scope 含「以及 PATH」）。
- **决策（用户 2026-10-24 明确）**：门禁与引擎都**不**忽略 PATH。顺序固定为「配置目录（`binDirs` / `msys64` / 环境变量）→ PATH 兜底」：配置里指的那份优先，配置里没有才用系统 PATH 里的，都没有才判缺件。理由：PATH 里的工具就是真能跑的工具，忽略它反而会对着一个装好的机器说「缺工具链」；配置目录优先则保证用户点名的那份不被旧版本顶掉。**不做**严格模式（只看配置目录）。
- **真机复验（2026-10-24，插件 0.1.1）**：`binDirs: ["D:/__dsh_missing_bin__"]` + `envCheck: "warn"` 逐个入口打了一遍，四个入口全部**靠 PATH 兜底跑通**：`stm32_build` 1.3 s 成功（增量，产物 656888 B）、`stm32_flash` 4.4 s「烧录成功（已校验）」（openocd 日志里有 `device id = 0x20036410`、`flash size = 64 KiB`、`** Verified OK **`）、`stm32_regs_read` 读到 3 个地址（`GPIOC_ODR=0x00000000`、`RCC_APB2ENR=0x00000035`、`ICSR=0x00000000`，pc=0x0800024c）、`stm32_debug_session` 起会话成功并在 `stm32_debug_eval` 里读到 `g_led_blink_count = 23`、`pc 0x8001178 <Reset_Handler>`，`stm32_debug_stop` 正常释放探针（之后 `stm32_doctor` 报 `processes: []`、`portBusy: false`）。**结论**：§9 那条修复在真硬件上成立，门禁与引擎不再是两套规则。
- **后台 job 在真宿主的行为**：`foreground !== true` 且宿主有 `jobs` 时走 job 分支，进度靠 `handle.append`，只在单测里用假 handle 验过。

### 10. 插件要给别人下载：默认值去本机化 + 外来配置告警

- **现象**：插件是给自己写的，路径也是自己的。三处把开发机写死进了产物：`DEFAULT_BIN_DIRS` 第一项是 `D:/app/msys64/ucrt64/bin`、`DEFAULT_CUBEMX_ROOTS` 第一项是 `D:/app/STM32CubeMX`；`buildTargets` 的五条 `install` 建议直接写 `D:/app/msys64/usr/bin/pacman.exe -S …`；`xcube-catalog.ts` 的来源串带 `C:/Users/JingYu/…`。别人 `dsh plugin add` 之后：报告里「查过 D:/app/msys64/…」是一句在他机器上无意义的噪声，照抄 pacman 建议直接报「不是内部或外部命令」，而把 `~/.dsh-stm32/config.json` 从这台机器拷过去更糟——安装器会拿配置里的 `msys64` 当已装目标，往一个不存在的盘上写。
- **根因**：路径不是「配置」，而是写进了常量、提示文案和数据快照；同时「配置是别的机器的」这个状态在整个链路里**没有任何表达通道**——读进来的路径既不过滤也不提示，安装器也分不清「已装」与「这台机器上根本没有这个盘」。
- **修法**（四条，互相独立）：
  1. **默认值只留通用位置**：`DEFAULT_BIN_DIRS = ["C:/msys64/ucrt64/bin", "C:/msys64/mingw64/bin"]`、`DEFAULT_CUBEMX_ROOTS = ["C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeMX"]`。装在别处不靠猜——自动发现（扫盘 + 注册表 + PATH）本来就兜得住，默认列表只是起点。
  2. **只报告，不动手**：`searchConfigWarnings(env, exists)` 检查 `STM32_BIN_DIRS` / `STM32_CUBEMX_ROOT` 与配置里的 `msys64` / `binDirs` / `cubeMxRoot`，不存在的每条给一句「配置文件里的 X 在本机不存在（配置可能是从别的机器拷来的），这一条搜不到工具；换机器后重跑 stm32_env_install，或手改 ~/.dsh-stm32/config.json」。它**不删条目也不过滤**，`resolveSearchConfig` 的输出与以前逐字一致——配置是用户的，插件没有资格替人清空。告警接进三处：`GateResult.warnings` + `buildDetail` 的「⚠ …」行、`gateReportNotes`（**放行时也带**，否则「编译成功」旁边看不到污染来源）、`stm32_env_probe.recommendations` 开头。
  3. **建议按实际 MSYS2 推导**：新增 `msys64RootFromBinDirs(binDirs)`（从 `<root>/ucrt64/bin` 这类路径反推 root）与 `pacmanHint(config)`，五条包建议变成 `<root>/usr/bin/pacman.exe -S …`，没有 MSYS2 证据时回落 `C:/msys64`；CubeMX 那条改成「装到 `C:/Program Files/…` 会被自动发现」。
  4. **安装器认盘符**：`driveUsable(path)` 先确认 `Q:/` 本身存在，再谈目录。配置里的 `msys64` 盘符都没有时 → 忽略该配置、notes 与 message 前置「⚠ 配置里的 MSYS2 根 Q:/app/msys64 在本机不存在（盘符都没有，配置大概是从别的机器拷来的），已忽略，请指定 targetDir」，然后照常回落自动发现、否则要求 `targetDir`。**绝不**往不存在的盘上 mkdir/解压。
- **决策**：为什么不按原计划写「按 `env` 推导默认路径的函数」（`LOCALAPPDATA`、`scoop`、`ChocolateyToolsLocation`…）？因为那等于把「猜别人的安装位置」这件事从 3 条硬编码扩散成 8 条更隐蔽的猜测，而自动发现已经在做同一件事且证据更强（真扫盘、真查注册表）。默认值越短越好，短到「只含 Windows 上最标准的两个位置」。
- **未做**：以上全部只在单测里用 `exists` 注入模拟过（假 `Q:/`、假 `E:/gone/bin`），**没有一台真正「什么都没装」的机器**跑过；PATH 写坏/超长的真机路径仍只在计划模式里看过（见 §8）。

### 11. 第一次真装：pacman 会顺手升级用户工具链，且"失败"不等于没装成

- **真跑的证据**（2026-10-24，`stm32_env_install({dryRun:false, confirm:true})`，后台 job）：`prepare` 命中已有 MSYS2、`download` / `extract` 跳过、`pacman` 退出码 1「错误：无法准备事务处理 (无法满足依赖关系)」、`verify` 5/5 全过（gcc 13.3.0、gdb 16.2、openocd 0.12.0、cmake 3.31.5、ninja 1.12.1）、`config` 写入，**job 整体判 failed**。
- **根因一（副作用）**：`pacman -S --noconfirm <5 个 mingw 包>` 对**已装**的包不是跳过而是"顺手升级到仓库最新"。`pacman -Sp --needed` 一跑就露馅：gcc 13.3.0 → 16.2.0、gdb 16.2 → 18.1、cmake 3.31.5 → 4.4.4、ninja 1.12.1 → 1.13.2、openocd 0.12.0 → 0.12.0-4。装个 openocd 顺手把别人的编译器升一个大版本，是任何插件都没资格做的决定。
- **根因二（假失败）**：久未整体升级的 MSYS2 上，`pacman -Sy` + 局部 `-S` 会因"局部升级解不开依赖"直接失败；而这时工具链其实**全都在**（`verify` 5/5），却报"安装未完成"。
- **修法**：
  1. 先问再装：`pacman -Q <packages>` → `parsePacmanQuery` 解析出已装集合，缺件才装。五个全在 → pacman 步直接 `skipped`，detail 写「…都已经装了，没有重复安装，也没有升级（要升级自己跑 pacman -Syu）。」
  2. 新命令 `pacmanInstallCommand(packages)` = `pacman -S --noconfirm --needed …`，**不带 `-Sy`**；只有整机一件都没装（`installed.size === 0`）时才走带同步的那条。
  3. 补包失败且不是"整机没装"时，先自动 `pacman -Sy` 重试一次并 `onProgress` 说明；仍失败且 stderr 含「无法满足依赖关系」就追加一句「这条一般是 MSYS2 太久没整体升级：先在 <msys64> 里跑 pacman -Syu，再重调本工具。」
  4. 成功判定加一条：`verify.ok` 且 pacman 步失败 → 该步改判 `done` 并附「但自检显示 5 个组件都能跑，按「已装」处理（插件不替你升级，要升级自己跑 pacman -Syu）。」——自检是最终裁判，pacman 的退出码只是过程信息。
  5. 真装卡片文案换成「已在后台安装 MSYS2 到 …：7 步依次跑，进度看 job 输出。」，并过滤掉计划模式专属的那句「这只是计划」，否则用户在 job 里读到"还没动手"会以为没装。
  6. **计划文案与实际执行对齐**：pacman 步原本预告的是 `bash.exe -lc "pacman -Sy --noconfirm && pacman -S …"`——真跑已经不是这条了。改成「先 `pacman -Q <5 个包>` 问一遍装没装，已装的直接跳过（不重复安装、也不升级…）；只对缺的包跑 `pacman -S --noconfirm --needed <缺的包>`；整机一件都没有时才先 `pacman -Sy` 同步一次」。用户是先看计划再决定装不装，计划里的命令必须就是会跑的命令。
- **验证**：`test/install-units.test.mjs` 6 例（假 `spawn`，按命令内容回答）；修完后再真机跑一次 `stm32_env_install({dryRun:false, confirm:true})`（job `stm32-env-install-7d8c8295473445d7`）：卡片首行「已在后台安装 MSYS2 到 D:/app/msys64（来源：配置里的 msys64）：7 步依次跑，进度看 job 输出。」，job 状态 **completed**，pacman 步 `[--]` 跳过（detail 列出 5 个包与版本）、PATH 步「已经有 D:\app\msys64\ucrt64\bin，没有重复写」、自检 5/5、config 写入，结尾「现在可以编译 / 烧录 / 调试」；再用真 `subprocess` 在本机复跑一次（临时脚本、`DSH_STM32_CONFIG` 指临时文件、`writePath: false`）：pacman 步 `skipped`、detail 列出 5 个包与版本、`ok` true、`verify.ok` true，**全程没有第二条 `pacman -S`**。
- **教训**：安装器对"已经装好一部分"的机器最危险——很容易把"再确认一次"写成"再动一遍手"。凡是 pacman / apt / npm install 这类命令，先查状态再决定执行，且默认永不隐式升级。

### 12. 动手前先选路线：installability 分流 + `stm32_route_plan`

- **问题**（用户 2026-10-24 在阿里云 Windows 服务器上实测 0.1.1 时提出）：插件默认只会「缺什么就想着装什么」。但缺件其实分两类——一类是 pacman 装得上的（gcc / cmake / ninja / openocd / gdb），另一类**根本装不了**：CubeMX 是 InstallAnywhere GUI 向导（没有官方静默参数、要 ST 账号并同意许可、装完约 1.5 GB），固件包不在安装包里且在 CubeMX 之外没有任何权威来源。旧门禁对这两类说同一句话「回一句「装」，我先跑 stm32_env_install 出计划」，用户照做只会拿到一个必然失败的 job。用户的原话要求是三条：必须用 CubeMX 的程序要有引导安装步骤；HAL 与寄存器都能做的程序要把两版的效率/可读性评估给他选；选了 HAL 又缺 CubeMX 就要引导他自己装。
- **取证（为什么固件包不能靠 GitHub 下载代替）**：`STMicroelectronics/STM32CubeF1` 有 `v1.8.7` tag，但仓库挂 22 个 git 子模块，编译必需的 `Drivers/CMSIS/Device/ST/STM32F1xx` 与 `Drivers/STM32F1xx_HAL_Driver` 都是子模块——**tarball / zip 里是空目录**。本机官方包顶层的 `package.xml` 只有 7 行（`DBVersion="2.0"` + `Release="FW.F1.1.8.0"` + `Patch="FW.F1.1.8.7"`），需要自造；而 CubeMX 认不认这种手工组装的包**尚未验证**（要往真实 `Repository` 放一次再 `-q` 生成才算数，属于会动用户安装目录的操作，等授权）。所以本期只做「说清楚 + 指路」，不做自动组装。
- **路由判断为什么必须绑工程**：同一个外设在不同工程里代价完全不同——USART 轮询 20 行，USART + DMA + 空闲中断收不定长帧就是另一回事。所以 `stm32_route_plan` 的 `requirement` 是必填项，不提供「通用 HAL vs 寄存器对照表」；给不出结论时宁可 `unclear` 也不瞎猜。
- **实现**（三块，互不依赖）：
  1. `src/data/install-guides.ts`：`COMPONENT_INSTALLABILITY`（前五个 `auto`，`cubemx` / `cubemx-java` / `firmware` 是 `manual`）+ `cubeMxGuide()` / `firmwareGuide({family,packageName,repositoryDir})`（字段化步骤：标题、说明、可粘贴命令、自检、`portable` 的「整目录拷过去免重装」）+ `guidesFor(components)`（`cubemx` 与 `cubemx-java` 合成一份）。
  2. `src/engine/toolchain-gate.ts`：`GateResult` 增 `installability: "none" | "auto" | "manual"` 与 `guides: InstallGuide[]`；`GateMissing` 每条也带 `installability`。block 档的 `nextStep` 按缺件成分分流：全 auto → 原文案「回一句「装」」；全 manual → 「插件不代装，照着 guides[].steps 走」；混合 → 两句话分开说，并把「能自动装的是哪几个」点名。`buildDetail` 每条缺件多一行「方式：自动（插件可代装）/ 手动（插件不代装，按下面的指引）」，`gateReportNotes` 在放行时也贴前两步——**用户往往是在"编译成功但可能有坑"的那一刻才需要这条指引**。
  3. `src/tools/route-plan.ts` + `src/engine/route-plan.ts`：`PERIPHERAL_RULES` 28 条规则（`family` + `rank` 同族只留最具体的一条：说「串口中断」就不再单列「串口轮询」），每条给 HAL 与寄存器两套 `{effort, risk, setup}`（1 最省 → 5 最费），寄存器为 `null` 的是协议栈级外设（CAN / USB / ETH / SD / FSMC / 低功耗 / RTOS），`regGap` 写清「为什么没有寄存器版」。判定：`reg.effort<=2 && reg.risk<=2` 才建议寄存器，否则建议 HAL；有 `hal-required` 就 `hal-only`，全 `register` 就 `register-ok`，其余 `both-viable`。工具把门禁的 `capability` 也跟着路线走：`register-ok` 查 `build`（gcc/cmake/ninja），否则查 `generate`（CubeMX + JRE），再叠一层 `findFirmwarePackage`（三条判据与 `scaffold.ts:113-126` 保持一致，同族多版本取字典序最大，只有半成品时 `incomplete: true` 并提示「多半是只解压了 GitHub 源码包」）。
- **踩坑**：`matchText` 最初只把来源记成 `"requirement"`，`iocPeripherals` 分支又拿外设名去查规则 id，导致 `matchedBy` 永远没有 `"ioc"`（单测直接红）。改成 `matchText(text, into, source)` 三参数后，来源才如实反映「这句话是需求里说的还是 .ioc 里已使能的」。另一条：写中文文案时用 ASCII 双引号当引号会把 TS 字符串写断（tsc 一片 `TS1005`/`TS1127`），全项目统一用「」。
- **验证**：`test/route-plan-units.test.mjs` 15 例（四条 verdict 判定、同族去重、`unknown` 提示、`.ioc` 证据、`familyOf`、固件包完整/半成品/无 Repository 三种、门禁 manual 与 auto 两档文案、`guidesFor` 合并规则）；`test/schema-guard.mjs` 20 → 21（`stm32_route_plan` 缺 `requirement` 的早退形状 + 正常评估形状，`envCheck: "off"` 保证不 spawn）。套件 17 → 18，用例 170 → **186 pass / 0 fail**（CI 上 184 + 2 skipped）。
- **顺手补的三处**：① `.ioc` 里的 `NVIC` / `RCC` / `SYS` 是 CubeMX 的虚拟系统条目，原先被当成"已使能外设的证据"，于是正文写「已把 3 个外设算作证据」而表里只有 2 行——现在按 `VIRTUAL_IOC_IPS` 过滤掉；② 随插件下发的 SKILL 顶部加了「〇、先定路线」，把手写代码前先跑 `stm32_route_plan` 写成工作流第一步，否则模型会直接闷头写代码，评估工具的结论永远用不上；③ 固件包指引的 `sizeHint` 原先把「F1 一代约 293 MB」写死，真机上给 H7 看照样这么讲——现在按系列查 `FIRMWARE_SIZE_HINTS`（2026-10 在 `D:\app\STM32CubeMX\Repository` 直接量的：F1 v1.8.7 = 293.4 MB / 10,778 文件、G4 v1.6.2 = 471.3 MB / 23,089、F4 v1.28.3 = 1,674.0 MB / 43,397、L0 v1.12.4 = 258.4 MB / 17,504、C0 v1.4.1 = 380.6 MB / 21,535），没实测过的系列给 250 MB – 1.7 GB 区间而不是编数字；`cubeMxGuide()` 里的「F1 约 293 MB」也一并去掉。
- **还没验证的**：CubeMX 是否接受手工组装的 `Repository` 包（见上）；`stm32_route_plan` 在真机上还没跟着一条真实工程走过完整流程；寄存器模板当时仍未落地（用户 2026-10-24 决定：**不预置进插件目录**，改为首次从 GitHub 拉到可检索的缓存目录，之后复用——已由 §13 落地）。

### 13. 缓存目录 + 下载器 + 寄存器版模板

- **要求（用户 2026-10-24）**：「寄存器版本文件不能提前放进插件目录，因为后续要拓展至任意 stm32 单片机，不可能每一个都放进插件，可以设置一个缓存目录，每次从网上下载下来模板啊什么的，都放到一个可检索的目录里，这样就只第一次需要下载，后面就复用缓存区模板了。」——所以本期三块：可检索缓存、下载器、寄存器版脚手架，**模板一个字节都不进插件包**。
- **取证一（下载源，本机实测 `curl.exe`）**：`raw.githubusercontent.com/.../stm32f1xx.h` **超时（curl 28）不可用**；`github.com` 206、`api.github.com` 206、`codeload.github.com/.../tar.gz` 200 / 1,086,613 B / 2.8 s；`fastly.jsdelivr.net/gh/...` 206 / 0.94 s；`ghproxy.net/https://raw.githubusercontent.com/...` 206 / 1.9 s。于是 `sourceUrls()` 固定四候选顺序：jsDelivr fastly → jsDelivr cdn → raw.githubusercontent → ghproxy。逐文件用 jsDelivr 核过 10 个文件全 200（`core_cm3.h` 109,913 B、`stm32f103xb.h` 842,883 B、`startup_stm32f103xb.s` 9,725 B 等）。
- **取证二（ST 上游到底有哪几套文件，直接决定模板清单）**：F1 只有三套，`x8` / `xC` / `xD` 三种写法在 Include 与 startup 目录**全是 404**：`Include/{stm32f103x6.h 832,603 B, stm32f103xb.h 842,883 B, stm32f103xe.h 962,263 B}`、`Source/Templates/gcc/{startup_stm32f103x6.s 9,272 B, startup_stm32f103xb.s 9,725 B, startup_stm32f103xe.s 12,022 B}`。中等容量（C8/CB）归 `xB` 那一组。`F1_STARTUP_BY_DENSITY` 因此是 `{6:x6, 8:xb, B:xb, C/D/E:xe}`，每条直接带 `{startup, define, header}` 三元组，不再拼串。
- **实现（六个文件）**：
  1. `src/engine/cache.ts`：缓存根 `DSH_STM32_CACHE`（支持 `~` 展开）> `%LOCALAPPDATA%\dsh-stm32\cache` > `%USERPROFILE%\AppData\Local\...` > `os.tmpdir()/dsh-stm32-cache`；`index.json` 可检索（`CacheEntry{id,kind,family,label,root,createdAt,totalBytes,files,sources,license}`）；`writeCacheIndex` 走 `.tmp` + rename 原子替换；坏 JSON **不抛**——返回空索引 + 一句中文错误（缓存是加速手段，坏了就当没缓存）。
  2. `src/engine/fetch.ts`：`fetchOne(target, destRoot, {fetchImpl, timeoutMs, signal})` 按 `urls` 顺序试，HTTP 非 2xx / 字节数 < `minBytes`（默认 16）/ 内容前 512 字节像 HTML 都记为该源失败并进 `attempts`；成功走 `.part-<pid>` + rename，不留半截文件；`fetchAll` 并发 3、`onProgress(outcome, done, total)`。**只用全局 `fetch`，零运行时依赖**，测试注入 `fetchImpl`。
  3. `src/data/cmsis-sources.ts`：`CMSIS_FAMILIES` 目前只有 F1（`cmsis-device-f1@master` + `STM32CubeF1@master` 的 CMSIS Core 头 + `core_cm3.h`）；`startupChoiceFor(mcu)` 认 `STM32F103C8T6` 与 `F1:B` 两种写法，**认不出返回 null**（宁可说"这版不支持"，也不编一个文件名）；`cmsisTemplatePlan(choice)` 产出 10 个 `FetchTarget`，落盘路径按 ST 固件包布局（`Drivers/CMSIS/Device/ST/STM32F1xx/...`、`Drivers/CMSIS/Include/...`），每项带自己的 `minBytes`（头 200、`stm32f103xb.h` 10,000、startup 500…）。
  4. `src/engine/register-template.ts`：`ensureCmsisTemplate()` 查缓存 → `checkCacheEntry` 全好即 `cacheHit` → 否则 `fetchAll` → 写 `THIRD_PARTY_NOTICES.md`（Apache-2.0 + 两个 ST 仓库地址 + 「本目录是下载缓存，不是插件源码」）→ `upsertCacheEntry`。下载失败时**把整条缓存条目删掉**（半截缓存比没有缓存更糟）。`createRegisterProject()` 复用 `templates/scaffold` 的四个公共文件（`CMakePresets.json`、`.gitignore`、`STM32F103XX_FLASH.ld`、`cmake/gcc-arm-none-eabi.cmake`），CMSIS 从缓存 `cpSync` 整棵 `Drivers`。
  5. `templates/register/{CMakeLists.txt,Core/Src/main.c}`：`CMakeLists.txt` 只四个占位（`__PROJECT_NAME__` / `__FAMILY_DIR__` / `__STARTUP_FILE__` / `__DEVICE_DEFINE__`）；`main.c` 是纯 CMSIS 的 PC13 翻转 + `g_led_blink_count` 计数，`delay_ms` 用 `SysTick->LOAD/VAL/CTRL` + `COUNTFLAG` 轮询，**一个 HAL 符号都没有**。
  6. `src/tools/cache.ts`（`stm32_cache`，`action: list|verify|fetch|purge`）+ `stm32_project_create` 增 `route: "hal" | "register"`（门禁按路线分流：寄存器版查 `build`、HAL 查 `generate`）。
- **两个真 bug（都是 e2e 首次运行才暴露的）**：
  1. **容量档拼串**：第一版把 C8 拼成 `stm32f103x8.s` / `stm32f1038.h`，四个源全 404。修法见上「取证二」。顺带在下载失败分支加了判断：所有 `attempts` 都是 `HTTP 404` 时提示「上游就是 404，多半是模板清单写错了（插件 bug）」，别让用户去换网络。
  2. **`system_stm32f1xx.c` 路径错**：`CMakeLists.txt` 里引用 `Core/Src/system_stm32f1xx.c`（那是 CubeMX 生成工程的布局），缓存里的模板在 `Drivers/CMSIS/Device/ST/STM32F1xx/Source/Templates/system_stm32f1xx.c`，配置阶段直接 `Cannot find source file` + `No SOURCES given to target`。改成直接引用 `Drivers` 路径。
- **决策与理由**：
  - **只比字节数、不比 sha256**：文件来自 GitHub 的 tag/branch，四个源同一份内容；sha256 对每个文件要多读一遍盘，而缓存损坏的典型形态就是"截断/缺失"——字节数足够抓住这两种。真要验完整性，`stm32_cache verify` 报告的 `missing` / `changed` 已经能让人一眼看出问题。
  - **不照抄 `templates/scaffold/.vscode`**：那份 `launch.json` 里 `svdPath` 是 `D:/JingYu/STM32/...`、`armToolchainPath` / `gdbPath` 是 `D:/app/msys64/ucrt64/bin`（§10 同一类毛病）。寄存器版工程跑在**别人的机器**上，宁可没有 `.vscode` 也不能带着我的路径。
  - **半截缓存整条删**：缓存命中判据是"文件都在且大小对"，半截条目会让后续每次 `checkCacheEntry` 都判不命中却又不重下，变成永久坏状态。
- **e2e 实测**：首次 `createRegisterProject` → 1,221 ms、10 个文件下载成功、`templateFiles: 6`、`driverFiles: 10`；紧接着 `cmake --preset Debug` + `cmake --build --preset Debug` → 4 步构建，`reg.elf` 431,076 B，**FLASH 760 B / 64 KB（1.16%）、RAM 1,576 B / 20 KB（7.70%）**；第二次调用 `cacheHit: true`、153 ms，注入的 `neverFetch` 一次都没被调用。
- **一次事故（值得单独记）**：用 PowerShell `Add-Content` 往 `test/schema-guard.mjs` 追加中文用例。Windows PowerShell 5.1 的 `Add-Content` 默认按 ANSI(936) 编码写，把一个 UTF-8 文件写成了混合编码，`tools.read` 直接 `invalid UTF-8 text`；随后"用 GBK 读回来再写 UTF-8"的补救把原本正常的整片中文变成不可逆 mojibake。恢复手段是**不碰 git 命令**（git 由用户全权负责）：用 Node + `zlib` 直接读 `.git` 对象库（`HEAD` → commit → tree → 逐层解析 `mode SP name NUL 20-byte sha`）把已提交版本 inflate 回来，再补未提交的改动。**落盘规范**：仓库里的中文文件只走 `write` / `edit` 工具，禁止 `Add-Content` / `Set-Content` / `Out-File` / `>` 写文本。
- **验证**：新增 `test/cache-units.test.mjs` 10 例（缓存根四种来源与 `~` 展开、坏 JSON、`upsert` 幂等 + `checkCacheEntry` 缺文件/大小不符、`fetchOne` 首源 404 回退次源、网页/过短不算成功、`fetchAll` 并发统计、`startupChoiceFor` 六种写法、`cmsisTemplatePlan` 10 文件与四候选、离线明说 `not-cached`、下载后命中且删文件会重下、`createRegisterProject` 产物齐全 + G431 被拒）；`schema-guard` 20 → 22（`stm32_route_plan` 与 `stm32_cache`）；套件 18 → 19，用例 186 → **197 pass / 0 fail**（CI 上 195 + 2 skipped）。
- **还没验证的**：
  - `stm32_cache` 与 `stm32_project_create route:"register"` 在真宿主里还没跑过（本段只做了工具级 e2e，用的假 ctx）；宿主加载新 `lib/` 需要重启。
  - 只有 F1 在 `CMSIS_FAMILIES` 里。G4/H7 等系列缺的不是"下哪个文件"的想象力，而是**上游真实文件名**——F1 这次就因为 `x8`/`xC`/`xD` 猜错而四个源全 404，别的系列必须同样先 `curl` 核一遍再补表。
  - 固件包（`STM32Cube_FW_*`）当时只报告、不下载：`package.xml` 要自造，CubeMX 认不认这种手工组装的 `Repository` 包尚未实测——这一点已在 §14 实测并落地。

### 14. 固件包下载器（`stm32_firmware_install`）

- **要解决的问题**：CubeMX 装好不等于有**这一颗芯片**的固件包。安装包本身不带固件包，`<CubeMX 根>/Repository/` 是空的，用户得在包管理器里另下 200–300 MB；离线或慢网机器上这一步经常卡住整条 HAL 路线。
- **先定性地问一句「CubeMX 认不认手工组装的包」**（这决定了下载器值不值得做）。取证：
  - UM1718（`pdftotext -layout` 抽文本）里固件仓库是**单一**路径（Help → Updater settings），没有多目录列表；但脚本命令 `project setCustomFWPath` 可以让**单个工程**指向任意目录（`.ioc` 键 `CustomFwLocation`）。
  - 真包 `package.xml` 只有 257 B：`<Package DBVersion="2.0"><PackDescription Release="FW.F1.1.8.0" Patch="FW.F1.1.8.7">…</PackDescription></Package>`，顶层再没有任何 manifest / 哈希 / 与下载源绑定的文件。
  - 对照实验：同一个 `.ioc`、同一套脚本，A 组 `setCustomFWPath` 指向真包、B 组指向自造的同构包（`Drivers/STM32F1xx_HAL_Driver/Src/stm32f1xx_hal.c` 末尾塞了注释标记）。两组都生成成功，B 组生成的工程里那条标记**命中**（A 组不命中）→ **CubeMX 认我们组装的包，内容逐字节来自我们目录**。
  - 顺带挖到一个危险行为：把 `.ioc` 的 `ProjectManager.FirmwarePackage` 改成不存在的包名，CubeMX **不报错**、退出码 0、照样打印 `Code succesfully generated`，只是**不拷 HAL**（只出 Inc/Src）。所以生成成功不能当验收，必须按判据自查——这也正是 `src/engine/scaffold.ts` 的 `resolveFirmwareRoot()` 一直在做的事。
- **为什么不能直接解 `STM32CubeF1` 的 tarball**：主仓挂 22 个 git 子模块，`Drivers/CMSIS/Device/ST/STM32F1xx` 与 `Drivers/STM32F1xx_HAL_Driver` 在 zip/tar 里是**空目录**，解出来编译必挂。所以下载器改为拉两个独立源仓（`stm32f1xx-hal-driver`、`cmsis-device-f1`）加 5 个 CMSIS 内核头，自己摆成固件包布局。
- **取证（体积与源）**：codeload 的 `stm32f1xx-hal-driver` 818,831 B（顶层 `Inc/` 与 `Src/`）、`cmsis-device-f1` 1,086,613 B（顶层 `Include/` 与 `Source/`），加 5 个内核头，一个包约 2 MB——秒级，不需要断点续传。codeload 的 HEAD 不回 `content-length`（chunked），所以计划模式只能给约 2 MB 的估值，真实字节数装完才知道。仓库名要用规范写法 `stm32f1xx-hal-driver`（下划线旧名会 302）。
- **实现（四个文件）**：
  1. `src/engine/tar.ts`：自写 tar.gz 解包（`extractTarGz`），支持常规文件、目录、ustar `prefix`、pax `x`（取 `path=` 与 `size=`）、GNU 长名 `L`；符号链接与设备文件只计数跳过。**两遍**：先把所有条目校验完（拒绝绝对路径、盘符、含 `..`），全部通过才建目录写文件——第一版边解析边写，踩到 `../escape.txt` 时前面的文件已经落盘，调用方会看到一个看起来解完了的假目录。另有 `maxBytes`（默认 512 MiB）防炸弹。不依赖机器上有没有 `tar`。
  2. `src/data/firmware-packages.ts`：`FIRMWARE_FAMILIES.F1`（包前缀、版本、HAL 目录、设备目录、内核头清单、两个源码归档的 `mapPath` 规则）；`archiveUrls()` 三候选 `codeload` → `ghproxy` → `api.github.com`；`firmwareVersionTags()` 按 `FW.<族>.<x.y.z>` 规则给 `{release: FW.F1.1.8.0, patch: FW.F1.1.8.7}`；`packageXmlText()` 生成与官方同构的 6 行；`verifyFirmwarePackage()` 五项判据（内核头 5 个、HAL Inc 非空、HAL Src 非空、设备 Include 非空、`Source/Templates/gcc` 有 `startup_*.s`）。未接入的族在联网前就返回「插件还不会给 X 自动组装固件包（目前只会：F1）」。
  3. `src/engine/firmware-install.ts`：`decideTarget()` 三档落点——已有官方包 → `existing`（什么都不做）；仓库可写 → `repository`；否则 → 缓存目录 `firmware/<包名>` 并追加「要靠工程级 `CustomFwLocation` 指过去，这个绝对路径会写进 `.ioc`」的 notes（**落点顺序已被 14.1 的真机复验推翻：现在默认落 CubeMX 目录里的 dsh-firmware**）。`firmwareInstallPlan()` 零副作用（计划模式连目录都不建），`installFirmware()` 才下载解包写 `package.xml` 与 `THIRD_PARTY_NOTICES.md` 并自检。**计划模式判可写**要沿 `dirname` 向上找最近存在的祖先再 `accessSync(W_OK)`——Repository 还没建时直接 access 会抛 ENOENT，把可写的根误判成不可写而错落缓存（这个 bug 是测试抓出来的）。
  4. `src/tools/firmware-install.ts`（`stm32_firmware_install`）：`dryRun` 默认出计划，`dryRun: false` 加 `confirm: true` 才真装；真装走 `jobs.start` 后台 job（进度 `handle.append`），`foreground: true` 或没有 jobs 服务时同步。纯 fetch 加 fs，不需要 `subprocess`。
- **决策与理由**：
  - ~~**优先落 Repository 而不是缓存**~~（已被 14.1 否定）：`CustomFwLocation` 会把机器绝对路径写进 `.ioc`，换机器或清缓存就失效；而 Repository 是 CubeMX 与插件都直接认的位置。缓存只是仓库不可写时的退路。
  - **不把已装的包拷进缓存**：同族多版本并存（本机 `Repository` 里 F1 就有 V1.8.5 与 V1.8.7）会让缓存涨到数 GB，且 CubeMX 升级或删包后缓存副本立刻陈旧。缓存里只放寄存器版那套约 1 MB 的 CMSIS 模板。
  - **自写解包器而不是调系统 `tar`**：单测能用内存造的 tar.gz 完整覆盖（含路径穿越、坏 gzip），也不依赖用户机器上有没有 tar。
- **e2e 实测（真网络加真编译）**：`installFirmware({family: F1, target: repository, mode: install})` → `ok: true`、`kind: repository`、**7 个文件 / 2,047 KB / 4,751 ms**、五项判据全过；接着 `createProjectScaffold()` 从这个组装包拷出 14 个工程文件加 **238 个固件文件**；`stm32_generate`（CubeMX 无头，154,298 ms，冷启）落位 6 个 Core 文件；`cmake --preset Debug` 加 `cmake --build --preset Debug` → 19 步构建成功，`fwe2e.elf` 654,232 B，**FLASH 4,704 B / 64 KB（7.18%）、RAM 1,584 B / 20 KB（7.73%）**。整条「下载 → 组装 → 生成 → 编译」在组装包上闭环。
- **验证**：新增 `test/firmware-units.test.mjs` 12 例（自带 ustar 构造器 `makeTar` 与 `makeTarGz`；归档里塞 120 KB 随机数据才能过 `minBytes: 100_000`；覆盖解包映射与路径穿越整次失败、坏包、`firmwarePlanFor` 的版本串与文件表、未接入族与错版本、五项判据、计划零副作用、假网络整装、下载失败不许假装成功、已装时零网络、工具契约与 H7 联网前早退）；`schema-guard` 22 → 23（19 个工具）；套件 19 → 20，用例 197 → **215 pass / 0 fail**（`firmware-units` 后来补到 17 例，见 14.1；CI 上跑 213 加 2 skipped）。
- **踩坑记录**：
  - `scaffold` 只出骨架，`Core/Src/main.c` 要 `stm32_generate` 才生成；拿骨架直接 `cmake --preset Debug` 会报 `target_sources: Cannot find source file: .../Core/Src/main.c`——**不是 bug**，别把它当下载器的问题查。
  - 手工用 `execFileSync` 跑 CubeMX 时 120 s 不够、240 s 也可能不够：冷启动一次实测 154 s，加上初始化能到 4 分钟以上。要么走插件的 `stm32_generate`（默认 600 s），要么把 `run_code` 的 `timeoutMs` 一起放宽。
  - 一次被 kill 的 CubeMX 会在目标目录里留下半个 `Drivers`（这次是 61–62 个 HAL 源文件），重跑会补齐；但别拿文件数对不对当成功判据——用 `verifyFirmwarePackage()`。
- **还没验证的**：
  - 只有 F1 在 `FIRMWARE_FAMILIES` 里，别的系列要先 `curl` 核过真实仓库名与顶层目录（F1 这次就因下划线旧名 302 踩过）。
  - ~~`repository` 落点在**真 CubeMX 安装目录**里还没跑过~~ —— 已跑过（真 Repository 装 1.8.8），结论是**会被 CubeMX 静默忽略**，见 14.1。`cache` 落点加 `CustomFwLocation` 的全链路不做了：那条路会挂死，改用 `setCustomFWPath`。
  - ~~CubeMX 认组装包这一条是用 `setCustomFWPath`（工程级）验的，插件的 `stm32_generate` 目前并不发这条命令~~ —— **已补齐**：`stm32_generate` 现在按 `.ioc` 的 `ProjectManager.FirmwarePackage` 找包，并在脚本里发 `project setCustomFWPath <包目录>`（见 14.1）。

#### 14.1 真机复验与三处更正（2026-10-25）

把上文的「组装包放进真 Repository → 直接生成」这条链路拿到真机上跑，结论与设计时的假设相反，据此改了三处代码。

**① 落进真 Repository 的包会被 CubeMX 静默忽略。** 把组装好的 `STM32Cube_FW_F1_V1.8.8`（HAL 源文件里带标记）放进 `D:/app/STM32CubeMX/Repository`，`.ioc` 写 `ProjectManager.FirmwarePackage=STM32Cube FW_F1 V1.8.8`，再带 `LibraryCopy=1` 重跑 `stm32_generate`（173,557 ms 与 123,121 ms 两次都 `ok`）：工程里 `Drivers/STM32F1xx_HAL_Driver/Src/stm32f1xx_hal.c` 是 **20,257 B**（官方 1.8.7 的大小），我们那份带标记的是 **20,293 B**，标记一次都没出现 —— CubeMX 认不出这个版本名，无报错地退回它自己认识的 1.8.7。旁证：CubeMX 日志里 `CubeFinder database FW Pack versions=[…]` 是**线上**清单，不含自造版本；`~/.stm32cubemx` 下也没有本地包注册记录。

**② 只改 `.ioc` 指自定义目录会挂死。** 改 `ProjectManager.CustomerFirmwarePackage=<包目录>` 加 `DefaultFWLocation=false` 后重跑：`ok:false`、**421,600 ms「CubeMX 生成超时」**，HAL 一个都没拷（多半弹了迁移对话框，无头模式没人应答）。

**③ 唯一被证实有效的机制是脚本命令。** `project setCustomFWPath "<包目录>"`。现在 `buildGenerateScript()` 多一个 `firmwareDir` 参数，非空就在 `config load` 之后、`generate code` 之前插这一行（路径含空格会加引号）。找包交给 `locateFirmwarePackage()`：`<root>/Repository` 与 `<root>/dsh-firmware` 都找，包名精确匹配优先、其次版本号大的、同版本优先官方；`firmwareNeedFromIoc()` 从 `.ioc` 读 `ProjectManager.FirmwarePackage`，缺这条时退回 `Mcu.CPN` 推族加该族默认版本。

**落点改为 `<CubeMX>/dsh-firmware`。** `decideTarget()` 现在是：显式 `targetDir` → `existing` → `cubeMx`（插件自建，与 Repository 并列，不动官方包）→ 写不进去才退回用户缓存 `cache`。`target:"repository"` 保留，但 notes 会明说「CubeMX 不会自动认这个版本号，生成靠 setCustomFWPath」。这样生命周期跟着 CubeMX、整目录可搬、不同盘也不怕跨卷。

**顺带加的防线。** `parseGenerateLog()` 现在把 `Unknown command` / `Unrecognized command` / `Invalid command` 之类判为**失败** —— 万一日后 CubeMX 改命令名、`setCustomFWPath` 被忽略，也不会拿到「成功但用错固件包」的结果（这种结果比直接失败更难查）。

**报告与卡片。** `GenerateReport` 增 `firmwareDir` / `firmwarePackage` / `firmwareSource`（`repository` | `dsh-firmware` | 空），工具卡片多一行「固件包：…（CubeMX 仓库 / 插件的 dsh-firmware 目录）」；找不到包时 notes 里写找过哪些目录，以及可以用 `stm32_firmware_install` 装到 `dsh-firmware` 下。

**验证。** `test/firmware-units.test.mjs` 12 → **18 例**（选址缺陷修复后又加到 22，见 §14.2）（新增 `buildGenerateScript` 发不发那行命令与插入位置、`parseGenerateLog` 未知命令判失败、`firmwareNeedFromIoc` 两种来源、`locateFirmwarePackage` 的优先序与不完整包过滤、`firmwareInstallPlan` 三种落点且计划模式不建目录、`resolveFirmwareRoot` 在 `Repository` 缺失时回落到 `<CubeMX>/dsh-firmware`）；`schema-guard` 同步改期望；套件 20、用例 210 → **216 pass / 0 fail**（§14.2 修完是 **220**）。

### 14.1 真机验收（2026-10-25）：装到 dsh-firmware → 脚手架 → 生成 → 编译

**装。** `installFirmware({family:"F1", version:"1.8.8", cubeMxRoots:["D:/app/STM32CubeMX"], mode:"install"})` → `ok`、`targetKind` **cubeMx**、目录 `D:/app/STM32CubeMX/dsh-firmware/STM32Cube_FW_F1_V1.8.8`、**7 个文件 / 2047 KB**、五项判据全过。`Repository` 保持原样（9 个官方包），官方地面一点没动。

**脚手架。** `stm32_project_create route:"hal"` → `templateFiles` 14、`driverFiles` 238，`firmwareRoot` 指向 dsh-firmware 那份 —— 这是本段补的 `resolveFirmwareRoot()` 双层查找（先 `Repository`、再 `dsh-firmware`）在起作用；原来只查 `Repository`，装到 dsh-firmware 的包会被判「找不到固件包」。`.ioc` 里 `ProjectManager.FirmwarePackage=STM32Cube FW_F1 V1.8.8`、`LibraryCopy=1`。

**生成。** `runGenerate`（注入真 spawn 的 `SubprocessService`）：第一次 394,518 ms，`ok` 但 **CubeMX 没把 HAL 拷回工程**（先删掉了工程里的 `stm32f1xx_hal.c` 做基线，结果没回来）；第二次不删（200,194 ms）→ `ok`、`firmwareDir` 指向 dsh-firmware 目录、`firmwareSource` 为 `dsh-firmware`、`verdict.ok` true、`errors` 空，notes 写着「本次指定固件包：…（来源：插件的 dsh-firmware 目录）- 脚本里用 project setCustomFWPath 传的，不写进 .ioc。」

**编译。** `cd demo/.verify-fw2; cmake --preset Debug; cmake --build --preset Debug` → 配置 58.5 s、19 步构建、`fw2.elf`：**RAM 1,584 B / 20 KB（7.73%）、FLASH 4,704 B / 64 KB（7.18%）**。整条链在真机成立。

**新发现的限制（还没改）。** 只靠 `.ioc` 的 `ProjectManager.LibraryCopy=1` **不会**让 CubeMX 从 `setCustomFWPath` 指的自定义包把 HAL 拷进工程（上面第一次实验就是证据）；§14 那次能拷，是因为脚本里另外发了 `SetCopyLibrary "copy all"`，而插件现在**不发**这条命令。对 `project_create route:hal` 够用（Drivers 由脚手架提供），对「CubeMX GUI 建的、没拷库的工程」不覆盖 —— 待定：`buildGenerateScript()` 在工程缺 `<Drivers>/<族>_HAL_Driver/Src` 时补发它，或至少在报告里提示。

### 14.2 修：自动选址把固件包往不存在的 Program Files 里塞（2026-10-25）

**现象。** 宿主里调 `stm32_firmware_install({family:"F1", version:"1.8.8"})`，计划落点是 `C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeMX/dsh-firmware/STM32Cube_FW_F1_V1.8.8`，而本机 CubeMX 实际装在 `D:/app/STM32CubeMX`（`C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeMX` 根本不存在）。计划模式零副作用，所以没写坏东西，但真装会往一个要管理员权限的地方撞。

**两条根因，缺一不可。**
1. **候选根顺序**：`resolveSearchConfig` 的自动发现把 `DEFAULT_CUBEMX_ROOTS` 里那些「别的机器上的默认安装位置」也追加进来，且排在本机真装的那份前面；`decideTarget()` 是按列表顺序撞第一个「可写」的根，于是先撞上 Program Files 那条。
2. **可写性判据在 Windows 上不成立**：plan 模式用 `accessSync(最近一个已存在的祖先, constants.W_OK)` 探测。Windows 上 `access(W_OK)` 只看文件的**只读属性**，不看 ACL —— `C:/Program Files` 对普通用户是只读的，但它的只读属性是关的，于是被判成「可写」。install 模式没这个毛病（它是真 mkdir + 写探针文件）。

**修法（`src/engine/firmware-install.ts`）。**
- 新增 `isProtectedSystemDir(dir, env)`：把 env 里的 `ProgramFiles` / `ProgramFiles(x86)` / `ProgramW6432` / `ProgramData` / `SystemRoot` 归一成小写正斜杠前缀，落在其下即算受保护。`dirWritable()` 的 plan 分支一旦发现最近存在的祖先受保护，直接返回不可写并说明原因，不再信 `access(W_OK)`。
- **刻意不把整块系统盘 `C:/` 算进来**：`%TEMP%`、`%LOCALAPPDATA%` 都在 C: 上，算进来会把所有临时目录判成不可写（第一版加了 drive-root 逻辑，测试立刻红，这正是它该红的理由）。
- 新增 `orderCubeMxRoots(roots)`：本机 `existsSync` 为真的排前面（组内保序），不存在的排后面；`decideTarget()` 改用它。这样「哪台机器的默认路径」不会再压过「真有 CubeMX 的那份」。

**验证。** `test/firmware-units.test.mjs` 18 → **22 例**（`isProtectedSystemDir` 的真/假两个方向、`orderCubeMxRoots` 的排序、plan 在 `[不存在的根, 真根]` 下必须选真根且不建目录、根不存在且祖先受保护时必须退回用户缓存）；套件 20、用例 216 → **220 pass / 0 fail**。宿主级复验（重启后 `stm32_firmware_install` 的 targetDir 应变成 `D:/app/STM32CubeMX/dsh-firmware/...`）还没做。

### 15. 批 1：审计里的数据安全问题（2026-10-25）

按 `docs/logic-audit.md` 的四批计划，批 1 先修「会把用户文件写坏或把假成功当真」的那几条。全部改动都在离线套件里可回归：套件 20 → **21**，用例 220 → **244 pass / 0 fail**（CI 上 242 + 2 skipped）。

**B2 源码按 UTF-8 读写，GBK 工程被写坏。** 新增 `src/engine/text-file.ts`：BOM → `utf8-bom`，严格 UTF-8 解码成功 → `utf8`，严格 GB18030 解码成功 → `gb18030`，都不行 → `unknown`（拒绝改动）。关键取舍：Node 只有 GB18030 **解码器**、没有编码器（`TextEncoder` 只支持 UTF-8），所以 GBK 文件不做整份重编码，而是 `lineStarts()` + `replaceLineRange()` **按字节拼接** —— 没改的行原字节照抄，只把新增行按 ASCII 插进去；新增内容含非 ASCII 时直接拒绝写入。`code-patch.ts` 与 `generate.ts` 的写盘都改用它，BOM 与 CRLF 保留，`unknown` 文件一个字节都不动。

**A6 flash 的 SWD 守卫不再静默放行。** `findIocFile()` 只认唯一一个 `.ioc`，0 个或多个都返回 `null`；原来这条分支直接返回 `blocked:false` 加两个空数组，守卫等于不存在。现在给出两条 notes：「SWD 守卫没生效：工程里没有 .ioc / 有 N 个 .ioc 分不清」+ 手工核对 PA13/PA14 的做法；`runFlash` 也把非 blocked 时的 notes 真的带进报告（以前丢掉）。另加 `stm32_flash` 的 `iocPath` 参数，多 `.ioc` 工程可以点名。

**A7 readWords 的值不再错位。** gdb 失败的命令只打一行 `Cannot access memory`、不产生 `$N`，按出现顺序对齐会让后面的值整体前移、还标 `ok:true`。现在每个地址前先 `echo ===DSH:<address>===`，`parseMarkedWords()` 只在各自那一段里找值；没有标记时（极老 gdb）才回退旧解析。

**A5 写盘不再是未捕获异常。** `regs_read` 的 openocd 临时脚本、`generate` 的 CubeMX 脚本与产物写回全部包 `try/catch` 转成干净失败；工程只读时给「工程目录可能只读」而不是堆栈。产物读不了编码时用新动作 `skipped-encoding`（schema enum 同步），旧文件编码认不出时**不覆盖**，宁可少做一步也不毁用户的中文注释。

**A1 `project_create` 覆盖前先备份。** `preflightTarget()` 把「工程名 → 目录非空 → hal 且已有同名 `.ioc` 直接拒绝（指向 `stm32_ioc_plan` / `stm32_ioc_apply`）」提到门禁之前；`backupBeforeOverwrite()` 只备份**真正会被覆盖**的文件（14 个模板目标 + startup + system，register 路线是 `CMakeLists.txt` / `main.c` / 4 个公共文件），备份失败即 `ok:false` 且一个字节都不写；写盘中途失败按「本次新建」精确回收，原目录存在时只 `rmdir` 空目录，绝不递归删用户文件。

**A2/A12 缓存索引不再丢数据。** 索引读坏时先改名成 `index.json.broken-<ts>`（rename 失败退 copy，两者都失败才拒绝覆盖）再以空索引重建；`writeCacheIndex` 的 tmp 名带 pid + 序号 + 随机后缀，首次 rename 失败不再先删旧索引，而是把旧索引改名成 `index.json.bak-<ts>` 再搬，二次失败把备份原样放回并抛 `CacheIndexWriteError` —— 抛错时旧索引逐字节未动。

**A4 tar 解包只认白名单。** 条目类型只接受常规文件（0 / NUL / 空）与目录（5），x / g / L / K 作元数据前置消费，1 / 2 / 3 / 4 / 6 / 7 一律跳过并记进 `skippedPaths`（以前符号链接会被当 0 字节文件写下并计入成功）；`isSafeRelative()` 补拒反斜杠、冒号、绝对路径与空段 / 点段；声明大小超出实际数据判为截断包，整次失败不留半截文件。

**A3 `.ioc` 引脚表保序。** 原来重写 `Mcu.PinN` 时按 `.Signal` 过滤，PB2/BOOT1 这类只有 `.Mode` 的引脚会被剔除、留下孤儿键。现在复制原顺序、只追加新引脚，且顺序没变时一个 `Mcu.Pin*` 键都不碰。

**B3 用户 PATH 读失败不再当成没有 Path。** `UserPathRead` 增 `readable`：读失败（spawn 出错、超时、非 0 且不像找不到、输出认不出）→ `readable:false`，此时规划阶段就失败并给手工命令，`applyUserPath()` 不写空串备份、不发 `reg add /f`；只有 reg 明确回答没有这个值才允许新建。这条以前会把整条用户 PATH 覆盖成一条目录。

**测试。** 新增 `test/text-encoding-units.test.mjs` 9 例（编码四态、GB18030 解码、编码器拒绝非 ASCII、字节级替换保留 GBK 注释、unknown 拒改且字节不变、BOM 保留）；`session-units` +2（标记分段不错位、无标记时空结果）、`flash-units` +1（守卫不生效要说清楚）、`cache-units` +2、`firmware-units` +2、`ioc-plan-units` +2、`install-units` +2、`scaffold-patch-units` +4。

### 16. 批 2：只在用户机器上暴露的可用性问题（2026-10-25）

批 1 修的是任何机器都会错的写坏数据与假成功；批 2 修的是**在开发机上看不出来**的那一类：开发机的 msys64 同时躺在用户级与机器级 PATH 里、CubeMX 装在 `D:/app`、工程路径纯 ASCII、系统代码页恰好不影响 grep。换台干净机器或中文 Windows，这些地方就露。逐条见 `docs/logic-audit.md` 的 B1/B4–B10/B12/B13/B15；本段只记取证与取舍。

**B1 模板把开发机绝对路径塞进每个新工程。** `templates/scaffold/vscode/launch.json` 原来写死 `svdPath: D:/JingYu/STM32/cmsis-svd-stm32/stm32f1/STM32F103.svd`、`armToolchainPath`/`gdbPath: D:/app/msys64/ucrt64/bin`，`scaffold.ts` 原样拷进用户的 `.vscode/` —— 别人按 F5 必挂，还顺手泄露我的用户名。现在模板只留占位符（`__GDB_PATH__` / `__ARM_TOOLCHAIN_PATH__` / `__CMAKE_PATH__` / `__SVD_PATH__`），由新增的 `src/engine/vscode-config.ts` 在写盘时按**本机探测结果**填充：`detectVscodeFill(binDirs)` 在 `binDirs + PATH` 里找 gdb 与 cmake，`fillVscodeTemplate()` 有值就替换、**没值就把整行删掉**并记进 `dropped`（cortex-debug 会把空字符串当有效路径，写空串比不写更糟），`scaffold` 再把 `describeDroppedPlaceholder()` 的人话塞进 `report.warnings`。SVD 一律不填：插件没有 SVD 来源，模板里留注释教用户自己加一行。

**B6 模板 settings.json 绑死 ST 官方 VS Code 扩展。** 原来是 `cube-cmake`、`-DCMAKE_COMMAND=cube-cmake`、`stm32cube-ide-clangd.path=cube` 加 `${env:CUBE_BUNDLE_PATH}/gnu-tools-for-stm32/14.3.1+st.2/...` —— 没装 ST 扩展的用户在 VS Code 里配置与索引全废。现在只留通用三项：`cmake.cmakePath: __CMAKE_PATH__`（探测到的系统 cmake，探测不到就整行删）、`cmake.preferredGenerators` 为 Ninja、`cortex-debug.variableUseNaturalFormat`。

**B4 子进程不注入 env，只有找可执行文件用 binDirs。** 这条最阴：`stm32_env_install` 刚把工具装好、`config.json` 里的 `binDirs` 也写对了，但 DSH 宿主进程的 `PATH` 还是旧快照 —— 门禁 `locateFast` 只 `existsSync` 判齐全，紧接着 `cmake --preset Debug` 里那句裸 `arm-none-eabi-gcc` 找不到。开发机永远不暴露，因为 `ucrt64/bin` 早就在系统 PATH 里。修法：新增 `src/engine/tool-env.ts` 的 `envWithBinDirs(binDirs, base)`（去重去空、`binDirs` 用 `path.delimiter` 拼在原 `PATH` 前、Windows 上只保留一个大小写正确的 `Path` 键），`RunRequest` 加 `env?` 并透传到两处 `subprocess.spawn`，`runBuild()` 把 `envWithBinDirs(config.binDirs)` 传给 configure 与 build 两次调用。为什么不是只给 cmake 一个绝对路径：cmake 还要再调 gcc/g++/ninja/objcopy/size，它们是 cmake 的子进程，得靠 `PATH`。

**B13 门禁快路径只判文件存在。** 快路径（全部候选 `existsSync` 命中就放行、零 spawn）会把下载不完整／被杀毒隔离／架构不对的 exe 也当成齐全。现在命中后对**该能力的主组件**（build→gcc、flash→openocd、debug→gdb、generate→cubemx-java）跑一次轻量版本命令（`smokeTarget()`，同样 60 s 缓存，`resetGateCache()` 一起清）；跑不通就按缺件处理，并在 `warnings` 里写明「文件在（路径），但版本命令没跑通：…」—— 区分没装与装了但跑不起来，这两种给用户的下一步完全不同。

**B15 hal 路线的门禁用了 generate 能力。** `route:"hal"` 只拷 CMake 文件与 `Drivers/`，不需要 `STM32CubeMX.exe` 与它的内置 JRE，但门禁按 `generate` 能力拦人，缺 JRE 的用户会被要求去装 CubeMX。现在 hal 路线**不挂门禁**（缺固件包由 `scaffold` 自己按三条判据报，并列出找过的路径），register 路线仍按 `build` 能力检查（它要真编译），`gate.message` 降级成 `warnings` 一行。

**B7 斜杠命令把带空格的路径切成两段。** `/stm32-build "C:/Program Files/My Proj"` 以前解析成 `C:/Program`，报工程目录不存在让人莫名其妙。`tokenizeCommandLine()` 改成一次扫描的引号感知切词：引号内不切、顺手剥引号、**不做反斜杠转义**（Windows 路径里反斜杠太多，当转义符会把路径吃掉），未闭合引号明确报错；`--flag` 判定加 `!token.quoted`，所以引号里的 `--clean` 是目录名不是开关。

**B8 斜杠命令不走门禁。** 命令是人已经决定要干的动作，所以这里用 `envCheck: "warn"`：缺件照样跑，但把 `gate.message` 放在卡片第一行（`withGateWarning()`，`kind` 原样保留 —— 命令已经执行完，改成 error 会误导）。接了 `/stm32-flash`、`/stm32-debug`（三处返回都包）、`/stm32-build`；`/stm32-stop` 只关会话、`/stm32-doctor` 本身就是体检，不接。顺序是**先门禁再掐探针**，与工具层 `stm32_flash` 相反 —— 缺件时不该先去动别人的调试会话。

**B9 reg.exe 的输出是 GBK，却被当 UTF-8 读。** `readUserPath()` 与 `readRegistryInstallDirs()` 都按 `utf8` 读 `reg.exe` 的管道输出。中文 Windows 上 `REG_SZ` 里的中文会变成 U+FFFD：注册表发现直接失效（`existsSync` 必失败），更糟的是把解坏的旧 PATH 用 `reg add /f` **写回**，用户整条 PATH 永久损坏。修法两条：新增 `decodeRegistryText()`（先严格 UTF-8、再严格 GB18030，都失败就 `ok:false` 且 `text` 留空；string 入参含 U+FFFD 直接拒绝），`readUserPath` 新增 `queryUserPathBytes()` —— 用 `cmd.exe /d /s /c "reg.exe query … > dump.txt 2>&1"` 把**原始字节**落盘再 `readFileSync` 成 Buffer（宿主的 `CollectedReader` 只给 string，拿不到字节），解不出来按读不到处理、拒绝写注册表。为什么不用 powershell 改 `[Console]::OutputEncoding`：多一次进程启动、多一层引号转义，而 EDR 环境下 cmd 与 powershell 的存活概率没区别。

**B5 安装自检走 PATH 兜底，pacman 失败被改判成功。** 自检用 `probeAll`，而 `probeTarget` 在目录里找不到时会回退 `subprocess.resolveExecutable`（≈PATH）—— 于是 PATH 上本来就有 gcc 能让 `verifyState.ok` 变 true，接着把 pacman 的 `failed` 补偿成 `done`，报告写安装完成。修法：`ProbeOptions` 加 `allowPathFallback?: boolean`（默认 true，既有调用不变），自检传 `false`；再加 `isInsideDir()` 过滤器 `strayTools` —— 只有五个工具**都落在目标 `binDir` 里**才允许那条补偿判定。`message` 相应补一句能跑的那几个不在 `<binDir>` 里、这个目录并没有装好。

**B12 install 分支跳过受保护目录判定。** `dirWritable()` 的 plan 分支会拒 `Program Files`（见 §14.2），但 `create=true` 的分支直接 `mkdir` 加写探针 —— 冒烟时正是这样往不存在的 `C:/Program Files/.../dsh-firmware` 里规划落点。现在 `decideTarget()` 的 `repository` 与 `cubeMx` 两支都先过新增的 `hasCubeMxExe(root)`（只判 `<root>/STM32CubeMX.exe`；比 `search-roots.looksLikeCubeMxRoot` 宽松是**故意**的 —— 那个还要 `jre/bin/java.exe`，是给无头生成用的，缺 JRE 但装了 CubeMX 的机器也该能落 `dsh-firmware`），假根跳过并写 note。

**B10 装到 cache 或自定义目录的包，generate 结构上看不到。** `locateFirmwarePackage()` 只扫 `<root>/Repository` 与 `<root>/dsh-firmware`，而 `stm32_firmware_install` 在 CubeMX 根写不进去时会落到 `<cacheRoot>/firmware` 或调用方指定目录，随后 `nextStep` 又让用户直接调 `stm32_generate` —— 必然找不到包。修法：`locateFirmwarePackage` 增 `extraDirs`（来源扩成 `repository | dsh-firmware | cache | custom`，`firmwareSourceLabel()` 统一中文标签），装成功时往 `<cacheRoot>/firmware/installed.json` 记一条落点，`firmwareExtraDirs(env)` 把 `<cacheRoot>/firmware` 与记录里的非 CubeMX 落点拼起来交给生成。`tools/generate.ts` 的 `firmwareSource` enum 与来源标签同步扩到五值。

**B10 的漏网之鱼（原条目没写到）。** `scaffold.resolveFirmwareRoot()` 同样只扫 CubeMX 根 —— 装到缓存的包在**建工程**那边也看不见。现在它和 `generate` 共用同一个 `firmwareExtraDirs()`（先写在 `generate.ts` 里，本段移到 `firmware-install.ts`，避免两处各写一份迟早对不上），并支持 `extra.dir` 本身就是包目录（显式 `targetDir` 指到包上）。三条判据抽成 `isUsableFirmwareRoot()` 共用。

**测试。** 新增 `test/vscode-units.test.mjs` 9 例（模板里没有 `D:/app`/`D:/JingYu`/`C:/Users`、launch 保留 gdb 与 toolchain 占位符、settings 解绑 ST 扩展且去注释后是合法 JSON、`detectVscodeFill` 的 binDirs 命中与 `Path` 兜底与都没有时三项空串、`fillVscodeTemplate` 填值/删行两态且删行后仍可解析、`describeDroppedPlaceholder` 四条人话加未知占位符、`envWithBinDirs` 前置与保留原 PATH 与不改入参、`Path` 与 `PATH` 只留一个键、空 `binDirs` 不凭空造 PATH）；`commands-units` 6 → 11（引号带空格路径、引号内另一种引号、普通多参数不变、未闭合引号报错且命令拒绝执行、缺件时三条命令以工具链警告开头 —— 最后这条在 `try/finally` 里临时把 `STM32_BIN_DIRS` 指到空目录并关掉自动发现与配置，否则开发机上永远齐全，用例等于没测）；`toolchain-units` 22 → 24（快路径只给主组件跑一次版本命令、文件在但跑不通不算齐全且 `missing` 只有 gcc、smoke 缓存 60 s 内只 spawn 一次）；`scaffold-patch-units` 15 → 17（hal 缺 CubeMX 时报找不到固件包而不是缺 STM32CubeMX、固件包在下载缓存里也能被脚手架找到并拷出 `Drivers/`）；`firmware-units` 24 → 28（`extraDirs` 找缓存落点且只给 CubeMX 根时找不到、`installed.json` 记录、假根不建 `dsh-firmware`、install 分支祖先受保护不建目录）；`install-units` 8 → 10（PATH 上能跑的 gcc 不许把 pacman 失败改判成功且 `--version` 调用次数为 0、GBK 字节的中文 PATH 解得对且写回幂等）；`search-roots-units` 11 → 12（`decodeRegistryText` 四态）。套件 21 → **22**，用例 244 → **269 pass / 0 fail**（CI 上 267 加 2 skipped）。

**还没验证的。** ① 真中文 Windows 上 `cmd.exe` 重定向落 `dump.txt` 的语义只在假 subprocess 加人工拼的 GBK 字节上验过，没在实机跑过一条真 `reg query`；EDR 拦截导致 `dump.txt` 缺失、且旧值含中文的组合没有专门用例（行为落在安全侧：不写注册表、给手工命令）。② 非中日英代码页（CP932／CP1251）的字节可能能被严格 UTF-8 解码但语义是乱码，零依赖识别不出来，与改前一致。③ `decodeRegistryText` 与 `text-file.detectEncoding` 是两套同类探测，合并要连 `text-file.ts` 一起改，留到批 4。④ 宿主级复验（重启后按 F5 看 `.vscode` 是否真能调试、`/stm32-build` 带空格路径）还没做。

### 17. 批 3/批 4：假成功、状态一致性与一致性清理（2026-10-25）

批 3（10 条）修「报告说成功但其实是假的、状态谁拥有说不清」；批 4（23 条）修剩下的文案、边界与清理问题。全部改动的可回归证据在离线套件：套件 22 → **23**，用例 269 → **296 pass / 0 fail**（CI 上 294 + 2 skipped）。逐条编号见 `docs/logic-audit.md` 的「建议修复批次」。

**A10 生成成功的判据。** §14 的实测已经证明：`.ioc` 里的 `FirmwarePackage` 指向一个 CubeMX 不认识的版本时，它**不报错**、照样打印 `Code succesfully generated`，只是不拷 HAL。`parseGenerateLog()` 又规定「有成功行就把 ERROR 全部降级成噪音」，两件事叠起来就是稳定的假成功。新增 `assessGenerateProducts(projectDir, appliedCount)`：没有任何产物落位 / 缺 `Core/Src/main.c` / 工程有 `Drivers/*_HAL_Driver` 但其 `Src` 下没有 `.c`（说明包没被认到）→ 直接 `fail()`，并且这步排在**写生成缓存之前**，下次不会用缓存把假成功复读一遍。`ok = successLine !== ""` 的老判据原样保留，产物判据是额外的必要条件。

**A25 flash 的成功判据。** `openocd` 在成功路径上也会打 `Error:` 行（无效 ACK 之类），原来任何 `Error:` 都判失败，等于成功也报错。现在先算 `succeeded = programmed && verified`：成功时命中 `Error:` 的行进 `noise`（首条写进 notes，别让用户以为没看见），失败时照旧进 `errors`。判定 `ok` 的条件没放松（`exitCode === 0` + `programmed` + `verified` + 无 errors）。

**A26 debug_run 的 `ok` 与 `errors` 自相矛盾。** 原来只看 `spawnError === null`、没超时、断点命中，完全无视 gdb 退出码与 `probe.errors`，于是报告写「调试快照完成」同时挂着一串 `Cannot access memory`。现在 `ok` 追加 `gdbOutcome.exitCode === 0 && probe.errors.length === 0`。

**A9 会话归属：turn/end 不能掐别人的调试会话。** 原来 `session/event` 收到任何 `turn/end` 就无条件 `debugSessions.stop()`。现在 `SessionStartRequest` 与 `InternalSession` 都带 `owner`（工具层填 `exec.agent.id`），`stop(reason, { requireOwner })` 在「会话有 owner 且与 requireOwner 不同」时不关并说明原因；`index.ts` 用新增的 `callerIdOf(event, session)` 依次读 `agentId` / `owner` / `agent.id` / `session.id`，**取不到就按旧行为无条件关**（宁可多关一次也别把探针留着不放 —— 单会话场景本来就没这个问题）。

**A27 探测被取消时不写 60 s 缓存。** 慢路径 `for (const target of wanted)` 里 `break` 之后仍然 `probeCache.set(cacheKey, ...)`，于是一次取消会让「缺 gcc」这个错误结论被缓存一分钟。现在 `signal.aborted` 时直接返回 `ok:false` 加「工具链检查被取消：这次没探完，也不缓存结果」，`cacheHit` 保持 false。

**A28 配置写回的 CAS。** `readToolchainConfig()` 记录 `mtimeMs`，`writeToolchainConfig(config, { expect })` 在 mtime 变了时返回 `conflict` 而不覆盖；`updateToolchainConfig()` 先读、冲突就重读重写一次（两次都冲突才失败）。tmp 文件名加 `randomBytes(4)`，两个进程同时写也不会互相踩。安装器与「写 cubeMxRoot」都走这条路。

**A29/A30 取消与 pacman 失败的人话。** 取消时 `exitCode` 是 `null`，原来会落进「退出码 1 失败」分支并把暂存目录删掉 —— 现在是 `ExtractOutcome.cancelled` + `EXTRACT_CANCELLED`，暂存留着方便续跑，文案写「取消≠失败」。pacman 失败时补两条对症提示：`db.lck` 存在给出 `rm -f /var/lib/pacman/db.lck`，出现 conflicting files 给出 `--overwrite`。

**A21 job 卡片不再是计划快照。** 真装返回的 `report` 原来是 `plan` 的副本（`mode: "install"` 但步骤全是 `pending`、`targetDir` 是计划值），看一眼以为没动。现在返回 `runningReport`：步骤 `pending`、抬头「安装进行中」，真正的结果在 job 输出里。

**A36 取消桥接。** `exec.signal` 的 abort 监听在 `jobs.start()` 返回后立刻 `removeEventListener` —— 工具调用一返回，取消就再也传不进 job。现在监听一直留到 job 的 `done` 结算（`.finally` 里摘），`done` 补 `.catch` 把异常转成 `failed` 而不是永远 `running`（`firmware-install` 的 job 这条也一起补了）。

**A14 CubeMX 单飞锁要看进程活没活。** 原来只看 `pid` 加「30 分钟内一律占用」：进程崩了要等半小时，或者用户手删 `.dsh-stm32/lock.json`。现在锁里多写 `host`，`isProcessAlive(pid)` 用 `process.kill(pid, 0)` 真探一次（`EPERM` 按活着算）；同机且进程不在了就接管，并在进度里说明「接管了上次没释放的单飞锁（…进程已不在／来自另一台机器）」；另一台机器的锁仍然不抢。

**B11 pdsc 索引不再卡在 `.dsh-parked`。** 生成期间把第三方包索引整体 rename 走，还原依赖 `generate.ts` 的 `finally`；断电或被杀就留在停放态，而还原分支以前遇到「CubeMX 重建了非空 pdsc」只会让人手工合并。新增 `mergeDirectoryInto()` 逐项 rename 并回（目标已存在算 kept、失败计数），搬空后删停放目录，notes 写「已把停放的索引并回 N 项」。

**A11/A15 下载与替换的原子性。** 暂存目录改成唯一名 `.dsh-download-<pid>-<ts>` 并在下次启动时清扫陈旧目录（`sweepStaleTemps`），主流程补 `catch`；落盘改成「旧文件改名 `.old-<pid>-<seq>` → 新文件 rename → 成功删 `.old`／失败把旧文件还原」，中途失败不会留下半个文件。

**A22 单位。** `formatBytes()` 用 1024 进制却标 MB，41,060,000 字节显示成 39.2 MB。现在十进制（43060392 B → **43.1 MB**），与 GitHub 页面上写的大小一致。

**A23 「159 个包」是文件数不是条目数。** 索引目录里一个包每个版本占一个 `.pdsc`，159 个文件归并成 67 个包；原来报告写「收录 159 条」但实际只能匹配 67 条。现在 `XCUBE_CATALOG_ENTRY_COUNT = XCUBE_PACK_CATALOG.length`，`XCUBE_CATALOG_SOURCE` 由两个常量拼；`scripts/gen-xcube-catalog.mjs` 的 `render()` 同步改成同一布局（否则重跑生成器会把修复回退），并用 3 个假 pdsc 验证过输出。

**A24 缓存条目的 notices 也是文件。** 写进缓存条目的 `files` 列表与计数时漏了 `THIRD_PARTY_NOTICES.md`（10 个文件报成 10、磁盘上是 11）；重下时上一份先改名 `.stale-<ts>` 再删，删失败不阻塞新版本落盘。

**A32 下载内容真校验。** 只比字节数抓不到「返回了一个 200 的漂亮错误页」。`FetchTarget` 加 `markers[]`，每个 CMSIS 目标声明自己必须含的特征串（`system_stm32f1xx.h` 的守卫是 `__SYSTEM_STM32F1XX_H`，第一版只写 `__STM32` 全挂）；tar 先查 gzip 魔数 `1f 8b` 与条目数，解出 0 个条目直接判失败。

**A38 缓存完整性用 sha256。** `CacheFile` 加 `sha256`，`checkCacheEntry()` 不再只比字节数（大小相同但内容被改过的缓存会被继续用）。

**A8/A34 缓存工具的边界。** `stm32_cache` 的 `else` 兜底原来会落进 `purge`，未知 action 现在返回 `ok:false`；清空整份缓存要求 `confirm:true`（不传只报「要删什么」）；`action: fetch/verify` 把 `exec.signal` 真的传下去，取消能停。

**A13 下一步提示按落点分档。** 装到 `cache` / 自定义目录时 `nextStep` 还写着「直接调 stm32_generate」—— 现在 `nextStepFor()` 按 `targetKind` 给不同的话（缓存落点会说明生成靠 `setCustomFWPath` 指过去）。`existing` 分支仍是旧文案，属于已知未整理项。

**A16 `route_plan` 的四处。** `isConcurrencySafe` 从 true 改 false（它要探工具链）；`verdict === "unclear"` 时不再跑门禁（没有外设可评估时查工具链没意义），`guides` 相应为空、`toolchainCapability` 为 `"none"`；`ok` 不再被 `gate.ok` 拽住（寄存器路线不需要 CubeMX）；本机没探测到 CubeMX 根时给 `fallbackRepository: ""` 并说明「固件包落位要你自己填」。

**A17/A18/A31 契约与参数。** skill 正文把 `plan_id` 改成 `planId`（仓库里没有 `plan_id` 这个参数名，模型照抄就会失败）；`stm32_ioc_apply` 回滚时 `appliedChanges` 记 0（回滚不是应用变更）并新增 required 字段 `rolledBack`；`ioc_apply` / `ioc_plan` / `debug_session` / `debug_eval` 四处 `execute(rawArgs: X | undefined)` 加 `const args = rawArgs ?? {}`，宿主传 undefined 时不再 TypeError。

**A19 `regs_read` 借用会话时的参数说明。** `configFile` / `adapterSpeed` 在借用已有调试会话时**不生效**（openocd 是会话里那个），原来静默忽略；现在写进 notes 并给「先 stm32_debug_stop 再读」的做法。

**A20 死代码。** `debug.ts` 里 `REGISTER_NAMES` 只做 `some()` 再 `continue` 的空循环、`tools/generate.ts` 里 `report` 变量只写不读的两处全部删掉。

**A35 job 路径丢了 `released` 说明。** 同步路径会在 notes 里写「已释放探针」，job 路径把那句话丢了；现在 job 的 `run` 一开始就 `handle.append(released)`，`build` 与 `generate` 都补上。

**A37 安装指引的分支。** `install-guides.ts` 用 `in` 判族名（`"constructor"` 会命中原型链）改成 `Object.hasOwn`；`guideFor()` 原来只认 `cubemx` / `cubemx-java`，缺件矩阵里真实的第 7 个组件 `firmware` 取不到指引，现在支持它（`guidesFor` 调用不变）。

**B14 新装的 MSYS2 先整体升级一次。** 基包解压后立刻 `pacman -S --needed <5 包>` 在久未整体升级的镜像上会解不开依赖（实测「无法满足依赖关系」）。现在空库路径先 `pacman -Syu --noconfirm` 再装；已有一份完整 MSYS2 的机器**不**替用户升级（只 `-Q` 查、缺件才 `--needed`）。

**B16 缺件时不该收走别人的探针。** `releaseProbeFor()` 原来排在门禁之前：`stm32_flash` 因缺 openocd 被拦下，却顺手把别人开着的调试会话关了。现在先门禁、`block` 分支直接返回，之后才释放探针（斜杠命令侧是相反顺序，见 §16 B8）。

**B17 长路径复制。** `Drivers/CMSIS/Device/ST/STM32F1xx/Source/Templates/gcc/…` 这样的层级碰上深目录就超 260 字符。新增 `src/engine/fs-longpath.ts`：`toLongPath()` 给绝对路径加 `\\?\`（UNC 走 `\\?\UNC\`，非 win32 原样），`copyFileLong()` / `copyTreeLong()` 失败时给中文说明（两侧路径、`ENAMETOOLONG`、改短目录的建议）；`scaffold.ts` 的整树复制与两处单文件复制全部改走它，`mkdirTracked` 变薄壳保持 `register-template` 的调用签名。

**B18 CubeMX 脚本里的中文路径。** 脚本是 UTF-8 写的，而 CubeMX 是 Java 程序，读脚本用平台默认字符集（中文 Windows = GBK），路径里有中文就乱码。现在启动参数加 `-Dfile.encoding=UTF-8`，不动脚本内容、也不给用户添 BOM。

**D1（宿主验收发现，不在审计清单里）：填进 JSON 的 Windows 路径没转义。** §16 的占位符填充把 `D:\app\msys64\ucrt64\bin` 原样插进 `launch.json`，反斜杠在 JSON 字符串里是转义符 —— 生成的 `.vscode` 不是合法 JSON，VS Code 直接打不开。`fillVscodeTemplate()` 现在先把值里的反斜杠统一成正斜杠再替换（VS Code 与 CMake 都认正斜杠，且不再需要关心 JSON 转义）。引擎级复验：`createProjectScaffold` 建出的 `launch.json` / `settings.json` 剥注释后 `JSON.parse` 成功、反斜杠计数 0、`cmake.cmakePath` 是 `D:/app/msys64/ucrt64/bin/cmake.exe`。顺带一提：验证这一步的队友还确认了 GBK 文件经 `stm32_code_patch` 后中文逐字节不变（含反证：编码认不出的文件被拒且零改动）、register 覆盖前备份目录的 tag 是 `-register`、hal 且已有同名 `.ioc` 会被 preflight 拒绝且零写入、含空格目录 `demo\.accept space\reg proj` 里能正常编译出 elf。

**测试。** `engine-units` +1（CubeMX 说成功但 HAL 目录为空不算成功）、`flash-units` +1（成功序列齐全时 `Error:` 行进 noise）、`session-units` +2（别人的会话不关 / owner 未知照旧关）、`toolchain-units` +1（abort 后不写 60 s 缓存）、`thirdparty-units` 改写 1 例（停放索引逐项并回）、`xcube-units` +1（生成脚本重跑不会把条目数写死）、`vscode-units` +1（填进 JSON 的路径必须合法）、`scaffold-patch-units` +5（长路径三态 + 回滚 `rolledBack` + 四个工具接受 undefined）、`ioc-units` +2（`guideFor` 的 firmware 分支与 `Object.hasOwn`）、`install-units` 到 17、`cache-units` 到 16、`firmware-units` 到 30。最终 **23 套件 296 pass / 0 fail**（CI 294 + 2 skipped）。

**宿主级烟测（2026-10-25，重启后新 lib）。** 五项全部通过：
① `stm32_firmware_install({family:"F1", version:"1.8.8"})` 的计划落点是 `D:/app/STM32CubeMX/dsh-firmware/STM32Cube_FW_F1_V1.8.8`、`targetKind: "cubeMx"` —— §14.2 那条选址缺陷在宿主里确实修好了（以前会规划到不存在的 `C:/Program Files/...`）。
② `stm32_cache({action:"purge"})` 在有 1 个条目、1.0 MB 且没带 `confirm` 时 `ok:false`，message「要清空整个缓存（1 个条目、共 1.0 MB）必须带 confirm:true；只想删一个条目就给 id。什么都没删。」——A8 生效且零副作用。
③ `stm32_project_create({route:"hal", firmwarePackage:"STM32Cube_FW_F1_V1.8.8"})` 建出 14 个工程文件 + 238 个固件文件，`firmwareRoot` 指向 `dsh-firmware` 那份（scaffold 双层查找在宿主里生效）。
④ 该工程的 `.vscode/launch.json` 与 `settings.json` 剥注释后都是合法 JSON、反斜杠计数 0、占位符 0、不含 `D:/JingYu`（`D:/app` 会出现，那是本机探测到的工具链真路径，不是模板写死）——D1 修好。
⑤ `stm32_ioc_plan`（`ProjectManager.HeapSize` 0x200 → 0x800）+ `stm32_ioc_apply` 写入 1 个键变化，再 `stm32_ioc_apply({rollbackFrom})` 回滚：`appliedChanges: 0`、`rolledBack: true`，`.ioc` 回到 0x200 —— A18 生效。

**还没做的。** ② `firmware-install` 的 `existing` 分支 `nextStep` 还是旧文案。③ 只有 F1 在 `FIRMWARE_FAMILIES`，其他族要 curl 核实仓库名。④ `SetCopyLibrary "copy all"` 要不要补发仍未决（见 §14.1）。

## 18. 设置面板：宿主 web-api + 浏览器端 bundle（2026-10-25）

用户要的是「别只靠命令行改配置」：把 `~/.dsh-stm32/config.json` 搬到 DSH 的 **设置** 页里，能读、能改、能探测、能一键装。结论是先做**面板**（配置 + 探测 + 安装），不做卸载与目录浏览。

### 18.1 先摸清宿主的两条契约（决定技术路线）

**客户端插件不是插件里的一段 React，而是一个"外壳直接执行的 bundle"。** 宿主读已启用 Loader 条目 `package.json` 里的 `dsh.client`（要求 `platform: "web"`）与 `exports["./client"]`，把那个文件以 `/plugins/<包名>/client.js` 提供给浏览器。所以：

- 不需要打包器。`dsh-skill-mcp-panel` 的构建就是 `tsc -p tsconfig.json && node scripts/strip-client-export.mjs`，产物直接是 `lib/client.js`；
- 产物形状固定：`window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => { var module = { exports: {} }; ...; return module.exports; } })`，`exports.apply` 是入口、`exports.inject` 是客户端服务依赖；
- `factory(require)` 只认外壳种子：`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives`。要用别的模块得在 `dsh.client.external` 里声明——我们只用 `react`，没碰这一层。

**设置页的挂载点是 slot，不是路由。** 官方账户页的写法是 `ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "account", order: -10, label: () => t("nav"), locale: "settings.account", inject: () => operations }, AccountSection)), "<label>")`。`label` / `locale` / `inject` 都是可选的：我们只给 `{ name, id: "stm32", order: 40, label: () => "STM32 工具链" }`，不传 `locale`（中文写死）也不传 `inject`（组件自己 fetch）。

**顺带纠正一条早期的错误判断**：profile 的 `cordis.patch.yml` 里 `ui-settings` 的 `config.enabled: false` 是「代码工作工具开关」这条偏好，**不是**把设置页关掉。设置页一直存在。

**为什么客户端不声明 `dsh.client.inject`**：`dshmarket` 与 `dsh-skill-mcp-panel` 都列了 `@deepseek-ai/dsh-client-ui-layout` / `-sidebar` 之类的客户端服务，因为它们要用侧栏与主题；我们只需要 `slots`，它由外壳核心提供。**也不需要往 `cordis.patch.yml` 加 client loader 行**：这两个已装好的客户端插件同样只是 `dsh.profile.bundles` 里的一项 + 包自己的 `dsh.client` 声明（对比它们的 `package.json`：`dsh.bundle.patch` + `dsh.client.platform`，patch 里没有它们的 loader 条目）。

### 18.2 宿主侧：HTTP 而不是 remote / configForms

面板要读写的配置在 `~/.dsh-stm32/config.json`，**不在**宿主 settings 命名空间里——`ctx.configForms` 只对后者有效；走 typert 的 `ctx.remote` 又要另加一层协议定义与类型生成，对三个按钮的页面不值。所以照 `dshmarket` 的做法用宿主的 `webServer` 服务：

`register(route: { kind: "exact" | "prefix"; path: string; handler: (IncomingMessage, ServerResponse) => void | Promise<void> }): () => void`

分两层落地（`src/engine/web-api.ts` + `src/engine/web-routes.ts`）：

- **web-api.ts（纯逻辑，可离线单测）**：`configSnapshot` / `saveConfig` / `capabilitiesOf` / `summarizeProbe` / `probeTools` / `installPlan` / `installStart` / `installTaskState` / `handleWebApi` / `resetInstallTasks`，六条路由 = `GET /dsh-stm32/api/config`、`POST .../config/save`、`POST .../probe`、`POST .../install/plan`、`POST .../install/start`、`GET .../install/state`；
- **web-routes.ts（薄适配）**：`ctx.inject(["webServer"], scope => ...)` 里对每条路由 `server.register({ kind: "exact", path, handler })`，只负责拼 URL、读请求体（上限 1 MB）、写 JSON（`cache-control: no-store`）。宿主没组合 `webServer`（纯 CLI）时静默跳过。
- `src/types.ts` 新增 `WebServerService`，request/response 用 `any`：asar 里的宿主包**没有 .d.ts**（`node_modules/@deepseek-ai/*` 下 d.ts 数为 0），类型只能按 `dshmarket/src/routes.ts` 的用法自写。

**安全边界写在 web-api 里而不是面板里**（面板是浏览器代码，谁都能改）：`packages` 拒绝以 `-` 开头的名字（否则等于把 `pacman` 变成任意标志注入）与含空白 / `"'|&;<>` 的名字；`binDirs` 必须是字符串数组；`saveConfig` 的空补丁直接 400（不然会写出一个"看起来保存了"的假成功）；`installStart` 没有 `confirm: true` 一律拒。安装任务是进程内 `Map`（留最近 20 个、每个日志尾巴 200 行），真装复用 `planOrInstallMsys2`，与 `stm32_env_install` 同一个安装器。

### 18.3 浏览器端：手写纯 JS

`client/client.js`（674 行）三张卡：**装在哪**（读配置 / 改 `msys64` `cubeMxRoot` `binDirs` / 保存）、**缺什么**（探测 + 四项能力徽章 + 逐项路径版本与 `hint`）、**装工具链**（出计划 → 二次确认 → `install/start` → 轮询 `install/state` 到结束）。`scripts/copy-client.mjs` 把它原样复制到 `lib/client.js`；`package.json` 只加四处（`exports["./client"]`、`files += "client"`、`build` 串上复制脚本、`dsh.client.platform = "web"`），零新依赖。

不做 TS/JSX：这个文件的正确产物就是它自己；写成 TS 只会多一层「tsc 决定产物路径」的中间层，还要额外引入 jsx 运行时配置。

**队友桩测逮到一个真缺陷**：安装结果块原来用 `taskId === "" ? null : …` 判渲染，而轮询结束时组件会清掉 `taskId` 去重读配置——于是「安装成功 / 失败」连同日志整块从面板消失。改成 `(taskId !== "" || installState !== null)` 才渲染，任务号那一行单独判别。

### 18.4 测试与文档

新增 `test/web-api-units.test.mjs`（9 例）：配置快照（无文件 → `ok:false`、路径仍给出）、保存后读回且 `binDirs` 由 `msys64` 推出、四类非法输入都在动手前拒掉且不创建文件、能力归纳（缺 gdb 时 `debug:false` 而 `build:true`、`missingRequired` 只收必需项）、分发层 405 / 404 / 坏 JSON 400 / 缺 `taskId` 400、`confirm` 门槛（直接调与走 HTTP 都拒、且不登记任务）、探测与安装计划的入参校验、路由表六条无重复。`test/run-units.mjs` 的 `suites` 加一行。

**24 套件 305 pass / 0 fail**（CI 303 + 2 skipped）。README / README_EN 的计数与新增小节「设置面板（GUI）」同步。

**还没验证的**：面板在真 GUI 里的渲染与三步操作（要重启 DSH 后在 **设置 → STM32 工具链** 里点），以及宿主是否自动发现 `link:` 安装包里的 `dsh.client`（按 `dshmarket` / `dsh-skill-mcp-panel` 的同形安装推断会自动，重启后看 `/plugins/dsh-stm32/client.js` 能不能取到即可）。

## 19. 安装计划只报缺件：计划模式也要真的看一眼本机（2026-10-25）

**用户的反馈**（面板上线后第一句）：「我电脑已经有完整工具链了，安装计划应该只显示缺少的吧」。当时卡片写的是「把 MSYS2 装到 D:/app/msys64（来源：配置里的 msys64），再补 5 个组件；安装包 43.1 MB（需要下载）」，7 个步骤全 pending，用量估算「43.1 MB + 121 MB / 磁盘约 491 MB」——而这台机器上 5 个组件、`usr/bin/bash.exe`、用户 PATH、`config.json` 全都已经就位。

**根因是"计划零副作用"被理解得太宽。** 早期实现为了绝对安全，计划模式只做纯计算：不读 `pacman -Q`、不跑版本命令，于是它对"已装了什么"一无所知，只能按最坏情况（全新安装）出文案。真正的边界应该是「不写」而不是「不看」——`pacman -Q` 只看、`gcc --version` 只跑、`reg query` 只读，都不改变系统。

### 19.1 现在计划模式会做的只读动作

- `isMsys2Root(msys64)` + `usr/bin/bash.exe` 存在 → 真跑一次查询（优先 `usr/bin/pacman.exe -Q <5 包>`，没有才 `bash -lc`；与真装第 4 步同一个命令），`parsePacmanQuery` 得出 `installed` / `missing`；问不了（spawnError / 超时 / pacman 自己报错）就标 `pacmanUnknown`，**不编缺件清单**，并在 `notes` 里写明原因；
- `binDir` 存在 → `probeAll(..., { binDirs: [binDir], allowPathFallback: false })` 只跑 `VERIFY_IDS` 那五个版本命令（不越过目标目录去 PATH 上找，B5 的规矩照样守）；`verify.ok` 与「缺 X」直接进卡片的第 6 步，`report.verify` 不再是恒 `{ok:false, tools:[]}`；
- `configMatches`：现配置的 `msys64` 与 `binDirs` 对得上、`packages` 全含 → 第 7 步标 skipped「配置已经是这个样子，不用改」；
- `download`：已有 MSYS2 时恒为「`bytes: 0`」（安装包根本不会碰）；
- PATH 那一步复用已有的 `reg query` 读（只读一次，用于预告「会不会重复写」）。

### 19.2 文案按"实际要做什么"分四档

| 现场 | 首句 | 第 4 步（pacman） |
| --- | --- | --- |
| 已装齐 | **只回一句**「工具链完整，不需要装任何东西：5 个组件都能跑，PATH 与配置都已就位（D:/app/msys64/ucrt64/bin）。」——`steps: []`、`notes: []`、`nextStep: ""`，不列步骤也不贴 notes | （不出现） |
| 已有 MSYS2、缺 N 个 | 「计划（还没动手）：复用 … 里已有的 MSYS2，只补 N 个组件（缺 …）；不用下载安装包，已装的 K 个不动、也不升级。」 | `pending`：「先 pacman -Q 问过一遍：缺 N 个（…）；将跑 pacman -S --noconfirm --needed <缺的包>（已装的 K 个不动，也不升级）」 |
| 已有 MSYS2、问不出装没装 | 「计划（还没动手）：复用 … 里已有的 MSYS2；计划里没问出这 5 个组件装没装（pacman 超时或起不来），真装时会先 pacman -Q 问一遍，只补缺的，已装的包不动、也不升级。」 | `pending`：「计划里没问出来（pacman 超时或起不来）：真装时会先 pacman -Q 问一遍，只补缺的包…」 |
| 全新 | 原文案（下载安装包 + 补 5 个组件） | 原文案（整机空库时先 `pacman -Syu` 再补，不做 `-Sy` 后立刻 `-S` 的局部升级） |

**为什么完整时连步骤都不列**：把「没有可做的事」画成七行「已跳过」+ 三条 notes，卡片比真要装的还长，用户第一反应是「还有一堆动作在排队」。所以 `nothingToDo && verifyOk` 时直接返回紧凑结果（`steps: []` / `notes: []` / `nextStep: ""`），浏览器端 `client/client.js` 在 `steps.length === 0` 时也不再渲染「目标：… · 包：… · 下载：…」那行和步骤列表。另有一处兜底：`tools/env-install.ts` 在计划 steps 为空时用新导出的 `msys2StepSkeleton()` 补出 7 步骨架，真装 job 的「安装中」卡片照样列得出步骤（A21 的断言依赖这一点）。

**CubeMX 不在那 5 件里**：编译 / 烧录 / 调试都不需要它，但 HAL 路线要用它生成代码。所以紧凑卡片在 `cubemx` 与 `cubemx-java` 两项都没找到时补一句：「要写 HAL 库程序还需要从 ST 官网装 STM32CubeMX（含内置 JRE，约 1.5 GB，https://www.st.com/en/development-tools/stm32cubemx.html）；纯寄存器程序不需要它。」——否则「工具链完整」会被读成「HAL 工程也能直接生成」。

`usageNote(facts, …)` 同步四档：已装齐 →「不用下载任何东西（MSYS2 与 5 个组件都已在本机）」；缺件 →「不用下载安装包；只补 N 个包，pacman 下载约 …」；全新 → 原公式。`nextStep` 也分档，已装齐时直接给「去看 `stm32_env_probe` 或 `stm32_build`，要换一份 MSYS2 就传 `targetDir`」，不再劝人确认安装。

### 19.3 现场实测又逮到一层：pacman 比版本命令慢得多

第一版计划问包状态用的是 `bash -lc "pacman -Q …"` 加 15 s 预算（直接照抄版本命令的 `PROBE_TIMEOUT_MS`）——在这台机器上**一律超时**，于是计划又退回「缺 5 个」，看起来和没改一样。实测：`bash.exe -lc "pacman -Q <包>"` 要 **11.0 s**（`-lc` 会起一遍 profile），直接跑 `D:/app/msys64/usr/bin/pacman.exe -Q` 要 **6.5 s**（首跑含安全软件扫描）。两条改法：

- 优先直接跑 `<msys64>/usr/bin/pacman.exe -Q <包…>`（存在才用），没有才退回 `bash -lc`——省掉 shell 与 profile；
- 单独的 `PACMAN_QUERY_TIMEOUT_MS = 60_000`，不再挤占版本命令那份预算。

再加一个新事实 `pacmanUnknown`：问不出来（超时 / pacman 自己报错且一条都没解析出来）时**不再按「全部未装」编清单**——卡片改说「计划里没问出这 5 个组件装没装（pacman 超时或起不来），真装时会先 `pacman -Q` 问一遍，只补缺的，已装的包不动、也不升级」，用量估算也只说「缺几个包要等真装时才知道」。编一份看起来精确的假清单比不给清单更糟。

### 19.4 真机复验（2026-10-25，引擎级直调 lib）

同一台机器、同一份配置（`~/.dsh-stm32/config.json` → `msys64: D:/app/msys64`），`planOrInstallMsys2({ mode: "plan" })` 现在的输出：

- `ok = true`、`steps = []`、`notes = []`、`nextStep = ""`、`download.bytes = 0`、`verify.ok = true`（tools 5 项全 found）；
- 卡片全文只有一句：「工具链完整，不需要装任何东西：5 个组件都能跑，PATH 与配置都已就位（D:/app/msys64/ucrt64/bin）。」
- 对照：缺件 / pacman 问不出来 / 全新安装时仍走详细卡片（步骤 + 用量 + nextStep），因为那时每一步都有信息量。

### 19.5 测试

`install-units` 17 → **21 例**，按加入顺序：①「已有完整 MSYS2 + 5 个组件 → 说『什么都不用装』、`download.bytes` 为 0」；②「只缺 1 个包 → 只说 `openocd`、不列已装的 4 个」；③「pacman 问不出来（超时 / 报错）→ 不猜缺哪个，只说真装时会先问」；④「缺 CubeMX → 紧凑卡片补一句 HAL 提示，装了就不补」。既有那例「计划里的 pacman 步骤说的是真会跑的事」跟着改了断言：计划模式允许**一条**只读查询，但绝不能出现 `pacman -S` / `-Sy`。

**24 套件 318 pass / 0 fail**（CI 316 + 2 skipped）。README / README_EN 的计数同步到 318。

**还没验证的**：重启 DSH 后在面板里点「生成安装计划」，确认卡片首句变成「什么都不用装」。

## 20. 发布形态三连修：mpu_armv7 的 marker、npm 吞 .gitignore、盘根 mkdir（2026-10-25）

用户在另一台机器（阿里云 ECS、无 CubeMX、无 USB）实测暴露的三条「作者本机测不出来」的问题，全部是发布/环境形态才炸：

**Q1 mpu_armv7.h 被 marker 误杀（100% 复现，与网络无关）。** `cmsis-sources.ts` 给 5 个内核头共用 `[__CMSIS,__CORE_,__MPU_]`，但上游 V5.0.4 的 `mpu_armv7.h` 是 ARM 原版，真实守卫是 `ARM_MPU_ARMV7_H`（没有前导下划线）——一个都不命中，四条下载链路全通也必失败。改为按文件各配真实守卫（`__CORE_CM3_H` / `__CMSIS_COMPILER_H` / `__CMSIS_GCC_H` / `__CMSIS_VERSION` / `ARM_MPU_ARMV7_H`）。**测试侧同一个坑**：`cache-units` 的 `markerFor()` 按文件名猜 "`#ifndef __MPU_ARMV7_H`"，恰好撞上旧 markers 的 `__MPU_`，等于一直在测假世界——同步改成真实守卫表，并新增回归用例（真守卫内容必须能落盘）。

**Q2 npm 打包永远排除 .gitignore（所有 npm 用户 100% 复现）。** `.gitignore` 同时是 npm 的忽略过滤器，永远进不了 tarball；而 `register-template.ts` 把它列为**必需**文件，缺失即整次失败，报错还让用户"重新安装插件"——npm 用户重装是同一个包，死循环。用户决定**不改名、只做容错**：`.gitignore` 移出硬检查与复制循环，缺失时继续建工程 + 一句 warning（"工程功能不受影响，git 状态会多出 build/；想干净就自己建一个内容为 build/ 的 .gitignore"）；scaffold 路线同样处理；"重新安装插件"文案改为指向插件版本号反馈。两条路线各加一例"缺失时 ok:true + warning + 其余文件齐全"的测试（测试里临时把真实模板的 .gitignore 改名、finally 恢复）。

**Q3 盘根 mkdir EPERM（插件自设的雷）。** `targetDir=C:/msys64` 是插件自己建议的默认装法，而 parent 是盘根 `C:/`，Node 的 `mkdirSync(盘根, {recursive:true})` 在 Windows 抛 EPERM。新增 `isDriveRoot(dir)`（导出，纯函数）与 `ensureParentDir(parent)`：盘根走 `existsSync` 校验、其余才 mkdir。install-units 加 isDriveRoot 单测（含"推荐默认 C:/msys64 的 parent 必须被判为盘根"的反向断言）。

**Q4 USB/探针形态诊断（doctor 分级）。** 云服务器物理上没有 USB 口，与"没插板/线只供电/驱动异常/被占用"是四种完全不同的回答。新增 `diagnoseUsb(pnputilText)`（纯函数，四分类：no-usb / no-dap / driver-error / ok，另有 unknown 兜底）与 `usbDiagnosis(subprocess)`（跑只读 `pnputil /enum-devices /connected`，失败不阻塞）。**编码教训**：中文系统 pnputil 字段名是 GBK（"实例 ID" 读出来是乱码），任何依赖字段名的解析都会失效——最终只认行内 ASCII 本体（`USB\\VID_`、`USB\\ROOT_HUB`）。no-usb 判定进 blockers（它阻塞烧录且无解），no-dap/driver-error 进 notes，ok 也给一句"探针在线"。DoctorReport 与工具 outputSchema 新增 `usb` 字段，渲染加一行。doctor-regs-units +5 例。真机复验：本机（有 USB、无 CMSIS-DAP）正确报 no-dap 而不是 no-usb。

**测试。** cache-units 16 → 17（真守卫回归）、scaffold-patch-units 22 → 24（.gitignore 缺失两条路线各一例）、install-units 21 → 22（isDriveRoot）、doctor-regs-units 5 → 10（四分类 + 空文本）。**24 套件 318 pass / 0 fail**（CI 316 + 2 skipped）。

**发布顺序**：npm pack --dry-run 人工核对 → 版本 0.1.2（package.json + lock 两处 + 两 README 各两处）→ npm publish（盯 PUT 201/202）→ 模拟用户验收（删缓存 + 新 profile 装 tarball + register/hal 各建一次 + doctor 看 USB 话术）。

## 21. 阿里云实测后的五档清单：让"别人的机器"也能从零跑到烧录（2026-10-25）

**背景。** 用户在一台阿里云 Windows ECS（有 MSYS2、无 CubeMX、无 USB 口）上照 README 从零走了一遍，除了 §20 那三条 100% 复现的 P0，还提了五条：①发布形态没人验过——`npm pack` 出来的包里少了文件、`lib/client.js` 与 `client/client.js` 不同步，都要等用户装上才发现；②云服务器上 `stm32_doctor` 说不清"没有 USB 口"和"没插探针"的区别；③只有 `.elf`，想要 `hex` / `bin`，还希望工程自带 `openocd.cfg`；④烧录失败只有一句话，模型没法按类分支；⑤上游文件只靠 marker 判"像不像"，`master` 改一行照样落盘。

定案时明确了两条边界：**不做**自动装 CubeMX（GUI 向导 + ST 账号，装不了）；**不加**运行时依赖（zip 都自己写）。

### 21.1 钉死上游内容：模板每个文件带 sha256（0a）

marker 只能证明"拿回来的像这个文件"，证明不了"还是那一份"。上游 `master` 上把 `system_stm32f1xx.c` 改一行，marker 照样命中，落盘后要到编译期才炸，而缓存还会把坏文件长期留着。

- `src/engine/fetch.ts` 的 `FetchTarget` 加可选 `sha256`，`fetchOne` 的校验顺序是：HTTP 状态 → 体积下限 → HTML 嗅探（代理拦截页）→ marker → **sha256**；不匹配就换下一个候选源，全失败时报「sha256 对不上（期望 `abcd…`，实际 `ef01…`）多半是上游 master 挪动了内容」，并把实际值写进 attempts 方便核对。
- `src/data/cmsis-sources.ts` 新增四张表 `DEVICE_HEADER_SHA256` / `SYSTEM_C_SHA256` / `STARTUP_SHA256` / `CORE_HEADER_SHA256`，10 个下载目标全部接上。值是 2026-10-25 从本机缓存里的真实文件算出来的，关键五条：`stm32f1xx.h` `05e93fa3ddefb2e83d762b9ca4de36e3bba9cd8e9690400fe9f2c11fc0a3cef5`、`system_stm32f1xx.h` `a54dfbb3480c672f532d472a6e84bcf34df6551771d2e9966c5a3503c676b6ab`、`stm32f103xb.h` `d9c7c613d9fea74220892b4fbc3e80617493acad82a04bafadab2b4a7198399c`、`system_stm32f1xx.c` `8465bf3fe9057adecd8b4561403836d1fa2152d3cb088831623da3f91d86ec0a`、`startup_stm32f103xb.s` `a9a5fc7ed5ff617527dd98b3092830f4d17ed4bf57c99eac2c53bdb514ce138c`。
- **取舍**：上游一动，新机器就装不上（旧的还能从缓存复用）。仍然选"失败"而不是"照落"——落错文件的代价是半天编译报错的排查，而对不上的提示里直接给了两个哈希，用户（或我）能在 30 秒内判断是上游改了还是网络中间人。
- 测试注入点：`TemplateRequest.hashes` 与 `RegisterProjectRequest.hashes`（`src/engine/register-template.ts` 把它们映射到 targets 的 `sha256`），测试侧用 `contentHashes(override)` 按 `SAMPLE_PAYLOADS` 现算；`cache-units` 新增"哈希对不上必须拒绝并报两个哈希"。

### 21.2 pack-smoke：发布形态得由 CI 自己验（第 1 批）

`npm test` 跑的是仓库里的 `lib/`，永远发现不了"tarball 里少了 `templates/scaffold/openocd.cfg`"或"`lib/client.js` 没跟着 `client/client.js` 重新生成"。新增 `scripts/pack-smoke.mjs`：

1. `npm pack` 到临时目录；
2. `tar -xzf` 解开（Windows 上 `execFileSync` 必须带 `shell: true`，否则找不到 `tar`）；
3. 断言 16 个发布必须文件都在（含 `lib/client.js`、`templates/scaffold/openocd.cfg`——`openocd.cfg` 是 2c 新加的，漏打包会让新工程烧不了而单测全绿）；
4. 断言 `lib/client.js` 与 `client/client.js` 逐字节一致（否则说明忘了 `npm run build`）；
5. **用解包出来的 `lib/` 与 `templates/` 真建一次寄存器工程**，断言产物与模板计数。

`package.json` 加 `test:pack`，`.github/workflows/ci.yml` 在 `npm test` 之后单独一步跑它。不并进 `npm test` 的原因：它要跑 `npm pack`（慢），而且它验的是"发布形态"而不是"逻辑"，分开跑能一眼看出是哪种失败。

### 21.3 探针诊断下沉到烧录（2a）

云服务器上 `stm32_flash` 失败只会说「找不到 CMSIS-DAP 设备」，和"线只供电"、"驱动没装"、"口被占"混在一起。做法是把 §20 的 `usbDiagnosis` 复用出两层：

- `src/engine/doctor.ts` 的 `hasDap` 名单扩到 CMSIS-DAP / `VID_0D28` / `VID_0483`（ST-Link）/ `VID_C251` / `VID_1A86`（CH340 桥接板），另配 `usb vid_` 小写形态；
- `src/engine/flash.ts` 新增导出 `probeMissingLines(errors)`（从 openocd 日志里认出"找不到设备"那几行）与 `usbNoteFor(kind, detail)`（`unknown` 返回 `null`，不乱说话），`runFlash` 只在"确实没找到设备"时把 USB 形态追加进 `notes`。

### 21.4 hex/bin 与 openocd.cfg（2b / 2c）

- `stm32_build` 的 `BuildRequest.artifacts`（`elf` / `hex` / `bin` 的子集）与 `BuildReport.converted`（`{kind, path, size}[]`）。链接成功后用 `resolveToolIn(subprocess, ["arm-none-eabi-objcopy"], config.binDirs, signal)` 跑 `-O ihex` / `-O binary` 到 `.elf` 同目录；**转换失败只写 note，不判编译失败**——编译本身已经成功，`.elf` 仍然可用。不让用户自己 `objcopy` 的理由：门禁已经知道工具链在哪，而且失败时文案能说清"缺 objcopy"还是"路径写不进"。
- 新增 `templates/scaffold/openocd.cfg`（`source interface/cmsis-dap.cfg`、`transport select hla_swd`、`source target/stm32f1x.cfg`、`adapter speed 2000`），进 `SHARED_TEMPLATE_FILES`，两条路线都自带。2 MHz 是 F103 + CMSIS-DAP 上实测最稳的档位。
- 顺带把 `checkNoDebugGuard` 的降级路径做完整：工程里找不到唯一 `.ioc` 时，改看 `openocd.cfg` 的 `transport` —— `swd` 放行并说明"依据是 openocd.cfg"；`jtag` 提示 PA13/PA14 可能被复用；连 `transport` 都没有才继续报"守卫没生效"。计数断言随之 14 → 15（scaffold-patch）、6 → 7（cache-units）。

### 21.5 errorCode：让模型能按类分支（2d）

`stm32_flash` 新增 `FlashErrorCode`（`""` / `no-probe` / `probe-busy` / `swd-locked` / `flash-protected` / `no-power` / `target-mismatch` / `unknown`）与 `errorCodeOfLines(lines)`；成功时为空串，`FlashLogVerdict` 与 `FlashReport` 都带上它，工具 schema 用 enum 收口并在卡片里单独一行渲染。分类按 openocd 日志的**首个**命中判定（顺序敏感：先 `no-probe` 再 `probe-busy`，避免把"被占用"读成"没插"）。不把 `message` 直接给模型当分支依据——中文话术会改，错误码是契约。

### 21.6 `/stm32-setup`（第 3 批轻量版）

人已经决定要干活时，先体检再出计划比"先问他装不装"更顺手：命令一次跑完 `stm32_env_probe` + 安装计划；**命令里带「装」字**（例如 `/stm32-setup 装上缺的`）才真装，否则只回计划与下一句。真装仍然是 43 MB 下载 + 写注册表，不能靠一句 `/stm32-setup` 触发。命令数 6 → 7。

### 21.7 `stm32_project_export`：把工程交给别人（P1-4）

用户的原话是"云上建好的工程怎么拿回本地"。与其让他自己挑文件打包，不如给一个工具：

- `src/engine/project-export.ts`：`collectSources` 递归收集，`SKIP_DIRS` 固定跳过 `build/`、`.dsh-stm32/`、`node_modules/`、`.git/`；`includePrebuilt` 时把 `.elf` 一起带上；`readme` 默认在包里写一份开箱说明（内容用 `__inline__` 前缀表示"这是内联生成，不是文件"）；`outDir` 缺省落在工程同级的 `<name>-export.zip`。
- `src/engine/zip.ts`：**store-only 的最小 zip 写盘器**（CRC32 + DOS 时间 + 本地头 + 中央目录），外加 `listZipEntries(buffer)` 给测试验内容。为什么不加 `archiver` / `jszip`：这个仓库的承诺是零运行时依赖、`lib/` 入库、`npm i` 不用编译任何东西，为此引一棵依赖树不划算；我们的场景也不需要压缩比（源码 + 一个 `.elf`）。
- 报告字段：`ok` / `projectDir` / `zipPath` / `zipBytes` / `fileCount` / `prebuilt` / `durationMs` / `message` / `notes`；`message` 直接给"多少个文件、多大、要不要带 elf"。
- 测试（`test/export-units.test.mjs` 9 例）：空工程仍出合法 zip 且能被 `listZipEntries` 读回；`build/` 与 `.dsh-stm32/` 不进包；`includePrebuilt: true` 时 `.elf` 在包里、`false` 时不在；`readme: false` 不写 README；默认落点与 `outDir`；`zipBytes` 与磁盘文件大小一致；`fileCount` 与实际条目一致；CRC 能被独立实现验过。

### 21.8 计数与文档

本批新增 8 例（cache 17 → 19 的两条哈希、flash 8 → 13 的五条、doctor 10 → 11 的一条 CH340；`commands-units` 只改命令名单断言、不增例），加 export 9 例：**25 套件 335 pass / 0 fail**（CI 333 + 2 skipped）。README / README_EN 的用例数、套件数、工具数（19 → 20）、命令数（6 → 7）与新增小节一并同步；`package.json` / `package-lock.json` / 两个 README 的 badge 与"装完确认"行升到 0.1.2。

### 21.9 宿主级验证（2026-10-28，重启加载 0.1.2 后）

八项实测，全部通过（不碰板子的部分都跑了；碰板子的两条见 21.10）：

1. **计划只报缺件（§19 的回归）**：`stm32_env_install` 默认计划 → `steps: []`、`download.bytes: 0`、`verify.ok: true`、`notes: []`、`nextStep: ""`，全文只有「工具链完整，不需要装任何东西：5 个组件都能跑，PATH 与配置都已就位（D:/app/msys64/ucrt64/bin）。」
2. **`stm32_env_probe`**：四项能力全 `true`；gcc 13.3.0、gdb 16.2、openocd 0.12.0、cmake 3.31.5、ninja 1.12.1、`cubemx-java` OpenJDK 21.0.3；`cubemx` 的版本串是空的（路径在、版本没解析出来，记进 21.10）。
3. **`stm32_doctor`**：`ok: true`、`usb.kind: "no-dap"`（文案把「没插探针 / 线只供电 / BOOT0=1」分开说了）、`portBusy: false`、`processes: []`、`blockers: []`。
4. **2b hex/bin**：寄存器版工程（template 7 / drivers 10，缓存命中）→ 首次 `cmake --preset Debug` 21.9 s、编译 2.2 s、`elf` 431,012 B、RAM 7.7% / FLASH 1.16%；`converted` = `hex` 2,221 B + `bin` 760 B，落在 `build/Debug/` 里。
5. **0a sha256 真下载**：把 `%LOCALAPPDATA%\dsh-stm32\cache` 整个挪开 → `stm32_cache fetch` → 11 个文件 / 1,071,297 B 全部过校验并落盘；新缓存与挪开的旧缓存逐文件比对 `diffCount=0`。
6. **sha256 反向验证**：同一个 URL 故意喂 64 个 `0` 的哈希 → `ok: false`，attempts 原文「sha256 对不上（期望 0000000000000000…，实际 05e93fa3ddefb2e8…）。多半是上游 master 挪动了内容」；喂真值 → `ok: true`、10,110 B。说明这道门禁不是空转。
7. **export**：同一个寄存器工程 `includePrebuilt: true` → zip 1,522,918 B / 21 条，包内有 `prebuilt/{p1verify.elf,hex,bin}`、`README.md`、`openocd.cfg`、`.gitignore`，**没有** `build/`、没有 `.dsh-stm32/`；notes 写明 build 不进包的原因（CMakeCache 记着本机绝对路径）。
8. **2c + hal 路线**：hal 工程 template 15（比旧版多 `openocd.cfg`）、drivers 238、`firmwareRoot` = `D:\app\STM32CubeMX\dsh-firmware\STM32Cube_FW_F1_V1.8.8`；`.vscode/launch.json` 与 `settings.json` 剥注释后都 `JSON.parse` 成功、**占位符 0 个、`D:/JingYu` 0 次**，`armToolchainPath` / `gdbPath` 填的是本机探测到的 `D:/app/msys64/ucrt64/bin`；寄存器版工程没有 `.ioc` 时 `checkNoDebugGuard` 按 `openocd.cfg` 的 `transport=swd` 放行（`blocked=false`）并说明依据，不再静默通过。

**顺手记下的两个 API 事实**（下次写验证脚本别再踩）：`src/engine/zip.ts` 的 `listZipEntries(buffer)` 返回的是**文件名数组**（`string[]`），不是对象数组；在 `demo/` 下写脚本 import 插件的 `lib/` 必须用 `file:///` 绝对 URL，相对路径会 `ERR_MODULE_NOT_FOUND`。

**验证用的临时工程**（`.verify-p1/` 下的 reg、hal、zip 与三个脚本）与挪开的旧缓存都已进回收站，`demo/` 下 `.verify-*` / `.tmp-*` 为 0。

### 21.10 还没验证的

- `npm run test:pack` 只在开发机跑过，CI 上首跑要看 windows-latest 的 `tar` 行为（已按经验带 `shell: true`）；
- 2d 的 `errorCode` 已在真板上验过 `probe-busy`（见 §21.11）；`swd-locked` / `flash-protected` / `no-power` / `target-mismatch` 四种要制造锁片、写保护或拔电源，不能为了测试去毁板子，仍只有单测覆盖；
- `/stm32-setup`、`/stm32-build` 等斜杠命令的人工卡片：命令只能用户自己输入，工具层结论已由上面的 1–8 覆盖；
- `stm32_env_probe` 里 `cubemx` 的版本串为空是**设计如此**（`probe.ts` 的 cubemx 目标 `versionArgs: []`——启动器 exe 没有可用的 `--version`，版本靠 `cubemx-java` 那项）；卡片上 `OK  cubemx  <路径>` 正常显示，只有直接读 JSON 的 `version` 字段才是空串。验证时一度把它当缺陷，记在这里免得下次又查一遍；
- P2（多芯片 F0/F3/F4/G0/L4、HAL 外设源文件落位）未开工；P3（gdb MI 常驻）后来已在 §37 做完（此处是 10-28 的旧记录，保留原意以免误读时间线）。
### 21.11 上板验证（2026-10-28，蓝丸 F103C8T6 + CMSIS-DAP）

用户插上板子后补的第五~九项。**这一步抓出了两个只有真硬件才会暴露的缺陷**，单测当时全是绿的。

**跑通的部分**

- `stm32_doctor`：`usb.kind` 从 `no-dap` 变成 `ok`（「能看到 CMSIS-DAP 设备且驱动正常」），`processes: []`、`portBusy: false`。
- `stm32_flash` 烧 demo：`ok`、`programmed + verified`、2.5 s、`errorCode` 缺省；openocd 日志 `device id = 0x20036410`、`flash size = 64 KiB`、`clock speed 1000 kHz`（工程自带 `demo/openocd.cfg`）。
- 新建寄存器工程（`route=register`，`template 7 / drivers 10`，缓存命中）→ 构建 9.0 s configure + 2.5 s 编译、`regcheck.elf` 431,052 B、RAM 7.70% / FLASH 1.16% → `stm32_flash` 走模板 `openocd.cfg`（`transport swd` + `adapter speed 2000`，日志 `clock speed 2000 kHz`）成功，notes 第一条是「SWD 守卫（openocd.cfg 版）：transport 是 swd…」——2c 的两条路径（.ioc 与 openocd.cfg）都在真机上成立。
- `stm32_regs_read`：`pc=0x08000210`；`0x4001100C`(GPIOC_ODR)=`0x00000000`、`0x40011004`(GPIOC_CRH)=`0x44244444`、`0x40021018`(RCC_APB2ENR)=`0x00000035`、`0xE000ED04`=`0x00000000`，全 `ok`、`errors: []`。
- `stm32_debug_run`（`breakAt: main`）：`ok`、`hitBreakpoint`、`main () at Core/Src/main.c:67`、`pc=0x8000f58 sp=0x20004ff8 lr=0x80011ab`、backtrace 一条。

**缺陷 1：模板 `openocd.cfg` 写了 `hla_swd`（2c 的模板错了）**

寄存器工程第一次烧录，宿主直接拒收：`tool "stm32_flash" returned invalid output: "value.report.errorCode" is not a declared property`（这才是缺陷 2 暴露的入口）。手动跑 openocd 才看到真因：`Error: Debug adapter doesn't support 'hla_swd' transport`，位置正是模板的 `transport select hla_swd`。`hla_swd` 只有 st-link 系适配器支持，CMSIS-DAP 必须 `transport select swd`。

修法与回归：模板改 `transport select swd`（注释里写清为什么不能用 `hla_swd`），`test/flash-units.test.mjs` 加一条读模板文件的用例——断言 `/transport\s+select\s+swd\b/u` 命中、**生效行**不含 `hla_swd`（注释允许解释）、把这份配置写进临时目录后 `checkNoDebugGuard` 报 `blocked=false` 且 notes 含「transport 是 swd」。教训：模板类文件也要有「按真实消费者跑一遍」的断言，光断言文件存在不够。

**缺陷 2：`stm32_flash` 的 report schema 漏声明 `errorCode`（2d 在失败路径上不可用）**

`src/tools/flash.ts` 的 `reportSchema` 是 `additionalProperties: false`，但没写 `errorCode`。成功路径 `errorCode` 是空串、引擎按 `...(errorCode === "" ? {} : { errorCode })` 省略，所以永远不触发；**只要失败带码，宿主就判「工具返回了非法输出」，报告拿不到**。2d 加字段时只改了 `FlashReport` 类型与卡片渲染，没同步 schema，单测也只测了空目录早退（不带码）。

修法与回归：schema 补 `errorCode`（enum 收到 8 个码，不进 `required`）；`test/schema-guard.mjs` 加「失败报告带 errorCode 时仍符合 output schema」，用假 subprocess 返回 `exitCode 1` + `no-probe` 文本，断言 `report.errorCode === "no-probe"` 且过 schema 检查。教训：**新增可选字段必须同时进 schema**，而且要有一条「字段有值」的用例——只测缺省值等于没测。

**顺手补的分类：两个 openocd 抢同一个探针**

为了验 `probe-busy`，用 `Start-Process` 起一个常驻 openocd（`-f interface/cmsis-dap.cfg -c "transport select swd" -f target/stm32f1x.cfg -c init`，日志 `Listening on port 3333`）攥住探针，再调 `stm32_flash`。真实失败**不是**「设备忙」，而是两个进程交替收发：`CMSIS-DAP command mismatch. Sent 0x12 received 0x5`、`CMSIS-DAP command CMD_DISCONNECT failed`、满屏 `CMSIS-DAP transfer count mismatch: expected 5, got 1`、`Failed to write memory`、`clearing lockup after double fault`。原来的 `errorCodeOfLines` 一条都不认 → `unknown`。

修法：`errorCodeOfLines` 增加 `/cmsis-dap (transfer count mismatch|command mismatch)|cmsis-dap command cmd_\w+ failed|libusb_error_busy/` → `probe-busy`；新增 `HINT_BUSY` 并只在 `errorCode === "probe-busy"` 时进 notes（「先关掉调试会话或另一个 openocd，再烧一次」）。宿主级实测：`ok=false`、`exitCode=1`、`errorCode=probe-busy`、notes 就是 `HINT_BUSY`，工具正常返回；杀掉持锁进程后再烧 demo → `ok`、`programmed + verified`、3.1 s、`errorCode` 缺省。

另外记一个 PowerShell 坑：`Start-Process -ArgumentList` 不会替你加引号，`-c 'transport select swd'` 会被拆成两个参数，openocd 报 `Unexpected command line argument: select`；要写成 `-c '"transport select swd"'`。

**计数**：本批新增 3 例（flash 13 → 15 两条、schema-guard 23 → 24 一条）→ **25 套件 338 pass / 0 fail**（CI 336 + 2 skipped）；README / README_EN 的用例数与 CI 计数已同步。

**清理**：`demo/.verify-board/`（一次性寄存器工程）与 `%TEMP%` 下的持锁脚本、openocd 日志、重启脚本都进了回收站，计划任务 `dsh-restart-board` 已注销；`demo/` 下 `.verify-*` / `.tmp-*` 为 0。








## 22. 源码精读指南：把 2 万行拆成七站（2026-10-26）

新增 `docs/reading-guide.md`（约 695 行 / 4 万字符）。它不是 API 文档，而是「怎么读这份源码」的路线图：11 章、14 张 Mermaid 流程图，从宿主装配一路读到测试假件。

结构：0 心法（四层：L4 装配 / L3 tools 契约 / L2 engine 逻辑 / L1 data 事实表，加四条设计约定）→ 1 整体框架图 + 目录行数全景 → 2 七站阅读顺序（每站有行数、能回答的问题、建议时长）→ 3 入口层 → 4 tools 骨架与 20 工具表 → 5 engine 十个域逐文件表 → 6 data 六张事实表 → 7 十四条流程各配一张图 → 8 二十条不变量 → 9 测试三层 → 10 改东西动哪里 → 11 已知的坑。

**写文档时踩到的两件事**

1. **数字必须从磁盘重算，不能抄早先的清点。** 第一版的行数是从几轮前的一次 `grep` 清点里拿的，已经过时：engine 合计写成 11 994（实为 12 753）、`commands/register.ts` 386（实为 445）、`client/client.js` 674（实为 682）、`msys2-install.ts` 1808（实为 2038）、`types.ts` 164（实为 196）。最后用脚本按「读文件 → 按 `\n` 切 → 去掉末尾空行」重新统计，再把文档里所有 `文件名（数字）`、章节小计、目录合计、阅读站小计逐个对齐，并做了一次反向扫描（把每个「文件名 + 数字」对拿新表校验，剩 0 处不一致）。教训：文档里的数字要么别写，要么每次由产物重算——写死手抄值必然在下一批改动后变成假话。
2. **Mermaid 的标签一律用双引号包住。** 节点标签里出现括号、斜杠、方括号（`probeCache.set(key, {at})`、`missing[]`）时，不引号化会直接把图解析坏；状态图的行内标签里也尽量别用括号（本轮把 `turn/end（本轮输出结束）` 改成顿号版本）。

**顺手发现的一处杂物**

`templates/scaffold/build/` 里有 4 个文件、29 459 B 的构建残留（`.cmake/api/v1/query/client-vscode/query.json`、`CMakeFiles/CMakeConfigureLog.yaml`、`CMakeFiles/3.31.5/CMakeSystem.cmake`、`CMakeFiles/3.31.5/CompilerIdC/CMakeCCompilerId.c`）。全仓库 grep 不到任何 `scaffold/build` 引用，但 `package.json` 的 `files` 含 `templates`，会把它一起打进发行包。已写进指南 §11 待清，尚未删除（等用户确认）。

README 与 README_EN 的 docs 索引各加一行指向新文档。

## 23. 可视化：用 Archify 出两张可交互图（2026-10-28）

精读指南里原来只有 Mermaid。Mermaid 适合贴在 Markdown 里速览，但排版、配色、缩放和导出都不受控；这一节记的是用 Archify（`@tt-a1i/archify-dsh` 技能）把它升级成两张单文件 HTML 的过程与踩坑。

**产物**（已复制进仓库，随 `docs` 一起发布）

- `docs/diagrams/dsh-stm32-architecture.html`（约 787 KB）：17 个节点、1 个宿主进程边界、19 条连线、5 张卡片。主轴是「调用入口 → tools 层 → 门禁 → engine 五簇 → 子进程桥 → 外部程序（CubeMX / 工具链 / openocd+gdb / pacman）/ 上游仓库」，磁盘状态放卡片。
- `docs/diagrams/dsh-stm32-journey.html`（约 771 KB）：6 列 × 4 lane 的 workflow。列是时间（定路线 → 体检 → 建工程 → 生成 → 改码 → 编译 → 上板），lane 是「你与模型 / 契约层 / 门禁与失败分支（exception 配色）/ 外部程序与板子」。
- 两张都带「来源 N」角标：点开是 `path` + 行号，对着 `reading-guide.md` 第 5 章能直接跳到文件。

**生成命令**（本机没有 Chrome，用 Edge 冒充 Chromium 通过 browser-check）

```powershell
$env:ARCHIFY_CHROME="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
node "<skill>/bin/archify.mjs" finalize architecture `
  ".archify/architecture-dsh-stm32-overview-20261028-152823/candidate.json" `
  ".archify/architecture-dsh-stm32-overview-20261028-152823/dsh-stm32-architecture.html" `
  --quality showcase --repo-root "D:/JingYu/Desktop/c8t6_vscode_test/demo/dsh-stm32" --json
```

candidate JSON 放在工作区 `.archify/<type>-<slug>-<时间戳>/`，不进仓库；改完重新 finalize，再把 HTML 覆盖到 `docs/diagrams/`。

**踩到的六个坑**

1. **没有 Chrome 时 browser-check 直接 skipped**（`viewer/chrome-unavailable`，整体 exit 1）。本机只有 Edge，`ARCHIFY_CHROME` 指过去就能跑——Edge 是 Chromium 内核，CDP 检查全过。
2. **证据按 HEAD 的已提交字节校验，不认工作区**。`/nodes/N/sources/path` 必须在该 revision 存在：我第一次把 `install-guides.ts` 写成 `src/engine/…`（实际在 `src/data/…`），报 `repository-evidence/file-missing`。行号同理——0.1.2 尚未提交，凡是这一批新加的行都别写行号，只写 `path` 更稳。
3. **showcase 要求零警告**：`composition/viewport-height` 在普通检查里只是 warning，在 showcase deliver 里算失败。判据很具体——1440×900 视口下，画布要么高度 ≤ 785（宽 1218），要么横向铺到 ≥ 1414；我最初 6 条 lane 的 workflow 是 1218×912，被判超高，删掉一条 lane（6→5→4）才合格。
4. **`composition/desktop-readability` 卡字号**：画布越宽缩放越小，8px 源文字投到 930px 预算上必须 ≥ 6px。把节点宽度一口气加到 196 后 viewBox 变成 1511，投影只有 4.9px；退回 132–160 的混合宽度（viewBox 1218）才过。宽度和字号是一对矛盾，别只盯布局。
5. **workflow 的 lane/col 是硬网格**：`mainPath` 必须按列单调，`entry(col1) → route(col0)` 这种回退会报 `mainPath moves backward`；同一 lane 同一 col 只能放一个节点；`route: "straight"` 在跨 lane 的边上根本不可能满足（`workflow/route-preset-conflict`），同 lane 相邻列的边又容易撞 `ambiguous-corridor`（两条边共用一段通道 ≥ 8px）。最后是靠「把失败分支从图里挪进卡片、把 patch/build 放进同一 lane」收掉的。
6. **回执文件有归属校验**：artifact 变了以后旧的 `*.browser-check.json` 会被判 `viewer/evidence-path-conflict`（`ownership-artifact-mismatch`），不许覆盖。每轮改完 finalize 前，把旧回执改名（如 `stale-browser-check-*.json`）而不是删掉。

**经验**：Archify 的价值在「强制你把话说清楚」——节点要一句话、边要有方向、失败分支要么成节点要么进卡片。两次 finalize 卡住的都不是审美，而是「这条边到底谁指向谁」「这个失败到底属于哪个阶段」。写图的过程等于把 `reading-guide.md` 第 7 章又校对了一遍。

## 24. 第五批：选错 .elf、调试丢根因、安装包单源（F1–F4，2026-10-29）

用户点名的四个问题，顺序 F1 → F4（m00536）。F1/F2 修的是「已经在做对的事，但结果说错/做错」，F3 修的是「只在网络不好或国内访问时才暴露」，F4 是文档。

### 24.1 F1：`findElf` 会把旧固件当产物（P0）

旧规则是「构建目录同名优先」：`buildDir` 叫 `build/Debug` 时 `buildName = "Debug"`，而产物叫 `demo.elf`，两者**永不相等**，于是退化成 `readdir` 顺序——改过工程名（或换个 `project()` 重新生成）之后，中间产物和上一次的固件都在同一个 `build/` 里，谁排在前面就烧谁。这条路径被 **5 个调用点**共用：`src/engine/build.ts:414`（编译后报产物）、`flash.ts:210`（烧之前找 elf）、`debug.ts:402`、`doctor.ts:213`（体检报 elf 大小）、`project-export.ts:104`（导出 prebuilt），所以坏一次是五处一起坏。

新实现（`src/engine/build.ts:194-284`）：

- `readCmakeProjectName(buildDir)`：从 `CMakeCache.txt` 里读 `CMAKE_PROJECT_NAME:<TYPE>=<名字>`，读不到返回空串（没有缓存不影响出结果）。
- `elfCandidates(buildDir)`：列出全部 `.elf`，带 `size` / `mtimeMs`，按修改时间从新到旧排序；`readdir` 或 `stat` 抛错（刚被删、被独占）就跳过，不炸整条链路。
- `pickElf(buildDir)`：**先按 CMakeCache 里的工程名精确匹配 `<name>.elf`**（`byProjectName: true`，最权威）；匹配不到才退回"修改时间最新"（`byProjectName: false`）。
- `findElf(buildDir)`：对外的老签名不变，仍返回 `ElfInfo`，所以五个调用点一行都不用改。
- `elfSelectionNote(buildDir)`：构建目录里有 ≥2 个 `.elf` 时回一句人话（"用了 demo.elf（18:42:03，按 CMakeCache 的工程名选）；没动的 2 个：…"），只放 `notes`，只有一个 elf 时返回空串——不给报告加噪音。

**判据为什么不是「最新」而是 CMakeCache**：`mtime` 只能回答"谁最后被写"，回答不了"谁属于当前这套构建"。`stm32_generate` 重新生成、`cmake --preset` 换 preset、用户手动 `rename` 都能让旧固件比新固件更新；而 `CMakeCache.txt` 是 CMake 自己写的、和这套构建目录一一对应的事实。**先在事实层找答案，再退回启发式**，这条经验在 `buildDir` 检测、`findProjectConfig` 里都出现过。

### 24.2 F2：`stm32_debug_run` 失败只说"起不来"（P0）

旧代码在 `waitForListening` 超时后只做两件事：把日志 `tail(15)` 塞进 `openOcdLogTail`，message 写 "没调试：openocd 起不来"。真机上 adapter init 失败的那几行（`Error: unable to find CMSIS-DAP device`、`CMSIS-DAP command mismatch`）常被后 15 行的 `Info :` 挤出去，模型和用户都拿不到根因，而且**同一套分类逻辑在 `stm32_flash` 里已经有了**（`errorCodeOfLines` / `probeMissingLines` / `usbDiagnosis`），调试路径没接上。

修法（两条失败路径都覆盖）：

1. **openocd 起不来**（`src/engine/debug.ts:277-299`）：`errorCodeOfLines(lines)` 归类 → `debugHintFor(code)` 给一句下一步（`no-probe`→查线/驱动、`probe-busy`→关掉另一个 openocd、`swd-locked`→`monitor reset halt`/改 BOOT、`no-power`→查 3V3/GND）；只有 `no-probe` 且 `probeMissingLines` 命中时才多跑一次 `usbDiagnosis`（`usbNoteFor` 出人话，`ok` 时不打扰）；`firstProblemLine(lines)` 取第一条 `Error/unable to find/no device found/couldn't bind/cannot open/invalid` 进 `errors`，message 带 `（code）`。
2. **gdb 起来了但没收好**（`src/engine/debug.ts:351-362`）：`ok === false` 时同样算一次 `errorCode`，只在失败时附上（成功时报告里根本不出现这个字段）。
3. **日志尾巴换算法**（`keyLogTail(lines, 40)`，`debug.ts:192-203`）：先用 `/error|unable to find|no device found|adapter|cmsis-dap|listening|couldn't bind|jtag|cannot/i` 从尾部往前挑"有信息量"的行，挑不满 40 行再按尾部补齐，最后按原顺序拼回去。旧的 `tail(15)` 只保证"最后"，新的保证"最后 + 关键"。
4. 契约同步：`src/tools/debug.ts` 的 `reportSchema` 补 `errorCode`（8 个码的 enum，不进 `required`），`formatDebugReport` 在"固件："后加一行"错误码：";`test/schema-guard.mjs` 加一条"失败报告带 `errorCode` 时仍过 output schema + 卡片打印错误码"的用例（手搓报告对象，不跑 15 s 超时）。

**教训**：同一类失败在两个工具里各写一遍，就一定会有一边落队（`flash` 有 `errorCode` 时 `debug` 没有）。现在两者共用 `HINT_PROBE` / `HINT_BUSY` / `HINT_DP` / `errorCodeOfLines` / `probeMissingLines` / `usbDiagnosis`，改一处两边都变。

### 24.3 F3：MSYS2 安装包只有 GitHub 一个来源（P1）

**a) 候选链**（`resolveInstallerUrls(env)`，替换掉的旧名 `resolveInstallerUrl` 已不存在）：`MSYS2_INSTALLER_URL`（单源，给了就只试它）> `MSYS2_MIRROR`（给全 `.exe` 当完整地址，否则当目录拼两个文件名）> 四个国内镜像 × 两个文件名 > GitHub × 两个文件名，共 **10 个候选**，顺序就是"国内优先、GitHub 兜底"。**为什么每个源要试两个名字**：镜像只同步 `msys2-x86_64-latest.sfx.exe`，GitHub releases 只有 `msys2-base-x86_64-latest.sfx.exe`（实测 TUNA 上 `msys2-base-…` 是 404），钉死一个名字等于把一半源排除掉。

**b) pacman 也走国内镜像**（`preferMirrorServers(text, servers)` + `preferChinaMirrors(msys64)`）：MSYS2 自带的 `etc/pacman.d/mirrorlist.{msys,mingw}` 第一顺位是官方源，国内装 173 个包会慢到像卡死。安装成功后把国内镜像插到这两个文件**最前面**（`Server = https://mirrors.tuna.tsinghua.edu.cn/msys2/msys/$arch/` 这类），官方条目不删、只在缺失时插入（幂等），文件不存在就跳过。**已经有 MSYS2 的机器一个字都不改**——那是用户自己的配置。

**c) 断点续传 + 低速判死**（`src/engine/fetch.ts`，同步用于所有下载）：`streamOnce(url, part, startAt, …)` 带 `Range: bytes=N-` 流式写 `.part-<pid>-<seq>`；watchdog 每 `min(1000, max(100, stallMs/4))` ms 检查：超过 `stallMs`（默认 10 s）没有新字节，或窗口内平均速率 < `minBytesPerSec`（默认 1024），就 `slow = true` + `controller.abort()`，然后**从已落盘字节续一次**（`fetchOne` 里 `if (!streamed.ok && streamed.slow && streamed.bytes > 0 && !isCancelled())`）。`206` 才追加、`200` 一律截断重写（服务器无视 Range 时不能把两段拼起来）、`416` 直接判失败。**换源一定从零开始**（不同源的字节不保证是同一份，拼出来的 sha256 必然对不上）。安装包那边同一套逻辑用 curl 实现：`-C -` + `--speed-limit 1024 --speed-time 10`，退出码 28 单独写成"太慢（10 s 内不足 1 KB/s）"，退出码 33（服务器不支持 Range）去掉 `-C -` 重下一次。

**d) 缓存三道粗检**：① 命中缓存先 `cachedInstallerBytes`（MZ 魔数 + ≥ `MIN_INSTALLER_BYTES` = 40 MB 才算数）② 下载后查退出码/体量/MZ 头 ③ 解压后查 `<msys64>/usr/bin/bash.exe`，缺了就把坏缓存改名 `.broken`（不删，留证据）并让用户重跑。**为什么不能钉 sha256**：镜像与 GitHub 的文件名不同、字节数也不同（实测 TUNA/NJU/aliyun 43,117,824 B、GitHub 42,907,176 B，同步时点不同），跨源钉同一个哈希必然误杀。

**e) 顺序不变的部分**：CMSIS 头与 ST 固件包仍走原来的候选（raw.githubusercontent → jsdelivr → ghfast → …）。实测 codeload 4.2 s、jsdelivr 675 ms、raw 859 ms，换顺序省不下时间；真正的大头是 43 MB 安装包和 pacman 包体。

**测试**：`test/install-units.test.mjs` 27 例（新增候选链 / `preferMirrorServers` 幂等 / `preferChinaMirrors` 只动两个文件 / 1 KB 缓存不算数→10 个候选全试 / 已有 MSYS2 不改配置）、`test/cache-units.test.mjs` 22 例（新增"断在 1500 字节→`Range: bytes=1500-`→206 续传""服务器回 200 时截断重写""慢源试两次后换快源、不拼接"）。**A29 那条测试同时被改了**：它用 1 KB 假缓存来"跳过下载、在解压步取消"，`MIN_INSTALLER_BYTES` 一上就让缓存失效、取消点前移到下载步，解压步自然变 `skipped`——把假缓存改成 40 MB 的 `Buffer.alloc(40_000_002)` 才恢复原意。

### 24.4 F4：README 排错段补"连不上 GitHub"

现象：`dsh plugin add github:JingYu-er/dsh-stm32` 报 `ERR_PNPM_GIT_UNKNOWN_ERROR … connect ETIMEDOUT …:443`。这不是 pnpm 11 的 `allowBuilds` 拦截、不是签名问题、不是包坏了，而是**取包这一跳根本连不上 GitHub**——换个说法就没人再往 pnpm 身上查。

给了三条不再碰全局配置的路（README 中/英同一条）：① 走 npm registry（`add dsh-stm32`，已发布时最省事）② 进程级代理：只给本次命令设 `GIT_CONFIG_COUNT=1` / `GIT_CONFIG_KEY_0=http.https://github.com.proxy` / `GIT_CONFIG_VALUE_0=…`，不写 `git config --global`（那样会影响用户所有仓库）③ 直接吃 codeload 的 tarball。装最新用 `github:JingYu-er/dsh-stm32#main`，要稳定版用 `dsh-stm32@latest`。

### 24.5 计数与行数

`npm run build` exit 0；`npm test` → **24 套件 348 pass / 0 fail**（CI 346 + 2 skipped）。行数按"文件内 `\n` 个数"重算：src 65 个 `.ts` **20,758 行**、tools 19 文件 4,832、engine 36 文件 **13,328**（`fetch.ts` 197→**341**、`msys2-install.ts` 2038→**2313**）、data 6 文件 1,803、client 682；`reading-guide.md` 的合计与两处单文件数字、第 9 章用例数已同步。

**顺手记一个度量坑**：PowerShell 的 `(Get-Content x.ts).Count` 和 `Measure-Object -Line` 都**不等于**行数（前者受文件尾换行影响，后者忽略空行），`wc -l` 在 Git Bash 里对 CRLF 文件也会差一。本文档与 `reading-guide.md` 统一用 Node 读文件数 `\n`：`(text.match(/\n/g) ?? []).length`——示例：`index.ts` 是 119，`Get-Content` 给 108。

## 25. T1 / T2 验收：sha256 负向与 .ioc 事务链（2026-10-30）

发布前该验的三件（T1 sha256 负向、T2 .ioc 四步链、T3 真机）里，T1/T2 完全离线，先做掉；T3 卡在探针没识别（见 25.3）。

### 25.1 T1：sha256 门禁负向（6 例全过，抓到一个真缺陷）

用注入的 `fetchImpl` 走真 `fetchOne`（一次网络都不发）：正控（哈希对→落盘、字节一致、失败记录为空）；负控（哈希错→拒绝、消息里有「期望」与「实际」两个前缀和「重新实测」的提示、**不落盘**）；旧文件已存在时失败（旧文件原样不动，A15 语义）；多源（第一个源回代理登录页 html、第二个源哈希不符→`attempts` 两条各说各的）；`minBytes`（1 字节→「只有 1 字节（< 16）」）；模拟上游漂移（内容变了但声明哈希还是旧的→拦下并提示去更新 `cmsis-sources`）。

**抓到的缺陷**：四道校验（体量 / 网页 / markers / sha256）失败后只 `continue`，**没删 `.part` 半成品**。该路径在 `streamOnce` 内部有自己的清理，但校验发生在整个文件读完之后，`.part` 已经躺在缓存目录里——43 MB 的安装包、几十 MB 的模板，几次失败能攒出几百 MB 垃圾，而且它既不参与续传（换源一律从零）也不会被任何清理逻辑回收。

修法：`src/engine/fetch.ts` 的校验段加局部 `reject(reason)`（`attempts.push` + `removeQuietly(part)`），四道校验改用它再 `continue`；回归沉到 `test/cache-units.test.mjs` 的「fetchOne：校验失败（sha256 / markers / 体量 / 网页）时必须连 .part 半成品一起删掉（T1）」——四道校验各跑一遍，断言目标文件不存在、目录里没有 `.part-*`（22 → 23 例）。

### 25.2 T2：`.ioc` 事务链（7 例全过，用仓库自带 `templates/scaffold/demo.ioc`）

工具层走真注册（假 `ctx`：`tools.register` 收定义、`workingDirectory.ensure` 给临时目录、`subprocess` 一律抛错证明没起进程），工程是 `templates/scaffold/demo.ioc`（4 084 B，sha `a487d32b1d3b8818…`）复制到临时目录：

- `stm32_ioc_inspect`：`STM32F103C8T6` / `STM32Cube FW_F1 V1.8.7` / `SWD=Serial_Wire` / 8 个引脚 / 3 个外设，**不写盘**（sha 不变）。
- `stm32_ioc_plan`（加 `PA0` 输出、label `t2led`）：`planId` 10 位、`sourceSha256` 等于当前文件、`candidateSha256` 变了，diff **8 条**（`Mcu.Pin8`、`Mcu.PinsNb` 与 `PA0.GPIO_*` 五项），**不写盘**。
- `stm32_ioc_apply`：`shaBefore` = 原文件、`shaAfter` = 候选、备份落在 `.dsh-stm32/backups/<时间戳>-ioc/demo.ioc` 且与原文件逐字节一致；写完后反读 inspect 能看到 `PA1` / `t2btn`。
- `stm32_ioc_apply({rollbackFrom})`：`rolledBack=true`，文件**逐字节**回到原 sha。
- 两条守卫：plan 之后外部改过 `.ioc` → apply 拒写（消息里带两个 sha 与「请重新 plan」）、文件不动；缺 `planId` / 不存在的 `planId` → 给人话且不写盘。

脚本留在工作区 `.t1-t2/`（不进仓库、不进包）：它们的长期价值已经分别沉到 `test/cache-units.test.mjs`（T1）与既有的 `test/e2e-a8-ioc-rollback.mjs` + `test/ioc-plan-units.test.mjs`（T2），重复收进仓库只会养一批没人跑的脚本。

### 25.3 T3：真机项先挂起

`stm32_doctor` 报 `usb.kind = "no-dap"`（「有 USB 控制器但没看到常见探针（CMSIS-DAP / ST-Link / DAPLink / CH340）」），`processes: []`、`portBusy: false`。也就是说板子/探针当前没被识别：现在跑 `stm32_flash` / `stm32_regs_read` / `stm32_debug_run` 只会得到 `no-probe` 分支——那验证的是错误路径（2026-10-28 已验过），不是 T3 要的烧录 / 读寄存器 / 断点。插上后再跑。

### 25.4 计数

`npm run build` exit 0；`npm test` → **24 套件 348 pass / 0 fail**（CI 346 + 2 skipped）；`npm run test:pack` exit 0（16 个必须文件齐全）。README / README_EN / `reading-guide.md` 第 9 章的用例数已同步到 348 / 346。

## 26. 修掉老洞：`cmake/stm32cubemx/CMakeLists.txt` 从不跟着 .ioc 更新（2026-10-30）

### 26.1 洞是什么，怎么证实的

CubeMX 无头生成（`generate all_code_in_main` + `generate code`）只重写 `Core/` 下的代码，`cmake/stm32cubemx/CMakeLists.txt` 这份源清单它一个字都不碰——那是脚手架拷进来的快照。后果：`.ioc` 里新开了 USART1，CubeMX 会老老实实把 `HAL_UART_MODULE_ENABLED` 写进 `stm32f1xx_hal_conf.h`、把 `MX_USART1_UART_Init()` 写进 `main.c`，但源清单里没有 `stm32f1xx_hal_uart.c`，到链接阶段才炸 `undefined reference to HAL_UART_Init`，而错误信息完全指不到真正的原因。

证据（2026-10-30 实测）：`demo/cmake/stm32cubemx/CMakeLists.txt`（3 466 B，mtime 2026/10/21 17:55:36）与 `templates/scaffold/cmake/stm32cubemx/CMakeLists.txt` 逐字节相同，而 `demo/Core/Src/main.c` 的 mtime 是 2026/10/24 15:17:33——中间跑过生成，源清单没变过。模板里三个写死的点：`set(MX_Defines_Syms ... STM32F103xB)`、`set(MX_Application_Src ...)`、`set(STM32_Drivers_Src ...)`（只有 11 个 HAL 模块）。
### 26.2 修法：新增 `src/engine/cmake-sources.ts`（450 行）

- `deviceDefineFromStartup` / `familyTokensFromStartup`：从 `startup_stm32f103xb.s` 反推设备宏 `STM32F103xB` 与家族目录名 `STM32F1xx`（规则：upper 后把倒数第二个 X 换小写 x），不查表。
- `halModulesInUse`：模块清单以 `Core/Inc/stm32f1xx_hal_conf.h` 里 CubeMX 自己写的 `HAL_xxx_MODULE_ENABLED` 为准，再并上 `Core/Src/*.c`、`Core/Inc/*.h` 里显式 `#include "stm32f1xx_hal_xxx.h"` 的（兜住手写代码）。不能扫 hal_conf 里那一圈 `#include`：那里 33 个模块全列了一遍，只是被 `#ifdef` 包住。
- `collectCmakeSources`：算出启动文件、设备宏、模块清单、驱动源文件（顺序 = `system_stm32f1xx.c` → `stm32f1xx_hal.c` → 其余按模块名字母序，`_ex.c` 存在才带上）、应用源文件（`Core/Src/*.c` + 启动文件），缺 `.c` 的模块进 notes 而不是硬写。
- `refreshCubemxCmakeLists(projectDir, { dryRun })`：只改上面三个 managed 块，其余行原样；清单保留原顺序、摘掉磁盘上已不存在的条目、缺的追加到末尾（对用户工程 diff 最小）；内容一致时一个字节都不写。
- `describeRefresh`：一句话给 notes（「已是最新 / 已更新（新增 N 条）/ 未处理 —— 原因」）。
- 接线：`src/engine/generate.ts` 在两条返回路径上都调它——CubeMX 真跑完落位之后（dryRun 时只算不写），以及缓存命中直接复用产物时。只要经过 `stm32_generate`，源清单就会被对齐。
### 26.3 差分构建验证（真工具链，不是单测）

把 `demo` 复制一份（2 935 文件 / 261 914 598 B，排除 `build`、`.dsh-stm32` 等），在副本上做最小改动：

1. `Core/Inc/stm32f1xx_hal_conf.h` 打开 `HAL_UART_MODULE_ENABLED`，`main.c` 的 `USER CODE BEGIN 2` 里塞 `UART_HandleTypeDef huart1; huart1.Instance = USART1; (void)HAL_UART_Init(&huart1);`。
2. `cmake --preset Debug` + `cmake --build --preset Debug`（不刷新源清单）→ 复现老洞：`Core/Src/main.c:84:(.text.main+0x20): undefined reference to HAL_UART_Init`，`ninja: build stopped`。
3. 跑 `refreshCubemxCmakeLists` → `added = ["Drivers/STM32F1xx_HAL_Driver/Src/stm32f1xx_hal_uart.c"]`，`modules` 从 7 个变 8 个。
4. 重新 configure + build → `[21/21] Linking C executable demo.elf`，`demo.elf` 存在。

先失败、后成功，两遍都是真跑了 arm-none-eabi-gcc + ninja；这是「修复确实治好了那个症状」的唯一硬证据。副本与临时脚本用完丢回收站。

### 26.4 验证过程里又抓到两个真缺陷

- 注释里的 `#define` 被当成启用：真实 `stm32f1xx_hal_conf.h` 里没用到的模块写的是 `/*#define HAL_ADC_MODULE_ENABLED   */`，正则照样命中，于是第一次刷新把整个 HAL 的 30 多个 `.c` 全加进了清单（差分验证第 3 步一开始看到的是 30 条 added）。修法：匹配前先 `stripComments`（块注释 + 行注释），并补一条回归用例（三个注释形态 + 源码里被注释掉的 `#include` 都不算）。
- 行尾混排导致整文件重写：`demo` 这份文件的 86 行里 6 行 CRLF、80 行 LF，而 `readTextFile` 的 `eol` 是「含 CRLF 就算 CRLF」→ 内容一个字没改，写出来却是全文件翻成 CRLF；再加上「按行切完末尾多一个空串」没摘，每跑一次多一个空行，幂等直接断掉。修法：`dominantEol` 按多数行尾决定写回值、比较时只比内容不比行尾、切完 `pop()` 掉末尾空串。现在对真实 `demo` 跑 dryRun 报「已是最新」，字节不动。
### 26.5 测试与计数

新套件 `test/cmake-sources-units.test.mjs`（15 例）：设备宏/家族反推、启动文件排序、原样工程零写入、换芯片（startup + 设备宏一起换、旧 startup 从清单摘掉）、开 UART 只加真存在的 `hal_uart.c` 且第二次幂等、hal_conf 开着但驱动包缺 `.c` 时只进 notes、hal_conf 里那一圈 `#include` 不算用到、源码手写 `#include` 也算、ADC 连 `_ex` 一起加、删掉的驱动文件从清单摘除、dryRun 不写盘、非 CMake 布局/无启动文件 `ok=false`、注释掉的 `#define` 不算启用、CRLF/LF 混排零写入，以及一条接线回归（伪造 `cubemx/jre/bin/java.exe` + 缓存命中，`runGenerate` 在 `skipped=true` 时也必须把 `hal_uart.c` 写进清单）；`test/run-units.mjs` 已登记。

`npm run build` exit 0；`npm test` → **25 套件 363 pass / 0 fail**（CI 361 + 2 skipped）；`npm run test:pack` exit 0（16 个必须文件齐全、解包产物能建寄存器工程）。README / README_EN / `reading-guide.md` 第 9 章已同步到 363 / 361。
## 27. F1 全系第一步：src/data/stm32f1.ts（2026-10-30）

### 27.1 为什么先做这一层

扩 F1 全系的最小切口不是改工具，而是把「型号 → 启动文件 / 设备宏 / 容量」这条事实单独拎出来。原来这条映射散在 src/data/cmsis-sources.ts:105-123 的 startupChoiceFor（只认 STM32F103 加三个字母）和 src/data/chips.ts 的一张 C8T6 引脚表里。

### 27.2 数据来源（优先级）

1. 固件包 Drivers/CMSIS/Device/ST/STM32F1xx/Source/Templates/gcc 里真实存在的启动文件——实测 14 个：f100xb/xe、f101x6/xb/xe/xg、f102x6/xb、f103x6/xb/xe/xg、f105xc、f107xc。设备头在同级 Include/，14 个同名（没有 f106）。
2. 本机 CubeMX db/mcu/*.xml（Flash/RAM/引脚数，将来做校验用）。
3. 文件内置的容量字母表。
### 27.3 两个真坑（都是实测暴露的）

- 容量字母到容量档不是全局映射：字母 C 在 F103 上是 xE（startup_stm32f103xe.s），在 F105/F107 上却是 xC（startup_stm32f105xc.s）。第一版用全局表直接映射，STM32F107VCT6 被判成「没有 xe 这一档」而返回 null。修法：chooseGroup 先试「该 line 真有 x 加字母」，不行再退回全局表。
- F106 不存在：最初凭「F105/F106 共用」的旧笔记加了 code 106，结果对着固件包实测没有 startup_stm32f106xc.s，测试直接红。删掉该 line——宁可少一条，也不要编一个上游没有的文件。

### 27.4 接口与边界

resolveF1Chip(input) 支持三种输入：完整型号（STM32F103RCT6）、去掉温度后缀（STM32F103C8）、显式容量档（F103:xb）。返回 { chip, reason }：认不出时 chip=null 且 reason 是人话（「F107 没有 xb 这一容量档（上游真实档位：xc）」这种），绝不返回一个不存在的启动文件名。

RAM 表按「line:容量字母」而不是按容量档——xE 跨 C/D/E 三个字母，RAM 分别是 48/64/64 KiB；查不到就 ramBytes=null 并进 notes，不猜数字。
### 27.5 验证

test/stm32f1-units.test.mjs 11 例：C8T6 与既有事实一致、RCT6 走 xE、C/D/E 三字母 RAM 不同、F107 只有 xC、不存在的档位明确拒绝、未知 line 与坏格式与空输入与坏封装后缀都给原因、无温度后缀也认、F103:xb 与完整型号同解、6 条 line 的每个档位都能反推回启动文件名、RAM 未收录只给 note，以及「本机有固件包时，14 个组合的启动文件与设备头都真实存在」（CI 上自动 skip）。

npm run build exit 0；npm test 26 套件 374 pass / 0 fail（CI 372 + 2 skipped）。README / README_EN / reading-guide.md 第 9 章已同步。

## 28. F1 全系落地：HAL/寄存器两条路 + 时钟并入 .ioc 事务 + 薄表（2026-10-30）

§27 把「型号 → 启动文件 / 设备宏 / 容量」抽成了一张事实表，这一批把这张表接到三条链路上（HAL 建工程、寄存器建工程、.ioc 时钟事务），再加一层一致性护栏与一份全族薄表。四件事各自独立可回退，改动没有新开工具：时钟走的是既有的 `stm32_ioc_plan`，薄表是新脚本产出的数据文件。

### 28.1 t1：HAL 路线不再写死 C8T6（新增 src/engine/hal-chip.ts，284 行）

原来的 scaffold 把三个型号相关的文件写死在代码里：`startup_stm32f103xb.s`（拷哪个启动文件）、`STM32F103XX_FLASH.ld`（链接脚本）、`demo.ioc`（工程名与 MCU 字段）。这三处现在都改成**按芯片渲染**。

`src/engine/hal-chip.ts` 只有两件事：派生与渲染，全是字符串函数（不起进程、不写盘），所以能在**写盘之前**把整份产物渲染完——渲染失败时一个字节都不落盘，不会留下半截工程。

- `resolveHalChip(input)`：型号 → 启动文件 / 设备宏 / `.ld` 名 / 包名（复用 §27 的 `resolveF1Chip`，认完整型号、去温度后缀、`F103:xb`）。
- `renderStartupAndDefine`：`STM32F103RCT6 → startup_stm32f103xe.s + STM32F103xE`。
- `renderLinkerScript`：把模板的 MEMORY 两行（RAM / FLASH）与注释两行换成 `STM32F103RCTx_FLASH.ld`，256 KiB / 48 KiB。
- `renderIoc`：demo.ioc 的 `Mcu.CPN`、引脚与时钟键一起按型号重写。
- `pointLinkerFlagAt`：工具链文件里写死的 `-T STM32F103XX_FLASH.ld` 改成指向新名。**这一步不做就完蛋**——要么链到旧脚本（容量不对），要么命令行上出现两个 `-T`（链哪个看顺序）。

链接脚本从这一批起按 `<DeviceId>_FLASH.ld` 命名：

| 型号 | 启动文件 | 设备宏 | 链接脚本 | Flash / RAM |
| --- | --- | --- | --- | --- |
| STM32F103C8T6 | startup_stm32f103xb.s | STM32F103xB | STM32F103C8Tx_FLASH.ld | 64 / 20 KiB |
| STM32F103RCT6 | startup_stm32f103xe.s | STM32F103xE | STM32F103RCTx_FLASH.ld | 256 / 48 KiB |
| STM32F107VCT6 | startup_stm32f107xc.s | STM32F107xC | STM32F107VCTx_FLASH.ld | 256 / 64 KiB |

旧名 `templates/scaffold/STM32F103XX_FLASH.ld` 保留为 **C8T6 的兼容副本**（`templates/` 的文件数没变，scaffold 的文件数断言仍 15），但 cmake 的 `-T` 一律指向按型号命名的那份。

实测（真建工程）：RCT6 → `startup_stm32f103xe.s` / `STM32F103xE` / `STM32F103RCTx_FLASH.ld`（256 KiB、48 KiB）；F107VCT6 → `startup_stm32f107xc.s` / `STM32F107xC` / `STM32F107VCTx_FLASH.ld`（256 KiB、64 KiB）；C8T6 不回归（`templateFiles` 仍 15，链接脚本换成 `STM32F103C8Tx_FLASH.ld`）。

### 28.2 t2：寄存器路线泛化到 14 个容量档

`src/data/cmsis-sources.ts`（392 行）重写。三处要点：

1. `startupChoiceFor(mcu)` 不再自己认型号，改成委托 `resolveF1Chip`，并保留旧写法的兼容解析：`F1:B`、`F1:8`、`F103:xb`、`STM32F103C8T6` 四种输入同解。老工程里缓存过的条目 id（`F1:B` 那种）也能读。
2. `STARTUP_SHA256` 从 1 条变 14 条，**全部是真实下载后算的**（2026-10-30 UTC）。来源：`https://fastly.jsdelivr.net/gh/STMicroelectronics/cmsis-device-f1@master/Source/Templates/gcc/<startup>.s`，备用 `cdn.jsdelivr.net` / `raw.githubusercontent.com` / `ghproxy.net`。sha256 表里连文件字节数一起记，失败信息能直接告诉你「是上游挪了内容还是网络换了页面」。
3. 缓存条目 id 改成 `cmsis:F1:103xb`（族 + 容量档），`chipEntryId` / `parseCmsisEntryRef` / `cmsisEntryAliases` 三件套负责新旧 id 互认。

另两个新模块：

- `src/engine/register-clock.ts`（261 行）：寄存器版的时钟代码生成。每条 line 的最高 SYSCLK 不同——**F100 24 / F101 36 / F102 48 / F103·F105·F107 72 MHz**；HSE 8 MHz 乘到上限（F101 走 HSE/2×9 才凑得出 36 MHz）；FLASH latency 按频率给 0/1/2（F100 的设备头里没有 latency 字段，自动跳过）；APB1 在 >36 MHz 时 ÷2；HSE 起不来就退到 HSI/2×N 并写警告。生成的 `clock_init()` 插在 main() 第一行，末尾 `SystemCoreClockUpdate()` 让 SysTick 与 delay_ms 跟着对。
- `src/engine/register-linker.ts`（152 行）：按型号渲 `<DeviceId>_FLASH.ld`（改 MEMORY 的 RAM/FLASH 两行 + 注释两行）。F100/F101/F102 的 RAM 不在 §27 的表里，这里用 CubeMX db 的最小值兜底**并明确警告**——宁可报小，也不要让栈跑出真 RAM。

于是寄存器路线对 F1 的 14 个容量档全部可用，且**不需要 CubeMX、不需要固件包**，只靠下载缓存（第二次起完全离线）。

### 28.3 t3：时钟配置并入 stm32_ioc_plan（不新开工具）

为什么不做成 `stm32_clock_plan`：时钟改动本来就是改 .ioc 键，而 .ioc 只能走「plan → 用户确认 → apply」这一条事务。新开工具等于让用户可以绕过 SHA 校验直接写时钟。

新增两张：`src/data/clock-f1.ts`（215 行，事实：PLL 源 HSE 8 MHz / HSI÷2 4 MHz / HSI 8 MHz、×2..×16、上限 SYSCLK 72 / APB1 36 / APB2 72 / ADC 14 / USB 48、APB1/APB2/ADC 分频表、14 条外设→总线、UART 波特率档、20 个 RCC IPParameters）与 `src/engine/clock-plan.ts`（801 行，求解）。

求解顺序：枚举全部可行组合 → 取 `|sysclk − target|` 最小（**同距取更高档**，所以 60 MHz 的目标落在 64 MHz，而不是 56 MHz）→ 与 .ioc 现有键做 diff → 派生键**全量重算** → 给逐外设频率表、UART 波特率整除误差、备选档位。

`mode` 四态：`snapshot`（只看不写，未请求时钟时的缺省）/ `nearest`（就近）/ `explicit`（钉死倍频）/ `none`。任何早退分支都必须带 `clockPlan`（`IocPlanReport.clockPlan` 是必填字段，不是 `null`），这样报告形状统一、schema 不用多态。

实测（真实 `test/fixtures/project/demo.ioc`，`clock: { targetHz: 60000000 }`，dry plan 未 apply）：

- planId `b4f83c6165de72f7`，17 个键变化（新增 1、删除 0、修改 16）；
- 结论：目标 60 MHz **不可达**，已选 64 MHz（差 +4 MHz）。F1 的 PLL 只能整数倍频（×2..×16），HSE 8 MHz 拼不出这一档；HSI÷2 4 MHz ×15 正好 60 MHz，但 HSI 精度 ±1% 会把 UART 一起带漂，所以默认没选它（备选里能看到）；
- 总线：SYSCLK 64 / HCLK 64 / APB1 32（÷2，定时器 64）/ APB2 64（÷1）/ ADC 10.667 MHz（÷6，.ioc 里写成 10666667）/ USB 不可用；
- 逐外设：USART1@64、SPI1@64、TIM1@64、ADC1/2@10.667；USART2/3@32、SPI2@32、I2C1/2@32、TIM2/3/4@64；
- 波特率误差（16 倍过采样）：USART1@64 MHz 最差 115200 −0.080%，USART2@32 MHz 最差 57600 −0.080%；
- 写入 21 个 RCC 键（含 `RCC.IPParameters` 合并），源 .ioc 未被修改（`ok=true` 但 dry）。

错误路径是硬的：SYSCLK >72 / APB1 >36 / ADC >14 时**一个键都不写**，只报错并给最近可行档位。

### 28.4 t4：doctor 五项一致性 + 引脚表从本机 db 派生

`src/engine/doctor.ts`（665 行，+382）加了 `checkChipConsistency` / `collectChipConsistency`，比原计划的四项多拆一项：

1. 芯片型号 ↔ 启动文件名（例：RCT6 却只有 `startup_stm32f103xb.s` → blocker，并写出该有的名字）；
2. 启动文件 ↔ cmake 设备宏（`STM32F103xB` 配 xE 启动文件 → blocker，提示重跑 `stm32_generate`）；
3. `.ld` 的 MEMORY ↔ 芯片实际容量（小于芯片 → note「浪费了 N KiB」；大于 → blocker，RAM 同理）；
4. `.elf` 的 Flash 占用 ↔ Flash 容量（超了 → blocker，≥90% → note）；
5. .ioc 用到的引脚是否在封装里（本机 db 有封装表时才算）。

第四项踩了个真坑：**别用 .elf 文件大小判超 Flash**。工作区里那个正经 C8T6 工程，`.elf` 有 641.5 KiB——全是 `-g3` 的调试信息，按文件大小判会把 64 KiB 的芯片判成超容量。改成读 ELF program header，只累加 `p_paddr` 落在 `0x08000000` 起 1 MiB 的 `PT_LOAD` 的 `p_filesz`，同一工程立刻变成 0 blocker。解析不出 program header 时才退回文件大小，并在 notes 里注明「按文件大小粗算」。

`src/data/chips.ts`（202 行，+162；内置表 2026-10-31 已删，见 §28.9）：保留原 `CHIPS` / `findChip` / `isKnownPin` 的语义（未知型号一律放行，不猜、不误拦），新增 `parseMcuDbXmlPins`（`<Pin Name= Position=>`，`Position<=0` 的虚拟脚丢弃，`PC13-TAMPER-RTC → PC13`，电源脚不算）、`findMcuDbDir`（`<CubeMX>/db/mcu`）、`readMcuDbPins`、`deriveChipPinTable({cpn, mcuName, dbMcuDir})` → `kind: db / builtin / unknown`：db 命中就注明来源 XML 与引脚数，否则明说「未与本机 db 校验」，都没有就说明未知引脚一律放行。

### 28.5 包体三分法与护栏

这一批开始往仓库里加东西（薄表、图、脚本），先把「什么东西放哪」定下来，否则包体迟早失控：

| 类别 | 内容 | 实测 |
| --- | --- | --- |
| 随 npm 包 | `lib/**`（含 `lib/client.js`）、`client/client.js`、`templates/scaffold/**`、`cordis.patch.yml`、两份 README、LICENSE、`docs/*.md` | tarball 525.7 KB / 99 个文件，解包 1538.3 KB，templates/** 38.5 KB |
| 进 git 不进包 | `src/**`、`test/**`、`scripts/**`、`docs/diagrams/**` | diagrams 2 MB 原始 / 891 KB gz；`package.json` 的 files 从 `docs` 收窄成 `docs/*.md` |
| 远端按需下载 | CMSIS 设备头 / 启动文件 / 内核头、HAL 固件包 | 带 sha256 校验，缓存在本机 |
| 现造 | `.ioc` 内容（`renderIoc`）、`.ld` MEMORY（`renderLinkerScript`）、cmake 源清单（`refreshCubemxCmakeLists`） | 不进包，按型号生成 |

护栏是 `scripts/pack-size.mjs`（80 行，`npm run test:size`，CI 在 `test:pack` 之后跑）：tarball ≤1.2 MB、`templates/**` 里的**运行时资产**（`.ioc/.xml/.ld/.json/.cfg/.svd/.csv`）≤40 KB（2026-11-01 改口径：`.md` 文档与 C/CMake 源码不算资产，另设单文件 24 KB 上限）、包内禁止 png/jpg/jpeg/gif/webp/bmp/pdf/html/zip/7z/exe/dll、必须含 README.md / README_EN.md / LICENSE / cordis.patch.yml / docs/reading-guide.md。它用 `npm pack --dry-run --json` 拿文件清单，不写盘。

### 28.6 芯片薄表：scripts/gen-chip-table.mjs（371 行）——**2026-10-31 已整体删除，见 §28.9**

目标是一份「不联网、不依赖 CubeMX 运行时」的芯片事实表，供将来扩族时查容量与封装，也方便人肉核对。

- 来源：本机 CubeMX 的 `db/mcu/*.xml`（2019 个 xml，其中 `compatibility.xml` / `families.xml` / `rules.xml` 不是 MCU，真正 2016 颗；F1 系 58 个）。
- XML 里**没有 CPN 字段**，只有 `RefName` 模式（`STM32F103C(8-B)Tx` 这种带备选字母的写法），文件名 = `Mcu.Name` = `.ioc` 里的 join key，CPN 由 RefName 展开派生。
- 输出 `src/data/chip-table.json`：2016 行、157546 字节（gz 后约 10 KB），字段为 CPN / 内核 / 主频 / RAM / Flash / 电压 / 引脚数。文件头写明「脚本生成，不要手改」，并注明插件当前只消费 F1 那一段、其余为将来扩族备查。
- `--check` 模式：重新从 db 抽一遍，与已落盘的文件比对，不一致就 exit 1（给 CI 用）。
- 安装位置不必手填：`--mcu-dir` > `--cube-mx-root` > `STM32_CUBEMX_ROOT` > `~/.dsh-stm32/config.json` 的 `cubeMxRoot` > 默认位置 > 扫盘发现（本机 CubeMX 装在 `D:/app/STM32CubeMX`，就是靠扫盘找到的——只扫目录、不读注册表，扫不到就让人用 `--cube-mx-root` 指过来）。
- 读不到 db（没装 CubeMX / 路径不对）时**明确报错退出，不写半截文件**（先写临时文件再 rename，校验通过才替换）。

### 28.7 文档口径

README / README_EN / `docs/reading-guide.md` / `src/skill/stm32-workflow.ts` 里「只支持 STM32F103C8T6」的说法全部改口成 **F1 全系**（F100/101/102/103/105/107），并补了两件最容易漏的事：

- **链接脚本命名规则**：`<DeviceId>_FLASH.ld`（`STM32F103C8Tx_FLASH.ld` / `STM32F103RCTx_FLASH.ld` / `STM32F107VCTx_FLASH.ld`），旧名 `STM32F103XX_FLASH.ld` 只是 C8T6 的兼容副本；命令行上只能有一个 `-T`。
- **时钟就近策略**：目标频率不可达时选最接近的一档并**显式标注差多少**（60 MHz → 「不可达，已选 64 MHz（+4 MHz）」），同距取更高档；派生键全量重算；超限一个键都不写。

skill 的 R2 现在点名「本型号的启动文件 + 本型号的 `.ld`」，R3 补了时钟走同一条事务，`§四 踩过的坑` 加了两条：裸 `cmake -S . -B build` 不读 `CMakePresets.json` 会丢工具链文件（必须 `cmake --preset default` 或显式 `-DCMAKE_TOOLCHAIN_FILE`）；换芯片后别留旧链接脚本名（`-T` 两个 .ld 时链哪个看顺序，症状是「编译过、上板跑飞」）。

### 28.8 验证

- `npm run build` → exit 0。
- `npm test` → **29 套件 418 pass / 0 fail**（CI 上 416 pass + 2 skipped）；本批新登记 `hal-route-units`（12 例）、`clock-units`（14 例）、`doctor-chip-units`（15 例），既有套件未回归。
- `node scripts/gen-chip-table.mjs --check` → exit 0（生成物与 db 一致）。
- `npm run test:size` → exit 0（tarball 525.7 KB / 上限 1171.9 KB，templates 38.5 KB；当时的上限是 templates 总量 60 KB，2026-11-01 改成「运行时资产 ≤40 KB」，见 §46.4）。

注：§27.5 里的「26 套件 374 例」是当时的数，现在是 29 套件 418 例（captain 口径里的 28 个套件少算了 `schema-guard`）；§27.3 的坑、§27.4 的接口都还成立，只是 `startupChoiceFor` 现在委托给 `resolveF1Chip` 了。

### 28.9 2026-10-31：删掉全部内置芯片表，设备事实只从资源包缓存读

用户原话：「**内置表删了吧**」。这一批把插件里三张手写/生成的事实表全部清掉，改成「资源仓库出事实、插件只读本地缓存」：

- **删文件**：`src/data/chip-table.json`（2016 颗薄表，157 KB）、`src/data/f1-ram.generated.ts`（RAM 反查表）、`scripts/gen-chip-table.mjs`（371 行）。脚本**直接删**而不是保留：生成 CPN 的逻辑已经搬到资源仓库的 `scripts/build-assets.mjs`，插件侧再留一份生成器就等于留两条事实来源。
- **新增读取层** `src/data/device-facts.ts`：唯一事实来源是 `~/.dsh-stm32/assets/<版本>/device/f1/chips.json`（版本取本地已装最新一版；`DSH_STM32_ASSETS` 可换根目录），按 path+size+mtime 内存缓存一次。`loadDeviceFacts()` / `findChipFact(cpn)`（缺失返回 null）/ `requireChipFact(cpn)`（抛 `DeviceFactError`，code = `facts-missing` / `chip-unknown`）/ `deviceFactsSource()`（缓存路径或 `"none"`）。没有缓存时不抛、不猜，把「先跑 stm32_assets refresh，或检查网络」原样交上去。
- **`src/data/stm32f1.ts`**：删 `F1_LINES` / `GROUP_BY_LETTER` / `FLASH_BY_LETTER` / `RAM_BY_LINE_LETTER` / `PINS_BY_PACKAGE` 与 `f1-ram.generated` 的 import；`resolveF1Chip` 的签名与 `F1Chip` 结构不变，改为「解析写法 → 查 device facts」；`f1GroupsFor(code)` 从事实聚合。错误分四类，都带 refresh 提示。
- **`src/data/cmsis-sources.ts`**：`F1:B` / `F1:8` 这类只给容量字母的老写法，原来的「字母 → 档位」常量表已删，改成从事实里挑一颗同档芯片当代表（优先 F103），没缓存就返回 null。
- **`src/data/chips.ts`**：删 `CHIPS` / `KNOWN_CHIPS` / `findChip` / `ChipInfo`。`isKnownPin(pin)` 改成单参、只查**引脚名合法性**（`PA0..PG15`、`VP_*`；`PA0-WKUP` / `PC13-TAMPER-RTC` 先归一化）。没有拿 `pinCount` 去猜封装引脚——那等于又造一张表；引脚存在性只认本机 CubeMX db（`deriveChipPinTable` 的 `kind` 从 `db / builtin / unknown` 收窄成 `db / unknown`，没有 db 就明说「引脚存在性不校验」）。
- **首次使用自动 refresh**：`src/engine/assets.ts` 新增 `ensureAssets({profile:'core'})` —— 缓存命中（已装版本里有 `device/f1/chips.json`）直接返回 `status: "cache"`，否则走 `fetchManifest` + `verifyAndInstall` 自动装一次（`status: "refreshed"`），失败 `status: "missing"` 并带 refresh 文案。接进 `stm32_project_create`（**硬失败**，结构化错误）、`stm32_doctor` / `stm32_ioc_plan` / `stm32_cache` 的 fetch（**软提示**，其余检查照跑）；`stm32_generate` / `stm32_ioc_inspect` / `stm32_ioc_apply` / `stm32_route_plan` 本来不读芯片事实，**故意不接**（接了只会让不相关的工具因为没网而失败）。
- **测试**：新增夹具 `test/fixtures/assets/2026.10.31-1/`（20 颗真实 CPN + `manifest.json` + `install.json`，值从资源包原样抽，测试不联网）；`stm32f1-units` 重写成「事实从哪来 / 缺缓存怎么报」，`doctor-chip-units` 的 builtin 用例改成 `kind: unknown` + 空引脚，`assets-units` 的「内置表兜底」断言全部改口径。`test/run-units.mjs` 未动（captain 统一登记）。
- **验证**：`npm run build` exit 0；`npm test` → **31 套件 442 pass / 0 fail**；资源包版本 `2026.10.31-1`（`chips.json` 83 颗 = F1 全部 CPN；任务书里的「58 颗」是 CubeMX `db/mcu` 的 XML 分组数，不是 CPN 数）。
- **偏差备案**：任务书要求 `stm32_generate` / `stm32_ioc_*` 也 `await ensureAssets`，实际只接了 `stm32_ioc_plan`（软提示）；其余不读芯片事实的工具按上面的理由不接，避免把「没网」变成无关工具的硬失败。

## 29. B 阶段：结构化探针错误 + 会话复用快路径 + 断点预算（2026-10-31）

这一批只做三件事，都是「工具已经能用、但在真机上还硌手」的地方：**故障说清楚（B2）**、**连读不要每次重起 openocd（B3）**、**断点别等 openocd 起来才说不够（B4）**。三件都在 engine 层新增一个模块，工具层只负责声明 schema 与渲染。

### 29.1 B2：一套字段取代 errorCode —— 只留 `probeError`

旧形态是一枚枚举 `errorCode`（`no-probe` / `probe-busy` / `swd-locked` / `flash-protected` / `no-power` / `target-mismatch` / `unknown`），只回答「哪一类」，不回答「为什么」和「下一步做什么」。用户看到 `swd-locked` 还是不知道要按住 BOOT0 还是查复位时序。现在换成结构化对象：

```ts
interface ProbeError {
  kind: ProbeErrorKind;   // 8 类
  cause: string;          // 一句话根因（来自真实日志行）
  hint: string;           // 可执行的下一步，每类都有专属文案
  evidence: string[];     // 原始日志行，便于复核
  retryable: boolean;     // 照 hint 处理完再调一次同一个工具，有没有意义
}
```

**为什么是「直接替换」而不是加兼容别名**（这是本批唯一的取舍点）：

- 两个字段并存，等于两份规则。flash 与 debug 本来就各有一份分类代码（`errorCodeOfLines` + `debugHintFor`），再加一层旧字段只会让漂移更难发现。
- 宿主侧 `output.schema` 是硬的（report 上 `additionalProperties: false`）。多留一个字段就要在 schema 里多声明一次、在 `schema-guard` 里多守一次；而 `errorCode` 这种「只有失败时才有」的可选字段已经在 0.1.2 出过一次事故（失败路径被判非法输出）。
- 本插件的版本号还在 0.1.x、外部消费者为零（README 里就是这么写的），没有「老字段要留着不破坏兼容」的义务。既然要改，就改干净。

具体落点：

- `src/engine/probe-error.ts`（257 行，新）：`ProbeErrorKind` 8 类（多了 `timeout`）、运行期枚举 `PROBE_ERROR_KINDS`、`classifyProbeFailure({lines, exitCode, stage, timedOut, spawnError})` —— 判定顺序是 **MATCHERS 首个命中 → timedOut（timeout） → spawnError（unknown 但带 cause） → unknown**，所以 MATCHERS 数组的**顺序是敏感的**（`no-probe` 必须排在 `probe-busy` 前面，否则 `no device found` 会被 `cmsis-dap command cmd_\w+ failed` 抢走）。hint 常量八条只此一份；`firstProblemLine` / `probeMissingLines` / `usbNoteFor` 从 flash.ts 迁来；`formatProbeError` 出「错误：<kind> — <cause>；建议：<hint>」；`PROBE_ERROR_SCHEMA` 五个字段全 required、`additionalProperties: false`。
- `retryable` 的判据只有一条：**照 hint 处理完再调一次同一个工具，有没有意义**。因此 `flash-protected`（要解 RDP / 全片擦除）与 `target-mismatch`（芯片型号根本不对）是 `false`，其余六类 `true`。
- `src/engine/flash.ts` / `src/engine/debug.ts`：字段从 `errorCode` 换成 `probeError: ProbeError | null`。**解析层不再归类**（`parseFlashLog` 只回答 programmed / verified / errors / noise），分类在 `runFlash` / `runDebugRun` 里各调一次 `classifyProbeFailure`，两条路径同一个函数、同一组 kind。
- `src/tools/flash.ts` / `src/tools/debug.ts`：schema 里 `errorCode` 删除、加 `probeError: PROBE_ERROR_SCHEMA`；卡片行改成「错误：<kind> — <cause>；建议：<hint>」；新增 `flashReportForHost` / `debugReportForHost` —— 引擎在成功路径给的是 `null`，而宿主 schema 不接受 `null`，必须在工具层把 null 摘掉，「成功时字段不出现」才真的成立。
- 测试：`test/probe-error-units.test.mjs`（23 例）覆盖 8 类 kind、判定顺序、每条 hint、retryable 表；`schema-guard` 里两条 `errorCode` 用例改成 `probeError` 并断言成功路径的 null 被摘掉；`flash-units` 同步到新 API。

**四类真机故障的专属 hint**（本批要求写死的四条）：

| kind | cause 形态 | hint 指向的动作 |
| --- | --- | --- |
| `swd-locked` | `Error connecting DP` / `cannot read IDR` / `AP lock` | 按 BOOT0 上电进系统存储器启动、复位时序里先释放 NRST 再连；确认 PA13/PA14 没被固件改成 GPIO |
| `flash-protected` | `flash programming` / `write protected` / `read protected` | 先 `openocd -c "stm32f1x unlock 0"` 解 RDP，或全片擦除后再烧；只擦扇区不够 |
| `no-power` | `target voltage may be too low` / `no power` | 查 3V3 / GND、BOOT 跳线、是否只接了 SWD 没共地；量一下目标板电压 |
| `target-mismatch` | `device id` / `cannot identify` / `unexpected idcode` | 目标芯片与 `target/stm32f1x.cfg` 不符；换对应族的 target cfg，或确认买到的不是国产兼容片 |

这四条的 hint 与 kind 都进了单测，但**只有单测没有真机**（真故障不好造，见 §11 的坑 4）——这也是为什么 hint 写得像「操作清单」而不是一句安慰话。

**历史段落的读法**：本文件 §21（2d）与 §24.2（F2 缺陷）里出现的 `errorCode`、`FlashErrorCode`、`errorCodeOfLines`、`debugHintFor` 都是**当时的字段名与函数名**，原样保留（改历史记录等于篡改当时的验收口径）。从 §29 起，字段只有 `probeError`，函数只有 `classifyProbeFailure`；读旧段落时按这个映射翻译即可。

### 29.2 B3：会话复用快路径 —— 1493 ms → 15 ms

痛点：烧完看寄存器，「连读十次看计数器有没有在翻」是标准动作，而每次 `stm32_regs_read` 都**新起一个 openocd、读完关掉**，一次约 1.5 s（旧的一次性路径实测 1493 ms/次；另一次在 WCH-Link 上量到 7010 ms）。

做法不是「把 gdb 跑快一点」，而是**绕开 gdb**：openocd 启动日志里会打 `Listening on port`（gdb server 与 tcl 两个端口）：`debug-session.ts` 新增 `parseListeningPorts` 解析出 `{gdb, tcl, telnet}`，并在 `TCL_PORT_SETTLE_MS = 120` 之后拿**完整启动缓冲**再解析一次（端口行还没打出来就解析会拿到 0），结果存进 `session.tclPort`。新模块 `src/engine/probe-session.ts`（365 行）只消费这个端口：在**一条 TCP 连接**上依次发 halt → `reg pc` → `mdw`×N → resume，帧用 `0x1a`（`TCL_FRAME`）分隔，帧齐立刻收尾（`readWordsViaSession`）。tcl 端口没拿到、或 RPC 出错，就回退到会话里的 gdb 读，并把「为什么回退」写进 notes。

复用的边界（**只有两个工具复用**）：

- `stm32_regs_read`：`ensureSession` → 有会话就借、没有就起一个并保留到 90 s 空闲租约；报告新增 `reusedSession` 与 `durationMs`；借用已有会话时 `configFile` / `adapterSpeed` 不生效（openocd 是会话里那个），notes 会明说并提示「先 stm32_debug_stop」。
- `stm32_debug_eval`：本来就连会话端口上的 gdb，不会起第二个 openocd；**没有会话时明确报「没有调试会话」，而不是自己起一个**。
- `stm32_debug_run`：保持一次性（快照工具，跑完就还探针）。
- `stm32_flash`：不碰会话（烧录要先独占探针）。
- 会话的唯一真相仍是 `debug-session.ts` 的 `debugSessions` 单例——`probe-session.ts` 不自己存句柄、不自己算租约；并发靠模块级 starting Promise 去重（同时两次调用只起一个进程）；端口被占**直接报 `probe-busy`**，不让 openocd 顺延端口去抢探针（顺延就是「两个 openocd 抢一个 CMSIS-DAP」的经典翻车姿势）。
- 释放四条路都通：turn/end（`src/index.ts` 既有 stop）、90 s 空闲（`sweepExpired`）、`stm32_debug_stop`（`debugSessions.stop`）、进程退出（`process.once('exit')` 里 `terminateSync()` 尽力清理）。

数字（假探针实测：假 subprocess + 本地假 Tcl 服务端，量的是新代码路径本身）：旧一次性路径 **1493 ms/次**；新路径起会话 **790 ms**（第一次调用含启动），之后 10 连读单次 **13–18 ms**（`[16,14,15,18,13,15,16,15,16,15]`）、总计 **154 ms**、openocd 进程数 **1**。

**真机计时这一条没达成**，如实记在这里：当时插的探针是 WCH-Link（`USB\VID_C251&PID_F001`），openocd 0.12 一 init 就报 `Error: CMSIS-DAP command CMD_INFO failed.`，hid / bulk 后端与 `adapter speed 1000` 都试过；用仓库里 B3 之前的旧版工具跑同一次读，报的也是同一句（那次一次性 openocd 耗 7010 ms）。所以这不是本次改动引入的故障，而是探针/固件不兼容。**复测方法**：换回 CMSIS-DAP 探针，跑 `stm32_regs_read` 连读 10 次 `0x4001100C`，看报告里的 `durationMs` 与 `reusedSession`。

### 29.3 B4：断点预算 6 / 4 —— 在碰探针之前就报

Cortex-M3（F1）的硬件断点靠 FPB 的 6 个比较器、观察点靠 DWT 的 4 个。以前设第 7 个断点，要等 openocd 起来、gdb 跑完 `break` 才报错，白占一次探针（还会把你正开着的调试会话顶掉）。

`src/engine/breakpoints.ts`（281 行，新）把这个上限做成预算：`BreakpointBudget{code, data}`、`F1_BREAKPOINT_BUDGET = {code: 6, data: 4}`、`quotaOf(used, limit)` 给 `{used, limit, remaining}`；预算来源优先 `.ioc` 的 `Mcu.CPN` → 资源包 `chips.json` 里可选的 `breakpoints` / `watchpoints`（只写一个另一个按 F1 补齐），没 `.ioc`、chips.json 没这颗、或没写这两个值都回退 F1 6/4，**并在 note 里明说为什么回退**（不让用户以为芯片就是这么设计的）。

收集端：`breakAt` + `breakpoints` 参数 + `preCommands` 里的 `break` / `tbreak` / `hbreak` / `watch` / `rwatch` / `awatch` 一起算（`collectBreakpointRequests`），同 kind + location 去重。判定端：`planBreakpoints` 给 `detail`（「这次要设 7 个硬件断点 / 0 个观察点，芯片上限是 6/4（多 1 个硬件断点）」）与 `suggestion`（换 `tbreak`、拆成多次、或换芯片）。

落点：`debug_run` 与 `debug_session` 都在 spawn openocd **之前**算预算，超限直接失败——不碰探针、也不关已有会话；报告统一带 `breakpoints` / `watchpoints` 两个三元组，卡片打「断点预算：6/6（还剩 0）；观察点 0/4」；`debug_eval` 里 `commands` 中的 `break` / `watch` 同样过一遍预算。证据：拿真实 C8T6 工程（`demo.ioc` + `build/Debug/demo.elf`，用 forbidden subprocess 保证不碰探针）设 7 个断点，输出「没调试：断点超预算（硬件断点 6/6，观察点 0/4）」+ detail + 建议——**判定发生在碰探针之前**，所以与 §29.2 那个 WCH-Link 故障完全解耦。

### 29.4 文档口径

- `README.md` / `README_EN.md`：错误段落全部改成 `probeError`（`kind` / `cause` / `hint` / `evidence` / `retryable`，8 类），**不再出现 `errorCode`**；烧录行、调试行补了「超断点预算不占探针」与「连读复用会话」；资源包大小从「约 100 KB」改为 **core 约 180 KB**，并在安装一节加了一句「首次使用要联网拉一次资源包，装好之后离线可用」——插件不内置芯片表这件事，用户应该在装的时候就知道，而不是建工程时才撞上。
- `docs/reading-guide.md`：engine 从 41 个增至 44 个（表里 44 行；目录里实际 45 个 `.ts`，`assets.ts` 一直没单独成行），§5.4 从 5 个 / 2257 行改成 8 个 / 3160 行并补 `probe-error.ts` / `probe-session.ts` / `breakpoints.ts` 三行；§7.5 / §7.6 的流程图与文字改成 `classifyProbeFailure` + `probeError`，并写了 B3 的 Tcl RPC 快路径与 B4 的预算先算、§9.1 / §9.2 改成 34 套件 497 例（CI 495 + 2 skipped）、§10 的「给工具加错误码」那行改成「加 / 改探针错误分类」、§11 补了坑 13（B3 真机计时欠着）。

### 29.5 验证

- `npm run build` → exit 0。
- `npm test` → **34 套件 497 pass / 0 fail**（CI 上 495 pass + 2 skipped）。本批新登记三个套件：`probe-error-units` 23 例、`probe-session-units` 16 例、`breakpoints-units` 17 例；既有套件无回归（`schema-guard` 25 例、`flash-units` 已迁到新 API）。
- 真机：B4 的 7 断点判定在真实 C8T6 工程上实测（不碰探针）；B2 的四类故障、B3 的计时**只有单测 / 假件**，原因见 §29.2 与 §11 的坑 4、坑 13。

### 29.6 偏差备案

- **B3 真机计时未达成**：探针侧硬件/固件问题（WCH-Link `CMD_INFO failed`），非代码引入；替代证据是假件实测，复测命令写在 §29.2 与 reading-guide 坑 13。
- **资源包体积口径**：任务书写「core 约 180 KB」，当时量到 core profile 是 30 个文件 / 242903 字节 ≈ **237 KiB**（大头是 `device/f1/chips.json` 36.1 KiB 与 `memory.json` 34.2 KiB）。2026-10-31 用户要求「缓存仓库中重复的删掉」后：`chipdb/`（58 个 XML，与 CubeMX 安装目录的 `db/mcu` 重复）与 `device/f1/memory.json`（每条都是 chips.json 的 flashBytes/ramBytes 派生）删除；chips.json 只留 db 与固件包能算出来的 9 个字段（startup/deviceDefine/deviceHeader/linkerScript 由插件 `namingFrom` 现算）→ core **29 个文件 / 201716 字节 ≈ 197 KiB**（chips.json 30.8 KiB），full 69 个文件（SVD 1.75 MB 仍在 full 里）。两份 README 已同步成这两个数。
- **engine 模块计数**：reading-guide 的表是「逐条列出来的模块数」（41 → 44），不是目录文件数（42 → 45）——`assets.ts` 从来没单独成行，这次没顺手补（避免把文档任务做成改表任务）。

### 29.7 真机样本（已取证的四类）

这一节只记**真板子上真的发生过**的样本；它们同时是 `MATCHERS` 的回归依据。原始日志逐字保留，判定结果来自 `classifyProbeFailure`。

| kind | 触发动作 | openocd 原始关键行 | 插件判定 | 恢复动作 |
| --- | --- | --- | --- | --- |
| `no-probe` | 拔掉探针再烧 | `Error: unable to find a matching CMSIS-DAP device` | `no-probe`，hint 提示检查 USB / 占用 / 换线 | 插回探针 |
| `probe-busy`（并发） | 两个 openocd 同时抓同一个 CMSIS-DAP | `Error: CMSIS-DAP transfer count mismatch: expected 5, got 1`、`Error: CMSIS-DAP command mismatch. Sent 0x12 received 0x2` | `probe-busy` | 关掉多余的那个 openocd / 调试会话 |
| `probe-busy`（固件卡住） | 上一次会话被硬 kill 之后（2026-10-31 复现两次） | `Error: CMSIS-DAP command CMD_INFO failed.`（约 6 s 后超时；此时没有任何并发进程，HID 设备状态 `CM_PROB_NONE`） | `probe-busy`，cause 现在写成「探针没有正常响应（被另一个进程同时访问，或探针固件卡住）」，hint 追加「拔下来等 3 秒再插回」 | **物理拔插**探针（软重启设备需要管理员权限，`Disable-PnpDevice` 会失败） |
| `timeout` | 同一颗卡住的探针上跑 `stm32_rtt start` | `错误：timeout — 读控制块失败：Tcl 往返超时（5000 ms）` | `timeout` | 同上，拔插后重试 |
| `target-mismatch` | 用 `openocd-f4.cfg`（`target/stm32f4x.cfg`）连 F1 芯片烧录（2026-10-31） | `Warn : Cannot identify target as a STM32 family.`（另有 `Error: Failed to write memory` / `Error: auto_probe failed`） | 修复前 **`unknown`**（分类器只吃 `Error:` 行，这行是 `Warn :`）；改成喂完整日志后 `target-mismatch`，`retryable=false` | 删掉临时 cfg、换回 `target/stm32f1x.cfg` |
| `swd-locked` | `USER CODE BEGIN 2` 写 `AFIO->MAPR = (AFIO->MAPR & ~(7u << 24)) \| (4u << 24);`，第一次烧录成功、复位后再烧（2026-10-31） | `Error: Error connecting DP: cannot read IDR` | `swd-locked`，`retryable=true`，hint 指向 BOOT0 进系统 bootloader | BOOT0=1 → 复位 → 烧回正常固件 → BOOT0=0 → 复位 |

**根因与修复**：卡死是「会话关闭时直接 kill openocd」造成的——openocd 来不及给探针发断开序列，CMSIS-DAP 固件停在半连接。现在 `src/engine/debug-session.ts` 的 `stop()` 会先经 Tcl 口发 `shutdown`、等 1.2 s 再 terminate（`requestOpenocdShutdown(port, timeoutMs)`）。修完之后连续多轮真机操作未再复现。

### 29.8 四类待实测（需要真实故障，暂无样本）

`swd-locked` / `flash-protected` / `no-power` / `target-mismatch` 目前**只有单测构造的日志行**（`test/probe-error-units.test.mjs`），没有真机样本。风险很具体：真实 openocd 的措辞若落不到 `MATCHERS` 的正则上，就会被判成 `unknown`，hint 也随之失效。

复现方法（**建议都在备用板上做**）：

| kind | 复现动作 | 预期日志 | 恢复 | 风险 |
| --- | --- | --- | --- | --- |
| `swd-locked` | 烧一个关掉 SWD 的固件（`.ioc` 的 SYS→Debug 设 Disable，或代码写 `AFIO->MAPR = SWJ_DISABLE`），再 `stm32_flash` | `Error connecting DP: cannot read IDR` / `sticky error` | 按住 BOOT0 上电进系统 bootloader 再连，重烧正常固件 | 中：会暂时失去调试口，可恢复 |
| `flash-protected` | 用 STM32CubeProgrammer 给 option bytes 开 **WRP**（写保护）后烧录 | `flash programming failed` / `write protected` | 解除 WRP（通常需全片擦除） | 中：**RDP level 2 不可逆，绝对不要碰**；只做 WRP |
| `no-power` | 只留 SWD 两根线、拔掉 3V3（或把供电降到 2.5 V） | 探针在、目标 ID 读不到；部分固件报 `target voltage may be too low` | 接回 3V3 | 低 |
| `target-mismatch` | 拿非 F1 的板子（F4/F0）用 `target/stm32f1x.cfg` 去连，或把 target 配成 `stm32f4x` 连 F1 | `unexpected idcode` / `device id = 0x…` 与期望不符 | 换回正确 target 配置 | 低 |

每类实测后要记录的字段（补进 29.7 那张表）：

```markdown
| kind | 复现动作 | openocd 关键行（逐字 2–3 行） | 插件判定 kind | cause / hint 是否对症 | retryable 是否合理 | 恢复动作 | 日期 | 板子 / 探针 |
```

判定标准：① `probeError.kind` 与造的故障一致；② `cause` 不是「有失败但分不出原因」；③ 照 hint 做真能恢复；④ `retryable` 符合 §29.1 的判据（`swd-locked`/`no-power` 为 `true`，`flash-protected`/`target-mismatch` 为 `false`）；⑤ 若判成 `unknown`，把原始行贴回来补 `MATCHERS` 正则。

## 30. C 阶段：RTT 日志（openocd rtt + stm32_rtt + 模板侧控制块）（2026-10-31）

这一批只做一件事：**让固件里的 printf 出现在工具输出里，不接串口、不改接线**。做法不是自己写传输，而是把 openocd 自带的 `rtt` 命令用起来，我们只管三头：**控制块**（固件侧，与 SEGGER 兼容）、**帧语法**（级别 + 时间戳）、**工具面**（`stm32_rtt` 的 start / dump / stop / status）。

### 30.1 为什么走 openocd rtt，而不是自研传输

RTT 的传输本质很朴素：调试器通过 SWD 直接读目标 RAM 里的环形缓冲，把新数据搬到宿主。这条链路 openocd 早就有——`rtt setup <addr> <size>` 让它在指定 RAM 区间里认控制块、`rtt start` 打开通道、`rtt server start <port> <channel>` 把它暴露成本地 TCP 端口。传输层是现成的，而且就在我们的调试会话里（B3 之后会话本来就带 Tcl 端口），自己再写一遍没有任何收益：

- 自研传输要么再起一个 openocd（两个进程抢一个探针，正是 §29.2 端口顺延那类翻车的根源），要么自己实现 SWD 批量读（CMSIS-DAP 的 `DAP_TransferBlock` + apswd 那一层，等于把 openocd 重写一遍）。后者远超这一阶段的风险面。
- 反过来，**沿用 openocd 的传输，我们只需要让固件里的控制块长得像 SEGGER 的**：首 10 字节 `"SEGGER RTT"`、`MaxNumUpBuffers` / `MaxNumDownBuffers`、每通道一个 `rtt_buffer_desc_t{sName,pBuffer,SizeOfBuffer,WrOff,RdOff,Flags}`。于是 `rtt setup/start/server start` 三条命令直接认（布局见 30.4）。
- **帧格式反而是我们自己的**：SEGGER 原生通道只搬裸字节，没有级别、没有时间戳——而「哪条是 error、这条是几秒前打的」恰恰是排查时最先要的信息。所以在通道 0 的字节流上加 13 字节头（见 30.2）。代价写在 30.6：原生客户端（RTT Viewer / J-Link RTT Client）读通道 0 会把这 13 字节当内容，不会自动拆帧。

一句话：**传输借 openocd，语法归我们**。这也是为什么 src/engine/rtt.ts（724 行，新）里没有一行 SWD 代码，只有「校验控制块 → 发三条 Tcl / 命令行 → 读端口 → 解帧」四件事。

### 30.2 帧约定：13 字节头 + UTF-8 payload

一条记录在通道 0 的环形缓冲里是连续的一段字节：

| 偏移 | 宽度 | 含义 |
| --- | --- | --- |
| 0 | 4 | 长度 LE，**含级别 + 时间戳 + payload**，即 `9 + payload 字节数`（不含这 4 字节自己） |
| 4 | 1 | 级别：1 error / 2 warn / 3 info / 4 debug（固件侧越界夹到 1..4） |
| 5 | 8 | 时间戳，毫秒，LE（默认 DWT 周期计数器按 `SystemCoreClock` 换算，弱符号可覆盖成 `HAL_GetTick`） |
| 13 | n | UTF-8 payload，不含结尾 0 |

常量只有一对，两侧都从它派生：`RTT_FRAME_HEADER_BYTES = 13`、`RTT_MIN_FRAME_BYTES = 9`（payload 为空时长度字段的值）。`src/engine/rtt.ts` 里的 `parseRttFrames` / `encodeRttFrame` 一解一编（后者给单测与自检用），`templates/register/Core/Src/rtt.c` 里的 `RTT_FRAME_OVERHEAD` / `RTT_FRAME_MIN_BYTES` 是同名的另一份——`rtt-units` 有一条反算断言钉住「两边算出来的头长与最小长度一致」，改一边不改另一边会红。

解析的三个细节（都是「真出过一次就会记一辈子」的）：

- **先看长度字段，再决定信不信它**：`len < 9` 或 `len > 4096`（`DEFAULT_MAX_FRAME_BYTES`）一律判失步，按字节滑动重找，绝不用一个错长度去读后面的内存。
- **单帧坏掉不炸整次 dump**：丢掉这一帧、记一条 note，能解出来的记录照常返回。
- **截断要出声**：本次读到的数据被环覆盖过、或帧头自洽但 payload 已经滚掉时，报告 `truncated: true` 并说明原因，而不是悄悄少几条。

### 30.3 工具面：`stm32_rtt` 的四个动作

一个工具四个 action（`src/tools/rtt.ts`，408 行），共用一份 report schema：

| action | 做什么 | 关键参数 |
| --- | --- | --- |
| `start` | 校验控制块 → `rtt setup <addr> <size>` → `rtt start` → `rtt server start <port> 0` | `addr`（必填，控制块起始地址）、`size`（默认 `0x400`）、`banner`、`rttPort`（默认 9090） |
| `dump` | 连本地 RTT 端口，读 `seconds` 秒或 `maxRecords` 条，解帧、按 `level` 过滤，返回 `records[{t,level,text}]` | `seconds`（默认 3，0.2..60）、`level`（默认 4 = 全要，语义是「保留到哪一级」的上限）、`maxRecords`（默认 200） |
| `stop` | 关端口 / 停 server，幂等 | — |
| `status` | 报当前有没有在跑（`running` / `startedAt` / `runningMs` / 端口） | — |

细节：

- **start 先 `mdw` 三个字确认控制块**：`0x47474553`（`SEGG`）/ `0x52205245`（`ER R`）/ 低 16 位 `0x5454`（`TT`）。读回全 0 → 「没调 `rtt_init()`」；不是这个魔数 → 「`addr` 指错了」。这一步在 `rtt setup` **之前**，所以地址填错不会把 openocd 带进一个坏状态。
- **没有调试会话就自己起一个**：`start` 走 `ensureSession`（与 `stm32_regs_read` 同一个单例），notes 写「没有活跃会话，先起了一个调试会话（gdb 端口 N，tcl 端口 M）」；已有会话则写「复用已有调试会话（tcl 端口 N）」。**只有 `start` 跑工具链门禁**（capability `debug`），`dump` / `stop` / `status` 不跑——读一个本地端口不需要 gcc。
- **`rtt start` 需要目标在跑**：目标 halt 住时通道不推进（缓冲不写，也就读不到新东西）。工具在 notes 里点明「先 resume 再 dump」；`dump` 自己不发 halt。
- **错误复用 `ProbeError` 形状**：`kind` 只用 `unknown` / `timeout`（另外七类是探针故障，与 RTT 无关，硬塞进来只会误导），`cause` 来自真实日志行，`hint` 覆盖六种情形：端口占用（换 `rttPort`）、通道连不上（连接超时 + 目标是否在跑）、无会话、控制块全 0 / 魔数不符（都指向「模板里怎么加 RTT」）、Tcl 超时、帧失步。
- **渲染上限 80 条**：超出打「… 还有 N 条（调大 maxRecords 或分批 dump）」，否则一次 200 条会把卡片刷满。
- `isConcurrencySafe: false`：RTT 是「一个端口一个会话」的状态机，两个 dump 并发会互抢那条 TCP。

### 30.4 模板侧：寄存器版自带，HAL 版只给说明

`templates/register/Core/{Src/rtt.c,Inc/rtt.h}`（282 + 103 行）随 `stm32_project_create route=register` 一起落地（`templateFiles` 7 → 9）。控制块布局：

| 偏移 | 字段 | 值 / 说明 |
| --- | --- | --- |
| 0 | `char acID[16]` | `"SEGGER RTT"` —— openocd `rtt setup` 靠它认块 |
| 16 | `uint32_t MaxNumUpBuffers` | 3 |
| 20 | `uint32_t MaxNumDownBuffers` | 0（不做下行，`aDown` 只留一个占位） |
| 24 | `aUp[3]` | 每个 24 字节：`{sName, pBuffer, SizeOfBuffer, WrOff, RdOff, Flags}` |
| 96 | `aDown[1]` | 不使用 |

四条 `_Static_assert` 把布局钉死（`acID` 在 0、`MaxNumUpBuffers` 在 16、`aUp` 在 24、描述符 24 字节）——这些偏移是 SEGGER 的 ABI，改了 openocd 就认不出来，所以用编译期断言，而不是注释提醒。通道名是 `Terminal` / `Channel 1` / `Channel 2`（工具只读通道 0）。

写入策略：3 个通道各 1 KB 环形缓冲（`s_up_buf[3][1024]`，共 3 KB `.bss`）。`rtt_ring_write` 先 `memcpy` 数据、**最后**才推进 `WrOff`（读侧不会看到半条帧）；剩余空间放不下整条就返回 0、**整条丢**，不写半条、不阻塞、也不覆盖还没被读走的数据。`rtt_init()` 的顺序是先 `memset`、再填描述符、**最后**才写 ID 魔数——openocd 看到魔数时描述符一定已就绪。它会打开 DWT 周期计数器，所以必须在时钟初始化之后调用。

默认不启用是有意的：`main.c` 只在 `USER CODE BEGIN 2` 里给注释示例，`CMakeLists` 列了 `Core/Src/rtt.c`，但工具链开了 `--gc-sections` 且没人引用 `rtt_init()`——不取消注释时那块 3 KB 缓冲和 rtt.c 的代码都被链接器丢掉（实测默认 RAM 1576 B / FLASH 1368 B，`nm` 里没有 `_SEGGER_RTT`）。取消注释后同一工程实测 RAM **1576 → 5232 B**，控制块落在 **`0x20000DE0`**。

**一个真实链接缺陷（本批唯一改代码的意外）**：只取消 `rtt_init()` / `rtt_printf()` 的注释就去链接，报 `undefined reference to `_sbrk'` —— `vsnprintf` 会牵进 newlib 的堆延伸，而寄存器版模板没有 `syscalls.c`。修法是 rtt.c 里给一份 `__attribute__((weak))` 的 `_sbrk`（直接失败，等于没有堆）：用户自己实现 `_sbrk` 或带 `syscalls.c` 时，强符号自动覆盖它。这条写进了 `rtt.h` 的注释与 `templates/scaffold/RTT.md`，因为它是「照文档加了三行代码却链接不过」最容易撞的那堵墙。

HAL 版**不预置 rtt.c**：`Core/**` 是 CubeMX 生成区，自己的 `.c` 放进去会被下次 `stm32_generate` 覆盖、也违反「只改 USER CODE」的红线。所以只给 `templates/scaffold/RTT.md`（拷到 `App/`、在 `cmake/user/CMakeLists.txt` 里 `target_sources` + `target_include_directories`、只在 USER CODE 块里写 `#include` 与调用），并在 `cmake/user/CMakeLists.txt` 留了钩子注释。

### 30.5 性能、丢帧与「读不到」的三种原因

- **成本在 RAM，不在 CPU**：每通道 1 KB、默认 3 通道 = 3 KB `.bss`（C8T6 20 KB 的 15%）。RAM 紧就改 `rtt.h` 的 `RTT_UP_CHANNELS`（例如 1）/ `RTT_BUF_SIZE`（例如 512），单条 payload 上限 `RTT_MSG_MAX=120` 也能改。
- **写入 O(payload)、无锁、不阻塞**：主循环和中断都能写；多上下文并发要自己在外面关临界区（rtt.h 明写「不加锁」）。
- **丢帧是整条丢，不是半条**：环满 / 放不下整条 → 返回 0、丢弃，丢了多少数 `rtt_dropped_count()`（固件本地变量）。**口径要注意**：`stm32_rtt` 报告里的 `dropped` 统计的是**按 `level` 过滤掉的记录条数**，不是环丢弃——两者不是一回事，rtt.h 与这个文件里都写清了。
- **dump 的默认口径**：3 秒、最多 200 条、单帧上限 4096 字节；`level` 是上限（默认 4 全要，`level=3` 就只要 error/warn/info）。长时间盯日志的正确姿势是「多次 dump」，而不是把 `seconds` 拉到 60——单次越长越容易撞上端口读超时。
- **「读不到」分三种，工具分开报**：控制块全 0（没 `rtt_init()`）／魔数不符（`addr` 错）／通道连不上（目标停在 halt、会话掉了、端口被占）。这是 §29.1 那套「kind + cause + hint + evidence」的直接延续。

### 30.6 已知限制

- **只有通道 0**：工具只读 `Terminal`。通道 1/2 留给应用自己分用途，插件不读，也没有「按通道分文件」的写法。
- **没有 defmt 解码**：帧里就是 UTF-8 文本，不理解 Rust `defmt` 的二进制编码，也不解 SEGGER SystemView 的包。要结构化数据只能自己在 payload 里放 JSON，回宿主再解。
- **RTT 占目标 RAM**：默认 3 KB。C8T6 上同时开 ADC + 串口 + 3 KB RTT 就要算账了，这 3 KB 是「加日志要不要紧」的真实代价。
- **需要固件先调 `rtt_init()`**：openocd 能认控制块，是因为固件先把魔数和描述符写好了。不调初始化就只有一个全 0 的 RAM 区，工具会明确这么报，而不是含糊地说「连不上探针」。
- **时间戳是毫秒且不跨复位**：DWT 按 `SystemCoreClock` 换算，时钟不准它就不准；复位后归零。要墙钟就覆盖 `rtt_time_ms()` 接 RTC / `HAL_GetTick`。
- **原生客户端读不了我们的帧**：RTT Viewer / J-Link RTT Client 读通道 0 会看到 13 字节头（它们不知道我们的帧语法）。
- **真机 dump 还没有记录**（见 30.9）。

### 30.7 文档口径

- `README.md` / `README_EN.md`：功能表与工具表各加一行 `stm32_rtt`（start / dump / stop / status），并补一节「固件里怎么加 RTT」的最短示例——固件侧三行（`#include "rtt.h"`、`rtt_init()`、`rtt_printf(...)`），宿主侧先 `arm-none-eabi-nm … | findstr _SEGGER_RTT` 取控制块地址，再三次工具调用 `stm32_rtt`（start / dump / stop）；「已知限制」各加一行 RTT 的边界（通道 0 / 帧是我们自己的 / 3 KB RAM）。
- `docs/reading-guide.md`：tools 从 20 个增至 21 个（§1.1 行数、§3.1 注册顺序、§4 标题与 §4.2 表加 `stm32_rtt` 行）、engine 从 44 个增至 45 个（§5 标题与 §5.4 加 `rtt.ts`，8 个 3160 行 → 9 个 3884 行）、§9.1 / §9.2 改成 **35 套件 523 例**（CI 521 pass + 2 skipped）并加 `rtt-units` 26 例、§10 加一行「改 RTT 帧格式」、§11 补坑 14（RTT 只有离线验证）。

### 30.8 验证

- `npm run build` → exit 0（typecheck 同）。
- `node --test test/rtt-units.test.mjs` → **26 pass / 0 fail**，进程正常退出（C1 的 20 例 + C2 的 6 条静态断言：模板文件与 CMakeLists 引用、控制块布局与 `used`、魔数与引擎常量反算一致、帧常量 13/9 与级别 1..4、HAL 只留说明、弱 `_sbrk` 兜底）。
- `npm test` → **35 套件 523 pass / 0 fail**（前 34 套件 497 例 + `rtt-units` 26 例，无回归）。
- 真工程：用本地真实 CMSIS 缓存（**未联网**）建寄存器工程 → `templateFiles=9`、`Core/Src/rtt.c` 与 `Core/Inc/rtt.h` 就位；`cmake --preset Debug` + `cmake --build` 两次都 exit 0（默认无 `_SEGGER_RTT` 符号，RAM 1576 B）；取消 `USER CODE BEGIN 2` 的注释后同一工程链接出 `_SEGGER_RTT @ 0x20000DE0`，RAM 5232 B。
- 帧逻辑在主机上编译执行过（64 位布局，帧代码与固件同源），产出的 4 条记录被 `lib/engine/rtt.js` 的 `parseRttFrames` 正确还原成 `{t, level, text}`。

### 30.9 偏差备案

- **真机 dump 未达成**：26 例全部离线（假 subprocess + 假 Tcl / 假端口），真机上只做到「建工程 + 编译 + `nm` 取址」，**没有一次「真板子 + 真探针 + 真 dump」**。原因与本批改动无关：手头的 WCH-Link 在 §29.2 就报 `Error: CMSIS-DAP command CMD_INFO failed.`，而 `rtt start` 需要目标真在跑，探针不通就无从验证。**复测方法**：换回 CMSIS-DAP 探针 → `stm32_flash` 烧一个取消注释的寄存器工程 → `arm-none-eabi-nm build/<preset>/<工程名>.elf | findstr _SEGGER_RTT` → `stm32_rtt action=start addr=<addr>` → `stm32_rtt action=dump seconds=3`。
- **只有通道 0 / 无 defmt**：见 30.6，是设计取舍不是欠账（多通道要先在帧头里加通道标识，defmt 解码要另一个依赖）。
- **行数口径**：reading-guide 的行数是「在既有数字上加增量」，不是重算——tools 19 → 20 个文件 / 5078 → 5486 行、engine 41 → 42 个文件 / 15919 → 16643 行、§5.4 8 → 9 个 / 3160 → 3884 行。目录里的真实数字比表里的旧值大得多（tools 21 个文件 6157 行、engine 46 个文件 18980 行），顺手重算会把文档任务做成改表任务（与 §29.6 同一条原则，这里如实记一笔）。**D 阶段末已改口径**：全书按文件换行符数重数了一遍（`src/tools` 21 个文件 6623 行、`src/data` 10 个 3599 行），本条只记录 C 阶段当时的做法，别再拿 5486 / 16643 这两个数字当现状。

## 31. D 阶段：SVD 寄存器命名与位域解释（2026-10-31）

这一批只做一件事：**让寄存器从「一串十六进制地址」变成「有名字、有位域」的东西**。做法不是自己维护一张寄存器表，而是接资源仓库里的 SVD 事实表（`device/f1/svd/<line>.json`）：工具层把 `GPIOC.ODR` 解析成 `0x4001100C`，读回来的 `0x00000020` 再按位域拆成 `ODR5=1`。不新增工具、不改 engine、不动固件模板——`stm32_regs_read` 的手感不变，只是它的 `addresses` 多了几种写法、报告多了几个字段。

### 31.1 为什么用 SVD，而不是内置一张寄存器表

「这个外设的基址是多少、这个寄存器偏移多少、这一位叫什么」这三件事只有 ST 的 SVD 有完整答案。三条路摆在面前，选了第三条：

| 方案 | 为什么不选 |
| --- | --- |
| 插件内置一张 F1 寄存器表 | 等于手工重写一遍 SVD，还写不全：光 103 一条线就有 53 个外设 / 722 个寄存器 / 4833 个位域。手写表从一开始就是过期数据 |
| 运行时解析 ST 的原始 `.svd` XML | 每条产品线 0.5–1.5 MB XML，而本插件**零运行时依赖**（不变量 20），带一个 XML 解析器等于自己养一个依赖；而且插件里没有任何地方需要一个通用 XML 解析器 |
| **资源仓库把 SVD 先解析成精简 JSON，插件只读** | 解析一次、六条线复用；插件侧只做「查表 + 解码」，零依赖、纯只读（`src/data/svd.ts` 不写盘、不联网、不起进程） |

资源仓库的 `scripts/build-assets.mjs` 在构建时把 ST 的 `STM32F1<line>xx.svd` 裁成只含**外设基址 / 寄存器偏移 / 字段 bitOffset+bitWidth** 的 JSON（实测 `103.json` 里连一个 `description` 字段都没有），六条产品线合计 **266 个外设 / 3703 个寄存器 / 27881 个位域，1,795,459 字节 ≈ 1.71 MiB**（103 那份 319,901 字节）。

**许可上这是硬约束**：原始 SVD 是 STMicroelectronics End User License Agreement v1.0（cmsis-svd-data 的 `data/STMicro/License.html`），不能随插件分发。所以资源仓库只存「编译结果」——地址与位宽这类事实，不含 ST 的说明文字——并且标在 `profile: "full"` 里（`manifest.json` 的 `files[].profile`）：`full` 是 128 个文件，`core`（30 个文件 ≈ 237 KiB，见 §29.6 那笔账）里**没有 SVD**。用户跑一次 `stm32_assets refresh --profile full` 就装到 `~/.dsh-stm32/assets/<版本>/device/f1/svd/`；插件之后只读本地缓存，不再联网、也不再分发。

### 31.2 工程 → line：先看 `.ioc`，再按型号兜底

一份 SVD 事实表对应一条产品线，所以「读哪个 JSON」要先回答「这块板是哪条线」。`resolveProjectSvd(projectDir, env)` 的顺序是：

1. 工程里的 `.ioc` 读 `Mcu.CPN`（如 `STM32F103C8T6`）→ 资源包的 `device/f1/chips.json` 里这一颗的 `line` 字段 → `device/f1/svd/103.json`。`source: "chips.json"`。
2. `.ioc` 有型号但 `chips.json` 里没有这颗（资源包没装 / 直指资源仓库本体而没有 `install.json`）：按 `/^STM32F(\d{3})/` 兜底，落在 `SVD_KNOWN_LINES = ["100","101","102","103","105","107"]` 之内就用。`source: "cpn"`，note 里明说「line 是按型号编号兜底推出来的」。
3. 都没有：`source: "none"`，`device: null`，`failure` 说明原因——**不抛异常**，因为「没有 SVD」只是少一层增强，不是错误。

只有这六条线有数据；同一 line 下的所有容量档/封装共享同一份（C8T6 与 RCT6 都是 `103.json`）。105 与 107 各一份、不合并。成功时 note 会写清用的是哪份：「位域解释来自 SVD line=103（STM32F103xx，53 个外设 / 722 个寄存器 / 4833 个位域，资源包 <版本>）」。

缓存键是 `path+size+mtimeMs`：资源包升级、重装、手改后自动失效，不需要 reset 钩子；`svdCacheStats()` / `resetSvdCache()` 只给单测证明「命中不重复读盘」。

### 31.3 五种写法，以及它们为什么等价

`addresses` 的每一项现在可以是下面五种之一，大小写、首尾空格、箭头两侧的空格都容错：

| 写法 | 例子 | 解析成 | 备注 |
| --- | --- | --- | --- |
| 地址（带 `0x`） | `0x4001100C` | 原样读 | 没有 SVD 也能用；有 SVD 时反查名字 |
| 地址（不带 `0x`） | `4001100C` | 同上 | 八位十六进制，统一成 8 位大写输出 |
| 符号名 | `GPIOC.ODR` | 基址 0x4001100C | 手册里的 `GPIOC_ODR` 写成点更顺 |
| C 风格箭头 | `GPIOC->ODR` | 同上 | 与 `.` 完全等价 |
| 纯外设名 | `GPIOC` | 该外设全部寄存器（升序，上限 64） | 顺带 dump，见 31.6 |

解析与去重都发生在**碰探针之前**（`planRegReads`）：所有 ref 先解析成地址列表、去重、决定每条的目标类型，全绿了才 `ensureSession`。所以符号写错时一个进程都不会 spawn，不会白占探针——这条和 B4 的断点预算（§29.3）是同一个原则。

去重与别名在 notes 里会出声：

- `["GPIOC.ODR", "0x4001100C", "RCC.CR"]` → 只读 2 个地址，note：`「0x4001100C」与「GPIOC.ODR」指向同一个地址 0x4001100C，只读一次`。
- `["GPIOC.ODR", "RCC.CR", "GPIOC.ODR"]` → note：`「GPIOC.ODR」重复了，只读一次`。

### 31.4 报告长什么样

`samples` 从三个字段变成六个**全部必填**（`additionalProperties: false`，不变量 6）：

| 字段 | 含义 |
| --- | --- |
| `address` | 8 位大写十六进制，如 `0x4001100C` |
| `value` | 读到的值，8 位大写十六进制 |
| `ok` | 这一条读成功没有 |
| `ref` | 用户原样写的那个字符串（`GPIOC.ODR` / `0x4001100C` / `GPIOC`） |
| `name` | 规范化名字（`GPIOC.ODR`）；纯地址且没有 SVD 时就是地址本身 |
| `fields` | **只列置位**的位域，元素 `{name, bits, value}`；`bits` 单 bit 写 `"5"`、区段写 `"3:7"`，`value` 已按 `bitOffset` 右移 |

渲染出来的样本行长这样（`GPIOC.ODR` 读回 0x20，`RCC.CR` 读回 0x83）：

```text
  GPIOC.ODR (0x4001100C) = 0x00000020  → ODR5=1
  RCC.CR (0x40021000) = 0x00000083  → HSION=1, HSIRDY=1, HSITRIM=16
```

（等号后一个空格、箭头前两个空格；值为 0 时只到等号、没有箭头，`fields: []`。）

`message` 的单位跟着目标类型走：这次读里只要有一个符号名或外设名，就说「读到 N 个寄存器」；纯地址仍是「N 个地址」。另外 notes 会补一句 line 来源（见 31.2），所以报告本身就能回答「这个解释是哪来的」。

### 31.5 位域解码的口径

`decodeRegisterValue(register, value)` 是纯函数，五个输出：

| 输出 | 含义 |
| --- | --- |
| `fields` | 值里**为 1** 的字段：`{name, bitOffset, bitWidth, value, bits}`（`bits` 由 `formatBits` 生成，与报告字段同源） |
| `set` / `clear` | 置位名与清位名两组（样本只带 `fields`；`clear` 留给以后做「清位建议」的人） |
| `uncovered` / `uncoveredBits` | 没被任何字段覆盖的位数与位掩码。`GPIOC.ODR` 是 16 个单 bit 全覆盖，读 0x00000004 → `ODR2=1`、`uncovered=0` |

三条取舍：

- **只报置位**。一整屏「ODR0=0、ODR1=0…」没有信息量；值为 0 的字段读者自己知道是 0。
- **不猜枚举名**。SVD 里有 `enumeratedValues` 这类东西，但「寄存器这一位等于 2 是什么意思」是数据手册正文的事；事实表里没有，插件也不编。给出的是位名 + 数值。
- **位宽按寄存器 `size`**（SVD 33 个，F1 基本都是 32），没有 SVD 时按 32 位处理。`value` 是右移后的原值，不做符号扩展。

### 31.6 外设 dump：7 条、64 条上限

只写外设名（`GPIOC`）时，按 `addressOffset` 升序把该外设的全部寄存器读出来并逐条解释：

- `GPIOC` → **7 条**：`CRL`、`CRH`、`IDR`、`ODR`、`BSRR`、`BRR`、`LCKR`（最后一条 `GPIOC.LCKR @ 0x40011018`），note：`「GPIOC」是外设名：dump 了它的 7 个寄存器（基址 0x40011000）`。
- `RCC` → 10 条（基址 0x40021000）。
- 上限 `REG_DUMP_MAX = 64`：超过时只 dump 地址最小的前 64 条，并在 note 里写「外设 X 有 N 个寄存器，只 dump 了地址最小的前 64 个（剩下的写 X.寄存器名 单独读）」。没有新增「dump」这种 action，也没新增工具——`addresses` 里的一项就是一个读目标。

### 31.7 缺 SVD 时的回退：地址照读，符号名报错

两种情形分开处理，因为它们的「用户预期」不一样：

- **纯地址**（`0x4001100C` / `4001100C`）：照读。`name` 就是地址、`fields` 是空数组，note 写「没有可用的 SVD：这次只给值，没有名字与位域解释（SVD 只在 profile=full 里：先跑 `stm32_assets refresh --profile full`）」。门禁不拦——读一个地址不需要 SVD。
- **符号名 / 外设名**：解析不了就是错误（`ok: false`，不 spawn 进程），文案同上并给出可执行下一步：「`「GPIOC.ODR」不是物理地址；符号名/外设名要靠 SVD 才能解析：SVD 只在 profile=full 里：先跑 stm32_assets refresh --profile full（或者直接写 0x 开头的地址）。`」

有 SVD 但名字写错，则尽量列出现成可用的名字（`REGS_SUGGEST_PERIPHERALS = 10`）：

```text
资源包（line=103）里没有外设 GPIOZ；可用外设（前 10 个）：FSMC、PWR、RCC、GPIOA、GPIOB、GPIOC、GPIOD、GPIOE、GPIOF、GPIOG（共 53 个）
外设 GPIOC 里没有寄存器 ODRX；已知寄存器：CRL、CRH、IDR、ODR、BSRR、BRR、LCKR（共 7 个）。
```

一个名字既不是已知外设、也不像 `X.Y` 时，会同时说这两件事：「`资源包（line=103）里没有外设 FOO，也不像 GPIOC.ODR 这种寄存器写法；可用外设（前 10 个）：…（共 53 个）`」。

`loadSvd` 本身**不抛**（返回 `{device, failure}`），只有「明确要一个寄存器 / 一段地址」的 API（`resolveRegisterRef` / `describeAddress`）才抛 `SvdError`，`code` 收 9 类：`assets-missing` / `svd-missing` / `svd-invalid` / `line-invalid` / `ref-invalid` / `value-invalid` / `peripheral-unknown` / `register-unknown` / `address-unknown`。严格解析是有意的：外设 / 寄存器 / 字段任何一条不合法就整份拒绝——装错文件比没装更危险，半个位域表会解释出错误的位。

### 31.8 代码落点

| 文件 | 行数 | 干什么 |
| --- | --- | --- |
| `src/data/svd.ts` | 837（新） | 加载（`loadSvd` / `loadSvdForLine` / `requireSvd` / `svdLineForChip`）、符号解析（`resolveRegisterRef`）、反向查（`describeAddress`，给一个地址说它属于哪个寄存器的第几字节）、解码（`decodeRegisterValue`）、渲染小件（`formatDecodedFields` / `formatAddress` / `formatOffset`）、`SvdError`、`SVD_FULL_PROFILE_HINT` 一份文案 |
| `src/tools/regs.ts` | 735（原 272，+463） | 五种写法的解析与去重（`planRegReads`）、工程 → line（`resolveProjectSvd`）、样本装饰（`decorateSamples`）、渲染（`describeRegSample` / `formatBits`）、`REG_DUMP_MAX` / `REGS_SUGGEST_PERIPHERALS` |
| `test/svd-units.test.mjs` | 39 例（新） | 26 例符号解析与解码（D1）+ 13 例工具层端到端（D2，含假 subprocess 与假 Tcl 服务端） |
| `test/fixtures/svd/` | 3 种布局 | flat（直接指向资源仓库本体）、versioned（`<root>/<version>/`）、badline（坏数据必须整份拒绝） |

engine 的 `src/engine/regs.ts` **一行没动**：它仍旧只负责「生成 openocd 脚本 / 解析 mdw 日志」，符号解析与位域解释全在 tools 层与 data 层。这也是这一阶段几乎没有回归风险的原因——21 个工具的数量与 engine 45 个模块都不变。

### 31.9 文档口径

- `README.md` / `README_EN.md`：`regs_read` 的示例从纯地址改成符号名与地址并列（`GPIOC.ODR` / `0x4001100C`），并注明符号名要资源包的 `full` profile；工具表那一行重写为「五种写法 + dump 上限 + 缺 SVD 的回退」；「已知限制」加一行（SVD 只在 full、只覆盖 F1 六条线）。
- `docs/reading-guide.md`：§0 与 §1.1 与 §6 的 data 层从 9 个模块改成 **10 个模块 3599 行**并加 `svd.ts` 一行；§1.1 / §4.1 / §4.2 / §5 / §6 的行数按「文件换行符数」统一重数过一遍（口径见下文 31.11）；§4.2 的 `stm32_regs_read` 行改为 `regs.ts（735）`、「工具层解析符号名」；§5.4 补一句 engine 不动；§8 加不变量 23（寄存器名字只能来自 SVD）；§9.1 / §9.2 改成 **36 套件 562 例**并加 `svd-units` 39 例；§10 加两行（改写法 / 更新 SVD 表）；§11 加坑 15（真机未复测）。
- 数字口径：D1 加 26 例、D2 加 13 例，合计 **39**；`npm test` 从 523 → **562**，套件 35 → **36**；工具数仍是 **21**，engine 仍是 **45** 个模块。

### 31.10 验证

- `npm run build` → exit 0（typecheck 同）。
- `node --test test/svd-units.test.mjs` → **39 pass / 0 fail**（26 + 13）。
- `npm test` → **36 个套件 562 pass / 0 fail**（前 35 套件 523 例 + `svd-units` 39 例，无回归；`run-units.mjs` 里 `svd-units` 排在 `rtt-units` 之后）。
- 真实资源包实测（`DSH_STM32_ASSETS` 直指资源仓库，line=103，53 外设 / 722 寄存器 / 4833 位域）：
  - `GPIOC.ODR` → 0x4001100C（基址 0x40011000 + offset 0x0C，16 个位域）；`GPIOC->ODR` 同；`RCC.CR` → 0x40021000（10 个位域）。
  - 反向：`0x4001100C` → `GPIOC.ODR`；`describeAddress(0x4001100E)` → `GPIOC.ODR`、`exact: false`、`offsetInRegister: 2`。
  - 解码：`GPIOC.ODR` 读 0x00000020 → `ODR5=1`；`RCC.CR` 读 0x00000083 → `HSION=1, HSIRDY=1, HSITRIM=16`；读 0 → `fields: []`、无箭头。
  - dump：`GPIOC` → 7 条（`CRL`…`LCKR`），`RCC` → 10 条；`BSRR` 读 0x1 → `BS0=1`。
  - 混传 `["GPIOC.ODR", "0x4001100C", "RCC.CR"]` → 只读 2 个地址，note 说明别名去重。
- 端到端用**假 subprocess + 假 Tcl 服务端**跑（不起真 openocd），覆盖「符号名 + 地址混传 / dump / 64 条截断 / 四种写法等价 / 未知外设建议 / 未知寄存器 / 无 SVD 回退 / 去重 / 位域置位 / line 推断 / 未知符号不 spawn」。

### 31.11 偏差备案

- **真机未复测**：符号名与位域解释的证据是「真实资源包 + 假探针」，**没有一次「真板子 + 真探针 + `GPIOC.ODR`」**。原因与 §29.2 / §30.9 同源（手头的 WCH-Link 在 `CMD_INFO failed` 上过不去）。**复测方法**：换回 CMSIS-DAP 探针，`stm32_regs_read addresses=["GPIOC.ODR","0x4001100C"]`，看 `samples[0].name` / `fields` 与 notes 里的 line 来源；顺带把 B3 的真机计时（坑 13）与 RTT 的真机 dump（坑 14）一起补掉。
- **行数口径**：D 阶段末把全书行数按**文件换行符数**（node `split('\n')`，等价编辑器的「块末行号」）重数了一遍，第 1、4.1、4.2、5、6 章现在都用这个口径：`src/tools` 21 个文件 **6623** 行、`src/data` 10 个文件 **3599** 行、`src/engine` 46 个文件 **18981** 行（第 5 章只表格化了 45 个模块，`engine/assets.ts` 1162 行未单列）；`regs.ts` **272 → 735（+463）**、`svd.ts` **837（新）**。之前用 PowerShell `(Get-Content f).Count` / `Measure-Object -Line` 量的会少算几十行（regs.ts 报 705、实际 735），那批数字已作废——教训写进 §31.11 这条。
- **用例数口径**：D2 的交付报告里写「追加 12 个用例（文件 39 例）」，实测文件是 39 例 = 26 + 13；文档按 **39** 记。
- **SVD 事实表体积**：六条线 1.71 MiB，`full` 档 128 个文件；`core` 仍是 30 个文件 / 237 KiB。与 §29.6 那笔「core 不在 180 KB」的账一致，没有新的口径变化。

## 32. 外设预设：CubeMX 到底靠什么把 `.ioc` 里的外设“认”出来（2026-10-31）

背景：用户要求把「启用一个外设」做成 `stm32_ioc_plan` 的预设（`peripherals`），键集不能靠猜。这一节记录实测过程与最终结论——**三条独立的坑，缺任何一条，CubeMX 都会静默丢弃整个外设，日志里一个错都不报**。

### 32.1 三条坑（都已用 CubeMX 6.15.0 + DB.6.0.150 + STM32Cube_FW_F1_V1.8.7 复现并修好）

1. **引脚必须列进 `Mcu.PinN`**。只写 `PA5.Signal=…` 而 `Mcu.PinN` 里没有 PA5，这根脚的配置根本不会被应用（SPI1 只列 PA6 时 PA5/PA7 被忽略，整个 SPI1 不激活；补齐三根脚后立刻生成 `MX_SPI1_Init`）。`Mcu.PinsNb` 要与实际条数一致。
2. **普通外设（USART）靠 `<pin>.Mode`**：`PA9.Mode=Asynchronous` + `PA9.Signal=USART1_TX` + `USART1.VirtualMode=VM_ASYNC`。缺 `.Mode` 时 USART1 被丢弃。
3. **共享信号外设（定时器 / ADC）靠 `SH.<信号>.n=<IP 信号>,<IP 模式>`**，而且这类引脚**不能**写 `.Mode`：
   - 定时器：`PA0-WKUP.Signal=S_TIM2_CH1_ETR`（PA0 的定时器信号与 TIM2_ETR 合并，必须用合并名）、`PA6.Signal=S_TIM3_CH1`、`PB6.Signal=S_TIM4_CH1`，配 `SH.S_TIM3_CH1.0=TIM3_CH1,PWM Generation1 CH1` + `SH.S_TIM3_CH1.ConfNb=1`。
   - ADC：`PA1.Signal=ADCx_IN1`（共享名，不是 `ADC1_IN1`），配 `SH.ADCx_IN1.0=ADC1_IN1,IN1` + `SH.ADCx_IN1.ConfNb=1`。
   - 交叉验证：官方板级 `B47_Nucleo_NUCLEO-L4R5ZI-P_STM32L4R5ZI_Board_AllConfig.ioc` 里就是这套写法（`SH.S_TIM2_CH1.0=TIM2_CH1,PWM Generation1 CH1`），它能被 `config load` 往返后保住 `Mcu.IP16=TIM2` —— 说明**文本导入本来能处理定时器，是我们缺 SH 块**。

顺带记两条**不是**原因的东西（都试过，别再试）：`Mcu.IPn` / `Mcu.IPNb` 写什么都没用（CubeMX 按引脚自己重建）；把 IP 键按字母序重排、把 IP 键放到引脚键之前、把 `ProjectManager.ProjectFileName` 改成实际文件名，全都没用（`-q config load` 永远走 `ImportTextPane` 文本导入路径）。

### 32.2 白嫖一个 oracle：`config save`

CubeMX 的 `-q` 脚本里可以用 **`config save <路径>`**（日志 `UtilMem:75 - End SaveConfig()`）。它**写到被 `config load` 的那份文件、忽略给定路径**、不生成代码 —— 于是每轮试探从「生成代码 3–4 分钟 + 翻 main.c」缩成「load+save 一轮 + 看它自己写回来的键」。
（耗时后来按族复核过：这台机器上**单次 load+save 98–120 s**，而且保存完进程有时不退出——见 §52。早先记的 25–40 s 偏乐观，别据此设超时。）上面三条坑基本就是这么一条条试出来的。

调用方式（PowerShell 里踩过的坑）：`jre\bin\java.exe` 与 `STM32CubeMX.exe` 直接调，**不要**传 `-Dfile.encoding=UTF-8`（会被 pwsh 拆成 `/encoding=UTF-8` → `ClassNotFoundException`）；日志用 `cmd /c xxx.bat > log 2>&1` 重定向（pwsh 的 `*>` 会写成 UTF-16，read 工具读不了）。脚本命令集合可用 `help` 查（`config load/save`、`project setCustomFWPath`、`generate all_code_in_main`、`generate code <目录>`、`script <file>`…）。

### 32.3 代码落点

- `src/data/ioc-presets.ts`：`PeripheralPinRole` 加 `shared?: { key, ipSignal, ipMode }`；`timerPwm()` / `adc()` 改成产 `signal`（`S_TIM2_CH1_ETR` / `ADCx_IN1`）+ `mode: ""` + `shared`；TIM2/3/4 的 db 信号名逐条写明。
- `src/engine/ioc-plan.ts`：新增 `enableSharedSignal()`（写 `SH.<key>.<n>` 并维护 `ConfNb`，同样的值幂等）；`enablePeripheral()` 对共享信号引脚**删掉 `.Mode`** 再写 SH 块；`validatePeripheralWiring()` 新增 `devicesOfSignal()`（识别 `USART1_TX`、`S_` 前缀、以及 `SH.…` 值里逗号前的 IP 信号），「缺功能表达」的告警改成「既没有 `.Mode` 也没有 SH 块」。
- `test/ioc-plan-units.test.mjs`：TIM2/ADC1 的断言改成 `Signal=S_TIM2_CH1_ETR` / `ADCx_IN1` + `SH.*`；新增「共享信号缺 SH 块要告警」「ADC1 后再加 ADC2 时 `ConfNb=2` 且 `.1=ADC2_IN1,IN1`」「预设自己写出的 SH 不触发告警」三例。

### 32.4 验证

- `npm run build` → exit 0；`npm test` → **577 pass / 0 fail（36 套件）**（原 573 + 新 4 例）。
- 探针工程 `_ioc_probe`（C8T6）：`peripherals=[USART1, TIM2(Prescaler=71,Period=999), ADC1]` 一次写成 38 个键 → `stm32_generate` 成功，`Core/Src/main.c` 里 `MX_USART1_UART_Init` / `MX_TIM2_Init` / `MX_ADC1_Init` 各 3 处，`stm32f1xx_hal_conf.h` 的 UART/TIM/ADC 三个 MODULE_ENABLED 全由 CubeMX 自己打开，cmake 源清单新增 `stm32f1xx_hal_tim.c`、`stm32f1xx_hal_adc.c` 等 4 个。
- 另跑过两次单外设实验：TIM3(PA6) + ADC1(PA1) + USART1 同时激活；TIM2(PA0-WKUP) 单独激活（`MX_TIM2_Init-TIM2`）。

### 32.5 偏差备案

- **F1 官方 .ioc 里没有定时器样例**：CubeMX 安装目录 `db/plugins/boardmanager/boards`（递归）里含 `TIM2.IPParameters` 的 44 份文件中没有一份是 F1（L4 7 / F7 6 / MP1 8 …）；F1 的 12 份板级 `.ioc` 一个定时器都没有。所以 TIM/ADC 的键集**只能拿 CubeMX 当 oracle 实测**，不是抄来的。
- **`RCC.ADCFreqValue` 是脏键**：脚手架模板里写的是 `36000000`，对 F1 非法（ADC ≤ 14 MHz，CubeMX 会报 `Parameter (ADCFreqValue) has invalid value`）。用 ADC 预设时要么把它设成 `12000000`、要么干脆别写；`RCC.ADCPresc=RCC_ADCPCLK2_DIV6` 由预设补上。
- **工具层要重启**：`lib/` 改完后宿主 dsh 进程仍用启动时加载的旧模块（`stm32_ioc_plan` 的 JSON Schema 会把 `peripherals` 剥掉，返回“没有变化”）。验证新引擎要么重启 dsh，要么像本次一样用 node 直接 import `lib/engine/ioc-plan.js`。

## 33. `.ioc` 是正确的 INI 文本：无损写回的规则与实测（2026-10-31）

前提纠正：`.ioc` **不是 XML**，是 Java-properties 风格的纯文本键值文件——首行 `#MicroXplorer Configuration settings - do not modify`，正文是 `Mcu.IP3=USART1`、`PA9.Mode=Asynchronous` 这种 `key=value`。因此「XML 结构损坏 / 属性引号 / 冲突标记」都不是风险；真实风险只有三个：**编码与换行、键集完整度、版本迁移**。这一节写的是第一条（写回字节级正确性）落地的规则与实测数据。

### 33.1 四条规则（照抄 `Wafleem/stm32cubemx_mcp` 的做法，并用官方 504 份 `.ioc` 验证）

1. **换行风格与末尾换行必须原样保留**。读时检测「含 CRLF 就用 CRLF」，写时用同一个分隔符 join；源文件末尾有没有换行也照原样——不做「统一加一个 `\n`」这种看起来很整洁、实际改了字节的事。
2. **没改动就逐字节返回原文**。`renderIocText(text, [])` 直接 `return text`，这是最便宜的 round-trip 不变量，也是发现「顺手整理格式」类回归的第一道闸。
3. **只接受 UTF-8**。用 `new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })` 解码，失败就报错让人另存为 UTF-8；不猜 GBK/ANSI（猜错一次会把整份工程写坏）。`ignoreBOM` 让 BOM 留在字符串里自然往返。
4. **重复键与跨行值不碰**。同一个键出现多次时 CubeMX 只认最后一个，改它等于在打两份不一致的补丁；值里有 Java-properties 续行（行尾奇数个反斜杠）时改第一行会留下续行残骸。两种情况都在计划阶段直接拒绝，并提示「先在 CubeMX 里重新保存一次」。

补充：坏行（既不是 `#` 注释、也没有 `=`）与混合换行（既有 CRLF 又有 LF）给**告警**而不是报错——官方文件里真的存在，不该让用户因为别人的文件风格写不成自己的配置。

### 33.2 官方 504 份 `.ioc` 的实测数据（`D:/app/STM32CubeMX/db/plugins/boardmanager/boards`，递归 depth≤4）

- **504/504 逐字节 round-trip 相同**（读进来再 `renderIocText(text, [])` 写出去，`===` 原文）。
- 换行：**CRLF 497 / LF 7** —— CubeMX 在 Windows 上写 CRLF，我们旧代码强加 LF 是真实偏差（改前会无谓改动 497 个文件的字节）。
- 末尾换行：**26 份文件末尾没有换行**，其余有 —— 两种形态都真实存在，必须原样保留。
- 重复键：**2 份**（`PL1_Nucleo_NUCLEO-WL33CC1_STM32WL33CCV6TR_Board.ioc` 的 `Mcu.Pin5=PA11` 连续两行；`M12_Discovery_STM32MP135F-DK_STM32MP135FAF_BareMetalEnabled_Board.ioc` 的 `Mcu.ContextProject=Bare Metal Enabled` 两行）。
- 折行值（续行）：**3 份**（`K05_Connectivity_Expansion_B-WBA6M-WPAN_STM32WBA6MOIH6_Board.ioc:73`、其 `_AllConfig.ioc:137`、其 `_TrustZoneEnabled_Board_AllConfig.ioc:218`），都是 `ProjectManager.functionlistsort=` 的值被折断，续行形如 `MX_I2C1_Init-I2C1-false-HAL-true,5-MX_I2C3_Init-…`。→ 解析必须支持 Java-properties 续行，否则会把这行当垃圾丢掉、把 `functionlistsort` 截断。

### 33.3 代码落点

- `src/engine/ioc.ts`：新增 `iocLogicalLines(text): IocLogicalLine[]`（`{ line, startIndex, lineCount }`，按「行尾奇数个反斜杠 = 续行」拼接，续行前导空白 `trimStart()`）；`parseIocEntries()` 改为遍历逻辑行，键值仍走 `decodeIocKey`/`decodeIocValue`。
- `src/engine/ioc-plan.ts`：`renderIocText()` 无改动直通、新键插在末尾空行之前、`join(eol)` 不再补 eol；新增 `inspectIocText()`（`duplicates` / `malformedLines` / `multiLineKeys` / `mixedEol` / `finalNewline`）与 `readIocText()`（fatal UTF-8 + 保留 BOM）；`planIocChanges()` 接上四条告警/两条硬闸（重复键、跨行值），并把 `planned` 复用给渲染与变更统计。
- `test/ioc-plan-units.test.mjs`：32 例（新增 9 例：无改动逐字节还原 4 种换行/末尾组合、改键保留 CRLF 且不补末尾换行、新键不吞末尾空行、混合换行告警、GBK 拒绝、坏行告警、重复键拒绝、续行解析、续行拒绝修改）。

### 33.4 验证

- `npm run build` → exit 0。
- `npm test` → **586 pass / 0 fail（36 套件）**。
- 官方 504 份 `.ioc`：round-trip 504/504 相同（见 33.2）。
- 探针工程 `_ioc_probe`（C8T6）：`peripherals=[USART1, TIM2, ADC1]` 写入后 `stm32_generate` 成功，`MX_USART1_UART_Init`/`MX_TIM2_Init`/`MX_ADC1_Init` 各 3 处（详见 §32.4）。

### 33.5 对模板的意义

- 模板里不该出现「重排整个文件」的写法；只允许**逐键写入/替换**，其余行原样保留（现在是这么做的：`buildLineTable` 只改命中的行，新增键按 key 排序插入）。
- 新建工程时 `.ioc` 由 CubeMX 骨架给出（`stm32_project_create` 走的是我们的脚手板模板），我们只改键、不重写文件——所以「模板要不要改」结论是**不用改**：模板提供基线键集，写入走无损通道。

## 34. 诊断工具：`stm32_ioc_verify`（让 CubeMX 自己说它认了什么）（2026-10-31）

### 34.1 为什么要做成工具，而不是只写文档

§32 的三条坑（引脚没进 `Mcu.PinN`、普通外设缺 `<pin>.Mode`、定时器/ADC 缺 `SH.*` 共享信号块）是在本机用 `config save` 一轮轮试出来的。但用户机器上跑的是插件，出问题的现场没有我：只把方法写成文档，等于要求 agent 每次重新发明一遍流程。所以拆成两半：

- **确定性部分进工具**：`stm32_ioc_verify` 把 .ioc 复制到 `.dsh-stm32/verify/<stamp>/`，用无头脚本 `config load` + `config save` 让 CubeMX 写回「它理解的结果」，再 diff 出结构化结论（丢了哪些外设、信号被改成什么、补了哪些 `SH` 块、计划生成哪些 `MX_*_Init`、缺什么的提示）。实测单次 98–120 s（默认超时 180 s），不生成代码，**不动工程里的 .ioc**。
- **判断经验进 skill**：`src/skill/stm32-workflow.ts` 新增「六、外设写了却没生效？先让它自己说（oracle 诊断）」——症状、怎么读 `droppedPeripherals`/`plannedFunctions`/`signalRewrites`/`sharedSignals`/`hints`、三条已知原因的修法，以及「别手改 .ioc / 别把副本覆盖回去 / 别并发跑 CubeMX」的禁令。

### 34.2 工具输出怎么读

- `droppedPeripherals`：我们写了、CubeMX 没认的外设（`before` 的 `Mcu.IPn` 有、`after` 没有）。
- `plannedFunctions`：`after` 的 `ProjectManager.functionlistsort` 里的 `MX_*` —— 等于**不生成代码就预览会生成哪些初始化函数**，最快的判据。
- `signalRewrites`：引脚 `.Signal` 被规范化（`TIM2_CH1` → `S_TIM2_CH1_ETR`、`ADC1_IN1` → `ADCx_IN1`），提示规范名写错了。
- `sharedSignals`：`after` 里的 `SH.<信号>.<n>=<IP 信号>,<IP 模式>`；缺块时它就是标准答案。
- `removedKeys` / `addedKeys`：被删与被补的键（各截 60 条）。
- `hints`：按「没有引脚指向 / 引脚没进 `Mcu.PinN` / 缺功能表达」三类给出的具体修法。

### 34.3 代码落点

- `src/engine/ioc-verify.ts`：纯函数 `diffIocForVerify(beforeText, afterText)`（可离线单测）+ `runIocVerify(subprocess, request)`（复用 `generate.ts` 的 `acquireLock`/`cubeMxLaunch` 单飞锁与启动器、`subprocess-runner.runStreaming`）。
- `src/tools/ioc-verify.ts`：注册 `stm32_ioc_verify`（`projectDir` / `iocPath` / `timeoutMs`，默认 180 s，`isConcurrencySafe: false`）。
- `src/index.ts`：`registerIocVerify(ctx)`。
- `test/ioc-verify-units.test.mjs`：6 例（`plannedFunctionOf`、被丢外设 + 信号改写 + SH 块 + 计划函数、缺功能表达提示、引脚未列进 `Mcu.PinN` 提示、完全没有引脚指向的提示、两边相同则零告警），已加入 `test/run-units.mjs`。

### 34.4 验证与边界

- `npm run build` → exit 0；`npm test` → **592 pass / 0 fail（37 套件）**。
- `runIocVerify` 需要真 CubeMX，单测只覆盖纯函数 `diffIocForVerify`；端到端证据仍是 §32.4 那三次（TIM3+ADC1+USART1、TIM2/PA0、探针工程 38 键）。
- 工具只回答「CubeMX 认了什么」，**不会替你修**：被丢的键是真被删了，副本覆盖回工程等于删配置。

## 35. 把 CubeMX 读 `.ioc` 的规则“照搬”进插件（反汇编 `com.st.microxplorer.importproject`）（2026-11-01）

### 35.1 逻辑在哪：jar 里，不在文档里

`D:\app\STM32CubeMX\STM32CubeMX.exe` 其实是 **227 MB 的 jar**。用 msys64 的 `unzip` 列表/解包，用 CubeMX 自带的 `jre\bin\javap.exe` 反汇编：

```text
D:/app/Git/usr/bin/unzip.exe -l "D:/app/STM32CubeMX/STM32CubeMX.exe" | Select-String microxplorer/importproject
D:/app/Git/usr/bin/unzip.exe -o "D:/app/STM32CubeMX/STM32CubeMX.exe" "com/st/microxplorer/importproject/*.class"
D:/app/STM32CubeMX/jre/bin/javap.exe -p -c -classpath <解出的目录> com.st.microxplorer.importproject.ImportEngine
```

关键类（已解出 23 个，放在 `demo/_cubemx_class`）：

| 类 | 作用 |
| --- | --- |
| `ImportEngine`（抽象） | 总流程：`tryImport` → 引脚/模式分析 → IP 列表分析 → 参数导入 → 诊断 |
| `CompleteImport` | `importConfigAnalysis` / `pinoutAnalysis` / `ipListAnalysis` / `importMode` / `importIpConfig` / `makeDiagnostic` |
| `ImportParameterContext` | 按 IP 名分发：**ADC / DAC / RCC / DMA / NVIC** |
| `ImportADCParameter` | `addRegularConversionRank(int, String)`、`setParamValueWithId(...)`、`getEnableChannel()` |
| `ImportDMAParameter` | 读 `Dma.RequestsNb`（默认 `0`）、按 `:` 切子字段、认 `MEMTOMEM`、`equivalentIpNames`、`isLastCharDigit` |
| `ImportNVICParameter` | 走 `NVICService.loadPriorityGroupConfig(Properties)`、`getVectorsWithoutIp()`，键必须含 `_IRQn` |
| `ImportRCCParameter` | 参数解析：`integer`、`0x`/`0X` 前缀再 `substring` |
| `NvicVector` | 每条中断的字段顺序：`Enable`、`preemptionPriority`、`subPriority`、`configurablePriority`、`systemHandler`、`irqHandlerGenerated`、`enableCodeNeeded` … |

### 35.2 已固化成离线规则（`src/engine/ioc-rules.ts`，`stm32_ioc_plan` 每次都会跑）

| 规则 | 判据 | 为什么（证据） |
| --- | --- | --- |
| **R1** | 有 `Dma.*` 但 `Mcu.IPn` 里没有 `DMA` → **报错** | 实测：缺这一项时 CubeMX 把整组 `Dma.ADC1.0.*` 丢弃 |
| **R2** | `Rank-<id>`/`Channel-<id>`/`SamplingTime-<id>` 要同 id；`NbrOfConversion` 与 Rank 组数一致；Rank 值 1..N 连续 | `ImportADCParameter.addRegularConversionRank` 按 rank 序号建通道 |
| **R3** | `NVIC.<x>_IRQn` 的值必须是冒号分隔 9 段，首段 true/false | `NvicVector` 字段顺序 |
| **R5** | F1 的 `RCC.ADCPresc` 必须是 `RCC_ADCPCLK2_DIV6`（12 MHz ≤ 14 MHz） | 实测生成代码写成 `RCC_ADCPCLK2_DIV2`（36 MHz） |
| **R7** | `<IP>.IPParameters` 是白名单：任何 `<IP>.<参数>` 没列进去 → 告警 | 实测 `TIM2.Prescaler/Period` 因未列进白名单被静默丢弃 |

已被 `stm32_ioc_plan` 其它校验覆盖、不重复：`Mcu.IPNb` 与实际条数一致；外设必须有引脚 `.Signal` 指向；普通外设要 `<pin>.Mode`、定时器/ADC 要 `SH.<信号>.<n>=<IP 信号>,<IP 模式>`。

### 35.3 还没照搬、下一步要做的

- `ImportEngine.tryImport` 的**键分发顺序**（先引脚还是先 IP、`SH.*` 何时生效）——把 `-c` 里 `Properties.getProperty` 的调用点按顺序列出来即可。
- `CompleteImport.pinoutAnalysis` 的**引脚-模式匹配**规则（如何把 `PA8.Signal=GPXTI8` + `SH.GPXTI8.0=GPIO_EXTI8` 合成 EXTI 配置）。
- `ImportRCCParameter` 到底读哪个键设 ADC 预分频（`RCC.ADCPresc` 在我们这里没生效，怀疑它读派生频率而非预分频名）。

### 35.4 验证

- `npm run build` exit 0；`npm test` → **600 pass / 0 fail（38 套件）**，新增 `test/ioc-rules-units.test.mjs` 8 例（R1/R2/R3/R5/R7 正反例）。
- 这些规则是**离线**的（毫秒级），与 `stm32_ioc_verify`（实测 98–120 s 跑 CubeMX）互补：先离线挡住“必被丢”的写法，再用 oracle 复核实际理解。

## 36. 通用 .ioc 规则清单（族无关，来自 CubeMX 字节码 + 实测）（2026-11-01）

目标（用户 m01855）：不只为当前程序服务——把 CubeMX 读 `.ioc` 时会用的规则尽量搬全，换族、换外设都能用。下表全部已在 `src/engine/ioc-rules.ts` 实现，`stm32_ioc_plan` 每次自动跑，告警带 `[Rn]` 前缀。

| 规则 | 判据 | 级别 | 来源 |
| --- | --- | --- | --- |
| R1 | 有 `Dma.*` 但 `Mcu.IPn` 里没有 `DMA` | 错误 | `ImportParameterContext`（DMA 是伪 IP）+ 实测丢整组 |
| R2 | ADC 的 `Rank-<id>`/`Channel-<id>`/`SamplingTime-<id>` 要同 id；`NbrOfConversion` 与 Rank 组数一致；Rank 值 1..N 连续；Rank 有 Channel 配对 | 告警 | `ImportADCParameter.addRegularConversionRank(int,String)`、`setParamValueWithId` |
| R3 | `NVIC.<x>_IRQn` 值必须冒号分隔 9 段且首段 true/false | 告警 | `NvicVector` 字段序 |
| R4 | `<pin>.<后缀>` 的引脚必须出现在 `Mcu.PinN` 里 | 告警 | `ImportEngine` 只按引脚表建模型 + 实测（只写 `PA5.Signal` 不列进表 → 不应用） |
| R5 | F1 的 `RCC.ADCPresc` 必须 `RCC_ADCPCLK2_DIV6`（12 MHz ≤ 14 MHz） | 告警 | 实测生成的 `AdcClockSelection` 曾是 `DIV2` |
| R6 | `SH.<信号>.ConfNb` 必须等于 `SH.<信号>.<n>` 条数；值形如 `<IP 信号>,<IP 模式>`，EXTI 例外 `GPIO_EXTIn` | 告警 | `ImportEngine` 对 `SH.*` 的处理 + 实测 |
| R7 | `<IP>.IPParameters` 白名单：任何 `<IP>.<参数>` 没列进去 | 告警 | 实测 `TIM2.Prescaler/Period` 被静默丢弃 |
| R8 | `Mcu.IPNb` / `Mcu.PinsNb` 与实际条数一致 | 告警 | CubeMX 写盘时自己重算；不一致说明文件被手改 |
| R12 | 引脚只有 `.Mode` 没有 `.Signal`（伪引脚 `VP_*` 除外，`Dma.*.Mode` 这类多段键不算引脚） | 告警 | 实测缺 `.Signal` 时外设不激活 |
| R15 | 外设参数键（`USART2.BaudRate`、`TIM3.Prescaler`…）的实例不在 `Mcu.IPn` 里 | 告警 | `ImportParameterContext` 只给「`Mcu.IPn` 建出来的实例」分发参数，没有实例就没有接收方，键被静默丢弃 |

### 36.1 族相关的那一点点

规则本身族无关，只有两处需要按族给表：

- **ADC 时钟上限**：F1 = 14 MHz（已实现）；其它族未实测，不给结论，避免编数字。要加就加在 `checkAdcClock` 的表里。
- **伪外设集合**：`NVIC`、`RCC`、`SYS`、`DMA`、`USB`/`USB_OTG_*`、`CORTEX_M0..M7`、`FREERTOS` —— 它们出现在 `Mcu.IPn` 但没有自己的引脚，不参与「必须有引脚指向」的校验（`PSEUDO_IPS`）。

### 36.2 已提取的词表（`com.st.microxplorer.importproject`，供以后查）

`_IRQn`、`NO_PIN`、`__NULL`、`_Cube`、`_FS`、`_HS`、`_HIGH`、`_VERY_HIGH`、`ADC_CHANNEL_`（以及 `ADC_CHANNEL_TEMPSENSOR/VBAT/VLCD/VREFINT`）、`ADC_SCAN_DIRECTION_FORWARD/BACKWARD`、`DAC_OUT2`、`Dma.RequestsNb`、`Enable_Timer`、`GPIO_Analog`、`GPIO_Speed`、`HDMI_CEC`、`No_Debug`、`USB_Device`、`USB_HOST`；无点的：`ADC`、`DAC`、`RCC`、`DMA`、`NVIC`、`GPIO`、`TIM`、`SYS`、`master`、`Rank`、`Channel`、`NbrOfConversion`、`NbrOfConversionFlag`、`ScanConvMode`、`ClockSpeed`、`MEMTOMEM`、`Import Mode OK`、`Import Mode Error`、`try to import 2 different configuration in the same IP`。

命令（换机器/换 CubeMX 版本时重跑）：

```text
D:/app/Git/usr/bin/unzip.exe -l "D:/app/STM32CubeMX/STM32CubeMX.exe" | Select-String microxplorer/importproject
D:/app/Git/usr/bin/unzip.exe -o "D:/app/STM32CubeMX/STM32CubeMX.exe" "com/st/microxplorer/importproject/*.class" "com/st/microxplorer/mcu/NvicVector*.class"
D:/app/STM32CubeMX/jre/bin/javap.exe -p -c -classpath <解出目录> com.st.microxplorer.importproject.ImportEngine
```

### 36.3 还没搬的三处（按价值排序）

1. `ImportEngine.tryImport` 的**键分发顺序**（先引脚还是先 IP、`SH.*` 何时生效）——决定我们写文件的顺序是否会踩坑。
2. `CompleteImport.pinoutAnalysis` 的**引脚-模式合成**（`PA8.Signal=GPXTI8` + `SH.GPXTI8.0=GPIO_EXTI8` → EXTI 配置）。
3. `ImportRCCParameter` 里设 ADC 预分频的真实键名（我们现在靠 `RCC.IPParameters` 白名单 + `RCC.ADCPresc` 已能生效，但要确认没有更稳的写法）。

### 36.4 验证

- `npm run build` exit 0；`npm test` → **606 pass / 0 fail（38 套件）**，`ioc-rules-units` 14 例（R1/R2/R3/R4/R5/R6/R8/R12 正反例）。
- 对真实工程 `demo/_rich_hal/richhal.ioc` 跑一遍：**0 error / 0 warning**（修掉 `RCC.IPParameters` 缺 `ADCPresc` 之后）。





### 36.5 R16：引脚名不再靠内置别名表（2026-11-01）

CubeMX 的 db 里同一根脚常带后缀（F103C8 的 `PA0` 是 `PA0-WKUP`、`PC13` 是 `PC13-TAMPER-RTC`、
`PC14/PC15` 是 `PC14-OSC32_IN/PC15-OSC32_OUT`、`PD0/PD1` 是 `PD0-OSC_IN/PD1-OSC_OUT`）。
名字写错 CubeMX 认不到这根脚，整段外设配置会被静默丢弃，所以 `stm32_ioc_plan` 写 `<pin>.Signal` 前必须拿到 db 名。

现在走两条路（`src/engine/ioc-plan.ts` 的 `createPinNameResolver`）：

| 条件 | 引脚名来源 | 报告里怎么体现 |
| --- | --- | --- |
| 本机有 CubeMX 且 `db/mcu/<Mcu.Name>.xml` 存在 | `readMcuFacts` + `resolveDbPinName`（精确 → 去 `-XXX` 后缀） | notes 写「引脚名按本机 CubeMX db 解析（<Mcu.Name>，<DB 版本>）」 |
| 没装 CubeMX / db 里没有这颗 | `ioc-presets.ts` 的 `PIN_DB_ALIASES`（离线兜底，只覆盖 F1 6 根脚） | warnings 明确说「只覆盖 F1 的 6 根带后缀的脚，db 里换过名的话会写错脚」 |

搜索范围来自 `resolveSearchConfig(process.env, {})`：`STM32_CUBEMX_ROOT` 指目录、`STM32_NO_DISCOVER=1` 关自动发现、
`DSH_STM32_NO_CONFIG=1` 不读本机配置（单测就是这么把 db 钉死的）。

**顺带纠正一个数错**：`STM32F103C(8-B)Tx.xml` 里有 **48 个 `<Pin>` 标签，但只有 44 个不同名字**——
`VSS`/`VDD` 各出现 3 次（电源脚在 db 里按球位重复），`parseMcuXml` 早就全部解析到了。
所以「引脚解析 44→48」不是缺陷；测试里钉了一条：解析结果必须覆盖所有不同的 `<Pin Name>`。

验证：`cubemx-db-units` 6 例、`ioc-plan-units` 34 例（新增 4 例：db 优先、别名表兜底 + 告警、
`logicalPinName` 反查、<Pin> 标签重复只算一根）。

### 36.6 R15：参数键指向的外设不在 `Mcu.IPn` 里（2026-11-01）

`ImportParameterContext` 是按「`Mcu.IPn` 建出来的实例」分发参数的。所以 `.ioc` 里写了
`USART2.BaudRate=9600`、`TIM3.Prescaler=71`，但 `Mcu.IPn` 里没有 `USART2`/`TIM3` 时，
这些键**没有接收方**，CubeMX 会静默丢掉——看起来「我明明写了」，生成出来的代码里却没有。

`checkIpInstanceKeys` 只查首段看起来就是外设实例名的键（`ADC/DAC/TIM/USART/UART/SPI/I2C/CAN/USB/SDIO/ETH/RTC/IWDG/WWDG` + 可选数字），
`RCC.` / `NVIC.` / `SH.` / `Dma.` / `Mcu.` / `ProjectManager.` 都不当实例名（`Dma.*` 归 R1 管）。
两级测试：反例（`USART2`/`TIM3` 不在 `Mcu.IPn` → 告警）、正例（齐了不告警，且 `RCC.ADCPresc`/`NVIC.*`/`SH.*` 不误报）；
`ioc-rules-units` 16 例全绿，全量 618 pass / 0 fail。

## 37. gdb MI 常驻会话（P3）（2026-11-01）

**问题**：`stm32_debug_eval` 原来是「每次调用临时起一个 `gdb -batch` → 连上 → 跑几条命令 → detach」，
断点/变量/栈跨调用全丢，每次重连约 1.5 s。排障时想「先断在 HardFault_Handler，再连读几次栈」根本走不通。

**做法**：新增 `src/engine/gdb-mi.ts`（零依赖、可单测）：

- `parseMiLine` / `parseMiValue` / `parseMiTuple`：MI 记录解析（`^done`/`^error`/`*stopped`/`~"…"`/提示符），
  支持 tuple 与 `[frame={…},…]` 结果列表；`decodeMiString` 处理 MI 的 C 转义。
- `MiSession`：`--interpreter=mi2` 常驻进程，带 token 的请求队列；`~"…"` 控制台流挂到当前请求上
  （否则 `print` 的输出找不到归属）；`*stopped` 单独记录；`console`/`evaluate`/`continueTarget`/
  `interrupt`/`stackFrames`/`stop`。
- 握手不依赖 `(gdb)` 提示符：MI 下它不带换行，按行读会永远卡住，所以用 `-gdb-set confirm off` 的 `^done` 当握手。
- `debug-session.ts`：`InternalSession.mi` 懒启动；`eval` 优先走 MI（命令里 `continue` 走 `-exec-continue`，
  默认结尾 `monitor resume`），连不上就静默退回 `gdb -batch` 老路径；`stop()`/`terminateSync()` 先收 MI 再关 openocd。

**实测**（_rich_hal + CMSIS-DAP，gdb-multiarch）：连接 715 ms，之后单条命令：`evaluate $pc` 22 ms、
`stackFrames` 70 ms（3 帧：HardFault_Handler@88 ← signal handler ← main@246）、`console info registers` 25 ms。

**测试**：`test/gdb-mi-units.test.mjs` 7 例（解析 + FakeChild 假进程的排队/控制台归属/*stopped/超时不挂死）；
全量 `node test/run-units.mjs` → 625 pass / 0 fail。

补充：首轮之后又加了 `MiSession.waitStopped(timeoutMs)`（把 `*stopped` 的等待者排队，配合 `-exec-next`
做源级单步），测试增到 8 例，全量 626 pass / 0 fail。

## 38. `_rich_hal` 的 HardFault：根因是 `main()` 少了 `while (1)`（2026-11-01）

**症状**：`demo/_rich_hal` 上电即进 `HardFault_Handler`，用户变量全 0；CFSR 在 `0x100`（IBUSERR）、
`0x400`（IMPRECISERR）、`0x8200`（PRECISERR+BFARVALID）之间飘，`BFAR` 曾读到 `0x20005000`（`_estack`）。

**定位方式**（MI 常驻带来的新手段）：`break main` + `break *HardFault_Handler`，然后连续 `-exec-next`
看每一行停在哪：

```text
main.c:196 → 197 → 198 → 242 → 244 → 251 → 252 → 257
  → Reset_Handler @ startup_stm32f103xb.s:101（bx lr）
  → main.c:244 → 245 → 246 → 248 → 246
  → HardFault_Handler（stm32f1xx_it.c:79，breakpoint-hit）
```

`main.c:257` 是 `main` 的收尾 `}`——**函数返回了**。

**根因**：`Core/Src/main.c` 的 `/* USER CODE BEGIN WHILE */` 区里，ST 模板自带的
`while (1) { … }` 外壳被删掉了（这两行在 ST 模板里属于 USER CODE 区，CubeMX 会原样保留，所以
「重新生成」也救不回来）。于是 `main()` 返回 → 控制流回到 `Reset_Handler` 的 `bx lr` →
栈指针被打回 `0x20005000`（RAM 顶端）→ 下一次给 `rtt_printf` 传 12 个参数时的压栈
（`0x08002652 str.w ip,[sp,#28]` / `0x08002656 str r6,[sp,#24]` / `0x0800266c bl 8002e44 <rtt_printf>`）
写到 `0x20005000` —— 刚过 RAM 末尾 4 字节 → 总线错误 → HardFault。

异常帧（`0x20004fe0` 起 8 字）能对上：`r0..r3=0`、`r12=0`、`lr=0x0800260b`、`pc=0x08002656`、
`xpsr=0xa1000000`。

**这也解释了之前二分的飘忽**：崩不崩取决于 `main` 返回后落到什么状态，跟具体哪个 `MX_*_Init` 无关。

**修复**（都在 `_rich_hal`，非 git 仓库）：

1. 恢复循环外壳：`/* USER CODE BEGIN WHILE */` 后加 `while (1)` + `{`，`/* USER CODE BEGIN 3 */` 后补 `}`。
2. 撤销之前所有二分注释（`HAL_Init`、`SystemClock_Config`、六个 `MX_*_Init`、`rtt_init`、NVIC 使能、
   `HAL_UART_Receive_IT`、`HAL_TIM_PWM_Start`、`HAL_TIM_Base_Start_IT`、`EXTI->SWIER`、裸寄存器写）。
3. **ADC 外部触发缺 `EXTTRIG`**：`.ioc` 里 ADC 是 "Software start"，HAL 不会置 `ADC_CR2` bit20，
   只改 `EXTSEL` 外部触发不生效（这是 ADC 读数恒为 0 的原因）→ 补 `ADC1->CR2 |= (1u << 20);`。
4. 打开 `HAL_ADC_Start_DMA(&hadc1, (uint32_t *)g_adc_dma, ADC_CH_COUNT)`。
5. `DMA1_Channel1->CCR` 由「清 TCIE/HTIE」改成「置位」：`|= ((1u << 1) | (1u << 2))`，
   否则 `g_dma_tc`/`g_dma_ht` 永远不涨。
6. 恢复 PA8 EXTI 的 `HAL_GPIO_Init` + `HAL_NVIC_SetPriority(EXTI9_5_IRQn, 1, 0)`
   （`MX_GPIO_Init_1` 里先 `__HAL_RCC_AFIO_CLK_ENABLE()`，写 `EXTICR` 不会再总线错误）。

**验证**（MI 实机，2 s）：`g_tick_1k=2032`（1 kHz TIM2 节拍）、`g_duty=329`（PWM 跟随 ADC 均值）、
`g_adc_dma = 0,1591,1786,2047`（4 通道扫描 + DMA 搬运）、`CFSR=0`、PC 停在 `main` 循环内。

**遗留**：`g_dma_tc`/`g_dma_ht` 仍只到 1（2 s 内应约 2000），待查（先看 `DMA1_Channel1->CNDTR`
是否在动、`DMA1_Channel1_IRQn` 是否真进、`Dma.ADC1.0.Mode=DMA_CIRCULAR` 是否生效）；
`stm32f1xx_it.c:82-86` 的 `frame[6]` 取值偏移错（恒读 0），要修或删。

**教训**：改 USER CODE 时别把 ST 模板的 `while (1)` 外壳一起删掉——症状是 HardFault 且
`BFAR=_estack`，很容易误判成外设初始化问题。

## 39. RTT dump 首读失步：环缓冲从中间推过来，解析器要能对齐（2026-11-01）

**症状**：重启宿主后按 start → dump 验 `cfc7694`，`dump` 返回 `ok=false bytes=1024 records=0`，
错误是 `帧长度 1836544032 超过上限 4096，通道里很可能不是我们的帧`；同样的固件上一轮
（缓冲还没绕圈时）却 `bytes=1059 records=12` 正常。再复跑一轮（start → 等 2.5 s → dump 2 s）
仍必现。

**根因**：`bytes` 恰好等于通道缓冲大小（1024 = `DEFAULT_RTT_SIZE`）。openocd 的 rtt server
在客户端连上时把整块环形缓冲一次性推过来，而固件（1 kHz 打印 + boot 段日志）的写指针早已
绕过好几圈 —— 首字节落在某条记录中间。`parseRttFrames` 是**严格解析器**：偏移 0 的 4 字节
被当作长度字段（读成 1836544032 级乱码）→ 直接 return error → 整次 dump 判失败。

**修复**（只加在 dump 路径上，纯函数保持严格）：

1. `src/engine/rtt.ts` 新增 `resyncRttFrames(buffer, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES)`：
   从 `offset=0` 起逐字节找第一个「长度在 9..maxFrameBytes、级别在 1..4、剩余字节够整帧」的位置；
   找不到返回 `-1`（那才是真的不是我们的帧）。
2. `collectFromPort` 的 data 处理器里：解出 0 条记录且解析报错时先 `resyncRttFrames`，
   `offset > 0` 就切掉前导垃圾、记一条 note（`开头 N 字节不是帧头…已对齐到帧边界继续读`）再重解。
3. 一条都没解出来时不再立刻收尾：把错误存进 `state.lastError`，等窗口结束再判 —— 窗口结束时
   仍然 0 条才判失败（保留「帧对不上就报错」的语义，`test/rtt-units.test.mjs` 里那条断言不变）。

**测试**（`test/rtt-units.test.mjs`，31 pass）：新增纯函数用例（乱字节前缀 + 两帧，`resyncRttFrames`
返回 `garbage.length`、对齐后两条中文都能解出来；纯垃圾返回 `-1`），以及假 RTT 服务端用例
（首包发乱字节再接两帧，dump 仍 `ok=true`、records 对、notes 里有一句「不是帧头」）。
全量 `node test/run-units.mjs` → **TOTAL pass=631 fail=0**。

**教训**：RTT 通道的「字节流不等于从帧边界开始」——凡是从环形缓冲直读的地方都不能假设
偏移 0 对齐。严格解析器 + 调用侧对齐，比把 resync 塞进解析器更好测也更好读。

## 40. continue/step 等到 `*stopped` 报停点；RTT 中段对齐 + 去重（2026-11-01）

**背景**：`MiSession.waitStopped` 早在 `81586d6` 就有了，但**零调用方** —— `stm32_debug_eval` 里的
`continue` 只回一句「目标已继续运行（要停下就在下次 eval 里先发 monitor halt，或让断点命中）」。
断点命中了也拿不到「停在哪一行」，排障时还是得靠 `-exec-next` 逐行看。

**改动 1（`src/engine/gdb-mi.ts`）**：把 `lastStopped` 变成真正可消费的停止记录。

- `^running`/`*running` 到达时清掉 `lastStopped`：`MiSession.start` 的 `monitor halt` 必留一条
  `*stopped`，不清就会把「上一次停在哪」当成本次 continue 的结果（实测就是这条把单测顶红的）。
- `waitStopped`：有现成停止记录就立刻返回并标记已消费（`this.lastStopped = null`）；排队等到的那条
  也在分发后清空，同一条停止记录不会报两次。
- `continueTarget` 发送前也清一次，避免命令本身没跑起来时留下旧记录。
- 新增 `formatStopLocation(record)`：把 `*stopped` 压成一行
  `main Core/Src/main.c:196 @0x08001234 (breakpoint-hit)`，纯函数、好测。

**改动 2（`src/engine/debug-session.ts`）**：`continue`/`next`/`step` 统一走 MI：

- `continue` → `-exec-continue`，`next|n` → `-exec-next`，`step|s` → `-exec-step`；
  `^running` 之后最多等 `MI_STOP_WAIT_MS = 3000` 的 `*stopped`。
- 停住：`c：已停下 —— main Core/Src/main.c:196 @0x08001234 (breakpoint-hit)（本次 eval 结束会按默认再 resume；要停在那里用 keepHalted=true）`。
- 没停（纯主循环）：`c：目标已继续运行（3000 ms 内没命中断点；要停下就在下次 eval 里先发 monitor halt）`。
- 没跑起来（`^error`）：直接把 gdb 的 `msg` 报出来，不假装成功。

**改动 3（`src/engine/rtt.ts`）**：§39 的 resync 只覆盖「首包偏移 0 失步」；这轮补两头。

- 已经解出过记录、**中段**又出现非帧头字节（环缓冲回绕时很常见）：同样先 `resyncRttFrames`，
  `offset > 0` 就切掉垃圾继续解，note 写「中段 N 字节不是帧头…」；只有整段都找不到帧头才按
  「尾部半帧」收尾。
- 去重：`seen` 集合按 `t|level|text` 记已收过的记录，重复的只计数，收尾时 note「重复记录 N 条…已去重」。
  环缓冲被 openocd 重推时不再让 records 里出现两遍同一行。

**测试**：`test/gdb-mi-units.test.mjs` 10 例（新增 waitStopped 消费语义 + `formatStopLocation`），
`test/rtt-units.test.mjs` 33 例（新增「中段垃圾跳过」「重推去重」两条假服务端用例）；
全量 `node test/run-units.mjs` → **TOTAL pass=635 fail=0**。

**实机验收又抓到一个真 bug（同一天）**：`break main` + `continue` 在**目标已经在 main 循环里**时不可能命中，
于是 3 s 后按「已继续运行」返回（这是对的）；但紧接着的 `next` 卡满 30 s：`-exec-next` 在**运行态**下 gdb 根本不回。
第二轮更糟：目标还跑着，连 `break TIM2_IRQHandler` 这条 console 命令都超时 30 s —— 也就是说原来提示用户的
「下次 eval 里先发 monitor halt」**一样会卡**。

根因：MI 会话是常驻的，而「目标在跑」这件事没有任何地方记着。修法三处：

1. `MiSession` 新增 `private runningState` + `get targetRunning()`：`^running`/`*running` 置 true，`*stopped` 置 false；
2. `console()` 里嗅探 `monitor halt` / `monitor resume`（这两条不产生 `^running`/`*stopped`，运行态只能从命令本身记）；
3. 新增 `async ensureHalted(timeoutMs)`：跑着就发 `-exec-interrupt`（**只有它是异步感知的**，console 命令在运行态会卡），
   失败回滚状态并抛错；`debug-session` 的 eval 循环在**每条命令前**先 `if (mi.targetRunning) await mi.ensureHalted()`，
   日志里记一条「（目标在跑，已用 -exec-interrupt 停下）」。

测试：`gdb-mi-units` 11 例（新增「运行态 ensureHalted 走 -exec-interrupt」「monitor resume/halt 记运行态」
「*stopped 落回停止态」）；全量 **636 pass / 0 fail**。
**教训**：`lastStopped` 是「当前状态」不是「事件队列」——只要把它当缓冲，就必须显式定好
「谁清、谁消费、消费后还能不能看见」，否则断点报告会张冠李戴（而且在单测里比在板子上更容易先炸）。

## 41. RTT dump 在「整块环缓冲」上：已解出的记录不能丢，对齐说明只能有一条（2026-11-01）

真机（C8T6 + `_rich_hal`，环缓冲 1024 字节写满后固件不再写，openocd 每次连上都把整块重推）：

- 现象 A：`stm32_rtt action=dump` 报 `ok=false、bytes=28598、records=0`，`notes` 里
  「开头 929 字节不是帧头…」**重复 27 条**，最后「窗口结束时尾部还有 855 字节的半个帧」。
- 现象 B：`monitor reset run` 让固件重来后再 dump，记录能出来（13 条），但 notes 里
  「中段 42 字节不是帧头」**重复 26 条** —— 每个 chunk 撞一次就 push 一条，纯噪音。

根因两处，都在 `src/engine/rtt.ts` 的 `socket.on("data")` 里：

1. **判定顺序反了**：先判 `parsed.error !== null` 才收 `parsed.records`。而「一条有效帧 + 后面一长串 0」
   是同一次 `parseRttFrames` 的结果（`length=0` 触发失步），于是这次已经解出来的记录跟着被丢掉。
2. **note 在循环里 push**：对齐一次 push 一条，上限 64 次内每个 chunk 都来一遍，把 notes 刷屏。

修法：

- 新增本地 `takeRecords(list)`：统一做「去重（`t|level|text`）→ 按 level 过滤 → maxRecords 收尾」，
  在每次 `parseRttFrames` 之后**先收记录再判 error**。
- 对齐统计改成状态量：`skippedBytes` / `skippedAtHead` / `tailNote`，只在 `finish()` 里
  `notes.unshift("开头|中段 N 字节不是帧头…")` 一条、并 push `tailNote`。
- `for (let guard = 0; guard < 64; guard += 1)` 保留防死循环；不收敛就把剩余字节当垃圾丢掉并记 error。

测试：`rtt-units` 34 例（新增「整块 1024 字节缓冲（垃圾+有效帧+长串 0）时记录不能丢，对齐说明只留一条」，
同一块连推三次，断言 records 只有 1 条、`/不是帧头/` 的 note 恰好 1 条）；全量 **637 pass / 0 fail**。

**教训**：解析器的 `records` 和 `error` 不是互斥的——「读到这里出错」之前读到的数据仍然是有效数据，
API 一旦把两者放在同一个返回值里，调用方就必须**先消费成功部分**，否则每次失步都白丢一批记录。

**补记：重启后复验（同一块板子）与「NUL 尾巴」**

- 重启宿主加载新 lib 后，同样的现场（`monitor reset run` → 2.5 s → `dump seconds=3`）得到：
  `ok=true、bytes=27675、records=13`，notes 只剩两条 ——「中段 1092 字节不是帧头…，已跳过并对齐到帧边界」
  和「重复记录 312 条…已去重」。**27 条刷屏消失，说明聚合生效。**
- 剩下的现象：最后一条记录的文本尾巴挂一串 `\0`（`… adc=2271,2090,2137,2056 dma\0\0…`）。
  根因是环形缓冲回绕：一帧的头在缓冲区末尾、尾在开头，openocd 连上时把整块线性推来，
  于是「头 + 清零/旧数据」被当成完整一帧。修法：`parseRttFrames` 里 `rawText.replace(/\u0000+$/u, "")`，
  测试加 1 例（payload 尾部补 6 个 NUL，断言 `text` 恰好是原文）。
- **已知限制（不修）**：回绕残帧被裁掉 NUL 后文本仍是**半截**（例如停在 `…dma`，少了 `=2998 ht=…`）。
  要彻底解决得让 dump 端知道环大小并按环序重排分片，代价远大于收益；这是 dump 窗口边界上的一条，
  下一块里就是完整记录。文档写清，别让用户以为解析错位。
- 全量：**638 pass / 0 fail**（`rtt-units` 35 例）。

## 42. 变量监视与硬件观察点（P3 续）（2026-11-01）

**需求**：`stm32_debug_eval` 只能一条条敲 gdb 命令 —— 想看「`g_tick_1k` 这一秒涨了多少」
得自己 `print` 两次再心算，想抓「谁在写这个变量」得手敲 `watch` 并自己数还剩几个比较器。
P3 把这两件事做成一个工具：`stm32_watch`。

### 42.1 为什么不塞进 stm32_debug_eval

两条硬理由，都是「语义不同」而不是「代码放不下」：

1. **观察点吃芯片资源**。F1 只有 6 个代码断点 / 4 个数据观察点（`breakpoints.ts` 的
   `F1_BREAKPOINT_BUDGET`），而 `watch` / `rwatch` / `awatch` 是**数据**比较器，和 `break` 抢的
   不是同一份预算。塞进 eval 就没有统一登记表，用户看不到「4 个里用了几个」。
2. **值监视需要「暂停语义」**。目标跑着的时候 gdb 不回任何命令（§40 踩过：连 `-interpreter-exec
   console "break"` 都要卡 30 s）。所以「采样」必须是：在跑就先 `-exec-interrupt` 停住 → 逐项
   `evaluate` → 原本在跑就 `monitor resume` 放回去。这个「临时停一下再放回」不该让用户手写。

### 42.2 数据模型：状态归纯函数，动作归 debug-session

`src/engine/watch.ts`（266 行）**不碰任何进程**，只做登记表与文本：

- `WatchKind = value | write | read | access`；`value` 是「每次 sample 求值」，其余三种是真正的
  硬件观察点（对应 gdb 的 `watch` / `rwatch` / `awatch`）。
- `WatchEntry{id, expression, kind, gdbNumber, lastValue, lastAt, lastError, addedAt}`：`gdbNumber`
  是 gdb 分配的观察点编号，`0` 表示「值监视」或「观察点已失效」。
- `watchState` 是模块级单例（`nextId` 单调递增，删了不回收），所以 id 不会因为删除而串号。
- 去重按 `expression + kind`：同一个表达式既可以当值监视又可以当写观察点，这是有意的。
- `MAX_WATCH_ENTRIES = 32`、`MAX_WATCH_EXPRESSION_LENGTH = 200`；`normalizeWatchExpression` 拒空、
  超长、含换行或 NUL（表达式会被拼进 gdb 命令行，换行等于注入第二条命令）。

真正下达 gdb 的三个方法在 `debug-session.ts`（`DebugSessionManager`），因为它们要复用常驻 MI：

- `sampleWatches({timeoutMs, signal, resume})`：没有会话 / 没有值监视项都给人话；MI 可用时按上面
  的暂停语义逐项 `evaluate`，`recordWatchSample` 写回 `lastValue`（**出错时保留上一次的值**，只写
  `lastError`，免得一抖动整列变空）；MI 不可用时退回一次性 gdb 路径，用 `===DSH:W<id>===` 标记
  分段再 `parseWatchMarkers` —— 和 `readWords` 的标记法同源。
- `addWatchpoints({entries, timeoutMs})`：先按 `resolveBreakpointBudget(projectDir)` 取 data 预算做
  **纯校验**（重复、超预算都在起进程之前拒绝），再 `ensureMi` → 目标在跑先停 → 逐条 `watch`/
  `rwatch`/`awatch` → `parseWatchpointNumber` 取编号 → 装完 `monitor resume`。
- `removeWatchpoints(ids)`：先删登记项，再对 `gdbNumber > 0` 的项在 MI 里 `delete <n>`；MI 已经不在了
  就只提示「旧 gdb 已经没了，登记项已删」，不假装删成功。

### 42.3 两个容易漏的生命周期

1. **会话关闭要清表**：观察点住在 gdb 进程里，`stop()` 之后 gdb 没了，登记表还留着就会骗人。
   所以 `stop()` 在 `this.current = null` 之后调 `resetWatchState()`。
2. **MI 重建要标 stale**：`ensureMi` 发现原 MI 死了会新起一个，此时旧观察点编号全失效。
   `markWatchpointsStale(watchState, reason)` 把 `gdbNumber` 清 0 并写 `lastError`，用户下次
   `list` 就能看到「观察点已随旧进程丢失：重新 action=add」，而不是看到一个永远不命中的编号。

### 42.4 「装成了软件观察点」要告警

`isHardwareWatchpoint(text)` 认 gdb 的 `Hardware watchpoint N:` / `Hardware read watchpoint` /
`Hardware access watchpoint`。目标或表达式不支持硬件比较器时 gdb 会退回软件观察点（单步 + 比较），
那会把 1 kHz 的主循环拖成几十 Hz —— 所以这种情况必须在 `notes` 里说清，不能静默接受。

### 42.5 工具层

`src/tools/watch.ts`（304 行）注册 `stm32_watch`：`action` = `add` / `sample` / `list` / `remove` /
`clear`（缺省 `list`），参数 `expressions` / `kind` / `ids` / `timeoutMs` / `resume`；输出统一
`{ message, report }`，report 带 `entries`（含 `delta`）/ `watchpoints`（used/limit/remaining）/
`halted` / `resumed` / `errors` / `notes`。`action=add` 且 `kind=value` 时**只登记，不需要会话** ——
「先记下我想看什么」和「现在就去读」是两件事。

注册函数叫 `registerWatchTool` 而不是 `registerWatch`：engine 里已经导出了同名的 `registerWatch`，
同一文件里 import 会 TS2440 撞名。

### 42.6 测试

`test/watch-units.test.mjs` 16 例：纯函数（kind 表、normalize 的四种拒绝、register 的去重与上限、
remove/reset、采样分流、`markWatchpointsStale`、`recordWatchSample` 出错保留旧值、`numericWatchValue`
与 `formatWatchDelta`、`parseWatchMarkers` 多标记多行、`parseWatchpointNumber` + `isHardwareWatchpoint`）
+ 工具层（schema 的 required 与 properties 一一对应、空表 `list`、`add` 值监视、重复 `add` 报错、
坏 `kind` / 空 `expressions` / 未知 `action` / `remove` 没给 `ids` 都给人话、无会话 `sample` 干净失败
且不起进程、`clear` 清空）。全量：**654 pass / 0 fail**（41 个套件）。

**教训**：登记表是模块级单例，工具层用例开头必须 `resetWatchState(watchState)`，否则前面用例的
残留会让断言数不对 —— 这类「跨用例共享状态」的测试要显式重置，不能靠执行顺序。

---

## 43. 三处小改进：单指令步进、采样提示、RTT 尾部不再提前收尾（2026-11-01）

### 43.1 单指令步进（si / ni）

`stm32_debug_eval` 原来只认 `n/next`、`s/step`（整行），`si`/`stepi`/`ni`/`nexti` 被当成普通
console 命令发给 gdb —— 目标在跑时照样卡 30 s。现在映射集中在一个纯函数里（`src/engine/gdb-mi.ts`）：

```ts
export function steppingCommandFor(command: string): string | null {
  // n/next → -exec-next；s/step → -exec-step
  // ni/nexti → -exec-next-instruction；si/stepi → -exec-step-instruction
  // continue 不在这里（它要先清 lastStopped）；其余一律 null
}
```

`debug-session.ts` 的 eval 循环用 `isContinue || stepCommand !== null` 判分支，两者都走
「`^running` 之后等 `*stopped`（3 s 窗口）+ `formatStopLocation` 报停点」这条路。

### 43.2 采样提示要区分「目标本来就在停着」

会话刚起时 `MiSession.start` 已经发过 `monitor halt`，所以第一次 `sample` 的 `wasRunning` 是 false。
真机表现：`g_tick_1k` 连采两次 delta 都是 0，而 `g_adc_dma[0]` 照样 +264（DMA 是外设，核停了也搬数）
—— 看着像工具坏了。现在把提示做成纯函数（`src/engine/watch.ts`）并点明原因：

```ts
export function formatWatchSampleNote(halted: boolean, resumed: boolean, targetWasRunning: boolean): string {
  if (!targetWasRunning) return "（目标本来就在停着：值不会变，想看得先 continue 或 monitor resume）";
  if (halted && resumed) return "（目标在跑，已停下采完再放回去）";
  if (halted) return "（目标在跑，已停下采样）";
  return "";
}
```

回退路径（MI 起不来、走一次性 gdb）不加这条提示：那时根本不知道目标原本跑没跑，宁可不说话。

### 43.3 RTT dump 尾部不再提前收尾（顺带修掉一个真 bug）

旧逻辑：解析失步、carry 里找不到帧头、但已经解出过记录时，直接 `finish("window")`。真机上 openocd
会先推「一条完整帧 + 回绕剩下的半条」，于是在这里就收尾了，**后面 chunk 里还能解出来的记录一条都收不到**。
现在改成：只记 `tailError`、把 carry 裁到 `maxFrameBytes + 13` 字节以内，继续等窗口结束；窗口结束时
若 carry 还有残留，note 里带上解析错误原文。

**顺带抓到的真 bug（写这条单测才暴露）**：`resyncRttFrames` 原来作用在整段 `carry` 上，不是
`parsed.rest` 上 —— 刚解出的那帧首字节就在偏移 0，于是 `offset === 0` 永远成立，既不前进也不收尾，
后面的记录全解不出来。改成在 `parsed.rest` 上找帧头，并且：

- `offset > 0` → 累加 `skippedBytes`、从该处继续解析；
- `offset === 0` → 这帧还没收齐，等下一个 chunk；
- `offset === -1` → 真的没有帧头，按尾巴处理。

### 43.4 测试与文档

- `test/gdb-mi-units.test.mjs` 12 例（新增 `steppingCommandFor`，含「continue / print / 空串不是步进」）。
- `test/watch-units.test.mjs` 17 例（新增 `formatWatchSampleNote` 四种组合）。
- `test/rtt-units.test.mjs` 36 例（新增「尾部半条记录之后推来的记录照样要收」，假服务端按 chunk 推）。
- 全量：**657 pass / 0 fail**（41 个套件）。

**教训**：① 「已经解出过记录」不等于「这段窗口读完了」，尾部失步要等窗口结束再判；② resync 的输入
必须是「失步点之后剩下的字节」，拿整段重扫会在偏移 0 命中自己刚解出的帧；③ 提示语要说清「为什么
看起来没动」（核停着），否则用户会以为采样坏了。

## 44. RTT 加固：写侧临界区、丢帧可观测、会话死掉要说真话（2026-11-01）

起因：用户拿来一份 CSDN 问答「JLINK RTT 高速传输怎么不丢数据」的五条对策，问哪些值得做。逐条判：

| 对策 | 判断 |
| --- | --- |
| ① 加大 RTT 缓冲 | 换成「砍通道数」更划算：默认 3 通道 × 1 KB = 3 KB RAM，C8T6 只有 20 KB |
| ② 提高主机读取频率 | **真缺口**：`stm32_rtt` 只有窗口式 dump，窗口外 openocd 不排空环 → 后续做 `follow` |
| ③ 给 RTT 写加互斥锁 | 裸机用关中断就够，做成**弱符号钩子**，裸机/RTOS 两种都能用（本节的 44.1） |
| ④ 调中断优先级 | 不适用：RTT 不走中断，改 SysTick 优先级只会打乱 1 kHz 时基 |
| ⑤ DMA + SWO | 概念错：RTT 是 openocd 经 SWD 读目标 RAM 的环，跟 SWO/ITM 无关（44.3 写清） |

### 44.1 写侧临界区：弱符号 `rtt_lock`/`rtt_unlock`

`templates/register/Core/Src/rtt.c` 与 `_rich_hal/App/rtt.c` 是同一份实现。加两个弱函数：

```c
__attribute__((weak)) uint32_t rtt_lock(void);          /* 返回 token */
__attribute__((weak)) void     rtt_unlock(uint32_t token);
```

默认实现只在 `RTT_HAVE_CMSIS` 下生效：`__get_PRIMASK()` → `__disable_irq()` → 返回旧 PRIMASK；解锁时
`__set_PRIMASK(token)`。RTOS 使用者覆盖成「拿 mutex + 内部再关中断」即可（`rtt.h` 头注释里给了
FreeRTOS 例子）。

三个坑：

1. **`rtt_init()` 会自锁**：它原来直接在 `rtt_write()` 的临界区里被懒调用，如果 `rtt_init()` 自己也拿锁，
   mutex 实现（不可重入）当场死锁。所以拆成内部 `static void rtt_init_locked(void)`（不拿锁）+
   公开 `rtt_init()`（拿锁包一层）。
2. **锁要拿得够小**：`strlen`/`memcpy`/长度与级别字段都可以在锁外算好，锁内只做「写时间戳 + 环写入 +
   失败则 `s_dropped++`」。
3. **时间戳必须在锁内取**：否则两条记录的时间戳可能倒序，dump 端按时间戳去重/排序会乱。

实测：新固件 RAM 27.62%（与改前同，弱函数没多占）、FLASH 36.38%、elf 954504 B；`_SEGGER_RTT` 仍在
`0x20000f88`、`s_dropped` 在 `0x20001000`；dump 出来 `dma` 与 `t` 仍严格 1:1 → 关中断钩子没有破坏
1 kHz 时基。

### 44.2 丢帧可观测：周期日志打 `drop=%u`

`rtt_dropped_count()` 早就存在，但没人看就等于不存在。模板和 `_rich_hal` 的周期日志都加上了
`drop=%u`，dump 一条记录就能读出累计丢帧。

**现象学**（写清楚免得下次误判）：`drop>0` 只有在「环写满 → 宿主把环读走 → 又有新记录落进环」之后才
看得到。环满期间新记录**根本写不进去**（`NO_BLOCK_SKIP`：整条丢弃，不阻塞主循环、不覆盖没读走的数据），
所以现场表现为**内容冻结**：多次 dump 时间戳一模一样、重复记录一大堆、`drop` 不动。要解冻就先
`monitor reset run` 让宿主把环排空。

### 44.3 RTT ≠ SWO（写进头注释，防止再被误开药方）

RTT 是目标内存里的一段环形缓冲 + 控制块（`SEGGER RTT` 魔数），openocd 通过 SWD 读内存取数据；SWO/ITM
是另一套（单线输出、要配 trace 时钟、要 SWO 引脚）。两者唯一的共同点是「都能打印」。所以：

- 调 NVIC 优先级、开 DMA 送 ITM、换 SWO 引脚，对 RTT 丢数据**一点用都没有**；
- 真想少丢，只有三条路：环更大/记录更短、写侧不被打断（44.1）、宿主读得更勤（`follow`）。

### 44.4 会话死掉时别报「目标里没有控制块」

真机踩到的顺序：探针在 openocd 手里报 `hid_write/WaitForSingleObject: (0x000003E5)` +
`CMSIS-DAP command CMD_INFO failed.` → openocd 退出 → `stm32_rtt start` 得到 `ECONNREFUSED`，但旧代码
把任何「读控制块失败」都归到 `HINT_NO_BLOCK`（「目标内存里没有 RTT 控制块」），照着提示改 addr 永远
改不好。

新增 `export function sessionGoneHint(error: string): string | null`：命中
`ECONNREFUSED|ECONNRESET|ECONNABORTED|EPIPE|socket hang up` 就返回「调试会话的 openocd 已经不在了…
先 stm32_debug_stop…反复出现就插拔探针」，`startRtt` 读控制块失败时优先用它。

顺带发现一个**没修的真 bug**（记为待办）：`stm32_debug_session` 的 status 只看自己记的会话对象，
openocd 进程死了它照样回 ok；需要加「会话存活校验」（`EvalRequest` 失败/lsof 端口/proc 名）并按需重建。

### 44.5 测试与文档

- `test/rtt-units.test.mjs` 37 例（新增 `sessionGoneHint`：三种连接类错误都要报「会话没了」，超时和解析
  错误不能误报）。
- 全量 `node test/run-units.mjs` → **658 pass / 0 fail**；`npm run build` + `npx tsc --noEmit` 干净。
- 两份 `RTT.md`（`templates/scaffold/RTT.md`、`_rich_hal/RTT.md`）同步改：不再需要自己在外面关中断、
  给容量公式（1024 ÷ 83 ≈ 12 条 ≈ 2.4 s）、写清 RTT≠SWO、建议打 `drop=`。

**教训**：① 修「丢数据」这类问题，先分清是**写不进**（环满丢弃）还是**没读走**（宿主不排空），两条路
的药方完全不同；② 提示语写错方向比不写更坏（`ECONNREFUSED` 被说成「没有控制块」害人改 addr）；
③ 弱符号钩子是把「裸机能用、RTOS 也能用」落到同一个 API 上的最低成本做法，代价只有一次 PRIMASK 存取。

## 45. 真机抓到的「RTT 丢数据」真因：写偏移没有回绕（2026-11-01）

§44 做完锁钩子和 `drop=` 之后上板验收，结果发现一个**远比锁严重**的问题：RTT 灌满 1 KB 之后
就永久冻结，之后所有记录都被丢弃。

### 45.1 现象（真机数字）

- `stm32_rtt dump seconds=8 maxRecords=40`：收到 `bytes=72725`，却只解出 **12 条**记录，时间戳
  `t=0 → 2792` 之后不再前进；notes 里「重复记录 770 条（时间戳+级别+文本都相同）」——openocd 每隔几
  毫秒把**同一块** 1024 字节推到客户端。
- 同一时刻 `p (unsigned)s_dropped` = 41，而 `p g_tick_1k` = 10521（跑满 10.5 s）→ 环从约 2.8 s 起就
  再也写不进去，后面 7.7 s × 5 条/s ≈ 38 条全被丢。
- 直读控制块描述符（`mdw 0x20000fa0 6`，openocd 的 Tcl 口）：
  `sName=0x08005c14 pBuffer=0x20000388 Size=0x400 **WrOff=0x415** RdOff=0x15 Flags=0`。

**WrOff = 0x415 = 1045 > Size = 1024** —— 这就是根因。

### 45.2 根因

`rtt_ring_write()` 里两处都假定「偏移可以无限增长」：

```c
used = wr - rd;            /* 无符号相减，RdOff 绕圈后 rd > wr 会得到天文数字 */
...
desc->WrOff = wr + len;    /* 发布出去的 WrOff 会 >= Size */
```

拷贝时用了 `wr % size` 所以**数据本身没写错位置**，但发布给宿主的 `WrOff` 却越界了。SEGGER 的约定是
`WrOff`/`RdOff` 永远落在 `[0, Size)`，openocd 按这个区间算「还剩多少可读」，一旦 `WrOff >= Size`：

1. openocd 算出的可用量是错的（本次是 1024，看起来永远「满」）；
2. 它把 `RdOff` 推到 `WrOff` 之后又发现越界，于是**不再推进**；
3. 固件这边 `used` 一直 `>= size` → 每条都丢 → 环永久冻结，只有复位能解。

顺带一个更危险的点：`memcpy(&desc->pBuffer[wr_pos], ...)` 里 `wr_pos` 是取模过的，写入本身没越界；
但 `WrOff` 越界会让后续任何按 `WrOff` 取地址的宿主实现读到缓冲之外。

### 45.3 修复

`templates/register/Core/Src/rtt.c` 与 `_rich_hal/App/rtt.c`（同一份实现）改两处：

```c
/* 偏移一律按 [0, size) 解释，不能直接用无符号相减 */
used = (wr >= rd) ? (wr - rd) : (size - (rd - wr));
...
wr += len;
if (wr >= size) { wr -= size; }   /* 必须回绕，否则对端算不清 */
desc->WrOff = wr;
```

### 45.4 修复后的真机对比

| | 修复前 | 修复后 |
| --- | --- | --- |
| 8 s 窗口解出的记录 | 12 条，`t` 卡在 2792 | **40 条（截断），`t=0 → 8382` 连续** |
| 重复记录 note | 770 条去重 | 无 |
| 描述符偏移 | `WrOff=0x415` 越界 | `WrOff=0x3cd`、`RdOff=0x36e`，都在 `[0, 0x400)` |
| `drop=` 是否可见 | 流冻结，看不到 | 记录里直接打出来（`drop=3` → `drop=36`） |
| 再 dump 一次 | 同一块字节 | `t=8782 → 20163` 继续前进 |

`drop` 仍有增长（20.4 s 累计 36 条）：因为 dump 是**间歇**的——两次 dump 之间没人排空，1 KB 环只装得下
约 2.4 s，超出的按 `NO_BLOCK_SKIP` 丢弃。这正好说明 `s_dropped` 记的是真事，也说明「不丢」只能靠
**持续挂着一个读者**（即待办里的 `follow` 流式读），而不是靠加大缓冲。

### 45.5 教训

① 环形缓冲的读写指针是**协议**不是内部变量：只要有一端按 `[0, size)` 解释，另一端就必须回绕；
② 「内容冻结 + 重复记录刷屏」这种症状要第一时间去读描述符（`mdw` 6 个字），比在宿主侧加多少 resync 都直接；
③ 加大缓冲（CSDN 对策①）在这种 bug 面前完全无效——环更大只会让冻结来得更晚一点。

## 46. follow 流式读、固件侧丢帧计数、会话存活校验、包体护栏改口径（2026-11-01）

§45 收尾时留了三条待办：① `stm32_rtt` 加 `follow`（窗口外不丢）② 会话存活校验（openocd 死了还报 ok）
③ 报告带固件侧 `s_dropped`。这一节把三条做完，另外按用户要求改掉包体护栏的统计口径。

### 46.1 follow：`keepNewest` 而不是「更大的 dump」

`dump` 到 `maxRecords` 就 `finish("truncated")` 提前关连接——恰好把「窗口长」这件事废掉了。follow 复用同一条
采集管线，只改两处：

- `collectFromPort(..., keepNewest: true)`：到上限时 `records.shift()` 丢最旧、继续读；note 只写一次
  「记录超过 maxRecords=N，只保留最新的 N 条」，不再提前收尾。
- `dumpRtt` 的窗口上限从 60 s 放宽到 300 s（仅 follow），失败原因和 dump 共用一张表。

为什么这才是「不丢」的正解：`s_dropped` 涨的根源是「两次读之间没人排空环」（1 KB ≈ 2.4 s），只要窗口内一直
挂着读者，环就不会满。加大缓冲只是把 2.4 s 变成 4.8 s。

### 46.2 固件侧 s_dropped：`p (unsigned)s_dropped`

宿主侧的 `dropped` 是「按 level 过滤掉几条」，跟丢帧无关，容易看错。固件里的 `static uint32_t s_dropped` 才是
「环满丢了几条」：`readFirmwareDropCount()` 走 `debugSessions.eval({ commands: ["p (unsigned)s_dropped"] })`，
正则 `\$\d+\s*=\s*(\d+)` 取数，**读不到就返回 -1**（沿用仓库 0/-1 哨兵风格，不给假数）。代价是目标被停
约 50–100 ms（eval 会 halt → print → resume），所以它是 `readFirmwareDrop: true` 时的额外一步，不是每次 dump 都做。

`src/engine/rtt.ts` 里用 `await import("./debug-session.js")` 动态引入：`probe-session` 已经 import 了
`debugSessions`，静态 import 会把 rtt ↔ debug-session 绑成环。

### 46.3 会话存活校验：openocd 死了不能还报 ok

真机事故：探针 HID 掉线后 openocd 打完 `Listening on port …` 就退出，而 `status()` 只看内存里的会话对象，
于是 `stm32_rtt start` 报「复用已有调试会话」，然后 `read ECONNRESET`。两处补：

1. `probe-session.sessionLooksAlive(info)`：连一下 `tclPort`（没有就 `port`），`isPortBusy(port, 500)`；两个端口
   都是 0 时返回 true（没法判，别在这里误杀）。`ensureSession` 复用前先问它，死了就 `debugSessions.stop(...)`
   后重起，结果里带 `replacedDead: true`，message 前缀「旧会话的 openocd 已经不在了，已重起：」。
2. `DebugSessionManager.start()` 起完会话再确认一次：`aliveProbe(tclPort)` 失败 → 等 300 ms 再试 → 仍失败就
   `terminate()` + `emptyReport(["…Tcl 端口 X 连不上（探针掉线？插拔探针后重试）", tail], "没开会话：openocd 起来后立刻退出")`。
   `aliveProbe` 通过 `configure(subprocess, binDirs, aliveProbe?)` 或 `setAliveProbe()` 注入，单测用假探针。

**踩的两个坑**（都写进单测注释了）：

- 测试里的假 subprocess 的 `waitForExit()` 是 `Promise.resolve()`，第一时间就完成。所以「用 waitForExit 竞速
  判进程有没有当场退出」在单测里恒为真，把 6 个复用用例全弄失败 → 改成连 Tcl 端口 + 可注入探针。
- 单测跑的是 `lib/`：改完 `src/` 不 `npm run build` 就跑去 `node test/*.test.mjs`，看到的是旧行为（这次白查两轮）。

### 46.4 包体护栏改口径：只算运行时资产

用户口径：「md 文档应该被排除在外，因为这本身不算做资产，资产应该是那些在工具使用过程中用到的 xml,ioc 等文件」。
于是 `scripts/pack-size.mjs` 不再对 `templates/**` 总量设限，而是：

```js
const ASSET_EXTS = [".ioc", ".xml", ".ld", ".json", ".cfg", ".svd", ".csv"];
const MAX_TEMPLATE_ASSETS = 40 * 1024;      // 7 个文件实测 16.4 KB
const MAX_TEMPLATE_ASSET_FILE = 24 * 1024;  // 单文件上限，拦大资产
```

报告改成 `模板：66.4 KB，其中运行时资产 16.4 KB / 7 个（上限 40.0 KB；.md 文档与源码不计入资产）`。
`.md`（文档）与 `.c/.h/.cmake`（模板工程源码）都不计入资产，它们由 tarball ≤1.2 MB 那条兜住；二进制/图仍然
由扩展名禁令拦。CI 的 `npm run test:size` 因此从「66.4 KB > 60 KB 失败」变成通过。

### 46.5 测试与教训

- `test/rtt-units.test.mjs` 38 例（+1「keepNewest 只留最新 N 条」：5 帧 + `maxRecords: 2` → `line4/line5`，
  `truncated: true`，note 与 message 都要出现「只保留最新 2 条」，且 `firmwareDropped === -1`）。
- `test/probe-session-units.test.mjs` 18 例（+2：`sessionLooksAlive` 三态；「复用前发现 openocd 已死 → 重起」）。
  测试里新增 `const ALIVE = async () => true; const REUSE_OPTS = { checkPortBusy: NOT_BUSY, checkSessionAlive: ALIVE };`，
  死会话用例用计数探针（第 1 次答死=旧会话，之后答活=新会话）——注入的探针同时喂给 manager 的起后确认。
- 全量：`node test/run-units.mjs` → **661 pass / 0 fail**；`npm run build` + `npx tsc --noEmit` 干净；
  `node scripts/pack-size.mjs` exit 0（包体 714.2 KB / 119 文件，资产 16.4 KB / 40 KB）。

**教训**：① 「时长不够」和「没人读」是两件事——dump 窗口再长，提前收尾也会把它废掉；② 报告里的数字要写清
口径（宿主过滤条数 ≠ 固件丢帧数）；③ 护栏要按「这条规则到底防什么」来定统计口径，别用一个总量数字同时代理
「别塞二进制」和「别写太多文档」两件事。

### 46.6 follow 自动 start + Tcl 连接重试（实机验收时补的）

实机验收第一次就撞到两件事：

1. `stm32_debug_session` 刚起、`stm32_rtt start` 紧接着调用 → `connect ECONNREFUSED 127.0.0.1:6666`，被
   `sessionGoneHint` 报成「openocd 已经不在了」。其实 openocd 只是还没开始 accept：再等一会儿 6666/4444/3333
   三个口都在监听，`p g_tick_1k` 也正常。修法：`readControlBlock` 遇到连接类错误先重试 2 次（间隔 250 ms），
   仍失败才判死；`isConnectRefused()` / `sleepMs()` 放在 `sessionGoneHint` 旁边。
2. `follow` 要求先手动 `action=start`，多一步。改成 `bringUpChannel()`：通道没在跑时自动走「门禁 → ensureSession
   → startRtt」，`addr` 取参数、其次上次 start 记住的地址；起完在 notes 里写「没有 RTT 通道，已自动 start：控制块 …」，
   `replacedDead` 也一并提示。`dump` 与 `follow` 共用这条路径。

**实机验收（`_rich_hal`，2026-11-01，`follow` 窗口 20 s / 15 s）**

| 观测 | 结果 |
| --- | --- |
| `follow seconds=20 maxRecords=30` | ok、30 条、`bytes=11444`、`t=2385363 → 2391151`（连续 6 s 历史），note「记录超过 maxRecords=30，只保留最新的 30 条」 |
| `firmwareDropped` | 11806（自复位起累计，早期环被写坏期间攒下的） |
| 连续两个 15 s follow | `s_dropped` 都是 **11837**，第二个窗口 **delta = 0** |
| 中途 13 s 没客户端 | `t` 从 2414095 前进到 2427269，`s_dropped` 仍不动 → 修好 WrOff 之后 openocd 的 rtt server 自己就把环排空了 |

结论：环不再被写坏之后，持续读的窗口里 `s_dropped` 就是不涨的；§45 里「间歇 dump 仍会丢」主要来自那个越界 bug。
## 47. P1'：把 db 查询接进 .ioc 规则（R13/R14/R17）（2026-11-01）

背景：`src/engine/cubemx-db.ts` 早就能查「这颗芯片有哪些引脚/信号/模式」，但只有 `ioc-plan.ts` 拿它解析引脚名。
这一批把「查到了」变成「拿去判定」，新增三条规则——它们都只读 db，不落盘、不导出任何表。

### 47.1 三条规则

| 规则 | 判定 | 级别 |
| --- | --- | --- |
| R13 | `<pin>.Signal` 必须是该脚在 db 里支持的信号 | 告警 |
| R14 | `<pin>.Mode` 必须是该信号允许的模式（GPIO 查 IOModes，外设查该 IP 的 RefMode 名单） | 告警 |
| R17 | 同一物理引脚被写两份（`PA0` + `PA0-WKUP`）、或同一外设信号挂到两根脚上 | 错误 |

### 47.2 实现要点：CubeMX 的「伪信号」必须放行

`.ioc` 里的 Signal 不是 db 里的名字，直接字符串比对会全是误报。实测四种写法都要容忍：

- `GPIO_Output` / `GPXTI8`：GPIO 模式与外部中断，等价于 db 的 `GPIO`（db 里 PA8 只有 RCC_MCO/TIM1_CH1/USART1_CK/GPIO，**没有 EXTI**）；
- `ADCx_IN1`：db 是 `ADC1_IN1`/`ADC2_IN1`，`x` 是占位符；
- `S_TIM2_CH1_ETR`：db 把共享信号拆成 `TIM2_CH1` 与 `TIM2_ETR`，认前缀；
- `SYS_JTMS-SWDIO`、`RCC_OSC_IN`：和 db 完全一致，精确匹配。

模式名也要归一（`Serial Wire` / `Serial_Wire` / `PWM Generation1 CH1`）。

### 47.3 db 缺失时整体跳过

`checkIocRules(entries, { db, facts })` 的 context 是可选的：`facts === null` 就不跑这三条。理由：没装 CubeMX 或版本不匹配时，
「查不到」不等于「写错了」，把一份本来能用的 `.ioc` 判出问题比不检查更坏。`ioc-plan.ts` 里 `PinNameResolver` 现在多带
`db`/`facts` 两个字段，调用处直接 `checkIocRules(after, { db: pinNames.db, facts: pinNames.facts })`。

### 47.4 实测（真 db：DB.6.0.150）

- `_rich_hal/richhal.ioc`、`templates/scaffold/demo.ioc` → **R13/R14/R17 命中 0**（真工程不能有误报）。
- 故意写坏：`PA9.Mode=Bogus_Mode` → R14（列出 USART1 的合法模式；注意 db 的 RefMode 里还有 `usartBasic` 这种名字）；
  `PA9.Signal=USART9_TX` → R13（并列出该脚真支持的 TIM1_CH2/USART1_TX/GPIO）；
  额外加 `PA8.Signal=USART1_TX` → R17「信号 USART1_TX 同时挂在 PA8、PA9 上」+ R13（PA8 不支持 USART1_TX）。

### 47.5 测试

`test/ioc-rules-units.test.mjs` 23 例（新增 7 例：R13 的四类伪信号放行、R13 非法信号、R13 无 db 跳过、R14 GPIO 模式、
R14 外设 RefMode（临时目录造 `db/mcu/IP/USART-...-Modes.xml`）、R17 同脚两份、R17 同信号两脚）；全量 **668 pass / 0 fail**。

**教训**：① 规则吃 db 之前先想清楚「哪些是 CubeMX 自己的写法」——`.ioc` 的 Signal 是**渲染后的名字**，不是 db 里的原名；
② 每条 db 规则都要有「db 不在就不判」的开关，否则 CI/无 CubeMX 的机器会集体误报。

## 48. P2'：主频上限按 db 判（R18）+ 报告带 db 指纹（2026-11-01）

### 48.1 R18

`RCC.SYSCLKFreq_VALUE`（.ioc 里就是 Hz 数值，`src/engine/ioc.ts:203` 也是这么读的）不得超过 db 的
`<Frequency>`：C8T6 = 72 MHz。恰好等于上限合法（这就是正常配置）。

- 上限**只认 db**，不写死 72：换到 F4/F0 时同一个规则照样成立；
- 没有 db、或 .ioc 里没有 `RCC.SYSCLKFreq_VALUE`（手工精简过的文件）时不判；
- APB1 的 36 MHz 与 ADC 的 14 MHz 属于「派生上限」：ADC 由 R5 管，APB1 暂不在这里判
  （族间上限不同，写死会误报，等有 db 里的总线信息再说）。

实机（真 db）：把 `RCC.SYSCLKFreq_VALUE` 改成 `96000000` → `stm32_ioc_plan` 直接失败：
`[R18] RCC.SYSCLKFreq_VALUE=96000000 Hz 超过 db（STM32F103C(8-B)Tx）的上限 72 MHz = 72000000 Hz`。

### 48.2 db 指纹

`IocPlanReport` 与 `stm32_ioc_plan` 的输出新增两个字段：

- `dbVersion`：例如 `DB.6.0.150`；没找到 db 时是空串；
- `dbRoot`：例如 `D:\app\STM32CubeMX\db`。

**所有返回路径都要带**（包括「没有变化」「失败」）：实现上不是只改成功那条 return，而是在
`createPinNameResolver()` 之后直接写进 `empty` 模板（`empty.dbVersion = pinNames.db?.version ?? ""`），
其余 return 全是 `{ ...empty, ... }`。第一次只改成功路径时，「没有变化」的报告里两个字段是空串——
这正好说明「db 指纹」这种诊断字段必须**无条件**带上，否则用户报 bug 时说不出自己用的哪版 db。

### 48.3 测试

`test/ioc-rules-units.test.mjs` 25 例（+2：R18 超频报错且恰好等于上限不报；缺键/缺 db 不判）；
全量 **670 pass / 0 fail**；`npm run build` + `npx tsc --noEmit` 干净。

## 49. 冗余清理：包瘦身 + 删死代码（2026-11-01）

用户问「插件还有哪些地方是冗余的」，做了一次全仓扫描（89 个 src 文件、24 个工具），结论与动作：

### 49.1 包里的开发文档（最大的一处冗余）

`package.json` 的 `files` 写的是 `docs/*.md`，于是四份文档全进了 npm 包：
`development-notes.md` 375 KB、`reading-guide.md` 94.6 KB、`logic-audit.md` 38.8 KB、`dsh-stm32-plugin-规格.md` 53 KB。
装插件的用户只需要 `reading-guide.md`。

改成 `"docs/reading-guide.md"` 后：**包体 714.2 KB → 522.7 KB，文件 119 → 116**（`scripts/pack-size.mjs` 实测），
`scripts/pack-smoke.mjs` 的必需文件清单本来只要 reading-guide，无需改；`npm run test:pack` 全过。

### 49.2 死导出 11 个

扫法：把所有 `export function/const/class/interface/type` 收集起来，在 **src + test + scripts** 里数引用（含同文件内的使用），
零引用即删除：`regs.describeSample`、`breakpoints.DEFAULT_BREAKPOINT_BUDGET`、`toolchain-gate.gateBlockedMessage`、
`scaffold.DEFAULT_MCU_CUBE_VERSION`、`watch.isSampledKind`、`firmware-install.planOrInstallFirmware`、
`clock-f1.{pllMulFromValue,F1_CLOCK_LIMIT_LABELS,F1_RCC_IP_KEYS}`、`ioc-presets.pinLogicalName`、`toolchain-config.describeToolchainConfig`。
其中 `pinLogicalName` 与 `cubemx-db.logicalPinName` 是同一件事的两份实现，删掉多余那份。

**保留**：`cubemx-db.hasIpInstance` / `cubemx-db.logicalPinName` 目前零引用，但它们是 R19/R15 扩展的预留 API，留着更划算。

### 49.3 顺带清掉的东西

仓库根 11 个 `.tmp-*`（`.tmp-audit*.mjs`、`.tmp-deadcode.cjs`、`.tmp-hal-check*.mjs`、`.tmp-t4-*.mjs`、`.tmp-units.log`、`.tmp-escape-probe.txt`）
全部送回收站——`git ls-files` 确认它们从未被提交。

### 49.4 明确判为「必要」的（别再动）

`zip.ts`（工程导出）、`tar.ts`（HAL 包解包）、`svd.ts`（35 KB，`stm32_regs_read` 的符号名，R20 也要用）、
`msys2-install.ts`（95 KB，一键装工具链）、`web-api.ts`/`web-routes.ts`（Web 面板）、`ioc-presets.ts` 的 `PIN_DB_ALIASES`（db 不可用时的离线兜底）。
每个 engine 模块都能查到真实 import 方，没有孤儿文件（唯一「无 import」的是入口 `src/index.ts` 和 `zip.ts` 的动态使用）。

### 49.5 还没做的结构性合并

三套缓存 UX（`stm32_cache` / `stm32_assets` / `stm32_firmware_install`）、`stm32_env_probe` 与 `stm32_doctor` 的重叠、
24 个工具的样板（`resolveProjectDir` 15 处、`ensureToolchain` 10 处、`baseReport` 9 处）——这些改的是命令名/结构，
要在同一次里同步 `src/skill/stm32-workflow.ts`、README、docs 与测试，单独一轮做。

## 50. 工具合并第一刀：stm32_env_probe → stm32_doctor（2026-11-01）

`stm32_doctor` 与 `stm32_env_probe` 各自调一次同一个 `probeAll()`，一个报「工程/探针现在为什么不能烧」，
一个报「这台机器能编译/烧录/调试/建工程吗」——同一份数据的两种排版。合并后：

- `src/engine/doctor.ts`：`DoctorReport` 增 `capabilities: Capabilities`、`recommendations: string[]`、`searched: string[]`；
  新增纯函数 `capabilitiesOf(tools)`（build = gcc+cmake+ninja、flash = openocd、debug = openocd+gdb、generate = cubemx+cubemx-java）
  与 `recommendationsOf(tools, missingRequired, capabilities)`（缺件按顺序装 + 「需要我帮你装吗」+ CubeMX/JRE 两条提示），都从原 env-probe 搬过来。
- `src/tools/doctor.ts`：schema/`required` 补三个字段，`formatReport` 加一行能力矩阵与「下一步」段。
- 删掉 `src/tools/env-probe.ts` 与 `src/index.ts` 的注册；**工具数 24 → 23**。
- 提示语里的 `stm32_env_probe` 全部改成 `stm32_doctor`（`install-guides.ts`、`debug-session.ts`、`debug.ts`、`msys2-install.ts`、`probe.ts`、`web-api.ts`、`src/skill/stm32-workflow.ts`、README 两份、`docs/reading-guide.md`）。
- `test/schema-guard.mjs`：两个 env_probe 测试改成 `capabilitiesOf`/`recommendationsOf` 的纯函数测试（不 spawn 进程）。

结果：全量 **669 pass / 0 fail**（原 670，两个工具测试换成一个纯函数测试），`pack-size` 通过，工具数 23（README 两处数字同步）。

**教训**：合并「同一份数据两种排版」的工具几乎没有成本，只要把纯逻辑抽成函数；真正贵的是**提示语**——
一个工具名散落在 8 个文件的 hint/verify 字段里，删工具时必须全量替换，否则用户按提示去调用一个不存在的工具。

### 50.1 附注：`stm32_assets` 与 `stm32_cache` **不合并**（2026-11-01，用户拍板）

审计时把这两个工具列成了「三套缓存 UX」的重叠项，但细看是两套完全不同的数据：
`stm32_cache` 管 CMSIS 设备头/启动文件的下载缓存（`cache.ts`），`stm32_assets` 管设备事实资源包
（`device/f1/chips.json` + `.ioc` 模板 + `.ld` + SVD，`assets.ts`）。命令形状像（都有 list/verify/refresh），
底层引擎、缓存目录、失败语义都不同。

**结论：不合并。**「看起来像」不是合并理由——强行合成 `kind` 双后端只会让两套错误语义挤进一个 schema，
用户仍然得知道自己在操作哪份数据。冗余的标准是「同一件事有两份实现」，不是「两个命令长得像」。

同理，`stm32_env_probe` → `stm32_doctor` 之所以该合，是因为它们**跑的是同一个 `probeAll()`**，那才是真冗余。

## 51. P3'-C4：纯时基定时器预设 `TIM<n>:timebase`（2026-11-01）

只想「每 1 ms 进一次中断」时，`TIM2/3/4` 的 PWM 预设会顺手占掉 CH1 引脚——对纯时基来说那是噪音。
新增一种「变体预设」写法：`peripherals: [{ name: "TIM3:timebase" }]`。

- `src/data/ioc-presets.ts`：新增 `timerBase(name)`（`pins: []`，参数 Prescaler=71 / Period=999 / CounterMode=UP /
  ClockDivision=DIV1 / AutoReloadPreload=DISABLE，72 MHz 下正好 1 kHz）；`findPeripheralPreset()` 识别 `:timebase` 变体，
  `peripheralPresetNames()` 里也列出来，用户报错时能看到这个写法。
- `enablePeripheral()` 对空 `pins` 本来就能工作（循环不执行、仍会写 `Mcu.IPn` 与 `<IP>.IPParameters`），无需改动。
- 测试：`test/ioc-plan-units.test.mjs` +1 例（TIM3:timebase → 只写 TIM3 参数、`Mcu.IPn` 含 TIM3、引脚数不变且不出现 TIM3 引脚）；
  全量 **670 pass / 0 fail**。

**教训**：同一实例名要两种用法（PWM / 纯时基）时，别加第二个同名预设（`findPeripheralPreset` 只会命中第一个）；
用「实例名:变体」的写法让查找函数自己决定，既不动老名字也不制造歧义。

## 52. P3'-C5：多 Rank ADC 预设 `ADC1:1,4,5`（2026-11-01）

键的形状照抄 ImportADCParameter 的结论：每条转换占三个同下标键，`NbrOfConversion` 等于条数，Rank 从 1 连续。

- `src/data/ioc-presets.ts`：`ADC_PIN_BY_CHANNEL`（F103C8 的 IN0–IN9 → PA0/PA1/PA4/PA5/PA6/PA7/PB0/PB1）+ `adcMulti(name, channels)`；
  写法是 `peripherals: [{ name: "ADC1:1,4,5" }]`，由 `findPeripheralPreset()` 解析 `/^[0-9]+(,[0-9]+)*$/` 变体生成，
  通道去重、只接受这张表里存在的通道（不认识的通道直接返回 null，报错里会列出 `ADC1:1,4,5（多 Rank，通道号列表）` 的写法）。
- 每路引脚用 `ADCx_INn` 共享信号 + `shared` 块，`enableSharedSignal()` 自动写 `SH.ADCx_INn.0/ConfNb`；
  `RCC.ADCPresc=RCC_ADCPCLK2_DIV6` 照旧带上（F1 的 ADC 上限 14 MHz）。
- 测试：`test/ioc-plan-units.test.mjs` +1（`ADC1:1,4,5` → `NbrOfConversion=3`、Rank-0/1/2 = 1/2/3、Channel-n = ADC_CHANNEL_1/4/5、
  三个 `ADCx_INn` 信号、三个 `SH.*.ConfNb`）；全量 **671 pass / 0 fail**。

**注意**：单路 ADC 还是老预设（`ADC1`），多路用新写法——`findPeripheralPreset` 只命中第一个，别造同名第二条。

## 54. P4'-上半：SVD 中断表 + R20（2026-11-01）

发现：本项目的「SVD」不是 ARM 的 `.svd` XML，而是资源包里我们自己的 JSON（`parseSvd()` 读 JSON）。原来只有外设/寄存器/位域——没有中断表，R20 无从下手。

**插件侧（本次）**

- `src/data/svd.ts`：新增 `export interface SvdInterrupt { name; value }`；`SvdDevice` 加 `interrupts` 与 `interruptNames`；
  `parseSvd()` 在构造 `device` 前解析 `parsed["interrupts"]`（非数组/条目不合法就跳过，老资源包没有这个字段→空表）。
- `src/engine/ioc-rules.ts`：`IocRuleContext` 加 `interrupts?: ReadonlySet<string>`；新增 `checkNvicNames()`（R20，告警）：
  `NVIC.<NAME>_IRQn` 的 NAME 不在中断表里就提示「CubeMX 会忽略这条，生成代码里不会有对应 NVIC 使能」。没有中断表时整条跳过。
- 测试：`ioc-rules-units` +1（坏名字报 R20、好名字不报、没给中断表不判）；全量 **673 pass / 0 fail**。

**还没做**：① `ioc-plan.ts` 把 SVD 中断名传进 `checkIocRules`（要先把 `Mcu.CPN` 的 STM32F103C8T6 换成 SVD 的 line "103"）；
② 资源包 `dsh-stm32-assets` 的生成器要写 `interrupts` 字段；③ C6（`entries` 写的标量键自动补进 `<IP>.IPParameters`）。

## 53. P3'-C3：DMA 预设 `DMA:ADC1`（2026-11-01）

`Dma.*` 的键名是 `Dma.<外设>.<n>.<字段>`，跟预设的 `<ip>.<参数>` 规则对不上，所以给预设加了 `rawEntries`：
逐字写入、不进 `IPParameters`。八字段照 `ImportDMAParameter` 的顺序：
`Instance / Direction / PeriphInc / MemInc / PeriphDataAlignment / MemDataAlignment / Mode / Priority`。

- `src/data/ioc-presets.ts`：`dmaPreset(ip, channel)`（ADC 用半字对齐 + `DMA_CIRCULAR` + MINC；预设的 `ip` 就是 `DMA`，
  这样 `Mcu.IPn=DMA` 由 `enablePeripheral` 自动补上——缺它 CubeMX 会把整组 `Dma.*` 丢掉，R1 规则专盯这条）；
  写法 `peripherals: [{ name: "DMA:ADC1" }]`，`ALLOWED_DMA_IP` 限定在外设 DMA 请求表内的实例。
- `src/engine/ioc-plan.ts`：写 `rawEntries` 后按实际 `Dma.<IP>.<n>` 组数重算 `Dma.RequestsNb`；
  另外修了一个小坑——`parameters` 为空时不再写空的 `<ip>.IPParameters=`（否则 DMA 这种无参预设会留一个空键）。
- 测试：`test/ioc-plan-units.test.mjs` +1（`ADC1:1,4,5` + `DMA:ADC1` → 八个字段、`RequestsNb=1`、`Mcu.IPn` 含 DMA、无 error）；
  全量 **672 pass / 0 fail**。
补记（同一天，用户第三次重启后实机验 `a77528b`/`7bcd2ee`）：

- `stm32_rtt action=follow addr=0x20000f88`（**既不先 debug_session，也不先 rtt start**）→ ok、8 条、`t=2793184 → 2794581`，
  notes 三条：「没有活跃会话，先起了一个调试会话（gdb 端口 3333，tcl 端口 6666）」「没有 RTT 通道，已自动 start：控制块 0x20000f88，通道端口 9090」「记录超过 maxRecords=8，只保留最新的 8 条」，`firmwareDropped=13611` → 自动 start 端到端成立。
- 手动 `Stop-Process` 杀掉 openocd（模拟探针掉线）后：`stm32_rtt start` 回 ok、notes 出现「旧会话的 openocd 已经不在了（tcl 端口连不上），已清理并重起」→ 死会话自动重起成立。
- 但同一时刻 `follow` 直接失败（`连不上 RTT 通道端口 9090：connect ECONNREFUSED`）—— `bringUpChannel` 只看了内存里的 `rttStatus().running`。**修**：`running` 为真也要先 `isPortBusy(port, 300)` 探一次通道端口，连不上就当通道已死、走「清理 + 重起」那条路，并写 note「RTT 通道端口 N 连不上（openocd 多半已退出），清理后重起」。这条要等下次重启才生效。


## 55. P4'-C6：`<IP>.IPParameters` 自动补齐（2026-11-01）

以前 `entries` 里直接写 `<IP>.Prescaler=71` 而不把它列进 `<IP>.IPParameters` 时，R7 只会**告警**，
但 CubeMX 那边是真**静默丢弃**。这次改成主动补齐：写盘前扫一遍，把实例下所有标量键补进白名单，
并在 notes 里说明补了哪些——`自动补 TIM3.IPParameters：Prescaler、Period（不补会被 CubeMX 静默丢弃）`。

**关键限制**：只补真外设实例（`/^[A-Z]+[0-9]+$/`，例如 ADC1/TIM3/USART1）。`NVIC`/`RCC`/`SYS`/`DMA`
是「伪实例」——它们的键（`NVIC.TIM2_IRQn`、`RCC.SYSCLKSource`）不在 IPParameters 白名单里，补进去反而写错。
第一次实现漏了这条判断，直接打挂 `clock-units` 两例 + `ioc-plan-units` 一例，加守卫后恢复 **673 pass**。

注：C6 目前靠既有 plan 用例回归覆盖（没有专门的新用例），下一步补一条「entries 写 TIM3.Prescaler 但没列白名单 → 自动补上」的断言。
## 56. P4' 收尾：资源包带 interrupts + R20 实测 + C6 专测（2026-11-01）

### 56.1 资源包侧（`dsh-stm32-assets` 提交 `5b5e6c6`，VERSION → `2026.11.01-1`）

`scripts/svd-f1.mjs`：`parseSvd()` 解析顶层 `<interrupt><name/><value/>`；`buildSvdDoc()` 的**两个输入分支**都写入 `interrupts`；
`renderSvdDoc()` 输出 `"interrupts": [...]` 段。`scripts/build-assets.mjs` 把 `parsed.interrupts` 传进 `buildSvdDoc`。

生成的条数：F100 57 / F103 67 / F107 61 条（F103 去重后 60 个不同名字）。

**踩的坑（三小时变三分钟的教训）**：`buildSvdDoc(input)` 里有个三元分支——`input.deviceName` 存在时走 `input` 分支，
而 `build-assets.mjs` 恰好传了 `deviceName`。我先只改了另一支（`parsed` 分支），所以产物里永远是空数组；
改对后再看：`parseSvd()` 单独调用一直是对的（67 条），问题从头到尾都在**装配层**。教训：先确认「数据源解析对不对」，
再确认「传给渲染器的对象里有没有这个字段」——两步都用一个 3 行脚本就能证，别猜。

### 56.2 R20 实测（用真实 SVD 数据，不是假数据）

```
SVD 103 中断数 = 60，含 TIM2 = true，含 TIM9 = false
R20 命中：NVIC.TIM9_IRQn 的中断名 TIM9 不在 SVD 的中断表里：CubeMX 会忽略这条，生成代码里不会有对应的 NVIC 使能
```

`NVIC.TIM2_IRQn` 不报（真实存在），`NVIC.TIM9_IRQn` 报（F103 没有 TIM9）——规则与数据都对上了。

### 56.3 C6 专测（补上 §55 缺的那条）

`test/ioc-plan-units.test.mjs` +1：`peripherals: [{name:"USART3"}]` + `entries: [{key:"USART3.BaudRate", value:"9600"}]`
→ 断言 `USART3.IPParameters` 里出现 `BaudRate`，且 notes 有「自动补 USART3.IPParameters」。全量 **674 pass / 0 fail**。

### 56.4 还差最后一步（设备侧）

插件与资源包都在仓库里了，但**本机装的是旧资源包**（`2026.10.31-1`）。要真机生效：
`stm32_assets refresh`（拉到 `2026.11.01-1`）→ 重启宿主（插件 lib 也要重载）→ 在 `.ioc` 里塞 `NVIC.TIM9_IRQn` 跑 `stm32_ioc_plan`，
报告里应出现同一条 R20。
## 57. R20 真机验收：发现并修掉 9 条内核异常误报（2026-11-01）

资源包刷到 `2026.11.01-1` 后第一次在真工程上跑 R20，结果 **`_rich_hal/richhal.ioc` 直接刷出 9 条假警报**：
`NVIC.BusFault_IRQn`、`HardFault`、`MemoryManagement`、`NonMaskableInt`、`PendSV`、`SVCall`、`SysTick`、`UsageFault`、`DebugMonitor`。

根因：SVD 的 `<interrupt>` 只列**器件外设**中断，Cortex-M 内核异常不在里面；而这些键在 `.ioc` 里永远合法。
修法：`src/engine/ioc-rules.ts` 加 `CORE_EXCEPTIONS` 白名单（9 个内核异常名），命中即跳过。

修后同一次检查：**R20 命中 1 条**——只有手工注入的 `NVIC.TIM9_IRQn`（F103 确实没有 TIM9），
工程自带的 TIM2/USART1 等一个都不报。全量 **674 pass / 0 fail**。

**教训**：规则用外部数据（SVD）判定「名字是否存在」时，必须先想清楚这份数据**覆盖不到什么**——
内核异常、厂商伪信号、CubeMX 渲染名都属于这一类；先跑一遍真工程，比先写单测更容易发现这类盲区。

## 58. 逆向 CubeMX 写侧 → 修 GPIO 默认属性与 DMA 三件套（2026-11-01）

动机：`ioc-plan` 一直是「按我们理解的 .ioc 格式拼键」，正确性只能靠 `ioc_verify`（CubeMX config load+save 回写再 diff）证伪，
且三个结构性问题——只能证伪不能证明、一次 25–40 s 太贵、差异归因不清。于是分三路取证：javap 反汇编（写侧真值表）、
db/boardmanager 语料（504 份 .ioc 实测分布）、现有生成器（我们写了什么），再做三源比对。

### 58.1 真值表（`.dsh-stm32/cubemx-re/jar.md`，约 80 键/键族，带 类#方法 证据）

落盘链路唯一：`mxsystem.ProjectFactory#saveConfigFile` → `db.DbConfProperties#store` → `com.st.components.util.SortedProperties`。
所以**文件键序 = 字符串字典序**（`Collections.sort` + `String.compareTo`），我们的写调用序对结果没有影响——这条推翻了先前「块序」的猜测；
`#<date>` 时间戳行被 `StripTimeStampOuputStream` 删掉，CRLF + ISO-8859-1 + 反斜杠转义，因此零 diff 在原理上可行。
`<IP>.IPParameters` 成员序 = `LinkedHashMap` 插入序（**不是**字典序，也不是 db 序），所以只能照抄用户给的顺序；
`RCC.IPParameters` 是例外，`Collections.sort` 后字典序。共享信号引脚（`SH.*`）不写 `.Mode`；无信号引脚只写 `.Locked` 就 return。

### 58.2 语料实测（504 份板级 .ioc，跨 4.5.0–6.15.0）

- `GPIOParameters` 最常见值：`GPIO_Label`（14,357 次）、`GPIO_Label,PinAttribute`（3,546）、`GPIO_Label,GPIO_Speed,GPIO_PuPd,GPIO_Mode`（2,400）。
  **默认属性不写**是常态（14k 对 2.4k）；只有用户改过才出现 Speed/PuPd/Mode。
- 含 DMA 的 17 份文件里：`Dma.RequestsNb` 17/17、`Dma.Request<i>` 17/17、`Dma.<IP>.<n>.RequestParameters` 共 64 处；
  F4 的参数是 9 段（多 `FIFOMode`），MDMA 22 段、L4/L5/WB/MP1 16–23 段——**名单必须覆盖该组实际写了的每个字段**（83 个 request 里 0 处不符）。
- 我们的 `src/` 里只有 `Dma.RequestsNb`，另外两类键全仓库 0 命中 → DMA 极可能被 CubeMX 整组静默丢弃。

### 58.3 改动（未发版）

1. **GPIO 只写非默认属性**（`src/engine/ioc-plan.ts` `addPin()`）：label 为空 / speed=`low` / pull=`none` 时不写对应键，
   `GPIOParameters` 只列真正写了的名字；原来是无条件写 `GPIO_Label,GPIO_PuPd,GPIO_Speed` 三项。
2. **DMA 三件套**（同文件入库块）：按 `Dma.<IP>.<n>.<field>` 归组，写 `RequestParameters`=`DMA_PARAM_ORDER` 过滤后的实写字段名，
   写 `Dma.Request<i>`=<IP>（i 从 0 按首次出现序），清理多余 `Request<i>`，最后 `RequestsNb`=组数。
3. **DMA 通道中断**：Instance 形如 `DMA[12]_Channel<n>` 且缺 `NVIC.<Instance>_IRQn` 时补
   `true:0:0:false:false:true:false:true:true`（实测 CubeMX 6.15.0/F1 保存时会自己加这一条，不补就永远差一条键）。
4. **新规则 R21**（`src/engine/ioc-rules.ts` `checkDmaRequests()`）：缺 `RequestParameters`、名单漏字段、
   有组无 `Dma.Request<i>`、条数不符、值与该组 IP 名不符，分别 error/warning。

### 58.4 验收

- 单测：`npm run build` 后 `node test/run-units.mjs` → **678 pass / 0 fail**（原 674 + 4）；`tsc --noEmit` 干净。
- **GPIO 真机零 diff**：复制 demo.ioc → `planIocChanges({pins:[{pin:"PA5",label:"led2",signal:"output"}]})` → `applyIocPlan` → `runIocVerify`：
  `durationMs=62358`，`droppedPeripherals/addedPeripherals/addedKeys/removedKeys/signalRewrites` 全空，PA5 四行回写后逐字不变。
- **DMA 真机零 diff**：`peripherals:[{name:"ADC1:1"},{name:"DMA:ADC1"}]` → 第一轮 `durationMs=75917`，只剩
  `addedKeys=["NVIC.DMA1_Channel1_IRQn"]`（`Dma.*` 三件套逐字保留、ADC1 认了）；补 §58.3.3 后复跑 `durationMs=62280`，四项 diff 全空。

**教训**：验证脚手架里那段最小 `SubprocessService`（`spawn` 把 `java` 映射到 `D:/app/STM32CubeMX/jre/bin/java.exe`，
`readFrom()` 返回累计文本）可以直接复用，不必为了跑一次 `runIocVerify` 去起宿主。

## 59. 按三源比对（abc-diff）修真机零 diff 的四类破绽（2026-11-01）

§58 的三路取证产出 `.dsh-stm32/cubemx-re/abc-diff.md`（A 16 / B 9 / C 13），B 表是「我们写、CubeMX 不这么写或写法不同」，
其中 4 条会直接毁掉字节级零 diff；C 表里挑出 1 条会让人误判「零 diff」的盲区。逐条核实后动的是这 4 + 1：

1. **键排序必须是纯字典序**（`src/engine/ioc-plan.ts` `compareIocKeys()`）。真值 :`com.st.components.util.SortedProperties`
   =`java.util.Properties` + `Collections.sort` + `String.compareTo`；语料 6.x 266 份里 261 份（98.1%）满足 `sort(decode(key))`。
   旧实现按「数字段比数值」排，`Mcu.Pin10` 会排到 `Mcu.Pin2` 之前——≥10 个引脚/外设时整段错位。
2. **值开头的空格要转义成 `\\ `**（`encodeIocValue()`）。`Properties#store` 对 `escapeSpace` 的首字符空格写 `\\ `，
   不转义则 CubeMX 读回时前导空白被吃掉（`ProjectManager.DeviceId=" xyz"` 这类）。
3. **ADC 分频与 `RCC.ADCFreqValue` 必须同步**（`src/data/ioc-presets.ts` 预设块 + `adcPrescalerDiv()`）。
   预设写 `RCC.ADCPresc=RCC_ADCPCLK2_DIV6` 却留着模板里 ÷2 的 `RCC.ADCFreqValue=36000000`，自相矛盾；
   语料里 `RCC.ADCPresc` 只有 4 份，但 4/4 都满足 `ADCFreqValue == APB2/分频`——CubeMX 自己维护这个不变量。
   现在按 `APB2Freq_Value` 重算并写回，同时把 `RCC.IPParameters` 按字典序重排（`clock-plan.ts` 的 `mergeIpParameters` 本来就 sort，两处终于一致）。
4. **纯 LF 的 .ioc 只告警不静默**（`planIocChanges()`）。CubeMX 写 CRLF + ISO-8859-1；
   写回沿用源文件行尾（`dominantEol`）才不会首次 `apply` 就整文件变换行，但这样「逐字节零 diff」对 LF 源永远不可达——
   所以明确告警，别让人以为已经对齐。
5. **`ioc_verify` 新增 `changedValues`**（`src/engine/ioc-verify.ts` `diffIocForVerify()`）。
   原来只比键存在性（`removedKeys`/`addedKeys`）和引脚信号，**键还在、值被 CubeMX 改写时零 diff**，
   这类最常见（token 改名、派生频率重算）反而看不出来。现在逐键比值，报告 `{key,before,after}`（截 60 条），
   并进 `message`（「另有 N 个键的值被改写」）与终端渲染。

### 59.1 真机证据

- **ADC 预设（`ADC1:1`）**：`durationMs=70753`，`dropped/added/removed/signalRewrites` 全空；候选与 CubeMX 回写快照逐字比对：
  `RCC.ADCFreqValue=12000000`、`RCC.ADCPresc=RCC.ADCPCLK2_DIV6`、`RCC.IPParameters` 的字典序名单完全相同——CubeMX 保留了我们重算的值。
- **`changedValues` 正例**：把副本里的 `RCC.SYSCLKFreq_VALUE` 从 72000000 改成 64000000 → `durationMs=63234`，
  `changedValues=[{"key":"RCC.SYSCLKFreq_VALUE","before":"64000000","after":"72000000"}]`，其余 diff 全空。
  CubeMX 自己把派生时钟改回 72 MHz，我们抓到了——证明这条检测不是空跑。
- 单测：`npm run build` + `node test/run-units.mjs` → **681 pass / 0 fail**（原 680 + changedValues 1 条）。

### 59.2 判过但不改（留证据，免得下次又当缺口报）

- **`<pin>.Locked` 恒写 true 不是伪 diff**：语料 24,990 个 `Locked=true`、`Locked=false` **0 个**（497 文件）——CubeMX 只在锁定时写，我们恒写 true 与它语义一致。
- **`entries` 的键名校验已够用**：`planIocChanges` 已拒绝空键、含 `=` 的键、值里有换行的键（`ioc-plan.ts:957-968`）；
  再往前一步就得有完整 schema（真值表）才能判「这个键 CubeMX 认不认」，现在加只会造噪声——打错的键由 R7（IPParameters 白名单）和 R20（NVIC 名）兜住。
- **DMA 通道 NVIC 的 9 段值**与真机一致（`true:0:0:false:false:true:false:true:true`，§58.3.3 实测回写零 diff），B8 不动。
- **`<IP>.IPParameters` 成员序推不出来**（jar 的 U2：35% 与任何推导都不符，`LinkedHashMap` 插入序取决于 db 加载与改参历史），只能照抄用户给的顺序；B5 不修，留作已知限制。

## 60. 补 C 表的两个功能缺口 + 表达力缺口：中断、EXTI、开漏/初始电平（2026-11-02）

§59 之后 abc-diff 的 C 表还剩 11 条（CubeMX 会写、我们不写）。其中 2 条是功能缺口、1 条是表达力缺口，
其余是键序/自动补全这类不影响生成正确性的边角。本轮按「先把缺的功能补上」处理这三条 + 一条必须修的真 diff：

- **C1：非 DMA 外设的 `NVIC.<IP>_IRQn` 从来不自动写**。以前想开 USART1 中断只能自己往 `entries` 里手拼 9 段值，
  拼错就是静默不使能（R3 只能事后抓「段数不对」，抓不到「值合法但语义错」）。
- **C10：`pins` 完全写不出 EXTI 链路**。EXTI 不是一个键，是四件套 + 按线号选中断组：
  `<pin>.GPIOParameters` 里要有 `GPIO_ModeDefaultEXTI`、`<pin>.GPIO_ModeDefaultEXTI=GPIO_MODE_IT_FALLING`、
  `<pin>.Signal=GPXTI<line>`、`SH.GPXTI<line>.0=GPIO_EXTI<line>` + `SH.GPXTI<line>.ConfNb=1`、`NVIC.EXTI*_IRQn`。
- **C13：`pins` 写不出开漏与初始电平**（`GPIO_Mode=GPIO_MODE_OUTPUT_OD`、`PinState=GPIO_PIN_SET/RESET`）。
- **Mcu.Pin 排序错**：以前新脚一律追加到尾部，而 CubeMX 按 db 的 `<Pin Position>` 升序插、`VP_*` 恒在最后。

### 60.1 新 API（`src/engine/ioc-plan.ts`）

```ts
interface PinAddRequest {
  pin: string;
  signal?: "input" | "output";
  label?: string;
  pull?: "none" | "up" | "down";
  speed?: "low" | "medium" | "high";
  outputType?: "pp" | "od";              // 新增：od 写 GPIO_MODE_OUTPUT_OD（C13）
  initial?: "low" | "high";              // 新增：high 写 PinState=GPIO_PIN_SET（C13）
  interrupt?: "rising" | "falling" | "both"; // 新增：一次写全 EXTI 四件套 + NVIC（C10）
}
interface IocPlanRequest {
  // …
  interrupts?: string[];                 // 新增：["USART1:2:0", "EXTI9_5"]（C1）
}
```

默认值一律不写（这是「非默认才写」的一贯口径，不是省事）：`outputType` 缺省即 pp → 不写 `GPIO_Mode`；
`initial` 缺省即 low → 不写 `PinState`。理由在 §60.2 的第 1 条：CubeMX 自己也不给普通输入脚写 `GPIO_MODE_INPUT`。

**`interrupts` 的值格式** `<name>:<preempt>:<sub>`（`2:0` 就是 preempt=2、sub=0，可省成 `USART1`→`true:0:0:…`），
渲染成 R3 要求的 9 段：`true:<preempt>:<sub>:false:false:true:true:true:true`。`<name>` 必须是本机 db 里该 MCU 的实例名
（`USART1` 可以，`USART1:1` 是另一套「预设名」写法、不在这里用）。`EXTI<n>` 这种写法由 `pins[].interrupt` 按线号自动选组（`EXTI0`/`EXTI1`/`EXTI2`/`EXTI3`/`EXTI4`/`EXTI9_5`/`EXTI15_10`），不要手写组名——线号与组对不上 R23 会告警。

### 60.2 真机取证（CubeMX 6.15.0 无头 `config load` + `config save`，逐轮 50–77 s）

四轮探针（脚本在 `demo/.dsh-stm32/`，每轮都是「改副本 → 让 CubeMX 回写 → 逐键 diff」）：

1. **`pins` 不把脚列进 `Mcu.PinN` 时，写在脚上的键全被删**。第一轮只往 `entries` 里塞 18 个引脚键（不给 `pins`），
   回写后 18 个键**一个不剩**——CubeMX 只保留引脚表里存在的脚。这解释了为什么以前「手拼引脚键」偶尔像生效、偶尔完全没反应。
2. **输入脚不写 `GPIO_Mode`，CubeMX 不会替我们补 `GPIO_MODE_INPUT`**（`PA1` 回写只剩 `GPIOParameters=GPIO_PuPd`、
   `GPIO_PuPd=GPIO_PULLUP`、`Locked`、`Signal=GPIO_Input`）。所以「默认不写」与真值一致，不是漏写。
3. **`PinState` / `GPIO_MODE_OUTPUT_OD` 逐字保留**（`PA6`、`PA3` 都验过）→ C13 两个字段真能表达，且 CubeMX 不规范化。
4. **写在脚上的 `GPIO_*` 属性键必须同时列进该脚的 `GPIOParameters`，否则被静默丢弃**。反例：`PC13-TAMPER-RTC.PinState=…`
   而 `PC13-TAMPER-RTC.GPIOParameters` 只列了 `GPIO_Label` → `PinState` 被删。这条现在是规则 **R22**。
5. **EXTI 四件套 + `NVIC.EXTI*_IRQn` 全部逐字保留、`addedKeys=[]`**（`PA0→GPXTI0`（`EXTI0`）、`PA5→GPXTI5`（`EXTI9_5`）、
   `PA10→GPXTI10`（`EXTI15_10`）三组都验过，含优先级）→ C10 与「线号→中断组」映射成立。完整性检查是规则 **R23**。
6. **`NVIC.USART1_IRQn=true:0:0:false:false:true:true:true:true` 逐字保留**（`dropped=[]`）→ C1 的 9 段编码被真机确认。
7. **`Mcu.Pin<i>` 的顺序 = db `<Pin Position>` 升序，`VP_*` 恒最后**。四轮回写后的顺序都一致：
   `PC13-TAMPER-RTC, PC14-OSC32_IN, PC15-OSC32_OUT, PD0-OSC_IN, PD1-OSC_OUT, PA1, PA3, PA5, PA10, PA13, PA14, VP_SYS_VS_Systick`。
   db 里 `PA1@11, PA3@13, PA5@15`（`STM32F103C(8-B)Tx.xml`），`Position` 本来就在 `readMcuFacts()` 的 `facts.pins` 里，
   所以 `sortPinsByPosition()` 不需要新解析，只是把「追加」换成「按 Position 插入」。

### 60.3 `GPIOParameters` 的成员顺序：靠语料定，不靠猜

同一组属性，CubeMX 写出来的顺序是 `GPIO_Speed → PinState → GPIO_PuPd → GPIO_Label → GPIO_ModeDefault* → GPIO_Mode`，
和我们原来写的（`GPIO_Label` 打头）不同。这个顺序不能从 jar 里读出来（`LinkedHashMap` 插入序取决于 db 加载与改参历史），
所以改用**语料统计**（脚本 `demo/.dsh-stm32/gpio-param-order-v6.mjs`）：扫 `<CubeMX>/db/plugins/boardmanager/boards` 下 504 份板级 `.ioc`，
按 `MxCube.Version` 分组——**只有 6.x 的 266 份（11808 条 `GPIOParameters`）能当权威**，4.x 的 238 份顺序不同（`GPIO_Label` 在前），
把两代混在一起统计会得到自相矛盾的全序。6.x 里两两先后计数全是 0 反例（如 `GPIO_Speed<GPIO_PuPd` 376/0、`GPIO_PuPd<GPIO_Label` 694/0、
`GPIO_Label<PinAttribute` 3608/0），才敢定成全序写进 `PIN_ATTRIBUTE_ORDER`。

教训：**凡是「键名对、值对、但 CubeMX 回写不一致」的差异，先怀疑顺序/规范化，再去语料里按版本分层统计**；
拿真机一轮 70 s 去试顺序，性价比极低（一轮只能证伪一种排列）。

### 60.4 `autoAddedFunctions`：把「它自己补的」和「我们写错的」分开

真机回写里唯一无法消除的差异是 `ProjectManager.functionlistsort`：CubeMX 保存时会给新使能的外设追加
`3-MX_USART1_UART_Init-USART1-false-HAL-true`。**决定不写这个键**——它给每个外设的初始化函数名后缀并不统一
（`USART1→MX_USART1_UART_Init`，`TIM2→MX_TIM2_Init`），猜错会把生成顺序写坏，而它自己补的格式永远正确。

所以 `ioc-verify` 增了 `autoAddedFunctions`：只有当 `functionlistsort` 的变化是**纯追加**
（前缀条目逐字相同、新条目全部匹配 `/^[0-9]+-MX_[A-Za-z0-9_]+_Init-[^,]*$/u`）时，才把它从 `changedValues` 摘出来单独报；
删条目、改值仍然留在 `changedValues` 里当差异。这样「零 diff」的判据不会被一条我们故意不写的键长期污染，
也不会因此掩盖真差异。

### 60.5 验收（真机，`demo/.dsh-stm32/accept-exti.mjs`）

输入：`pins` = `PA6`（开漏 + 初始高 + 标签 `led_od`）、`PA5`（上拉输入 + `interrupt: falling` + 标签 `btn`）；
`peripherals` = `USART1`；`interrupts` = `["USART1:2:0", "EXTI9_5"]`。

- 第一次跑（`durationMs=68084`，顺序修复前）：`removedKeys/addedKeys/droppedPeripherals/addedPeripherals/signalRewrites` 全空，
  只剩 3 条值差异 —— 两条 `GPIOParameters` 顺序 + 一条 `functionlistsort`。`Mcu.Pin` 顺序此时已与 db 一致。
- 第二次跑（`durationMs=74852`，顺序 + `autoAddedFunctions` 修复后）：**`removedKeys=[]`、`addedKeys=[]`、`changedValues=[]`、
  `signalRewrites=[]`、`droppedPeripherals=[]`、`addedPeripherals=[]`**，`autoAddedFunctions` 1 条（它自己的）。
  回写快照里 `PA5.GPIOParameters=GPIO_PuPd,GPIO_Label,GPIO_ModeDefaultEXTI`、`PA6.GPIOParameters=PinState,GPIO_Label,GPIO_Mode`、
  `PA6.GPIO_Mode=GPIO_MODE_OUTPUT_OD`、`PA6.PinState=GPIO_PIN_SET`、`PA5.Signal=GPXTI5`、`SH.GPXTI5.0=GPIO_EXTI5`、
  `SH.GPXTI5.ConfNb=1`、`NVIC.EXTI9_5_IRQn=true:0:0:false:false:true:true:true:true`、
  `NVIC.USART1_IRQn=true:2:0:false:false:true:true:true:true`、`Mcu.Pin5..11=PA5,PA6,PA9,PA10,PA13,PA14,VP_SYS_VS_Systick`。
- 单测：`npm run typecheck` 0 错、`npm run build` 通过、`npm test` → **693 pass / 0 fail**（691 + `autoAddedFunctions` 2 条）。

### 60.6 判过但不动

- **`ProjectManager.functionlistsort` 不写**（理由见 60.4）。它是已知且已单独报告的差异，不是缺口。
- **`outputType: pp` / `initial: low` 不写键**：语料里 `GPIO_MODE_OUTPUT_PP` 116/2657 个输出脚、`GPIO_MODE_OUTPUT_OD` 0 个
  （开漏只能靠真机验，语料给不出证据——这也是本次必须上真机的原因），CubeMX 自己只在非默认时写。
- **AF 脚不写 `GPIO_Mode`**：1265 个 AF 脚里只有 5 个带 `GPIO_Mode=GPIO_MODE_AF_PP`、23 个带 `GPIO_ModeDefaultPP`，
  默认一律不写（与 CubeMX 一致）。
- **AF 脚的开漏（`GPIO_MODE_AF_OD`）仍写不出**，是已知限制：`pins[].signal` 只有 `input`/`output`，`outputType: od` 只在
  `signal !== "input"` 时写 `GPIO_MODE_OUTPUT_OD`（`ioc-plan.ts:599-601`），没有「AF 信号 + 开漏」这条路径。
  需要时用 `entries` 直写 `<pin>.GPIO_Mode=GPIO_MODE_AF_OD` **并**把 `GPIO_Mode` 加进该脚的 `GPIOParameters`（R22），否则会被静默删。

## 61. S5 第一步：.ioc 真值表（schema）+ `ioc_verify` 差异归因（2026-11-02）

### 61.1 动机：从「猜格式」到「按表渲染」

生成器一直是「按我们理解的 .ioc 格式逐键拼字符串」（`ioc-plan.ts` 里 39 处 `entries.set` 大多是字面量），
正确性只有一个证伪手段：`stm32_ioc_verify` 让 CubeMX 回写再 diff。这条路有三个结构性毛病：

1. **只能证伪不能证明**：diff 空了只说明「这一种组合没被丢」，换一个外设/引脚/版本还得再跑一轮。
2. **一次 25–40 s**：真机往返太贵，逼得人一批一批塞键，出错时又分不清是哪一条。
3. **差异归因不清**：同一个「非零 diff」可能来自行序、CubeMX 的规范化，或我们写错——原来的报告只给 `removedKeys`/`addedKeys`，
   人得自己去副本里逐行看。

所以这一步的产物不是「又修了几个键」，而是**真值表**：实体 → 键名（含索引拼接）→ 写序 → 值编码 → 触发条件 → 证据。
生成器写键名从此只有一条路：`renderIocKey(id, params)`。

### 61.2 三源证据 + 版本绑定

每条 spec 的 `evidence` 都指向这三源之一（真值表不写「我觉得」）：

| 源 | 取到的东西 | 落在哪 |
| --- | --- | --- |
| 反编译（exe 核心 + 插件 jar） | 序列化类里 `ldc` 的键字面量、写键顺序、条件分支 | `demo/.dsh-stm32/cubemx-re/jar.md`（318 行，带行号引用） |
| 真机回写（无头 `config load` + `config save`） | 值编码是否逐字保留、哪些键会被静默删 | docs §58/§60 + 本轮 §61.8 |
| 504 份板级语料（`db/plugins/boardmanager/boards`） | 键出现率、成员序、索引连续性、值 token 全集 | docs §60.3 |

**版本绑定写进文件头注释**：CubeMX 6.15.0 / DB.6.0.150 / STM32CubeFW_F1_V1.8.7。换版本要重跑语料统计与探针，
否则「真值表」就是过期的真值表（这是比没有表更危险的状态）。

### 61.3 表的结构：48 条 spec（§61.11 收尾后 49 条）

`src/data/ioc-schema.ts`（约 30 KB）：类型 → `SPECS`（48 条 JSON 字面量；§61.11 收尾后 49 条）→ 编译与查询函数。

- 三个枚举：`entity`（mcu / pin / shared-signal / nvic / dma / peripheral / rcc / project）、
  `valueKind`（count / index / bool / enum / csv / nvic9 / hz / text）、
  `order`（dictionary / insertion / sorted-members / index / sequence）。
- 占位符：`{pin}`、`{index}`、`{ip}`、`{name}`、`{n}`、`{signal}` 按值取参；`{*}` 是**命名空间兜底**（不取参）。
- 对外 API：`compileIocKeyTemplate`、`IOC_SCHEMA`、`iocSpecById`、`matchIocKey`、`renderIocKey`、
  `iocSchemaCoverage`、`describeIocKey`。

**匹配优先级（踩过坑）**：一开始只按「`{name}` 最宽、`{*}` 次之」排序，结果 `RCC.IPParameters` 被
`{ip}.{name}`（`periph.parameter`）抢走了——键形状一样，归因就错了。改成三条一起排：

0. 以字面量开头、没有 catch-all（`Mcu.Pin{index}`、`NVIC.{name}_IRQn`、`{pin}.Signal` 之外都是）；
1. 以字面量开头、带 catch-all 的命名空间兜底（`RCC.{*}`）；
2. 以占位符开头的通配模板（`{ip}.{name}`、`{pin}.Signal`、`{ip}.IPParameters`）。

同级再按**字面量字符数降序**：`RCC.IPParameters`（16）压住 `{ip}.IPParameters`（13），
而 `USART1.IPParameters` 根本匹配不上 `RCC.IPParameters`，自然落到 `{ip}.IPParameters`。

**时钟派生键不抄一遍**：`RCC.*Freq_Value` 有几十个，且由 `clock-plan.ts` 计算，逐条登记只会让表迅速过期。
用一条 `rcc.derived`（`RCC.{*}`）兜住，值仍由 `clock-plan` 负责。

### 61.4 生成器接线 + 覆盖率闸门

`ioc-plan.ts` 里所有写键名的地方改成 `renderIocKey(...)`：引脚表（`Mcu.Pin{i}`/`Mcu.PinsNb`）、`addPin()` 的
`GPIOParameters` 与各属性键（经 `PIN_ATTRIBUTE_SPEC` 白名单，未登记属性名直接抛错）、`pin.Locked/.Signal/.Mode`、
`ensureSerialWire()`、`applyInterrupts()`、`enableSharedSignal()` / `enableExtiSharedLine()`、`enablePeripheral()`
（`Mcu.IP{i}`/`Mcu.IPNb`、DMA 三件套、`IPParameters`、`RCC.ADCFreqValue`/`RCC.IPParameters`）。

计划生成后再跑一道**覆盖率闸门**：`iocSchemaCoverage(after.keys())` 有未覆盖键就 push 一条 `[SCHEMA]` 告警
（「N 个键不在 .ioc schema 真值表里……拼错的键会被 CubeMX 静默忽略，确认后请补进 `src/data/ioc-schema.ts`」）。

**为什么只告警不失败**：老工程模板里常带着上一代 CubeMX 的键，硬失败会让「只想改一根引脚」的调用直接卡死；
硬闸门放在单测里（`test/ioc-schema-units.test.mjs` 断言夹具 `demo.ioc` 与 plan 产物 0 未覆盖）。

### 61.5 已知盲区（写下来，免得下一轮当成新发现）

覆盖率闸门只能拦**形状上不可能存在**的键。任何带点号的键都会被 `{ip}.{name}` 兜住——
比如拼错的 `TIM3.IPParamters` 会被认成「TIM3 的一个普通参数」，覆盖率 100%。
这类错误只能靠真机 `ioc_verify` 的 `removedKeys` / `addedKeys` 暴露（CubeMX 回写时把它删掉）。
这也是为什么归因升级（§61.6）和 schema 必须同期做：一个负责「写对」，一个负责「证明写对了」。

### 61.6 `ioc_verify` 差异归因

`IocVerifyDiff` 新增 `misorderedKeys` 与 `attribution`：

| 桶 | 含义 | 判据 |
| --- | --- | --- |
| `orderOnly` | 值相同、行序不同（CubeMX 按自己的顺序重排） | 两边都有的键按 after 位置求**最长保序子序列**，不在子序列里的就是被重排的（共同键 >1500 时退化为位置比较） |
| `valueNormalized` | 值只是成员顺序/空白被规范化，语义不变 | 空白折叠相等，或逗号切分后排序集合相等（≥2 个成员） |
| `valueChanged` | 值真被改 | 上面两条都不成立 |
| `missingKeys` / `addedKeys` / `droppedPeripherals` / `autoAddedFunctions` | 与旧字段一致，只是并到一个对象里 | — |
| `benign` | 零实质差异 | `dropped===0 && removed===0 && added===0 && valueChanged===0 && signalRewrites===0` |

配套改动：
- `message` 拆成四个后缀（真改写 / 仅重排成员序 / 仅行序 / 它自己补的清单），不再把三者糊成一句「值被改写」。
- 工具 `format()` 末尾加结论行：**「结论：零实质差异（只有行序/成员序的规范化）」** 或「结论：有实质差异，见上面各条」。
- 新增提示：`removedKeys` 里有 `NVIC.<IP>_IRQn` 且该 IP 不在 CubeMX 认的外设表（`Mcu.IPn`）里时，明说
  「先启用外设再开它的中断，否则中断键会被静默丢弃」（`EXTI*` 向量例外，不提示）。这是 §61.8 第一次真机跑出来的坑。

### 61.7 模板化当晚就抓到两个真 bug

1. **`NVIC.EXTI0_IRQn_IRQn`**：`nvic.vector` 的模板是 `NVIC.{name}_IRQn`，而 `extiIrqName(line)` 返回的名字**自带** `_IRQn`
   → 渲染出双后缀。这是把字面量换成模板时最典型的错，而当时真机探针**抓不到**它：探针里写的是字面量字符串。
   现在 `test/ioc-schema-units.test.mjs` 有一条回归：plan 产物里任何键都不许匹配 `/_IRQn_IRQn/u`。
2. **`renderIocKey("rcc.derived")` 渲染出 `"RCC."`**：catch-all 只该用于识别，不该用于渲染。改成直接抛错。

教训写进流程：**「把字面量改成模板」这类重构，必须配一条「产物形状自查」测试**（0 未覆盖 + 禁止双后缀），
只靠真机往返验不出来——它在真机上同样会「静默丢弃」，看起来只是又一个零 diff。

### 61.8 真机验收（CubeMX 6.15.0 无头，`demo/.dsh-stm32/s5-verify.mjs`）

两轮，第二轮才是正确用法：

1. **只给 `interrupts: ["USART1"]`、不给 `peripherals`** → `removedKeys=["NVIC.USART1_IRQn"]`、
   `dropped=[]`、`benign=false`。原因：USART1 不在 `Mcu.IPn` 里，CubeMX 把它的中断向量静默删了。
   → 顺手把这个因果做成了 `hints`（§61.6），并补了单测。
2. **`peripherals:[{name:"USART1"}]` + `interrupts:["USART1"]` + `pins`：`PA6`（开漏 + 初始高 + 标签 `led2`）、
   `PA0-WKUP`（上拉 + `interrupt: falling`）+ `serialWire: true`** →
   `plan` 33 个键改动、`durationMs=44036`、
   **`addedKeys=[]`、`removedKeys=[]`、`changedValues=[]`、`signalRewrites=[]`、`orderOnly=[]`、`valueNormalized=[]`**，
   `autoAddedFunctions` 1 条（它自己的 `3-MX_USART1_UART_Init-USART1-false-HAL-true`），`benign=true`。

第二轮同时证明了 §60 的 `Mcu.Pin<i>` db-Position 排序是对的（`orderOnly` 为空 = 行序与它一致）。

### 61.9 单测与包体

- 新增 `test/ioc-schema-units.test.mjs` 8 例：表形状（48 条、id 唯一、三个枚举合法、证据/写者齐全）、
  `compileIocKeyTemplate`、`matchIocKey` 具体优先、`renderIocKey` 四种拼错抛错、覆盖率分层、
  夹具 `demo.ioc` 0 未覆盖、真 plan 产物 0 未覆盖 + 无双后缀 + schema 键真的落地。
- `ioc-verify-units` 9 → 16 例（`orderOnly`、纯插入不算重排、`valueNormalized`、`valueChanged`、
  三个旧字段与新桶一致、`isIocValueNormalized` 边界、中断被删提示 + EXTI 不误报）。
- `node test/run-units.mjs` → **708 pass / 0 fail**（41 → 42 个套件；§61.12 收尾后 714）；`node scripts/pack-size.mjs` →
  包体 550.0 KB（上限 1171.9 KB，117 个文件，解包 1747.8 KB），运行时资产 16.4 KB / 7 个（上限 40.0 KB）。

### 61.10 判过但不动 / 下一步

- **DMA 参数键与 `Mcu.IPn` 正则仍留字面量**：`Dma.<ip>.<n>.<name>` 是 `prefix` 拼的、`/^Mcu\.IP\d+$/u` 是形状扫描（不是写键）。
  它们被覆盖率闸门兜住，改动收益低于风险，留到下一增量一起收拾。
- **差异样本仍截 60 条**（`KEY_SAMPLE_LIMIT`）：归因也只是分类，不打算把 500 行差异全吐给模型。
- **不新增规则编号**：schema 覆盖率用 `[SCHEMA]` 前缀，而不是编成 R24——它描述的是「我们的表」，不是 CubeMX 的行为约束。
- S5 的剩余部分（`ioc-plan` 全量 schema 化收尾）留到用户开启的下一阶段。

### 61.11 S5 收尾：字面量清零 + 覆盖率闸门分层（同日续）

§61.5 和 §61.10 记的两个盲区，这一轮一起收了：生成器里残留的手拼键名，以及「覆盖率 100% 却证明不了键名对」。

**为什么原来的覆盖率闸门证不了事**（先把话说透，不然下一轮又会把绿钩当成证据）：
`{ip}.{name}` 这条模板会把**任何**带点的键都兜住。实测把 `demo.ioc` 的 112 个键按命中强度分层，
namespace 级占了 **59 个**（exact 15 / shape 38 / namespace 59），构成是 `ProjectManager.*` 41 个、
`RCC.*` 19 个，加上 `CAD.formats`/`CAD.pinconfig`/`CAD.provider`/`File.Version`/`GPIO.groupedBy`/
`Mcu.ThirdPartyNb`/`Mcu.UserConstants`/`MxDb.Version`/`PinOutPanel.RotationAngle`。同一条模板同时冒充了
三种东西：「IP 参数」「工程配置组」「未知引脚属性」。504 份 board 级语料也印证了这一点：
`{ip}.{name}` 的 ip 位有 276 种不同前缀，除了 RIF/PCC/Mcu/DDR_CTRL_PHY/NVIC1/ADC1 这些真实例，
**引脚名也出现在 ip 位**（PB9 30 行、PB6 28、PB7 28、PC12 20、PE0 19）——未知引脚属性同样落进 `periph.parameter`。

**表的变化（48 → 49 条）**：

- `rcc.derived`：`RCC.{*}` → `RCC.{member}`（`{member}` = `[A-Za-z0-9_]+`）。两个好处：
  `renderIocKey("rcc.derived", { member: "SYSCLKFreq_VALUE" })` 现在拼得出键名，生成器不必再手写 `"RCC." + x`；
  且「RCC.」这个命名空间本身被钉住（`RCCF.X` 不再命中）。代价是原来「全通配不会缺占位符」的行为没了，
  单测里那条 `assert.throws(… /catch-all/)` 改成断言缺 `{member}` 抛错 + 渲染正确。
- 新增 `project.manager_key` = `ProjectManager.{name}`（writer `null`）：把工程配置组从 `periph.parameter` 里分出来，
  否则「这个前缀是不是真外设」这个判据永远被 ProjectManager 污染。证据：语料 65 行 / 2 份（34 个不同成员），
  真工程 `demo.ioc` 里 41 个键。

**命中强度由模板形状自动推导**（不加表字段——49 条各写一遍 `tier` 一定会写漏）：

| tier | 判据 | 例子 |
| --- | --- | --- |
| `exact` | 模板里没有占位符 | `Mcu.PinsNb`、`RCC.IPParameters` |
| `shape` | 占位符都带边界（`index`/`n`/`ip`/`member`），或自由文本占位符后面还有字面量 | `Mcu.Pin{index}`、`{pin}.Signal`、`NVIC.{name}_IRQn`、`Dma.{ip}.{n}.RequestParameters` |
| `namespace` | 自由文本占位符（`{pin}`/`{name}`/`{signal}`）且以它结尾 | `{ip}.{name}`、`Dma.{ip}.{n}.{name}`、`SH.{signal}.{n}` |

于是闸门分两道：`iocSchemaCoverage` 返回 `{covered, strong, weak, uncovered, specIds}`（strong = exact/shape，
weak = namespace）；weak 的键再过 `auditIocKeys(keys, context)` 按上下文逐条判，六种 verdict：

1. `ok`：真外设 + 参数名在 db 的 `<RefParameter>` 清单里 / 已知伪命名空间 / exact·shape 级；
2. `unknown-parameter`：实例是真的，参数名不在清单里（`USART1.Baudrate`）；
3. `inactive-instance`：db 里这颗芯片有这个实例，但 `Mcu.IP<i>` 没启用（键没有接收方）；
4. `pin-attribute`：ip 位写的是引脚名（`PA9.BaudRate`）——引脚属性必须逐条登记进表；
5. `unknown-namespace`：三者都不是，唯一能凭空判「拼错」的一类（`USART9.BaudRate`、`RIF.Whatever`）；
6. `unknown-dma-parameter`：`Dma.<IP>.<n>.<name>` 的 name 不在 `DMA_PARAM_ORDER` 白名单里；
   另有 `unregistered`（表中完全没有的形状）。

参数清单从哪来：F1 的 `db/mcu/<Mcu>.xml` 里 `RefParameter` 是 **0 条**（只有 `<IP>` 实例清单），
真名在 `db/mcu/IP/<Name>-<Version>_Modes.xml`：USART1 86 条（Instance/VirtualMode/BaudRate/WordLength/…/Parity）、
TIM3 256 条、ADC1 77 条、SPI1 27 条、GPIO 15 条。所以新增 `readIpParameterNames(db, facts, instance)`
（`src/engine/cubemx-db.ts`，复用 `ipModesPath`，按文件路径缓存）；查不到返回空数组，调用方据此返回 `null` = 不校验，
而不是「查不到就判错」。

**只审「这次计划写或改的键」**（`after.get(k) !== before.get(k)`）：文件里原有的键是 CubeMX 自己写的，
审了只会误报（真工程光 `ProjectManager`/`CAD` 就有几十个）。闸门也从 C6 之前**移到 C6 之后**——
自动补 `<IP>.IPParameters` 会新增一个键，它同样该受审。

**生成器去字面量**（`src/engine/ioc-plan.ts`）：`<IP>.<参数>`（两处）、`RCC.ADCPresc`、`RCC.APB2Freq_Value`/
`RCC.APB2TimFreq_Value`、`RCC.IPParameters`、`Mcu.CPN`/`Mcu.Family`/`Mcu.Name`、DMA 段的三条手写正则
（`/^Dma.([\w]+).(d+).([\w]+)$/`、`/^Dma.Request(d+)$/`、`prefix + "RequestParameters"`、`prefix + "Instance"`）
与 `/^Mcu[.]IP[0-9]+$/` 全部改成 `renderIocKey(...)` / `matchIocKey(...)`。DMA 分组解析抽成
`dmaGroupOf(key)`（取 `dma.request_group` 的三个占位符）与 `isDmaKey(key)`（`spec.id` 以 `dma.` 开头）。

**实测（本机 db `DB.6.0.150`，`STM32F103C(8-B)Tx`）**：

- 正例：`demo.ioc` + `USART1`（PA9/PA10）+ `PA6` 开漏 + `interrupts:["USART1"]` → `ok=true`，**0 条 `[SCHEMA]`**，
  只有既有的 `R5`（缺 `RCC.ADCPresc`）。说明审计对真生成器产物不误报。
- 反例（`entries` 手写五条）：
  `Dma.ADC1.0.Bogus` → `unknown-dma-parameter`；`PA9.BaudRate` → `pin-attribute`；
  `USART1.Baudrate`/`USART1.BaudRate` 在未启用 USART1 时报 `inactive-instance`，**启用后**报 `unknown-parameter`
  （`USART1.Baudrate` 被点名，`USART1.BaudRate` 通过）；`USART9.BaudRate` → `unknown-namespace`。
  五条合并成一条 `[SCHEMA]` 告警（前缀 5 条 + 说明），仍然只告警不硬失败。

**真机往返（`demo/.dsh-stm32/s5-verify.mjs`，CubeMX 6.15.0 无头，`durationMs=63072`）**：plan 33 个键
（`PA6` 开漏 + 初始高、`PA0-WKUP` 下降沿 EXTI + 上拉、`USART1`、`interrupts:["USART1"]`、Serial Wire）
→ apply → `config load` + `config save`：`addedKeys`/`removedKeys`/`changedValues`/`signalRewrites`/
`orderOnly` **全空**，`benign=true`，`dropped=[]`，只有它自己追加的 `3-MX_USART1_UART_Init-USART1-false-HAL-true`。
即：去字面量之后键名与 CubeMX 写回来的**逐字节一致**，且计划阶段 0 条 `[SCHEMA]`。

**单测与包体**：`test/ioc-schema-units.test.mjs` 8 → 12 例（新增 `iocKeyTier` 推导表、strong/weak 分层、
`auditIocKeys` 六种 verdict、`readIpParameterNames` 用临时目录造假 db）；
`node test/run-units.mjs` → **712 pass / 0 fail**（42 个套件；§61.12 再收两条后 714）；`node scripts/pack-size.mjs` →
包体 **554.0 KB**（上限 1171.9 KB，117 个文件，解包 1759.9 KB；§61.12 后 555.4 KB / 1764.0 KB），模板 66.4 KB，运行时资产 16.4 KB / 7 个。

**仍未做**：F4/F7 族的 db 表（`clock-plan.ts`/`chips.ts` 是另一条工作流，需用户开启）；`ioc_verify` 的输出
还没把审计结论并进 `attribution`（目前两边独立，计划阶段告警 / 回写阶段归类）。

### 61.12 §61.11 的两处收尾：ADC 合成参数名 + `Mcu.IP<i>` 排序（同日再续）

§61.11 的验收只跑了「USART1 + 引脚 + EXTI + Serial Wire」这一条路径。补跑 ADC + DMA 那条
（`demo/.dsh-stm32/s5-verify-dma.mjs`，`ADC1`(IN0=PA0-WKUP) + `DMA:ADC1`，`durationMs=79400`）后暴露两个问题，
都属于「闸门自己不准」，不是生成器写错：

**① ADC 每通道参数名被审计误报（假阳性）**

计划阶段报了三条：

```
[SCHEMA] 3 个键名形状对但上下文不对：ADC1.Channel-0#ChannelRegularConversion（ADC1 的 db 参数清单里没有…）；
ADC1.Rank-0#ChannelRegularConversion…；ADC1.SamplingTime-0#ChannelRegularConversion…
```

根因在 db 的形状：`db/mcu/IP/ADC-aditf_v2_5F1_Cube_Modes.xml` 的 `<RefParameter>` 只登记**基名**
（120 行去重后 40 个：`Instance`/`DataAlign`/`ScanConvMode`/`NbrOfConversion`/`Rank`/`Channel`/
`SamplingTime`/…），而每通道/每 Rank 的键名是 CubeMX **合成**的 `<基名>-<n>#<信号>`。
所以「整体名字必须在清单里」这条判据对 ADC 天然为假。

修法（`src/data/ioc-schema.ts` 的 `parameterNameKnown(name, names)`）：先整体命中，再退一步判
**`-/#` 之前的基名**命中 —— `Channel-0#ChannelRegularConversion` 的基名 `Channel` ∈ 清单 → ok；
`Channelz-0#…` 的基名 `Channelz` 不在 → 仍报 `unknown-parameter`（detail 会写出「也没有基名 Channelz」）。
单测补 5 条断言（三条合成名放行、两条拼错照抓）。

**② `Mcu.IP<i>` 顺序：我们尾部追加，CubeMX 回写时整表重排**

同一次往返的 `changedValues` 5 条全是槽位换位：

```
before  IP0=NVIC IP1=RCC IP2=SYS IP3=ADC1 IP4=DMA
after   IP0=ADC1 IP1=DMA IP2=NVIC IP3=RCC IP4=SYS      （benign=false，其余 added/removed/orderOnly 全空）
```

往返 A 之所以零 diff，只是因为 `USART1` 恰好排在 `SYS` 之后 —— 尾部追加正好等于正确位置。

**排列规则（504 份官方板级 .ioc 实测）**：实例名按 **natural 序（数字段按数值比）升序，伪实例（板名，含 `-`）永远在最后**。
差别只在 `TIM2…TIM4,TIM15` 这种（纯字典序会把 `TIM15` 排到 `TIM2` 前）。

| 判据 | 命中 |
| --- | --- |
| 纯字典序升序 | 375 / 502 |
| natural 序 | 392 / 502 |
| natural 序 + 伪实例置尾 | **435 / 502** |

按族看更清楚 —— **单核族全对，反例全在双核/TrustZone 板**：

| 族 | 反例 | 例子 |
| --- | --- | --- |
| F0/F1/F2/F3/F4/F7/G0/G4/L0/L1/L4/WB/WL3/C0/U0 | **0**（F1 12/12） | — |
| H7 | 4 | `NUCLEO-H7S3L8` 插在 `EXTMEM_MANAGER` 与 `NVIC2` 之间 |
| U5 / WBA / L5 | 21 / 14 / 6 | `NVIC2` 在 `NVIC1` 前（TrustZone 双 NVIC） |
| H5 / N6 / MP1 / WL | 6 / 6 / 2 / 6 | `SYS` 在 `SYS_M0PLUS` 前、`NVIC1,NVIC2` |

实现（`src/engine/ioc-plan.ts`）：新增 `compareIpInstance(left, right)`（伪实例分桶 + `\d+|\D+` 分词的数值比较）
与 `sortIpSlots(entries)`（收集 `mcu.ip_index` 槽位 → 排序 → **顺序没变就一个字节都不动** → 否则重编号并写 `Mcu.IPNb`）。
调用点在 C6 之后、覆盖率闸门之前，条件 `ipTouched`（这次动过 IP 槽位才排）：用户没动外设时不动文件。
作用等价于引脚表既有的 `sortPinsByPosition`/`writePinOrder` 那一套。

**实测（CubeMX 6.15.0 无头，本机 db `DB.6.0.150`）**：

- ADC+DMA 往返（修后）：plan 36 个键、`durationMs=76583` → `addedKeys`/`removedKeys`/`changedValues`/
  `signalRewrites`/`orderOnly` **全空**、`benign=true`、`dropped=[]`；计划阶段只剩一条**内容**告警
  （`ADC1` 换了引脚但 `Channel-0#…` 仍是 `ADC_CHANNEL_1`，通道号必须与引脚一致 —— 这条是真该报的）。
- USART1 + 引脚 + EXTI 往返（回归）：plan 33 个键、`durationMs=102148`，六个 diff 桶仍**全空**、`benign=true`。

**单测与包体**：`ioc-plan-units` 49 → 51 例（natural 序 `NVIC,RCC,SYS,TIM2,TIM4,TIM15`；伪实例 `AAA-BOARD` 字典序最前仍置尾），
`ioc-schema-units` 的 audit 用例补 5 条断言（仍 12 例）；`node test/run-units.mjs` → **714 pass / 0 fail**（42 个套件）；
`node scripts/pack-size.mjs` → 包体 **555.4 KB**（上限 1171.9 KB，117 个文件，解包 1764.0 KB），模板 66.4 KB，运行时资产 16.4 KB / 7 个。

**边界（别当成已解决）**：双核/TrustZone 族（H7/H5/U5/U3/N6/L5/WBA/MP1/WL）的 `Mcu.IP<i>` 仍是另一套插入序 ——
我们按 natural 序写会在这些族上继续产生 `changedValues` 噪音（功能不受影响：键值集合一致，CubeMX 只是重排），
所以「零 diff」的结论只对单核族成立，本项目当前范围是 F1。（下一节把这件遗留补上：审计结论并进 `attribution`。）

### 61.13 `ioc_verify` 的归因补上「为什么它不认」：droppedReasons / addedVerdicts / ipOrderOnly

§61.11–§61.12 把「键名形状」这层管住了，但 `ioc_verify` 的产物一直有个说不出口的地方：
它只告诉你**哪些键没了**（`removedKeys` / `missingKeys`），说不出**为什么没了**。
同一个「键被 CubeMX 丢掉」的现象，成因至少有四种，处置完全不同：

| 现象 | 真实成因 | 该改谁 |
| --- | --- | --- |
| `NVIC.TIM2_IRQn` 被删 | 外设没进 `Mcu.IP<i>` —— 参数/中断没有接收方 | 生成器：启用外设的顺序 / `pins` API |
| `USART1.BaudRate` 被删 | 参数名拼错，db 的 `RefParameter` 清单里没有它 | 生成器：参数名 |
| `PA5.PinState` 被删 | 引脚属性写成了「外设参数」，没登记进 `<pin>.GPIOParameters` | 生成器：属性键必须双向登记（R22） |
| `Foo.Bar` 被删 | 前缀既不是实例也不是引脚名/命名空间，纯拼错 | 人：键根本写错 |

所以在真值表之外再补一层：把**审计结论**（§61.11 的 `auditIocKeys`）并进 `attribution`。

**三个新字段**（`src/engine/ioc-verify.ts` 的 `IocVerifyAttribution`）

- `droppedReasons: Array<{ key, verdict, detail }>` —— 对 `removedKeys` 逐条给判据。
  `verdict` 复用真值表的 `IocKeyVerdict`：`unregistered` / `unknown-namespace` / `pin-attribute` /
  `unknown-parameter` / `unknown-dma-parameter` / `inactive-instance` / `ok`。`detail` 是人话。
- `addedVerdicts` —— 对 `addedKeys`（CubeMX 自己补的键）同样跑一遍，用来区分
  「形状登记过、它自己补的（例如 `ProjectManager.functionlistsort`）」与「我们连 spec 都没有的缺口」。
- `ipOrderOnly: string[]` —— `changedValues` 里只有 `Mcu.IP<i>` 换位、且**外设集合完全没变**时，
  这些键单独成桶，并从 `benign` 的计算里排除。动机：§61.12 说过槽位重排是语义不变的重排，
  它混在 `valueChanged` 里会把 `benign` 打成 `false`，让人误以为写错了键。
  实现上先比 `beforeIps`/`afterIps` 排序后拼接是否相等，再把 `spec.id === "mcu.ip_index"` 的
  `changedValues` 逐条 `splice` 出来；`orderOnly` 里同步排除这些键，两桶不重复计数
  （否则一次重排会同时报「行序变了」和「槽位变了」）。

**上下文怎么进去**：`diffIocForVerify(beforeText, afterText, audit?)` 的第三个参数是**可选**的，
纯函数不碰文件系统；db 上下文由 `runIocVerify` 里的 `buildAuditInput()` 造：

1. 从 before 文本读 `Mcu.Name`（CubeMX 的 db 分组名，例如 `STM32F103C(8-B)Tx` —— 传型号 `STM32F103C8Tx` 是查不到的）；
2. `locateCubemxDb()` 定位本机 db，`readMcuFacts()` 读引脚表与 IP 实例表；
3. `paramNamesOf(instance)` 走 `readIpParameterNames()`（`db/mcu/IP/<Name>-<Version>_Modes.xml` 的 `<RefParameter Name>`），
   `dmaParamNames` 用 `DMA_PARAM_ORDER` 白名单（它在 `src/engine/ioc-plan.ts` 里改为导出，
   `ioc-plan` 不反向依赖 `ioc-verify`，没有循环依赖）。

**三条降级路径**（都不误报，只降级）：

| 情况 | 行为 |
| --- | --- |
| 没有 CubeMX db / 读不到 `Mcu.Name` | `audit = null`，`droppedReasons` 每条 `verdict: ""` + 「这次没有 db 上下文…」，诊断照跑 |
| 某个实例在 db 的 IP 模式文件里没有 `RefParameter` | `paramNamesOf` 返回 `null` → 该实例的参数名**不校验**（宁可漏报不误报） |
| `verdict === "ok"` 但键照样被丢 | `detail` 明确写「几何已登记、上下文也没问题，但它仍然被丢：这类键的生效条件只能靠真机实验确认」，**不假装判过** |

`inactive-instance` 还有一条特别的补白：如果这个 ip 在 before 文本的 `Mcu.IP<i>` 里本来**有**，
说明不是「我们没启用外设」，而是 CubeMX 回写时把整个外设删了 —— `detail` 会点明这一点。
`ioc_verify` 的 `message` 末尾也按 verdict 计数拼一句成因摘要
（「它丢掉的键里 1 个前缀既不认识也不是已启用实例、1 个把引脚属性写成了外设参数（没登记进 GPIOParameters）」）。

**真机证据**（`demo/.dsh-stm32/attrib-verify.mjs`，`durationMs=108087`，CubeMX 6.15.0 无头 / db `DB.6.0.150`）：
往 demo.ioc 副本里故意注入三个坏键

```
RCC.BogusParam=1      Foo.BarParam=2      PA5.BogusAttr=1
```

回写后三条全在 `removedKeys`，`droppedReasons` 分别是：

| 键 | verdict | detail 要点 |
| --- | --- | --- |
| `Foo.BarParam` | `unknown-namespace` | Foo 既不是已启用实例，也不是 db 引脚名或已知命名空间 |
| `PA5.BogusAttr` | `pin-attribute` | PA5 是引脚名，BogusAttr 是引脚属性；必须逐条登记进真值表 |
| `RCC.BogusParam` | `ok` | 命中 `rcc.derived` 形状，但成员名不校验 → 只能真机确认 |

`addedVerdicts` / `ipOrderOnly` 空、`dropped=[]`、`benign=false`；`notes` 里多一条上下文来源说明。

**边界（别当成已解决）**：`RCC.{member}` 是**形状级**命中，成员名不校验 —— 504 份官方板级 `.ioc` 里
`RCC.*` 有 **847 个不同成员名**（`IPParameters` 504、`FamilyName` 482、`SYSCLKFreq_VALUE` 433、`HSE_VALUE` 428…），
跨族列不出白名单，所以 `RCC.BogusParam` 这种拼错只能靠真机往返抓。要收窄得先做
「db `RefParameter` ∪ 分族语料表」，未做。

**单测与包体**：`ioc-verify-units` 16 → 24 例（无上下文只报键名 / `unknown-parameter` /
`inactive-instance` 两态 / `pin-attribute` 且已登记 `PinState` 判 ok / `addedVerdicts` 的 ok 与 unregistered /
`ipOrderOnly` 良性 / 槽位重排但集合真变了仍 `valueChanged` / ok-but-dropped 文案）；
`node test/run-units.mjs` → **722 pass / 0 fail**（42 个套件）；
`node scripts/pack-size.mjs` → 包体 **558.2 KB**（上限 1171.9 KB，117 个文件，解包 1772.9 KB），
模板 66.4 KB，运行时资产 16.4 KB / 7 个。

## 62. 从「只支持 F1」扩到 STM32 全系列（第一步：族画像 + 按族接线）

这一节的起因是一句需求：「现在将单片机种类从 f1 系列扩展到 stm32 全系列」。
先把「全系列」拆成可验证的东西：**哪些事只用型号就能决定，哪些事必须真的按族算**。
结论是新增一层**族画像**（`src/data/family.ts`），并让所有族相关的地方从这里取值 —— 而不是把
F1 的字面量复制 26 份。

### 62.1 为什么是「族画像」而不是「按族补表」

把 F1 的假设按命中数排了一遍（`grep -c` 全 src）：`cmsis-sources.ts` 67 处、`clock-plan.ts` 48、`hal-chip.ts` 32、
`firmware-packages.ts` 28、`stm32f1.ts` 21、`register-*.ts` 各 20、`ioc-plan.ts` 16、`device-facts.ts` 14…
也就是说「F1 假设」不是一处开关，而是散在十几个模块里的事实。

同时 CubeMX 的 db（本机 `DB.6.0.150`）已经把**一半**事实给全了，而且是族无关的：
`db/mcu/` 有 2019 个 MCU xml，根元素直接带族与内核（`<Mcu ClockTree="" DBVersion="V3.0" Family="STM32F1"
HasPowerPad="false" IOType="" Line="STM32F103" Package="LQFP48" RefName="STM32F103C(8-B)Tx">`），
另有 `<Core>Arm Cortex-M3</Core>`、`<Frequency>72</Frequency>`、`<Ram>20</Ram>`、`<IONb>37</IONb>`、
多个 `<Flash>64</Flash>`（容量档）、引脚/信号表、`db/mcu/IP/*_Modes.xml` 的 `<RefParameter DefaultValue=…>`。

所以划分是：

| 事实 | 来源 | 谁负责 |
| --- | --- | --- |
| 族 id / line / 内核 / 最高频 / Flash 档 / RAM / 引脚数 / 引脚信号表 / 外设参数默认值 | **CubeMX db**（按型号读） | `src/engine/cubemx-db.ts` 的 `parseMcuXml` / `readMcuFacts` |
| openocd target 脚本名、固件包前缀、SVD 目录、按内核的硬件断点预算、能力闸门 | **db 里没有** | `src/data/family.ts`（27 条画像） |

`parseMcuXml` 因此扩了 6 个字段（`family` / `line` / `core` / `ramKb` / `flashKb`（去重数组）/ `ioNb`）。
这个接口只有 `parseMcuXml` 一处构造，加必填字段不会破别处。

### 62.2 27 个族（实测 `db/mcu` 的 2019 个 xml）

| 族 | 型号数 | 内核 | 最高频 | 族 | 型号数 | 内核 | 最高频 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C0 | 84 | M0+ | 48 | L4+ | 64 | M4 | 120 |
| F0 | 89 | M0 | 48 | L5 | 32 | M33 | 110 |
| F1 | 58 | M3 | 72 | MP1 | 84 | A7 | — |
| F2 | 16 | M3 | 120 | MP2 | 148 | A35 | — |
| F3 | 53 | M4 | 72 | N6 | 24 | M55 | — |
| F4 | 116 | M4 | 180 | U0 | 48 | M0+ | 56 |
| F7 | 90 | M7 | 216 | U3 | 48 | M33 | — |
| G0 | 98 | M0+ | 64 | U5 | 162 | M33 | 160 |
| G4 | 118 | M4 | 170 | WB | 22 | M4 | 64 |
| H5 | 75 | M33 | 250 | WB0 | 10 | M0+ | — |
| H7 | 175 | M7 | 600 | WBA | 35 | M33 | 100 |
| L0 | 113 | M0+ | 32 | WL | 17 | M4 | 48 |
| L1 | 90 | M3 | 32 | WL3 | 18 | M0+ | — |
| L4 | 129 | M4 | 80 | | | | |

（另有 3 个没有 `Family` 属性的老文件，不进画像表。db 的 `<Core>` 只有大小写两种写法、**没有双核写法**：
`Arm Cortex-M4` 362 / `ARM Cortex-M4` 157、`Arm Cortex-M7` 168 / `ARM Cortex-M7` 97、
`Arm Cortex-M33` 5 / `ARM Cortex-M33` 347、C0 写全大写 `ARM Cortex-M0+` —— 所以内核匹配一律用
`/cortex-mXX/i`；而且它**只写主核**（MP1 只写 `ARM Cortex-A7`、MP2 只写 `ARM Cortex-A35`，
协处理核不出现），另有 2 个老文件没有 `<Core>` 节点，内核对它们就是空串 —— 断点预算这时回退并说明原因，
不猜。）

**型号 → 族**（`familyIdOfPart`）不靠猜前缀字母数：遍历画像表，取「族段最长且族段后紧跟非字母」的那条。
两个踩过的坑写在注释里：① 早期用 `/^STM32([A-Z]{2}[0-9])/` 直接认不出 `STM32WBA55CG`（三段族）；
② 比较时**必须比族段长度**（"WBA"）而不是族 id 长度（"STM32WB" 有 8 个字符，会赢过 "WB0"）。
`STM32L4[PQRS]` 单独判成 `STM32L4+`（L4+ 在 db 里是独立 Family）。

### 62.3 openocd target 矩阵

本机 openocd 0.12.0 的 `share/openocd/scripts/target` 里一共 24 个 stm32 相关 cfg。画像表把
「哪一族有脚本」钉死，**没有脚本时明确拒绝而不是拿别的族硬连**：

| 有专用脚本 | target | 没有专用脚本 | 处理 |
| --- | --- | --- | --- |
| F0 / F1 / F2 / F3 / F4 / F7 / G0 / G4 / H7 / L0 / L1 / L4 / L4+ / L5 / U5 / WB / WL | `target/stm32f0x.cfg` … `target/stm32wlx.cfg`（L4 与 L4+ 都用 `stm32l4x.cfg`） | C0 / H5 / MP2 / N6 / U0 / U3 / WBA / WB0 / WL3 | `openocdTarget: null` |

（H7 的 `stm32h7x.cfg` 之外还有 `stm32h7x_dual_bank.cfg`，画像里只钉单 bank，双 bank 由工程自己的
`openocd.cfg` 写死 —— 这类判断不该由插件替用户做。MP1 用 `stm32mp15x.cfg`；另有 `stm32x5x_common.cfg`
只是公共片段，没有 h5x 包装，所以 H5 也归「没有脚本」。）

接线点：`src/engine/flash.ts`、`debug.ts`、`debug-session.ts`、`regs.ts` 原来的 `defaultConfigs()` 改成
`defaultConfigs(family)`，并且**只在工程里没有自己的 `openocd.cfg` 时**才走这个回退；
`chooseOpenocdTarget(family)` 返回 `{targetConfig, note, error}`，`error` 非空就整条命令不跑、报告里说清
「本机 openocd 没有 <族> 的 target 脚本：请在工程根目录放一份 `openocd.cfg` 写死 `source [find target/xxx.cfg]`，
不要拿别的族的 target 硬连（会连不上或读错 flash 布局）」。工程里没有可读的 `.ioc` 时（认不出族）仍回退
`target/stm32f1x.cfg` 并在 notes 里说明 —— 这是刻意的向后兼容。

**族从哪来**：`.ioc` 里本来就有 `Mcu.Family`（demo.ioc 的 `Mcu.Family=STM32F1`），`readIocFamilyId()`
优先读它，没有再退 `Mcu.CPN` 走 `familyIdOfPart`。**不查 db** —— 少一次 2019 文件的定位，也不会因为
db 版本不同判出不同族。

### 62.4 硬件断点预算按内核，不按族

`src/engine/breakpoints.ts` 原来的三级回退是「资源包 `chips.json` → F1 默认 6/4」。问题是比较器个数是
**内核属性**（Cortex-M0 只有 4 个 FPB 比较器、DWT 2 个观察点），同族不同内核就会对不上，跨族更是全错。
现在改成：

| 内核 | 硬件断点 | 观察点 |
| --- | --- | --- |
| Cortex-M0 / M0+ | 4 | 2 |
| Cortex-M3 / M4 | 6 | 4 |
| Cortex-M7 / M33 / M55 | 8 | 4 |
| Cortex-A（MP1/MP2） | `null` | `null` |

顺序有讲究：`/cortex-m0/i` → `/cortex-m7|cortex-m33|cortex-m55/i` → `/cortex-m3|cortex-m4/i`。
**M33 含 "m3" 子串**，第一版把 M33 判成了 6/4，被 `family-units` 抓出来。
`BudgetResolution.source` 因此多一个 `"core"`，notes 写明「断点预算按内核 <core> 的硬件上限：N 个硬件断点 /
M 个观察点」。内核为空（认不出族）或 Cortex-A 仍回退 F1 字面量并在 note 里说清为什么算不出。

### 62.5 能力闸门：不支持的参数要**明确拒绝**，不能悄悄用 F1 的表

族画像里 `Stm32FamilyCapabilities` 五个布尔：`halScaffold` / `registerScaffold` / `iocPresets` /
`clockPlan` / `svdValidation`。现在**只有 F1 五项全 true**，其余 26 族全 false —— 因为模板、启动文件、
链接脚本、`.ioc` 预设表、时钟上限表、SVD 这些都是按 F1 实现的。

闸门落在 `src/engine/ioc-plan.ts`，每处都用 `capabilityGap(profile, capability)` 拼一句**短**理由
（早期把整段族 note 拼进 errors，一条报错 300+ 字，用户看不出是哪一项挡住了参数）：

| 不支持的能力 | 行为 |
| --- | --- |
| `svdValidation` | 跳过中断名/寄存器名校验，`notes` 说明「中断名/寄存器名校验跳过：<族>：要该族的 SVD，资源包目前只有 F1」 |
| `iocPresets` | `peripherals` 参数**不执行**：`errors.push`「peripherals 参数已忽略（<族>：.ioc 外设预设表目前只有 F1）：这一族请用 pins + entries 手写该族的键」 |
| `clockPlan` | 用 `emptyClockPlan()` 顶替，**一个 RCC 键都不写**；只读请求进 `notes`，请求改动进 `errors` |
| `halScaffold` / `registerScaffold` | 由 `stm32_project_create` / `stm32_generate` 侧拒绝（下一步接线） |

`pins` / `interrupts` 在非 F1 上**放行**，但带一条 warning：「引脚/中断的写入规则只在 F1 上做过真机往返
（<族> 未验证）：键名按本族 db 生成，落地前请用 `stm32_ioc_verify` 复核」。理由：键名与形状现在都从 db 与
真值表来，不去卡死比乱猜更安全；但没验证过就必须说出来。

### 62.6 EXTI 的 NVIC 向量按内核分档（C0 逼出来的）

`extiIrqName(line)` 原来是 F1 专用：0–4 → `EXTI<line>`、5–9 → `EXTI9_5`、10–15 → `EXTI15_10`。
拿 C0 板级文件跑验收时，让它把 `PA0` 配成下降沿，我们写的是 `NVIC.EXTI0_IRQn`，而 C0 只有
`NVIC.EXTI0_1_IRQn` —— 中断根本不会被使能。

语料统计（`.dsh-stm32/exti-irq-by-family.mjs`，504 份官方板级 `.ioc`）：

| 内核档 | 向量分组 | 实测族 |
| --- | --- | --- |
| M0 / M0+ | `EXTI0_1`(0–1) / `EXTI2_3`(2–3) / `EXTI4_15`(4–15) | C0、L0 |
| M3 / M4 / M7 | `EXTI0`…`EXTI4` 逐线 + `EXTI9_5`(5–9) + `EXTI15_10`(10–15) | F1、F4、G4、L4、WB |
| M33 / M55 | 逐线 `EXTI0`…`EXTI15` | U5、WBA、N6 |
| Cortex-A | 空（不走 NVIC/EXTI 模型） | MP1、MP2 |

落成 `ExtiVectorSpec {name, from, to}` + `extiVectorsOf(profile)` + `extiVectorNameOf(line, profile)`；
`extiIrqName(line, profile?)` 加可选第二参（不传保持老行为，调用点全部显式传）；`R23`（`checkExtiChains`）
也按画像取向量名，Cortex-A 上改成「<族> 没有 EXTI<线> 的 NVIC 向量」而不是报「缺 NVIC 键」。
注意判断顺序：M33/M55 必须早于 M3/M4 —— 与 62.4 是同一个坑。

### 62.7 Serial Wire 跨族：脚名与调试信号名都要问 db

`ensureSerialWire` 原来写死 F1 的两个脚：`PA13/SYS_JTMS-SWDIO`、`PA14/SYS_JTCK-SWCLK`。
C0 的 db 里这不成立：脚名是 `PA14-BOOT0`，信号名是 `DEBUG_SWDIO` / `DEBUG_SWCLK`
（语料实测 `Signal=DEBUG_SWDIO` **只在 C0 出现**，其余族是 `SYS_JTMS-SWDIO`）。结果 C0 验收直接报
`[R17] 同一个物理引脚写了多份：PA14-BOOT0、PA14`。

现在：脚名走 `resolveDbPinName(facts, "PA13"/"PA14")`；信号名按「首选清单 → 正则兜底」从
`facts.pins.get(dbPin).signals` 里挑（SWDIO：`SYS_JTMS-SWDIO` → `DEBUG_SWDIO` → `/SWDIO|JTMS/`；
SWCLK：`SYS_JTCK-SWCLK` → `DEBUG_SWCLK` → `/SWCLK|JTCK/`）；都没命中就退回 F1 字面量并 warning
「db 里 <脚> 没有 SWD 调试信号…可能被 CubeMX 丢弃」。没有 db 时行为与以前完全一致。
`Mode=Serial_Wire` 两族都合法（C0 语料里有 6 份 `DEBUG_SWDIO` + `Mode=Serial_Wire`）。

顺带还修了两个漏写的 IP 实例（都是「CubeMX 回写时自己补了一条，说明我们少写」这一手证据逼出来的）：

- **SYS**（F4 往返）：报文里出现 `Mcu.IP2=SYS` + `Mcu.IPNb` 2→3。开 Serial Wire 时 `SYS` 本来该进外设表
  → `ensureIpInstance(entries, "SYS")` 无条件补（F1 的 demo.ioc 里本来就有 `Mcu.IP2=SYS`）。
- **DEBUG**（C0 往返）：C0 的 db 把调试口**单列成一个 IP 实例**（`STM32C031C(4-6)Tx.xml` 里有
  `<IP InstanceName="DEBUG" Name="DEBUG"/>`，F1/F4 的 db 没有）。所以第一次 C0 验收虽然
  `plan ok=true`、写进去的键一个没丢，但 `ioc_verify` 的 `addedKeys` 里挂着 `Mcu.IP5`、
  `changedValues` 有 5 条 `Mcu.IP1..IP4` 整排位移（CubeMX 把 DEBUG 插在 `CORTEX_M0+` 之后，正好是
  natural 序），`benign=false`。补法是 db 驱动而不是按族写死：`ensureDebugInstance(entries, facts)` 只在
  **本族 db 有 DEBUG 实例**且这次确实写了 `DEBUG_*` 信号时才补 —— 判据用 db 是因为在 F1/F4 上补反而会
  多写一个它们不认的实例。补完 C0 的 `addedKeys` / `changedValues` 都空了。

两个实例都走同一个 `ensureIpInstance(entries, name)`：按 `mcu.ip_index` 形状扫槽位（不拼字符串），
没有就追加并更新 `Mcu.IPNb`；顺序交给后面的 `sortIpSlots`（CubeMX 的 natural 序 + 板名置尾）。

### 62.8 `instancesWithPins`：谁「应该有引脚」要问 db

`validatePeripheralWiring` 有一条自洽检查：「进了 `Mcu.IPn` 却没有引脚的 `.Signal` 指向它」。
C0 板级文件里 `Mcu.IPn` 含 `CORTEX_M0+` 和板名 `NUCLEO-C031C6`（这两者本来就不该有引脚），
原来的黑名单只有 `""/NVIC/RCC/SYS/DMA`，于是假阳性两条。

修法是 db 驱动：`instancesWithPins(facts)` 遍历 `facts.pins` 的每个 signal 名，去 `S_` 前缀取第一段
（`USART1_TX` → `USART1`），**同时收 `USART`** 这一级（`Mcu.IPn` 里写的是实例名还是族名各文件不一，
第一版只收 `USART1` 就让两条真检查失效了）；`ADCx_IN1`/`DACx_OUT1` 额外收 `ADC`/`DAC`。
`validatePeripheralWiring` 里 `if (chipFamilies !== null && !chipFamilies.has(instanceFamilyName(device))) continue;`
—— 内核项、板名自动跳过，而「USART1 在 `Mcu.IPn` 里但没有任何脚指向它」仍然告警。没有 db 时行为不变。

### 62.9 真机验收（CubeMX 6.15.0 无头 / db `DB.6.0.150`）

脚本 `.dsh-stm32/family-verify2.mjs <tag> <src.ioc> <输出脚> <EXTI脚>`，两段式：
① 先用 CubeMX `config load`+`config save` **原地规范化**源文件（消掉「老版本 .ioc 升级噪声」，
F4 那份是 MxCube 4.13.0 / DB.4.0.130 的老文件：115 → 153 键，C0：117 → 149 键）；
② 再 `plan` → `apply` → `ioc_verify`，并把 candidate 与 snapshot **逐键**比对（我们写的键有没有被丢/被改）。

**F4 通过**（`A40_Nucleo_NUCLEO-F401RE_STM32F401RE_Board.ioc`，CPN=`STM32F401RET6`）：
族判定 `STM32F4 / Cortex-M4 / target/stm32f4x.cfg`、能力全 false；计划 28 个键变化
（PB0 输出 + PA0-WKUP EXTI 下降沿 + Serial Wire + GPIO.groupedBy）；
`ioc_verify` **benign=true**（`durationMs=109110`：dropped / addedKeys / removedKeys / changedValues /
signalRewrites / orderOnly 六桶全空），28 个键逐字保留。闸门同场验过：`clock:{targetHz:84000000}` +
`peripherals:[{name:"USART1"}]` → `ok=false`，两条短理由，`clockPlan.entries` 为空。

**C0 通过**（`M44_Nucleo_NUCLEO-C031C6_STM32C031C6_Board.ioc`，CPN=`STM32C031C6T3`，
db 名 `STM32C031C(4-6)Tx`）：族判定 `STM32C0 / Cortex-M0+ / target ""`（本机 openocd 没有 `stm32c0x.cfg`，
`chooseOpenocdTarget` 返回 error）；`plan ok=true`、31 个键变化，写出 `PA13.Signal=DEBUG_SWDIO`、
`PA14-BOOT0.Signal=DEBUG_SWCLK`（62.7）、`NVIC.EXTI0_1_IRQn`（62.6）、`Mcu.IP<i>` 里的 `DEBUG`（62.7）；
`ioc_verify` **benign=true**（`durationMs=108048`，六桶全空），31 个键逐字保留。

这一轮 C0 的教训值得单独记一笔：**`benign=false` 之前的两版都是"我们少写了一条"，不是"CubeMX 乱改"**。
第一版死在 `PA14-BOOT0`/`PA14` 重复（62.7），第二版死在缺 DEBUG 实例。真机往返的价值就在这：
`plan ok=true` + 键没丢**不等于**配置对了，只有 CubeMX 回写逐键比对才能看出"差的那一条"。

这两族能跑通的含义要说清：**C0 的 openocd target 为 null 只影响烧录/调试，不影响 `.ioc` 往返**；
烧录能力与 `.ioc` 能力是两条独立的线。

### 62.10 单测与包体

`test/family-units.test.mjs` 新增 11 例并加入 `test/run-units.mjs` 的 suites 清单（**手写清单，不是 glob**）：
27 族齐全且只有 F1 五项全 true、`familyIdOfPart` 15 个真实型号（含 `STM32L4R5ZIT6`→`STM32L4+`、
`STM32WBA55CG`→`STM32WBA`、`STM32WB05KZV6`→`STM32WB0`、`STM32WL30K8V6`→`STM32WL3`）、
`familyProfileOf("F4")`、9 个无脚本族的 null + note、`debugBudgetForCore` 7 种内核 + 双核写法 + 空串、
`debugBudgetOfFamily(MP1)=null`、`chooseOpenocdTarget` 四种输入、`readIocFamilyId`/`readProjectFamily`、
`parseMcuXml` 新字段、`extiVectorsOf` 按内核分档、`instancesWithPins`。
`breakpoints-units` 加两条（F103→6/4、F030→4/2、H743→8/4），`ioc-rules-units` 加一条（R23 分档），
`ioc-plan-units` 加一条（C0 的 Serial Wire 按假 db 写 `PA14-BOOT0`/`DEBUG_SWDIO`）。

`node test/run-units.mjs` → **736 pass / 0 fail**（43 个套件）；
`node scripts/pack-size.mjs` → 包体 **573.1 KB**（上限 1171.9 KB，118 个文件，解包 1816.6 KB），
模板 66.4 KB，运行时资产 16.4 KB / 7 个。

### 62.11 这一步**没有**做什么（别当成已支持）

- **只有 F1 能建工程**（§63 起 HAL 路线已扩到 14 个单核族，仍只有 F1 的是寄存器路线）：`stm32_project_create` 的 HAL 路线（模板 / 启动文件 / 链接脚本 / 设备宏）与
  寄存器路线（`src/data/stm32f1.ts` 14 个容量档）仍是 F1 专用；非 F1 族会明确拒绝，不给半成品工程。
- **只有 F1 有 `.ioc` 预设表**：`USART1` / `TIM2` / `ADC1` 这些内建预设名是 F1 的表。下一步按族从
  `db/mcu/IP/*_Modes.xml` 的 `<RefParameter DefaultValue=…>` **生成**（db 里参数默认值是现成的，不必手写）。
- **只有 F1 有时钟规划**：`clock-plan.ts` 的 RCC/PLL 上限表只覆盖 F1；其它族 `clock` 参数会被拒。
- **只有 F1 有 SVD**：资源包 `device/f1/svd`，中断名/寄存器名校验扩族要先给资源包加数据。
- **C0 / H5 / N6 / U0 / U3 / WBA / WB0 / WL3 / MP2 不能烧录**：本机 openocd 0.12 没有对应 target 脚本。

## 63. 全系列第二步：HAL 建工程按族实现（14 个单核族）

### 63.1 先把范围钉死

用户定的范围是「**14 个单核族**：C0 / F0 / F1 / F2 / F3 / F4 / F7 / G0 / G4 / L0 / L1 / L4 / L4+ / U0，先不包含 H7、
WB0、WL3」，双核（WB/WL）、M33/M55（H5/L5/U3/U5/N6/WBA）、MPU（MP1/MP2）一律**明确拒绝**。
拒绝这件事本身要有代价可控：族画像（`src/data/family.ts`）已经给了 `capabilities` 闸门，这一步只是把
`halScaffold` 从「只有 F1 为 true」改成「14 个单核族为 true」，其余四项（registerScaffold / iocPresets /
clockPlan / svdValidation）继续留在 F1 —— 一步只开一条线，别的线照旧拒绝，不会出现「看着支持其实半截」的族。

### 63.2 芯片事实改成资源包按族发文件

原来是 `device/f1/chips.json` 一个文件 + 插件里手写 F1 的分组名表。这一步的做法是：**资源仓库按族生成
`device/<族>/chips.json`**（`dsh-stm32-assets/scripts/family-assets.mjs`），插件只负责读。理由有三条：

1. 启动文件/设备头/设备宏不是「按族一条规则」，而是「按容量档 / 按封装档 / 按 line」的笛卡尔积。
   F410/F412 的启动文件按**封装**分档（`startup_stm32f410cx.s`），F401/F411 按**容量**分档
   （`startup_stm32f401xc.s` / `startup_stm32f411xe.s`），L4+ 的 line 直接带字母（`4P5`）。
   这些规则只要有一族特殊，插件里「猜」就是错的 —— 让生成器在**固件包上 existsSync 验过**再写进表里，
   插件读到的每个文件名都真的存在。
2. 装了什么族一目了然：某族的 chips.json 不在，就是没装这个族的资源，插件给「先 stm32_assets refresh」，
   而不是拿一个大而全的文件假装全支持。
3. 内存字段只有一个来源：非 F1 族的官方固件包**不带 gcc 链接脚本**，RAM 只能取 CubeMX db 的 `<Ram>`；
   生成器把这条写进 chips.json 的 notes，插件不再自己算。

命名规则两侧必须逐字一致（`scripts/family-assets.mjs` 的 `namingOf` 与插件 `src/data/device-facts.ts` 的
`namingFrom`）：族字母取自型号（`STM32F407VGTx` → F），**line 与 group 拼进文件名时全小写**
（`startup_stm32l4p5xx.s`），设备宏里 line 原样大写、尾缀按 `defineSuffix`：
`xx → xx`（`STM32F407xx`）、`xb → xB`（`STM32F103xB`）、`cx → Cx`（`STM32F410Cx`）。

### 63.3 型号解析按族分发，F1 的老路径一个字节都不动

`resolveHalChip()` 先 `familyIdOfPart()` 判族，然后分两条：

- **F1** 继续走 `resolveF1Chip()`（手写 RAM 表 + db 分组名，蓝丸 C8T6 还留旧名链接脚本兼容副本）——
  老行为零变化，`hal-route-units` 里那些 F1 断言一个都没改。
- **非 F1** 走新的 `resolveFamilyHalChip()`：全部字段来自 chips.json；`flashBytes/ramBytes` 为 0 直接拒绝
  （链接脚本的内存长度不能猜）；`mcuName` 缺失时按具体型号名写并加一条 note。

`HalChipFacts` 加了两条字段 `familyId` / `familyLine`：以后所有「按族取东西」的地方（固件包、CMSIS 目录、
system 文件、cmake 目录名、openocd target、SVD）都从这两条派生，不再各自正则。

读文件也按族分了：`loadFamilyDeviceFacts(familyId, env)` 按 `familyFactsRelOf()` 拼路径
（`STM32L4+ → device/l4/chips.json`），缓存从「一个全局 cache」改成「按文件路径的 Map」，否则装了 F4 再查 F1
会互相顶掉。

### 63.4 模板参数化：三处 F1 字面量都按族替换

脚手架模板 `templates/scaffold/` 是 F1 工程的快照，里面有三种 F1 痕迹，过去对非 F1 族是直接拒绝：

| F1 痕迹 | 出现在 | 这一步怎么处理 |
| --- | --- | --- |
| `STM32F1xx` / `stm32f1xx`（CMSIS 目录、HAL 目录、hal_conf 名） | `cmake/stm32cubemx/CMakeLists.txt` | `renderCmakeLists()`：先换设备宏/启动文件，再按族换目录名 |
| `STM32F103xB` / `startup_stm32f103xb.s` | 同上 | `renderStartupAndDefine()`（原有） |
| `target/stm32f1x.cfg` | `openocd.cfg`、`.vscode/launch.json` | `renderOpenocdTarget()`：按族画像的 openocdTarget 换；**族没有脚本时原样保留并告警**，绝不猜别的族 |

`.ioc` 也不能拿 F1 的骨架改型号：时钟树、RCC 键名、`Mcu.IP` 清单逐族不同，改个型号名 CubeMX 打开就报配置不一致。
所以资源包按族发 `ioc/family/<族>.ioc`（CubeMX 6.15 无头 `config load` + `config save` 认证过的最小配置，
只留 SWD 两脚），插件用 `assetsFamilyIocText()` 取；取不到就**拒绝建工程**，不留半成品。

固件包按族找（`resolveFamilyFirmwareRoot()`）：`<CubeMX>/Repository/STM32Cube_FW_<族>_V*` 取本机已装的最高版本，
`L4+` 与 `L4` 共用 `STM32Cube_FW_L4`。**F1 仍然是默认 `V1.8.7`**（显式包名优先）——否则同一台机器上装了
1.8.4/1.8.5 的时候，「最高版本」会把老工程悄悄换基线。

### 63.5 踩到的真坑：`STM32F407xX`

F4 第一轮验收：create ok、generate ok（`STM32Cube_FW_F4_V1.28.3`，6 个文件落位），**build 挂**：

```
stm32f4xx.h:174:2: error: #error "Please select first the target STM32F4xx device used in your application"
stm32f4xx_hal_rcc_ex.h:47:3: error: unknown type name 'uint32_t'
```

根因不在芯片表，在 `src/engine/cmake-sources.ts` 的老规则 `deviceDefineFromStartup()`：

```ts
// 旧实现：upper 之后把「倒数第二个 X」换小写
return startupStem(file).toUpperCase().replace(/X(?=.$)/u, "x");
```

这条规则只对 `xb/xc/xe`（x + 容量字母）成立。对 xx 档 `startup_stm32f407xx.s`，upper 得到 `STM32F407XX`，
替换第一个 X 得到 **`STM32F407xX`** —— CMSIS 头里没有这个宏，于是 `#error` 连锁导致 `uint32_t` 都没定义。
对「按封装分档」的 `startup_stm32f410cx.s` 更糟：要的是 `STM32F410Cx`（大小写与 xb 相反）。

修法是让尾缀规则只有一个出处：`deviceDefineFromStartup()` 拆出尾缀交给 `defineSuffix()`，
`stem.slice(0,-2).toUpperCase() + defineSuffix(stem.slice(-2))`，并在 `cmake-sources-units` 补四条
（`f407xx → STM32F407xx`、`g431xx`、`f410cx → STM32F410Cx`、`l4p5xx → STM32L4P5xx`）。

教训写在这里：**「设备宏」这种东西错了不会在生成期暴露**，CubeMX 照样 `Code succesfully generated`，
只有真编一次才看得见；所以按族扩支持必须带「建工程 → 生成 → 编译」三段的真机验收，只验前两段等于没验。

### 63.6 六族真机验收（create → generate → build）

`demo/.dsh-stm32/accept-family.mjs`（仓库外）逐族跑：`createProjectScaffold` → `runGenerate`（`skipIfUnchanged:false`，
强制真跑 CubeMX）→ `runBuild`，工具链 `D:/app/msys64/ucrt64/bin`（arm-none-eabi-gcc 13.3.0 / newlib 4.5.0），
CubeMX `D:/app/STM32CubeMX`。

| 族 | 芯片 | 启动文件 / 设备宏 | 固件包 | 结果 | elf |
| --- | --- | --- | --- | --- | --- |
| C0 | STM32C031C6T6 | `startup_stm32c031xx.s` / `STM32C031xx` | `STM32Cube_FW_C0_V1.4.1` | create+generate+build **ok** | 558388 B（RAM 12.89% / FLASH 8.91%） |
| F0 | STM32F030C8T6 | `startup_stm32f030x8.s` / `STM32F030x8` | `STM32Cube_FW_F0_V1.11.6` | **ok** | 449716 B（RAM 19.34% / FLASH 5.4%） |
| F1 | STM32F103C8T6 | `startup_stm32f103xb.s` / `STM32F103xB` | `STM32Cube_FW_F1_V1.8.7` | **ok**（老路径零变化） | 654432 B（RAM 7.73% / FLASH 7.18%） |
| F4 | STM32F407VGT6 | `startup_stm32f407xx.s` / `STM32F407xx` | `STM32Cube_FW_F4_V1.28.3` | **ok**（修 63.5 之后） | 962396 B（RAM 1.21%） |
| G4 | STM32G431CBT6 | `startup_stm32g431xx.s` / `STM32G431xx` | `STM32Cube_FW_G4_V1.6.2` | **ok** | 883292 B（RAM 4.83% / FLASH 3.68%） |
| L0 | STM32L071CBT6 | `startup_stm32l071xx.s` / `STM32L071xx` | `STM32Cube_FW_L0_V1.12.4` | **ok** | 536728 B（RAM 7.73% / FLASH 3.05%） |

六族全部 **0 warning**，CubeMX 一次生成成功（`verdict.errors` 空）。C0 的 create 会多一条告警：
openocd 0.12 没有 `stm32c0x.cfg`，工程里的 `openocd.cfg` 仍指向 `stm32f1x` —— 这正是「烧录能力 ≠ 建工程能力」，
下一步内置 C0/U0 的 target 脚本时消掉。

### 63.7 资源包构建（含 G4 族模板重做）

`node scripts/build-assets.mjs --families C0,F0,F4,G4,L0` →

- C0 78 颗 / F0 111 / F4 209 / G4 168 / L0 177（F1 老管线 111 颗仍在），**79 个资产 / 13.85 MB**，manifest 版本未变（`2026.11.01-1`）。
- G4 的 `templates/family/G4.ioc` 第一版是坏的（150 s 超时，只回写出 22 个键、没有时钟树）：
  重跑 `probe-family-template.mjs G4 "STM32G431C(6-B)Tx" STM32G431CBT6 LQFP48 STM32G431CBTx` →
  148866 ms、exit 0、**109 键**、SYSCLK 16 MHz。族模板这种「一次 2–3 分钟」的活必须看退出码 + 键数，
  超时被杀也可能留下半份文件。
- skip 23 条：F1 老问题 14 条（F100 没有 x4/x6 档、F105/F107 没有 x8/xb 档）+ **G4A1 9 条**
  （`line 4A1` 在 G4 固件包里没有匹配的启动文件档位，待查是否真缺 `startup_stm32g4a1xx.s`）。

### 63.8 单测与包体

- 新 `test/family-facts-units.test.mjs`（11 例，已进 `test/run-units.mjs` 清单）：
  `familyFactsRelOf` 四种输入、`defineSuffix`、`namingFrom`（F4 407 / 410cx / L4+ 4P5 / 坏 group 全空串）、
  按族读表互不干扰、`findChipFact` 分发、`resolveHalChip` 五型、`renderCmakeLists`（含模板缺键抛错）、
  `renderOpenocdTarget`（F4 换 / F1 保持 / C0 原样 + note）、`resolveFamilyFirmwareRoot`（假 Cube 根取最高版本 /
  显式包名 / 缺失 / L4+）、`assetsFamilyIocText`、14 族 halScaffold 放行与 6 族拒绝。
- 按新行为改了三处老断言：`family-units` 的 `f4.capabilities.halScaffold` 由 false 改 true（并注明预设/时钟仍 false）、
  `hal-route-units` 的「F407 必须被拒」换成 `STM32H743ZIT6`（族外/资源包没装）、`scaffold-patch-units` 的
  「找不到 CubeMX 固件包」文案锚点（现在文案带族名，显式包名原样报、不追加 `_V*`）。
- `cmake-sources-units` 补 4 条 `deviceDefineFromStartup`（63.5）。

### 63.9 这一步**没有**做什么（别当成已支持）

- **时钟规划、.ioc 外设预设、SVD 校验、寄存器版模板仍然只有 F1**：非 F1 族照旧明确拒绝（`capabilities` 为 false）。
- **C0 / U0 的 target 脚本是插件自带的**（§63.10）：本机 openocd 0.12 没有 `stm32c0x.cfg` / `stm32u0x.cfg`，
  插件内置了一份把 `-tap` 换成 `-chain-position` 的适配版；**还没在 C0/U0 真板子上烧过**（手上没有这两族的板子），
  「脚本能被 0.12 完整加载」是验证过的，「烧写时序在真芯片上对不对」没有。
- **F2 / F3 / F7 / G0 / L1 / L4 / L4+ / U0 没有真机验收**：本机 CubeMX Repository 里只有 C0/F0/F1/F4/G4/L0 六族固件包，
  其余族要先用 CubeMX 包管理器装包（插件的 `stm32_firmware_install` 目前只能下 F1）。
- **链接脚本仍是「F1 模板改尺寸」**：F4 的 CCMRAM（0x10000000）没有 `.ccmram` 段；不用 CCM 时无影响，
  要用 CCM 就得按族给真模板。

### 63.10 内置 C0 / U0 的 openocd target 脚本

openocd 0.12 是 2023-01 的最后一个正式版，包里没有 `stm32c0x.cfg` / `stm32u0x.cfg`（两族都更晚）。
升级 openocd 不是选项（本机 pacman/xPack/上游正式版都停在 0.12），所以在**插件里带一份适配脚本**，
不去改用户机器上的 openocd 安装：

| | C0 | U0 |
| --- | --- | --- |
| 文件 | `templates/openocd/stm32c0x.cfg`（2088 B） | `templates/openocd/stm32u0x.cfg`（1853 B） |
| 来源 | openocd master `tcl/target/stm32c0x.cfg` | openocd master `tcl/target/stm32u0x.cfg` |
| 与上游的差异 | 只把 `dap create $_CHIPNAME.dap -tap $_CHIPNAME.cpu` 换成 `-chain-position` | 同上 |
| 关键事实 | CPUTAPID 0x0bc11477、work-area 0x1800、flash bank 用 `stm32l4x` 驱动 @0x08000000、otp @0x1fff7000 | CPUTAPID 0x6ba02477、work-area 0x1000、flash bank `stm32l4x` @0x08000000、otp @0x1FFF6800 |

为什么只改一处就够：0.12 的 `dap create` 没有 `-tap` 参数（会报 `Unknown param: -tap`），
换成同义的 `-chain-position` 后整份脚本在 0.12 上**完整加载**（adapter / target / flash bank 全部通过），
只有没接探针时 `init` 会报 `Error: CMSIS-DAP command CMD_INFO failed.` —— 这正是「脚本没问题、只是没硬件」。
GPL-2.0-or-later 头保留在文件里，注释写清来源与这处改动。

接线只有三处，其余全复用：

1. `src/data/family.ts`：族画像加 `bundledTarget`（C0 → `stm32c0x`、U0 → `stm32u0x`），
   `bundledOpenocdConfig(name)` 给出模板目录里的**绝对路径**；`chooseOpenocdTarget()` 在
   `openocdTarget === null` 但 `bundledTarget !== null` 时返回该绝对路径（`bundled: true`、`error: ""`），
   模板缺文件才报「插件安装不完整」。`OpenocdTargetChoice` 的 `targetConfig` 语义因此变成
   「原样传给 openocd `-f` 的值」——正常是相对 scripts 目录的路径，内置时是绝对路径。
2. `flash.ts` / `debug.ts` / `debug-session.ts` / `regs.ts` 四个调用点**一行都不用改**：它们本来就透传
   `choice.targetConfig`。
3. `scaffold.ts` + `renderOpenocdTarget(text, facts, variant)`：建工程时把插件里那份 cfg 复制到工程
   `openocd/<name>.cfg`（失败即整体拒绝，不留半成品），`openocd.cfg` 里写
   `source [find openocd/stm32c0x.cfg]`，`.vscode/launch.json` 的 configFiles 写
   `${workspaceFolder}/openocd/stm32c0x.cfg` —— 工程自带脚本，换机器、换 openocd 版本都还能用。

验证（不需要真板子）：

```
cd <新建的 C0 工程>
openocd -f interface/cmsis-dap.cfg -f openocd/stm32c0x.cfg -c "init; shutdown"
# 期望：exit=1，唯一错误 Error: CMSIS-DAP command CMD_INFO failed.（没接探针）
# 出现 Unknown param: -tap / invalid command name 之类，说明脚本语法没适配好
```

C0 建工程冒烟（`accept/C0-openocd`）：create ok，`openocd.cfg` 含
`source [find interface/cmsis-dap.cfg]` / `transport select swd` / `source [find openocd/stm32c0x.cfg]` /
`adapter speed 2000`，launch.json 两条 configFiles 都指向 `${workspaceFolder}/openocd/stm32c0x.cfg`，
工程内 `openocd/stm32c0x.cfg` 存在，`chooseOpenocdTarget(readProjectFamily(dir))` 给出插件内的绝对路径。

**还没做的诚实说明**：手上没有 C0/U0 板子，所以「能连上、能烧、烧完能跑」没有真机证据；
H5 / N6 / U3 / WBA / WB0 / WL3 / MP2 依旧没有脚本（也不在 14 族范围里），照旧明确拒绝。

## 64. 全系列第三步：.ioc 外设预设按 db 派生（先做串口）

### 64.1 为什么不手抄 14 份预设表

F1 的 `PERIPHERAL_PRESETS`（`src/data/ioc-presets.ts`）是手写表：USART1 → PA9/PA10、TIM3 → PA6（共享信号
`S_TIM3_CH1`）、ADC1 → PA1（`ADCx_IN1` + `RCC.ADCPresc`），每条都是真机验过的。这套表**换族就失效**：
同一颗 F4 上 USART1 的默认脚可以是 PA9/PA10 也可以是 PB6/PB7，TIM2_CH1 落在哪根脚要看具体型号，
共享信号的规范名（`S_TIMx_CHy`）与 ADC 的 Rank/采样参数也各不相同。手抄 14 份表 = 把 14 族手册各抄一遍，
抄错一根脚的表现是「plan 成功、CubeMX 一打开把整个外设丢掉」——最贵的那种错。

CubeMX 自己就有这些事实：`db/mcu/<Mcu.Name>.xml` 里每个 `<Pin>` 的 `<Signal>` 就是「这根脚能做什么」，
`db/mcu/IP/<IP>-<ver>_Modes.xml` 的 `<RefParameter DefaultValue>` 是参数默认值。所以这一步做的是**读 db 选脚**。

### 64.2 新模块 `src/data/db-presets.ts`

`derivePeripheralPreset(facts, name)` 返回 `{ preset, reason }`，第一步只覆盖串口（`USART` / `UART` / `LPUART` + 数字）。
选脚规则刻意写成**可复现的三条**、不掺型号特例：

1. 信号名必须**完全相等**（`<IP>_TX` / `<IP>_RX`）：db 里定时器通道信号既有 `TIM2_CH1` 也有合并的 `S_TIM2_CH1_ETR`，
   用前缀/includes 匹配会把「能做什么」和「做过什么」混一起；
2. 候选引脚按「端口字母 → 脚号」升序，跳过虚拟脚（`VP_*`）与带 `-`/`/` 后缀的名字；
3. 优先**同端口的一对**（PA9 + PA10）；没有同端口的对就各取一根，并在 `notes` 里写明跨端口。
   缺 TX 或缺 RX 直接拒绝并点名缺哪一路。

参数只写 `VirtualMode=VM_ASYNC`（异步），其余走 CubeMX 缺省（8N1 / 115200）。
TIM / ADC 到这里会拿到明确的人话（「还没按族派生…现在请用 pins + entries 手写」），宁可拒绝，也不写一份 CubeMX 会丢的配置。

### 64.3 解析顺序：F1 用内置表，非 F1 用 db 派生

第一版写成「先查内置表、没有才派生」，F4 上立刻露馅：`findPeripheralPreset("USART1")` 命中 F1 表，
走的是手写 PA9/PA10，**db 派生根本没跑**（round-trip 的 notes 写「已启用预设 USART1」而不是「按 db 派生」）。
PA9/PA10 在 F4 上碰巧也对，所以没暴露错误 —— 这正是「巧合成立」的陷阱。

改成按族分流（`src/engine/ioc-plan.ts` 的 `enablePeripheral` 新增 `familyId` 参数）：F1 用内置表；
非 F1 **只允许与脚无关的两类**内置预设 —— `TIMx:timebase`（纯时基，不占脚）与 `DMA:<IP>`（`Dma.*` 键与脚无关），
其余一律走 db 派生。

### 64.4 闸门变化：从「整族拒绝」到「逐条报人话」

原来 `ioc-plan.ts` 的 `presetsSupported` 闸门在 `capabilities.iocPresets` 为 false 时把整个 `peripherals` 忽略掉。
现在改成逐条解析：每条要么成功（内置表或 db 派生），要么给出**这一条**为什么不行（名字不在 db 的 IP 清单里 / 缺 TX /
TIM 还没派生 / 认不出的名字）。`capabilities.iocPresets` 语义收窄成「有手写脚位表」，
`CAPABILITY_GAPS.iocPresets` 文案改为「手写 .ioc 预设表只有 F1（其它族靠 db 派生 USART/UART/LPUART，TIM/ADC/DMA 仍需手写键）」。

### 64.5 顺带修掉一个假 diff：`ProjectManager.ProjectFileName`

F4 第一轮往返 `benign` 是 false，唯一差异是 `ProjectManager.ProjectFileName: demo.ioc -> blink_f4.ioc`：
模板里这个键固定写 `demo.ioc`，工程文件实际叫 `<工程名>.ioc`，CubeMX 保存时按真实文件名改回去，
于是**每次** plan→verify 都多一条「值被改写」。修法：`renderIoc(template, facts, projectName)` 多收一个工程名，
建工程时把这个键一起渲染（可选键，老模板没有这项也不报错）。

### 64.6 验证与数字

真机往返（F4，`demo/.dsh-stm32/f4-usart-verify.mjs`）：新建工程 → `peripherals: [{ name: "USART1" }]` → apply → `runIocVerify`：

```text
notes : 按 db 派生预设 USART1（USART1 异步串口（按 db 选脚 PA9/PA10））
计划  : PA9.Signal=USART1_TX / PA10.Signal=USART1_RX / 两个 .Mode=Asynchronous / USART1.VirtualMode=VM_ASYNC
verify: benign=true；droppedPeripherals / missingKeys / signalRewrites / valueChanged 全空
        message「CubeMX 认了全部 4 个外设；计划生成 2 个初始化函数」
```

单测：新增 `test/db-presets-units.test.mjs`（8 例，已进 `test/run-units.mjs`）——同端口优先（PB6 有 TX 但不配对 → 仍选 PA9/PA10）、
跨端口、缺 RX、实例不在 db（列出真实 IP 清单）、虚拟脚/带后缀脚不参与、TIM/ADC 给「还没派生」、facts=null、LPUART 同规则。
`ioc-plan-units` 里「不认识的外设预设」那条断言改成 `/不能启用/u`（文案变了）。

### 64.7 这一步**没有**做什么

- **TIM / ADC / DMA 的预设还没按族派生**：定时器要处理共享信号（`S_TIMx_CHy` + `SH` 块）与通道参数，
  ADC 要定 Rank/采样时间，DMA 要按族的请求表校验通道名。这三类在非 F1 上仍是「请手写键」。
- **时钟规划仍只有 F1**：`clock-plan.ts` 的 RCC/PLL 上限表只覆盖 F1，非 F1 的 `clock` 参数照旧被拒。
- **只有 F4 做过逐键往返**：C0/F0/G4/L0 有建工程→生成→编译的证据（§63.6），但没对 db 派生预设做 round-trip；其余 8 族连固件包都还没装。

## 65. 把 F1 也切到 db 派生：手写预设表只剩 db 表达不了的三类

### 65.1 为什么连 F1 也不该用手写表

用户的判断是对的：手写表里的每个值本来就来自某个版本的 CubeMX db，抄下来就成了「快照」——
db 换版本、族换型号，快照立刻变成错误事实。这一步之后**所有能查 db 的预设都走 db**，F1 也不例外：
手写表退化成两件事：db 表达不了的三种预设（见 65.4），以及没装 CubeMX 时的离线兜底。

### 65.2 代码改动

- `src/data/db-presets.ts` 扩到三类：串口（USART/UART/LPUART）、定时器 PWM（`TIMx` → CH1）、ADC 单通道（`ADC1` → 优先 IN1）。
  新增 `DbPresetOptions { familyId }`：只有 F1 才在 ADC 预设里带 `RCC.ADCPresc=RCC_ADCPCLK2_DIV6`（F1 ADC 上限 14 MHz），
  其它族只提醒「要降频请用 entries 设」。
- **修掉一个会丢脚的 bug**：`pinsWithSignal` 原先「名字含 `-` 就跳过」，会把 F1 的 `PA0-WKUP`（TIM2_CH1 的默认脚）整根丢掉。
  现在用 `logicalPinName()` 映射成逻辑名（PA0）后再写进预设，只跳过 `VP_*`。
- `.ioc` 写法与 db 不同的两处集中在这里处理（语料实证：504 份官方板级 .ioc）：
  定时器通道 `.ioc` 写 `S_<db 信号名>`（`S_TIM2_CH1`），ADC 通道 `.ioc` 写 `ADCx_INn`（不是 `ADC1_INn`），实例由 SH 块表达。
- `src/engine/ioc-plan.ts`：解析顺序改成**db 优先（所有族）** —— 变体/DMA 用手写表；其余先派生，db 不可用才回退手写表；
  两者都没有才报错（错误文案带这一条的具体原因 + 手写表清单）。

### 65.3 真机证据（F1，plan → apply → CubeMX 回写逐键比对）

```text
peripherals: [{name:USART1},{name:TIM2},{name:ADC1}]
notes : 按 db 派生预设 USART1（按 db 选脚 PA9/PA10）/ TIM2（按 db 选脚 PA0）/ ADC1（按 db 选脚 PA1）
写入  : PA9.Signal=USART1_TX, PA10.Signal=USART1_RX, PA0-WKUP.Signal=S_TIM2_CH1,
        SH.S_TIM2_CH1.0=TIM2_CH1,PWM Generation1 CH1, PA1.Signal=ADCx_IN1, SH.ADCx_IN1.0=ADC1_IN1,IN1
verify: benign=true；droppedPeripherals / signalRewrites / valueChanged / missingKeys 全空
```

注意 `S_TIM2_CH1` 与手写表里的 `S_TIM2_CH1_ETR` 不同：后者是某个 db 版本的合并名，CubeMX 对两者都认，
但**只有 db 派生的那个永远与当前 db 一致**。这条差异本身就是「别抄快照」的证据。

### 65.4 手写表现在只剩三类（都写清了为什么）

| 预设 | 为什么 db 给不出来 |
| --- | --- |
| `TIMx:timebase` | 不占引脚，只有 Prescaler/Period 取值，db 的引脚信息里没有「纯时基」这种用法 |
| `DMA:<IP>` | 「哪个外设请求对应哪条 DMA 通道」不在 db 的引脚复用例表里 |
| `ADC1:1,4,5` | 多 Rank 扫描的通道顺序、Rank 编号，是调用方的意图而不是 db 事实 |
| （离线兜底） | 没装 CubeMX / db 里没这颗时，退回手写表并在 notes 里写明「内置表兜底启用」 |

### 65.5 同类「手抄事实」盘点（这一节的用途：下一步照单清理）

| 位置 | 抄的是什么 | 真源 | 结论 |
| --- | --- | --- | --- |
| `src/engine/clock-plan.ts`（`F1_PLL_MULS` / `F1_APB_DIVS` / 上限表） | 各族的 PLL 倍频枚举与 APB 分频 | `db/mcu/IP/RCC-*_Modes.xml` 的 `<RefParameter Name="PLLMUL" Type="list">` → `PossibleValue RCC_PLL_MUL2..`（已核实存在），上限用 MCU xml 的 `<Frequency>` | **可改**，是时钟规划全族化的钥匙 |
| `src/engine/hal-chip.ts` `PIN_COUNT_BY_PACKAGE`（T/C/R/V/Z→36/48/64/100/144） | 封装脚数 | `device/<族>/chips.json` 的 `pinCount`（db `<Package>` + `<Pin>`） | **可删** |
| `src/engine/hal-chip.ts` `MCU_NAME_GROUPS`（F1 分组名） | db 的 `RefName` 分组名 | `chips.json` 的 `mcuName` | **可删** |
| `src/data/device-facts.ts` `namingFrom` ↔ 资源仓 `family-assets.mjs` `namingOf` | 启动文件/设备头/设备宏的拼法（两侧必须逐字一致） | 资源仓生成器 + 固件包 existsSync 验过的显式字段 | 收敛为「插件只读表里的显式字段，`namingFrom` 只给老资源包兜底」 |
| `src/data/ioc-presets.ts` `PIN_DB_ALIASES`（F1 六根带后缀脚） | db 的引脚名（PA0-WKUP…） | 运行时的 `pinNameResolver`（已按 db 解析） | 保留为离线兜底，语义已在注释里写清 |
| `src/data/ioc-presets.ts` `ADC_PIN_BY_CHANNEL` | 通道 → 默认脚 | db 的 `ADC1_INn` 复用例（同一套派生逻辑，批量版即可） | 可改（多 Rank 预设下一步一起做） |
| `src/data/ioc-presets.ts` `ALLOWED_DMA_IP` + `DMA1_ChannelN` | 外设 → DMA 通道映射 | db 的 `DMA-*_Modes.xml` 有 DMA 实例参数，但「请求映射」不在其中 | **保留**（要另找来源，不能凭 db 引脚猜） |
| `src/data/family.ts` 里每族的 `core` | 内核 | MCU xml 的 `<Core>`（db 已是权威） | 可改（`openocdTarget` 只能手写：openocd 脚本名不在 db 里） |
| `src/data/cmsis-sources.ts` 四张 sha256 表 | 下载资源的指纹 | 上游文件本身 | **必须保留**（安全边界） |
| `src/engine/route-plan.ts` `PERIPHERAL_RULES` | 「这个需求该走 HAL 还是寄存器」的经验规则 | 没有权威源 | **保留**（是判断，不是事实） |

结论：真正值得下一步动的只有两件 —— **时钟规划改成从 `RCC-*_Modes.xml` 的枚举 + `<Frequency>` 派生**（收益最大），
以及 `PIN_COUNT_BY_PACKAGE` / `MCU_NAME_GROUPS` / 每族 `core` 这三处小表（都已有现成真源，删掉即可）。

## 66. 全系列第四步：时钟事实从 db 派生（pllmul 模型先落地，F1 零回归）

### 66.1 为什么连时钟表也不该手抄

`src/data/clock-f1.ts` 里的 `F1_PLL_MULS`（×2..×16）、`F1_APB_DIVS`（÷1/2/4/8/16）、`F1_ADC_DIVS`（÷2/4/6/8）、
`F1_PLL_SOURCES` 与 `F1_CLOCK_LIMITS` 全是**某个 db 版本枚举值的手抄快照**。db 里恰好都有：
`db/mcu/<Mcu.Name>.xml` 的 `<Frequency>` 就是该型号的 SYSCLK 上限；`db/mcu/IP/RCC-*.xml`（Modes）里
`<RefParameter Name="PLLMUL" Type="list">` 的 `<PossibleValue Value="RCC_PLL_MUL2" Comment="2"/>` 就是倍频枚举。
抄快照的代价在 §65 已经算过一次（`S_TIM2_CH1_ETR` 是旧版本名），时钟表同理。

### 66.2 新层：`ClockFacts` + `readClockDbFacts`

- `src/data/clock-f1.ts` 新增 `ClockFacts { muls, sources, apbDivs, adcDivs, limits, usb, peripheralClocks, baudList }`
  与 `F1_FACTS`（由现有 F1 常量拼成，**只作没有 db 时的兜底**）；`pllSourceById(id, sources = F1_PLL_SOURCES)` 收源列表；
  `PllSourceFact` 加 `divider?`（PLL 输入前的固定分频，见 66.5）。
- 新 `src/data/clock-db.ts`：`readClockDbFacts(db, facts)` 用 RCC 实例的 `ipModesPath()` 找到该族的 Modes 文件
  （RCC 的 `Version` 属性本身就是族专属文件名，例如 F103 → `RCC-STM32F102_rcc_v1_0_Modes.xml`），解析出：
  `model`（有 `PLLMUL` → `pllmul`；有 `PLLM`/`PLLN` → `pllmn`；都没有 → `unknown`）、`sysclkMaxHz`、`muls`、`sources`、
  `apbDivs`（APB1CLKDivider 枚举）、`adcDivs`（ADCPresc 枚举）、`pllM`/`pllN`(Min/Max)/`pllP`。
- `clockFactsFromDb(dbFacts, familyId)` 把 db 事实 + 该族总线上限合成 `ClockFacts`；`pllmn`/`unknown`/上限未建档一律返回 null。

### 66.3 planClock 参数化（F1 输出零变化）

`clock-plan.ts` 里 35 处 `F1_*` 引用改成读模块级 `activeFacts`（`planClock` 入口 `activeFacts = ctx.clockFacts ?? F1_FACTS`；
planClock 是同步单线程，入口赋值即可），新增 `activeHsiHz`（从 `.ioc` 的 `RCC.HSI_VALUE` 读，缺省 8 MHz）与
`pllInHzOf(source, hseHz)`。`ClockPlanContext` 加 `clockFacts?: ClockFacts`。
**F1 的 14 个 clock 单测一条都没改、全绿**，说明参数化没动行为。

### 66.4 db 里没有的（仍然手写，别以为这一层能替）

| 事实 | 为什么 db 给不出 | 现在的做法 |
| --- | --- | --- |
| APB1 / APB2 / ADC 频率上限 | 数据手册规格，db 只给引脚与枚举 | `BUS_LIMITS` 只收**核过的族**（F1 36/72/14、F0 48/48/14、L0 32/32/16），没建档的族直接拒绝规划 |
| USB 48 MHz 规则 | 各族来源不同（F1 要 PLL=72 再 ÷1.5；F0/L0 是 PLL=48） | 非 F1 标成「未建模」（`requiresPllClkHz = 0`）→ 报告里说 USB 不可用，不套 F1 的规则 |
| 外设挂哪条总线 | db 不写 | 沿用 F1 的 kind 映射（这几个族的分配相同），未覆盖的族后续按手册补 |

### 66.5 踩到的坑：F0 的 `RCC_PLLSOURCE_HSI` 是 HSI÷2

第一版 F0 规划 48 MHz 时选了「HSI ×6」（8 MHz×6），交给 CubeMX 回写后**全部变成 24 MHz**：
F0 的 `RCC_PLLSOURCE_HSI` 在硬件上就是 HSI÷2 进 PLL（这类族没有单独的 `HSI_DIV2` 枚举值）。
修法：`readClockDbFacts` 发现「有 `hsi` 但没有 `hsi-div2`」时给该源标 `divider: 2`，
`pllInHzOf` 按 `activeHsiHz / divider` 算输入频率；重跑后计划变成「HSI ×12」，CubeMX 回写**频率全部保持 48 MHz**。

### 66.6 真机验收

- **F1**（72 MHz，db 派生的时钟事实）：`plan → apply → CubeMX 回写` → **`benign=true`**，值差异全空。
  notes「目标 72 MHz 可达：HSE（外部晶振）×9」，写入 `RCC.PLLMUL=RCC_PLL_MUL9`、`APB1CLKDivider=RCC_HCLK_DIV2` 等。
- **F0**（48 MHz，非 F1 的 pllmul 族）：计划「HSI ×12 → 48 MHz」；CubeMX 回写后 `SYSCLKFreq_VALUE / HCLK / APB1 / PLLCLK`
  **全部保持 48 MHz**，唯一差异是 `RCC.IPParameters` 里多了一项 `USART1Freq_Value` —— CubeMX 给已启用的 USART1 补了
  派生频率键，而我们的计划不写这类「按外设逐个生成」的 `RCC.<IP>Freq_Value`。频率数值零差异，这一条记在 §66.7。

### 66.7 没做什么

- **`pllmn` 模型（PLLM/PLLN/PLLP）已实现，但只对 F4 开放**（§68）：F2/F7/G4/L4 的总线上限与 VCO 区间还没按手册核过，
  对这些族的 `clock` 参数仍然明确拒绝（db 侧事实已经读得到，缺的是"核过的规格表"）。
- **`unknown` 模型（H7 的分相 PLL、U5 的 EPOD）**：拒绝，理由写在 note 里。
- **`RCC.<IP>Freq_Value` 这类派生键不写**：CubeMX 会自己补（F0 实测多出 `USART1Freq_Value`），
  所以逐键比对会看到 `RCC.IPParameters` 变化一次；要消掉它得按外设实例枚举总线，留作下一步。
- **F0 的族模板缺 SWD 两脚**：`ioc/family/F0.ioc` 是 `PinsNb=0`，直接用会被「没有 Serial Wire」的安全闸拦下，
  验收时是显式加 `serialWire: true` 过的；资源包里这一份模板要重做（C0/F4/L0 都带 PA13/PA14）。

## 67. ② 清掉手抄小表：hal-chip 的封装脚数与 F1 分组名

### 67.1 删了什么、凭什么

`src/engine/hal-chip.ts` 里有两张纯手抄表，都是 db 的转述：

| 删掉的 | 原来的用途 | 现在的真源 |
| --- | --- | --- |
| `PIN_COUNT_BY_PACKAGE`（T/C/R/V/Z → 36/48/64/100/144） | F1 路径算 `pinCount` 与封装名（`LQFP48`） | 资源包 `device/f1/chips.json` 的 `pinCount`（生成器按 db 的 `<Package>` + `<Pin>` 数出来） |
| `MCU_NAME_GROUPS` + `GROUP_LETTERS` + `grouped` 判定 | 用 line + 封装字母 + 容量字母拼出 db 分组名（`STM32F103R(C-D-E)Tx`） | 同一个 `chips.json` 的 `mcuName`（生成器直接抄 db 的 `RefName`） |

顺带给 `src/data/stm32f1.ts` 的 `F1Chip` 加了 `mcuName` 字段（`chipFromFact` 从 `DeviceFactsChip.mcuName` 透传），
hal-chip 的 F1 分支现在是 `const pinCount = chip.pinCount;` 与 `chip.mcuName !== "" ? chip.mcuName : deviceId`，
空名时仍保留原来那句 note（「资源包里没有 … 的分组名，按具体型号名写」）。

为什么可以放心删：这两张表本来就只在 `resolveF1Chip` 之后做兜底 —— chips.json 一定有 `pinCount`/`mcuName` 两个字段，
而表里那些值是 db 某一版的手抄；db 换版本（或换族）时表和真源就会分叉，与 §65 的 `S_TIM2_CH1_ETR` 是同一类问题。

### 67.2 验证

删表后逐套件：`hal-route-units` 13 / `stm32f1-units` 18 / `scaffold-patch-units` 24 / `doctor-chip-units` 15，全绿；
`npx tsc` 干净。这些套件正好覆盖「C8T6 名字与链接脚本不变」「RCT6/F107 的启动文件/设备宏按芯片算」「渲染 .ioc 五个键」，
也就是说删表没有改变任何对外可见的事实。

### 67.3 第三项（每族 `core`）还没做，原因与下一步

`src/data/family.ts` 里每个族的 `core`（`Cortex-M3`/`Cortex-M4`…）其实 db 里就有（MCU xml 的 `<Core>`），
但现在**读不到**：`src/engine/cubemx-db.ts` 的 `parseMcuXml` 只取了 `RefName`/`Package`/`Frequency`/引脚/IP，
没有 `<Core>` 字段。所以这一步要按顺序做：

1. `cubemx-db.ts`：`CubemxMcuFacts` 加 `core: string`，`parseMcuXml` 里 `/<Core>([^<]+)<\/Core>/u` 取值（db 里只有
   `Arm Cortex-M3` / `ARM Cortex-M0` 这种写法，MP1/MP2 分别写 `Cortex-A7`/`Cortex-A35`，2 个老文件没有这个节点 → 空串）；
2. `breakpoints.ts` 的预算解析：读得到 db 时用 `facts.core` 走 `debugBudgetForCore()`，读不到才退回 `debugBudgetOfFamily(profile)`；
3. `family.ts` 的 `core` 字段保留为「没有 db 时的兜底」，并在注释里写清这一点；
4. 补 `cubemx-db-units` 的 `<Core>` 解析用例 + `breakpoints-units` 一条「db 的 core 优先」。

没有顺手做掉的原因：它要改 `CubemxMcuFacts` 的形状（缓存、假 db 夹具、若干测试都跟着动），
和「删两张表」不是同一量级的改动，混在一个提交里会让回归定位变难。

### 67.4 一个 CI-only 失败：测试不该绑死在「本机有没有 CubeMX」

GitHub 的 runner 上没有装 CubeMX，`ioc-plan-units` 里那条 TIM2 用例直接断言了 db 派生的共享信号名 `S_TIM2_CH1`，
于是 CI 上走手写表兜底（`S_TIM2_CH1_ETR`）就红了 —— 本地全绿、CI 红，正是这类断言的典型症状。

改法是断言**关系**而不是字面量：`PA0-WKUP.Signal` 必须匹配 `S_TIM2_CH1(_ETR)?`，且 `SH.<该名字>.0` 必须等于
`TIM2_CH1,PWM Generation1 CH1`、`ConfNb=1`。两种来源都是 CubeMX 认的名字（`S_TIM2_CH1_ETR` 只是旧 db 的合并名），
测试要证明的是「名字与 SH 块自洽」，不是「我这台机器上的 db 长什么样」。

验证方式：把 `STM32_CUBEMX_ROOT` 指到一个不存在的目录再跑同一套件（等价于 runner 上没有 CubeMX）：
改前 fail=1，改后 52/52 通过。
## 68. pllmn 时钟模型（F4 打通）+ 族模板自带的 SWD 两脚

### 68.1 pllmn：源 ÷ PLLM × PLLN ÷ PLLP

`src/engine/clock-pllmn.ts` 新增 `planClockPllmn({ request, entries, facts, familyId })`，输出与 pllmul 完全同形状的
`ClockPlan`，所以 ioc-plan 只是按 `facts.model` 分派、后面的写键逻辑不分叉：

- **事实**：`PLLM`/`PLLN`/`PLLP` 从 db 的 RCC Modes 读；**VCO 允许区间** db 不写（数据手册规格），按族放 `PLL_VCO_LIMITS`（目前只有 `STM32F4`：100–432 MHz，输入 1–2 MHz），没核过的族直接拒绝；
- **搜索**：源 × PLLM × PLLN（50..432 全扫）× PLLP，过滤 VCO 越界与 SYSCLK 超上限，取距目标最近的一档；同分优先用户指定的源、再优先 P 小的（VCO 高=抖动小）；
- **写键**：`RCC.PLLM/PLLN/PLLP`（F4 的 PLLM 是 **integer 字符串** `25`，PLLP 才是枚举 `RCC_PLLP_DIV2`），同时把 `RCC.PLLMUL` 放进 `unset`（模型切换时清理旧键），并合并 `RCC.IPParameters`。

### 68.2 一个解析 bug：`PLLM` 在 db 里是 integer，不是 list

F4 的 db 写的是 `<RefParameter Name="PLLM" Type="integer" Max="63" Min="2" DefaultValue="16"/>`（自闭合）。
第一版 `enumOf()` 用 `<RefParameter[^>]*Name="PLLM"[^>]*>([\s\S]*?)</RefParameter>` 抓块，自闭合标签没有 children，
于是它**吞掉了下一个块**，把 `PLLP` 的枚举名（`RCC_PLLP_DIV4`）当成了 PLLM 的值 —— 真机往返居然也被 CubeMX 接受
（因为它把 DIV4 当成 M=4），但写出来的键是错的、换个值就会炸。

修法两条：`enumOf` 先看开标签是不是 `/>`（integer 型直接返回空列表）；`pllM` 在 integer 型时用 `Min..Max` 生成
`{ div, iocValue: String(div) }`。修完后 F4 写出的就是 `RCC.PLLM=25`（HSE 8 MHz ÷25 = 320 kHz 输入，×336 = VCO 336 MHz，÷2 = 168 MHz）。

### 68.3 真机验收（F4，pllmn）

```text
plan  : 目标 168 MHz 可达：HSE（外部晶振）÷25 ×336 ÷2 → SYSCLK 168 MHz（VCO 336 MHz）
写键  : RCC.PLLM=25 / RCC.PLLN=336 / RCC.PLLP=RCC_PLLP_DIV2 / APB1CLKDivider=RCC_HCLK_DIV4（APB1 42 MHz）
verify: benign=true；valueChanged / missingKeys / addedKeys 全空
```

同一次验收里 F0（pllmul）也跑了：模板现在自带 SWD 两脚，**不再需要显式传 `serialWire: true`**；
计划写完后 CubeMX 保留全部频率值，唯一差异仍是 `RCC.IPParameters` 里多出 `USART1Freq_Value`（见 §66.7 最后一条）。

### 68.4 族模板的 SWD 信号名逐族不同（F0/L0 之前是空的）

生成族模板的脚本（`demo/.dsh-stm32/probe-family-template.mjs`）原来写死 F1/F4 的 `SYS_JTMS-SWDIO`/`SYS_JTCK-SWCLK`。
F0/L0 的 db 里这两根脚叫 **`SYS_SWDIO` / `SYS_SWCLK`** —— 名字不匹配，CubeMX 就静默地把两根脚连同 SYS 实例一起丢掉，
于是 F0/L0 的族模板是 `PinsNb=0` 的空配置（建出来的工程没有调试口，必须显式 `serialWire: true` 兜）。

现在脚本从 db 现查：`swdSignal("PA13", "SWDIO")` / `swdSignal("PA14", "SWCLK")`，写进 .ioc 的就是该族真实信号名。
重做后 F0 = 70 键 / L0 = 91 键，两份都带 `PA13.Signal=SYS_SWDIO`、`PA14.Signal=SYS_SWCLK`；
资源仓按新模板重新生成 `ioc/family/{F0,L0}.ioc`，`--check` 通过。

### 68.5 现在的能力边界

| 族 | 时钟模型 | 能不能规划 |
| --- | --- | --- |
| F1 | pllmul | ✅ 真机 benign=true（72 MHz，HSE×9） |
| F0 / L0 | pllmul | ✅（F0 48 MHz 真机验收；L0 有总线上限、尚未单独往返） |
| F4 | pllmn | ✅ 真机 benign=true（168 MHz，÷25×336÷2） |
| F2 / F7 / G4 / L4 / L4+ / C0 / G0 / F3 / L1 / F2 | pllmul / pllmn | ❌ 缺「核过的总线上限 / VCO 区间」，拒绝并说明 |
| H5 / U5 / H7 等 | unknown（分相 PLL） | ❌ 拒绝 |

## 69. 为什么生成时弹出 CubeMX 的"是否保存工程"模态框，以及为什么不替用户点它

### 69.1 现象

跑 `stm32_generate` 时，屏幕上出现 CubeMX 的 GUI 弹窗：

```text
Warning: Load Project
Project Untitled has been modified would you like to save the project ?   [Yes] [No] [Cancel]
```

不点它，生成就一直挂着（3–4 分钟的活变成无限等）。

### 69.2 原因：CubeMX 是单实例应用

插件走的是无头调用：`jre/bin/java.exe -Dfile.encoding=UTF-8 -jar STM32CubeMX.exe -q <script>`。
但 CubeMX 只允许一个实例：**GUI 已经开着时，新命令行会被转发给那个 GUI 进程**，`-q`（无界面）随之失效，
脚本在 GUI 里执行、装载工程时 CubeMX 发现当前编辑的工程（这里是一个叫 Untitled 的、还没保存过的窗口）被改动过，
就弹出上面那个模态框等人工决定。

也就是说：弹窗不是我们的脚本要保存什么，而是**用户自己开着的那个 CubeMX 窗口**在拦路。

### 69.3 插件的处理：先探测、先拒绝（不替你点按钮）

新增 `src/engine/cube-mx-guard.ts`：

- `findRunningCubeMxGui(subprocess)` 用 `tasklist /NH /FO CSV` 找 **`STM32CubeMX.exe`**（无头调用自己跑的是
  `jre/bin/java.exe`，不算），复用 `doctor.ts` 的 `parseTasklistCsv`；
- `describeCubeMxGuiConflict(processes)` 生成一句人话（点名 PID、说明单实例与模态框、让人关掉 GUI 再重跑）；
- `generate.ts` 与 `ioc-verify.ts` 在真正 spawn CubeMX **之前**调用它，检测到就直接失败返回；
- **探测失败不拦人**：非 Windows、`tasklist` 不可用、退出码非 0 一律当"没检测到"——不能因为诊断手段缺失就挡住正常生成。

报错长这样（不再是静默卡住）：

```text
检测到 STM32CubeMX 图形界面正在运行（STM32CubeMX.exe#8124）：CubeMX 是单实例，命令行会被转发给它，
无头模式（-q）失效并可能弹出"是否保存工程"这类模态框，生成会一直等下去。
请先关掉 CubeMX 窗口（或保存后退出），再重跑；不想关也可以先用 CubeMX 自己 Generate Code，再回来跑 stm32_build
```

### 69.4 为什么不做"CLI 点按钮"

技术上能用 PowerShell + UI Automation / SendKeys 去点那个 `Yes`/`No`，但不该做成常态：

1. 那是 CubeMX 的 **SWT 原生窗口**，控件结构没有稳定的自动化标识，只能按窗口标题 + 按钮文本匹配，
   换个语言（中文界面是"是/否/取消"）或换个 CubeMX 版本就点空；
2. UIA/SendKeys 都要求窗口在前台、且不能被别的窗口抢焦点（我们是在后台跑生成，做不到）；
3. 就算点中了，按的是**用户自己的**工程状态（"要不要保存 Untitled"）——这个决定轮不到插件替人做，
   点错（比如自动 Yes）会在 CubeMX 的工作目录里写出一个无关的 `Untitled.ioc`。

结论：这类"有人开着的 GUI 在挡路"的情况，正确做法是**发现并如实拒绝**，而不是绕过它。

### 69.5 已经弹出来了，该点哪个

**No**（不保存）。那个 `Untitled` 与我们的工程无关，Yes 只会多写一个无用的 `Untitled.ioc`；
Cancel 会让 CubeMX 继续停在旧工程上，脚本仍然不会前进。点完之后把 CubeMX 关掉，再重跑生成即可。

### 69.6 验证

`test/cubemx-guard-units.test.mjs` 4 例：认出 `STM32CubeMX.exe` 并报 PID、只有 `java.exe` 时返回空、
`tasklist` 退出码非 0 / spawn 报错时返回空（不拦生成）、冲突文案包含"单实例""关掉 CubeMX""模态框"。
全量 `node test/run-units.mjs` → **770 pass / 0 fail（48 套件）**，pack-size 护栏通过。

## 70. pllmn 时钟扩到 F7/G4/L4 + 内核改从 db 读

### 70.1 三个族的 pllmn 事实（都从 db 来，规格表按手册建档）

| 族 | PLL 事实（db） | 总线上限（手册） | VCO 区间（手册） | 验证 |
| --- | --- | --- | --- | --- |
| F7 | PLLM integer 2..63、PLLN 50..432、PLLP DIV2/4/6/8 | APB1 ≤54 MHz、APB2 ≤108 MHz、ADC ≤36 MHz | 100–432 MHz，输入 1–2 MHz | 216 MHz（HSE ÷25 ×432 ÷2）**benign=true** |
| G4 | PLLM DIV1..16、PLLN 8..127、PLLP DIV2..31 | APB1/APB2 = 170 MHz、ADC 走 ADC12CLockSelection（不用 RCC 预分频） | 96–344 MHz，输入 2.66–16 MHz | 170 MHz（HSE ÷2 ×85 ÷2）**benign=true** |
| L4 | PLLM integer、PLLN 8..86、**PLLR DIV2/4/6/8**（PLLP 是 PLLSAI1 的 DIV7/DIV17） | APB1/APB2 = 80 MHz、ADC 来自 PLLSAI1 | 64–344 MHz，输入 4–16 MHz | 80 MHz（HSE ÷1 ×20 ÷2）**benign=true** |

L4 那条是这一步最值得记的：它的 SYSCLK 输出不是 PLLP 而是 **PLLR**。db 里 `PLLP` 只有 `DIV7`/`DIV17` 两档 —— 那是 PLLSAI1 的输出。
所以 `readClockDbFacts` 现在会判 `sysclkOutput`：`PLLP` 全是 DIV7/DIV17 且存在 `PLLR` 枚举时，用 PLLR 当 SYSCLK 输出，
规划器相应写 `RCC.PLLR` 而不是 `RCC.PLLP`，并把另一个键放进 `unset`（模型切换时清理）。

### 70.2 引脚名后缀的第二种写法：`PA13 (JTMS-SWDIO)`

之前只处理了 F1 的连字符后缀（`PA0-WKUP`）。L4/F7 的 db 里同一根脚写成 **空格 + 括号里的复用功能**，
`resolveDbPinName` 认不出就会把键写成 `PA13.Signal=…`（CubeMX 不认这个键名 → 整根脚被静默丢掉）。
新增 `pinBaseOf(dbName)`（先按空白切、再按连字符切），`resolveDbPinName` 与 `logicalPinName` 都改用它；
实测 L476 `PA13 → PA13 (JTMS-SWDIO)`、F103 `PA0 → PA0-WKUP`、F767 `PA13 → PA13`。

### 70.3 内核（core）改从 db 读

`src/engine/breakpoints.ts` 的预算解析现在优先用**本机 CubeMX db 里这颗芯片的 `<Core>`**：
从 `.ioc` 的 `Mcu.Name` 查 `db/mcu/<Name>.xml`，读到就用它算硬件断点/观察点预算，
读不到（没装 CubeMX、db 里没这颗、老文件没 Core 节点）才退回族画像的 `core`；
报告里会注明来源是「本机 CubeMX db 的 `<Core>`」还是「族画像兜底」。
族画像的 `core` 因此降级为兜底值，与 `F1_FACTS`、`PIN_DB_ALIASES` 的处理方式一致。

### 70.4 验证

- **F7**：族模板（101 键，含 PA13/PA14 SWD、`CORTEX_M7`）→ plan「HSE ÷25 ×432 ÷2 = 216 MHz（VCO 432）」→ apply → verify **benign=true**。
- **L4**：族模板（92 键，引脚名 `PA13 (JTMS-SWDIO)`）→ plan「HSE ÷1 ×20 ÷2 = 80 MHz」+ 写 `RCC.PLLR=RCC_PLLR_DIV2` → verify **benign=true**。
- **G4**：真实脚手架工程（本机装了 STM32Cube_FW_G4_V1.6.2）→ plan「HSE ÷2 ×85 ÷2 = 170 MHz」+ `RCC.PLLM=RCC_PLLM_DIV2 / RCC.PLLN=85 / RCC.PLLP=RCC_PLLP_DIV2` → verify **benign=true**。
- 单测：clock-db 5 例、clock-pllmn 4 例、clock 14 例、breakpoints 18 例全绿；cubemx-db 新增括号引脚名一例。

教训仍要记：**用手搓的最小 .ioc 验时钟会得到假失败** —— CubeMX 会把 `Mcu.IP*`、引脚名、`RCC.IPParameters` 整体规范化
（`Mcu.IP0: SYS -> CORTEX_M7`、`PA13 -> PA13 (JTMS-SWDIO)`）；必须用 CubeMX 规范化过的族模板或真实脚手架工程。

### 70.5 仍然没做的

- **F7 / L4 没有固件包**（本机只装了 C0/F0/F1/F4/G4/L0），所以只能用「族模板 + 时钟往返」验证，
  不能 create→generate→build；它们的族模板也还没进资源仓（`build-assets.mjs` 的 family 循环要求固件包，会跳过）。
- **F2 / F3 / G0 / L1 / L4+ / C0 的时钟仍是拒绝**：缺「核过的总线上限 / VCO 区间」，db 事实已能读，只差规格表。
- `RCC.<IP>Freq_Value` 这类派生键仍不写（CubeMX 自己补，导致 `RCC.IPParameters` 有一次差异，见 §66.7）。

## 71. 固件包装配扩到 9 族：自己下载、自己装、逐族验收

### 71.1 装配表扩族

`src/data/firmware-packages.ts` 的 `FIRMWARE_FAMILIES` 原来只有 F1，现在 9 族：
F1 1.8.7 / F2 1.9.3 / F3 1.11.5 / F7 1.17.4 / G0 1.6.2 / L1 1.10.6 / L4 1.18.2 / U0 1.2.0 / C0 1.4.1。
每族写清 HAL 仓库（`stm32<f>xx-hal-driver`）、CMSIS 设备仓库（`cmsis-device-<f>`）、主仓库（`STM32Cube<F>`）与内核头集合；
**分支按仓库真实默认分支**：F2/F3/F7/G0/L1/L4 是 `master`，U0/C0 是 `main`（16 个仓库都用 GitHub API 核过）。

### 71.2 三个真坑

1. **每文件 30 s 的超时不够**：F7/L4 的 `device.tgz` 三个源全超时。`firmware-install.ts` 的 FetchOptions 现在是
   `timeoutMs: request.timeoutMs ?? 240_000`；改完 F3/L1/U0 也一次装成。
2. **M0+ 的内核头缺一个文件**：G0/U0 构建报 `core_cm0plus.h:1005: fatal error: mpu_armv7.h: No such file or directory` ——
   `core_cm0plus.h` 在 `__MPU_PRESENT=1` 时会 include 它。装配表的 G0/U0/C0 coreHeaders 已补 `mpu_armv7.h`，重装后两族都能编。
3. **资源仓看不见插件装的包**：`family-assets.mjs` 的 `findFirmwareRoot` 只搜 `Repository`，而插件把包装在并列的 `dsh-firmware` ——
   F7/L4 因此被跳过、生成不出 `chips.json`。现在两处都搜。

### 71.3 13 族 create→generate→build（全部 0 warning）

```text
C0  558,388 B    F0  449,716 B    F1  654,432 B    F2  925,072 B
F3  623,532 B    F4  962,396 B    F7 1,168,148 B    G0  615,704 B
G4  883,292 B    L0  536,728 B    L1  597,352 B    L4 1,134,232 B
U0  761,912 B
```

资源包同时扩到 12 族模板 + 13 族芯片表（91 个资产 / 14.05 MB，`--check` 与生成结果一致）。

### 71.4 遗留

- **G0 模板只留下 PA13、U0 模板 pins 全空**：这两族的 db 引脚名/信号名与生成脚本的假设不同，需要按 `readMcuFacts` 的真实键名重生成
  （不影响编译，只影响工程自带调试口）。
- F2/F3/F7/G0/L1/L4/U0 的包在 `dsh-firmware`（插件装的），不在 CubeMX 官方 `Repository`；CubeMX GUI 打开这类工程可能提示缺包，
  走插件的 `stm32_generate` 没问题（它用 `setCustomFWPath` 指过去）。

## 72. 时钟扩到 18 族：总线上限/VCO/分频枚举全部从 db 读（2026-11-03）

### 72.1 为什么原来只有 7 族能用 clock

`src/data/clock-db.ts` 里的 `BUS_LIMITS`（APB1/APB2/ADC 上限）只收 7 族、`PLL_VCO_LIMITS`（VCO 输入/输出区间）只收 4 族，
注释写的是「db 里没有这些数，属数据手册规格，按族手写」。**这句是错的**：

`db/mcu/IP/RCC-*_Modes.xml` 里 `<RefParameter Name="APB1Freq_Value" Max="30000000" …>` 的 `Min`/`Max` 就是 CubeMX 自己的校验上限，
同族还带 `VCOOutputFreq_Value` / `VCOInputFreq_Value` / `SYSCLKFreq_VALUE` / `HCLKFreq_Value` / `ADCFreq_Value`。
所以做成 `readClockDbFacts` 里读、手写表降级成「核过族的 override」：

- `ClockDbFacts` 新增 `sysclkMaxDbHz`（`SYSCLKFreq_VALUE` 的 Max）、`busLimits`（`BusLimits | null`）、`vco`（`PllVcoLimits | null`，含 `inMinHz`/`inMaxHz`）。
- 取值规则：**同名参数有多个变体**（`<Condition Expression="scale1">`／G4 的 150M 与 170M／U0 的 96–344M 与 96–128M）→ 取「最小的 Min + 最大的 Max」；
  `Max="=SYSCLKFreq_VALUE"` 这种表达式值一律丢弃（`numAttr` 里 `value.startsWith("=")` 直接当没有）。
- 名字回退：APB1 → `APB1Freq_Value` 再 `APBFreq_Value`（单 APB 族）；APB2 → `APB2Freq_Value` 再 `APBFreq_Value`；
  ADC → `ADCFreq_Value` → `ADC12outputFreq_Value` → `synchADCFreq_Value`，都没有就按 APB2 顶。
- `clockFactsFromDb`：`const limits = BUS_LIMITS[family] ?? facts.busLimits`（null 就返回 null → planner 照旧拒绝并说人话）；
  SYSCLK 上限三级回退 **MCU xml `<Frequency>` → db `SYSCLKFreq_VALUE` Max → apb2Hz**（G4/U0 的 `<Frequency>` 读出来是 0，不回退会误用 apb2）。
- `PLL_VCO_LIMITS[family] ?? facts.vco` 同理，`clock-pllmn.ts` 不再按族名查表。

逐族真值（**按具体型号读**，`assets/chips[0]` 常是入门型号：F1→F100 24 MHz、F4→84 MHz，会给出错的族结论）：

| 族 | 型号 | 模型 | SYSCLK | APB1 | APB2 | VCO 输出 | VCO 输入 |
|---|---|---|---|---|---|---|---|
| F2 | STM32F205R(B-C-E-F-G)Tx | pllmn | 120M | 30M | 60M | 192–432M | 1–2M |
| F3 | STM32F303C(B-C)Tx | pllmul | 72M | 36M | 72M | — | — |
| G0 | STM32G030C(6-8)Tx | pllmn | 64M | 64M | 64M | 96–344M | 2.66–16M |
| L1 | STM32L100C6Ux | pllmul | 32M | 32M | 32M | — | — |
| U0 | STM32U031C6Tx | pllmn | 56M（回退） | 64M | 64M | 96–344M | 2.66–16M |

五族 `adcDivs` 全空 → ADC 上限对它们不生效（planner 只在 `adcDivs` 非空时才写 `RCC.ADCPresc`/`RCC.ADCFreqValue`）。
F407 42/84、F722 54/108、G431 170/170、L476 80/80 与旧手写表一致；F072 的 db 给 ADC 48M 但 override 表 14M 胜出 —— 所以 override 优先、db 兜底这条顺序不能反。

### 72.2 一个错枚举让 CubeMX 死循环（F2 卡死的真因）

F2 跑时钟验收时 `config load` 之后 >240 s 不返回，日志固定停在 `PinOutPanel:1589 - setPackage(STM32F205RBTx,LQFP64)`。
二分（每一组都是 `config load`+`config save` 的完整往返，超时 240 s）定位到**单个键**：

| 组 | 内容 | 结果 |
|---|---|---|
| baseline | 未经时钟计划的 .ioc | 98 s，exit 0，saved（3399 B） |
| PLL | PLLM/PLLN/PLLP/SYSCLKSource | 118 s，OK，CubeMX 自己补全派生键 |
| PLL + 分频 | 再加 AHBCLKDivider/APB1CLKDivider/APB2CLKDivider | >150 s 不返回 |
| PLL + `AHBCLKDivider=RCC_SYSCLK_DIV1` | 只换这一个值 | 跑到 `End SaveConfig()`（保存完成） |
| PLL + `AHBCLKDivider=RCC_HCLK_DIV1` | 错值 | 240 s 内根本没保存 |

db 对照（`RCC-STM32F217-rcc_v1_0_Modes.xml`）：`:441` `AHBCLKDivider` 的取值是 **`RCC_SYSCLK_DIV1/2/4/8/16/64/128/256/512`**，
`:452`/`:463` 的 `APB1CLKDivider`/`APB2CLKDivider` 才是 `RCC_HCLK_DIV1/2/4/8/16`。全库统计：`AHBCLKDivider` 默认 `RCC_SYSCLK_DIV1` 的 51 个文件，
`RCC_HCLK_DIV1` 的只有 3 个（C0 系）。原码把 APB 的枚举值写进 AHB 键 → **CubeMX 拿到非法枚举不报错、直接死循环**。
F4/F7/G4/L4 一直是同一个错值，只是它们没死循环、verify 又把这些当「值被改写」报了 benign=false 才被掩盖。

修法：`ClockDbFacts.ahbDivs`（`enumOf(text, "AHBCLKDivider")`）、`ClockFacts.ahbDivs?`，`clock-pllmn.ts` 里
`const divValueOf = (divs, div, fallback) => divFact(divs, div)?.iocValue ?? fallback(div)`，**查不到就不写这个键**（缺省就是 ÷1）。

同批还修了一个一直没被触发的错：APB2 分频写死 `?? 1`。F2 是 120 MHz SYSCLK / 60 MHz APB2，写死 ÷1 会把 APB2 顶到 120 MHz 超规格；
F4/F7/G4/L4 的 SYSCLK 上限恰等于 APB2 上限，所以从没暴露。现在是 `minimalDiv(facts.apbDivs, best.sysclkHz, facts.limits.apb2Hz).div`。

**方法论教训 1**：CubeMX 无头 `config save` 有时「保存完但不退出」（上表第 4 行就是），所以成功判据只能看日志里的 `SaveConfig`/`Bye bye`，不能只看退出码。
**方法论教训 2**：单键隔离实验如果超时给太短（120 s）会把「机器本来就慢」记成「这个键有毒」，整体结论会反 —— 一次 load+save 实测 98–120 s。

### 72.3 F303 的 SYSCLK 源叫 SYSCLKSourceVirtual

db 全库只有 `RCC-STM32F303_rcc_v1_0/_F303E/WBA/WBA6` 同时有 `SYSCLKSource` 与 `SYSCLKSourceVirtual`；
F303 里 `:258` `SYSCLKSourceVirtual` 才是可选列表（PossibleValue HSI/HSE/PLLCLK），`:269` 的 `SYSCLKSource` 是 `DefaultValue="+SYSCLKSourceVirtualString"` 的派生项。
写 `RCC.SYSCLKSource` 会被静默丢掉（F3 首轮 verify 的 `missingKeys` 正是它），靠 PLL 键让 CubeMX 反推只是运气。

现在 `ClockDbFacts.sysclkSourceKey`＝db 文本里含 `Name="SYSCLKSourceVirtual"` 就是 `RCC.SYSCLKSourceVirtual`，否则 `RCC.SYSCLKSource`，
pllmul 与 pllmn 两条路径都按它写。

### 72.4 ioc_verify：把「CubeMX 自己重算的派生频率」从实质差异里摘出来

以前每次改时钟，`valueChanged` 里都塞满 `RCC.AHBFreq_Value`/`CortexFreq_Value`/`I2SClocksFreq_Value`/`VCOI2SOutputFreq_Value` 这类**时钟树输出**，
真正的差异（比如某个键被丢）反而看不见。现在：

- `isDerivedClockKey(key)`：键形如 `^RCC\.[A-Za-z0-9_]+$` 且成员名以 `Freq_Value`/`FreqValue`/`VcooutputI2S` 结尾。
  `SYSCLKFreq_VALUE` 故意**不算**派生 —— 那是我们写的设定，被改必须报。
- 归因新增三个字段：`derivedRecomputed`（CubeMX 重算的派生键）、`derivedAdded`（它自己补的派生键）、
  `ipParametersAdded`（`RCC.IPParameters` 里它自己追加的名字；判据是 after ⊇ before 且多出来的全是派生名，**顺序不参与判定**，因为它会整体重排）。
- 计划里写过的派生键仍然留在 `valueChanged`（算我们算错）—— 靠 `<projectDir>/.dsh-stm32/plans/*.json` 里 createdAt 最新那份的 `changes[].key` 判断。
- `benign` 的语义随之变成「只重排／只规范化／只自动补清单／只重算派生频率」。
- 顺带放宽 `functionlistsort` 纯追加的正则：U0 会追加 `0-MX_CORTEX_M0+_Init-CORTEX_M0+-false-HAL-true`，旧正则的 `[A-Za-z0-9_]+` 认不出 `+`。

**没有保存就必须判失败**：超时时 `runStreaming` 不抛错，快照还是原样的 .ioc，逐键比出来是「零 diff」—— 这是假通过。
现在先看 `/SaveConfig|Bye bye/` 是否出现：没出现直接 `ok: false` 并说明；保存了但进程没正常退出则照常出结论、在 `notes` 里交代。
文档里的耗时也改成实测值（单次 load+save 98–120 s，默认超时 180 s）。

### 72.5 G0/U0 模板与「资产缓存才生效」

- G0：模板只有 `Mcu.IP0=NVIC / IP1=RCC`，CubeMX 保存时自己补 `SYS` → `Mcu.IPNb` 2→3 成了唯一差异。模板补 `Mcu.IP2=SYS`、`IPNb=3`。
- U0：模板用逻辑脚名 `PA13`/`PA14`，而该族 db 的脚名是 `PA13 (SWDIO)`/`PA14 (SWCLK)`；信号是 `DEBUG_JTMS-SWDIO`/`DEBUG_JTCK-SWCLK`，
  还要一个 `DEBUG` 实例。模板改成 `Mcu.Pin0=PA13 (SWDIO)` + 转义键 `PA13\ (SWDIO).Mode=Serial_Wire`、`IP0=CORTEX_M0+ / IP1=DEBUG / IP2=NVIC / IP3=RCC / IPNb=4`。
- **改了资源仓的模板不等于插件会用**：插件读的是已安装缓存 `~/.dsh-stm32/assets/<version>/ioc/family/*.ioc`。
  验收前要把模板同步进缓存并按 sha256 更新缓存里的 `manifest.json`，否则复跑的仍然是旧模板（G0/U0 第一次复跑就是这样白跑一轮）。

### 72.6 pllmul 文案里写死的「F1 的」

F0/G0/L0/L1/F3 共用同一个 `finish()`，不可达文案原来整句写死「F1 的 PLL 只能整数倍频」。
现在按 `facts.muls` 的 min/max 说，并补上真正的备选源：HSE 也进候选（`readHseHz`，.ioc 里没 `RCC_OSC_IN` 时明说「要板上真接着晶振」），
USB 警告分两种（`requiresPllClkHz > 0` 才说「只在 PLLCLK=<多> 时拿得到」，否则说「这一族的 USB 时钟来源还没建模」）。

### 72.7 五族时钟验收（create → clock → apply → ioc_verify → generate → build）

```text
F2  STM32F205RBT6  HSE ÷20 ×192 ÷2 → 120 MHz (VCO 240M)  benign=true  872,828 B  0 warning
F3  STM32F303CBT6  HSI÷2 4M ×16     →  64 MHz（72 不可达） benign=true  850,344 B  0 warning
G0  STM32G030C6T6  HSE ÷1 ×16 ÷2    →  64 MHz (VCO 128M)  benign=true  615,828 B  0 warning
L1  STM32L100C6U6  HSI ×4           →  32 MHz              benign=true  597,460 B  0 warning
U0  STM32U031C6T6  HSE ÷1 ×28 ÷2    →  56 MHz (VCO 112M)  benign=true  762,820 B  0 warning
```

单测 `node test/run-units.mjs` → **783 pass / 0 fail**；`node scripts/pack-size.mjs` → 602.9 KB（上限 1171.9 KB）、解包 1902.0 KB、护栏通过。

### 72.8 遗留

- F3 的 72 MHz 在只有 HSI 时不可达（HSI÷2 4 MHz ×16 = 64 MHz）。要么模板加 `RCC_OSC_IN`（前提是板上有 8 MHz 晶振），要么接受 64 MHz；
  现在只把 HSE ×9 这条路写在 note 里。
- 派生频率的公式在 CubeMX 的 jar 里，插件只认「派生键被重算」这个事实，不复算数值 —— 所以 `derivedRecomputed` 里的值不参与 benign 判定，也不校验。
- 双核/TrustZone 族（H5/U5/WB 的双核）没验，pllmn 的 VCO 区间与 APB 上限对它们可能是另一套键（`APB3Freq_Value` 之类）。

## 73. 固件包官网直取通道：先问 CubeMX，再回退 GitHub（2026-11-05）

到 72 为止，缺固件包只有一条路：从 GitHub 拉 HAL + CMSIS 两个源码包自己拼一个 `STM32Cube_FW_<族>_V<版本>`，装进 `<CubeMX 根>/dsh-firmware`，生成时用 `setCustomFWPath` 指过去。这条路能用，但它有两个天花板：一是我们拼出来的包 `package.xml` 是自写的，CubeMX 的包管理器不认（列不出来、也删不掉）；二是版本号必须我们自己维护，官方发了新版得改代码。

所以加了第二条通道：**按 db 的 FwLibrary 拼官方 zip 的 URL，下载校验后交给 CubeMX 自己的 `swmgr install`**，让 CubeMX 把包装进 `Repository` 并记账。`stm32_firmware_install` 默认 `source: "auto"`：先试官网，失败（没有 CubeMX、跑着 GUI、下载/校验/许可协议任一步不过）就把原因写进 `notes` 回退 GitHub 拼包；`source: "official"` 时不回退，直接报失败。

### 拼 URL：FwLibrary 只在少数族上

先取证：`db/mcu/*.xml` 里只有一小部分 `<Mcu>` 带 `FwLibrary` 属性，`families.xml` 里根本没有这个字段（探针 `demo/.dsh-stm32/probe-fwlib.mjs` 统计了全量 2019 个 xml）。有值的是 STM32H7 的 H7RS 行（`STM32Cube_FW_H7RS`）、STM32MP1 的 MP13 行、WB0、WL3；其余族为空串。所以规则是：

- `resolveFwLibrary(dbRoot, partNumber, fallback)`：按 db 文件名（RefName 簇写法，如 `STM32F103C(8-B)Tx`、`STM32H7R3A8Ix`）转成正则去匹配用户给的型号，命中且带 `FwLibrary` 就用它；否则退回落包名 `STM32Cube_FW_<族>`。
- URL 规律（实测 HEAD 全部 200）：`https://sw-center.st.com/packs/resource/firmware/stm32cube_fw_<库名后缀小写>_v<版本去点>.zip`，例 `stm32cube_fw_f1_v187.zip`（56,220,914 B）、`stm32cube_fw_wba_v170.zip`（388,603,994 B）。不存在的版本返回 404 + 一个 XML 错误页，所以必须判状态码，不能只看有没有字节。
- `DSH_STM32_FIRMWARE_BASE` 可把基址换掉（内网镜像/离线测试用）。

### 校验：Content-Length + 逐条 CRC32

官方 zip 几十到几百 MB，下了一半就交给 CubeMX 会把包管理器搞坏，所以两道闸：

- 下载时比 `Content-Length`，对不上就删掉半截文件并判失败；`downloadOfficialZip` 默认 600 s 超时，走 `AbortController`。
- 下完扫一遍 zip：读 EOCD → 中央目录 → 逐条 `inflateRawSync` 算 CRC32 比对（method 0/8，其它方法跳过）。`crc32Of` 是查表法自实现的，因为 `package.json` 写着 `node >= 20`，而 `zlib.crc32` 要到 20.15 才回移、22 才稳定。实测 WL3 1.2.0 那个 32,172,685 B 的包：6,166 条条目全部对上，用时 11 s。

### 装：swmgr 只认本地 zip，且第一次装新族会弹 GUI

CubeMX 无头命令行里 `swmgr` 子命令有 `refresh` / `connection` / `install <包名|本地zip> <deny|ask>` / `remove`。实测：

- 传家族包名（`STM32Cube_FW_H5_V1.5.1`）一律 KO：`MainUpdater:1578 Unknown pack`——`cubemx.pidx` 里只有 62 条 X-CUBE 条目，没有固件包。只有**本地 zip 的绝对路径**可行。
- 许可协议是**按族×版本**记的（日志里 `Accepted Firmware Licenses: FW.C0.1.3.0,FW.C0.1.4.0,FW.F4.1.28.0`）。首次装某个族的新版本时，`ask` 会弹 GUI 对话框等人点同意——无头调用会一直挂着。这是这条通道唯一的硬限制：插件不代点、只超时回退，并在 `notes` 里写明「许可见 CubeMX 弹窗」。
- 对已经装着的包，`swmgr` 常常直接打 `KO` 就退出（实测日志尾 `…End of Local Load Thread | KO | exit | Bye bye`），但包本身是好的。所以判据不看日志文本，看 `Repository/<包名>` 里有没有 `package.xml` / `Drivers` / `Utilities/pc_software`；`reused` 在起进程**之前**取，用来区分「本来就有」和「这次装上的」——跑完再取会把两者混为一谈（第一版就是这么错的，单测当场抓住）。

### 验收

- `test/firmware-units.test.mjs` 42 pass：URL 拼法（含 base 覆盖）、RefName 正则、FwLibrary 解析与回落、CRC 标准向量与续算、好包/坏包（改一个字节要精确指到 `Drivers/CMSIS/Include/core_cm4.h`）、Content-Length 不符删文件、404、`source: "official"` 没给 CubeMX 时明确失败且零网络、`auto` 回退 GitHub 且 `notes` 留原因、swmgr 成功/失败/预存包三条。
- 全量：`npx tsc --noEmit` 0；`node test/run-units.mjs` TOTAL pass=830；`node scripts/pack-size.mjs` 631.6 KB（上限 1171.9 KB）。
- 真机证据：`probe-official-real.mjs` 真下 WL3 包并校验通过；`probe-swmgr-real.mjs` 真起 CubeMX 跑 `swmgr install`（65 s），`Repository\STM32Cube_FW_WL3_V1.2.0` 在，`reused=true`。
- 没验到的：首次装**未装过**的族时 EULA 弹窗的超时回退——那一步需要真人去 CubeMX 窗口点同意，本机做不到，代码里按超时+回退处理，逻辑由单测覆盖。

### 顺带

`project_create` 缺固件包时的拒绝文案（`src/engine/scaffold.ts`）改成指到 `stm32_firmware_install`：传 `mcu`，真装要 `dryRun: false` + `confirm: true`，先官网后 GitHub。

## 74. facts 获取自动化：SVD 本地→缓存→联网，RM 按线分级拒收套用（2026-11-07）
上一节做完事实层，留下两个洞：facts 靠人手喂 SVD 路径与 rm-facts，换机器就断；更要命的是自动化本身有风险——CLI 一顺，「把 C011/C031 的 RM0490 语义喂给 C051」这种错用会静默通过 flash 门禁（semantics>0 就放行）。这一节把获取做成链路，同时把分级门禁补上。

### 上游取证（全部实测，零手搓）

- SVD 源：本机 `D:/JingYu/STM32/cmsis-svd-stm32` 的 origin 就是 `github.com/modm-io/cmsis-svd-stm32`；GitHub API 实测 default_branch=main、261★、未归档、pushed_at=2026-07-09。contents API 实测布局 `<族小写>/<线>.svd`（stm32c0 6 份、stm32f1 5 份、stm32l4 16 份、stm32h5 10 份，命名同规则），候选顺序沿用 cmsis-sources 的老结论：fastly jsDelivr → cdn jsDelivr → raw.githubusercontent → ghproxy（前两条 200 实测）。
- **SVD 不锁 sha256**：同名文件本机快照与 main 已漂移（STM32C031.svd 本地 2,332,557 B / 远端 2,281,605 B，哈希不同）。锁哈希=每次上游 "Update STM32 SVD files" 就全线报错；改锁形状——`minBytes` + markers `<device`/`<cpu>`（真 SVD 必带），实际取到内容算 sha256 **记进 sources**（可追溯、不拦人）。这跟 CMSIS 下载缓存逐文件钉哈希的口径相反，是有意的：那边钉的是版本，这边上游本来就漂。
- RM 源：`https://www.st.com/resource/en/reference_manual/rm0490-<全标题小写>.pdf` 实测 200（11,536,384 B，application/pdf），短 slug `rm0490.pdf` 404，`rm0490.html` 产品页也 404。slug 含整篇标题，只能人从官网复制——所以插件**不建「RM 号→URL」表**（那就是又一张某版事实的快照），RM 通道只留 `--rm-pdf`（本机文件，含中文 PDF）与 `--rm-url`（人给的直链，下载按 `%PDF` 头校验后缓存到 `<facts>/rm/`）两个入口；`DSH_STM32_OFFLINE=1`/`--no-network` 时跳过并明说。
> **§75 更正（同日）**：「只能人从官网复制」被证伪——ST 官方 `sitemap1..10.xml` 匿名可取、直接列出全部 132 条英文 reference_manual 直链；RM 载体由此做成双通道自动（sitemap 主 + stmcu CCC 备案）。仍然不建静态表：清单每次现取，不焊进代码——本节对「不焊快照表」的坚持是对的，错在以为没有机器可读的动态源。

### 获取链路（src/engine/facts-acquire.ts）

`acquireSvd`：`--svd` 显式文件 → 每个 `--svd-root` 的 `<族>/<线>.svd` → `<facts>/svd/` 下载缓存 →（允许时）联网下到缓存。下载失败把**每个源的尝试**列出来；本地文件存在但解析不出 FLASH_OPTR/ACR/SECR 也明说「内容对不上」，不猜。缓存命中后二次调用零网络（离线复用，单测验证）。
`acquireRm`：rm-facts JSON（语义唯一来源）+ 载体登记；坏 JSON 记 error 不炸。
`buildFacts` 组装 schema 2：`sources` 带 origin（local/URL）、`rmDoc`、`rmAppliesTo`、`needs`。`facts.ts` 的 `readFactsFor` 优先读回 `pkg.needs`，缺省兜底文案也改成指路 `build-facts.mjs --part <型号>`。

### 按线分级：语义套用必须拒收

`facts-acquire` 的 `rmLines`（CLI `--rm-lines`）优先、rm-facts 的 `doc.lines` 兜底：声明过且不含目标线 → 语义**整批拒收**（0 条）、needs 写明「rm-facts 声明只覆盖 STM32C011/STM32C031，不含 STM32C051」。fixtures 与本机 rm-facts-c0.json 都补了 `doc.lines`。没声明 → 照常采信但在 notes 提醒「抽取的人要自己核对覆盖范围」——旧数据不能因为新校验突然全灭。真 CLI 验证：C051+同一份 rm-facts → 语义 0 条 + needs；C031 → 7 条正常。flash 门禁不用改：它只看 `verified`，而 verified 现在套不上假语义了。

### 验收与遗留

- `test/facts-units.test.mjs` 6 条黄金样本改 import 到 `lib/engine`（结构解析归引擎，CLI 只是壳）；新套 `test/facts-acquire-units.test.mjs` 11 条全注入假 fetch：候选表、本地命中、svdRoots 布局、离线缺内容、缓存复用、404 换源、坏 rm-facts、schema2 全链路、缺语义降级、**跨线拒收**、needs 指路。全量 `TOTAL pass=853 fail=0`、tsc 0、pack-size 642.3 KB 通过。真链路实测：本地根/联网下载/离线失败/降级/RM PDF 登记 5 条 CLI 路径各跑一遍（`demo/.dsh-stm32/facts-cli-test/`）。
- 一条单测翻车记录：「svdRoots 找不到就明说」先写成走默认缓存，而先前 CLI 实测已把 C051 下进默认缓存 → 命中成功、断言炸。测试前提被真实副作用污染，修法是给用例独立空 `cacheDir`（离线复用本来就是另一条用例）。
- 遗留：RM 语义仍是人工 rm-facts，PDF→语义自动解析 = 第 5 步（黄金样本扩到 RM 抽取）；~~C051/C071/C091/C092 的 RM 与 rm-facts 待补（第 3 步）~~（§75 取证：现行 EN RM0490 六线全覆盖，不存在「各自的 RM」）；`facts` 还没接进 generate/project-create（第 4 步）。

## 75. RM 载体双通道：sitemap 主源 + stmcu 备案，覆盖验证替代人核（2026-11-07）

§74 把 SVD 获取自动化之后，RM 一直是人喂。这轮把 RM 载体也做成自动，并且回答了一个更根本的问题：**C051/C071/C091/C092「各自的 RM」根本不存在**——EN RM0490 现行版标题就是 stm32c0-series，正文 Table 3..6 是逐线边界地址表，六线全覆盖（pdfCoverageIndex 实测六线线名全命中）。交接文档说「只覆盖 C0x1」来自中文 Rev 1，那是旧版；§4 的按线分级结论仍然对（老版本确实窄），但事实要按版本重新取证。

### 通道取证（全部匿名实测，先证伪再选路）

- **semiee.com 出局**：真实接口 bdxx-api/chip/v5/rich/search 匿名回 code:1「请登录」，浏览器里也一样（弹窗要登录）。
- **立创（用户指定试的站）：分类页可解析、token 端点不可用**。overseas.szlcsc.com 的聚合搜索匿名可用但代理来的 PDF 是**商品 datasheet 不是 RM**（mm.digikey.com 那条 2,585,296 B 实测是 DS14721 Datasheet，BOOT_LOCK/OPTKEY/Option bytes 全文 0 命中）；stmcu 自己的 design_resource_download token 端点冷静后单发 303 跳 SSO。**但详情页内联 JS 明文暴露 ST 中国官网 CCC 直链**（is_outside_file 分支的 window.open），那条匿名 200、15,851,579 B、与本地中文 RM0490 逐字节同哈希——立创的价值成了「备案 URL 提供者」。
- **主源：ST 官方 sitemap**。www.st.com/content/st_com/sitemap1..10.xml 匿名 200，37,647 条里 132 条英文 reference_manual 直链；不建「号→URL」表，清单每次现取。
- **产品页/搜索页/文档导出全试过**：产品页静态只有 datasheet、搜索页浏览器里 HTTP2 协议错、search.st.com 只有 UI config、四个导出端点全 404。

### 匹配与验证（rm-sources.ts）

打分制（线名 100 / 线号首位 60 / 族级 series 40 / 族名 20）——单测钉住 rm0394(l41xxx) 必须赢过 rm0432(l4-series)；线号首位来自 ln.slice(fam.length)，slice(0,7) 恰好等于族名是个坑。stmcu 侧：按 RM 号筛、标题须含族名（分类页混入 RM0434 他族条目与 CubeMonitor 帖），zh→en 翻译替换（两版实测都匿名 200）；politeGet 3 s 节流 + 429 退避 8/16 s 至多重试 2 次（实测连打 3 次必 429）。

**覆盖验证只信英文 PDF**：Node 抽 content stream 字面量 → 压平（只留字母数字小写）→ 找 <线>xx。EN RM0490 六线全中；中文是 CID 编码字体，抽出来是空索引——判不出=不放行，方向保守不会假阳（假 zh fixture 钉住）。载体记录进 facts.sources：kind=rm-pdf + doc + sha256 + bytes + url + origin:auto:<通道> + coveredLines。

### 又修一个真 bug（间距判定写反）

TJ 数组的真实形状是 (a) -578 (b)：数字**前面**是右括号。旧实现判「数字后面是右括号」，大间距从未还原成空格（Wide 422 Ok 粘成 wideok）；kerning 小数 (a)-5(b) 后面正好是左括号…也不该插。修正：数字前必须是右括号、后接左括号或右方括号，|n|>=200 才插空格。fixture 同时钉住三件事：kerning 不粘、大间距插空格、坐标数不误判。

### 验收

tsc 0；TOTAL pass=863 fail=0（rm-sources-units 10 条全离线）；pack-size 648.6 KB。真链路：C051 auto → sitemap 下到真 EN RM0490（sha256 b5af48dc…，与手工 probe 逐字节一致）、coveredLines 六线全中、语义按 doc.lines 照旧拒收；off 降级正常；stmcu 专通道实测撞 429（退避加强后待再验，失败信息完整）。

### 遗留

R3 自动抽取 rm-facts（引文逐字回查 + 与本线 SVD 位域交叉两道机检替代人核）；R4 用 EN RM0490 重抽并把 doc.lines 放宽到六线；R5 facts 摘要接进 generate/project_create。run_code 的 execFile env 是空壳（APPDATA/USERPROFILE 未设），python user-site 探测必须补 env，否则 pymupdf 假阴性——本轮踩过后定位：pymupdf 2.1 装在 AppData/Roaming/Python/Python314/site-packages。

## 76. rm-facts 自动抽取：两道机检替代人核，C0 六线语义转正（2026-11-07）

§75 留的问题是「解析能不能免人核」。答案：能，但门禁必须换形状——人核防的是「结论写错」，机检防的是「结论没有语料支撑」。这轮落两道机检：**引文逐字回查**（每条语义带锚点，必须在其声称页码 ±3 的 pymupdf 文本里逐字出现，引文直接从命中页截取）+ **SVD 交叉**（语义引用的寄存器字段必须在本线 SVD 里存在且位偏移一致）。任一道不过整条拒收，原因打进输出，exit 1。

### 抽取器为什么用 pymupdf 而不是插件自研

引文必须来自被核验的那一份文本。Node 侧压平索引（§75）没有页边界与大小写，做不了 page±3 回查——它负责覆盖判定那一层就够。`extract-rm-facts.mjs` 调 pymupdf（`DSH_STM32_PYTHON` 可覆盖解释器），不可用就明确失败并指路，绝不降级到自研抽取凑数。归一化口径：折叠空白、匹配用小写副本、引文保留原大小写（ASCII 下两者等长，注释里写明了 Unicode 边界）。

### 机检当场抓到一条旧误记

§4 记的「自举配置在 SYSCLK 第 4 个上升沿锁存」在 EN RM0490 Rev 6 全文**不存在**——`4th` 只出现在 p.305 之后别的语境。RM 实文是 "The boot mode configuration is latched after a reset"（p.53）+ "BOOT0 pin sampling is done on NRST (external reset) rising edge"（p.54）。旧条目是凭旧版/别处知识写的，锚点回查把它拒了；新拆成 latch/nrst-sample 两条带逐字引文的条目。这条误记进了 §4 的教训扩展：**推断的代价不是「可能错」，是「看起来对并被下游当真」**。

### 采信口径升级：条目级 appliesTo 优先

自动抽取的每条 rm-facts 带 `appliesTo`（该条过了哪些线的 SVD 交叉），`buildFacts` 采信顺序 = 条目级 appliesTo → 包级 doc.lines/--rm-lines → 都没声明才整批放行（notes 提醒）。第一版只按条目级筛，把「doc.lines 不含目标线」的整批门禁架空了（回归测试当场抓住）；无 appliesTo 的老式条目现在仍受包级约束。C0 六线现全在 10 条条目的 appliesTo 里，六线 facts `verified=true`——flash 只读门禁对 C0 全系放行，且这些语义每一条都能溯源到页码+引文。

### 验收

- tsc 0；TOTAL **pass=875 fail=0**（新套 rm-extract-units 11 条：正样本/改一字即拒/旧误记拒收/表格篡改拒收/位偏移剔除/页窗口就近/多锚点防巧合/并集组装/口径/空锚点拒/缺 SVD 不放行；facts-acquire 加了包级门禁与条目级优先两条）；pack-size 651.6 KB。
- 真语料三连：EN RM0490 全 10 主题采信、六线全适用；**伪造测试**（改锚点/改表格行/改位偏移）三条全按预期拒收、exit 1；`node --test` 前后一致。
- 端到端：六线逐条 build-facts 落默认 facts 根，readFactsFor 六线 verified=true semantics=10。
- fixtures/rm-facts-c0.json 换成自动抽取版（旧版留 `.bak-2026-11-07` 同目录）；黄金样本断言改钉新形状（表 9 七行/六线/引文回查/误记清除）。

### 遗留

- spec（rm-topics-c0.json）里的锚点仍是人挑的——这是「人只负责提出可证伪的候选，机器负责证据」的分工，不是全自动；扩族时每族要一份 spec。
- R5：facts 摘要接进 generate/project_create。
- flash 工具的真机放行验证需要接板，留到用户下次上机。

## 77. facts 摘要接进 generate / project_create：生成前就摆出烧录门禁三态（2026-11-07）

R5 收尾。动机：facts 门禁长在 `stm32_flash` 上，但用户往往先跑 `stm32_project_create` / `stm32_generate`（CubeMX 一趟 3–4 分钟），烧板时才发现被只读门禁拦——风险应该出现在**开始长任务之前**，不是任务链末端。`generationRiskNotes(part)`（facts.ts）给一行式三态，与 describeFacts（doctor/flash 的多行详单）分开口径：前者回答「烧录会不会被拦、缺什么、怎么补」，后者给逐条证据。

- **未生成** → 指路 `build-facts.mjs --part <型号>`。**话术踩了一次口径错**：初版写「不补的话 stm32_flash 会拒烧」——错，flash 门禁只在 `found && !verified` 拦，完全没 facts 的族只提示（§7 已知限制）。活体验证（离线驱动真工具 execute）时撞出来，改成「不补也能烧，但启动/调试结论没有 RM 依据可查」。这种「两个工具各说各话」的分歧正是接线测试的价值：单测只测纯函数的话，两口径打架要跑真工具链才暴露。
- **只有结构** → 「stm32_flash 默认拒烧（allowUnknownFacts=true 可强制）」+ needs 首条并进同一行。
- **已核实** → 「已核实 N 条语义 → 不会被只读门禁拦；逐条见 stm32_doctor」。

接入点：generate 前台 report.notes、后台 job handle.append（开工横幅里）、**门禁 block 分支也带**（用户接下来去装 CubeMX，重跑前就该一并看到 facts 状态——第一版漏了 blocked 分支，同样是活体撞出来的）；project-create 两条路线都进 warnings（register 用决议后的 report.mcu、hal 用 scaffold.mcu ?? args.mcu，ok=false 时不打扰）。型号来源 generate 侧是 `mcuFromIoc(projectDir)`，工程没 .ioc 就返回空数组不硬凑。

验收：tsc 0；TOTAL **pass=880 fail=0**（新套 generation-risk-units 5 条 + 话术回归）；pack-size 652.6 KB。活体三场景全过：F103 register → 未生成行；C051 HAL（默认 facts 根，六线 verified）→ 已核实行；generate blocked（离线 spawn）→ notes 带未生成行。至此 §5 的 1/2/3/5 与 R5 全部闭环，facts 链路端到端：SVD/载体自动获取 → 覆盖验证 → 双机检抽取 → 门禁采信 → 工具面暴露。

## 78. 资产自愈 + 芯片级 spec 门禁：各族自动写书，只有踩过坑的才拦（2026-11-07）

用户四条决定合成这一版：① 各族一律自动准备资产、无需人为干预；② RM 载体先下载、暴露本地路径，调试遇怪行为可 pdf_scan/pdf_read_page 反查原文；③ 只有踩过坑的族/芯片需要机检背书，其余直接烧；④ spec 允许用户踩坑后自行生成，**按芯片不按族**（我不可能把坑全部踩一遍）。

### 三态门禁取代「found && !verified 就拦」

`FactsSummary` 加两个维度：`hasSpec`（`src/data/rm-topics.ts`：插件族级 `lib/data/rm-topics/<族>.json` + 用户芯片级 `<facts>/topics/<族>/<线>.json` 两层合并、同 id 用户赢）与 `rmPath`（已缓存 RM 的本机路径）。flash 门禁改成 `hasSpec && !verified` 才拒烧（`allowUnknownFacts` 保留）。上一轮担心的「自愈接上 F1 反被拦」没有发生：旧的「族没 facts 只提示」被「芯片没 spec 只提示」等价替换，判据还更准了——坑本来就是芯片级的（C071 的小写 nBOOT_SEL 与 C031 的大写 NBOOT_SEL 是两个故事）。用户放一份芯片级 spec（几条锚点 + 页码的 JSON），这颗芯片下次烧录前就必须过机检；没放过的其它芯片不受影响。

### ensureFacts 自愈与两个真 bug（一个活体一个单测）

`ensureFacts(part)`（facts-acquire.ts）：查无书或「有清单没核过」→ 当场 `buildFacts`（SVD→RM 载体→结构→有 spec 就连语义双机检抽取），再读回；已 verified 不重跑。flash（150 s 护栏）/generate（180 s）/project-create 两条路线全接；`generationRiskNotes` 按三态重写，口径一致性测试钉死「hasSpec=true 必含拒烧、false 必不含」。
- **bug①（活体抓到，最有价值）**：`parseSvdStructure` 写死 `FLASH_ACR/OPTR/SECR` 名字清单——那是 C0 命名约定。F103 真 SVD 的寄存器名是 `ACR/OBR/WRPR/KEYR…`，解析出 0 寄存器、自愈整条炸掉。改成两级：首选 `<peripheral> name==FLASH` 下的**全部**寄存器，退回名单过滤（单测微型夹具无 peripheral 包装，靠它兜底）。改完 F103 真链路自愈通过：8 个真实寄存器入 facts、载体 RM0008 经 sitemap 到位、风险行「只有结构、没有主题清单：不拦烧录，直接烧即可；RM 载体：本地 …rm0008.pdf」。**「名字清单」就是又一种手搓快照**——铁律 1 以新形态复发过一次。
- **bug②（单测抓到）**：自动通道的 rm-pdf source 只写 `file`（basename）没写 `path`，`rmPath` 反查入口永远空。补字段并钉进 ensure-facts 测试。
- 内置 C0 spec 从仓外搬进 `src/data/rm-topics/stm32c0.json`（随包发布；新 `scripts/copy-data.mjs` 复制进 lib，并入 build 链——tsc 不搬 JSON，npm files 只带 lib）。曾有「开发态退回 src」的兜底路径，在真实安装位置永不存在、只会把「没跑 copy-data」伪装成「清单在但读不到」——删掉，rm-topics 测试当场先抓住了它。
- spec 抽取认双载体来源：自动通道下的与显式 `--rm-pdf` 给的（用户本地手册场景从此免 CLI）。

### 验收

- tsc 0；TOTAL **pass=890 fail=0**（新 rm-topics-units 4 + ensure-facts-units 4 + generation-risk 重写为 7 条三态）；pack-size 659.9 KB。
- 真链路（干净 facts 根）：C071 → 自愈全程无人、verified、10 条语义、rmPath 指本地 RM0490；F103 → 结构 8 寄存器 + 载体 RM0008 路径暴露、不拦烧。中途一次 rmPath 空是 sitemap 网络抖动，降级文案正确、重跑恢复——自愈的失败形态就是「如实说没拿到」，不是「假装不需要」。
- 待用户：重启 dsh 后真机烧 C051（预期直接过）与 F103（预期只提示）；给常用的别的芯片放芯片级 spec 试一轮拒烧→修 spec→放行闭环。

## 79. 烧录探针分两路：实见 ST-LINK 就换 interface，openocd 认不出再走 CubeProgrammer（2026-11-07）

用户拿 C031F6P6 + ST-Link 实测，openocd 报 `Error: unable to find a matching CMSIS-DAP device`，给了七条复盘。逐条按证据核，落成三条结论：**探针类型没分流**（真问题）、**没有第二后端**（真问题）、**「非 F1 没有烧录后端」不成立**（那次是手写 openocd.cfg 覆盖了插件自带的 target 脚本）。

### 取证：三处硬编码与一条被覆盖的自带配置

- `doctor` 把任何认不出的探针都写成「CMSIS-DAP」：它只看 pnputil 里有没有 USB 设备，没解析 VID:PID。`flash` 的兜底 interface 是字面量 `interface/cmsis-dap.cfg`。debug / regs / debug-session 三处各自也各写了一遍同样的字面量——**四处快照，改一处不管用**。
- 本机 openocd 0.12：`interface/stlink.cfg` 存在且 `hla_vid_pid` 已含 3752（ST-Link/V3）；`interface/cmsis-dap.cfg` 不锁 VID，所以接上 ST-Link 时它会去枚举 DAP 并失败——报错文案正是 "unable to find a matching CMSIS-DAP device"。这不是「探针没插」，是「interface 选错了」，两类错误必须分开。
- `templates/openocd/stm32c0x.cfg` 一直是内置的（0.13→0.12 适配版：`-tap` 改 `-chain-position`、CPUTAPID `0x0bc11477`、stm32l4x flash bank），`chooseOpenocdTarget` 按族取它。用户工程里那份手写的 `openocd.cfg` 优先级更高，把它盖掉了——于是「C0 没有烧录后端」的观感成立，事实不成立。**自带模板存在 ≠ 用户没覆盖它**，两条都要在结论里分开说。
- CubeProgrammer v2.19.0（`D:/app/STMicroelectronics/STM32Cube/STM32CubeProgrammer/bin/STM32_Programmer_CLI.exe`）：从 exe/dll 的 UTF-16 字符串表里取出真实消息串（`Data downloaded successfully` / `Download verified successfully` / `Download verification failed` / `No ST-Link detected!`），当前没插探针时 `-l` 正好报最后一条。它的退出码不参与成败判定——按日志串判。

### 实现：一个公共入口 + 两段兜底

- `parseProbeVidPid(text)`（doctor.ts）：从 pnputil 输出抓 `USB\VID_xxxx&PID_yyyy`，ST-LINK 认 3744/3748/374b/374d/374e/374f/3752/3753/3754，`0d28`→CMSIS-DAP，`c251`→DAPLink，`1a86`→CH340 串口桥（历史契约：串口桥仍算 ok，但 detail 改成「只供电/BOOT0」话术，不再冒充调试探针）。
- `preferredInterfaceConfig(probes)` 给出 cfg 与理由；`liveProbeChoice(subprocess, signal?, force?)` 是 flash / debug / regs / 会话四处的**唯一**兜底入口，60 s 进程内缓存——一次烧录里「探测→换接口重试→CLI 兜底」最多问一次 pnputil（0.5–2 s），不拿它拖慢每个工具。
- `probe-error.ts` 新增 `probe-interface-mismatch`（`unable to find a matching (cmsis-dap|stlink|st-link) device`），**排在 no-probe 之前**：先判「选错 interface」，再判「没探针」。no-probe 收窄成 `no device found` / `open failed`。9 类。
- `flash.ts` 拆成 `runOpenocdFlash`（原逻辑，多一个 interface 覆盖参数）+ `runFlash` 编排：实见探针选 interface（工程自带 openocd.cfg 则不插手，notes 写明「以它为准」）→ 失败且是 interface 不匹配、又没手写 cfg 时**换另一个 interface 重试一次** → 仍失败、错误不属无解类（swd-locked / no-power / flash-protected / probe-busy）、实见 ST-LINK、CLI 在，则 CubeProgrammer 兜底。DAPLink 全败时 notes 明说「CLI 只认 ST-LINK」，不假装还有一条腿。
- `cube-programmer.ts`（新）：`findCubeProgrammerCli` / `buildCubeProgrammerArgs`（`-c port=SWD[ freq=] -d <elf> -v -rst`）/ `parseCubeProgrammerLog` / `runCubeProgrammerFlash` / `cubeProgrammerBackendNote`。search-roots 加 `cubePrgBins` 发现链（默认装法 + `STM32_CUBE_PRG_ROOT`，认安装根也认 bin），probe 清单加非必需条目 `cubeprogrammer`。

### 教训

- **字面量 interface 是第三种「手搓快照」**：前两次是寄存器名清单和 RM 主题清单，这次是 `"interface/cmsis-dap.cfg"` 被复制到四个文件。凡「同一个事实在多处重复写」的地方，迟早有一处没跟上。
- **错误归类决定能否自愈**：把「interface 选错」混进「没有探针」，编排层就永远不知道该换一条路试。新增一个 kind 的成本远低于让用户去猜。
- **兜底要有明确的准入条件**（实见 ST-LINK + CLI 在 + 错误可解 + 窗口内），否则第二后端会把「探针没插」也拖成两倍耗时。
- **模块级缓存是最阴的一类隐藏状态**（CI 抓到）：第一版把「实见探针」在模块里缓存 60 s，本意是省掉重复 pnputil，结果同进程连烧两颗不同芯片时，第二颗拿到第一颗的结论，「换另一个 interface」这个取反还会因此算反、把重试引回同一个配置；`sawStLink` 一起被污染，DAPLink 用例凭空走了 CubeProgrammer。**决定行为的事实不能活在模块状态里**——一次工具调用内复用返回值就够，跨调用永远重新看。
- **测试跑的必须是这一版代码**：一轮报「898 pass」，其实 `tsc --noEmit` 不产出 `lib/`，套件 import 的仍是改动前的 lib，全绿是假的。`test/run-units.mjs` 现在比较 src/lib 最新 mtime，src 更新就喊「先 npm run build」。凡是「产物入库 + 测试读产物」的仓库，这条必须自动化。

### 验收

- tsc 0；TOTAL **pass=899 fail=0**（新 `flash-orchestrator-units` 8 条全注入假 subprocess：实见选 stlink / 自动换 interface 重试 / 手写 cfg 不重试 / CLI 兜底成功 / DAPLink 不派 CLI / swd-locked 不兜底 / 显式 interface 不探 USB / 连烧两颗不共享探针结论；probe-error 扩到 27 条）；pack-size 666.5 KB / 上限 1171.9 KB。CI（`1215fc6`）绿。
- 真机：`parseProbeVidPid` 吃真 pnputil 输出（84,848 B，GBK 乱码前缀不影响）认出 0483:3752；`diagnoseUsb` 输出「探针在线：ST-Link（VID:PID 0483:3752）；openocd 应用 interface/stlink.cfg」；probeAll 真机 found=true 自动发现 `STM32_Programmer_CLI.exe`。
- 待用户：插上 ST-Link 跑一次真烧（预期 notes 里能看到「实见 ST-Link → interface/stlink.cfg」），再故意把工程里的 openocd.cfg 留着验证「以它为准」那条分支。

## 80. 工具描述对齐实现：模型读的是 description，不是代码（2026-11-08）

§79 把烧录改成「实见探针选 interface → 换另一个重试 → CubeProgrammer 兜底」之后，`stm32_flash` 的 `description` 还留着上一版的话：「没有则回退 CMSIS-DAP + stm32f1x」。代码是对的，描述是错的，而**模型做决策时读的是描述**——它会以为插件仍然写死 CMSIS-DAP、以为没有第二后端，于是在用户接 ST-Link 报错时给出错误的归因。同类滞后还有三处：`doctor` 的「占着 CMSIS-DAP 探针」、skill 里的「本机验证板……CMSIS-DAP 探针」、以及参数说明 `allowUnknownFacts`（实际判据是「有 rm-topics 清单且没机检过」，不是「只有结构」）。

改动（纯文案，不动行为）：

- `stm32_flash` description 重写为完整链路：三道门禁（工具链 / Serial Wire / 芯片级 spec）→ 实见探针选 interface → 工程自带 `openocd.cfg` 以它为准 → 驱动不匹配自动换一次 → ST-Link + CLI 兜底 → 成功证据是 `Programming Finished` + `Verified OK`。
- 参数说明补上真实约束：`configFile` 给了且存在时「不按探针改 interface、不自动换 interface 重试」；`allowUnknownFacts` 改成本芯片有主题清单但机检没过时才生效；`adapterSpeed` 注明 openocd 与 CLI 兜底共用。
- `doctor` 描述改「占着探针（CMSIS-DAP / ST-Link）」，不再把探针当成 CMSIS-DAP 的同义词。
- skill（`src/skill/stm32-workflow.ts`）：验证板那句改成「CMSIS-DAP 与 ST-Link 都支持，按 USB 实见选 interface」；R6 补「型号不必手选、RTT/debug_session 会占探针先 stop、只有手写 `openocd.cfg` 才以它为准」。

### 教训

- **接口描述是契约的一部分**：参数 schema 与 description 是模型能看到的全部真相，它们比实现更容易腐坏，因为改实现时没人会去读一遍文案。功能改动涉及「行为变了」时，description 要和代码一起改，并在验收清单里单列一项。
- **用户能看到的两份文档也要一起改**：skill 是随插件下发的运行时文本，它对用户和模型同时生效，比 README 更容易被忘。

### 验收

- `npm run build` 0；TOTAL **pass=899 fail=0**；`pack-smoke` 全过；包体 667.6 KB / 上限 1171.9 KB。
- 只改文案与 skill 文本，无行为变更；`lib/` 随 src 重建后一并提交（CI 会校验两者同步）。

## 81. CubeProgrammer 升为 ST-Link 正式后端；新建工程自带 .vscode/launch.json（2026-11-08）

用户选了方案 B：把 CubeProgrammer 从「openocd 失败后的兜底」提升为 ST-Link 的**正式后端**（`backend: auto | openocd | cubeprogrammer`），并要求新建工程自动生成 `.vscode/launch.json`。顺手修掉 §79 遗留的第三处问题：内置 C0/U0 脚本在 0.12 上其实加载不了。

### 一、内置 C0/U0 脚本：上一版只适配了一半

§78 说「内置一份适配 0.12 的脚本」，实际只把 `-tap` 改成了 `-chain-position`，另两处 0.13 写法还在——用 ST-Link 实测第 11 行就报 `Debug adapter doesn't support 'swd' transport`（0.12 的 st-link 驱动只有 `hla_swd`/`dapdirect_swd`），去掉后第 39 行报 `invalid command name "swd"`。

改成三处真适配：`source [find target/swj-dp.tcl]` 替代 `transport select swd`；`swj_newdap ... -irlen 4 -ircapture 0x1 -irmask 0xf` 替代 `swd newdap`；`-chain-position` 保持不变。改后 cmsis-dap / stlink-dap / stlink(hla) 三种都能加载到「连探针」这一步，报错退化为 `open failed` / `unable to find a matching CMSIS-DAP device`（因为没插探针）。

顺带统一 ST-Link 的 interface：`preferredInterfaceConfig` 从 `interface/stlink.cfg`（hla）改成 `interface/stlink-dap.cfg`（dapdirect）——新族 target 脚本走 swj-dp.tcl，hla 会撞 transport 不支持。所有断言与文案同步。

### 二、backend 三态

- `auto`（默认）：openocd 先烧 → 失败且不属无解类 → 实见 ST-Link 且装了 CLI 就兜底。
- `openocd`：只用 openocd，失败就报错（用户明确不要第二后端时不偷偷换工具）。
- `cubeprogrammer`：直接走 `STM32_Programmer_CLI`（`-c port=SWD -d elf -v -rst`），不依赖 openocd 的 target/flash 脚本——H5/WBA/WB0/WL3 这类上游连脚本和 flash 驱动都没有的族只能走它；实见 CMSIS-DAP/DAPLink 时直接拒绝（CLI 只认 ST-LINK），不白跑一趟。

实现：`FlashRequest.backend`；`prepareFlashTarget()` 抽出两条后端共用的「找 elf + SWD 守卫」；`runCubeProgrammerBackend()`；`cliFailureProbeError()` 把 CLI 日志归成 `no-probe`（No ST-Link detected）或 `target-mismatch`（Unable to connect）。auto 的兜底文案按「openocd 根本没起来（没有 target 脚本）」与「N 个配置都试过」分开；CLI 没装时明确说「装上它，ST-Link 就多一条不依赖 openocd 的后端」。工具层在 cubeprogrammer 后端下把工具链门禁降为 off（CLI 不需要 openocd）。

### 三、.vscode 自动生成：register 路线过去完全没有

HAL 路线一直有 `.vscode/{launch,settings,c_cpp_properties}.json`；register 路线不走 scaffold，所以建出来的工程**没有 launch.json**，用户在 VSCode 里按 F5 只能自己写。

- 新增 `scaffold.writeVscodeConfigs({targetDir, projectName, interfaceConfig?, binDirs?})`：与 HAL 同源（`templates/scaffold/vscode/`），填占位符、替换工程名，已存在的文件不覆盖只给 warning。
- `createRegisterProject` 建完后自动调用它（放在引擎而不是工具里：直接调引擎的调用方也拿到同样的工程），`templateFiles` 9 → 12。
- `openocd.cfg` 与 `launch.json` 的 interface 都按**实见探针**写：建工程时探一次（pnputil 0.5–2 s），实见 ST-Link 写 `interface/stlink-dap.cfg`，否则沿用 cmsis-dap。HAL 路线同样支持（`ScaffoldRequest.interfaceConfig`）。

### 教训

- **「适配旧版本」要按行验证，不是按注释**：上一版注释写着「适配 0.12」，实际只改了一处；结论一直在文档里，直到拿 ST-Link 真跑才暴露。凡「声称支持某版本」的地方，验收必须是「用那个版本跑一遍并贴输出」。
- **同一个事实两处写就会分叉**：interface 同时出现在 openocd.cfg 与 launch.json，register 路线的 openocd.cfg 由 `SHARED_TEMPLATE_FILES` 直接 `copyFileSync`——不加替换就会一半 stlink-dap 一半 cmsis-dap。

### 验收

- tsc 0；TOTAL **pass=907 fail=0**（新增 8 条：backend 直连/拒绝/不兜底 3 条、writeVscodeConfigs 3 条、register 路线 .vscode 与 interface 一致性 2 条；原有 register 文件数断言 9 → 12）。
- 引擎级真建工程：HAL（STM32F103C8T6，`cubeMxRoots=D:/app/STM32CubeMX`）与 register 都产出 `.vscode/launch.json`，`openocd.cfg` 与 `launch.json` 同时写 `interface/stlink-dap.cfg`。
- `pack-smoke` 全过；包体 670.3 KB / 上限 1171.9 KB（135 文件）。
- 待真机：C031F6P6 + ST-Link 分别跑 `backend: auto` 与 `backend: "cubeprogrammer"`；F5 用新工程的 launch.json 烧一次。

## 82. 三类探针都能用：J-Link 要外补 transport；launch.json 改指工程自带 openocd.cfg（2026-11-08）

用户要求（m00556 第 1 条）：ST-Link、DAPLink、J-Link 的用户都要能用插件。ST-Link（0483:37xx）与 DAPLink/CMSIS-DAP（0d28 / c251）此前已按 USB 实见分流，缺的是 J-Link。

### 一、J-Link：认 VID 之外，还必须显式选 SWD

- 识别：`doctor.ts` 新增 `SEGGER_VID = "1366"`，`parseProbeVidPid` 把 1366:xxxx 归为 `jlink`（J-Link 与 J-Trace 共用这个 VID）；`preferredInterfaceConfig` 返回 `interface/jlink.cfg`（排在 st-link 之后、cmsis-dap 之前）；`swdProbes` 过滤与 `diagnoseUsb` 的 no-dap 文案同步加 J-Link。
- **transport 是硬约束**：实测 openocd 0.12 的 `interface/jlink.cfg` 只有一行 `adapter driver jlink`，不选 transport；`openocd -f interface/jlink.cfg -f target/stm32f1x.cfg -c 'init; exit'` 打印 `Info : auto-selecting first available session transport "jtag"` 后报 `Error: No J-Link device found`——默认走 JTAG，SWD 目标连不上。加 `-c "transport select swd"` 且顺序为 interface → transport → target 时才落到 SWD（同样报 No J-Link device found 是因为当时没插探针）。
- 实现：`doctor.ts` 导出 `openocdTransportArgs(interfaceConfig)`（`/jlink/iu` 命中才返回 `["-c", "transport select swd"]`）；四个起 openocd 的地方全部改用它——`flash.ts`、`debug.ts`、`regs.ts`、`debug-session.ts`。工程自带 `openocd.cfg` 时读文件内容判 `interface/jlink.cfg` 再补 transport。
- 兜底差异：CubeProgrammer CLI 只认 ST-LINK，所以 J-Link 全败时 notes 明说「没有 CLI 兜底腿」，不假装还有第二条路。

### 二、launch.json 不再拆两份 configFiles

原模板是 `configFiles: ["interface/cmsis-dap.cfg", "target/stm32f1x.cfg"]`——cortex-debug 按顺序 `-f` 加载，**中间没有地方插 `-c transport select swd`**，J-Link 用户在 VSCode 里按 F5 必然连不上；而且 interface 与 openocd.cfg 各写一份，早晚分叉。

改为 `configFiles: ["${workspaceFolder}/openocd.cfg"]`：工程根目录的 openocd.cfg 里按 interface → transport → target 顺序写全（scaffold 生成的 openocd.cfg 本来就含 `transport select swd`）。实测 cwd=工程目录时 `source [find openocd/stm32c0x.cfg]` 能解析（没插探针时报 `unable to find a matching CMSIS-DAP device`，说明脚本已加载）。HAL 与 register 两条路线、`writeVscodeConfigs` 与 `createProjectScaffold` 同一口径；interface 只写在 openocd.cfg 一处。

### 三、验收

- tsc 0；`flash-orchestrator-units` 11 条、`vscode-units` 13 条、`scaffold-patch-units` 26 条全绿（断言从「launch 里有 interface 字面量」改成「launch 只引用 openocd.cfg」）。
- 真机未验：J-Link 手上没有，接口只到「脚本加载 + transport 顺序正确」；DAPLink 与 ST-Link 的历史实测仍有效。

## 83. 寄存器版从 F1 扩到 13 族：建工程 + 真编译闭环，时钟故意留复位默认（2026-11-08）

用户要求（m00556 第 4 条）：HAL 能写哪些芯片，寄存器版也要跟进。做法是**芯片事实全部来自资源包**（`device/<族>/chips.json`：startup / deviceHeader / deviceDefine / deviceId / flashBytes / ramBytes），插件不内置任何型号表；族清单从 1 条扩到资源包已有的 13 族：C0/F0/F1/F2/F3/F4/F7/G0/G4/L0/L1/L4/U0。

### 一、族级清单（`src/data/cmsis-sources.ts`）

- `CmsisFamilySpec` 增 `systemC`（`system_stm32f4xx.c` 这类）与可选 `mpuHeader`；13 条 spec 的 device 仓、cube 仓、include 目录、设备头、宏前缀按族填。
- 设备头与启动文件走 `findChipFact(cpn)`：资源包里没有这颗芯片 → 直接拒绝（文案列 13 族并指路 `stm32_assets refresh`），**绝不猜文件名**——同族不同 line 的启动文件与设备头完全不同（G431 是 `stm32g431xx.h`，G474 是 `stm32g474xx.h`）。
- 只给族不给型号时 register 路线拒绝（HAL 可以），理由同上。
- 哈希口径：只有 F1 保留逐文件 sha256（`CORE_HEADER_SHA256` 等实测值），其它族只锁形状（minBytes + markers），真实哈希由下载时登记进缓存索引——与 SVD 同一口径。若把 F1 的哈希套到别的族会直接报 `sha256 对不上（期望 03ab80c4…，实际 b51963d2…）`，这是本段真踩到的。
- 内核头按 spec 选（core_cm0 / cm0plus / cm3 / cm4 / cm7 / cm33），`mpu_armv7.h` / `mpu_armv8.h` 按内核头自动带上（`cm33 → mpu_armv8.h`，`cm0 → 无`）：漏了它 C0 编译报 `core_cm0plus.h:1007:10: fatal error: mpu_armv7.h: No such file or directory`。

### 二、按族生成的三块代码

- **GPIO/LED**（`src/engine/register-gpio.ts`）：`STYLE_BY_FAMILY` 分五套写法——F1 的 CRL/CRH + APB2ENR；F2/F4/F7 的 MODER + AHB1ENR；F0/F3/L1 的 MODER + AHBENR；G4/L4 的 MODER + AHB2ENR；C0/G0/L0/U0 的 MODER + IOPENR。表是拿编译器纠正出来的：F2 原按 F1 写会报 `'RCC_APB2ENR_IOPCEN' undeclared`、`'GPIO_TypeDef' has no member named 'CRH'`；F3 原按 AHB1 写会报 `'RCC_TypeDef' has no member named 'AHB1ENR'; did you mean 'AHBENR'?`。
- **时钟**（`register-clock.ts` 的 `planGenericClock` / `renderGenericClockInit`）：非 F1 **刻意不配 PLL**，`clock_init()` 生成空函数（保持 system_<族>xx.c 里 SystemInit 的复位时钟），报告写「复位时钟（未配 PLL）」。理由：PLL 源/字段/Flash 等待周期/电压调节各代不同，HSE 频率还随板子变；猜一个配方比留复位默认更危险（能编译、能跑，只是慢）。F1 仍走原来的 72 MHz 配方，`sysclkHz=72`。
- **链接脚本**（`register-linker.ts`）：`RegisterLinkerChip` 接受 chips.json 事实，`deviceIdFor` 优先用 `deviceId`（`STM32F401CBUx`），FLASH/RAM 取 `flashBytes`/`ramBytes`；F1 的 RAM 兜底表只对 F1 档位生效。

### 三、缓存自愈：清单变长时不能只信索引

索引只记「上次写了哪些文件」，清单加文件（这次加了 `mpu_armv7.h`）后旧缓存按索引看是完整的、实际缺文件 → C0 编译缺头。`ensureCmsisTemplate` 改为按**当前清单**逐个 `existsSync` 核对，缺什么下什么（`reuseRoot` 复用旧目录），索引合并已有文件（排除本次重下的同路径与 THIRD_PARTY_NOTICES.md）与新下载，`totalBytes` 一并重算；失败文案分母用待下条数。

另一类「网页当文件」也踩了：C0/G0 的伞头守卫是 `STM32C0xx_H`/`STM32G0xx_H`（无前导下划线），markers 原来只有 `#ifndef __STM32` → 全部源判「内容对不上」。markers 是「至少命中一个」，两代守卫都列上即可。

### 四、13 族真编译矩阵（`stm32_build`，msys64 ucrt64）

f0 736 B / f1 1404 B / f2 932 B / f3 948 B / f4 960 B / f7、c0、g0、g4、l0、l1、l4、u0 全部 ok=true，RAM 均 1576 B（无错误行）。生成到 `demo/.tmp-reg/v6/<族>`，芯片取资源包首条：C011D6Y6 / F030C6T6 / F103C8T6 / F205RBT6 / F301C6T6 / F401CBU6 / F722ICK6 / G030C6T6 / G411C6T6 / L010C6T6 / L100C6U6 / L412C8T6 / U031C6T6。

### 五、教训

- **模板注释里连占位符名与注释结束符都不能出现**：main.c 原写「见 __LED_INIT__」后紧跟占位符，全局字面量替换把整段 led_init() 塞进注释，里层注释结束符提前闭合外层，报 `#else without #if` 与 `redefinition of 'led_toggle'`。第一次修时又在注释里写了反引号包住的结束符，再踩一次（`missing terminating ' character`）。
- **过时单测是能力升级的镜子**：「G431CBT6 不支持」在扩族后必然翻车；认不出的用例改用资源包没有的 H5（`STM32H563ZIT6`）。同理 `seedCmsisCache` 种固定 3 个文件不再够用，改成按 `cmsisTemplatePlan` 的 targets 逐条落盘。
- **能力表要跟清单一起改**：`family.ts` 新增 `HAL_REG_CAPS`，13 族画像改用它，`PENDING_REG` 与 `CAPABILITY_GAPS.registerScaffold` 文案同步；否则 `route_plan` 会把已支持的族判成 hal-only。

### 六、验收

- tsc 0；TOTAL **pass=907 fail=0**；`pack-smoke` 全过；包体 678.0 KB / 上限 1171.9 KB（136 文件）。
- 生成 + 编译 13 族全过（见上）；HAL 路线未回归真建（本批只动 register 模板与族画像，HAL 用例全绿）。

## 84. 缺件不只报"缺"，还要给出下载入口（CubeMX / CubeProgrammer）（2026-11-08）

用户要求（m00556 第 2、3 条）：没有 CubeMX 就写不了 HAL；缺 CubeMX 要提示去下载，用到 CubeProgrammer 但没装也要提示。第 2 条本来是事实（HAL 的固件包与 `stm32_generate` 都依赖 CubeMX），缺口在第 3 条——**探测层**（`stm32_doctor` / `stm32_env_install` / 工具链门禁）早就带官网链接，但**运行时**真正失败的这一刻只说"找不到固件包"或"本机没找到 CLI"，用户不知道下一步该干什么。

### 一、CubeMX：HAL 失败文案里说清"为什么离不开它"

- `scaffold.ts` 新增 `CUBEMX_DOWNLOAD_URL`，并在找不到固件包时追加一段：本机没找到 STM32CubeMX 安装（列出扫过的候选）+ 两条理由（固件包只由 CubeMX 包管理器维护；`Core/` 下的 `MX_*_Init` 要 `stm32_generate` 调无头 CubeMX 生成）+ 官网链接（约 1.5 GB，含内置 JRE）+ 一句"只写寄存器程序不需要它（route=register）"。
- 建工程**成功**时也检查：cubeMxRoots 一个都不存在 → warnings 里同样放这段（否则用户建完才在 generate 那步撞墙）。
- 刻意不把 HAL 建工程的门禁改成 generate 能力：拷 CMake 文件与 Drivers 不需要 CubeMX 启动器（B15 仍是"找不到固件包"而不是"缺 STM32CubeMX"），提示是**附加信息**，不是新增门禁。

### 二、CubeProgrammer：三条失败路径都带链接

缺 CLI 有三处会撞上，全部补 `https://www.st.com/en/development-tools/stm32cubeprog.html` 与"默认路径即可被自动发现，装在别处设 STM32_CUBE_PRG_ROOT"：

- `cube-programmer.ts` 的 `runCubeProgrammerFlash`（任何调用方）；
- `flash.ts` 的 `runCubeProgrammerBackend`（`backend=cubeprogrammer` 直连）；
- `flash.ts` 的 auto 兜底分支（实见 ST-LINK 但没装 CLI 的那条 note）。

### 三、验收

- tsc 0；新增 2 条回归用例：scaffold 失败文案必须含 CubeMX 链接与 route=register 说明；`backend=cubeprogrammer` 缺 CLI 时必须含 CubeProgrammer 链接且不调 CLI。
- `flash-orchestrator-units` 14 条（含 2 条 J-Link：实见 1366 就选 `interface/jlink.cfg` 且参数顺序 interface → `-c transport select swd` → target；J-Link 失败不派 CubeProgrammer 并提示 transport）、`scaffold-patch-units` 26 条全绿；全量 TOTAL **pass=910 fail=0**；`pack-smoke` 全过；包体 678.8 KB / 上限 1171.9 KB（136 文件）。


## 85. 资源仓并入插件：assets/ 随包分发，不再有第二个仓库（2026-11-09）

用户要求（m04422）：`dsh-stm32-assets` 一共才十几兆，全部挪进插件仓库，少维护一个仓库，插件里对应的程序一起改。此前资源是独立仓 + manifest 下载器（三条源、逐文件 sha256、staging 回滚、`stm32_assets refresh`）；并入后**资源就是包的一部分**，装好插件即离线可用。

### 一、搬运与清点

- 资源仓 tracked 137 个文件。`.cache/`（16 文件 4.37 MB 的探针草稿）本就不入库，不搬。
- `diagrams/` 4 个文件与插件 `docs/diagrams/` 同名文件 sha256 完全相同，不重复搬，也不进 manifest。
- 搬进 `assets/`：device / headers / ioc / ld / startup / templates、`manifest.json`、`README.md`、`VERSION`，共 129 文件 12.48 MB；三个生成脚本进 `scripts/assets/`。
- manifest 过滤掉 diagrams 后：schema 2、files 105（core 75 = device 27 + ioc 34 + ld 14；full 再加 startup 14 + headers 16）、合计 12,936,436 B。`templates/family/` 21 份是生成 `ioc/family/` 的源模板，保留但不进 manifest。
- 口径修正：旧文档写 core 69，实际按 glob 展开是 **75**（27+34+14）；测试先按 69 写，被真实 manifest 打回。

### 二、布局与解析

- **flat 布局**：`assets/manifest.json` 与 `device/` 同层，不套 `<version>/`。`bundledAssetsRoot()` 用 `path.resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets")`，`lib/engine/assets.js` 正好解析到包根 `assets/`。
- `assetsRootInfo(env)`：默认 `origin="插件内置（assets/）"`；`DSH_STM32_ASSETS` 非空仍覆盖（开发与单测），可指向 flat 或旧的 `<version>/install.json` 多版本布局。
- `listInstalledVersions` 先认 flat 根（`bundled=true`、`current=true`、`installedAt="插件内置"`），再列外部历史版本；flat 存在时 current 只给 flat。`readLocalManifest` 同样先 flat，`versionDir` 就是根。
- `ensureAssets` 退化成**纯本地完整性检查**：manifest + `device/f1/chips.json` 存在即 `ok/cache/bundled`，缺则 `missing` 并让人重装插件。为不打断调用方，旧参数 `source/fetchImpl/timeoutMs/signal` 保留但不使用，`EnsureAssetsStatus` 仍含 `refreshed`（永不产生）。

### 三、删掉下载器

- `src/engine/assets.ts` 整体重写（约 800 行）：删除 `ASSETS_SOURCES`、`resolveSources`、`fetchManifest`、`verifyAndInstall` 与全部下载/staging 代码；保留 `parseManifest`、glob/profile、逐文件 sha256 校验、`resolveAssetFile`、`verifyInstalled`、`pruneOldVersions`。
- `pruneOldVersions` 在 `base === bundledAssetsRoot()` 时直接返回，**绝不删包内资源**；只有 `DSH_STM32_ASSETS` 下的历史版本与 `.tmp-*` 会被清。
- `src/tools/assets.ts` 重写：`list/verify` 查内置资源并逐文件标 present/missing；`refresh` 保留为 `verify` 的别名（文案明说「资源随插件内置，不需要下载」）；`prune` 只清外部历史版本。输出 schema 14 个必填字段不变（`attempts` 恒空、`offlineFallback` 改为内置说明）。
- 文案统一：`ASSETS_REFRESH_HINT` 改为「资源随插件内置（assets/）：缺文件说明安装不完整，重装插件后重试；stm32_assets verify 可定位缺了哪些」，`SVD_FULL_PROFILE_HINT` 改为「SVD 只在 profile=full 里：重装插件（或确认安装完整）」。涉及 `svd.ts`、`device-facts.ts`、`stm32f1.ts`、`scaffold.ts`、`hal-chip.ts`、`register-template.ts`、`regs.ts` 等 20 个文件。

### 四、打包与护栏

- `package.json` 的 `files` 加 `assets`；`scripts/pack-size.mjs` 的 `MAX_TARBALL` 从 1.2 MB 提到 **4 MB**（不是按源文件 12.5 MB 提，因为设备头是文本、压缩后很小：实测 1.75 MB），`REQUIRED` 增加 `assets/manifest.json` / `assets/device/f1/chips.json` / `assets/ioc/minimal/STM32F103C8Tx.ioc`。
- `scripts/pack-smoke.mjs`：断言解包后有 assets 关键文件；建寄存器工程时清空 `DSH_STM32_ASSETS`，强制走解包后 `lib/engine/assets.js` 的 `../../assets` 解析——这一步才真正证明资源进了 tarball。
- `test/assets-units.test.mjs` 整体重写：13 条全离线用例，覆盖 flat/旧版本发现、readLocalManifest、ensureAssets、resolveAssetFile、verifyInstalled、prune 安全、工具 list/verify/refresh/prune；`svd-units` 与 `stm32f1-units` 的旧 `refresh` 文案断言同步改为新提示。

### 五、验收

- `npm run build` exit 0（tsc + copy-client + copy-data）。
- `node test/run-units.mjs`：**TOTAL pass=908 fail=0**（assets 套件 13 条全绿；svd-units 39、stm32f1 18）。
- `npm run test:pack`：pack-smoke 全过（含「解包产物能建寄存器工程」与 assets 关键文件）。
- `npm run test:size`：包体 **1750.3 KB / 上限 3906.3 KB**，解包 14901.3 KB，265 个文件；`templates/**` 运行时资产 22.0 KB / 9 个。
- 未做：真机烧录验证（无探针）；dsh 需重启才加载新代码。

### 六、教训

- **别把「资源包」当成永久概念**：下载器、三源回退、staging 回滚、profile 安装开关，在资源随包后全是死代码；留着只会让「缺文件」被误诊成网络问题。删掉后 `ensureAssets` 的语义反而更清楚——它只是在检查安装完整性。
- **flat 与 versioned 必须并存**：外部 `DSH_STM32_ASSETS` 的历史版本还在用户机器上，直接只认 flat 会让老夹具与老缓存全失效；flat 优先、旧版兜底，两边都测。
- **体积护栏要按产物量级设，不是按源文件量级**：12.5 MB 源文件打成 1.75 MB tarball；按源文件设上限会让护栏失去意义。
- **文案断言是最容易漏的回归**：删下载器后 `refresh --profile full` 的提示全变了，`svd-units` / `stm32f1-units` 立刻红；工具文案是契约，改语义必须同步测试与 README。

## 86. 串口 P1：Windows PowerShell 桥 + `stm32_serial` 七动作（2026-11-09）

用户要的是一条**不需要 GUI** 的串口闭环：模型自己开串口、发一行、等回包、读收到的行，串口助手不再由人肉中转。硬约束有两条：插件**零 npm 依赖**（dependencies 为空），且 P1 只做 Windows、不做右侧面板/SSE。

### 一、为什么是 PowerShell 桥

- Node 没有内建串口；装 `serialport` 就破坏零依赖。Windows 自带 PowerShell 5.1 + `System.IO.Ports.SerialPort`，于是真正握着 COM 口的是 `templates/serial/bridge.ps1`（18472 B，纯 ASCII）。
- Node 侧（`src/engine/serial.ts`，约 1999 行）只是**文件 IPC 客户端**：起桥用 `spawn(powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File bridge.ps1)` + `stdio: ignore` + `windowsHide` + `unref`。
- **不能用 `detached`**：Windows 上它翻成 `DETACHED_PROCESS`，powershell.exe 5.1 直接 exit 0，什么都不跑（这是本轮最早踩的坑；改成 spawn + unref 后才有独立于工具调用的桥）。
- 桥也必须是纯 ASCII：PS 5.1 对无 BOM 的 .ps1 按 ANSI 解码，中文 hint 全部放在 `src/tools/serial.ts`。

### 二、文件契约（没有 RPC）

目录 `%USERPROFILE%\.dsh-stm32\serial\<sessionId>\`（`DSH_STM32_SERIAL_HOME` 改根）：

- `session.json`：会话参数（端口、波特率、8N1、dtr/rts、编码、换行、persist、超时、maxLines/maxBytes）。
- `status.json`：`opening|open|closed|error`，桥每 1 s 心跳；`open` 等它到 `state=open`（上限 5 s）。
- `cmd/<id>.json` → `done/<id>.json`：命令与回执；`cmd` 先写 `.tmp` 再 rename，避免半截 JSON。
- `rx.ndjson` / `tx.ndjson`：收发行流水 `{t,d[,p]}`，`p=true` 是无换行残行。
- `bridge.pid` / `bridge.log`：pid 与桥自己的日志。

节拍：桥 20 ms 轮询串口、100 ms 扫 `cmd/`、1 s 写 `status.json`、5 s 查一次父进程 PID——DSH 被杀（关窗口/重启宿主）时桥自己放口退出，否则 COM 口会永远「被占用」。超时：`send` 等 `done` ≤2 s（`ACK_WAIT_MS`），`close` 等 3 s（`CLOSE_GRACE_MS`）后强杀，`idleTimeoutMs` 默认 600000（10 min）自动放口。

### 三、单会话、参数与端口记忆

- 模块级 `active` 只允许一个会话；重复 `open` 返回 `already-open` 并提示先 `close`。并发两次 `open` 由引擎的 `openChain` 串行化（t14 修）：一次成功、一次 `already-open`。
- 默认（`src/data/serial-config.ts`）：115200 / 8 / 1 / none 校验 / 无流控 / **dtr=false、rts=false** / utf8 / CRLF；会话参数 `timeoutMs=1000`（上限 30000）、`maxLines=200`、`maxBytes=65536`、`idleTimeoutMs=600000`、`maxLogBytes=8 MB`、`persist=false`。波特率 50–4000000，数据位 5–8。
- 端口记忆 `%USERPROFILE%\.dsh-stm32\serial.json`（`DSH_STM32_SERIAL_CONFIG` 覆盖；`DSH_STM32_NO_CONFIG=1` 关闭）：身份三档 `usb:VID:PID:序列号` → `usb:VID:PID@位置` → `com:COMx`，最多 32 个、按最后使用淘汰；**只有成功 open 才写**。

### 四、工具层与错误

- `src/tools/serial.ts`（829 行）：`SERIAL_TOOL="stm32_serial"`，七个动作 `list/open/read/send/transact/status/close`；输出 `{message, report}`，report 的 24 个必填字段恒定，失败时附 `serialError`。
- 工具层补三件引擎不做的事：`cursor` 增量读（`nextCursor` 是 `rx.ndjson` 的字节偏移）、`hex`（`"48 65 6C"` 按会话编码反解）、`until` → `transact.match` 正则。
- 11 类错误统一 `{kind,cause,hint,evidence,retryable}`：`unsupported-platform` / `powershell-missing` / `port-not-found` / `port-busy` / `access-denied` / `settings-invalid` / `bridge-start-timeout` / `bridge-crashed` / `disconnected` / `already-open` / `no-session`；中文 `cause`/`hint` 在工具层。
- `persist=false` 时 turn 结束自动 `close`（`turn/end` 事件），`persist=true` 才跨 turn。

### 五、t14 的六处收口

1. `abandonBridge`：open 失败/超时先发 close 等 800 ms、再 kill 等 1.5 s，目录留 `abandoned.json`，`status` 报 `orphanDirs`——失败不再留下占着 COM 口的孤儿桥（代价是失败 open 多花约 2.3 s）。
2. `openChain`：open/close 串行，消除并发 `open` 的双桥竞态。
3. `SerialSessionView` 增 `timeoutMs/maxLines/maxBytes/idleTimeoutMs`，open 报告显示会话实际值而不是全局默认。
4. `transact` 的 `truncated` 与 `timedOut` 解耦：读满上限不等于没等到回包。
5. `bridge.ps1` 的 `rtscts` 改 `Handshake::RequestToSend`，流控参数真正生效。
6. `readSerial` 缺省用会话打开时的 `maxLines/maxBytes`，工具层不再另给一套默认。

### 六、验收

- `npx tsc --noEmit` exit 0；`npm run build` exit 0。
- `test/serial-units.test.mjs`：**23 pass / 0 fail**，全部走 `test/fixtures/serial-fake-bridge.mjs` 假桥（同一份文件契约；`DSH_STM32_SERIAL_FAKE_FAIL` / `DSH_STM32_SERIAL_FAKE_SLOW_OPEN_MS` 两个钩子造失败与慢 open）。
- 全量 `node test/run-units.mjs`：**TOTAL pass=932 fail=0**（t15 时点）。
- **真桥只验到失败路径**：用真 PowerShell + 真 `bridge.ps1`、`DSH_STM32_SERIAL_PORTS` 造一个不存在的 COM99 → `port-not-found`；`status.json`/`bridge.log` 落盘正确、无残留 pid、`orphanDirs=0`。成功路径（`state=open`、真实收数、DTR/RTS 实际电平、5 s 看门狗、idle 自动放口、`port-busy`/`access-denied` 真机样本）**没有硬件证据**：本机无板、也没有第二个 COM 口可占。
- `turn/end` 的真实宿主事件只做了代码审读；`powershell-missing` 未实测（本机必装）。

### 七、未做 / 已知风险

- P1 不做右侧串口面板、不做 SSE/WebSocket 推流（`read` 是拉取式）、不支持 Linux/macOS（直接 `unsupported-platform`）、不自动重连。
- `orphanDirs` 是「目录里还有 `bridge.pid` 且进程活着」，多开几个 DSH 进程时会把别人的活会话误列为孤儿（只是提示，不动别人的进程）。
- kill 失败时没有更强的手段，只能提示人工关进程；`read` 的 `maxBytes` 有 256 的下界 clamp。
- 恢复路径：`stm32_serial action=close` → 不行再按 `status` 报的 pid 手工结束；桥日志在会话目录 `bridge.log`。

### 八、教训

- **「独立进程」在 Windows 上不等于 `detached`**：Node 的 `detached` 会改进程创建标志，老 PowerShell 直接不执行脚本；spawn + unref 才是对的做法。
- **文件 IPC 比 stdin/stdout 更好测**：假桥只要照同一份 `cmd/``done/``status.json` 契约写文件，23 条用例全离线；换成管道协议就得模拟进程生命周期。
- **失败路径也要收口**：open 超时若只 kill 不管，桥可能已经握着口；先 close 再 kill、再留 `abandoned.json`，才能把「口被占」变成可诊断状态。
- **零依赖是产品约束，不是洁癖**：它直接决定了「桥」这个形态；文档里必须写清 P1 的边界，否则用户会默认它跨平台、有 UI、会重连。

## 87. 寄存器路线 13 → 21 族：数据层、GPIO 门与链接窗口（2026-11-09）

0.1.5 把寄存器建工程从 13 族扩到 21 族：新增 **H5 / H7 / L4+ / L5 / U3 / U5 / WBA / WL**。这一节写已经落地并复核过的事实：数据层与链接层见一～三，8 族的逐族 `create→build` 矩阵见 §87.5（t6 已跑完，8/8 通过，合计 21/21）。

### 一、21 族与代表型号

`src/data/cmsis-sources.ts` 的 `CMSIS_FAMILIES` 现在 21 项（原 13 族 + 8 族）；内置 `assets/device/<族>/chips.json` 同步到 21 族。逐族抽一颗代表型号核对过（头文件 / 启动文件 / 设备宏 / Flash / RAM）：

| 族 | 代表型号 | 设备头 | 启动文件 | 设备宏 | Flash / RAM |
| --- | --- | --- | --- | --- | --- |
| H5 | STM32H563ZIT6 | stm32h563xx.h | startup_stm32h563xx.s | STM32H563xx | 2 MB / 640 KB |
| H7 | STM32H743ZIT6 | stm32h743xx.h | startup_stm32h743xx.s | STM32H743xx | 2 MB / 864 KB（跨域合计，不连续） |
| L4+ | STM32L4R5ZIT6 / STM32L4P5ZGT6 | stm32l4r5xx.h / stm32l4p5xx.h | 同名 startup | STM32L4R5xx / STM32L4P5xx | 640 KB / 320 KB（连续） |
| L5 | STM32L562ZET6 | stm32l562xx.h | startup_stm32l562xx.s | STM32L562xx | 512 KB / 256 KB |
| U5 | STM32U575ZIT6 | stm32u575xx.h | startup_stm32u575xx.s | STM32U575xx | 2 MB / 786 KB |
| WBA | STM32WBA55CGU6 | stm32wba55xx.h | startup_stm32wba55xx.s | STM32WBA55xx | 1 MB / 128 KB |
| WL | STM32WLE5CCU6 | stm32wle5xx.h | startup_stm32wle5xx.s | STM32WLE5xx | 256 KB / 64 KB |

- L4+ 必须走 `cmsis-device-l4` + `STM32CubeL4`、设备宏前缀 `STM32L4`（没有独立的 l4plus 仓库）。
- WL 的 chips 只有 WLE4/WLE5，没有 WL55；WL55 双核的启动文件是 `startup_stm32wl55xx_cm4.s`，不在寄存器路线里。
- 首次下载的 8 族 CMSIS 源（设备头 / system / startup / 内核头）在 2026-11-08/09 逐族实测 200；唯一例外是 STM32CubeU3 的 `cmsis_gcc.h` 在 jsDelivr 403（上游树缓存），raw.githubusercontent 与 ghproxy 两条兜底正常。

### 二、GPIO 使能位：四种口径

`src/data/register-gpio.ts` 按芯片记录选：

- `moder`：原 F1 口径（GPIO 在 APB2）。
- `moder-ahb4`：**H7**，GPIO 挂在 AHB4ENR，端口 A–K。
- `moder-ahb2enr1`：**U3 / U5**，GPIO 在 AHB2ENR1；U3 只有 A,B,C,D,E,G,H（没有 F）。
- `moder-ahb2`：其余族（H5 A–I、L4+ A–I、L5 A–H、WBA/WL A,B,C,H）。

族 profile（`src/data/family.ts`）的 `HAL_REG_CAPS`/`PENDING_REG` 与 `CAPABILITY_GAPS` 文案同步改成 21 族口径；不支持列表固定为 WB / WB0 / WL3（双核或无线专用）/ MP1 / MP2 / N6（MPU/NPU 路线）。

### 三、链接脚本：H7 的 DTCM 与 U5 的 per-line 窗口

`DeviceFactsChip` 新增可选 `linkerRam { origin, sizeBytes, region }`；`planRegisterLinker` 优先用它并改写 `MEMORY` 的 ORIGIN/LENGTH（`family-assets.mjs` 负责落数据与 manifest）。

- **H7**：138 颗全部带 `{0x20000000, 128 KiB, DTCM}`。生成的 .ld `RAM` 128 KB、`_estack=0x20020000`；实测 130 KB `.bss` 报 `RAM overflowed by 3592 bytes`，8 KB 通过（`g_data`/`g_bss` 落在 0x20000000/0x20000004）。
- **U5**：62 颗按 line 给窗口——535/545 256 KiB，575/585 768 KiB，595/599/5A5/5F7/5G7 2496 KiB（region SRAM）；实测 260 KB 溢出 5640 B、8 KB 通过，`_estack=0x20040000`。
- **L4+ / L5**：都是连续单块，不需要 `linkerRam`；L5 的 192 + 64 KiB 相邻，合并成 256 KiB。
- h7/u5 的 `chips.json` 与 `assets/manifest.json`（bytes + sha256）已同步；`stm32_assets verify` 通过。

### 四、已验收 / 未验收

- 已过：`npm run build` exit 0；`node test/run-units.mjs` pass=932、0 fail（t6 时点；t4 时点 909）；H5 冒烟 `createRegisterProject(STM32H503CBT6)` 下载 10 个 CMSIS 文件并 `cmake --build`（Debug）exit 0；8 族矩阵 8/8 全过（§87.5）。
- 两处模板阻塞已在 t6 修掉并被矩阵验证：①模板 cmake 的 `-mcpu=cortex-m3` 改为按族生成——`src/engine/register-template.ts` 新增 `coreFlagOf()`，复制 `cmake/gcc-arm-none-eabi.cmake` 时替换（H7=cortex-m7，H5/L5/U3/U5/WBA=cortex-m33，L4+/WL=cortex-m4）；②`core_cm7.h:2234` 条件 include `cachel1_armv7.h`——`src/data/cmsis-sources.ts` 增加 `extraCoreHeaders`，H7 的下载/校验清单补上（guard `ARM_CACHEL1_ARMV7_H`），H7 模板目标 10→11 个文件。
- **独立验收（t8）已通过**：上面是实施侧矩阵；t8 由 impl 复验，结论一致，证据见 §87.6。

### 五、8 族逐族矩阵（t6 实测，warning 0 / error 0）

| 族 | 型号 | 结果 | FLASH used/total | RAM used/total | elf B |
| --- | --- | --- | --- | --- | --- |
| H5 | STM32H503CBT6 | ok | 1368 / 131072 | 1576 / 32768 | 610028 |
| H7 | STM32H723VGT6 | ok | 1524 / 1048576 | 1576 / 131072 | 1039792 |
| L4+ | STM32L4P5AGI6 | ok | 988 / 1048576 | 1576 / 327680 | 895372 |
| L5 | STM32L552CET6 | ok | 1044 / 524288 | 1576 / 262144 | 842544 |
| U3 | STM32U375CET6 | ok | 1124 / 524288 | 1576 / 262144 | 929460 |
| U5 | STM32U535CBT6 | ok | 1196 / 131072 | 1576 / 262144 | 937248 |
| WBA | STM32WBA50KGU6 | ok | 916 / 1048576 | 1576 / 65536 | 495364 |
| WL | STM32WLE4CBU6 | ok | 856 / 131072 | 1576 / 49152 | 433488 |

- 验证方式：8 个工程 `cmake configure + build` exit 0，`stm32_build` clean rebuild `ok:true` / `warningCount 0` / `errors []`；M33 族（H5 / L5 / U3 / U5 / WBA）用默认 startup + cortex-m33 编译链接全过，不需要额外 CMSE/TZ 选项。
- H7 内存证据：`.ld` 的 `RAM ORIGIN=0x20000000 LENGTH=128K`，`nm _estack=0x20020000`，`.data` 0x20000000+4B、`.bss` 0x20000004+0x20B，都在 DTCM 窗口内；U5 用 256K 连续窗口（RAM 1576/262144）未越界。
- 采集口径的坑：`stm32_build` 解析器把 1 MB 的 FLASH 行漏了，H7 / L4+ / WBA 三行是 t6 从原始 cmake 输出补记的（不是编译问题）。
- t6 是在**新 Node 进程**里直接 import `lib/engine/register-template.js` 建工程的：长驻 dsh 进程会缓存旧插件模块，`tools.stm32_project_create` 建出的仍是旧模板（564K / m3 / 无 cachel1）；build 仍走 `stm32_build`。矩阵工程留在 `demo/.tmp-register-matrix/`，未提交。

### 六、t8 独立验收（2026-11-09）

t8 由 impl 执行（不是寄存器路线的实现者）：只做只读复验与新建工程编译，不改实现。以下是 0.1.5「21 族可用」的独立证据；它和 §87.4 / §87.5 的实施侧矩阵互相印证。

- **数据层**：`CMSIS_FAMILIES` 恰 21 个键（`src/data/cmsis-sources.ts`）；`registerScaffold` 对 21 族逐一有 profile，没有缺项或多余键。
- **8 族 GPIO 门**：H5 A–I@AHB2ENR、H7 A–K@AHB4ENR、L4+ A–I@AHB2ENR、L5 A–H@AHB2ENR、U3 A,B,C,D,E,G,H@AHB2ENR1（无 F）、U5 A–I@AHB2ENR1、WBA/WL A,B,C,H@AHB2ENR；`register-gpio.ts` 的 `moder-ahb4`（H7）与 `moder-ahb2enr1`（U3/U5）两条路径都命中。
- **链接窗口**：H7 138/138 颗带 `linkerRam`（0x20000000 / 128 KiB / DTCM），U5 62/62 颗按 line 带窗口；H7 实测 `.ld` 的 `RAM LENGTH=128K`、`_estack=0x20020000`，链接后 RAM 末地址 0x20000628，未越过 DTCM 上界。
- **事实校验**：外部 `verify-facts` 296 条断言 `failed=0`（逐颗启动文件 / 设备宏 / Flash·RAM 与 assets 一致）。
- **编译**：H5 / H7 / L4+ 新工程 `create→build` exit 0；8 族 `cmake` 构建全部 exit 0（warning 0 / error 0，逐族 FLASH/RAM 见 §87.5）。
- **回归**：`npm run build` exit 0；`node test/run-units.mjs` pass=932 / fail=0。
- **未验**：真机烧录与运行（无硬件）；逐颗 `linkerRam` 只验了代表型号与窗口边界，没有对 138 + 62 颗全部做链接/上板验证。

### 七、教训

- **「族」不是「内核」**：H7 的 GPIO 在 AHB4ENR、U5 在 AHB2ENR1，按 F1 的 APB2 套就会静默不亮；使能位必须按族查数据，不能按内核猜。
- **链接窗口是数据，不是常量**：H7 只给 DTCM、U5 按 line 分窗口，写死一张 RAM 表就必然有一颗芯片越界；`linkerRam` 放进 chips.json 后，溢出错误在链接期就暴露。
- **下载成功 ≠ 可编译**：CMSIS 头/启动文件齐了只说明事实层对了；`-mcpu` 与内核附加头（`cachel1_armv7.h`）是模板层的事，验收矩阵必须真的 build。

## 88. 0.1.5 旧文案清理（2026-11-09）

跟 13 → 21 族与串口 P1 一起，把「只有 F1 / 13 族 / 22 个单核族 / HAL 14 族」这类旧口径从用户文档里清掉。原则：**用户文档写现在的行为；development-notes 的历史章节保留当时的数字**（它们是决策记录，不是现状）。

### 一、改了什么

- `README.md` / `README_EN.md`：首段链条补 `stm32_serial`；寄存器族数 13 → 21（初稿按当时口径写「13 族已过、8 族矩阵指 §87」；t6 补上矩阵后已统一成 21/21，见 §87.5）；「这只是最小验证」的边界句去掉「只到 F1」；功能表加串口行；新增「串口（Windows P1）」章节；芯片章节补寄存器内存映射 bullet；已知限制补串口两条与 8 族矩阵一条；文档节指向 `docs/release-notes/v0.1.5.md`。
- `docs/reading-guide.md`：§4.2 工具表补 `stm32_serial` 行；新增「§12 0.1.5 增补」讲串口文件 IPC 与 21 族事实层；§11 的历史条目与数字不动。
- `docs/development-notes.md`：新增 §86/§87/§88；§1–§85 不动。
- 新增 `docs/release-notes/v0.1.5.md` 骨架；t17 已把测试与包体数字填成实测值；t22 按 `test:size` 最终实测回填为 932 pass / 59 套件、269 文件 / 1800.6 KB packed / 15094.8 KB unpacked。
- t17 补清代码侧文案：`src/skill/stm32-workflow.ts:12,14`（HAL 22→21、寄存器 13→21，并写明其余族 WB/WB0/WL3/MP1/MP2/N6 只有 HAL 或明确拒绝）、`src/tools/project-create.ts:180`、`src/data/family.ts:131,146`、`test/assets-units.test.mjs:178` 标题、`package.json:4` description（version 未动）。

### 二、收尾结果（t22）

- 版本号已 bump 到 0.1.5：`package.json`、`package-lock.json`（根与 `packages[""]`）、`README.md` badge 与安装确认行、`README_EN.md` badge 与安装确认行；历史 release notes 里的 0.1.4 保留。
- 代码侧旧族数已由 t17 改掉：`src/skill/stm32-workflow.ts:12,14`、`src/tools/project-create.ts:180`、`src/data/family.ts:131,146`、`test/assets-units.test.mjs:178`、`package.json:4` 的 description；剩下只有版本号与发版动作。
- `README.md` / `README_EN.md` 的测试规模与包体数字已按最终实测刷新：932 用例 / 59 套件，269 文件 / 1800.6 KB packed / 15094.8 KB unpacked（`npm pack` 原始 size=1,843,826 B、unpackedSize≈15,457,070 B，与 `test:size` 的 KB 口径一致）。
- 工具计数已改到 24 个注册工具（`src/tools/` 23 个文件 = 22 个工具文件 + `project-dir.ts`；`debug-session.ts` 一键三工具），两份 README 的「注册 23 个工具」都已改口。
- `docs/development-notes.md` §5040/5049/5451/5453/5458/5475/5483/5488 附近的旧族数是历史记录，**不改**；`docs/reading-guide.md` §11 的早期条目里「只有 F1 在 FIRMWARE_FAMILIES」是现状描述，已改为「目前收 17 族」并列出族名。
- t8 独立验收已通过，README / README_EN / release notes / §87.4 的「独立验收尚未收口」四处已改为通过并指向 §87.6；`src/commands/register.ts:253` 注释「六条斜杠命令」实测 7 条，已改。

### 三、教训

- **旧口径要按「文档类型」分流**：README/指南是现状，必须改；notes 是时间线，改了反而丢失「当时为什么这么写」。
- **留清单比随手改安全**：版本号、skill 文案、工具 description 与测试断言要跟 package.json/代码一起动，文档预检阶段先列 `文件:行`，避免两边不同步。

## 89. 安装包只下载、不安装：`stm32_download`（2026-11-10）

### 一、问题与边界

用户问「实见 J-Link 但缺驱动，能不能自动装」。核验后结论是：**软件包可以自动下，驱动不能无感装**。J-Link 安装器从 6.49a 起支持 `-InstAllUsers=0` 按用户安装，但 `-InstUSBDriver=1` 只在 `-InstAllUsers=1` 时生效，必须过 UAC；而现代 J-Link 探针默认 WinUSB，只有停产老探针才需要 legacy 驱动，Problem Code 28/52 也未必靠重装软件修复。STM32CubeMX / CubeProgrammer 更没有稳定直链：ST 官网要 myST 登录、接受许可，直链会过期，本机 `winget search STM32` 也没有对应包。

因此定边界：**插件只负责下载与校验，不执行安装器、不写注册表、不改 PATH、不请求管理员**。J-Link 用官方直链 + 固定 SHA256；ST 两个组件默认只打开官方页；用户自己下载好的安装包可以交给工具做哈希校验。

### 二、实现

- `src/engine/download.ts`（247 行）：`DownloadComponent`、`JLINK_DOWNLOAD`（8.18.0，URL `https://files.nordicsemi.com/artifactory/swtools/external/jlink/JLink_Windows_V818_x86_64.exe`，SHA256 `63110b6fc55e494d197d6efa156d7f61c0dd0c1f776424995a05407e2d7f566f`）、`ST_PAGES`、`planDownload`、`downloadRootInfo`、`downloadUrlToFile`、`sha256File`、`inspectInstallerFile`。
- 下载实现：`fetch` + `response.body.getReader()` 逐块写 `targetPath + ".part-<pid>-<ts>"`，边写边更新 SHA256；校验通过后先删旧目标再 `rename`；网络失败、超时、超过 `maxBytes`（默认 300 MB）或哈希不符都删除临时文件。已有目标且哈希正确时 `cached: true`，不重复下载。
- `src/tools/download.ts`（300 行）：`stm32_download`，四种模式 `plan` / `direct` / `manual` / `file`；`dryRun` 默认 `true`，`confirm` 只对 `direct` / `manual` 生效；`file` 模式只校验本地安装包，不需要 `confirm`。report 有 21 个必填字段，`expectedSha256` 与实测 `sha256` 分开，不把计算值伪装成官方值。
- `src/index.ts:26` 引入、`:74` 注册；`test/download-units.test.mjs` 5 条离线用例；`test/run-units.mjs:89` 登记。

### 三、验证

- `npm run build` exit 0；`node test/download-units.test.mjs` 5 pass / 0 fail；全量 `node test/run-units.mjs` **pass=937 fail=0**。
- J-Link 直链只做 `HEAD`：HTTP 200、`content-length: 59,012,800`；没有真的下载 59 MB，也没有运行安装器（按设计永远不运行）。
- 下载/缓存/哈希不符清理用本机 HTTP 服务覆盖；ST 页面只验证 URL 与计划输出，没有打开浏览器。

### 四、教训

- **「自动安装」和「自动下载」要分开承诺**：下载可以校验、可以重试、可以缓存；安装要 UAC、许可与驱动绑定，插件不该替用户点。
- **哈希要在写盘过程中算**：下完再读一遍 59 MB 会多一次全文件 IO；边写边算还能在中途失败时立刻停。
- **临时文件必须带 pid + 时间戳**：并发或上次崩溃留下的 `.part` 不能互相覆盖，失败清理也不该误删别人的。

<<<<<<< HEAD
## 90. DSH 0.2.2 收紧工具 schema：把 25 个工具压进子集（2026-11-12，随 0.1.6 发布）

### 一、问题与取证

DSH 0.2.2-rc.1 把工具 JSON Schema 压成固定子集，违规在**注册期**就抛 `JsonSchemaError`（错误码 `UNSUPPORTED_SCHEMA`），`ToolsService.register` 校验的是 `output.schema`——抛错即该工具从列表里消失，且没有明显提示。本轮开发会话里看不到任何 `stm32_*` 工具，先怀疑就是这个原因。

取证方式（不起真机、不猜）：

- 用 `asar` 头 JSON 从 `D:/app/DeepSeek Harness/resources/app.asar` 抽出 `node_modules/@deepseek-ai/dsh-tools/lib/types/json-schema.js`（25,604 字节），直接读白名单与逐条报错文本；
- 另抽 `tools` 服务与沙箱 `defineTool` 的调用点，确认三条影响面：`output.schema` 注册期校验、PTC 类型渲染与 sandbox `parameters` 校验（后两者失败只降级成 `unknown`/`Any`，不抛）；
- 自写探针按同一语义扫 25 个工具 → 5 个真违规、2 个假阳性（探针没做进入/退出栈，把复用同一子 schema 的节点误判成循环引用；真实校验器复核为合规）。

关键事实：`minimum`/`maximum` 不在白名单；`additionalProperties` 必须是 boolean；`properties`/`required`/`additionalProperties` 只能用在 `object`，`items` 只能用在 `array`。

### 二、实现

- `src/types.ts`：`JsonSchema` 收窄成宿主子集（删 `minimum`/`maximum`，`additionalProperties?: boolean`，`enum` 允许标量，补 `title`/`const`/`examples`/`oneOf`），注释写明依据与「范围写 description、执行期校验」。
- `stm32_ioc_plan`：`peripherals[].pins` / `parameters` 由 `type:"object" + additionalProperties:{type:"string"}` 改为 `type:"array"` + `items:{key,value}`（`required:["key","value"]`）；`pllMul` 由 `number + minimum + maximum` 改为 `integer + enum[2..16]`。账本侧 `src/engine/ioc-plan.ts` 新增 `KeyValuePair` 与 `keyValueMap()`（空 key / 重复 key 记 errors，重复时后值覆盖），类型改为 `KeyValuePair[]`。
- `stm32_build`：删掉 `artifacts`（数组）上的 `additionalProperties: false`。
- `stm32_assets`：`keep` 去掉 `minimum`，description 写「≥1 的整数」，`execute` 里运行期校验，非法值 `ok=false` 且不删任何文件。
- `stm32_serial`：参数与 `report.settings` 共 24 处 `minimum`/`maximum` 全删，范围写进 description（`SERIAL_LIMITS` 拼接），`dataBits` 用 `enum:[5,6,7,8]`；越界校验仍在 `normalizeSerialSettings`（`src/data/serial-config.ts`），越界记 errors 并保持默认值。

### 三、验证

- `npm run typecheck` / `npm run build` exit 0。
- 新增 `test/schema-subset-units.test.mjs`（2 条）：① 镜像校验器扫 `apply` 收集到的全部 25 个工具，0 违规；② 从 `app.asar` 抽出宿主**真校验器**（内部 import 用本地桩替换：`HarnessError`、`isJsonValue`/`assertNever`），逐 schema 与镜像比对结论一致。
- `node test/run-units.mjs` **pass=923 fail=0**（61 个套件；同机改动前基线 stash 实测 921，+2 为新套件）。
- `npm run test:pack` 全部通过；`npm run test:size` 1811.6 KB / 271 文件 / 解包 15132.3 KB。
- 未验：真机重启后 25 个工具是否可见可调用——开发会话没挂载插件，留给用户侧确认。

### 四、教训

- **看着像「工具没注册」的问题，先查宿主校验器源码**：报错被吞掉时，唯一可靠的事实是宿主那 25 KB 的白名单代码，不是文档。
- **探针要复刻宿主的栈语义**：不做 enter/leave 的循环引用检测会把复用子 schema 误报成环，假阳性会让你改本来没坏的地方。
- **镜像测试必须与真值对齐**：只写镜像等于自己给自己出题；抽出 `app.asar` 里的真校验器跑一遍，镜像才不会随宿主升级悄悄漂移（找不到 asar 时自动跳过，不阻塞 CI）。
- **`additionalProperties` 从 schema 退成 boolean 时，`pins` 这种「任意键 → 值」的映射只能换形状**：用户选了 `[{key,value}]` 数组，宿主能校验、模型有结构可依，代价是老写法要迁移。
=======
## §90 供应链完整性：MSYS2 固定版本与固件拼包哈希（2026-11）

用户要求（m06051）从 P0 开始修审计漏洞。两条都是「下载的东西没有可信哈希」：MSYS2 安装包下完直接 `-y` 执行，GitHub 固件归档只查 ≥500 B。修法是**把版本钉死、把哈希钉死，校验失败就不解压/不执行**；不是再加一层「看起来像校验」的体量检查。

### 一、MSYS2：固定 release + sha256，覆盖源必须自带哈希

- 原来 `INSTALLER_FILE = msys2-base-x86_64-latest.sfx.exe`，跟着 GitHub `releases/latest/download` 走——那是 **nightly**，每天变；四个国内镜像也不保留版本化文件（实测 TUNA/NJU/阿里云 404、USTC 403）。等于每次安装都在执行一个当天从网上拿的、无法复核的 exe。
- 改为固定稳定 release `2026-09-27`：`MSYS2_INSTALLER_VERSION = "2026-09-27"`，资产 `msys2-base-x86_64-20260927.sfx.exe`，43,117,824 B，`MSYS2_INSTALLER_SHA256 = ad336cccfda47758b5e15cda993fbba421115cb0b126697daef1ee4dfe37209f`（GitHub release API 的 digest，release 同时提供 `.sha256` 与 `.sig`）。`src/engine/msys2-install.ts:85-96`
- 默认只有一条源：官方 release 固定 URL。`resolveInstallerUrls(env)` 支持 `MSYS2_INSTALLER_URL`（完整 exe 地址）或 `MSYS2_MIRROR`（目录，自动拼固定文件名），但**必须同时给 `MSYS2_INSTALLER_SHA256`**；只给地址不给哈希直接 `ok:false`，不会悄悄退回官方源（避免「以为在用内网镜像，实际换成了公网未知文件」）。`src/engine/msys2-install.ts:466-520`
- 三道闸都用同一个 `checkInstallerFile(path, expectedSha256)`：体量 ≥40 MB、MZ 头、sha256 一致；错误里同时给期望值与实际值。下载后校验（不符删 `.part` 并换源）、缓存复用时校验（不符不删原文件、标 warning 后重下）、**解压执行前再校验一次**（防止缓存目录在两次之间被替换）。缓存文件名带版本：`msys2-2026-09-27.sfx.exe`。
- 失败文案不再写「10 个候选源、国内镜像优先」，改成固定版本/固定哈希口径，并直接告诉用户怎么补 `MSYS2_INSTALLER_SHA256`。

### 二、固件拼包：34 个归档 + 86 个内核头逐个钉 sha256

- 原来的 GitHub 回退通道有 3 条 URL（codeload、ghproxy、api tarball），`FetchTarget` 只带 URL、不带哈希，`minBytes: 500` 就是全部完整性检查；ghproxy 还是第三方代理。
- 实测同一 commit 的 codeload 与 api legacy tarball **字节不同**（F1 HAL：817,831 B / `EA95…` vs 818,351 B / `5B1D…`），所以一个 sha256 不能同时校验多条归档链路。改为**每个归档只保留 codeload 一条源**：`https://codeload.github.com/STMicroelectronics/<repo>/tar.gz/refs/heads/<ref>`；ghproxy 与 api 两条删除。
- `scripts/firmware/pin-firmware.mjs` 从 `lib/data/firmware-packages.js` 收集去重后的 **34 个归档**（21 族共用 repo，不是 42）与 **86 个内核头**（不是 105），流式下载算 sha256，生成 `src/data/firmware-pins.ts`。归档 key `<repo>@<ref>`，头 key `<repo>@<ref>/<包内路径>`，值 `{sha256, bytes}`。
- `firmwarePlanFor` 为每个归档与内核头查 pin；缺任何一条就 `ok:false`（提示先跑 pin 脚本并提交生成文件），不再返回「没有哈希的计划」。`FirmwareArchivePlan` 带 `sha256`/`bytes`，`src/engine/firmware-install.ts` 把它塞进 `FetchTarget.sha256`；`fetch.ts` 已有的校验逻辑保持不变，只把报错文案改成「更新 cmsis-sources（CMSIS 头）或 firmware-pins（固件归档/内核头）」。
- 没有钉 commit：GitHub API 未认证额度只有 60/h，63 个 repo 一次跑不完；哈希本身已经满足「内容不变」的要求——上游 master 挪动文件时，安装会在下载阶段明确拒收并给期望/实际哈希，而不是静默装进一个不同的包。需要完全可复现时，改 ref 为 commit 再重跑 pin 脚本即可。
- **F7 的 cachel1 是照 H7 抄错的**：`STM32CubeF7@master/Drivers/CMSIS/Include/cachel1_armv7.h` 在 raw 与 jsDelivr 都是 404，F7 的 `core_cm7.h` 也不 include 它。原清单让 F7 的 GitHub 拼包必然 404；已改成五个头（无 cachel1），并加测试锁住「H7 有、F7 没有」。

### 三、pin 脚本的可靠性

- 首次跑：34 个归档（含 H7 5.5 MB，codeload 约 420 s）完成后，`raw.githubusercontent` 批量 87 个头里 72 个 `ECONNRESET`，整批 reject、不写文件。
- 增加 `MAX_ATTEMPTS=4`、每条 URL 退避 1/2/3 s、`AbortSignal.timeout(180_000)`、`CONCURRENCY=6`；内核头按 fastly.jsDelivr → cdn.jsDelivr → raw → ghproxy 多镜像回退（`hashAny`）。raw 批量不可用、jsDelivr 个别 403，回退后 86 个全部成功。
- `--cache` 读 `../.dsh-stm32/firmware-pins-cache.json`，每成功一项立即原子写（`.tmp` + rename）；任一项失败就不写 `src/data/firmware-pins.ts`、退出码 1，并提示「修好网络后加 --cache 重跑，已完成项会复用」。缓存是本机维护产物，不提交。

### 四、验证

- `npm run build` exit 0；`node test/install-units.test.mjs` 29 pass；`node test/firmware-units.test.mjs` **47 pass / 0 fail**；全量 `node test/run-units.mjs` **pass=939 fail=0**（59 套件）；`npm run test:pack` 全部通过；`npm run test:size` **1817.6 KB / 272 文件 / 解包 15152.1 KB**（上限 3906.3 KB）。
- pin 产物：34 归档 + 86 头，17 个 GitHub 拼包族 `firmwarePlanFor` 全 `ok`。
- 新增用例覆盖：缺哈希拒绝、非法哈希、direct/mirror 覆盖、下载内容哈希不符删 `.part` 不解压、缓存体量够但哈希不符保留原文件并重下；固件侧覆盖归档单源、每族 archive/core pin 非空、假 fetch 通过哈希闸。

### 五、教训

- **`latest` 不是版本**：MSYS2 的 `releases/latest/download` 指向 nightly，文件名里写着 latest 的东西不能进「可复核安装」链路。
- **哈希要绑到具体 URL 形态**：同一 commit 的 codeload 与 api tarball 字节不同；先砍掉多余链路，再谈一个哈希。
- **族间清单不能照抄**：F7 没有 cachel1_armv7.h，照 H7 抄会让整个拼包 404；这类差异要靠实测 URL/文件，不靠「都是 CM7」推断。
- **校验点要贴着执行点**：下载后校验只证明「下载那一刻是对的」；解压/执行前再算一次，才覆盖缓存被替换的窗口。

## §91 P1/P2 加固：流式校验、原子固件安装、doctor 能力诚实化（2026-11）

用户 m06797 要求把供应链审计剩下的 P1/P2 一次做完。P0（MSYS2 固定版本 + 固件归档哈希）已在 §90 收口；这一节处理的是「哈希对了之后，内存、落盘、并发和诊断仍然会说假话」的部分。

### 一、官方 zip：不再把 388 MB 整包读进内存

- 原实现 `verifyZipCrc(file)` 用 `readFileSync(file)` 读整个 WBA 官方包（388,603,994 B），再在 Buffer 里找 EOCD、解析中央目录、逐条 inflate。峰值内存 = 压缩包 + 单条解压，CI 和低内存机器都容易被打爆。
- 改为 `openSync` + 定位读：只读尾部最多 65,558 B 找 EOCD，按 EOCD 的 `cdSize` 读中央目录，再按每条本地头 + `compressedSize` 读该条压缩数据；`inflateRawSync(raw, { maxOutputLength: ZIP_MAX_ENTRY_BYTES })`（256 MB）限制单条炸弹。校验 `cdOffset + cdSize <= size`、本地头/数据不越界，`finally` 关闭 fd。
- 内存峰值从「整包大小」降到「最大单条」，API 仍是同步函数，调用点与测试不用改。
- 教训：**流式不等于异步**。只要按偏移读，同步 API 也能把峰值压到单条；先改 IO 形态，再谈要不要改调用约定。

### 二、tar：先限流再解压，并补流式解包

- 同步 `extractTarGz` 原来先 `gunzipSync(archive)` 全量解压，再在 planned 累加时检查 `maxBytes`——压缩炸弹在检查之前就已经把内存吃掉了。现在 `gunzipSync(archive, { maxOutputLength: maxBytes + TAR_OVERHEAD_ALLOWANCE })`，超限返回「解包后超过 N MiB，已中止（防止压缩炸弹）」。64 MiB 的 allowance 只给 tar 头/对齐，不给文件内容。
- 固件安装改走新的 `extractTarGzFile(archivePath, destRoot, options)`：`createReadStream → createGunzip → Transform` 计数，超过 `maxBytes` 立刻 `callback(Error("TAR_TOO_LARGE"))`；解出的 tar 落到 `mkdtemp(tmpdir()/dsh-tar-)` 临时文件，第一遍只读头/扩展头记录 `{ mapped, offset, bytes }`，第二遍按 1 MiB 分块 `readSync/writeSync` 落盘。路径安全、pax x/g、GNU L/K、`stripComponents`、`mapPath`、`maxBytes` 语义与同步版一致，`finally` 删临时目录。
- 为什么还要临时 tar：tar 的扩展头可能出现在文件数据之前，必须先完整走一遍头才能知道每个文件从哪开始；把解压流先落成临时 tar，第二遍就能随机读写，不必把全部文件内容留在内存里。
- 新增 `test/tar-units.test.mjs` 4 条：正常解包 + map、可疑路径整次失败且目标目录不存在、解压阶段就卡上限、截断失败。已登记进 `test/run-units.mjs`。

### 三、固件安装：锁 + 暂存 + 原子换入

- 原来 `installFirmware` 先 `mkdirSync(decision.dir)`，再直接 `extractTarGz(buffer, decision.dir)`，最后 `verifyFirmwarePackage(decision.dir)`。中途失败会留下半截包；两个进程同时装会互相覆盖；旧包也会在验证前就被新文件污染。
- 现在：
  1. `acquireInstallLock(dir)` 在 `<dir>.dsh-install.lock` 上用 `openSync(..., "wx")` 写 `{ pid, startedAt }`；`EEXIST` 时读 pid，`process.kill(pid, 0)` 判活，`ESRCH` 或超过 6 小时按陈旧锁删除重试；活锁直接返回「另一个进程正在装同一个固件包（pid N）」。
  2. 下载归档到 `parent/.dsh-download-<pid>-<ts>`，内核头与解包内容进 `tempDir/package`（staging）；`package.xml` / `NOTICES` 也写在 staging。
  3. staging 通过 `verifyFirmwarePackage` 后，旧目录 rename 成 `.dsh-replaced-<pid>-<ts>`，staging rename 成正式目录；换入后再验一次，失败删新目录并还原旧目录；成功后删备份。`finally` 删临时目录并释放锁。
- 结果：失败不动旧包、不留半截包；成功是整目录替换，旧 `stale.txt` 不会残留。`test/firmware-units.test.mjs` 新增 3 条（失败保留旧目录、成功整目录替换、活锁不联网直接拒绝），套件 50 pass。
- 教训：**「先写目标目录再校验」无法靠 finally 补救**。回滚能力来自「旧目录还在 + 新目录可丢弃」，所以必须先 staging 再 rename。

### 四、下载文案与系统程序路径

- `stm32_download` 在 `expectedSha256 === ""` 时 `verified` 本来就是 `false`，文案却写「安装包校验完成」。改为：有哈希时「安装包校验完成（SHA256 与官方值一致）」；没有官方哈希时「安装包已检查（无官方哈希可对比，verified=false）」。**字段和文案必须说同一件事**。
- `systemExe(name)` 在 Windows 上固定解析 `%SystemRoot%/System32/<name>`（找不到也返回绝对路径，不退回裸名字），`cmd.exe` / `reg.exe` / `curl.exe` 三处调用改用它。原先裸命令会先命中当前目录或用户 PATH 上的同名 exe，属于典型的二进制劫持面。
- `openOfficialPage` 原来 `spawn` 完立即 `return true`；改为 `Promise<boolean>`，绝对 `System32/cmd.exe`，等 `exit code === 0`，`error` / 3 秒超时都返回 false。虽然 `cmd /c start` 退出 0 仍不能 100% 证明浏览器真的打开了页面，但至少不再把「进程都没起来」报成「已打开」。
- MSYS2 写用户 PATH 成功后，`broadcastPathEntry(entry)` 把新条目补进当前进程的 `process.env.PATH/Path`（去重）。此前只写注册表，当前 dsh 进程仍看不到新工具，用户必须重启。

### 五、doctor：四项能力拆开，按实见探针说真话

- `Capabilities` 仍是 build / flash / debug / generate，但新增 `flashOpenocd` / `flashCubeProgrammer` / `debugOpenocd`：
  - `flash = openocd || cubeprogrammer`
  - `debug = openocd && gdb`
- `probe.ts` 里 gdb / openocd 不再 `required: true`：只编译、只烧录的用户不该被「缺 gdb」拦下；缺失由 `recommendationsOf` 按能力说明影响。
- 只有 CubeProgrammer 时，推荐语明确写「只能走 CubeProgrammer（仅 ST-LINK，不能调试）」，不再笼统说「烧录还缺 openocd」。
- 新增 `openocdTargetProblem(openocdPath, chooseOpenocdTarget(familyProfileOf(cpn)))`：优先看绝对 target 是否存在；相对 target 从 openocd 可执行文件的 `../share/openocd/scripts`、`../../share/openocd/scripts`、`./scripts` 找 scripts 根，再查 `target/<cfg>`。找不到 scripts 根时返回空（未知，不误报）；确实缺 target 时，有 CubeProgrammer 记 note，否则 blocker。
- USB 正常时列出实见探针类型；J-Link 驱动错误时明确写「必须装 SEGGER USB 驱动，只装 OpenOCD 不够」。
- 自动发现 `looksLikeBinDir` 从 gcc/openocd/cmake 扩到 `arm-none-eabi-gcc` / `arm-none-eabi-gdb` / `gdb-multiarch` / `openocd` / `cmake` / `ninja`，只补了 gdb 或 ninja 的 MSYS2 目录不再漏掉。
- J-Link 仍只有一条官方 8.18.0 直链；新增 `DSH_STM32_JLINK_URL` + `DSH_STM32_JLINK_SHA256` 成对覆盖，缺哈希或非法哈希直接回官方源，不引入不可校验镜像。

### 六、验证

- `npm run build` exit 0。
- 全量 `node test/run-units.mjs`：**947 pass / 0 fail**（60 个套件；新增 tar 套件）。
- `npm run test:pack` 全部通过；`npm run test:size` 包体 1825.2 KB / 272 文件 / 解包 15181.3 KB（上限 3906.3 KB）。
- 新增/更新用例：tar 4 条、固件原子安装与锁 3 条、J-Link 镜像成对覆盖 1 条、gdb/ninja 自动发现断言、schema-guard 的 CubeProgrammer-only 能力矩阵。`install-units` 29 pass（reg.exe 改为绝对路径后，测试匹配器同步改成「reg.exe + 动作」）。
- 真机 C031F6P6 与真串口仍未验（没有探针/串口设备）；J-Link 驱动、CubeProgrammer 烧录、ST 官网下载均未在真机复核。

### 七、教训

- **内存峰值要按「最大单条」设计，不是「平均文件」**：388 MB 的包能过测试，不代表 1 GB 的包能过；先改 IO 形态最省事。
- **原子性靠 staging + rename，不靠 finally**：finally 只能清理，不能把已经写坏的旧包变回来。
- **能力矩阵要能表达「能烧但不能调」**：一个布尔 `flash` 会把 CubeProgrammer 和 OpenOCD 混为一谈，最终给出错误建议。
- **诊断里的「成功」必须来自被诊断对象**：spawn 成功、文件存在、进程退出 0，都不是「页面已打开」或「驱动已装好」。
>>>>>>> d96f2b24bdf2dee59184b40080ff2357b790ff3c

## §92 调试台：事件总线、SSE 与停靠网格（2026-11，S1–S97）

### 一、目标与约束

需求是给插件一个与「对话 / 上下文 / 编队」并列的主窗口标签，用于人机联调：模型做了什么、参数与结果是什么、串口与 RTT 输出长什么样，都能在同一屏看到，并且能贴回对话里引用。

约束（用户拍板）：

- 内存环形缓冲保留 5000 条；超出的每 30 秒落一批 log；证据目录每会话一个。
- 先做停靠网格（拖分隔条、收起到抽屉），自由浮动留到后续阶段。
- 版本号不变（仍 0.1.7），不新建 release notes。

### 二、实现

事件链路（服务端）：

- `src/engine/event-bus.ts`：纯内存、无定时器。`EVENT_RING_LIMIT = 5000`、`EVENT_PAYLOAD_LIMIT = 8192`、`EVENT_PENDING_LIMIT = 2000`。`emitEvent()` 分配单调 `seq` 与 ISO 毫秒时间；payload 超限截成 `{preview}` 并置 `truncated`；环形挤出的事件进待落盘队列，队列再满则计入缺口计数。导出 `subscribeEvents` / `eventSnapshot(since)` / `drainEvicted` / `requeueEvicted` / `takeDroppedCount` / `setEventSessionKey` / `resetEventBus`。
- `src/engine/event-log.ts`：`EVENT_LOG_INTERVAL_MS = 30_000`，`evidenceRoot()` 默认 `~/.dsh-stm32/evidence`（`DSH_STM32_EVIDENCE` 可覆盖），目录为 `<root>/<yyyy-mm-dd>/<会话键>/events-<HHmmss>.jsonl`；`safeSessionKey()` 把非 `[A-Za-z0-9._-]` 归一成 `-`。有缺口时先写一条 `kind:"log" status:"fail"` 的缺口事件，避免证据看起来连续；写失败把本批放回队列。
- `src/engine/tool-events.ts`：装配期给 ctx 套 Proxy，只替换 `tools.register`，给 25 个 `stm32_*` 工具包一层 start / ok / fail；其余属性绑定到真实 ctx 转发，避免破坏 cordis 的 this 语义。名字不以 `stm32_` 开头的工具原样注册。
- `src/engine/channels.ts`：串口 / RTT / 监视输出编成 `kind: "channel:<名字>"` 的事件，单行截 400 字符、单次最多 400 行（`CHANNEL_LINE_LIMIT`），摘要写「串口 12 行」，超限标注「面板保留前 N 行」。
- `GET /dsh-stm32/api/events`：SSE。先补发 `?since=` 之后的存量，再推增量；15 秒心跳（`x-accel-buffering: no`），请求断开时清理订阅。路由在 `registerWebRoutes` 里特殊处理，不进 JSON 分发器。
- `GET /dsh-stm32/api/status`：只读诊断，返回 `eventCount` / `latestSeq` / `sessionKey` / `evidenceRoot` / `ringLimit` / `evidenceOverride`。

客户端（`client/client.js`，仍手写纯 JS，`scripts/copy-client.mjs` 原样复制）：

- 注册 `conversation.view`：`id: "stm32-debug"`、`order: 40`、`label: () => "调试台"`。
- 停靠网格：左时间线（按 seq 增量续播、断线 1.5 s 重连并从 lastSeq 续上）、中事件详情（payload 与 refs，带「复制引用」生成 `[调试台事件 #seq] kind status：summary`）、右实时通道（串口 / RTT / 监视各自尾部 400 行，可暂停、清空）、底部控制台（最近 400 行）。分隔条拖动改宽、双击复位，面板可收进抽屉，宽度与收起状态存 `localStorage["dsh-stm32.debug.layout.v1"]`。
- 状态条：连接状态、事件数、最新 seq、证据目录（悬停显示完整路径与是否被环境变量覆盖）。

### 三、验证

- `npm run typecheck` / `npm run build` exit 0。
- `node test/run-units.mjs` **951 pass / 0 fail**（64 个套件）。新增 `test/event-bus-units.test.mjs`（环形上限、payload 截断、待落盘队列与缺口、订阅与注销、证据目录布局、落盘内容与缺口首行、工具埋点 start/ok/fail、SSE 补发与断开、通道归一）与 `test/client-debug-units.test.mjs`（桩 React 下两个槽位注册、调试台可渲染）。
- 真 HTTP 探针：用 `http.createServer` + `openEventStream` 起临时服务，curl 收到 `: connected`、两条存量事件（`id:` 与 data 对应）与 `: ping` 心跳。
- `npm run test:pack` 全部通过；`npm run test:size` 1854.2 KB / 276 文件 / 解包 15261.3 KB（上限 3906.3 KB）。
- 未验：真机窗口里的标签与硬件通道——需要重启 DSH，由用户侧完成。

### 四、已知限制与后续

- 通道输出默认仍是「一次工具调用一批」；常驻 RTT / 串口流已在 S7 补上（见「九、常驻通道」），但默认关、需在面板打开，且只在有串口会话 / RTT 通道时才有增量。
- 证据目录的会话键取工具调用的 `agent.id`；面板自身 sessionId 的按会话过滤已在 S5 补上（见「七、会话绑定」），两者是同一个串时行为一致。
- 「人 → AI」的复制引用与「AI → 人」的进度/中止均已可用（S6）；中止只覆盖 `stm32_*` 工具调用，不碰后台 job。

### 五、调试会话卡与监视历史曲线（S3）

- `GET /dsh-stm32/api/debug`：只读 `debugSessions.status()`，返回 `active` / `sessionId` / `port` / `tclPort` / 工程与符号路径 / 剩余租约 / 断点与观察点配额 / 说明文本。GET-only，POST 返回 405；不触发任何探针动作。
- 客户端右侧「实时通道」顶部加会话卡（5 秒轮询），下方加监视曲线：`channel:watch` 事件的 `payload.meta.samples` 带结构化样本（`expression` / `value` / `delta` / `ok`），面板按表达式分桶、只取数值、每条保留最近 120 点，画折线并给出当前值、点数与最小最大值。
- 为什么曲线不服务端存：曲线只服务面板显示，事件流已是唯一事实源；再存一份会与环形缓冲的淘汰策略打架，还会让「重连续播」出现两条时间轴。
- 测试：`web-api-units` 加 `/debug`（空闲摘要与 405）、`event-bus-units` 加监视结构化样本、`client-debug-units` 的桩渲染补上 `props.children`（真 React 会塞，桩原来把它留在 `node.children`，导致面板正文不可见）。
- 计数更新：64 套件 / 952 pass；`client/client.js` 1484 行；包体 1858.5 KB / 276 文件 / 解包 15277.6 KB。

### 六、断点面板（S4）

- `POST /dsh-stm32/api/debug/breakpoints`：只放行 `add` / `remove` / `list` 三种动作；`location` 只接受符号名或 `文件:行`（字母、数字与 `. _ : $ * / + -`，长度 1–120），`id` 只接受 1–9999 的整数。参数先校验、再看会话：参数错回 400，没有会话回 409。
- 执行统一走 `debugSessions.eval({ commands: [...], keepHalted: true })`：`break` / `watch` 在 eval 内部已有硬件比较器预算检查，面板不另算一套。
- 客户端断点块：列出、按位置添加、按编号移除，gdb 原文直接展示；会话卡与断点块共用同一次 5 秒轮询，动作完成立即刷新。
- 为什么不开放任意 gdb 命令：面板走本机 HTTP，只要能拼命令就等于把调试器交给任何能访问该端口的东西。三种动作加位置白名单已覆盖联调需要，剩下的交给 `stm32_debug_eval` 工具。
- 计数：64 套件 / 953 pass；`client/client.js` 1565 行；包体 1860.6 KB / 276 文件 / 解包 15286.6 KB。

### 七、会话绑定（S5）

- 事件带 `session`：工具埋点写 `ctx.tools` 执行时的 `agent.id`，面板写宿主 `conversation.view` 的 `inject(sessionId)` 拿到的 session id；两者本来就是同一个串（真机 `GET /status` 已复核），这里把它显式化，多标签页同时开着时各看各的。
- `eventSnapshot(since, session?)` 与 `eventCount(session?)` 按会话过滤，空串表示不过滤——单会话时不传也能用，回归测试与诊断脚本不必关心绑定。
- SSE：`openEventStream({ since, session })` 先按会话补发存量，再在订阅回调里丢弃别的会话的增量；`/dsh-stm32/api/events?since=N&session=<键>` 由 `web-routes` 从 query 透传。
- `/dsh-stm32/api/status?session=<键>`：计数与 `latestSeq` 只算本会话，`sessionKey` 回显请求的会话；不带参数时回显当前绑定键，行为与 S1 一致。
- 客户端：`debugEventsPath(lastSeq, sessionId)` 拼 `&session=`；`useDebugEvents(sessionId)` 与状态轮询的依赖都换成 `[sessionId]`，切标签页即重新订阅、重新计数；注册对象加 `inject: (sessionId) => ({ sessionId })`。
- 为什么不改协议头：面板走同源 fetch/EventSource，query 是最小改动面，也方便用 curl 复现与验收。
- 计数：64 套件 / **956 pass / 0 fail**；`client/client.js` 1574 行；包体 1861.9 KB / 276 文件 / 解包 15290.4 KB。

### 八、在途调用与中止（S6）

- 登记表 `src/engine/progress.ts`：`beginToolCall({ name, session, outer })` 生成 `call-<n>` 与一个**派生** AbortController，`listRunning(session?)` / `abortCall(id)` / `abortAll(session?)` / `resetRunning()`。
- 为什么不直接 abort 宿主的 `exec.signal`：那个 signal 归调用方所有，插件从内部掐它会污染宿主的超时与取消语义。派生一支、把宿主的 abort 转发进来，面板只掐自己这一支；工具本来就把 `exec.signal` 透传给子进程，所以中止会一路到 cmake / openocd / gdb。
- 进度：`handle.update(phase)` 发 `kind:"progress"` 事件（同一阶段连报只发一条），摘要 `工具名：阶段`，payload 带 `callId` / `tool` / `phase`。
- 配对：start / ok / fail 的 payload 都带 `callId`；面板因此**不需要轮询**就能从事件流算出「谁还在跑」——start 出现过而 ok/fail 未出现即在途，progress 只更新阶段。
- 接口：`POST /dsh-stm32/api/abort`，只认登记过的调用（缺 `callId` 又没 `all:true` 返回 400，找不到返回 404），返回 `{ abort: { count, calls } }`；`GET /status` 增 `running`，同样按 `?session=` 过滤。
- 面板：右侧通道顶部「在途调用」块，显示 callId、工具名、已跑秒数、阶段与「中止」按钮；没有在途时写明「当前没有在途的工具调用。」。
- 边界：只覆盖走本插件 `instrumentContext` 的 `stm32_*` 工具；后台 job 与调试会话另有自己的租约与关闭路径，不在这里中止。
- 计数：65 套件 / **963 pass / 0 fail**；`client/client.js` 1652 行；包体 1865.3 KB / 277 文件 / 解包 15301.9 KB。

### 九、常驻通道（S7）

- 问题：S1–S6 的通道是「一次工具调用一批」。`stm32_serial read` 之后的输出、`stm32_rtt follow` 之后的记录，只要模型不再调用就看不着，面板会停在最后一批。
- 做法：服务端定时取增量，按同一套事件流写 `channel:serial` / `channel:rtt`，面板不新增取数路径。
  - `src/engine/channel-tap.ts`：串口 700 ms 一拍、RTT 2 000 ms 一拍，每拍最多 200 行 / 200 条记录；两个开关默认关，`setChannelTaps({ serial?, rtt? })` 改状态，`channelTapStatus()` 给面板读，`stopChannelTaps()` 在 `session/disposed` 与 `dispose` 里调用。
  - 串口增量读的是桥自己的 `rx.ndjson`：维护读取偏移与未换行的物理半行；偏移越界或**尾部指纹对不上**就从头读（桥重开文件时长度可能不变，只看长度会静默错位）。
  - 桥把残行标成 `p: true`（`d` 只是这一段的片段），所以逻辑行要跨记录拼接：`p:true` 先并进 `lineCarry`，下一条非 `p` 记录拼完整再发。
  - RTT 走已有的 `dumpRtt({ seconds: 0.5, maxRecords: 200 })`，只取 `records`，不新起探针会话；`busy` 标志防上一拍未完成就叠下一拍。
- 接口：`GET /dsh-stm32/api/channels` 返回两个通道的 `{ active, lines, lastAt, lastError }`；`POST /channels/start` 与 `/channels/stop` 只认 `serial` / `rtt` 两个布尔开关（非布尔 400），不传则两个一起动。
- 面板：每个通道块头部显示「常驻开 N 行 / 常驻关」，旁边「开常驻 / 停常驻」按钮，3 秒轮询状态；开关不写 localStorage——它对应真实的定时任务，重启后应回到关闭。
- 为什么常驻不默认开：定时读串口文件与 RTT 通道都有成本，且 RTT 的 `dump` 会占用探针；由使用者按需打开，误开时一眼能看到状态与最近错误。
- 计数：66 套件 / **967 pass / 0 fail**；`client/client.js` 1706 行；包体 1869.4 KB / 278 文件 / 解包 15315.6 KB。

### 十、工作区标签与引脚面板（S8）

- 问题：右列从 S3 起堆了会话卡、在途调用、断点、曲线、三个通道，全挤在一屏；引脚这类「看一眼就知道」的信息没有位置，模型也只能靠 `stm32_ioc_inspect` 打一大段文本。
- 做法：右列顶部加标签条（「实时通道」/「引脚」），两个标签各自整块呈现，不共用一个滚动容器；通道页内容与 S7 完全一致，引脚页是新面板。
  - 服务端 `src/engine/pinout.ts`：`readPinout(projectDir)` 找工程里第一个可读的 `.ioc`（与断点预算的 `readIocCpn` 同一套挑选规则），复用 `summarizeIoc` 解析，不另写一套解析器；返回芯片、时钟（SYSCLK/APB1/APB2）、中断数、告警、全部引脚，以及按外设分组的 `groups`。
  - 分组规则 `groupOfPin`：`kind` 为 debug/clock/virtual 的分别归「调试口 / 时钟 / 虚拟引脚」；其余按信号里的实例名归组（`USART1_TX` → USART1、`S_TIM2_CH1_ETR` → TIM2、`ADC1_IN1` → ADC1）；没有实例名的归 GPIO。`groupPins` 让外设组按名字自然序在前（USART2 在 USART10 前），固定类别按 GPIO → 调试口 → 时钟 → 虚拟引脚 排在最后。
  - 接口：`GET /dsh-stm32/api/pinout?projectDir=<绝对路径>`；不传 `projectDir` 时用 `process.cwd()`；没有 `.ioc`、目录不存在、读失败都回 409 并带上具体原因，面板原样显示。
  - 面板 `PinoutPanel`：工程目录取 `/debug` 的 `projectDir`（没有会话时为空，显示「当前没有可用的工程目录」），切到引脚页才拉取，之后 10 秒刷新；每行显示引脚名、标签 / 模式 / 信号、类别与锁定标记；顶部一行汇总型号、三路时钟、中断数与 SWD 状态，告警最多列三条。
- 为什么引脚页不常驻轮询：`.ioc` 只在模型改配置时才变，10 秒足够；通道页仍按事件流实时推送，两者取数路径不同，不该互相拖慢。
- 计数：67 套件 / **973 pass / 0 fail**；`client/client.js` 1852 行；包体 1873.9 KB / 279 文件 / 解包 15333.3 KB。

### 十一、时钟页（S9）

- 问题：引脚页给了「哪个脚配成什么」，但没有「各总线跑多快」。调试串口波特率误差、定时器周期、ADC 超频这些问题，第一眼要看的就是 PCLK1 / PCLK2 与它们的定时器倍频。
- 做法：又一个只读页，数据全部来自 `.ioc` 里 CubeMX 自己写下的 `RCC.*Freq_Value` 键。
  - `src/engine/clocks.ts`：`readClockTree(projectDir)` 复用 `parseIocEntries` 与 `findIocPath`，按固定顺序列出 SYSCLK / HCLK / PCLK1 / PCLK2 / TIM(APB1) / TIM(APB2) / Cortex / ADC / USB / SysTick / MCO 十一路，外加其它 `RCC.*Freq*` 键。
  - **不自己复算频率**：插件算 PLL 与总线分频很容易和 CubeMX 的取整口径差一档，面板一旦显示「72 MHz」而 CubeMX 认为是 71.9，排查就会跑偏。宁可显示 CubeMX 的原值，缺键就写 —。
  - 分频与倍频只做展示翻译：`RCC_HCLK_DIV2` → `÷2`、`RCC_PLL_MUL9` → `×9`；系统时钟源与 PLL 源同样翻成 HSI/HSE/PLL 一类的短名，认不出就原样显示。
  - 接口：`GET /dsh-stm32/api/clocks?projectDir=<绝对路径>`，缺 `.ioc` 回 409；面板 `ClockPanel` 每 10 秒刷新，横向比例条按最高频归一（线性，不用对数——分频是整数倍，线性更直观）。
- 计数：68 套件 / **979 pass / 0 fail**；`client/client.js` 1957 行；包体 1877.1 KB / 280 文件 / 解包 15347.8 KB。

### 十二、故障页（S10）

- 问题：失败事件混在时间线里，原文往往只有一句英文报错（`unable to find a matching CMSIS-DAP device`），看的人得先知道这句话意味着查 USB 还是查接线。
- 做法：把已知失败特征翻成「先看哪里」，纯规则表，不做通用日志理解。
  - `src/engine/fault-hints.ts`：`decodeFault(text)` 返回 `{ category, hint, rule }`；规则按「最具体在前」排列——`cmsis-dap` 规则排在泛化的 `openocd init failed` 之前，避免泛词盖住精确提示。未命中返回 `rule:"none"`、`hint:""`，面板只显示原文，不臆造原因。
  - 分类：probe（探针）、target（目标芯片）、build（编译链接）、flash（烧录校验）、toolchain（命令缺失）、network（下载）、debug（会话）、tool（文件与权限）、other。
  - 接口：`GET /dsh-stm32/api/faults?session=<键>&since=N&limit=50`，只取 `status === "fail"` 的事件，`total` 给全量条数、`faults` 给最近 `limit` 条的解码结果（上限 200）。
  - 面板：故障标签按倒序列出 `#seq / 工具名 / 分类 / 原文 / 先看：…`，5 秒轮询；没有失败时写明「本会话还没有失败事件。」。
- 为什么解码放在服务端：同一套规则要给命令行、验收脚本与面板共用；放在客户端会导致 curl 验收看不到提示。
- 计数：69 套件 / **985 pass / 0 fail**；`client/client.js` 2033 行；包体 1880.7 KB / 281 文件 / 解包 15360.2 KB。

### 十三、产物与内存（S11）

- 问题：烧完最常问的是「现在 Flash / RAM 还剩多少、刚才烧的是哪个文件」，这两件事原本分散在一次构建输出与文件管理器里。
- 做法：只读文件属性与芯片容量，不额外起 `size` / `objdump` 进程。
  - `src/engine/artifacts.ts`：`readArtifacts(projectDir)` 用 `detectBuildDir` → `findElf` 取 elf，同名兄弟文件取 `.hex` / `.bin`，`readIocCpn` + `findChipFact` 取 `flashBytes` / `ramBytes`；`notes` 覆盖「没有构建目录 / 多个 elf / 资源包没有该芯片 / 没有 .ioc 型号」。
  - 内存占用来历：`stm32_build` 已带 `--print-memory-usage`，`tool-events` 的 `resultDigest` 白名单加上 `memoryUsage` / `warningCount`，面板直接从 `stm32_build` 的 ok 事件里取。同一份数字只有一个来源，不会出现「面板算的和构建打印的不一致」。
  - 接口：`GET /dsh-stm32/api/artifacts?projectDir=…`，返回 `{ artifacts: { buildDir, elf, hex, bin, otherElves, chip, notes } }`，10 秒轮询。
  - 面板：产物标签显示构建目录、ELF/HEX/BIN（文件名、大小、修改时间）、芯片容量一行、最近一次构建的 Flash/RAM 比例条；没有构建记录时提示先跑 `stm32_build`。
- 边界：多 elf 时只展示一个，并在 notes 里说明挑法，避免把旧固件当成刚烧进去的那份。
- 计数：70 套件 / **991 pass / 0 fail**；`client/client.js` 2181 行；包体 1884.2 KB / 282 文件 / 解包 15377.2 KB。

### 十四、概览页（S12）

- 问题：引脚、时钟、产物、会话分散在四个标签里，联调开始时要点四次才能回答「这块板现在是什么状态」。
- 做法：纯客户端拼装，不新增接口——`OverviewPanel` 复用 `usePinout` / `useClockTree` / `useArtifacts` / `useDebugStatus`，再加事件流里的两条时间戳（最后一次 `stm32_build`、`stm32_flash` 的成功事件）。
  - 一屏八行：工程目录、型号与封装、SYSCLK、容 Flash/RAM、会话（进行中带剩余租约或空闲）、上次构建、上次烧录、失败事件数。
  - Flash/RAM 比例条复用产物页的 `MemoryBar` 与 `collectMemoryUsage`，同一份 `memoryUsage`、同一种画法。
- 为什么不新建 `/overview`：四份数据各自已有轮询与错误处理，服务端再拼一次等于把同一批读取写两遍，且面板的刷新节奏会被迫统一成最慢的那个。
- 边界：概览只做「现在是什么」，不做趋势；历史看时间线，失败看故障页。
- 计数：70 套件 / **991 pass / 0 fail**；`client/client.js` 2244 行；包体 1885.5 KB / 282 文件 / 解包 15383.9 KB。

### 十五、证据回放（S13）

- 问题：证据文件只在溢出时落盘，没人读得出来；复盘还是得靠对话记录猜当时做了什么。
- 做法：两条只读路由 + 面板入口。
  - `GET /evidence`：列证据目录下的 `.jsonl`，按修改时间倒序，最多 200 条；只下探「日期 / 会话 / 文件」三层，目录读不到就跳过，不抛错。
  - `GET /replay?path=`：相对路径经 `resolve` 钉在证据目录内，绝对路径、`..` 与非 `.jsonl` 一律 400；单文件上限 8 MB（超出 413）；逐行 `JSON.parse`，只收 `seq/time/kind/status/summary` 齐全的事件，坏行计入 `skipped`；载入上限 5000 条，按 `seq` 升序。
  - 面板：时间线工具栏「回放…」打开选择器，点一个文件即载入；回放期间时间线与详情只读这份数据，顶部横幅写明文件名、条数与跳过数，实时事件暂停显示，再点「退出回放」恢复。
- 为什么不混流：把历史事件插进实时序列会让 `seq` 与时间的单调性失效，筛选与详情定位都会乱；分成两个数据源、一个当前视图更简单。
- 教训：目录遍历的深度守卫按「要读文件的目录」算，不按「目录本身」算——先写成 `depth > 2` 时恰好停在会话目录外一层，列表恒为空。
- 计数：70 套件 / **992 pass / 0 fail**；`client/client.js` 2341 行；包体 1888.5 KB / 282 文件 / 解包 15397.9 KB。

### 十六、变更页（S14）

- 问题：改完 .ioc 再生成代码，外设与引脚会变，但没有「和上次比」的入口；git 未必可用，工程也可能不是自己的。
- 做法：基线单独存，不依赖版本库。
  - `src/engine/ioc-diff.ts`：`parseIocEntries` 收 `key=value`（跳过注释、空行、无等号行，重复键取第一次）；`diffIocEntries` 分新增 / 删除 / 改动三表并按 key 排序；`snapshotPath` 用工程绝对路径的 sha256 前 16 位命名，目录默认 `~/.dsh-stm32/ioc-snapshots`，可用 `DSH_STM32_SNAPSHOTS` 覆盖。
  - `POST /ioc-diff/save` 复制当前 .ioc 覆盖基线；`GET /ioc-diff?projectDir=` 返回 `{hasSnapshot,savedAt,added,removed,changed,counts,notes}`，没有基线时 `hasSnapshot=false` 并在 notes 里提示。
  - 面板「变更」标签：头部给基线时间与三类计数，「记下当前配置」重新记基线；三张表分别用 `+` / `-` / `~` 前缀。
- 语义边界：基线只有一份，覆盖式保存、不留历史；比较的是配置键，不是工程产物；.ioc 由 CubeMX 重写时注释行与键序变化不会算作差异（解析只认键值）。
- 测试：`test/ioc-diff-units.test.mjs` 4 条 + `/ioc-diff` 路由用例 + 验收里「记基线 → 改文件 → 比出新增与删除」。
- 教训：验收脚本要连同子目录一起隔离——首版只把 `DSH_STM32_EVIDENCE` 指到临时目录，基线仍写进用户主目录，靠 `DSH_STM32_SNAPSHOTS` 补上。
- 计数：71 套件 / **997 pass / 0 fail**；`client/client.js` 2420 行；包体 1892.0 KB / 283 文件 / 解包 15413.8 KB。

### 十七、状态筛选与导出（S15）

- 问题：联调时最想看的只有失败事件，但时间线按 seq 铺开，失败混在几十条成功里；复盘要把现场带走，只有「复制一条」不够。
- 做法（纯客户端，无新接口）：
  - 工具栏加状态筛选：默认「全部事件」，点一下变「只看失败」，与文字筛选叠加（先按状态过滤，再按 `kind + summary` 匹配）。
  - 「导出 JSONL」把当前视图（已过滤）序列化成与证据文件同一种形状，文件名 `stm32-debug-<ISO 时间>.jsonl`，用 `Blob` + 临时 `<a download>` 触发，1 秒后 `revokeObjectURL`。
- 为什么导出走客户端：环形缓冲的内容已经在面板里，服务端再拼一次只会多一条「要不要给全部会话导出」的分支；证据目录里的文件本来也可用 `/replay` 载回。
- 边界：导出的是视图，不是落盘历史；回放期间导出的是回放数据，实时事件不混入。
- 计数：71 套件 / **997 pass / 0 fail**；`client/client.js` 2445 行；包体 1892.9 KB / 283 文件 / 解包 15416.5 KB。

### 十八、断点命中历史（S16）

- 问题：断点停住后，`continue` 的返回只是一次性文本，下一次 eval 就覆盖了；「刚才是谁命中的、命中几次」没有地方看。
- 做法：在会话里攒一份短历史，不与 gdb 进程生命周期绑死。
  - `src/engine/breakpoint-hits.ts`：`parseStops(output)` 认三种停点描述——`Breakpoint N, …`、`Hardware/Software watchpoint N: …`（连带后两行 `Old value` / `New value` 拼成一条）、`continue：已停下 —— …`（去掉末尾 resume 提示，记 id 0）；`HitHistory` 环形 50 条，`record(output, nowMs)` 返回新增条数。
  - `DebugSessionManager` 在 eval 的两条返回路径（常驻 MI / gdb -batch）都调 `this.hits.record(...)`；`hitHistory()` 给面板；`stop()` 与 `resetForTest()` 清空——会话关了，gdb 里的断点也不存在了，历史留着会误导。
  - `/debug` 响应加 `hits`，面板「断点」卡片底部按时间倒序列出 `#编号 描述`，空态提示「跑一次 continue / next 后这里会出现停在哪」。
- 为什么不订阅 MI 的 `*stopped`：两条执行路径的产物形状不同，订阅只能覆盖 MI 一路；统一在输出的文本层解析，命令行与面板拿到的是同一份记录。
- 边界：只记 gdb 输出里出现的停点，后台悄悄命中（目标在跑时）不会被记录；id 0 表示输出里没有编号。
- 计数：72 套件 / **1000 pass / 0 fail**；`client/client.js` 2460 行；包体 1894.8 KB / 284 文件 / 解包 15422.0 KB。

### 十九、监视自动采样（S17）

- 问题：曲线只有「人手点一次 stm32_watch sample」才有新点，想观察计数器怎么走就得一直点。
- 做法：把「什么时候采」交给定时器，采样本身原样复用。
  - `src/engine/watch-recorder.ts`：`createWatchRecorder({sample, emit, now, setTimer?, clearTimer?})`，抽成工厂是为了单测注入假时钟与假定时器，不碰 gdb。间隔夹在 500–60000 ms（默认 2000），一次录制最多 10 分钟；`busy` 保证上一拍没采完不重叠；采到样本才发事件，失败只记 `lastError`、不停表。
  - `src/engine/watch-record.ts`：进程内唯一实例。`sample` 调 `debugSessions.sampleWatches({})`（目标在跑就先拦停、读完按原状态放回），`emit` 走 `emitChannel({channel:"watch", meta:{action:"record", samples}})`——形状与 `stm32_watch` 的 sample 一致，面板的 `collectWatchSeries` 不用改。
  - `GET /watch-recording`、`POST /watch-recording/start`、`POST /watch-recording/stop`：开始只接受 500–60000 的整数毫秒，越界 400；状态含已录样本数、起止时间、剩余时长与最近错误。`src/index.ts` 在 `session/disposed` 与 `dispose` 时复位。
  - 面板：`WatchCurves` 头部「自动采样 / 停止」按钮与状态文字（3 秒轮询），采样结果随事件流回来，不另拉数据。
- 为什么默认关：自动采样会在目标运行时反复拦停它，联调多久就打断多久；这个代价必须由用户显式同意。
- 边界：录制不跨调试会话（会话重建后采样直接失败并记 `lastError`）；10 分钟上限是防忘记关，不是配额。
- 计数：73 套件 / **1006 pass / 0 fail**；`client/client.js` 2520 行；包体 1897.7 KB / 286 文件 / 解包 15433.8 KB。

### 二十、面板发串口（S18）

- 问题：串口面板能看不能发，想回一句得另起 `stm32_serial action=send`；联调时人的一半动作都被迫绕道对话。
- 做法：把「人发一行」做成 HTTP 入口，复用同一条桥命令。
  - `POST /serial/send`：正文 `{text, newline?, raw?}`。`text` 必须是字符串（空串＝只发换行）；`newline` 只认 crlf / lf / none，`raw` 必须是布尔；校验全部走完再调 `sendSerial`。
  - 没有开着的会话返回 409 并带上原来的提示（先 `stm32_serial action=open`），不吞成 500；成功返回 `{bytes, ackMs, message}`，面板直接显示「已发送 N B（M ms）」。
  - 面板 `ChannelBlock` 只在串口那一块渲染输入框，回车或点「发送」；RTT 与监视没有输入框——那两条通道是只读的。
- 为什么不复用 `/abort` 或事件流：发送是同步往返（桥写命令文件、等 done 文件），与事件流的单向推送不同；塞进事件流还得再造一套请求/响应配对。
- 边界：一次一行、受 `SERIAL_LIMITS.textChars` 限制；不带会话 id，只发给当前串口会话（面板本来就只显示当前会话的输出）。
- 计数：73 套件 / **1007 pass / 0 fail**；`client/client.js` 2553 行；包体 1898.9 KB / 286 文件 / 解包 15438.4 KB。

### 二十一、引脚引用复制（S19）

- 问题：联调时人最常说的是「PA9 那个串口」，但面板里的引脚只能看、不能带走；人要把话贴进对话得手抄。
- 做法：点引脚行即复制一条引用文本。
  - `PinRow` 整行可点，`copyPin` 写剪贴板：有信号名时复制 `PA9 USART1_TX`，没有时只复制引脚名；成功后该行尾部显示「已复制」，失败不报错（浏览器不给剪贴板时静默）。
  - 引脚页头部加一句「点行复制引用」，说明这个动作，避免看起来只是装饰。
- 为什么不加成按钮：一行一个按钮会把本来就窄的引脚表挤散；整行点击 + 尾部反馈是零成本交互。
- 边界：只复制「引脚 + 信号」，不带工程路径与时间；要带上下文的引用走事件详情里的「复制引用」。
- 计数：73 套件 / **1007 pass / 0 fail**；`client/client.js` 2566 行；包体 1899.4 KB / 286 文件 / 解包 15439.7 KB。

### 二十二、通道过滤（S20）

- 问题：串口与 RTT 一屏几十行，找一条关键日志只能靠眼睛；RTT 的级别混在一起，error 容易被信息级刷走。
- 做法：在通道块内部做过滤，不改事件也不改服务端。
  - `ChannelBlock` 增「过滤关键字」输入（不区分大小写，作用于当前暂停/清空窗口内的行）与 RTT 专属的级别按钮「全部 / 错误 / 警告 / 信息 / 调试」，级别从行首 `[n]` 前缀解析（与 `src/engine/rtt.ts`、`channel-tap.ts` 写出的格式一致）。
  - 计数显示当前命中数 `命中 / 窗口`，未过滤时仍是总行数；暂停与清空语义不变——过滤只影响显示。
- 为什么不做服务端过滤：通道事件本来就只有几百行，过滤是纯展示问题；放服务端会让「暂停后改过滤」重新拉数据。
- 边界：不跨窗口搜索（清空/暂停之外的行不参与）；级别过滤只对 RTT 通道出现。
- 计数：73 套件 / **1007 pass / 0 fail**；`client/client.js` 2601 行；包体 1900.4 KB / 286 文件 / 解包 15442.9 KB。

### 二十三、会话续期（S21）

- 问题：调试会话有「空闲 90 s 自动关」的租约。用户盯着日志看，面板只是轮询 `/debug`（只读，不续租），十分钟后会话被扫掉，探针被还回去——人什么都没干，会话没了。
- 做法：把已有的 `touch()` 暴露成入口。
  - `DebugSessionManager.touch()` 原本给 regs 快路径用（每次读寄存器算一次「用过」）；这里复用它，语义一致：只重置 `lastUsedAt`，**总时长上限 `startedAt + hardTtlMs` 不动**。
  - `POST /debug/touch`：没有会话 409；有会话返回新的 `/debug` 摘要，面板直接刷新剩余秒数。
  - 会话卡加「续期」按钮，成功显示「已续期，剩余 N s」。
- 为什么不自动续租（面板一开就续）：那等于把空闲租约变成「只要开着面板就永不超时」，探针会被长期占住，VS Code 那边就按不了 F5。续期必须是人按的。
- 边界：只影响空闲计时，不改总上限；会话已经过期时返回 409，不会复活进程。
- 计数：73 套件 / **1008 pass / 0 fail**；`client/client.js` 2628 行；包体 1901.1 KB / 286 文件 / 解包 15445.6 KB。

### 二十四、中断页（S22）

- 问题：知道「中断开着」最快的地方是 .ioc，而打开 CubeMX 只为看一页 NVIC 表，要等图形配置启动程序几十秒。
- 做法：只解析 `.ioc` 的 `NVIC.*` 键。
  - `interruptName("NVIC.USART1_IRQn")` 归一成 `USART1`；`NVIC.ForceEnableDMAVector` 这类只有一段的键不是中断，跳过。
  - 值形如 `true\:2\:0\:false\:false\:true\:false\:false\:false`（**冒号在 .ioc 里是转义的**），先还原再切段：第一段使能，第二段抢占优先级，第三段子优先级。
  - 段数不足时优先级给 -1 而不是 0——0 是合法的最高优先级，不能拿来表示「没写」。
  - 排序按「抢占 → 子 → 名字」，与 CubeMX 的中断表习惯一致，不按字母硬排。
- `GET /dsh-stm32/api/interrupts?projectDir=`：只读，不启动 CubeMX；缺 `.ioc` 或读失败 409。
- 面板：标签条「中断」，头部「<iocName>：使能 N / M 路」，每行名称、抢 N、子 N、开/关；10 秒轮询，与引脚/时钟同口径。
- 边界：只显示「NVIC 里使能了什么」，不推断中断是否真的会触发（那要看外设时钟与优先级分组，属于运行期行为）。

### 二十五、批量勾选引用（S23）

- 问题：单条「复制引用」够用，但排查一次失败常常要带上「构建 → 烧录 → 会话 → 某条 RTT」四五行；逐条复制再拼，容易漏、顺序也乱。
- 做法：纯客户端，不动服务端。
  - 时间线每行左侧一个复选框；勾选集合用数组保存（按勾选先后），复制时按**时间线顺序**重排，读者看到的次序与面板一致。
  - `eventRefLine(event)` 产出一行 `- #seq 时间 kind status：摘要`；`eventRefBlock(events)` 给首行「调试台事件（N 条）：」再接各行，贴进对话就是一段可读的引用块。
  - 工具栏常驻「复制已选（N）」，未勾选时禁用并降透明度；复制成功显示「已复制 N 条引用」，失败说明是权限问题还是环境没有剪贴板接口——不静默。
  - 勾选只影响复制，不改变当前选中事件（右侧详情仍由单击决定），两种状态互不覆盖。
- 边界：只导出当前视图里还存在的序号（回放/筛选切换后，已勾选但不在视图里的事件不参与复制），避免贴出面板上看不到的引用。

### 二十六、概览页的工具链一行（S24）

- 问题：概览页有工程、型号、时钟、产物、会话，却没有「这台机器现在能不能编译/烧录」。排查时最常见的岔路就是工具链缺件，而它藏在上一个「探测工具链」按钮后面。
- 做法：复用已有的 `GET /probe`，纯客户端。
  - `useProbeSummary(60000)` 60 秒一次。探测会真的跑各工具的版本命令，不能和 5 秒的会话状态同频。
  - 一行拼三层信息：`就绪 / 缺 X、Y` · `N/M 项可用` · `编译 ✓ 烧录 ✓ 调试 ✓ 生成 ✗`。缺件时直接列出名字，不去面板里点按钮。
  - `capabilitiesText` 只认 `capabilities` 的四个布尔，不自己按工具名推——能力口径留在服务端 `capabilitiesOf` 一份。
- 边界：概览页不做自动探测之外的任何动作，安装仍在设置页；探测失败（400）时该行显示 `—`，不打断其它行。

### 二十七、事件详情的参数与结果（S25）

- 问题：时间线只显示一条摘要，`payload` 一直藏在事件里没露出来。排查时想看一眼 `stm32_build` 返回的错误行或 `stm32_ioc_plan` 的 diff，只能回对话里翻工具回包。
- 做法：纯客户端，`Detail` 里加一段只读 JSON。
  - `JSON.stringify(event.payload, null, 2)` 放在 `pre` 里，`max-height: 200px` + 滚动，`word-break` 防长路径撑破面板。
  - 只有带 `payload` 的事件才渲染这一段；`truncated` 为真时原有提示照旧，读者能区分「完整结果」和「只有预览」。
  - 「复制 payload」与「复制引用」并列：前者贴进对话是原始结构，后者是一行人话摘要。
- 边界：只渲染不编辑；payload 超过 8 KB 时事件层已截成 `{preview}`，面板不再二次处理。

### 二十八、停点跳源码（S26）

- 问题：断点与观察点命中后，`/debug` 的 `hits` 只给一行 gdb 原文（`Breakpoint 2 at 0x…: file stm32f1xx_hal.c, line 373.`）。想看一眼这一行前后，得回编辑器里按文件行翻。
- 做法：新增只读的 `/source`，面板从停点文本里取位置后点开。
  - `parseHitLocation(text)`：正则抓「带扩展名:数字」，从右往左取最后一个，避免把 `0x8000314` 的尾数当行号；c/h/cc/cpp/hpp/s 都认。
  - `readSourceSlice(projectDir, file, line, context)`：`resolve` 后要求目标落在 `projectDir + sep` 之内，`../` 与盘符绝对路径一律拒；`line` 夹到 `[1, totalLines]`，上下文 `SOURCE_CONTEXT_MAX = 20` 封顶。
  - 面板：命中历史的每行可点，打开后显示 `文件:行（共 N 行）` 与带行号的高亮片段，焦点行加底色；读不到时显示错误文本，不弹窗。
- 边界：只读源码，不读二进制、不跟随 `#include`；工程外的 SDK 头（`Drivers/` 之外）与本工程内的文件同样受限，越界即 400。
- 计数：73 套件 / **1018 pass / 0 fail**；`client/client.js` 2907 行；包体 1909.4 KB / 288 文件 / 解包 15478.6 KB。

### 二十九、编译错误跳源码（S27）

- 问题：`stm32_build` 的失败事件只带 `summary`，编译错误在 `errors` 里，面板看不到；S26 做了 `/source` 却只有断点能用上。
- 做法：把错误本身也进事件摘要，面板复用同一套源码片段。
  - `resultDigest` 白名单加 `projectDir`（跳源码要读哪个工程）与 `errors`；错误截到 20 条——再多是刷屏，完整列表仍在工具回包里。
  - `parseCompileError("Core/Src/main.c:67:5: error: …")` 拆出 `file/line/column/message`；只有「文件:行:列」这种才有位置，`In function 'main':` 这类返回 null，按纯文本列出。
  - `CompileErrors` 独立成组件：它有 `useState`，不能塞进 `Detail` 的早退分支里（`Detail` 在无事件时直接 return，钩子顺序会变）。
  - 抽 `SourceBlock` 出来给断点与编译错误共用，`fetchSource(projectDir, file, line, context)` 只有一处拼参数。
- 踩坑：用 python 字符串替换插函数时把 `function Detail(props) {` 写成了 `add + anchor`，`add` 结尾又带了一遍该行，产出 `function Detail(props) {    function Detail(props) {`，`node --check` 报 `Unexpected token ','` 在文件尾——报错行不在出错处，先看 `git diff` 的 `+` 行更快。
- 计数：73 套件 / **1018 pass / 0 fail**；`client/client.js` 2986 行；包体 1911.0 KB / 288 文件 / 解包 15485.6 KB。

### 三十一、串口卡片（S28）

- 问题：开串口一直是 AI 的活（`stm32_serial action=open`），人自己想在面板上发一行得先让模型调一次工具。
- 做法：把「开会话 / 关会话 / 看状态 / 列端口」搬到面板，与 `stm32_serial` 共用同一套引擎函数。
  - `GET /serial` 走 `serialStatus`，只回面板需要的字段（open / port / baudRate / bridgePid / bridgeAlive / message）；`GET /serial/ports` 走 `listPorts`，只留 port / description / vid / pid。
  - `POST /serial/open` 只透传 `port` 与 `baudRate`，其余参数与参数记忆、缺省值仍由 `openSerial` 决定——面板不是第二套配置入口。
  - `POST /serial/close` 没有会话时返回 200 + `closed:false`，不报 409：关一个本来就关着的口不是错误，面板不该因此弹红字。
- 边界：`/serial/ports` 会起一次 PowerShell 查 PnP，只在点「刷新端口」时调；状态轮询 4 秒只读会话目录，不起进程。
- 计数：74 套件 / **1019 pass / 0 fail**；`client/client.js` 3085 行；包体 1913.0 KB / 288 文件 / 解包 15497.2 KB；路由 33 条。
- 教训：面板能做的事要和工具能做的事同源，否则两处对同一份 `serial.json` 的语义会慢慢分叉。

### 三十二、概览跳到失败视图（S29）

- 问题：概览页把「失败事件」写成一个数字，看到 3 条却不知道是哪三条，还要自己切到实时通道再点「只看失败」。
- 做法：失败数有值时可点，一次完成「切标签 + 只看失败」。
  - 标签状态在 `Channels`，筛选状态在 `DebugConsole`；用 `focusFailures` 计数做跨层信号——`DebugConsole` 递增，`Channels` 在 `useEffect` 里看到变大就切到实时通道，不引入状态库也不把 tab 抽出去。
  - 0 条时保持纯文本：点一个按钮什么都不会发生，比不显示按钮更差。
- 计数：74 套件 / **1019 pass / 0 fail**；`client/client.js` 3118 行；包体 1913.4 KB / 288 文件 / 解包 15500.3 KB。
- 教训：跨组件的一次性动作可以用「递增计数 + effect」表达，前提是双方都只关心「发生了一次」，不关心值本身。

### 三十三、证据保留与占用（S30）

- 问题：设计时定了「保留 20 个会话或 7 天」，代码只写不删；证据目录会随跑板子一直长。
- 做法：清理与落盘放在同一处（`src/engine/event-log.ts`），`flushEvicted` 那拍顺带 `pruneEvidence`。
  - 两条规则：日期目录早于 7 天整体删；跨日期目录一起数会话目录，按 mtime 保留最新 20 个。
  - 只认本插件的布局（`<root>/<yyyy-mm-dd>/<会话>`），遇到别的条目跳过，绝不删 root 本身。
  - 清理结果（目录、文件数、字节）随 `POST /evidence/prune` 返回；面板给一个手动入口，自动清理由 30 秒落盘那拍做，失败静默——磁盘问题不该刷屏。
  - `GET /evidence` 增加 `usage: { count, bytes }`，面板显示「N 个文件 · X MB」，人不用去资源管理器看。
- 计数：74 套件 / **1020 pass / 0 fail**；`client/client.js` 3143 行；包体 1914.8 KB / 288 文件 / 解包 15507.8 KB；路由 34 条。
- 教训：保留策略要和写入代码放在同一文件，否则「谁删、什么时候删」没人说得清；单测造 21 个会话目录就能把边界钉住。

### 三十四、ioc_apply 自动记基线（S31）

- 问题：变更页要人先点「记下当前配置」才有基线，而实际写 .ioc 的入口就是 `stm32_ioc_apply`；写完不记，下一次比对就分不清「这次改了什么」。
- 做法：写入成功后立刻 `saveIocSnapshot(projectDir)`，把结果写进报告 notes。
  - 只挂在成功路径；回滚分支不记——回滚后的基线应该由人决定（回滚是「恢复旧配置」，不是「新配置落定」）。
  - 记基线失败不翻转工具结论：报告写「基线未更新：<原因>」，写入本身仍然算成功。
  - `saveIocSnapshot` 读 `process.env`，单测用 `DSH_STM32_SNAPSHOTS` 指到临时目录；`snapshotPath(projectDir, env)` 也要传同一份 env，否则断言会去用户主目录找。
- 测试：新增 `test/ioc-apply-tool-units.test.mjs`，用假 `ctx.tools.register` 抓注册对象、真 `execute({projectDir, planId})`，断言基线与写入后的 .ioc 一致（`readIocDiff` 三张表全空）。**工具级测试要用 `node:test` 的 `test()`**，否则 `run-units.mjs` 解析不到 `ℹ pass`，会报「1 个套件未统计」。
- 计数：75 套件 / **1021 pass / 0 fail**；包体 1915.0 KB / 288 文件 / 解包 15508.5 KB。
- 教训：把「副作用」挂在最靠近真动作的那一层（写入成功处），比让使用者记得点按钮可靠。

### 三十五、.ioc 与生成代码是否同步（S32）

- 问题：在 CubeMX 里改了配置、存了 .ioc 却忘了 `stm32_generate`，之后编译、烧录跑的都是旧代码，现场表现是「配置明明改了怎么不生效」。这个坑没有报错，只能靠人记得。
- 做法：`src/engine/ioc-sync.ts` 的 `readIocSync(projectDir)` 只比两个文件的修改时间——`<工程>/*.ioc` 与 `<工程>/Core/Src/main.c`。
  - 用 `main.c` 当「最近一次生成」的代表：`generate` 一定会重写它。比 Core/Inc 的某个头更稳。
  - `stale = iocMtimeMs > codeMtimeMs + 1000`：留 1 秒容差，避免生成后立刻改 .ioc 的边界抖动。
  - 没有 `main.c` 时不下结论：`stale: false` + 「还没有生成过代码…先跑一次 stm32_generate」。没有 .ioc 与空 `projectDir` 分别给明确错误。
  - 不读 .ioc 内容、不启动 CubeMX、不碰探针：这是一行状态，不是一次配置解析。
- 接线：`GET /ioc-sync`（35 条路由，GET 专用，`projectDir` 取 query 否则 `process.cwd()`，失败 409）；客户端 `useIocSync(projectDir, 10000)` 在引脚页头部显示「已同步 / 待重新生成」，`title` 挂完整说明。
- 测试：`test/ioc-sync-units.test.mjs` 4 条（一致与待生成两个方向、1 秒内抖动、无 `main.c` 的提示、空参数与缺 .ioc）；web-api 35 条断言与 `/ioc-sync` 用例（两个方向、409、POST 405）；验收脚本用 `utimesSync` 把 .ioc 推到未来再拉回，断言两次结论。
- 计数：76 套件 / **1026 pass / 0 fail**；包体 1916.1 KB / 289 文件 / 解包 15513.3 KB；`client/client.js` 3174 行。
- 教训：时间戳判定要留容差、要有「文件不存在」的第三态——把不确定当确定，比不显示更糟。

### 三十六、面板编辑监视登记表（S33）

- 问题：监视项原来只能让模型调 `stm32_watch action=add` 才登记；人在面板上看到曲线，却没法自己加一项去掉一项。
- 做法：新增 `src/engine/watch-admin.ts`，面板与工具共用同一份 `watchState`：
  - `listWatches()` → `{entries, budget, canAddWatchpoint}`（`budget` 取 `debugSessions.status().watchpoints`，`canAddWatchpoint` = 有活动会话）。
  - `addWatches({kind, expressions})`：`kind=value` 走 `registerWatch`（不碰目标）；`write/read/access` 走 `debugSessions.addWatchpoints`（要活动会话，装比较器时目标必须停）。`kind` 先用 `isWatchKind` 校验，不认识直接拒。
  - `removeWatches(ids)` / `clearWatches()` 交给 `debugSessions.removeWatchpoints`：它同时清登记表、删 gdb 里的比较器、把目标放回去——自己再实现一遍就会漏掉 gdb 侧。
- 接口：`/watch` 一个路径两种动词。GET 列清单；POST 按 `action` 分 add/remove/clear，未知动作 400。为此在动词校验处给这个路径开了两动词的例外，POST 时单独解析 body（`needsBody || (path === /watch && method === POST)`）。
- 客户端：`useWatches(5000)` + `WatchAdmin`（标题栏显示观察点用量与「清空」；每行 `#id 表达式 类型 最近值 移除`；底部表达式输入 + 类型下拉 + 「添加」，回车即加）。插在断点卡片与曲线之间。
- 测试：`test/watch-admin-units.test.mjs` 4 条（加一项与重复拒绝、非法表达式/空清单/未知 kind、无会话的硬件观察点被拒且不登记、移除/清空/非法 id）；web-api 36 条断言与 `/watch` 用例（GET 空、POST add、409 未知 kind、remove、clear、未知 action 400、PUT 405）；验收脚本 4 项。
- 计数：77 套件 / **1031 pass / 0 fail**；包体 1919.4 KB / 290 文件 / 解包 15528.8 KB；`client/client.js` 3280 行。
- 教训：同一份状态有两个写入口时，删除路径要交给「真正持有硬件那一侧」做，否则登记表与 gdb 会各说各话。

### 三十七、面板直接构建与烧录（S34）

- 问题：构建、烧录原来只有模型能触发；人在面板上看见「待重新生成」「没烧进去」，却要先回去打一句话让模型调工具。
- 做法：新增 `src/engine/panel-actions.ts`，面板直接调引擎。
  - `buildFromPanel(deps, {projectDir, clean?, target?, artifacts?})` → `runBuild(deps.subprocess, …)`；`flashFromPanel` → `runFlash`。
  - 两个入口都发 `stm32_build` / `stm32_flash` 事件：`source: "user"`，start 一条、ok/fail 一条带 `result` 摘要（`buildDigest` / `flashDigest`，字段与工具埋点同形）。时间线、故障页、产物页因此不必区分「人点的」和「模型点的」。
  - `stm32_build` 事件里的 `memoryUsage` 正是产物页 `MemoryBar` 读的那份，人点一次构建，概览与产物页立刻有数。
- 接口：`POST /build`（`clean`、`target`、`artifacts` 可选）、`POST /flash`（`adapterSpeed`、`allowNoDebug` 可选），路径 36→38 条。失败仍是 200：报告里的 `ok:false` 与 `errors` 才是给面板看的结果，不是 HTTP 层错误。
- 客户端：`BuildCard` 三个按钮「构建 / 清理构建 / 烧录」，下方显示 `message` 与前 5 条 `errors`；卡片里写清「构建与烧录同时记进时间线；烧录会占用探针，调试会话开着时先关」。
- 测试：web-api 38 条断言与 `POST /build`、`/flash` 用例（空目录必然失败、要 200、`stm32_build:start|fail` 与 `stm32_flash:start|fail` 四类事件都在、GET 405）；client 源码断言 `BuildCard`；验收脚本 3 项（构建报告、烧录报告、事件数增加）。
- 计数：78 套件 / **1032 pass / 0 fail**；包体 1921.6 KB / 291 文件 / 解包 15539.3 KB；`client/client.js` 3325 行。
- 教训：人在面板上做的动作要落成和模型动作同一形状的事件，否则时间线会分裂成两套叙事。HTTP 200 + 业务失败，比 500 更好排障。

### 三十八、引脚图视图（S35）

- 问题：引脚页原本只有按外设分组的表。查「PA9 现在给谁用」要先在表里扫两遍；换成按端口排布更接近看芯片丝印的直觉。
- 做法：纯客户端（`client/client.js`），不新增接口。
  - `PIN_PORT_PATTERN = /^P([A-Z])(\d+)$/u` 拆端口与序号；`pinMapRows(pins)` 聚合为「一行一个端口」，端口按字母排序、其它类垫底，格子按序号排。
  - `PinMap`：每格 76px 的小按钮，两行文字（脚名 + 信号/标号/模式），`title` 带完整说明；点格子复制引用，与表格同一套 `copyPin`。未配置的脚用透明底，GPIO/调试/其它用 `color-mix` 调边框深浅。
  - `PinoutPanel` 加「表 / 图」切换（`mode` state），图表互斥渲染；图模式提示「按端口排布；点格子复制引用」。
- 为什么不按 LQFP 物理顺序画：物理顺序依赖封装（LQFP48/64 与 TSSOP20 完全不同），需要更多器件事实；按端口排已经能回答「哪一路占了哪些脚」，且不会画错。
- 验证：`node --check`、build 0、`run-units` **78 套件 / 1032 pass**、`test:pack` 0、`test:size` 1923.7 KB / 291 文件 / 解包 15547.7 KB、client 3404 行；client 测试加 `pinMapRows` / `PinMap` 源码断言。
- 教训：视图切换只加状态与分支，不要把两套渲染都塞进同一次 map；物理排布类需求先确认器件事实够不够。

### 三十九、串口发送历史与重发（S36）

- 问题：面板能发一行串口，但发过的内容没留下；同一条命令要连发几次时只能重打。
- 做法：纯客户端（`client/client.js` 的 `ChannelBlock`），不新增接口。
  - `const [history, setHistory] = useState([])` 记最近 20 条 `{ text, at }`；只在 `message.startsWith("已发送")` 时入列，失败与「发送中」不进历史。
  - 发送成功后清空输入框，避免同一行被误发两次。
  - 历史渲染成一行小按钮「最近发送 ▸ …」，`title` 带时间，点一下走同一条 `props.onSend` 重发；只存内存，刷新页面即清空（与常驻开关同一取舍：不把运行时状态写进 localStorage）。
- 为什么不落盘：串口内容是现场调试产物，不属工程事实；要留就走证据目录与事件流，不在浏览器里再造一份。
- 验证：`node --check`、build 0、`run-units` **1032 pass / 0 fail**、ACCEPTANCE OK、`test:pack` 0、`test:size` 1924.5 KB / 291 文件 / 解包 15551.1 KB、client 3441 行；client 测试加「最近发送」「resend」源码断言。
- 教训：发送类交互要区分「尝试」与「已发生」——只有确认成功才进历史，否则历史会变成噪声。

### 四十、产物校验和（S37）

- 问题：烧进去的到底是哪一版固件？面板能看到文件名、大小、时间，但同名 elf 重新构建后这些都可能一样。
- 做法：`src/engine/artifacts.ts` 增 `sha256` 字段。
  - `elfSha256(file)` 用 `createHash("sha256").update(readFileSync(path)).digest("hex")`；读失败返回空串。
  - 上限 `ARTIFACT_HASH_MAX_BYTES = 8 * 1024 * 1024`：面板每 10 秒轮询一次，超过上限直接跳过并在 notes 里说明「elf 超过 8 MB，跳过校验和」。
  - 没有 elf 时是空串，面板显示 `—`，不假装算过。
- 客户端：产物页加一行「校验和 `xxxxxxxxxxxxxxxx…`」，`title` 是完整 64 位，右侧「复制」拷全串。
- 测试：`test/artifacts-units.test.mjs` 增两条（正常 elf 匹配 `/^[0-9a-f]{64}$/u`；把 elf 写成 `ARTIFACT_HASH_MAX_BYTES + 1` 后为空且 notes 含「跳过校验和」），并在无构建目录用例里断言空串；client 源码断言「校验和」。
- 计数：**1033 pass / 0 fail**；包体 1925.1 KB / 291 文件 / 解包 15553.7 KB；client 3463 行。
- 教训：轮询接口里不要做与「看一眼」不成比例的活（算 20 MB 的哈希）；不能算的时候要显式说不能算。

### 四十一、时钟流向图（S38）

- 问题：时钟页只有一条按频率排序的横条表，看不出「PCLK1 从 HCLK 分频来、TIM(APB1) 再翻倍」这层关系。
- 做法：纯客户端，不新增接口。
  - `clockFlowRows(nodes)` 按名字挂父节点：`PCLK1/PCLK2` 挂 `SYSCLK`，`TIM (APB1)/(APB2)` 分别挂 `PCLK1/PCLK2`，`HCLK/Cortex/SysTick/ADC/USB/MCO` 挂 `SYSCLK`；认不出的节点留在最外层，不猜。
  - 同级按频率从高到低排；`walk(parent, depth)` 递归摊平成行，避免在渲染里递归。
  - `ClockFlow`：缩进 16px/层 + `└` 标记从属，条宽按峰值归一，根节点色深、子节点色浅。
  - 表/图切换沿用引脚页的同一套按钮写法。
- 为什么不画真正的方块连线：SVG 手工排线在窄侧栏里容易压字，且层级只有 3 层；缩进 + 竖线表达从属足够，也不影响复制频率值。
- 验证：`node --check`、build 0、`run-units` **1033 pass / 0 fail**、ACCEPTANCE OK、`test:pack` 0、`test:size` 1926.0 KB / 291 文件 / 解包 15557.7 KB、client 3499 行；client 源码断言 `clockFlowRows` / `ClockFlow`。
- 教训：层级数据要先摊平成行再渲染，别在 JSX 里递归；认不出的项平铺，比猜父节点可靠。

### 四十二、故障按分类筛选（S39）

- 问题：故障页原来是按时间一列到底，二十条以后同类的连在一起，看不出「哪类问题最多」。
- 做法：纯客户端，`FaultPanel` 顶部一排 chip：「全部 N」+ 每个分类的计数，按计数降序（同数按名字排）。选中态与其它页按钮一致，`useState("")` 放在最前面——`FaultPanel` 有多个 early return，hook 放到 return 之后会违反 hook 顺序。
- 数据不再请求：分类与计数都在已取回的 `faults` 数组上算，10 秒一次的轮询不变。
- 空态分两种：整体没有失败事件；或选中的分类下没有条目（两者文案不同）。
- 验证：`node --check`、build 0、**1033 pass / 0 fail**、ACCEPTANCE OK、`test:size` 1926.4 KB / 291 文件 / 解包 15560.2 KB、client 3525 行；client 源码断言 `fault-chip-`。
- 教训：有 early return 的组件，hook 一律写在最前；分类计数在客户端算，别为聚合再开接口。

### 四十三、事件深链与 Esc 清筛选（S40）

- 问题：想让人看「就是这条事件」时只能截图；刷新页面选中状态也没了。
- 做法：纯客户端。
  - `readDebugEventSeq()` 从 `location.hash` 里读 `#stm32-debug:event=<seq>`；`writeDebugEventSeq(seq)` 用 `history.replaceState` 写回（不新增历史条目，后退键不会被深链塞满）。
  - 面板挂载时读一次 hash 设定选中项；`selectEvent` 里同时写 hash。回放态不写——回放的事件不在实时列表里，写进地址栏下次打开会指向不存在的 seq。
  - `Esc` 清空文字筛选（只在有筛选时生效）；监听按 `filter` 重建，避免闭包读到旧值。
- 为什么不走 query 参数：宿主前端会重写 query（会话、路由参数），hash 是这一层唯一稳定的位置。
- 验证：`node --check`、build 0、**1033 pass / 0 fail**、ACCEPTANCE OK、`test:size` 1927.0 KB / 291 文件 / 解包 15563.1 KB、client 3560 行；client 源码断言 `readDebugEventSeq` / `writeDebugEventSeq`。
- 教训：状态同步用 `replaceState` 不用 `pushState`；回放与实时是两套 seq，别把回放写进深链。

### 四十四、探针信息卡（S41）

- 问题：面板只显示「有/没有探针」，不显示是什么探针、序列号、该走哪份 interface 配置；换板子排查时只能去设备管理器看。
- 做法：新增 `src/engine/probe-info.ts`，只读 `pnputil /enum-devices /connected` 的 ASCII 段。
  - `parseProbeInstances` 把 `USB\VID_C251&PID_F001\0001A0000000` 拆成 vid/pid/序列号；带 `&MI_xx` 的是设备里的接口（HID / COM），标 `isInterface`。
  - **序列号只认父设备那一条**：本机实况是父设备 + `&MI_00`（COM4）+ `&MI_02`（HID）三条，接口条目的最后一段是总线路径（`6&30b5aae7&0&0000`），换 USB 口就变，不能当身份。
  - `probeInfoFromText` 复用 doctor 的 `parseProbeVidPid` 分类与 `preferredInterfaceConfig` 选配置；没有 SWD 探针时把其它 USB 设备列进 `others`，接口配置留空。
  - `readProbeInfo` 跑不动 pnputil 时返回 `error`，不抛。
- 接口与面板：`GET /probe-info`（39 条路由，GET 专用）；客户端 `useProbeInfo(30000)` + `ProbeCard`（类型 / 序列号 / 位置 / 接口，取不到的显示 `—`），插在实时通道的串口卡之前。
- 验证：`tsc` 0、build 0、**1043 pass / 0 fail**（`probe-info-units` 9 条）、ACCEPTANCE OK（75 项，含「认出 DAPLink 与序列号」「给出 interface 配置」）、`test:pack` 0、`test:size` 1929.9 KB / 292 文件 / 解包 15574.2 KB、client 3633 行；client 源码断言 `ProbeCard` / `probe-info`。
- 教训：先拿真机 pnputil 输出对一遍再写正则——第一版正则要求 `PID_xxxx` 后直接跟 `\`，真实设备名带 `&MI_00`，会一条都匹配不上；序列号与总线路径必须分开。

### 四十五、恢复某个键（S42）

- 问题：变更页能看出「这个键被改过」，但没有回退入口；改错一个引脚或时钟源，只能手动去 .ioc 里找那一行。
- 做法：新增 `restoreIocKey(projectDir, key, env)`（`src/engine/ioc-diff.ts`）。
  - 值来自基线文件，不猜：基线里没有这个键就直接拒绝（`基线里没有这个键：<key>`），避免「恢复」变成「凭印象填」。
  - 只改命中那一行：保留行首缩进，其余字节原样；当前文件里已经没有该键时追加到末尾。
  - 写之前先 `copyFileSync` 到 `<工程>/.dsh-stm32/backups/ioc-<时间戳>.ioc`；返回 `before/after/backupPath/changed`。
  - 键名按 `/^[A-Za-z0-9_.]+$/u` 校验，挡掉换行与空格。
- 接口与面板：`POST /ioc-diff/restore`（40 条路由），缺 `key` 回 400，`restoreIocKey` 失败回 409；客户端只给「删除」「改动」两类行加「恢复」按钮——「新增」行在基线里没有值，无从恢复。
- 验证：`tsc` 0、build 0、**1046 pass / 0 fail**（`ioc-diff-units` 7 条，新增 3 条覆盖写回、备份、拒绝）、ACCEPTANCE OK（含「恢复某键写回基线值」「恢复前留有备份」「恢复缺 key 被拒」）、`test:pack` 0、`test:size` 1931.3 KB / 292 文件 / 解包 15580.3 KB、client 3657 行。
- 教训：写工程文件的功能必须先落备份再写；备份名带时间戳，同一秒内重复恢复也不会互相覆盖（文件名冲突时后写覆盖前写，但内容一致，可接受）。

### 四十六、中断优先级就地编辑（S43）

- 问题：中断页能看出抢占比子优先级多少，但要改只能回 CubeMX 图形界面；改完还得重新生成，排查时序问题时来回切换成本很高。
- 做法：新增 `setInterruptPriority(projectDir, name, preempt, sub)`（`src/engine/interrupts.ts`）。
  - 只改 `NVIC.<name>_IRQn` 那一条的第二、三段：`.ioc` 里冒号是 `\:`，按转义分隔符切段、改完再拼回去，其余段（使能、硬件触发等）原样保留。
  - 参数先校验：中断名 `/^[A-Za-z0-9_]+$/u`，抢占与子优先级必须是 0–15 的整数（Cortex-M3/M4 只有 4 位）。
  - 写前 `copyFileSync` 到 `<工程>/.dsh-stm32/backups/ioc-<时间戳>.ioc`，与 S42 共用 `iocBackupDir`。
  - 段数不足 3 的异常行直接拒绝，不猜着补。
- 接口与面板：`POST /interrupts/priority`（41 条路由），缺 `name` 回 400，校验或写失败回 409；客户端每行「抢 N / 子 N」变成按钮，点开是两个数字输入框 + 保存 / 取消，保存后显示「抢 2 / 子 0 → 抢 5 / 子 1（已备份）」并刷新。
- 不改生成代码：改的是 .ioc 配置，`stm32_generate` 才会把它写进 `stm32f1xx_hal_msp.c` 的 `HAL_NVIC_SetPriority`；面板只负责改配置，不假装已经生效。
- 验证：`tsc` 0、build 0、**1049 pass / 0 fail**（`interrupts-units` 6 条，新增 2 条覆盖写回与拒绝）、ACCEPTANCE OK（含「改中断优先级写回 .ioc」「留有备份」「越界值被拒」）、`test:pack` 0、`test:size` 1933.1 KB / 292 文件 / 解包 15589.4 KB、client 3696 行。
- 教训：改 `.ioc` 的文件级操作要共用同一套备份与校验工具，否则每个功能各写一份，审计时找不到统一入口。

### 四十七、串口参数回填（S44）

- 问题：串口开着的时候，卡片上写着「COM4 · 115200」，但输入框还是空的；想用同一组参数重开，得自己抄一遍。
- 做法（纯客户端）：`SerialCard` 里加一条 `useEffect`——会话开着且输入框为空（或仍是默认 115200）时，把 `serial.port` / `serial.baudRate` 回填；另加「回填」按钮，会话开着时随时把当前参数抄回输入框并提示「已回填当前参数」。
- 为什么用「只在空时回填」：直接跟着服务端状态覆盖输入框，会把用户敲到一半的端口号冲掉。
- 验证：build 0、**1049 pass / 0 fail**、ACCEPTANCE OK、`test:pack` 0、`test:size` 1933.8 KB / 292 文件 / 解包 15591.7 KB、client 3719 行；client 源码断言「已回填当前参数」。
- 教训：面板里的表单，服务端状态只做「空位补齐」，不要做「持续同步」——用户正在输入时被覆盖比不填更难受。

### 四十八、插件自检（S45）

- 问题：面板加了新功能后，只有「完全退出 DSH 再启动」才生效；用户刷新页面看不到，分不清是前端没刷新、还是进程里跑的是旧 `lib`。
- 做法：`/status` 增加 `self: { version, libMtimeMs, startedAt, routeCount }`。
  - `version` 读 `<包根>/package.json`；`libMtimeMs` 是 `web-api.js` 自身的 mtime（即本次构建时间）；`startedAt` 是模块加载时刻；`routeCount` 取 `WEB_API_PATHS.length`。
  - 客户端状态条显示「v0.1.7 · 41 路由」；当 `libMtimeMs > startedAt + 1s` 时显示「（有新构建）」并标黄，`title` 里给出「lib 比进程新：完全退出 DSH 再启动」。
  - 判据选时间戳而不是比对文件内容：一次重启就能自证；不需要额外维护一份「期望版本」。
- 验证：`tsc` 0、build 0、**1049 pass / 0 fail**、ACCEPTANCE OK（含「版本与路由数」「构建时间与启动时间」）、`test:pack` 0、`test:size` 1935.0 KB / 292 文件 / 解包 15594.7 KB、client 3735 行。
- 教训：**「为什么我的功能没出现」要能在界面上自证**，不要让用户猜是前端缓存还是进程没重启；把构建时间与进程启动时间放在同一个状态条上，比写一段文档更管用。

### 四十九、故障按规则合并（S46）

- 问题：一次构建失败常连着几条同因错误（几个未定义符号各算一条），故障页逐条列会把「真正不同的那一条」挤出屏幕。
- 做法：`src/engine/fault-hints.ts` 增 `groupFaults(items)`——按 `rule` 合并，保留 `count` / `firstSeq` / `lastSeq` / `firstTime` / `lastTime`，按 `count` 降序、同数按规则名排序；`/faults` 响应多返回 `groups`，`faults` 原样保留。
  - 面板在分类 chip 之上加「按规则合并（N 组）」一行，每行显示 `×次数 规则名 最近时间`；点一行按该规则筛选，再点一次取消，右侧给「清除规则筛选」。
  - 只合并展示，不改事件本身：时间线与 `faults` 列表仍逐条，导出与回放不受影响。
- 验证：`tsc` 0、build 0、**1050 pass / 0 fail**（新增 `groupFaults` 用例 1 条）、ACCEPTANCE OK（含「故障按规则合并」）、`test:pack` 0、`test:size` 1936.6 KB / 292 文件 / 解包 15600.6 KB、client 3785 行。
- 教训：**合并是展示层的事，别改事实**。分组一旦污染事件流，「这条是第几次」就再也算不回来；只把统计放进响应，原始事件留原处。

### 五十、时间线按耗时与慢调用（S47）

- 问题：时间线一直按到达顺序排，一次 40 秒的 `stm32_build` 和几十条 30 ms 的读寄存器混在一起，看不出时间花在哪。
- 做法（纯客户端）：
  - `toolDurations(events)` 按 `payload.callId` 把 `start` 与 `ok`/`fail` 配成一对，用两条事件的 `time` 算耗时；重连补发的历史同样能算出，不需要面板自己计时。
  - 时间线每行在摘要右侧显示耗时（`820 ms` / `2.4 s`）；超过 `TOOL_SLOW_MS = 5000` 标黄并加「慢」字，`title` 说明阈值。
  - 工具栏「按时间 / 按耗时」切换：按耗时从长到短，没有配对的事件（模型发的 info、生命周期等）排在最后，避免它们挤到前面。
- 验证：`node --check`、build 0、**79 套件 / 1050 pass / 0 fail**、ACCEPTANCE OK、`test:pack` 0、`test:size` 1938.6 KB / 292 文件 / 解包 15607.0 KB、client 3852 行。
- 教训：**能算的不要记**。耗时从已有时间戳推出来，比在面板里维护一份计时器更稳：刷新页面、回放、重连都不会丢。

### 五十一、证据列表按会话分组（S48）

- 问题：证据目录是「日期/会话/文件」，面板却把最多 200 个文件平铺，找某个会话要自己筛路径。
- 做法：`web-api.ts` 增 `evidenceSessionKey(path)`（取第二段）与 `groupEvidenceFiles(files)`——按会话键聚合 `bytes`、`latestMs`，按最近时间倒序；`/evidence` 响应加 `groups`，`files` 原样保留。
  - 面板 `ReplayPicker` 改成「会话标题行（键名 + N 个 · 体积）」+ 该会话文件列表；键为空归「（未分目录）」。
  - 分组只影响展示：回放仍按完整相对路径取文件，路径是唯一标识。
- 验证：build 0、**1050 pass / 0 fail**（`/evidence` 用例改为断言两个会话两组）、ACCEPTANCE OK、`test:pack` 0、`test:size` 1939.3 KB / 292 文件 / 解包 15610.1 KB、client 3868 行。
- 教训：**目录已是分组就不要再造一份索引**。证据路径自带会话信息，服务端聚合时只需读路径，不必额外维护清单。

### 五十二、会话卡显示最近 gdb 输出（S49）

- 问题：调试时 gdb 的原始输出只有工具回包里有；面板上只看到「已停下在 main.c:67」，想看 `info registers` 的整段输出得再问一次模型。
- 做法：
  - `DebugSessionManager` 增 `EvalTrace { at, command, ok, output }` 与 `traces` 环形表（`TRACE_LIMIT = 20`，单条输出留尾部 `TRACE_TEXT_LIMIT = 2000` 字符），MI 与 `-batch` 两条路径都在 `hits.record` 之后调 `rememberTrace`；`stop()`/`resetForTest()` 一并清空。
  - `/debug` 响应加 `outputs: debugSessions.recentTraces()`（默认最近 5 条）。
  - 会话卡在断点配额之后渲染「最近 gdb 输出」：最多 3 条 `时间 + 命令` 与 `pre` 里 120px 高的输出，最上面一条给「复制」。
  - 只留尾部而不是整段：一次 `info all-registers` 能到几万字符，面板要的是最后几行结论；完整输出仍在工具回包里。
- 验证：`tsc` 0、build 0、**79 套件 / 1050 pass / 0 fail**、ACCEPTANCE OK、`test:pack` 0、`test:size` 1940.4 KB / 292 文件 / 解包 15615.6 KB、client 3918 行。
- 教训：**面板要的是「刚才那段输出」，不是「所有输出」**。留尾部 + 条数上限，比把 gdb log 全量塞进事件流便宜得多，也不至于把界面拖死。

### 五十三、引脚页看该脚的 .ioc 键（S50）

- 问题：引脚页只说「PA0 = GPIO_Output」，用户改 CubeMX 配置时想知道这一脚在 `.ioc` 里到底占哪几行键（`PA0.Signal`、`PA0.GPIOParameters`），得自己去翻文件。
- 做法：`src/engine/ioc-diff.ts` 增 `readIocKeysForPin(projectDir, pin)`——键前缀就是 `.ioc` 里的引脚名（`PC13-TAMPER-RTC.Signal`）；先按完整名匹配，没有命中再退到第一段（`PC13`）；`GET /ioc-keys?projectDir=&pin=` 只读返回 `{ iocPath, pin, base, entries }`。
  - 引脚行右侧加「ioc」按钮，点开在表下方显示该脚的键值（最多 180px 高、可滚动），再点「关闭」收起；不改 `.ioc`。
  - 为什么不做成跳转到变更页：变更页按基线比差异，没有基线时是空的；「这个脚占哪些键」与「有没有改过」是两个问题。
- 验证：build 0、**79 套件 / 1052 pass / 0 fail**、ACCEPTANCE OK（「引脚 ioc 键」「缺 pin 回 400」）、`test:pack` 0、`test:size` 1941.6 KB / 292 文件 / 解包 15622.8 KB、client 3969 行、路由 42 条。
- 教训：**面板上的「为什么是这样」要能就地展开**。把底层键摊在同一个页面里，比让人切到编辑器再找回来快得多。

### 五十四、通道导出文本（S51）

- 问题：串口/RTT 的行只活在面板窗口里，要贴给别人或留档只能手抄；时间线有 JSONL 导出，通道没有。
- 做法：`client/client.js` 加 `exportChannelLines(channelKey, lines)`——与 `exportEvents` 同一条路（`Blob` + 临时 `<a download>` + 1 秒后 `revokeObjectURL`），文件名 `stm32-<channel>-<ISO>.txt`；`ChannelBlock` 头部在「暂停」左侧加「导出」按钮，导的是 `shown`（已按关键字与 RTT 级别筛过的当前窗口），按钮 `title` 写明行数，没有可见行时禁用。
- 为什么导 `shown` 而不是全量：面板上看见什么就导什么，导出结果与截图能对得上；要原文走常驻通道或证据目录。
- 纯客户端改动，无新路由、无新接口。
- 验证：`node --check` 与 build 0、**79 套件 / 1052 pass / 0 fail**、ACCEPTANCE OK、`test:pack` 0、`test:size` 1942.1 KB / 292 文件 / 解包 15625.2 KB、client 3993 行。
- 教训：**可见范围就是导出范围**。导出按钮与筛选、暂停、清空共用同一份 `shown`，才不会出现「导出的比看到的多」这类解释成本。

### 五十五、变更页一次恢复全部差异（S52）

- 问题：S42 只能一个键一个键点「恢复」；真改错一版配置时往往五六个键一起偏，逐个点太慢。
- 做法：`src/engine/ioc-diff.ts` 加 `restoreAllIocKeys(projectDir, env)`——复用 `readIocDiff` 算出「改动」「删除」两组键，一次改写所有行（删掉的键追加回末尾），**整批只做一次备份**，返回 `{ iocPath, backupPath, restored[], skipped[], changed }`；「新增」的键不动（基线里没有它们的值，删不删应由人判断）。
  - `POST /ioc-diff/restore-all`（43 条路由）：`projectDir` 缺省 `process.cwd()`，失败 409。
  - 面板头部「全部恢复」按钮坐在「记下当前配置」左边；没有差异或没有基线时禁用/报错，成功后提示恢复几条与备份路径。
- 验证：build 0、**79 套件 / 1054 pass / 0 fail**、ACCEPTANCE OK（「变更页批量恢复可调用」）、`test:pack` 0、`test:size` 1942.9 KB / 292 文件 / 解包 15631.4 KB、client 4017 行。
- 教训：**同类操作要成批**。单个「恢复」解决偶尔点一下，整批恢复才配得上「改错一版配置」这个真实场景；批量时备份只做一次，回退才有意义。

### 五十六、引脚页筛选（S53）

- 问题：48 脚以上的芯片，引脚表与外设分组会拉得很长；想找「USART1_TX 在哪一脚」只能靠眼睛扫。
- 做法：纯客户端——`PinoutPanel` 加 `needle` 状态与 `pinMatches(pin)`（把 `pin`、`signal`、`label` 拼成小写串做包含匹配），空白表示不过滤；`groups` 先按组过滤引脚再丢空组，`PinMap` 也吃同一份过滤结果（空端口整行消失）；工具栏输入框右侧在筛选时显示「命中 N / 总 M」，无命中显示「没有匹配的引脚。」。
- 为什么不做成服务端接口：过滤只作用在已加载的一份引脚表上，每次改动都要重读 `.ioc` 只会让输入变卡。
- 验证：`node --check` 与 build 0、**79 套件 / 1054 pass / 0 fail**、ACCEPTANCE OK、`test:pack` 0、`test:size` 1943.5 KB / 292 文件 / 解包 15634.2 KB、client 4043 行。
- 教训：**筛选放在离数据最近的一次渲染里**。同一份过滤函数同时喂表格与图，视图切换后条件不丢，也不用维护两份状态。

### 五十七、概览补证据占用与最近事件（S54）

- 问题：概览页有「失败事件」，但没有「证据占多少」，也没有「最近一条事件是什么时候」；切到回放页才知道磁盘用了多少。
- 做法：纯客户端——`OverviewPanel` 复用 `useEvidence(true)` 的 `usage`（`{count, bytes}`），加一行「证据 `N 个 · X`」；再用 `events` 最后一条加「最近事件 `时间 · #seq`」。
- 为什么直接复用 `useEvidence`：它已经在回放页按需轮询，概览挂上同一份状态只多一次 GET /evidence；另起接口会把同一份目录扫描写第二遍。
- 验证：build 0、**79 套件 / 1054 pass / 0 fail**（首轮出现过一次 `1053/1`，重跑即过，属构建产物复制与测试抢读 `lib/client.js` 的偶发）、ACCEPTANCE OK、`test:pack` 0、`test:size` 1943.7 KB / 292 文件 / 解包 15635.1 KB、client 4053 行。
- 教训：**概览的每一行都要能指向一个可继续查的地方**。写「证据 N 个」，人自然会去回放页清；写「最近事件 #seq」，人自然会去时间线定位。

### 五十八、中断页筛选（S55）

- 问题：`.ioc` 里 NVIC 动辄二三十路，想确认「USART1 的抢占优先级是多少」得从头扫；中断页也没有任何检索入口。
- 做法：纯客户端——`InterruptPanel` 加 `needle` 状态与 `shown`（按 `entry.name` 小写包含匹配），头部右侧输入框「筛选中断名」，筛选时显示「命中 N」；无命中显示「没有匹配的中断名。」，与「这个 .ioc 里没有 NVIC 中断配置。」分开，避免把「筛空了」误判为「没配置」。
- 验证：`node --check` 与 build 0、**79 套件 / 1054 pass / 0 fail**、ACCEPTANCE OK、`test:pack` 0、`test:size` 1943.9 KB / 292 文件 / 解包 15636.9 KB、client 4067 行。
- 教训：**两种空态要分开写**。「没有配置」与「筛掉了」是两件事，混用一句话会让人去改 `.ioc`。

### 五十九、面板关闭调试会话（S56）

- 问题：会话只能靠空闲超时或让 AI 调工具关；人想立刻把探针让给 VS Code 时没有入口。
- 做法：`POST /debug/stop`（44 条路由）调 `debugSessions.stop("面板关闭")`——该方法原本就存在（工具层用），会把 gdb MI、openocd（走 Tcl shutdown）、观察点登记表一起清掉；没有会话时返回 200 且 `stopped:false`，**关闭是幂等的**，面板重复点不会报错。
  - 响应体 `{ debug: { ...status, stopped, message } }`，面板据此区分「已关闭，探针已释放」与「本来就没有会话」。
  - `SessionCard` 在「续期」右侧加「关闭会话」（`#e8b339`，title 说明会释放探针、观察点清空），关闭中显示「关闭中…」，完成后刷新状态。
- 为什么不做二次确认：会话可重建、观察点可重加，且按钮文案已写明后果；弹确认框反而挡住「马上把探针让出去」这个场景。
- 验证：build 0、**79 套件 / 1055 pass / 0 fail**、ACCEPTANCE OK（「面板关闭会话幂等」）、`test:pack` 0、`test:size` 1944.4 KB / 292 文件 / 解包 15639.8 KB、client 4096 行。
- 教训：**破坏性操作要幂等**。空闲时点关闭不能报错，否则人分不清「关成功了」还是「本来就没开」。

### 六十、时间线按工具名筛选（S57）

- 问题：时间线一屏几十条，想只看 `stm32_build` 的调用，得自己在筛选框里敲工具名。
- 做法：纯客户端——`kindCounts(events, limit)` 按 `kind` 统计频次（降序、同数按名字），工具栏在「显示 N / M」后渲染前 5 个 chip（文案去掉 `stm32_` 前缀，如 `build 3`）；点击把 `filter` 设成该 `kind`（复用既有文字筛选，因为筛选本就是 `kind + summary` 的包含匹配），再点一次清空。
- 为什么不新增筛选状态：文字筛选已经覆盖「按 kind 精确匹配」这个场景，复用后 Esc 清筛选、导出、勾选引用全部自动一致。
- 验证：`node --check` 与 build 0、**79 套件 / 1055 pass / 0 fail**、ACCEPTANCE OK、`test:pack` 0、`test:size` 1945.0 KB / 292 文件 / 解包 15642.1 KB、client 4122 行。
- 教训：**先看统计再筛选**。把「哪一类最多」摆在工具栏上，比让人盲敲名字更符合排查时的动作顺序。

### 六十一、故障组复制提示（S58）

- 问题：故障页把同因错误合并成组后，只有点开某一条才能看到原文与提示；想请人去查「这条规则为什么触发」时得手动抄。
- 做法：纯客户端——`FaultPanel` 加 `copyGroup(item)`，把组写成三行文本：`[故障组] rule ×N（category）`、`提示：…`（无提示时写明「无匹配提示，按原文判断」）、`首见 #a 时间 · 末见 #b 时间`；组行从单个按钮改成「选择按钮 + 复制按钮」的横向行（按钮不能嵌套），复制成功后标题栏显示「已复制 <rule>」。
- 为什么给首末时间：频次高但都在很早以前的组，与刚刚开始刷屏的组，处置优先级不同。
- 验证：`node --check` 与 build 0、**79 套件 / 1055 pass / 0 fail**、ACCEPTANCE OK、`test:pack` 0、`test:size` 1945.6 KB / 292 文件 / 解包 15644.7 KB、client 4150 行。
- 教训：**合并后的组要能整段带走**。合并只解决「屏幕被刷」，解决不了「拿去问人」，所以复制的是整组而不是单条。

### 六十二、引脚表导出 CSV（S59）

- 问题：引脚分配要写进硬件说明或发给别人核对，截图不好查，手抄又容易错。
- 做法：纯客户端——`csvCell(value)` 按 CSV 规则转义（含逗号/引号/换行时加引号、引号翻倍），`exportPinsCsv(pins)` 生成 `﻿` 开头的 UTF-8 CSV（BOM 让 Excel 直接认中文），表头 `引脚,信号,标号,模式`，行分隔用 `
`；引脚页「导出 CSV」按钮导的是**当前筛选结果**，没有引脚时禁用。
- 为什么带 BOM：不带 BOM 的 UTF-8 CSV 在中文 Windows 的 Excel 里常显示成乱码，这类问题排查成本远高于加三个字节。
- 验证：`node --check` 与 build 0、**79 套件 / 1055 pass / 0 fail**、ACCEPTANCE OK、`test:pack` 0、`test:size` 1946.4 KB / 292 文件 / 解包 15647.8 KB、client 4183 行。
- 教训：**导出的第一用户是别人的表格软件**。转义、BOM、CRLF 都不是洁癖，是让文件在对方机器上打开就正确。

### 六十三、概览显示在途调用（S60）

- 问题：概览页有会话、工具链、构建与烧录，但不显示「现在有几个调用正在跑」——人从面板发起构建后，只能去实时通道翻。
- 做法：纯客户端——`OverviewPanel` 复用 `collectRunning(props.events ?? [])` 得到在途列表，在「上次构建」前插一行「在途」：`无`，或 `N 个 · name1、name2`（超过 2 个加「等」）。数据来自同一份事件流，不新增接口。
- 为什么只看名字不看耗时：这一行回答的是「还在不在跑」，耗时属于时间线的慢调用标记。
- 验证：`node --check` 与 build 0、**79 套件 / 1055 pass / 0 fail**、ACCEPTANCE OK、`test:pack` 0、`test:size` 1946.6 KB / 292 文件 / 解包 15648.5 KB、client 4191 行。
- 教训：**同一个事实源可以被多个视图读**。`collectRunning` 先服务「在途调用」块，再加一个消费者不需要动服务端——这类复用要优先于新接口。

### 六十四、在途行可跳实时通道（S61）

- 问题：S60 加的「在途 N 个」只是静态文字；看到有调用在跑但不知道输出在哪，还得自己切标签。
- 做法：纯客户端——`OverviewPanel` 的芯片行渲染支持第三个元素为点击处理器：`chips` 里「在途」在 `runningNow.length > 0` 时传 `props.onShowChannels`（`Channels` 里 `() => setTab("channels")`），渲染时统一判断 `typeof pair[2] === "function"` 走按钮分支；「失败事件」仍走原有 `onShowFailures`，两者共用同一段按钮样式。
- 为什么不在概览里直接嵌输出：输出与筛选状态属实时通道，重复一份会出现「两个地方都能停、但停的不是同一份」。
- 验证：`node --check` 与 build 0、**79 套件 / 1055 pass / 0 fail**、ACCEPTANCE OK、`test:pack` 0、`test:size` 1946.8 KB / 292 文件 / 解包 15649.5 KB、client 4198 行。
- 教训：**跳转优于复制**。同一份数据在第二个位置渲染，迟早会和原位置的交互状态对不上。

### 六十五、产物逐文件校验和（S62）

- 问题：S37 只给 elf 算了 SHA-256；实际烧进芯片的常是 hex 或 bin，核对「板子里跑的是不是这次构建」时缺的就是这两个文件的校验和。
- 做法：`ArtifactFile` 增 `readonly sha256: string`，`statFile` 先给空串，`withHash(file)` 统一补算（`hashFile` 仍受 `ARTIFACT_HASH_MAX_BYTES = 8 MB` 约束，超限留空串）；`readArtifacts` 依次对 elf / hex / bin 走 `withHash`，报告级 `sha256` 仍取 elf 那份以保持兼容；面板每行文件名后显示前 12 位，`title` 里是完整 64 位。
- 为什么保留报告级字段：既有面板与验收脚本按 `artifacts.sha256` 读 elf 校验和，换成嵌套结构会牵动两处消费者。
- 验证：build 0、**79 套件 / 1055 pass / 0 fail**（`artifacts-units` 增 hex/bin 校验和格式与「不同文件不同值」断言）、ACCEPTANCE OK、`test:pack` 0、`test:size` 1947.0 KB / 292 文件 / 解包 15650.0 KB、client 4199 行。
- 教训：**「哪个文件被烧进去」是产物页的核心问题**。只给 elf 算哈希，在 hex/bin 烧录场景里等于没给。

### 六十六、中断页按优先级/名字切换排序（S63）

- 问题：服务端按「抢占 → 子 → 名字」给中断，利于看优先级分布；但要找某一路（比如 USART1）时得在列表里扫。
- 做法：纯客户端——`InterruptPanel` 加 `order` 状态（默认 `"priority"`），头部两个按钮「按优先级 / 按名字」；顺序只作用于 `shown` 的副本（`filtered.slice().sort(...)`），不改变筛选结果与行内容。
- 为什么不加服务端参数：排序是纯展示，再让接口多一个 `order` 会让测试与文档都要维护两份顺序语义。
- 验证：build 0、**79 套件 / 1055 pass / 0 fail**、ACCEPTANCE OK、`test:pack` 0、`test:size` 1947.4 KB / 292 文件 / 解包 15652.2 KB、client 4225 行。
- 教训：**筛选与排序分开做**。先筛后排，两个控件互不覆盖；把排序塞进筛选条件里，用一次就得想两次。

### 六十七、失败事件导出 CSV（S64）

- 问题：故障页能筛选、能合并、能复制单组，但整轮调试结束后要把「这次一共踩了哪些坑、各多少次」交给别人时，还是要一条条抄。
- 做法：纯客户端——`exportFaultsCsv(rows)` 复用 S59 的 `csvCell`，表头「序号,时间,工具,分类,规则,摘要,提示」，UTF-8 带 BOM、CRLF；故障页 chip 行末尾加「导出 CSV」，导的是**当前筛选结果**（分类 + 规则筛选后），没有事件时禁用。
- 顺手修掉 `groupRow` 里重复的 `type: "button"` 属性（同一对象里写了两遍，读起来像手误）。
- 验证：`node --check` 与 build 0、**79 套件 / 1055 pass / 0 fail**、ACCEPTANCE OK、`test:pack` 0、`test:size` 1948.2 KB / 292 文件 / 解包 15655.1 KB、client 4262 行。
- 教训：**导出的内容要和屏幕上看到的筛选一致**。导全量再让人自己筛，等于把面板的工作丢回给读者。

### 六十八、失败未读角标（S65）

- 问题：调试时人常停在概览或引脚页，失败事件在别处悄悄累积，只有切回实时通道才发现——「面板没提示」是上次清点列出的缺口之一。
- 做法：纯客户端——`Channels` 里 `failCount` 取当前会话所有 `status === "fail"` 的事件数，`failSeen` 记已经看过的数量；`useEffect` 在 `tab === "channels" || tab === "faults"` 时把 `failSeen` 拉到 `failCount`；`unseenFails = max(0, failCount - failSeen)` 作为角标传给「实时通道」与「故障」两个标签按钮。
- 为什么挂在两个标签：实时通道看的是时间线，故障页看的是归类结果；两边都能「处理掉」失败，任一处打开即视为已读。
- 边界：只看当前会话（`props.events` 已按会话过滤），角标不会因别的会话失败而亮；不落 localStorage，刷新后清零。
- 验证：`node --check` 与 build 0、**79 套件 / 1055 pass / 0 fail**、ACCEPTANCE OK、`test:pack` 0、`test:size` 1948.6 KB / 292 文件 / 解包 15656.6 KB、client 4276 行。
- 顺带修正本文档 §92 标题口径：正文已写到 S65，标题原写「S1–S45」。
- 教训：**提示要贴在「会切走」的位置**，不是贴在出事的地方。失败发生在时间线，但人不在那儿。

### 六十九、时钟页超限标黄（S66）

- 问题：时钟页只把 CubeMX 写进 `.ioc` 的频率列出来，看不出哪一路已经超过手册上限——ADC 配成 36 MHz 在 F1 上是错的，但页面上和正常值长得一样。
- 数据来源：`src/data/clock-db.ts` 已有的 `BUS_LIMITS`（按族索引 `apb1Hz` / `apb2Hz` / `adcHz`，注释里带手册号）。不新造一张表，避免两处上限不一致。
- 做法（服务端）：`src/engine/clocks.ts` 新增 `familyOfCpn(cpn)`（`STM32F103C8T6` → `STM32F1`，表里没有就空串）与 `limitForNode(label, limits)`；`ClockNode` 增 `limitHz` / `overLimit`，报告增 `limits: {family, apb1Hz, apb2Hz, adcHz} | null`。
- 只判三路：`PCLK1 / APB1`、`PCLK2 / APB2`、`ADC`。**定时器不判**——`TIM (APB1)` 是 APB1 的二倍频，拿 APB1 上限去比会误报（F1 上 TIM2 就是 72 MHz 而 APB1 上限 36 MHz）。`SYSCLK` 也不判：`BUS_LIMITS` 里没有 SYSCLK 列，不猜。
- 做法（客户端）：超限行的频率标 `#e8b339`、加粗、加「超」字并 `title` 写上限；分频列尾显示「限 36 MHz」；头部显示「STM32F1 上限 APB1 36 MHz · APB2 72 MHz · ADC 14 MHz」，族不在表里时显示「上限：未收录」。
- 验证：`test/clocks-units.test.mjs` 增 3 条（族名归一、只判三路、F1 @72 MHz 时 ADC 36 MHz 判超限且 SYSCLK 的 `limitHz` 为 null、未知族全不判）；`client-debug-units` 断言 `overLimit`；验收脚本加「时钟上限与超限标记」。总计 **79 套件 / 1059 pass / 0 fail**、ACCEPTANCE OK、`test:pack` 0、`test:size` 1949.7 KB / 292 文件 / 解包 15660.7 KB、client 4303 行。
- 教训：**「有上限」和「能判超限」不是一回事**。定时器二倍频、SYSCLK 缺数据这两处，宁可显示「未判」，也不要拿相邻的列去比——误报比不报更费时间。

### 七十、监视采样明细导出 CSV（S67）

- 问题：曲线只存在面板内存里，采样明细（时间、表达式、值、增量）刷新即失，想拿一段变化趋势做记录只能截图。
- 做法：纯客户端——`collectWatchRows(events)` 走 `channel:watch` 事件的 `payload.meta.samples`，只收 `ok === true` 的样本，字段 `{time, expression, value, delta}`；`exportWatchCsv(rows)` 复用 S59 的 `csvCell`，表头「时间,表达式,值,增量」，UTF-8 带 BOM、CRLF；`WatchCurves` 头部加「导出 CSV」，没有事件时禁用。
- 为什么不改 `collectWatchSeries`：曲线只要数值序列（`number[]`），导出要时间与增量；两件事分开，避免给画线的地方塞它不用的字段。
- 边界：只导当前会话（`props.events` 已按会话过滤），导的是事件流里还在的样本——环形缓冲淘汰与面板 2000 条上限之外的不在。
- 验证：`node --check` 与 build 0、**79 套件 / 1059 pass / 0 fail**、ACCEPTANCE OK、`test:pack` 0、`test:size` 1951.2 KB / 292 文件 / 解包 15665.4 KB、client 4351 行。
- 教训：**同一份数据的两种用途，允许两条读取路径**。曲线要的是形状，导出要的是明细，硬合成一条只会让两边都别扭。

### 七十一、两次构建的 elf 对比（S68）

- 问题：烧录前最常见的疑问是「板子里那次构建，跟刚才这次是不是同一个」；只给当前 elf 的校验和回答不了。
- 做法（服务端）：`src/engine/artifacts.ts` 导出 `sha256OfPath(filePath)`（`statFile` + `hashFile`，仍受 8 MB 上限）；`src/engine/panel-actions.ts` 的 `buildDigest` 在 `report.elf` 存在时补 `elfSha256`。只在构建摘要里算一次，面板不改读文件。
- 做法（客户端）：`collectBuildShas(events)` 取最近两条 `kind === "stm32_build" && status === "ok"` 的 `payload.result.elfSha256`，产物页「与上次构建相同（#seq 时间）」或「与上次构建不同（#seq 时间）」，不同时标 `#e8b339`。
- 边界：少于两次成功构建时显示「至少要有两次成功构建记录」；事件被环形缓冲淘汰后自然只剩一条，同样落到这个提示，不猜。
- 验证：`test/artifacts-units.test.mjs` 增 `sha256OfPath` 与产物报告一致、文件不存在给空串两条断言；client 断言 `collectBuildShas`。总计 **79 套件 / 1059 pass / 0 fail**、ACCEPTANCE OK、`test:pack` 0、`test:size` 1952.1 KB / 292 文件 / 解包 15668.3 KB、client 4376 行。
- 教训：**要比较两次构建，就得在构建那一刻把指纹记下来**。事后从文件系统找「上次的 elf」通常已被覆盖，只有事件流里留着的摘要可信。

### 七十二、概览一行告警摘要（S69）

- 问题：概览里「在途」与「失败事件」是两行，字段多的时候要逐行扫才知道「现在有没有事」。面板回答的第一个问题应该是「要不要我处理」。
- 做法：纯客户端——`warnParts` 收集「在途 N 个 · 名字」「失败 M 条」，拼成一行置于 chips 首位；没有告警时显示「无：没有在途调用，也没有失败事件」；有失败优先跳失败筛选，只有在途时跳实时通道。原来两行随之删掉，避免三处说同一件事。
- 为什么失败优先：失败是已发生的问题，在途只是进行中；点进去先看能立刻处理的那一类。
- 验证：`node --check` 与 build 0、**79 套件 / 1059 pass / 0 fail**、ACCEPTANCE OK、`test:pack` 0、`test:size` 1952.4 KB / 292 文件 / 解包 15669.2 KB、client 4377 行。
- 教训：**概览的第一行是「结论」，不是「字段」**。状态行回答「有没有事」，其余行才回答「是什么」。

### 七十三、新失败主动提示（S70）

- 问题：S65 的未读角标只在标签上，用户停在概览或时间线时不会注意到；失败发生在别的面板视线之外，往往过几分钟才被发现。
- 做法：纯客户端——`DebugConsole` 用 `failSeenRef` 记住已读的最大失败 `seq`，`useEffect` 扫 `events`，发现更大的失败就置 `failToast`（条数、序号、工具名、摘要）；面板顶部渲染一条黄底提示，带「看」（跳实时通道 + 只看失败）与「×」；首次加载把已有失败当已读，避免一进面板就弹历史。
- 为什么不用 `document.title` 或系统通知：改标题会污染宿主页签，系统通知要权限且容易被忽略；面板内提示与「用户正在看调试台」这个场景一致。
- 验证：`node --check` 与 build 0、**79 套件 / 1059 pass / 0 fail**、ACCEPTANCE OK、`test:pack` 0、`test:size` 1953.2 KB / 292 文件 / 解包 15674.1 KB、client 4435 行。
- 教训：**提示要落在用户已经在看的地方**。角标适合「回来时清账」，即时提示适合「这次失败了」。

### 七十四、时钟超限给修法（S71）

- 问题：S66 能标出「APB1 超了」，但用户还得自己想「那该除以几」。标红只完成一半工作。
- 做法：`src/engine/clocks.ts` 加 `suggestFix(label, hz, limitHz)`——只对三路有上限的节点（`PCLK1 / APB1`、`PCLK2 / APB2` 用 2/4/8/16，`ADC` 用 2/4/6/8）枚举分频档，取第一个满足上限的档，返回「把分频改成 ÷N（X MHz）」；都不够时明说「现有分频档都不够，需要降低源频率」。`ClockNode` 增 `suggest: string`（未超限为空串），面板在超限行尾显示这条建议。
- 只给建议、不写 `.ioc`：改配置仍走 `stm32_ioc_plan`，那里会重算 `SYSCLKFreq_VALUE` 等全部派生键并校验五项一致；面板直接改分频会产生半套配置。
- 验证：tsc 0、build 0、**79 套件 / 1059 pass / 0 fail**（clocks-units 断言 ADC 超限有 `÷N` 建议、未超限为空串）、ACCEPTANCE OK、`test:pack` 0、`test:size` 1955.1 KB / 292 文件 / 解包 15678.7 KB、client 4445 行。
- 教训：**报警与修法要成对出现**。只告诉人「超了」，等于把计算推回给人；给出「改成 ÷4」才对得上「工具」二字。

### 七十五、正常会话也落盘证据（S72）

- 问题：S13 起证据目录只在环形缓冲溢出时才有内容。正常会话（几千条以内）重启后什么都留不下，`/evidence` 面板永远空着，复盘只能靠截图。
- 做法：`src/engine/event-log.ts` 抽出 `writeBatch(events, {root, now, key, dropped})`，目录布局与缺口事件只实现一次；新增 `flushPending()` = 「溢出队列里游标之后的」+ 「环形缓冲里游标之后且属于本会话的」，写成功后把游标推到本批最大 `seq`；`startEventLog` 的每拍从 `flushEvicted` 换成 `flushPending`（30 秒一批，仍是每批一个 `events-<HHmmss>.jsonl`）。
- 两个关键判定：
  - **按 `seq` 去重而不是按时间**：游标记录「已写过的最大序号」，同一事件不会被写两遍，也不会因为两批落在同一秒的同一文件里而重复（同秒只会 append 到同一文件）。
  - **归档要按会话过滤**：换会话后 ring 里还留着上一个会话的事件，不过滤就会把它们写进新会话目录。测试里正是这一点先失败（期望 1 条、实际 4 条），加 `event.session === key` 过滤后通过。
- 清理沿用 `pruneEvidence`（7 天 / 20 会话），不加新配额。
- 验证：tsc 0、build 0、**79 套件 / 1060 pass / 0 fail**（`event-bus-units` 新增「未溢出的事件也落盘，同一事件只写一次，会话换了重新记基线」）、ACCEPTANCE OK、`test:pack` 0、`test:size` 1955.6 KB / 292 文件 / 解包 15681.0 KB。
- 教训：**证据要按「会话 + 序号」记账**。只按时间或只按容量判断「要不要落盘」，最后都会出现「看起来连续、实际缺段」或者「换个会话写串目录」。

### 七十六、操作记录导出 Markdown（S73）

- 问题：事件能导 JSONL，但那是给程序读的。要把「这次让插件做了什么、哪里失败了」发给别人，得手抄。
- 做法：纯客户端——`summaryMarkdown(events, {projectDir, counts})` 生成 Markdown：抬头（工程、区间、事件数与成功/失败/其他计数）、`## 工具调用`（工具、次数、最慢一次，复用 S47 的 `toolDurations`/`durationText`）、`## 失败`（逐条 `#seq 时间 kind：摘要`，原文照抄）、`## 构建与烧录`（成功项的 FLASH/RAM 与 elf 校验和前 12 位）；`exportSummary` 以 `text/markdown` 下载 `stm32-summary-<ISO>.md`；概览页头部加「操作记录」chip。
- 只汇总不推断：失败原因由 `decodeFault` 在故障页负责，这里照抄摘要，避免同一件事在两张表里说法不一致。
- 验证：`node --check` 与 build 0、**79 套件 / 1060 pass / 0 fail**、ACCEPTANCE OK、`test:pack` 0、`test:size` 1957.5 KB / 292 文件 / 解包 15689.1 KB、client 4530 行。
- 教训：**同一条事实只解释一次**。汇总页展示原始摘要，解码结论留给故障页；两处各写一套判断，迟早互相矛盾。

### 七十七、中断优先级批量修改（S74）

- 问题：S43 只能一路一路改；手上十路要设成同一组抢占/子优先级时，点十次还得对十次备份文件。
- 做法：`src/engine/interrupts.ts` 加 `setInterruptPriorities(projectDir, names, preempt, sub)`——名字去重、逐个改 `NVIC.<name>_IRQn` 的第二、三段，**整批只备份一次、只写盘一次**；找不到的那一路进 `errors`，不影响其它路成功。路由 `POST /interrupts/priorities`（45 条）；面板每行加勾选框，选中后头部出现「已选 N 路，设为 抢/子 + 批量应用 + 清除选择」。
- 部分成功是故意的：一次改动里有一路名字写错，不该把整批回退——那会让人以为「什么都没写」，实际磁盘上已经有一个备份文件。
- 验证：tsc 0、build 0、**79 套件 / 1062 pass / 0 fail**（interrupts-units 加批量用例、web-api 加路由与缺 `names` 400 用例）、ACCEPTANCE OK（56 PASS，含「批量改中断优先级」）、`test:pack` 0、`test:size` 1959.0 KB / 292 文件 / 解包 15698.9 KB、client 4580 行。
- 教训：**批量操作的备份要按「批」算，不能按「条」算**。十条改九条成功，留九个备份文件既占地又难对账；一次批一份，日志里也只出现一次「已备份」。

### 七十八、编译警告进详情（S75）

- 问题：`stm32_build` 的警告数在事件摘要里（`warningCount`），但警告原文没进事件；面板看得到「有 18 条警告」，看不到是哪几行。
- 做法：`src/engine/tool-events.ts` 的 `resultDigest` 加 `warnings`，与 `errors` 同样截断到 20 条；客户端新增 `CompileWarnings`（与 `CompileErrors` 同为独立组件，因为有 `useState`），标题与配色区分（黄色），行仍可点开 `SourceBlock` 看上下文；`Detail` 里排在错误之后。
- 为什么警告也截断到 20：警告往往是同一条模板展开多次，前 20 条足够定位文件；完整列表仍在工具回包里，需要时可再要。
- 验证：tsc 0、build 0、**79 套件 / 1062 pass / 0 fail**（event-bus-units 断言警告截断与首条内容、client 断言 `CompileWarnings`）、ACCEPTANCE OK（56 PASS）、`test:pack` 0、`test:size` 1959.7 KB / 292 文件 / 解包 15704.0 KB、client 4631 行。
- 教训：**先让数字可追到行**。只有「18 条警告」的界面，用户下一步只能去翻构建日志；给出行号与上下文，面板才替代得了一次翻日志。

### 七十九、时钟图模式补回组件（S76）

- 问题：清点时发现 `ClockPanel` 的图模式里写了 `e(ClockFlow, {...})`，但全仓没有 `ClockFlow` 定义——点「图」会抛 `ReferenceError: ClockFlow is not defined`。S38 加的组件在某次大段替换里丢了，`node --check` 只查语法，查不出未定义引用。
- 做法：补回 `function ClockFlow(props)`——用既有 `clockFlowRows(nodes)` 摊平成层级行，缩进 16px/层、`└` 标记、条宽按最高频归一、根色深 50% 子节点 32%；超限行标黄并在行尾带 S71 的 `suggest` 建议；空数据给「没有可画的频率节点。」。
- 为什么这类 bug 能活下来：客户端没有类型检查，测试只断言「源码里出现某个字符串」，而字符串检查正好检查的是使用点而不是定义点——两处都写了 `ClockFlow` 名字，断言就过了。
- 补强：`test/client-debug-units.test.mjs` 改为断言 `function ClockFlow(`（带 `function` 前缀），把「有定义」也纳入检查；同时修掉 README 两处过期的「44 条路由」，与实际 45 条对齐。
- 验证：`node --check` 与 build 0、**79 套件 / 1062 pass / 0 fail**、ACCEPTANCE OK、`test:pack` 0、`test:size` 1960.8 KB / 292 文件 / 解包 15709.2 KB、client 4677 行。
- 教训：**断言要钉在定义侧**。检查「用了这个名字」会漏掉「名字没定义」；写成 `function X(` 才真的验证存在。

### 八十、LQFP 物理引脚图（S77）

- 问题：S35/S53 的引脚图按端口排（PA/PB/PC…），回答的是「哪一路占了哪些脚」；插线、查原理图时要的是「第 23 脚是哪个信号」，需要封装脚位。
- 事实来源：CubeMX 安装目录的 `db/mcu/<Mcu.Name>.xml`，每封装一个 `<Pin Name="PA0" Position="29" Type="I/O"/>`。插件已有解析器 `src/engine/cubemx-db.ts` 的 `parseMcuXml`，`CubemxMcuFacts.pins` 就是 `名字 → { name, position, signals }`。**所有 CubeMX 收录的型号都有这份事实**，不需要另找数据源，也不内置第三方转存。
- 做法：`src/engine/pinout.ts` 新增 `readPhysicalLayout(mcuName, pins, env)`，用 `resolveSearchConfig(env).cubeMxRoots` 找 db、`readMcuFacts` 读型号、`resolveDbPinName` 把 `.ioc` 里的别名（`PA13` 对 `SYS_JTMS-SWDIO` 等）对回 db 名；`PinoutReport.physical` 给 `{ available, packageName, pinCount, positions, reason }`。客户端加第三种视图「方框」：`pinBoxSides(physical)` 按 LQFP 逆时针规则把脚位摊到四边（1 脚左上，左侧 1..quarter 自上而下、下边自左向右、右边自下而上、上边自右向左），`PinBox` 每格显示脚号与 `.ioc` 引脚名，点击复制引用。
- 两个边界写进代码：`pinCount` 取 **最大 Position** 而不是 `facts.pins.size`——db 按名字去重，48 脚封装只有 44 个不同名字，用 size 会少 4 脚；没有 CubeMX db 时不画空方框，直接显示 `reason`（「装 CubeMX，或用 STM32_CUBEMX_ROOT 指定安装根」）。
- 验证：tsc 0、build 0、**79 套件 / 1064 pass / 0 fail**（pinout-units 加「有 db 给封装与脚号」「无 db 降级提示」两条）、ACCEPTANCE OK（新增「物理引脚布局字段齐全（S77）」）、`test:pack` 0、`test:size` 1964.0 KB / 292 文件 / 解包 15721.4 KB、client 4782 行。
- 教训：**同一个「引脚」，按端口看与按封装看是两个问题**。前者查功能冲突，后者查接线；两种视图都要有，且事实只能来自器件库。

### 八十一、证据落盘与保留可配置（S78）

- 问题：S72 之后正常会话也落盘，但节奏与保留是写死的（30 秒、7 天、20 会话）。想留长一点、或嫌写得勤，都得改代码。
- 做法：`src/engine/event-log.ts` 新增 `evidencePolicy(env)`，三项各自独立解析，优先级「环境变量 > 配置文件 > 默认」：环境变量 `DSH_STM32_EVIDENCE_FLUSH_SECONDS` / `_KEEP_DAYS` / `_KEEP_SESSIONS`；配置文件的 `evidenceFlushSeconds` / `evidenceKeepDays` / `evidenceKeepSessions`；默认 30 秒 / 7 天 / 20 会话。每项夹到 `POLICY_LIMITS`（5–3600 秒、0–365 天、1–200 会话），并返回 `sources` 说明这一项从哪来——面板据此显示「每 30 s 落盘 · 保留 7 天 / 20 会话」并可在 `title` 里看到来源。`startEventLog` 用 `policy.flushSeconds` 当拍间隔、把 `keepDays` / `keepSessions` 传给 `pruneEvidence`；`/evidence` 回 policy，`/evidence/prune` 按 policy 清。
- 两个边界：`DSH_STM32_NO_CONFIG=1` 时不读配置文件（与工具链配置同一开关，测试与验收可完全隔离）；时间间隔有下限 5 秒，避免有人把定时器开成秒级轮询把磁盘写满。
- 验证：tsc 0、build 0、**79 套件 / 1065 pass / 0 fail**（event-bus-units 加「默认值、环境变量夹取、配置文件生效」一条）、ACCEPTANCE OK（新增「证据策略字段齐全（S78）」）、`test:pack` 0、`test:size` 1965.8 KB / 292 文件 / 解包 15726.5 KB、client 4795 行。
- 教训：**可配置项要把「来源」一起报出来**。用户看到 30 秒与 60 秒的差别时，第一句话必然是「这值哪来的」；先给 `sources`，就不用再翻两份配置。

### 八十二、两套筛选并存的提示与导出范围说明（S79）

- 问题：故障页同时有「分类 chip」与「规则 chip」两套筛选，叠加后列表变短，容易以为事件丢了；导出按钮也没写清「导的是当前视图还是全部」。
- 做法：纯客户端——`FaultPanel` 在 `category !== "" && rule !== ""` 时插一行说明「分类「X」与规则「Y」同时生效」，并给「只看分类」「只看规则」两个按钮（分别清掉另一个条件）；事件导出按钮补 `title`：「导出当前显示的事件（含文字筛选与「只看失败」；勾选不影响导出范围）」。
- 为什么不做成单选互斥：两套维度确实有用（「编译类里的未定义引用」）；问题不是组合本身，而是组合后没人告诉用户现在叠加了两层。
- 验证：`node --check` 与 build 0、**79 套件 / 1065 pass / 0 fail**（client-debug-units 断言两个按钮文案同时存在）、ACCEPTANCE OK、`test:pack` 0、`test:size` 1966.2 KB / 292 文件 / 解包 15728.3 KB、client 4812 行。
- 教训：**叠加筛选要说出口**。筛选器自己不会让数据消失，但用户看到的条目变少时，第一反应是「是不是坏了」。

### 八十三、增量构建的占用兜底（S80）

- 问题：`cmake --build` 报「ninja: no work to do」时没有链接动作，链接器不打印 FLASH/RAM，面板的内存条是空的。界面看起来像坏了，实际只是「这次没量」。
- 做法：`src/engine/build.ts` 在「构建成功 + 有 elf + 日志里没有占用」时，用同一套 binDirs 找 `arm-none-eabi-size`，对现成 elf 量一次（`--format=berkeley` 的 `text data bss`），把 `text + data` 记作 FLASH、`data + bss` 记作 RAM；总量取器件事实 `findChipFact(readIocCpn(projectDir))` 的 `flashBytes` / `ramBytes`，没有事实就不硬编总量、退回原来的提示。`parseBerkeleySize` 单独导出可单测。
- 两个边界：只在构建成功时量（失败构建的 elf 可能是旧的）；`size` 找不到或输出认不出就静默退回原提示，不把构建判失败——占用是附加信息，不是构建结论。
- 验证：tsc 0、build 0、**79 套件 / 1066 pass / 0 fail**（build-units 加 `parseBerkeleySize` 一条）、ACCEPTANCE OK、`test:pack` 0、`test:size` 1967.1 KB / 292 文件 / 解包 15731.2 KB。真机「无改动构建」的占用仍需重启 DSH 后点一次构建确认。
- 教训：**「没有数据」要区分「没发生」与「没采集」**。增量构建属于后者，用现成产物补一次采集，比让用户去点「清理构建」便宜得多。

### 八十三补、真机确认与 notes 顺序修正（S80 收尾）

- 真机验证（重启 DSH 后，端口 51352，`self.routeCount === 46`）：对 demo 工程连续两次 `POST /build`，`logTail` 都是 `ninja: no work to do.`，`memoryUsage` 都有 FLASH 4836 B / 65536 B（7.4%）与 RAM 1584 B / 20480 B（7.7%），elf 653580 B —— S80 的 `arm-none-eabi-size` 兜底在真机成立。
- 发现的问题：`notes` 只写了「占用：FLASH 7.4%，RAM 7.7%」，没写「占用是量出来的」。原因是三条 `if/else if` 互斥，`measured` 分支被 `memoryUsage.length > 0` 吃掉。
- 改法：把 `measured` 的判断挪进「有占用」分支内部——先写占用百分比，再追加「本次没有重新链接；占用由 arm-none-eabi-size 直接量 elf 得到」；没有占用时才走原来的两条提示。
- 回归：`test/build-units.test.mjs` 新增 `runBuild` 用例（假 subprocess：cmake 返回 `ninja: no work to do.`、size 返回 berkeley 行；临时工程造 `build/Debug` 与 elf；断言 FLASH = text + data、RAM = data + bss、notes 里同时有「没有重新链接」与「arm-none-eabi-size」）。全量 **79 套件 / 1073 pass / 0 fail**、ACCEPTANCE OK、`test:size` 1971.2 KB / 293 文件 / 解包 15748.7 KB。
- 教训：**互斥的条件分支里，附加说明要跟着主信息走**。「有数据」与「数据从哪来」不是二选一。

### 八十四、工程与工作区自描述文件（S82）

- 问题：面板要用工程目录，但来源只有「当前调试会话的 projectDir」——没开会话时为空；同一会话换工程时，各页签各读各的，容易看串。用户提出：在工程里放一份描述文件，创建工程时在工作区根再放一份索引，两处同名、语义分层的 `dsh-stm32.conf`。
- 做法：新建 `src/engine/project-conf.ts`，整份文件是 `key=value` 行文本，`#` 注释、`project=` 可重复（工作区索引专用）。
  - 工程根 `dsh-stm32.conf`：`name` / `mcu` / `ioc` / `build` / `createdAt`，由 `stm32_project_create` 成功后写入；重写时未传的字段保留旧值、`createdAt` 只在首次生成。
  - 工作区根 `dsh-stm32.conf`：`version=1` + 若干 `project=<相对路径>`；登记幂等（已存在就返回 false，不重复追加）。
  - `GET /projects`（46 条路由）把「索引里的工程」与「工作区扫描（深度 ≤2，有 `*.ioc` 或 `CMakeLists.txt`）」合并去重，附 `current`（当前工程的 conf 内容），缺目录的条目保留但标 `exists:false`。
  - 面板用 `useProjects` 拉这份清单，工具栏 `<select>` 里「跟随调试会话」之外可显式选一个工程，选择按会话存 localStorage；`Channels` 的 `projectDir` 优先用覆盖值。
- 为什么两处同名：用户要「统一」——同一个文件名、同一套解析，只是作用域不同；比再加 `.dsh-stm32/workspace.json` 之类更好解释。
- 验证：`test/project-conf-units.test.mjs` 5 条（解析、登记幂等、缺失目录、字段重写、扫描深度）、`web-api-units` 46 条路由 + `/projects` 用例、验收加两项；全量 **79 套件 / 1072 pass / 0 fail**、ACCEPTANCE OK、`test:size` 1971.2 KB / 293 文件 / 解包 15748.6 KB。
- 教训：**描述文件要「人能读、机器能写、缺了不炸」**。解析失败返回空文档而不是抛异常；写失败只影响选择器，绝不回滚已建好的工程。

### 八十五、打开面板时载入最近证据（S81）

- 问题：重启 DSH 后环形缓冲清空，面板一开始是空的；用户以为「记录没了」，实际证据已落盘，只是要手动点「回放…」。
- 做法：`DebugConsole` 在「会话非空 + 尚未自动载入 + 实时事件为 0」时，拉 `/evidence` 取本会话最新一份（没有本会话文件就取全局最新），载入成回放，并提示「已载入最近一份历史记录（<path>）；点「退出回放」回到实时。」。用 `autoLoadedRef` 保证一个面板实例只自动载一次，避免与用户手动回放打架。
- 为什么不是「一直自动载入」：人会主动退出回放看实时；自动重载会把它拽回去。
- 验证：client 源码断言（`useProjects`、`DEBUG_PROJECT_KEY`、`已载入最近一份历史记录`）+ 全量 1072 pass + ACCEPTANCE OK。
- 教训：**空状态要自己找一次历史**。面板显示「没有事件」时，先看看磁盘上有没有，再决定要不要说「没有」。

### 八十六、演示固件与串口双向验证（S83）

- 目的：给 DAPLink + STM32F103C8T6 一个「跑起来就能点满页签」的固件，用来验收调试台。
- 固件（`demo` 工程）：主循环每圈 `g_work_loops++`、每 25 圈翻 PC13、每秒一帧 `T loops=… led=… mode=…`；串口命令 `s` 状态、`r` 清零、`l` 切 LED、`w` 忙等约 1 秒、`?` 帮助；被监视量还有 `g_uart_tx_lines` / `g_uart_rx_bytes` / `g_uart_commands` / `g_uart_errors` / `g_last_command`。工程侧改动：`HAL_UART_MODULE_ENABLED`、`cmake/stm32cubemx/CMakeLists.txt` 加 `stm32f1xx_hal_uart.c`、`demo.ioc` 补 PA9/PA10。
- 接线：DAPLink 的虚拟串口与 SWD 引脚不复用，必须 PA9→转接板的 RXD、PA10→TXD、共地。实测换了 CH340（COM5）之后才通。
- 实测：构建 FLASH 11612 B（17.72%）、RAM 2128 B（10.39%）；烧录 `programmed/verified`；SWD 两次读 `g_work_loops` 4262 → 34743；串口侧收到 `T loops=` 起始噪声与状态行；发 `l` 后固件回 `L mode=0` 且 LED 停在 264；发 `z` 回 `E unknown command 'z'`；`/channels` 的 `serial.lines` 19；等 30 秒后证据里出现 27 条 `channel:serial`，`/replay` 可原样载回。
- 顺带修：`/faults` 对「编译失败：FAILED: [code=1] …」与「找不到已配置的构建目录」两条自家文案没有规则，兜到 `other/none`。`src/engine/fault-hints.ts` 增 `build.no-build-dir`（提示先跑 cmake 配置）与 `build.cmake-failed`（提示看 errors 与 cmake/user 登记），`test/fault-hints-units.test.mjs` 增对应用例。
- 验证：`tsc` 0、build 0、**79 套件 / 1074 pass / 0 fail**、ACCEPTANCE OK、`test:pack` 0、`test:size` 1971.3 KB / 293 文件 / 解包 15749.3 KB。
- 教训：**工具自己的错误文案也要进故障规则表**。规则只认编译器原文，就会把自己的「找不到构建目录」当成未知故障。

### 八十七、工程目录不再回落到进程工作目录（S84）

- 问题：面板没打开调试会话时，引脚页显示「当前没有可用的工程目录」，变更页报「工程目录里没有 .ioc：`C:\Users\<用户>\.dsh\profiles\desktop`」——那个路径是 DSH 进程的工作目录（profile 目录），被十几处 `projectDir ?? process.cwd()` 当成工程用了。工具层早就在 `src/tools/project-dir.ts` 修过同一个洞，Web API 这一层漏了。
- 做法：`src/engine/web-api.ts` 加 `setSessionWorkspaceResolver`（由 `src/index.ts` 注入宿主 `workingDirectory.ensure`）与 `withProject(raw)`：显式 `projectDir` 优先，否则用会话工作目录，两者都没有才回 400「projectDir 不能为空：从工具栏「工程」下拉里选一个，或先打开调试会话」。所有工程类路由（pinout / clocks / interrupts / ioc-diff / ioc-diff/save / ioc-diff/restore / ioc-diff/restore-all / ioc-keys / ioc-sync / artifacts / source / build / flash）统一走它，`process.cwd()` 只剩 `/projects` 的最后一档兜底。
- 配套：`/projects` 的工作区根改为「显式 `root` → 当前工程父目录 → 会话工作目录 → cwd」；`scanWorkspaceProjects` 把工作区根自己也算一个工程（宿主常把会话目录当根，它往往正是工程目录）；客户端在既没选工程、也没调试会话时退到 `/projects` 的第一个工程（`fallbackProjectDir`），并把空状态文案改成「在工具栏「工程」里选一个，或先打开调试会话」。
- 验证：tsc 0、build 0、**79 套件 / 1077 pass / 0 fail**（新增两条：缺 `projectDir` 回 400 且提示含「projectDir 不能为空」；注入 resolver 后 `/pinout` 回 200 并读出 `STM32F103C8T6`）、ACCEPTANCE OK、`test:pack` 0、`test:size` 1972.2 KB / 293 文件 / 解包 15753.4 KB、`client/client.js` 4901 行。
- 教训：**「省略参数」与「参数为空」是两件事**。前者该去问宿主要上下文，后者该被明确拒绝；用 `process.cwd()` 同时兜这两件事，等于把错误变成一个看起来合理的路径。

### 八十八、工程目录的第三档：最近一次用过的工程（S84b）

- 问题：S84 让工程类接口在缺 `projectDir` 时先问会话工作目录，实测 `/projects` 仍把 profile 目录当工作区——`workingDirectory.ensure(undefined)` 在没有 agent 时给不出目录，resolver 只能返回空串。
- 做法：
  - 新增 `src/engine/session-context.ts`：`noteSessionAgent(agent)` / `lastSessionAgent()`，只存最近一个 agent；`src/index.ts` 的 `session/event` 处理器每轮记一次（`session.agent`），`src/tools/project-dir.ts` 在工具入口也记一次。
  - 新增 `src/engine/workspace-memo.ts`：`workspaceMemoPath`（默认 `~/.dsh-stm32/last-workspace.txt`，`DSH_STM32_HOME` 覆盖根）、`rememberWorkspace`（写失败静默）、`recallWorkspace`（读不到空串）。`resolveProjectDir` 定下目录后记一笔。
  - `web-api` 的兜底链变成「显式 → 会话工作目录 → 最近一次用过的工程 → 空（400）」；`/projects` 的工作区根同样多一档 `memoDir`。
- 验证：79→**80 套件 / 1080 pass / 0 fail**（新增 `workspace-memo-units` 3 条与 `/pinout` 走备忘的用例；两条重复的 S84 用例合并，并用临时 `DSH_STM32_HOME` 隔离，否则本机备忘会把 400 用例变成 200）、ACCEPTANCE OK、`test:pack` 0、`test:size` 1973.4 KB / 295 文件 / 解包 15756.7 KB。
- 回归隔离：`test/run-units.mjs` 现在整轮设 `DSH_STM32_HOME` 到临时目录——`resolveProjectDir` 每跑一次都会写备忘，不隔离时会把开发机真实 `~/.dsh-stm32/last-workspace.txt` 改成测试夹具路径，反过来让 web-api 的「缺参数回 400」用例变成 200。
- 教训：**兜底链要一档一档可验证**。加了「会话目录」这一档不等于拿得到它——resolver 拿不到的输入（agent）要显式补上，否则新档位永远命中不了。

### 八十九、工程根已是工程时不再向下扫描（S84c）

- 现象：S84b 上线后 `/projects` 能解析到真实工作区，但 `entries` 里除了 `demo` 还有 `stm32cubemx`、`user`、`probe-c0`、`_rich_hal`——它们都是工程内部目录（`cmake/stm32cubemx`、`cmake/user` 里有 `CMakeLists.txt`）。
- 修：`scanWorkspaceProjects` 先判断根自身是不是工程（根下有 `*.ioc` 或 `CMakeLists.txt`）；是就**直接返回根**，不再往下扫。工程内部的 `cmake/`、`build/`、`Drivers/` 都会命中标记，深扫一定出噪音。
- 验证：`project-conf-units` 加「根是工程时不把内部 `cmake/stm32cubemx` 当独立工程」一条；全量 **80 套件 / 1081 pass / 0 fail**（`serial-units` 偶发 1 条失败，重跑全绿，仍是 PowerShell 桥时序）、ACCEPTANCE OK、`test:pack` 0、`test:size` 1973.6 KB / 295 文件 / 解包 15757.0 KB。
- 教训：**「向下扫描」要先确认上级不是目标**。层级扫描的第一条规则应该是「当前目录是不是就在找的东西」，否则一定把工程内部当邻居。

### 九十、引脚面板空白：head 里用了后声明的 const（S84d）

- 现象：S84b 修好工程目录后，点「引脚」整块面板变空白——没有报错文字，也没有加载提示。
- 定位：写了一个临时渲染探针（把 `client/client.js` 里的 `PinoutPanel` 挂到 `globalThis`，用桩 React + 脚本化的 `useState` 队列喂一份 `/pinout` 数据真跑一次），立刻复现 `ReferenceError: Cannot access 'totalPins' before initialization`（`client/client.js:2249`）。
- 根因：S59 给 head 加了「导出 CSV」按钮，按钮里读 `totalPins` / `hitPins`，而这两个 `const` 声明在 head 之后。数据没回来时走「读取引脚表…」分支不碰它们；等 `/pinout` 真返回、进入正常分支，就撞上 TDZ ——首屏正常、数据到达即白屏。
- 修：把 `allGroups` / `groups` / `totalPins` / `hitPins` 的计算整体提到 `const head = []` 之前，并写明「head 里要用，必须先算」。
- 回归：新增 `test/pinout-render-units.test.mjs`——桩 React + `useState` 队列，分别以 `table` / `map` / `box` 三种视图渲染 `PinoutPanel`，断言不抛错且内容正确；再加一条「没有工程目录时给提示而不是空白」。`test/run-units.mjs` 登记；**80 套件 / 1085 pass / 0 fail**。
- 验证：`npm run build` 0、ACCEPTANCE OK、`test:pack` 0、`test:size` 1973.9 KB / 295 文件 / 解包 15757.4 KB、`client/client.js` 4903 行。
- 教训：**`const` 的「先声明后使用」在渲染函数里会被分支掩盖**。加载分支不碰它，数据到达那一刻才炸，所以只测「能打开」不够，必须用真实数据渲染一遍。

### 九十一、时钟面板空白：钩子写在早退之后（S84e）

- 现象：修好引脚页白屏后，点「时钟」整块面板也变空白。
- 根因：`ClockPanel` 的 `const [mode, setMode] = useState("table")` 写在三个早退（无工程 / 出错 / 读取中）之后。首帧 `clocks === null` 走「读取时钟树…」直接返回，**没有调用这个钩子**；`/clocks` 数据到达后第二帧才开始调它——钩子数量变化，React 直接抛错并卸载面板。
- 与 S84d 的区别：S84d 是 `const` 的 TDZ（数据到达那一刻才炸），S84e 是**钩子顺序不稳定**（首帧少一次 hook）。两种都只在「数据回来」时暴露，所以只看首屏正常是不够的。
- 修：把 `useState` 提到函数第一行、早退之前；`nodes` / `peak` 仍在早退之后算，它们不是钩子。
- 检查：写了个括号配平的扫描脚本，把 `client/client.js` 里每个 `function X(props)` 内「顶层早退语句之后才出现的 useState/useEffect/useRef/useCallback」都列出来——改完这一处之后全仓 0 命中。
- 回归：`test/pinout-render-units.test.mjs` 扩成双面板渲染测试，新增「时钟面板在 table / flow 视图下能渲染」「没有工程目录时给提示」三条（桩 React 的 `useState` 队列顺序按真实调用顺序喂：`mode` → `clocks` → `error` → `tick`）。**80 套件 / 1088 pass / 0 fail**。
- 验证：`npm run build` 0、ACCEPTANCE OK、`test:pack` 0、`test:size` 1974.2 KB / 295 文件 / 解包 15757.8 KB。
- 教训：**有早退的组件，钩子必须写在第一条语句附近**。规则本身简单，难的是「首屏正常」造成的错觉；渲染回归测试要用「数据已到达」的状态跑，而不是初始状态。

### 九十二、面板视觉优化（S85）

- 问题：功能齐了，但看起来像调试输出——全内联样式，按钮没有 hover、输入框没有焦点环、标签没有选中态、滚动条是浏览器默认，面板与背景糊在一起。
- 做法分两层：
  1. **令牌层**：只调 `debugStyles` 的公共值，不动任何结构——页面留白 12/14、行高 1.55、面板圆角 10px 并给 `color-mix(currentColor 2%)` 底色、面板标题带 3% 底、行距 5/12、输入与按钮圆角 8px 且带 3% 底、空状态居中、时间戳换等宽字体。
  2. **样式表层**：`DEBUG_CSS` + `ensureDebugStyleTag()` 注入一段只作用于 `.d32-page` 的样式，补内联做不到的四类：hover/active、`:focus-visible` 焦点环（强调色 `#e8b339`）、标签选中态（底部 2px 强调色 + 6% 底）、状态色（行左 2px：失败 `#e5484d`、成功 `#3fb950`、开始 `#4a9eff`），以及 9px 的自绘滚动条。
- 为什么不全改成 CSS 类：57 处 `debugStyles.button` 全部重写风险远大于收益；「元素级选择器 + 少量类名（`d32-page` / `d32-tabs` / `d32-tab` / `d32-row`）」既拿到 hover 与焦点，又不碰任何业务分支。
- 为什么用 `color-mix(in srgb, currentColor N%)` 而不是固定色：面板活在宿主主题里，浅色/深色都要跟；`currentColor` 混一混就自适应，只在强调与状态处用固定色。
- 验证：`node --check` 与 build 0、**80 套件 / 1088 pass / 0 fail**、ACCEPTANCE OK、`test:pack` 0、`test:size` 1976.7 KB / 295 文件 / 解包 15765.3 KB、client 4954 行；新增两条源码断言（`d32-page`、`ensureDebugStyleTag`）。
- 教训：**观感问题优先在令牌层解决**。改圆角、留白、层次与状态色，比重排组件结构便宜得多；只有在「内联做不到」的地方（hover/焦点/滚动条）才值得引入样式表。

### 九十三、时间线与详情合并成「事件」页签（S86）

- 问题：停靠网格把时间线、实时通道、详情、控制台四块挤在一屏，看任何一个都要在几条竖线之间来回扫；工作区页签还藏在右栏，位置比时间线低一级。
- 做法：撤掉左侧「时间线」停靠面板与详情面板，改成与实时通道/引脚/时钟同级的「事件」页签；页内左右两栏仍是时间线 + 详情（时间线 `flex: 1 1 55%`、详情固定 380px），拖动分栏改宽的交互去掉，靠页签切换而非拖拽。
- 保留：筛选条（文字、只看失败、按耗时、工具名 chip、复制已选、导出、回放、工程选择）仍在页签之上，因为它对「事件」页是主操作；控制台仍在底部。
- 默认页签仍是「实时通道」，没有改成「事件」：默认落在最常看的会话与串口状态上，事件页一点即到。
- 验证：`node --check` 与 build 0、**80 套件 / 1088 pass / 0 fail**、ACCEPTANCE OK、`test:pack` 0、`test:size` 1977.0 KB / 295 文件 / 解包 15765.9 KB、client 4962 行；测试改为用页签名钉住入口（默认页签下不再渲染详情），并保留「事件详情仍是独立组件」的源码断言。
- 教训：**布局复杂度要靠信息层级降，不是靠可拖拽**。四个面板挤一屏时用户要的是「先看哪块」，给页签比给分隔条有效。

### 九十四、超限建议要按「分频器挂在谁身上」算（S87）

- 问题：时钟页对 ADC 给的建议是「把分频改成 ÷4（9 MHz）」。9 MHz 是 36÷4 算出来的，可 ADC 预分频并不除当前 ADC 频率，它除的是 PCLK2（72 MHz）——真按 ÷4 配，ADC 是 18 MHz，照样超限；正确的最小档是 ÷6（12 MHz）。APB1 / APB2 同理，分频器除的是 HCLK，不是上次分频后的结果。
- 做法：`suggestFix(label, hz, limitHz, baseHz)` 增加 `baseHz`（父时钟频率）：`readClockTree` 里 ADC 传 `RCC.APB2Freq_Value`、`PCLK1` / `PCLK2` 传 `RCC.AHBFreq_Value`；文案改成「把 ADC 预分频改成 ÷6（12 MHz）」「把 APB1 分频改成 ÷2（36 MHz）」，明确说改的是哪一级分频器。`baseHz` 缺失时退回以当前频率为基准，并在文案里保持保守。
- 顺带修一个误报：.ioc 里没有 ADC 外设时，`RCC.ADCFreqValue` 只是 CubeMX 顺手算的派生键（本项目就是 36 MHz，默认 ÷2），不是真在用的时钟。现在会写成「工程没有启用 ADC，这条不影响运行；启用时把 ADC 预分频改成 ÷6（12 MHz）」，既不装作没看见，也不制造「配置错了」的错觉。
- 验证：`tsc` 0、build 0、**80 套件 / 1088 pass / 0 fail**（clocks-units 9 pass，含 `suggestFix` 三条直接断言）、ACCEPTANCE OK、`test:pack` 0、`test:size` 1977.4 KB / 295 文件 / 解包 15767.1 KB；真机工程 `readClockTree` 输出即「工程没有启用 ADC，这条不影响运行；启用时把 ADC 预分频改成 ÷6（12 MHz）」。
- 教训：**建议的准确性取决于基准选对没有**。给「除以几」时，先问这个分频器除的是哪一路时钟；拿结果频率再去除，只会得出看着合理、实际配不出来的档位。

### 九十五、面板视觉对齐「编队」页（S88）

- 问题：S85 的视觉优化仍是「自成一套」——警告色写死 `#e8b339`、边框用 `currentColor` 混色、没有卡片阴影。放在宿主页面里像外挂面板。
- 取证：编队页由 `dsh-context/lib/client.js` 提供（`conversation.view` 的 `id:"fleet"`），样式全部取宿主设计令牌：卡片 `--dsw-alias-bg-layer-1` + `--dsw-alias-border-l2` + `border-radius:10px`，根字号 13px，分段控件 `--dsw-alias-bg-layer-2`，选中项 `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground`，hover `--dsw-alias-interactive-bg-hover`，细线用 `.5px`。
- 做法：`debugStyles` 全量换令牌（背景分层、边框 l1–l4、文字 primary/secondary/tertiary、等宽字体 `--ds-font-family-code`、卡片阴影 `--dsw-shadow-lv1`）；`DEBUG_CSS` 里标签条做成分段控件（`bg-layer-2` + padding 2 + gap 2），选中标签用主按钮填充色，行状态色改用 `--dsw-alias-state-error/success/business-primary`；`#e8b339` 收敛成一个常量 `D32_WARN = var(--dsw-alias-state-warn-primary)`，徽标文字色改用 `label-primary-foreground`。
- 为什么保留 `d32-*` 类名：57 处 `debugStyles.button` 的调用点不动，类名只承载 hover/焦点/分段这些内联做不到的部分。
- 验证：`node --check` 与 build 0、**80 套件 / 1088 pass / 0 fail**（`serial-units` 偶发 1 条失败、重跑全绿，判为 PowerShell 桥时序）、ACCEPTANCE OK、`test:pack` 0、`test:size` 1978.3 KB / 295 文件 / 解包 15769.2 KB。
- 教训：**「像宿主自己的页面」比「有设计感」重要**。抄令牌而不是抄色值，主题切换时才不会掉链子。

### 九十六、面板改瑞士国际主义，底色跟宿主走（S89）

- 用户 (m07178) 从四套备选里选了 01 瑞士国际主义（克莱因蓝），并追加一条硬约束：**底色不能是白色，宿主深色就深色、宿主浅色就浅色**。
- 做法（只动视觉层，布局与交互不动）：
  - 版式取风格 B 的四条：全无衬线、直角、发丝线、等宽大写小标 + 单一强调色。`D32_LABEL_MONO` 统一小标（`10.5px` / `letter-spacing .14em` / `uppercase` / 等宽），栏目标题、状态项、只读提示都用它。
  - 颜色全部走宿主令牌，强调色在 `DEBUG_CSS` 落成 `--d32-accent: var(--dsw-alias-state-business-primary)`：焦点环、选中页签下划线、勾选描边、运行中的行状态条、状态点都取它。深色下宿主的 business-primary 会自动换成浅蓝，不必自己算。
  - 底色不自写：`page` 透明（继承会话视图背景），面板用 `bg-layer-1`、代码块与输入用 `bg-layer-2`，文字用 `label-primary/secondary/tertiary`——深浅切换由宿主给值。
  - 页签从「填充式分段控件」改成「文字 + 选中项 2px 下划线」，状态行从卡片改成一条发丝线到页脚，面板与抽屉去掉圆角与阴影；事件行保留 2px 方角内阴影标状态（fail 红 / ok 绿 / start 强调色）。
  - 圆角用一条兜底 `.d32-page, .d32-page * { border-radius: 0 !important; }` 归零：内联圆角有 35 处，逐个改只会漏。
- 取舍：没有搬 01 备选的右侧栏（会话卡、监视曲线、产物占用条）。真实面板的事件页是「时间线 + 详情抽屉」的停靠网格，搬右栏等于重做布局；这一轮先把视觉语言统一，结构改动留到有需求时再说。
- 验证：`node --check` 与 build 0、**80 套件 / 1088 pass / 0 fail**（`client-debug-units` 增 5 条样式断言）、ACCEPTANCE OK、`test:pack` 0、`test:size` 1979.8 KB / 295 文件 / 解包 15772.0 KB；`client/client.js` 5021 行。
- 教训：**主题一致性靠令牌，个性靠几何与字号**。把圆角、阴影、填充全撤掉，只留一个强调色与一套等宽小标，面板立刻不像外挂；底色更是一条都不能自己写——写一个白，深色主题下就是一块补丁。

### 九十七、原理图：KiCad 10 解析、PCB 对账与模块框图（S90）

- 用户 (m07547) 提出让插件读懂原理图。四条路线里先做 KiCad（PDF 暂缓）：KiCad 10 的图纸是 S-expression，符号库内嵌在 `lib_symbols`，不需要安装 KiCad，也不需要 `sym-lib-table`——这是确定性最高、可以纯 TypeScript 做的一条。
- 解析分四步：`sexpr.ts` 词法 + 树；`kicad-sch.ts` 抽图纸、符号实例、导线、标号、结点、no-connect 与库引脚；`transform.ts` 把库坐标摆到图纸坐标；`nets.ts` 用并查集建网。
- 坐标变换是本轮唯一的硬骨头。库坐标 +y 向上、图纸 +y 向下，实例 `(at cx cy rot)` 又要顺时针转，镜像还有 `(mirror x)` / `(mirror y)` 两种。按「先取反 y → 镜像 → 顺时针旋转」实现后，用「引脚落点与导线端点重合率」打分：**122/145（84.1%）** 精确重合（0.02 mm），另一假设 78.6%，都不取反只有 66–70%。选择依据来自数据，不是猜。
- 建网规则：导线两端按 0.02 mm 取整后合并；标号吸收最近的导线端点或线身（0.35 mm）；同名本地标号合并；电源符号按值合并；`no_connect` 单独标记。
- 验收不看「像不像」，看能不能对上出货数据：主控 `U18` 的 20 个脚，原理图解析出的网络与 `D_NFC.kicad_pcb` 焊盘网络 **20/20 一致**；全板 25 个有名字、≥2 焊盘的网络 **23 个连通性一致**，`GND` / `VCC` 各被拆成两段（原因都是电源符号直接压在引脚上、没有压在导线上），**没有任何错误合并**。单张 279 KB 图纸全流程 0.21 s。
- 规则按实测放宽或收紧，避免把解析噪声报成设计错误：SWD 与 BOOT0 按网络名认（KiCad 的 STM32 符号里 PA13/PA14 是普通脚，调试口只体现在网络名）；`no-connect.conflict` 只对有人起名字的网络报；`pcb.net-split` 降为 warning；PCB 名字不一致只在「两边都是人起的名字」时比较，自动名（`N$12` / `Net-(...)`）不可比。
- 模块框图（S90 的面板页签）不画原理图，只回答「哪两块电路连在一起、走什么总线」：无源器件不单独成框，自动网络名不画线，同一对框之间的多条网络合成一条，标签优先写总线（`SCL+SDA → I2C`）。本板因此得到 `U17—U18 I2C`，正是用户举例要看到的样子。框按连接数排序，读图时先看到与主控关系最密的模块。
- 工具：`stm32_sch_read`（图纸树 / 元件 / 网络 / 框图）、`stm32_sch_pins`（引脚矩阵 + CubeMX 数据库给出的信号候选）、`stm32_sch_check`（原理图检查 + `.ioc` 与 `.kicad_pcb` 对账）。只读，不改原理图，也不改工程配置。
- 验证：`test/schematic-units.test.mjs` 13 条（含夹具回归）、全量 **1101 pass / 0 fail**、ACCEPTANCE OK（新增夹具解析、I2C 连线、PCB 对账、空目录 404 四项）、`test:size` 1970.6 KB / 303 文件 / 解包 15792.9 KB。
- 教训：**解析器的正确性要用外部数据反证**。自己写的 S-expression 遍历器能把任何输入「解析成功」，只有拿 PCB 的焊盘网络对一遍，才知道坐标变换与并查集是不是真的对。另一个教训是词法与数值：`Number(node[1])` 在传入字符串时取的是第二个字符（`"-12.7"` → `1`），这类错误不会抛异常，只会让所有坐标悄悄变形。

### 九十八、调试台按会话隔离工程与调试会话（S91）

- 用户反馈：在另一个工作区打开调试台，明明那里没有工程，却显示本工作区的工程与调试信息。
- 三个跨会话兜底叠在一起，才造成这个现象：
  - Web API 没有 agent，`withProject()` 缺 `projectDir` 时用「最近一次工具调用带来的 agent」向宿主换会话工作目录，而这个 agent 是进程级的最后一个，与当前请求无关。
  - 再退一步读 `~/.dsh-stm32/last-workspace.txt`，那是上一轮工作区的备忘，同样与请求无关。
  - `/projects` 缺根目录时按上面两条算，于是把别的工作区的工程索引整个列了出来；面板的 `fallbackProjectDir` 取列表第一个，后续所有页签都按它请求。
- 改法是把「当前会话」从请求一路带到解析：
  - `src/engine/session-context.ts` 由「只记最后一个 agent」改为「按会话 id 记 agent」（上限 64 条，满了丢最早）。
  - `src/index.ts` 的 `session/event` 用 `sessionIdOf(session)` 取 `session.header.id`，连同 agent 一起登记；`setSessionWorkspaceResolver` 的签名改为 `(sessionId) => Promise<string>`，只解析登记过的会话。
  - `src/engine/web-api.ts`：`handleWebApi` 读请求里的 `session` 参数，缺省或查不到就解析为空串；`withProject()` 只走「显式 → 本会话 → 空」，删掉备忘与最后一个 agent 两条兜底；`/projects` 在没有根目录时直接返回空列表并说明原因，不再退到 `process.cwd()`。
  - `client/client.js`：`callApi()` 统一附带 `session=<当前会话 id>`（`withSessionParam`），面板挂载时 `setApiSessionId(props.sessionId)`；`/status` 原先手写的 `session=` 也被这条统一逻辑覆盖。
- 调试会话本身同样要判归属：`SessionReport` 增 `owner`（启动它的 agent id，工具层早已记录），新增 `debugSessionForeign(sessionId, owner)`。别的会话在调试时，`/debug` 返回 `active:false, foreign:true` 并清空工程目录、断点、命中与 gdb 输出，`/debug/breakpoints` 直接 409 提示去启动它的会话里操作。owner 在工具输出里是内部标记，`publicSession()` 会剥掉，避免 `sessionSchema` 的 `additionalProperties:false` 校验失败。
- 验证：`test/session-context-units.test.mjs` 3 条（对照表、容量淘汰、归属判定）；`test/web-api-units.test.mjs` 改为「按会话 id 兜底，别的会话与无会话 id 都回 400」，并新增「没有会话工作目录时 `/projects` 返回空列表」。全量 **82 个套件 / 1105 pass / 0 fail**，ACCEPTANCE OK，`test:size` 1972.8 KB / 303 文件 / 解包 15799.5 KB。
- 教训：**兜底链里任何一环只要是进程级的，就会把别的会话的状态借过来**。「最近一个」这类变量在单会话脚本里很方便，在多会话界面里等于数据泄漏；要么把身份一路带下去，要么宁可返回空并说明原因。

### 九十九、工具层按 agent.id 登记会话（S92）

- 起因：按 S91 实测调试台时发现另一条路径仍然断着。`session/event` 里用 `sessionIdOf(session)` 取 `session.header.id`，但宿主实际给的对象未必带这个字段；取到空串时只更新了兜底引用，按会话 id 的表始终是空的。
- 后果：`/projects`、`/pinout` 等接口按 `session=` 查不到工作目录，面板只能显示「没有可用的会话工作目录」。这与设计意图相反——该提示本应只在「这条会话确实没有工程」时出现。
- 改法：`src/engine/session-context.ts` 的 `noteSessionAgent()` 同时按「传入的会话 id」与「agent 自己的 id」记两份（都走同一个容量上限）；`src/tools/project-dir.ts` 改为 `noteSessionAgent(exec.agent.id, exec.agent)`——工具层是唯一稳定带着 agent 的地方，而调试台注入的会话 id 与 `exec.agent.id` 是同一个值（证据目录名即此值）。
- 验证：`test/session-context-units.test.mjs` 增 1 条（agent.id 单独登记、两把钥匙都能开），全量 **82 个套件 / 1106 pass / 0 fail**，ACCEPTANCE OK，`test:size` 1973.6 KB / 303 文件 / 解包 15801.3 KB。
- 教训：**宿主没公开的事件结构不能当作已确认的事实**。`session.header.id` 是猜的，猜错时不会报错，只会让功能静默退化；凡是「取不到就降级」的分支，都要有另一条来自真实调用链的登记路径兜住。

### 一百、原理图工具没把 exec 传下去（S93）

- 起因：S92 之后重启，面板仍显示「当前没有可用的工程目录」。同一次会话里，不带 `projectDir` 的两个工具结果相反：`stm32_doctor` 能解析出 `D:\JingYu\Desktop\c8t6_vscode_test\demo`，`stm32_sch_read` 却落到 `C:\Users\Admin\.dsh\profiles\desktop`（插件进程的 cwd）。
- 结论：宿主 `workingDirectory` 服务是好的，断在参数传递。`src/tools/schematic.ts` 三处 `resolveProjectDir(ctx, args.projectDir, {} as ToolExec)` 传的是空对象，`exec.agent` 恒为 undefined——既登记不了会话对照表，也换不到会话目录，只能走 `process.cwd()` 兜底。
- 改法：三个工具（`stm32_sch_read` / `stm32_sch_pins` / `stm32_sch_check`）的 `execute` 增第二参 `exec: ToolExec` 并原样传进 `resolveProjectDir`。全仓再查 `{} as ToolExec` 已无残留。
- 验证：`test/schematic-units.test.mjs` 增 1 条（不带 `projectDir`、只给 `exec.agent`，应解析出夹具并登记会话），全量 **82 个套件 / 1107 pass / 0 fail**，ACCEPTANCE OK，`test:size` 1973.6 KB / 303 文件 / 解包 15801.3 KB。
- 教训：**新工具照抄旧工具时，最容易漏掉的是第二个参数**。类型上 `{} as ToolExec` 能过编译，运行时只是静默降级；凡是「拿不到身份就换默认值」的接口，写完要立刻用一个真 agent 跑一遍，否则缺陷会以「功能不生效」的形态出现在用户那里，而不是出现在错误里。

### 一百零一、面板首次打开没有默认工程（S94）

- 起因：S93 之后面板仍只有空态。实测新进程 `/status` 的 `sessionKey` 是空串，`/projects?session=<上一进程记下的 id>` 为空列表——对照表是进程内内存，重启即清零；而面板打开调试台本身不触发任何 STM32 工具，于是「先调用一次工具才登记」的设计天然失效。
- 改法：不再等工具调用。`src/engine/session-context.ts` 增 `noteSessionDir()` / `sessionDirOf()`（与 agent 表同一套写法归一：原文、裸 UUID、补 `session-` 前缀），`src/index.ts` 监听宿主 `agent/created`，用 `workingDirectory.ensure(agent)` 换出工作目录并记下；请求侧的 resolver 先读这份快照，再退回 agent 表。
- 效果：进程启动后 agent 一创建就有「会话 → 工作目录」，面板第一次打开即可给出默认工程；工具调用路径保持原样，两条来源互不覆盖。
- 验证：`test/session-context-units.test.mjs` 增 2 条（三种写法命中且不串会话、`agentIdOf` 形状校验），全量 **82 个套件 / 1109 pass / 0 fail**，ACCEPTANCE OK，`test:size` 1974.1 KB / 303 文件 / 解包 15802.9 KB。
- 教训：**「第一次用的时候顺手登记」在进程重启后会变成「永远登记不上」**。凡是面板强依赖的索引，都要在对象创建时主动填充，而不是指望某条业务路径顺带完成。

### 一百零三、工程目录约定：程序、硬件与配置各归其位（S95）

- 起因：两件事同时暴露。工程下拉里出现 `probe-c0`、`_rich_hal`、`a5`、`blink`、`m6` 等十几项——旧扫描器把「含 `CMakeLists.txt` 的目录」都当工程；而原理图页在真实工程上报「工程里没有 `.kicad_sch`」——`demo.ioc` 在根、KiCad 工程在 `D_NFC_V1.3_1.1.2/`，两者不在同一层，只按工程根找图纸必然落空。
- 约定：一个工程由三块组成，位置可以显式写进 `dsh-stm32.conf`，也可以按名字自动识别。程序目录候选 `program` / `firmware` / `app` / `user` / 工程根；硬件目录候选 `hardware` / `kicad` / `hw` / `pcb`；配置与基线固定放 `<工程>/.dsh-stm32`（与 `.vscode` 同级）。两者都没命中时，按深度 ≤2 扫 `*.kicad_pro` / `*.kicad_sch`，跳过 `.history`、`build`、`node_modules`、`Gerber`、`bom`。
- 改法：新增 `src/engine/project-layout.ts` 的 `resolveProjectLayout()`，一次算出三块目录并附 `notes`（判定依据）；`ProjectConf` 增 `firmware` / `hardware` 两个键；读 `.ioc` 的接口一律走 `firmwareDir`，`/schematic` 与原理图工具走 `hardwareDir`；面板原理图页的汇总行显示当前硬件目录名。
- 扫描器：标记收敛为 `.ioc`、`CMakeLists.txt`、`*.kicad_pro`、约定子目录（`program`/`firmware`/`hardware`），以及「写了 `mcu=` / `firmware=` / `hardware=` 的 `dsh-stm32.conf`」。单有同名 conf 不再算工程——工作区根用的也是这个文件名，早期实现因此把父目录也列成工程。命中工程后不再下钻，工程根只列它自己。
- 效果：`resolveProjectLayout("D:/JingYu/Desktop/c8t6_vscode_test/demo")` 返回 `firmwareDir = demo`、`hardwareDir = demo\D_NFC_V1.3_1.1.2`——不改目录结构也能读到原理图；13 项噪音从下拉里消失，只剩真实工程。
- 验证：新增 `test/project-layout-units.test.mjs`（6 条），登记进 `test/run-units.mjs`；全量 **82 个套件 / 1115 pass / 0 fail**，ACCEPTANCE OK，`test:size` 1976.6 KB / 304 文件 / 解包 15802.0 KB。
- 教训：**「哪里是工程」是要写进约定的，不能让扫描器猜**。猜的代价不是多列几项，而是用户在正确的工程里看到一个空面板；同时，配置文件名与工作区索引文件同名时，单看文件存在与否一定会误判，必须看它写了什么。

### 一百零四、真实工程改成分层目录，工具层按程序目录解析（S96）

- 现场改造：把 `D:/JingYu/Desktop/c8t6_vscode_test/demo` 从「程序、KiCad、旧探针混在根上」改成三块——`program/`（`CMakeLists.txt`、`CMakePresets.json`、`Core`、`Drivers`、`cmake`、`test`、`demo.ioc`、启动文件与链接脚本、`openocd.cfg`）、`hardware/`（KiCad 工程整目录上提，`.kicad_pro` / `.kicad_sch` / `.kicad_pcb` 直接在 `hardware/` 下）、`.dsh-stm32/`（配置与基线，保持在根）。旧探针工程、日志与打包产物移到工作区外的 `_archive_demo/`，`build/` 删除后重建。
- 配置文件：工程根 `dsh-stm32.conf` 写 `firmware=program`、`hardware=hardware`、`ioc=program/demo.ioc`、`build=program/build`。工作区根与工程根是同一个目录，索引与工程事实共存于一份文件。
- 连带修正：
  - `writeProjectConf()` 改为保留不归它管辖的行。此前每次写工程描述都会整份重写，把工作区 `project=` 索引一起删掉——工程即工作区时这是必然发生的缺陷。
  - `src/tools/project-dir.ts` 新增 `resolveFirmwareDir()`：先按老规则定工程根，再按约定取程序目录；解析不出程序目录时退回工程根，老工程行为不变。
  - 14 个固件相关工具（build / flash / generate / debug / debug-session / doctor / ioc-apply / ioc-inspect / ioc-plan / ioc-verify / code-patch / regs / route-plan / rtt）改用它；原理图工具与 `project_export` 仍以工程根为准，前者自己解析硬件目录，后者要打包整棵工程树。
  - `.vscode/launch.json` 与 `c_cpp_properties.json` 的 `cwd`、`executable`、`compileCommands` 指到 `program/`，VS Code 里 F5 与 Ctrl+F5 仍按原方式可用。
- 复核：`cmake --preset Debug` + `cmake --build --preset Debug` 在 `program/` 下通过（FLASH 11612/65536、RAM 2128/20480，与搬迁前一致）；`resolveProjectLayout()` 返回 `firmwareDir = demo\program`、`hardwareDir = demo\hardware`；`/pinout`、`/clocks`、`/schematic`、`/artifacts`、`/ioc-sync` 全部 200，`/schematic` 仍读到 43 元件 / 35 网络，`/artifacts` 的 `buildDir` 落在 `program/build/Debug`。
- 验证：新增 1 条工具层单测（工程根 → 程序目录、老工程保持原样），全量 **82 个套件 / 1116 pass / 0 fail**，ACCEPTANCE OK，`test:size` 1977.3 KB / 304 文件 / 解包 15803.9 KB。
- 教训：**「工程根」与「程序目录」是两个概念，工具不能默认它们相同**。分层之后，凡是读写源码、`.ioc`、构建产物的入口都必须显式落到程序目录；而唯一知道目录结构的地方应该只有 `resolveProjectLayout()`，其余调用点不要自己拼路径。

### 一百零五、电路设计：tscircuit 写板、kicad-cli 验收（S97）

- 目标：让插件能画原理图与 PCB、导出 STEP，并且画出来的板子要能被 KiCad 自己认。写者只保留一个——tscircuit 生成 `.kicad_sch` / `.kicad_pcb`，插件不直接改 KiCad 文件；验收交给 `kicad-cli` 的 ERC 与 DRC。
- 取证（决定了架构）：
  - 本机 KiCad 10.0.7 的 `kicad-cli` 支持 `sch erc --format json`、`pcb drc --format json`、`pcb export step`，全部无头可用；报告键为 ERC `sheets[].violations[]`、DRC `violations[]` / `unconnected_items[]` / `schematic_parity[]`。
  - `tsci build --kicad-project --svgs` 能一次产出 `circuit.json`、原理图/PCB 的 SVG 与真 KiCad 工程；但 Node 直接跑 `.tsx` 报 `Unknown file extension ".tsx"`，**必须用 KiCad 自带的 bun**（`<KiCad>/bin/bun.exe`）。
  - 五个社区的 KiCad MCP 都是 Python + KiCad IPC/GUI，要求编辑器正在运行；本插件是零运行期依赖的 TS 进程，直连 `kicad-cli` 更短、更可测，MCP 只留作「GUI 在环」的可选后端。
  - 真机 STEP 导出会因缺 3D 模型打印 `Could not add 3D model for <Ref>. File not found`，模型缺失不阻断导出——这属于「要报告，不要失败」。
- 分层：`src/engine/ecad/toolchain.ts` 定位 KiCad 与 bun、拼 `KICAD10_3DMODEL_DIR` 等环境；`tsci.ts` 定义 `hardware/{circuit,kicad,libs,out}` 工作区、写最小 `package.json`、拼 `tsci build` 参数、找最近一次产物；`checks.ts` 跑 ERC/DRC 并收敛成 `rule/severity/message/items`，外加 STEP 导出；`src/tools/ecad.ts` 提供 `stm32_ecad_init` / `build` / `check` / `step` 四个工具。
- 实测（`hardware/circuit` 下一个 5 元件样例）：构建 16 s 出 `dist/index/kicad/{index.kicad_sch,index.kicad_pcb}`；ERC 2 error（`pin_not_connected`）+ 6 warning；DRC 1 error（走线 0.15 mm 低于 0.2 mm 约束）+ 4 warning；STEP 50702 B / 507 ms。
- 过程中修掉的自身缺陷：
  - **快照会过期**：`planEcadWorkspace()` 把 `initialized` 算在对象里，初始化之后立刻构建仍报「工作区还没初始化」；改成构建时现场看 `circuit/package.json`。
  - **漏传 ctx 会静默降级**：`projectDirOf()` 第一版写成 `resolveProjectDir(undefined, …)`，拿不到会话工作目录就落到插件进程的 cwd；改成显式传 `ctx`。
  - **显式覆盖必须唯一**：`DSH_STM32_KICAD_ROOT` 指到不存在的目录时，旧逻辑会悄悄回落到默认安装，问题被藏起来；改成「指了就用它，找不到就报错」。
  - **正则别把解释一起吃进去**：缺失模型的第一版正则把 `U18. File not found` 整段当成引用号；收敛为 `[^\s.:]+`。
- 验证：新增 `test/ecad-units.test.mjs` 13 条（工具链定位与报错、工作区路径、初始化幂等、构建的三种失败提示与 argv 拼装、产物择新、ERC/DRC 解析、STEP 缺失模型），登记进 `test/run-units.mjs`；全量 **83 个套件 / 1129 pass / 0 fail**，ACCEPTANCE OK，`test:size` 1987.7 KB / 308 文件 / 解包 15846.1 KB。
- 教训：**跨进程工具要把「下一步怎么做」写进返回值**。缺 bun、缺依赖、缺 `node_modules`、没有构建产物这几种情况，报一句「失败」用户无法行动；报「在哪个目录执行哪条命令，再重试」才有用。

### 一百零二、教训

- **面板不要自己留第二份账本**：时间线、详情、证据目录都从同一个 seq 序列来，重连逻辑与回放逻辑只需要写一遍。
- **落盘必须能表达缺口**：只写成功批次会让证据看起来连续；先写一条缺口事件，复盘时才不会把「丢了 5 条」当成「只有这些」。
- **给工具批量埋点用代理，不要改 25 个 execute**：注册期包一层，零侵入；但 Proxy 必须把方法绑定到真实 ctx，否则 cordis 的 this 语义会被换掉。

## §93 MSYS2 安装包：官方 release 与国内镜像回退（2026-11，0.1.7）

### 一、问题

真机装工具链时，`install/start` 在第二步失败：

```
下载 43.1 MB（GitHub 官方 release，第 1/1 个候选）：
https://github.com/msys2/msys2-installer/releases/download/2026-09-27/msys2-base-x86_64-20260927.sfx.exe
下载安装包失败：固定版本 2026-09-27 的官方安装包没下来（试过 1 个候选）。
```

2026-11-12 本机实测：`github.com` 的 release 资产不可达，同一条命令对 TUNA / NJU 的
`msys2-base-x86_64-20260927.sfx.exe` 都返回 200；Tuna 那份实测 sha256 与官方一致
（`ad336ccc…37209f`，与 `MSYS2_INSTALLER_SHA256` 相同）。

### 二、改法

- `installerDefaultUrls()`：候选链 = 官方 release → TUNA → NJU → 阿里云，全部指向同一个文件名。
- 完整性不放宽：每个候选下载后仍走 `checkInstallerFile`（体量下限 + MZ 头 + 对
  `MSYS2_INSTALLER_SHA256` 逐字节校验）；镜像换了字节就拒收并换下一个候选。
- `installerSourceLabel()` 增加「国内镜像（主机名）」标签，失败时能看出试过哪几家。
- 注释里原先写的「镜像只同步 latest、保留不了历史版本」是 2026-11-11 的结论，本次实测已不成立，一并改掉。

### 三、验证

- `installerSourceLabel` 与候选链断言进 `test/install-units.test.mjs`（默认 4 个候选；全失败时 curl 调 4 次）。
- 计数：64 套件 / 953 pass；包体 1861.1 KB / 276 文件 / 解包 15287.9 KB。
- 真机：TUNA 下载 43,117,824 B，sha256 相符 → 解压 → `pacman -Syu` → 5 个组件全部装好
  （gcc 16.2.0 / gdb 18.1 / OpenOCD 0.12.0 / CMake 4.4.5 / Ninja 1.13.2），
  `stm32_doctor` 报 7/8（缺可选的 STM32CubeProgrammer）。

### 四、教训

- **回退链要和完整性钉一起设计**：只看「有没有下载成功」，镜像就成了可替换执行文件的入口；
  先钉 sha256、再列候选，才能既好装又不失守。
- **pacman 的慢不能靠等**：官方源单包 20 KB/s 时，`cmake` 一个包要 25 分钟；
  把镜像放到 `mirrorlist.mingw` / `mirrorlist.msys` 最前，同样的包在 45 秒内下完。

## §94 发布 0.1.8：调试台（2026-11-13）

### 一、为什么现在发

v0.1.7（2026-11-12）之后仓库里积了 100 个提交、S1–S89 一整条人机联调面板的改动，全部只在本机开发树里验收过，没有版本号可对照。功能已收敛到「十个标签 + 46 条路由」，再攒下去只会让「哪些是已发布行为」更难回答，因此按 v0.1.7 的同口径发布：只升版本、写 release notes、打 tag，工具参数不动。

### 二、改了什么

- `package.json` / `package-lock.json` 0.1.7 → **0.1.8**；`README.md` / `README_EN.md` 的版本徽章与安装校验提示同步。
- 删除整个 `docs/release-notes/`：发布正文改为按版本在发布页/对话里给，仓库不再保存随包无关的发布文本（包 `files` 本来也不含该目录）。
- `README.md` / `README_EN.md` 的文档区去掉发布说明条目，改一行说明「按版本随发布页提供，历史见 git 历史与开发笔记」。
- 无破坏性变更：25 个工具的参数、返回结构、权限都不变；新增的只是面板、`/dsh-stm32/api/*` 路由与 `dsh-stm32.conf` / 证据目录这些新文件。

### 三、验证

- `npm run build` 0；`node test/run-units.mjs` **80 套件 / 1088 pass / 0 fail**；`node .dsh-stm32/acceptance.mjs` → ACCEPTANCE OK；`npm run test:pack` 通过；`npm run test:size` 1979.8 KB / 295 文件 / 解包 15772.0 KB。
- tag `v0.1.8`（annotated），commit 与 tag 一起 push。

### 四、教训

- **发布文本要按「读者的下一个问题」组织**：先给一眼看完的对照表，再给能做什么、数据面、修了什么、不做什么、怎么验证、怎么升级；只罗列提交信息，读的人还得自己拼。
- **发布文本不进仓库**：`package.json` 的 `files` 不含 `docs/release-notes/`，它既不随包发布、又会随版本变陈旧（45 路由 / 79 套件这类计数很快就对不上）。发布正文按版本在发布页或对话里给，仓库只留 `development-notes.md` 这类会长期维护的开发记录。

### 五、发布后：双语 README 重排（两轮）

- 触发：发布页之外，仓库首页是读者看到的第一份文档，双语版本各自长成不同结构、夹带第二人称与口语，与「工程工具专业简约风」（`dsh-stm32-dev` §13）不一致。
- 第一轮：两份 README 用同一节次重写，事实全部回取源码（25 个工具名取自 `src/tools/*.ts`，7 条命令取自 `src/commands/register.ts:260-421`，配置字段取自 `src/data/toolchain-config.ts:21-34`，包 `files` 取自 `package.json`）。
- 第二轮（用户反馈）：README 是写给使用者的，不是写实现约束的，「未覆盖的能力明确拒绝并说明原因，不回退到 F1 表」这类句子属于开发口径；安装段也不该把 gcc / cmake / openocd / CubeMX 全列成「前置条件」，插件可以先装、工具链后补。
- 第二轮改动：
  - 删掉「不回退到 F1 表」这类实现承诺，正文改为使用者能观察到的行为：「遇到不支持的芯片或功能，调用时会直接说明缺什么，不会给出一份猜出来的结果」；「缺什么就说什么」进设计要点。
  - 安装段拆成「安装插件（只需 DSH）→ 补齐工具链（按任务列：编译 / 烧录调试 / 生成代码，给出 `/stm32-env`、`/stm32-setup`）→ 开工前检查（`/stm32-doctor`）→ 内置资源 → 从源码安装」；前置条件表删除，`Node ≥ 20` 归到源码安装。
  - 调试台删掉「46 条路由 / SSE / 环形缓冲 5000 条 / payload 8 KB」，改为使用者视角：打开面板先补齐最近记录、之后实时追加、每 30 秒落盘、默认保留 7 天与 20 个会话。
  - 串口删掉「零 npm 依赖的 PowerShell 5.1 常驻桥」等实现说明；工具表内的 `probeError` 字段名、「数据比较器预算」「13 字节头」「halt 后 resume」改为效果描述。
  - 环境变量表只留日常可用的项，开发用（`DSH_STM32_ASSETS` / `FACTS` / `SERIAL_BRIDGE` / `SERIAL_POWERSHELL` / `PYTHON`）收成一行；自动发现段删掉「进程内缓存」「路径净化」等实现细节。
  - 已知限制表按「现象 → 处理」重写，去掉 `stm32_assets verify 定位缺件` 这类开发提示。
- 复核：`node test/run-units.mjs` **80 套件 / 1088 pass / 0 fail**；`npm run test:size` **1943.0 KB / 295 文件 / 解包 15686.1 KB**（README 在 `files` 内，重排后比发布时小 37 KB）；两份均 410 行、节次一一对应，grep 无第二人称。
- 提交 `docs: 双语 README 按工程工具专业简约风重排`；`v0.1.8` 删除后就地重建到该提交并 push（tag 与 main 同指该提交）。
- 教训：**README 只写使用者能观察到的东西**——实现约束、内部数据结构、字段名属于开发笔记；安装路径要按「先能跑起来、再补能力」组织，而不是先罗列全部依赖。**双语文档按节次对齐**，先取证再改文案，否则重排过程最容易把计数写错。
