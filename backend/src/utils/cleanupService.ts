import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const PLAYWRIGHT_CLI_WORKSPACE_DIR = ".playwright-cli";
const TEST_RESULTS_DIR = "test-results";

// 清理 playwright-cli 页面探测留下的临时快照和控制台日志。
export async function cleanupPlaywrightCliWorkspace(cwd = process.cwd()) {
  const workspacePath = path.resolve(cwd, PLAYWRIGHT_CLI_WORKSPACE_DIR);
  await rm(workspacePath, { recursive: true, force: true });
}

// 清空并重建单个用例的 Playwright 运行产物目录。
export async function resetPlaywrightTestResults(testCaseId: string, cwd = process.cwd()) {
  const testResultsDir = path.resolve(cwd, TEST_RESULTS_DIR, testCaseId);
  await rm(testResultsDir, { recursive: true, force: true });
  await mkdir(testResultsDir, { recursive: true });
  return testResultsDir;
}

// 用例脚本失效时删除旧运行产物，避免旧报告继续代表当前用例。
export async function removePlaywrightTestResults(testCaseId: string, cwd = process.cwd()) {
  const testResultsDir = path.resolve(cwd, TEST_RESULTS_DIR, testCaseId);
  await rm(testResultsDir, { recursive: true, force: true });
}
