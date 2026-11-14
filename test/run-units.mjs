// 顺序跑全部离线套件并汇总用例数。
//
// 各套件的输出格式不统一，这里认四种结尾：
//   node:test（spec reporter）                        → "\u2139 pass 16" / "\u2139 fail 0"
//   node:test（tap reporter，非 TTY 时 node 20 的默认）→ "# pass 16" / "# fail 0"
//   自写断言                                          → "tests 9 / fail 0"
//   commands                                          → "commands-units: 6 pass / 0 fail"
// 解析不到用例数时不再默默报 0（之前 TOTAL 只算出 46，实际 80），而是标红并贴出该套件结尾几行。
// 套件退出码非 0 一律算失败，即使它自己打印了 fail=0。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// lib/ 是入库的编译产物，套件 import 的是 lib/ 而不是 src/。src 比 lib 新 = 正在测上一版代码，
// 之前就吃过一次亏（报 898 pass，实际跑的是改动前的 lib）。这里只警告不失败：CI 先 build 再测，
// 本地偶尔只改 src 跑一遍也不该被拦死，但绝不能让「测的不是这次改动」静默通过。
{
  const root = fileURLToPath(new URL("..", import.meta.url));
  const newest = (dir) => {
    let best = 0;
    const walk = (d) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.name.endsWith(".ts") || ent.name.endsWith(".js")) best = Math.max(best, fs.statSync(p).mtimeMs);
      }
    };
    if (fs.existsSync(dir)) walk(dir);
    return best;
  };
  const srcNew = newest(path.join(root, "src"));
  const libOld = newest(path.join(root, "lib"));
  if (srcNew > libOld + 1000) {
    console.warn("[warn] src/ 比 lib/ 新：套件 import 的是 lib/，当前结果不代表 src 的最新改动。先 npm run build 再跑。");
  }
}

const suites = [
  "build-units.test.mjs",
  "cache-units.test.mjs",
  "event-bus-units.test.mjs",
  "progress-units.test.mjs",
  "channel-tap-units.test.mjs",
    "pinout-units.test.mjs",
    "schematic-units.test.mjs",
    "ecad-units.test.mjs",
  "pdf-units.test.mjs",
    "project-layout-units.test.mjs",
    "session-context-units.test.mjs",
    "pinout-render-units.test.mjs",
    "workspace-memo-units.test.mjs",
    "project-conf-units.test.mjs",
    "clocks-units.test.mjs",
    "fault-hints-units.test.mjs",
    "artifacts-units.test.mjs",
    "ioc-diff-units.test.mjs",
    "ioc-apply-tool-units.test.mjs",
    "breakpoint-hits-units.test.mjs",
    "watch-recorder-units.test.mjs",
    "watch-admin-units.test.mjs",
    "interrupts-units.test.mjs",
    "probe-info-units.test.mjs",
    "ioc-sync-units.test.mjs",
    "source-slice-units.test.mjs",
  "client-debug-units.test.mjs",
  "cache-gc-units.test.mjs",
  "assets-units.test.mjs",
  "probe-error-units.test.mjs",
  "probe-session-units.test.mjs",
  "breakpoints-units.test.mjs",
"family-units.test.mjs",
  "family-facts-units.test.mjs",
  "facts-units.test.mjs",
  "facts-acquire-units.test.mjs",
  "rm-sources-units.test.mjs",
  "rm-extract-units.test.mjs",
  "rm-topics-units.test.mjs",
  "ensure-facts-units.test.mjs",
  "generation-risk-units.test.mjs",
  "flash-orchestrator-units.test.mjs",
  "db-presets-units.test.mjs",
  "rtt-units.test.mjs",
  "svd-units.test.mjs",
  "stm32f1-units.test.mjs",
  "hal-route-units.test.mjs",
  "clock-units.test.mjs",
  "clock-db-units.test.mjs",
  "clock-pllmn-units.test.mjs",
  "clock-direct-units.test.mjs",
  "clock-derived-units.test.mjs",
  "cubemx-guard-units.test.mjs",
  "doctor-chip-units.test.mjs",
  "cmake-sources-units.test.mjs",
  "commands-units.test.mjs",
  "doctor-regs-units.mjs",
  "engine-units.test.mjs",
  "export-units.test.mjs",
  "firmware-units.test.mjs",
  "tar-units.test.mjs",
  "flash-units.test.mjs",
  "generate-cache-units.test.mjs",
  "ioc-plan-units.test.mjs",
  "schema-subset-units.test.mjs",
  "ioc-verify-units.test.mjs",
  "ioc-schema-units.test.mjs",
  "ioc-rules-units.test.mjs",
  "cubemx-db-units.test.mjs",
  "gdb-mi-units.test.mjs",
  "install-units.test.mjs",
  "ioc-units.test.mjs",
  "route-plan-units.test.mjs",
  "scaffold-patch-units.test.mjs",
  "search-roots-units.test.mjs",
  "serial-units.test.mjs",
  "download-units.test.mjs",
  "session-units.test.mjs",
  "text-encoding-units.test.mjs",
  "thirdparty-units.test.mjs",
  "tool-contract-units.test.mjs",
  "toolchain-units.test.mjs",
  "vscode-units.test.mjs",
  "watch-units.test.mjs",
  "web-api-units.test.mjs",
  "xcube-units.test.mjs",
  "schema-guard.mjs",
];

/** @returns {{pass: number, fail: number, fmt: string} | null} */
function parseCounts(out) {
  const spec = /\u2139\s*pass\s+(\d+)[\s\S]*?\u2139\s*fail\s+(\d+)/u.exec(out);
  if (spec !== null) return { pass: Number(spec[1]), fail: Number(spec[2]), fmt: "spec" };
  // TAP 汇总：# tests N / # pass N / # fail M（非 TTY 下 node 20 的默认 reporter）
  const tap = /^#\s*pass\s+(\d+)[\s\S]*?^#\s*fail\s+(\d+)/mu.exec(out);
  if (tap !== null) return { pass: Number(tap[1]), fail: Number(tap[2]), fmt: "tap" };
  const testsLine = /tests\s+(\d+)\s*\/\s*fail\s+(\d+)/u.exec(out);
  if (testsLine !== null) return { pass: Number(testsLine[1]), fail: Number(testsLine[2]), fmt: "custom" };
  const inline = /(\d+)\s+pass\s*\/\s*(\d+)\s+fail/u.exec(out);
  if (inline !== null) return { pass: Number(inline[1]), fail: Number(inline[2]), fmt: "inline" };
  return null;
}

function tail(out, n) {
  const lines = out.split(/\r?\n/u).filter((line) => line.trim() !== "");
  return lines.slice(-n).join("\n    ");
}

// 单测不许把「最近用过的工程」写进开发机真实的 ~/.dsh-stm32：resolveProjectDir 每跑一次都会记一笔，
// 于是 web-api 的「缺参数回 400」用例会被本机备忘变成 200。整轮换到临时根目录。
const memoHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-stm32-units-home-"));

/**
 * 从套件输出里挑出失败用例的名字与断言摘要。
 *
 * 只贴结尾不够：TAP 里失败用例往往出现在中段，结尾只有汇总，于是"哪条红了"要靠重跑猜。
 * 两种 reporter 都认：TAP 的 `not ok N - 名字`，spec 的 `✖ 名字`。
 */
function failures(out) {
  // 去掉颜色转义：带颜色的日志里行首是 \u001b[31m，直接 ^not ok 会全部漏掉。
  const text = out.replace(/\u001b\[[0-9;]*m/gu, "");
  const names = [];
  const tap = /^not ok \d+ - (.+)$/gmu;
  let match = tap.exec(text);
  while (match !== null) {
    const name = match[1].trim();
    if (name !== "") names.push(name);
    match = tap.exec(text);
  }
  if (names.length === 0) {
    const spec = /^\s*\u2716\s+(.+?)(?:\s+\(\d+(?:\.\d+)?ms\))?$/gmu;
    match = spec.exec(text);
    while (match !== null) {
      const name = match[1].trim();
      if (name !== "" && !names.includes(name)) names.push(name);
      match = spec.exec(text);
    }
  }
  if (names.length === 0) {
    // 两种 reporter 都没认出来时，至少把带失败标记的原始行贴出来，不要只剩「失败用例：」这个空标题。
    const loose = /(?:^|\s)(?:not ok|\u2716|\u2717|AssertionError|cancelled)[^\n]*/gmu;
    match = loose.exec(text);
    while (match !== null && names.length < 10) {
      names.push(match[0].trim().slice(0, 180));
      match = loose.exec(text);
    }
  }
  const detail = [];
  const assertLine = /^\s{2,}(error|expected|actual|operator|code):\s*(.+)$/gmu;
  match = assertLine.exec(text);
  while (match !== null && detail.length < 8) {
    detail.push(match[1] + ": " + match[2].slice(0, 200));
    match = assertLine.exec(text);
  }
  return { names: names.slice(0, 10), detail: detail };
}

let totalPass = 0;
let totalFail = 0;
let unparsed = 0;
let crashed = 0;
for (const name of suites) {
  let out = "";
  let code = 0;
  try {
    out = execFileSync(process.execPath, ["test/" + name], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      // 别再继承 stderr：子进程（reg.exe 之类）的噪音会直接糊到终端上，还打乱套件输出。
      stdio: ["ignore", "pipe", "pipe"],
      // 单测不许受开发机上真实存在的 ~/.dsh-stm32/config.json 影响（装了工具链的机器上
      // search-roots 的"默认候选"断言会因此变红）；toolchain-units 自己会清掉这个变量再测配置读取。
      env: { ...process.env, DSH_STM32_NO_CONFIG: "1", DSH_STM32_HOME: memoHome },
    });
  } catch (error) {
    out = String(error.stdout ?? "") + String(error.stderr ?? "");
    code = error.status ?? -1;
  }
  const counts = parseCounts(out);
  if (counts === null) {
    unparsed += 1;
    console.log(name + " exit=" + code + " 用例数无法解析  <<< 需检查，该套件结尾：\n    " + tail(out, 6));
    continue;
  }
  totalPass += counts.pass;
  totalFail += counts.fail;
  if (code !== 0 && counts.fail === 0) crashed += 1;
  const bad = counts.fail > 0 || code !== 0;
  console.log(name + " exit=" + code + " (" + counts.fmt + ") pass=" + counts.pass + " fail=" + counts.fail + (bad ? "  <<< 需检查" : ""));
  // 失败时先给用例名与断言摘要，再贴结尾：TAP 的失败用例常在中段，只贴结尾等于没线索。
  if (bad) {
    const failed = failures(out);
    if (failed.names.length > 0) {
      console.log("    失败用例（" + name + "）：");
      for (const name of failed.names) console.log("      - " + name);
    }
    if (failed.detail.length > 0) {
      console.log("    断言：");
      for (const line of failed.detail) console.log("      " + line);
    }
    if (failed.names.length === 0) console.log("    " + tail(out, 30));
  }
}
console.log("TOTAL pass=" + totalPass + " fail=" + totalFail + (unparsed > 0 ? "（" + String(unparsed) + " 个套件未统计）" : "") + (crashed > 0 ? "（" + String(crashed) + " 个套件退出码非 0 但自报 0 失败）" : ""));
if (totalFail > 0 || unparsed > 0 || crashed > 0) process.exitCode = 1;
