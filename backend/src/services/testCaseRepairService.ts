import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../infra/prisma.js";
import { ensureRepo } from "../infra/repoService.js";
import { runPlaywright } from "../infra/runnerService.js";
import {
  assertNoProjectVariableValues,
  assertUsesOnlySourceVariablePlaceholders,
  redactProjectVariableValues,
  type ScriptRepairResult,
} from "../prompts/scriptRepair.js";
import { formatTestDataSafetyIssue, validateTestDataSafety } from "../prompts/testDataSafety.js";
import { getRunArtifactEvidence } from "../utils/artifactService.js";
import { ACTIVE_STATUSES, USER_STOP_FAILURE_REASON } from "../utils/runStatus.js";
import { extractRepairVideoFrames, removeRepairWorkspace } from "../utils/videoFrameService.js";
import { formatScriptRepairProgress, repairScriptWithAgent } from "./scriptRepairAgentService.js";
import {
  appendRunLog,
  finishRunTask,
  flushRunLog,
  getRunLog,
  logRun,
  truncateRunLogMessage,
  updateRunStatus,
} from "./testCaseRunLogService.js";
import type { RepairItem, RunTask } from "./testCaseRunTypes.js";
import { resolveTestCaseVariables } from "./testCaseVariables.js";

// 收集失败证据、调用 AI 诊断，并按结果完成脚本修复、用例候选或不可修复结论。
export async function executeTestCaseRepair(item: RepairItem, sessionId: string, signal: AbortSignal) {
  const { task, project, sourceRunLog } = item;
  const originalScript = !task.testCase.scriptNeedsGeneration && task.testCase.playwrightScript?.trim()
    ? task.testCase.playwrightScript
    : null;
  const repairMode = originalScript ? "script_or_case" : "case_only";
  const specPath = path.resolve(process.cwd(), "tests", "generated", `${task.testCase.id}.spec.ts`);
  const candidateSpecPath = path.resolve(
    process.cwd(),
    "tests",
    "generated",
    `${task.testCase.id}.repair-${task.runLogId}.spec.ts`,
  );
  let lastProgress = "";

  try {
    if (originalScript) {
      await writeFile(candidateSpecPath, originalScript, "utf8");
    } else {
      await appendRunLog(task, "当前没有有效的 Playwright 脚本，将仅诊断自然语言用例和失败原因");
    }
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
        repositoryPath = await ensureRepo({
          repoUrl: project.repoUrl,
          repoBranch: project.repoBranch,
          repoSubdirectory: project.repoSubdirectory,
        }, task.testCase.projectId);
        await appendRunLog(task, "业务代码仓库同步完成");
      } catch (error) {
        await appendRunLog(task, `业务代码仓库不可用，将使用其他证据：${toErrorMessage(error)}`);
      }
    } else {
      await appendRunLog(task, "项目未配置业务代码仓库，将使用其他证据诊断");
    }

    let resolvedNaturalLanguage: string | null = null;
    if (repairMode === "script_or_case") {
      try {
        resolvedNaturalLanguage = resolveTestCaseVariables(task.testCase.naturalLanguage, project.variables);
      } catch {
        await appendRunLog(task, "项目变量无法完整解析，将使用原始用例和失败记录继续诊断");
      }
    }
    await appendRunLog(task, "失败证据准备完成，进入 AI 根因分析");
    const repairResult = await repairScriptWithAgent({
      repairMode,
      baseUrl: task.baseUrl,
      targetFile: originalScript
        ? path.relative(process.cwd(), candidateSpecPath).replaceAll(path.sep, "/")
        : null,
      businessRepository: repositoryPath,
      projectInstructions: task.projectInstructions,
      automationInstructions: task.automationInstructions,
      automationAdapter: task.automationAdapter,
      testCase: {
        id: task.testCase.id,
        title: task.testCase.title,
        originalNaturalLanguage: task.testCase.naturalLanguage,
        resolvedNaturalLanguage,
        protectedVariablePlaceholders: project.variables.map((variable) => `\${${variable.name}}`),
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
      signal,
      stopReason: USER_STOP_FAILURE_REASON,
      sessionId,
      repairLogId: task.runLogId,
      projectVariables: project.variables,
      onProgress: async (message) => {
        const progress = formatScriptRepairProgress(message);
        if (progress && progress !== lastProgress) {
          lastProgress = progress;
          await appendRunLog(task, progress);
        }
      },
    });

    await handleRepairResult(item, repairResult, specPath, candidateSpecPath, signal);
  } catch (error) {
    const message = redactProjectVariableValues(toErrorMessage(error), project.variables);
    await appendRunLog(task, `AI 修复失败：${truncateRunLogMessage(message)}`);
    await finishRunTask(task, "failed", { stdout: "", stderr: "", failureReason: message });
  } finally {
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
    assertUsesOnlySourceVariablePlaceholders(task.testCase.naturalLanguage, result.naturalLanguage);
    const safetyIssue = validateTestDataSafety(result.naturalLanguage);
    if (safetyIssue) {
      throw new Error(`AI 返回的自然语言修复候选仍会影响既有业务数据\n${formatTestDataSafetyIssue(safetyIssue)}`);
    }
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
    await finishRunTask(task, "failed", { stdout: "", stderr: "", failureReason: message });
    return;
  }

  if (task.testCase.scriptNeedsGeneration || !task.testCase.playwrightScript?.trim()) {
    throw new Error("当前用例没有可修复的 Playwright 脚本，不能应用脚本修复结果");
  }

  const candidateScript = await readFile(candidateSpecPath, "utf8");
  if (!candidateScript.trim() || candidateScript === task.testCase.playwrightScript) {
    throw new Error("AI 未产生有效的候选脚本修改");
  }

  const summary = redactProjectVariableValues(result.summary, project.variables);
  await appendRunLog(task, `AI 已生成候选脚本：${summary}`);
  if (!(await updateRunStatus(task.runLogId, task.testCase.id, "running"))) {
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
    await appendRunLog(task, `候选脚本验证失败，已保留原脚本：${truncateRunLogMessage(failureReason)}`);
    await finishRunTask(task, "failed", {
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
