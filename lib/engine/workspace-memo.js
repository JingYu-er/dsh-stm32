/**
 * 最近一次用过的工程目录（S84 补）。
 *
 * Web API 是独立于会话的 HTTP 入口，拿不到 agent；宿主的 `workingDirectory.ensure()`
 * 在没有会话对象时也可能给不出目录。这里在工具入口每次定下工程目录时记一笔，
 * 面板缺 projectDir 时就能回退到「上一个真用过的工程」，而不是进程工作目录。
 *
 * 只记一个路径、纯文本；读不到就返回空串，不抛。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
/** 备忘文件路径：默认 `~/.dsh-stm32/last-workspace.txt`，可用 DSH_STM32_HOME 覆盖根目录。 */
export function workspaceMemoPath(env = process.env) {
    const root = typeof env.DSH_STM32_HOME === "string" && env.DSH_STM32_HOME.trim() !== ""
        ? env.DSH_STM32_HOME.trim()
        : join(homedir(), ".dsh-stm32");
    return join(root, "last-workspace.txt");
}
/** 记下这次用的工程目录；写失败静默（只是备忘，不影响功能）。 */
export function rememberWorkspace(dir, env = process.env) {
    const trimmed = dir.trim();
    if (trimmed === "")
        return;
    try {
        mkdirSync(dirname(workspaceMemoPath(env)), { recursive: true });
        writeFileSync(workspaceMemoPath(env), trimmed + "\n", "utf8");
    }
    catch {
        /* 备忘写不了就算了 */
    }
}
/** 读上一次记下的工程目录；没有或读不了返回空串。 */
export function recallWorkspace(env = process.env) {
    try {
        return readFileSync(workspaceMemoPath(env), "utf8").trim();
    }
    catch {
        return "";
    }
}
