/**
 * 文本文件编码探测与「同编码写回」。
 *
 * 为什么需要：STM32 的 C 源码在国内经常是被 Keil 编辑过的 GB18030/GBK 文件。
 * 以前 code_patch 用 readFileSync(path, "utf8") 读、writeFileSync(path, text, "utf8") 写，
 * 一次补丁就会把用户的中文注释永久变成替换符（审计 B2）。这里把「怎么读、怎么按原编码写回」
 * 收成一处，所有写用户源码的地方都走它。
 *
 * 写回策略：
 * - UTF-8 / UTF-8 BOM：整份按 UTF-8 写回，BOM 原样保留（BOM 在字节层不动，见 replaceLineRange）。
 * - GB18030：Node 只有解码器、没有编码器（TextEncoder 仅支持 UTF-8），所以不做整份重编码，
 *   而是按行做**字节级拼接**：没改到的行原字节照抄，只把新增的行按 ASCII 编码插入。
 *   新增内容含非 ASCII 时直接拒绝（宁可让调用方报错，也不把中文写坏）。
 * - 识别不出来：一律拒绝改写。
 */

import fs from "node:fs";

export type TextEncoding = "utf8" | "utf8-bom" | "gb18030" | "unknown";

export interface EncodedText {
  ok: boolean;
  bytes: Buffer;
  error: string;
}

export interface TextFileRead {
  ok: boolean;
  text: string;
  encoding: TextEncoding;
  /** 行尾：原文件用 CRLF 就是 CRLF，新写入的行跟随它。 */
  eol: string;
  bytes: number;
  error: string;
}

const BOM_UTF8: readonly number[] = [0xef, 0xbb, 0xbf];

function decodesStrictly(buffer: Buffer, label: string): boolean {
  try {
    new TextDecoder(label, { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/** 探测顺序：BOM → 严格 UTF-8 → 严格 GB18030 → 认不出。 */
export function detectEncoding(buffer: Buffer): TextEncoding {
  if (buffer.length >= 3 && buffer[0] === BOM_UTF8[0] && buffer[1] === BOM_UTF8[1] && buffer[2] === BOM_UTF8[2]) {
    return "utf8-bom";
  }
  if (buffer.length === 0) return "utf8";
  if (decodesStrictly(buffer, "utf-8")) return "utf8";
  if (decodesStrictly(buffer, "gb18030")) return "gb18030";
  return "unknown";
}

export function describeEncoding(encoding: TextEncoding): string {
  if (encoding === "utf8") return "UTF-8";
  if (encoding === "utf8-bom") return "UTF-8（带 BOM）";
  if (encoding === "gb18030") return "GB18030/GBK";
  return "认不出";
}

/** 把字节解码成文本；utf8-bom 会去掉 BOM（写回时 BOM 在字节层保留）。 */
export function decodeText(buffer: Buffer, encoding: TextEncoding): string {
  if (encoding === "utf8-bom") return buffer.subarray(3).toString("utf8");
  if (encoding === "utf8") return buffer.toString("utf8");
  if (encoding === "gb18030") {
    try {
      return new TextDecoder("gb18030").decode(buffer);
    } catch {
      return "";
    }
  }
  return "";
}

export function isAscii(text: string): boolean {
  for (const ch of text) {
    if (ch.codePointAt(0) !== undefined && (ch.codePointAt(0) as number) > 0x7f) return false;
  }
  return true;
}

/**
 * 把「要新写进文件的文本」按目标编码编成字节。
 * GB18030 只允许纯 ASCII（Node 没有 GB18030 编码器，非 ASCII 无法无损写出）。
 */
export function encodeText(text: string, encoding: TextEncoding): EncodedText {
  if (encoding === "utf8" || encoding === "utf8-bom") {
    return { ok: true, bytes: Buffer.from(text, "utf8"), error: "" };
  }
  if (encoding === "gb18030") {
    if (!isAscii(text)) {
      return {
        ok: false,
        bytes: Buffer.alloc(0),
        error: "这个文件是 GB18030/GBK 编码，而要写入的内容含非 ASCII 字符：Node 只有 GB18030 解码器、没有编码器，写出去会变成乱码或替换符，所以拒绝写入。请先把文件转成 UTF-8（VS Code 右下角编码 → 通过编码保存 → UTF-8），或把要写入的代码改成英文/纯 ASCII。",
      };
    }
    return { ok: true, bytes: Buffer.from(text, "latin1"), error: "" };
  }
  return {
    ok: false,
    bytes: Buffer.alloc(0),
    error: "这个文件的编码认不出来（既不是 UTF-8 也不是 GB18030），为避免写坏不做改动。",
  };
}

export function readTextFile(absPath: string): TextFileRead {
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(absPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, text: "", encoding: "unknown", eol: "\n", bytes: 0, error: "读不了文件：" + message };
  }
  const encoding = detectEncoding(buffer);
  if (encoding === "unknown") {
    return {
      ok: false,
      text: "",
      encoding,
      eol: "\n",
      bytes: buffer.length,
      error: "这个文件的编码认不出来（既不是 UTF-8 也不是 GB18030），为避免写坏不做改动。",
    };
  }
  const text = decodeText(buffer, encoding);
  return { ok: true, text, encoding, eol: text.includes("\r\n") ? "\r\n" : "\n", bytes: buffer.length, error: "" };
}

/** 每个逻辑行（\n 分隔，与 text.split(/\r?\n/) 的行号一一对应）的起始字节偏移。 */
export function lineStarts(buffer: Buffer): number[] {
  const starts: number[] = [0];
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0x0a) starts.push(index + 1);
  }
  return starts;
}

/**
 * 用「新行」替换 [startLine, endLine) 这些逻辑行，其余字节原样保留。
 *
 * startLine 是块内第一行的行号、endLine 是 END 行的行号时，正好是「替换 USER CODE 块内容」；
 * startLine === endLine 时就是「在那一行之前插入」。
 */
export function replaceLineRange(
  original: Buffer,
  startLine: number,
  endLine: number,
  newLines: readonly string[],
  eol: string,
  encoding: TextEncoding,
): EncodedText {
  const starts = lineStarts(original);
  const prefixEnd = starts[startLine] ?? original.length;
  const suffixStart = starts[endLine] ?? original.length;
  if (suffixStart < prefixEnd) {
    return { ok: false, bytes: Buffer.alloc(0), error: "行范围不合法（endLine 在 startLine 之前）" };
  }
  const head = original.subarray(0, prefixEnd);
  const tail = original.subarray(suffixStart);
  if (newLines.length === 0) {
    return { ok: true, bytes: Buffer.concat([head, tail]), error: "" };
  }
  const body = encodeText(newLines.join(eol), encoding);
  if (!body.ok) return body;
  return { ok: true, bytes: Buffer.concat([head, body.bytes, Buffer.from(eol, "utf8"), tail]), error: "" };
}
