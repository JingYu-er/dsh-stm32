/**
 * PDF 读取工具（S117）。
 *
 * 一个工具四种用法，覆盖读数据手册与原理图 PDF 的全部动作：
 *   info    —— 页数、纸张、有没有文字层（决定后面走文字还是走图）；
 *   text    —— 指定页范围的文字（-layout 保版面，表格能读）；
 *   figures —— 从图注/目录行里列图与表，知道「第几页有什么图」；
 *   render  —— 页面或局部渲染成 PNG，返回文件路径供视觉读图（曲线、框图、丝印）。
 *
 * 为什么不一个动作做完：整本 1000 页转文本会烧掉上下文，渲染整页也不总是需要的。
 * 先 info 判断，再按需取页，是本工具的使用姿势。
 */

import { extname, isAbsolute, resolve } from "node:path";

import type { DshContext, JsonSchema, ToolExec } from "../types.js";
import { resolveSearchConfig } from "../data/search-roots.js";
import { extractPdfText, listFigures, readPdfInfo, renderPdfPage } from "../engine/pdf/reader.js";
import { locatePoppler } from "../engine/pdf/toolchain.js";

export const PDF_READ_TOOL = "stm32_pdf_read";

const MODES = ["info", "text", "figures", "render"] as const;

const noteSchema: JsonSchema = {
  type: "array",
  items: { type: "string" },
  description: "本次调用的补充说明：为什么给了这个结果、下一步该做什么。",
};

const outputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    error: { type: "string" },
    mode: { type: "string", enum: [...MODES] },
    file: { type: "string" },
    info: {
      type: "object",
      additionalProperties: false,
      properties: {
        pages: { type: "number" },
        title: { type: "string" },
        producer: { type: "string" },
        pageSize: { type: "string" },
        encrypted: { type: "boolean" },
        hasTextLayer: { type: "boolean" },
      },
      required: ["pages", "title", "producer", "pageSize", "encrypted", "hasTextLayer"],
    },
    pages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          page: { type: "number" },
          text: { type: "string" },
        },
        required: ["page", "text"],
      },
    },
    figures: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          number: { type: "string" },
          title: { type: "string" },
          page: { type: "number" },
        },
        required: ["number", "title", "page"],
      },
    },
    imageFile: { type: "string" },
    imageWidth: { type: "number" },
    imageHeight: { type: "number" },
    dpi: { type: "number" },
    notes: noteSchema,
  },
  required: ["ok", "error", "mode", "file", "notes"],
};

function popplerDirs(): string[] {
  const config = resolveSearchConfig(process.env);
  const extra = (process.env["DSH_STM32_BIN_DIRS"] ?? "")
    .split(";")
    .map((dir) => dir.trim())
    .filter((dir) => dir !== "");
  return [...new Set([...extra, ...config.binDirs])];
}

function absoluteFile(raw: string): string {
  return isAbsolute(raw) ? raw : resolve(raw);
}

export function registerPdfTools(ctx: DshContext): void {
  ctx.tools.register({
    name: PDF_READ_TOOL,
    description:
      "读 PDF：数据手册与原理图都适用。mode=info 看页数与有无文字层；text 取指定页文字（-layout 保版面，表格可读）；figures 列图与表；render 把页面或局部渲染成 PNG 并返回路径，供视觉读曲线与框图。",
    parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: { type: "string", description: "PDF 路径；相对工程根或当前目录。" },
          mode: { type: "string", enum: [...MODES], description: "info（默认）/ text / figures / render。" },
          first: { type: "number", description: "text 与 figures 的起始页（默认 1）。" },
          last: { type: "number", description: "text 与 figures 的结束页（默认同 first；text 最多 20 页）。" },
          page: { type: "number", description: "render 的页码（从 1 开始）。" },
          dpi: { type: "number", description: "render 的分辨率 72–600，默认 150；抠字用 400。" },
          crop: {
            type: "object",
            additionalProperties: false,
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              width: { type: "number" },
              height: { type: "number" },
            },
            required: ["x", "y", "width", "height"],
            description: "render 的裁切区域：按该 dpi 渲染后的像素坐标，用于放大某一张图。",
          },
        },
      required: ["file"],
    },
    output: {
      schema: outputSchema,
      render: (_args, value) => {
        const result = value as {
          ok: boolean;
          error: string;
          mode: string;
          file: string;
          info?: { pages: number; hasTextLayer: boolean; pageSize: string };
          pages?: { page: number; text: string }[];
          figures?: { number: string; title: string; page: number }[];
          imageFile?: string;
          imageWidth?: number;
          imageHeight?: number;
          dpi?: number;
          notes: string[];
        };
        if (!result.ok) return [{ type: "text", text: "读取失败：" + result.error }];
        const lines: string[] = [];
        if (result.mode === "info" && result.info !== undefined) {
          lines.push(
            "PDF：" + result.file,
            "页数 " + String(result.info.pages) + " · " + result.info.pageSize + " · 文字层 " + (result.info.hasTextLayer ? "有" : "无"),
          );
        }
        if (result.mode === "text" && result.pages !== undefined) {
          for (const page of result.pages) {
            lines.push("", "=== 第 " + String(page.page) + " 页 ===", page.text);
          }
        }
        if (result.mode === "figures" && result.figures !== undefined) {
          lines.push("图与表 " + String(result.figures.length) + " 条：");
          for (const figure of result.figures) {
            lines.push("  Figure " + figure.number + " · " + figure.title + (figure.page > 0 ? "（第 " + String(figure.page) + " 页）" : ""));
          }
        }
        if (result.mode === "render" && result.imageFile !== undefined) {
          lines.push(
            "第 " + String(result.dpi ?? 0) + " dpi · " + String(result.imageWidth ?? 0) + "×" + String(result.imageHeight ?? 0),
            "图像：" + result.imageFile,
          );
        }
        for (const note of result.notes) lines.push("· " + note);
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    timeoutMs: 180_000,
    isConcurrencySafe: () => false,
    execute: async (
      args: { file: string; mode?: string; first?: number; last?: number; page?: number; dpi?: number; crop?: { x: number; y: number; width: number; height: number } },
      exec: ToolExec,
    ) => {
      const mode = args.mode ?? "info";
      const file = absoluteFile(args.file);
      const located = locatePoppler(popplerDirs());
      const base = { ok: false, error: "", mode, file, notes: [] as string[] };
      if (located.tools === null) return { ...base, error: located.error };
      if (mode === "info") {
        const info = await readPdfInfo(ctx.subprocess, located.tools, file, exec.signal);
        if (!info.ok) return { ...base, error: info.error };
        return {
          ...base,
          ok: true,
          info: {
            pages: info.pages,
            title: info.title,
            producer: info.producer,
            pageSize: info.pageSize,
            encrypted: info.encrypted,
            hasTextLayer: info.hasTextLayer,
          },
          notes: [
            ...info.notes,
            info.hasTextLayer ? "文字层可用：先用 text 取参数页，再按需 render 看图。" : "文字层不可用：直接 render 去看图。",
          ],
        };
      }
      if (mode === "text") {
        const first = Math.max(1, Math.floor(args.first ?? 1));
        const last = Math.min(first + 19, Math.max(first, Math.floor(args.last ?? first)));
        const text = await extractPdfText(ctx.subprocess, located.tools, file, { first, last }, exec.signal);
        if (!text.ok) return { ...base, error: text.error };
        return { ...base, ok: true, pages: text.pages, notes: text.notes };
      }
      if (mode === "figures") {
        const first = Math.max(1, Math.floor(args.first ?? 1));
        const last = Math.max(first, Math.floor(args.last ?? Math.min(first + 29, 40)));
        const whole = await extractPdfText(ctx.subprocess, located.tools, file, { first, last }, exec.signal);
        if (!whole.ok) return { ...base, error: whole.error };
        const joined = whole.pages.map((page) => page.text).join("\n");
        const figures = listFigures(joined, 60);
        return {
          ...base,
          ok: true,
          figures,
          notes: [
            "第 " + String(first) + "–" + String(last) + " 页里找到 " + String(figures.length) + " 条图注；目录页会给出页号，正文图注只有标题。",
            figures.length === 0 ? "这一段没有图注行：换个页范围，或直接 render 该页看。" : "用 render 打开带页号的那一页，即可读图。",
          ],
        };
      }
      const page = Math.max(1, Math.floor(args.page ?? 1));
      const render = await renderPdfPage(
        ctx.subprocess,
        located.tools,
        file,
        { page, dpi: args.dpi ?? 150, ...(args.crop === undefined ? {} : { crop: args.crop }) },
        exec.signal,
      );
      if (!render.ok) return { ...base, error: render.error };
      return {
        ...base,
        ok: true,
        imageFile: render.imageFile,
        imageWidth: render.width,
        imageHeight: render.height,
        dpi: render.dpi,
        notes: [
          ...render.notes,
          "图像已落盘：" + extname(render.imageFile) + " 用 read_image 打开即可读图。",
          "要抠数字就把 crop 收紧、dpi 提到 300–400；整页概览用 150–200。",
        ],
      };
    },
  });
}
