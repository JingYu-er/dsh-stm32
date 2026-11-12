/**
 * 安装包下载（只下载，不执行安装器）。
 *
 * 设计边界：
 *   - J-Link：SEGGER 安装包有稳定直链与官方哈希，可以下载到本地并校验；
 *   - STM32CubeMX / STM32CubeProgrammer：ST 官网通常要求登录/接受许可，直链会过期，
 *     所以默认只给官方页面；用户自己下载后可以把本地安装包路径交给工具做校验。
 *   - 本模块绝不 spawn 安装器，也不请求管理员权限。
 *
 * 下载目录：DSH_STM32_DOWNLOADS 覆盖，默认 %LOCALAPPDATA%\dsh-stm32\downloads。
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export type DownloadComponent = "jlink" | "cubemx" | "cubeprogrammer";

export interface DownloadPlan {
  component: DownloadComponent;
  label: string;
  mode: "direct" | "manual";
  version: string;
  /** 可直链下载时非空；manual 模式为空串。 */
  url: string;
  /** 官方下载页。 */
  page: string;
  /** 官方提供的 SHA256；没有就是空串（不要把计算值伪装成官方值）。 */
  expectedSha256: string;
  fileName: string;
  targetPath: string;
  installHint: string;
  licenseNote: string;
}

export interface DownloadRootInfo {
  root: string;
  origin: string;
}

export interface DownloadFileResult {
  path: string;
  bytes: number;
  sha256: string;
  cached: boolean;
}

/** 2026-11-10 从 winget 的 NordicSemiconductor.JLink 8.18.0 manifest 取的值；升级要同步改这里。 */
export const JLINK_DOWNLOAD = {
  version: "8.18.0",
  url: "https://files.nordicsemi.com/artifactory/swtools/external/jlink/JLink_Windows_V818_x86_64.exe",
  sha256: "63110b6fc55e494d197d6efa156d7f61c0dd0c1f776424995a05407e2d7f566f",
  fileName: "JLink_Windows_V818_x86_64.exe",
  page: "https://www.segger.com/downloads/jlink/",
} as const;

const ST_PAGES: Record<"cubemx" | "cubeprogrammer", { label: string; page: string; installHint: string }> = {
  cubemx: {
    label: "STM32CubeMX",
    page: "https://www.st.com/en/development-tools/stm32cubemx.html",
    installHint:
      "从官方页登录 myST、接受许可并下载安装包；默认目录 C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeMX 会被 stm32_doctor 自动发现。",
  },
  cubeprogrammer: {
    label: "STM32CubeProgrammer",
    page: "https://www.st.com/en/development-tools/stm32cubeprog.html",
    installHint:
      "从官方页登录 myST、接受许可并下载安装包；默认路径会被 stm32_doctor 自动发现。它的 SWD 路径只认 ST-LINK。",
  },
};

export class DownloadError extends Error {
  readonly kind: string;
  readonly retryable: boolean;
  constructor(kind: string, message: string, retryable = false) {
    super(message);
    this.name = "DownloadError";
    this.kind = kind;
    this.retryable = retryable;
  }
}

export function isDownloadComponent(value: string): value is DownloadComponent {
  return value === "jlink" || value === "cubemx" || value === "cubeprogrammer";
}

/** 下载目录：DSH_STM32_DOWNLOADS 覆盖，其次 LOCALAPPDATA，再退 USERPROFILE、临时目录。 */
export function downloadRootInfo(env: NodeJS.ProcessEnv = process.env): DownloadRootInfo {
  const override = (env.DSH_STM32_DOWNLOADS ?? "").trim();
  if (override !== "") {
    return { root: path.resolve(expandHome(override, env)), origin: "DSH_STM32_DOWNLOADS" };
  }
  const localAppData = (env.LOCALAPPDATA ?? "").trim();
  if (localAppData !== "") {
    return { root: path.join(localAppData, "dsh-stm32", "downloads"), origin: "LOCALAPPDATA" };
  }
  const userProfile = (env.USERPROFILE ?? "").trim();
  if (userProfile !== "") {
    return { root: path.join(userProfile, "AppData", "Local", "dsh-stm32", "downloads"), origin: "USERPROFILE" };
  }
  return { root: path.join(tmpdir(), "dsh-stm32-downloads"), origin: "临时目录（没有 LOCALAPPDATA/USERPROFILE）" };
}

function expandHome(value: string, env: NodeJS.ProcessEnv): string {
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    const home = (env.USERPROFILE ?? env.HOME ?? homedir()).trim();
    if (home !== "") return path.join(home, value.slice(1));
  }
  return value;
}

export function planDownload(
  component: DownloadComponent,
  options: { env?: NodeJS.ProcessEnv; outDir?: string } = {},
): DownloadPlan {
  const env = options.env ?? process.env;
  const info = downloadRootInfo(env);
  const root = options.outDir !== undefined && options.outDir.trim() !== "" ? path.resolve(options.outDir) : info.root;
  if (component === "jlink") {
    // 官方只有一条可校验的直链。允许内网镜像覆盖，但必须同时给 sha256——
    // 没有哈希的覆盖会让"下载 J-Link"变成"执行一个来源不明的 exe"，一律拒绝并回默认源。
    const overrideUrl = (env.DSH_STM32_JLINK_URL ?? "").trim();
    const overrideSha = (env.DSH_STM32_JLINK_SHA256 ?? "").trim().toLowerCase();
    const useOverride = /^https?:\/\//iu.test(overrideUrl) && /^[0-9a-f]{64}$/u.test(overrideSha);
    const url = useOverride ? overrideUrl : JLINK_DOWNLOAD.url;
    const sha256 = useOverride ? overrideSha : JLINK_DOWNLOAD.sha256;
    const fileName = useOverride ? path.basename(new URL(overrideUrl).pathname) : JLINK_DOWNLOAD.fileName;
    return {
      component,
      label: "SEGGER J-Link Software and Documentation Pack",
      mode: "direct",
      version: JLINK_DOWNLOAD.version,
      url,
      page: JLINK_DOWNLOAD.page,
      expectedSha256: sha256,
      fileName,
      targetPath: path.join(root, fileName),
      installHint:
        "下载后双击安装。只装软件可不请求管理员；要装 USB 驱动需要在安装器里选 all users 并允许 UAC。现代 J-Link 探针默认 WinUSB，老探针才需要 legacy USB 驱动。",
      licenseNote: "SEGGER 软件许可；插件只下载，不执行安装器。",
    };
  }
  const st = ST_PAGES[component];
  return {
    component,
    label: st.label,
    mode: "manual",
    version: "",
    url: "",
    page: st.page,
    expectedSha256: "",
    fileName: "",
    targetPath: "",
    installHint: st.installHint,
    licenseNote: "ST 官网需要登录 myST 并接受许可，插件不绕过；请自己下载，或把已下载的安装包路径传给 file。",
  };
}

/**
 * 下载到 targetPath 并校验 SHA256。
 *
 * 写临时文件再 rename，下载失败/哈希不符不会留下半个“安装包”。
 * 目标已存在且哈希正确时直接复用；哈希不符则重新下载。
 */
export async function downloadUrlToFile(
  url: string,
  targetPath: string,
  expectedSha256: string,
  options: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number } = {},
): Promise<DownloadFileResult> {
  const expected = expectedSha256.trim().toLowerCase();
  if (existsSync(targetPath)) {
    const existing = statSync(targetPath);
    if (existing.isFile()) {
      const hash = await sha256File(targetPath);
      if (expected === "" || hash === expected) {
        return { path: targetPath, bytes: existing.size, sha256: hash, cached: true };
      }
    }
  }

  mkdirSync(path.dirname(targetPath), { recursive: true });
  const part = targetPath + ".part-" + String(process.pid) + "-" + String(Date.now());
  const timeoutMs = Math.max(5_000, options.timeoutMs ?? 10 * 60_000);
  const maxBytes = options.maxBytes ?? 300 * 1024 * 1024;
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = (): void => controller.abort();
  if (options.signal !== undefined) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!response.ok) {
      throw new DownloadError("download-failed", "下载失败：HTTP " + String(response.status) + " " + response.statusText, response.status >= 500);
    }
    if (response.body === null) throw new DownloadError("download-failed", "下载失败：响应没有 body", true);
    const announced = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(announced) && announced > maxBytes) {
      throw new DownloadError("too-large", "安装包超过上限 " + String(maxBytes) + " 字节（服务器声明 " + String(announced) + "）");
    }

    handle = await open(part, "w");
    const hash = createHash("sha256");
    let bytes = 0;
    const reader = response.body.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new DownloadError("too-large", "安装包超过上限 " + String(maxBytes) + " 字节");
      hash.update(value);
      await handle.write(value);
    }
    await handle.close();
    handle = undefined;
    const actual = hash.digest("hex");
    if (expected !== "" && actual !== expected) {
      throw new DownloadError(
        "checksum-mismatch",
        "SHA256 不符：期望 " + expected + "，实际 " + actual + "（已删除临时文件）",
        true,
      );
    }
    // Windows 的 rename 不覆盖已存在文件；先删旧目标（旧目标哈希已不符），再原子换名。
    if (existsSync(targetPath)) unlinkSync(targetPath);
    const fs = await import("node:fs");
    fs.renameSync(part, targetPath);
    return { path: targetPath, bytes, sha256: actual, cached: false };
  } catch (error) {
    if (handle !== undefined) {
      try { await handle.close(); } catch { /* 已关 */ }
    }
    try { if (existsSync(part)) unlinkSync(part); } catch { /* 清理失败不掩盖主错误 */ }
    if (error instanceof DownloadError) throw error;
    if (timedOut) throw new DownloadError("timeout", "下载超时（" + String(timeoutMs) + " ms）", true);
    if (controller.signal.aborted) throw new DownloadError("cancelled", "下载已取消", false);
    throw new DownloadError("download-failed", "下载失败：" + (error instanceof Error ? error.message : String(error)), true);
  } finally {
    clearTimeout(timer);
    if (options.signal !== undefined) options.signal.removeEventListener("abort", onAbort);
  }
}

/** 计算文件 SHA256（流式，不把安装包读进内存）。 */
export async function sha256File(file: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

/** 校验用户已经下载好的安装包；不复制、不执行。 */
export async function inspectInstallerFile(
  file: string,
  expectedSha256 = "",
): Promise<{ path: string; bytes: number; sha256: string; expectedSha256: string; verified: boolean }> {
  const resolved = path.resolve(expandHome(file.trim(), process.env));
  const stat = statSync(resolved, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile()) {
    throw new DownloadError("file-not-found", "找不到安装包文件：" + resolved);
  }
  if (stat.size <= 0) throw new DownloadError("file-invalid", "安装包是空文件：" + resolved);
  const hash = await sha256File(resolved);
  const expected = expectedSha256.trim().toLowerCase();
  const verified = expected === "" ? false : hash === expected;
  if (expected !== "" && !verified) {
    throw new DownloadError("checksum-mismatch", "SHA256 不符：期望 " + expected + "，实际 " + hash, false);
  }
  return { path: resolved, bytes: stat.size, sha256: hash, expectedSha256: expected, verified };
}
