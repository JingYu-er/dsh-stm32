/**
 * 立创 / EasyEDA 封装转 KiCad（S178）。
 *
 * 数据来源：`https://easyeda.com/api/products/<编号>/components` 的 `result.packageDetail.dataStr`，
 * 里面是 EasyEDA 的图形命令（PAD/TRACK/CIRCLE/ARC/SOLIDREGION），坐标单位 10 mil（0.254 mm），
 * 原点在画布中心 `head.x` / `head.y`。
 *
 * 坐标换算是「两个轴都取反」：与 KiCad 官方 SOT-223 对照过——EasyEDA 的 1 脚在右下、
 * 官方在左上，pad1 y 符号也相反，所以 kx = -(x-cx)*u、ky = -(y-cy)*u。
 *
 * 只做封装（不猜器件功能）：SMD 焊盘、通孔焊盘、丝印线/圆/弧、courtyard 轮廓；
 * 3D 模型（STEP）本轮不下载，只在 notes 里给出模型名，避免把没验证过的模型挂到封装上。
 */

import { createHash } from "node:crypto";

export const EASYEDA_UNIT_MM = 0.254;
export const EASYEDA_PRODUCT_URL = (code: string): string =>
  "https://easyeda.com/api/products/" + code + "/components?version=6.4.19.5";

export interface EasyedaPoint {
  readonly x: number;
  readonly y: number;
}

export interface EasyedaPad {
  readonly number: string;
  readonly shape: "rect" | "roundrect" | "oval" | "circle" | "polygon";
  readonly layer: string;
  readonly rotation: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly holeRadius: number;
  readonly holeLength: number;
  readonly plated: boolean;
  readonly points: readonly EasyedaPoint[];
}

export interface EasyedaGraphic {
  readonly kind: "line" | "circle" | "arc" | "region";
  readonly layer: string;
  readonly width: number;
  readonly points: readonly EasyedaPoint[];
  readonly radius: number;
  readonly cutout: boolean;
}

export interface EasyedaPackage {
  readonly ok: boolean;
  readonly error: string;
  readonly code: string;
  readonly mpn: string;
  readonly packageName: string;
  readonly model3d: string;
  readonly pads: readonly EasyedaPad[];
  readonly graphics: readonly EasyedaGraphic[];
  readonly notes: readonly string[];
}

const EMPTY: EasyedaPackage = {
  ok: false,
  error: "",
  code: "",
  mpn: "",
  packageName: "",
  model3d: "",
  pads: [],
  graphics: [],
  notes: [],
};

/** EasyEDA 层号 → KiCad 层。99 = 元件外形（courtyard），100/101 是装饰，不导入。 */
const LAYERS: Record<string, string> = {
  "1": "F.Cu",
  "2": "B.Cu",
  "3": "F.SilkS",
  "4": "B.SilkS",
  "5": "F.Paste",
  "6": "B.Paste",
  "7": "F.Mask",
  "8": "B.Mask",
  "10": "Edge.Cuts",
  "12": "Cmts.User",
  "13": "F.Fab",
  "14": "B.Fab",
  "15": "Dwgs.User",
  "99": "F.CrtYd",
};

function layerOf(id: string): string {
  return LAYERS[id.trim()] ?? "";
}

/** 按逗号切图形命令：SVGNODE 的 JSON 里有逗号，必须按括号/引号深度切。 */
export function splitEasyedaShape(shape: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let escaped = false;
  let current = "";
  for (const ch of shape) {
    if (escaped) {
      escaped = false;
      current += ch;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      current += ch;
      continue;
    }
    // 只按花括号/方括号算深度：SVGNODE 的 JSON 里逗号很多，引号里的 `{` 不该影响切分。
    if (ch === "{" || ch === "[") depth += 1;
    if (ch === "}" || ch === "]") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") out.push(current);
  return out.map((item) => item.trim()).filter((item) => item !== "");
}

function pointsOf(raw: string): EasyedaPoint[] {
  const numbers = raw
    .trim()
    .split(/\s+/u)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
  const out: EasyedaPoint[] = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    out.push({ x: numbers[index]!, y: numbers[index + 1]! });
  }
  return out;
}

function padShapeOf(raw: string): EasyedaPad["shape"] {
  const shape = raw.trim().toUpperCase();
  if (shape === "RECT") return "rect";
  if (shape === "ROUNDED_RECTANGLE") return "roundrect";
  if (shape === "OVAL" || shape === "ELLIPSE") return "oval";
  if (shape === "POLYGON") return "polygon";
  return "rect";
}

/** 把一串 EasyEDA 命令解析成封装模型（坐标仍是 EE 单位，换算在渲染时做）。 */
export function parseEasyedaPackage(payload: unknown): EasyedaPackage {
  const root = payload as { result?: { title?: unknown; packageDetail?: { dataStr?: unknown } } } | null;
  const result = root?.result ?? null;
  const dataStr = result?.packageDetail?.dataStr ?? null;
  if (dataStr === null || typeof dataStr !== "object") {
    return { ...EMPTY, error: "这个页面没有封装数据（packageDetail.dataStr 为空）：换成有封装的下单编号试试" };
  }
  const doc = dataStr as { head?: { x?: unknown; y?: unknown; c_para?: Record<string, unknown> }; shape?: unknown };
  const head = doc.head ?? {};
  const para = (head.c_para ?? {}) as Record<string, unknown>;
  const pads: EasyedaPad[] = [];
  const graphics: EasyedaGraphic[] = [];
  const notes: string[] = [];
  let regions = 0;
  let skipped = 0;

  const rawShape = doc.shape as unknown;
  const commands = Array.isArray(rawShape)
    ? rawShape.filter((item): item is string => typeof item === "string")
    : splitEasyedaShape(typeof rawShape === "string" ? rawShape : "");
  for (const command of commands) {
    const fields = command.split("~");
    const kind = fields[0] ?? "";
    if (kind === "PAD") {
      const layerId = fields[6] ?? "";
      const layer = layerId === "11" ? "*.Cu" : layerOf(layerId);
      if (layer === "") {
        skipped += 1;
        continue;
      }
      const pad: EasyedaPad = {
        number: (fields[8] ?? "").trim(),
        shape: padShapeOf(fields[1] ?? ""),
        layer,
        rotation: Number(fields[11] ?? 0) || 0,
        x: Number(fields[2] ?? 0) || 0,
        y: Number(fields[3] ?? 0) || 0,
        width: Number(fields[4] ?? 0) || 0,
        height: Number(fields[5] ?? 0) || 0,
        holeRadius: Number(fields[9] ?? 0) || 0,
        holeLength: Number(fields[13] ?? 0) || 0,
        plated: (fields[15] ?? "Y").trim() !== "N",
        points: pointsOf(fields[10] ?? ""),
      };
      if (pad.width <= 0 || pad.height <= 0) {
        skipped += 1;
        continue;
      }
      pads.push(pad);
      continue;
    }
    if (kind === "TRACK" || kind === "ARC" || kind === "CIRCLE") {
      const layer = layerOf(fields[kind === "TRACK" ? 2 : kind === "ARC" ? 2 : 5] ?? "");
      if (layer === "" || layer === "F.Cu" || layer === "B.Cu") continue;
      const width = Number(fields[1] ?? 0) || 0;
      if (kind === "TRACK") {
        graphics.push({ kind: "line", layer, width, points: pointsOf(fields[4] ?? ""), radius: 0, cutout: false });
      } else if (kind === "CIRCLE") {
        graphics.push({
          kind: "circle",
          layer,
          width,
          points: [{ x: Number(fields[1] ?? 0) || 0, y: Number(fields[2] ?? 0) || 0 }],
          radius: Number(fields[3] ?? 0) || 0,
          cutout: false,
        });
      } else {
        graphics.push({ kind: "arc", layer, width, points: [], radius: 0, cutout: false });
        // ARC 的 path 存在第 4 段（SVG `M x y A rx ry rot large sweep x y`），渲染时再算。
        const path = fields[4] ?? "";
        if (path !== "") (graphics[graphics.length - 1] as { path?: string }).path = path;
      }
      continue;
    }
    if (kind === "SOLIDREGION") {
      const layer = layerOf(fields[1] ?? "");
      const regionType = (fields[4] ?? "").trim();
      if (layer === "" || layer === "F.Cu" || layer === "B.Cu") {
        skipped += 1;
        continue;
      }
      // 只取 `M x y L … Z` 的轮廓；courtyard（99）与装配层（13/14）画成不填充的线。
      const path = fields[3] ?? "";
      const numbers = path
        .replace(/[MLZmlz]/gu, " ")
        .trim()
        .split(/\s+/u)
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item));
      const points: EasyedaPoint[] = [];
      for (let index = 0; index + 1 < numbers.length; index += 2) {
        points.push({ x: numbers[index]!, y: numbers[index + 1]! });
      }
      if (points.length < 3) {
        skipped += 1;
        continue;
      }
      regions += 1;
      graphics.push({ kind: "region", layer, width: 0, points, radius: 0, cutout: regionType === "cutout" });
      continue;
    }
  }

  if (skipped > 0) notes.push("有 " + String(skipped) + " 条图形命令没转换（层或形状不支持）");
  if (regions > 0) notes.push("封装外形（courtyard）用了 " + String(regions) + " 条区域轮廓");
  if (typeof para["3DModel"] === "string" && para["3DModel"] !== "") {
    notes.push("这个编号有 3D 模型（" + String(para["3DModel"]) + "）：本轮只出封装，模型没挂上");
  }
  if (pads.length === 0) {
    return { ...EMPTY, error: "这个封装里没有可用焊盘：可能只有 3D 外形，换一个带封装的编号" };
  }
  return {
    ok: true,
    error: "",
    code: typeof para["link"] === "string" ? "" : "",
    mpn: typeof result?.title === "string" ? result.title : "",
    packageName: typeof para["package"] === "string" ? para["package"] : "",
    model3d: typeof para["3DModel"] === "string" ? para["3DModel"] : "",
    pads,
    graphics,
    notes,
  };
}

function fmt(value: number): string {
  return String(Math.round(value * 1e4) / 1e4);
}

function sanitizeName(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[^\w+.-]/gu, "_").replace(/_+/gu, "_");
  return cleaned === "" ? fallback : cleaned;
}

/** 图形命令里的弧：`M x1 y1 A rx ry rot large sweep x2 y2`，三点定圆后转 fp_arc。 */
function arcPointsOf(path: string): { start: EasyedaPoint; mid: EasyedaPoint; end: EasyedaPoint } | null {
  const match = /M\s*(-?[\d.]+)\s+(-?[\d.]+)\s*A\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(\d)\s*(\d)\s*(-?[\d.]+)\s+(-?[\d.]+)/u.exec(path);
  if (match === null) return null;
  const x1 = Number(match[1]);
  const y1 = Number(match[2]);
  const rx = Number(match[3]);
  const large = match[6] === "1";
  const sweep = match[7] === "1";
  const x2 = Number(match[8]);
  const y2 = Number(match[9]);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const chord = Math.hypot(dx, dy);
  if (!Number.isFinite(rx) || rx <= 0 || chord === 0) return null;
  // 弦中点 + 垂线方向；两段弧取 large/sweep 决定的一侧。
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const half = chord / 2;
  const h = Math.sqrt(Math.max(0, rx * rx - half * half));
  let nx = -dy / chord;
  let ny = dx / chord;
  const sameSide = large === sweep;
  if (sameSide) {
    nx = -nx;
    ny = -ny;
  }
  const cx = mx + nx * h;
  const cy = my + ny * h;
  const a1 = Math.atan2(y1 - cy, x1 - cx);
  let a2 = Math.atan2(y2 - cy, x2 - cx);
  let delta = a2 - a1;
  if (sweep && delta < 0) delta += Math.PI * 2;
  if (!sweep && delta > 0) delta -= Math.PI * 2;
  const am = a1 + delta / 2;
  return {
    start: { x: x1, y: y1 },
    mid: { x: cx + rx * Math.cos(am), y: cy + rx * Math.sin(am) },
    end: { x: x2, y: y2 },
  };
}

export interface EasyedaKicadOptions {
  readonly name?: string;
  readonly libraryName?: string;
  readonly now?: () => number;
}

/**
 * 把封装模型渲染成 KiCad `.kicad_mod` 文本。
 *
 * 两个轴都取反（与官方 SOT-223 对照过），单位 0.254 mm/EE unit，原点取画布中心。
 */
export function easyedaToKicadMod(
  pkg: EasyedaPackage,
  center: EasyedaPoint,
  options: EasyedaKicadOptions = {},
): { ok: boolean; error: string; name: string; text: string; pads: number } {
  const rawName = options.name ?? (pkg.packageName !== "" ? pkg.packageName : "easyeda_part");
  const name = sanitizeName(rawName, "easyeda_part");
  const u = EASYEDA_UNIT_MM;
  const map = (point: EasyedaPoint): EasyedaPoint => ({
    x: -(point.x - center.x) * u,
    y: -(point.y - center.y) * u,
  });
  const lines: string[] = [];
  lines.push("(footprint \"" + name + "\"");
  lines.push("  (version 20241229)");
  lines.push("  (generator \"dsh-stm32\")");
  lines.push("  (layer \"F.Cu\")");
  if (pkg.mpn !== "") lines.push("  (descr \"" + pkg.mpn.replace(/"/gu, "'") + "\")");
  lines.push("  (attr smd)");
  const reference = map({ x: center.x, y: center.y - 100 / u });
  lines.push("  (property \"Reference\" \"REF**\"");
  lines.push("    (at " + fmt(reference.x) + " " + fmt(reference.y) + " 0)");
  lines.push("    (layer \"F.SilkS\")");
  lines.push("    (effects (font (size 1 1) (thickness 0.15)))");
  lines.push("  )");
  lines.push("  (property \"Value\" \"" + name + "\"");
  lines.push("    (at 0 " + fmt(1.5) + " 0)");
  lines.push("    (layer \"F.Fab\")");
  lines.push("    (effects (font (size 1 1) (thickness 0.15)))");
  lines.push("  )");

  let padCount = 0;
  for (const pad of pkg.pads) {
    const at = map(pad);
    const width = pad.width * u;
    const height = pad.height * u;
    const drillDiameter = pad.holeRadius > 0 ? pad.holeRadius * 2 * u : 0;
    const through = pad.layer === "*.Cu" || drillDiameter > 0;
    const shape = pad.shape === "roundrect" ? "roundrect" : pad.shape === "oval" ? "oval" : pad.shape === "circle" ? "circle" : "rect";
    const number = pad.number === "" ? String(padCount + 1) : pad.number;
    lines.push("  (pad \"" + number + "\" " + (through ? "thru_hole" : "smd") + " " + shape);
    lines.push("    (at " + fmt(at.x) + " " + fmt(at.y) + " " + fmt(pad.rotation) + ")");
    if (shape === "circle") {
      lines.push("    (size " + fmt(width) + " " + fmt(width) + ")");
    } else {
      lines.push("    (size " + fmt(width) + " " + fmt(height) + ")");
    }
    if (shape === "roundrect") lines.push("    (roundrect_rratio 0.25)");
    if (through) {
      lines.push("    (drill " + fmt(drillDiameter) + ")");
      lines.push("    (layers \"*.Cu\" \"*.Mask\")");
    } else {
      lines.push("    (layers \"F.Cu\" \"F.Paste\" \"F.Mask\")");
    }
    lines.push("  )");
    padCount += 1;
  }

  const strokeOf = (width: number): string =>
    width <= 0 ? "0" : fmt(width * u);
  for (const graphic of pkg.graphics) {
    const layer = graphic.layer;
    const width = graphic.width > 0 ? graphic.width * u : 0.12;
    if (graphic.kind === "line") {
      const points = graphic.points.map(map);
      for (let index = 0; index + 1 < points.length; index += 1) {
        const a = points[index]!;
        const b = points[index + 1]!;
        lines.push("  (fp_line");
        lines.push("    (start " + fmt(a.x) + " " + fmt(a.y) + ")");
        lines.push("    (end " + fmt(b.x) + " " + fmt(b.y) + ")");
        lines.push("    (stroke (width " + strokeOf(graphic.width) + ") (type solid))");
        lines.push("    (layer \"" + layer + "\")");
        lines.push("  )");
        void width;
      }
      continue;
    }
    if (graphic.kind === "circle") {
      const centerPoint = map(graphic.points[0] ?? { x: 0, y: 0 });
      const r = graphic.radius * u;
      lines.push("  (fp_circle");
      lines.push("    (center " + fmt(centerPoint.x) + " " + fmt(centerPoint.y) + ")");
      lines.push("    (end " + fmt(centerPoint.x + r) + " " + fmt(centerPoint.y) + ")");
      lines.push("    (stroke (width " + fmt(graphic.width > 0 ? graphic.width * u : 0.12) + ") (type solid))");
      lines.push("    (fill none)");
      lines.push("    (layer \"" + layer + "\")");
      lines.push("  )");
      continue;
    }
    if (graphic.kind === "arc") {
      const path = (graphic as { path?: string }).path ?? "";
      const arc = arcPointsOf(path);
      if (arc === null) continue;
      const start = map(arc.start);
      const mid = map(arc.mid);
      const end = map(arc.end);
      lines.push("  (fp_arc");
      lines.push("    (start " + fmt(start.x) + " " + fmt(start.y) + ")");
      lines.push("    (mid " + fmt(mid.x) + " " + fmt(mid.y) + ")");
      lines.push("    (end " + fmt(end.x) + " " + fmt(end.y) + ")");
      lines.push("    (stroke (width " + fmt(graphic.width > 0 ? graphic.width * u : 0.12) + ") (type solid))");
      lines.push("    (layer \"" + layer + "\")");
      lines.push("  )");
      continue;
    }
    // region：courtyard 与装配层画成闭合轮廓（不填充），避免把「板厂看到的形状」当成铜。
    const points = graphic.points.map(map);
    for (let index = 0; index < points.length; index += 1) {
      const a = points[index]!;
      const b = points[(index + 1) % points.length]!;
      lines.push("  (fp_line");
      lines.push("    (start " + fmt(a.x) + " " + fmt(a.y) + ")");
      lines.push("    (end " + fmt(b.x) + " " + fmt(b.y) + ")");
      lines.push("    (stroke (width 0.05) (type solid))");
      lines.push("    (layer \"" + layer + "\")");
      lines.push("  )");
    }
  }
  lines.push(")");
  return { ok: true, error: "", name, text: lines.join("\n") + "\n", pads: padCount };
}

export interface EasyedaFetchResult {
  readonly ok: boolean;
  readonly error: string;
  readonly pkg: EasyedaPackage;
  readonly center: EasyedaPoint;
  readonly name: string;
}

/** 拉一个编号的封装数据（网络失败与页面缺封装分别给不同的话）。 */
export async function fetchEasyedaPackage(
  code: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<EasyedaFetchResult> {
  const clean = code.trim().toUpperCase();
  if (!/^C\d+$/u.test(clean)) {
    return { ok: false, error: "立创编号不对：要 C 加数字，例如 C14663", pkg: EMPTY, center: { x: 0, y: 0 }, name: "" };
  }
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  const abort = (): void => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await doFetch(EASYEDA_PRODUCT_URL(clean), {
      headers: { "user-agent": "dsh-stm32", accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, error: "立创页面返回 " + String(response.status) + "：" + clean, pkg: EMPTY, center: { x: 0, y: 0 }, name: "" };
    }
    const payload = (await response.json()) as unknown;
    const root = payload as { result?: { packageDetail?: { dataStr?: { head?: { x?: unknown; y?: unknown } } } } } | null;
    const head = root?.result?.packageDetail?.dataStr?.head ?? {};
    const center: EasyedaPoint = {
      x: Number(head.x ?? 0) || 0,
      y: Number(head.y ?? 0) || 0,
    };
    const pkg = parseEasyedaPackage(payload);
    if (!pkg.ok) {
      return { ok: false, error: pkg.error, pkg, center, name: "" };
    }
    return { ok: true, error: "", pkg: { ...pkg, code: clean }, center, name: sanitizeName(pkg.packageName, clean) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: "取立创封装失败：" + reason, pkg: EMPTY, center: { x: 0, y: 0 }, name: "" };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

/** 缓存键：编号 + 数据哈希，避免同一编号换了封装还用旧文件。 */
export function easyedaCacheKey(code: string, text: string): string {
  return code + "-" + createHash("sha256").update(text).digest("hex").slice(0, 12);
}
