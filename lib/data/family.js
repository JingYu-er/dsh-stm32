/**
 * L1：ST 芯片族画像（跨族支持的唯一"族相关"事实表）。
 *
 * 为什么要这一层：插件早期只认 STM32F1——openocd 的 target 脚本名、CubeMX 固件包名、
 * 资源包里的 SVD 目录、硬件断点/观察点个数、.ioc 预设与时钟表，全都写死成 F1。
 * 这些事实**CubeMX 的 db 里没有**（db 只给族 id/内核/主频/封装/引脚/IP），
 * 所以集中放在这里，按族查一次。
 *
 * 反过来，族 id / 内核 / 最高主频 / Flash / RAM / 引脚数**不进这张表**：它们由
 * engine/cubemx-db.ts 的 parseMcuXml 从本机 db/mcu/<Mcu.Name>.xml 读（Family/Core/
 * Frequency/Flash/Ram/IONb）。db 一升级，那些数字自动跟着走，不用改代码。
 *
 * 证据（2026-11 实测，DB.6.0.150 + openocd 0.12.0，Windows）：
 *   - db/mcu 共 2019 个 MCU xml，Family 属性恰好 27 个值（另有 3 个老文件没有 Family）。
 *   - openocd 的 target 目录（share/openocd/scripts/target）里 stm32 的脚本只有：
 *     f0x f1x f2x f3x f4x f7x g0x g4x h7x(+dual_bank) l0(+dual_bank) l1(+dual_bank) l4x
 *     l5x mp13x mp15x u5x wbx wlx x5x_common xl w108xx。
 *     —— 没有 C0/H5/N6/U0/U3/WBA/WB0/WL3/MP2 的专用脚本，这些族 openocdTarget = null，
 *     烧录/调试时给明确拒绝理由，而不是拿别的族的 target 硬连。
 *
 * 能力闸门（capabilities）是**诚实降级**：值为 false 表示插件这条路线还没按该族实现，
 * 调用方应当直接报"不支持"并说清原因，绝不能悄悄用 F1 的表去凑。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const NO_CAPS = {
    halScaffold: false,
    registerScaffold: false,
    iocPresets: false,
    clockPlan: false,
    svdValidation: false,
};
/** F1 是唯一全线跑通的族（第一版目标芯片），五项能力全开。 */
const F1_CAPS = {
    halScaffold: true,
    registerScaffold: true,
    iocPresets: true,
    clockPlan: true,
    svdValidation: true,
};
function profile(init) {
    return {
        id: init.id,
        line: init.line,
        core: init.core,
        openocdTarget: init.target,
        bundledTarget: init.bundled ?? null,
        firmwarePrefix: init.firmware,
        assetSvdDir: init.svd ?? null,
        capabilities: init.caps ?? NO_CAPS,
        note: init.note,
    };
}
/**
 * 增量 1 之后：14 个单核族的 HAL 路线已经按族实现（固件包按族找、启动文件/设备宏/链接脚本/
 * .ioc 模板全部从「CubeMX 固件包 + 资源包芯片表」派生），所以 halScaffold 为 true。
 * 其余能力（寄存器模板 / .ioc 预设 / 时钟规划 / SVD 校验）仍只在 F1 上验过，留给后续增量。
 */
const HAL_CAPS = { ...NO_CAPS, halScaffold: true };
/**
 * 寄存器路线已按族打通：资源包 device/<族>/chips.json 有启动文件/设备宏/Flash/RAM，
 * CMSIS 头从 cmsis-device-<族> + STM32Cube<族> 下载，GPIO 写法按族生成（register-gpio.ts）。
 * 时钟只留复位默认（不猜 PLL 字段），这是刻意的降级，见 register-clock.ts 的 planGenericClock。
 */
const HAL_REG_CAPS = { ...HAL_CAPS, registerScaffold: true };
/** 还没做 HAL 支持的族（双核 / MPU / 范围外）：说明为什么，别让工具悄悄退化。 */
const PENDING_HAL = "HAL 建工程只支持 22 个单核族（C0/F0/F1/F2/F3/F4/F7/G0/G4/H5/H7/L0/L1/L4/L4+/L5/U0/U3/U5/WBA/WL，另加双核的 WB 只建 M4 核），本族不在其中";
const PENDING_REG = "寄存器版模板（CMSIS 头 + 启动文件）目前只有 F1 与资源包已有芯片表的 13 族（C0/F0/F1/F2/F3/F4/F7/G0/G4/L0/L1/L4/U0）";
const REG_OK = "寄存器版已按族打通（CMSIS 头 + 启动文件 + 按族 GPIO；时钟留复位默认）";
const PENDING_PRESET = ".ioc 外设预设表目前只有 F1（下一步按族从 db 的 RefParameter 生成）";
const PENDING_CLOCK = "时钟规划目前只按 F1 的 RCC/PLL 实现";
const NO_SVD = "资源包只有 F1 的 SVD（中断名/寄存器名校验暂不可用）";
/**
 * 每项能力"缺什么"的一句话（给工具报错用，不是给文档用）。
 *
 * 为什么不复用族 note：note 是给人看的整段理由（HAL/寄存器/预设/时钟/SVD 全塞在一条里），
 * 工具拒绝某个参数时只需要那一项的原因。之前直接把 note 拼进 errors，一条报错 300 多字，
 * 用户看不出到底哪一项挡住了他。
 */
export const CAPABILITY_GAPS = {
    halScaffold: "HAL 建工程（模板/启动文件/链接脚本/设备宏）按 22 个单核族的固件包实现",
    registerScaffold: "寄存器版模板（CMSIS 头 + 启动文件）只有资源包已有芯片表的 13 族：C0/F0/F1/F2/F3/F4/F7/G0/G4/L0/L1/L4/U0",
    iocPresets: "手写 .ioc 预设表只有 F1（其它族靠 db 派生 USART/UART/LPUART，TIM/ADC/DMA 仍需手写键）",
    clockPlan: "时钟规划只按 F1 的 RCC/PLL 键实现",
    svdValidation: "中断名/寄存器名校验要该族的 SVD，资源包目前只有 F1 的",
};
/** 某项能力在某个族上缺什么（含族 id），供工具直接拼进告警/拒绝理由。 */
export function capabilityGap(profile, capability) {
    return profile.id + "：" + CAPABILITY_GAPS[capability];
}
/**
 * 27 个族的画像（顺序按 db 里的族字母排，便于比对）。
 *
 * firmwarePrefix 只写**已确认**的固件包名（ST 的命名就是 STM32Cube_FW_<族>，L4+ 零件在 L4 包里）；
 * 不确定的（WB0/WL3）写 null 并在 note 里说明，不在运行时猜。
 */
const PROFILES = [
    profile({
        id: "STM32C0", line: "C0", core: "Cortex-M0+", target: null, bundled: "stm32c0x", firmware: "STM32Cube_FW_C0", caps: HAL_REG_CAPS,
        note: "openocd 0.12 没有 stm32c0x.cfg（C0 是 2023 年后的产品线）：插件内置一份适配 0.12 的脚本（templates/openocd/stm32c0x.cfg）",
    }),
    profile({
        id: "STM32F0", line: "F0", core: "Cortex-M0", target: "stm32f0x", firmware: "STM32Cube_FW_F0", caps: HAL_REG_CAPS,
        note: REG_OK + "；" + PENDING_PRESET + "；" + PENDING_CLOCK + "；" + NO_SVD,
    }),
    profile({
        id: "STM32F1", line: "F1", core: "Cortex-M3", target: "stm32f1x", firmware: "STM32Cube_FW_F1",
        svd: "device/f1/svd", caps: F1_CAPS,
        note: "唯一全线跑通的族：HAL/寄存器两条建工程路线、.ioc 预设、时钟规划、SVD 校验都在 F1 上验过（蓝丸 F103C8T6 + RCT6 + F107）",
    }),
    profile({
        id: "STM32F2", line: "F2", core: "Cortex-M3", target: "stm32f2x", firmware: "STM32Cube_FW_F2", caps: HAL_REG_CAPS,
        note: REG_OK + "；" + PENDING_PRESET + "；" + PENDING_CLOCK + "；" + NO_SVD,
    }),
    profile({
        id: "STM32F3", line: "F3", core: "Cortex-M4", target: "stm32f3x", firmware: "STM32Cube_FW_F3", caps: HAL_REG_CAPS,
        note: REG_OK + "；" + PENDING_PRESET + "；" + PENDING_CLOCK + "；" + NO_SVD,
    }),
    profile({
        id: "STM32F4", line: "F4", core: "Cortex-M4", target: "stm32f4x", firmware: "STM32Cube_FW_F4", caps: HAL_REG_CAPS,
        note: REG_OK + "；" + PENDING_PRESET + "；" + PENDING_CLOCK + "；" + NO_SVD,
    }),
    profile({
        id: "STM32F7", line: "F7", core: "Cortex-M7", target: "stm32f7x", firmware: "STM32Cube_FW_F7", caps: HAL_REG_CAPS,
        note: REG_OK + "；" + PENDING_PRESET + "；" + PENDING_CLOCK + "；" + NO_SVD,
    }),
    profile({
        id: "STM32G0", line: "G0", core: "Cortex-M0+", target: "stm32g0x", firmware: "STM32Cube_FW_G0", caps: HAL_REG_CAPS,
        note: REG_OK + "；" + PENDING_PRESET + "；" + PENDING_CLOCK + "；" + NO_SVD,
    }),
    profile({
        id: "STM32G4", line: "G4", core: "Cortex-M4", target: "stm32g4x", firmware: "STM32Cube_FW_G4", caps: HAL_REG_CAPS,
        note: REG_OK + "；" + PENDING_PRESET + "；" + PENDING_CLOCK + "；" + NO_SVD,
    }),
    profile({
        id: "STM32H5", line: "H5", core: "Cortex-M33", target: null, firmware: "STM32Cube_FW_H5", caps: HAL_CAPS,
        note: "openocd 0.12 只有 stm32x5x_common.cfg（公共片段），没有 h5x 目标脚本 —— 不能用 u5x 顶替",
    }),
    profile({
        id: "STM32H7", line: "H7", core: "Cortex-M7", target: "stm32h7x", firmware: "STM32Cube_FW_H7", caps: HAL_CAPS,
        note: "双 bank 器件可用 openocd.cfg 里改 source target/stm32h7x_dual_bank.cfg" + "；" + PENDING_CLOCK,
    }),
    profile({
        id: "STM32L0", line: "L0", core: "Cortex-M0+", target: "stm32l0", firmware: "STM32Cube_FW_L0", caps: HAL_REG_CAPS,
        note: REG_OK + "；" + PENDING_PRESET + "；" + PENDING_CLOCK + "；" + NO_SVD,
    }),
    profile({
        id: "STM32L1", line: "L1", core: "Cortex-M3", target: "stm32l1", firmware: "STM32Cube_FW_L1", caps: HAL_REG_CAPS,
        note: REG_OK + "；" + PENDING_PRESET + "；" + PENDING_CLOCK + "；" + NO_SVD,
    }),
    profile({
        id: "STM32L4", line: "L4", core: "Cortex-M4", target: "stm32l4x", firmware: "STM32Cube_FW_L4", caps: HAL_REG_CAPS,
        note: REG_OK + "；" + PENDING_PRESET + "；" + PENDING_CLOCK + "；" + NO_SVD,
    }),
    profile({
        id: "STM32L4+", line: "L4+", core: "Cortex-M4", target: "stm32l4x", firmware: "STM32Cube_FW_L4", caps: HAL_CAPS,
        note: "L4+ 零件（L4P5/L4Q5/L4R5/L4S5…）共用 STM32Cube_FW_L4 固件包与 openocd 的 stm32l4x.cfg" + "；" + PENDING_CLOCK,
    }),
    profile({
        id: "STM32L5", line: "L5", core: "Cortex-M33", target: "stm32l5x", firmware: "STM32Cube_FW_L5", caps: HAL_CAPS,
        note: PENDING_REG + "；" + PENDING_PRESET + "；" + PENDING_CLOCK + "；" + NO_SVD,
    }),
    profile({
        id: "STM32MP1", line: "MP1", core: "Cortex-A7", target: "stm32mp15x", firmware: "STM32Cube_FW_MP1",
        note: "MPU：裸机要跑在 M4 协处理上，A7 侧是 Linux/OpenSTLinux —— 本插件的建工程与调试路线都不适用" + "；" + NO_SVD,
    }),
    profile({
        id: "STM32MP2", line: "MP2", core: "Cortex-A35", target: null, firmware: "STM32Cube_FW_MP2",
        note: "MPU：openocd 0.12 没有 mp2 目标脚本，且本插件的建工程/调试路线不适用于 A35 + M33 的 MPU",
    }),
    profile({
        id: "STM32N6", line: "N6", core: "Cortex-M55", target: null, firmware: "STM32Cube_FW_N6",
        note: "openocd 0.12 没有 n6 目标脚本（NPU 系列，2024 年后产品）",
    }),
    profile({
        id: "STM32U0", line: "U0", core: "Cortex-M0+", target: null, bundled: "stm32u0x", firmware: "STM32Cube_FW_U0", caps: HAL_REG_CAPS,
        note: "openocd 0.12 没有 u0 目标脚本：插件内置一份适配 0.12 的脚本（templates/openocd/stm32u0x.cfg）",
    }),
    profile({
        id: "STM32U3", line: "U3", core: "Cortex-M33", target: null, firmware: "STM32Cube_FW_U3", caps: HAL_CAPS,
        note: "openocd 0.12 没有 u3 目标脚本",
    }),
    profile({
        id: "STM32U5", line: "U5", core: "Cortex-M33", target: "stm32u5x", firmware: "STM32Cube_FW_U5", caps: HAL_CAPS,
        note: PENDING_REG + "；" + PENDING_PRESET + "；" + PENDING_CLOCK + "；" + NO_SVD,
    }),
    profile({
        id: "STM32WB", line: "WB", core: "Cortex-M4", target: "stm32wbx", firmware: "STM32Cube_FW_WB",
        note: "双核（M4 + M0+ 射频核）：只对 M4 应用核建工程/调试，射频核不碰" + "；" + PENDING_HAL + "；" + PENDING_CLOCK,
    }),
    profile({
        id: "STM32WB0", line: "WB0", core: "Cortex-M0+", target: null, firmware: null,
        note: "openocd 0.12 没有 wb0 目标脚本；固件包名未确认（STM32CubeWB0 还是并入 WB），运行时不去猜",
    }),
    profile({
        id: "STM32WBA", line: "WBA", core: "Cortex-M33", target: null, firmware: "STM32Cube_FW_WBA", caps: HAL_CAPS,
        note: "openocd 0.12 没有 wba 目标脚本",
    }),
    profile({
        id: "STM32WL", line: "WL", core: "Cortex-M4", target: "stm32wlx", firmware: "STM32Cube_FW_WL", caps: HAL_CAPS,
        note: "Sub-GHz 无线：M4 应用核可建工程/调试，射频部分不碰" + "；" + PENDING_CLOCK,
    }),
    profile({
        id: "STM32WL3", line: "WL3", core: "Cortex-M0+", target: null, firmware: null,
        note: "openocd 0.12 没有 wl3 目标脚本；固件包名未确认",
    }),
];
const BY_ID = new Map(PROFILES.map((item) => [item.id.toUpperCase(), item]));
/** 所有有画像的族（27 条，含 MPU）。 */
export function familyProfiles() {
    return PROFILES;
}
/**
 * 型号 → 族 id。只做字符串判定，不查 db（db 里 MCU xml 的 Family 属性是更权威的来源，
 * 见 engine/cubemx-db.ts 的 parseMcuXml；这里用于没有 db 的场合与 .ioc 缺失时的兜底）。
 *
 * 例：STM32F103C8T6 → STM32F1；STM32L4R5ZIT6 → STM32L4+；STM32WBA55CG → STM32WBA；
 *    STM32H563ZI → STM32H5；STM32U575ZI → STM32U5；STM32G071RB → STM32G0。
 */
export function familyIdOfPart(part) {
    const raw = part.trim().toUpperCase();
    if (!raw.startsWith("STM32"))
        return "";
    const tail = raw.slice("STM32".length);
    // 族段长度不一（C0/F1/H7 两位，WB/WL 两位无数字，WBA/WB0/WL3/MP1/MP2 三位），
    // 与其写一堆正则特例，不如直接拿族表里的段做前缀匹配、取最长的那个：
    //   STM32WBA55CG → WBA（3）胜过 WB；STM32WB55RG → WB；STM32H563ZI → H5。
    // 边界条件：族段后面必须紧跟数字或字符串结束。否则 STM32L4R5ZIT6 会被判成 L4（"L4" 后面是字母 R）。
    // L4+ 要先判：L4P5/L4Q5/L4R5/L4S5 的前缀也是 L4，等到循环里就会被 L4 抢走。
    if (/^L4[PQRS]/u.test(tail))
        return "STM32L4+";
    let best = "";
    let bestSegment = 0; // 记住"最长的族段"，不能拿族 id 的长度比（"STM32WB" 比 "WB0" 长，会选错）
    for (const item of PROFILES) {
        const segment = item.id.slice("STM32".length).toUpperCase();
        // L4+ 不是字面前缀：零件名是 L4P/L4Q/L4R/L4S（族属性写 STM32L4+，不是笔误），走下面单独判。
        if (segment.endsWith("+"))
            continue;
        if (!tail.startsWith(segment))
            continue;
        const next = tail.slice(segment.length, segment.length + 1);
        // 后面跟字母时，只有「字母+数字」这种子族段才算继续（H7A3 的 A3、H7B0 的 B0）；
        // 单纯的字母说明这是别的族（L4R5 已在上面按 L4+ 处理，WB55 的 B 后面是 5 但 segment WB 更短、不冲突）。
        const after = tail.slice(segment.length + 1, segment.length + 2);
        if (next !== "" && /[A-Z]/u.test(next) && !/[0-9]/u.test(after))
            continue;
        if (segment.length > bestSegment) {
            best = item.id;
            bestSegment = segment.length;
        }
    }
    return best;
}
/** 族 id / 型号 / 族段（"F1"、"STM32F1"）→ 画像；认不出的族返回一个"全不支持"的画像。 */
export function familyProfileOf(idOrPart) {
    const raw = idOrPart.trim().toUpperCase();
    if (raw === "")
        return unknownFamilyProfile("");
    const direct = BY_ID.get(raw);
    if (direct !== undefined)
        return direct;
    // "F1" / "L4+" / "WBA" 这种族段
    if (/^[A-Z]{1,2}[0-9]\+?$/u.test(raw)) {
        const byLine = BY_ID.get("STM32" + raw);
        if (byLine !== undefined)
            return byLine;
    }
    const byPart = familyIdOfPart(raw);
    if (byPart !== "") {
        const found = BY_ID.get(byPart.toUpperCase());
        if (found !== undefined)
            return found;
    }
    return unknownFamilyProfile(idOrPart);
}
/** 认不出的族：id 原样保留，能力全 false，note 说清"别猜"。 */
export function unknownFamilyProfile(id) {
    return {
        id: id.trim() === "" ? "未知族" : id.trim(),
        line: "",
        core: "",
        openocdTarget: null,
        bundledTarget: null,
        firmwarePrefix: null,
        assetSvdDir: null,
        capabilities: NO_CAPS,
        note: "没有这个族的画像（不是已知的 27 个 STM32 族之一）：所有按族的能力一律不放行，先确认型号拼写",
    };
}
/** 该族是否就是 F1（第一版唯一全线支持的族，供调用方做"新旧行为"分支）。 */
export function isF1(profile) {
    return profile.id.toUpperCase() === "STM32F1";
}
/**
 * 按内核的硬件预算（ARM 文档值，不是某个型号的实测值）：
 *   Cortex-M0 / M0+ → 4 断点 / 2 观察点（FPB 只有 4 个比较器、DWT 2 个）
 *   Cortex-M3 / M4  → 6 / 4
 *   Cortex-M7 / M33 / M55 → 8 / 4
 * 单型号可以在资源包 chips.json 里写 breakpoints/watchpoints 覆盖（breakpoints.ts 优先用它）。
 */
// 顺序有讲究：M33 里含有 "m3" 子串，所以 M7/M33/M55 必须排在 M3/M4 前面判。
const CORE_BUDGETS = [
    [/cortex-m0/i, { code: 4, data: 2 }],
    [/cortex-m7|cortex-m33|cortex-m55/i, { code: 8, data: 4 }],
    [/cortex-m3|cortex-m4/i, { code: 6, data: 4 }],
];
/** F1（Cortex-M3）的实测值，也是所有查不到内核时的兜底。 */
export const FALLBACK_DEBUG_BUDGET = { code: 6, data: 4 };
/** 内核名 → 硬件断点/观察点预算；查不到返回 F1 的 6/4（调用方应在 notes 里说明是兜底）。 */
export function debugBudgetForCore(core) {
    const raw = core.trim();
    if (raw === "")
        return FALLBACK_DEBUG_BUDGET;
    for (const [pattern, budget] of CORE_BUDGETS) {
        if (pattern.test(raw))
            return budget;
    }
    return FALLBACK_DEBUG_BUDGET;
}
/**
 * 族画像 → 预算（MPU 的 A7/A35 不用这个模型，返回 null 让调用方跳过比较器预算）。
 * 内核未知（空串）也返回 null：不知道内核就不该假装算得出一条数值预算，
 * 让调用方退回"按 F1 兜底并说明原因"的老路径。
 */
export function debugBudgetOfFamily(profile) {
    const core = profile.core.trim();
    if (core === "")
        return null;
    if (/cortex-a/i.test(core))
        return null;
    return debugBudgetForCore(core);
}
/**
 * 插件内置的 target 脚本绝对路径（C0 → templates/openocd/stm32c0x.cfg）。
 *
 * 为什么要内置：openocd 0.12（2023-01 的最后一个正式版）没有 stm32c0x.cfg / stm32u0x.cfg，
 * 而这两族已经在 14 个单核族的支持范围里。上游 master 版脚本只用了 0.13 才有的
 * `dap create ... -tap`，把它换成 0.12 认的 `-chain-position` 就能完整加载（adapter/target/flash bank
 * 全部通过，只有没接探针时 init 会报 CMSIS-DAP CMD_INFO failed）。
 * 文件放在插件模板目录而不是系统 openocd 目录：升级/卸载 openocd 不会把支持弄丢，
 * 也不去改用户机器上的 openocd 安装。
 */
export function bundledOpenocdConfig(name) {
    const trimmed = name.trim();
    if (trimmed === "")
        return null;
    const file = fileURLToPath(new URL("../../templates/openocd/" + trimmed + ".cfg", import.meta.url));
    return existsSync(file) ? file : null;
}
/**
 * 族 → openocd target 配置。
 *
 * family 传 null 表示"工程里没有 .ioc / 认不出族"：保持历史行为回退 stm32f1x，
 * 但在 note 里说明这是兜底（用户可自己在 openocd.cfg 里写 target）。
 */
export function chooseOpenocdTarget(family) {
    if (family === null) {
        return {
            targetConfig: "target/stm32f1x.cfg",
            note: "工程里没有可读的 .ioc（认不出芯片族），openocd 回退 target/stm32f1x.cfg；换族请在工程里放 openocd.cfg 写死 target",
            error: "",
            bundled: false,
        };
    }
    if (family.openocdTarget === null) {
        // 没有官方脚本但有内置脚本（C0 / U0）：用插件自带的那份，而不是拒绝
        if (family.bundledTarget !== null) {
            const bundled = bundledOpenocdConfig(family.bundledTarget);
            if (bundled !== null) {
                return {
                    targetConfig: bundled,
                    note: family.id + " 的 target 脚本 openocd 0.12 里没有，改用插件内置的 " + bundled,
                    error: "",
                    bundled: true,
                };
            }
            return {
                targetConfig: "",
                note: family.note,
                error: family.id + " 要靠插件内置的 target 脚本烧录/调试，但模板里没有 templates/openocd/" + family.bundledTarget +
                    ".cfg（插件安装不完整）：重新安装插件，或在工程根目录放一份 openocd.cfg 写死 target",
                bundled: false,
            };
        }
        return {
            targetConfig: "",
            note: family.note,
            error: "本机 openocd 没有 " + family.id + " 的 target 脚本（" + family.note + "）：" +
                "请在工程根目录放一份 openocd.cfg 写死 source [find target/xxx.cfg]，或用 openocd 的 -f 显式指定；" +
                "不要拿别的族的 target 硬连（会连不上或读错 flash 布局）",
            bundled: false,
        };
    }
    return {
        targetConfig: "target/" + family.openocdTarget + ".cfg",
        note: "",
        error: "",
        bundled: false,
    };
}
// ── 从工程里读族 ────────────────────────────────────────────────────────────
/**
 * 工程里 .ioc 的 Mcu.Family（例如 STM32F1）。找不到/读不出来返回空串。
 *
 * 多个 .ioc 时按文件名排序取第一个读得出 Mcu.Family 的（与 breakpoints.ts 的 readIocCpn 同规则）。
 */
export function readIocFamilyId(projectDir) {
    let names;
    try {
        names = readdirSync(projectDir);
    }
    catch {
        return "";
    }
    const candidates = names.filter((name) => name.toLowerCase().endsWith(".ioc")).sort();
    for (const name of candidates) {
        try {
            const text = readFileSync(join(projectDir, name), "utf8");
            const matched = /^Mcu\.Family=(.+)$/mu.exec(text);
            const family = matched === null ? "" : (matched[1] ?? "").trim();
            if (family !== "")
                return family;
        }
        catch {
            // 读不了就试下一个
        }
        // 没有 Mcu.Family 的老 .ioc：退回按 Mcu.CPN 推族。
        try {
            const text = readFileSync(join(projectDir, name), "utf8");
            const matched = /^Mcu\.CPN=(.+)$/mu.exec(text);
            const cpn = matched === null ? "" : (matched[1] ?? "").trim();
            const id = familyIdOfPart(cpn);
            if (id !== "")
                return id;
        }
        catch {
            // 同上
        }
    }
    return "";
}
/** 工程 → 族画像；认不出返回 null（调用方按"没有 .ioc"处理）。 */
export function readProjectFamily(projectDir) {
    const id = readIocFamilyId(projectDir);
    if (id === "")
        return null;
    const profileOfIoc = familyProfileOf(id);
    // familyProfileOf 认不出时会返回"未知族"画像，这里区分开：真未知也要返回画像（能力全 false），
    // 只是 id 不是空串，所以用 BY_ID 判断是否已知。
    return profileOfIoc;
}
/** 该族画像是否来自已知的 27 个族之一。 */
export function isKnownFamily(profile) {
    return BY_ID.has(profile.id.toUpperCase());
}
/**
 * EXTI 分组的机制：Cortex 内核的 NVIC 只有一条 EXTI 线的位图，
 * 「哪几条线共用一个向量」是**硅片厂商在芯片层面**捆的，和内核强相关：
 *   M0 / M0+（C0/F0/G0/L0/U0/WB0/WL3）→ EXTI0_1（0-1）、EXTI2_3（2-3）、EXTI4_15（4-15）
 *   M3 / M4 / M7（F1/F2/F3/F4/F7/G4/L1/L4/WB/WL/H7）→ EXTI0..EXTI4 逐线、EXTI9_5（5-9）、EXTI15_10（10-15）
 *   M33 / M55（H5/L5/U3/U5/N6/WBA）→ 16 条线全部逐线 EXTI0..EXTI15
 *   Cortex-A（MP1/MP2）→ 不走 NVIC/EXTI 模型，空表
 *
 * 证据（2026-11，504 份 CubeMX 板级 .ioc 里 NVIC.EXTI*_IRQn 的实测分布）：
 *   C0 → 只有 EXTI4_15；L0 → EXTI0_1 + EXTI4_15；F1 → EXTI15_10（板级模板没用到 5-9 那一档）；
 *   F4/G4/L4/WB → EXTI0..EXTI4 + EXTI9_5 + EXTI15_10；U5/WBA → 逐线 EXTI0..EXTI15；N6 → EXTI13。
 * 也就是说：拿 F1 的分组去写 C0/L0/U5，会写出一个该芯片根本不存在的向量名，CubeMX 静默丢弃。
 */
const M0_EXTI_VECTORS = [
    { name: "EXTI0_1", from: 0, to: 1 },
    { name: "EXTI2_3", from: 2, to: 3 },
    { name: "EXTI4_15", from: 4, to: 15 },
];
const M3M4M7_EXTI_VECTORS = [
    { name: "EXTI0", from: 0, to: 0 },
    { name: "EXTI1", from: 1, to: 1 },
    { name: "EXTI2", from: 2, to: 2 },
    { name: "EXTI3", from: 3, to: 3 },
    { name: "EXTI4", from: 4, to: 4 },
    { name: "EXTI9_5", from: 5, to: 9 },
    { name: "EXTI15_10", from: 10, to: 15 },
];
/** M33/M55：16 条线各一个向量（EXTI0..EXTI15）。 */
const PER_LINE_EXTI_VECTORS = Array.from({ length: 16 }, (_, line) => ({
    name: "EXTI" + String(line),
    from: line,
    to: line,
}));
/** 认不出内核时的兜底：F1 的 M3 分组（保持历史行为，调用方应在 notes 里说明）。 */
export const FALLBACK_EXTI_VECTORS = M3M4M7_EXTI_VECTORS;
/**
 * 族 → EXTI 向量分组。profile 为 null（工程里读不到族）时返回 F1 的 M3 分组，
 * 这是历史行为，调用方要自行在报告里说明"分组按 M3 兜底"。
 */
export function extiVectorsOf(profile) {
    const core = (profile?.core ?? "").trim();
    if (core === "")
        return FALLBACK_EXTI_VECTORS;
    if (/cortex-m0/i.test(core))
        return M0_EXTI_VECTORS;
    if (/cortex-m33|cortex-m55/i.test(core))
        return PER_LINE_EXTI_VECTORS;
    if (/cortex-a/i.test(core))
        return [];
    return M3M4M7_EXTI_VECTORS;
}
/** EXTI 线号 → 该族的 NVIC 中断名（不带 _IRQn）；这根线不在任何向量里返回空串。 */
export function extiVectorNameOf(line, profile) {
    for (const vector of extiVectorsOf(profile)) {
        if (line >= vector.from && line <= vector.to)
            return vector.name;
    }
    return "";
}
