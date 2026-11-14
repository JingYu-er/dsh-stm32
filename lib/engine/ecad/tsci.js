/**
 * ECAD 工作区与 tscircuit 构建（S97）。
 *
 * 分工：
 *   circuit/  tscircuit 源码（唯一写者），package.json + lockfile 固定版本
 *   kicad/    tsci build 生成的真 KiCad 工程（每次重建、只读）
 *   libs/     从 KiCad 库抽取的符号/封装与 3D 模型
 *   out/      gerber / step / svg 成品
 *
 * 为什么必须用 bun：Node 直接跑 `.tsx` 报 `Unknown file extension ".tsx"`，
 * tsci 的 eval 走的是 bun 的 TS 加载器；KiCad 自带的 bun 正好可用。
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCapture } from "../subprocess-runner.js";
import { ecadEnv } from "./toolchain.js";
export const ECAD_DIRS = ["circuit", "kicad", "libs", "out"];
/** 在 `hardware/` 下规划四个子目录；不建目录（初始化由 initEcadWorkspace 负责）。 */
export function planEcadWorkspace(projectDir, hardwareDir) {
    const root = hardwareDir !== "" ? hardwareDir : join(projectDir, "hardware");
    return {
        projectDir,
        root,
        circuitDir: join(root, "circuit"),
        kicadDir: join(root, "kicad"),
        libsDir: join(root, "libs"),
        outDir: join(root, "out"),
        initialized: existsSync(join(root, "circuit", "package.json")),
    };
}
/**
 * 建目录并写最小 tscircuit 工程骨架（不装依赖）。
 *
 * 依赖安装单独一步（`npm i` 约 730 MB），失败也不影响后续重试；这里只保证
 * 目录与 package.json 就位，`tsci build` 前再检查 node_modules。
 */
export function initEcadWorkspace(workspace) {
    const created = [];
    try {
        for (const dir of [workspace.root, workspace.circuitDir, workspace.kicadDir, workspace.libsDir, workspace.outDir]) {
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
                created.push(dir);
            }
        }
        const pkgPath = join(workspace.circuitDir, "package.json");
        if (!existsSync(pkgPath)) {
            const pkg = {
                name: "dsh-stm32-circuit",
                private: true,
                version: "0.0.0",
                devDependencies: {
                    tscircuit: "latest",
                    typescript: "^5.0.0",
                },
            };
            writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
            created.push(pkgPath);
        }
        return { ok: true, error: "", created, workspace };
    }
    catch (error) {
        return {
            ok: false,
            error: "初始化 ECAD 工作区失败：" + (error instanceof Error ? error.message : String(error)),
            created,
            workspace,
        };
    }
}
function findDistRoot(circuitDir) {
    const dist = join(circuitDir, "dist");
    return existsSync(dist) ? dist : "";
}
/** 在 `dist/` 下找第一个含 `kicad/*.kicad_pcb` 的目录。 */
function findKicadProject(distRoot) {
    const empty = { kicadDir: "", pcbSvg: "", schematicSvg: "", circuitJson: "" };
    if (distRoot === "" || !existsSync(distRoot))
        return empty;
    for (const entry of readdirSync(distRoot, { withFileTypes: true })) {
        if (!entry.isDirectory())
            continue;
        const dir = join(distRoot, entry.name);
        const kicadDir = join(dir, "kicad");
        const hasPcb = existsSync(kicadDir) && readdirSync(kicadDir).some((name) => name.endsWith(".kicad_pcb"));
        if (!hasPcb)
            continue;
        return {
            kicadDir,
            pcbSvg: existsSync(join(dir, "pcb.svg")) ? join(dir, "pcb.svg") : "",
            schematicSvg: existsSync(join(dir, "schematic.svg")) ? join(dir, "schematic.svg") : "",
            circuitJson: existsSync(join(dir, "circuit.json")) ? join(dir, "circuit.json") : "",
        };
    }
    return empty;
}
function tail(text, limit = 4000) {
    return text.length <= limit ? text : text.slice(text.length - limit);
}
/**
 * 跑一次 `tsci build`。
 *
 * 不自动装依赖：缺 `node_modules` 时直接给出可执行的错误，避免工具在 730 MB 的
 * 安装上静默卡住。构建超时默认 5 分钟（首次打包较慢）。
 */
export async function runTsciBuild(request) {
    const { subprocess, toolchain, workspace } = request;
    const notes = [];
    const started = Date.now();
    const fail = (error) => ({
        ok: false,
        error,
        exitCode: null,
        timedOut: false,
        durationMs: Date.now() - started,
        stdoutTail: "",
        stderrTail: "",
        circuitJson: "",
        pcbSvg: "",
        schematicSvg: "",
        kicadProjectDir: "",
        notes,
    });
    if (toolchain.bun === "")
        return fail("没找到 bun：它随 KiCad 一起安装，或用 DSH_STM32_BUN 指定");
    if (!existsSync(join(workspace.circuitDir, "package.json"))) {
        return fail("ECAD 工作区还没初始化：先运行 stm32_ecad_init 生成 " + workspace.circuitDir);
    }
    const cli = join(workspace.circuitDir, "node_modules", "tscircuit", "cli.mjs");
    if (!existsSync(cli)) {
        return fail("tscircuit 未安装：在 " + workspace.circuitDir + " 里执行 npm install（首次约 730 MB），再重试");
    }
    const argv = [toolchain.bun, cli, "build"];
    const entry = (request.entry ?? "").trim();
    if (entry !== "")
        argv.push(entry);
    argv.push("--kicad-project");
    if (request.svgs !== false)
        argv.push("--svgs");
    const outcome = await runCapture(subprocess, {
        argv,
        cwd: workspace.circuitDir,
        env: ecadEnv(toolchain),
        timeoutMs: request.timeoutMs ?? 300_000,
        maxBytes: 1024 * 1024,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const distRoot = findDistRoot(workspace.circuitDir);
    const found = findKicadProject(distRoot);
    const ok = outcome.exitCode === 0 && found.kicadDir !== "";
    if (outcome.exitCode === 0 && found.kicadDir === "") {
        notes.push("构建命令成功但没有找到 dist/<name>/kicad/*.kicad_pcb：检查入口文件是否导出 board");
    }
    if (outcome.timedOut)
        notes.push("构建超时：tscircuit 未在限制时间内完成");
    return {
        ok,
        error: ok ? "" : (outcome.spawnError ?? tail(outcome.stderr)) || "tscircuit 构建失败",
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        durationMs: Date.now() - started,
        stdoutTail: tail(outcome.stdout),
        stderrTail: tail(outcome.stderr),
        circuitJson: found.circuitJson,
        pcbSvg: found.pcbSvg,
        schematicSvg: found.schematicSvg,
        kicadProjectDir: found.kicadDir,
        notes,
    };
}
/** 列出 `circuit/` 下的入口候选（`*.circuit.tsx`，按名字排序）。 */
export function listCircuitEntries(circuitDir) {
    if (!existsSync(circuitDir))
        return [];
    return readdirSync(circuitDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".circuit.tsx"))
        .map((entry) => entry.name)
        .sort();
}
/** 在若干根目录下找最新的 `.kicad_pcb`，同目录里的 `.kicad_sch` 一并返回。 */
function newestKicadProject(roots) {
    let best = null;
    const stack = roots.filter((root) => existsSync(root));
    while (stack.length > 0) {
        const current = stack.pop();
        let entries;
        try {
            entries = readdirSync(current, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.name.startsWith("."))
                continue;
            const path = join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(path);
                continue;
            }
            if (!entry.name.endsWith(".kicad_pcb"))
                continue;
            let mtimeMs = 0;
            try {
                mtimeMs = statSync(path).mtimeMs;
            }
            catch {
                continue;
            }
            // 同一毫秒内写完的两份产物在 Windows 上时间戳可能相等；相等时按路径字典序定胜负，
            // 否则遍历顺序（readdir 的实现细节）会让「取最新」变成不确定的行为。
            if (best !== null && (mtimeMs < best.mtimeMs || (mtimeMs === best.mtimeMs && path <= best.pcbFile)))
                continue;
            const schematicFile = readdirSync(current)
                .filter((name) => name.endsWith(".kicad_sch"))
                .map((name) => join(current, name))
                .sort()[0];
            best = { kicadDir: current, pcbFile: path, schematicFile: schematicFile ?? "", mtimeMs };
        }
    }
    return best === null ? null : { kicadDir: best.kicadDir, pcbFile: best.pcbFile, schematicFile: best.schematicFile };
}
/**
 * 取最近一次构建产出的 KiCad 工程。
 *
 * 先看 `hardware/kicad/`（成品拷贝），再看 `circuit/dist/`（tsci 的原始产物）；
 * 两边都没有时给一句能照着做的错误，而不是让调用方拿到空路径。
 */
export function findLatestKicadBuild(workspace) {
    const found = newestKicadProject([workspace.kicadDir, join(workspace.circuitDir, "dist")]);
    if (found === null) {
        return {
            ok: false,
            error: "还没有可用的 KiCad 工程：先跑一次 stm32_ecad_build（在 hardware/circuit 下生成 dist/<name>/kicad）",
            kicadDir: "",
            pcbFile: "",
            schematicFile: "",
        };
    }
    return { ok: true, error: "", ...found };
}
/** 目录大小（字节）：用于初始化报告里说明 node_modules 占位。 */
export function dirSizeBytes(dir) {
    if (!existsSync(dir))
        return 0;
    let total = 0;
    const stack = [dir];
    while (stack.length > 0) {
        const current = stack.pop();
        let entries;
        try {
            entries = readdirSync(current, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const path = join(current, entry.name);
            if (entry.isDirectory())
                stack.push(path);
            else {
                try {
                    total += statSync(path).size;
                }
                catch {
                    /* 忽略读不到的文件 */
                }
            }
        }
    }
    return total;
}
