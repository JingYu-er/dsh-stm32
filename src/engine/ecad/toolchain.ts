/**
 * ECAD 工具链定位（S97）：KiCad 与它自带的 bun。
 *
 * 为什么单独一层：电路由 tscircuit 生成，但生成与验收都依赖本机 KiCad 安装——
 * `kicad-cli` 做 ERC/DRC/STEP 导出，tsc 侧必须用 KiCad 自带的 bun 跑（Node 直接跑
 * `.tsx` 会报 `Unknown file extension`）。把「找它们、拼环境变量」收在一处，
 * 上层工具只拿一个 EcadToolchain。
 *
 * 只读：不安装、不改配置；找不到就给可执行的提示。
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface EcadToolchain {
  /** KiCad 安装根，例如 `D:/app/KiCad/10.0`。 */
  readonly root: string;
  /** `kicad-cli` 全路径。 */
  readonly kicadCli: string;
  /** 随 KiCad 附带的 bun；tsc 必须用它跑。 */
  readonly bun: string;
  /** KiCad 自带 Python（部分器件的 3D/封装需要）。 */
  readonly python: string;
  /** `share/kicad/footprints`、`symbols`、`3dmodels`。 */
  readonly footprintDir: string;
  readonly symbolDir: string;
  readonly model3dDir: string;
  /** 子进程环境：注入 3D 模型目录与 PATH，供 kicad-cli 与 bun 共用。 */
  readonly env: Record<string, string>;
  /** 定位依据，进检查报告。 */
  readonly notes: readonly string[];
}

export interface EcadLocateResult {
  readonly ok: boolean;
  readonly toolchain: EcadToolchain | null;
  readonly error: string;
}

const WIN_ROOT_CANDIDATES = [
  "D:/app/KiCad",
  "C:/Program Files/KiCad",
  "C:/Program Files (x86)/KiCad",
];

/** 从 `.../10.0` 这样的版本目录里挑版本号最大的那个（字符串比较对 9.x/10.x 够用）。 */
function pickVersionDir(base: string): string {
  if (!existsSync(base)) return "";
  let best = "";
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!/^\d+\.\d+$/u.test(entry.name)) continue;
    if (entry.name > best) best = entry.name;
  }
  return best;
}

function firstExisting(paths: readonly string[]): string {
  for (const path of paths) {
    if (path !== "" && existsSync(path)) return path;
  }
  return "";
}

/**
 * 定位 KiCad 与 bun。
 *
 * 顺序：显式环境变量 → 常见安装根下的版本目录 → PATH 里的 bun。
 * 环境变量：`DSH_STM32_KICAD_ROOT`（覆盖安装根）、`DSH_STM32_BUN`（覆盖 bun）。
 */
export function locateEcadToolchain(env: Record<string, string | undefined> = process.env): EcadLocateResult {
  const notes: string[] = [];
  const explicitRoot = (env["DSH_STM32_KICAD_ROOT"] ?? env["KICAD_ROOT"] ?? "").replace(/\\/gu, "/");

  const roots: string[] = [];
  if (explicitRoot !== "") {
    // 显式覆盖就是唯一来源：指错时要能立刻看出来，而不是悄悄换成默认安装。
    roots.push(explicitRoot);
  } else {
    for (const base of WIN_ROOT_CANDIDATES) {
      const version = pickVersionDir(base);
      if (version !== "") roots.push(base + "/" + version);
      roots.push(base);
    }
  }

  let root = "";
  for (const candidate of roots) {
    const cli = firstExisting([
      candidate + "/bin/kicad-cli.exe",
      candidate + "/bin/kicad-cli",
    ]);
    if (cli === "") continue;
    root = candidate.replace(/\/bin$/u, "");
    notes.push("KiCad：从 " + (explicitRoot === "" ? "默认安装根" : "DSH_STM32_KICAD_ROOT") + " 找到 " + root);
    break;
  }
  if (root === "") {
    return {
      ok: false,
      toolchain: null,
      error:
        "没找到 KiCad：装一个 KiCad 10 后重试，或用 DSH_STM32_KICAD_ROOT 指向安装目录（例如 D:/app/KiCad/10.0）",
    };
  }

  const binDir = root + "/bin";
  const kicadCli = firstExisting([binDir + "/kicad-cli.exe", binDir + "/kicad-cli"]);
  const bunExplicit = (env["DSH_STM32_BUN"] ?? "").replace(/\\/gu, "/");
  const bun =
    bunExplicit !== "" && existsSync(bunExplicit)
      ? bunExplicit
      : firstExisting([binDir + "/bun.exe", binDir + "/bun"]);
  const python = firstExisting([binDir + "/python.exe", binDir + "/python"]);

  const share = root + "/share/kicad";
  const footprintDir = firstExisting([share + "/footprints", root + "/share/footprints"]);
  const symbolDir = firstExisting([share + "/symbols", root + "/share/symbols"]);
  const model3dDir = firstExisting([share + "/3dmodels", root + "/share/3dmodels"]);

  if (bun === "") {
    notes.push("bun：未随 KiCad 找到，tscircuit 构建会失败（可用 DSH_STM32_BUN 指定）");
  } else {
    notes.push("bun：" + bun);
  }
  if (footprintDir === "") notes.push("KiCad 封装库目录未找到，`kicad:` 前缀的封装无法解析");
  if (symbolDir === "") notes.push("KiCad 符号库目录未找到，抽取符号会失败");
  if (model3dDir === "") notes.push("KiCad 3D 模型目录未找到，STEP 只出板体");

  /** 变量名带版本号：KiCad 写封装里的模型路径就是 `${KICADnN_3DMODEL_DIR}/...`。 */
  const major = root.replace(/\\/gu, "/").split("/").pop()?.split(".")[0] ?? "";
  const envOut: Record<string, string> = {
    PATH: [binDir, env["PATH"] ?? ""].filter((part) => part !== "").join(";"),
  };
  if (model3dDir !== "") {
    envOut["KICAD10_3DMODEL_DIR"] = model3dDir;
    if (major !== "") envOut["KICAD" + major + "_3DMODEL_DIR"] = model3dDir;
    envOut["KICAD_3DMODEL_DIR"] = model3dDir;
    envOut["KISYS3DMOD"] = model3dDir;
  }
  if (footprintDir !== "") {
    envOut["KICAD10_FOOTPRINT_DIR"] = footprintDir;
    if (major !== "") envOut["KICAD" + major + "_FOOTPRINT_DIR"] = footprintDir;
  }
  if (symbolDir !== "") {
    envOut["KICAD10_SYMBOL_DIR"] = symbolDir;
    if (major !== "") envOut["KICAD" + major + "_SYMBOL_DIR"] = symbolDir;
  }

  return {
    ok: true,
    toolchain: {
      root,
      kicadCli,
      bun,
      python,
      footprintDir,
      symbolDir,
      model3dDir,
      env: envOut,
      notes,
    },
    error: "",
  };
}

/** 子进程环境：在宿主 env 之上叠加工具链变量（不给 DSH_STM32_* 之外的宿主变量做白名单过滤）。 */
export function ecadEnv(
  toolchain: EcadToolchain,
  base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return { ...base, ...toolchain.env };
}
