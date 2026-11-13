// dsh-stm32/conf 单测：工程与工作区自描述文件（S81/S82）
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  CONF_FILE_NAME,
  parseConf,
  readProjectConf,
  readWorkspaceIndex,
  registerWorkspaceProject,
  scanWorkspaceProjects,
  writeProjectConf,
} from "../lib/engine/project-conf.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("parseConf：跳过注释与非法行，单值取第一次，project 可重复", () => {
  const doc = parseConf([
    "# 注释",
    "",
    "version=1",
    "name=demo",
    "name=另一个",
    "没有等号",
    "project=demo",
    "project=board",
  ].join("\n"));
  assert.equal(doc.single.get("version"), "1");
  assert.equal(doc.single.get("name"), "demo", "同名键保留第一次的值");
  assert.deepEqual(doc.multi.get("project"), ["demo", "board"]);
});

test("registerWorkspaceProject：首次写入带表头且用相对路径，重复调用不重复写", () => {
  const root = tempDir("ws-");
  const project = path.join(root, "demo");
  fs.mkdirSync(project);
  assert.equal(registerWorkspaceProject(root, project), true, "首次应写入");
  const conf = path.join(root, CONF_FILE_NAME);
  assert.equal(fs.existsSync(conf), true);
  const text = fs.readFileSync(conf, "utf8");
  assert.match(text, /^# dsh-stm32 工作区索引/m);
  assert.ok(text.includes("project=demo"), "工程路径应相对工作区根");
  assert.equal(registerWorkspaceProject(root, project), false, "重复登记应返回 false");
  assert.equal((fs.readFileSync(conf, "utf8").match(/^project=/gmu) ?? []).length, 1);
});

test("readWorkspaceIndex：缺失的工程目录标 exists=false，不删记录", () => {
  const root = tempDir("ws-miss-");
  fs.mkdirSync(path.join(root, "demo"));
  fs.writeFileSync(path.join(root, CONF_FILE_NAME), "version=1\nproject=demo\nproject=gone\n", "utf8");
  const index = readWorkspaceIndex(root);
  assert.equal(index.exists, true);
  assert.equal(index.projects.length, 2);
  assert.equal(index.projects[0].exists, true);
  assert.equal(index.projects[1].exists, false);
});

test("writeProjectConf/readProjectConf：写最小事实，重写保留 createdAt", () => {
  const project = tempDir("proj-");
  assert.equal(writeProjectConf(project, { name: "demo", mcu: "STM32F103C8T6", ioc: "demo.ioc", build: "Debug" }), true);
  const first = readProjectConf(project);
  assert.equal(first.exists, true);
  assert.equal(first.name, "demo");
  assert.equal(first.mcu, "STM32F103C8T6");
  assert.equal(first.ioc, "demo.ioc");
  assert.equal(first.build, "Debug");
  const confText = fs.readFileSync(path.join(project, CONF_FILE_NAME), "utf8");
  const createdAt = /createdAt=(.+)/u.exec(confText)?.[1] ?? "";
  assert.notEqual(createdAt, "", "应有 createdAt");

  writeProjectConf(project, { name: "demo2" });
  const second = readProjectConf(project);
  assert.equal(second.name, "demo2", "传入的字段应覆盖");
  assert.equal(second.mcu, "STM32F103C8T6", "未传的字段保留旧值");
  const again = /createdAt=(.+)/u.exec(fs.readFileSync(path.join(project, CONF_FILE_NAME), "utf8"))?.[1] ?? "";
  assert.equal(again, createdAt, "createdAt 不应被重写改动");
});

test("scanWorkspaceProjects：深度 ≤2 内认 .ioc 与 CMakeLists.txt", () => {
  const root = tempDir("scan-");
  const a = path.join(root, "alpha");
  const b = path.join(root, "beta", "inner");
  const c = path.join(root, "gamma");
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  fs.mkdirSync(c, { recursive: true });
  fs.writeFileSync(path.join(a, "alpha.ioc"), "Mcu.CPN=STM32F103C8T6\n", "utf8");
  fs.writeFileSync(path.join(b, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.20)\n", "utf8");
  const names = scanWorkspaceProjects(root).map((item) => item.name);
  assert.deepEqual(names.sort(), ["alpha", "inner"]);
  assert.equal(names.includes("gamma"), false, "没有标记文件的目录不算工程");
});
