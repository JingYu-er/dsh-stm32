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

const suites = [
  "build-units.test.mjs",
  "cache-units.test.mjs",
  "commands-units.test.mjs",
  "doctor-regs-units.mjs",
  "engine-units.test.mjs",
  "export-units.test.mjs",
  "firmware-units.test.mjs",
  "flash-units.test.mjs",
  "generate-cache-units.test.mjs",
  "ioc-plan-units.test.mjs",
  "install-units.test.mjs",
  "ioc-units.test.mjs",
  "route-plan-units.test.mjs",
  "scaffold-patch-units.test.mjs",
  "search-roots-units.test.mjs",
  "session-units.test.mjs",
  "text-encoding-units.test.mjs",
  "thirdparty-units.test.mjs",
  "tool-contract-units.test.mjs",
  "toolchain-units.test.mjs",
  "vscode-units.test.mjs",
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
      env: { ...process.env, DSH_STM32_NO_CONFIG: "1" },
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
}
console.log("TOTAL pass=" + totalPass + " fail=" + totalFail + (unparsed > 0 ? "（" + String(unparsed) + " 个套件未统计）" : "") + (crashed > 0 ? "（" + String(crashed) + " 个套件退出码非 0 但自报 0 失败）" : ""));
if (totalFail > 0 || unparsed > 0 || crashed > 0) process.exitCode = 1;
