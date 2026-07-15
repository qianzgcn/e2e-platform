import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { prisma } from "../infra/prisma.js";
import { assertNoProjectVariableValues, assertPreservesVariablePlaceholders } from "../prompts/scriptRepair.js";
import { getRunArtifacts } from "../utils/artifactService.js";
import { removeGeneratedTestScript, removeTestCaseArtifacts } from "../utils/cleanupService.js";
import { resolveScriptGenerationOnSave } from "../utils/testCaseScriptGeneration.js";
import { startCaseGeneration } from "../services/caseGenerationJobService.js";
import { repairTestCase, runAllTestCases, runTestCase, runTestCases, stopTestCaseRun } from "../services/testCaseRunService.js";

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
  repairCandidates: Array<{ id: number }>;
  runLogs: Array<{ kind: "execution" | "repair" }>;
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

// 加载待审核候选。
testCasesRouter.get("/candidates", async (req, res) => {
  const projectId = Number(req.query.projectId);
  if (!Number.isInteger(projectId)) {
    res.status(400).json({ message: "projectId 必填" });
    return;
  }
  const candidates = await prisma.testCaseCandidate.findMany({
    where: { projectId, status: "pending" },
    orderBy: { id: "asc" },
    include: { targetTestCase: { select: { editedAt: true } } },
  });
  res.json({
    candidates: candidates.map(({ targetTestCase, ...candidate }) => ({
      ...candidate,
      stale: Boolean(
        candidate.kind === "repair"
        && candidate.sourceEditedAt
        && targetTestCase
        && candidate.sourceEditedAt.getTime() !== targetTestCase.editedAt.getTime()
      ),
    })),
  });
});

// 按项目查看最近的 AI 用例生成记录；日志详情通过 /generations/:id 按需加载。
testCasesRouter.get("/generations", async (req, res) => {
  const projectId = Number(req.query.projectId);
  if (!Number.isInteger(projectId)) {
    res.status(400).json({ message: "projectId 必填" });
    return;
  }

  const generations = await prisma.testCaseGeneration.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      projectId: true,
      status: true,
      hint: true,
      failureReason: true,
      createdAt: true,
      finishedAt: true,
      _count: { select: { candidates: true } },
    },
  });

  res.json({
    generations: generations.map(({ _count, ...generation }) => ({
      ...generation,
      candidateCount: _count.candidates,
    })),
  });
});

testCasesRouter.get("/:id/logs", async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
  const where = { testCaseId: req.params.id };
  const [total, logs] = await Promise.all([
    prisma.runLog.count({ where }),
    prisma.runLog.findMany({
      where,
      orderBy: { startedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        testCaseId: true,
        kind: true,
        status: true,
        sourceRunLogId: true,
        startedAt: true,
        finishedAt: true,
        repairCandidate: { select: { id: true, status: true } },
      },
    }),
  ]);
  res.json({ logs, total, page, pageSize });
});

testCasesRouter.get("/:id/logs/:logId", async (req, res) => {
  const logId = Number(req.params.logId);
  if (!Number.isInteger(logId)) {
    res.status(400).json({ message: "日志 ID 无效" });
    return;
  }
  const runLog = await prisma.runLog.findFirst({
    where: { id: logId, testCaseId: req.params.id },
    include: {
      repairCandidate: {
        select: {
          id: true,
          status: true,
          naturalLanguage: true,
          sourceNaturalLanguage: true,
          repairProblem: true,
          repairSuggestion: true,
        },
      },
    },
  });
  if (!runLog) {
    res.status(404).json({ message: "用例日志不存在" });
    return;
  }
  res.json({ runLog, ...(await getRunArtifacts(req.params.id, runLog.id)) });
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
  const runLog = await prisma.runLog.findFirst({
    where: { testCaseId: id },
    orderBy: { startedAt: "desc" },
  });
  const artifacts = runLog ? await getRunArtifacts(id, runLog.id) : { artifacts: [] };

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

// AI 基于项目代码仓库生成用例候选（自然语言步骤），供前端审核后导入。
testCasesRouter.post("/generate", async (req, res) => {
  const projectId = Number(req.body.projectId);
  if (!Number.isInteger(projectId)) {
    res.status(400).json({ message: "projectId 必填" });
    return;
  }
  const hint = typeof req.body.hint === "string" ? req.body.hint : undefined;
  try {
    console.log(`[testCases] 生成用例请求 projectId=${projectId} hint=${hint ? "有" : "无"}`);
    const generation = await startCaseGeneration(projectId, hint);
    res.status(202).json(generation);
  } catch (error) {
    console.error("[testCases] 生成用例失败", error instanceof Error ? error.message : error);
    res.status(400).json({ message: error instanceof Error ? error.message : "生成用例失败" });
  }
});

testCasesRouter.post("/:id/repair", async (req, res) => {
  try {
    res.status(202).json(await repairTestCase(req.params.id));
  } catch (error) {
    res.status(400).json({ message: error instanceof Error ? error.message : "AI 修复提交失败" });
  }
});

// 导入选中候选为 TestCase。
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
    const existing = await prisma.testCaseCandidate.findMany({
      where: { id: { in: ids }, kind: "generated", status: "pending" },
    });
    if (!existing.length) {
      res.json({ createdCount: 0, skippedCount: 0 });
      return;
    }
    const existingIds = new Set(existing.map((candidate) => candidate.id));
    const projectId = existing[0].projectId;
    const rows = valid.filter((row) => existingIds.has(row.id));
    const { createdIds, skippedRows } = await createTestCasesFromRows(projectId, rows);
    await prisma.testCaseCandidate.updateMany({
      where: { id: { in: existing.map((candidate) => candidate.id) }, kind: "generated", status: "pending" },
      data: { status: "imported" },
    });
    res.json({ createdCount: createdIds.length, skippedCount: skippedRows.length });
  } catch (error) {
    res.status(400).json({ message: error instanceof Error ? error.message : "导入失败" });
  }
});

testCasesRouter.post("/candidates/:id/apply-repair", async (req, res) => {
  const id = Number(req.params.id);
  const naturalLanguage = typeof req.body.naturalLanguage === "string" ? req.body.naturalLanguage.trim() : "";
  if (!Number.isInteger(id) || !naturalLanguage) {
    res.status(400).json({ message: "修复候选和测试步骤必填" });
    return;
  }

  try {
    const candidate = await prisma.testCaseCandidate.findUnique({
      where: { id },
      include: {
        targetTestCase: { select: { id: true, editedAt: true } },
        project: { select: { variables: { select: { name: true, value: true } } } },
      },
    });
    if (
      !candidate
      || candidate.kind !== "repair"
      || candidate.status !== "pending"
      || !candidate.targetTestCase
      || !candidate.sourceEditedAt
    ) {
      res.status(404).json({ message: "待审核的修复候选不存在" });
      return;
    }

    assertNoProjectVariableValues(naturalLanguage, candidate.project.variables);
    assertPreservesVariablePlaceholders(candidate.sourceNaturalLanguage ?? "", naturalLanguage);
    const target = candidate.targetTestCase;
    const sourceEditedAt = candidate.sourceEditedAt;
    const updated = await prisma.$transaction(async (tx) => {
      const testCase = await tx.testCase.updateMany({
        where: { id: target.id, editedAt: sourceEditedAt },
        data: {
          naturalLanguage,
          playwrightScript: null,
          scriptNeedsGeneration: true,
          scriptGeneratedAt: null,
          status: "not_run",
          lastFailureReason: null,
          lastRunAt: null,
          editedAt: new Date(),
        },
      });
      if (testCase.count !== 1) return false;

      const applied = await tx.testCaseCandidate.updateMany({
        where: { id: candidate.id, kind: "repair", status: "pending" },
        data: { naturalLanguage, status: "imported" },
      });
      if (applied.count !== 1) throw new Error("修复候选状态已变化");
      return true;
    });
    if (!updated) {
      res.status(409).json({ message: "原用例已被修改，该修复候选已过期，请重新发起 AI 修复" });
      return;
    }

    await removeGeneratedTestScript(target.id).catch((error) => {
      console.error("[testCases] 清理已失效脚本失败", {
        testCaseId: target.id,
        message: error instanceof Error ? error.message : "未知错误",
      });
    });
    res.json({ updated: true, testCaseId: target.id });
  } catch (error) {
    res.status(400).json({ message: error instanceof Error ? error.message : "采纳修复候选失败" });
  }
});

testCasesRouter.post("/candidates/:id/reject", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ message: "候选 ID 无效" });
    return;
  }
  const result = await prisma.testCaseCandidate.updateMany({
    where: { id, kind: "repair", status: "pending" },
    data: { status: "rejected" },
  });
  if (result.count !== 1) {
    res.status(404).json({ message: "待审核的修复候选不存在" });
    return;
  }
  res.json({ rejected: true });
});

// 查看某次生成的日志。
testCasesRouter.get("/generations/:id", async (req, res) => {
  const id = Number(req.params.id);
  const generation = await prisma.testCaseGeneration.findUnique({
    where: { id },
    include: { _count: { select: { candidates: true } } },
  });
  if (!generation) {
    res.status(404).json({ message: "生成记录不存在" });
    return;
  }
  const { _count, ...detail } = generation;
  res.json({ ...detail, candidateCount: _count.candidates });
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
