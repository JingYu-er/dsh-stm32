const DEFAULT_GAP = 0.6;
const DEFAULT_MARGIN = 3;
function halfExtent(part) {
    return { hw: Math.max(part.courtyardWidth, part.width, 0.5) / 2, hh: Math.max(part.courtyardHeight, part.height, 0.5) / 2 };
}
function overlaps(a, b, gap) {
    return !(a.x + a.w / 2 + gap <= b.x - b.w / 2 ||
        b.x + b.w / 2 + gap <= a.x - a.w / 2 ||
        a.y + a.h / 2 + gap <= b.y - b.h / 2 ||
        b.y + b.h / 2 + gap <= a.y - a.h / 2);
}
function insideBoard(box, board, margin) {
    return (box.x - box.w / 2 >= margin &&
        box.y - box.h / 2 >= margin &&
        box.x + box.w / 2 <= board.width - margin &&
        box.y + box.h / 2 <= board.height - margin);
}
/** 某元件与哪些元件有连接（用于"小件跟大件"的放置）。 */
function neighbours(model) {
    const map = new Map();
    for (const net of model.nets) {
        for (const a of net.pins) {
            for (const b of net.pins) {
                if (a.ref === b.ref)
                    continue;
                const row = map.get(a.ref) ?? new Map();
                row.set(b.ref, (row.get(b.ref) ?? 0) + 1);
                map.set(a.ref, row);
            }
        }
    }
    return map;
}
function isBig(part) {
    return part.kind !== "passive" && Math.max(part.courtyardWidth, part.courtyardHeight) >= 2.5;
}
function ringPositions(count, radiusX, radiusY, cx, cy) {
    const result = [];
    for (let index = 0; index < count; index += 1) {
        const angle = -Math.PI / 2 + (index * 2 * Math.PI) / Math.max(count, 1);
        result.push({ x: cx + Math.cos(angle) * radiusX, y: cy + Math.sin(angle) * radiusY });
    }
    return result;
}
/** 从元件中心向外螺旋找一个不冲突的位置。 */
function spiral(part, start, boxes, board, margin, gap) {
    const { hw, hh } = halfExtent(part);
    for (let step = 0; step < 120; step += 1) {
        const theta = step * 2.399963;
        const radius = 1.2 + 1.1 * Math.sqrt(step);
        const x = start.x + Math.cos(theta) * radius;
        const y = start.y + Math.sin(theta) * radius;
        const box = { x, y, w: hw * 2, h: hh * 2 };
        if (!insideBoard(box, board, margin))
            continue;
        if (boxes.some((other) => overlaps(box, other, gap)))
            continue;
        return { x, y, box };
    }
    return null;
}
/** 计算放置方案：先大件分区，再小件贴人。 */
export function planPlacement(model, options = {}) {
    const gap = options.gap ?? DEFAULT_GAP;
    const margin = options.margin ?? DEFAULT_MARGIN;
    const board = { width: options.widthMm ?? model.board.width, height: options.heightMm ?? model.board.height };
    const notes = [];
    if (!model.ok)
        return { ok: false, error: model.error, board, items: [], unplaced: [], notes };
    if (model.parts.length === 0)
        return { ok: false, error: "板上没有元件：先完成原理图并构建", board, items: [], unplaced: [], notes };
    const big = model.parts.filter(isBig);
    const small = model.parts.filter((part) => !isBig(part));
    const link = neighbours(model);
    const placed = [];
    const boxes = [];
    const center = { x: board.width / 2, y: board.height / 2 };
    const mcu = big.find((part) => part.kind === "mcu") ?? big.find((part) => part.kind === "ic");
    if (mcu !== undefined) {
        const { hw, hh } = halfExtent(mcu);
        const box = { x: center.x, y: center.y, w: hw * 2, h: hh * 2 };
        placed.push({ ref: mcu.ref, x: center.x, y: center.y, rotation: 0, kind: mcu.kind });
        boxes.push(box);
    }
    const rest = big.filter((part) => part.ref !== mcu?.ref);
    const edge = rest.filter((part) => part.kind === "connector" || part.kind === "keys");
    const around = rest.filter((part) => part.kind !== "connector" && part.kind !== "keys");
    // 接口与按键沿板边摆：接口优先长边、按键优先短边，符合"手能碰到"。
    edge.forEach((part, index) => {
        const { hw, hh } = halfExtent(part);
        const slot = ringPositions(edge.length, board.width / 2 - margin - hw, board.height / 2 - margin - hh, center.x, center.y)[index];
        const target = slot ?? center;
        const found = spiral(part, target, boxes, board, margin, gap);
        if (found === null) {
            notes.push("放不下：" + part.ref);
            return;
        }
        placed.push({ ref: part.ref, x: found.x, y: found.y, rotation: 0, kind: part.kind });
        boxes.push(found.box);
    });
    around.forEach((part, index) => {
        const { hw, hh } = halfExtent(part);
        const radiusX = board.width / 4 + hw;
        const radiusY = board.height / 4 + hh;
        const target = ringPositions(Math.max(around.length, 1), radiusX, radiusY, center.x, center.y)[index] ?? center;
        const found = spiral(part, target, boxes, board, margin, gap);
        if (found === null) {
            notes.push("放不下：" + part.ref);
            return;
        }
        placed.push({ ref: part.ref, x: found.x, y: found.y, rotation: 0, kind: part.kind });
        boxes.push(found.box);
    });
    // 小件：贴近连接最多的大件；找不到连接就贴主控。
    for (const part of small) {
        const votes = link.get(part.ref);
        let host = mcu?.ref ?? "";
        let best = 0;
        if (votes !== undefined) {
            for (const [ref, count] of votes) {
                if (count > best && placed.some((item) => item.ref === ref)) {
                    best = count;
                    host = ref;
                }
            }
        }
        const anchor = placed.find((item) => item.ref === host) ?? { x: center.x, y: center.y };
        const found = spiral(part, { x: anchor.x, y: anchor.y }, boxes, board, margin, gap);
        if (found === null) {
            notes.push("放不下：" + part.ref);
            continue;
        }
        placed.push({ ref: part.ref, x: found.x, y: found.y, rotation: 0, kind: part.kind });
        boxes.push(found.box);
    }
    const unplaced = model.parts.filter((part) => !placed.some((item) => item.ref === part.ref)).map((part) => part.ref);
    if (unplaced.length > 0)
        notes.push("有 " + String(unplaced.length) + " 个元件没放下：板框偏小或元件过密");
    return { ok: true, error: "", board, items: placed, unplaced, notes };
}
