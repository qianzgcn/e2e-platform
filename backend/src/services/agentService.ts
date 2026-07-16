import { rm } from "node:fs/promises";
import path from "node:path";
import { runClaude } from "../infra/runClaude.js";
import { createScriptAgentHooks } from "../infra/scriptAgentToolPolicy.js";
import {
  buildScriptGenerationPrompt,
  loadScriptGenerationSystemPrompt,
  parseScriptGenerationError,
  type ScriptSource,
} from "../prompts/scriptGeneration.js";
import { formatTestDataSafetyIssue, validateTestDataSafety } from "../prompts/testDataSafety.js";
import type { ProjectAutomationAdapter } from "../types/projectAutomation.js";

export type { ScriptSource } from "../prompts/scriptGeneration.js";

type GenerateScriptOptions = {
  signal?: AbortSignal;
  stopReason?: string;
  onProgress?: (message: string) => void;
  projectInstructions?: string | null;
  automationInstructions?: string | null;
  automationAdapter?: ProjectAutomationAdapter | null;
  // playwright-cli 的浏览器 session 名；并发生成时每个 worker 用不同 session，互不踩浏览器。
  sessionId?: string;
};

// 调用 Claude 为单个用例生成 Playwright spec；Claude 用 Write 工具把文件落到 tests/generated。
export async function generateScript(testCase: ScriptSource, baseUrl: string, options: GenerateScriptOptions = {}) {
  const targetFile = `tests/generated/${testCase.id}.spec.ts`;
  const prompt = buildScriptGenerationPrompt(
    testCase,
    baseUrl,
    options.projectInstructions,
    options.automationInstructions,
    options.automationAdapter,
  );
  logAgent("准备调用 Claude 生成", { caseId: testCase.id, baseUrl, promptLength: prompt.length });

  try {
    const safetyIssue = validateTestDataSafety(testCase.originalNaturalLanguage);
    if (safetyIssue) {
      throw new Error(`用例无法生成自动化脚本\n${formatTestDataSafetyIssue(safetyIssue)}`);
    }
    await removeTargetScript(testCase.id);
    const result = await runClaude(prompt, {
      cwd: process.cwd(),
      signal: options.signal,
      stopReason: options.stopReason,
      onProgress: options.onProgress,
      env: {
        PLAYWRIGHT_BASE_URL: baseUrl,
        ...(options.sessionId ? { PLAYWRIGHT_CLI_SESSION: options.sessionId } : {}),
      },
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: await loadScriptGenerationSystemPrompt(),
      },
      tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
      disallowedTools: ["mcp__*"],
      settingSources: ["user", "project"],
      skills: ["playwright-cli"],
      hooks: createScriptAgentHooks(targetFile),
    });

    const generationError = parseScriptGenerationError(result);
    if (generationError) {
      throw new Error(
        `用例无法生成自动化脚本\n问题：${generationError.problem}\n修改建议：${generationError.suggestion}`,
      );
    }
    logAgent("Claude 生成完成", { caseId: testCase.id });
  } catch (error) {
    await removeTargetScript(testCase.id).catch((cleanupError) => {
      logAgent("清理未完成脚本失败", {
        caseId: testCase.id,
        message: cleanupError instanceof Error ? cleanupError.message : "未知错误",
      });
    });
    const message = error instanceof Error ? error.message : "Claude 生成用例失败";
    logAgent("Claude 生成失败", { caseId: testCase.id, message });
    throw new Error(message);
  }
}

function removeTargetScript(testCaseId: string) {
  const specPath = path.resolve(process.cwd(), "tests", "generated", `${testCaseId}.spec.ts`);
  return rm(specPath, { force: true });
}

function logAgent(message: string, data?: unknown) {
  console.log(`[agentService] ${message}`, data ?? "");
}
