/**
 * .ioc 与生成代码是否同步。
 *
 * 场景：用户在 CubeMX 里改了配置、存了 .ioc，却忘了 stm32_generate；此后编译、烧录跑的都是旧代码，
 * 现象是「配置明明改了怎么不生效」。这里只比文件时间，不读内容：.ioc 比生成物新就是「待生成」。
 *
 * 判定用 Core/Src/main.c 的修改时间当「最近一次生成」——generate 一定会重写它；
 * 工程里没有这个文件时视为没生成过（或不是本插件的工程布局），给出提示而不下结论。
 */

import { statSync } from "node:fs";
import { join } from "node:path";

import { findIocPath } from "./pinout.js";

export interface IocSyncReport {
  /** 找到的 .ioc；空串表示工程里没有。 */
  iocPath: string;
  iocMtimeMs: number;
  /** 生成物的代表文件：Core/Src/main.c。 */
  codePath: string;
  codeMtimeMs: number;
  /** true = .ioc 比生成物新，需要重新 generate。 */
  stale: boolean;
  /** 给面板直接显示的一句话。 */
  message: string;
}

export type IocSyncResult = { ok: true; report: IocSyncReport } | { ok: false; error: string };

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export function readIocSync(projectDir: string): IocSyncResult {
  const dir = projectDir.trim();
  if (dir === "") return { ok: false, error: "projectDir 不能为空" };
  const iocPath = findIocPath(dir);
  if (iocPath === "") return { ok: false, error: "工程目录里没有 .ioc：" + dir };
  const codePath = join(dir, "Core", "Src", "main.c");
  const iocMtimeMs = mtimeOf(iocPath);
  const codeMtimeMs = mtimeOf(codePath);
  if (codeMtimeMs === 0) {
    return {
      ok: true,
      report: {
        iocPath,
        iocMtimeMs,
        codePath,
        codeMtimeMs: 0,
        stale: false,
        message: "还没有生成过代码（找不到 Core/Src/main.c）：先跑一次 stm32_generate。",
      },
    };
  }
  const stale = iocMtimeMs > codeMtimeMs + 1000;
  return {
    ok: true,
    report: {
      iocPath,
      iocMtimeMs,
      codePath,
      codeMtimeMs,
      stale,
      message: stale
        ? ".ioc 比生成的代码新：配置改了但还没重新生成，编译烧录仍是旧代码。"
        : ".ioc 与生成的代码一致。",
    },
  };
}
