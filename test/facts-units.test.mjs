// 黄金样本：facts 生成链路（SVD 结构 + RM 语义）一旦改坏必须在这里炸。
// 运行：node --test test/facts-units.test.mjs
// 结构解析在 lib/engine/facts-acquire.js、型号解析在 lib/engine/facts.js（scripts/facts/build-facts.mjs 只是 CLI 壳）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseSvdStructure } from "../lib/engine/facts-acquire.js";
import { partToFamilyLine } from "../lib/engine/facts.js";

const SVD = fileURLToPath(new URL("./fixtures/svd/stm32c031-excerpt.svd", import.meta.url));
const RM = fileURLToPath(new URL("./fixtures/rm-facts-c0.json", import.meta.url));
const regs = parseSvdStructure(readFileSync(SVD, "utf8"));

test("partToFamilyLine：STM32C031F6P6 → family stm32c0 / line STM32C031", () => {
  assert.deepEqual(partToFamilyLine("STM32C031F6P6"), { family: "stm32c0", line: "STM32C031" });
  assert.equal(partToFamilyLine("not-a-part"), null);
});

test("DBG_SWEN：FLASH_ACR 第 18 位，0=Debugger disabled / 1=Debugger enabled", () => {
  const f = regs.FLASH_ACR.fields.find((x) => x.name === "DBG_SWEN");
  assert.ok(f, "FLASH_ACR 必须有 DBG_SWEN");
  assert.equal(f.bitOffset, 18);
  assert.equal(f.bitWidth, 1);
  assert.deepEqual(f.enums, [
    { value: "0x0", description: "Debugger disabled" },
    { value: "0x1", description: "Debugger enabled" },
  ]);
});

test("EMPTY：FLASH_ACR 第 16 位（空片自动进系统存储器）", () => {
  const f = regs.FLASH_ACR.fields.find((x) => x.name === "EMPTY");
  assert.ok(f);
  assert.equal(f.bitOffset, 16);
});

test("RDP：FLASH_OPTR 位 0 宽 8，0xAA=Level 0 / 0xCC=Level 2", () => {
  const f = regs.FLASH_OPTR.fields.find((x) => x.name === "RDP");
  assert.ok(f);
  assert.equal(f.bitOffset, 0);
  assert.equal(f.bitWidth, 8);
  assert.deepEqual(f.enums.map((e) => e.value), ["0xAA", "0xCC"]);
});

test("BOOT_LOCK：FLASH_SECR 第 16 位；SEC_SIZE 第 0 位", () => {
  const lock = regs.FLASH_SECR.fields.find((x) => x.name === "BOOT_LOCK");
  const size = regs.FLASH_SECR.fields.find((x) => x.name === "SEC_SIZE");
  assert.ok(lock && size);
  assert.equal(lock.bitOffset, 16);
  assert.equal(size.bitOffset, 0);
});

test("黄金样本（EN RM0490 Rev 6 自动抽取）：表 9 七行 + appliesTo 六线 + statement 无旧误记", () => {
  const rm = JSON.parse(readFileSync(RM, "utf8"));
  assert.deepEqual(rm.doc.lines, ["STM32C011", "STM32C031", "STM32C051", "STM32C071", "STM32C091", "STM32C092"]);
  assert.equal(rm.doc.id, "RM0490");
  assert.equal(rm.doc.rev, "Rev 6");
  const table = rm.items.find((x) => x.id === "c0.boot.table");
  assert.ok(table, "rm-facts 必须有 c0.boot.table");
  assert.equal(table.source.page, 53);
  assert.equal(table.table.length, 7);
  // EN 表格是压平行（c0..c5 列）：第 5 行 nBOOT_SEL=1/nBOOT0=0/nBOOT1=1 → System memory
  const system = table.table.find((r) => r.c0 === "0" && r.c1 === "1" && r.c3 === "1" && r.c4 === "0");
  assert.equal(system.c5, "System memory");
  const locked = table.table.find((r) => r.c0 === "1");
  assert.equal(locked.c5, "Main flash memory");
  // 引文回查口径：quote 必须能在 statement 声称的来源页原文里逐字找到（这里断言折叠空白后含关键短语）
  assert.match(table.evidence.quote.toLowerCase(), /boot configuration pin boot0 and bits/);
  assert.equal(table.appliesTo.length, 6);
  assert.equal(rm.items.length, 10);
  // §4 订正：旧「SYSCLK 第 4 个上升沿锁存」的误记必须已从所有 statement 里清除
  for (const it of rm.items) assert.ok(!/4th|第 ?4 ?个上升沿/.test(it.statement), it.id + " 还残留旧误记");
});
