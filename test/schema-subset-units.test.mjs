// 宿主 schema 子集守卫：dsh 0.2.2 起，工具注册只接受一个极小的 JSON Schema 关键字集合，
// 多写一个 minimum / maximum / $ref / additionalProperties-as-schema 就会抛
// UNSUPPORTED_SCHEMA，整个工具注册失败（register 里校验 output.schema，参数在 PTC 渲染与
// sandbox 路径上校验）。
//
// 这里做两件事：
//   1) 用一个与宿主语义等价的镜像校验器，扫全部工具注册的 parameters 与 output.schema；
//   2) 若本机能找到 DSH 的 app.asar，就从里面抽出宿主真正的 dsh-tools/lib/types/json-schema.js，
//      用真校验器再跑一遍同一批 schema（真值对齐，防镜像漂移）。
//
// 运行：node test/schema-subset-units.test.mjs（需先 npm run build）
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

// ── 宿主 0.2.2 允许的关键字（摘自 dsh-tools/lib/types/json-schema.js） ──────────
const CONSTRAINT_KEYWORDS = new Set(["type", "oneOf", "properties", "required", "additionalProperties", "items", "enum", "const"]);
const ANNOTATION_KEYWORDS = new Set(["description", "title", "default", "examples"]);
const SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function typeMatches(type, value) {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number";
  return typeof value === type;
}

/**
 * 与宿主 assertSupportedJsonSchema 等价的镜像：
 * - 只认上面的关键字；boolean schema 作为节点不允许；type 必须是单个字符串；
 * - properties/required/additionalProperties 只能挂在 type:"object"，items 只能挂在 type:"array"；
 * - additionalProperties 必须是 boolean；required 里的名字必须在 properties 里；
 * - enum/const 只能配标量 type，enum 非空且元素类型一致、不能重复；
 * - oneOf 至少 2 支，不能与 type/properties/required/additionalProperties/items/enum/const 并列；
 * - 同一 schema 对象不能出现在自己的祖先链上（circular）。
 */
export function schemaViolations(root) {
  const violations = [];
  const walk = (node, path, ancestors) => {
    if (node === true || node === false) {
      violations.push(path + ": boolean schema 不再是合法节点");
      return;
    }
    if (!isPlainObject(node)) {
      violations.push(path + ": schema 必须是对象");
      return;
    }
    if (ancestors.has(node)) {
      violations.push(path + ": circular schema（同一个对象出现在自己的祖先链上）");
      return;
    }
    ancestors.add(node);
    try {
      for (const key of Object.keys(node)) {
        if (CONSTRAINT_KEYWORDS.has(key) || ANNOTATION_KEYWORDS.has(key)) continue;
        violations.push(path + "." + key + " 是宿主不支持的 schema 关键字（只允许 type/oneOf/properties/required/additionalProperties/items/enum/const + 注解）");
      }

      for (const key of ["description", "title"]) {
        if (node[key] !== undefined && typeof node[key] !== "string") violations.push(path + "." + key + " 必须是 string");
      }
      for (const key of ["default", "examples"]) {
        if (node[key] !== undefined) {
          try {
            JSON.parse(JSON.stringify(node[key]));
          } catch {
            violations.push(path + "." + key + " 必须是 JSON 可序列化的值");
          }
        }
      }

      const type = node.type;
      const hasOneOf = Array.isArray(node.oneOf);
      if (type === undefined && !hasOneOf) {
        for (const key of ["properties", "required", "additionalProperties", "items", "enum", "const"]) {
          if (node[key] !== undefined) violations.push(path + "." + key + " 缺少 type/oneOf，宿主不会接受");
        }
      }
      if (type !== undefined) {
        if (typeof type !== "string") {
          violations.push(path + ".type 必须是单个字符串（type 数组不支持）");
        } else if (!SCHEMA_TYPES.has(type)) {
          violations.push(path + ".type 不支持 " + JSON.stringify(type));
        }
      }
      if (type !== undefined && hasOneOf) violations.push(path + " 不能同时有 type 和 oneOf");

      if (hasOneOf) {
        if (node.oneOf.length < 2) violations.push(path + ".oneOf 至少要 2 个分支");
        for (const key of ["properties", "required", "additionalProperties", "items", "enum", "const"]) {
          if (node[key] !== undefined) violations.push(path + " 的 oneOf 不能与 " + key + " 并列");
        }
        node.oneOf.forEach((branch, index) => walk(branch, path + ".oneOf[" + String(index) + "]", ancestors));
      }

      if (type === "object") {
        if (node.properties !== undefined && !isPlainObject(node.properties)) {
          violations.push(path + ".properties 必须是对象");
        } else {
          for (const [name, child] of Object.entries(node.properties ?? {})) {
            walk(child, path + ".properties." + name, ancestors);
          }
        }
        if (node.required !== undefined) {
          if (!Array.isArray(node.required) || node.required.some((name) => typeof name !== "string")) {
            violations.push(path + ".required 必须是字符串数组");
          } else {
            for (const name of node.required) {
              if (!isPlainObject(node.properties) || !Object.prototype.hasOwnProperty.call(node.properties, name)) {
                violations.push(path + '.required 里的 "' + name + '" 不在 properties 里');
              }
            }
          }
        }
        if (node.additionalProperties !== undefined && typeof node.additionalProperties !== "boolean") {
          violations.push(path + ".additionalProperties 必须是 boolean（不能带值 schema）");
        }
      } else {
        for (const key of ["properties", "required", "additionalProperties"]) {
          if (node[key] !== undefined) violations.push(path + "." + key + " 只能用在 type:\"object\" 上");
        }
      }

      if (type === "array") {
        if (node.items !== undefined) walk(node.items, path + ".items", ancestors);
      } else if (node.items !== undefined) {
        violations.push(path + ".items 只能用在 type:\"array\" 上");
      }

      const scalar = type === "string" || type === "number" || type === "integer" || type === "boolean";
      if (node.enum !== undefined) {
        if (!Array.isArray(node.enum) || node.enum.length === 0) {
          violations.push(path + ".enum 必须是非空数组");
        } else if (!scalar) {
          violations.push(path + ".enum 只能用在标量 type 上");
        } else {
          const seen = new Set();
          for (const item of node.enum) {
            if (!typeMatches(type, item)) violations.push(path + ".enum 元素 " + JSON.stringify(item) + " 与 type " + type + " 不匹配");
            const key = JSON.stringify(item);
            if (seen.has(key)) violations.push(path + ".enum 元素重复：" + key);
            seen.add(key);
          }
        }
      }
      if (node.const !== undefined) {
        if (!scalar) violations.push(path + ".const 只能用在标量 type 上");
        else if (!typeMatches(type, node.const)) violations.push(path + ".const 与 type " + type + " 不匹配");
      }
    } finally {
      ancestors.delete(node);
    }
  };
  walk(root, "schema", new Set());
  return violations;
}

// ── 抓取插件注册的全部工具（stub ctx，不启动任何服务） ─────────────────────────
async function collectTools() {
  const mod = await import(pathToFileURL(join(process.cwd(), "lib", "index.js")).href);
  const tools = [];
  const noop = () => {};
  const base = {
    tools: {
      register(def) {
        tools.push(def);
        return noop;
      },
    },
    inject: (_deps, fn) => {
      try {
        fn(base);
      } catch {
        /* 命令/技能注册失败与 schema 无关，忽略 */
      }
    },
    on: noop,
    emit: noop,
    effect: noop,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    subprocess: { spawn: noop, resolveExecutable: async () => "" },
    jobs: { start: () => "job" },
  };
  const ctx = new Proxy(base, { get: (target, key) => (key in target ? target[key] : undefined) });
  mod.apply(ctx);
  return tools;
}

test("schema 子集：全部工具的参数与输出都只用宿主 0.2.2 放行的关键字", async () => {
  const tools = await collectTools();
  assert.ok(tools.length >= 25, "注册到的工具太少（实际 " + String(tools.length) + "），apply 可能没跑完");
  const problems = [];
  for (const def of tools) {
    for (const violation of schemaViolations(def.parameters)) problems.push(def.name + " [parameters] " + violation);
    assert.ok(def.output?.schema !== undefined, def.name + " 缺少 output.schema");
    for (const violation of schemaViolations(def.output.schema)) problems.push(def.name + " [output.schema] " + violation);
  }
  assert.deepEqual(problems, [], "宿主 0.2.2 会拒绝这些 schema：\n" + problems.join("\n"));
});

// ── 真值对齐：能从 app.asar 抽到宿主的 json-schema.js 就用它再验一遍 ──────────
// Electron 运行时会接管 fs，把 app.asar 当目录看；这里要的是 asar 的原始字节，
// 所以优先用 original-fs（Electron 内置的未打补丁版本），拿不到再退回 node:fs。
function rawReadFileSync(path) {
  try {
    const original = createRequire(import.meta.url)("original-fs");
    return typeof original.readFileSync === "function" ? original.readFileSync(path) : null;
  } catch {
    return null;
  }
}

function asarExtract(asarPath, innerPath) {
  const bytes = rawReadFileSync(asarPath) ?? readFileSync(asarPath);
  const headerSize = bytes.readUInt32LE(4);
  const jsonLen = bytes.readUInt32LE(12);
  const root = JSON.parse(bytes.subarray(16, 16 + jsonLen).toString("utf8"));
  const dataStart = (8 + headerSize + 3) & ~3;
  let node = root;
  for (const part of innerPath.split("/")) {
    node = node?.files?.[part];
    if (node === undefined) return null;
  }
  if (node.files !== undefined) return null;
  return bytes.subarray(dataStart + Number(node.offset), dataStart + Number(node.offset) + Number(node.size));
}

test("真值对齐：宿主真校验器与本测试镜像对同一批 schema 结论一致", async () => {
  const candidates = [
    process.env.DSH_ASAR,
    "D:/app/DeepSeek Harness/resources/app.asar",
    "C:/Program Files/DeepSeek Harness/resources/app.asar",
  ].filter((item) => typeof item === "string" && item !== "" && existsSync(item));
  if (candidates.length === 0) {
    console.log("跳过：本机没有 DSH 的 app.asar（可用 DSH_ASAR 指定）");
    return;
  }
  const source = asarExtract(candidates[0], "node_modules/@deepseek-ai/dsh-tools/lib/types/json-schema.js")
    ?? asarExtract(candidates[0], "dsh/node_modules/@deepseek-ai/dsh-tools/lib/types/json-schema.js");
  if (source === null) {
    console.log("跳过：asar 里没找到 dsh-tools 的 json-schema.js（安装布局可能变了）");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "dsh-stm32-schema-"));
  // 宿主模块 import 两个内部包（@deepseek-ai/dsh-llm 的 HarnessError、
  // @deepseek-ai/dsh-util-values 的 isJsonValue/assertNever）。这里用行为等价的小桩替换，
  // 否则要顺带抽整棵依赖树。桩只服务于"校验结论"，与业务无关。
  writeFileSync(join(dir, "stub-llm.mjs"), [
    "export class HarnessError extends Error {",
    "  constructor(code, message) { super(typeof message === 'string' ? message : String(code)); this.code = code; }",
    "}",
  ].join("\n"), "utf8");
  writeFileSync(join(dir, "stub-values.mjs"), [
    "export function assertNever(value, label) { throw new Error((label ?? 'value') + ' 走到不该走的分支：' + String(value)); }",
    "export function isJsonValue(value, seen) {",
    "  const visited = seen ?? new Set();",
    "  if (value === null) return true;",
    "  const type = typeof value;",
    "  if (type === 'string' || type === 'boolean') return true;",
    "  if (type === 'number') return Number.isFinite(value);",
    "  if (type !== 'object' || visited.has(value)) return false;",
    "  visited.add(value);",
    "  try {",
    "    if (Array.isArray(value)) return value.every((item) => isJsonValue(item, visited));",
    "    const proto = Object.getPrototypeOf(value);",
    "    if (proto !== Object.prototype && proto !== null) return false;",
    "    return Object.values(value).every((item) => isJsonValue(item, visited));",
    "  } finally { visited.delete(value); }",
    "}",
  ].join("\n"), "utf8");
  const patched = source.toString("utf8")
    .replace("from '@deepseek-ai/dsh-llm'", "from './stub-llm.mjs'")
    .replace("from '@deepseek-ai/dsh-util-values'", "from './stub-values.mjs'");
  const file = join(dir, "host-json-schema.mjs");
  writeFileSync(file, patched, "utf8");
  const host = await import(pathToFileURL(file).href);
  const tools = await collectTools();
  const mismatches = [];
  for (const def of tools) {
    for (const [label, schema] of [["parameters", def.parameters], ["output.schema", def.output?.schema]]) {
      let hostError = null;
      try {
        host.assertSupportedJsonSchema(schema);
      } catch (error) {
        hostError = Array.isArray(error?.violations) ? error.violations.join("; ") : String(error);
      }
      const mirror = schemaViolations(schema);
      if ((hostError === null) !== (mirror.length === 0)) {
        mismatches.push(def.name + " [" + label + "] 宿主=" + (hostError ?? "ok") + " / 镜像=" + (mirror.join("; ") || "ok"));
      }
    }
  }
  assert.deepEqual(mismatches, [], "镜像与宿主真校验器结论不一致：\n" + mismatches.join("\n"));
});
