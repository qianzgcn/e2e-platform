import { exec } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resetPlaywrightTestResults } from "./cleanupService.js";

const execAsync = promisify(exec);
const MAX_PLAYWRIGHT_OUTPUT_BUFFER = 1024 * 1024 * 10;

export type PlaywrightResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  failureReason?: string;
};

// 写入指定用例的 spec 文件，并调用 Playwright 执行。
export async function runPlaywright(
  script: string,
  baseUrl: string,
  testCaseId: string,
): Promise<PlaywrightResult> {
  logRunner("准备执行 Playwright", { testCaseId, baseUrl });
  const generatedDir = path.resolve(process.cwd(), "tests", "generated");
  await mkdir(generatedDir, { recursive: true });

  // 生成文件固定使用用例 id 命名，避免标题变更后留下旧文件。
  const specFileName = `${testCaseId}.spec.ts`;
  const specPath = path.join(generatedDir, specFileName);

  await writeFile(specPath, script, "utf8");
  logRunner("写入 Playwright spec 文件", { testCaseId, specPath, scriptLength: script.length });

  // 每个用例只保留最新一次产物，运行前先清空该用例自己的结果目录。
  const testResultsDir = await resetPlaywrightTestResults(testCaseId);
  logRunner("重建 Playwright 产物目录", { testCaseId, testResultsDir });

  try {
    // Playwright 的退出码就是运行结果：0 表示通过，非 0 表示失败或执行异常。
    const specRelativePath = path.relative(process.cwd(), specPath).replaceAll(path.sep, "/");
    const command = `npm run test:generated -- ${quoteArg(specRelativePath)}`;
    logRunner("执行 Playwright 命令", {
      testCaseId,
      command,
      env: {
        PLAYWRIGHT_BASE_URL: baseUrl,
        PLAYWRIGHT_TEST_CASE_ID: testCaseId,
      },
    });
    const { stdout, stderr } = await execAsync(command, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PLAYWRIGHT_BASE_URL: baseUrl,
        PLAYWRIGHT_TEST_CASE_ID: testCaseId,
      },
      maxBuffer: MAX_PLAYWRIGHT_OUTPUT_BUFFER,
    });

    logRunner("Playwright 执行成功", {
      testCaseId,
      stdoutLength: stdout.length,
      stderrLength: stderr.length,
    });
    return { success: true, stdout, stderr };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; message?: string };
    const stderr = result.stderr ?? "";
    const stdout = result.stdout ?? "";
    const failureReason = stderr || stdout || result.message || "Playwright 运行失败";

    logRunner("Playwright 执行失败", {
      testCaseId,
      stdoutLength: stdout.length,
      stderrLength: stderr.length,
      failureReason,
    });
    return {
      success: false,
      stdout,
      stderr,
      failureReason,
    };
  }
}

// 给命令行参数加双引号，避免路径里的空格影响执行。
function quoteArg(value: string) {
  return `"${value.replaceAll('"', '\\"')}"`;
}

// 输出 Playwright runner 日志。
function logRunner(message: string, data?: unknown) {
  console.log(`[runnerService] ${message}`, data ?? "");
}
