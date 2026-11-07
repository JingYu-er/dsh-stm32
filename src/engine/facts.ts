import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** facts 包里的语义条目（由 RM 抽取，带页码）。 */
export interface FactsSemantic {
  id: string;
  statement: string;
  source?: { doc?: string; page?: number; section?: string };
  table?: Record<string, unknown>[];
}

export interface FactsPackage {
  schema: number;
  part: string;
  family: string;
  line: string;
  sources?: { kind: string; file?: string; sha256?: string }[];
  registers?: Record<string, { description?: string; fields?: { name: string; bitOffset: number; bitWidth: number }[] }>;
  semantics?: FactsSemantic[];
}

export interface FactsSummary {
  found: boolean;
  path: string;
  part: string;
  line: string;
  /** 语义条数；0 表示只有结构、没有经过 RM 核实的启动/调试事实。 */
  semantics: number;
  /** 有语义才允许给"确定"建议；否则只能只读。 */
  verified: boolean;
  lines: string[];
  needs: string[];
}

/** facts 缓存根（可用 DSH_STM32_FACTS 覆盖）。 */
export function factsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.DSH_STM32_FACTS;
  return custom !== undefined && custom !== "" ? custom : join(homedir(), ".dsh-stm32", "facts");
}

/** STM32C031F6P6 → { family: "c0", line: "STM32C031" }。 */
export function partToFamilyLine(part: string): { family: string; line: string } | null {
  const m = /^STM32([A-Z])(\d)(\d)(\d)/i.exec(part.trim().toUpperCase());
  if (m === null) return null;
  const a = m[1] ?? "";
  const b = m[2] ?? "";
  const c = m[3] ?? "";
  const d = m[4] ?? "";
  if (a === "" || b === "" || c === "" || d === "") return null;
  return { family: "stm32" + (a + b).toLowerCase(), line: "STM32" + a + b + c + d };
}

/** 从工程 .ioc 里读 MCU 型号（Mcu.CPN 或 Mcu.UserName）。 */
export function mcuFromIoc(projectDir: string): string | null {
  try {
    const files = readdirSync(projectDir).filter((name) => name.toLowerCase().endsWith(".ioc"));
    for (const name of files) {
      const text = readFileSync(join(projectDir, name), "utf8");
      const cpn = /^Mcu\.CPN=(.+)$/mu.exec(text)?.[1]?.trim();
      if (cpn !== undefined && cpn !== "") return cpn;
    }
  } catch {
    return null;
  }
  return null;
}

export function readFactsFor(part: string, env: NodeJS.ProcessEnv = process.env): FactsSummary {
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
      needs: ["facts 未生成（可运行 scripts/facts/build-facts.mjs，或提供该线的 RM 手册）"],
    };
  }
  let pkg: FactsPackage;
  try {
    pkg = JSON.parse(readFileSync(file, "utf8")) as FactsPackage;
  } catch (error) {
    return { found: false, path: file, part, line: target.line, semantics: 0, verified: false, lines: [], needs: ["facts.json 解析失败：" + (error instanceof Error ? error.message : String(error))] };
  }
  const semantics = pkg.semantics ?? [];
  const lines: string[] = [];
  for (const item of semantics) {
    const page = item.source?.page === undefined ? "" : "（RM p." + String(item.source.page) + "）";
    lines.push(item.id + "：" + item.statement + page);
    if (Array.isArray(item.table) && item.table.length > 0) {
      lines.push("  " + item.table.map((row) => Object.values(row).join("/")).join(" | "));
    }
  }
  const needs = semantics.length === 0 ? ["本线只有结构、语义未核实：需要该线对应的 RM 手册"] : [];
  return { found: true, path: file, part: pkg.part ?? part, line: pkg.line ?? target.line, semantics: semantics.length, verified: semantics.length > 0, lines, needs };
}

/** 给工具输出用的摘要行（带结论语气）。 */
export function describeFacts(summary: FactsSummary): string[] {
  if (!summary.found) return ["事实层：" + (summary.needs[0] ?? "未生成") + "（只读建议）"];
  if (!summary.verified) return ["事实层：" + summary.line + " 仅结构、无语义（只读建议；" + summary.needs.join("；") + "）"];
  const out = ["事实层：" + summary.line + "（" + String(summary.semantics) + " 条语义，已验证）"];
  for (const line of summary.lines) out.push("  · " + line);
  return out;
}
