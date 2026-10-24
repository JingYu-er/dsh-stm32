/**
 * L1：第三方包索引（thirdparties/pdsc）的按需停放与「要不要加载」的判定。
 *
 * 背景（实测，见 docs/development-notes.md）：
 * CubeMX 每次无头启动都会扫 ~/.stm32cubemx/thirdparties/pdsc 里的 159 个 X-CUBE 包索引
 * （11.6 MB），并在 change project 时再枚举一遍，纯 HAL 工程白花约 25 s
 * （155.6 s → 130.3 s），产物字节完全一致（整树 sha256 相同）。
 *
 * 判定不靠猜关键词，而是靠包目录（src/engine/xcube-catalog.ts，由 CubeMX 的 pdsc 目录生成）：
 *   Mcu.ThirdPartyNb=<n> / Mcu.ThirdParty0=STMicroelectronics.X-CUBE-ALGOBUILD.1.4.0
 * 解析成 <vendor>.<pack>[.<version>]，再跟本机索引对一遍 —— 既知道要不要索引，也知道本机有没有这个包。
 *
 * 保守原则：判断不了就保留（多花的 25 s 可以接受，漏加载包可能生成错代码）。
 */
import { existsSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { describePack, listInstalledPacks, scanIocPacks, summarizePacks } from "./xcube.js";
/** 停放后的目录名（与 pdsc 同级）。 */
export const PARKED_NAME = "pdsc.dsh-parked";
function packWarnings(packs, pdscDir, installed) {
    if (pdscDir === undefined)
        return [];
    if (installed === null) {
        return ["读不到本机第三方包索引目录（" + pdscDir + "），没法判断工程要的包在不在本机"];
    }
    const out = [];
    for (const pack of packs) {
        if (pack.installed === "missing") {
            out.push("工程要用 " + describePack(pack) +
                "，但本机第三方包索引里没有这个包（先在 CubeMX 的 Manage embedded software packages 里装上它，否则生成会报缺包）：" +
                pdscDir);
        }
        else if (pack.installed === "other-version") {
            out.push("工程要用 " + describePack(pack) +
                "，本机索引里只有 " + pack.installedVersions.join("、") +
                "（CubeMX 会按可用版本处理，必要时在它里面 Migrate）");
        }
    }
    return out;
}
/**
 * 从 .ioc 正文判断本次生成要不要第三方包索引。
 *
 * 判定顺序：
 *   Mcu.ThirdPartyNb > 0            → 需要（并列出包名与本机安装情况）
 *   正文里引用了目录里的包          → 需要（.ioc 没写 Nb 但确实用了包）
 *   正文里出现目录里的包名（无 vendor）→ 需要（认不全，保守）
 *   Mcu.ThirdParty 行解析不了       → 需要（保守）
 *   Mcu.ThirdPartyNb = 0 且无包证据 → 不需要（可以停放，省约 25 s）
 *   没有 Mcu.ThirdPartyNb 且无证据  → 需要（手写/旧版 .ioc，保守）
 */
export function needsThirdpartyPacks(iocText, options = {}) {
    const pdscDir = options.pdscDir;
    const installed = pdscDir === undefined ? null : listInstalledPacks(pdscDir);
    const scan = scanIocPacks(iocText, { installed });
    const evidence = [];
    const push = (line) => {
        if (evidence.length >= 3 || evidence.includes(line))
            return;
        evidence.push(line);
    };
    if (scan.nbLine !== null)
        push(scan.nbLine);
    for (const pack of scan.packs)
        push(pack.raw);
    for (const marker of scan.markers)
        push(marker);
    for (const bad of scan.malformed)
        push(bad);
    const warnings = packWarnings(scan.packs, pdscDir, installed);
    const listed = summarizePacks(scan.packs);
    const count = scan.thirdPartyNb;
    if (count !== null && count > 0) {
        return {
            needed: true,
            reason: "工程声明了 " + String(count) + " 个第三方包" + (listed === "" ? "" : "（" + listed + "）"),
            evidence,
            packs: scan.packs,
            warnings,
        };
    }
    if (scan.packs.length > 0) {
        return {
            needed: true,
            reason: ".ioc 里引用了第三方包（" + listed + "）" +
                (count === 0 ? "，但 Mcu.ThirdPartyNb=0（两处对不上，保守保留索引）" : ""),
            evidence,
            packs: scan.packs,
            warnings,
        };
    }
    if (scan.markers.length > 0) {
        return { needed: true, reason: ".ioc 里出现了第三方包标记（X-CUBE/I-CUBE 等）", evidence, packs: [], warnings };
    }
    if (scan.malformed.length > 0) {
        return { needed: true, reason: ".ioc 里有解析不了的 Mcu.ThirdParty 行，保守保留索引", evidence, packs: [], warnings };
    }
    if (count === 0) {
        return { needed: false, reason: "工程没有第三方包（Mcu.ThirdPartyNb=0），本次生成不需要包索引", evidence: [], packs: [], warnings: [] };
    }
    return {
        needed: true,
        reason: ".ioc 里没有 Mcu.ThirdPartyNb，无法确认是否用第三方包，保守保留",
        evidence: [],
        packs: [],
        warnings: [],
    };
}
/** CubeMX 的用户级目录（~/.stm32cubemx）。显式 STM32CUBEMX_HOME 优先，便于测试与多机。 */
export function cubeMxUserHome(env) {
    const explicit = env.STM32CUBEMX_HOME;
    if (explicit !== undefined && explicit.trim() !== "")
        return explicit.trim().replace(/\\/gu, "/");
    const base = env.USERPROFILE ?? env.HOME;
    if (base === undefined || base.trim() === "")
        return null;
    return base.trim().replace(/\\/gu, "/") + "/.stm32cubemx";
}
function dirIsEmpty(dir) {
    try {
        return readdirSync(dir).length === 0;
    }
    catch {
        return false;
    }
}
/**
 * 把 <thirdparties>/pdsc 停放到 <thirdparties>/pdsc.dsh-parked。
 *
 * 只在确实需要停放时调用；失败一律返回 ok:false（调用方照常跑生成，只是没省下这 25 s）。
 */
export function parkThirdpartyDb(thirdpartiesDir) {
    const dbPath = join(thirdpartiesDir, "pdsc");
    const parkedPath = join(thirdpartiesDir, PARKED_NAME);
    if (!existsSync(dbPath)) {
        if (existsSync(parkedPath)) {
            // 上次没还原（进程被杀）：先还原，本次当作「无索引可停放」。
            try {
                renameSync(parkedPath, dbPath);
                return { ok: false, detail: "发现上次停放的第三方包索引，已先还原（本次未再停放）" };
            }
            catch (error) {
                return { ok: false, detail: "上次停放的第三方包索引还原失败：" + String(error.message) };
            }
        }
        return { ok: false, detail: "没有第三方包索引目录（" + dbPath + "），无需停放" };
    }
    if (dirIsEmpty(dbPath)) {
        return { ok: false, detail: "第三方包索引目录是空的（" + dbPath + "），无需停放" };
    }
    if (existsSync(parkedPath)) {
        return {
            ok: false,
            detail: "停放位置已被占用（" + parkedPath + "），本次按原样加载；确认后可手动删除该目录",
        };
    }
    try {
        renameSync(dbPath, parkedPath);
    }
    catch (error) {
        return { ok: false, detail: "停放第三方包索引失败：" + String(error.message) };
    }
    return {
        ok: true,
        detail: "已临时停放第三方包索引（" + parkedPath + "），生成结束后自动还原",
        parkedPath,
        dbPath,
        restore: () => {
            const notes = [];
            if (!existsSync(parkedPath))
                return notes;
            if (existsSync(dbPath)) {
                // 实测：CubeMX 运行中会自己新建一个**空的** pdsc 目录，必须删掉才能改名回去。
                if (dirIsEmpty(dbPath)) {
                    try {
                        rmdirSync(dbPath);
                    }
                    catch (error) {
                        notes.push("还原第三方包索引失败（删不掉空目录 " + dbPath + "）：" + String(error.message));
                        return notes;
                    }
                }
                else {
                    notes.push("CubeMX 运行中重新生成了 " + dbPath + "（非空），原索引仍在 " + parkedPath + "，请手动合并或删除其一");
                    return notes;
                }
            }
            try {
                renameSync(parkedPath, dbPath);
            }
            catch (error) {
                notes.push("还原第三方包索引失败：" + String(error.message) + "（原索引在 " + parkedPath + "）");
            }
            return notes;
        },
    };
}
