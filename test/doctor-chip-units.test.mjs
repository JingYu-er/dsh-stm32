// 单元测试：doctor 的芯片一致性（型号 ↔ 启动文件 ↔ 设备宏 ↔ .ld MEMORY ↔ .elf）
// 与引脚表派生（有本机 CubeMX db/mcu 就用它；没有就 kind=unknown，插件不内置引脚表）。
//
// 这里守的是“换芯片只换了 .ioc”这一类最麻烦的错：编译器全绿、烧进去跑飞。
// 跑法：node --test test/doctor-chip-units.test.mjs（需先 npm run build）
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { deriveChipPinTable, findMcuDbDir, isKnownPin, parseMcuDbXmlPins } from "../lib/data/chips.js";
import {
  checkChipConsistency,
  collectChipConsistency,
  deviceDefinesIn,
  elfFlashBytes,
  parseLinkerMemory,
  runDoctor,
} from "../lib/engine/doctor.js";

import { FIXTURE_ASSETS } from "./fixtures.mjs";

// 设备事实只从资源包缓存读（内置引脚表已删）：单测统一指到夹具，绝不读真实 home 缓存。
process.env.DSH_STM32_ASSETS = FIXTURE_ASSETS;

const TEMPLATES = fileURLToPath(new URL("../templates/scaffold/", import.meta.url));

const C8T6_CMake = fs.readFileSync(path.join(TEMPLATES, "cmake/stm32cubemx/CMakeLists.txt"), "utf8");
const C8T6_LD = fs.readFileSync(path.join(TEMPLATES, "STM32F103XX_FLASH.ld"), "utf8");
const C8T6_IOC = fs.readFileSync(path.join(TEMPLATES, "demo.ioc"), "utf8");

/** 一份“RCT6 的 LQFP64”迷你 db XML：带功能后缀、虚拟引脚（Position=0）、电源脚。 */
const DB_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Mcu Name="STM32F103R(8-B)Tx" Package="LQFP64">',
  '  <Pin Name="VBAT" Type="Power" Position="1"/>',
  '  <Pin Name="PC13-TAMPER-RTC" Type="I/O" Position="2"',
  '       Signal="RTC_TAMP"/>',
  '  <Pin Name="PC14-OSC32_IN" Type="I/O" Position="3"/>',
  '  <Pin Name="PC15-OSC32_OUT" Type="I/O" Position="4"/>',
  '  <Pin Name="PD0-OSC_IN" Type="I/O" Position="5"/>',
  '  <Pin Name="PD1-OSC_OUT" Type="I/O" Position="6"/>',
  '  <Pin Name="PA0-WKUP" Type="I/O" Position="14"/>',
  '  <Pin Name="PA13" Type="I/O" Position="46"/>',
  '  <Pin Name="PA14" Type="I/O" Position="49"/>',
  '  <Pin Name="PA15" Type="I/O" Position="50"/>',
  '  <Pin Name="PB3" Type="I/O" Position="55"/>',
  '  <Pin Name="VP_SYS_VS_Systick" Type="Virtual" Position="0"/>',
  "</Mcu>",
  "",
].join("\n");

// 任何一次 spawn 都算测试写错：一致性检查是纯读文件的，不该起进程。
const noSpawn = {
  resolveExecutable: (command) => command,
  spawn: () => {
    throw new Error("doctor 芯片一致性检查不应启动任何进程");
  },
};

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-stm32-doctor-" + tag + "-"));
}

function dbDirWith(xml, name = "STM32F103R(8-B)Tx.xml") {
  const dir = tempDir("db");
  fs.writeFileSync(path.join(dir, name), xml);
  return dir;
}

/** 造一个工程目录（tmp 里），只放 doctor 要读的那几样东西。 */
function makeProject(tag, options = {}) {
  const dir = tempDir(tag);
  for (const name of options.startupFiles ?? ["startup_stm32f103xb.s"]) {
    fs.writeFileSync(path.join(dir, name), "; 空启动文件：doctor 只看文件名\n");
  }
  fs.mkdirSync(path.join(dir, "cmake", "stm32cubemx"), { recursive: true });
  fs.writeFileSync(path.join(dir, "cmake", "stm32cubemx", "CMakeLists.txt"), options.cmakeText ?? C8T6_CMake);
  if (options.linkerName !== undefined) {
    fs.writeFileSync(path.join(dir, options.linkerName), options.linkerText ?? C8T6_LD);
  }
  fs.writeFileSync(path.join(dir, "demo.ioc"), options.iocText ?? C8T6_IOC);
  if (options.elf !== undefined) {
    const buildDir = path.join(dir, "build", "Debug");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "CMakeCache.txt"), "CMAKE_PROJECT_NAME:STATIC=demo\n");
    fs.writeFileSync(path.join(buildDir, "demo.elf"), options.elf);
  }
  return dir;
}

function iocFor(cpn, mcuName) {
  return C8T6_IOC.replace("Mcu.CPN=STM32F103C8T6", "Mcu.CPN=" + cpn).replace(
    "Mcu.Name=STM32F103C(8-B)Tx",
    "Mcu.Name=" + mcuName,
  );
}

/** 造一个真 ELF32：一个落在 Flash 的 PT_LOAD（flashBytes 字节），可选补一段垃圾把文件撑大。 */
function elfWith(flashBytes, padBytes = 0) {
  const contentAt = 52 + 32;
  const buf = Buffer.alloc(contentAt + flashBytes + padBytes);
  buf[0] = 0x7f;
  buf[1] = 0x45;
  buf[2] = 0x4c;
  buf[3] = 0x46;
  buf[4] = 1; // ELFCLASS32
  buf[5] = 1; // little endian
  buf[6] = 1;
  buf.writeUInt16LE(2, 16); // e_type = ET_EXEC
  buf.writeUInt16LE(40, 18); // e_machine = EM_ARM
  buf.writeUInt32LE(1, 20);
  buf.writeUInt32LE(0x08000000, 24);
  buf.writeUInt32LE(52, 28); // e_phoff
  buf.writeUInt16LE(52, 40);
  buf.writeUInt16LE(32, 42); // e_phentsize
  buf.writeUInt16LE(1, 44); // e_phnum
  buf.writeUInt32LE(1, 52); // PT_LOAD
  buf.writeUInt32LE(contentAt, 56);
  buf.writeUInt32LE(0x08000000, 60);
  buf.writeUInt32LE(0x08000000, 64);
  buf.writeUInt32LE(flashBytes, 68); // p_filesz
  buf.writeUInt32LE(flashBytes, 72); // p_memsz
  buf.writeUInt32LE(5, 76);
  buf.writeUInt32LE(4, 80);
  return buf;
}

test("没有本机 db 时 kind=unknown + 空引脚 + 明说没校验（内置引脚表已删，不再有 builtin 兜底）", () => {
  const table = deriveChipPinTable({ cpn: "STM32F103C8T6", mcuName: "STM32F103C(8-B)Tx", dbMcuDir: null });
  assert.equal(table.kind, "unknown");
  assert.deepEqual(table.pins, []);
  assert.equal(table.notes.some((line) => line.includes("引脚存在性不校验")), true, table.notes.join(" / "));
  assert.equal(table.notes.some((line) => line.includes("不内置引脚表")), true, table.notes.join(" / "));
  // isKnownPin 只查引脚名合法性：PZ9 / PA99 这类写错的一定拦；PC12 名字合法
  //（这个封装到底有没有它，只有本机 CubeMX db 说了算）。
  assert.equal(isKnownPin("PA0"), true);
  assert.equal(isKnownPin("PA0-WKUP"), true);
  assert.equal(isKnownPin("PC12"), true);
  assert.equal(isKnownPin("PZ9"), false);
  assert.equal(isKnownPin("PA99"), false);
  assert.equal(isKnownPin("PA-1"), false);
  assert.equal(isKnownPin("VP_SYS_VS_Systick"), true);
});

test("db XML 解析：只收 Position>0 的封装引脚，功能后缀归一化（VP 引脚位置 0 不算）", () => {
  const pins = parseMcuDbXmlPins(DB_XML);
  assert.deepEqual(pins, ["PA0", "PA13", "PA14", "PA15", "PB3", "PC13", "PC14", "PC15", "PD0", "PD1"]);
  assert.equal(pins.includes("VP_SYS_VS_Systick"), false, "Position=0 是虚拟引脚，不能当封装引脚");
  assert.equal(pins.includes("VBAT"), false, "电源脚不是 GPIO");
});

test("有本机 db 时引脚表来自 db（Mcu.Name 优先，其次按完整型号找 XML）", () => {
  const dbMcuDir = dbDirWith(DB_XML);
  const byName = deriveChipPinTable({ cpn: "STM32F103RCT6", mcuName: "STM32F103R(8-B)Tx", dbMcuDir });
  assert.equal(byName.kind, "db");
  assert.ok(byName.pins.includes("PB3"));
  assert.equal(byName.notes.some((line) => line.includes("CubeMX db")), true, byName.notes.join("\n"));
  // 只给完整型号（没有 Mcu.Name）也能命中
  const full = dbDirWith(DB_XML, "STM32F103RCT6.xml");
  assert.equal(deriveChipPinTable({ cpn: "STM32F103RCT6", dbMcuDir: full }).kind, "db");
  // db 里没有这个型号 → kind=unknown（没有内置表可退），仍然说明没校验
  const other = deriveChipPinTable({ cpn: "STM32F103C8T6", dbMcuDir: full });
  assert.equal(other.kind, "unknown");
  assert.deepEqual(other.pins, []);
  assert.equal(other.notes.some((line) => line.includes("引脚存在性不校验")), true);
});

test("findMcuDbDir：只认 <CubeMX 根>/db/mcu，找不到返回 null", () => {
  const fakeRoot = tempDir("cube");
  fs.mkdirSync(path.join(fakeRoot, "db", "mcu"), { recursive: true });
  assert.equal(findMcuDbDir([fakeRoot]), path.join(fakeRoot, "db", "mcu"));
  assert.equal(findMcuDbDir(["D:/__dsh_stm32_no_such_cube__", ""]), null);
  assert.equal(findMcuDbDir(undefined), null);
});

test("启动文件与 cmake 设备宏不匹配 → blocker（换芯片后漏跑 generate 的典型症状）", () => {
  const result = checkChipConsistency({
    cpn: "STM32F103C8T6",
    mcuName: "STM32F103C(8-B)Tx",
    startupFiles: ["startup_stm32f103xb.s"],
    cmakeText: "cmake_minimum_required(VERSION 3.22)\nset(MX_Defines_Syms\n\tUSE_HAL_DRIVER\n\tSTM32F103xE\n)\n",
    linkerText: C8T6_LD,
    linkerName: "STM32F103XX_FLASH.ld",
  });
  assert.equal(
    result.blockers.some((line) => line.includes("startup_stm32f103xb.s") && line.includes("STM32F103xE")),
    true,
    result.blockers.join("\n"),
  );
});

test("cmake 里只认 STM32 设备宏，不把链接脚本名/注释当宏", () => {
  assert.deepEqual(deviceDefinesIn(C8T6_CMake), ["STM32F103xB"]);
  assert.deepEqual(deviceDefinesIn("set(FLAGS -DSTM32F107xC /proj/STM32F107VCTx_FLASH.ld)"), ["STM32F107xC"]);
  assert.deepEqual(deviceDefinesIn("# STM32F103xE 是旧芯片\nset(MX_Defines_Syms STM32F103xB)"), ["STM32F103xB"]);
});

test("芯片型号与工程根启动文件不一致 → blocker（型号说 xe，盘上是 xb）", () => {
  const result = checkChipConsistency({
    cpn: "STM32F103RCT6",
    mcuName: "STM32F103R(8-B)Tx",
    startupFiles: ["startup_stm32f103xb.s"],
    cmakeText: C8T6_CMake,
    linkerText: C8T6_LD,
  });
  assert.equal(result.chip === null, false, "RCT6 应当能被 F1 表反推出来");
  assert.equal(
    result.blockers.some((line) => line.includes("startup_stm32f103xe.s")),
    true,
    result.blockers.join("\n"),
  );
});

test("链接脚本 MEMORY 容量写法：20K / 0x5000 / 64K；算式不猜", () => {
  const text =
    "MEMORY\n{\nRAM (xrw)      : ORIGIN = 0x20000000, LENGTH = 0x5000\n" +
    "FLASH (rx)      : ORIGIN = 0x8000000, LENGTH = 64K\n}\n" +
    "_estack = ORIGIN(RAM) + LENGTH(RAM);\n";
  assert.deepEqual(parseLinkerMemory(text), { ramBytes: 20 * 1024, flashBytes: 64 * 1024 });
  assert.deepEqual(parseLinkerMemory(C8T6_LD), { ramBytes: 20 * 1024, flashBytes: 64 * 1024 });
  const formula = parseLinkerMemory(
    "MEMORY\n{\nRAM (xrw) : ORIGIN = 0x20000000, LENGTH = 20K - 4K\nFLASH (rx) : ORIGIN = 0x8000000, LENGTH = 64K\n}\n",
  );
  assert.equal(formula.ramBytes, null, "LENGTH = 20K - 4K 这种算式不猜");
  assert.equal(formula.flashBytes, 64 * 1024);
});

test("链接脚本 MEMORY 比芯片小 → note（浪费但不致命）；RAM 比芯片大 → blocker", () => {
  const small = checkChipConsistency({
    cpn: "STM32F103RCT6",
    mcuName: "STM32F103R(8-B)Tx",
    startupFiles: ["startup_stm32f103xe.s"],
    cmakeText: "set(MX_Defines_Syms\n\tUSE_HAL_DRIVER\n\tSTM32F103xE\n)\n",
    linkerText: C8T6_LD,
    linkerName: "STM32F103XX_FLASH.ld",
  });
  assert.deepEqual(small.blockers, [], small.blockers.join("\n"));
  assert.equal(
    small.notes.some((line) => line.includes("只给了 64 KiB Flash") && line.includes("256 KiB")),
    true,
    small.notes.join("\n"),
  );

  const fatRam = checkChipConsistency({
    cpn: "STM32F103C8T6",
    startupFiles: ["startup_stm32f103xb.s"],
    cmakeText: C8T6_CMake,
    linkerText: C8T6_LD.replace("LENGTH = 20K", "LENGTH = 64K"),
    linkerName: "STM32F103C8Tx_FLASH.ld",
  });
  assert.equal(
    fatRam.blockers.some((line) => line.includes("RAM") && line.includes("超过芯片")),
    true,
    fatRam.blockers.join("\n"),
  );
});

test(".elf 超出 Flash → blocker；接近满 → note", () => {
  const over = checkChipConsistency({
    cpn: "STM32F103C8T6",
    startupFiles: ["startup_stm32f103xb.s"],
    cmakeText: C8T6_CMake,
    linkerText: C8T6_LD,
    linkerName: "STM32F103C8Tx_FLASH.ld",
    elfSize: 300 * 1024,
  });
  assert.equal(
    over.blockers.some((line) => line.includes(".elf") && line.includes("超过 Flash")),
    true,
    over.blockers.join("\n"),
  );

  const tight = checkChipConsistency({
    cpn: "STM32F103C8T6",
    startupFiles: ["startup_stm32f103xb.s"],
    cmakeText: C8T6_CMake,
    linkerText: C8T6_LD,
    linkerName: "STM32F103C8Tx_FLASH.ld",
    elfSize: 62 * 1024,
  });
  assert.deepEqual(tight.blockers, []);
  assert.equal(tight.notes.some((line) => line.includes("已用") && line.includes("% Flash")), true, tight.notes.join("\n"));
});

test("elfFlashBytes：只数落在 Flash 的 PT_LOAD；不是 ELF / 只有 RAM 段就返回 null", () => {
  const dir = tempDir("elfbytes");
  const good = path.join(dir, "good.elf");
  fs.writeFileSync(good, elfWith(3 * 1024, 512));
  assert.equal(elfFlashBytes(good), 3 * 1024);

  const garbage = path.join(dir, "garbage.elf");
  fs.writeFileSync(garbage, Buffer.alloc(4096, 0));
  assert.equal(elfFlashBytes(garbage), null, "随便一段字节不是 ELF");

  const ramOnly = elfWith(1024);
  ramOnly.writeUInt32LE(0x20000000, 60);
  ramOnly.writeUInt32LE(0x20000000, 64);
  const ramPath = path.join(dir, "ram.elf");
  fs.writeFileSync(ramPath, ramOnly);
  assert.equal(elfFlashBytes(ramPath), null, "只有 RAM 段时 Flash 占用为 0");

  assert.equal(elfFlashBytes(path.join(dir, "nope.elf")), null);
});

test("调试信息撑大的 .elf 不误报超 Flash（按 program header 算，不看文件大小）", () => {
  const dir = tempDir("elf-debug");
  const elfPath = path.join(dir, "demo.elf");
  fs.writeFileSync(elfPath, elfWith(2 * 1024, 600 * 1024));
  const result = checkChipConsistency({
    cpn: "STM32F103C8T6",
    startupFiles: ["startup_stm32f103xb.s"],
    cmakeText: C8T6_CMake,
    linkerText: C8T6_LD,
    linkerName: "STM32F103C8Tx_FLASH.ld",
    elfPath,
    elfSize: fs.statSync(elfPath).size,
  });
  assert.deepEqual(result.blockers, [], result.blockers.join("\n"));
  assert.equal(
    result.notes.some((line) => line.includes("超过 Flash")),
    false,
    "文件 600 KiB 但 Flash 只占 2 KiB，不能报",
  );

  // 同一颗芯片，真的塞了 300 KiB 进 Flash → 必须报
  const fat = path.join(dir, "fat.elf");
  fs.writeFileSync(fat, elfWith(300 * 1024));
  const fatResult = checkChipConsistency({
    cpn: "STM32F103C8T6",
    startupFiles: ["startup_stm32f103xb.s"],
    cmakeText: C8T6_CMake,
    linkerText: C8T6_LD,
    linkerName: "STM32F103C8Tx_FLASH.ld",
    elfPath: fat,
    elfSize: fs.statSync(fat).size,
  });
  assert.equal(
    fatResult.blockers.some((line) => line.includes("要占 300 KiB Flash") && line.includes("超过 Flash 容量")),
    true,
    fatResult.blockers.join("\n"),
  );
});

test("本机 db 的封装里没有 .ioc 用到的引脚 → note（非致命，只在本机 db 上判）", () => {
  const dbMcuDir = dbDirWith(DB_XML);
  const result = checkChipConsistency({
    cpn: "STM32F103RCT6",
    mcuName: "STM32F103R(8-B)Tx",
    dbMcuDir,
    startupFiles: ["startup_stm32f103xe.s"],
    cmakeText: "set(MX_Defines_Syms\n\tUSE_HAL_DRIVER\n\tSTM32F103xE\n)\n",
    linkerText: C8T6_LD,
    linkerName: "STM32F103XX_FLASH.ld",
    iocPins: ["PC13-TAMPER-RTC", "PA0", "PB7", "VP_SYS_VS_Systick"],
  });
  assert.equal(
    result.notes.some((line) => line.includes("PB7") && line.includes("封装")),
    true,
    result.notes.join("\n"),
  );
});

test("collectChipConsistency：从工程里读全（.ioc 之外的四处事实）", () => {
  const clean = makeProject("collect-clean", { linkerName: "STM32F103C8Tx_FLASH.ld" });
  const cleanResult = collectChipConsistency(clean, { cpn: "STM32F103C8T6", mcuName: "STM32F103C(8-B)Tx" });
  assert.deepEqual(cleanResult.blockers, [], cleanResult.blockers.join("\n"));
  assert.deepEqual(cleanResult.memory, { ramBytes: 20 * 1024, flashBytes: 64 * 1024 });

  const mismatch = makeProject("collect-mismatch", {
    startupFiles: ["startup_stm32f103xb.s"],
    cmakeText: "set(MX_Defines_Syms\n\tUSE_HAL_DRIVER\n\tSTM32F103xE\n)\n",
    linkerName: "STM32F103C8Tx_FLASH.ld",
  });
  const mismatchResult = collectChipConsistency(mismatch, { cpn: "STM32F103C8T6" });
  assert.equal(mismatchResult.blockers.length >= 1, true, "startup xb vs 设备宏 xE 必须报");
});

test("错配工程：runDoctor 实测把芯片类问题报成 blockers，干净的 C8T6 工程不误报", async () => {
  const dir = makeProject("doctor-mismatch", {
    startupFiles: ["startup_stm32f103xb.s"],
    cmakeText: "cmake_minimum_required(VERSION 3.22)\nset(MX_Defines_Syms\n\tUSE_HAL_DRIVER\n\tSTM32F103xE\n)\n",
    linkerName: "STM32F103C8Tx_FLASH.ld",
    iocText: iocFor("STM32F103RCT6", "STM32F103R(8-B)Tx"),
    elf: elfWith(300 * 1024),
  });
  const report = await runDoctor(noSpawn, { projectDir: dir, port: 3999, timeoutMs: 1000 });
  const chipBlockers = report.blockers.filter((line) => !line.startsWith("缺少必需组件"));
  const text = chipBlockers.join("\n");
  assert.equal(report.ok, false);
  assert.equal(text.includes("startup_stm32f103xe.s"), true, text);
  assert.equal(text.includes("设备宏"), true, text);
  assert.equal(text.includes(".elf") && text.includes("超过 Flash"), true, text);
  assert.equal(report.notes.some((line) => line.includes("只给了 64 KiB Flash")), true, report.notes.join("\n"));

  const clean = makeProject("doctor-clean", { linkerName: "STM32F103C8Tx_FLASH.ld" });
  const cleanReport = await runDoctor(noSpawn, { projectDir: clean, port: 3999, timeoutMs: 1000 });
  const cleanChipBlockers = cleanReport.blockers.filter((line) => !line.startsWith("缺少必需组件"));
  assert.deepEqual(cleanChipBlockers, [], cleanChipBlockers.join("\n"));
  assert.equal(cleanReport.notes.some((line) => line.includes("引脚表")), true, cleanReport.notes.join("\n"));
});
