/**
 * ECAD 引擎单测（S97）：工具链定位、工作区初始化、构建参数拼装、ERC/DRC 解析、STEP 缺失模型。
 *
 * 全部离线：假 subprocess 只记录 argv、按 `-o <报告>` 写一份固定的 JSON，不真跑 KiCad。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { exportStep, findUnnamedNets, runDrc, runErc } from "../lib/engine/ecad/checks.js";
import { exportEmbeddedLibraries, scanPcbFootprints, scanSchSymbols } from "../lib/engine/ecad/libs.js";
import { exportFabrication } from "../lib/engine/ecad/fabrication.js";
import { registerEcadTools } from "../lib/tools/ecad.js";
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
