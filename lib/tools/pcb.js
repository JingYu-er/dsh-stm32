/**
 * PCB 放置工具（S139）：把算好的落位写进 .kicad_pcb。
 *
 * 只做一件事：读 circuit.json 算落位 → 调 KiCad 自带 python 搬元件存盘。
 * 布线、铺铜、检查都在后面的工具里，这里不越界。
 */
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { runCapture } from "../engine/subprocess-runner.js";
import { locateEcadToolchain } from "../engine/ecad/toolchain.js";
import { planEcadWorkspace } from "../engine/ecad/tsci.js";
import { readCircuitNetlist } from "../engine/ecad/pcb/netlist.js";
import { planPlacement } from "../engine/ecad/pcb/placement.js";
import { buildApplyScript, parseApplyOutput } from "../engine/ecad/pcb/apply.js";
import { buildGeometryScript, parseGeometry } from "../engine/ecad/pcb/geometry.js";
import { planRouting } from "../engine/ecad/pcb/router.js";
import { buildTrackScript, parseTrackReport } from "../engine/ecad/pcb/tracks.js";
import { readBoardBox } from "../engine/ecad/dfm.js";
import { resolveProjectDir } from "./project-dir.js";
export const PCB_PLACE_TOOL = "stm32_pcb_place";
export const PCB_ROUTE_TOOL = "stm32_pcb_route";
const output = {
    type: "object",
    additionalProperties: false,
    properties: {
        ok: { type: "boolean" },
        error: { type: "string" },
        boardFile: { type: "string" },
        moved: { type: "number" },
        missing: { type: "array", items: { type: "string" } },
        removedTracks: { type: "number" },
        parts: { type: "number" },
        boardWidth: { type: "number" },
        boardHeight: { type: "number" },
        notes: { type: "array", items: { type: "string" } },
    },
    required: ["ok", "error", "boardFile", "moved", "missing", "removedTracks", "parts", "boardWidth", "boardHeight", "notes"],
};
function newestFile(dir, pattern, depth = 3) {
    if (!existsSync(dir))
        return "";
    let best = "";
    let bestTime = -1;
    const walk = (current, level) => {
        if (level > depth)
            return;
        let entries;
        try {
            entries = readdirSync(current);
        }
        catch {
            return;
        }
        for (const name of entries) {
            const full = join(current, name);
            let stat;
            try {
                stat = statSync(full);
            }
            catch {
                continue;
            }
            if (stat.isDirectory()) {
                if (name === "node_modules" || name === ".history")
                    continue;
                walk(full, level + 1);
                continue;
            }
            if (!pattern.test(name))
                continue;
            if (stat.mtimeMs > bestTime) {
                bestTime = stat.mtimeMs;
                best = full;
            }
        }
    };
    walk(dir, 0);
    return best;
}
export function registerPcbTools(ctx) {
    const tool = {
        name: PCB_PLACE_TOOL,
        description: "按 circuit.json 的网表与元件尺寸计算落位，再调 KiCad 自带 python 把元件搬进 .kicad_pcb；默认清掉旧走线（重新放置后它们已失效）。只放置，不布线、不铺铜。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                projectDir: { type: "string", description: "工程根目录；缺省为会话工作目录。" },
                boardFile: { type: "string", description: "指定要改的 .kicad_pcb；缺省取 hardware/kicad 下最新的一份。" },
                keepTracks: { type: "boolean", description: "保留既有走线（默认 false：重新放置会清掉）。" },
            },
            required: [],
        },
        output: {
            schema: output,
            render: (_args, value) => {
                const result = value;
                if (!result.ok)
                    return [{ type: "text", text: "放置未执行：" + result.error }];
                const lines = [
                    "放置完成：搬了 " + String(result.moved) + " / " + String(result.parts) + " 个元件，板框 " + String(result.boardWidth) + "×" + String(result.boardHeight) + " mm",
                    "板文件：" + result.boardFile,
                    "清掉的旧走线：" + String(result.removedTracks) + " 条",
                ];
                if (result.missing.length > 0)
                    lines.push("板上找不到的位号：" + result.missing.join("、"));
                for (const note of result.notes)
                    lines.push("说明：" + note);
                return [{ type: "text", text: lines.join("\n") }];
            },
        },
        timeoutMs: 120_000,
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const empty = { ok: false, error: "", boardFile: "", moved: 0, missing: [], removedTracks: 0, parts: 0, boardWidth: 0, boardHeight: 0, notes: [] };
            const resolved = await resolveProjectDir(ctx, args.projectDir, exec);
            if (resolved.projectDir === "")
                return { ...empty, error: "projectDir 不能为空：从工具栏「工程」下拉里选一个，或先打开调试会话" };
            const located = locateEcadToolchain();
            if (located.toolchain === null)
                return { ...empty, error: located.error };
            const workspace = planEcadWorkspace(resolved.projectDir, join(resolved.projectDir, "hardware"));
            const circuitFile = newestFile(workspace.circuitDir, /^circuit\.json$/u);
            if (circuitFile === "")
                return { ...empty, error: "还没有 circuit.json：先跑一次 stm32_ecad_build" };
            const model = readCircuitNetlist(readFileSync(circuitFile, "utf8"));
            if (!model.ok)
                return { ...empty, error: model.error };
            const boardFile = args.boardFile !== undefined && args.boardFile !== "" ? args.boardFile : newestFile(workspace.kicadDir, /\.kicad_pcb$/u);
            if (boardFile === "" || !existsSync(boardFile))
                return { ...empty, error: "还没有 .kicad_pcb：先跑一次构建，或传 boardFile 指定板子" };
            // 板框以 KiCad 画的那块为准：circuit.json 里的尺寸可能与实际板框不一致。
            const box = readBoardBox(readFileSync(boardFile, "utf8"));
            const plan = planPlacement(model, box === null ? {} : { widthMm: box.x1 - box.x0, heightMm: box.y1 - box.y0 });
            if (!plan.ok)
                return { ...empty, error: plan.error };
            // 落位按「板子左上角为 0」算，写板前要平移到板框原点，否则元件会落到板外。
            if (box !== null) {
                for (const item of plan.items) {
                    item.x = Math.round((item.x + box.x0) * 1000) / 1000;
                    item.y = Math.round((item.y + box.y0) * 1000) / 1000;
                }
            }
            else {
                plan.notes.push("板上没有 Edge.Cuts 板框：按原点 0,0 落位，可能落在板外");
            }
            copyFileSync(boardFile, boardFile + ".bak");
            const script = buildApplyScript({ plan, boardFile, keepTracks: args.keepTracks === true });
            const scriptFile = join(tmpdir(), "dsh-stm32-place-" + String(Date.now()) + ".py");
            writeFileSync(scriptFile, script, "utf8");
            const payload = JSON.stringify({ boardFile, keepTracks: args.keepTracks === true, items: plan.items, board: plan.board });
            const resultFile = join(tmpdir(), "dsh-stm32-place-" + String(Date.now()) + ".json");
            const run = await runCapture(ctx.subprocess, {
                argv: [located.toolchain.python, scriptFile, payload, resultFile],
                cwd: dirname(boardFile),
                env: located.toolchain.env,
                timeoutMs: 90_000,
                maxBytes: 256_000,
                signal: exec.signal,
            });
            if (run.exitCode !== 0) {
                return { ...empty, boardFile, error: "KiCad python 执行失败：" + (run.stderr === "" ? run.stdout : run.stderr).slice(-400) };
            }
            const parsedText = existsSync(resultFile) ? readFileSync(resultFile, "utf8") : "";
            const parsed = parseApplyOutput(parsedText);
            if (!parsed.ok)
                return { ...empty, boardFile, error: "没读到放置结果：脚本没有写出结果文件（板子可能已被锁定或路径不可写）" };
            const notes = [...model.notes, ...plan.notes];
            if (parsed.missing.length > 0)
                notes.push("板上没有这些位号：多半是构建产物与 circuit.json 不同步，重跑构建后再放置");
            return {
                ok: true,
                error: "",
                boardFile,
                moved: parsed.moved,
                missing: parsed.missing,
                removedTracks: parsed.removedTracks,
                parts: plan.items.length,
                boardWidth: plan.board.width,
                boardHeight: plan.board.height,
                notes,
            };
        },
    };
    ctx.tools.register(tool);
    const routeTool = {
        name: PCB_ROUTE_TOOL,
        description: "在已放置的板上布电源与地：按网络把焊盘用最近邻链连起来（F.Cu，0.5 mm），并尝试补一块 GND 铺铜区后填充；不处理信号线。默认保留既有走线。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                projectDir: { type: "string", description: "工程根目录；缺省为会话工作目录。" },
                boardFile: { type: "string", description: "显式指定 .kicad_pcb；缺省取最近一次构建产物。" },
                keepTracks: { type: "boolean", description: "保留板上的既有走线；默认清掉（重新布线前它们多半已失效）。" },
                nets: { type: "array", items: { type: "string" }, description: "要布的网络名；缺省用 GND/VCC/3V3/5V/VBUS 这些常见电源网。" },
                apply: { type: "boolean", description: "真的写进板子；默认只预览（先算段数与走向，不改文件）。" },
            },
            required: [],
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    ok: { type: "boolean" },
                    error: { type: "string" },
                    boardFile: { type: "string" },
                    tracks: { type: "number" },
                    vias: { type: "number" },
                    nets: { type: "array", items: { type: "object", additionalProperties: false, properties: { net: { type: "string" }, pads: { type: "number" }, segments: { type: "number" } }, required: ["net", "pads", "segments"] } },
                    plane: { type: "string" },
                    notes: { type: "array", items: { type: "string" } },
                },
                required: ["ok", "error", "boardFile", "tracks", "vias", "nets", "plane", "notes"],
            },
            render: (_args, value) => {
                const result = value;
                if (!result.ok)
                    return [{ type: "text", text: "布线未执行：" + result.error }];
                const lines = ["已布 " + String(result.tracks) + " 段电源与地，过孔 " + String(result.vias) + " 个"];
                for (const item of result.nets)
                    lines.push("- " + item.net + "：" + String(item.segments) + " 段");
                lines.push(result.plane === "" ? "铺铜：未写入（见提示）" : "铺铜：" + result.plane);
                for (const note of result.notes)
                    lines.push("· " + note);
                return [{ type: "text", text: lines.join("\n") }];
            },
        },
        timeoutMs: 180_000,
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const empty = { ok: false, error: "", boardFile: "", tracks: 0, vias: 0, nets: [], plane: "", notes: [] };
            const resolved = await resolveProjectDir(ctx, args.projectDir, exec);
            if (resolved.projectDir === "")
                return { ...empty, error: "projectDir 不能为空：从工具栏「工程」下拉里选一个，或先打开调试会话" };
            const located = locateEcadToolchain();
            if (located.toolchain === null)
                return { ...empty, error: located.error };
            const workspace = planEcadWorkspace(resolved.projectDir, join(resolved.projectDir, "hardware"));
            const boardFile = args.boardFile !== undefined && args.boardFile !== ""
                ? args.boardFile
                : newestFile(workspace.kicadDir, /\.kicad_pcb$/u);
            if (boardFile === "" || !existsSync(boardFile))
                return { ...empty, error: "还没有可用的 .kicad_pcb：先跑 stm32_ecad_build 或 stm32_pcb_place" };
            const notes = [];
            const geometryScript = join(tmpdir(), "dsh-stm32-geo-" + String(Date.now()) + ".py");
            writeFileSync(geometryScript, buildGeometryScript(boardFile), "utf8");
            const geoRun = await runCapture(ctx.subprocess, {
                argv: [located.toolchain.python, geometryScript],
                cwd: resolved.projectDir,
                timeoutMs: 60_000,
                maxBytes: 64 << 20,
                signal: exec.signal,
            });
            if (geoRun.exitCode !== 0)
                return { ...empty, boardFile, error: "读取板子几何失败：" + (geoRun.stderr === "" ? geoRun.stdout : geoRun.stderr).slice(-300) };
            const geometry = parseGeometry(geoRun.stdout);
            if (!geometry.ok)
                return { ...empty, boardFile, error: geometry.error };
            const wanted = args.nets ?? [];
            const plan = planRouting(geometry, {
                resolutionMm: 0.25,
                onlyPower: wanted.length === 0,
                maxPadsPerNet: 24,
                singleLayer: args.singleLayer === true,
            });
            if (!plan.ok)
                return { ...empty, boardFile, error: plan.error };
            const keep = wanted.length === 0 ? plan.segments : plan.segments.filter((segment) => wanted.includes(segment.net));
            const keepVias = wanted.length === 0 ? plan.vias : plan.vias.filter((via) => wanted.includes(via.net));
            if (args.apply === true && keep.length > 0) {
                copyFileSync(boardFile, boardFile + ".bak");
                const trackScript = join(tmpdir(), "dsh-stm32-tracks-" + String(Date.now()) + ".py");
                writeFileSync(trackScript, buildTrackScript(boardFile, keep, false, keepVias), "utf8");
                const trackResult = join(tmpdir(), "dsh-stm32-tracks-" + String(Date.now()) + ".json");
                const trackPayload = join(tmpdir(), "dsh-stm32-tracks-" + String(Date.now()) + ".payload.json");
                writeFileSync(trackPayload, JSON.stringify({ boardFile, segments: keep, vias: keepVias, dryRun: false }), "utf8");
                const trackRun = await runCapture(ctx.subprocess, {
                    argv: [located.toolchain.python, trackScript, trackPayload, trackResult],
                    cwd: resolved.projectDir,
                    timeoutMs: 120_000,
                    maxBytes: 1 << 20,
                    signal: exec.signal,
                });
                if (trackRun.exitCode !== 0)
                    return { ...empty, boardFile, error: "写走线失败：" + (trackRun.stderr === "" ? trackRun.stdout : trackRun.stderr).slice(-300) };
                const report = parseTrackReport(existsSync(trackResult) ? readFileSync(trackResult, "utf8") : "");
                if (!report.ok)
                    return { ...empty, boardFile, error: report.error };
                notes.push("已写入 " + String(report.added) + " 段走线、" + String(report.vias) + " 个过孔（原文件留 .bak）");
                notes.push("写完请跑 stm32_ecad_check：栅格布线仍有短接风险，必须过 DRC 才算数");
            }
            else {
                notes.push("预览模式：只算路径不写板；确认无误后传 apply: true");
            }
            for (const item of plan.notes)
                notes.push(item);
            const nets = plan.nets.map((item) => ({ net: item.net, pads: item.pads, segments: item.segments }));
            return {
                ok: true,
                error: "",
                boardFile,
                tracks: keep.length,
                vias: keepVias.length,
                nets,
                plane: "",
                notes: [...notes, ...(plan.unrouted.length > 0 ? ["未布通：" + plan.unrouted.join("、")] : [])],
            };
        },
    };
    ctx.tools.register(routeTool);
}
