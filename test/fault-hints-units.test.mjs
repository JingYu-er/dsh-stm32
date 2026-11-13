import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeFault, groupFaults } from "../lib/engine/fault-hints.js";

test("decodeFault：探针未识别与目标无响应各自归类", () => {
  const probe = decodeFault("Error: unable to find a matching CMSIS-DAP device");
  assert.equal(probe.category, "probe");
  assert.equal(probe.rule, "probe.cmsis-dap-missing");
  assert.ok(probe.hint.includes("USB"));

  const target = decodeFault("Error: no device found");
  assert.equal(target.category, "target");
  assert.ok(target.hint.includes("SWD"));
});

test("decodeFault：编译与链接错误给出具体检查点", () => {
  const link = decodeFault("main.c:(.text+0x10): undefined reference to `HAL_Delay'");
  assert.equal(link.category, "build");
  assert.equal(link.rule, "build.undefined-reference");
  assert.ok(link.hint.includes("CMakeLists"));

  const header = decodeFault("Core/Src/main.c:12:10: fatal error: foo.h: No such file or directory");
  assert.equal(header.category, "build");
  assert.equal(header.rule, "build.missing-header");
});

test("decodeFault：工具链缺失、网络、权限与占用分别归类", () => {
  assert.equal(decodeFault("openocd: command not found").category, "toolchain");
  assert.equal(decodeFault("下载安装包失败：固定版本没下来").category, "network");
  assert.equal(decodeFault("EPERM: operation not permitted, open 'C:/x'").category, "tool");
  assert.equal(decodeFault("EBUSY: resource busy or locked").rule, "io.busy");
  assert.equal(decodeFault("当前没有调试会话（先开 stm32_debug_session）").category, "debug");
  assert.equal(decodeFault("工程目录里没有可读的 .ioc：D:/x").rule, "ioc.missing");
});

test("decodeFault：规则按最具体优先，泛词不会盖住精确提示", () => {
  const text = "Error: unable to find a matching CMSIS-DAP device (openocd init failed)";
  assert.equal(decodeFault(text).rule, "probe.cmsis-dap-missing", "cmsis-dap 规则排在 openocd init 之前");
});

test("decodeFault：没命中就给空提示与原样归类，不臆造原因", () => {
  const unknown = decodeFault("something odd happened");
  assert.equal(unknown.category, "other");
  assert.equal(unknown.hint, "");
  assert.equal(unknown.rule, "none");
  assert.deepEqual(decodeFault("   "), { category: "other", hint: "", rule: "none" });
});

test("groupFaults：同一条规则合并计数，保留首末序号与时间，按 count 降序", () => {
  const items = [
    { seq: 3, time: "2026-11-13T07:00:00.000Z", rule: "build.undefined-reference", category: "build", hint: "看链接命令" },
    { seq: 5, time: "2026-11-13T07:00:05.000Z", rule: "build.undefined-reference", category: "build", hint: "看链接命令" },
    { seq: 9, time: "2026-11-13T07:00:09.000Z", rule: "probe.cmsis-dap-missing", category: "probe", hint: "换 USB 口" },
  ];
  const groups = groupFaults(items);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].rule, "build.undefined-reference");
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].firstSeq, 3);
  assert.equal(groups[0].lastSeq, 5);
  assert.equal(groups[0].firstTime, "2026-11-13T07:00:00.000Z");
  assert.equal(groups[0].lastTime, "2026-11-13T07:00:05.000Z");
  assert.equal(groups[0].category, "build");
  assert.equal(groups[1].count, 1);
  assert.deepEqual(groupFaults([]), []);
});
