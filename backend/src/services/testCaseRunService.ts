import { readFile } from "node:fs/promises";
import path from "node:path";
import { generateScripts, type ScriptSource } from "./agentService.js";
import { prisma } from "../prisma.js";
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
  title: string;
  naturalLanguage: string;
  status: TestCaseStatus;
  playwrightScript: string | null;
  scriptGeneratedAt: Date | null;
};

type RunTask = {
  runLogId: number;
  testCase: RunTargetTestCase;
};

// 运行单个用例并返回对应运行日志 id。
export async function runTestCase(testCaseId: string) {
  // 单条运行复用批量编排，避免单条和批量生成逻辑分叉。
  const result = await runTestCases([testCaseId]);
  return { runId: result.runIds[0] };
}

// 批量创建运行日志并启动后台执行流程。
export async function runTestCases(testCaseIds: string[]) {
  const testCases = await findRunTargets(testCaseIds);

  if (testCases.length !== testCaseIds.length) {
    throw new Error("用例不存在");
  }

  const now = new Date();
  const tasks: RunTask[] = [];

  for (const testCase of testCases) {
    // 用户点击运行后立即落库，前端可以马上看到“排队中”的运行记录。
    const runLog = await prisma.runLog.create({
      data: {
        testCaseId: testCase.id,
        status: "queued",
        startedAt: now,
      },
    });

    await prisma.testCase.update({
      where: { id: testCase.id },
      data: {
        status: "queued",
        lastRunAt: now,
        lastFailureReason: null,
      },
    });

    tasks.push({ runLogId: runLog.id, testCase });
  }

  // 后台异步执行，接口只返回 runId，不阻塞用户等待 Claude 和 Playwright。
  void processRuns(tasks);

  return { runIds: tasks.map((task) => task.runLogId) };
}

// 后台处理一批用例：先按需生成脚本，再逐个执行。
async function processRuns(tasks: RunTask[]) {
  try {
    const project = await getProject();

    // 同一次 API 请求内，需要生成的用例先合并给 Claude，再逐个执行 Playwright。
    await generateNeededScripts(tasks, project);

    for (const task of tasks) {
      await executeTask(task, project.baseUrl);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "运行失败";
    await Promise.all(tasks.map((task) => markFinished(task.runLogId, task.testCase.id, "failed", "", "", message)));
  }
}

// 筛选需要生成的用例，并交给 Claude 一次性生成。
async function generateNeededScripts(tasks: RunTask[], project: ProjectConfig) {
  const generationItems: Array<{ task: RunTask; source: ScriptSource }> = [];

  for (const task of tasks) {
    const { testCase } = task;

    if (!shouldRegenerate(testCase.status, testCase.playwrightScript, testCase.scriptGeneratedAt, project)) {
      continue;
    }

    try {
      // 变量替换只影响传给 agent 的内容，不回写自然语言用例原文。
      const resolvedNaturalLanguage = resolveVariables(testCase.naturalLanguage, project.variables);
      generationItems.push({
        task,
        source: {
          id: testCase.id,
          title: testCase.title,
          naturalLanguage: resolvedNaturalLanguage,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "变量解析失败";
      await markFinished(task.runLogId, testCase.id, "failed", "", "", message);
    }
  }

  // 本批次全都可以复用已有脚本时，跳过 Claude，直接进入执行阶段。
  if (!generationItems.length) {
    return;
  }

  const generationTasks = generationItems.map((item) => item.task);
  await Promise.all(generationTasks.map((task) => updateStatus(task.runLogId, task.testCase.id, "generating")));

  try {
    // 这里是批量生成的关键：一次 Claude 调用生成本批次所有需要更新的 spec 文件。
    await generateScripts(
      generationItems.map((item) => item.source),
      project.baseUrl,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Claude Code 生成用例失败";
    await Promise.all(generationTasks.map((task) => markFinished(task.runLogId, task.testCase.id, "failed", "", "", message)));
    return;
  }

  await Promise.all(generationItems.map((item) => saveGeneratedScript(item.task)));
}

// 执行单个用例的 Playwright 脚本并落最终状态。
async function executeTask(task: RunTask, baseUrl: string) {
  // 重新从数据库读取脚本，确保拿到 Claude 刚生成并保存的最新内容。
  const latestTestCase = await prisma.testCase.findUniqueOrThrow({
    where: { id: task.testCase.id },
    select: {
      id: true,
      playwrightScript: true,
      status: true,
    },
  });

  // 变量解析或 agent 生成阶段已经失败的用例，不再进入 Playwright 执行。
  if (latestTestCase.status === "failed" || !latestTestCase.playwrightScript) {
    return;
  }

  await updateStatus(task.runLogId, latestTestCase.id, "running");

  // runPlaywright 通过 Playwright 命令退出码返回 success，服务层只负责落最终状态。
  const result = await runPlaywright(latestTestCase.playwrightScript, baseUrl, latestTestCase.id);

  if (result.success) {
    await markFinished(task.runLogId, latestTestCase.id, "success", result.stdout, result.stderr);
    return;
  }

  await markFinished(task.runLogId, latestTestCase.id, "failed", result.stdout, result.stderr, result.failureReason);
}

// 读取 Claude 生成的 spec 文件，并保存回数据库。
async function saveGeneratedScript(task: RunTask) {
  const specPath = path.resolve(process.cwd(), "tests", "generated", `${task.testCase.id}.spec.ts`);

  try {
    // Claude 只负责写文件；数据库里的 playwrightScript 以文件内容为准。
    const script = await readFile(specPath, "utf8");
    task.testCase.playwrightScript = script;
    task.testCase.scriptGeneratedAt = new Date();

    await prisma.testCase.update({
      where: { id: task.testCase.id },
      data: {
        playwrightScript: script,
        scriptGeneratedAt: task.testCase.scriptGeneratedAt,
      },
    });
  } catch {
    await markFinished(
      task.runLogId,
      task.testCase.id,
      "failed",
      "",
      "",
      `Agent 未生成用例文件: ${task.testCase.id}.spec.ts`,
    );
  }
}

// 查询本次要运行的用例，并按请求顺序返回。
async function findRunTargets(testCaseIds: string[]) {
  // findMany 不保证返回顺序，后面按请求 id 顺序排回去，方便 runIds 和用户选择顺序一致。
  const testCases = (await prisma.testCase.findMany({
    where: {
      id: {
        in: testCaseIds,
      },
    },
    select: {
      id: true,
      title: true,
      naturalLanguage: true,
      status: true,
      playwrightScript: true,
      scriptGeneratedAt: true,
    },
  })) as RunTargetTestCase[];

  const orderMap = new Map(testCaseIds.map((id, index) => [id, index]));
  return testCases.sort((left, right) => orderMap.get(left.id)! - orderMap.get(right.id)!);
}

// 获取当前项目配置和变量。
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

// 判断当前用例是否需要重新生成 Playwright 脚本。
function shouldRegenerate(
  previousStatus: TestCaseStatus,
  script: string | null,
  scriptGeneratedAt: Date | null,
  project: ProjectConfig,
) {
  // 上次没成功、没有脚本、没有生成时间，都说明不能安全复用旧脚本。
  if (previousStatus !== "success" || !script || !scriptGeneratedAt) {
    return true;
  }

  // 配置按整体保存，project.updatedAt 能覆盖变量被删除后没有行级 updatedAt 的情况。
  return project.updatedAt > scriptGeneratedAt || project.variables.some((variable) => variable.updatedAt > scriptGeneratedAt);
}

// 解析自然语言用例里的 ${变量名} 占位符。
function resolveVariables(naturalLanguage: string, variables: ProjectVariable[]) {
  const variableMap = new Map(variables.map((variable) => [variable.name, variable.value]));

  // 只支持 ${name} 这种最小语法；未配置变量直接失败，避免把占位符交给 agent 猜。
  return naturalLanguage.replace(/\$\{([^}]+)\}/g, (_match, variableName: string) => {
    const name = variableName.trim();
    const value = variableMap.get(name);

    if (value === undefined) {
      throw new Error(`变量 ${name} 未配置`);
    }

    return value;
  });
}

// 同步更新运行日志和用例的运行状态。
async function updateStatus(runLogId: number, testCaseId: string, status: SharedRunningStatus) {
  // 运行日志和用例状态保持同步，列表页可以直接读取 TestCase.status。
  await Promise.all([
    prisma.runLog.update({ where: { id: runLogId }, data: { status } }),
    prisma.testCase.update({ where: { id: testCaseId }, data: { status } }),
  ]);
}

// 标记一次运行结束，并写入输出和失败原因。
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
