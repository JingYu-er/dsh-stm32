/**
 * 本插件消费的宿主契约的最小类型声明。
 *
 * 为什么自写而不 import：dsh 的 asar 只发布编译后的 JS，package.json 的 types
 * 指向的 lib/types/index.d.ts 并不随包分发，装不到 @deepseek-ai/dsh-tools 的类型。
 * 这里只声明本项目真正用到的那部分，保持零运行时依赖、离线可编译。
 */

/** 工具参数的 JSON Schema 子集（注册表接受标准 JSON Schema）。 */
export interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: string[];
  additionalProperties?: boolean;
  default?: unknown;
  minimum?: number;
  maximum?: number;
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
