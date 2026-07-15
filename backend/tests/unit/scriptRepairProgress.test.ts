import assert from "node:assert/strict";
import test from "node:test";
import { formatScriptRepairProgress } from "../../src/services/scriptRepairAgentService.js";

test("script repair progress turns SDK events into user-facing stages", () => {
  assert.equal(formatScriptRepairProgress("初始化 cwd=C:/repo tools=5"), "AI 已启动，正在汇总失败证据");
  assert.equal(formatScriptRepairProgress("调用工具 Read C:/repo/src/login.ts"), "AI 正在阅读用例、业务代码或失败产物");
  assert.equal(formatScriptRepairProgress("调用工具 Grep pattern=login"), "AI 正在检索相关业务实现");
  assert.equal(formatScriptRepairProgress("调用工具 Edit C:/repo/test.spec.ts"), "AI 正在修改候选 Playwright 脚本");
  assert.equal(formatScriptRepairProgress("调用工具 Bash commandLength=20"), "AI 正在复现页面交互或验证候选脚本");
  assert.equal(formatScriptRepairProgress("unknown"), null);
});
