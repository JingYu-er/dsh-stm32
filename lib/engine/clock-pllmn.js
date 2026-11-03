/**
 * pllmn 模型的时钟规划（PLLM / PLLN / PLLP：F2 / F4 / F7 / G4 / L4 这类族）。
 *
 * 与 pllmul 模型的区别只在「源 → SYSCLK」这一段：
 *   pllmul：sysclk = src × PLLMUL
 *   pllmn ：vco = src / PLLM × PLLN；sysclk = vco / PLLP
 * 后面 AHB/APB/ADC 分频与要写的 RCC.* 键基本一致（键名从 PLLMUL 变成 PLLM/PLLN/PLLP）。
 *
 * 事实来源：PLLM/PLLN/PLLP 的枚举、PLLN 的 Min/Max、总线频率上限、VCO 允许区间、以及
 * AHB/APB 分频的枚举名都从 db 的 RCC-*_Modes.xml 读（见 src/data/clock-db.ts）；
 * 核过手册/真机的族在那边用 override 表压过 db（F103 这类 db 偏保守的族）。
 */
import { apbDivValue, pllSourceById } from "../data/clock-f1.js";
import { emptyClockPlan, formatHz, peripheralClockHz } from "./clock-plan.js";
/** PLL 输入频率（HSI 用 .ioc 的 RCC.HSI_VALUE；HSE 用 RCC.HSE_VALUE）。 */
export function pllInHzOfSource(source, hseHz, hsiHz, facts) {
    const fact = pllSourceById(source, facts.sources);
    if (fact === null)
        return 0;
    if (fact.id === "hse")
        return hseHz;
    const divider = fact.divider ?? (fact.id === "hsi-div2" ? 2 : 1);
    return Math.round(hsiHz / divider);
}
function divFact(divs, div) {
    if (divs === undefined)
        return null;
    return divs.find((item) => item.div === div) ?? null;
}
function minimalDiv(divs, value, limit) {
    let best = null;
    for (const item of divs) {
        if (value / item.div > limit)
            continue;
        if (best === null || item.div < best.div)
            best = item;
    }
    return best ?? divs[divs.length - 1];
}
/** 从 .ioc 读 RCC.HSE_VALUE / RCC.HSI_VALUE，缺省按 8 / 16 MHz（F4 的 HSI 是 16 MHz）。 */
function readSourcesHz(entries) {
    const hse = Number.parseInt((entries.get("RCC.HSE_VALUE") ?? "").trim(), 10);
    const hsi = Number.parseInt((entries.get("RCC.HSI_VALUE") ?? "").trim(), 10);
    return {
        hseHz: Number.isFinite(hse) && hse > 0 ? hse : 8_000_000,
        hsiHz: Number.isFinite(hsi) && hsi > 0 ? hsi : 16_000_000,
    };
}
/**
 * pllmn 的规划入口。返回与 pllmul 完全同形状的 ClockPlan，这样 ioc-plan 不用分叉。
 */
export function planClockPllmn(input) {
    const { request, entries, facts, familyId } = input;
    // VCO 区间跟着 facts 走（db 读出来的或核过的 override），不再按族名查表：
    // 这样新族只要 db 里有 VCOOutputFreq_Value/VCOInputFreq_Value 就能规划。
    const vcoLimits = facts.vco;
    const pllM = facts.pllM ?? [];
    // L4 这类族的 SYSCLK 输出是 PLLR（PLLP 属于 PLLSAI1，只有 DIV7/DIV17）
    const useR = facts.sysclkOutput === "R";
    const pllP = (useR ? (facts.pllR ?? []) : (facts.pllP ?? []));
    const outputKey = useR ? "RCC.PLLR" : "RCC.PLLP";
    const pllN = facts.pllN ?? null;
    if (vcoLimits === undefined) {
        return emptyClockPlan(familyId + " 的 PLLM/PLLN/PLLP 模型已从 db 读到，但 VCO 允许区间（db 的 VCOOutputFreq_Value/VCOInputFreq_Value 或 override 表）没有：clock 参数不会生效");
    }
    if (pllM.length === 0 || pllP.length === 0 || pllN === null) {
        return emptyClockPlan(familyId + " 的 db 事实不全（缺 PLLM/PLLN/PLLP 枚举）：clock 参数不会生效");
    }
    const { hseHz, hsiHz } = readSourcesHz(entries);
    const hasHse = entries.has("RCC.HSE_VALUE") || entries.get("RCC.PLLSourceVirtual") === "RCC_PLLSOURCE_HSE";
    const targetHz = request?.targetHz ?? 0;
    const wantedSource = request?.pllSource ?? (hasHse ? "hse" : "hsi");
    // 1) 枚举所有 (源, M, N, P)，留下 VCO 与 SYSCLK 都合法的组合
    const candidates = [];
    const nMin = Math.max(pllN.min, 2);
    const nMax = Math.min(pllN.max, 432);
    for (const source of facts.sources) {
        if (!source.selectable)
            continue;
        const srcHz = pllInHzOfSource(source.id, hseHz, hsiHz, facts);
        if (srcHz <= 0)
            continue;
        for (const m of pllM) {
            const inHz = srcHz / m.div;
            if (vcoLimits.inMinHz !== undefined && inHz < vcoLimits.inMinHz)
                continue;
            if (vcoLimits.inMaxHz !== undefined && inHz > vcoLimits.inMaxHz)
                continue;
            // N 全扫（50..432，几百个值，成本可忽略）：早先按目标反推邻域会在 P≠1 时把正确档位截掉
            // （8 MHz/4 × 168 × 1/2 = 168 MHz 这种档位就落在窗口外，实测选了 86 MHz）。
            for (let n = nMin; n <= nMax; n += 1) {
                const vcoHz = Math.round(inHz * n);
                if (vcoHz < vcoLimits.minHz || vcoHz > vcoLimits.maxHz)
                    continue;
                for (const p of pllP) {
                    const sysclkHz = Math.round(vcoHz / p.div);
                    if (sysclkHz <= 0 || sysclkHz > facts.limits.sysclkHz)
                        continue;
                    const score = targetHz > 0 ? Math.abs(sysclkHz - targetHz) : 0;
                    candidates.push({
                        source: source.id,
                        sourceLabel: source.label,
                        m: m.div,
                        n,
                        p: p.div,
                        vcoHz,
                        sysclkHz,
                        score,
                    });
                }
            }
        }
    }
    if (candidates.length === 0) {
        return emptyClockPlan("在 " + familyId + " 的 PLLM/PLLN/PLLP 组合里找不到满足 VCO 与 SYSCLK 上限的档位：clock 参数不会生效");
    }
    // 2) 选最接近目标的；同分时优先「用户指定的源」、再优先 P=2（VCO 越高越少抖动）
    const sameSource = candidates.filter((item) => item.source === wantedSource);
    const pool = sameSource.length > 0 ? sameSource : candidates;
    pool.sort((left, right) => left.score - right.score || left.p - right.p || left.m - right.m);
    const best = pool[0];
    // 3) 总线频率与分频（APB1/APB2 都取满足各自上限的最小分频）。
    // APB2 曾经写死 ÷1：F4/F7/G4/L4 的 SYSCLK 上限恰好等于 APB2 上限，看不出来；
    // F2 是 120 MHz SYSCLK / 60 MHz APB2，写死 ÷1 会把 APB2 顶到 120 MHz（超规格），
    // CubeMX 载入这份 .ioc 会卡住不返回（实测 >240 s 无输出）。
    const apb1Div = request?.apb1Div ?? minimalDiv(facts.apbDivs, best.sysclkHz, facts.limits.apb1Hz).div;
    const apb2Div = request?.apb2Div ?? minimalDiv(facts.apbDivs, best.sysclkHz, facts.limits.apb2Hz).div;
    const apb1Hz = Math.round(best.sysclkHz / apb1Div);
    const apb2Hz = Math.round(best.sysclkHz / apb2Div);
    const adcDiv = request?.adcDiv ?? minimalDiv(facts.adcDivs.length > 0 ? facts.adcDivs : [{ div: 1, iocValue: "" }], apb2Hz, facts.limits.adcHz).div;
    const adcHz = Math.round(apb2Hz / adcDiv);
    const chain = {
        pllSource: best.source,
        pllSourceLabel: best.sourceLabel,
        pllInHz: Math.round(pllInHzOfSource(best.source, hseHz, hsiHz, facts) / best.m),
        pllMul: best.n,
        pllM: best.m,
        pllN: best.n,
        pllP: best.p,
        pllClkHz: best.vcoHz / best.p,
        sysclkHz: best.sysclkHz,
        hclkHz: best.sysclkHz,
        apb1Div,
        apb1TimHz: apb1Div === 1 ? apb1Hz : apb1Hz * 2,
        apb1Hz,
        apb2Div,
        apb2Hz,
        apb2TimHz: apb2Div === 1 ? apb2Hz : apb2Hz * 2,
        adcDiv,
        adcHz,
        usbHz: 0,
        usbAvailable: false,
        usbPrescaled: false,
        mcoHz: 0,
    };
    const peripherals = facts.peripheralClocks.map((fact) => ({
        id: fact.id,
        label: fact.label,
        bus: fact.bus,
        clockHz: peripheralClockHz(chain, fact),
        note: "",
    }));
    // 4) 要写的键（pllmn 用 PLLM/PLLN/PLLP，没有 PLLMUL）
    const mFact = divFact(pllM, best.m);
    const pFact = divFact(pllP, best.p);
    if (mFact === null || pFact === null) {
        return emptyClockPlan("PLLM/PLLP 的 .ioc 取值在 db 枚举里找不到：clock 参数不会生效");
    }
    const draft = new Map();
    draft.set("RCC.PLLSourceVirtual", pllSourceById(best.source, facts.sources).iocValue);
    draft.set("RCC.PLLM", mFact.iocValue);
    draft.set("RCC.PLLN", String(best.n));
    draft.set(outputKey, pFact.iocValue);
    // SYSCLK 源的键名按 db 决定：F303 只有 SYSCLKSourceVirtual 生效（写 RCC.SYSCLKSource 会被丢）。
    draft.set(facts.sysclkSourceKey ?? "RCC.SYSCLKSource", "RCC_SYSCLKSOURCE_PLLCLK");
    // 分频键的取值必须来自 db 的枚举名：AHB 与 APB 不是同一套名字（F2/F4/F7 的 AHB 是
    // RCC_SYSCLK_DIVn，APB 是 RCC_HCLK_DIVn；C0 反过来）。写错名字 CubeMX **不报错**，
    // 载入时直接死循环（F2 实测 >240 s 停在 setPackage），所以这里按 div 去枚举里查，
    // 查不到就不写这个键（缺省值本来就是 ÷1，正好是我们要的）。
    const divValueOf = (divs, div, fallback) => divFact(divs, div)?.iocValue ?? fallback(div);
    const ahbValue = divValueOf(facts.ahbDivs, 1, () => "");
    if (ahbValue !== "")
        draft.set("RCC.AHBCLKDivider", ahbValue);
    draft.set("RCC.APB1CLKDivider", divValueOf(facts.apbDivs, apb1Div, apbDivValue));
    draft.set("RCC.APB2CLKDivider", divValueOf(facts.apbDivs, apb2Div, apbDivValue));
    draft.set("RCC.SYSCLKFreq_VALUE", String(best.sysclkHz));
    draft.set("RCC.HCLKFreq_Value", String(best.sysclkHz));
    // AHB 只 ÷1（上面写的 AHBCLKDivider 就是 ÷1），所以 AHB 与 Cortex 都等于 HCLK。
    // 不写它们 CubeMX 保存时会按自己的树重算一遍，verify 里就成了「值被改写」的噪声（F2 实测）。
    draft.set("RCC.AHBFreq_Value", String(best.sysclkHz));
    draft.set("RCC.CortexFreq_Value", String(best.sysclkHz));
    draft.set("RCC.FCLKCortexFreq_Value", String(best.sysclkHz));
    draft.set("RCC.PLLCLKFreq_Value", String(Math.round(best.vcoHz / best.p)));
    draft.set("RCC.VCOOutputFreq_Value", String(best.vcoHz));
    draft.set("RCC.APB1Freq_Value", String(apb1Hz));
    draft.set("RCC.APB1TimFreq_Value", String(chain.apb1TimHz));
    draft.set("RCC.APB2Freq_Value", String(apb2Hz));
    draft.set("RCC.APB2TimFreq_Value", String(chain.apb2TimHz));
    if (adcDiv >= 2 && facts.adcDivs.length > 0) {
        const adcFact = divFact(facts.adcDivs, adcDiv);
        if (adcFact !== null && adcFact.iocValue !== "") {
            draft.set("RCC.ADCPresc", adcFact.iocValue);
            draft.set("RCC.ADCFreqValue", String(adcHz));
        }
    }
    // RCC.IPParameters 要把上面这些名字并进去（CubeMX 按它决定读哪些键）
    const existing = (entries.get("RCC.IPParameters") ?? "").split(",").map((item) => item.trim()).filter((item) => item !== "");
    const merged = [...existing];
    for (const key of draft.keys()) {
        const name = key.slice("RCC.".length);
        if (!merged.includes(name))
            merged.push(name);
    }
    // CubeMX 自己写这一列时是**按 ASCII 升序**排的（实测 F2：48MHZClocksFreq_Value,AHBCLKDivider,
    // AHBFreq_Value,… ,VcooutputI2S——大写整体排在小写前面）。这里跟着排序，否则每次 verify 都会
    // 报「IPParameters 的值被改写」，把真正的差异淹掉。
    draft.set("RCC.IPParameters", merged.sort().join(","));
    const reachable = targetHz === 0 || best.sysclkHz === targetHz;
    const deltaHz = targetHz === 0 ? 0 : best.sysclkHz - targetHz;
    const notes = [];
    notes.push((targetHz === 0 ? "时钟现状" : reachable ? "目标 " + formatHz(targetHz) + " 可达" : "目标 " + formatHz(targetHz) + " 不可达，已选 " + formatHz(best.sysclkHz)) +
        "：" + best.sourceLabel + " ÷" + String(best.m) + " ×" + String(best.n) + " ÷" + String(best.p) +
        " → SYSCLK " + formatHz(best.sysclkHz) + "（VCO " + formatHz(best.vcoHz) + "）");
    if (!reachable)
        notes.push("PLLM/PLLN/PLLP 只能凑出上面这一档最接近的频率");
    return {
        mode: targetHz === 0 ? "snapshot" : "nearest",
        ok: true,
        reachable,
        deltaHz,
        note: notes.join("；"),
        requested: {
            targetHz,
            pllSource: wantedSource,
            pllMul: best.n,
            apb1Div,
            apb2Div,
            adcDiv,
        },
        achieved: chain,
        alternatives: candidates
            .filter((item) => item.sysclkHz !== best.sysclkHz && item.source === best.source)
            .sort((left, right) => left.score - right.score)
            .slice(0, 3)
            .map((item) => ({
            sysclkHz: item.sysclkHz,
            pllSource: item.source,
            pllSourceLabel: item.sourceLabel,
            pllMul: item.n,
            apb1Div: minimalDiv(facts.apbDivs, item.sysclkHz, facts.limits.apb1Hz).div,
            apb2Div: minimalDiv(facts.apbDivs, item.sysclkHz, facts.limits.apb2Hz).div,
            adcDiv,
            usbAvailable: false,
            deltaHz: targetHz === 0 ? 0 : item.sysclkHz - targetHz,
        })),
        peripherals,
        bauds: [],
        entries: [...draft.entries()].map(([key, value]) => ({ key, value })),
        unset: ["RCC.PLLMUL", "RCC.PLLMCOFreq_Value", "RCC.USBPrescaler", useR ? "RCC.PLLP" : "RCC.PLLR"],
        warnings: [],
        errors: [],
    };
}
