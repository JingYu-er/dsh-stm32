// stm32_serial 工具层单测：全部走 test/fixtures/serial-fake-bridge.mjs（Node 假桥），
// 不碰 PowerShell、不碰真串口，所以能在任何机器上跑。
//
// 关键点：引擎是单会话 + 模块级状态，所以这里的用例顺序有意义（每个用例自己 open、afterEach 收尾）。
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bridgeScript = fileURLToPath(new URL("./fixtures/serial-fake-bridge.mjs", import.meta.url));

const root = mkdtempSync(join(tmpdir(), "dsh-stm32-serial-units-"));
process.env.USERPROFILE = root;
process.env.HOME = root;
// run-units.mjs 会设 DSH_STM32_NO_CONFIG=1（让所有配置当不存在）；这里要测端口记忆的落盘，
// 但配置文件已经指向临时目录，所以直接把它摘掉。
delete process.env.DSH_STM32_NO_CONFIG;
process.env.DSH_STM32_SERIAL_HOME = join(root, "sessions");
process.env.DSH_STM32_SERIAL_CONFIG = join(root, "serial.json");
process.env.DSH_STM32_SERIAL_BRIDGE = bridgeScript;
process.env.OS = "Windows_NT";
process.env.DSH_STM32_SERIAL_PORTS = JSON.stringify([
  {
    port: "COM7",
    description: "STLink Virtual COM Port",
    vid: "0483",
    pid: "5740",
    serialNumber: "FAKE0001",
    location: "1-2",
    pnpId: "USB\\VID_0483&PID_5740\\FAKE0001",
  },
  {
    port: "COM8",
    description: "USB-SERIAL CH340",
    vid: "1A86",
    pid: "7523",
    serialNumber: "",
    location: "1-3",
    pnpId: "USB\\VID_1A86&PID_7523\\5&1234&0&1",
  },
]);

const { registerSerial, reportSchema } = await import("../lib/tools/serial.js");
const { cleanupSerialOnTurnEnd, pidAlive } = await import("../lib/engine/serial.js");

const defs = new Map();
registerSerial({
  tools: {
    register(def) {
      defs.set(def.name, def);
      return () => undefined;
    },
  },
});
const tool = defs.get("stm32_serial");
assert.ok(tool, "registerSerial 应该注册 stm32_serial");

const exec = { signal: new AbortController().signal };

/** 临时改环境变量（桥的测试钩子/平台模拟），结束时原样还原。 */
async function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function call(args) {
  const value = await tool.execute(args, exec);
  assert.ok(value && typeof value.message === "string", "工具必须返回 {message, report}");
  return value.report;
}

/** report 的必填字段一个都不能少、也不能多出来（宿主按 output schema 校验）。 */
function assertShape(report, action) {
  assert.equal(report.action, action, "report.action 与请求不一致");
  for (const key of reportSchema.required) {
    assert.ok(Object.prototype.hasOwnProperty.call(report, key), action + " 的 report 缺字段 " + key);
  }
  const allowed = new Set(Object.keys(reportSchema.properties));
  for (const key of Object.keys(report)) {
    assert.ok(allowed.has(key), action + " 的 report 多出字段 " + key);
  }
}

afterEach(async () => {
  // 每个用例收尾：有会话就关掉，免得影响下一个用例
  const report = await call({ action: "close" });
  assertShape(report, "close");
});

test("list：解析端口并按 USB 序列号算身份", async () => {
  const report = await call({ action: "list" });
  assertShape(report, "list");
  assert.equal(report.ok, true, report.errors.join("；"));
  assert.equal(report.ports.length, 2);
  assert.equal(report.platform, process.env.OS === "Windows_NT" ? "win32" : report.platform);
  const stlink = report.ports.find((port) => port.port === "COM7");
  assert.ok(stlink, "应该列出 COM7");
  assert.equal(stlink.identity, "usb:0483:5740:FAKE0001");
  assert.equal(stlink.serialNumber, "FAKE0001");
  const ch340 = report.ports.find((port) => port.port === "COM8");
  assert.ok(ch340, "应该列出 COM8");
  assert.equal(ch340.identity, "usb:1A86:7523@1-3", "没有序列号时退到 VID:PID@位置");
  assert.ok(report.configPath.endsWith("serial.json"), "configPath 应该指向 serial.json");
});

test("非 Windows：unsupported-platform", async () => {
  const saved = process.env.OS;
  process.env.OS = "Linux";
  try {
    const report = await call({ action: "list" });
    assertShape(report, "list");
    assert.equal(report.ok, false);
    assert.equal(report.serialError?.kind, "unsupported-platform");
    assert.ok(report.errors[0].includes("unsupported-platform"), report.errors[0]);
  } finally {
    process.env.OS = saved;
  }
});

test("open：默认 115200 8N1 + status open", async () => {
  const report = await call({ action: "open", port: "com7" });
  assertShape(report, "open");
  assert.equal(report.ok, true, report.errors.join("；"));
  assert.equal(report.port, "COM7", "端口名统一成大写 COMx");
  assert.equal(report.state, "open");
  assert.ok(report.bridgePid > 0, "应该记下桥的 pid");
  assert.equal(report.bridgeAlive, true);
  const settings = report.settings;
  assert.equal(settings.baudRate, 115200);
  assert.equal(settings.dataBits, 8);
  assert.equal(settings.stopBits, "1");
  assert.equal(settings.parity, "none");
  assert.equal(settings.flow, "none");
  assert.equal(settings.dtr, false);
  assert.equal(settings.rts, false);
  assert.equal(settings.encoding, "utf8");
  assert.equal(settings.newline, "crlf");
  assert.equal(settings.persist, false);
  assert.ok(report.notes.some((note) => note.startsWith("桥：")), "notes 里应该有桥的信息");
});

test("open 幂等：第二次 open 报 already-open", async () => {
  const first = await call({ action: "open", port: "COM7" });
  assert.equal(first.ok, true, first.errors.join("；"));
  const second = await call({ action: "open", port: "COM7" });
  assertShape(second, "open");
  assert.equal(second.ok, false);
  assert.equal(second.serialError?.kind, "already-open");
});

test("send + read cursor：只拿新行", async () => {
  await call({ action: "open", port: "COM7" });
  const sent = await call({ action: "send", text: "hello" });
  assertShape(sent, "send");
  assert.equal(sent.ok, true, sent.errors.join("；"));
  assert.ok(sent.bytes >= "hello".length);
  assert.equal(sent.text, "hello");

  const first = await call({ action: "read" });
  assertShape(first, "read");
  assert.equal(first.ok, true, first.errors.join("；"));
  assert.deepEqual(first.records.map((record) => record.d), ["hello"]);
  assert.equal(first.nextCursor, first.fileBytes);
  assert.ok(first.fileBytes > 0);

  const cursor = first.nextCursor;
  await call({ action: "send", text: "world" });
  const second = await call({ action: "read", cursor });
  assertShape(second, "read");
  assert.equal(second.ok, true);
  assert.deepEqual(second.records.map((record) => record.d), ["world"], "cursor 之后只应有 world");
  assert.ok(second.nextCursor > cursor);

  const third = await call({ action: "read", cursor: second.nextCursor });
  assert.equal(third.ok, true);
  assert.equal(third.records.length, 0, "没有新行时应该给空数组而不是报错");
  assert.ok(third.message.includes("没有新行"), third.message);
});

test("hex：按会话编码反解后发送", async () => {
  await call({ action: "open", port: "COM7" });
  const sent = await call({ action: "send", hex: "48 65 6C 6C 6F" });
  assertShape(sent, "send");
  assert.equal(sent.ok, true, sent.errors.join("；"));
  assert.equal(sent.text, "Hello");
  const read = await call({ action: "read" });
  assert.deepEqual(read.records.map((record) => record.d), ["Hello"]);

  const bad = await call({ action: "send", hex: "48 6" });
  assert.equal(bad.ok, false);
  assert.equal(bad.serialError?.kind, "settings-invalid");

  const both = await call({ action: "send", text: "a", hex: "41" });
  assert.equal(both.ok, false);
  assert.equal(both.serialError?.kind, "settings-invalid");
});

test("transact：until 命中与超时", async () => {
  await call({ action: "open", port: "COM7" });
  const hit = await call({ action: "transact", text: "PING", until: "PONG", timeoutMs: 3000 });
  assertShape(hit, "transact");
  assert.equal(hit.ok, true, hit.errors.join("；"));
  assert.equal(hit.matched, true);
  assert.equal(hit.matchedLine, "PONG");
  assert.ok(hit.records.some((record) => record.d === "PONG"));

  const miss = await call({ action: "transact", text: "HELLO", until: "NOPE", timeoutMs: 300 });
  assertShape(miss, "transact");
  assert.equal(miss.ok, true, "超时不算失败");
  assert.equal(miss.matched, false);
  assert.equal(miss.truncated, false, "truncated 只表示读到的只是尾部，不能拿来表示等不到 until");
  assert.ok(miss.notes.some((note) => note.includes("timeoutMs")), "超时要给提示");
});

test("参数校验：parity / baudRate 不合法都在 open 前拦住", async () => {
  const parity = await call({ action: "open", port: "COM7", parity: "foo" });
  assertShape(parity, "open");
  assert.equal(parity.ok, false);
  assert.equal(parity.serialError?.kind, "settings-invalid");

  const baud = await call({ action: "open", port: "COM7", baudRate: 0 });
  assert.equal(baud.ok, false);
  assert.equal(baud.serialError?.kind, "settings-invalid");
});

test("缺 action / 未知 action", async () => {
  const missing = await call({});
  assertShape(missing, "");
  assert.equal(missing.ok, false);
  assert.ok(missing.message.includes("缺少 action"));

  const unknown = await call({ action: "nope" });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.message.includes("未知 action"));
});

test("no-session：read/send/close/status 都说得清楚", async () => {
  const read = await call({ action: "read" });
  assertShape(read, "read");
  assert.equal(read.ok, false);
  assert.equal(read.serialError?.kind, "no-session");

  const send = await call({ action: "send", text: "x" });
  assert.equal(send.ok, false);
  assert.equal(send.serialError?.kind, "no-session");

  const close = await call({ action: "close" });
  assert.equal(close.ok, false);
  assert.equal(close.serialError?.kind, "no-session");

  const status = await call({ action: "status" });
  assertShape(status, "status");
  assert.equal(status.ok, true, "没有会话时 status 仍然是一次成功的信息查询");
  assert.equal(status.state, "closed");
  assert.equal(status.bridgePid, 0);
});

test("status：报告会话、桥、文件大小", async () => {
  const opened = await call({ action: "open", port: "COM7" });
  assert.equal(opened.ok, true, opened.errors.join("；"));
  await call({ action: "send", text: "one" });
  const status = await call({ action: "status" });
  assertShape(status, "status");
  assert.equal(status.ok, true);
  assert.equal(status.sessionId, opened.sessionId);
  assert.equal(status.state, "open");
  assert.equal(status.bridgePid, opened.bridgePid);
  assert.equal(status.bridgeAlive, true);
  assert.ok(status.notes.some((note) => note.includes("rx")), "notes 里应该报告文件大小");
});

test("status：残留（stale）会话目录能被指出来", async () => {
  const staleDir = join(process.env.DSH_STM32_SERIAL_HOME, "dead-session");
  mkdirSync(staleDir, { recursive: true });
  writeFileSync(join(staleDir, "bridge.pid"), "2147483646", "utf8");
  writeFileSync(join(staleDir, "status.json"), JSON.stringify({ state: "open", pid: 2147483646, sessionId: "dead-session", port: "COM9" }), "utf8");
  const status = await call({ action: "status" });
  assertShape(status, "status");
  assert.equal(status.ok, true);
  assert.ok(
    status.notes.some((note) => /死的 [1-9]/.test(note)),
    "notes 里应指出死会话目录：" + JSON.stringify(status.notes),
  );
});

test("bridge crash：send 等不到回执且 pid 已死 → bridge-crashed", async () => {
  const opened = await call({ action: "open", port: "COM7" });
  assert.equal(opened.ok, true, opened.errors.join("；"));
  const sent = await call({ action: "send", text: "CRASH" });
  assertShape(sent, "send");
  assert.equal(sent.ok, false);
  assert.equal(sent.serialError?.kind, "bridge-crashed", JSON.stringify(sent.serialError));
});

test("ack 超时：桥活着但没回执 → bridge-start-timeout", async () => {
  const opened = await call({ action: "open", port: "COM7" });
  assert.equal(opened.ok, true, opened.errors.join("；"));
  const sent = await call({ action: "send", text: "SLOW" });
  assertShape(sent, "send");
  assert.equal(sent.ok, false);
  assert.equal(sent.serialError?.kind, "bridge-start-timeout", JSON.stringify(sent.serialError));
  assert.equal(sent.serialError.retryable, true);
});

test("idle：bridge 按 idleTimeoutMs 自行退出，之后 read 报 no-session", async () => {
  const opened = await call({ action: "open", port: "COM7", idleTimeoutMs: 400 });
  assert.equal(opened.ok, true, opened.errors.join("；"));
  const deadline = Date.now() + 6000;
  let last = null;
  while (Date.now() < deadline) {
    last = await call({ action: "read" });
    if (last.ok === false) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.ok(last, "应该至少读一次");
  assert.equal(last.ok, false, "桥空闲退出后 read 应该失败");
  assert.equal(last.serialError?.kind, "no-session");
});


test("open 超时：收掉慢桥，不留活孤儿", async () => {
  const report = await withEnv({ DSH_STM32_SERIAL_FAKE_SLOW_OPEN_MS: "7000" }, () => call({ action: "open", port: "COM7" }));
  assertShape(report, "open");
  assert.equal(report.ok, false);
  assert.equal(report.serialError?.kind, "bridge-start-timeout", JSON.stringify(report.serialError));
  assert.ok(report.bridgePid > 0, "报告里要能指出那个 pid");
  assert.equal(pidAlive(report.bridgePid), false, "超时的桥必须被收掉，不能继续占着 COM 口");
  assert.ok(
    report.notes.some((note) => note.includes("已终止启动失败的桥进程")),
    "notes 里要说明已经收尸：" + JSON.stringify(report.notes),
  );
  const status = await call({ action: "status" });
  assert.equal(status.ok, true);
  // 目录刻意不删（bridge.log 是唯一线索），pid 已死 → 算 stale，turn/end 会清
  assert.ok(status.notes.some((note) => note.includes("死的")), JSON.stringify(status.notes));
  const cleanup = await cleanupSerialOnTurnEnd({});
  assert.ok(cleanup.removedSessions.length >= 1, "死目录应该被 turn/end 清掉");
});

test("并发 open：只起一个桥，另一个 already-open", async () => {
  const [first, second] = await Promise.all([
    call({ action: "open", port: "COM7" }),
    call({ action: "open", port: "COM8" }),
  ]);
  const opened = [first, second].find((report) => report.ok === true);
  const denied = [first, second].find((report) => report.ok === false);
  assert.ok(opened, "两次并发 open 里应该有一次成功");
  assert.ok(denied, "另一次应该被拒");
  assert.equal(denied.serialError?.kind, "already-open", JSON.stringify(denied.serialError));
  assert.equal(pidAlive(opened.bridgePid), true);
  const status = await call({ action: "status" });
  assert.equal(status.ok, true);
  assert.equal(status.sessionId, opened.sessionId, "active 只应记下真正打开的那个会话");
});

test("open 失败分类：port-busy / access-denied / port-not-found", async () => {
  for (const kind of ["port-busy", "access-denied"]) {
    const report = await withEnv({ DSH_STM32_SERIAL_FAKE_FAIL: kind }, () => call({ action: "open", port: "COM7" }));
    assertShape(report, "open");
    assert.equal(report.ok, false);
    assert.equal(report.serialError?.kind, kind, JSON.stringify(report.serialError));
    assert.ok(report.serialError.hint !== "", "错误要带中文 hint");
  }
  const missing = await call({ action: "open", port: "COM42" });
  assertShape(missing, "open");
  assert.equal(missing.ok, false);
  assert.equal(missing.serialError?.kind, "port-not-found", JSON.stringify(missing.serialError));
  await cleanupSerialOnTurnEnd({});
});

test("transact：非法正则报 settings-invalid，不是内部异常", async () => {
  const opened = await call({ action: "open", port: "COM7" });
  assert.equal(opened.ok, true, opened.errors.join("；"));
  const bad = await call({ action: "transact", text: "PING", until: "[", timeoutMs: 100 });
  assertShape(bad, "transact");
  assert.equal(bad.ok, false);
  assert.equal(bad.serialError?.kind, "settings-invalid", JSON.stringify(bad.serialError));
  assert.ok(bad.message.includes("正则"), bad.message);
});

test("turn/end 清理：persist=true 保留，persist=false 关掉", async () => {
  const opened = await call({ action: "open", port: "COM7", persist: true });
  assert.equal(opened.ok, true, opened.errors.join("；"));
  const kept = await cleanupSerialOnTurnEnd({});
  assert.equal(kept.keptSession, opened.sessionId);
  assert.equal(kept.closed, false);
  assert.equal(pidAlive(opened.bridgePid), true, "persist=true 的会话必须留着");
  const status = await call({ action: "status" });
  assert.ok(status.notes.some((note) => note.includes("persist=true")), JSON.stringify(status.notes));
  assert.equal((await call({ action: "close" })).ok, true);

  const normal = await call({ action: "open", port: "COM7" });
  assert.equal(normal.ok, true, normal.errors.join("；"));
  const cleanup = await cleanupSerialOnTurnEnd({});
  assert.equal(cleanup.closed, true);
  assert.equal(pidAlive(normal.bridgePid), false, "turn/end 之后桥必须退出");
});

test("端口记忆复用 + open 报告显示会话实际的 5 个会话参数", async () => {
  const first = await call({
    action: "open",
    port: "COM7",
    baudRate: 57600,
    dataBits: 7,
    timeoutMs: 2500,
    maxLines: 12,
    maxBytes: 4096,
    idleTimeoutMs: 30000,
  });
  assert.equal(first.ok, true, first.errors.join("；"));
  assert.equal(first.settings.baudRate, 57600);
  assert.equal(first.settings.timeoutMs, 2500, "open 报告要给本次实际值，不是默认 1000");
  assert.equal(first.settings.maxLines, 12);
  assert.equal(first.settings.maxBytes, 4096);
  assert.equal(first.settings.idleTimeoutMs, 30000);
  assert.equal((await call({ action: "close" })).ok, true);

  const second = await call({ action: "open", port: "COM7" });
  assert.equal(second.ok, true, second.errors.join("；"));
  assert.equal(second.settings.baudRate, 57600, "参数应按 USB 序列号复用");
  assert.equal(second.settings.dataBits, 7);
  assert.ok(second.notes.some((note) => note.includes("参数取自")), JSON.stringify(second.notes));
  // 端口记忆只记「线的参数」；timeoutMs/maxLines 这些是每次会话自己的行为参数，
  // 不该跟着端口跑（否则上次调大的上限会悄悄影响下一次）。
  assert.equal(second.settings.timeoutMs, 1000, "会话参数不随端口记忆");
  assert.equal(second.settings.maxLines, 200);
});

test("read：不给 maxLines/maxBytes 时用打开会话时的值", async () => {
  const opened = await call({ action: "open", port: "COM7", maxLines: 3 });
  assert.equal(opened.ok, true, opened.errors.join("；"));
  for (const text of ["l1", "l2", "l3", "l4", "l5"]) {
    const sent = await call({ action: "send", text });
    assert.equal(sent.ok, true, sent.errors.join("；"));
  }
  const read = await call({ action: "read" });
  assertShape(read, "read");
  assert.equal(read.ok, true, read.errors.join("；"));
  assert.deepEqual(read.records.map((record) => record.d), ["l3", "l4", "l5"], "应只返回会话 maxLines=3 行");
});

test("status：活着的孤儿桥能被指出来", async () => {
  const orphanDir = join(process.env.DSH_STM32_SERIAL_HOME, "orphan-session");
  mkdirSync(orphanDir, { recursive: true });
  writeFileSync(join(orphanDir, "bridge.pid"), String(process.pid), "utf8");
  writeFileSync(
    join(orphanDir, "status.json"),
    JSON.stringify({ state: "open", pid: process.pid, sessionId: "orphan-session", port: "COM99" }),
    "utf8",
  );
  try {
    const status = await call({ action: "status" });
    assertShape(status, "status");
    assert.equal(status.ok, true);
    assert.ok(status.notes.some((note) => note.includes("孤儿桥")), JSON.stringify(status.notes));
  } finally {
    rmSync(orphanDir, { recursive: true, force: true });
  }
});

