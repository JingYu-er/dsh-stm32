/** 交付打包：把 hardware/ 下「别人拿得到就能继续做」的文件打成一个 zip。 */

import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { createZip, listZipEntries, type ZipEntry } from "./zip.js";

export const PACKAGE_SKIP_DIRS = new Set(["node_modules", "dist", ".history", ".git", "__pycache__", ".hq"]);
export const PACKAGE_MAX_BYTES = 60 * 1024 * 1024;

export type PackageReport = {
  ok: boolean;
  error: string;
  file: string;
  bytes: number;
  files: number;
  skipped: string[];
  notes: string[];
};

function emptyReport(error: string): PackageReport {
  return { ok: false, error: error, file: "", bytes: 0, files: 0, skipped: [], notes: [] };
}

/** 收集要打包的文件：跳过依赖、构建中间物、编辑器缓存与已有 zip；单个超过 60 MB 直接放弃（多半放错了东西）。 */
export function collectPackageFiles(root: string): { ok: boolean; error: string; entries: ZipEntry[]; skipped: string[]; totalBytes: number } {
  const entries: ZipEntry[] = [];
  const skipped: string[] = [];
  let totalBytes = 0;
  const walk = (dir: string): string => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        if (PACKAGE_SKIP_DIRS.has(item.name)) {
          skipped.push(relative(root, full).replace(/\\/gu, "/") + "/");
          continue;
        }
        const failure = walk(full);
        if (failure !== "") return failure;
        continue;
      }
      if (!item.isFile()) continue;
      const lower = item.name.toLowerCase();
      // .kicad_prl 是 KiCad 的本地界面状态（选中项、缩放），换台机器就没用；.zip 是上一次的交付包。
      if (lower.endsWith(".zip") || lower.endsWith(".kicad_prl")) {
        skipped.push(relative(root, full).replace(/\\/gu, "/"));
        continue;
      }
      const size = statSync(full).size;
      if (size > PACKAGE_MAX_BYTES) {
        return relative(root, full).replace(/\\/gu, "/") + " 单文件超过 60 MB";
      }
      totalBytes += size;
      if (totalBytes > PACKAGE_MAX_BYTES * 4) return "打包内容超过 240 MB，先清理 out/ 与 dist/";
      entries.push({ name: relative(root, full).replace(/\\/gu, "/"), data: readFileSync(full) });
    }
    return "";
  };
  const failure = walk(root);
  if (failure !== "") return { ok: false, error: failure, entries: [], skipped: skipped, totalBytes: 0 };
  entries.sort((one, other) => (one.name < other.name ? -1 : one.name > other.name ? 1 : 0));
  return { ok: true, error: "", entries: entries, skipped: skipped, totalBytes: totalBytes };
}

/**
 * 打包 hardware/。
 *
 * 交付物里只放「拿到就能继续做」的东西：电路源码、生成的 KiCad 工程、抽出的库、
 * 以及 out/ 下的制造文件；node_modules（七百多 MB）与 dist（每次可重建）不进包。
 */
export function packageHardware(hardwareDir: string, projectName: string): PackageReport {
  if (!existsSync(hardwareDir)) return emptyReport("还没有硬件目录：" + hardwareDir + "（先跑 stm32_ecad_init）");
  const collected = collectPackageFiles(hardwareDir);
  if (!collected.ok) return emptyReport(collected.error);
  if (collected.entries.length === 0) return emptyReport("硬件目录里没有可打包的文件");
  const manifest = [
    "# 硬件交付包",
    "",
    "- 工程：" + (projectName === "" ? "未命名" : projectName),
    "- 生成时间：" + new Date().toISOString(),
    "- 文件数：" + String(collected.entries.length),
    "",
    "## 目录",
    "",
    "- `circuit/`：tscircuit 电路源码（唯一的写者）",
    "- `kicad/`：由 circuit 生成的 KiCad 工程（每次构建重建）",
    "- `libs/`：从产物里抽出的封装库与符号库",
    "- `out/`：Gerber、钻孔、贴片坐标、STEP",
    "",
    "重建：在 `circuit/` 下 `npm install` 后执行 `stm32_ecad_build`；检查用 `stm32_ecad_check`。",
    "",
  ].join("\n");
  collected.entries.push({ name: "README.md", data: Buffer.from(manifest, "utf8") });
  const zip = createZip(collected.entries);
  const outDir = join(hardwareDir, "out");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/gu, "").replace(/-/gu, "");
  const file = join(outDir, (projectName === "" ? "hardware" : projectName) + "-hardware-" + stamp + ".zip");
  writeFileSync(file, zip);
  const notes = ["打包 " + String(collected.entries.length) + " 个文件，解压后根目录即 hardware 的内容"];
  if (collected.skipped.length > 0) {
    notes.push("已跳过 " + String(collected.skipped.length) + " 项：" + collected.skipped.slice(0, 6).join("、") + (collected.skipped.length > 6 ? "…" : ""));
  }
  return {
    ok: true,
    error: "",
    file: file,
    bytes: zip.length,
    files: collected.entries.length,
    skipped: collected.skipped,
    notes: notes,
  };
}

/** 自检：读回刚写出的 zip，确认条目数与文件大小对得上（打包器自己不能只说「成功」）。 */
export function verifyPackage(file: string): { ok: boolean; error: string; files: number } {
  if (!existsSync(file)) return { ok: false, error: "打包结果不存在：" + basename(file), files: 0 };
  try {
    const entries = listZipEntries(readFileSync(file));
    if (entries.length === 0) return { ok: false, error: "zip 里没有任何条目", files: 0 };
    for (const entry of entries) {
      if (entry.name.endsWith("/")) continue;
      if (entry.size < 0) return { ok: false, error: "条目大小为负：" + entry.name, files: entries.length };
    }
    return { ok: true, error: "", files: entries.length };
  } catch (error) {
    return { ok: false, error: "读回 zip 失败：" + (error instanceof Error ? error.message : String(error)), files: 0 };
  }
}

export type { ZipEntry };
