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
git clone https://github.com/OWNER/dsh-stm32.git   # 换成你自己的仓库地址
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
