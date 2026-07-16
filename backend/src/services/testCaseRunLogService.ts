import { prisma } from "../infra/prisma.js";
import { ACTIVE_STATUSES } from "../utils/runStatus.js";
import type { RunTask, SharedRunningStatus } from "./testCaseRunTypes.js";

const EXECUTION_LOG_HEADER = "[用例运行日志]";
const REPAIR_LOG_HEADER = "[AI 修复日志]";

type FinishOutput = {
  logs: string;
  stdout: string;
  stderr: string;
  failureReason?: string;
};

// 只推进仍活跃的运行，避免用户停止后被后台流程重新写回运行中或成功。
export async function updateRunStatus(runLogId: number, testCaseId: string, status: SharedRunningStatus) {
  logRun("更新用例运行状态", { runLogId, testCaseId, status });
  const transitionedAt = new Date();
  return prisma.$transaction(async (tx) => {
    const runLogResult = await tx.runLog.updateMany({
      where: {
        id: runLogId,
        testCaseId,
        status: { in: ACTIVE_STATUSES },
        finishedAt: null,
      },
      data: {
        status,
        generationStartedAt: status === "generating" ? transitionedAt : undefined,
        executionStartedAt: status === "running" ? transitionedAt : undefined,
      },
    });

    if (runLogResult.count !== 1) {
      logRun("运行日志已结束，跳过状态更新", { runLogId, testCaseId, status });
      return false;
    }

    const testCaseResult = await tx.testCase.updateMany({
      where: {
        id: testCaseId,
        status: { in: ACTIVE_STATUSES },
      },
      data: { status },
    });

    return testCaseResult.count === 1;
  });
}

export async function finishRunTask(
  task: RunTask,
  status: "success" | "failed",
  output: Omit<FinishOutput, "logs">,
) {
  await flushRunLog(task);
  return markRunFinished(task.runLogId, task.testCase.id, task.kind, status, {
    ...output,
    logs: getRunLog(task),
  });
}

// 终态先锁定运行日志，再同步用例状态，防止已结束任务覆盖后续运行。
export async function markRunFinished(
  runLogId: number,
  testCaseId: string,
  kind: RunTask["kind"],
  status: "success" | "failed",
  { logs, stdout, stderr, failureReason }: FinishOutput,
) {
  const finishedAt = new Date();
  logRun("标记运行结束", { runLogId, testCaseId, status, failureReason });

  return prisma.$transaction(async (tx) => {
    const runLogResult = await tx.runLog.updateMany({
      where: {
        id: runLogId,
        testCaseId,
        status: { in: ACTIVE_STATUSES },
        finishedAt: null,
      },
      data: {
        status,
        logs,
        stdout,
        stderr,
        failureReason,
        finishedAt,
      },
    });

    if (runLogResult.count !== 1) {
      logRun("运行日志已结束，跳过结束状态写入", { runLogId, testCaseId, status });
      return false;
    }

    await tx.testCase.updateMany({
      where: {
        id: testCaseId,
        status: { in: ACTIVE_STATUSES },
      },
      data: {
        status,
        lastRunAt: kind === "execution" ? finishedAt : undefined,
        lastFailureReason: status === "failed" ? failureReason ?? stderr : null,
      },
    });
    return true;
  });
}

export function appendRunLog(task: RunTask, message: string) {
  const writer = getLogWriter(task);
  writer.lines.push(`${formatLogTime(new Date())} ${message}`);
  const snapshot = writer.lines.join("\n");
  writer.pending = writer.pending.then(() => persistRunLog(task, snapshot));
  return writer.pending;
}

export function getRunLog(task: RunTask) {
  return getLogWriter(task).lines.join("\n");
}

export function createRunLog(kind: RunTask["kind"], message: string) {
  return [getRunLogHeader(kind), `${formatLogTime(new Date())} ${message}`].join("\n");
}

export function getRunLogHeader(kind: RunTask["kind"]) {
  return kind === "repair" ? REPAIR_LOG_HEADER : EXECUTION_LOG_HEADER;
}

export function flushRunLog(task: RunTask) {
  return getLogWriter(task).pending;
}

export function appendTerminalRunLog(
  logs: string | null | undefined,
  kind: RunTask["kind"],
  message: string,
) {
  return `${logs || getRunLogHeader(kind)}\n${formatLogTime(new Date())} ${message}`;
}

export function truncateRunLogMessage(message: string) {
  return message.length <= 300 ? message : `${message.slice(0, 300)}...`;
}

export function logRun(message: string, data?: unknown) {
  console.log(`[testCaseRunService] ${message}`, data ?? "");
}

function getLogWriter(task: RunTask) {
  task.logWriter ??= {
    lines: [getRunLogHeader(task.kind)],
    pending: Promise.resolve(),
  };
  return task.logWriter;
}

async function persistRunLog(task: RunTask, logs: string) {
  try {
    await prisma.runLog.updateMany({
      where: {
        id: task.runLogId,
        testCaseId: task.testCase.id,
        status: { in: ACTIVE_STATUSES },
        finishedAt: null,
      },
      data: { logs },
    });
  } catch (error) {
    logRun("实时写入用例过程日志失败", {
      runLogId: task.runLogId,
      testCaseId: task.testCase.id,
      message: error instanceof Error ? error.message : "未知错误",
    });
  }
}

function formatLogTime(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
