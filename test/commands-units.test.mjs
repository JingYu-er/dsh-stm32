/**
 * 斜杠命令 + SKILL 的离线单测。
 *
 * 不起任何进程：subprocess 桩在 spawn 时直接抛错，用来验证"命令注册对了、handler 兜住了失败、
 * 文本不是空的"，真实烧录/编译的路径由 e2e-flash / e2e-build 覆盖。
 *
 * 运行：node test\commands-units.test.mjs（不要用 node --test，沙箱下它会 spawn 失败）
 */

import { registerCommands, tokenizeCommandLine } from "../lib/commands/register.js";
import { registerStm32Skill, STM32_SKILL_NAME, SKILL_CONTENT } from "../lib/skill/stm32-workflow.js";

let pass = 0;
let fail = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass += 1;
      console.log("PASS " + name);
    })
    .catch((error) => {
      fail += 1;
      console.log("FAIL " + name + " -> " + (error instanceof Error ? error.message : String(error)));
    });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeContext(workdir) {
  const commands = new Map();
  const skills = new Map();
  const ctx = {
    tools: { register() {} },
    subprocess: {},
    get(name) {
      if (name === "subprocess") {
        return {
          spawn() {
            throw new TypeError("spawn 被离线单测禁用");
          },
          async resolveExecutable() {
            throw new Error("resolveExecutable 被离线单测禁用");
          },
        };
      }
      if (name === "workingDirectory") return { ensure: async () => workdir };
      if (name === "skills") return { register: (skill) => { skills.set(skill.name, skill); return () => {}; } };
      return undefined;
    },
    commands: { register: (definition) => { commands.set(definition.name, definition); return () => {}; } },
  };
  return { ctx, commands, skills };
}

const invocation = (rawInput) => ({ commandId: "c1", agent: { id: "a1" }, rawInput, signal: new AbortController().signal });

await check("注册 6 条命令，名字与描述齐全", () => {
  const { ctx, commands } = makeContext("D:/proj");
  registerCommands(ctx);
  const names = [...commands.keys()].sort();
  assert(JSON.stringify(names) === JSON.stringify(["stm32-build", "stm32-debug", "stm32-doctor", "stm32-env", "stm32-flash", "stm32-stop"]), "命令名不对：" + names.join(","));
  for (const [, definition] of commands) {
    assert(typeof definition.description === "string" && definition.description.length > 8, definition.name + " 缺描述");
    assert(typeof definition.handler === "function", definition.name + " 缺 handler");
    assert(definition.definitionId.startsWith("dsh-stm32/"), definition.name + " 的 definitionId 没加命名空间");
  }
});

await check("命令名符合宿主正则 ^[a-z][a-z0-9_-]*$", () => {
  const { ctx, commands } = makeContext("D:/proj");
  registerCommands(ctx);
  for (const name of commands.keys()) {
    assert(/^[a-z][a-z0-9_-]*$/u.test(name), name + " 不符合宿主命令名规则");
  }
});

await check("spawn 失败时 /stm32-flash 返回 error 而不是抛异常", async () => {
  const { ctx, commands } = makeContext("D:/proj");
  registerCommands(ctx);
  const result = await commands.get("stm32-flash").handler(invocation(""));
  assert(result.kind === "error", "期望 error，实际 " + result.kind);
  assert(typeof result.text === "string" && result.text.includes("烧录"), "文本里应该有烧录结果：" + result.text);
});

await check("斜杠命令解析路径：显式目录优先，缺省用会话工作目录", async () => {
  const { ctx, commands } = makeContext("D:/work");
  registerCommands(ctx);
  const explicit = await commands.get("stm32-doctor").handler(invocation("D:/proj"));
  assert(explicit.kind === "error", "离线桩下体检应当失败");
  const implicit = await commands.get("stm32-doctor").handler(invocation("   "));
  assert(implicit.kind === "error", "空参数也应当走默认目录并失败");
  assert(explicit.text !== undefined && implicit.text !== undefined, "两条命令都应有输出");
});

await check("切词：引号里的空格不切、引号被剥掉（B7）", () => {
  const tokens = tokenizeCommandLine('"C:/Program Files/ST/demo proj" --clean');
  assert(tokens.length === 2, "应当切成 2 段，实际 " + tokens.length);
  assert(tokens[0].text === "C:/Program Files/ST/demo proj", "带空格的路径被切坏：" + tokens[0].text);
  assert(tokens[0].quoted === true, "引号段应当标记 quoted（不参与 --flag 判定）");
  assert(tokens[1].text === "--clean" && tokens[1].quoted === false, "开关被引号逻辑吃掉：" + JSON.stringify(tokens[1]));
});

await check("切词：引号内另一种引号原样保留（B7）", () => {
  const single = tokenizeCommandLine("'D:/It\"s here'");
  assert(single.length === 1 && single[0].text === 'D:/It"s here', "单引号内的双引号被吃掉：" + JSON.stringify(single));
  const double = tokenizeCommandLine('"D:/It\'s here"');
  assert(double.length === 1 && double[0].text === "D:/It's here", "双引号内的单引号被吃掉：" + JSON.stringify(double));
});

await check("切词：普通多参数与旧行为一致，空白不多出空参（B7）", () => {
  const plain = tokenizeCommandLine("  D:/proj   --clean  ");
  assert(plain.length === 2, "应当切成 2 段，实际 " + JSON.stringify(plain));
  assert(plain[0].text === "D:/proj" && plain[1].text === "--clean", "普通参数被改动：" + JSON.stringify(plain));
  assert(tokenizeCommandLine("").length === 0, "空输入应当没有任何 token");
  assert(tokenizeCommandLine("   ").length === 0, "纯空白应当没有任何 token");
});

await check("切词：未闭合引号给明确错误，命令直接拒绝执行（B7）", async () => {
  let thrown = null;
  try {
    tokenizeCommandLine('"D:/Program Files/ST');
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof Error, "未闭合引号应当抛错，而不是静默按空白切");
  assert(thrown.message.includes("引号没闭合"), "错误文本里应当说清是引号问题：" + thrown.message);
  const { ctx, commands } = makeContext("D:/work");
  registerCommands(ctx);
  const result = await commands.get("stm32-build").handler(invocation('"D:/Program Files/ST'));
  assert(result.kind === "error", "路径写坏时命令应当是 error");
  assert(result.text.includes("引号没闭合"), "命令输出里应当带上引号错误：" + result.text);
});

await check("缺工具链时三条命令把门禁警告放在第一行（B8）", async () => {
  // 造一台"什么都没装"的机器：点名一个存在但没有工具的目录，并关掉自动发现与用户配置，
  // 否则开发机上（msys64 在 PATH、config.json 指过去）门禁永远"齐全"，这条用例等于没测。
  const saved = {
    binDirs: process.env.STM32_BIN_DIRS,
    noDiscover: process.env.STM32_NO_DISCOVER,
    noConfig: process.env.DSH_STM32_NO_CONFIG,
  };
  process.env.STM32_BIN_DIRS = process.cwd();
  process.env.STM32_NO_DISCOVER = "1";
  process.env.DSH_STM32_NO_CONFIG = "1";
  try {
    for (const name of ["stm32-flash", "stm32-build", "stm32-debug"]) {
      const { ctx, commands } = makeContext("D:/proj");
      registerCommands(ctx);
      const result = await commands.get(name).handler(invocation("D:/proj"));
      assert(typeof result.text === "string" && result.text.startsWith("⚠ 工具链不齐"), name + " 没把门禁警告放在第一行：" + result.text);
    }
  } finally {
    for (const [key, value] of [
      ["STM32_BIN_DIRS", saved.binDirs],
      ["STM32_NO_DISCOVER", saved.noDiscover],
      ["DSH_STM32_NO_CONFIG", saved.noConfig],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

await check("注册 SKILL：名字合法、内容含两条硬规范", () => {
  const { ctx, skills } = makeContext("D:/proj");
  registerStm32Skill(ctx);
  const skill = skills.get(STM32_SKILL_NAME);
  assert(skill !== undefined, "skill 没注册");
  assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(skill.name), "skill 名不符合宿主规则");
  assert(skill.description.length > 10, "skill 缺描述");
  assert(typeof skill.content === "string" && skill.content.includes("USER CODE"), "skill 内容缺少 USER CODE 规范");
  assert(skill.content.includes("不许改 CubeMX 生成区"), "skill 内容缺少生成区禁令");
  assert(SKILL_CONTENT.includes("Serial Wire"), "skill 内容缺少 SWD 保护条款");
  // 复刻宿主 validateDefinition() 的硬要求：name / description / source / provider / content
  // 必须是字符串。少 source 的表现是"目录里看得见、一加载就报 source must be a string"。
  for (const field of ["name", "description", "source", "provider", "content"]) {
    const value = field === "provider" ? (skill.provider ?? "runtime") : skill[field];
    assert(typeof value === "string" && value.length > 0, "宿主读取 skill 时字段 " + field + " 必须是字符串");
  }
});

await check("宿主没有 commands/skills 服务时不炸", () => {
  const bare = { tools: { register() {} }, subprocess: {}, get: () => undefined };
  registerCommands(bare);
  registerStm32Skill(bare);
});

console.log("\ncommands-units: " + pass + " pass / " + fail + " fail");
process.exitCode = fail === 0 ? 0 : 1;
