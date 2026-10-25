// L0 纯逻辑单测：X-CUBE 包目录快照 + .ioc 里的第三方包身份识别。
// 运行：node --test test/xcube-units.test.mjs（需先 npm run build）
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parsePdscFileNames, render } from "../scripts/gen-xcube-catalog.mjs";
import {
  XCUBE_CATALOG_FILE_COUNT,
  XCUBE_CATALOG_SOURCE,
  XCUBE_PACK_CATALOG,
} from "../lib/engine/xcube-catalog.js";
import {
  describePack,
  findCatalogPack,
  identifyPackId,
  listInstalledPacks,
  parsePdscNames,
  scanIocPacks,
  summarizePacks,
} from "../lib/engine/xcube.js";
import { needsThirdpartyPacks } from "../lib/engine/thirdparty.js";

/** 8110_foc.ioc 的真实片段（第 206/214/215/436-437/482 行原样）：Pin35 行在 ThirdParty0 之前。 */
const FOC_IOC = [
  "Mcu.Pin35=VP_STMicroelectronics.X-CUBE-ALGOBUILD_VS_DSPOoLibraryJjLibrary_1.4.0_1.4.0",
  "Mcu.ThirdParty0=STMicroelectronics.X-CUBE-ALGOBUILD.1.4.0",
  "Mcu.ThirdPartyNb=1",
  "STMicroelectronics.X-CUBE-ALGOBUILD.1.4.0.DSPOoLibraryJjLibrary_Checked=true",
  "STMicroelectronics.X-CUBE-ALGOBUILD.1.4.0.IPParameters=LibraryCcDSPOoLibraryJjDSPOoLibrary",
  "VP_STMicroelectronics.X-CUBE-ALGOBUILD_VS_DSPOoLibraryJjLibrary_1.4.0_1.4.0.Mode=DSPOoLibraryJjLibrary",
  "",
].join("\n");

const PDSC_NAMES = [
  "STMicroelectronics.X-CUBE-ALGOBUILD.1.4.0.pdsc",
  "STMicroelectronics.X-CUBE-ALGOBUILD.1.5.0.pdsc",
  "wolfSSL.I-CUBE-wolfMQTT.pdsc",
  "STMicroelectronics.X-CUBE-DPOWER.pdsc",
  "STMicroelectronics.X-CUBE-DPower.1.3.0.pdsc",
  "junk.txt",
  "noext",
];

/** 造一个假 pdsc 索引目录。 */
function fakePdsc(files) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-xcube-"));
  for (const name of files) writeFileSync(join(dir, name), "x", "utf8");
  return dir;
}

test("目录快照：条目够多、含 ALGOBUILD 1.4.0、无大小写重复、版本号是数字点号", () => {
  assert.ok(XCUBE_PACK_CATALOG.length >= 60, "快照条目应 >= 60，实际 " + String(XCUBE_PACK_CATALOG.length));
  assert.ok(XCUBE_CATALOG_FILE_COUNT >= XCUBE_PACK_CATALOG.length);
  assert.match(XCUBE_CATALOG_SOURCE, /pdsc/u);
  const algo = findCatalogPack("STMicroelectronics", "X-CUBE-ALGOBUILD");
  assert.ok(algo !== null, "目录里应有 STMicroelectronics.X-CUBE-ALGOBUILD");
  assert.ok(algo.versions.includes("1.4.0"), "版本里应有 1.4.0，实际 " + algo.versions.join(","));
  const seen = new Set();
  for (const entry of XCUBE_PACK_CATALOG) {
    const key = (entry.vendor + "." + entry.name).toLowerCase();
    assert.ok(!seen.has(key), "重复条目：" + key);
    seen.add(key);
    assert.ok(entry.name !== "" && entry.vendor !== "");
    for (const version of entry.versions) assert.match(version, /^[0-9]+(?:\.[0-9]+)*$/u);
  }
});

test("findCatalogPack：大小写不敏感，找不到返回 null", () => {
  assert.ok(findCatalogPack("stmicroelectronics", "x-cube-algobuild") !== null);
  assert.equal(findCatalogPack("STMicroelectronics", "X-CUBE-NOT-A-REAL-PACK"), null);
});

test("parsePdscNames 与生成脚本的 parsePdscFileNames 解析一致", () => {
  const fromLib = parsePdscNames(PDSC_NAMES);
  const fromScript = parsePdscFileNames(PDSC_NAMES);
  const shape = (list) =>
    list.map((e) => (e.vendor + "." + e.name).toLowerCase() + "@" + e.versions.slice().sort().join(","));
  assert.deepEqual(shape(fromLib), shape(fromScript));
  // 结尾连续的数字段要整段剥掉，只剥最后一段会得到 ...ALGOBUILD.1.4
  const algo = fromLib.find((e) => e.name === "X-CUBE-ALGOBUILD");
  assert.ok(algo !== undefined);
  assert.deepEqual(algo.versions.slice().sort(), ["1.4.0", "1.5.0"]);
  // 无版本号的索引也要收进来，并与带版本的同名包合并
  const dpower = fromLib.filter((e) => e.name.toLowerCase() === "x-cube-dpower");
  assert.equal(dpower.length, 1);
  assert.deepEqual(dpower[0].versions, ["1.3.0"]);
  assert.equal(fromLib.some((e) => e.vendor === "wolfSSL" && e.name === "I-CUBE-wolfMQTT"), true);
});

test("identifyPackId：目录命中（带版本 / 不带版本）", () => {
  assert.deepEqual(identifyPackId("STMicroelectronics.X-CUBE-ALGOBUILD.1.4.0"), {
    vendor: "STMicroelectronics",
    name: "X-CUBE-ALGOBUILD",
    version: "1.4.0",
  });
  assert.deepEqual(identifyPackId("STMicroelectronics.X-CUBE-ALGOBUILD"), {
    vendor: "STMicroelectronics",
    name: "X-CUBE-ALGOBUILD",
    version: null,
  });
});

test("identifyPackId：目录里没有的包走通用拆法，认不出来返回 null", () => {
  assert.deepEqual(identifyPackId("Acme.Custom-Pack.2.1"), {
    vendor: "Acme",
    name: "Custom-Pack",
    version: "2.1",
  });
  assert.equal(identifyPackId("onlyone"), null);
  assert.equal(identifyPackId("A."), null);
  assert.equal(identifyPackId("has space"), null);
  assert.equal(identifyPackId(""), null);
});

test("scanIocPacks：8110_foc 片段 → nb=1、一个包、版本由 ThirdParty0 补全", () => {
  const scan = scanIocPacks(FOC_IOC);
  assert.equal(scan.thirdPartyNb, 1);
  assert.equal(scan.nbLine, "Mcu.ThirdPartyNb=1");
  assert.equal(scan.packs.length, 1);
  const pack = scan.packs[0];
  assert.equal(pack.vendor, "STMicroelectronics");
  assert.equal(pack.name, "X-CUBE-ALGOBUILD");
  assert.equal(pack.requestedVersion, "1.4.0");
  assert.equal(pack.installed, "unknown");
  assert.deepEqual(pack.installedVersions, []);
  // 证据优先留 Mcu.ThirdParty<k> 声明行（而不是先出现的 VP_ 行）
  assert.equal(pack.raw, "Mcu.ThirdParty0=STMicroelectronics.X-CUBE-ALGOBUILD.1.4.0");
  assert.equal(scan.markers.length, 0);
  assert.equal(scan.malformed.length, 0);
  assert.equal(describePack(pack), "STMicroelectronics.X-CUBE-ALGOBUILD 1.4.0");
});

test("scanIocPacks：安装情况 exact / other-version / missing", () => {
  const at = (versions) => scanIocPacks(FOC_IOC, { installed: [{ vendor: "STMicroelectronics", name: "X-CUBE-ALGOBUILD", versions }] });
  const exact = at(["1.4.0"]);
  assert.equal(exact.packs[0].installed, "exact");
  assert.deepEqual(exact.packs[0].installedVersions, ["1.4.0"]);
  const other = at(["1.5.0"]);
  assert.equal(other.packs[0].installed, "other-version");
  assert.deepEqual(other.packs[0].installedVersions, ["1.5.0"]);
  assert.equal(at([]).packs[0].installed, "missing");
});

test("scanIocPacks：nb=0 + 裸包名 → 进 markers；解析不了的 ThirdParty 行 → 进 malformed", () => {
  const markers = scanIocPacks("Mcu.ThirdPartyNb=0\nProjectManager.ProjectName=X-CUBE-AI-demo\n");
  assert.equal(markers.thirdPartyNb, 0);
  assert.equal(markers.nbLine, null);
  assert.equal(markers.packs.length, 0);
  // markers 存整行（进证据用），不是包名
  assert.equal(markers.markers.length, 1);
  assert.match(markers.markers[0], /X-CUBE-AI/u);
  const bad = scanIocPacks("Mcu.ThirdParty0=\n");
  assert.equal(bad.malformed.length, 1);
});

test("listInstalledPacks：读得到就解析，读不到返回 null", () => {
  const dir = fakePdsc(PDSC_NAMES);
  const packs = listInstalledPacks(dir);
  assert.ok(packs !== null);
  assert.equal(packs.length, 3);
  assert.ok(packs.some((p) => p.name === "X-CUBE-ALGOBUILD"));
  assert.equal(listInstalledPacks(join(dir, "no-such-dir")), null);
});

test("summarizePacks：最多列 3 个，超出说明还有几个", () => {
  const make = (name) => ({ raw: name, vendor: "V", name, requestedVersion: null, installed: "unknown", installedVersions: [] });
  assert.equal(summarizePacks([make("A")]), "V.A");
  assert.equal(summarizePacks([make("A"), make("B"), make("C")]), "V.A、V.B、V.C");
  assert.equal(summarizePacks([make("A"), make("B"), make("C"), make("D"), make("E")]), "V.A、V.B、V.C 等 5 个");
});

test("needsThirdpartyPacks + pdscDir：本机有该版本 → 无警告，包信息带到判定里", () => {
  const dir = fakePdsc(["STMicroelectronics.X-CUBE-ALGOBUILD.1.4.0.pdsc"]);
  const d = needsThirdpartyPacks(FOC_IOC, { pdscDir: dir });
  assert.equal(d.needed, true);
  assert.match(d.reason, /1 个第三方包/u);
  assert.match(d.reason, /STMicroelectronics\.X-CUBE-ALGOBUILD 1\.4\.0/u);
  assert.deepEqual(d.warnings, []);
  assert.equal(d.packs.length, 1);
  assert.equal(d.packs[0].installed, "exact");
});

test("needsThirdpartyPacks + pdscDir：缺包 / 版本不符 → 提前给警告", () => {
  const missing = needsThirdpartyPacks(FOC_IOC, { pdscDir: fakePdsc(["wolfSSL.I-CUBE-wolfMQTT.pdsc"]) });
  assert.equal(missing.warnings.length, 1);
  assert.match(missing.warnings[0], /没有这个包/u);
  assert.match(missing.warnings[0], /X-CUBE-ALGOBUILD/u);
  const other = needsThirdpartyPacks(FOC_IOC, { pdscDir: fakePdsc(["STMicroelectronics.X-CUBE-ALGOBUILD.1.5.0.pdsc"]) });
  assert.equal(other.warnings.length, 1);
  assert.match(other.warnings[0], /只有 1\.5\.0/u);
  assert.equal(other.packs[0].installed, "other-version");
});

test("needsThirdpartyPacks + pdscDir：索引目录读不到 → 警告而不是静默", () => {
  const d = needsThirdpartyPacks(FOC_IOC, { pdscDir: join(tmpdir(), "dsh-xcube-does-not-exist") });
  assert.equal(d.warnings.length, 1);
  assert.match(d.warnings[0], /读不到本机第三方包索引目录/u);
});

test("needsThirdpartyPacks：纯 HAL 工程（nb=0、无包证据）→ 不需要索引，也不给警告", () => {
  const d = needsThirdpartyPacks("Mcu.CPN=STM32F103C8T6\nMcu.ThirdPartyNb=0\nMcu.IPNb=3\n", {
    pdscDir: fakePdsc(["STMicroelectronics.X-CUBE-ALGOBUILD.1.4.0.pdsc"]),
  });
  assert.equal(d.needed, false);
  assert.deepEqual(d.packs, []);
  assert.deepEqual(d.warnings, []);
  assert.deepEqual(d.evidence, []);
});

test("生成脚本重跑不会把条目数写死回 159（审计 A23）", () => {
  const packs = parsePdscFileNames([
    "STMicroelectronics.X-CUBE-ALGOBUILD.1.4.0.pdsc",
    "STMicroelectronics.X-CUBE-ALGOBUILD.1.5.0.pdsc",
    "wolfSSL.I-CUBE-wolfMQTT.pdsc",
  ]);
  const text = render(packs, "CubeMX 包索引 ~/.stm32cubemx/thirdparties/pdsc（3 个 .pdsc）", "2026-01-01T00:00:00.000Z", 3);
  assert.match(text, /XCUBE_CATALOG_ENTRY_COUNT = XCUBE_PACK_CATALOG\.length;/u);
  assert.equal(/XCUBE_CATALOG_ENTRY_COUNT = [0-9]+/u.test(text), false, "条目数必须由数组派生");
  assert.ok(
    text.indexOf("export const XCUBE_CATALOG_ENTRY_COUNT") > text.indexOf("export const XCUBE_PACK_CATALOG"),
    "常量要放在数组之后，否则运行时报未定义",
  );
  assert.match(text, /XCUBE_CATALOG_FILE_COUNT = 3;/u);
  assert.match(text, /归并成 /u);
});
