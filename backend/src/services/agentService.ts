import { runClaude } from "./runClaude.js";

export type ScriptSource = {
  title: string;
  id: string;
  naturalLanguage: string;
};

// 生成单个用例脚本，内部复用批量生成逻辑。
export async function generateScript(testCase: ScriptSource, baseUrl: string) {
  await generateScripts([testCase], baseUrl);
}

// 调用 Claude Code 批量生成 Playwright spec 文件。
export async function generateScripts(testCases: ScriptSource[], baseUrl: string) {
  if (!testCases.length) {
    return;
  }

  const prompt = buildPrompt(testCases, baseUrl);
  console.log("提示词", prompt);
  logAgent("准备调用 Claude Code", {
    caseCount: testCases.length,
    caseIds: testCases.map((testCase) => testCase.id),
    baseUrl,
    promptLength: prompt.length,
  });

  try {
    // Claude 的职责是写入 spec 文件；后续由运行服务读取文件并保存到数据库。
    await runClaude(prompt, { cwd: process.cwd() });
    logAgent("Claude Code 生成完成", {
      caseIds: testCases.map((testCase) => testCase.id),
    });
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean; signal?: string };
    const message = getClaudeErrorMessage(result);
    logAgent("Claude Code 生成失败", {
      stderr: result.stderr,
      stdout: result.stdout,
      message,
      killed: result.killed,
      signal: result.signal,
    });
    throw new Error(message);
  }
}

// 构造传给 Claude Code 的完整提示词。
export function buildPrompt(testCases: ScriptSource[], baseUrl: string) {
  // prompt 里的 payload 用 JSON 承载，避免自然语言分隔符导致 Claude 误读用例边界。
  const payload = {
    baseUrl,
    outputDir: "tests/generated",
    testCases,
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

// 统一转换 Claude 执行错误信息。
function getClaudeErrorMessage(error: { stdout?: string; stderr?: string; message?: string; killed?: boolean; signal?: string }) {
  if (error.killed || error.signal === "SIGTERM") {
    return "Claude Code 生成用例超时，已终止执行";
  }

  return error.stderr || error.stdout || error.message || "Claude Code 生成用例失败";
}

// 输出 agent 服务日志。
function logAgent(message: string, data?: unknown) {
  console.log(`[agentService] ${message}`, data ?? "");
}
