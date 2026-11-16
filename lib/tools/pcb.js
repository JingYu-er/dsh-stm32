/**
 * PCB 放置工具（S139）：把算好的落位写进 .kicad_pcb。
 *
 * 只做一件事：读 circuit.json 算落位 → 调 KiCad 自带 python 搬元件存盘。
 * 布线、铺铜、检查都在后面的工具里，这里不越界。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runCapture } from "../engine/subprocess-runner.js";
import { locateEcadToolchain } from "../engine/ecad/toolchain.js";
import { connectPcbIpc } from "../engine/ecad/pcb/ipc.js";
import { findLatestKicadBuild, planEcadWorkspace } from "../engine/ecad/tsci.js";
import { readCircuitNetlist } from "../engine/ecad/pcb/netlist.js";
import { planPlacement } from "../engine/ecad/pcb/placement.js";
import { countCopperLayers, ensureDesignRules } from "../engine/ecad/pcb/rules.js";
import { buildApplyScript, parseApplyOutput } from "../engine/ecad/pcb/apply.js";
import { buildGeometryScript, parseGeometry } from "../engine/ecad/pcb/geometry.js";
import { planRouting } from "../engine/ecad/pcb/router.js";
import { buildTrackScript, parseTrackReport } from "../engine/ecad/pcb/tracks.js";
import { readBoardBox } from "../engine/ecad/dfm.js";
import { resolveProjectDir } from "./project-dir.js";
import { krtRoot, krtStatus, krtVersion, quoteLayerNames, runKrtAutoroute, runKrtConnectedCheck } from "../engine/ecad/pcb/krt.js";
import { readPcbScene } from "../engine/ecad/pcb/scene.js";
import { renderPcbSvg } from "../engine/ecad/pcb/pcb-svg.js";
import { runPcbIpc } from "../engine/ecad/pcb/ipc.js";
import { applyQuotes, readBom, renderBomCsv, renderBomMarkdown } from "../engine/ecad/bom.js";
import { ensurePrices, priceCachePath, readPriceCache } from "../engine/datasheet/price.js";
import { analyzeStackup, DEFAULT_TARGETS } from "../engine/ecad/pcb/stackup.js";
export const PCB_PLACE_TOOL = "stm32_pcb_place";
export const PCB_ROUTE_TOOL = "stm32_pcb_route";
export const PCB_AUTOROUTE_TOOL = "stm32_pcb_autoroute";
export const PCB_IPC_TOOL = "stm32_pcb_ipc";
export const PCB_RENDER_TOOL = "stm32_pcb_render";
export const PCB_BOM_TOOL = "stm32_bom";
export const PCB_STACKUP_TOOL = "stm32_stackup";
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
const autorouteOutput = {
    type: "object",
    additionalProperties: false,
    properties: {
        ok: { type: "boolean" },
        error: { type: "string" },
        dryRun: { type: "boolean" },
        boardFile: { type: "string" },
        output: { type: "string" },
        engine: { type: "string" },
        seconds: { type: "number" },
        openNets: { type: "number", description: "未连接网络数；-1 表示引擎没报" },
        steps: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                properties: { tag: { type: "string" }, what: { type: "string" }, why: { type: "string" }, optional: { type: "boolean" } },
                required: ["tag", "what", "why", "optional"],
            },
        },
        warnings: { type: "array", items: { type: "string" } },
        notes: { type: "array", items: { type: "string" } },
    },
    required: ["ok", "error", "dryRun", "boardFile", "output", "engine", "seconds", "openNets", "steps", "warnings", "notes"],
};
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
        description: "实验性的自研布线器：在已放置的板上按网络把焊盘用最近邻链连起来并尝试补 GND 铺铜。已被 stm32_pcb_autoroute 取代，保留用于对照与无引擎时的兜底。",
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
    const autorouteTool = {
        name: PCB_AUTOROUTE_TOOL,
        description: "用 KiCadRoutingTools（Rust 网格布线器）给已放置的板布线：铺平面、QFN/BGA 扇出、差分与等长、逐网布线，并回报未连接数。默认只出计划不写板。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                projectDir: { type: "string", description: "工程根目录；缺省为会话工作目录。" },
                boardFile: { type: "string", description: "指定 .kicad_pcb；缺省取 hardware/kicad 下最新的一份。" },
                dryRun: { type: "boolean", description: "只出计划、不写板；默认 true。" },
                normalize: { type: "boolean", description: "先给层名补引号（tscircuit 导出的板子需要）；默认 true。" },
                apply: { type: "boolean", description: "把布好的板子写回原文件（先备份 .bak）；默认 false 只写到 <板名>.auto.kicad_pcb。" },
            },
            required: [],
        },
        output: {
            schema: autorouteOutput,
            render: (_args, value) => {
                const result = value;
                if (!result.ok)
                    return [{ type: "text", text: "布线未完成：" + result.error }];
                const lines = [];
                lines.push((result.dryRun ? "布线计划" : "布线完成") + "：" + result.engine + " · " + String(result.seconds) + " 秒" + (result.openNets < 0 ? "" : " · 未连接 " + String(result.openNets)));
                lines.push("输入板：" + result.boardFile);
                if (result.output !== "")
                    lines.push("输出板：" + result.output);
                for (const step of result.steps)
                    lines.push("- " + step.tag + "：" + step.what + (step.why === "" ? "" : "（" + step.why + "）"));
                for (const note of result.notes)
                    lines.push("说明：" + note);
                for (const warning of result.warnings.slice(0, 5))
                    lines.push("告警：" + warning);
                return [{ type: "text", text: lines.join("\n") }];
            },
        },
        timeoutMs: 1_900_000,
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const empty = { ok: false, error: "", dryRun: args.dryRun !== false, boardFile: "", output: "", engine: "", seconds: 0, openNets: -1, steps: [], warnings: [], notes: [] };
            const resolved = await resolveProjectDir(ctx, args.projectDir, exec);
            if (resolved.projectDir === "")
                return { ...empty, error: "projectDir 不能为空：从工具栏「工程」下拉里选一个，或先打开调试会话" };
            const root = krtRoot();
            const status = krtStatus(root);
            if (!status.ok)
                return { ...empty, error: status.error + "（可用 DSH_STM32_KRT_ROOT 指定目录）" };
            const located = locateEcadToolchain();
            if (located.toolchain === null)
                return { ...empty, error: located.error };
            const workspace = planEcadWorkspace(resolved.projectDir, join(resolved.projectDir, "hardware"));
            const board = args.boardFile !== undefined && args.boardFile !== "" ? args.boardFile : newestFile(workspace.kicadDir, /\.kicad_pcb$/u);
            if (board === "" || !existsSync(board))
                return { ...empty, error: "还没有 .kicad_pcb：先构建，或传 boardFile 指定板子" };
            const notes = [];
            // 布线器从 DSN 读间距与线宽，DSN 又取自网络类；先抬到工艺下限，避免「合规于 0.09、违规于 0.2」（S149）。
            const rules = ensureDesignRules(workspace.kicadDir);
            if (!rules.ok)
                notes.push("设计规则未对齐：" + rules.error);
            else
                notes.push("设计规则按 " + String(countCopperLayers(workspace.kicadDir)) + " 层嘉立创常规档：间距 "
                    + String(rules.floor.clearanceMm) + " mm、线宽 " + String(rules.floor.trackWidthMm) + " mm"
                    + (rules.changed.length === 0 ? "（已是该档）" : "（抬升：" + rules.changed.join("、") + "）"));
            let input = board;
            if (args.normalize !== false) {
                const normalized = quoteLayerNames(readFileSync(board, "utf8"));
                input = board.replace(/\.kicad_pcb$/u, ".norm.kicad_pcb");
                writeFileSync(input, normalized.text);
                if (normalized.quoted > 0)
                    notes.push("层名补引号：" + String(normalized.quoted) + " 处（引擎只认带引号的写法）");
            }
            const outFile = board.replace(/\.kicad_pcb$/u, ".auto.kicad_pcb");
            // 布线器会把设置写回 .kicad_pro，布线后再抬一次，后续 DRC 才按工艺下限判。
            const restoreRules = () => {
                const again = ensureDesignRules(workspace.kicadDir, rules.floor);
                if (again.changed.length > 0)
                    notes.push("布线器重写了网络类，已按同一档再次对齐：" + again.changed.join("、"));
            };
            const report = await runKrtAutoroute({
                subprocess: ctx.subprocess,
                runtime: { root, python: located.toolchain.python },
                inputPcb: input,
                outputPcb: outFile,
                dryRun: args.dryRun !== false,
                signal: exec.signal,
            });
            if (!report.ok)
                return { ...empty, boardFile: board, error: report.error, steps: report.steps, warnings: report.warnings, notes };
            restoreRules();
            let output = report.output;
            if (!report.dryRun) {
                const check = await runKrtConnectedCheck({ subprocess: ctx.subprocess, runtime: { root, python: located.toolchain.python }, pcbFile: outFile, signal: exec.signal });
                notes.push(check.unconnected === null ? "连通性检查未给出数字" : "连通性检查：未连接 " + String(check.unconnected) + " 条");
                if (args.apply === true) {
                    copyFileSync(board, board + ".bak");
                    copyFileSync(outFile, board);
                    output = board;
                    notes.push("已写回原板（备份：" + board + ".bak）");
                }
            }
            return {
                ok: true,
                error: "",
                dryRun: report.dryRun,
                boardFile: board,
                output,
                engine: "KiCadRoutingTools " + krtVersion(root),
                seconds: report.seconds,
                openNets: report.openNets === null ? -1 : report.openNets,
                steps: report.steps,
                warnings: report.warnings,
                notes,
            };
        },
    };
    const renderOutput = {
        type: "object",
        additionalProperties: false,
        properties: {
            ok: { type: "boolean" },
            error: { type: "string" },
            boardFile: { type: "string" },
            savedTo: { type: "string" },
            bytes: { type: "number" },
            widthMm: { type: "number" },
            heightMm: { type: "number" },
            copperLayers: { type: "number" },
            pads: { type: "number" },
            tracks: { type: "number" },
            innerTracks: { type: "number" },
            vias: { type: "number" },
            elements: { type: "number" },
            notes: { type: "array", items: { type: "string" } },
        },
        required: ["ok", "error", "boardFile", "savedTo", "bytes", "widthMm", "heightMm", "copperLayers", "pads", "tracks", "innerTracks", "vias", "elements", "notes"],
    };
    const renderTool = {
        name: PCB_RENDER_TOOL,
        description: "把 .kicad_pcb 画成 SVG 板图：板框、顶层与底层走线、焊盘、过孔、丝印、铺铜。用于回答「板子多大、线有多密、元件摆得开不开」；默认只回尺寸与计数，给 saveAs 才把 SVG 落盘。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                projectDir: { type: "string", description: "工程根目录；缺省为会话工作目录。" },
                boardFile: { type: "string", description: "指定 .kicad_pcb；缺省取 hardware/kicad 下最新的一份。" },
                layers: { type: "string", enum: ["all", "top", "bottom"], description: "画哪几层铜：all（默认）、top 或 bottom。" },
                refs: { type: "boolean", description: "是否在图上标位号；元件密集时会压线，默认 false。" },
                saveAs: { type: "string", description: "把 SVG 写到这个路径（相对路径按工程根解析）；不传则只回计数。" },
            },
            required: [],
        },
        output: {
            schema: renderOutput,
            render: (_args, value) => {
                const result = value;
                if (!result.ok)
                    return [{ type: "text", text: "板图生成失败：" + result.error }];
                const lines = [];
                lines.push("板图：" + String(result.widthMm) + " × " + String(result.heightMm) + " mm · " + String(result.copperLayers) + " 层铜");
                lines.push("焊盘 " + String(result.pads) + " · 走线 " + String(result.tracks) + (result.innerTracks > 0 ? "（内层另有 " + String(result.innerTracks) + " 条不画）" : "") + " · 过孔 " + String(result.vias));
                if (result.savedTo !== "")
                    lines.push("已保存：" + result.savedTo + "（" + String(Math.round(result.bytes / 102.4) / 10) + " KB）");
                else
                    lines.push("SVG 没有落盘：需要文件时给 saveAs。");
                for (const note of result.notes)
                    lines.push("说明：" + note);
                return [{ type: "text", text: lines.join("\n") }];
            },
        },
        timeoutMs: 30_000,
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const empty = { ok: false, error: "", boardFile: "", savedTo: "", bytes: 0, widthMm: 0, heightMm: 0, copperLayers: 0, pads: 0, tracks: 0, innerTracks: 0, vias: 0, elements: 0, notes: [] };
            const resolved = await resolveProjectDir(ctx, args.projectDir, exec);
            if (resolved.projectDir === "")
                return { ...empty, error: "projectDir 不能为空：从工具栏「工程」下拉里选一个，或先打开调试会话" };
            const workspace = planEcadWorkspace(resolved.projectDir, join(resolved.projectDir, "hardware"));
            const board = args.boardFile !== undefined && args.boardFile !== "" ? resolve(resolved.projectDir, args.boardFile) : newestFile(workspace.kicadDir, /\.kicad_pcb$/u);
            if (board === "" || !existsSync(board))
                return { ...empty, error: "还没有 .kicad_pcb：先构建，或传 boardFile 指定板子" };
            const scene = readPcbScene(board);
            if (!scene.ok)
                return { ...empty, error: scene.error };
            const layer = typeof args.layers === "string" ? args.layers : "all";
            const rendered = renderPcbSvg(scene, {
                show: { top: layer !== "bottom", bottom: layer !== "top", pads: true, vias: true, silk: true, edge: true, zones: true, refs: args.refs === true },
            });
            if (!rendered.ok)
                return { ...empty, error: rendered.error, boardFile: board, notes: [...scene.notes] };
            let savedTo = "";
            if (typeof args.saveAs === "string" && args.saveAs !== "") {
                savedTo = resolve(resolved.projectDir, args.saveAs);
                // saveAs 可能带子目录（out/board.svg），缺目录时补上，否则写到一半才报 ENOENT。
                mkdirSync(dirname(savedTo), { recursive: true });
                writeFileSync(savedTo, rendered.svg);
            }
            return {
                ok: true,
                error: "",
                boardFile: board,
                savedTo,
                bytes: rendered.svg.length,
                widthMm: rendered.widthMm,
                heightMm: rendered.heightMm,
                copperLayers: scene.copperLayers,
                pads: rendered.pads,
                tracks: rendered.tracks,
                innerTracks: scene.innerTracks,
                vias: rendered.vias,
                elements: rendered.elements,
                notes: [...scene.notes],
            };
        },
    };
    const ipcOutput = {
        type: "object",
        additionalProperties: false,
        properties: {
            ok: { type: "boolean" },
            error: { type: "string" },
            kind: { type: "string" },
            action: { type: "string" },
            version: { type: "string" },
            boardName: { type: "string" },
            footprints: { type: "number" },
            tracks: { type: "number" },
            vias: { type: "number" },
            zones: { type: "number" },
            nets: { type: "number" },
            applied: { type: "boolean" },
            planned: { type: "string" },
            items: { type: "array", items: { type: "string" } },
            notes: { type: "array", items: { type: "string" } },
        },
        required: ["ok", "error", "kind", "action", "version", "boardName", "footprints", "tracks", "vias", "zones", "nets", "applied", "planned", "items", "notes"],
    };
    const ipcTool = {
        name: PCB_IPC_TOOL,
        description: "在打开的 KiCad PCB 编辑器里做局部编辑：看当前板况、按位号移动元件、布一段线、加过孔、重铺铜、保存。走 KiCad 官方 IPC 接口，作用于编辑器里当前打开的那块板；默认只回计划（apply=false），要真改必须 apply=true 并给出 expectBoard 防改错板。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                action: { type: "string", enum: ["status", "inspect", "move", "route", "via", "refill", "save"], description: "要做什么：status 看板况、inspect 看元件与网络、move 移元件、route 布线、via 加过孔、refill 重铺铜、save 保存。" },
                ref: { type: "string", description: "元件位号（move 必填；inspect 可用它只看一个）。" },
                x: { type: "number", description: "位置 X（mm，move/via 用）。" },
                y: { type: "number", description: "位置 Y（mm，move/via 用）。" },
                net: { type: "string", description: "网络名（route/via 用；不写则不挂网络，KiCad 会当成无网络铜）。" },
                layer: { type: "string", description: "走线所在铜层，例如 F.Cu（route 用，默认 F.Cu）。" },
                width: { type: "number", description: "线宽（mm，route 用，默认 0.25）。" },
                points: { type: "string", description: "折线顶点，写成 \"x1,y1;x2,y2\"（mm，route 必填，至少两个点）。" },
                size: { type: "number", description: "过孔外径（mm，via 用，默认 0.6）。" },
                drill: { type: "number", description: "过孔孔径（mm，via 用，默认 0.3）。" },
                apply: { type: "boolean", description: "false（默认）只回计划；true 才真的动板子。" },
                expectBoard: { type: "string", description: "期望的活动文档名，例如 PCB1.kicad_pcb；对不上就拒绝，避免改错板子。apply=true 时建议总是给。" },
                projectDir: { type: "string", description: "工程根目录（可选；不给就用当前调试会话的工程）。用来找「最近一次构建的板子」。" },
                boardFile: { type: "string", description: "连不上 IPC 时要打开的板子；默认取本工程最近一次构建出的 .kicad_pcb。" },
                open: { type: "boolean", description: "连不上时自动用 pcbnew 打开板子并等它起来（默认 true）。不想被打开就传 false。" },
            },
            required: ["action"],
        },
        output: {
            schema: ipcOutput,
            render: (_args, value) => {
                const result = value;
                if (!result.ok)
                    return [{ type: "text", text: "KiCad IPC 失败：" + (result.kind === "" ? "" : result.kind + "：") + result.error }];
                const lines = [];
                lines.push("KiCad IPC · " + result.action + (result.boardName === "" ? "" : " · " + result.boardName));
                if (result.footprints > 0 || result.tracks > 0)
                    lines.push("元件 " + String(result.footprints) + " · 走线 " + String(result.tracks) + " · 过孔 " + String(result.vias) + " · 铺铜 " + String(result.zones) + " · 网络 " + String(result.nets));
                if (result.planned !== "")
                    lines.push((result.applied ? "已执行：" : "计划（未动板子）：") + result.planned);
                for (const item of result.items)
                    lines.push("· " + item);
                for (const note of result.notes)
                    lines.push("说明：" + note);
                return [{ type: "text", text: lines.join("\n") }];
            },
        },
        timeoutMs: 90_000,
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const empty = { ok: false, error: "", kind: "", action: args.action, version: "", boardName: "", footprints: 0, tracks: 0, vias: 0, zones: 0, nets: 0, applied: false, planned: "", items: [], notes: [] };
            const found = locateEcadToolchain();
            if (!found.ok || found.toolchain === null)
                return { ...empty, error: found.error + "（KiCad IPC 需要 KiCad 自带的 Python 与 kipy）", kind: "FAILED_PRECONDITION" };
            if (args.apply === true && (args.expectBoard === undefined || args.expectBoard === "")) {
                return { ...empty, error: "要真改板子就带上 expectBoard（例如 PCB1.kicad_pcb），否则可能改错文档", kind: "INVALID_ARGUMENT" };
            }
            const resolved = await resolveProjectDir(ctx, args.projectDir, exec);
            let boardFile = args.boardFile !== undefined && args.boardFile !== "" ? args.boardFile : "";
            if (boardFile === "" && resolved.projectDir !== "") {
                const workspace = planEcadWorkspace(resolved.projectDir, join(resolved.projectDir, "hardware"));
                const latest = findLatestKicadBuild(workspace);
                if (latest.ok && latest.pcbFile !== "")
                    boardFile = latest.pcbFile;
            }
            const ipcOptions = { subprocess: ctx.subprocess, python: found.toolchain.python, kicadRoot: found.toolchain.root, env: process.env };
            const connected = await connectPcbIpc({ ...ipcOptions, autoOpen: args.open !== false, boardFile });
            if (!connected.status.ok) {
                return { ...empty, error: connected.status.error, kind: connected.status.kind, notes: connected.notes.concat(["脚本：" + connected.status.script]) };
            }
            if (args.action === "status") {
                const data = connected.status.data;
                const counts = data.board?.counts ?? {};
                return { ...empty, ok: true, version: data.version ?? "", boardName: data.board?.name ?? "", footprints: counts["footprints"] ?? 0, tracks: counts["tracks"] ?? 0, vias: counts["vias"] ?? 0, zones: counts["zones"] ?? 0, nets: counts["nets"] ?? 0, notes: connected.notes };
            }
            const result = await runPcbIpc(ipcOptions, {
                action: args.action,
                ref: args.ref,
                x: args.x,
                y: args.y,
                net: args.net,
                layer: args.layer,
                width: args.width,
                points: args.points,
                size: args.size,
                drill: args.drill,
                apply: args.apply === true,
                expectBoard: args.expectBoard,
            });
            if (!result.ok)
                return { ...empty, error: result.error, kind: result.kind, notes: connected.notes.concat(["脚本：" + result.script]) };
            const data = result.data;
            const counts = data.board?.counts ?? {};
            const items = [];
            if (Array.isArray(data.selection))
                for (const item of data.selection.slice(0, 12))
                    items.push("已选中：" + item);
            if (Array.isArray(data.footprints))
                for (const fp of data.footprints.slice(0, 12))
                    items.push(JSON.stringify(fp));
            const planned = data.planned === undefined ? "" : JSON.stringify(data.planned);
            return {
                ...empty,
                ok: true,
                version: data.version ?? "",
                boardName: data.board?.name ?? "",
                footprints: counts["footprints"] ?? 0,
                tracks: counts["tracks"] ?? 0,
                vias: counts["vias"] ?? 0,
                zones: counts["zones"] ?? 0,
                nets: counts["nets"] ?? 0,
                applied: data.applied === true,
                planned,
                items,
            };
        },
    };
    const bomOutput = {
        type: "object",
        additionalProperties: false,
        properties: {
            ok: { type: "boolean" },
            error: { type: "string" },
            circuitFile: { type: "string" },
            savedTo: { type: "string" },
            lines: { type: "number" },
            componentCount: { type: "number" },
            priced: { type: "number" },
            pricedComponents: { type: "number" },
            partsUsd: { type: "number" },
            missingLcsc: { type: "number" },
            notes: { type: "array", items: { type: "string" } },
        },
        required: ["ok", "error", "circuitFile", "savedTo", "lines", "componentCount", "priced", "pricedComponents", "partsUsd", "missingLcsc", "notes"],
    };
    const bomTool = {
        name: PCB_BOM_TOOL,
        description: "出 BOM 与元件成本：读 circuit.json 按「主选编号 + 值 + 封装」分组，列位号、数量、立创编号、替代料、单价与小计。价格默认只读本地缓存；prices=true 才联网去立创取（每个编号约 0.8 s，会限流）。format=csv 出嘉立创贴片 BOM 列，给 saveAs 落盘。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                projectDir: { type: "string", description: "工程根目录；缺省为当前调试会话的工程。" },
                format: { type: "string", enum: ["markdown", "csv"], description: "输出格式：markdown（默认，带表格）或 csv（嘉立创贴片 BOM 列）。" },
                prices: { type: "boolean", description: "是否联网补价格；默认 false，只用本地缓存。" },
                saveAs: { type: "string", description: "把表格写到这个路径（相对工程根）；不传只回摘要。" },
            },
            required: [],
        },
        output: {
            schema: bomOutput,
            render: (_args, value) => {
                const result = value;
                if (!result.ok)
                    return [{ type: "text", text: "BOM 生成失败：" + result.error }];
                const lines = [];
                lines.push("BOM：" + String(result.lines) + " 行 / " + String(result.componentCount) + " 个元件 · 元件成本 $" + result.partsUsd.toFixed(4));
                lines.push("有价 " + String(result.priced) + "/" + String(result.lines) + " 行（覆盖 " + String(result.pricedComponents) + " 个元件）" + (result.missingLcsc > 0 ? " · " + String(result.missingLcsc) + " 行没有立创编号" : ""));
                if (result.savedTo !== "")
                    lines.push("已保存：" + result.savedTo);
                for (const note of result.notes)
                    lines.push("说明：" + note);
                return [{ type: "text", text: lines.join("\n") }];
            },
        },
        timeoutMs: 120_000,
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const empty = { ok: false, error: "", circuitFile: "", savedTo: "", lines: 0, componentCount: 0, priced: 0, pricedComponents: 0, partsUsd: 0, missingLcsc: 0, notes: [] };
            const resolved = await resolveProjectDir(ctx, args.projectDir, exec);
            if (resolved.projectDir === "")
                return { ...empty, error: "projectDir 不能为空：从工具栏「工程」下拉里选一个，或先打开调试会话" };
            const workspace = planEcadWorkspace(resolved.projectDir, join(resolved.projectDir, "hardware"));
            const latest = findLatestKicadBuild(workspace);
            if (!latest.ok || latest.kicadDir === "")
                return { ...empty, error: latest.ok ? "还没有构建产物：先跑一次 stm32_ecad_build" : latest.error };
            const circuitFile = join(dirname(latest.kicadDir), "circuit.json");
            const base = readBom(circuitFile);
            if (!base.ok)
                return { ...empty, circuitFile, error: base.error };
            let quotes = readPriceCache(priceCachePath()).quotes;
            const notes = [];
            if (args.prices === true) {
                const lookup = await ensurePrices(base.lines.map((line) => line.lcsc).filter((code) => code !== ""));
                quotes = lookup.quotes;
                if (lookup.fetched.length > 0)
                    notes.push("这次联网取到 " + String(lookup.fetched.length) + " 个编号的报价");
                if (lookup.failed.length > 0)
                    notes.push("没取到报价：" + lookup.failed.slice(0, 6).join("、"));
            }
            const report = applyQuotes(base, quotes);
            let savedTo = "";
            if (typeof args.saveAs === "string" && args.saveAs !== "") {
                savedTo = resolve(resolved.projectDir, args.saveAs);
                mkdirSync(dirname(savedTo), { recursive: true });
                const text = (args.format === "csv" ? renderBomCsv(report) : renderBomMarkdown(report));
                writeFileSync(savedTo, text, "utf8");
            }
            return {
                ok: true,
                error: "",
                circuitFile,
                savedTo,
                lines: report.lines.length,
                componentCount: report.componentCount,
                priced: report.priced,
                pricedComponents: report.pricedComponents,
                partsUsd: report.partsUsd,
                missingLcsc: report.missingLcsc,
                notes: report.notes.concat(notes),
            };
        },
    };
    const stackupOutput = {
        type: "object",
        additionalProperties: false,
        properties: {
            ok: { type: "boolean" },
            error: { type: "string" },
            boardFile: { type: "string" },
            copperLayers: { type: "number" },
            preset: { type: "string" },
            traceWidths: { type: "array", items: { type: "number" } },
            suggestions: {
                type: "array",
                items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        kind: { type: "string" },
                        targetOhm: { type: "number" },
                        widthMm: { type: "number" },
                        spacingMm: { type: "number" },
                        achievedOhm: { type: "number" },
                    },
                    required: ["kind", "targetOhm", "widthMm", "spacingMm", "achievedOhm"],
                },
            },
            notes: { type: "array", items: { type: "string" } },
        },
        required: ["ok", "error", "boardFile", "copperLayers", "preset", "traceWidths", "suggestions", "notes"],
    };
    const stackupTool = {
        name: PCB_STACKUP_TOOL,
        description: "算叠层与阻抗：板子没有叠层定义时按层数取嘉立创常规叠层（2 层 1.6 mm / 4 层 1.6 mm），给 50 Ω 单端、90/100 Ω 差分的线宽，并列出板上实际用到的线宽。工程估算（±10%），要卡准阻抗得让板厂做阻抗报告。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                projectDir: { type: "string", description: "工程根目录；缺省为当前调试会话的工程。" },
                boardFile: { type: "string", description: "指定 .kicad_pcb；缺省取最近一次构建的板子。" },
                spacingMm: { type: "number", description: "差分对的间距（mm），默认 0.2。" },
            },
            required: [],
        },
        output: {
            schema: stackupOutput,
            render: (_args, value) => {
                const result = value;
                if (!result.ok)
                    return [{ type: "text", text: "叠层分析失败：" + result.error }];
                const lines = [];
                lines.push("叠层：" + result.preset + " · " + String(result.copperLayers) + " 层铜");
                const names = { microstrip: "微带线", stripline: "带状线", "differential-microstrip": "差分微带", "differential-stripline": "差分带状线" };
                for (const item of result.suggestions) {
                    lines.push((names[item.kind] ?? item.kind) + " " + String(item.targetOhm) + " Ω → 线宽 " + String(item.widthMm) + " mm" + (item.kind.startsWith("differential") ? "（间距 " + String(item.spacingMm) + " mm）" : "") + "，实际 " + String(item.achievedOhm) + " Ω");
                }
                if (result.traceWidths.length > 0)
                    lines.push("板上现有线宽：" + result.traceWidths.map((w) => String(w) + " mm").join("、"));
                for (const note of result.notes)
                    lines.push("说明：" + note);
                return [{ type: "text", text: lines.join("\n") }];
            },
        },
        timeoutMs: 30_000,
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const empty = { ok: false, error: "", boardFile: "", copperLayers: 0, preset: "", traceWidths: [], suggestions: [], notes: [] };
            const resolved = await resolveProjectDir(ctx, args.projectDir, exec);
            if (resolved.projectDir === "")
                return { ...empty, error: "projectDir 不能为空：从工具栏「工程」下拉里选一个，或先打开调试会话" };
            let boardFile = "";
            if (typeof args.boardFile === "string" && args.boardFile !== "") {
                boardFile = resolve(resolved.projectDir, args.boardFile);
            }
            else {
                const workspace = planEcadWorkspace(resolved.projectDir, join(resolved.projectDir, "hardware"));
                const latest = findLatestKicadBuild(workspace);
                if (!latest.ok || latest.pcbFile === "")
                    return { ...empty, error: latest.ok ? "还没有构建产物：先跑一次 stm32_ecad_build" : latest.error };
                boardFile = latest.pcbFile;
            }
            if (!existsSync(boardFile))
                return { ...empty, boardFile, error: "找不到板子文件：" + boardFile };
            const spacingMm = typeof args.spacingMm === "number" && args.spacingMm > 0 ? args.spacingMm : 0.2;
            const analysis = analyzeStackup(readFileSync(boardFile, "utf8"), boardFile, spacingMm, DEFAULT_TARGETS);
            if (!analysis.ok)
                return { ...empty, boardFile, error: analysis.error };
            return {
                ok: true,
                error: "",
                boardFile: analysis.boardFile,
                copperLayers: analysis.copperLayers,
                preset: analysis.preset.label,
                traceWidths: [...analysis.traceWidths],
                suggestions: analysis.suggestions.map((item) => ({ ...item })),
                notes: [...analysis.notes],
            };
        },
    };
    ctx.tools.register(autorouteTool);
    ctx.tools.register(renderTool);
    ctx.tools.register(ipcTool);
    ctx.tools.register(bomTool);
    ctx.tools.register(stackupTool);
}
