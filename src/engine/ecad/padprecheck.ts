import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 封装焊盘预检（S130）。
 *
 * KiCad 官方 USB-C 这类 16P 封装，把 A/B 两排触点拆成了同坐标的两个独立脚
 * （A1 与 B12 等），tscircuit 的自动布线器没法把同坐标的两个 port 归到唯一焊盘，
 * 直接抛错并整板放弃布线，看起来像「一半网络没连上」。
 *
 * 这里在构建前把同一份 .kicad_mod 拿下来数一遍：同坐标的脚列出来，
 * 由构建降级为「只摆件不布线」，并把原因写清楚。
 */

export interface ModPad {
  name: string;
  x: number;
  y: number;
}

export interface PadBlocker {
  ref: string;
  pairs: string[][];
}

export interface PadPrecheckReport {
  ok: boolean;
  error: string;
  checked: number;
  blockers: PadBlocker[];
  notes: string[];
}

const FOOTPRINT_REF = /footprint\s*=\s*[{]?\s*["'`]kicad:([A-Za-z0-9_.\-/]+)["'`]/gu;

/** 从 .circuit.tsx 里收集 `footprint="kicad:Lib/Name"` 的引用。 */
export function collectKicadFootprintRefs(tsx: string): string[] {
  const found = new Set<string>();
  let match = FOOTPRINT_REF.exec(tsx);
  while (match !== null) {
    found.add(match[1] ?? "");
    match = FOOTPRINT_REF.exec(tsx);
  }
  return [...found].filter((item) => item !== "");
}

/**
 * 解析 .kicad_mod 里的焊盘坐标。
 *
 * 只取「脚号 + 坐标」两项：这两个字段在 KiCad 各版本的写法稳定，
 * 形状、层、圆角都不影响预检判据。
 */
export function parseKicadModPads(text: string): ModPad[] {
  const pads: ModPad[] = [];
  const pattern = /\(pad\s+"([^"]*)"[\s\S]*?\(at\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/gu;
  let match = pattern.exec(text);
  while (match !== null) {
    const name = match[1] ?? "";
    if (name !== "") {
      pads.push({ name, x: Number(match[2]), y: Number(match[3]) });
    }
    match = pattern.exec(text);
  }
  return pads;
}

/** 同坐标（0.01 mm 内）的焊盘分组，只返回 ≥2 个脚的组。 */
export function coincidentGroups(pads: readonly ModPad[], tolerance = 0.01): string[][] {
  const buckets = new Map<string, string[]>();
  for (const pad of pads) {
    const key = `${Math.round(pad.x / tolerance)},${Math.round(pad.y / tolerance)}`;
    buckets.set(key, [...(buckets.get(key) ?? []), pad.name]);
  }
  return [...buckets.values()].filter((names) => names.length > 1);
}

/** 封装缓存目录：与数据手册缓存并列，落在插件自己的家目录下。 */
export function footprintCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env["DSH_STM32_FOOTPRINTS"] ?? "").trim();
  if (override !== "") return override;
  const home = (env["DSH_STM32_HOME"] ?? "").trim() || join(homedir(), ".dsh-stm32");
  return join(home, "kicad-mod-cache");
}

function cachePath(dir: string, ref: string): string {
  const digest = createHash("sha1").update(ref).digest("hex").slice(0, 12);
  return join(dir, `${digest}.kicad_mod`);
}

export interface PrecheckOptions {
  fetchImpl?: typeof fetch;
  cacheDir?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function loadMod(ref: string, options: PrecheckOptions): Promise<string> {
  const dir = options.cacheDir ?? footprintCacheDir();
  const file = cachePath(dir, ref);
  if (existsSync(file)) return readFileSync(file, "utf8");
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `https://kicad-mod-cache.tscircuit.com/${ref}.kicad_mod`;
  const response = await fetchImpl(url, {
    signal: options.signal,
    headers: { "user-agent": "dsh-stm32 footprint precheck" },
  });
  if (!response.ok) {
    throw new Error(`取封装失败（HTTP ${response.status}）：${url}`);
  }
  const text = await response.text();
  if (!text.includes("(footprint")) throw new Error(`取到的不是 .kicad_mod：${url}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, text, "utf8");
  return text;
}

/**
 * 预检一个工程的封装：列出同坐标焊盘。
 *
 * 单个封装取不到（网络或库里没有）只记 note，不阻断构建——
 * 预检是为了把「布线器为什么放弃」说清楚，不是构建的前置条件。
 */
export async function precheckFootprints(
  tsxFile: string,
  options: PrecheckOptions = {},
): Promise<PadPrecheckReport> {
  const notes: string[] = [];
  let tsx = "";
  try {
    tsx = readFileSync(tsxFile, "utf8");
  } catch (error) {
    return {
      ok: false,
      error: `读不到电路源码：${error instanceof Error ? error.message : String(error)}`,
      checked: 0,
      blockers: [],
      notes,
    };
  }
  const refs = collectKicadFootprintRefs(tsx);
  if (refs.length === 0) {
    return { ok: true, error: "", checked: 0, blockers: [], notes: ["电路里没有 kicad: 封装引用"] };
  }
  const blockers: PadBlocker[] = [];
  let checked = 0;
  for (const ref of refs) {
    try {
      const pads = parseKicadModPads(await loadMod(ref, options));
      checked += 1;
      const pairs = coincidentGroups(pads);
      if (pairs.length > 0) blockers.push({ ref, pairs });
    } catch (error) {
      notes.push(`封装 ${ref} 没预检到：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (blockers.length > 0) {
    const first = blockers[0];
    notes.push(
      `封装 ${first?.ref ?? ""} 有 ${String(first?.pairs.length ?? 0)} 组同坐标焊盘（${(first?.pairs ?? [])
        .map((pair) => pair.join("/"))
        .join("、")}）：自动布线器会放弃整板布线`,
    );
  }
  return { ok: true, error: "", checked, blockers, notes };
}
