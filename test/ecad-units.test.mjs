/**
 * ECAD 引擎单测（S97）：工具链定位、工作区初始化、构建参数拼装、ERC/DRC 解析、STEP 缺失模型。
 *
 * 全部离线：假 subprocess 只记录 argv、按 `-o <报告>` 写一份固定的 JSON，不真跑 KiCad。
 */

import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildFootprint } from "../lib/engine/ecad/gen/footprint.js";
import { buildSymbol } from "../lib/engine/ecad/gen/symbol.js";
import { applySchEdits, pinPoint, replaySchEditsTo } from "../lib/engine/schematic/edit.js";
import { parseSchText } from "../lib/engine/schematic/kicad-sch.js";
import { analyzeLinks } from "../lib/engine/ecad/pcb/links.js";
import { readGerberSet } from "../lib/engine/ecad/pcb/gerber.js";
import { absorbFromKicad, diffImport, readImportState, renderCircuitSource } from "../lib/engine/ecad/import.js";
import { importPart } from "../lib/engine/ecad/part-import.js";
import { drawOnSheet, drawSheetPath, readDrawSheet, seedDrawSheet, symbolBlocks, writeDrawSheet } from "../lib/engine/schematic/draw.js";
import { assignableNet, buildHandSyncScript, parseHandSyncOutput, planHandSync } from "../lib/engine/ecad/pcb/hand-sync.js";

import { exportStep, findUnnamedNets, runDrc, runErc } from "../lib/engine/ecad/checks.js";
import { exportEmbeddedLibraries, scanPcbFootprints, scanSchSymbols, upsertLibEntries } from "../lib/engine/ecad/libs.js";
import { checkDfm, estimateCost, readBoardFacts, renderDru, writeDru } from "../lib/engine/ecad/dfm.js";
import { normalizeKicadProject, normalizePcbFootprintNames, readCanonicalFootprints } from "../lib/engine/ecad/normalize.js";
import { parseJlcpcbFootprints, vendorJlcpcbFootprints } from "../lib/engine/ecad/jlcpcb.js";
import { collectModelPaths, prepareModels3d, resolveModels, rewriteModelPaths } from "../lib/engine/ecad/models3d.js";
import { exportFabrication } from "../lib/engine/ecad/fabrication.js";
import { FAB_RULE_FLOOR, countCopperLayers, ensureDesignRules, fabFloorForLayers } from "../lib/engine/ecad/pcb/rules.js";
import { parseMech, renderMechDxf, writeMechDxf } from "../lib/engine/ecad/pcb/mech.js";
import { analyzeStackup } from "../lib/engine/ecad/pcb/stackup.js";
import { analyzeEmc, defaultCurrentForNet, requiredWidthMm } from "../lib/engine/ecad/pcb/emc.js";
import { analyzeEmcDeep } from "../lib/engine/ecad/pcb/emc-deep.js";
import { planImpedance } from "../lib/engine/ecad/pcb/impedance.js";
import { checkNetGate } from "../lib/engine/ecad/netgate.js";
import { collectBriefFacts, writeBriefs } from "../lib/engine/ecad/brief.js";
import { analyzePowerBudget } from "../lib/engine/ecad/pcb/power.js";
import { parsePcbScene, readPcbScene } from "../lib/engine/ecad/pcb/scene.js";
import { renderPcbSvg } from "../lib/engine/ecad/pcb/pcb-svg.js";
import { coincidentGroups, collectKicadFootprintRefs, parseKicadModPads } from "../lib/engine/ecad/padprecheck.js";
import { mergeCoincidentPads } from "../lib/engine/ecad/padmerge.js";
import { applyQuotes, buildBom, renderBomCsv, renderBomMarkdown } from "../lib/engine/ecad/bom.js";
import { parseLcscPrice, readPriceCache, writePriceCache } from "../lib/engine/datasheet/price.js";
import { registerEcadTools } from "../lib/tools/ecad.js";
import { registerPcbTools } from "../lib/tools/pcb.js";
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

/** 电源预算夹具（S160）：VBUS 0.2 mm、V3V3 0.3 mm、VDDA 无走线、VBAT_SW 无电压但 0.5 mm。 */
const POWER_BOARD = [
  "(kicad_pcb (version 20241229) (generator pcbnew)",
  '  (net 0 "")',
  '  (net 1 "GND")',
  '  (net 2 "VBUS")',
  '  (net 3 "V3V3")',
  '  (net 4 "VDDA")',
  '  (net 5 "VBAT_SW")',
  "  (segment (start 0 0) (end 10 0) (width 0.2) (layer F.Cu) (net 2))",
  "  (segment (start 0 0) (end 10 0) (width 0.3) (layer F.Cu) (net 3))",
  "  (segment (start 0 0) (end 10 0) (width 0.5) (layer F.Cu) (net 5))",
  ")",
  "",
].join("\n");

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
    assert.ok(!argv.includes("--routing-disabled"));
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("合并焊盘：同封装同坐标同网络并成多编号焊盘，网络不同时拒绝（S131）", () => {
  const pcb = [
    '(footprint "Lib:USB_C"',
    '  (pad "1" smd roundrect (at -3.25 -4.045) (size 0.3 1.1) (layers "F.Cu") (net 1 "VBUS"))',
    '  (pad "16" smd roundrect (at -3.25 -4.045) (size 0.3 1.1) (layers "F.Cu") (net 1 "VBUS"))',
    '  (pad "2" smd roundrect (at -2.45 -4.045) (size 0.3 1.1) (layers "F.Cu") (net 2 "D-"))',
    '  (pad "15" smd roundrect (at -2.45 -4.045) (size 0.3 1.1) (layers "F.Cu") (net 3 "D+"))',
    ")",
    "",
  ].join("\n");
  const result = mergeCoincidentPads(pcb);
  assert.deepEqual(result.merged.map((group) => group.names), [["1", "16"]]);
  assert.equal(result.skipped.length, 1);
  assert.deepEqual(result.skipped[0].names, ["2", "15"]);
  assert.match(result.skipped[0].reason, /网络不同/u);
  assert.match(result.text, /\(pad "1,16"/u);
  assert.ok(!result.text.includes('(pad "16"'));
  assert.match(result.text, /\(pad "15"/u);
});

test("硬件目录只到 hardware/kicad 时，电路工作区仍落在 hardware（S133）", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-ecad-root-"));
  mkdirSync(join(dir, "hardware", "circuit"), { recursive: true });
  mkdirSync(join(dir, "hardware", "kicad"), { recursive: true });
  writeFileSync(join(dir, "hardware", "circuit", "package.json"), "{}", "utf8");
  const workspace = planEcadWorkspace(dir, join(dir, "hardware", "kicad"));
  assert.equal(workspace.root, join(dir, "hardware"));
  assert.equal(workspace.circuitDir, join(dir, "hardware", "circuit"));
  assert.equal(workspace.initialized, true);
});

test("封装预检：同坐标焊盘按 A1/B12 这类成对列出，并驱动降级参数（S130）", async () => {
  const dir = tempDir("padprecheck-");
  try {
    const tsx = join(dir, "board.circuit.tsx");
    writeFileSync(tsx, [
      "export default () => (",
      '  <board width="30mm" height="20mm">',
      '    <connector name="J1" footprint="kicad:Connector_USB/USB_C_Receptacle_HRO_TYPE-C-31-M-12" />',
      '    <resistor name="R1" resistance="1k" footprint="0402" />',
      "  </board>",
      ");",
      "",
    ].join("\n"), "utf8");
    assert.deepEqual(collectKicadFootprintRefs(readFileSync(tsx, "utf8")), [
      "Connector_USB/USB_C_Receptacle_HRO_TYPE-C-31-M-12",
    ]);
    const mod = [
      '(footprint "USB_C"',
      '  (pad "A1" smd roundrect (at -3.25 -4.04) (size 0.3 1.1))',
      '  (pad "B12" smd roundrect (at -3.25 -4.04) (size 0.3 1.1))',
      '  (pad "A4" smd roundrect (at -2.45 -4.04) (size 0.3 1.1))',
      '  (pad "B9" smd roundrect (at -2.45 -4.04) (size 0.3 1.1))',
      '  (pad "1" smd roundrect (at 0 0) (size 0.3 1.1))',
      ")",
      "",
    ].join("\n");
    const pads = parseKicadModPads(mod);
    assert.equal(pads.length, 5);
    assert.deepEqual(coincidentGroups(pads), [["A1", "B12"], ["A4", "B9"]]);

    const located = locateEcadToolchain({ DSH_STM32_KICAD_ROOT: fakeKicadRoot() });
    const workspace = planEcadWorkspace(dir, "");
    initEcadWorkspace(workspace);
    mkdirSync(join(workspace.circuitDir, "node_modules", "tscircuit"), { recursive: true });
    writeFileSync(join(workspace.circuitDir, "node_modules", "tscircuit", "cli.mjs"), "export {};\n", "utf8");
    const subprocess = fakeSubprocess({ exitCode: 1 });
    await runTsciBuild({
      subprocess,
      toolchain: located.toolchain,
      workspace,
      entry: "board.circuit.tsx",
      routingDisabled: true,
    });
    const argv = subprocess.calls[0].argv;
    assert.ok(argv.includes("--routing-disabled"));
    assert.ok(argv.includes("--ignore-placement-drc"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
    writeFileSync(schematic, "(kicad_sch (wire (pts (xy 1 1) (xy 2 2))))", "utf8");
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

test("一键设计支持 pcb 参数：默认关，缺引擎时跳过布线而不是失败（S146）", () => {
  const src = readFileSync(new URL("../src/tools/ecad.ts", import.meta.url), "utf8");
  assert.match(src, /pcb: \{ type: "boolean"/u);
  assert.match(src, /pcb: args\.pcb === true/u);
  const design = readFileSync(new URL("../src/engine/ecad/design.ts", import.meta.url), "utf8");
  assert.match(design, /跳过：KiCadRoutingTools 未安装/u);
  assert.match(design, /request\.pcb === true/u);
});

test("没有导线的原理图：未连接类规则降级为提醒并说明（S148）", async () => {
  const root = fakeKicadRoot();
  const project = tempDir("ecad-erc-nowire-");
  try {
    const located = locateEcadToolchain({ DSH_STM32_KICAD_ROOT: root });
    const schematic = join(project, "board.kicad_sch");
    writeFileSync(schematic, "(kicad_sch (symbol (lib_id \"Device:R\")))", "utf8");
    const subprocess = fakeSubprocess({
      report: {
        sheets: [
          {
            violations: [
              { type: "pin_not_connected", severity: "error", description: "Pin not connected", items: [] },
              { type: "lib_symbol_issues", severity: "warning", description: "找不到符号", items: [] },
            ],
          },
        ],
      },
    });
    const erc = await runErc(subprocess, located.toolchain, schematic);
    assert.equal(erc.summary.errors, 0);
    assert.equal(erc.summary.warnings, 2);
    assert.match(erc.notes.join(" "), /没有导线/u);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("机器生成的原理图：未连接类规则降级并注明生成器（S148）", async () => {
  const root = fakeKicadRoot();
  const project = tempDir("ecad-erc-gen-");
  try {
    const located = locateEcadToolchain({ DSH_STM32_KICAD_ROOT: root });
    const schematic = join(project, "board.kicad_sch");
    writeFileSync(
      schematic,
      "(kicad_sch (generator circuit-json-to-kicad) (wire (pts (xy 1 1) (xy 2 2))))",
      "utf8",
    );
    const subprocess = fakeSubprocess({
      report: {
        sheets: [
          {
            violations: [
              { type: "pin_not_connected", severity: "error", description: "Pin not connected", items: [] },
            ],
          },
        ],
      },
    });
    const erc = await runErc(subprocess, located.toolchain, schematic);
    assert.equal(erc.summary.errors, 0);
    assert.match(erc.notes.join(" "), /circuit-json-to-kicad/u);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("设计规则按层数取嘉立创常规档：多层 0.10、双层 0.127、只升不降（S149）", () => {
  const dir = tempDir("ecad-rules-");
  try {
    assert.equal(ensureDesignRules(dir).ok, false);
    const write = () => writeFileSync(
      join(dir, "board.kicad_pro"),
      JSON.stringify(
        {
          net_settings: { classes: [{ name: "Default", clearance: 0.09, track_width: 0.3 }] },
          board: { design_settings: { rules: { min_clearance: 0.09, min_track_width: 0.1 } } },
        },
        null,
        2,
      ),
      "utf8",
    );
    write();
    // 没有 PCB 文件时按 4 层算：0.10 mm 档。
    const four = ensureDesignRules(dir);
    assert.equal(four.ok, true);
    assert.equal(four.floor.clearanceMm, 0.1);
    let parsed = JSON.parse(readFileSync(join(dir, "board.kicad_pro"), "utf8"));
    assert.equal(parsed.net_settings.classes[0].clearance, 0.1);
    assert.equal(parsed.net_settings.classes[0].track_width, 0.3, "已够宽的线宽不该被改");
    assert.equal(parsed.net_settings.classes[0].via_diameter, 0.45);
    assert.equal(parsed.net_settings.classes[0].via_drill, 0.2);
    assert.equal(parsed.board.design_settings.rules.min_clearance, 0.1);
    assert.match(four.changed.join(" "), /clearance/u);

    // 双层板：0.127 mm 档；显式传 FAB_RULE_FLOOR 时仍按 0.2 判。
    writeFileSync(
      join(dir, "board.kicad_pcb"),
      '(kicad_pcb (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (36 "B.SilkS" user)))',
      "utf8",
    );
    write();
    const two = ensureDesignRules(dir);
    assert.equal(countCopperLayers(dir), 2);
    assert.equal(two.floor.clearanceMm, 0.127);
    parsed = JSON.parse(readFileSync(join(dir, "board.kicad_pro"), "utf8"));
    assert.equal(parsed.net_settings.classes[0].clearance, 0.127);

    // 显式给更严的档：间距可以降回来也可以抬上去，线宽只升不降。
    const strict = ensureDesignRules(dir, FAB_RULE_FLOOR);
    assert.equal(JSON.parse(readFileSync(join(dir, "board.kicad_pro"), "utf8")).net_settings.classes[0].clearance, 0.2);
    assert.match(strict.changed.join(" "), /clearance=0\.2/u);
    const back = ensureDesignRules(dir, fabFloorForLayers(4));
    assert.equal(JSON.parse(readFileSync(join(dir, "board.kicad_pro"), "utf8")).net_settings.classes[0].clearance, 0.1);
    assert.match(back.changed.join(" "), /clearance=0\.1/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("最近构建跳过布线器的工作目录与派生板子（S150）", () => {
  const dir = tempDir("ecad-latest-");
  try {
    const kicad = join(dir, "circuit", "dist", "board", "kicad");
    const working = join(kicad, "board.kicad_pcb.autoroute");
    mkdirSync(working, { recursive: true });
    const board = join(kicad, "board.kicad_pcb");
    const step = join(working, "step04_route.kicad_pcb");
    writeFileSync(board, "(kicad_pcb)", "utf8");
    writeFileSync(join(kicad, "board.kicad_sch"), "(kicad_sch)", "utf8");
    writeFileSync(step, "(kicad_pcb)", "utf8");
    writeFileSync(join(kicad, "board.auto.kicad_pcb"), "(kicad_pcb)", "utf8");
    // 中间步骤比成品新：不排除的话「最近构建」会指向那份没有原理图的板子。
    const later = new Date(Date.now() + 60_000);
    utimesSync(step, later, later);
    utimesSync(join(kicad, "board.auto.kicad_pcb"), later, later);

    const found = findLatestKicadBuild({ kicadDir: join(dir, "empty"), circuitDir: join(dir, "circuit") });
    assert.equal(found.ok, true);
    assert.equal(found.pcbFile, board);
    assert.equal(found.schematicFile, join(kicad, "board.kicad_sch"));
    assert.equal(found.kicadDir, kicad);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SCENE_BOARD = `(kicad_pcb (version 20241229) (generator circuit-json-to-kicad)
  (layers (0 "F.Cu" signal) (1 "In1.Cu" signal) (31 "B.Cu" signal) (36 "B.SilkS" user))
  (gr_line (start 0 0) (end 20 0) (width 0.1) (layer Edge.Cuts))
  (gr_line (start 20 0) (end 20 10) (width 0.1) (layer Edge.Cuts))
  (gr_line (start 20 10) (end 0 10) (width 0.1) (layer Edge.Cuts))
  (gr_line (start 0 10) (end 0 0) (width 0.1) (layer Edge.Cuts))
  (footprint "tscircuit:qfn48" (layer F.Cu) (at 10 5 180)
    (property "Reference" "U1" (at 0 -2 0))
    (fp_text reference "U1" (at 0 -2 0) (layer F.SilkS) (effects (font (size 1 1))))
    (fp_line (start -1 0) (end 1 0) (width 0.15) (layer F.SilkS))
    (pad "1" smd rect (at 2 0 0) (size 1 2) (layers F.Cu F.Mask))
    (pad "2" smd circle (at 0 2 0) (size 0.6 0.6) (layers F.Cu F.Mask)))
  (segment (start 0 0) (end 5 0) (width 0.25) (layer F.Cu) (net 1))
  (segment (start 0 1) (end 5 1) (width 0.25) (layer B.Cu) (net 1))
  (segment (start 0 2) (end 5 2) (width 0.25) (layer In1.Cu) (net 1))
  (via (at 3 3) (size 0.8) (drill 0.4) (layers F.Cu B.Cu)))`;

test("BOM：按主选编号分组、替代料单列，报价只贴到主选（S156）", () => {
  const circuit = JSON.stringify([
    { type: "source_component", source_component_id: "a", name: "C1", ftype: "simple_capacitor", display_capacitance: "100nF", supplier_part_numbers: { jlcpcb: ["C14663", "C108079"] } },
    { type: "source_component", source_component_id: "b", name: "C2", ftype: "simple_capacitor", display_capacitance: "100nF", supplier_part_numbers: { jlcpcb: ["C14663"] } },
    { type: "source_component", source_component_id: "c", name: "U1", ftype: "simple_chip", manufacturer_part_number: "STM32F103C8T6", supplier_part_numbers: { jlcpcb: [] } },
    { type: "cad_component", source_component_id: "a", model_step_url: "https://kicad-mod-cache.tscircuit.com/Capacitor_SMD/C_0603_1608Metric.step" },
    { type: "cad_component", source_component_id: "b", model_step_url: "https://kicad-mod-cache.tscircuit.com/Capacitor_SMD/C_0603_1608Metric.step" },
  ]);
  const report = buildBom(circuit, "circuit.json");
  assert.equal(report.ok, true, report.error);
  assert.equal(report.componentCount, 3);
  assert.equal(report.lines.length, 2);
  const cap = report.lines[0];
  assert.deepEqual(cap.refs, ["C1", "C2"]);
  assert.equal(cap.qty, 2);
  assert.equal(cap.lcsc, "C14663");
  assert.deepEqual(cap.alternatives, ["C108079"]);
  assert.equal(cap.footprint, "Capacitor_SMD:C_0603_1608Metric");
  assert.equal(report.lines[1].value, "STM32F103C8T6");
  assert.equal(report.missingLcsc, 1);

  const priced = applyQuotes(report, {
    C14663: { priceUsd: 0.0031, currency: "USD", stock: 100, mpn: "CC0603", brand: "YAGEO", fetchedAt: "2026-01-01T00:00:00.000Z" },
  });
  assert.equal(priced.priced, 1);
  assert.equal(priced.partsUsd, 0.0062);
  assert.equal(priced.lines[0].subtotalUsd, 0.0062);
  const markdown = renderBomMarkdown(priced);
  assert.match(markdown, /\| C1, C2 \|/u);
  assert.match(markdown, /元件成本 \$0\.0062/u);
  const csv = renderBomCsv(priced);
  assert.match(csv, /^Comment,Designator,Footprint,LCSC Part #,Quantity/u);
  assert.match(csv, /C1,C2/u);
});

test("价格：只认 JSON-LD 的 Product 报价，缺数字回 null（S156）", () => {
  const html = '<script type="application/ld+json">{"@type":"Product","mpn":"M1","brand":{"name":"B"},"offers":{"price":0.0031,"priceCurrency":"USD","inventoryLevel":9}}</script>';
  const quote = parseLcscPrice(html);
  assert.ok(quote !== null);
  assert.equal(quote.priceUsd, 0.0031);
  assert.equal(quote.stock, 9);
  assert.equal(quote.mpn, "M1");
  assert.equal(parseLcscPrice("<html>no offer</html>"), null);
  assert.equal(parseLcscPrice('<script type="application/ld+json">{"@type":"Product","offers":{"price":0}}</script>'), null);

  const dir = mkdtempSync(join(tmpdir(), "dsh-price-"));
  try {
    const path = join(dir, "prices.json");
    writePriceCache(path, { version: 1, quotes: { C1: { priceUsd: 0.5, currency: "USD", stock: null, mpn: "", brand: "", fetchedAt: "2026-01-01T00:00:00.000Z" } } });
    assert.equal(readPriceCache(path).quotes.C1.priceUsd, 0.5);
    writePriceCache(path, { version: 1, quotes: {} });
    assert.deepEqual(readPriceCache(path).quotes, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EMC：电流按 IPC-2221 换线宽，铺铜网络不判窄，换层过孔要求地回流（S158）", () => {
  // 1 A、温升 10 ℃、1 oz：约 0.30 mm；电流越大线越宽。
  const one = requiredWidthMm(1);
  assert.ok(one > 0.28 && one < 0.33, "1 A 大约是 0.30 mm，实际 " + String(one));
  assert.ok(requiredWidthMm(2) > one);
  assert.equal(requiredWidthMm(0), 0);
  assert.equal(defaultCurrentForNet("VBUS"), 1);
  assert.equal(defaultCurrentForNet("V3V3"), 0.5);
  assert.equal(defaultCurrentForNet("LCD_CS"), 0);
  const board = [
    "(kicad_pcb (version 20241229)",
    '  (layers "F.Cu" "In1.Cu" "In2.Cu" "B.Cu")',
    '  (net 0 "")',
    '  (net 1 "V3V3")',
    '  (net 2 "VBUS")',
    '  (net 3 "GND")',
    '  (segment (start 0 0) (end 10 0) (width 0.25) (layer F.Cu) (net 1))',
    '  (segment (start 0 1) (end 5 1) (width 0.15) (layer F.Cu) (net 2))',
    '  (segment (start 0 6) (end 10 6) (width 0.25) (layer F.Cu) (net 3))',
    '  (segment (start 0 6) (end 5 6) (width 0.25) (layer In1.Cu) (net 3))',
    '  (segment (start 5 1) (end 10 1) (width 0.15) (layer In2.Cu) (net 2))',
    '  (via (at 5 1) (size 0.6) (drill 0.3) (layers F.Cu In2.Cu))',
    '  (zone (net 3) (layer "In1.Cu"))',
    ")",
  ].join("\n");
  const report = analyzeEmc(board);
  assert.equal(report.ok, true);
  assert.equal(report.copperLayers, 4);
  assert.deepEqual(report.zonesByLayer, { "In1.Cu": 1 });
  const vbus = report.powerTraces.find((item) => item.net === "VBUS");
  assert.ok(vbus !== undefined);
  assert.equal(vbus.ok, false, "0.15 mm 带不动 1 A");
  const three = report.powerTraces.find((item) => item.net === "V3V3");
  assert.ok(three !== undefined && three.ok === true, "0.5 A 用 0.25 mm 够");
  const gnd = report.powerTraces.find((item) => item.net === "GND");
  assert.equal(gnd, undefined, "有整层铺铜的网络不该被拿最窄走线判窄");
  assert.ok(report.findings.some((item) => item.id === "emc.power-trace-width" && item.message.includes("VBUS")));
  assert.ok(report.findings.some((item) => item.id === "emc.return-path-via"), "5,1 换层但 1.5 mm 内没有地线头");
  // 两层板：多一条回流提醒。
  const two = analyzeEmc(board.replace('"In1.Cu" "In2.Cu" ', ""));
  assert.ok(two.findings.some((item) => item.id === "emc.two-layer-return"));
});

test("叠层与阻抗：按层数取叠层，50/90/100 Ω 的线宽能反算回目标（S157）", () => {
  const board = [
    "(kicad_pcb (version 20241229)",
    '  (layers "F.Cu" "F.Mask"',
    '    "In1.Cu" "In2.Cu" "B.Cu")',
    '  (segment (start 0 0) (end 1 0) (width 0.25) (layer F.Cu) (net 1))',
    '  (segment (start 0 1) (end 1 1) (width 0.1) (layer B.Cu) (net 2))',
    ")",
  ].join("\n");
  const four = analyzeStackup(board);
  assert.equal(four.ok, true);
  assert.equal(four.copperLayers, 4);
  assert.equal(four.preset.id, "jlc4-1.6");
  assert.deepEqual(four.traceWidths, [0.1, 0.25]);
  const fifty = four.suggestions.find((item) => item.kind === "microstrip" && item.targetOhm === 50);
  assert.ok(fifty !== undefined);
  assert.ok(Math.abs(fifty.achievedOhm - 50) < 0.5, "反算出的线宽要能回到 50 Ω");
  const ninety = four.suggestions.find((item) => item.kind === "differential-microstrip" && item.targetOhm === 90);
  assert.ok(ninety !== undefined && ninety.widthMm > 0);
  assert.ok(Math.abs(ninety.achievedOhm - 90) < 1);
  // 两层板换叠层：介质更厚，同样 50 Ω 的线要更宽。
  const two = analyzeStackup(board.replace(/"In1.Cu" "In2.Cu" /u, ""));
  assert.equal(two.copperLayers, 2);
  assert.equal(two.preset.id, "jlc2-1.6");
  const fiftyTwo = two.suggestions.find((item) => item.kind === "microstrip" && item.targetOhm === 50);
  assert.ok(fiftyTwo !== undefined && fiftyTwo.widthMm > 1, "1.6 mm 两层板的 50 Ω 微带要比四层板宽得多");
  assert.ok(four.notes.some((note) => note.includes("没有叠层定义")));
  assert.ok(four.notes.some((note) => note.includes("0.1 mm 的细线")));
});

test("库表：重复写也只保留一个表头，已有条目与新增条目各一条（S155）", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-stm32-libtable-"));
  try {
    const table = join(dir, "fp-lib-table");
    writeFileSync(table, "(fp_lib_table\n  (lib (name \"Old\")(type \"KiCad\")(uri \"${KIPRJMOD}/old.pretty\")(options \"\")(descr \"\"))\n)\n", "utf8");
    upsertLibEntries(table, "fp", [{ lib: "New", uri: "${KIPRJMOD}/new.pretty" }]);
    upsertLibEntries(table, "fp", [{ lib: "New", uri: "${KIPRJMOD}/new.pretty" }, { lib: "Third", uri: "${KIPRJMOD}/third.pretty" }]);
    const text = readFileSync(table, "utf8");
    assert.equal(text.match(/\(fp_lib_table/gu)?.length, 1, "表头只能有一个");
    assert.equal(text.match(/\(name "Old"\)/gu)?.length, 1);
    assert.equal(text.match(/\(name "New"\)/gu)?.length, 1);
    assert.equal(text.match(/\(name "Third"\)/gu)?.length, 1);
    assert.match(text, /^\(fp_lib_table\n  \(version 7\)\n/u);
    assert.equal(text.trimEnd().endsWith(")"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("板图：解析 .kicad_pcb 出焊盘/走线/过孔/板框与内层说明（S151）", () => {
  const scene = parsePcbScene(SCENE_BOARD, "mem.kicad_pcb");
  assert.equal(scene.ok, true, scene.error);
  assert.equal(scene.copperLayers, 3);
  assert.equal(scene.outline.length, 4);
  assert.equal(scene.pads.length, 2);
  assert.equal(scene.tracks.length, 2, "只收顶层与底层");
  assert.equal(scene.innerTracks, 1, "内层单独计数");
  assert.match(scene.notes.join(" "), /内层有 1 条走线/u);
  assert.equal(scene.vias.length, 1);
  assert.equal(scene.silk.length, 1);
  assert.equal(scene.refs.length, 1);
  assert.equal(scene.refs[0].text, "U1");
  // 封装转 180°：pad(2,0) → 相对 (-2,0)，绝对 (8,5)。
  const pad = scene.pads.find((item) => item.number === "1");
  assert.equal(Math.round(pad.x * 1000) / 1000, 8);
  assert.equal(Math.round(pad.y * 1000) / 1000, 5);
  assert.equal(pad.rotation, 180);
  assert.equal(pad.side, "top");
  assert.deepEqual([scene.bbox.x, scene.bbox.y, scene.bbox.width, scene.bbox.height], [0, 0, 20, 10]);

  const rendered = renderPcbSvg(scene, { show: { top: true, bottom: true, pads: true, vias: true, silk: true, edge: true, refs: true } });
  assert.equal(rendered.ok, true, rendered.error);
  assert.match(rendered.svg, /<svg[^>]*viewBox="/u);
  assert.match(rendered.svg, /var\(--dsw-alias-state-business-primary\)/u, "顶层走线用宿主令牌");
  assert.match(rendered.svg, /var\(--dsw-alias-state-success-primary\)/u, "底层走线用宿主令牌");
  assert.match(rendered.svg, /U1/u, "开了 refs 才画位号");
  assert.equal(rendered.pads, 2);
  assert.equal(rendered.tracks, 2);
  assert.equal(rendered.vias, 1);
  // 关掉底层：底层颜色不再出现，计数也不含底层走线。
  const onlyTop = renderPcbSvg(scene, { show: { top: true, bottom: false, pads: true, vias: true, silk: true, edge: true, refs: false } });
  assert.equal(onlyTop.ok, true);
  assert.doesNotMatch(onlyTop.svg, /state-success-primary/u);
  assert.doesNotMatch(onlyTop.svg, /U1/u);
  assert.equal(onlyTop.tracks, 1);

  const broken = parsePcbScene("(kicad_pcb", "broken.kicad_pcb");
  assert.equal(broken.ok, false);
  assert.match(broken.error, /读不懂|语法|括号/u);
  const missing = readPcbScene("C:/definitely/not/here.kicad_pcb");
  assert.equal(missing.ok, false);
  assert.match(missing.error, /读不到|找不到/u);
});

test("工具 stm32_pcb_render：给临时板出 SVG，saveAs 才落盘（S151）", async () => {
  const dir = tempDir("ecad-pcb-render-");
  try {
    const kicad = join(dir, "hardware", "kicad");
    mkdirSync(kicad, { recursive: true });
    writeFileSync(join(kicad, "board.kicad_pcb"), SCENE_BOARD, "utf8");
    const tools = new Map();
    const ctx = {
      tools: { register: (definition) => { tools.set(definition.name, definition); return () => {}; } },
      get(name) {
        if (name === "workingDirectory") return { ensure: async () => dir };
        return undefined;
      },
    };
    registerPcbTools(ctx);
    const tool = tools.get("stm32_pcb_render");
    assert.ok(tool !== undefined, "工具应当注册");

    const dry = await tool.execute({ projectDir: dir }, { signal: new AbortController().signal });
    assert.equal(dry.ok, true, dry.error);
    assert.equal(dry.savedTo, "", "不给 saveAs 不该写文件");
    assert.equal(dry.pads, 2);
    assert.equal(dry.tracks, 2);
    assert.equal(dry.innerTracks, 1);
    assert.match(dry.notes.join(" "), /内层/u);

    const saved = await tool.execute({ projectDir: dir, saveAs: "out/board.svg", layers: "top", refs: true }, { signal: new AbortController().signal });
    assert.equal(saved.ok, true, saved.error);
    assert.match(saved.savedTo.replace(/\\/gu, "/"), /out\/board\.svg$/u);
    assert.ok(existsSync(saved.savedTo));
    const svg = readFileSync(saved.savedTo, "utf8");
    assert.match(svg, /<svg/u);
    assert.equal(saved.tracks, 1, "只要顶层");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("打开 KiCad：拼对 pcbnew 参数，连不上时按给定节奏重探（S154）", async () => {
  const { openBoardInKicad, waitForIpc } = await import("../lib/engine/ecad/pcb/ipc-open.js");
  const dir = mkdtempSync(join(tmpdir(), "dsh-open-"));
  try {
    const board = join(dir, "board.kicad_pcb");
    writeFileSync(board, "(kicad_pcb (version 20241229))\n", "utf8");

    const calls = [];
    const opened = openBoardInKicad(board, { exe: "C:/fake/pcbnew.exe", launcher: (spec) => calls.push(spec) });
    assert.equal(opened.ok, true, opened.error);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].exe, "C:/fake/pcbnew.exe");
    assert.equal(calls[0].boardFile.replace(/\\/gu, "/"), board.replace(/\\/gu, "/"));
    assert.equal(calls[0].cwd.replace(/\\/gu, "/"), dir.replace(/\\/gu, "/"));

    const missing = openBoardInKicad(join(dir, "nope.kicad_pcb"), { exe: "C:/fake/pcbnew.exe" });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /不存在/u);

    let attempts = 0;
    const waits = [];
    const ready = await waitForIpc({
      probe: async () => {
        attempts += 1;
        return attempts >= 3 ? "board.kicad_pcb" : "";
      },
      pollMs: 5,
      timeoutMs: 2000,
      sleep: async (ms) => waits.push(ms),
    });
    assert.equal(ready.ok, true);
    assert.equal(ready.boardName, "board.kicad_pcb");
    assert.equal(attempts, 3);
    assert.deepEqual(waits, [5, 5]);

    const timedOut = await waitForIpc({ probe: async () => "", pollMs: 1, timeoutMs: 5, sleep: async () => {} });
    assert.equal(timedOut.ok, false, "一直连不上要如实报超时");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("需求文档：事实从工程里读，已有文件不覆盖，force 才重写（S159）", async () => {
  const dir = tempDir("ecad-brief-");
  try {
    // `.ioc` 按约定可以落在程序子目录里：工程根读不到时要按 S95 的约定找下去。
    mkdirSync(join(dir, "program"), { recursive: true });
    writeFileSync(join(dir, "program", "demo.ioc"), "Mcu.CPN=STM32F103C8T6\nMcu.Name=STM32F103C8Tx\nMcu.Package=LQFP48\n", "utf8");
    const facts = collectBriefFacts(dir);
    assert.equal(facts.ok, true, facts.error);
    assert.equal(facts.mcu.cpn, "STM32F103C8T6");
    assert.match(facts.notes.join(" "), /还没有构建产物/u);

    const first = writeBriefs(dir, facts);
    assert.equal(first.ok, true, first.error);
    assert.equal(first.written.length, 3);
    const mrd = readFileSync(join(dir, "docs", "01-MRD.md"), "utf8");
    assert.match(mrd, /## 已确认事实/u);
    assert.match(mrd, /STM32F103C8T6/u);
    assert.match(mrd, /待定/u, "需求内容不替人编");

    const second = writeBriefs(dir, facts);
    assert.equal(second.written.length, 0, "已有文件默认不覆盖");
    assert.equal(second.skipped.length, 3);
    const forced = writeBriefs(dir, facts, true);
    assert.equal(forced.written.length, 3, "force 才重写");

    const tools = new Map();
    const ctx = {
      tools: { register: (definition) => { tools.set(definition.name, definition); return () => {}; } },
      get(name) {
        if (name === "workingDirectory") return { ensure: async () => dir };
        return undefined;
      },
    };
    registerPcbTools(ctx);
    const tool = tools.get("stm32_brief");
    assert.ok(tool !== undefined, "stm32_brief 应当注册");
    const dry = await tool.execute({ projectDir: dir, format: "brief" }, { signal: new AbortController().signal });
    assert.equal(dry.ok, true, dry.error);
    assert.equal(dry.mcu, "STM32F103C8T6（LQFP48）");
    assert.match(dry.markdown, /## 方案/u);
    assert.equal(dry.written.length, 0, "不给 write 不写文件");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("电源预算：只合计你填的电流，按名字估的另计，未填的单列（S160）", async () => {
  const dir = tempDir("ecad-power-");
  try {
    writeFileSync(join(dir, "board.kicad_pcb"), POWER_BOARD, "utf8");
    const facts = analyzePowerBudget(POWER_BOARD, "board.kicad_pcb", null, {
      currents: { V3V3: 0.25, NOSUCH: 1 },
      voltages: { VBAT_SW: 3.7 },
    });
    assert.equal(facts.ok, true, facts.error);
    const rail = (name) => facts.rails.find((item) => item.net === name);
    assert.equal(rail("V3V3").currentA, 0.25);
    assert.equal(rail("V3V3").assumed, false);
    assert.equal(rail("V3V3").ok, true, "0.25 A 需 0.045 mm，0.3 mm 够");
    assert.equal(rail("VBUS").assumed, true, "没填的按名字估 1 A");
    assert.equal(rail("VBUS").ok, false, "0.2 mm 不够 1 A 的 0.302 mm");
    assert.equal(rail("VBAT_SW").voltageV, 3.7, "电压可覆盖");
    assert.equal(facts.totalA, 0.25, "预算只算填的");
    assert.equal(facts.totalW, 0.825);
    assert.equal(facts.estimatedA, 2.5, "估的另计：VBUS 1 + VDDA 0.5 + VBAT_SW 1（夹具没有 VBAT）");
    assert.equal(facts.unfilled, 0);
    assert.match(facts.notes.join(" "), /没有这个电源网络：NOSUCH/u);
    assert.match(facts.notes.join(" "), /不当作需求/u);

    const bare = analyzePowerBudget(POWER_BOARD, "board.kicad_pcb", null, {});
    assert.equal(bare.totalA, 0, "一个都没填时预算是 0，不能把估算当预算");
    assert.ok(bare.estimatedA > 0);

    const broken = analyzePowerBudget("(segment", "x.kicad_pcb", null);
    assert.equal(broken.ok, false);

    const tools = new Map();
    const ctx = {
      tools: { register: (definition) => { tools.set(definition.name, definition); return () => {}; } },
      get() {
        return undefined;
      },
    };
    registerPcbTools(ctx);
    const tool = tools.get("stm32_power");
    assert.ok(tool !== undefined, "stm32_power 应当注册");
    const out = await tool.execute({ projectDir: dir, boardFile: "board.kicad_pcb", currents: [{ net: "V3V3", currentA: 0.25 }] }, { signal: new AbortController().signal });
    assert.equal(out.ok, true, out.error);
    assert.equal(out.rails.find((item) => item.net === "V3V3").known, true);
    assert.equal(out.rails.find((item) => item.net === "VBUS").known, true, "按名字估的也算已知，但 assumed 为真");
    assert.equal(out.totalA, 0.25);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("机械：板框与定位孔从 pcb 里读，孔位按板框左下角归一，DXF 只画定位孔（S162）", () => {
  const board = [
    "(kicad_pcb (version 20241229) (generator pcbnew)",
    '  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))',
    '  (gr_line (start 100 50) (end 140 50) (width 0.1) (layer "Edge.Cuts"))',
    '  (gr_line (start 140 50) (end 140 80) (width 0.1) (layer "Edge.Cuts"))',
    '  (gr_line (start 140 80) (end 100 80) (width 0.1) (layer "Edge.Cuts"))',
    '  (gr_line (start 100 80) (end 100 50) (width 0.1) (layer "Edge.Cuts"))',
    '  (footprint "MountingHole" (layer "F.Cu") (at 102 52)',
    '    (property "Reference" "H1" (at 0 0 0))',
    '    (pad "" np_thru_hole circle (at 0 0) (size 2.2 2.2) (drill 2.2) (layers "*.Cu" "*.Mask"))',
    "  )",
    '  (footprint "connector" (layer "F.Cu") (at 138 78 90)',
    '    (property "Reference" "J1" (at 0 0 0))',
    '    (pad "1" thru_hole circle (at 1 0) (size 1.6 1.6) (drill 1) (layers "*.Cu" "*.Mask"))',
    "  )",
    ")",
    "",
  ].join("\n");
  const report = parseMech(board, "board.kicad_pcb");
  assert.equal(report.ok, true, report.error);
  assert.equal(report.widthMm, 40);
  assert.equal(report.heightMm, 30);
  assert.equal(report.areaCm2, 12);
  assert.equal(report.holes.length, 2);
  assert.equal(report.mountingHoles, 1, "只有非金属化孔算定位孔");
  assert.equal(report.minHoleEdgeMm, 2, "H1 在 (2,2)：离两条边各 2 mm");
  assert.equal(report.findings.length, 0);
  const mount = report.holes.find((hole) => !hole.plated);
  assert.equal(mount.x, 2);
  assert.equal(mount.y, 2);

  const dxf = renderMechDxf(report);
  assert.equal((dxf.match(/^LINE$/gmu) ?? []).length, 4, "板框四条线");
  assert.equal((dxf.match(/^CIRCLE$/gmu) ?? []).length, 1, "只画定位孔");
  assert.equal(dxf.includes("H1") || dxf.includes("J1"), false, "DXF 不带位号");

  const dir = mkdtempSync(join(tmpdir(), "dsh-mech-"));
  try {
    const file = join(dir, "mech", "board.dxf");
    const bytes = writeMechDxf(file, report);
    assert.equal(bytes > 0, true);
    assert.equal(readFileSync(file, "utf8").startsWith("0\nSECTION"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const missingOutline = parseMech("(kicad_pcb (version 20241229))", "x.kicad_pcb");
  assert.equal(missingOutline.ok, false);
  assert.match(missingOutline.error, /板框/u);
});

test("符号与封装生成：引脚数、坐标与文件名都对得上（S164）", () => {
  const qfp = buildFootprint({ kind: "qfp", name: "LQFP-48_7x7_P0.5mm", pins: 48, pitch: 0.5, bodyWidthMm: 7, bodyHeightMm: 7, padWidthMm: 1.5, padHeightMm: 0.28 });
  assert.equal(qfp.ok, true, qfp.error);
  assert.equal(qfp.pinCount, 48);
  assert.equal((qfp.text.match(/\(pad "/gu) ?? []).length, 48, "QFP 要画出 48 个焊盘");
  assert.match(qfp.text, /\(footprint "LQFP-48_7x7_P0\.5mm"/u);
  assert.match(qfp.text, /\(pad "1" smd rect \(at -3\.95 -2\.75\)/u, "1 脚在左列最上");
  assert.match(qfp.text, /\(pad "48" smd rect \(at 2\.75 -3\.95\)/u, "48 脚在上边最右（逆时针收到）");

  const soic = buildFootprint({ kind: "soic", name: "SOIC-8", pins: 8, pitch: 1.27, bodyWidthMm: 3.9 });
  assert.equal(soic.ok, true, soic.error);
  assert.equal(soic.pinCount, 8);
  assert.match(soic.text, /\(pad "1" smd rect \(at -2\.35 -1\.905\)/u);
  assert.match(soic.text, /\(pad "8" smd rect \(at 2\.35 -1\.905\)/u, "8 脚在右列最上（自下而上接续）");

  const passive = buildFootprint({ kind: "passive", name: "R_0402_1005Metric", bodyWidthMm: 1, bodyHeightMm: 0.5 });
  assert.equal(passive.ok, true, passive.error);
  assert.equal((passive.text.match(/\(pad "/gu) ?? []).length, 2);

  const bad = buildFootprint({ kind: "qfp", name: "X", pins: 10, pitch: 0.5, bodyWidthMm: 7, bodyHeightMm: 7 });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /4 的倍数/u);
  const missing = buildFootprint({ kind: "soic", name: "X", pins: 8 });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /pitch/u, "缺 pitch 必须报错，不猜");

  const sym = buildSymbol({
    name: "STM32F103C8T6",
    pins: [
      { number: "1", name: "VBAT", kind: "power_in" },
      { number: "2", name: "PC13" },
      { number: "3", name: "PC14" },
      { number: "4", name: "VSS", kind: "power_in" },
    ],
  });
  assert.equal(sym.ok, true, sym.error);
  assert.equal(sym.pinCount, 4);
  assert.equal((sym.text.match(/\(pin /gu) ?? []).length, 4);
  assert.match(sym.text, /\(pin power_in line \(at -7\.62 1\.27 0\)/u, "左列第一脚在左边界外一格、比本体顶低一格");
  assert.match(sym.text, /\(number "1"/u);
  assert.equal(sym.bodyWidthMm >= 10, true, "本体宽按最长引脚名推");
  const dup = buildSymbol({ name: "X", pins: [{ number: "1", name: "A" }, { number: "1", name: "B" }] });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /编号重复/u);
  const noNum = buildSymbol({ name: "X", pins: [{ number: "", name: "A" }] });
  assert.equal(noNum.ok, false);
  assert.match(noNum.error, /缺 number/u);
});

test("布线体检：差分对长度差、平面层上的信号、去耦电容到引脚的距离（S165）", () => {
  const board = [
    "(kicad_pcb (version 20241229)",
    '  (layers "F.Cu" "In1.Cu" "B.Cu")',
    '  (net 0 "")',
    '  (net 1 "GND")',
    '  (net 2 "VBUS")',
    '  (net 3 "USB_DP")',
    '  (net 4 "USB_DN")',
    '  (net 5 "V3V3")',
    '  (footprint "x:u1" (layer "F.Cu") (at 10 10) (property "Reference" "U1")',
    '    (pad "1" smd rect (at 0 0) (layers "F.Cu") (net 5 "V3V3"))',
    '    (pad "2" smd rect (at 2 0) (layers "F.Cu") (net 1 "GND")))',
    '  (footprint "x:c1" (layer "F.Cu") (at 11 10) (property "Reference" "C1") (property "Value" "100nF")',
    '    (pad "1" smd rect (at 0 0) (layers "F.Cu") (net 5 "V3V3"))',
    '    (pad "2" smd rect (at 1 0) (layers "F.Cu") (net 1 "GND")))',
    '  (segment (start 0 0) (end 10 0) (width 0.2) (layer "F.Cu") (net 3))',
    '  (segment (start 0 1) (end 10 1) (width 0.2) (layer "B.Cu") (net 4))',
    '  (via (at 5 0) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 3))',
    '  (zone (net 1) (layer "In1.Cu") (polygon (pts (xy 0 0) (xy 10 0) (xy 10 10))))',
    '  (segment (start 1 5) (end 6 5) (width 0.2) (layer "In1.Cu") (net 2)))',
    "",
  ].join("\n");
  const report = analyzeLinks(board, "board.kicad_pcb");
  assert.equal(report.ok, true, report.error);
  assert.equal(report.copperLayers, 3);
  assert.equal(report.pairs.length, 1);
  const pair = report.pairs[0];
  assert.equal(pair.id, "USB");
  assert.equal(pair.routedP, true);
  assert.equal(pair.routedN, true);
  assert.equal(pair.lengthPMm, 10);
  assert.equal(pair.lengthNMm, 10);
  assert.equal(pair.deltaMm, 0);
  assert.equal(pair.viasP, 1);
  assert.equal(pair.viasN, 0);
  assert.match(pair.notes.join("；"), /过孔数不同/u);

  assert.equal(report.decaps.length, 1);
  assert.equal(report.decaps[0].ref, "C1");
  assert.equal(report.decaps[0].powerNet, "V3V3");
  assert.equal(report.decaps[0].distanceMm, 1);
  assert.equal(report.decaps[0].nearestRef, "U1");
  assert.equal(report.decaps[0].ok, true);

  const inner = report.planes.find((plane) => plane.layer === "In1.Cu");
  assert.equal(inner.planeNets.length, 1);
  assert.equal(inner.trackCount, 1);
  assert.equal(report.findings.some((finding) => finding.id === "plane.signals-on-plane-layer"), true);

  // 长度差超限要报；没有差分对与铺铜时如实说「没有」。
  const skewed = analyzeLinks(
    board.replace('(segment (start 0 1) (end 10 1)', '(segment (start 0 1) (end 4 1)'),
    "board.kicad_pcb",
    { toleranceMm: 0.5 },
  );
  assert.equal(skewed.pairs[0].deltaMm, 6);
  assert.equal(skewed.pairs[0].ok, false);
  assert.equal(skewed.findings.some((finding) => finding.id === "pair.length-skew"), true);

  const plain = analyzeLinks([
    "(kicad_pcb (version 20241229)",
    '  (layers "F.Cu" "B.Cu")',
    '  (net 1 "GND")',
    "  )",
    "",
  ].join("\n"), "plain.kicad_pcb");
  assert.equal(plain.ok, true);
  assert.equal(plain.pairs.length, 0);
  assert.equal(plain.decaps.length, 0);
  assert.match(plain.notes.join("；"), /没有认出差分对/u);
  assert.match(plain.notes.join("；"), /没有任何铺铜区/u);

  const broken = analyzeLinks("(kicad_pcb", "broken.kicad_pcb");
  assert.equal(broken.ok, false);
  assert.match(broken.error, /读不懂|括号/u);
});

test("制造文件回看：Gerber 的线/焊盘/区域与 Excellon 的孔都对得上，选层不影响钻孔（S166）", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-gerber-"));
  try {
    // 一个最小可用的两层板：板框、一顶层走线 + 一个焊盘 + 一块 G36 区域、一个钻孔。
    const lay = (name, body) => {
      writeFileSync(join(dir, name), [
        "%TF.GenerationSoftware,KiCad,Pcbnew,10.0.7*%",
        "%FSLAX46Y46*%",
        "%MOMM*%",
        "%LPD*%",
        "G01*",
        "%ADD10C,0.500000*%",
        "%ADD11R,1.000000X0.600000*%",
        "D10*",
        body,
        "M02*",
      ].join("\n"));
    };
    lay("board-F_Cu.gtl", [
      "X10000000Y20000000D02*",
      "X20000000Y20000000D01*",
      "D11*",
      "X30000000Y30000000D03*",
      "G36*",
      "X0Y0D02*",
      "X5000000Y0D01*",
      "X5000000Y5000000D01*",
      "G37*",
    ].join("\n"));
    lay("board-Edge_Cuts.gm1", "X0Y0D02*\nX60000000Y0D01*\nX60000000Y100000000D01*\nX0Y100000000D01*\nX0Y0D01*");
    writeFileSync(join(dir, "board.drl"), ["M48", "; FORMAT={-:-/ absolute / metric / decimal}", "FMAT,2", "METRIC", "T1C0.400", "%", "G90", "G05", "T1", "X10.0Y-20.0", "X30.0Y-30.0", "M30"].join("\n"));
    const view = readGerberSet(dir);
    assert.equal(view.ok, true, view.error);
    assert.equal(view.drillHoles, 2);
    assert.equal(view.widthMm > 60, true);
    const cu = view.layers.find((layer) => layer.name === "F_Cu");
    assert.equal(cu.kind, "copper");
    assert.equal(cu.segments, 1);
    assert.equal(cu.flashes, 1);
    assert.equal(cu.regions, 1);
    const edge = view.layers.find((layer) => layer.name === "Edge_Cuts");
    assert.equal(edge.kind, "edge");
    assert.equal(edge.segments, 4);
    assert.match(view.svg, /<svg/u);
    assert.match(view.svg, /data-layer="F_Cu"/u);
    assert.match(view.svg, /data-layer="DRILL"/u);
    // 只选铜层时，钻孔仍要画（它不属于任何一层）。
    const onlyCu = readGerberSet(dir, { layers: ["F_Cu"] });
    assert.equal(onlyCu.ok, true, onlyCu.error);
    assert.equal(onlyCu.layers.length, 1);
    assert.equal(onlyCu.drillHoles, 2);
    // 空目录给人话。
    const empty = readGerberSet(join(dir, "nope"));
    assert.equal(empty.ok, false);
    assert.match(empty.error, /读不到|没有/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EMC 深度体检：差分对间距、回流覆盖、串扰都不算差分对内部（S167）", () => {
  const board = [
    "(kicad_pcb",
    '  (version 20241229)',
    '  (layers (0 "F.Cu" signal) (1 "In1.Cu" signal) (2 "In2.Cu" signal) (31 "B.Cu" signal))',
    '  (net 1 "GND")',
    '  (net 2 "USB_DP")',
    '  (net 3 "USB_DN")',
    '  (net 4 "SIG_A")',
    '  (net 5 "SIG_B")',
    '  (segment (start 0 0) (end 10 0) (width 0.2) (layer "F.Cu") (net 2))',
    '  (segment (start 0 0.15) (end 10 0.15) (width 0.2) (layer "F.Cu") (net 3))',
    '  (segment (start 0 5) (end 10 5) (width 0.2) (layer "F.Cu") (net 4))',
    '  (segment (start 0 5.05) (end 10 5.05) (width 0.2) (layer "F.Cu") (net 5))',
    '  (zone (net 1) (net_name "GND") (layer "In1.Cu") (filled_polygon (layer "In1.Cu") (pts (xy -1 -1) (xy 12 -1) (xy 12 6) (xy -1 6))))',
    '  (zone (net 1) (net_name "GND") (layer "In2.Cu") (polygon (pts (xy 20 20) (xy 30 20) (xy 30 30))))',
    ")",
  ].join("\n");
  const report = analyzeEmcDeep(board, "C:/tmp/dsh-ecad-deep.kicad_pcb");
  assert.equal(report.ok, true, report.error);
  // 差分对：USB_DP / USB_DN 间距 0.15 mm，在 0.1–1 mm 之间算画对了。
  assert.equal(report.pairs.length, 1);
  assert.equal(report.pairs[0].id, "USB");
  assert.equal(report.pairs[0].minMm, 0.15);
  assert.equal(report.pairs[0].ok, true);
  // 回流：In1.Cu 有已填充的铜皮，F.Cu 的线全在铜皮覆盖范围内。
  assert.equal(report.returnPaths.length, 1);
  assert.equal(report.returnPaths[0].referenceLayer, "In1.Cu");
  assert.equal(report.returnPaths[0].onPlane > 0, true);
  assert.equal(report.returnPaths[0].ok, true);
  // 串扰：只有 SIG_A / SIG_B 这一对（差分对内部不算）。
  assert.equal(report.crosstalk.length, 1);
  assert.equal(report.crosstalk[0].victim, "SIG_B");
  assert.equal(report.crosstalk[0].ok, false);
  assert.equal(report.findings.some((item) => item.id === "emc.crosstalk"), true);
  assert.equal(report.findings.some((item) => item.id === "emc.pair-spacing"), false);
  // 只有轮廓、没有填充的铺铜要明说按未铺铜处理。
  assert.match(report.notes.join("\n"), /只有轮廓/u);
});

test("阻抗规则：单端要点名，差分对从板子里认，写盘两次不叠版本行（S168）", () => {
  const work = mkdtempSync(join(tmpdir(), "dsh-imp-"));
  const kicadDir = join(work, "kicad");
  mkdirSync(kicadDir, { recursive: true });
  writeFileSync(join(kicadDir, "board.kicad_pro"), "{}\n", "utf8");
  const pcb = [
    "(kicad_pcb (version 20241229)",
    '  (layers "F.Cu" "B.Cu" "In1.Cu" "In2.Cu")',
    '  (net 1 "VBUS") (net 2 "GND") (net 3 "USB_DP") (net 4 "USB_DN")',
    '  (segment (start 0 0) (end 5 0) (width 0.25) (layer "F.Cu") (net 1))',
    '  (segment (start 0 2) (end 5 2) (width 0.2) (layer "F.Cu") (net 3))',
    '  (segment (start 0 2.2) (end 5 2.2) (width 0.2) (layer "F.Cu") (net 4))',
    ")",
    "",
  ].join("\n");
  const boardFile = join(kicadDir, "board.kicad_pcb");
  writeFileSync(boardFile, pcb, "utf8");

  const dry = planImpedance(kicadDir, pcb, boardFile, { singles: ["VBUS"] });
  assert.equal(dry.ok, true);
  assert.equal(dry.written, false);
  assert.ok(dry.rules.some((rule) => rule.includes("阻抗 50Ω 单端 VBUS") && rule.includes("track_width (opt")));
  assert.ok(dry.rules.some((rule) => rule.includes("diff_pair_gap")), "差分对要写间距规则");
  assert.ok(dry.rules.some((rule) => rule.includes("USB_DP") && rule.includes("USB_DN")));
  assert.ok(dry.notes.some((note) => note.includes("没有 impedance 约束")));

  const wrote = planImpedance(kicadDir, pcb, boardFile, { singles: ["VBUS"], write: true });
  assert.equal(wrote.ok, true);
  assert.equal(wrote.written, true);
  const first = readFileSync(wrote.rulesFile, "utf8");
  assert.ok(first.startsWith("(version 1)"));
  assert.equal((first.match(/\(version 1\)/gu) || []).length, 1);
  assert.ok(first.includes("嘉立创 最小线宽"));
  assert.ok(first.includes("阻抗 50Ω 单端 VBUS"));

  const again = planImpedance(kicadDir, pcb, boardFile, { singles: ["VBUS"], write: true });
  const second = readFileSync(again.rulesFile, "utf8");
  assert.equal(second, first, "同样的输入写两次结果要一样");

  const noSingles = planImpedance(kicadDir, pcb, boardFile, {});
  assert.ok(noSingles.notes.some((note) => note.includes("没有点名单端网络")));

  rmSync(work, { recursive: true, force: true });
});

test("一致性门禁：读出拆网/缺焊盘/悬空件，图纸更新过就报板子旧（S169）", () => {
  const fixture = fileURLToPath(new URL("./fixtures/kicad-10-d-nfc", import.meta.url));
  const pcbFile = join(fixture, "D_NFC.kicad_pcb");
  const schematicFile = join(fixture, "D_NFC.kicad_sch");

  const report = checkNetGate("", { pcbFile, schematicFile });
  assert.equal(report.ok, true, report.error);
  assert.equal(report.state, "mismatch");
  assert.equal(report.compared, 25);
  assert.equal(report.matched, 24);
  assert.equal(report.split, 1);
  assert.equal(report.missingPads, 4);
  assert.ok(report.findings.some((finding) => finding.id === "gate.net-split" && finding.severity === "error"));
  assert.ok(report.findings.some((finding) => finding.id === "gate.pad-missing"));
  assert.ok(report.findings.some((finding) => finding.id === "gate.component-unconnected"));
  assert.ok(report.notes.some((note) => note.includes("没接到任何网络")));

  // 图纸比板子新：把板子的时间戳拨到 1 小时前，状态要变成 stale。
  const work = mkdtempSync(join(tmpdir(), "dsh-gate-"));
  const stalePcb = join(work, "board.kicad_pcb");
  copyFileSync(pcbFile, stalePcb);
  const past = statSync(schematicFile).mtimeMs / 1000 - 3600;
  utimesSync(stalePcb, past, past);
  const stale = checkNetGate("", { pcbFile: stalePcb, schematicFile });
  assert.equal(stale.staleSeconds > 3000, true, "应报出旧了多少秒");
  assert.ok(stale.findings.some((finding) => finding.id === "gate.stale-board"));
  assert.equal(stale.state === "stale" || stale.state === "mismatch", true);

  const none = checkNetGate("");
  assert.equal(none.ok, false);
  assert.ok(none.error.includes("projectDir"));

  rmSync(work, { recursive: true, force: true });
});

test("一致性门禁：手绘层多出来的元件与改过的网络都要点出来（S176）", () => {
  // 生成图纸用 sch-edit 夹具（有 lib_id，能克隆）；板子用 D_NFC 夹具（只用来比元件与网络）。
  const schFixture = fileURLToPath(new URL("./fixtures/sch-edit/index.kicad_sch", import.meta.url));
  const pcbFixture = fileURLToPath(new URL("./fixtures/kicad-10-d-nfc/D_NFC.kicad_pcb", import.meta.url));
  const schematicFile = schFixture;
  const pcbFile = pcbFixture;

  const work = mkdtempSync(join(tmpdir(), "dsh-hand-"));
  const handFile = drawSheetPath(work);
  mkdirSync(dirname(handFile), { recursive: true });
  writeFileSync(handFile, readFileSync(schematicFile, "utf8"), "utf8");

  // 手绘层里克隆一个 R2，并把 R2.1 接到 R1.1：元件与网络两边都会不一样。
  const hand = readDrawSheet(handFile);
  const kinds = symbolBlocks(hand);
  assert.ok(kinds.length > 0, "夹具里要有元件块");
  const drawn = drawOnSheet(hand, handFile, [
    { op: "clone", from: "R1", ref: "R2", at: { x: 200, y: 100 } },
    { op: "wire", a: { ref: "R2", pin: "1" }, b: { ref: "R1", pin: "1" } },
  ]);
  assert.equal(drawn.ok, true, drawn.error);
  writeFileSync(handFile, drawn.text, "utf8");

  const report = checkNetGate(work, { pcbFile, schematicFile });
  assert.equal(report.ok, true, report.error);
  assert.equal(report.hand.exists, true);
  assert.equal(report.hand.partsOnlyInHand.includes("R2"), true, "手绘层多的元件要点出来");
  assert.equal(report.hand.pinsChanged.length > 0, true, "改过的网络要点出来");
  assert.ok(report.findings.some((finding) => finding.id === "hand.part-not-in-build"));
  assert.ok(report.findings.some((finding) => finding.id === "hand.net-diff"));

  // 没有手绘层的地方要如实说没有。
  const plain = mkdtempSync(join(tmpdir(), "dsh-hand-none-"));
  const none = checkNetGate(plain, { pcbFile, schematicFile });
  assert.equal(none.hand.exists, false);

  rmSync(work, { recursive: true, force: true });
  rmSync(plain, { recursive: true, force: true });
});

test("原理图编辑：连线插在两脚端点之间，重放幂等，标名落在引脚上（S170）", () => {
  const file = fileURLToPath(new URL("./fixtures/sch-edit/index.kicad_sch", import.meta.url));
  const before = readFileSync(file, "utf8");
  const sheet = parseSchText(before, file, file);
  assert.ok(sheet.symbols.length >= 2, "夹具里要有两个元件");
  const from = pinPoint(sheet, "R1", "1");
  const to = pinPoint(sheet, "C1", "2");
  assert.ok(from !== null && to !== null, "两个引脚都要能定位");

  const edits = [
    { op: "connect", a: { ref: "R1", pin: "1" }, b: { ref: "C1", pin: "2" } },
    { op: "label", at: { ref: "R1", pin: "2" }, text: "SENSE" },
  ];
  const outcome = applySchEdits(before, file, edits);
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.applied, 2);
  assert.equal(outcome.skipped, 0);
  assert.deepEqual(outcome.failed, []);

  const after = parseSchText(outcome.text, file, file);
  assert.ok(after.wires.length >= 1, "应写进一条导线");
  // 同轴则一条线，否则 L 形两段。
  const aligned = Math.abs(from.x - to.x) < 0.001 || Math.abs(from.y - to.y) < 0.001;
  assert.equal(after.wires.length, sheet.wires.length + (aligned ? 1 : 2), "应按同轴或 L 形写入导线");
  const near = (x, y, point) => Math.abs(x - point.x) < 0.01 && Math.abs(y - point.y) < 0.01;
  const touches = (point) => after.wires.some((wire) => near(wire.a.x, wire.a.y, point) || near(wire.b.x, wire.b.y, point));
  assert.equal(touches(from), true, "起点要落在 R1.1 的引脚端点上");
  assert.equal(touches(to), true, "终点要落在 C1.2 的引脚端点上");

  assert.equal(after.labels.some((label) => label.name === "SENSE"), true, "标名要写进图纸");

  const again = applySchEdits(outcome.text, file, edits);
  assert.equal(again.applied, 0, "重放不应再画一遍");
  assert.equal(again.skipped, 2);

  const missing = applySchEdits(before, file, [{ op: "connect", a: { ref: "R1", pin: "9" }, b: { ref: "C1", pin: "1" } }]);
  assert.equal(missing.applied, 0);
  assert.ok(missing.failed[0].includes("R1"), "找不到的引脚要指名道姓");
});

test("原理图编辑：重放走构建目录，第一次落盘、第二次只计跳过（S170）", () => {
  const file = fileURLToPath(new URL("./fixtures/sch-edit/index.kicad_sch", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "dsh-replay-"));
  const target = join(dir, "index.kicad_sch");
  copyFileSync(file, target);
  const edits = [{ op: "connect", a: { ref: "R1", pin: "1" }, b: { ref: "C1", pin: "2" } }];
  const first = replaySchEditsTo(dir, edits);
  assert.equal(first.applied, 1, "第一次要真的画上去");
  assert.equal(first.failed.length, 0);
  assert.ok(first.notes.some((note) => note.includes("已重放")));
  const again = replaySchEditsTo(dir, edits);
  assert.equal(again.applied, 0);
  assert.equal(again.skipped, 1);
  assert.ok(again.notes.some((note) => note.includes("已经画在图纸上")));
  const empty = replaySchEditsTo("", edits);
  assert.equal(empty.applied, 0);
  assert.ok(empty.notes.some((note) => note.includes("还没有构建产物")));
});

const PCB = `(kicad_pcb (version 20241229) (generator "dsh-stm32")
  (gr_line (start 0 0) (end 30 0) (layer "Edge.Cuts"))
  (gr_line (start 30 0) (end 30 20) (layer "Edge.Cuts"))
  (gr_line (start 30 20) (end 0 20) (layer "Edge.Cuts"))
  (gr_line (start 0 20) (end 0 0) (layer "Edge.Cuts"))
  (footprint "tscircuit:resistor_res0402" (layer "F.Cu") (at 5 5)
    (property "Reference" "R1")
    (property "Value" "10kΩ")
    (pad "1" smd rect (at 0 0) (size 0.6 0.6) (layers "F.Cu") (net 1 "GND"))
    (pad "2" smd rect (at 1 0) (size 0.6 0.6) (layers "F.Cu") (net ".R1 > .pin2 to .C1 > .pin2"))
  )
  (footprint "tscircuit:capacitor_cap0402" (layer "F.Cu") (at 12 5)
    (property "Reference" "C1")
    (property "Value" "100nF")
    (property "Supplier Part Number" "C1525, C307331")
    (pad "1" smd rect (at 0 0) (size 0.6 0.6) (layers "F.Cu") (net 1 "GND"))
    (pad "2" smd rect (at 1 0) (size 0.6 0.6) (layers "F.Cu") (net ".R1 > .pin2 to .C1 > .pin2"))
  )
  (footprint "tscircuit:led_diode0603_anodepin2_cathodepin1" (layer "F.Cu") (at 20 5)
    (property "Reference" "D1")
    (property "Value" "LED")
    (pad "1" smd rect (at 0 0) (size 0.6 0.6) (layers "F.Cu") (net "VCC"))
    (pad "2" smd rect (at 1 0) (size 0.6 0.6) (layers "F.Cu") (net "VCC"))
  )
)`;

test("吸收：网络按 tscircuit 的 A to B 名合并，元件值与封装还原（S172）", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-import-"));
  const board = join(dir, "board.kicad_pcb");
  writeFileSync(board, PCB);
  const state = readImportState(board);
  assert.equal(state.ok, true);
  assert.equal(state.widthMm, 30);
  assert.equal(state.heightMm, 20);
  assert.deepEqual(state.parts.map((part) => part.ref), ["C1", "D1", "R1"]);
  const c1 = state.parts.find((part) => part.ref === "C1");
  assert.equal(c1?.value, "100nF");
  assert.equal(c1?.footprint, "0402");
  assert.deepEqual(c1?.suppliers, ["C1525", "C307331"]);
  assert.equal(state.nets.length, 3);
  const ground = state.nets.find((net) => net.name === "GND");
  assert.deepEqual(ground?.pins, [{ ref: "C1", pin: "1" }, { ref: "R1", pin: "1" }]);
  const pair = state.nets.find((net) => net.pins.some((pin) => pin.ref === "R1"));
  assert.deepEqual(pair?.pins, [{ ref: "C1", pin: "2" }, { ref: "R1", pin: "2" }]);
  const power = state.nets.find((net) => net.name === "VCC");
  assert.deepEqual(power?.pins, [{ ref: "D1", pin: "1" }, { ref: "D1", pin: "2" }]);
  rmSync(dir, { recursive: true, force: true });
});

test("吸收：生成的 TSX 用 jlcpcb 对象写料号、二极管补 pinLabels，电阻值去掉 Ω（S172）", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-import-"));
  const board = join(dir, "board.kicad_pcb");
  writeFileSync(board, PCB);
  const state = readImportState(board);
  const source = renderCircuitSource(state);
  assert.ok(source.includes('<board width="30mm" height="20mm">'));
  assert.ok(source.includes('resistance="10k"'));
  assert.ok(source.includes('supplierPartNumbers={{ jlcpcb: ["C1525", "C307331"] }}'));
  assert.ok(source.includes('pinLabels={{ "pin1": "cathode", "pin2": "anode" }}'));
  assert.ok(source.includes('<trace from=".C1 > .pin2" to=".R1 > .pin2" />'));
  rmSync(dir, { recursive: true, force: true });
});

test("吸收：diff 只报增删改，写盘前留 .bak，备份失败就不改源（S172）", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-import-"));
  const board = join(dir, "board.kicad_pcb");
  const source = join(dir, "index.circuit.tsx");
  const circuitJson = join(dir, "circuit.json");
  writeFileSync(board, PCB);
  writeFileSync(source, "// 旧源\n");
  writeFileSync(circuitJson, JSON.stringify([
    { type: "source_component", name: "R1", ftype: "simple_resistor", value: "10k" },
    { type: "source_component", name: "C1", ftype: "simple_capacitor", value: "100nF" },
  ]));
  const preview = absorbFromKicad(dir, { boardFile: board, sourceFile: source, circuitJsonFile: circuitJson });
  assert.equal(preview.written, false);
  assert.deepEqual(preview.diff.added, ["D1"]);
  assert.deepEqual(preview.diff.changed, []);
  assert.equal(readFileSync(source, "utf8"), "// 旧源\n");
  const stored = absorbFromKicad(dir, { boardFile: board, sourceFile: source, circuitJsonFile: circuitJson, write: true });
  assert.equal(stored.written, true);
  assert.ok(readFileSync(source, "utf8").includes("由 dsh-stm32 从 KiCad 工程吸收"));
  assert.ok(readdirSync(dir).some((name) => name.endsWith(".bak")));
  const diff = diffImport(readImportState(board), readFileSync(circuitJson, "utf8"));
  assert.deepEqual(diff.added, ["D1"]);
  assert.equal(diff.removed.length, 0);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(existsSync(dir), false);
});

// S173：器件导入用合成库，离线验证「复制封装 + 生成符号 + 登记库表」三件事。
const SOIC8_MOD = `(footprint "SOIC-8_3.9x4.9mm_P1.27mm" (version 20260206) (generator "pcbnew")
  (layer "F.Cu")
  (pad "1" smd roundrect (at -2.7 -1.905) (size 1.5 0.6) (layers "F.Cu" "F.Paste" "F.Mask"))
  (pad "2" smd roundrect (at -2.7 -0.635) (size 1.5 0.6) (layers "F.Cu" "F.Paste" "F.Mask"))
  (pad "3" smd roundrect (at -2.7 0.635) (size 1.5 0.6) (layers "F.Cu" "F.Paste" "F.Mask"))
  (pad "4" smd roundrect (at -2.7 1.905) (size 1.5 0.6) (layers "F.Cu" "F.Paste" "F.Mask"))
  (pad "5" smd roundrect (at 2.7 1.905) (size 1.5 0.6) (layers "F.Cu" "F.Paste" "F.Mask"))
  (pad "6" smd roundrect (at 2.7 0.635) (size 1.5 0.6) (layers "F.Cu" "F.Paste" "F.Mask"))
  (pad "7" smd roundrect (at 2.7 -0.635) (size 1.5 0.6) (layers "F.Cu" "F.Paste" "F.Mask"))
  (pad "8" smd roundrect (at 2.7 -1.905) (size 1.5 0.6) (layers "F.Cu" "F.Paste" "F.Mask"))
)`;

function fakeToolchain(footprintDir) {
  return {
    root: "C:/fake/KiCad",
    kicadCli: "C:/fake/KiCad/bin/kicad-cli.exe",
    bun: "",
    python: "",
    footprintDir,
    symbolDir: footprintDir,
    model3dDir: footprintDir,
    env: {},
    notes: [],
  };
}

test("器件导入：复制封装、按焊盘生符号、两张库表各一条（S173）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-part-"));
  const libDir = join(dir, "kicad-libs", "footprints");
  mkdirSync(join(libDir, "Package_SO.pretty"), { recursive: true });
  writeFileSync(join(libDir, "Package_SO.pretty", "SOIC-8_3.9x4.9mm_P1.27mm.kicad_mod"), SOIC8_MOD);
  mkdirSync(join(dir, "project", "hardware", "kicad"), { recursive: true });

  const toolchain = fakeToolchain(libDir);
  const preview = await importPart(join(dir, "project"), toolchain, {
    footprint: "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm",
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.pads.length, 8);
  assert.deepEqual(preview.written, []);
  assert.ok(preview.footprint !== null && preview.footprint.file.includes("libs"));

  const written = await importPart(join(dir, "project"), toolchain, {
    footprint: "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm",
    code: "C1234",
    write: true,
    fetchImpl: async () => new Response("<html>no pdf here</html>"),
  });
  assert.equal(written.ok, true);
  assert.equal(written.written.length, 4);
  const mod = readFileSync(written.footprint.file, "utf8");
  assert.ok(mod.includes('(property "LCSC" "C1234"'));
  assert.ok(mod.includes("(pad \"8\""));
  assert.ok(readFileSync(written.symbol.file, "utf8").includes('(symbol "SOIC-8_3.9x4.9mm_P1.27mm"'));
  const fpTable = readFileSync(join(dir, "project", "hardware", "kicad", "fp-lib-table"), "utf8");
  assert.equal((fpTable.match(/\(fp_lib_table/gu) ?? []).length, 1);
  assert.ok(fpTable.includes('(lib (name "Package_SO")'));
  assert.ok(fpTable.includes("libs/footprints/Package_SO.pretty"));

  const again = await importPart(join(dir, "project"), toolchain, {
    footprint: "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm",
    write: true,
    fetchImpl: async () => new Response("<html></html>"),
  });
  assert.equal(again.ok, true);
  const table2 = readFileSync(join(dir, "project", "hardware", "kicad", "fp-lib-table"), "utf8");
  assert.equal((table2.match(/\(fp_lib_table/gu) ?? []).length, 1);
  assert.equal((table2.match(/\(lib \(name "Package_SO"\)/gu) ?? []).length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("器件导入：库里没有就报缺哪个封装，立创编号格式不对直接拒（S173）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-part-"));
  const libDir = join(dir, "kicad-libs");
  mkdirSync(libDir, { recursive: true });
  const toolchain = fakeToolchain(libDir);
  const missing = await importPart(dir, toolchain, { footprint: "Package_SO:NOPE-8" });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /库里没有这个封装/u);
  mkdirSync(join(dir, "hardware", "kicad"), { recursive: true });
  mkdirSync(join(libDir, "Local.pretty"), { recursive: true });
  writeFileSync(join(libDir, "Local.pretty", "SOIC-8_3.9x4.9mm_P1.27mm.kicad_mod"), SOIC8_MOD);
  const badCode = await importPart(dir, toolchain, { footprint: "SOIC-8_3.9x4.9mm_P1.27mm", code: "1234" });
  assert.equal(badCode.ok, false);
  assert.match(badCode.error, /立创编号格式不对/u);
  rmSync(dir, { recursive: true, force: true });
});

// S174：手绘层只改图纸文本，四个动作都幂等；缺元件/缺脚要报出来。
test("手绘层：克隆、连线、标名、挪动都能落到图纸上，重复执行幂等（S174）", () => {
  const fixture = fileURLToPath(new URL("./fixtures/sch-edit/index.kicad_sch", import.meta.url));
  const source = readFileSync(fixture, "utf8");
  const first = drawOnSheet(source, fixture, [
    { op: "clone", from: "R1", ref: "R2" },
    { op: "wire", a: { ref: "R2", pin: "1" }, b: { ref: "R1", pin: "1" } },
    { op: "label", at: { ref: "R2", pin: "2" }, text: "SENSE" },
    { op: "move", ref: "C1", at: { x: 120, y: 90 } },
  ]);
  assert.equal(first.ok, true);
  assert.equal(first.applied, 4);
  assert.equal(first.failed.length, 0);
  assert.ok(first.text.includes('(property "Reference" "R2"'));
  assert.ok(first.text.includes('(label "SENSE"'));
  assert.ok(first.text.includes("(at 120 90 0)"));
  assert.ok(symbolBlocks(first.text).length === symbolBlocks(source).length + 1);

  const second = drawOnSheet(first.text, fixture, [
    { op: "clone", from: "R1", ref: "R2" },
    { op: "wire", a: { ref: "R2", pin: "1" }, b: { ref: "R1", pin: "1" } },
    { op: "label", at: { ref: "R2", pin: "2" }, text: "SENSE" },
  ]);
  assert.equal(second.applied, 0);
  assert.equal(second.skipped, 3);

  const removed = drawOnSheet(first.text, fixture, [{ op: "remove", ref: "R2" }]);
  assert.equal(removed.ok, true);
  assert.equal(symbolBlocks(removed.text).length, symbolBlocks(source).length);

  const bad = drawOnSheet(source, fixture, [
    { op: "wire", a: { ref: "R9", pin: "1" }, b: { ref: "R1", pin: "1" } },
    { op: "clone", from: "R7", ref: "R8" },
  ]);
  assert.equal(bad.ok, false);
  assert.equal(bad.applied, 0);
  assert.equal(bad.failed.length, 2);
  assert.match(bad.failed[0], /起点找不到/u);
  assert.match(bad.failed[1], /图纸里没有 R7/u);
});

test("手绘层：底图已存在就不覆盖，构建图纸不存在时说清先构建（S174）", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-draw-"));
  const buildSheet = join(dir, "build.kicad_sch");
  const handSheet = drawSheetPath(join(dir, "project"));
  writeFileSync(buildSheet, "(kicad_sch (version 20250114) (generator test))");
  const seeded = seedDrawSheet(buildSheet, handSheet);
  assert.equal(seeded.ok, true);
  assert.equal(seeded.seeded, true);
  writeDrawSheet(handSheet, "(hand)");
  const again = seedDrawSheet(buildSheet, handSheet);
  assert.equal(again.seeded, false);
  assert.equal(readDrawSheet(handSheet), "(hand)");
  const missing = seedDrawSheet(join(dir, "nope.kicad_sch"), join(dir, "x.kicad_sch"));
  assert.equal(missing.ok, false);
  assert.match(missing.error, /还没有可用的构建图纸/u);
  rmSync(dir, { recursive: true, force: true });
});

// S175：从符号库放一个全新器件——内嵌 lib_symbols、生成实例、引脚号随库走。
test("放置：从 .kicad_sym 内嵌符号并生成实例，库缺失要报出来（S175）", () => {
  const fixture = fileURLToPath(new URL("./fixtures/sch-edit/index.kicad_sch", import.meta.url));
  const source = readFileSync(fixture, "utf8");
  const libText = `(kicad_symbol_lib
  (version 20241209)
  (generator "test")
  (symbol "R_Small"
    (pin_numbers (hide yes))
    (pin_names (offset 0.254) (hide yes))
    (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
    (property "Value" "R_Small" (at 0 0 90) (effects (font (size 1.27 1.27))))
    (symbol "R_Small_0_1"
      (rectangle (start -0.762 1.27) (end 0.762 -1.27) (stroke (width 0.254) (type default)) (fill (type none)))
    )
    (symbol "R_Small_1_1"
      (pin passive line (at 0 2.54 270) (length 1.27)
        (name "~" (effects (font (size 1.27 1.27))))
        (number "1" (effects (font (size 1.27 1.27)))))
      (pin passive line (at 0 -2.54 90) (length 1.27)
        (name "~" (effects (font (size 1.27 1.27))))
        (number "2" (effects (font (size 1.27 1.27)))))
    )
  )
)`;

  const placed = drawOnSheet(source, fixture, [
    { op: "place", libId: "Device:R_Small", ref: "R9", at: { x: 130, y: 120 }, value: "4k7", footprint: "Resistor_SMD:R_0603_1608Metric" },
  ], (libId) => (libId === "Device:R_Small" ? libText : null));
  assert.equal(placed.ok, true);
  assert.equal(placed.applied, 1);
  assert.ok(placed.text.includes('(symbol "Device:R_Small"'));
  assert.ok(placed.text.includes('(lib_id "Device:R_Small")'));
  assert.ok(placed.text.includes('(property "Reference" "R9"'));
  assert.ok(placed.text.includes('(property "Value" "4k7"'));
  assert.ok(placed.text.includes('(pin "1"'));
  assert.equal((placed.text.match(/\(lib_id "Device:R_Small"\)/gu) ?? []).length, 1);

  const twice = drawOnSheet(placed.text, fixture, [
    { op: "place", libId: "Device:R_Small", ref: "R9", at: { x: 130, y: 120 } },
  ], () => libText);
  assert.equal(twice.applied, 0);
  assert.equal(twice.skipped, 1);

  const missing = drawOnSheet(source, fixture, [
    { op: "place", libId: "Device:NOPE", ref: "R8", at: { x: 100, y: 100 } },
  ], () => null);
  assert.equal(missing.ok, false);
  assert.match(missing.failed[0], /找不到符号库/u);

  const noLibTable = drawOnSheet("(kicad_sch (version 20250114) (generator test))", fixture, [
    { op: "place", libId: "Device:R_Small", ref: "R7", at: { x: 1, y: 1 } },
  ], () => libText);
  assert.equal(noLibTable.ok, false);
  assert.match(noLibTable.failed[0], /lib_symbols/u);
});

test("手绘层补封装：已在板上的跳过，tscircuit 封装不补，克隆的新件带库与网络计划（S177）", () => {
  const work = mkdtempSync(join(tmpdir(), "dsh-handsync-"));
  try {
    const fixture = fileURLToPath(new URL("./fixtures/sch-edit/index.kicad_sch", import.meta.url));
    const sheetDir = join(work, "hardware", "schematic");
    mkdirSync(sheetDir, { recursive: true });
    const sheet = join(sheetDir, "schematic.kicad_sch");
    copyFileSync(fixture, sheet);

    const kicad = join(work, "hardware", "kicad");
    mkdirSync(kicad, { recursive: true });
    const board = join(kicad, "board.kicad_pcb");
    writeFileSync(
      board,
      [
        "(kicad_pcb (version 20241229) (generator pcbnew)",
        "  (layers (0 F.Cu signal) (2 B.Cu signal))",
        '  (net 0 "")',
        '  (net 1 "GND")',
        "  (gr_line (start 0 0) (end 30 0) (width 0.1) (layer Edge.Cuts))",
        "  (gr_line (start 30 0) (end 30 20) (width 0.1) (layer Edge.Cuts))",
        "  (gr_line (start 30 20) (end 0 20) (width 0.1) (layer Edge.Cuts))",
        "  (gr_line (start 0 20) (end 0 0) (width 0.1) (layer Edge.Cuts))",
        '  (footprint "Resistor_SMD:R_0402_1005Metric" (layer F.Cu) (at 5 5)',
        '    (property "Reference" "R1" (at 0 0 0))',
        '    (pad "1" smd rect (at -0.5 0) (size 0.5 0.6) (layers "F.Cu") (net 1 "GND"))',
        "  )",
        ")",
        "",
      ].join("\n"),
    );

    const first = planHandSync(work, { boardFile: board, schematicFile: sheet });
    assert.equal(first.ok, true);
    assert.equal(first.alreadyOnBoard.includes("R1"), true, "R1 已在板上，应跳过");
    assert.equal(first.noFootprint.some((item) => item.startsWith("C1") && item.includes("tscircuit")), true, "tscircuit 封装不补，要如实说");
    assert.match(first.notes.join("\n"), /tscircuit/u);

    const cloned = drawOnSheet(readDrawSheet(sheet), sheet, [
      { op: "clone", from: "R1", ref: "R30", at: { x: 40, y: 30 }, value: "4k7", footprint: "Resistor_SMD:R_0402_1005Metric" },
      { op: "wire", a: { ref: "R30", pin: "1" }, b: { ref: "R30", pin: "2" } },
    ]);
    assert.equal(cloned.ok, true);
    writeFileSync(sheet, cloned.text, "utf8");

    const plan = planHandSync(work, { boardFile: board, schematicFile: sheet });
    assert.equal(plan.ok, true);
    const part = plan.parts.find((item) => item.ref === "R30");
    assert.notEqual(part, undefined);
    assert.equal(part.library, "Resistor_SMD");
    assert.equal(part.footprintName, "R_0402_1005Metric");
    assert.equal(part.value, "4k7");
    assert.equal(typeof part.x, "number");
    assert.equal(part.y > 20, true, "暂定位置应在板框下方");
    assert.equal(part.nets.every((net) => assignableNet(net.net)), true);
    assert.match(plan.notes.join("\n"), /坐标是暂定的/u);

    const script = buildHandSyncScript(plan);
    assert.match(script, /FootprintLoad/u);
    assert.match(script, /\.pretty/u);
    assert.match(script, /SetReference/u);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("手绘层补封装：自动网名不赋，脚本输出只认最后一行 JSON（S177）", () => {
  assert.equal(assignableNet("SENSE"), true);
  assert.equal(assignableNet("GND"), true);
  assert.equal(assignableNet(""), false);
  assert.equal(assignableNet("N$12"), false);
  assert.equal(assignableNet("Net-(R1-Pad1)"), false);
  assert.equal(assignableNet(".C1 > .pin2 to .D1 > .anode"), false);

  const parsed = parseHandSyncOutput(['warning: swig', '{"added":2,"skipped":["R5"],"missingLib":["Foo"],"unassigned":1}'].join("\n"));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.added, 2);
  assert.deepEqual(parsed.skipped, ["R5"]);
  assert.deepEqual(parsed.missingLib, ["Foo"]);
  assert.equal(parsed.unassigned, 1);
  assert.equal(parseHandSyncOutput("no json here").ok, false);
});
