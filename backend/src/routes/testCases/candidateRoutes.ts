import { Router } from "express";
import { prisma } from "../../infra/prisma.js";
import { assertNoProjectVariableValues, assertUsesOnlySourceVariablePlaceholders } from "../../prompts/scriptRepair.js";
import { formatTestDataSafetyIssue, validateTestDataSafety } from "../../prompts/testDataSafety.js";
import { createTestCasesFromRows } from "../../services/testCaseImportService.js";
import { removeGeneratedTestScript } from "../../utils/cleanupService.js";

export const testCaseCandidateRoutes = Router();

testCaseCandidateRoutes.get("/candidates", async (req, res) => {
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

testCaseCandidateRoutes.post("/candidates/import", async (req, res) => {
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
    const unsafeRow = rows.find((row) => validateTestDataSafety(row.naturalLanguage));
    if (unsafeRow) {
      const issue = validateTestDataSafety(unsafeRow.naturalLanguage)!;
      throw new Error(`候选用例“${unsafeRow.title}”未通过测试数据安全检查\n${formatTestDataSafetyIssue(issue)}`);
    }
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

testCaseCandidateRoutes.post("/candidates/:id/apply-repair", async (req, res) => {
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
    assertUsesOnlySourceVariablePlaceholders(candidate.sourceNaturalLanguage ?? "", naturalLanguage);
    const safetyIssue = validateTestDataSafety(naturalLanguage);
    if (safetyIssue) {
      throw new Error(`修复候选仍会影响既有业务数据\n${formatTestDataSafetyIssue(safetyIssue)}`);
    }
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

testCaseCandidateRoutes.post("/candidates/:id/reject", async (req, res) => {
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
