// L1 纯逻辑单测：doctor 的进程表解析、regs 的地址归一化 / tcl 脚本 / 日志解析。
// 运行：node test\doctor-regs-units.mjs（需先 npm run build）
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseTasklistCsv } from "../lib/engine/doctor.js";
import { buildRegsScript, normalizeAddress, parseRegsLog } from "../lib/engine/regs.js";

test("normalizeAddress 接受带/不带 0x、大小写混写，非法返回 null", () => {
  assert.equal(normalizeAddress("0x4001100C"), "0x4001100C");
  assert.equal(normalizeAddress("4001100c"), "0x4001100C");
  assert.equal(normalizeAddress(" 0x40010004 "), "0x40010004");
  assert.equal(normalizeAddress("20000028"), "0x20000028");
  assert.equal(normalizeAddress("0xZZZ"), null);
  assert.equal(normalizeAddress("0x123456789"), null);
  assert.equal(normalizeAddress(""), null);
});

test("buildRegsScript：init → halt → 读 pc → 每个地址一条 echo mdw → resume/shutdown（不复位芯片）", () => {
  const script = buildRegsScript(["0x4001100C", "0x40010004"]);
  assert.deepEqual(script.trimEnd().split("\n"), [
    "init",
    "halt",
    'echo "PC [lindex [reg pc] 1]"',
    'echo "REG 0x4001100C [lindex [mdw 0x4001100C] 1]"',
    'echo "REG 0x40010004 [lindex [mdw 0x40010004] 1]"',
    "resume",
    "shutdown",
  ]);
});

test("parseRegsLog 抽 pc 与地址值；读不到的地址 ok=false", () => {
  // 格式取自 demo 上 openocd 0.12.0 的真实输出：pc 在 halt 横幅里，
  // mdw 的值是 8 位裸 hex（"00002000"），旧版 echo 还带着 "0x4001100c: " 前缀。
  const text = [
    "Open On-Chip Debugger 0.12.0",
    "[stm32f1x.cpu] halted due to debug-request, current mode: Thread ",
    "xPSR: 0x21000000 pc: 0x08000210 msp: 0x20004fdc",
    "REG 0x4001100C 00002000",
    "REG 0x40010004 0x4001000c: 00000000",
    "shutdown command invoked",
  ].join("\r\n");
  const parsed = parseRegsLog(text, ["0x4001100C", "0x40010004", "0x40010800"]);
  assert.equal(parsed.pc, "0x08000210");
  assert.deepEqual(parsed.samples, [
    { address: "0x4001100C", value: "0x00002000", ok: true },
    { address: "0x40010004", value: "0x00000000", ok: true },
    { address: "0x40010800", value: "", ok: false },
  ]);
});

test("parseRegsLog 兼容 \"PC 0x…\" 兜底形态，且地址大小写不敏感", () => {
  const parsed = parseRegsLog("PC 0x08000478\nREG 0x4001100c 00002000\n", ["4001100C"]);
  assert.equal(parsed.pc, "0x08000478");
  assert.equal(parsed.samples[0].value, "0x00002000");
  assert.equal(parsed.samples[0].ok, true);
});

test("parseTasklistCsv 只留下关心的进程，容忍本地化表头与空行", () => {
  const text = [
    '"openocd.exe","70348","Console","1","12,345 K"',
    '"Code.exe","1234","Console","1","300,000 K"',
    '"gdb-multiarch.exe","888","Console","1","20,000 K"',
    "",
    "信息: 没有运行的任务匹配指定标准。",
  ].join("\r\n");
  assert.deepEqual(parseTasklistCsv(text), [
    { name: "openocd.exe", pid: 70348 },
    { name: "gdb-multiarch.exe", pid: 888 },
  ]);
});
