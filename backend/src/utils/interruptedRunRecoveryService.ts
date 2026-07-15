import { prisma } from "../infra/prisma.js";
import { createInterruptedRunRecoveryArgs } from "./runStatus.js";

// 服务启动时只做一次恢复：把上次中断遗留的活跃态收敛为 failed。
export async function recoverInterruptedRuns() {
  const now = new Date();
  const args = createInterruptedRunRecoveryArgs();
  const [interruptedRunLogs, interruptedGenerations] = await Promise.all([
    prisma.runLog.findMany({
      where: { status: { in: ["queued", "generating", "running"] }, finishedAt: null },
      select: { id: true, kind: true, logs: true },
    }),
    prisma.testCaseGeneration.findMany({
      where: { status: "running" },
      select: { id: true, logs: true },
    }),
  ]);
  const [testCaseResult] = await prisma.$transaction([
    prisma.testCase.updateMany(args.testCase),
    ...interruptedRunLogs.map((runLog) => {
      const reason = runLog.kind === "repair" ? "服务中断，AI 修复未完成" : "服务中断，运行未完成";
      return prisma.runLog.update({
        where: { id: runLog.id },
        data: {
          status: "failed",
          failureReason: reason,
          finishedAt: now,
          logs: `${runLog.logs || (runLog.kind === "repair" ? "[AI 修复日志]" : "[用例运行日志]")}\n${formatLogTime(now)} ${reason}`,
        },
      });
    }),
    ...interruptedGenerations.map((generation) =>
      prisma.testCaseGeneration.update({
        where: { id: generation.id },
        data: {
          status: "failed",
          failureReason: "服务中断，用例生成未完成",
          finishedAt: now,
          logs: `${generation.logs}\n${formatLogTime(now)} 服务中断，用例生成未完成`,
        },
      }),
    ),
  ]);

  return {
    testCaseCount: testCaseResult.count,
    runLogCount: interruptedRunLogs.length,
    generationCount: interruptedGenerations.length,
  };
}

export async function recoverInterruptedRunsOnStartup() {
  try {
    const result = await recoverInterruptedRuns();
    console.log("[interruptedRunRecoveryService] 服务中断恢复完成", result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "服务中断恢复失败";
    console.error("[interruptedRunRecoveryService] 服务中断恢复失败", { message });
  }
}

function formatLogTime(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
