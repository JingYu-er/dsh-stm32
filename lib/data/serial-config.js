/**
 * 串口配置与「端口记忆」（数据层）：%USERPROFILE%/.dsh-stm32/serial.json
 *
 * 为什么不塞进 config.json：那份记的是「这台机器把工具装在哪」，是安装器写的、变一次要重装；
 * 这份记的是「这块板子上次用什么参数通的」，每 open 一次就可能写一次。读写频率差两个数量级，
 * 混在一起会让安装配置跟着串口一起坏——这份坏了大不了丢记忆，不该连累工具链配置。
 *
 * 记忆的单位是 **USB 身份，不是 COM 号**：同一块板子换个 USB 口，Windows 会新分一个 COM 号
 * （COM5 → COM7），按 COM 号记等于每次都要重设波特率。身份按可靠度分三档：
 *   usb:<VID>:<PID>:<序列号>   —— 最可靠（每块板子唯一，换口换机器都认得出）
 *   usb:<VID>:<PID>@<位置>     —— 芯片没烧序列号（CH340 常见），退一步按 USB 端口路径区分
 *   com:<COMx>                 —— 不是 USB（板载 UART / 蓝牙串口），只能按名字记
 * 三档都由 portIdentity() 一处决定，engine 与本文件不各写一套。
 *
 * 环境变量：
 *   DSH_STM32_SERIAL_CONFIG  整体改指配置文件（单测与多工程隔离用；相对路径按主目录解析）
 *   DSH_STM32_NO_CONFIG=1    让读配置的地方当它不存在（与 config.json 同一套开关语义）
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute } from "node:path";
export const SERIAL_CONFIG_VERSION = 1;
/** 最多记多少个端口；超了按最后使用时间淘汰最旧的（USB 口多的机器不至于无限长）。 */
export const MAX_REMEMBERED_PORTS = 32;
/** 枚举的运行时形态：工具的 schema enum 与校验都从这里取，避免第二个真相。 */
export const SERIAL_PARITIES = ["none", "odd", "even", "mark", "space"];
export const SERIAL_STOP_BITS = ["1", "1.5", "2"];
export const SERIAL_FLOWS = ["none", "xonxoff", "rtscts"];
export const SERIAL_ENCODINGS = ["utf8", "ascii", "latin1"];
export const SERIAL_NEWLINES = ["crlf", "lf", "none"];
/** 缺省参数：115200 8N1、无流控、DTR/RTS 都不动、UTF-8、发 CRLF。 */
export function defaultSerialSettings() {
    return {
        baudRate: 115200,
        dataBits: 8,
        stopBits: "1",
        parity: "none",
        flow: "none",
        dtr: false,
        rts: false,
        encoding: "utf8",
        newline: "crlf",
    };
}
export const SERIAL_BAUD_MIN = 50;
export const SERIAL_BAUD_MAX = 4_000_000;
export const SERIAL_DATA_BITS_MIN = 5;
export const SERIAL_DATA_BITS_MAX = 8;
function asString(value) {
    return typeof value === "string" ? value.trim() : "";
}
/**
 * DTR/RTS 只认真正的布尔值，外加 "true"/"false"/"1"/"0" 这些常见字符串写法。
 * 认不出来返回 null（由调用方记一条错误）——悄悄回落到缺省值会让"我明明设了 rts"变成静默无效。
 */
function asOptionalBoolean(value) {
    if (typeof value === "boolean")
        return value;
    if (typeof value === "string") {
        const text = value.trim().toLowerCase();
        if (text === "true" || text === "1")
            return true;
        if (text === "false" || text === "0")
            return false;
    }
    return null;
}
function asInteger(value) {
    if (typeof value === "number" && Number.isInteger(value))
        return value;
    if (typeof value === "string" && /^\d+$/u.test(value.trim()))
        return Number.parseInt(value.trim(), 10);
    return null;
}
function oneOf(value, allowed) {
    const text = asString(value).toLowerCase();
    if (text === "")
        return null;
    return allowed.includes(text) ? text : null;
}
/**
 * 把任意 JSON / 工具参数归一成合法参数：非法的字段按缺省值处理并记一条 errors。
 * 不抛异常——参数写错要能变成 settings-invalid 的一次报告，而不是把调用方打崩。
 */
export function normalizeSerialSettings(raw, errors, base = defaultSerialSettings()) {
    const out = { ...base };
    if (raw === null || raw === undefined)
        return out;
    if (typeof raw !== "object") {
        errors.push("串口参数不是对象，已按缺省值处理");
        return out;
    }
    const record = raw;
    const baud = asInteger(record["baudRate"]);
    if (baud !== null) {
        if (baud < SERIAL_BAUD_MIN || baud > SERIAL_BAUD_MAX) {
            errors.push("baudRate 超出范围（" + String(SERIAL_BAUD_MIN) + "…" + String(SERIAL_BAUD_MAX) + "）：" + String(baud));
        }
        else {
            out.baudRate = baud;
        }
    }
    else if (record["baudRate"] !== undefined) {
        errors.push("baudRate 不是整数");
    }
    const bits = asInteger(record["dataBits"]);
    if (bits !== null) {
        if (bits < SERIAL_DATA_BITS_MIN || bits > SERIAL_DATA_BITS_MAX) {
            errors.push("dataBits 只能是 5…8：" + String(bits));
        }
        else {
            out.dataBits = bits;
        }
    }
    else if (record["dataBits"] !== undefined) {
        errors.push("dataBits 不是整数");
    }
    const stop = oneOf(record["stopBits"], SERIAL_STOP_BITS);
    if (stop !== null)
        out.stopBits = stop;
    else if (record["stopBits"] !== undefined && asString(record["stopBits"]) !== "")
        errors.push("stopBits 只能是 1 / 1.5 / 2");
    const parity = oneOf(record["parity"], SERIAL_PARITIES);
    if (parity !== null)
        out.parity = parity;
    else if (record["parity"] !== undefined && asString(record["parity"]) !== "")
        errors.push("parity 只能是 none / odd / even / mark / space");
    const flow = oneOf(record["flow"], SERIAL_FLOWS);
    if (flow !== null)
        out.flow = flow;
    else if (record["flow"] !== undefined && asString(record["flow"]) !== "")
        errors.push("flow 只能是 none / xonxoff / rtscts");
    const encoding = oneOf(record["encoding"], SERIAL_ENCODINGS);
    if (encoding !== null)
        out.encoding = encoding;
    else if (record["encoding"] !== undefined && asString(record["encoding"]) !== "")
        errors.push("encoding 只能是 utf8 / ascii / latin1");
    const newline = oneOf(record["newline"], SERIAL_NEWLINES);
    if (newline !== null)
        out.newline = newline;
    else if (record["newline"] !== undefined && asString(record["newline"]) !== "")
        errors.push("newline 只能是 crlf / lf / none");
    const dtr = asOptionalBoolean(record["dtr"]);
    if (dtr !== null)
        out.dtr = dtr;
    else if (record["dtr"] !== undefined)
        errors.push("dtr 只能是 true / false");
    const rts = asOptionalBoolean(record["rts"]);
    if (rts !== null)
        out.rts = rts;
    else if (record["rts"] !== undefined)
        errors.push("rts 只能是 true / false");
    return out;
}
/** 参数是否与缺省值一致（报告里用来提示「这次哪些参数是默认的」）。 */
export function settingsAreDefault(settings) {
    const base = defaultSerialSettings();
    return Object.keys(base).every((key) => settings[key] === base[key]);
}
function text(value) {
    return typeof value === "string" ? value.trim() : "";
}
/** Windows 用总线路径当序列号时的形状：5&2c1a4b3&0&1；这种值换个口就变，不能当身份。 */
function isBusPathId(value) {
    return /^\d+&/u.test(value);
}
/**
 * 端口身份：三档按可靠度选第一档可用的。
 * 纯函数（只依赖 facts），engine 与配置层共用同一份判断，别各写一套。
 */
export function portIdentity(facts) {
    // 字段声明成 string，但调用方可能是「手工改过的 serial.json / 老版本记录」，
    // 缺字段时按空串处理，别让一个半截配置把整条打开流程打崩。
    const vid = text(facts.vid).toUpperCase();
    const pid = text(facts.pid).toUpperCase();
    const serial = text(facts.serialNumber);
    const location = text(facts.location);
    if (vid !== "" && pid !== "") {
        if (serial !== "" && !isBusPathId(serial))
            return "usb:" + vid + ":" + pid + ":" + serial;
        if (location !== "")
            return "usb:" + vid + ":" + pid + "@" + location;
        if (serial !== "")
            return "usb:" + vid + ":" + pid + "@" + serial;
        return "usb:" + vid + ":" + pid;
    }
    return "com:" + text(facts.port).toUpperCase();
}
/** 身份的可读形态（报告里给人看：usb:0483:5740@1-3.4 这种比一段 JSON 好认）。 */
export function describeIdentity(identity) {
    if (identity.startsWith("usb:"))
        return "USB " + identity.slice(4);
    if (identity.startsWith("com:"))
        return "端口名 " + identity.slice(4);
    return identity;
}
let cache = null;
function envValue(env, key) {
    const value = env[key];
    return value === undefined ? "" : value.trim();
}
function homeDir(env) {
    const userProfile = envValue(env, "USERPROFILE");
    if (userProfile !== "")
        return userProfile;
    const home = envValue(env, "HOME");
    if (home !== "")
        return home;
    return homedir();
}
function toPosix(value) {
    return value.replace(/\\/gu, "/").replace(/\/+$/u, "");
}
/** 配置文件路径：DSH_STM32_SERIAL_CONFIG 优先（相对路径按主目录解析）。 */
export function serialConfigPath(env = process.env) {
    const override = envValue(env, "DSH_STM32_SERIAL_CONFIG");
    if (override !== "")
        return isAbsolute(override) ? toPosix(override) : toPosix(homeDir(env) + "/" + override);
    return toPosix(homeDir(env)) + "/.dsh-stm32/serial.json";
}
/** 与 config.json 共用的总开关：关掉时所有读都当「没有配置」。 */
export function serialConfigReadingDisabled(env = process.env) {
    const flag = envValue(env, "DSH_STM32_NO_CONFIG");
    return flag === "1" || flag === "true";
}
export function defaultSerialConfig() {
    return { version: SERIAL_CONFIG_VERSION, ports: [], updatedAt: "" };
}
function normalizeMemory(raw, errors, index) {
    if (raw === null || typeof raw !== "object") {
        errors.push("第 " + String(index + 1) + " 条端口记忆不是对象，已丢弃");
        return null;
    }
    const record = raw;
    const identity = asString(record["identity"]);
    if (identity === "") {
        errors.push("第 " + String(index + 1) + " 条端口记忆没有 identity，已丢弃");
        return null;
    }
    return {
        identity,
        comPort: asString(record["comPort"]).toUpperCase(),
        description: asString(record["description"]),
        vid: asString(record["vid"]).toUpperCase(),
        pid: asString(record["pid"]).toUpperCase(),
        serialNumber: asString(record["serialNumber"]),
        location: asString(record["location"]),
        settings: normalizeSerialSettings(record["settings"], errors),
        lastUsedAt: asString(record["lastUsedAt"]),
        lastOkAt: asString(record["lastOkAt"]),
        openCount: Math.max(0, asInteger(record["openCount"]) ?? 0),
    };
}
/** 把任意 JSON 归一成配置：坏条目丢一条记一条，绝不让整个文件失效。 */
export function normalizeSerialConfig(raw, errors) {
    if (raw === null || typeof raw !== "object") {
        errors.push("配置内容不是对象，已按空配置处理");
        return defaultSerialConfig();
    }
    const record = raw;
    const list = Array.isArray(record["ports"]) ? record["ports"] : [];
    if (record["ports"] !== undefined && !Array.isArray(record["ports"])) {
        errors.push("ports 不是数组，已按空列表处理");
    }
    const ports = [];
    const seen = new Set();
    for (let i = 0; i < list.length; i += 1) {
        const memory = normalizeMemory(list[i], errors, i);
        if (memory === null)
            continue;
        if (seen.has(memory.identity))
            continue;
        seen.add(memory.identity);
        ports.push(memory);
    }
    return {
        version: typeof record["version"] === "number" ? record["version"] : SERIAL_CONFIG_VERSION,
        ports,
        updatedAt: asString(record["updatedAt"]),
    };
}
export function readSerialConfig(env = process.env) {
    const path = serialConfigPath(env);
    if (serialConfigReadingDisabled(env))
        return { path, exists: false, config: null, errors: [], mtimeMs: 0 };
    let mtimeMs = 0;
    let size = -1;
    try {
        const stat = statSync(path);
        mtimeMs = stat.mtimeMs;
        size = stat.size;
    }
    catch {
        cache = null;
        return { path, exists: false, config: null, errors: [], mtimeMs: 0 };
    }
    if (cache !== null && cache.path === path && cache.mtimeMs === mtimeMs && cache.size === size)
        return cache.read;
    let text = "";
    try {
        text = readFileSync(path, "utf8");
    }
    catch (error) {
        const read = {
            path,
            exists: true,
            config: null,
            errors: ["串口配置文件读不了：" + describeError(error)],
            mtimeMs,
        };
        cache = { path, mtimeMs, size, read };
        return read;
    }
    const errors = [];
    let parsed = null;
    try {
        parsed = text.trim() === "" ? null : JSON.parse(text);
    }
    catch (error) {
        const read = {
            path,
            exists: true,
            config: null,
            errors: ["串口配置文件不是合法 JSON：" + describeError(error) + "；已按无记忆处理（重新写入会覆盖它）"],
            mtimeMs,
        };
        cache = { path, mtimeMs, size, read };
        return read;
    }
    const config = parsed === null ? defaultSerialConfig() : normalizeSerialConfig(parsed, errors);
    const read = { path, exists: true, config, errors, mtimeMs };
    cache = { path, mtimeMs, size, read };
    return read;
}
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
/** 原子写：同目录 tmp + rename。半截 JSON 比没有记忆更糟（下次直接整份失效）。 */
export function writeSerialConfig(config, env = process.env) {
    const path = serialConfigPath(env);
    const normalized = {
        version: SERIAL_CONFIG_VERSION,
        ports: config.ports.slice(0, MAX_REMEMBERED_PORTS),
        updatedAt: new Date().toISOString(),
    };
    const body = JSON.stringify(normalized, null, 2) + "\n";
    const tmpPath = path + ".tmp-" + String(process.pid) + "-" + randomBytes(4).toString("hex");
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(tmpPath, body, "utf8");
        renameSync(tmpPath, path);
    }
    catch (error) {
        try {
            if (existsSync(tmpPath))
                unlinkSync(tmpPath);
        }
        catch {
            // 清理失败不影响主错误
        }
        cache = null;
        return { ok: false, path, error: "写串口配置失败：" + describeError(error) };
    }
    cache = null;
    return { ok: true, path, error: "" };
}
/** 按身份找记忆；不是 USB 设备时退化成按 COM 号找。 */
export function findPortMemory(config, facts) {
    if (config === null)
        return null;
    const identity = portIdentity(facts);
    return config.ports.find((memory) => memory.identity === identity) ?? null;
}
/**
 * 取这块板子的历史参数。
 * 记忆只是「基准」：调用方显式给的参数永远覆盖它，缺省的字段才落到历史值上。
 */
export function recallPortSettings(facts, env = process.env) {
    const read = readSerialConfig(env);
    const memory = findPortMemory(read.config, facts);
    if (memory === null) {
        return { remembered: false, settings: defaultSerialSettings(), comPort: "", lastUsedAt: "", openCount: 0 };
    }
    return {
        remembered: true,
        // 老版本 / 手改过的记录里 settings 可能是半截的，这里再归一一次：
        // 记忆只负责「值是多少」，合法性永远由 normalizeSerialSettings 说了算。
        settings: normalizeSerialSettings(memory.settings, [], defaultSerialSettings()),
        comPort: text(memory.comPort),
        lastUsedAt: text(memory.lastUsedAt),
        openCount: typeof memory.openCount === "number" ? memory.openCount : 0,
    };
}
/**
 * 打开成功后记一笔：按身份 upsert，其余条目原样保留（别人的板子不能被我们的打开挤掉）。
 * 只记「这次真的通了」的参数——失败时调用方不该写，否则下次 recover 会复用一个错参数。
 */
export function rememberPort(facts, settings, env = process.env) {
    const identity = portIdentity(facts);
    if (serialConfigReadingDisabled(env))
        return { ok: false, identity, path: serialConfigPath(env), error: "配置读取被 DSH_STM32_NO_CONFIG 关掉了，没有写入" };
    const read = readSerialConfig(env);
    const base = read.config ?? defaultSerialConfig();
    const now = new Date().toISOString();
    const previous = base.ports.find((memory) => memory.identity === identity) ?? null;
    const entry = {
        identity,
        comPort: facts.port,
        description: facts.description,
        vid: text(facts.vid).toUpperCase(),
        pid: text(facts.pid).toUpperCase(),
        serialNumber: text(facts.serialNumber),
        location: text(facts.location),
        settings: normalizeSerialSettings(settings, []),
        lastUsedAt: now,
        lastOkAt: now,
        openCount: (previous?.openCount ?? 0) + 1,
    };
    const others = base.ports.filter((memory) => memory.identity !== identity);
    const ports = [entry, ...others]
        .sort((left, right) => (right.lastUsedAt > left.lastUsedAt ? 1 : right.lastUsedAt < left.lastUsedAt ? -1 : 0))
        .slice(0, MAX_REMEMBERED_PORTS);
    const written = writeSerialConfig({ version: SERIAL_CONFIG_VERSION, ports, updatedAt: now }, env);
    return { ok: written.ok, identity, path: written.path, error: written.error };
}
/** 单测用：清掉 mtime 缓存。 */
export function resetSerialConfigCache() {
    cache = null;
}
