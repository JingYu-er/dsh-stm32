/**
 * L3：stm32_cache —— 看/验/拉/清 下载缓存。
 *
 * 缓存里放的是"不属于插件、但建工程要用"的东西：目前是 CMSIS 设备头 + 启动文件 + 内核头。
 * 用户要能自己看见"下到哪了、对不对、占多大、能不能清"，所以这四个动作必须是一等公民，
 * 而不是藏在 error 信息里。
 */

import {
  cacheRootInfo,
  checkCacheEntry,
  describeCacheBytes,
  readCacheIndex,
  removeCacheEntry,
  resolveCacheEntry,
  type CacheEntry,
  type CacheIndex,
} from "../engine/cache.js";
import { ensureCmsisTemplate } from "../engine/register-template.js";
import type { DshContext, JsonSchema, ToolExec } from "../types.js";

export const CACHE_TOOL = "stm32_cache";

const entrySchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    kind: { type: "string" },
    family: { type: "string" },
    label: { type: "string" },
    root: { type: "string" },
    files: { type: "number" },
    bytes: { type: "number" },
    createdAt: { type: "string" },
    status: { type: "string" },
    detail: { type: "string" },
  },
  required: ["id", "kind", "family", "label", "root", "files", "bytes", "createdAt"],
};

export const outputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string" },
    ok: { type: "boolean" },
    cacheRoot: { type: "string" },
    indexPath: { type: "string" },
    origin: { type: "string" },
    totalBytes: { type: "number" },
    entries: { type: "array", items: entrySchema },
    message: { type: "string" },
  },
  required: ["action", "ok", "cacheRoot", "indexPath", "origin", "totalBytes", "entries", "message"],
};

interface CacheArgs {
  action?: string;
  id?: string;
  mcu?: string;
  family?: string;
  /** purge 不给 id 时表示"清空整个缓存"，必须显式确认（A8）。 */
  confirm?: boolean;
}

interface CacheValue {
  action: string;
  ok: boolean;
  cacheRoot: string;
  indexPath: string;
  origin: string;
  totalBytes: number;
  entries: Array<{
    id: string;
    kind: string;
    family: string;
    label: string;
    root: string;
    files: number;
    bytes: number;
    createdAt: string;
    status?: string;
    detail?: string;
  }>;
  message: string;
}

function listEntries(index: CacheIndex, verify: boolean): CacheValue["entries"] {
  return index.entries.map((entry: CacheEntry) => {
    const base = {
      id: entry.id,
      kind: entry.kind,
      family: entry.family,
      label: entry.label,
      root: entry.root,
      files: entry.files.length,
      bytes: entry.totalBytes,
      createdAt: entry.createdAt,
    };
    if (!verify) return base;
    const health = checkCacheEntry(entry);
    return {
      ...base,
      status: health.ok ? "ok" : "broken",
      detail: health.ok
        ? "文件齐全、大小对得上"
        : "缺 " + String(health.missing.length) + " 个、大小不对 " + String(health.changed.length) + " 个：" + [...health.missing, ...health.changed].slice(0, 5).join("；"),
    };
  });
}

export function registerCache(ctx: DshContext): void {
  ctx.tools.register({
    name: CACHE_TOOL,
    description:
      "看 / 验 / 拉 / 清 插件的下载缓存（默认 %LOCALAPPDATA%\\dsh-stm32\\cache，可用 DSH_STM32_CACHE 覆盖）：寄存器版模板（CMSIS 设备头 + 启动文件 + 内核头）第一次用时从网上下载到这里，之后复用。action=list 列出条目、verify 逐文件校验、fetch 按型号拉一次（已缓存则直接复用）、purge 删条目（不给 id 就清空）。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["list", "verify", "fetch", "purge"], description: "list（默认）/ verify / fetch / purge" },
        id: { type: "string", description: "条目 id，例如 cmsis:F1:103xb（purge/verify 用）；也认 cmsis:F1:startup_stm32f103xb、F1:B、STM32F103C8T6 这些写法。" },
        mcu: { type: "string", description: "芯片型号，例如 STM32F103C8T6（fetch 用）。" },
        family: { type: "string", description: "只给族时写这里，例如 F1（fetch 用；按中容量档处理）。" },
        confirm: { type: "boolean", description: "purge 且不给 id 时（清空整个缓存）必须为 true；只删一条用 id 即可。" },
      },
      required: [],
    },
    timeoutMs: 5 * 60_000,
    isConcurrencySafe: () => false,
    output: {
      schema: outputSchema,
      render: (_args, value) => {
        const typed = value as CacheValue;
        const lines: string[] = [typed.message];
        lines.push("缓存目录：" + typed.cacheRoot + "（来源：" + typed.origin + "）");
        lines.push("索引：" + typed.indexPath + "；共 " + String(typed.entries.length) + " 个条目、" + describeCacheBytes(typed.totalBytes));
        for (const entry of typed.entries) {
          lines.push("· " + entry.id + "（" + entry.kind + "）" + describeCacheBytes(entry.bytes) + "、" + String(entry.files) + " 个文件" + (entry.status === undefined ? "" : " → " + entry.status));
          if (entry.detail !== undefined) lines.push("    " + entry.detail);
        }
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(rawArgs: CacheArgs | undefined, exec: ToolExec): Promise<CacheValue> {
      const args = rawArgs ?? {};
      const action = (args.action ?? "list").trim().toLowerCase();
      const info = cacheRootInfo(process.env);
      const { index, error } = readCacheIndex(process.env);
      const empty = (message: string, ok = false): CacheValue => ({
        action,
        ok,
        cacheRoot: info.root,
        indexPath: info.indexPath,
        origin: info.origin,
        totalBytes: 0,
        entries: [],
        message,
      });

      if (action === "list" || action === "verify") {
        const entries = listEntries(index, action === "verify");
        if (args.id !== undefined) {
          // 按"用户可能怎么写"解析（cmsis:F1:103xb / 0.1 的 startup_stm32f103xb / F1:B / 型号）。
          const target = resolveCacheEntry(index, args.id);
          const kept = target === null ? [] : entries.filter((entry) => entry.id === target.id);
          const hint = target === null ? "" : target.id === args.id ? "" : "（已按别名解析成 " + target.id + "）";
          return {
            action,
            ok: error === null,
            cacheRoot: info.root,
            indexPath: info.indexPath,
            origin: info.origin,
            totalBytes: kept.reduce((sum, entry) => sum + entry.bytes, 0),
            entries: kept,
            message: (error ?? "") + (kept.length === 0 ? "缓存里没有条目 " + args.id + "。" : "缓存里有 " + String(kept.length) + " 个条目" + hint + "。"),
          };
        }
        return {
          action,
          ok: error === null,
          cacheRoot: info.root,
          indexPath: info.indexPath,
          origin: info.origin,
          totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
          entries,
          message: (error ?? "") + (entries.length === 0 ? "缓存是空的：第一次建寄存器版工程（或 action=fetch）时会从网上下载模板。" : "缓存里有 " + String(entries.length) + " 个条目。"),
        };
      }

      if (action === "fetch") {
        if ((args.mcu ?? "") === "" && (args.family ?? "") === "") {
          return empty("fetch 至少给一个 mcu（例如 STM32F103C8T6）或 family（例如 F1）。");
        }
        const result = await ensureCmsisTemplate({
          ...(args.mcu === undefined ? {} : { mcu: args.mcu }),
          ...(args.family === undefined ? {} : { family: args.family }),
          // 取消要能真的传到网络层（A34）：模板 10 个文件、4 个候选源，用户按取消时不能还慢慢下。
          signal: exec.signal,
        });
        const after = readCacheIndex(process.env).index;
        const entries = listEntries(after, false);
        return {
          action,
          ok: result.ok,
          cacheRoot: info.root,
          indexPath: info.indexPath,
          origin: info.origin,
          totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
          entries: entries.filter((entry) => result.id === "" || entry.id === result.id),
          message: result.message,
        };
      }

      if (action !== "purge") {
        // 以前这里直接掉进 purge 分支：action 拼错一个字母（或模型传了不认识的值）就等于清空缓存（A8）。
        return empty("不认识的 action：" + action + "（只有 list / verify / fetch / purge）。什么都没动。");
      }

      // purge
      if (args.id !== undefined) {
        // 同样先解析别名：0.1 的 id 写法也得删得掉，否则用户以为删了、下次还是旧文件。
        const target = resolveCacheEntry(index, args.id);
        const removed = target === null ? { removed: false, indexPath: info.indexPath } : removeCacheEntry(target.id, process.env);
        const after = readCacheIndex(process.env).index;
        const entries = listEntries(after, false);
        return {
          action: "purge",
          ok: true,
          cacheRoot: info.root,
          indexPath: info.indexPath,
          origin: info.origin,
          totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
          entries,
          message: removed.removed
            ? "已删掉缓存条目 " + (target === null ? args.id : target.id) + "（目录也清了）。"
            : "缓存里没有条目 " + args.id + "，什么都没删。",
        };
      }
      const all = readCacheIndex(process.env).index.entries;
      if (all.length === 0) {
        return empty("缓存本来就是空的。", true);
      }
      if (args.confirm !== true) {
        // 清空是破坏性操作：没有 confirm 就说清楚要什么，不删（A8）。
        const entries = listEntries(index, false);
        return {
          action: "purge",
          ok: false,
          cacheRoot: info.root,
          indexPath: info.indexPath,
          origin: info.origin,
          totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
          entries,
          message: "要清空整个缓存（" + String(all.length) + " 个条目、共 " + describeCacheBytes(entries.reduce((sum, entry) => sum + entry.bytes, 0)) + "）必须带 confirm:true；只想删一个条目就给 id。什么都没删。",
        };
      }
      let removed = 0;
      for (const entry of all) if (removeCacheEntry(entry.id, process.env).removed) removed += 1;
      return {
        action: "purge",
        ok: true,
        cacheRoot: info.root,
        indexPath: info.indexPath,
        origin: info.origin,
        totalBytes: 0,
        entries: [],
        message: "已清空缓存（索引里原有 " + String(all.length) + " 个条目，实际删掉 " + String(removed) + " 个）。下次建工程会重新下载。"
          + (removed === all.length ? "" : "剩下 " + String(all.length - removed) + " 个只删了索引记录（目录可能不在了或被占用）。"),
      };
    },
  });
}
