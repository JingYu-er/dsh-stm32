// npm pack 解包烟测：挡住"作者本机测不出、发布形态必炸"的一整类问题。
//
// 为什么要有它（两条真实事故）：
//   1) npm 打包永远排除 .gitignore（它同时是 npm 的忽略过滤器），而它曾被列为必需文件
//      ——npm 安装的用户 stm32_project_create 100% 失败，源码安装的开发者完全测不出。
//   2) cmsis-sources 的 marker 曾给 mpu_armv7.h 配了它真实内容里不存在的特征
//      ——四条下载链路全通也必失败，同样的清单在单测里却一直绿。
// 所以本脚本不等价于 npm test：它测的是"打包出来的东西"，不是"源码目录"。
//
// 跑法：npm run test:pack（pack 到临时目录，不动仓库）。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const work = mkdtempSync(join(tmpdir(), "dsh-pack-smoke-"));
const failures = [];
const say = (ok, name, detail = "") => {
  console.log((ok ? "PASS " : "FAIL ") + name + (detail === "" ? "" : " — " + detail));
  if (!ok) failures.push(name + (detail === "" ? "" : " (" + detail + ")"));
};

try {
  // 1) pack 到临时目录
  const tarball = join(work, "pkg.tgz");
  execFileSync("npm pack --pack-destination " + JSON.stringify(work) + " --ignore-scripts", { cwd: root, stdio: "pipe", shell: true });
  const packed = readdirSync(work).find((name) => name.endsWith(".tgz"));
  if (packed === undefined) throw new Error("npm pack 没产出 tgz");
  execFileSync("tar -xzf " + JSON.stringify(packed) + " -C " + JSON.stringify(work), { cwd: work, stdio: "pipe", shell: true });
  const pkgRoot = join(work, "package");
  if (!existsSync(pkgRoot)) throw new Error("解包后没有 package/ 目录");

  // 2) 断言一：包内完整性。.gitignore 不在是**合法的**（已决事实：npm 会排除它），
  //    其余关键文件一个都不能少。
  const mustHave = [
    "lib/index.js",
    "lib/client.js",
    "lib/engine/register-template.js",
    "lib/engine/flash.js",
    "lib/engine/doctor.js",
    "templates/register/CMakeLists.txt",
    "templates/register/Core/Src/main.c",
    "templates/scaffold/CMakeLists.txt",
    "templates/scaffold/CMakePresets.json",
    "templates/scaffold/STM32F103XX_FLASH.ld",
    "templates/scaffold/cmake/gcc-arm-none-eabi.cmake",
    "templates/scaffold/vscode/launch.json",
    "templates/scaffold/vscode/settings.json",
    "templates/scaffold/demo.ioc",
    "templates/scaffold/openocd.cfg",
    "cordis.patch.yml",
  ];
  for (const rel of mustHave) {
    say(existsSync(join(pkgRoot, rel)), "包内文件存在：" + rel);
  }
  // client 源与构建产物等价（copy-client 是原样复制）
  const clientSrc = readFileSync(join(root, "client", "client.js"));
  const clientLib = readFileSync(join(pkgRoot, "lib", "client.js"));
  say(clientSrc.equals(clientLib), "lib/client.js 与 client/client.js 逐字节一致");

  // 3) 断言二：用**解包出来的** lib + templates 真建一个寄存器工程（假 fetch，不发网）。
  //    register-template 从 import.meta.url 解析 templates（../../templates/register），
  //    解包目录里正好同构 —— 所以这一步能同时验证 lib 找得到 templates、清单是对的。
  const mod = await import("file://" + join(pkgRoot, "lib", "engine", "register-template.js").replace(/\\/gu, "/"));
  const payload = (name, size = 800) => {
    let text = "";
    while (text.length < size) text += "/* " + name + " */ ";
    return text + "\n" + markerFor(name);
  };
  function markerFor(name) {
    if (name === "system_stm32f1xx.c") return "void SystemInit(void);";
    if (name.endsWith(".s")) return ".syntax unified\n_estack:";
    if (name === "core_cm3.h") return "#ifndef __CORE_CM3_H";
    if (name === "cmsis_compiler.h") return "#ifndef __CMSIS_COMPILER_H";
    if (name === "cmsis_gcc.h") return "#ifndef __CMSIS_GCC_H";
    if (name === "cmsis_version.h") return "#define __CMSIS_VERSION";
    if (name === "mpu_armv7.h") return "#ifndef ARM_MPU_ARMV7_H";
    if (name === "stm32f1xx.h") return "#ifndef __STM32F1XX_H";
    if (name === "stm32f103xb.h") return "#ifndef __STM32F103xB_H";
    if (name === "system_stm32f1xx.h") return "#ifndef __SYSTEM_STM32F1XX_H";
    return "#ifndef __" + name.replace(/[^a-z0-9]/gi, "_").toUpperCase() + "_H";
  }
  const SAMPLES = {
    "Drivers/CMSIS/Device/ST/STM32F1xx/Include/stm32f1xx.h": payload("stm32f1xx.h", 400),
    "Drivers/CMSIS/Device/ST/STM32F1xx/Include/system_stm32f1xx.h": payload("system_stm32f1xx.h", 400),
    "Drivers/CMSIS/Device/ST/STM32F1xx/Include/stm32f103xb.h": payload("stm32f103xb.h", 12000),
    "Drivers/CMSIS/Device/ST/STM32F1xx/Source/Templates/system_stm32f1xx.c": payload("system_stm32f1xx.c", 1200),
    "Drivers/CMSIS/Device/ST/STM32F1xx/Source/Templates/gcc/startup_stm32f103xb.s": payload("startup_stm32f103xb.s", 1200),
    "Drivers/CMSIS/Include/core_cm3.h": payload("core_cm3.h", 600),
    "Drivers/CMSIS/Include/cmsis_compiler.h": payload("cmsis_compiler.h", 600),
    "Drivers/CMSIS/Include/cmsis_gcc.h": payload("cmsis_gcc.h", 600),
    "Drivers/CMSIS/Include/cmsis_version.h": payload("cmsis_version.h", 600),
    "Drivers/CMSIS/Include/mpu_armv7.h": payload("mpu_armv7.h", 600),
  };
  const hashes = {};
  for (const [key, text] of Object.entries(SAMPLES)) {
    hashes[key] = createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
  }
  const fakeFetch = async (url) => {
    const name = url.split("/").pop();
    const key = Object.keys(SAMPLES).find((candidate) => candidate.endsWith("/" + name));
    return new Response(key === undefined ? "" : SAMPLES[key], { status: 200 });
  };
  const projectDir = join(work, "proj");
  const cacheDir = join(work, "cache");
  const env = { DSH_STM32_CACHE: cacheDir };
  const report = await mod.createRegisterProject({
    targetDir: projectDir,
    projectName: "smoke",
    mcu: "STM32F103C8T6",
    env,
    fetchImpl: fakeFetch,
    hashes,
  });
  say(report.ok, "解包产物能建寄存器工程", report.ok ? "" : report.message.slice(0, 300));
  if (report.ok) {
    const produced = [
      "CMakeLists.txt",
      "Core/Src/main.c",
      "Drivers/CMSIS/Device/ST/STM32F1xx/Source/Templates/gcc/startup_stm32f103xb.s",
      "Drivers/CMSIS/Device/ST/STM32F1xx/Include/stm32f103xb.h",
      "Drivers/CMSIS/Include/core_cm3.h",
      "Drivers/CMSIS/Include/mpu_armv7.h",
    ];
    for (const rel of produced) {
      say(existsSync(join(projectDir, rel)), "工程产物存在：" + rel);
    }
  }
} catch (error) {
  say(false, "烟测本身异常", error instanceof Error ? error.message : String(error));
} finally {
  try { rmSync(work, { recursive: true, force: true }); } catch { /* 留给系统清理 */ }
}

console.log("");
if (failures.length > 0) {
  console.log("pack-smoke：失败 " + failures.length + " 项");
  console.log(failures.map((line) => "  · " + line).join("\n"));
  process.exitCode = 1;
} else {
  console.log("pack-smoke：全部通过");
}
