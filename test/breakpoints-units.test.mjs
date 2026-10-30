// B4：断点预算（src/engine/breakpoints.ts）单测。
//
// 覆盖：F1 的 6/4 默认、chips.json 里按芯片写的预算、超预算的判定与文案、
// 三处来源（breakAt / breakpoints / preCommands）的收集与去重、报告三元组夹取。
//
// 运行：node --test test/breakpoints-units.test.mjs（需先 npm run build）
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FIXTURE_ASSETS, FIXTURE_ASSETS_VERSION } from "./fixtures.mjs";

import {
  F1_BREAKPOINT_BUDGET,
  budgetFromChipFact,
  collectBreakpointRequests,
  parseBreakpointSpec,
  planBreakpoints,
  quotaOf,
  readIocCpn,
  resolveBreakpointBudget,
} from "../lib/engine/breakpoints.js";
import { parseDeviceFacts } from "../lib/data/device-facts.js";

/** 只带一个 .ioc 的临时工程（断点预算只从 .ioc 的 Mcu.CPN 推芯片）。 */
function iocProject(cpn) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-bp-project-"));
  writeFileSync(join(dir, "demo.ioc"), "Mcu.CPN=" + cpn + "\nMcu.Name=" + cpn + "Tx\n");
  return dir;
}

/** 断点请求的简写：code 用 "break:<名字>"，data 用 "watch:<名字>"。 */
function requests(...specs) {
  return specs.map((spec) => {
    const parsed = parseBreakpointSpec(spec);
    assert.notEqual(parsed, null, "解析不出断点：" + spec);
    return parsed;
  });
}

test("F1 默认预算就是实测的 6 个硬件断点 / 4 个观察点", () => {
  assert.deepEqual({ ...F1_BREAKPOINT_BUDGET }, { code: 6, data: 4 });
  assert.equal(budgetFromChipFact(null), null, "没有芯片事实时返回 null，由调用方回退默认");
});

test("6 个硬件断点刚好放得下：placed=6、overflow=0、remaining=0", () => {
  const plan = planBreakpoints(
    requests("break:a", "break:b", "break:c", "break:d", "break:e", "break:f"),
    F1_BREAKPOINT_BUDGET,
  );
  assert.equal(plan.ok, true);
  assert.equal(plan.placed.length, 6);
  assert.deepEqual(plan.overflow, []);
  assert.deepEqual(plan.used, { code: 6, data: 0 });
  assert.deepEqual(plan.remaining, { code: 0, data: 4 });
  assert.equal(plan.suggestion, "", "没超预算就不该有建议");
  assert.equal(plan.detail, "");
});

test("第 7 个硬件断点超限：前 6 个 placed、第 7 个进 overflow，并给出可执行的建议", () => {
  const plan = planBreakpoints(
    requests("break:a", "break:b", "break:c", "break:d", "break:e", "break:f", "break:g"),
    F1_BREAKPOINT_BUDGET,
  );
  assert.equal(plan.ok, false);
  assert.equal(plan.placed.length, 6);
  assert.equal(plan.overflow.length, 1);
  assert.equal(plan.overflow[0].location, "g", "超出来的是最后一个（按请求顺序）");
  assert.match(plan.detail, /7 个硬件断点/u);
  assert.match(plan.detail, /多 1 个硬件断点/u);
  assert.match(plan.suggestion, /删掉多出来的 1 个 break/u);
  assert.match(plan.suggestion, /tbreak/u, "建议里要给替代做法");
  assert.match(plan.suggestion, /6\/4/u, "建议里要写芯片上限");
  assert.deepEqual(plan.used, { code: 6, data: 0 });
});

test("观察点 4 个刚好、第 5 个超限，走的是 data 这一维", () => {
  const ok = planBreakpoints(requests("watch:w1", "watch:w2", "watch:w3", "watch:w4"), F1_BREAKPOINT_BUDGET);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.used, { code: 0, data: 4 });
  assert.deepEqual(ok.remaining, { code: 6, data: 0 });

  const over = planBreakpoints(requests("watch:w1", "watch:w2", "watch:w3", "watch:w4", "watch:w5"), F1_BREAKPOINT_BUDGET);
  assert.equal(over.ok, false);
  assert.equal(over.overflow[0].kind, "data");
  assert.match(over.detail, /5 个观察点/u);
  assert.match(over.detail, /多 1 个观察点/u);
  assert.match(over.suggestion, /DWT/u);
});

test("硬件断点与观察点各算各的：3+3 都放得下，7+5 各超 1 个", () => {
  const fits = planBreakpoints(
    requests("break:a", "break:b", "break:c", "watch:w1", "watch:w2", "watch:w3"),
    F1_BREAKPOINT_BUDGET,
  );
  assert.equal(fits.ok, true);
  assert.deepEqual(fits.used, { code: 3, data: 3 });
  assert.deepEqual(fits.remaining, { code: 3, data: 1 });

  const mixed = planBreakpoints(
    requests("break:a", "break:b", "break:c", "break:d", "break:e", "break:f", "break:g", "watch:w1", "watch:w2", "watch:w3", "watch:w4", "watch:w5"),
    F1_BREAKPOINT_BUDGET,
  );
  assert.equal(mixed.ok, false);
  assert.equal(mixed.overflow.length, 2, "第 7 个断点和第 5 个观察点都要进 overflow");
  assert.deepEqual(mixed.used, { code: 6, data: 4 });
  assert.match(mixed.detail, /多 1 个硬件断点、多 1 个观察点/u);
});

test("芯片事实里写了预算就用芯片的：parsed chips.json → 8/2", () => {
  const text = JSON.stringify({
    chips: [{
      cpn: "STM32F103C8T6", line: "103", group: "xb", packageName: "LQFP48",
      pinCount: 48, flashBytes: 65536, ramBytes: 20480,
      deviceId: "STM32F103C8Tx", mcuName: "STM32F103C(8-B)Tx",
      startup: "startup_stm32f103xb.s", deviceDefine: "STM32F103xB",
      deviceHeader: "stm32f103xb.h", linkerScript: "STM32F103C8Tx_FLASH.ld",
      breakpoints: 8, watchpoints: 2,
    }],
  });
  const facts = parseDeviceFacts(text, "device/f1/chips.json");
  assert.equal(facts.ok, true);
  const chip = facts.byCpn.get("STM32F103C8T6");
  assert.notEqual(chip, undefined);
  assert.equal(chip.breakpoints, 8, "chips.json 的 breakpoints 要被解析出来");
  assert.equal(chip.watchpoints, 2);
  assert.deepEqual({ ...budgetFromChipFact(chip) }, { code: 8, data: 2 });
});

test("芯片只写了 breakpoints 时，观察点回退 F1 默认 4（不让整份预算作废）", () => {
  assert.deepEqual({ ...budgetFromChipFact({ breakpoints: 4 }) }, { code: 4, data: 4 });
  assert.deepEqual({ ...budgetFromChipFact({ watchpoints: 1 }) }, { code: 6, data: 1 });
  assert.equal(budgetFromChipFact({}), null);
  assert.equal(budgetFromChipFact({ breakpoints: 0 }), null, "0 不是有效上限");
});

test("resolveBreakpointBudget：资源包里给了预算就用芯片的（临时复制夹具资源包改写 chips.json）", () => {
  const assets = mkdtempSync(join(tmpdir(), "dsh-bp-assets-"));
  const project = iocProject("STM32F103C8T6");
  try {
    cpSync(FIXTURE_ASSETS, assets, { recursive: true });
    const chipsPath = join(assets, FIXTURE_ASSETS_VERSION, "device", "f1", "chips.json");
    const parsed = JSON.parse(readFileSync(chipsPath, "utf8"));
    const chip = parsed.chips.find((item) => item.cpn === "STM32F103C8T6");
    assert.ok(chip, "夹具资源包里应有 STM32F103C8T6");
    chip.breakpoints = 8;
    chip.watchpoints = 2;
    writeFileSync(chipsPath, JSON.stringify(parsed, null, 2) + "\n");

    const resolution = resolveBreakpointBudget(project, { DSH_STM32_ASSETS: assets });
    assert.equal(resolution.source, "chips.json", resolution.note);
    assert.equal(resolution.chip, "STM32F103C8T6");
    assert.deepEqual({ ...resolution.budget }, { code: 8, data: 2 });
    assert.match(resolution.note, /来自 chips\.json/u);
  } finally {
    rmSync(assets, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("resolveBreakpointBudget：资源包里没有预算字段时回退 F1 默认，并说清原因", () => {
  const project = iocProject("STM32F103C8T6");
  try {
    const resolution = resolveBreakpointBudget(project, { DSH_STM32_ASSETS: FIXTURE_ASSETS });
    assert.equal(resolution.source, "f1-default");
    assert.deepEqual({ ...resolution.budget }, { code: 6, data: 4 });
    assert.match(resolution.note, /没写 breakpoints\/watchpoints/u);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("resolveBreakpointBudget：没有 .ioc 时按 F1 默认，并说明工程里没找到 .ioc", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-bp-empty-"));
  try {
    assert.equal(readIocCpn(dir), "");
    const resolution = resolveBreakpointBudget(dir, { DSH_STM32_ASSETS: FIXTURE_ASSETS });
    assert.equal(resolution.source, "f1-default");
    assert.match(resolution.note, /\.ioc/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveBreakpointBudget：型号不在资源包里时回退默认并点名型号", () => {
  const project = iocProject("STM32F999ZZZ");
  try {
    const resolution = resolveBreakpointBudget(project, { DSH_STM32_ASSETS: FIXTURE_ASSETS });
    assert.equal(resolution.source, "f1-default");
    assert.match(resolution.note, /STM32F999ZZZ/u);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("收集断点：breakAt 计入，breakAt=none / 空串不计入", () => {
  assert.deepEqual(collectBreakpointRequests({ breakAt: "main" }).requested, [{ location: "main", kind: "code" }]);
  assert.deepEqual(collectBreakpointRequests({ breakAt: "none" }).requested, []);
  assert.deepEqual(collectBreakpointRequests({ breakAt: "" }).requested, []);
  assert.deepEqual(collectBreakpointRequests({}).requested, []);
  assert.deepEqual(collectBreakpointRequests({ breakAt: "  " }).requested, []);
});

test("收集断点：preCommands 里的 break/tbreak/watch 也算进预算（不能从这里绕过限制）", () => {
  const collected = collectBreakpointRequests({
    breakAt: "main",
    preCommands: ["break HAL_Delay", "tbreak HAL_GetTick", "watch g_led_count", "bt", "set pagination off"],
  });
  assert.deepEqual(collected.requested, [
    { location: "main", kind: "code" },
    { location: "HAL_Delay", kind: "code" },
    { location: "HAL_GetTick", kind: "code" },
    { location: "g_led_count", kind: "data" },
  ]);
  assert.ok(collected.notes.some((note) => /3 条 break\/watch/u.test(note)), collected.notes.join(" | "));
});

test("收集断点：同一位置只占一个比较器（重复的合并并记一条 note）", () => {
  const collected = collectBreakpointRequests({
    breakAt: "main",
    breakpoints: ["main", "break:main", "HAL_Delay"],
  });
  assert.deepEqual(collected.requested, [
    { location: "main", kind: "code" },
    { location: "HAL_Delay", kind: "code" },
  ]);
  assert.ok(collected.notes.some((note) => /重复断点/u.test(note)), collected.notes.join(" | "));
});

test("断点写法：watch:/break: 前缀标 kind，空串被忽略", () => {
  assert.deepEqual(parseBreakpointSpec("watch:g_count"), { location: "g_count", kind: "data" });
  assert.deepEqual(parseBreakpointSpec("break:HAL_Delay"), { location: "HAL_Delay", kind: "code" });
  assert.deepEqual(parseBreakpointSpec("main"), { location: "main", kind: "code" });
  assert.equal(parseBreakpointSpec("   "), null);
  assert.equal(parseBreakpointSpec("watch:"), null);
  const collected = collectBreakpointRequests({ breakpoints: ["", "  "] });
  assert.deepEqual(collected.requested, []);
  assert.equal(collected.notes.length, 2, "空串要被点名忽略，而不是静默吞掉");
});

test("报告三元组夹取：used 不会超过 limit，也不会为负", () => {
  assert.deepEqual({ ...quotaOf(7, 6) }, { used: 6, limit: 6, remaining: 0 });
  assert.deepEqual({ ...quotaOf(-3, 6) }, { used: 0, limit: 6, remaining: 6 });
  assert.deepEqual({ ...quotaOf(2, 6) }, { used: 2, limit: 6, remaining: 4 });
  assert.deepEqual({ ...quotaOf(1, 0) }, { used: 0, limit: 0, remaining: 0 });
});

test("换一颗预算更大的芯片（模拟 F4 的 12/4）：12 个断点全放得下", () => {
  const big = { code: 12, data: 4 };
  const plan = planBreakpoints(requests(...Array.from({ length: 12 }, (_, index) => "break:fn" + String(index))), big);
  assert.equal(plan.ok, true);
  assert.equal(plan.placed.length, 12);
  assert.deepEqual(plan.remaining, { code: 0, data: 4 });
});
