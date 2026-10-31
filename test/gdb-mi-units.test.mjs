// gdb MI 常驻会话单测：node test/gdb-mi-units.test.mjs（需先 npm run build）
import assert from "node:assert/strict";

import { MiSession, decodeMiString, escapeMi, parseMiLine, parseMiTuple, parseMiValue, toGdbPath } from "../lib/engine/gdb-mi.js";

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

test("decodeMiString：MI 的 C 转义", () => {
  assert.equal(decodeMiString('a\\nb'), "a\nb");
  assert.equal(decodeMiString('say \"hi\"'), 'say "hi"');
  assert.equal(decodeMiString("path\\\\to"), "path\\to");
  assert.equal(decodeMiString("\\x41"), "A");
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
