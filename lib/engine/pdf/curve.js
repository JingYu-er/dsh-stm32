const HUE_NAMES = ["red", "orange", "yellow", "green", "cyan", "blue", "violet", "magenta"];
/** 把 RGB 归到 8 个色相桶；灰色（饱和度低）返回 -1。 */
function hueBucket(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    if (sat < 0.45 || max < 90)
        return -1;
    const delta = max - min;
    let hue = 0;
    if (max === r)
        hue = ((g - b) / delta + 6) % 6;
    else if (max === g)
        hue = (b - r) / delta + 2;
    else
        hue = (r - g) / delta + 4;
    const degrees = hue * 60;
    return Math.min(7, Math.floor(((degrees + 22.5) % 360) / 45));
}
const BUCKET_RGB = {
    0: "#ff0000",
    1: "#ff8000",
    2: "#ffff00",
    3: "#00c000",
    4: "#00e0e0",
    5: "#3399ff",
    6: "#8000ff",
    7: "#ff00aa",
};
export function digitizeCurves(image, calibration, options = {}) {
    const notes = [];
    const maxPoints = options.maxPoints ?? 40;
    const columns = new Map();
    const pixelCount = new Map();
    for (let y = 0; y < image.height; y += 1) {
        for (let x = 0; x < image.width; x += 1) {
            const index = (y * image.width + x) * 4;
            const bucket = hueBucket(image.rgba[index] ?? 0, image.rgba[index + 1] ?? 0, image.rgba[index + 2] ?? 0);
            if (bucket < 0)
                continue;
            pixelCount.set(bucket, (pixelCount.get(bucket) ?? 0) + 1);
            let byColumn = columns.get(bucket);
            if (byColumn === undefined) {
                byColumn = new Map();
                columns.set(bucket, byColumn);
            }
            const ys = byColumn.get(x);
            if (ys === undefined)
                byColumn.set(x, [y]);
            else
                ys.push(y);
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
    const series = [];
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
        const points = [];
        for (let index = 0; index < sortedX.length; index += step) {
            const x = sortedX[index] ?? 0;
            const ys = byColumn.get(x) ?? [];
            if (ys.length === 0)
                continue;
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
        if (outOfRange)
            notes.push(HUE_NAMES[bucket] + " 的横向范围超出坐标轴，端点值可能不可信");
        series.push({ hue: HUE_NAMES[bucket] ?? "unknown", color: BUCKET_RGB[bucket] ?? "#888888", points, pixels });
    }
    if (series.length === 0)
        notes.push("没有找到饱和色调的曲线像素：这张图可能不是彩色曲线");
    return { calibration, series, notes };
}
function round(value, digits) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}
/** 从一个数字词里取值；"1.235"、"−40"、"0"、"1,2" 都能认，认不出返回 null。 */
function numberOfWord(text) {
    const cleaned = text.replace(/[−–—]/gu, "-").replace(/,/gu, ".").trim();
    if (!/^-?\d+(?:\.\d+)?$/u.test(cleaned))
        return null;
    const value = Number(cleaned);
    return Number.isFinite(value) ? value : null;
}
function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
function fitLine(pairs) {
    const n = pairs.length;
    const sumX = pairs.reduce((acc, item) => acc + item.pixel, 0);
    const sumY = pairs.reduce((acc, item) => acc + item.value, 0);
    const sumXY = pairs.reduce((acc, item) => acc + item.pixel * item.value, 0);
    const sumXX = pairs.reduce((acc, item) => acc + item.pixel * item.pixel, 0);
    const denominator = n * sumXX - sumX * sumX;
    if (denominator === 0)
        return { a: 0, b: sumY / Math.max(1, n) };
    const a = (n * sumXY - sumX * sumY) / denominator;
    return { a, b: (sumY - a * sumX) / n };
}
/**
 * 从词框里认坐标轴刻度。
 *
 * 纵向刻度：同一列（x 中心接近）、竖直排列、竖直方向随值单调 → 纵轴。
 * 横向刻度：同一行（y 基线接近）、水平排列 → 横轴。
 */
export function calibrateFromWords(words, options = {}) {
    const scale = options.scale ?? 1;
    const numeric = words
        .map((word) => ({ word, value: numberOfWord(word.text) }))
        .filter((item) => item.value !== null);
    if (numeric.length < 6)
        return { ok: false, error: "页面上认出的数字太少（" + numeric.length + " 个），无法标定坐标轴" };
    const columns = new Map();
    for (const item of numeric) {
        const key = Math.round(((item.word.x0 + item.word.x1) / 2) * 2) / 2;
        const list = columns.get(key);
        const center = (item.word.y0 + item.word.y1) / 2;
        if (list === undefined)
            columns.set(key, [{ value: item.value, y: center }]);
        else
            list.push({ value: item.value, y: center });
    }
    let bestColumn = null;
    for (const [key, items] of columns) {
        if (items.length < 3)
            continue;
        if (bestColumn === null || items.length > bestColumn.items.length)
            bestColumn = { key, items };
    }
    if (bestColumn === null)
        return { ok: false, error: "没有找到成列的纵轴刻度" };
    const yTicks = bestColumn.items
        .map((item) => ({ value: item.value, pixel: item.y * scale }))
        .sort((a, b) => a.pixel - b.pixel);
    const ySpread = Math.abs((yTicks[yTicks.length - 1]?.value ?? 0) - (yTicks[0]?.value ?? 0));
    if (ySpread === 0)
        return { ok: false, error: "纵轴刻度值全都相同，无法标定" };
    const rows = new Map();
    for (const item of numeric) {
        const key = Math.round(((item.word.y0 + item.word.y1) / 2) * 2) / 2;
        const list = rows.get(key);
        const center = (item.word.x0 + item.word.x1) / 2;
        if (list === undefined)
            rows.set(key, [{ value: item.value, x: center }]);
        else
            list.push({ value: item.value, x: center });
    }
    let bestRow = null;
    for (const [key, items] of rows) {
        if (items.length < 3)
            continue;
        if (key === bestColumn.key)
            continue;
        if (bestRow === null || items.length > bestRow.items.length)
            bestRow = { key, items };
    }
    if (bestRow === null)
        return { ok: false, error: "没有找到成行的横轴刻度" };
    const xTicks = bestRow.items
        .map((item) => ({ value: item.value, pixel: item.x * scale }))
        .sort((a, b) => a.pixel - b.pixel);
    const yFit = fitLine(yTicks);
    const xFit = fitLine(xTicks);
    const notes = [
        "纵轴刻度 " + yTicks.length + " 个（" + yTicks[0]?.value + "…" + yTicks[yTicks.length - 1]?.value + "）",
        "横轴刻度 " + xTicks.length + " 个（" + xTicks[0]?.value + "…" + xTicks[xTicks.length - 1]?.value + "）",
        "标定按最近的一列/一行数字拟合，若图上有多组刻度，结果可能是错的那一组",
    ];
    const spreadOf = (ticks) => median(ticks.slice(1).map((item, index) => Math.abs(item.pixel - (ticks[index]?.pixel ?? 0))));
    if (spreadOf(yTicks) > 60)
        notes.push("纵轴刻度间距偏大（" + Math.round(spreadOf(yTicks)) + " px），拟合可能不稳");
    if (spreadOf(xTicks) > 120)
        notes.push("横轴刻度间距偏大（" + Math.round(spreadOf(xTicks)) + " px），拟合可能不稳");
    return {
        ok: true,
        calibration: {
            x: { a: xFit.a, b: xFit.b, ticks: xTicks, unit: "" },
            y: { a: yFit.a, b: yFit.b, ticks: yTicks, unit: "" },
            notes,
        },
    };
}
