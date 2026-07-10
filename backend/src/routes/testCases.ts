import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { prisma } from "../infra/prisma.js";
import { getLatestArtifacts } from "../utils/artifactService.js";
import { removePlaywrightTestResults } from "../utils/cleanupService.js";
import { resolveScriptGenerationOnSave } from "../utils/testCaseScriptGeneration.js";
import { generateTestCaseCandidates } from "../services/caseGenerationService.js";
import { runAllTestCases, runTestCase, runTestCases, stopTestCaseRun } from "../services/testCaseRunService.js";
import { ensureRepo } from "../infra/repoService.js";

export const testCasesRouter = Router();

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
};

type ExistingTestCaseForUpdate = {
  naturalLanguage: string;
  playwrightScript: string | null;
  scriptNeedsGeneration: boolean;
};

type ImportTestCaseRow = {
  title?: unknown;
  groupName?: unknown;
  naturalLanguage?: unknown;
  rowNumber?: unknown;
};

type NormalizedImportTestCaseRow = {
  title: string;
  groupName: string;
  naturalLanguage: string;
  rowNumber?: number;
};

type SkippedImportTestCaseRow = Partial<NormalizedImportTestCaseRow> & {
  reason: string;
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
    })),
  );
});

// 加载待审核的候选用例（刷新页面不丢）。
testCasesRouter.get("/candidates", async (req, res) => {
  const projectId = Number(req.query.projectId);
  if (!Number.isInteger(projectId)) {
    res.status(400).json({ message: "projectId 必填" });
    return;
  }
  const candidates = await prisma.testCaseCandidate.findMany({
    where: { projectId, status: "pending" },
    orderBy: { id: "asc" },
  });
  res.json({ candidates });
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

// AI 基于项目代码仓库生成用例候选（自然语言步骤），供前端审核后导入。
testCasesRouter.post("/generate", async (req, res) => {
  const projectId = Number(req.body.projectId);
  if (!Number.isInteger(projectId)) {
    res.status(400).json({ message: "projectId 必填" });
    return;
  }
  const hint = typeof req.body.hint === "string" ? req.body.hint : undefined;
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { repoUrl: true, promptHint: true, variables: { select: { name: true } } },
    });
    if (!project) {
      res.status(404).json({ message: "项目不存在" });
      return;
    }
    if (!project.repoUrl) {
      res.status(400).json({ message: "项目未配置代码仓库（repoUrl）" });
      return;
    }
    console.log(`[testCases] 生成用例请求 projectId=${projectId} hint=${hint ? "有" : "无"}`);
    const repoPath = await ensureRepo(project.repoUrl, projectId);
    const { candidates, logs } = await generateTestCaseCandidates(repoPath, project, hint);
    console.log(`[testCases] 生成完成 ${candidates.length} 条候选`);

    const generation = await prisma.testCaseGeneration.create({
      data: {
        projectId,
        logs: logs.join("\n"),
        hint: hint ?? null,
        candidates: {
          create: candidates.map((candidate) => ({
            projectId,
            title: candidate.title,
            groupName: candidate.groupName,
            naturalLanguage: candidate.naturalLanguage,
          })),
        },
      },
      include: { candidates: { orderBy: { id: "asc" } } },
    });
    res.json({ generationId: generation.id, candidates: generation.candidates });
  } catch (error) {
    console.error("[testCases] 生成用例失败", error instanceof Error ? error.message : error);
    res.status(400).json({ message: error instanceof Error ? error.message : "生成用例失败" });
  }
});

// 导入选中候选为 TestCase 并标记 imported。候选字段以请求传入为准（允许用户在审核时编辑）。
testCasesRouter.post("/candidates/import", async (req, res) => {
  const input = Array.isArray(req.body.candidates)
    ? (req.body.candidates as Array<{ id: number; title: string; groupName: string; naturalLanguage: string }>)
    : [];
  const valid = input.filter((row) => Number.isInteger(row.id) && row.title && row.groupName && row.naturalLanguage);
  if (!valid.length) {
    res.status(400).json({ message: "candidates 必填" });
    return;
  }
  try {
    const ids = valid.map((row) => row.id);
    const existing = await prisma.testCaseCandidate.findMany({ where: { id: { in: ids }, status: "pending" } });
    if (!existing.length) {
      res.json({ createdCount: 0, skippedCount: 0 });
      return;
    }
    const existingIds = new Set(existing.map((candidate) => candidate.id));
    const projectId = existing[0].projectId;
    const rows = valid.filter((row) => existingIds.has(row.id));
    const { createdIds, skippedRows } = await createTestCasesFromRows(projectId, rows);
    await prisma.testCaseCandidate.updateMany({ where: { id: { in: ids } }, data: { status: "imported" } });
    res.json({ createdCount: createdIds.length, skippedCount: skippedRows.length });
  } catch (error) {
    res.status(400).json({ message: error instanceof Error ? error.message : "导入失败" });
  }
});

// 查看某次生成的日志。
testCasesRouter.get("/generations/:id", async (req, res) => {
  const id = Number(req.params.id);
  const generation = await prisma.testCaseGeneration.findUnique({ where: { id } });
  if (!generation) {
    res.status(404).json({ message: "生成记录不存在" });
    return;
  }
  res.json(generation);
});

testCasesRouter.post("/export-rows", async (req, res) => {
  const ids = getStringArray(req.body.ids);
  if (!ids.length) {
    res.json({ rows: [] });
    return;
  }

  const testCases = await prisma.testCase.findMany({
    where: { id: { in: ids } },
    include: { group: true },
  });
  const orderMap = new Map(ids.map((id, index) => [id, index]));

  res.json({
    rows: testCases
      .sort((left, right) => orderMap.get(left.id)! - orderMap.get(right.id)!)
      .map((testCase) => ({
        title: testCase.title,
        groupName: testCase.group.name,
        naturalLanguage: testCase.naturalLanguage,
      })),
  });
});

testCasesRouter.post("/import", async (req, res) => {
  const projectId = Number(req.body.projectId);
  if (!Number.isInteger(projectId)) {
    res.status(400).json({ message: "projectId 必填" });
    return;
  }
  const rows = Array.isArray(req.body.rows) ? (req.body.rows as ImportTestCaseRow[]) : [];
  const result = await createTestCasesFromRows(projectId, rows);
  res.json({
    createdCount: result.createdIds.length,
    skippedCount: result.skippedRows.length,
    createdIds: result.createdIds,
    skippedRows: result.skippedRows,
  });
});

// 把用例行（title/groupName/naturalLanguage）入库为 TestCase：normalize、去重、建分组、批量创建。
// POST /import 与 POST /candidates/import 共用。
async function createTestCasesFromRows(
  projectId: number,
  rows: ImportTestCaseRow[],
): Promise<{ createdIds: string[]; skippedRows: SkippedImportTestCaseRow[] }> {
  const { validRows, skippedRows } = normalizeImportRows(rows);
  if (!validRows.length) {
    return { createdIds: [], skippedRows };
  }

  return prisma.$transaction(async (tx) => {
    const existingTestCases = await tx.testCase.findMany({
      where: { projectId, title: { in: validRows.map((row) => row.title) } },
      select: { title: true },
    });
    const existingTitles = new Set(existingTestCases.map((testCase) => testCase.title.trim()));
    const importingTitles = new Set<string>();
    const rowsToCreate: NormalizedImportTestCaseRow[] = [];
    const duplicateSkippedRows: SkippedImportTestCaseRow[] = [];

    for (const row of validRows) {
      if (existingTitles.has(row.title) || importingTitles.has(row.title)) {
        duplicateSkippedRows.push({ ...row, reason: "用例名称重复" });
        continue;
      }

      importingTitles.add(row.title);
      rowsToCreate.push(row);
    }

    if (!rowsToCreate.length) {
      return { createdIds: [], skippedRows: [...skippedRows, ...duplicateSkippedRows] };
    }

    const groupNames = Array.from(new Set(rowsToCreate.map((row) => row.groupName)));
    const groups = await Promise.all(
      groupNames.map((name) =>
        tx.testCaseGroup.upsert({
          where: { projectId_name: { projectId, name } },
          create: { projectId, name },
          update: {},
        }),
      ),
    );
    const groupIdByName = new Map(groups.map((group) => [group.name, group.id]));
    const now = new Date();
    const createdIds = rowsToCreate.map(() => uuidv4());

    await tx.testCase.createMany({
      data: rowsToCreate.map((row, index) => ({
        id: createdIds[index],
        title: row.title,
        groupId: groupIdByName.get(row.groupName)!,
        projectId,
        naturalLanguage: row.naturalLanguage,
        playwrightScript: null,
        scriptNeedsGeneration: true,
        status: "not_run",
        lastFailureReason: null,
        lastRunAt: null,
        scriptGeneratedAt: null,
        editedAt: now,
      })),
    });

    return { createdIds, skippedRows: [...skippedRows, ...duplicateSkippedRows] };
  });
}

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

function getStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item)) : [];
}

function getScriptNeedsGeneration(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeImportRows(rows: ImportTestCaseRow[]) {
  const validRows: NormalizedImportTestCaseRow[] = [];
  const skippedRows: SkippedImportTestCaseRow[] = [];

  for (const row of rows) {
    const normalizedRow = {
      title: toTrimmedString(row.title),
      groupName: toTrimmedString(row.groupName),
      naturalLanguage: toTrimmedString(row.naturalLanguage),
      rowNumber: typeof row.rowNumber === "number" ? row.rowNumber : undefined,
    };

    if (!normalizedRow.title || !normalizedRow.groupName || !normalizedRow.naturalLanguage) {
      skippedRows.push({ ...normalizedRow, reason: "缺少必填字段" });
      continue;
    }

    validRows.push(normalizedRow);
  }

  return { validRows, skippedRows };
}

function toTrimmedString(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}
