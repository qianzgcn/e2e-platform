import { query } from "@anthropic-ai/claude-agent-sdk";

const CLAUDE_TIMEOUT = 60 * 60 * 1000;

// 失败子类型：result 消息的 subtype 落在这里即视为执行失败。
const FAILURE_RESULT_SUBTYPES = new Set([
  "error_max_turns",
  "error_during_execution",
  "error_max_consecutive_errors",
  "error_cancelled",
]);

type RunClaudeOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  signal?: AbortSignal;
  stopReason?: string;
  onProgress?: (message: string) => void;
};

// 通过 Claude Agent SDK 运行一次生成任务，返回最终 result 文本。
// 对外契约与原 spawn 版本一致：resolve 成功结果，失败/超时/中止时 reject 一个带 stdout/stderr/killed/signal 字段的 Error。
export function runClaude(prompt: string, options: RunClaudeOptions = {}) {
  return new Promise<string>((resolve, reject) => {
    const timeout = options.timeout ?? CLAUDE_TIMEOUT;
    const recentEvents: string[] = [];
    let resultText = "";
    let resultIsError = false;
    let resultSubtype = "";
    let gotResult = false;
    let settled = false;

    // SDK 自带 AbortController 入口；外部 signal 与超时都通过它转发，统一走 finish() 收尾。
    const controller = new AbortController();
    const timer = setTimeout(() => finish("timeout"), timeout);
    const onExternalAbort = () => finish("abort");
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });

    if (options.signal?.aborted) {
      finish("abort");
      return;
    }

    function finish(reason: "timeout" | "abort") {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onExternalAbort);
      controller.abort();

      const message =
        reason === "timeout"
          ? "Claude Code 生成用例超时，已终止执行"
          : options.stopReason ?? "Claude Code 生成已被终止";

      logClaude(reason === "timeout" ? "Claude Code 生成超时" : "Claude Code 已被手动终止", {
        gotResult,
        recentEvents,
      });

      reject(toClaudeError(message, "", "", true, "SIGTERM"));
    }

    (async () => {
      try {
        logClaude("执行 Claude Code", {
          cwd: options.cwd ?? process.cwd(),
          promptLength: prompt.length,
          timeout,
        });

        // SDK 内部 spawn 自带的 Claude Code 二进制，会透传 env 里的
        // ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL，第三方网关照常工作。
        const stream = query({
          prompt,
          options: {
            cwd: options.cwd ?? process.cwd(),
            // dontAsk：未在 settings.allow 中预批准的工具直接失败，等价原 --permission-mode dontAsk。
            permissionMode: "dontAsk",
            // 默认即全开，显式写明：加载 backend/.claude/settings.json + skills + CLAUDE.md。
            settingSources: ["user", "project", "local"],
            abortController: controller,
            env: { ...process.env, ...options.env },
            // 可选：镜像剥离了 SDK 自带二进制时，用全局 claude 兜底。
            ...(process.env.CLAUDE_CODE_PATH
              ? { pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_PATH }
              : {}),
          },
        });

        for await (const message of stream) {
          const summary = summarizeClaudeStreamEvent(message);

          if (summary) {
            pushRecentEvent(recentEvents, summary);
            options.onProgress?.(summary);
            logClaude("Claude Code 事件", summary);
          }

          if (message.type === "result") {
            gotResult = true;
            const result = message as unknown as {
              result?: string;
              is_error?: boolean;
              subtype?: string;
            };
            resultText = typeof result.result === "string" ? result.result : resultText;
            resultIsError = result.is_error === true;
            resultSubtype = typeof result.subtype === "string" ? result.subtype : "";
          }
        }

        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onExternalAbort);

        if (!gotResult) {
          logClaude("Claude Code 未返回结果", { recentEvents });
          reject(toClaudeError("Claude Code 未返回结果", "", ""));
          return;
        }

        if (resultIsError || FAILURE_RESULT_SUBTYPES.has(resultSubtype)) {
          logClaude("Claude Code 执行失败", {
            subtype: resultSubtype,
            resultLength: resultText.length,
            recentEvents,
          });
          reject(toClaudeError(resultText || `Claude Code 执行失败: ${resultSubtype}`, "", ""));
          return;
        }

        logClaude("Claude Code 执行成功", {
          resultLength: resultText.length,
          recentEvents,
        });
        resolve(resultText);
      } catch (error) {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onExternalAbort);

        const message = (error as Error)?.message || "Claude Code 生成用例失败";
        logClaude("Claude Code 执行异常", { message, recentEvents });
        reject(toClaudeError(message, "", ""));
      }
    })();
  });
}

// 把 SDK 消息转成单行摘要，供 onProgress 与日志使用；格式与旧 stream-json 摘要保持一致。
export function summarizeClaudeStreamEvent(event: unknown) {
  if (!isRecord(event)) {
    return null;
  }

  if (event.type === "stream_event") {
    return null;
  }

  if (event.type === "assistant") {
    const message = isRecord(event.message) ? event.message : {};
    return summarizeAssistantContent(message.content);
  }

  if (event.type === "user") {
    const message = isRecord(event.message) ? event.message : {};
    return summarizeToolResultError(message.content);
  }

  if (event.type === "system") {
    // 只有 init 子类型携带 tools/cwd；其余 system 事件（status/commands_changed 等）忽略。
    if (event.subtype !== "init") {
      return null;
    }
    const toolCount = Array.isArray(event.tools) ? ` tools=${event.tools.length}` : "";
    const cwd = typeof event.cwd === "string" ? ` cwd=${event.cwd}` : "";
    return `初始化${cwd}${toolCount}`;
  }

  if (event.type === "result") {
    const status = event.is_error === true ? "失败" : "完成";
    const turns = typeof event.num_turns === "number" ? ` turns=${event.num_turns}` : "";
    const duration = typeof event.duration_ms === "number" ? ` durationMs=${event.duration_ms}` : "";
    const result = typeof event.result === "string" ? ` ${truncateText(event.result, 300)}` : "";
    return `${status}${turns}${duration}${result}`;
  }

  return null;
}

function summarizeAssistantContent(content: unknown) {
  if (!Array.isArray(content)) {
    return null;
  }

  for (const item of content) {
    if (!isRecord(item)) {
      continue;
    }

    if (item.type === "text") {
      return typeof item.text === "string" ? `回复 ${truncateText(item.text, 300)}` : null;
    }

    if (item.type === "tool_use") {
      const name = typeof item.name === "string" ? item.name : "unknown";
      const input = summarizeToolInput(item.input);
      return input ? `调用工具 ${name} ${input}` : `调用工具 ${name}`;
    }
  }

  return null;
}

function summarizeToolResultError(content: unknown) {
  if (!Array.isArray(content)) {
    return null;
  }

  for (const item of content) {
    if (!isRecord(item) || item.type !== "tool_result" || item.is_error !== true) {
      continue;
    }

    const id = typeof item.tool_use_id === "string" ? ` ${item.tool_use_id}` : "";
    const text = typeof item.content === "string" ? ` ${truncateText(item.content, 300)}` : "";
    return `工具错误${id}${text}`;
  }

  return null;
}

function summarizeToolInput(input: unknown) {
  if (!isRecord(input)) {
    return "";
  }

  const parts: string[] = [];

  for (const key of ["file_path", "path", "pattern", "command", "cmd", "description"] as const) {
    if (typeof input[key] === "string") {
      parts.push(key === "file_path" ? truncateText(input[key], 300) : `${key}=${truncateText(input[key], 300)}`);
    }
  }

  for (const key of ["content", "old_string", "new_string"] as const) {
    if (typeof input[key] === "string") {
      parts.push(`${key}Length=${input[key].length}`);
    }
  }

  return parts.join(" ");
}

function pushRecentEvent(recentEvents: string[], event: string) {
  recentEvents.push(event);

  if (recentEvents.length > 20) {
    recentEvents.shift();
  }
}

function truncateText(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// 包装 Claude 执行错误，保留 stdout/stderr 供上层写入日志（SDK 模式下 stdout/stderr 不再可用，留空串保持字段形状）。
function toClaudeError(message: string, stdout: string, stderr: string, killed = false, signal?: string) {
  return Object.assign(new Error(message), {
    stdout,
    stderr,
    killed,
    signal,
  });
}

// 输出 Claude 事件日志。
function logClaude(message: string, data?: unknown) {
  console.log(`[runClaude] ${message}`, data ?? "");
}
