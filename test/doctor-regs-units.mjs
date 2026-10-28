// L1 纯逻辑单测：doctor 的进程表解析、regs 的地址归一化 / tcl 脚本 / 日志解析。
// 运行：node test\doctor-regs-units.mjs（需先 npm run build）
import assert from "node:assert/strict";
import { test } from "node:test";

import { diagnoseUsb, parseTasklistCsv } from "../lib/engine/doctor.js";
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

test("diagnoseUsb：云服务器（没有 USB 控制器）→ no-usb，话术点名换机或 usbip", () => {
  const cloud = [
    "Instance ID:                PCI\\VEN_8086&DEV_7000\\0",
    "Device Description:         Intel 82371SB PCI Bus Master IDE Controller",
    "Class Name:                 IDE Controller",
    "Status:                     0x0",
  ].join("\r\n");
  const d = diagnoseUsb(cloud);
  assert.equal(d.kind, "no-usb");
  assert.match(d.detail, /云服务器|虚拟机/u);
  assert.match(d.detail, /usbip|USB over IP/iu);
  assert.match(d.detail, /物理上没有 USB/u);
});

test("diagnoseUsb：有 USB 控制器但没有 CMSIS-DAP → no-dap，话术覆盖只供电的线与 BOOT0", () => {
  const desktopNoBoard = [
    "Instance ID:                PCI\\VEN_8086&DEV_1E31\\3&11583659&0&A0",
    "Instance ID:                USB\\ROOT_HUB30\\4&3392f545&0&0",
    "Device Description:         Intel(R) 7 Series/C216 Chipset Family USB Enhanced Host Controller",
    "Class Name:                 USB (USB Host Controller)",
    "Class GUID:                 {36fc9e60-c465-11cf-8056-444553540000}",
    "Status:                     0x0",
  ].join("\r\n");
  const d = diagnoseUsb(desktopNoBoard);
  assert.equal(d.kind, "no-dap");
  assert.match(d.detail, /只能供电/u);
  assert.match(d.detail, /BOOT0/u);
});

test("diagnoseUsb：CH340 桥接探针（VID_1A86）也算在线（2a VID 扩表）", () => {
  const ch340 = [
    "Instance ID:                USB\\ROOT_HUB30\\4&1a2b3c4d&0&0",
    "Instance ID:                USB\\VID_1A86&PID_7523\\5&2ff57725&0&0",
    "Device Description:         USB-SERIAL CH340",
    "Status:                     0x0",
  ].join("\r\n");
  const d = diagnoseUsb(ch340);
  assert.equal(d.kind, "ok");
});

test("diagnoseUsb：CMSIS-DAP 在线且无 Problem Code → ok", () => {
  const online = [
    "Instance ID:                USB\\VID_C251&PID_F001\\DEMO0001",
    "Device Description:         CMSIS-DAP",
    "Class Name:                 USB (USB 儲存裝置)",  // pnputil 输出格式：Class Name: USB (…)
    "Status:                     0x0",
  ].join("\r\n");
  const d = diagnoseUsb(online);
  assert.equal(d.kind, "ok");
});

test("diagnoseUsb：CMSIS-DAP 在线但 Problem Code 非 0 → driver-error", () => {
  const broken = [
    "Instance ID:                USB\\VID_0483&PID_374B\\00000000001A",
    "Device Description:         STM32 STLink",
    "Class Name:                 USB (USB Host Controller)",
    "Status:                     0x1802000A",
    "Problem Code:               28",
  ].join("\r\n");
  const d = diagnoseUsb(broken);
  assert.equal(d.kind, "driver-error");
  assert.match(d.detail, /设备管理器/u);
});

test("diagnoseUsb：空文本/乱码不误报 no-usb 之外的东西（拿不到 pnputil 输出走 unknown 路径）", () => {
  // 空输出意味着"什么都没枚举到"：按 no-usb 处理太激进，但也没证据说有 USB。
  // 设计取舍：空文本给 no-usb（云服务器上 pnputil 正常输出为空集）不会误导——
  // 有 USB 的机器上 /connected 至少会枚举出控制器自己。
  const d = diagnoseUsb("");
  assert.equal(d.kind, "no-usb");
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
