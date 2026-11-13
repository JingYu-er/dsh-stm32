/**
 * 引脚坐标变换：库坐标 → 图纸坐标。
 *
 * 库符号的 `pin (at x y)` 是 +y 向上的笛卡尔坐标，图纸是 +y 向下；符号实例再用
 * `(at cx cy rot)` 与可选 `(mirror x|y)` 摆放。实测这套式子在样例工程上
 * 122/145 个引脚与导线端点精确重合（0.02 mm），其余行级近似方案明显更差，
 * 因此这里固定按「翻转 → 顺时针旋转 → 平移到实例坐标」计算。
 */
/** 把库引脚坐标摆到图纸坐标。 */
export function placePin(pin, symbol) {
    let px = pin.x;
    let py = -pin.y;
    if (symbol.mirror === "x")
        py = -py;
    if (symbol.mirror === "y")
        px = -px;
    const degrees = ((symbol.rot % 360) + 360) % 360;
    const radians = (degrees * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return {
        x: symbol.at.x + px * cos + py * sin,
        y: symbol.at.y - px * sin + py * cos,
    };
}
