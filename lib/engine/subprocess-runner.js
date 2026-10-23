/**
 * L0：子进程执行封装。
 *
 * 只做三件事：把一次执行变成 { exitCode, signal, stdout, stderr, timedOut }、
 * 用宿主 subprocess 服务的 Job 范围保证终止时连带子进程树、把超时表达为 abort。
 * 不做命令解析、不做 shell 解释——argv 永远是数组。
 */
function messageOf(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
export async function runCapture(subprocess, request) {
    const maxBytes = request.maxBytes ?? 256 * 1024;
    const timeoutMs = request.timeoutMs ?? 10_000;
    // 宿主的 subprocess 服务要求 cwd 必填（dsh-subprocess-local 的 targetEnvironment 直接对
    // spec.cwd 调 includes，缺省时抛 "Cannot read properties of undefined (reading 'includes')"）。
    const cwd = request.cwd ?? process.cwd();
    const controller = new AbortController();
    const external = request.signal;
    const onExternalAbort = () => controller.abort();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    if (external !== undefined) {
        if (external.aborted) {
            clearTimeout(timer);
            return {
                exitCode: null,
                signal: null,
                stdout: "",
                stderr: "",
                timedOut: false,
                aborted: true,
                spawnError: null,
            };
        }
        external.addEventListener("abort", onExternalAbort, { once: true });
    }
    let handle = null;
    try {
        handle = subprocess.spawn({
            argv: request.argv,
            cwd,
            stdio: {
                stdin: "ignore",
                stdout: { maxBytes },
                stderr: { maxBytes },
            },
            graceMs: 3_000,
            signal: controller.signal,
        });
        const outcome = await handle.done;
        const stdout = handle.collected.stdout?.readFrom(0).text ?? "";
        const stderr = handle.collected.stderr?.readFrom(0).text ?? "";
        return {
            exitCode: outcome.exitCode,
            signal: outcome.signal,
            stdout,
            stderr,
            timedOut,
            aborted: external?.aborted === true && !timedOut,
            spawnError: null,
        };
    }
    catch (error) {
        return {
            exitCode: null,
            signal: null,
            stdout: "",
            stderr: "",
            timedOut,
            aborted: external?.aborted === true && !timedOut,
            spawnError: messageOf(error),
        };
    }
    finally {
        clearTimeout(timer);
        if (external !== undefined)
            external.removeEventListener("abort", onExternalAbort);
        if (handle !== null && request.awaitQuiescence === true) {
            await handle.waitForExit().catch(() => undefined);
        }
    }
}
function sleep(ms, signal) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        if (signal !== undefined) {
            signal.addEventListener("abort", () => {
                clearTimeout(timer);
                resolve();
            }, { once: true });
        }
    });
}
/**
 * 与 runCapture 同样语义，但在进程运行期间增量读取两条流。
 * 用于 3–4 分钟的 CubeMX 生成：调用方可以先把日志推给 job，而不是等结束。
 */
export async function runStreaming(subprocess, request) {
    const maxBytes = request.maxBytes ?? 2 * 1024 * 1024;
    const timeoutMs = request.timeoutMs ?? 600_000;
    const pollMs = request.pollMs ?? 400;
    const heartbeatMs = request.heartbeatMs ?? 15_000;
    const cwd = request.cwd ?? process.cwd();
    const controller = new AbortController();
    const external = request.signal;
    let timedOut = false;
    const startedAt = Date.now();
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    if (external !== undefined) {
        if (external.aborted) {
            clearTimeout(timer);
            return { exitCode: null, signal: null, stdout: "", stderr: "", timedOut: false, aborted: true, spawnError: null };
        }
        external.addEventListener("abort", () => controller.abort(), { once: true });
    }
    let handle = null;
    try {
        handle = subprocess.spawn({
            argv: request.argv,
            cwd,
            stdio: { stdin: "ignore", stdout: { maxBytes }, stderr: { maxBytes } },
            graceMs: 5_000,
            signal: controller.signal,
        });
        const current = handle;
        let settled = false;
        void current.done.then(() => {
            settled = true;
        }, () => {
            settled = true;
        });
        let outOffset = 0;
        let errOffset = 0;
        const drain = () => {
            const stdoutReader = current.collected.stdout;
            if (stdoutReader !== undefined) {
                const chunk = stdoutReader.readFrom(outOffset);
                if (chunk.nextOffset > outOffset) {
                    outOffset = chunk.nextOffset;
                    if (chunk.text !== "")
                        request.onOutput?.("stdout", chunk.text);
                }
            }
            const stderrReader = current.collected.stderr;
            if (stderrReader !== undefined) {
                const chunk = stderrReader.readFrom(errOffset);
                if (chunk.nextOffset > errOffset) {
                    errOffset = chunk.nextOffset;
                    if (chunk.text !== "")
                        request.onOutput?.("stderr", chunk.text);
                }
            }
        };
        let lastBeat = Date.now();
        while (!settled) {
            await sleep(pollMs, controller.signal);
            drain();
            if (request.onHeartbeat !== undefined && Date.now() - lastBeat >= heartbeatMs) {
                lastBeat = Date.now();
                request.onHeartbeat(Date.now() - startedAt);
            }
        }
        drain();
        const outcome = await current.done;
        return {
            exitCode: outcome.exitCode,
            signal: outcome.signal,
            stdout: current.collected.stdout?.readFrom(0).text ?? "",
            stderr: current.collected.stderr?.readFrom(0).text ?? "",
            timedOut,
            aborted: external?.aborted === true && !timedOut,
            spawnError: null,
        };
    }
    catch (error) {
        return { exitCode: null, signal: null, stdout: "", stderr: "", timedOut, aborted: false, spawnError: messageOf(error) };
    }
    finally {
        clearTimeout(timer);
        if (handle !== null && request.awaitQuiescence === true) {
            await handle.waitForExit().catch(() => undefined);
        }
    }
}
