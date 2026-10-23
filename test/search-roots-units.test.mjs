// L0 纯逻辑单测：工具链路径候选的净化、去重、自动发现与覆盖优先级。
// 运行：node --test test/search-roots-units.test.mjs（需先 npm run build）
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_BIN_DIRS,
  DEFAULT_CUBEMX_ROOTS,
  dedupePaths,
  discoverBinDirs,
  discoverCubeMxRoots,
  discoverInstalls,
  discoveryDisabled,
  looksLikeBinDir,
  looksLikeCubeMxRoot,
  normalizePathEntry,
  resetDiscoveryCache,
  resolveSearchConfig,
  splitList,
} from "../lib/data/search-roots.js";

const key = (path) => path.replace(/\\/gu, "/").toLowerCase();

/** 假文件系统：files 是"存在的文件"，dirs 是"目录 → 直接子目录"，其余由参数给出。 */
function fakeProbe({ files = [], dirs = {}, registry = [], drives = [], user = [] } = {}) {
  const fileSet = new Set(files.map(key));
  const dirMap = new Map(Object.entries(dirs).map(([dir, children]) => [key(dir), children]));
  return {
    exists: (path) => fileSet.has(key(path)),
    listDirs: (dir) => dirMap.get(key(dir)) ?? [],
    registryInstallDirs: () => registry,
    driveRoots: () => drives,
    userProgramDirs: () => user,
  };
}

/** 一个完整 CubeMX 安装根需要的两个文件。 */
const cubeMxFiles = (root) => [root + "/STM32CubeMX.exe", root + "/jre/bin/java.exe"];

test("路径条目净化：去引号、反斜杠转正斜杠、折叠重复斜杠、去尾斜杠（盘根保留）", () => {
  assert.equal(normalizePathEntry('"E:\\msys64\\ucrt64\\bin"'), "E:/msys64/ucrt64/bin");
  assert.equal(normalizePathEntry("E:\\\\msys64\\\\bin"), "E:/msys64/bin", "双反斜杠（从 JSON 里抄来的）也要能认");
  assert.equal(normalizePathEntry("D:/a//b/"), "D:/a/b");
  assert.equal(normalizePathEntry("D:\\"), "D:/", "盘根不能被削成 D:");
  assert.equal(normalizePathEntry("   "), "");
});

test("splitList：分号分隔、剥引号、跳过空项", () => {
  assert.deepEqual(splitList("D:/a; E:\\b ;\"F:\\c d\""), ["D:/a", "E:/b", "F:/c d"]);
  assert.deepEqual(splitList("  ;  "), []);
  assert.deepEqual(splitList(undefined), []);
});

test("dedupePaths：大小写与尾斜杠视为同一路径，保持首次出现顺序", () => {
  assert.deepEqual(dedupePaths(["D:/a", "d:/a/", "D:/b", "", "D:/A"]), ["D:/a", "D:/b"]);
});

test("looksLike*：只认完整安装（CubeMX 必须 exe + jre 都在）", () => {
  const cube = "E:/cube";
  assert.equal(looksLikeCubeMxRoot(cube, (path) => cubeMxFiles(cube).includes(path)), true);
  assert.equal(looksLikeCubeMxRoot(cube, (path) => path.endsWith("STM32CubeMX.exe")), false, "缺 jre 不算完整安装");
  assert.equal(looksLikeBinDir("E:/msys64/ucrt64/bin", (path) => path === "E:/msys64/ucrt64/bin/openocd.exe"), true);
  assert.equal(looksLikeBinDir("E:/empty", () => false), false);
});

test("自动发现 CubeMX：注册表与盘符常见位置都算，缺 jre 的目录不算", () => {
  const probe = fakeProbe({
    drives: ["E:"],
    registry: ["E:/registry/STM32CubeMX"],
    files: [...cubeMxFiles("E:/registry/STM32CubeMX"), ...cubeMxFiles("E:/tools/STM32CubeMX"), "E:/tools/half/STM32CubeMX.exe"],
    dirs: { "E:/": ["E:/tools"], "E:/tools": ["E:/tools/STM32CubeMX", "E:/tools/half"] },
  });
  const roots = discoverCubeMxRoots(probe);
  assert.ok(roots.includes("E:/registry/STM32CubeMX"), "注册表登记的安装根要找到");
  assert.ok(roots.includes("E:/tools/STM32CubeMX"), "盘符下的常见位置要找到");
  assert.ok(!roots.includes("E:/tools/half"), "只有 exe、没有 jre/bin/java.exe 的不算");
});

test("自动发现工具链：<盘>/msys64 下三个变体里挑有 exe 的 bin", () => {
  const probe = fakeProbe({
    drives: ["E:"],
    files: ["E:/msys64/ucrt64/bin/openocd.exe", "E:/msys64/mingw64/bin/cmake.exe", "E:/msys64/clang64/bin/readme.txt"],
  });
  assert.deepEqual(discoverBinDirs(probe), ["E:/msys64/ucrt64/bin", "E:/msys64/mingw64/bin"]);
});

test("resolveSearchConfig：默认 < 环境变量 < 参数，自动发现只追加不覆盖（点名参数时不追加）", () => {
  const discovered = { binDirs: ["F:/found/ucrt64/bin"], cubeMxRoots: ["G:/STM32CubeMX"] };

  const plain = resolveSearchConfig({}, {}, discovered);
  assert.deepEqual(plain.binDirs, [...DEFAULT_BIN_DIRS, "F:/found/ucrt64/bin"]);
  assert.deepEqual(plain.cubeMxRoots, [...DEFAULT_CUBEMX_ROOTS, "G:/STM32CubeMX"]);

  const fromEnv = resolveSearchConfig({ STM32_BIN_DIRS: "E:\\tools\\bin", STM32_CUBEMX_ROOT: "E:/cube" }, {}, discovered);
  assert.deepEqual(fromEnv.binDirs, ["E:/tools/bin", "F:/found/ucrt64/bin"], "环境变量整体替换默认值，发现项仍追加");
  assert.deepEqual(fromEnv.cubeMxRoots, ["E:/cube", "G:/STM32CubeMX"]);

  const explicit = resolveSearchConfig({ STM32_BIN_DIRS: "E:/env/bin" }, { binDirs: ["H:/arg/bin"] }, discovered);
  assert.deepEqual(explicit.binDirs, ["H:/arg/bin"], "显式参数整份替换，且不再混入自动发现（我点名的地方就是我要的）");
  assert.deepEqual(explicit.cubeMxRoots, [...DEFAULT_CUBEMX_ROOTS, "G:/STM32CubeMX"], "另一个 list 没点名，仍吃自动发现");
});

test("STM32_NO_DISCOVER=1 关掉自动发现（CI / 单测用）", () => {
  const discovered = { binDirs: ["F:/found/ucrt64/bin"], cubeMxRoots: ["G:/STM32CubeMX"] };
  assert.equal(discoveryDisabled({ STM32_NO_DISCOVER: "1" }), true);
  assert.equal(discoveryDisabled({ STM32_NO_DISCOVER: "true" }), true);
  assert.equal(discoveryDisabled({}), false);
  assert.deepEqual(resolveSearchConfig({ STM32_NO_DISCOVER: "1" }, {}, discovered).binDirs, [...DEFAULT_BIN_DIRS]);
  assert.deepEqual(resolveSearchConfig({ STM32_NO_DISCOVER: "1" }, {}, discovered).cubeMxRoots, [...DEFAULT_CUBEMX_ROOTS]);
});

test("discoverInstalls：进程内只扫一次盘（缓存），resetDiscoveryCache 后可重扫", () => {
  resetDiscoveryCache();
  const first = discoverInstalls();
  assert.equal(discoverInstalls(), first, "第二次必须命中缓存");
  resetDiscoveryCache();
  assert.notEqual(discoverInstalls(), first, "reset 之后要重新扫描");
});
