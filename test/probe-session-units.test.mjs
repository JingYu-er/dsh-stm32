// B3 会话复用快路径单测：node --test test/probe-session-units.test.mjs
// 全假：假 subprocess（不真起 openocd/gdb）+ 本地假 Tcl 服务端（127.0.0.1 随机端口）。
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";

import { debugSessions, parseListeningPorts } from "../lib/engine/debug-session.js";
import {
  DEFAULT_PROBE_PORT,
  ensureSession,
  parseMdwReply,
  parsePcReply,
  readWordsViaSession,
  release,
  sessionInfo,
  tclRoundTrip,
  touch,
  withSession,
} from "../lib/engine/probe-session.js";

import { FIXTURE_PROJECT, fakeBinDirs } from "./fixtures.mjs";

const BIN_DIRS = fakeBinDirs();
/** 测试里永远不真的去探测 3333（CI/本机可能恰好占着），端口占用用例自己注入。 */
const NOT_BUSY = async () => false;
const FRAME = String.fromCharCode(0x1a);

/**
 * 假 subprocess：复刻宿主严格性（cwd 必填）+ 收集式偏移读取。
 * mode="ok" → 起来后打印三行 Listening（含 tcl 端口）；
 * mode="no-tcl" → 只有 gdb 那行（快路径要能优雅回退）；
 * mode="fail" → 打印 CMSIS-DAP 的错误后立刻退出（归类 no-probe）。
 */
function makeSubprocess(options = {}) {
  const mode = options.mode ?? "ok";
  const tclPort = options.tclPort ?? 4445;
  const spawned = [];
  return {
    spawned,
    service: {
      resolveExecutable: (command) => command,
      spawn(spec) {
        if (typeof spec.cwd !== "string") throw new TypeError("Cannot read properties of undefined (reading 'includes')");
        const isOpenOcd = String(spec.argv[0]).toLowerCase().includes("openocd");
        const record = { argv: spec.argv, cwd: spec.cwd, terminated: false };
        spawned.push(record);
        const out = { text: "" };
        const err = { text: "" };
        let resolveDone;
        const done = new Promise((resolve) => {
          resolveDone = resolve;
        });
        if (!isOpenOcd) {
          setTimeout(() => resolveDone({ exitCode: 0, signal: null }), 20);
        } else if (mode === "fail") {
          setTimeout(() => {
            err.text += "Error: CMSIS-DAP command CMD_INFO failed.\n";
            resolveDone({ exitCode: 1, signal: null });
          }, 20);
        } else {
          setTimeout(() => {
            err.text += "Info : CMSIS-DAP: Interface ready\n";
            if (mode === "ok") {
              err.text += "Info : Listening on port 4444 for telnet connections\n";
              err.text += "Info : Listening on port " + String(tclPort) + " for tcl connections\n";
            }
            err.text += "Info : Listening on port 3333 for gdb connections\n";
          }, 20);
        }
        return {
          done,
          collected: {
            stdout: { readFrom: (offset) => ({ text: out.text.slice(offset), lossy: false, nextOffset: out.text.length }) },
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

/** 每个用例开头把单例清干净（单例是模块级的，用例之间必须互不影响）。 */
async function resetSession() {
  await debugSessions.stop("单测重置");
}

/** 假 openocd 的 Tcl 口：按 0x1a 分帧收命令、回同帧格式的响应。 */
async function startFakeTclServer(options = {}) {
  const values = options.values ?? {};
  const sockets = new Set();
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
        let reply = "";
        if (command === "halt" || command === "resume") reply = "";
        else if (command === "reg pc") reply = "pc (/32): 0x0800012c";
        else if (command.startsWith("mdw ")) {
          const address = command.slice(4).trim().toLowerCase();
          reply = address + ": " + (values[address] ?? "00000000");
        } else reply = "Error: unknown command";
        socket.write(reply + FRAME);
        frame = buffer.indexOf(FRAME);
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("parseListeningPorts：三行分别解析，乱序/未知服务都不影响", () => {
  const text = [
    "Info : Listening on port 4444 for telnet connections",
    "Info : x",
    "Info : Listening on port 5555 for tcl connections",
    "Info : Listening on port 3333 for gdb connections",
  ].join("\n");
  assert.deepEqual(parseListeningPorts(text), { gdb: 3333, tcl: 5555, telnet: 4444 });
  // 同一服务出现两次：取第一条（openocd 只报一次，重复多半是日志被回放了）
  assert.equal(parseListeningPorts("Listening on port 6666 for tcl connections\nListening on port 7777 for tcl connections").tcl, 6666);
  // 老版本只报 gdb：tcl 就是 0，调用方要能回退
  assert.equal(parseListeningPorts("Info : Listening on port 3333 for gdb connections").tcl, 0);
});

test("parseMdwReply / parsePcReply：常规回显与裸值都要认", () => {
  assert.deepEqual(parseMdwReply("0x4001100c: 00000020"), { address: "0x4001100c", value: "0x00000020" });
  assert.deepEqual(parseMdwReply("0x4001100C: 0x2004"), { address: "0x4001100c", value: "0x00002004" });
  assert.deepEqual(parseMdwReply("00000020"), { address: "", value: "0x00000020" });
  assert.equal(parseMdwReply("Error: Can't read"), null);
  assert.equal(parsePcReply("pc (/32): 0x0800012c"), "0x0800012c");
  assert.equal(parsePcReply("pc: 0x0800012C"), "0x0800012c");
  assert.equal(parsePcReply("0x20004fdc"), "0x20004fdc");
});

test("sessionInfo：没有会话时是 null", async () => {
  await resetSession();
  assert.equal(sessionInfo(), null);
});

test("ensureSession：首次起会话，tcl 端口从日志里解析出来", async () => {
  await resetSession();
  const server = await startFakeTclServer();
  try {
    const fake = makeSubprocess({ tclPort: server.port });
    debugSessions.configure(fake.service, BIN_DIRS);
    const ensured = await ensureSession(FIXTURE_PROJECT, { checkPortBusy: NOT_BUSY });
    assert.equal(ensured.ok, true, ensured.message);
    assert.equal(ensured.reused, false);
    assert.equal(fake.spawned.length, 1, "只该起一个 openocd");
    assert.match(String(fake.spawned[0].argv[0]), /openocd/u);
    const info = sessionInfo();
    assert.equal(info.port, DEFAULT_PROBE_PORT);
    assert.equal(info.tclPort, server.port, "tcl 端口必须从启动日志里解析到");
    assert.ok(info.idleDeadline > Date.now(), "要有一个未来的租约到期时刻");
  } finally {
    await server.close();
    await resetSession();
  }
});

test("ensureSession：第二次直接复用，不再 spawn", async () => {
  await resetSession();
  const fake = makeSubprocess({ tclPort: 4446 });
  debugSessions.configure(fake.service, BIN_DIRS);
  const first = await ensureSession(FIXTURE_PROJECT, { checkPortBusy: NOT_BUSY });
  const second = await ensureSession(FIXTURE_PROJECT, { checkPortBusy: NOT_BUSY });
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.ok, true);
  assert.equal(fake.spawned.length, 1, "复用会话不能再起 openocd");
  assert.match(second.message, /复用/u);
  await resetSession();
});

test("ensureSession：端口被占时报 probe-busy，不抢探针、不 spawn", async () => {
  await resetSession();
  const fake = makeSubprocess();
  debugSessions.configure(fake.service, BIN_DIRS);
  const ensured = await ensureSession(FIXTURE_PROJECT, { checkPortBusy: async () => true });
  assert.equal(ensured.ok, false);
  assert.equal(ensured.probeError?.kind, "probe-busy");
  assert.equal(ensured.probeError?.retryable, true);
  assert.match(ensured.message, /^错误：probe-busy —/u);
  assert.match(ensured.message, /建议：/u);
  assert.equal(fake.spawned.length, 0, "端口被占时一个进程都不该起");
  assert.equal(debugSessions.isActive(), false);
});

test("并发两次 ensureSession：只起一个 openocd", async () => {
  await resetSession();
  const fake = makeSubprocess({ tclPort: 4447 });
  debugSessions.configure(fake.service, BIN_DIRS);
  const [left, right] = await Promise.all([
    ensureSession(FIXTURE_PROJECT, { checkPortBusy: NOT_BUSY }),
    ensureSession(FIXTURE_PROJECT, { checkPortBusy: NOT_BUSY }),
  ]);
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  assert.equal(fake.spawned.length, 1, "并发申请只允许起一个进程");
  await resetSession();
});

test("10 连读快路径：复用会话 + 每次都走 Tcl，单次 < 150 ms、总计 < 1500 ms", async () => {
  await resetSession();
  const server = await startFakeTclServer({ values: { "0x4001100c": "00000020" } });
  try {
    const fake = makeSubprocess({ tclPort: server.port });
    debugSessions.configure(fake.service, BIN_DIRS);
    assert.equal((await ensureSession(FIXTURE_PROJECT, { checkPortBusy: NOT_BUSY })).ok, true);

    const durations = [];
    const startedAt = Date.now();
    for (let round = 0; round < 10; round += 1) {
      const read = await readWordsViaSession({ addresses: ["0x4001100C"], timeoutMs: 3000 });
      assert.equal(read.ok, true, "第 " + String(round + 1) + " 次读失败：" + String(read.error) + " / " + read.output);
      assert.equal(read.pc, "0x0800012c");
      assert.equal(read.samples[0].value, "0x00000020");
      durations.push(read.durationMs);
    }
    const totalMs = Date.now() - startedAt;
    assert.equal(fake.spawned.length, 1, "10 次读只允许一个 openocd");
    assert.ok(Math.max(...durations) < 150, "单次读最慢 " + String(Math.max(...durations)) + " ms，要求 < 150 ms");
    assert.ok(totalMs < 1500, "10 次读总耗时 " + String(totalMs) + " ms，要求 < 1500 ms");
  } finally {
    await server.close();
    await resetSession();
  }
});

test("readWordsViaSession：没有会话时干净失败（不抛）", async () => {
  await resetSession();
  const read = await readWordsViaSession({ addresses: ["0x4001100C"] });
  assert.equal(read.ok, false);
  assert.match(String(read.error), /没有可复用的调试会话/u);
  assert.deepEqual(read.samples, []);
});

test("readWordsViaSession：会话没有 Tcl 端口时回退提示（老 openocd）", async () => {
  await resetSession();
  const fake = makeSubprocess({ mode: "no-tcl" });
  debugSessions.configure(fake.service, BIN_DIRS);
  const ensured = await ensureSession(FIXTURE_PROJECT, { checkPortBusy: NOT_BUSY });
  assert.equal(ensured.ok, true, "没有 tcl 端口也要能起会话（只是快路径不可用）");
  assert.equal(sessionInfo().tclPort, 0);
  const read = await readWordsViaSession({ addresses: ["0x4001100C"] });
  assert.equal(read.ok, false);
  assert.match(String(read.error), /Tcl 端口/u);
  await resetSession();
});

test("openocd 起不来：归类 no-probe，不给 active 会话", async () => {
  await resetSession();
  const fake = makeSubprocess({ mode: "fail" });
  debugSessions.configure(fake.service, BIN_DIRS);
  const ensured = await ensureSession(FIXTURE_PROJECT, { checkPortBusy: NOT_BUSY });
  assert.equal(ensured.ok, false);
  assert.ok(ensured.probeError !== null);
  assert.match(ensured.message, /^错误：/u);
  assert.equal(ensured.probeError?.evidence.length > 0, true);
  assert.equal(debugSessions.isActive(), false);
});

test("release：关掉会话、旧句柄失效，再 ensureSession 会重建", async () => {
  await resetSession();
  const fake = makeSubprocess({ tclPort: 4448 });
  debugSessions.configure(fake.service, BIN_DIRS);
  await ensureSession(FIXTURE_PROJECT, { checkPortBusy: NOT_BUSY });
  const handle = fake.spawned[0];
  const stopped = await release("单测显式释放");
  assert.equal(stopped.stopped, true);
  assert.equal(handle.terminated, true);
  assert.equal(sessionInfo(), null);
  assert.equal(await touch(), false, "没有会话时 touch 不该造出会话");
  const read = await readWordsViaSession({ addresses: ["0x4001100C"] });
  assert.equal(read.ok, false);
  const again = await ensureSession(FIXTURE_PROJECT, { checkPortBusy: NOT_BUSY });
  assert.equal(again.reused, false);
  assert.equal(fake.spawned.length, 2, "释放之后再读要能重新起会话");
  await resetSession();
});

test("租约到期：sweep 关会话后 ensureSession 重建（空闲超时语义）", async () => {
  await resetSession();
  const fake = makeSubprocess({ tclPort: 4449 });
  debugSessions.configure(fake.service, BIN_DIRS);
  await ensureSession(FIXTURE_PROJECT, { checkPortBusy: NOT_BUSY, idleTtlMs: 60 });
  await new Promise((done) => setTimeout(done, 80));
  assert.equal(await debugSessions.sweepExpired(), true, "空闲超时应该收掉会话");
  assert.equal(sessionInfo(), null);
  const again = await ensureSession(FIXTURE_PROJECT, { checkPortBusy: NOT_BUSY });
  assert.equal(again.ok, true);
  assert.equal(again.reused, false);
  assert.equal(fake.spawned.length, 2);
  await resetSession();
});

test("touch：续租把 idleDeadline 往后推", async () => {
  await resetSession();
  const fake = makeSubprocess({ tclPort: 4450 });
  debugSessions.configure(fake.service, BIN_DIRS);
  await ensureSession(FIXTURE_PROJECT, { checkPortBusy: NOT_BUSY });
  const before = sessionInfo().idleDeadline;
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(touch(), true);
  const after = sessionInfo().idleDeadline;
  assert.ok(after > before, "续租后到期时刻必须更晚");
  await resetSession();
});

test("withSession：拿会话跑一段操作，成功返回 value、失败返回 ProbeError", async () => {
  await resetSession();
  const fake = makeSubprocess({ tclPort: 4451 });
  debugSessions.configure(fake.service, BIN_DIRS);
  const ok = await withSession(async (session) => session.port, FIXTURE_PROJECT, { checkPortBusy: NOT_BUSY });
  assert.equal(ok.ok, true);
  assert.equal(ok.value, DEFAULT_PROBE_PORT);
  assert.equal(ok.reused, false);

  const failure = await withSession(async () => {
    throw new Error("gdb 炸了");
  }, FIXTURE_PROJECT, { checkPortBusy: NOT_BUSY });
  assert.equal(failure.ok, false);
  assert.equal(failure.probeError?.kind, "unknown");
  assert.match(failure.message, /会话内操作失败：gdb 炸了/u);
  // 会话本身没坏：失败之后还能继续用
  assert.equal(debugSessions.isActive(), true);
  await resetSession();
});

test("tclRoundTrip：端口不可达时干净失败（ok=false + error）", async () => {
  const round = await tclRoundTrip(1, ["halt"], 300);
  assert.equal(round.ok, false);
  assert.match(String(round.error), /连不上|超时|没有可用的 Tcl 端口/u);
});
