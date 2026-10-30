// SVD 单测（L1 寄存器表）：node --test test/svd-units.test.mjs
// 覆盖：四种写法互转（GPIOC.ODR / GPIOC->ODR / RCC.CR / 0x4001100C）、未知外设/寄存器/地址、
// 位域解码（含多位置段与未解释位）、按地址反查、line 缺失/装错文件的提示、缓存命中与失效。
// 夹具是一条迷你 SVD（test/fixtures/svd/**），不是真实资源包——真资源包在开发机上不一定装了，
// 真实数据的一致性是 build-assets 脚本那边的事（这里只验解析/查找/解释逻辑）。
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  SVD_FULL_PROFILE_HINT,
  SvdError,
  decodeRegisterValue,
  describeAddress,
  formatAddress,
  formatDecodedFields,
  formatOffset,
  formatRegisterRef,
  loadSvd,
  loadSvdForLine,
  parseAddressText,
  parseSvd,
  requireSvd,
  resetSvdCache,
  resolveRegisterRef,
  svdCacheStats,
  svdLineForChip,
} from "../lib/data/svd.js";

import { FIXTURES, FIXTURE_ASSETS, FIXTURE_PROJECT, fakeBinDirs } from "./fixtures.mjs";

import { debugSessions } from "../lib/engine/debug-session.js";
import { ensureSession } from "../lib/engine/probe-session.js";
import {
  REG_DUMP_MAX,
  REGS_SUGGEST_PERIPHERALS,
  decorateSamples,
  describeRegSample,
  formatBits,
  planRegReads,
  registerRegsRead,
  resolveProjectSvd,
} from "../lib/tools/regs.js";

/** 未分版本布局：<root>/device/f1/svd/103.json 直接可读。 */
const SVD_FLAT = join(FIXTURES, "svd", "flat");
/** 已安装版本布局：<root>/<version>/device/f1/svd/103.json（带 install.json）。 */
const SVD_VERSIONED = join(FIXTURES, "svd", "versioned");
/** 坏夹具：999.json 里写的却是 line=103（装错文件）。 */
const SVD_BADLINE = join(FIXTURES, "svd", "badline");
/** 指向一个不存在的根：模拟"资源包没装"。 */
const SVD_NOWHERE = join(FIXTURES, "svd", "definitely-not-installed");

const flatEnv = { DSH_STM32_ASSETS: SVD_FLAT };
const versionedEnv = { DSH_STM32_ASSETS: SVD_VERSIONED };
const badlineEnv = { DSH_STM32_ASSETS: SVD_BADLINE };
const nowhereEnv = { DSH_STM32_ASSETS: SVD_NOWHERE };
/** 现有夹具资源包：只有 core profile、没有 svd 目录（验证"只装了 core"的提示）。 */
const coreEnv = { DSH_STM32_ASSETS: FIXTURE_ASSETS };

const LINE = "103";

function resolve(ref, env = flatEnv) {
  return resolveRegisterRef(ref, LINE, env);
}

function errorOf(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail("本来该抛 SvdError，结果没抛");
}

test("GPIOC.ODR → 0x4001100C（base 0x40011000 + offset 0x0C，16 个单bit 位域）", () => {
  const resolved = resolve("GPIOC.ODR");
  assert.equal(resolved.address, 0x4001100c);
  assert.equal(resolved.addressHex, "0x4001100C");
  assert.equal(resolved.peripheral, "GPIOC");
  assert.equal(resolved.register, "ODR");
  assert.equal(resolved.baseAddress, 0x40011000);
  assert.equal(resolved.addressOffset, 0x0c);
  assert.equal(resolved.offsetHex, "0xC");
  assert.equal(resolved.size, 32);
  assert.equal(resolved.fields.length, 16);
  assert.equal(resolved.fields[0]?.name, "ODR0");
  assert.equal(resolved.fields[15]?.name, "ODR15");
  assert.equal(formatRegisterRef(resolved), "GPIOC.ODR");
  assert.equal(resolved.ref, "GPIOC.ODR");
});

test("三种名字写法等价：GPIOC.ODR / GPIOC->ODR / 大小写+空格的 gpioc . odr", () => {
  const dotted = resolve("GPIOC.ODR");
  const arrow = resolve("GPIOC->ODR");
  const sloppy = resolve("  gpioc . odr  ");
  for (const other of [arrow, sloppy]) {
    assert.equal(other.address, dotted.address);
    assert.equal(other.ref, "GPIOC.ODR", "回显一律规范化成 GPIOC.ODR");
    assert.equal(other.register, "ODR");
    assert.equal(other.fields.length, 16);
  }
  assert.equal(resolve("USART1->DR").register, "DR", "带数字的外设名也要认");
});

test("RCC.CR → 0x40021000（offset 0x00），RCC.CFGR → 0x40021004", () => {
  const cr = resolve("RCC.CR");
  assert.equal(cr.address, 0x40021000);
  assert.equal(cr.addressOffset, 0x00);
  assert.equal(cr.fields.length, 10);
  assert.deepEqual(cr.fields.map((field) => field.name).slice(0, 3), ["HSION", "HSIRDY", "HSITRIM"]);
  assert.equal(resolve("RCC.CFGR").address, 0x40021004);
  assert.equal(resolve("RCC.APB2RSTR").fields.length, 0, "空字段表也是合法寄存器");
});

test("地址写法互转：0x4001100C / 4001100C / 0X4001100c → GPIOC.ODR", () => {
  assert.equal(resolve("0x4001100C").ref, "GPIOC.ODR");
  assert.equal(resolve("4001100C").ref, "GPIOC.ODR");
  assert.equal(resolve(" 0X4001100c ").ref, "GPIOC.ODR");
  assert.equal(resolve("0x40021004").ref, "RCC.CFGR");
  const viaAddress = resolve("0x4001100C");
  const viaName = resolve("GPIOC.ODR");
  assert.equal(viaAddress.address, viaName.address);
  assert.equal(viaAddress.addressHex, viaName.addressHex);
  assert.deepEqual(viaAddress.fields, viaName.fields);
});

test("未知外设：报错 + 列出已知外设（不静默返回空）", () => {
  const error = errorOf(() => resolve("GPIOZ.ODR"));
  assert.equal(error instanceof SvdError, true);
  assert.equal(error.code, "peripheral-unknown");
  assert.match(error.message, /没有外设 GPIOZ/u);
  assert.match(error.message, /已知外设：.*GPIOC/u);
  assert.equal(error.line, LINE);
});

test("未知寄存器：报错 + 列出该外设已知寄存器", () => {
  const error = errorOf(() => resolve("GPIOC.XYZ"));
  assert.equal(error instanceof SvdError, true);
  assert.equal(error.code, "register-unknown");
  assert.match(error.message, /没有寄存器 XYZ/u);
  assert.match(error.message, /已知寄存器：CRL、CRH、IDR、ODR/u);
});

test("非法写法：空串 / 没有分隔符 / 0xZZ → ref-invalid，且提示四种写法", () => {
  for (const bad of ["", "GPIOC", "GPIOC.ODR.X", "0xZZ"]) {
    const error = errorOf(() => resolve(bad));
    assert.equal(error instanceof SvdError, true, "输入 " + JSON.stringify(bad) + " 该报 SvdError");
    assert.equal(error.code, "ref-invalid", "输入 " + JSON.stringify(bad) + " 该是 ref-invalid");
  }
  assert.match(errorOf(() => resolve("GPIOC")).message, /GPIOC\.ODR、GPIOC->ODR、RCC\.CR、0x4001100C/u);
});

test("地址落在寄存器内部：0x40021002 明确说它属于 RCC.CR，而不是「不认识」", () => {
  const error = errorOf(() => resolve("0x40021002"));
  assert.equal(error.code, "register-unknown");
  assert.match(error.message, /落在 RCC\.CR/u);
  assert.match(error.message, /起点 0x40021000/u);
});

test("SVD 没覆盖的地址：address-unknown，并说明裸地址读仍可用", () => {
  const error = errorOf(() => resolve("0xE000ED00"));
  assert.equal(error.code, "address-unknown");
  assert.match(error.message, /没有寄存器覆盖地址 0xE000ED00/u);
  assert.match(error.message, /裸地址读仍然可以/u);
});

test("describeAddress 反查：精确命中 / 落在内部 / 未覆盖返回 null", () => {
  const exact = describeAddress(0x4001100c, LINE, flatEnv);
  assert.notEqual(exact, null);
  assert.equal(exact.ref, "GPIOC.ODR");
  assert.equal(exact.exact, true);
  assert.equal(exact.offsetInRegister, 0);
  assert.equal(exact.addressHex, "0x4001100C");
  const inside = describeAddress("0x4001100E", LINE, flatEnv);
  assert.equal(inside.ref, "GPIOC.ODR");
  assert.equal(inside.exact, false);
  assert.equal(inside.offsetInRegister, 2);
  assert.equal(describeAddress(0x40021000, LINE, flatEnv).register, "CR");
  assert.equal(describeAddress(0xe000ed00, LINE, flatEnv), null, "没覆盖就是 null，不当错误");
  const bad = errorOf(() => describeAddress("0xZZ", LINE, flatEnv));
  assert.equal(bad.code, "ref-invalid");
});

test("位域解码：0x00000005 → ODR0=1、ODR2=1，其余 14 个字段为 0", () => {
  const decoded = decodeRegisterValue(resolve("GPIOC.ODR"), "0x00000005");
  assert.equal(decoded.register, "ODR");
  assert.equal(decoded.value, 5);
  assert.equal(decoded.valueHex, "0x00000005");
  assert.deepEqual(decoded.set.map((field) => field.name), ["ODR0", "ODR2"]);
  assert.deepEqual(decoded.set.map((field) => field.value), [1, 1]);
  assert.equal(decoded.clear.length, 14);
  assert.equal(decoded.uncovered, 0);
  assert.deepEqual(decoded.uncoveredBits, []);
  assert.equal(formatDecodedFields(decoded), "ODR0=1、ODR2=1");
});

test("位域解码：多位置段按 bitOffset 右移（CFGR 的 SW=2、PLLMUL=7）", () => {
  const decoded = decodeRegisterValue(resolve("RCC.CFGR"), 0x001c0002);
  const sw = decoded.fields.find((field) => field.name === "SW");
  const pllmul = decoded.fields.find((field) => field.name === "PLLMUL");
  assert.equal(sw.value, 2);
  assert.equal(sw.mask, 0x00000003);
  assert.equal(pllmul.value, 7);
  assert.equal(pllmul.mask, 0x003c0000);
  assert.equal(decoded.uncovered, 0, "CFGR 的 SW/PLLMUL 都被字段解释掉了");
  const brr = decodeRegisterValue(resolve("USART1.BRR"), 0x4b5);
  assert.equal(brr.fields.find((field) => field.name === "DIV_Mantissa").value, 0x4b);
  assert.equal(brr.fields.find((field) => field.name === "DIV_Fraction").value, 5);
});

test("位域解码：没被任何位域解释的位要单独报出来（0x00000005 在 RCC.CR 里 bit2 没人管）", () => {
  const decoded = decodeRegisterValue(resolve("RCC.CR"), "0x00000005");
  assert.deepEqual(decoded.set.map((field) => field.name), ["HSION"]);
  assert.equal(decoded.uncovered, 0x00000004);
  assert.deepEqual(decoded.uncoveredBits, [2]);
  assert.match(formatDecodedFields(decoded), /HSION=1/u);
  assert.match(formatDecodedFields(decoded), /不属于任何位域/u);
  assert.match(formatDecodedFields(decoded), /第 2 位/u);
  const allClear = decodeRegisterValue(resolve("GPIOC.BSRR"), 0);
  assert.equal(allClear.fields.length, 0);
  assert.equal(formatDecodedFields(allClear), "没有置位的位域");
});

test("位域解码：值为 0 / 非法值", () => {
  const zero = decodeRegisterValue(resolve("RCC.CR"), "0x00000000");
  assert.deepEqual(zero.set, []);
  assert.equal(zero.clear.length, 10);
  assert.equal(zero.uncovered, 0);
  const bad = errorOf(() => decodeRegisterValue(resolve("RCC.CR"), "zzz"));
  assert.equal(bad.code, "value-invalid");
  assert.equal(errorOf(() => decodeRegisterValue(resolve("RCC.CR"), -1)).code, "value-invalid");
});

test("加载：未分版本布局（DSH_STM32_ASSETS 直接指到根）", () => {
  resetSvdCache();
  const loaded = loadSvd(LINE, flatEnv);
  assert.equal(loaded.failure, null);
  assert.equal(loaded.device.line, "103");
  assert.equal(loaded.device.device, "STM32F103xx");
  assert.equal(loaded.device.family, "STM32F1");
  assert.equal(loaded.device.version, "");
  assert.equal(loaded.device.counts.peripherals, 5);
  assert.equal(loaded.device.counts.registers, 21);
  assert.deepEqual(loaded.device.peripheralNames, ["GPIOA", "GPIOC", "RCC", "USART1", "TIM2"]);
  assert.equal(loadSvdForLine(LINE, flatEnv).line, "103");
});

test("加载：已安装版本布局（install.json 里的版本号带出来）", () => {
  resetSvdCache();
  const device = loadSvdForLine(LINE, versionedEnv);
  assert.equal(device.line, "103");
  assert.equal(device.version, "2026.10.31-1");
  assert.equal(device.path.includes(join("2026.10.31-1", "device", "f1", "svd")), true);
});

test("缺失：资源包没装 → assets-missing，文案含 stm32_assets refresh --profile full", () => {
  resetSvdCache();
  const loaded = loadSvd(LINE, nowhereEnv);
  assert.equal(loaded.device, null);
  assert.equal(loaded.failure.code, "assets-missing");
  assert.match(loaded.failure.message, /stm32_assets refresh --profile full/u);
  assert.match(loaded.failure.hint, /stm32_assets refresh --profile full/u);
  assert.equal(loaded.failure.line, LINE);
  assert.equal(loadSvdForLine(LINE, nowhereEnv), null);
  const thrown = errorOf(() => requireSvd(LINE, nowhereEnv));
  assert.equal(thrown instanceof SvdError, true);
  assert.match(thrown.message, /stm32_assets refresh --profile full/u);
});

test("缺失：只装了 core profile 的资源包 → 明说「只装了 profile=core」并让人 refresh full", () => {
  resetSvdCache();
  const loaded = loadSvd(LINE, coreEnv);
  assert.equal(loaded.device, null);
  assert.equal(loaded.failure.code, "svd-missing");
  assert.match(loaded.failure.message, /profile=core/u);
  assert.match(loaded.failure.message, /stm32_assets refresh --profile full/u);
  assert.match(loaded.failure.message, /device\/f1\/svd\/103\.json/u);
});

test("缺失：这个 line 没有 SVD（资源包在，文件不在）", () => {
  resetSvdCache();
  const loaded = loadSvd("105", flatEnv);
  assert.equal(loaded.device, null);
  assert.equal(loaded.failure.code, "svd-missing");
  assert.match(loaded.failure.message, /没有 device\/f1\/svd\/105\.json/u);
  assert.match(loaded.failure.message, /stm32_assets refresh --profile full/u);
});

test("line 非法：不是三位数字 → line-invalid（不瞎猜成 103）", () => {
  for (const bad of ["", "13", "1055", "abc"]) {
    const loaded = loadSvd(bad, flatEnv);
    assert.equal(loaded.device, null, "line=" + JSON.stringify(bad) + " 该失败");
    assert.equal(loaded.failure.code, "line-invalid", "line=" + JSON.stringify(bad) + " 该是 line-invalid");
  }
  assert.match(loadSvd("13", flatEnv).failure.message, /三位数字/u);
});

test("装错文件：999.json 里写着 line=103 → svd-invalid，绝不拿 103 的表解释 999", () => {
  resetSvdCache();
  const loaded = loadSvd("999", badlineEnv);
  assert.equal(loaded.device, null);
  assert.equal(loaded.failure.code, "svd-invalid");
  assert.match(loaded.failure.message, /不一致/u);
  assert.match(loaded.failure.message, /装错文件比没装更危险/u);
});

test("缓存：同一份文件第二次不再读盘（reads 不涨、hits 涨）", () => {
  resetSvdCache();
  const first = loadSvdForLine(LINE, flatEnv);
  assert.notEqual(first, null);
  const afterFirst = svdCacheStats();
  assert.equal(afterFirst.reads, 1);
  assert.equal(afterFirst.hits, 0);
  const second = loadSvdForLine(LINE, flatEnv);
  assert.notEqual(second, null);
  const afterSecond = svdCacheStats();
  assert.equal(afterSecond.reads, 1, "第二次不该再读盘");
  assert.equal(afterSecond.hits, 1);
  assert.equal(afterSecond.entries, 1);
});

test("缓存失效：文件 size/mtime 变了要重读（资源包升级不能读到旧表）", () => {
  resetSvdCache();
  const dir = mkdtempSync(join(tmpdir(), "dsh-svd-cache-"));
  try {
    const svdDir = join(dir, "device", "f1", "svd");
    mkdirSync(svdDir, { recursive: true });
    const target = join(svdDir, "103.json");
    const source = readFileSync(join(SVD_FLAT, "device", "f1", "svd", "103.json"), "utf8");
    writeFileSync(target, source);
    const env = { DSH_STM32_ASSETS: dir };
    assert.equal(loadSvdForLine(LINE, env).device, "STM32F103xx");
    assert.equal(svdCacheStats().reads, 1);
    writeFileSync(target, source.replace('"device": "STM32F103xx"', '"device": "STM32F103RE"') + "\n");
    const reloaded = loadSvdForLine(LINE, env);
    assert.equal(reloaded.device, "STM32F103RE", "改了文件就该重新解析");
    assert.equal(svdCacheStats().reads, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseSvd：坏数据一律拒绝（非 JSON / 缺 peripherals / 字段越界）", () => {
  assert.match(parseSvd("{not json", "x.json").error, /不是合法 JSON/u);
  assert.match(parseSvd(JSON.stringify({ line: "103" }), "x.json").error, /缺 peripherals/u);
  assert.match(parseSvd(JSON.stringify({ line: "103", peripherals: [] }), "x.json").error, /peripherals 数组或为空/u);
  const tooWide = {
    line: "103",
    peripherals: [{ name: "A", baseAddress: "0x0", registers: [{ name: "R", addressOffset: "0x0", size: 32, fields: [{ name: "F", bitOffset: 30, bitWidth: 4 }] }] }],
  };
  assert.match(parseSvd(JSON.stringify(tooWide), "x.json").error, /越界/u);
  const badOffset = {
    line: "103",
    peripherals: [{ name: "A", baseAddress: "0x0", registers: [{ name: "R", addressOffset: "0x0", size: 32, fields: [{ name: "F", bitOffset: 99, bitWidth: 1 }] }] }],
  };
  assert.match(parseSvd(JSON.stringify(badOffset), "x.json").error, /bitOffset 不合法/u);
  const good = parseSvd(readFileSync(join(SVD_FLAT, "device", "f1", "svd", "103.json"), "utf8"), "103.json", "v1", "103");
  assert.equal(good.error, "");
  assert.equal(good.device.counts.fields, 117);
});

test("svdLineForChip：芯片型号 → line（走资源包 device facts）", () => {
  assert.equal(svdLineForChip("STM32F103C8T6", coreEnv), "103");
  assert.equal(svdLineForChip("STM32F103RCT6", coreEnv), "103");
  assert.equal(svdLineForChip("STM32F999XX", coreEnv), null);
});

test("小工具：parseAddressText / formatAddress / formatOffset / 常量", () => {
  assert.equal(parseAddressText("0x4001100C"), 0x4001100c);
  assert.equal(parseAddressText("4001100C"), 0x4001100c);
  assert.equal(parseAddressText("ADC1"), null, "裸写要 5 位以上，别把外设名当地址");
  assert.equal(parseAddressText("GPIO"), null);
  assert.equal(parseAddressText("0xZZ"), null);
  assert.equal(formatAddress(0x4001100c), "0x4001100C");
  assert.equal(formatOffset(0x0c), "0xC");
  assert.match(SVD_FULL_PROFILE_HINT, /stm32_assets refresh --profile full/u);
});

/* ============================ D2：regs_read 的符号名与位域 ============================ */

const BIN_DIRS = fakeBinDirs("regs");

/** 纯函数用例里的 planRegReads：显式带上夹具环境的 DSH_STM32_ASSETS（工具路径由 withAssets 改 process.env）。 */
const planWith = (refs, device) => planRegReads(refs, device, flatEnv);
/** 测试里永远不真的去探测 3333（本机可能恰好占着）。 */
const NOT_BUSY = async () => false;
const FRAME = String.fromCharCode(0x1a);

/** 假 subprocess：只认 openocd，起来后打印三行 Listening（含 tcl 端口）；gdb 立刻退 0。 */
function makeSubprocess(options = {}) {
  const tclPort = options.tclPort ?? 4445;
  const spawned = [];
  return {
    spawned,
    service: {
      resolveExecutable: (command) => command,
      spawn(spec) {
        if (typeof spec.cwd !== "string") throw new TypeError("Cannot read properties of undefined (reading 'includes')");
        const isOpenOcd = String(spec.argv[0]).toLowerCase().includes("openocd");
        const record = { argv: spec.argv, cwd: spec.cwd, terminated: false };
        spawned.push(record);
        const out = { text: "" };
        const err = { text: "" };
        let resolveDone;
        const done = new Promise((resolve) => {
          resolveDone = resolve;
        });
        if (!isOpenOcd) {
          setTimeout(() => resolveDone({ exitCode: 0, signal: null }), 20);
        } else {
          setTimeout(() => {
            err.text += "Info : CMSIS-DAP: Interface ready\n";
            err.text += "Info : Listening on port 4444 for telnet connections\n";
            err.text += "Info : Listening on port " + String(tclPort) + " for tcl connections\n";
            err.text += "Info : Listening on port 3333 for gdb connections\n";
          }, 20);
        }
        return {
          done,
          collected: {
            stdout: { readFrom: (offset) => ({ text: out.text.slice(offset), lossy: false, nextOffset: out.text.length }) },
            stderr: { readFrom: (offset) => ({ text: err.text.slice(offset), lossy: false, nextOffset: err.text.length }) },
          },
          terminate() {
            record.terminated = true;
            resolveDone({ exitCode: null, signal: "SIGTERM" });
          },
          waitForExit() {
            return Promise.resolve();
          },
        };
      },
    },
  };
}

/** 假 openocd 的 Tcl 口：按 0x1a 分帧收命令、回同帧格式的响应（mdw 的键是小写 0x 地址）。 */
async function startFakeTclServer(options = {}) {
  const values = options.values ?? {};
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let frame = buffer.indexOf(FRAME);
      while (frame >= 0) {
        const command = buffer.slice(0, frame).trim();
        buffer = buffer.slice(frame + 1);
        let reply = "";
        if (command === "halt" || command === "resume") reply = "";
        else if (command === "reg pc") reply = "pc (/32): 0x0800012c";
        else if (command.startsWith("mdw ")) {
          const address = command.slice(4).trim().toLowerCase();
          reply = address + ": " + (values[address] ?? "00000000");
        } else reply = "Error: unknown command";
        socket.write(reply + FRAME);
        frame = buffer.indexOf(FRAME);
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** 起一个"已在跑"的假会话：工具里的 ensureSession 会直接复用它，不再探测 3333。 */
async function startToolSession(options = {}) {
  await debugSessions.stop("D2 单测重置");
  const server = await startFakeTclServer({ values: options.values ?? {} });
  const fake = makeSubprocess({ tclPort: server.port });
  debugSessions.configure(fake.service, BIN_DIRS);
  const ensured = await ensureSession(FIXTURE_PROJECT, { subprocess: fake.service, checkPortBusy: NOT_BUSY, idleTtlMs: 60_000 });
  assert.equal(ensured.ok, true, ensured.message);
  return {
    fake,
    server,
    async close() {
      await server.close();
      await debugSessions.stop("D2 单测收尾");
    },
  };
}

/** 临时把 DSH_STM32_ASSETS 指到某个夹具根（工具内部读的是 process.env）。 */
async function withAssets(dir, fn) {
  const previous = process.env.DSH_STM32_ASSETS;
  process.env.DSH_STM32_ASSETS = dir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.DSH_STM32_ASSETS;
    else process.env.DSH_STM32_ASSETS = previous;
  }
}

function makeToolContext(subprocessService) {
  const map = new Map();
  const ctx = {
    tools: { register: (definition) => { map.set(definition.name, definition); return () => {}; } },
    get(name) {
      return name === "subprocess" ? subprocessService : undefined;
    },
  };
  return { ctx, map };
}

async function runRegsTool(refs, options = {}) {
  const { ctx, map } = makeToolContext(options.subprocess);
  registerRegsRead(ctx);
  const definition = map.get("stm32_regs_read");
  assert.ok(definition, "工具必须注册成 stm32_regs_read");
  return await definition.execute(
    { projectDir: options.projectDir ?? FIXTURE_PROJECT, addresses: refs, envCheck: "off" },
    { signal: new AbortController().signal },
  );
}

/** 手搭一份"外设寄存器特别多"的 SVD，专门验 dump 的 64 条上限（不落盘）。 */
function syntheticDevice(registers) {
  const peripheral = { name: "BIG", baseAddress: 0x40000000, registers };
  return {
    line: "103",
    device: "STM32F103xx",
    family: "STM32F1",
    schema: 2,
    version: "",
    path: "",
    source: "",
    counts: { peripherals: 1, registers: registers.length, fields: 0 },
    peripherals: [peripheral],
    byName: new Map([["BIG", peripheral]]),
    peripheralNames: ["BIG"],
    flat: [],
    byAddress: new Map(),
  };
}

test("planRegReads：四种写法等价（0x4001100C / GPIOC.ODR / GPIOC->ODR / 大小写空格）", () => {
  const device = loadSvdForLine(LINE, flatEnv);
  assert.notEqual(device, null);
  const plan = planWith(["GPIOC.ODR", "GPIOC->ODR", "0x4001100C", "  gpioc . odr  "], device);
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.targets.length, 1, "四种写法指向同一个地址，只该留一条");
  assert.equal(plan.addresses[0], "0x4001100C");
  assert.equal(plan.targets[0].name, "GPIOC.ODR");
  assert.equal(plan.targets[0].kind, "register", "首次出现的写法是符号名，去重后保留它");
  assert.match(plan.notes.join("\n"), /重复了|同一个地址/u);
  assert.equal(plan.targets[0].fields.length, 16);
});

test("planRegReads：只给外设名 → dump 该外设全部寄存器（按偏移升序、名字是全名）", () => {
  const device = loadSvdForLine(LINE, flatEnv);
  const plan = planWith(["GPIOC"], device);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.targets.map((target) => target.name), ["GPIOC.CRL", "GPIOC.CRH", "GPIOC.IDR", "GPIOC.ODR", "GPIOC.BSRR", "GPIOC.BRR"]);
  assert.deepEqual(plan.targets.map((target) => target.address), [0x40011000, 0x40011004, 0x40011008, 0x4001100c, 0x40011010, 0x40011014]);
  assert.equal(plan.targets.every((target) => target.kind === "peripheral"), true);
  assert.equal(plan.targets[3].fields.length, 16, "ODR 的位域要带上，dump 才能逐条解释");
  assert.match(plan.notes.join("\n"), /是外设名：dump 了它的 6 个寄存器/u);
});

test("planRegReads：外设寄存器超过 REG_DUMP_MAX 时截断并说明（不静默丢）", () => {
  const registers = Array.from({ length: REG_DUMP_MAX + 5 }, (_, index) => ({
    name: "R" + String(index),
    addressOffset: index * 4,
    size: 32,
    access: "read-write",
    fields: [],
  }));
  const plan = planWith(["BIG"], syntheticDevice(registers));
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.targets.length, REG_DUMP_MAX, "最多只 dump " + String(REG_DUMP_MAX) + " 个");
  assert.equal(plan.addresses.length, REG_DUMP_MAX);
  assert.match(plan.notes.join("\n"), /有 69 个寄存器，只 dump 了地址最小的前 64 个/u);
});

test("planRegReads：未知外设 → 结构化错误 + 前 10 个可用外设（不静默）", () => {
  const device = loadSvdForLine(LINE, flatEnv);
  const plan = planWith(["GPIOZ"], device);
  assert.equal(plan.targets.length, 0);
  assert.equal(plan.errors.length, 1);
  assert.match(plan.errors[0], /没有外设 GPIOZ/u);
  assert.match(plan.errors[0], new RegExp("可用外设（前 " + String(REGS_SUGGEST_PERIPHERALS) + " 个）", "u"));
  assert.match(plan.errors[0], /GPIOC/u);
  assert.match(plan.errors[0], /共 5 个/u);
});

test("planRegReads：GPIOZ.ODR 这种「外设.寄存器」写错 → 错误里点名外设，且带上已知外设", () => {
  const device = loadSvdForLine(LINE, flatEnv);
  const plan = planWith(["GPIOZ.ODR"], device);
  assert.equal(plan.errors.length, 1);
  assert.match(plan.errors[0], /没有外设 GPIOZ/u);
  assert.match(plan.errors[0], /可用外设（前 10 个）：GPIOA、GPIOC/u);
});

test("planRegReads：未知寄存器 → 列出该外设已知寄存器；没有 SVD 时符号名给 full profile 提示", () => {
  const device = loadSvdForLine(LINE, flatEnv);
  const badRegister = planWith(["GPIOC.XYZ"], device);
  assert.match(badRegister.errors[0], /外设 GPIOC 里没有寄存器 XYZ/u);
  assert.match(badRegister.errors[0], /已知寄存器：CRL、CRH/u);

  const noSvd = planWith(["GPIOC.ODR"], null);
  assert.equal(noSvd.targets.length, 0);
  assert.match(noSvd.errors[0], /不是物理地址/u);
  assert.match(noSvd.errors[0], /stm32_assets refresh --profile full/u);

  const addressOnly = planWith(["0x4001100C"], null);
  assert.deepEqual(addressOnly.errors, [], "没有 SVD 也要能按纯地址读");
  assert.equal(addressOnly.targets[0].name, "0x4001100C");
  assert.match(addressOnly.notes.join("\n"), /refresh --profile full/u);
});

test("planRegReads：重复 ref 与同地址别名只读一次（并说明）", () => {
  const device = loadSvdForLine(LINE, flatEnv);
  const plan = planWith(["GPIOC.ODR", "gpioc.odr", "0x4001100C"], device);
  assert.equal(plan.targets.length, 1);
  const notes = plan.notes.join("\n");
  assert.match(notes, /「gpioc\.odr」重复了，只读一次/u);
  assert.match(notes, /指向同一个地址 0x4001100C，只读一次/u);
});

test("formatBits / decorateSamples / describeRegSample：置位位域与读不到的样本", () => {
  assert.equal(formatBits(5, 1), "5");
  assert.equal(formatBits(3, 5), "3:7", "bitOffset=3、bitWidth=5 覆盖 bit 3..7，跟手册的 7:3 是同一段");
  assert.equal(formatBits(8, 8), "8:15");

  const device = loadSvdForLine(LINE, flatEnv);
  const plan = planWith(["GPIOC.ODR", "RCC.CR"], device);
  const samples = decorateSamples(
    [
      { address: "0x4001100c", value: "0x00000020", ok: true },
      { address: "0x40021000", value: "0x00000003", ok: true },
      { address: "0x40021004", value: "", ok: false },
    ],
    plan.targets,
  );
  assert.equal(samples[0].ref, "GPIOC.ODR");
  assert.equal(samples[0].name, "GPIOC.ODR");
  assert.deepEqual(samples[0].fields, [{ name: "ODR5", bits: "5", value: 1 }]);
  assert.deepEqual(samples[1].fields, [{ name: "HSION", bits: "0", value: 1 }, { name: "HSIRDY", bits: "1", value: 1 }]);
  assert.deepEqual(samples[2].fields, [], "读不到的样本不解释位域");
  assert.equal(samples[2].ref, "0x40021004", "没有对应目标时 ref/name 退回地址");
  assert.match(describeRegSample(samples[0]), /^GPIOC\.ODR \(0x4001100C\) = 0x00000020\s+→ ODR5=1$/u);
  assert.match(describeRegSample(samples[2]), /（读不到）$/u);
});

test("resolveProjectSvd：.ioc 型号 → line（SVD 在） / 没装 SVD → 提示 full profile", () => {
  const withSvd = resolveProjectSvd(FIXTURE_PROJECT, { DSH_STM32_ASSETS: SVD_FLAT });
  assert.equal(withSvd.cpn, "STM32F103C8T6");
  assert.equal(withSvd.line, "103");
  assert.notEqual(withSvd.device, null);
  assert.equal(withSvd.device.device, "STM32F103xx");
  assert.match(withSvd.note, /SVD line=103/u);
  assert.match(withSvd.note, /5 个外设/u);
  assert.match(withSvd.note, /21 个寄存器/u);

  const withoutSvd = resolveProjectSvd(FIXTURE_PROJECT, { DSH_STM32_ASSETS: SVD_NOWHERE });
  assert.equal(withoutSvd.line, "103", "型号里能推断出 line，但文件读不到");
  assert.equal(withoutSvd.device, null);
  assert.match(withoutSvd.note, /stm32_assets refresh --profile full/u);
});

test("execute：符号名 + 地址混着传 → 每条样本带 ref/name/fields，位域按 SVD 解释（假 subprocess）", async () => {
  const session = await startToolSession({ values: { "0x4001100c": "00000020", "0x40010800": "00000001", "0x40021000": "00000003" } });
  try {
    const value = await withAssets(SVD_FLAT, () =>
      runRegsTool(["GPIOC.ODR", "0x40010800", "RCC.CR"], { subprocess: session.fake.service }),
    );
    assert.equal(value.report.ok, true, value.report.message + " / " + value.report.errors.join(" | "));
    assert.equal(value.report.samples.length, 3);
    for (const sample of value.report.samples) {
      assert.deepEqual(Object.keys(sample).sort(), ["address", "fields", "name", "ok", "ref", "value"], "样本字段必须与 schema 一致（additionalProperties:false）");
    }
    const odr = value.report.samples[0];
    assert.equal(odr.ref, "GPIOC.ODR");
    assert.equal(odr.name, "GPIOC.ODR");
    assert.equal(odr.address, "0x4001100C");
    assert.equal(odr.value, "0x00000020");
    assert.deepEqual(odr.fields, [{ name: "ODR5", bits: "5", value: 1 }]);
    assert.equal(value.report.samples[1].name, "GPIOA.CRL", "纯地址也要按 SVD 反查名字");
    assert.equal(value.report.samples[1].ref, "0x40010800", "ref 保留用户写法");
    assert.equal(value.report.samples[2].name, "RCC.CR");
    assert.deepEqual(value.report.samples[2].fields.map((field) => field.name), ["HSION", "HSIRDY"]);
    assert.match(value.message, /读到 3 个寄存器/u);
    assert.match(value.report.notes.join("\n"), /SVD line=103/u);
  } finally {
    await session.close();
  }
});

test("execute：只给 GPIOC → dump 6 个寄存器并逐条解释（含 ODR 位域）", async () => {
  const session = await startToolSession({ values: { "0x4001100c": "00000020" } });
  try {
    const value = await withAssets(SVD_FLAT, () => runRegsTool(["GPIOC"], { subprocess: session.fake.service }));
    assert.equal(value.report.ok, true, value.report.message);
    assert.equal(value.report.samples.length, 6);
    assert.deepEqual(value.report.samples.map((sample) => sample.name), ["GPIOC.CRL", "GPIOC.CRH", "GPIOC.IDR", "GPIOC.ODR", "GPIOC.BSRR", "GPIOC.BRR"]);
    const addresses = value.report.samples.map((sample) => Number.parseInt(sample.address, 16));
    assert.deepEqual(addresses, [...addresses].sort((left, right) => left - right), "dump 按地址升序");
    const odr = value.report.samples[3];
    assert.deepEqual(odr.fields, [{ name: "ODR5", bits: "5", value: 1 }]);
    assert.match(value.report.notes.join("\n"), /是外设名：dump 了它的 6 个寄存器/u);
    assert.match(value.message, /读到 6 个寄存器/u);
  } finally {
    await session.close();
  }
});

test("execute：没有 SVD 时回退纯地址模式（不报错，name=地址，fields 空）", async () => {
  const session = await startToolSession({ values: { "0x4001100c": "00000020" } });
  try {
    const value = await withAssets(SVD_NOWHERE, () => runRegsTool(["0x4001100C"], { subprocess: session.fake.service }));
    assert.equal(value.report.ok, true, value.report.message);
    assert.equal(value.report.samples.length, 1);
    assert.equal(value.report.samples[0].name, "0x4001100C");
    assert.equal(value.report.samples[0].ref, "0x4001100C");
    assert.deepEqual(value.report.samples[0].fields, []);
    assert.equal(value.report.samples[0].value, "0x00000020");
    assert.match(value.report.notes.join("\n"), /stm32_assets refresh --profile full/u);
    assert.match(value.message, /读到 1 个地址/u, "纯地址模式的文案还是「个地址」");
  } finally {
    await session.close();
  }
});

test("execute：未知符号 → 直接失败并列出可用外设，且一个进程都不 spawn（不白占探针）", async () => {
  await debugSessions.stop("D2 单测重置");
  const fake = makeSubprocess({ tclPort: 4446 });
  debugSessions.configure(fake.service, BIN_DIRS);
  const value = await withAssets(SVD_FLAT, () => runRegsTool(["GPIOZ.ODR"], { subprocess: fake.service }));
  assert.equal(value.report.ok, false);
  assert.deepEqual(value.report.samples, []);
  assert.match(value.report.errors[0], /没有外设 GPIOZ/u);
  assert.match(value.report.errors[0], /可用外设（前 10 个）/u);
  assert.match(value.report.notes.join("\n"), /SVD line=103/u);
  assert.equal(fake.spawned.length, 0, "解析失败就不该起 openocd");
});
