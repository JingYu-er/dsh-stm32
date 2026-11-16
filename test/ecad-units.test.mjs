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
import { exportEmbeddedLibraries, scanPcbFootprints, scanSchSymbols, upsertLibEntries } from "../lib/engine/ecad/libs.js";
import { checkDfm, estimateCost, readBoardFacts, renderDru, writeDru } from "../lib/engine/ecad/dfm.js";
import { normalizeKicadProject, normalizePcbFootprintNames, readCanonicalFootprints } from "../lib/engine/ecad/normalize.js";
import { parseJlcpcbFootprints, vendorJlcpcbFootprints } from "../lib/engine/ecad/jlcpcb.js";
import { collectModelPaths, prepareModels3d, resolveModels, rewriteModelPaths } from "../lib/engine/ecad/models3d.js";
import { exportFabrication } from "../lib/engine/ecad/fabrication.js";
import { FAB_RULE_FLOOR, countCopperLayers, ensureDesignRules, fabFloorForLayers } from "../lib/engine/ecad/pcb/rules.js";
import { analyzeStackup } from "../lib/engine/ecad/pcb/stackup.js";
import { analyzeEmc, defaultCurrentForNet, requiredWidthMm } from "../lib/engine/ecad/pcb/emc.js";
import { collectBriefFacts, writeBriefs } from "../lib/engine/ecad/brief.js";
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
    writeFileSync(join(dir, "demo.ioc"), "Mcu.CPN=STM32F103C8T6\nMcu.Name=STM32F103C8Tx\nMcu.Package=LQFP48\n", "utf8");
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
