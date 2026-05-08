import { readFile } from "node:fs/promises";
import path from "node:path";
import { generateScripts, type ScriptSource } from "./agentService.js";
import { cleanupPlaywrightCliWorkspace } from "./cleanupService.js";
import { prisma } from "../prisma.js";
import { runPlaywright } from "./runnerService.js";
import { chunkByAgentGenerationBatchSize } from "./runBatch.js";
import {
  SUBMITTABLE_STATUSES,
  splitRunTargetsByStatus,
  toSkippedRunCase,
  type SkippedRunCase,
  type TestCaseRunStatus,
} from "./runStatus.js";

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
  status: TestCaseRunStatus;
  playwrightScript: string | null;
  scriptGeneratedAt: Date | null;
};

type RunTask = {
  runLogId: number;
  testCase: RunTargetTestCase;
};

type GenerationItem = {
  task: RunTask;
  source: ScriptSource;
};

type ReadyTaskQueue = {
  items: RunTask[];
  generationFinished: boolean;
  wakeRunner?: () => void;
};

const runBatchQueue: RunTask[][] = [];
let isRunBatchQueueDraining = false;

// 单条运行复用批量提交结果，返回统一的 runIds/skippedCases 结构。
export async function runTestCase(testCaseId: string) {
  logRun("收到单用例运行请求", { testCaseId });
  // 单条运行复用批量编排，避免单条和批量生成逻辑分叉。
  return runTestCases([testCaseId]);
}

// 批量创建运行日志并启动后台执行流程。
export async function runTestCases(testCaseIds: string[]) {
  logRun("收到批量运行请求", { testCaseIds });
  const testCases = await findRunTargets(testCaseIds);

  if (testCases.length !== testCaseIds.length) {
    logRun("运行请求包含不存在的用例", { requested: testCaseIds.length, found: testCases.length });
    throw new Error("用例不存在");
  }

  const { runnableTestCases, skippedCases } = splitRunTargetsByStatus(testCases);
  const queuedResult = runnableTestCases.length
    ? await createQueuedRunTasks(runnableTestCases)
    : { tasks: [], skippedCases: [] };
  const allSkippedCases = [...skippedCases, ...queuedResult.skippedCases];

  if (queuedResult.tasks.length) {
    enqueueRunBatch(queuedResult.tasks);
  }

  logRun("批量运行提交完成", {
    queuedCount: queuedResult.tasks.length,
    skippedCount: allSkippedCases.length,
  });

  return {
    runIds: queuedResult.tasks.map((task) => task.runLogId),
    skippedCases: allSkippedCases,
  };
}

async function createQueuedRunTasks(testCases: RunTargetTestCase[]) {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const tasks: RunTask[] = [];
    const skippedCases: SkippedRunCase[] = [];

    for (const testCase of testCases) {
      // 条件更新放在事务内，避免并发点击把同一个用例重复提交。
      const updated = await tx.testCase.updateMany({
        where: {
          id: testCase.id,
          status: { in: SUBMITTABLE_STATUSES },
        },
        data: {
          status: "queued",
          lastRunAt: now,
          lastFailureReason: null,
        },
      });

      if (updated.count !== 1) {
        const latestTestCase = await tx.testCase.findUniqueOrThrow({
          where: { id: testCase.id },
          select: {
            id: true,
            title: true,
            status: true,
          },
        });

        skippedCases.push(toSkippedRunCase(latestTestCase));
        logRun("用例状态已变化，本次运行跳过", {
          testCaseId: latestTestCase.id,
          title: latestTestCase.title,
          status: latestTestCase.status,
        });
        continue;
      }

      // 用户点击运行后立即落库，前端可以马上看到“排队中”的运行记录。
      const runLog = await tx.runLog.create({
        data: {
          testCaseId: testCase.id,
          status: "queued",
          startedAt: now,
        },
      });

      tasks.push({ runLogId: runLog.id, testCase });
      logRun("创建运行日志并设置排队中", {
        runLogId: runLog.id,
        testCaseId: testCase.id,
        title: testCase.title,
        status: "queued",
      });
    }

    return { tasks, skippedCases };
  });
}

function enqueueRunBatch(tasks: RunTask[]) {
  runBatchQueue.push(tasks);
  logRun("运行批次进入全局队列", {
    batchSize: tasks.length,
    queueLength: runBatchQueue.length,
  });
  void drainRunBatchQueue();
}

async function drainRunBatchQueue() {
  if (isRunBatchQueueDraining) {
    return;
  }

  isRunBatchQueueDraining = true;
  try {
    while (runBatchQueue.length) {
      const tasks = runBatchQueue.shift()!;
      await processRuns(tasks);
    }
  } finally {
    isRunBatchQueueDraining = false;
  }
}

// 后台处理一批用例：批内生成和执行并行推进，批次之间由全局队列串行。
async function processRuns(tasks: RunTask[]) {
  try {
    logRun("开始后台运行批次", {
      runLogIds: tasks.map((task) => task.runLogId),
      testCaseIds: tasks.map((task) => task.testCase.id),
    });
    const project = await getProject();

    await processRunPipeline(tasks, project);
    logRun("后台运行批次结束", {
      runLogIds: tasks.map((task) => task.runLogId),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "运行失败";
    logRun("后台运行批次失败", { message });
    await Promise.all(tasks.map((task) => markFinished(task.runLogId, task.testCase.id, "failed", "", "", message)));
  } finally {
    await cleanupRunWorkspace();
  }
}

// 批次内双流水线：已有脚本先执行，agent 生成完成的用例再追加执行。
async function processRunPipeline(tasks: RunTask[], project: ProjectConfig) {
  const readyQueue = createReadyTaskQueue();
  const generationItems = await collectGenerationItems(tasks, project, readyQueue);

  await Promise.all([executeReadyTaskQueue(readyQueue, project.baseUrl), generateNeededScripts(generationItems, project, readyQueue)]);
}

// 运行批次结束后清理 playwright-cli 页面探测产物，避免历史快照影响下一次生成。
async function cleanupRunWorkspace() {
  try {
    await cleanupPlaywrightCliWorkspace();
    logRun("清理 playwright-cli 工作目录完成");
  } catch (error) {
    const message = error instanceof Error ? error.message : "清理 playwright-cli 工作目录失败";
    logRun("清理 playwright-cli 工作目录失败", { message });
  }
}

function createReadyTaskQueue(): ReadyTaskQueue {
  return {
    items: [],
    generationFinished: false,
  };
}

function enqueueReadyTask(queue: ReadyTaskQueue, task: RunTask) {
  queue.items.push(task);
  wakeReadyTaskRunner(queue);
}

function wakeReadyTaskRunner(queue: ReadyTaskQueue) {
  queue.wakeRunner?.();
  queue.wakeRunner = undefined;
}

function waitForReadyTask(queue: ReadyTaskQueue) {
  return new Promise<void>((resolve) => {
    queue.wakeRunner = resolve;
  });
}

async function executeReadyTaskQueue(queue: ReadyTaskQueue, baseUrl: string) {
  while (true) {
    const task = queue.items.shift();

    if (task) {
      await executeTaskWithIsolation(task, baseUrl);
      continue;
    }

    if (queue.generationFinished) {
      return;
    }

    await waitForReadyTask(queue);
  }
}

async function executeTaskWithIsolation(task: RunTask, baseUrl: string) {
  try {
    await executeTask(task, baseUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Playwright 执行异常";
    logRun("用例执行异常", {
      runLogId: task.runLogId,
      testCaseId: task.testCase.id,
      message,
    });
    await markFinished(task.runLogId, task.testCase.id, "failed", "", "", message);
  }
}

// 筛选需要生成的用例；可复用脚本的用例直接进入执行队列。
async function collectGenerationItems(tasks: RunTask[], project: ProjectConfig, readyQueue: ReadyTaskQueue) {
  const generationItems: GenerationItem[] = [];

  for (const task of tasks) {
    const { testCase } = task;

    if (!shouldRegenerate(testCase.status, testCase.playwrightScript, testCase.scriptGeneratedAt, project)) {
      logRun("复用已有脚本，跳过 agent 生成", {
        runLogId: task.runLogId,
        testCaseId: testCase.id,
        status: testCase.status,
      });
      enqueueReadyTask(readyQueue, task);
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
      logRun("用例需要 agent 生成", {
        runLogId: task.runLogId,
        testCaseId: testCase.id,
        title: testCase.title,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "变量解析失败";
      logRun("变量解析失败", {
        runLogId: task.runLogId,
        testCaseId: testCase.id,
        message,
      });
      await markFinished(task.runLogId, testCase.id, "failed", "", "", message);
    }
  }

  return generationItems;
}

// 按最多 10 条一组调用 Claude；每个小批完成后把成功生成的用例追加到执行队列。
async function generateNeededScripts(generationItems: GenerationItem[], project: ProjectConfig, readyQueue: ReadyTaskQueue) {
  try {
    for (const chunk of chunkByAgentGenerationBatchSize(generationItems)) {
      await generateScriptChunk(chunk, project, readyQueue);
    }
  } finally {
    readyQueue.generationFinished = true;
    wakeReadyTaskRunner(readyQueue);
  }
}

async function generateScriptChunk(generationItems: GenerationItem[], project: ProjectConfig, readyQueue: ReadyTaskQueue) {
  const generationTasks = generationItems.map((item) => item.task);
  await Promise.all(generationTasks.map((task) => updateStatus(task.runLogId, task.testCase.id, "generating")));
  logRun("开始调用 agent 生成脚本小批次", {
    caseCount: generationItems.length,
    testCaseIds: generationItems.map((item) => item.source.id),
  });

  try {
    await generateScripts(
      generationItems.map((item) => item.source),
      project.baseUrl,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Claude Code 生成用例失败";
    logRun("调用 agent 生成脚本小批次失败", {
      testCaseIds: generationItems.map((item) => item.source.id),
      message,
    });
    await Promise.all(generationTasks.map((task) => markFinished(task.runLogId, task.testCase.id, "failed", "", "", message)));
    return;
  }

  for (const item of generationItems) {
    const saved = await saveGeneratedScript(item.task);
    if (saved) {
      enqueueReadyTask(readyQueue, item.task);
    }
  }

  logRun("agent 生成脚本小批次保存完成", {
    testCaseIds: generationItems.map((item) => item.source.id),
  });
}

// 执行单个用例的 Playwright 脚本并落最终状态。
async function executeTask(task: RunTask, baseUrl: string) {
  logRun("准备执行用例", {
    runLogId: task.runLogId,
    testCaseId: task.testCase.id,
  });
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
    logRun("跳过 Playwright 执行", {
      runLogId: task.runLogId,
      testCaseId: latestTestCase.id,
      status: latestTestCase.status,
      hasScript: Boolean(latestTestCase.playwrightScript),
    });
    return;
  }

  await updateStatus(task.runLogId, latestTestCase.id, "running");

  // runPlaywright 通过 Playwright 命令退出码返回 success，服务层只负责落最终状态。
  const result = await runPlaywright(latestTestCase.playwrightScript, baseUrl, latestTestCase.id);

  if (result.success) {
    logRun("用例执行成功", {
      runLogId: task.runLogId,
      testCaseId: latestTestCase.id,
    });
    await markFinished(task.runLogId, latestTestCase.id, "success", result.stdout, result.stderr);
    return;
  }

  logRun("用例执行失败", {
    runLogId: task.runLogId,
    testCaseId: latestTestCase.id,
    failureReason: result.failureReason,
  });
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
    logRun("保存 agent 生成脚本", {
      runLogId: task.runLogId,
      testCaseId: task.testCase.id,
      specPath,
      scriptLength: script.length,
    });
    return true;
  } catch {
    logRun("agent 未生成目标 spec 文件", {
      runLogId: task.runLogId,
      testCaseId: task.testCase.id,
      specPath,
    });
    await markFinished(
      task.runLogId,
      task.testCase.id,
      "failed",
      "",
      "",
      `Agent 未生成用例文件: ${task.testCase.id}.spec.ts`,
    );
    return false;
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
    logRun("没有项目配置，无法运行用例");
    throw new Error("请先在配置页新建项目");
  }

  logRun("读取项目配置", {
    projectId: project.id,
    baseUrl: project.baseUrl,
    variableCount: project.variables.length,
  });
  return project;
}

// 判断当前用例是否需要重新生成 Playwright 脚本。
function shouldRegenerate(
  previousStatus: TestCaseRunStatus,
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
  logRun("更新用例运行状态", { runLogId, testCaseId, status });
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
  logRun("标记运行结束", {
    runLogId,
    testCaseId,
    status,
    failureReason,
  });

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

// 输出运行服务日志。
function logRun(message: string, data?: unknown) {
  console.log(`[testCaseRunService] ${message}`, data ?? "");
}
