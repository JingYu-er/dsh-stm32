#!/usr/bin/env node
/**
 * 从 CubeMX 的 MCU 数据库（<CubeMX 根>/db/mcu/*.xml）抽一张「薄表」写到 src/data/chip-table.json。
 *
 *   node scripts/gen-chip-table.mjs                              # 生成 / 刷新薄表
 *   node scripts/gen-chip-table.mjs --check                      # 只校验（CI）：与 db 不一致就退 1
 *   node scripts/gen-chip-table.mjs --cube-mx-root D:/app/STM32CubeMX
 *   node scripts/gen-chip-table.mjs --mcu-dir D:/app/STM32CubeMX/db/mcu --out D:/tmp/chip-table.json
 *   node scripts/gen-chip-table.mjs --allow-small                # 允许生成「不像整份 db」的小表
 *
 * 为什么要薄表：完整 db 是 2000 多个 XML、几十 MB，既进不了仓库也进不了发行包；
 * 这里每颗芯片只留 10 个字段（名字 / 订货号模板 / 族 / 内核 / 主频 / RAM / Flash / 电压 / 引脚数），
 * 全族约 100 KB。插件目前只消费 F1 行（给 resolveF1Chip 与 doctor 的一致性检查当参照），
 * 其余族留着备查——将来扩到 F4/G0 时不必再要一台装了 CubeMX 的机器。
 *
 * 数据来源是本机 CubeMX 安装目录，脚本不联网。安装位置不必手填：先看 --mcu-dir / --cube-mx-root /
 * STM32_CUBEMX_ROOT / ~/.dsh-stm32/config.json，再退到常见安装位置与扫盘发现（装在 D:/app 也能找到）。
 * 找不到 db 就友好失败（退 2），**不写半截文件**：
 * 表在内存里整个生成完、过了自检才一次性写盘。
 *
 * 不要手改 src/data/chip-table.json：它是生成物，改了下次 --check 就会红。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const DEFAULT_OUT = join(repoRoot, "src", "data", "chip-table.json");

/** 与 src/data/search-roots.ts 的内置默认值保持一致（Windows 默认安装位置）。 */
const DEFAULT_CUBEMX_ROOTS = ["C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeMX"];

/** 列顺序即 rows 里每个数组的下标，改这里必须同时改文件头的 columns 与文档。 */
const COLUMNS = ["name", "cpn", "family", "core", "mhz", "ramKiB", "flashKiB", "vMin", "vMax", "pins"];

/**
 * 少于这个数就认为 db 目录选错了（整份 db 有 2016 颗）。
 * 用阈值而不是「必须等于 2016」：ST 每次发版都会增删芯片，卡死具体数字会让 CI 无缘无故红。
 */
const MIN_EXPECTED_ROWS = 1000;

class UserError extends Error {}

function fail(message) {
  throw new UserError(message);
}

/** 解析命令行；不认识的选项直接报错，免得打错一个字母就静默生成到默认路径。 */
export function parseArgs(argv) {
  const options = {
    check: false,
    allowSmall: false,
    help: false,
    out: DEFAULT_OUT,
    mcuDir: "",
    cubeMxRoots: [],
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) fail(arg + " 后面要跟一个路径");
      i += 1;
      return value;
    };
    switch (arg) {
      case "--check":
        options.check = true;
        break;
      case "--allow-small":
        options.allowSmall = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--out":
        options.out = resolve(next());
        break;
      case "--mcu-dir":
        options.mcuDir = resolve(next());
        break;
      case "--cube-mx-root":
        options.cubeMxRoots.push(resolve(next()));
        break;
      default:
        fail("不认识的参数：" + arg + "（可用：--check / --allow-small / --mcu-dir <dir> / --cube-mx-root <dir> / --out <file> / --help）");
    }
  }
  return options;
}

/** 读 ~/.dsh-stm32/config.json 里的 cubeMxRoot；坏了当没有（与插件的行为一致）。 */
function configuredCubeMxRoot(env) {
  if (/^(1|true)$/i.test((env.DSH_STM32_NO_CONFIG ?? "").trim())) return "";
  const explicit = (env.DSH_STM32_CONFIG ?? "").trim();
  const home = (env.USERPROFILE ?? env.HOME ?? "").trim();
  const file = explicit !== "" ? explicit : home !== "" ? join(home, ".dsh-stm32", "config.json") : "";
  if (file === "" || !existsSync(file)) return "";
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed?.cubeMxRoot === "string" ? parsed.cubeMxRoot.trim() : "";
  } catch {
    return "";
  }
}

/** 优先级：--mcu-dir > --cube-mx-root > STM32_CUBEMX_ROOT > 配置文件 > 内置默认值。 */
export function cubeMxRootCandidates(options, env) {
  const roots = [];
  const push = (value) => {
    const cleaned = String(value ?? "").trim().replace(/^"|"$/g, "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (cleaned !== "" && !roots.includes(cleaned)) roots.push(cleaned);
  };
  for (const root of options.cubeMxRoots) push(root);
  for (const root of (env.STM32CUBEMX_ROOT ?? env.STM32_CUBEMX_ROOT ?? "").split(";")) push(root);
  push(configuredCubeMxRoot(env));
  for (const root of DEFAULT_CUBEMX_ROOTS) push(root);
  for (const root of discoverCubeMxRoots(env)) push(root);
  return roots;
}

/**
 * 在常见安装位置里扫 CubeMX 根（装到 D:/app 之类非默认位置时也能直接跑）。
 * 与 src/data/search-roots.ts 的 discoverCubeMxRoots 同思路，但只扫目录、不读注册表：
 * 这个脚本是开发者工具，扫不到就让人用 --cube-mx-root 指过来，不值得为它起 reg.exe。
 */
export function discoverCubeMxRoots(env, probe) {
  const exists = probe?.exists ?? existsSync;
  const listDirs = (dir) => {
    try {
      return readdirSync(dir)
        .map((name) => dir.replace(/\/+$/u, "") + "/" + name)
        .filter((child) => {
          try {
            return statSync(child).isDirectory();
          } catch {
            return false;
          }
        });
    } catch {
      return [];
    }
  };
  const isRoot = (dir) => exists(dir + "/STM32CubeMX.exe") && exists(dir + "/jre/bin/java.exe");
  const bases = [];
  for (let code = 65; code <= 90; code += 1) {
    const drive = String.fromCharCode(code) + ":";
    if (!exists(drive + "/")) continue;
    bases.push(
      drive + "/",
      drive + "/app",
      drive + "/tools",
      drive + "/Program Files/STMicroelectronics/STM32Cube",
      drive + "/Program Files (x86)/STMicroelectronics/STM32Cube",
    );
  }
  const localAppData = (env.LOCALAPPDATA ?? "").trim();
  if (localAppData !== "") bases.push(localAppData.replace(/\\/gu, "/").replace(/\/+$/u, "") + "/Programs");
  const found = [];
  for (const base of bases) {
    if (!exists(base)) continue;
    const direct = base.replace(/\/+$/u, "") + "/STM32CubeMX";
    if (isRoot(direct) && !found.includes(direct)) found.push(direct);
    for (const child of listDirs(base)) {
      if (isRoot(child) && !found.includes(child)) found.push(child);
    }
  }
  return found;
}

/** 找到一份能用的 db/mcu 目录；找不到就抛 UserError 并列出查过哪些地方。 */
export function resolveMcuDir(options, env) {
  const tried = [];
  const accept = (dir) => {
    if (dir === "" || tried.includes(dir)) return "";
    tried.push(dir);
    try {
      if (!statSync(dir).isDirectory()) return "";
    } catch {
      return "";
    }
    const xmls = readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".xml"));
    return xmls.length > 0 ? dir : "";
  };
  if (options.mcuDir !== "") {
    const hit = accept(options.mcuDir);
    if (hit !== "") return hit;
    fail("--mcu-dir 指向的目录里没有 .xml：" + options.mcuDir);
  }
  for (const root of cubeMxRootCandidates(options, env)) {
    const hit = accept(join(root, "db", "mcu"));
    if (hit !== "") return hit;
  }
  fail(
    "找不到 CubeMX 的 MCU 数据库（db/mcu/*.xml）。查过：\n" +
      tried.map((dir) => "  - " + dir).join("\n") +
      "\n装好 CubeMX 后重试，或用 --cube-mx-root <CubeMX 安装根> / --mcu-dir <db/mcu> 直接指过去。",
  );
}

/** 取标签文本（第一个匹配），没有就是 null。 */
function tagText(raw, tag) {
  const m = new RegExp("<" + tag + ">([^<]*)</" + tag + ">").exec(raw);
  return m === null ? null : m[1].trim();
}

/** 取标签的全部出现（<Flash>16</Flash> 会有多条，对应括号里的多个备选密度）。 */
function tagTexts(raw, tag) {
  return [...raw.matchAll(new RegExp("<" + tag + ">([^<]*)</" + tag + ">", "g"))].map((m) => m[1].trim());
}

/** 解析一个属性串（Max="3.6" Min="2"），属性顺序不固定。 */
function attrMap(text) {
  const attrs = {};
  for (const m of text.matchAll(/([A-Za-z][A-Za-z0-9]*)="([^"]*)"/g)) attrs[m[1]] = m[2];
  return attrs;
}

/** "Arm Cortex-M0+" → "M0+"、"ARM Cortex-A35" → "A35"：只留能区分型号的那一段。 */
export function normalizeCore(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return null;
  return text.replace(/^(?:Arm|ARM)\s+/, "").replace(/^Cortex-/, "");
}

/** 数字或数字数组：去重后只剩一个就当标量（多数芯片的多个备选密度 RAM 是共用的）。 */
export function numberOrNumbers(values) {
  const unique = [...new Set(values)];
  return unique.length <= 1 ? (unique[0] ?? null) : unique;
}

/**
 * 由 RefName 展开订货号模板：括号里是备选，按 "-" 分隔。
 *   STM32F103C(8-B)Tx → ["STM32F103C8Tx", "STM32F103CBTx"]
 *   STM32F103RCTx     → "STM32F103RCTx"
 * 末位的封装 / 温度码在 db 里是通配的（...Tx 对应 T6 / T7 …），所以这里是模板而不是完整 CPN。
 */
export function orderCodeStems(refName) {
  const name = String(refName ?? "").trim();
  const m = /\(([^)]*)\)/.exec(name);
  if (m === null) return name;
  const head = name.slice(0, m.index);
  const tail = name.slice(m.index + m[0].length);
  const stems = m[1]
    .split("-")
    .map((part) => head + part.trim() + tail)
    .filter((stem) => stem !== "");
  const unique = [...new Set(stems)];
  return unique.length <= 1 ? (unique[0] ?? name) : unique;
}

/**
 * 解析一颗芯片；不是 MCU 的 db 文件返回 null。
 * 判据是「整个文档只有一个 <Mcu 元素」：db/mcu 下还有 families.xml（2674 个 <Mcu>）、
 * rules.xml 与 compatibility.xml（0 个），硬编码文件名排除不了以后新增的同类文件。
 */
export function parseMcuXml(raw) {
  if ((raw.match(/<Mcu\s/g) ?? []).length !== 1) return null;
  const opening = /<Mcu\s([^>]*)>/.exec(raw);
  if (opening === null) return null;
  const attrs = attrMap(opening[1]);
  const name = (attrs.RefName ?? "").trim();
  const family = (attrs.Family ?? "").trim();
  if (name === "" || family === "") return null;
  const voltage = /<Voltage\s([^>]*?)\/>/.exec(raw);
  const vAttrs = voltage === null ? {} : attrMap(voltage[1]);
  const mhz = tagText(raw, "Frequency");
  const pins = tagText(raw, "IONb");
  return {
    name,
    cpn: orderCodeStems(name),
    family,
    core: normalizeCore(tagText(raw, "Core")),
    mhz: mhz === null ? null : Number(mhz),
    ramKiB: numberOrNumbers(tagTexts(raw, "Ram").map(Number).filter((n) => Number.isFinite(n))),
    flashKiB: numberOrNumbers(tagTexts(raw, "Flash").map(Number).filter((n) => Number.isFinite(n))),
    vMin: vAttrs.Min === undefined ? null : Number(vAttrs.Min),
    vMax: vAttrs.Max === undefined ? null : Number(vAttrs.Max),
    pins: pins === null ? null : Number(pins),
  };
}

/** 按名字排序（纯码点比较，不随 locale 漂，--check 才能稳定）。 */
function compareNames(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** 从 mcu 目录读全表；重复名字直接报错（否则 .ioc 反查会静默选错一颗）。 */
export function buildTable(mcuDir, options = {}) {
  const files = readdirSync(mcuDir)
    .filter((fileName) => fileName.toLowerCase().endsWith(".xml"))
    .sort();
  const rows = [];
  const seen = new Map();
  for (const fileName of files) {
    const entry = parseMcuXml(readFileSync(join(mcuDir, fileName), "utf8"));
    if (entry === null) continue;
    if (seen.has(entry.name)) fail("型号重复：" + entry.name + "（" + seen.get(entry.name) + " 与 " + fileName + "）");
    seen.set(entry.name, fileName);
    rows.push(entry);
  }
  rows.sort(compareNames);
  if (rows.length === 0) fail(mcuDir + " 里没解析出任何芯片（目录选错了？）");
  if (rows.length < MIN_EXPECTED_ROWS && options.allowSmall !== true) {
    fail(
      "只解析出 " + rows.length + " 颗芯片（整份 db 有 2016 颗）——db 目录选错了吗？\n" +
        "确实只想生成一张小表就加 --allow-small。",
    );
  }
  return rows;
}

/** 渲染成 JSON 文本：顶层缩进好读，rows 一行一颗，diff 才看得懂。 */
export function render(rows) {
  const header = {
    schema: 1,
    source: "CubeMX db/mcu/*.xml（本机安装目录，脚本不联网）",
    count: rows.length,
    columns: COLUMNS,
    notes: [
      "生成物，不要手改：改数据跑 node scripts/gen-chip-table.mjs（--check 只校验）。",
      "每行是一个数组，字段顺序见 columns。",
      "name 是 db 里的 RefName，也是 .ioc 的 Mcu.Name / db 文件名，用来反查芯片。",
      "cpn 是订货号模板（括号备选展开、末位封装温度码写作 x）：单值字符串，多值数组，如 STM32F100C(4-6)Tx → [STM32F100C4Tx, STM32F100C6Tx]；没有括号备选、与 name 完全相同时写 null（省 30KB，读的时候回落到 name）。",
      "mhz 为 null 表示 CubeMX 的 db 没声明主频；ramKiB / flashKiB 为数组表示这颗芯片覆盖多个密度档（已去重）。",
      "vMin / vMax 为 null 表示 db 没写电压范围；pins 是 <IONb>（可用 IO 数，不是封装总脚数）。",
      "插件当前只消费 family=STM32F1 的行，其余族留作扩族时的参照。",
    ],
  };
  const lines = [];
  lines.push("{");
  for (const [key, value] of Object.entries(header)) {
    // 标量也要过 JSON.stringify：字符串不引起来就不是 JSON 了（source 那行裸奔过一次）。
    const body = Array.isArray(value) ? JSON.stringify(value, null, 2).replace(/\n/g, "\n  ") : JSON.stringify(value);
    lines.push("  " + JSON.stringify(key) + ": " + body + ",");
  }
  lines.push('  "rows": [');
  rows.forEach((row, index) => {
    const tuple = COLUMNS.map((column) => {
      // cpn 是从 name 展开的：没有括号备选时两者一模一样，再存一遍就是纯冗余（30 KB）。
      if (column === "cpn" && row.cpn === row.name) return null;
      return row[column] ?? null;
    });
    lines.push("  " + JSON.stringify(tuple) + (index === rows.length - 1 ? "" : ","));
  });
  lines.push("  ]");
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

/** --check 的差异摘要：只看条数与哪些行不同，别把 100 KB 的 diff 倒进 CI 日志。 */
function diffSummary(expected, actual) {
  const lines = actual.split("\n");
  const expectedRows = expected.filter((line) => /^ {2}\[/.test(line));
  const actualRows = lines.filter((line) => /^ {2}\[/.test(line));
  const actualSet = new Set(actualRows);
  const expectedSet = new Set(expectedRows);
  const missing = expectedRows.filter((line) => !actualSet.has(line)).length;
  const extra = actualRows.filter((line) => !expectedSet.has(line)).length;
  return "行数：期望 " + expectedRows.length + "，实际 " + actualRows.length + "（缺 " + missing + " / 多 " + extra + "）";
}

const HELP = [
  "用法：node scripts/gen-chip-table.mjs [选项]",
  "",
  "  （无选项）            从本机 CubeMX db 生成 src/data/chip-table.json",
  "  --check               只校验磁盘上的薄表是否与 db 一致，不一致退 1",
  "  --mcu-dir <dir>       直接用这个 db/mcu 目录",
  "  --cube-mx-root <dir>  CubeMX 安装根（可用多次，按给出顺序试）",
  "                        不给的话按 --mcu-dir > --cube-mx-root > STM32_CUBEMX_ROOT",
  "                        > ~/.dsh-stm32/config.json 的 cubeMxRoot > 默认位置 > 扫盘发现",
  "  --out <file>          输出路径（默认 src/data/chip-table.json）",
  "  --allow-small         允许少于 " + MIN_EXPECTED_ROWS + " 颗芯片（用测试 db 时）",
  "  --help                这份说明",
].join("\n");

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      console.log(HELP);
      return 0;
    }
    const mcuDir = resolveMcuDir(options, process.env);
    const rows = buildTable(mcuDir, options);
    const text = render(rows);
    const families = new Map();
    for (const row of rows) families.set(row.family, (families.get(row.family) ?? 0) + 1);
    const f1 = families.get("STM32F1") ?? 0;
    const bytes = Buffer.byteLength(text, "utf8");
    if (options.check) {
      const existing = existsSync(options.out) ? readFileSync(options.out, "utf8") : null;
      if (existing === null) {
        console.error("✗ " + options.out + " 不存在：先跑一次 node scripts/gen-chip-table.mjs");
        return 1;
      }
      if (existing !== text) {
        console.error("✗ 薄表与 db 不一致，重跑 node scripts/gen-chip-table.mjs 更新：" + options.out);
        console.error("  " + diffSummary(text.split("\n"), existing));
        return 1;
      }
      console.log("✓ 薄表与 db 一致：" + rows.length + " 颗芯片（F1 " + f1 + "），" + bytes + " B <- " + options.out);
      return 0;
    }
    writeFileSync(options.out, text, "utf8");
    console.log(
      "chips=" + rows.length + " families=" + families.size + " f1=" + f1 + " bytes=" + bytes + " -> " + options.out,
    );
    return 0;
  } catch (error) {
    if (error instanceof UserError) {
      console.error("✗ " + error.message);
      return 2;
    }
    throw error;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv);
}
