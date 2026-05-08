import assert from "node:assert/strict";
import test from "node:test";

import { createClaudeInvocation, summarizeClaudeStreamEvent } from "../../src/services/runClaude.js";

test("createClaudeInvocation uses stream-json output for realtime logging", () => {
  const invocation = createClaudeInvocation("hello");
  const outputFormatIndex = invocation.args.indexOf("--output-format");

  assert.notEqual(outputFormatIndex, -1);
  assert.equal(invocation.args[outputFormatIndex + 1], "stream-json");
  assert.ok(invocation.args.includes("--verbose"));
  assert.ok(!invocation.args.includes("--include-partial-messages"));
});

test("summarizeClaudeStreamEvent reports tool calls as concise text", () => {
  const summary = summarizeClaudeStreamEvent({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Write",
          input: {
            file_path: "tests/generated/demo.spec.ts",
            content: "x".repeat(500),
          },
        },
      ],
    },
  });

  assert.equal(summary, "调用工具 Write tests/generated/demo.spec.ts contentLength=500");
});

test("summarizeClaudeStreamEvent ignores low-level stream events", () => {
  const summary = summarizeClaudeStreamEvent({
    type: "stream_event",
    event: { type: "content_block_delta" },
    session_id: "session-id",
    parent_tool_use_id: "tool-id",
    uuid: "uuid",
  });

  assert.equal(summary, null);
});

test("summarizeClaudeStreamEvent ignores successful tool results", () => {
  const summary = summarizeClaudeStreamEvent({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "ok",
        },
      ],
    },
  });

  assert.equal(summary, null);
});
