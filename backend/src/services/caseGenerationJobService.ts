import { prisma } from "../infra/prisma.js";
import { ensureRepo } from "../infra/repoService.js";
import { generateTestCaseCandidates } from "./caseGenerationService.js";

const FAILURE_REASON_MAX_LENGTH = 2000;

export async function startCaseGeneration(projectId: number, hint?: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      repoUrl: true,
      repoBranch: true,
      repoSubdirectory: true,
      promptHint: true,
      variables: { select: { name: true } },
    },
  });

  if (!project) {
    throw new Error("项目不存在");
  }
  if (!project.repoUrl) {
    throw new Error("项目未配置代码仓库（repoUrl）");
  }

  const initialLog = formatLogLine("生成任务已创建，等待同步代码仓库");
  const generation = await prisma.testCaseGeneration.create({
    data: {
      projectId,
      status: "running",
      logs: initialLog,
      hint: hint?.trim() || null,
    },
    select: { id: true },
  });

  void executeGeneration(generation.id, projectId, project, hint, initialLog).catch((error) => {
    console.error("[caseGenerationJob] 后台生成任务异常", {
      generationId: generation.id,
      message: error instanceof Error ? error.message : "未知错误",
    });
  });

  return { generationId: generation.id };
}

async function executeGeneration(
  generationId: number,
  projectId: number,
  project: {
    repoUrl: string | null;
    repoBranch: string | null;
    repoSubdirectory: string | null;
    promptHint: string | null;
    variables: Array<{ name: string }>;
  },
  hint?: string,
  initialLog?: string,
) {
  const progress = createProgressRecorder(generationId, [initialLog ?? formatLogLine("生成任务已创建，等待同步代码仓库")]);
  const { record } = progress;

  try {
    await record("正在同步项目代码仓库");
    const repoPath = await ensureRepo({
      repoUrl: project.repoUrl!,
      repoBranch: project.repoBranch,
      repoSubdirectory: project.repoSubdirectory,
    }, projectId);
    await record("代码仓库同步完成");

    const { candidates } = await generateTestCaseCandidates(repoPath, project, hint, {
      onProgress: record,
    });

    await record(`正在保存 ${candidates.length} 条候选用例`);
    const completedLogs = `${progress.getLogs()}\n${formatLogLine(`生成完成，共 ${candidates.length} 条候选用例`)}`;
    await prisma.testCaseGeneration.update({
      where: { id: generationId },
      data: {
        status: "success",
        logs: completedLogs,
        failureReason: null,
        finishedAt: new Date(),
        candidates: {
          create: candidates.map((candidate) => ({
            projectId,
            title: candidate.title,
            groupName: candidate.groupName,
            naturalLanguage: candidate.naturalLanguage,
          })),
        },
      },
    });
  } catch (error) {
    const message = truncateFailureReason(error instanceof Error ? error.message : "生成用例失败");
    await record(`生成失败：${message}`);
    await prisma.testCaseGeneration.update({
      where: { id: generationId },
      data: {
        status: "failed",
        logs: progress.getLogs(),
        failureReason: message,
        finishedAt: new Date(),
      },
    });
  }
}

function createProgressRecorder(generationId: number, initialLines: string[]) {
  const lines = [...initialLines];

  return {
    record: async (message: string) => {
      lines.push(formatLogLine(message));
      try {
        await prisma.testCaseGeneration.update({
          where: { id: generationId },
          data: { logs: lines.join("\n") },
        });
      } catch (error) {
        console.error("[caseGenerationJob] 写入实时日志失败", {
          generationId,
          message: error instanceof Error ? error.message : "未知错误",
        });
      }
    },
    getLogs: () => lines.join("\n"),
  };
}

function formatLogLine(message: string) {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return `${time} ${message}`;
}

function truncateFailureReason(message: string) {
  return message.length <= FAILURE_REASON_MAX_LENGTH
    ? message
    : `${message.slice(0, FAILURE_REASON_MAX_LENGTH)}...`;
}
