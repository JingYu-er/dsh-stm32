// 为什么要有这个套件：固件包下载器会联网、会解 tar.gz、会往 CubeMX 仓库写目录。
// 坏掉的表现很难查：CubeMX 缺包时不报错（docs §14）、解包逻辑写错会把文件摊到错目录、
// 半截包被当成装好了。所以这里全部用注入的 fetchImpl + 临时目录，逐条钉住行为。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";

import { extractTarGz } from "../lib/engine/tar.js";
import {
  FIRMWARE_FAMILIES,
  dshFirmwareDir,
  firmwareFamilyOf,
  firmwareNeedFromIoc,
  firmwarePlanFor,
  firmwareVersionTags,
  locateFirmwarePackage,
  packageXmlText,
  verifyFirmwarePackage,
} from "../lib/data/firmware-packages.js";
import { buildGenerateScript, parseGenerateLog } from "../lib/engine/generate-script.js";
import { resolveFirmwareRoot } from "../lib/engine/scaffold.js";
import {
  findInstalledFirmware,
  firmwareInstallPlan,
  installFirmware,
  isProtectedSystemDir,
  orderCubeMxRoots,
  readFirmwareInstallRecords,
} from "../lib/engine/firmware-install.js";
import { FIRMWARE_INSTALL_TOOL, registerFirmwareInstall } from "../lib/tools/firmware-install.js";

function tempDir(tag) {
  return mkdtempSync(join(tmpdir(), "dsh-fw-" + tag + "-"));
}

/**
 * 造一个"看起来装过 CubeMX"的根：插件只对含 STM32CubeMX.exe 的根建 dsh-firmware，
 * 少了这个标记文件就会被当成假根跳过（B12）。
 */
function cubeMxRoot(tag) {
  const root = tempDir(tag);
  writeFileSync(join(root, "STM32CubeMX.exe"), "stub");
  return root;
}

/* --------------------------- 内存里造 tar.gz --------------------------- */

const BLOCK = 512;

function octal(value, width) {
  return value.toString(8).padStart(width, "0");
}

/** 一个 ustar 条目头（名字不超过 100 字节，测试足够）。linkname 只对链接类条目有意义。 */
function tarHeader(name, size, typeflag, linkname = "") {
  const buf = Buffer.alloc(BLOCK);
  buf.write(name.slice(0, 100), 0, 100, "utf8");
  buf.write("0000644\0", 100);
  buf.write("0000000\0", 108);
  buf.write("0000000\0", 116);
  buf.write(octal(size, 11) + "\0", 124);
  buf.write("00000000000\0", 136);
  buf.write("        ", 148);
  buf.write(typeflag, 156);
  if (linkname !== "") buf.write(linkname.slice(0, 100), 157, 100, "utf8");
  buf.write("ustar\0", 257);
  buf.write("00", 263);
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(octal(sum, 6) + "\0 ", 148);
  return buf;
}

/** 条目类型 → typeflag（只列测试会用到的）。 */
const TYPEFLAGS = { file: "0", dir: "5", hardlink: "1", symlink: "2", device: "3", fifo: "6" };

/** entries: { path, data?, type?: "file"|"dir"|"symlink"|"hardlink"|"device"|"fifo", link? } */
function makeTar(entries) {
  const chunks = [];
  for (const entry of entries) {
    const typeflag = TYPEFLAGS[entry.type ?? "file"] ?? "0";
    const isDir = typeflag === "5";
    const isLink = typeflag === "1" || typeflag === "2";
    // 链接/设备/FIFO 没有数据段；目录也没有。
    const data = Buffer.from(isDir || isLink || typeflag !== "0" ? "" : entry.data ?? "", "utf8");
    const name = isDir && !entry.path.endsWith("/") ? entry.path + "/" : entry.path;
    chunks.push(tarHeader(name, data.length, typeflag, isLink ? entry.link ?? "" : ""));
    if (data.length > 0) {
      chunks.push(data);
      const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
      if (pad > 0) chunks.push(Buffer.alloc(pad));
    }
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
}

function makeTarGz(entries) {
  return gzipSync(makeTar(entries));
}

/** HAL 归档（codeload 的根目录会被 stripComponents:1 去掉）。含一块随机数据，保证 gzip 后 > 100 KB。 */
function halArchive(extra = []) {
  return makeTarGz([
    { path: "stm32f1xx-hal-driver-master", type: "dir" },
    { path: "stm32f1xx-hal-driver-master/Inc/stm32f1xx_hal.h", data: "/* hal */\n" },
    { path: "stm32f1xx-hal-driver-master/Src/stm32f1xx_hal.c", data: "/* hal src */\n" },
    { path: "stm32f1xx-hal-driver-master/Inc/blob.h", data: randomBytes(120_000) },
    { path: "stm32f1xx-hal-driver-master/.github/workflows/ci.yml", data: "name: ci\n" },
    ...extra,
  ]);
}

function deviceArchive() {
  return makeTarGz([
    { path: "cmsis-device-f1-master", type: "dir" },
    { path: "cmsis-device-f1-master/Include/stm32f1xx.h", data: "/* device */\n" },
    { path: "cmsis-device-f1-master/Source/Templates/gcc/startup_stm32f103xb.s", data: ".syntax unified\n" },
    { path: "cmsis-device-f1-master/Source/Templates/system_stm32f1xx.c", data: "/* system */\n" },
    { path: "cmsis-device-f1-master/Include/blob.h", data: randomBytes(120_000) },
  ]);
}

const CORE_BODY = "/* cmsis core */\n".padEnd(700, " ");

/** 假 fetch：按 URL 里的仓库名给归档、按文件名给内核头，其它一律 404。 */
function firmwareFetch(options = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (typeof options.handler === "function") return options.handler(url, calls);
    if (options.fail === true) return new Response("", { status: 404 });
    if (url.includes("stm32f1xx-hal-driver")) return new Response(halArchive(), { status: 200 });
    if (url.includes("cmsis-device-f1")) return new Response(deviceArchive(), { status: 200 });
    const name = url.split("/").pop();
    const headers = FIRMWARE_FAMILIES.F1.coreHeaders;
    if (headers.includes(name)) return new Response(CORE_BODY, { status: 200 });
    return new Response("", { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

const neverFetch = async (url) => {
  throw new Error("不该联网：" + String(url));
};

/* ------------------------------ 解包器 ------------------------------ */

test("extractTarGz：stripComponents + mapPath 只留要的目录，别的计入 skipped", () => {
  const root = tempDir("tar");
  try {
    const archive = halArchive();
    const result = extractTarGz(archive, root, {
      stripComponents: 1,
      mapPath: (rel) =>
        rel === "Inc" || rel.startsWith("Inc/")
          ? "Drivers/HAL/Inc" + rel.slice(3)
          : rel === "Src" || rel.startsWith("Src/")
            ? "Drivers/HAL/Src" + rel.slice(3)
            : null,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(existsSync(join(root, "Drivers/HAL/Inc/stm32f1xx_hal.h")), true);
    assert.equal(existsSync(join(root, "Drivers/HAL/Src/stm32f1xx_hal.c")), true);
    assert.equal(existsSync(join(root, ".github")), false);
    assert.ok(result.skipped >= 1, "被映射掉的条目要计数");
    assert.equal(readFileSync(join(root, "Drivers/HAL/Inc/stm32f1xx_hal.h"), "utf8").trim(), "/* hal */");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extractTarGz：不是 tar.gz 就明说；带 .. 的条目整次失败、一个文件都不落", () => {
  const root = tempDir("tar-bad");
  try {
    const bad = extractTarGz(Buffer.from("this is not a gzip stream"), root, {});
    assert.equal(bad.ok, false);
    assert.match(bad.error, /tar\.gz/u);

    const evil = makeTarGz([
      { path: "root", type: "dir" },
      { path: "root/ok.txt", data: "ok\n" },
      { path: "root/../escape.txt", data: "boom\n" },
    ]);
    const result = extractTarGz(evil, root, { stripComponents: 1 });
    assert.equal(result.ok, false);
    assert.match(result.error, /\.\./u);
    assert.equal(existsSync(join(root, "escape.txt")), false);
    assert.equal(existsSync(join(root, "ok.txt")), false, "命中穿越就整次失败，不留半成品");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extractTarGz：符号链接 / 硬链接不落盘，名字记进 skippedPaths，其余文件照解", () => {
  const root = tempDir("tar-link");
  try {
    const archive = makeTarGz([
      { path: "root", type: "dir" },
      { path: "root/Inc", type: "dir" },
      { path: "root/Inc/a.h", data: "/* a */\n" },
      { path: "root/Inc/link.h", type: "symlink", link: "../../escape.h" },
      { path: "root/Inc/hard.h", type: "hardlink", link: "a.h" },
    ]);
    const result = extractTarGz(archive, root, { stripComponents: 1 });
    assert.equal(result.ok, true, result.error);
    assert.equal(existsSync(join(root, "Inc/a.h")), true);
    assert.equal(existsSync(join(root, "Inc/link.h")), false, "符号链接不能变成 0 字节假文件");
    assert.equal(existsSync(join(root, "Inc/hard.h")), false, "硬链接同样不能变成 0 字节假文件");
    assert.equal(result.files.some((item) => item.path.includes("link.h")), false, "files 里不许出现链接条目");
    assert.ok((result.skippedPaths ?? []).some((item) => item.includes("link.h")), "跳过的名字要能报出来");
    assert.ok((result.skippedPaths ?? []).some((item) => item.includes("hard.h")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extractTarGz：条目名用反斜杠上跳也整次失败，目标目录外一个文件都不落", () => {
  const outside = tempDir("tar-backslash");
  const root = join(outside, "dest");
  try {
    const archive = makeTarGz([
      { path: "root", type: "dir" },
      { path: "root/ok.txt", data: "ok\n" },
      { path: "root/..\\..\\escape.txt", data: "boom\n" },
    ]);
    const result = extractTarGz(archive, root, { stripComponents: 1 });
    assert.equal(result.ok, false, "反斜杠穿越必须整次失败");
    assert.match(result.error, /可疑路径/u);
    assert.equal(existsSync(join(outside, "escape.txt")), false);
    assert.equal(existsSync(join(outside, "..", "escape.txt")), false);
    assert.equal(existsSync(join(root, "ok.txt")), false, "命中穿越就整次失败，不留半成品");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

/* --------------------------- 包计划与判据 --------------------------- */

test("firmwarePlanFor：F1 的目录名、版本串、归档与内核头都对得上真包", () => {
  const plan = firmwarePlanFor({ family: "F1" });
  assert.equal(plan.ok, true, plan.error);
  assert.equal(plan.dirName, "STM32Cube_FW_F1_V1.8.7");
  assert.equal(plan.releaseTag, "FW.F1.1.8.0");
  assert.equal(plan.patchTag, "FW.F1.1.8.7");
  assert.match(plan.packageXml, /Release="FW\.F1\.1\.8\.0"/u);
  assert.match(plan.packageXml, /Patch="FW\.F1\.1\.8\.7"/u);
  assert.equal(plan.archives.length, 2);
  assert.deepEqual(plan.archives.map((item) => item.id), ["hal", "device"]);
  assert.equal(plan.archives[0].urls.length >= 2, true);
  assert.equal(plan.coreTargets.length, 5);
  assert.equal(plan.coreTargets.every((target) => target.urls.length >= 2), true);
  assert.equal(plan.halDir, "Drivers/STM32F1xx_HAL_Driver");

  const byMcu = firmwarePlanFor({ mcu: "STM32F103C8T6" });
  assert.equal(byMcu.ok, true);
  assert.equal(byMcu.dirName, plan.dirName);

  const v162 = firmwarePlanFor({ family: "F1", version: "1.6.2" });
  assert.equal(v162.dirName, "STM32Cube_FW_F1_V1.6.2");
  assert.equal(v162.patchTag, "FW.F1.1.6.2");
});

test("firmwarePlanFor：没接入的族、错的版本号都要说人话（不瞎猜）", () => {
  const h7 = firmwarePlanFor({ family: "STM32H743VIT6" });
  assert.equal(h7.ok, false);
  assert.match(h7.error, /目前只会/u);

  const badVersion = firmwarePlanFor({ family: "F1", version: "1.8" });
  assert.equal(badVersion.ok, false);
  assert.match(badVersion.error, /三段/u);

  const empty = firmwarePlanFor({});
  assert.equal(empty.ok, false);
  assert.match(empty.error, /family/u);
});

test("firmwareFamilyOf / firmwareVersionTags / packageXmlText 的基本规则", () => {
  assert.equal(firmwareFamilyOf("STM32F103C8T6"), "F1");
  assert.equal(firmwareFamilyOf("f1"), "F1");
  assert.equal(firmwareFamilyOf("STM32G431CBT6"), "");
  const tags = firmwareVersionTags("F1", "1.6.2");
  assert.deepEqual(tags, { release: "FW.F1.1.6.0", patch: "FW.F1.1.6.2" });
  assert.match(packageXmlText(tags), /PackDescription Release="FW\.F1\.1\.6\.0" Patch="FW\.F1\.1\.6\.2"/u);
});

test("verifyFirmwarePackage：空目录必须判不过，并把缺的条目标出来", () => {
  const root = tempDir("verify");
  try {
    const empty = verifyFirmwarePackage(root, "F1");
    assert.equal(empty.ok, false);
    assert.ok(empty.missing.length >= 3, "HAL/CMSIS/设备三块都缺");
    const unknown = verifyFirmwarePackage(root, "H7");
    assert.equal(unknown.ok, false);
    assert.match(unknown.missing.join("；"), /清单/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------- 计划：零副作用 ------------------------- */

test("firmwareInstallPlan：只读——不建目录、不联网，五步全 pending", async () => {
  const root = cubeMxRoot("plan");
  try {
    const result = firmwareInstallPlan({ family: "F1", cubeMxRoots: [root], env: { DSH_STM32_CACHE: join(root, "cache") } });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.mode, "plan");
    assert.equal(result.targetKind, "cubeMx");
    assert.equal(result.targetDir, join(root, "dsh-firmware", "STM32Cube_FW_F1_V1.8.7").split("\\").join("/"));
    assert.equal(result.steps.length, 5);
    assert.equal(result.steps.every((step) => step.status === "pending"), true);
    assert.match(result.message, /还没动手/u);
    assert.equal(existsSync(join(root, "Repository")), false, "计划模式不许建 Repository");
    assert.equal(existsSync(join(root, "dsh-firmware")), false, "计划模式不许建 dsh-firmware");
    assert.equal(findInstalledFirmware([root], "STM32Cube_FW_F1_V1.8.7"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("firmwareInstallPlan：已装官方包就地用，五步全 skipped；自检不过要明说", () => {
  const root = tempDir("existing");
  try {
    const pkg = join(root, "Repository", "STM32Cube_FW_F1_V1.8.7");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.xml"), "<Package/>", "utf8");
    const result = firmwareInstallPlan({ family: "F1", cubeMxRoots: [root] });
    assert.equal(result.targetKind, "existing");
    assert.equal(result.steps.every((step) => step.status === "skipped"), true);
    assert.equal(result.verify.ok, false);
    assert.equal(result.ok, false);
    assert.match(result.message, /自检不过/u);
    assert.match(result.message, /包管理器重装/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* --------------------------- 真装（假网络） --------------------------- */

test("installFirmware：假 fetch 装出一个自检全过的包（只留要的目录）", async () => {
  const root = tempDir("install");
  const target = join(root, "pkg");
  const progress = [];
  try {
    const result = await installFirmware({
      family: "F1",
      targetDir: target,
      cubeMxRoots: [root],
      mode: "install",
      env: { DSH_STM32_CACHE: join(root, "cache") },
      fetchImpl: firmwareFetch(),
      onProgress: (line) => progress.push(line),
    });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.mode, "install");
    assert.equal(result.targetKind, "custom");
    assert.equal(result.verify.ok, true);
    assert.equal(result.verify.checks.length, 5);
    assert.equal(result.steps.every((step) => step.status === "done"), true);
    assert.equal(result.download.files, 7, "2 个归档 + 5 个内核头");
    assert.ok(result.download.bytes > 100_000);
    assert.match(result.message, /三条判据全过/u);
    assert.match(result.nextStep, /setCustomFWPath/u);
    assert.match(result.nextStep, /不往 \.ioc 里写绝对路径/u);

    assert.equal(existsSync(join(target, "package.xml")), true);
    assert.match(readFileSync(join(target, "package.xml"), "utf8"), /FW\.F1\.1\.8\.7/u);
    assert.equal(existsSync(join(target, "THIRD_PARTY_NOTICES.md")), true);
    assert.equal(existsSync(join(target, "Drivers/STM32F1xx_HAL_Driver/Inc/stm32f1xx_hal.h")), true);
    assert.equal(existsSync(join(target, "Drivers/STM32F1xx_HAL_Driver/Src/stm32f1xx_hal.c")), true);
    assert.equal(existsSync(join(target, "Drivers/CMSIS/Device/ST/STM32F1xx/Include/stm32f1xx.h")), true);
    assert.equal(existsSync(join(target, "Drivers/CMSIS/Device/ST/STM32F1xx/Source/Templates/gcc/startup_stm32f103xb.s")), true);
    assert.equal(existsSync(join(target, "Drivers/CMSIS/Include/core_cm3.h")), true);
    assert.equal(existsSync(join(target, ".github")), false, "仓库里的 .github 不该落盘");
    assert.deepEqual(
      readdirSync(target).filter((name) => name.startsWith(".dsh-download")),
      [],
      "下载临时目录要清掉（固定名 .dsh-download 与每次唯一的 .dsh-download-<pid>-<ts> 都算）",
    );
    assert.ok(progress.some((line) => line.includes("解包")), "进度里要看得到解包");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installFirmware：下不下来就失败、不许假装装好", async () => {
  const root = tempDir("fail");
  const target = join(root, "pkg");
  try {
    const result = await installFirmware({
      family: "F1",
      targetDir: target,
      cubeMxRoots: [root],
      mode: "install",
      fetchImpl: firmwareFetch({ fail: true }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.verify.ok, false);
    assert.match(result.message, /下载失败/u);
    const downloadStep = result.steps.find((step) => step.id === "download");
    assert.equal(downloadStep.status, "failed");
    assert.match(downloadStep.detail, /个文件没下下来/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installFirmware：already-installed 时一次网络都不发", async () => {
  const root = tempDir("existing-install");
  try {
    const pkg = join(root, "Repository", "STM32Cube_FW_F1_V1.8.7");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.xml"), "<Package/>", "utf8");
    const result = await installFirmware({ family: "F1", cubeMxRoots: [root], mode: "install", fetchImpl: neverFetch });
    assert.equal(result.targetKind, "existing");
    assert.equal(result.ok, false);
    assert.equal(result.download.files, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------ 工具层 ------------------------------ */

function fakeContext() {
  const tools = [];
  return {
    tools,
    ctx: {
      tools: { register: (definition) => tools.push(definition) },
      get: () => undefined,
    },
  };
}

test("stm32_firmware_install：注册契约与计划模式（不联网、不建目录）", async () => {
  const root = cubeMxRoot("tool");
  try {
    const { tools, ctx } = fakeContext();
    registerFirmwareInstall(ctx);
    assert.equal(tools.length, 1);
    const definition = tools[0];
    assert.equal(definition.name, FIRMWARE_INSTALL_TOOL);
    assert.equal(definition.parameters.properties.family.type, "string");
    assert.equal(definition.parameters.properties.dryRun.type, "boolean");
    assert.equal(definition.parameters.properties.confirm.type, "boolean");
    assert.deepEqual(definition.parameters.properties.target.enum, ["auto", "repository", "cache"]);
    assert.ok(definition.output.schema.required.includes("message"));

    const value = await definition.execute(
      { family: "F1", cubeMxRoot: root },
      { signal: new AbortController().signal },
    );
    assert.equal(value.mode, "report");
    assert.equal(value.jobId, "");
    assert.equal(value.report.mode, "plan");
    assert.equal(value.report.targetKind, "cubeMx");
    assert.match(value.report.message, /还没动手/u);
    assert.equal(existsSync(join(root, "Repository")), false);
    assert.equal(existsSync(join(root, "dsh-firmware")), false);
    assert.match(value.report.targetDir, /dsh-firmware[\\/]STM32Cube_FW_F1_V1.8.7$/u);

    const needDecision = await definition.execute(
      { family: "STM32H743VIT6", cubeMxRoot: root },
      { signal: new AbortController().signal },
    );
    assert.equal(needDecision.report.ok, false);
    assert.match(needDecision.report.message, /目前只会/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
/* ---------------- setCustomFWPath / 固件包定位（docs §14 的修法） ---------------- */

/** 造一棵"像个固件包"的目录：CMSIS 内核头 + 一个带 Src 的 HAL 驱动。 */
function makePackage(root) {
  mkdirSync(join(root, "Drivers", "CMSIS", "Include"), { recursive: true });
  writeFileSync(join(root, "Drivers", "CMSIS", "Include", "core_cm3.h"), "x");
  mkdirSync(join(root, "Drivers", "STM32F1xx_HAL_Driver", "Src"), { recursive: true });
  writeFileSync(join(root, "Drivers", "STM32F1xx_HAL_Driver", "Src", "stm32f1xx_hal.c"), "x");
  return root;
}

test("buildGenerateScript：没找到包就不发 setCustomFWPath；找到就排在 config load 与 generate code 之间", () => {
  const plain = buildGenerateScript("C:/proj/a.ioc", "C:/proj/out", "coupled");
  assert.equal(plain.includes("setCustomFWPath"), false);
  assert.equal(plain.split("\n")[0], "config load C:/proj/a.ioc");

  const withFirmware = buildGenerateScript("C:/proj/a.ioc", "C:/proj/out", "coupled", "C:/Program Files/ST/dsh-firmware/STM32Cube_FW_F1_V1.8.8");
  const lines = withFirmware.split("\n");
  assert.equal(lines[0], "config load C:/proj/a.ioc");
  assert.equal(lines[1], 'project setCustomFWPath "C:/Program Files/ST/dsh-firmware/STM32Cube_FW_F1_V1.8.8"');
  assert.ok(lines.indexOf("project setCustomFWPath") < lines.findIndex((line) => line.startsWith("generate code")));
  assert.equal(withFirmware.includes("generate code C:/proj/out"), true);
});

test("parseGenerateLog：脚本命令不被认就当失败（不然会静默用错固件包还报成功）", () => {
  const ok = parseGenerateLog("Code succesfully generated under C:/out");
  assert.equal(ok.ok, true);

  const unknown = parseGenerateLog(["Error: Unknown command: setCustomFWPath", "Code succesfully generated under C:/out"].join("\n"));
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors[0], /Unknown command/u);
});

test("firmwareNeedFromIoc：认 ProjectManager.FirmwarePackage，缺了就按 Mcu.CPN 推默认版本", () => {
  const packaged = firmwareNeedFromIoc("Mcu.CPN=STM32F103C8Tx\nProjectManager.FirmwarePackage=STM32Cube FW_F1 V1.8.7\n");
  assert.equal(packaged.family, "F1");
  assert.equal(packaged.version, "1.8.7");
  assert.equal(packaged.packageName, "STM32Cube_FW_F1_V1.8.7");

  const fallback = firmwareNeedFromIoc("Mcu.CPN=STM32F103C8Tx\n");
  assert.equal(fallback.packageName, "STM32Cube_FW_F1_V1.8.7");

  const unknown = firmwareNeedFromIoc("Mcu.CPN=STM32G431CBTx\n");
  assert.equal(unknown.packageName, "");
  assert.equal(unknown.family, "");
});

test("locateFirmwarePackage：包名精确匹配优先；同版本优先官方仓库；两处都找", () => {
  const root = tempDir("locate");
  try {
    makePackage(join(root, "Repository", "STM32Cube_FW_F1_V1.8.7"));
    makePackage(join(dshFirmwareDir(root), "STM32Cube_FW_F1_V1.8.8"));
    // 不完整的目录不算（只解压了一半的包）
    mkdirSync(join(root, "Repository", "STM32Cube_FW_F1_V1.9.9"), { recursive: true });

    const wanted = locateFirmwarePackage([root], { packageName: "STM32Cube_FW_F1_V1.8.8", family: "F1" });
    assert.equal(wanted.found, true);
    assert.equal(wanted.source, "dsh-firmware");
    assert.match(wanted.dir, /dsh-firmware/u);

    const official = locateFirmwarePackage([root], { packageName: "STM32Cube_FW_F1_V1.8.7", family: "F1" });
    assert.equal(official.source, "repository");

    const missing = locateFirmwarePackage([join(root, "nope")], { packageName: "STM32Cube_FW_F1_V1.8.7" });
    assert.equal(missing.found, false);
    assert.ok(missing.checked.length >= 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("firmwareInstallPlan：默认落 dsh-firmware，target=cache 才落用户缓存，显式目录优先", () => {
  const root = cubeMxRoot("target");
  try {
    const env = { DSH_STM32_CACHE: join(root, "cache") };
    const auto = firmwareInstallPlan({ family: "F1", version: "1.8.8", cubeMxRoots: [root], env });
    assert.equal(auto.targetKind, "cubeMx");
    assert.match(auto.targetDir, /dsh-firmware/u);
    assert.equal(existsSync(join(root, "dsh-firmware")), false, "计划模式不许建目录");

    const cache = firmwareInstallPlan({ family: "F1", version: "1.8.8", cubeMxRoots: [root], target: "cache", env });
    assert.equal(cache.targetKind, "cache");
    assert.match(cache.notes.join("\n"), /setCustomFWPath/u);

    const custom = firmwareInstallPlan({ family: "F1", version: "1.8.8", cubeMxRoots: [root], targetDir: join(root, "mine"), env });
    assert.equal(custom.targetKind, "custom");
    assert.equal(custom.targetDir, join(root, "mine").replace(/\\/g, "/"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveFirmwareRoot：Repository 里没有时也要找到 <CubeMX>/dsh-firmware 下的包", () => {
  const root = tempDir("scaffold-fw");
  try {
    const pkg = join(root, "dsh-firmware", "STM32Cube_FW_F1_V1.8.8");
    makePackage(pkg);
    const gccDir = join(pkg, "Drivers", "CMSIS", "Device", "ST", "STM32F1xx", "Source", "Templates", "gcc");
    mkdirSync(gccDir, { recursive: true });
    writeFileSync(join(gccDir, "startup_stm32f103xb.s"), "x");

    const found = resolveFirmwareRoot([root], "STM32Cube_FW_F1_V1.8.8");
    assert.equal(found.root, pkg);
    assert.ok(found.checked.some((entry) => entry.includes("Repository")), "先找官方仓库");
    assert.ok(found.checked.some((entry) => entry.includes("dsh-firmware")), "再找 dsh-firmware");

    const missing = resolveFirmwareRoot([root], "STM32Cube_FW_F1_V9.9.9");
    assert.equal(missing.root, undefined);
    assert.ok(missing.checked.length >= 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isProtectedSystemDir：Program Files / Windows / ProgramData 算受保护，整块系统盘与用户目录不算", () => {
  const env = {
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    ProgramData: "C:\\ProgramData",
    SystemRoot: "C:\\Windows",
  };
  assert.equal(isProtectedSystemDir("C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeMX", env), true);
  assert.equal(isProtectedSystemDir("C:/Program Files", env), true);
  assert.equal(isProtectedSystemDir("C:/Windows/System32", env), true);
  assert.equal(isProtectedSystemDir("C:/ProgramData/ST", env), true);
  // 整块系统盘不算受保护：%TEMP% / %LOCALAPPDATA% 也都在 C: 上，算进来会误伤一切。
  assert.equal(isProtectedSystemDir("C:/", env), false);
  assert.equal(isProtectedSystemDir("D:/app/STM32CubeMX", env), false);
  assert.equal(isProtectedSystemDir("C:/Users/JingYu/STM32CubeMX", env), false);
  assert.equal(isProtectedSystemDir("", env), false);
});

test("orderCubeMxRoots：本机真存在的排前面（别让不存在的默认路径把落点带偏）", () => {
  const root = tempDir("order");
  try {
    const ghost = join(root, "no-such-cubemx");
    const ordered = orderCubeMxRoots(["  ", ghost, root]);
    assert.deepEqual(ordered, [root, ghost]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("firmwareInstallPlan：候选根里排在前面的不存在时，落点要选本机真有的那份 CubeMX", () => {
  const root = cubeMxRoot("pickexisting");
  try {
    const env = { DSH_STM32_CACHE: join(root, "cache") };
    const ghost = join(root, "no-such-cubemx");
    const plan = firmwareInstallPlan({ family: "F1", version: "1.8.8", cubeMxRoots: [ghost, root], env });
    assert.equal(plan.targetKind, "cubeMx");
    assert.equal(plan.targetDir, dshFirmwareDir(root) + "/STM32Cube_FW_F1_V1.8.8");
    assert.equal(existsSync(dshFirmwareDir(ghost)), false, "计划模式不许建目录");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("firmwareInstallPlan：根不存在、祖先又是受保护的系统目录时，不许假装可写（退回用户缓存）", () => {
  const root = tempDir("protected");
  const saved = process.env["ProgramFiles"];
  try {
    // 拿一个真实存在的临时目录冒充 Program Files：根 <它>/STMicroelectronics/STM32CubeMX 不存在，
    // 祖先正是"受保护目录"，plan 模式下必须判不可写，而不是一路 accessSync 报 ok。
    process.env["ProgramFiles"] = root;
    const env = { DSH_STM32_CACHE: join(root, "cache") };
    // 根自身存在、也像 CubeMX（有 STM32CubeMX.exe），这样才能验证"祖先受保护"这条判据本身。
    const ghostRoot = join(root, "STMicroelectronics", "STM32CubeMX");
    mkdirSync(ghostRoot, { recursive: true });
    writeFileSync(join(ghostRoot, "STM32CubeMX.exe"), "stub");
    const plan = firmwareInstallPlan({ family: "F1", version: "1.8.8", cubeMxRoots: [ghostRoot], env });
    assert.equal(plan.targetKind, "cache");
    assert.match(plan.notes.join("\n"), /dsh-firmware|写不进去|受保护/u);
  } finally {
    if (saved === undefined) delete process.env["ProgramFiles"];
    else process.env["ProgramFiles"] = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------- B10/B12：落点与 generate 的搜索要对齐 ------------------- */

test("locateFirmwarePackage：装到下载缓存里的包，靠 extraDirs 也要找得到（B10）", () => {
  const root = tempDir("locate-cache");
  try {
    // 模拟 stm32_firmware_install 的 cache 兜底：<cacheRoot>/firmware/<包名>
    const cacheFw = join(root, "cache", "firmware");
    const pkg = join(cacheFw, "STM32Cube_FW_F1_V1.8.7");
    makePackage(pkg);

    // 只搜 CubeMX 根：看不见（这正是审计里 generate 说"没找到"的那个洞）
    const blind = locateFirmwarePackage([join(root, "cubemx")], { packageName: "STM32Cube_FW_F1_V1.8.7" });
    assert.equal(blind.found, false);

    const seen = locateFirmwarePackage([join(root, "cubemx")], {
      packageName: "STM32Cube_FW_F1_V1.8.7",
      extraDirs: [{ dir: cacheFw, source: "cache" }],
    });
    assert.equal(seen.found, true);
    assert.equal(seen.source, "cache");
    assert.equal(seen.dir, pkg.split("\\").join("/"));

    // 显式 targetDir 是"包本身"，不是包的父目录，也要认
    const customPkg = join(root, "mine", "STM32Cube_FW_F1_V1.8.8");
    makePackage(customPkg);
    const custom = locateFirmwarePackage([], {
      packageName: "STM32Cube_FW_F1_V1.8.8",
      extraDirs: [{ dir: customPkg, source: "custom" }],
    });
    assert.equal(custom.found, true);
    assert.equal(custom.source, "custom");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installFirmware：cache 落点会记进 installed.json，generate 再靠记录找回来（B10）", async () => {
  const root = tempDir("install-record");
  const env = { DSH_STM32_CACHE: join(root, "cache") };
  try {
    const result = await installFirmware({
      family: "F1",
      version: "1.8.8",
      cubeMxRoots: [join(root, "no-cubemx")],
      mode: "install",
      env,
      fetchImpl: firmwareFetch(),
    });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.targetKind, "cache");
    // nextStep 按落点分档（A13）：落到缓存时必须说清"包不在 CubeMX 安装目录里"。
    assert.match(result.nextStep, /setCustomFWPath/u);
    assert.match(result.nextStep, /缓存/u);
    const records = readFirmwareInstallRecords(env);
    const mine = records.find((record) => record.packageName === "STM32Cube_FW_F1_V1.8.8");
    assert.ok(mine !== undefined, "装完必须留一条落点记录");
    assert.equal(mine.kind, "cache");
    assert.equal(mine.dir, result.targetDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("firmwareInstallPlan：候选根里没有 STM32CubeMX.exe 时不当它是 CubeMX（B12）", () => {
  const root = tempDir("fake-root");
  try {
    const env = { DSH_STM32_CACHE: join(root, "cache") };
    const fake = join(root, "empty-cubemx");
    mkdirSync(fake, { recursive: true });
    const plan = firmwareInstallPlan({ family: "F1", version: "1.8.8", cubeMxRoots: [fake], env });
    assert.equal(plan.targetKind, "cache", "不往没有 STM32CubeMX.exe 的假根里造包");
    assert.match(plan.notes.join("\n"), /STM32CubeMX\.exe/u);
    assert.equal(existsSync(join(fake, "dsh-firmware")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installFirmware：install 模式下祖先受保护时不建目录、不报 cubeMx（B12）", async () => {
  const root = tempDir("install-protected");
  const saved = process.env["ProgramFiles"];
  try {
    process.env["ProgramFiles"] = root;
    const ghostRoot = join(root, "Vendor", "STM32CubeMX");
    const result = await installFirmware({
      family: "F1",
      version: "1.8.8",
      cubeMxRoots: [ghostRoot],
      mode: "install",
      env: { DSH_STM32_CACHE: join(root, "cache") },
      fetchImpl: firmwareFetch(),
    });
    assert.notEqual(result.targetKind, "cubeMx");
    assert.notEqual(result.targetKind, "repository");
    assert.equal(existsSync(join(ghostRoot, "dsh-firmware")), false, "受保护祖先下不许 mkdir");
    assert.equal(result.targetKind, "cache");
  } finally {
    if (saved === undefined) delete process.env["ProgramFiles"];
    else process.env["ProgramFiles"] = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("extractTarGz：不是 gzip 的内容与空归档都判失败，不当作装好了（A32）", () => {
  const root = tempDir("tar-magic");
  try {
    const notGzip = extractTarGz(Buffer.from("<!doctype html><html>proxy</html>", "utf8"), join(root, "a"));
    assert.equal(notGzip.ok, false);
    assert.match(notGzip.error, /魔数|tar\.gz/u);
    assert.equal(existsSync(join(root, "a")), false, "魔数不对时一个文件都不许落盘");

    const empty = extractTarGz(gzipSync(Buffer.alloc(0)), join(root, "b"));
    assert.equal(empty.ok, false);
    assert.match(empty.error, /空归档/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installFirmware：暂存目录每次唯一，结束时不留残渣，老残留会被清掉（A11）", async () => {
  const root = tempDir("temp-clean");
  const target = join(root, "pkg");
  try {
    mkdirSync(target, { recursive: true });
    const stale = join(target, ".dsh-download-123-456");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "half.tgz"), "old", "utf8");
    const old = Date.now() / 1000 - 2 * 60 * 60;
    utimesSync(stale, old, old);

    const result = await installFirmware({
      family: "F1",
      targetDir: target,
      cubeMxRoots: [root],
      mode: "install",
      env: { DSH_STM32_CACHE: join(root, "cache") },
      fetchImpl: firmwareFetch(),
    });
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(
      readdirSync(target).filter((name) => name.startsWith(".dsh-download")),
      [],
      "结束时暂存目录不能留在包里",
    );
    assert.equal(existsSync(stale), false, "超过 1 小时的老残留要清掉");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
