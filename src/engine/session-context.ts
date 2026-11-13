/**
 * 最近一次工具调用带来的会话 agent（S84 补第二波）。
 *
 * Web API 没有 agent 对象，宿主的 `workingDirectory.ensure()` 因此给不出会话目录。
 * 工具调用里一定有 agent，这里记下最近一个，Web API 的 resolver 就能拿它去问宿主。
 *
 * 只持有一个引用，不做生命周期管理；会话结束时不清理（下一轮会被覆盖）。
 */

let lastAgent: unknown = undefined;

/** 工具调用入口每轮记一次；只留最新的。 */
export function noteSessionAgent(agent: unknown): void {
  if (agent === undefined || agent === null) return;
  lastAgent = agent;
}

/** 供 Web API 的 workspace resolver 使用；没记录过返回 undefined。 */
export function lastSessionAgent(): unknown {
  return lastAgent;
}
