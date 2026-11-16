/**
 * 打开 KiCad 的 PCB 编辑器并等 IPC 就绪（S154）。
 *
 * 为什么要这一层：IPC 只对**正在运行的编辑器**生效，没开 KiCad 时任何局部编辑都做不了。
 * 用一个「先看连不连得上，连不上就把板子交给 pcbnew 打开，再等它把 IPC 服务拉起来」的
 * 小流程，把「人先手动开 KiCad」这一步省掉。
 *
 * 启动是 detached：KiCad 是用户的应用，DSH 退出时不该把它带走。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
/** 默认启动器：detached + 忽略输出，KiCad 独立于 DSH 存活。 */
function spawnDetached(spec) {
    const child = spawn(spec.exe, [spec.boardFile], { cwd: spec.cwd, detached: true, stdio: "ignore" });
    child.unref();
}
/** `pcbnew.exe` 的位置：Windows 上就在 `kicad.exe` 旁边。 */
export function pcbnewPath(kicadRoot) {
    const root = kicadRoot.replace(/\\/gu, "/");
    const candidates = [join(root, "bin", "pcbnew.exe"), join(root, "bin", "pcbnew")];
    for (const candidate of candidates) {
        if (existsSync(candidate))
            return candidate;
    }
    return "";
}
/**
 * 用 pcbnew 打开一块板。
 *
 * 单独存在而不是并进 launchAndWait：测试里只关心「拼没拼对可执行文件与参数」，
 * 不必真的拉起 GUI。
 */
export function openBoardInKicad(boardFile, options = {}) {
    const board = boardFile.trim();
    if (board === "")
        return { ok: false, error: "没有可打开的板子文件：先构建一次，或显式给 boardFile", exe: "", boardFile: "" };
    if (!existsSync(board))
        return { ok: false, error: "板子文件不存在：" + board, exe: "", boardFile: board };
    const exe = options.exe !== undefined && options.exe !== "" ? options.exe : pcbnewPath(options.kicadRoot ?? "");
    if (exe === "")
        return { ok: false, error: "找不到 pcbnew.exe：用 DSH_STM32_KICAD_ROOT 指向 KiCad 安装根，或显式给 exe", exe: "", boardFile: board };
    const launcher = options.launcher ?? spawnDetached;
    try {
        launcher({ exe, boardFile: board, cwd: dirname(board) });
    }
    catch (error) {
        return { ok: false, error: "启动 pcbnew 失败：" + String(error instanceof Error ? error.message : error), exe, boardFile: board };
    }
    return { ok: true, error: "", exe, boardFile: board };
}
/**
 * 等 IPC 服务起来：KiCad 从进程启动到 IPC 可用要几秒（加载板子 + 起服务）。
 *
 * 没就绪不是错误，只是「还没好」；超时后由调用方给出「去偏好设置里启用 IPC API」的提示。
 */
export async function waitForIpc(options) {
    const timeoutMs = options.timeoutMs !== undefined && options.timeoutMs > 0 ? options.timeoutMs : 90_000;
    const pollMs = options.pollMs !== undefined && options.pollMs > 0 ? options.pollMs : 2_000;
    const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const startedAt = Date.now();
    let lastError = "";
    for (;;) {
        try {
            const name = await options.probe();
            if (name !== "")
                return { ok: true, boardName: name, waitedMs: Date.now() - startedAt, error: "" };
            lastError = "IPC 还没有响应";
        }
        catch (error) {
            lastError = String(error instanceof Error ? error.message : error);
        }
        if (Date.now() - startedAt >= timeoutMs) {
            return { ok: false, boardName: "", waitedMs: Date.now() - startedAt, error: lastError };
        }
        await sleep(pollMs);
    }
}
