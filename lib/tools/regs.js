/**
 * L3：stm32_regs_read —— 读物理地址上的寄存器（例如 GPIOC_ODR、AFIO_MAPR）。
 *
 * 只读不写、跑完 resume 让芯片原样继续跑。
 * B3 起走"会话复用快路径"：先保证有一个调试会话（有就复用，没有就起一个、保留到租约到期），
 * 再走 openocd 的 **Tcl RPC 口** halt → reg pc → mdw × N → resume，一次 TCP 往返几毫秒
 * （原来每次 spawn 一个 openocd 要 1493 ms）。Tcl 端口解析不到 / RPC 失败时回退到会话里的 gdb 读。
 * 端口被 VS Code 的调试会话占着时直接报 probe-busy，不抢探针。
 *
 * D2：接上资源包里的 SVD（profile=full 才装）。addresses 的每一项可以是
 *   物理地址（0x4001100C / 4001100C）、寄存器符号（GPIOC.ODR / GPIOC->ODR / RCC.CR），
 *   或者只写外设名（GPIOC）＝把该外设的寄存器整体 dump 一遍（最多 REG_DUMP_MAX 个）。
 * 每条样本都会带上 ref（用户写法）、name（规范化名）与 fields（置位位域），报告 schema 同步。
 * 没有 SVD 时自动退回"纯地址"模式，只是没有名字/位域解释（不报错，功能不退化）。
 */
import { debugSessions } from "../engine/debug-session.js";
import { ensureSession, readWordsViaSession } from "../engine/probe-session.js";
import { ensureToolchain, gateReportNotes } from "../engine/toolchain-gate.js";
import { readIocCpn } from "../engine/breakpoints.js";
import { SVD_FULL_PROFILE_HINT, SVD_KNOWN_LINES, SvdError, decodeRegisterValue, describeAddress, formatAddress, loadSvd, parseAddressText, resolveRegisterRef, svdLineForChip, } from "../data/svd.js";
import { resolveProjectDir, validateToolArgs } from "./project-dir.js";
export const REGS_TOOL = "stm32_regs_read";
/** 只给外设名时一次最多 dump 多少个寄存器（GPIOC 这种寄存器少的根本到不了上限，RCC 也就几十个）。 */
export const REG_DUMP_MAX = 64;
/** 未知外设时列出多少个"可用外设"当建议。 */
export const REGS_SUGGEST_PERIPHERALS = 10;
const fieldSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        name: { type: "string", description: "位域名，例如 ODR2。" },
        bits: { type: "string", description: "位域覆盖的位：单 bit 写 \"2\"，多 bit 写 \"3:5\"（起点:终点，闭区间）。" },
        value: { type: "number", description: "该位域移位后的值（置位才进列表，所以非 0）。" },
    },
    required: ["name", "bits", "value"],
};
const sampleSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        address: { type: "string" },
        value: { type: "string" },
        ok: { type: "boolean" },
        ref: { type: "string", description: "用户写的那个 ref（原样）。" },
        name: { type: "string", description: "规范化名，例如 GPIOC.ODR；没有 SVD 时等于地址。" },
        fields: { type: "array", items: fieldSchema, description: "值里置位（非 0）的位域。" },
    },
    required: ["address", "value", "ok", "ref", "name", "fields"],
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
/* ------------------------------ SVD → line ------------------------------ */
function svdFailureText(failure) {
    const suffix = failure.message.includes("refresh --profile full") ? "" : "；" + SVD_FULL_PROFILE_HINT;
    return failure.message + suffix;
}
/**
 * 工程 → SVD：先按型号查 device facts（chips.json 的 line），查不到再按型号里的三位数字兜底。
 *
 * 为什么要兜底：开发机上常把 DSH_STM32_ASSETS 直接指到资源仓库本体（未分版本、没有 install.json），
 * 这时 device-facts 读不到，但 SVD 文件其实就在 <root>/device/f1/svd/<line>.json —— 兜底让本地开发可用。
 */
export function resolveProjectSvd(projectDir, env = process.env) {
    const cpn = readIocCpn(projectDir);
    const degraded = (note) => ({
        cpn, line: "", device: null, failure: null, source: "none", note,
    });
    if (cpn === "") {
        return degraded("工程里没有 .ioc（取不到型号）：这次只按物理地址读，符号名与位域解释不可用。");
    }
    let line = "";
    let source = "none";
    try {
        line = svdLineForChip(cpn, env) ?? "";
    }
    catch {
        line = "";
    }
    if (line !== "") {
        source = "chips.json";
    }
    else {
        // 兜底：STM32F103C8T6 → "103"。只认 SVD_KNOWN_LINES 里真有的 line，且文件必须能读出来。
        const match = /^STM32F(\d{3})/u.exec(cpn.trim().toUpperCase());
        const candidate = match === null ? "" : (match[1] ?? "");
        if (candidate !== "" && SVD_KNOWN_LINES.includes(candidate)) {
            line = candidate;
            source = "cpn";
        }
    }
    if (line === "") {
        return degraded("型号 " + cpn + " 没能对上 SVD line（device facts 里没有它，或资源包没装）：这次只按物理地址读，符号名与位域解释不可用；" +
            SVD_FULL_PROFILE_HINT + "。");
    }
    const loaded = loadSvd(line, env);
    if (loaded.device === null) {
        const failure = loaded.failure;
        return {
            cpn,
            line,
            device: null,
            failure,
            source,
            note: "line=" + line + " 的 SVD 读不到（" + (failure === null ? "未知原因" : svdFailureText(failure)) +
                "）：这次只按物理地址读，符号名与位域解释都用不了。",
        };
    }
    const device = loaded.device;
    const pieces = [
        "位域解释来自 SVD line=" + device.line + "（" + device.device + "，" +
            String(device.counts.peripherals) + " 个外设 / " + String(device.counts.registers) + " 个寄存器 / " +
            String(device.counts.fields) + " 个位域" + (device.version === "" ? "" : "，资源包 " + device.version) + "）",
        source === "cpn"
            ? "line 是按型号 " + cpn + " 的编号兜底推出来的（device facts 里没有这颗芯片）"
            : "型号 " + cpn + " 来自 device facts",
    ];
    return { cpn, line, device, failure: null, source, note: pieces.join("；") };
}
/* ------------------------------ refs → 读目标 ------------------------------ */
/** 位域覆盖的位：单 bit 写 "2"，多 bit 写 "3:5"（起点:终点，闭区间，跟手册的写法一致）。 */
export function formatBits(bitOffset, bitWidth) {
    if (bitWidth <= 1)
        return String(bitOffset);
    return String(bitOffset) + ":" + String(bitOffset + bitWidth - 1);
}
function normalizeRefKey(ref) {
    return ref.trim().replace(/\s+/gu, "").toUpperCase();
}
function lookupPeripheral(device, name) {
    const exact = device.byName.get(name.trim());
    if (exact !== undefined)
        return exact;
    const wanted = name.trim().toUpperCase();
    if (wanted === "")
        return null;
    for (const peripheral of device.peripherals) {
        if (peripheral.name.toUpperCase() === wanted)
            return peripheral;
    }
    return null;
}
function suggestPeripheralNames(device, wanted) {
    const upper = wanted.trim().toUpperCase();
    const prefixHits = [];
    const others = [];
    for (const name of device.peripheralNames) {
        const candidate = name.toUpperCase();
        if (upper !== "" && (candidate.startsWith(upper) || upper.startsWith(candidate)))
            prefixHits.push(name);
        else
            others.push(name);
    }
    return [...prefixHits, ...others].slice(0, REGS_SUGGEST_PERIPHERALS);
}
function describeAddressSafe(device, address, env) {
    try {
        return describeAddress(address, device.line, env);
    }
    catch {
        // SVD 文件在两次调用之间被删/改坏：降级成"没有名字"，不要让读值失败。
        return null;
    }
}
const SYMBOL_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\.|->)\s*([A-Za-z_][A-Za-z0-9_]*)$/u;
const BARE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
/**
 * 把 addresses 的每一项解析成"绝对地址 + 名字 + 位域"。
 *
 * 支持四种写法（与 svd.resolveRegisterRef 一致）+ 只给外设名时的 dump：
 *   GPIOC.ODR / GPIOC->ODR / RCC.CR / 0x4001100C / 4001100C / GPIOC
 * 失败不抛：把结构化原因放进 errors（包含该 line 的可用外设清单），由工具层拼成一次失败的报告。
 */
export function planRegReads(refs, device, env = process.env) {
    const addresses = [];
    const targets = [];
    const errors = [];
    const notes = [];
    const seenRefs = new Set();
    const byAddress = new Map();
    let noSvdNoted = false;
    const pushTarget = (target, quiet = false) => {
        const existing = byAddress.get(target.address);
        if (existing !== undefined) {
            if (!quiet) {
                notes.push("「" + target.ref + "」与「" + existing.ref + "」指向同一个地址 " + formatAddress(target.address) + "，只读一次");
            }
            return;
        }
        byAddress.set(target.address, target);
        targets.push(target);
        addresses.push(formatAddress(target.address));
    };
    const dumpPeripheral = (peripheral) => {
        // 按偏移升序（= 手册顺序），前 REG_DUMP_MAX 个；同一个地址的别名寄存器只留第一个。
        const registers = [...peripheral.registers].sort((left, right) => {
            if (left.addressOffset !== right.addressOffset)
                return left.addressOffset - right.addressOffset;
            return left.name.localeCompare(right.name);
        });
        const kept = registers.slice(0, REG_DUMP_MAX);
        for (const register of kept) {
            pushTarget({
                ref: peripheral.name,
                kind: "peripheral",
                name: peripheral.name + "." + register.name,
                address: (peripheral.baseAddress + register.addressOffset) >>> 0,
                peripheral: peripheral.name,
                register: register.name,
                size: register.size,
                fields: register.fields,
            }, true);
        }
        if (registers.length > kept.length) {
            notes.push("外设 " + peripheral.name + " 有 " + String(registers.length) + " 个寄存器，只 dump 了地址最小的前 " +
                String(REG_DUMP_MAX) + " 个（剩下的写 " + peripheral.name + ".寄存器名 单独读）");
        }
        notes.push("「" + peripheral.name + "」是外设名：dump 了它的 " + String(kept.length) + " 个寄存器（基址 " +
            formatAddress(peripheral.baseAddress) + "）");
    };
    for (const raw of refs) {
        const text = (raw ?? "").trim();
        if (text === "") {
            errors.push("addresses 里有一项是空字符串：写地址（0x4001100C）或符号名（GPIOC.ODR）都行。");
            continue;
        }
        const key = normalizeRefKey(text);
        if (seenRefs.has(key)) {
            notes.push("「" + text + "」重复了，只读一次");
            continue;
        }
        seenRefs.add(key);
        const numeric = parseAddressText(text);
        if (numeric !== null) {
            const description = device === null ? null : describeAddressSafe(device, numeric, env);
            if (device === null && !noSvdNoted) {
                noSvdNoted = true;
                notes.push("没有可用的 SVD：这次只给值，没有名字与位域解释（" + SVD_FULL_PROFILE_HINT + "）");
            }
            pushTarget({
                ref: text,
                kind: "address",
                name: description === null ? formatAddress(numeric) : description.peripheral + "." + description.register,
                address: numeric,
                peripheral: description === null ? "" : description.peripheral,
                register: description === null ? "" : description.register,
                size: description === null ? 32 : description.size,
                fields: description === null ? [] : description.fields,
            });
            if (description !== null && !description.exact) {
                notes.push("地址 " + formatAddress(numeric) + " 落在 " + description.peripheral + "." + description.register +
                    "（起点 " + formatAddress(description.address) + "）内部第 " + String(description.offsetInRegister) +
                    " 个字节；位域解释按整个寄存器算");
            }
            continue;
        }
        if (device === null) {
            errors.push("「" + text + "」不是物理地址；符号名/外设名要靠 SVD 才能解析：" + SVD_FULL_PROFILE_HINT +
                "（或者直接写 0x 开头的地址）。");
            continue;
        }
        if (SYMBOL_PATTERN.test(text)) {
            try {
                const resolved = resolveRegisterRef(text, device.line, env);
                pushTarget({
                    ref: text,
                    kind: "register",
                    name: resolved.peripheral + "." + resolved.register,
                    address: resolved.address,
                    peripheral: resolved.peripheral,
                    register: resolved.register,
                    size: resolved.size,
                    fields: resolved.fields,
                });
            }
            catch (error) {
                if (error instanceof SvdError) {
                    const groups = SYMBOL_PATTERN.exec(text);
                    const wanted = groups === null || groups[1] === undefined ? text : groups[1];
                    // 外设写错是最常见的笔误：这里统一列出该 line 的前 N 个外设（不把 SVD 的内部文案直接甩给用户）。
                    errors.push(error.code === "peripheral-unknown"
                        ? "资源包（line=" + device.line + "）里没有外设 " + wanted.toUpperCase() +
                            "；可用外设（前 " + String(REGS_SUGGEST_PERIPHERALS) + " 个）：" +
                            suggestPeripheralNames(device, wanted).join("、") + "（共 " +
                            String(device.counts.peripherals) + " 个）"
                        : error.message);
                    continue;
                }
                throw error;
            }
            continue;
        }
        const peripheral = BARE_NAME_PATTERN.test(text) ? lookupPeripheral(device, text) : null;
        if (peripheral !== null) {
            dumpPeripheral(peripheral);
            continue;
        }
        errors.push("资源包（line=" + device.line + "）里没有外设 " + text.toUpperCase() +
            "，也不像 GPIOC.ODR 这种寄存器写法；可用外设（前 " + String(REGS_SUGGEST_PERIPHERALS) + " 个）：" +
            suggestPeripheralNames(device, text).join("、") + "（共 " + String(device.counts.peripherals) + " 个）");
    }
    return { addresses, targets, errors, notes };
}
/* ------------------------------ 读回来的值 → 位域 ------------------------------ */
/**
 * 把 engine 的原始样本配上 ref/name/fields。
 *
 * 为什么在工具层做而不是改 engine：readWordsViaSession / gdb 那条路只认地址（它们不该知道 SVD）；
 * 这里按绝对地址把 target 找回来，再拿 SVD 的位域拆值，两边互不侵入。
 */
export function decorateSamples(rawSamples, targets) {
    const byAddress = new Map();
    for (const target of targets) {
        if (!byAddress.has(target.address))
            byAddress.set(target.address, target);
    }
    const samples = [];
    for (const sample of rawSamples) {
        const numeric = parseAddressText(sample.address);
        // 地址统一成 8 位大写，跟 ref/name 和报告里的写法对齐（engine 那条路给的是小写）。
        const address = numeric === null ? sample.address : formatAddress(numeric);
        const target = numeric === null ? undefined : byAddress.get(numeric);
        const fields = [];
        if (sample.ok && target !== undefined && target.fields.length > 0) {
            try {
                const decoded = decodeRegisterValue({ name: target.register, addressOffset: 0, size: target.size, access: "", fields: target.fields }, sample.value);
                for (const field of decoded.set) {
                    fields.push({ name: field.name, bits: formatBits(field.bitOffset, field.bitWidth), value: field.value });
                }
            }
            catch {
                // 值不是合法十六进制（openocd 偶尔给 "0x????????"）：保留读值，只是不解释位域。
            }
        }
        samples.push({
            address,
            value: sample.value,
            ok: sample.ok,
            ref: target === undefined ? address : target.ref,
            name: target === undefined ? address : target.name,
            fields,
        });
    }
    return samples;
}
/** 一行人话：GPIOC.ODR (0x4001100C) = 0x00000004  → ODR2=1 */
export function describeRegSample(sample) {
    const named = sample.name !== "" && sample.name.toUpperCase() !== sample.address.toUpperCase();
    const head = (named ? sample.name + " (" + sample.address + ")" : sample.address) + " = " +
        (sample.ok ? sample.value : "（读不到）");
    if (sample.fields.length === 0)
        return head;
    return head + "  → " + sample.fields.map((field) => field.name + "=" + String(field.value)).join(", ");
}
/* ------------------------------ 报告 ------------------------------ */
function formatReport(report) {
    const lines = [];
    lines.push((report.ok ? "读取完成" : "读取失败") + "：" + report.message);
    if (report.pc !== "")
        lines.push("pc = " + report.pc);
    for (const sample of report.samples)
        lines.push("  " + describeRegSample(sample));
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
        description: "读 STM32 内存映射寄存器：addresses 每项可以是物理地址（0x4001100C / GPIOC_ODR=0x4001100C 这种）、符号名（GPIOC.ODR / GPIOC->ODR / RCC.CR），或只给外设名（GPIOC = 把该外设的寄存器整体 dump 一遍，最多 " +
            String(REG_DUMP_MAX) + " 个）。有 SVD（stm32_assets refresh --profile full）时每条样本带规范化名 name 与置位位域 fields；没有 SVD 时自动退回纯地址读，只是没有名字/位域。复用常驻调试会话的 openocd（B3：Tcl RPC 直读，毫秒级；没有会话就先起一个并保留到租约到期），halt → mdw → resume 不复位芯片；Tcl 不可用时回退 gdb。用来自证固件在跑（例如看 ODR 位在翻转）。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                projectDir: { type: "string", description: "工程根目录（用于找 openocd.cfg 与 .ioc 里的型号）；缺省为当前工作目录。" },
                addresses: {
                    type: "array",
                    items: { type: "string" },
                    description: "要读的寄存器，每项可以是：物理地址（0x4001100C，可带或不带 0x）、符号名（GPIOC.ODR、GPIOC->ODR、RCC.CR），或外设名（GPIOC = dump 该外设全部寄存器）。",
                },
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
            // D2：先把符号名/外设名解析成地址（零成本、不占探针）。解析不了就直接失败——
            // 没解析清楚就去借探针，等于白占一次硬件。
            const svd = resolveProjectSvd(resolution.projectDir);
            const plan = planRegReads(args.addresses, svd.device);
            const planNotes = [svd.note, ...plan.notes];
            const planErrors = plan.errors.length > 0
                ? [...plan.errors]
                : (plan.addresses.length === 0 ? ["addresses 里没有可读的项（都是空串/重复？）"] : []);
            if (planErrors.length > 0) {
                const message = "寄存器写法解析失败：" + (planErrors[0] ?? "");
                const report = failureReport(resolution.projectDir, message, planErrors);
                report.notes = planNotes;
                return { message, report };
            }
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
                blocked.notes = [...planNotes, ...gateNotes];
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
                report.notes = [...planNotes, ...gateNotes, ...(resolution.note === null ? [] : [resolution.note])];
                return { message: report.message, report };
            }
            const startedAt = Date.now();
            const notes = [...planNotes, ...gateNotes];
            // 快路径：Tcl RPC 直读（毫秒级）。
            const fast = await readWordsViaSession({
                addresses: plan.addresses,
                ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
                signal: exec.signal,
            });
            let ok = false;
            let pc = "";
            let rawSamples = [];
            let command = "";
            let output = "";
            let errors = [];
            let viaTcl = false;
            if (fast.ok) {
                ok = true;
                viaTcl = true;
                pc = fast.pc;
                rawSamples = fast.samples;
                command = fast.command;
                output = fast.output;
            }
            else {
                // 回退：会话里的 gdb -batch（慢一些，但不会挡探针、也不会撞上 openocd 的"转移计数不一致"）。
                const gdb = await debugSessions.readWords({
                    addresses: plan.addresses,
                    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
                    signal: exec.signal,
                });
                ok = gdb.ok;
                pc = gdb.pc;
                rawSamples = gdb.samples;
                command = gdb.command;
                output = gdb.output;
                errors = gdb.errors;
                notes.push("Tcl 快路径没成（" + (fast.error ?? "未知原因") + "），回退到会话里的 gdb 读（慢一些）");
            }
            const durationMs = Date.now() - startedAt;
            const samples = decorateSamples(rawSamples, plan.targets);
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
            const unit = plan.targets.some((target) => target.kind !== "address") ? "个寄存器" : "个地址";
            const clean = ok && errors.length === 0;
            const message = clean
                ? "读到 " + String(readValues) + " " + unit + "（pc=" + (pc === "" ? "未知" : pc) + "，" + String(durationMs) + " ms" + (viaTcl ? "，复用会话 Tcl 直读" : "") + "）"
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
