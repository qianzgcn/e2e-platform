import { exec } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type PlaywrightResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  failureReason?: string;
};

export async function runPlaywright(
  script: string,
  baseUrl: string,
  testCaseTitle: string,
  testCaseId: string,
): Promise<PlaywrightResult> {
  const generatedDir = path.resolve(process.cwd(), "tests", "generated");
  await mkdir(generatedDir, { recursive: true });

  const fileBaseName = `${toSafeFileName(testCaseTitle)}-${testCaseId}`;
  const specFileName = `${fileBaseName}.spec.ts`;
  const specPath = path.join(generatedDir, specFileName);
  const testResultsDir = path.resolve(process.cwd(), "test-results", testCaseId);

  await writeFile(specPath, script, "utf8");
  await rm(testResultsDir, { recursive: true, force: true });
  await mkdir(testResultsDir, { recursive: true });

  try {
    const command = `npm run test:generated -- --grep ${quoteArg(testCaseId)}`;
    const { stdout, stderr } = await execAsync(command, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PLAYWRIGHT_BASE_URL: baseUrl,
        PLAYWRIGHT_TEST_CASE_ID: testCaseId,
      },
      maxBuffer: 1024 * 1024 * 10,
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

function toSafeFileName(value: string) {
  return value.trim().replace(/[<>:"/\\|?*\r\n\t]/g, "-").replace(/\s+/g, "-").slice(0, 80) || "test-case";
}

function quoteArg(value: string) {
  return `"${value.replaceAll('"', '\\"')}"`;
}
