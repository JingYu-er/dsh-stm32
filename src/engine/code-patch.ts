/**
 * L2：code_patch —— 只往 USER CODE 块里写代码，绝不碰 CubeMX 生成区。
 *
 * 红线（用户规格 §7）：任何写 C 代码的动作都必须落在
 * `/* USER CODE BEGIN X *\/` 与 `/* USER CODE END X *\/` 之间，否则 CubeMX 下次生成会覆盖掉。
 * 这个模块负责把它变成**机械保证**：
 * - 目标块必须存在（找不到就报可用标签，让模型自己改，不猜）；
 * - 替换会先备份原文件到 .dsh-stm32/backups/<stamp>-patch/，再原子写（临时文件 + rename）；
 * - 只改目标块内的行，块外的字节原样保留（含 CRLF / 缩进 / 其它 USER CODE 区）。
 */

import fs from "node:fs";
import path from "node:path";

import { STATE_DIR } from "./generate.js";

const MARKER = /^[ \t]*\/\* USER CODE (BEGIN|END) (.+?) \*\/[ \t]*$/u;

export interface CodePatchRequest {
  projectDir: string;
  /** 相对 projectDir 的源文件路径，例如 Core/Src/main.c。 */
  file: string;
  /** USER CODE 标签，例如 "3"、"WHILE"、"Init"。 */
  block: string;
  code: string;
  /** replace（默认，替换块内全部内容）或 append（追加到块尾）。 */
  mode?: "replace" | "append";
}

export interface CodePatchReport {
  ok: boolean;
  file: string;
  block: string;
  mode: string;
  labels: string[];
  linesBefore: number;
  linesAfter: number;
  backupPath?: string;
  errors: string[];
  message: string;
}

interface BlockRange {
  begin: number;
  end: number;
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/u);
}

/** 找出某个标签的 BEGIN/END 行号（0 基）。 */
function findBlock(lines: string[], label: string): BlockRange | null {
  let begin = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const match = MARKER.exec(lines[i] ?? "");
    if (match === null) continue;
    const text = (match[2] ?? "").trim();
    if (text !== label) continue;
    if (match[1] === "BEGIN") {
      begin = i;
      continue;
    }
    if (begin >= 0) return { begin, end: i };
  }
  return null;
}

export function listUserCodeLabels(text: string): string[] {
  const labels: string[] = [];
  for (const line of splitLines(text)) {
    const match = MARKER.exec(line);
    if (match !== null && match[1] === "BEGIN") labels.push((match[2] ?? "").trim());
  }
  return labels;
}

/** 只有括号（可带行尾 // 注释）的行——典型的收尾结构行，例如 while(1) 的 `}`。 */
function isBraceOnly(line: string): boolean {
  const codeOnly = (line.split("//")[0] ?? "").trim();
  return codeOnly !== "" && /^[{}]+$/u.test(codeOnly);
}

/** append 的落点：跳过块尾连续的收尾括号行，插在它们之前。 */
function appendPosition(previousBody: string[]): number {
  let index = previousBody.length;
  while (index > 0 && isBraceOnly(previousBody[index - 1] ?? "")) index -= 1;
  return index;
}

/** 生成备份目录名：时间戳 + 来源文件（可读、可排序、不会撞）。 */
function backupStamp(fileRel: string): string {
  const iso = new Date().toISOString().replace(/[:.]/gu, "-");
  return iso + "-" + path.basename(fileRel, path.extname(fileRel));
}

export function patchUserCode(request: CodePatchRequest): CodePatchReport {
  const projectDir = path.resolve(request.projectDir);
  const fileRel = request.file.replace(/\\/gu, "/");
  const mode = request.mode ?? "replace";
  const fail = (message: string, extra: Partial<CodePatchReport> = {}): CodePatchReport => ({
    ok: false,
    file: fileRel,
    block: request.block,
    mode,
    labels: [],
    linesBefore: 0,
    linesAfter: 0,
    errors: [message],
    message,
    ...extra,
  });

  if (request.block === "" || request.code === undefined) return fail("block 与 code 都必填");
  if (request.code.includes("USER CODE BEGIN") || request.code.includes("USER CODE END")) {
    return fail("要写入的代码里包含 USER CODE 标记：那会破坏块配对，拒绝写入。");
  }
  if (fileRel.startsWith("/") || fileRel.includes("..")) return fail("file 必须是工程内的相对路径：" + fileRel);

  const absPath = path.join(projectDir, fileRel);
  if (!fs.existsSync(absPath)) return fail("文件不存在：" + absPath);
  if (!fs.statSync(absPath).isFile()) return fail("不是文件：" + absPath);

  const original = fs.readFileSync(absPath, "utf8");
  const lines = splitLines(original);
  const labels = listUserCodeLabels(original);
  const range = findBlock(lines, request.block);
  if (range === null) {
    return fail(
      "文件里没有名为 \"" + request.block + "\" 的 USER CODE 块。可用的标签：" +
        (labels.length === 0 ? "（这个文件没有任何 USER CODE 块）" : labels.join("、")) +
        "。CubeMX 生成区的代码不能直接写，换一个存在的块。",
      { labels },
    );
  }

  // 行尾必须跟随原文件：CubeMX 生成的是 CRLF，混入 LF 会让 git diff 整文件飘红。
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const body = splitLines(request.code.replace(/\r?\n$/u, ""));
  const before = lines.slice(0, range.begin + 1);
  const after = lines.slice(range.end);
  const previousBody = lines.slice(range.begin + 1, range.end);

  // replace 会删掉块内原有的行。CubeMX 的 `USER CODE BEGIN 3` / `END 3` 之间夹着 while(1) 的收尾 `}`，
  // 删掉它 = 把整个 main() 变成没闭合的函数（实测 build 报 invalid storage class for function 'MX_GPIO_Init'）。
  // 所以：replace 只允许"删掉空白或纯代码行"，碰到块内原有的结构行（含 { 或 }）就拒绝，让人改用 append。
  if (mode === "replace") {
    const structural = previousBody.filter((line) => {
      const codeOnly = line.split("//")[0] ?? "";
      return codeOnly.includes("{") || codeOnly.includes("}");
    });
    if (structural.length > 0) {
      return fail(
        "块 \"" + request.block + "\" 的原有内容里有 " + String(structural.length) + " 行结构代码（含 { 或 }）：" +
          "replace 会把它们删掉，块结构随即坏掉（例如 USER CODE 3 之间夹着 while(1) 的收尾括号）。" +
          "改用 mode=\"append\" 追加，或把这些行一并写进 code。块内的结构行：" +
          structural.map((line) => line.trim()).join(" / ").slice(0, 200),
        { labels },
      );
    }
  }
  // append 插在块尾——但块尾若是收尾括号（CubeMX 的 USER CODE 3 里就夹着 while(1) 的 `}`），
  // 直接追加会把代码放到循环外（实测：代码在 main 的 } 之后 → 不可达 → 链接时整个计数器被 gc-sections 丢掉）。
  // 所以 append 的位置退到"最后一个纯粹的收尾括号之前"。
  const tailStart = mode === "append" ? appendPosition(previousBody) : 0;
  const nextBody =
    mode === "append"
      ? [...previousBody.slice(0, tailStart), ...body, ...previousBody.slice(tailStart)]
      : body;
  const rebuilt = [...before, ...nextBody, ...after].join(eol);
  if (rebuilt === original) {
    return {
      ok: true, file: fileRel, block: request.block, mode, labels,
      linesBefore: previousBody.length, linesAfter: nextBody.length, errors: [],
      message: "内容没有变化（块 \"" + request.block + "\" 已是目标内容）",
    };
  }

  // 备份 + 原子写
  const backupDir = path.join(projectDir, STATE_DIR, "backups", backupStamp(fileRel) + "-patch");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, path.basename(fileRel));
  fs.copyFileSync(absPath, backupPath);
  const tmpPath = absPath + ".dsh-stm32-tmp";
  fs.writeFileSync(tmpPath, rebuilt);
  fs.renameSync(tmpPath, absPath);

  return {
    ok: true,
    file: fileRel,
    block: request.block,
    mode,
    labels,
    linesBefore: previousBody.length,
    linesAfter: nextBody.length,
    backupPath,
    errors: [],
    message:
      "已写入 " + fileRel + " 的 USER CODE " + request.block + "（" + mode + "，" +
      String(previousBody.length) + " → " + String(nextBody.length) + " 行）。备份：" + backupPath,
  };
}
