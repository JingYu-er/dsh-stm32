/**
 * pymupdf 页文本桥：给 rm-extract 的引文回查供「与被核验同源」的文本。
 *
 * 为什么单独成模块而且可注入：
 *   · 引文必须来自被核验的那一份文本（docs §76），所以本插件的自研 Node 抽取器
 *     （rm-sources.extractPdfLatinText，压平、无页边界）只用于覆盖判定，不进回查口径；
 *   · dsh 主进程 env 完整时 `python` 一般可用（pymupdf 装在 user site 也能 import）；
 *     run_code 的 execFile 是空 env，user-site 探测会假阴性——候选与失败原因都要能看见。
 *   · 单测注入 bridge，不依赖本机 Python。
 */

import { spawnSync } from "node:child_process";

export interface PdfPagesText {
  page: number;
  text: string;
}

export type PdfTextBridge = (pdfPath: string, pages: number[]) => Promise<{ ok: boolean; pages: PdfPagesText[]; error: string; tried: string[] }>;

const PY_CODE = [
  "import json, sys",
  "import pymupdf",
  "d = pymupdf.open(sys.argv[1])",
  "want = [int(x) for x in sys.argv[2].split(',') if x]",
  "out = [{'page': n, 'text': d[n - 1].get_text()} for n in want if 0 < n <= d.page_count]",
  "print(json.dumps(out))",
].join("\n");

function pythonCandidates(env: NodeJS.ProcessEnv): string[] {
  const custom = (env.DSH_STM32_PYTHON ?? "").trim();
  if (custom !== "") return [custom];
  return ["python", "python3", "py"];
}

/** 默认桥：按候选解释器逐个试（第一个能 import pymupdf 且跑通 JSON 的胜出）。 */
export const defaultPdfTextBridge: PdfTextBridge = async (pdfPath, pages) => {
  const tried: string[] = [];
  const list = [...new Set(pages)].sort((a, b) => a - b);
  if (list.length === 0) return { ok: false, pages: [], error: "没请求任何页", tried };
  for (const py of pythonCandidates(process.env)) {
    const r = spawnSync(py, ["-c", PY_CODE, pdfPath, list.join(",")], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180_000 });
    if (r.error !== undefined && r.error !== null) {
      tried.push(py + " → 起进程失败：" + r.error.message);
      continue;
    }
    if (r.status !== 0) {
      const last = String(r.stderr || "").split("\n").filter(Boolean).pop() || ("退出码 " + String(r.status));
      tried.push(py + " → " + last.slice(0, 160));
      continue;
    }
    try {
      const parsed = JSON.parse(r.stdout) as PdfPagesText[];
      if (!Array.isArray(parsed) || parsed.length === 0) {
        tried.push(py + " → 输出里没有页");
        continue;
      }
      return { ok: true, pages: parsed, error: "", tried };
    } catch (error) {
      tried.push(py + " → JSON 解析失败：" + (error instanceof Error ? error.message : String(error)).slice(0, 120));
    }
  }
  return { ok: false, pages: [], error: "pymupdf 桥全候选都没跑通（给某个解释器装 pymupdf，或用 DSH_STM32_PYTHON 指定）", tried };
};
