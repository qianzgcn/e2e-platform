import assert from "node:assert/strict";
import test from "node:test";
import { formatCaseGenerationProgress } from "../../src/services/caseGenerationService.js";

test("case generation progress turns SDK events into useful stages", () => {
  const repoPath = "C:\\workspace\\repo";

  assert.equal(
    formatCaseGenerationProgress("初始化 cwd=C:\\workspace\\repo tools=3", repoPath),
    "AI 已启动，开始分析代码仓库",
  );
  assert.equal(
    formatCaseGenerationProgress("调用工具 Read C:\\workspace\\repo\\src\\pages\\Login.tsx", repoPath),
    "正在阅读文件：src/pages/Login.tsx",
  );
  assert.equal(
    formatCaseGenerationProgress(
      "调用工具 Glob path=C:\\workspace\\repo pattern=src/**/*.tsx",
      repoPath,
    ),
    "正在扫描代码结构：src/**/*.tsx",
  );
  assert.equal(
    formatCaseGenerationProgress(
      "调用工具 Grep path=C:\\workspace\\repo pattern=login",
      repoPath,
    ),
    "正在检索代码：login",
  );
  assert.equal(
    formatCaseGenerationProgress("完成 turns=4 durationMs=1234 resultLength=20", repoPath),
    "AI 分析完成（4 轮，2 秒）",
  );
  assert.equal(
    formatCaseGenerationProgress("回复 textLength=200", repoPath),
    "AI 正在整理候选用例",
  );
});

test("case generation progress ignores unrelated SDK events", () => {
  assert.equal(formatCaseGenerationProgress("未知事件", "C:\\workspace\\repo"), null);
});
