import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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
export function readFactsFor(part, env = process.env) {
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
        return ["事实层：" + (summary.needs[0] ?? "未生成") + "（只读建议）"];
    if (!summary.verified)
        return ["事实层：" + summary.line + " 仅结构、无语义（只读建议；" + summary.needs.join("；") + "）"];
    const out = ["事实层：" + summary.line + "（" + String(summary.semantics) + " 条语义，已验证）"];
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
    if (!s.found) {
        // 口径必须跟 flash 的门禁一致：facts 完全不存在时 flash 只提示不拦（§7 已知限制）；
        // 拦的是「facts 存在但语义 0」——那是另一行文案。这里不能吓唬人说会拒烧。
        return ["事实层（RM/SVD）未生成：node scripts/facts/build-facts.mjs --part " + s.part + "——不补也能烧（stm32_flash 对无 facts 的族只提示），但启动/调试门禁类结论没有 RM 依据可查"];
    }
    if (!s.verified) {
        return ["事实层 " + s.line + " 只有结构、语义未核实 → stm32_flash 默认拒烧（allowUnknownFacts=true 可强制）；缺的是该线 RM 的 rm-facts 抽取" + (s.needs.length > 0 ? "（" + s.needs[0] + "）" : "")];
    }
    return ["事实层 " + s.line + " 已核实 " + String(s.semantics) + " 条语义（自举/调试门控/选项字节）→ stm32_flash 不会因只读门禁拦；逐条摘要见 stm32_doctor"];
}
