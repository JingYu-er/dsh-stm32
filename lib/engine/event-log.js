/**
 * 把被环形缓冲挤出的事件定期落到证据目录。
 *
 * 分工：event-bus.ts 只管内存与序号，本文件只管「什么时候写、写到哪」。
 * 这样事件流在面板里永远是内存直读（毫秒级），磁盘写失败也不会拖慢工具调用。
 *
 * 落盘布局（每个会话一个目录）：
 *   <root>/<yyyy-mm-dd>/<sessionKey>/events-<HHmmss>.jsonl
 * 每批一个文件，按批次的起始时刻命名，复盘时按文件名排序即为时间顺序。
 */
import { readFileSync } from "node:fs";
import { appendFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { toolchainConfigPath } from "../data/toolchain-config.js";
import { drainEvicted, eventSessionKey, eventSnapshot, requeueEvicted, takeDroppedCount, } from "./event-bus.js";
/** 默认落盘间隔。一批之内的事件共用一个文件。 */
export const EVENT_LOG_INTERVAL_MS = 30_000;
/** 证据目录保留的会话数上限：超出时先删最老的会话目录。 */
export const EVENT_EVIDENCE_KEEP_SESSIONS = 20;
/** 证据目录保留天数上限：超过这个天数的日期目录整体删掉。 */
export const EVENT_EVIDENCE_KEEP_DAYS = 7;
/** 允许范围：落盘 5 秒–1 小时；保留天数 0（不按天清）–365；会话数 1–200。 */
const POLICY_LIMITS = {
    flushSeconds: { min: 5, max: 3600, fallback: 30 },
    keepDays: { min: 0, max: 365, fallback: 7 },
    keepSessions: { min: 1, max: 200, fallback: 20 },
};
function readPolicyConfig(env) {
    const flag = env["DSH_STM32_NO_CONFIG"];
    if (flag === "1" || flag === "true")
        return null;
    try {
        const text = readFileSync(toolchainConfigPath(env), "utf8");
        const parsed = JSON.parse(text);
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
function pickNumber(key, envKey, env, config) {
    const limits = POLICY_LIMITS[key];
    const fromEnv = env[envKey];
    if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
        const parsed = Number.parseInt(fromEnv.trim(), 10);
        if (Number.isFinite(parsed)) {
            return { value: Math.min(limits.max, Math.max(limits.min, parsed)), source: "env " + envKey };
        }
        return { value: limits.fallback, source: "default（" + envKey + " 不是整数）" };
    }
    const fromConfig = config === null ? undefined : config["evidence" + key.charAt(0).toUpperCase() + key.slice(1)];
    if (typeof fromConfig === "number" && Number.isFinite(fromConfig)) {
        return { value: Math.min(limits.max, Math.max(limits.min, Math.round(fromConfig))), source: "config evidence" + key.charAt(0).toUpperCase() + key.slice(1) };
    }
    return { value: limits.fallback, source: "default" };
}
/**
 * 读出证据策略（S78）：环境变量优先，其次配置文件，最后默认值。
 *
 * 落盘间隔与保留口径都允许改；越界一律夹到允许范围，非法值退回默认。
 */
export function evidencePolicy(env = process.env) {
    const config = readPolicyConfig(env);
    const flush = pickNumber("flushSeconds", "DSH_STM32_EVIDENCE_FLUSH_SECONDS", env, config);
    const days = pickNumber("keepDays", "DSH_STM32_EVIDENCE_KEEP_DAYS", env, config);
    const sessions = pickNumber("keepSessions", "DSH_STM32_EVIDENCE_KEEP_SESSIONS", env, config);
    return {
        flushSeconds: flush.value,
        keepDays: days.value,
        keepSessions: sessions.value,
        sources: { flushSeconds: flush.source, keepDays: days.source, keepSessions: sessions.source },
    };
}
/** 证据目录根：允许用环境变量改到别处（例如放到工程内便于随工程归档）。 */
export function evidenceRoot(env = process.env) {
    const custom = env.DSH_STM32_EVIDENCE;
    if (typeof custom === "string" && custom.trim() !== "")
        return path.resolve(custom.trim());
    return path.join(homedir(), ".dsh-stm32", "evidence");
}
/** 会话键要能当目录名：只留安全字符，空的退回 unbound。 */
export function safeSessionKey(key) {
    const cleaned = key.trim().replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
    return cleaned === "" ? "unbound" : cleaned.slice(0, 80);
}
function pad(value) {
    return value < 10 ? "0" + String(value) : String(value);
}
/** 日期目录：按本地日期分，便于人找。 */
export function dateFolder(now) {
    return now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
}
function timeName(now) {
    return pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
}
/** 某会话在某一时刻的证据目录。 */
export function sessionEvidenceDir(root, key, now) {
    return path.join(root, dateFolder(now), safeSessionKey(key));
}
function eventLine(event) {
    return JSON.stringify(event) + "\n";
}
/** 已经写进证据目录的最大序号；换会话时归零，避免把别的会话的序号当基线。 */
let archivedSeq = 0;
let archivedKey = "";
/** 测试用：把归档游标归零。 */
export function resetArchiveCursor() {
    archivedSeq = 0;
    archivedKey = "";
}
/**
 * 写一批事件并返回写入信息。
 *
 * 目录与文件名规则只在这里实现一次：`flushEvicted` 与 `flushPending` 共用。
 */
async function writeBatch(events, options) {
    const dir = sessionEvidenceDir(options.root, options.key, options.now);
    const file = path.join(dir, "events-" + timeName(options.now) + ".jsonl");
    const lines = [];
    if (options.dropped > 0) {
        // 缺口本身要留痕：否则证据目录看起来连续，实际中间丢了条目。
        lines.push(eventLine({
            seq: events.length > 0 ? (events[0]?.seq ?? 0) : 0,
            time: options.now.toISOString(),
            source: "system",
            kind: "log",
            status: "fail",
            summary: "落盘通道积压，丢弃 " + String(options.dropped) + " 条事件",
            payload: { dropped: options.dropped },
        }));
    }
    for (const event of events)
        lines.push(eventLine(event));
    await mkdir(dir, { recursive: true });
    await appendFile(file, lines.join(""), "utf8");
    return { written: events.length, file };
}
/**
 * 写一批被挤出的事件。成功返回写入条数；失败把事件放回队列并抛出，由调用方决定是否重试。
 */
export async function flushEvicted(options = {}) {
    const now = options.now ?? new Date();
    const dropped = takeDroppedCount();
    const events = drainEvicted();
    if (events.length === 0 && dropped === 0)
        return { written: 0, file: null, dropped: 0 };
    const key = eventSessionKey() === "" ? "unbound" : eventSessionKey();
    const root = options.root ?? evidenceRoot(options.env);
    const dir = sessionEvidenceDir(root, key, now);
    try {
        const result = await writeBatch(events, { root, now, key, dropped });
        return { written: result.written, file: result.file, dropped };
    }
    catch (error) {
        requeueEvicted(events);
        throw error;
    }
}
/**
 * 写「还没落盘的」事件（S72）：溢出队列 + 环形缓冲里序号超过游标的部分。
 *
 * 正常会话不再等到溢出才留证据——每拍把新事件写一份，重启后仍能回放。
 * 游标记的是「已写过」的最大序号，所以同一事件不会写两遍。
 */
export async function flushPending(options = {}) {
    const now = options.now ?? new Date();
    const key = eventSessionKey() === "" ? "unbound" : eventSessionKey();
    if (key !== archivedKey) {
        archivedKey = key;
        archivedSeq = 0;
    }
    const dropped = takeDroppedCount();
    // 只归档本会话的事件：换会话后 ring 里还有上一个会话的条目，不能重复写进新目录。
    const mine = (event) => event.session === undefined || event.session === key;
    const evicted = drainEvicted().filter((event) => event.seq > archivedSeq && mine(event));
    const recent = eventSnapshot(archivedSeq).filter(mine);
    const events = evicted.concat(recent);
    if (events.length === 0 && dropped === 0)
        return { written: 0, file: null, dropped: 0 };
    const root = options.root ?? evidenceRoot(options.env);
    try {
        const result = await writeBatch(events, { root, now, key, dropped });
        const last = events[events.length - 1];
        if (last !== undefined)
            archivedSeq = last.seq;
        return { written: result.written, file: result.file, dropped };
    }
    catch (error) {
        requeueEvicted(evicted);
        throw error;
    }
}
/**
 * 清理旧证据：按「日期目录超过 N 天」与「会话目录超过 M 个」两条规则，先算后删。
 *
 * 只删本插件自己的目录布局（<root>/<yyyy-mm-dd>/<会话>），遇到不合布局的条目跳过，
 * 绝不递归删 root 本身。
 */
export async function pruneEvidence(options = {}) {
    const root = options.root ?? evidenceRoot(options.env);
    const now = options.now ?? new Date();
    const keepSessions = options.keepSessions ?? EVENT_EVIDENCE_KEEP_SESSIONS;
    const keepDays = options.keepDays ?? EVENT_EVIDENCE_KEEP_DAYS;
    const removedDirs = [];
    let removedFiles = 0;
    let removedBytes = 0;
    const measure = async (dir) => {
        let files = 0;
        let bytes = 0;
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        }
        catch {
            return { files, bytes };
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const inner = await measure(full);
                files += inner.files;
                bytes += inner.bytes;
                continue;
            }
            try {
                const info = await stat(full);
                files += 1;
                bytes += info.size;
            }
            catch {
                // 文件刚被别处删掉：不计入即可。
            }
        }
        return { files, bytes };
    };
    let dayDirs = [];
    try {
        dayDirs = (await readdir(root, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/u.test(entry.name))
            .map((entry) => entry.name);
    }
    catch {
        return { removedDirs, removedFiles, removedBytes };
    }
    const cutoff = new Date(now.getTime() - keepDays * 24 * 60 * 60 * 1000);
    const liveDays = [];
    for (const day of dayDirs) {
        const at = new Date(day + "T00:00:00");
        if (Number.isNaN(at.getTime()))
            continue;
        if (at.getTime() < cutoff.getTime()) {
            const full = path.join(root, day);
            const size = await measure(full);
            await rm(full, { recursive: true, force: true });
            removedDirs.push(day);
            removedFiles += size.files;
            removedBytes += size.bytes;
            continue;
        }
        liveDays.push(day);
    }
    // 会话数按「最新 mtime 的会话目录」排序保留；跨日期目录一起算。
    const sessions = [];
    liveDays.sort();
    for (const day of liveDays) {
        const dayDir = path.join(root, day);
        let entries;
        try {
            entries = await readdir(dayDir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            const full = path.join(dayDir, entry.name);
            let mtimeMs = 0;
            try {
                mtimeMs = (await stat(full)).mtimeMs;
            }
            catch {
                continue;
            }
            sessions.push({ full, relative: day + "/" + entry.name, mtimeMs });
        }
    }
    if (sessions.length > keepSessions) {
        sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
        for (const stale of sessions.slice(keepSessions)) {
            const size = await measure(stale.full);
            await rm(stale.full, { recursive: true, force: true });
            removedDirs.push(stale.relative);
            removedFiles += size.files;
            removedBytes += size.bytes;
        }
    }
    return { removedDirs, removedFiles, removedBytes };
}
/**
 * 启动定期落盘。返回停止函数（停止时再冲一次，尽量把内存里的挤出条目落完）。
 *
 * onError 只用于把失败报给宿主日志；默认静默，避免磁盘问题刷屏。
 */
export function startEventLog(options = {}) {
    const policy = evidencePolicy(options.env);
    const intervalMs = options.intervalMs ?? policy.flushSeconds * 1000;
    let running = false;
    const tick = async () => {
        if (running)
            return;
        running = true;
        try {
            // 每拍把新事件也写一份（S72）：不再只有溢出才留证据。
            await flushPending({ root: options.root, env: options.env });
            await pruneEvidence({ root: options.root, env: options.env, keepDays: policy.keepDays, keepSessions: policy.keepSessions });
        }
        catch (error) {
            options.onError?.(error);
        }
        finally {
            running = false;
        }
    };
    const timer = setInterval(() => {
        void tick();
    }, intervalMs);
    if (typeof timer.unref === "function")
        timer.unref();
    return async () => {
        clearInterval(timer);
        await tick();
    };
}
