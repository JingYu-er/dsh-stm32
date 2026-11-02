/**
 * L2：\`.ioc\` 变更事务 —— plan（只读算 diff）→ 人确认 → apply（备份 + 原子替换）→ 可回滚。
 *
 * 设计要点（规格 §3 I3、§8、§11 A8）：
 * - 插件**永远不静默改 \`.ioc\`**：plan 只算、不写源文件；apply 必须带 planId，且源文件 SHA-256
 *   与 plan 时一致，否则拒绝（防止"plan 之后你自己又用 CubeMX GUI 改过"）。
 * - plan 的候选文件先落在 \`.dsh-stm32/plans/<planId>.ioc\`，apply 前重新核对它的 SHA-256，
 *   保证"确认的那份"就是"写进去的那份"。
 * - apply 前再跑一遍安全校验（Serial Wire 在、KeepUserCode 开），是第二道闸：plan 通过之后
 *   候选文件也可能被人手改过。
 * - 覆盖前一律备份到 \`.dsh-stm32/backups/<时间戳>/<原文件名>\`，回滚就是把备份写回去。
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { findIocFile, STATE_DIR } from "./generate.js";
import { decodeIocKey, iocLogicalLines, parseIocEntries, summarizeIoc } from "./ioc.js";
import { CORE_EXCEPTIONS, checkIocRules, extiIrqName } from "./ioc-rules.js";
import { findPeripheralPreset, peripheralPresetNames, pinDbName } from "../data/ioc-presets.js";
import { iocSchemaCoverage, renderIocKey } from "../data/ioc-schema.js";
import { locateCubemxDb, readMcuFacts, resolveDbPinName } from "./cubemx-db.js";
import { loadSvdForLine, svdLineForChip } from "../data/svd.js";
import { resolveSearchConfig } from "../data/search-roots.js";
import { emptyClockPlan, formatHz, planClock } from "./clock-plan.js";
import { isKnownPin } from "../data/chips.js";
export function sha256Hex(text) {
    return createHash("sha256").update(text, "utf8").digest("hex");
}
/**
 * 写回时的转义。值里要转义 "\\"、":"（NVIC 的 true\:0…）和 "#"
 * （ADC1.IPParameters=Rank-0\#ChannelRegularConversion 是 CubeMX 自己的写法）。
 */
export function encodeIocValue(value) {
    const escaped = value.replace(/\\/gu, "\\\\").replace(/:/gu, "\\:").replace(/#/gu, "\\#");
    // java.util.Properties#store 对**值开头的空格**也转义（`case ' ': if (x == 0 || escapeSpace) outBuffer.append('\\')`）：
    // 不转义的话读回来前导空白会被 properties 语法吃掉（GPIO_Label=" led" 就变成 "led"）。
    return escaped.replace(/^ +/u, (run) => run.replace(/ /gu, "\\ "));
}
/**
 * 键名里的转义。键里出现空格/括号时**必须**转义：.ioc 走 java properties 语义，
 * 未转义的空格会把键截断，于是 "TIM2.Channel-PWM Generation1 CH1" 变成
 * "TIM2.Channel-PWM" —— CubeMX 读不到，通道配置静默失效。
 */
export function encodeIocKey(key) {
    return key.replace(/\\/gu, "\\\\").replace(/ /gu, "\\ ").replace(/#/gu, "\\#").replace(/:/gu, "\\:");
}
function splitLines(text) {
    return text.split(/\r?\n/u);
}
function dominantEol(text) {
    return text.includes("\r\n") ? "\r\n" : "\n";
}
/**
 * .ioc 的键排序：**纯字典序**，与 CubeMX 落盘完全一致。
 *
 * 依据（jar.md「落盘」一节）：CubeMX 走 mxsystem.ProjectFactory#saveConfigFile →
 * db.DbConfProperties#store → com.st.components.util.SortedProperties（就是 java.util.Properties），
 * 而 java.util.Properties 写盘前对键做 Collections.sort → String.compareTo，
 * 也就是按 **UTF-16 码元**逐字符比。JS 的 `<` 比较同样是码元序，所以直接比字符串即可。
 * 语料 504 份板级 .ioc 实测：6.x 的 266 份里 261 份（98.1%）是这种序。
 *
 * 以前这里按"数字段比数值"排（Mcu.Pin2 在 Mcu.Pin10 之前），是我们自己的审美：
 * 键数一过 10 就和 CubeMX 的写法错位，用户拿我们的 .ioc 跟 CubeMX 另存的 diff 时满屏挪行。
 */
export function compareIocKeys(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
/** 一行对应的（解码后的）键；注释行、空行、没有 "=" 的垃圾行返回空串。 */
function lineKey(line) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#"))
        return "";
    const eq = trimmed.indexOf("=");
    if (eq <= 0)
        return "";
    return decodeIocKey(trimmed.slice(0, eq).trim());
}
export function inspectIocText(text) {
    const counts = new Map();
    const malformedLines = [];
    const multiLineKeys = new Set();
    for (const item of iocLogicalLines(text)) {
        const trimmed = item.line.trim();
        if (trimmed === "" || trimmed.startsWith("#"))
            continue;
        const eq = trimmed.indexOf("=");
        if (eq <= 0) {
            malformedLines.push(item.startIndex + 1);
            continue;
        }
        const key = decodeIocKey(trimmed.slice(0, eq).trim());
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (item.lineCount > 1)
            multiLineKeys.add(key);
    }
    const duplicates = new Map();
    for (const [key, count] of counts)
        if (count > 1)
            duplicates.set(key, count);
    return {
        duplicates,
        malformedLines,
        multiLineKeys,
        mixedEol: text.includes("\r\n") && text.replace(/\r\n/gu, "").includes("\n"),
        finalNewline: /(\r?\n)$/u.test(text),
    };
}
/**
 * 读 .ioc：只接受 UTF-8（与 CubeMX 一致），别的编码直接报错。
 *
 * 为什么不做「猜编码」：CubeMX 写的是 UTF-8；文件被中文编辑器另存成 GBK 时，
 * 按 UTF-8 解码会得到一堆替换字符，写回去就把整份工程改坏了。
 * 这里用 fatal 解码器，宁可拒绝也不静默乱码。
 * BOM 用 ignoreBOM 保留在字符串里，写回时原样往返。
 */
export function readIocText(path) {
    const raw = readFileSync(path);
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    try {
        return decoder.decode(raw);
    }
    catch {
        throw new Error("不是合法的 UTF-8：" + path +
            "（多半是中文编辑器另存成了 GBK/ANSI）。请用 VS Code 以 UTF-8 另存后再改；" +
            "插件不会替你猜编码，以免把整份 .ioc 写坏");
    }
}
function buildLineTable(text) {
    const lines = splitLines(text);
    const index = new Map();
    lines.forEach((line, position) => {
        const key = lineKey(line);
        if (key === "")
            return;
        const list = index.get(key) ?? [];
        list.push(position);
        index.set(key, list);
    });
    return { lines, index, changedKeys: 0 };
}
/**
 * 把变更应用到 .ioc 文本上：已有键原地改、重复键只留第一条、新增键按 key 排序插入。
 *
 * 为什么是"插入"而不是"追加"：CubeMX 自己写盘时整个文件按 key 排序
 * （CAD.* → File.Version → GPIO.* → KeepUserPlacement → Mcu.* → MxCube.Version →
 * MxDb.Version → NVIC.* → 引脚键 → PinOutPanel.* → ProjectManager.* → RCC.* → SH.* →
 * VP_* → board）。以前新键一律追加到末尾，结果落在 Mcu.IPNb / Mcu.PinsNb 之后，
 * 谁看 diff 都对不上 CubeMX 的格式，也让人误以为键没写进去。
 */
export function renderIocText(text, changes) {
    const table = buildLineTable(text);
    const removed = new Set();
    const added = [];
    for (const change of changes) {
        const positions = table.index.get(change.key) ?? [];
        if (change.after === null) {
            for (const position of positions)
                removed.add(position);
            continue;
        }
        const line = encodeIocKey(change.key) + "=" + encodeIocValue(change.after);
        if (positions.length === 0) {
            added.push(change);
            continue;
        }
        const first = positions[0];
        table.lines[first] = line;
        table.changedKeys += 1;
        for (const position of positions.slice(1))
            removed.add(position);
    }
    if (added.length === 0 && removed.size === 0 && table.changedKeys === 0)
        return text;
    const eol = dominantEol(text);
    const out = [];
    table.lines.forEach((line, position) => {
        if (!removed.has(position))
            out.push({ key: lineKey(line), line });
    });
    // 新增键按 key 排序插到对应位置；末尾的空行是原文件的（可能是"文件末尾有换行"的表现），
    // 不能吃掉，新键要插在它们**之前**。
    let tail = out.length;
    while (tail > 0 && out[tail - 1].line.trim() === "")
        tail -= 1;
    added.sort((left, right) => compareIocKeys(left.key, right.key));
    for (const change of added) {
        const item = { key: change.key, line: encodeIocKey(change.key) + "=" + encodeIocValue(change.after) };
        let at = -1;
        for (let index = 0; index < tail; index += 1) {
            const key = out[index].key;
            if (key !== "" && compareIocKeys(key, change.key) > 0) {
                at = index;
                break;
            }
        }
        if (at < 0)
            at = tail;
        out.splice(at, 0, item);
        tail += 1;
    }
    // 按行 split 后，文件末尾有换行会多出一个空串，join 回去正好还原原文，所以不再补 eol。
    return out.map((item) => item.line).join(eol);
}
export function compareEntries(before, after) {
    const changes = [];
    const keys = new Set([...before.keys(), ...after.keys()]);
    for (const key of keys) {
        const old = before.get(key) ?? null;
        const next = after.get(key) ?? null;
        if (old === next)
            continue;
        changes.push({ key, before: old, after: next });
    }
    return changes.sort((left, right) => compareIocKeys(left.key, right.key));
}
const LABEL_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const PULL_VALUES = {
    none: "GPIO_NOPULL",
    up: "GPIO_PULLUP",
    down: "GPIO_PULLDOWN",
};
const SPEED_VALUES = {
    low: "GPIO_SPEED_FREQ_LOW",
    medium: "GPIO_SPEED_FREQ_MEDIUM",
    high: "GPIO_SPEED_FREQ_HIGH",
};
/** EXTI 触发边沿 → <pin>.GPIO_ModeDefaultEXTI 的值（语料 504 份里只有这三个 token）。 */
const EXTI_MODES = {
    rising: "GPIO_MODE_IT_RISING",
    falling: "GPIO_MODE_IT_FALLING",
    both: "GPIO_MODE_IT_RISING_FALLING",
};
/**
 * 引脚属性键写进 <pin>.GPIOParameters 的顺序。
 *
 * 这不是"我们觉得好看"的顺序，而是 CubeMX 6.15.0 回写时自己用的顺序——它把 GPIOParameters 当
 * 集合重新序列化，**无视我们写进去的排列**（所以排列只影响 diff 噪声，不影响功能）。
 *
 * 证据两条：
 * 1) 真机探针（2026-11-02，demo.ioc 副本 load+save）：写 `GPIO_Label,GPIO_PuPd,GPIO_ModeDefaultEXTI`
 *    回写成 `GPIO_PuPd,GPIO_Label,GPIO_ModeDefaultEXTI`；写 `GPIO_Label,PinState,GPIO_Mode`
 *    回写成 `PinState,GPIO_Label,GPIO_Mode`。
 * 2) 语料 266 份 MxCube.Version=6.x 板级 .ioc 的 11808 条 GPIOParameters 两两先后统计（0 反例）：
 *    GPIO_Speed < GPIO_PuPd(376/0)、GPIO_Speed < PinState(61/0)、PinState < GPIO_PuPd(54/0)、
 *    GPIO_PuPd < GPIO_Label(694/0)、GPIO_Label < GPIO_Mode(268/0)、
 *    GPIO_Label < GPIO_ModeDefaultEXTI(97/0)、GPIO_ModeDefaultEXTI < GPIO_PuPd→反(85/0)。
 *    合成全序：Speed → PinState → PuPd → Label → ModeDefault* → GPIO_Mode。
 */
const PIN_ATTRIBUTE_ORDER = [
    "GPIO_Speed", "PinState", "GPIO_PuPd", "GPIO_Label",
    "GPIO_ModeDefaultEXTI", "GPIO_ModeDefaultPP", "GPIO_ModeDefaultOutputPP", "GPIO_Mode",
];
/** 引脚号 = EXTI 线号（PA5 → 5）。非 GPIO 名返回 null。 */
function extiLineOf(pin) {
    const match = /^P[A-Z]([0-9]{1,2})(?:-|$)/u.exec(pin.trim().toUpperCase());
    if (match === null)
        return null;
    const line = Number.parseInt(match[1], 10);
    return line >= 0 && line <= 15 ? line : null;
}
/**
 * NVIC.<name>_IRQn 的 9 段值：Enable:Preempt:Sub:Configurable:System:IrqHandlerGenerated:…
 * 实测依据（6.15.0）：给非 DMA 外设打开中断后 CubeMX 自己写的就是 true:0:0:false:false:true:true:true:true。
 * DMA 通道是另一串（true:0:0:false:false:true:false:true:true），由 DMA 那段逻辑单独写。
 */
export function nvicIrqValue(preempt, sub) {
    return ["true", String(preempt), String(sub), "false", "false", "true", "true", "true", "true"].join(":");
}
/** RCC_ADCPCLK2_DIV2/4/6/8 → 2/4/6/8；认不出来返回 null（那就别动 ADCFreqValue）。 */
function adcPrescalerDiv(token) {
    const match = /^RCC_ADCPCLK2_DIV([2468])$/u.exec(token.trim());
    return match === null ? null : Number.parseInt(match[1], 10);
}
/**
 * DMA 请求参数的白名单顺序（CubeMX 按这个顺序把参数名写进
 * `Dma.<IP>.<n>.RequestParameters`）。F1 的 DMA 没有 FIFO，所以列到 Priority 为止；
 * 后面几个是 F4/H7 才有的字段，留在这里是为了让我们写到它们时顺序仍然对。
 * 实测依据：richhal.ioc:30（F1，8 个字段）与语料里 F4 的 9 字段版本（多一个 FIFOMode）。
 */
const DMA_PARAM_ORDER = [
    "Instance", "Direction", "PeriphInc", "MemInc", "PeriphDataAlignment", "MemDataAlignment",
    "Mode", "Priority", "FIFOMode", "SignalID", "Polarity", "RequestNumber",
];
function readPinTable(entries, errors, warnings) {
    const nbKey = renderIocKey("mcu.pins_nb");
    const count = Number.parseInt(entries.get(nbKey) ?? "0", 10);
    if (!Number.isFinite(count) || count < 0) {
        errors.push(nbKey + " 不是合法数字（" + (entries.get(nbKey) ?? "<缺失>") + "）");
        return { order: [], entries, errors, warnings };
    }
    const order = [];
    for (let position = 0; position < count; position += 1) {
        const indexKey = renderIocKey("mcu.pin_index", { index: position });
        const pin = entries.get(indexKey);
        if (pin === undefined) {
            errors.push(indexKey + " 缺失（" + nbKey + "=" + String(count) + " 但列表不连续）");
            continue;
        }
        order.push(pin);
    }
    return { order, entries, errors, warnings };
}
/** 两串引脚名是否完全一致（顺序也要一致）：没变就别重写 Mcu.PinN，保持原字节。 */
function samePinOrder(left, right) {
    if (left.length !== right.length)
        return false;
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index])
            return false;
    }
    return true;
}
/**
 * Mcu.Pin<i> 的排列规则（2026-11-02 真机确认，三次探针一致）：
 * **按 db 里 <Pin Position> 升序**，虚拟脚（VP_*）永远在最后。
 *
 * 证据：demo.ioc 原序 PC13-TAMPER-RTC(2), PC14-OSC32_IN(3), PC15-OSC32_OUT(4), PD0-OSC_IN(5),
 * PD1-OSC_OUT(6), PA13, PA14, VP_SYS_VS_Systick 正是 Position 序；我们追加 PA5/PA6/PA7/PA0 之后
 * CubeMX 回写成 PA0-WKUP(10), PA5(15), PA6(16), PA7(17)…PA13, PA14, VP_* —— 我们尾部追加的顺序被它重排。
 * db 不可用（没装 CubeMX / 查不到这根脚）时保持原序，只在末尾放 VP_*。
 */
function sortPinsByPosition(order, positionOf) {
    const keyed = order.map((pin, index) => {
        const position = positionOf(pin);
        // 分三档：已知 Position 的真实脚（1）→ db 里查不到的真实脚（2，保持原相对序）→ 虚拟脚（3，永远最后）。
        const bucket = pin.startsWith("VP_") ? 3 : position === null ? 2 : 1;
        const rank = position === null ? index : position;
        return { pin, index, bucket, rank };
    });
    keyed.sort((left, right) => {
        if (left.bucket !== right.bucket)
            return left.bucket - right.bucket;
        if (left.rank !== right.rank)
            return left.rank - right.rank;
        return left.index - right.index;
    });
    return keyed.map((item) => item.pin);
}
/** 把引脚列表整体重编号写回 entries（新增/删除都可能让下标变化，重写最稳）。 */
function writePinOrder(entries, order, positionOf) {
    const finalOrder = positionOf === undefined ? order : sortPinsByPosition(order, positionOf);
    const previous = Number.parseInt(entries.get(renderIocKey("mcu.pins_nb")) ?? "0", 10);
    const oldCount = Number.isFinite(previous) ? previous : 0;
    finalOrder.forEach((pin, position) => {
        entries.set(renderIocKey("mcu.pin_index", { index: position }), pin);
    });
    for (let position = finalOrder.length; position < oldCount; position += 1) {
        entries.delete(renderIocKey("mcu.pin_index", { index: position }));
    }
    entries.set(renderIocKey("mcu.pins_nb"), String(finalOrder.length));
}
/**
 * 引脚属性名 → schema spec id。属性键必须登记在 src/data/ioc-schema.ts 里，
 * 否则覆盖率检查会把它当未知键报出来（这正是我们要的保护：拼错的名字会被抓到）。
 */
const PIN_ATTRIBUTE_SPEC = {
    "GPIO_Label": "pin.gpio_label",
    "GPIO_Speed": "pin.gpio_speed",
    "GPIO_PuPd": "pin.gpio_pupd",
    "PinState": "pin.pin_state",
    "GPIO_Mode": "pin.gpio_mode",
    "GPIO_ModeDefaultEXTI": "pin.gpio_mode_default_exti",
    "GPIO_ModeDefaultPP": "pin.gpio_mode_default_pp",
    "GPIO_ModeDefaultOutputPP": "pin.gpio_mode_default_output_pp",
};
function attributeSpecId(name) {
    const id = PIN_ATTRIBUTE_SPEC[name];
    if (id === undefined)
        throw new Error("ioc-plan: 引脚属性 " + name + " 没有登记 schema spec id");
    return id;
}
function addPin(table, request) {
    const pin = request.pin.trim();
    if (pin === "") {
        table.errors.push("pins 里有空引脚名");
        return;
    }
    if (table.order.includes(pin)) {
        table.errors.push("引脚 " + pin + " 已经在 .ioc 里配置过了（要改请用 entries 直接设置对应键）");
        return;
    }
    if (!isKnownPin(pin)) {
        table.errors.push("引脚名 " + pin + " 不是合法的 STM32 GPIO 引脚（形如 PA0..PG15，或 VP_ 开头的虚拟引脚）；" +
            "插件不再内置引脚表，这个封装到底有没有这根脚请用 stm32_doctor 对着本机 CubeMX db 校验");
        return;
    }
    const label = (request.label ?? "").trim();
    if (label !== "" && !LABEL_PATTERN.test(label)) {
        table.errors.push("标签 " + JSON.stringify(label) + " 不是合法 C 标识符（会生成 " + label + "_Pin 变量）");
        return;
    }
    if (label !== "") {
        for (const [key, value] of table.entries) {
            if (!key.endsWith(".GPIO_Label"))
                continue;
            if (value === label) {
                table.errors.push("标签 " + label + " 已被 " + key.slice(0, key.length - ".GPIO_Label".length) + " 占用，生成的 C 变量会重名");
                return;
            }
        }
    }
    const exti = request.interrupt;
    const line = exti === undefined ? null : extiLineOf(pin);
    if (exti !== undefined && line === null) {
        table.errors.push("引脚 " + pin + " 不能做 EXTI（EXTI 线号取引脚号 0–15，虚拟引脚没有线号）");
        return;
    }
    const signal = exti === undefined
        ? (request.signal === "input" ? "GPIO_Input" : "GPIO_Output")
        : "GPXTI" + String(line);
    const pull = request.pull === undefined ? "none" : request.pull;
    const speed = request.speed === undefined ? "low" : request.speed;
    // S1/S2：CubeMX 只写「非默认」的 GPIO 属性 —— 默认（无上下拉、低速、输出推挽、初始低电平）时这些键
    // 根本不出现。语料 504 份 .ioc 实测：GPIO 输出脚最常见的 GPIOParameters 就是单独一个 GPIO_Label
    // （14,357 次），75.2% 的输出脚连 Speed/PuPd 都没有；三个名字无条件全写等于每个脚自造 2–3 处伪 diff。
    //
    // 2026-11-02 真机（6.15.0）补充两条：
    // - 写在引脚上的 GPIO_* 属性键，只有同时列进 <pin>.GPIOParameters 才会被保留，
    //   否则 CubeMX 静默删掉（实测 PC13-TAMPER-RTC.PinState 就是这样丢的）；
    // - GPIO_Mode / PinState 的值它不规范化，写什么回写什么（GPIO_MODE_OUTPUT_OD / GPIO_PIN_SET 都逐字保留），
    //   所以能不能表达开漏、初始电平只取决于我们写不写这两个键。
    const attributes = new Map();
    if (label !== "")
        attributes.set("GPIO_Label", label);
    if (speed !== "low")
        attributes.set("GPIO_Speed", SPEED_VALUES[speed]);
    if (pull !== "none")
        attributes.set("GPIO_PuPd", PULL_VALUES[pull]);
    if (exti !== undefined) {
        attributes.set("GPIO_ModeDefaultEXTI", EXTI_MODES[exti]);
    }
    else {
        if (request.initial === "high")
            attributes.set("PinState", "GPIO_PIN_SET");
        if (request.signal !== "input" && request.outputType === "od") {
            attributes.set("GPIO_Mode", "GPIO_MODE_OUTPUT_OD");
        }
    }
    const parameters = PIN_ATTRIBUTE_ORDER.filter((name) => attributes.has(name));
    if (parameters.length > 0)
        table.entries.set(renderIocKey("pin.gpio_parameters", { pin }), parameters.join(","));
    else
        table.entries.delete(renderIocKey("pin.gpio_parameters", { pin }));
    for (const name of PIN_ATTRIBUTE_ORDER) {
        const key = renderIocKey(attributeSpecId(name), { pin });
        if (attributes.has(name))
            table.entries.set(key, attributes.get(name));
        else
            table.entries.delete(key);
    }
    table.entries.set(renderIocKey("pin.locked", { pin }), "true");
    table.entries.set(renderIocKey("pin.signal", { pin }), signal);
    // EXTI 引脚在 CubeMX 的 .ioc 里没有 .Mode（模式由 GPIO_ModeDefaultEXTI + SH 块表达）。
    if (exti !== undefined)
        table.entries.delete(renderIocKey("pin.mode", { pin }));
    if (exti !== undefined && line !== null) {
        enableExtiSharedLine(table, line);
        // extiIrqName() 已经带 _IRQn 后缀，而 spec 模板是 NVIC.{name}_IRQn → 这里去掉后缀再渲染。
        const irqKey = renderIocKey("nvic.vector", { name: extiIrqName(line).replace(/_IRQn$/u, "") });
        if (!table.entries.has(irqKey))
            table.entries.set(irqKey, nvicIrqValue(0, 0));
        if (pull === "none") {
            table.warnings.push("EXTI 引脚 " + pin + " 没有上/下拉：边沿触发时悬空会乱触发（常见做法是 pull=up 配 falling）");
        }
    }
    if (signal === "GPIO_Input" && pull === "none") {
        table.warnings.push("引脚 " + pin + " 配成输入但没有上/下拉：悬空时读数会乱（常见做法是 pull=up）");
    }
    table.order.push(pin);
}
/** 确保 Serial Wire 调试口：PA13/PA14 用调试信号，同时清掉 VP_SYS_VS_ND（No_Debug）残留。 */
function ensureSerialWire(table) {
    const noDebugPins = table.order.filter((pin) => pin === "VP_SYS_VS_ND");
    for (const pin of noDebugPins) {
        table.order = table.order.filter((item) => item !== pin);
        for (const key of [...table.entries.keys()]) {
            if (key === pin || key.startsWith(pin + "."))
                table.entries.delete(key);
        }
        table.warnings.push("已删除 " + pin + "（No_Debug 会让 CubeMX 生成 __HAL_AFIO_REMAP_SWJ_DISABLE()）");
    }
    const debugPins = [
        { pin: "PA13", signal: "SYS_JTMS-SWDIO" },
        { pin: "PA14", signal: "SYS_JTCK-SWCLK" },
    ];
    for (const item of debugPins) {
        if (!table.order.includes(item.pin)) {
            table.order.push(item.pin);
            table.entries.set(renderIocKey("pin.locked", { pin: item.pin }), "true");
        }
        table.entries.set(renderIocKey("pin.mode", { pin: item.pin }), "Serial_Wire");
        table.entries.set(renderIocKey("pin.signal", { pin: item.pin }), item.signal);
    }
}
/** 解析 "USART1" / "USART1_IRQn" / "EXTI9_5:2:0" → { irq, preempt?, sub? }。 */
function parseInterruptText(text) {
    const parts = text.split(":");
    const irq = (parts[0] ?? "").trim();
    const preempt = parts.length > 1 ? Number.parseInt((parts[1] ?? "").trim(), 10) : undefined;
    const sub = parts.length > 2 ? Number.parseInt((parts[2] ?? "").trim(), 10) : undefined;
    return {
        irq,
        ...(preempt === undefined || Number.isNaN(preempt) ? {} : { preempt }),
        ...(sub === undefined || Number.isNaN(sub) ? {} : { sub }),
    };
}
/**
 * 打开中断：写 NVIC.<名字>_IRQn。
 *
 * 为什么值得单开一个参数：C1 —— 以前"启用 USART1"只写 Mcu.IPn + 引脚 + IPParameters，
 * 中断一个都不写，用户还得自己去 entries 里手拼 9 段；拼错第一段位置（true/false）CubeMX 会
 * 按默认值覆盖，而且不报错。名字先按「db 外设实例 / SVD 中断表 / Cortex-M 内核异常」校验，
 * 查不到就报错——写一条没人认的 NVIC 键，生成代码里不会有任何使能，等于白写。
 */
function applyInterrupts(table, requests, context, notes) {
    for (const item of requests) {
        // 字符串形式允许内联优先级："USART1:2:0"（preempt:sub）；对象形式直接给字段。
        const request = typeof item === "string" ? parseInterruptText(item) : item;
        const raw = request.irq.trim();
        if (raw === "") {
            table.errors.push("interrupts 里有空的中断名");
            continue;
        }
        const name = raw.replace(/_IRQn$/iu, "");
        if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(name)) {
            table.errors.push("中断名 " + JSON.stringify(raw) + " 不是合法标识符（例：USART1 / EXTI9_5 / SysTick）");
            continue;
        }
        const inIps = context.facts !== null && context.facts.ips.has(name.toUpperCase());
        const inSvd = context.interrupts !== null && context.interrupts.has(name);
        // EXTI 线是按线号分组的（EXTI0…EXTI4 / EXTI9_5 / EXTI15_10），SVD 里就叫这么个名字，
        // 但它不是外设实例，db 里查不到；写 pins 的 interrupt 时也是同一个名字来源，所以直接放行。
        const isExtiGroup = /^EXTI[0-9]+(?:_[0-9]+)?$/u.test(name);
        if (!CORE_EXCEPTIONS.has(name) && !inIps && !inSvd && !isExtiGroup) {
            if (context.interrupts === null && context.facts === null) {
                table.warnings.push("中断名 " + name + " 没法校验：本机既没有 CubeMX db 也没有 SVD 中断表");
            }
            else {
                table.errors.push("中断名 " + name + " 既不在本机 CubeMX db 的外设实例里，也不在 SVD 的中断表里：".concat("CubeMX 会忽略 NVIC.", name, "_IRQn，生成代码里不会有这个中断"));
                continue;
            }
        }
        const preempt = request.preempt ?? 0;
        const sub = request.sub ?? 0;
        if (!Number.isInteger(preempt) || preempt < 0 || preempt > 15) {
            table.errors.push("中断 " + name + " 的 preempt 必须是 0–15 的整数（F1 的 NVIC 只有 4 位）");
            continue;
        }
        if (!Number.isInteger(sub) || sub < 0 || sub > 15) {
            table.errors.push("中断 " + name + " 的 sub 必须是 0–15 的整数");
            continue;
        }
        const key = renderIocKey("nvic.vector", { name });
        const existing = table.entries.get(key);
        if (existing !== undefined && request.preempt === undefined && request.sub === undefined) {
            notes.push(key + " 已存在（" + existing + "），保留原值；要改优先级请显式传 preempt/sub");
            continue;
        }
        table.entries.set(key, nvicIrqValue(preempt, sub));
        notes.push("已打开中断 " + key + " = " + nvicIrqValue(preempt, sub));
    }
}
/**
 * 写共享信号块：`SH.<key>.<n>=<IP 信号>,<IP 模式>` + `SH.<key>.ConfNb=<条数>`。
 *
 * 2026-10-31 实测（C8T6 + CubeMX 6.15.0）：定时器与 ADC 的引脚在 .ioc 里是共享信号
 * （`PA0-WKUP.Signal=S_TIM2_CH1_ETR`、`PA1.Signal=ADCx_IN1`），CubeMX 靠
 * `SH.S_TIM2_CH1_ETR.0=TIM2_CH1,PWM Generation1 CH1` 才能把「这根脚 → TIM2 CH1 PWM」
 * 这件事还原出来。只写引脚 Signal + <ip>.IPParameters 时，TIM2/TIM3/TIM4/ADC1 全被
 * 静默丢弃（生成结果里没有 MX_xxx_Init，日志里也没有任何报错）。
 */
function enableSharedSignal(table, shared) {
    const value = shared.ipSignal + "," + shared.ipMode;
    const confKey = renderIocKey("shared_signal.conf_nb", { signal: shared.key });
    const declared = Number.parseInt(table.entries.get(confKey) ?? "", 10);
    const count = Number.isFinite(declared) ? declared : 0;
    for (let index = 0; index < count; index += 1) {
        if ((table.entries.get(renderIocKey("shared_signal.slot", { signal: shared.key, n: index })) ?? "").trim() === value)
            return;
    }
    table.entries.set(renderIocKey("shared_signal.slot", { signal: shared.key, n: count }), value);
    table.entries.set(confKey, String(count + 1));
}
export function createPinNameResolver(options) {
    const roots = options.cubeMxRoots !== undefined
        ? [...options.cubeMxRoots]
        : resolveSearchConfig(options.env ?? process.env, {}).cubeMxRoots;
    const mcuName = options.mcuName.trim();
    let facts = null;
    let dbVersion = "";
    if (mcuName !== "") {
        const db = locateCubemxDb(roots);
        if (db !== null) {
            facts = readMcuFacts(db, mcuName);
            if (facts !== null)
                dbVersion = db.version;
        }
    }
    const hit = facts;
    if (hit !== null) {
        return {
            resolve: (logical) => resolveDbPinName(hit, logical) ?? logical,
            db: locateCubemxDb(roots),
            facts: hit,
            describe: () => "引脚名按本机 CubeMX db 解析（" + hit.name + "，" + dbVersion + "）",
            warning: () => "",
        };
    }
    return {
        resolve: (logical) => pinDbName(options.family, logical),
        db: null,
        facts: null,
        describe: () => "引脚名按内置别名表解析（本机没有可用的 CubeMX db：Mcu.Name=" + (mcuName === "" ? "（空）" : mcuName) + "）",
        warning: () => "没找到 CubeMX 的 db/mcu/" + (mcuName === "" ? "<Mcu.Name>" : mcuName) + ".xml（找过 " +
            (roots.length === 0 ? "（无候选目录）" : roots.join("、")) +
            "），引脚名退回内置别名表：只覆盖 F1 的 6 根带后缀的脚，db 里换过名的话会写错脚",
    };
}
/**
 * EXTI 的共享信号块：`SH.GPXTI<line>.0=GPIO_EXTI<line>` + `SH.GPXTI<line>.ConfNb=1`。
 *
 * 和定时器/ADC 的 SH 块同一个机制，但值不带「,<模式>」（EXTI 没有多模式）：
 * 语料里的实物形态是 SH.GPXTI13.0=GPIO_EXTI13、SH.GPXTI13.ConfNb=1；
 * 实测 6.15.0 回写时逐字保留、不会补别的键。
 */
function enableExtiSharedLine(table, line) {
    const signal = "GPXTI" + String(line);
    const value = "GPIO_EXTI" + String(line);
    const confKey = renderIocKey("shared_signal.conf_nb", { signal });
    const declared = Number.parseInt(table.entries.get(confKey) ?? "", 10);
    const count = Number.isFinite(declared) ? declared : 0;
    for (let index = 0; index < count; index += 1) {
        if ((table.entries.get(renderIocKey("shared_signal.slot", { signal, n: index })) ?? "").trim() === value)
            return;
    }
    table.entries.set(renderIocKey("shared_signal.slot", { signal, n: count }), value);
    table.entries.set(confKey, String(count + 1));
}
function enablePeripheral(table, request, pinNames, notes) {
    const preset = findPeripheralPreset(request.name);
    if (preset === null) {
        table.errors.push("不认识的外设预设 " + JSON.stringify(request.name) + "；内置：" + peripheralPresetNames().join("、") +
            "（要配别的请直接用 entries 逐键写，键集可参考官方板级 .ioc）");
        return;
    }
    // Mcu.IPn：占了槽位就把 IPNb 按实际条数重算。
    const used = new Set();
    let slots = 0;
    for (const [key, value] of table.entries) {
        if (!/^Mcu\.IP\d+$/u.test(key))
            continue;
        slots += 1;
        used.add(value.trim());
    }
    if (!used.has(preset.ip)) {
        table.entries.set(renderIocKey("mcu.ip_index", { index: slots }), preset.ip);
        slots += 1;
    }
    table.entries.set(renderIocKey("mcu.ip_nb"), String(slots));
    // 引脚：Mode + Signal + Locked。
    const overrodePins = request.pins !== undefined && Object.keys(request.pins).length > 0;
    for (const role of preset.pins) {
        const logical = (request.pins?.[role.role] ?? role.defaultPin).trim().toUpperCase();
        if (logical === "") {
            table.errors.push(preset.name + " 的引脚 " + role.role + " 被指定成空串");
            continue;
        }
        if (!isKnownPin(logical)) {
            table.errors.push("引脚名 " + logical + " 不是合法的 STM32 GPIO 引脚（形如 PA0..PG15）");
            continue;
        }
        const dbName = pinNames.resolve(logical);
        const existingSignal = (table.entries.get(renderIocKey("pin.signal", { pin: dbName })) ?? "").trim();
        if (table.order.includes(dbName) && existingSignal !== "" && existingSignal !== role.signal) {
            table.errors.push(preset.name + " 想用 " + dbName + " 做 " + role.signal + "，但这根脚已经配成 " + existingSignal +
                "（同一根脚不能同时做两件事，换引脚请传 pins）");
            continue;
        }
        if (!table.order.includes(dbName))
            table.order.push(dbName);
        table.entries.set(renderIocKey("pin.locked", { pin: dbName }), "true");
        table.entries.set(renderIocKey("pin.signal", { pin: dbName }), role.signal);
        if (role.shared === undefined) {
            if (role.mode !== "")
                table.entries.set(renderIocKey("pin.mode", { pin: dbName }), role.mode);
        }
        else {
            // 共享信号引脚：CubeMX 自己的 .ioc 里不带 .Mode，功能由 SH 块表达。
            table.entries.delete(renderIocKey("pin.mode", { pin: dbName }));
            enableSharedSignal(table, role.shared);
        }
    }
    // 逐字键（DMA 这类键名不受 <ip>.<名字> 约束）：先写它们，再统一重算 Dma.RequestsNb。
    for (const raw of preset.rawEntries ?? []) {
        table.entries.set(raw.key, request.parameters?.[raw.key.replace("Dma.", "").replace(/\.0\./u, ".")] ?? raw.value);
    }
    // G1/G2：DMA 三件套。CubeMX 自己写的是
    //   Dma.<IP>.<n>.RequestParameters=Instance,Direction,...,Priority（白名单，与 IPParameters 同机制：
    //   不在名单里的字段会被静默忽略）
    //   Dma.Request<i>=<IP>（把请求号绑回实例；只有 RequestsNb 时它只是个孤立计数）
    //   语料 504 份里含 DMA 的 17 份全部三件套齐全，richhal.ioc:30-32 是 F1 的实物证据；
    //   另有 64/64 的 Dma.Request<i> 值等于同号 Dma.<IP>.<n> 的 IP 名，且 RequestParameters 列出的
    //   名字与真的写了的键一一对应（0 处不符）。
    const dmaGroups = new Map();
    for (const key of table.entries.keys()) {
        const match = /^Dma\.([A-Za-z0-9_]+)\.([0-9]+)\.([A-Za-z0-9_]+)$/u.exec(key);
        if (match === null)
            continue;
        if (match[3] === "RequestParameters")
            continue;
        dmaGroups.set(match[1] + "." + match[2], { ip: match[1] });
    }
    if (dmaGroups.size > 0 || (preset.rawEntries ?? []).some((raw) => raw.key.startsWith("Dma."))) {
        let request = 0;
        for (const [group, info] of dmaGroups) {
            const prefix = "Dma." + group + ".";
            const present = [];
            for (const key of table.entries.keys()) {
                if (!key.startsWith(prefix))
                    continue;
                const name = key.slice(prefix.length);
                if (name === "RequestParameters" || name.includes("."))
                    continue;
                present.push(name);
            }
            present.sort((left, right) => {
                const a = DMA_PARAM_ORDER.indexOf(left);
                const b = DMA_PARAM_ORDER.indexOf(right);
                if (a < 0 && b < 0)
                    return 0;
                if (a < 0)
                    return 1;
                if (b < 0)
                    return -1;
                return a - b;
            });
            table.entries.set(prefix + "RequestParameters", present.join(","));
            table.entries.set(renderIocKey("dma.request_index", { n: request }), info.ip);
            // CubeMX 见到 DMA 通道就顺手打开它的中断（实测 6.15.0 + F1：加一条 ADC1 DMA 后
            // 保存，diff 里唯一多出来的键就是 NVIC.DMA1_Channel1_IRQn，值固定这一串）。
            // 我们不补它的话，每次回写都要多一条 added-key 噪声；只在缺失时补，用户设过的不覆盖。
            const instance = (table.entries.get(prefix + "Instance") ?? "").trim();
            const channelIrq = renderIocKey("nvic.vector", { name: instance });
            if (/^DMA[12]_Channel[0-9]$/u.test(instance) && !table.entries.has(channelIrq)) {
                table.entries.set(channelIrq, "true:0:0:false:false:true:false:true:true");
            }
            request += 1;
        }
        table.entries.set(renderIocKey("dma.requests_nb"), String(request));
        for (const key of [...table.entries.keys()]) {
            const match = /^Dma\.Request([0-9]+)$/u.exec(key);
            if (match !== null && Number.parseInt(match[1], 10) >= request)
                table.entries.delete(key);
        }
    }
    // 参数：写 <ip>.<名字>=值，并把名字合并进 <ip>.IPParameters。
    const paramsKey = renderIocKey("periph.ip_parameters", { ip: preset.ip });
    const names = (table.entries.get(paramsKey) ?? "").split(",").map((item) => item.trim()).filter((item) => item !== "");
    for (const param of preset.parameters) {
        table.entries.set(preset.ip + "." + param.name, request.parameters?.[param.name] ?? param.value);
        if (!names.includes(param.name))
            names.push(param.name);
        if (overrodePins && request.parameters?.[param.name] === undefined && param.name.startsWith("Channel-")) {
            table.warnings.push(preset.name + " 换了引脚，但 " + param.name + " 仍是 " + param.value +
                "：通道号必须与引脚一致，请一并用 parameters 改");
        }
    }
    for (const [name, value] of Object.entries(request.parameters ?? {})) {
        if (names.includes(name))
            continue;
        names.push(name);
        table.entries.set(preset.ip + "." + name, value);
    }
    if (names.length > 0)
        table.entries.set(paramsKey, names.join(","));
    // 预设自带的全局键（目前只有 ADC 的 RCC.ADCPresc）。两条硬要求：
    // 1) RCC.IPParameters 必须**字典序**：jar.md 说 RCCService 自己写这份名单时走 Collections.sort，
    //    语料 504 份里 429 份有序；以前这里是"追加到末尾"，键一多就和 CubeMX 的写法错位。
    // 2) 改了 ADCPresc 就得同步 RCC.ADCFreqValue：否则 .ioc 自相矛盾（÷6 却还写着 ÷2 的 36 MHz）。
    //    语料里 4 份带 ADCPresc 的文件全部满足 ADCFreqValue == APB2/分频 → 这是 CubeMX 自己维护的不变量。
    const extraRcc = [];
    for (const extra of preset.extraEntries ?? []) {
        table.entries.set(extra.key, extra.value);
        if (extra.key.startsWith("RCC."))
            extraRcc.push(extra.key.slice("RCC.".length));
    }
    if (extraRcc.length > 0) {
        const adcDiv = adcPrescalerDiv(table.entries.get("RCC.ADCPresc") ?? "");
        const apb2 = Number(table.entries.get("RCC.APB2Freq_Value") ?? table.entries.get("RCC.APB2TimFreq_Value") ?? "");
        if (adcDiv !== null && Number.isFinite(apb2) && apb2 > 0) {
            table.entries.set(renderIocKey("rcc.adc_freq"), String(Math.round(apb2 / adcDiv)));
            if (!extraRcc.includes("ADCFreqValue"))
                extraRcc.push("ADCFreqValue");
        }
        const names = new Set();
        for (const part of (table.entries.get("RCC.IPParameters") ?? "").split(",")) {
            const trimmed = part.trim();
            if (trimmed !== "")
                names.add(trimmed);
        }
        for (const name of extraRcc)
            names.add(name);
        table.entries.set(renderIocKey("rcc.ip_parameters"), [...names].sort().join(","));
    }
    notes.push("已启用预设 " + preset.name + "（" + preset.label + "）");
    for (const note of preset.notes ?? [])
        notes.push(note);
}
/**
 * 自洽校验（都按 CubeMX 的真实推导规则，不是风格洁癖）：
 * - Mcu.IPNb 必须等于 Mcu.IPn 的条数；
 * - 外设进了 Mcu.IPn 就得有引脚 .Signal 指向它；
 * - 多模式外设的引脚还得表达功能：普通外设（USART）用 `.Mode`，共享信号外设（定时器/ADC）
 *   用 `SH.<pin信号>.<n>=<IP 信号>,<IP 模式>` —— 两者都缺时 CubeMX 静默丢弃整个外设，不报错。
 */
function validatePeripheralWiring(entries, warnings) {
    let slots = 0;
    const devices = new Set();
    for (const [key, value] of entries) {
        if (!/^Mcu\.IP\d+$/u.test(key))
            continue;
        slots += 1;
        devices.add(value.trim());
    }
    const ipNbKey = renderIocKey("mcu.ip_nb");
    const declared = Number.parseInt(entries.get(ipNbKey) ?? "", 10);
    if (Number.isFinite(declared) && declared !== slots) {
        warnings.push(ipNbKey + "=" + String(declared) + " 但实际有 " + String(slots) + " 个 Mcu.IPn 键（CubeMX 打开时会自己重算）");
    }
    const pinsByDevice = new Map();
    for (const [key, value] of entries) {
        if (!key.endsWith(".Signal"))
            continue;
        const pin = key.slice(0, key.length - ".Signal".length);
        for (const device of devicesOfSignal(entries, value.trim())) {
            const list = pinsByDevice.get(device) ?? [];
            list.push(pin);
            pinsByDevice.set(device, list);
        }
    }
    for (const device of devices) {
        // 伪外设：没有自己的引脚（DMA/NVIC/RCC/SYS 以及 Cortex 内核项），不按「必须有引脚」校验。
        if (device === "" || device === "NVIC" || device === "RCC" || device === "SYS" || device === "DMA")
            continue;
        const pins = pinsByDevice.get(device) ?? [];
        if (pins.length === 0) {
            warnings.push(device + " 在 Mcu.IPn 里，但没有引脚的 .Signal 指向它 → CubeMX 会忽略这个外设");
            continue;
        }
        const noMode = pins.filter((pin) => {
            const signal = (entries.get(pin + ".Signal") ?? "").trim();
            if (signal.startsWith("GPIO_"))
                return false;
            if ((entries.get(pin + ".Mode") ?? "").trim() !== "")
                return false;
            // 共享信号（定时器/ADC）本来就不带 .Mode，改由 SH.<signal>.<n>=<IP 信号>,<IP 模式> 表达。
            return (entries.get(renderIocKey("shared_signal.conf_nb", { signal })) ?? "") === "";
        });
        if (noMode.length > 0) {
            warnings.push(device + " 的引脚 " + noMode.join("、") + " 既没有 .Mode 也没有 SH." + " 共享信号块 → " +
                "CubeMX 实测会静默丢弃整个外设（用 peripherals 预设，或自己补 <pin>.Mode / SH 块）");
        }
    }
}
/**
 * 一根脚的 .Signal 指向哪个外设实例。
 *
 * 名字有三种来源：`USART1_TX`（普通外设）、`S_TIM2_CH1_ETR`（定时器共享信号，前缀 S_）、
 * `ADCx_IN1`（ADC 共享信号，本身不含实例名 —— 实例名在 `SH.ADCx_IN1.0=ADC1_IN1,IN1` 里）。
 */
function devicesOfSignal(entries, signal) {
    const found = new Set();
    const add = (name) => {
        const match = /^([A-Z][A-Z0-9]*)_/u.exec(name);
        if (match === null)
            return;
        const device = match[1] ?? "";
        if (device === "" || device.endsWith("x"))
            return;
        found.add(device);
    };
    add(signal);
    if (signal.startsWith("S_"))
        add(signal.slice(2));
    const declared = Number.parseInt(entries.get(renderIocKey("shared_signal.conf_nb", { signal })) ?? "", 10);
    const count = Number.isFinite(declared) ? declared : 0;
    for (let index = 0; index < count; index += 1) {
        const value = (entries.get(renderIocKey("shared_signal.slot", { signal, n: index })) ?? "").trim();
        const target = value.split(",")[0] ?? "";
        add(target);
    }
    return [...found];
}
function planPaths(projectDir, planId) {
    const dir = join(projectDir, STATE_DIR, "plans");
    return { planPath: join(dir, planId + ".json"), candidatePath: join(dir, planId + ".ioc") };
}
function prunePlans(planDir, keep = 20) {
    if (!existsSync(planDir))
        return;
    const files = readdirSync(planDir).filter((name) => name.endsWith(".json"));
    if (files.length <= keep)
        return;
    const withTime = files.map((name) => ({ name, mtime: statSync(join(planDir, name)).mtimeMs }));
    withTime.sort((left, right) => right.mtime - left.mtime);
    for (const item of withTime.slice(keep)) {
        const planId = item.name.slice(0, -".json".length);
        rmSync(join(planDir, item.name), { force: true });
        rmSync(join(planDir, planId + ".ioc"), { force: true });
    }
}
/** 生成变更计划：只读源文件，把候选文本写到 .dsh-stm32/plans/，不碰 .ioc。 */
export function planIocChanges(request) {
    const projectDir = resolve(request.projectDir);
    const iocPath = request.iocPath !== undefined && request.iocPath !== ""
        ? (isAbsolute(request.iocPath) ? request.iocPath : resolve(projectDir, request.iocPath))
        : findIocFile(projectDir);
    const empty = {
        ok: false, projectDir, iocPath: iocPath ?? "", planId: "", sourceSha256: "", candidateSha256: "",
        changes: [], warnings: [], notes: [], errors: [], message: "",
        dbVersion: "", dbRoot: "",
        clockPlan: emptyClockPlan("还没读到 .ioc，时钟没算"),
    };
    if (iocPath === null || !existsSync(iocPath)) {
        return { ...empty, errors: ["找不到 .ioc（工程根目录下必须有且只有一个 *.ioc，或用 iocPath 指定）"], message: "没生成计划：找不到 .ioc" };
    }
    let source = "";
    try {
        source = readIocText(iocPath);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ...empty, iocPath, errors: [message], message: "没生成计划：" + message };
    }
    const sourceSha256 = sha256Hex(source);
    const errors = [];
    const warnings = [];
    const notes = [];
    const diagnostics = inspectIocText(source);
    if (diagnostics.mixedEol) {
        warnings.push("这份 .ioc 的换行不一致（既有 CRLF 又有 LF）：写回时会统一成多数的那种（CRLF）");
    }
    else if (source.includes("\n") && !source.includes("\r\n")) {
        // 纯 LF：CubeMX 自己保存时写 CRLF。我们保留原样（否则用户第一次 apply 就会看到整文件换行变化），
        // 但要说清代价——拿我们的文件跟 CubeMX 另存的结果逐字节 diff 时会差整文件换行（键值不受影响）。
        warnings.push("这份 .ioc 是纯 LF 换行（CubeMX 自己保存时用 CRLF）：写回保持 LF，逐字节对比 CubeMX 另存的结果会整文件不同");
    }
    if (!diagnostics.finalNewline) {
        notes.push("源文件末尾没有换行：写回时保持原样（CubeMX 自己写的文件是有换行的，手工改出来的常常没有）");
    }
    if (diagnostics.malformedLines.length > 0) {
        warnings.push("这些行既不是 # 注释、也没有 \"=\"，CubeMX 会当垃圾行丢掉（行号：" +
            diagnostics.malformedLines.slice(0, 8).join("、") +
            (diagnostics.malformedLines.length > 8 ? "…" : "") + "）");
    }
    const before = parseIocEntries(source);
    // 深拷贝成可写 Map（parseIocEntries 返回的就是新 Map，直接改即可）。
    const after = new Map(before);
    const pinTable = readPinTable(after, errors, warnings);
    // 先记下原始引脚表：只有真的变了才重写 Mcu.PinN，顺序没变就一个字节都不碰。
    const originalOrder = [...pinTable.order];
    // SVD 的中断表先准备好：interrupts 参数要拿它校验中断名，R20 也要用（同一个 set 复用，只读一次盘）。
    // .ioc 里只有 CPN（STM32F103C8T6），先换成 SVD 的 line（103）；没有资源包时 device 为 null，校验跳过。
    let interrupts = null;
    const cpn = (after.get("Mcu.CPN") ?? "").trim();
    if (cpn !== "") {
        const line = svdLineForChip(cpn);
        const device = line === null ? null : loadSvdForLine(line);
        if (device !== null && device.interruptNames.size > 0)
            interrupts = device.interruptNames;
    }
    for (const pin of request.pins ?? [])
        addPin(pinTable, pin);
    if (request.serialWire === true)
        ensureSerialWire(pinTable);
    const family = (after.get("Mcu.Family") ?? "").trim();
    if (family === "" && (request.peripherals ?? []).length > 0) {
        warnings.push("读不到 Mcu.Family，引脚名按原样写入：F1 的 PA0 实际 db 名是 PA0-WKUP，写错会被 CubeMX 丢弃");
    }
    const pinNames = createPinNameResolver({ mcuName: (after.get("Mcu.Name") ?? "").trim(), family });
    // db 指纹写进报告：任何一条返回路径（包括"没有变化"、失败）都要带上，报 bug 时能一眼看出 db 版本差异。
    empty.dbVersion = pinNames.db?.version ?? "";
    empty.dbRoot = pinNames.db?.root ?? "";
    if ((request.peripherals ?? []).length > 0) {
        notes.push(pinNames.describe());
        const pinWarning = pinNames.warning();
        if (pinWarning !== "")
            warnings.push(pinWarning);
    }
    for (const item of request.peripherals ?? [])
        enablePeripheral(pinTable, item, pinNames, notes);
    // 引脚表变化过才重写 Mcu.PinN。
    // 为什么不再按"有没有 .Signal"过滤：F1 的 PB2 在 CubeMX 里只有 PB2.Mode=B2-BOOT1（BOOT1 是复用功能，
    // 不带 .Signal）。按 .Signal 过滤会把它从 Mcu.PinN 里静默剔除——PinsNb 缩水，PB2.Mode / PB2.GPIO_*
    // 成了没有引脚指向的孤儿键，CubeMX 下次打开就丢这段配置。所以：已在表里的引脚一个都不删，只追加。
    // 虚拟引脚（VP_*）的清理归 ensureSerialWire 管，这里不掺和。
    // 排序：CubeMX 自己按 db 的 <Pin Position> 升序写 Mcu.Pin<i>（虚拟脚在最后），我们以前只会尾部追加，
    // 所以每次加引脚都会多一条"引脚表被重排"的真 diff（三次真机探针一致）。
    // 没有 db 时所有脚都查不到 Position：排序退化成「原序 + 虚拟脚挪到最后」，仍然是我们想要的
    // （原文件本来就是 CubeMX 写的，顺序已经对；VP_* 无论哪种情况都在最后）。
    const positionOf = (pin) => {
        const fact = pinNames.facts === null ? undefined : pinNames.facts.pins.get(pin);
        return fact === undefined ? null : fact.position;
    };
    const finalOrder = sortPinsByPosition(pinTable.order, positionOf);
    if (!samePinOrder(originalOrder, finalOrder)) {
        const onlyReordered = samePinOrder(originalOrder, pinTable.order);
        writePinOrder(after, pinTable.order, positionOf);
        if (onlyReordered) {
            notes.push("Mcu.Pin<i> 按 CubeMX db 的引脚 Position 重排（虚拟脚在最后）：CubeMX 自己保存时就是这个顺序");
        }
    }
    for (const item of request.entries ?? []) {
        const key = item.key.trim();
        if (key === "" || key.includes("=")) {
            errors.push("键名非法：" + JSON.stringify(item.key));
            continue;
        }
        if (/[\r\n]/u.test(item.value)) {
            errors.push("键 " + key + " 的值里有换行，.ioc 不能表达");
            continue;
        }
        after.set(key, item.value);
    }
    for (const key of request.unset ?? []) {
        const trimmed = key.trim();
        if (!after.has(trimmed)) {
            warnings.push("要删除的键 " + trimmed + " 本来就不存在，跳过");
            continue;
        }
        after.delete(trimmed);
    }
    // 中断放在 entries/unset 之后：entries 里手写的 NVIC 值优先，没显式给优先级时原样保留
    // （applyInterrupts 见到已存在的键只会记 note，不会覆盖）。
    if ((request.interrupts ?? []).length > 0) {
        applyInterrupts(pinTable, request.interrupts ?? [], { facts: pinNames.facts, interrupts }, notes);
    }
    // 时钟：.ioc 里的一段键，和 entries 一起算（不单开工具）。复用 after，所以同一调用里的
    // entries（例如 RCC.MCOSource）对时钟规划是可见的；规划出的键也是"候选文件"的一部分。
    const clockPlan = request.clock === undefined
        ? planClock(undefined, { entries: after })
        : planClock(request.clock, { entries: after });
    if (request.clock === undefined) {
        const achieved = clockPlan.achieved;
        notes.push("时钟（只读，未请求改动）：SYSCLK " + formatHz(achieved.sysclkHz) +
            " / APB1 " + formatHz(achieved.apb1Hz) +
            " / APB2 " + formatHz(achieved.apb2Hz) +
            " / ADC " + formatHz(achieved.adcHz));
    }
    else {
        warnings.push(...clockPlan.warnings);
        if (clockPlan.note !== "")
            notes.push("时钟：" + clockPlan.note);
        for (const item of clockPlan.entries)
            after.set(item.key, item.value);
        for (const key of clockPlan.unset)
            after.delete(key);
        for (const error of clockPlan.errors)
            errors.push("时钟：" + error);
    }
    // 外设接线自洽性（IPNb 条数、外设有没有引脚指向、多模式引脚缺不缺 .Mode）。
    validatePeripheralWiring(after, warnings);
    // schema 覆盖率闸门：写出来的每个键都要在 src/data/ioc-schema.ts 里找得到 spec。
    // 这里只告警、不硬失败——老工程模板可能带我们没登记的键，卡死 plan 比漏报更糟；
    // 真正的闸门在单测里（schema 覆盖率 0 uncovered + 每类写键点都有 spec）。
    const coverage = iocSchemaCoverage(after.keys());
    if (coverage.uncovered.length > 0) {
        warnings.push("[SCHEMA] " + String(coverage.uncovered.length) + " 个键不在 .ioc schema 真值表里（" +
            coverage.uncovered.slice(0, 5).join("、") + "）：可能是 CubeMX 新版本加的键，也可能是我们拼错了键名" +
            "——拼错的键会被 CubeMX 静默忽略，确认后请补进 src/data/ioc-schema.ts");
    }
    // 从 CubeMX 字节码还原出来的离线规则（docs §35）：IPParameters 白名单、DMA 需要 Mcu.IP=DMA、
    // ADC Rank 一致性、NVIC 值 9 段、F1 的 ADC 时钟上限。
    // C6：把 entries 直接写进去的 <IP>.<标量键> 自动补进 <IP>.IPParameters。
    // CubeMX 只认白名单里的参数（R7 检查的就是这件事），漏写会被静默丢弃——这里主动补齐，而不是只告警。
    const instances = new Set();
    for (const [key, value] of after) {
        if (/^Mcu[.]IP[0-9]+$/u.test(key))
            instances.add(value.trim());
    }
    for (const ip of instances) {
        // 只补真外设实例（ADC1/TIM3/USART1…）。NVIC / RCC / SYS / DMA 这些是"伪实例"，
        // 它们的键（NVIC.TIM2_IRQn、RCC.SYSCLKSource…）不属于 IPParameters 白名单，补进去反而写错。
        if (!/^[A-Z]+[0-9]+$/u.test(ip))
            continue;
        const listed = (after.get(ip + ".IPParameters") ?? "").split(",").map((item) => item.trim()).filter((item) => item !== "");
        const known = new Set(listed);
        const added = [];
        for (const key of [...after.keys()]) {
            if (!key.startsWith(ip + "."))
                continue;
            const name = key.slice(ip.length + 1);
            if (name === "IPParameters" || name.includes("."))
                continue;
            if (known.has(name))
                continue;
            known.add(name);
            added.push(name);
        }
        if (added.length === 0)
            continue;
        after.set(ip + ".IPParameters", [...listed, ...added].join(","));
        notes.push("自动补 " + ip + ".IPParameters：" + added.join("、") + "（不补会被 CubeMX 静默丢弃）");
    }
    // R20 用的中断表就是上面那份（interrupts 参数校验时已经读过一次盘，这里复用）。
    const ruleReport = checkIocRules(after, { db: pinNames.db, facts: pinNames.facts, interrupts });
    for (const issue of ruleReport.errors)
        errors.push("[" + issue.rule + "] " + issue.message);
    for (const issue of ruleReport.warnings)
        warnings.push("[" + issue.rule + "] " + issue.message);
    // 重复键 / 跨行值：CubeMX 只认最后一个键值，而跨行值（Java properties 续行）改第一行会留下续行残骸。
    const planned = compareEntries(before, after);
    const multiLine = planned.filter((change) => diagnostics.multiLineKeys.has(change.key));
    if (multiLine.length > 0) {
        errors.push("这些键的值跨了多行（Java properties 的续行）：" + multiLine.map((change) => change.key).join("、") +
            "。改第一行会留下续行残骸，请先在 CubeMX 里重新保存一次再改");
    }
    const duplicated = planned.filter((change) => diagnostics.duplicates.has(change.key));
    if (duplicated.length > 0) {
        errors.push("这些键在 .ioc 里出现了不止一次（CubeMX 只认最后一个）：" +
            duplicated.map((change) => change.key + "×" + String(diagnostics.duplicates.get(change.key) ?? 0)).join("、") +
            "。先在 CubeMX 里重新保存一次把重复键清掉，再来改");
    }
    // 安全闸：这两条是踩过坑的硬约束，不满足就不给 plan。
    const candidateText = renderIocText(source, planned);
    const summary = summarizeIoc(candidateText, iocPath);
    if (!summary.debug.serialWire) {
        errors.push("改完之后没有 Serial Wire 调试口（PA13/PA14）：CubeMX 会生成 __HAL_AFIO_REMAP_SWJ_DISABLE()，烧录后 SWD 连不上。加 serialWire:true 让插件补上。");
    }
    if (!summary.settings.keepUserCode) {
        errors.push("改完之后 ProjectManager.KeepUserCode=false：重新生成会丢掉 USER CODE 区，拒绝。");
    }
    if (errors.length > 0) {
        return { ...empty, iocPath, sourceSha256, errors, warnings, notes, clockPlan, message: "没生成计划：" + errors[0] };
    }
    const changes = planned;
    if (changes.length === 0) {
        return { ...empty, iocPath, sourceSha256, warnings, notes, clockPlan, message: "没有变化：这些键本来就是这个值" };
    }
    const candidateSha256 = sha256Hex(candidateText);
    const planId = sha256Hex(sourceSha256 + "\n" + candidateSha256).slice(0, 16);
    const paths = planPaths(projectDir, planId);
    mkdirSync(join(projectDir, STATE_DIR, "plans"), { recursive: true });
    writeFileSync(paths.candidatePath, candidateText, "utf8");
    const plan = {
        planId, createdAt: new Date().toISOString(), projectDir, iocPath,
        sourceSha256, candidateSha256, changes, warnings, notes,
        candidatePath: paths.candidatePath, planPath: paths.planPath,
    };
    writeFileSync(paths.planPath, JSON.stringify(plan, null, 1), "utf8");
    prunePlans(join(projectDir, STATE_DIR, "plans"));
    const added = changes.filter((change) => change.before === null).length;
    const removedCount = changes.filter((change) => change.after === null).length;
    notes.push("候选文件：" + paths.candidatePath);
    notes.push("确认后调用 stm32_ioc_apply({ planId: \"" + planId + "\" })；apply 会核对源文件 SHA-256=" + sourceSha256.slice(0, 16) + "…");
    if (pinTable.order.length !== summary.pins.length) {
        notes.push("提示：写成 Mcu.PinsNb=" + String(summary.pins.length) + "，其中 " + String(pinTable.order.length) + " 个引脚有信号定义");
    }
    return {
        ok: true, projectDir, iocPath, planId, sourceSha256, candidateSha256,
        changes, warnings, notes,
        errors: [],
        dbVersion: pinNames.db?.version ?? "",
        dbRoot: pinNames.db?.root ?? "",
        message: "已生成计划 " + planId + "：" + String(changes.length) + " 个键变化（新增 " + String(added) + "、删除 " + String(removedCount) + "、修改 " + String(changes.length - added - removedCount) + "）",
        summaryAfter: summary,
        clockPlan,
    };
}
export function loadPlan(projectDir, planId) {
    const paths = planPaths(resolve(projectDir), planId);
    if (!existsSync(paths.planPath))
        return null;
    try {
        return JSON.parse(readFileSync(paths.planPath, "utf8"));
    }
    catch {
        return null;
    }
}
function nowStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return (String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()));
}
function backupIoc(projectDir, iocPath) {
    const dir = join(projectDir, STATE_DIR, "backups", nowStamp() + "-ioc");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, basename(iocPath));
    copyFileSync(iocPath, target);
    return target;
}
/** 原子替换：先写同目录临时文件，再 rename 覆盖，避免写一半断电留下半截 .ioc。 */
function writeFileAtomic(target, text) {
    const tmp = target + ".dsh-tmp-" + String(process.pid) + "-" + String(Date.now());
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, target);
}
export function applyIocPlan(request) {
    const projectDir = resolve(request.projectDir);
    const empty = {
        ok: false, projectDir, iocPath: "", planId: request.planId, appliedChanges: 0,
        shaBefore: "", shaAfter: "", backupPath: "", warnings: [], notes: [], message: "",
    };
    const plan = loadPlan(projectDir, request.planId);
    if (plan === null) {
        return { ...empty, message: "没写入：找不到计划 " + request.planId + "（可能已被清理，请重新 plan）" };
    }
    const iocPath = resolve(plan.iocPath);
    if (!existsSync(iocPath))
        return { ...empty, iocPath, message: "没写入：.ioc 不存在了：" + iocPath };
    const current = readFileSync(iocPath, "utf8");
    const currentSha = sha256Hex(current);
    if (currentSha !== plan.sourceSha256) {
        return {
            ...empty, iocPath, shaBefore: currentSha,
            message: "没写入：.ioc 在 plan 之后被改过（当前 SHA-256=" + currentSha.slice(0, 16) + "，plan 时=" + plan.sourceSha256.slice(0, 16) +
                "）。这是故意的保护——请重新 plan 确认新内容。",
        };
    }
    if (!existsSync(plan.candidatePath)) {
        return { ...empty, iocPath, shaBefore: currentSha, message: "没写入：候选文件不在了（" + plan.candidatePath + "），请重新 plan" };
    }
    const candidate = readFileSync(plan.candidatePath, "utf8");
    const candidateSha = sha256Hex(candidate);
    if (candidateSha !== plan.candidateSha256) {
        return { ...empty, iocPath, shaBefore: currentSha, message: "没写入：候选文件的 SHA-256 与 plan 时不一致（可能被手改），请重新 plan" };
    }
    // 第二道闸：候选内容也必须满足安全约束。
    const summary = summarizeIoc(candidate, iocPath);
    if (!summary.debug.serialWire || !summary.settings.keepUserCode) {
        return { ...empty, iocPath, shaBefore: currentSha, message: "没写入：候选 .ioc 不满足安全约束（Serial Wire 或 KeepUserCode），请重新 plan" };
    }
    const backupPath = backupIoc(projectDir, iocPath);
    writeFileAtomic(iocPath, candidate);
    const writtenSha = sha256Hex(readFileSync(iocPath, "utf8"));
    if (writtenSha !== plan.candidateSha256) {
        // 极端情况：写盘后哈希不一致 → 立刻回滚，别留半成品。
        writeFileAtomic(iocPath, current);
        return { ...empty, iocPath, shaBefore: currentSha, shaAfter: writtenSha, backupPath, message: "写入后校验失败，已自动回滚" };
    }
    const warnings = [...plan.warnings];
    const notes = [
        "备份：" + backupPath,
        "回滚：stm32_ioc_apply({ rollbackFrom: \"" + backupPath + "\" })",
    ];
    if (summary.warnings.length > 0)
        notes.push("改完后的 .ioc 仍有 " + String(summary.warnings.length) + " 条告警，可用 stm32_ioc_inspect 查看");
    notes.push("下一步：stm32_generate（CubeMX 会按新 .ioc 重写非 USER CODE 区，USER CODE 保活）");
    return {
        ok: true, projectDir, iocPath, planId: plan.planId, appliedChanges: plan.changes.length,
        shaBefore: currentSha, shaAfter: writtenSha, backupPath, warnings, notes,
        message: "已写入 " + String(plan.changes.length) + " 个键变化（备份在 " + backupPath + "）",
    };
}
/** 回滚：把某次备份的 .ioc 写回去（写之前先备份当前文件，回滚也能再回滚）。 */
export function rollbackIoc(request) {
    const projectDir = resolve(request.projectDir);
    const empty = {
        ok: false, projectDir, iocPath: "", restoredFrom: request.backupFrom,
        shaBefore: "", shaAfter: "", backupPath: "", message: "",
    };
    const iocPath = findIocFile(projectDir);
    if (iocPath === null)
        return { ...empty, message: "没回滚：工程里找不到唯一的 .ioc" };
    const backupRoot = join(projectDir, STATE_DIR, "backups");
    const resolved = isAbsolute(request.backupFrom) ? resolve(request.backupFrom) : resolve(projectDir, request.backupFrom);
    const relative = resolved.startsWith(backupRoot + sep) ? resolved.slice(backupRoot.length + 1) : null;
    if (relative === null || !resolved.toLowerCase().endsWith(".ioc") || relative.includes("..")) {
        return { ...empty, iocPath, message: "没回滚：只接受 .dsh-stm32/backups/ 下的 .ioc 备份路径（收到 " + resolved + "）" };
    }
    if (!existsSync(resolved))
        return { ...empty, iocPath, message: "没回滚：备份文件不存在：" + resolved };
    const restored = readFileSync(resolved, "utf8");
    const current = readFileSync(iocPath, "utf8");
    const currentSha = sha256Hex(current);
    const backupPath = backupIoc(projectDir, iocPath);
    writeFileAtomic(iocPath, restored);
    const afterSha = sha256Hex(readFileSync(iocPath, "utf8"));
    return {
        ok: true, projectDir, iocPath, restoredFrom: resolved,
        shaBefore: currentSha, shaAfter: afterSha, backupPath,
        message: "已把 " + basename(resolved) + " 写回 .ioc（当前内容先备份到 " + backupPath + "）",
    };
}
