/**
 * STM32F1 的 CMSIS-SVD → 精简事实表（device/f1/svd/<line>.json，6 条 line 各一个文件）。
 *
 * 为什么要这一层：SVD 是「外设 → 寄存器 → 位域」的权威事实源（debug 的寄存器视图、
 * 按位写寄存器的代码都得靠它），但原始 ST SVD 是 300 KB ~ 1.2 MB 的 XML，还带 description /
 * enumeratedValues / resetValue 这些这份表用不到的东西。这里把 XML 解析成 JSON：
 *
 *   peripheral { name, baseAddress, registers: [ { name, addressOffset, size, access, fields } ] }
 *   field      { name, bitOffset, bitWidth }
 *
 * 三条约定（写进 README，消费方按这个读）：
 *   1. addressOffset 是相对该外设 baseAddress 的**字节**偏移，统一写成大写十六进制、
 *      至少两位（0x00 / 0x0C / 0x100），和 ST SVD 的原始写法等价。
 *   2. size / bitWidth 单位是**位**（SVD 的 0x20 = 32 位），字段名 sizeUnit 写着 "bits"，
 *      别按字节读。
 *   3. peripheral 的 derivedFrom 已经**展开**：SVD 里 GPIOB..G 只写了 baseAddress，
 *      寄存器是从 GPIOA 继承来的；这份表里每个外设都有完整寄存器，消费方不用再做继承。
 *
 * 覆盖范围与分工：STM32F1 有 6 条产品线（F100/F101/F102/F103/F105/F107），上游 cmsis-svd-data
 * 的 data/STMicro 下正好有 6 个对应的 SVD。**每个文件只覆盖自己那条 line**：
 *   device/f1/svd/100.json ← STM32F100xx.svd    device/f1/svd/101.json ← STM32F101xx.svd
 *   device/f1/svd/102.json ← STM32F102xx.svd    device/f1/svd/103.json ← STM32F103xx.svd
 *   device/f1/svd/105.json ← STM32F105xx.svd    device/f1/svd/107.json ← STM32F107xx.svd
 * 跨 line 的同名外设（GPIOA、USART1……）布局相同，但**独有外设只出现在对应文件里**：
 * F105/F107 的 CAN2、USB OTG_FS、以太网只在 105/107；F100 的 CEC、F102 的 USB 同理。
 * 想知道「这颗芯片有没有 CAN2」就看对应 line 的文件，别拿 103 的表去查 107。
 */

/** 上游 SVD 的固定坐标：同一个 repo、同一个 commit 取 6 个文件，保证任何机器上重跑都解析出同一份结果。 */
export const SVD_REPO = "cmsis-svd/cmsis-svd-data";
export const SVD_COMMIT = "c65f8551e57c770344d229dcaa0bf838fa29aff4";
export const SVD_LICENSE = "STMicroelectronics End User License Agreement v1.0（cmsis-svd-data 的 data/STMicro/License.html）";

/** F1 的 6 条产品线（顺序固定：产物顺序、manifest、日志都按它）。 */
export const SVD_LINES = ["100", "101", "102", "103", "105", "107"];

/** line（"103"）→ 上游文件名（STM32F103xx.svd）。 */
export function svdFileName(line) {
    return "STM32F" + String(line) + "xx.svd";
}

/**
 * 上游文件的坐标（repo/commit/path/url/license + file/line），写进每个产物 JSON 的 source 段。
 * kind=st-svd 表示「ST 原件解析」，消费方据此判断数据可信度（不再有手写兜底那种 kind）。
 */
export function svdSource(line) {
    const file = svdFileName(line);
    const path = "data/STMicro/" + file;
    return {
        kind: "st-svd",
        repo: SVD_REPO,
        commit: SVD_COMMIT,
        path,
        url: "https://raw.githubusercontent.com/" + SVD_REPO + "/" + SVD_COMMIT + "/" + path,
        file,
        line: String(line),
        license: SVD_LICENSE,
    };
}

/** 文件名 → line：认 STM32F103xx.svd 这种写法，认不出返回 null（调用方给可读报错）。 */
export function lineFromFileName(name) {
    const match = /^STM32F(\d{3})xx\.svd$/iu.exec(String(name ?? "").split("/").pop() ?? "");
    return match === null ? null : match[1];
}

/**
 * 每条 line 的 notes（写进产物，消费方不用翻文档）。模板里塞的是这条 line 自己的数字/文件名，
 * 所以 6 个文件的 notes 不完全一样——这是刻意的：看到 107.json 就该知道 CAN2 在这里。
 */
export function svdNotes(line) {
    const name = svdFileName(line);
    const others = SVD_LINES.filter((item) => item !== String(line));
    return [
        "生成物，不要手改：改数据跑 node scripts/assets/build-assets.mjs（--check 只校验不写盘）。",
        "覆盖范围：**只有 " + name.replace(/\.svd$/u, "") + " 这一条产品线**（line=" + line + "）。" +
        "F1 的其它 line 在 device/f1/svd/" + others.join(".json、") + ".json——独有外设不会跨文件出现，查 F105/F107 的 CAN2、USB OTG_FS、以太网要看 105/107 自己的文件。",
        "peripheral 的 derivedFrom 已经展开（GPIOB..G 的寄存器从 GPIOA 继承，DMA2 从 DMA1，TIM3/4/5 从 TIM2……），消费方不用再做继承。",
        "只保留 name/addressOffset/size/access/fields；description、enumeratedValues、resetValue 都丢了——这份表用来查寄存器与位域，不是用来生成头文件的。",
        "addressOffset 是相对外设 baseAddress 的字节偏移；size 与 bitWidth 的单位是位（sizeUnit=bits）。",
    ];
}

/** 去掉 XML 注释：SVD 里有些注释块里带尖括号，留着会干扰后续的标签匹配。 */
function stripComments(text) {
    return String(text).replace(/<!--[\s\S]*?-->/g, "");
}

/** 取某个标签的全部出现；attrs 是开标签里的属性串（<peripheral derivedFrom="GPIOA">）。 */
function blocks(text, tagName) {
    const pattern = new RegExp("<" + tagName + "(\\s[^>]*)?>([\\s\\S]*?)</" + tagName + ">", "g");
    const found = [];
    for (const match of text.matchAll(pattern)) found.push({ attrs: match[1] ?? "", body: match[2] });
    return found;
}

/** 取标签的文本内容（第一个匹配），没有就是 null。 */
function tagText(text, name) {
    const match = new RegExp("<" + name + ">([^<]*)</" + name + ">").exec(text);
    return match === null ? null : match[1].trim();
}

/** 取属性值，没有就是 null。 */
function attrOf(attrs, name) {
    const match = new RegExp("(?:^|\\s)" + name + '="([^"]*)"').exec(attrs);
    return match === null ? null : match[1].trim();
}

/** 十六进制 / 十进制数字转 Number，认不出就是 null。 */
function numberOf(text) {
    if (text === null || text === undefined) return null;
    const raw = String(text).trim();
    if (raw === "") return null;
    const value = /^0x/i.test(raw) ? Number.parseInt(raw.slice(2), 16) : Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : null;
}

/** register 级 derivedFrom 写成 "GPIOA.ODR"，取最后一段（本外设里的寄存器名）。 */
function shortName(text) {
    const raw = String(text ?? "").trim();
    const dot = raw.lastIndexOf(".");
    return dot < 0 ? raw : raw.slice(dot + 1);
}

/** 地址：大写十六进制、补到 8 位（0x8000000 → 0x08000000），和链接脚本的写法一致。 */
export function normalizeAddress(value) {
    const number = numberOf(value);
    if (number === null) return null;
    return "0x" + number.toString(16).toUpperCase().padStart(8, "0");
}

/**
 * 偏移：大写十六进制、至少两位（SVD 里的 0xC → 0x0C，README 与验收都按这个写法）。
 * 不补到偶数位：0x100 得留成 0x100，补成 0x0100 就是另一个数了。
 */
export function normalizeOffset(value) {
    const number = numberOf(value);
    if (number === null) return null;
    const hex = number.toString(16).toUpperCase();
    return "0x" + (hex.length < 2 ? "0" + hex : hex);
}

/** 解析一个 <field>；位域定义不全（缺 name/bitOffset/bitWidth）就当没有。 */
function parseField(body) {
    const name = tagText(body, "name");
    const bitOffset = numberOf(tagText(body, "bitOffset"));
    const bitWidth = numberOf(tagText(body, "bitWidth"));
    if (name === null || bitOffset === null || bitWidth === null) return null;
    return { name, bitOffset, bitWidth };
}

/** 解析一个 <register>；派生信息留给后面统一展开。 */
function parseRegister(raw, defaultSize) {
    const name = tagText(raw.body, "name");
    if (name === null) return null;
    const addressOffset = normalizeOffset(tagText(raw.body, "addressOffset"));
    if (addressOffset === null) return null;
    const size = numberOf(tagText(raw.body, "size")) ?? defaultSize;
    const access = tagText(raw.body, "access");
    const fields = blocks(raw.body, "field")
        .map((field) => parseField(field.body))
        .filter((field) => field !== null);
    return {
        name,
        addressOffset,
        size,
        access,
        derivedFrom: attrOf(raw.attrs, "derivedFrom"),
        fields,
    };
}

/**
 * register 级的 derivedFrom 展开：本外设里先找同名寄存器，找不到就报错。
 * STM32F1 的 SVD 里目前没有这种写法，留着是为了换一份 SVD 时不至于静默丢寄存器。
 */
function resolveRegisterDerivation(registers, peripheralName) {
    const byName = new Map();
    for (const register of registers) byName.set(register.name, register);
    return registers.map((register) => {
        if (register.fields.length > 0 || register.derivedFrom === null) {
            return { name: register.name, addressOffset: register.addressOffset, size: register.size, access: register.access, fields: register.fields };
        }
        const base = byName.get(shortName(register.derivedFrom));
        if (base === undefined) {
            throw new Error("SVD 里 " + peripheralName + "." + register.name + " 派生自不存在的寄存器 " + register.derivedFrom);
        }
        return { name: register.name, addressOffset: register.addressOffset, size: register.size, access: register.access, fields: base.fields };
    });
}

/**
 * peripheral 级 derivedFrom 展开（SVD 里 GPIOB..G / DMA2 / TIM3..5 / USART2..3 都是这么写的：
 * 只给 baseAddress，寄存器全在基外设里）。带环检测，成环直接报错而不是死循环。
 */
function resolvePeripheralDerivation(list) {
    const byName = new Map();
    for (const item of list) byName.set(item.name, item);
    const done = new Map();
    const resolving = new Set();
    const resolve = (item) => {
        if (done.has(item.name)) return done.get(item.name);
        if (resolving.has(item.name)) {
            throw new Error("SVD 里 peripheral 的 derivedFrom 成环：" + Array.from(resolving).join(" → ") + " → " + item.name);
        }
        resolving.add(item.name);
        let registers = item.registers;
        if (registers.length === 0 && item.derivedFrom !== null) {
            const base = byName.get(shortName(item.derivedFrom));
            if (base === undefined) {
                throw new Error("SVD 里外设 " + item.name + " 派生自不存在的 " + item.derivedFrom);
            }
            registers = resolve(base);
        }
        const resolved = resolveRegisterDerivation(registers, item.name);
        resolving.delete(item.name);
        done.set(item.name, resolved);
        return resolved;
    };
    return list.map((item) => ({
        name: item.name,
        baseAddress: item.baseAddress,
        derivedFrom: item.derivedFrom,
        registers: resolve(item),
    }));
}

/**
 * 解析 SVD 文本 → { deviceName, deviceVersion, addressUnitBits, peripherals }。
 * peripherals 里的寄存器已经是展开过的（每个外设都自带完整寄存器表）。
 */
export function parseSvd(rawText) {
    const raw = stripComments(rawText);
    const peripheralsAt = raw.indexOf("<peripherals");
    const peripheralsEnd = raw.indexOf("</peripherals>");
    if (peripheralsAt < 0 || peripheralsEnd < 0) throw new Error("SVD 里没有 <peripherals> 段（文件不对？）");
    const head = raw.slice(0, peripheralsAt);
    const deviceName = tagText(head, "name") ?? "";
    const deviceVersion = tagText(head, "version") ?? "";
    const addressUnitBits = numberOf(tagText(head, "addressUnitBits")) ?? 8;
    const defaultSize = numberOf(tagText(head, "size")) ?? 32;
    const section = raw.slice(peripheralsAt, peripheralsEnd);
    const list = [];
    for (const peripheral of blocks(section, "peripheral")) {
        const name = tagText(peripheral.body, "name");
        if (name === null) continue;
        const baseAddress = normalizeAddress(tagText(peripheral.body, "baseAddress"));
        const registers = blocks(peripheral.body, "register")
            .map((register) => parseRegister(register, defaultSize))
            .filter((register) => register !== null);
        list.push({ name, baseAddress, derivedFrom: attrOf(peripheral.attrs, "derivedFrom"), registers });
    }
    if (list.length === 0) throw new Error("SVD 里一个外设都没解析出来（文件不对？）");
    // 中断表：ARM SVD 里是顶层 <interrupt><name/><value/></interrupt>，R20 规则要它。
    const interrupts = blocks(raw, "interrupt")
        .map((item) => {
            const name = tagText(item.body, "name");
            const value = numberOf(tagText(item.body, "value"));
            return name === null || value === null ? null : { name, value };
        })
        .filter((item) => item !== null);
    return { deviceName, deviceVersion, addressUnitBits, interrupts, peripherals: resolvePeripheralDerivation(list) };
}

/** 输出前把内部字段（derivedFrom）摘掉，只留消费方该看到的。 */
export function sanitizePeripheral(peripheral) {
    return {
        name: peripheral.name,
        baseAddress: peripheral.baseAddress,
        registers: peripheral.registers.map((register) => {
            const out = { name: register.name, addressOffset: register.addressOffset, size: register.size };
            if (typeof register.access === "string" && register.access.length > 0) out.access = register.access;
            out.fields = register.fields.map((field) => ({ name: field.name, bitOffset: field.bitOffset, bitWidth: field.bitWidth }));
            return out;
        }),
    };
}

/** 统计条数（manifest 与文件头都用它，两处口径一致）。 */
export function svdCounts(peripherals) {
    let registers = 0;
    let fields = 0;
    for (const peripheral of peripherals) {
        registers += peripheral.registers.length;
        for (const register of peripheral.registers) fields += register.fields.length;
    }
    return { peripherals: peripherals.length, registers, fields };
}

/** 单个值渲染成一行 JSON：对象/数组用 ", " 与 ": " 分隔，长行也还能读。 */
function inlineJson(value) {
    if (Array.isArray(value)) return "[" + value.map(inlineJson).join(", ") + "]";
    if (value !== null && typeof value === "object") {
        const pairs = [];
        for (const key of Object.keys(value)) {
            const item = value[key];
            if (item === undefined || item === null) continue;
            pairs.push(JSON.stringify(key) + ": " + inlineJson(item));
        }
        return "{" + pairs.join(", ") + "}";
    }
    return JSON.stringify(value);
}

/** 把一个多行 JSON 块整体缩进 n 格（顶层 source / notes 用）。 */
function indentBlock(text, spaces) {
    return text.split("\n").join("\n" + " ".repeat(spaces));
}

/**
 * 渲染成文件文本：一个寄存器一行。
 * 一行一个寄存器是刻意的：--check 报差异时能指出「哪个外设的哪个寄存器变了」，
 * 而且 git diff 不会因为整表重排而炸开。
 */
export function renderSvdDoc(doc) {
    const lines = [];
    lines.push("{");
    lines.push('  "schema": 2,');
    lines.push('  "family": "STM32F1",');
    lines.push('  "line": ' + JSON.stringify(String(doc.line)) + ",");
    lines.push('  "device": ' + JSON.stringify(doc.source?.file?.replace(/\.svd$/u, "") ?? "") + ",");
    lines.push('  "sizeUnit": "bits",');
    lines.push('  "addressUnitBits": ' + JSON.stringify(doc.addressUnitBits) + ",");
    lines.push('  "source": ' + indentBlock(JSON.stringify(doc.source, null, 2), 2) + ",");
    lines.push('  "notes": ' + indentBlock(JSON.stringify(doc.notes, null, 2), 2) + ",");
    lines.push('  "counts": ' + inlineJson(svdCounts(doc.peripherals)) + ",");
    const interrupts = doc.interrupts ?? [];
    if (interrupts.length === 0) {
        lines.push('  "interrupts": [],');
    } else {
        lines.push('  "interrupts": [');
        interrupts.forEach((item, index) => {
            lines.push("    " + inlineJson(item) + (index === interrupts.length - 1 ? "" : ","));
        });
        lines.push("  ],");
    }
    lines.push('  "peripherals": [');
    doc.peripherals.forEach((peripheral, index) => {
        lines.push("    {");
        lines.push('      "name": ' + JSON.stringify(peripheral.name) + ",");
        lines.push('      "baseAddress": ' + JSON.stringify(peripheral.baseAddress) + ",");
        if (peripheral.registers.length === 0) {
            lines.push('      "registers": []');
        } else {
            lines.push('      "registers": [');
            peripheral.registers.forEach((register, registerIndex) => {
                lines.push("        " + inlineJson(register) + (registerIndex === peripheral.registers.length - 1 ? "" : ","));
            });
            lines.push("      ]");
        }
        lines.push("    }" + (index === doc.peripherals.length - 1 ? "" : ","));
    });
    lines.push("  ]");
    lines.push("}");
    lines.push("");
    return lines.join("\n");
}

/**
 * 组装最终的 doc（不含渲染）：调用方决定 source 与 notes（都按 line 给）。
 * svdText 可以是 SVD 原文，也可以是「已经解析好的 peripherals」（测试/离线诊断用）。
 */
export function buildSvdDoc(input) {
    const parsed = Array.isArray(input.peripherals)
        ? { deviceName: input.deviceName ?? "", deviceVersion: input.deviceVersion ?? "", addressUnitBits: input.addressUnitBits ?? 8, peripherals: input.peripherals, interrupts: input.interrupts ?? [] }
        : parseSvd(input.svdText);
    return {
        schema: 2,
        family: "STM32F1",
        line: String(input.line),
        sizeUnit: "bits",
        addressUnitBits: parsed.addressUnitBits,
        interrupts: parsed.interrupts ?? [],
        source: input.source,
        notes: input.notes,
        peripherals: parsed.peripherals.map(sanitizePeripheral),
    };
}
