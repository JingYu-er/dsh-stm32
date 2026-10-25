// 为什么要有这个套件：新增的两块"自己读配置 + 开工前查工具链"逻辑，是插件里唯一
// 会碰用户磁盘（配置 JSON）和进程 PATH（探测）的地方。它坏了的表现是"什么都能跑但
// 结果是错的"，所以这里逐条钉住：配置读写往返、四层优先级、门禁放行/拦截/告警的文案，
// 以及"快路径一次 spawn 都不做"这个性能约束。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TOOLCHAIN_CONFIG_VERSION,
  binDirsFromConfig,
  configReadingDisabled,
  defaultToolchainConfig,
  normalizeToolchainConfig,
  readToolchainConfig,
  resetToolchainConfigCache,
  toolchainConfigPath,
  updateToolchainConfig,
  writeToolchainConfig,
} from "../lib/data/toolchain-config.js";
import { DEFAULT_BIN_DIRS, resolveSearchConfig } from "../lib/data/search-roots.js";
import { buildTargets, resolveToolIn } from "../lib/engine/probe.js";
import { resolveTargetDir } from "../lib/engine/msys2-install.js";
import {
  CAPABILITY_COMPONENTS,
  ensureToolchain,
  gateReportNotes,
  normalizeEnvCheck,
  resetGateCache,
} from "../lib/engine/toolchain-gate.js";

// run-units.mjs 统一给子进程设了 DSH_STM32_NO_CONFIG=1（免得开发机上真实存在的
// ~/.dsh-stm32/config.json 影响别的套件）；这个套件本身就是测配置层的，所以先清掉它，
// 需要"关掉配置"的那条断言再自己显式设置。
delete process.env.DSH_STM32_NO_CONFIG;

/** 每个用例一个临时目录，跑完删掉；配置路径一律指到它里面。 */
function tempDir(tag) {
  return mkdtempSync(join(tmpdir(), "dsh-stm32-" + tag + "-"));
}

/** 环境变量只在本用例内生效，退出时（含断言失败）原样还原。 */
async function withEnv(patch, body) {
  const before = new Map();
  for (const key of Object.keys(patch)) before.set(key, process.env[key]);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetToolchainConfigCache();
  resetGateCache();
  try {
    return await body();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetToolchainConfigCache();
    resetGateCache();
  }
}

// ── 配置层 ────────────────────────────────────────────────────────────────

test("配置写入→读回：路径归正、去重、updatedAt 有值、不留 .tmp 残渣", async () => {
  const dir = tempDir("cfg-roundtrip");
  const path = join(dir, "nested", "config.json");
  try {
    await withEnv({ DSH_STM32_CONFIG: path }, () => {
      const written = writeToolchainConfig(
        {
          version: TOOLCHAIN_CONFIG_VERSION,
          msys64: "E:\\msys64\\",
          binDirs: ["E:\\msys64\\ucrt64\\bin\\", "e:/MSYS64/ucrt64/bin"],
          packages: ["mingw-w64-ucrt-x86_64-cmake", "mingw-w64-ucrt-x86_64-cmake", "mingw-w64-ucrt-x86_64-ninja"],
          cubeMxRoot: "",
          updatedAt: "",
        },
        process.env,
      );
      assert.equal(written.ok, true, "写配置应成功：" + written.error);
      assert.equal(written.path, path);

      const read = readToolchainConfig(process.env);
      assert.equal(read.exists, true);
      assert.equal(read.errors.length, 0);
      assert.equal(read.config.msys64, "E:/msys64");
      assert.deepEqual(read.config.binDirs, ["E:/msys64/ucrt64/bin"], "反斜杠与大小写重复应被归并");
      assert.deepEqual(read.config.packages, ["mingw-w64-ucrt-x86_64-cmake", "mingw-w64-ucrt-x86_64-ninja"]);
      assert.ok(read.config.updatedAt.length > 0, "updatedAt 应由写入方补上");

      const leftovers = readdirSync(join(dir, "nested")).filter((name) => name.includes(".tmp-"));
      assert.deepEqual(leftovers, [], "原子写入不该留下 tmp 文件");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("坏 JSON 不抛异常：config=null，errors 说清是 JSON 的问题", async () => {
  const dir = tempDir("cfg-badjson");
  const path = join(dir, "config.json");
  try {
    writeFileSync(path, "{ this is not json", "utf8");
    await withEnv({ DSH_STM32_CONFIG: path }, () => {
      const read = readToolchainConfig(process.env);
      assert.equal(read.exists, true);
      assert.equal(read.config, null);
      assert.equal(read.errors.length, 1);
      assert.match(read.errors[0], /不是合法 JSON/u);
      assert.equal(configReadingDisabled(process.env), false);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizeToolchainConfig：类型不对的字段按空处理，version 缺失记一条 errors", () => {
  const errors = [];
  const config = normalizeToolchainConfig(
    { version: "one", binDirs: "not-an-array", packages: [1, " mingw-w64-ucrt-x86_64-openocd ", ""], cubeMxRoot: 42, extra: true },
    errors,
  );
  assert.equal(config.version, TOOLCHAIN_CONFIG_VERSION);
  assert.deepEqual(config.binDirs, []);
  assert.deepEqual(config.packages, ["mingw-w64-ucrt-x86_64-openocd"], "非字符串项与空串要丢掉，首尾空白要去掉");
  assert.equal(config.cubeMxRoot, "");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /version/u);

  const notObject = [];
  assert.deepEqual(normalizeToolchainConfig("nope", notObject), defaultToolchainConfig());
  assert.match(notObject[0], /不是对象/u);
});

test("binDirsFromConfig：没写 binDirs 时按 MSYS2 布局由 msys64 推导", () => {
  assert.deepEqual(binDirsFromConfig(null), []);
  assert.deepEqual(binDirsFromConfig(defaultToolchainConfig()), []);
  assert.deepEqual(binDirsFromConfig({ ...defaultToolchainConfig(), msys64: "D:/app/msys64" }), ["D:/app/msys64/ucrt64/bin"]);
  assert.deepEqual(
    binDirsFromConfig({ ...defaultToolchainConfig(), msys64: "D:/app/msys64", binDirs: ["E:/custom/bin"] }),
    ["E:/custom/bin"],
    "显式 binDirs 优先于推导",
  );
});

test("toolchainConfigPath：DSH_STM32_CONFIG（绝对/相对）> 主目录默认位置", () => {
  assert.equal(toolchainConfigPath({ DSH_STM32_CONFIG: "D:/x/config.json" }), "D:/x/config.json");
  assert.equal(toolchainConfigPath({ DSH_STM32_CONFIG: "sub/config.json", USERPROFILE: "D:/home/u" }), "D:/home/u/sub/config.json");
  assert.equal(toolchainConfigPath({ USERPROFILE: "D:/home/u" }), "D:/home/u/.dsh-stm32/config.json");
});

test("updateToolchainConfig：只改给定字段，其余从原文件保留", async () => {
  const dir = tempDir("cfg-update");
  const path = join(dir, "config.json");
  try {
    await withEnv({ DSH_STM32_CONFIG: path }, () => {
      writeToolchainConfig({ ...defaultToolchainConfig(), msys64: "D:/app/msys64", packages: ["a"] }, process.env);
      const updated = updateToolchainConfig({ cubeMxRoot: "D:/app/STM32CubeMX" }, process.env);
      assert.equal(updated.ok, true, updated.error);
      assert.equal(updated.config.msys64, "D:/app/msys64", "没给的字段应保留原值");
      assert.deepEqual(updated.config.packages, ["a"]);
      const read = readToolchainConfig(process.env);
      assert.equal(read.config.cubeMxRoot, "D:/app/STM32CubeMX");
      assert.equal(read.config.msys64, "D:/app/msys64");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DSH_STM32_NO_CONFIG=1：所有读配置的地方都当它不存在", async () => {
  const dir = tempDir("cfg-disabled");
  const path = join(dir, "config.json");
  try {
    await withEnv({ DSH_STM32_CONFIG: path }, () => {
      writeToolchainConfig({ ...defaultToolchainConfig(), msys64: "D:/app/msys64" }, process.env);
    });
    await withEnv({ DSH_STM32_CONFIG: path, DSH_STM32_NO_CONFIG: "1" }, () => {
      const read = readToolchainConfig(process.env);
      assert.equal(read.exists, false);
      assert.equal(read.config, null);
      assert.equal(configReadingDisabled(process.env), true);
      const config = resolveSearchConfig(process.env, {}, { binDirs: [], cubeMxRoots: [] });
      assert.deepEqual(config.binDirs, [...DEFAULT_BIN_DIRS], "关掉配置后应回到默认候选");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSearchConfig 四层优先级：显式参数 > 环境变量 > 用户配置 > 默认值", async () => {
  const dir = tempDir("cfg-precedence");
  const path = join(dir, "config.json");
  const discovered = { binDirs: [], cubeMxRoots: [] };
  try {
    writeToolchainConfig(
      { ...defaultToolchainConfig(), msys64: "", binDirs: ["E:/cfg/bin"], cubeMxRoot: "E:/cfg/cubemx" },
      { DSH_STM32_CONFIG: path },
    );
    const base = { DSH_STM32_CONFIG: path, STM32_BIN_DIRS: undefined, STM32_CUBEMX_ROOT: undefined };

    const fromConfig = resolveSearchConfig(base, {}, discovered);
    assert.deepEqual(fromConfig.binDirs, ["E:/cfg/bin"], "只有配置文件时用配置");
    assert.deepEqual(fromConfig.cubeMxRoots, ["E:/cfg/cubemx"]);

    const fromEnv = resolveSearchConfig({ ...base, STM32_BIN_DIRS: "E:/env/bin" }, {}, discovered);
    assert.deepEqual(fromEnv.binDirs, ["E:/env/bin"], "环境变量整份替换配置文件");

    const fromExplicit = resolveSearchConfig({ ...base, STM32_BIN_DIRS: "E:/env/bin" }, { binDirs: ["E:/explicit/bin"] }, discovered);
    assert.deepEqual(fromExplicit.binDirs, ["E:/explicit/bin"], "显式参数压过一切");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 门禁层 ────────────────────────────────────────────────────────────────

/** 假 subprocess：解析/spawn 都直接抛错——这样"没走快路径"会被断言抓到。 */
function forbiddingSubprocess() {
  const calls = { resolve: 0, spawn: 0 };
  return {
    calls,
    subprocess: {
      resolveExecutable: () => {
        calls.resolve += 1;
        throw new Error("快路径不该解析可执行文件");
      },
      spawn: () => {
        calls.spawn += 1;
        throw new Error("快路径不该 spawn");
      },
    },
  };
}

/** 门禁只从 ctx 里取 subprocess，其余服务它自己会兜底。 */
function gateCtx(subprocess) {
  return {
    tools: { register: () => () => undefined },
    get(name) {
      return name === "subprocess" ? subprocess : undefined;
    },
  };
}

/** 造一个"看起来装着工具链"的 bin 目录（空文件即可，快路径只做存在性检查）。 */
function fakeBin(tag, names) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-stm32-gate-" + tag + "-"));
  for (const name of names) writeFileSync(join(dir, name), "");
  return dir;
}

test("CAPABILITY_COMPONENTS / normalizeEnvCheck：能力映射固定，未知 envCheck 按 block", () => {
  assert.deepEqual(CAPABILITY_COMPONENTS.build, ["gcc", "cmake", "ninja"]);
  assert.deepEqual(CAPABILITY_COMPONENTS.flash, ["openocd"]);
  assert.deepEqual(CAPABILITY_COMPONENTS.debug, ["openocd", "gdb"]);
  assert.deepEqual(CAPABILITY_COMPONENTS.generate, ["cubemx", "cubemx-java"]);
  assert.equal(normalizeEnvCheck("warn"), "warn");
  assert.equal(normalizeEnvCheck("off"), "off");
  assert.equal(normalizeEnvCheck(undefined), "block");
  assert.equal(normalizeEnvCheck("随便什么"), "block", "认不出的值不能变成放行");
});

/** 假 subprocess：按 argv 回答版本命令（不真的起进程），记下每次 spawn 的 argv。 */
function versionSubprocess(answer) {
  const spawns = [];
  const reader = (text) => ({
    readFrom: (offset) => ({ text: text.slice(offset), lossy: false, nextOffset: text.length }),
  });
  return {
    spawns,
    subprocess: {
      resolveExecutable: () => {
        throw new Error("文件已经在 binDirs 里，不该回退到 PATH 解析");
      },
      spawn(spec) {
        spawns.push(spec.argv);
        const reply = answer(spec.argv) ?? {};
        return {
          done: Promise.resolve({ exitCode: reply.exitCode ?? 0, signal: null }),
          collected: { stdout: reader(reply.stdout ?? ""), stderr: reader(reply.stderr ?? "") },
          terminate() {
            return undefined;
          },
          waitForExit() {
            return Promise.resolve();
          },
        };
      },
    },
  };
}

test("快路径：文件都在时只给主组件跑一次版本命令，其余组件零成本放行", async () => {
  const bin = fakeBin("full", ["arm-none-eabi-gcc.exe", "cmake.exe", "ninja.exe"]);
  const fake = versionSubprocess(() => ({ stdout: "arm-none-eabi-gcc (GCC) 13.3.0" }));
  try {
    await withEnv({ DSH_STM32_NO_CONFIG: "1" }, async () => {
      const result = await ensureToolchain(gateCtx(fake.subprocess), { capability: "build", binDirs: [bin] });
      assert.equal(result.ok, true, result.message);
      assert.deepEqual(result.missing, []);
      assert.deepEqual(result.checked, ["gcc", "cmake", "ninja"]);
      assert.match(result.message, /工具链齐全/u);
      assert.equal(fake.spawns.length, 1, "只该为 gcc 跑一次版本命令，不是每个组件都跑");
      assert.match(String(fake.spawns[0][0]), /gcc/iu);
      assert.deepEqual(gateReportNotes(result), [], "成功路径不往报告里塞噪音");
    });
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("快路径：文件在、但版本命令跑不通时不算齐全（审计 B13）", async () => {
  const bin = fakeBin("broken", ["arm-none-eabi-gcc.exe", "cmake.exe", "ninja.exe"]);
  const fake = versionSubprocess((argv) =>
    String(argv[0]).toLowerCase().includes("gcc")
      ? { exitCode: 1, stderr: "cannot execute binary file" }
      : { stdout: "ok" },
  );
  try {
    await withEnv({ DSH_STM32_NO_CONFIG: "1" }, async () => {
      const result = await ensureToolchain(gateCtx(fake.subprocess), { capability: "build", binDirs: [bin] });
      assert.equal(result.ok, false, "半截下载/被杀软隔离的 exe 不能被当成齐全");
      assert.deepEqual(result.missing.map((item) => item.id), ["gcc"]);
      assert.ok(
        result.warnings.some((line) => line.includes("版本命令没跑通")),
        "要写明是「跑不通」而不是「没装」：" + result.warnings.join(" | "),
      );
      assert.ok(result.warnings.some((line) => line.includes("文件在")), result.warnings.join(" | "));
    });
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("快路径的版本确认带 60 s 缓存：连着调两次只 spawn 一次", async () => {
  const bin = fakeBin("smoke-cache", ["openocd.exe"]);
  const fake = versionSubprocess(() => ({ stdout: "Open On-Chip Debugger 0.12.0" }));
  try {
    await withEnv({ DSH_STM32_NO_CONFIG: "1" }, async () => {
      const request = { capability: "flash", binDirs: [bin] };
      assert.equal((await ensureToolchain(gateCtx(fake.subprocess), request)).ok, true);
      assert.equal((await ensureToolchain(gateCtx(fake.subprocess), request)).ok, true);
      assert.equal(fake.spawns.length, 1, "第二次应命中 smoke 缓存，不再 spawn");
    });
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("缺件且 envCheck=block：说清缺什么、为什么不能开工，missing 带安装与自检", async () => {
  const bin = tempDir("gate-empty");
  const fake = forbiddingSubprocess();
  try {
    await withEnv({ DSH_STM32_NO_CONFIG: "1" }, async () => {
      const result = await ensureToolchain(gateCtx(fake.subprocess), { capability: "build", binDirs: [bin] });
      assert.equal(result.ok, false);
      assert.equal(result.mode, "block");
      assert.deepEqual(result.missing.map((item) => item.id), ["gcc", "cmake", "ninja"]);
      assert.match(result.message, /^缺 /u);
      assert.match(result.message, /这次没有开始/u);
      for (const item of result.missing) {
        assert.ok(item.label.length > 0);
        assert.ok(item.impact.length > 0, item.id + " 要说清缺了会怎样");
        assert.ok(item.install.length > 0, item.id + " 要给安装步骤");
        assert.ok(item.verify.length > 0, item.id + " 要给自检命令");
      }
      assert.match(result.detail, /安装：/u);
      assert.match(result.detail, /MSYS2 配置：/u);
      assert.match(result.nextStep, /stm32_env_install/u);
      const notes = gateReportNotes(result);
      assert.match(notes[0], /^缺 /u);
      assert.ok(notes.length > result.missing.length, "每条缺件至少两行（说明 + 安装）");
    });
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("envCheck=warn：不拦但把警告放在最前面；off：根本不查", async () => {
  const bin = tempDir("gate-warn");
  const fake = forbiddingSubprocess();
  try {
    await withEnv({ DSH_STM32_NO_CONFIG: "1" }, async () => {
      const warned = await ensureToolchain(gateCtx(fake.subprocess), { capability: "flash", binDirs: [bin], envCheck: "warn" });
      assert.equal(warned.ok, false, "warn 只是不拦调用方，结论仍是'缺'");
      assert.equal(warned.mode, "warn");
      assert.match(warned.message, /^⚠ 工具链不齐/u);
      assert.deepEqual(warned.checked, ["openocd"]);

      const off = await ensureToolchain(gateCtx(fake.subprocess), { capability: "debug", binDirs: [bin], envCheck: "off" });
      assert.equal(off.ok, true);
      assert.equal(off.mode, "off");
      assert.deepEqual(off.missing, []);
      assert.match(off.message, /没有检查/u);
      assert.match(off.detail, /跳过工具链检查/u);
      assert.equal(fake.calls.spawn, 0);
    });
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("慢路径 60 s 缓存：同一配置第二次 cacheHit=true，resetGateCache 清掉", async () => {
  const bin = tempDir("gate-cache");
  const fake = forbiddingSubprocess();
  try {
    await withEnv({ DSH_STM32_NO_CONFIG: "1" }, async () => {
      const request = { capability: "debug", binDirs: [bin] };
      const first = await ensureToolchain(gateCtx(fake.subprocess), request);
      assert.equal(first.ok, false);
      assert.equal(first.cacheHit, false);
      assert.deepEqual(first.missing.map((item) => item.id), ["openocd", "gdb"]);

      const second = await ensureToolchain(gateCtx(fake.subprocess), request);
      assert.equal(second.cacheHit, true, "同一配置的探测结果应命中缓存");
      assert.deepEqual(second.missing.map((item) => item.id), ["openocd", "gdb"]);
      assert.match(second.detail, /60 s 缓存/u);

      resetGateCache();
      const third = await ensureToolchain(gateCtx(fake.subprocess), request);
      assert.equal(third.cacheHit, false, "resetGateCache 之后要重新探测");
    });
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("generate 能力：CubeMX 与它自带的 java 都缺时两项一起报出来", async () => {
  const bin = tempDir("gate-cubemx");
  const cube = tempDir("gate-cubemx-root");
  const fake = forbiddingSubprocess();
  try {
    await withEnv({ DSH_STM32_NO_CONFIG: "1" }, async () => {
      const result = await ensureToolchain(gateCtx(fake.subprocess), { capability: "generate", binDirs: [bin], cubeMxRoots: [cube] });
      assert.equal(result.ok, false);
      assert.deepEqual(result.checked, ["cubemx", "cubemx-java"]);
      assert.deepEqual(result.missing.map((item) => item.id), ["cubemx", "cubemx-java"]);
      assert.match(result.message, /这次没有开始生成代码/u);
    });
  } finally {
    rmSync(bin, { recursive: true, force: true });
    rmSync(cube, { recursive: true, force: true });
  }
});

// ── 引擎与门禁共用同一条解析规则 ──────────────────────────────────────────
// 之前 flash/regs/debug/debug-session 只用 resolveFromDirs（显式目录，不看 PATH），
// 而门禁（probe）会回退到宿主解析；结果就是"门禁说齐全、引擎说找不到 openocd"。
// 这条规则现在收在 resolveToolIn 里，下面把它按优先级钉住。

/** 假 subprocess：只实现 resolveExecutable，记下被问到的命令名。 */
function resolvingSubprocess(table) {
  const asked = [];
  return {
    asked,
    subprocess: {
      resolveExecutable: (command) => {
        asked.push(command);
        const hit = table[command];
        if (hit === undefined) throw new Error("command not found: " + command);
        return Promise.resolve(hit);
      },
      spawn: () => {
        throw new Error("解析阶段不该 spawn");
      },
    },
  };
}

test("resolveToolIn：显式目录命中时不碰宿主解析", async () => {
  const exeName = process.platform === "win32" ? "openocd.exe" : "openocd";
  const bin = fakeBin("probe-dirs", [exeName]);
  const fake = resolvingSubprocess({ openocd: "C:/somewhere/openocd.exe" });
  try {
    const hit = await resolveToolIn(fake.subprocess, ["openocd"], [bin]);
    assert.equal(hit, join(bin, exeName));
    assert.deepEqual(fake.asked, [], "目录里已经有文件了，就不该问宿主/PATH");
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("resolveToolIn：目录里没有时回退到宿主解析（等同于 PATH）", async () => {
  const bin = tempDir("probe-path");
  const fake = resolvingSubprocess({ "gdb-multiarch": "D:/app/msys64/ucrt64/bin/gdb-multiarch.exe" });
  try {
    const hit = await resolveToolIn(fake.subprocess, ["gdb-multiarch", "arm-none-eabi-gdb"], [bin]);
    assert.equal(hit, "D:/app/msys64/ucrt64/bin/gdb-multiarch.exe");
    assert.deepEqual(fake.asked, ["gdb-multiarch"], "第一个候选名命中就不再试第二个");
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("resolveToolIn：哪都找不到时返回 null，不抛异常", async () => {
  const bin = tempDir("probe-miss");
  const fake = resolvingSubprocess({});
  try {
    const hit = await resolveToolIn(fake.subprocess, ["openocd"], [bin]);
    assert.equal(hit, null);
    assert.deepEqual(fake.asked, ["openocd"]);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("resolveToolIn：老式假 subprocess（没有 resolveExecutable）也不炸", async () => {
  const bin = tempDir("probe-legacy");
  try {
    const hit = await resolveToolIn({ spawn: () => { throw new Error("不该 spawn"); } }, ["openocd"], [bin]);
    assert.equal(hit, null);
    assert.equal(await resolveToolIn(undefined, ["openocd"], [bin]), null);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("没有 subprocess 服务时也只做文件检查，不炸", async () => {
  const bin = tempDir("gate-nosub");
  try {
    await withEnv({ DSH_STM32_NO_CONFIG: "1" }, async () => {
      const result = await ensureToolchain(gateCtx(undefined), { capability: "flash", binDirs: [bin] });
      assert.equal(result.ok, false);
      assert.deepEqual(result.missing.map((item) => item.id), ["openocd"]);
      assert.match(result.missing[0].error, /subprocess/u);
    });
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

// ── 给别人下载也一样能用：配置/默认值里不能有开发机专属路径 ────────────────

test("配置里的路径本机不存在时：门禁照常工作，但把「这条不会命中」写进 warnings 与 notes", async () => {
  const dir = tempDir("cfg-foreign");
  const path = join(dir, "config.json");
  try {
    writeToolchainConfig(
      { ...defaultToolchainConfig(), msys64: "Q:/app/msys64", binDirs: ["Q:/app/msys64/ucrt64/bin"] },
      { DSH_STM32_CONFIG: path },
    );
    await withEnv({ DSH_STM32_CONFIG: path, STM32_BIN_DIRS: undefined, STM32_CUBEMX_ROOT: undefined }, async () => {
      const fake = forbiddingSubprocess();
      const result = await ensureToolchain(gateCtx(fake.subprocess), { capability: "flash", envCheck: "off" });
      assert.equal(result.ok, true);
      assert.ok(result.warnings.length >= 1, "外来的 msys64/binDirs 应该被报出来");
      assert.ok(result.warnings.every((line) => line.includes("Q:/app/msys64")), result.warnings.join(" | "));
      assert.ok(result.warnings.every((line) => line.includes("在本机不存在")), result.warnings.join(" | "));
      const notes = gateReportNotes(result);
      assert.ok(notes.some((line) => line.includes("⚠")), "即使放行，配置告警也要随 notes 出去");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("安装建议里的 pacman 指向配置里的 MSYS2，不写死开发机的 D:/app/msys64", () => {
  const targets = buildTargets({ binDirs: ["E:/msys64/ucrt64/bin"], cubeMxRoots: ["F:/CubeMX"] });
  const gcc = targets.find((target) => target.id === "gcc");
  assert.match(gcc.install[0], /E:\/msys64\/usr\/bin\/pacman\.exe -S /u);
  assert.ok(
    targets.every((target) => target.install.every((line) => !line.includes("D:/app"))),
    "任何一条安装建议都不该出现开发机路径",
  );
  const noMsys = buildTargets({ binDirs: ["E:/only/bin"], cubeMxRoots: [] });
  const openocd = noMsys.find((target) => target.id === "openocd");
  assert.match(openocd.install[0], /C:\/msys64\/usr\/bin\/pacman\.exe/u, "不知道 MSYS2 在哪时给默认安装位置");
});

test("配置里的 msys64 来自别的机器（盘符不存在）时：不当安装目标、也不当已装，只给告警", () => {
  const foreign = resolveTargetDir(
    undefined,
    { ...defaultToolchainConfig(), msys64: "Q:/app/msys64" },
    { STM32_NO_DISCOVER: "1" },
    () => false,
  );
  assert.notEqual(foreign.via, "config", "不能把外来配置当成本机安装目标");
  assert.match(foreign.warning, /Q:\/app\/msys64/u);
  assert.match(foreign.warning, /targetDir/u);

  const local = resolveTargetDir(
    undefined,
    { ...defaultToolchainConfig(), msys64: "C:/msys64" },
    {},
    (path) => path === "C:/",
  );
  assert.equal(local.msys64, "C:/msys64", "本机存在的盘符照常当目标");
  assert.equal(local.via, "config");
  assert.equal(local.warning, "");
});

test("探测被取消时不写 60 s 缓存（审计 A27）", async () => {
  const bin = tempDir("gate-abort");
  try {
    await withEnv({ DSH_STM32_NO_CONFIG: "1" }, async () => {
      const cancelled = await ensureToolchain(gateCtx(undefined), {
        capability: "flash",
        binDirs: [bin],
        signal: AbortSignal.abort(),
      });
      assert.equal(cancelled.ok, false);
      assert.match(cancelled.message, /取消/u);
      assert.equal(cancelled.cacheHit, false);

      const next = await ensureToolchain(gateCtx(undefined), { capability: "flash", binDirs: [bin] });
      assert.equal(next.cacheHit, false, "取消的那次不该留下缓存，否则缺件会被记 60 s");
      assert.equal(next.ok, false, "空目录里当然找不到 openocd");
    });
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});
