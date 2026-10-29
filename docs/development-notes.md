# 开发笔记（原 README）

> 这是 0.1.0 发布前的开发记录：里程碑、宿主契约踩坑、19 个工具的实现细节、A1–A13 验收与宿主侧复验。
> 面向使用者的说明已移到仓库根目录的 [README.md](../README.md)。
# dsh-stm32

DSH 插件（宿主侧，无 UI）：把 STM32（当前只支持 STM32F103C8T6）的 **环境探测 → .ioc 事务 → 生成工程 → 编译 → 烧录 → 调试** 变成一组可被模型调用的工具。

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
npm test                                            # 可选：80 个离线用例
```

然后把 `lib/` 用 `link:` 挂进 dsh 的 profile 并重启 dsh（见下一节）。宿主要求：

| 依赖 | 用途 | 缺了会怎样 |
| --- | --- | --- |
| dsh（能加载 bundle 层） | 宿主 | 插件不会被加载 |
| Node ≥ 20 | 构建 / 测试 | — |
| `openocd`、`gdb-multiarch`、`arm-none-eabi-*`（MSYS2 UCRT64 或 ARM GNU Toolchain） | 编译 / 烧录 / 调试 | `stm32_doctor` 逐个列出缺哪个，并给出该装到哪 |
| STM32CubeMX | `stm32_generate`、首次建工程 | 生成类工具不可用，其余照常 |
| STM32Cube 固件包 F1（随 CubeMX 安装） | `stm32_project_create` 抄 Drivers | 建骨架报「找不到固件包」 |

默认路径在 [`src/data/search-roots.ts`](src/data/search-roots.ts)（msys64 优先），可用 `STM32_BIN_DIRS` / `STM32_CUBEMX_ROOT` 覆盖。当前只支持 **STM32F103C8T6**（引脚表见 [`src/data/chips.ts`](src/data/chips.ts)）。
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
- P2（多芯片 F0/F3/F4/G0/L4、HAL 外设源文件落位）与 P3（gdb MI 常驻）未开工。
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
