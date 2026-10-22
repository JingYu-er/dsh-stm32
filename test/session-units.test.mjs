// 调试会话租约单测：node test/session-units.test.mjs（不要用 node --test：沙箱下 spawn EPERM）
import assert from "node:assert/strict";

import { DebugSessionManager } from "../lib/engine/debug-session.js";

import { FIXTURE_PROJECT, binDirs } from "./fixtures.mjs";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

/** 假 subprocess：复刻宿主严格性（cwd 必填）+ 收集式偏移读取。 */
function makeSubprocess() {
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
        if (isOpenOcd) {
          // openocd 的日志走 stderr，且要"过一会儿"才出现。
          setTimeout(() => {
            err.text += "Info : CMSIS-DAP: Interface ready\nInfo : Listening on port 3333 for gdb connections\n";
          }, 30);
        } else {
          out.text += "Breakpoint 1, main () at demo/Core/Src/main.c:74\n0x08000f58 in main ()\n";
          setTimeout(() => resolveDone({ exitCode: 0, signal: null }), 30);
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

const BIN_DIRS = binDirs();

test("start：起 openocd 并等到监听，会话变为 active", async () => {
  const fake = makeSubprocess();
  const manager = new DebugSessionManager();
  manager.configure(fake.service, BIN_DIRS);
  const report = await manager.start({ projectDir: FIXTURE_PROJECT, binDirs: BIN_DIRS });
  assert.equal(report.ok, true, report.message);
  assert.equal(report.active, true);
  assert.equal(report.port, 3333);
  assert.match(report.sessionId, /^dbg-/u);
  assert.ok(report.remainingMs > 0);
  assert.equal(manager.isActive(), true);
  // 起的确实是 openocd + gdb_port
  const openocd = fake.spawned[0];
  assert.match(String(openocd.argv[0]), /openocd/u);
  assert.ok(openocd.argv.includes("-c") && openocd.argv.includes("gdb_port 3333"));
  await manager.stop("测试收尾");
});

test("eval：临时起 gdb -batch，带 monitor halt/resume/detach", async () => {
  const fake = makeSubprocess();
  const manager = new DebugSessionManager();
  manager.configure(fake.service, BIN_DIRS);
  await manager.start({ projectDir: FIXTURE_PROJECT, binDirs: BIN_DIRS });
  const report = await manager.eval({ expression: "g_led_blink_count" });
  assert.equal(report.ok, true, report.message);
  assert.match(report.output, /Breakpoint 1/u);
  const gdb = fake.spawned[1];
  assert.match(String(gdb.argv[0]), /gdb/u);
  assert.ok(gdb.argv.includes("target extended-remote 127.0.0.1:3333"));
  assert.ok(gdb.argv.includes("monitor halt"));
  assert.ok(gdb.argv.includes("print g_led_blink_count"));
  assert.ok(gdb.argv.includes("monitor resume"));
  assert.ok(gdb.argv.includes("detach"));
  await manager.stop("测试收尾");
});

test("eval：没有会话时明确拒绝，不 spawn", async () => {
  const fake = makeSubprocess();
  const manager = new DebugSessionManager();
  manager.configure(fake.service, BIN_DIRS);
  const report = await manager.eval({ commands: ["info registers pc"] });
  assert.equal(report.ok, false);
  assert.match(report.errors.join(" "), /没有调试会话/u);
  assert.equal(fake.spawned.length, 0);
});

test("stop：终止 openocd、探针释放", async () => {
  const fake = makeSubprocess();
  const manager = new DebugSessionManager();
  manager.configure(fake.service, BIN_DIRS);
  await manager.start({ projectDir: FIXTURE_PROJECT, binDirs: BIN_DIRS });
  const stopped = await manager.stop("测试");
  assert.equal(stopped.stopped, true);
  assert.equal(fake.spawned[0].terminated, true);
  assert.equal(manager.isActive(), false);
  // 再关一次是幂等的
  const again = await manager.stop("再关一次");
  assert.equal(again.stopped, false);
});

test("租约：空闲超时后 sweepExpired 关会话", async () => {
  const fake = makeSubprocess();
  let now = 1_000_000;
  const manager = new DebugSessionManager({ now: () => now });
  manager.configure(fake.service, BIN_DIRS);
  await manager.start({ projectDir: FIXTURE_PROJECT, binDirs: BIN_DIRS, idleTtlMs: 1000 });
  assert.equal(await manager.sweepExpired(), false, "还没到期");
  now += 1500;
  assert.equal(manager.status().remainingMs, 0);
  assert.equal(await manager.sweepExpired(), true);
  assert.equal(manager.isActive(), false);
  assert.match(manager.status().message, /没有调试会话/u);
});

test("硬上限：不管有没有活动，总时长到了也关", async () => {
  const fake = makeSubprocess();
  let now = 1_000_000;
  const manager = new DebugSessionManager({ now: () => now });
  manager.configure(fake.service, BIN_DIRS);
  await manager.start({ projectDir: FIXTURE_PROJECT, binDirs: BIN_DIRS, idleTtlMs: 60_000, hardTtlMs: 2_000 });
  now += 1_000;
  await manager.eval({ expression: "1" }); // 续租一次
  now += 1_500; // 空闲没超时，但总时长超了
  assert.equal(await manager.sweepExpired(), true);
  assert.equal(manager.isActive(), false);
});

test("重复 start：旧会话被关掉（探针只有一块）", async () => {
  const fake = makeSubprocess();
  const manager = new DebugSessionManager();
  manager.configure(fake.service, BIN_DIRS);
  await manager.start({ projectDir: FIXTURE_PROJECT, binDirs: BIN_DIRS });
  const first = fake.spawned[0];
  await manager.start({ projectDir: FIXTURE_PROJECT, binDirs: BIN_DIRS });
  assert.equal(first.terminated, true, "旧 openocd 必须被杀");
  assert.equal(manager.isActive(), true);
  await manager.stop("测试收尾");
});

test("openocd 起不来：明确报错，不留下 active 会话", async () => {
  const service = {
    resolveExecutable: (command) => command,
    spawn(spec) {
      if (typeof spec.cwd !== "string") throw new TypeError("boot");
      let resolveDone;
      const done = new Promise((resolve) => {
        resolveDone = resolve;
      });
      setTimeout(() => {
        resolveDone({ exitCode: 1, signal: null });
      }, 20);
      const empty = { readFrom: (offset) => ({ text: "", lossy: false, nextOffset: offset }) };
      return {
        done,
        collected: { stdout: empty, stderr: empty },
        terminate() {},
        waitForExit() {
          return Promise.resolve();
        },
      };
    },
  };
  const manager = new DebugSessionManager();
  manager.configure(service, BIN_DIRS);
  const report = await manager.start({ projectDir: FIXTURE_PROJECT, binDirs: BIN_DIRS });
  assert.equal(report.ok, false);
  assert.equal(manager.isActive(), false);
});

let failed = 0;
for (const item of cases) {
  try {
    await item.fn();
    console.log("ok   " + item.name);
  } catch (error) {
    failed += 1;
    console.log("FAIL " + item.name);
    console.log(String(error && error.message ? error.message : error));
  }
}
console.log("---");
console.log("tests " + cases.length + " / fail " + failed);
process.exit(failed === 0 ? 0 : 1);
