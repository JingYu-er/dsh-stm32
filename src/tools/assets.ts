/**
 * L3：stm32_assets —— 查看 / 校验插件内置资源（assets/）。
 *
 * 2026-11 起资源不再放独立仓库、也不再按需下载：device 事实层（chips.json / svd）、ioc 模板、
 * 链接脚本、启动文件、设备头全部随 npm 包发布，装好插件就能离线用。这个工具因此从「下载器」
 * 变成「体检器」：
 *   · list    内置资源版本、profile=core/full 的文件清单、本地在不在、占多大；
 *   · refresh 旧名字，保留兼容：等价于 verify（资源和插件同版本，没有「刷新」这回事）；
 *   · verify  逐文件 sha256 复核（怀疑装坏 / 被杀软改过 / 手工动过 assets/ 就跑它）；
 *   · prune   只清 DSH_STM32_ASSETS 覆盖目录下的历史版本，内置资源永不删除。
 *
 * 失败不抛：都返回 ok:false + 人话原因；缺文件只可能是插件安装不完整，提示重装插件，
 * 而不是让用户去「联网 refresh」——已经没有那个通道了。
 */

import fs from "node:fs";
import path from "node:path";

import {
  assetsRootInfo,
  listInstalledVersions,
  normalizeProfile,
  profileFiles,
  pruneOldVersions,
  readLocalManifest,
  verifyInstalled,
  type InstalledVersion,
} from "../engine/assets.js";
import type { DshContext, JsonSchema, ToolExec } from "../types.js";

export const ASSETS_TOOL = "stm32_assets";

const BUILTIN_NOTE =
  "资源随插件内置（assets/），不需要联网下载；文件缺失说明插件安装不完整，重装插件即可恢复。";

const fileSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string" },
    bytes: { type: "number" },
    sha256: { type: "string" },
    status: { type: "string" },
    detail: { type: "string" },
  },
  required: ["path", "bytes", "sha256", "status", "detail"],
};

const versionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    version: { type: "string" },
    files: { type: "number" },
    bytes: { type: "number" },
    profiles: { type: "array", items: { type: "string" } },
    installedAt: { type: "string" },
    current: { type: "boolean" },
  },
  required: ["version", "files", "bytes", "profiles", "installedAt", "current"],
};

export const outputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string" },
    ok: { type: "boolean" },
    root: { type: "string" },
    origin: { type: "string" },
    version: { type: "string" },
    profile: { type: "string" },
    source: { type: "string" },
    fileCount: { type: "number" },
    totalBytes: { type: "number" },
    files: { type: "array", items: fileSchema },
    versions: { type: "array", items: versionSchema },
    attempts: { type: "array", items: { type: "string" } },
    offlineFallback: { type: "string" },
    message: { type: "string" },
  },
  required: [
    "action",
    "ok",
    "root",
    "origin",
    "version",
    "profile",
    "source",
    "fileCount",
    "totalBytes",
    "files",
    "versions",
    "attempts",
    "offlineFallback",
    "message",
  ],
};

interface AssetsArgs {
  action?: string;
  profile?: string;
  /** verify / list 指定版本（默认内置 flat 根）。 */
  version?: string;
  /** prune 保留几个历史版本（默认 2：当前 + 上一版）。 */
  keep?: number;
}

interface AssetsFileView {
  path: string;
  bytes: number;
  sha256: string;
  status: string;
  detail: string;
}

interface AssetsVersionView {
  version: string;
  files: number;
  bytes: number;
  profiles: string[];
  installedAt: string;
  current: boolean;
}

interface AssetsValue {
  action: string;
  ok: boolean;
  root: string;
  origin: string;
  version: string;
  profile: string;
  source: string;
  fileCount: number;
  totalBytes: number;
  files: AssetsFileView[];
  versions: AssetsVersionView[];
  attempts: string[];
  offlineFallback: string;
  message: string;
}

export interface AssetsToolOptions {
  /** 测试注入环境变量（DSH_STM32_ASSETS 指到临时目录），生产不传。 */
  env?: NodeJS.ProcessEnv;
}

function toVersionView(item: InstalledVersion): AssetsVersionView {
  return {
    version: item.version,
    files: item.fileCount,
    bytes: item.totalBytes,
    profiles: item.profiles,
    installedAt: item.installedAt,
    current: item.current,
  };
}

function describeBytes(bytes: number): string {
  if (bytes < 1024) return String(bytes) + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(2) + " MB";
}

export function registerAssets(ctx: DshContext, options: AssetsToolOptions = {}): void {
  ctx.tools.register({
    name: ASSETS_TOOL,
    description:
      "查看 / 校验插件内置的 STM32 资源（随包发布，在 assets/：device 事实层 device/<族>/chips.json 与 device/f1/svd、ioc 模板、链接脚本；profile=full 另含 startup/ 与 headers/）。" +
      "不需要联网下载：action=list 看当前版本、文件清单、在不在、占多大；refresh 是 verify 的旧名（等价，保留兼容）；verify 逐文件复核 manifest 的 sha256（怀疑装坏时用）；prune 只清 DSH_STM32_ASSETS 覆盖目录下的历史版本，内置资源永不删除。" +
      "缺文件说明插件安装不完整：返回 ok=false + 人话原因，建议重装插件，而不是去联网刷新——下载通道已经移除。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["list", "refresh", "verify", "prune"],
          description: "list（默认，看内置版本/清单/占用）/ refresh（= verify，旧名保留）/ verify（逐文件 sha256 复核）/ prune（只清 DSH_STM32_ASSETS 下历史版本）。",
        },
        profile: {
          type: "string",
          enum: ["core", "full"],
          description: "core（默认：device/ + ioc/ + ld/，建工程够用）/ full（再加 startup/ + headers/ + svd/）。",
        },
        version: {
          type: "string",
          description: "list / verify 指定版本；不填用内置版本（或 DSH_STM32_ASSETS 下最新历史版本）。",
        },
        keep: {
          type: "number",
          description: "prune 保留几个历史版本（≥1 的整数），默认 2（内置资源不受影响）。",
        },
      },
      required: [],
    },
    timeoutMs: 5 * 60_000,
    isConcurrencySafe: () => false,
    output: {
      schema: outputSchema,
      render: (_args, value) => {
        const typed = value as AssetsValue;
        const lines: string[] = [typed.message];
        lines.push("资源目录：" + typed.root + "（来源：" + typed.origin + "）；profile=" + typed.profile);
        if (typed.source !== "") lines.push("资源来源：" + typed.source);
        if (typed.versions.length > 0) {
          const items = typed.versions.map(
            (item) =>
              item.version +
              (item.current ? "（当前）" : "") +
              "：" + String(item.files) + " 个文件、" + describeBytes(item.bytes) +
              "，profile=" + item.profiles.join("+"),
          );
          lines.push("本地资源：" + items.join("；"));
        }
        if (typed.files.length > 0) {
          const head = typed.files.slice(0, 10);
          for (const file of head) {
            lines.push("· " + file.path + "（" + describeBytes(file.bytes) + "）→ " + file.status + (file.detail === "" ? "" : "：" + file.detail));
          }
          if (typed.files.length > head.length) lines.push("… 还有 " + String(typed.files.length - head.length) + " 个文件（action=list 看全量）");
          lines.push("合计 " + String(typed.fileCount) + " 个文件、" + describeBytes(typed.totalBytes));
        }
        if (typed.attempts.length > 0) lines.push("尝试记录：" + typed.attempts.join(" ｜ "));
        if (typed.offlineFallback !== "") lines.push("提示：" + typed.offlineFallback);
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(rawArgs: AssetsArgs | undefined, _exec: ToolExec): Promise<AssetsValue> {
      const args = rawArgs ?? {};
      const action = (args.action ?? "list").trim().toLowerCase();
      const env = options.env ?? process.env;
      const info = assetsRootInfo(env);
      const profile = normalizeProfile(args.profile);
      const versionsOf = (): AssetsVersionView[] => listInstalledVersions(env).map(toVersionView);
      const base = (): AssetsValue => ({
        action,
        ok: false,
        root: info.root,
        origin: info.origin,
        version: "",
        profile: profile ?? (args.profile ?? "").trim(),
        source: "",
        fileCount: 0,
        totalBytes: 0,
        files: [],
        versions: versionsOf(),
        attempts: [],
        offlineFallback: "",
        message: "",
      });

      if (profile === null) {
        return {
          ...base(),
          message: "不认识的 profile：" + String(args.profile) + "（只有 core / full）。什么都没做。",
        };
      }

      /* ---------------------------- list ---------------------------- */
      if (action === "list") {
        const value = base();
        const state = readLocalManifest(env, args.version);
        if (state.manifest === null) {
          value.offlineFallback = BUILTIN_NOTE;
          value.message = "找不到内置资源（" + info.root + "）：" + state.error;
          return value;
        }
        value.ok = true;
        value.version = state.version;
        value.source = state.bundled ? "bundled（插件内置）" : "cache（DSH_STM32_ASSETS）";
        for (const target of profileFiles(state.manifest, profile)) {
          const localPath = path.join(state.versionDir, target.path);
          let present = false;
          try {
            present = fs.statSync(localPath).isFile();
          } catch {
            present = false;
          }
          value.files.push({
            path: target.path,
            bytes: target.bytes,
            sha256: target.sha256,
            status: present ? "present" : "missing",
            detail: present ? "在磁盘上（未校验；action=verify 逐文件复核 sha256）" : "manifest 里列了，但本地没有这个文件（重装插件修复）",
          });
        }
        value.fileCount = value.files.length;
        value.totalBytes = value.files.reduce((sum, file) => sum + file.bytes, 0);
        value.message =
          "内置资源 " + state.version + "（profile=" + profile + "）：" + String(value.fileCount) + " 个文件、约 " +
          describeBytes(value.totalBytes) + "；目录 " + state.versionDir + "。";
        return value;
      }

      /* ------------------------ refresh / verify ------------------------ */
      if (action === "refresh" || action === "verify") {
        const value = base();
        const result = verifyInstalled({
          profile,
          env,
          ...(args.version === undefined ? {} : { version: args.version }),
        });
        value.ok = result.ok;
        value.version = result.version;
        value.source = readLocalManifest(env, args.version).bundled ? "bundled（插件内置）" : "cache（DSH_STM32_ASSETS）";
        value.fileCount = result.fileCount;
        value.totalBytes = result.totalBytes;
        value.files = result.files.map((file) => ({
          path: file.path,
          bytes: file.bytes,
          sha256: file.sha256,
          status: file.status,
          detail: file.detail,
        }));
        value.message =
          (action === "refresh" ? "资源随插件内置，不需要下载；这次做了一次完整性校验。" : "") +
          result.message;
        if (!result.ok) value.offlineFallback = BUILTIN_NOTE;
        return value;
      }

      /* ---------------------------- prune ---------------------------- */
      if (action === "prune") {
        const value = base();
        // schema 里不能再写 minimum（宿主 0.2.2 的 schema 子集不认），范围改在这里兜。
        if (args.keep !== undefined && (typeof args.keep !== "number" || !Number.isFinite(args.keep) || Math.floor(args.keep) < 1)) {
          value.ok = false;
          value.message = "keep 必须是 ≥1 的整数（实际 " + JSON.stringify(args.keep) + "）。什么都没删。";
          return value;
        }
        const keep = typeof args.keep === "number" ? Math.floor(args.keep) : 2;
        const pruned = pruneOldVersions(env, keep);
        value.ok = true;
        value.versions = versionsOf();
        value.version = pruned.kept[0] ?? (readLocalManifest(env).version);
        value.totalBytes = pruned.reclaimedBytes;
        value.message = pruned.message;
        return value;
      }

      const value = base();
      value.message = "不认识的 action：" + action + "（只有 list / refresh / verify / prune）。什么都没做。";
      return value;
    },
  });
}
