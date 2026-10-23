/**
 * 随插件下发的 skill：把"这个工程里什么能改、什么绝对不能改"固化成模型必读的规范。
 *
 * 运行时注册（ctx.skills.register）而不是打包成文件：插件是单目录交付物，
 * 但凡是能注册的服务就不要依赖路径约定（规格 §9）。
 */
export const STM32_SKILL_NAME = "stm32-workflow";
const DESCRIPTION = "STM32F103C8T6 + dsh-stm32 的标准工作流与红线：只改 USER CODE、不许动 CubeMX 生成区、.ioc 走事务、烧录与调试分开、Serial Wire 不能关";
export const SKILL_CONTENT = "# STM32 工作流（dsh-stm32）\n\n适用：本机这块 **STM32F103C8T6**（蓝丸，64 KiB Flash / 20 KiB RAM，CMSIS-DAP 探针）+ 当前 CubeMX 生成的 CMake 工程。\n\n## 一、硬规范（红线）\n\n**R1 代码只准写在 USER CODE 块之间。**\n`/* USER CODE BEGIN X */` 与 `/* USER CODE END X */` 之间是 CubeMX 承诺\"重新生成时原样保留\"的唯一区域。\n想加的功能（GPIO 操作、状态机、自己的 .c 逻辑）全部写在块内。块外的任何一行都不属于你。\n\n**R2 不许改 CubeMX 生成区。** 具体包括（不是举例，是清单）：\n- `Core/Src/main.c` 的 `main()`、`SystemClock_Config()`、`MX_GPIO_Init()` 等 `MX_*_Init()` 函数体；\n- `Core/Inc/main.h` 里 `/* Private defines */` 段的 `_Pin`/`_GPIO_Port` 宏；\n- `Core/Src/stm32f1xx_hal_msp.c`、`Core/Src/stm32f1xx_it.c`（中断服务函数内部若要加内容，只能加在它自带的 USER CODE 块里）；\n- `Core/Inc/stm32f1xx_hal_conf.h`、`Core/Src/system_stm32f1xx.c`、`startup_stm32f103xb.s`、`STM32F103XX_FLASH.ld`；\n- `CMakeLists.txt`、`cmake/stm32cubemx/CMakeLists.txt`、`.mxproject`、`demo.ioc`（.ioc 只能通过事务改，见 R3）。\n理由：这些文件由 CubeMX 按 .ioc 重写；手改会被无声覆盖，而且覆盖后编译不报错（源清单写死在 `cmake/stm32cubemx/CMakeLists.txt:21-28`），故障会以\"改了不生效\"的形式出现。\n\n**R3 配置只准走 .ioc 事务：`stm32_ioc_plan` → 用户确认 → `stm32_ioc_apply`。**\n不要手改 .ioc 文本，不要开 CubeMX GUI，不要\"顺手\"改引脚/时钟。apply 必须带 plan_id，源文件 SHA-256 变了就拒绝。\n\n**R4 不许生成 `No_Debug` 的 SYS 配置。** 那会生成 `__HAL_AFIO_REMAP_SWJ_DISABLE()`，烧进去以后固件一上电就关掉 PA13/PA14 的 SWD 功能，**调试口永久失联**，只能靠 BOOT0 进系统 bootloader 抢救。\n.ioc 里必须有 `PA13.Signal=SYS_JTMS-SWDIO`、`PA14.Signal=SYS_JTCK-SWCLK`、`*.Mode=Serial_Wire`。ioc_inspect 报这条警告时必须先修。\n\n**R5 烧录与调试分开。**\n只烧录：`stm32_flash` 或 `/stm32-flash`（openocd `program ... verify reset exit`，烧完就跑，不进调试会话）。\n调试：`stm32_debug_run`（一次性停 main、取 pc/栈后释放）或 `/stm32-debug` + `stm32_debug_eval`（保持会话）。\n永远不要用\"能不能断下来\"来判断烧录成功——烧录成功的证据是 `** Programming Finished **` 与 `** Verified OK **`。\n\n**R6 探针只有一块。** build / flash / generate 之前先让出调试会话；我输出结束（turn/end）时插件会自动关会话，所以别在输出中途把探针攥着不说。\n\n**R7 先 build 再 flash。** 改完代码不编译就烧，烧的是旧 elf；烧完看现象会得出错误结论。\n\n**R8 结论必须带证据。** 说\"闪了\"要给寄存器/计数器证据（例如 `GPIOC_ODR` 在 0x2000/0x0000 之间翻转、`g_led_blink_count` 单调增长），不要只说\"看起来好了\"。\n\n## 二、标准流程\n\n1. `stm32_env_probe` —— 工具链齐不齐（gcc/gdb/openocd/cmake/ninja + CubeMX）。缺哪个就照它给的 `install` 装（第一条最省事，带可粘贴的 pacman / winget 命令），装完按 `verify` 自检；它还会问要不要我代装。CubeMX 是可选的：只影响建工程与重新生成，不影响编译/烧录/调试。\n2. `stm32_ioc_inspect` —— 看清引脚/时钟/调试口；有 `warnings` 先处理（尤其 Serial Wire）。\n3. 需要改引脚/时钟：`stm32_ioc_plan` → 给用户看 diff → `stm32_ioc_apply`（自动备份到 `.dsh-stm32/backups/<时间戳>-ioc/`）。\n4. `stm32_generate` —— 无头重新生成（3–4 分钟，走 job）。产物 `Src/`/`Inc/` 会被搬到 `Core/Src`/`Core/Inc`，USER CODE 按标签保活，生成用的临时目录会被删掉。\n5. 写代码：**只在 USER CODE 块内**。\n6. `stm32_build`（clean 才有内存占用表）→ 0 错再往下。\n7. `stm32_flash` —— 只烧录；或 `stm32_debug_run` —— 烧录并停在 main。\n8. 验证：`stm32_regs_read`（读 GPIOC_ODR / AFIO_MAPR / 全局变量）或 `stm32_debug_eval`。\n\n## 三、命令对照\n\n| 想要 | 工具 | 斜杠命令 |\n|---|---|---|\n| 只烧录 | `stm32_flash` | `/stm32-flash` |\n| 烧录 + 调试 | `stm32_debug_run`（一次性）/ `stm32_debug_session`（保持） | `/stm32-debug` |\n| 编译 | `stm32_build` | `/stm32-build` |\n| 体检 | `stm32_doctor` | `/stm32-doctor` |\n| 释放探针 | `stm32_debug_stop` | `/stm32-stop` |\n\n## 四、踩过的坑（本机实测，别重复）\n\n1. **CubeMX 的\"假成功\"**：直接 `STM32CubeMX.exe -q script` 会 detach 出 javaw 并立刻 exit 0，stdout 是空的。必须 `jre\\bin\\java.exe -jar STM32CubeMX.exe -q <脚本>` 并重定向日志，成功标志是日志里的 `Code succesfully generated under`（CubeMX 自己把 successfully 拼错了）。启动要 90–150 s。\n2. **CLI 生成忽略工程设置**：.ioc 写着 `MainLocation=Core/Src`、`CoupleFile=false`，CLI 依然固定写 `Src/`/`Inc/` 并按外设拆文件。所以必须落地映射 + USER CODE 合并，否则核心代码会被搬丢。\n3. **USER CODE 按标签保活**：同标签用旧正文覆盖新正文；旧有新无的标签直接丢；标签不配对则那对放弃。\n4. **`mdw` 输出是 8 位裸 hex**：`0x4001100c: 00000000`；`[reg pc]` 返回 `pc (/32): 0x...`，要 `lindex 1`。\n5. **openocd 的日志走 stderr**：等 \"Listening on port\" 必须同时 drain stdout 和 stderr，否则永远等不到。\n6. **读寄存器的收尾用 `resume` 不要 `reset run`**：后者会复位芯片，计数器归零，看起来像\"变量丢了\"。\n7. **符号地址会随重链接漂移**：`g_led_blink_count` 曾在 `0x20000028`，改一行后变成 `0x2000002C`，老地址变成 `uwTick`。读符号前用 `nm` 确认，或直接读物理地址。\n8. **装插件用一条命令**：`dsh plugin --profile desktop add github:JingYu-er/dsh-stm32#main`（`lib/` 已入库，pnpm 不替 git 依赖构建也能直接用）。只有要改插件源码时才用 `link:`，且升级前先删掉 `node_modules/dsh-stm32` 这个 junction，否则 pnpm 覆盖时报 `EPERM`。\n9. **宿主输出契约**：工具返回的对象在 `additionalProperties: false` 下不能有多余键；声明为 number/object 的字段不接受 `null`（用可选字段 + 条件展开）。\n10. **ninja / piped stdio 在受限沙箱里会挂或 EPERM**：那是工具侧沙箱，不是工程问题；插件里经 `ctx.subprocess` 起的进程不受会话文件沙箱限制。\n\n## 五、自检清单（每次交付前）\n\n- [ ] 改动全部落在 USER CODE 块内（`git diff` 里没有生成区的行）\n- [ ] .ioc 改动走过 plan → apply（有备份）\n- [ ] Serial Wire 仍在（`stm32_ioc_inspect` 的 `warnings` 为空）\n- [ ] `stm32_build` 0 error、0 unexpected warning\n- [ ] 烧录有 `** Verified OK **`\n- [ ] 行为验证有寄存器/计数器证据\n- [ ] 探针已释放（`stm32_doctor` 无残留进程）";
/** 注册 skill；宿主没组合 skills 服务时直接返回。 */
export function registerStm32Skill(ctx) {
    const skills = ctx.get("skills");
    if (skills === undefined)
        return;
    skills.register({
        name: STM32_SKILL_NAME,
        description: DESCRIPTION,
        whenToUse: "给 STM32F103C8T6 工程写代码、改引脚/时钟、重新生成、编译、烧录或调试时",
        content: SKILL_CONTENT,
        // 宿主读取 skill 时要求 source / provider 是字符串（register 本身不校验，
        // 但 ctx.skills.get() 会用 validateDefinition 再验一次）。缺 source 的表现是
        // skill 出现在目录里、一加载就报 "loaded skill "..." source must be a string"。
        source: "dsh-stm32:src/skill/stm32-workflow.ts",
        resourceBase: {
            kind: "opaque",
            description: "本 skill 的参考资料就是本仓库的 README.md 与 docs/dsh-stm32-plugin-规格.md",
        },
        invocation: { modelInvocable: true, userInvocable: true },
    });
}
