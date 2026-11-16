/**
 * 手绘层里新放的元件补到板子上（S177）。
 *
 * 手绘层 `hardware/schematic/*.kicad_sch` 可以放图上原来没有的器件（S175），但板子还是构建产物，
 * 不补上去就等于只画了图。这里按位号找出「手绘层有、板上没有」的元件：
 *
 * - 封装从 `Footprint` 属性来（形如 `Resistor_SMD:R_0603_1608Metric`），空属性直接说没有；
 * - 只赋板上已存在的同名网络（`GND`、`V3V3`…）；自动网名 `N$n` 与 tscircuit 的 `.R1 > .pin2` 一律不赋；
 * - 位置给暂定坐标：板框下方一排，等布线前用 `stm32_pcb_place` 或人手工摆；
 * - `apply` 默认 false，只出计划；写盘前留 `.bak`。
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSheetNets } from "../../schematic/nets.js";
import { parseSchText } from "../../schematic/kicad-sch.js";
import { drawSheetPath } from "../../schematic/draw.js";
import { readPcb } from "../../schematic/pcb.js";
import { readBoardBox } from "../dfm.js";
import { resolveProjectLayout } from "../../project-layout.js";
import { findLatestKicadBuild, planEcadWorkspace } from "../tsci.js";
const EMPTY = {
    ok: false,
    error: "",
    schematicFile: "",
    boardFile: "",
    libraryDirs: [],
    parts: [],
    alreadyOnBoard: [],
    noFootprint: [],
    noNet: 0,
    notes: [],
};
/** 自动网名不是设计意图：`N$3`、`Net-(R1-Pad2)`、tscircuit 的 `.R1 > .pin2` 都不赋。 */
export function assignableNet(name) {
    const trimmed = name.trim();
    if (trimmed === "")
        return false;
    if (/^N\$\d+$/u.test(trimmed))
        return false;
    if (/^Net-\(/u.test(trimmed))
        return false;
    if (trimmed.includes(" > "))
        return false;
    return true;
}
function splitFootprint(footprint) {
    const index = footprint.indexOf(":");
    if (index <= 0)
        return { library: "", name: footprint.trim() };
    return { library: footprint.slice(0, index).trim(), name: footprint.slice(index + 1).trim() };
}
/** 引脚 → 网络名；未连线或不可赋值的记空串。 */
function netsOfSheet(schematicFile) {
    const byRef = new Map();
    const text = readFileSync(schematicFile, "utf8");
    const sheet = parseSchText(text, schematicFile, schematicFile);
    const built = buildSheetNets(sheet);
    for (const [pin, index] of built.pinNet) {
        const split = pin.lastIndexOf(".");
        if (split <= 0)
            continue;
        const ref = pin.slice(0, split);
        const number = pin.slice(split + 1);
        const net = built.nets[index];
        if (net === undefined)
            continue;
        const name = net.name !== "" ? net.name : (net.power[0] ?? "");
        const map = byRef.get(ref) ?? new Map();
        map.set(number, assignableNet(name) ? name : "");
        byRef.set(ref, map);
    }
    return byRef;
}
export function planHandSync(projectDir, options = {}) {
    const layout = resolveProjectLayout(projectDir);
    const workspace = planEcadWorkspace(projectDir, layout.hardwareDir);
    const boardFile = options.boardFile !== undefined && options.boardFile !== ""
        ? options.boardFile
        : (findLatestKicadBuild(workspace)?.pcbFile ?? "");
    const schematicFile = options.schematicFile !== undefined && options.schematicFile !== ""
        ? options.schematicFile
        : drawSheetPath(projectDir);
    if (!existsSync(schematicFile)) {
        return { ...EMPTY, schematicFile, boardFile, error: "还没有手绘层：先用 stm32_sch_draw（seed: true）把底图拷出来" };
    }
    if (boardFile === "" || !existsSync(boardFile)) {
        return { ...EMPTY, schematicFile, boardFile, error: "还没有可用的 .kicad_pcb：先跑一次 stm32_ecad_build" };
    }
    const sheet = parseSchText(readFileSync(schematicFile, "utf8"), schematicFile, schematicFile);
    const nets = netsOfSheet(schematicFile);
    const board = readPcb(boardFile);
    const box = readBoardBox(readFileSync(boardFile, "utf8"));
    const onBoard = new Set(board.refs);
    // 项目自己的库在前，KiCad 官方库在后；同一个封装名在两边都有时用项目里那份。
    const libraryDirs = [
        join(layout.hardwareDir, "libs", "footprints"),
        join(layout.projectDir, "hardware", "libs", "footprints"),
        ...(options.footprintDirs ?? []),
    ].filter((dir, index, all) => all.indexOf(dir) === index);
    const parts = [];
    const alreadyOnBoard = [];
    const noFootprint = [];
    let noNet = 0;
    const baseX = box === null ? 0 : box.x0;
    const baseY = box === null ? 0 : box.y1 + 5;
    let index = 0;
    for (const symbol of sheet.symbols) {
        if (symbol.ref === "" || symbol.isPower)
            continue;
        if (onBoard.has(symbol.ref)) {
            alreadyOnBoard.push(symbol.ref);
            continue;
        }
        // 实例上的 Footprint 常常是空的（tscircuit 只写在 lib_symbols 里），别因此当成「没有封装」。
        const footprint = (symbol.footprint.trim() !== "" ? symbol.footprint : (sheet.libFootprints.get(symbol.libId) ?? "")).trim();
        if (footprint === "") {
            noFootprint.push(symbol.ref);
            continue;
        }
        const split = splitFootprint(footprint);
        // tscircuit 的封装名（`tscircuit:resistor_res0402`）不是 KiCad 库：照实说，不去猜。
        if (split.library === "tscircuit") {
            noFootprint.push(symbol.ref + "（tscircuit 封装）");
            continue;
        }
        const mapped = [];
        for (const [number, net] of nets.get(symbol.ref) ?? new Map()) {
            if (net === "") {
                noNet += 1;
                continue;
            }
            mapped.push({ number, net });
        }
        parts.push({
            ref: symbol.ref,
            value: symbol.value,
            footprint,
            library: split.library,
            footprintName: split.name,
            nets: mapped,
            x: Math.round((baseX + 5 + index * 5) * 1000) / 1000,
            y: Math.round((baseY + 5) * 1000) / 1000,
        });
        index += 1;
    }
    const notes = [];
    if (parts.length > 0)
        notes.push("新封装的坐标是暂定的：板框下方一排，布线前用 stm32_pcb_place 或手工摆");
    if (noFootprint.length > 0)
        notes.push("这些元件没有 Footprint 属性，不补到板上：" + noFootprint.slice(0, 8).join("、"));
    if (noNet > 0)
        notes.push("有 " + String(noNet) + " 个引脚没有可赋的网络（未连线或自动网名）：补到板上后要人接");
    if (board.nets.size === 0)
        notes.push("板子上还没有网络声明：补进去的封装不会带网络");
    return { ok: true, error: "", schematicFile, boardFile, libraryDirs, parts, alreadyOnBoard, noFootprint, noNet, notes };
}
/** 交给 KiCad 自带 python 执行：逐件 FootprintLoad → SetReference/SetValue/SetPosition → 赋网络。 */
export function buildHandSyncScript(plan) {
    const payload = {
        boardFile: plan.boardFile,
        libraryDirs: [...plan.libraryDirs],
        parts: plan.parts.map((part) => ({
            ref: part.ref,
            value: part.value,
            library: part.library,
            footprintName: part.footprintName,
            x: part.x,
            y: part.y,
            nets: part.nets.map((net) => ({ number: net.number, net: net.net })),
        })),
    };
    return [
        "import json, os, sys, pcbnew",
        "payload = json.loads(sys.argv[1])",
        "board = pcbnew.LoadBoard(payload['boardFile'])",
        "by_ref = {fp.GetReference(): fp for fp in board.GetFootprints()}",
        "net_of = {str(name): net for name, net in board.GetNetInfo().NetsByName().items()}",
        "added, skipped, missing_lib, unassigned = 0, [], [], 0",
        "for part in payload['parts']:",
        "    ref = part['ref']",
        "    if ref in by_ref:",
        "        skipped.append(ref)",
        "        continue",
        "    fp = None",
        "    for base in payload['libraryDirs']:",
        "        candidate = os.path.join(base, part['library'] + '.pretty')",
        "        if not os.path.isdir(candidate):",
        "            continue",
        "        try:",
        "            fp = pcbnew.FootprintLoad(candidate, part['footprintName'])",
        "        except Exception:",
        "            fp = None",
        "        if fp is not None:",
        "            break",
        "    if fp is None:",
        "        missing_lib.append(ref)",
        "        continue",
        "    fp.SetReference(ref)",
        "    if part['value'] != '':",
        "        fp.SetValue(part['value'])",
        "    fp.SetPosition(pcbnew.VECTOR2I(int(round(part['x'] * 1e6)), int(round(part['y'] * 1e6))))",
        "    board.Add(fp)",
        "    for pin in part['nets']:",
        "        net = net_of.get(pin['net'])",
        "        if net is None:",
        "            unassigned += 1",
        "            continue",
        "        for pad in fp.Pads():",
        "            if str(pad.GetNumber()) == str(pin['number']):",
        "                pad.SetNet(net)",
        "    added += 1",
        "pcbnew.SaveBoard(payload['boardFile'], board)",
        "with open(sys.argv[2], 'w', encoding='utf-8') as handle:",
        "    json.dump({'added': added, 'skipped': skipped, 'missingLib': missing_lib, 'unassigned': unassigned}, handle)",
    ].join("\n");
}
export function parseHandSyncOutput(text) {
    const line = text
        .split(/\r?\n/u)
        .reverse()
        .find((row) => row.trim().startsWith("{") && row.includes("\"added\""));
    if (line === undefined)
        return { ok: false, added: 0, skipped: [], missingLib: [], unassigned: 0 };
    try {
        const parsed = JSON.parse(line);
        return {
            ok: true,
            added: typeof parsed.added === "number" ? parsed.added : 0,
            skipped: Array.isArray(parsed.skipped) ? parsed.skipped : [],
            missingLib: Array.isArray(parsed.missingLib) ? parsed.missingLib : [],
            unassigned: typeof parsed.unassigned === "number" ? parsed.unassigned : 0,
        };
    }
    catch {
        return { ok: false, added: 0, skipped: [], missingLib: [], unassigned: 0 };
    }
}
export function backupBoardFile(boardFile) {
    const bak = boardFile + ".bak";
    copyFileSync(boardFile, bak);
    return bak;
}
