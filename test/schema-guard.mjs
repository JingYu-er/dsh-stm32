// 宿主输出契约守卫：离线复现"工具返回值的形状与 output schema 不一致会被宿主拒收"这类 bug。
//
// 背景：dsh 宿主在 execute 返回后按 output.schema 校验。规则比 asar 里那个宽松的
// validateJsonSchemaValue 严得多：additionalProperties:false 必须严格遵守，
// 声明为 primitive/object 的字段不接受 null（也不需要 null 表示"没有"）。
// 之前 stm32_flash 少了 args 声明、stm32_build 用 null 顶替 exitCode/elf，
// 都是"副作用已经发生、调用却报 ToolCallError"。除 stm32_env_probe 外，本测试只走失败早退路径
// （不 spawn 进程）；env_probe 的成功形状用一个假 subprocess 喂版本号（也不起进程）。
// 覆盖范围是全部 19 个工具 + 6 条斜杠命令里的工具部分；真宿主里的成功路径仍要靠 e2e 复验。
//
// 运行：node test/schema-guard.mjs（需先 npm run build）
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { FIXTURE_PROJECT, e2eWorkDir } from "./fixtures.mjs";

import { runBuild } from "../lib/engine/build.js";
import { runDebugRun } from "../lib/engine/debug.js";
import { runDoctor } from "../lib/engine/doctor.js";
import { runFlash } from "../lib/engine/flash.js";
import { runGenerate } from "../lib/engine/generate.js";
import { runRegsRead } from "../lib/engine/regs.js";
import { outputSchema as buildSchema } from "../lib/tools/build.js";
import { registerDebugSession } from "../lib/tools/debug-session.js";
import { evalOutputSchema as debugEvalSchema, outputSchema as debugSessionSchema, stopOutputSchema as debugStopSchema } from "../lib/tools/debug-session.js";
import { registerIocApply } from "../lib/tools/ioc-apply.js";
import { outputSchema as iocApplySchema } from "../lib/tools/ioc-apply.js";
import { registerIocPlan } from "../lib/tools/ioc-plan.js";
import { outputSchema as iocPlanSchema } from "../lib/tools/ioc-plan.js";
import { outputSchema as debugSchema } from "../lib/tools/debug.js";
import { registerCodePatch } from "../lib/tools/code-patch.js";
import { outputSchema as codePatchSchema } from "../lib/tools/code-patch.js";
import { outputSchema as doctorSchema } from "../lib/tools/doctor.js";
import { registerEnvInstall } from "../lib/tools/env-install.js";
import { outputSchema as envInstallSchema } from "../lib/tools/env-install.js";
import { registerBuild } from "../lib/tools/build.js";
import { registerEnvProbe } from "../lib/tools/env-probe.js";
import { outputSchema as envProbeSchema } from "../lib/tools/env-probe.js";
import { registerIocInspect } from "../lib/tools/ioc-inspect.js";
import { outputSchema as iocInspectSchema } from "../lib/tools/ioc-inspect.js";
import { outputSchema as flashSchema } from "../lib/tools/flash.js";
import { outputSchema as generateSchema } from "../lib/tools/generate.js";
import { registerProjectCreate } from "../lib/tools/project-create.js";
import { outputSchema as projectCreateSchema } from "../lib/tools/project-create.js";
import { registerRoutePlan } from "../lib/tools/route-plan.js";
import { outputSchema as routePlanSchema } from "../lib/tools/route-plan.js";
import { registerCache } from "../lib/tools/cache.js";
import { outputSchema as cacheSchema } from "../lib/tools/cache.js";
import { registerFirmwareInstall } from "../lib/tools/firmware-install.js";
import { outputSchema as firmwareInstallSchema } from "../lib/tools/firmware-install.js";
import { outputSchema as regsSchema } from "../lib/tools/regs.js";

const MISSING_DIR = "D:/__dsh_stm32_missing_project__";

// 任何一次 spawn 都算测试写错：本测试只验证早退路径的报告形状。
const forbiddenSubprocess = {
  resolveExecutable: (command) => command,
  spawn: () => {
    throw new Error("schema-guard 不应启动任何进程");
  },
};

/** 按 schema 检查 value；返回问题列表（空 = 通过）。 */
function check(schema, value, path = "value", problems = []) {
  if (schema === undefined) return problems;
  if (Array.isArray(schema.oneOf)) {
    for (const branch of schema.oneOf) {
      if (check(branch, value, path, []).length === 0) return problems;
    }
    problems.push(path + " 不匹配任何 oneOf 分支");
    return problems;
  }
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) {
      problems.push(path + " 不在 enum [" + schema.enum.join(",") + "] 里（实际 " + JSON.stringify(value) + "）");
    }
    return problems;
  }
  if (value === undefined) {
    problems.push(path + " 是 undefined（JSON 序列化会丢掉，宿主 required 时会失败）");
    return problems;
  }
  if (value === null) {
    problems.push(path + " 是 null（宿主不接受 null 顶替 " + String(schema.type ?? "声明类型") + "）");
    return problems;
  }
  const type = schema.type;
  if (type === "object") {
    if (typeof value !== "object" || Array.isArray(value)) {
      problems.push(path + " 应为 object（实际 " + typeof value + "）");
      return problems;
    }
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) problems.push(path + "." + key + " 缺失（schema required）");
    }
    for (const [key, item] of Object.entries(value)) {
      if (!Object.prototype.hasOwnProperty.call(props, key)) {
        problems.push(path + "." + key + " 未在 schema 里声明（宿主会按 additionalProperties:false 拒收）");
        continue;
      }
      check(props[key], item, path + "." + key, problems);
    }
    return problems;
  }
  if (type === "array") {
    if (!Array.isArray(value)) {
      problems.push(path + " 应为 array（实际 " + typeof value + "）");
      return problems;
    }
    value.forEach((item, index) => check(schema.items, item, path + "[" + String(index) + "]", problems));
    return problems;
  }
  if (type === "string" && typeof value !== "string") problems.push(path + " 应为 string（实际 " + typeof value + "）");
  if (type === "number" && (typeof value !== "number" || Number.isNaN(value))) problems.push(path + " 应为 number（实际 " + typeof value + "）");
  if (type === "integer" && !Number.isInteger(value)) problems.push(path + " 应为 integer（实际 " + String(value) + "）");
  if (type === "boolean" && typeof value !== "boolean") problems.push(path + " 应为 boolean（实际 " + typeof value + "）");
  return problems;
}

function reportProblems(label, schema, value) {
  const problems = check(schema, value);
  if (problems.length > 0) {
    assert.fail(label + " 的输出不符合宿主契约：\n  - " + problems.join("\n  - "));
  }
  return value;
}

test("stm32_build 失败报告符合 output schema（不出现 null / 未声明字段）", () => {
  return runBuild(forbiddenSubprocess, { projectDir: MISSING_DIR, timeoutMs: 5000 }).then((report) => {
    reportProblems("stm32_build", buildSchema, { mode: "report", jobId: "", message: report.message, report });
    assert.equal(report.ok, false);
  });
});

test("stm32_flash 失败报告含 args 且符合 output schema", () => {
  return runFlash(forbiddenSubprocess, { projectDir: MISSING_DIR, timeoutMs: 5000 }).then((report) => {
    reportProblems("stm32_flash", flashSchema, { message: report.message, report });
    assert.deepEqual(report.args, []);
    assert.equal(report.ok, false);
  });
});

test("stm32_flash 失败报告带 errorCode 时仍符合 output schema（2d 回归）", async () => {
  // 本机 smoke 里踩到的真缺陷：reportSchema 漏声明 errorCode（additionalProperties:false），
  // 成功路径 errorCode 缺省所以测不出来；一旦失败带码，宿主直接判「工具返回了非法输出」。
  const failLog = [
    "Open On-Chip Debugger 0.12.0",
    "Error: unable to find a matching CMSIS-DAP device",
    "Error: Error connecting DP: cannot read IDR",
  ].join("\n");
  const failingSubprocess = {
    resolveExecutable: (command) => command,
    spawn: () => ({
      done: Promise.resolve({ exitCode: 1, signal: null }),
      collected: {
        stdout: { readFrom: () => ({ text: "", nextOffset: 0 }) },
        stderr: { readFrom: () => ({ text: failLog, nextOffset: failLog.length }) },
      },
      waitForExit: () => Promise.resolve({ exitCode: 1, signal: null }),
    }),
  };
  const report = await runFlash(failingSubprocess, { projectDir: FIXTURE_PROJECT, timeoutMs: 5000 });
  reportProblems("stm32_flash", flashSchema, { message: report.message, report });
  assert.equal(report.ok, false);
  assert.equal(report.errorCode, "no-probe", "拿不到探针时要归到 no-probe：" + JSON.stringify(report.errors));
});

test("stm32_debug_run 失败报告符合 output schema", () => {
  return runDebugRun(forbiddenSubprocess, { projectDir: MISSING_DIR, timeoutMs: 5000 }).then((report) => {
    reportProblems("stm32_debug_run", debugSchema, { message: report.message, report });
    assert.equal(report.ok, false);
  });
});

test("stm32_regs_read 参数错误报告符合 output schema（不 spawn）", () => {
  return runRegsRead(forbiddenSubprocess, { projectDir: MISSING_DIR, addresses: ["0xZZZ"] }).then((report) => {
    reportProblems("stm32_regs_read", regsSchema, { message: report.message, report });
    assert.equal(report.ok, false);
    assert.equal(report.exitCode, undefined);
  });
});

test("stm32_doctor 报告符合 output schema（工具全 MISS 也必须是完整形状）", () => {
  return runDoctor(forbiddenSubprocess, { projectDir: MISSING_DIR, port: 3999, timeoutMs: 1000 }).then((report) => {
    reportProblems("stm32_doctor", doctorSchema, { message: report.message, report });
    assert.equal(report.ok, false);
    assert.ok(report.missingRequired.length > 0);
  });
});

test("stm32_generate 失败报告符合 output schema", () => {
  return runGenerate(forbiddenSubprocess, { projectDir: MISSING_DIR, timeoutMs: 5000 }).then((report) => {
    reportProblems("stm32_generate", generateSchema, { mode: "report", jobId: "", message: report.message, report });
    assert.equal(report.ok, false);
  });
});

// ── M4：事务层与调试会话（同一套形状守卫，覆盖 tools 层自己拼的 value）────────────────

/** 注册一批工具，返回 name→definition，用假 ctx 直接调 execute（默认不 spawn 进程）。 */
function collectTools(register, subprocess = forbiddenSubprocess) {
  const defs = new Map();
  const ctx = {
    tools: {
      register(definition) {
        defs.set(definition.name, definition);
        return () => undefined;
      },
    },
    get(name) {
      return name === "subprocess" ? subprocess : undefined;
    },
  };
  register(ctx);
  return defs;
}

const noBinDirs = { binDirs: ["D:/__dsh_stm32_missing_bin__"] };
const exec = { signal: new AbortController().signal };

test("stm32_env_install 缺 dryRun:false / confirm:true 时停在计划模式，形状合规", async () => {
  const tool = collectTools(registerEnvInstall).get("stm32_env_install");
  assert.ok(tool, "stm32_env_install 应已注册");
  for (const args of [{}, { confirm: true }, { dryRun: false }]) {
    const value = await tool.execute(args, exec);
    reportProblems("stm32_env_install" + JSON.stringify(args), envInstallSchema, value);
    // 外层 mode 是宿主卡片的形态（report/job），引擎侧的 mode 才是 plan/install；
    // 两个开关缺一就只能是 plan，绝不开 job、绝不动网络与注册表。
    assert.notEqual(value.mode, "job", "缺开关时不许开后台 job：" + JSON.stringify(args));
    assert.equal(value.report.mode, "plan", "两个开关缺一就必须停在计划：" + JSON.stringify(args));
    assert.ok(value.report.steps.length > 0, "计划里要列出步骤");
    assert.equal(value.report.path.done, false, "计划模式不许改 PATH");
    assert.equal(value.report.config.written, false, "计划模式不许写配置");
  }
});

test("门禁缺件时 stm32_build 返回 schema 齐全的失败报告（不 spawn cmake）", async () => {
  const tool = collectTools(registerBuild).get("stm32_build");
  assert.ok(tool, "stm32_build 应已注册");
  const value = await tool.execute({ projectDir: FIXTURE_PROJECT, ...noBinDirs, envCheck: "block", foreground: true }, exec);
  reportProblems("stm32_build(门禁)", buildSchema, value);
  assert.equal(value.report.ok, false);
  assert.match(value.message, /这次没有开始编译/u);
  assert.ok(value.report.notes.some((line) => line.includes("安装：")), "notes 里要有可粘贴的安装动作");
});

test("envCheck=off 时门禁不拦（仍会走真编译路径，故只看它没被门禁文案替代）", async () => {
  const tool = collectTools(registerBuild).get("stm32_build");
  const value = await tool.execute({ projectDir: FIXTURE_PROJECT, ...noBinDirs, envCheck: "off", foreground: true, timeoutMs: 5000 }, exec);
  reportProblems("stm32_build(off)", buildSchema, value);
  assert.doesNotMatch(value.message, /这次没有开始编译/u);
});

test("stm32_ioc_plan 早退（找不到 .ioc）符合 output schema", async () => {
  const defs = collectTools(registerIocPlan);
  const tool = defs.get("stm32_ioc_plan");
  assert.ok(tool, "stm32_ioc_plan 应已注册");
  const value = await tool.execute({ projectDir: MISSING_DIR }, exec);
  reportProblems("stm32_ioc_plan", iocPlanSchema, value);
  assert.equal(value.ok, false);
  assert.equal(value.planId, "");
});

test("stm32_ioc_apply 缺 planId / 非法回滚路径都符合 output schema", async () => {
  const defs = collectTools(registerIocApply);
  const tool = defs.get("stm32_ioc_apply");
  assert.ok(tool, "stm32_ioc_apply 应已注册");
  const missingPlan = await tool.execute({ projectDir: MISSING_DIR }, exec);
  reportProblems("stm32_ioc_apply(缺 planId)", iocApplySchema, missingPlan);
  assert.equal(missingPlan.ok, false);
  const badRollback = await tool.execute({ projectDir: MISSING_DIR, rollbackFrom: "D:/__nope__/x.ioc" }, exec);
  reportProblems("stm32_ioc_apply(回滚)", iocApplySchema, badRollback);
  assert.equal(badRollback.mode, "rollback");
});

test("stm32_ioc_plan / stm32_ioc_apply 成功路径符合 output schema（不 spawn）", async () => {
  const demoRoot = FIXTURE_PROJECT;
  const work = e2eWorkDir("schema-guard");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  copyFileSync(join(demoRoot, "demo.ioc"), join(work, "demo.ioc"));
  try {
    const planTool = collectTools(registerIocPlan).get("stm32_ioc_plan");
    const planValue = await planTool.execute({ projectDir: work, pins: [{ pin: "PA5", signal: "output", label: "led2" }] }, exec);
    reportProblems("stm32_ioc_plan(成功)", iocPlanSchema, planValue);
    assert.equal(planValue.ok, true);
    assert.ok(planValue.changes.length > 0, "应给出 diff");
    for (const change of planValue.changes) {
      assert.ok(["added", "removed", "changed"].includes(change.kind), "kind 必须是 added/removed/changed：" + JSON.stringify(change));
      assert.equal(typeof change.before, "string");
      assert.equal(typeof change.after, "string");
    }
    const applyTool = collectTools(registerIocApply).get("stm32_ioc_apply");
    const applyValue = await applyTool.execute({ projectDir: work, planId: planValue.planId }, exec);
    reportProblems("stm32_ioc_apply(成功)", iocApplySchema, applyValue);
    assert.equal(applyValue.ok, true);
    assert.equal(applyValue.mode, "apply");
    assert.equal(applyValue.shaAfter, planValue.candidateSha256);
    assert.ok(applyValue.backupPath.length > 0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("stm32_debug_session 找不到 openocd 时符合 output schema（不 spawn）", async () => {
  const defs = collectTools(registerDebugSession);
  const tool = defs.get("stm32_debug_session");
  assert.ok(tool, "stm32_debug_session 应已注册");
  const value = await tool.execute({ projectDir: MISSING_DIR, ...noBinDirs }, exec);
  reportProblems("stm32_debug_session", debugSessionSchema, value);
  assert.equal(value.session.ok, false);
  assert.equal(value.session.active, false);
});

test("stm32_debug_eval 没有会话时符合 output schema（不 spawn）", async () => {
  const defs = collectTools(registerDebugSession);
  const tool = defs.get("stm32_debug_eval");
  assert.ok(tool, "stm32_debug_eval 应已注册");
  const value = await tool.execute({ expression: "g_led_blink_count" }, exec);
  reportProblems("stm32_debug_eval", debugEvalSchema, value);
  assert.equal(value.report.ok, false);
  assert.match(value.report.errors.join(" "), /没有调试会话/u);
});

test("stm32_debug_stop 幂等且符合 output schema", async () => {
  const defs = collectTools(registerDebugSession);
  const tool = defs.get("stm32_debug_stop");
  assert.ok(tool, "stm32_debug_stop 应已注册");
  const value = await tool.execute({}, exec);
  reportProblems("stm32_debug_stop", debugStopSchema, value);
  assert.equal(value.stopped, false);
});

// ── M5 收尾：project_create / code_patch 的形状守卫（都走早退或临时目录，不 spawn）────

test("stm32_project_create 失败报告符合 output schema（工程名非法）", async () => {
  const defs = collectTools(registerProjectCreate);
  const tool = defs.get("stm32_project_create");
  assert.ok(tool, "stm32_project_create 应已注册");
  const value = await tool.execute({ targetDir: join(MISSING_DIR, "x"), projectName: "1-bad name" }, exec);
  reportProblems("stm32_project_create(非法工程名)", projectCreateSchema, value);
  assert.equal(value.report.ok, false);
  assert.equal(value.report.firmwareRoot, undefined);
});

test("stm32_code_patch 失败 / 成功报告都符合 output schema", async () => {
  const work = e2eWorkDir("schema-guard-patch");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, "Core", "Src"), { recursive: true });
  const source = join(work, "Core", "Src", "main.c");
  writeFileSync(source, ["int main(void)", "{", "  /* USER CODE BEGIN 3 */", "  /* USER CODE END 3 */", "}"].join("\n"));
  try {
    const tool = collectTools(registerCodePatch).get("stm32_code_patch");
    assert.ok(tool, "stm32_code_patch 应已注册");
    const missing = await tool.execute({ projectDir: work, file: "Core/Src/main.c", block: "NOPE", code: "x();" }, exec);
    reportProblems("stm32_code_patch(块不存在)", codePatchSchema, missing);
    assert.equal(missing.report.ok, false);
    assert.ok(missing.report.labels.includes("3"));

    const ok = await tool.execute({ projectDir: work, file: "Core/Src/main.c", block: "3", code: "  a();" }, exec);
    reportProblems("stm32_code_patch(成功)", codePatchSchema, ok);
    assert.equal(ok.report.ok, true);
    assert.equal(typeof ok.report.backupPath, "string");
    assert.match(readFileSync(source, "utf8"), /a\(\);/u);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("stm32_route_plan 缺 requirement / 正常评估都符合 output schema（不 spawn）", async () => {
  const tool = collectTools(registerRoutePlan).get("stm32_route_plan");
  assert.ok(tool, "stm32_route_plan 应已注册");

  const empty = await tool.execute({ projectDir: FIXTURE_PROJECT }, exec);
  reportProblems("stm32_route_plan(缺 requirement)", routePlanSchema, empty);
  assert.equal(empty.ok, false);
  assert.ok(empty.message.includes("requirement"));
  assert.equal(empty.verdict, "unclear");

  // 正常评估：envCheck=off 关掉门禁探测，保证这条用例只走形状校验、不起进程。
  const value = await tool.execute({ requirement: "按键控制 LED，串口每秒打印一次状态", projectDir: FIXTURE_PROJECT, envCheck: "off" }, exec);
  reportProblems("stm32_route_plan(寄存器版)", routePlanSchema, value);
  assert.equal(value.verdict, "register-ok");
  assert.ok(value.devices.length >= 2);
  for (const device of value.devices) {
    assert.equal(typeof device.halEffort, "number", device.id + " 的 HAL 代价要拍平成数字");
    assert.equal(typeof device.regEffort, "number", device.id + " 的寄存器代价要拍平成数字");
    assert.ok(["hal", "register", "hal-required"].includes(device.advice));
  }

  // 必须 HAL 的工程在关掉门禁时也不许报 ok（固件包没验过），但要给出指引而不是空指针。
  const hal = await tool.execute({ requirement: "用 FreeRTOS 跑两个任务，并通过 USB HID 上报状态", projectDir: FIXTURE_PROJECT, envCheck: "off" }, exec);
  reportProblems("stm32_route_plan(HAL 版)", routePlanSchema, hal);
  assert.equal(hal.verdict, "hal-only");
  assert.equal(typeof hal.firmware.found, "boolean");
  // 不变量：没找到该芯片的固件包，就必须贴出"怎么自己装"的指引（否则用户只剩一句干瞪眼）。
  if (!hal.firmware.found) {
    const firmwareGuide = hal.guides.find((guide) => guide.component === "firmware");
    assert.ok(firmwareGuide, "缺固件包时要贴手动安装指引：" + JSON.stringify(hal.guides.map((g) => g.component)));
    assert.equal(typeof firmwareGuide.steps[0].title, "string");
    assert.equal(typeof firmwareGuide.steps[0].command, "string");
  }
});

// ── 补齐 env_probe / ioc_inspect：这两个工具此前没进守卫，README 却按"15 个工具"写────────

const ENV_PROBE_VERSION = "arm-none-eabi-gcc (GNU Arm Embedded) 13.2.1\n";

/** 假子进程：spawn 直接给出"版本命令成功"的结算，不真的起进程。 */
const fakeVersionSubprocess = {
  resolveExecutable: (command) => command,
  spawn: (spec) => ({
    done: Promise.resolve({ exitCode: 0, signal: null }),
    collected: {
      stdout: { readFrom: () => ({ text: ENV_PROBE_VERSION, nextOffset: spec.argv.length }) },
      stderr: { readFrom: () => ({ text: "", nextOffset: 0 }) },
    },
    waitForExit: () => Promise.resolve({ exitCode: 0, signal: null }),
  }),
};

test("stm32_env_probe 输出符合 output schema（每项 found/path/version/hint 都在）", async () => {
  const defs = collectTools(registerEnvProbe, fakeVersionSubprocess);
  const tool = defs.get("stm32_env_probe");
  assert.ok(tool, "stm32_env_probe 应已注册");
  const value = await tool.execute({ binDirs: ["D:/__dsh_stm32_missing_bin__"], cubeMxRoots: ["D:/__dsh_stm32_missing_cubemx__"] }, exec);
  reportProblems("stm32_env_probe", envProbeSchema, value);
  assert.equal(typeof value.platform, "string");
  assert.ok(value.tools.length >= 5, "至少要报出 gcc/gdb/openocd/cmake/ninja 五条：" + String(value.tools.length));
  for (const item of value.tools) {
    assert.equal(typeof item.found, "boolean");
    assert.equal(typeof item.path, "string");
    assert.equal(typeof item.version, "string");
    assert.equal(typeof item.hint, "string");
    assert.equal(typeof item.error, "string");
    assert.equal(typeof item.impact, "string", item.id + " 必须写清缺失影响");
    assert.equal(typeof item.verify, "string", item.id + " 必须给出自检方式");
    assert.ok(Array.isArray(item.install), item.id + " 必须给出安装步骤");
    assert.ok(item.install.length > 0, item.id + " 的安装步骤不能为空");
    assert.equal(typeof item.install[0], "string");
    if (item.found) assert.ok(item.version.length > 0, item.id + " found=true 时应有版本号");
    if (!item.found) assert.ok(item.impact.length > 0, item.id + " 缺失时影响不能为空");
  }
  // 版本命令全成功 → 五个必需项都不缺；CubeMX 缺只是可选。
  assert.deepEqual(value.missingRequired, []);
  assert.match(value.summary, /工具链就绪/u);
  // 能力矩阵：编译/烧录/调试齐了，建工程因为 CubeMX 缺失而未就绪。
  assert.deepEqual(value.capabilities, { build: true, flash: true, debug: true, generate: false });
  assert.ok(value.recommendations.length > 0, "要给出下一步建议");
  assert.ok(
    value.recommendations.some((line) => line.includes("CubeMX 是可选的")),
    "缺 CubeMX 时必须说明它是可选的：" + JSON.stringify(value.recommendations),
  );
  assert.equal(value.searched.length, 2, "要报告工具链与 CubeMX 两处搜索范围");
  for (const line of value.searched) assert.ok(line.length > 0);
});

test("stm32_env_probe 全缺时给出安装顺序与「帮你装」的主动询问", async () => {
  // resolveExecutable 直接抛错 = 所有候选都找不到（不 spawn，纯失败早退）。
  const nothingSubprocess = {
    resolveExecutable: () => {
      throw new Error("not found");
    },
    spawn: () => {
      throw new Error("全缺时不应该 spawn");
    },
  };
  const defs = collectTools(registerEnvProbe, nothingSubprocess);
  const tool = defs.get("stm32_env_probe");
  assert.ok(tool, "stm32_env_probe 应已注册");
  const value = await tool.execute({ binDirs: ["D:/__dsh_stm32_missing_bin__"], cubeMxRoots: ["D:/__dsh_stm32_missing_cubemx__"] }, exec);
  reportProblems("stm32_env_probe(全缺)", envProbeSchema, value);
  assert.match(value.summary, /工具链不完整/u);
  assert.deepEqual(value.missingRequired, ["gcc", "gdb", "openocd", "cmake", "ninja"]);
  assert.deepEqual(value.capabilities, { build: false, flash: false, debug: false, generate: false });
  assert.ok(
    value.recommendations.some((line) => line.includes("pacman.exe -S")),
    "建议里要带可粘贴的安装命令：" + JSON.stringify(value.recommendations),
  );
  assert.ok(
    value.recommendations.some((line) => line.includes("需要我帮你装吗")),
    "必须主动问要不要代装：" + JSON.stringify(value.recommendations),
  );
  assert.ok(
    value.recommendations.some((line) => line.includes("CubeMX 是可选的")),
    "缺 CubeMX 时必须说明它是可选的",
  );
});

test("stm32_ioc_inspect 找不到 .ioc 与解析成功都符合 output schema", async () => {
  const tool = collectTools(registerIocInspect).get("stm32_ioc_inspect");
  assert.ok(tool, "stm32_ioc_inspect 应已注册");
  const missing = await tool.execute({ projectDir: MISSING_DIR }, exec);
  reportProblems("stm32_ioc_inspect(找不到)", iocInspectSchema, missing);
  assert.equal(missing.found, false);
  assert.equal(missing.path, "");

  const demoRoot = FIXTURE_PROJECT;
  const value = await tool.execute({ projectDir: demoRoot, iocPath: "demo.ioc" }, exec);
  reportProblems("stm32_ioc_inspect(成功)", iocInspectSchema, value);
  assert.equal(value.found, true);
  assert.equal(value.mcu.cpn, "STM32F103C8T6");
  assert.equal(value.debug.serialWire, true);
  assert.ok(typeof value.debug.mode === "string");
  assert.equal(typeof value.clocks.sysclkHz, "string");
  assert.equal(typeof value.entryCount, "number");
  for (const pin of value.pins) {
    assert.ok(["gpio", "debug", "clock", "virtual", "other"].includes(pin.kind), "pin.kind 越界：" + pin.kind);
  }
});

// ── stm32_cache：L3 里唯一"用户可以直接看到缓存状态"的入口 ─────────────────────

test("stm32_cache list / fetch 缺参 / fetch 认不出型号 / purge 都符合 output schema（不联网）", async () => {
  const tool = collectTools(registerCache, forbiddenSubprocess).get("stm32_cache");
  assert.ok(tool, "stm32_cache 应已注册");
  const work = e2eWorkDir("cache-tool");
  const before = process.env.DSH_STM32_CACHE;
  process.env.DSH_STM32_CACHE = join(work, "cache");
  try {
    const listed = await tool.execute({}, exec);
    reportProblems("stm32_cache(list)", cacheSchema, listed);
    assert.equal(listed.action, "list");
    assert.equal(listed.ok, true);
    assert.equal(listed.entries.length, 0);
    assert.match(listed.message, /缓存是空的/u);

    const noArgs = await tool.execute({ action: "fetch" }, exec);
    reportProblems("stm32_cache(fetch 缺参数)", cacheSchema, noArgs);
    assert.equal(noArgs.ok, false);
    assert.ok(noArgs.message.includes("mcu"), noArgs.message);

    // 认不出的型号必须在联网之前就停住（否则一次拼错的型号会白下 1 MB）。
    const unknown = await tool.execute({ action: "fetch", mcu: "STM32G999XX" }, exec);
    reportProblems("stm32_cache(fetch 认不出型号)", cacheSchema, unknown);
    assert.equal(unknown.ok, false);
    assert.equal(unknown.entries.length, 0);

    const purge = await tool.execute({ action: "purge" }, exec);
    reportProblems("stm32_cache(purge 空缓存)", cacheSchema, purge);
    assert.equal(purge.ok, true);
    assert.match(purge.message, /本来就是空的/u);
  } finally {
    if (before === undefined) delete process.env.DSH_STM32_CACHE;
    else process.env.DSH_STM32_CACHE = before;
    rmSync(work, { recursive: true, force: true });
  }
});

// ── stm32_firmware_install：固件包下载器（只走不联网的计划路径）──────────────

test("stm32_firmware_install 的计划报告符合 output schema，且不建目录 / 不联网", async () => {
  const tool = collectTools(registerFirmwareInstall, forbiddenSubprocess).get("stm32_firmware_install");
  assert.ok(tool, "stm32_firmware_install 应已注册");
  const work = e2eWorkDir("firmware-tool");
  try {
    const cubemxRoot = join(work, "cubemx");
    // 审计 B12 之后，decideTarget 只在"像 CubeMX 安装根"的目录里建 dsh-firmware（判据：有 STM32CubeMX.exe）。
    // 不写这个桩，计划会保守地退到下载缓存，targetKind 就不是 cubeMx 了。
    mkdirSync(cubemxRoot, { recursive: true });
    writeFileSync(join(cubemxRoot, "STM32CubeMX.exe"), "stub");
    const planned = await tool.execute({ family: "F1", cubeMxRoot: cubemxRoot }, exec);
    reportProblems("stm32_firmware_install(计划)", firmwareInstallSchema, planned);
    assert.equal(planned.mode, "report");
    assert.equal(planned.jobId, "");
    assert.equal(planned.report.mode, "plan");
    assert.equal(planned.report.targetKind, "cubeMx");
    assert.match(planned.report.targetDir, /dsh-firmware/u);
    assert.equal(planned.report.steps.length, 5);
    assert.equal(planned.report.download.files, 0);
    assert.match(planned.report.message, /还没动手/u);

    // 没接入的族：必须在联网前停下，并把话说清楚（不能瞎下）。
    const unknown = await tool.execute({ family: "STM32H743VIT6", cubeMxRoot: cubemxRoot }, exec);
    reportProblems("stm32_firmware_install(没接入的族)", firmwareInstallSchema, unknown);
    assert.equal(unknown.report.ok, false);
    assert.match(unknown.report.message, /目前只会/u);
    assert.equal(unknown.report.steps.length, 0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
