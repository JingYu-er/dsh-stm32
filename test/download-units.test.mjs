// stm32_download：只下载/校验，不执行安装器。
// 网络用本机 HTTP server，CI 不访问外网。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DownloadError,
  downloadRootInfo,
  downloadUrlToFile,
  inspectInstallerFile,
  planDownload,
} from "../lib/engine/download.js";
import { registerDownload } from "../lib/tools/download.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");

async function withServer(body, fn) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(Buffer.byteLength(body)) });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    return await fn("http://127.0.0.1:" + String(address.port) + "/installer.exe");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("J-Link 计划是直链 + 官方 SHA256；ST 两件是 manual", () => {
  const jlink = planDownload("jlink", { env: { DSH_STM32_DOWNLOADS: "D:/tmp/downloads" } });
  assert.equal(jlink.mode, "direct");
  assert.match(jlink.url, /^https:\/\//u);
  assert.equal(jlink.expectedSha256.length, 64);
  assert.match(jlink.targetPath, /downloads[\\/]JLink_/u);
  const mx = planDownload("cubemx");
  assert.equal(mx.mode, "manual");
  assert.equal(mx.url, "");
  assert.match(mx.page, /stm32cubemx/u);
  const prg = planDownload("cubeprogrammer");
  assert.equal(prg.mode, "manual");
  assert.match(prg.page, /stm32cubeprog/u);
});

test("J-Link 镜像覆盖必须同时给 URL 和 SHA256，否则回默认官方源", () => {
  const fallback = planDownload("jlink", {
    env: { DSH_STM32_JLINK_URL: "https://mirror.example/JLink.exe" },
  });
  assert.match(fallback.url, /files\.nordicsemi\.com/u, "只给 URL 不收：没有哈希的 exe 不能下");
  assert.equal(fallback.expectedSha256.length, 64);

  const hash = sha("mirror-installer");
  const pinned = planDownload("jlink", {
    env: {
      DSH_STM32_JLINK_URL: "https://mirror.example/tools/JLink_Windows_V818.exe",
      DSH_STM32_JLINK_SHA256: hash,
    },
  });
  assert.equal(pinned.url, "https://mirror.example/tools/JLink_Windows_V818.exe");
  assert.equal(pinned.expectedSha256, hash);
  assert.match(pinned.targetPath, /JLink_Windows_V818\.exe$/u);

  const badHash = planDownload("jlink", {
    env: { DSH_STM32_JLINK_URL: "https://mirror.example/JLink.exe", DSH_STM32_JLINK_SHA256: "not-a-hash" },
  });
  assert.match(badHash.url, /files\.nordicsemi\.com/u, "哈希格式不对也回默认源");
});

test("下载目录：DSH_STM32_DOWNLOADS 覆盖", () => {
  const info = downloadRootInfo({ DSH_STM32_DOWNLOADS: "D:/tmp/x" });
  assert.equal(info.origin, "DSH_STM32_DOWNLOADS");
  assert.match(info.root, /tmp[\\/]x$/u);
});

test("本地安装包只校验，不复制、不执行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-download-"));
  const file = join(dir, "stm32cubemx.exe");
  writeFileSync(file, "installer-bytes");
  const info = await inspectInstallerFile(file);
  assert.equal(info.path, file);
  assert.equal(info.bytes, 15);
  assert.equal(info.sha256, sha("installer-bytes"));
  assert.equal(info.verified, false);
  await assert.rejects(
    () => inspectInstallerFile(file, "0".repeat(64)),
    (error) => error instanceof DownloadError && error.kind === "checksum-mismatch",
  );
});

test("直链下载：校验、复用缓存、哈希不符清理临时文件", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-download-"));
  const body = "fake-installer-" + "x".repeat(1024);
  const target = join(dir, "JLink_test.exe");
  await withServer(body, async (url) => {
    const first = await downloadUrlToFile(url, target, sha(body), { timeoutMs: 5000 });
    assert.equal(first.bytes, Buffer.byteLength(body));
    assert.equal(first.sha256, sha(body));
    assert.equal(first.cached, false);
    assert.equal(readFileSync(target, "utf8"), body);

    const second = await downloadUrlToFile(url, target, sha(body), { timeoutMs: 5000 });
    assert.equal(second.cached, true);
  });

  const bad = join(dir, "bad.exe");
  await withServer(body, async (url) => {
    await assert.rejects(
      () => downloadUrlToFile(url, bad, "f".repeat(64), { timeoutMs: 5000 }),
      (error) => error instanceof DownloadError && error.kind === "checksum-mismatch",
    );
  });
  assert.equal(existsSync(bad), false);
  assert.equal(existsSync(bad + ".part"), false);
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".part")), []);
});

test("工具：默认 dryRun 不下载；manual 不下载；confirm 缺失拒绝", async () => {
  const tools = [];
  registerDownload({ tools: { register: (def) => { tools.push(def); return () => {}; } } });
  const tool = tools[0];
  const signal = new AbortController().signal;
  const plan = await tool.execute({ component: "jlink" }, { signal });
  assert.equal(plan.report.ok, true);
  assert.equal(plan.report.downloaded, false);
  assert.equal(plan.report.mode, "direct");
  assert.match(plan.message, /下载计划/u);

  const manual = await tool.execute({ component: "cubemx", dryRun: false, openPage: false, confirm: true }, { signal });
  assert.equal(manual.report.ok, true);
  assert.equal(manual.report.downloaded, false);
  assert.equal(manual.report.opened, false);

  const refused = await tool.execute({ component: "jlink", dryRun: false }, { signal });
  assert.equal(refused.report.ok, false);
  assert.match(refused.message, /confirm:true/u);
});
