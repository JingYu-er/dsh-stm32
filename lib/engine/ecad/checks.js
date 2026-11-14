/**
 * ECAD 检查与导出（S97）：把 kicad-cli 的 ERC / DRC / STEP 包成结构化结果。
 *
 * 为什么用 kicad-cli 而不是 KiCad 的 Python 或 MCP：它随 KiCad 安装、
 * 无需 GUI、无需 IPC、JSON 报告有稳定 schema；本插件已经在用 runCapture
 * 管子进程，不需要再引入一层 MCP 协议。
 */
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { runCapture } from "../subprocess-runner.js";
import { ecadEnv } from "./toolchain.js";
function pushFindings(target, violation, fallbackRule) {
    const severity = (violation.severity ?? "error").toLowerCase();
    const items = (violation.items ?? [])
        .map((item) => item.description ?? "")
        .filter((text) => text !== "")
        .slice(0, 3);
    target.push({
        rule: violation.type ?? fallbackRule,
        severity,
        message: violation.description ?? "",
        items,
    });
}
function summarize(findings) {
    let errors = 0;
    let warnings = 0;
    for (const finding of findings) {
        if (finding.severity === "error")
            errors += 1;
        else
            warnings += 1;
    }
    return { errors, warnings, findings };
}
function tail(text, limit = 1200) {
    return text.length <= limit ? text : text.slice(text.length - limit);
}
/**
 * 跑 `kicad-cli sch erc`。
 *
 * 报告文件名用固定的 `drc/erc.json` 形式落在 `<kicadDir>/checks/`，方便面板与
 * 下一次构建对比；`--severity-error` 只收 error，warning 用 `all` 再跑一次。
 */
export async function runErc(subprocess, toolchain, schematicFile, signal) {
    return runReport(subprocess, toolchain, "sch", "erc", schematicFile, signal);
}
export async function runDrc(subprocess, toolchain, pcbFile, signal) {
    return runReport(subprocess, toolchain, "pcb", "drc", pcbFile, signal);
}
async function runReport(subprocess, toolchain, kind, command, file, signal) {
    const empty = { errors: 0, warnings: 0, findings: [] };
    if (toolchain.kicadCli === "") {
        return { ok: false, error: "没有 kicad-cli：装一个 KiCad 10", file, reportPath: "", summary: empty, raw: "" };
    }
    const checksDir = join(dirname(file), "checks");
    if (!existsSync(checksDir))
        mkdirSync(checksDir, { recursive: true });
    const reportPath = join(checksDir, command + ".json");
    const argv = [
        toolchain.kicadCli,
        kind,
        command,
        "--format",
        "json",
        "--severity-all",
        "-o",
        reportPath,
        file,
    ];
    const outcome = await runCapture(subprocess, {
        argv,
        cwd: dirname(file),
        env: ecadEnv(toolchain),
        timeoutMs: 120_000,
        maxBytes: 1024 * 1024,
        ...(signal === undefined ? {} : { signal }),
    });
    let raw = "";
    let findings = [];
    try {
        raw = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
        if (raw !== "") {
            if (command === "erc") {
                const parsed = JSON.parse(raw);
                for (const sheet of parsed.sheets ?? []) {
                    for (const violation of sheet.violations ?? [])
                        pushFindings(findings, violation, "erc");
                }
            }
            else {
                const parsed = JSON.parse(raw);
                for (const violation of parsed.violations ?? [])
                    pushFindings(findings, violation, "drc");
                for (const violation of parsed.unconnected_items ?? [])
                    pushFindings(findings, violation, "unconnected");
                for (const violation of parsed.schematic_parity ?? [])
                    pushFindings(findings, violation, "parity");
            }
        }
    }
    catch (error) {
        return {
            ok: false,
            error: "解析 " + command.toUpperCase() + " 报告失败：" + (error instanceof Error ? error.message : String(error)),
            file,
            reportPath,
            summary: empty,
            raw: "",
        };
    }
    if (outcome.spawnError !== null) {
        return { ok: false, error: outcome.spawnError, file, reportPath, summary: empty, raw };
    }
    const ok = outcome.exitCode === 0;
    return {
        ok,
        error: ok ? "" : tail(outcome.stdout + "\n" + outcome.stderr),
        file,
        reportPath,
        summary: summarize(findings),
        raw,
    };
}
/**
 * 导 STEP：`kicad-cli pcb export step`。
 *
 * 3D 模型缺失不阻断导出（KiCad 只警告），所以把 `Could not add 3D model for X`
 * 抽成清单，交给面板提示，而不是当失败。
 */
export async function exportStep(subprocess, toolchain, pcbFile, outFile, signal) {
    const started = Date.now();
    if (toolchain.kicadCli === "") {
        return { ok: false, error: "没有 kicad-cli：装一个 KiCad 10", stepFile: "", bytes: 0, durationMs: 0, missingModels: [] };
    }
    if (!existsSync(dirname(outFile)))
        mkdirSync(dirname(outFile), { recursive: true });
    const outcome = await runCapture(subprocess, {
        argv: [toolchain.kicadCli, "pcb", "export", "step", "-o", outFile, pcbFile],
        cwd: dirname(pcbFile),
        env: ecadEnv(toolchain),
        timeoutMs: 300_000,
        maxBytes: 512 * 1024,
        ...(signal === undefined ? {} : { signal }),
    });
    const missing = [];
    for (const line of (outcome.stdout + "\n" + outcome.stderr).split(/\r?\n/u)) {
        const match = /Could not add 3D model for ([^\s.:]+)/u.exec(line);
        if (match !== null)
            missing.push(match[1] ?? "");
    }
    const ok = outcome.exitCode === 0 && existsSync(outFile);
    let bytes = 0;
    if (ok) {
        try {
            bytes = statSync(outFile).size;
        }
        catch {
            bytes = 0;
        }
    }
    return {
        ok,
        error: ok ? "" : tail(outcome.stdout + "\n" + outcome.stderr) || "STEP 导出失败",
        stepFile: ok ? outFile : "",
        bytes,
        durationMs: Date.now() - started,
        missingModels: [...new Set(missing)].slice(0, 20),
    };
}
/**
 * 未命名的网络（S98）。
 *
 * tscircuit 不给自动生成的走线起名时，`.kicad_pcb` 里会写成 `.R1 > .pin1 to .C1 > .pin1`
 * 这种由引脚路径拼出来的名字。它在技术上是一个网络，但人看不出电气含义，也进不了网表
 * 对照；这里把它们挑出来，让作者补 `<net name="VDD" />` 与 `trace net="VDD"`。
 */
export function findUnnamedNets(pcbText) {
    const found = new Set();
    const pattern = /\(net\s+\d+\s+"([^"]*)"\)/gu;
    let match = pattern.exec(pcbText);
    while (match !== null) {
        const name = match[1] ?? "";
        if (name.startsWith(".") || name.startsWith("Net-("))
            found.add(name);
        match = pattern.exec(pcbText);
    }
    return [...found].slice(0, 20);
}
