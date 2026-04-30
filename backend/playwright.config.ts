import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const testCaseId = process.env.PLAYWRIGHT_TEST_CASE_ID || "latest";
const testResultsDir = path.resolve("test-results", testCaseId);

// 后端生成的自动化用例统一放在 tests/generated 目录。
// 平台运行用例时只执行这个目录，避免误跑其它测试文件。
export default defineConfig({
  testDir: "./tests/generated",

  // 生成的文件统一以 .spec.ts 结尾。
  testMatch: "**/*.spec.ts",

  // 单个测试最长运行时间。MVP 阶段先给 30 秒，避免异常页面长期卡住。
  timeout: 30_000,

  // 每个断言的默认等待时间。
  expect: {
    timeout: 5_000,
  },

  // 只输出命令行日志和 HTML 报告；平台不再展示 JSON 结果。
  reporter: [
    ["list"],
    ["html", { outputFolder: path.join(testResultsDir, "html-report"), open: "never" }],
  ],

  // 视频和报告统一放在 test-results 目录下，运行日志直接从这里读取。
  outputDir: testResultsDir,

  use: {
    // runner 会通过 PLAYWRIGHT_BASE_URL 注入项目配置里的 baseUrl。
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://localhost:5173",

    // 当前只需要视频回放，不再输出 trace 和截图。
    trace: "off",
    screenshot: "off",
    video: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
