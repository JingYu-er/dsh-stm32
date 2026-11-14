/**
 * ECAD 引擎单测（S97）：工具链定位、工作区初始化、构建参数拼装、ERC/DRC 解析、STEP 缺失模型。
 *
 * 全部离线：假 subprocess 只记录 argv、按 `-o <报告>` 写一份固定的 JSON，不真跑 KiCad。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { exportStep, findUnnamedNets, runDrc, runErc } from "../lib/engine/ecad/checks.js";
import { exportEmbeddedLibraries, scanPcbFootprints, scanSchSymbols } from "../lib/engine/ecad/libs.js";
import { checkDfm, estimateCost, readBoardFacts, renderDru, writeDru } from "../lib/engine/ecad/dfm.js";
import { normalizeKicadProject, normalizePcbFootprintNames, readCanonicalFootprints } from "../lib/engine/ecad/normalize.js";
import { parseJlcpcbFootprints, vendorJlcpcbFootprints } from "../lib/engine/ecad/jlcpcb.js";
import { collectModelPaths, prepareModels3d, resolveModels, rewriteModelPaths } from "../lib/engine/ecad/models3d.js";
import { exportFabrication } from "../lib/engine/ecad/fabrication.js";
import { registerEcadTools } from "../lib/tools/ecad.js";
import { buildTargets } from "../lib/engine/probe.js";
import { resolveSearchConfig } from "../lib/data/search-roots.js";
import { guidesFor } from "../lib/data/install-guides.js";
import { collectPackageFiles, packageHardware, verifyPackage } from "../lib/engine/ecad/package.js";
import { createZip, listZipEntries } from "../lib/engine/ecad/zip.js";
import { locateEcadToolchain } from "../lib/engine/ecad/toolchain.js";
import {
  findLatestKicadBuild,
  initEcadWorkspace,
  listCircuitEntries,
  planEcadWorkspace,
  runTsciBuild,
} from "../lib/engine/ecad/tsci.js";

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 假 KiCad 安装：`bin/kicad-cli.exe` 与 `bin/bun.exe` 只需存在。 */
function fakeKicadRoot() {
  const root = tempDir("ecad-kicad-");
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "share", "kicad", "footprints"), { recursive: true });
  mkdirSync(join(root, "share", "kicad", "symbols"), { recursive: true });
  mkdirSync(join(root, "share", "kicad", "3dmodels"), { recursive: true });
  writeFileSync(join(root, "bin", "kicad-cli.exe"), "", "utf8");
  writeFileSync(join(root, "bin", "bun.exe"), "", "utf8");
  return root;
}

/** 假 subprocess：记录 argv；给了 report 就按 argv 里的 `-o` 写盘；exitCode 由参数决定。 */
function fakeSubprocess(options = {}) {
  const calls = [];
  return {
    calls,
    resolveExecutable(command) {
      return command;
    },
    spawn(spec) {
      calls.push({ argv: spec.argv, cwd: spec.cwd });
      const outIndex = spec.argv.indexOf("-o");
      if (options.report !== undefined && outIndex >= 0) {
        const target = spec.argv[outIndex + 1];
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, JSON.stringify(options.report), "utf8");
      }
      if (options.stdout !== undefined) writeFileSync(join(spec.cwd, ".fake-stdout"), options.stdout, "utf8");
      const text = options.stdout ?? "";
      const reader = {
        readFrom(offset) {
          const slice = text.slice(offset);
          return { text: slice, nextOffset: text.length, lossy: false };
        },
      };
      const done = Promise.resolve({ exitCode: options.exitCode ?? 0, signal: null });
      return {
        done,
        collected: { stdout: reader, stderr: reader },
        terminate() {},
        waitForExit() {
          return done;
        },
      };
    },
  };
}

test("工具链：DSH_STM32_KICAD_ROOT 指到哪就认哪，并注入 3D 模型目录", () => {
  const root = fakeKicadRoot();
  try {
    const located = locateEcadToolchain({ DSH_STM32_KICAD_ROOT: root });
    assert.equal(located.ok, true);
    assert.equal(located.toolchain.root, root.replace(/\\/gu, "/"));
    assert.match(located.toolchain.kicadCli, /bin[\\/]kicad-cli\.exe$/u);
    assert.match(located.toolchain.bun, /bin[\\/]bun\.exe$/u);
    assert.match(located.toolchain.env["KICAD10_3DMODEL_DIR"], /3dmodels$/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("工具链：找不到 KiCad 时给可执行的提示，而不是空对象", () => {
  const located = locateEcadToolchain({ DSH_STM32_KICAD_ROOT: join(tmpdir(), "definitely-missing-kicad") });
  assert.equal(located.ok, false);
  assert.equal(located.toolchain, null);
  assert.match(located.error, /没找到 KiCad/u);
  assert.match(located.error, /DSH_STM32_KICAD_ROOT/u);
});

test("工作区：hardware 为空时落到 <工程>/hardware，四个目录名固定", () => {
  const project = tempDir("ecad-plan-");
  try {
    const workspace = planEcadWorkspace(project, "");
    assert.equal(workspace.root, join(project, "hardware"));
    assert.equal(workspace.circuitDir, join(project, "hardware", "circuit"));
    assert.equal(workspace.kicadDir, join(project, "hardware", "kicad"));
    assert.equal(workspace.libsDir, join(project, "hardware", "libs"));
    assert.equal(workspace.outDir, join(project, "hardware", "out"));
    assert.equal(workspace.initialized, false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("工具层：没有 hardware/ 时初始化落到 <工程>/hardware，而不是工程根", async () => {
  const project = tempDir("ecad-tool-init-");
  try {
    const defs = new Map();
    registerEcadTools({
      tools: { register: (def) => defs.set(def.name, def) },
      subprocess: fakeSubprocess(),
      get: () => undefined,
    });
    const def = defs.get("stm32_ecad_init");
    assert.ok(def !== undefined);
    const value = await def.execute({ projectDir: project }, { signal: new AbortController().signal });
    assert.equal(value.ok, true);
    assert.equal(value.root, join(project, "hardware"));
    assert.ok(value.circuitDir.startsWith(join(project, "hardware")));
    for (const key of def.output.schema.required) assert.ok(key in value, "缺字段 " + key);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("初始化：建四个目录与最小 package.json，重复调用幂等", () => {
  const project = tempDir("ecad-init-");
  try {
    const workspace = planEcadWorkspace(project, "");
    const first = initEcadWorkspace(workspace);
    assert.equal(first.ok, true);
    assert.ok(first.created.length >= 4);
    const second = initEcadWorkspace(workspace);
    assert.equal(second.ok, true);
    assert.equal(second.created.length, 0);
    assert.equal(listCircuitEntries(workspace.circuitDir).length, 0);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("构建：没初始化时提示先跑 stm32_ecad_init", async () => {
  const project = tempDir("ecad-build-");
  try {
    const located = locateEcadToolchain({ DSH_STM32_KICAD_ROOT: fakeKicadRoot() });
    const workspace = planEcadWorkspace(project, "");
    const built = await runTsciBuild({
      subprocess: fakeSubprocess(),
      toolchain: located.toolchain,
      workspace,
    });
    assert.equal(built.ok, false);
    assert.match(built.error, /stm32_ecad_init/u);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("构建：装了工作区但没装依赖时提示 npm install，不静默卡住", async () => {
  const root = fakeKicadRoot();
  const project = tempDir("ecad-build2-");
  try {
    const located = locateEcadToolchain({ DSH_STM32_KICAD_ROOT: root });
    const workspace = planEcadWorkspace(project, "");
    initEcadWorkspace(workspace);
    const built = await runTsciBuild({ subprocess: fakeSubprocess(), toolchain: located.toolchain, workspace });
    assert.equal(built.ok, false);
    assert.match(built.error, /npm install/u);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("构建：argv 用 KiCad 自带的 bun 跑本地 cli.mjs，并带 --kicad-project", async () => {
  const root = fakeKicadRoot();
  const project = tempDir("ecad-build3-");
  try {
    const located = locateEcadToolchain({ DSH_STM32_KICAD_ROOT: root });
    const workspace = planEcadWorkspace(project, "");
    initEcadWorkspace(workspace);
    mkdirSync(join(workspace.circuitDir, "node_modules", "tscircuit"), { recursive: true });
    writeFileSync(join(workspace.circuitDir, "node_modules", "tscircuit", "cli.mjs"), "export {};\n", "utf8");
    const subprocess = fakeSubprocess({ exitCode: 1 });
    const built = await runTsciBuild({ subprocess, toolchain: located.toolchain, workspace, entry: "board.circuit.tsx" });
    assert.equal(built.ok, false);
    assert.equal(subprocess.calls.length, 1);
    const argv = subprocess.calls[0].argv;
    assert.equal(argv[0], located.toolchain.bun);
    assert.match(argv[1], /node_modules[\\/]tscircuit[\\/]cli\.mjs$/u);
    assert.equal(argv[2], "build");
    assert.equal(argv[3], "board.circuit.tsx");
    assert.ok(argv.includes("--kicad-project"));
    assert.ok(argv.includes("--svgs"));
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("产物：没有构建结果时给下一步动作，不返回空路径", () => {
  const project = tempDir("ecad-latest-");
  try {
    const workspace = planEcadWorkspace(project, "");
    const latest = findLatestKicadBuild(workspace);
    assert.equal(latest.ok, false);
    assert.match(latest.error, /stm32_ecad_build/u);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("产物：多份构建里取最新的一份，并带上同目录的原理图", () => {
  const project = tempDir("ecad-latest2-");
  try {
    const workspace = planEcadWorkspace(project, "");
    const old = join(workspace.circuitDir, "dist", "old", "kicad");
    const fresh = join(workspace.circuitDir, "dist", "new", "kicad");
    for (const dir of [old, fresh]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(old, "old.kicad_pcb"), "x", "utf8");
    writeFileSync(join(fresh, "new.kicad_pcb"), "y", "utf8");
    writeFileSync(join(fresh, "new.kicad_sch"), "z", "utf8");
    // Windows 的文件时间精度只到毫秒，两次写入可能落在同一毫秒；显式拉开时间戳，避免断言随机失败。
    utimesSync(join(old, "old.kicad_pcb"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const latest = findLatestKicadBuild(workspace);
    assert.equal(latest.ok, true);
    assert.equal(latest.kicadDir, fresh);
    assert.match(latest.pcbFile, /new\.kicad_pcb$/u);
    assert.match(latest.schematicFile, /new\.kicad_sch$/u);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("ERC：把 sheets[].violations 收敛成 rule/severity/条数", async () => {
  const root = fakeKicadRoot();
  const project = tempDir("ecad-erc-");
  try {
    const located = locateEcadToolchain({ DSH_STM32_KICAD_ROOT: root });
    const schematic = join(project, "board.kicad_sch");
    writeFileSync(schematic, "sch", "utf8");
    const subprocess = fakeSubprocess({
      report: {
        sheets: [
          {
            violations: [
              { type: "pin_not_connected", severity: "error", description: "Pin not connected", items: [{ description: "U1 pin 3" }] },
              { type: "lib_symbol_issues", severity: "warning", description: "找不到符号", items: [] },
            ],
          },
        ],
      },
    });
    const erc = await runErc(subprocess, located.toolchain, schematic);
    assert.equal(erc.ok, true);
    assert.equal(erc.summary.errors, 1);
    assert.equal(erc.summary.warnings, 1);
    assert.equal(erc.summary.findings[0].rule, "pin_not_connected");
    assert.deepEqual(erc.summary.findings[0].items, ["U1 pin 3"]);
    assert.match(subprocess.calls[0].argv.join(" "), /sch erc --format json --severity-all/u);
    assert.match(erc.reportPath, /checks[\\/]erc\.json$/u);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("DRC：violations 与 unconnected_items 一起收，未连接项单独标规则名", async () => {
  const root = fakeKicadRoot();
  const project = tempDir("ecad-drc-");
  try {
    const located = locateEcadToolchain({ DSH_STM32_KICAD_ROOT: root });
    const pcb = join(project, "board.kicad_pcb");
    writeFileSync(pcb, "pcb", "utf8");
    const subprocess = fakeSubprocess({
      report: {
        violations: [{ type: "track_width", severity: "error", description: "走线太窄", items: [] }],
        unconnected_items: [{ type: "unconnected_items", severity: "error", description: "未连接", items: [] }],
      },
    });
    const drc = await runDrc(subprocess, located.toolchain, pcb);
    assert.equal(drc.ok, true);
    assert.equal(drc.summary.errors, 2);
    assert.deepEqual(
      drc.summary.findings.map((finding) => finding.rule),
      ["track_width", "unconnected_items"],
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("STEP：缺失 3D 模型只报告不阻断，成功时给出字节数", async () => {
  const root = fakeKicadRoot();
  const project = tempDir("ecad-step-");
  try {
    const located = locateEcadToolchain({ DSH_STM32_KICAD_ROOT: root });
    const pcb = join(project, "board.kicad_pcb");
    writeFileSync(pcb, "pcb", "utf8");
    const outFile = join(project, "out", "board.step");
    const subprocess = fakeSubprocess({
      stdout:
        "Could not add 3D model for U18. File not found: ${KICAD10_3DMODEL_DIR}/Package_DFN_QFN.3dshapes/x.step\n" +
        "Could not add 3D model for R5. File not found\n",
    });
    const original = subprocess.spawn.bind(subprocess);
    // 假 kicad-cli 不会真的生成 STEP，这里在 spawn 后补写目标文件。
    subprocess.spawn = (spec) => {
      const handle = original(spec);
      mkdirSync(dirname(outFile), { recursive: true });
      writeFileSync(outFile, "STEP", "utf8");
      return handle;
    };
    const exported = await exportStep(subprocess, located.toolchain, pcb, outFile);
    assert.equal(exported.ok, true);
    assert.equal(exported.bytes, 4);
    assert.deepEqual(exported.missingModels, ["U18", "R5"]);
    assert.match(subprocess.calls[0].argv.join(" "), /pcb export step/u);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("内嵌封装抽取：封装头换行、字符串里的括号不影响切分（S98）", () => {
  const pcb = [
    "(kicad_pcb (version 20240108)",
    "  (footprint",
    '    "tscircuit:chip"',
    '    (layer "F.Cu")',
    '    (fp_text user "(paren inside string)")',
    "  )",
    '  (footprint "tscircuit:resistor"',
    '    (property "Reference" "R1")',
    "  )",
    ")",
  ].join("\n");
  const found = scanPcbFootprints(pcb);
  assert.deepEqual(found.map((item) => item.lib + ":" + item.name), [
    "tscircuit:chip",
    "tscircuit:resistor",
  ]);
});

test("内嵌符号抽取：lib_symbols 里按库分组，导出时去掉库前缀（S98）", () => {
  const sch = [
    "(kicad_sch (version 20260306)",
    "  (lib_symbols",
    '    (symbol "Device:boxresistor_right"',
    '      (property "Reference" "R" (at 0 0 0))',
    "    )",
    '    (symbol "Device:capacitor_left"',
    "      (property)",
    "    )",
    '    (symbol "custom_no_lib"',
    "    )",
    "  )",
    ")",
  ].join("\n");
  const found = scanSchSymbols(sch);
  assert.deepEqual(found.map((item) => item.lib + ":" + item.name), [
    "Device:boxresistor_right",
    "Device:capacitor_left",
  ]);
  assert.equal(found[0].raw.startsWith('(symbol "boxresistor_right"'), true);
});

test("库导出：落盘 .kicad_mod 与 .kicad_sym，库表只追加缺失项并保留已有条目（S98）", () => {
  const project = tempDir("ecad-libs-");
  try {
    const workspace = planEcadWorkspace(project, join(project, "hardware"));
    initEcadWorkspace(workspace);
    const kicadDir = join(workspace.kicadDir, "dist", "index", "kicad");
    mkdirSync(kicadDir, { recursive: true });
    const pcb = join(kicadDir, "index.kicad_pcb");
    writeFileSync(
      pcb,
      [
        "(kicad_pcb",
        '  (footprint "tscircuit:chip"',
        '    (property "Reference" "U1")',
        "  )",
        '  (net 1 ".R1 > .pin1 to .C1 > .pin1")',
        '  (net 2 "VDD")',
        ")",
      ].join("\n"),
      "utf8",
    );
    const sch = join(kicadDir, "index.kicad_sch");
    writeFileSync(
      sch,
      '(kicad_sch (lib_symbols (symbol "Device:R_Small" (property))))\n',
      "utf8",
    );
    writeFileSync(
      join(kicadDir, "fp-lib-table"),
      '(fp_lib_table\n  (lib (name "mine")(type "KiCad")(uri "x")(options "")(descr ""))\n)\n',
      "utf8",
    );

    const exported = exportEmbeddedLibraries(workspace, pcb, sch);
    assert.equal(exported.ok, true);
    assert.deepEqual(exported.footprintLibs.map((item) => item.lib), ["tscircuit"]);
    assert.deepEqual(exported.symbolLibs.map((item) => item.lib), ["Device"]);
    assert.equal(readFileSync(exported.fpLibTable, "utf8").includes('(name "mine")'), true);
    assert.match(readFileSync(exported.fpLibTable, "utf8"), /KIPRJMOD/u);
    const mod = readFileSync(
      join(workspace.libsDir, "footprints", "tscircuit.pretty", "chip.kicad_mod"),
      "utf8",
    );
    assert.match(mod, /^\(footprint "chip" \(version 20240108\)/u);
    const sym = readFileSync(join(workspace.libsDir, "symbols", "Device.kicad_sym"), "utf8");
    assert.match(sym, /\(symbol "R_Small"/u);
    assert.equal(sym.includes("Device:R_Small"), false);
    assert.deepEqual(findUnnamedNets(readFileSync(pcb, "utf8")), [".R1 > .pin1 to .C1 > .pin1"]);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("制造文件导出：Gerber、钻孔、坐标、STEP 一起落盘，顺序固定（S100）", async () => {
  const root = fakeKicadRoot();
  const project = tempDir("ecad-fab-");
  try {
    const located = locateEcadToolchain({ DSH_STM32_KICAD_ROOT: root });
    const kicadDir = join(project, "kicad");
    mkdirSync(kicadDir, { recursive: true });
    const pcb = join(kicadDir, "board.kicad_pcb");
    writeFileSync(pcb, "pcb", "utf8");
    const outDir = join(project, "out");
    const subprocess = fakeSubprocess();
    const original = subprocess.spawn.bind(subprocess);
    // 假 kicad-cli 不产文件；这里按输出目录补一份 Gerber 与钻孔，验证文件统计。
    subprocess.spawn = (spec) => {
      const handle = original(spec);
      if (spec.argv.includes("gerbers")) {
        mkdirSync(join(outDir, "gerbers"), { recursive: true });
        writeFileSync(join(outDir, "gerbers", "board-F_Cu.gtl"), "g", "utf8");
      }
      if (spec.argv.includes("drill")) {
        writeFileSync(join(outDir, "gerbers", "board.drl"), "d", "utf8");
      }
      if (spec.argv.includes("pos")) {
        writeFileSync(join(outDir, "board-pos.csv"), "p", "utf8");
      }
      if (spec.argv.includes("step")) {
        writeFileSync(join(outDir, "board.step"), "s", "utf8");
      }
      return handle;
    };
    const exported = await exportFabrication(subprocess, located.toolchain, pcb, outDir);
    assert.equal(exported.ok, true);
    assert.equal(exported.gerbers.length >= 1, true);
    assert.equal(exported.drillFiles.length, 1);
    assert.match(exported.stepFile, /board\.step$/u);
    assert.match(exported.posFile, /board-pos\.csv$/u);
    const kinds = subprocess.calls.map((call) => call.argv.slice(2, 4).join(" "));
    assert.deepEqual(kinds.slice(0, 4), ["export gerbers", "export drill", "export pos", "export step"]);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("制造文件导出：没有板子时给人话，不跑 kicad-cli（S100）", async () => {
  const root = fakeKicadRoot();
  try {
    const located = locateEcadToolchain({ DSH_STM32_KICAD_ROOT: root });
    const subprocess = fakeSubprocess();
    const exported = await exportFabrication(subprocess, located.toolchain, join(root, "missing.kicad_pcb"), join(root, "out"));
    assert.equal(exported.ok, false);
    assert.match(exported.error, /还没有 \.kicad_pcb/u);
    assert.equal(subprocess.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("zip：STORE 打包的条目能读回，中文名与 CRC 路径都成立（S107）", () => {
  const buffer = createZip([
    { name: "a/b.txt", data: Buffer.from("hello", "utf8") },
    { name: "中文/说明.md", data: Buffer.from("# 说明", "utf8") },
  ], new Date("2026-11-14T08:00:00Z"));
  assert.equal(buffer.readUInt32LE(0), 0x04034b50, "本地头签名");
  const entries = listZipEntries(buffer);
  assert.deepEqual(entries.map((item) => item.name), ["a/b.txt", "中文/说明.md"]);
  assert.equal(entries[0].size, 5);
  // 中央目录与结尾记录都要在：结尾签名固定在最后 22 字节。
  assert.equal(buffer.readUInt32LE(buffer.length - 22), 0x06054b50);
});

test("打包：跳过 node_modules 与 dist，写出 zip 并能读回自检（S107）", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-ecad-pack-"));
  const hardware = join(root, "hardware");
  try {
    mkdirSync(join(hardware, "circuit"), { recursive: true });
    mkdirSync(join(hardware, "circuit", "node_modules"), { recursive: true });
    mkdirSync(join(hardware, "dist", "index"), { recursive: true });
    mkdirSync(join(hardware, ".hq", "cache"), { recursive: true });
    writeFileSync(join(hardware, ".hq", "cache", "edge.db"), "cache");
    writeFileSync(join(hardware, "D_NFC.kicad_prl"), "{}");
    writeFileSync(join(hardware, "circuit", "index.circuit.tsx"), "export default null;\n");
    writeFileSync(join(hardware, "circuit", "node_modules", "huge.js"), "x".repeat(1024));
    writeFileSync(join(hardware, "dist", "index", "old.svg"), "<svg/>");
    writeFileSync(join(hardware, "old.zip"), "zip");
    const collected = collectPackageFiles(hardware);
    assert.equal(collected.ok, true);
    assert.deepEqual(collected.entries.map((item) => item.name), ["circuit/index.circuit.tsx"]);
    assert.ok(collected.skipped.some((item) => item.startsWith("circuit/node_modules/")), JSON.stringify(collected.skipped));
    assert.ok(collected.skipped.includes("dist/"), JSON.stringify(collected.skipped));
    assert.ok(collected.skipped.includes(".hq/"), JSON.stringify(collected.skipped));
    assert.ok(collected.skipped.includes("D_NFC.kicad_prl"), JSON.stringify(collected.skipped));

    const packed = packageHardware(hardware, "demo");
    assert.equal(packed.ok, true, packed.error);
    assert.ok(packed.files >= 2, "至少要有电路源码与 README");
    assert.ok(packed.file.endsWith(".zip"));
    const check = verifyPackage(packed.file);
    assert.equal(check.ok, true, check.error);
    assert.equal(check.files, packed.files);
    const names = listZipEntries(readFileSync(packed.file)).map((item) => item.name);
    assert.ok(names.includes("README.md"));
    assert.ok(!names.some((name) => name.startsWith("dist/")), "dist 不该进交付包");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("打包：没有 hardware 目录时给人话，不写文件（S107）", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-ecad-pack-missing-"));
  try {
    const packed = packageHardware(join(root, "hardware"), "demo");
    assert.equal(packed.ok, false);
    assert.match(packed.error, /还没有硬件目录/u);
    assert.equal(packed.file, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("工具链探测覆盖电路设计的两件套：kicad 与 npm（S108）", () => {
  const config = resolveSearchConfig({});
  const targets = buildTargets(config);
  const kicad = targets.find((item) => item.id === "kicad");
  const npm = targets.find((item) => item.id === "npm");
  assert.ok(kicad !== undefined, "探测列表要含 kicad");
  assert.ok(npm !== undefined, "探测列表要含 npm");
  for (const target of [kicad, npm]) {
    assert.equal(target.required, false, target.id + " 不应是必需项");
    assert.ok(target.install.length >= 2, target.id + " 要给安装步骤");
    assert.ok(target.verify !== "", target.id + " 要给自检命令");
  }
  // 缺件时的指引要能落到「怎么装」：两条都必须是 manual，并自带步骤。
  const guides = guidesFor(["kicad", "npm"]);
  assert.equal(guides.length, 2);
  for (const guide of guides) {
    assert.equal(guide.installability, "manual");
    assert.ok(guide.steps.length >= 2 && guide.verify !== "");
  }
});

test("没装 KiCad 时的报错要给出安装去向（S108）", () => {
  const root = tempDir("ecad-nokicad-");
  const located = locateEcadToolchain({ DSH_STM32_KICAD_ROOT: join(root, "missing") });
  assert.equal(located.ok, false);
  assert.match(located.error, /KiCad 10/u);
  assert.match(located.error, /stm32_doctor/u);
});

test("可制造性：设计规则写成嘉立创工艺档（S109）", () => {
  const dru = renderDru();
  assert.match(dru, /\(version 1\)/u);
  assert.match(dru, /track_width \(min 0\.200mm\)/u);
  assert.match(dru, /hole_size \(min 0\.300mm\)/u);
  const root = mkdtempSync(join(tmpdir(), "dsh-ecad-dru-"));
  try {
    writeFileSync(join(root, "demo.kicad_pro"), "{}", "utf8");
    const written = writeDru(root);
    assert.equal(written.ok, true, written.error);
    assert.ok(written.file.endsWith("demo.kicad_dru"), written.file);
    assert.match(readFileSync(written.file, "utf8"), /clearance \(min 0\.200mm\)/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("可制造性：从板子里读尺寸、层数、最细走线与最小孔（S109）", () => {
  const pcb = [
    "(kicad_pcb (version 20240108) (generator \"dsh-stm32\")",
    "  (layers \"F.Cu\" \"B.Cu\")",
    "  (gr_line",
    "    (start 0 0)",
    "    (end 50 40)",
    "    (layer Edge.Cuts)",
    "  )",
    "  (segment (start 1 1) (end 9 1) (width 0.15) (layer \"F.Cu\") (net 1))",
    "  (segment (start 1 2) (end 9 2) (width 0.25) (layer \"F.Cu\") (net 1))",
    "  (via (at 5 5) (size 0.6) (drill 0.2) (net 1))",
    ")",
  ].join("\n");
  const facts = readBoardFacts(pcb);
  assert.equal(facts.widthMm, 50);
  assert.equal(facts.heightMm, 40);
  assert.equal(facts.layers, 2);
  assert.equal(facts.minTrackMm, 0.15);
  assert.equal(facts.minDrillMm, 0.2);
  assert.equal(facts.viaCount, 1);
});

test("可制造性：细线与小孔报 error，并给出修法；成本随尺寸与层数上升（S109）", () => {
  const thin = [
    "(kicad_pcb (version 20240108) (generator \"dsh-stm32\")",
    "  (layers \"F.Cu\" \"B.Cu\")",
    "  (gr_rect (start 0 0) (end 30 20) (layer \"Edge.Cuts\"))",
    "  (segment (start 1 1) (end 9 1) (width 0.15) (layer \"F.Cu\") (net 1))",
    "  (via (at 5 5) (size 0.6) (drill 0.2) (net 1))",
    ")",
  ].join("\n");
  const report = checkDfm(thin);
  assert.equal(report.ok, false);
  const rules = report.findings.map((finding) => finding.rule);
  assert.ok(rules.includes("dfm.track-width"), rules.join(","));
  assert.ok(rules.includes("dfm.hole-size"), rules.join(","));
  for (const finding of report.findings.filter((item) => item.severity === "error")) {
    assert.ok(finding.fix !== "", finding.rule + " 要给修法");
  }
  assert.ok(report.cost.approxCny > 0);

  const small = estimateCost({ widthMm: 40, heightMm: 30, layers: 2, minTrackMm: 0.25, minDrillMm: 0.3, viaCount: 0 });
  const big = estimateCost({ widthMm: 160, heightMm: 120, layers: 2, minTrackMm: 0.25, minDrillMm: 0.3, viaCount: 0 });
  const four = estimateCost({ widthMm: 40, heightMm: 30, layers: 4, minTrackMm: 0.25, minDrillMm: 0.3, viaCount: 0 });
  assert.ok(big.approxCny > small.approxCny, "大板要更贵");
  assert.ok(four.approxCny > small.approxCny, "四层板要更贵");
  assert.ok(small.surcharges.length === 0, "常规参数不应有加价项");
});

test("封装名归一化：从 circuit.json 的模型地址还原真库名（S111）", () => {
  const circuit = JSON.stringify([
    { type: "source_component", source_component_id: "sc0", name: "R1" },
    { type: "source_component", source_component_id: "sc1", name: "U1" },
    { type: "cad_component", source_component_id: "sc0", model_step_url: "https://kicad-mod-cache.tscircuit.com/Resistor_SMD/R_0402_1005Metric.step" },
    { type: "cad_component", source_component_id: "sc1" },
  ]);
  const index = readCanonicalFootprints(circuit);
  assert.deepEqual(index.byReference.get("R1"), { lib: "Resistor_SMD", name: "R_0402_1005Metric" });
  assert.equal(index.byReference.has("U1"), false);
  assert.deepEqual(index.unresolved, ["U1"]);
});

test("封装名归一化：只换 tscircuit 生成名，认不出的位号留原样（S111）", () => {
  const pcb = [
    "(kicad_pcb (version 20240108) (generator \"dsh-stm32\")",
    "  (footprint",
    "    \"tscircuit:resistor\"",
    "    (property \"Reference\" \"R1\")",
    "  )",
    "  (footprint",
    "    \"tscircuit:chip\"",
    "    (property \"Reference\" \"U1\")",
    "  )",
    ")",
  ].join("\n");
  const index = { byReference: new Map([["R1", { lib: "Resistor_SMD", name: "R_0402_1005Metric" }]]), unresolved: [] };
  const result = normalizePcbFootprintNames(pcb, index);
  assert.match(result.text, /"Resistor_SMD:R_0402_1005Metric"/u);
  assert.match(result.text, /"tscircuit:chip"/u, "认不出的封装保持原样");
  assert.equal(result.renamed.length, 1);
  assert.deepEqual(result.unresolved, ["U1"]);
});

test("封装名归一化：复制官方封装并登记 fp-lib-table（S111）", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-ecad-norm-"));
  try {
    const kicadDir = join(root, "kicad");
    const libsDir = join(root, "libs", "footprints");
    const source = join(root, "official", "Resistor_SMD.pretty");
    mkdirSync(kicadDir, { recursive: true });
    mkdirSync(libsDir, { recursive: true });
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "R_0402_1005Metric.kicad_mod"), "(footprint \"R_0402_1005Metric\")\n", "utf8");
    writeFileSync(
      join(kicadDir, "demo.kicad_pcb"),
      "(kicad_pcb\n  (footprint\n    \"tscircuit:resistor\"\n    (property \"Reference\" \"R1\")\n  )\n)\n",
      "utf8",
    );
    const circuit = JSON.stringify([
      { type: "source_component", source_component_id: "sc0", name: "R1" },
      { type: "cad_component", source_component_id: "sc0", model_step_url: "https://kicad-mod-cache.tscircuit.com/Resistor_SMD/R_0402_1005Metric.step" },
    ]);
    const report = normalizeKicadProject(kicadDir, circuit, { footprintRoot: join(root, "official"), libsDir });
    assert.equal(report.ok, true);
    assert.equal(report.copied, 1);
    assert.ok(existsSync(join(libsDir, "Resistor_SMD.pretty", "R_0402_1005Metric.kicad_mod")));
    const pcb = readFileSync(join(kicadDir, "demo.kicad_pcb"), "utf8");
    assert.match(pcb, /"Resistor_SMD:R_0402_1005Metric"/u);
    const table = readFileSync(join(kicadDir, "fp-lib-table"), "utf8");
    assert.match(table, /\(name "Resistor_SMD"\)/u);
    assert.match(table, /\$\{KIPRJMOD\}/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("立创封装固化：从源码读编号、从 PCB 抽几何、登记库与来源（S115）", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-jlc-"));
  try {
    const kicadDir = join(root, "kicad");
    const libsDir = join(root, "libs");
    mkdirSync(kicadDir, { recursive: true });
    const tsx = [
      "export default () => (",
      "  <board>",
      '    <resistor name="R1" resistance="10k" footprint="jlcpcb:C25137" />',
      '    <led name="D1" footprint=\'jlcpcb:C84256\' />',
      "  </board>",
      ");",
    ].join("\n");
    const tsxFile = join(root, "index.circuit.tsx");
    writeFileSync(tsxFile, tsx, "utf8");
    const usages = parseJlcpcbFootprints(tsx);
    assert.deepEqual(usages, [{ ref: "R1", code: "25137" }, { ref: "D1", code: "84256" }]);

    const footprint = (ref) => "(footprint\n    \"tscircuit:chip\"\n    (layer \"F.Cu\")\n    (property \"Reference\" \"" + ref + "\")\n    (pad \"1\" smd rect (at 0 0))\n  )";
    const pcbFile = join(kicadDir, "index.kicad_pcb");
    writeFileSync(pcbFile, "(kicad_pcb\n  " + footprint("R1") + "\n  " + footprint("D1") + "\n)\n", "utf8");
    const out = vendorJlcpcbFootprints({ tsxFile, pcbFile, kicadDir, libsDir });
    assert.equal(out.ok, true);
    assert.equal(out.vendored.length, 2);
    const mod = join(libsDir, "footprints", "jlcpcb_25137.pretty", "25137.kicad_mod");
    assert.ok(existsSync(mod), "封装要落成单文件");
    assert.match(readFileSync(mod, "utf8"), /\(footprint "25137"/u);
    const table = readFileSync(join(kicadDir, "fp-lib-table"), "utf8");
    assert.match(table, /\(name "jlcpcb_25137"\)/u);
    assert.match(table, /\$\{KIPRJMOD\}\//u);
    const sources = JSON.parse(readFileSync(join(libsDir, "sources.json"), "utf8"));
    assert.equal(sources[0].source, "jlcpcb");
    assert.equal(sources[0].code, "25137");
    assert.deepEqual(sources[0].refs, ["R1"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("3D 模型解析：官方目录 → 工程 libs/3d → 缺失，找到的改写成相对路径（S116）", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-models-"));
  try {
    const kicadDir = join(root, "kicad");
    const libsDir = join(root, "libs");
    const modelRoot = join(root, "official-3d");
    mkdirSync(join(modelRoot, "Package_SO.3dshapes"), { recursive: true });
    mkdirSync(join(libsDir, "3d"), { recursive: true });
    mkdirSync(kicadDir, { recursive: true });
    writeFileSync(join(modelRoot, "Package_SO.3dshapes", "SOIC-8.step"), "STEP", "utf8");
    writeFileSync(join(libsDir, "3d", "C25137.step"), "STEP", "utf8");
    const pcbFile = join(kicadDir, "board.kicad_pcb");
    const text = "(kicad_pcb\n  (footprint \"a\" (model \"${KICAD10_3DMODEL_DIR}/Package_SO.3dshapes/SOIC-8.step\"))\n  (footprint \"b\" (model \"${KICAD10_3DMODEL_DIR}/Nope.3dshapes/C25137.step\"))\n  (footprint \"c\" (model \"${KICAD10_3DMODEL_DIR}/Nope.3dshapes/Missing.step\"))\n)\n";
    writeFileSync(pcbFile, text, "utf8");

    const paths = collectModelPaths(text);
    assert.equal(paths.length, 3);
    const uses = resolveModels(text, { modelRoot, libsDir });
    assert.equal(uses.filter((item) => item.source === "kicad-official").length, 1);
    assert.equal(uses.filter((item) => item.source === "project-libs").length, 1);
    assert.equal(uses.filter((item) => item.source === "missing").length, 1);

    const rewritten = rewriteModelPaths(text, uses, kicadDir);
    assert.equal(rewritten.changed, 2);
    assert.match(rewritten.text, /\$\{KIPRJMOD\}\/\.\.\/official-3d\/Package_SO\.3dshapes\/SOIC-8\.step/u);
    assert.match(rewritten.text, /\$\{KIPRJMOD\}\/\.\.\/libs\/3d\/C25137\.step/u);
    assert.match(rewritten.text, /Nope\.3dshapes\/Missing\.step/u);

    const report = prepareModels3d(pcbFile, { modelRoot, libsDir });
    assert.equal(report.ok, true);
    assert.equal(report.changed, 2);
    assert.equal(report.missing.length, 1);
    assert.match(readFileSync(pcbFile, "utf8"), /\$\{KIPRJMOD\}/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
