// 单元测试：scaffold（空目录建骨架）、code-patch（只写 USER CODE 块）、flash 的 A5 守卫。
// 跑法：node test\scaffold-patch-units.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createProjectScaffold, resolveFirmwareRoot, DEFAULT_FIRMWARE_PACKAGE } from "../lib/engine/scaffold.js";
import { listUserCodeLabels, patchUserCode } from "../lib/engine/code-patch.js";
import { checkNoDebugGuard } from "../lib/engine/flash.js";

const CUBE_ROOT = "D:/app/STM32CubeMX";

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-stm32-" + tag + "-"));
}

function writeProject(files) {
  const dir = tempDir("proj");
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return dir;
}

const MAIN_C = [
  "/* generated header: do not touch */",
  "int main(void)",
  "{",
  "  /* USER CODE BEGIN 1 */",
  "  /* USER CODE END 1 */",
  "",
  "  /* USER CODE BEGIN WHILE */",
  "  while (1)",
  "  {",
  "    /* USER CODE END WHILE */",
  "  }",
  "  /* USER CODE BEGIN 3 */",
  "  /* USER CODE END 3 */",
  "}",
].join("\r\n");

test("code-patch：replace 只改块内，块外字节原样保留", () => {
  const dir = writeProject({ "Core/Src/main.c": MAIN_C });
  const code = ["  HAL_GPIO_TogglePin(GPIOC, GPIO_PIN_13);", "  HAL_Delay(200);"].join("\r\n");
  const report = patchUserCode({ projectDir: dir, file: "Core/Src/main.c", block: "3", code });
  assert.equal(report.ok, true);
  assert.equal(report.linesBefore, 0);
  assert.equal(report.linesAfter, 2);
  assert.ok(typeof report.backupPath === "string" && fs.existsSync(report.backupPath));
  const after = fs.readFileSync(path.join(dir, "Core/Src/main.c"), "utf8");
  assert.ok(after.includes("HAL_Delay(200)"));
  assert.ok(after.startsWith("/* generated header: do not touch */\r\n"));
  assert.ok(after.includes("/* USER CODE BEGIN WHILE */\r\n  while (1)"));
  assert.equal(after.split("\r\n").length, MAIN_C.split("\r\n").length + 2);
  // 备份就是原文件
  assert.equal(fs.readFileSync(report.backupPath, "utf8"), MAIN_C);
});

test("code-patch：append 追加到块尾，不动前面的内容", () => {
  const dir = writeProject({ "Core/Src/main.c": MAIN_C });
  const first = patchUserCode({ projectDir: dir, file: "Core/Src/main.c", block: "3", code: "  a();" });
  assert.equal(first.ok, true);
  const second = patchUserCode({ projectDir: dir, file: "Core/Src/main.c", block: "3", code: "  b();", mode: "append" });
  assert.equal(second.ok, true);
  assert.equal(second.linesBefore, 1);
  assert.equal(second.linesAfter, 2);
  const text = fs.readFileSync(path.join(dir, "Core/Src/main.c"), "utf8");
  assert.match(text, /\/\* USER CODE BEGIN 3 \*\/\r?\n {2}a\(\);\r?\n {2}b\(\);\r?\n {2}\/\* USER CODE END 3 \*\//u);
});

test("code-patch：replace 遇到块内结构行（{ 或 }）时拒绝，append 可以", () => {
  // 真实 CubeMX 布局：USER CODE 3 之间夹着 while(1) 的收尾 }（replace 会把它删掉，main() 随之不闭合）
  const cubemx = [
    "int main(void)",
    "{",
    "  while (1)",
    "  {",
    "    /* USER CODE END WHILE */",
    "    /* USER CODE BEGIN 3 */",
    "  }",
    "  /* USER CODE END 3 */",
    "}",
  ].join("\r\n");
  const dir = writeProject({ "Core/Src/main.c": cubemx });
  const rejected = patchUserCode({ projectDir: dir, file: "Core/Src/main.c", block: "3", code: "  g_x++;\r\n" });
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /结构代码/u);
  assert.match(rejected.message, /append/u);
  assert.equal(rejected.linesAfter, 0);
  assert.equal(fs.readFileSync(path.join(dir, "Core/Src/main.c"), "utf8"), cubemx, "被拒绝时文件不能变");
  const appended = patchUserCode({
    projectDir: dir, file: "Core/Src/main.c", block: "3", mode: "append", code: "    g_x++;",
  });
  assert.equal(appended.ok, true);
  const text = fs.readFileSync(path.join(dir, "Core/Src/main.c"), "utf8");
  // append 插在收尾括号之前（否则代码落在 while 之后 → 不可达 → 链接时被 gc-sections 丢掉）
  assert.match(text, /BEGIN 3 \*\/\r\n    g_x\+\+;\r\n  \}\r\n  \/\* USER CODE END 3/u);
  // 块里原本的 } 仍在（append 不动原有行）
  assert.equal(text.split("\r\n").length, cubemx.split("\r\n").length + 1);
});

test("code-patch：块不存在时失败并列出可用标签", () => {
  const dir = writeProject({ "Core/Src/main.c": MAIN_C });
  const report = patchUserCode({ projectDir: dir, file: "Core/Src/main.c", block: "NOPE", code: "x();" });
  assert.equal(report.ok, false);
  assert.deepEqual(report.labels, ["1", "WHILE", "3"]);
  assert.match(report.message, /NOPE/u);
  assert.match(report.message, /1、WHILE、3/u);
  assert.equal(fs.readFileSync(path.join(dir, "Core/Src/main.c"), "utf8"), MAIN_C);
});

test("code-patch：代码里带 USER CODE 标记时拒绝（会破坏配对）", () => {
  const dir = writeProject({ "Core/Src/main.c": MAIN_C });
  const report = patchUserCode({ projectDir: dir, file: "Core/Src/main.c", block: "3", code: "/* USER CODE END 3 */" });
  assert.equal(report.ok, false);
  assert.match(report.message, /标记/u);
});

test("code-patch：listUserCodeLabels 按出现顺序收集", () => {
  assert.deepEqual(listUserCodeLabels(MAIN_C), ["1", "WHILE", "3"]);
});

const IOC_NO_DEBUG = [
  "Mcu.CPN=STM32F103C8T6",
  "Mcu.PinsNb=2",
  "Mcu.Pin0=PC13-TAMPER-RTC",
  "Mcu.Pin1=VP_SYS_VS_Systick",
  "ProjectManager.ProjectName=demo",
  "ProjectManager.TargetToolchain=CMake",
  "ProjectManager.MainLocation=Core/Src",
  "ProjectManager.KeepUserCode=true",
].join("\n");

const IOC_SERIAL_WIRE = [
  "Mcu.CPN=STM32F103C8T6",
  "Mcu.PinsNb=3",
  "Mcu.Pin0=PC13-TAMPER-RTC",
  "Mcu.Pin1=PA13",
  "Mcu.Pin2=PA14",
  "PA13.Mode=Serial_Wire",
  "PA13.Signal=SYS_JTMS-SWDIO",
  "PA14.Mode=Serial_Wire",
  "PA14.Signal=SYS_JTCK-SWCLK",
  "ProjectManager.ProjectName=demo",
  "ProjectManager.TargetToolchain=CMake",
  "ProjectManager.MainLocation=Core/Src",
  "ProjectManager.KeepUserCode=true",
].join("\n");

test("A5 守卫：.ioc 没有 Serial Wire 时拦住烧录", () => {
  const dir = writeProject({ "demo.ioc": IOC_NO_DEBUG });
  const guard = checkNoDebugGuard(dir);
  assert.equal(guard.blocked, true);
  assert.match(guard.errors[0] ?? "", /Serial Wire/u);
  assert.ok(guard.notes.some((note) => note.includes("allowNoDebug")));
});

test("A5 守卫：Serial Wire 在 / allowNoDebug / 没有 .ioc 时放行", () => {
  const ok = writeProject({ "demo.ioc": IOC_SERIAL_WIRE });
  assert.equal(checkNoDebugGuard(ok).blocked, false);

  const overridden = writeProject({ "demo.ioc": IOC_NO_DEBUG });
  assert.equal(checkNoDebugGuard(overridden, true).blocked, false);

  const noIoc = writeProject({ "Core/Src/main.c": MAIN_C });
  assert.equal(checkNoDebugGuard(noIoc).blocked, false);
});

test("scaffold：固件包在预期位置、能被解析到", { skip: !fs.existsSync(path.join(CUBE_ROOT, "Repository", DEFAULT_FIRMWARE_PACKAGE)) }, () => {
  const resolved = resolveFirmwareRoot([CUBE_ROOT]);
  assert.equal(resolved.root, path.join(CUBE_ROOT, "Repository", DEFAULT_FIRMWARE_PACKAGE));
  assert.equal(resolveFirmwareRoot(["D:/nope"]).root, undefined);
});

test("scaffold：空目录 → 骨架（工程名替换 / .ioc 改名 / Drivers 全量 / 拒绝非空目录）", { skip: !fs.existsSync(path.join(CUBE_ROOT, "Repository", DEFAULT_FIRMWARE_PACKAGE)) }, () => {
  const root = tempDir("scaffold");
  const targetDir = path.join(root, "blink");
  const report = createProjectScaffold({ targetDir, projectName: "blink", cubeMxRoots: [CUBE_ROOT] });
  assert.equal(report.ok, true, report.message);
  // 12 个工程文件（CMake/.ld/.vscode/.ioc/.gitignore）+ Core/Src 下的 sysmem.c、syscalls.c
  // （CubeMX GUI 会生成这两个，CLI 不生成；缺了 cmake/stm32cubemx/CMakeLists.txt 直接配置失败）
  assert.equal(report.templateFiles, 14);
  assert.ok(fs.existsSync(path.join(targetDir, "Core/Src/sysmem.c")));
  assert.ok(fs.existsSync(path.join(targetDir, "Core/Src/syscalls.c")));
  // 固件包 Drivers 有 5392 个文件，其中 4000+ 是 CMSIS 文档站/DSP 示例/BSP 组件（与编译无关）；
  // scaffold 只拷有用的那部分（实测 629 个、~4 s），这里守住"够用但别把文档也搬进来"。
  assert.ok(report.driverFiles > 600 && report.driverFiles < 900, "Drivers 文件数 " + String(report.driverFiles));
  assert.ok(fs.existsSync(path.join(targetDir, "Drivers", "STM32F1xx_HAL_Driver", "Src", "stm32f1xx_hal.c")), "HAL 源文件必须在");
  assert.ok(fs.existsSync(path.join(targetDir, "Drivers", "CMSIS", "Device", "ST", "STM32F1xx", "Include", "stm32f103xb.h")), "CMSIS 设备头必须在");
  assert.ok(!fs.existsSync(path.join(targetDir, "Drivers", "CMSIS", "docs")), "CMSIS 文档站不该被拷进来");
  assert.ok(!fs.existsSync(path.join(targetDir, "Drivers", "BSP")), "BSP 板级组件不该被拷进来");

  const cmake = fs.readFileSync(path.join(targetDir, "CMakeLists.txt"), "utf8");
  assert.ok(cmake.includes("set(CMAKE_PROJECT_NAME blink)"));
  assert.ok(fs.existsSync(path.join(targetDir, "blink.ioc")));
  assert.ok(!fs.existsSync(path.join(targetDir, "demo.ioc")));
  const ioc = fs.readFileSync(path.join(targetDir, "blink.ioc"), "utf8");
  assert.ok(ioc.includes("ProjectManager.ProjectName=blink"));
  const launch = fs.readFileSync(path.join(targetDir, ".vscode/launch.json"), "utf8");
  assert.ok(launch.includes("${workspaceFolder}/build/Debug/blink.elf"));
  assert.ok(launch.includes("只烧录"));
  assert.ok(launch.includes("烧录并调试"));
  assert.ok(fs.existsSync(path.join(targetDir, "startup_stm32f103xb.s")));
  assert.ok(fs.existsSync(path.join(targetDir, "Core/Src/system_stm32f1xx.c")));
  assert.ok(fs.existsSync(path.join(targetDir, "STM32F103XX_FLASH.ld")));
  const ld = fs.readFileSync(path.join(targetDir, "STM32F103XX_FLASH.ld"), "utf8");
  assert.ok(ld.includes("LENGTH = 64K"));
  assert.ok(fs.existsSync(path.join(targetDir, "cmake/user/CMakeLists.txt")));
  // 用户清单必须是空的（demo 里那句 test/test.c 不能带过来）
  assert.ok(!fs.readFileSync(path.join(targetDir, "cmake/user/CMakeLists.txt"), "utf8").includes("test.c"));

  // 非空目录默认拒绝
  const again = createProjectScaffold({ targetDir, projectName: "blink", cubeMxRoots: [CUBE_ROOT] });
  assert.equal(again.ok, false);
  assert.match(again.message, /不是空的/u);

  fs.rmSync(root, { recursive: true, force: true });
});

test("scaffold：工程名不是 C 标识符时拒绝", () => {
  const report = createProjectScaffold({ targetDir: path.join(tempDir("bad"), "x"), projectName: "1-bad name" });
  assert.equal(report.ok, false);
  assert.match(report.message, /C 标识符/u);
});
