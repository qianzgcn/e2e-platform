import { readFile } from "node:fs/promises";
import path from "node:path";
import { generateScript, type ScriptSource } from "./agentService.js";
import { AsyncQueue } from "../infra/asyncQueue.js";
import { prisma } from "../infra/prisma.js";
import { runPlaywright } from "../infra/runnerService.js";
import { shouldGenerateScript } from "../utils/testCaseScriptGeneration.js";
import {
  ACTIVE_STATUSES,
  SUBMITTABLE_STATUSES,
  USER_STOP_FAILURE_REASON,
  splitRunTargetsByStatus,
  toSkippedRunCase,
  type SkippedRunCase,
  type TestCaseRunStatus,
} from "../utils/runStatus.js";

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
  projectId: number;
  naturalLanguage: string;
  status: TestCaseRunStatus;
  playwrightScript: string | null;
  scriptNeedsGeneration: boolean;
  scriptGeneratedAt: Date | null;
};

type RunTask = {
  runLogId: number;
  testCase: RunTargetTestCase;
  // 提交时的项目 baseUrl 快照，生成和执行都以此为准，避免 worker 反复查库。
  baseUrl: string;
  generationLogLines?: string[];
};

type GenerationItem = {
  task: RunTask;
  source: ScriptSource;
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

// 全局共享池：所有提交的用例（不分批次）进这两个队列，常驻 worker 消费。
// 这样一次提交里慢生成不会阻塞另一次提交的快速用例（排队 bug 的根因）。
const generationQueue = new AsyncQueue<GenerationItem>();
const readyQueue = new AsyncQueue<RunTask>();
const activeGenerationRuns = new Map<number, GenerationControl>();
const activePlaywrightRuns = new Map<number, PlaywrightControl>();

const GENERATION_LOG_HEADER = "[用例生成日志]";

// Playwright 执行并发度；浏览器进程较重，默认 3，可用 MAX_PLAYWRIGHT_CONCURRENCY 按机器内存调整。
const PLAYWRIGHT_CONCURRENCY = resolvePlaywrightConcurrency();

function resolvePlaywrightConcurrency() {
  const raw = Number(process.env.MAX_PLAYWRIGHT_CONCURRENCY);
  return Number.isInteger(raw) && raw > 0 ? raw : 3;
}

// Agent 生成并发度；每个 worker 一次处理一条用例（一次 SDK 调用），可用 MAX_GENERATION_CONCURRENCY 调整。
const GENERATION_CONCURRENCY = resolveGenerationConcurrency();

function resolveGenerationConcurrency() {
  const raw = Number(process.env.MAX_GENERATION_CONCURRENCY);
  return Number.isInteger(raw) && raw > 0 ? raw : 3;
}

// 启动常驻 worker（生成 + 执行），在服务启动、中断恢复之后调用一次。
export function startRunWorkers() {
  for (let workerIndex = 0; workerIndex < GENERATION_CONCURRENCY; workerIndex += 1) {
    void drainGenerationLoop(workerIndex);
  }
  for (let workerIndex = 0; workerIndex < PLAYWRIGHT_CONCURRENCY; workerIndex += 1) {
    void drainReadyLoop();
  }
  logRun("运行 worker 已启动", { generationConcurrency: GENERATION_CONCURRENCY, playwrightConcurrency: PLAYWRIGHT_CONCURRENCY });
}

// 单条运行复用批量提交结果，返回统一的 runIds/skippedCases 结构。
export async function runTestCase(testCaseId: string) {
  logRun("收到单用例运行请求", { testCaseId });
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

// 全量运行指定项目的用例；活跃态用例会在提交时自动跳过。
export async function runAllTestCases(projectId: number) {
  logRun("收到全量运行请求", { projectId });
  return submitRunTargets(await findAllRunTargets(projectId));
}

async function submitRunTargets(testCases: RunTargetTestCase[]) {
  const { runnableTestCases, skippedCases } = splitRunTargetsByStatus(testCases);
  if (!runnableTestCases.length) {
    logRun("运行提交完成（无可运行用例）", { requestedCount: testCases.length, skippedCount: skippedCases.length });
    return { runIds: [], skippedCases };
  }

  const project = await getProject(runnableTestCases[0].projectId);
  const queuedResult = await createQueuedRunTasks(runnableTestCases, project.baseUrl);
  dispatchTasks(queuedResult.tasks, project);

  const allSkippedCases = [...skippedCases, ...queuedResult.skippedCases];
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

// 把提交的 task 分流到全局队列：有可复用脚本直接执行，否则进生成队列。变量解析失败直接判失败。
function dispatchTasks(tasks: RunTask[], project: ProjectConfig) {
  for (const task of tasks) {
    const { testCase } = task;

    if (
      !shouldGenerateScript({
        scriptNeedsGeneration: testCase.scriptNeedsGeneration,
        playwrightScript: testCase.playwrightScript,
      })
    ) {
      appendGenerationLog(task, "本次复用已有 Playwright 脚本，未进入 agent 生成");
      logRun("复用已有脚本，直接执行", { runLogId: task.runLogId, testCaseId: testCase.id });
      readyQueue.enqueue(task);
      continue;
    }

    try {
      appendGenerationLog(task, "开始解析自然语言用例变量");
      // 变量替换只影响传给 agent 的内容，不回写自然语言用例原文。
      const resolvedNaturalLanguage = resolveVariables(testCase.naturalLanguage, project.variables);
      appendGenerationLog(task, "变量解析完成，等待进入 agent 生成");
      generationQueue.enqueue({
        task,
        source: { id: testCase.id, title: testCase.title, naturalLanguage: resolvedNaturalLanguage },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "变量解析失败";
      appendGenerationLog(task, `变量解析失败：${message}`);
      logRun("变量解析失败", { runLogId: task.runLogId, testCaseId: testCase.id, message });
      void markFinished(task.runLogId, testCase.id, "failed", { stdout: getGenerationLog(task), stderr: "", failureReason: message });
    }
  }
}

// 停止当前活跃运行：排队态移出内存队列，生成态终止该用例的 Claude 生成，运行态终止 Playwright。
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
    logRun("已停止 Claude 生成", {
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

async function createQueuedRunTasks(testCases: RunTargetTestCase[], baseUrl: string) {
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

      // 用户点击运行后立即落库，前端可以马上看到"排队中"的运行记录。
      const runLog = await tx.runLog.create({
        data: {
          testCaseId: testCase.id,
          status: "queued",
          startedAt: now,
        },
      });

      tasks.push({ runLogId: runLog.id, testCase, baseUrl });
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

// 生成 worker：每个 worker 绑定独立 playwright-cli session（gen-{i}），并发互不踩浏览器。
async function drainGenerationLoop(workerIndex: number) {
  const sessionId = `gen-${workerIndex}`;
  while (true) {
    const next = await generationQueue.next();
    if (next.done) {
      return;
    }
    await generateSingleScript(next.value, sessionId);
  }
}

// 执行 worker：并发消费就绪队列，并发度由 MAX_PLAYWRIGHT_CONCURRENCY 控制（默认 3）。
async function drainReadyLoop() {
  while (true) {
    const next = await readyQueue.next();
    if (next.done) {
      return;
    }
    await executeTaskWithIsolation(next.value);
  }
}

// 生成单个用例的脚本：独立一次 SDK 调用、独立 abort 控制，失败只影响这一条。
async function generateSingleScript(item: GenerationItem, sessionId: string) {
  const { task, source } = item;
  const transitioned = await updateStatus(task.runLogId, task.testCase.id, "generating");
  if (!transitioned) {
    return;
  }

  const control = registerGenerationControl([task]);
  appendGenerationLog(task, "进入 agent 生成");
  logRun("开始调用 agent 生成用例", { runLogId: task.runLogId, testCaseId: source.id, sessionId });

  try {
    await generateScript(source, task.baseUrl, {
      signal: control.controller.signal,
      stopReason: USER_STOP_FAILURE_REASON,
      onProgress: (message) => appendGenerationLog(task, message),
      sessionId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Claude 生成用例失败";
    appendGenerationLog(task, `agent 生成失败：${message}`);
    logRun("agent 生成用例失败", { runLogId: task.runLogId, testCaseId: source.id, message });
    await markFinished(task.runLogId, task.testCase.id, "failed", { stdout: getGenerationLog(task), stderr: "", failureReason: message });
    return;
  } finally {
    unregisterGenerationControl(control);
  }

  if (await saveGeneratedScript(task)) {
    readyQueue.enqueue(task);
  }
}

async function executeTaskWithIsolation(task: RunTask) {
  try {
    await executeTask(task);
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

// 执行单个用例的 Playwright 脚本并落最终状态。
async function executeTask(task: RunTask) {
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
    result = await runPlaywright(script, task.baseUrl, latestTestCase.id, {
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
      projectId: true,
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

// 查询指定项目的所有用例，供全量运行使用。
async function findAllRunTargets(projectId: number) {
  return (await prisma.testCase.findMany({
    where: { projectId },
    orderBy: { editedAt: "desc" },
    select: {
      id: true,
      title: true,
      projectId: true,
      naturalLanguage: true,
      status: true,
      playwrightScript: true,
      scriptNeedsGeneration: true,
      scriptGeneratedAt: true,
    },
  })) as RunTargetTestCase[];
}

// 获取指定项目的配置和变量。
async function getProject(projectId: number) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { variables: true },
  });

  if (!project) {
    logRun("项目不存在，无法运行用例", { projectId });
    throw new Error("项目不存在");
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

// 从两个全局队列摘出排队中（尚未交付给 worker）的 task，停止时调用。
function removeQueuedTasks(runLogId: number) {
  const fromGeneration = generationQueue.remove((item) => item.task.runLogId === runLogId).map((item) => item.task);
  const fromReady = readyQueue.remove((task) => task.runLogId === runLogId);
  return [...fromGeneration, ...fromReady];
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
