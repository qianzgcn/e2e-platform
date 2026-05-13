import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { prisma } from "../prisma.js";
import { getLatestArtifacts } from "../services/artifactService.js";
import { removePlaywrightTestResults } from "../services/cleanupService.js";
import { resolveScriptGenerationOnSave } from "../services/testCaseScriptGeneration.js";
import { runTestCase, runTestCases, stopTestCaseRun } from "../services/testCaseRunService.js";

export const testCasesRouter = Router();

type TestCaseListRow = {
  id: string;
  title: string;
  groupId: number;
  group: {
    name: string;
  };
  status: string;
  scriptNeedsGeneration: boolean;
  lastFailureReason: string | null;
  lastRunAt: Date | null;
  createdAt: Date;
  editedAt: Date;
};

type ExistingTestCaseForUpdate = {
  naturalLanguage: string;
  playwrightScript: string | null;
  scriptNeedsGeneration: boolean;
};

testCasesRouter.get("/", async (_req, res) => {
  const title = typeof _req.query.title === "string" ? _req.query.title.trim() : "";
  const testCases = await prisma.testCase.findMany({
    where: title
      ? {
          title: {
            contains: title,
          },
        }
      : undefined,
    orderBy: { editedAt: "desc" },
    select: {
      id: true,
      title: true,
      groupId: true,
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
    },
  });

  res.json(
    testCases.map((testCase: TestCaseListRow) => ({
      id: testCase.id,
      title: testCase.title,
      groupId: testCase.groupId,
      groupName: testCase.group.name,
      status: testCase.status,
      scriptNeedsGeneration: testCase.scriptNeedsGeneration,
      lastFailureReason: testCase.lastFailureReason,
      lastRunAt: testCase.lastRunAt,
      createdAt: testCase.createdAt,
      editedAt: testCase.editedAt,
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

testCasesRouter.get("/:id/latest-run", async (req, res) => {
  const id = req.params.id;
  const [runLog, artifacts] = await Promise.all([
    prisma.runLog.findFirst({
      where: { testCaseId: id },
      orderBy: { startedAt: "desc" },
    }),
    getLatestArtifacts(id),
  ]);

  res.json({
    runLog,
    ...artifacts,
  });
});

testCasesRouter.post("/", async (req, res) => {
  const { title, groupId, naturalLanguage } = req.body;

  if (!title || !groupId || !naturalLanguage) {
    res.status(400).json({ message: "标题、分组和测试步骤必填" });
    return;
  }

  const testCase = await prisma.testCase.create({
    data: {
      id: uuidv4(),
      title,
      groupId,
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

    if (scriptGeneration.clearRunHistory) {
      await tx.runLog.deleteMany({ where: { testCaseId: id } });
    }

    return updatedTestCase;
  });

  if (scriptGeneration.clearRunHistory) {
    await removePlaywrightTestResults(id);
  }

  res.json({
    ...testCase,
    groupName: testCase.group.name,
  });
});

testCasesRouter.delete("/:id", async (req, res) => {
  const ids = parseIds(req.params.id);
  await prisma.testCase.deleteMany({ where: { id: { in: ids } } });
  res.status(204).send();
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
  try {
    const result = await stopTestCaseRun(req.params.id);
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
