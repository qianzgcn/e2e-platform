import { spawn, type ChildProcess } from "node:child_process";

const CLAUDE_COMMAND = "claude";
const WINDOWS_COMMAND = "powershell.exe";
const CLAUDE_TIMEOUT = 3 * 60 * 1000;

type RunClaudeOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
};

type ClaudeInvocation = {
  command: string;
  args: string[];
  stdin?: string;
};

// 运行 Claude Code CLI，并返回 stdout 文本。
export function runClaude(prompt: string, options: RunClaudeOptions = {}) {
  return new Promise<string>((resolve, reject) => {
    const invocation = getClaudeInvocation(prompt);
    const timeout = options.timeout ?? CLAUDE_TIMEOUT;
    let stdout = "";
    let stderr = "";
    let settled = false;

    logClaude("执行 Claude Code 命令", {
      command: invocation.command,
      args: invocation.args,
      fullCommand: formatCommand(invocation.command, invocation.args),
      stdin: invocation.stdin,
      cwd: options.cwd ?? process.cwd(),
      timeout,
    });

    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd ?? process.cwd(),
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        ...options.env,
      },
    });

    if (invocation.stdin) {
      child.stdin.write(invocation.stdin);
    }
    child.stdin.end();

    const timer = setTimeout(() => {
      settled = true;
      killProcess(child);
      const message = "Claude Code 生成用例超时，已终止执行";
      logClaude(message, { timeout, stdoutLength: stdout.length, stderrLength: stderr.length });
      reject(toClaudeError(message, stdout, stderr, true, "SIGTERM"));
    }, timeout);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      logClaude("Claude Code 启动失败", { message: error.message });
      reject(toClaudeError(error.message, stdout, stderr));
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      if (code === 0) {
        logClaude("Claude Code 执行成功", {
          stdout,
          stderr,
          stdoutLength: stdout.length,
          stderrLength: stderr.length,
        });

        if (isClaudeErrorOutput(stdout)) {
          reject(toClaudeError(stdout.trim(), stdout, stderr));
          return;
        }

        resolve(stdout.trim());
        return;
      }

      const message = `Claude Code 退出码异常: ${code ?? "null"}`;
      logClaude("Claude Code 执行失败", { code, signal, stderr, stdout });
      reject(toClaudeError(stderr || stdout || message, stdout, stderr, false, signal ?? undefined));
    });
  });
}

// 生成当前平台可用的 Claude 调用命令。
function getClaudeInvocation(prompt: string): ClaudeInvocation {
  const args = ["-p", "--output-format", "text"];

  if (process.platform === "win32") {
    const command = [
      "[Console]::InputEncoding = [System.Text.Encoding]::UTF8",
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "$OutputEncoding = [System.Text.Encoding]::UTF8",
      "$input | claude -p --output-format text",
    ].join("; ");

    return {
      command: WINDOWS_COMMAND,
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      stdin: prompt,
    };
  }

  return {
    command: CLAUDE_COMMAND,
    args,
    stdin: prompt,
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
  child.kill();
}
