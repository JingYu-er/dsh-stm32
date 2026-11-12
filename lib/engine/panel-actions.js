/**
 * 面板直接触发的构建与烧录。
 *
 * 人在面板上点「构建 / 烧录」时不经过模型：这里直接调引擎的 `runBuild` / `runFlash`，
 * 并把结果作为 `stm32_build` / `stm32_flash` 事件写进同一条总线（source 标 user）。
 * 这样时间线、故障页、产物页看到的仍是同一种事件，不需要为「人点的」再开一套数据。
 */
import { emitEvent } from "./event-bus.js";
import { runBuild } from "./build.js";
import { runFlash } from "./flash.js";
/** 构建摘要：与工具埋点的 resultDigest 同形状，面板不必区分来源。 */
export function buildDigest(report) {
    const digest = {
        ok: report.ok,
        projectDir: report.projectDir,
        buildDir: report.buildDir,
        durationMs: report.durationMs,
        warningCount: report.warningCount,
    };
    if (report.exitCode !== undefined)
        digest["exitCode"] = report.exitCode;
    if (report.memoryUsage.length > 0)
        digest["memoryUsage"] = report.memoryUsage;
    if (report.elf !== undefined)
        digest["elf"] = report.elf.path;
    if (report.errors.length > 0)
        digest["errors"] = report.errors.slice(0, 20);
    return digest;
}
export function flashDigest(report) {
    const digest = {
        ok: report.ok,
        projectDir: report.projectDir,
        elfPath: report.elfPath,
        elfSize: report.elfSize,
        durationMs: report.durationMs,
        programmed: report.programmed,
        verified: report.verified,
    };
    if (report.exitCode !== undefined)
        digest["exitCode"] = report.exitCode;
    if (report.probeError !== null)
        digest["probeError"] = report.probeError;
    if (report.errors.length > 0)
        digest["errors"] = report.errors.slice(0, 20);
    return digest;
}
export async function buildFromPanel(deps, request) {
    emitEvent({
        source: "user",
        kind: "stm32_build",
        status: "start",
        summary: "面板：构建 " + request.projectDir,
        payload: { projectDir: request.projectDir, clean: request.clean === true },
    });
    const report = await runBuild(deps.subprocess, {
        projectDir: request.projectDir,
        ...(request.clean === true ? { clean: true } : {}),
        ...(request.target === undefined ? {} : { target: request.target }),
        ...(request.artifacts === undefined ? {} : { artifacts: request.artifacts }),
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });
    emitEvent({
        source: "user",
        kind: "stm32_build",
        status: report.ok ? "ok" : "fail",
        summary: report.message,
        payload: { result: buildDigest(report) },
    });
    return report;
}
export async function flashFromPanel(deps, request) {
    emitEvent({
        source: "user",
        kind: "stm32_flash",
        status: "start",
        summary: "面板：烧录 " + request.projectDir,
        payload: { projectDir: request.projectDir },
    });
    const flashRequest = { projectDir: request.projectDir };
    if (request.elfPath !== undefined)
        flashRequest.elfPath = request.elfPath;
    if (request.buildDir !== undefined)
        flashRequest.buildDir = request.buildDir;
    if (request.adapterSpeed !== undefined)
        flashRequest.adapterSpeed = request.adapterSpeed;
    if (request.allowNoDebug === true)
        flashRequest.allowNoDebug = true;
    const report = await runFlash(deps.subprocess, flashRequest);
    emitEvent({
        source: "user",
        kind: "stm32_flash",
        status: report.ok ? "ok" : "fail",
        summary: report.message,
        payload: { result: flashDigest(report) },
    });
    return report;
}
