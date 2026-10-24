# 开发笔记（原 README）

> 这是 0.1.0 发布前的开发记录：里程碑、宿主契约踩坑、15 个工具的实现细节、A1–A13 验收与宿主侧复验。
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
node test\schema-guard.mjs        # 15 个工具的输出契约守卫（未声明键 / null / 类型），离线复刻宿主校验
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
