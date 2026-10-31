/**
 * L2：直接读 STM32CubeMX 安装自带的 db（只查询，不复制、不落盘）。
 *
 * 为什么这么做：用户要求「能在 db 查到的，只写查询逻辑」。CubeMX 安装目录里的
 * db/mcu/*.xml 就是芯片事实（引脚、Signal、IP 实例、最高频率），
 * db/mcu/IP/*_Modes.xml 就是各 IP 的合法模式名，db/package.xml 是库版本。
 * 这些文件随用户的 CubeMX 版本变化，所以我们不在插件里内置副本，运行时按版本找。
 *
 * 结构（实测 DB.6.0.150）：
 *   db/package.xml                      → <PackDescription Release="DB.6.0.150"/>
 *   db/mcu/STM32F103C(8-B)Tx.xml        → <Mcu ... Package="LQFP48"> <Frequency>72</Frequency>
 *                                          <Pin Name="PA8" Position="29"><Signal Name="TIM1_CH1"/>…
 *                                          <IP ConfigFile="TIM-STM32F1xx" InstanceName="TIM3" Name="TIM1_8F1" Version="gptimer2_v1_x_Cube"/>
 *   db/mcu/IP/TIM1_8F1-gptimer2_v1_x_Cube_Modes.xml → <RefMode Name="PWM Generation1 No Output" …/>
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
/** 读 <root>/db/package.xml 里的 Release。 */
function readDbVersion(dbRoot) {
    const file = join(dbRoot, "package.xml");
    if (!existsSync(file))
        return null;
    const text = readFileSync(file, "utf8");
    const match = /Release="(DB[^"]+)"/u.exec(text);
    return match === null ? null : match[1];
}
/**
 * 定位要用的 db：优先安装目录，其次用户目录下的历史下载库。
 * wantedVersion 为空时用安装目录那份（CubeMX 自己也是这么选的）。
 */
export function locateCubemxDb(roots, wantedVersion = "") {
    const candidates = [];
    for (const root of roots)
        candidates.push(join(root, "db"));
    for (const root of roots) {
        const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
        if (home !== "")
            candidates.push(join(home, ".stm32cubemx", "databases"));
    }
    for (const candidate of candidates) {
        if (!existsSync(candidate))
            continue;
        if (candidate.endsWith("databases")) {
            if (wantedVersion === "")
                continue;
            for (const name of readdirSync(candidate)) {
                if (name !== wantedVersion)
                    continue;
                const version = readDbVersion(join(candidate, name, "db"));
                if (version !== null)
                    return { root: join(candidate, name, "db"), version };
            }
            continue;
        }
        const version = readDbVersion(candidate);
        if (version === null)
            continue;
        if (wantedVersion !== "" && version !== wantedVersion)
            continue;
        return { root: candidate, version };
    }
    return null;
}
/** 解析一份 MCU XML（结构简单，用正则足够，零依赖）。 */
export function parseMcuXml(text) {
    const mcu = /<Mcu\b([^>]*)>/u.exec(text);
    if (mcu === null)
        return null;
    const attrs = mcu[1];
    const name = /RefName="([^"]+)"/u.exec(attrs)?.[1] ?? "";
    const packageName = /Package="([^"]+)"/u.exec(attrs)?.[1] ?? "";
    const frequency = Number.parseInt(/<Frequency>(\d+)<\/Frequency>/u.exec(text)?.[1] ?? "", 10);
    const pins = new Map();
    // 两种写法都要认：自闭合 <Pin ... />（如 BOOT0）与带子节点的 <Pin ...> … </Pin>；
    // 属性顺序不固定（有的 Pin 把 Type 放前面），所以先抓整段属性再取字段。
    const pinBlocks = text.matchAll(/<Pin\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Pin>)/gu);
    for (const block of pinBlocks) {
        const pinAttrs = block[1];
        const pinName = /(?:^|\s)Name="([^"]+)"/u.exec(pinAttrs)?.[1] ?? "";
        const pinPosition = Number.parseInt(/(?:^|\s)Position="(\d+)"/u.exec(pinAttrs)?.[1] ?? "", 10);
        if (pinName === "")
            continue;
        const signals = new Map();
        for (const signal of (block[2] ?? "").matchAll(/<Signal\b([^>]*)\/?>/gu)) {
            const signalAttrs = signal[1];
            const signalName = /Name="([^"]+)"/u.exec(signalAttrs)?.[1] ?? "";
            if (signalName === "")
                continue;
            const ioModes = /IOModes="([^"]+)"/u.exec(signalAttrs)?.[1] ?? "";
            signals.set(signalName, ioModes === "" ? [] : ioModes.split(",").map((item) => item.trim()));
        }
        pins.set(pinName, {
            name: pinName,
            position: Number.isFinite(pinPosition) ? pinPosition : 0,
            signals,
        });
    }
    const ips = new Map();
    for (const ip of text.matchAll(/<IP\b([^>]*)\/>/gu)) {
        const ipAttrs = ip[1];
        const instanceName = /InstanceName="([^"]+)"/u.exec(ipAttrs)?.[1] ?? "";
        if (instanceName === "")
            continue;
        ips.set(instanceName, {
            instanceName,
            name: /(?:^|\s)Name="([^"]+)"/u.exec(ipAttrs)?.[1] ?? "",
            version: /Version="([^"]+)"/u.exec(ipAttrs)?.[1] ?? "",
            configFile: /ConfigFile="([^"]+)"/u.exec(ipAttrs)?.[1] ?? "",
        });
    }
    if (pins.size === 0)
        return null;
    return { name, packageName, frequencyMhz: Number.isFinite(frequency) ? frequency : 0, pins, ips };
}
/** 读某个芯片的 MCU XML。mcuName 就是 .ioc 里的 Mcu.Name，例如 STM32F103C(8-B)Tx。 */
export function readMcuFacts(db, mcuName) {
    const file = join(db.root, "mcu", mcuName + ".xml");
    if (!existsSync(file))
        return null;
    return parseMcuXml(readFileSync(file, "utf8"));
}
/**
 * 逻辑引脚名 → db 引脚名：先精确匹配，再按「去掉 -XXX 后缀」匹配，
 * 最后按 Position 最近的同端口引脚兜底（PA0 → PA0-WKUP、PC13 → PC13-TAMPER-RTC）。
 */
export function resolveDbPinName(facts, logical) {
    if (facts.pins.has(logical))
        return logical;
    const wanted = logical.trim().toUpperCase();
    for (const name of facts.pins.keys()) {
        const base = name.split("-")[0];
        if (base.toUpperCase() === wanted)
            return name;
    }
    return null;
}
/** 反查：db 引脚名 → 逻辑名（PA0-WKUP → PA0、PC13-TAMPER-RTC → PC13）。 */
export function logicalPinName(dbName) {
    return dbName.split("-")[0] ?? dbName;
}
/** 该芯片是否有这个 IP 实例（TIM3、ADC1…）。 */
export function hasIpInstance(facts, instanceName) {
    return facts.ips.has(instanceName.trim().toUpperCase());
}
/** 某个 IP 实例的 Modes 文件路径（db/mcu/IP/<Name>-<Version>_Modes.xml）。 */
export function ipModesPath(db, facts, instanceName) {
    const ip = facts.ips.get(instanceName.trim().toUpperCase());
    if (ip === undefined)
        return null;
    const file = join(db.root, "mcu", "IP", ip.name + "-" + ip.version + "_Modes.xml");
    return existsSync(file) ? file : null;
}
/** 读某个 IP 的合法模式名（RefMode Name=…），例如 PWM Generation1 CH1。 */
export function readIpModeNames(db, facts, instanceName) {
    const file = ipModesPath(db, facts, instanceName);
    if (file === null)
        return [];
    const text = readFileSync(file, "utf8");
    const names = [];
    for (const match of text.matchAll(/<RefMode\b[^>]*Name="([^"]+)"/gu))
        names.push(match[1]);
    return [...new Set(names)];
}
