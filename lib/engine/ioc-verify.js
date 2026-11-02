/**
 * L2：`.ioc` 的「CubeMX 到底怎么理解这份配置」诊断（oracle）。
 *
 * 为什么需要：CubeMX 遇到不认识的键**不报错，直接丢**。我们写对了 USART 却丢了 TIM/ADC 时，
 * 生成日志里一个 ERROR 都没有，只能靠「生成完翻 main.c 看有没有 MX_xxx_Init」倒推。
 *
 * 这里利用 CubeMX 无头脚本的 `config save`：`config load` 之后把**它理解的工程**写回 .ioc。
 * 走的是文本导入（与 `stm32_generate` 同一条路），因此 save 出来的东西就是「它理解的结果」：
 * 哪些外设真的激活了（`Mcu.IPn`）、引脚信号被规范化成什么、有没有补 `SH.*` 共享信号块、
 * 计划生成哪些 `MX_*_Init`（`ProjectManager.functionlistsort`）。
 *
 * 纪律：
 * - **只对副本操作**。CubeMX 的 `config save` 会忽略给定路径、直接覆盖被 load 的那份文件，
 *   所以这里把 .ioc 复制到 `.dsh-stm32/verify/<stamp>/` 再跑，绝不碰工程里的 .ioc。
 * - 只读结论：不生成代码、不改工程、不写 cmake。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { parseIocEntries } from "./ioc.js";
import { STATE_DIR, acquireLock, cubeMxLaunch } from "./generate.js";
import { runStreaming } from "./subprocess-runner.js";
import { resolveSearchConfig } from "../data/search-roots.js";
const KEY_SAMPLE_LIMIT = 60;
function peripheralsOf(entries) {
    const count = Number.parseInt(entries.get("Mcu.IPNb") ?? "", 10);
    const names = [];
    if (Number.isFinite(count)) {
        for (let index = 0; index < count; index += 1) {
            const name = (entries.get("Mcu.IP" + String(index)) ?? "").trim();
            if (name !== "")
                names.push(name);
        }
    }
    if (names.length > 0)
        return names;
    for (const [key, value] of entries) {
        if (/^Mcu\.IP\d+$/u.test(key) && value.trim() !== "")
            names.push(value.trim());
    }
    return names;
}
/** `3-MX_USART1_UART_Init-USART1-false-HAL-true` → MX_USART1_UART_Init。 */
export function plannedFunctionOf(entry) {
    const parts = entry.trim().split("-");
    for (const part of parts) {
        if (part.startsWith("MX_"))
            return part;
    }
    return "";
}
function pinSignals(entries) {
    const result = new Map();
    for (const [key, value] of entries) {
        if (!key.endsWith(".Signal"))
            continue;
        const pin = key.slice(0, key.length - ".Signal".length);
        if (pin.startsWith("SH."))
            continue;
        result.set(pin, value.trim());
    }
    return result;
}
/**
 * 两边的值是否只差「CSV 成员顺序 / 空白」——CubeMX 维护自己的名单顺序（如 GPIOParameters、
 * functionlistsort）时会这样改，语义不变，不该算我们写错。
 */
export function isIocValueNormalized(before, after) {
    if (before === after)
        return true;
    if (before.replace(/\s+/gu, " ").trim() === after.replace(/\s+/gu, " ").trim())
        return true;
    const split = (text) => text.split(",").map((item) => item.trim()).filter((item) => item !== "");
    const left = split(before);
    const right = split(after);
    if (left.length < 2 || left.length !== right.length)
        return false;
    const sortedLeft = [...left].sort();
    const sortedRight = [...right].sort();
    return sortedLeft.every((item, index) => item === sortedRight[index]);
}
/**
 * 两边都有、但相对顺序变了的键（不在最长保序子序列里的那些）。
 *
 * 为什么需要：.ioc 的行序对 CubeMX 是有语义的（Mcu.PinN 决定引脚表顺序，IPParameters 是插入序），
 * 所以「零 diff」必须同时是「零 reorder」；只比键集合会把这个盲区放过。
 */
export function misorderedKeysOf(before, after) {
    const commonSet = new Set();
    const common = [];
    for (const key of before.keys()) {
        if (!after.has(key))
            continue;
        commonSet.add(key);
        common.push(key);
    }
    if (common.length < 2)
        return [];
    const rank = new Map();
    let position = 0;
    for (const key of after.keys()) {
        if (!commonSet.has(key))
            continue;
        rank.set(key, position);
        position += 1;
    }
    const sequence = common.map((key) => rank.get(key) ?? 0);
    if (sequence.length > 1500) {
        // 超大文件不走 O(n^2)：只报「位置变小」的键，够定位问题。
        return common.filter((_key, index) => sequence[index] !== index).slice(0, KEY_SAMPLE_LIMIT);
    }
    const best = new Array(sequence.length).fill(1);
    const prev = new Array(sequence.length).fill(-1);
    for (let i = 0; i < sequence.length; i += 1) {
        for (let j = 0; j < i; j += 1) {
            if (sequence[j] < sequence[i] && best[j] + 1 > best[i]) {
                best[i] = best[j] + 1;
                prev[i] = j;
            }
        }
    }
    let end = 0;
    for (let i = 1; i < sequence.length; i += 1) {
        if (best[i] > best[end])
            end = i;
    }
    const keep = new Set();
    for (let cursor = end; cursor >= 0; cursor = prev[cursor]) {
        keep.add(cursor);
        if (prev[cursor] < 0)
            break;
    }
    return common.filter((_key, index) => !keep.has(index));
}
function listedPins(entries) {
    const listed = new Set();
    const count = Number.parseInt(entries.get("Mcu.PinsNb") ?? "", 10);
    if (Number.isFinite(count)) {
        for (let index = 0; index < count; index += 1) {
            const pin = (entries.get("Mcu.Pin" + String(index)) ?? "").trim();
            if (pin !== "")
                listed.add(pin);
        }
    }
    if (listed.size === 0) {
        for (const [key, value] of entries) {
            if (/^Mcu\.Pin\d+$/u.test(key) && value.trim() !== "")
                listed.add(value.trim());
        }
    }
    return listed;
}
function sharedSignalBlocks(entries) {
    const keys = new Map();
    for (const [key, value] of entries) {
        const match = /^SH\.(.+)\.(\d+|ConfNb)$/u.exec(key);
        if (match === null)
            continue;
        const name = match[1];
        const list = keys.get(name) ?? [];
        list.push(key.slice("SH.".length + name.length + 1) + "=" + value);
        keys.set(name, list);
    }
    return [...keys.entries()].map(([key, items]) => ({ key, entries: items.sort() }));
}
/** 这个外设在 before 文本里有没有引脚指向（普通信号 / S_ 定时器信号 / ADCx 共享信号）。 */
function pinsPointingAt(before, device) {
    const pins = [];
    for (const [pin, signal] of pinSignals(before)) {
        if (signal.startsWith(device + "_")) {
            pins.push(pin);
            continue;
        }
        const stripped = signal.startsWith("S_") ? signal.slice(2) : signal;
        if (stripped.startsWith(device + "_")) {
            pins.push(pin);
            continue;
        }
        const sharedCount = Number.parseInt(before.get("SH." + signal + ".ConfNb") ?? "", 10);
        if (Number.isFinite(sharedCount) && sharedCount > 0) {
            for (let index = 0; index < sharedCount; index += 1) {
                const target = (before.get("SH." + signal + "." + String(index)) ?? "").split(",")[0]?.trim() ?? "";
                if (target.startsWith(device + "_")) {
                    pins.push(pin);
                    break;
                }
            }
        }
    }
    return pins;
}
/** 纯函数：把「我们写的」与「CubeMX 理解的」两份 .ioc 文本对比成诊断。 */
export function diffIocForVerify(beforeText, afterText) {
    const before = parseIocEntries(beforeText);
    const after = parseIocEntries(afterText);
    const beforeIps = peripheralsOf(before);
    const afterIps = peripheralsOf(after);
    const dropped = beforeIps.filter((name) => !afterIps.includes(name));
    const added = afterIps.filter((name) => !beforeIps.includes(name));
    const rawList = (after.get("ProjectManager.functionlistsort") ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item !== "");
    const plannedRaw = rawList.length > 0 ? rawList : (before.get("ProjectManager.functionlistsort") ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item !== "");
    const plannedFunctions = plannedRaw.map(plannedFunctionOf).filter((name) => name !== "");
    const beforePins = pinSignals(before);
    const afterPins = pinSignals(after);
    const signalRewrites = [];
    for (const [pin, signal] of beforePins) {
        const next = afterPins.get(pin);
        if (next !== undefined && next !== signal)
            signalRewrites.push({ pin, before: signal, after: next });
    }
    const listed = listedPins(before);
    const removedKeys = [...before.keys()].filter((key) => !after.has(key)).sort();
    const addedKeys = [...after.keys()].filter((key) => !before.has(key)).sort();
    // 只比键存在性会漏掉「值被 CubeMX 规范化/重算」：键还在、值变了——这类差异最容易被误读成零 diff。
    const changedValues = [];
    for (const [key, value] of before) {
        const next = after.get(key);
        if (next !== undefined && next !== value)
            changedValues.push({ key, before: value, after: next });
    }
    changedValues.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
    // functionlistsort 的「纯追加 MX_*_Init」不算差异：那是 CubeMX 保存时自己维护的一列。
    // 只有「只追加、不删条目、不改已有条目的值」才这么处理；删条目/改值仍然留在 changedValues 里。
    const autoAddedFunctions = [];
    const listSortIndex = changedValues.findIndex((item) => item.key === "ProjectManager.functionlistsort");
    if (listSortIndex >= 0) {
        const change = changedValues[listSortIndex];
        const beforeItems = change.before.split(",").map((item) => item.trim()).filter((item) => item !== "");
        const afterItems = change.after.split(",").map((item) => item.trim()).filter((item) => item !== "");
        const appended = afterItems.slice(beforeItems.length);
        const keptPrefix = afterItems.slice(0, beforeItems.length);
        const onlyAppended = keptPrefix.length === beforeItems.length &&
            keptPrefix.every((item, index) => item === beforeItems[index]) &&
            appended.length > 0 &&
            appended.every((item) => /^[0-9]+-MX_[A-Za-z0-9_]+_Init-[^,]*$/u.test(item));
        if (onlyAppended) {
            autoAddedFunctions.push(...appended);
            changedValues.splice(listSortIndex, 1);
        }
    }
    // 归因：键序变化 + 值规范化，各自单独成桶（见 IocVerifyAttribution 的三条动机）。
    const misordered = misorderedKeysOf(before, after);
    const valueNormalized = [];
    const valueChanged = [];
    for (const item of changedValues) {
        const bucket = isIocValueNormalized(item.before, item.after) ? valueNormalized : valueChanged;
        bucket.push(item);
    }
    const attribution = {
        orderOnly: misordered.slice(0, KEY_SAMPLE_LIMIT),
        valueNormalized: valueNormalized.slice(0, KEY_SAMPLE_LIMIT),
        valueChanged: valueChanged.slice(0, KEY_SAMPLE_LIMIT),
        missingKeys: removedKeys.slice(0, KEY_SAMPLE_LIMIT),
        addedKeys: addedKeys.slice(0, KEY_SAMPLE_LIMIT),
        droppedPeripherals: dropped,
        autoAddedFunctions,
        benign: dropped.length === 0 &&
            removedKeys.length === 0 &&
            addedKeys.length === 0 &&
            valueChanged.length === 0 &&
            signalRewrites.length === 0,
    };
    const hints = [];
    // 实测（6.15.0）：中断所属外设没在 Mcu.IPn 里时，NVIC.<IP>_IRQn 会被静默删掉——
    // 用户看到的现象是「开了中断但生成代码里没有」，这里把因果说清楚。
    for (const key of removedKeys) {
        const vector = /^NVIC\.([A-Za-z0-9_]+?)_IRQn$/u.exec(key);
        if (vector === null)
            continue;
        const ip = vector[1] ?? "";
        if (ip === "" || ip.startsWith("EXTI"))
            continue;
        if (peripheralsOf(after).includes(ip))
            continue;
        hints.push(key + " 被 CubeMX 删掉了：" + ip + " 不在它认的外设表里（Mcu.IPn）——" +
            "先启用外设（peripherals）再开它的中断，否则中断键会被静默丢弃");
    }
    for (const device of dropped) {
        const pins = pinsPointingAt(before, device);
        if (pins.length === 0) {
            hints.push(device + " 没有引脚指向它：补 <pin>.Signal=" + device + "_…（普通外设）——" +
                "CubeMX 只从引脚推导外设，光写 " + device + ".IPParameters 不够");
            continue;
        }
        const unlisted = pins.filter((pin) => !listed.has(pin));
        const noFunction = pins.filter((pin) => {
            const signal = before.get(pin + ".Signal") ?? "";
            if ((before.get(pin + ".Mode") ?? "").trim() !== "")
                return false;
            return (before.get("SH." + signal + ".ConfNb") ?? "") === "";
        });
        if (unlisted.length > 0) {
            hints.push(device + " 的引脚 " + unlisted.join("、") + " 没列进 Mcu.PinN：CubeMX 只应用引脚表里的脚（补 Mcu.PinN 与 PinsNb）");
        }
        if (noFunction.length > 0) {
            hints.push(device + " 的引脚 " + noFunction.join("、") + " 缺功能表达：普通外设写 <pin>.Mode（如 USART 的 Asynchronous）；" +
                "定时器/ADC 写共享信号块 SH.<pin信号>.0=<IP 信号>,<IP 模式> 并把 SH.<pin信号>.ConfNb 设成条数" +
                "（引脚本身不要写 .Mode）");
        }
        if (unlisted.length === 0 && noFunction.length === 0) {
            hints.push(device + " 的引脚写法看起来是对的却仍被丢：对照本次 after 文本里该外设的键，多半还差 <" + device + ">.IPParameters 的某个模式项");
        }
    }
    return {
        afterPeripherals: afterIps,
        droppedPeripherals: dropped,
        addedPeripherals: added,
        plannedFunctions,
        plannedFunctionsRaw: plannedRaw,
        signalRewrites,
        sharedSignals: sharedSignalBlocks(after),
        removedKeys: removedKeys.slice(0, KEY_SAMPLE_LIMIT),
        addedKeys: addedKeys.slice(0, KEY_SAMPLE_LIMIT),
        changedValues: changedValues.slice(0, KEY_SAMPLE_LIMIT),
        misorderedKeys: misordered.slice(0, KEY_SAMPLE_LIMIT),
        attribution,
        autoAddedFunctions,
        hints,
    };
}
function findIoc(projectDir) {
    const dir = projectDir;
    const names = [];
    for (const name of readdirSafe(dir)) {
        if (name.toLowerCase().endsWith(".ioc"))
            names.push(name);
    }
    if (names.length === 1)
        return join(dir, names[0]);
    return null;
}
function readdirSafe(dir) {
    try {
        return readdirSync(dir);
    }
    catch {
        return [];
    }
}
/** 跑一次「load + save」诊断。约 25–40 s（不需要生成代码）。 */
export async function runIocVerify(subprocess, request) {
    const projectDir = resolve(request.projectDir);
    const iocPath = request.iocPath !== undefined && request.iocPath !== ""
        ? (isAbsolute(request.iocPath) ? request.iocPath : resolve(projectDir, request.iocPath))
        : findIoc(projectDir);
    const base = {
        ok: false, projectDir, iocPath: iocPath ?? "", snapshotPath: "", durationMs: 0,
        diff: diffIocForVerify("", ""), notes: [], errors: [], message: "",
    };
    if (iocPath === null || !existsSync(iocPath)) {
        return { ...base, errors: ["找不到 .ioc：工程根目录下必须有且只有一个 *.ioc，或用 iocPath 指定"], message: "没诊断：找不到 .ioc" };
    }
    const config = resolveSearchConfig(process.env, request.cubeMxRoots === undefined ? {} : { cubeMxRoots: request.cubeMxRoots });
    const launch = cubeMxLaunch(config.cubeMxRoots);
    if (launch === null) {
        return {
            ...base,
            errors: ["找不到可无头调用的 STM32CubeMX（需要 <root>/jre/bin/java.exe 与 <root>/STM32CubeMX.exe）；可用 STM32_CUBEMX_ROOT 指定"],
            message: "没诊断：找不到 CubeMX",
        };
    }
    const lock = acquireLock(projectDir, "ioc verify");
    if ("error" in lock)
        return { ...base, errors: [lock.error], message: "没诊断：CubeMX 正忙" };
    const beforeText = readFileSync(iocPath, "utf8");
    const stamp = new Date().toISOString().replace(/[-:T.]/gu, "").slice(0, 14);
    const workDir = join(projectDir, STATE_DIR, "verify", stamp);
    mkdirSync(workDir, { recursive: true });
    const snapshotPath = join(workDir, basename(iocPath));
    copyFileSync(iocPath, snapshotPath);
    const scriptPath = join(workDir, "verify.txt");
    writeFileSync(scriptPath, ["config load " + snapshotPath.replace(/\\/g, "/"), "config save " + snapshotPath.replace(/\\/g, "/"), "exit", ""].join("\n"), "utf8");
    const startedAt = Date.now();
    try {
        const argv = [launch.java, "-Dfile.encoding=UTF-8", "-jar", launch.jar, "-q", scriptPath];
        const outcome = await runStreaming(subprocess, {
            argv,
            cwd: projectDir,
            timeoutMs: request.timeoutMs ?? 180_000,
            maxBytes: 1024 * 1024,
        });
        const log = outcome.stdout + "\n" + outcome.stderr;
        const afterText = readFileSync(snapshotPath, "utf8");
        const diff = diffIocForVerify(beforeText, afterText);
        const notes = [
            "CubeMX 写回的是「它理解的结果」，不是正确答案：被丢掉的外设不会自己补回来。",
            "副本在 " + snapshotPath + "（工程里的 .ioc 没动过）。",
            "判定口径：Mcu.IPn = 真正激活的外设；functionlistsort = 计划生成的 MX_*_Init。",
        ];
        if (!/SaveConfig|Bye bye/iu.test(log)) {
            notes.push("日志里没看到保存完成的行，结论可能不完整；原始日志末尾：" + log.trim().split(/\r?\n/u).slice(-3).join(" | "));
        }
        const dropped = diff.droppedPeripherals;
        const valueSuffix = diff.attribution.valueChanged.length === 0
            ? ""
            : "；另有 " + String(diff.attribution.valueChanged.length) + " 个键的值真被改写（键还在，值不一样）";
        const normalizedSuffix = diff.attribution.valueNormalized.length === 0
            ? ""
            : "；另有 " + String(diff.attribution.valueNormalized.length) + " 个键的值只是成员顺序被规范化（语义不变）";
        const orderSuffix = diff.attribution.orderOnly.length === 0
            ? ""
            : "；另有 " + String(diff.attribution.orderOnly.length) + " 个键的值相同但行序不同（CubeMX 按自己的顺序重排）";
        const autoSuffix = diff.autoAddedFunctions.length === 0
            ? ""
            : "；它另外自己补了 " + String(diff.autoAddedFunctions.length) + " 条初始化清单（functionlistsort，不影响生成正确性）";
        return {
            ...base,
            ok: true,
            snapshotPath,
            durationMs: Date.now() - startedAt,
            diff,
            notes,
            message: (dropped.length === 0
                ? "CubeMX 认了全部 " + String(diff.afterPeripherals.length) + " 个外设；计划生成 " + String(diff.plannedFunctions.length) + " 个初始化函数"
                : "CubeMX 丢了 " + dropped.join("、") + "（其余 " + String(diff.afterPeripherals.length) + " 个认了）") +
                valueSuffix + normalizedSuffix + orderSuffix + autoSuffix,
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ...base, snapshotPath, errors: [message], message: "诊断失败：" + message };
    }
    finally {
        lock.release();
    }
}
