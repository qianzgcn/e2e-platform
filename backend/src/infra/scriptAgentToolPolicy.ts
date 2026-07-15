import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";

const GENERATED_TEST_COMMAND = /^npm run test:generated -- (?:tests\/generated\/[A-Za-z0-9._-]+\.spec\.ts|"tests\/generated\/[A-Za-z0-9._-]+\.spec\.ts"|'tests\/generated\/[A-Za-z0-9._-]+\.spec\.ts')$/;

export function isAllowedScriptAgentBashCommand(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const command = value.trim();
  if (command !== value || hasUnsafeShellSyntax(command)) return false;

  return (command.startsWith("playwright-cli ") && command.length > "playwright-cli ".length)
    || GENERATED_TEST_COMMAND.test(command);
}

const enforceScriptAgentBashPolicy: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") return {};
  const toolInput = isRecord(input.tool_input) ? input.tool_input : {};
  if (isAllowedScriptAgentBashCommand(toolInput.command)) return {};

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: [
        "脚本 Agent 只能单独执行一条 playwright-cli 命令，",
        "或 npm run test:generated -- tests/generated/<file>.spec.ts。",
        "不要串联命令、探测安装状态或使用 shell 重定向，请改为直接调用允许的命令。",
      ].join(""),
    },
  };
};

export const SCRIPT_AGENT_HOOKS: NonNullable<Options["hooks"]> = {
  PreToolUse: [{
    matcher: "Bash",
    hooks: [enforceScriptAgentBashPolicy],
  }],
};

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
