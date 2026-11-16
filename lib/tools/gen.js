/**
 * L3：符号与封装生成工具（S164）。
 *
 *   stm32_symbol_footprint  action=symbol 出 `.kicad_sym`；action=footprint 出 `.kicad_mod`
 *
 * 为什么单独成工具：它不读工程、不依赖 KiCad，只吃「引脚表」或「封装尺寸」这两组数。
 * 数据来自手册（`stm32_pdf_read` 的 table）或人量的尺寸，生成只是排版与坐标算术；
 * 尺寸缺一个就报错，不拿型号去猜。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { buildFootprint } from "../engine/ecad/gen/footprint.js";
import { buildSymbol } from "../engine/ecad/gen/symbol.js";
import { resolveProjectDir } from "./project-dir.js";
export const GEN_TOOL = "stm32_symbol_footprint";
const PIN_KINDS = ["input", "output", "bidirectional", "power_in", "passive", "unspecified"];
const FOOTPRINT_KINDS = ["qfp", "soic", "passive"];
export function registerGenTools(ctx) {
    ctx.tools.register({
        name: GEN_TOOL,
        description: "按引脚表生成 KiCad 符号（.kicad_sym），或按封装尺寸生成封装（.kicad_mod）。只做矩形本体 + 左右两列引脚、QFP/SOIC/两脚小件三类封装；尺寸与引脚号必须由调用方给出，缺一个就报错，不按型号猜。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                action: { type: "string", enum: ["symbol", "footprint"], description: "生成符号还是封装。" },
                projectDir: { type: "string", description: "工程根目录（saveAs 的相对路径按它解析）；缺省为当前调试会话的工程。" },
                name: { type: "string", description: "符号名或封装名，例如 STM32F103C8T6、LQFP-48_7x7_P0.5mm。" },
                pins: {
                    type: "array",
                    description: "action=symbol 时的引脚表；顺序即画法顺序（左列先，右列接续）。",
                    items: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            number: { type: "string", description: "引脚编号，例如 1、A1。" },
                            name: { type: "string", description: "引脚名，例如 PA0、VDD。" },
                            kind: { type: "string", enum: [...PIN_KINDS], description: "引脚类型；不给写 unspecified。" },
                        },
                        required: ["number", "name"],
                    },
                },
                bodyWidthMm: { type: "number", description: "本体宽（mm）；符号不给按最长引脚名推，封装必填。" },
                bodyHeightMm: { type: "number", description: "本体高（mm）；双列封装不给按 pitch 推。" },
                kind: { type: "string", enum: [...FOOTPRINT_KINDS], description: "封装类型：qfp / soic / passive。" },
                pinCount: { type: "number", description: "封装引脚总数（qfp 要 4 的倍数、soic 要 2 的倍数）。" },
                pitch: { type: "number", description: "引脚间距（mm）。" },
                padWidthMm: { type: "number", description: "焊盘沿引脚方向的长度（mm）。" },
                padHeightMm: { type: "number", description: "焊盘宽度（mm）。" },
                padOffsetMm: { type: "number", description: "焊盘中心到本体中心的距离（mm）；不给按本体与焊盘推。" },
                referencePrefix: { type: "string", description: "符号的参考位号前缀，默认 U。" },
                saveAs: { type: "string", description: "落盘路径（相对工程根），例如 libs/mcu.kicad_sym；不给只回文本。" },
            },
            required: ["action", "name"],
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    ok: { type: "boolean" },
                    error: { type: "string" },
                    action: { type: "string" },
                    name: { type: "string" },
                    savedTo: { type: "string" },
                    bytes: { type: "number" },
                    pinCount: { type: "number" },
                    bodyWidthMm: { type: "number" },
                    bodyHeightMm: { type: "number" },
                    text: { type: "string" },
                    notes: { type: "array", items: { type: "string" } },
                },
                required: ["ok", "error", "action", "name", "savedTo", "bytes", "pinCount", "bodyWidthMm", "bodyHeightMm", "text", "notes"],
            },
            render: (_args, value) => {
                const result = value;
                if (!result.ok)
                    return [{ type: "text", text: "生成失败：" + result.error }];
                const what = result.action === "symbol" ? "符号" : "封装";
                const lines = [
                    what + " " + result.name + " · 引脚 " + String(result.pinCount) + " 个" +
                        (result.bodyWidthMm > 0 ? " · 本体 " + String(result.bodyWidthMm) + " × " + String(result.bodyHeightMm) + " mm" : ""),
                ];
                if (result.savedTo !== "")
                    lines.push("已写：" + result.savedTo + "（" + String(result.bytes) + " B）");
                for (const note of result.notes)
                    lines.push("· " + note);
                return [{ type: "text", text: lines.join("\n") }];
            },
        },
        timeoutMs: 30_000,
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const action = typeof args.action === "string" ? args.action : "";
            const name = typeof args.name === "string" ? args.name.trim() : "";
            const base = {
                ok: false,
                error: "",
                action,
                name,
                savedTo: "",
                bytes: 0,
                pinCount: 0,
                bodyWidthMm: 0,
                bodyHeightMm: 0,
                text: "",
                notes: [],
            };
            if (action !== "symbol" && action !== "footprint") {
                return { ...base, error: "action 只能是 symbol 或 footprint" };
            }
            if (action === "footprint" && (args.kind === undefined || !FOOTPRINT_KINDS.includes(args.kind))) {
                return { ...base, error: "生成封装要指定 kind：qfp / soic / passive" };
            }
            const built = action === "symbol"
                ? buildSymbol({
                    name,
                    pins: Array.isArray(args.pins) ? args.pins : [],
                    ...(typeof args.bodyWidthMm === "number" ? { bodyWidthMm: args.bodyWidthMm } : {}),
                    ...(typeof args.referencePrefix === "string" ? { referencePrefix: args.referencePrefix } : {}),
                })
                : buildFootprint(footprintSpecOf(args, name));
            if (!built.ok)
                return { ...base, error: built.error };
            const result = {
                ...base,
                ok: true,
                pinCount: built.pinCount,
                bodyWidthMm: "bodyWidthMm" in built ? built.bodyWidthMm : 0,
                bodyHeightMm: "bodyHeightMm" in built ? built.bodyHeightMm : 0,
                text: built.text,
                notes: [...built.notes],
            };
            if (typeof args.saveAs !== "string" || args.saveAs.trim() === "")
                return result;
            const project = await resolveProjectDir(ctx, args.projectDir, exec);
            const root = project.projectDir !== "" ? project.projectDir : process.cwd();
            const target = isAbsolute(args.saveAs.trim()) ? args.saveAs.trim() : resolve(root, args.saveAs.trim());
            try {
                mkdirSync(dirname(target), { recursive: true });
                writeFileSync(target, built.text, "utf8");
            }
            catch (error) {
                return { ...result, ok: false, error: "写不进 " + target + "：" + (error instanceof Error ? error.message : String(error)) };
            }
            return { ...result, savedTo: target, bytes: Buffer.byteLength(built.text, "utf8") };
        },
    });
}
function footprintSpecOf(args, name) {
    const kind = args.kind;
    if (kind === undefined || !FOOTPRINT_KINDS.includes(kind)) {
        return { kind: "qfp", name, pins: 0 };
    }
    return {
        kind,
        name,
        ...(typeof args.pinCount === "number" ? { pins: args.pinCount } : {}),
        ...(typeof args.pitch === "number" ? { pitch: args.pitch } : {}),
        ...(typeof args.bodyWidthMm === "number" ? { bodyWidthMm: args.bodyWidthMm } : {}),
        ...(typeof args.bodyHeightMm === "number" ? { bodyHeightMm: args.bodyHeightMm } : {}),
        ...(typeof args.padWidthMm === "number" ? { padWidthMm: args.padWidthMm } : {}),
        ...(typeof args.padHeightMm === "number" ? { padHeightMm: args.padHeightMm } : {}),
        ...(typeof args.padOffsetMm === "number" ? { padOffsetMm: args.padOffsetMm } : {}),
    };
}
