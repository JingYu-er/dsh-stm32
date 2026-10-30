// C1 RTT 单测：node --test test/rtt-units.test.mjs
// 全离线：假 subprocess（不真起 openocd）+ 假 Tcl 服务端 + 假 RTT 通道 TCP 服务端。
// 覆盖：帧编解码、start 发对命令、控制块魔数校验、dump 解析/过滤/截断、stop 关连接、
//       端口占用、连不上通道、工具层四个动作与报告 schema。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { debugSessions } from "../lib/engine/debug-session.js";
import { ensureSession, sessionInfo } from "../lib/engine/probe-session.js";
import {
  DEFAULT_RTT_PORT,
  DEFAULT_RTT_SIZE,
  RTT_FRAME_HEADER_BYTES,
  RTT_MAGIC_TEXT,
  RTT_MAGIC_WORD_0,
  RTT_MAGIC_WORD_1,
  RTT_MAGIC_WORD_2_LOW,
  RTT_MAX_LEVEL,
  RTT_MIN_FRAME_BYTES,
  RTT_MIN_LEVEL,
  dumpRtt,
  encodeRttFrame,
  parseRttFrames,
  rttStatus,
  startRtt,
  stopRtt,
} from "../lib/engine/rtt.js";
import { outputSchema as rttOutputSchema, registerRtt } from "../lib/tools/rtt.js";

import { FIXTURE_PROJECT, fakeBinDirs } from "./fixtures.mjs";

const BIN_DIRS = fakeBinDirs();
/** 引擎自己判断端口占用；单测里端口是自造的，别真去 connect。 */
const NOT_BUSY = async () => false;
const FRAME = String.fromCharCode(0x1a);
const MAGIC_ADDR = "0x20000000";

// ---------------------------------------------------------------- 假 subprocess

/** 假 subprocess：复刻宿主严格性（cwd 必填），起来后打印三行 Listening（含 tcl 端口）。 */
function makeSubprocess(options = {}) {
  const tclPort = options.tclPort ?? 4445;
  const spawned = [];
  return {
    spawned,
    service: {
      resolveExecutable: (command) => command,
      spawn(spec) {
        if (typeof spec.cwd !== "string") throw new TypeError("Cannot read properties of undefined (reading 'includes')");
        const record = { argv: spec.argv, cwd: spec.cwd, terminated: false };
        spawned.push(record);
        const err = { text: "" };
        let resolveDone;
        const done = new Promise((resolve) => {
          resolveDone = resolve;
        });
        const isOpenOcd = String(spec.argv[0]).toLowerCase().includes("openocd");
        if (!isOpenOcd) {
          setTimeout(() => resolveDone({ exitCode: 0, signal: null }), 20);
        } else {
          setTimeout(() => {
            err.text += "Info : CMSIS-DAP: Interface ready\n";
            err.text += "Info : Listening on port 4444 for telnet connections\n";
            err.text += "Info : Listening on port " + String(tclPort) + " for tcl connections\n";
            err.text += "Info : Listening on port 3333 for gdb connections\n";
          }, 20);
        }
        return {
          done,
          collected: {
            stdout: { readFrom: (offset) => ({ text: "", lossy: false, nextOffset: offset }) },
            stderr: { readFrom: (offset) => ({ text: err.text.slice(offset), lossy: false, nextOffset: err.text.length }) },
          },
          terminate() {
            record.terminated = true;
            resolveDone({ exitCode: null, signal: "SIGTERM" });
          },
          waitForExit() {
            return Promise.resolve();
          },
        };
      },
    },
  };
}

// ---------------------------------------------------------------- 假 Tcl RPC

/**
 * 假 openocd 的 Tcl 口：
 *   - mdw 回控制块三个字（block="ok" 给正确魔数，block="zero" 全 0，block="garbage" 给别的数）；
 *   - rtt setup / rtt start / rtt server ... 回空帧并记进 log；
 *   - 其余命令回 "Error: unknown command"。
 */
async function startFakeTclServer(options = {}) {
  const block = options.block ?? "ok";
  const log = [];
  const sockets = new Set();
  const magic = {
    [MAGIC_ADDR]: "47474553",
    "0x20000004": "52205245",
    "0x20000008": "00005454",
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let frame = buffer.indexOf(FRAME);
      while (frame >= 0) {
        const command = buffer.slice(0, frame).trim();
        buffer = buffer.slice(frame + 1);
        log.push(command);
        let reply = "";
        if (command.startsWith("mdw ")) {
          const address = command.slice(4).trim().toLowerCase();
          if (block === "zero") reply = address + ": 00000000";
          else if (block === "garbage") reply = address + ": deadbeef";
          else reply = address + ": " + (magic[address] ?? "00000000");
        } else if (command.startsWith("rtt ")) {
          reply = "";
        } else {
          reply = "Error: unknown command";
        }
        socket.write(reply + FRAME);
        frame = buffer.indexOf(FRAME);
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    log,
    commands: () => log.slice(),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// ---------------------------------------------------------------- 假 RTT 通道

/**
 * 假 RTT 通道端口：连上来就按 frames 依次写（可选把每帧拆成两次写，模拟半帧）。
 * hold=true 时什么都不写，只握着连接——用来验 stop 会不会把连接关掉。
 */
async function startFakeRttServer(options = {}) {
  const frames = options.frames ?? [];
  const connections = [];
  let closedCount = 0;
  const server = createServer((socket) => {
    const entry = { socket, closed: false };
    connections.push(entry);
    socket.on("error", () => undefined);
    socket.on("close", () => {
      entry.closed = true;
      closedCount += 1;
    });
    if (options.hold === true) return;
    const payloads = options.chunked === true ? frames.flatMap((frame) => [frame.subarray(0, 5), frame.subarray(5)]) : frames;
    let index = 0;
    const push = () => {
      if (index >= payloads.length) return;
      socket.write(payloads[index]);
      index += 1;
      setTimeout(push, 5);
    };
    setTimeout(push, 5);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    connections,
    closedCount: () => closedCount,
    close: async () => {
      for (const connection of connections) connection.socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** 拿一个"现在确实没人监听"的端口：起一个再关掉。 */
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resetAll() {
  await stopRtt();
  await debugSessions.stop("单测重置");
}

/** 一套齐全的环境：调试会话 + 假 Tcl + 假通道。 */
async function setup(options = {}) {
  await resetAll();
  const tcl = await startFakeTclServer({ block: options.block ?? "ok" });
  const fake = makeSubprocess({ tclPort: tcl.port });
  debugSessions.configure(fake.service, BIN_DIRS);
  const ensured = await ensureSession(FIXTURE_PROJECT, { subprocess: fake.service, binDirs: BIN_DIRS, checkPortBusy: NOT_BUSY });
  assert.equal(ensured.ok, true, ensured.message);
  const rtt = await startFakeRttServer({ frames: options.frames ?? [], hold: options.hold === true, chunked: options.chunked === true });
  return { tcl, fake, rtt };
}

// ---------------------------------------------------------------- 工具层小工具

/** 只注册工具、不起进程的假 ctx（和 schema-guard 里的 collectTools 同一个思路）。 */
function collectTools(register, subprocess) {
  const defs = new Map();
  const ctx = {
    tools: { register: (definition) => defs.set(definition.name, definition) },
    get: (name) => (name === "subprocess" ? subprocess : undefined),
  };
  register(ctx);
  return defs;
}

const EXEC = { signal: new AbortController().signal };

/** 手写一个小 schema 校验器：reject null、多余字段、缺必填、类型不符、enum 落空。 */
function checkSchema(schema, value, path, problems) {
  if (value === null || value === undefined) {
    problems.push(path + " 是 " + String(value));
    return;
  }
  if (Array.isArray(value)) {
    if (schema.type !== undefined && schema.type !== "array") problems.push(path + " 应为 array");
    for (let index = 0; index < value.length; index += 1) checkSchema(schema.items ?? {}, value[index], path + "[" + String(index) + "]", problems);
    return;
  }
  if (typeof value === "object") {
    if (schema.type !== undefined && schema.type !== "object") problems.push(path + " 应为 object");
    for (const key of schema.required ?? []) {
      if (!(key in value)) problems.push(path + "." + key + " 缺必填字段");
    }
    for (const [key, item] of Object.entries(value)) {
      const property = (schema.properties ?? {})[key];
      if (property === undefined) {
        if (schema.additionalProperties === false) problems.push(path + "." + key + " 是 schema 里没声明的字段");
        continue;
      }
      checkSchema(property, item, path + "." + key, problems);
    }
    return;
  }
  if (schema.type === "string" && typeof value !== "string") problems.push(path + " 应为 string");
  if (schema.type === "number" && typeof value !== "number") problems.push(path + " 应为 number");
  if (schema.type === "boolean" && typeof value !== "boolean") problems.push(path + " 应为 boolean");
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) problems.push(path + " 不在 enum 里：" + String(value));
}

function assertSchema(value, label) {
  const problems = [];
  checkSchema(rttOutputSchema, value, label, problems);
  assert.deepEqual(problems, [], label + " 不符合 outputSchema：\n" + problems.join("\n"));
}

// ---------------------------------------------------------------- 帧格式（纯函数）

test("帧编解码：encodeRttFrame 编出来再 parseRttFrames 能取回级别与时间戳", () => {
  const frames = [encodeRttFrame({ t: 1234, level: 3, text: "温度 42" }), encodeRttFrame({ t: 5678, level: 1, text: "boom" })];
  const buffer = Buffer.concat(frames);
  const parsed = parseRttFrames(buffer);
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.records, [
    { t: 1234, level: 3, text: "温度 42" },
    { t: 5678, level: 1, text: "boom" },
  ]);
  assert.equal(parsed.rest.length, 0);
  assert.equal(frames[0].length, RTT_FRAME_HEADER_BYTES + Buffer.byteLength("温度 42", "utf8"));
});

test("parseRttFrames：半个帧留在 rest 里，补齐后接着解", () => {
  const whole = encodeRttFrame({ t: 1, level: 2, text: "两句" });
  const first = parseRttFrames(whole.subarray(0, 7));
  assert.equal(first.error, null);
  assert.deepEqual(first.records, []);
  assert.equal(first.rest.length, 7);
  const second = parseRttFrames(Buffer.concat([first.rest, whole.subarray(7)]));
  assert.deepEqual(second.records, [{ t: 1, level: 2, text: "两句" }]);
});

test("parseRttFrames：长度非法 / 级别越界都给失步错误", () => {
  const short = Buffer.alloc(4);
  short.writeUInt32LE(2, 0);
  const badLength = parseRttFrames(short);
  assert.match(String(badLength.error), /帧长度字段/u);

  const badLevel = encodeRttFrame({ t: 1, level: 9, text: "x" });
  const parsed = parseRttFrames(badLevel);
  assert.match(String(parsed.error), /级别字段/u);
  assert.deepEqual(parsed.records, []);
});

// ---------------------------------------------------------------- start

test("startRtt：先 mdw 验控制块，再发 rtt setup / rtt start / rtt server start", async () => {
  const { tcl, rtt } = await setup();
  try {
    const started = await startRtt({ addr: MAGIC_ADDR, port: rtt.port, checkPortBusy: NOT_BUSY });
    assert.equal(started.ok, true, started.message);
    assert.equal(started.addr, MAGIC_ADDR);
    assert.equal(started.size, DEFAULT_RTT_SIZE);
    const commands = tcl.commands();
    assert.deepEqual(commands.slice(0, 3), ["mdw 0x20000000", "mdw 0x20000004", "mdw 0x20000008"]);
    assert.ok(commands.includes("rtt setup 0x20000000 1024"), commands.join(" | "));
    assert.ok(commands.includes("rtt start"), commands.join(" | "));
    assert.ok(commands.includes("rtt server start " + String(rtt.port) + " 0"), commands.join(" | "));
    const snapshot = rttStatus();
    assert.equal(snapshot.running, true);
    assert.equal(snapshot.addr, MAGIC_ADDR);
    assert.equal(snapshot.port, rtt.port);
  } finally {
    await resetAll();
    await tcl.close();
    await rtt.close();
  }
});

test("startRtt：控制块全 0 时不动 openocd，提示去模板里加 RTT", async () => {
  const { tcl, rtt } = await setup({ block: "zero" });
  try {
    const started = await startRtt({ addr: MAGIC_ADDR, port: rtt.port, checkPortBusy: NOT_BUSY });
    assert.equal(started.ok, false);
    assert.equal(started.probeError?.kind, "unknown");
    assert.match(started.probeError?.hint ?? "", /模板/u);
    assert.match(started.message, /^错误：unknown/u);
    assert.equal(rttStatus().running, false);
    assert.equal(tcl.commands().some((command) => command.startsWith("rtt setup")), false);
  } finally {
    await resetAll();
    await tcl.close();
    await rtt.close();
  }
});

test("startRtt：魔数不符时提示核对地址与 .map", async () => {
  const { tcl, rtt } = await setup({ block: "garbage" });
  try {
    const started = await startRtt({ addr: MAGIC_ADDR, port: rtt.port, checkPortBusy: NOT_BUSY });
    assert.equal(started.ok, false);
    assert.match(started.probeError?.hint ?? "", /魔数/u);
    assert.match(started.probeError?.hint ?? "", /map/u);
    assert.equal(tcl.commands().some((command) => command.startsWith("rtt setup")), false);
  } finally {
    await resetAll();
    await tcl.close();
    await rtt.close();
  }
});

test("startRtt：端口被占用时结构化报错，不发任何 rtt 命令", async () => {
  const { tcl, rtt } = await setup();
  try {
    const started = await startRtt({ addr: MAGIC_ADDR, port: rtt.port, checkPortBusy: async () => true });
    assert.equal(started.ok, false);
    assert.equal(started.probeError?.kind, "unknown");
    assert.match(started.probeError?.hint ?? "", /端口/u);
    assert.match(started.message, /已被占用/u);
    assert.equal(tcl.commands().some((command) => command.startsWith("rtt ")), false);
  } finally {
    await resetAll();
    await tcl.close();
    await rtt.close();
  }
});

test("startRtt：magic 常量与 SEGGER RTT 文本一致", () => {
  const bytes = Buffer.alloc(12);
  bytes.writeUInt32LE(RTT_MAGIC_WORD_0, 0);
  bytes.writeUInt32LE(RTT_MAGIC_WORD_1, 4);
  bytes.writeUInt16LE(0x5454, 8);
  assert.equal(bytes.toString("latin1", 0, 10), "SEGGER RTT");
});

test("startRtt：没有活跃会话时给一句怎么办", async () => {
  await resetAll();
  const started = await startRtt({ addr: MAGIC_ADDR, checkPortBusy: NOT_BUSY });
  assert.equal(started.ok, false);
  assert.equal(started.probeError?.kind, "unknown");
  assert.match(started.probeError?.hint ?? "", /stm32_debug_session|stm32_rtt action=start/u);
});

// ---------------------------------------------------------------- dump

test("dumpRtt：解析出帧与时间戳，level 过滤掉更啰嗦的记录", async () => {
  const frames = [
    encodeRttFrame({ t: 10, level: 1, text: "ERR" }),
    encodeRttFrame({ t: 20, level: 3, text: "INFO" }),
    encodeRttFrame({ t: 30, level: 4, text: "DEBUG" }),
  ];
  const { tcl, rtt } = await setup({ frames });
  try {
    const started = await startRtt({ addr: MAGIC_ADDR, port: rtt.port, checkPortBusy: NOT_BUSY });
    assert.equal(started.ok, true, started.message);
    const dumped = await dumpRtt({ seconds: 0.6, level: 2 });
    assert.equal(dumped.ok, true, dumped.message);
    assert.deepEqual(dumped.records, [{ t: 10, level: 1, text: "ERR" }]);
    assert.equal(dumped.dropped, 2);
    assert.ok(dumped.bytes > 0);
    assert.equal(dumped.truncated, false);
  } finally {
    await resetAll();
    await tcl.close();
    await rtt.close();
  }
});

test("dumpRtt：maxRecords 到了就提前收尾并标记 truncated", async () => {
  const frames = [1, 2, 3].map((index) => encodeRttFrame({ t: index, level: 3, text: "line" + String(index) }));
  const { tcl, rtt } = await setup({ frames });
  try {
    await startRtt({ addr: MAGIC_ADDR, port: rtt.port, checkPortBusy: NOT_BUSY });
    const dumped = await dumpRtt({ seconds: 1, maxRecords: 2 });
    assert.equal(dumped.ok, true, dumped.message);
    assert.equal(dumped.records.length, 2);
    assert.equal(dumped.truncated, true);
    assert.deepEqual(dumped.records.map((record) => record.text), ["line1", "line2"]);
  } finally {
    await resetAll();
    await tcl.close();
    await rtt.close();
  }
});

test("dumpRtt：一帧被拆成两次写也能拼起来", async () => {
  const frames = [encodeRttFrame({ t: 7, level: 3, text: "half" }), encodeRttFrame({ t: 8, level: 3, text: "again" })];
  const { tcl, rtt } = await setup({ frames, chunked: true });
  try {
    await startRtt({ addr: MAGIC_ADDR, port: rtt.port, checkPortBusy: NOT_BUSY });
    const dumped = await dumpRtt({ seconds: 0.8 });
    assert.equal(dumped.ok, true, dumped.message);
    assert.deepEqual(dumped.records.map((record) => record.text), ["half", "again"]);
  } finally {
    await resetAll();
    await tcl.close();
    await rtt.close();
  }
});

test("dumpRtt：没 start 时直接说先 starts", async () => {
  await resetAll();
  const dumped = await dumpRtt({ seconds: 0.2 });
  assert.equal(dumped.ok, false);
  assert.equal(dumped.probeError?.kind, "unknown");
  assert.match(dumped.probeError?.hint ?? "", /stm32_rtt action=start/u);
});

test("dumpRtt：通道端口连不上归成 timeout，并给连接建议", async () => {
  // setup() 会同时起一个假 RTT 通道服务端；这个用例故意连别的（死）端口，
  // 但那个服务端也得在 finally 里关掉，否则它的 listen 句柄会吊着进程不退出。
  const { tcl, rtt } = await setup();
  const deadPort = await freePort();
  try {
    const started = await startRtt({ addr: MAGIC_ADDR, port: deadPort, checkPortBusy: NOT_BUSY });
    assert.equal(started.ok, true, started.message);
    const dumped = await dumpRtt({ seconds: 0.3, timeoutMs: 500 });
    assert.equal(dumped.ok, false);
    assert.equal(dumped.probeError?.kind, "timeout");
    assert.match(dumped.probeError?.hint ?? "", /连不上 RTT 通道/u);
  } finally {
    await resetAll();
    await tcl.close();
    await rtt.close();
  }
});

test("dumpRtt：帧对不上时报失步错误而不是死等", async () => {
  const broken = Buffer.alloc(8);
  broken.writeUInt32LE(2, 0);
  const { tcl, rtt } = await setup({ frames: [broken] });
  try {
    await startRtt({ addr: MAGIC_ADDR, port: rtt.port, checkPortBusy: NOT_BUSY });
    const dumped = await dumpRtt({ seconds: 1 });
    assert.equal(dumped.ok, false);
    assert.equal(dumped.probeError?.kind, "unknown");
    assert.match(dumped.probeError?.hint ?? "", /帧约定/u);
    assert.match(dumped.message, /帧长度字段/u);
  } finally {
    await resetAll();
    await tcl.close();
    await rtt.close();
  }
});

// ---------------------------------------------------------------- stop

test("stopRtt：关掉正在读的通道连接，并让 openocd 收掉 rtt server", async () => {
  const { tcl, rtt } = await setup({ hold: true });
  try {
    const started = await startRtt({ addr: MAGIC_ADDR, port: rtt.port, checkPortBusy: NOT_BUSY });
    assert.equal(started.ok, true, started.message);
    const pending = dumpRtt({ seconds: 5 });
    for (let index = 0; index < 100 && rtt.connections.length === 0; index += 1) await sleep(10);
    assert.equal(rtt.connections.length, 1, "dump 应该已经连上通道");
    const stopped = await stopRtt();
    const dumped = await pending;
    assert.equal(stopped.ok, true, stopped.message);
    assert.equal(stopped.stopped, true);
    assert.equal(dumped.stopped, true);
    await sleep(30);
    assert.ok(rtt.closedCount() >= 1, "通道连接应该被关掉");
    assert.equal(rttStatus().running, false);
    const commands = tcl.commands();
    assert.ok(commands.includes("rtt server stop " + String(rtt.port)), commands.join(" | "));
    assert.ok(commands.includes("rtt stop"), commands.join(" | "));
  } finally {
    await resetAll();
    await tcl.close();
    await rtt.close();
  }
});

// ---------------------------------------------------------------- 工具层

test("stm32_rtt start：没有活跃会话时自动起一个，报告符合 outputSchema", async () => {
  await resetAll();
  const tcl = await startFakeTclServer({ block: "ok" });
  const fake = makeSubprocess({ tclPort: tcl.port });
  debugSessions.configure(fake.service, BIN_DIRS);
  const port = await freePort();
  try {
    const defs = collectTools(registerRtt, fake.service);
    const tool = defs.get("stm32_rtt");
    assert.ok(tool !== undefined, "stm32_rtt 应该注册上了");
    assert.equal(tool.parameters.additionalProperties, false);
    assert.deepEqual(tool.parameters.required, ["action"]);
    const value = await tool.execute(
      { action: "start", projectDir: FIXTURE_PROJECT, addr: MAGIC_ADDR, rttPort: port, envCheck: "off" },
      EXEC,
    );
    assert.equal(value.report.ok, true, value.message);
    assert.equal(value.report.running, true);
    assert.equal(value.report.port, port);
    assert.notEqual(sessionInfo(), null, "start 应该自己起了会话");
    assert.equal(fake.spawned.length, 1);
    assertSchema(value.report, "start");
    await stopRtt();
  } finally {
    await resetAll();
    await tcl.close();
  }
});

test("stm32_rtt dump：不需要 subprocess 也能读到记录，报告符合 outputSchema", async () => {
  const frames = [encodeRttFrame({ t: 5, level: 3, text: "hello" })];
  const { tcl, rtt } = await setup({ frames });
  try {
    const started = await startRtt({ addr: MAGIC_ADDR, port: rtt.port, checkPortBusy: NOT_BUSY });
    assert.equal(started.ok, true, started.message);
    const defs = collectTools(registerRtt, undefined);
    const tool = defs.get("stm32_rtt");
    const value = await tool.execute({ action: "dump", projectDir: FIXTURE_PROJECT, seconds: 0.6 }, EXEC);
    assert.equal(value.report.ok, true, value.message);
    assert.deepEqual(value.report.records, [{ t: 5, level: 3, text: "hello" }]);
    assertSchema(value.report, "dump");
  } finally {
    await resetAll();
    await tcl.close();
    await rtt.close();
  }
});

test("stm32_rtt status / stop / 非法 action 都返回完整报告", async () => {
  await resetAll();
  const defs = collectTools(registerRtt, undefined);
  const tool = defs.get("stm32_rtt");

  const status = await tool.execute({ action: "status", projectDir: FIXTURE_PROJECT }, EXEC);
  assert.equal(status.report.ok, true);
  assert.equal(status.report.running, false);
  assertSchema(status.report, "status");

  const stopped = await tool.execute({ action: "stop", projectDir: FIXTURE_PROJECT }, EXEC);
  assert.equal(stopped.report.stopped, false);
  assertSchema(stopped.report, "stop");

  const bogus = await tool.execute({ action: "bogus", projectDir: FIXTURE_PROJECT }, EXEC);
  assert.equal(bogus.report.ok, false);
  assert.ok(bogus.report.errors.length > 0);
  assertSchema(bogus.report, "bogus");
});

test("stm32_rtt start：缺 addr 时给中文说明，不碰 openocd", async () => {
  await resetAll();
  const fake = makeSubprocess({});
  const defs = collectTools(registerRtt, fake.service);
  const tool = defs.get("stm32_rtt");
  const value = await tool.execute({ action: "start", projectDir: FIXTURE_PROJECT, envCheck: "off" }, EXEC);
  assert.equal(value.report.ok, false);
  assert.match(value.message, /addr/u);
  assert.equal(fake.spawned.length, 0);
  assertSchema(value.report, "start-missing-addr");
});

// ---------------------------------------------------------------- 模板端（静态断言，不起进程）

/** 插件根目录（test/ 的上一级）。 */
const PLUGIN_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REG_TEMPLATE = PLUGIN_ROOT + "templates/register/";
const HAL_TEMPLATE = PLUGIN_ROOT + "templates/scaffold/";

const readTemplate = (rel) => readFileSync(REG_TEMPLATE + rel, "utf8");

test("模板：寄存器版自带 rtt.c/rtt.h，CMakeLists 编它、main.c include 它", () => {
  assert.equal(existsSync(REG_TEMPLATE + "Core/Src/rtt.c"), true, "缺 templates/register/Core/Src/rtt.c");
  assert.equal(existsSync(REG_TEMPLATE + "Core/Inc/rtt.h"), true, "缺 templates/register/Core/Inc/rtt.h");

  const cmake = readTemplate("CMakeLists.txt");
  assert.match(cmake, /^\s*Core\/Src\/rtt\.c\s*$/mu, "CMakeLists 的 add_executable 要列 rtt.c");
  assert.match(cmake, /add_executable\(\$\{CMAKE_PROJECT_NAME\}/u);

  const main = readTemplate("Core/Src/main.c");
  assert.match(main, /#include "rtt\.h"/u, "main.c 要 include rtt.h");
  assert.match(main, /\/\* USER CODE BEGIN 2 \*\//u, "示例注释要放在 USER CODE 块里");
  // 「不强制调用」是这套设计的关键：默认 rtt_init() 必须是注释掉的，
  // 否则 --gc-sections 也救不回来，3 KB RAM 白占。
  assert.match(main, /^\s*\*\s+rtt_init\(\);/mu, "main.c 里的 rtt_init() 只能出现在注释示例里");
  assert.doesNotMatch(main, /^\s{4}rtt_init\(\);\s*$/mu, "main.c 不该真的调用 rtt_init()");
});

test("模板：控制块布局与 SEGGER 对齐（ID 在最前 / 描述符 24 字节 / 上行数组偏移 24）", () => {
  const source = readTemplate("Core/Src/rtt.c");
  // 结构体字段顺序：openocd 是按这个顺序读的，错一个字段后面全错位
  assert.match(source, /const char \*sName;/u);
  assert.match(source, /uint8_t \*pBuffer;/u);
  assert.match(source, /uint32_t SizeOfBuffer;/u);
  assert.match(source, /uint32_t WrOff;/u);
  assert.match(source, /volatile uint32_t RdOff;/u);
  assert.match(source, /uint32_t Flags;/u);
  // 字段顺序 + 两个静态断言（把布局钉在编译期）
  assert.ok(
    source.indexOf("const char *sName;") < source.indexOf("volatile uint32_t RdOff;"),
    "描述符字段顺序必须是 sName → pBuffer → SizeOfBuffer → WrOff → RdOff → Flags",
  );
  assert.match(source, /_Static_assert\(sizeof\(rtt_buffer_desc_t\) == 24u/u);
  assert.match(source, /_Static_assert\(offsetof\(rtt_control_block_t, aUp\) == 24u/u);
  assert.match(source, /char acID\[16\];/u);
  assert.match(source, /uint32_t MaxNumUpBuffers;/u);
  assert.match(source, /uint32_t MaxNumDownBuffers;/u);
  // 控制块符号名要固定，不然文档里的 nm | findstr _SEGGER_RTT 就失效
  assert.match(source, /rtt_control_block_t _SEGGER_RTT;/u);
  assert.match(source, /__attribute__\(\(used\)\)/u, "控制块要标 used，否则 -ffunction-sections 下容易被当成未引用");
});

test("模板：控制块魔数（从模板字面量反算）与引擎校验的三个字一致", () => {
  const source = readTemplate("Core/Src/rtt.c");
  const literal = /static const char RTT_ID_TEXT\[\] = "([^"]+)";/u.exec(source);
  assert.ok(literal !== null, "rtt.c 里找不到 RTT_ID_TEXT 字面量");
  assert.equal(literal[1], RTT_MAGIC_TEXT, "模板里的魔数文本要和引擎的 RTT_MAGIC_TEXT 一致");

  // 引擎是这样校验的：在控制块起始处按小端读 word0/word1，再读第 3 个字的低 16 位。
  const block = Buffer.alloc(16);
  block.write(literal[1], 0, "utf8");
  assert.equal(block.readUInt32LE(0), RTT_MAGIC_WORD_0);
  assert.equal(block.readUInt32LE(4), RTT_MAGIC_WORD_1);
  assert.equal(block.readUInt16LE(8), RTT_MAGIC_WORD_2_LOW);

  // ID 必须带结尾 0 一起写进 acID（"SEGGER RTT" 占 11 字节）
  assert.match(source, /memcpy\(_SEGGER_RTT\.acID, RTT_ID_TEXT, sizeof\(RTT_ID_TEXT\)\)/u);
  assert.match(source, /_SEGGER_RTT\.MaxNumUpBuffers = \(uint32_t\)RTT_UP_CHANNELS;/u);
});

test("模板：帧头 13 字节 / 最小长度 9 / 级别 1..4 与引擎常量一致", () => {
  const source = readTemplate("Core/Src/rtt.c");
  const header = /#define RTT_FRAME_OVERHEAD (\d+)u/u.exec(source);
  const min = /#define RTT_FRAME_MIN_BYTES (\d+)u/u.exec(source);
  assert.ok(header !== null && min !== null, "rtt.c 里找不到帧格式常量");
  assert.equal(Number(header[1]), RTT_FRAME_HEADER_BYTES, "4B 长度 + 1B 级别 + 8B 时间戳 = 13");
  assert.equal(Number(min[1]), RTT_MIN_FRAME_BYTES);

  const headerSource = readTemplate("Core/Inc/rtt.h");
  assert.match(headerSource, new RegExp("#define RTT_LEVEL_ERROR " + String(RTT_MIN_LEVEL) + "u", "u"));
  assert.match(headerSource, new RegExp("#define RTT_LEVEL_DEBUG " + String(RTT_MAX_LEVEL) + "u", "u"));

  // 长度字段 = 9 + payload：写端必须先算长度再搬 payload
  assert.match(source, /rtt_put_u32\(&frame\[0\], RTT_FRAME_MIN_BYTES \+ payload\)/u);
  // 级别越界要夹住，不能把 0/5 写进帧里（dump 端会把它判成失步）
  assert.match(source, /if \(level < RTT_LEVEL_ERROR\)/u);
  assert.match(source, /if \(level > RTT_LEVEL_DEBUG\)/u);
});

test("模板：HAL 脚手架只留 USER CODE 钩子说明，不把 rtt.c 塞进 CubeMX 生成区", () => {
  assert.equal(existsSync(HAL_TEMPLATE + "RTT.md"), true, "HAL 脚手架要带 RTT.md 说明");
  assert.equal(existsSync(HAL_TEMPLATE + "Core/Src/rtt.c"), false, "HAL 模板不该预置 rtt.c（Core/** 是生成区）");
  assert.equal(existsSync(HAL_TEMPLATE + "Core/Inc/rtt.h"), false);

  const guide = readFileSync(HAL_TEMPLATE + "RTT.md", "utf8");
  assert.match(guide, /USER CODE BEGIN Includes/u);
  assert.match(guide, /USER CODE BEGIN 2/u);
  assert.match(guide, /stm32_rtt action=start/u);
  assert.match(guide, /nm .*_SEGGER_RTT/u, "要教用户怎么拿控制块地址");

  // 唯一的构建钩子在 cmake/user/CMakeLists.txt（CubeMX 不生成它的内容）
  const hook = readFileSync(HAL_TEMPLATE + "cmake/user/CMakeLists.txt", "utf8");
  assert.match(hook, /App\/rtt\.c/u);
  assert.match(hook, /RTT\.md/u);
});

test("模板：rtt_printf 的 newlib 依赖有兜底（弱符号 _sbrk），加一行不用改 syscalls", () => {
  const source = readTemplate("Core/Src/rtt.c");
  // 实测：只取消 main.c 里 rtt_init()/rtt_printf() 的注释，链接会报
  // undefined reference to _sbrk ——寄存器版模板没有 syscalls.c。
  assert.match(source, /__attribute__\(\(weak\)\) void \*_sbrk\(ptrdiff_t increment\)/u);
  assert.match(source, /#if defined\(RTT_HAVE_STDIO\)/u, "兜底要跟 vsnprintf 一样受 stdio 开关约束");

  const headerSource = readTemplate("Core/Inc/rtt.h");
  assert.match(headerSource, /弱符号/u, "rtt.h 要写清 _sbrk 是弱符号、可被自己的 syscalls.c 覆盖");
  assert.match(headerSource, /syscalls\.c/u);

  const guide = readFileSync(HAL_TEMPLATE + "RTT.md", "utf8");
  assert.match(guide, /_sbrk/u, "RTT.md 的代价清单里要提 newlib/_sbrk");
});
