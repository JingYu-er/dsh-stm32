/**
 * KiCad 10 原理图引擎的离线单测：夹具是真实工程 `D_NFC_V1.3_1.1.2` 的三份只读文件
 * （入口图纸、被引用的 col1 图纸、PCB），以及同目录的 `.kicad_pro` 用于推断入口。
 *
 * 断言的着力点：
 *   · 解析数量（符号/导线/标号）—— 结构变了先在这里失败
 *   · 一个已知器件的引脚网络 —— 变换与建网错了这里必然错
 *   · 与 PCB 的连通性对账 —— 唯一能证明"没有接错线"的外部真值
 *   · 框图连线文字 —— 面板上人先看到的那一行
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkSchematic, readIocPins } from "../lib/engine/schematic/checks.js";
import { findRootSchematic, readSchematic } from "../lib/engine/schematic/model.js";
import { draftIoc } from "../lib/engine/schematic/to-ioc.js";
import { crossCheckPcb, readPcb } from "../lib/engine/schematic/pcb.js";
import { parseSexpr } from "../lib/engine/schematic/sexpr.js";
import { agentOfSession, resetSessionAgents } from "../lib/engine/session-context.js";
import { registerSchematicTools } from "../lib/tools/schematic.js";
import { SKILL_CONTENT } from "../lib/skill/stm32-workflow.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "kicad-10-d-nfc");

function fixturePath(...parts) {
  return path.join(FIXTURE, ...parts);
}

function loadFixture() {
  const root = findRootSchematic(FIXTURE);
  assert.ok(root !== null && root !== "", "找不到入口图纸");
  return readSchematic(root);
}

function makeToolContext(workdir) {
  const tools = new Map();
  const ctx = {
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {}; } },
    get(name) {
      if (name === "workingDirectory") return { ensure: async () => workdir };
      return undefined;
    },
  };
  registerSchematicTools(ctx);
  return tools;
}

test("S-expression：字符串转义与嵌套列表", () => {
  // parseSexpr 返回最外层列表的子项（不是包一层的数组），调用方直接在其上取子列表。
  const doc = parseSexpr('(root (a "x\\"y") (b 1 (c 2)))');
  assert.equal(doc[0], "root");
  const a = doc[1];
  assert.equal(a[1], 'x"y');
  const b = doc[2];
  assert.equal(b[1], "1");
  assert.equal(b[2][0], "c");
});

test("S-expression：括号未闭合时报错，不返回半截结果", () => {
  assert.throws(() => parseSexpr("(root (a 1)"), /括号未闭合/u);
});

test("入口图纸：按 .kicad_pro 同名文件推断，跟随 sheet 引用", () => {
  const root = findRootSchematic(FIXTURE);
  assert.ok(root.endsWith("D_NFC.kicad_sch"), `入口应为根图纸，实际 ${root}`);
  const { report } = loadFixture();
  assert.equal(report.version, 20260306);
  assert.equal(report.generator, "eeschema");
  assert.deepEqual(report.sheets.map((sheet) => sheet.file).sort(), ["D_NFC.kicad_sch", "col1.kicad_sch"]);
});

test("解析数量：col1 为 65 个符号、163 段导线、54 个标号、38 个结点", () => {
  const { report } = loadFixture();
  const col1 = report.sheets.find((sheet) => sheet.file === "col1.kicad_sch");
  assert.ok(col1 !== undefined);
  assert.equal(col1.symbols, 65);
  assert.equal(col1.nets, 35);
  // 元件只统计非电源符号：本板 43 个。
  assert.equal(report.components.length, 43);
});

test("主控识别：U18 = STM32L021F4Ux，20 个引脚", () => {
  const { report } = loadFixture();
  assert.ok(report.mcu !== null);
  assert.equal(report.mcu.ref, "U18");
  assert.equal(report.mcu.value, "STM32L021F4Ux");
  assert.equal(report.mcu.pins.length, 20);
});

test("引脚网络：I2C 落在 PA4/PA5，调试口与电源正确", () => {
  const { report } = loadFixture();
  const pins = new Map(report.mcu.pins.map((pin) => [pin.name, pin.net]));
  assert.match(pins.get("PA4"), /SCL/u);
  assert.match(pins.get("PA5"), /SDA/u);
  assert.match(pins.get("PA13"), /SWDIO/u);
  assert.match(pins.get("PA14"), /SWCLK/u);
  assert.equal(pins.get("VSS"), "GND");
  assert.equal(pins.get("VDD"), "VCC");
});

test("PCB 对账：25 个网络比对，24 个连通一致，0 个名字不一致", () => {
  const { report } = loadFixture();
  const pcb = readPcb(fixturePath("D_NFC.kicad_pcb"));
  assert.equal(pcb.footprints, 43);
  const check = crossCheckPcb(report, pcb);
  assert.equal(check.compared, 25);
  assert.equal(check.matched, 24);
  assert.equal(check.nameMismatches.length, 0);
  // GND 被拆成两段是已知的电源符号压在引脚上的形态：允许存在，但不能有别的网络被拆。
  assert.deepEqual(check.split.map((item) => item.net), ["GND"]);
});

test("框图：按功能模块聚合，主控与 NFC 之间是一条 I2C 连线", () => {
  const { report } = loadFixture();
  const kinds = report.diagram.blocks.map((block) => block.kind);
  for (const kind of ["mcu", "nfc", "optical", "interface", "keys"]) {
    assert.ok(kinds.includes(kind), "缺少功能模块：" + kind);
  }
  const link = report.diagram.links.find(
    (item) => (item.from === "mcu" && item.to === "nfc") || (item.from === "nfc" && item.to === "mcu"),
  );
  assert.ok(link !== undefined, "缺少主控与 NFC 的连线");
  assert.equal(link.label, "I2C");
  assert.ok(link.nets.some((net) => /SCL/u.test(net)));
  // 元件不单独成框：43 个器件聚成 5 个模块，且模块内器件数加起来不超过器件总数。
  const refs = report.diagram.blocks.reduce((sum, block) => sum + block.refs.length, 0);
  assert.ok(report.diagram.blocks.length <= 6, "模块数过多：" + String(report.diagram.blocks.length));
  assert.ok(refs <= 43, "模块内器件数超出器件总数");
});

test("检查：调试口/BOOT0/电源齐备，无错误；PCB 拆分只算告警", () => {
  const { report } = loadFixture();
  const check = checkSchematic(report, { pcbFile: fixturePath("D_NFC.kicad_pcb") });
  assert.equal(check.summary.errors, 0, check.findings.map((finding) => finding.message).join("; "));
  assert.equal(check.findings.some((finding) => finding.rule === "mcu.swd-missing"), false);
  assert.equal(check.findings.some((finding) => finding.rule === "mcu.boot0-missing"), false);
  const split = check.findings.find((finding) => finding.rule === "pcb.net-split");
  assert.ok(split !== undefined);
  assert.equal(split.severity, "warning");
});

test(".ioc 引脚表：只认引脚键，跳过 GPIO_Label / Locked", () => {
  const pins = readIocPins([
    "PA9.S_USART1_TX=PA9",
    "PA9.GPIO_Label=UART_TX",
    "PA10.S_USART1_RX=PA10",
    "PA10.Locked=true",
    "Mcu.CPN=STM32F103C8T6",
  ].join("\n"));
  assert.deepEqual([...pins.keys()].sort(), ["PA10", "PA9"]);
  assert.deepEqual(pins.get("PA9"), ["S_USART1_TX"]);
});

test("工具 stm32_sch_read：只读工具能读夹具并给出主控", async () => {
  const tools = makeToolContext(FIXTURE);
  const tool = tools.get("stm32_sch_read");
  assert.ok(tool !== undefined);
  const value = await tool.execute({ projectDir: FIXTURE }, { signal: new AbortController().signal });
  assert.equal(value.ok, true);
  assert.equal(value.components, 43);
  assert.match(value.mcu, /U18 STM32L021F4Ux/u);
  assert.ok(value.diagram.links.length > 0);
});

test("工具 stm32_sch_check：夹具上 0 错误，并对上 PCB", async () => {
  const tools = makeToolContext(FIXTURE);
  const tool = tools.get("stm32_sch_check");
  assert.ok(tool !== undefined);
  const value = await tool.execute({ projectDir: FIXTURE, pcbFile: fixturePath("D_NFC.kicad_pcb") }, { signal: new AbortController().signal });
  assert.equal(value.ok, true);
  assert.equal(value.errors, 0);
  assert.equal(value.pcbCompared, 25);
  assert.equal(value.pcbMatched, 24);
});

test("工具参数错误：目录里没有原理图时给人话，不抛栈", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-sch-empty-"));
  const tools = makeToolContext(empty);
  const value = await tools.get("stm32_sch_read").execute({ projectDir: empty }, { signal: new AbortController().signal });
  assert.equal(value.ok, false);
  assert.match(value.message, /没有 KiCad 原理图|没有 \.kicad_sch/u);
});

test("工具 stm32_sch_read：没传 projectDir 时按 exec.agent 解析会话工作目录（S93）", async () => {
  // 工具必须把宿主传进来的 exec 一路带到 resolveProjectDir：少了它，会话工作目录换不到，
  // 调试台拿不到默认工程，工具会退到插件进程的 cwd（不是用户的工作区）。
  resetSessionAgents();
  const tools = makeToolContext(FIXTURE);
  const agent = { id: "session-abc-123" };
  const value = await tools.get("stm32_sch_read").execute({}, { signal: new AbortController().signal, agent });
  assert.equal(value.ok, true);
  assert.equal(value.components, 43);
  assert.ok(agentOfSession("session-abc-123") !== undefined, "exec.agent 应登记到会话对照表");
});

test("流程图规则同时出现在工具说明与技能文本里", () => {
  const tools = makeToolContext(FIXTURE);
  const read = tools.get("stm32_sch_read");
  assert.ok(read !== undefined, "缺少 stm32_sch_read");
  assert.match(read.description, /功能模块/u);
  assert.match(SKILL_CONTENT, /流程图怎么看/u);
  assert.match(SKILL_CONTENT, /按功能聚合/u);
  assert.match(SKILL_CONTENT, /电源不上线/u);
});

test("配置草案：把网络名对到器件库信号，对不上的进待确认（S113）", () => {
  const root = findRootSchematic(FIXTURE);
  const { report } = readSchematic(root);
  const pinFact = (...signals) => ({ name: "", position: 0, signals: new Map(signals.map((signal) => [signal, []])) });
  const facts = {
    name: "STM32L021F4Ux",
    packageName: "ST_UFQFPN-20",
    frequencyMhz: 32,
    family: "STM32L0",
    line: "STM32L021",
    core: "ARM Cortex-M0+",
    ramKb: 6,
    flashKb: [16],
    ioNb: 20,
    clockTree: "",
    pins: new Map([
      ["PA4", pinFact("I2C1_SCL", "GPIO")],
      ["PA5", pinFact("SPI1_SCK", "GPIO")],
      ["PA13", pinFact("SYS_SWDIO", "GPIO")],
      ["PA14", pinFact("SYS_SWCLK", "GPIO")],
      ["PA9", pinFact("GPIO")],
      ["PB9-BOOT0", pinFact("BOOT0")],
    ]),
    ips: new Map(),
  };
  const draft = draftIoc(report, facts);
  assert.equal(draft.ok, true);
  const byName = new Map(draft.pins.map((pin) => [pin.name, pin]));
  assert.equal(byName.get("PA13")?.signal, "SYS_SWDIO");
  assert.equal(byName.get("PA13")?.confidence, "high");
  assert.equal(byName.get("PA4")?.signal, "I2C1_SCL");
  const pa5 = byName.get("PA5");
  assert.equal(pa5?.signal, "");
  assert.ok(draft.unresolved.some((pin) => pin.name === "PA5"), "PA5 只能做 SPI，网络名 SDA 对不上");
  assert.ok(draft.gpioPins.some((pin) => pin.pin === "PA9" && pin.signal === "output"), "LED 网络按 GPIO 输出");
  assert.ok(draft.peripherals.some((pin) => pin.name === "I2C1" && pin.pins.includes("PA4")), "外设按信号前缀归纳");
  assert.ok(draft.notes.some((note) => note.includes("待确认") || note.includes("对不上")), "要在说明里提示待确认");
});

test("配置草案：没有器件库时给出下一步而不是空结果（S113）", () => {
  const root = findRootSchematic(FIXTURE);
  const { report } = readSchematic(root);
  const draft = draftIoc(report, null);
  assert.equal(draft.ok, false);
  assert.match(draft.error, /CubeMX 器件库/u);
  assert.equal(draft.pins.length, 0);
});
