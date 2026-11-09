// 假串口桥：只实现引擎用到的文件 IPC 协议，用来在单测里替掉 PowerShell + 真串口。
// 协议（与 templates/serial/bridge.ps1 对齐）：
//   session.json  引擎写，桥读一次（port / newline / idleTimeoutMs）
//   bridge.pid    桥写自己的 pid
//   status.json   桥写 {state,pid,sessionId,port,openedAt,updatedAt,rxBytes,txBytes,reason?}
//   cmd/<id>.json 引擎写（临时文件 rename 过来），桥读完即删
//   done/<id>.json 桥写 {ok,action,data?,error?}
//   rx.ndjson     桥写收到的行 {t,d}
//
// 行为钩子（测试用）：
//   文本含 CRASH → 立刻 exit(7)，不回 done（模拟桥崩）
//   文本含 SLOW  → 不回 done、不退出（模拟 ack 超时）
//   文本含 PING  → 先回显 PING 行，再补一行 PONG
//   其余文本     → 原样回显一行（模拟板子回显）
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ipc = process.env.DSH_STM32_SERIAL_IPC ?? "";
if (ipc === "") process.exit(3);

const statusPath = join(ipc, "status.json");
const cmdDir = join(ipc, "cmd");
const doneDir = join(ipc, "done");
const rxPath = join(ipc, "rx.ndjson");

let session = { port: "COM7", sessionId: "fake", newline: "crlf", idleTimeoutMs: 600000 };
try {
  session = { ...session, ...JSON.parse(readFileSync(join(ipc, "session.json"), "utf8")) };
} catch {
  // session.json 缺失时用默认值，方便手工起桥
}

const startedAt = Date.now();
let rxBytes = 0;
let txBytes = 0;
let state = "opening";
let reason = "";
let lastError = null;

function writeStatus() {
  const payload = {
    state,
    pid: process.pid,
    sessionId: session.sessionId ?? "fake",
    port: session.port ?? "COM7",
    openedAt: startedAt,
    updatedAt: Date.now(),
    rxBytes,
    txBytes,
  };
  if (reason !== "") payload.reason = reason;
  if (lastError !== null) payload.error = lastError;
  if (state === "open") payload.openedAt = startedAt;
  const tmp = statusPath + ".tmp";
  writeFileSync(tmp, JSON.stringify(payload));
  renameSync(tmp, statusPath);
}

function writeRx(text) {
  const line = JSON.stringify({ t: Date.now(), d: text }) + "\n";
  appendFileSync(rxPath, line, "utf8");
  rxBytes += Buffer.byteLength(line, "utf8");
}

function ack(id, action, data) {
  const payload = { ok: true, action, at: Date.now() };
  if (data !== undefined) payload.data = data;
  const tmp = join(doneDir, "." + id + ".tmp");
  writeFileSync(tmp, JSON.stringify(payload));
  renameSync(tmp, join(doneDir, id + ".json"));
}

function newlineOf(command) {
  if (command.raw === true) return "";
  const kind = command.newline ?? session.newline ?? "crlf";
  if (kind === "crlf") return "\r\n";
  if (kind === "lf") return "\n";
  return "";
}

function handle(command) {
  const id = command.id ?? "";
  if (command.action === "send") {
    const text = typeof command.text === "string" ? command.text : "";
    if (text.includes("CRASH")) process.exit(7);
    if (text.includes("SLOW")) return;
    writeRx(text);
    if (text.includes("PING")) writeRx("PONG");
    const payload = text + newlineOf(command);
    txBytes += Buffer.byteLength(payload, "utf8");
    ack(id, "send", { bytes: Buffer.byteLength(payload, "utf8") });
    return;
  }
  if (command.action === "close") {
    state = "closed";
    reason = "close";
    writeStatus();
    ack(id, "close");
    process.exit(0);
  }
  if (command.action === "lines" || command.action === "ping") {
    ack(id, command.action);
    return;
  }
  const tmp = join(doneDir, "." + id + ".tmp");
  writeFileSync(tmp, JSON.stringify({ ok: false, action: String(command.action ?? ""), error: { kind: "bridge-crashed", cause: "假桥不认识动作 " + String(command.action) } }));
  renameSync(tmp, join(doneDir, id + ".json"));
}

// 测试钩子：模拟桥在 Open() 阶段失败（引擎只看到 status.error + 进程退出）
const failKind = process.env.DSH_STM32_SERIAL_FAKE_FAIL ?? "";
if (failKind !== "") {
  const cause =
    failKind === "port-busy"
      ? "假桥模拟：端口被另一个程序占用"
      : failKind === "access-denied"
        ? "假桥模拟：拒绝访问该端口"
        : "假桥模拟：端口不存在";
  lastError = { kind: failKind, cause };
  state = "error";
  reason = "open-failed";
  writeFileSync(join(ipc, "bridge.pid"), String(process.pid));
  writeStatus();
  process.exit(4);
}

mkdirSync(cmdDir, { recursive: true });
mkdirSync(doneDir, { recursive: true });
writeFileSync(join(ipc, "bridge.pid"), String(process.pid));
// 测试钩子：slow-open 模拟「桥启动比 5 s 窗口还慢」，用来验证引擎的收尾不会留孤儿。
const slowOpenMs = Number(process.env.DSH_STM32_SERIAL_FAKE_SLOW_OPEN_MS) || 0;
if (slowOpenMs > 0) {
  writeStatus();
  setTimeout(() => {
    state = "open";
    writeStatus();
  }, slowOpenMs);
} else {
  writeStatus();
  state = "open";
  writeStatus();
}

let lastActivity = Date.now();
const idleTimeoutMs = Number(session.idleTimeoutMs) || 600000;

setInterval(() => {
  let names = [];
  try {
    names = readdirSync(cmdDir).filter((name) => name.endsWith(".json"));
  } catch {
    names = [];
  }
  for (const name of names) {
    const file = join(cmdDir, name);
    let command = null;
    try {
      command = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      command = null;
    }
    try {
      unlinkSync(file);
    } catch {
      // 已经没了就算了
    }
    if (command !== null) {
      lastActivity = Date.now();
      handle(command);
    }
  }
  if (Date.now() - lastActivity > idleTimeoutMs) {
    state = "closed";
    reason = "idle";
    writeStatus();
    process.exit(0);
  }
}, 100);
