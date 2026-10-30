// 测试路径都从这里来：离线单测只用仓库自带的 test/fixtures/，不依赖开发机上的任何工程。
// 需要真工程 / 真板子 / 真 CubeMX 的 e2e 用环境变量或命令行参数指路（见 test/fixtures/README.md）。
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
export const FIXTURE_PROJECT = join(FIXTURES, "project");
export const FIXTURE_IOC = join(FIXTURE_PROJECT, "demo.ioc");
export const FIXTURE_SCRATCH_IOC = join(FIXTURES, "scratch.ioc");

/**
 * 夹具资源包根（DSH_STM32_ASSETS 用的那个根）：里面只有一个版本目录 2026.10.31-1，
 * 带 manifest.json / install.json / device/f1/chips.json（20 颗真实 CPN）。
 * 插件已经不再内置芯片表，设备事实全从这个缓存读，所以**所有**需要型号事实的单测都要
 * 在最前面写 process.env.DSH_STM32_ASSETS = FIXTURE_ASSETS —— 否则会去读开发机真实 home 缓存，
 * 测试就不再是离线的了。
 */
export const FIXTURE_ASSETS = join(FIXTURES, "assets");
/** 夹具资源包的版本目录名（也是 install.json 里的 version）。 */
export const FIXTURE_ASSETS_VERSION = "2026.10.31-1";

/** e2e 放临时副本的根目录（默认系统临时目录）。 */
export const E2E_ROOT = process.env.DSH_STM32_E2E_ROOT ?? tmpdir();

/** 在 E2E_ROOT 下划一个 <名字> 的临时工作目录。 */
export function e2eWorkDir(name) {
  return join(E2E_ROOT, "dsh-stm32-e2e-" + name);
}

/**
 * e2e 要的真实工程目录：环境变量 DSH_STM32_E2E_PROJECT 优先（argv 为 false 时忽略命令行参数），
 * 否则取命令行第 2 个参数。拿不到就报错——绝不悄悄用夹具（夹具里的 .elf 是占位文件，烧了会浪费一次刷写）。
 */
export function e2eProject(options = {}) {
  const { argv = true } = options;
  const fromEnv = process.env.DSH_STM32_E2E_PROJECT;
  const fromArgv = argv ? process.argv[2] : undefined;
  const dir = fromEnv ?? fromArgv;
  const hint =
    "这是需要真工程 / 真板子 / 真 CubeMX 的 e2e，必须指路：\n" +
    "  PowerShell: $env:DSH_STM32_E2E_PROJECT='D:\\path\\to\\your-project'; node test\\e2e-flash.mjs\n" +
    "  或直接给参数: node test\\e2e-flash.mjs D:\\path\\to\\your-project\n" +
    "工程里要有 openocd.cfg、build\\Debug\\<名字>.elf（先跑一次 stm32_build 或 cmake --preset Debug）。";
  if (dir === undefined || dir === null || dir.trim() === "") throw new Error(hint);
  if (resolve(dir) === resolve(FIXTURE_PROJECT)) throw new Error(hint + "\n（test/fixtures/project 只有占位 elf，不能拿来跑 e2e）");
  return dir;
}

/** 工具链目录：环境变量优先，否则沿用插件默认值（msys64 优先）。 */
export function binDirs() {
  const fromEnv = (process.env.STM32_BIN_DIRS ?? "")
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return fromEnv.length > 0 ? fromEnv : ["D:/app/msys64/ucrt64/bin", "C:/msys64/ucrt64/bin"];
}

/**
 * 假的工具链目录：只有空文件占位的 openocd / gdb / gcc。
 * 给"只验会话与参数构造、不真起进程"的单测用（session-units 的 subprocess 是假的），
 * 这样在没装 msys64 / CubeMX 的机器（例如 GitHub runner）上也能跑。
 */
export function fakeBinDirs(tag = "bin") {
  const dir = mkdtempSync(join(tmpdir(), "dsh-stm32-" + tag + "-"));
  for (const name of ["openocd", "openocd.exe", "gdb-multiarch", "gdb-multiarch.exe", "arm-none-eabi-gcc", "arm-none-eabi-gcc.exe"]) {
    writeFileSync(join(dir, name), "");
  }
  return [dir];
}
