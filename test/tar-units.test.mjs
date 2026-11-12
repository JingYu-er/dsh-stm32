// 文件级 tar.gz 解包：流式、先校验后落盘、上限在解压阶段生效。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { extractTarGz, extractTarGzFile } from "../lib/engine/tar.js";

const root = mkdtempSync(path.join(tmpdir(), "dsh-tar-tests-"));
process.on("exit", () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });
let seq = 0;
function fresh() { seq += 1; return path.join(root, "case-" + String(seq)); }

function octal(value, width) { return value.toString(8).padStart(width, "0"); }
function header(name, size, type = "0") {
  const buf = Buffer.alloc(512, 0);
  buf.write(name, 0, 100, "utf8");
  buf.write(octal(0o644, 7) + "\0", 100);
  buf.write(octal(0, 7) + "\0", 108);
  buf.write(octal(0, 7) + "\0", 116);
  buf.write(octal(size, 11) + "\0", 124);
  buf.write(octal(0, 11) + "\0", 136);
  buf.write("        ", 148);
  buf.write(type, 156);
  buf.write("ustar\0", 257);
  buf.write("00", 263);
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(octal(sum, 6) + "\0 ", 148);
  return buf;
}
function tar(entries) {
  const chunks = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? "", "utf8");
    chunks.push(header(entry.path, data.length, entry.type ?? "0"));
    chunks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad > 0) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

test("extractTarGzFile：流式解包 + stripComponents + mapPath", async () => {
  const dest = fresh();
  const archive = path.join(root, "ok.tar.gz");
  writeFileSync(archive, tar([
    { path: "repo-master/Inc/a.h", data: "#pragma once\n" },
    { path: "repo-master/Src/a.c", data: "int a;\n" },
    { path: "repo-master/README.md", data: "skip\n" },
  ]));
  const result = await extractTarGzFile(archive, dest, {
    stripComponents: 1,
    mapPath: (rel) => (rel.startsWith("Inc/") || rel.startsWith("Src/") ? rel : null),
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.files.length, 2);
  assert.equal(readFileSync(path.join(dest, "Inc/a.h"), "utf8"), "#pragma once\n");
  assert.equal(readFileSync(path.join(dest, "Src/a.c"), "utf8"), "int a;\n");
  assert.equal(existsSync(path.join(dest, "README.md")), false);
  assert.equal(result.skipped >= 1, true);
});

test("extractTarGzFile：可疑路径整次失败，目标目录一个文件都不落", async () => {
  const dest = fresh();
  const archive = path.join(root, "evil.tar.gz");
  writeFileSync(archive, tar([{ path: "repo-master/a.txt", data: "ok" }, { path: "repo-master/x/../../evil.txt", data: "bad" }]));
  const result = await extractTarGzFile(archive, dest, { stripComponents: 1 });
  assert.equal(result.ok, false);
  assert.match(result.error, /可疑路径/u);
  assert.equal(existsSync(dest), false);
});

test("extractTarGzFile：解压阶段就卡上限（不是先整包解压再判）", async () => {
  const dest = fresh();
  const archive = path.join(root, "big.tar.gz");
  writeFileSync(archive, tar([{ path: "repo-master/big.bin", data: Buffer.alloc(2 * 1024 * 1024, 0x41) }]));
  const result = await extractTarGzFile(archive, dest, { stripComponents: 1, maxBytes: 1024 * 1024 });
  assert.equal(result.ok, false);
  assert.match(result.error, /压缩炸弹|超过/u);
  assert.equal(existsSync(dest), false);
});

test("extractTarGzFile：截断的 tar 整次失败", async () => {
  const dest = fresh();
  const archive = path.join(root, "trunc.tar.gz");
  const full = tar([{ path: "repo-master/a.txt", data: "hello" }]);
  writeFileSync(archive, full);
  const result = await extractTarGzFile(archive, dest, { stripComponents: 1, maxBytes: 1 });
  assert.equal(result.ok, false);
  assert.equal(existsSync(dest), false);
  // 同一份归档在 sync API 下也不该写出半截文件
  const sync = extractTarGz(full, dest, { stripComponents: 1, maxBytes: 1 });
  assert.equal(sync.ok, false);
  assert.equal(existsSync(dest), false);
});