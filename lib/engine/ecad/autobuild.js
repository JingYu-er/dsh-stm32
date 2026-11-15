/**
 * 回合末自动构建（S136）。
 *
 * 目标：你在对话里改完电路源码，回到 KiCad 就能看到最新的原理图与 PCB，不必先想起点按钮。
 * 三条约束换来「不烦人」：
 *   1. 只在源码比产物新、或上次构建失败时才跑；
 *   2. 每回合最多一次，两次之间至少 60 s；
 *   3. 只跑构建 + 检查（ERC/DRC/DFM），不导出 Gerber/STEP——导出是一次性交付动作，留在按钮里。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runEcadDesign } from "./design.js";
import { runtimeReady } from "./runtime.js";
/** 两次自动构建之间的最小间隔：防止连续小改动把机器拖满。 */
export const AUTO_BUILD_MIN_INTERVAL_MS = 60_000;
export function ecadStateFile(projectDir) {
    return join(projectDir, ".dsh-stm32", "ecad-state.json");
}
export function readAutoState(projectDir) {
    const file = ecadStateFile(projectDir);
    if (!existsSync(file))
        return null;
    try {
        const raw = JSON.parse(readFileSync(file, "utf8"));
        return {
            lastAttemptAt: typeof raw.lastAttemptAt === "number" ? raw.lastAttemptAt : 0,
            lastOk: raw.lastOk === true,
            lastError: typeof raw.lastError === "string" ? raw.lastError : "",
            lastDurationMs: typeof raw.lastDurationMs === "number" ? raw.lastDurationMs : 0,
            lastTurn: typeof raw.lastTurn === "string" ? raw.lastTurn : "",
        };
    }
    catch {
        return null;
    }
}
export function writeAutoState(projectDir, state) {
    const file = ecadStateFile(projectDir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2) + "\n", "utf8");
}
const SKIP_DIRS = new Set(["node_modules", "dist", ".history", ".git", "build"]);
/** 目录里最新的修改时间；不存在返回 0。 */
function newestMtime(path, accept, depth = 0) {
    if (depth > 6 || !existsSync(path))
        return 0;
    let stat;
    try {
        stat = statSync(path);
    }
    catch {
        return 0;
    }
    if (stat.isFile())
        return accept("") ? stat.mtimeMs : 0;
    let newest = 0;
    let entries;
    try {
        entries = readdirSync(path, { withFileTypes: true });
    }
    catch {
        return 0;
    }
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name))
                continue;
            newest = Math.max(newest, newestMtime(join(path, entry.name), accept, depth + 1));
            continue;
        }
        if (!entry.isFile())
            continue;
        if (!accept(entry.name))
            continue;
        try {
            newest = Math.max(newest, statSync(join(path, entry.name)).mtimeMs);
        }
        catch {
            // 读不到就跳过：这是启发式判断，不值得中断。
        }
    }
    return newest;
}
const isSourceFile = (name) => name.endsWith(".circuit.tsx") || name.endsWith(".circuit.ts") || name.endsWith(".kicad_mod") || name.endsWith(".kicad_sym");
const isProductFile = (name) => name.endsWith(".kicad_pcb") || name.endsWith(".kicad_sch");
/** 电路源码是否比产物新。产物缺失也算脏（从没成功构建过）。 */
export function circuitDirty(workspace) {
    const sourceMtime = Math.max(newestMtime(workspace.circuitDir, isSourceFile), newestMtime(workspace.libsDir, isSourceFile));
    const productMtime = newestMtime(workspace.kicadDir, isProductFile);
    if (productMtime === 0) {
        return { dirty: sourceMtime > 0, reason: sourceMtime > 0 ? "还没有可用产物" : "没有电路源码", sourceMtime, productMtime };
    }
    if (sourceMtime > productMtime) {
        return { dirty: true, reason: "源码比产物新", sourceMtime, productMtime };
    }
    return { dirty: false, reason: "产物已是最新", sourceMtime, productMtime };
}
/** 是否该跑一次自动构建。纯函数，便于单测覆盖三种拒绝理由。 */
export function decideAutoBuild(input) {
    if (!input.dirty.dirty)
        return { go: false, reason: input.dirty.reason };
    const minInterval = input.minIntervalMs ?? AUTO_BUILD_MIN_INTERVAL_MS;
    const state = input.state;
    if (state !== null) {
        if (state.lastTurn === input.turn && state.lastTurn !== "") {
            return { go: false, reason: "本回合已经构建过" };
        }
        if (input.now - state.lastAttemptAt < minInterval) {
            const wait = Math.ceil((minInterval - (input.now - state.lastAttemptAt)) / 1000);
            return { go: false, reason: "距上次构建不足 " + String(wait) + " s" };
        }
    }
    return { go: true, reason: input.dirty.reason };
}
/**
 * 跑一次回合末自动构建。
 *
 * 运行时还没装时直接跳过——安装 730 MB 必须由用户点一次确认，不能藏在回合结束里。
 */
export async function runAutoBuild(request) {
    const { subprocess, toolchain, workspace } = request;
    const now = request.now ?? Date.now();
    const dirty = circuitDirty(workspace);
    const state = readAutoState(workspace.projectDir);
    const decision = decideAutoBuild({ dirty, state, now, turn: request.turn, minIntervalMs: request.minIntervalMs });
    if (!decision.go)
        return { ran: false, reason: decision.reason, ok: false, error: "", durationMs: 0, design: null };
    if (!existsSync(join(workspace.circuitDir, "node_modules", "tscircuit", "cli.mjs"))) {
        return { ran: false, reason: "依赖还没装：先在一键设计里确认安装共享运行时", ok: false, error: "", durationMs: 0, design: null };
    }
    const started = Date.now();
    const design = await runEcadDesign({
        subprocess,
        toolchain,
        workspace,
        artifacts: false,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const durationMs = Date.now() - started;
    writeAutoState(workspace.projectDir, {
        lastAttemptAt: now,
        lastOk: design.ok,
        lastError: design.error,
        lastDurationMs: durationMs,
        lastTurn: request.turn,
    });
    return { ran: true, reason: decision.reason, ok: design.ok, error: design.error, durationMs, design };
}
/** 运行时是否已就绪（面板用一句话说明「依赖装在哪」）。 */
export function runtimeLinked(circuitDir) {
    return existsSync(join(circuitDir, "node_modules", "tscircuit", "cli.mjs"));
}
export { runtimeReady };
