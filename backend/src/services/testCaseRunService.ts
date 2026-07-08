import { readFile } from "node:fs/promises";
import path from "node:path";
import { generateScripts, type ScriptSource } from "./agentService.js";
import { cleanupPlaywrightCliWorkspace } from "./cleanupService.js";
import { prisma } from "../prisma.js";
import { runPlaywright } from "./runnerService.js";
import { chunkByAgentGenerationBatchSize } from "./runBatch.js";
import { shouldGenerateScript } from "./testCaseScriptGeneration.js";
import {
  ACTIVE_STATUSES,
  SUBMITTABLE_STATUSES,
  USER_STOP_FAILURE_REASON,
  splitRunTargetsByStatus,
  toSkippedRunCase,
  type SkippedRunCase,
  type TestCaseRunStatus,
} from "./runStatus.js";

type SharedRunningStatus = "queued" | "generating" | "running" | "success" | "failed";

type ProjectConfig = {
  baseUrl: string;
  variables: ProjectVariable[];
};

type ProjectVariable = {
  name: string;
  value: string;
};

type RunTargetTestCase = {
  id: string;
  title: string;
  naturalLanguage: string;
  status: TestCaseRunStatus;
  playwrightScript: string | null;
  scriptNeedsGeneration: boolean;
  scriptGeneratedAt: Date | null;
};

type RunTask = {
  runLogId: number;
  testCase: RunTargetTestCase;
  generationLogLines?: string[];
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

type StopTarget = {
  runLogId: number;
  testCaseId: string;
};

type StopRunResult = {
  stopped: boolean;
  affectedTestCaseIds: string[];
};

type GenerationControl = {
  controller: AbortController;
  tasks: RunTask[];
};

type PlaywrightControl = {
  controller: AbortController;
};

const runBatchQueue: RunTask[][] = [];
const activeReadyQueues = new Set<ReadyTaskQueue>();
const activeGenerationRuns = new Map<number, GenerationControl>();
const activePlaywrightRuns = new Map<number, PlaywrightControl>();
let isRunBatchQueueDraining = false;

const GENERATION_LOG_HEADER = "[用例生成日志]";

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

  return submitRunTargets(testCases);
}

// 全量运行所有用例；活跃态用例会在提交时自动跳过。
export async function runAllTestCases() {
  logRun("收到全量运行请求");
  return submitRunTargets(await findAllRunTargets());
}

async function submitRunTargets(testCases: RunTargetTestCase[]) {
  const { runnableTestCases, skippedCases } = splitRunTargetsByStatus(testCases);
  const queuedResult = runnableTestCases.length
    ? await createQueuedRunTasks(runnableTestCases)
    : { tasks: [], skippedCases: [] };
  const allSkippedCases = [...skippedCases, ...queuedResult.skippedCases];

  if (queuedResult.tasks.length) {
    enqueueRunBatch(queuedResult.tasks);
  }

  logRun("运行提交完成", {
    requestedCount: testCases.length,
    queuedCount: queuedResult.tasks.length,
    skippedCount: allSkippedCases.length,
  });

  return {
    runIds: queuedResult.tasks.map((task) => task.runLogId),
    skippedCases: allSkippedCases,
  };
}

// 停止当前活跃运行：排队态移出内存队列，生成态终止 Claude 小批次，运行态终止 Playwright。
export async function stopTestCaseRun(testCaseId: string): Promise<StopRunResult> {
  logRun("收到停止用例请求", { testCaseId });
  const testCase = await prisma.testCase.findUnique({
    where: { id: testCaseId },
    select: { id: true },
  });

  if (!testCase) {
    throw new Error("用例不存在");
  }

  const activeRunLog = await prisma.runLog.findFirst({
    where: {
      testCaseId,
      status: { in: ACTIVE_STATUSES },
      finishedAt: null,
    },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      testCaseId: true,
    },
  });

  if (!activeRunLog) {
    logRun("停止请求未找到活跃运行", { testCaseId });
    return { stopped: false, affectedTestCaseIds: [] };
  }

  const generationControl = activeGenerationRuns.get(activeRunLog.id);
  if (generationControl) {
    generationControl.controller.abort(new Error(USER_STOP_FAILURE_REASON));
    const targets = generationControl.tasks.map(toStopTarget);
    await markRunsStopped(targets);
    logRun("已停止 Claude 生成小批次", {
      testCaseId,
      affectedTestCaseIds: targets.map((target) => target.testCaseId),
    });
    return toStopRunResult(targets);
  }

  const playwrightControl = activePlaywrightRuns.get(activeRunLog.id);
  if (playwrightControl) {
    playwrightControl.controller.abort(new Error(USER_STOP_FAILURE_REASON));
  }

  const removedTasks = removeQueuedTasks(activeRunLog.id);
  const targets = removedTasks.length ? removedTasks.map(toStopTarget) : [{ runLogId: activeRunLog.id, testCaseId }];
  await markRunsStopped(targets);
  logRun("已停止用例运行", {
    testCaseId,
    affectedTestCaseIds: targets.map((target) => target.testCaseId),
  });
  return toStopRunResult(targets);
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
    await Promise.all(
      tasks.map((task) => {
        appendGenerationLog(task, `运行批次失败：${message}`);
        return markFinished(task.runLogId, task.testCase.id, "failed", { stdout: getGenerationLog(task), stderr: "", failureReason: message });
      }),
    );
  } finally {
    await cleanupRunWorkspace();
  }
}

// 批次内双流水线：已有脚本先执行，agent 生成完成的用例再追加执行。
async function processRunPipeline(tasks: RunTask[], project: ProjectConfig) {
  const readyQueue = createReadyTaskQueue();
  activeReadyQueues.add(readyQueue);

  try {
    const generationItems = await collectGenerationItems(tasks, project, readyQueue);
    await Promise.all([executeReadyTaskQueue(readyQueue, project.baseUrl), generateNeededScripts(generationItems, project, readyQueue)]);
  } finally {
    activeReadyQueues.delete(readyQueue);
  }
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
    appendGenerationLog(task, `用例执行异常：${message}`);
    logRun("用例执行异常", {
      runLogId: task.runLogId,
      testCaseId: task.testCase.id,
      message,
    });
    await markFinished(task.runLogId, task.testCase.id, "failed", { stdout: getGenerationLog(task), stderr: "", failureReason: message });
  }
}

// 筛选需要生成的用例；可复用脚本的用例直接进入执行队列。
async function collectGenerationItems(tasks: RunTask[], project: ProjectConfig, readyQueue: ReadyTaskQueue) {
  const generationItems: GenerationItem[] = [];

  for (const task of tasks) {
    const { testCase } = task;

    if (
      !shouldGenerateScript({
        scriptNeedsGeneration: testCase.scriptNeedsGeneration,
        playwrightScript: testCase.playwrightScript,
      })
    ) {
      appendGenerationLog(task, "本次复用已有 Playwright 脚本，未进入 agent 生成");
      logRun("复用已有脚本，跳过 agent 生成", {
        runLogId: task.runLogId,
        testCaseId: testCase.id,
        status: testCase.status,
        scriptNeedsGeneration: testCase.scriptNeedsGeneration,
      });
      enqueueReadyTask(readyQueue, task);
      continue;
    }

    try {
      appendGenerationLog(task, "开始解析自然语言用例变量");
      // 变量替换只影响传给 agent 的内容，不回写自然语言用例原文。
      const resolvedNaturalLanguage = resolveVariables(testCase.naturalLanguage, project.variables);
      appendGenerationLog(task, "变量解析完成，等待进入 agent 生成");
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
        scriptNeedsGeneration: testCase.scriptNeedsGeneration,
        hasScript: Boolean(testCase.playwrightScript),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "变量解析失败";
      appendGenerationLog(task, `变量解析失败：${message}`);
      logRun("变量解析失败", {
        runLogId: task.runLogId,
        testCaseId: testCase.id,
        message,
      });
      await markFinished(task.runLogId, testCase.id, "failed", { stdout: getGenerationLog(task), stderr: "", failureReason: message });
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
  const transitionResults = await Promise.all(
    generationItems.map((item) => updateStatus(item.task.runLogId, item.task.testCase.id, "generating")),
  );
  const activeItems = generationItems.filter((_item, index) => transitionResults[index]);

  if (!activeItems.length) {
    return;
  }

  const generationTasks = activeItems.map((item) => item.task);
  const generationControl = registerGenerationControl(generationTasks);
  appendGenerationLogToItems(activeItems, `进入 agent 生成，批次包含 ${activeItems.length} 条用例`);
  logRun("开始调用 agent 生成脚本小批次", {
    caseCount: activeItems.length,
    testCaseIds: activeItems.map((item) => item.source.id),
  });

  try {
    await generateScripts(
      activeItems.map((item) => item.source),
      project.baseUrl,
      {
        signal: generationControl.controller.signal,
        stopReason: USER_STOP_FAILURE_REASON,
        onProgress: (message) => appendGenerationLogToItems(activeItems, message),
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Claude Code 生成用例失败";
    appendGenerationLogToItems(activeItems, `agent 生成失败：${message}`);
    logRun("调用 agent 生成脚本小批次失败", {
      testCaseIds: activeItems.map((item) => item.source.id),
      message,
    });
    await Promise.all(
      generationTasks.map((task) => markFinished(task.runLogId, task.testCase.id, "failed", { stdout: getGenerationLog(task), stderr: "", failureReason: message })),
    );
    return;
  } finally {
    unregisterGenerationControl(generationControl);
  }

  for (const item of activeItems) {
    const saved = await saveGeneratedScript(item.task);
    if (saved) {
      enqueueReadyTask(readyQueue, item.task);
    }
  }

  logRun("agent 生成脚本小批次保存完成", {
    testCaseIds: activeItems.map((item) => item.source.id),
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
    appendGenerationLog(task, "跳过 Playwright 执行：脚本生成阶段已失败或脚本为空");
    logRun("跳过 Playwright 执行", {
      runLogId: task.runLogId,
      testCaseId: latestTestCase.id,
      status: latestTestCase.status,
      hasScript: Boolean(latestTestCase.playwrightScript),
    });
    return;
  }

  const script = latestTestCase.playwrightScript;
  const switchedToRunning = await updateStatus(task.runLogId, latestTestCase.id, "running");
  if (!switchedToRunning) {
    appendGenerationLog(task, "运行日志已结束，跳过 Playwright 执行");
    logRun("用例已停止，跳过 Playwright 执行", {
      runLogId: task.runLogId,
      testCaseId: latestTestCase.id,
    });
    return;
  }

  // runPlaywright 通过 Playwright 命令退出码返回 success，服务层只负责落最终状态。
  const playwrightControl = registerPlaywrightControl(task);
  let result;
  try {
    result = await runPlaywright(script, baseUrl, latestTestCase.id, {
      signal: playwrightControl.controller.signal,
      stopReason: USER_STOP_FAILURE_REASON,
    });
  } finally {
    unregisterPlaywrightControl(task.runLogId, playwrightControl);
  }

  if (result.success) {
    appendGenerationLog(task, "Playwright 执行成功");
    logRun("用例执行成功", {
      runLogId: task.runLogId,
      testCaseId: latestTestCase.id,
    });
    await markFinished(task.runLogId, latestTestCase.id, "success", { stdout: getGenerationLog(task), stderr: result.stderr });
    return;
  }

  appendGenerationLog(task, `Playwright 执行失败：${truncateLogMessage(result.failureReason ?? "未知错误")}`);
  logRun("用例执行失败", {
    runLogId: task.runLogId,
    testCaseId: latestTestCase.id,
    failureReason: result.failureReason,
  });
  await markFinished(task.runLogId, latestTestCase.id, "failed", {
    stdout: getGenerationLog(task),
    stderr: result.stderr,
    failureReason: result.failureReason,
  });
}

// 读取 Claude 生成的 spec 文件，并保存回数据库。
async function saveGeneratedScript(task: RunTask) {
  const specPath = path.resolve(process.cwd(), "tests", "generated", `${task.testCase.id}.spec.ts`);

  try {
    // Claude 只负责写文件；数据库里的 playwrightScript 以文件内容为准。
    const script = await readFile(specPath, "utf8");
    task.testCase.playwrightScript = script;
    task.testCase.scriptGeneratedAt = new Date();

    const saved = await prisma.$transaction(async (tx) => {
      const activeRunLog = await tx.runLog.findFirst({
        where: {
          id: task.runLogId,
          testCaseId: task.testCase.id,
          status: { in: ACTIVE_STATUSES },
          finishedAt: null,
        },
        select: { id: true },
      });

      if (!activeRunLog) {
        return false;
      }

      const updated = await tx.testCase.updateMany({
        where: {
          id: task.testCase.id,
          status: { in: ACTIVE_STATUSES },
        },
        data: {
          playwrightScript: script,
          scriptGeneratedAt: task.testCase.scriptGeneratedAt,
          scriptNeedsGeneration: false,
        },
      });
      return updated.count === 1;
    });

    if (!saved) {
      appendGenerationLog(task, "用例已停止，跳过保存 agent 脚本");
      logRun("用例已停止，跳过保存 agent 脚本", {
        runLogId: task.runLogId,
        testCaseId: task.testCase.id,
      });
      return false;
    }

    appendGenerationLog(task, `保存 agent 生成脚本成功：${path.relative(process.cwd(), specPath).replaceAll(path.sep, "/")}`);
    logRun("保存 agent 生成脚本", {
      runLogId: task.runLogId,
      testCaseId: task.testCase.id,
      specPath,
      scriptLength: script.length,
    });
    return true;
  } catch {
    appendGenerationLog(task, `agent 未生成目标 spec 文件：${task.testCase.id}.spec.ts`);
    logRun("agent 未生成目标 spec 文件", {
      runLogId: task.runLogId,
      testCaseId: task.testCase.id,
      specPath,
    });
    await markFinished(task.runLogId, task.testCase.id, "failed", {
      stdout: getGenerationLog(task),
      stderr: "",
      failureReason: `Agent 未生成用例文件: ${task.testCase.id}.spec.ts`,
    });
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
      scriptNeedsGeneration: true,
      scriptGeneratedAt: true,
    },
  })) as RunTargetTestCase[];

  const orderMap = new Map(testCaseIds.map((id, index) => [id, index]));
  return testCases.sort((left, right) => orderMap.get(left.id)! - orderMap.get(right.id)!);
}

// 查询所有用例，供全量运行使用。
async function findAllRunTargets() {
  return (await prisma.testCase.findMany({
    orderBy: { editedAt: "desc" },
    select: {
      id: true,
      title: true,
      naturalLanguage: true,
      status: true,
      playwrightScript: true,
      scriptNeedsGeneration: true,
      scriptGeneratedAt: true,
    },
  })) as RunTargetTestCase[];
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

// 只推进仍活跃的运行，避免用户停止后被后台流程重新写回运行中或成功。
async function updateStatus(runLogId: number, testCaseId: string, status: SharedRunningStatus) {
  logRun("更新用例运行状态", { runLogId, testCaseId, status });
  return prisma.$transaction(async (tx) => {
    const runLogResult = await tx.runLog.updateMany({
      where: {
        id: runLogId,
        testCaseId,
        status: { in: ACTIVE_STATUSES },
        finishedAt: null,
      },
      data: { status },
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

// 标记一次运行结束，并写入输出和失败原因。
async function markFinished(
  runLogId: number,
  testCaseId: string,
  status: "success" | "failed",
  { stdout, stderr, failureReason }: { stdout: string; stderr: string; failureReason?: string },
) {
  const finishedAt = new Date();
  logRun("标记运行结束", {
    runLogId,
    testCaseId,
    status,
    failureReason,
  });

  // 结束时先锁定本次运行日志，再同步用例状态，避免旧后台任务覆盖新运行。
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
        lastRunAt: finishedAt,
        lastFailureReason: status === "failed" ? failureReason ?? stderr : null,
      },
    });
    return true;
  });
}

function registerGenerationControl(tasks: RunTask[]) {
  const control: GenerationControl = {
    controller: new AbortController(),
    tasks,
  };

  for (const task of tasks) {
    activeGenerationRuns.set(task.runLogId, control);
  }

  return control;
}

function unregisterGenerationControl(control: GenerationControl) {
  for (const task of control.tasks) {
    if (activeGenerationRuns.get(task.runLogId) === control) {
      activeGenerationRuns.delete(task.runLogId);
    }
  }
}

function registerPlaywrightControl(task: RunTask) {
  const control: PlaywrightControl = {
    controller: new AbortController(),
  };

  activePlaywrightRuns.set(task.runLogId, control);
  return control;
}

function unregisterPlaywrightControl(runLogId: number, control: PlaywrightControl) {
  if (activePlaywrightRuns.get(runLogId) === control) {
    activePlaywrightRuns.delete(runLogId);
  }
}

function removeQueuedTasks(runLogId: number) {
  const removedTasks: RunTask[] = [];

  for (let batchIndex = runBatchQueue.length - 1; batchIndex >= 0; batchIndex -= 1) {
    const batch = runBatchQueue[batchIndex];
    const remaining = batch.filter((task) => {
      if (task.runLogId !== runLogId) {
        return true;
      }

      removedTasks.push(task);
      return false;
    });

    if (remaining.length) {
      runBatchQueue[batchIndex] = remaining;
    } else {
      runBatchQueue.splice(batchIndex, 1);
    }
  }

  for (const queue of activeReadyQueues) {
    const originalLength = queue.items.length;
    queue.items = queue.items.filter((task) => {
      if (task.runLogId !== runLogId) {
        return true;
      }

      removedTasks.push(task);
      return false;
    });

    if (queue.items.length !== originalLength) {
      wakeReadyTaskRunner(queue);
    }
  }

  return removedTasks;
}

async function markRunsStopped(targets: StopTarget[]) {
  await Promise.all(
    dedupeStopTargets(targets).map((target) =>
      markFinished(target.runLogId, target.testCaseId, "failed", { stdout: createGenerationLog(USER_STOP_FAILURE_REASON), stderr: "", failureReason: USER_STOP_FAILURE_REASON }),
    ),
  );
}

function dedupeStopTargets(targets: StopTarget[]) {
  const seen = new Set<number>();
  return targets.filter((target) => {
    if (seen.has(target.runLogId)) {
      return false;
    }

    seen.add(target.runLogId);
    return true;
  });
}

function toStopTarget(task: RunTask): StopTarget {
  return {
    runLogId: task.runLogId,
    testCaseId: task.testCase.id,
  };
}

function toStopRunResult(targets: StopTarget[]): StopRunResult {
  return {
    stopped: true,
    affectedTestCaseIds: Array.from(new Set(targets.map((target) => target.testCaseId))),
  };
}

function appendGenerationLogToItems(items: GenerationItem[], message: string) {
  for (const item of items) {
    appendGenerationLog(item.task, message);
  }
}

function appendGenerationLog(task: RunTask, message: string) {
  task.generationLogLines ??= [GENERATION_LOG_HEADER];
  task.generationLogLines.push(`${formatLogTime(new Date())} ${message}`);
  void persistGenerationLog(task);
}

function getGenerationLog(task: RunTask) {
  return (task.generationLogLines ?? [GENERATION_LOG_HEADER, `${formatLogTime(new Date())} 暂无用例生成日志`]).join("\n");
}

function createGenerationLog(message: string) {
  return [GENERATION_LOG_HEADER, `${formatLogTime(new Date())} ${message}`].join("\n");
}

async function persistGenerationLog(task: RunTask) {
  try {
    await prisma.runLog.updateMany({
      where: {
        id: task.runLogId,
        testCaseId: task.testCase.id,
        status: { in: ACTIVE_STATUSES },
        finishedAt: null,
      },
      data: {
        stdout: getGenerationLog(task),
      },
    });
  } catch (error) {
    logRun("实时写入用例生成日志失败", {
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

function truncateLogMessage(message: string) {
  return message.length <= 300 ? message : `${message.slice(0, 300)}...`;
}

// 输出运行服务日志。
function logRun(message: string, data?: unknown) {
  console.log(`[testCaseRunService] ${message}`, data ?? "");
}
