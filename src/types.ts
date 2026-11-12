/**
 * 本插件消费的宿主契约的最小类型声明。
 *
 * 为什么自写而不 import：dsh 的 asar 只发布编译后的 JS，package.json 的 types
 * 指向的 lib/types/index.d.ts 并不随包分发，装不到 @deepseek-ai/dsh-tools 的类型。
 * 这里只声明本项目真正用到的那部分，保持零运行时依赖、离线可编译。
 */

/**
 * 工具参数/输出的 JSON Schema 子集——**只允许宿主 0.2.2+ 放行的关键字**。
 *
 * 宿主（dsh-tools/lib/types/json-schema.js，assertSupportedJsonSchema）只认：
 *   约束：type / oneOf / properties / required / additionalProperties / items / enum / const
 *   注解：description / title / default / examples
 * 其余关键字一律 UNSUPPORTED_SCHEMA；number 的 minimum/maximum 已不在集合里，
 * 范围写进 description，并在执行期校验（见 engine/serial.ts 的 SERIAL_LIMITS）。
 * additionalProperties 只能是 boolean（不能再带"值 schema"）；properties/required/
 * additionalProperties 只能挂在 type:"object"，items 只能挂在 type:"array"。
 */
export interface JsonSchema {
  type?: string;
  description?: string;
  title?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  /** 标量枚举；元素类型必须与 type 一致。 */
  enum?: (string | number | boolean)[];
  /** 标量常量；等价于单元素 enum。 */
  const?: string | number | boolean;
  /** 只能是 boolean：true = 允许额外键，false = 拒绝。 */
  additionalProperties?: boolean;
  default?: unknown;
  examples?: unknown[];
  oneOf?: JsonSchema[];
}

export interface TextPart {
  type: "text";
  text: string;
}

export interface ToolOutput {
  schema: JsonSchema;
  render: (args: Record<string, unknown>, value: unknown) => TextPart[];
}

export interface ToolExec {
  /** 工具超时或调用方取消时 abort；插件必须把它透传给子进程。 */
  signal: AbortSignal;
  /** 调用方 agent（后台 job 的 owner 用它的 id 归属）。 */
  agent?: { id: string };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  output: ToolOutput;
  timeoutMs?: number;
  isConcurrencySafe?: () => boolean;
  execute: (args: any, exec: ToolExec) => Promise<unknown>;
}

export interface ToolsService {
  register(tool: ToolDefinition): () => void;
}

/** 收集式输出读取器：偏移读取，永不消费，lossy 表示有截断。 */
export interface CollectedReader {
  readFrom(offset: number): { text: string; lossy: boolean; nextOffset: number };
}

export interface ProcessHandle {
  done: Promise<{ exitCode: number | null; signal: string | null }>;
  collected: { stdout?: CollectedReader; stderr?: CollectedReader };
  terminate(): unknown;
  waitForExit(): Promise<void>;
}

export interface SpawnSpec {
  argv: string[];
  /** 宿主 subprocess 服务要求必填；缺省会抛 TypeError（见 subprocess-runner.ts 的注释）。 */
  cwd: string;
  stdio?: {
    stdin?: "ignore" | "pipe" | "inherit";
    stdout?: { maxBytes: number } | "pipe" | "inherit";
    stderr?: { maxBytes: number } | "pipe" | "inherit";
  };
  graceMs?: number;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

export interface SubprocessService {
  spawn(spec: SpawnSpec): ProcessHandle;
  resolveExecutable(
    command: string,
    env?: Record<string, string | undefined>,
    signal?: AbortSignal,
  ): Promise<string>;
}

/** 后台 job 的运行句柄：只有追加输出与更新进度条两件事。 */
export interface JobHandleForRun {
  id: string;
  append(text: string): void;
  updateProgress(line: string): void;
}

export interface JobOutcome {
  status: "completed" | "failed" | "killed";
  detail?: string;
}

export interface JobSpec {
  kind: string;
  label: string;
  owner?: string;
  outputLimitBytes?: number;
  run(handle: JobHandleForRun): { done: Promise<JobOutcome>; cancel(reason?: string): void };
}

export interface JobsService {
  start(spec: JobSpec): string;
}

/** commands 服务把 handler 的调用现场交给我们（dsh-commands 的 CommandInvocation）。 */
export interface CommandInvocation {
  commandId: string;
  /** 发起这次命令的 agent；workingDirectory.ensure 会用它的会话目录。 */
  agent: unknown;
  /** 斜杠命令后面的原始文本（可能为空串）。 */
  rawInput: string;
  attachments?: readonly unknown[];
  signal: AbortSignal;
}

export type CommandResult =
  | { kind: "success"; text?: string }
  | { kind: "error"; text?: string };

export interface CommandDefinition {
  definitionId?: string;
  name: string;
  description: string;
  input?: { hint: string; attachments?: boolean };
  recordInput?: boolean;
  handler(invocation: CommandInvocation): CommandResult | Promise<CommandResult>;
}

export interface CommandsService {
  register(definition: CommandDefinition): () => void;
}

/**
 * 运行时注册的 skill（dsh-skill 的 skills.register()）。
 *
 * 坑：register() 只校验 name / description / invocation，但 skill 真正被读取时
 * 会走 validateDefinition()，那里 source 与 provider 都必须是字符串，否则
 * `skill` 工具直接报 "loaded skill \"x\" source must be a string"。
 * provider 由 register() 兜底成 "runtime"，source 必须自己给。
 */
export interface SkillDefinition {
  name: string;
  description: string;
  whenToUse?: string;
  content: string;
  source: string;
  provider?: string;
  resourceBase?: { kind: "opaque"; description: string } | { kind: "directory"; path: string };
  invocation?: { modelInvocable: boolean; userInvocable: boolean };
}

export interface SkillsService {
  register(skill: SkillDefinition): () => void;
}

/**
 * 宿主 webServer 服务：注册 HTTP 路由（同 dsh-market 的用法），返回注销函数。
 *
 * 只声明设置面板用到的那一小块；request/response 用 any 是因为宿主没有发布
 * IncomingMessage / ServerResponse 的类型（asar 里只有编译后的 JS）。
 */
export interface WebServerService {
  register(route: {
    kind: "exact" | "prefix";
    path: string;
    handler: (request: any, response: any) => void | Promise<void>;
  }): () => void;
}

/** 会话工作目录服务：give 我 cwd，别让我猜 process.cwd()。 */
export interface WorkingDirectoryService {
  ensure(agent: unknown, signal?: AbortSignal): Promise<string>;
}

export interface DshContext {
  tools: ToolsService;
  subprocess: SubprocessService;
  get<T = unknown>(name: string): T | undefined;
  /** 可选服务：宿主没组合时干脆不注册斜杠命令 / skill，工具照常工作。 */
  commands?: CommandsService;
  skills?: SkillsService;
  workingDirectory?: WorkingDirectoryService;
  /** cordis 的动态注入：服务就绪后再执行，宿主缺服务时静默跳过。 */
  inject?(deps: string[], callback: (scope: DshContext) => void): void;
  /** 事件订阅（cordis）：返回取消订阅函数。turn/end 用它把调试会话在轮次结束时关掉。 */
  on?(event: string, listener: (...args: any[]) => void): () => void;
  logger?: { info?(message: string): void; warn?(message: string): void };
}
