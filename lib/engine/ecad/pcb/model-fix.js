/**
 * 3D 模型缺失的替代封装建议（S181）。
 *
 * 只回答一个问题：这个封装的 STEP 不在磁盘上，KiCad 官方库里有没有
 * 同族（引脚数/间距/本体一致）且自带 STEP 的封装可以换过去。
 *
 * 判据全部是文件名与磁盘事实：同族库、引脚数相同、间距相同、STEP 真实存在。
 * 不做几何比对，也不替人改板子——给候选，换不换由人决定。
 */
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parenBlocks } from "./emc.js";
import { resolveModelFile } from "./render3d.js";
/** 库目录按族挑；认不出的族扫全部库。 */
const FAMILY_LIBS = [
    { family: "qfp", libs: ["Package_QFP"] },
    { family: "qfn", libs: ["Package_DFN_QFN"] },
    { family: "fpc", libs: ["Connector_FFC-FPC", "Connector_FPC"] },
    { family: "soic", libs: ["Package_SO"] },
    { family: "sot", libs: ["Package_TO_SOT_SMD"] },
];
function familyOf(name) {
    if (/qfp|lqfp|tqfp/iu.test(name))
        return "qfp";
    if (/qfn|dfn/iu.test(name))
        return "qfn";
    if (/fpc|ffc/iu.test(name))
        return "fpc";
    if (/soic|sop|ssop|tssop/iu.test(name))
        return "soic";
    if (/sot|to-\d/iu.test(name))
        return "sot";
    return "";
}
/** 引脚数：优先取封装名里的第一个 2–3 位数字（`qfp48`、`fpc40`）。 */
function pinsOf(name, pads) {
    const match = /(\d{2,3})/u.exec(name);
    if (match !== null) {
        const value = Number(match[1]);
        if (Number.isFinite(value) && value >= 2 && value <= 300)
            return value;
    }
    return pads;
}
/** 引脚间距：`p0.5mm`、`P1.27mm`，也认 tscircuit 的 `p0_5mm` 写法。 */
function pitchOf(name) {
    const match = /p(\d+(?:[._]\d+)?)mm/iu.exec(name);
    if (match === null)
        return 0;
    const value = Number(match[1]?.replace("_", ".") ?? "");
    return Number.isFinite(value) ? value : 0;
}
/** 本体宽度：`w7.5mm`、`w3.4mm`。 */
function bodyOf(name) {
    const match = /w(\d+(?:[._]\d+)?)mm/iu.exec(name);
    if (match === null)
        return 0;
    const value = Number(match[1]?.replace("_", ".") ?? "");
    return Number.isFinite(value) ? value : 0;
}
function factsOf(boardText, boardFile, model3dDir) {
    const facts = [];
    for (const block of parenBlocks(boardText, "footprint")) {
        const libId = /^\(footprint\s+"([^"]+)"/u.exec(block)?.[1] ?? "";
        if (libId === "")
            continue;
        const ref = /\(property "Reference" "([^"]+)"/u.exec(block)?.[1] ?? "";
        const pads = (block.match(/\(pad /gu) ?? []).length;
        const missing = [];
        for (const match of block.matchAll(/\(model\s+"([^"]+)"/gu)) {
            const path = match[1] ?? "";
            if (path === "")
                continue;
            if (!existsSync(resolveModelFile(path, dirname(boardFile), model3dDir)))
                missing.push(path);
        }
        if (missing.length === 0)
            continue;
        const name = libId.includes(":") ? libId.slice(libId.indexOf(":") + 1) : libId;
        facts.push({ ref, libId, name, pads, missing });
    }
    return facts;
}
/** 候选 STEP 按 KiCad 约定推：`<model3dDir>/<Lib>.3dshapes/<Name>.step`（也认 .wrl）。 */
function stepOf(model3dDir, lib, name) {
    const dir = join(model3dDir, lib + ".3dshapes");
    const step = join(dir, name + ".step");
    if (existsSync(step))
        return { path: step, exists: true };
    const wrl = join(dir, name + ".wrl");
    if (existsSync(wrl))
        return { path: wrl, exists: true };
    return { path: step, exists: false };
}
function libsToScan(family, footprintDir) {
    const listed = FAMILY_LIBS.find((item) => item.family === family);
    if (listed !== undefined) {
        return listed.libs.filter((lib) => existsSync(join(footprintDir, lib + ".pretty")));
    }
    try {
        return readdirSync(footprintDir)
            .filter((item) => item.endsWith(".pretty"))
            .map((item) => basename(item, ".pretty"));
    }
    catch {
        return [];
    }
}
function scoreName(name, pins, pitch, body) {
    let score = 0;
    if (pins > 0) {
        const hit = new RegExp("(?:^|[-_x])" + String(pins) + "(?:[-_]|$)", "u").test(name);
        if (!hit)
            return -1;
        score += 1;
    }
    if (pitch > 0) {
        const text = "p" + String(pitch) + "mm";
        if (!name.toLowerCase().includes(text.toLowerCase()))
            return -1;
        score += 3;
    }
    if (body > 0 && name.toLowerCase().includes(String(body) + "x"))
        score += 2;
    return score;
}
/**
 * 对每个缺模型文件的封装给出可换的 KiCad 官方封装。
 *
 * 只在「同族库里有同名引脚数 + 同间距」时才给候选；STEP 存不存在单独标出来。
 */
export function suggestModelFixes(boardText, boardFile, options) {
    const max = options.maxCandidates ?? 3;
    const suggestions = [];
    for (const facts of factsOf(boardText, boardFile, options.model3dDir)) {
        const family = familyOf(facts.name);
        const pins = pinsOf(facts.name, facts.pads);
        const pitch = pitchOf(facts.name);
        const body = bodyOf(facts.name);
        const candidates = [];
        for (const lib of libsToScan(family, options.footprintDir)) {
            let entries = [];
            try {
                entries = readdirSync(join(options.footprintDir, lib + ".pretty")).filter((item) => item.endsWith(".kicad_mod"));
            }
            catch {
                continue;
            }
            for (const entry of entries) {
                const name = entry.slice(0, -".kicad_mod".length);
                const score = scoreName(name, pins, pitch, body);
                if (score <= 0)
                    continue;
                const step = stepOf(options.model3dDir, lib, name);
                candidates.push({ candidate: { libId: lib + ":" + name, stepPath: step.path, has3d: step.exists, pitchMm: pitchOf(name) }, score });
            }
        }
        candidates.sort((left, right) => right.score - left.score || left.candidate.libId.localeCompare(right.candidate.libId));
        const top = candidates.slice(0, max).map((item) => item.candidate);
        suggestions.push({
            ref: facts.ref,
            footprint: facts.libId,
            missingFile: facts.missing[0] ?? "",
            family,
            candidates: top,
            note: top.length === 0
                ? family === ""
                    ? "从封装名里认不出族，没有同族候选：换封装要在 KiCad 里挑，或给这个封装补一个 STEP。"
                    : "同族官方库里没有引脚数与间距都一致的封装：换封装要在 KiCad 里挑，或给这个封装补一个 STEP。"
                : top.some((item) => item.has3d)
                    ? (pitch === 0
                        ? "候选封装引脚数一致、自带 STEP，但板子上的封装名没写间距：换之前核对一下间距（候选里的 pitch）。"
                        : "上面这些官方封装自带 STEP，换过去再重建一次，3D 里就不会空着。")
                    : "候选封装与现在的引脚数/间距一致，但它们的 STEP 也不在磁盘上：换过去仍会是空的，先补 3D 模型库。",
        });
    }
    return suggestions;
}
