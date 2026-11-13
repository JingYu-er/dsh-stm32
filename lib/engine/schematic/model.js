/**
 * 原理图模型：把图纸树合并成「元件 / 引脚 / 网络」三张表，并派生出电路框图。
 *
 * 合并规则：电源网络与全局标号跨图纸按名字合并；本地标号只在所属图纸内有效
 * （这是 KiCad 的语义，跨页同名本地标号并不相连）。层级图纸引脚暂不解析，
 * 多图纸工程会带 `sheet.hierarchy-unresolved` 告警，避免把未连通的网络当成连通。
 *
 * 框图面向人看：MCU、主要 IC、连接器各成一框，两只元件之间有网络就连一条线，
 * 线上写网络名；GND/VCC 这类电源网络画成连线会把图糊掉，单独列为「电源网络」。
 */
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { readSchTree } from "./kicad-sch.js";
import { buildSheetNets } from "./nets.js";
/** 工程目录里找根图纸：优先与 `.kicad_pro` 同名的文件，其次取未被其它图纸引用的那张。 */
export function findRootSchematic(projectDir) {
    let entries;
    try {
        entries = readdirSync(projectDir);
    }
    catch {
        return null;
    }
    const sch = entries.filter((name) => extname(name) === ".kicad_sch").sort();
    if (sch.length === 0)
        return null;
    const pro = entries.find((name) => extname(name) === ".kicad_pro");
    if (pro !== undefined) {
        const expected = `${basename(pro, ".kicad_pro")}.kicad_sch`;
        if (sch.includes(expected))
            return join(projectDir, expected);
    }
    return join(projectDir, sch[0]);
}
function classify(ref, value) {
    if (/^STM32/u.test(value))
        return "mcu";
    if (/^(J|CN|P)\d/u.test(ref) || /^(Conn|Connector|Screw|Header|Jack|USB|Terminal)/u.test(value))
        return "connector";
    if (/^U\d/u.test(ref))
        return "ic";
    if (/^(R|C|L|D|FB|Y|X|Q)\d/u.test(ref))
        return "passive";
    return "other";
}
function humanLabel(component) {
    const value = component.value === "" ? component.ref : component.value;
    return value.length > 26 ? `${value.slice(0, 25)}…` : value;
}
/**
 * 读原理图并合成报告。
 *
 * `rootFile` 显式给定时按该文件读；否则在 `projectDir` 里找根图纸。
 */
export function readSchematic(rootFile) {
    const tree = readSchTree(rootFile);
    const warnings = [...tree.warnings];
    const merged = new Map();
    const localNets = [];
    const sheetNets = new Map();
    for (const sheet of tree.sheets) {
        const result = buildSheetNets(sheet);
        sheetNets.set(sheet.relFile, result);
        for (const net of result.nets) {
            const globalKey = net.kind === "power" || net.global ? `g:${net.name}` : `l:${sheet.relFile}:${net.name}`;
            let entry = merged.get(globalKey);
            if (entry === undefined) {
                entry = { name: net.name, kind: net.kind, sheets: new Set(), labels: new Set(), pins: [] };
                merged.set(globalKey, entry);
            }
            entry.sheets.add(net.sheet);
            for (const label of net.labels)
                entry.labels.add(label);
            for (const pin of net.pins)
                entry.pins.push({ ref: pin.ref, number: pin.number, name: pin.name });
            localNets.push(net);
        }
        if (result.floatingPins.length > 0) {
            warnings.push(`${sheet.relFile}：${result.floatingPins.length} 个引脚没有碰到导线（${result.floatingPins.slice(0, 6).join("、")}）`);
        }
    }
    const components = [];
    for (const sheet of tree.sheets) {
        const symPins = new Map();
        for (const symbol of sheet.symbols) {
            if (symbol.isPower || symbol.ref === "" || symbol.ref.startsWith("#"))
                continue;
            const pins = [];
            const libPins = (sheet.libPins.get(symbol.libId) ?? []).filter((pin) => pin.unit === 0 || pin.unit === symbol.unit);
            const placed = libPins.length > 0 ? libPins : sheet.libPins.get(symbol.libId) ?? [];
            const netResult = sheetNets.get(sheet.relFile);
            for (const pin of placed) {
                const key = `${symbol.ref}:${pin.number}`;
                const index = netResult?.pinNet.get(key);
                const source = index === undefined ? undefined : netResult?.nets[index];
                pins.push({
                    number: pin.number,
                    name: pin.name,
                    net: source?.name ?? "",
                    type: pin.kind,
                    noConnect: source?.hasNoConnect === true,
                });
            }
            symPins.set(symbol.ref, pins);
            components.push({
                ref: symbol.ref,
                value: symbol.value,
                footprint: symbol.footprint,
                libId: symbol.libId,
                sheet: sheet.relFile,
                dnp: symbol.dnp,
                pins,
            });
        }
    }
    const nets = [...merged.values()]
        .filter((net) => net.pins.length > 0 || net.kind !== "unnamed")
        .map((net) => ({
        name: net.name,
        kind: net.kind,
        sheets: [...net.sheets].sort(),
        labels: [...net.labels].sort(),
        pins: net.pins,
    }))
        .sort((a, b) => b.pins.length - a.pins.length || a.name.localeCompare(b.name));
    const mcuComponent = components.find((component) => /^STM32/u.test(component.value));
    if (mcuComponent === undefined)
        warnings.push("没有识别到 STM32 主控：框图只按普通元件分组");
    const multiUnit = new Map();
    for (const sheet of tree.sheets) {
        for (const symbol of sheet.symbols) {
            if (symbol.ref === "" || symbol.ref.startsWith("#"))
                continue;
            multiUnit.set(symbol.ref, (multiUnit.get(symbol.ref) ?? 0) + 1);
        }
    }
    for (const [ref, count] of multiUnit) {
        if (count > 1)
            warnings.push(`元件 ${ref} 在图纸上出现 ${count} 次（多单元符号按同一引用合并）`);
    }
    const hierarchical = tree.sheets.some((sheet) => sheet.labels.some((label) => label.kind === "hierarchical_label"));
    if (hierarchical && tree.sheets.length > 1) {
        warnings.push("多图纸工程含层级标号：层级图纸引脚未跨页解析，跨页连通性请以 PCB 对账为准");
    }
    if (tree.sheets.length > 1)
        warnings.push(`共 ${tree.sheets.length} 张图纸；未在根图纸引用的历史文件不参与解析`);
    const unreferenced = unreferencedSheets(dirname(rootFile), tree.sheets);
    if (unreferenced.length > 0) {
        warnings.push(`目录内还有未引用的图纸（历史版本，按设计不解析）：${unreferenced.join("、")}`);
    }
    const diagram = buildDiagram(components, nets);
    const report = {
        rootFile,
        version: tree.sheets[0]?.version ?? 0,
        generator: tree.sheets[0]?.generator ?? "",
        sheets: tree.sheets.map((sheet) => {
            const netsOfSheet = localNets.filter((net) => net.sheet === sheet.relFile);
            return { file: sheet.relFile, paper: sheet.paper, symbols: sheet.symbols.length, nets: netsOfSheet.length };
        }),
        components,
        nets,
        mcu: mcuComponent === undefined ? null : { ref: mcuComponent.ref, value: mcuComponent.value, pins: mcuComponent.pins },
        diagram,
        warnings,
    };
    const netPins = new Map();
    for (const net of nets)
        netPins.set(net.name, net.pins.map((pin) => ({ ref: pin.ref, number: pin.number })));
    return { report, netPins };
}
/** 目录里存在、但没有被任何图纸引用的 `.kicad_sch`（历史版本）。 */
function unreferencedSheets(projectDir, sheets) {
    const used = new Set(sheets.map((sheet) => resolve(sheet.file)));
    let entries = [];
    try {
        entries = readdirSync(projectDir);
    }
    catch {
        return [];
    }
    return entries
        .filter((name) => extname(name) === ".kicad_sch")
        .map((name) => join(projectDir, name))
        .filter((file) => !used.has(resolve(file)) && statSync(file).isFile())
        .map((file) => basename(file));
}
/** 按网络名判断总线类型；认不出来时返回 null，由调用方回落到网络名。 */
function busOf(nets) {
    const names = nets.map((name) => name.toUpperCase());
    const has = (pattern) => names.some((name) => pattern.test(name));
    if (has(/SCL/u) && has(/SDA/u))
        return "I2C";
    if (has(/MOSI/u) || has(/MISO/u) || has(/SCK/u))
        return "SPI";
    if (has(/TXD?\b/u) && has(/RXD?\b/u))
        return "UART";
    return null;
}
function buildDiagram(components, nets) {
    const blocks = new Map();
    for (const component of components) {
        const kind = classify(component.ref, component.value);
        if (kind === "passive")
            continue;
        blocks.set(component.ref, { id: component.ref, label: humanLabel(component), kind, refs: [component.ref] });
    }
    // 无源器件不单独成框：模块框图回答「哪两块电路连在一起、走什么总线」，
    // 电容电阻只会把图连成一团，具体连接留给元件表与网络表。
    const blockOfRef = (ref) => (blocks.has(ref) ? ref : null);
    const links = new Map();
    const powerNets = new Set();
    // 自动网络名（N$12）是解析器的占位：画到图上只会变成噪声，连线只画人起过名字的网络。
    const isAnonymous = (name) => /^N\$\d+$/u.test(name);
    for (const net of nets) {
        if (net.kind !== "power" && isAnonymous(net.name))
            continue;
        const refs = [...new Set(net.pins.map((pin) => blockOfRef(pin.ref)).filter((ref) => ref !== null))];
        if (refs.length < 2)
            continue;
        if (net.kind === "power" || refs.length > 6) {
            powerNets.add(net.name);
            continue;
        }
        for (let i = 0; i < refs.length; i += 1) {
            for (let j = i + 1; j < refs.length; j += 1) {
                const a = refs[i];
                const b = refs[j];
                const key = a < b ? `${a}|${b}` : `${b}|${a}`;
                const existing = links.get(key);
                if (existing === undefined) {
                    links.set(key, { from: a < b ? a : b, to: a < b ? b : a, nets: [net.name] });
                }
                else if (!existing.nets.includes(net.name)) {
                    existing.nets.push(net.name);
                }
            }
        }
    }
    // 连接多的块排前面：面板按顺序自上而下摆，读图时先看到与主控关系最密的模块。
    const degree = new Map();
    for (const link of links.values()) {
        degree.set(link.from, (degree.get(link.from) ?? 0) + link.nets.length);
        degree.set(link.to, (degree.get(link.to) ?? 0) + link.nets.length);
    }
    const allBlocks = [...blocks.values()];
    const ordered = [
        ...allBlocks.filter((block) => block.kind === "mcu"),
        ...allBlocks
            .filter((block) => block.kind !== "mcu")
            .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.id.localeCompare(b.id)),
    ];
    const linksWithLabel = [...links.values()].map((link) => {
        const netsOfLink = [...link.nets].sort();
        const shown = netsOfLink.slice(0, 3).join(" / ");
        const extra = netsOfLink.length > 3 ? ` +${netsOfLink.length - 3}` : "";
        // 线上文字优先写总线类型（I2C/SPI/UART）：这是读图的人先要的信息，
        // 具体网络名放进 nets，面板可在悬停时展开。
        const bus = busOf(netsOfLink);
        return { from: link.from, to: link.to, label: bus ?? `${shown}${extra}`, nets: netsOfLink };
    });
    return { blocks: ordered, links: linksWithLabel, powerNets: [...powerNets].sort() };
}
