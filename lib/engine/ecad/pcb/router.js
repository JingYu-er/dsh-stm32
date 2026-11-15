const POWER_NET = /^(GND|VCC|VDD|VSS|VBUS|\+?\d+V\d*|\+?3V3|\+?5V)$/iu;
export function isPowerNet(net) {
    return POWER_NET.test(net.trim());
}
function index(grid, col, row) {
    return row * grid.cols + col;
}
function toCol(grid, x) {
    return Math.round((x - grid.x0) / grid.res);
}
function toRow(grid, y) {
    return Math.round((y - grid.y0) / grid.res);
}
function markDisc(grid, cx, cy, radiusMm) {
    const radius = Math.max(1, Math.ceil(radiusMm / grid.res));
    const col = toCol(grid, cx);
    const row = toRow(grid, cy);
    for (let dr = -radius; dr <= radius; dr += 1) {
        for (let dc = -radius; dc <= radius; dc += 1) {
            if (dc * dc + dr * dr > radius * radius)
                continue;
            const c = col + dc;
            const r = row + dr;
            if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows)
                continue;
            grid.blocked[index(grid, c, r)] = 1;
        }
    }
}
function markFree(grid, cx, cy, radiusMm) {
    const radius = Math.max(1, Math.ceil(radiusMm / grid.res));
    const col = toCol(grid, cx);
    const row = toRow(grid, cy);
    for (let dr = -radius; dr <= radius; dr += 1) {
        for (let dc = -radius; dc <= radius; dc += 1) {
            if (dc * dc + dr * dr > radius * radius)
                continue;
            const c = col + dc;
            const r = row + dr;
            if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows)
                continue;
            grid.blocked[index(grid, c, r)] = 0;
        }
    }
}
function markLine(grid, x1, y1, x2, y2, radiusMm) {
    const length = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(1, Math.ceil(length / (grid.res * 0.5)));
    for (let step = 0; step <= steps; step += 1) {
        const ratio = step / steps;
        markDisc(grid, x1 + (x2 - x1) * ratio, y1 + (y2 - y1) * ratio, radiusMm);
    }
}
const DIRS = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
];
class MinHeap {
    items = [];
    push(item) {
        this.items.push(item);
        let child = this.items.length - 1;
        while (child > 0) {
            const parent = (child - 1) >> 1;
            const a = this.items[child];
            const b = this.items[parent];
            if (a === undefined || b === undefined || a.estimate >= b.estimate)
                break;
            this.items[child] = b;
            this.items[parent] = a;
            child = parent;
        }
    }
    pop() {
        const top = this.items[0];
        const last = this.items.pop();
        if (this.items.length > 0 && last !== undefined) {
            this.items[0] = last;
            let parent = 0;
            for (;;) {
                const left = parent * 2 + 1;
                const right = left + 1;
                let smallest = parent;
                const a = this.items[smallest];
                const l = this.items[left];
                const r = this.items[right];
                if (l !== undefined && a !== undefined && l.estimate < a.estimate)
                    smallest = left;
                const best = this.items[smallest];
                if (r !== undefined && best !== undefined && r.estimate < best.estimate)
                    smallest = right;
                if (smallest === parent)
                    break;
                const temp = this.items[parent];
                const swap = this.items[smallest];
                if (temp === undefined || swap === undefined)
                    break;
                this.items[parent] = swap;
                this.items[smallest] = temp;
                parent = smallest;
            }
        }
        return top;
    }
    get size() {
        return this.items.length;
    }
}
function nearestPadOrder(pads) {
    const order = [0];
    const rest = new Set(pads.map((_pad, i) => i).slice(1));
    while (rest.size > 0) {
        const last = pads[order[order.length - 1] ?? 0];
        let best = -1;
        let bestDist = Number.POSITIVE_INFINITY;
        for (const candidate of rest) {
            const pad = pads[candidate];
            if (pad === undefined || last === undefined)
                continue;
            const dist = Math.abs(pad.x - last.x) + Math.abs(pad.y - last.y);
            if (dist < bestDist) {
                bestDist = dist;
                best = candidate;
            }
        }
        if (best < 0)
            break;
        order.push(best);
        rest.delete(best);
    }
    return order;
}
/**
 * 布一张网：从起点焊盘出发，逐次连到「最近的未连焊盘」。
 * 每连一条就把路径写进障碍，后面的网络不会压到它。
 */
function routeNet(grid, pads, widthMm, options) {
    const segments = [];
    let lastReason = "";
    const order = nearestPadOrder(pads);
    const cos = Math.cos(Math.PI / 4);
    let failed = false;
    const widthCells = Math.max(1, Math.ceil((widthMm / 2 + options.clearanceMm) / grid.res));
    for (let step = 1; step < order.length; step += 1) {
        const fromPad = pads[order[step - 1] ?? 0];
        const toPad = pads[order[step] ?? 0];
        if (fromPad === undefined || toPad === undefined)
            continue;
        const startCol = toCol(grid, fromPad.x);
        const startRow = toRow(grid, fromPad.y);
        const goalCol = toCol(grid, toPad.x);
        const goalRow = toRow(grid, toPad.y);
        if (startCol === goalCol && startRow === goalRow)
            continue;
        // 焊盘本体与相邻焊盘的膨胀可能把起点围死：在起终点周围清出一小片可走区域（逃逸孔）。
        const startBlocked = grid.blocked[index(grid, startCol, startRow)] === 1;
        const goalBlocked = grid.blocked[index(grid, goalCol, goalRow)] === 1;
        const escape = Math.hypot(fromPad.width, fromPad.height) / 2 + grid.res * 1.2;
        markFree(grid, fromPad.x, fromPad.y, escape);
        markFree(grid, toPad.x, toPad.y, escape);
        // 起点与终点附近暂时清空，避免自己的焊盘挡住出路。
        const cost = new Float32Array(grid.cols * grid.rows).fill(Number.POSITIVE_INFINITY);
        const previous = new Int32Array(grid.cols * grid.rows).fill(-1);
        const open = new MinHeap();
        const startKey = index(grid, startCol, startRow);
        cost[startKey] = 0;
        open.push({ key: startKey, cost: 0, estimate: Math.hypot(goalCol - startCol, goalRow - startRow) });
        let visited = 0;
        let reached = -1;
        while (open.size > 0 && visited < 60000) {
            const current = open.pop();
            if (current === undefined)
                break;
            visited += 1;
            const col = current.key % grid.cols;
            const row = Math.floor(current.key / grid.cols);
            if (col === goalCol && row === goalRow) {
                reached = current.key;
                break;
            }
            for (const [dc, dr] of DIRS) {
                const nc = col + dc;
                const nr = row + dr;
                if (nc < 0 || nr < 0 || nc >= grid.cols || nr >= grid.rows)
                    continue;
                const key = index(grid, nc, nr);
                if (grid.blocked[key] === 1 || cost[key] !== undefined && cost[key] !== Number.POSITIVE_INFINITY)
                    continue;
                const dist = Math.hypot(dc, dr);
                let next = (cost[current.key] ?? 0) + dist;
                const isDiagonal = dc !== 0 && dr !== 0;
                const prevKey = previous[current.key];
                if (isDiagonal)
                    next *= 1.0;
                if (prevKey !== undefined && prevKey >= 0) {
                    const pc = prevKey % grid.cols;
                    const pr = Math.floor(prevKey / grid.cols);
                    if ((pc !== col && col - pc !== dc) || (pr !== row && row - pr !== dr))
                        next += options.turnCostMm / grid.res;
                }
                if (next < (cost[key] ?? Number.POSITIVE_INFINITY)) {
                    cost[key] = next;
                    previous[key] = current.key;
                    open.push({ key, cost: next, estimate: next + Math.hypot(goalCol - nc, goalRow - nr) });
                }
            }
        }
        if (reached < 0) {
            failed = true;
            lastReason = "起点被围 " + (startBlocked ? "是" : "否") + "、终点被围 " + (goalBlocked ? "是" : "否") + "、探索 " + String(visited) + " 格";
            continue;
        }
        // 回溯成折线，再把同一方向上的点合并成段。
        const points = [];
        let cursor = reached;
        while (cursor >= 0) {
            const col = cursor % grid.cols;
            const row = Math.floor(cursor / grid.cols);
            points.push([grid.x0 + col * grid.res, grid.y0 + row * grid.res]);
            cursor = previous[cursor] ?? -1;
        }
        points.reverse();
        const simplified = [points[0] ?? [0, 0]];
        for (let i = 1; i < points.length - 1; i += 1) {
            const a = points[i - 1];
            const b = points[i];
            const c = points[i + 1];
            if (a === undefined || b === undefined || c === undefined)
                continue;
            const dir1 = [Math.sign(b[0] - a[0]), Math.sign(b[1] - a[1])];
            const dir2 = [Math.sign(c[0] - b[0]), Math.sign(c[1] - b[1])];
            if (dir1[0] === dir2[0] && dir1[1] === dir2[1])
                continue;
            simplified.push(b);
        }
        const lastPoint = points[points.length - 1];
        if (lastPoint !== undefined)
            simplified.push(lastPoint);
        for (let i = 1; i < simplified.length; i += 1) {
            const a = simplified[i - 1];
            const b = simplified[i];
            if (a === undefined || b === undefined)
                continue;
            segments.push({ net: fromPad.net, layer: "F.Cu", widthMm, x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
        }
        for (let i = 1; i < simplified.length; i += 1) {
            const a = simplified[i - 1];
            const b = simplified[i];
            if (a === undefined || b === undefined)
                continue;
            markLine(grid, a[0], a[1], b[0], b[1], widthCells * grid.res * 0.5);
        }
        void cos;
    }
    return { segments, failed, reason: lastReason };
}
function pointSegmentDistance(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0)
        return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / lengthSquared;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
/**
 * 落盘前的自检：逐段采样，碰到别的网络（间距不够）就丢掉这一段。
 * 栅格布线只保证「格子级别」不撞，实际几何仍可能压线，这一步把明显错的拦下来。
 */
export function validateSegments(geometry, segments, clearanceMm) {
    const obstacles = [];
    for (const pad of geometry.pads) {
        obstacles.push({ net: pad.net, x1: pad.x, y1: pad.y, x2: pad.x, y2: pad.y, radius: Math.hypot(pad.width, pad.height) / 2 });
    }
    for (const track of geometry.tracks) {
        obstacles.push({ net: track.net, x1: track.x1, y1: track.y1, x2: track.x2, y2: track.y2, radius: track.width / 2 });
    }
    const accepted = [];
    const rejected = [];
    for (const segment of segments) {
        const length = Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
        const steps = Math.max(2, Math.ceil(length / 0.1));
        let bad = false;
        for (const obstacle of obstacles) {
            if (obstacle.net === segment.net)
                continue;
            const allowed = obstacle.radius + segment.widthMm / 2 + clearanceMm;
            for (let step = 0; step <= steps; step += 1) {
                const ratio = step / steps;
                const px = segment.x1 + (segment.x2 - segment.x1) * ratio;
                const py = segment.y1 + (segment.y2 - segment.y1) * ratio;
                if (pointSegmentDistance(px, py, obstacle.x1, obstacle.y1, obstacle.x2, obstacle.y2) < allowed) {
                    bad = true;
                    break;
                }
            }
            if (bad)
                break;
        }
        if (bad) {
            rejected.push(segment);
            continue;
        }
        accepted.push(segment);
        obstacles.push({ net: segment.net, x1: segment.x1, y1: segment.y1, x2: segment.x2, y2: segment.y2, radius: segment.widthMm / 2 });
    }
    return { accepted, rejected };
}
export function planRouting(geometry, options = {}) {
    const empty = {
        ok: false, error: "", segments: [], nets: [], unrouted: [],
        grid: { cols: 0, rows: 0, resolutionMm: options.resolutionMm ?? 0.5 }, notes: [],
    };
    if (!geometry.ok)
        return { ...empty, error: geometry.error };
    const resolution = Math.max(0.15, options.resolutionMm ?? 0.25);
    const clearance = options.clearanceMm ?? 0.2;
    const powerWidth = options.powerWidthMm ?? 0.5;
    const signalWidth = options.signalWidthMm ?? 0.25;
    const margin = 1;
    const cols = Math.ceil(geometry.widthMm / resolution) + 2 * margin;
    const rows = Math.ceil(geometry.heightMm / resolution) + 2 * margin;
    const committed = [];
    const buildGrid = (excludeNet) => {
        const grid = {
            cols, rows, res: resolution,
            x0: geometry.x0 - margin * resolution,
            y0: geometry.y0 - margin * resolution,
            blocked: new Uint8Array(cols * rows),
        };
        for (let row = 0; row < rows; row += 1) {
            for (let col = 0; col < cols; col += 1) {
                const x = grid.x0 + col * resolution;
                const y = grid.y0 + row * resolution;
                const outside = x < geometry.x0 - 0.5 || y < geometry.y0 - 0.5
                    || x > geometry.x0 + geometry.widthMm + 0.5 || y > geometry.y0 + geometry.heightMm + 0.5;
                if (outside)
                    grid.blocked[index(grid, col, row)] = 1;
            }
        }
        for (const pad of geometry.pads) {
            if (pad.net === excludeNet)
                continue;
            // 按对角线半径膨胀：矩形焊盘的角比外接圆更远，用外接圆会留出「绕角」的假通道。
            const radius = Math.hypot(pad.width, pad.height) / 2 + clearance + resolution * 0.5;
            markDisc(grid, pad.x, pad.y, radius);
        }
        for (const track of geometry.tracks) {
            markLine(grid, track.x1, track.y1, track.x2, track.y2, track.width / 2 + clearance);
        }
        for (const track of committed) {
            markLine(grid, track.x1, track.y1, track.x2, track.y2, track.widthMm / 2 + clearance);
        }
        return grid;
    };
    const byNet = new Map();
    for (const pad of geometry.pads) {
        if (pad.net === "")
            continue;
        const list = byNet.get(pad.net) ?? [];
        list.push(pad);
        byNet.set(pad.net, list);
    }
    const nets = [...byNet.entries()]
        .filter(([net, pads]) => pads.length > 1 && padRoutable(net, options))
        .sort((a, b) => (isPowerNet(b[0]) ? 1 : 0) - (isPowerNet(a[0]) ? 1 : 0) || b[1].length - a[1].length);
    const segments = [];
    const reports = [];
    const unrouted = [];
    const notes = [];
    for (const [net, pads] of nets) {
        const capped = pads.slice(0, options.maxPadsPerNet ?? 24);
        if (capped.length < pads.length)
            notes.push(net + "：只布前 " + String(capped.length) + " 个焊盘");
        const grid = buildGrid(net);
        const width = isPowerNet(net) ? powerWidth : signalWidth;
        const routed = routeNet(grid, capped, width, { clearanceMm: clearance, viaCostMm: options.viaCostMm ?? 20, turnCostMm: options.turnCostMm ?? 2 });
        segments.push(...routed.segments);
        committed.push(...routed.segments);
        reports.push({ net, pads: capped.length, segments: routed.segments.length, connected: !routed.failed, reason: routed.failed ? (routed.reason === "" ? "有焊盘没能连通（障碍太密）" : routed.reason) : "" });
        if (routed.failed)
            unrouted.push(net);
    }
    const checked = validateSegments(geometry, segments, clearance);
    if (checked.rejected.length > 0) {
        notes.push("落盘前自检丢掉 " + String(checked.rejected.length) + " 段（与别的网络间距不足）");
        for (const report of reports) {
            const alive = checked.accepted.filter((segment) => segment.net === report.net).length;
            report.segments = alive;
            if (alive === 0 && report.connected) {
                report.connected = false;
                report.reason = "布线结果全部被自检拦下";
            }
        }
    }
    return {
        ok: true, error: "", segments: checked.accepted, nets: reports, unrouted,
        grid: { cols, rows, resolutionMm: resolution }, notes,
    };
}
function padRoutable(net, options) {
    if (options.onlyPower === true && !isPowerNet(net))
        return false;
    return true;
}
