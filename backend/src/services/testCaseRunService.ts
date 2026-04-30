import { prisma } from "../prisma.js";
import { generateScript } from "./agentService.js";
import { runPlaywright } from "./runnerService.js";

type TestCaseStatus = "not_run" | "queued" | "generating" | "running" | "success" | "failed";
type SharedRunningStatus = "queued" | "generating" | "running" | "success" | "failed";

export async function runTestCase(testCaseId: string) {
  const testCase = await prisma.testCase.findUnique({ where: { id: testCaseId } });

  if (!testCase) {
    throw new Error("用例不存在");
  }

  const now = new Date();
  const runLog = await prisma.runLog.create({
    data: {
      testCaseId,
      status: "queued",
      startedAt: now,
    },
  });

  await prisma.testCase.update({
    where: { id: testCaseId },
    data: {
      status: "queued",
      lastRunAt: now,
      lastFailureReason: null,
    },
  });

  void processRun(testCaseId, runLog.id, testCase.status, testCase.playwrightScript);

  return { runId: runLog.id };
}

async function processRun(
  testCaseId: string,
  runLogId: number,
  previousStatus: TestCaseStatus,
  existingScript: string | null,
) {
  try {
    const project = await getProject();
    let script = existingScript;

    if (previousStatus !== "success" || !script) {
      await updateStatus(runLogId, testCaseId, "generating");
      const latestTestCase = await prisma.testCase.findUniqueOrThrow({ where: { id: testCaseId } });
      script = await generateScript(latestTestCase);
      await prisma.testCase.update({
        where: { id: testCaseId },
        data: { playwrightScript: script },
      });
    }

    await updateStatus(runLogId, testCaseId, "running");
    const latestTestCase = await prisma.testCase.findUniqueOrThrow({ where: { id: testCaseId } });
    const result = await runPlaywright(script, project.baseUrl, latestTestCase.title, latestTestCase.id);

    if (result.success) {
      await markFinished(runLogId, testCaseId, "success", result.stdout, result.stderr);
      return;
    }

    await markFinished(runLogId, testCaseId, "failed", result.stdout, result.stderr, result.failureReason);
  } catch (error) {
    const message = error instanceof Error ? error.message : "运行失败";
    await markFinished(runLogId, testCaseId, "failed", "", "", message);
  }
}

async function getProject() {
  return (
    (await prisma.project.findFirst({ orderBy: { id: "asc" } })) ??
    (await prisma.project.create({
      data: {
        name: "默认项目",
        baseUrl: "http://localhost:5173",
      },
    }))
  );
}

async function updateStatus(runLogId: number, testCaseId: string, status: SharedRunningStatus) {
  await Promise.all([
    prisma.runLog.update({ where: { id: runLogId }, data: { status } }),
    prisma.testCase.update({ where: { id: testCaseId }, data: { status } }),
  ]);
}

async function markFinished(
  runLogId: number,
  testCaseId: string,
  status: "success" | "failed",
  stdout: string,
  stderr: string,
  failureReason?: string,
) {
  const finishedAt = new Date();

  await Promise.all([
    prisma.runLog.update({
      where: { id: runLogId },
      data: {
        status,
        stdout,
        stderr,
        failureReason,
        finishedAt,
      },
    }),
    prisma.testCase.update({
      where: { id: testCaseId },
      data: {
        status,
        lastRunAt: finishedAt,
        lastFailureReason: status === "failed" ? failureReason ?? stderr : null,
      },
    }),
  ]);
}
