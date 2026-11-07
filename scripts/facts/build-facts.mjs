#!/usr/bin/env node
// 生成「按需事实包」：SVD(结构+字段语义) + RM 抽取(语义) → facts.json
// 用法：node scripts/facts/build-facts.mjs --part STM32C031F6P6 --svd-root D:/JingYu/STM32/cmsis-svd-stm32 --rm-facts <rm.json> --out <dir>
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";

const REGISTERS = ["FLASH_OPTR", "FLASH_ACR", "FLASH_SECR"];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    out[key] = next === undefined || next.startsWith("--") ? true : next;
    if (out[key] !== true) i += 1;
  }
  return out;
}

export function partToFamilyLine(part) {
  const m = /^STM32([A-Z])(\d)(\d)(\d)/i.exec(part.trim().toUpperCase());
  if (!m) return null;
  const family = m[1] + m[2];
  const line = "STM32" + family + m[3] + m[4];
  return { family, line, dir: ("stm32" + family).toLowerCase() };
}

function text(node, tag) {
  const m = node.match(new RegExp("<" + tag + ">([^<]*)</" + tag + ">"));
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

export function parseSvd(xml, registers = REGISTERS) {
  const result = {};
  for (const m of xml.matchAll(/<register>([\s\S]*?)<\/register>/g)) {
    const reg = m[1];
    const name = text(reg, "name");
    if (!registers.includes(name)) continue;
    const fields = [];
    for (const fm of reg.matchAll(/<field>([\s\S]*?)<\/field>/g)) {
      const f = fm[1];
      const enums = [];
      for (const em of f.matchAll(/<enumeratedValue>([\s\S]*?)<\/enumeratedValue>/g)) {
        enums.push({ value: text(em[1], "value"), description: text(em[1], "description") });
      }
      fields.push({
        name: text(f, "name"),
        bitOffset: Number(text(f, "bitOffset")),
        bitWidth: Number(text(f, "bitWidth")),
        description: text(f, "description"),
        enums,
      });
    }
    fields.sort((a, b) => a.bitOffset - b.bitOffset);
    result[name] = { description: text(reg, "description"), fields };
  }
  return result;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.part || typeof args.part !== "string") {
    console.error("用法: --part STM32C031F6P6 --svd-root <dir> [--rm-facts <file>] [--out <dir>]");
    process.exit(2);
  }
  const target = partToFamilyLine(args.part);
  if (!target) { console.error("认不出型号: " + args.part); process.exit(2); }
  const svdRoot = args["svd-root"] || "D:/JingYu/STM32/cmsis-svd-stm32";
  const svdPath = args.svd || join(svdRoot, target.dir, target.line + ".svd");
  if (!existsSync(svdPath)) { console.error("找不到 SVD: " + svdPath); process.exit(2); }
  const svdBuf = readFileSync(svdPath);
  const structure = parseSvd(svdBuf.toString("utf8"));

  const rmFacts = args["rm-facts"] && typeof args["rm-facts"] === "string" && existsSync(args["rm-facts"])
    ? JSON.parse(readFileSync(args["rm-facts"], "utf8"))
    : { doc: null, items: [] };

  const facts = {
    schema: 1,
    part: args.part.toUpperCase(),
    family: "STM32" + target.family,
    line: target.line,
    generatedAt: new Date().toISOString(),
    sources: [
      { kind: "svd", file: basename(svdPath), sha256: sha256(svdBuf), path: resolve(svdPath) },
      ...(rmFacts.doc ? [{ kind: "rm", ...rmFacts.doc }] : []),
    ],
    registers: structure,
    semantics: rmFacts.items || [],
  };

  const outDir = args.out
    ? resolve(args.out)
    : join(homedir(), ".dsh-stm32", "facts", ("stm32" + target.family).toLowerCase(), target.line);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, "facts.json");
  writeFileSync(outFile, JSON.stringify(facts, null, 1), "utf8");

  const regs = Object.keys(structure).map((k) => k + "(" + structure[k].fields.length + ")").join(" ");
  console.log("facts -> " + outFile);
  console.log("  part=" + facts.part + " family=" + facts.family + " line=" + facts.line);
  console.log("  registers: " + (regs || "(none)"));
  console.log("  semantics: " + facts.semantics.length + " 条；sources: " + facts.sources.map((s) => s.kind).join("+"));
  const dbg = structure.FLASH_ACR?.fields.find((f) => f.name === "DBG_SWEN");
  if (dbg) console.log("  DBG_SWEN: bit " + dbg.bitOffset + " / " + dbg.enums.map((e) => e.value + "=" + e.description).join(", "));
  const rdp = structure.FLASH_OPTR?.fields.find((f) => f.name === "RDP");
  if (rdp) console.log("  RDP: bits " + rdp.bitOffset + "+" + rdp.bitWidth + " / " + rdp.enums.map((e) => e.value + "=" + e.description).join(", "));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\//, ""))) main();
