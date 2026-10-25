/**
 * 寄存器版工程：从缓存拉 CMSIS 模板，再拼出一个不用 CubeMX / 不用 HAL 的 CMake 工程。
 *
 * 为什么模板不预置进插件（用户 2026-10-24 决定）：插件要覆盖任意 STM32，每颗芯片的
 * startup + 设备头 + 内核头都打一份进 npm 包，包会大到不可用。所以：
 *   第一次用 → 从网上下载（多候选源，见 fetch.ts）→ 落到可检索缓存目录（见 cache.ts）
 *   以后用   → 直接复用缓存，不联网
 *
 * 工程里的 Drivers/CMSIS 与 HAL 工程布局一致（ST 固件包的摆放），所以同一套 include 约定、
 * 同一个工具链文件、同一个链接脚本都能直接复用；差别只是源文件里不出现 HAL 调用。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CMSIS_FAMILIES, cmsisTemplatePlan, startupChoiceFor, type StartupChoice } from "../data/cmsis-sources.js";
import { cacheRootInfo, checkCacheEntry, findCacheEntry, readCacheIndex, sha256OfFile, upsertCacheEntry, type CacheEntry, type CacheFile } from "./cache.js";
import { fetchAll, type FetchOptions, type FetchOutcome } from "./fetch.js";
import { backupBeforeOverwrite, backupWarning, cleanupAfterFailure, mkdirTracked, preflightTarget, templateDir, type OverwriteBackup } from "./scaffold.js";

/** 寄存器版模板目录：lib/engine/register-template.js → ../../templates/register。 */
export function registerTemplateDir(): string {
  return fileURLToPath(new URL("../../templates/register/", import.meta.url));
}

export interface TemplateRequest {
  /** 芯片型号（STM32F103C8T6）或容量档写法（F1:B）。 */
  mcu?: string;
  /** 只给族时的写法（默认 F1），按最常见容量档处理。 */
  family?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
  /** false = 只查缓存，不联网（给"离线机器"与测试用）。 */
  download?: boolean;
}

/** 型号/族 → 启动文件与设备宏；认不出返回 null（不猜文件名）。 */
export function resolveStartupChoice(request: { mcu?: string; family?: string }): StartupChoice | null {
  const mcu = (request.mcu ?? "").trim();
  if (mcu !== "") return startupChoiceFor(mcu);
  const family = (request.family ?? "F1").trim().toUpperCase();
  // 只给族时按中容量档（F1 → xB）：蓝丸 C8T6 正是这一档，也是最常见的入门芯片。
  return startupChoiceFor(family + ":B");
}

export interface TemplateResult {
  ok: boolean;
  family: string;
  /** 缓存条目 id，例如 cmsis:F1:startup_stm32f103xb。 */
  id: string;
  cacheRoot: string;
  /** 模板根目录（里面是 Drivers/CMSIS 布局）；失败时是空串。 */
  entryDir: string;
  cacheHit: boolean;
  startup: string;
  deviceDefine: string;
  deviceHeader: string;
  files: number;
  bytes: number;
  error: string;
  message: string;
}

function emptyResult(cacheRoot: string, error: string, message: string): TemplateResult {
  return { ok: false, family: "", id: "", cacheRoot, entryDir: "", cacheHit: false, startup: "", deviceDefine: "", deviceHeader: "", files: 0, bytes: 0, error, message };
}

/**
 * 确保某颗芯片的 CMSIS 模板在缓存里。
 *
 * 顺序：查索引 → 校验文件（缺/大小不对就重下）→ 下载（并发 3、每个文件多候选源）→
 * 写 THIRD_PARTY_NOTICES.md → 写索引。任何一步失败都返回 ok:false + 人话原因，
 * 不抛异常（工具层要把原因贴到卡片上）。
 */
export async function ensureCmsisTemplate(request: TemplateRequest = {}): Promise<TemplateResult> {
  const env = request.env ?? process.env;
  const info = cacheRootInfo(env);
  const choice = resolveStartupChoice(request);
  if (choice === null) {
    const asked = (request.mcu ?? request.family ?? "").trim();
    // F103 家族里上游没有的容量档要单独说清楚（A24）：说"认不出"会让人以为插件坏了。
    const f103 = /^STM32F103([A-Z])([0-9A-Z])/u.exec(asked.toUpperCase());
    const densityNote = f103 !== null
      ? "上游 CMSIS 只有 x6 / xB / xE 三套启动文件，没有容量档 " + (f103[2] ?? "") + " 这一套：F103 的 4/8/6 档归到 x6 或 xB，C/D/E 档归到 xE。换 STM32F103C8T6 / CBT6 这类型号，"
      : "换 F103 型号，";
    return emptyResult(
      info.root,
      "unsupported-mcu",
      "认不出这颗芯片的启动文件（目前只做 STM32F1 的 F103 系列）：" + (asked || "(没给型号)") + "。" + densityNote + "或改用 HAL 路线（.ioc + CubeMX）。",
    );
  }
  const plan = cmsisTemplatePlan(choice);
  if (plan === null) return emptyResult(info.root, "unsupported-family", "这一代还没有下载清单：" + choice.family + "。");

  const { index, error: indexError } = readCacheIndex(env);
  if (indexError !== null) request.onProgress?.(indexError);

  const existing = findCacheEntry(index, "cmsis", plan.id);
  if (existing !== null) {
    const health = checkCacheEntry(existing);
    if (health.ok) {
      return {
        ok: true,
        family: plan.family,
        id: plan.id,
        cacheRoot: info.root,
        entryDir: existing.root,
        cacheHit: true,
        startup: choice.startup,
        deviceDefine: choice.define,
        deviceHeader: choice.deviceHeader,
        files: existing.files.length,
        bytes: existing.totalBytes,
        error: "",
        message: "缓存里已有 " + plan.id + "（" + String(existing.files.length) + " 个文件），没有联网。",
      };
    }
    const broken = health.missing.length + health.changed.length;
    request.onProgress?.("缓存条目 " + plan.id + " 有 " + String(broken) + " 个文件缺失或大小不对，重新下载。");
  }

  if (request.download === false) {
    return {
      ...emptyResult(info.root, "not-cached", "寄存器模板不在缓存里（" + plan.id + "）：这台机器还没下载过，而这次调用被要求不联网。去掉 download=false 再试一次。"),
      family: plan.family,
      id: plan.id,
      startup: choice.startup,
      deviceDefine: choice.define,
      deviceHeader: choice.deviceHeader,
    };
  }

  const entryDir = path.join(info.root, plan.dirName);
  fs.mkdirSync(entryDir, { recursive: true });
  request.onProgress?.("下载 " + String(plan.targets.length) + " 个模板文件到 " + entryDir + "（第一次用需要联网，以后复用缓存）。");

  const options: FetchOptions = {
    onProgress: (outcome: FetchOutcome, done: number, total: number) => {
      request.onProgress?.("下载 " + String(done) + "/" + String(total) + "：" + outcome.path + (outcome.ok ? " ✓" : " ✗ " + outcome.error));
    },
  };
  if (request.fetchImpl !== undefined) options.fetchImpl = request.fetchImpl;
  if (request.signal !== undefined) options.signal = request.signal;

  const fetched = await fetchAll(plan.targets, entryDir, options);
  if (fetched.failed > 0) {
    const failures = fetched.results.filter((item) => !item.ok).slice(0, 3).map((item) => item.path + "：" + item.error);
    const failedResults = fetched.results.filter((item) => !item.ok);
    const allNotFound = failedResults.length > 0 && failedResults.every((item) => item.attempts.length > 0 && item.attempts.every((line) => line.includes("HTTP 404")));
    // 半截缓存比没有缓存更糟：下一次会把不完整的目录当成模板用。
    // 但直接 rm 会把并发方正在读的目录抽走（A24）：先改名成 .stale-<时间戳>，再删；
    // 改名失败（被占用）就留着，至少不删到一半。
    const staleDir = entryDir + ".stale-" + new Date().toISOString().replace(/[:.]/gu, "-");
    let renamed = false;
    try {
      fs.renameSync(entryDir, staleDir);
      renamed = true;
    } catch {
      renamed = false;
    }
    let cleaned = false;
    if (renamed) {
      try {
        fs.rmSync(staleDir, { recursive: true, force: true });
        cleaned = true;
      } catch {
        cleaned = false;
      }
    }
    const cleanupNote = renamed
      ? (cleaned ? "已把半截目录改名后清掉（" + staleDir + "）。" : "半截目录已改名成 " + staleDir + "，但没删掉（可能被占用），可以手工删。")
      : "半截目录 " + entryDir + " 被占用，改名失败也没删（下次会重下覆盖）。";
    return {
      ...emptyResult(
        info.root,
        "download-failed",
        "模板没下下来（" + String(fetched.failed) + "/" + String(plan.targets.length) + " 个文件失败）。" + cleanupNote + "第一条失败原因：" + (failures[0] ?? "(未知)") + "。"
        + (allNotFound ? "这几个文件在上游就是 404：多半是这一代/这一档的模板清单写错了（插件 bug），换型号没用，先走 HAL 路线或报告这个问题。" : "多半是网络/代理问题：换网络重试，或手动把 ST 固件包（STM32Cube_FW_F1_*）装到 CubeMX 的 Repository 里走 HAL 路线。"),
      ),
      family: plan.family,
      id: plan.id,
      startup: choice.startup,
      deviceDefine: choice.define,
      deviceHeader: choice.deviceHeader,
    };
  }

  // 每个下载的文件登记 sha256（A38）：字节数挡不住"同样大小、内容被换掉"。
  const files: CacheFile[] = fetched.results.map((outcome) => {
    const item: CacheFile = { path: outcome.path, bytes: outcome.bytes, url: outcome.url };
    try {
      item.sha256 = sha256OfFile(path.join(entryDir, ...outcome.path.split("/")));
    } catch {
      // 落盘文件读不出来就别登记哈希，校验时退回只看字节数。
    }
    return item;
  });
  const upstream = new Set<string>();
  for (const target of plan.targets) for (const url of target.urls) upstream.add(url);

  // notices 也是条目的一部分，必须进 files[]（A24）：否则 checkCacheEntry 永远不校验它，
  // 人手删掉之后索引照样显示"完整"。
  const noticesName = "THIRD_PARTY_NOTICES.md";
  const noticesPath = path.join(entryDir, noticesName);
  fs.writeFileSync(noticesPath, plan.license, "utf8");
  const noticesFile: CacheFile = { path: noticesName, bytes: Buffer.byteLength(plan.license, "utf8"), url: "" };
  try {
    noticesFile.sha256 = sha256OfFile(noticesPath);
  } catch {
    // 同上。
  }
  files.push(noticesFile);
  const totalBytes = fetched.bytes + noticesFile.bytes;

  const entry: CacheEntry = {
    id: plan.id,
    kind: "cmsis",
    family: plan.family,
    label: plan.family + " / " + choice.startup.replace(/\.s$/u, "") + "（CMSIS 设备头 + 启动文件 + 内核头）",
    root: entryDir,
    createdAt: new Date().toISOString(),
    totalBytes,
    files,
    sources: Array.from(upstream).sort(),
    license: plan.license,
  };
  upsertCacheEntry(entry, env);
  request.onProgress?.("缓存已更新：" + plan.id);

  return {
    ok: true,
    family: plan.family,
    id: plan.id,
    cacheRoot: info.root,
    entryDir,
    cacheHit: false,
    startup: choice.startup,
    deviceDefine: choice.define,
    deviceHeader: choice.deviceHeader,
    files: files.length,
    bytes: totalBytes,
    error: "",
    message: "已下载 " + String(files.length) + " 个模板文件到缓存（" + entryDir + "），下次直接用。",
  };
}

export interface RegisterProjectRequest {
  targetDir: string;
  projectName?: string;
  mcu?: string;
  family?: string;
  overwrite?: boolean;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
  download?: boolean;
}

export interface RegisterProjectReport {
  ok: boolean;
  targetDir: string;
  projectName: string;
  route: "register";
  mcu: string;
  family: string;
  startup: string;
  deviceDefine: string;
  cacheRoot: string;
  cacheHit: boolean;
  templateFiles: number;
  driverFiles: number;
  durationMs: number;
  warnings: string[];
  message: string;
}

/** 从 HAL 骨架模板里借来的**与 HAL 无关**的文件（工具链、presets、链接脚本、.gitignore）。 */
const SHARED_TEMPLATE_FILES = ["CMakePresets.json", ".gitignore", "STM32F103XX_FLASH.ld", "cmake/gcc-arm-none-eabi.cmake"];

function countFiles(root: string): number {
  let count = 0;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else count += 1;
    }
  };
  if (fs.existsSync(root)) walk(root);
  return count;
}

/**
 * 建一个寄存器版工程：模板（CMakeLists + main.c）来自插件，CMSIS/启动文件来自缓存，
 * 工具链与链接脚本复用 HAL 骨架里那几份**不含 HAL 内容**的文件。
 */
export async function createRegisterProject(request: RegisterProjectRequest): Promise<RegisterProjectReport> {
  const startedAt = Date.now();
  const targetDir = path.resolve(request.targetDir);
  const projectName = request.projectName ?? path.basename(targetDir);
  const mcu = (request.mcu ?? "STM32F103C8T6").trim();
  const fail = (message: string, warnings: string[] = []): RegisterProjectReport => ({
    ok: false,
    targetDir,
    projectName,
    route: "register",
    mcu,
    family: "",
    startup: "",
    deviceDefine: "",
    cacheRoot: cacheRootInfo(request.env ?? process.env).root,
    cacheHit: false,
    templateFiles: 0,
    driverFiles: 0,
    durationMs: Date.now() - startedAt,
    warnings,
    message,
  });

  // 先判"能不能写"（工程名 / 目录非空），下载和写盘都在后面：
  // 工具层会在门禁之前先跑同一个判定（免得用户先装工具再撞第二个错），这里再来一次是为了
  // 让直接调用引擎的人（测试、别的工具）也拿到同一套拒绝理由。
  const refusal = preflightTarget({
    targetDir,
    projectName,
    route: "register",
    ...(request.overwrite === undefined ? {} : { overwrite: request.overwrite }),
  });
  if (refusal !== null) return fail(refusal);

  const template = await ensureCmsisTemplate({
    ...(request.mcu === undefined ? {} : { mcu: request.mcu }),
    ...(request.family === undefined ? {} : { family: request.family }),
    ...(request.env === undefined ? {} : { env: request.env }),
    ...(request.fetchImpl === undefined ? {} : { fetchImpl: request.fetchImpl }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress }),
    ...(request.download === undefined ? {} : { download: request.download }),
  });
  if (!template.ok) return fail(template.message);

  const choice = resolveStartupChoice({ ...(request.mcu === undefined ? {} : { mcu: request.mcu }), ...(request.family === undefined ? {} : { family: request.family }) });
  if (choice === null || cmsisTemplatePlan(choice) === null) return fail("内部错误：缓存条目对应的下载清单没了（" + template.family + "）。");
  const spec = CMSIS_FAMILIES[template.family];
  if (spec === undefined) return fail("内部错误：这一代没有设备头规格（" + template.family + "）。");
  const familyDir = spec.deviceDefinePrefix + "xx";

  const regTpl = registerTemplateDir();
  const halTpl = templateDir();
  if (!fs.existsSync(regTpl)) return fail("插件模板目录缺失：" + regTpl + "（重新安装插件）");

  // 要读的模板文件、要拷的 Drivers，全部在**写盘之前**检查一遍：
  // 半路才发现插件包缺文件，留下的就是一个比没有更糟的半成品工程。
  const sourcesToCheck = [
    path.join(regTpl, "CMakeLists.txt"),
    path.join(regTpl, "Core", "Src", "main.c"),
    ...SHARED_TEMPLATE_FILES.map((rel) => path.join(halTpl, rel)),
  ];
  for (const source of sourcesToCheck) {
    if (!fs.existsSync(source)) return fail("插件模板缺文件：" + source + "（重新安装插件）");
  }
  const driversSrc = path.join(template.entryDir, "Drivers");
  if (!fs.existsSync(driversSrc)) return fail("缓存的模板目录不完整（缺 Drivers）：" + template.entryDir + "。删掉它再试一次会重新下载。");

  // 覆盖前先备份将被覆盖的同名文件；备份失败就一个字节都不写（否则用户的 main.c 就没了）。
  let backup: OverwriteBackup;
  try {
    backup = backupBeforeOverwrite(targetDir, ["CMakeLists.txt", "Core/Src/main.c", ...SHARED_TEMPLATE_FILES], "register");
  } catch (error) {
    return fail("没写任何文件：覆盖前的备份失败（" + String((error as Error).message) + "）。目标目录 " + targetDir + " 未被改动。");
  }
  const backupNote = backupWarning(backup);

  // 1) 寄存器版 CMakeLists：替换四个占位符
  const replacements: Record<string, string> = {
    __PROJECT_NAME__: projectName,
    __FAMILY_DIR__: familyDir,
    __STARTUP_FILE__: template.startup,
    __DEVICE_DEFINE__: template.deviceDefine,
  };
  const fill = (text: string): string => {
    let out = text;
    for (const [key, value] of Object.entries(replacements)) out = out.split(key).join(value);
    return out;
  };

  const targetExistedBefore = fs.existsSync(targetDir);
  const driversExistedBefore = fs.existsSync(path.join(targetDir, "Drivers"));
  const createdDirs: string[] = [];
  let templateFiles = 2;
  try {
    mkdirTracked(path.join(targetDir, "Core", "Src"), createdDirs);
    mkdirTracked(path.join(targetDir, "Core", "Inc"), createdDirs);

    // 1) CMakeLists.txt
    fs.writeFileSync(path.join(targetDir, "CMakeLists.txt"), fill(fs.readFileSync(path.join(regTpl, "CMakeLists.txt"), "utf8")), "utf8");

    // 2) 寄存器版 main.c（PC13 蓝丸示例，无占位符）
    fs.writeFileSync(path.join(targetDir, "Core", "Src", "main.c"), fs.readFileSync(path.join(regTpl, "Core", "Src", "main.c"), "utf8"), "utf8");

    // 3) 与 HAL 无关的公共文件：工具链 / presets / 链接脚本 / .gitignore
    for (const rel of SHARED_TEMPLATE_FILES) {
      const dest = path.join(targetDir, rel);
      mkdirTracked(path.dirname(dest), createdDirs);
      fs.copyFileSync(path.join(halTpl, rel), dest);
      templateFiles += 1;
    }

    // 4) CMSIS：缓存条目里的 Drivers 整棵拷进工程（与 HAL 工程布局一致）
    fs.cpSync(driversSrc, path.join(targetDir, "Drivers"), { recursive: true });
  } catch (error) {
    // Drivers 整棵是本次拷的（原来没有）→ 可以整棵删；原来就有（覆盖场景）则一个都不动。
    if (!driversExistedBefore) {
      try {
        fs.rmSync(path.join(targetDir, "Drivers"), { recursive: true, force: true });
      } catch {
        // 删不掉就留着：下面 cleanup 会说清哪个目录没清干净，但绝不递归删用户的文件。
      }
    }
    const cleanup = cleanupAfterFailure(targetDir, targetExistedBefore, createdDirs);
    return fail(
      "写盘失败（已写 " + String(templateFiles) + " 个工程文件）：" + String((error as Error).message) + "；路径：" + targetDir + "。" + cleanup,
      backupNote === null ? [] : [backupNote],
    );
  }
  const driverFiles = countFiles(path.join(targetDir, "Drivers"));

  const warnings: string[] = [];
  // 备份清单放第一条：用户看到"覆盖成功"时，第一眼得知道旧文件去哪了。
  if (backupNote !== null) warnings.push(backupNote);
  warnings.push(
    "模板里的 LED 是蓝丸的 PC13；换板子改 Core/Src/main.c 顶部的 LED_PORT / LED_PIN。",
    "寄存器版没有 .ioc：不需要 CubeMX，也不需要固件包；要换成 HAL 版就用 stm32_project_create route=hal。",
  );
  if (template.cacheHit) warnings.push("这次用的是缓存模板（" + template.entryDir + "），没有联网。");
  else warnings.push("模板已下载到缓存（" + template.entryDir + "），以后再建工程不联网。");

  return {
    ok: true,
    targetDir,
    projectName,
    route: "register",
    mcu,
    family: template.family,
    startup: template.startup,
    deviceDefine: template.deviceDefine,
    cacheRoot: template.cacheRoot,
    cacheHit: template.cacheHit,
    templateFiles,
    driverFiles,
    durationMs: Date.now() - startedAt,
    warnings,
    message:
      "寄存器版工程已建好（" + String(templateFiles) + " 个工程文件 + " + String(driverFiles) + " 个 CMSIS 文件）：" + targetDir +
      (backupNote === null ? "" : "；" + backupNote),
  };
}
