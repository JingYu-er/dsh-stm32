import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  diffIocEntries,
  iocBackupDir,
  parseIocEntries,
  readIocDiff,
  restoreIocKey,
  saveIocSnapshot,
  snapshotPath,
} from "../lib/engine/ioc-diff.js";

function projectWithIoc(text) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-ioc-diff-"));
  writeFileSync(join(dir, "demo.ioc"), text, "utf8");
  return dir;
}

test(".ioc 解析：跳过注释与空行，重复键只收第一次", () => {
  const entries = parseIocEntries(
    [
      "#MicroXplorer Configuration settings - do not modify",
      "",
      "Mcu.CPN=STM32F103C8T6",
      "Mcu.IP0=NVIC",
      "Mcu.IP0=DMA",
      "GPIO_Label.PA5=LED",
      "没有等号的行",
    ].join("\n"),
  );
  assert.deepEqual(entries, [
    { key: "Mcu.CPN", value: "STM32F103C8T6" },
    { key: "Mcu.IP0", value: "NVIC" },
    { key: "GPIO_Label.PA5", value: "LED" },
  ]);
});

test("逐键比较：新增、删除、改动各归各表并按 key 排序", () => {
  const before = [
    { key: "Mcu.CPN", value: "STM32F103C8T6" },
    { key: "Mcu.IP0", value: "NVIC" },
    { key: "RCC.SYSCLKSource", value: "RCC_SYSCLKSOURCE_HSI" },
  ];
  const after = [
    { key: "Mcu.CPN", value: "STM32F103C8T6" },
    { key: "RCC.SYSCLKSource", value: "RCC_SYSCLKSOURCE_PLLCLK" },
    { key: "USART1.Mode", value: "Asynchronous" },
  ];
  const diff = diffIocEntries(before, after);
  assert.deepEqual(diff.added, [{ key: "USART1.Mode", value: "Asynchronous" }]);
  assert.deepEqual(diff.removed, [{ key: "Mcu.IP0", value: "NVIC" }]);
  assert.deepEqual(diff.changed, [
    { key: "RCC.SYSCLKSource", before: "RCC_SYSCLKSOURCE_HSI", after: "RCC_SYSCLKSOURCE_PLLCLK" },
  ]);
});

test("没有基线时只给提示；记下基线后能比出改动", () => {
  const env = { DSH_STM32_SNAPSHOTS: mkdtempSync(join(tmpdir(), "dsh-ioc-snap-")) };
  const dir = projectWithIoc("Mcu.CPN=STM32F103C8T6\nRCC.SYSCLKSource=RCC_SYSCLKSOURCE_HSI\n");

  const empty = readIocDiff(dir, env);
  assert.equal(empty.ok, true);
  assert.equal(empty.report.hasSnapshot, false);
  assert.equal(empty.report.counts.total, 0);
  assert.ok(empty.report.notes[0].includes("还没有基线"));
  assert.equal(empty.report.snapshotPath, snapshotPath(dir, env));

  const saved = saveIocSnapshot(dir, env);
  assert.equal(saved.ok, true);
  assert.equal(saved.report.entries, 2);

  writeFileSync(join(dir, "demo.ioc"), "Mcu.CPN=STM32F103C8T6\nRCC.SYSCLKSource=RCC_SYSCLKSOURCE_PLLCLK\nUSART1.Mode=Asynchronous\n", "utf8");
  const changed = readIocDiff(dir, env);
  assert.equal(changed.ok, true);
  assert.equal(changed.report.hasSnapshot, true);
  assert.equal(changed.report.counts.changed, 1);
  assert.equal(changed.report.counts.added, 1);
  assert.equal(changed.report.counts.removed, 0);
  assert.equal(changed.report.changed[0].key, "RCC.SYSCLKSource");
  assert.ok(changed.report.savedAt.length > 0);

  rmSync(env.DSH_STM32_SNAPSHOTS, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

test("空目录与空参数给出可读错误，不抛", () => {
  const env = { DSH_STM32_SNAPSHOTS: mkdtempSync(join(tmpdir(), "dsh-ioc-snap-bad-")) };
  const empty = mkdtempSync(join(tmpdir(), "dsh-ioc-none-"));
  assert.equal(readIocDiff("   ", env).ok, false);
  assert.equal(saveIocSnapshot("  ", env).ok, false);
  const missing = readIocDiff(empty, env);
  assert.equal(missing.ok, false);
  assert.ok(missing.error.includes(".ioc"));
  assert.equal(saveIocSnapshot(empty, env).ok, false);
  rmSync(env.DSH_STM32_SNAPSHOTS, { recursive: true, force: true });
  rmSync(empty, { recursive: true, force: true });
});

test("恢复某个键：写回基线值并先备份，其它行不动", () => {
  const env = { DSH_STM32_SNAPSHOTS: mkdtempSync(join(tmpdir(), "dsh-ioc-snap-restore-")) };
  const dir = projectWithIoc("#注释\nMcu.CPN=STM32F103C8T6\nRCC.SYSCLKSource=RCC_SYSCLKSOURCE_HSI\n");
  assert.equal(saveIocSnapshot(dir, env).ok, true);
  writeFileSync(join(dir, "demo.ioc"), "#注释\nMcu.CPN=STM32F103C8T6\nRCC.SYSCLKSource=RCC_SYSCLKSOURCE_PLLCLK\n", "utf8");

  const restored = restoreIocKey(dir, "RCC.SYSCLKSource", env);
  assert.equal(restored.ok, true);
  assert.equal(restored.report.key, "RCC.SYSCLKSource");
  assert.equal(restored.report.before, "RCC_SYSCLKSOURCE_PLLCLK");
  assert.equal(restored.report.after, "RCC_SYSCLKSOURCE_HSI");
  assert.equal(restored.report.changed, true);
  const text = readFileSync(join(dir, "demo.ioc"), "utf8");
  assert.ok(text.includes("RCC.SYSCLKSource=RCC_SYSCLKSOURCE_HSI"));
  assert.ok(text.includes("Mcu.CPN=STM32F103C8T6"));
  assert.ok(text.includes("#注释"));
  assert.equal(restored.report.backupPath.startsWith(iocBackupDir(dir)), true);
  assert.ok(existsSync(restored.report.backupPath));
  assert.ok(readFileSync(restored.report.backupPath, "utf8").includes("RCC_SYSCLKSOURCE_PLLCLK"));

  const again = readIocDiff(dir, env);
  assert.equal(again.ok, true);
  assert.equal(again.report.counts.total, 0);

  rmSync(env.DSH_STM32_SNAPSHOTS, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

test("恢复某个键：基线里没有、非法键名、没有基线都被拒", () => {
  const env = { DSH_STM32_SNAPSHOTS: mkdtempSync(join(tmpdir(), "dsh-ioc-snap-reject-")) };
  const dir = projectWithIoc("Mcu.CPN=STM32F103C8T6\n");
  const noBaseline = restoreIocKey(dir, "Mcu.CPN", env);
  assert.equal(noBaseline.ok, false);
  assert.ok(noBaseline.error.includes("基线"));
  assert.equal(saveIocSnapshot(dir, env).ok, true);
  const unknown = restoreIocKey(dir, "USART1.BaudRate", env);
  assert.equal(unknown.ok, false);
  assert.ok(unknown.error.includes("基线里没有这个键"));
  const bad = restoreIocKey(dir, "Mcu CPN", env);
  assert.equal(bad.ok, false);
  assert.ok(bad.error.includes("key"));
  const empty = restoreIocKey("   ", "Mcu.CPN", env);
  assert.equal(empty.ok, false);
  rmSync(env.DSH_STM32_SNAPSHOTS, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

test("恢复某个键：当前文件里被删掉的键追加回末尾", () => {
  const env = { DSH_STM32_SNAPSHOTS: mkdtempSync(join(tmpdir(), "dsh-ioc-snap-append-")) };
  const dir = projectWithIoc("Mcu.CPN=STM32F103C8T6\nRCC.SYSCLKSource=RCC_SYSCLKSOURCE_HSI\n");
  assert.equal(saveIocSnapshot(dir, env).ok, true);
  writeFileSync(join(dir, "demo.ioc"), "Mcu.CPN=STM32F103C8T6\n", "utf8");
  const restored = restoreIocKey(dir, "RCC.SYSCLKSource", env);
  assert.equal(restored.ok, true);
  assert.equal(restored.report.changed, true);
  const text = readFileSync(join(dir, "demo.ioc"), "utf8");
  assert.ok(text.includes("RCC.SYSCLKSource=RCC_SYSCLKSOURCE_HSI"));
  assert.equal(text.endsWith("\n"), false);
  rmSync(env.DSH_STM32_SNAPSHOTS, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});
