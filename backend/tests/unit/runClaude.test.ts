import assert from "node:assert/strict";
import test from "node:test";
import { summarizeClaudeEvent } from "../../src/infra/runClaude.js";

test("Claude progress summaries do not expose assistant text", () => {
  const assistantText = "账号 admin，密码 SuperSecret";
  const summary = summarizeClaudeEvent({
    type: "assistant",
    message: {
      content: [{ type: "text", text: assistantText }],
    },
  });

  assert.equal(summary, `回复 textLength=${assistantText.length}`);
  assert.equal(summary?.includes("SuperSecret"), false);
});

test("Claude progress summaries do not expose shell commands or descriptions", () => {
  const summary = summarizeClaudeEvent({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Bash",
          input: {
            command: 'playwright-cli fill "密码" "SuperSecret"',
            description: "使用 SuperSecret 填写密码",
          },
        },
      ],
    },
  });

  assert.match(summary ?? "", /^调用工具 Bash commandLength=\d+ descriptionLength=\d+$/);
  assert.equal(summary?.includes("SuperSecret"), false);
});

test("Claude result summaries only record result length", () => {
  const summary = summarizeClaudeEvent({
    type: "result",
    is_error: false,
    num_turns: 3,
    duration_ms: 1200,
    result: "包含敏感信息的最终回复",
  });

  assert.equal(summary, "完成 turns=3 durationMs=1200 resultLength=11");
  assert.equal(summary?.includes("敏感信息"), false);
});
