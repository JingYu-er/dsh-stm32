// 黄金样本：facts 生成链路（SVD 结构 + RM 语义）一旦改坏必须在这里炸。
// 运行：node --test test/facts-units.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseSvd, partToFamilyLine } from "../scripts/facts/build-facts.mjs";

const SVD = fileURLToPath(new URL("./fixtures/svd/stm32c031-excerpt.svd", import.meta.url));
const RM = fileURLToPath(new URL("./fixtures/rm-facts-c0.json", import.meta.url));
const regs = parseSvd(readFileSync(SVD, "utf8"));

test("partToFamilyLine：STM32C031F6P6 → family C0 / line STM32C031 / dir stm32c0", () => {
  assert.deepEqual(partToFamilyLine("STM32C031F6P6"), { family: "C0", line: "STM32C031", dir: "stm32c0" });
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

test("黄金样本：表 4 自举模式 7 行，nBOOT_SEL=1/nBOOT0=0/nBOOT1=1 → 系统存储器", () => {
  const rm = JSON.parse(readFileSync(RM, "utf8"));
  const table = rm.items.find((x) => x.id === "c0.boot.table");
  assert.ok(table, "rm-facts 必须有 c0.boot.table");
  assert.equal(table.source.page, 42);
  assert.equal(table.table.length, 7);
  const system = table.table.find((r) => r.nBOOT_SEL === 1 && r.nBOOT0 === 0 && r.nBOOT1 === 1);
  assert.equal(system.region, "系统存储器");
  const locked = table.table.find((r) => r.BOOT_LOCK === 1);
  assert.equal(locked.region, "主 Flash");
  assert.equal(rm.items.length, 7);
});
