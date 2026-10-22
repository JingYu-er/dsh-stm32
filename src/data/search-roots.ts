/**
 * 工具链搜索配置。
 *
 * 设计约定：路径是数据，不是逻辑。默认值覆盖本机最常见的安装位置，可用环境
 * 变量或工具参数覆盖；任何模块都不得在其他地方硬编码工具链路径。
 */

export interface SearchConfig {
  /** 优先在这些目录里找裸命令名（gcc/openocd/...）。 */
  binDirs: string[];
  /** STM32CubeMX 安装根目录候选。 */
  cubeMxRoots: string[];
}

/** 默认二进制目录：用户已确认的偏好是 msys64 优先。 */
export const DEFAULT_BIN_DIRS: readonly string[] = [
  "D:/app/msys64/ucrt64/bin",
  "C:/msys64/ucrt64/bin",
  "C:/msys64/mingw64/bin",
];

/** 默认 CubeMX 安装根目录候选（6.x）。 */
export const DEFAULT_CUBEMX_ROOTS: readonly string[] = [
  "D:/app/STM32CubeMX",
  "C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeMX",
];

function splitList(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  return value
    .split(";")
    .map((entry) => entry.trim().replace(/\\/g, "/"))
    .filter((entry) => entry !== "");
}

/** 环境变量或显式参数覆盖默认搜索配置。 */
export function resolveSearchConfig(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<SearchConfig> = {},
): SearchConfig {
  const binFromEnv = splitList(env["STM32_BIN_DIRS"]);
  const rootsFromEnv = splitList(env["STM32_CUBEMX_ROOT"]);
  const binDirs = overrides.binDirs ?? (binFromEnv.length > 0 ? binFromEnv : [...DEFAULT_BIN_DIRS]);
  const cubeMxRoots =
    overrides.cubeMxRoots ?? (rootsFromEnv.length > 0 ? rootsFromEnv : [...DEFAULT_CUBEMX_ROOTS]);
  return { binDirs, cubeMxRoots };
}
