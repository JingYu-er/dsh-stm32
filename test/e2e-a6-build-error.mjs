// A6：往 USER CODE 里注入语法错 → build 必须返回 file:line:col，而不是一句"编译失败"。
// 跑法：node test\e2e-a6-build-error.mjs
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runBuild } from "../lib/engine/build.js";
import { patchUserCode } from "../lib/engine/code-patch.js";
import { freshCopy, log, makeSubprocess } from "./harness.mjs";
import { e2eProject, e2eWorkDir } from "./fixtures.mjs";

const SOURCE = e2eProject();
const TARGET = e2eWorkDir("a6");
const BIN = "D:/app/msys64/ucrt64/bin";
const subprocess = makeSubprocess();

freshCopy(SOURCE, TARGET);
// 先确保有一份能编译的基线和已配置的构建目录（复制过来就有 CMakeCache）。
const baseline = await runBuild(subprocess, { projectDir: TARGET, binDirs: [BIN] });
log("基线 build：", baseline.ok, baseline.message);
assert.equal(baseline.ok, true, "基线必须能编译：" + baseline.logTail);

const broken = patchUserCode({
  projectDir: TARGET,
  file: "Core/Src/main.c",
  block: "3",
  mode: "append",
  code: "    int bad = ;",
});
assert.equal(broken.ok, true, "注入语法错失败：" + broken.message);

const failed = await runBuild(subprocess, { projectDir: TARGET, binDirs: [BIN] });
log("坏代码 build：", failed.ok, failed.message);
log("errors[0]：", failed.errors[0] ?? "(空)");
assert.equal(failed.ok, false, "语法错必须让 build 失败");
assert.ok(failed.errors.length > 0, "必须至少有一条 errors");

// A6 的判据：file:line:col
const located = failed.errors.find((line) => /main\.c:\d+:\d+/u.test(line));
assert.ok(located !== undefined, "错误行里必须有 main.c:<line>:<col>，实际：\n" + failed.errors.join("\n"));
log("定位到了：", located);
assert.match(located, /main\.c:(\d+):(\d+)/u);
assert.ok(/expected expression|error/u.test(located), "应是编译器原话，而不是我们编的：" + located);

// 改回去以后必须能重新编译（不留脏 .obj）
const restored = readFileSync(join(TARGET, "Core/Src/main.c"), "utf8").replace("    int bad = ;\r\n", "");
writeFileSync(join(TARGET, "Core/Src/main.c"), restored);
const fixed = await runBuild(subprocess, { projectDir: TARGET, binDirs: [BIN] });
log("修好后再 build：", fixed.ok, fixed.message);
assert.equal(fixed.ok, true, "改回去后必须能编译：" + fixed.logTail);

log("A6 PASS：语法错被定位到 " + located.trim());
