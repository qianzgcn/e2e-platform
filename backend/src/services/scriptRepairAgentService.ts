import { runClaude } from "../infra/runClaude.js";
import { SCRIPT_AGENT_HOOKS } from "../infra/scriptAgentToolPolicy.js";
import {
  buildScriptRepairPrompt,
  loadScriptRepairSystemPrompt,
  parseScriptRepairResult,
  type ScriptRepairPromptInput,
} from "../prompts/scriptRepair.js";

type RepairAgentOptions = {
  signal?: AbortSignal;
  stopReason?: string;
  onProgress?: (message: string) => void | Promise<void>;
  sessionId: string;
  repairLogId: number;
  projectVariables: Array<{ name: string; value: string }>;
};

export async function repairScriptWithAgent(input: ScriptRepairPromptInput, options: RepairAgentOptions) {
  const prompt = buildScriptRepairPrompt(input, options.projectVariables);
  const tools = input.repairMode === "script_or_case"
    ? ["Read", "Edit", "Glob", "Grep", "Bash"]
    : ["Read", "Glob", "Grep", "Bash"];
  console.log("[scriptRepairAgent] 准备调用 AI 修复", {
    caseId: input.testCase.id,
    repairLogId: options.repairLogId,
    baseUrl: input.baseUrl,
    promptLength: prompt.length,
  });

  const result = await runClaude(prompt, {
    cwd: process.cwd(),
    signal: options.signal,
    stopReason: options.stopReason,
    onProgress: options.onProgress,
    env: {
      PLAYWRIGHT_CLI_SESSION: options.sessionId,
      PLAYWRIGHT_BASE_URL: input.baseUrl,
      PLAYWRIGHT_TEST_CASE_ID: input.testCase.id,
      PLAYWRIGHT_RUN_LOG_ID: `repair-${options.repairLogId}-agent`,
    },
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: await loadScriptRepairSystemPrompt(),
    },
    tools,
    disallowedTools: ["mcp__*"],
    settingSources: ["user", "project"],
    skills: ["playwright-cli"],
    hooks: SCRIPT_AGENT_HOOKS,
  });

  return parseScriptRepairResult(result, input.repairMode);
}

export function formatScriptRepairProgress(message: string): string | null {
  if (message.startsWith("初始化 ")) return "AI 已启动，正在汇总失败证据";
  if (message.startsWith("调用工具 Read ")) return "AI 正在阅读用例、业务代码或失败产物";
  if (message.startsWith("调用工具 Glob")) return "AI 正在扫描业务代码结构";
  if (message.startsWith("调用工具 Grep")) return "AI 正在检索相关业务实现";
  if (message.startsWith("调用工具 Edit ")) return "AI 正在修改候选 Playwright 脚本";
  if (message.startsWith("调用工具 Bash")) return "AI 正在复现页面交互或验证候选脚本";
  if (message.startsWith("回复 ")) return "AI 正在整理根因和修复结论";
  if (message.startsWith("完成 ")) return "AI 分析完成，正在校验修复结果";
  if (message.startsWith("工具错误 ") || message.startsWith("失败 ")) return "AI 工具执行失败，正在整理错误信息";
  return null;
}
