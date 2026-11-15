/**
 * 曲线数字化（S122）：把「一张曲线图」变成「若干条 (x, y) 序列」。
 *
 * 做法：渲染后的位图按色相分组得到每条曲线的像素，再用纵/横坐标轴上的刻度文字
 * （来自 pdftotext -bbox 的词框）做线性标定。刻度认不出来时明确失败，不做「大概齐」的猜测——
 * 没有标定的曲线只是形状，谈不上数值。
 */
import type { PdfWord } from "./tables.js";
import type { DecodedPng } from "./png.js";

export interface AxisCalibration {
  /** value = a * pixel + b */
  a: number;
  b: number;
  /** 参与拟合的刻度值（按像素位置升序） */
  ticks: { value: number; pixel: number }[];
  unit: string;
}

export interface Calibration {
  x: AxisCalibration;
  y: AxisCalibration;
  notes: string[];
}

export interface CurveSeries {
  /** 色相名：red / orange / yellow / green / cyan / blue / violet / magenta */
  hue: string;
  /** 图例里认出的名字（Mean / Max 这类）；认不出为空串（S124）。 */
  label: string;
  color: string;
  points: { x: number; y: number }[];
  pixels: number;
}

export interface DigitizeResult {
  calibration: Calibration;
  series: CurveSeries[];
  notes: string[];
}

interface NoCalibration {
  ok: false;
  error: string;
}

const HUE_NAMES = ["red", "orange", "yellow", "green", "cyan", "blue", "violet", "magenta"];

/** 把 RGB 归到 8 个色相桶；灰色（饱和度低）返回 -1。 */
function hueBucket(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  if (sat < 0.45 || max < 90) return -1;
  const delta = max - min;
  let hue = 0;
  if (max === r) hue = ((g - b) / delta + 6) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  const degrees = hue * 60;
  return Math.min(7, Math.floor(((degrees + 22.5) % 360) / 45));
}

const BUCKET_RGB: Record<number, string> = {
  0: "#ff0000",
  1: "#ff8000",
  2: "#ffff00",
  3: "#00c000",
  4: "#00e0e0",
  5: "#3399ff",
  6: "#8000ff",
  7: "#ff00aa",
};

export function digitizeCurves(
  image: DecodedPng,
  calibration: Calibration,
  options: { maxPoints?: number } = {},
): DigitizeResult {
  const notes: string[] = [];
  const maxPoints = options.maxPoints ?? 40;
  const columns = new Map<number, Map<number, number[]>>();
  const pixelCount = new Map<number, number>();
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const index = (y * image.width + x) * 4;
      const bucket = hueBucket(image.rgba[index] ?? 0, image.rgba[index + 1] ?? 0, image.rgba[index + 2] ?? 0);
      if (bucket < 0) continue;
      pixelCount.set(bucket, (pixelCount.get(bucket) ?? 0) + 1);
      let byColumn = columns.get(bucket);
      if (byColumn === undefined) {
        byColumn = new Map<number, number[]>();
        columns.set(bucket, byColumn);
      }
      const ys = byColumn.get(x);
      if (ys === undefined) byColumn.set(x, [y]);
      else ys.push(y);
    }
  }
  const yTicks = calibration.y.ticks;
  const xTicks = calibration.x.ticks;
  const yLow = Math.min(...yTicks.map((tick) => tick.value));
  const yHigh = Math.max(...yTicks.map((tick) => tick.value));
  const ySpan = Math.abs(yHigh - yLow);
  const xLow = Math.min(...xTicks.map((tick) => tick.value));
  const xHigh = Math.max(...xTicks.map((tick) => tick.value));
  const xSpan = Math.abs(xHigh - xLow);
  const series: CurveSeries[] = [];
  for (const [bucket, byColumn] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    const pixels = pixelCount.get(bucket) ?? 0;
    if (pixels < 120) {
      notes.push("跳过 " + HUE_NAMES[bucket] + "：像素太少（" + pixels + "）");
      continue;
    }
    const sortedX = [...byColumn.keys()].sort((a, b) => a - b);
    if (sortedX.length < 8) {
      notes.push("跳过 " + HUE_NAMES[bucket] + "：横向跨度太小（" + sortedX.length + " 列）");
      continue;
    }
    const step = Math.max(1, Math.floor(sortedX.length / maxPoints));
    const points: { x: number; y: number }[] = [];
    for (let index = 0; index < sortedX.length; index += step) {
      const x = sortedX[index] ?? 0;
      const ys = byColumn.get(x) ?? [];
      if (ys.length === 0) continue;
      const median = ys.sort((a, b) => a - b)[Math.floor(ys.length / 2)] ?? 0;
      points.push({
        x: round(calibration.x.a * x + calibration.x.b, 3),
        y: round(calibration.y.a * median + calibration.y.b, 4),
      });
    }
    const ys = points.map((point) => point.y);
    const inside = ys.filter((value) => value >= yLow - ySpan * 0.06 && value <= yHigh + ySpan * 0.06).length;
    if (points.length === 0 || inside / points.length < 0.6) {
      notes.push("跳过 " + HUE_NAMES[bucket] + "：多数像素落在坐标轴范围外（疑似图例、链接文字或页眉）");
      continue;
    }
    const xs = points.map((point) => point.x);
    const outOfRange = xs.some((value) => value < xLow - xSpan * 0.2 || value > xHigh + xSpan * 0.2);
    if (outOfRange) notes.push(HUE_NAMES[bucket] + " 的横向范围超出坐标轴，端点值可能不可信");
    series.push({ hue: HUE_NAMES[bucket] ?? "unknown", label: "", color: BUCKET_RGB[bucket] ?? "#888888", points, pixels });
  }
  if (series.length === 0) notes.push("没有找到饱和色调的曲线像素：这张图可能不是彩色曲线");
  return { calibration, series, notes };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 从一个数字词里取值；"1.235"、"−40"、"0"、"1,2" 都能认，认不出返回 null。 */
function numberOfWord(text: string): number | null {
  const cleaned = text.replace(/[−–—]/gu, "-").replace(/,/gu, ".").trim();
  if (!/^-?\d+(?:\.\d+)?$/u.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function fitLine(pairs: { pixel: number; value: number }[]): { a: number; b: number } {
  const n = pairs.length;
  const sumX = pairs.reduce((acc, item) => acc + item.pixel, 0);
  const sumY = pairs.reduce((acc, item) => acc + item.value, 0);
  const sumXY = pairs.reduce((acc, item) => acc + item.pixel * item.value, 0);
  const sumXX = pairs.reduce((acc, item) => acc + item.pixel * item.pixel, 0);
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return { a: 0, b: sumY / Math.max(1, n) };
  const a = (n * sumXY - sumX * sumY) / denominator;
  return { a, b: (sumY - a * sumX) / n };
}

/**
 * 从词框里认坐标轴刻度。
 *
 * 纵向刻度：同一列（x 中心接近）、竖直排列、竖直方向随值单调 → 纵轴。
 * 横向刻度：同一行（y 基线接近）、水平排列 → 横轴。
 */
export function calibrateFromWords(
  words: readonly PdfWord[],
  options: { scale?: number; bounds?: PixelBounds } = {},
): { ok: true; calibration: Calibration } | NoCalibration {
  const scale = options.scale ?? 1;
  const bounds = options.bounds;
  /** 只认落在图区范围内的刻度：同页两张图时，靠这个把隔壁图的刻度筛掉（S124）。 */
  const insideBounds = (word: PdfWord): boolean => {
    if (bounds === undefined) return true;
    const cx = ((word.x0 + word.x1) / 2) * scale;
    const cy = ((word.y0 + word.y1) / 2) * scale;
    const padX = (bounds.x1 - bounds.x0) * 0.25;
    const padY = (bounds.y1 - bounds.y0) * 0.25;
    return cx >= bounds.x0 - padX && cx <= bounds.x1 + padX && cy >= bounds.y0 - padY && cy <= bounds.y1 + padY;
  };
  const numeric = words
    .filter((word) => insideBounds(word))
    .map((word) => ({ word, value: numberOfWord(word.text) }))
    .filter((item): item is { word: PdfWord; value: number } => item.value !== null);
  if (numeric.length < 6) return { ok: false, error: "页面上认出的数字太少（" + numeric.length + " 个），无法标定坐标轴" };

  const columns = new Map<number, { value: number; y: number }[]>();
  for (const item of numeric) {
    const key = Math.round(((item.word.x0 + item.word.x1) / 2) * 2) / 2;
    const list = columns.get(key);
    const center = (item.word.y0 + item.word.y1) / 2;
    if (list === undefined) columns.set(key, [{ value: item.value, y: center }]);
    else list.push({ value: item.value, y: center });
  }
  let bestColumn: { key: number; items: { value: number; y: number }[] } | null = null;
  for (const [key, items] of columns) {
    if (items.length < 3) continue;
    if (bestColumn === null || items.length > bestColumn.items.length) bestColumn = { key, items };
  }
  if (bestColumn === null) return { ok: false, error: "没有找到成列的纵轴刻度" };
  const yTicks = bestColumn.items
    .map((item) => ({ value: item.value, pixel: item.y * scale }))
    .sort((a, b) => a.pixel - b.pixel);
  const ySpread = Math.abs((yTicks[yTicks.length - 1]?.value ?? 0) - (yTicks[0]?.value ?? 0));
  if (ySpread === 0) return { ok: false, error: "纵轴刻度值全都相同，无法标定" };

  const rows = new Map<number, { value: number; x: number }[]>();
  for (const item of numeric) {
    const key = Math.round(((item.word.y0 + item.word.y1) / 2) * 2) / 2;
    const list = rows.get(key);
    const center = (item.word.x0 + item.word.x1) / 2;
    if (list === undefined) rows.set(key, [{ value: item.value, x: center }]);
    else list.push({ value: item.value, x: center });
  }
  let bestRow: { key: number; items: { value: number; x: number }[] } | null = null;
  for (const [key, items] of rows) {
    if (items.length < 3) continue;
    if (key === bestColumn.key) continue;
    if (bestRow === null || items.length > bestRow.items.length) bestRow = { key, items };
  }
  if (bestRow === null) return { ok: false, error: "没有找到成行的横轴刻度" };
  const xTicks = bestRow.items
    .map((item) => ({ value: item.value, pixel: item.x * scale }))
    .sort((a, b) => a.pixel - b.pixel);

  const yFit = fitLine(yTicks);
  const xFit = fitLine(xTicks);
  const notes: string[] = [
    "纵轴刻度 " + yTicks.length + " 个（" + yTicks[0]?.value + "…" + yTicks[yTicks.length - 1]?.value + "）",
    "横轴刻度 " + xTicks.length + " 个（" + xTicks[0]?.value + "…" + xTicks[xTicks.length - 1]?.value + "）",
    bounds === undefined
      ? "标定按最近的一列/一行数字拟合：同页若有多张图，结果可能落到隔壁那张"
      : "刻度只取图区附近的那一组（同页多图时按彩色像素外接框筛过）",
  ];
  /** 刻度间距是否均匀：均匀的刻度拟合才可信，绝对值大小不影响线性标定。 */
  const irregularity = (ticks: { pixel: number }[]): number => {
    const gaps = ticks.slice(1).map((item, index) => Math.abs(item.pixel - (ticks[index]?.pixel ?? 0)));
    const middle = median(gaps);
    if (middle === 0) return 0;
    return Math.max(...gaps.map((gap) => Math.abs(gap - middle) / middle));
  };
  const yIrregular = irregularity(yTicks);
  const xIrregular = irregularity(xTicks);
  if (yIrregular > 0.4) notes.push("纵轴刻度间距不均匀（最大偏差 " + Math.round(yIrregular * 100) + "%），拟合可能不稳");
  if (xIrregular > 0.4) notes.push("横轴刻度间距不均匀（最大偏差 " + Math.round(xIrregular * 100) + "%），拟合可能不稳");
  return {
    ok: true,
    calibration: {
      x: { a: xFit.a, b: xFit.b, ticks: xTicks, unit: "" },
      y: { a: yFit.a, b: yFit.b, ticks: yTicks, unit: "" },
      notes,
    },
  };
}

export interface PixelBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * 彩色像素的外接框（S124）。
 *
 * 一张页可能有两张图，刻度文字也各有一套。先量出「彩色曲线占了哪块地方」，
 * 再用它把刻度候选筛到同一块地方，才能避免标定到隔壁那张图。
 */
export function chromaBounds(image: DecodedPng, margin = 0): PixelBounds | null {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const at = (y * image.width + x) * 4;
      const bucket = hueBucket(image.rgba[at] ?? 0, image.rgba[at + 1] ?? 0, image.rgba[at + 2] ?? 0);
      if (bucket < 0) continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0 || y1 < 0) return null;
  return {
    x0: Math.max(0, x0 - margin),
    y0: Math.max(0, y0 - margin),
    x1: Math.min(image.width - 1, x1 + margin),
    y1: Math.min(image.height - 1, y1 + margin),
  };
}

/**
 * 图例的「颜色 → 名字」（S124）。
 *
 * 手册的图例是「一小段彩色线段 + 一个词」。词能从 bbox 里拿到，颜色只能从图里取：
 * 在词的左边找一小块彩色像素，取出现最多的色相，就得到这条线的名字。
 * 图例文字若被转成轮廓，这里自然拿不到，返回空表即可。
 */
export function legendLabels(
  words: readonly PdfWord[],
  image: DecodedPng,
  bounds: PixelBounds | null,
  options: { scale?: number } = {},
): Map<number, string> {
  const scale = options.scale ?? 1;
  const labels = new Map<number, string>();
  const candidates = words.filter((word) => /^[A-Za-z][A-Za-z0-9 .%°-]{0,18}$/u.test(word.text.trim()) && word.text.trim().length >= 2);
  for (const word of candidates) {
    const y0 = Math.round(word.y0 * scale);
    const y1 = Math.round(word.y1 * scale);
    const xStart = Math.round(word.x0 * scale) - Math.round(30 * scale);
    const xEnd = Math.round(word.x0 * scale) - 2;
    if (y0 < 0 || y1 >= image.height || xEnd <= 0) continue;
    if (bounds !== null) {
      const inside = y0 >= bounds.y0 - Math.round(24 * scale) && y1 <= bounds.y1 + Math.round(24 * scale) && xEnd >= bounds.x0 - Math.round(60 * scale);
      if (!inside) continue;
    }
    const counts = new Map<number, number>();
    for (let y = Math.max(0, y0); y <= Math.min(image.height - 1, y1); y += 1) {
      for (let x = Math.max(0, xStart); x <= Math.min(image.width - 1, xEnd); x += 1) {
        const at = (y * image.width + x) * 4;
        const bucket = hueBucket(image.rgba[at] ?? 0, image.rgba[at + 1] ?? 0, image.rgba[at + 2] ?? 0);
        if (bucket < 0) continue;
        counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
      }
    }
    let bestBucket = -1;
    let bestCount = 0;
    for (const [bucket, count] of counts) {
      if (count > bestCount) {
        bestBucket = bucket;
        bestCount = count;
      }
    }
    if (bestBucket < 0 || bestCount < 12) continue;
    if (labels.has(bestBucket)) continue;
    labels.set(bestBucket, word.text.trim());
  }
  return labels;
}
