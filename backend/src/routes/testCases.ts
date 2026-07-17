import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { prisma } from "../infra/prisma.js";
import { removeGeneratedTestScript, removeTestCaseArtifacts } from "../utils/cleanupService.js";
import { resolveScriptGenerationOnSave } from "../utils/testCaseScriptGeneration.js";
import { repairTestCase, runAllTestCases, runTestCase, runTestCases, stopTestCaseRun, stopTestCases } from "../services/testCaseRunService.js";
import { testCaseCandidateRoutes } from "./testCases/candidateRoutes.js";
import { testCaseGenerationRoutes } from "./testCases/generationRoutes.js";
import { testCaseImportExportRoutes } from "./testCases/importExportRoutes.js";
import { testCaseLogRoutes } from "./testCases/logRoutes.js";

export const testCasesRouter = Router();
testCasesRouter.use(testCaseCandidateRoutes);
testCasesRouter.use(testCaseGenerationRoutes);
testCasesRouter.use(testCaseImportExportRoutes);
testCasesRouter.use(testCaseLogRoutes);

type TestCaseListRow = {
  id: string;
  title: string;
  groupId: number;
  projectId: number;
  group: {
    name: string;
  };
  status: string;
  scriptNeedsGeneration: boolean;
  lastFailureReason: string | null;
  lastRunAt: Date | null;
  createdAt: Date;
  editedAt: Date;
  repairCandidates: Array<{ id: number }>;
  runLogs: Array<{ kind: "execution" | "repair" }>;
};

type ExistingTestCaseForUpdate = {
  naturalLanguage: string;
  playwrightScript: string | null;
  scriptNeedsGeneration: boolean;
};

testCasesRouter.get("/", async (req, res) => {
  const title = typeof req.query.title === "string" ? req.query.title.trim() : "";
  const projectId = Number(req.query.projectId);
  const testCases = await prisma.testCase.findMany({
    where: {
      ...(title ? { title: { contains: title } } : {}),
      ...(Number.isInteger(projectId) ? { projectId } : {}),
    },
    orderBy: { editedAt: "desc" },
    select: {
      id: true,
      title: true,
      groupId: true,
      projectId: true,
      group: {
        select: {
          name: true,
        },
      },
      status: true,
      scriptNeedsGeneration: true,
      lastFailureReason: true,
      lastRunAt: true,
      createdAt: true,
      editedAt: true,
      repairCandidates: {
        where: { kind: "repair", status: "pending" },
        take: 1,
        select: { id: true },
      },
      runLogs: {
        where: { status: { in: ["queued", "generating", "running"] }, finishedAt: null },
        orderBy: { startedAt: "desc" },
        take: 1,
        select: { kind: true },
      },
    },
  });

  res.json(
    testCases.map((testCase: TestCaseListRow) => ({
      id: testCase.id,
      title: testCase.title,
      groupId: testCase.groupId,
      projectId: testCase.projectId,
      groupName: testCase.group.name,
      status: testCase.status,
      scriptNeedsGeneration: testCase.scriptNeedsGeneration,
      lastFailureReason: testCase.lastFailureReason,
      lastRunAt: testCase.lastRunAt,
      createdAt: testCase.createdAt,
      editedAt: testCase.editedAt,
      pendingRepairCandidateId: testCase.repairCandidates[0]?.id ?? null,
      activeRunKind: testCase.runLogs[0]?.kind ?? null,
    })),
  );
});

testCasesRouter.get("/:id", async (req, res) => {
  const id = req.params.id;
  const testCase = await prisma.testCase.findUnique({
    where: { id },
    include: { group: true },
  });

  if (!testCase) {
    res.status(404).json({ message: "用例不存在" });
    return;
  }

  res.json({
    id: testCase.id,
    title: testCase.title,
    groupId: testCase.groupId,
    projectId: testCase.projectId,
    groupName: testCase.group.name,
    naturalLanguage: testCase.naturalLanguage,
    playwrightScript: testCase.playwrightScript,
    scriptNeedsGeneration: testCase.scriptNeedsGeneration,
    status: testCase.status,
    lastFailureReason: testCase.lastFailureReason,
    lastRunAt: testCase.lastRunAt,
    editedAt: testCase.editedAt,
  });
});

testCasesRouter.post("/", async (req, res) => {
  const { title, groupId, naturalLanguage } = req.body;

  if (!title || !groupId || !naturalLanguage) {
    res.status(400).json({ message: "标题、分组和测试步骤必填" });
    return;
  }

  const group = await prisma.testCaseGroup.findUnique({ where: { id: groupId }, select: { projectId: true } });
  if (!group) {
    res.status(400).json({ message: "分组不存在" });
    return;
  }

  const testCase = await prisma.testCase.create({
    data: {
      id: uuidv4(),
      title,
      groupId,
      projectId: group.projectId,
      naturalLanguage,
      scriptNeedsGeneration: true,
      editedAt: new Date(),
    },
    include: { group: true },
  });

  res.status(201).json({
    ...testCase,
    groupName: testCase.group.name,
  });
});

testCasesRouter.put("/:id", async (req, res) => {
  const id = req.params.id;
  const { title, groupId, naturalLanguage } = req.body;
  const requestedScriptNeedsGeneration = getScriptNeedsGeneration(req.body.scriptNeedsGeneration);

  if (!title || !groupId || !naturalLanguage) {
    res.status(400).json({ message: "标题、分组和测试步骤必填" });
    return;
  }

  const existing = (await prisma.testCase.findUnique({
    where: { id },
    select: {
      naturalLanguage: true,
      playwrightScript: true,
      scriptNeedsGeneration: true,
    },
  })) as ExistingTestCaseForUpdate | null;
  if (!existing) {
    res.status(404).json({ message: "用例不存在" });
    return;
  }

  const group = await prisma.testCaseGroup.findUnique({ where: { id: groupId }, select: { projectId: true } });
  if (!group) {
    res.status(400).json({ message: "分组不存在" });
    return;
  }

  const scriptGeneration = resolveScriptGenerationOnSave(existing, {
    naturalLanguage,
    scriptNeedsGeneration: requestedScriptNeedsGeneration,
  });
  const testCase = await prisma.$transaction(async (tx) => {
    const updatedTestCase = await tx.testCase.update({
      where: { id },
      data: {
        title,
        groupId,
        projectId: group.projectId,
        naturalLanguage,
        scriptNeedsGeneration: scriptGeneration.scriptNeedsGeneration,
        ...(scriptGeneration.clearScript
          ? {
              playwrightScript: null,
              scriptGeneratedAt: null,
            }
          : {}),
        ...(scriptGeneration.resetRunState
          ? {
              status: "not_run",
              lastRunAt: null,
              lastFailureReason: null,
            }
          : {}),
        editedAt: new Date(),
      },
      include: { group: true },
    });

    return updatedTestCase;
  });

  if (scriptGeneration.clearScript) {
    await removeGeneratedTestScript(id).catch((error) => {
      console.error("[testCases] 清理已失效脚本失败", {
        testCaseId: id,
        message: error instanceof Error ? error.message : "未知错误",
      });
    });
  }

  res.json({
    ...testCase,
    groupName: testCase.group.name,
  });
});

testCasesRouter.delete("/:id", async (req, res) => {
  const ids = parseIds(req.params.id);
  const existing = await prisma.testCase.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  });
  await prisma.testCase.deleteMany({ where: { id: { in: existing.map((testCase) => testCase.id) } } });
  const cleanupResults = await Promise.allSettled(
    existing.flatMap((testCase) => [
      removeGeneratedTestScript(testCase.id),
      removeTestCaseArtifacts(testCase.id),
    ]),
  );
  for (const result of cleanupResults) {
    if (result.status === "rejected") {
      console.error("[testCases] 删除用例文件失败", result.reason);
    }
  }
  res.status(204).send();
});

testCasesRouter.post("/run-all", async (req, res) => {
  const projectId = Number(req.query.projectId);
  if (!Number.isInteger(projectId)) {
    res.status(400).json({ message: "projectId 必填" });
    return;
  }
  try {
    res.json(await runAllTestCases(projectId));
  } catch (error) {
    res.status(400).json({ message: error instanceof Error ? error.message : "全量运行失败" });
  }
});

testCasesRouter.post("/:id/repair", async (req, res) => {
  try {
    res.status(202).json(await repairTestCase(req.params.id));
  } catch (error) {
    res.status(400).json({ message: error instanceof Error ? error.message : "AI 修复提交失败" });
  }
});

testCasesRouter.post("/:id/run", async (req, res) => {
  const ids = parseIds(req.params.id);
  try {
    const result = ids.length === 1 ? await runTestCase(ids[0]) : await runTestCases(ids);
    res.json(result);
  } catch (error) {
    res.status(404).json({ message: error instanceof Error ? error.message : "用例不存在" });
  }
});

testCasesRouter.post("/:id/stop", async (req, res) => {
  const ids = parseIds(req.params.id);
  try {
    const result = ids.length === 1 ? await stopTestCaseRun(ids[0]) : await stopTestCases(ids);
    res.json(result);
  } catch (error) {
    res.status(404).json({ message: error instanceof Error ? error.message : "用例不存在" });
  }
});

function parseIds(value: string) {
  return value.split(",").filter(Boolean);
}

function getScriptNeedsGeneration(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}
