/**
 * 故障解码：把工具失败事件里的一行原文，翻成「先看哪里」。
 *
 * 只按已知文本特征匹配，不做通用日志理解；没命中就原样返回，由人判断。
 * 规则表按「最具体在前」排列：先匹配到的规则生效，避免 "cmsis-dap" 这类泛词盖住更精确的提示。
 */
const RULES = [
    {
        id: "probe.cmsis-dap-missing",
        category: "probe",
        test: /unable to find a matching cmsis-dap|no cmsis-dap device|没有找到.*cmsis-dap/iu,
        hint: "探针没被识别：确认 USB 线接在数据口、换一个 USB 口，仍失败则重装 DAPLink 驱动或换 ST-Link。",
    },
    {
        id: "probe.openocd-init",
        category: "probe",
        test: /error:\s*init|openocd.*failed|无法.*连接.*探针/iu,
        hint: "调试器初始化失败：先关掉 VS Code 或其它占用探针的程序，再执行 stm32_doctor 看是否有残留进程。",
    },
    {
        id: "target.no-response",
        category: "target",
        test: /no device found|target not found|unable to connect|target.*did not respond/iu,
        hint: "目标芯片没响应：确认板子供电、SWD 四线（3V3/GND/SWDIO/SWCLK）接对，必要时按住复位再连。",
    },
    {
        id: "target.not-halted",
        category: "target",
        test: /target not halted|not halted|cannot.*halt/iu,
        hint: "目标没停住：程序可能关掉了调试口或进了低功耗，检查 .ioc 里 Serial Wire 是否开启。",
    },
    {
        id: "flash.verify",
        category: "flash",
        test: /verified ok|verification failed|校验失败/iu,
        hint: "烧录校验不通过：确认芯片型号与工程一致，重新上电后重烧一次。",
    },
    {
        id: "build.no-build-dir",
        category: "build",
        test: /找不到已配置的构建目录/iu,
        hint: "没有构建目录：先跑一次 cmake 配置（或用 stm32_build 的预设），不要在未配置的目录上直接构建。",
    },
    {
        id: "build.cmake-failed",
        category: "build",
        test: /FAILED: \[code=\d+\]/iu,
        hint: "编译或链接失败：看同一事件里 errors 的前几行，通常是源码写错，或新增的 .c 没有登记进 cmake/user/CMakeLists.txt。",
    },
    {
        id: "build.undefined-reference",
        category: "build",
        test: /undefined reference|undefined symbol/iu,
        hint: "链接缺符号：新加的 .c 是否登记进 cmake/user/CMakeLists.txt，函数声明与实现是否一致。",
    },
    {
        id: "build.missing-header",
        category: "build",
        test: /fatal error:.*\.h: no such file|compilation terminated/iu,
        hint: "编译缺头文件：检查 include 路径与文件名大小写；CubeMX 重新生成后是否漏了某个目录。",
    },
    {
        id: "toolchain.missing-tool",
        category: "toolchain",
        test: /is not recognized as an internal|系统找不到指定的文件|command not found|not found in path/iu,
        hint: "命令不存在：工具链没装或在 PATH 之外，执行 stm32_doctor 后按提示装齐或补 binDirs。",
    },
    {
        id: "network.download",
        category: "network",
        test: /下载安装包失败|download failed|econnrefused|econnreset|getaddrinfo|etimedout|网络/iu,
        hint: "下载失败：先确认网络可达；安装包会自动回退国内镜像，仍失败就手动下载后放进缓存目录。",
    },
    {
        id: "io.permission",
        category: "tool",
        test: /eperm|eacces|permission denied|拒绝访问/iu,
        hint: "权限不足：目标文件被占用或目录只读，关掉占用程序或换一个可写目录。",
    },
    {
        id: "io.busy",
        category: "tool",
        test: /ebusy|being used by another process|另一个程序正在使用/iu,
        hint: "设备或文件被占用：关掉串口助手、CubeProgrammer 等占用方后重试。",
    },
    {
        id: "debug.no-session",
        category: "debug",
        test: /没有调试会话|no active debug session/iu,
        hint: "当前没有调试会话：先调用 stm32_debug_session 建立会话，再操作断点或读取变量。",
    },
    {
        id: "ioc.missing",
        category: "tool",
        test: /没有可读的 \.ioc|no \.ioc/iu,
        hint: "工程里没有 .ioc：确认 projectDir 指向工程根目录，而不是 build 或子目录。",
    },
];
/** 按规则表解码一行失败原文。 */
export function decodeFault(text) {
    const source = text.trim();
    if (source === "")
        return { category: "other", hint: "", rule: "none" };
    for (const rule of RULES) {
        if (rule.test.test(source))
            return { category: rule.category, hint: rule.hint, rule: rule.id };
    }
    return { category: "other", hint: "", rule: "none" };
}
/**
 * 按规则合并失败事件（S46）。
 *
 * 一次构建失败往往连着几条同因错误（多个未定义符号各算一条），逐条列会把
 * 真正不同的那一条挤到屏幕外。合并只影响展示：计数、首末序号与时间保留，
 * 原始事件仍在时间线与 `faults` 列表里。
 */
export function groupFaults(items) {
    const groups = new Map();
    for (const item of items) {
        const found = groups.get(item.rule);
        if (found === undefined) {
            groups.set(item.rule, {
                rule: item.rule,
                category: item.category,
                hint: item.hint,
                count: 1,
                firstSeq: item.seq,
                lastSeq: item.seq,
                firstTime: item.time,
                lastTime: item.time,
            });
            continue;
        }
        groups.set(item.rule, {
            rule: found.rule,
            category: found.category,
            hint: found.hint,
            count: found.count + 1,
            firstSeq: Math.min(found.firstSeq, item.seq),
            lastSeq: Math.max(found.lastSeq, item.seq),
            firstTime: found.firstTime,
            lastTime: item.time,
        });
    }
    return Array.from(groups.values()).sort((left, right) => right.count - left.count || left.rule.localeCompare(right.rule));
}
