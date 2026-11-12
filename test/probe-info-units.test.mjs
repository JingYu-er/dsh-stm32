/**
 * 探针信息（S41）：pnputil 文本解析（序列号 vs 位置）、interface 选择、读不到时的退化。
 *
 * 样例取自真实 pnputil 输出的 ASCII 段，中文系统里的字段名不参与匹配。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseProbeInstances, probeInfoFromText, readProbeInfo } from "../lib/engine/probe-info.js";

const PNPUTIL_DAPLINK = [
  "Instance ID:                USB\\VID_C251&PID_F001\\0000000001A8",
  "Device Description:         USB 输入设备",
  "Class Name:                 HIDClass",
].join("\n");

const PNPUTIL_STLINK = [
  "Instance ID:                USB\\VID_0483&PID_374B\\5&2C1A&0&1",
  "Device Description:         STM32 STLink",
].join("\n");

/** 假 subprocess：pnputil 返回固定文本，或直接 spawn 失败。 */
function fakeSubprocess({ text = "", fail = false } = {}) {
  return {
    resolveExecutable: (name) => name,
    spawn(spec) {
      const joined = spec.argv.map(String).join(" ");
      if (fail) throw new Error("spawn 失败：" + joined);
      const collected = {
        stdout: { readFrom: () => ({ text: text, nextOffset: text.length }) },
        stderr: { readFrom: () => ({ text: "", nextOffset: 0 }) },
      };
      return {
        collected: collected,
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {},
        waitForExit: () => Promise.resolve({ exitCode: 0, signal: null }),
      };
    },
  };
}

test("parseProbeInstances：十六进制串当序列号，带 & 的总线路径当位置", () => {
  const rows = parseProbeInstances(PNPUTIL_DAPLINK + "\n" + PNPUTIL_STLINK);
  assert.equal(rows.length, 2);
  const daplink = rows.find((row) => row.vid === "c251");
  assert.ok(daplink, JSON.stringify(rows));
  assert.equal(daplink.serial, "0000000001A8");
  assert.equal(daplink.location, "");
  const stlink = rows.find((row) => row.vid === "0483");
  assert.ok(stlink, JSON.stringify(rows));
  assert.equal(stlink.serial, "");
  assert.equal(stlink.location, "5&2C1A&0&1");
});

// 本机 pnputil 实况：同一颗 DAPLink 是父设备 + 两个 &MI_ 接口，序列号只在父设备上。
const PNPUTIL_REAL = [
  "Instance ID:                USB\\VID_C251&PID_F001&MI_00\\6&30b5aae7&0&0000",
  "Instance ID:                USB\\VID_C251&PID_F001\\0001A0000000",
  "Instance ID:                USB\\VID_C251&PID_F001&MI_02\\6&30b5aae7&0&0002",
].join("\n");

test("parseProbeInstances：带 &MI_xx 的接口条目也收，标成 isInterface", () => {
  const rows = parseProbeInstances(PNPUTIL_REAL);
  assert.equal(rows.length, 3, JSON.stringify(rows));
  const parent = rows.find((row) => row.isInterface === false);
  assert.ok(parent, JSON.stringify(rows));
  assert.equal(parent.serial, "0001A0000000");
  assert.equal(rows.filter((row) => row.isInterface === true).length, 2);
});

test("probeInfoFromText：序列号取父设备，不被接口的总线路径顶掉", () => {
  const info = probeInfoFromText(PNPUTIL_REAL);
  assert.equal(info.present, true);
  assert.equal(info.probe?.serial, "0001A0000000");
  assert.equal(info.probe?.location, "");
});

test("parseProbeInstances：重复实例只留一条，空文本给空数组", () => {
  assert.equal(parseProbeInstances(PNPUTIL_DAPLINK + "\n" + PNPUTIL_DAPLINK).length, 1);
  assert.deepEqual(parseProbeInstances(""), []);
});

test("probeInfoFromText：DAPLink 认成 CMSIS-DAP，带序列号与 interface 配置", () => {
  const info = probeInfoFromText(PNPUTIL_DAPLINK);
  assert.equal(info.present, true);
  assert.equal(info.probe?.kind, "daplink");
  assert.equal(info.probe?.serial, "0000000001A8");
  assert.equal(info.interfaceCfg, "interface/cmsis-dap.cfg");
  assert.ok(info.interfaceWhy.includes("CMSIS-DAP"), info.interfaceWhy);
  assert.equal(info.error, "");
});

test("probeInfoFromText：ST-LINK 走 dapdirect，序列号取不到时留空", () => {
  const info = probeInfoFromText(PNPUTIL_STLINK);
  assert.equal(info.present, true);
  assert.equal(info.probe?.kind, "st-link");
  assert.equal(info.probe?.serial, "");
  assert.equal(info.probe?.location, "5&2C1A&0&1");
  assert.equal(info.interfaceCfg, "interface/stlink-dap.cfg");
});

test("probeInfoFromText：只有串口桥时判为没有 SWD 探针，并把它列进 others", () => {
  const info = probeInfoFromText("Instance ID:  USB\\VID_1A86&PID_7523\\5&1&0");
  assert.equal(info.present, false);
  assert.equal(info.probe, null);
  assert.equal(info.interfaceCfg, "");
  assert.equal(info.others.length, 1);
});

test("readProbeInfo：pnputil 跑不了时给 error，不抛", async () => {
  const info = await readProbeInfo({ subprocess: fakeSubprocess({ fail: true }) });
  assert.equal(info.present, false);
  assert.ok(info.error.includes("pnputil"), info.error);
});

test("readProbeInfo：正常输出原样转成报告", async () => {
  const info = await readProbeInfo({ subprocess: fakeSubprocess({ text: PNPUTIL_DAPLINK }) });
  assert.equal(info.present, true);
  assert.equal(info.probe?.vid, "c251");
});
