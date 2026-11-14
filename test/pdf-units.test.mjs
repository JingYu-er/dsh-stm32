import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { locatePoppler } from "../lib/engine/pdf/toolchain.js";
import { extractPdfText, listFigures, readPdfInfo, renderPdfPage } from "../lib/engine/pdf/reader.js";
import { CAPABILITY_COMPONENTS } from "../lib/engine/toolchain-gate.js";

function fakeSubprocess(respond) {
  const calls = [];
  return {
    calls,
    resolveExecutable: (command) => command,
    spawn(spec) {
      calls.push({ argv: spec.argv });
      const result = respond(spec.argv);
      const reader = (text) => ({
        readFrom(offset) {
          const slice = text.slice(offset);
          return { text: slice, nextOffset: text.length, lossy: false };
        },
      });
      if (result.writePng !== undefined) writeFileSync(result.writePng, result.png);
      const done = Promise.resolve({ exitCode: result.exitCode ?? 0, signal: null });
      return {
        done,
        collected: { stdout: reader(result.stdout ?? ""), stderr: reader(result.stderr ?? "") },
        terminate() {},
        waitForExit() {
          return done;
        },
      };
    },
  };
}

const tools = { pdftotext: "pdftotext.exe", pdfinfo: "pdfinfo.exe", pdftoppm: "pdftoppm.exe", binDir: "E:/msys64/ucrt64/bin" };

function tempDir() {
  return mkdtempSync(join(tmpdir(), "dsh-pdf-"));
}

test("locatePoppler：三个命令齐了才算找到，缺的全在报错里说清", () => {
  const dir = tempDir();
  try {
    const missing = locatePoppler([dir]);
    assert.equal(missing.tools, null);
    assert.match(missing.error, /poppler/u);
    assert.match(missing.error, /pacman/u);
    for (const name of ["pdftotext.exe", "pdfinfo.exe", "pdftoppm.exe"]) writeFileSync(join(dir, name), "");
    const found = locatePoppler([dir]);
    assert.equal(found.tools?.binDir, dir);
    assert.equal(found.tools?.pdftoppm, join(dir, "pdftoppm.exe"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPdfInfo：页数与文字层判定，描边字体的 PDF 会被标出来", async () => {
  const file = join(tempDir(), "manual.pdf");
  writeFileSync(file, "x");
  const normal = fakeSubprocess((argv) => {
    if (argv[0] === tools.pdfinfo) {
      return { stdout: "Title:          RM0490\nProducer:       pdfTeX\nPages:          1023\nPage size:      595 x 842 pts (A4)\nEncrypted:      no\n" };
    }
    return { stdout: "Embedded flash memory (FLASH)\n" };
  });
  const info = await readPdfInfo(normal, tools, file);
  assert.equal(info.ok, true);
  assert.equal(info.pages, 1023);
  assert.equal(info.pageSize, "595 x 842 pts (A4)");
  assert.equal(info.hasTextLayer, true);

  const glyph = fakeSubprocess((argv) => {
    if (argv[0] === tools.pdfinfo) return { stdout: "Pages: 2\n" };
    return { stdout: "\u0001\u0001\u0001\u0002\u0001\n" };
  });
  const second = await readPdfInfo(glyph, tools, file);
  assert.equal(second.hasTextLayer, false);
  assert.match(second.notes.join("\n"), /描边字形/u);
});

test("extractPdfText：按分页符切开，页码从 first 起算", async () => {
  const file = join(tempDir(), "manual.pdf");
  writeFileSync(file, "x");
  const sub = fakeSubprocess(() => ({ stdout: "第一页正文\n\f第二页正文\n\f" }));
  const text = await extractPdfText(sub, tools, file, { first: 57, last: 58 });
  assert.equal(text.ok, true);
  assert.equal(text.pages[0]?.page, 57);
  assert.match(text.pages[0]?.text ?? "", /第一页正文/u);
  assert.equal(text.pages[1]?.page, 58);
  const argv = sub.calls[0]?.argv ?? [];
  assert.equal(argv.includes("-layout"), true);
  assert.equal(argv[argv.indexOf("-f") + 1], "57");
  assert.equal(argv[argv.indexOf("-l") + 1], "58");
});

test("listFigures：目录行带页号，正文图注只有标题，重复只留一条", () => {
  const figures = listFigures(
    [
      "Figure 14.   VREFINT vs. temperature . . . . . . . . . . . . 44",
      "Figure 19.   HSI48 frequency versus temperature . . . . . . 60",
      "                         Figure 14. VREFINT vs. temperature",
      "Table 28. General operating conditions . . . 61",
    ].join("\n"),
  );
  assert.equal(figures.length, 2);
  assert.equal(figures[0]?.number, "14");
  assert.match(figures[0]?.title ?? "", /VREFINT vs\. temperature/u);
  assert.equal(figures[0]?.page, 44);
  assert.equal(figures[1]?.page, 60);
});

test("renderPdfPage：裁切参数按像素透传，渲染失败给人话", async () => {
  const file = join(tempDir(), "manual.pdf");
  writeFileSync(file, "x");
  const sub = fakeSubprocess(() => ({ exitCode: 1, stderr: "Syntax Error: Couldn't find trailer dictionary" }));
  const render = await renderPdfPage(sub, tools, file, { page: 44, dpi: 400, crop: { x: 340, y: 260, width: 1140, height: 720 } });
  assert.equal(render.ok, false);
  assert.match(render.error, /pdftoppm/u);
  const argv = sub.calls[0]?.argv ?? [];
  assert.equal(argv[argv.indexOf("-r") + 1], "400");
  assert.equal(argv[argv.indexOf("-x") + 1], "340");
  assert.equal(argv[argv.indexOf("-W") + 1], "1140");
  assert.equal(argv[argv.indexOf("-H") + 1], "720");
});

test("PDF 能力只依赖 poppler", () => {
  assert.deepEqual(CAPABILITY_COMPONENTS.pdf, ["poppler"]);
});
