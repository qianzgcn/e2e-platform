import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from "node:child_process";

const CLAUDE_COMMAND = "claude";
const CLAUDE_TIMEOUT = 3 * 60 * 1000;
const CLAUDE_SETTINGS_PATH = ".claude/settings.json";

const CLAUDE_ARGS = [
  // -p: 使用 Claude Code 的非交互 print mode，输出完成后立即退出。
  "-p",
  // --output-format: 指定 stdout 的输出格式。
  "--output-format",
  // text: 当前业务只关心 Claude 是否写入文件，不依赖结构化 stdout。
  "text",
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
    let settled = false;

    logClaude("执行 Claude Code 命令", {
      command: invocation.command,
      args: invocation.args,
      fullCommand: formatCommand(invocation.command, invocation.args),
      promptLength: invocation.stdin.length,
      cwd: options.cwd ?? process.cwd(),
      timeout,
    });

    const child = spawn(invocation.command, invocation.args, createClaudeSpawnOptions(options));

    child.stdin.write(invocation.stdin);
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
