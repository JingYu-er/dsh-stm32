/**
 * 寄存器路线的时钟配置（F1 全系，按 line 决定上限）。
 *
 * 为什么寄存器路线要自己配时钟：HAL 路线由 CubeMX 生成的 SystemClock_Config() 负责，
 * 而寄存器路线不用 CubeMX、也不用固件包，从模板拷过去的 main.c 里只有 HSI 8 MHz——
 * 72 MHz 的板子在 8 MHz 上跑，串口/延时/定时全要按 8 MHz 算，而且用户会以为"F1 就该这么快"。
 * 所以这里按芯片型号算出一段 clock_init()，生成 main.c 时写进去。
 *
 * 所有数字都查过 RM0008/RM0038/RM0041 和 14 个真实设备头（2026-10-30 实测，见
 * data/cmsis-sources.ts 的哈希表）：
 *   · 各 line 的 SYSCLK 上限：F100 24 MHz、F101 36 MHz、F102 48 MHz、F103/105/107 72 MHz
 *   · Flash 等待周期：≤24 MHz 用 0，≤48 MHz 用 1，72 MHz 用 2（RM0008 §3.3.3）
 *   · APB1 上限 36 MHz（F100 是 24 MHz，这里 F100 的 SYSCLK 只有 24 MHz 所以 /1 也够）
 *   · F100 的 FLASH_ACR 没有 LATENCY / PRFTBE 字段（只有 HLFCYA），所以 F100 完全不碰 FLASH
 *
 * PLL 一律走 HSE 8 MHz（蓝丸/大多数 F1 小板都是 8 MHz 晶振），算出来正好等于该 line 的上限；
 * HSE 没起（没焊晶振）时退回 HSI/2 4 MHz × 倍频，F103/105/107 因为 4×18 > 16 只能到 64 MHz，
 * 这时候会往 report 里塞一条 warning，让用户知道"没跑在 72"。
 *
 * 为什么不用 RCC_CFGR_PLLMULL9 之类的倍频宏：F100/F101 的可用倍频档位和设备头里定义的宏
 * 并不齐全（实测 f100 没有 PLLMULL6，f105/f107 没有 PLLMULL16），而 PLLMUL 字段的编码
 * 全家族一致（0=×2 … 14=×16，bit21:18）。所以这里统一按 (倍频 - 2) << 18 写，
 * 只依赖全 14 个设备头都有的 RCC_CFGR_PLLMULL_Msk / _Pos。
 */
/** 实测过的 HSE 频率（蓝丸、绝大多数 F1 最小系统板）。 */
export const REGISTER_HSE_HZ = 8_000_000;
/** HSI 出厂频率（RM0008：8 MHz ±1%）。 */
export const REGISTER_HSI_HZ = 8_000_000;
/**
 * 按 line 的时钟表。hseMul/hseDiv 是"8 MHz 晶振拿到该 line 上限"的唯一组合：
 *   24 = 8×3 · 36 = 8/2×9 · 48 = 8×6 · 72 = 8×9
 */
const LINE_CLOCK = {
    "100": { maxMHz: 24, hseMul: 3, hseDiv: 1, apb1Div: 1, hasFlashLatency: false },
    "101": { maxMHz: 36, hseMul: 9, hseDiv: 2, apb1Div: 1, hasFlashLatency: true },
    "102": { maxMHz: 48, hseMul: 6, hseDiv: 1, apb1Div: 2, hasFlashLatency: true },
    "103": { maxMHz: 72, hseMul: 9, hseDiv: 1, apb1Div: 2, hasFlashLatency: true },
    "105": { maxMHz: 72, hseMul: 9, hseDiv: 1, apb1Div: 2, hasFlashLatency: true },
    "107": { maxMHz: 72, hseMul: 9, hseDiv: 1, apb1Div: 2, hasFlashLatency: true },
};
/** line 代号：STM32F103 → 103。 */
function lineOf(chip) {
    return chip.prefix.slice(6);
}
/** 等待周期：RM0008 Table 3（0 WS ≤ 24 MHz，1 WS ≤ 48 MHz，2 WS ≤ 72 MHz）。 */
function latencyFor(hz) {
    if (hz <= 24_000_000)
        return 0;
    if (hz <= 48_000_000)
        return 1;
    return 2;
}
/**
 * 给一颗芯片算时钟方案。只读、纯函数；不认识 line 时按 F103 处理并记 warning
 * （宁可给一个能跑的 72 MHz，也不抛异常让整个工程建不出来）。
 */
export function planRegisterClock(chip) {
    const line = lineOf(chip);
    const warnings = [];
    let spec = LINE_CLOCK[line];
    if (spec === undefined) {
        warnings.push("时钟表里还没有 F" + line + "，先按 F103 的 72 MHz 方案生成；确认这颗芯片能跑到 72 MHz 后请把 line 补进 register-clock.ts 的 LINE_CLOCK。");
        spec = LINE_CLOCK["103"];
    }
    const hseHz = REGISTER_HSE_HZ;
    const pllInHz = hseHz / spec.hseDiv;
    const sysclkHz = pllInHz * spec.hseMul;
    const hsiMul = Math.min(16, Math.max(2, Math.round(spec.maxMHz / (REGISTER_HSI_HZ / 2 / 1_000_000))));
    const hsiSysclkHz = (REGISTER_HSI_HZ / 2) * hsiMul;
    const flashLatency = spec.hasFlashLatency ? latencyFor(Math.max(sysclkHz, hsiSysclkHz)) : 0;
    const apb1Div = sysclkHz > 36_000_000 ? 2 : spec.apb1Div;
    const apb2Div = 1;
    const ahbHz = sysclkHz;
    const apb1Hz = ahbHz / apb1Div;
    const apb2Hz = ahbHz / apb2Div;
    if (sysclkHz !== spec.maxMHz * 1_000_000) {
        warnings.push("内部不一致：按 HSE " + hseHz + " Hz × " + spec.hseMul + " / " + spec.hseDiv + " 算出来是 " + sysclkHz + " Hz，但 F" + line + " 的上限是 " + spec.maxMHz + " MHz；请检查 register-clock.ts 的表。");
    }
    if (hsiSysclkHz < sysclkHz) {
        warnings.push("HSE 没起（常见原因：板上没焊 8 MHz 晶振）时会退回 HSI/2 × " + hsiMul + " = " + Math.round(hsiSysclkHz / 1e6) + " MHz，比 " + Math.round(sysclkHz / 1e6) + " MHz 慢；生成的 clock_init() 已经带兜底，不用改代码。");
    }
    if (!spec.hasFlashLatency) {
        warnings.push("F" + line + " 的 FLASH_ACR 只有 HLFCYA、没有 LATENCY/PRFTBE 字段，生成的 clock_init() 不写 FLASH->ACR（该 line 的 SYSCLK 上限本来就不需要等待周期）。");
    }
    const summary = Math.round(sysclkHz / 1e6) + " MHz（HSE " + Math.round(hseHz / 1e6) + " MHz"
        + (spec.hseDiv === 2 ? " / 2" : "") + " × " + spec.hseMul + "；AHB /" + 1 + "、APB1 /" + apb1Div
        + " = " + Math.round(apb1Hz / 1e6) + " MHz、APB2 /" + apb2Div + " = " + Math.round(apb2Hz / 1e6) + " MHz"
        + (spec.hasFlashLatency ? "；Flash " + flashLatency + " 等待周期" : "") + "）";
    return {
        mcu: chip.cpn,
        line,
        hseHz,
        sysclkHz,
        pllMul: spec.hseMul,
        hseDiv: spec.hseDiv,
        hsiMul,
        hsiSysclkHz,
        flashLatency,
        hasFlashLatency: spec.hasFlashLatency,
        apb1Div,
        apb2Div,
        ahbHz,
        apb1Hz,
        apb2Hz,
        hsiApb1Hz: Math.round(hsiSysclkHz / apb1Div),
        summary,
        warnings,
    };
}
/** 生成 main.c 里那一整块时钟代码（含注释、宏、clock_init）。 */
export function renderClockInit(plan) {
    const lines = [];
    const push = (...text) => {
        for (const t of text)
            lines.push(t);
    };
    push("/* ---------------------------------------------------------------------------", " * 时钟：" + plan.mcu + " @ " + plan.summary, " *   HSE " + Math.round(plan.hseHz / 1e6) + " MHz" + (plan.hseDiv === 2 ? " / 2" : "") + " × " + plan.pllMul
        + " = " + Math.round(plan.sysclkHz / 1e6) + " MHz（PLL）", " *   HSE 起不来时自动退回 HSI/2 × " + plan.hsiMul + " = " + Math.round(plan.hsiSysclkHz / 1e6) + " MHz，不会卡死", " *   这段是按型号算出来的，不依赖 CubeMX 生成物；换晶振改 DSH_HSE_HZ 一个数即可", " * -------------------------------------------------------------------------*/", "#define DSH_HSE_HZ          " + plan.hseHz + "u", "#define DSH_PLL_MUL         " + plan.pllMul + "u", "#define DSH_HSI_MUL         " + plan.hsiMul + "u", "#define DSH_SYSCLK_HZ       " + plan.sysclkHz + "u", "#define DSH_APB1_DIV        " + plan.apb1Div + "u");
    if (plan.hseDiv === 2)
        push("#define DSH_HSE_DIV         2u");
    if (plan.hasFlashLatency)
        push("#define DSH_FLASH_LATENCY   " + plan.flashLatency + "u");
    push("", "/*", " * 把 SYSCLK 从复位默认的 HSI 8 MHz 切到 PLL。" + (plan.hasFlashLatency ? "顺序不能换：先加 Flash 等待周期，再切时钟。" : ""), " * HSE 就绪用有限次自旋等（不依赖中断，也不会因为没焊晶振死在这里）。", " */", "static void clock_init(void)", "{", "    uint32_t cfgr;", "    uint32_t spin;", "    int use_hse;", "");
    if (plan.hasFlashLatency) {
        push("    /* 1) Flash 等待周期：" + Math.round(plan.sysclkHz / 1e6) + " MHz 用 " + plan.flashLatency + " 个（先设再提速） */", "    FLASH->ACR = FLASH_ACR_PRFTBE | (DSH_FLASH_LATENCY << FLASH_ACR_LATENCY_Pos);", "");
    }
    push("    /* 2) 先把 SYSCLK 切回 HSI（重复调用也安全），再动 PLL */", "    cfgr = RCC->CFGR;", "    cfgr = (cfgr & ~RCC_CFGR_SW_Msk) | RCC_CFGR_SW_HSI;", "    RCC->CFGR = cfgr;", "    spin = 0u;", "    while (((RCC->CFGR & RCC_CFGR_SWS_Msk) != RCC_CFGR_SWS_HSI) && (spin < 100000u)) { spin++; }", "", "    /* 3) 开 HSE 并等就绪；等不到就用 HSI/2 当 PLL 源 */", "    RCC->CR |= RCC_CR_HSEON;", "    spin = 0u;", "    while (((RCC->CR & RCC_CR_HSERDY) == 0u) && (spin < 100000u)) { spin++; }", "    use_hse = ((RCC->CR & RCC_CR_HSERDY) != 0u) ? 1 : 0;", "", "    /* 4) 关 PLL 才能改 PLL 参数（RM0008 要求 PLL 关闭时改 PLLSRC/PLLMUL） */", "    RCC->CR &= ~RCC_CR_PLLON;", "    spin = 0u;", "    while (((RCC->CR & RCC_CR_PLLRDY) != 0u) && (spin < 100000u)) { spin++; }", "", "    /* 5) 组 CFGR：AHB /1、APB2 /1、APB1" + (plan.apb1Div === 2 ? " /2" : " /1") + "（F1 的 APB1 上限 36 MHz） */", "    cfgr = RCC->CFGR;", "    cfgr &= ~(RCC_CFGR_HPRE_Msk | RCC_CFGR_PPRE1_Msk | RCC_CFGR_PPRE2_Msk | RCC_CFGR_PLLSRC | RCC_CFGR_PLLXTPRE | RCC_CFGR_PLLMULL_Msk);", "    cfgr |= RCC_CFGR_HPRE_DIV1 | RCC_CFGR_PPRE2_DIV1;", "    cfgr |= (DSH_APB1_DIV == 2u) ? RCC_CFGR_PPRE1_DIV2 : RCC_CFGR_PPRE1_DIV1;", "    if (use_hse != 0) {", "        cfgr |= RCC_CFGR_PLLSRC;   /* PLL 源 = HSE" + (plan.hseDiv === 2 ? "（先 /2 再进 PLL）" : "") + " */");
    if (plan.hseDiv === 2)
        push("        cfgr |= RCC_CFGR_PLLXTPRE;");
    push("        cfgr |= ((uint32_t)(DSH_PLL_MUL - 2u) << RCC_CFGR_PLLMULL_Pos);", "    } else {", "        cfgr |= ((uint32_t)(DSH_HSI_MUL - 2u) << RCC_CFGR_PLLMULL_Pos);   /* 0 = HSI/2 进 PLL */", "    }", "    RCC->CFGR = cfgr;", "", "    /* 6) 开 PLL 等锁定，然后把 SYSCLK 切到 PLL 并等 SWS 确认 */", "    RCC->CR |= RCC_CR_PLLON;", "    spin = 0u;", "    while (((RCC->CR & RCC_CR_PLLRDY) == 0u) && (spin < 100000u)) { spin++; }", "    cfgr = RCC->CFGR;", "    cfgr = (cfgr & ~RCC_CFGR_SW_Msk) | RCC_CFGR_SW_PLL;", "    RCC->CFGR = cfgr;", "    spin = 0u;", "    while (((RCC->CFGR & RCC_CFGR_SWS_Msk) != RCC_CFGR_SWS_PLL) && (spin < 100000u)) { spin++; }", "", "    /* 7) 让 SystemCoreClock 跟着变，delay_ms / SysTick 才是对的数 */", "    SystemCoreClockUpdate();", "}", "");
    return lines.join("\n");
}
