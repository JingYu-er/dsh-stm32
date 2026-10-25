// L0 纯逻辑单测：第三方包索引的判定与「按需停放 / 还原」。
// 运行：node --test test/thirdparty-units.test.mjs（需先 npm run build）
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PARKED_NAME, cubeMxUserHome, needsThirdpartyPacks, parkThirdpartyDb } from "../lib/engine/thirdparty.js";

const tmp = () => mkdtempSync(join(tmpdir(), "dsh-tp-"));

/** 造一个假 thirdparties 目录，pdsc 里放 n 个文件。 */
function fakeThirdparties(files = 3) {
  const home = tmp();
  const dir = join(home, "thirdparties");
  const pdsc = join(dir, "pdsc");
  mkdirSync(pdsc, { recursive: true });
  for (let i = 0; i < files; i += 1) writeFileSync(join(pdsc, "pack" + String(i) + ".pdsc"), "x", "utf8");
  return { home, dir, pdsc, parked: join(dir, PARKED_NAME) };
}

test("needsThirdpartyPacks：Mcu.ThirdPartyNb=0 → 不需要（可停放）", () => {
  const ioc = ["Mcu.CPN=STM32F103C8T6", "Mcu.ThirdPartyNb=0", "Mcu.IPNb=3", ""].join("\n");
  const d = needsThirdpartyPacks(ioc);
  assert.equal(d.needed, false);
  assert.match(d.reason, /Mcu\.ThirdPartyNb=0/u);
  assert.deepEqual(d.evidence, []);
});

test("needsThirdpartyPacks：ThirdPartyNb>0 → 需要，并给出证据行", () => {
  const d = needsThirdpartyPacks("Mcu.ThirdPartyNb=2\n");
  assert.equal(d.needed, true);
  assert.match(d.reason, /2 个第三方包/u);
  assert.deepEqual(d.evidence, ["Mcu.ThirdPartyNb=2"]);
});

test("needsThirdpartyPacks：出现 X-CUBE 标记也要保留索引", () => {
  const d = needsThirdpartyPacks("Mcu.ThirdPartyNb=0\nProjectManager.ProjectName=X-CUBE-AI-demo\n");
  assert.equal(d.needed, true);
  assert.match(d.reason, /第三方包标记/u);
  assert.ok(d.evidence.some((line) => /X-CUBE/u.test(line)));
});

test("needsThirdpartyPacks：没有 ThirdPartyNb 键时保守保留（判断不了就不动）", () => {
  const d = needsThirdpartyPacks("Mcu.CPN=STM32F103C8T6\nMcu.IPNb=3\n");
  assert.equal(d.needed, true);
  assert.match(d.reason, /保守保留/u);
});

test("cubeMxUserHome：STM32CUBEMX_HOME 优先并规范化斜杠，否则用 USERPROFILE", () => {
  assert.equal(cubeMxUserHome({ STM32CUBEMX_HOME: "D:\\tmp\\mx" }), "D:/tmp/mx");
  assert.equal(cubeMxUserHome({ USERPROFILE: "C:\\Users\\me" }), "C:/Users/me/.stm32cubemx");
  assert.equal(cubeMxUserHome({ HOME: "/home/me" }), "/home/me/.stm32cubemx");
  assert.equal(cubeMxUserHome({}), null);
});

test("parkThirdpartyDb + restore：往返后 pdsc 原样回来，停放目录消失", () => {
  const thirdparties = fakeThirdparties(3);
  try {
    const parked = parkThirdpartyDb(thirdparties.dir);
    assert.equal(parked.ok, true);
    assert.equal(existsSync(thirdparties.pdsc), false);
    assert.equal(readdirSync(thirdparties.parked).length, 3);
    assert.match(parked.detail, /已临时停放/u);

    const notes = parked.restore();
    assert.deepEqual(notes, []);
    assert.equal(readdirSync(thirdparties.pdsc).length, 3);
    assert.equal(existsSync(thirdparties.parked), false);
  } finally {
    rmSync(thirdparties.home, { recursive: true, force: true });
  }
});

test("restore 兼容 CubeMX 自建的空 pdsc 目录（实测行为）", () => {
  const thirdparties = fakeThirdparties(1);
  try {
    const parked = parkThirdpartyDb(thirdparties.dir);
    assert.equal(parked.ok, true);
    // 模拟 CubeMX 运行中新建了一个空 pdsc
    mkdirSync(thirdparties.pdsc);
    const notes = parked.restore();
    assert.deepEqual(notes, []);
    assert.equal(readdirSync(thirdparties.pdsc).length, 1);
  } finally {
    rmSync(thirdparties.home, { recursive: true, force: true });
  }
});

test("restore 遇到非空 pdsc 时逐项并回去，不把索引卡在 .dsh-parked（审计 B11）", () => {
  const thirdparties = fakeThirdparties(1);
  try {
    const parked = parkThirdpartyDb(thirdparties.dir);
    assert.equal(parked.ok, true);
    mkdirSync(thirdparties.pdsc, { recursive: true });
    writeFileSync(join(thirdparties.pdsc, "leftover.pdsc"), "y", "utf8");
    const notes = parked.restore();
    assert.equal(notes.length, 1);
    assert.match(notes[0], /非空/u);
    assert.match(notes[0], /并回 1 项/u);
    assert.equal(existsSync(thirdparties.parked), false, "搬空后停放目录要删掉");
    assert.deepEqual(readdirSync(thirdparties.pdsc).sort(), ["leftover.pdsc", "pack0.pdsc"]);
  } finally {
    rmSync(thirdparties.home, { recursive: true, force: true });
  }
});

test("没有 pdsc 目录时不停放（返回 ok:false 并说明原因）", () => {
  const home = tmp();
  try {
    const dir = join(home, "thirdparties");
    mkdirSync(dir, { recursive: true });
    const res = parkThirdpartyDb(dir);
    assert.equal(res.ok, false);
    assert.match(res.detail, /没有第三方包索引目录/u);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("上次停放没还原：先还原再报告本次未停放", () => {
  const thirdparties = fakeThirdparties(2);
  try {
    const first = parkThirdpartyDb(thirdparties.dir);
    assert.equal(first.ok, true);
    // 模拟进程被杀：只留下 parked、没有 pdsc
    const second = parkThirdpartyDb(thirdparties.dir);
    assert.equal(second.ok, false);
    assert.match(second.detail, /已先还原/u);
    assert.equal(readdirSync(thirdparties.pdsc).length, 2);
    assert.equal(existsSync(thirdparties.parked), false);
  } finally {
    rmSync(thirdparties.home, { recursive: true, force: true });
  }
});

test("停放位置已被占用时不动手（两个目录都在 → 返回 ok:false）", () => {
  const thirdparties = fakeThirdparties(1);
  try {
    mkdirSync(thirdparties.parked, { recursive: true });
    const res = parkThirdpartyDb(thirdparties.dir);
    assert.equal(res.ok, false);
    assert.match(res.detail, /已被占用/u);
    assert.equal(readdirSync(thirdparties.pdsc).length, 1);
  } finally {
    rmSync(thirdparties.home, { recursive: true, force: true });
  }
});
