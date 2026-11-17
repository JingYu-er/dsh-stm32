/**
 * 器件导入（S173）：把一个封装从 KiCad 官方库收进工程，并按焊盘生成符号骨架。
 *
 * 为什么要这一步：`footprint="jlcpcb:C<编号>"` 是构建时去立创拉的，产物里只有几何、没有出处；
 * 换机器、换网络都复现不了。这里把「库里的封装」固化成工程自己的文件，并登记库表，
 * 再顺手生一个符号骨架——符号的引脚号必须与封装焊盘一一对上，否则网表对不上。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import { fetchLcscProduct } from "../datasheet/lcsc.js";
import { easyedaToKicadMod, fetchEasyedaPackage } from "./easyeda.js";
import { buildSymbol } from "./gen/symbol.js";
import { libsDirOf } from "./jlcpcb.js";
import { upsertLibEntries } from "./libs.js";
import { parseKicadModPads } from "./padprecheck.js";
import type { EcadToolchain } from "./toolchain.js";

export interface PartImportOptions {
  /** 立创编号（`C25137`）；给了就去查型号/品牌/手册，查不到不阻断导入。 */
  readonly code?: string;
  /** 源封装，`Lib:Name`（如 `Package_SO:SOIC-8_3.9x4.9mm_P1.27mm`）或只给 `Name`。 */
  readonly footprint: string;
  /** 收进工程后的库名，默认用源库名。 */
  readonly library?: string;
  /** 符号名，默认用封装名。 */
  readonly name?: string;
  /** 封装从哪来：kicad 只查官方库；lcsc 只从立创页面转；auto（默认）先库后立创。 */
  readonly source?: "kicad" | "lcsc" | "auto";
  /** 不传就只预先检查，不写文件。 */
  readonly write?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}

export interface PartImportReport {
  readonly ok: boolean;
  readonly error: string;
  readonly code: string;
  readonly mpn: string;
  readonly brand: string;
  readonly datasheet: string;
  readonly footprint: { readonly library: string; readonly name: string; readonly source: string; readonly file: string } | null;
  readonly symbol: { readonly name: string; readonly file: string; readonly pins: number } | null;
  /** 封装引用的 3D 模型：收进工程后落在 `hardware/libs/3d/<Lib>.3dshapes/`。 */
  readonly model: { readonly file: string; readonly source: string; readonly bytes: number } | null;
  readonly pads: readonly string[];
  readonly written: readonly string[];
  readonly notes: readonly string[];
}

const EMPTY: PartImportReport = {
  ok: false,
  error: "",
  code: "",
  mpn: "",
  brand: "",
  datasheet: "",
  footprint: null,
  symbol: null,
  model: null,
  pads: [],
  written: [],
  notes: [],
};

/** 从 `Lib:Name` 拆出库名与封装名；只有名字时库名留空。 */
export function splitFootprintRef(ref: string): { library: string; name: string } {
  const text = ref.trim().replace(/\.kicad_mod$/u, "");
  const colon = text.indexOf(":");
  if (colon < 0) return { library: "", name: text };
  return { library: text.slice(0, colon), name: text.slice(colon + 1) };
}

/** 在 KiCad 官方库里找封装文件；`library` 为空时按名字扫一遍（慢，但只扫一层目录）。 */
export function findFootprintFile(footprintDir: string, library: string, name: string): string {
  if (library !== "") {
    const direct = join(footprintDir, library + ".pretty", name + ".kicad_mod");
    if (existsSync(direct)) return direct;
    return "";
  }
  if (!existsSync(footprintDir)) return "";
  for (const entry of readdirSync(footprintDir)) {
    if (!entry.endsWith(".pretty")) continue;
    const candidate = join(footprintDir, entry, name + ".kicad_mod");
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

/** 名字里的封装（`SOIC-8_3.9x4.9mm_P1.27mm`）优先，其次立创给的型号——只用于给人看。 */
function displayName(name: string, mpn: string): string {
  return name !== "" ? name : mpn;
}

/** 封装里引用的第一个 3D 模型路径（`(model "…"`）；没有就返回空串。 */
export function parseModelRef(modText: string): string {
  const match = /\(model\s+"([^"]+)"/u.exec(modText);
  return match === null ? "" : (match[1] ?? "");
}

/** 把 KiCad 的环境变量写法（`${KICAD10_3DMODEL_DIR}` 等）换成实际目录。 */
export function resolveModelPath(path: string, model3dDir: string): string {
  const relative = path.replace(/^\$\{(?:KICAD\d+_3DMODEL_DIR|KISYS3DMOD)\}/u, "").replace(/^\/+/, "");
  return relative === path ? path : join(model3dDir, relative);
}

/**
 * 导入一个封装：复制 `.kicad_mod`、生成符号骨架、登记两张库表。
 *
 * 三件事都只在 `write: true` 时落盘；预先检查会给出将要写的每个路径。
 */
export async function importPart(projectDir: string, toolchain: EcadToolchain, options: PartImportOptions): Promise<PartImportReport> {
  const footprintRef = splitFootprintRef(options.footprint);
  if (footprintRef.name === "") return { ...EMPTY, error: "要给封装名：Lib:Name（如 Package_SO:SOIC-8_3.9x4.9mm_P1.27mm）" };
  const requestedSource = options.source ?? "auto";
  const requestedName = (options.name ?? "").trim();
  const requestedLibrary = (options.library ?? "").trim();
  const code = (options.code ?? "").trim().toUpperCase();
  if (code !== "" && !/^C\d+$/u.test(code)) return { ...EMPTY, error: "立创编号格式不对：" + code + "（形如 C25137）" };

  const notes: string[] = [];
  let mpn = "";
  let brand = "";
  let datasheet = "";
  let origin: "kicad" | "easyeda" = "kicad";
  let sourceFile = "";
  let text = "";
  let generatedPackage = "";

  const reference = footprintRef.library === "" ? footprintRef.name : footprintRef.library + ":" + footprintRef.name;
  const libFile = requestedSource === "lcsc" ? "" : findFootprintFile(toolchain.footprintDir, footprintRef.library, footprintRef.name);
  if (libFile !== "") {
    sourceFile = libFile;
    text = readFileSync(libFile, "utf8");
  } else if (code !== "" && requestedSource !== "kicad") {
    // 库里没有就回退到立创页面：封装图形转成 .kicad_mod，来源写进属性。
    const fetched = await fetchEasyedaPackage(code, { fetchImpl: options.fetchImpl, signal: options.signal });
    if (!fetched.ok) {
      return {
        ...EMPTY,
        error: "KiCad 库里没有 " + reference + "，从立创页面取 " + code + " 也失败：" + fetched.error,
      };
    }
    const converted = easyedaToKicadMod(fetched.pkg, fetched.center, {
      name: requestedName !== "" ? requestedName : footprintRef.name,
    });
    if (!converted.ok) return { ...EMPTY, error: "立创封装转 KiCad 失败：" + converted.error };
    origin = "easyeda";
    text = converted.text;
    generatedPackage = fetched.pkg.packageName;
    mpn = fetched.pkg.mpn;
    notes.push("封装来自立创页面 " + code + "（" + generatedPackage + "）：3D 模型没挂，需要的话单独下载。");
    for (const note of fetched.pkg.notes) notes.push(note);
  } else {
    return {
      ...EMPTY,
      error: "KiCad 库里没有这个封装：" + reference + "（在 " + toolchain.footprintDir + " 下找）",
    };
  }

  if (code !== "") {
    const fetched = await fetchLcscProduct(code, { fetchImpl: options.fetchImpl, signal: options.signal });
    if (fetched.ok) {
      if (mpn === "") mpn = fetched.product.mpn;
      brand = fetched.product.brand;
      datasheet = fetched.product.pdfUrl;
    } else if (origin === "kicad") {
      notes.push("没查到立创页面（" + fetched.error + "）：封装照常导入，但来源信息留空。");
    }
  } else {
    notes.push("没有给立创编号：只从 KiCad 库取封装，不查型号与手册。");
  }

  const pads = parseKicadModPads(text);
  if (pads.length === 0) return { ...EMPTY, error: "这个封装里没有焊盘（或焊盘格式不认识）：" + (sourceFile !== "" ? sourceFile : reference) };
  const names = pads.map((pad) => pad.name);

  const library = (
    requestedLibrary !== ""
      ? requestedLibrary
      : origin === "easyeda"
        ? code !== "" ? "jlcpcb_" + code : footprintRef.library
        : footprintRef.library !== ""
          ? footprintRef.library
          : sourceFile !== "" ? basename(dirname(sourceFile), ".pretty") : "local"
  ).trim();
  const footprintName = (requestedName !== "" ? requestedName : footprintRef.name).trim();
  // 库落在 hardware/libs（与手绘层补封装、构建产物同一套约定）；没有 hardware 目录的老工程退回工程根。
  const libsRoot = libsDirOf(existsSync(join(projectDir, "hardware")) ? join(projectDir, "hardware") : projectDir);
  const footprintFile = join(libsRoot, "footprints", library + ".pretty", footprintName + ".kicad_mod");

  // 3D 模型：只搬封装真正引用的那一个文件，路径改成工程内的相对写法。
  const modelRef = parseModelRef(text);
  let modelSource = "";
  let modelFile = "";
  let modelBytes = 0;
  let modelTarget = modelRef;
  if (modelRef !== "") {
    const resolved = resolveModelPath(modelRef, toolchain.model3dDir);
    if (existsSync(resolved)) {
      modelSource = resolved;
      modelFile = join(libsRoot, "3d", library + ".3dshapes", basename(resolved));
      modelBytes = statSync(resolved).size;
      modelTarget = "${KIPRJMOD}/../libs/3d/" + library + ".3dshapes/" + basename(resolved);
    } else {
      notes.push("封装引用了 3D 模型 " + modelRef + "，但在 KiCad 里没找到（找的是 " + resolved + "）：源码保持原路径。");
    }
  } else if (origin === "easyeda" && generatedPackage !== "") {
    notes.push("立创只给了模型名（" + generatedPackage + "），转换器不挂 3D 模型：需要时在 KiCad 里手动挂，或换用官方库封装。");
  }
  const symbolName = displayName(footprintName, mpn);
  const symbolFile = join(libsRoot, "symbols", symbolName + ".kicad_sym");

  const symbol = buildSymbol({
    name: symbolName,
    pins: pads.map((pad) => ({ number: pad.name, name: pad.name })),
  });
  if (!symbol.ok) return { ...EMPTY, error: "符号骨架生成失败：" + symbol.error };

  const written: string[] = [];
  if (options.write === true) {
    mkdirSync(dirname(footprintFile), { recursive: true });
    mkdirSync(dirname(symbolFile), { recursive: true });
    let footprintText = withProperties(text, { code, mpn, brand, datasheet });
    if (modelFile !== "" && modelTarget !== modelRef) {
      footprintText = footprintText.replace('(model "' + modelRef + '"', '(model "' + modelTarget + '"');
      mkdirSync(dirname(modelFile), { recursive: true });
      copyFileSync(modelSource, modelFile);
      written.push(modelFile);
    }
    writeFileSync(footprintFile, footprintText);
    written.push(footprintFile);
    writeFileSync(symbolFile, symbol.text);
    written.push(symbolFile);

    const kicadDir = join(projectDir, "hardware", "kicad");
    if (existsSync(kicadDir)) {
      registerTables(kicadDir, libsRoot, library, symbolName);
      written.push(join(kicadDir, "fp-lib-table"), join(kicadDir, "sym-lib-table"));
    } else {
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
    footprint: {
      library,
      name: footprintName,
      source: origin === "easyeda" ? "easyeda:" + code : sourceFile,
      file: footprintFile,
    },
    symbol: { name: symbolName, file: symbolFile, pins: pads.length },
    model: modelFile === "" ? null : { file: modelFile, source: modelSource, bytes: modelBytes },
    pads: names,
    written,
    notes,
  };
}

/** 把来源信息写进封装的属性里：换机器打开也能看出这是哪个料。 */
export function withProperties(
  modText: string,
  input: { code: string; mpn: string; brand: string; datasheet: string },
): string {
  const entries: string[] = [];
  if (input.code !== "") entries.push('(property "LCSC" "' + input.code + '")');
  if (input.mpn !== "") entries.push('(property "MPN" "' + input.mpn + '")');
  if (input.brand !== "") entries.push('(property "Brand" "' + input.brand + '")');
  if (input.datasheet !== "") entries.push('(property "Datasheet" "' + input.datasheet + '")');
  if (entries.length === 0) return modText;
  const end = modText.lastIndexOf(")");
  if (end < 0) return modText;
  return modText.slice(0, end) + "  " + entries.join("  ") + "\n" + modText.slice(end);
}

/** 登记 `fp-lib-table` 与 `sym-lib-table`：两条都走同一套 `(lib …)` 重建，避免表头重复。 */
function registerTables(kicadDir: string, libsRoot: string, library: string, symbolName: string): void {
  const fpTable = join(kicadDir, "fp-lib-table");
  const fpUri = "${KIPRJMOD}/" + relative(kicadDir, join(libsRoot, "footprints", library + ".pretty")).replace(/\\/gu, "/");
  upsertLibEntries(fpTable, "fp", [{ lib: library, uri: fpUri }]);

  const symTable = join(kicadDir, "sym-lib-table");
  const symUri = "${KIPRJMOD}/" + relative(kicadDir, join(libsRoot, "symbols", symbolName + ".kicad_sym")).replace(/\\/gu, "/");
  upsertLibEntries(symTable, "sym", [{ lib: symbolName, uri: symUri }]);
}
