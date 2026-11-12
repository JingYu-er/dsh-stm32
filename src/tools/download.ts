/**
 * L3：stm32_download —— 只下载安装包，不执行安装器。
 *
 * 为什么下载与安装分离：J-Link/CubeMX/CubeProgrammer 的安装器会写注册表、
 * 装 USB 驱动、改 PATH，甚至要 UAC。插件把下载和安装拆开，用户自己决定什么时候双击。
 */

import { spawn } from "node:child_process";
import {
  DownloadError,
  downloadRootInfo,
  downloadUrlToFile,
  inspectInstallerFile,
  isDownloadComponent,
  planDownload,
  type DownloadComponent,
  type DownloadPlan,
} from "../engine/download.js";
import type { DshContext, JsonSchema, ToolExec } from "../types.js";

export const DOWNLOAD_TOOL = "stm32_download";

export const outputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: { type: "string" },
    report: {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { type: "boolean" },
        component: { type: "string" },
        label: { type: "string" },
        mode: { type: "string", enum: ["direct", "manual", "file"] },
        version: { type: "string" },
        url: { type: "string" },
        page: { type: "string" },
        sha256: { type: "string" },
        expectedSha256: { type: "string" },
        filePath: { type: "string" },
        bytes: { type: "number" },
        downloaded: { type: "boolean" },
        cached: { type: "boolean" },
        verified: { type: "boolean" },
        opened: { type: "boolean" },
        installHint: { type: "string" },
        licenseNote: { type: "string" },
        downloadRoot: { type: "string" },
        downloadRootOrigin: { type: "string" },
        notes: { type: "array", items: { type: "string" } },
        errors: { type: "array", items: { type: "string" } },
      },
      required: [
        "ok", "component", "label", "mode", "version", "url", "page", "sha256",
        "expectedSha256", "filePath", "bytes", "downloaded", "cached", "verified",
        "opened", "installHint", "licenseNote", "downloadRoot", "downloadRootOrigin",
        "notes", "errors",
      ],
    },
  },
  required: ["message", "report"],
};

interface DownloadArgs {
  component?: string;
  /** 默认 true：只返回计划，不下载。 */
  dryRun?: boolean;
  /** 真正下载/打开官方页前必须显式确认。 */
  confirm?: boolean;
  /** 用户已经下载好的安装包；只校验，不复制、不执行。 */
  file?: string;
  /** 覆盖下载目录。 */
  outDir?: string;
  /** manual 模式下是否打开官方页；默认 true，但只有 dryRun:false + confirm:true 才执行。 */
  openPage?: boolean;
  timeoutMs?: number;
}

interface DownloadReport {
  ok: boolean;
  component: string;
  label: string;
  mode: "direct" | "manual" | "file";
  version: string;
  url: string;
  page: string;
  sha256: string;
  expectedSha256: string;
  filePath: string;
  bytes: number;
  downloaded: boolean;
  cached: boolean;
  verified: boolean;
  opened: boolean;
  installHint: string;
  licenseNote: string;
  downloadRoot: string;
  downloadRootOrigin: string;
  notes: string[];
  errors: string[];
}

interface ToolValue {
  message: string;
  report: DownloadReport;
}

function emptyReport(component: string): DownloadReport {
  const info = downloadRootInfo(process.env);
  return {
    ok: false,
    component,
    label: "",
    mode: "manual",
    version: "",
    url: "",
    page: "",
    sha256: "",
    expectedSha256: "",
    filePath: "",
    bytes: 0,
    downloaded: false,
    cached: false,
    verified: false,
    opened: false,
    installHint: "",
    licenseNote: "",
    downloadRoot: info.root,
    downloadRootOrigin: info.origin,
    notes: [],
    errors: [],
  };
}

function reportForPlan(plan: DownloadPlan, env: NodeJS.ProcessEnv): DownloadReport {
  const info = downloadRootInfo(env);
  return {
    ok: true,
    component: plan.component,
    label: plan.label,
    mode: plan.mode,
    version: plan.version,
    url: plan.url,
    page: plan.page,
    sha256: "",
    expectedSha256: plan.expectedSha256,
    filePath: "",
    bytes: 0,
    downloaded: false,
    cached: false,
    verified: false,
    opened: false,
    installHint: plan.installHint,
    licenseNote: plan.licenseNote,
    downloadRoot: info.root,
    downloadRootOrigin: info.origin,
    notes: [],
    errors: [],
  };
}

/**
 * 打开官方页；只在 Windows 上尝试。
 *
 * 不能 spawn 完就报成功：cmd 起得来但 start 失败（没有默认浏览器、URL handler 坏了）时
 * 也要返回 false。这里等 exit code，最多等 3 秒；超时按失败算，让用户手动复制 URL。
 */
function openOfficialPage(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      resolve(false);
      return;
    }
    const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(ok);
    };
    let child;
    try {
      child = spawn(root + "\\System32\\cmd.exe", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      finish(false);
      return;
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      finish(false);
    }, 3000);
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
  });
}

function formatReport(report: DownloadReport, message: string): string[] {
  const lines: string[] = [message];
  lines.push("组件：" + (report.label === "" ? report.component : report.label) + "（" + report.mode + "）");
  if (report.version !== "") lines.push("版本：" + report.version);
  if (report.url !== "") lines.push("直链：" + report.url);
  if (report.page !== "") lines.push("官方页：" + report.page);
  if (report.filePath !== "") lines.push("文件：" + report.filePath + "（" + String(report.bytes) + " B）");
  if (report.sha256 !== "") lines.push("SHA256：" + report.sha256);
  if (report.expectedSha256 !== "") lines.push("官方 SHA256：" + report.expectedSha256);
  lines.push("下载目录：" + report.downloadRoot + "（" + report.downloadRootOrigin + "）");
  if (report.installHint !== "") lines.push("安装：" + report.installHint);
  if (report.licenseNote !== "") lines.push("许可：" + report.licenseNote);
  for (const note of report.notes) lines.push("· " + note);
  for (const error of report.errors) lines.push("错误：" + error);
  return lines;
}

export function registerDownload(ctx: DshContext): void {
  ctx.tools.register({
    name: DOWNLOAD_TOOL,
    description:
      "只下载 STM32 相关安装包，不执行安装器。component=jlink 时从 SEGGER 官方直链下载并校验 SHA256；component=cubemx / cubeprogrammer 默认只返回 ST 官方下载页（需要 myST 登录/许可），也可把已下载的 file 路径传进来只做校验。默认 dryRun:true 只出计划；真正下载/打开官方页要 dryRun:false + confirm:true。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        component: { type: "string", enum: ["jlink", "cubemx", "cubeprogrammer"], description: "要下载/校验的组件。" },
        dryRun: { type: "boolean", description: "默认 true：只返回计划，不下载、不打开页面。" },
        confirm: { type: "boolean", description: "dryRun:false 时必须为 true 才下载或打开官方页。" },
        file: { type: "string", description: "用户已下载的安装包路径；只校验，不复制、不执行。" },
        outDir: { type: "string", description: "覆盖下载目录（默认 %LOCALAPPDATA%\\dsh-stm32\\downloads）。" },
        openPage: { type: "boolean", description: "manual 模式是否打开官方页，默认 true；只有 confirm:true 才执行。" },
        timeoutMs: { type: "number", description: "下载超时，默认 600000 ms。" },
      },
      required: ["component"],
    },
    timeoutMs: 15 * 60_000,
    isConcurrencySafe: () => false,
    output: {
      schema: outputSchema,
      render: (_args, value) => {
        const typed = value as ToolValue;
        return [{ type: "text", text: formatReport(typed.report, typed.message).join("\n") }];
      },
    },
    async execute(rawArgs: DownloadArgs | undefined, exec: ToolExec): Promise<ToolValue> {
      const args = rawArgs ?? {};
      const rawComponent = (args.component ?? "").trim().toLowerCase();
      if (!isDownloadComponent(rawComponent)) {
        const report = emptyReport(rawComponent);
        report.errors.push("component 必须是 jlink / cubemx / cubeprogrammer");
        return { message: "不认识要下载的组件：" + rawComponent, report };
      }
      const component: DownloadComponent = rawComponent;
      const env = process.env;
      const plan = planDownload(component, {
        env,
        ...(args.outDir === undefined ? {} : { outDir: args.outDir }),
      });
      const report = reportForPlan(plan, env);
      const dryRun = args.dryRun !== false;

      // 用户给本地安装包：只校验，属于只读操作，不需要 confirm。
      if (args.file !== undefined && args.file.trim() !== "") {
        try {
          const info = await inspectInstallerFile(args.file, plan.expectedSha256);
          report.mode = "file";
          report.filePath = info.path;
          report.bytes = info.bytes;
          report.sha256 = info.sha256;
          report.expectedSha256 = info.expectedSha256;
          report.verified = info.verified;
          report.downloaded = false;
          report.cached = false;
          report.ok = true;
          report.notes.push(info.expectedSha256 === ""
            ? "已计算 SHA256；这个组件没有官方哈希可对比。"
            : "SHA256 与官方值一致。");
          report.notes.push("没有复制、没有执行安装器；确认来源可信后自己双击安装。");
          // 没有官方哈希时 verified 一定是 false：不能把"算了一遍 SHA256"说成"校验完成"。
          return {
            message: info.verified
              ? "安装包校验完成（SHA256 与官方值一致）：" + info.path
              : "安装包已检查（无官方哈希可对比，verified=false）：" + info.path,
            report,
          };
        } catch (error) {
          const err = error instanceof DownloadError ? error : new DownloadError("file-invalid", error instanceof Error ? error.message : String(error));
          report.ok = false;
          report.errors.push(err.kind + "：" + err.message);
          return { message: "安装包校验失败：" + err.message, report };
        }
      }

      if (dryRun) {
        if (plan.mode === "direct") {
          report.notes.push("计划下载到 " + plan.targetPath + "；确认后传 dryRun:false + confirm:true。");
          report.notes.push("下载后只校验 SHA256，不执行安装器。");
          return { message: "下载计划：" + plan.label + " " + plan.version, report };
        }
        report.notes.push("ST 官网需要登录/接受许可；插件不直接下载。");
        report.notes.push("打开官方页或把已下载文件传给 file；确认后传 dryRun:false + confirm:true。");
        return { message: "需要手动下载：" + plan.label, report };
      }

      if (args.confirm !== true) {
        report.ok = false;
        report.errors.push("需要 confirm:true：真正下载或打开官方页前必须显式确认");
        return { message: "未执行：需要 confirm:true", report };
      }

      if (plan.mode === "manual") {
        const shouldOpen = args.openPage !== false;
        report.opened = shouldOpen ? await openOfficialPage(plan.page) : false;
        report.notes.push(shouldOpen && report.opened
          ? "已打开官方下载页；登录 myST、接受许可后下载。"
          : "没有自动下载；请在浏览器打开官方页，或把已下载文件传给 file。");
        if (shouldOpen && !report.opened) report.notes.push("自动打开失败（非 Windows 或系统拒绝），请手动复制官方页 URL。");
        report.downloaded = false;
        report.ok = true;
        return { message: "未下载：请在官方页手动下载 " + plan.label, report };
      }

      try {
        const result = await downloadUrlToFile(plan.url, plan.targetPath, plan.expectedSha256, {
          signal: exec.signal,
          ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
        });
        report.filePath = result.path;
        report.bytes = result.bytes;
        report.sha256 = result.sha256;
        report.downloaded = !result.cached;
        report.cached = result.cached;
        report.verified = plan.expectedSha256 !== "" && result.sha256 === plan.expectedSha256;
        report.ok = true;
        report.notes.push(result.cached ? "目标文件已存在且 SHA256 正确，直接复用。" : "下载完成，SHA256 已校验。");
        report.notes.push("没有执行安装器；请自己双击安装。");
        return { message: (result.cached ? "已复用安装包：" : "已下载安装包：") + result.path, report };
      } catch (error) {
        const err = error instanceof DownloadError ? error : new DownloadError("download-failed", error instanceof Error ? error.message : String(error), true);
        report.ok = false;
        report.errors.push(err.kind + "：" + err.message);
        if (err.retryable) report.notes.push("可重试；若反复失败，检查网络/代理或稍后再试。");
        return { message: "下载失败：" + err.message, report };
      }
    },
  });
}
