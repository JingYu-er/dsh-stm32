/**
 * L1：USER CODE 保活。
 *
 * CubeMX 只在"同一文件被重写"时保留 USER CODE；CLI 会把新代码写到 Src/Inc，
 * 落到 Core/Src 时需要我们自己把旧文件里 USER CODE 区的内容搬进新内容。
 *
 * 规则（保守优先）：
 * - 按标记标签（BEGIN 3 / END 3 里的 "3"）配对，标签相同才覆盖；
 * - 旧文件有、新文件没有的标签 → 记 droppedLabels，内容不丢（旧文件已备份），交给调用方报告；
 * - 新文件里没有 USER CODE 标记 → 视为不可安全合并，由调用方决定跳过覆盖。
 */

export interface UserCodeRegion {
  label: string;
  /** 标记之间的原文（含行尾换行），不含标记行。 */
  body: string;
}

export interface MergeResult {
  merged: string;
  /** 从旧文件保活过来的标签。 */
  preserved: string[];
  /** 旧文件有内容、新文件也有该标签，但旧内容为空（无需搬运）的标签。 */
  empty: string[];
  /** 旧文件里有、新文件里找不到的标签：内容未被搬运，需要人工确认。 */
  droppedLabels: string[];
}

const MARKER = /^[ \t]*\/\* USER CODE (BEGIN|END) (.+?) \*\/[ \t]*$/u;

/**
 * 按行切分并去掉行尾 CR。
 * CubeMX 生成的工程是 CRLF，残留的 "\r" 会让以 $ 结尾的标记正则匹配失败。
 */
function splitLines(text: string): string[] {
  return text.split(/\r?\n/u);
}

/** 保留文件原有行尾：新内容用 CRLF 就继续用 CRLF，否则 LF。 */
function dominantEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function markerLabel(raw: string): string {
  return raw.trim();
}

/** 按行扫描标记，返回成对区间的正文。未闭合的 BEGIN 忽略（并让调用方看到 label 缺失）。 */
export function parseUserCodeRegions(text: string): UserCodeRegion[] {
  const lines = splitLines(text);
  const regions: UserCodeRegion[] = [];
  let openLabel: string | null = null;
  let openBody: string[] = [];
  for (const line of lines) {
    const match = MARKER.exec(line);
    if (match === null) {
      if (openLabel !== null) openBody.push(line);
      continue;
    }
    const kind = match[1];
    const label = markerLabel(match[2] ?? "");
    if (kind === "BEGIN") {
      openLabel = label;
      openBody = [];
      continue;
    }
    if (openLabel !== null && openLabel === label) {
      regions.push({ label, body: openBody.join("\n") });
      openLabel = null;
      openBody = [];
    } else if (openLabel !== null) {
      // 标签不匹配：放弃这一对，避免把错位的内容搬过去。
      openLabel = null;
      openBody = [];
    }
  }
  return regions;
}

function hasUserCodeMarkers(text: string): boolean {
  return splitLines(text).some((line) => MARKER.test(line));
}

/**
 * 把旧文件的 USER CODE 正文覆盖到新文件上。
 * 新旧文件都没有标记时原样返回（调用方本不该调用它）。
 */
export function mergeUserCode(oldText: string, newText: string): MergeResult {
  const oldRegions = new Map<string, string>();
  for (const region of parseUserCodeRegions(oldText)) oldRegions.set(region.label, region.body);
  const preserved: string[] = [];
  const empty: string[] = [];
  const seen = new Set<string>();
  const out: string[] = [];
  const eol = dominantEol(newText);
  const lines = splitLines(newText);
  let openLabel: string | null = null;
  for (const line of lines) {
    const match = MARKER.exec(line);
    if (match !== null && match[1] === "BEGIN") {
      openLabel = markerLabel(match[2] ?? "");
      out.push(line);
      const body = oldRegions.get(openLabel);
      if (body !== undefined) {
        seen.add(openLabel);
        if (body.trim() === "") {
          empty.push(openLabel);
        } else {
          preserved.push(openLabel);
          // body 内部用 LF 分隔，展开成行后由最终 join 统一回原文件的行尾。
          out.push(...body.split("\n"));
        }
      }
      continue;
    }
    if (match !== null && match[1] === "END" && openLabel !== null) {
      openLabel = null;
      out.push(line);
      continue;
    }
    if (openLabel !== null) {
      // 该标签的正文已被旧内容替换（或旧文件没有该标签，保留新生成的空内容）。
      if (oldRegions.has(openLabel)) continue;
    }
    out.push(line);
  }
  const droppedLabels = [...oldRegions.keys()].filter((label) => !seen.has(label) && !hasMarkerLabel(lines, label));
  return { merged: out.join(eol), preserved, empty, droppedLabels };
}

function hasMarkerLabel(lines: string[], label: string): boolean {
  for (const line of lines) {
    const match = MARKER.exec(line);
    if (match !== null && match[1] === "BEGIN" && markerLabel(match[2] ?? "") === label) return true;
  }
  return false;
}

/** 新内容是否带有 USER CODE 标记（没有则不能安全合并）。 */
export function canMergeUserCode(text: string): boolean {
  return hasUserCodeMarkers(text);
}
