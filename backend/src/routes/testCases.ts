import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { prisma } from "../prisma.js";
import { getLatestArtifacts } from "../services/artifactService.js";
import { removePlaywrightTestResults } from "../services/cleanupService.js";
import { resolveScriptGenerationOnSave } from "../services/testCaseScriptGeneration.js";
import { runAllTestCases, runTestCase, runTestCases, stopTestCaseRun } from "../services/testCaseRunService.js";

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

testCasesRouter.post("/run-all", async (_req, res) => {
  try {
    res.json(await runAllTestCases());
  } catch (error) {
    res.status(400).json({ message: error instanceof Error ? error.message : "全量运行失败" });
  }
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
  const rows = Array.isArray(req.body.rows) ? (req.body.rows as ImportTestCaseRow[]) : [];
  const { validRows, skippedRows } = normalizeImportRows(rows);

  if (!validRows.length) {
    res.json({
      createdCount: 0,
      skippedCount: skippedRows.length,
      createdIds: [],
      skippedRows,
    });
    return;
  }

  const result = await prisma.$transaction(async (tx) => {
    const existingTestCases = await tx.testCase.findMany({
      where: { title: { in: validRows.map((row) => row.title) } },
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
      return {
        createdIds: [],
        skippedRows: [...skippedRows, ...duplicateSkippedRows],
      };
    }

    const groupNames = Array.from(new Set(rowsToCreate.map((row) => row.groupName)));
    const groups = await Promise.all(
      groupNames.map((name) =>
        tx.testCaseGroup.upsert({
          where: { name },
          create: { name },
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

    return {
      createdIds,
      skippedRows: [...skippedRows, ...duplicateSkippedRows],
    };
  });

  res.json({
    createdCount: result.createdIds.length,
    skippedCount: result.skippedRows.length,
    createdIds: result.createdIds,
    skippedRows: result.skippedRows,
  });
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
