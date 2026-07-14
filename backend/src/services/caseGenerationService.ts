import { runClaude } from "../infra/runClaude.js";
import {
  buildCaseGenerationPrompt,
  loadCaseGenerationSystemPrompt,
  parseTestCaseCandidates,
  type TestCaseCandidate,
} from "../prompts/caseGeneration.js";

export type { TestCaseCandidate } from "../prompts/caseGeneration.js";

// 让 Claude 基于代码仓库读代码理解功能，生成 E2E 测试用例候选（自然语言步骤）。
// 只读代码（Read/Glob/Grep），不加载被分析项目的 settings、说明文件或 Skill。
type GenerationProject = {
  variables: Array<{ name: string }>;
  promptHint: string | null;
};

export type GenerateResult = {
  candidates: TestCaseCandidate[];
  logs: string[];
};

export async function generateTestCaseCandidates(
  repoPath: string,
  project: GenerationProject,
  hint?: string,
): Promise<GenerateResult> {
  const logs: string[] = [];
  const record = (message: string) => {
    logs.push(message);
    log(message);
  };

  record(`开始生成用例候选 cwd=${repoPath}`);
  const resultText = await runClaude(buildCaseGenerationPrompt(project, hint), {
    cwd: repoPath,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: await loadCaseGenerationSystemPrompt(),
    },
    tools: ["Read", "Glob", "Grep"],
    allowedTools: ["Read", "Glob", "Grep"],
    settingSources: ["user"],
    skills: [],
    onProgress: record,
  });

  const candidates = parseTestCaseCandidates(resultText);
  record(`解析出候选 ${candidates.length} 条`);
  return { candidates, logs };
}

function log(message: string) {
  console.log(`[caseGeneration] ${message}`);
}
