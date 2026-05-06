import { exec } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

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
  const generatedDir = path.resolve(process.cwd(), "tests", "generated");
  await mkdir(generatedDir, { recursive: true });

  // 生成文件固定使用用例 id 命名，避免标题变更后留下旧文件。
  const specFileName = `${testCaseId}.spec.ts`;
  const specPath = path.join(generatedDir, specFileName);
  const testResultsDir = path.resolve(process.cwd(), "test-results", testCaseId);

  await writeFile(specPath, script, "utf8");

  // 每个用例只保留最新一次产物，运行前先清空该用例自己的结果目录。
  await rm(testResultsDir, { recursive: true, force: true });
  await mkdir(testResultsDir, { recursive: true });

  try {
    // Playwright 的退出码就是运行结果：0 表示通过，非 0 表示失败或执行异常。
    const specRelativePath = path.relative(process.cwd(), specPath).replaceAll(path.sep, "/");
    const command = `npm run test:generated -- ${quoteArg(specRelativePath)}`;
    const { stdout, stderr } = await execAsync(command, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PLAYWRIGHT_BASE_URL: baseUrl,
        PLAYWRIGHT_TEST_CASE_ID: testCaseId,
      },
      maxBuffer: MAX_PLAYWRIGHT_OUTPUT_BUFFER,
      windowsHide: true,
    });

    return { success: true, stdout, stderr };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; message?: string };
    const stderr = result.stderr ?? "";
    const stdout = result.stdout ?? "";

    return {
      success: false,
      stdout,
      stderr,
      failureReason: stderr || stdout || result.message || "Playwright 运行失败",
    };
  }
}

// 给命令行参数加双引号，避免路径里的空格影响执行。
function quoteArg(value: string) {
  return `"${value.replaceAll('"', '\\"')}"`;
}
