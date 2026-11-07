import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadRmTopics } from "../data/rm-topics.js";
/** facts 缓存根（可用 DSH_STM32_FACTS 覆盖）。 */
export function factsRoot(env = process.env) {
    const custom = env.DSH_STM32_FACTS;
    return custom !== undefined && custom !== "" ? custom : join(homedir(), ".dsh-stm32", "facts");
}
/** STM32C031F6P6 → { family: "c0", line: "STM32C031" }。 */
export function partToFamilyLine(part) {
    const m = /^STM32([A-Z])(\d)(\d)(\d)/i.exec(part.trim().toUpperCase());
    if (m === null)
        return null;
    const a = m[1] ?? "";
    const b = m[2] ?? "";
    const c = m[3] ?? "";
    const d = m[4] ?? "";
    if (a === "" || b === "" || c === "" || d === "")
        return null;
    return { family: "stm32" + (a + b).toLowerCase(), line: "STM32" + a + b + c + d };
}
/** 从工程 .ioc 里读 MCU 型号（Mcu.CPN 或 Mcu.UserName）。 */
export function mcuFromIoc(projectDir) {
    try {
        const files = readdirSync(projectDir).filter((name) => name.toLowerCase().endsWith(".ioc"));
        for (const name of files) {
            const text = readFileSync(join(projectDir, name), "utf8");
            const cpn = /^Mcu\.CPN=(.+)$/mu.exec(text)?.[1]?.trim();
            if (cpn !== undefined && cpn !== "")
                return cpn;
        }
    }
    catch {
        return null;
    }
    return null;
}
/** 给 summary 补 spec/载体两个维度（readFactsFor 的每条出口都过这里）。 */
function withSpecFields(s, part, env) {
    const t = partToFamilyLine(part);
    if (t === null)
        return { ...s, hasSpec: false, rmPath: "" };
    const loaded = loadRmTopics(t.family, t.line, factsRoot(env));
    let rmPath = "";
    try {
        const raw = JSON.parse(readFileSync(join(factsRoot(env), t.family, t.line, "facts.json"), "utf8"));
        const pdf = (raw.sources ?? []).find((x) => x.kind === "rm-pdf" && typeof x.path === "string" && existsSync(x.path));
        rmPath = typeof pdf?.path === "string" ? pdf.path : "";
    }
    catch {
        // facts 还没生成或读不动：rmPath 保持空串，不影响门禁
    }
    return { ...s, hasSpec: loaded.hasSpec, rmPath };
}
export function readFactsFor(part, env = process.env) {
    return withSpecFields(readFactsRaw(part, env), part, env);
}
function readFactsRaw(part, env) {
    const target = partToFamilyLine(part);
    if (target === null) {
        return { found: false, path: "", part, line: "", semantics: 0, verified: false, lines: [], needs: ["无法从型号 " + part + " 解析出族/线"] };
    }
    const file = join(factsRoot(env), target.family, target.line, "facts.json");
    if (!existsSync(file)) {
        return {
            found: false,
            path: file,
            part: part.toUpperCase(),
            line: target.line,
            semantics: 0,
            verified: false,
            lines: [],
            needs: ["facts 未生成：node scripts/facts/build-facts.mjs --part " + part.toUpperCase() + "（SVD 会自动本地找→下载缓存→联网取；语义另需该线 rm-facts）"],
        };
    }
    let pkg;
    try {
        pkg = JSON.parse(readFileSync(file, "utf8"));
    }
    catch (error) {
        return { found: false, path: file, part, line: target.line, semantics: 0, verified: false, lines: [], needs: ["facts.json 解析失败：" + (error instanceof Error ? error.message : String(error))] };
    }
    const semantics = pkg.semantics ?? [];
    const lines = [];
    for (const item of semantics) {
        const page = item.source?.page === undefined ? "" : "（RM p." + String(item.source.page) + "）";
        lines.push(item.id + "：" + item.statement + page);
        if (Array.isArray(item.table) && item.table.length > 0) {
            lines.push("  " + item.table.map((row) => Object.values(row).join("/")).join(" | "));
        }
    }
    const declared = Array.isArray(pkg.needs) ? pkg.needs.filter((n) => typeof n === "string" && n !== "") : [];
    const needs = semantics.length === 0
        ? (declared.length > 0 ? declared : ["本线只有结构、语义未核实：需要该线对应的 RM 手册与 rm-facts 抽取"])
        : declared;
    return { found: true, path: file, part: pkg.part ?? part, line: pkg.line ?? target.line, semantics: semantics.length, verified: semantics.length > 0, lines, needs };
}
/** 给工具输出用的摘要行（带结论语气）。 */
export function describeFacts(summary) {
    if (!summary.found)
        return ["事实层：" + (summary.needs[0] ?? "未生成") + (summary.hasSpec ? "（这颗芯片有清单，烧录门禁会拦）" : "（这颗芯片没清单，不拦烧录）")];
    const rm = summary.rmPath === "" ? "" : "｜RM 载体本地路径：" + summary.rmPath;
    if (!summary.verified) {
        if (summary.hasSpec)
            return ["事实层：" + summary.line + " 有清单但机检没过：" + summary.needs.join("；") + "（stm32_flash 拒烧，allowUnknownFacts=true 可强制）" + rm];
        return ["事实层：" + summary.line + " 仅结构、无主题清单：不拦烧录" + rm];
    }
    const out = ["事实层：" + summary.line + "（" + String(summary.semantics) + " 条语义，已验证）" + rm];
    for (const line of summary.lines)
        out.push("  · " + line);
    return out;
}
/**
 * 给 stm32_generate / stm32_project_create 用的「生成前风险」一行式摘要。
 * 与 describeFacts（doctor/flash 的多行详单）不同口径：这里只回答一件事——
 * 生成完这块板，烧录门禁会不会拦、缺什么。三态各一句，found=false 也给指路命令。
 */
export function generationRiskNotes(part, env = process.env) {
    if (part === null || part.trim() === "")
        return [];
    const s = readFactsFor(part, env);
    const rm = s.rmPath === "" ? "" : "；RM 载体：本地 " + s.rmPath + "（调试怪行为可 pdf_scan/pdf_read_page 反查原文）";
    if (s.found && s.verified) {
        return ["事实层 " + s.line + " 已核实 " + String(s.semantics) + " 条语义（自举/调试门控/选项字节）→ stm32_flash 不会因只读门禁拦；逐条摘要见 stm32_doctor" + rm];
    }
    if (s.hasSpec) {
        return ["事实层 " + (s.found ? s.line : part) + " 有 rm-topics 主题清单但机检没过/书没建起来 → stm32_flash 会拒烧（allowUnknownFacts=true 可强制）" + (s.needs.length > 0 ? "：" + s.needs[0] : "") + rm];
    }
    if (!s.found) {
        return ["事实层（RM/SVD）未生成（stm32_flash 对没清单的芯片只提示不拦；工具会自动补，补失败多半是离线，可跑 build-facts.mjs --part " + s.part + "）"];
    }
    return ["事实层 " + s.line + " 只有结构、没有主题清单：不拦烧录，直接烧即可" + rm];
}
