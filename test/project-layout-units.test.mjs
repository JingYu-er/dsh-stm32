/**
 * 工程目录约定（S95）的离线单测。
 *
 * 断言的是「哪一层被当成程序目录、哪一层被当成硬件目录」：这两个答案决定了
 * 引脚/时钟读哪个 .ioc、原理图读哪个 .kicad_sch。真实工程有无数种摆法，
 * 这里只钉住约定式布局、老式布局、conf 覆盖三种。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { readProjectConf, scanWorkspaceProjects, writeProjectConf } from "../lib/engine/project-conf.js";
import { resolveProjectLayout } from "../lib/engine/project-layout.js";

function tempProject(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-layout-" + name + "-"));
  return root;
}

function touch(dir, name, body = "") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body, "utf8");
}

test("约定式布局：program/ 与 hardware/ 各自被认出（S95）", () => {
  const root = tempProject("convention");
  touch(path.join(root, "program"), "blink.ioc", "");
  touch(path.join(root, "program"), "CMakeLists.txt", "");
  touch(path.join(root, "hardware"), "board.kicad_pro", "");
  touch(path.join(root, "hardware"), "board.kicad_sch", "");
  const layout = resolveProjectLayout(root);
  assert.equal(layout.projectDir, root);
  assert.equal(layout.firmwareDir, path.join(root, "program"));
  assert.equal(layout.hardwareDir, path.join(root, "hardware"));
  assert.equal(layout.configDir, path.join(root, ".dsh-stm32"));
  assert.ok(layout.notes.length > 0, "要给出判定依据");
});

test("老式布局：程序在根、KiCad 在子目录，靠扫描找到硬件目录（S95）", () => {
  const root = tempProject("legacy");
  touch(root, "blink.ioc", "");
  touch(path.join(root, "D_NFC"), "D_NFC.kicad_pro", "");
  touch(path.join(root, "D_NFC"), "D_NFC.kicad_sch", "");
  const layout = resolveProjectLayout(root);
  assert.equal(layout.firmwareDir, root, "根上有 .ioc 就是程序目录");
  assert.equal(layout.hardwareDir, path.join(root, "D_NFC"));
});

test("conf 里显式写 firmware/hardware 时优先于约定（S95）", () => {
  const root = tempProject("conf");
  touch(path.join(root, "firmware"), "fw.ioc", "");
  touch(path.join(root, "hw-main"), "main.kicad_pro", "");
  assert.ok(writeProjectConf(root, { firmware: "firmware", hardware: "hw-main" }));
  const conf = readProjectConf(root);
  assert.equal(conf.firmware, "firmware");
  assert.equal(conf.hardware, "hw-main");
  const layout = resolveProjectLayout(root);
  assert.equal(layout.firmwareDir, path.join(root, "firmware"));
  assert.equal(layout.hardwareDir, path.join(root, "hw-main"));
});

test("没有 KiCad 工程时 hardwareDir 为空串，不猜目录（S95）", () => {
  const root = tempProject("empty");
  touch(root, "blink.ioc", "");
  assert.equal(resolveProjectLayout(root).hardwareDir, "");
});

test("工作区扫描：根是工程时只列它自己，内部的 program/hardware 不算兄弟工程（S95）", () => {
  const root = tempProject("scan");
  touch(root, "blink.ioc", "");
  touch(path.join(root, "hardware"), "board.kicad_pro", "");
  touch(path.join(root, "program"), "CMakeLists.txt", "");
  const found = scanWorkspaceProjects(root);
  assert.deepEqual(found.map((item) => item.name), [path.basename(root)]);
});

test("工作区扫描：约定式工程被认出来，构建产物与 .dsh-stm32 不会混进来（S95）", () => {
  const root = tempProject("scan2");
  const project = path.join(root, "nfc");
  touch(path.join(project, "firmware"), "nfc.ioc", "");
  touch(path.join(project, "hardware"), "nfc.kicad_pro", "");
  touch(path.join(root, "build"), "CMakeLists.txt", "");
  touch(path.join(root, ".dsh-stm32"), "CMakeLists.txt", "");
  const found = scanWorkspaceProjects(root);
  assert.deepEqual(found.map((item) => item.name), ["nfc"]);
});
