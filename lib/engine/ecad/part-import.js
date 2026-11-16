/**
 * 器件导入（S173）：把一个封装从 KiCad 官方库收进工程，并按焊盘生成符号骨架。
 *
 * 为什么要这一步：`footprint="jlcpcb:C<编号>"` 是构建时去立创拉的，产物里只有几何、没有出处；
 * 换机器、换网络都复现不了。这里把「库里的封装」固化成工程自己的文件，并登记库表，
 * 再顺手生一个符号骨架——符号的引脚号必须与封装焊盘一一对上，否则网表对不上。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fetchLcscProduct } from "../datasheet/lcsc.js";
import { buildSymbol } from "./gen/symbol.js";
import { libsDirOf } from "./jlcpcb.js";
import { upsertLibEntries } from "./libs.js";
import { parseKicadModPads } from "./padprecheck.js";
const EMPTY = {
    ok: false,
    error: "",
    code: "",
    mpn: "",
    brand: "",
    datasheet: "",
    footprint: null,
    symbol: null,
    pads: [],
    written: [],
    notes: [],
};
/** 从 `Lib:Name` 拆出库名与封装名；只有名字时库名留空。 */
export function splitFootprintRef(ref) {
    const text = ref.trim().replace(/\.kicad_mod$/u, "");
    const colon = text.indexOf(":");
    if (colon < 0)
        return { library: "", name: text };
    return { library: text.slice(0, colon), name: text.slice(colon + 1) };
}
/** 在 KiCad 官方库里找封装文件；`library` 为空时按名字扫一遍（慢，但只扫一层目录）。 */
export function findFootprintFile(footprintDir, library, name) {
    if (library !== "") {
        const direct = join(footprintDir, library + ".pretty", name + ".kicad_mod");
        if (existsSync(direct))
            return direct;
        return "";
    }
    if (!existsSync(footprintDir))
        return "";
    for (const entry of readdirSync(footprintDir)) {
        if (!entry.endsWith(".pretty"))
            continue;
        const candidate = join(footprintDir, entry, name + ".kicad_mod");
        if (existsSync(candidate))
            return candidate;
    }
    return "";
}
/** 名字里的封装（`SOIC-8_3.9x4.9mm_P1.27mm`）优先，其次立创给的型号——只用于给人看。 */
function displayName(name, mpn) {
    return name !== "" ? name : mpn;
}
/**
 * 导入一个封装：复制 `.kicad_mod`、生成符号骨架、登记两张库表。
 *
 * 三件事都只在 `write: true` 时落盘；预先检查会给出将要写的每个路径。
 */
export async function importPart(projectDir, toolchain, options) {
    const footprintRef = splitFootprintRef(options.footprint);
    if (footprintRef.name === "")
        return { ...EMPTY, error: "要给封装名：Lib:Name（如 Package_SO:SOIC-8_3.9x4.9mm_P1.27mm）" };
    const source = findFootprintFile(toolchain.footprintDir, footprintRef.library, footprintRef.name);
    if (source === "") {
        return {
            ...EMPTY,
            error: "KiCad 库里没有这个封装：" +
                (footprintRef.library === "" ? footprintRef.name : footprintRef.library + ":" + footprintRef.name) +
                "（在 " + toolchain.footprintDir + " 下找）",
        };
    }
    let mpn = "";
    let brand = "";
    let datasheet = "";
    const notes = [];
    const code = (options.code ?? "").trim().toUpperCase();
    if (code !== "") {
        if (!/^C\d+$/u.test(code))
            return { ...EMPTY, error: "立创编号格式不对：" + code + "（形如 C25137）" };
        const fetched = await fetchLcscProduct(code, { fetchImpl: options.fetchImpl, signal: options.signal });
        if (fetched.ok) {
            mpn = fetched.product.mpn;
            brand = fetched.product.brand;
            datasheet = fetched.product.pdfUrl;
        }
        else {
            notes.push("没查到立创页面（" + fetched.error + "）：封装照常导入，但来源信息留空。");
        }
    }
    else {
        notes.push("没有给立创编号：只从 KiCad 库取封装，不查型号与手册。");
    }
    const text = readFileSync(source, "utf8");
    const pads = parseKicadModPads(text);
    if (pads.length === 0)
        return { ...EMPTY, error: "这个封装里没有焊盘（或焊盘格式不认识）：" + source };
    const names = pads.map((pad) => pad.name);
    const library = (options.library ?? footprintRef.library ?? basename(dirname(source), ".pretty")).trim();
    const footprintName = (options.name ?? footprintRef.name).trim();
    const libsRoot = libsDirOf(projectDir);
    const footprintFile = join(libsRoot, "footprints", library + ".pretty", footprintName + ".kicad_mod");
    const symbolName = displayName(footprintName, mpn);
    const symbolFile = join(libsRoot, "symbols", symbolName + ".kicad_sym");
    const symbol = buildSymbol({
        name: symbolName,
        pins: pads.map((pad) => ({ number: pad.name, name: pad.name })),
    });
    if (!symbol.ok)
        return { ...EMPTY, error: "符号骨架生成失败：" + symbol.error };
    const written = [];
    if (options.write === true) {
        mkdirSync(dirname(footprintFile), { recursive: true });
        mkdirSync(dirname(symbolFile), { recursive: true });
        writeFileSync(footprintFile, withProperties(text, { code, mpn, brand, datasheet }));
        written.push(footprintFile);
        writeFileSync(symbolFile, symbol.text);
        written.push(symbolFile);
        const kicadDir = join(projectDir, "hardware", "kicad");
        if (existsSync(kicadDir)) {
            registerTables(kicadDir, libsRoot, library, symbolName);
            written.push(join(kicadDir, "fp-lib-table"), join(kicadDir, "sym-lib-table"));
        }
        else {
            notes.push("没找到 hardware/kicad：库文件已写，但两张库表没登记（构建一次生成 KiCad 工程后再跑一次）。");
        }
    }
    return {
        ok: true,
        error: "",
        code,
        mpn,
        brand,
        datasheet,
        footprint: { library, name: footprintName, source, file: footprintFile },
        symbol: { name: symbolName, file: symbolFile, pins: pads.length },
        pads: names,
        written,
        notes,
    };
}
/** 把来源信息写进封装的属性里：换机器打开也能看出这是哪个料。 */
export function withProperties(modText, input) {
    const entries = [];
    if (input.code !== "")
        entries.push('(property "LCSC" "' + input.code + '")');
    if (input.mpn !== "")
        entries.push('(property "MPN" "' + input.mpn + '")');
    if (input.brand !== "")
        entries.push('(property "Brand" "' + input.brand + '")');
    if (input.datasheet !== "")
        entries.push('(property "Datasheet" "' + input.datasheet + '")');
    if (entries.length === 0)
        return modText;
    const end = modText.lastIndexOf(")");
    if (end < 0)
        return modText;
    return modText.slice(0, end) + "  " + entries.join("  ") + "\n" + modText.slice(end);
}
/** 登记 `fp-lib-table` 与 `sym-lib-table`：两条都走同一套 `(lib …)` 重建，避免表头重复。 */
function registerTables(kicadDir, libsRoot, library, symbolName) {
    const fpTable = join(kicadDir, "fp-lib-table");
    const fpUri = "${KIPRJMOD}/" + relative(kicadDir, join(libsRoot, "footprints", library + ".pretty")).replace(/\\/gu, "/");
    upsertLibEntries(fpTable, "fp", [{ lib: library, uri: fpUri }]);
    const symTable = join(kicadDir, "sym-lib-table");
    const symUri = "${KIPRJMOD}/" + relative(kicadDir, join(libsRoot, "symbols", symbolName + ".kicad_sym")).replace(/\\/gu, "/");
    upsertLibEntries(symTable, "sym", [{ lib: symbolName, uri: symUri }]);
}
