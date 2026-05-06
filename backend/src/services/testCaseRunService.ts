import { prisma } from "../prisma.js";
import { generateScript } from "./agentService.js";
import { runPlaywright } from "./runnerService.js";

type TestCaseStatus = "not_run" | "queued" | "generating" | "running" | "success" | "failed";
type SharedRunningStatus = "queued" | "generating" | "running" | "success" | "failed";

type ProjectConfig = {
  baseUrl: string;
  updatedAt: Date;
  variables: ProjectVariable[];
};

type ProjectVariable = {
  name: string;
  value: string;
  updatedAt: Date;
};

type RunTargetTestCase = {
  id: string;
  status: TestCaseStatus;
  playwrightScript: string | null;
  scriptGeneratedAt: Date | null;
};

export async function runTestCase(testCaseId: string) {
  const testCase = (await prisma.testCase.findUnique({
    where: { id: testCaseId },
    select: {
      id: true,
      status: true,
      playwrightScript: true,
      scriptGeneratedAt: true,
    },
  })) as RunTargetTestCase | null;

  if (!testCase) {
    throw new Error("用例不存在");
  }

  const now = new Date();

  // 用户点击运行后立即落库，前端可以马上看到“排队中”的运行记录。
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

  // 后台异步执行，接口只返回 runId，不阻塞用户等待 Playwright 跑完。
  void processRun(testCaseId, runLog.id, testCase.status, testCase.playwrightScript, testCase.scriptGeneratedAt);

  return { runId: runLog.id };
}

async function processRun(
  testCaseId: string,
  runLogId: number,
  previousStatus: TestCaseStatus,
  existingScript: string | null,
  scriptGeneratedAt: Date | null,
) {
  try {
    const project = await getProject();
    let script = existingScript;
    const shouldRegenerateScript = shouldRegenerate(previousStatus, script, scriptGeneratedAt, project);

    // 上次成功、已有脚本且变量未变化时才复用脚本，否则重新生成。
    if (shouldRegenerateScript) {
      await updateStatus(runLogId, testCaseId, "generating");
      const latestTestCase = await prisma.testCase.findUniqueOrThrow({ where: { id: testCaseId } });
      const resolvedNaturalLanguage = resolveVariables(latestTestCase.naturalLanguage, project.variables);
      script = await generateScript({ ...latestTestCase, naturalLanguage: resolvedNaturalLanguage });
      await prisma.testCase.update({
        where: { id: testCaseId },
        data: {
          playwrightScript: script,
          scriptGeneratedAt: new Date(),
        },
      });
    }

    await updateStatus(runLogId, testCaseId, "running");
    const latestTestCase = await prisma.testCase.findUniqueOrThrow({ where: { id: testCaseId } });
    const runnableScript = script!;

    // runPlaywright 通过 Playwright 命令退出码返回 success，服务层只负责落最终状态。
    const result = await runPlaywright(runnableScript, project.baseUrl, latestTestCase.title, latestTestCase.id);

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
  const project = await prisma.project.findFirst({
    orderBy: { id: "asc" },
    include: {
      variables: true,
    },
  });

  if (!project) {
    throw new Error("请先在配置页新建项目");
  }

  return project;
}

function shouldRegenerate(
  previousStatus: TestCaseStatus,
  script: string | null,
  scriptGeneratedAt: Date | null,
  project: ProjectConfig,
) {
  if (previousStatus !== "success" || !script || !scriptGeneratedAt) {
    return true;
  }

  // 配置按整体保存，project.updatedAt 能覆盖变量被删除后没有行级 updatedAt 的情况。
  return project.updatedAt > scriptGeneratedAt || project.variables.some((variable) => variable.updatedAt > scriptGeneratedAt);
}

function resolveVariables(naturalLanguage: string, variables: ProjectVariable[]) {
  const variableMap = new Map(variables.map((variable) => [variable.name, variable.value]));

  return naturalLanguage.replace(/\$\{([^}]+)\}/g, (_match, variableName: string) => {
    const name = variableName.trim();
    const value = variableMap.get(name);

    if (value === undefined) {
      throw new Error(`变量 ${name} 未配置`);
    }

    return value;
  });
}

async function updateStatus(runLogId: number, testCaseId: string, status: SharedRunningStatus) {
  // 运行日志和用例状态保持同步，列表页可以直接读取 TestCase.status。
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

  // 结束时写入 stdout/stderr，失败原因同步到用例表用于列表快速展示。
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
