import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const PLAYWRIGHT_CLI_WORKSPACE_DIR = ".playwright-cli";
const TEST_RESULTS_DIR = "test-results";

// 清理 playwright-cli 页面探测留下的临时快照和控制台日志。
export async function cleanupPlaywrightCliWorkspace(cwd = process.cwd()) {
  const workspacePath = path.resolve(cwd, PLAYWRIGHT_CLI_WORKSPACE_DIR);
  await rm(workspacePath, { recursive: true, force: true });
}

// 清空并重建单次 Playwright 运行的产物目录。
export async function resetPlaywrightTestResults(testCaseId: string, runLogId: number | string, cwd = process.cwd()) {
  const testResultsDir = path.resolve(cwd, TEST_RESULTS_DIR, testCaseId, String(runLogId));
  await rm(testResultsDir, { recursive: true, force: true });
  await mkdir(testResultsDir, { recursive: true });
  return testResultsDir;
}

export async function removeGeneratedTestScript(testCaseId: string, cwd = process.cwd()) {
  await rm(path.resolve(cwd, "tests", "generated", `${testCaseId}.spec.ts`), { force: true });
}

export async function removeTestCaseArtifacts(testCaseId: string, cwd = process.cwd()) {
  await rm(path.resolve(cwd, TEST_RESULTS_DIR, testCaseId), { recursive: true, force: true });
}
