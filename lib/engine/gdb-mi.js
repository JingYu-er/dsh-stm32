/**
 * L2：gdb MI 常驻会话（P3）。
 *
 * 为什么要有这一层：`stm32_debug_eval` 原来是"每次调用临时起一个 gdb -batch → 连上 → 跑几条命令 →
 * detach"，断点、变量、栈这些状态在调用之间全丢，而且每次都要重连（实测约 1.5 s）。排障时想
 * "先断在 HardFault_Handler，再连读几次栈/寄存器"，这条路根本走不通。
 *
 * MI（Machine Interface）是 gdb 的机器可读协议（`--interpreter=mi2`）：命令带 token、
 * 结果以 `^done`/`^error`/`^running` 回，异步事件以 `*stopped`/`*running` 推。VS Code 的
 * C/C++ 调试器也是这么驱动 gdb 的。这里实现最小可用子集：结果/异步记录解析、带 token 的请求队列、
 * 把 `~"..."` 控制台流关联到当前请求（否则 `print` 的输出无法确定归属）。
 *
 * 只读设计约束：零依赖、可单测（解析是纯函数；进程通过 MiSpawner 注入，测试给假进程）。
 */
import { spawn } from "node:child_process";
/**
 * 步进命令映射到 MI 的 -exec-*：n/next、s/step 走整行（-exec-next / -exec-step），
 * ni/nexti、si/stepi 走单指令（-exec-next-instruction / -exec-step-instruction）。
 * continue 不在此处（由 continueTarget 处理，需先清除旧的停止记录）。返回 null 表示不是步进命令。
 */
export function steppingCommandFor(command) {
    const normalized = command.trim().toLowerCase();
    if (normalized === "n" || normalized === "next")
        return "-exec-next";
    if (normalized === "s" || normalized === "step")
        return "-exec-step";
    if (normalized === "ni" || normalized === "nexti")
        return "-exec-next-instruction";
    if (normalized === "si" || normalized === "stepi")
        return "-exec-step-instruction";
    return null;
}
/** 把 *stopped 记录描述成一行「func file:line @addr (reason)」，continue/step 报停点用。 */
export function formatStopLocation(record) {
    const reason = typeof record.data["reason"] === "string" ? record.data["reason"] : "";
    const parts = [];
    const frame = record.data["frame"];
    if (typeof frame === "object" && frame !== null) {
        const item = frame;
        const func = typeof item["func"] === "string" ? item["func"] : "";
        const file = typeof item["file"] === "string" ? item["file"] : "";
        const line = typeof item["line"] === "string" ? item["line"] : typeof item["line"] === "number" ? String(item["line"]) : "";
        const addr = typeof item["addr"] === "string" ? item["addr"] : "";
        if (func !== "")
            parts.push(func);
        if (file !== "" && line !== "")
            parts.push(file + ":" + line);
        else if (line !== "")
            parts.push("行 " + line);
        if (addr !== "")
            parts.push("@" + addr);
    }
    if (reason !== "")
        parts.push("(" + reason + ")");
    return parts.length === 0 ? "位置未知" : parts.join(" ");
}
/** MI 的 C 字符串转义：\\ \" \n \t \r 以及 \xNN。 */
export function decodeMiString(text) {
    let out = "";
    for (let index = 0; index < text.length; index += 1) {
        const ch = text[index];
        if (ch !== "\\") {
            out += ch;
            continue;
        }
        const next = text[index + 1] ?? "";
        index += 1;
        if (next === "n")
            out += "\n";
        else if (next === "t")
            out += "\t";
        else if (next === "r")
            out += "\r";
        else if (next === "0")
            out += "\0";
        else if (next === "x") {
            const hex = text.slice(index + 1, index + 3);
            const parsed = Number.parseInt(hex, 16);
            if (Number.isFinite(parsed)) {
                out += String.fromCharCode(parsed);
                index += 2;
            }
        }
        else
            out += next;
    }
    return out;
}
/** 解析一个 MI 值：带引号的字符串、{...} tuple、或裸 token。返回解析后的值与下一处位置。 */
export function parseMiValue(text, start = 0) {
    let index = start;
    while (index < text.length && text[index] === " ")
        index += 1;
    const first = text[index] ?? "";
    if (first === '"') {
        index += 1;
        let raw = "";
        while (index < text.length) {
            const ch = text[index];
            if (ch === "\\") {
                raw += ch + (text[index + 1] ?? "");
                index += 2;
                continue;
            }
            if (ch === '"')
                return { value: decodeMiString(raw), next: index + 1 };
            raw += ch;
            index += 1;
        }
        return { value: decodeMiString(raw), next: index };
    }
    if (first === "{") {
        const parsed = parseMiTuple(text, index + 1);
        return { value: parsed.data, next: parsed.next };
    }
    if (first === "[") {
        // MI 的列表元素是「结果」不是「值」：stack=[frame={…},frame={…}] 的每一项都是 key=value。
        const items = [];
        let pos = index + 1;
        while (pos < text.length) {
            while (pos < text.length && (text[pos] === " " || text[pos] === ","))
                pos += 1;
            if (text[pos] === "]")
                return { value: items, next: pos + 1 };
            const eq = text.indexOf("=", pos);
            const closing = text.indexOf("]", pos);
            if (eq >= 0 && (closing < 0 || eq < closing)) {
                const key = text.slice(pos, eq).trim();
                const parsed = parseMiValue(text, eq + 1);
                items.push({ [key]: parsed.value });
                pos = parsed.next;
                continue;
            }
            const parsed = parseMiValue(text, pos);
            items.push(parsed.value);
            pos = parsed.next;
        }
        return { value: items, next: pos };
    }
    let raw = "";
    while (index < text.length && text[index] !== ",") {
        raw += text[index];
        index += 1;
    }
    return { value: raw.trim(), next: index };
}
export function parseMiTuple(text, start = 0) {
    const data = {};
    let index = start;
    while (index < text.length) {
        while (index < text.length && (text[index] === " " || text[index] === ","))
            index += 1;
        if (text[index] === "}")
            return { data, next: index + 1 };
        const eq = text.indexOf("=", index);
        if (eq < 0)
            return { data, next: text.length };
        const key = text.slice(index, eq).trim();
        const parsed = parseMiValue(text, eq + 1);
        data[key] = parsed.value;
        index = parsed.next;
    }
    return { data, next: index };
}
/** 一行 MI 输出 → 记录；认不出返回 null（gdb 偶尔会吐空行/纯文本）。 */
export function parseMiLine(line) {
    const text = line.replace(/\r$/u, "");
    if (text === "")
        return null;
    if (text === "(gdb)")
        return { token: null, kind: "prompt", class: "", data: {}, text: "" };
    const match = /^(\d*)([\^\*\+=~@&])(.*)$/u.exec(text);
    if (match === null)
        return null;
    const token = (match[1] ?? "") === "" ? null : Number.parseInt(match[1], 10);
    const sigil = match[2];
    const rest = (match[3] ?? "").trim();
    if (sigil === "~" || sigil === "@" || sigil === "&") {
        const parsed = parseMiValue(rest, 0);
        const kind = sigil === "~" ? "console" : sigil === "@" ? "target" : "log";
        return { token, kind, class: "", data: {}, text: String(parsed.value ?? "") };
    }
    const comma = rest.indexOf(",");
    const head = comma < 0 ? rest : rest.slice(0, comma);
    const dataText = comma < 0 ? "" : rest.slice(comma + 1);
    const data = dataText === "" ? {} : parseMiTuple(dataText, 0).data;
    const kind = sigil === "^" ? "result" : sigil === "*" ? "exec" : sigil === "+" ? "status" : "notify";
    return { token, kind, class: head, data, text: "" };
}
/** 常驻的 gdb MI 会话：保持连接，命令按 token 排队，控制台输出关联到当前请求。 */
export class MiSession {
    child = null;
    buffer = "";
    token = 0;
    pending = null;
    lastStopped = null;
    /** 目标是否处于运行态。运行态下 gdb 不响应任何命令（含 console 的 break），因此操作前先检查该状态。 */
    runningState = false;
    stopWaiters = [];
    lastPromptResolve = null;
    exited = false;
    miLog = [];
    constructor() { }
    static async start(options) {
        const spawner = options.spawner ?? defaultSpawner;
        const session = new MiSession();
        const argv = [options.gdb, "--interpreter=mi2", "-q", "-nx"];
        session.child = spawner(argv, options.cwd ?? process.cwd());
        session.attach();
        // MI 模式下 gdb 不一定先吐提示符（而且 "(gdb) " 没有换行，按行读会一直卡着）。
        // 因此握手改为「发一条必须返回 ^done 的命令」：收到该回复即视为连接成功。
        await session.send("-gdb-set confirm off", options.timeoutMs ?? 20_000);
        await session.send("-gdb-set pagination off", options.timeoutMs ?? 20_000);
        if (options.elfPath !== undefined && options.elfPath !== "") {
            await session.send("-file-exec-and-symbols " + toGdbPath(options.elfPath), options.timeoutMs ?? 20_000);
        }
        await session.send("-target-select extended-remote 127.0.0.1:" + String(options.port), options.timeoutMs ?? 20_000);
        await session.console("monitor halt", options.timeoutMs ?? 20_000);
        return session;
    }
    get alive() {
        return this.child !== null && !this.exited;
    }
    /** 最近一次 *stopped 记录（断点命中/单步结束）。 */
    get stopped() {
        return this.lastStopped;
    }
    /** 目标现在是不是在跑（continue / monitor resume / 断点放过之后）。 */
    get targetRunning() {
        return this.runningState;
    }
    /** 会话日志（调试用：记录所有收到的记录类别）。 */
    get log() {
        return this.miLog;
    }
    attach() {
        const child = this.child;
        if (child === null)
            return;
        const onData = (chunk) => {
            this.buffer += chunk.toString();
            let index = this.buffer.indexOf("\n");
            while (index >= 0) {
                const line = this.buffer.slice(0, index);
                this.buffer = this.buffer.slice(index + 1);
                this.consume(line);
                index = this.buffer.indexOf("\n");
            }
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.on("exit", () => {
            this.exited = true;
            const pending = this.pending;
            if (pending !== null) {
                clearTimeout(pending.timer);
                this.pending = null;
                pending.reject(new Error("gdb 进程已退出"));
            }
        });
        child.on("error", () => {
            this.exited = true;
        });
    }
    consume(rawLine) {
        // gdb 的 "(gdb) " 提示符没有换行，会和下一条记录黏在一行里，先剥掉。
        const line = rawLine.replace(/^(?:\(gdb\)\s*)+/u, "").trimEnd();
        if (line === "") {
            const resolve = this.lastPromptResolve;
            this.lastPromptResolve = null;
            resolve?.();
            return;
        }
        const record = parseMiLine(line);
        if (record === null)
            return;
        // 目标重新跑起来（^running / *running）后，旧的停止记录就作废——否则 waitStopped
        // 会把上一条（比如 start 时 monitor halt 产生的）当成这次 continue 的结果。
        if (record.class === "running") {
            this.runningState = true;
            this.lastStopped = null;
        }
        if (record.kind === "prompt") {
            const resolve = this.lastPromptResolve;
            this.lastPromptResolve = null;
            resolve?.();
            return;
        }
        if (record.kind === "console" || record.kind === "target" || record.kind === "log") {
            if (this.pending !== null)
                this.pending.text += record.text;
            this.miLog.push(record.kind + ":" + record.text.trimEnd());
            return;
        }
        if (record.kind === "exec") {
            if (record.class === "stopped") {
                this.runningState = false;
                this.lastStopped = record;
                const waiters = this.stopWaiters;
                this.stopWaiters = [];
                for (const waiter of waiters)
                    waiter(record);
                // 已经被 waitStopped 取走的停止记录不再留档，避免下一次重复报告。
                if (waiters.length > 0)
                    this.lastStopped = null;
            }
            this.miLog.push("exec:" + record.class);
            return;
        }
        if (record.kind === "result") {
            const pending = this.pending;
            if (pending !== null && record.token === pending.token) {
                clearTimeout(pending.timer);
                this.pending = null;
                pending.resolve({ record, text: pending.text });
            }
            else if (record.token === null && pending !== null) {
                // 有些 gdb 版本对 -interpreter-exec 不给 token：归给当前请求。
                clearTimeout(pending.timer);
                this.pending = null;
                pending.resolve({ record, text: pending.text });
            }
        }
    }
    waitPrompt(timeoutMs) {
        if (this.exited)
            return Promise.reject(new Error("gdb 没起来"));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.lastPromptResolve = null;
                reject(new Error("等 gdb 提示符超时（" + String(timeoutMs) + " ms）"));
            }, timeoutMs);
            this.lastPromptResolve = () => {
                clearTimeout(timer);
                resolve();
            };
        });
    }
    /** 发送一条 MI 命令，等待该命令自身的 ^done/^error/^running。 */
    send(command, timeoutMs = 20_000) {
        const child = this.child;
        if (child === null || this.exited)
            return Promise.reject(new Error("gdb 会话已结束"));
        this.token += 1;
        const token = this.token;
        const line = String(token) + command + "\n";
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending !== null && this.pending.token === token)
                    this.pending = null;
                reject(new Error("gdb 命令超时（" + String(timeoutMs) + " ms）：" + command));
            }, timeoutMs);
            this.pending = { token, resolve, reject, text: "", timer };
            writeTo(child, line);
        });
    }
    /** 用 gdb 控制台语法执行（等价于 -interpreter-exec console），返回控制台输出文本。 */
    async console(command, timeoutMs = 20_000) {
        const result = await this.send('-interpreter-exec console "' + escapeMi(command) + '"', timeoutMs);
        if (result.record.class !== "error") {
            // monitor halt/resume 不会产生 *stopped / ^running，运行态只能从命令本身记。
            if (/^monitor\s+halt\b/iu.test(command))
                this.runningState = false;
            if (/^monitor\s+resume\b/iu.test(command))
                this.runningState = true;
        }
        return result;
    }
    /**
     * 确保目标停着。跑着就用 -exec-interrupt：运行态下 console 命令（连 "break"）都不会回，
     * 只有 -exec-interrupt 是异步感知的。返回 true 表示这次真的打断过。
     */
    async ensureHalted(timeoutMs = 10_000) {
        if (!this.runningState)
            return false;
        this.runningState = false;
        const result = await this.send("-exec-interrupt", timeoutMs);
        if (result.record.class === "error") {
            this.runningState = true;
            throw new Error("打断运行中的目标失败：" + String(result.record.data["msg"] ?? "未知原因"));
        }
        return true;
    }
    /** 求值一个 gdb 表达式，返回打印出来的字符串（如 "0x20004fd0"）。 */
    async evaluate(expression, timeoutMs = 20_000) {
        const result = await this.send("-data-evaluate-expression " + JSON.stringify(expression), timeoutMs);
        const value = result.record.data["value"];
        return typeof value === "string" ? value : result.text.trim();
    }
    /** -exec-continue：目标开跑，本方法在 ^running 时返回（不等到下一个断点）。 */
    async continueTarget(timeoutMs = 20_000) {
        this.lastStopped = null;
        const result = await this.send("-exec-continue", timeoutMs);
        return result.record;
    }
    /** -exec-interrupt：把跑着的目标停下来。 */
    async interrupt(timeoutMs = 10_000) {
        const result = await this.send("-exec-interrupt", timeoutMs);
        return result.record;
    }
    /** -stack-list-frames：拿调用栈（每帧 level/func/addr/file/line）。 */
    async stackFrames(timeoutMs = 20_000) {
        const result = await this.send("-stack-list-frames", timeoutMs);
        const frames = result.record.data["stack"];
        if (!Array.isArray(frames))
            return [];
        const out = [];
        for (const item of frames) {
            if (typeof item !== "object" || item === null)
                continue;
            const frame = item["frame"];
            if (typeof frame === "object" && frame !== null)
                out.push(frame);
        }
        return out;
    }
    /**
     * 等下一个 *stopped（断点命中/单步结束/信号）。
     * continueTarget / -exec-next 只在 ^running 时返回，真正"停在哪"要靠这个方法。
     */
    waitStopped(timeoutMs = 20_000) {
        const stopped = this.lastStopped;
        if (stopped !== null) {
            // 已经停住了（比如断点在别的命令里命中了）：立刻返回并标记已消费。
            this.lastStopped = null;
            return Promise.resolve(stopped);
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.stopWaiters = this.stopWaiters.filter((item) => item !== waiter);
                reject(new Error("等 *stopped 超时（" + String(timeoutMs) + " ms）"));
            }, timeoutMs);
            const waiter = (record) => {
                clearTimeout(timer);
                resolve(record);
            };
            this.stopWaiters.push(waiter);
        });
    }
    /** 结束会话：-gdb-exit，超时就 kill。 */
    async stop(timeoutMs = 5000) {
        if (this.child === null || this.exited)
            return;
        try {
            await this.send("-gdb-exit", timeoutMs);
        }
        catch {
            // 退出时 gdb 常不返回 ^done：忽略，随后由回退路径 kill。
        }
        const child = this.child;
        this.child = null;
        try {
            child.kill();
        }
        catch {
            // 已经退出就无所谓。
        }
    }
}
/** MI 命令里的字符串转义。 */
export function escapeMi(text) {
    return text.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}
/** Windows 路径 → gdb 认的斜杠路径。 */
export function toGdbPath(path) {
    return path.replace(/\\/gu, "/");
}
function writeTo(child, line) {
    const writer = child.stdin;
    if (writer?.write !== undefined)
        writer.write(line);
}
const defaultSpawner = (argv, cwd) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"] });
    return child;
};
