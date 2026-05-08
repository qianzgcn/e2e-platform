import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVE_STATUSES,
  INTERRUPTED_RUN_FAILURE_REASON,
  SUBMITTABLE_STATUSES,
  createInterruptedRunRecoveryArgs,
  splitRunTargetsByStatus,
} from "../../src/services/runStatus.js";

test("run status rules keep terminal statuses submittable and active statuses skipped", () => {
  assert.deepEqual(SUBMITTABLE_STATUSES, ["not_run", "success", "failed"]);
  assert.deepEqual(ACTIVE_STATUSES, ["queued", "generating", "running"]);

  const result = splitRunTargetsByStatus([
    { id: "case-1", title: "未运行", status: "not_run" },
    { id: "case-2", title: "排队中", status: "queued" },
    { id: "case-3", title: "运行中", status: "running" },
    { id: "case-4", title: "成功", status: "success" },
  ]);

  assert.deepEqual(result.runnableTestCases, [
    { id: "case-1", title: "未运行", status: "not_run" },
    { id: "case-4", title: "成功", status: "success" },
  ]);
  assert.deepEqual(result.skippedCases, [
    { id: "case-2", title: "排队中", status: "queued" },
    { id: "case-3", title: "运行中", status: "running" },
  ]);
});

test("createInterruptedRunRecoveryArgs marks active test cases and run logs failed", () => {
  const now = new Date("2026-05-08T08:00:00.000Z");
  const args = createInterruptedRunRecoveryArgs(now);

  assert.equal(INTERRUPTED_RUN_FAILURE_REASON, "服务中断，运行未完成");
  assert.deepEqual(args.testCase, {
    where: { status: { in: ACTIVE_STATUSES } },
    data: {
      status: "failed",
      lastFailureReason: INTERRUPTED_RUN_FAILURE_REASON,
    },
  });
  assert.deepEqual(args.runLog, {
    where: { status: { in: ACTIVE_STATUSES } },
    data: {
      status: "failed",
      failureReason: INTERRUPTED_RUN_FAILURE_REASON,
      finishedAt: now,
    },
  });
});
