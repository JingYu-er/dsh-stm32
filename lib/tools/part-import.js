/**
 * S173：器件导入工具。
 *
 *   stm32_part_import  footprint=Package_SO:SOIC-8_3.9x4.9mm_P1.27mm  code=C25137  write=true
 *
 * 把 KiCad 官方库里的封装收进工程自己的库，按焊盘生成符号骨架，并登记两张库表。
 * 立创编号只用来查型号/品牌/手册；查不到不阻断，但会在 notes 里说清楚。
 */
import { importPart } from "../engine/ecad/part-import.js";
import { locateEcadToolchain } from "../engine/ecad/toolchain.js";
import { resolveProjectDir } from "./project-dir.js";
export const PART_IMPORT_TOOL = "stm32_part_import";
export function registerPartImportTools(ctx) {
    ctx.tools.register({
        name: PART_IMPORT_TOOL,
        description: "把封装导入工程：优先从 KiCad 官方库复制 .kicad_mod；库里没有但给了立创编号时，从立创页面取封装图形转成 .kicad_mod（source=lcsc 可强制走这条路）。按焊盘生成符号骨架到 hardware/libs/symbols，并登记 fp-lib-table/sym-lib-table。默认只做预先检查，write=true 才写文件。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                projectDir: { type: "string", description: "工程根目录；缺省为当前调试会话的工程。" },
                footprint: {
                    type: "string",
                    description: "源封装，Lib:Name 形式（如 Package_SO:SOIC-8_3.9x4.9mm_P1.27mm）；只给 Name 时在库里按名字找。",
                },
                code: { type: "string", description: "立创编号（如 C25137）：用来查型号/品牌/手册，也是库里没有封装时的回退来源。" },
                source: {
                    type: "string",
                    enum: ["auto", "kicad", "lcsc"],
                    description: "封装从哪来：auto（默认，先库后立创）/ kicad（只查官方库）/ lcsc（只从立创页面转）。",
                },
                library: { type: "string", description: "收进工程后的库名，默认沿用源库名。" },
                name: { type: "string", description: "收进工程后的封装名与符号名，默认沿用源封装名。" },
                write: { type: "boolean", description: "true 才真的写文件与登记库表；默认只回计划。" },
            },
            required: ["footprint"],
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    ok: { type: "boolean" },
                    error: { type: "string" },
                    code: { type: "string" },
                    mpn: { type: "string" },
                    brand: { type: "string" },
                    datasheet: { type: "string" },
                    library: { type: "string" },
                    footprintName: { type: "string" },
                    source: { type: "string" },
                    footprintFile: { type: "string" },
                    symbolFile: { type: "string" },
                    padCount: { type: "number" },
                    pads: { type: "array", items: { type: "string" } },
                    written: { type: "array", items: { type: "string" } },
                    notes: { type: "array", items: { type: "string" } },
                },
                required: [
                    "ok",
                    "error",
                    "code",
                    "mpn",
                    "brand",
                    "datasheet",
                    "library",
                    "footprintName",
                    "source",
                    "footprintFile",
                    "symbolFile",
                    "padCount",
                    "pads",
                    "written",
                    "notes",
                ],
            },
            render: (_args, value) => {
                const result = value;
                if (!result.ok)
                    return [{ type: "text", text: "导入失败：" + result.error }];
                const head = (result.code !== "" ? result.code + " " : "") +
                    (result.mpn !== "" ? result.mpn + " " : "") +
                    (result.brand !== "" ? "（" + result.brand + "）" : "") +
                    "· 封装 " + result.library + ":" + result.footprintName + " · 焊盘 " + String(result.padCount) + " 个";
                const lines = [head.trim()];
                if (result.source.startsWith("easyeda:"))
                    lines.push("封装来源：立创页面 " + result.source.slice("easyeda:".length));
                if (result.datasheet !== "")
                    lines.push("手册：" + result.datasheet);
                lines.push(result.written.length > 0 ? "已写：" : "将写（还没有落盘）：");
                lines.push("  封装：" + result.footprintFile);
                lines.push("  符号：" + result.symbolFile);
                for (const file of result.written.slice(2))
                    lines.push("  库表：" + file);
                for (const note of result.notes)
                    lines.push("· " + note);
                return [{ type: "text", text: lines.join("\n") }];
            },
        },
        timeoutMs: 60_000,
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const project = await resolveProjectDir(ctx, args.projectDir, exec);
            const projectDir = project.projectDir;
            if (projectDir === "") {
                return {
                    ok: false,
                    error: "没有工程目录：从工具栏「工程」下拉里选一个，或先打开调试会话。",
                    code: "",
                    mpn: "",
                    brand: "",
                    datasheet: "",
                    library: "",
                    footprintName: "",
                    source: "",
                    footprintFile: "",
                    symbolFile: "",
                    padCount: 0,
                    pads: [],
                    written: [],
                    notes: [],
                };
            }
            const located = locateEcadToolchain();
            if (!located.ok || located.toolchain === null) {
                return {
                    ok: false,
                    error: "找不到 KiCad：" + located.error + "（封装来源是 KiCad 官方库，需要先装 KiCad）",
                    code: "",
                    mpn: "",
                    brand: "",
                    datasheet: "",
                    library: "",
                    footprintName: "",
                    source: "",
                    footprintFile: "",
                    symbolFile: "",
                    padCount: 0,
                    pads: [],
                    written: [],
                    notes: [],
                };
            }
            const report = await importPart(projectDir, located.toolchain, {
                footprint: (args.footprint ?? "").trim(),
                code: (args.code ?? "").trim(),
                source: args.source ?? "auto",
                library: (args.library ?? "").trim(),
                name: (args.name ?? "").trim(),
                write: args.write === true,
            });
            return {
                ok: report.ok,
                error: report.error,
                code: report.code,
                mpn: report.mpn,
                brand: report.brand,
                datasheet: report.datasheet,
                library: report.footprint?.library ?? "",
                footprintName: report.footprint?.name ?? "",
                source: report.footprint?.source ?? "",
                footprintFile: report.footprint?.file ?? "",
                symbolFile: report.symbol?.file ?? "",
                padCount: report.pads.length,
                pads: [...report.pads],
                written: [...report.written],
                notes: [...report.notes],
            };
        },
    });
}
