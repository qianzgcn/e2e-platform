export type TestCaseRunStatus = "not_run" | "queued" | "generating" | "running" | "success" | "failed";
export type ActiveRunStatus = "queued" | "generating" | "running";
export type SubmittableRunStatus = "not_run" | "success" | "failed";

export type RunTargetStatusView = {
  id: string;
  title: string;
  status: TestCaseRunStatus;
};

export type SkippedRunCase = {
  id: string;
  title: string;
  status: ActiveRunStatus;
};

// 终态可以再次提交；活跃态说明已有运行流程正在占用该用例。
export const SUBMITTABLE_STATUSES: SubmittableRunStatus[] = ["not_run", "success", "failed"];
export const ACTIVE_STATUSES: ActiveRunStatus[] = ["queued", "generating", "running"];
export const INTERRUPTED_RUN_FAILURE_REASON = "服务中断，运行未完成";
export const USER_STOP_FAILURE_REASON = "用户手动停止";

const ACTIVE_STATUS_SET = new Set<TestCaseRunStatus>(ACTIVE_STATUSES);

// 提交时按数据库当前状态拆分：终态入队，活跃态跳过。
export function splitRunTargetsByStatus<T extends RunTargetStatusView>(testCases: T[]) {
  const runnableTestCases: T[] = [];
  const skippedCases: SkippedRunCase[] = [];

  for (const testCase of testCases) {
    if (ACTIVE_STATUS_SET.has(testCase.status)) {
      skippedCases.push(toSkippedRunCase(testCase));
      continue;
    }

    runnableTestCases.push(testCase);
  }

  return { runnableTestCases, skippedCases };
}

export function toSkippedRunCase(testCase: RunTargetStatusView): SkippedRunCase {
  return {
    id: testCase.id,
    title: testCase.title,
    status: testCase.status as ActiveRunStatus,
  };
}

export function createInterruptedRunRecoveryArgs(now: Date) {
  return {
    testCase: {
      where: { status: { in: [...ACTIVE_STATUSES] } },
      data: {
        status: "failed" as const,
        lastFailureReason: INTERRUPTED_RUN_FAILURE_REASON,
      },
    },
    runLog: {
      where: { status: { in: [...ACTIVE_STATUSES] } },
      data: {
        status: "failed" as const,
        failureReason: INTERRUPTED_RUN_FAILURE_REASON,
        finishedAt: now,
      },
    },
  };
}
