/**
 * 多族资产生成：把 device/<fam>/chips.json 与 ioc/family/<FAM>.ioc 这类「按族」的产物算出来。
 *
 * 为什么单独一个模块：build-assets.mjs 的 F1 管线是逐字节校准过的（111 颗 CPN、14 份 .ld/ioc、
 * 官方 .ld 的 RAM 权威值），动它风险大。这里只做 F1 之外的族，用同一套命名规则 + CubeMX db + 固件包：
 *   cpn        STM32LETTER + line(3 位) + 封装字母 + 容量字母 + 后缀字母 + 6
 *   line       恒为 3 位数字（db 文件名 STM32G431C(6-B)Tx → G431）
 *   group      从固件包的启动文件名反推（startup_stm32g431xx.s → xx），不按族级假设
 *   startup    startup_stm32<letter><line><group>.s
 *   header     stm32<letter><line><group>.h
 *   define     STM32<LETTER><line>x<GROUP 大写>（group=xx 时保留小写 xx，与 CubeMX 的 CMakeLists 一致）
 *   ld         <deviceId>_FLASH.ld（插件建工程时按 Flash/RAM 现渲染）
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** db/mcu 的文件名：STM32F103C(8-B)Tx / STM32G431C(6-B)Tx / STM32F030C8Tx → line / 封装 / 容量字母。 */
// line 允许 4 位：WBA 的 line 是 BA50（startup_stm32wba50xx.s），3 位会把它拆成 BA5 + 封装 0。
const MCU_FILE_PATTERN = /^STM32([A-Z])([0-9A-Z]{3,4})([A-Z])(?:\(([0-9A-Z]+(?:-[0-9A-Z]+)*)\)|([0-9A-Z]))([A-Z])x\.xml$/u;

/** 固件包的启动文件：startup_stm32f103xb.s / startup_stm32g431xx.s → letter + line + group。 */
// WB 的启动文件带内核后缀（startup_stm32wb10xx_cm4.s）：双核族只建 M4 应用核，后缀要保留在名字里。
const STARTUP_PATTERN = /^startup_stm32([a-z])([0-9a-z]{3,4})((?:x[0-9a-z])|(?:[0-9a-z]x))(_cm[0-9])?\.s$/u;

/** 容量字母的大小序（数字在前、字母在后）：判断「x6 覆盖 4/6、xb 覆盖 7..B」这种分段。 */
function letterRank(letter) {
    const upper = letter.toUpperCase();
    if (/^[0-9]$/u.test(upper)) return upper.charCodeAt(0) - 48;
    if (/^[A-Z]$/u.test(upper)) return upper.charCodeAt(0) - 65 + 10;
    return -1;
}

/** 少数封装名里没有数字（C0 的 SO8N 只有 8 脚）：这里补一张小表，其它封装一律从名字里的数字取。 */
const PIN_COUNT_FALLBACK = { SO8N: 8, SO8: 8, TSSOP14: 14 };

/** 封装引脚数：db 的 Package 属性（LQFP48 / TFBGA64 / TSSOP20 / WLCSP49）里的数字就是总引脚数。 */
function pinCountOf(packageName) {
    const match = /(\d{2,3})/u.exec(packageName ?? "");
    if (match !== null) return Number(match[1]);
    return PIN_COUNT_FALLBACK[packageName ?? ""];
}

function compareVersion(a, b) {
    const left = a.split(".").map(Number);
    const right = b.split(".").map(Number);
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const l = left[index] ?? 0;
        const r = right[index] ?? 0;
        if (l !== r) return l - r;
    }
    return 0;
}

/** 在 CubeMX 的 Repository 里找某族已装的最新固件包目录（没有返回 null，不猜）。 */
export function findFirmwareRoot(repositoryDir, family) {
    // 两处都找：CubeMX 官方 Repository，以及插件 stm32_firmware_install 自己组装的 dsh-firmware
    // （与 Repository 并列）。只认 Repository 会把"插件刚装好的包"当成没装。
    const dirs = [repositoryDir, join(dirname(repositoryDir), "dsh-firmware")].filter((dir) => existsSync(dir));
    const wanted = new RegExp("^STM32Cube_FW_" + family + "_V(\\d+\\.\\d+\\.\\d+)$", "u");
    let best = null;
    for (const dir of dirs) {
        for (const name of readdirSync(dir)) {
            const match = wanted.exec(name);
            if (match === null) continue;
            if (best === null || compareVersion(match[1], best.version) > 0) {
                best = { name, version: match[1], dir };
            }
        }
    }
    return best === null ? null : { dir: join(best.dir, best.name), version: best.version, name: best.name };
}

/** db/mcu 里属于某族的全部分组（一个 XML = 一条 line × 一个封装 × 一段容量字母）。 */
export function loadMcuGroups(mcuDir, family) {
    const groups = [];
    for (const name of readdirSync(mcuDir).sort()) {
        const match = MCU_FILE_PATTERN.exec(name);
        if (match === null) continue;
        const line = match[2];
        const text = readFileSync(join(mcuDir, name), "utf8");
        // 族归属以 XML 的 Family 属性为准：文件名反推的「首字母 + line 首字符」只是近似，
        // L4+（STM32L4P5A(G-E)Ix → L + 4P5 → L4）与 WB/WB0（STM32WB05KZVx → W + B05 → WB）都会被它判错。
        // 属性缺失或对不上时才退回旧启发式，保证没有 Family 属性的老 db 仍按原样工作。
        const xmlFamily = /\bFamily="([^"]+)"/u.exec(text)?.[1] ?? "";
        const familyMatched = xmlFamily !== "" ? xmlFamily === "STM32" + family : match[1] + line.charAt(0) === family;
        if (!familyMatched) continue;
        groups.push({
            refName: /RefName="([^"]+)"/u.exec(text)?.[1] ?? name.slice(0, -4),
            packageName: /(?:^|\s)Package="([^"]+)"/u.exec(text)?.[1] ?? "",
            family,
            line,
            packageLetter: match[3],
            letters: match[4] === undefined ? [match[5]] : match[4].split("-"),
            suffixLetter: match[6],
            flashKb: [...text.matchAll(/<Flash>(\d+)<\/Flash>/gu)].map((item) => Number(item[1])),
            ramKb: Number.parseInt(/<Ram>(\d+)<\/Ram>/u.exec(text)?.[1] ?? "", 10),
        });
    }
    return groups;
}

/** 固件包里某族的启动文件清单 → line → 容量档集合（group 的权威来源）。 */
export function loadStartupGroups(cmsisRoot) {
    const dir = join(cmsisRoot, "Source/Templates/gcc");
    const groupsByLine = new Map();
    if (!existsSync(dir)) return groupsByLine;
    for (const name of readdirSync(dir).sort()) {
        const match = STARTUP_PATTERN.exec(name);
        if (match === null) continue;
        const line = match[2];
        const groups = groupsByLine.get(line) ?? new Set();
        groups.add(match[3].toLowerCase());
        groupsByLine.set(line, groups);
    }
    return groupsByLine;
}

/**
 * 容量字母 → 容量档：先认「x + 字母」，再按区间覆盖（xb 覆盖 8..B），最后认整条 line 的 xx。
 * 三条都不是就返回 null（宁可跳过这颗，也不瞎猜一个启动文件）。
 */
export function chooseGroupFor(line, letter, packageLetter, groupsByLine) {
    // line 在 db 文件名里是原样大小写（L4+ 的 4P5/4Q5/4R5/4S5 带字母），而启动文件名全小写：
    // 查启动文件档位时统一按小写找，否则 L4+ 会因为 4P5 ≠ 4p5 一颗都算不出来。
    const groups = groupsByLine.get(line) ?? groupsByLine.get(line.toLowerCase());
    if (groups === undefined) return null;
    const direct = "x" + letter.toLowerCase();
    if (groups.has(direct)) return direct;
    if (groups.has("xx")) return "xx";
    // 有些 line 的启动文件是按**封装**分档的（F410：startup_stm32f410cx.s / rx / tx），
    // 这时尾缀是「封装字母 + x」而不是「x + 容量字母」，用它才对得上。
    const byPackage = packageLetter.toLowerCase() + "x";
    if (groups.has(byPackage)) return byPackage;
    const rank = letterRank(letter);
    if (rank < 0) return null;
    const singles = [...groups].filter((group) => /^x[0-9a-z]$/u.test(group) && group !== "xx").sort((a, b) => letterRank(a.charAt(1)) - letterRank(b.charAt(1)));
    // 只有「x + 容量字母」的档位参与区间覆盖；「cx/rx」这种按封装分档的不参与。
    for (const group of singles) {
        if (letterRank(group.charAt(1)) >= rank) return group;
    }
    return null;
}

/** 命名规则（与插件 src/data/device-facts.ts 的 namingFrom 必须逐字一致）。 */
export function namingOf(family, line, suffix, deviceId) {
    const letter = family.charAt(0).toLowerCase();
    // 文件名全小写：L4+ 的 line 是 4P5（带字母），固件包里那份叫 startup_stm32l4p5xx.s。
    const lowerLine = line.toLowerCase();
    return {
        startup: "startup_stm32" + letter + lowerLine + suffix + ".s",
        deviceHeader: "stm32" + letter + lowerLine + suffix + ".h",
        deviceDefine: "STM32" + family.charAt(0).toUpperCase() + line + defineSuffix(suffix),
        linkerScript: deviceId + "_FLASH.ld",
    };
}

/**
 * 启动文件尾缀 → 设备宏的尾缀（大写的是「不是 x 的那个字符」，x 永远小写）：
 *   xb → xB（STM32F103xB）  xx → xx（STM32F407xx）  cx → Cx（STM32F410Cx，「按封装分档」那种）
 */
export function defineSuffix(suffix) {
    if (suffix === "xx") return "xx";
    if (suffix.charAt(0) === "x") return "x" + suffix.charAt(1).toUpperCase();
    return suffix.charAt(0).toUpperCase() + suffix.charAt(1);
}

/**
 * 一族全部 CPN 的事实（F1 的 9 个基础字段 + 3 个实测出来的文件名，见下方 chips.push 的注释）。
 * 返回 { chips, skipped }：算不出来的写 skipped 的 reason（不猜），调用方负责汇总。
 */
export function collectFamilyChips({ mcuDir, cmsisRoot, family }) {
    const groups = loadMcuGroups(mcuDir, family);
    const groupsByLine = loadStartupGroups(cmsisRoot);
    const headerDir = join(cmsisRoot, "Include");
    const startupDir = join(cmsisRoot, "Source/Templates/gcc");
    const chips = [];
    const skipped = [];
    for (const group of groups) {
        for (const letter of group.letters) {
            const capacity = chooseGroupFor(group.line, letter, group.packageLetter, groupsByLine);
            if (capacity === null) {
                skipped.push({ what: group.refName + " 的容量字母 " + letter, reason: family + " 的 line " + group.line + " 没有匹配的启动文件档位" });
                continue;
            }
            const index = group.letters.indexOf(letter);
            const flashKb = group.flashKb.length === group.letters.length ? group.flashKb[index] : group.flashKb[0];
            if (flashKb === undefined) {
                skipped.push({ what: group.refName + " 的容量字母 " + letter, reason: "db 里没有 <Flash> 值" });
                continue;
            }
            const deviceId = "STM32" + family.charAt(0).toUpperCase() + group.line + group.packageLetter + letter + group.suffixLetter + "x";
            const cpn = deviceId.slice(0, -1) + "6";
            const naming = namingOf(family, group.line, capacity, deviceId);
            if (!existsSync(join(startupDir, naming.startup))) {
                skipped.push({ what: cpn, reason: "固件包里没有启动文件 " + naming.startup });
                continue;
            }
            if (!existsSync(join(headerDir, naming.deviceHeader))) {
                skipped.push({ what: cpn, reason: "固件包里没有设备头 " + naming.deviceHeader });
                continue;
            }
            const pinCount = pinCountOf(group.packageName);
            if (pinCount === undefined) {
                skipped.push({ what: cpn, reason: "封装 " + group.packageName + " 里认不出引脚数" });
                continue;
            }
            chips.push({
                cpn,
                line: group.line,
                group: capacity,
                packageName: group.packageName,
                pinCount,
                flashBytes: flashKb * 1024,
                ramBytes: (Number.isFinite(group.ramKb) ? group.ramKb : 0) * 1024,
                deviceId,
                mcuName: group.refName,
                // 这三样已经是**实测过的文件名**（上面两个 existsSync 就是判据），所以显式写出来：
                // 插件侧就不必再按 F1 那套「STM32F + line + x + 容量字母」去推（L4+/按封装分档的族推不出来）。
                startup: naming.startup,
                deviceHeader: naming.deviceHeader,
                deviceDefine: naming.deviceDefine,
            });
        }
    }
    chips.sort((a, b) => (a.cpn < b.cpn ? -1 : a.cpn > b.cpn ? 1 : 0));
    return { chips, skipped, groups };
}

/** 把 CubeMX 生成的族模板规整成插件可渲染的形式（只改工程名占位符，其它键原样保留）。 */
export function normalizeFamilyIoc(text) {
    const lines = text.split(/\r?\n/u).filter((line) => line !== "");
    const out = lines.map((line) => {
        if (line.startsWith("ProjectManager.ProjectName=")) return "ProjectManager.ProjectName=__PROJECT_NAME__";
        return line;
    });
    return out.join("\n") + "\n";
}
