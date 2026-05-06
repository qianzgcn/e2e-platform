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
function buildPrompt(testCases: ScriptSource[], baseUrl: string) {
  // prompt 里的 payload 用 JSON 承载，避免自然语言分隔符导致 Claude 误读用例边界。
  const payload = {
    baseUrl,
    outputDir: "tests/generated",
    testCases,
  };

  return `
参考CLAUDE.md生成测试用例脚本。
请根据输入的自然语言用例（naturalLanguage）生成 Playwright 测试文件。
用例标题使用testCases的title字段。

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
