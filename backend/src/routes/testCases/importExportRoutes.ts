import { Router } from "express";
import { prisma } from "../../infra/prisma.js";
import { createTestCasesFromRows, type ImportTestCaseRow } from "../../services/testCaseImportService.js";

export const testCaseImportExportRoutes = Router();

testCaseImportExportRoutes.post("/export-rows", async (req, res) => {
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

testCaseImportExportRoutes.post("/import", async (req, res) => {
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

function getStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item)) : [];
}
