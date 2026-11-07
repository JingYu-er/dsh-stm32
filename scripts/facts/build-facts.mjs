#!/usr/bin/env node
// 生成「按需事实包」：SVD(结构) + rm-facts(RM 语义) → facts.json
//
// 用法：
//   node scripts/facts/build-facts.mjs --part STM32C031F6P6 
//     [--rm-facts <rm.json>] [--rm-pdf <a.pdf>] [--rm-url <https 直链>] [--rm-lines STM32C011,STM32C031]
//     [--svd <x.svd>] [--svd-root <dir>]... [--out <dir>] [--no-network] [--no-write]
//
// SVD 来源顺序：--svd → 每个 --svd-root 下的 <族>/<线>.svd → ~/.dsh-stm32/facts/svd/ 缓存 →
// 联网从 modm-io/cmsis-svd-stm32@main 取（jsDelivr → raw → ghproxy，见 src/engine/facts-acquire.ts）。
// 没有 --svd-root 也不报错：直接走下载缓存/网络，第一次联网之后离线复用。
// RM 语义仍只认人工抽取的 --rm-facts；--rm-pdf/--rm-url 只是登记载体（哈希/大小/来源），
// 不做 PDF 解析（那是下一项工作）。缺语义 → facts.needs 写明缺什么，flash/doctor 自动只读降级。
// --rm-lines 声明这份 rm-facts 适用哪些线（RM 按线分级：RM0490 只覆盖 STM32C0x1=C011/C031）；
// 目标线不在其中时语义一律拒收，只留结构。rm-facts 自带 doc.lines 时可以不传。
import { buildFacts } from "../../lib/engine/facts-acquire.js";

function parseArgs(argv) {
  const out = {};
  const multi = new Set(["svd-root", "rm-lines"]);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    const value = next === undefined || next.startsWith("--") ? true : next;
    if (value !== true) i += 1;
    if (multi.has(key)) {
      const prev = Array.isArray(out[key]) ? out[key] : [];
      if (value !== true) prev.push(String(value));
      out[key] = prev;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function usage() {
  console.error("用法: node scripts/facts/build-facts.mjs --part STM32C031F6P6 [--rm-facts f] [--rm-pdf p] [--rm-url u] [--rm-lines A,B] [--svd f] [--svd-root d]... [--out dir] [--no-network] [--no-write]");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.part !== "string" || args.part === "") {
    usage();
    process.exitCode = 2;
    return;
  }
  const report = await buildFacts({
    part: args.part,
    svdPath: typeof args.svd === "string" ? args.svd : undefined,
    svdRoots: Array.isArray(args["svd-root"]) ? args["svd-root"] : [],
    rmFactsPath: typeof args["rm-facts"] === "string" ? args["rm-facts"] : undefined,
    rmPdfPath: typeof args["rm-pdf"] === "string" ? args["rm-pdf"] : undefined,
    rmUrl: typeof args["rm-url"] === "string" ? args["rm-url"] : undefined,
    rmLines: (Array.isArray(args["rm-lines"]) ? args["rm-lines"] : [])
      .join(",")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s !== ""),
    outDir: typeof args.out === "string" ? args.out : undefined,
    allowNetwork: args["no-network"] !== true,
    write: args["no-write"] !== true,
  });
  if (!report.ok) {
    console.error(report.message);
    for (const a of report.notes) console.error("  尝试: " + a);
    process.exitCode = 2;
    return;
  }
  console.log(report.message);
  console.log("  part=" + report.part + " family=" + report.family + " line=" + report.line);
  console.log("  registers: " + (report.registers || "(none)"));
  console.log("  semantics: " + String(report.semantics) + " 条；sources: " + report.sources.map((s) => s.kind).join("+"));
  for (const n of report.notes) console.log("  note: " + n);
  for (const n of report.needs) console.log("  needs: " + n);
  const dbg = report.structure.FLASH_ACR?.fields.find((f) => f.name === "DBG_SWEN");
  if (dbg !== undefined) console.log("  DBG_SWEN: bit " + String(dbg.bitOffset) + " / " + dbg.enums.map((e) => e.value + "=" + e.description).join(", "));
  const rdp = report.structure.FLASH_OPTR?.fields.find((f) => f.name === "RDP");
  if (rdp !== undefined) console.log("  RDP: bits " + String(rdp.bitOffset) + "+" + String(rdp.bitWidth) + " / " + rdp.enums.map((e) => e.value + "=" + e.description).join(", "));
}

await main();
