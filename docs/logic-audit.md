# dsh-stm32 逻辑漏洞审计报告

审计对象：dsh-stm32 0.1.1（src 约 40 个文件 / 13,500 行 + templates + test）
审计方式：逐文件静态读码 + 关键行交叉复核（Lead 与 3 个队友分片，共 4 份切片，Lead 复核 30 余处关键行）
运行期验证：本报告不含新跑的命令；标「已实测」的条目来自此前真机验收记录（docs/development-notes.md §9 / §14.1 / §14.2）

## 分类口径

- **A 类｜纯逻辑漏洞**：代码本身写错了，换任何机器、任何路径都会错，只是日常路径没走到（只在 overwrite、只在取消、只在坏索引时才触发）。
- **B 类｜环境相关**：代码在本机（Windows + D:/app/msys64 已在用户级与机器级 PATH + CubeMX 在 D:/app/STM32CubeMX 且 JRE 齐全 + 工程路径纯 ASCII + 全 UTF-8 源码 + 单会话串行）不会暴露，但在别人的机器上会。

严重度：**S1** = 丢数据 / 写坏系统状态；**S2** = 功能假成功或明确错误结论；**S3** = 文案、提示、死代码、一致性。

## 摘要

| 分类 | S1 | S2 | S3 | 合计 |
| --- | --- | --- | --- | --- |
| A 纯逻辑 | 3 | 8 | 28 | 39 |
| B 环境相关 | 3 | 8 | 8 | 19 |

**优先修（会毁数据或给出错误结论）**：

1. A1：project_create 的 overwrite 无备份覆盖工程文件
2. B2：源码按 UTF-8 读写，GBK 工程会被写坏中文
3. B3：用户 PATH 读取失败被当空值，reg add /f 覆盖整条 PATH
4. A2：缓存坏索引被空索引覆盖，全部条目消失
5. A3：ioc-plan 把没有 .Signal 的引脚从引脚表剔除（PB2 / BOOT1）
6. A4：tar 把符号链接当 0 字节文件写，还报 ok
7. B5：安装自检走 PATH 兜底，pacman 失败被改判成功
8. A6：flash 的 SWD 守卫在 .ioc 不唯一时静默放行
9. A7：readWords 寄存器值错位却全标 ok
10. B1：模板 launch.json 硬编码开发机路径

---

## A 类：纯逻辑漏洞

### A1 [S1] project_create 的 overwrite 直接覆盖工程文件，零备份还报成功

位置：src/tools/project-create.ts:230-233；src/engine/scaffold.ts:157-196；src/engine/register-template.ts:277-320

触发：目标目录已有同名工程。第一次调用被「目标目录不是空的…或显式 overwrite=true（会覆盖同名文件）」顶回，模型或用户按提示重试 overwrite=true。

影响：hal 路线 scaffold.ts:189-191 用空白模板替换 .ioc（引脚、时钟树、外设全丢）；register 路线 :317/:320 直写 CMakeLists.txt 与 Core/Src/main.c（USER CODE 全丢）。这条路径不进 .dsh-stm32/backups（code-patch / ioc / generate 都会进），报告仍 ok:true、warnings 只提两条固定提示，用户以为只是补了骨架。同时绕过 skill 里「.ioc 只能走事务」的红线。

修法：覆盖前把将被替换的文件复制到 .dsh-stm32/backups/<时间戳>/ 并把清单写进 warnings；.ioc 已存在时直接拒绝并指向 stm32_ioc_plan / stm32_ioc_apply（或另开 iocOverwrite 显式开关）；「目录非空」检查提到门禁之前。

### A2 [S1] 缓存索引读坏后被空索引整份覆盖

位置：src/engine/cache.ts:136（配 :107-109、:168）

触发：index.json 被写坏（断电、杀软截断、手工编辑）。readCacheIndex 返回空索引加一条 error，但 upsertCacheEntry 写的是 `const { index } = readCacheIndex(env)` —— error 被丢弃，随后把「只含新条目」的索引整份写回。

影响：其余全部缓存条目一起消失；checkCacheEntry 只比字节数，半截文件大小对得上也算完整。

修法：写前检查 error，坏文件改名备份成 index.json.broken-<ts> 再重建；条目记录每文件 sha256。

### A3 [S1] ioc-plan 把没有 .Signal 的引脚从引脚表剔除

位置：src/engine/ioc-plan.ts:370-371 与 :241-247（writePinOrder）

触发：任何触发 pinsTouched 的操作（serialWire:true 或新增引脚）。过滤条件是 after.get(pin + ".Signal") !== undefined || pin.startsWith("VP_")。

影响：F1 上 PB2（BOOT1）在 .ioc 里只有 PB2.Mode=B2-BOOT1、没有 .Signal，会被静默踢出 Mcu.PinN 列表，PinsNb 随之缩小，而它的 .Mode / .GPIO_* 键仍留在 entries 里成为孤儿。CubeMX 重新加载后引脚配置可能丢失或直接报配置错误 —— 这是「改一条 .ioc」最容易毁配置的地方。

修法：只在 order 真的变化时重写；或保留所有已存在的 PinN 项（对缺失 Signal 的引脚沿用原顺序）。

### A4 [S1] tar 解包不检查 typeflag，符号链接被当 0 字节文件写入并计入成功

位置：src/engine/tar.ts:166-201（文件头 :9 的注释声称会跳过）

触发：归档里出现符号链接（typeflag 1 / 2）、硬链接、设备文件。当前上游 codeload 恰好没有，但用户可换源（ghproxy 镜像、企业代理缓存）或未来换打包方式。

影响：写出 0 字节的假文件、files 计数虚高、ok:true，错误推迟到编译期（缺头文件）。同时 isSafeRelative（:84-90）只拦以 / 开头、盘符、以及按 / 切分后等于 .. 的段，**不拦反斜杠**：条目名里用 .. 加反斜杠形成单段时不满足等于 .. 的判定、能通过校验，joinSafe 用 path.join 规范化后在 Windows 上跳出目标目录。

修法：typeflag 不在 {0, 空, 5, x, g, L, K} 一律 skipped 并记名字；路径拒绝反斜杠与冒号，或先按混合分隔符切段逐段校验再自行拼接。

### A5 [S2] 引擎大量写盘没有 try/catch，只读工程会以未捕获异常收场

位置：src/engine/regs.ts:166-169（写 .dsh-stm32/tmp 的 Tcl 脚本）；同类 src/engine/ioc-plan.ts:419-427、src/engine/generate.ts:447-451、src/engine/scaffold.ts:192-202

触发：工程目录只读（Program Files、只读共享、库目录、企业受控目录）。

影响：工具直接抛异常而不是返回干净的中文失败报告；留下半截 .dsh-stm32/tmp 目录。tools 层只有 ioc-inspect.ts、project-dir.ts、route-plan.ts 三个文件出现过 catch，其余 14 个工具没有兜底。

修法：引擎侧把 fs 写盘包成带上下文的 Result；tools 层统一 try/catch 转成报告。

### A6 [S2] flash 的 SWD 守卫在 .ioc 不唯一时静默放行

位置：src/engine/flash.ts:79-81（findIocFile 返回 null 时直接 {blocked:false, errors:[], notes:[]}）；findIocFile 在 src/engine/generate.ts:135-140 要求「唯一」

触发：工程里 0 个 .ioc 或 2 个以上（常见：demo.ioc 加 demo_backup.ioc、别人给的工程）。

影响：烧录前「Serial Wire 是否启用」的检查被完全跳过，连一条 note 都不留。若目标固件关了 SWD，这次烧录会让调试口失联，只能 BOOT0 救回来。这条守卫是插件最重要的一条红线，静默失效比不实现更危险。

修法：findIocFile 返回 null 时明确 note「没找到唯一的 .ioc，SWD 守卫已跳过」，多 .ioc 时要求用户指定 iocPath。

### A7 [S2] readWords 在中间地址读失败时值整体错位，仍全部标 ok

位置：src/engine/debug-session.ts:392-404（readWords）、:137-144（parseGdbPrintedHex）

触发：批量读寄存器时其中某个地址不可读（外设时钟没开、地址非法、目标已复位）。失败命令只打 Cannot access memory，不产生 $N 行。

影响：按出现顺序取 $N = 0x…，后面的值整体前移一格，samples 全部 ok:true。用户据此判断寄存器状态会得出完全错误的结论（例如以为 RCC 已开，实际读到的是下一个地址的值）。

修法：逐地址单独下命令并按读回的地址或序号对齐；或解析错误行与 $N 的配对，缺失即标 ok:false。

### A8 [S2] stm32_cache 的 action 落 else 分支等于 purge

位置：src/tools/cache.ts:208-235

触发：传枚举外的值（clear、delete、清空、拼错）。schema 的 enum 不保证宿主一定校验，handler 内部也只有 if 链。

影响：无 id 时删整库。断网或公司代理环境下等于功能不可用，且回执写「已清理」，用户不知道自己删了什么。

修法：else 分支先返回「不认识这个 action（list / verify / fetch / purge）」；purge 要求 id 或 confirm:true 并回报条目数。

### A9 [S2] turn/end 监听不看会话身份，旁路 agent 结束就释放探针

位置：src/index.ts:72-83

触发：主会话开着 stm32_debug_session，同时有子 agent 或第二个会话结束一轮。

影响：debugSessions.stop() 被无条件调用，探针被释放；之后 stm32_debug_eval / stm32_regs_read 报「没有会话」，而用户没做任何操作。

修法：start 时记录发起者（session id 或 exec.agent.id），stop 前比对；或只监听 session/disposed。

### A10 [S2] CubeMX 日志出现成功行就一票否决所有错误

位置：src/engine/generate-script.ts:106-113

触发：CubeMX 打印 Code succesfully generated，同时日志里有 Error 行。

影响：所有错误被降级成 knownNoise，ok:true。配合已实测的「缺包或包版本不认时 CubeMX 仍打成功行、只是不拷 HAL」，这意味着 ok:true 完全不能代表生成正确（dev-notes §14 已记录）。

修法：以产物判据（三项固件包判据加 Core/Src 里的文件数）作为 ok 的必要条件，日志只作附加信息。

### A11 [S2] 固件包安装的临时目录清理在 try 之外

位置：src/engine/firmware-install.ts:459-461（建 <目标>/.dsh-download）与 :550-552（rmSync）

触发：安装收尾时暂存目录被占用（杀软扫描、资源管理器预览），或前面步骤抛异常。

影响：job 以未捕获异常结束，report 全缺，用户只看到「失败」没有任何细节；目标目录里留下 .dsh-download 残渣，下次安装还会读到它。

修法：清理移进 try，失败只记 note；暂存目录放到包目录之外（同盘可 rename 的位置）。

### A12 [S2] writeCacheIndex 的兜底先删好索引再搬

位置：src/engine/cache.ts:124-130

触发：首次 rename 失败（常见原因就是 tmp 被占用），进入 catch 执行 rmSync(indexPath) 后 renameSync 仍然失败。

影响：好索引已被删除、第二次 rename 抛出，全部条目一起消失，且工具以未捕获异常收场。

修法：只在明确「目标已存在」的错误码上兜底；兜底前先把旧索引改名备份；tmp 用随机独占名。

### A13 [S3] 固件安装 needsHint 恒为真，else 是死代码

位置：src/engine/firmware-install.ts:536-548（existing 已在 :259 提前返回）

修法：按 targetKind switch 给提示，并与 generate 实际能看到的目录对齐。

### A14 [S3] generate 锁只看 pid 加时间，不看进程是否活着

位置：src/engine/generate.ts:159-196

影响：DSH 崩溃或断电后 30 分钟内所有生成被挡，要用户手删 .dsh-stm32/lock.json。

修法：锁里写 pid，判断时探活（process.kill(pid, 0) 或 tasklist）；跨机器或容器场景补 host 标识。

### A15 [S3] fetch 覆盖目标文件时先删旧文件再 rename

位置：src/engine/fetch.ts:82

影响：rename 失败时旧的好文件已经没了（更新模板时磁盘满或被占用）。

修法：先 rename 到 .old 再 rename 新文件，成功后删 .old。

### A16 [S3] route-plan 四处同源问题

位置：src/tools/route-plan.ts:441（isConcurrencySafe 返回 true，但 execute 会 spawn 探测）、:483（verdict unclear 也落 capability generate）、:503（无 cubeMxRoots 时 repositoryDir 退化成盘根 /Repository）、:516-519（ok 与 gate.ok 相与，缺件时「路线评估成功」被吞成 ok:false）

修法：并发安全改 false；unclear 不传 capability 跳过门禁；repositoryDir 为空给空串并在 notes 说明；gate 结论只进 notes/guides，不改 ok。

### A17 [S3] skill 文本写 plan_id，工具参数是 planId

位置：src/skill/stm32-workflow.ts:14；契约在 src/tools/ioc-apply.ts:54、src/engine/ioc-plan.ts:433

影响：模型照最权威的说明书传参会被 additionalProperties:false 拒绝，一次必然失败加一次修参重试。

### A18 [S3] ioc-apply 的 rollback 编造 appliedChanges

位置：src/tools/ioc-apply.ts:90（rollback.ok ? 1 : 0）

修法：回滚时置 0，或加 rolledBack 字段区分语义。

### A19 [S3] regs_read 借用会话时静默忽略 configFile / adapterSpeed

位置：src/tools/regs.ts:161-190

影响：用户以为按新参数（例如降速到 1000 kHz）读到了值，实际用的是旧会话参数，排障会得出错误结论。

修法：参数与生效值不同时写 notes，或拒绝借用并提示先 stm32_debug_stop。

### A20 [S3] 死代码与冗余

- src/tools/generate.ts:256/276：report 变量声明后只 void，job 路径从不读回；:279-280 status / detail 三元两支相同。
- src/engine/debug.ts:143-145：空 for 循环。
- src/engine/tar.ts:174：const mapped = isDir ? mapPath(rel) : mapPath(rel)；:199-200 planned.push 后 void size。
- src/engine/firmware-install.ts:536-548（见 A13）。

### A21 [S3] env-install 的 job 卡片贴的是安装前的计划快照

位置：src/tools/env-install.ts:467-482（report 是 { ...plan, message: startMessage }）

影响：真装走 job 时，卡片上 mode=plan、steps 全 pending、config.written=false，只有 message 说「已在后台安装」，用户分不清装没装，容易再点一次。formatInstallReport 只在 mode 等于 install 时给 headline。

修法：job 分支返回 mode=install 的骨架（steps 全 pending），或对 job 单独渲染「已开始，看 job 输出」。

### A22 [S3] formatBytes 用 1024 进制却标 MB

位置：src/engine/msys2-install.ts:189-193

影响：43060392 B 显示成 41.1 MB（实为 41.1 MiB / 43.1 MB）；「装完约 X MB」再乘倍率 3，误差叠加。此前真机卡片上的「安装包 41.1 MB」就是这个数。

修法：除以 1e6 或单位写 MiB；估算倍率在 notes 里注明含解压与 pacman 缓存。

### A23 [S3] xcube-catalog 的常量与实际数据不符

位置：src/engine/xcube-catalog.ts:26-29（写死 159 个 .pdsc、XCUBE_CATALOG_FILE_COUNT=159），实际数组 :34-102 只有 67 条，两个常量无人引用。

影响：报告里的「159 个第三方包」是开发机当时的快照，换机器后既不准也没被读取。

修法：由数组长度派生，或标注「上游全集数 / 当前收录 N 条」。

### A24 [S3] register-template 的缓存完整性有缺口

- THIRD_PARTY_NOTICES.md 写在 files[] 之外（:167），checkCacheEntry 不校验（:147）：删掉它仍算命中。
- 下载失败直接 rmSync 整个 entryDir，会把并发方正在读的目录抽走。
- startup 容量档只覆盖 6 / 8 / B / C / D / E，STM32F103x4 返回 null（拒绝建工程）；src/data/cmsis-sources.ts:101 的注释「C8T6 → x8」与表格（8 → xb）自相矛盾（代码对，注释错）。

### A25 [S3] flash 日志里任何 Error: 行都判失败

位置：src/engine/flash.ts:167-172

影响：openocd 成功路径也会打 Error: 前缀的行（无关 ACK、DAP 噪声），于是「烧录成功、已校验」被判成失败。

修法：以 Verified OK 与退出码为主判据，Error 行只在缺失成功标志时升级为失败。

### A26 [S3] debug_run 的 ok 与 errors 自相矛盾

位置：src/engine/debug.ts:285

现状：ok = spawnError 为 null 且未超时且（breakAt 为 none 或已命中断点），完全不看 gdbOutcome.exitCode 与 probe.errors。

影响：报告写「调试快照完成」同时 errors 非空（例如 Cannot access memory）。

### A27 [S3] 门禁的探测缓存会把被取消的不完整结果缓存 60 秒

位置：src/engine/toolchain-gate.ts:360-366（break 后仍执行 probeCache.set）

影响：用户取消一次 stm32_build 后，接下来 60 秒同 capability 命中缓存，未探测的组件被当成「缺」，用户被告知「缺 gcc/cmake/ninja，要我装吗」，可能据此重装一份。

修法：signal.aborted 时不写缓存，或只缓存已完成部分并标 partial。

### A28 [S3] 工具链配置是读—改—写，tmp 名只带 pid

位置：src/data/toolchain-config.ts:223、242-258；调用点 src/engine/msys2-install.ts:1377-1379

影响：同进程两个工具同时写配置时后者覆盖前者（丢 packages / binDirs / cubeMxRoot）；tmp 路径完全相同还会互相 ENOENT。

修法：写前比对 mtime 或 version 做 CAS，不一致重读重试一次；tmp 名加随机后缀。

### A29 [S3] 取消被当成「解压或下载失败」，还删掉暂存目录

位置：src/engine/msys2-install.ts:617-653（exitCode 为 null 时 !== 0 成立）

触发：job_kill 或工具超时 abort 掉 sfx 解压。

影响：卡片写「安装没全部成功：解压安装包 / 退出码 null：（无输出）」，nextStep 让用户「修好后重调」；同时把暂存目录整棵删掉，而被 kill 的 sfx 可能还在写，留下更难查的残渣。

修法：三个失败判据前先判 outcome.aborted，返回「已取消」；取消时不删暂存目录，下次进入 extract 时再清。

### A30 [S3] pacman 被打断后的 db.lck 与半装事务没有指引

位置：src/engine/msys2-install.ts:1290-1312、:1420

影响：var/lib/pacman/db.lck 残留后每次报 unable to lock database；事务半提交后下次 --needed 报 exists in filesystem 或 conflicting files。两种情况的卡片都只有「退出码 N」，而 nextStep 恰恰建议重调本工具，越调越坏。

修法：失败后检测 db.lck 并给「确认没有 pacman 进程后删除它」的具体命令；stderr 命中 conflicting files 时给 --overwrite 或先 -Syu 的指引（不自动执行）；pacman 阶段单独放宽超时。

### A31 [S3] 四个工具 rawArgs 非可选且没有 ?? {}

位置：src/tools/debug-session.ts:162/221、src/tools/ioc-apply.ts:77、src/tools/ioc-plan.ts:141

影响：宿主传 undefined 时 TypeError；其余工具都写了 rawArgs?. 或 ?? {}。

### A32 [S3] 下载内容没有真正的校验

位置：src/engine/fetch.ts:71-78（字节数加前 512 字节像不像 HTML）、src/data/firmware-packages.ts:274-286、src/engine/cache.ts:168

影响：600 字节的代理错误页可以写成 core_cm3.h；verify 只查 existsSync 与目录非空，安装报「三项判据全过」，错误拖到编译期（unknown type name 或 #error）。

修法：核心头与归档记期望 sha256 或首行特征（例如 #ifndef __CORE_CM3_H）。

### A33 [S3] env-install 的 packages 原样透传给 pacman

位置：src/tools/env-install.ts:388-400

影响：传入 --noconfirm 之类的值会被当 flag 执行，而不是包名。

### A34 [S3] 缓存 fetch 不传 signal

位置：src/tools/cache.ts:190-193

影响：网络卡住时只能等工具超时，取消无效。

### A35 [S3] releaseProbeFor 的 released 说明在 job 路径被丢弃

位置：src/tools/generate.ts:233/249、src/tools/build.ts:178/191

影响：后台模式下看不到「探针已让出 / 会话已停」，之后 eval 报没会话时无从追溯。

### A36 [S3] job 分支只有 .then，取消桥接等于没接

位置：src/tools/env-install.ts:433-465、src/tools/firmware-install.ts:242/268

现状：firmware-install 注册 exec.signal 到 controller 的监听后 :268 立刻 removeEventListener；env-install 干脆没有桥。取消时 done reject，没有中文说明。

修法：removeEventListener 挪进 done 回调；job 分支加 .catch 给「已取消 / 失败：原因」（build 与 generate 的 job 分支同样处理）。

### A37 [S3] guideFor 缺 firmware 分支，且用 in 判原型链

位置：src/data/install-guides.ts:206-209（只认 cubemx / cubemx-java）、:164（family in FIRMWARE_FAMILIES 会命中原型链）

现状：src/tools/route-plan.ts:497 直接调 firmwareGuide，所以用户实际能拿到固件包手动指引；guideFor 够不到它只是潜在不一致。

### A38 [S3] 缓存 verify 只比字节数

位置：src/engine/cache.ts:170-182

影响：同尺寸内容被替换仍报 status 为 ok（与 A2 同源）。

---

## B 类：本机不暴露、用户机器会中

### B1 [S1] 模板 launch.json 把开发机绝对路径写进每个新工程

位置：templates/scaffold/vscode/launch.json:19-21 与 :39-41（svdPath 指向 D:/JingYu/STM32/cmsis-svd-stm32/stm32f1/STM32F103.svd；armToolchainPath 与 gdbPath 指向 D:/app/msys64/ucrt64/bin）；映射逻辑 src/engine/scaffold.ts:187-191

本机为何不暴露：这两个路径在本机确实存在，按 F5 能用。

影响：别人拿到工程按 F5 必挂（找不到 gdb 或 SVD），同时暴露开发机的用户名与目录结构。

修法：模板改成占位符（gdb 路径与 SVD 路径各一），生成时按本机探测结果填；探测不到就留空并写一条 warning，绝不写死。

### B2 [S1] 源码按 UTF-8 读写，GBK 工程会被写坏中文

位置：src/engine/code-patch.ts:124（readFileSync utf8）与 :185（写回）、src/engine/generate.ts:236/242/246/266、src/engine/usercode-merge.ts（文本层）、src/engine/ioc.ts（解析）

本机为何不暴露：本机工程全 UTF-8 或 ASCII。

影响：中文嵌入式项目里 main.c 常是 Keil 编辑的 GBK。读进来是替换符，写回去把用户的中文注释永久毁掉（且报告 ok:true）。.ioc 是 UTF-8，不受影响。

修法：读文件时检测 BOM 与非法 UTF-8 序列；非 UTF-8 时按 GB18030 解码并记住编码，写回用同一编码；检测不出就拒绝改写并说明原因。

### B3 [S1] 用户级 PATH 读取失败被当成「没有 Path」，reg add /f 覆盖整条 PATH

位置：src/engine/msys2-install.ts:457-475（readUserPath 对 spawnError、超时、非 0 退出都返回 emptyUserPath）、:488-506（planPathState 不看 found）、:546-556（reg add /v Path /f）

触发：reg query 10 秒超时、被组策略或 EDR 拦、输出格式与 parseRegValue 的正则不符（:446-455 要求名字后至少两个空格再 REG_*）。

本机为何不暴露：本机 reg query 正常返回，永远走 found=true 分支。

影响：整条 HKCU 里的 Environment 下 Path 被单条新值替换；而「备份」写的是空串（writePathBackup(current.raw)），无法回滚。中文用户名下的 WindowsApps、npm 等条目全消失，重启后命令行失效。

修法：写注册表前必须确认 current.found 为 true 且 raw 非空；found 为 false 时按 error 区分「真的没有 Path」（可以新建）与「读失败」（判 path 步失败并给手动命令）；把 found 与 error 透到卡片，不能再印「写前先备份旧值」。

### B4 [S2] 子进程不注入 env，binDirs 只用于「找可执行文件」

位置：src/engine/subprocess-runner.ts:76-86 与 :175-181（subprocess.spawn 没有 env 参数）；templates/scaffold/cmake/gcc-arm-none-eabi.cmake:11-16（裸名 arm-none-eabi-gcc 与 g++）、templates/scaffold/CMakePresets.json:7（generator 用裸名 Ninja）

触发：用户刚用 stm32_env_install 装好、config.json 也写了 binDirs，但 DSH 宿主进程还没重启（用户在注册表里的 PATH 变了，进程 env 没变）。

本机为何不暴露：ucrt64/bin 早在用户级与机器级 PATH 里，进程启动时就带着。

影响：门禁 locateFast 判「工具链齐全」，紧接着 cmake --preset 报 arm-none-eabi-gcc not found —— 显示的成功与随后的失败直接矛盾，用户完全不知道为什么。

修法：spawn 时注入 env.PATH（binDirs 优先加原 PATH）；CMake 侧显式传 -DCMAKE_C_COMPILER 为绝对路径，或把 toolchain 文件里的前缀设为绝对目录。

### B5 [S2] 安装自检走 PATH 兜底，pacman 失败被改判成功

位置：src/engine/msys2-install.ts:1356-1362（probeAll 用 binDirs:[binDir]，但 probeTarget 会回退 subprocess.resolveExecutable，见 src/engine/probe.ts:116-130）与 :1392-1398（verifyState.ok 时把 pacman 的 failed 改成 done）

触发：目标目录这份 pacman 补包失败（代理挡源、镜像不通、空间不足），而 PATH 上已有另一份 arm-none-eabi-gcc（STM32CubeIDE 自带、xpack、旧 msys64）。

本机为何不暴露：本机 PATH 里的 D:/app/msys64/ucrt64/bin 与 targetDir 是同一份。

影响：卡片 pacman 显示完成、message 说「MSYS2 装到 X 了，5 个组件都能跑，现在可以编译 / 烧录 / 调试」，但配置里写的是 X/ucrt64/bin（空目录）；版本号打印的其实是 PATH 上另一份。用户删掉 PATH 那份或换机器后立刻全缺。

修法：自检限定「只在该 binDir 里找」（existsSync 加在该目录跑版本命令，禁用 PATH 兜底，或给 probe 加 allowPathFallback:false）；只有全部来自 binDir 才允许补偿判定，否则保留 pacman failed 并如实说「工具在 PATH 上另一份，没装到 X」。

### B6 [S2] 模板 settings.json 绑死 ST 官方 VS Code 扩展

位置：templates/scaffold/vscode/settings.json:2-13（cmake.cmakePath 为 cube-cmake、-DCMAKE_COMMAND 为 cube-cmake、stm32cube-ide-clangd.path 为 cube、--query-driver 指向 CUBE_BUNDLE_PATH 下的 gnu-tools-for-stm32）

本机为何不暴露：本机装了 ST 扩展。

影响：没装 ST 扩展的用户在 VS Code 里配置与索引全废（找不到 cube-cmake、clangd 起不来）。

修法：改成 CMake Tools 的通用配置（cmake.cmakePath 指向系统 cmake），ST 专用键放到单独的 settings.st.json；探测不到 CUBE_BUNDLE_PATH 就不写 clangd 行。

### B7 [S2] 命令解析把带空格的路径切成两段

位置：src/commands/register.ts:45-60（先按空白切词，再剥引号）

触发：例如 /stm32-build 后面跟一个带空格并被引号包起来的工程路径，或任何 Program Files 下的路径；命令 hint 就写着「工程目录」，鼓励手写。

本机为何不暴露：工程路径纯 ASCII 无空格。

影响：projectDir 只剩半截，后续报「找不到 .ioc / CMakeLists.txt」，用户只会以为工程坏了。

修法：引号感知切词（一次扫描：引号内不切、顺手剥引号），或把首个 token 到行尾整段当 projectDir。

### B8 [S2] 四条斜杠命令不走门禁

位置：src/commands/register.ts:165-287（flash / debug / stop / build）

影响：缺 gcc 或 openocd 的机器上只得到原始 spawn 错误，与工具入口的中文「缺 X 加安装命令」体验不一致；/stm32-env 摆在那儿但没人会先想到。

修法：四个 handler 里 await ensureToolchain（envCheck 用 warn），把 gate.message 前置进 text（或直接改道调对应工具）。

### B9 [S2] reg.exe 输出按 UTF-8 读，中文系统上是 GBK

位置：src/engine/msys2-install.ts:446-455 与 :457-475（readUserPath）、src/data/search-roots.ts:180-186（readRegistryInstallDirs）

触发：中文 Windows 加值里含非 ASCII：CubeMX 装在中文用户目录下，或用户级 Path 含中文目录条目。

本机为何不暴露：用户目录与 CubeMX 路径纯 ASCII（D:/app/STM32CubeMX）。

影响：注册表发现链拿到的路径乱码，existsSync 必失败，CubeMX 发现退化成目录扫描，generate 能力误报缺件；PATH 那条更糟：乱码旧值被 composeUserPath 写回，中文条目永久写坏（与 B3 叠加时备份也是乱码）。

修法：不要直接解析 reg.exe 的管道输出；零依赖下改走 powershell 并先设 [Console]::OutputEncoding 为 UTF8，或按 buffer 读入、检测到非法 UTF-8 就拒绝写回 PATH 并报错。

### B10 [S2] 固件包装到 cache 或自定义目录后，generate 结构上看不到它

位置：src/engine/firmware-install.ts:259（kind 为 cache 或 custom 仍 ok:true）与 :544-547（nextStep 让「直接调 stm32_generate」）；src/engine/generate.ts:363 只搜 config.cubeMxRoots 下的 Repository 与 dsh-firmware（src/data/firmware-packages.ts:384-387）

触发：CubeMX 在 Program Files 不可写或没装、非管理员，导致 decideTarget 所有 cubeMx 根建不了，落到 cacheRoot/firmware/<包名>；或显式 targetDir。

影响：install 说「三项判据全过」，generate 反而打印「可以用 stm32_firmware_install 装到 CubeMX 的 dsh-firmware 下」把用户指回刚做过的事；CubeMX 静默退回自己认识的版本，generate 仍报成功（与 A10 叠加）。

修法：把 cacheRoot/firmware 与安装时记录的 targetDir 作为 extraRoots 传给 locateFirmwarePackage；或拒绝落在 generate 搜不到的目录（明确说要放哪儿）。

### B11 [S2] 第三方包索引被整体 rename，断电或被杀就消失

位置：src/engine/thirdparty.ts:176-236（pdsc 改名成 pdsc.dsh-parked）、:213-227（CubeMX 运行中又建了非空 pdsc 时拒绝还原，要人手工合并）；还原依赖 src/engine/generate.ts:494-498 的 finally

触发：生成长度 2 到 6 分钟，期间 DSH 被 kill、断电、蓝屏；或两个工程、两个 DSH 会话并发生成（锁是按工程的，见 A14 位置 src/engine/generate.ts:159-196）。

本机为何不暴露：本机每次生成都能正常收尾，且单会话串行。

影响：用户 CubeMX 里 159 个第三方包全消失（目录被改名后没人改回来）；期间在 GUI 装了新包，两份 pdsc 需人工合并。全局状态（共享的 pdsc 目录）被工程级锁保护。

修法：不要 rename 全局目录；改用「生成期间临时把配置指向一份过滤后的索引」（若 CubeMX 支持），或至少在进程启动时检查残留 pdsc.dsh-parked 并自动还原，加一个独立的跨进程锁。

### B12 [S2] install 分支跳过受保护目录判定，会在假根里造包

位置：src/engine/firmware-install.ts:186-195（dirWritable 在 create=true 时直接 mkdir 加探针），isProtectedSystemDir 判定只在 :173 的 plan 分支

触发：候选根不存在且祖先受保护（例如只有 Program Files 下那条），install 模式会把它真建出来。

本机为何不暴露：D:/app/STM32CubeMX 排在前面且 :245 立刻 return。

影响：盘上多出假根下的 dsh-firmware/STM32Cube_FW_F1_V1.8.7，targetKind 仍报 cubeMx，plan 与 install 给出两个不同落点。

修法：install 分支同样先过 isProtectedSystemDir；只对含 STM32CubeMX.exe 的根建 dsh-firmware。

### B13 [S3] 门禁快路径只判文件存在，不跑版本命令

位置：src/engine/toolchain-gate.ts:302-325

触发：binDirs 里存在 arm-none-eabi-gcc.exe 但跑不起来（杀软隔离、删了 libwinpthread、拷贝来的半份 msys64、0 字节占位文件）。

本机为何不暴露：本机 5 个 exe 都真能跑。

影响：门禁说「工具链齐全，可以开始」，真正失败发生在 cmake 或 ninja 阶段，报错离原因很远；而 envCheck=block 就是想拦这种情况。

修法：快路径命中也做一次轻量探测（至少 gcc 与 openocd），或在 detail 里标明「只做了存在性检查」。

### B14 [S3] pacman -Sy 之后立刻 -S 是 MSYS2 官方禁止的局部升级

位置：src/engine/msys2-install.ts:685-687

触发：基包与仓库同批包版本不一致（镜像滞后、企业镜像旧）。

影响：「无法满足依赖关系」式失败；工具只在 step detail 补一句「先跑 pacman -Syu」，nextStep 重调仍是同一条命令，循环失败。

修法：基包首次装完跑一次 pacman -Syu --noconfirm；至少把提示提到 message 与 nextStep。

### B15 [S3] hal 路线的门禁用了 generate 能力（要求启动器加内置 JRE）

位置：src/tools/project-create.ts:222-233

现状：scaffold 只读 CubeMX 的 Repository（src/engine/scaffold.ts:167-173/199-202），不需要 STM32CubeMX.exe 启动器、更不需要 JRE。

影响：CubeMX 装着但 JRE 缺失（精简安装、杀软隔离、只拷贝了 Repository）时，完全合法的建骨架被拒，还引导用户去装 JRE；且门禁排在「目录非空」检查之前，用户先被要求装东西、装完再撞第二个错。

修法：hal 路线只校验 CubeMX 目录存在（或用 envCheck:warn）；目录检查提到门禁之前。

### B16 [S3] releaseProbeFor 排在门禁之前，拒绝执行时已先掐掉会话

位置：src/tools/flash.ts:132、src/tools/debug.ts:173

触发：同一工程开着 stm32_debug_session，随后 flash 不带 binDirs、配置里又找不到 openocd，门禁 block。

影响：拒绝的那一刻副作用已发生（会话被停），报告却说「缺 openocd 没烧」。

修法：挪到 gate.ok 之后、真正干活前一行。

### B17 [S3] 拷固件包没有长路径处理

位置：src/engine/scaffold.ts:199-202（copyTree 与 copyFileSync）

触发：工程放在深目录或长用户名下；固件包层级很深（Drivers/CMSIS/Device/ST/STM32F1xx/Source/Templates/gcc 下还有子层，本机实测 238 个文件）。

影响：ENAMETOOLONG，建工程失败（Node 不会自动加长路径前缀）。

修法：Windows 上 copy 前把路径规范成扩展长度形式，或检测超长时给明确提示。

### B18 [S3] CubeMX 脚本按 UTF-8 写，路径含中文时可能乱码

位置：src/engine/generate.ts:451（writeFileSync 用 utf8），脚本里是 .ioc、工程、固件包的绝对路径

触发：中文用户名或中文工程目录，且 CubeMX（Java）按平台默认字符集（中文 Windows 为 GBK）读脚本。

影响：脚本里的路径变乱码，CubeMX 报找不到 .ioc 或生成到奇怪位置。

状态：未实测，属风险项（本机路径纯 ASCII 无法暴露）。

修法：脚本文件用 BOM 加 UTF-8 写，或把路径统一转成 8.3 短路径再写进脚本；也可先用一个含中文路径的小工程做一次真机验证。

---

## 横切主题

### 数据安全（S1 集中区）

- 覆盖写：A1（工程骨架）、B2（GBK 源码）、A2 与 A12（缓存索引）。
- 环境变量：B3（整条 PATH 加空备份）、B9（中文乱码写回）。
- 全局共享状态：B11（pdsc 目录 rename）、A3（.ioc 引脚表）。

共同形态是「先破坏、后判断」，而报告仍按成功渲染。建议统一一条规则：任何会改动用户已有文件的路径，先备份并进 warnings，再改。

### 假成功（S2 集中区）

A10（成功行否决错误）、B5（PATH 兜底自检）、A7（错位值标 ok）、A25（Error 行判失败的反面）、A26（ok 与 errors 并存）、A21（job 卡片贴计划）。这些都让「报告说成功」与「实际状态」脱钩。共同修法：以产物判据或独立复核作为 ok 的必要条件，日志只做旁证。

### 状态机与并发

A9（turn/end 掐会话）、A14（锁不看 pid）、A28（配置读改写）、B11（工程级锁管全局状态）、A27（abort 后写缓存）、A36（取消桥接失效）。插件已经有 jobs、lock、缓存三层状态，但没有统一的「谁拥有、何时失效」约定。

### 文案与单位

A22（MiB 标 MB）、A23（159 常量）、A17（plan_id）、A21（计划卡片）、A35（released 丢）、A37（guide 分支）。

---

## 建议修复批次

**第 1 批｜数据安全（改动小、风险低、优先级最高）**
A1 覆盖前备份并拒绝覆盖 .ioc；B2 编码检测；B3 PATH 写入前确认 found；A2 与 A12 索引读写加固；A3 引脚表保序；A4 tar typeflag 与反斜杠；A5 引擎写盘兜底；A6 SWD 守卫显式提示；A7 readWords 对齐。

**第 2 批｜用户机器可用性**
B1 模板去绝对路径；B4 spawn 注入 PATH 加编译器绝对路径；B6 settings 解绑 ST 扩展；B7 引号感知切词；B8 命令接门禁；B9 reg.exe 编码；B5 自检禁 PATH 兜底；B10 固件包目录对齐；B12 install 受保护目录；B13 快路径轻量探测；B15 hal 门禁降级。

**第 3 批｜假成功与状态一致性**
A10 产物判据；A25 flash 成功判据；A26 debug_run 的 ok；A9 会话归属；A27 abort 不缓存；A28 CAS 写配置；A36 取消桥接；A21 job 卡片；A14 锁探活；B11 pdsc 恢复策略。

**第 4 批｜一致性清理**
A8、A13、A16、A17、A18、A19、A20、A22、A23、A24、A29、A30、A31、A32、A33、A34、A35、A37、A38、B14、B16、B17、B18。

---

## 方法与局限

- 全部结论来自静态读码（4 份独立切片，Lead 复核 30 余处关键行）；除 B18 的「未实测」标注外，未做新的一次运行期复现。
- 未覆盖：CubeMX 本体行为（只能靠已记录的实测）、宿主 DSH 的 jobs 服务实现、非 Windows 平台（插件主要面向 Windows）。
- 已排除的疑点（读码确认无问题）：build 的 CMakeCache 路径错位拦截、elf 查找与 Debug 优先、usercode-merge 的标签配对与 CRLF 保留、ioc.ts 的 serialWire 两种写法识别、layout 的路径映射、doctor 的进程与端口判定、flash 对 Tcl 特殊字符的处理（罕见，未列入）。
- 本机（开发机）环境基线：Windows；msys64 在 D:/app/msys64 且已在用户级与机器级 PATH；CubeMX 在 D:/app/STM32CubeMX（JRE 齐全，Repository 9 个官方包，另有插件组装的 dsh-firmware/STM32Cube_FW_F1_V1.8.8）；~/.dsh-stm32/config.json 存在；工程路径纯 ASCII、源码全 UTF-8；单会话串行操作。B 类条目即以此为「本机不暴露」的判据。
