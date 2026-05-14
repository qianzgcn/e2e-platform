import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from "node:child_process";

const CLAUDE_COMMAND = "claude";
const CLAUDE_TIMEOUT = 30 * 60 * 1000;
const CLAUDE_SETTINGS_PATH = ".claude/settings.json";

const CLAUDE_ARGS = [
  // -p: 使用 Claude Code 的非交互 print mode，输出完成后立即退出。
  "-p",
  // --output-format: 指定 stdout 的输出格式。
  "--output-format",
  // stream-json: 实时输出 Claude Code 事件，便于定位卡在哪个工具或阶段。
  "stream-json",
  // --verbose: Claude Code 要求 stream-json 输出必须开启 verbose。
  "--verbose",
  // --input-format: 指定 stdin 的输入格式。
  "--input-format",
  // text: 后端通过 stdin 传入普通文本 prompt。
  "text",
  // --no-session-persistence: 每次生成独立执行，不写入或复用会话历史。
  "--no-session-persistence",
  // --permission-mode: 指定非交互环境下的权限处理策略。
  "--permission-mode",
  // dontAsk: 未被 settings 预批准的工具直接失败，避免服务端卡在确认提示。
  "dontAsk",
  // --settings: 显式加载项目内的 Claude Code 权限配置。
  "--settings",
  // .claude/settings.json: backend 目录下的受控工具 allowlist。
  CLAUDE_SETTINGS_PATH,
];

type RunClaudeOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  signal?: AbortSignal;
  stopReason?: string;
  onProgress?: (message: string) => void;
};

export type ClaudeInvocation = {
  command: string;
  args: string[];
  stdin: string;
};

// 运行 Claude Code CLI，并返回 stdout 文本。
export function runClaude(prompt: string, options: RunClaudeOptions = {}) {
  return new Promise<string>((resolve, reject) => {
    const invocation = createClaudeInvocation(prompt);
    const timeout = options.timeout ?? CLAUDE_TIMEOUT;
    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    let resultText = "";
    let resultIsError = false;
    const recentEvents: string[] = [];
    let settled = false;

    const onClaudeEvent = (event: unknown) => {
      const summary = summarizeClaudeStreamEvent(event);

      if (summary) {
        pushRecentEvent(recentEvents, summary);
        options.onProgress?.(summary);
        logClaude("Claude Code 事件", summary);
      }

      const result = getClaudeResultEvent(event);
      if (result) {
        resultText = result.result ?? resultText;
        resultIsError = result.isError;
      }
    };

    logClaude("执行 Claude Code 命令", {
      command: invocation.command,
      args: invocation.args,
      fullCommand: formatCommand(invocation.command, invocation.args),
      promptLength: invocation.stdin.length,
      cwd: options.cwd ?? process.cwd(),
      timeout,
    });

    const child = spawn(invocation.command, invocation.args, createClaudeSpawnOptions(options));
    let timer: NodeJS.Timeout;

    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      killProcess(child);
      const message = options.stopReason ?? "Claude Code 生成已被终止";
      logClaude("Claude Code 已被手动终止", {
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
        recentEvents,
      });
      reject(toClaudeError(message, stdout, stderr, true, "SIGTERM"));
    };

    timer = setTimeout(() => {
      settled = true;
      cleanup();
      killProcess(child);
      const message = "Claude Code 生成用例超时，已终止执行";
      logClaude(message, {
        timeout,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
        recentEvents,
      });
      reject(toClaudeError(message, stdout, stderr, true, "SIGTERM"));
    }, timeout);

    options.signal?.addEventListener("abort", onAbort, { once: true });

    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    child.stdin.write(invocation.stdin);
    child.stdin.end();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      stdoutBuffer = consumeClaudeStreamChunk(stdoutBuffer + chunk, onClaudeEvent);
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      logClaude("Claude Code stderr", { message: truncateText(chunk.trim(), 1_000) });
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      logClaude("Claude Code 启动失败", { message: error.message });
      reject(toClaudeError(error.message, stdout, stderr));
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      flushClaudeStreamBuffer(stdoutBuffer, onClaudeEvent);

      if (code === 0) {
        logClaude("Claude Code 执行成功", {
          stdoutLength: stdout.length,
          stderrLength: stderr.length,
          resultLength: resultText.length,
          recentEvents,
        });

        if (resultIsError || isClaudeErrorOutput(resultText || stdout)) {
          reject(toClaudeError(resultText || stdout.trim(), stdout, stderr));
          return;
        }

        resolve(resultText || stdout.trim());
        return;
      }

      const message = `Claude Code 退出码异常: ${code ?? "null"}`;
      logClaude("Claude Code 执行失败", {
        code,
        signal,
        stderr: truncateText(stderr, 2_000),
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
        recentEvents,
      });
      reject(toClaudeError(stderr || stdout || message, stdout, stderr, false, signal ?? undefined));
    });
  });
}

// 生成 Linux 环境下的 Claude Code 调用命令。
export function createClaudeInvocation(prompt: string): ClaudeInvocation {
  return {
    command: CLAUDE_COMMAND,
    args: [...CLAUDE_ARGS],
    stdin: prompt,
  };
}

// 生成 Linux 环境下的 spawn 配置；参数变更时要同步更新对应注释。
export function createClaudeSpawnOptions(options: RunClaudeOptions = {}): SpawnOptionsWithoutStdio {
  return {
    cwd: options.cwd ?? process.cwd(),
    // shell: false 让参数原样传给 claude，避免 shell 转义和注入问题。
    shell: false,
    // 单独进程组方便停止时同时终止 Claude 及其拉起的工具子进程。
    detached: true,
    env: {
      ...process.env,
      ...options.env,
    },
  };
}

// 包装 Claude 执行错误，保留 stdout/stderr 供上层写入日志。
function toClaudeError(message: string, stdout: string, stderr: string, killed = false, signal?: string) {
  return Object.assign(new Error(message), {
    stdout,
    stderr,
    killed,
    signal,
  });
}

// Claude 有时错误输出在 stdout 且退出码仍为 0，这里统一转成失败。
function isClaudeErrorOutput(stdout: string) {
  return stdout.trim().startsWith("Error:");
}

type ClaudeResultEvent = {
  result?: string;
  isError: boolean;
};

// 处理 Claude Code 的 NDJSON stdout。返回最后一段未完整换行的 buffer。
function consumeClaudeStreamChunk(buffer: string, onEvent: (event: unknown) => void) {
  const lines = buffer.split(/\r?\n/);
  const rest = lines.pop() ?? "";

  for (const line of lines) {
    consumeClaudeStreamLine(line, onEvent);
  }

  return rest;
}

function flushClaudeStreamBuffer(buffer: string, onEvent: (event: unknown) => void) {
  if (buffer.trim()) {
    consumeClaudeStreamLine(buffer, onEvent);
  }
}

function consumeClaudeStreamLine(line: string, onEvent: (event: unknown) => void) {
  const trimmed = line.trim();

  if (!trimmed) {
    return;
  }

  try {
    onEvent(JSON.parse(trimmed) as unknown);
  } catch {
    logClaude("Claude Code stdout 非 JSON 行", { line: truncateText(trimmed, 1_000) });
  }
}

function getClaudeResultEvent(event: unknown): ClaudeResultEvent | null {
  if (!isRecord(event) || event.type !== "result") {
    return null;
  }

  const isError = event.is_error === true || event.subtype === "error";
  const result = typeof event.result === "string" ? event.result : undefined;
  return { result, isError };
}

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

// 拼接用于日志查看的完整命令。
function formatCommand(command: string, args: string[]) {
  return [command, ...args.map(quoteCommandArg)].join(" ");
}

// 为日志里的命令参数补充引号。
function quoteCommandArg(value: string) {
  return `"${value.replaceAll('"', '\\"')}"`;
}

// 输出 Claude CLI 日志。
function logClaude(message: string, data?: unknown) {
  console.log(`[runClaude] ${message}`, data ?? "");
}

// 终止 Claude 子进程。
function killProcess(child: ChildProcess) {
  if (!child.pid) {
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}
