import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateScript, type ScriptSource } from "./agentService.js";
import { AsyncQueue } from "../infra/asyncQueue.js";
import { prisma } from "../infra/prisma.js";
import { ensureRepo } from "../infra/repoService.js";
import { runPlaywright } from "../infra/runnerService.js";
import {
  assertNoProjectVariableValues,
  assertPreservesVariablePlaceholders,
  redactProjectVariableValues,
  type ScriptRepairResult,
} from "../prompts/scriptRepair.js";
import { formatScriptRepairProgress, repairScriptWithAgent } from "./scriptRepairAgentService.js";
import { getRunArtifactEvidence } from "../utils/artifactService.js";
import { shouldGenerateScript } from "../utils/testCaseScriptGeneration.js";
import { extractRepairVideoFrames, removeRepairWorkspace } from "../utils/videoFrameService.js";
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
  repoUrl: string | null;
  promptHint: string | null;
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
  kind: "execution" | "repair";
  testCase: RunTargetTestCase;
  // 提交时的项目配置快照，生成和执行都以此为准，避免 worker 反复查库。
  baseUrl: string;
  projectInstructions: string | null;
  logWriter?: {
    lines: string[];
    pending: Promise<void>;
  };
};

type ScriptGenerationItem = {
  kind: "generation";
  task: RunTask;
  source: ScriptSource;
};

type RepairItem = {
  kind: "repair";
  task: RunTask;
  project: ProjectConfig;
  sourceRunLog: {
    id: number;
    failureReason: string | null;
    stdout: string | null;
    stderr: string | null;
  };
  sourceEditedAt: Date;
  groupName: string;
};

type GenerationItem = ScriptGenerationItem | RepairItem;

type StopTarget = {
  runLogId: number;
  testCaseId: string;
  kind: RunTask["kind"];
  logs?: string;
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
  task: RunTask;
};

// 全局共享池：所有提交的用例（不分批次）进这两个队列，常驻 worker 消费。
// 这样一次提交里慢生成不会阻塞另一次提交的快速用例（排队 bug 的根因）。
const generationQueue = new AsyncQueue<GenerationItem>();
const readyQueue = new AsyncQueue<RunTask>();
const activeGenerationRuns = new Map<number, GenerationControl>();
const activePlaywrightRuns = new Map<number, PlaywrightControl>();

const EXECUTION_LOG_HEADER = "[用例运行日志]";
const REPAIR_LOG_HEADER = "[AI 修复日志]";

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
  if (testCase.scriptNeedsGeneration || !testCase.playwrightScript?.trim()) {
    throw new Error("当前用例没有可修复的 Playwright 脚本，请先运行并生成脚本");
  }
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
  const queuedResult = await createQueuedRunTasks(runnableTestCases, project.baseUrl, project.promptHint);
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
      void appendRunLog(task, "本次复用已有 Playwright 脚本，未进入 AI 生成");
      logRun("复用已有脚本，直接执行", { runLogId: task.runLogId, testCaseId: testCase.id });
      readyQueue.enqueue(task);
      continue;
    }

    try {
      void appendRunLog(task, "开始解析自然语言用例变量");
      // 变量替换只影响传给 agent 的内容，不回写自然语言用例原文。
      const resolvedNaturalLanguage = resolveVariables(testCase.naturalLanguage, project.variables);
      void appendRunLog(task, "变量解析完成，等待进入 AI 生成");
      generationQueue.enqueue({
        kind: "generation",
        task,
        source: { id: testCase.id, title: testCase.title, naturalLanguage: resolvedNaturalLanguage },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "变量解析失败";
      void appendRunLog(task, `变量解析失败：${message}`);
      logRun("变量解析失败", { runLogId: task.runLogId, testCaseId: testCase.id, message });
      void finishTask(task, "failed", { stdout: "", stderr: "", failureReason: message });
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
  baseUrl: string,
  projectInstructions: string | null,
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
          logs: EXECUTION_LOG_HEADER,
          startedAt: now,
        },
      });

      tasks.push({ runLogId: runLog.id, kind: "execution", testCase, baseUrl, projectInstructions });
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
  const transitioned = await updateStatus(task.runLogId, task.testCase.id, "generating");
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
      sessionId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Claude 生成用例失败";
    void appendRunLog(task, `AI 脚本生成失败：${message}`);
    logRun("agent 生成用例失败", { runLogId: task.runLogId, testCaseId: source.id, message });
    await finishTask(task, "failed", { stdout: "", stderr: "", failureReason: message });
    return;
  } finally {
    unregisterGenerationControl(control);
  }

  if (await saveGeneratedScript(task)) {
    readyQueue.enqueue(task);
  }
}

async function repairSingleTestCase(item: RepairItem, sessionId: string) {
  const { task, project, sourceRunLog } = item;
  const transitioned = await updateStatus(task.runLogId, task.testCase.id, "generating");
  if (!transitioned) return;

  const control = registerGenerationControl([task]);
  const originalScript = task.testCase.playwrightScript!;
  const specPath = path.resolve(process.cwd(), "tests", "generated", `${task.testCase.id}.spec.ts`);
  const candidateSpecPath = path.resolve(
    process.cwd(),
    "tests",
    "generated",
    `${task.testCase.id}.repair-${task.runLogId}.spec.ts`,
  );
  let lastProgress = "";

  try {
    await writeFile(candidateSpecPath, originalScript, "utf8");
    await appendRunLog(task, "开始收集最近一次失败记录和 Playwright 产物");
    const evidence = await getRunArtifactEvidence(task.testCase.id, sourceRunLog.id);
    const videoPaths = evidence.artifacts.filter((artifact) => artifact.type === "video").map((artifact) => artifact.filePath);

    let videoFramePaths: string[] = [];
    if (videoPaths.length) {
      await appendRunLog(task, "正在提取失败录屏关键帧");
      try {
        videoFramePaths = await extractRepairVideoFrames(task.runLogId, videoPaths);
        await appendRunLog(task, `录屏关键帧提取完成，共 ${videoFramePaths.length} 张`);
      } catch (error) {
        await appendRunLog(task, `录屏无法解析，将使用其他失败证据：${toErrorMessage(error)}`);
      }
    } else {
      await appendRunLog(task, "本次失败没有可用录屏，将使用日志、报告、代码和真实页面诊断");
    }

    let repositoryPath: string | null = null;
    if (project.repoUrl) {
      await appendRunLog(task, "正在同步业务代码仓库");
      try {
        repositoryPath = await ensureRepo(project.repoUrl, task.testCase.projectId);
        await appendRunLog(task, "业务代码仓库同步完成");
      } catch (error) {
        await appendRunLog(task, `业务代码仓库不可用，将使用其他证据：${toErrorMessage(error)}`);
      }
    } else {
      await appendRunLog(task, "项目未配置业务代码仓库，将使用其他证据诊断");
    }

    const resolvedNaturalLanguage = resolveVariables(task.testCase.naturalLanguage, project.variables);
    await appendRunLog(task, "失败证据准备完成，进入 AI 根因分析");
    const repairResult = await repairScriptWithAgent({
      baseUrl: task.baseUrl,
      targetFile: path.relative(process.cwd(), candidateSpecPath).replaceAll(path.sep, "/"),
      businessRepository: repositoryPath,
      projectInstructions: task.projectInstructions,
      testCase: {
        id: task.testCase.id,
        title: task.testCase.title,
        originalNaturalLanguage: task.testCase.naturalLanguage,
        resolvedNaturalLanguage,
      },
      currentScript: originalScript,
      sourceFailure: {
        runLogId: sourceRunLog.id,
        failureReason: sourceRunLog.failureReason,
        stdout: truncateEvidence(sourceRunLog.stdout),
        stderr: truncateEvidence(sourceRunLog.stderr),
        artifactPaths: [
          ...(evidence.reportPath ? [evidence.reportPath] : []),
          ...evidence.artifacts
            .filter((artifact) => artifact.type !== "video" && artifact.filePath !== evidence.reportPath)
            .map((artifact) => artifact.filePath),
        ].slice(0, 50),
        videoFramePaths,
      },
    }, {
      signal: control.controller.signal,
      stopReason: USER_STOP_FAILURE_REASON,
      sessionId,
      repairLogId: task.runLogId,
      onProgress: async (message) => {
        const progress = formatScriptRepairProgress(message);
        if (progress && progress !== lastProgress) {
          lastProgress = progress;
          await appendRunLog(task, progress);
        }
      },
    });

    await handleRepairResult(item, repairResult, specPath, candidateSpecPath, control.controller.signal);
  } catch (error) {
    const message = redactProjectVariableValues(toErrorMessage(error), project.variables);
    await appendRunLog(task, `AI 修复失败：${truncateLogMessage(message)}`);
    await finishTask(task, "failed", { stdout: "", stderr: "", failureReason: message });
  } finally {
    unregisterGenerationControl(control);
    await Promise.all([
      removeRepairWorkspace(task.runLogId),
      rm(path.resolve(process.cwd(), "test-results", task.testCase.id, `repair-${task.runLogId}-agent`), {
        recursive: true,
        force: true,
      }),
      rm(candidateSpecPath, { force: true }),
    ]).catch((error) => {
      logRun("清理 AI 修复临时文件失败", { repairLogId: task.runLogId, message: toErrorMessage(error) });
    });
  }
}

async function handleRepairResult(
  item: RepairItem,
  result: ScriptRepairResult,
  specPath: string,
  candidateSpecPath: string,
  signal: AbortSignal,
) {
  const { task, project } = item;
  if (result.outcome === "case_repair") {
    assertNoProjectVariableValues(result.naturalLanguage, project.variables);
    assertPreservesVariablePlaceholders(task.testCase.naturalLanguage, result.naturalLanguage);
    if (result.naturalLanguage.trim() === task.testCase.naturalLanguage.trim()) {
      throw new Error("AI 返回的自然语言修复候选与原用例相同");
    }
    const problem = redactProjectVariableValues(result.problem, project.variables);
    const suggestion = redactProjectVariableValues(result.suggestion, project.variables);
    await appendRunLog(task, "AI 判断自然语言用例需要修复，正在创建待审核候选");
    await completeCaseRepairCandidate(item, {
      naturalLanguage: result.naturalLanguage.trim(),
      problem,
      suggestion,
    });
    return;
  }

  if (result.outcome === "unrepairable") {
    const problem = redactProjectVariableValues(result.problem, project.variables);
    const suggestion = redactProjectVariableValues(result.suggestion, project.variables);
    const message = `无法安全修复（${toRepairCategoryText(result.category)}）\n问题：${problem}\n处理建议：${suggestion}`;
    await appendRunLog(task, message);
    await finishTask(task, "failed", { stdout: "", stderr: "", failureReason: message });
    return;
  }

  const candidateScript = await readFile(candidateSpecPath, "utf8");
  if (!candidateScript.trim() || candidateScript === task.testCase.playwrightScript) {
    throw new Error("AI 未产生有效的候选脚本修改");
  }

  const summary = redactProjectVariableValues(result.summary, project.variables);
  await appendRunLog(task, `AI 已生成候选脚本：${summary}`);
  if (!(await updateStatus(task.runLogId, task.testCase.id, "running"))) {
    return;
  }

  await appendRunLog(task, "开始平台独立 Playwright 验证");
  const validation = await runPlaywright(candidateScript, task.baseUrl, task.testCase.id, task.runLogId, {
    signal,
    stopReason: USER_STOP_FAILURE_REASON,
    specPath: candidateSpecPath,
  });
  if (!validation.success) {
    const failureReason = validation.failureReason ?? "候选脚本验证失败";
    await appendRunLog(task, `候选脚本验证失败，已保留原脚本：${truncateLogMessage(failureReason)}`);
    await finishTask(task, "failed", {
      stdout: validation.stdout,
      stderr: validation.stderr,
      failureReason,
    });
    return;
  }

  await appendRunLog(task, "候选脚本独立验证通过，正在保存修复结果");
  const saved = await completeScriptRepair(
    task,
    item.sourceEditedAt,
    candidateScript,
    validation.stdout,
    validation.stderr,
  );
  if (saved) {
    await writeFile(specPath, candidateScript, "utf8").catch((error) => {
      logRun("数据库已保存修复脚本，但同步生成文件失败", {
        repairLogId: task.runLogId,
        testCaseId: task.testCase.id,
        message: toErrorMessage(error),
      });
    });
  }
}

async function completeScriptRepair(
  task: RunTask,
  sourceEditedAt: Date,
  script: string,
  stdout: string,
  stderr: string,
) {
  await appendRunLog(task, "AI 脚本修复完成");
  await flushRunLog(task);
  const finishedAt = new Date();
  return prisma.$transaction(async (tx) => {
    const runLog = await tx.runLog.updateMany({
      where: { id: task.runLogId, testCaseId: task.testCase.id, status: { in: ACTIVE_STATUSES }, finishedAt: null },
      data: {
        status: "success",
        logs: getRunLog(task),
        stdout,
        stderr,
        failureReason: null,
        finishedAt,
      },
    });
    if (runLog.count !== 1) return false;

    const testCase = await tx.testCase.updateMany({
      where: { id: task.testCase.id, editedAt: sourceEditedAt, status: { in: ACTIVE_STATUSES } },
      data: {
        playwrightScript: script,
        scriptNeedsGeneration: false,
        scriptGeneratedAt: finishedAt,
        status: "success",
        lastFailureReason: null,
        lastRunAt: finishedAt,
      },
    });
    if (testCase.count !== 1) throw new Error("用例状态已变化，未保存候选脚本");
    return true;
  });
}

async function completeCaseRepairCandidate(
  item: RepairItem,
  candidate: { naturalLanguage: string; problem: string; suggestion: string },
) {
  const { task } = item;
  await appendRunLog(task, "自然语言修复候选已生成，等待人工审核");
  await flushRunLog(task);
  const finishedAt = new Date();
  await prisma.$transaction(async (tx) => {
    const runLog = await tx.runLog.updateMany({
      where: { id: task.runLogId, testCaseId: task.testCase.id, status: { in: ACTIVE_STATUSES }, finishedAt: null },
      data: { status: "success", logs: getRunLog(task), failureReason: null, finishedAt },
    });
    if (runLog.count !== 1) return;

    await tx.testCaseCandidate.create({
      data: {
        projectId: task.testCase.projectId,
        kind: "repair",
        generationId: null,
        repairRunLogId: task.runLogId,
        targetTestCaseId: task.testCase.id,
        title: task.testCase.title,
        groupName: item.groupName,
        naturalLanguage: candidate.naturalLanguage,
        sourceNaturalLanguage: task.testCase.naturalLanguage,
        sourceEditedAt: item.sourceEditedAt,
        repairProblem: candidate.problem,
        repairSuggestion: candidate.suggestion,
      },
    });
    const testCase = await tx.testCase.updateMany({
      where: { id: task.testCase.id, status: { in: ACTIVE_STATUSES } },
      data: {
        status: "failed",
        lastFailureReason: item.sourceRunLog.failureReason,
      },
    });
    if (testCase.count !== 1) throw new Error("用例状态已变化，未创建修复候选");
  });
}

function truncateEvidence(value: string | null, maxLength = 20_000) {
  if (!value || value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n...[输出已截断]`;
}

function toRepairCategoryText(category: "business" | "data" | "permission" | "environment") {
  return {
    business: "业务逻辑问题",
    data: "测试数据问题",
    permission: "权限问题",
    environment: "环境问题",
  }[category];
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "未知错误";
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
    await finishTask(task, "failed", { stdout: "", stderr: "", failureReason: message });
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
  const switchedToRunning = await updateStatus(task.runLogId, latestTestCase.id, "running");
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
    await finishTask(task, "success", { stdout: result.stdout, stderr: result.stderr });
    return;
  }

  void appendRunLog(task, `Playwright 执行失败：${truncateLogMessage(result.failureReason ?? "未知错误")}`);
  logRun("用例执行失败", {
    runLogId: task.runLogId,
    testCaseId: latestTestCase.id,
    failureReason: result.failureReason,
  });
  await finishTask(task, "failed", {
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
    await finishTask(task, "failed", {
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

  logRun("读取项目配置", {
    projectId: project.id,
    baseUrl: project.baseUrl,
    hasPromptHint: Boolean(project.promptHint?.trim()),
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
      throw new Error(
        `变量 ${name} 未配置。请在项目设置中配置该变量，或修改用例中的 \${${name}} 占位符`,
      );
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

type FinishOutput = {
  logs: string;
  stdout: string;
  stderr: string;
  failureReason?: string;
};

async function finishTask(
  task: RunTask,
  status: "success" | "failed",
  output: Omit<FinishOutput, "logs">,
) {
  await flushRunLog(task);
  return markFinished(task.runLogId, task.testCase.id, task.kind, status, {
    ...output,
    logs: getRunLog(task),
  });
}

// 标记一次运行结束，并写入过程日志、原始输出和失败原因。
async function markFinished(
  runLogId: number,
  testCaseId: string,
  kind: RunTask["kind"],
  status: "success" | "failed",
  { logs, stdout, stderr, failureReason }: FinishOutput,
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
      markFinished(target.runLogId, target.testCaseId, target.kind, "failed", {
        logs: target.logs ?? appendTerminalLog(logsById.get(target.runLogId), target.kind, USER_STOP_FAILURE_REASON),
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

function appendTerminalLog(logs: string | null | undefined, kind: RunTask["kind"], message: string) {
  return `${logs || getLogHeader(kind)}\n${formatLogTime(new Date())} ${message}`;
}

function toStopRunResult(targets: StopTarget[]): StopRunResult {
  return {
    stopped: true,
    affectedTestCaseIds: Array.from(new Set(targets.map((target) => target.testCaseId))),
  };
}

function appendRunLog(task: RunTask, message: string) {
  const writer = getLogWriter(task);
  writer.lines.push(`${formatLogTime(new Date())} ${message}`);
  const snapshot = writer.lines.join("\n");
  writer.pending = writer.pending.then(() => persistRunLog(task, snapshot));
  return writer.pending;
}

function getRunLog(task: RunTask) {
  return getLogWriter(task).lines.join("\n");
}

function createRunLog(kind: RunTask["kind"], message: string) {
  return [getLogHeader(kind), `${formatLogTime(new Date())} ${message}`].join("\n");
}

function getLogWriter(task: RunTask) {
  task.logWriter ??= {
    lines: [getLogHeader(task.kind)],
    pending: Promise.resolve(),
  };
  return task.logWriter;
}

function getLogHeader(kind: RunTask["kind"]) {
  return kind === "repair" ? REPAIR_LOG_HEADER : EXECUTION_LOG_HEADER;
}

function flushRunLog(task: RunTask) {
  return getLogWriter(task).pending;
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
      data: {
        logs,
      },
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

function truncateLogMessage(message: string) {
  return message.length <= 300 ? message : `${message.slice(0, 300)}...`;
}

// 输出运行服务日志。
function logRun(message: string, data?: unknown) {
  console.log(`[testCaseRunService] ${message}`, data ?? "");
}
