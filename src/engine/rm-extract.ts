/**
 * rm-facts 自动抽取与两道机检（替代人核）。
 *
 * 流程：主题规格（id/statement/page/anchors/svd）+ PDF 页面文本 + 各线 SVD 结构
 *   → 逐条核验 → 只把全过的条目写进 rm-facts（带逐字 quote 与实证页码），拒的带原因。
 * 机检①「锚点/引文」：anchors 全部要在 page±3 的归一化文本里逐字出现，
 *   evidence.quote 直接从命中页按锚点窗口截取（不是人重写），RM 改版/页码漂移即失败——
 *   这专门钉死 §4 那类推断错：旧中文 Rev 1 时代写的「SYSCLK 第 4 个上升沿锁存」
 *   在 EN Rev 6 全文找不到锚点 → 自动拒收（RM0490 实际写的是 latched after a reset
 *   + BOOT0 pin sampling is done on NRST rising edge）。
 * 机检②「SVD 交叉」：spec.svd 要求的 {reg, field, bitOffset} 必须在该线 SVD 里存在
 *   （字段名大小写不敏感——C071 是小写 nBOOT_SEL，其余线大写），枚举值命中才适用；
 *   不适用的线从 appliesTo 剔除。声明只给结构不给的组合规则，这里只做一致性核验。
 */

import type { SvdStructure } from "./facts-acquire.js";

export interface RmTopicSpec {
  /** 目标线与候选线。 */
  family: string;
  lines: string[];
  topics: RmTopic[];
}

export interface RmTopic {
  id: string;
  /** 人写的简明结论（进 statement）。 */
  statement: string;
  /** 期望物理页（±3 内搜索；命中页才写进 evidence）。 */
  page: number;
  /** 全部必须逐字出现的锚点（归一化：折叠空白、大小写不敏感）。 */
  anchors: string[];
  /** 引文窗口：从该锚起、到该锚止（缺 anchorEnd 则取 700 字符）。 */
  anchorEnd?: string;
  /**
   * 表格逐行回查（boot 模式表 7 行这类）。每行是单元格文本数组，
   * pymupdf 的 get_text 保持单元格顺序（换行分隔），归一化后就是 "0 x 0 0 x Main flash memory"
   * 这样的串；任一行没逐字命中就整条拒收。
   */
  rows?: string[][];
  /** SVD 交叉要求：该线必须存在的字段（大小写不敏感）与枚举值。 */
  svd?: { reg: string; field: string; bitOffset: number; enums?: string[] }[];
}

export interface PdfPageText {
  page: number;
  text: string;
}

export interface RmFactsItemOut {
  id: string;
  statement: string;
  source: { page: number; section?: string };
  evidence: { quote: string; normalized: boolean };
  appliesTo: string[];
  table?: Record<string, string>[];
}

export interface RmExtractReport {
  ok: boolean;
  items: RmFactsItemOut[];
  rejected: { id: string; reason: string }[];
  lineNotes: { line: string; accepted: number; dropped: string[] }[];
}

/** 归一化：折叠空白 + 小写（锚点与引文回查的公共口径）。 */
export function normQuote(text: string): string {
  return text.replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * 页文本核验口径：只折叠空白、保留原大小写（引文要能读回原文写法）。
 * 匹配在它的 toLowerCase 副本上做；两者对 ASCII 等长，稀有 Unicode（如 İ）
 * 理论上会让下标偏移，但命中与否用的都是同一份副本，偏移只影响引文截取边界，
 * 不会把「没锚点」判成「有锚点」。
 */
export function normalizedPage(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function findNormalized(hayLower: string, needle: string): number {
  return hayLower.indexOf(normQuote(needle));
}

/**
 * 逐主题核验。pages 只需覆盖 spec 里各 page±3（CLI 从 PDF 抽好喂进来）。
 */
export function extractRmFacts(spec: RmTopicSpec, pages: PdfPageText[], svdByLine: Record<string, SvdStructure>): RmExtractReport {
  const items: RmFactsItemOut[] = [];
  const rejected: { id: string; reason: string }[] = [];
  const lineNotes: { line: string; accepted: number; dropped: string[] }[] = spec.lines.map((l) => ({ line: l, accepted: 0, dropped: [] }));
  for (const topic of spec.topics) {
    if (!Array.isArray(topic.anchors) || topic.anchors.length === 0) {
      rejected.push({ id: topic.id, reason: "规格没给锚点：无语料回查等于没核验" });
      continue;
    }
    const window = pages.filter((p) => Math.abs(p.page - topic.page) <= 3);
    let hitHay = "";
    let hitIdx = -1;
    let anchorIdx = -1;
    for (const p of window) {
      const hay = normalizedPage(p.text);
      const lower = hay.toLowerCase();
      const idx = findNormalized(lower, topic.anchors[0] ?? "");
      if (idx < 0) continue;
      const rest = topic.anchors.slice(1).every((a) => findNormalized(lower, a) >= 0);
      if (!rest) continue;
      hitHay = hay; anchorIdx = idx; hitIdx = p.page;
      break;
    }
    if (hitIdx < 0) {
      rejected.push({ id: topic.id, reason: "锚点在 p" + String(topic.page) + "±3 的逐字回查没过（改版/换族/推断错的结论都会在这里被拒）：" + (topic.anchors[0] ?? "").slice(0, 48) });
      continue;
    }
    const hay = hitHay;
    const lower = hay.toLowerCase();
    let quote: string;
    if (topic.anchorEnd) {
      const endIdx = findNormalized(lower.slice(anchorIdx), topic.anchorEnd);
      if (endIdx < 0) {
        rejected.push({ id: topic.id, reason: "引文终止锚点不在同一页：" + topic.anchorEnd.slice(0, 48) });
        continue;
      }
      quote = hay.slice(anchorIdx, anchorIdx + endIdx + topic.anchorEnd.length);
    } else {
      quote = hay.slice(anchorIdx, anchorIdx + 700);
    }
    // 表格逐行回查：声明的行必须都在这页里逐字出现
    if (topic.rows !== undefined && topic.rows.length > 0) {
      const missRows = topic.rows.filter((row) => findNormalized(lower, row.join(" ")) < 0);
      if (missRows.length > 0) {
        rejected.push({ id: topic.id, reason: "表格有 " + String(missRows.length) + " 行在 p" + String(hitIdx) + " 逐字找不到（首行：" + (missRows[0] ?? []).join(" ").slice(0, 40) + "）" });
        continue;
      }
    }
    // 机检②：逐线 SVD 交叉
    const applies: string[] = [];
    for (const line of spec.lines) {
      const st = svdByLine[line];
      if (st === undefined) { lineNotes.find((x) => x.line === line)?.dropped.push(topic.id + "(该线 SVD 没取到)"); continue; }
      const miss: string[] = [];
      for (const want of topic.svd ?? []) {
        const reg = st[want.reg];
        const f = reg?.fields.find((y) => y.name.toLowerCase() === want.field.toLowerCase());
        if (f === undefined) { miss.push(want.reg + "." + want.field); continue; }
        if (f.bitOffset !== want.bitOffset) { miss.push(want.reg + "." + want.field + " 位不对(" + String(f.bitOffset) + "≠" + String(want.bitOffset) + ")"); continue; }
        for (const v of want.enums ?? []) {
          if (!f.enums.some((e) => e.value.toLowerCase() === v.toLowerCase())) miss.push(want.reg + "." + want.field + " 缺枚举 " + v);
        }
      }
      if (miss.length === 0) applies.push(line);
      else lineNotes.find((x) => x.line === line)?.dropped.push(topic.id + "(" + miss.join("/") + ")");
    }
    if (applies.length === 0 && (topic.svd?.length ?? 0) > 0) {
      rejected.push({ id: topic.id, reason: "没有任何一条线通过 SVD 交叉" });
      continue;
    }
    if (applies.length === 0) applies.push(...spec.lines); // 无 svd 要求的纯文本条目：线适用性只由锚点回查决定
    items.push({
      id: topic.id,
      statement: topic.statement,
      source: { page: hitIdx },
      evidence: { quote, normalized: true },
      appliesTo: applies,
      ...(topic.rows === undefined ? {} : { table: topic.rows.map((row) => row.reduce<Record<string, string>>((acc, cell, i) => { acc["c" + String(i)] = cell; return acc; }, {})) }),
    });
    for (const l of applies) {
      const note = lineNotes.find((x) => x.line === l);
      if (note !== undefined) note.accepted += 1;
    }
  }
  return { ok: rejected.length === 0 && items.length > 0, items, rejected, lineNotes };
}

/** 把核验结果组装成 build-facts 认识的 rm-facts 文档（doc.lines = 全部条目 appliesTo 交集的并集口径见 notes）。 */
export function assembleRmFacts(doc: Record<string, unknown>, items: RmFactsItemOut[]): { doc: Record<string, unknown>; items: Record<string, unknown>[] } {
  const union = [...new Set(items.flatMap((i) => i.appliesTo))];
  const outDoc = { ...doc, lines: union };
  return { doc: outDoc, items: items.map((i) => ({ id: i.id, statement: i.statement, source: i.source, evidence: i.evidence, appliesTo: i.appliesTo, ...(i.table === undefined ? {} : { table: i.table }) })) };
}
