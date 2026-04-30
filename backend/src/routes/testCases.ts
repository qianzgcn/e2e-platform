import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { prisma } from "../prisma.js";
import { getLatestArtifacts } from "../services/artifactService.js";
import { runTestCase } from "../services/testCaseRunService.js";

export const testCasesRouter = Router();

type TestCaseListRow = {
  id: string;
  title: string;
  groupId: number;
  group: {
    name: string;
  };
  status: string;
  lastFailureReason: string | null;
  lastRunAt: Date | null;
  editedAt: Date;
};

testCasesRouter.get("/", async (_req, res) => {
  const testCases = await prisma.testCase.findMany({
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
      lastFailureReason: true,
      lastRunAt: true,
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
      lastFailureReason: testCase.lastFailureReason,
      lastRunAt: testCase.lastRunAt,
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
  const { title, groupId, naturalLanguage, playwrightScript } = req.body;

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
      playwrightScript,
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
  const { title, groupId, naturalLanguage, playwrightScript } = req.body;

  if (!title || !groupId || !naturalLanguage) {
    res.status(400).json({ message: "标题、分组和测试步骤必填" });
    return;
  }

  const testCase = await prisma.testCase.update({
    where: { id },
    data: {
      title,
      groupId,
      naturalLanguage,
      playwrightScript,
      editedAt: new Date(),
    },
    include: { group: true },
  });

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
    const results = await Promise.all(ids.map((id) => runTestCase(id)));
    res.json(ids.length === 1 ? results[0] : { runIds: results.map((result) => result.runId) });
  } catch (error) {
    res.status(404).json({ message: error instanceof Error ? error.message : "用例不存在" });
  }
});

function parseIds(value: string) {
  return value.split(",").filter(Boolean);
}
