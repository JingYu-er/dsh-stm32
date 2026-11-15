import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { locatePoppler } from "../lib/engine/pdf/toolchain.js";
import { extractPdfText, listFigures, readPdfInfo, renderPdfPage } from "../lib/engine/pdf/reader.js";
import { extractTablesFromWords, parseBboxXml } from "../lib/engine/pdf/tables.js";
import { calibrateFromWords, chromaBounds, digitizeCurves, legendLabels } from "../lib/engine/pdf/curve.js";
import { decodePng } from "../lib/engine/pdf/png.js";
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


function wordBox(text, x0, y0, width = 24) {
  return { text, x0, y0, x1: x0 + width, y1: y0 + 9 };
}

function pageOf(rows) {
  return { width: 600, height: 800, words: rows.flat() };
}

test("parseBboxXml 解实体并按页分组", () => {
  const xml = [
    '<html><body><doc>',
    '<page width="612.000" height="792.000">',
    '<word xMin="10.0" yMin="20.0" xMax="34.0" yMax="29.0">A&amp;B</word>',
    "<word xMin=\"40.0\" yMin=\"20.0\" xMax=\"64.0\" yMax=\"29.0\">2</word>",
    '</page>',
    '<page width="612.000" height="792.000"></page>',
    '</doc></body></html>',
  ].join("\n");
  const pages = parseBboxXml(xml);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].width, 612);
  assert.equal(pages[0].words.length, 2);
  assert.equal(pages[0].words[0].text, "A&B");
  assert.equal(pages[0].words[0].x1, 34);
  assert.equal(pages[1].words.length, 0);
});

test("两列参数表能切出来，句子段落被丢掉", () => {
  const table = [
    [wordBox("HCLK", 40, 100, 30), wordBox("LATENCY", 160, 100, 50)],
    [wordBox("≤", 40, 116, 8), wordBox("24", 52, 116, 12), wordBox("000", 160, 116, 20), wordBox("(1", 184, 116, 12), wordBox("cycle)", 200, 116, 34)],
    [wordBox("≤", 40, 132, 8), wordBox("48", 52, 132, 12), wordBox("001", 160, 132, 20), wordBox("(2", 184, 132, 12), wordBox("cycles)", 200, 132, 40)],
  ];
  const prose = [
    [wordBox("To", 40, 200, 14), wordBox("set", 58, 200, 16), wordBox("the", 78, 200, 16), wordBox("latency,", 98, 200, 40), wordBox("write", 142, 200, 26)],
    [wordBox("FLASH_ACR", 40, 212, 60), wordBox("register", 104, 212, 40), wordBox("first,", 148, 212, 26), wordBox("then", 178, 212, 24)],
  ].flat();
  const page = pageOf([...table, prose]);
  const tables = extractTablesFromWords(page, { page: 59 });
  assert.equal(tables.length, 1);
  const found = tables[0];
  assert.equal(found.columns.length, 2);
  assert.equal(found.cells[0][0], "HCLK");
  assert.equal(found.cells[1][0], "≤ 24");
  assert.equal(found.cells[2][1], "001 (2 cycles)");
  assert.ok(!found.cells.some((row) => row.join(" ").includes("FLASH_ACR")));
});

test("曲线标定：成列纵轴 + 成行横轴各自拟合（S122）", () => {
  const words = [];
  // 纵轴 1.235 … 1.185，每格 0.005，向下像素递增
  for (let index = 0; index < 11; index += 1) {
    words.push({ text: (1.235 - index * 0.005).toFixed(3), x0: 100, y0: 200 + index * 40, x1: 130, y1: 210 + index * 40 });
  }
  // 横轴 −40 … 120，每格 20，向右像素递增
  for (let index = 0; index < 9; index += 1) {
    words.push({ text: String(-40 + index * 20), x0: 200 + index * 50, y0: 700, x1: 220 + index * 50, y1: 712 });
  }
  const calibrated = calibrateFromWords(words);
  assert.equal(calibrated.ok, true);
  const x = calibrated.calibration.x;
  const y = calibrated.calibration.y;
  assert.equal(x.ticks.length, 9);
  assert.equal(y.ticks.length, 11);
  // pixel 200 → 值 1.235；pixel 240 → 1.230
  assert.ok(Math.abs(y.a * 205 + y.b - 1.235) < 0.0001);
  assert.ok(Math.abs(y.a * 245 + y.b - 1.23) < 0.0001);
});

test("曲线标定：数字太少或纵轴刻度全相同则明确失败（S122）", () => {
  const few = calibrateFromWords([{ text: "1.2", x0: 0, y0: 0, x1: 10, y1: 10 }]);
  assert.equal(few.ok, false);
  const flat = [];
  for (let index = 0; index < 5; index += 1) {
    flat.push({ text: "3.3", x0: 50, y0: 100 + index * 20, x1: 70, y1: 110 + index * 20 });
  }
  for (let index = 0; index < 5; index += 1) {
    flat.push({ text: String(index), x0: 100 + index * 20, y0: 500, x1: 110 + index * 20, y1: 510 });
  }
  assert.equal(calibrateFromWords(flat).ok, false);
});

test("曲线采样：按色相取每条线的中位数，坐标轴范围外的装饰被丢弃（S122）", () => {
  const width = 200;
  const height = 80;
  const rgba = new Uint8Array(width * height * 4).fill(255);
  const paint = (x, y, r, g, b) => {
    const index = (y * width + x) * 4;
    rgba[index] = r;
    rgba[index + 1] = g;
    rgba[index + 2] = b;
    rgba[index + 3] = 255;
  };
  for (let x = 5; x < 195; x += 1) {
    paint(x, 30, 255, 0, 170); // 品红曲线
    paint(x, 50, 0, 224, 224); // 青色曲线
    paint(x, 78, 51, 153, 255); // 蓝色：轴外装饰
  }
  const calibration = {
    x: { a: 1, b: 0, ticks: [{ value: 0, pixel: 10 }, { value: 100, pixel: 110 }], unit: "" },
    y: { a: -1, b: 60, ticks: [{ value: 10, pixel: 50 }, { value: 40, pixel: 20 }], unit: "" },
    notes: [],
  };
  const result = digitizeCurves({ width, height, rgba }, calibration, { maxPoints: 8 });
  const hues = result.series.map((item) => item.hue).sort();
  assert.deepEqual(hues, ["cyan", "magenta"]);
  const magenta = result.series.find((item) => item.hue === "magenta");
  assert.ok(magenta.points.length > 2);
  assert.ok(magenta.points.every((point) => Math.abs(point.y - 30) < 0.001));
});

test("PNG 解码：拒绝非 PNG 与 16 位图（S122）", () => {
  const bad = decodePng(Buffer.from("not a png"));
  assert.equal(bad.ok, false);
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from("IHDR", "latin1"),
    Buffer.from([0, 0, 0, 4, 0, 0, 0, 4, 16, 2, 0, 0, 0]),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from("IEND", "latin1"),
    Buffer.from([0, 0, 0, 0]),
  ]);
  const sixteen = decodePng(png);
  assert.equal(sixteen.ok, false);
});

function makeImage(width, height, paint) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const [r, g, b] = paint(x, y);
      rgba[at] = r; rgba[at + 1] = g; rgba[at + 2] = b; rgba[at + 3] = 255;
    }
  }
  return { width, height, rgba };
}

test("曲线：彩色像素外接框避开灰度背景（S124）", () => {
  const image = makeImage(60, 40, (x, y) => (x >= 10 && x <= 30 && y >= 8 && y <= 20 ? [255, 0, 0] : [240, 240, 240]));
  const bounds = chromaBounds(image, 2);
  assert.ok(bounds !== null);
  assert.equal(bounds.x0, 8);
  assert.equal(bounds.x1, 32);
  assert.equal(bounds.y0, 6);
  assert.equal(bounds.y1, 22);
  const gray = makeImage(20, 20, () => [128, 128, 128]);
  assert.equal(chromaBounds(gray), null, "纯灰度图没有彩色像素");
});

test("曲线：图例文字按左侧色块认出名字（S124）", () => {
  // 左侧一条红色线段（图例色块），右侧是文字框位置。
  const image = makeImage(120, 40, (x, y) => (x >= 20 && x <= 34 && y >= 18 && y <= 21 ? [255, 0, 0] : [255, 255, 255]));
  const words = [
    { text: "Mean", x0: 38, y0: 15, x1: 60, y1: 25 },
    { text: "x", x0: 70, y0: 15, x1: 78, y1: 25 },
  ];
  const labels = legendLabels(words, image, null, { scale: 1 });
  assert.equal(labels.get(0), "Mean", "red 桶对应 Mean");
  assert.equal(labels.size, 1, "单字母词不算图例");
});

test("曲线：同页两张图时，刻度按图区范围筛选（S124）", () => {
  const word = (text, x0, y0, x1, y1) => ({ text, x0, y0, x1, y1 });
  const words = [];
  // 左边那张图的纵轴刻度在 x=100，右边那张在 x=900。
  for (let i = 0; i < 5; i += 1) {
    words.push(word(String(1 + i * 0.1), 96, 100 + i * 30, 120, 110 + i * 30));
    words.push(word(String(3 + i * 0.1), 896, 100 + i * 30, 920, 110 + i * 30));
  }
  // 横轴刻度：左图在 y=260，右图在 y=380。
  for (let i = 0; i < 5; i += 1) {
    words.push(word(String(-40 + i * 40), 130 + i * 60, 250, 160 + i * 60, 268));
    words.push(word(String(200 + i * 40), 930 + i * 60, 370, 960 + i * 60, 388));
  }
  const left = calibrateFromWords(words, { scale: 1, bounds: { x0: 120, y0: 90, x1: 460, y1: 280 } });
  assert.equal(left.ok, true);
  assert.ok(left.calibration.y.ticks.every((tick) => tick.value < 2), "纵轴只取左图那一列");
  assert.ok(left.calibration.x.ticks.every((tick) => tick.value <= 200), "横轴只取左图那一行");
  const right = calibrateFromWords(words, { scale: 1, bounds: { x0: 900, y0: 90, x1: 1240, y1: 400 } });
  assert.equal(right.ok, true);
  assert.ok(right.calibration.x.ticks.every((tick) => tick.value >= 200), "右图取到 200 起的刻度");
});
