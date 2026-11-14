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
/**
 * 模块识别规则（按“这块电路在做什么”归类，不按位号）。
 *
 * 先把有明确身份的器件认成种子：主控、NFC 标签与天线、光电与运放、供电、调试接口、
 * 按键；再把电阻电容等无源器件按连接关系并进种子模块。规则只认器件库与网络语义，
 * 换一块板子照样能用；认不出的模块单列，不硬塞。
 */
const MODULE_SPECS = [
    {
        key: "mcu",
        label: "主控",
        match: (c) => /^STM32|^GD32|^ATSAM|^MSP430|^RP2040|^ESP32/u.test(c.value),
    },
    {
        key: "nfc",
        label: "NFC 天线与标签",
        match: (c) => /^RF_NFC:/u.test(c.libId) ||
            /^NFC_Coil:/u.test(c.libId) ||
            /^(ST25D|M24SR|NT3H|PN5|FM11)/u.test(c.value),
    },
    {
        key: "optical",
        label: "光检测",
        match: (c) => /^Sensor_Optical:/u.test(c.libId) ||
            /(Amplifier_Operational|Amplifier:)/u.test(c.libId) ||
            /^Device:(LED|Photodiode|Phototransistor)$/u.test(c.libId),
    },
    {
        key: "power",
        label: "供电与接口",
        match: (c) => /(Regulator_Linear|Regulator_Switching)/u.test(c.libId) ||
            /^Device:Battery/u.test(c.libId) ||
            /(LDO|^AMS1117|^TLV7|^MIC5|^AP2112|^RT9013|^SGM)/iu.test(c.value) ||
            /(USB|Battery|LiPo|CR2032)/iu.test(c.value),
    },
    {
        key: "keys",
        label: "按键与复位",
        match: (c) => /^Switch:/u.test(c.libId) || /^SW_/u.test(c.value),
    },
];
function moduleOf(component, swdRefs) {
    for (const spec of MODULE_SPECS) {
        if (spec.match(component))
            return spec;
    }
    if (swdRefs.has(component.ref))
        return INTERFACE_SPEC;
    return null;
}
const INTERFACE_SPEC = { key: "interface", label: "调试接口", match: () => false };
const PASSIVE_LIB = /^Device:(R|C|L|FB|Ferrite|Crystal|D_TVS|Polyfuse)/u;
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
/** 把一串网络名归纳成读者先要的信息：总线类型与信号用途，而不是逐个引脚名。 */
function signalGroups(nets) {
    const names = nets.map((name) => name.toUpperCase());
    const groups = [];
    const has = (pattern) => names.some((name) => pattern.test(name));
    if (has(/SCL/u) && has(/SDA/u))
        groups.push("I2C");
    if (has(/MOSI/u) && has(/MISO/u) && has(/SCK/u))
        groups.push("SPI");
    if (has(/TXD?\b/u) && has(/RXD?\b/u))
        groups.push("UART");
    if (has(/ADC/u))
        groups.push("ADC");
    if (has(/^LED|LED\d/u))
        groups.push("LED");
    if (has(/PWM/u))
        groups.push("PWM");
    if (has(/SWD(IO|CLK)/u))
        groups.push("SWD");
    if (has(/^(NRST|BOOT0)$/u))
        groups.push("复位与启动");
    return groups;
}
function buildDiagram(components, nets) {
    // 先找出带 SWDIO / SWCLK 的器件：调试口多数是 4 脚排针，靠网络名比靠位号可靠。
    const swdRefs = new Set();
    for (const net of nets) {
        if (!/SWD(IO|CLK)/iu.test(net.name))
            continue;
        for (const pin of net.pins)
            swdRefs.add(pin.ref);
    }
    const moduleOfRef = new Map();
    for (const component of components) {
        const spec = moduleOf(component, swdRefs);
        if (spec === null)
            continue;
        moduleOfRef.set(component.ref, spec.key);
    }
    // 无源器件与认不出的器件按连接关系并进已有模块。两条规则：
    // 1）两脚器件一脚接电源、一脚接信号 —— 它是去耦或上拉，跟信号那侧走；
    // 2）其余按「和哪个模块共网最多」投票，只数非电源网络，避免 VCC 把所有器件绑到一处。
    const isPowerName = (name) => /^(VCC|VDD\w*|VBUS|GND\w*|VSS|\+3V3|\+5V|3V3|5V)/iu.test(name);
    const pinsOfRef = new Map();
    for (const net of nets) {
        for (const pin of net.pins) {
            const list = pinsOfRef.get(pin.ref) ?? [];
            list.push({ net: net.name, kind: net.kind });
            pinsOfRef.set(pin.ref, list);
        }
    }
    const votes = new Map();
    const bump = (ref, kind, weight = 1) => {
        const bucket = votes.get(ref) ?? new Map();
        bucket.set(kind, (bucket.get(kind) ?? 0) + weight);
        votes.set(ref, bucket);
    };
    for (const net of nets) {
        if (net.kind === "power" || isPowerName(net.name))
            continue;
        for (const pin of net.pins) {
            if (moduleOfRef.has(pin.ref))
                continue;
            for (const other of net.pins) {
                const kind = moduleOfRef.get(other.ref);
                if (kind !== undefined)
                    bump(pin.ref, kind);
            }
        }
    }
    // 两脚器件的「一脚电源、一脚信号」规则：信号侧邻居的模块更可信，权重加倍。
    for (const [ref, pins] of pinsOfRef) {
        if (moduleOfRef.has(ref) || pins.length !== 2)
            continue;
        const powerPins = pins.filter((pin) => pin.kind === "power" || isPowerName(pin.net));
        if (powerPins.length !== 1)
            continue;
        const signal = pins.find((pin) => pin !== powerPins[0]);
        if (signal === undefined)
            continue;
        const net = nets.find((item) => item.name === signal.net);
        if (net === undefined)
            continue;
        for (const other of net.pins) {
            const kind = moduleOfRef.get(other.ref);
            if (kind !== undefined)
                bump(ref, kind, 2);
        }
    }
    for (const [ref, bucket] of votes) {
        let best = null;
        let bestCount = 0;
        for (const [kind, count] of bucket) {
            if (count > bestCount) {
                best = kind;
                bestCount = count;
            }
        }
        if (best !== null)
            moduleOfRef.set(ref, best);
    }
    const blocks = new Map();
    const specByKey = new Map([...MODULE_SPECS, INTERFACE_SPEC].map((spec) => [spec.key, spec]));
    for (const component of components) {
        const kind = moduleOfRef.get(component.ref);
        if (kind === undefined)
            continue;
        const spec = specByKey.get(kind);
        const existing = blocks.get(kind);
        if (existing !== undefined) {
            existing.refs.push(component.ref);
            continue;
        }
        blocks.set(kind, {
            id: kind,
            label: spec?.label ?? "其他电路",
            kind,
            refs: [component.ref],
        });
    }
    const blockOfRef = (ref) => moduleOfRef.get(ref) ?? null;
    void blockOfRef;
    const links = new Map();
    const powerNets = new Set();
    const isAnonymous = (name) => /^N\$\d+$/u.test(name);
    for (const net of nets) {
        const refs = [...new Set(net.pins.map((pin) => moduleOfRef.get(pin.ref)).filter((kind) => kind !== undefined))];
        if (refs.length < 2)
            continue;
        if (net.kind === "power" || isPowerName(net.name)) {
            powerNets.add(net.name);
            continue;
        }
        if (refs.length > 6) {
            powerNets.add(net.name);
            continue;
        }
        for (let i = 0; i < refs.length; i += 1) {
            for (let j = i + 1; j < refs.length; j += 1) {
                const a = refs[i];
                const b = refs[j];
                if (a === b)
                    continue;
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
        const netsOfLink = [...link.nets].filter((name) => !isAnonymous(name)).sort();
        const groups = signalGroups(netsOfLink);
        const shown = netsOfLink.slice(0, 3).join(" / ");
        const extra = netsOfLink.length > 3 ? ` +${netsOfLink.length - 3}` : "";
        const label = groups.length > 0 ? groups.join(" · ") : shown === "" ? "" : `${shown}${extra}`;
        return { from: link.from, to: link.to, label, nets: netsOfLink };
    });
    return { blocks: ordered, links: linksWithLabel, powerNets: [...powerNets].sort() };
}
