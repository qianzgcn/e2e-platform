import { query } from "@anthropic-ai/claude-agent-sdk";
import { summarizeClaudeEvent } from "../infra/runClaude.js";

export type TestCaseCandidate = {
  title: string;
  groupName: string;
  naturalLanguage: string;
};

// 让 Claude 基于代码仓库读代码理解功能，生成 E2E 测试用例候选（自然语言步骤）。
// 只读代码（Read/Glob/Grep），不加载项目 settings，不写文件。
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
  const stream = query({
    prompt: buildPrompt(project, hint),
    options: {
      cwd: repoPath,
      permissionMode: "dontAsk",
      allowedTools: ["Read", "Glob", "Grep"],
      // 只加载用户级 ~/.claude（含认证），不加载项目 .claude（避免 playwright-cli 等无关工具）。
      settingSources: ["user"],
    },
  });

  let resultText = "";
  for await (const message of stream) {
    const summary = summarizeClaudeEvent(message);
    if (summary) {
      record(summary);
    }
    if (message.type === "result") {
      const result = message as { result?: string };
      resultText = typeof result.result === "string" ? result.result : "";
    }
  }

  const candidates = parseCandidates(resultText);
  record(`解析出候选 ${candidates.length} 条`);
  return { candidates, logs };
}

function log(message: string) {
  console.log(`[caseGeneration] ${message}`);
}

function buildPrompt(project: GenerationProject, hint?: string): string {
  const variableNames = project.variables.map((v) => v.name.trim()).filter(Boolean);
  const variableSection = variableNames.length
    ? `\n\n项目变量（步骤里用 \${name} 形式占位引用，运行时自动替换为真实值，不要写死账号密码）：${variableNames.map((n) => "${" + n + "}").join("、")}`
    : "";
  const projectHintSection = project.promptHint?.trim()
    ? `\n\n项目业务约束（每次都遵守）：\n${project.promptHint.trim()}`
    : "";
  const userHintSection = hint?.trim()
    ? `\n\n本次额外要求（优先满足）：\n${hint.trim()}`
    : "";

  return `你是 E2E 测试用例设计专家。请基于当前代码仓库（用 Glob/Read/Grep 读代码：页面、组件、路由、API、状态管理），理解被测系统核心功能，生成覆盖主要功能的 E2E 测试用例。

要求：
1. 先用 Glob/Read/Grep 充分理解系统功能，不要凭空臆测。
2. 每条用例覆盖一个可验证的功能点，步骤具体可执行。
3. naturalLanguage 用中文编号步骤（1. 2. 3. ...），描述用户操作和预期结果。
4. groupName 按功能模块归类（如"登录"、"用户管理"）。
5. 生成 5-15 条用例。${variableSection}${projectHintSection}${userHintSection}

只返回 JSON 数组，不要任何其它文字或 markdown：
[{"title":"用例标题","groupName":"分组名","naturalLanguage":"1. 打开首页\\n2. 点击登录\\n3. 输入账号密码\\n4. 验证跳转首页"}]`;
}

function parseCandidates(text: string): TestCaseCandidate[] {
  const json = extractJson(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("AI 返回的内容无法解析为 JSON");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("AI 返回的不是数组");
  }

  return parsed
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      title: String(item.title ?? "").trim(),
      groupName: String(item.groupName ?? "").trim(),
      naturalLanguage: String(item.naturalLanguage ?? "").trim(),
    }))
    .filter((item) => item.title && item.groupName && item.naturalLanguage);
}

// Claude 可能返回带 markdown fence 或多余文字的 JSON，提取首个 JSON 数组。
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const arrayMatch = raw.match(/\[[\s\S]*\]/);
  if (!arrayMatch) {
    throw new Error("AI 返回内容中未找到 JSON 数组");
  }
  return arrayMatch[0];
}
