import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../prisma.js";

type ColumnCountRow = {
  count: bigint | number | string;
};

function splitSqlStatements(sql: string): string[] {
  return sql
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function initializeDatabase() {
  const initSqlPath = path.resolve(process.cwd(), "sql/init.sql");
  const initSql = await readFile(initSqlPath, "utf8");

  // init.sql 里的语句都必须可重复执行，保证服务重启不会破坏已有数据。
  for (const statement of splitSqlStatements(initSql)) {
    await prisma.$executeRawUnsafe(statement);
  }

  await ensureScriptNeedsGenerationColumn();
}

async function ensureScriptNeedsGenerationColumn() {
  const rows = await prisma.$queryRaw<ColumnCountRow[]>`
    SELECT COUNT(*) AS count
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'TestCase'
      AND COLUMN_NAME = 'scriptNeedsGeneration'
  `;

  if (Number(rows[0]?.count ?? 0) > 0) {
    return;
  }

  // 老库补列时按已有脚本初始化：脚本为空需要生成，已有脚本默认可复用。
  await prisma.$executeRawUnsafe(
    "ALTER TABLE `TestCase` ADD COLUMN `scriptNeedsGeneration` BOOLEAN NOT NULL DEFAULT TRUE",
  );
  await prisma.$executeRawUnsafe(
    "UPDATE `TestCase` SET `scriptNeedsGeneration` = CASE WHEN `playwrightScript` IS NULL OR TRIM(`playwrightScript`) = '' THEN TRUE ELSE FALSE END",
  );
}
