/**
 * CMSIS / 设备头 / 启动文件的下载清单。
 *
 * 为什么从网上拉而不是打进插件（用户 2026-10-24 决定）：插件要能覆盖任意 STM32，
 * 每颗芯片的 startup + 设备头 + CMSIS 内核头都打一份进 npm 包，包会大到不可用。
 * 这些都是 Apache-2.0 的 ST/ARM 公开源码，第一次用时拉到缓存目录，之后复用。
 *
 * 每个文件给多条候选 URL（见 fetch.ts：raw.githubusercontent 在有些网络里不通）。
 *
 * 0.2 起这一层不再自己维护「型号 → 启动文件」的对照表：那条事实统一由 data/stm32f1.ts 的
 * resolveF1Chip() 负责（100/101/102/103/105/107 全部 line × 容量档），这里只做两件事：
 *   1) 把 F1Chip 翻译成下载清单（路径 + markers + 实测 sha256）；
 *   2) 把用户给的各种写法（型号 / F1:B / F1:103xb / 0.1 的老缓存 id）解析成同一个缓存条目。
 */
import { findChipFact, loadDeviceFacts } from "./device-facts.js";
import { familyIdOfPart } from "./family.js";
import { resolveF1Chip } from "./stm32f1.js";
const JS_DELIVR_FASTLY = (repo, ref, file) => "https://fastly.jsdelivr.net/gh/STMicroelectronics/" + repo + "@" + ref + "/" + file;
const JS_DELIVR_CDN = (repo, ref, file) => "https://cdn.jsdelivr.net/gh/STMicroelectronics/" + repo + "@" + ref + "/" + file;
const RAW_GITHUB = (repo, ref, file) => "https://raw.githubusercontent.com/STMicroelectronics/" + repo + "/" + ref + "/" + file;
const GHPROXY = (repo, ref, file) => "https://ghproxy.net/https://raw.githubusercontent.com/STMicroelectronics/" + repo + "/" + ref + "/" + file;
/** 一个文件的多条下载路线，顺序 = 优先级（实测 jsDelivr 最稳，raw 兜底）。 */
export function sourceUrls(repo, ref, file) {
    return [JS_DELIVR_FASTLY(repo, ref, file), JS_DELIVR_CDN(repo, ref, file), RAW_GITHUB(repo, ref, file), GHPROXY(repo, ref, file)];
}
/**
 * 寄存器件模板支持的 13 个族。
 *
 * 为什么是这 13 个：内置资源 device/<族>/chips.json 已经收了这 13 族的芯片事实
 * （启动文件名 / 设备宏 / 设备头 / Flash / RAM 都在里面），寄存器路线需要的事实刚好齐了。
 * 其它族（H5/U3/U5/L5/WB/WBA/WL/H7/L4+）等内置资源补了 chips.json 再按同样字段加一条即可。
 *
 * 内核头沿用 F1 的口径：从 ST 的 STM32Cube<族> 主仓库取（ST 在主仓里 vendor 了 CMSIS，
 * 不是子模块；2026-11-08 实测 F4/G0 的 Drivers/CMSIS/Include 都是 200）。
 *
 * 哈希钉：只有 F1 那张表（DEVICE_HEADER_SHA256 / STARTUP_SHA256 / CORE_HEADER_SHA256）
 * 是逐文件实测的；其它族只锁形状（minBytes + markers），真实哈希在下载时登记进缓存索引。
 * 这与 SVD 的处理同口径：上游同族文件会随版本漂移，锁死哈希会让"上游发新版"变成插件故障。
 */
export const CMSIS_FAMILIES = {
    F1: {
        family: "F1",
        deviceRepo: "cmsis-device-f1",
        deviceRef: "master",
        deviceIncludeDir: "Include",
        deviceTemplatesDir: "Source/Templates",
        cmsisRepo: "STM32CubeF1",
        cmsisRef: "master",
        coreIncludeDir: "Drivers/CMSIS/Include",
        coreHeader: "core_cm3.h",
        deviceHeaders: ["stm32f1xx.h", "system_stm32f1xx.h"],
        deviceDefinePrefix: "STM32F1",
        systemC: "system_stm32f1xx.c",
        mpuHeader: "mpu_armv7.h",
    },
    C0: {
        family: "C0",
        deviceRepo: "cmsis-device-c0",
        deviceRef: "master",
        deviceIncludeDir: "Include",
        deviceTemplatesDir: "Source/Templates",
        cmsisRepo: "STM32CubeC0",
        cmsisRef: "master",
        coreIncludeDir: "Drivers/CMSIS/Include",
        coreHeader: "core_cm0plus.h",
        deviceHeaders: ["stm32c0xx.h", "system_stm32c0xx.h"],
        deviceDefinePrefix: "STM32C0",
        systemC: "system_stm32c0xx.c",
    },
    F0: {
        family: "F0",
        deviceRepo: "cmsis-device-f0",
        deviceRef: "master",
        deviceIncludeDir: "Include",
        deviceTemplatesDir: "Source/Templates",
        cmsisRepo: "STM32CubeF0",
        cmsisRef: "master",
        coreIncludeDir: "Drivers/CMSIS/Include",
        coreHeader: "core_cm0.h",
        deviceHeaders: ["stm32f0xx.h", "system_stm32f0xx.h"],
        deviceDefinePrefix: "STM32F0",
        systemC: "system_stm32f0xx.c",
    },
    F2: {
        family: "F2",
        deviceRepo: "cmsis-device-f2",
        deviceRef: "master",
        deviceIncludeDir: "Include",
        deviceTemplatesDir: "Source/Templates",
        cmsisRepo: "STM32CubeF2",
        cmsisRef: "master",
        coreIncludeDir: "Drivers/CMSIS/Include",
        coreHeader: "core_cm3.h",
        deviceHeaders: ["stm32f2xx.h", "system_stm32f2xx.h"],
        deviceDefinePrefix: "STM32F2",
        systemC: "system_stm32f2xx.c",
        mpuHeader: "mpu_armv7.h",
    },
    F3: {
        family: "F3",
        deviceRepo: "cmsis-device-f3",
        deviceRef: "master",
        deviceIncludeDir: "Include",
        deviceTemplatesDir: "Source/Templates",
        cmsisRepo: "STM32CubeF3",
        cmsisRef: "master",
        coreIncludeDir: "Drivers/CMSIS/Include",
        coreHeader: "core_cm4.h",
        deviceHeaders: ["stm32f3xx.h", "system_stm32f3xx.h"],
        deviceDefinePrefix: "STM32F3",
        systemC: "system_stm32f3xx.c",
        mpuHeader: "mpu_armv7.h",
    },
    F4: {
        family: "F4",
        deviceRepo: "cmsis-device-f4",
        deviceRef: "master",
        deviceIncludeDir: "Include",
        deviceTemplatesDir: "Source/Templates",
        cmsisRepo: "STM32CubeF4",
        cmsisRef: "master",
        coreIncludeDir: "Drivers/CMSIS/Include",
        coreHeader: "core_cm4.h",
        deviceHeaders: ["stm32f4xx.h", "system_stm32f4xx.h"],
        deviceDefinePrefix: "STM32F4",
        systemC: "system_stm32f4xx.c",
        mpuHeader: "mpu_armv7.h",
    },
    F7: {
        family: "F7",
        deviceRepo: "cmsis-device-f7",
        deviceRef: "master",
        deviceIncludeDir: "Include",
        deviceTemplatesDir: "Source/Templates",
        cmsisRepo: "STM32CubeF7",
        cmsisRef: "master",
        coreIncludeDir: "Drivers/CMSIS/Include",
        coreHeader: "core_cm7.h",
        deviceHeaders: ["stm32f7xx.h", "system_stm32f7xx.h"],
        deviceDefinePrefix: "STM32F7",
        systemC: "system_stm32f7xx.c",
        mpuHeader: "mpu_armv7.h",
    },
    G0: {
        family: "G0",
        deviceRepo: "cmsis-device-g0",
        deviceRef: "master",
        deviceIncludeDir: "Include",
        deviceTemplatesDir: "Source/Templates",
        cmsisRepo: "STM32CubeG0",
        cmsisRef: "master",
        coreIncludeDir: "Drivers/CMSIS/Include",
        coreHeader: "core_cm0plus.h",
        deviceHeaders: ["stm32g0xx.h", "system_stm32g0xx.h"],
        deviceDefinePrefix: "STM32G0",
        systemC: "system_stm32g0xx.c",
    },
    G4: {
        family: "G4",
        deviceRepo: "cmsis-device-g4",
        deviceRef: "master",
        deviceIncludeDir: "Include",
        deviceTemplatesDir: "Source/Templates",
        cmsisRepo: "STM32CubeG4",
        cmsisRef: "master",
        coreIncludeDir: "Drivers/CMSIS/Include",
        coreHeader: "core_cm4.h",
        deviceHeaders: ["stm32g4xx.h", "system_stm32g4xx.h"],
        deviceDefinePrefix: "STM32G4",
        systemC: "system_stm32g4xx.c",
        mpuHeader: "mpu_armv7.h",
    },
    L0: {
        family: "L0",
        deviceRepo: "cmsis-device-l0",
        deviceRef: "master",
        deviceIncludeDir: "Include",
        deviceTemplatesDir: "Source/Templates",
        cmsisRepo: "STM32CubeL0",
        cmsisRef: "master",
        coreIncludeDir: "Drivers/CMSIS/Include",
        coreHeader: "core_cm0plus.h",
        deviceHeaders: ["stm32l0xx.h", "system_stm32l0xx.h"],
        deviceDefinePrefix: "STM32L0",
        systemC: "system_stm32l0xx.c",
    },
    L1: {
        family: "L1",
        deviceRepo: "cmsis-device-l1",
        deviceRef: "master",
        deviceIncludeDir: "Include",
        deviceTemplatesDir: "Source/Templates",
        cmsisRepo: "STM32CubeL1",
        cmsisRef: "master",
        coreIncludeDir: "Drivers/CMSIS/Include",
        coreHeader: "core_cm3.h",
        deviceHeaders: ["stm32l1xx.h", "system_stm32l1xx.h"],
        deviceDefinePrefix: "STM32L1",
        systemC: "system_stm32l1xx.c",
        mpuHeader: "mpu_armv7.h",
    },
    L4: {
        family: "L4",
        deviceRepo: "cmsis-device-l4",
        deviceRef: "master",
        deviceIncludeDir: "Include",
        deviceTemplatesDir: "Source/Templates",
        cmsisRepo: "STM32CubeL4",
        cmsisRef: "master",
        coreIncludeDir: "Drivers/CMSIS/Include",
        coreHeader: "core_cm4.h",
        deviceHeaders: ["stm32l4xx.h", "system_stm32l4xx.h"],
        deviceDefinePrefix: "STM32L4",
        systemC: "system_stm32l4xx.c",
        mpuHeader: "mpu_armv7.h",
    },
    U0: {
        family: "U0",
        deviceRepo: "cmsis-device-u0",
        deviceRef: "master",
        deviceIncludeDir: "Include",
        deviceTemplatesDir: "Source/Templates",
        cmsisRepo: "STM32CubeU0",
        cmsisRef: "master",
        coreIncludeDir: "Drivers/CMSIS/Include",
        coreHeader: "core_cm0plus.h",
        deviceHeaders: ["stm32u0xx.h", "system_stm32u0xx.h"],
        deviceDefinePrefix: "STM32U0",
        systemC: "system_stm32u0xx.c",
    },
};
/** line 代号：STM32F103 → F1。 */
export function familyOf(chip) {
    return chip.prefix.slice(5, 7);
}
/**
 * 缓存条目里的「档位键」= line + 容量档，例如 103xb。
 *
 * 为什么不只用容量档（任务书写的是 <family>:<group>）：同名档位在 F1 内部会撞车——
 * F100 / F101 / F102 / F103 各有一套 startup_stm32f10xxb.s 设备头，只用 xb 会把
 * 四份不同的文件当成同一份缓存。带上 line 之后每档唯一，且一眼看得出是哪一颗。
 */
export function cmsisGroupKey(chip) {
    return chip.prefix.slice(6) + chip.group;
}
/** 缓存条目 id：cmsis:<族>:<line><档>，例如 cmsis:F1:103xb。 */
export function cmsisEntryId(family, groupKey) {
    return "cmsis:" + family + ":" + groupKey;
}
/** 某颗芯片的缓存条目 id。 */
export function chipEntryId(chip) {
    return cmsisEntryId(familyOf(chip), cmsisGroupKey(chip));
}
function choiceFromChip(chip) {
    return {
        family: familyOf(chip),
        startup: chip.startup,
        define: chip.deviceDefine,
        deviceHeader: chip.deviceHeader,
        chip,
    };
}
/**
 * 只给容量字母（F1:B / F1:8）时，从设备事实里挑一颗同档芯片当代表：
 * 优先 F103（档位最全，0.1 的 "F1:B" 正是按 F103 解释的），再按 line / CPN 升序。
 *
 * 以前这里靠手写的「容量字母 → 档位」常量表（随 chip-table.json 2026-10-31 一起删了）。
 * 现在这条事实也只从内置资源读：缺文件就返回 null，上层会明说先确认安装完整（stm32_assets verify），
 * 不会编一个可能不存在的启动文件名。
 */
function chipForDensityLetter(letter) {
    const wanted = letter.trim().toUpperCase();
    const facts = loadDeviceFacts();
    if (!facts.ok)
        return null;
    const candidates = facts.chips.filter((chip) => /^STM32F\d{3}[A-Z]([0-9A-G])/u.exec(chip.cpn)?.[1] === wanted);
    if (candidates.length === 0)
        return null;
    const ordered = [...candidates].sort((a, b) => {
        const byLine = Number(a.line) - Number(b.line);
        if (byLine !== 0)
            return byLine;
        return a.cpn < b.cpn ? -1 : a.cpn > b.cpn ? 1 : 0;
    });
    const preferred = ordered.find((chip) => chip.line === "103") ?? ordered[0];
    return preferred === undefined ? null : resolveF1Chip(preferred.cpn).chip;
}
/**
 * 只给容量档（F1:B / F1:8 / F1:xb）时，用 F103 当代表：F103 的档位最全
 * （x6/xb/xe/xg），0.1 的 "F1:B" 也正是按 F103 解释的，行为不变。
 */
function chipForKey(key) {
    const text = key.trim().toLowerCase();
    if (text.length === 0)
        return null;
    if (/^x[0-9a-z]{1,2}$/u.test(text))
        return resolveF1Chip("F103:" + text.toUpperCase()).chip;
    if (/^[0-9a-z]$/u.test(text))
        return chipForDensityLetter(text);
    return null;
}
/**
 * 各种写法 → F1Chip：
 *   STM32F103C8T6 / STM32F103C8（型号）· F103:xb（容量档）· F1:B / F1:8 / F1:xb（族:档）
 * 认不出返回 null（宁可明说"这一代还没做"，也不编文件名让链接器报一堆奇怪错误）。
 */
export function chipForInput(input) {
    const text = input.trim().toUpperCase();
    if (text.length === 0)
        return null;
    if (text.startsWith("STM32"))
        return resolveF1Chip(text).chip;
    if (/^F\d{2,3}:X[0-9A-Z]{1,2}$/u.test(text))
        return resolveF1Chip(text).chip;
    const familyForm = /^[A-Z]\d{1,2}:(.+)$/u.exec(text);
    if (familyForm !== null)
        return chipForKey(familyForm[1] ?? "");
    return null;
}
/**
 * 从型号（或容量档写法）推出启动文件与设备宏。
 *
 * 0.2 起不再写死 F103：内部一律走 resolveF1Chip（F100/F101/F102/F103/F105/F107 × 各自档位）。
 * 老签名与老写法（"F1:B"）保持可用。
 */
export function startupChoiceFor(mcu, env = process.env) {
    const chip = chipForInput(mcu);
    if (chip !== null)
        return choiceFromChip(chip);
    // 非 F1：事实全部来自插件内置资源 chips.json（按族分文件）。
    const facts = findChipFact(mcu, env);
    if (facts === null)
        return null;
    const familyId = familyIdOfPart(facts.cpn);
    const family = familyId.slice("STM32".length);
    if (CMSIS_FAMILIES[family] === undefined)
        return null;
    return { family, startup: facts.startup, define: facts.deviceDefine, deviceHeader: facts.deviceHeader, facts };
}
function refFromChip(chip) {
    return { family: familyOf(chip), groupKey: cmsisGroupKey(chip), id: chipEntryId(chip), chip };
}
/**
 * 缓存条目名的解析器：认
 *   · cmsis:F1:103xb（0.2 的规范写法）
 *   · F1:103xb / F103:xb / F1:B / F1:8（脚本与老文档里的写法）
 *   · cmsis:F1:stm32f103xb · cmsis:F1:startup_stm32f103xb（0.1 的老 id，健康条目直接复用）
 *   · STM32F103C8T6（型号）
 */
export function parseCmsisEntryRef(ref) {
    const text = ref.trim();
    if (text.length === 0)
        return null;
    const direct = chipForInput(text);
    if (direct !== null)
        return refFromChip(direct);
    const familyForm = /^(?:cmsis:)?([A-Za-z]\d{1,2}):(.+)$/u.exec(text);
    const tail = (familyForm === null ? text : (familyForm[2] ?? "")).trim().toLowerCase();
    const stem = tail.replace(/^startup_/u, "").replace(/\.s$/u, "");
    const keyed = /^(?:stm32f)?(\d{3})(x[0-9a-z]{1,2})$/u.exec(stem);
    if (keyed !== null) {
        const chip = resolveF1Chip("F" + (keyed[1] ?? "") + ":" + (keyed[2] ?? "").toUpperCase()).chip;
        return chip === null ? null : refFromChip(chip);
    }
    const chip = chipForKey(stem);
    return chip === null ? null : refFromChip(chip);
}
/**
 * 一个写法可能指的缓存 id（第一位是规范 id）。
 * 用途：用户/老索引里是 0.1 的 id 时，别把已经下好的健康条目当成"没缓存"重下一遍。
 */
export function cmsisEntryAliases(ref) {
    const parsed = parseCmsisEntryRef(ref);
    if (parsed === null)
        return [];
    const out = [parsed.id];
    const stem = parsed.chip === null ? "" : parsed.chip.startup.replace(/\.s$/u, "");
    if (stem !== "") {
        const deviceStem = stem.replace(/^startup_/u, "");
        out.push(cmsisEntryId(parsed.family, deviceStem));
        out.push(cmsisEntryId(parsed.family, stem));
    }
    out.push(parsed.family + ":" + parsed.groupKey);
    return out;
}
/**
 * 上游文件的 sha256（实测 2026-10-30，jsDelivr fastly master，见每条表下面的 URL 模板）。
 *
 * 为什么值得锁：markers 钉的是「内容里必须有这个特征」，CDN 缓存旧版、上游同名不同代
 * 都拦不住；哈希一锁，上游任何一点改动都会显式失败并给出两个哈希——维护者就知道
 * 该去重新实测而不是静默接受漂移。
 *
 * 覆盖范围（0.2）：F1 全部 14 套启动文件（100:xb/xe · 101:x6/xb/xe/xg · 102:x6/xb ·
 * 103:x6/xb/xe/xg · 105:xc · 107:xc）+ 16 个设备头（14 个型号头 + stm32f1xx.h +
 * system_stm32f1xx.h）。实测方式：按真实 URL 各下一份，算 sha256（脚本用本仓
 * lib/engine/fetch.js 的同一条下载路径，避免"表里是手抄值"）。
 * 重新实测：把新值整体替换，并在下面注释里更新日期。
 *
 * URL 模板：
 *   启动文件 https://fastly.jsdelivr.net/gh/STMicroelectronics/cmsis-device-f1@master/Source/Templates/gcc/<startup>
 *   设备头   https://fastly.jsdelivr.net/gh/STMicroelectronics/cmsis-device-f1@master/Include/<header>
 */
export const DEVICE_HEADER_SHA256 = {
    "stm32f1xx.h": "05e93fa3ddefb2e83d762b9ca4de36e3bba9cd8e9690400fe9f2c11fc0a3cef5",
    "system_stm32f1xx.h": "a54dfbb3480c672f532d472a6e84bcf34df6551771d2e9966c5a3503c676b6ab",
    "stm32f100xb.h": "88ceaa84c70d6b72378846f46139b63b6c66863a97cf0502049ca692ee6ca656",
    "stm32f100xe.h": "9fece142c6e63348b2e3623a05ab3b5ec5e41b8e4c31e572b79525fbef400e8b",
    "stm32f101x6.h": "56a2e4f93f1febf7c716703c3cb0327982bcddf05ca598c26c618f53355af580",
    "stm32f101xb.h": "c310cfc3d5afe70a9cc2fead7dd6a852d302ee2c85e096f1e473df7573e0d269",
    "stm32f101xe.h": "9dafcb66917c270337675bf27d7607dff88e2dfe81ca036c4b4e048616e1388b",
    "stm32f101xg.h": "1fdf19e22bbbc64c28eaaab51cc1ed97a47400d5ec720b05b1be7901e75ab6e1",
    "stm32f102x6.h": "c0bf0a4447e14395e908b9545380c3c1929919f7d1e294377ed1b0ac3955bc9b",
    "stm32f102xb.h": "fe0233569238071756f17c289c6daa132b9006664749b0968c988e5030b48a4b",
    "stm32f103x6.h": "8e827edef0fbbc1f9fef6d1ec07fcf2c3789f18a906884cf88ac5fec893521be",
    "stm32f103xb.h": "d9c7c613d9fea74220892b4fbc3e80617493acad82a04bafadab2b4a7198399c",
    "stm32f103xe.h": "2104082df11b7e172ecf85461a72689b849e05b222a573e3cae0b2ab279800c3",
    "stm32f103xg.h": "7ca8ab045885a99481ffb141e01b0cc4f6df4d5e1914561fc0ee67b6f4a4e99a",
    "stm32f105xc.h": "ee0cff14b833552194d0d4062e93f479cb640b18b5a7a19c749e753bd305d0f1",
    "stm32f107xc.h": "ffb02a8480dd670d0436bedc48fca222085f343d3019088d83d9348fb4632b4d",
};
/** 实测 2026-10-30：https://fastly.jsdelivr.net/gh/STMicroelectronics/cmsis-device-f1@master/Source/Templates/system_stm32f1xx.c */
export const SYSTEM_C_SHA256 = "8465bf3fe9057adecd8b4561403836d1fa2152d3cb088831623da3f91d86ec0a";
/** 实测 2026-10-30：https://fastly.jsdelivr.net/gh/STMicroelectronics/cmsis-device-f1@master/Source/Templates/gcc/<startup> */
export const STARTUP_SHA256 = {
    "startup_stm32f100xb.s": "627ed97c93a33e4678262f9403469f509c050dabc7e8467998016362517597df",
    "startup_stm32f100xe.s": "7aba359302b27457575a63c87b4e1718902d555f621f29bc5f56bd7b982b4e52",
    "startup_stm32f101x6.s": "bbd6f1acf892c549594521534be9560477cf4c1f904c5ac3cd6f38e5f87a1ea7",
    "startup_stm32f101xb.s": "fd97158a935c10b1d6701721b78b57da6d472d2f8a8fe672f8fc0c29b5428ef8",
    "startup_stm32f101xe.s": "2cb8b1d4c77cf56e39256eafbc167f7a360be3bfd07f43a5afcc0bbd6c0d7097",
    "startup_stm32f101xg.s": "71c2341a2b56c99e0963dff275df48a70f4cd9b4217b71b0200543481ec49ea0",
    "startup_stm32f102x6.s": "de15b09885aa64a55c3be274046ca16003eccdd434b02176f0644d1d714f3ee3",
    "startup_stm32f102xb.s": "d6a7da9e8c76932edcad28a2e0ff5da429a5ffff193d9dda087bc73ee7de040e",
    "startup_stm32f103x6.s": "56254accb4a72fe36b48e518bc7ea28e577353938a9c429cd847da52f660ce9e",
    "startup_stm32f103xb.s": "a9a5fc7ed5ff617527dd98b3092830f4d17ed4bf57c99eac2c53bdb514ce138c",
    "startup_stm32f103xe.s": "04d6550310b491d5d8ad4de87b9cecb631b5ba5a284340e31bc94e0d05e4230b",
    "startup_stm32f103xg.s": "413a437ab1246c1506e5ba421d38efc0fef277e6f851af6c09904a3bafee84f9",
    "startup_stm32f105xc.s": "d189def35e547ee70e70a82648b03621587ac4384bf0d78245aafcf0b6bf7d42",
    "startup_stm32f107xc.s": "71db8ed11634c230e3c04381cd899d1622b2ba58e3ac03b1e6c202eceec6713a",
};
/** 实测 2026-10-30：https://fastly.jsdelivr.net/gh/STMicroelectronics/STM32CubeF1@master/Drivers/CMSIS/Include/<header> */
export const CORE_HEADER_SHA256 = {
    "core_cm3.h": "655bb08e9474438dec8b1874ea6c63749dc2787b85f06a0987c4870bcb580f21",
    "cmsis_compiler.h": "03ab80c426a8360eaaad833ac816462a9f38cb2e4dbdc490914880ad071181fe",
    "cmsis_gcc.h": "341982e6d6c91119214c47d7a04b31f1f8ce0970c45e2c9fe0870c80d0876e28",
    "cmsis_version.h": "c2570d56ee85d4f2ec0fb62f31d080d3cddf3a015500a4ed5a006a571637b43c",
    "mpu_armv7.h": "e4968e627df085e4ebf46be5140be657e035d978ae1938c1c2e3ee49fbde5030",
};
/** 兼容：直接给 F1Chip 也行（0.2 内部路径），只给 StartupChoice 时按 startup 文件名反推档位。 */
function chipOf(input) {
    if ("cpn" in input)
        return input;
    if (input.chip !== undefined)
        return input.chip;
    const parsed = parseCmsisEntryRef(input.startup);
    return parsed === null ? null : parsed.chip;
}
/**
 * 组装一代/一档模板的下载计划：路径全部按 ST 固件包布局摆，
 * 寄存器版工程直接 -I Drivers/CMSIS/Include -I Drivers/CMSIS/Device/ST/STM32F1xx/Include 就能编译，
 * 与 HAL 工程共用同一套 include 约定。
 */
export function cmsisTemplatePlan(input) {
    const chip = chipOf(input);
    const choice = "cpn" in input ? choiceFromChip(input) : { ...input, ...(chip === null ? {} : { chip }) };
    const spec = CMSIS_FAMILIES[choice.family];
    if (spec === undefined)
        return null;
    const facts = choice.facts;
    if (chip === null && facts === undefined)
        return null;
    const familyDir = spec.deviceDefinePrefix + "xx";
    const deviceBase = "Drivers/CMSIS/Device/ST/" + familyDir;
    const targets = [];
    // markers 是内容特征（A32）：minBytes 只能挡住"太短"，挡不住代理塞进来的登录页、
    // 或者同名但不同版本的另一个头文件。每个 target 至少命中一个特征才算真拿到。
    // 1) 设备头：umbrella + system 头 + 具体型号头（都以 #ifndef __STM32 开头）
    for (const header of spec.deviceHeaders) {
        targets.push({
            path: deviceBase + "/Include/" + header,
            urls: sourceUrls(spec.deviceRepo, spec.deviceRef, spec.deviceIncludeDir + "/" + header),
            minBytes: 200,
            // 新族（C0/G0 等）的守卫不带前导下划线：STM32C0xx_H、SYSTEM_STM32C0XX_H；
            // 老族（F0–F7/L1）是 __STM32F4xx_H、__SYSTEM_STM32F4XX_H。markers 是"至少命中一个"，两种都列上。
            markers: ["#ifndef __STM32", "#ifndef STM32", "#ifndef __SYSTEM_STM32", "#ifndef SYSTEM_STM32"],
            sha256: DEVICE_HEADER_SHA256[header],
        });
    }
    targets.push({
        path: deviceBase + "/Include/" + choice.deviceHeader,
        urls: sourceUrls(spec.deviceRepo, spec.deviceRef, spec.deviceIncludeDir + "/" + choice.deviceHeader),
        minBytes: 10_000,
        // 具体型号头（stm32c011xx.h / stm32f401xc.h）同样有带/不带前导下划线两代写法。
        markers: ["#ifndef __STM32", "#ifndef STM32", "#ifndef __SYSTEM_STM32", "#ifndef SYSTEM_STM32"],
        sha256: DEVICE_HEADER_SHA256[choice.deviceHeader],
    });
    // 2) system_<族>xx.c 与启动文件
    targets.push({
        path: deviceBase + "/Source/Templates/" + spec.systemC,
        urls: sourceUrls(spec.deviceRepo, spec.deviceRef, spec.deviceTemplatesDir + "/" + spec.systemC),
        minBytes: 1_000,
        markers: ["SystemInit"],
        // SYSTEM_C_SHA256 只是 F1 那一份的实测值；别的族按形状校验（见 CMSIS_FAMILIES 注释）。
        sha256: spec.family === "F1" ? SYSTEM_C_SHA256 : undefined,
    });
    targets.push({
        path: deviceBase + "/Source/Templates/gcc/" + choice.startup,
        urls: sourceUrls(spec.deviceRepo, spec.deviceRef, spec.deviceTemplatesDir + "/gcc/" + choice.startup),
        minBytes: 1_000,
        markers: ["_estack", ".syntax unified"],
        sha256: STARTUP_SHA256[choice.startup],
    });
    // 3) CMSIS 内核头（ST 主仓库里就有，不是子模块）。
    // markers 按文件给：core_cm3/cmsis_compiler/cmsis_gcc/cmsis_version 带 __CORE_/__CMSIS_ 守卫，
    // 但 mpu_armv7.h 是 ARM 原版，真实守卫是 ARM_MPU_ARMV7_H（V5.0.4 实测）——
    // 上一版给五个头共用 [__CMSIS,__CORE_,__MPU_]，mpu_armv7.h 一个都不命中，
    // 网络全通、逐字节正确也会被判成"不是要的那个文件"，整个寄存器模板下载必失败。
    // core_cmX.h 的守卫名就是文件名大写前面加 __、后面加 _H（core_cm0plus.h → __CORE_CM0PLUS_H）；
    // 别再写死 __CORE_CM3_H：换了内核头（F4 → core_cm4.h）会一个都不命中。
    const coreGuard = "__" + spec.coreHeader.replace(/\.h$/u, "").toUpperCase() + "_H";
    const coreHeaderMarkers = {
        [spec.coreHeader]: [coreGuard, "__CMSIS"],
        "cmsis_compiler.h": ["__CMSIS_COMPILER_H", "__CMSIS"],
        "cmsis_gcc.h": ["__CMSIS_GCC_H", "__CMSIS"],
        "cmsis_version.h": ["__CMSIS_VERSION", "__CMSIS"],
    };
    // mpu 头不是可选项：core_cm0plus.h / core_cm3.h / core_cm4.h / core_cm7.h 里都 #include "mpu_armv7.h"
    // （core_cm33.h → mpu_armv8.h）。少下一个文件，main.c 第一条就 fatal error: mpu_armv7.h: No such file。
    // 所以按内核头自动带上，spec.mpuHeader 只用来覆盖例外。
    const mpuHeader = spec.mpuHeader
        ?? (spec.coreHeader === "core_cm0.h" ? undefined : /cm33/u.test(spec.coreHeader) ? "mpu_armv8.h" : "mpu_armv7.h");
    if (mpuHeader !== undefined)
        coreHeaderMarkers[mpuHeader] = ["ARM_MPU_", "__MPU_"];
    const coreHeaders = [spec.coreHeader, "cmsis_compiler.h", "cmsis_gcc.h", "cmsis_version.h", ...(mpuHeader === undefined ? [] : [mpuHeader])];
    for (const header of coreHeaders) {
        targets.push({
            path: "Drivers/CMSIS/Include/" + header,
            urls: sourceUrls(spec.cmsisRepo, spec.cmsisRef, spec.coreIncludeDir + "/" + header),
            minBytes: 500,
            markers: coreHeaderMarkers[header] ?? ["__CMSIS", "__CORE_"],
            // CORE_HEADER_SHA256 是 F1 那份（STM32CubeF1@master）的实测值。各族的 CMSIS 内核版本不同
            // （U0 的 cmsis_compiler.h 与 F1 内容差一版），拿 F1 的哈希去校验别的族只会全灭。
            sha256: spec.family === "F1" ? CORE_HEADER_SHA256[header] : undefined,
        });
    }
    const license = "STMicroelectronics CMSIS device headers / startup / CMSIS core headers — Apache License 2.0."
        + "\n来源仓库：github.com/STMicroelectronics/" + spec.deviceRepo + "（" + spec.deviceRef + "）、"
        + "github.com/STMicroelectronics/" + spec.cmsisRepo + "（" + spec.cmsisRef + "）。"
        + "\n本目录是下载缓存，不是插件源码；删掉它不影响插件，下次用时会重新下载。\n";
    // 0.2：条目按 line+档位分（cmsis:F1:103xb），目录同名。没有 chip 的旧调用退化成 startup 文件名。
    const groupKey = chip !== null
        ? cmsisGroupKey(chip)
        : facts !== undefined
            ? facts.line + facts.group
            : choice.startup.replace(/^startup_/u, "").replace(/\.s$/u, "");
    return {
        family: choice.family,
        id: chip !== null ? chipEntryId(chip) : cmsisEntryId(choice.family, groupKey),
        dirName: choice.family + "/" + groupKey,
        choice,
        targets,
        license,
    };
}
