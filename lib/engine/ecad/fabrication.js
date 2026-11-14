/**
 * ECAD 制造文件导出（S100）：Gerber、钻孔、贴片坐标与 STEP 一次落盘。
 *
 * 全部交给 kicad-cli：它是 KiCad 自己的一块，输出与 KiCad 里点「制造输出」一致，
 * 不需要在本插件里重写一遍写文件的格式。
 */
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { runCapture } from "../subprocess-runner.js";
import { ecadEnv } from "./toolchain.js";
import { exportStep } from "./checks.js";
function listFiles(dir) {
    const files = [];
    if (!existsSync(dir))
        return files;
    for (const name of readdirSync(dir).sort()) {
        try {
            const info = statSync(join(dir, name));
            if (info.isFile())
                files.push({ name, bytes: info.size });
        }
        catch {
            // 单个文件读不到不影响整批导出，跳过即可。
        }
    }
    return files;
}
function tail(text, limit = 800) {
    const trimmed = text.trim();
    return trimmed.length > limit ? trimmed.slice(trimmed.length - limit) : trimmed;
}
async function runExport(subprocess, toolchain, argv, cwd, signal) {
    const outcome = await runCapture(subprocess, {
        argv: [...argv],
        cwd,
        env: ecadEnv(toolchain),
        timeoutMs: 300_000,
        maxBytes: 256 * 1024,
        ...(signal === undefined ? {} : { signal }),
    });
    if (outcome.exitCode === 0)
        return { ok: true, error: "" };
    return { ok: false, error: tail(outcome.stdout + "\n" + outcome.stderr) || "kicad-cli 执行失败" };
}
/**
 * 导出制造文件。
 *
 * 落点：`<outDir>/gerbers/`（Gerber 与钻孔）、`<outDir>/<board>.step`、
 * `<outDir>/<board>-pos.csv`。中途某一步失败不删已产出的文件，错误里说明是哪一步。
 */
export async function exportFabrication(subprocess, toolchain, pcbFile, outDir, signal) {
    const empty = {
        ok: false,
        error: "",
        outDir,
        gerberDir: "",
        gerbers: [],
        stepFile: "",
        stepBytes: 0,
        posFile: "",
        drillFiles: [],
        notes: [],
    };
    if (toolchain.kicadCli === "")
        return { ...empty, error: "没有 kicad-cli：装一个 KiCad 10" };
    if (!existsSync(pcbFile))
        return { ...empty, error: "还没有 .kicad_pcb：先跑一次 stm32_ecad_build" };
    const board = (pcbFile.split(/[\\/]/u).pop() ?? "board").replace(/\.kicad_pcb$/u, "");
    const gerberDir = join(outDir, "gerbers");
    mkdirSync(gerberDir, { recursive: true });
    const notes = [];
    const cwd = dirname(pcbFile);
    const gerbers = await runExport(subprocess, toolchain, [toolchain.kicadCli, "pcb", "export", "gerbers", "-o", gerberDir, pcbFile], cwd, signal);
    if (!gerbers.ok)
        return { ...empty, error: "Gerber 导出失败：" + gerbers.error };
    const drill = await runExport(subprocess, toolchain, [toolchain.kicadCli, "pcb", "export", "drill", "-o", gerberDir, pcbFile], cwd, signal);
    const drillFiles = listFiles(gerberDir).filter((file) => /\.(drl|nc|g\d+|xln)$/iu.test(file.name));
    if (!drill.ok)
        notes.push("钻孔文件导出失败：" + drill.error);
    const posFile = join(outDir, board + "-pos.csv");
    const pos = await runExport(subprocess, toolchain, [toolchain.kicadCli, "pcb", "export", "pos", "-o", posFile, pcbFile], cwd, signal);
    if (!pos.ok)
        notes.push("贴片坐标导出失败：" + pos.error);
    const step = await exportStep(subprocess, toolchain, pcbFile, join(outDir, board + ".step"), signal);
    if (!step.ok)
        notes.push("STEP 导出失败：" + step.error);
    if (step.missingModels.length > 0)
        notes.push("缺 3D 模型：" + step.missingModels.join("、"));
    const gerbers_list = listFiles(gerberDir);
    if (gerbers_list.length === 0)
        notes.push("Gerber 目录是空的：检查板子是否已经铺铜/布线");
    return {
        ok: true,
        error: "",
        outDir,
        gerberDir,
        gerbers: gerbers_list,
        stepFile: step.stepFile,
        stepBytes: step.bytes,
        posFile: pos.ok ? posFile : "",
        drillFiles,
        notes,
    };
}
