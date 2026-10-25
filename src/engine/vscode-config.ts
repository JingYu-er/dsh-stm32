/**
 * L2：把模板里的 .vscode 配置填成"这台机器能用的"。
 *
 * 背景（审计 B1/B6）：模板快照是从开发者机器上拷的，里面有
 *   svdPath: D:/JingYu/...、armToolchainPath/gdbPath: D:/app/msys64/ucrt64/bin、
 *   settings.json 里的 cube-cmake / ${env:CUBE_BUNDLE_PATH} / 钉死版本的 clangd query-driver。
 * 换台机器（或换个用户）这些路径全是死的：按 F5 调试直接报找不到 gdb，CMake 面板认不出编译器，
 * 还顺带把开发机的用户名泄露到每个新工程里。
 *
 * 所以模板里只留占位符，写盘时按本机实际情况填：
 *   - 找得到 gdb / cmake → 填绝对路径（cortex-debug 与 CMake Tools 都吃绝对路径）；
 *   - 找不到 → **整行删掉**（让扩展回退到 PATH），并把缺什么回报给调用方写进 warnings。
 * 不写空字符串：cortex-debug 拿到 "" 会当成"用这个路径"，比不写更糟。
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { toolSearchDirs } from "./tool-env.js";

/** 模板占位符（改了模板记得同步这里）。 */
export const VSCODE_PLACEHOLDERS = {
  gdb: "__GDB_PATH__",
  toolchain: "__ARM_TOOLCHAIN_PATH__",
  cmake: "__CMAKE_PATH__",
  svd: "__SVD_PATH__",
} as const;

export interface VscodeFill {
  /** gdb 可执行文件的绝对路径；空串 = 本机没找到。 */
  gdbPath: string;
  /** 工具链目录（gdb 所在目录，cortex-debug 用它找 objdump 等）。 */
  armToolchainPath: string;
  /** cmake 可执行文件的绝对路径；空串 = 交给 PATH。 */
  cmakePath: string;
}

function findExecutable(names: readonly string[], dirs: readonly string[]): string | null {
  for (const dir of dirs) {
    for (const name of names) {
      const abs = path.join(dir, name);
      if (existsSync(abs)) return abs;
    }
  }
  return null;
}

/**
 * 探测本机的调试/构建工具路径。
 *
 * 顺序：显式 binDirs（配置里的 msys64 等）优先，PATH 兜底——与门禁同一套优先级，
 * 免得出现"门禁说齐全、launch.json 却是空的"。
 */
export function detectVscodeFill(binDirs: readonly string[], base: NodeJS.ProcessEnv = process.env): VscodeFill {
  const dirs = toolSearchDirs(binDirs, base);
  const gdb = findExecutable(
    ["gdb-multiarch.exe", "gdb-multiarch", "arm-none-eabi-gdb.exe", "arm-none-eabi-gdb"],
    dirs,
  );
  const cmake = findExecutable(["cmake.exe", "cmake"], dirs);
  return {
    gdbPath: gdb ?? "",
    armToolchainPath: gdb === null ? "" : path.dirname(gdb),
    cmakePath: cmake ?? "",
  };
}

/**
 * 把占位符换成实际值；值为空的那一行整行删掉。
 *
 * 返回被删掉的占位符，调用方据此写 warnings（"没找到 gdb，新工程的 .vscode 里没写 gdbPath"）。
 * 模板是 JSONC（带注释、可带尾逗号），所以按行处理不会破坏语法：一行只放一个属性时删行即合法。
 */
export function fillVscodeTemplate(
  text: string,
  fill: VscodeFill,
): { text: string; dropped: string[] } {
  const values: Record<string, string> = {
    [VSCODE_PLACEHOLDERS.gdb]: fill.gdbPath,
    [VSCODE_PLACEHOLDERS.toolchain]: fill.armToolchainPath,
    [VSCODE_PLACEHOLDERS.cmake]: fill.cmakePath,
  };
  const dropped: string[] = [];
  let filled = text;
  for (const [token, rawValue] of Object.entries(values)) {
    if (rawValue !== "") {
      // 这些值都嵌在 JSON 字符串里：Windows 路径是单反斜杠，直接插会得到 `"D:\app\..."`
      // 这种非法转义（VS Code 打不开 launch.json）。统一转正斜杠：cortex-debug / CMake Tools 都吃。
      const value = rawValue.replace(/\\/gu, "/");
      filled = filled.split(token).join(value);
      continue;
    }
    if (!filled.includes(token)) continue;
    dropped.push(token);
    filled = filled
      .split(/\r?\n/u)
      .filter((line) => !line.includes(token))
      .join("\n");
  }
  return { text: filled, dropped };
}

/** 被删掉的占位符 → 一句人话（写进 scaffold 的 warnings）。 */
export function describeDroppedPlaceholder(token: string): string {
  if (token === VSCODE_PLACEHOLDERS.gdb) {
    return "本机没找到 gdb（gdb-multiarch / arm-none-eabi-gdb），新工程 .vscode/launch.json 里没写 gdbPath：" +
      "在 VS Code 里按 F5 调试前要自己补，或把 msys64 的 bin 加进 PATH 后重建工程。";
  }
  if (token === VSCODE_PLACEHOLDERS.toolchain) {
    return "本机没找到 gdb 目录，新工程 .vscode/launch.json 里没写 armToolchainPath：cortex-debug 会去 PATH 里找 arm-none-eabi-objdump。";
  }
  if (token === VSCODE_PLACEHOLDERS.cmake) {
    return "本机没找到 cmake，新工程 .vscode/settings.json 里没写 cmake.cmakePath：CMake Tools 会回退到 PATH 里的 cmake。";
  }
  if (token === VSCODE_PLACEHOLDERS.svd) {
    return "新工程 .vscode/launch.json 里没写 svdPath（插件不代替你选 SVD 文件）：想在外设寄存器视图里看值，自己加一行 svdPath 指向对应芯片的 .svd。";
  }
  return "模板占位符 " + token + " 没有值，那一行已删掉。";
}
