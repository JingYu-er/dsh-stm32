/**
 * 立创（嘉立创 / LCSC）封装的固化。
 *
 * tscircuit 的 `footprint="jlcpcb:C12345"` 会在构建时从立创拉封装，产物里只有几何、没有出处：
 * 生成名变成 `tscircuit:chip`，`circuit.json` 里也不留编号。换一台机器再打开工程，
 * 既看不出这是立创的哪个料，也没法把封装收进自己的库。
 *
 * 这里做两件事：
 *   1. 从 `.circuit.tsx` 里读出「哪个位号用了哪个立创编号」（这是唯一保留出处的地方）；
 *   2. 把 `.kicad_pcb` 里对应位号的内嵌封装抽出来，落成 `hardware/libs/footprints/jlcpcb_<编号>.pretty`，
 *      并登记到工程的 `fp-lib-table`，同时写一份 `sources.json` 记下来源。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { scanPcbFootprints } from "./libs.js";
/** 从电路源码里读「位号 → 立创编号」。只认 `footprint="jlcpcb:C<数字>"` 这种写法。 */
export function parseJlcpcbFootprints(tsxText) {
    const usages = [];
    const tags = tsxText.match(/<[A-Za-z][^>]*>/gu) ?? [];
    for (const tag of tags) {
        const footprint = /footprint\s*=\s*["'{][^"'}]*jlcpcb:C(\d+)/u.exec(tag);
        if (footprint === null)
            continue;
        const name = /name\s*=\s*["']([^"']+)["']/u.exec(tag);
        if (name === null)
            continue;
        usages.push({ ref: name[1] ?? "", code: footprint[1] ?? "" });
    }
    return usages;
}
function referenceOf(block) {
    const match = /\(property\s+"Reference"\s+"([^"]+)"/u.exec(block);
    return match === null ? "" : (match[1] ?? "");
}
/** 把内嵌封装改写成立创库里的单文件：头换成 dsh-stm32 生成，名字用编号。 */
function toModule(block, code) {
    const start = block.search(/\(footprint\s/u);
    if (start < 0)
        return "";
    const rest = block.slice(start);
    const afterHead = rest.replace(/^\(footprint\s+(?:"[^"]*"|[^\s(]+)/u, "(footprint \"" + code + "\" (version 20240108) (generator \"dsh-stm32\")");
    return afterHead;
}
/** 读/写 `libs/sources.json`：记每个固化的封装来自哪里，方便追料与换料。 */
function mergeSources(file, entries) {
    let existing = [];
    if (existsSync(file)) {
        try {
            const parsed = JSON.parse(readFileSync(file, "utf8"));
            if (Array.isArray(parsed))
                existing = parsed;
        }
        catch {
            existing = [];
        }
    }
    const byCode = new Map(existing.map((entry) => [entry.code, entry]));
    for (const entry of entries)
        byCode.set(entry.code, entry);
    const sorted = [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
    writeFileSync(file, JSON.stringify(sorted, null, 2) + "\n", "utf8");
}
/** 把一条库登记进工程的 fp-lib-table（已存在就跳过，不动别人的条目）。 */
function mergeFootprintTable(kicadDir, lib, uri) {
    const file = join(kicadDir, "fp-lib-table");
    const line = "    (lib (name \"" + lib + "\")(type \"KiCad\")(uri \"" + uri + "\")(options \"\")(descr \"\"))";
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (current.includes("(name \"" + lib + "\")"))
        return file;
    if (current.trim() === "") {
        writeFileSync(file, "(fp_lib_table\n  (version 7)\n" + line + "\n)\n", "utf8");
        return file;
    }
    const closed = current.lastIndexOf(")");
    const head = current.slice(0, closed).replace(/\s*$/u, "");
    writeFileSync(file, head + "\n" + line + "\n)\n", "utf8");
    return file;
}
/**
 * 固化立创封装。
 *
 * @param input.tsxFile 电路源码（`.circuit.tsx`），出处只在这里
 * @param input.pcbFile 构建产出的 `.kicad_pcb`，几何在这里
 * @param input.kicadDir KiCad 工程目录（写 `fp-lib-table`）
 * @param input.libsDir 工程库目录（写封装与 `sources.json`）
 */
export function vendorJlcpcbFootprints(input) {
    const report = { ok: true, error: "", vendored: [], skipped: [], notes: [] };
    if (!existsSync(input.tsxFile)) {
        return { ...report, ok: false, error: "找不到电路源码：" + input.tsxFile };
    }
    if (!existsSync(input.pcbFile)) {
        return { ...report, ok: false, error: "找不到 KiCad PCB：" + input.pcbFile };
    }
    const usages = parseJlcpcbFootprints(readFileSync(input.tsxFile, "utf8"));
    if (usages.length === 0) {
        report.notes.push("电路里没有 jlcpcb:C<编号> 的封装");
        return report;
    }
    const blocks = scanPcbFootprints(readFileSync(input.pcbFile, "utf8"));
    const byCode = new Map();
    const sources = [];
    for (const usage of usages) {
        const block = blocks.find((item) => referenceOf(item.raw) === usage.ref);
        if (block === undefined) {
            report.skipped.push({ ref: usage.ref, code: usage.code, reason: "PCB 里找不到这位号的封装" });
            continue;
        }
        const dir = join(input.libsDir, "footprints", "jlcpcb_" + usage.code + ".pretty");
        const file = join(dir, usage.code + ".kicad_mod");
        mkdirSync(dir, { recursive: true });
        const module = toModule(block.raw, usage.code);
        if (module === "") {
            report.skipped.push({ ref: usage.ref, code: usage.code, reason: "封装块里没有 footprint 头" });
            continue;
        }
        writeFileSync(file, module + "\n", "utf8");
        mergeFootprintTable(input.kicadDir, "jlcpcb_" + usage.code, "${KIPRJMOD}/" + relative(input.kicadDir, dir).replace(/\\/gu, "/"));
        const refs = byCode.get(usage.code) ?? [];
        refs.push(usage.ref);
        byCode.set(usage.code, refs);
        sources.push({ source: "jlcpcb", code: usage.code, refs, file: relative(input.libsDir, file).replace(/\\/gu, "/") });
    }
    for (const [code, refs] of byCode) {
        report.vendored.push({ code, refs, file: join(input.libsDir, "footprints", "jlcpcb_" + code + ".pretty", code + ".kicad_mod") });
    }
    if (sources.length > 0)
        mergeSources(join(input.libsDir, "sources.json"), sources);
    if (report.skipped.length > 0)
        report.notes.push("有 " + String(report.skipped.length) + " 个立创封装没固化，见 skipped");
    return report;
}
/** 工程库根目录（`hardware/libs`）。 */
export function libsDirOf(hardwareDir) {
    return join(hardwareDir, "libs");
}
/** 供调用方拼路径用（保持与 `planEcadWorkspace` 一致）。 */
export function tsxPathOf(circuitDir, entry) {
    return join(circuitDir, entry === "" ? "index.circuit.tsx" : entry);
}
export { dirname };
