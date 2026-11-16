/**
 * 板面几何 → SVG（S151）。
 *
 * 面板要看见走线密度、焊盘排布与板框，不需要 KiCad 的绘制规则。这里只画七类东西：
 * 铺铜区、走线、焊盘、过孔、丝印、板框、位号。颜色全部走宿主设计令牌，深浅色由
 * `var(--dsw-alias-*)` 自动跟随，不在 SVG 里写死色值。
 *
 * 选 SVG 而不是 canvas/WebGL：一块 41 元件的板子约 1600 个图元，SVG 体积在 150 KB
 * 量级，浏览器直接按需缩放，面板里还能用 CSS 选中与悬停；引入第三方渲染器要背
 * 42 MB 依赖与不明许可，不划算。
 */
const COLOR_TOP = "var(--dsw-alias-state-business-primary)";
const COLOR_BOTTOM = "var(--dsw-alias-state-success-primary)";
const COLOR_EDGE = "var(--dsw-alias-label-secondary)";
const COLOR_SILK = "var(--dsw-alias-label-tertiary)";
const COLOR_VIA = "var(--dsw-alias-state-warn-primary)";
function n(value) {
    const rounded = Math.round(value * 100) / 100;
    return String(rounded);
}
function escapeText(value) {
    return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}
function rotatePoint(point, cx, cy, degrees) {
    if (degrees === 0)
        return point;
    const radians = (degrees * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const dx = point.x - cx;
    const dy = point.y - cy;
    return { x: cx + dx * cos + dy * sin, y: cy - dx * sin + dy * cos };
}
/** 焊盘的轮廓点；圆用半径表达，其余统一按多边形。 */
function padPoints(pad) {
    const halfWidth = pad.width / 2;
    const halfHeight = pad.height / 2;
    if (pad.shape === "circle")
        return null;
    const corners = [
        { x: -halfWidth, y: -halfHeight },
        { x: halfWidth, y: -halfHeight },
        { x: halfWidth, y: halfHeight },
        { x: -halfWidth, y: halfHeight },
    ].map((point) => ({ x: pad.x + point.x, y: pad.y + point.y }));
    if (pad.shape !== "oval")
        return corners.map((point) => rotatePoint(point, pad.x, pad.y, pad.rotation));
    // 椭圆焊盘：两端各半圆，用折线近似，避免再引入一个 path 图元。
    const radius = Math.min(halfWidth, halfHeight);
    const longAxisX = halfWidth > halfHeight;
    const out = [];
    const steps = 10;
    const first = longAxisX ? { x: -halfWidth + radius, y: 0 } : { x: 0, y: -halfHeight + radius };
    const second = longAxisX ? { x: halfWidth - radius, y: 0 } : { x: 0, y: halfHeight - radius };
    for (let index = 0; index <= steps; index += 1) {
        const angle = -Math.PI / 2 + (index / steps) * Math.PI;
        out.push(longAxisX
            ? { x: pad.x + second.x + radius * Math.cos(angle), y: pad.y + radius * Math.sin(angle) }
            : { x: pad.x + radius * Math.cos(angle), y: pad.y + second.y + radius * Math.sin(angle) });
    }
    for (let index = 0; index <= steps; index += 1) {
        const angle = Math.PI / 2 + (index / steps) * Math.PI;
        out.push(longAxisX
            ? { x: pad.x + first.x + radius * Math.cos(angle), y: pad.y + radius * Math.sin(angle) }
            : { x: pad.x + radius * Math.cos(angle), y: pad.y + first.y + radius * Math.sin(angle) });
    }
    return out.map((point) => rotatePoint(point, pad.x, pad.y, pad.rotation));
}
function fillFor(side) {
    return side === "top" ? COLOR_TOP : COLOR_BOTTOM;
}
export function renderPcbSvg(scene, options = {}) {
    const show = options.show ?? {};
    const maxPx = options.maxPx === undefined || options.maxPx <= 0 ? 720 : options.maxPx;
    const empty = {
        ok: false,
        error: "",
        svg: "",
        width: 0,
        height: 0,
        widthMm: 0,
        heightMm: 0,
        pads: 0,
        tracks: 0,
        vias: 0,
        elements: 0,
    };
    if (!scene.ok)
        return { ...empty, error: scene.error };
    if (scene.bbox === null)
        return { ...empty, error: "板子里没有可画的几何：既没有板框，也没有焊盘或走线。" };
    const paddingMm = 1.6;
    const widthMm = scene.bbox.width + paddingMm * 2;
    const heightMm = scene.bbox.height + paddingMm * 2;
    const scale = Math.min(maxPx / widthMm, maxPx / heightMm, 8);
    const pxPerMm = Number.isFinite(scale) && scale > 0 ? scale : 1;
    const width = Math.max(1, Math.round(widthMm * pxPerMm));
    const height = Math.max(1, Math.round(heightMm * pxPerMm));
    const toX = (value) => (value - scene.bbox.x + paddingMm) * pxPerMm;
    const toY = (value) => (value - scene.bbox.y + paddingMm) * pxPerMm;
    const strokeOf = (widthMmValue) => Math.max(0.6, widthMmValue * pxPerMm);
    const parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + String(width) + " " + String(height) + '" width="' + String(width) + '" height="' + String(height) + '" role="img" aria-label="PCB 预览：' + escapeText(scene.file.split(/[\\/]/u).pop() ?? "") + '">');
    if (options.grid !== false) {
        parts.push('<defs><pattern id="d32-pcb-grid" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="var(--dsw-alias-border-l3)" /></pattern></defs>');
        parts.push('<rect x="0" y="0" width="' + String(width) + '" height="' + String(height) + '" fill="url(#d32-pcb-grid)" opacity="0.5" />');
    }
    const zones = scene.zones;
    if (show.zones !== false && zones.length > 0) {
        const shapes = [];
        for (const zone of zones) {
            if (zone.side === "top" && show.top === false)
                continue;
            if (zone.side === "bottom" && show.bottom === false)
                continue;
            const points = zone.points.map((point) => n(toX(point.x)) + "," + n(toY(point.y))).join(" ");
            shapes.push('<polygon points="' + points + '" fill="' + fillFor(zone.side) + '" opacity="0.1" />');
        }
        if (shapes.length > 0)
            parts.push('<g class="d32-pcb-zones">' + shapes.join("") + "</g>");
    }
    const tracks = [];
    for (const track of scene.tracks) {
        if (track.side === "top" && show.top === false)
            continue;
        if (track.side === "bottom" && show.bottom === false)
            continue;
        tracks.push('<line x1="' + n(toX(track.x1)) + '" y1="' + n(toY(track.y1)) + '" x2="' + n(toX(track.x2)) + '" y2="' + n(toY(track.y2))
            + '" stroke="' + fillFor(track.side) + '" stroke-width="' + n(strokeOf(track.width)) + '" stroke-linecap="round"'
            + (track.side === "bottom" ? ' opacity="0.85"' : "") + " />");
    }
    if (tracks.length > 0)
        parts.push('<g class="d32-pcb-tracks">' + tracks.join("") + "</g>");
    const pads = [];
    if (show.pads !== false) {
        for (const pad of scene.pads) {
            if (pad.side === "top" && show.top === false)
                continue;
            if (pad.side === "bottom" && show.bottom === false)
                continue;
            const color = fillFor(pad.side);
            if (pad.shape === "circle") {
                pads.push('<circle cx="' + n(toX(pad.x)) + '" cy="' + n(toY(pad.y)) + '" r="' + n((pad.width / 2) * pxPerMm) + '" fill="' + color + '" fill-opacity="0.62" />');
                continue;
            }
            const points = padPoints(pad);
            if (points === null)
                continue;
            pads.push('<polygon points="' + points.map((point) => n(toX(point.x)) + "," + n(toY(point.y))).join(" ") + '" fill="' + color + '" fill-opacity="0.62" />');
        }
    }
    if (pads.length > 0)
        parts.push('<g class="d32-pcb-pads">' + pads.join("") + "</g>");
    const vias = [];
    if (show.vias !== false) {
        for (const via of scene.vias) {
            vias.push('<circle cx="' + n(toX(via.x)) + '" cy="' + n(toY(via.y)) + '" r="' + n((via.size / 2) * pxPerMm) + '" fill="var(--dsw-alias-bg-base)" stroke="' + COLOR_VIA + '" stroke-width="0.8" />');
        }
    }
    if (vias.length > 0)
        parts.push('<g class="d32-pcb-vias">' + vias.join("") + "</g>");
    const silk = [];
    if (show.silk !== false) {
        for (const line of scene.silk) {
            silk.push('<line x1="' + n(toX(line.x1)) + '" y1="' + n(toY(line.y1)) + '" x2="' + n(toX(line.x2)) + '" y2="' + n(toY(line.y2)) + '" stroke="' + COLOR_SILK + '" stroke-width="0.6" opacity="0.7" />');
        }
    }
    if (silk.length > 0)
        parts.push('<g class="d32-pcb-silk">' + silk.join("") + "</g>");
    if (show.edge !== false && scene.outline.length > 0) {
        const edge = [];
        for (const line of scene.outline) {
            edge.push('<line x1="' + n(toX(line.x1)) + '" y1="' + n(toY(line.y1)) + '" x2="' + n(toX(line.x2)) + '" y2="' + n(toY(line.y2)) + '" stroke="' + COLOR_EDGE + '" stroke-width="1.2" stroke-linecap="round" />');
        }
        parts.push('<g class="d32-pcb-edge">' + edge.join("") + "</g>");
    }
    if (show.refs === true && scene.refs.length > 0) {
        const labels = [];
        for (const ref of scene.refs) {
            labels.push('<text x="' + n(toX(ref.x)) + '" y="' + n(toY(ref.y)) + '" fill="var(--dsw-alias-label-secondary)" font-family="var(--ds-font-family-code, ui-monospace, monospace)" font-size="10" text-anchor="middle" dominant-baseline="middle">' + escapeText(ref.text) + "</text>");
        }
        parts.push('<g class="d32-pcb-refs">' + labels.join("") + "</g>");
    }
    parts.push("</svg>");
    const elements = zones.length + tracks.length + pads.length + vias.length + silk.length + scene.outline.length + (show.refs === true ? scene.refs.length : 0);
    return {
        ok: true,
        error: "",
        svg: parts.join(""),
        width,
        height,
        widthMm: Math.round(widthMm * 100) / 100,
        heightMm: Math.round(heightMm * 100) / 100,
        pads: pads.length,
        tracks: tracks.length,
        vias: vias.length,
        elements,
    };
}
