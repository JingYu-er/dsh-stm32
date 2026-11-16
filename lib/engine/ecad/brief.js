/**
 * 需求与设计说明的三段文档（S159）。
 *
 * 借鉴「市场 → 需求 → 设计说明」的分段：`docs/01-MRD.md`（为什么做、给谁用、硬约束）、
 * `docs/02-hardware-PRD.md`（要做成什么、电气指标）、`docs/03-design-brief.md`（按什么做）。
 *
 * 这里只做**能自动填**的部分：芯片、时钟、外设、引脚数、板尺寸、元件数、成本都从工程里读；
 * 需求类内容（场景、验收标准）留空位并标「待定」，不替人编。每份文档都分
 * 「已确认事实 / 建议 / 假设 / 待定问题」——这样读者一眼能看出哪些是读出来的、哪些是人拍的。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readPinout } from "../pinout.js";
import { readBoardFacts } from "./dfm.js";
import { readBom } from "./bom.js";
import { findLatestKicadBuild, planEcadWorkspace } from "./tsci.js";
import { resolveProjectLayout } from "../project-layout.js";
function emptyFacts(projectDir, error) {
    return {
        ok: false,
        error,
        projectDir,
        mcu: { cpn: "", name: "", packageName: "" },
        clocks: { sysclkHz: null, apb1Hz: null, apb2Hz: null },
        peripherals: [],
        pinCount: 0,
        nvicCount: 0,
        debugPins: [],
        board: null,
        bom: null,
        notes: [],
    };
}
/** 汇总工程里读得到的事实；缺失的部分不猜，记进 notes。 */
export function collectBriefFacts(projectDir, env = process.env) {
    const dir = projectDir.trim();
    if (dir === "")
        return emptyFacts(dir, "projectDir 不能为空");
    const pinout = readPinout(dir, env);
    if (!pinout.ok)
        return emptyFacts(dir, pinout.error);
    const report = pinout.report;
    const notes = [];
    const layout = resolveProjectLayout(dir);
    const workspace = planEcadWorkspace(dir, layout.hardwareDir);
    const latest = findLatestKicadBuild(workspace);
    let board = null;
    if (latest.ok && latest.pcbFile !== "") {
        try {
            const facts = readBoardFacts(readFileSync(latest.pcbFile, "utf8"));
            board = {
                widthMm: Math.round(facts.widthMm * 10) / 10,
                heightMm: Math.round(facts.heightMm * 10) / 10,
                layers: facts.layers,
                minTrackMm: facts.minTrackMm,
            };
        }
        catch {
            notes.push("板子文件读不了，设计说明里不写尺寸与层数");
        }
    }
    else {
        notes.push("还没有构建产物：设计说明里不写板尺寸、层数与元件数");
    }
    let bom = null;
    if (latest.ok && latest.kicadDir !== "") {
        const report2 = readBom(join(dirname(latest.kicadDir), "circuit.json"));
        if (report2.ok) {
            bom = {
                componentCount: report2.componentCount,
                lines: report2.lines.length,
                partsUsd: report2.partsUsd,
                missingLcsc: report2.missingLcsc,
            };
        }
    }
    const mcu = report.mcu;
    return {
        ok: true,
        error: "",
        projectDir: dir,
        mcu: { cpn: mcu.cpn, name: mcu.name, packageName: mcu.package },
        clocks: { sysclkHz: report.clocks.sysclkHz, apb1Hz: report.clocks.apb1Hz, apb2Hz: report.clocks.apb2Hz },
        peripherals: report.peripherals,
        pinCount: report.pins.length,
        nvicCount: report.nvicCount,
        debugPins: report.debug.pins,
        board,
        bom,
        notes,
    };
}
function mhz(hz) {
    if (hz === null || !Number.isFinite(hz))
        return "未知";
    return String(Math.round((hz / 1_000_000) * 10) / 10) + " MHz";
}
function factsBlock(facts) {
    const lines = [];
    lines.push("- 主控：" + facts.mcu.cpn + (facts.mcu.name !== "" && facts.mcu.name !== facts.mcu.cpn ? "（" + facts.mcu.name + "）" : "") + "，封装 " + (facts.mcu.packageName || "未读到"));
    lines.push("- 时钟：SYSCLK " + mhz(facts.clocks.sysclkHz) + "，APB1 " + mhz(facts.clocks.apb1Hz) + "，APB2 " + mhz(facts.clocks.apb2Hz));
    lines.push("- 已配置外设：" + (facts.peripherals.length === 0 ? "无" : facts.peripherals.join("、")));
    lines.push("- 引脚：" + String(facts.pinCount) + " 个已分配，中断 " + String(facts.nvicCount) + " 条，调试口 " + (facts.debugPins.length === 0 ? "未接" : facts.debugPins.join("/")));
    if (facts.board !== null) {
        lines.push("- 板子：" + String(facts.board.widthMm) + " × " + String(facts.board.heightMm) + " mm，" + String(facts.board.layers) + " 层，最细走线 " + String(facts.board.minTrackMm) + " mm");
    }
    if (facts.bom !== null) {
        lines.push("- 元件：" + String(facts.bom.componentCount) + " 个 / " + String(facts.bom.lines) + " 行，元件成本 $" + facts.bom.partsUsd.toFixed(4) + (facts.bom.missingLcsc > 0 ? "（" + String(facts.bom.missingLcsc) + " 行没有立创编号）" : ""));
    }
    return lines;
}
/** `docs/01-MRD.md`：市场与需求。自动填写只到「已确认事实」，其余留给人。 */
export function renderMrd(facts) {
    const lines = ["# 01 市场需求（MRD）", ""];
    lines.push("> 目的：说清楚「为什么做、给谁用、边界在哪」。硬件指标在 `02-hardware-PRD.md`，实现口径在 `03-design-brief.md`。", "");
    lines.push("## 已确认事实", "", ...factsBlock(facts), "");
    lines.push("## 使用场景", "", "- 待定：谁在什么环境里用它（手持 / 桌面 / 车载 / 电池供电）", "- 待定：连续工作时间、充电还是换电池", "- 待定：人机交互方式（按键 / 屏幕 / 串口 / 无线）", "");
    lines.push("## 硬约束", "", "- 待定：目标成本（BOM + 贴片 + 结构）", "- 待定：外形尺寸上限与安装方式", "- 待定：供电方式与输入范围", "- 待定：认证与合规（CE / FCC / RoHS）", "");
    lines.push("## 假设", "", "- 假设：一次性打样、小批量交付，不做产线治具", "");
    lines.push("## 待定问题", "", "- 待定：验收由谁签字、按什么标准", "");
    lines.push("## 变更记录", "", "| 日期 | 变更 | 依据 |", "| --- | --- | --- |", "| 待填 | 初稿 | 从工程自动生成骨架 |", "");
    return lines.join("\n");
}
/** `docs/02-hardware-PRD.md`：产品需求（电气与接口）。 */
export function renderPrd(facts) {
    const lines = ["# 02 硬件产品需求（PRD）", ""];
    lines.push("> 目的：把 MRD 的场景落成可测的电气与接口指标。数字写不出来就写「待定」，不要留空。", "");
    lines.push("## 已确认事实", "", ...factsBlock(facts), "");
    lines.push("## 功能清单", "");
    const peripherals = facts.peripherals.length === 0 ? ["待定：主功能"] : facts.peripherals.map((name) => "使用 " + name + "：待定（做什么、何时用）");
    for (const item of peripherals)
        lines.push("- " + item);
    lines.push("");
    lines.push("## 电气指标", "", "- 供电：待定（输入电压范围、最大电流、纹波）", "- 主控电流：待定（运行 / 待机 / 睡眠）", "- 接口电平：3.3 V 逻辑；外部接口的耐压与保护待定", "- 时钟精度：待定（内部 RC 还是外部晶振；USB/CAN 必须外接晶振）", "");
    lines.push("## 接口与连接器", "", "- 待定：每个连接器的型号、脚序、线缆长度", "- 调试口：" + (facts.debugPins.length === 0 ? "未接，量产板建议留 SWD" : facts.debugPins.join("/")), "");
    lines.push("## 环境与可靠性", "", "- 待定：工作温度、湿度、ESD 等级", "- 待定：跌落/振动要求", "");
    lines.push("## 假设", "", "- 假设：软件与硬件同版交付，固件版本写在丝印或标签上", "");
    lines.push("## 待定问题", "", "- 待定：是否需要电池与充电管理", "- 待定：是否需要外壳与结构件", "");
    return lines.join("\n");
}
/** `docs/03-design-brief.md`：设计说明（按什么做）。 */
export function renderBrief(facts) {
    const lines = ["# 03 设计说明（design brief）", ""];
    lines.push("> 目的：把 PRD 翻成实现口径——用什么芯片、什么叠层、什么工艺、按什么顺序做。", "");
    lines.push("## 已确认事实", "", ...factsBlock(facts), "");
    lines.push("## 方案", "");
    lines.push("- 主控：" + facts.mcu.cpn + "；调试口 " + (facts.debugPins.length === 0 ? "未接（注意：关掉 Serial Wire 会锁死芯片）" : facts.debugPins.join("/")));
    lines.push("- 时钟：SYSCLK " + mhz(facts.clocks.sysclkHz) + "；外部晶振待定（USB/CAN 必需）");
    lines.push("- 电源树：待定（输入 → 保护 → DC-DC/LDO → 3.3 V；各路电流预算按 PRD 填）");
    lines.push("- 叠层与阻抗：用 `stm32_stackup` 按层数取嘉立创常规叠层，50 Ω 与 90/100 Ω 差分的线宽照它给的值走");
    lines.push("- EMC：用 `stm32_emc` 体检电源线载流与回流缝合；高速线换层处补地过孔");
    lines.push("- 工艺：嘉立创常规档（间距/线宽随层数），DRC 规则由 `stm32_ecad_design` 按层数写进 `.kicad_dru`");
    lines.push("");
    lines.push("## 建议", "");
    lines.push("- 去耦电容贴在对应电源脚 3 mm 内，先过孔再进芯片");
    lines.push("- 晶振与复位靠近主控，晶振下方不走线");
    lines.push("- 关键网络（时钟、差分、复位）尽量短，少换层");
    lines.push("");
    lines.push("## 假设", "");
    lines.push("- 假设：板厂能做嘉立创常规档（线宽 0.1–0.127 mm、间距同档），不做特殊工艺");
    lines.push("- 假设：一次打 5 片，DFM 按小批量估算成本");
    lines.push("");
    lines.push("## 待定问题", "", "- 待定：是否需要屏蔽罩、是否需要三防漆", "- 待定：测试点布置与量产测试方案", "");
    if (facts.notes.length > 0) {
        lines.push("## 生成时的缺口", "");
        for (const note of facts.notes)
            lines.push("- " + note);
        lines.push("");
    }
    return lines.join("\n");
}
/**
 * 写三份文档。已有文件默认不覆盖（`force` 才覆盖）——这些文档是人要接着改的，
 * 自动生成只负责骨架。
 */
export function writeBriefs(projectDir, facts, force = false) {
    const docsDir = join(projectDir, "docs");
    const files = [
        { name: "01-MRD.md", text: renderMrd(facts) },
        { name: "02-hardware-PRD.md", text: renderPrd(facts) },
        { name: "03-design-brief.md", text: renderBrief(facts) },
    ];
    const written = [];
    const skipped = [];
    try {
        mkdirSync(docsDir, { recursive: true });
        for (const file of files) {
            const target = join(docsDir, file.name);
            if (existsSync(target) && !force) {
                skipped.push(target);
                continue;
            }
            writeFileSync(target, file.text, "utf8");
            written.push(target);
        }
    }
    catch (error) {
        return { ok: false, error: "写不了文档：" + (error instanceof Error ? error.message : String(error)), written, skipped };
    }
    return { ok: true, error: "", written, skipped };
}
