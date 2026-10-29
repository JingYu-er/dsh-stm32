/**
 * L2：cmake-sources —— 让 cmake/stm32cubemx/CMakeLists.txt 跟着工程的实际内容更新。
 *
 * 背景（审计后补的老洞）：这份文件由脚手架从 templates/scaffold 拷进来，之后 CubeMX 不再重写它。
 * 实测证据：demo 工程里它的 mtime 与模板拷贝时间相同，而 Core/Src/main.c 已经更新过一轮。
 * 于是它一直是「C8T6 + GPIO」的快照：设备宏写死 STM32F103xB、启动文件写死 startup_stm32f103xb.s、
 * HAL 模块清单只有 gpio/dma/pwr/flash/exti/cortex/rcc 那一圈。只要在 CubeMX 里开一个 UART/CAN/USB，
 * 编译能过、链接报 undefined reference to HAL_UART_Init —— 而源清单里根本没有那个 .c，
 * 报错信息完全不指向真正的病因，这是最费时间的一类坑。
 *
 * 做法：只动三处（设备宏、应用源清单、驱动源清单），文件里其余的行原样保留。
 *   - 设备宏与启动文件：从工程根真实存在的 startup_stm32*.s 反推（stm32f103xb → STM32F103xB），
 *     不查表、不猜型号：文件在，就说明事实如此。
 *   - HAL 模块：以 Core/Inc/stm32f1xx_hal_conf.h 里 CubeMX 自己写的 HAL_xxx_MODULE_ENABLED 为准，
 *     再并上 Core 源码里 #include "stm32f1xx_hal_xxx.h" 的模块；只有 Drivers/.../Src 下真有 .c 的才写进去。
 *   - 已有条目只要文件还在就保持原顺序（用户工程的 diff 最小），缺的追加在末尾。
 * 幂等：算出来和文件里一模一样时一个字节都不写。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { readTextFile } from "./text-file.js";
/** ST 的 CMake 布局里那份「CubeMX 生成」的源清单。 */
export const CUBEMX_CMAKE_REL = "cmake/stm32cubemx/CMakeLists.txt";
/** CMSIS 的设备宏，例如 STM32F103xB / STM32F107xC。 */
const DEVICE_DEFINE_RE = /^STM32[A-Z]\d{3}[A-Za-z][A-Za-z0-9]?$/u;
/** 启动文件名，例如 startup_stm32f103xb.s。 */
const STARTUP_RE = /^startup_stm32[a-z0-9]+\.s$/iu;
/** 块里的条目路径：${CMAKE_CURRENT_SOURCE_DIR}/../../Core/Src/main.c → Core/Src/main.c。 */
const ENTRY_RE = /\$\{CMAKE_CURRENT_SOURCE_DIR\}\/\.\.\/\.\.\/([^"\s)]+)/u;
export function isDeviceDefine(token) {
    return DEVICE_DEFINE_RE.test(token);
}
/** 工程根上的启动文件（排序后返回，保证多次调用结果一致）。 */
export function listStartupFiles(projectDir) {
    if (!existsSync(projectDir))
        return [];
    try {
        return readdirSync(projectDir)
            .filter((name) => STARTUP_RE.test(name))
            .sort();
    }
    catch {
        return [];
    }
}
/** 选工程根那个启动文件：唯一就是它；多个按字典序取第一个并说明（芯片换了要人删掉旧的）。 */
export function pickStartupFile(projectDir) {
    const files = listStartupFiles(projectDir);
    if (files.length === 0)
        return null;
    const first = files[0];
    if (files.length === 1)
        return { file: first, notes: [] };
    return {
        file: first,
        notes: [
            "工程根有多个启动文件（" + files.join("、") + "），按字典序用了 " + first + "；",
            "换过芯片的话请删掉不用的那个，否则链接期会撞重复的中断向量表。",
        ],
    };
}
/** startup_stm32f103xb.s → stm32f103xb。 */
export function startupStem(file) {
    return basename(file).replace(/^startup_/iu, "").replace(/\.s$/iu, "").toLowerCase();
}
/** stm32f103xb → STM32F103xB（就是 CMSIS 头里那个宏，也是 cmake 源清单里那一行）。 */
export function deviceDefineFromStartup(file) {
    return startupStem(file).toUpperCase().replace(/X(?=.$)/u, "x");
}
/** stm32f103xb → { token: stm32f1xx, upper: STM32F1xx }；认不出返回 null。 */
export function familyTokensFromStartup(file) {
    const matched = /^stm32([a-z]\d)/u.exec(startupStem(file));
    if (matched === null)
        return null;
    const code = matched[1];
    return { token: "stm32" + code + "xx", upper: "STM32" + code.toUpperCase() + "xx" };
}
/**
 * 抹掉注释再匹配。
 *
 * CubeMX 的 hal_conf 里，没用到的模块是一行被注释掉的 `/*#define HAL_ADC_MODULE_ENABLED *\/`——
 * 不剥注释的话正则照样命中，会把整个 HAL 的 30 多个 .c 全编进去（老洞修复时就踩了这个）。
 */
/**
 * 这个文件主要用哪种行尾。
 *
 * text-file 的 eol 是「含 CRLF 就算 CRLF」，遇到 CRLF/LF 混排的文件会把整个文件翻成 CRLF，
 * 于是明明内容没变，diff 却是全文件重写。这里改成按多数行尾走。
 */
function dominantEol(text) {
    let crlf = 0;
    let lf = 0;
    for (const line of text.split("\n")) {
        if (line.endsWith("\r"))
            crlf += 1;
        else
            lf += 1;
    }
    return crlf > lf ? "\r\n" : "\n";
}
function stripComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/\/\/[^\n]*/gu, " ");
}
function readTextOrNull(path) {
    try {
        return existsSync(path) ? readFileSync(path, "utf8") : null;
    }
    catch {
        return null;
    }
}
/**
 * 这个工程用到了哪些 HAL 模块。
 *
 * 主依据是 stm32f1xx_hal_conf.h：CubeMX 只把真正用到的外设模块的 HAL_xxx_MODULE_ENABLED 打开，
 * 那份文件就是它对「要编译哪些 .c」的声明（不要扫 hal_conf 里的 #include —— 那里每个模块都列了一遍，
 * 只是被 #ifdef 包住，全当「用到」会把整个 HAL 都编进去）。
 * 再并上 Core 源码里显式 #include 的模块，兜住手写代码的情况。
 */
export function halModulesInUse(projectDir, family) {
    const modules = new Set();
    const notes = [];
    const confPath = join(projectDir, "Core", "Inc", family.token + "_hal_conf.h");
    const conf = readTextOrNull(confPath);
    if (conf === null) {
        notes.push("没有 " + family.token + "_hal_conf.h，模块清单只能靠源码里的 #include 推");
    }
    else {
        for (const matched of stripComments(conf).matchAll(/#define\s+HAL_([A-Z0-9_]+)_MODULE_ENABLED/gu)) {
            modules.add(matched[1].toLowerCase());
        }
    }
    const includeRe = new RegExp("#include\\s+[\"<]" + family.token + "_hal_([a-z0-9_]+)\\.h[\">]", "gu");
    const scanDirs = [
        [join(projectDir, "Core", "Src"), /\.c$/iu],
        [join(projectDir, "Core", "Inc"), /\.h$/iu],
    ];
    const skip = confPath.toLowerCase();
    for (const [dir, filter] of scanDirs) {
        if (!existsSync(dir))
            continue;
        let names;
        try {
            names = readdirSync(dir).filter((name) => filter.test(name));
        }
        catch {
            continue;
        }
        for (const name of names) {
            const path = join(dir, name);
            if (path.toLowerCase() === skip)
                continue;
            const text = readTextOrNull(path);
            if (text === null)
                continue;
            for (const matched of stripComments(text).matchAll(includeRe))
                modules.add(matched[1].toLowerCase());
        }
    }
    const sorted = [...modules].sort();
    if (sorted.length === 0)
        notes.push("没读到任何 HAL 模块（hal_conf 与 Core 源码里都没有），驱动源清单会保持原样");
    return { modules: sorted, notes };
}
/** 收集「这个工程到底该编哪些文件」的事实；缺启动文件时返回 error。 */
export function collectCmakeSources(projectDir) {
    const startup = pickStartupFile(projectDir);
    if (startup === null) {
        return { error: "工程根没有 startup_stm32*.s（不是脚手架建的 HAL 工程？），无从反推芯片与源清单" };
    }
    const family = familyTokensFromStartup(startup.file);
    if (family === null)
        return { error: "认不出启动文件 " + startup.file + " 属于哪个 STM32 家族" };
    const deviceDefine = deviceDefineFromStartup(startup.file);
    const notes = [...startup.notes];
    const moduleFacts = halModulesInUse(projectDir, family);
    notes.push(...moduleFacts.notes);
    const driverDir = "Drivers/" + family.upper + "_HAL_Driver/Src";
    const exists = (rel) => existsSync(join(projectDir, rel));
    const driverFiles = [];
    const push = (rel) => {
        if (exists(rel) && !driverFiles.includes(rel))
            driverFiles.push(rel);
    };
    const systemSrc = "Core/Src/system_" + family.token + ".c";
    push(systemSrc);
    push(driverDir + "/" + family.token + "_hal.c");
    const missing = [];
    for (const module of moduleFacts.modules) {
        const base = driverDir + "/" + family.token + "_hal_" + module + ".c";
        if (!exists(base)) {
            missing.push(module);
            continue;
        }
        driverFiles.push(base);
        const ex = driverDir + "/" + family.token + "_hal_" + module + "_ex.c";
        if (exists(ex) && !driverFiles.includes(ex))
            driverFiles.push(ex);
    }
    if (missing.length > 0) {
        notes.push("这些模块在 stm32f1xx_hal_conf.h 里是开着的，但固件包的 " + driverDir + " 下没有对应 .c：" +
            missing.join("、") +
            "（先确认 Drivers 目录是不是完整拷贝）");
    }
    const appFiles = [];
    const appCandidates = [
        "Core/Src/main.c",
        "Core/Src/" + family.token + "_it.c",
        "Core/Src/" + family.token + "_hal_msp.c",
        "Core/Src/sysmem.c",
        "Core/Src/syscalls.c",
        startup.file,
    ];
    for (const rel of appCandidates) {
        if (exists(rel))
            appFiles.push(rel);
    }
    return { startup: startup.file, deviceDefine, family, modules: moduleFacts.modules, driverDir, driverFiles, appFiles, notes };
}
function findBlock(lines, varName) {
    const openRe = new RegExp("^\\s*set\\(\\s*" + varName + "\\s*$", "u");
    for (let i = 0; i < lines.length; i += 1) {
        if (!openRe.test(lines[i]))
            continue;
        for (let j = i + 1; j < lines.length; j += 1) {
            if (lines[j].trim() === ")")
                return { open: i, close: j };
        }
        return null;
    }
    return null;
}
function entryPaths(lines, block) {
    const out = [];
    for (let i = block.open + 1; i < block.close; i += 1) {
        const matched = ENTRY_RE.exec(lines[i]);
        if (matched !== null)
            out.push(matched[1]);
    }
    return out;
}
/** 把一组相对路径渲染成 cmake 块里的条目行（缩进照模板：4 个空格）。 */
function entryLines(paths) {
    return paths.map((rel) => "    ${CMAKE_CURRENT_SOURCE_DIR}/../../" + rel);
}
function splice(lines, block, body) {
    return [...lines.slice(0, block.open + 1), ...body, ...lines.slice(block.close)];
}
/**
 * 应用源清单：保留原有顺序，去掉已经不存在的文件，启动文件必须与事实一致（换芯片时换掉旧的）。
 */
function rewriteAppBlock(lines, block, facts, projectDir) {
    const added = [];
    const dropped = [];
    const kept = [];
    for (const rel of entryPaths(lines, block)) {
        const isStartup = STARTUP_RE.test(basename(rel));
        if (!existsSync(join(projectDir, rel))) {
            dropped.push(rel);
            continue;
        }
        if (isStartup && basename(rel) !== facts.startup) {
            dropped.push(rel);
            continue;
        }
        if (kept.includes(rel))
            continue;
        kept.push(rel);
    }
    for (const rel of facts.appFiles) {
        if (kept.includes(rel))
            continue;
        kept.push(rel);
        added.push(rel);
    }
    if (kept.length === 0)
        return { lines, added: [], dropped: [] };
    return { lines: splice(lines, block, entryLines(kept)), added, dropped };
}
/** 驱动源清单：同样保留顺序，缺的追加；只剩一个空块时不改（宁可不写也不写坏）。 */
function rewriteDriverBlock(lines, block, facts, projectDir) {
    const added = [];
    const dropped = [];
    const kept = [];
    for (const rel of entryPaths(lines, block)) {
        if (!existsSync(join(projectDir, rel))) {
            dropped.push(rel);
            continue;
        }
        if (kept.includes(rel))
            continue;
        kept.push(rel);
    }
    for (const rel of facts.driverFiles) {
        if (kept.includes(rel))
            continue;
        kept.push(rel);
        added.push(rel);
    }
    if (kept.length === 0)
        return { lines, added: [], dropped: [] };
    return { lines: splice(lines, block, entryLines(kept)), added, dropped };
}
/** 设备宏：把块里已有的设备宏换成事实值；一个都没有就插在 USE_HAL_DRIVER 后面。 */
function rewriteDefinesBlock(lines, block, facts) {
    const body = [];
    let found = false;
    for (let i = block.open + 1; i < block.close; i += 1) {
        const line = lines[i];
        const token = line.trim();
        if (isDeviceDefine(token)) {
            body.push(line.replace(token, facts.deviceDefine));
            found = true;
            continue;
        }
        body.push(line);
    }
    if (!found) {
        const insertAt = body.findIndex((line) => line.includes("USE_HAL_DRIVER"));
        body.splice(insertAt >= 0 ? insertAt + 1 : 0, 0, "\t" + facts.deviceDefine);
    }
    return { lines: splice(lines, block, body), changed: true };
}
function emptyResult(path, message, notes = []) {
    return { ok: false, path, changed: false, message, notes, startup: "", deviceDefine: "", modules: [], added: [], dropped: [] };
}
/**
 * 重算并（默认）写回 cmake/stm32cubemx/CMakeLists.txt。
 * 只动三处 managed 块，其余行原样保留；内容没变就不写盘。
 */
export function refreshCubemxCmakeLists(projectDir, options = {}) {
    const cmakePath = join(projectDir, CUBEMX_CMAKE_REL);
    if (!existsSync(cmakePath)) {
        return emptyResult(cmakePath, "工程里没有 " + CUBEMX_CMAKE_REL + "（不是 ST 的 CMake 布局），跳过");
    }
    const facts = collectCmakeSources(projectDir);
    if ("error" in facts)
        return emptyResult(cmakePath, facts.error);
    const file = readTextFile(cmakePath);
    if (!file.ok)
        return emptyResult(cmakePath, "读不了 " + CUBEMX_CMAKE_REL + "（" + file.error + "），跳过");
    if (file.encoding !== "utf8" && file.encoding !== "utf8-bom") {
        return emptyResult(cmakePath, CUBEMX_CMAKE_REL + " 的编码是 " + file.encoding + "，为避免写坏，跳过");
    }
    const eol = dominantEol(file.text);
    const original = file.text.split(/\r?\n/u);
    const endedWithEol = /\r?\n$/u.test(file.text);
    // 按行切完末尾会多出一个空串；不摘掉它，每跑一次就多一个空行（幂等就断了）。
    if (endedWithEol)
        original.pop();
    let lines = original;
    // 家族目录名（Drivers/STM32F1xx_HAL_Driver、CMSIS/Device/ST/STM32F1xx）跟着启动文件走。
    const familyRe = /STM32[A-Z]\dXX/gu;
    lines = lines.map((line) => line.replace(familyRe, facts.family.upper));
    const notes = [...facts.notes];
    const added = [];
    const dropped = [];
    const defines = findBlock(lines, "MX_Defines_Syms");
    if (defines === null)
        return emptyResult(cmakePath, "找不到 set(MX_Defines_Syms ...) 块，格式不是 CubeMX 那套，跳过");
    const afterDefines = rewriteDefinesBlock(lines, defines, facts);
    lines = afterDefines.lines;
    const apps = findBlock(lines, "MX_Application_Src");
    if (apps !== null) {
        const rewritten = rewriteAppBlock(lines, apps, facts, projectDir);
        lines = rewritten.lines;
        added.push(...rewritten.added);
        dropped.push(...rewritten.dropped);
    }
    else {
        notes.push("没有 set(MX_Application_Src ...) 块，应用源清单未改动");
    }
    const drivers = findBlock(lines, "STM32_Drivers_Src");
    if (drivers !== null) {
        const rewritten = rewriteDriverBlock(lines, drivers, facts, projectDir);
        lines = rewritten.lines;
        added.push(...rewritten.added);
        dropped.push(...rewritten.dropped);
    }
    else {
        notes.push("没有 set(STM32_Drivers_Src ...) 块，驱动源清单未改动");
    }
    if (dropped.length > 0) {
        notes.push("从源清单里摘掉了磁盘上已不存在的条目：" + dropped.join("、"));
    }
    const next = lines.join(eol) + (endedWithEol ? eol : "");
    const base = {
        ok: true,
        path: cmakePath,
        startup: facts.startup,
        deviceDefine: facts.deviceDefine,
        modules: facts.modules,
        added,
        dropped,
        notes,
    };
    // 只比内容，不比行尾：文件里 CRLF 与 LF 混着时，按一种行尾重写会让整个文件都变「脏」。
    const contentSame = original.length === lines.length && original.every((line, index) => line === lines[index]);
    if (contentSame) {
        return { ...base, changed: false, message: "已是最新（" + facts.startup + " / " + facts.deviceDefine + " / " + String(facts.modules.length) + " 个 HAL 模块）" };
    }
    if (options.dryRun === true) {
        return { ...base, changed: true, message: "将要更新（dryRun，未写盘）" };
    }
    try {
        writeFileSync(cmakePath, next, "utf8");
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return emptyResult(cmakePath, "写不了 " + cmakePath + "：" + message, notes);
    }
    return {
        ...base,
        changed: true,
        message: "已更新（" + facts.startup + " / " + facts.deviceDefine + "，新增 " + String(added.length) + " 条）",
    };
}
/** 给报告/日志用的一句话。 */
export function describeRefresh(result) {
    if (!result.ok)
        return "cmake 源清单：未处理 —— " + result.message;
    if (!result.changed)
        return "cmake 源清单：" + result.message + "（" + CUBEMX_CMAKE_REL + "）";
    return ("cmake 源清单：" +
        result.message +
        (result.added.length === 0 ? "" : "；新增 " + result.added.join("、")) +
        (result.dropped.length === 0 ? "" : "；摘掉 " + result.dropped.join("、")));
}
