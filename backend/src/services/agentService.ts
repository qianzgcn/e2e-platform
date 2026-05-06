import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLAUDE_COMMAND = "claude";
const CLAUDE_OUTPUT_BUFFER = 1024 * 1024 * 10;

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

  try {
    // 使用 execFile 直接传参，避免自然语言 prompt 里的引号、换行被 shell 解析破坏。
    // Claude 的职责是写入 spec 文件；后续由运行服务读取文件并保存到数据库。
    await execFileAsync(CLAUDE_COMMAND, ["-p", prompt], {
      cwd: process.cwd(),
      maxBuffer: CLAUDE_OUTPUT_BUFFER,
      windowsHide: true,
    });
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(result.stderr || result.stdout || result.message || "Claude Code 生成用例失败");
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
你是一个 Playwright 测试生成 agent。
当前工作目录是 backend。
参考backend/CLAUDE.md
请根据输入的自然语言用例生成 Playwright 测试文件。

严格要求：
- 只允许创建或覆盖 tests/generated/{id}.spec.ts。
- 每个输入用例必须生成一个独立 .spec.ts 文件。
- 文件名必须严格等于 {id}.spec.ts。
- 优先使用 Playwright baseURL 和相对路径；如果自然语言包含完整 URL，可以使用完整 URL。
- 不要修改 playwright.config.ts、package.json、数据库或其它源码。
- 只完成文件写入。
- 生成脚本应简洁、可读，避免硬编码无关等待。
- 若步骤不明确，按自然语言中最直接的用户意图实现，不额外扩展场景。

输入数据：
${JSON.stringify(payload, null, 2)}
`.trim();
}
