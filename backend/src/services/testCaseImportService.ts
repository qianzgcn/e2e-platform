import { v4 as uuidv4 } from "uuid";
import { prisma } from "../infra/prisma.js";

export type ImportTestCaseRow = {
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

// 将 Excel 或 AI 候选行统一归一化、去重、创建分组并批量入库。
export async function createTestCasesFromRows(
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
