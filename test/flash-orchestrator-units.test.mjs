// 烧录编排器（2026-11-08 复盘）：interface 实见选择、不匹配自动换、CubeProgrammer 兜底。
// 一切进程走注入假 subprocess；不碰真 USB / 真 openocd / 真 CLI。
// 运行：node --test test/flash-orchestrator-units.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as t } from "node:test";
import { fileURLToPath } from "node:url";

import { runFlash } from "../lib/engine/flash.js";

const FIXTURE_PROJECT = fileURLToPath(new URL("./fixtures/project", import.meta.url));

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), "orch-" + tag + "-"));

/** 复制真夹具工程（build/Debug 有 CMakeCache+elf，能过 resolveElf）；withCfg=false 删掉 openocd.cfg。 */
function makeProject(withCfg) {
  const dir = tmp("proj");
  fs.cpSync(FIXTURE_PROJECT, dir, { recursive: true });
  if (!withCfg) fs.rmSync(path.join(dir, "openocd.cfg"), { force: true });
  return dir;
}

const PNPUTIL_STLINK = [
  "Published name :            oem25.inf",
  "Instance ID:                USB\\VID_0483&PID_3752\\5&abc",
  "Device Description:         ST-Link/ST-LinkDB",
  "Status:                     0x18",
].join("\r\n");
const PNPUTIL_DAPLINK = [
  "Instance ID:                USB\\VID_C251&PID_F001\\DEMO",
  "Device Description:         CMSIS-DAP",
  "Status:                     0x18",
].join("\r\n");

function once(text, exitCode = 1) {
  return {
    done: Promise.resolve({ exitCode, signal: null }),
    collected: {
      stdout: { readFrom: () => ({ text, nextOffset: text.length }) },
      stderr: { readFrom: () => ({ text, nextOffset: text.length }) },
    },
    terminate() {},
    waitForExit: () => Promise.resolve({ exitCode, signal: null }),
  };
}

/** 假 subprocess：pnputil→pnputilText；openocd 第 i 次→openocdLogs[i]（exit 同理）；CLI→cliText。 */
function fakeSpawner({ pnputil = "", openocdLogs = [], openocdExits = [], cliText = "", cliExit = 1 }) {
  const calls = [];
  let oc = 0;
  return {
    calls,
    resolveExecutable: (command) => command,
    spawn(spec) {
      const joined = spec.argv.map(String).join(" ");
      calls.push(joined);
      if (/pnputil/i.test(joined)) return once(pnputil, 0);
      if (/Programmer_CLI/i.test(joined)) return once(cliText, cliExit);
      const text = openocdLogs[Math.min(oc, openocdLogs.length - 1)] ?? "";
      const exit = openocdExits[Math.min(oc, openocdExits.length - 1)] ?? 1;
      oc += 1;
      return once(text, exit);
    },
  };
}

const GOOD = ["** Programming Finished **\n** Verified OK **"];

t("实见 ST-LINK + 工程无 openocd.cfg：兜底 interface 用 stlink（不再硬编码 cmsis-dap）", async () => {
  const fake = fakeSpawner({ pnputil: PNPUTIL_STLINK, openocdLogs: GOOD, openocdExits: [0] });
  const report = await runFlash(fake, { projectDir: makeProject(false), timeoutMs: 10_000 });
  assert.equal(report.ok, true, report.message);
  assert.ok(report.configs.includes("interface/stlink-dap.cfg"), "interface 按实见探针选（ST-LINK 走 dapdirect）：" + report.configs.join(","));
  assert.ok(report.notes.some((n) => n.includes("ST-LINK") && n.includes("探针实见")), report.notes.join(" | "));
});

t("mismatch 自动换 interface 重试：第一次 cmsis-dap 失败、第二次 stlink 成功", async () => {
  const fake = fakeSpawner({
    pnputil: PNPUTIL_DAPLINK,
    openocdLogs: ["Error: unable to find a matching CMSIS-DAP device", ...GOOD],
    openocdExits: [1, 0],
  });
  const report = await runFlash(fake, { projectDir: makeProject(false), timeoutMs: 10_000 });
  assert.equal(report.ok, true, report.message);
  const ocCalls = fake.calls.filter((c) => /openocd/i.test(c) && !/pnputil|Programmer/i.test(c));
  assert.equal(ocCalls.length, 2, "必须恰好重试一次");
  assert.ok(ocCalls[1].includes("interface/stlink-dap.cfg"), "第二次换 stlink-dap：" + ocCalls[1]);
  assert.ok(report.notes.some((n) => n.includes("自动换 interface/stlink-dap.cfg 重试") && n.includes("第 1 次")), report.notes.join(" | "));
});

t("工程自带 openocd.cfg：不插手 interface、不自动重试（手写配置交给 hint 让人改）", async () => {
  const fake = fakeSpawner({ pnputil: PNPUTIL_STLINK, openocdLogs: ["Error: unable to find a matching CMSIS-DAP device"] });
  const report = await runFlash(fake, { projectDir: makeProject(true), timeoutMs: 10_000 });
  assert.equal(report.ok, false);
  assert.equal(report.probeError?.kind, "probe-interface-mismatch");
  const ocCalls = fake.calls.filter((c) => /openocd/i.test(c) && !/pnputil|Programmer/i.test(c));
  assert.equal(ocCalls.length, 1, "手写 cfg 的不匹配不自动改写用户配置：" + ocCalls.join(" ;; ").slice(0, 200));
});

t("ST-LINK + openocd 两条都败 + 本机有 CubeProgrammer：CLI 兜底成功，报告署名后端", async () => {
  const prgBin = tmp("prg");
  fs.writeFileSync(path.join(prgBin, "STM32_Programmer_CLI.exe"), "MZ");
  process.env.STM32_CUBE_PRG_ROOT = prgBin;
  process.env.STM32_NO_DISCOVER = "1";
  try {
    const fake = fakeSpawner({
      pnputil: PNPUTIL_STLINK,
      openocdLogs: [
        "Error: unable to find a matching ST-LINK device",
        "Error: unable to find a matching CMSIS-DAP device",
      ],
      cliText: "     File : demo.elf\nData downloaded successfully\nVerifying ...\nDownload verified successfully\nReset system",
      cliExit: 0,
    });
    const report = await runFlash(fake, { projectDir: makeProject(false), timeoutMs: 10_000 });
    assert.equal(report.ok, true, report.message + " | notes=" + report.notes.join(" | "));
    assert.ok(report.command.includes("STM32_Programmer_CLI"), report.command);
    assert.ok(report.notes.some((n) => n.includes("只认 ST-LINK")), "后端署名要说清支持面：" + report.notes.join(" | "));
    const cliCall = fake.calls.find((c) => /Programmer_CLI/.test(c));
    assert.match(cliCall, /port=SWD/u, "CLI 连接参数：" + cliCall);
    assert.match(cliCall, /-d .*\.elf/u, "CLI 下载参数：" + cliCall);
    assert.match(cliCall, /-v/u, "CLI 要带校验");
    assert.match(cliCall, /-rst/u, "CLI 要带复位");
  } finally {
    delete process.env.STM32_CUBE_PRG_ROOT;
    delete process.env.STM32_NO_DISCOVER;
  }
});

t("DAPLink + openocd 全败：绝不派 CLI 去撞 ST-LINK 墙", async () => {
  const prgBin = tmp("prg2");
  fs.writeFileSync(path.join(prgBin, "STM32_Programmer_CLI.exe"), "MZ");
  process.env.STM32_CUBE_PRG_ROOT = prgBin;
  process.env.STM32_NO_DISCOVER = "1";
  try {
    const fake = fakeSpawner({
      pnputil: PNPUTIL_DAPLINK,
      openocdLogs: ["Error: unable to find a matching CMSIS-DAP device", "Error: no device found"],
    });
    const report = await runFlash(fake, { projectDir: makeProject(false), timeoutMs: 10_000 });
    assert.equal(report.ok, false);
    assert.equal(fake.calls.some((c) => /Programmer_CLI/.test(c)), false, "实见 DAP 类探针不能走 CubeProgrammer");
  } finally {
    delete process.env.STM32_CUBE_PRG_ROOT;
    delete process.env.STM32_NO_DISCOVER;
  }
});

t("swd-locked 不做无谓兜底：锁片换后端也没用", async () => {
  const fake = fakeSpawner({
    pnputil: PNPUTIL_STLINK,
    openocdLogs: ["Error: Error connecting DP: cannot read IDR"],
  });
  const report = await runFlash(fake, { projectDir: makeProject(false), timeoutMs: 10_000 });
  assert.equal(report.probeError?.kind, "swd-locked");
  assert.equal(fake.calls.some((c) => /Programmer_CLI/.test(c)), false, "换后端解决不了锁片");
  const ocCalls = fake.calls.filter((c) => /openocd/i.test(c) && !/pnputil|Programmer/i.test(c));
  assert.equal(ocCalls.length, 1, "锁片只试一次：" + ocCalls.length);
});

t("显式 interfaceConfig 参数：尊重用户指定，不探测 USB（省一次 pnputil）", async () => {
  const fake = fakeSpawner({ openocdLogs: GOOD, openocdExits: [0] });
  const report = await runFlash(fake, {
    projectDir: makeProject(false),
    interfaceConfig: "interface/stlink.cfg",
    timeoutMs: 10_000,
  });
  assert.equal(report.ok, true, report.message);
  assert.equal(fake.calls.some((c) => /pnputil/i.test(c)), false, "给了显式 interface 就不该再探 USB");
});

t("连续两次烧录不共享探针结论：第二颗实见 DAPLink 就按 DAPLink 走", async () => {
  // 回归：第一版把实见结果缓存在模块里 60 s，CI 上 2 条用例正是这么挂的——
  // 同进程先烧 ST-LINK 再烧 DAPLink，第二颗芯片会拿到第一颗的结论（重试方向还算反）。
  const first = fakeSpawner({ pnputil: PNPUTIL_STLINK, openocdLogs: GOOD, openocdExits: [0] });
  const r1 = await runFlash(first, { projectDir: makeProject(false), timeoutMs: 10_000 });
  assert.ok(r1.configs.includes("interface/stlink-dap.cfg"), "第一次按 ST-LINK（dapdirect）：" + r1.configs.join(","));
  const second = fakeSpawner({ pnputil: PNPUTIL_DAPLINK, openocdLogs: GOOD, openocdExits: [0] });
  const r2 = await runFlash(second, { projectDir: makeProject(false), timeoutMs: 10_000 });
  assert.ok(second.calls.some((c) => /pnputil/i.test(c)), "第二次必须重新探 USB，不能吃上一次的缓存");
  assert.ok(r2.configs.includes("interface/cmsis-dap.cfg"), "第二次按 DAPLink：" + r2.configs.join(","));
});

// ---- backend 三态（B 方案）：auto / openocd / cubeprogrammer ----

function withCli(fn) {
  const prgBin = tmp("prg");
  fs.writeFileSync(path.join(prgBin, "STM32_Programmer_CLI.exe"), "MZ");
  process.env.STM32_CUBE_PRG_ROOT = prgBin;
  process.env.STM32_NO_DISCOVER = "1";
  return Promise.resolve().then(fn).finally(() => {
    delete process.env.STM32_CUBE_PRG_ROOT;
    delete process.env.STM32_NO_DISCOVER;
  });
}

const CLI_GOOD = "     File : demo.elf\nData downloaded successfully\nVerifying ...\nDownload verified successfully\nReset system";

t("backend=cubeprogrammer：ST-LINK 直接走 CLI，不启 openocd", async () => {
  await withCli(async () => {
    const fake = fakeSpawner({ pnputil: PNPUTIL_STLINK, cliText: CLI_GOOD, cliExit: 0 });
    const report = await runFlash(fake, { projectDir: makeProject(false), backend: "cubeprogrammer", timeoutMs: 10_000 });
    assert.equal(report.ok, true, report.message + " | " + report.errors.join(" / "));
    assert.equal(report.configs.length, 0, "CLI 后端不产生 openocd 配置");
    assert.ok(fake.calls.some((c) => /Programmer_CLI/.test(c)), "必须调 CLI：" + fake.calls.join(" ;; "));
    assert.ok(!fake.calls.some((c) => /openocd/i.test(c) && !/pnputil|Programmer/i.test(c)), "不该起 openocd");
    assert.ok(report.notes.some((n) => /CubeProgrammer/.test(n)), report.notes.join(" | "));
  });
});

t("backend=cubeprogrammer 但没装 CLI：报错里给 ST 官网下载链接（用户 2026-11-08 要求提示下载）", async () => {
  process.env.STM32_NO_DISCOVER = "1";
  delete process.env.STM32_CUBE_PRG_ROOT;
  try {
    const fake = fakeSpawner({ pnputil: PNPUTIL_STLINK });
    const report = await runFlash(fake, { projectDir: makeProject(false), backend: "cubeprogrammer", timeoutMs: 10_000 });
    assert.equal(report.ok, false);
    assert.match(report.message, /stm32cubeprog\.html/u, "缺 CLI 要指路下载：" + report.message);
    assert.ok(!fake.calls.some((c) => /Programmer_CLI/.test(c)), "没 CLI 就不该调：" + fake.calls.join(" ;; "));
  } finally {
    delete process.env.STM32_NO_DISCOVER;
  }
});

t("backend=cubeprogrammer + DAPLink：直接拒绝，不派 CLI 去撞墙", async () => {
  await withCli(async () => {
    const fake = fakeSpawner({ pnputil: PNPUTIL_DAPLINK, cliText: CLI_GOOD, cliExit: 0 });
    const report = await runFlash(fake, { projectDir: makeProject(false), backend: "cubeprogrammer", timeoutMs: 10_000 });
    assert.equal(report.ok, false);
    assert.ok(/只认 ST-LINK/.test(report.message), report.message);
    assert.ok(!fake.calls.some((c) => /Programmer_CLI/.test(c)), "不该调 CLI：" + fake.calls.join(" ;; "));
  });
});

t("backend=openocd：ST-LINK 两败也不派 CLI（用户明确只要 openocd）", async () => {
  await withCli(async () => {
    const fake = fakeSpawner({
      pnputil: PNPUTIL_STLINK,
      openocdLogs: ["Error: unable to find a matching ST-LINK device", "Error: unable to find a matching CMSIS-DAP device"],
      cliText: CLI_GOOD,
      cliExit: 0,
    });
    const report = await runFlash(fake, { projectDir: makeProject(false), backend: "openocd", timeoutMs: 10_000 });
    assert.equal(report.ok, false);
    assert.ok(!fake.calls.some((c) => /Programmer_CLI/.test(c)), "openocd 后端不该调 CLI：" + fake.calls.join(" ;; "));
  });
});

// ---- 第三类探针：J-Link（用户 2026-11-08 要求 ST-Link / DAPLink / J-Link 都能用）----

const PNPUTIL_JLINK = [
  "Instance ID:                USB\\VID_1366&PID_1051\\000000123456",
  "Device Description:         J-Link",
  "Status:                     0x18",
].join("\r\n");

t("实见 J-Link：interface 用 jlink.cfg，且必须在 interface 与 target 之间补 transport select swd", async () => {
  // openocd 0.12 的 interface/jlink.cfg 只有 adapter driver jlink，默认选 jtag；
  // 不给 "transport select swd" 会连到 jtag 上然后报 No J-Link device found（实测）。
  const fake = fakeSpawner({ pnputil: PNPUTIL_JLINK, openocdLogs: GOOD, openocdExits: [0] });
  const report = await runFlash(fake, { projectDir: makeProject(false), timeoutMs: 10_000 });
  assert.equal(report.ok, true, report.message + " | " + report.errors.join(" / "));
  assert.ok(report.configs.includes("interface/jlink.cfg"), "按实见探针选 jlink：" + report.configs.join(","));
  const ocCall = fake.calls.find((c) => /openocd/i.test(c) && !/pnputil|Programmer/i.test(c)) ?? "";
  const iIface = ocCall.indexOf("interface/jlink.cfg");
  const iTransport = ocCall.indexOf("transport select swd");
  const iTarget = ocCall.indexOf("target/");
  assert.ok(iIface >= 0 && iTransport > iIface, "transport 必须在 interface 之后：" + ocCall);
  assert.ok(iTarget > iTransport, "transport 必须在 target 之前：" + ocCall);
  assert.ok(report.notes.some((n) => /J-Link/u.test(n)), "notes 要说清用的是 J-Link：" + report.notes.join(" | "));
});

t("实见 J-Link 且 openocd 失败：不派 CubeProgrammer（CLI 只认 ST-LINK），并说明缺 transport 的可能", async () => {
  await withCli(async () => {
    const fake = fakeSpawner({ pnputil: PNPUTIL_JLINK, openocdLogs: ["Error: No J-Link device found"], cliText: CLI_GOOD, cliExit: 0 });
    const report = await runFlash(fake, { projectDir: makeProject(false), timeoutMs: 10_000 });
    assert.equal(report.ok, false);
    assert.equal(fake.calls.some((c) => /Programmer_CLI/.test(c)), false, "J-Link 没有 CLI 兜底腿：" + fake.calls.join(" ;; "));
    assert.ok(report.notes.some((n) => /transport select swd/u.test(n)), report.notes.join(" | "));
  });
});
