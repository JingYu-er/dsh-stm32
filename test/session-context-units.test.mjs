import test from "node:test";
import assert from "node:assert/strict";
import { agentOfSession, lastSessionAgent, noteSessionAgent, resetSessionAgents } from "../lib/engine/session-context.js";
import { debugSessionForeign } from "../lib/engine/web-api.js";

test("会话 agent 对照表：按会话 id 取回，互不串用（S91）", () => {
  resetSessionAgents();
  const a = { id: "agent-a" };
  const b = { id: "agent-b" };
  noteSessionAgent("s1", a);
  noteSessionAgent("s2", b);
  assert.equal(agentOfSession("s1"), a);
  assert.equal(agentOfSession("s2"), b);
  assert.equal(agentOfSession("s3"), undefined, "没记过的会话不能借别人的 agent");
  assert.equal(agentOfSession(""), undefined, "空会话 id 不查表");
  assert.equal(lastSessionAgent(), b, "兜底引用只给工具侧用，跟着最近一条走");
  resetSessionAgents();
  assert.equal(agentOfSession("s1"), undefined);
  assert.equal(lastSessionAgent(), undefined);
});

test("会话 agent 对照表：同时按 agent.id 记一份，工具层登记的会话 id 也查得到（S91）", () => {
  resetSessionAgents();
  const agent = { id: "session-6c6c19e8-a30b-435e-ab7c-6168d8f03803" };
  // 工具层只有 agent，没有宿主的会话对象；调试台请求带的正是 agent.id。
  noteSessionAgent(agent.id, agent);
  assert.equal(agentOfSession("session-6c6c19e8-a30b-435e-ab7c-6168d8f03803"), agent);
  resetSessionAgents();
  noteSessionAgent("s1", agent);
  assert.equal(agentOfSession(agent.id), agent, "会话 id 与 agent.id 不同形时两把钥匙都能开");
  assert.equal(agentOfSession("s1"), agent);
  resetSessionAgents();
});

test("会话 agent 对照表：超过容量时丢最早的一条", () => {
  resetSessionAgents();
  for (let index = 0; index < 65; index += 1) noteSessionAgent("k" + String(index), { index });
  assert.equal(agentOfSession("k0"), undefined, "最早的一条被挤掉");
  assert.notEqual(agentOfSession("k64"), undefined, "最近的一条保留");
  resetSessionAgents();
});

test("调试会话归属：别的会话的调试会话不可见，查不到时不拦（S91）", () => {
  resetSessionAgents();
  noteSessionAgent("s1", { id: "agent-1" });
  assert.equal(debugSessionForeign("", "agent-1"), false, "请求不带会话 id 时保持老行为");
  assert.equal(debugSessionForeign("s1", ""), false, "owner 未知时不拦");
  assert.equal(debugSessionForeign("s1", "agent-1"), false, "自己启动的会话可见");
  assert.equal(debugSessionForeign("s1", "agent-2"), true, "另一条会话启动的会话不可见");
  assert.equal(debugSessionForeign("s-unknown", "agent-2"), false, "查不到会话的 agent 时不拦");
  resetSessionAgents();
});
