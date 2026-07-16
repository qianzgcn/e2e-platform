import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";

const GENERATED_TEST_COMMAND = /^npm run test:generated -- (?:(tests\/generated\/[A-Za-z0-9._-]+\.spec\.ts)|"(tests\/generated\/[A-Za-z0-9._-]+\.spec\.ts)"|'(tests\/generated\/[A-Za-z0-9._-]+\.spec\.ts)')$/;

export function isAllowedScriptAgentBashCommand(
  value: unknown,
  allowedTestFile?: string | null,
): boolean {
  if (typeof value !== "string") return false;
  const command = value.trim();
  if (command !== value || hasUnsafeShellSyntax(command)) return false;

  if (command.startsWith("playwright-cli ") && command.length > "playwright-cli ".length) {
    return true;
  }

  const generatedTest = command.match(GENERATED_TEST_COMMAND);
  if (!generatedTest) return false;
  if (allowedTestFile === undefined) return true;
  if (allowedTestFile === null) return false;

  const requestedFile = generatedTest[1] ?? generatedTest[2] ?? generatedTest[3];
  return requestedFile === allowedTestFile.replaceAll("\\", "/");
}

export function isAllowedScriptAgentFilePath(value: unknown, allowedFile: string | null): boolean {
  if (typeof value !== "string" || !allowedFile) return false;

  const actualPath = normalizePath(path.resolve(process.cwd(), value));
  const expectedPath = normalizePath(path.resolve(process.cwd(), allowedFile));
  return actualPath === expectedPath;
}

export function createScriptAgentHooks(allowedFile: string | null): NonNullable<Options["hooks"]> {
  const enforceScriptAgentPolicy: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolInput = isRecord(input.tool_input) ? input.tool_input : {};

    if (input.tool_name === "Bash") {
      if (isAllowedScriptAgentBashCommand(toolInput.command, allowedFile)) return {};

      return deny([
        "脚本 Agent 只能单独执行一条 playwright-cli 命令，",
        allowedFile
          ? `或 npm run test:generated -- ${allowedFile}。`
          : "当前任务不允许执行生成脚本。",
        "不要串联命令、探测安装状态或使用 shell 重定向，请改为直接调用允许的命令。",
      ].join(""));
    }

    if (input.tool_name === "Write" || input.tool_name === "Edit") {
      if (isAllowedScriptAgentFilePath(toolInput.file_path, allowedFile)) return {};

      return deny(
        allowedFile
          ? `当前任务只能修改 ${allowedFile}；项目 Adapter、业务仓库和其他 spec 均为只读。`
          : "当前任务不允许修改文件。",
      );
    }

    return {};
  };

  return {
    PreToolUse: ["Bash", "Write", "Edit"].map((matcher) => ({
      matcher,
      hooks: [enforceScriptAgentPolicy],
    })),
  };
}

function hasUnsafeShellSyntax(command: string): boolean {
  let quote: "single" | "double" | null = null;
  let escaped = false;

  for (const character of command) {
    if (character === "\n" || character === "\r" || character === "\0") return true;

    if (quote === "single") {
      if (character === "'") quote = null;
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }

    if (quote === "double") {
      if (character === '"') quote = null;
      else if (character === "$" || character === "`") return true;
      continue;
    }

    if (character === "'") {
      quote = "single";
      continue;
    }
    if (character === '"') {
      quote = "double";
      continue;
    }
    if (";&|<>()`$".includes(character)) return true;
  }

  return quote !== null || escaped;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizePath(value: string) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function deny(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  };
}
