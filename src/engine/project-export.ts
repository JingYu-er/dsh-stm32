/**
 * L2：工程交付（export）—— 把「能编译的工程」变成「别人拿到就能用」的一个 zip。
 *
 * 两条铁律（P1-4）：
 *  1. build/ 绝不进包：CMakeCache.txt / build.ninja / compile_commands.json 里全是
 *     本机绝对路径，拷到别人机器上 cmake 退出码 0 但产物是旧的（实测），比不带还糟。
 *  2. 两种意图分开：「拿到就能烧」带 prebuilt/（elf/hex/bin），「拿到就能改」绝不能带 build 缓存。
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { detectBuildDir, findElf } from "./build.js";

export interface ExportRequest {
  projectDir: string;
  /** zip 输出目录；默认工程目录同级。 */
  outDir?: string;
  /** 是否把编译产物（elf/hex/bin）拷进包里的 prebuilt/。 */
  includePrebuilt?: boolean;
  /** 是否自动写包内 README（怎么编译、build/ 为什么不在）。默认开。 */
  readme?: boolean;
  /** 注入打包实现（测试用）；默认走 zip.ts。 */
  zipImpl?: (outPath: string, sources: Map<string, string>) => Promise<void>;
  /** 取消信号：收集文件前与打包前各查一次（导出要读遍整个工程，大工程不该点了取消还在跑）。 */
  signal?: AbortSignal;
}

export interface ExportReport {
  ok: boolean;
  projectDir: string;
  zipPath: string;
  zipBytes: number;
  fileCount: number;
  prebuilt: { path: string; size: number }[];
  durationMs: number;
  message: string;
  notes: string[];
}

/** 进包的排除目录：构建缓存（绝对路径雷区）、插件备份、git、node_modules。 */
const SKIP_DIRS = new Set(["build", ".dsh-stm32", "node_modules", ".git"]);

function collectSources(projectDir: string): Map<string, string> {
  const sources = new Map<string, string>();
  const walk = (dir: string, relDir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = relDir === "" ? entry.name : relDir + "/" + entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name), rel);
      } else {
        sources.set(rel, join(dir, entry.name));
      }
    }
  };
  walk(projectDir, "");
  return sources;
}

function readmeText(projectName: string, prebuilt: string[], includePrebuilt: boolean): string {
  const lines: string[] = [
    "# " + projectName,
    "",
    "由 dsh-stm32 插件导出（stm32_project_export）。",
    "",
    "## 拿到就能改",
    "",
    "用 CMake 正常配置编译即可（VS Code CMake Tools 或 cmake --preset Debug）。",
    "",
    "build/ 不在包里是有意的：CMakeCache.txt 记录的是原机器的绝对路径，",
    "拷贝过去的 build 目录会让 cmake 静默用旧缓存编译出旧产物。",
    "",
  ];
  if (includePrebuilt && prebuilt.length > 0) {
    lines.push("## 拿到就能烧（prebuilt/）");
    lines.push("");
    // 包里这些文件在 prebuilt/ 下，README 里的路径要对得上（别让人按裸文件名去找）。
    for (const name of prebuilt) lines.push("- prebuilt/" + name);
    lines.push("");
    lines.push("用 STM32CubeProgrammer / J-Flash / openocd 直接烧；改过源码后请重新编译再烧。");
  } else {
    lines.push("## 烧录");
    lines.push("");
    lines.push("包里没带预编译产物：先编译得到 .elf 再烧。");
  }
  return lines.join("\n");
}

export async function runExport(request: ExportRequest): Promise<ExportReport> {
  const startedAt = Date.now();
  const projectDir = resolve(request.projectDir);
  const projectName = basename(projectDir);
  const fail = (message: string): ExportReport => ({
    ok: false, projectDir, zipPath: "", zipBytes: 0, fileCount: 0, prebuilt: [],
    durationMs: Date.now() - startedAt, message, notes: [],
  });
  const cancelled = (): boolean => request.signal !== undefined && request.signal.aborted;
  if (!existsSync(projectDir)) return fail("工程目录不存在：" + projectDir);
  if (cancelled()) return fail("已取消：没有生成 zip（连文件都没开始收集）。");

  const includePrebuilt = request.includePrebuilt === true;
  const prebuilt: { path: string; size: number }[] = [];
  const buildDir = detectBuildDir(projectDir) ?? "";
  if (includePrebuilt && buildDir !== "") {
    const elf = findElf(buildDir);
    if (elf !== null) {
      prebuilt.push({ path: elf.path, size: elf.size });
      for (const ext of ["hex", "bin"]) {
        const candidate = elf.path.replace(/\.elf$/u, "") + "." + ext;
        if (existsSync(candidate)) prebuilt.push({ path: candidate, size: statSync(candidate).size });
      }
    }
  }

  const sources = collectSources(projectDir);
  for (const item of prebuilt) sources.set("prebuilt/" + basename(item.path), item.path);
  const notes: string[] = [];
  notes.push("build/ 未进包：CMakeCache.txt 里是本机绝对路径，拷贝过去会静默复用旧缓存。");
  if (includePrebuilt && prebuilt.length === 0) notes.push("要求带 prebuilt 但构建目录里没有 .elf：先 stm32_build 再导出。");
  if (request.readme !== false) {
    const text = readmeText(projectName, prebuilt.map((item) => basename(item.path)), includePrebuilt);
    sources.set("README.md", "__inline__\n" + text);
  }

  if (cancelled()) return fail("已取消：没有生成 zip（工程里 " + String(sources.size) + " 个文件已读完，但没写盘）。");

  const outDir = request.outDir === undefined ? resolve(projectDir, "..") : resolve(request.outDir);
  const zipPath = join(outDir, projectName + "-export.zip");
  const zipImpl =
    request.zipImpl ??
    (async (out: string, srcs: Map<string, string>): Promise<void> => {
      const { makeZip } = await import("./zip.js");
      await makeZip(out, srcs);
    });

  try {
    await zipImpl(zipPath, sources);
  } catch (error) {
    return fail("打包失败：" + (error instanceof Error ? error.message : String(error)));
  }

  let zipBytes = 0;
  try {
    zipBytes = statSync(zipPath).size;
  } catch {
    // 注入的 zipImpl 可能没真写文件（测试替身）；报告里的字节数只是给人看的，不该让它炸掉。
    zipBytes = 0;
  }
  const message =
    "导出完成：" + zipPath + "（" + String(zipBytes) + " 字节、" + String(sources.size) + " 个文件" +
    (includePrebuilt ? "，含 prebuilt/" + String(prebuilt.length) + " 个产物" : "") + "）。";
  return {
    ok: true, projectDir, zipPath, zipBytes, fileCount: sources.size, prebuilt,
    durationMs: Date.now() - startedAt, message, notes,
  };
}
