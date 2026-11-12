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
import { deviceFactsSource } from "../data/device-facts.js";
import { cacheRootInfo, checkCacheEntry, readCacheIndex, resolveCacheEntry, sha256OfFile, upsertCacheEntry, type CacheEntry, type CacheFile } from "./cache.js";
import { fetchAll, type FetchOptions, type FetchOutcome } from "./fetch.js";
import { planGenericClock, planRegisterClock, renderClockInit, renderGenericClockInit, type GenericClockPlan, type RegisterClockPlan } from "./register-clock.js";
import { renderLedFunctions } from "./register-gpio.js";
import { planRegisterLinker, renderLinkerScript } from "./register-linker.js";
import { backupBeforeOverwrite, backupWarning, cleanupAfterFailure, mkdirTracked, preflightTarget, templateDir, writeVscodeConfigs, type OverwriteBackup } from "./scaffold.js";

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
  /**
   * 覆盖下载清单里的 sha256（path → 期望值）。**只给测试用**：
   * 单测的假 fetch 返回的是拼出来的假内容，生产哈希必然对不上；
   * 注入"假内容的真实哈希"来验证哈希校验这条链路本身。
   * 生产调用一律不传，targets 用 cmsis-sources 里的实测值。
   */
  hashes?: Record<string, string>;
}

/** 型号/族 → 启动文件与设备宏；认不出返回 null（不猜文件名）。 */
export function resolveStartupChoice(request: { mcu?: string; family?: string }, env: NodeJS.ProcessEnv = process.env): StartupChoice | null {
  const mcu = (request.mcu ?? "").trim();
  if (mcu !== "") return startupChoiceFor(mcu, env);
  const family = (request.family ?? "F1").trim().toUpperCase();
  // 只给族时只有 F1 有默认档（中容量 xB，蓝丸 C8T6 正是这一档）。
  // 其它族必须给具体型号：同一族里不同 line 的启动文件/设备头完全不同，猜一个就是编文件名。
  if (family !== "F1") return null;
  return startupChoiceFor("F1:B", env);
}

export interface TemplateResult {
  ok: boolean;
  family: string;
  /** 缓存条目 id，例如 cmsis:F1:103xb（0.1 是 cmsis:F1:startup_stm32f103xb）。 */
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
  const choice = resolveStartupChoice(request, env);
  if (choice === null) {
    const asked = (request.mcu ?? request.family ?? "").trim();
    // 内置资源不全时，型号解析必然是空——这种时候要说清「先确认内置资源完整」，别让人以为型号写错了。
    if (deviceFactsSource({ ...process.env, ...env }) === "none") {
      return emptyResult(
        info.root,
        "facts-missing",
        "设备事实还没就绪：找不到插件内置的芯片表（assets/device/…）；先跑 stm32_assets verify 确认安装完整（缺文件就重装插件），再建工程。",
      );
    }
    // F103 家族里上游没有的容量档要单独说清楚（A24）：说"认不出"会让人以为插件坏了。
    const f103 = /^STM32F103([A-Z])([0-9A-Z])/u.exec(asked.toUpperCase());
    if (/^STM32F1/u.test(asked.toUpperCase())) {
      const densityNote = f103 !== null
        ? "上游 CMSIS 只有 x6 / xB / xE 三套启动文件，没有容量档 " + (f103[2] ?? "") + " 这一套：F103 的 4/8/6 档归到 x6 或 xB，C/D/E 档归到 xE。换 STM32F103C8T6 / CBT6 这类型号，"
        : "换一颗内置资源里收录的 F1 型号，";
      return emptyResult(
        info.root,
        "unsupported-mcu",
        "认不出这颗芯片的启动文件：" + (asked || "(没给型号)") + "。" + densityNote + "或改用 HAL 路线（.ioc + CubeMX）。",
      );
    }
    return emptyResult(
      info.root,
      "unsupported-mcu",
      "寄存器版暂时不支持这颗芯片：" + (asked || "(没给型号)") + "。支持 " + Object.keys(CMSIS_FAMILIES).join("/") + " 这 " + String(Object.keys(CMSIS_FAMILIES).length) +
        " 族（芯片事实来自内置资源 chips.json：先跑 stm32_assets verify，或确认这一版内置资源收了该族）；" +
        "其它族走 HAL 路线（stm32_project_create route=hal，需要 CubeMX 固件包）。",
    );
  }
  const plan = cmsisTemplatePlan(choice);
  if (plan === null) return emptyResult(info.root, "unsupported-family", "这一代还没有下载清单：" + choice.family + "。");

  const { index, error: indexError } = readCacheIndex(env);
  if (indexError !== null) request.onProgress?.(indexError);

  // 用别名解析而不是精确匹配：0.1 建过的 cmsis:F1:startup_stm32f103xb 条目内容完全一样，
  // 认不出就会白下一遍 14 个文件（还可能在慢网里失败）。
  const existing = resolveCacheEntry(index, plan.id);
  /** 复用已有目录但只补缺的文件（见下面"清单变长"的说明）。 */
  let reuseRoot = "";
  if (existing !== null) {
    const health = checkCacheEntry(existing);
    // 索引只记"上次写了哪些文件"，不会自动知道清单变长。插件升级给同一族加了文件
    // （例如补 mpu_armv7.h）之后，旧缓存按索引看是完整的，但编译会 fatal error 缺头文件。
    // 所以缓存命中前还要按当前清单逐个确认文件在盘上，缺的补下。
    const missing = plan.targets.filter((target) => !fs.existsSync(path.join(existing.root, ...target.path.split("/"))));
    if (health.ok && missing.length === 0) {
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
    if (health.ok && missing.length > 0) {
      reuseRoot = existing.root;
      request.onProgress?.("缓存条目 " + plan.id + " 比当前清单少 " + String(missing.length) + " 个文件（" + missing.map((target) => target.path).join("、") + "），只补这几个。");
    } else {
      request.onProgress?.("缓存条目 " + plan.id + " 有 " + String(broken) + " 个文件缺失或大小不对，重新下载。");
    }
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

  const entryDir = reuseRoot === "" ? path.join(info.root, plan.dirName) : reuseRoot;
  fs.mkdirSync(entryDir, { recursive: true });
  // 复用旧目录时只下缺的：已经有的文件不重复拉，也避免把刚补的文件覆盖成半截。
  const pending = reuseRoot === ""
    ? plan.targets
    : plan.targets.filter((target) => !fs.existsSync(path.join(entryDir, ...target.path.split("/"))));
  request.onProgress?.("下载 " + String(pending.length) + " 个模板文件到 " + entryDir + "（第一次用需要联网，以后复用缓存）。");

  const options: FetchOptions = {
    onProgress: (outcome: FetchOutcome, done: number, total: number) => {
      request.onProgress?.("下载 " + String(done) + "/" + String(total) + "：" + outcome.path + (outcome.ok ? " ✓" : " ✗ " + outcome.error));
    },
  };
  if (request.fetchImpl !== undefined) options.fetchImpl = request.fetchImpl;
  if (request.signal !== undefined) options.signal = request.signal;

  const targets = request.hashes === undefined
    ? pending
    : pending.map((target) => ({ ...target, sha256: request.hashes?.[target.path] }));
  const fetched = await fetchAll(targets, entryDir, options);
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
        "模板没下下来（" + String(fetched.failed) + "/" + String(pending.length) + " 个文件失败）。" + cleanupNote + "第一条失败原因：" + (failures[0] ?? "(未知)") + "。"
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
  // 复用旧目录时，旧文件也要留在索引里（否则下次 checkCacheEntry 会将其判定为"缺失"并重新下载一遍）。
  const noticesName = "THIRD_PARTY_NOTICES.md";
  const keptFiles: CacheFile[] = reuseRoot === "" || existing === null
    ? []
    : existing.files.filter((item) => item.path !== noticesName && fetched.results.every((outcome) => outcome.path !== item.path));
  const files: CacheFile[] = keptFiles.concat(fetched.results.map((outcome) => {
    const item: CacheFile = { path: outcome.path, bytes: outcome.bytes, url: outcome.url };
    try {
      item.sha256 = sha256OfFile(path.join(entryDir, ...outcome.path.split("/")));
    } catch {
      // 落盘文件读不出来就别登记哈希，校验时退回只看字节数。
    }
    return item;
  }));
  const upstream = new Set<string>();
  for (const target of plan.targets) for (const url of target.urls) upstream.add(url);

  // notices 也是条目的一部分，必须进入 files[]（A24）：否则 checkCacheEntry 永不校验该文件，
  // 手工删除后索引仍显示"完整"。
  const noticesPath = path.join(entryDir, noticesName);
  fs.writeFileSync(noticesPath, plan.license, "utf8");
  const noticesFile: CacheFile = { path: noticesName, bytes: Buffer.byteLength(plan.license, "utf8"), url: "" };
  try {
    noticesFile.sha256 = sha256OfFile(noticesPath);
  } catch {
    // 同上。
  }
  files.push(noticesFile);
  const totalBytes = fetched.bytes + noticesFile.bytes + keptFiles.reduce((sum, item) => sum + item.bytes, 0);

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
  /** 测试注入：path → 期望 sha256（见 TemplateRequest.hashes）。 */
  hashes?: Record<string, string>;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
  download?: boolean;
  /** 探针实见决定的 openocd interface（实见 ST-Link 时写 stlink-dap）；缺省沿用模板的 cmsis-dap。 */
  interfaceConfig?: string;
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
  /** ST 器件代号，例如 STM32F103C8Tx（链接脚本名用）。 */
  deviceId: string;
  /** 按型号渲染的链接脚本文件名，例如 STM32F103C8Tx_FLASH.ld。 */
  linkerScript: string;
  flashBytes: number;
  ramBytes: number;
  /** clock_init() 拿到的 SYSCLK（Hz）。 */
  sysclkHz: number;
  /** 时钟摘要，例如 72 MHz（HSE 8 MHz × 9；…）。 */
  clockSummary: string;
  cacheRoot: string;
  cacheHit: boolean;
  templateFiles: number;
  driverFiles: number;
  durationMs: number;
  warnings: string[];
  message: string;
}

/**
 * 从 HAL 骨架模板里借来的**与 HAL 无关**的文件（工具链、presets、.gitignore）。
 *
 * 链接脚本不在该表中：该文件是寄存器路线里唯一必须按型号修改的模板（ST 版本写死
 * 64K FLASH / 20K RAM），所以从 HAL 骨架读原文本、改 MEMORY 两行、另存为
 * <DeviceId>_FLASH.ld（见 register-linker.ts）。这四个文件数目固定；工程文件总数由
 * templateFiles 计数（CMakeLists + main.c + rtt.c/rtt.h + 这四个 + 链接脚本 + .vscode 三份 = 12）。
 */
const SHARED_TEMPLATE_FILES = ["CMakePresets.json", ".gitignore", "cmake/gcc-arm-none-eabi.cmake", "openocd.cfg"];

/** 链接脚本的"源模板"（HAL 骨架里那份，按型号渲染后另存）。 */
const LINKER_TEMPLATE_FILE = "STM32F103XX_FLASH.ld";

/**
 * 内核头 → GCC 的 -mcpu 值。
 *
 * 模板工具链文件是为蓝丸写的（-mcpu=cortex-m3）；寄存器路线要按这一代的内核替换，
 * 否则 H7/M33 的启动文件与内核头会被当成 M3 编译：cache 指令（cachel1_armv7.h 的内联汇编）
 * 与 M33 的启动序列都会在汇编阶段报错。HAL 路线不在此处修改（其按 .ioc 配置走 CubeMX 的工程）。
 */
function coreFlagOf(coreHeader: string): string {
  switch (coreHeader) {
    case "core_cm0.h": return "cortex-m0";
    case "core_cm0plus.h": return "cortex-m0plus";
    case "core_cm3.h": return "cortex-m3";
    case "core_cm4.h": return "cortex-m4";
    case "core_cm7.h": return "cortex-m7";
    case "core_cm33.h": return "cortex-m33";
    default: return "cortex-m3";
  }
}

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
 * 建一个寄存器版工程：模板（CMakeLists + main.c + 可选 RTT 的 rtt.c/rtt.h）来自插件，
 * CMSIS/启动文件来自缓存，工具链与链接脚本复用 HAL 骨架里那几份**不含 HAL 内容**的文件。
 *
 * RTT 那两个文件是"编进来但默认不启用"：main.c 里 rtt_init() 是注释掉的，工具链开了
 * --gc-sections，所以不调用时 rtt.c 的代码与 3 KB 控制块缓冲会被链接器丢掉，不占 RAM/Flash。
 * 这样模板既能被 stm32_rtt 直接支持，又不给不用 RTT 的人增加成本。
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
    deviceId: "",
    linkerScript: "",
    flashBytes: 0,
    ramBytes: 0,
    sysclkHz: 0,
    clockSummary: "",
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
    ...(request.hashes === undefined ? {} : { hashes: request.hashes }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress }),
    ...(request.download === undefined ? {} : { download: request.download }),
  });
  if (!template.ok) return fail(template.message);

  const choice = resolveStartupChoice({ ...(request.mcu === undefined ? {} : { mcu: request.mcu }), ...(request.family === undefined ? {} : { family: request.family }) }, request.env);
  if (choice === null || cmsisTemplatePlan(choice) === null) return fail("内部错误：缓存条目对应的下载清单没了（" + template.family + "）。");
  const chip = choice.chip;
  const facts = choice.facts;
  if (chip === undefined && facts === undefined) return fail("内部错误：缓存条目没带回芯片信息（" + template.family + "）。");
  const spec = CMSIS_FAMILIES[template.family];
  if (spec === undefined) return fail("内部错误：这一代没有设备头规格（" + template.family + "）。");
  // 链接脚本按型号即时计算：寄存器路线没有 CubeMX 代为计算，写死 C8T6 的 64K/20K
  // 会让 F103ZE / F100C6 这类芯片要么链不下、要么把栈顶伸到不存在的 RAM。
  const linker = planRegisterLinker(chip ?? facts!);
  // 时钟分两路：F1 有验证过的 PLL 配方；其它族如实留空（复位时钟），不猜 PLL 字段。
  const f1Clock = chip === undefined ? null : planRegisterClock(chip);
  const clock: RegisterClockPlan | GenericClockPlan = f1Clock
    ?? planGenericClock({ cpn: mcu, family: template.family, systemC: spec.systemC });
  const familyDir = spec.deviceDefinePrefix + "xx";
  const led = renderLedFunctions(template.family);

  const regTpl = registerTemplateDir();
  const halTpl = templateDir();
  if (!fs.existsSync(regTpl)) return fail("插件模板目录缺失：" + regTpl + "（重新安装插件）");

  // 要读的模板文件、要拷的 Drivers，全部在**写盘之前**检查一遍：
  // 半路才发现插件包缺文件，留下的就是一个比没有更糟的半成品工程。
  // 例外：.gitignore 不在检查列表中——npm 打包始终排除点文件（.gitignore 同时是其
  // 忽略过滤器），npm 安装的用户模板中必然没有该文件；缺失仅影响 git 状态显示，工程照常创建。
  const missingOptional: string[] = [];
  // 全量预检（0b）：一次列全所有缺失的必需文件，避免用户每修一个再重试一次。
  const required = [
    path.join(regTpl, "CMakeLists.txt"),
    path.join(regTpl, "Core", "Src", "main.c"),
    // 极简 RTT：CMakeLists 已经 add_executable 了 Core/Src/rtt.c，缺了会 link error；
    // main.c 里也 include 了 rtt.h，缺了连编译都过不了。所以两个都算必需文件。
    path.join(regTpl, "Core", "Src", "rtt.c"),
    path.join(regTpl, "Core", "Inc", "rtt.h"),
    // 链接脚本模板：按型号渲染的那份由该模板生成，缺失时只能创建 C8T6 尺寸的工程
    path.join(halTpl, LINKER_TEMPLATE_FILE),
    ...SHARED_TEMPLATE_FILES.filter((rel) => rel !== ".gitignore").map((rel) => path.join(halTpl, rel)),
  ];
  const missingRequired = required.filter((source) => !fs.existsSync(source));
  if (missingRequired.length > 0) {
    const list = missingRequired.map((source) => "  · " + source).join("\n");
    return fail(
      "插件模板缺 " + String(missingRequired.length) + " 个文件（一次列完）：\n" + list +
        "\n这是插件包损坏（安装中断或目录被杀毒软件动过），不是工程或配置的问题；" +
        "带插件版本号（见 package.json）反馈最有效。",
    );
  }
  if (!fs.existsSync(path.join(halTpl, ".gitignore"))) missingOptional.push(".gitignore");
  const driversSrc = path.join(template.entryDir, "Drivers");
  if (!fs.existsSync(driversSrc)) return fail("缓存的模板目录不完整（缺 Drivers）：" + template.entryDir + "。删除该目录后重试将重新下载。");

  // 覆盖前先备份将被覆盖的同名文件；备份失败就一个字节都不写（否则用户的 main.c 就没了）。
  let backup: OverwriteBackup;
  try {
    backup = backupBeforeOverwrite(
      targetDir,
      ["CMakeLists.txt", "Core/Src/main.c", "Core/Src/rtt.c", "Core/Inc/rtt.h", linker.fileName, ...SHARED_TEMPLATE_FILES],
      "register",
    );
  } catch (error) {
    return fail("没写任何文件：覆盖前的备份失败（" + String((error as Error).message) + "）。目标目录 " + targetDir + " 未被改动。");
  }
  const backupNote = backupWarning(backup);

  // 1) 寄存器版 CMakeLists / main.c：替换占位符
  const clockText = clock.sysclkHz > 0
    ? "SYSCLK " + String(Math.round(clock.sysclkHz / 1e6)) + " MHz"
    : "复位时钟（未配 PLL）";
  const chipBanner = mcu.toUpperCase() + " · " + linker.summary + " · " + clockText;
  const replacements: Record<string, string> = {
    __PROJECT_NAME__: projectName,
    __FAMILY_DIR__: familyDir,
    __STARTUP_FILE__: template.startup,
    __DEVICE_DEFINE__: template.deviceDefine,
    __LINKER_SCRIPT__: linker.fileName,
    __MCU_BANNER__: chipBanner,
    __CLOCK_INIT__: f1Clock === null ? renderGenericClockInit(clock as GenericClockPlan) : renderClockInit(clock as RegisterClockPlan),
    __SYSTEM_C__: spec.systemC,
    __DEVICE_UMBRELLA__: spec.deviceHeaders[0] ?? "",
    __LED_INIT__: led.text,
  };
  const fill = (text: string): string => {
    let out = text;
    for (const [key, value] of Object.entries(replacements)) out = out.split(key).join(value);
    return out;
  };

  // 链接脚本先渲染（纯字符串替换）：模板被修改导致四处标记缺一处时，应在写盘之前拒绝，
  // 而非生成一个 RAM/Flash 尺寸错误的工程——该工程可编译，烧录后才出现故障。
  const linkerText = renderLinkerScript(linker, fs.readFileSync(path.join(halTpl, LINKER_TEMPLATE_FILE), "utf8"));
  if (linkerText === null) {
    return fail(
      "链接脚本模板里没找到该改的四处（MEMORY 的 RAM/FLASH 两行 + 注释两行）：" + path.join(halTpl, LINKER_TEMPLATE_FILE) +
        "。这是插件模板被改坏，不是工程问题；带插件版本号反馈最有效。一个字节都没写。",
    );
  }

  const targetExistedBefore = fs.existsSync(targetDir);
  const driversExistedBefore = fs.existsSync(path.join(targetDir, "Drivers"));
  const createdDirs: string[] = [];
  // 2 = CMakeLists.txt + Core/Src/main.c；rtt.c/rtt.h 也是模板直接拷的，一并计数（见下面 3)。
  let templateFiles = 4;
  try {
    mkdirTracked(path.join(targetDir, "Core", "Src"), createdDirs);
    mkdirTracked(path.join(targetDir, "Core", "Inc"), createdDirs);

    // 1) CMakeLists.txt
    fs.writeFileSync(path.join(targetDir, "CMakeLists.txt"), fill(fs.readFileSync(path.join(regTpl, "CMakeLists.txt"), "utf8")), "utf8");

    // 2) 寄存器版 main.c：芯片注释 + 按型号生成的 clock_init()
    fs.writeFileSync(path.join(targetDir, "Core", "Src", "main.c"), fill(fs.readFileSync(path.join(regTpl, "Core", "Src", "main.c"), "utf8")), "utf8");

    // 3) 极简 RTT（SEGGER 兼容控制块 + 4+1+8+payload 帧）：原样拷贝，不做占位符替换。
    //    CMakeLists 已编译该文件，main.c 已 include 该头文件；rtt_init() 是否调用由用户在 USER CODE 2 决定。
    fs.writeFileSync(path.join(targetDir, "Core", "Src", "rtt.c"), fs.readFileSync(path.join(regTpl, "Core", "Src", "rtt.c"), "utf8"), "utf8");
    fs.writeFileSync(path.join(targetDir, "Core", "Inc", "rtt.h"), fs.readFileSync(path.join(regTpl, "Core", "Inc", "rtt.h"), "utf8"), "utf8");

    // 4) 与 HAL 无关的公共文件：工具链 / presets（.gitignore 缺失时跳过，见上面 missingOptional）
    for (const rel of SHARED_TEMPLATE_FILES) {
      if (rel === ".gitignore" && missingOptional.includes(rel)) continue;
      const dest = path.join(targetDir, rel);
      mkdirTracked(path.dirname(dest), createdDirs);
      if (rel === "cmake/gcc-arm-none-eabi.cmake") {
        // 工具链文件里的 -mcpu=cortex-m3 是按内核头换掉的（H7 → cortex-m7，M33 族 → cortex-m33）。
        const cpu = coreFlagOf(spec.coreHeader);
        const text = fs.readFileSync(path.join(halTpl, rel), "utf8").split("-mcpu=cortex-m3").join("-mcpu=" + cpu);
        fs.writeFileSync(dest, text, "utf8");
      } else if (rel === "openocd.cfg" && request.interfaceConfig !== undefined && request.interfaceConfig !== "" && request.interfaceConfig !== "interface/cmsis-dap.cfg") {
        // 与 .vscode/launch.json 同口径：实见 ST-Link 却写 cmsis-dap，F5 会撞 transport 不支持。
        const text = fs.readFileSync(path.join(halTpl, rel), "utf8").split("interface/cmsis-dap.cfg").join(request.interfaceConfig);
        fs.writeFileSync(dest, text, "utf8");
      } else {
        fs.copyFileSync(path.join(halTpl, rel), dest);
      }
      templateFiles += 1;
    }

    // 5) 按型号渲染的链接脚本：MEMORY 两行 + 注释两行换成本芯片的真实 Flash/RAM
    fs.writeFileSync(path.join(targetDir, linker.fileName), linkerText, "utf8");
    templateFiles += 1;

    // 6) CMSIS：缓存条目里的 Drivers 整棵拷进工程（与 HAL 工程布局一致）
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

  // .vscode：register 路线不走 scaffold，但用户在 VSCode 里按 F5 烧录/调试靠的就是这三份文件。
  // 放在引擎里而不是工具里，是为了让直接调引擎的调用方（测试、别的工具）也拿到同样的工程。
  const vscode = writeVscodeConfigs({
    targetDir,
    projectName,
    ...(request.interfaceConfig === undefined ? {} : { interfaceConfig: request.interfaceConfig }),
    binDirs: [],
  });
  templateFiles += vscode.files.length;

  const warnings: string[] = [];
  if (missingOptional.includes(".gitignore")) {
    warnings.push(
      "插件包中没有 .gitignore（npm 打包会排除该文件）：工程功能不受影响，仅 git 状态会多出 build/ 目录。" +
        "如需保持整洁，可在工程根目录创建 .gitignore，内容为一行：build/",
    );
  }
  // 备份清单放第一条：用户看到"覆盖成功"时，第一眼得知道旧文件去哪了。
  if (backupNote !== null) warnings.push(backupNote);
  if (vscode.error !== "") warnings.push(vscode.error);
  for (const w of vscode.warnings) warnings.push(w);
  warnings.push(
    "模板里的 LED 是蓝丸的 PC13（低电平点亮）；换板子改 Core/Src/main.c 的 LED_PIN 与 led_init()。",
    "寄存器版没有 .ioc：不需要 CubeMX，也不需要固件包；要换成 HAL 版就用 stm32_project_create route=hal。",
    "链接脚本已按型号渲染：" + linker.fileName + "（" + linker.summary + "），拷自 templates/scaffold/" + LINKER_TEMPLATE_FILE + "。",
    f1Clock === null
      ? "时钟：" + clock.summary + "（未代为配置 PLL，理由见 main.c 的 clock_init() 注释）。"
      : "时钟在 main.c 的 clock_init() 里现配：" + clock.summary + "（HSE 不起振就自动退回 HSI/2 ×" + String(f1Clock.hsiMul) + "）。",
  );
  // 链接脚本/时钟/LED 的告警来自按型号推导本身（RAM 用了保守下限、HSI 到不了上限、这一族没有验证过的 GPIO 写法…），
  // 用户需了解"频率为 64 MHz 而非 72"以及"LED 不闪烁"的原因。
  warnings.push(...linker.warnings, ...clock.warnings, ...led.warnings);
  // RTT 是"编入但默认不启用"，用户需了解启用方式及其占用多少 RAM——
  // 否则 dump 时只会看到"控制块是空的"，需回头查阅模板。
  warnings.push(
    "RTT 已随工程就位（Core/Src/rtt.c + Core/Inc/rtt.h，SEGGER 兼容控制块、通道 0 按 4+1+8+payload 写帧），" +
      "但默认未启用：取消 main.c 中 USER CODE BEGIN 2 的 rtt_init() 注释后才会链接进来（否则 --gc-sections 会将其丢弃）。" +
      "启用后 3 个通道 × 1 KB = 3 KB RAM；dump 前先用 nm 拿 _SEGGER_RTT 地址再 stm32_rtt action=start addr=…。",
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
    deviceId: linker.deviceId,
    linkerScript: linker.fileName,
    flashBytes: linker.flashBytes,
    ramBytes: linker.ramBytes,
    sysclkHz: clock.sysclkHz,
    clockSummary: clock.summary,
    cacheRoot: template.cacheRoot,
    cacheHit: template.cacheHit,
    templateFiles,
    driverFiles,
    durationMs: Date.now() - startedAt,
    warnings,
    message:
      "寄存器版工程已建好（" + String(templateFiles) + " 个工程文件 + " + String(driverFiles) + " 个 CMSIS 文件）：" + targetDir +
      "；芯片 " + chipBanner +
      (backupNote === null ? "" : "；" + backupNote),
  };
}
