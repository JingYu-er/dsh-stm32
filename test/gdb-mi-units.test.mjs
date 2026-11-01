// gdb MI 常驻会话单测：node test/gdb-mi-units.test.mjs（需先 npm run build）
import assert from "node:assert/strict";

import { MiSession, decodeMiString, escapeMi, formatStopLocation, parseMiLine, parseMiTuple, parseMiValue, steppingCommandFor, toGdbPath } from "../lib/engine/gdb-mi.js";

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

test("decodeMiString：MI 的 C 转义", () => {
  assert.equal(decodeMiString('a\\nb'), "a\nb");
  assert.equal(decodeMiString('say \"hi\"'), 'say "hi"');
  assert.equal(decodeMiString("path\\\\to"), "path\\to");
  assert.equal(decodeMiString("\\x41"), "A");
});

test("steppingCommandFor：整行步进与单指令步进映射到不同的 -exec-*", () => {
  assert.equal(steppingCommandFor("n"), "-exec-next");
  assert.equal(steppingCommandFor(" Next "), "-exec-next");
  assert.equal(steppingCommandFor("s"), "-exec-step");
  assert.equal(steppingCommandFor("step"), "-exec-step");
  assert.equal(steppingCommandFor("ni"), "-exec-next-instruction");
  assert.equal(steppingCommandFor("nexti"), "-exec-next-instruction");
  assert.equal(steppingCommandFor("si"), "-exec-step-instruction");
  assert.equal(steppingCommandFor("STEPI"), "-exec-step-instruction");
  // continue 不走这里（它要先清掉旧的停止记录），别的命令也不该被当成步进。
  for (const other of ["continue", "c", "print x", "bt", "monitor halt", ""]) {
    assert.equal(steppingCommandFor(other), null, other);
  }
});

test("parseMiLine：结果记录带 token 与嵌套 tuple", () => {
  const record = parseMiLine('5^done,value="0x20004fd0"');
  assert.equal(record.token, 5);
  assert.equal(record.kind, "result");
  assert.equal(record.class, "done");
  assert.equal(record.data.value, "0x20004fd0");

  const stopped = parseMiLine('*stopped,reason="breakpoint-hit",bkptno="1",frame={func="HardFault_Handler",addr="0x08004b7d",line="84"}');
  assert.equal(stopped.kind, "exec");
  assert.equal(stopped.class, "stopped");
  assert.equal(stopped.data.reason, "breakpoint-hit");
  assert.equal(stopped.data.frame.func, "HardFault_Handler");
  assert.equal(stopped.data.frame.line, "84");
});

test("parseMiLine：控制台/目标/日志流与提示符", () => {
  assert.deepEqual(parseMiLine('~"$1 = 0x20004fd0\\n"'), { token: null, kind: "console", class: "", data: {}, text: "$1 = 0x20004fd0\n" });
  assert.equal(parseMiLine('@"abc"').kind, "target");
  assert.equal(parseMiLine('&"warning"').text, "warning");
  assert.equal(parseMiLine("(gdb)").kind, "prompt");
  assert.equal(parseMiLine("=thread-group-added,id=\"i1\"").class, "thread-group-added");
  assert.equal(parseMiLine("这不是 MI"), null);
});

test("parseMiValue / parseMiTuple：三个分支都认", () => {
  assert.deepEqual(parseMiValue('"x"'), { value: "x", next: 3 });
  assert.deepEqual(parseMiValue("{a=\"1\",b=\"2\"}").value, { a: "1", b: "2" });
  assert.deepEqual(parseMiValue("running").value, "running");
  assert.deepEqual(parseMiTuple('a="1",b={c="2"}').data, { a: "1", b: { c: "2" } });
  // MI 的列表（-stack-list-frames 的 stack=[frame={…},frame={…}]）要解析成数组
  assert.deepEqual(parseMiValue('[frame={func="a"},frame={func="b"}]').value, [{ frame: { func: "a" } }, { frame: { func: "b" } }]);
});

test("escapeMi / toGdbPath：命令里的引号与 Windows 路径", () => {
  assert.equal(escapeMi('print "x"'), 'print \\"x\\"');
  assert.equal(toGdbPath("D:\\JingYu\\demo\\x.elf"), "D:/JingYu/demo/x.elf");
});

/** 假 gdb 进程：解析 token，按命令类型回 ^done / ^running，并模拟控制台流。 */
class FakeChild {
  constructor(options = {}) {
    this.silent = options.silent === true;
    this.written = [];
    this.handlers = {};
    this.out = null;
    this.stdout = { on: (_event, listener) => { this.out = listener; } };
    this.stderr = { on: () => {} };
    this.stdin = { write: (line) => this.onWrite(line) };
  }
  on(event, listener) { this.handlers[event] = listener; }
  emit(line) { this.out(line + "\n"); }
  kill() { this.handlers.exit?.(0, null); }
  onWrite(line) {
    const text = line.trim();
    this.written.push(text);
    if (this.silent) return;
    const match = /^(\d+)(.*)$/u.exec(text);
    const token = match === null ? "" : match[1];
    const command = match === null ? text : match[2];
    setTimeout(() => {
      if (command.startsWith("-interpreter-exec console")) {
        this.emit('~"console-out\\n"');
        this.emit(token + "^done");
        return;
      }
      if (command.startsWith("-data-evaluate-expression")) {
        this.emit(token + '^done,value="0x20004fd0"');
        return;
      }
      if (command === "-exec-continue") {
        this.emit(token + "^running");
        return;
      }
      if (command === "-exec-next") {
        this.emit(token + "^running");
        setTimeout(() => this.emit('*stopped,reason="end-stepping-range",frame={func="main",line="242"}'), 5);
        return;
      }
      if (command === "-stack-list-frames") {
        this.emit(token + '^done,stack=[frame={level="0",func="HardFault_Handler",line="84"},frame={level="1",func="main",line="244"}]');
        return;
      }
      this.emit(token + "^done");
    }, 0);
  }
}

test("MiSession：start → 命令排队 → 控制台输出归属当前请求 → 异步 stopped 记录", async () => {
  const child = new FakeChild();
  const started = MiSession.start({
    gdb: "fake-gdb",
    port: 3333,
    elfPath: "D:\\proj\\x.elf",
    spawner: () => child,
    timeoutMs: 2000,
  });
  // start 在等第一个 (gdb) 提示符
  setTimeout(() => child.emit("(gdb)"), 0);
  const session = await started;
  assert.equal(session.alive, true);
  assert.equal(child.written.some((line) => line.includes("-file-exec-and-symbols D:/proj/x.elf")), true, child.written.join(" | "));
  assert.equal(child.written.some((line) => line.includes("-target-select extended-remote 127.0.0.1:3333")), true);
  assert.equal(child.written.some((line) => line.includes("-gdb-set confirm off")), true, "握手命令要先发出去");

  const evaluated = await session.evaluate("$sp");
  assert.equal(evaluated, "0x20004fd0");

  const consoleResult = await session.console("monitor halt");
  assert.equal(consoleResult.text.includes("console-out"), true, "控制台流要挂到当前请求上");
  assert.equal(consoleResult.record.class, "done");

  child.emit('*stopped,reason="exited-normally"');
  assert.equal(session.stopped?.data.reason, "exited-normally");

  const frames = await session.stackFrames();
  assert.equal(frames.length, 2);
  assert.equal(frames[0].func, "HardFault_Handler");

  const running = await session.continueTarget();
  assert.equal(running.class, "running");
  await session.stop();
  assert.equal(session.alive, false);
});

test("MiSession：-exec-next 之后 waitStopped 能等到停在哪一帧", async () => {
  const child = new FakeChild();
  const started = MiSession.start({ gdb: "fake-gdb", port: 3333, spawner: () => child, timeoutMs: 2000 });
  setTimeout(() => child.emit("(gdb)"), 0);
  const session = await started;
  const waiting = session.waitStopped(2000);
  await session.send("-exec-next", 2000);
  const stop = await waiting;
  assert.equal(stop.class, "stopped");
  assert.equal(stop.data.reason, "end-stepping-range");
  assert.equal(stop.data.frame.func, "main");
  assert.equal(stop.data.frame.line, "242");
  await session.stop();
});

test("MiSession：waitStopped 只认 continue 之后的新 *stopped（旧的作废、取走的不重复给）", async () => {
  const child = new FakeChild();
  const started = MiSession.start({ gdb: "fake-gdb", port: 3333, spawner: () => child, timeoutMs: 2000 });
  setTimeout(() => child.emit("(gdb)"), 0);
  const session = await started;

  // start 时的 monitor halt 会先留下一条停止记录：continue 之后它必须失效。
  child.emit('*stopped,reason="signal-received",frame={func="old_stop",line="1"}');
  assert.equal(session.stopped.data.frame.func, "old_stop");
  await session.continueTarget();
  assert.equal(session.stopped, null, "^running 之后旧停止记录要清掉");
  await assert.rejects(session.waitStopped(50), /超时/u);

  child.emit('*stopped,reason="breakpoint-hit",frame={func="main",file="main.c",line="196",addr="0x08001234"}');
  const stop = await session.waitStopped(1000);
  assert.equal(stop.data.frame.func, "main");
  await assert.rejects(session.waitStopped(50), /超时/u, "已经取走的停止记录不能重复给");
  await session.stop();
});

test("MiSession：目标在跑时 ensureHalted 用 -exec-interrupt 停下（console 在运行态会卡）", async () => {
  const child = new FakeChild();
  const started = MiSession.start({ gdb: "fake-gdb", port: 3333, spawner: () => child, timeoutMs: 2000 });
  setTimeout(() => child.emit("(gdb)"), 0);
  const session = await started;
  assert.equal(session.targetRunning, false);

  await session.continueTarget();
  assert.equal(session.targetRunning, true, "^running 之后应记为运行态");
  assert.equal(await session.ensureHalted(), true);
  assert.equal(child.written.some((line) => line.includes("-exec-interrupt")), true, child.written.join(" | "));
  assert.equal(session.targetRunning, false);

  // monitor resume / monitor halt 不会产生 ^running / *stopped，运行态只能从命令本身记。
  await session.console("monitor resume");
  assert.equal(session.targetRunning, true);
  await session.console("monitor halt");
  assert.equal(session.targetRunning, false);

  child.emit('*stopped,reason="breakpoint-hit",frame={func="main",line="196"}');
  assert.equal(session.targetRunning, false, "*stopped 到达也要落回停止态");
  await session.stop();
});

test("formatStopLocation：func file:line @addr (reason) 一行说清停在哪", () => {
  const hit = parseMiLine('*stopped,reason="breakpoint-hit",frame={func="main",file="Core/Src/main.c",line="196",addr="0x08001234"}');
  assert.equal(formatStopLocation(hit), "main Core/Src/main.c:196 @0x08001234 (breakpoint-hit)");
  const bare = parseMiLine('*stopped,reason="exited-normally"');
  assert.equal(formatStopLocation(bare), "(exited-normally)");
  const empty = parseMiLine("*stopped");
  assert.equal(formatStopLocation(empty), "位置未知");
});

test("MiSession：gdb 不回命令就超时失败（不挂死）", async () => {
  const child = new FakeChild({ silent: true });
  await assert.rejects(
    MiSession.start({ gdb: "fake-gdb", port: 3333, spawner: () => child, timeoutMs: 50 }),
    /命令超时/u,
  );
});

let failed = 0;
for (const item of cases) {
  try { await item.fn(); console.log("ok   " + item.name); }
  catch (error) { failed += 1; console.log("FAIL " + item.name); console.log(String(error && error.message ? error.message : error)); }
}
console.log("---");
console.log("tests " + String(cases.length) + " / fail " + String(failed));
if (failed > 0) process.exit(1);
