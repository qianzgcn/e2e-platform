import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../prisma.js";

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
}
