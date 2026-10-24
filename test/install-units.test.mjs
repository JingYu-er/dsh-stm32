// 为什么要有这个套件：真装机上暴露的两个问题都在这块逻辑里——
// （1）pacman -S 对已装的包不是"跳过"而是"顺手升级"，插件在第 4 步把用户整套 mingw 工具链
//     升一个大版本是不能接受的副作用（而且老 MSYS2 上 -Sy + 局部 -S 会因局部升级解不开依赖而失败）；
// （2）那次失败后，job 明明自检 5 个组件都能跑，却仍然报"安装未完成"，用户看到的是假坏消息。
// 这里用"脚本化的假 subprocess"把这两种局面钉死，不碰真磁盘、不跑真 pacman。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planOrInstallMsys2, parsePacmanQuery } from "../lib/engine/msys2-install.js";
import { resetToolchainConfigCache } from "../lib/data/toolchain-config.js";
import { registerEnvInstall } from "../lib/tools/env-install.js";

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
    if (line.includes("pacman -Q")) {
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
    if (line.includes("pacman -Q")) return { exitCode: 1, stdout: "" };
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
    if (line.includes("pacman -Q")) return { exitCode: 1, stdout: "" };
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
    line.includes("pacman -Q")
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
test("计划里的 pacman 步骤说的是真会跑的事（先查状态，不无条件 -Sy 升级）", async () => {
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
  assert.match(pacman.detail, /跳过/u);
  assert.doesNotMatch(pacman.detail, /-Sy --noconfirm &&/u, "不能再向用户预告一条无条件 -Sy + -S 的命令");
  // 计划模式只读一次注册表里的 PATH 用来预告「会不会重复写」，绝不跑 pacman（那是安装才做的事）。
  assert.deepEqual(
    subprocess.calls.filter((line) => /pacman/iu.test(line)),
    [],
    "计划模式不该跑任何 pacman 命令",
  );
  rmSync(dir, { recursive: true, force: true });
});
