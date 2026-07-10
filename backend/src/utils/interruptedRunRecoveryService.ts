import { prisma } from "../infra/prisma.js";
import { createInterruptedRunRecoveryArgs } from "./runStatus.js";

// 服务启动时只做一次恢复：把上次中断遗留的活跃态收敛为 failed。
export async function recoverInterruptedRuns() {
  const args = createInterruptedRunRecoveryArgs(new Date());
  const [testCaseResult, runLogResult] = await prisma.$transaction([
    prisma.testCase.updateMany(args.testCase),
    prisma.runLog.updateMany(args.runLog),
  ]);

  return {
    testCaseCount: testCaseResult.count,
    runLogCount: runLogResult.count,
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
