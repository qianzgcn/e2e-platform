import type { TestCaseExcelRow } from "../types";

const EXCEL_COLUMNS = {
  title: "用例名称",
  groupName: "分组",
  naturalLanguage: "测试步骤",
} as const;

export async function writeTestCaseWorkbook(rows: TestCaseExcelRow[]) {
  const XLSX = await import("xlsx");
  const worksheet = XLSX.utils.json_to_sheet(toExcelRecords(rows), {
    header: Object.values(EXCEL_COLUMNS),
  });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "用例");
  XLSX.writeFile(workbook, createExportFileName());
}

export async function readTestCaseWorkbook(file: File) {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    return [];
  }

  const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[firstSheetName], { defval: "" });
  return records.map((record, index) => ({
    title: getExcelCellText(record, EXCEL_COLUMNS.title),
    groupName: getExcelCellText(record, EXCEL_COLUMNS.groupName),
    naturalLanguage: getExcelCellText(record, EXCEL_COLUMNS.naturalLanguage),
    rowNumber: index + 2,
  }));
}

function toExcelRecords(rows: TestCaseExcelRow[]) {
  return rows.map((row) => ({
    [EXCEL_COLUMNS.title]: row.title,
    [EXCEL_COLUMNS.groupName]: row.groupName,
    [EXCEL_COLUMNS.naturalLanguage]: row.naturalLanguage,
  }));
}

function getExcelCellText(record: Record<string, unknown>, column: string) {
  const value = record[column];
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function createExportFileName() {
  const now = new Date();
  const date = [
    now.getFullYear(),
    padDatePart(now.getMonth() + 1),
    padDatePart(now.getDate()),
  ].join("");
  const time = [padDatePart(now.getHours()), padDatePart(now.getMinutes()), padDatePart(now.getSeconds())].join("");
  return `用例导出_${date}_${time}.xlsx`;
}

function padDatePart(value: number) {
  return String(value).padStart(2, "0");
}
