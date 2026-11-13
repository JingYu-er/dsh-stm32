/**
 * 会话身份与 agent 的对照表（S84 引入，S91 改为按会话索引）。
 *
 * Web API 没有 agent 对象，宿主的 `workingDirectory.ensure()` 因此给不出会话目录。
 * 工具调用与会话事件里一定有 agent，这里按会话 id 记下来，Web API 拿请求里的
 * `session` 去查，只解析这一条会话自己的工作目录。
 *
 * 只记最近的若干条，不做生命周期管理：会话结束后条目留在表里也无害，
 * 缺省容量足够覆盖同时打开的几个会话。
 */
/** 最多记住多少条会话；超出时丢掉最早的一条。 */
const SESSION_LIMIT = 64;
/** 会话 id → 该会话最近一次带来的 agent。 */
const agents = new Map();
/** 会话 id → 该会话的工作目录。agent 一创建就向宿主换一次，面板首次打开即可用。 */
const dirs = new Map();
/** 没有会话 id 时记在空键上，仅供工具侧解析（Web API 不读它，避免跨会话串用）。 */
let lastAgent = undefined;
/** 取 agent 自带的 id（宿主会话 id 与工具的 `exec.agent.id` 未必同形，两者都记）。 */
export function agentIdOf(agent) {
    if (agent === null || typeof agent !== "object")
        return "";
    const id = agent["id"];
    return typeof id === "string" ? id.trim() : "";
}
function remember(key, agent) {
    const trimmed = key.trim();
    if (trimmed === "")
        return;
    // 宿主与工具层对同一会话的写法不统一：可能带 `session-` 前缀，也可能是裸 UUID。
    // 三种写法都登记，任何一方查都命中；条目仍在容量上限内，不跨会话。
    const bare = trimmed.startsWith("session-") ? trimmed.slice("session-".length) : trimmed;
    const names = new Set([trimmed, bare, "session-" + bare]);
    for (const name of names) {
        if (name === "")
            continue;
        agents.set(name, agent);
    }
    while (agents.size > SESSION_LIMIT) {
        const oldest = agents.keys().next();
        if (oldest.done === true)
            return;
        agents.delete(oldest.value);
    }
}
/**
 * 记一条会话的 agent；会话 id 为空时只更新兜底引用。
 *
 * 同时按 agent 自己的 id 记一份：调试台的 `conversation.view` 注入的会话 id 与工具层
 * 的 `exec.agent.id` 是同一个值，但 session/event 的 session 上不一定带 header.id。
 * 只记 sessionId 会让 Web API 永远查不到，面板只能显示「没有可用的会话工作目录」。
 */
export function noteSessionAgent(sessionId, agent) {
    if (agent === undefined || agent === null)
        return;
    lastAgent = agent;
    remember(sessionId.trim(), agent);
    remember(agentIdOf(agent), agent);
}
/** 按会话 id 取 agent；没有记录返回 undefined。 */
export function agentOfSession(sessionId) {
    const key = sessionId.trim();
    if (key === "")
        return undefined;
    return agents.get(key);
}
/** 最近一次工具调用带来的 agent；工具侧解析工程目录时使用。 */
export function lastSessionAgent() {
    return lastAgent;
}
/** 清空对照表（测试用）。 */
/**
 * 记一条会话的工作目录。
 *
 * 与 `noteSessionAgent` 用同一套写法归一：宿主给的是 `session-<uuid>` 还是裸 UUID 都登记。
 * 目的：面板第一次打开时不必先调用一次 STM32 工具，`/projects` 就能给出默认工程。
 */
export function noteSessionDir(sessionId, dir) {
    const trimmed = sessionId.trim();
    if (trimmed === "" || dir.trim() === "")
        return;
    const bare = trimmed.startsWith("session-") ? trimmed.slice("session-".length) : trimmed;
    for (const name of new Set([trimmed, bare, "session-" + bare])) {
        if (name === "")
            continue;
        dirs.set(name, dir);
    }
    while (dirs.size > SESSION_LIMIT) {
        const oldest = dirs.keys().next();
        if (oldest.done === true)
            return;
        dirs.delete(oldest.value);
    }
}
/** 按会话 id 取已记下的工作目录；没有记录返回空串。 */
export function sessionDirOf(sessionId) {
    const trimmed = sessionId.trim();
    if (trimmed === "")
        return "";
    return dirs.get(trimmed) ?? "";
}
export function resetSessionAgents() {
    agents.clear();
    dirs.clear();
    lastAgent = undefined;
}
