import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const SUMMARY_MAX_LENGTH = 300;
const RECENT_EVENT_LIMIT = 20;

type RunClaudeOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  signal?: AbortSignal;
  stopReason?: string;
  onProgress?: (message: string) => void | Promise<void>;
  systemPrompt?: Options["systemPrompt"];
  tools?: Options["tools"];
  allowedTools?: Options["allowedTools"];
  disallowedTools?: Options["disallowedTools"];
  settingSources?: Options["settingSources"];
  skills?: Options["skills"];
  hooks?: Options["hooks"];
};

// 通过 Claude Agent SDK 执行一次生成任务，返回最终结果文本；失败时抛出带可读原因的 Error。
export async function runClaude(prompt: string, options: RunClaudeOptions = {}): Promise<string> {
  if (options.signal?.aborted) {
    throw toClaudeError(options.stopReason ?? "Claude 生成已被终止");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(AbortSource.Timeout), options.timeout ?? DEFAULT_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort(AbortSource.External);
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    return await drainClaudeStream(prompt, options, controller);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}

async function drainClaudeStream(
  prompt: string,
  options: RunClaudeOptions,
  controller: AbortController,
): Promise<string> {
  const recentEvents: string[] = [];
  let resultText = "";
  let failed = false;
  let gotResult = false;
  const cwd = options.cwd ?? process.cwd();
  const env = { ...process.env, ...options.env };
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = [path.resolve(cwd, "node_modules", ".bin"), env[pathKey]].filter(Boolean).join(path.delimiter);

  const stream = query({
    prompt,
    options: {
      cwd,
      permissionMode: "dontAsk",
      abortController: controller,
      env,
      systemPrompt: options.systemPrompt,
      tools: options.tools,
      allowedTools: options.allowedTools,
      disallowedTools: options.disallowedTools,
      settingSources: options.settingSources,
      skills: options.skills,
      hooks: options.hooks,
    },
  });

  try {
    for await (const message of stream) {
      const summary = summarizeClaudeEvent(message);
      if (summary) {
        pushRecent(recentEvents, summary);
        await options.onProgress?.(summary);
      }

      if (message.type === "result") {
        gotResult = true;
        if (message.subtype === "success") {
          resultText = message.result;
        } else {
          failed = true;
          resultText = message.errors[0] ?? "";
        }
      }
    }
  } catch (error) {
    throw controller.signal.aborted
      ? toClaudeError(abortMessage(controller, options), recentEvents)
      : toClaudeError(errorMessage(error), recentEvents);
  }

  if (failed || !gotResult) {
    throw toClaudeError(resultText || "Claude 生成用例失败", recentEvents);
  }
  return resultText;
}

const AbortSource = {
  Timeout: "timeout",
  External: "external",
} as const;

function abortMessage(controller: AbortController, options: RunClaudeOptions): string {
  return controller.signal.reason === AbortSource.Timeout
    ? "Claude 生成用例超时，已终止执行"
    : options.stopReason ?? "Claude 生成已被终止";
}

// 将 SDK 消息压缩成单行摘要，用于实时进度上报。
export function summarizeClaudeEvent(event: unknown): string | null {
  if (!isRecord(event)) return null;

  switch (event.type) {
    case "assistant":
      return summarizeAssistant(event.message);
    case "user":
      return summarizeToolError(event.message);
    case "system":
      return event.subtype === "init"
        ? `初始化 cwd=${asText(event.cwd)} tools=${asArray(event.tools).length}`
        : null;
    case "result": {
      const result = asText(event.result);
      return `${event.is_error === true ? "失败" : "完成"} turns=${asNumber(event.num_turns)} durationMs=${asNumber(event.duration_ms)} resultLength=${result.length}`;
    }
    default:
      return null;
  }
}

function summarizeAssistant(message: unknown): string | null {
  if (!isRecord(message)) return null;
  const content = message.content;
  if (!Array.isArray(content)) return null;

  for (const item of content) {
    if (!isRecord(item)) continue;
    if (item.type === "text") {
      return `回复 textLength=${asText(item.text).length}`;
    }
    if (item.type === "tool_use") {
      const name = asText(item.name, "unknown");
      const detail = toolUseDetail(item.input);
      return detail ? `调用工具 ${name} ${detail}` : `调用工具 ${name}`;
    }
  }
  return null;
}

function summarizeToolError(message: unknown): string | null {
  if (!isRecord(message)) return null;
  const content = message.content;
  if (!Array.isArray(content)) return null;

  for (const item of content) {
    if (isRecord(item) && item.type === "tool_result" && item.is_error === true) {
      return `工具错误 contentLength=${asText(item.content).length}`;
    }
  }
  return null;
}

// 提取工具调用入参中的关键参数用于日志；大段文本只记长度，避免刷屏。
function toolUseDetail(input: unknown): string {
  if (!isRecord(input)) return "";
  const parts: string[] = [];

  for (const key of ["file_path", "path", "pattern"]) {
    const value = input[key];
    if (typeof value === "string") {
      parts.push(key === "file_path" ? truncate(value) : `${key}=${truncate(value)}`);
    }
  }
  for (const key of ["command", "cmd", "description"]) {
    const value = input[key];
    if (typeof value === "string") parts.push(`${key}Length=${value.length}`);
  }
  for (const key of ["content", "old_string", "new_string"]) {
    const value = input[key];
    if (typeof value === "string") parts.push(`${key}Length=${value.length}`);
  }
  return parts.join(" ");
}

function pushRecent(events: string[], event: string): void {
  events.push(event);
  if (events.length > RECENT_EVENT_LIMIT) events.shift();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Claude 生成用例失败";
}

function truncate(value: string): string {
  return value.length <= SUMMARY_MAX_LENGTH ? value : `${value.slice(0, SUMMARY_MAX_LENGTH)}...`;
}

function asText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toClaudeError(message: string, recentEvents: string[] = []): Error {
  if (recentEvents.length) console.log("[runClaude] 最近事件", recentEvents);
  return new Error(message);
}
