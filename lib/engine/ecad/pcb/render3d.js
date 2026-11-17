/**
 * 3D 预览（S180）：用 `kicad-cli pcb render` 把板子渲成 PNG，并顺带体检封装引用的 3D 模型。
 *
 * 为什么用官方渲染器：KiCad 自己就是唯一事实源——焊盘、丝印、器件高度、模型变换全在它手里，
 * 自研一个「看起来像 3D」的东西只会和真实观感越差越远。渲染器不认的模型会静默留空，
 * 所以这一步同时把「哪个位号缺模型」列出来，避免把空壳当成没问题。
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parenBlocks } from "./emc.js";
export const EMPTY_RENDER3D = {
    ok: false,
    error: "",
    file: "",
    bytes: 0,
    side: "top",
    width: 0,
    height: 0,
    models: [],
    missing: [],
    notes: [],
};
/** 封装里引用的 3D 模型路径；一个封装可能有多条，全部收下。 */
export function modelPathsOf(block) {
    const out = [];
    const pattern = /\(model\s+"([^"]+)"/gu;
    for (let match = pattern.exec(block); match !== null; match = pattern.exec(block)) {
        const path = match[1];
        if (path !== undefined && path !== "")
            out.push(path);
    }
    return out;
}
/** `${KICADnn_3DMODEL_DIR}`、`${KISYS3DMOD}`、`${KIPRJMOD}` 展开成实际路径。 */
export function resolveModelFile(path, boardDir, model3dDir) {
    return path
        .replace(/^\$\{(?:KICAD\d+_3DMODEL_DIR|KISYS3DMOD)\}/u, model3dDir.replace(/\\/gu, "/"))
        .replace(/^\$\{KIPRJMOD\}/u, boardDir.replace(/\\/gu, "/"))
        .replace(/\\/gu, "/");
}
/** 从板子里收集每个位号引用的模型，并标出缺文件的项。 */
export function collectBoardModels(boardText, boardFile, model3dDir = "") {
    const boardDir = dirname(boardFile);
    const models = [];
    const missing = [];
    const notes = [];
    for (const block of parenBlocks(boardText, "footprint")) {
        const refMatch = /\(property\s+"Reference"\s+"([^"]*)"/u.exec(block);
        const ref = refMatch === null ? "" : (refMatch[1] ?? "");
        for (const path of modelPathsOf(block)) {
            const file = resolveModelFile(path, boardDir, model3dDir);
            const exists = existsSync(file);
            const bytes = exists ? statSync(file).size : 0;
            models.push({ ref, file, exists, bytes });
            if (!exists)
                missing.push((ref === "" ? "(无位号)" : ref) + "：" + file);
        }
    }
    if (models.length === 0)
        notes.push("板子里没有任何封装引用 3D 模型：3D 视图里只会看到基板与焊盘。");
    if (missing.length > 0)
        notes.push("有 " + String(missing.length) + " 个模型文件不存在：渲染器会跳过它们，对应器件在 3D 里是空的。");
    return { boardFile, models, missing, notes };
}
function argOf(options, boardFile) {
    const side = options.side ?? "top";
    const width = Math.max(160, Math.min(3200, Math.round(options.width ?? 1200)));
    const height = Math.max(120, Math.min(2400, Math.round(options.height ?? 900)));
    const out = options.output !== undefined && options.output !== ""
        ? options.output
        : join(dirname(boardFile), "..", "out", "board-3d-" + side + ".png");
    const argv = [
        "pcb",
        "render",
        "--output",
        out,
        "--side",
        side,
        "--width",
        String(width),
        "--height",
        String(height),
        "--quality",
        options.quality ?? "basic",
        "--background",
        options.background ?? "opaque",
    ];
    if (options.perspective === true)
        argv.push("--perspective");
    if (options.zoom !== undefined && Number.isFinite(options.zoom))
        argv.push("--zoom", String(options.zoom));
    if (options.rotate !== undefined && options.rotate !== "")
        argv.push("--rotate", options.rotate);
    argv.push(boardFile);
    return { argv, out, width, height, side };
}
/** 渲一张 3D 预览图。调用方负责把 `boardFile` 取成绝对路径。 */
export async function renderBoard3d(deps, boardFile, options = {}) {
    if (!existsSync(boardFile))
        return { ...EMPTY_RENDER3D, error: "板子不存在：" + boardFile };
    const boardText = readFileSync(boardFile, "utf8");
    const report = collectBoardModels(boardText, boardFile, deps.model3dDir);
    const { argv, out, width, height, side } = argOf(options, boardFile);
    const started = Date.now();
    const run = await deps.run([deps.kicadCli, ...argv], 240_000);
    if (run.exitCode !== 0) {
        const detail = (run.stderr.trim() !== "" ? run.stderr : run.stdout).trim().split(/\r?\n/u).slice(-4).join(" / ");
        return {
            ...EMPTY_RENDER3D,
            error: "3D 渲染失败（退出码 " + String(run.exitCode) + "）：" + detail,
            models: report.models,
            missing: report.missing,
            notes: report.notes,
        };
    }
    const bytes = existsSync(out) ? statSync(out).size : 0;
    const notes = [...report.notes];
    if (bytes === 0)
        notes.push("渲染命令退出 0，但没有生成图片：检查输出目录是否可写（" + dirname(out) + "）。");
    notes.push("渲染耗时 " + String(Date.now() - started) + " ms（首次要加载全部 3D 模型，通常 5–10 s）。");
    return {
        ok: bytes > 0,
        error: "",
        file: out,
        bytes,
        side,
        width,
        height,
        models: report.models,
        missing: report.missing,
        notes,
    };
}
/** 读渲染出的图片前 N 字节判断是不是 PNG（渲染器偶尔会在失败时留下空文件）。 */
export function pngHeaderOf(file) {
    if (!existsSync(file))
        return false;
    const fd = openSync(file, "r");
    try {
        const buffer = Buffer.alloc(8);
        readSync(fd, buffer, 0, 8, 0);
        return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
    }
    finally {
        closeSync(fd);
    }
}
/** 给面板用的文件名：`board-3d-top.png` → `board-3d-top`。 */
export function renderNameOf(file) {
    return basename(file).replace(/\.(?:png|jpe?g)$/u, "");
}
