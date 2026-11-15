/**
 * 工程结构与配置文件归位（S128）的离线单测。
 *
 * 只钉住两条搬迁规则：子目录里的工程描述并回工程根、工程根里的索引行搬到上一级工作区索引；
 * 以及「归位一次之后不再有动作」（幂等），避免每次打开工程都提示要整理。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { CONF_FILE_NAME, WORKSPACE_CONF_REL, readProjectConf, readWorkspaceIndex } from "../lib/engine/project-conf.js";
import { applyLayoutFix, planLayoutFix } from "../lib/engine/project-repair.js";

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-repair-" + name + "-"));
}

function touch(dir, name, body = "") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body, "utf8");
}

test("子目录里的工程描述并回工程根，ioc 改成相对路径（S128）", () => {
  const workspace = tempDir("ws");
  const project = path.join(workspace, "board");
  touch(path.join(project, "fw"), "board.ioc", "Mcu.Name=STM32F303CCTx\n");
  touch(path.join(project, "fw"), CONF_FILE_NAME, "version=1\nname=board\nmcu=STM32F303CCT6\nioc=board.ioc\nbuild=Debug\n");

  const plan = planLayoutFix(project);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].kind, "project-conf-move");

  const out = applyLayoutFix(project);
  assert.equal(out.ok, true);
  const conf = readProjectConf(project);
  assert.equal(conf.name, "board");
  assert.equal(conf.ioc, "fw/board.ioc");
  assert.equal(conf.firmware, "fw");
  assert.ok(fs.existsSync(path.join(project, "fw", CONF_FILE_NAME + ".bak")), "原文件要留备份");
  assert.ok(!fs.existsSync(path.join(project, "fw", CONF_FILE_NAME)), "子目录那份要删掉");
});

test("工程根里的索引行搬到上一级工作区索引（S128）", () => {
  const workspace = tempDir("ws2");
  const project = path.join(workspace, "handheld");
  touch(project, "handheld.ioc", "Mcu.Name=STM32F303CCTx\n");
  touch(project, "fw", CONF_FILE_NAME);
  writeBoth(project);

  const out = applyLayoutFix(project);
  assert.equal(out.ok, true, out.error);
  const index = readWorkspaceIndex(workspace);
  assert.deepEqual(index.projects.map((item) => item.name), ["handheld"]);
  const conf = fs.readFileSync(path.join(project, CONF_FILE_NAME), "utf8");
  assert.ok(!conf.includes("project="), "工程描述里不应再留索引行");
});

test("归位一次之后不再产生动作（S128）", () => {
  const workspace = tempDir("ws3");
  const project = path.join(workspace, "solo");
  touch(path.join(project, "fw"), "solo.ioc", "Mcu.Name=STM32F303CCTx\n");
  touch(path.join(project, "fw"), CONF_FILE_NAME, "name=solo\nmcu=STM32F303CCT6\nioc=solo.ioc\n");
  applyLayoutFix(project);
  assert.equal(planLayoutFix(project).actions.length, 0);
  assert.equal(fs.existsSync(path.join(project, WORKSPACE_CONF_REL)), false, "工程目录里不该出现工作区索引");
});

function writeBoth(project) {
  const lines = ["version=1", "name=handheld", "mcu=STM32F303CCT6", "ioc=handheld.ioc", "build=Debug", "project=fw"];
  fs.writeFileSync(path.join(project, CONF_FILE_NAME), lines.join("\n") + "\n", "utf8");
}
