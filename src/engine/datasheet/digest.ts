/**
 * 手册的关键页索引（S121）。
 *
 * 一份手册几十上百页，真正要看的往往就四五处：引脚、绝对最大额定值、电气特性、时序、封装。
 * 这里只做一件事：把「哪一类信息在第几页」记下来，读的时候直接翻过去，而不是每次全文搜索。
 *
 * 索引是索引：只存页号与命中行，正文仍按需从 PDF 现取——避免把上千页文本塞进缓存。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { extractPdfText } from "../pdf/reader.js";
import type { PopplerTools } from "../pdf/toolchain.js";
import type { SubprocessService } from "../../types.js";

export type DigestKind = "pinout" | "absolute-maximum" | "electrical" | "timing" | "package";

export interface DigestSection {
  kind: DigestKind;
  page: number;
  heading: string;
}

export interface DatasheetDigest {
  pages: number;
  textLayer: boolean;
  scanned: number;
  sections: DigestSection[];
  builtAt: string;
}

const PATTERNS: { kind: DigestKind; pattern: RegExp }[] = [
  { kind: "pinout", pattern: /^(?:\d+(?:\.\d+)*\s+)?(?:pin ?out|pin configuration|pin description|pin assignments?|pin functions?)\b/iu },
  { kind: "absolute-maximum", pattern: /^(?:\d+(?:\.\d+)*\s+)?absolute maximum (?:ratings?|values?)\b/iu },
  { kind: "electrical", pattern: /^(?:\d+(?:\.\d+)*\s+)?(?:electrical characteristics|recommended operating conditions|dc characteristics)\b/iu },
  { kind: "timing", pattern: /^(?:\d+(?:\.\d+)*\s+)?(?:ac (?:electrical )?characteristics|timing (?:characteristics|diagrams?|specifications?)|switching characteristics)\b/iu },
  { kind: "package", pattern: /^(?:\d+(?:\.\d+)*\s+)?(?:package (?:outline|mechanical)|mechanical data|ordering information)\b/iu },
];

export function detectSections(pages: { page: number; text: string }[]): DigestSection[] {
  const found = new Map<DigestKind, DigestSection>();
  for (const page of pages) {
    for (const line of page.text.split(/\r?\n/u)) {
      const text = line.trim().replace(/\s{2,}/gu, " ");
      if (text.length < 4 || text.length > 90) continue;
      for (const rule of PATTERNS) {
        if (found.has(rule.kind)) continue;
        if (!rule.pattern.test(text)) continue;
        found.set(rule.kind, { kind: rule.kind, page: page.page, heading: text });
      }
    }
  }
  return [...found.values()].sort((left, right) => left.page - right.page);
}

export interface BuildDigestOptions {
  maxPages?: number;
  signal?: AbortSignal;
}

/** 读前 N 页（默认 40）做索引；文字层缺失时只记扫描页数，不假装读到了内容。 */
export async function buildDigest(
  subprocess: SubprocessService,
  tools: PopplerTools,
  pdfFile: string,
  options: BuildDigestOptions = {},
): Promise<{ ok: boolean; error?: string; digest?: DatasheetDigest }> {
  if (!existsSync(pdfFile)) return { ok: false, error: "PDF 不存在：" + pdfFile };
  const scanned = Math.max(1, options.maxPages ?? 40);
  const text = await extractPdfText(subprocess, tools, pdfFile, { first: 1, last: scanned }, options.signal);
  if (!text.ok) return { ok: false, error: text.error };
  const readable = text.pages.filter((page) => page.text.length > 20);
  const sections = detectSections(readable);
  return {
    ok: true,
    digest: {
      pages: scanned,
      textLayer: readable.length > 0,
      scanned,
      sections,
      builtAt: new Date().toISOString(),
    },
  };
}

export function digestFile(dir: string): string {
  return join(dir, "digest.json");
}

export function readDigest(dir: string): DatasheetDigest | null {
  const file = digestFile(dir);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as DatasheetDigest;
  } catch {
    return null;
  }
}

export function writeDigest(dir: string, digest: DatasheetDigest): void {
  writeFileSync(digestFile(dir), JSON.stringify(digest, null, 2) + "\n", "utf8");
}
