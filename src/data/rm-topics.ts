/**
 * rm-topics（主题/锚点清单）的两层装载。
 *
 * 为什么需要「spec」这一层：机器是阅卷人而非出题人——自动抽取必须有人（或经历过已知问题的会话）
 * 给出「要采信哪几条结论 + 在 RM 里逐字回查什么」，机器才能核验并落 semantics。
 *
 * 装载顺序（两层合并，同 id 用户赢）：
 *   1) 插件自带的族级 spec：lib/data/rm-topics/<族>.json（源在 src/data/rm-topics/，
 *      随包发布；scripts/copy-data.mjs 负责进 lib）。
 *   2) 用户芯片级 spec：<factsRoot>/topics/<族>/<线>.json——只覆盖手上这颗。
 *      用户遇到已知问题（例如某条选项字节规则导致板子无法连接），将「该结论 + 回查锚点」
 *      写成一份小 JSON 放入此处，该芯片下一次烧录前必须通过机检；未写入的其他
 *      芯片不受影响（族级判据过粗，已知问题通常是芯片级的，见 2026-11-07 决定）。
 *
 * 判定「这颗芯片要不要过机检」= 合并后主题数 > 0。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface RmTopicEntry {
  id: string;
  statement: string;
  /** 期望物理页（±3 内逐字回查）。 */
  page: number;
  /** 全部必须逐字出现的锚点。 */
  anchors: string[];
  anchorEnd?: string;
  rows?: string[][];
  svd?: { reg: string; field: string; bitOffset: number; enums?: string[] }[];
}

export interface LoadedTopics {
  topics: RmTopicEntry[];
  /** 核验范围内要过的线：族级 spec 的 lines ∪ 用户 spec 的 lines。 */
  lines: string[];
  /** rm 文档标识（抽取时进 doc.id）。 */
  docId: string;
  /** 装载来源（诊断用）。 */
  origins: string[];
  /** true = 这颗芯片必须过机检才放行烧录。 */
  hasSpec: boolean;
}

const EMPTY: LoadedTopics = { topics: [], lines: [], docId: "", origins: [], hasSpec: false };

interface RawTopicFile {
  topics?: unknown;
  lines?: unknown;
  doc?: { id?: unknown };
}

function normalize(raw: unknown, fallbackLines: string[]): { topics: RmTopicEntry[]; lines: string[]; docId: string } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as RawTopicFile;
  if (!Array.isArray(o.topics) || o.topics.length === 0) return null;
  const topics = o.topics.filter((x): x is RmTopicEntry => {
    if (typeof x !== "object" || x === null) return false;
    const e = x as { id?: unknown; anchors?: unknown };
    return typeof e.id === "string" && Array.isArray(e.anchors) && e.anchors.length > 0;
  });
  if (topics.length === 0) return null;
  const lines = Array.isArray(o.lines) ? o.lines.map((x) => String(x).toUpperCase()) : fallbackLines;
  const docId = typeof o.doc?.id === "string" ? o.doc.id : "";
  return { topics, lines, docId };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * 插件自带族级 spec 的目录：lib/data/rm-topics/（JSON 不进 tsc，由
 * scripts/copy-data.mjs 在 build 时复制；仓库里 lib/ 是入库的，装包侧也带）。
 * 未回退到 src：该相对路径在插件真实安装位置（node_modules 深处）
 * 基本不可能存在，留着只会把「没跑 copy-data」伪装成「清单在但读不到」。
 */
export function bundledTopicsDir(): string {
  return fileURLToPath(new URL("./rm-topics/", import.meta.url));
}

/** 用户芯片级 spec 的路径（暴露给用户/会话往里放）。 */
export function userTopicsPath(factsRoot: string, family: string, line: string): string {
  return join(factsRoot, "topics", family.toLowerCase(), line.toUpperCase() + ".json");
}

/**
 * 两层合并装载。factsRoot 由调用方传入（engine/facts 的 factsRoot(env)），
 * 本模块不 import engine——data 层保持无环。
 */
export function loadRmTopics(family: string, line: string, factsRoot: string): LoadedTopics {
  const fam = family.toLowerCase();
  const ln = line.toUpperCase();
  const merged = new Map<string, RmTopicEntry>();
  const lines = new Set<string>();
  const origins: string[] = [];
  let docId = "";

  const famFile = join(bundledTopicsDir(), fam + ".json");
  if (existsSync(famFile)) {
    const n = normalize(readJson(famFile), []);
    if (n !== null) {
      for (const tp of n.topics) merged.set(tp.id, tp);
      for (const l of n.lines) lines.add(l);
      docId = n.docId;
      origins.push("bundled:" + famFile);
    }
  }

  const userFile = userTopicsPath(factsRoot, fam, ln);
  if (existsSync(userFile)) {
    const n = normalize(readJson(userFile), [ln]);
    if (n !== null) {
      for (const tp of n.topics) merged.set(tp.id, tp); // 同 id 用户赢
      for (const l of n.lines) lines.add(l);
      if (docId === "") docId = n.docId;
      origins.push("user:" + userFile);
    }
  }

  const topics = [...merged.values()];
  if (topics.length === 0) return EMPTY;
  // 用户 spec 未写 lines 时仅针对该芯片（fallbackLines 回退）；族级有 lines 时遵循族级
  if (lines.size === 0) lines.add(ln);
  return { topics, lines: [...lines].sort(), docId, origins, hasSpec: true };
}
