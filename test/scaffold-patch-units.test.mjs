// 单元测试：scaffold（空目录建骨架）、code-patch（只写 USER CODE 块）、flash 的 A5 守卫。
// 跑法：node test\scaffold-patch-units.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createProjectScaffold, resolveFirmwareRoot, DEFAULT_FIRMWARE_PACKAGE } from "../lib/engine/scaffold.js";
import { firmwareExtraDirs } from "../lib/engine/firmware-install.js";
import { createRegisterProject } from "../lib/engine/register-template.js";
import { upsertCacheEntry } from "../lib/engine/cache.js";
import { cmsisTemplatePlan, startupChoiceFor } from "../lib/data/cmsis-sources.js";
import { registerProjectCreate } from "../lib/tools/project-create.js";
import { listUserCodeLabels, patchUserCode } from "../lib/engine/code-patch.js";
import { checkNoDebugGuard } from "../lib/engine/flash.js";
import { copyTreeLong, describeCopyFailure, toLongPath } from "../lib/engine/fs-longpath.js";
import { registerIocApply } from "../lib/tools/ioc-apply.js";
import { registerIocPlan } from "../lib/tools/ioc-plan.js";
import { registerDebugSession } from "../lib/tools/debug-session.js";

/** 取工具定义：注册器会把 definition 交给 ctx.tools.register，其余服务一律返回 undefined。 */
function captureTools(register) {
  const out = new Map();
  register({ tools: { register: (definition) => out.set(definition.name, definition) }, get: () => undefined });
  return out;
}

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

/** 造一个"形状够用"的固件包：三条判据都满足即可（内容不重要，只测找包）。 */
function makeFirmwarePackage(root) {
  for (const rel of [
    "Drivers/STM32F1xx_HAL_Driver/Inc/stm32f1xx_hal.h",
    "Drivers/STM32F1xx_HAL_Driver/Src/stm32f1xx_hal.c",
    "Drivers/CMSIS/Include/core_cm3.h",
    "Drivers/CMSIS/Device/ST/STM32F1xx/Include/stm32f103xb.h",
    "Drivers/CMSIS/Device/ST/STM32F1xx/Source/Templates/system_stm32f1xx.c",
    "Drivers/CMSIS/Device/ST/STM32F1xx/Source/Templates/gcc/startup_stm32f103xb.s",
  ]) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "");
  }
  return root;
}

test("scaffold：固件包在下载缓存里也要找得到（审计 B10：只扫 CubeMX 根会漏）", () => {
  const root = tempDir("fw-cache");
  const before = process.env.DSH_STM32_CACHE;
  try {
    process.env.DSH_STM32_CACHE = path.join(root, "cache");
    const inCache = makeFirmwarePackage(path.join(root, "cache", "firmware", DEFAULT_FIRMWARE_PACKAGE));
    // 只给一个不存在的 CubeMX 根：能找到就证明走的是 extraDirs 这条路。
    const resolved = resolveFirmwareRoot([path.join(root, "no-cube")], DEFAULT_FIRMWARE_PACKAGE, firmwareExtraDirs());
    assert.equal(resolved.root, inCache);
    // 不带 extraDirs 时仍然只认 CubeMX 根（保留显式行为，避免别处误以为"随便哪都能找到"）。
    assert.equal(resolveFirmwareRoot([path.join(root, "no-cube")], DEFAULT_FIRMWARE_PACKAGE).root, undefined);

    // 显式 targetDir 指到包本身：basename 就是包名，要认。
    const direct = makeFirmwarePackage(path.join(root, "custom-place", DEFAULT_FIRMWARE_PACKAGE));
    assert.equal(resolveFirmwareRoot([], DEFAULT_FIRMWARE_PACKAGE, [{ dir: direct, source: "custom" }]).root, direct);

    // 真建一次工程：Drivers 必须来自缓存里那份，不是空的。
    const targetDir = path.join(root, "blink");
    const report = createProjectScaffold({ targetDir, projectName: "blink", cubeMxRoots: [path.join(root, "no-cube")] });
    assert.equal(report.ok, true, report.message);
    assert.equal(report.firmwareRoot, inCache, "工程要指到缓存里那份：" + String(report.firmwareRoot));
    assert.ok(fs.existsSync(path.join(targetDir, "Drivers", "STM32F1xx_HAL_Driver", "Src", "stm32f1xx_hal.c")));
  } finally {
    if (before === undefined) delete process.env.DSH_STM32_CACHE;
    else process.env.DSH_STM32_CACHE = before;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scaffold：空目录 → 骨架（工程名替换 / .ioc 改名 / Drivers 全量 / 拒绝非空目录）", { skip: !fs.existsSync(path.join(CUBE_ROOT, "Repository", DEFAULT_FIRMWARE_PACKAGE)) }, () => {
  const root = tempDir("scaffold");
  const targetDir = path.join(root, "blink");
  const report = createProjectScaffold({ targetDir, projectName: "blink", cubeMxRoots: [CUBE_ROOT] });
  assert.equal(report.ok, true, report.message);
  // 15 个工程文件（CMake/.ld/.vscode/.ioc/openocd.cfg/.gitignore）+ Core/Src 下的 sysmem.c、syscalls.c
  // （CubeMX GUI 会生成这两个，CLI 不生成；缺了 cmake/stm32cubemx/CMakeLists.txt 直接配置失败）
  assert.equal(report.templateFiles, 15);
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

// —— 批 1（A1/A5）：overwrite 覆盖前必须备份、.ioc 不许被模板覆盖、写盘/备份失败要干净收场 ——

const CACHE_TEST_FILES = [
  ["Drivers/CMSIS/Include/core_cm3.h", "/* core */\n"],
  ["Drivers/CMSIS/Device/ST/STM32F1xx/Include/stm32f103xb.h", "/* device */\n"],
  ["Drivers/CMSIS/Device/ST/STM32F1xx/Source/Templates/gcc/startup_stm32f103xb.s", "/* startup */\n"],
];

/** 在临时目录里种一份"已经下好"的 CMSIS 缓存条目：register 路线因此不联网，测试也就与网络无关。 */
function seedCmsisCache(root) {
  const cacheRoot = path.join(root, "cache");
  const entryDir = path.join(root, "tpl");
  const files = [];
  for (const [rel, text] of CACHE_TEST_FILES) {
    const abs = path.join(entryDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    files.push({ path: rel, bytes: Buffer.byteLength(text), url: "https://example.invalid/" + rel });
  }
  const plan = cmsisTemplatePlan(startupChoiceFor("STM32F103C8T6"));
  const env = { ...process.env, DSH_STM32_CACHE: cacheRoot };
  upsertCacheEntry(
    {
      id: plan.id,
      kind: "cmsis",
      family: plan.family,
      label: "测试模板",
      root: entryDir,
      createdAt: new Date().toISOString(),
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      files,
      sources: ["https://example.invalid"],
      license: "test",
    },
    env,
  );
  return { env, entryDir };
}

test("A1 覆盖备份：register 路线 overwrite=true 时，被覆盖的旧文件先备份再写", async () => {
  const root = tempDir("a1-register");
  const { env } = seedCmsisCache(root);
  const targetDir = path.join(root, "blink");
  const oldMain = "/* 用户自己写的 main.c */\r\nint main(void) { return 0; }\r\n";
  const oldCMake = "# 旧 CMakeLists\nset(CMAKE_PROJECT_NAME old)\n";
  fs.mkdirSync(path.join(targetDir, "Core/Src"), { recursive: true });
  fs.writeFileSync(path.join(targetDir, "Core/Src/main.c"), oldMain);
  fs.writeFileSync(path.join(targetDir, "CMakeLists.txt"), oldCMake);
  // 寄存器路线不写 .ioc：它必须原样留着（被"顺手覆盖掉"就是 A1 的另一半）
  fs.writeFileSync(path.join(targetDir, "blink.ioc"), "Mcu.CPN=STM32F103C8T6\n");

  const report = await createRegisterProject({ targetDir, projectName: "blink", mcu: "STM32F103C8T6", overwrite: true, env, download: false });
  assert.equal(report.ok, true, report.message);

  const backupsDir = path.join(targetDir, ".dsh-stm32", "backups");
  const stamps = fs.readdirSync(backupsDir);
  assert.equal(stamps.length, 1, "只该有一次备份目录");
  const backupDir = path.join(backupsDir, stamps[0]);
  assert.ok((report.warnings[0] ?? "").includes(backupDir), "warnings 第一条要说清备份到哪：" + String(report.warnings[0]));
  assert.equal(fs.readFileSync(path.join(backupDir, "Core/Src/main.c"), "utf8"), oldMain);
  assert.equal(fs.readFileSync(path.join(backupDir, "CMakeLists.txt"), "utf8"), oldCMake);

  // 新文件已写入，旧内容不再藏在里面
  const fresh = fs.readFileSync(path.join(targetDir, "Core/Src/main.c"), "utf8");
  assert.ok(!fresh.includes("用户自己写的"), "main.c 应被模板覆盖");
  assert.ok(fresh.length > 0);
  assert.ok(!fs.readFileSync(path.join(targetDir, "CMakeLists.txt"), "utf8").includes("旧 CMakeLists"));
  assert.equal(fs.readFileSync(path.join(targetDir, "blink.ioc"), "utf8"), "Mcu.CPN=STM32F103C8T6\n");

  fs.rmSync(root, { recursive: true, force: true });
});

test("npm 包形态：模板里没有 .gitignore 时，register 路线照建工程并给一句 warning", async () => {
  const root = tempDir("gitignore-reg");
  const { env } = seedCmsisCache(root);
  const targetDir = path.join(root, "blink");
  // 模拟 npm 安装：npm 打包永远排除 .gitignore。改的是真实模板文件，测完恢复。
  const halTpl = path.resolve(process.cwd(), "templates", "scaffold");
  const gi = path.join(halTpl, ".gitignore");
  const giBackup = path.join(root, "gitignore.saved");
  fs.copyFileSync(gi, giBackup);
  fs.rmSync(gi);

  try {
    const report = await createRegisterProject({ targetDir, projectName: "blink", mcu: "STM32F103C8T6", env, download: false });
    assert.equal(report.ok, true, report.message);
    assert.ok(report.warnings.some((line) => line.includes(".gitignore")), "缺 .gitignore 要在 warnings 里说明：" + report.warnings.join(" | "));
    // 其余公共文件一个不少：工程能用
    assert.ok(fs.existsSync(path.join(targetDir, "CMakeLists.txt")));
    assert.ok(fs.existsSync(path.join(targetDir, "CMakePresets.json")));
    assert.ok(fs.existsSync(path.join(targetDir, "STM32F103XX_FLASH.ld")));
    assert.ok(!fs.existsSync(path.join(targetDir, ".gitignore")), "缺失时不该凭空造一个");
  } finally {
    fs.copyFileSync(giBackup, gi);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("npm 包形态：模板里没有 .gitignore 时，hal 路线照建骨架并给一句 warning", () => {
  const root = tempDir("gitignore-hal");
  const targetDir = path.join(root, "blink");
  const halTpl = path.resolve(process.cwd(), "templates", "scaffold");
  const gi = path.join(halTpl, ".gitignore");
  const giBackup = path.join(root, "gitignore.saved");
  fs.copyFileSync(gi, giBackup);
  fs.rmSync(gi);
  try {
    const report = createProjectScaffold({ targetDir, projectName: "blink", cubeMxRoots: [CUBE_ROOT], firmwarePackage: DEFAULT_FIRMWARE_PACKAGE });
    if (report.ok) {
      assert.ok(report.warnings.some((line) => line.includes(".gitignore")), "缺 .gitignore 要在 warnings 里说明：" + report.warnings.join(" | "));
      assert.ok(!fs.existsSync(path.join(targetDir, ".gitignore")));
    } else {
      // 本机没有固件包时 preflight 会先拒绝——那就只验证拒绝原因不是 .gitignore
      assert.ok(!report.message.includes(".gitignore"), "拒绝原因不该扯到 .gitignore：" + report.message);
    }
  } finally {
    fs.copyFileSync(giBackup, gi);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("A1 .ioc 保护：hal 路线遇到已有同名 .ioc 时直接拒绝，一个字节都不动", () => {
  const root = tempDir("a1-hal");
  const targetDir = path.join(root, "blink");
  fs.mkdirSync(targetDir, { recursive: true });
  const iocPath = path.join(targetDir, "blink.ioc");
  fs.writeFileSync(iocPath, IOC_SERIAL_WIRE);
  // 不传 cubeMxRoots：拒绝发生在找固件包之前，所以这个用例不依赖本机装没装 CubeMX
  const report = createProjectScaffold({ targetDir, projectName: "blink", overwrite: true });
  assert.equal(report.ok, false);
  assert.match(report.message, /stm32_ioc_plan/u);
  assert.match(report.message, /stm32_ioc_apply/u);
  assert.match(report.message, /先自己备份或删掉/u);
  assert.equal(fs.readFileSync(iocPath, "utf8"), IOC_SERIAL_WIRE);
  assert.ok(!fs.existsSync(path.join(targetDir, ".dsh-stm32")), "拒绝时不该留下备份目录或半成品");
  fs.rmSync(root, { recursive: true, force: true });
});

test("A5 备份失败：一个字都不写、旧文件不变、报告里带路径", async () => {
  const root = tempDir("a1-backupfail");
  const { env } = seedCmsisCache(root);
  const targetDir = path.join(root, "blink");
  const oldMain = "/* 旧 main */\n";
  fs.mkdirSync(path.join(targetDir, "Core/Src"), { recursive: true });
  fs.writeFileSync(path.join(targetDir, "Core/Src/main.c"), oldMain);
  // 把 .dsh-stm32 做成普通文件：备份目录 mkdir 必然 ENOTDIR，等价于"备份做不了"
  fs.writeFileSync(path.join(targetDir, ".dsh-stm32"), "not a dir");

  const report = await createRegisterProject({ targetDir, projectName: "blink", overwrite: true, env, download: false });
  assert.equal(report.ok, false);
  assert.match(report.message, /备份失败/u);
  assert.ok(report.message.includes(targetDir), "报告里要有路径：" + report.message);
  assert.equal(fs.readFileSync(path.join(targetDir, "Core/Src/main.c"), "utf8"), oldMain);
  assert.ok(!fs.existsSync(path.join(targetDir, "CMakeLists.txt")), "备份失败时不许写任何文件");
  assert.ok(!fs.existsSync(path.join(targetDir, "Drivers")), "备份失败时不许拷 Drivers");

  fs.rmSync(root, { recursive: true, force: true });
});

test("A1 顺序：目标目录非空先于工具链门禁（不会先让人去装 CubeMX）", async () => {
  let definition = null;
  registerProjectCreate({ tools: { register: (value) => { definition = value; } } });
  assert.ok(definition !== null);
  const dir = tempDir("a1-order");
  fs.writeFileSync(path.join(dir, "keep.txt"), "x");
  const value = await definition.execute(
    { targetDir: dir, projectName: "blink", envCheck: "block" },
    { signal: new AbortController().signal },
  );
  assert.equal(value.report.ok, false);
  assert.match(value.message, /不是空的/u, "应先报目录非空：" + value.message);
  assert.ok(!value.message.includes("CubeMX"), "不该先要求装 CubeMX：" + value.message);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("B15 hal 路线不再要 CubeMX 启动器：缺 CubeMX 时报「找不到固件包」而不是「缺 STM32CubeMX」", async () => {
  let definition = null;
  registerProjectCreate({ tools: { register: (value) => { definition = value; } }, get: () => undefined });
  assert.ok(definition !== null);
  const dir = tempDir("b15-hal");
  const value = await definition.execute(
    {
      targetDir: dir,
      projectName: "blink",
      route: "hal",
      cubeMxRoots: [path.join(dir, "no-such-cubemx")],
      envCheck: "block",
    },
    { signal: new AbortController().signal },
  );
  assert.equal(value.report.ok, false);
  // 拷 CMake 文件 / Drivers 不需要 STM32CubeMX.exe 与它的 JRE，所以门禁不该以 generate 能力拦人；
  // 真正缺的是固件包，由 scaffold 自己报（并列出找过的路径）。
  assert.match(value.message, /找不到 CubeMX 固件包/u, value.message);
  assert.ok(!value.message.includes("缺 STM32CubeMX"), "拷文件不需要 CubeMX 启动器：" + value.message);
  assert.ok(!fs.existsSync(path.join(dir, "CMakeLists.txt")), "失败时不该留下半成品");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("B17 fs-longpath：toLongPath 只给 Windows 绝对路径加 \\\\?\\ 前缀", () => {
  if (process.platform !== "win32") return;
  const abs = path.join(os.tmpdir(), "blink");
  const expected = "\\\\?\\" + abs.replace(/\//gu, "\\");
  assert.equal(toLongPath(abs), expected);
  assert.equal(toLongPath(expected), expected, "已经带前缀的不能再加一层");
  assert.equal(toLongPath("relative/dir"), "relative/dir");
  assert.equal(toLongPath(""), "");
});

test("B17 fs-longpath：目标路径超过 260 字符时仍能把整棵树拷过去", () => {
  const src = tempDir("b17-src");
  fs.mkdirSync(path.join(src, "a", "b"), { recursive: true });
  fs.writeFileSync(path.join(src, "a", "b", "hello.txt"), "长路径也能写\n");

  const root = tempDir("b17-dst");
  // 每级 40 字符 × 8 级：加上临时目录前缀必然超过 MAX_PATH，正是审计里"深目录 + 深固件包层级"的形状。
  const deep = path.join(root, ...Array.from({ length: 8 }, () => "d".repeat(40)));
  assert.ok(deep.length > 260, "这个用例要真的超过 260 字符：" + String(deep.length));

  const created = [];
  const count = copyTreeLong(src, deep, [], created);
  assert.equal(count, 1);
  const copied = path.join(deep, "a", "b", "hello.txt");
  assert.equal(fs.readFileSync(toLongPath(copied), "utf8"), "长路径也能写\n");
  assert.ok(created.length > 0, "新建的目录要记下来，失败时才好精确清理");

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});

test("B17 fs-longpath：复制失败的中文说明同时给出两侧路径与 260 字符这条线索", () => {
  const error = Object.assign(new Error("boom"), { code: "ENAMETOOLONG" });
  const text = describeCopyFailure("D:\\a\\very\\long\\src.s", "D:\\b\\dst.s", error);
  assert.match(text, /ENAMETOOLONG/u);
  assert.match(text, /260/u);
  assert.ok(text.includes("D:\\a\\very\\long\\src.s") && text.includes("D:\\b\\dst.s"), text);
});

test("A18：回滚报告 appliedChanges 记 0 且 rolledBack=true（不再拿 1 冒充改了一处）", async () => {
  const dir = tempDir("a18");
  fs.writeFileSync(path.join(dir, "demo.ioc"), "Mcu.CPN=STM32F103C8T6\n");
  const backupDir = path.join(dir, ".dsh-stm32", "backups", "20260101-000000-auto");
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, "demo.ioc"), "Mcu.CPN=STM32F103C8T6\nMcu.Restored=1\n");

  const tool = captureTools(registerIocApply).get("stm32_ioc_apply");
  const value = await tool.execute({ projectDir: dir, rollbackFrom: path.join(backupDir, "demo.ioc") }, { signal: new AbortController().signal });

  assert.equal(value.ok, true, value.message);
  assert.equal(value.mode, "rollback");
  assert.equal(value.appliedChanges, 0);
  assert.equal(value.rolledBack, true);
  assert.match(fs.readFileSync(path.join(dir, "demo.ioc"), "utf8"), /Mcu\.Restored=1/u);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("A31：rawArgs 为 undefined 时四个工具给报告而不是 TypeError", async () => {
  const tool = captureTools(registerIocApply).get("stm32_ioc_apply");
  const applied = await tool.execute(undefined, { signal: new AbortController().signal });
  assert.equal(applied.ok, false);
  assert.match(applied.message, /planId/u);
  assert.equal(applied.appliedChanges, 0);
  assert.equal(applied.rolledBack, false);

  const plan = captureTools(registerIocPlan).get("stm32_ioc_plan");
  const planned = await plan.execute(undefined, { signal: new AbortController().signal });
  assert.equal(planned.ok, false, "没有工程/参数时应当是「没计划」的报告");

  const sessionTools = captureTools(registerDebugSession);
  const evaluated = await sessionTools.get("stm32_debug_eval").execute(undefined, { signal: new AbortController().signal });
  assert.equal(evaluated.report.ok, false);
  assert.match(evaluated.message, /没有会话/u);

  // 只剩 stm32_debug_session：它会真的去起 openocd，所以先把门禁逼成"缺件"。
  // 本机 PATH 里有全套工具，不这么做用例会变成"真的开会话"。
  const savedEnv = {
    bins: process.env.STM32_BIN_DIRS,
    discover: process.env.STM32_NO_DISCOVER,
    config: process.env.DSH_STM32_NO_CONFIG,
    path: process.env.PATH,
  };
  const emptyBins = tempDir("a31-bins");
  process.env.STM32_BIN_DIRS = emptyBins;
  process.env.STM32_NO_DISCOVER = "1";
  process.env.DSH_STM32_NO_CONFIG = "1";
  process.env.PATH = emptyBins;
  try {
    const session = await sessionTools.get("stm32_debug_session").execute(undefined, { signal: new AbortController().signal });
    assert.equal(session.session.ok, false, session.message);
    assert.equal(session.session.active, false);
  } finally {
    const restore = (key, value) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("STM32_BIN_DIRS", savedEnv.bins);
    restore("STM32_NO_DISCOVER", savedEnv.discover);
    restore("DSH_STM32_NO_CONFIG", savedEnv.config);
    restore("PATH", savedEnv.path);
    fs.rmSync(emptyBins, { recursive: true, force: true });
  }
});

