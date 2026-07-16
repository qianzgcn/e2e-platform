import { readFile } from "node:fs/promises";
import path from "node:path";
import { generateScript } from "./agentService.js";
import { AsyncQueue } from "../infra/asyncQueue.js";
import { prisma } from "../infra/prisma.js";
import { resolveProjectAutomationAdapter } from "../infra/projectAutomationAdapter.js";
import { runPlaywright } from "../infra/runnerService.js";
import { formatTestDataSafetyIssue, validateTestDataSafety } from "../prompts/testDataSafety.js";
import { shouldGenerateScript } from "../utils/testCaseScriptGeneration.js";
import {
  ACTIVE_STATUSES,
  SUBMITTABLE_STATUSES,
  USER_STOP_FAILURE_REASON,
  splitRunTargetsByStatus,
  toSkippedRunCase,
  type SkippedRunCase,
} from "../utils/runStatus.js";
import { executeTestCaseRepair } from "./testCaseRepairService.js";
import {
  appendRunLog,
  appendTerminalRunLog,
  createRunLog,
  finishRunTask,
  getRunLog,
  getRunLogHeader,
  logRun,
  markRunFinished,
  truncateRunLogMessage,
  updateRunStatus,
} from "./testCaseRunLogService.js";
import type {
  GenerationControl,
  GenerationItem,
  PlaywrightControl,
  ProjectConfig,
  RepairItem,
  RunTargetTestCase,
  RunTask,
  ScriptGenerationItem,
  StopRunResult,
  StopTarget,
} from "./testCaseRunTypes.js";
import { resolveTestCaseVariables } from "./testCaseVariables.js";

// 全局共享池：所有提交的用例（不分批次）进这两个队列，常驻 worker 消费。
// 这样一次提交里慢生成不会阻塞另一次提交的快速用例（排队 bug 的根因）。
const generationQueue = new AsyncQueue<GenerationItem>();
const readyQueue = new AsyncQueue<RunTask>();
const activeGenerationRuns = new Map<number, GenerationControl>();
const activePlaywrightRuns = new Map<number, PlaywrightControl>();

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

// 手动提交一次 AI 修复；修复依据始终是当前用例最近一次失败记录。
export async function repairTestCase(testCaseId: string) {
  const testCase = await prisma.testCase.findUnique({
    where: { id: testCaseId },
    select: {
      id: true,
      title: true,
      projectId: true,
      naturalLanguage: true,
      status: true,
      playwrightScript: true,
      scriptNeedsGeneration: true,
      scriptGeneratedAt: true,
      editedAt: true,
      group: { select: { name: true } },
      runLogs: {
        where: { kind: "execution", status: "failed" },
        orderBy: { startedAt: "desc" },
        take: 1,
        select: { id: true, failureReason: true, stdout: true, stderr: true },
      },
      repairCandidates: {
        where: { kind: "repair", status: "pending" },
        take: 1,
        select: { id: true },
      },
    },
  });

  if (!testCase) throw new Error("用例不存在");
  if (testCase.status !== "failed") throw new Error("只有当前状态为失败的用例才能进行 AI 修复");
  if (!testCase.runLogs[0]) throw new Error("未找到可用于诊断的失败记录");
  if (testCase.repairCandidates.length) throw new Error("该用例已有待审核的修复候选，请先处理候选");

  const project = await getProject(testCase.projectId);
  const initialLogs = createRunLog("repair", `修复任务已创建，失败来源 #${testCase.runLogs[0].id}`);
  const repairLog = await prisma.$transaction(async (tx) => {
    const claimed = await tx.testCase.updateMany({
      where: { id: testCase.id, status: "failed" },
      data: { status: "queued" },
    });
    if (claimed.count !== 1) {
      throw new Error("用例状态已变化，请刷新后重试");
    }

    return tx.runLog.create({
      data: {
        testCaseId: testCase.id,
        kind: "repair",
        status: "queued",
        logs: initialLogs,
        sourceRunLogId: testCase.runLogs[0].id,
      },
      select: { id: true },
    });
  });

  const task: RunTask = {
    runLogId: repairLog.id,
    kind: "repair",
    testCase: {
      id: testCase.id,
      title: testCase.title,
      projectId: testCase.projectId,
      naturalLanguage: testCase.naturalLanguage,
      status: testCase.status,
      playwrightScript: testCase.playwrightScript,
      scriptNeedsGeneration: testCase.scriptNeedsGeneration,
      scriptGeneratedAt: testCase.scriptGeneratedAt,
    },
    baseUrl: project.baseUrl,
    projectInstructions: project.promptHint,
    automationInstructions: project.automationHint,
    automationAdapter: project.automationAdapter,
    logWriter: { lines: initialLogs.split("\n"), pending: Promise.resolve() },
  };

  generationQueue.enqueue({
    kind: "repair",
    task,
    project,
    sourceRunLog: testCase.runLogs[0],
    sourceEditedAt: testCase.editedAt,
    groupName: testCase.group.name,
  });
  logRun("AI 修复任务已入队", { testCaseId, repairLogId: repairLog.id });
  return { repairLogId: repairLog.id };
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
  const queuedResult = await createQueuedRunTasks(runnableTestCases, project);
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

    const safetyIssue = validateTestDataSafety(testCase.naturalLanguage);
    if (safetyIssue) {
      const message = `用例未通过测试数据安全检查\n${formatTestDataSafetyIssue(safetyIssue)}`;
      void appendRunLog(task, message);
      logRun("测试数据安全检查未通过", { runLogId: task.runLogId, testCaseId: testCase.id });
      void finishRunTask(task, "failed", { stdout: "", stderr: "", failureReason: message });
      continue;
    }

    if (
      !shouldGenerateScript({
        scriptNeedsGeneration: testCase.scriptNeedsGeneration,
        playwrightScript: testCase.playwrightScript,
      })
    ) {
      void appendRunLog(task, "本次复用已有 Playwright 脚本，未进入 AI 生成");
      logRun("复用已有脚本，直接执行", { runLogId: task.runLogId, testCaseId: testCase.id });
      readyQueue.enqueue(task);
      continue;
    }

    try {
      void appendRunLog(task, "开始解析自然语言用例变量");
      // 变量替换只影响传给 agent 的内容，不回写自然语言用例原文。
      const resolvedNaturalLanguage = resolveTestCaseVariables(testCase.naturalLanguage, project.variables);
      void appendRunLog(task, "变量解析完成，等待进入 AI 生成");
      generationQueue.enqueue({
        kind: "generation",
        task,
        source: {
          id: testCase.id,
          title: testCase.title,
          originalNaturalLanguage: testCase.naturalLanguage,
          naturalLanguage: resolvedNaturalLanguage,
          protectedVariablePlaceholders: project.variables.map((variable) => `\${${variable.name}}`),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "变量解析失败";
      void appendRunLog(task, `变量解析失败：${message}`);
      logRun("变量解析失败", { runLogId: task.runLogId, testCaseId: testCase.id, message });
      void finishRunTask(task, "failed", { stdout: "", stderr: "", failureReason: message });
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
      kind: true,
    },
  });

  if (!activeRunLog) {
    logRun("停止请求未找到活跃运行", { testCaseId });
    return { stopped: false, affectedTestCaseIds: [] };
  }

  const generationControl = activeGenerationRuns.get(activeRunLog.id);
  if (generationControl) {
    generationControl.controller.abort(new Error(USER_STOP_FAILURE_REASON));
    const targets = await createStoppedTargets(generationControl.tasks);
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
  const stoppedTasks = playwrightControl ? [playwrightControl.task, ...removedTasks] : removedTasks;
  const targets = stoppedTasks.length
    ? await createStoppedTargets(stoppedTasks)
    : [{ runLogId: activeRunLog.id, testCaseId, kind: activeRunLog.kind }];
  await markRunsStopped(targets);
  logRun("已停止用例运行", {
    testCaseId,
    affectedTestCaseIds: targets.map((target) => target.testCaseId),
  });
  return toStopRunResult(targets);
}

async function createQueuedRunTasks(
  testCases: RunTargetTestCase[],
  project: ProjectConfig,
) {
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
          kind: "execution",
          status: "queued",
          logs: getRunLogHeader("execution"),
          startedAt: now,
        },
      });

      tasks.push({
        runLogId: runLog.id,
        kind: "execution",
        testCase,
        baseUrl: project.baseUrl,
        projectInstructions: project.promptHint,
        automationInstructions: project.automationHint,
        automationAdapter: project.automationAdapter,
      });
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
  while (true) {
    const next = await generationQueue.next();
    if (next.done) {
      return;
    }
    if (next.value.kind === "repair") {
      await repairSingleTestCase(next.value, `repair-${workerIndex}`);
    } else {
      await generateSingleScript(next.value, `gen-${workerIndex}`);
    }
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
async function generateSingleScript(item: ScriptGenerationItem, sessionId: string) {
  const { task, source } = item;
  const transitioned = await updateRunStatus(task.runLogId, task.testCase.id, "generating");
  if (!transitioned) {
    return;
  }

  const control = registerGenerationControl([task]);
  void appendRunLog(task, "进入 AI 脚本生成");
  logRun("开始调用 agent 生成用例", { runLogId: task.runLogId, testCaseId: source.id, sessionId });

  try {
    await generateScript(source, task.baseUrl, {
      signal: control.controller.signal,
      stopReason: USER_STOP_FAILURE_REASON,
      onProgress: (message) => appendRunLog(task, message),
      projectInstructions: task.projectInstructions,
      automationInstructions: task.automationInstructions,
      automationAdapter: task.automationAdapter,
      sessionId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Claude 生成用例失败";
    void appendRunLog(task, `AI 脚本生成失败：${message}`);
    logRun("agent 生成用例失败", { runLogId: task.runLogId, testCaseId: source.id, message });
    await finishRunTask(task, "failed", { stdout: "", stderr: "", failureReason: message });
    return;
  } finally {
    unregisterGenerationControl(control);
  }

  if (await saveGeneratedScript(task)) {
    readyQueue.enqueue(task);
  }
}

async function repairSingleTestCase(item: RepairItem, sessionId: string) {
  const { task } = item;
  const transitioned = await updateRunStatus(task.runLogId, task.testCase.id, "generating");
  if (!transitioned) {
    return;
  }

  const control = registerGenerationControl([task]);
  try {
    await executeTestCaseRepair(item, sessionId, control.controller.signal);
  } finally {
    unregisterGenerationControl(control);
  }
}

async function executeTaskWithIsolation(task: RunTask) {
  try {
    await executeTask(task);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Playwright 执行异常";
    void appendRunLog(task, `用例执行异常：${message}`);
    logRun("用例执行异常", {
      runLogId: task.runLogId,
      testCaseId: task.testCase.id,
      message,
    });
    await finishRunTask(task, "failed", { stdout: "", stderr: "", failureReason: message });
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
    void appendRunLog(task, "跳过 Playwright 执行：脚本生成阶段已失败或脚本为空");
    logRun("跳过 Playwright 执行", {
      runLogId: task.runLogId,
      testCaseId: latestTestCase.id,
      status: latestTestCase.status,
      hasScript: Boolean(latestTestCase.playwrightScript),
    });
    return;
  }

  const script = latestTestCase.playwrightScript;
  const switchedToRunning = await updateRunStatus(task.runLogId, latestTestCase.id, "running");
  if (!switchedToRunning) {
    void appendRunLog(task, "运行日志已结束，跳过 Playwright 执行");
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
    result = await runPlaywright(script, task.baseUrl, latestTestCase.id, task.runLogId, {
      signal: playwrightControl.controller.signal,
      stopReason: USER_STOP_FAILURE_REASON,
    });
  } finally {
    unregisterPlaywrightControl(task.runLogId, playwrightControl);
  }

  if (result.success) {
    void appendRunLog(task, "Playwright 执行成功");
    logRun("用例执行成功", {
      runLogId: task.runLogId,
      testCaseId: latestTestCase.id,
    });
    await finishRunTask(task, "success", { stdout: result.stdout, stderr: result.stderr });
    return;
  }

  void appendRunLog(task, `Playwright 执行失败：${truncateRunLogMessage(result.failureReason ?? "未知错误")}`);
  logRun("用例执行失败", {
    runLogId: task.runLogId,
    testCaseId: latestTestCase.id,
    failureReason: result.failureReason,
  });
  await finishRunTask(task, "failed", {
    stdout: result.stdout,
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
      void appendRunLog(task, "用例已停止，跳过保存 AI 脚本");
      logRun("用例已停止，跳过保存 agent 脚本", {
        runLogId: task.runLogId,
        testCaseId: task.testCase.id,
      });
      return false;
    }

    void appendRunLog(task, `保存 AI 生成脚本成功：${path.relative(process.cwd(), specPath).replaceAll(path.sep, "/")}`);
    logRun("保存 agent 生成脚本", {
      runLogId: task.runLogId,
      testCaseId: task.testCase.id,
      specPath,
      scriptLength: script.length,
    });
    return true;
  } catch {
    void appendRunLog(task, `AI 未生成目标 spec 文件：${task.testCase.id}.spec.ts`);
    logRun("agent 未生成目标 spec 文件", {
      runLogId: task.runLogId,
      testCaseId: task.testCase.id,
      specPath,
    });
    await finishRunTask(task, "failed", {
      stdout: "",
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

  const automationAdapter = project.automationAdapterKey
    ? await resolveProjectAutomationAdapter(project.automationAdapterKey)
    : null;

  logRun("读取项目配置", {
    projectId: project.id,
    baseUrl: project.baseUrl,
    hasPromptHint: Boolean(project.promptHint?.trim()),
    hasAutomationHint: Boolean(project.automationHint?.trim()),
    automationAdapterKey: automationAdapter?.key ?? null,
    variableCount: project.variables.length,
  });
  return { ...project, automationAdapter };
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
    task,
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
  const uniqueTargets = dedupeStopTargets(targets);
  const existingLogs = await prisma.runLog.findMany({
    where: { id: { in: uniqueTargets.map((target) => target.runLogId) } },
    select: { id: true, logs: true },
  });
  const logsById = new Map(existingLogs.map((runLog) => [runLog.id, runLog.logs]));
  await Promise.all(
    uniqueTargets.map((target) =>
      markRunFinished(target.runLogId, target.testCaseId, target.kind, "failed", {
        logs: target.logs ?? appendTerminalRunLog(logsById.get(target.runLogId), target.kind, USER_STOP_FAILURE_REASON),
        stdout: "",
        stderr: "",
        failureReason: USER_STOP_FAILURE_REASON,
      }),
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
    kind: task.kind,
  };
}

async function createStoppedTargets(tasks: RunTask[]) {
  const uniqueTasks = Array.from(new Map(tasks.map((task) => [task.runLogId, task])).values());
  await Promise.all(uniqueTasks.map((task) => appendRunLog(task, USER_STOP_FAILURE_REASON)));
  return uniqueTasks.map((task) => ({ ...toStopTarget(task), logs: getRunLog(task) }));
}

function toStopRunResult(targets: StopTarget[]): StopRunResult {
  return {
    stopped: true,
    affectedTestCaseIds: Array.from(new Set(targets.map((target) => target.testCaseId))),
  };
}
