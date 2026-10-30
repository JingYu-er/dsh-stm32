/**
 * L3：stm32_regs_read —— 读物理地址上的寄存器（例如 GPIOC_ODR、AFIO_MAPR）。
 *
 * 只读不写、跑完 resume 让芯片原样继续跑。
 * B3 起走"会话复用快路径"：先保证有一个调试会话（有就复用，没有就起一个、保留到租约到期），
 * 再走 openocd 的 **Tcl RPC 口** halt → reg pc → mdw × N → resume，一次 TCP 往返几毫秒
 * （原来每次 spawn 一个 openocd 要 1493 ms）。Tcl 端口解析不到 / RPC 失败时回退到会话里的 gdb 读。
 * 端口被 VS Code 的调试会话占着时直接报 probe-busy，不抢探针。
 */
import { describeSample } from "../engine/regs.js";
import { debugSessions } from "../engine/debug-session.js";
import { ensureSession, readWordsViaSession } from "../engine/probe-session.js";
import { ensureToolchain, gateReportNotes } from "../engine/toolchain-gate.js";
import { resolveProjectDir, validateToolArgs } from "./project-dir.js";
export const REGS_TOOL = "stm32_regs_read";
const sampleSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        address: { type: "string" },
        value: { type: "string" },
        ok: { type: "boolean" },
    },
    required: ["address", "value", "ok"],
};
export const outputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        message: { type: "string" },
        report: {
            type: "object",
            additionalProperties: false,
            properties: {
                ok: { type: "boolean" },
                reusedSession: { type: "boolean" },
                projectDir: { type: "string" },
                configFile: { type: "string" },
                command: { type: "string" },
                script: { type: "string" },
                pc: { type: "string" },
                samples: { type: "array", items: sampleSchema },
                durationMs: { type: "number" },
                exitCode: { type: "number" },
                errors: { type: "array", items: { type: "string" } },
                message: { type: "string" },
                logTail: { type: "string" },
                notes: { type: "array", items: { type: "string" } },
            },
            required: [
                "ok", "reusedSession", "projectDir", "configFile", "command", "script", "pc", "samples",
                "durationMs", "errors", "message", "logTail", "notes",
            ],
        },
    },
    required: ["message", "report"],
};
/** 门禁档位参数：三个档位的说明文字与 build 工具保持一致。 */
const ENV_CHECK_SCHEMA = {
    type: "string",
    enum: ["block", "warn", "off"],
    description: "工具链检查：block 缺件就拒绝（默认）、warn 只警告、off 不检查",
};
function formatReport(report) {
    const lines = [];
    lines.push((report.ok ? "读取完成" : "读取失败") + "：" + report.message);
    if (report.pc !== "")
        lines.push("pc = " + report.pc);
    for (const sample of report.samples)
        lines.push("  " + describeSample(sample));
    if (report.configFile !== "")
        lines.push("openocd 配置：" + report.configFile);
    for (const note of report.notes)
        lines.push("· " + note);
    for (const error of report.errors.slice(0, 8))
        lines.push("! " + error);
    if (!report.ok && report.logTail !== "") {
        lines.push("");
        lines.push("日志尾部：");
        lines.push(report.logTail);
    }
    return lines;
}
function failureReport(projectDir, message, errors) {
    return {
        ok: false, reusedSession: false, projectDir, configFile: "", command: "", script: "", pc: "",
        samples: [], durationMs: 0, errors, message, logTail: "", notes: [],
    };
}
export function registerRegsRead(ctx) {
    ctx.tools.register({
        name: REGS_TOOL,
        description: "读 STM32 内存映射寄存器（物理地址，如 GPIOC_ODR=0x4001100C、AFIO_MAPR=0x40010004）：复用常驻调试会话的 openocd（B3：Tcl RPC 直读，毫秒级；没有会话就先起一个并保留到租约到期），halt → mdw → resume 不复位芯片；Tcl 不可用时回退 gdb。用来自证固件在跑（例如看 ODR 位在翻转）。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                projectDir: { type: "string", description: "工程根目录（用于找 openocd.cfg）；缺省为当前工作目录。" },
                addresses: { type: "array", items: { type: "string" }, description: "要读的物理地址，可带或不带 0x，例如 [\"0x4001100C\"]。" },
                configFile: { type: "string", description: "openocd 配置文件（相对工程目录；新起会话时生效）。" },
                adapterSpeed: { type: "number", description: "adapter speed（kHz；新起会话时生效）。" },
                timeoutMs: { type: "number", description: "超时毫秒数，默认 30000。" },
                binDirs: { type: "array", items: { type: "string" }, description: "工具链目录候选。" },
                envCheck: ENV_CHECK_SCHEMA,
            },
            required: ["addresses"],
        },
        timeoutMs: 60_000,
        isConcurrencySafe: () => false,
        output: {
            schema: outputSchema,
            render: (_args, value) => {
                const typed = value;
                return [{ type: "text", text: formatReport(typed.report).join("\n") }];
            },
        },
        async execute(rawArgs, exec) {
            const args = rawArgs ?? {};
            // 洞 C：参数名写错（例如把 addresses 写成 addresses_list）时先给一句人话，不要让宿主去报
            // "returned invalid output: value is not lossless JSON"。
            const invalid = validateToolArgs(REGS_TOOL, args, [
                { name: "addresses", kind: "string[]" },
            ]);
            if (invalid !== null) {
                return { message: invalid, report: failureReport(typeof args.projectDir === "string" ? args.projectDir : "", invalid, [invalid]) };
            }
            const resolution = await resolveProjectDir(ctx, args.projectDir, exec);
            // 门禁：读寄存器要 openocd（或已有会话里的那个）。放在借会话之前判断，
            // 两种取词方式都不会在缺件时白跑一趟。
            const gate = await ensureToolchain(ctx, {
                capability: "debug",
                ...(args.binDirs === undefined ? {} : { binDirs: args.binDirs }),
                envCheck: args.envCheck,
                signal: exec.signal,
            });
            const gateNotes = gate.ok ? [] : gateReportNotes(gate);
            if (!gate.ok && gate.mode === "block") {
                const blocked = failureReport(resolution.projectDir, gate.message, []);
                blocked.notes = gateNotes;
                return { message: blocked.message, report: blocked };
            }
            const subprocess = ctx.get("subprocess");
            if (subprocess === undefined) {
                const message = "宿主缺少 subprocess 服务，无法读寄存器";
                return { message, report: failureReport(resolution.projectDir, message, [message]) };
            }
            // B3：有会话就复用（不重新起 openocd）；没有就起一个，保留到租约到期（90 s 空闲 / turn 结束）。
            const ensured = await ensureSession(resolution.projectDir, {
                subprocess,
                ...(args.binDirs === undefined ? {} : { binDirs: args.binDirs }),
                ...(args.configFile === undefined || args.configFile === "" ? {} : { configFile: args.configFile }),
                ...(args.adapterSpeed === undefined ? {} : { adapterSpeed: args.adapterSpeed }),
                ...(exec.agent?.id === undefined ? {} : { owner: exec.agent.id }),
            });
            if (!ensured.ok || ensured.session === null) {
                // 端口被占（probe-busy）等：直接说清是哪一类，不让 openocd 顺延端口偷偷抢探针。
                const evidence = ensured.probeError === null ? [] : ensured.probeError.evidence;
                const report = failureReport(resolution.projectDir, ensured.message, evidence.length > 0 ? [...evidence] : [ensured.message]);
                report.notes = [...gateNotes, ...(resolution.note === null ? [] : [resolution.note])];
                return { message: report.message, report };
            }
            const startedAt = Date.now();
            const notes = [...gateNotes];
            // 快路径：Tcl RPC 直读（毫秒级）。
            const fast = await readWordsViaSession({
                addresses: args.addresses,
                ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
                signal: exec.signal,
            });
            let ok = false;
            let pc = "";
            let samples = [];
            let command = "";
            let output = "";
            let errors = [];
            let viaTcl = false;
            if (fast.ok) {
                ok = true;
                viaTcl = true;
                pc = fast.pc;
                samples = fast.samples;
                command = fast.command;
                output = fast.output;
            }
            else {
                // 回退：会话里的 gdb -batch（慢一些，但不会挡探针、也不会撞上 openocd 的"转移计数不一致"）。
                const gdb = await debugSessions.readWords({
                    addresses: args.addresses,
                    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
                    signal: exec.signal,
                });
                ok = gdb.ok;
                pc = gdb.pc;
                samples = gdb.samples;
                command = gdb.command;
                output = gdb.output;
                errors = gdb.errors;
                notes.push("Tcl 快路径没成（" + (fast.error ?? "未知原因") + "），回退到会话里的 gdb 读（慢一些）");
            }
            const durationMs = Date.now() - startedAt;
            notes.push((ensured.reused ? "复用调试会话" : "新起调试会话") +
                "（gdb 端口 " + String(ensured.session.port) + "，tcl 端口 " + String(ensured.session.tclPort) +
                "），没有另起 openocd；这次走" + (viaTcl ? " Tcl RPC 直读" : "会话里的 gdb"));
            // A19：借用会话时 openocd 是会话里那个，这两个参数没法改，别让用户以为生效了。
            if (ensured.reused && ((args.configFile !== undefined && args.configFile !== "") || args.adapterSpeed !== undefined)) {
                notes.push("这次借用了已有会话：configFile / adapterSpeed 不生效（openocd 是会话里那个，已按会话参数在跑）。" +
                    "要按新参数读，先 stm32_debug_stop 再调 " + REGS_TOOL + "。");
            }
            if (resolution.note !== null)
                notes.push(resolution.note);
            if (ensured.session.projectDir !== "" && ensured.session.projectDir !== resolution.projectDir) {
                notes.push("会话的工程目录是 " + ensured.session.projectDir + "，与本次参数的 " + resolution.projectDir + " 不同（读值用的是会话里的那个）");
            }
            const readValues = samples.filter((sample) => sample.ok).length;
            const clean = ok && errors.length === 0;
            const message = clean
                ? "读到 " + String(readValues) + " 个地址（pc=" + (pc === "" ? "未知" : pc) + "，" + String(durationMs) + " ms" + (viaTcl ? "，复用会话 Tcl 直读" : "") + "）"
                : "读寄存器失败：" + (errors[0] ?? fast.error ?? "未知原因");
            return {
                message,
                report: {
                    ok: clean,
                    reusedSession: ensured.reused,
                    projectDir: ensured.session.projectDir === "" ? resolution.projectDir : ensured.session.projectDir,
                    configFile: ensured.session.configFile,
                    command,
                    script: "",
                    pc,
                    samples,
                    durationMs,
                    errors,
                    message,
                    logTail: output.split(/\r?\n/u).slice(-12).join("\n"),
                    notes,
                },
            };
        },
    });
}
