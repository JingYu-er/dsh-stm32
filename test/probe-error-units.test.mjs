// B2 单元测试：结构化探针错误（probe-error.ts 是唯一分类入口，不连板子）。
// 用 node --test test/probe-error-units.test.mjs 跑。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HINT_BUSY,
  HINT_DP,
  HINT_FLASH_PROTECTED,
  HINT_NO_POWER,
  HINT_PROBE,
  HINT_TARGET_MISMATCH,
  PROBE_ERROR_KINDS,
  PROBE_ERROR_SCHEMA,
  classifyProbeFailure,
  firstProblemLine,
  formatProbeError,
  probeMissingLines,
  usbNoteFor,
} from "../lib/engine/probe-error.js";

/** 只给日志行、其余用默认值的分类调用（多数用例只需要 kind）。 */
function kindOf(lines, extra = {}) {
  return classifyProbeFailure({ lines, stage: "flash", ...extra }).kind;
}

// ── 8 个 kind 的正例：每条都是 openocd/gdb 真会打出来的那行 ─────────────────────

test("kind=no-probe：找不到 CMSIS-DAP 设备", () => {
  assert.equal(kindOf(["Error: unable to find a matching CMSIS-DAP device"]), "no-probe");
  // 同一类的第二句式也归一：openocd 有时候只说 no device found。
  assert.equal(kindOf(["Error: no device found"]), "no-probe");
});

test("kind=probe-busy：适配器被占用（命令行报锁 + 真机的事务错位两种形态）", () => {
  assert.equal(kindOf(["Error: adapter speed could not be limited"]), "probe-busy");
  assert.equal(kindOf(["libusb_error_busy"]), "probe-busy");
});

test("kind=probe-busy：探针固件卡住时只有 CMD_INFO failed（真板子取证，2026-10-31 复现两次）", () => {
  const error = classifyProbeFailure({
    lines: ["Error: CMSIS-DAP command CMD_INFO failed."],
    exitCode: 1,
    stage: "flash",
  });
  assert.equal(error.kind, "probe-busy");
  // 成因要能同时覆盖「并发访问」与「固件卡住」，hint 必须给拔插这条可执行动作。
  assert.match(error.cause, /另一个进程|固件卡住/u);
  assert.match(error.hint, /拔下来/u);
  assert.equal(error.retryable, true);
  assert.deepEqual(error.evidence, ["Error: CMSIS-DAP command CMD_INFO failed."]);
});

test("kind=probe-busy：两个 openocd 抢同一探针时的 transfer/command mismatch（真板子取证）", () => {
  const log = [
    "Error: CMSIS-DAP command CMD_DISCONNECT failed.",
    "Error: CMSIS-DAP command mismatch. Sent 0x12 received 0x2",
    "Error: CMSIS-DAP transfer count mismatch: expected 5, got 1",
    "Error: Failed to write memory at 0x00000004",
  ];
  assert.equal(kindOf(log), "probe-busy");
});

test("kind=swd-locked：连不上 DP / AP 被锁", () => {
  assert.equal(kindOf(["Error: Error connecting DP: cannot read IDR"]), "swd-locked");
  assert.equal(kindOf(["Error: AP lock detected"]), "swd-locked");
  assert.equal(kindOf(["Error: sticky error, clearing lockup"]), "swd-locked");
});

test("kind=flash-protected：写保护 / 读保护挡住烧写", () => {
  assert.equal(kindOf(["Error: flash programming failed: read protected"]), "flash-protected");
  assert.equal(kindOf(["Error: write protected"]), "flash-protected");
});

test("kind=no-power：目标电压过低", () => {
  assert.equal(kindOf(["Error: target voltage may be too low: 0.0 V"]), "no-power");
  assert.equal(kindOf(["Error: no power on target"]), "no-power");
});

test("kind=target-mismatch：device id 对不上", () => {
  assert.equal(kindOf(["Error: unexpected idcode: 0x2ba01477"]), "target-mismatch");
  assert.equal(kindOf(["Error: cannot identify target"]), "target-mismatch");
});

test("kind=target-mismatch：真机样本只有一行 Warn（2026-10-31，F4 target 连 F1 芯片）", () => {
  const error = classifyProbeFailure({
    lines: [
      "Info : device id = 0x20036410",
      "Warn : Cannot identify target as a STM32 family.",
      "Error: Failed to write memory at 0x40023808",
    ],
    exitCode: 1,
    stage: "flash",
  });
  assert.equal(error.kind, "target-mismatch");
  assert.deepEqual(error.evidence, ["Warn : Cannot identify target as a STM32 family."]);
  assert.equal(error.retryable, false);
});

test("正常烧录里的 Info : device id 不能被当成 target-mismatch", () => {
  const error = classifyProbeFailure({
    lines: ["Info : device id = 0x20036410", "** Programming Finished **"],
    exitCode: 1,
    stage: "flash",
  });
  assert.notEqual(error.kind, "target-mismatch");
});

test("kind=timeout：调用方判定的超时（日志里没有别的特征）", () => {
  const error = classifyProbeFailure({ lines: ["Info : Started by GNU MCU Eclipse"], stage: "flash", timedOut: true });
  assert.equal(error.kind, "timeout");
  assert.equal(error.retryable, true);
});

test("kind=unknown：日志特征都不命中，且没有超时/启动失败", () => {
  assert.equal(kindOf(["Error: something else entirely"]), "unknown");
  assert.equal(kindOf([]), "unknown");
});

// ── evidence：原始日志行逐字保留 ──────────────────────────────────────────────

test("evidence 逐字保留命中的原始日志行（不裁剪、不改写、去重）", () => {
  const raw = "Error: Error connecting DP: cannot read IDR";
  const lines = ["Info : CMSIS-DAP: Interface ready", raw, "  " + raw + "  ", "Info : shutdown"];
  const error = classifyProbeFailure({ lines, stage: "debug" });
  assert.equal(error.kind, "swd-locked");
  assert.equal(error.evidence.length, 2, "原样保留两种缩进形态，不合并：" + JSON.stringify(error.evidence));
  assert.equal(error.evidence[0], raw);
  assert.equal(error.evidence[1], "  " + raw + "  ", "首尾空格属于原始行的一部分");
});

test("evidence 最多留 4 条，且只留命中同一特征的行", () => {
  const lines = [];
  for (let index = 0; index < 8; index += 1) lines.push("Error: CMSIS-DAP transfer count mismatch #" + String(index));
  lines.push("Info : unrelated");
  const error = classifyProbeFailure({ lines, stage: "flash" });
  assert.equal(error.kind, "probe-busy");
  assert.equal(error.evidence.length, 4);
  assert.ok(error.evidence.every((line) => line.includes("transfer count mismatch")));
});

test("timeout 的 evidence 留超时行，没有超时行就留最后一行日志", () => {
  const withTimeout = classifyProbeFailure({ lines: ["Info : a", "Error: gdb timed out waiting"], stage: "debug", timedOut: true });
  assert.deepEqual(withTimeout.evidence, ["Error: gdb timed out waiting"]);
  const bare = classifyProbeFailure({ lines: ["Info : a", "Info : b"], stage: "session", timedOut: true });
  assert.deepEqual(bare.evidence, ["Info : b"]);
});

test("spawnError：进程没起来时归 unknown，原始错误进 evidence", () => {
  const error = classifyProbeFailure({ lines: [], stage: "flash", spawnError: "spawn openocd ENOENT" });
  assert.equal(error.kind, "unknown");
  assert.deepEqual(error.evidence, ["spawn openocd ENOENT"]);
  assert.match(error.cause, /启动失败/u);
});

// ── retryable：照 hint 弄完再调一次有没有意义 ─────────────────────────────────

test("retryable：可复原的 true，需要换流程/换芯片的 false", () => {
  const cases = [
    ["Error: unable to find a matching CMSIS-DAP device", true],
    ["Error: CMSIS-DAP transfer count mismatch: expected 5, got 1", true],
    ["Error: Error connecting DP: cannot read IDR", true],
    ["Error: target voltage may be too low", true],
    ["Error: flash programming failed: read protected", false],
    ["Error: unexpected idcode", false],
  ];
  for (const [line, expected] of cases) {
    const error = classifyProbeFailure({ lines: [line], stage: "flash" });
    assert.equal(error.retryable, expected, line + " 的 retryable 应为 " + String(expected));
  }
  assert.equal(
    classifyProbeFailure({ lines: ["Error: whatever"], stage: "flash" }).retryable,
    false,
    "unknown 没有依据，重试等于赌",
  );
  assert.equal(classifyProbeFailure({ lines: [], stage: "flash", timedOut: true }).retryable, true);
});

// ── 四类真机验过的故障：各有专属 hint，且不互相串味 ─────────────────────────────

test("四类真机故障的 hint 都在，且与 kind 一一对应", () => {
  const real = [
    ["swd-locked", "Error: Error connecting DP: cannot read IDR", HINT_DP, /BOOT0/u],
    ["flash-protected", "Error: flash programming failed: read protected", HINT_FLASH_PROTECTED, /写保护|读保护/u],
    ["no-power", "Error: target voltage may be too low", HINT_NO_POWER, /供电|3V3/u],
    ["target-mismatch", "Error: unexpected idcode", HINT_TARGET_MISMATCH, /STM32F103|device id/u],
  ];
  const seen = new Set();
  for (const [kind, line, expectedHint, pattern] of real) {
    const error = classifyProbeFailure({ lines: [line], stage: "flash" });
    assert.equal(error.kind, kind);
    assert.equal(error.hint, expectedHint, kind + " 的 hint 必须用专属文案");
    assert.match(error.hint, pattern);
    assert.ok(error.cause.length > 0, kind + " 的 cause 不能为空");
    assert.ok(!seen.has(error.hint), kind + " 的 hint 不能和别的故障复用同一句");
    seen.add(error.hint);
  }
});

test("每个 kind 都有非空 hint / cause，且 retryable 是布尔", () => {
  const probes = {
    "no-probe": ["Error: no device found"],
    "probe-busy": ["libusb_error_busy"],
    "swd-locked": ["Error: Error connecting DP: cannot read IDR"],
    "flash-protected": ["Error: read protected"],
    "no-power": ["Error: target voltage may be too low"],
    "target-mismatch": ["Error: unexpected idcode"],
    timeout: [],
    unknown: ["Error: mystery"],
  };
  assert.deepEqual([...PROBE_ERROR_KINDS].sort(), Object.keys(probes).sort(), "8 类一个都不能少");
  for (const [kind, lines] of Object.entries(probes)) {
    const error = classifyProbeFailure({ lines, stage: "flash", ...(kind === "timeout" ? { timedOut: true } : {}) });
    assert.equal(error.kind, kind);
    assert.ok(error.hint.length > 0, kind + " 缺 hint");
    assert.ok(error.cause.length > 0, kind + " 缺 cause");
    assert.equal(typeof error.retryable, "boolean");
    assert.ok(Array.isArray(error.evidence));
  }
  assert.equal(HINT_PROBE, classifyProbeFailure({ lines: ["Error: no device found"], stage: "flash" }).hint);
  assert.equal(HINT_BUSY, classifyProbeFailure({ lines: ["libusb_error_busy"], stage: "flash" }).hint);
});

// ── 同一故障在两条路径（flash / debug）必须得到同一个 kind ─────────────────────

test("同一故障在 flash 与 debug 两条路径归到同一个 kind", () => {
  const logs = [
    ["Error: unable to find a matching CMSIS-DAP device"],
    ["Error: CMSIS-DAP transfer count mismatch: expected 5, got 1"],
    ["Error: Error connecting DP: cannot read IDR"],
    ["Error: flash programming failed: read protected"],
    ["Error: target voltage may be too low"],
    ["Error: unexpected idcode", "Info : device id = 0x20036410"],
  ];
  for (const lines of logs) {
    const flash = classifyProbeFailure({ lines, exitCode: 1, stage: "flash" });
    const debug = classifyProbeFailure({ lines, exitCode: 0, stage: "debug" });
    assert.equal(flash.kind, debug.kind, "两路径必须同 kind：" + lines[0]);
    assert.equal(flash.hint, debug.hint, "两路径必须同 hint：" + lines[0]);
    assert.equal(flash.retryable, debug.retryable);
  }
});

test("归类顺序：先 no-probe 再 probe-busy，锁片特征比超时优先", () => {
  const mixed = ["Error: Error connecting DP: cannot read IDR", "Error: unable to find a matching CMSIS-DAP device"];
  assert.equal(kindOf(mixed), "no-probe", "别把'被占用/没插'读成'锁片'");
  const lockedAndTimeout = classifyProbeFailure({ lines: ["Error: Error connecting DP: cannot read IDR"], stage: "flash", timedOut: true });
  assert.equal(lockedAndTimeout.kind, "swd-locked", "既报错又超时时说要紧的那个");
});

test("超时的 cause 按 stage 区分（flash / debug / session 各说各的）", () => {
  const flash = classifyProbeFailure({ lines: [], stage: "flash", timedOut: true });
  const debug = classifyProbeFailure({ lines: [], stage: "debug", timedOut: true });
  const session = classifyProbeFailure({ lines: [], stage: "session", timedOut: true });
  assert.match(flash.cause, /烧录/u);
  assert.match(debug.cause, /调试/u);
  assert.match(session.cause, /会话/u);
  assert.notEqual(flash.cause, debug.cause);
});

// ── 文案与 schema 片段（工具层共用）──────────────────────────────────────────

test("formatProbeError 就是「错误：<kind> — <cause>；建议：<hint>」", () => {
  const error = classifyProbeFailure({ lines: ["Error: Error connecting DP: cannot read IDR"], stage: "flash" });
  const text = formatProbeError(error);
  assert.match(text, /^错误：swd-locked — .+；建议：.+$/u);
  assert.ok(text.includes(error.cause));
  assert.ok(text.includes(error.hint));
});

test("PROBE_ERROR_SCHEMA：probeError 对象五个字段齐全、additionalProperties=false、kind 收到 8 类", () => {
  assert.equal(PROBE_ERROR_SCHEMA.type, "object");
  assert.equal(PROBE_ERROR_SCHEMA.additionalProperties, false);
  assert.deepEqual(PROBE_ERROR_SCHEMA.required, ["kind", "cause", "hint", "evidence", "retryable"]);
  assert.deepEqual([...PROBE_ERROR_SCHEMA.properties.kind.enum].sort(), [...PROBE_ERROR_KINDS].sort());
  assert.equal(PROBE_ERROR_SCHEMA.properties.evidence.type, "array");
  assert.equal(PROBE_ERROR_SCHEMA.properties.evidence.items.type, "string");
  assert.equal(PROBE_ERROR_SCHEMA.properties.retryable.type, "boolean");
});

test("probeMissingLines / usbNoteFor 迁到 probe-error 后行为不变（2a 的老判据）", () => {
  const missing = probeMissingLines([
    "Error: unable to find a matching CMSIS-DAP device",
    "Error: no device found",
    "Error: Error connecting DP: cannot read IDR",
  ]);
  assert.equal(missing.length, 2);
  assert.match(missing[0] ?? "", /CMSIS-DAP/u);
  assert.equal(usbNoteFor("unknown", "诊断失败"), null);
  assert.match(usbNoteFor("no-usb", "这台机器没有 USB"), /USB 形态：/u);
});

test("firstProblemLine 取第一条说明问题的行，退化为最后一行", () => {
  assert.equal(firstProblemLine(["Info : a", "Error: unable to find a matching CMSIS-DAP device", "Info : b"]), "Error: unable to find a matching CMSIS-DAP device");
  assert.equal(firstProblemLine(["Info : a", "Info : b"]), "Info : b");
  assert.equal(firstProblemLine([]), "");
});
