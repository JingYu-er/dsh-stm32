/**
 * L1：STM32CubeProgrammer CLI 烧录后端（openocd 之外的第二条腿）。
 *
 * 为什么需要它（2026-11-08 真机教训）：openocd 0.12 没有 C0/U0 等族的 target 脚本，
 * 插件内置适配版也只覆盖到「flash 驱动能借用」的程度；C0 那次靠会话外手敲
 * STM32_Programmer_CLI 才烧进去——这条能力必须在插件里，而不是在用户的肌肉记忆里。
 *
 * 探针支持面（-h 实测 + 本机 -l 实测）：CLI 的 SWD 路径只认 **ST-LINK**
 * （port=SWD 的参数全是 ST-LINK 系；DAPLink/CMSIS-DAP 不走这条）。
 * 所以它是「插着 ST-LINK 时的第二后端」，不是万能替补，报告里要如实说。
 *
 * 判据短语全部来自对本机 v2.19.0 的 STM32_Programmer_CLI.exe / CubeProgrammer_API.dll
 * 内嵌消息表的实测提取（UTF-16 串扫描），不是文档转述：
 *   下载成功   Data downloaded successfully / Sector[%d] downloaded successfully
 *   校验成功   Download verified successfully
 *   校验失败   Download verification failed
 *   没插探针   No ST-Link detected!
 *
 * 退出码不参与成败判定：CLI 失败时也常退 0，只认输出行（与 openocd 同哲学，docs/A25）。
 */
import { basename } from "node:path";
import { runStreaming } from "./subprocess-runner.js";
import { describeSearchScope, resolveSearchConfig, looksLikeCubePrgBin } from "../data/search-roots.js";
import { existsSync } from "node:fs";
export function parseCubeProgrammerLog(text) {
    const downloaded = /Data downloaded successfully|Sector[d+] downloaded successfully/iu.test(text);
    const verified = /Download verified successfully/iu.test(text);
    const verifyFailed = /Download verification failed/iu.test(text);
    const errors = [];
    const seen = new Set();
    for (const raw of text.split(/\r?\n/u)) {
        const line = raw.trim();
        if (line === "")
            continue;
        const isError = /^Error[: ]/iu.test(line) ||
            /No ST-Link detected/iu.test(line) ||
            /Unable to connect/iu.test(line) ||
            verifyFailedTest(line);
        if (!isError)
            continue;
        if (seen.has(line))
            continue;
        seen.add(line);
        errors.push(line);
    }
    return { downloaded, verified, verifyFailed, errors };
}
function verifyFailedTest(line) {
    return /Download verification failed/iu.test(line);
}
/** 拼 CLI 参数（可单测）：连接 SWD → 下载 elf → 校验 → 复位。 */
export function buildCubeProgrammerArgs(elfPath, o = {}) {
    const freq = o.adapterSpeed === undefined ? "" : " freq=" + String(Math.trunc(o.adapterSpeed));
    const args = ["-c", "port=SWD" + freq, "-d", elfPath, "-v"];
    if (o.runAfterReset !== false)
        args.push("-rst");
    return args;
}
/** 找本机 CubeProgrammer CLI：显式路径 → 搜索根 → 注册表没有就认 PATH 裸命令。 */
export function findCubeProgrammerCli(binDirs, explicit) {
    if (explicit !== undefined && explicit !== "") {
        const hit = [explicit, explicit + ".exe"].find((p) => existsSync(p));
        return hit ?? null;
    }
    for (const dir of binDirs) {
        const p = dir + "/STM32_Programmer_CLI.exe";
        if (existsSync(p))
            return p;
        if (looksLikeCubePrgBin(dir))
            return dir + "/STM32_Programmer_CLI.exe";
    }
    return null;
}
export async function runCubeProgrammerFlash(subprocess, request) {
    const startedAt = Date.now();
    const config = resolveSearchConfig(process.env, request.binDirs === undefined ? {} : { binDirs: request.binDirs });
    const cli = findCubeProgrammerCli(config.cubePrgBins, request.cliPath);
    const empty = (errors, message) => ({
        ok: false, command: "", args: [], exitCode: null, programmed: false, verified: false,
        errors, logTail: "", durationMs: Date.now() - startedAt, message,
        searched: describeSearchScope(config.cubePrgBins, "STM32_CUBE_PRG_ROOT"),
    });
    if (cli === null) {
        return empty(["没找到 STM32_Programmer_CLI.exe"], "烧不了：本机找不到 STM32CubeProgrammer 的 CLI（查过 " + describeSearchScope(config.cubePrgBins, "STM32_CUBE_PRG_ROOT") + "）。" +
            "装上它就有了不依赖 openocd target 脚本的第二条后端（H5/WBA/WB0/WL3 只能走它）：" +
            "https://www.st.com/en/development-tools/stm32cubeprog.html（默认安装路径会被自动发现；已装在别处就设 STM32_CUBE_PRG_ROOT 指到安装根或 bin）");
    }
    const args = [cli, ...buildCubeProgrammerArgs(request.elfPath, {
            ...(request.adapterSpeed === undefined ? {} : { adapterSpeed: request.adapterSpeed }),
            runAfterReset: request.runAfterReset !== false,
        })];
    let out = "";
    const outcome = await runStreaming(subprocess, {
        argv: args,
        cwd: request.projectDir,
        timeoutMs: request.timeoutMs ?? 120_000,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        onOutput: (_stream, text) => {
            out += text;
            for (const line of text.split(/\r?\n/u)) {
                if (line.trim() !== "")
                    request.onProgress?.(line.trim());
            }
        },
    });
    // 判定用 runStreaming 收全的 stdout+stderr；onOutput 增量只用于实时转发进度。
    const log = out.length > outcome.stdout.length + outcome.stderr.length ? out : outcome.stdout + "\n" + outcome.stderr;
    const verdict = parseCubeProgrammerLog(log);
    const errors = [...verdict.errors];
    if (outcome.spawnError !== null)
        errors.push("CLI 启动失败：" + outcome.spawnError);
    if (outcome.timedOut)
        errors.push("超时（" + String(request.timeoutMs ?? 120_000) + " ms）：CLI 没跑完");
    // 成功 = 下载行 + 校验行都在、没有失败行；退出码不参与（CLI 失败也常退 0）。
    const ok = errors.length === 0 && verdict.downloaded && verdict.verified;
    const message = ok
        ? "烧录成功（CubeProgrammer，" + ((Date.now() - startedAt) / 1000).toFixed(1) + " s，已校验）"
        : "烧录失败（CubeProgrammer）：" + (errors[0] ?? (verdict.downloaded ? "校验行没出现" : "下载行没出现"));
    const exitValue = typeof outcome.exitCode === "number" ? outcome.exitCode : null;
    return {
        ok,
        command: args.map((a) => (a.includes(" ") ? '"' + a + '"' : a)).join(" "),
        args: args.slice(1),
        exitCode: exitValue,
        programmed: verdict.downloaded,
        verified: verdict.verified,
        errors,
        logTail: log.split(/\r?\n/u).slice(-25).join("\n"),
        durationMs: Date.now() - startedAt,
        message,
        searched: describeSearchScope(config.cubePrgBins, "STM32_CUBE_PRG_ROOT"),
    };
}
/** 报告卡片里给这行署名：烧的是哪条后端。 */
export function cubeProgrammerBackendNote(cliPath) {
    return "烧录后端：STM32CubeProgrammer CLI（" + basename(cliPath) + "）；注意它只认 ST-LINK，DAPLink/CMSIS-DAP 探针仍走 openocd。";
}
