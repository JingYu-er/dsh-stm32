/**
 * 布线前的设计规则对齐（S149）。
 *
 * KiCad 的网络类写在 `.kicad_pro` 里，布线器从 DSN 读到的间距与线宽就来自这里。
 * tscircuit 生成的工程默认给 0.09 mm，嘉立创常规工艺要求 0.2 mm——不在布线前改，
 * 布出来的线就会「合规于 0.09、违规于 0.2」。这里统一抬到工艺下限，再交给布线器。
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DesignRuleFloor {
  readonly clearanceMm: number;
  readonly trackWidthMm: number;
  readonly viaDiameterMm: number;
  readonly viaDrillMm: number;
}

export const FAB_RULE_FLOOR: DesignRuleFloor = {
  clearanceMm: 0.2,
  trackWidthMm: 0.2,
  viaDiameterMm: 0.6,
  viaDrillMm: 0.3,
};

/**
 * 嘉立创常规档（standard）按层数分档，与 KiCadRoutingTools 的
 * `py_router/fab_tiers.py` 取同一张表：布线器只按这张表布线，且把更高的网络类
 * 当作「理想值」压回档位。规则与布线器同档，DRC 才不会把每根线都判成间距不足。
 */
export function fabFloorForLayers(copperLayers: number): DesignRuleFloor {
  if (copperLayers <= 2) return { clearanceMm: 0.127, trackWidthMm: 0.127, viaDiameterMm: 0.45, viaDrillMm: 0.2 };
  return { clearanceMm: 0.1, trackWidthMm: 0.09, viaDiameterMm: 0.45, viaDrillMm: 0.2 };
}

/**
 * 给 DRC 规则留的量化余量（mm）。
 *
 * 布线器在栅格上落线，实测间距会比档位小 0.5–2.6 µm（0.1000 → 0.0974，最坏落在
 * 过孔与走线的圆角上）。DRC 规则也按精确档位判，这些线就会各报一条 `clearance`；
 * 规则减掉一个量化余量后，判定与布线器实际能做到的几何一致，而名义工艺档
 * （0.1 mm）仍在 DFM 与文档里写明。
 */
export const ROUTER_GRID_MARGIN_MM = 0.003;

/** 供 DRC 规则文件用的档位：名义档减掉量化余量。 */
export function druFloorForLayers(copperLayers: number): DesignRuleFloor {
  const nominal = fabFloorForLayers(copperLayers);
  return { ...nominal, clearanceMm: Math.round((nominal.clearanceMm - ROUTER_GRID_MARGIN_MM) * 1e6) / 1e6 };
}

/** 读 PCB 文件的铜层数；读不到时按 4 层算（多层板的常规档最宽松，不会误判更严）。 */
export function countCopperLayers(kicadDir: string): number {
  let board = "";
  try {
    const name = readdirSync(kicadDir).find((item) => item.endsWith(".kicad_pcb"));
    if (name === undefined) return 4;
    board = readFileSync(join(kicadDir, name), "utf8");
  } catch {
    return 4;
  }
  const block = /\(layers\b([\s\S]*?)\n\s*\)/u.exec(board);
  const text = block === null ? board : (block[1] ?? board);
  const copper = new Set<string>();
  for (const match of text.matchAll(/"((?:F|B|In\d+)\.Cu)"/gu)) copper.add(match[1] ?? "");
  return copper.size === 0 ? 4 : copper.size;
}

export interface DesignRuleReport {
  readonly ok: boolean;
  readonly error: string;
  readonly file: string;
  readonly changed: readonly string[];
  /** 本次对齐用的工艺档；`floor` 字段表示「间距/线宽」，便于调用方写进 notes。 */
  readonly floor: DesignRuleFloor;
}

interface NetClass {
  name?: string;
  clearance?: number;
  track_width?: number;
  via_diameter?: number;
  via_drill?: number;
}

interface ProjectFile {
  net_settings?: { classes?: NetClass[] };
  board?: { design_settings?: { rules?: Record<string, number> } };
}

/** 在目录里找唯一的 `.kicad_pro`。 */
export function findProjectFile(kicadDir: string): string {
  try {
    const name = readdirSync(kicadDir).find((item) => item.endsWith(".kicad_pro"));
    return name === undefined ? "" : join(kicadDir, name);
  } catch {
    return "";
  }
}

/**
 * 把工程里的网络类抬到工艺下限；只升不降，已经更宽的规则保留。
 *
 * 不传 `floor` 时按板子的铜层数取嘉立创常规档——与布线器一致，否则线按 0.1 布、
 * 规则按 0.2 判，会得到满屏 clearance 错误。
 */
export function ensureDesignRules(kicadDir: string, floor?: DesignRuleFloor): DesignRuleReport {
  const target = floor ?? fabFloorForLayers(countCopperLayers(kicadDir));
  const file = findProjectFile(kicadDir);
  if (file === "") return { ok: false, error: "工程里没有 .kicad_pro：" + kicadDir, file: "", changed: [], floor: target };
  let parsed: ProjectFile;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as ProjectFile;
  } catch (error) {
    return { ok: false, error: "读 " + file + " 失败：" + (error instanceof Error ? error.message : String(error)), file, changed: [], floor: target };
  }
  const changed: string[] = [];
  for (const item of parsed.net_settings?.classes ?? []) {
    const name = item.name ?? "Default";
    // 间距必须**对齐**到档位（可升可降）：布线器按档位布线，规则比它严就会整板报
    // 间距不足，比它松则 DRC 形同没查。线宽/过孔只升不降，用户放大过的值保留。
    const align = (key: "clearance" | "track_width" | "via_diameter" | "via_drill", value: number, exact: boolean): void => {
      const current = item[key];
      if (typeof current === "number" && (exact ? current === value : current >= value)) return;
      item[key] = value;
      changed.push(name + "." + key + "=" + String(value));
    };
    align("clearance", target.clearanceMm, true);
    align("track_width", target.trackWidthMm, false);
    align("via_diameter", target.viaDiameterMm, false);
    align("via_drill", target.viaDrillMm, false);
  }
  const rules = parsed.board?.design_settings?.rules;
  if (rules !== undefined) {
    const floors: ReadonlyArray<readonly [string, number, boolean]> = [
      ["min_clearance", target.clearanceMm, true],
      ["min_hole_clearance", target.clearanceMm, true],
      ["min_track_width", target.trackWidthMm, false],
    ];
    for (const [key, value, exact] of floors) {
      const current = rules[key];
      if (typeof current === "number" && (exact ? current === value : current >= value)) continue;
      rules[key] = value;
      changed.push("rules." + key + "=" + String(value));
    }
  }
  if (changed.length > 0) writeFileSync(file, JSON.stringify(parsed, null, "\t"), "utf8");
  return { ok: true, error: "", file, changed, floor: target };
}
