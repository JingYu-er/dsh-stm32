/**
 * 3D 模型解析：让 STEP 导出尽量带上器件。
 *
 * KiCad 的 `.kicad_pcb` 里模型路径写成 `${KICAD10_3DMODEL_DIR}/Package_SO.3dshapes/SOIC-8.step`，
 * 只要变量没定义、或用户机器上没装官方 3D 包，导出就连模型一起丢，只剩一块光板。
 * 这里按四级顺序找：官方 3D 目录 → 工程 `libs/3d` → tscircuit 的模型缓存 → 缺失清单。
 * 找到替代位置后把路径改写进 `.kicad_pcb`（`${KIPRJMOD}` 相对路径），下次导出不必再找。
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
const MODEL_VAR = /\$\{?(KICAD\d*_3DMODEL_DIR|KISYS3DMOD)\}?/u;
/** 读出 `.kicad_pcb` 里所有 `(model "路径")`。 */
export function collectModelPaths(pcbText) {
    const found = new Set();
    const pattern = /\(model\s+"([^"]+)"\)/gu;
    let match = pattern.exec(pcbText);
    while (match !== null) {
        found.add(match[1] ?? "");
        match = pattern.exec(pcbText);
    }
    return [...found];
}
/**
 * 按四级顺序解析模型。
 *
 * @param input.modelRoot 官方 3D 目录（KiCad 安装下的 `share/kicad/3dmodels`）
 * @param input.libsDir 工程库目录（`hardware/libs`），模型放 `libs/3d`
 * @param input.cacheDir tscircuit 的模型缓存（可选）
 */
export function resolveModels(pcbText, input) {
    return collectModelPaths(pcbText).map((path) => {
        const relativeToRoot = path.replace(MODEL_VAR, "").replace(/^\/+/u, "");
        const official = input.modelRoot === "" ? "" : join(input.modelRoot, relativeToRoot);
        if (official !== "" && existsSync(official))
            return { path, resolved: official, source: "kicad-official" };
        const project = join(input.libsDir, "3d", basename(path));
        if (existsSync(project))
            return { path, resolved: project, source: "project-libs" };
        if (input.cacheDir !== undefined && input.cacheDir !== "") {
            const cached = join(input.cacheDir, basename(path));
            if (existsSync(cached))
                return { path, resolved: cached, source: "cache" };
        }
        return { path, resolved: "", source: "missing" };
    });
}
/** 把找到的模型路径改写成 `${KIPRJMOD}` 相对路径；返回新文本与改了几处。 */
export function rewriteModelPaths(pcbText, uses, pcbDir) {
    let text = pcbText;
    let changed = 0;
    for (const use of uses) {
        if (use.resolved === "" || use.resolved === use.path)
            continue;
        const rel = "${KIPRJMOD}/" + relative(pcbDir, use.resolved).replace(/\\/gu, "/");
        if (!text.includes("(model \"" + use.path + "\")"))
            continue;
        text = text.replace("(model \"" + use.path + "\")", "(model \"" + rel + "\")");
        changed += 1;
    }
    return { text, changed };
}
/**
 * 导出前处理 3D 模型：解析 → 改写 `.kicad_pcb` → 返回报告。
 *
 * 只改模型路径，不动几何；找不到的留给 `missing`，由导出结果一起报。
 */
export function prepareModels3d(pcbFile, input) {
    const report = { ok: false, error: "", used: [], missing: [], changed: 0, bytesBefore: 0, bytesAfter: 0 };
    if (!existsSync(pcbFile)) {
        report.error = "找不到 KiCad PCB：" + pcbFile;
        return report;
    }
    const before = readFileSync(pcbFile, "utf8");
    report.bytesBefore = statSync(pcbFile).size;
    const used = resolveModels(before, input);
    report.used = used;
    report.missing = used.filter((item) => item.resolved === "").map((item) => item.path);
    const rewritten = rewriteModelPaths(before, used, dirname(pcbFile));
    report.changed = rewritten.changed;
    if (rewritten.changed > 0) {
        writeFileSync(pcbFile, rewritten.text, "utf8");
        report.bytesAfter = statSync(pcbFile).size;
    }
    else {
        report.bytesAfter = report.bytesBefore;
    }
    report.ok = true;
    return report;
}
