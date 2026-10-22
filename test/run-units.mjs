// 顺序跑全部离线套件并汇总用例数。
//
// 各套件的历史输出格式不统一，这里认三种结尾：
//   node:test  →  "ℹ pass 16" / "ℹ fail 0"
//   自写断言   →  "tests 9 / fail 0"
//   commands   →  "commands-units: 6 pass / 0 fail"
// 解析不到用例数时不再默默报 0（之前 TOTAL 只算出 46，实际 80），而是标红提示改输出格式。
import { execFileSync } from "node:child_process";

const suites = [
  "build-units.test.mjs",
  "commands-units.test.mjs",
  "doctor-regs-units.mjs",
  "engine-units.test.mjs",
  "flash-units.test.mjs",
  "ioc-plan-units.test.mjs",
  "ioc-units.test.mjs",
  "scaffold-patch-units.test.mjs",
  "session-units.test.mjs",
  "schema-guard.mjs",
];

/** @returns {{pass: number, fail: number} | null} */
function parseCounts(out) {
  const nodeTest = /\u2139\s*pass\s+(\d+)[\s\S]*?\u2139\s*fail\s+(\d+)/u.exec(out);
  if (nodeTest !== null) return { pass: Number(nodeTest[1]), fail: Number(nodeTest[2]) };
  const testsLine = /tests\s+(\d+)\s*\/\s*fail\s+(\d+)/u.exec(out);
  if (testsLine !== null) return { pass: Number(testsLine[1]), fail: Number(testsLine[2]) };
  const inline = /(\d+)\s+pass\s*\/\s*(\d+)\s+fail/u.exec(out);
  if (inline !== null) return { pass: Number(inline[1]), fail: Number(inline[2]) };
  return null;
}

let totalPass = 0;
let totalFail = 0;
let unparsed = 0;
for (const name of suites) {
  let out = "";
  let code = 0;
  try {
    out = execFileSync(process.execPath, ["test/" + name], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    out = String(error.stdout ?? "") + String(error.stderr ?? "");
    code = error.status ?? -1;
  }
  const counts = parseCounts(out);
  if (counts === null) {
    unparsed += 1;
    console.log(name + " exit=" + code + " 用例数无法解析（请让该套件在结尾打印 tests N / fail M）  <<< 需检查");
    continue;
  }
  totalPass += counts.pass;
  totalFail += counts.fail;
  const bad = counts.fail > 0 || code !== 0;
  console.log(name + " exit=" + code + " pass=" + counts.pass + " fail=" + counts.fail + (bad ? "  <<< 需检查" : ""));
}
console.log("TOTAL pass=" + totalPass + " fail=" + totalFail + (unparsed > 0 ? "（" + String(unparsed) + " 个套件未统计）" : ""));
if (totalFail > 0 || unparsed > 0) process.exitCode = 1;
