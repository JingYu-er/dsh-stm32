// 为什么要有这个套件：固件包下载器会联网、会解 tar.gz、会往 CubeMX 仓库写目录。
// 坏掉的表现很难查：CubeMX 缺包时不报错（docs §14）、解包逻辑写错会把文件摊到错目录、
// 半截包被当成装好了。所以这里全部用注入的 fetchImpl + 临时目录，逐条钉住行为。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
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
import { FIRMWARE_ARCHIVE_PINS, FIRMWARE_CORE_PINS } from "../lib/data/firmware-pins.js";
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
import {
  crc32Of,
  downloadOfficialZip,
  firmwareLicenceTag,
  installViaSwmgr,
  parseAcceptedFirmwareLicences,
  officialFirmwareUrl,
  refNamePattern,
  resolveFwLibrary,
  verifyZipCrc,
} from "../lib/engine/firmware-official.js";
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
const FAKE_HAL_ARCHIVE = halArchive();
const FAKE_DEVICE_ARCHIVE = deviceArchive();

function sha256Of(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * 假 fetch 的字节不可能等于真实上游哈希，所以把 F1 的 pin 临时改成假包的哈希。
 * 计划类用例都在前面跑，这里只在第一个 install 用例之后生效；每个套件是独立进程。
 */
function pinFakeFirmware() {
  const spec = FIRMWARE_FAMILIES.F1;
  for (const archive of spec.archives) {
    const body = archive.repo.includes("hal-driver") ? FAKE_HAL_ARCHIVE : FAKE_DEVICE_ARCHIVE;
    FIRMWARE_ARCHIVE_PINS[archive.repo + "@" + archive.ref] = { sha256: sha256Of(body), bytes: body.length };
  }
  const core = Buffer.from(CORE_BODY, "utf8");
  for (const header of spec.coreHeaders) {
    FIRMWARE_CORE_PINS[spec.coreRepo + "@" + spec.coreRef + "/" + spec.coreIncludeDir + "/" + header] = {
      sha256: sha256Of(core),
      bytes: core.length,
    };
  }
}

/** 假 fetch：按 URL 里的仓库名给归档、按文件名给内核头，其它一律 404。 */
function firmwareFetch(options = {}) {
  pinFakeFirmware();
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (typeof options.handler === "function") return options.handler(url, calls);
    if (options.fail === true) return new Response("", { status: 404 });
    if (url.includes("stm32f1xx-hal-driver")) return new Response(FAKE_HAL_ARCHIVE, { status: 200 });
    if (url.includes("cmsis-device-f1")) return new Response(FAKE_DEVICE_ARCHIVE, { status: 200 });
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
  assert.equal(plan.archives.every((item) => item.urls.length === 1), true, "归档只走 codeload 单源");
  assert.match(plan.archives[0].urls[0], /^https:\/\/codeload\.github\.com\/STMicroelectronics\//u);
  assert.equal(plan.archives.every((item) => /^[0-9a-f]{64}$/u.test(item.sha256)), true, "每个归档都有 sha256");
  assert.equal(plan.coreTargets.length, 5);
  assert.equal(plan.coreTargets.every((target) => target.urls.length >= 2), true);
  assert.equal(plan.coreTargets.every((target) => /^[0-9a-f]{64}$/u.test(target.sha256)), true, "每个内核头都有 sha256");
  assert.equal(plan.halDir, "Drivers/STM32F1xx_HAL_Driver");

  const byMcu = firmwarePlanFor({ mcu: "STM32F103C8T6" });
  assert.equal(byMcu.ok, true);
  assert.equal(byMcu.dirName, plan.dirName);

  const v162 = firmwarePlanFor({ family: "F1", version: "1.6.2" });
  assert.equal(v162.dirName, "STM32Cube_FW_F1_V1.6.2");
  assert.equal(v162.patchTag, "FW.F1.1.6.2");
});

test("firmwarePlanFor：没接入的族、错的版本号都要说人话（不瞎猜）", () => {
  // H7 已经接入了（8 族装配扩完之后），拿真正没接入的 N6 当反例
  const n6 = firmwarePlanFor({ family: "STM32N645A0HxQ" });
  assert.equal(n6.ok, false);
  assert.match(n6.error, /目前只会/u);

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
    const unknown = verifyFirmwarePackage(root, "N6");
    assert.equal(unknown.ok, false);
    assert.match(unknown.missing.join("；"), /清单/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coreHeaders 按上游真实文件走：H7 要 cachel1_armv7.h，F7 没有这个文件", () => {
  // H7 实测：core_cm7.h:2234 include cachel1_armv7.h，漏了编译直接 fatal error。
  const h7 = FIRMWARE_FAMILIES.H7;
  assert.ok(h7.coreHeaders.includes("core_cm7.h"));
  assert.ok(h7.coreHeaders.includes("cachel1_armv7.h"));
  // F7 的 core_cm7.h 不 include cachel1，仓库里也没有这个文件（raw/jsDelivr 均 404）；
  // 照 H7 抄会多下一个 404，整个拼包装不上。
  const f7 = FIRMWARE_FAMILIES.F7;
  assert.ok(f7.coreHeaders.includes("core_cm7.h"));
  assert.equal(f7.coreHeaders.includes("cachel1_armv7.h"), false);
  // 非 CM7 族不要顺手加（多下一个用不上的头）
  assert.equal(FIRMWARE_FAMILIES.F1.coreHeaders.includes("cachel1_armv7.h"), false);
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
      { family: "STM32N645A0HxQ", cubeMxRoot: root },
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

/* ---------------------- 官网直取通道（firmware-official.js） ---------------------- */

function storedZip(entries) {
  // 只造 store（method 0）的小 zip：本套件要验的是 CRC/中央目录解析，不测压缩算法。
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const body = Buffer.from(data);
    const crc = crc32Of(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test("officialFirmwareUrl：db 的 FwLibrary 与 packageBase 都按官网命名规律拼，base 可覆盖", () => {
  assert.equal(officialFirmwareUrl("STM32Cube_FW_F1", "1.8.7"), "https://sw-center.st.com/packs/resource/firmware/stm32cube_fw_f1_v187.zip");
  assert.equal(officialFirmwareUrl("STM32Cube_FW_H7RS", "1.4.0"), "https://sw-center.st.com/packs/resource/firmware/stm32cube_fw_h7rs_v140.zip");
  assert.equal(officialFirmwareUrl("STM32Cube_FW_WL3", "1.2.0"), "https://sw-center.st.com/packs/resource/firmware/stm32cube_fw_wl3_v120.zip");
  const env = { DSH_STM32_FIRMWARE_BASE: "http://127.0.0.1:9/packs" };
  assert.equal(officialFirmwareUrl("STM32Cube_FW_F1", "1.8.7", env), "http://127.0.0.1:9/packs/stm32cube_fw_f1_v187.zip");
});

test("refNamePattern：db 的 RefName 簇写法要能匹配具体 CPN", () => {
  assert.equal(refNamePattern("STM32F103C(8-B)Tx").test("STM32F103C8T6"), true);
  assert.equal(refNamePattern("STM32F103C(8-B)Tx").test("STM32F103CBT6"), true);
  assert.equal(refNamePattern("STM32F103C(8-B)Tx").test("STM32F103C6T6"), false);
  assert.equal(refNamePattern("STM32H7R3A8Ix").test("STM32H7R3A8I6"), true);
  assert.equal(refNamePattern("STM32H7R3A8Ix").test("STM32H743VIT6"), false);
  // 元字符不许当正则用：中间带点的型号不能把 "." 当通配。
  assert.equal(refNamePattern("STM32X1.2x").test("STM32X1X2Y"), false);
});

test("resolveFwLibrary：H7RS 的子系列要拿到 STM32Cube_FW_H7RS，普通族回落到 packageBase", () => {
  const dbRoot = "D:/app/STM32CubeMX/db";
  if (!existsSync(join(dbRoot, "mcu"))) {
    // 本机没有 db 就只验回落，不假装验过真 db。
    assert.equal(resolveFwLibrary("", "STM32F103C8T6", "STM32Cube_FW_F1"), "STM32Cube_FW_F1");
    return;
  }
  assert.equal(resolveFwLibrary(dbRoot, "STM32F103C8T6", "STM32Cube_FW_F1"), "STM32Cube_FW_F1");
  assert.equal(resolveFwLibrary(dbRoot, "STM32H7R3A8I6", "STM32Cube_FW_H7"), "STM32Cube_FW_H7RS");
  assert.equal(resolveFwLibrary(dbRoot, "STM32H743VIT6", "STM32Cube_FW_H7"), "STM32Cube_FW_H7");
});

test("crc32Of：对齐 zip 用的 CRC-32 标准向量，且可分段续算", () => {
  assert.equal(crc32Of(Buffer.from("123456789", "utf8")), 0xcbf43926);
  const whole = crc32Of(Buffer.from("hello world", "utf8"));
  const part = crc32Of(Buffer.from(" world", "utf8"), crc32Of(Buffer.from("hello", "utf8")));
  assert.equal(part, whole);
});

test("verifyZipCrc：好 zip 逐条比过；改坏一个字节要指名道姓", () => {
  const dir = tempDir("crc");
  const good = join(dir, "good.zip");
  const zip = storedZip([
    ["package.xml", "<Package/>"],
    ["Drivers/CMSIS/Include/core_cm4.h", "int x;"],
  ]);
  writeFileSync(good, zip);
  const report = verifyZipCrc(good);
  assert.equal(report.ok, true, report.error);
  assert.equal(report.entries, 2);
  assert.equal(report.checked, 2);
  assert.deepEqual(report.mismatches, []);

  const bad = join(dir, "bad.zip");
  const broken = Buffer.from(zip);
  const at = broken.indexOf(Buffer.from("int x;", "utf8"));
  broken[at] = 0x6a; // "i" → "j"
  writeFileSync(bad, broken);
  const badReport = verifyZipCrc(bad);
  assert.equal(badReport.ok, false);
  assert.equal(badReport.mismatches.length, 1);
  assert.equal(badReport.mismatches[0].name, "Drivers/CMSIS/Include/core_cm4.h");
  rmSync(dir, { recursive: true, force: true });
});

test("downloadOfficialZip：Content-Length 对不上就删文件、判失败；对得上才算成", async () => {
  const dir = tempDir("dl");
  const zip = storedZip([["package.xml", "<Package/>"]]);
  const goodFetch = async () =>
    new Response(zip, { status: 200, headers: { "content-length": String(zip.length) } });
  const okFile = join(dir, "ok.zip");
  const ok = await downloadOfficialZip({ url: "http://x/a.zip", destFile: okFile, fetchImpl: goodFetch });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.bytes, zip.length);
  assert.equal(verifyZipCrc(okFile).ok, true);

  const shortFetch = async () =>
    new Response(zip, { status: 200, headers: { "content-length": String(zip.length + 10) } });
  const shortFile = join(dir, "short.zip");
  const short = await downloadOfficialZip({ url: "http://x/a.zip", destFile: shortFile, fetchImpl: shortFetch });
  assert.equal(short.ok, false);
  assert.match(short.error, /Content-Length/u);
  assert.equal(existsSync(shortFile), false, "半截文件必须删掉，否则后面 CRC 报出来的错看不懂");

  const missFetch = async () => new Response("<Error/>", { status: 404, statusText: "Not Found" });
  const miss = await downloadOfficialZip({ url: "http://x/none.zip", destFile: join(dir, "miss.zip"), fetchImpl: missFetch });
  assert.equal(miss.ok, false);
  assert.match(miss.error, /404/u);
  rmSync(dir, { recursive: true, force: true });
});

test("installFirmware：source=official 但没进程服务时明确拒绝，不静默换源、一次网络都不发", async () => {
  const root = cubeMxRoot("official");
  let calls = 0;
  const neverFetch = async () => {
    calls += 1;
    throw new Error("不该联网");
  };
  const result = await installFirmware({
    family: "F1",
    cubeMxRoots: [root],
    mode: "install",
    source: "official",
    env: { ...process.env, DSH_STM32_ASSETS: join(root, "assets") },
    fetchImpl: neverFetch,
  });
  assert.equal(result.ok, false);
  assert.equal(result.source, "official");
  assert.match(result.message, /官网直取没成功/u);
  assert.equal(calls, 0);
  rmSync(root, { recursive: true, force: true });
});

test("installFirmware：默认 auto 没有进程服务时回退 GitHub 拼包，报告里写明来源", async () => {
  const root = cubeMxRoot("auto");
  const result = await installFirmware({
    family: "F1",
    cubeMxRoots: [root],
    mode: "install",
    fetchImpl: firmwareFetch(),
  });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.source, "github");
  assert.equal(result.downloadUrl, "");
  assert.equal(result.steps.length, 5);
  assert.ok(result.notes.some((note) => /官网直取跳过/u.test(note)), "要说明为什么没走官网");
  rmSync(root, { recursive: true, force: true });
});

/* ---------------------- swmgr 交给 CubeMX（installViaSwmgr） ---------------------- */

function fakeSubprocess(onSpawn) {
  return {
    resolveExecutable: async (command) => command,
    spawn(spec) {
      if (onSpawn !== undefined) onSpawn(spec);
      return {
        done: Promise.resolve({ exitCode: 0, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: "swmgr install ...\nOK\n", lossy: false, nextOffset: 0 }) },
          stderr: { readFrom: () => ({ text: "", lossy: false, nextOffset: 0 }) },
        },
        terminate() {},
        waitForExit: async () => {},
      };
    },
  };
}

test("installViaSwmgr：脚本写成 swmgr install \"<正斜杠路径>\" ask；Repository 落盘才算成", async () => {
  const root = tempDir("swmgr");
  const work = join(root, "work");
  const zip = join(root, "dl", "STM32Cube_FW_C0_V1.4.0.zip");
  mkdirSync(join(root, "dl"), { recursive: true });
  writeFileSync(zip, "stub");
  let argvSeen = [];
  const subprocess = fakeSubprocess((spec) => {
    argvSeen = spec.argv;
    const landed = join(root, "Repository", "STM32Cube_FW_C0_V1.4.0");
    mkdirSync(landed, { recursive: true });
    writeFileSync(join(landed, "package.xml"), "<Package/>");
  });
  const result = await installViaSwmgr({
    subprocess,
    java: "java.exe",
    jar: "STM32CubeMX.exe",
    root,
    zipFile: zip,
    dirName: "STM32Cube_FW_C0_V1.4.0",
    workDir: work,
    timeoutMs: 30_000,
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.dir, join(root, "Repository", "STM32Cube_FW_C0_V1.4.0"));
  assert.equal(result.reused, false);
  assert.deepEqual(argvSeen.slice(0, 4), ["java.exe", "-Dfile.encoding=UTF-8", "-jar", "STM32CubeMX.exe"]);
  const script = readFileSync(join(work, "swmgr-STM32Cube_FW_C0_V1.4.0.txt"), "utf8");
  assert.equal(script, 'swmgr install "' + zip.split("\\").join("/") + '" ask\nexit\n');
  rmSync(root, { recursive: true, force: true });
});

test("installViaSwmgr：CubeMX 没把包装进 Repository 就判失败，并把日志尾巴带出来", async () => {
  const root = tempDir("swmgr-bad");
  const zip = join(root, "x.zip");
  writeFileSync(zip, "stub");
  const result = await installViaSwmgr({
    subprocess: fakeSubprocess(),
    java: "java.exe",
    jar: "STM32CubeMX.exe",
    root,
    zipFile: zip,
    dirName: "STM32Cube_FW_WBA_V1.7.0",
    workDir: join(root, "work"),
    timeoutMs: 30_000,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /没把包装进 Repository/u);
  assert.match(result.error, /OK/u, "日志末尾要能看出 CubeMX 说了什么");
  rmSync(root, { recursive: true, force: true });
});

test("installViaSwmgr：Repository 里本来就有这个包时判成功并标 reused（swmgr 会报 KO 已存在）", async () => {
  const root = tempDir("swmgr-reuse");
  const landed = join(root, "Repository", "STM32Cube_FW_WL3_V1.2.0");
  mkdirSync(landed, { recursive: true });
  writeFileSync(join(landed, "package.xml"), "<Package/>");
  const zip = join(root, "x.zip");
  writeFileSync(zip, "stub");
  const result = await installViaSwmgr({
    subprocess: fakeSubprocess(),
    java: "java.exe",
    jar: "STM32CubeMX.exe",
    root,
    zipFile: zip,
    dirName: "STM32Cube_FW_WL3_V1.2.0",
    workDir: join(root, "work"),
    timeoutMs: 30_000,
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.reused, true);
  rmSync(root, { recursive: true, force: true });
});

test("firmwareLicenceTag：按「族+版本」拼 FW.<族>.<版本>；非规范输入给空串", () => {
  assert.equal(firmwareLicenceTag("H5", "1.5.1"), "FW.H5.1.5.1");
  assert.equal(firmwareLicenceTag("C0", "V1.3.0"), "FW.C0.1.3.0");
  assert.equal(firmwareLicenceTag("STM32F4", "1.28.0"), "FW.F4.1.28.0");
  assert.equal(firmwareLicenceTag("", "1.5.1"), "");
  assert.equal(firmwareLicenceTag("H5", "1.5"), "");
});

test("parseAcceptedFirmwareLicences：从 CubeMX 日志里读已接受的许可清单（去重、忽略别的行）", () => {
  const log = [
    "2026-11-05 15:38:13,797 [INFO] AnalyticsPlugin:253 - Accepted Software Licenses: STM32CubeMX.6.13.0",
    "2026-11-05 15:38:13,806 [INFO] AnalyticsPlugin:257 - Accepted Firmware Licenses: FW.C0.1.3.0,FW.C0.1.4.0, FW.F4.1.28.0",
    "2026-11-05 15:39:00,000 [INFO] AnalyticsPlugin:257 - Accepted Firmware Licenses: FW.C0.1.3.0",
  ].join("\n");
  assert.deepEqual(parseAcceptedFirmwareLicences(log), ["FW.C0.1.3.0", "FW.C0.1.4.0", "FW.F4.1.28.0"]);
  assert.deepEqual(parseAcceptedFirmwareLicences("no licence line"), []);
});

test("installViaSwmgr：目标版本不在已接受清单里就判「首装要先点同意」，不再干等", async () => {
  const root = tempDir("swmgr-licence");
  const zip = join(root, "x.zip");
  writeFileSync(zip, "stub");
  const log = [
    "2026-11-05 15:38:13,806 [INFO] AnalyticsPlugin:257 - Accepted Firmware Licenses: FW.C0.1.3.0,FW.F4.1.28.0",
    'swmgr install "' + zip.split("\\").join("/") + '" ask',
    "",
  ].join("\n");
  const subprocess = {
    resolveExecutable: async (command) => command,
    spawn() {
      return {
        done: Promise.resolve({ exitCode: null, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: log, lossy: false, nextOffset: log.length }) },
          stderr: { readFrom: () => ({ text: "", lossy: false, nextOffset: 0 }) },
        },
        terminate() {},
        waitForExit: async () => {},
      };
    },
  };
  const result = await installViaSwmgr({
    subprocess,
    java: "java.exe",
    jar: "STM32CubeMX.exe",
    root,
    zipFile: zip,
    dirName: "STM32Cube_FW_H5_V1.5.1",
    family: "H5",
    version: "1.5.1",
    workDir: join(root, "work"),
    timeoutMs: 30_000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.missingLicence, "FW.H5.1.5.1");
  assert.deepEqual(result.acceptedLicences, ["FW.C0.1.3.0", "FW.F4.1.28.0"]);
  assert.match(result.error, /FW\.H5\.1\.5\.1/u);
  assert.match(result.error, /Manage embedded software packages/u);
  rmSync(root, { recursive: true, force: true });
});

test("installViaSwmgr：目标版本已在清单里就不写 missingLicence（照常按落盘判成败）", async () => {
  const root = tempDir("swmgr-licence-ok");
  const zip = join(root, "x.zip");
  writeFileSync(zip, "stub");
  const log = "2026-11-05 15:38:13,806 [INFO] AnalyticsPlugin:257 - Accepted Firmware Licenses: FW.C0.1.3.0\n";
  const subprocess = {
    resolveExecutable: async (command) => command,
    spawn() {
      return {
        done: Promise.resolve({ exitCode: null, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: log, lossy: false, nextOffset: log.length }) },
          stderr: { readFrom: () => ({ text: "", lossy: false, nextOffset: 0 }) },
        },
        terminate() {},
        waitForExit: async () => {},
      };
    },
  };
  const result = await installViaSwmgr({
    subprocess,
    java: "java.exe",
    jar: "STM32CubeMX.exe",
    root,
    zipFile: zip,
    dirName: "STM32Cube_FW_C0_V1.3.0",
    family: "C0",
    version: "1.3.0",
    workDir: join(root, "work"),
    timeoutMs: 30_000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.missingLicence, "");
  assert.match(result.error, /没把包装进 Repository/u);
  rmSync(root, { recursive: true, force: true });
});

test("installFirmware 官网直取成功：下载→CRC→swmgr→自检五步 done，source=official 不回退", async () => {
  const root = tempDir("official-ok");
  mkdirSync(join(root, "jre", "bin"), { recursive: true });
  writeFileSync(join(root, "jre", "bin", "java.exe"), "");
  writeFileSync(join(root, "STM32CubeMX.exe"), "");
  mkdirSync(join(root, "Repository"), { recursive: true });
  const cache = tempDir("official-ok-cache");
  const spec = FIRMWARE_FAMILIES.F1;
  const dirName = spec.packageBase + "_V" + spec.defaultVersion;
  // findRunningCubeMxGui 也会起一个进程（tasklist），所以只数真正跑 swmgr 脚本的那次。
  let spawned = 0;
  const subprocess = fakeSubprocess((spawnSpec) => {
    if (!spawnSpec.argv.some((arg) => arg.endsWith(".txt"))) return;
    spawned += 1;
    const dir = join(root, "Repository", dirName);
    mkdirSync(join(dir, "Drivers", "CMSIS", "Include"), { recursive: true });
    for (const header of spec.coreHeaders) writeFileSync(join(dir, "Drivers", "CMSIS", "Include", header), "");
    mkdirSync(join(dir, spec.halDir, "Inc"), { recursive: true });
    writeFileSync(join(dir, spec.halDir, "Inc", "hal.h"), "");
    mkdirSync(join(dir, spec.halDir, "Src"), { recursive: true });
    writeFileSync(join(dir, spec.halDir, "Src", "hal.c"), "");
    mkdirSync(join(dir, spec.deviceDir, "Include"), { recursive: true });
    writeFileSync(join(dir, spec.deviceDir, "Include", "device.h"), "");
    mkdirSync(join(dir, spec.deviceDir, "Source", "Templates", "gcc"), { recursive: true });
    writeFileSync(join(dir, spec.deviceDir, "Source", "Templates", "gcc", "startup_stm32f103xb.s"), "");
    writeFileSync(join(dir, "package.xml"), "<Package/>");
  });
  const zip = storedZip([["package.xml", "<Package/>"]]);
  const fetchImpl = async () =>
    new Response(zip, { status: 200, headers: { "content-length": String(zip.length) } });
  const env = { DSH_STM32_CACHE: cache };
  const result = await installFirmware({
    family: "F1",
    version: spec.defaultVersion,
    cubeMxRoots: [root],
    cubeMxRoot: root,
    target: "repository",
    mode: "install",
    env,
    subprocess,
    fetchImpl,
    source: "official",
  });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.source, "official");
  assert.equal(result.targetKind, "repository");
  assert.equal(result.downloadUrl, officialFirmwareUrl(spec.packageBase, spec.defaultVersion, env));
  assert.deepEqual(result.steps.map((step) => step.status), ["done", "done", "done", "done", "done"]);
  assert.equal(spawned, 1);
  rmSync(root, { recursive: true, force: true });
  rmSync(cache, { recursive: true, force: true });
});
