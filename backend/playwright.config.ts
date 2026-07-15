/// <reference types="node" />

import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const testCaseId = process.env.PLAYWRIGHT_TEST_CASE_ID || "latest";
const runLogId = process.env.PLAYWRIGHT_RUN_LOG_ID || "latest";
const testResultsDir = path.resolve("test-results", testCaseId, runLogId);
const testArtifactsDir = path.join(testResultsDir, "artifacts");

// 后端生成的自动化用例统一放在 tests/generated 目录。
// 平台运行用例时只执行这个目录，避免误跑其它测试文件。
export default defineConfig({
  testDir: "./tests/generated",

  // 生成的文件统一以 .spec.ts 结尾。
  testMatch: "**/*.spec.ts",

  // 单个测试最长运行时间，避免复杂流程过早超时。
  timeout: 60_000,

  // 每个断言的默认等待时间。
  expect: {
    timeout: 5_000,
  },

  // 只输出命令行日志和 HTML 报告；平台不再展示 JSON 结果。
  reporter: [
    ["list"],
    ["html", { outputFolder: path.join(testResultsDir, "html-report"), open: "never" }],
  ],

  // 视频等测试附件放在 artifacts 子目录，避免 HTML 报告清理附件目录。
  outputDir: testArtifactsDir,

  use: {
    // runner 会通过 PLAYWRIGHT_BASE_URL 注入项目配置里的 baseUrl。
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://localhost:5173",

    // 每次运行都保留录屏，并由 Playwright HTML 报告统一展示。
    trace: "off",
    screenshot: "off",
    video: "on",

    // 容器内通常以 root 运行 Chromium，关闭 sandbox 避免启动失败。
    launchOptions: {
      chromiumSandbox: false,
    },
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
