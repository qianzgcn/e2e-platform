import { runClaude } from "./runClaude.js";

export type ScriptSource = {
  title: string;
  id: string;
  naturalLanguage: string;
};

type GenerateScriptOptions = {
  signal?: AbortSignal;
  stopReason?: string;
  onProgress?: (message: string) => void;
  // playwright-cli 的浏览器 session 名；并发生成时每个 worker 用不同 session，互不踩浏览器。
  sessionId?: string;
};

// 调用 Claude 为单个用例生成 Playwright spec；Claude 用 Write 工具把文件落到 tests/generated。
export async function generateScript(testCase: ScriptSource, baseUrl: string, options: GenerateScriptOptions = {}) {
  const prompt = buildPrompt(testCase, baseUrl);
  logAgent("准备调用 Claude 生成", { caseId: testCase.id, baseUrl, promptLength: prompt.length });

  try {
    await runClaude(prompt, {
      cwd: process.cwd(),
      signal: options.signal,
      stopReason: options.stopReason,
      onProgress: options.onProgress,
      env: options.sessionId ? { PLAYWRIGHT_CLI_SESSION: options.sessionId } : undefined,
    });
    logAgent("Claude 生成完成", { caseId: testCase.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Claude 生成用例失败";
    logAgent("Claude 生成失败", { caseId: testCase.id, message });
    throw new Error(message);
  }
}

// 构造传给 Claude 的提示词；payload 用 JSON 承载，避免自然语言分隔符导致误读用例边界。
export function buildPrompt(testCase: ScriptSource, baseUrl: string) {
  const payload = {
    baseUrl,
    outputDir: "tests/generated",
    testCases: [testCase],
  };

  return `
请参考 CLAUDE.md，把自然语言用例生成统一格式的 Playwright spec 文件。

优先级：
1. 输入数据中的 baseUrl、outputDir、testCases 为准。
2. 严格遵守 CLAUDE.md 的输出模板和步骤注释格式。

输出格式：
- 每个 testCase 写入一个 {outputDir}/{id}.spec.ts 文件。
- 代码内用“// 步骤 N：...”和“// 断言 N：...”表达自然语言脚本。
- 导航：使用完整 URL；相对页面先按 baseUrl 解析，禁止 page.goto('/')。

输入数据：
${JSON.stringify(payload, null, 2)}
`.trim();
}

function logAgent(message: string, data?: unknown) {
  console.log(`[agentService] ${message}`, data ?? "");
}
