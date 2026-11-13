/**
 * 工具调用的统一事件埋点：不逐个工具改 execute，而是在装配时包一层。
 *
 * 做法：给 apply 用的 ctx 套一个 Proxy，只替换 `tools.register`。
 * 其余属性原样转发（绑定到真实 ctx，避免 cordis 内部的 this 语义被破坏）。
 *
 * 每条工具调用产生两条事件：start 与配对的 ok/fail，共享工具名。
 * 摘要是给人看的一行字，完整参数与结果放进 payload，超过 8 KB 时由总线截断。
 */

import { emitEvent, setEventSessionKey } from "./event-bus.js";
import { beginToolCall } from "./progress.js";
import type { DshContext, ToolDefinition, ToolExec, ToolsService } from "../types.js";

function firstLine(text: string, limit = 160): string {
  const line = text.split(/\r?\n/u)[0] ?? "";
  return line.length > limit ? line.slice(0, limit) + "…" : line;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return firstLine(error.message === "" ? error.name : error.message);
  return firstLine(String(error));
}

/** 从返回值里挑少量字段进事件，避免把整个产物结构塞进时间线。 */
function resultDigest(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const digest: Record<string, unknown> = {};
  for (const key of ["ok", "summary", "error", "message", "elfPath", "hexPath", "binPath", "port", "taskId", "memoryUsage", "warningCount", "projectDir"]) {
    if (record[key] !== undefined) digest[key] = record[key];
  }
  // 编译错误最多带 20 条：面板用它跳源码，再多也只是刷屏。
  const errors = record["errors"];
  if (Array.isArray(errors) && errors.length > 0) digest["errors"] = errors.slice(0, 20);
  // 编译警告同样截断：多数警告不影响烧录，但「有几条、是什么」要看得见（S75）。
  const warnings = record["warnings"];
  if (Array.isArray(warnings) && warnings.length > 0) digest["warnings"] = warnings.slice(0, 20);
  return Object.keys(digest).length === 0 ? undefined : digest;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return String(Math.round(ms)) + " ms";
  return (ms / 1000).toFixed(1) + " s";
}

/** 给单个工具定义加 start / ok / fail 事件。 */
export function withToolEvents(definition: ToolDefinition): ToolDefinition {
  const original = definition.execute;
  return {
    ...definition,
    execute: async (args: unknown, exec: ToolExec): Promise<unknown> => {
      const startedAt = Date.now();
      const owner = exec?.agent?.id;
      if (typeof owner === "string" && owner !== "") setEventSessionKey(owner);
      // 登记在途调用：面板能列出「谁在跑」，也能中止（abort 会透传到子进程）。
      const running = beginToolCall({ name: definition.name, session: owner, outer: exec?.signal });
      emitEvent({
        source: "model",
        kind: definition.name,
        status: "start",
        summary: definition.name + " 开始",
        payload: { args: args as Record<string, unknown>, callId: running.info.id },
        session: owner,
      });
      try {
        const value = await original(args, exec === undefined ? exec : { ...exec, signal: running.signal });
        emitEvent({
          source: "model",
          kind: definition.name,
          status: "ok",
          summary: definition.name + " 完成（" + formatDuration(Date.now() - startedAt) + "）",
          payload: { durationMs: Date.now() - startedAt, callId: running.info.id, result: resultDigest(value) },
          session: owner,
        });
        running.end();
        return value;
      } catch (error) {
        emitEvent({
          source: "model",
          kind: definition.name,
          status: "fail",
          summary: definition.name + " 失败：" + describeError(error),
          payload: { durationMs: Date.now() - startedAt, callId: running.info.id, error: describeError(error) },
          session: owner,
        });
        running.end();
        throw error;
      }
    },
  };
}

/**
 * 返回一个只替换了 `tools` 的 ctx 代理，供 apply 里注册工具使用。
 *
 * 参数：deps 由调用方传 `{}`，留给后续按工具过滤/采样用。
 */
export function instrumentContext(
  ctx: DshContext,
  options: { include?: (name: string) => boolean } = {},
): DshContext {
  const include = options.include ?? ((name: string) => name.startsWith("stm32_"));
  const tools: ToolsService = {
    register(tool: ToolDefinition): () => void {
      return ctx.tools.register(include(tool.name) ? withToolEvents(tool) : tool);
    },
  };
  return new Proxy(ctx, {
    get(target, property) {
      if (property === "tools") return tools;
      const value = Reflect.get(target, property, target);
      if (typeof value === "function") return value.bind(target);
      return value;
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target);
    },
  });
}
