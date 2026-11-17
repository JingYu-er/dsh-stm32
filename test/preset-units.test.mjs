// 外设预设与生成防护（S187）：SPI 全双工/只发、I2C 的键集；迁移弹窗的防腐补丁；
// 「.ioc 启用了但产物里没有 MX_xxx_Init」的丢弃检查。
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { PERIPHERAL_PRESETS, peripheralPresetNames } from "../lib/data/ioc-presets.js";
import { missingPeripheralInits, sanitizeIocForHeadless } from "../lib/engine/generate.js";

function preset(name) {
  const found = PERIPHERAL_PRESETS.find((entry) => entry.name === name);
  assert.ok(found !== undefined, "没有这个预设：" + name);
  return found;
}

function parameterValue(item, key) {
  return item.parameters.find((entry) => entry.name === key)?.value ?? "";
}

test("外设预设：SPI 全双工要三根脚齐全，只发只写两根，方向与引脚模式配套（S187）", () => {
  const names = peripheralPresetNames();
  assert.ok(names.includes("SPI1"));
  assert.ok(names.includes("SPI1:tx"));
  assert.ok(names.includes("SPI1:rx"));

  const full = preset("SPI1");
  assert.equal(full.ip, "SPI1");
  assert.deepEqual(
    full.pins.map((pin) => [pin.role, pin.defaultPin, pin.signal, pin.mode]),
    [
      ["sck", "PA5", "SPI1_SCK", "Full_Duplex_Master"],
      ["miso", "PA6", "SPI1_MISO", "Full_Duplex_Master"],
      ["mosi", "PA7", "SPI1_MOSI", "Full_Duplex_Master"],
    ],
  );
  assert.equal(parameterValue(full, "Direction"), "SPI_DIRECTION_2LINES");
  assert.equal(parameterValue(full, "Mode"), "SPI_MODE_MASTER");
  assert.equal(parameterValue(full, "NSS"), "SPI_NSS_SOFT");
  // 缺 MISO 时 CubeMX 会静默丢掉整个外设，所以预设的说明必须写明这一点。
  assert.ok(full.notes.some((note) => note.includes("静默")));

  const tx = preset("SPI1:tx");
  assert.deepEqual(
    tx.pins.map((pin) => [pin.role, pin.mode]),
    [
      ["sck", "TransmitOnly_Master"],
      ["mosi", "TransmitOnly_Master"],
    ],
  );
  assert.equal(parameterValue(tx, "Direction"), "SPI_DIRECTION_1LINE");

  const rx = preset("SPI1:rx");
  assert.deepEqual(
    rx.pins.map((pin) => [pin.role, pin.mode]),
    [
      ["sck", "ReceiveOnly_Master"],
      ["miso", "ReceiveOnly_Master"],
    ],
  );
  assert.equal(parameterValue(rx, "Direction"), "SPI_DIRECTION_1LINE");
});

test("外设预设：I2C 两根脚都写 I2C 模式，键集带时钟与 7 位地址（S187）", () => {
  const i2c = preset("I2C1");
  assert.equal(i2c.ip, "I2C1");
  assert.deepEqual(
    i2c.pins.map((pin) => [pin.role, pin.defaultPin, pin.signal, pin.mode]),
    [
      ["scl", "PB6", "I2C1_SCL", "I2C"],
      ["sda", "PB7", "I2C1_SDA", "I2C"],
    ],
  );
  assert.equal(parameterValue(i2c, "ClockSpeed"), "100000");
  assert.equal(parameterValue(i2c, "AddressingMode"), "I2C_ADDRESSINGMODE_7BIT");
  assert.ok(i2c.notes.length > 0);
});

test("无头生成：AskForMigrate 被强制关掉，原 .ioc 一字不动（S187）", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-stm32-migrate-"));
  const source = join(dir, "board.ioc");
  const original = "MxCube.Version=6.15.0\nProjectManager.AskForMigrate=true\nMcu.UserName=STM32F303CCTx\n";
  writeFileSync(source, original, "utf8");

  const sanitized = sanitizeIocForHeadless(original, source, join(dir, "tmp"), "42");
  assert.equal(sanitized.sanitized, true);
  assert.match(readFileSync(sanitized.path, "utf8"), /ProjectManager\.AskForMigrate=false/u);
  assert.match(readFileSync(sanitized.path, "utf8"), /Mcu\.UserName=STM32F303CCTx/u);
  assert.ok(sanitized.note.includes("不迁移"));
  // 交给 CubeMX 的是副本；原文件保持原样，方便用户在 GUI 里自己决定迁不迁。
  assert.equal(readFileSync(source, "utf8"), original);
  assert.ok(sanitized.path !== source);
  assert.match(readFileSync(sanitized.path, "utf8"), /AskForMigrate=false/u);

  const missing = sanitizeIocForHeadless("MxCube.Version=6.8.0\n", source, join(dir, "tmp2"), "43");
  assert.equal(missing.sanitized, true);
  assert.match(readFileSync(missing.path, "utf8"), /AskForMigrate=false/u);
  assert.ok(missing.note.includes("6.8.0"));
});

test("无头生成：.ioc 启用了却没有 MX_xxx_Init 的外设要点名（S187）", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-stm32-dropped-"));
  const src = join(dir, "Core", "Src");
  mkdirSync(src, { recursive: true });
  writeFileSync(
    join(src, "main.c"),
    "static void MX_USART1_UART_Init(void);\nint main(void){MX_USART1_UART_Init();MX_GPIO_Init();}\n",
    "utf8",
  );
  const ioc = [
    "Mcu.IP0=NVIC",
    "Mcu.IP1=RCC",
    "Mcu.IP2=SYS",
    "Mcu.IP3=USART1",
    "Mcu.IP4=SPI1",
    "Mcu.IPNb=5",
  ].join("\n");

  const dropped = missingPeripheralInits(ioc, dir);
  // RCC/SYS/NVIC 本来就不生成 MX_*_Init，不该进清单；SPI1 才是被静默丢掉的。
  assert.deepEqual(dropped, ["SPI1"]);

  // 换 per-ip 布局时初始化函数在 Ip 文件里，检查要能扫到。
  writeFileSync(join(src, "spi.c"), "void MX_SPI1_Init(void){}\n", "utf8");
  assert.deepEqual(missingPeripheralInits(ioc, dir), []);
});
