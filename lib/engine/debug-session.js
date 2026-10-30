/**
 * L2：租约式调试会话（规格 §6）。
 *
 * 三种形态里最危险的是"常驻 gdb"——会挡住用户在 VS Code 里按 F5。这里的做法：
 * - 常驻的**只有 openocd**（gdb server 占着探针，但这是唯一的占用者）；
 * - 每次 stm32_debug_eval 临时起一个 `gdb -batch` 连上去，跑完命令 → `monitor resume` → detach 退出，
 *   不在插件进程里留 gdb；
 * - 租约：空闲 90 s 自动关、总时长 10 min 硬上限；`turn/end`（agent 输出完、等你回复）立刻关；
 * - `build` / `flash` / `generate` 动手前先让会话让出探针（`releaseProbe`）。
 *
 * 探针只有一块：任何时刻只允许一个会话，重复 start 会先把旧的关掉。
 */
import { existsSync } from "node:fs";
import { resolveSearchConfig } from "../data/search-roots.js";
import { F1_BREAKPOINT_BUDGET, collectBreakpointRequests, planBreakpoints, quotaOf, resolveBreakpointBudget } from "./breakpoints.js";
import { pickPort, resolveElfPath } from "./debug.js";
import { defaultConfigs, findProjectConfig, toOpenOcdPath } from "./flash.js";
import { resolveToolIn } from "./probe.js";
import { runCapture } from "./subprocess-runner.js";
import { waitForListening } from "./debug.js";
const DEFAULT_IDLE_TTL_MS = 90_000;
const DEFAULT_HARD_TTL_MS = 10 * 60_000;
const SWEEP_MS = 5_000;
/**
 * 等 tcl 端口那行日志的宽限期。
 *
 * openocd 的三行 "Listening on port N for <svc> connections" 是分别打印的，而 waitForListening
 * 一见到第一行就返回；多等 120 ms 再把 collected 缓冲从头读一遍，才不会把 tcl 端口读丢
 * （读丢只是慢一点：快路径会回退到 gdb）。
 */
const TCL_PORT_SETTLE_MS = 120;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/** 把 "0x4001100c" / "4001100C" 统一成 8 位小写 0x 形式；解析不了返回 null。 */
export function normalizeHexAddress(text) {
    const body = text.trim().replace(/^0x/iu, "");
    if (!/^[0-9a-f]{1,8}$/iu.test(body))
        return null;
    return "0x" + body.toLowerCase().padStart(8, "0");
}
/**
 * 从 gdb 输出里按出现顺序取 print/x 打印的十六进制值（形如 $1 = 0x4001100c）。
 *
 * gdb 只在成功打印时输出 `$N = 0x...`，被拒绝的表达式留一行 Cannot access memory，
 * 所以"少了一个"正好表示那个地址没读到。
 */
export function parseGdbPrintedHex(output) {
    const values = [];
    for (const match of output.matchAll(/\$\d+\s*=\s*(0x[0-9a-fA-F]+)/gu)) {
        const value = match[1];
        if (value !== undefined)
            values.push(value.toLowerCase());
    }
    return values;
}
/**
 * 按 gdb 的 echo 分段标记取回每个地址的值（审计 A7）。
 *
 * 老做法是按 `$N = 0x...` 的出现顺序对齐地址，但失败的命令只打一行
 * "Cannot access memory at address ..."、不产生 `$N`，于是中间有一个地址读失败，
 * 后面所有值就整体前移、张冠李戴，报告里还标着 ok=true。
 * 现在每个地址前面先 echo 一个 ===DSH:<address>=== 标记，值只在它自己那一段里找。
 */
export function parseMarkedWords(output, addresses) {
    const values = new Map();
    let pc = "";
    const marks = [];
    for (const match of output.matchAll(/===DSH:([A-Za-z0-9_.]+)===/gu)) {
        const tag = match[1];
        if (tag === undefined)
            continue;
        const start = match.index ?? 0;
        marks.push({ tag, start, end: start + match[0].length });
    }
    for (let index = 0; index < marks.length; index += 1) {
        const mark = marks[index];
        const next = marks[index + 1];
        const segment = output.slice(mark.end, next === undefined ? output.length : next.start);
        const printed = /\$\d+\s*=\s*(0x[0-9a-fA-F]+)/u.exec(segment);
        const value = printed === null ? "" : printed[1].toLowerCase();
        if (mark.tag === "PC") {
            if (pc === "" && value !== "")
                pc = value;
            continue;
        }
        if (value !== "" && !values.has(mark.tag))
            values.set(mark.tag, value);
    }
    return { pc, values };
}
/**
 * 从 openocd 启动日志里解析各服务的监听端口。
 *
 * openocd 0.12 会打印三行独立的 "Listening on port N for <svc> connections"（tcl / telnet / gdb）。
 * B3 的读寄存器快路径只要 tcl 那个：走它的 RPC 口 halt → mdw → resume，一次连接几毫秒。
 * 解析不到就是 0，调用方回退到 gdb（慢一点但能用），不把整个工具搞挂。
 */
export function parseListeningPorts(text) {
    const ports = { gdb: 0, tcl: 0, telnet: 0 };
    for (const match of text.matchAll(/listening on port (\d+) for ([a-z]+) connections/giu)) {
        const port = Number(match[1]);
        const service = (match[2] ?? "").toLowerCase();
        if (!Number.isFinite(port) || port <= 0)
            continue;
        if (service === "gdb")
            ports.gdb = ports.gdb === 0 ? port : ports.gdb;
        else if (service === "tcl")
            ports.tcl = ports.tcl === 0 ? port : ports.tcl;
        else if (service === "telnet")
            ports.telnet = ports.telnet === 0 ? port : ports.telnet;
    }
    return ports;
}
function emptyReport(errors, message) {
    return {
        ok: false, active: false, sessionId: "", port: 0, tclPort: 0, projectDir: "", configFile: "", elfPath: "",
        startedAt: 0, idleTtlMs: DEFAULT_IDLE_TTL_MS, hardTtlMs: DEFAULT_HARD_TTL_MS, remainingMs: 0,
        breakpoints: quotaOf(0, F1_BREAKPOINT_BUDGET.code),
        watchpoints: quotaOf(0, F1_BREAKPOINT_BUDGET.data),
        errors, message,
    };
}
export class DebugSessionManager {
    subprocess = null;
    binDirs = [];
    current = null;
    timer = null;
    now;
    constructor(options = {}) {
        this.now = options.now ?? (() => Date.now());
    }
    configure(subprocess, binDirs = []) {
        this.subprocess = subprocess;
        this.binDirs = binDirs;
    }
    isActive() {
        return this.current !== null;
    }
    /**
     * 续租：会话刚被用过一次（B3 的 regs 快路径每读一次都算"用过"）。
     * 返回是否真的有会话被续租。
     */
    touch() {
        const session = this.current;
        if (session === null)
            return false;
        session.lastUsedAt = this.now();
        return true;
    }
    status() {
        const session = this.current;
        if (session === null)
            return emptyReport([], "没有调试会话（探针空闲）");
        return {
            ok: true, active: true, sessionId: session.id, port: session.port, tclPort: session.tclPort,
            projectDir: session.projectDir,
            configFile: session.configFile,
            elfPath: session.elfPath, startedAt: session.startedAt, idleTtlMs: session.idleTtlMs,
            hardTtlMs: session.hardTtlMs, remainingMs: this.remainingMs(session),
            breakpoints: session.breakpoints, watchpoints: session.watchpoints, errors: [],
            message: "调试会话进行中（端口 " + String(session.port) + "，剩余 " + String(Math.ceil(this.remainingMs(session) / 1000)) + " s）",
        };
    }
    remainingMs(session) {
        const idleDeadline = session.lastUsedAt + session.idleTtlMs;
        const hardDeadline = session.startedAt + session.hardTtlMs;
        return Math.max(0, Math.min(idleDeadline, hardDeadline) - this.now());
    }
    /** 扫一次租约：过期的会话立刻关。定时器与单测共用这一条路径。 */
    async sweepExpired() {
        const session = this.current;
        if (session === null)
            return false;
        if (this.remainingMs(session) > 0)
            return false;
        await this.stop("租约到期（空闲 " + String(Math.round(session.idleTtlMs / 1000)) + " s 或总时长上限）");
        return true;
    }
    ensureSweeper() {
        if (this.timer !== null)
            return;
        this.timer = setInterval(() => {
            void this.sweepExpired();
        }, SWEEP_MS);
        // 不要因为一个定时器把宿主进程吊住（Node 的 Timeout 有 unref）。
        this.timer.unref?.();
    }
    stopSweeper() {
        if (this.timer === null)
            return;
        clearInterval(this.timer);
        this.timer = null;
    }
    async start(request) {
        const subprocess = this.subprocess;
        if (subprocess === null)
            return emptyReport(["插件还没拿到 subprocess 服务"], "没开会话：插件未就绪");
        // B4：断点预算先算（纯计算 + 读 .ioc/chips.json），超限就直接不占探针——
        // 也别把已有会话关掉：这次申请本来就不会开起来。
        const budgetInfo = resolveBreakpointBudget(request.projectDir);
        const collected = collectBreakpointRequests({
            ...(request.breakpoints === undefined ? {} : { breakpoints: request.breakpoints }),
        });
        const plan = planBreakpoints(collected.requested, budgetInfo.budget);
        if (!plan.ok) {
            const blocked = emptyReport(["断点超预算：" + plan.detail, budgetInfo.note, plan.suggestion], "没开会话：断点超预算（硬件断点 " + String(plan.used.code) + "/" + String(plan.budget.code)
                + "，观察点 " + String(plan.used.data) + "/" + String(plan.budget.data) + "）");
            return {
                ...blocked,
                breakpoints: quotaOf(plan.used.code, plan.budget.code),
                watchpoints: quotaOf(plan.used.data, plan.budget.data),
            };
        }
        if (this.current !== null) {
            await this.stop("新的会话申请覆盖了旧会话");
        }
        const projectDir = request.projectDir;
        const config = resolveSearchConfig(process.env, request.binDirs === undefined ? {} : { binDirs: request.binDirs });
        const openOcd = await resolveToolIn(subprocess, ["openocd"], config.binDirs);
        if (openOcd === null)
            return emptyReport(["找不到 openocd（先跑 stm32_env_probe）"], "没开会话：找不到 openocd");
        // 符号表在这里解析：调用方（工具层、e2e、以后可能的 CLI）都不用自己找 .elf。
        const elfPath = request.elfPath !== undefined && request.elfPath !== ""
            ? request.elfPath
            : (resolveElfPath(projectDir, {}) ?? "");
        const port = request.port ?? (await pickPort(3333));
        const argv = [openOcd];
        const projectConfig = findProjectConfig(projectDir, request.configFile);
        if (projectConfig !== null) {
            argv.push("-f", toOpenOcdPath(projectConfig));
        }
        else {
            const fallback = defaultConfigs();
            argv.push("-f", fallback.interfaceConfig, "-f", fallback.targetConfig);
        }
        if (request.adapterSpeed !== undefined)
            argv.push("-c", "adapter speed " + String(request.adapterSpeed));
        argv.push("-c", "gdb_port " + String(port));
        const handle = subprocess.spawn({
            argv,
            cwd: projectDir,
            stdio: { stdin: "ignore", stdout: { maxBytes: 512 * 1024 }, stderr: { maxBytes: 512 * 1024 } },
            graceMs: 2000,
        });
        const session = {
            id: "dbg-" + String(Date.now()) + "-" + Math.random().toString(16).slice(2, 8),
            projectDir,
            elfPath,
            port,
            tclPort: 0,
            configFile: projectConfig ?? "",
            handle,
            startedAt: this.now(),
            lastUsedAt: this.now(),
            idleTtlMs: request.idleTtlMs ?? DEFAULT_IDLE_TTL_MS,
            hardTtlMs: request.hardTtlMs ?? DEFAULT_HARD_TTL_MS,
            logText: "",
            binDirs: config.binDirs,
            owner: request.owner ?? "",
            breakpoints: quotaOf(plan.used.code, plan.budget.code),
            watchpoints: quotaOf(plan.used.data, plan.budget.data),
        };
        const listening = await waitForListening(handle, 15_000, (text) => {
            session.logText += text + "\n";
            request.onProgress?.(text);
        });
        if (!listening.ok) {
            handle.terminate();
            await handle.waitForExit().catch(() => undefined);
            const tail = listening.text.split(/\r?\n/u).slice(-12).join("\n");
            return emptyReport([/Error connecting DP|no device found|CMSIS-DAP/iu.test(listening.text) ? "openocd 连不上探针/芯片（见日志）" : "openocd 没有在 15 s 内监听 " + String(port), tail], "没开会话：openocd 起不来");
        }
        // tcl 那行常排在 gdb 那行之后：等一小会儿把整个 collected 缓冲从头读一遍再解析
        // （readFrom(0) 对收集式缓冲是随机读，不影响 waitForListening 已经消费掉的偏移）。
        await sleep(TCL_PORT_SETTLE_MS);
        const fullText = [
            listening.text,
            handle.collected.stdout?.readFrom(0).text ?? "",
            handle.collected.stderr?.readFrom(0).text ?? "",
        ].join("\n");
        session.tclPort = parseListeningPorts(fullText).tcl;
        this.current = session;
        this.ensureSweeper();
        if (request.reset !== undefined && request.reset !== "none") {
            const resetResult = await this.eval({ commands: ["monitor reset " + request.reset], keepHalted: true, timeoutMs: 20_000 });
            if (!resetResult.ok) {
                await this.stop("起会话时复位失败");
                return emptyReport(["复位失败：" + resetResult.output.split(/\r?\n/u).slice(-5).join(" ")], "没开会话：复位失败");
            }
        }
        const ready = this.status();
        if (collected.requested.length === 0)
            return ready;
        // B4：把登记集合、预算来源、以及"断点不在 gdb 进程之间保留"这件事说清楚。
        return {
            ...ready,
            message: ready.message + "\n· 断点预算已校验：登记 " + String(plan.used.code) + "/" + String(plan.budget.code)
                + " 个硬件断点、观察点 " + String(plan.used.data) + "/" + String(plan.budget.data) + "（" + budgetInfo.note
                + "）；会话不跨 gdb 进程保存断点，实际停靠用 stm32_debug_eval 的 break <loc>",
        };
    }
    async eval(request) {
        const session = this.current;
        const startedAt = this.now();
        if (session === null) {
            return {
                ok: false, output: "", command: "", durationMs: 0, remainingMs: 0,
                errors: ["没有调试会话（先 stm32_debug_session；短任务用 stm32_debug_run 更省事）"],
                message: "没执行：没有会话",
            };
        }
        const subprocess = this.subprocess;
        if (subprocess === null) {
            return { ok: false, output: "", command: "", durationMs: 0, remainingMs: this.remainingMs(session), errors: ["插件还没拿到 subprocess 服务"], message: "没执行：插件未就绪" };
        }
        // 用"起会话时那份"工具链目录：只读环境变量的话，调用方传了 binDirs 也会出现
        // "openocd 起来了、eval 却说缺 gdb"的错位（也便于离线单测给假目录）。
        const envConfig = resolveSearchConfig(process.env, {});
        const searchDirs = [session.binDirs, this.binDirs, envConfig.binDirs];
        let gdb = null;
        for (const dirs of searchDirs) {
            if (dirs.length === 0)
                continue;
            gdb = await resolveToolIn(this.subprocess, ["gdb-multiarch", "arm-none-eabi-gdb"], dirs);
            if (gdb !== null)
                break;
        }
        if (gdb === null) {
            return { ok: false, output: "", command: "", durationMs: 0, remainingMs: this.remainingMs(session), errors: ["找不到 gdb"], message: "没执行：缺 gdb" };
        }
        const commands = [];
        if (request.expression !== undefined && request.expression.trim() !== "")
            commands.push("print " + request.expression.trim());
        for (const command of request.commands ?? [])
            if (command.trim() !== "")
                commands.push(command.trim());
        if (commands.length === 0) {
            return { ok: false, output: "", command: "", durationMs: 0, remainingMs: this.remainingMs(session), errors: ["没有命令"], message: "没执行：commands/expression 都是空的" };
        }
        // B4：eval 里的 break/watch 也占硬件比较器（一次 gdb 会话里超了，gdb 只会报
        // Cannot insert breakpoint），所以同样先对预算。
        const evalBreakpoints = collectBreakpointRequests({ preCommands: commands });
        if (evalBreakpoints.requested.length > 0) {
            const evalBudget = resolveBreakpointBudget(session.projectDir);
            const evalPlan = planBreakpoints(evalBreakpoints.requested, evalBudget.budget);
            if (!evalPlan.ok) {
                return {
                    ok: false, output: "", command: "", durationMs: 0, remainingMs: this.remainingMs(session),
                    errors: ["断点超预算：" + evalPlan.detail, evalBudget.note, evalPlan.suggestion],
                    message: "没执行：断点超预算（硬件断点 " + String(evalPlan.used.code) + "/" + String(evalPlan.budget.code)
                        + "，观察点 " + String(evalPlan.used.data) + "/" + String(evalPlan.budget.data) + "）",
                };
            }
        }
        const argv = [gdb, "-q", "-batch", "-nx", "-ex", "set confirm off", "-ex", "set pagination off"];
        if (session.elfPath !== "" && existsSync(session.elfPath))
            argv.push("-ex", "file " + toOpenOcdPath(session.elfPath));
        argv.push("-ex", "target extended-remote 127.0.0.1:" + String(session.port), "-ex", "monitor halt");
        for (const command of commands)
            argv.push("-ex", command);
        if (request.keepHalted !== true)
            argv.push("-ex", "monitor resume");
        argv.push("-ex", "detach");
        const outcome = await runCapture(subprocess, {
            argv,
            cwd: session.projectDir,
            timeoutMs: request.timeoutMs ?? 30_000,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
            awaitQuiescence: true,
        });
        session.lastUsedAt = this.now();
        const output = (outcome.stdout + "\n" + outcome.stderr).trim();
        const errors = [];
        if (outcome.spawnError !== null)
            errors.push("gdb 启动失败：" + outcome.spawnError);
        if (outcome.timedOut)
            errors.push("gdb 超时（" + String(request.timeoutMs ?? 30_000) + " ms）");
        if (outcome.exitCode !== 0)
            errors.push("gdb 退出码 " + String(outcome.exitCode));
        // 会话在 eval 期间可能被 turn/end 关掉。
        const stillActive = this.current === session;
        if (!stillActive)
            errors.push("会话在本次 eval 期间已关闭");
        return {
            ok: errors.length === 0,
            output,
            command: argv.map((item) => (item.includes(" ") ? '"' + item + '"' : item)).join(" "),
            durationMs: this.now() - startedAt,
            remainingMs: stillActive ? this.remainingMs(session) : 0,
            errors,
            message: errors.length === 0 ? "执行完成（" + String(this.now() - startedAt) + " ms）" : "执行有问题：" + errors[0],
        };
    }
    /**
     * 借正在跑的调试会话（它已经占着 openocd + CMSIS-DAP）读 32 位字。
     *
     * 为什么要借：再起一个 openocd 会抢同一块探针，实测报
     * "CMSIS-DAP transfer count mismatch: expected 3, got 2"。所以有会话时一律走 gdb 表达式
     * （print/x $pc + 每地址 print/x *(unsigned int *)0x...），halt 之后 resume，芯片照原样继续跑。
     */
    async readWords(request) {
        const startedAt = this.now();
        const session = this.current;
        if (session === null) {
            return {
                ok: false, sessionId: "", port: 0, projectDir: "", command: "", pc: "", samples: [],
                durationMs: 0, output: "",
                errors: ["没有调试会话（先 stm32_debug_session，或短任务用 stm32_debug_run）"],
                message: "没读：没有调试会话",
            };
        }
        const addresses = [];
        const bad = [];
        for (const raw of request.addresses) {
            const normalized = normalizeHexAddress(raw);
            if (normalized === null)
                bad.push(raw);
            else
                addresses.push(normalized);
        }
        if (addresses.length === 0) {
            return {
                ok: false, sessionId: session.id, port: session.port, projectDir: session.projectDir,
                command: "", pc: "", samples: [], durationMs: this.now() - startedAt, output: "",
                errors: ["没有可读的地址" + (bad.length === 0 ? "" : "（解析不了：" + bad.join("、") + "）")],
                message: "没读：地址不合法",
            };
        }
        const commands = ["echo ===DSH:PC===", "print/x $pc"];
        for (const address of addresses) {
            commands.push("echo ===DSH:" + address + "===");
            commands.push("print/x *(unsigned int *)" + address);
        }
        const evaluated = await this.eval({
            commands,
            ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        const marked = parseMarkedWords(evaluated.output, addresses);
        const values = new Map(marked.values);
        let pc = marked.pc;
        if (marked.pc === "" && marked.values.size === 0) {
            // 极老的 gdb 可能不认 echo：退回按顺序对齐（老行为，可能错位），至少不让工具整体失败。
            const printed = parseGdbPrintedHex(evaluated.output);
            pc = printed[0] ?? "";
            addresses.forEach((address, index) => {
                const value = printed[index + 1];
                if (value !== undefined)
                    values.set(address, value);
            });
        }
        const samples = addresses.map((address) => {
            const value = values.get(address);
            return value === undefined || value === "" ? { address, value: "", ok: false } : { address, value, ok: true };
        });
        const missing = samples.filter((sample) => !sample.ok).length;
        const errors = [...evaluated.errors];
        for (const raw of bad)
            errors.push("地址解析不了：" + raw);
        if (missing > 0)
            errors.push("有 " + String(missing) + " 个地址没读到值（地址没映射或没对齐）");
        if (pc === "")
            errors.push("没读到 pc");
        const ok = evaluated.ok && missing === 0 && pc !== "";
        return {
            ok,
            sessionId: session.id,
            port: session.port,
            projectDir: session.projectDir,
            command: evaluated.command,
            pc,
            samples,
            durationMs: this.now() - startedAt,
            output: evaluated.output,
            errors,
            message: ok
                ? "从调试会话（端口 " + String(session.port) + "）读了 " + String(samples.length) + " 个值"
                : "读失败：" + (errors[0] ?? "未知原因"),
        };
    }
    /**
     * 关会话。options.requireOwner 给定时，只有 owner 对得上才关（审计 A9）。
     *
     * 原来 turn/end 一到就无条件关，多 agent 并行时会把别人正在用的探针收走；
     * 现在监听方带上自己的 agent id，不属于自己的会话就不动。owner 未知（空串）时按老行为处理。
     */
    async stop(reason, options = {}) {
        const session = this.current;
        const required = options.requireOwner ?? "";
        if (session !== null && required !== "" && session.owner !== "" && session.owner !== required) {
            return {
                ok: true,
                stopped: false,
                message: "没关：这个会话是另一个调用方起的（" + session.owner + "），不动它（" + reason + "）",
            };
        }
        this.current = null;
        this.stopSweeper();
        if (session === null)
            return { ok: true, stopped: false, message: "本来就没有会话（" + reason + "）" };
        session.handle.terminate();
        await Promise.race([session.handle.waitForExit().catch(() => undefined), sleep(3000)]);
        return { ok: true, stopped: true, message: "会话已关闭（" + reason + "），探针已释放" };
    }
    /**
     * 进程退出前的尽力清理（B3 第 4 条）：exit 事件里不能 await，只发终止信号。
     * 返回是否真的收掉了一个会话。
     */
    terminateSync() {
        const session = this.current;
        this.current = null;
        this.stopSweeper();
        if (session === null)
            return false;
        try {
            session.handle.terminate();
        }
        catch {
            // 进程可能已经没了；exit 阶段不能抛。
        }
        return true;
    }
    async closeAll(reason) {
        await this.stop(reason);
    }
}
/** 进程内单例：工具、turn/end 监听、dispose 共用同一个会话。 */
export const debugSessions = new DebugSessionManager();
/** 需要独占探针的动作（build / flash / generate / debug_run）动手前调用。 */
export async function releaseProbeFor(reason) {
    if (!debugSessions.isActive())
        return null;
    const stopped = await debugSessions.stop("被 " + reason + " 占用探针，先关闭会话");
    return stopped.stopped ? "已先关闭调试会话（" + reason + " 要用探针）" : null;
}
