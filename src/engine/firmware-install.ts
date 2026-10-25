/**
 * 固件包下载/组装引擎：把 GitHub 上的 HAL 驱动 + CMSIS 设备支持 + 内核头拼成
 * CubeMX 认的 STM32Cube_FW_<族>_V<版本> 目录（实测见 docs §14）。
 *
 * 装到哪（按优先级，default_target = auto）：
 *   ① 本机 CubeMX 仓库里已经有这个包 → 什么都不做（existing）
 *   ② <cubeMxRoot>/dsh-firmware/<包名>（插件自建，与 Repository 并列）→ 默认落点（cubeMx）
 *   ③ 显式 target=repository 且仓库可写 → 装进官方仓库（repository）
 *   ④ 上面都不行 → 落到用户缓存 <cacheRoot>/firmware/<包名>（cache）
 *
 * 为什么默认不装进 Repository（2026-10 实测，docs §14）：把自造版本号丢进官方仓库，
 * CubeMX **不报错也不认**，生成时静默退回它自己认识的版本（拷出来的 HAL 字节数不对）。
 * 真正让 CubeMX 用上指定包的唯一机制是脚本命令 project setCustomFWPath <包目录>，
 * 由 generate.ts 在 config load 之后发出去 —— 所以落点与 .ioc 无关，换机器也没有绝对路径残留。
 *
 * 刻意不做的事：不覆盖已有官方包（升级走 CubeMX 包管理器）、不动 Repository 里的其它包。
 */

import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  dshFirmwareDir,
  firmwarePlanFor,
  verifyFirmwarePackage,
  type FirmwarePackagePlan,
  type FirmwareVerifyCheck,
} from "../data/firmware-packages.js";
import { cacheRoot } from "./cache.js";
import { fetchAll, type FetchOptions, type FetchOutcome, type FetchTarget } from "./fetch.js";
import { extractTarGz } from "./tar.js";

export type FirmwareStepStatus = "pending" | "running" | "done" | "skipped" | "failed";

export interface FirmwareInstallStep {
  id: string;
  label: string;
  status: FirmwareStepStatus;
  detail: string;
}

export type FirmwareTargetKind = "existing" | "cubeMx" | "repository" | "cache" | "custom" | "";

export interface FirmwareInstallRequest {
  family?: string;
  mcu?: string;
  version?: string;
  /** CubeMX 安装根的候选列表（拼 <root>/Repository/<包名>）。 */
  cubeMxRoots: string[];
  /**
   * 装哪。默认 auto：已装就地用 → <cubeMxRoot>/dsh-firmware（可写即用）→ 用户缓存兜底。
   * repository = 硬塞官方仓库（CubeMX 可能不认这个版本号，生成照样靠 setCustomFWPath）；
   * cache = 只落用户缓存。
   */
  target?: "auto" | "repository" | "cache";
  /** 直接指定包目录（测试与自定义布局用）。 */
  targetDir?: string;
  mode?: "plan" | "install";
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
  /** 注入用（单测里换成假 fetch）。 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface FirmwareInstallResult {
  ok: boolean;
  mode: "plan" | "install";
  family: string;
  version: string;
  /** STM32Cube_FW_F1_V1.8.7 */
  packageName: string;
  targetKind: FirmwareTargetKind;
  targetDir: string;
  cacheRoot: string;
  cubeMxRoots: string[];
  steps: FirmwareInstallStep[];
  verify: { ok: boolean; checks: FirmwareVerifyCheck[] };
  download: { files: number; bytes: number };
  notes: string[];
  message: string;
  nextStep: string;
}

function slash(value: string): string {
  let out = value.split("\\").join("/");
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

function kindLabel(kind: FirmwareTargetKind): string {
  switch (kind) {
    case "existing":
      return "CubeMX 仓库里已有的官方包";
    case "cubeMx":
      return "CubeMX 目录里的 dsh-firmware";
    case "repository":
      return "CubeMX 仓库";
    case "cache":
      return "下载缓存";
    case "custom":
      return "调用方指定的目录";
    default:
      return "未定";
  }
}

function stepOf(steps: FirmwareInstallStep[], id: string): FirmwareInstallStep {
  const found = steps.find((step) => step.id === id);
  if (found !== undefined) return found;
  const fresh: FirmwareInstallStep = { id, label: id, status: "pending", detail: "" };
  steps.push(fresh);
  return fresh;
}

/** 在候选 CubeMX 根里找已经装好的包（找 <root>/Repository/<包名>）。 */
export function findInstalledFirmware(cubeMxRoots: readonly string[], packageName: string): string {
  for (const root of cubeMxRoots) {
    if (root.trim() === "") continue;
    const candidate = slash(root) + "/Repository/" + packageName;
    if (existsSync(candidate + "/package.xml") || existsSync(candidate + "/Drivers")) return candidate;
  }
  return "";
}

/**
 * 是不是受保护的系统目录（Windows 上普通用户建不了子目录的那几个）。
 *
 * 实测动机（2026-10-25 宿主冒烟）：本机 CubeMX 在 D:/app/STM32CubeMX，但自动发现把
 * C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeMX 排在前面；那个目录在本机
 * 根本不存在，plan 模式下 Node 的 accessSync(W_OK) 只看只读属性、不看 ACL，于是
 * 「最近一个已存在的祖先」C:/Program Files 被判成可写，计划就落到了一个装不进去的地方。
 */
export function isProtectedSystemDir(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const target = slash(dir).toLowerCase();
  if (target === "") return false;
  const roots: string[] = [];
  const push = (value: string | undefined): void => {
    if (value === undefined || value.trim() === "") return;
    const normalized = slash(value).toLowerCase();
    if (normalized !== "" && roots.includes(normalized) === false) roots.push(normalized);
  };
  push(env["ProgramFiles"]);
  push(env["ProgramFiles(x86)"]);
  push(env["ProgramW6432"]);
  push(env["ProgramData"]);
  push(env["SystemRoot"]);
  // 刻意不把整块系统盘（C:/）算进来：用户目录 %TEMP%、%LOCALAPPDATA% 都在 C: 上，那样会误伤一切。
  for (const root of roots) {
    if (target === root || target.startsWith(root.endsWith("/") ? root : root + "/")) return true;
  }
  return false;
}

/** 候选根排序：本机真存在的排前面（存在的才可能是真装过 CubeMX 的那份）。 */
export function orderCubeMxRoots(roots: readonly string[]): string[] {
  const kept = roots.map((root) => root.trim()).filter((root) => root !== "");
  const existing = kept.filter((root) => existsSync(root));
  const missing = kept.filter((root) => existsSync(root) === false);
  return [...existing, ...missing];
}

/** 目录能不能写。plan 模式只做只读探测（不建目录），install 模式才真的 mkdir + 试写。 */
function dirWritable(dir: string, create: boolean): { ok: boolean; dir: string; error: string } {
  if (!create) {
    // 计划模式：目录可能还不存在（CubeMX 刚装、Repository 还没建），按最近的已存在祖先判可写性。
    let probe = dir;
    while (!existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe || parent.length <= 3) break;
      probe = parent;
    }
    if (probe !== dir && isProtectedSystemDir(probe)) {
      // Windows 的 accessSync(W_OK) 只看只读属性，不看 ACL，Program Files 一样报"可写"。
      // 这里不猜：没装到那台机器上的根，祖先又是系统目录，就按不可写算，让落点退回能写的那一支。
      return { ok: false, dir, error: "位于受保护的系统目录 " + slash(probe) + " 下，普通权限建不了子目录" };
    }
    try {
      accessSync(probe, constants.W_OK);
      return { ok: true, dir, error: "" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, dir, error: message };
    }
  }
  try {
    mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".dsh-write-probe-" + String(process.pid));
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
    return { ok: true, dir, error: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, dir, error: message };
  }
}

/** 官方仓库能不能写（<root>/Repository）。 */
function repositoryWritable(root: string, create: boolean): { ok: boolean; dir: string; error: string } {
  return dirWritable(slash(root) + "/Repository", create);
}

interface TargetDecision {
  kind: FirmwareTargetKind;
  dir: string;
  notes: string[];
}

function decideTarget(request: FirmwareInstallRequest, plan: FirmwarePackagePlan, create: boolean): TargetDecision {
  const notes: string[] = [];
  const explicit = request.targetDir;
  if (explicit !== undefined && explicit.trim() !== "") {
    return { kind: "custom", dir: slash(explicit), notes };
  }
  const existing = findInstalledFirmware(request.cubeMxRoots, plan.dirName);
  if (existing !== "") {
    return { kind: "existing", dir: existing, notes: ["CubeMX 仓库里已经有 " + plan.dirName + "，直接用它，不下载。"] };
  }
  const want = request.target ?? "auto";
  // 本机真存在的根优先：自动发现会把别的机器上的默认安装路径也列进来，
  // 那种根在 plan 模式下判不出可写性，排在前面就会把落点带偏。
  const roots = orderCubeMxRoots(request.cubeMxRoots);

  if (want === "repository") {
    for (const root of roots) {
      const writable = repositoryWritable(root, create);
      if (writable.ok) {
        return {
          kind: "repository",
          dir: writable.dir + "/" + plan.dirName,
          notes: [
            "落进 CubeMX 官方仓库：" + writable.dir + "/" + plan.dirName + "。实测这种自造版本号 CubeMX 不会自动认，" +
              "生成代码照样靠脚本命令 setCustomFWPath 指过去。",
          ],
        };
      }
      notes.push("CubeMX 仓库 " + writable.dir + " 写不进去（" + writable.error + "）。");
    }
    notes.push("要求装进 CubeMX 仓库，但没有一个可写的仓库根，只好落到别处。");
  }

  if (want !== "cache") {
    // 默认落点：CubeMX 安装根下自建 dsh-firmware（与 Repository 并列，绝不往官方目录里塞）。
    for (const root of roots) {
      const own = dirWritable(dshFirmwareDir(root), create);
      if (own.ok) {
        return {
          kind: "cubeMx",
          dir: own.dir + "/" + plan.dirName,
          notes: [
            "落点：" + own.dir + "/" + plan.dirName + "（CubeMX 目录里的 dsh-firmware，与 Repository 并列，不动官方包）。",
          ],
        };
      }
      notes.push("建不了 " + own.dir + "（" + own.error + "）。");
    }
  }

  const dir = slash(cacheRoot(request.env ?? process.env)) + "/firmware/" + plan.dirName;
  notes.push(
    "落点：" + dir + "：CubeMX 目录写不进去（或没配置 CubeMX 根），只能放用户目录下的缓存；" +
      "生成时靠脚本命令 setCustomFWPath 指过去，不会写进 .ioc。",
  );
  return { kind: "cache", dir, notes };
}

function baseSteps(plan: FirmwarePackagePlan): FirmwareInstallStep[] {
  return [
    { id: "prepare", label: "准备目标目录", status: "pending", detail: "" },
    {
      id: "download",
      label: "下载 HAL 驱动与设备支持",
      status: "pending",
      detail:
        plan.archives.map((archive) => archive.label).join(" + ") +
        " 两个归档，外加 " +
        String(plan.coreTargets.length) +
        " 个 CMSIS 内核头（合计约 2 MB；每个文件 3 条候选源，前一条不通自动换）",
    },
    {
      id: "extract",
      label: "解包并摆成固件包布局",
      status: "pending",
      detail:
        "只保留 " + plan.halDir + "/{Inc,Src} 与 " + plan.deviceDir + "/{Include,Source}，其它（.github、文档、示例）不落盘",
    },
    {
      id: "package",
      label: "写 package.xml 与第三方声明",
      status: "pending",
      detail: "Release " + plan.releaseTag + " / Patch " + plan.patchTag + "（CubeMX 靠这个文件认版本）",
    },
    {
      id: "verify",
      label: "按三条判据自检",
      status: "pending",
      detail: "HAL 驱动 Inc/Src + 设备头 Include + gcc 启动文件都在才算装成（CubeMX 缺包时不报错，必须自查）",
    },
  ];
}

function emptyResult(mode: "plan" | "install", message: string): FirmwareInstallResult {
  return {
    ok: false,
    mode,
    family: "",
    version: "",
    packageName: "",
    targetKind: "",
    targetDir: "",
    cacheRoot: "",
    cubeMxRoots: [],
    steps: [],
    verify: { ok: false, checks: [] },
    download: { files: 0, bytes: 0 },
    notes: [],
    message,
    nextStep: "",
  };
}

function planResult(request: FirmwareInstallRequest, plan: FirmwarePackagePlan, decision: TargetDecision): FirmwareInstallResult {
  const steps = baseSteps(plan);
  const prepare = stepOf(steps, "prepare");
  prepare.detail = "装到 " + decision.dir + "（" + kindLabel(decision.kind) + "）";
  const notes = [...decision.notes];
  const roots = request.cubeMxRoots.map((root) => slash(root));

  if (decision.kind === "existing") {
    for (const step of steps) {
      step.status = "skipped";
      step.detail = "本机已有官方包，不需要这一步";
    }
    const verify = verifyFirmwarePackage(decision.dir, plan.family);
    return {
      ok: verify.ok,
      mode: "plan",
      family: plan.family,
      version: plan.version,
      packageName: plan.dirName,
      targetKind: decision.kind,
      targetDir: decision.dir,
      cacheRoot: slash(cacheRoot(request.env ?? process.env)),
      cubeMxRoots: roots,
      steps,
      verify,
      download: { files: 0, bytes: 0 },
      notes,
      message: verify.ok
        ? "本机已经有了 " + plan.dirName + "（" + decision.dir + "），自检也过了，不用下载，直接生成代码就行。"
        : "本机有个 " + plan.dirName + "，但自检不过（缺 " + verify.missing.join("、") + "），建议用 CubeMX 包管理器重装。",
      nextStep: "直接调 stm32_generate（.ioc 里 ProjectManager.FirmwarePackage 写 STM32Cube FW_" + plan.family + " V" + plan.version + "）。",
    };
  }

  return {
    ok: true,
    mode: "plan",
    family: plan.family,
    version: plan.version,
    packageName: plan.dirName,
    targetKind: decision.kind,
    targetDir: decision.dir,
    cacheRoot: slash(cacheRoot(request.env ?? process.env)),
    cubeMxRoots: roots,
    steps,
    verify: { ok: false, checks: [] },
    download: { files: 0, bytes: 0 },
    notes,
    message:
      "计划（还没动手）：把 " +
      plan.dirName +
      " 下载并组装到 " +
      decision.dir +
      "（" +
      kindLabel(decision.kind) +
      "）：2 个归档 + " +
      String(plan.coreTargets.length) +
      " 个内核头，约 2 MB；现在没有下载、没有建目录、没动 CubeMX 安装目录。",
    nextStep: "要我装吗？回一句「装固件包」，我给 dryRun:false + confirm:true 真下（约 2 MB）。",
  };
}

/** 计划模式：只读探测，零副作用。 */
export function firmwareInstallPlan(request: FirmwareInstallRequest): FirmwareInstallResult {
  const plan = firmwarePlanFor(request);
  if (!plan.ok) return emptyResult("plan", plan.error);
  return planResult(request, plan, decideTarget(request, plan, false));
}

/** 按归档的 dirs 表把压缩包里的路径映射到包布局。 */
function mapperFor(archive: { dirs: { from: string; to: string }[] }): (rel: string) => string | null {
  return (rel: string): string | null => {
    for (const dir of archive.dirs) {
      if (rel === dir.from || rel.startsWith(dir.from + "/")) {
        return dir.to + rel.slice(dir.from.length);
      }
    }
    return null;
  };
}

const NOTICES_FILE = "THIRD_PARTY_NOTICES.md";

/** 真装。失败时已下载的东西会留在目标目录里（方便重试），最终判据是三条自检。 */
export async function installFirmware(request: FirmwareInstallRequest): Promise<FirmwareInstallResult> {
  const plan = firmwarePlanFor(request);
  if (!plan.ok) return emptyResult("install", plan.error);
  const decision = decideTarget(request, plan, true);
  const steps = baseSteps(plan);
  const notes = [...decision.notes];
  const roots = request.cubeMxRoots.map((root) => slash(root));
  const progress = request.onProgress ?? ((): void => {});
  const cloud: "plan" | "install" = "install";

  const finish = (extra: Partial<FirmwareInstallResult>): FirmwareInstallResult => ({
    ...emptyResult(cloud, ""),
    family: plan.family,
    version: plan.version,
    packageName: plan.dirName,
    targetKind: decision.kind,
    targetDir: decision.dir,
    cacheRoot: slash(cacheRoot(request.env ?? process.env)),
    cubeMxRoots: roots,
    steps,
    notes,
    ...extra,
  });

  const prepare = stepOf(steps, "prepare");
  if (decision.kind === "existing") {
    const verify = verifyFirmwarePackage(decision.dir, plan.family);
    for (const step of steps) {
      step.status = "skipped";
      step.detail = "本机已有官方包，不需要这一步";
    }
    return finish({
      ok: verify.ok,
      verify,
      message: verify.ok
        ? "本机已经有 " + plan.dirName + "（" + decision.dir + "），不用下载。"
        : "本机有个 " + plan.dirName + "，但自检不过（缺 " + verify.missing.join("、") + "）。",
      nextStep: "直接调 stm32_generate。",
    });
  }

  try {
    mkdirSync(decision.dir, { recursive: true });
    prepare.status = "done";
    prepare.detail = "已建 " + decision.dir + "（" + kindLabel(decision.kind) + "）";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    prepare.status = "failed";
    prepare.detail = "建不了 " + decision.dir + "：" + message;
    return finish({ ok: false, message: "固件包没装成：建不了目标目录 —— " + message });
  }
  progress("目标目录：" + decision.dir);

  const tempDir = path.join(decision.dir, ".dsh-download");
  rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });

  try {
    const download = stepOf(steps, "download");
    download.status = "running";
    const archiveTargets: FetchTarget[] = plan.archives.map((archive) => ({
      path: archive.id + ".tgz",
      urls: archive.urls,
      minBytes: 100_000,
    }));
    const options: FetchOptions = {
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.fetchImpl === undefined ? {} : { fetchImpl: request.fetchImpl }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      onProgress: (outcome: FetchOutcome, done: number, total: number) => {
        progress("下载 " + String(done) + "/" + String(total) + "：" + outcome.path + (outcome.ok ? " OK" : " 失败（" + outcome.error + "）"));
      },
    };
    const archives = await fetchAll(archiveTargets, tempDir, options);
    const coreDir = path.join(decision.dir, "Drivers", "CMSIS", "Include");
    mkdirSync(coreDir, { recursive: true });
    const cores = await fetchAll(plan.coreTargets, coreDir, options);
    const files = archives.ok + cores.ok;
    const bytes = archives.bytes + cores.bytes;
    const failures = [...archives.results, ...cores.results].filter((item) => !item.ok);
    if (failures.length > 0) {
      download.status = "failed";
      download.detail =
        "有 " + String(failures.length) + " 个文件没下下来：" +
        failures.slice(0, 3).map((item) => item.path + "（" + item.error + "）").join("；");
      return finish({ ok: false, download: { files, bytes }, message: "固件包没装成：下载失败。", nextStep: "网络恢复后重试；或按 guides 里的手动步骤在 CubeMX 里装。" });
    }
    download.status = "done";
    download.detail = "下载 " + String(files) + " 个文件，共 " + String(Math.round(bytes / 1024)) + " KB";

    const extract = stepOf(steps, "extract");
    extract.status = "running";
    let extracted = 0;
    for (const archive of plan.archives) {
      const archivePath = path.join(tempDir, archive.id + ".tgz");
      const buffer = readFileSync(archivePath);
      const result = extractTarGz(buffer, decision.dir, { stripComponents: 1, mapPath: mapperFor(archive) });
      if (!result.ok) {
        extract.status = "failed";
        extract.detail = archive.label + " 解包失败：" + result.error;
        return finish({ ok: false, download: { files, bytes }, message: "固件包没装成：解包失败 —— " + result.error });
      }
      extracted += result.files.length;
      progress("解包 " + archive.label + "：" + String(result.files.length) + " 个文件");
    }
    extract.status = "done";
    extract.detail = "摆了 " + String(extracted) + " 个文件进 " + plan.dirName;

    const packageStep = stepOf(steps, "package");
    writeFileSync(path.join(decision.dir, "package.xml"), plan.packageXml, "utf8");
    writeFileSync(path.join(decision.dir, NOTICES_FILE), plan.license, "utf8");
    packageStep.status = "done";
    packageStep.detail = "package.xml " + String(plan.packageXml.length) + " B（Release " + plan.releaseTag + " / Patch " + plan.patchTag + "）+ " + NOTICES_FILE;

    const verify = verifyFirmwarePackage(decision.dir, plan.family);
    const verifyStep = stepOf(steps, "verify");
    if (!verify.ok) {
      verifyStep.status = "failed";
      verifyStep.detail = "缺：" + verify.missing.join("、");
      return finish({
        ok: false,
        download: { files, bytes },
        verify,
        message: "固件包没装成：自检缺 " + verify.missing.join("、") + "。",
        nextStep: "把这段报错贴给我；或者改用 CubeMX 包管理器装官方包。",
      });
    }
    verifyStep.status = "done";
    verifyStep.detail = "三条判据全过（" + String(verify.checks.length) + " 项检查）";

    const needsHint = decision.kind === "cache" || decision.kind === "custom" || decision.kind === "cubeMx" || decision.kind === "repository";
    return finish({
      ok: true,
      download: { files, bytes },
      verify,
      message:
        "固件包装好了：" + plan.dirName + " 在 " + decision.dir + "（" + kindLabel(decision.kind) + "）。" +
        "下载 " + String(files) + " 个文件 / " + String(Math.round(bytes / 1024)) + " KB，三条判据全过。",
      nextStep: needsHint
        ? "直接调 stm32_generate：它会按 .ioc 的 ProjectManager.FirmwarePackage 找到这个包，用脚本命令 setCustomFWPath 指过去（" +
          decision.dir +
          "），不往 .ioc 里写绝对路径。"
        : "直接调 stm32_generate（.ioc 里 ProjectManager.FirmwarePackage 写 STM32Cube FW_" + plan.family + " V" + plan.version + "）。",
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** 计划 / 真装的总入口。 */
export async function planOrInstallFirmware(request: FirmwareInstallRequest): Promise<FirmwareInstallResult> {
  return (request.mode ?? "plan") === "install" ? installFirmware(request) : firmwareInstallPlan(request);
}
