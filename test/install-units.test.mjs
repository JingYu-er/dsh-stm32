// 为什么要有这个套件：真装机上暴露的两个问题都在这块逻辑里——
// （1）pacman -S 对已装的包不是"跳过"而是"顺手升级"，插件在第 4 步把用户整套 mingw 工具链
//     升一个大版本是不能接受的副作用（而且老 MSYS2 上 -Sy + 局部 -S 会因局部升级解不开依赖而失败）；
// （2）那次失败后，job 明明自检 5 个组件都能跑，却仍然报"安装未完成"，用户看到的是假坏消息。
// 这里用"脚本化的假 subprocess"把这两种局面钉死，不碰真磁盘、不跑真 pacman。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatBytes, planOrInstallMsys2, parsePacmanQuery } from "../lib/engine/msys2-install.js";
import {
  readToolchainConfig,
  resetToolchainConfigCache,
  updateToolchainConfig,
  writeToolchainConfig,
} from "../lib/data/toolchain-config.js";
import { invalidPackageNames, registerEnvInstall } from "../lib/tools/env-install.js";

delete process.env.DSH_STM32_NO_CONFIG;
process.env.STM32_NO_DISCOVER = "1";
delete process.env.STM32_BIN_DIRS;
delete process.env.STM32_CUBEMX_ROOT;

const PACKAGES = [
  "mingw-w64-ucrt-x86_64-arm-none-eabi-gcc",
  "mingw-w64-ucrt-x86_64-gdb-multiarch",
  "mingw-w64-ucrt-x86_64-openocd",
  "mingw-w64-ucrt-x86_64-cmake",
  "mingw-w64-ucrt-x86_64-ninja",
];

function tempDir(tag) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-msys2-" + tag + "-"));
  process.env.DSH_STM32_CONFIG = join(dir, "cfg", "config.json");
  resetToolchainConfigCache();
  return dir;
}

/** 假 msys64：有 usr/bin/bash.exe（判定"本体完整"），ucrt64/bin 里放 5 个空文件当工具。 */
function makeMsys64(root) {
  mkdirSync(join(root, "usr", "bin"), { recursive: true });
  writeFileSync(join(root, "usr", "bin", "bash.exe"), "");
  mkdirSync(join(root, "ucrt64", "bin"), { recursive: true });
  for (const name of ["arm-none-eabi-gcc.exe", "gdb-multiarch.exe", "openocd.exe", "cmake.exe", "ninja.exe"]) {
    writeFileSync(join(root, "ucrt64", "bin", name), "");
  }
  return root;
}

/** 按命令内容回答的假 subprocess：只实现 runCapture 用到的 spawn 契约，记下每条被执行的命令。 */
function scriptedSubprocess(answer) {
  const calls = [];
  const reader = (text) => ({
    readFrom(offset) {
      return { text: text.slice(offset), nextOffset: text.length, lossy: false };
    },
  });
  return {
    calls,
    resolveExecutable: (command) => command,
    spawn(spec) {
      const line = spec.argv.join(" ");
      calls.push(line);
      const reply = answer(line) ?? {};
      const done = Promise.resolve({ exitCode: reply.exitCode ?? 0, signal: null });
      return {
        done,
        collected: {
          stdout: reader(reply.stdout ?? ""),
          stderr: reader(reply.stderr ?? ""),
        },
        terminate() {},
        waitForExit() {
          return done;
        },
      };
    },
  };
}

const pacmanFailText = "错误：无法准备事务处理 (无法满足依赖关系)";

function stepOf(report, id) {
  return report.steps.find((step) => step.id === id);
}

/** pacman 查询命令的两种形态：计划模式直接跑 pacman.exe -Q，真装走 bash -lc "pacman -Q …"。 */
function isPacmanQuery(line) {
  return /pacman(?:\.exe)? -Q /u.test(line);
}

test("parsePacmanQuery：只收「包名 版本」行，报错行走 stderr 收不进来", () => {
  const parsed = parsePacmanQuery(
    "mingw-w64-ucrt-x86_64-openocd 0.12.0-3\n\nmingw-w64-ucrt-x86_64-ninja 1.12.1-1\n乱码行\n",
  );
  assert.equal(parsed.get("mingw-w64-ucrt-x86_64-openocd"), "0.12.0-3");
  assert.equal(parsed.get("mingw-w64-ucrt-x86_64-ninja"), "1.12.1-1");
  assert.equal(parsed.size, 2);
  assert.equal(parsePacmanQuery("").size, 0);
});

test("五个包都已装：pacman 一步跳过，绝不再跑 pacman -S（不升级用户工具链）", async () => {
  const dir = tempDir("skip");
  const root = makeMsys64(join(dir, "msys64"));
  const subprocess = scriptedSubprocess((line) => {
    if (isPacmanQuery(line)) {
      return {
        exitCode: 0,
        stdout: PACKAGES.map((name, index) => name + " 1." + String(index) + ".0-1").join("\n") + "\n",
      };
    }
    return {};
  });
  const report = await planOrInstallMsys2(
    subprocess,
    { mode: "install", targetDir: root, writePath: false, timeoutMs: 5_000 },
    process.env,
  );
  const pacman = stepOf(report, "pacman");
  assert.equal(pacman.status, "skipped");
  assert.match(pacman.detail, /都已经装了/u);
  assert.match(pacman.detail, /没.*升级/u);
  // 真的没有第二条 pacman -S 命令：只问了一次 -Q。
  assert.equal(subprocess.calls.filter((line) => line.includes("pacman -S")).length, 0);
  assert.equal(report.ok, true);
  assert.equal(report.verify.ok, true);
  // 配置仍然写：已装好的机器也要留一份"工具链在哪"。
  assert.equal(report.config.written, true);
  const written = JSON.parse(readFileSync(process.env.DSH_STM32_CONFIG, "utf8"));
  assert.equal(written.msys64.toLowerCase(), root.replaceAll("\\", "/").toLowerCase());
  rmSync(dir, { recursive: true, force: true });
});

test("pacman 补包失败但 5 个组件自检都能跑：按「已装」处理，不报假失败", async () => {
  const dir = tempDir("compensate");
  const root = makeMsys64(join(dir, "msys64"));
  const subprocess = scriptedSubprocess((line) => {
    if (isPacmanQuery(line)) return { exitCode: 1, stdout: "" };
    if (line.includes("pacman -S") || line.includes("pacman -Sy")) {
      return { exitCode: 1, stdout: "", stderr: pacmanFailText + "\n" };
    }
    return {};
  });
  const report = await planOrInstallMsys2(
    subprocess,
    { mode: "install", targetDir: root, writePath: false, timeoutMs: 5_000 },
    process.env,
  );
  const pacman = stepOf(report, "pacman");
  assert.equal(pacman.status, "done", "自检全过时，pacman 失败不该让整个安装判负");
  assert.match(pacman.detail, /已装/u);
  assert.match(pacman.detail, /pacman -Syu/u, "要留一句：真想升级得自己 -Syu");
  assert.equal(report.ok, true);
  rmSync(dir, { recursive: true, force: true });
});

test("依赖解不开时给出 -Syu 的下一步，而不是只丢一句 pacman 退出码", async () => {
  const dir = tempDir("deps");
  const root = makeMsys64(join(dir, "msys64"));
  const subprocess = scriptedSubprocess((line) => {
    if (isPacmanQuery(line)) return { exitCode: 1, stdout: "" };
    if (line.includes("pacman -S") || line.includes("pacman -Sy")) {
      return { exitCode: 1, stdout: "", stderr: pacmanFailText + "\n" };
    }
    // 让自检失败：版本命令一律报错 → 组件"跑不起来"，于是 pacman 的失败必须保留下来。
    if (line.includes("--version")) return { exitCode: 1, stdout: "", stderr: "boom\n" };
    return {};
  });
  const report = await planOrInstallMsys2(
    subprocess,
    { mode: "install", targetDir: root, writePath: false, timeoutMs: 5_000 },
    process.env,
  );
  const pacman = stepOf(report, "pacman");
  assert.equal(pacman.status, "failed");
  assert.match(pacman.detail, /无法满足依赖关系/u);
  assert.match(pacman.detail, /pacman -Syu/u);
  assert.equal(report.ok, false);
  rmSync(dir, { recursive: true, force: true });
});

test("真装的卡片 message 说「已在后台安装」，不再贴计划模式的「还没动手」", async () => {
  const dir = tempDir("message");
  const root = makeMsys64(join(dir, "msys64"));
  const subprocess = scriptedSubprocess((line) =>
    isPacmanQuery(line)
      ? { exitCode: 0, stdout: PACKAGES.map((name) => name + " 1.0.0-1").join("\n") + "\n" }
      : {},
  );
  let definition;
  let startedLabel = "";
  registerEnvInstall({
    tools: {
      register(tool) {
        definition = tool;
      },
    },
    get(name) {
      if (name === "subprocess") return subprocess;
      if (name === "jobs") {
        return {
          start(spec) {
            startedLabel = spec.label;
            return "job-fake";
          },
        };
      }
      return undefined;
    },
  });
  assert.ok(definition, "stm32_env_install 应已注册");
  const value = await definition.execute(
    { dryRun: false, confirm: true, targetDir: root, writePath: false },
    { signal: new AbortController().signal },
  );
  assert.equal(value.mode, "job");
  assert.equal(value.jobId, "job-fake");
  assert.match(value.message, /已在后台安装/u);
  assert.doesNotMatch(value.message, /还没动手/u);
  assert.equal(value.report.message, value.message);
  assert.ok(
    value.report.notes.every((note) => !note.startsWith("这只是计划")),
    "计划专属的那句说明不能跟着真装 job 一起发出去",
  );
  assert.match(startedLabel, /stm32_env_install/u);
  rmSync(dir, { recursive: true, force: true });
});
test("计划里的 pacman 步骤说的是真会跑的事（只查 -Q，不 -S 不 -Sy）", async () => {
  const dir = tempDir("plan");
  const root = makeMsys64(join(dir, "msys64"));
  const subprocess = scriptedSubprocess(() => ({}));
  const report = await planOrInstallMsys2(
    subprocess,
    { mode: "plan", targetDir: root, writePath: false, timeoutMs: 5_000 },
    process.env,
  );
  const pacman = stepOf(report, "pacman");
  assert.match(pacman.detail, /pacman -Q/u, "计划要写清先问装没装");
  assert.match(pacman.detail, /不升级/u);
  assert.doesNotMatch(pacman.detail, /-Sy --noconfirm &&/u, "不能再向用户预告一条无条件 -Sy + -S 的命令");
  // 计划模式可以跑唯一一条只读的 pacman -Q（要回答"到底缺几个"），但绝不能碰 -S / -Sy。
  const pacmanCalls = subprocess.calls.filter((line) => /pacman/iu.test(line));
  assert.equal(pacmanCalls.length, 1, "计划模式只该跑一条只读的 pacman -Q：" + pacmanCalls.join(" | "));
  assert.match(pacmanCalls[0], /pacman(?:\.exe)? -Q /u);
  assert.deepEqual(
    subprocess.calls.filter((line) => /pacman\s+-S/iu.test(line)),
    [],
    "计划模式绝不能跑 pacman -S / -Sy（会改动系统）",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("计划：本机已有完整 MSYS2 + 5 个组件 → 说「什么都不用装」，下载 0 字节", async () => {
  const dir = tempDir("plan-ready");
  const root = makeMsys64(join(dir, "msys64"));
  const posixRoot = root.replace(/\\/g, "/");
  // 配置写成"已经装好"的样子：config 那一步也不该再说"要改"。
  writeToolchainConfig(
    {
      version: 1,
      msys64: posixRoot,
      binDirs: [posixRoot + "/ucrt64/bin"],
      packages: [...PACKAGES],
      cubeMxRoot: "",
      updatedAt: new Date().toISOString(),
    },
    process.env,
  );
  resetToolchainConfigCache();
  const subprocess = scriptedSubprocess((line) => {
    if (isPacmanQuery(line)) {
      return { exitCode: 0, stdout: PACKAGES.map((name) => name + " 13.3.0-1").join("\n") + "\n" };
    }
    return {};
  });
  const report = await planOrInstallMsys2(
    subprocess,
    { mode: "plan", targetDir: root, writePath: false, timeoutMs: 5_000 },
    process.env,
  );
  assert.equal(report.download.bytes, 0, "已有 MSYS2 时不能再说「安装包 43.1 MB」");
  // 工具链完整时卡片只留一句话：不列 7 个"已跳过"的步骤，也不贴 notes。
  assert.deepEqual(report.steps, [], "完整时不该再画一长串 skipped 步骤");
  assert.deepEqual(report.notes, []);
  assert.equal(report.nextStep, "");
  assert.match(report.message, /工具链完整/u);
  assert.doesNotMatch(report.message, /需要下载/u);
  assert.equal(report.verify.ok, true);
  assert.equal(report.verify.tools.filter((tool) => tool.found).length, 5);
  rmSync(dir, { recursive: true, force: true });
});

test("缺 CubeMX：紧凑卡片补一句 HAL 提示；装了就自动消失", async () => {
  const dir = tempDir("plan-cubemx");
  const root = makeMsys64(join(dir, "msys64"));
  // 5 个包都报"已装"，这样才走得到"什么都不用装"的紧凑分支。
  const subprocess = scriptedSubprocess((line) =>
    isPacmanQuery(line)
      ? { exitCode: 0, stdout: PACKAGES.map((name) => name + " 13.3.0-1").join("\n") + "\n" }
      : {},
  );

  process.env.STM32_CUBEMX_ROOT = join(dir, "no-cubemx").replace(/\\/g, "/");
  const without = await planOrInstallMsys2(
    subprocess,
    { mode: "plan", targetDir: root, writePath: false, timeoutMs: 5_000 },
    process.env,
  );
  assert.equal(without.steps.length, 0, "仍然是一句话的紧凑卡片");
  assert.match(without.message, /工具链完整/u);
  assert.match(without.message, /STM32CubeMX/u, "缺 CubeMX 时要提示去 ST 官网装");
  assert.match(without.message, /HAL/u);

  const cubeRoot = join(dir, "cubemx");
  mkdirSync(join(cubeRoot, "jre", "bin"), { recursive: true });
  writeFileSync(join(cubeRoot, "STM32CubeMX.exe"), "");
  writeFileSync(join(cubeRoot, "jre", "bin", "java.exe"), "");
  process.env.STM32_CUBEMX_ROOT = cubeRoot.replace(/\\/g, "/");
  const withCube = await planOrInstallMsys2(
    subprocess,
    { mode: "plan", targetDir: root, writePath: false, timeoutMs: 5_000 },
    process.env,
  );
  assert.doesNotMatch(withCube.message, /STM32CubeMX/u, "装了 CubeMX 就不该再提示去装");
  delete process.env.STM32_CUBEMX_ROOT;
  rmSync(dir, { recursive: true, force: true });
});

test("计划：只缺 1 个包 → 只说这 1 个，且不下载安装包", async () => {
  const dir = tempDir("plan-partial");
  const root = makeMsys64(join(dir, "msys64"));
  const subprocess = scriptedSubprocess((line) => {
    if (isPacmanQuery(line)) {
      // openocd 没装，其余 4 个装好了。
      const installed = PACKAGES.filter((name) => !name.endsWith("-openocd"));
      return { exitCode: 1, stdout: installed.map((name) => name + " 13.3.0-1").join("\n") + "\n" };
    }
    return {};
  });
  const report = await planOrInstallMsys2(
    subprocess,
    { mode: "plan", targetDir: root, writePath: false, timeoutMs: 5_000 },
    process.env,
  );
  const pacman = stepOf(report, "pacman");
  assert.equal(pacman.status, "pending");
  assert.match(pacman.detail, /缺 1 个/u);
  assert.match(pacman.detail, /openocd/u);
  assert.doesNotMatch(pacman.detail, /cmake/u, "已装好的包不该出现在「要补」的清单里");
  assert.match(pacman.detail, /已装的 4 个不动/u);
  assert.equal(report.download.bytes, 0);
  assert.match(report.message, /只补 1 个/u);
  assert.doesNotMatch(report.message, /需要下载/u);
  assert.match(report.nextStep, /只补缺的 1 个包/u);
  rmSync(dir, { recursive: true, force: true });
});

test("计划：pacman 问不出来（超时 / 报错）→ 不猜缺哪个，只说真装时会先问", async () => {
  const dir = tempDir("plan-unknown");
  const root = makeMsys64(join(dir, "msys64"));
  const subprocess = scriptedSubprocess((line) => {
    if (isPacmanQuery(line)) return { exitCode: 1, stdout: "", stderr: "error: 数据库被锁" };
    return {};
  });
  const report = await planOrInstallMsys2(
    subprocess,
    { mode: "plan", targetDir: root, writePath: false, timeoutMs: 5_000 },
    process.env,
  );
  const pacman = stepOf(report, "pacman");
  assert.equal(pacman.status, "pending");
  assert.match(pacman.detail, /没问出来/u);
  assert.doesNotMatch(pacman.detail, /缺 5 个/u, "问不出来就不能编一个缺件清单");
  assert.match(report.message, /没问出/u);
  assert.doesNotMatch(report.message, /只补 5 个/u);
  assert.match(report.notes.join("\n"), /不用下载安装包/u);
  assert.equal(report.download.bytes, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("reg query 读不到（起不来/被拦）：不写 PATH、不拿空串备份，配置照写", async (t) => {
  if (process.platform !== "win32") {
    t.skip("只有 Windows 才有 HKCU\\Environment");
    return;
  }
  const dir = tempDir("path-unreadable");
  const root = makeMsys64(join(dir, "msys64"));
  const subprocess = scriptedSubprocess((line) => {
    // 只让"读 PATH"失败。真实世界里这是被组策略 / EDR 拦住，或 reg.exe 根本起不来。
    if (line.includes("reg.exe query")) throw new Error("reg.exe 被安全软件拦住");
    if (isPacmanQuery(line)) {
      return { exitCode: 0, stdout: PACKAGES.map((name) => name + " 1.0.0-1").join("\n") + "\n" };
    }
    return {};
  });
  const report = await planOrInstallMsys2(
    subprocess,
    { mode: "install", targetDir: root, writePath: true, timeoutMs: 5_000 },
    process.env,
  );
  const pathStep = stepOf(report, "path");
  assert.equal(pathStep.status, "failed", pathStep.detail);
  assert.match(pathStep.detail, /读不到当前用户 PATH/u);
  assert.match(pathStep.detail, /不会写注册表/u);
  assert.match(report.message, /不会写注册表/u, "message 也要说清是「为安全起见没动」，不是「写坏了」");
  // 红线：一条 reg add 都不能有——读不到旧值时写进去就是把用户整条用户级 PATH 换掉。
  assert.deepEqual(subprocess.calls.filter((line) => line.includes("reg.exe add")), []);
  assert.equal(report.path.changed, false);
  assert.equal(report.path.done, false);
  assert.equal(report.path.after, "", "读失败时不该编出一个 after 值");
  // 也不许把空串当旧值备份（那种备份等于没有回滚能力）。
  assert.equal(report.path.backup, "");
  assert.deepEqual(
    readdirSync(join(dir, "cfg")).filter((name) => name.startsWith("path-backup")),
    [],
    "不该留下一个内容为空的 PATH 备份",
  );
  // PATH 失败不致命：配置照写，插件仍按配置里的绝对路径找工具。
  assert.equal(report.config.written, true);
  const written = JSON.parse(readFileSync(process.env.DSH_STM32_CONFIG, "utf8"));
  assert.deepEqual(written.binDirs, [root.replaceAll("\\", "/") + "/ucrt64/bin"]);
  assert.equal(report.ok, true);
  rmSync(dir, { recursive: true, force: true });
});

test("用户变量里确实没有 Path：照常新建一条（危险的是「读不到」，不是「没有」）", async (t) => {
  if (process.platform !== "win32") {
    t.skip("只有 Windows 才有 HKCU\\Environment");
    return;
  }
  const dir = tempDir("path-missing");
  const root = makeMsys64(join(dir, "msys64"));
  const subprocess = scriptedSubprocess((line) => {
    if (line.includes("reg.exe query")) {
      // 中文 Windows 上 reg.exe 的原话；英文系统是 "The system was unable to find ..."。
      return { exitCode: 1, stdout: "", stderr: "错误: 系统找不到指定的注册表项或值。\r\n" };
    }
    if (isPacmanQuery(line)) {
      return { exitCode: 0, stdout: PACKAGES.map((name) => name + " 1.0.0-1").join("\n") + "\n" };
    }
    return {};
  });
  const report = await planOrInstallMsys2(
    subprocess,
    { mode: "install", targetDir: root, writePath: true, timeoutMs: 5_000 },
    process.env,
  );
  const pathStep = stepOf(report, "path");
  assert.equal(pathStep.status, "done", pathStep.detail);
  const adds = subprocess.calls.filter((line) => line.includes("reg.exe add"));
  assert.equal(adds.length, 1, "只该写一次：计划阶段与真装各读一次，但只有真装那一次能写");
  const entry = root.replaceAll("/", "\\") + "\\ucrt64\\bin";
  assert.ok(
    (adds[0] ?? "").toLowerCase().includes(entry.toLowerCase()),
    "新值必须就是这条 bin 目录（没有旧值可拼）",
  );
  assert.equal(report.path.changed, true);
  assert.notEqual(report.path.backup, "", "写前仍要留一份备份");
  assert.equal(readFileSync(report.path.backup, "utf8").trim(), "");
  rmSync(dir, { recursive: true, force: true });
});

// B5：自检必须只认目标 binDir。PATH 上另一份能跑的 gcc（STM32CubeIDE 自带、xpack、旧 msys64）
// 一旦算命中，pacman 明明没装进目标目录也会被改判成"装好了"，而配置里指的正是那个空目录——
// 用户下一次编译才撞上。
test("自检只认目标 binDir：PATH 上能跑的 gcc 不能把 pacman 的失败改判成成功", async () => {
  const dir = tempDir("verify-scope");
  const root = makeMsys64(join(dir, "msys64"));
  // 目标目录里故意缺 arm-none-eabi-gcc（真机上很常见：机器本来就有别的工具链）。
  rmSync(join(root, "ucrt64", "bin", "arm-none-eabi-gcc.exe"), { force: true });
  const subprocess = scriptedSubprocess((line) => {
    if (isPacmanQuery(line)) return { exitCode: 1, stdout: "" };
    if (line.includes("pacman -S") || line.includes("pacman -Sy")) {
      return { exitCode: 1, stdout: "", stderr: pacmanFailText + "\n" };
    }
    // 假设的"另一份 gcc"：如果引擎还允许 PATH 兜底，这条命令就会被跑起来。
    if (line.includes("arm-none-eabi-gcc --version")) {
      return { exitCode: 0, stdout: "arm-none-eabi-gcc (xPack) 13.2.1\n", stderr: "" };
    }
    return {};
  });
  const report = await planOrInstallMsys2(
    subprocess,
    { mode: "install", targetDir: root, writePath: false, timeoutMs: 5_000 },
    process.env,
  );
  assert.equal(
    subprocess.calls.filter((line) => line.includes("arm-none-eabi-gcc --version")).length,
    0,
    "自检不该去跑 PATH 上那一份：那不是我们装的东西",
  );
  const pacman = stepOf(report, "pacman");
  assert.equal(pacman.status, "failed", "工具不在目标目录里，pacman 的失败必须留着");
  assert.match(pacman.detail, /无法满足依赖关系/u);
  assert.equal(report.verify.ok, false, "binDir 里没有 gcc，自检不能算通过");
  assert.equal(report.verify.tools.find((tool) => tool.id === "gcc").found, false);
  const verify = stepOf(report, "verify");
  assert.match(verify.detail, /只在/u);
  assert.match(verify.detail, /不算装到这个目录/u);
  assert.match(report.message, /不算装到这个目录|没有装好/u, "message 要说清没装到目标目录");
  assert.equal(report.ok, false);
  rmSync(dir, { recursive: true, force: true });
});

// B9：reg.exe 输出的是系统代码页（中文 Windows 是 GBK）的字节。宿主的 string 通道会把它变成
// U+FFFD，而旧值一旦被当成乱码写回去，用户原有的中文 PATH 条目就永久坏了。
test("reg query 输出是 GBK 字节：中文 PATH 条目解得出来，写回时不被写成乱码", async (t) => {
  if (process.platform !== "win32") {
    t.skip("只有 Windows 才有 HKCU\\Environment");
    return;
  }
  const dir = tempDir("path-gbk");
  const root = makeMsys64(join(dir, "msys64"));
  const ZHANG_SAN = Buffer.from([0xd5, 0xc5, 0xc8, 0xfd]); // GBK 的「张三」
  /** 把一条 PATH 值按 GBK 拼成 reg query 会吐出来的那种行（非 ASCII 只可能是「张三」）。 */
  const gbkDump = (value) => {
    const buffers = [Buffer.from("    Path    REG_EXPAND_SZ    ", "latin1")];
    value.split("张三").forEach((part, index) => {
      if (index > 0) buffers.push(ZHANG_SAN);
      buffers.push(Buffer.from(part, "latin1"));
    });
    buffers.push(Buffer.from("\r\n", "latin1"));
    return Buffer.concat(buffers);
  };
  // 一个最小的注册表模拟：query 照当前值吐 GBK 字节，add 改当前值。
  let currentPath = "C:/Users/张三/tools";
  const subprocess = scriptedSubprocess((line) => {
    if (line.includes("reg.exe query")) return { exitCode: 0, stdout: "", stderr: "" };
    if (line.includes("reg.exe add")) {
      const matched = / \/d ([\s\S]*) \/f$/u.exec(line);
      if (matched !== null) currentPath = matched[1];
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (isPacmanQuery(line)) {
      return { exitCode: 0, stdout: PACKAGES.map((name) => name + " 1.0.0-1").join("\n") + "\n" };
    }
    return {};
  });
  // 引擎用 cmd.exe 把 reg 输出重定向到临时目录里的 dump.txt；这里替它写 GBK 字节。
  const spawn = subprocess.spawn;
  subprocess.spawn = (spec) => {
    if (spec.argv.join(" ").includes("reg.exe query")) {
      writeFileSync(join(spec.cwd, "dump.txt"), gbkDump(currentPath));
    }
    return spawn(spec);
  };
  const report = await planOrInstallMsys2(
    subprocess,
    { mode: "install", targetDir: root, writePath: true, timeoutMs: 5_000 },
    process.env,
  );
  const pathStep = stepOf(report, "path");
  assert.equal(pathStep.status, "done", pathStep.detail);
  assert.equal(report.path.changed, true);
  const adds = subprocess.calls.filter((line) => line.includes("reg.exe add"));
  assert.equal(adds.length, 1, "只有真装那一次能写注册表");
  assert.ok((adds[0] ?? "").includes("C:/Users/张三/tools"), "旧值里的中文必须原样带过去：" + (adds[0] ?? ""));
  assert.ok(!(adds[0] ?? "").includes("\u{FFFD}"), "乱码绝不能写回注册表");
  const entry = root.replaceAll("/", "\\") + "\\ucrt64\\bin";
  assert.ok((adds[0] ?? "").includes(entry), "新条目要拼在旧值后面：" + entry);
  // 备份也要是解好的原文：将来回滚得靠它。
  assert.match(readFileSync(report.path.backup, "utf8"), /C:\/Users\/张三\/tools/u);
  // 幂等：再跑一次，PATH 里已经有这条 binDir → 只报 done，不再写第二次。
  const again = await planOrInstallMsys2(
    subprocess,
    { mode: "install", targetDir: root, writePath: true, timeoutMs: 5_000 },
    process.env,
  );
  assert.equal(stepOf(again, "path").status, "done", stepOf(again, "path").detail);
  assert.equal(again.path.changed, false);
  assert.equal(
    subprocess.calls.filter((line) => line.includes("reg.exe add")).length,
    1,
    "第二次不该重复写 PATH",
  );
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------- 第 3/4 批新增用例 ------------------------- */

/** 只做"注册工具定义"的假 ctx：不跑 job，只看 execute 返回什么。 */
function fakeCtx(subprocess, jobs) {
  let definition = null;
  return {
    ctx: {
      tools: {
        register(value) {
          definition = value;
        },
      },
      get(name) {
        if (name === "subprocess") return subprocess;
        if (name === "jobs") return jobs;
        return undefined;
      },
    },
    tool() {
      return definition;
    },
  };
}

test("A22 formatBytes：按十进制算，43 060 392 B 是 43.1 MB（不是 41.1）", () => {
  assert.equal(formatBytes(43_060_392), "43.1 MB");
  assert.equal(formatBytes(1_500_000), "1.5 MB");
  assert.equal(formatBytes(999), "0.0 MB");
  assert.equal(formatBytes(0), "0 MB");
});

test("B14 新解压的 MSYS2：先整体 pacman -Syu，再 -S 补包，绝不出现「-Sy 之后立刻 -S」", async () => {
  const dir = tempDir("syu");
  const root = makeMsys64(join(dir, "msys64"));
  const subprocess = scriptedSubprocess((line) => {
    if (isPacmanQuery(line)) return { exitCode: 1, stdout: "", stderr: "error: package not found" };
    if (line.includes("pacman -Syu")) return { exitCode: 0, stdout: "系统已是最新\n" };
    if (line.includes("pacman -S ")) return { exitCode: 0, stdout: "已安装\n" };
    return { exitCode: 0, stdout: "" };
  });
  const report = await planOrInstallMsys2(
    subprocess,
    { mode: "install", targetDir: root, writePath: false, timeoutMs: 5_000 },
    process.env,
  );
  const pacmanStep = stepOf(report, "pacman");
  assert.equal(pacmanStep.status, "done", pacmanStep.detail);
  const upgradeAt = subprocess.calls.findIndex((line) => line.includes("pacman -Syu"));
  const installAt = subprocess.calls.findIndex((line) => line.includes("-S --noconfirm --needed"));
  assert.ok(upgradeAt >= 0, "空库时必须先整体升级一次：" + subprocess.calls.join(" | "));
  assert.ok(installAt > upgradeAt, "-S 补包必须排在 -Syu 之后：" + subprocess.calls.join(" | "));
  for (const line of subprocess.calls) {
    assert.ok(!line.includes("-Sy --noconfirm &&"), "局部升级（-Sy 之后立刻 -S）不该再出现：" + line);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("A30 pacman 失败：db.lck 在就给删锁命令，文件冲突就给 --overwrite 指引（都只提示，不自动做）", async () => {
  const dir = tempDir("lock");
  const root = makeMsys64(join(dir, "msys64"));
  mkdirSync(join(root, "var", "lib", "pacman"), { recursive: true });
  writeFileSync(join(root, "var", "lib", "pacman", "db.lck"), "");
  // 装了一个、缺四个 → needsSync=false，直接走 -S 补包，才会撞上"文件已存在"。
  const subprocess = scriptedSubprocess((line) => {
    if (isPacmanQuery(line)) return { exitCode: 0, stdout: PACKAGES[0] + " 1.0.0-1\n" };
    if (line.includes("pacman -S ")) {
      return { exitCode: 1, stdout: "", stderr: "error: openocd: exists in filesystem" };
    }
    return { exitCode: 1, stdout: "", stderr: "" };
  });
  const report = await planOrInstallMsys2(
    subprocess,
    { mode: "install", targetDir: root, writePath: false, timeoutMs: 5_000 },
    process.env,
  );
  assert.equal(stepOf(report, "pacman").status, "failed", stepOf(report, "pacman").detail);
  const joined = report.notes.join("\n");
  assert.match(joined, /db\.lck/u, "锁文件要被点名：" + joined);
  assert.match(joined, /rm -f \/var\/lib\/pacman\/db\.lck/u, "给具体删锁命令：" + joined);
  assert.match(joined, /--overwrite/u, "文件冲突要给 --overwrite 指引：" + joined);
  // 只提示：锁文件必须还在原地（插件不替用户删）。
  assert.ok(existsSync(join(root, "var", "lib", "pacman", "db.lck")), "锁文件不该被本工具删掉");
  rmSync(dir, { recursive: true, force: true });
});

test("A29 解压中途被取消：不当失败、不删暂存目录、消息说「已取消」", async () => {
  const dir = tempDir("cancel");
  // 缓存里放一个以 MZ 开头的假安装包 → 下载步跳过，直接进解压。
  mkdirSync(join(dir, "cfg"), { recursive: true });
  writeFileSync(join(dir, "cfg", "msys2-latest.sfx.exe"), "MZ" + "0".repeat(1024));
  const root = join(dir, "msys64");
  const controller = new AbortController();
  const subprocess = scriptedSubprocess((line) => {
    if (line.includes(".sfx.exe")) {
      controller.abort();
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  const report = await planOrInstallMsys2(
    subprocess,
    { mode: "install", targetDir: root, writePath: false, timeoutMs: 5_000, signal: controller.signal },
    process.env,
  );
  const extractStep = stepOf(report, "extract");
  assert.equal(extractStep.status, "failed", extractStep.detail);
  assert.match(extractStep.detail, /已取消/u, extractStep.detail);
  assert.match(report.message, /已取消/u, report.message);
  assert.ok(!/解压失败/u.test(report.message), "取消不是失败：" + report.message);
  // 暂存目录保留着（下次进来再清），什么都没被删。
  assert.ok(existsSync(join(dir, ".dsh-msys2-staging")), "取消路径不该删暂存目录");
  assert.equal(report.config.written, false, "取消后不该写配置");
  rmSync(dir, { recursive: true, force: true });
});

test("A33 包名校验：以 - 开头或含 shell 字符的包名一律拒掉，一条命令都不执行", async () => {
  assert.deepEqual(invalidPackageNames(["mingw-w64-ucrt-x86_64-cmake", "gdb-multiarch"]), []);
  assert.deepEqual(invalidPackageNames(["-y", "a b", "x;rm -rf /"]), ["-y", "a b", "x;rm -rf /"]);
  const dir = tempDir("pkgname");
  const subprocess = scriptedSubprocess(() => ({}));
  const fake = fakeCtx(subprocess, undefined);
  registerEnvInstall(fake.ctx);
  const value = await fake.tool().execute(
    { dryRun: false, confirm: true, targetDir: join(dir, "msys64"), packages: ["-y", "mingw-w64-ucrt-x86_64-cmake; rm -rf /"] },
    { signal: new AbortController().signal },
  );
  assert.equal(value.mode, "report");
  assert.match(value.report.message, /包名不合法/u, value.report.message);
  assert.match(value.report.message, /-y/u, "违规值要点名：" + value.report.message);
  assert.equal(subprocess.calls.length, 0, "非法包名时不能碰任何命令：" + subprocess.calls.join(" | "));
  rmSync(dir, { recursive: true, force: true });
});

test("A21 后台 job 的卡片是「安装中」骨架：mode=install、步骤全 pending、不是计划快照", async () => {
  const dir = tempDir("jobcard");
  const root = makeMsys64(join(dir, "msys64"));
  const subprocess = scriptedSubprocess((line) => {
    if (isPacmanQuery(line)) return { exitCode: 0, stdout: PACKAGES.map((n) => n + " 1.0.0-1").join("\n") + "\n" };
    return { exitCode: 0, stdout: "" };
  });
  let started = null;
  const fake = fakeCtx(subprocess, {
    start(spec) {
      started = spec;
      return "job-card";
    },
  });
  registerEnvInstall(fake.ctx);
  const value = await fake.tool().execute(
    { dryRun: false, confirm: true, targetDir: root, writePath: false },
    { signal: new AbortController().signal },
  );
  assert.equal(value.mode, "job");
  assert.equal(value.jobId, "job-card");
  assert.equal(value.report.mode, "install", "卡片不能还挂着计划模式");
  assert.ok(value.report.steps.length > 0, "步骤要列出来");
  assert.ok(value.report.steps.every((step) => step.status === "pending"), "job 还没跑：步骤全是 pending");
  assert.equal(value.report.config.written, false);
  assert.equal(value.report.verify.tools.length, 0);
  assert.ok(value.report.notes.every((note) => !note.startsWith("这只是计划")), "卡片不能再说「这只是计划」");
  const text = fake.tool().output.render({}, value)[0].text;
  assert.match(text, /安装进行中/u, "抬头要写「安装进行中」，不能是「安装未完成」：" + text.split("\n")[0]);
  assert.match(text, /job-card/u);
  assert.ok(
    (started?.label ?? "").startsWith("stm32_env_install ") && (started?.label ?? "").includes("msys64"),
    "job 的 label 要写清装到哪：" + (started?.label ?? ""),
  );
  rmSync(dir, { recursive: true, force: true });
});

test("A28 配置 CAS：读完之后别人改过 → 重读并重新合并，attempts=2，对方的内容不丢", () => {
  const dir = tempDir("cas");
  const env = process.env;
  const seed = updateToolchainConfig({ cubeMxRoot: "D:/app/STM32CubeMX" }, env);
  assert.equal(seed.ok, true, seed.error);
  const stale = readToolchainConfig(env);
  assert.equal(stale.exists, true);
  // 另一个窗口在这中间写了 packages —— 还顺手把 mtime 推到未来，确保 mtime 真的不同。
  const other = writeToolchainConfig(
    { ...stale.config, packages: ["mingw-w64-ucrt-x86_64-ninja"], updatedAt: stale.config.updatedAt },
    env,
  );
  assert.equal(other.ok, true, other.error);
  utimesSync(stale.path, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
  const written = updateToolchainConfig(
    { msys64: "D:/msys64", binDirs: ["D:/msys64/ucrt64/bin"] },
    env,
    { expect: { mtimeMs: stale.mtimeMs, updatedAt: stale.config.updatedAt } },
  );
  assert.equal(written.ok, true, written.error);
  assert.equal(written.attempts, 2, "冲突后应该重读重写一次");
  assert.deepEqual(written.config.packages, ["mingw-w64-ucrt-x86_64-ninja"], "对方写的 packages 不能被覆盖掉");
  assert.equal(written.config.cubeMxRoot, "D:/app/STM32CubeMX", "原有字段也要保住");
  assert.equal(written.config.msys64, "D:/msys64");
  // 没人动过时不重试。
  const fresh = readToolchainConfig(env);
  const again = updateToolchainConfig(
    { cubeMxRoot: "D:/app/STM32CubeMX" },
    env,
    { expect: { mtimeMs: fresh.mtimeMs, updatedAt: fresh.config.updatedAt } },
  );
  assert.equal(again.ok, true, again.error);
  assert.equal(again.attempts, 1);
  rmSync(dir, { recursive: true, force: true });
});