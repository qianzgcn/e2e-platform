import path from "node:path";
import { runClaude } from "../infra/runClaude.js";
import {
  buildCaseGenerationPrompt,
  loadCaseGenerationSystemPrompt,
  parseTestCaseCandidates,
  type TestCaseCandidate,
} from "../prompts/caseGeneration.js";
import { formatTestDataSafetyIssue, validateTestDataSafety } from "../prompts/testDataSafety.js";

export type { TestCaseCandidate } from "../prompts/caseGeneration.js";

// 让 Claude 基于代码仓库读代码理解功能，生成 E2E 测试用例候选（自然语言步骤）。
// 只读代码（Read/Glob/Grep），不加载被分析项目的 settings、说明文件或 Skill。
type GenerationProject = {
  variables: Array<{ name: string }>;
  promptHint: string | null;
};

export type GenerateResult = {
  candidates: TestCaseCandidate[];
};

type GenerateOptions = {
  onProgress?: (message: string) => void | Promise<void>;
};

export async function generateTestCaseCandidates(
  repoPath: string,
  project: GenerationProject,
  hint?: string,
  options: GenerateOptions = {},
): Promise<GenerateResult> {
  let lastProgress = "";
  const record = async (message: string) => {
    if (message === lastProgress) {
      return;
    }
    lastProgress = message;
    log(message);
    await options.onProgress?.(message);
  };

  await record("正在启动 AI 分析代码仓库");
  const resultText = await runClaude(buildCaseGenerationPrompt(project, hint), {
    cwd: repoPath,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: await loadCaseGenerationSystemPrompt(),
    },
    tools: ["Read", "Glob", "Grep"],
    allowedTools: ["Read", "Glob", "Grep"],
    disallowedTools: ["mcp__*"],
    settingSources: ["user"],
    skills: [],
    onProgress: async (message) => {
      const progress = formatCaseGenerationProgress(message, repoPath);
      if (progress) {
        await record(progress);
      }
    },
  });

  await record("AI 响应完成，正在校验候选格式");
  const candidates = parseTestCaseCandidates(resultText);
  const unsafeCandidateIndex = candidates.findIndex((candidate) => validateTestDataSafety(candidate.naturalLanguage));
  if (unsafeCandidateIndex >= 0) {
    const issue = validateTestDataSafety(candidates[unsafeCandidateIndex].naturalLanguage)!;
    throw new Error(`第 ${unsafeCandidateIndex + 1} 条候选未通过测试数据安全校验\n${formatTestDataSafetyIssue(issue)}`);
  }
  await record(`候选格式与测试数据安全校验通过，共 ${candidates.length} 条`);
  return { candidates };
}

export function formatCaseGenerationProgress(message: string, repoPath: string): string | null {
  if (message.startsWith("初始化 ")) {
    return "AI 已启动，开始分析代码仓库";
  }
  if (message.startsWith("调用工具 Read ")) {
    const filePath = message.slice("调用工具 Read ".length).trim();
    return `正在阅读文件：${toDisplayPath(filePath, repoPath)}`;
  }
  if (message.startsWith("调用工具 Glob")) {
    return `正在扫描代码结构：${extractDetail(message, "pattern") ?? "项目文件"}`;
  }
  if (message.startsWith("调用工具 Grep")) {
    return `正在检索代码：${extractDetail(message, "pattern") ?? "业务实现"}`;
  }
  if (message.startsWith("回复 ")) {
    return "AI 正在整理候选用例";
  }
  if (message.startsWith("完成 ")) {
    const turns = extractDetail(message, "turns");
    const rawDurationMs = extractDetail(message, "durationMs");
    const durationMs = rawDurationMs ? Number(rawDurationMs) : Number.NaN;
    const duration = Number.isFinite(durationMs) ? `${Math.ceil(durationMs / 1000)} 秒` : "未知耗时";
    return `AI 分析完成（${turns ?? "未知"} 轮，${duration}）`;
  }
  if (message.startsWith("工具错误 ") || message.startsWith("失败 ")) {
    return "AI 分析失败，正在整理错误信息";
  }
  return null;
}

function extractDetail(message: string, key: string): string | null {
  const match = message.match(new RegExp(`${key}=([^\\s]+)`));
  return match?.[1] ?? null;
}

function toDisplayPath(filePath: string, repoPath: string): string {
  const relativePath = path.relative(repoPath, filePath);
  return relativePath && !relativePath.startsWith("..")
    ? relativePath.replaceAll(path.sep, "/")
    : filePath.replaceAll("\\", "/");
}

function log(message: string) {
  console.log(`[caseGeneration] ${message}`);
}
